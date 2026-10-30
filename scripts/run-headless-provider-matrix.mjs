#!/usr/bin/env node
// POSIX process ownership and server materialization; gameplay stays in headless-matrix.mjs.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeHeadlessMatrix } from '../coordinator/src/headless-matrix.mjs';
import { parseSavedWorldSpawn, prepareSpawnChunk } from '../coordinator/src/headless-world-spawn.mjs';
import { HeadlessRconClient } from '../coordinator/src/headless-rcon.mjs';
import { requestCaptureShutdown } from '../coordinator/src/capture-shutdown.mjs';
import { readArtifactReport, writeArtifactReport } from '../coordinator/src/benchmark/report-artifacts.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = file => readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2));
const exited = child => child.exitCode !== null || child.signalCode !== null;

export function scenarioConfig(source, scenario, bridgePort, workspace) {
	const config = structuredClone(source);
	config.bridge = { ...config.bridge, host: '127.0.0.1', port: bridgePort };
	config.workspaceRoot = workspace;
	config.minecraftAgentRoot = path.join(workspace, 'minecraft-agent');
	config.codex = { ...config.codex, cwd: workspace, launchProfile: { ...config.codex?.launchProfile, cwd: workspace } };
	// Codex 'default' is the standard tier; a priority/fast tier must be named by the scenario.
	// Opt-in mid-turn context rotation for Codex play (run-long --codex-mid-turn-rotation-tokens); unset keeps it off.
	const midTurnRotationTokens = Number(process.env.ARENA_CODEX_MID_TURN_ROTATION_TOKENS ?? 0);
	if (scenario.provider === 'codex' && Number.isSafeInteger(midTurnRotationTokens) && midTurnRotationTokens > 0) config.codex.midTurnContextRotationTokens = midTurnRotationTokens;
	if (scenario.provider === 'codex') for (const key of ['model', 'reasoningEffort', 'serviceTier']) config.codex.launchProfile[key] = scenario[key] ?? (key === 'serviceTier' ? 'default' : config.codex.launchProfile[key]);
	return config;
}

export function coordinatorReady(contents, scenario) {
	let authenticated = false, profileReady = false, settled = false, catalog = false;
	for (const line of contents.split('\n')) {
		let row; try { row = JSON.parse(line); } catch { continue; }
		const e = row.envelope;
		if (!e) continue;
		if (e.type === 'hello_ack' && e.payload?.authenticated) authenticated = true;
		if (row.direction !== 'coordinator_to_server') continue;
		if (['coordinator_status', 'catalog_snapshot'].includes(e.type)) authenticated = true;
		if (e.type === 'coordinator_status') settled ||= e.payload?.components?.some(c => c.component === `provider:${scenario.provider}` && ['ready', 'degraded'].includes(c.state));
		if (e.type !== 'catalog_snapshot') continue;
		for (const m of e.payload?.models ?? []) {
			if (m.provider !== scenario.provider) continue;
			catalog = true;
			const efforts = (m.reasoningEfforts ?? []).map(x => typeof x === 'string' ? x : x.reasoningEffort);
			const tiers = (m.serviceTiers ?? []).map(x => typeof x === 'string' ? x : x.id);
			profileReady ||= (m.model ?? m.id) === scenario.model && efforts.includes(scenario.reasoningEffort) && (!tiers.length || tiers.includes(scenario.serviceTier ?? (scenario.provider === 'codex' ? 'default' : 'priority')));
		}
	}
	return authenticated && (profileReady || settled && catalog);
}

async function freePort(requested, exclude) {
	const server = net.createServer();
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requested, '127.0.0.1', resolve); });
	const port = server.address().port;
	await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
	if (exclude.includes(port)) return freePort(requested, exclude);
	return port;
}

async function assertCleanTemplate(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink() || entry.name === 'level.dat') throw new Error('Natural evaluations require a clean template without saved worlds or links');
		if (entry.isDirectory()) await assertCleanTemplate(path.join(directory, entry.name));
	}
}

export async function runMatrix(options) {
	if (process.platform === 'win32') throw new Error('Use run-headless-provider-matrix.ps1 on Windows');
	const root = path.resolve(options.ProjectRoot), coordinatorRoot = path.resolve(options.CoordinatorRoot ?? root);
	const matrixFile = path.resolve(options.MatrixPath), template = path.resolve(options.ServerTemplate), jar = path.resolve(options.ModJar);
	const matrix = normalizeHeadlessMatrix(JSON.parse(await readFile(matrixFile, 'utf8')));
	if (matrix.scenarios.some(s => s.world?.mode !== 'natural' || s.repetitions !== 1)) throw new Error('POSIX launcher supports fresh natural worlds with one repetition per scenario');
	await assertCleanTemplate(template);
	const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
	const runDirectory = path.join(root, 'runtime/headless-runs', runId);
	await mkdir(runDirectory, { recursive: true, mode: 0o700 });
	await json(path.join(runDirectory, 'matrix-manifest.json'), { version: matrix.version, scenarios: matrix.scenarios });
	let aborted = false;
	const abort = () => { aborted = true; };
	process.on('SIGTERM', abort); process.on('SIGINT', abort);
	const reports = [];
	try {
		for (const scenario of matrix.scenarios) {
			if (aborted) break;
			const directory = path.join(runDirectory, `${scenario.id}-${randomUUID().slice(0, 8)}`);
			await mkdir(directory, { mode: 0o700 });
			const serverDirectory = path.join(directory, 'server'), workspace = path.join(directory, 'provider-workspaces');
			const protocol = path.join(directory, 'protocol.jsonl'), turns = path.join(directory, 'provider-turns.private.jsonl');
			const passwordFile = path.join(directory, 'rcon-password.txt'), capture = path.join(directory, 'capture-shutdown.json');
			const children = [], streams = [];
			const start = (command, args, cwd, log, env = {}) => {
				const stdout = createWriteStream(log + '.stdout.log'), stderr = createWriteStream(log + '.stderr.log');
				streams.push(stdout, stderr);
				const child = spawn(command, args, { cwd, detached: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
				child.launchError = null; child.on('error', error => { child.launchError = error; });
				child.stdout.pipe(stdout); child.stderr.pipe(stderr); children.push(child); return child;
			};
			const waitFor = async (predicate, timeout, label, child = null) => {
				const deadline = Date.now() + timeout;
				while (Date.now() < deadline) {
					if (aborted) throw new Error('Launcher interrupted');
					if (child?.launchError) throw child.launchError;
					if (await predicate()) return;
					if (child && exited(child)) throw new Error(`${label}: process exited (${child.exitCode ?? child.signalCode})`);
					await sleep(100);
				}
				throw new Error(`${label}: timed out after ${timeout} ms`);
			};
			let server, coordinator, failure = null, cleanupFailure = null, runnerReport = null;
			try {
				await cp(template, serverDirectory, { recursive: true, filter: entry => !/^arena-agents-.*\.jar$/i.test(path.basename(entry)) });
				await mkdir(path.join(serverDirectory, 'mods'), { recursive: true });
				await copyFile(jar, path.join(serverDirectory, 'mods', path.basename(jar)));
				const ports = {};
				for (const [key, name] of [['bridge', 'BRIDGE'], ['rcon', 'RCON'], ['minecraft', 'MINECRAFT']]) ports[key] = await freePort(Number(process.env[`ARENA_HEADLESS_${name}_PORT`] ?? 0), Object.values(ports));
				const secret = randomBytes(32).toString('hex');
				await writeFile(passwordFile, secret, { mode: 0o600 });
				const worldId = `headless-${runId}-${scenario.id}`;
				const propertiesFile = path.join(serverDirectory, 'server.properties');
				const properties = new Map((await text(propertiesFile)).split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
				Object.entries({ 'online-mode': 'false', 'server-ip': '127.0.0.1', 'enable-rcon': 'true', 'rcon.password': secret, 'rcon.port': ports.rcon, 'rcon.ip': '127.0.0.1', 'server-port': ports.minecraft, 'level-name': worldId, 'pause-when-empty-seconds': -1, 'level-seed': scenario.world.seed, 'level-type': scenario.world.generator, difficulty: scenario.world.difficulty, gamemode: scenario.world.gameMode, 'generator-settings': '{}', 'generate-structures': 'true' }).forEach(([k, v]) => properties.set(k, v));
				await writeFile(propertiesFile, [...properties].map(([k, v]) => `${k}=${v}`).join('\n') + '\n'); await chmod(propertiesFile, 0o600);
				for (const d of ['logs', 'traces', 'provider-workspaces']) await mkdir(path.join(directory, d));
				const configFile = path.join(directory, 'coordinator-config.json');
				await json(configFile, scenarioConfig(JSON.parse(await readFile(path.join(coordinatorRoot, 'coordinator/config/dynamic-agents.json'), 'utf8')), scenario, ports.bridge, workspace));
				await writeFile(path.join(directory, 'coordinator.jsonl'), '');
				await writeFile(path.join(directory, 'coordinator-private.jsonl'), '', { mode: 0o600 });
				await json(path.join(directory, 'manifest.json'), { runId, scenarioId: scenario.id, provider: scenario.provider, model: scenario.model, reasoningEffort: scenario.reasoningEffort, serviceTier: scenario.serviceTier, rosterSize: 1, serverDirectory, providerWorkspace: workspace, protocolAudit: protocol, providerTurns: turns, ports, levelName: worldId, world: scenario.world });
				const worldFile = path.join(directory, 'world-manifest.json');
				const world = { version: 1, scenarioId: scenario.id, worldId, fresh: true, world: scenario.world, modSha256: createHash('sha256').update(await readFile(jar)).digest('hex') };
				await json(worldFile, world);
				server = start(process.env.ARENA_HEADLESS_JAVA ?? 'java', [`-Darenaagents.bridgePort=${ports.bridge}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${passwordFile}`, '-Xms1G', '-Xmx2G', '-jar', path.join(serverDirectory, 'fabric-server-launch.jar'), 'nogui'], serverDirectory, path.join(directory, 'logs/fabric'));
				const startupMs = Number(process.env.ARENA_HEADLESS_STARTUP_TIMEOUT_SECONDS ?? 300) * 1000;
				await waitFor(async () => (await text(path.join(serverDirectory, 'logs/latest.log'))).includes('Done ('), startupMs, 'Fabric readiness', server);
				const env = { ARENA_AGENT_BRIDGE_SECRET: secret, ARENA_HEADLESS_RUN_ID: runId, ARENA_HEADLESS_SCENARIO_ID: scenario.id, ARENA_PROTOCOL_AUDIT_PATH: protocol, ARENA_PROVIDER_TURNS_PATH: turns, ARENA_HEADLESS_TRACE_PATH: path.join(directory, 'coordinator.jsonl'), ARENA_HEADLESS_PRIVATE_TRACE_PATH: path.join(directory, 'coordinator-private.jsonl'), ARENA_CAPTURE_SHUTDOWN_PATH: capture, ARENA_QUALITY_CAPTURE: scenario.qualitySetup ? '1' : '0', ARENA_HEADLESS_BRIDGE_PORT: String(ports.bridge), ARENA_HEADLESS_RCON_PORT: String(ports.rcon), ARENA_HEADLESS_MINECRAFT_PORT: String(ports.minecraft) };
				coordinator = start(process.execPath, [path.join(coordinatorRoot, 'coordinator/src/dynamic-main.mjs'), '--config', configFile], path.join(coordinatorRoot, 'coordinator'), path.join(directory, 'traces/dynamic'), env);
				await waitFor(async () => coordinatorReady(await text(protocol), scenario), startupMs, 'Coordinator readiness', coordinator);
				world.savedSpawn = parseSavedWorldSpawn(await readFile(path.join(serverDirectory, worldId, 'level.dat')));
				const rcon = new HeadlessRconClient({ port: ports.rcon, password: secret });
				try { await rcon.connect(); world.spawnLoading = await prepareSpawnChunk({ rcon, spawn: scenario.world.spawn.policy === 'surface' ? scenario.world.spawn : world.savedSpawn }); } finally { await rcon.close(); }
				await json(worldFile, world);
				const runner = start(process.execPath, [path.join(root, 'coordinator/src/headless-matrix.mjs'), '--config', matrixFile, '--scenario', scenario.id, '--run-directory', directory, '--rcon-host', '127.0.0.1', '--rcon-port', String(ports.rcon), '--rcon-password-file', passwordFile, '--protocol-audit', protocol, '--provider-turns', turns, '--world-manifest', worldFile, ...(options.RequireAll ? ['--require-all'] : [])], path.join(root, 'coordinator'), path.join(directory, 'traces/runner'), env);
				console.log(`Running ${scenario.id}: ${directory}`);
				await waitFor(() => exited(runner), scenario.timeoutMs + 30000, 'Scenario runner', runner);
				runnerReport = await readArtifactReport(path.join(directory, 'report.json'));
			} catch (error) { failure = error.message; console.error(`${scenario.id}: ${failure}`); }
			finally {
				if (coordinator && !exited(coordinator)) try { await requestCaptureShutdown(capture); } catch (e) { cleanupFailure = e.message; }
				if (server && !exited(server)) {
					server.stdin.on('error', () => {}); server.stdin.end('stop\n');
					const deadline = Date.now() + 10000; while (!exited(server) && Date.now() < deadline) await sleep(100);
				}
				// Each child leads a separate POSIX group. Kill that owned group, including provider descendants.
				for (const signal of ['SIGTERM', 'SIGKILL']) {
					for (const child of children) if (child.pid) try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') cleanupFailure = e.message; }
					await sleep(signal === 'SIGTERM' ? 1000 : 100);
				}
				for (const stream of streams) if (!stream.writableFinished) await new Promise(resolve => stream.end(resolve));
			}
			const report = { ...(runnerReport ?? {}), status: failure || cleanupFailure ? 'FAILED' : runnerReport?.status ?? 'FAILED', diagnostics: failure ?? runnerReport?.diagnostics ?? null, cleanup: { status: cleanupFailure ? 'FAILED' : 'CLEAN', error: cleanupFailure } };
			await writeArtifactReport(path.join(directory, 'report.json'), report); reports.push(report);
		}
		await writeArtifactReport(path.join(runDirectory, 'matrix-report.json'), { runId, scenarios: reports });
		return reports;
	} finally { process.off('SIGTERM', abort); process.off('SIGINT', abort); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const options = {};
		for (let i = 2; i < process.argv.length; i++) {
			const flag = process.argv[i];
			if (['-KeepArtifacts', '-RequireAll'].includes(flag)) options[flag.slice(1)] = true;
			else if (['-ProjectRoot', '-CoordinatorRoot', '-MatrixPath', '-ServerTemplate', '-ModJar'].includes(flag) && process.argv[i + 1]) options[flag.slice(1)] = process.argv[++i];
			else throw new Error(`Unsupported launcher argument ${flag}`);
		}
		const reports = await runMatrix(options);
		if (!reports.length || reports.some(r => r.status !== 'PASSED')) process.exitCode = 1;
	} catch (error) { console.error(error.stack); process.exitCode = 1; }
}
