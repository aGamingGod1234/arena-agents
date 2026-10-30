#!/usr/bin/env node
import { writeJsonl } from '../../coordinator/src/benchmark/jsonl-stream.mjs';
import { longProtocolRow, longTraceRow, longMetrics } from '../../coordinator/src/benchmark/long-run-artifacts.mjs';
import { requestCaptureShutdown } from '../../coordinator/src/capture-shutdown.mjs';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, createWriteStream } from 'node:fs';
import { cp, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requireRunBudgetPolicy, isStrictBudget, requireStrictGoal } from '../../coordinator/src/benchmark/auxiliary-budget-policy.mjs';
import { fileURLToPath } from 'node:url';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { extractQualityMetrics, parseJsonlDiagnostics, parseEntitySample, epoch, resolveGoalWindow, isVerifiedGoalCompletion, isEligibleQualityRun, firstAttemptQualityRuns } from '../../coordinator/src/benchmark/quality-metrics.mjs';
import { SPEED_TOKEN_PRICES_PER_MILLION } from '../../coordinator/src/benchmark/live-speed-benchmark.mjs';
import { readArtifactReport, writeArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';
import { findGeneralityInputLeaks } from '../../coordinator/src/benchmark/generality-suite.mjs';
import { activateQualitySetup, sampleQualityShelter } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { initialPlanEvidence } from '../../coordinator/src/benchmark/quality-metrics-v2.mjs';
import { liveSpendUsd, unmeteredProviderCalls } from '../../coordinator/src/benchmark/spend-ledger.mjs';
import { startAnthropicGateway, PREPARATION_ALLOWANCE_USD } from '../../coordinator/src/benchmark/spend-gate.mjs';
import { LadderEvaluator, evaluateSamples, parseSuccessCheck } from './ladder-evaluator.mjs';
import { spawnOwnedProcess, terminateChildProcess } from '../../coordinator/src/child-process-lifecycle.mjs';
import { collectWatchFiles } from './watch-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const DEFAULT_JAVA = path.join(ROOT, 'runtime/toolchains/temurin-25/jdk-25.0.3+9/bin', JAVA_EXE);
const DEFAULT_TEMPLATE = path.join(ROOT, 'runtime/server-template');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const directories = async dir => { try { return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => path.join(dir, e.name)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
const maybeText = async file => { try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };

export async function coordinatorFingerprint(root) {
	const fingerprint = createHash('sha256');
	const visit = async directory => {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) await visit(file);
			else fingerprint.update(path.relative(root, file).replaceAll(path.sep, '/') + '\0').update(await readFile(file));
		}
	};
	await visit(path.join(root, 'coordinator/src'));
	await visit(path.join(root, 'coordinator/config/minecraft-agent'));
	for (const file of ['coordinator/config/dynamic-agents.json', 'coordinator/package.json', 'coordinator/package-lock.json']) fingerprint.update(file + '\0').update(await readFile(path.join(root, file)));
	return fingerprint.digest('hex');
}

export function parseArgs(argv) {
	const accepted = new Set(['--scenarios', '--provider', '--model', '--effort', '--runs', '--jar', '--out', '--budget-ms', '--server-template', '--java', '--port-base', '--source-commit', '--coordinator-root', '--arms', '--harness-commit', '--play-window-ms', '--service-tier', '--seed', '--spawn']);
	const values = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--help') return { help: true };
		if (argv[i] === '--retry-failed') { values['retry-failed'] = true; continue; }
		if (!accepted.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument ${argv[i]}`);
		values[argv[i].slice(2)] = argv[++i];
	}
	if (values['source-commit'] && !/^[0-9a-f]{7,64}$/i.test(values['source-commit'])) throw new Error('--source-commit must be a Git hash');
	const harnessCommit = values['harness-commit'] ?? process.env.ARENA_QUALITY_HARNESS_COMMIT ?? null;
	if (harnessCommit && !/^[0-9a-f]{7,64}$/i.test(harnessCommit)) throw new Error('--harness-commit must be a Git hash');
	const provider = values.provider ?? 'claude';
	if (!['claude', 'codex', 'opencode'].includes(provider)) throw new Error('--provider must be claude, codex or opencode');
	const scenarios = (values.scenarios ?? 'S1,S1-deltas,S5').split(',');
	if (values['budget-ms'] && values['play-window-ms']) throw new Error('Use --budget-ms or --play-window-ms');
	// Without an explicit window, each scenario uses its own durationBudgetMs (see resolveQualityScenarios).
	const runs = Number(values.runs ?? 8), explicitBudget = values['play-window-ms'] ?? values['budget-ms'], budget = explicitBudget === undefined ? null : Number(explicitBudget);
	const serviceTier = values['service-tier'] ?? (provider === 'codex' ? 'default' : 'priority');
	if (!(provider === 'codex' ? ['default', 'priority', 'fast', 'flex'] : ['default', 'priority']).includes(serviceTier)) throw new Error('Unsupported --service-tier for provider');
	if (values.seed && (!/^-?\d+$/.test(values.seed) || BigInt(values.seed) < -(2n ** 63n) || BigInt(values.seed) >= 2n ** 63n)) throw new Error('--seed must be a signed 64-bit integer');
	const spawnPosition = values.spawn?.split(',').map(Number);
	if (spawnPosition && (spawnPosition.length !== 3 || values.spawn.split(',').some(n => !n.trim()) || spawnPosition.some(n => !Number.isFinite(n) || Math.abs(n) > 29000000))) throw new Error('--spawn must be x,y,z finite coordinates');
	const portBase = Number(values['port-base'] ?? process.env.ARENA_QUALITY_PORT_BASE ?? 0);
	if (portBase !== 0 && (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65533)) throw new Error('--port-base must be 1024..65533');
	if (!Number.isInteger(runs) || runs < 1 || runs > 32 || budget !== null && !validBudget(budget)) throw new Error('--runs must be 1..32; play window must be 1000..3600000 ms');
	if (scenarios.length * runs > 40) throw new Error('At most 40 scenario/repetition pairs per invocation');
	if (values['retry-failed'] && !values.arms) throw new Error('--retry-failed requires --arms');
	return { serviceTier, seed: values.seed ?? null, spawnPosition: spawnPosition ?? null, goalStartClock: Boolean(values['play-window-ms']), retryFailed: Boolean(values['retry-failed']), harnessCommit, arms: values.arms && path.resolve(values.arms), coordinatorRoot: path.resolve(values['coordinator-root'] ?? ROOT), sourceCommit: values['source-commit'] ?? null, provider, model: values.model ?? ({ claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol', opencode: 'opencode/deepseek-v4.1-flash-free' })[provider], effort: values.effort ?? 'low', runs, budget,
		scenarios, jar: values.jar && path.resolve(values.jar),
		portBase, out: path.resolve(values.out ?? path.join(ROOT, 'runtime/quality-results', `quality-${Date.now()}`)),
		template: path.resolve(values['server-template'] ?? process.env.ARENA_HEADLESS_SERVER_TEMPLATE ?? DEFAULT_TEMPLATE), java: values.java ?? process.env.ARENA_HEADLESS_JAVA ?? (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', JAVA_EXE) : DEFAULT_JAVA) };
}

// A sampler with no successful 1 Hz sample for this long is recorded as paused (dead player) or stalled, and logged.
export const SAMPLER_GAP_MS = 10000;
// One observer poll still running after this is reported and no longer blocks the scan of the others.
export const OBSERVER_POLL_STALL_MS = 30000;
const validBudget = (budget, maximum = 3600000) => Number.isInteger(budget) && budget >= 1000 && budget <= maximum;
export const DEFAULT_SAMPLED_ADVANCEMENTS = ['story/iron_tools', 'story/obtain_armor', 'nether/find_fortress', 'nether/find_bastion', 'end/kill_dragon'];

/** Scenario data drives budgets and which starts may be overridden; explicit CLI values apply to every selected scenario. */
export function resolveQualityScenarios(all, { scenarios, budget = null, seed = null, spawnPosition = null }, warn = console.warn) {
	return scenarios.map(id => {
		const s = all.find(s => s.id === id);
		if (!s) throw new Error(`Unknown scenario ${id}`);
		if ((seed !== null || spawnPosition !== null) && s.runPolicy?.overridableStart !== true) throw new Error(`--seed and --spawn require scenarios with runPolicy.overridableStart; ${id} has a fixed start`);
		const resolved = budget ?? s.durationBudgetMs, maximum = s.runPolicy?.maxWindowMs ?? 3600000;
		if (!validBudget(resolved, maximum)) throw new Error(`${id} needs durationBudgetMs or --budget-ms/--play-window-ms within 1000..${maximum}`);
		if (budget !== null && budget !== s.durationBudgetMs) warn(`${id}: explicit window ${budget} ms replaces scenario durationBudgetMs ${s.durationBudgetMs} ms`);
		return { ...s, durationBudgetMs: resolved, ...(seed === null ? {} : { seed }), ...(spawnPosition === null ? {} : { setup: { ...s.setup, position: spawnPosition } }) };
	});
}

export function isTerminalRconClosure(error) {
	return error?.code === 'RCON_CLOSED' || /^RCON (?:client|socket) (?:is )?closed$/.test(typeof error === 'string' ? error : error?.message ?? '');
}

export function measurementStatus(metrics, samples, errors = [], droppedLines = 0, provider = 'claude') {
	if (errors.length || droppedLines) return 'INCOMPLETE';
	if (!(metrics.modelCalls > 0 && samples.length > 1)) return 'UNAVAILABLE';
	if (metrics.tokenReconciliation?.complete !== true || provider === 'claude' && metrics.partialMessagesAccepted !== true) return 'INCOMPLETE';
	return 'MEASURED';
}

export class Tail {
	constructor(file, { project = row => row, journal = null, journalProject = row => row } = {}) { this.project = project; this.journal = journal; this.journalProject = journalProject; this.file = file; this.offset = 0; this.carry = ''; this.rows = []; this.droppedLines = 0; this.truncations = 0; }
	async parse(text) {
		const parsed = parseJsonlDiagnostics(text);
		this.droppedLines += parsed.droppedLines;
		const rows = parsed.rows.map(r => ({ ...r, observedAtMs: Date.now() }));
		if (this.journal) await writeJsonl(this.journal, rows.map(this.journalProject).filter(Boolean), { append: true });
		for (const row of rows) { const retained = this.project(row); if (retained) this.rows.push(retained); }
		return rows;
	}
	async finish() {
		try { await this.poll(); await this.parse(this.carry + (this.decoder?.end() ?? '')); this.carry = ''; }
		finally { await this.handle?.close(); this.handle = null; }
	}
	async drain(handle) {
		const size = (await handle.stat()).size;
		if (size < this.offset) { this.truncations++; this.offset = 0; this.carry = ''; this.decoder = new StringDecoder('utf8'); }
		const rows = [], buffer = Buffer.alloc(1024 * 1024);
		while (this.offset < size) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
			if (!bytesRead) break;
			this.offset += bytesRead;
			const text = this.carry + this.decoder.write(buffer.subarray(0, bytesRead));
			const last = text.lastIndexOf('\n');
			this.carry = text.slice(last + 1);
			if (last >= 0) for (const row of await this.parse(text.slice(0, last))) rows.push(row);
		}
		return rows;
	}
	async poll() {
		let current;
		try { current = await open(this.file, 'r'); } catch (e) { if (e.code === 'ENOENT') return this.handle ? this.drain(this.handle) : []; throw e; }
		const stat = await current.stat(), identity = `${stat.dev}:${stat.ino}`;
		const rows = [];
		if (this.handle && this.identity !== identity) {
			// Retaining the descriptor lets us drain the old inode even after rotation renamed or deleted it.
			for (const row of await this.drain(this.handle)) rows.push(row);
			for (const row of await this.parse(this.carry + this.decoder.end())) rows.push(row);
			await this.handle.close(); this.handle = null; this.offset = 0; this.carry = '';
		}
		if (!this.handle) { this.handle = current; this.identity = identity; this.decoder = new StringDecoder('utf8'); }
		else await current.close();
		for (const row of await this.drain(this.handle)) rows.push(row);
		return rows;
	}
}

/** Awaits the observer's poll for at most limitMs; a poll still running is awaited again next scan, never doubled. */
export async function pollWithin(observer, limitMs) {
	observer.pendingPoll ??= observer.poll().finally(() => { observer.pendingPoll = null; });
	let timer;
	try {
		await Promise.race([observer.pendingPoll, new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Observer poll still running after ${Math.round(limitMs / 1000)} s`)), limitMs);
		})]);
	} finally { clearTimeout(timer); }
}

export class Observer {
	/** controls.gate is the run's SpendGate; controls.hardStop terminates the process tree this runner started. */
	constructor(directory, manifest, definition, profile, { gate = null, hardStop = null, stopCommand = null, stopConfirmMs = 20000, stopRetryMs = 2000, maxStopFailures = 3, rconFactory = options => new HeadlessRconClient(options) } = {}) {
		Object.assign(this, { directory, manifest, definition, profile, samples: [], targets: [], errors: [], terminalObserverErrors: [], samplingGaps: [], startedAt: null, endedAt: null, initialPlan: null, rcon: null, agent: null, agentId: null, nextSample: 0 });
		Object.assign(this, { gate, hardStop, stopCommand, stopConfirmMs, stopRetryMs, maxStopFailures, rconFactory });
		this.longRun = definition.id === 'LONG';
		this.trace = new Tail(path.join(directory, 'coordinator.jsonl'), this.longRun ? { project: longTraceRow, journal: path.join(directory, 'quality-usage.jsonl'), journalProject: longTraceRow } : {});
		this.protocol = new Tail(manifest.protocolAudit, { journal: path.join(directory, 'quality-protocol.jsonl'), ...(this.longRun ? { project: longProtocolRow } : {}) });
		this.provider = new Tail(manifest.providerTurns, this.longRun ? { journal: path.join(directory, 'quality-provider-usage.jsonl'), journalProject: ({ input, output, ...usage }) => usage } : {});
	}
	async poll() {
		await this.progressStop();
		await this.collectWatch();
		await Promise.all([this.trace.poll(), this.provider.poll()]);
		const protocol = await this.protocol.poll();
		await this.progressStop();
		await this.capturePlan();
		const window = resolveGoalWindow(this.protocol.rows, { agentId: this.agentId, startedAt: this.startedAt, endedAt: this.endedAt });
		this.startedAt = window.startedAt; this.endedAt = window.endedAt;
		for (const r of protocol) {
			const e = r.envelope ?? r, p = e.payload ?? {};
			if (e.type === 'goal_control' && p.operation === 'dead') this.playerInactive = true;
			if (e.type === 'goal_control' && ['start', 'respawn'].includes(p.operation)) this.playerInactive = false;
			if (e.type === 'goal_control' && p.operation === 'start') { this.startedAt ??= p.updatedAtEpochMs ?? epoch(r); this.agentId ??= e.agentId; }
			if (isVerifiedGoalCompletion(r) || e.type === 'goal_control' && p.operation === 'stop') this.endedAt ??= p.updatedAtEpochMs ?? epoch(r);
			if (e.type === 'action_command' && /fight|attack/.test(p.actionType)) {
				const args = p.arguments ?? p.args ?? {};
				const targetId = args.targetId ?? args.targetSelector;
				if (this.rcon && !this.playerInactive && this.endedAt === null && targetId && /^[a-f0-9-]{36}$/.test(targetId)) {
					try {
					const target = parseEntitySample((await this.rcon.command(`data get entity ${targetId}`)).text);
					const player = parseEntitySample((await this.rcon.command(`data get entity ${this.agent}`)).text);
					if (target.position && player.position) this.targets.push({ actionId: p.actionId, at: Date.now(), position: target.position, verticalDelta: target.position.y - player.position.y });
					} catch (error) { this.errors.push(`Target ${p.actionId}: ${error.message}`); }
				}
			}
		}
		if (!this.agent) {
			const setupPath = path.join(this.directory, 'quality-setup.json');
			if (!existsSync(setupPath)) return;
			this.setup = await json(setupPath); this.agent = this.setup.agent;
			await this.connectRcon();
		}
		await this.enforceSpendCap();
		if ((this.definition.objective || this.definition.setup?.generality) && !this.inputLeakStopped && findGeneralityInputLeaks(this.provider.rows,this.definition).length) {
			this.errors.push('EVALUATOR_INPUT_LEAK: setup text reached model input');this.inputLeakStopped=true;
			await this.requestStop('EVALUATOR_INPUT_LEAK');
		}
		// The run stops the moment the goal ends, so take one last sample: the evaluator must see the state at the stop.
		if (this.startedAt !== null && this.endedAt !== null && !this.finalSampled && this.rcon && !this.playerInactive) {
			this.finalSampled = true;
			try { await this.samplePlayer(true); } catch (error) { this.errors.push(`Final sample: ${error.message}`); }
		}
		this.watchSampler();
		if (this.startedAt === null || this.endedAt !== null || this.playerInactive || Date.now() < this.nextSample) return;
		// A timed-out request retires its stream. Later read-only samples need a fresh connection.
		if (this.rcon?.state === 'closed') await this.connectRcon();
		const firstDecision = !this.definition.objective || this.trace.rows.some(r=>r.event==='native_model_call' && (!Number.isFinite(r.endedAt)||r.endedAt>=this.startedAt)) || this.protocol.rows.some(r=>(r.envelope??r).type==='action_command' && Number.isFinite(epoch(r)) && epoch(r)>=this.startedAt);
		if (this.setup?.definition.freezeUntilGoalStart && !this.preparationReleased && firstDecision) {
			await activateQualitySetup(this.setup, text=>this.rcon.command(text), {stage:'first-decision'});
			this.preparationReleased=true;
			await writeFile(path.join(this.directory, 'quality-setup.json'), JSON.stringify(this.setup,null,2));
		}
		try { await this.samplePlayer(); }
		catch (error) {
			await this.protocol.poll();
			const latestLifecycle = this.protocol.rows.map(r => r.envelope ?? r).findLast(e => e.type === 'goal_control' && (!this.agentId || e.agentId === this.agentId) && ['dead', 'start', 'respawn'].includes(e.payload?.operation));
			if (latestLifecycle) this.playerInactive = latestLifecycle.payload.operation === 'dead';
			if (error.code === 'QUALITY_PLAYER_UNAVAILABLE' && this.playerInactive) return;
			const terminal = resolveGoalWindow(this.protocol.rows, { agentId: this.agentId, startedAt: this.startedAt, endedAt: this.endedAt });
			this.startedAt = terminal.startedAt; this.endedAt = terminal.endedAt;
			if (isTerminalRconClosure(error) && terminal.endedAt !== null) this.terminalObserverErrors.push({ message: error.message, at: Date.now(), terminalAt: terminal.endedAt });
			else throw error;
		}
	}
	/**
	 * A sampler gap is never silent: a dead player pauses sampling (no entity to read) and anything else is a stall, an
	 * observer error. Each gap is kept in samplingGaps and logged when it starts and ends.
	 */
	watchSampler(now = Date.now()) {
		// A respawn restarts the stall clock: the first sample after it needs a moment.
		if (this.sampledInactive && !this.playerInactive) this.resumedAt = now;
		this.sampledInactive = this.playerInactive;
		const live = this.startedAt !== null && this.endedAt === null;
		// Local clock only: before the first sample, the gap counts from when this observer saw the goal start.
		const last = this.lastSampleAt ?? (live ? (this.liveSince ??= now) : null);
		const since = last === null ? null : this.playerInactive ? last : Math.max(last, this.resumedAt ?? last);
		const reason = this.playerInactive ? 'player dead' : 'no successful sample';
		const open = this.samplingGaps.at(-1)?.to === null ? this.samplingGaps.at(-1) : null;
		if (live && since !== null && now - since > SAMPLER_GAP_MS) {
			if (open?.reason === reason) return;
			if (open) open.to = now;
			this.samplingGaps.push({ from: since, to: null, reason });
			console.warn(`Sampler paused for ${this.manifest.scenarioId ?? this.directory}: ${reason}, last sample ${new Date(since).toISOString()}`);
			if (!this.playerInactive) this.errors.push(`Sampler stalled: no successful sample since ${new Date(since).toISOString()}`);
		} else if (open) {
			open.to = live ? since : now;
			console.log(`Sampler resumed for ${this.manifest.scenarioId ?? this.directory} after ${Math.round((open.to - open.from) / 1000)} s (${open.reason})`);
		}
	}
	/** Copies the mod's arena-watch files next to the run's other artifacts every 30 s, so pruning the server dir keeps them. */
	async collectWatch(force = false) {
		if (!force && Date.now() < (this.nextWatchCopy ?? 0)) return;
		this.nextWatchCopy = Date.now() + 30000;
		try { await collectWatchFiles(this.directory, this.directory, this.manifest.serverDirectory ?? path.join(this.directory, 'server')); }
		catch (error) { if (this.watchCopyError !== error.message) console.warn(`Watch file copy: ${error.message}`); this.watchCopyError = error.message; }
	}
	async connectRcon() {
		await this.rcon?.close?.();
		const password = (await readFile(path.join(this.directory, 'rcon-password.txt'), 'utf8')).trim();
		this.rcon = this.rconFactory({ port: this.manifest.ports.rcon, password, connectTimeoutMs: 1000, commandTimeoutMs: 2000, commandLock: path.join(this.directory, 'rcon-command.lock') });
		await this.rcon.connect();
	}
	async samplePlayer(final = false) {
		this.nextSample = Date.now() + 1000;
		const text = (await this.rcon.command(`data get entity ${this.agent}`)).text;
		if (/no entity was found/i.test(text)) throw Object.assign(new Error('Quality player disappeared during sampling'), { code: 'QUALITY_PLAYER_UNAVAILABLE' });
		const s = parseEntitySample(text);
		// The game clock the survival check counts in; null if the query fails, which falls back to wall time.
		const tick = Number((await this.rcon.command('time query gametime')).text.match(/time is (\d+)/i)?.[1] ?? NaN);
		s.gameTime = Number.isFinite(tick) ? tick : null;
		const hasObjective = type => this.definition.objective?.type === type || this.definition.objective?.predicates?.some(p => p.type === type);
		if(hasObjective('survival')){
			s.onFire=Number(text.match(/\bFire:\s*(-?[\d.]+)/)?.[1])>0;
			s.underWater=/time is \d+/i.test((await this.rcon.command(`execute at ${this.agent} if block ~ ~1.62 ~ minecraft:water run time query gametime`)).text);
			s.inLava=/time is \d+/i.test((await this.rcon.command(`execute at ${this.agent} if block ~ ~ ~ minecraft:lava run time query gametime`)).text);
			s.creeperNearby=/time is \d+/i.test((await this.rcon.command(`execute at ${this.agent} if entity @e[type=minecraft:creeper,distance=..6] run time query gametime`)).text);
		}
		if (hasObjective('shelter')) s.shelterEnclosed=await sampleQualityShelter(text=>this.rcon.command(text),this.agent);
		if (this.definition.objective?.rcon) s.objectiveMet = /time is \d+/i.test((await this.rcon.command(this.definition.objective.rcon.replaceAll('{agent}', this.agent))).text);
		for (const [field, objective] of [['damageTakenCounter', 'qo_damage'], ['deathCounter', 'qo_death']]) {
			const text = (await this.rcon.command(`scoreboard players get ${this.agent} ${objective}`)).text;
			s[field] = Number(text.match(/has (-?\d+) \[/)?.[1] ?? NaN);
		}
		s.advancements = [];
		for (const advancement of this.definition.sampledAdvancements ?? DEFAULT_SAMPLED_ADVANCEMENTS) {
			const text = (await this.rcon.command(`execute if entity @a[name=${this.agent},advancements={minecraft:${advancement}=true}] run time query gametime`)).text;
			if (/time is \d+/i.test(text)) s.advancements.push(advancement);
		}
		if ((s.damageTakenCounter ?? 0) > (this.samples.at(-1)?.damageTakenCounter ?? 0)) {
			const relation = (await this.rcon.command(`execute as ${this.agent} on attacker run data get entity @s Pos`)).text;
			s.lastAttackerEvidence = relation.includes('has the following entity data') ? relation : null;
		}
		await writeJsonl(path.join(this.directory, 'quality-samples.jsonl'), [s], { append: true });
		this.lastSampleAt = Date.now();
		if (this.longRun) { const { entityNbt, ...sample } = s; this.samples.push(sample); }
		else this.samples.push(s);
		if (final) return;
		const stopAdvancement = this.definition.runPolicy?.stopOnAdvancement;
		if (stopAdvancement && s.advancements.includes(stopAdvancement)) await this.requestStop('ADVANCEMENT', { advancement: stopAdvancement });
		await this.checkEvaluatorStop(s);
		await this.capturePlan();
	}
	/** Ladder only: stop the run once the evaluator-owned success check holds. Nothing is sent to the model. */
	async checkEvaluatorStop(sample) {
		if (!this.definition.evaluatorEarlyStop || this.stopRequest || this.startedAt === null) return;
		this.ladderEvaluator ??= new LadderEvaluator(parseSuccessCheck(this.definition.successCheck), { goalStartAt: this.startedAt, budgetMs: this.definition.durationBudgetMs });
		for (const prior of this.samples.slice(this.ladderEvaluator.fed ?? 0)) this.ladderEvaluator.push(prior);
		this.ladderEvaluator.fed = this.samples.length;
		const result = this.ladderEvaluator.result;
		if (result) await this.requestStop('EVALUATOR_PASS', { timeToPassMs: result.timeToPassMs });
	}
	/**
	 * Gateway-metered runs: the gate already refuses any call that could overrun, so a refusal (or a closed gate) ends play.
	 * Observer-metered Codex play: stop once metered spend plus one more call at the settlement's per-call charge reaches the cap.
	 */
	async enforceSpendCap() {
		if (this.stopRequest) return;
		if (this.gate && this.definition.playMetering !== 'observer') {
			if (this.gate.closed || this.gate.denied.length) await this.requestStop('SPEND_CAP', { gate: this.gate.totals() });
			return;
		}
		const cap = this.definition.spendCapUsd;
		if (!Number.isFinite(cap) || Date.now() < (this.nextSpendCheck ?? 0)) return;
		this.nextSpendCheck = Date.now() + 2000;
		this.liveSpend = liveSpendUsd({ traceRows: this.trace.rows, providerRows: this.provider.rows, profile: this.profile, reserveUsd: this.definition.runReserveUsd ?? 0 });
		if (this.liveSpend.usd + this.liveSpend.perCallUsd >= cap) await this.requestStop('SPEND_CAP', { capUsd: cap, spentUsd: this.liveSpend.usd });
	}
	/** A stop is pending until the protocol shows the goal ended; until then it is retried, and escalated to a process-tree stop. */
	async requestStop(reason, detail = {}) {
		if (this.stopRequest) return;
		this.gate?.close(reason);
		// An evaluator pass ends the owned attempt: pausing the goal would leave the player alive in a running world.
		this.stopRequest = { reason, at: Date.now(), ...detail, endAttempt: reason === 'EVALUATOR_PASS', state: 'pending', attempts: 0, failures: [] };
		// The stop pauses the goal while the world keeps running, so the run log must say why play ended.
		console.log(`Stopping play: ${reason} ${JSON.stringify(detail)}`);
		await this.progressStop();
	}
	async progressStop() {
		if (this.stopProgress) return this.stopProgress;
		this.stopProgress = this.advanceStop();
		try { await this.stopProgress; } finally { this.stopProgress = null; }
	}
	async advanceStop() {
		const stop = this.stopRequest;
		if (!stop || ['confirmed', 'escalated', 'escalating'].includes(stop.state)) return;
		const now = Date.now();
		if (!stop.endAttempt && (this.endedAt !== null || resolveGoalWindow(this.protocol.rows, { agentId: this.agentId, startedAt: this.startedAt }).endedAt !== null)) { Object.assign(stop, { state: 'confirmed', confirmedAt: now }); return; }
		if (now - stop.at >= this.stopConfirmMs || stop.failures.length >= this.maxStopFailures) {
			if (now < (stop.nextHardStopAt ?? 0)) return;
			stop.state = 'escalating';
			try {
				if (!this.hardStop) throw new Error('No owned process termination handler');
				await this.hardStop(stop.reason);
				Object.assign(stop, { state: 'escalated', escalatedAt: Date.now(), hardStopped: true });
			} catch (error) {
				Object.assign(stop, { state: 'pending', nextHardStopAt: Date.now() + this.stopRetryMs, hardStopError: error.message });
				(stop.hardStopFailures ??= []).push({ at: Date.now(), error: error.message });
				this.errors.push(`Hard stop failed: ${error.message}`);
			}
			return;
		}
		if (stop.endAttempt && stop.acknowledgedAt) {
			if (!stop.runnerStopRequestedAt) {
				await writeFile(path.join(this.directory, 'quality-stop.json'), JSON.stringify({ reason: stop.reason, at: stop.at }));
				stop.runnerStopRequestedAt = Date.now();
			}
			return;
		}
		if (now < (stop.nextAttemptAt ?? 0)) return;
		stop.attempts++; stop.nextAttemptAt = now + this.stopRetryMs;
		if (!this.rcon || !this.agent) { stop.failures.push({ at: now, error: 'No RCON connection to the player yet' }); return; }
		try {
			const text = String((await (this.stopCommand ? this.stopCommand(`codex stop ${this.agent}`) : this.rcon.command(`codex stop ${this.agent}`))).text ?? '');
			if (/unknown|incorrect|error|fail|not found|no agent|no player|usage:/i.test(text)) stop.failures.push({ at: now, error: `Stop rejected: ${text.slice(0, 200)}` });
			else stop.acknowledgedAt ??= Date.now();
		} catch (error) { stop.failures.push({ at: now, error: error.message }); }
	}
	async capturePlan() {
		if (!this.initialPlanEvidence) {
			const evidence = initialPlanEvidence(this.provider.rows ?? [], this.initialPlan);
			if (evidence) {
				await writeFile(path.join(this.directory, 'quality-initial-plan.json'), JSON.stringify(evidence, null, 2));
				this.initialPlanEvidence = evidence;
			}
		}
		if (this.initialPlan || !this.manifest.providerWorkspace) return;
		for (const file of (await readdir(path.join(this.manifest.providerWorkspace, 'player-memory', 'plans')).catch(() => [])).sort()) {
			if (!file.endsWith('.json')) continue;
			const plan = await json(path.join(this.manifest.providerWorkspace, 'player-memory', 'plans', file));
			if (plan.plan?.steps?.length) {
				this.initialPlan = plan;
				if (!this.initialPlanEvidence) {
					this.initialPlanEvidence = initialPlanEvidence([], this.initialPlan);
					await writeFile(path.join(this.directory, 'quality-initial-plan.json'), JSON.stringify(this.initialPlanEvidence, null, 2));
				}
				break;
			}
		}
	}
	async finish() {
		await this.collectWatch(true);
		await Promise.all([this.trace.finish(), this.protocol.finish(), this.provider.finish()]);
		await this.capturePlan();
		if (this.definition.objective && findGeneralityInputLeaks(this.provider.rows,this.definition).length && !this.inputLeakStopped) this.errors.push('EVALUATOR_INPUT_LEAK: setup text reached model input');
		if (this.rcon) await this.rcon.close();
		const memory = path.join(this.manifest.providerWorkspace, 'player-memory');
		let notebook = [], notebookDroppedLines = 0;
		for (const file of this.longRun ? [] : await readdir(memory).catch(() => [])) if (file.startsWith('notebook-actions-') && file.endsWith('.jsonl')) {
			const parsed = parseJsonlDiagnostics(await readFile(path.join(memory, file), 'utf8'), true);
			notebook.push(...parsed.rows); notebookDroppedLines += parsed.droppedLines;
		}
		const reportFile = path.join(this.directory, 'report.json');
		// A missing runner report stays NO_REPORT; an unreadable or tampered one is an observer error.
		const report = await readArtifactReport(reportFile).catch(error => {
			if (error.code !== 'ENOENT' || path.resolve(error.path ?? '') !== path.resolve(reportFile)) this.errors.push(`Runner report unreadable: ${error.message}`);
			return null;
		});
		const runner = report?.runner ?? report;
		const window = resolveGoalWindow(this.protocol.rows, { agentId: this.agentId, startedAt: this.startedAt, endedAt: this.endedAt });
		const end = window.endedAt ?? this.samples.at(-1)?.at ?? null;
		const jsonlDroppedLines = notebookDroppedLines + this.trace.droppedLines + this.protocol.droppedLines + this.provider.droppedLines;
		const metrics = this.longRun ? longMetrics({ traceRows: this.trace.rows, protocolRows: this.protocol.rows, profile: this.profile, providerRows: this.provider.rows }) : extractQualityMetrics({ traceRows: this.trace.rows, protocolRows: this.protocol.rows, providerRows: this.provider.rows, notebookRows: notebook,
			samples: this.samples, targetSamples: this.targets, initialPlan: this.initialPlan, initialPlanCapture: this.initialPlanEvidence, scenario: this.definition, profile: this.profile, startedAt: window.startedAt, endedAt: end, agentId: this.agentId, jsonlDroppedLines });
		const evaluation = this.definition.successCheck && typeof this.definition.evaluatorEarlyStop === 'boolean'
			? (() => { try { return evaluateSamples(this.samples, { ...this.definition, goalStartAt: window.startedAt, protocolRows: this.protocol.rows }); } catch (error) { return { status: 'ERROR', pass: false, error: error.message }; } })() : null;
		const runnerTermination = runner?.classification ?? report?.diagnostics ?? 'NO_REPORT';
		const run = { scenario: this.definition.id, name: this.definition.name, profile: this.profile, goalCompleted: window.goalCompleted, measurementStatus: measurementStatus(metrics, this.samples, this.errors, jsonlDroppedLines, this.profile.provider),
			diagnostics: runner?.diagnostics ?? null, errorCode: runner?.errorCode ?? null,
			termination: evaluation?.pass && evaluation.source === 'samples' ? 'EVALUATOR_PASS' : runnerTermination, runnerStatus: runner?.status ?? report?.status ?? null,
			metrics, definition: this.definition, setup: this.setup ?? null, artifacts: this.directory, observerErrors: this.errors, terminalObserverErrors: this.terminalObserverErrors,
			samplingGaps: this.samplingGaps, providerAttestation: runner?.settings ?? null, stopRequest: this.stopRequest ?? null, liveSpend: this.liveSpend ?? null,
			...(evaluation ? { evaluation, runnerTermination } : {}),
			unmeteredProviderCalls: unmeteredProviderCalls(this.trace.rows, this.provider.rows), capturedAt: new Date().toISOString() };
		// Protocol and samples are journaled during play, before any report extraction can fail.
		if (!this.longRun) await writeFile(path.join(this.directory, 'quality-samples.json'), JSON.stringify({ samples: this.samples, targets: this.targets }, null, 2));
		await writeArtifactReport(path.join(this.directory, 'quality-run.json'), run);
		return run;
	}
}

export function buildQualityScenario(s, { id = s.id, profile, budget = s.durationBudgetMs, goalStartClock = false } = {}) {
	const playWindowMs = goalStartClock || s.runPolicy?.clock === 'goal-start' ? budget : null;
	const preparationTimeoutMs = playWindowMs === null ? 0 : 300000;
	return { id, ...profile, task: s.goal, timeoutMs: budget + preparationTimeoutMs, scenarioTimeoutMs: budget + preparationTimeoutMs, rosterSize: 1, repetitions: 1,
		...(playWindowMs === null ? {} : { playWindowMs, preparationTimeoutMs }), continueAfterDeath: s.runPolicy?.continueAfterDeath === true,
		requireFactualSuccess: true, qualitySetup: s.setup, assert: [{ type: 'rcon', command: 'data get entity {agent} Pos', match: 'has the following entity data' }],
		world: { mode: 'natural', seed: s.seed, generator: 'minecraft:normal', difficulty: 'normal', gameMode: 'survival', rules: { advance_time: true, spawn_mobs: true, ...(s.worldRules ?? {}) }, spawn: s.worldSpawn ?? { policy: 'surface', x: 0, z: 0 } } };
}

// Template isolation, matrix process launch and JSONL append observation reuse the opt-bench approach.
export async function runScenarios(options, { spawnLauncher = spawnOwnedProcess, gatewayFactory = startAnthropicGateway, onObserver = null } = {}) {
	const strict = Boolean(options.spendGate) && isStrictBudget(options);
	if (options.spendGate) requireRunBudgetPolicy(options);
	const all = options.definitions ?? (await json(path.join(ROOT, 'scripts/quality/scenarios.json'))).scenarios;
	const selected = resolveQualityScenarios(all, options);
	if (strict) for (const scenario of selected) requireStrictGoal(scenario.goal);
	if (new Set(options.scenarios).size !== selected.length || selected.length * options.runs > 24) throw new Error('Select unique scenarios, at most 24 attempts per invocation');
	const profile = { provider: options.provider, model: options.model, reasoningEffort: options.effort, serviceTier: options.serviceTier ?? (options.provider === 'codex' ? 'default' : 'priority') };
	const version = (await readFile(path.join(ROOT, 'gradle.properties'), 'utf8')).match(/^mod_version=(.+)$/m)[1].trim();
	const jar = options.jar ?? path.join(ROOT, 'build/libs', `arena-agents-${version}.jar`);
	if (!existsSync(jar)) throw new Error(`Missing JAR ${jar}; build first or pass --jar`);
	if (!existsSync(options.java)) throw new Error(`Missing JDK ${options.java}`);
	const coordinatorRoot = options.coordinatorRoot ?? ROOT;
	if (strict) await validateStrictCoordinator(coordinatorRoot);
	const qualityCapture = await validateQualityCapture(coordinatorRoot, options.provider, { required: Boolean(options.arms) });
	const coordinatorSha256 = await coordinatorFingerprint(coordinatorRoot);
	const jarSha256 = createHash('sha256').update(await readFile(jar)).digest('hex');
	const token = `q-${Date.now().toString(36).slice(-6)}-${randomUUID().slice(0, 4)}`;
	const work = path.join(ROOT, 'runtime/quality', token), template = path.join(work, 'server-template');
	await mkdir(options.out, { recursive: true }); await mkdir(work, { recursive: true });
	await cp(options.template, template, { recursive: true, filter: entry => !['world', 'logs'].includes(path.basename(entry)) && !/^arena-agents-.*\.jar$/i.test(path.basename(entry)) });
	const definitions = new Map();
	const scenarios = [];
	for (let index = 1; index <= options.runs; index++) for (const s of selected) {
		const repetition = options.repetition ?? index;
		const id = `${token}-${s.id}-r${repetition}`; definitions.set(id, { ...s, repetition });
		scenarios.push(buildQualityScenario(s, { id, profile, goalStartClock: options.goalStartClock }));
	}
	const matrixFile = path.join(work, 'matrix.json'); await writeFile(matrixFile, JSON.stringify({ version: 1, scenarios }, null, 2));
	// A spend gate makes the budget hold per call: Claude play goes through a local gateway that reserves each request's worst case.
	// Codex with ChatGPT sign-in cannot be routed through it, so capped Codex play must be explicitly accepted as observer-metered.
	const gate = options.spendGate ?? null, playMetering = gate ? (options.provider === 'claude' ? 'gateway' : 'observer') : null;
	if (gate && playMetering === 'observer' && options.codexObserverCap !== true && options.provider !== 'opencode') throw new Error('A spend gate cannot meter Codex play per call; pass codexObserverCap to accept an observer-enforced cap');
	if (gate && options.runs * selected.length !== 1) throw new Error('A spend gate belongs to exactly one run');
	if (gate && !strict && !gate.admit('preparation', PREPARATION_ALLOWANCE_USD, 'preparation')) throw new Error(`Run budget $${gate.budgetUsd} cannot hold the $${PREPARATION_ALLOWANCE_USD} preparation allowance`);
	const gateway = gate && playMetering === 'gateway' ? options.gateway ?? await gatewayFactory({ gate, strict, profileFor: model => ({ ...profile, model }) }) : null;
	if (strict && gateway?.strict !== true) throw new Error('Strict run requires a strict gateway');
	let launcher = null, hardStopped = null;
	const hardStop = async reason => {
		if (!launcher) throw new Error('Owned launcher is unavailable');
		if (reason === 'EVALUATOR_PASS') await Promise.all([...observers.values()].map(async observer => {
			try { await requestCaptureShutdown(path.join(observer.directory, 'capture-shutdown.json')); }
			catch (error) { observer.errors.push(`Capture before hard stop: ${error.message}`); }
		}));
		await terminateChildProcess(launcher, { timeoutMs: 15000 }); hardStopped = { reason, at: Date.now() };
	};
	const observers = new Map(), scanErrors = [];
	let scanning = false, finished = false, matrixDirectory = null;
	const scan = async () => {
		if (scanning) return; scanning = true;
		try {
			for (const dir of await directories(path.join(ROOT, 'runtime/headless-runs'))) {
				if (matrixDirectory && matrixDirectory !== dir) continue;
				const matrix = await json(path.join(dir, 'matrix-manifest.json')).catch(() => null);
				if (!matrix?.scenarios?.some(s => definitions.has(s.id))) continue;
				matrixDirectory = dir;
				for (const runDir of await directories(dir)) {
					const manifest = await json(path.join(runDir, 'manifest.json')).catch(() => null);
					if (manifest && definitions.has(manifest.scenarioId) && !observers.has(manifest.scenarioId)) {
						observers.set(manifest.scenarioId, new Observer(runDir, manifest, { ...definitions.get(manifest.scenarioId), ...(playMetering ? { playMetering } : {}) }, profile, { gate, hardStop }));
						await writeArtifactReport(path.join(runDir, 'long-run-context.json'), { definition: definitions.get(manifest.scenarioId), profile, authoritativeDragon: strict, windowMs: definitions.get(manifest.scenarioId).durationBudgetMs });
						onObserver?.(observers.get(manifest.scenarioId));
						console.log(`Watching ${manifest.scenarioId}, RCON ${manifest.ports.rcon}`);
					}
				}
			}
			for (const observer of observers.values()) {
				try { await pollWithin(observer, OBSERVER_POLL_STALL_MS); }
				catch (e) {
					const message = e.message;
					if (observer.errors.at(-1) !== message) { observer.errors.push(message); console.warn(`Observer ${observer.manifest.scenarioId}: ${message}`); }
				}
			}
		} catch (e) { scanErrors.push(e.message); } finally { scanning = false; }
	};
	// Evidence discovery and reads must never block termination retries.
	const watchdog = setInterval(() => {
		for (const observer of observers.values()) void observer.progressStop().catch(error => observer.errors.push(`Stop watchdog: ${error.message}`));
	}, 100);
	const timer = setInterval(() => { if (!finished) void scan(); }, 100);
	const interrupt = signal => { void hardStop(`INTERRUPTED_${signal}`).catch(error => scanErrors.push(error.message)); };
	const onTerm = () => interrupt('SIGTERM'), onInt = () => interrupt('SIGINT');
	process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
	let result;
	try {
		result = await new Promise((resolve, reject) => {
			const stdout = createWriteStream(path.join(work, 'launcher.stdout.log')), stderr = createWriteStream(path.join(work, 'launcher.stderr.log'));
			const launcherCommand = process.platform === 'win32' ? 'powershell.exe' : process.execPath;
			const launcherArgs = process.platform === 'win32'
				? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/run-headless-provider-matrix.ps1')]
				: [path.join(ROOT, 'scripts/run-headless-provider-matrix.mjs')];
			const child = launcher = spawnLauncher(launcherCommand, [...launcherArgs,
				'-ProjectRoot', ROOT, '-CoordinatorRoot', options.coordinatorRoot ?? ROOT, '-MatrixPath', matrixFile, '-ServerTemplate', template, '-ModJar', jar, '-KeepArtifacts', '-RequireAll'],
				{ cwd: ROOT, windowsHide: true, env: { ...process.env, ...(gateway ? { ANTHROPIC_BASE_URL: gateway.url } : {}), ARENA_STRICT_SPEND_GATE: strict ? '1' : '0', ARENA_HEADLESS_JAVA: options.java, ARENA_HEADLESS_STARTUP_TIMEOUT_SECONDS: '300', ...(options.portBase ? { ARENA_HEADLESS_BRIDGE_PORT: String(options.portBase), ARENA_HEADLESS_RCON_PORT: String(options.portBase + 1), ARENA_HEADLESS_MINECRAFT_PORT: String(options.portBase + 2) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
			child.stdout.on('data', c => { stdout.write(c); process.stdout.write(c); }); child.stderr.on('data', c => { stderr.write(c); process.stderr.write(c); });
			child.once('error', reject); child.once('close', async (code, signal) => { await Promise.all([new Promise(r => stdout.end(r)), new Promise(r => stderr.end(r))]); resolve({ code, signal }); });
		});
	} finally { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); finished = true; clearInterval(timer); clearInterval(watchdog); await Promise.all([...observers.values()].map(observer => observer.progressStop())); while (scanning) await sleep(50); await scan(); if (gateway && !options.gateway) await gateway.close(); }
	const runs = [];
	for (const [id, definition] of definitions) {
		const observer = observers.get(id);
		const run = observer ? await observer.finish().catch(error => ({ scenario: definition.id, profile, definition, artifacts: observer.directory, measurementStatus: 'INCOMPLETE', termination: 'REPORT_EXTRACTION_FAILED', diagnostics: error.stack, metrics: null, observerErrors: [...observer.errors, error.message], stopRequest: observer.stopRequest ?? null })) : { scenario: definition.id, profile, definition, measurementStatus: 'UNAVAILABLE', termination: 'NO_OBSERVER', metrics: null };
		run.repetition = definition.repetition;
		if (hardStopped) { run.hardStopped = hardStopped; run.termination = hardStopped.reason; }
		if (run.artifacts) await writeArtifactReport(path.join(run.artifacts, 'quality-run.json'), run);
		if (gate) {
			const preparationUsd = run.metrics?.preparation?.costEstimateUsd ?? run.metrics?.overheadCostUsd;
			if (!strict) gate.settle('preparation', Number.isFinite(preparationUsd) ? preparationUsd : null, { calls: run.metrics?.overheadModelCalls ?? null });
			run.gate = { ...gate.totals(), playMetering, strict, preparationDisabled: strict, gatewayCalls: gateway?.calls.length ?? 0 };
			if (gateway && run.artifacts) await writeFile(path.join(run.artifacts, 'spend-gate-calls.json'), JSON.stringify(gateway.calls, null, 2));
			if (hardStopped) run.hardStopped = hardStopped;
		}
		runs.push(run); await writeArtifactReport(path.join(options.out, `${definition.id}-r${definition.repetition}.json`), run);
		await writeFile(path.join(options.out, `${definition.id}-r${definition.repetition}-timeline.txt`), formatTimeline(run));
	}
	const commit = await new Promise(resolve => { const c = spawn('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); let text = ''; c.stdout.on('data', b => text += b); c.once('close', () => resolve(text.trim())); });
	const sourceChangedDuringRun = coordinatorSha256 !== await coordinatorFingerprint(coordinatorRoot) || jarSha256 !== createHash('sha256').update(await readFile(jar)).digest('hex');
	if (sourceChangedDuringRun) for (const run of runs) {
		run.measurementStatus = 'INCOMPLETE';
		run.observerErrors = [...(run.observerErrors ?? []), 'Coordinator or JAR changed during measurement'];
		await writeArtifactReport(path.join(options.out, `${run.scenario}-r${run.repetition}.json`), run);
		await writeFile(path.join(options.out, `${run.scenario}-r${run.repetition}-timeline.txt`), formatTimeline(run));
	}
	const report = { schemaVersion: 2, benchmark: 'live-scenario-quality', capturedAt: new Date().toISOString(), harnessCommit: commit || options.harnessCommit || null, instrumentationSha256: await instrumentationFingerprint(), sourceCommit: options.sourceCommit, coordinatorSha256, scenarioDataSha256: createHash('sha256').update(options.definitions ? JSON.stringify(options.definitions) : await readFile(path.join(ROOT, 'scripts/quality/scenarios.json'))).digest('hex'),
		jar: { path: jar, sha256: jarSha256 }, sourceChangedDuringRun, qualityCapture,
		method: { server: 'fresh fixed-seed Fabric worlds, one owned headless server at a time, -Xmx2G, existing matrix launcher', coordinator: options.coordinatorRoot ?? ROOT,
			cost: 'Shared repository token-cost comparison proxy for play and preparation; provider-reported preparation USD retained separately; not subscription billing', rates: SPEED_TOKEN_PRICES_PER_MILLION, sampling: 'RCON entity NBT and vanilla scoreboard stats approximately once per second; trace epoch timestamps and audit append observation time' },
		runs, process: result, matrixDirectory, scanErrors, launcherLogs: work };
	await writeArtifactReport(path.join(options.out, 'results.json'), report);
	console.log(`Results: ${path.join(options.out, 'results.json')}`);
	if (runs.some(r => r.measurementStatus !== 'MEASURED')) process.exitCode = 1;
	return report;
}

export function pairedSchedule(scenarios, repetitions) {
	if (!Number.isInteger(repetitions) || repetitions < 3 || repetitions > 32) throw new Error('Paired benchmarks require at least 3 and at most 32 repetitions per arm');
	if (!scenarios.length || new Set(scenarios).size !== scenarios.length) throw new Error('Select unique scenarios');
	if (scenarios.length * repetitions > 40) throw new Error('At most 40 scenario/repetition pairs per invocation');
	return Array.from({ length: repetitions }, (_, i) => scenarios.flatMap(scenario => (i % 2 ? ['B', 'A'] : ['A', 'B']).map((arm, position) => ({ scenario, repetition: i + 1, arm, armOrderPosition: position + 1 })))).flat();
}

export const INSTRUMENTATION_FILES = ['scripts/quality/run-scenarios.mjs', 'scripts/quality/scenarios.json', 'scripts/quality/launch-scenarios.ps1', 'scripts/run-headless-provider-matrix.ps1', 'scripts/run-headless-provider-matrix.mjs', 'scripts/offline-server-policy.ps1', 'scripts/project-metadata.ps1', 'coordinator/src/headless-rcon.mjs', 'coordinator/src/provider-turn-recorder.mjs', 'coordinator/src/headless-matrix.mjs', 'coordinator/src/benchmark/report-artifacts.mjs', 'coordinator/src/benchmark/jsonl-stream.mjs', 'coordinator/src/benchmark/long-run-artifacts.mjs', 'coordinator/src/benchmark/long-run.mjs', 'scripts/quality/run-long.mjs', 'coordinator/src/benchmark/quality-scenarios.mjs', 'coordinator/src/benchmark/quality-metrics.mjs', 'coordinator/src/benchmark/quality-metrics-v2.mjs', 'coordinator/src/benchmark/quality-progress.mjs', 'coordinator/src/benchmark/live-speed-benchmark.mjs', 'coordinator/src/call-cost.mjs', 'coordinator/src/benchmark/spend-ledger.mjs', 'coordinator/src/benchmark/spend-gate.mjs'];
export async function instrumentationFingerprint(root = ROOT) {
	const hash = createHash('sha256');
	for (const file of INSTRUMENTATION_FILES) hash.update(file + '\0').update(await readFile(path.join(root, file)));
	return hash.digest('hex');
}

export async function validateQualityCapture(root, provider = 'claude', { required = true } = {}) {
	const [coordinator, service] = await Promise.all(['dynamic-main.mjs', `${provider}-service.mjs`].map(file => maybeText(path.join(root, 'coordinator/src', file))));
	if (!coordinator.includes('ARENA_QUALITY_CAPTURE') || !coordinator.includes('quality-first-message') || !coordinator.includes('quality_first_message')
		|| provider === 'claude' && (!service.includes('ARENA_QUALITY_CAPTURE') || !service.includes('quality_first_message') || !service.includes('8192'))
		|| provider === 'codex' && !service.includes("'agent_message'")) {
		const reason = `Quality ${provider} first-response capture is missing from the live coordinator. The shared hooks originate in b725a2a9 (coordinator/src/dynamic-main.mjs and coordinator/src/claude-service.mjs). Install identical hooks in both arm coordinators, commit and repin their hashes before paired launch.`;
		if (required) throw new Error(reason);
		return { verified: false, provider, reason };
	}
	return { verified: true, provider, maxResponseChars: 8192, method: 'Live coordinator capture hook and provider message source preflight; ARENA_QUALITY_CAPTURE is enabled by the quality launcher.' };
}

export async function validateArmBuild(build, arm, provider = 'claude', { requireCapture = true } = {}) {
	if (!build?.coordinatorRoot || !build.jar || !/^[a-f0-9]{7,64}$/i.test(build.commit ?? '') || !/^[a-f0-9]{64}$/i.test(build.expectedJarSha256 ?? '') || !/^[a-f0-9]{64}$/i.test(build.expectedCoordinatorSha256 ?? '')) throw new Error(`Arm ${arm} requires coordinatorRoot, jar, commit, expectedJarSha256 and expectedCoordinatorSha256`);
	for (const file of [build.jar, path.join(build.coordinatorRoot, 'coordinator/src/dynamic-main.mjs')]) if (!existsSync(file)) throw new Error(`Missing arm artifact: ${file}`);
	const coordinatorSha256 = await coordinatorFingerprint(build.coordinatorRoot);
	const jarSha256 = createHash('sha256').update(await readFile(build.jar)).digest('hex');
	if (jarSha256 !== build.expectedJarSha256.toLowerCase()) throw new Error(`Arm ${arm} expected JAR hash mismatch`);
	if (coordinatorSha256 !== build.expectedCoordinatorSha256.toLowerCase()) throw new Error(`Arm ${arm} expected coordinator hash mismatch`);
	let gitHead = null;
	if (existsSync(path.join(build.coordinatorRoot, '.git'))) {
		const git = promisify(execFile);
		const opts = { cwd: build.coordinatorRoot, windowsHide: true };
		gitHead = (await git('git', ['rev-parse', 'HEAD'], opts)).stdout.trim();
		if (!gitHead.toLowerCase().startsWith(build.commit.toLowerCase())) throw new Error(`Arm ${arm} HEAD does not match commit`);
		if ((await git('git', ['status', '--porcelain'], opts)).stdout.trim()) throw new Error(`Arm ${arm} refuses dirty Git tree`);
	}
	const [service, coordinator, usageView] = await Promise.all([`${provider}-service.mjs`, 'dynamic-main.mjs', 'live-task-view.mjs'].map(file => maybeText(path.join(build.coordinatorRoot, 'coordinator/src', file))));
	if (provider === 'claude' && (!/#emitCallUsage\s*\(/.test(service) || !service.includes('partialMessagesAccepted:') || !service.includes('modelCallId:'))
		|| !coordinator.includes("scope: 'thread_total'") || !coordinator.includes("usageSource: 'provider'")
		|| !coordinator.includes('nativeUsageTraceFields(value, usageState, usageRecord)') || !usageView.includes('export function updateUsage(')) throw new Error(`Arm ${arm} requires the shared accounting and trace-schema patches before launch`);
	const qualityCapture = await validateQualityCapture(build.coordinatorRoot, provider, { required: requireCapture });
	return { coordinatorSha256, jarSha256, gitHead, gitVerified: gitHead !== null, tracePatchVerified: true, qualityCapture };
}

export async function runPairedScenarios(options, execute = runScenarios, timing = {}) {
	const arms = await json(options.arms), pinned = {};
	for (const arm of ['A', 'B']) pinned[arm] = await validateArmBuild(arms[arm], arm, options.provider);
	if (pinned.A.jarSha256 === pinned.B.jarSha256 && pinned.A.coordinatorSha256 === pinned.B.coordinatorSha256) throw new Error('A and B must not have identical JAR and coordinator hashes');
	const schedule = pairedSchedule(options.scenarios, options.runs).map((entry, i) => ({ ...entry, executionOrder: i + 1 }));
	const checkpoint = path.join(options.out, 'results.json');
	if (!options.retryFailed && (await directories(options.out)).length + (await readdir(options.out).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).length) throw new Error('Use a fresh output directory, or --retry-failed for ineligible pairs');
	const saved = options.retryFailed ? await readArtifactReport(checkpoint) : null;
	const configuration = { scenarios: options.scenarios, runs: options.runs, provider: options.provider, model: options.model, effort: options.effort, budget: options.budget ?? null, serviceTier: options.serviceTier ?? null, seed: options.seed ?? null, spawnPosition: options.spawnPosition ?? null, goalStartClock: Boolean(options.goalStartClock), harnessCommit: options.harnessCommit ?? null };
	const currentInstrumentation = await instrumentationFingerprint();
	if (saved && (JSON.stringify(saved.configuration) !== JSON.stringify(configuration) || saved.instrumentationSha256 !== currentInstrumentation || JSON.stringify(saved.pinnedArms) !== JSON.stringify(pinned))) throw new Error('Retry configuration, instrumentation or pinned arms differ from original benchmark');
	const reports = saved?.arms ?? {}, sequence = saved?.sequence ?? [], history = saved?.history ?? [];
	const eligiblePair = id => {
		const rows = ['A', 'B'].map(arm => reports[arm]?.runs.filter(run => run.pairId === id) ?? []);
		if (!rows.every(runs => runs.length === 1 && isEligibleQualityRun(runs[0]))) return false;
		const [a, b] = rows.map(runs => runs[0]);
		return Math.abs((a.actualExecutionOrder ?? a.executionOrder) - (b.actualExecutionOrder ?? b.executionOrder)) === 1;
	};
	const selectedPairs = new Set(schedule.filter(entry => !options.retryFailed || !eligiblePair(`${entry.scenario}-r${entry.repetition}`)).map(entry => `${entry.scenario}-r${entry.repetition}`));
	const activeSchedule = schedule.filter(entry => selectedPairs.has(`${entry.scenario}-r${entry.repetition}`));
	const wait = timing.sleep ?? sleep, now = timing.now ?? Date.now;
	await mkdir(options.out, { recursive: true });
	const save = async () => {
		for (const arm of ['A', 'B']) if (reports[arm]) {
			reports[arm].firstAttemptRuns = firstAttemptQualityRuns(reports[arm].runs, history.filter(run => run.arm === arm), sequence.filter(row => row.arm === arm));
			await writeArtifactReport(path.join(options.out, `${arm}.json`), reports[arm]);
		}
		await writeArtifactReport(checkpoint, { schemaVersion: 3, benchmark: 'paired-live-scenario-quality', design: 'Counterbalanced AB/BA, fresh fixed-seed worlds, paired by scenario and repetition', configuration, instrumentationSha256: currentInstrumentation, pinnedArms: pinned, cacheControl: { gapMs: 60000, basis: 'Fixed 60-second post-run gap before each arm including first/retry; cache lifetime unknown; first-call warmth is reported per pair and excluded from verdict gates' }, arms: reports, sequence, history, complete: schedule.every(entry => reports[entry.arm]?.runs.some(run => run.pairId === `${entry.scenario}-r${entry.repetition}`)) });
	};
	await save();
	for (const entry of activeSchedule) {
		const pairId = `${entry.scenario}-r${entry.repetition}`, build = arms[entry.arm];
		const retryAttempt = sequence.filter(row => row.executionOrder === entry.executionOrder).length;
		const out = path.join(options.out, entry.arm, pairId, `attempt-${retryAttempt + 1}`);
		const gapStartedAtMs = now(); await wait(60000); const gapEndedAtMs = now();
		await validateArmBuild(build, entry.arm, options.provider);
		const report = await execute({ ...options, ...build, sourceCommit: build.commit, runs: 1, repetition: entry.repetition, scenarios: [entry.scenario], out });
		if (report.coordinatorSha256 !== pinned[entry.arm].coordinatorSha256 || report.jar?.sha256 !== pinned[entry.arm].jarSha256) throw new Error(`Arm ${entry.arm} differs from pinned artifacts during benchmark`);
		const prior = reports[entry.arm];
		if (prior) for (const field of ['instrumentationSha256', 'scenarioDataSha256']) if (prior[field] !== report[field]) throw new Error(`Arm ${entry.arm} changed ${field} during benchmark`);
		if (report.runs.length !== 1 || report.runs[0].scenario !== entry.scenario || report.runs[0].repetition !== entry.repetition) throw new Error('Executor must return exactly the requested scenario/repetition');
		for (const run of report.runs) Object.assign(run, { arm: entry.arm, pairId, executionOrder: entry.executionOrder, originalExecutionOrder: entry.executionOrder, armOrderPosition: entry.armOrderPosition, retry: Boolean(options.retryFailed), retryAttempt, actualExecutionOrder: sequence.length + 1, cacheGap: { requestedMs: 60000, actualMs: gapEndedAtMs - gapStartedAtMs, startedAtMs: gapStartedAtMs, endedAtMs: gapEndedAtMs } });
		const replaced = prior?.runs.filter(run => run.pairId === pairId) ?? [];
		history.push(...replaced);
		reports[entry.arm] = { ...report, runs: [...(prior?.runs.filter(run => run.pairId !== pairId) ?? []), ...report.runs] };
		sequence.push({ ...entry, retry: Boolean(options.retryFailed), retryAttempt, out, process: report.process });
		await save();
	}
	return reports;
}

export function formatTimeline(run) {
	const m = run.metrics;
	return `${run.scenario} ${run.measurementStatus} ${run.termination}\n${m ? `Calls ${m.modelCalls}; actions ${m.actions}; wall ${m.wallTimeMs}ms; tokens ${JSON.stringify(m.tokens)}; cost proxy USD ${m.costEstimateUsd}\nFirst text: ${m.firstTurnUnderstanding?.text ?? 'unavailable'}\nInitial plan: ${JSON.stringify(m.initialPlanSteps)}\n` : ''}\n` +
		(m?.timeline ?? []).map(r => `${r.elapsedMs ?? '?'}ms ${r.tool} ${r.argsSummary} => ${r.resultCode}; hp=${r.health}; pos=${JSON.stringify(r.position)}; dim=${r.dimension}`).join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { const options = parseArgs(process.argv.slice(2)); if (options.help) console.log('node scripts/quality/run-scenarios.mjs --scenarios S1,S1-deltas,S5 --provider claude|codex|opencode --model claude-opus-5-5 --effort low --runs 8 --arms arms.json --out DIR [--retry-failed] [--budget-ms MS | --play-window-ms MS (default: scenario durationBudgetMs)] [--service-tier priority] [--seed INTEGER --spawn X,Y,Z] [--coordinator-root PATH --jar PATH]; acceptance gate is Claude only'); else if (options.arms) await runPairedScenarios(options); else await runScenarios(options); }
	catch (e) { console.error(e.stack); process.exitCode = 1; }
}

/** Refuse older or mismatched coordinator enforcement before starting its provider processes. */
export async function validateStrictCoordinator(root) {
 for (const file of ['strict-spend-runtime.mjs', 'provider-service.mjs', 'dynamic-main.mjs', 'agent-planner.mjs', 'claude-service.mjs', 'provider-environment.mjs']) {
  const relative = path.join('coordinator/src', file);
  const [expected, actual] = await Promise.all([readFile(path.join(ROOT, relative)), readFile(path.join(root, relative))]);
  if (!expected.equals(actual)) throw new Error(`Strict coordinator enforcement mismatch: ${file}; use this runner's coordinator build`);
 }
}
