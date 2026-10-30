#!/usr/bin/env node
// Provider-free live check of the Watcher's progress truth (arena-watch/<agentId>-progress.jsonl). Loads a copy of a
// saved run world (read only), puts a new agent at recorded save points (1-iron-pickaxe and 7-nether-real from
// arena-beat-game/long/checkpoints, and an End spot), sends a few actions that succeed and fail, and checks the lines:
// one every 5 s, the named target cells really hold the target block (asked over RCON), results counted by action and
// code, and the cost per line. Always launch under slot.sh live; ports come from SLOT_PORT_BASE. No model calls.
//   ARENA_HEADLESS_SERVER_TEMPLATE=... slot.sh live node scripts/quality/test-progress-live.mjs OUT_DIR
import { readFile, writeFile, mkdir, cp, readdir, unlink, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const out = resolve(process.argv[2] ?? 'runtime/progress-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port = Number(process.env.SLOT_PORT_BASE);
const runs = '/home/agaminggod/Desktop/Projects';
const run = (build, id, scenario) => join(runs, `aa-run-${build}/runtime/headless-runs/${id}/${scenario}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checkpoint = name => JSON.parse(readFileSync(join(runs, 'arena-beat-game/long/checkpoints', name)));

const NETHER_WORLD = run('04c7eb6f', 'run-1792572050992-1dcbdca5', 'q-hv46ld-e023-LONG-r1-765ee875');
const END_WORLD = run('617e2d5d', 'run-1792549073765-49c8e2d9', 'q-hhfpa1-2a32-LONG-r1-ae04bd69');
const iron = checkpoint('1-iron-pickaxe.json'), nether = checkpoint('7-nether-real.json');
// Saved worlds are copied without entity files, so the End spot makes its crystals and dragon with vanilla commands.
const WORLDS = [
	{ world: NETHER_WORLD, spots: [
		{ name: 'iron', dim: 'minecraft:overworld', pos: iron.setup.position, stay: 65_000, expect: ['iron', 'lava_pool', 'gravel', 'obsidian', 'nether_portal', 'portal_room', 'stronghold'] },
		{ name: 'nether', dim: 'minecraft:the_nether', pos: nether.setup.position, offPortal: true, stay: 30_000, expect: ['nether_portal', 'gravel', 'blaze_spawner', 'fortress'] },
		// The nearest fortress (vanilla locate), probe dropped into it: the fortress start and its blaze spawners.
		{ name: 'fortress', dim: 'minecraft:the_nether', locate: 'minecraft:fortress', pos: null, stay: 30_000, expect: ['fortress', 'blaze_spawner'] },
	] },
	{ world: END_WORLD, spots: [{ name: 'end', dim: 'minecraft:the_end', pos: [0.5, 75, 40.5], stay: 25_000, expect: ['crystals', 'dragon'],
		surface: true, setup: ['execute in minecraft:the_end positioned 10.5 0 40.5 positioned over motion_blocking run summon minecraft:end_crystal ~ ~ ~', 'execute in minecraft:the_end positioned -20.5 0 40.5 positioned over motion_blocking run summon minecraft:end_crystal ~ ~ ~', 'execute in minecraft:the_end run summon minecraft:ender_dragon 0.5 110 0.5'] }] },
];
// The block a reported cell must hold, per target kind.
const BLOCKS = { iron: '#minecraft:iron_ores', gravel: 'minecraft:gravel', obsidian: 'minecraft:obsidian', nether_portal: 'minecraft:nether_portal', portal_room: 'minecraft:end_portal_frame',
	blaze_spawner: 'minecraft:spawner', lava_pool: 'minecraft:lava' };

await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
let liveServer = null;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (liveServer?.exitCode === null) liveServer.kill('SIGKILL'); process.exit(1); });

class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', e => this.accept(e)); bridge.on('ready', e => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex(w => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex(e => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: e => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}

async function boot(dir, world) {
	const server = join(dir, 'server');
	await cp(template, server, { recursive: true });
	for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
	await cp(jarPath, join(server, 'mods/arena-agents-0.2.0.jar'));
	const saved = join(world, 'server', (await readdir(join(world, 'server'))).find(name => name.startsWith('headless-run-')));
	await cp(saved, join(server, 'world'), { recursive: true, filter: (path) => !/[\\/](players|entities)([\\/]|$)|session\.lock$/.test(path.slice(saved.length)) });
	await rm(join(server, 'world', 'session.lock'), { force: true });
	const secret = randomBytes(32).toString('hex');
	await writeFile(join(dir, 'secret.txt'), secret, { mode: 0o600 });
	await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nspawn-protection=0\nview-distance=8\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=false\ndifficulty=peaceful\n`);
	const log = await open(join(dir, 'server.log'), 'a');
	const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Darenaagents.bridgePort=${port}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${join(dir, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
	const s = { child, log, server, record: null, observation: null, ordinal: 0 };
	liveServer = child;
	for (let i = 0; i < 150; i++) { try { s.rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 30000 }); await s.rcon.connect(); break; } catch (e) { await s.rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	s.command = async (text) => (await s.rcon.command(text)).text;
	s.bridge = new MultiplexedServerBridge({ port, secret }, {}); s.inbox = new Inbox(s.bridge);
	s.bridge.on('goal_spec_request', e => { s.bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live progress fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = s.inbox.wait('ready'); s.bridge.start(); await ready;
	await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free progress fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await s.command('gamerule minecraft:send_command_feedback false');
	s.act = async (type, args) => {
		const id = `progress-${++s.ordinal}`;
		const payload = { actionId: id, traceId: id, goalRevision: s.record.goalRevision, actionType: type, arguments: args,
			provenance: { provider: s.record.provider, model: s.record.model, reasoningEffort: s.record.reasoningEffort, serviceTier: s.record.serviceTier, traceId: id, programId: 'progress-fixture', programVersion: 1, sourceStepId: id, eventSequence: 0 } };
		const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000);
		await s.bridge.send('action_command', s.record.agentId, payload);
		const r = (await next).payload;
		await s.bridge.send('action_result_ack', s.record.agentId, { actionId: id, goalRevision: s.record.goalRevision });
		return { state: r.state, reasonCode: r.reasonCode };
	};
	s.stop = async () => {
		await s.command('stop').catch(() => {});
		s.bridge?.stop(); await s.rcon?.close();
		await Promise.race([new Promise(r => child.once('exit', r)), sleep(15000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
	};
	return s;
}

const agent = 'Probe';
async function summon(s) {
	const registered = s.inbox.wait('agent_registered');
	// The catalog snapshot lands asynchronously; summon once it has.
	for (let i = 0; i < 20; i++) {
		const text = await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${agent}`);
		if (!/MODEL_CATALOG_UNAVAILABLE/.test(text)) { console.log(`[summon] ${text}`); break; }
		await sleep(1000);
	}
	const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', e => e.payload.operation === 'start'); await s.command(`codex start ${agent} Survive for 1200 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${agent}`);
	await s.command(`effect give ${agent} minecraft:resistance 600 5 true`);
	await s.command(`effect give ${agent} minecraft:fire_resistance 600 0 true`);
}

const linesOf = async (s) => {
	const file = join(s.server, 'arena-watch', `${s.record.agentId}-progress.jsonl`);
	try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};

async function holds(s, dim, pos, block) {
	if (!Array.isArray(pos) || pos.length !== 3) return null;
	return /passed/i.test(await s.command(`execute in ${dim} if block ${pos.join(' ')} ${block}`));
}

const results = { jar: jarPath, spots: {}, failures: [] };
const fail = (spot, message) => { results.failures.push(`${spot}: ${message}`); console.log(`[FAIL] ${spot}: ${message}`); };
const only = (process.env.SPOTS ?? '').split(',').filter(Boolean);
for (const [index, entry] of WORLDS.entries()) {
	if (only.length && !entry.spots.some(spot => only.includes(spot.name))) continue;
	const dir = join(out, `world-${index}`);
	await mkdir(dir, { recursive: true });
	let s;
	try {
		s = await boot(dir, entry.world);
		await summon(s);
		for (const spot of entry.spots) {
			if (only.length && !only.includes(spot.name)) continue;
			if (spot.locate) {
				const found = (await s.command(`execute in ${spot.dim} positioned ${nether.setup.position.join(' ')} run locate structure ${spot.locate}`)).match(/\[(-?\d+), ~?(-?\d*), (-?\d+)\]/);
				if (!found) { fail(spot.name, 'locate found nothing'); continue; }
				spot.pos = [Number(found[1]) + 0.5, 72, Number(found[3]) + 0.5];
				console.log(`[locate] ${spot.locate} at ${spot.pos.join(' ')}`);
			}
			const [x, y, z] = spot.pos;
			await s.command(`execute in ${spot.dim} run forceload add ${Math.floor(x) - 32} ${Math.floor(z) - 32} ${Math.floor(x) + 32} ${Math.floor(z) + 32}`);
			// The 7-nether-real save point stands in the arrival portal, which would carry the probe back: this copy loses it.
			if (spot.offPortal) await s.command(`execute in ${spot.dim} run fill ${Math.floor(x) - 4} ${Math.floor(y) - 2} ${Math.floor(z) - 4} ${Math.floor(x) + 4} ${Math.floor(y) + 4} ${Math.floor(z) + 4} minecraft:air replace minecraft:nether_portal`);
			await s.command(spot.surface ? `execute in ${spot.dim} positioned ${x} 0 ${z} positioned over motion_blocking run tp ${agent} ~ ~ ~` : `execute in ${spot.dim} run tp ${agent} ${x} ${y} ${z}`);
			await sleep(1_000);
			for (const command of spot.setup ?? []) await s.command(command);
			const before = (await linesOf(s)).length;
			await sleep(6_000);
			// A success and three identical failures (breaking air), so the window's counts can be checked.
			const actions = [await s.act('look_at', { x: x + 3, y: y + 1, z: z + 3 })];
			for (let i = 0; i < 3; i++) actions.push(await s.act('break_block', { x: Math.floor(x), y: Math.floor(y) + 1, z: Math.floor(z), timeoutMs: 3000 }));
			await sleep(spot.stay);
			const lines = (await linesOf(s)).slice(before).filter(l => l.dim === spot.dim);
			const gaps = lines.slice(1).map((l, i) => l.atMs - lines[i].atMs);
			const counted = {};
			for (const l of lines) for (const [type, counts] of Object.entries(l.results ?? {})) for (const [k, n] of Object.entries(counts)) counted[`${type} ${k}`] = (counted[`${type} ${k}`] ?? 0) + n;
			const last = lines.at(-1);
			const cells = {};
			for (const kind of spot.expect) {
				const t = last?.targets?.[kind];
				const pos = kind === 'lava_pool' ? t?.pool?.pos : t?.nearest?.pos;
				cells[kind] = { present: t !== undefined, value: t ?? null, holds: BLOCKS[kind] && pos ? await holds(s, spot.dim, pos, BLOCKS[kind]) : null };
				if (t === undefined) fail(spot.name, `${kind} missing from the line`);
				if (cells[kind].holds === false) fail(spot.name, `${kind} cell ${JSON.stringify(pos)} does not hold ${BLOCKS[kind]}`);
			}
			if (spot.name === 'fortress' && !(last?.targets?.fortress?.dist <= 48)) fail(spot.name, `fortress not near: ${JSON.stringify(last?.targets?.fortress)}`);
			if (spot.name === 'end' && !(last?.targets?.crystals?.left >= 2 && last?.targets?.dragon?.dist > 0)) fail(spot.name, `crystals or dragon not seen: ${JSON.stringify(last?.targets)}`);
			const costs = lines.map(l => l.costUs).sort((a, b) => a - b);
			results.spots[spot.name] = { lines: lines.length, gapsMs: gaps, actions, counted, costUs: { median: costs[costs.length >> 1] ?? null, max: costs.at(-1) ?? null },
				pos: last?.pos ?? null, action: last?.action ?? null, scan: last?.scan ?? null, cells };
			if (lines.length < Math.floor(spot.stay / 5_000)) fail(spot.name, `only ${lines.length} lines in ${spot.stay / 1000} s`);
			if (gaps.some(g => g < 4_000 || g > 6_500)) fail(spot.name, `line gaps ${gaps.join(',')}`);
			if (!(counted['break_block FAILED:TARGET_AIR'] >= 3 || Object.entries(counted).some(([k, n]) => k.startsWith('break_block FAILED') && n >= 3))) fail(spot.name, `break_block failures not counted: ${JSON.stringify(counted)}`);
			if (!(counted['look_at SUCCEEDED'] >= 1)) fail(spot.name, `look_at success not counted: ${JSON.stringify(counted)}`);
			console.log(`[spot] ${spot.name}: ${lines.length} lines, cost median ${results.spots[spot.name].costUs.median} us, max ${results.spots[spot.name].costUs.max} us; ${Object.entries(cells).map(([k, c]) => `${k}=${JSON.stringify(c.value)?.slice(0, 160)}${c.holds === null ? '' : c.holds ? ' (cell ok)' : ' (CELL WRONG)'}`).join('; ')}`);
		}
		const log = await readFile(join(dir, 'server.log'), 'utf8');
		results[`world-${index}-costLog`] = [...log.matchAll(/Watcher (?:progress )?cost: .*/g)].map(m => m[0]);
	} catch (error) {
		results.failures.push(`world-${index}: ${String(error?.stack ?? error).slice(0, 600)}`);
	} finally {
		await s?.stop().catch(() => {});
		await rm(join(dir, 'server', 'world'), { recursive: true, force: true }).catch(() => {});
		await rm(join(dir, 'server', 'libraries'), { recursive: true, force: true }).catch(() => {});
		await writeFile(join(out, 'progress-live.json'), JSON.stringify(results, null, 2));
	}
}
console.log(results.failures.length ? `FAILED: ${results.failures.join(' | ')}` : 'PASS');
process.exit(results.failures.length ? 1 : 0);
