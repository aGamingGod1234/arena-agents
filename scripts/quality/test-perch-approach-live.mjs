#!/usr/bin/env node
// Provider-free check of closing in on the perched dragon's head from where a player waits (12-16 blocks out).
// End runs 2026-10-21 (617e2d5d, 10 games): 30 perches lasted 31-56 s with the player within 20 blocks, yet 14
// fight_target calls on the head (12 with shield:true) landed 0 hits: the approach crawled at about 0.9 m/s and stalled
// 14-15 blocks out. Each case lands the dragon, puts the player at the given distance and bearing, and runs
// fight_target on the head; it reports seconds to the first damage, damage in the case and the result. The behind-*
// cases first sprint to 3 blocks behind the head: measured 2026-10-21, the perched dragon's wings threw the body there
// (vanilla knockBack runs while it sits), so that spot is no melee spot. PERCH_CASES=a,b runs only the named cases.
// ARENA_JAR selects the jar (old vs new).
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const out = resolve(process.argv[2] ?? 'runtime/perch-approach-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true, jarSha256: createHash('sha256').update(await readFile(jarPath)).digest('hex'), node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
await cp(jarPath, join(server, 'mods/arena-agents-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261017\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Darenaagents.bridgePort=${port}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${join(out, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
await writeFile(join(out, 'server.pid'), String(child.pid));
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', e => this.accept(e)); bridge.on('ready', e => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex(w => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex(e => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: e => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}
let rcon, bridge, record, observation, inbox, ordinal = 0;
const agent = 'Slayer';
const actions = [];
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
const end = s => command(`execute in minecraft:the_end run ${s}`);
async function observe() { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }); return (await next).payload; }
async function executeAction(c) {
	const args = c.action.arguments;
	const payload = { actionId: c.actionId, traceId: c.provenance.traceId, goalRevision: record.goalRevision, actionType: c.action.type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: c.provenance.traceId, programId: c.provenance.programId, programVersion: c.provenance.programVersion ?? 1, sourceStepId: c.provenance.stepId, eventSequence: c.provenance.eventSequence } };
	const next = inbox.wait('action_result', e => e.payload.actionId === c.actionId && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000);
	await bridge.send('action_command', record.agentId, payload);
	const r = (await next).payload;
	await bridge.send('action_result_ack', record.agentId, { actionId: c.actionId, goalRevision: record.goalRevision });
	actions.push({ type: c.action.type, args, state: r.state, reasonCode: r.reasonCode, message: r.message });
	await writeFile(join(out, 'actions.json'), JSON.stringify(actions, null, 2));
	return r;
}
async function act(type, args, eventSequence = observation.eventSequence) {
	const id = `dragon-${++ordinal}`;
	return executeAction({ actionId: id, action: { type, arguments: args }, provenance: { traceId: id, programId: 'dragon-fixture', stepId: id, eventSequence } });
}
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(text.trim()) ?? [])[1]);
const dragonHealth = async () => number(await end('data get entity @e[type=minecraft:ender_dragon,limit=1] Health'));
const dragonPhase = async () => number(await end('data get entity @e[type=minecraft:ender_dragon,limit=1] DragonPhase'));
/** A fresh observation's part rows of the dragon, by part name. */
async function parts() {
	const o = await observe();
	const rows = (o.entities ?? []).filter(e => e.type === 'minecraft:ender_dragon' && e.partName);
	return Object.fromEntries(rows.map(e => [e.partName, e]));
}

const results = { cases: [] };
const ALL_CASES = [
	{ name: 'shield-15-east', distance: 15, bearing: 0, args: { pursue: true, shield: true } },
	{ name: 'noshield-15-east', distance: 15, bearing: 0, args: { pursue: true, shield: false } },
	{ name: 'shield-12-north', distance: 12, bearing: 90, args: { pursue: true, shield: true } },
	{ name: 'noshield-12-north', distance: 12, bearing: 90, args: { pursue: true, shield: false } },
	{ name: 'shield-15-west', distance: 15, bearing: 180, args: { pursue: true, shield: true } },
	{ name: 'shield-12-south', distance: 12, bearing: 270, args: { pursue: true, shield: true } },
	// 3 blocks behind the head (toward the fountain centre), inside the wings' throw, then swing.
	{ name: 'behind-12-east', distance: 12, bearing: 0, behind: 3, args: { pursue: false, shield: false } },
	{ name: 'behind-12-north', distance: 12, bearing: 90, behind: 3, args: { pursue: false, shield: false } },
	{ name: 'behind-12-south', distance: 12, bearing: 270, behind: 3, args: { pursue: true, shield: false } },
];
const CASES = process.env.PERCH_CASES ? ALL_CASES.filter(c => process.env.PERCH_CASES.split(',').includes(c.name)) : ALL_CASES;
/** Non-air cells (y 58-68) of each block column on the straight line from the player to the head, for stall reports. */
async function lineColumns(from, to) {
	const cols = [];
	const steps = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z));
	for (let i = 0; i <= steps; i++) {
		const x = Math.floor(from.x + (to.x - from.x) * i / steps), z = Math.floor(from.z + (to.z - from.z) * i / steps);
		if (cols.some(c => c.x === x && c.z === z)) continue;
		const solid = [];
		for (let y = 58; y <= 68; y++) if (/passed/i.test(await end(`execute unless block ${x} ${y} ${z} minecraft:air`))) solid.push(y);
		cols.push({ x, z, solid });
	}
	return cols;
}
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) observation = e.payload; });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free perch fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('forceload add -16 -16 16 16'); await sleep(2000);
	await command('fill -3 80 -3 3 80 3 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 81 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	await command(`effect give ${agent} minecraft:resistance 1200 4 true`);
	await command(`effect give ${agent} minecraft:saturation 1200 4 true`);
	await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
	await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);

	await end('forceload add -48 -48 48 48');
	await end(`tp ${agent} 0.5 120 0.5`);
	await command(`effect give ${agent} minecraft:slow_falling 30 0 true`);
	let dragonSeen = false;
	for (let i = 0; i < 60 && !dragonSeen; i++) { await sleep(1000); dragonSeen = Number.isFinite(await dragonHealth()); }
	await end('kill @e[type=minecraft:end_crystal]');
	await end(`tp ${agent} 40.5 90 0.5`); await sleep(6000);
	await command(`effect clear ${agent} minecraft:slow_falling`);
	for (const c of CASES) {
		// Away while it lands (beyond 20 blocks), so the landing is a fresh perch.
		await end(`execute positioned 40.5 0 0.5 positioned over motion_blocking_no_leaves run tp ${agent} ~ ~ ~`);
		await end('data merge entity @e[type=minecraft:ender_dragon,limit=1] {DragonPhase:3,Health:200f}');
		let phase = -1;
		for (let i = 0; i < 80 && ![5, 6, 7].includes(phase); i++) { await sleep(500); phase = await dragonPhase(); }
		const rad = c.bearing * Math.PI / 180, sx = 0.5 + Math.cos(rad) * c.distance, sz = 0.5 + Math.sin(rad) * c.distance;
		await end(`execute positioned ${sx.toFixed(1)} 0 ${sz.toFixed(1)} positioned over motion_blocking_no_leaves run tp ${agent} ~ ~ ~ facing 0.5 66 0.5`);
		await sleep(700);
		const rows = await parts();
		const row = { name: c.name, args: c.args, phase, head: rows.head?.position ?? null, headDistance: rows.head?.distance ?? null };
		if (!rows.head) { row.skipped = 'head not in view'; results.cases.push(row); continue; }
		if (c.behind) {
			await sleep(1500); rows.head = (await parts()).head ?? rows.head; row.phaseBeforeMove = await dragonPhase();
			const h = rows.head.position, len = Math.hypot(h.x - 0.5, h.z - 0.5) || 1;
			const spot = { x: h.x - (h.x - 0.5) / len * c.behind, z: h.z - (h.z - 0.5) / len * c.behind };
			const moved = await act('move_to', { x: Math.round(spot.x * 10) / 10, y: Math.round(observation.position.y), z: Math.round(spot.z * 10) / 10, tolerance: 1.5, sprint: true });
			row.move = { state: moved.state, reasonCode: moved.reasonCode, message: (moved.message ?? '').slice(0, 400), spot, phaseAfter: await dragonPhase(), at: observation?.position };
			rows.head = (await parts()).head ?? rows.head;
		}
		const before = await dragonHealth(), t0 = Date.now();
		let firstHurtS = null, lastHp = before;
		const track = [];
		const poll = setInterval(async () => {
			try {
				const hp = await dragonHealth(); const s = (Date.now() - t0) / 1000;
				if (firstHurtS === null && hp < before) firstHurtS = s;
				const clouds = (observation?.player?.clouds ?? []).map(c => c.contact ?? null);
				lastHp = hp; track.push({ s: Math.round(s * 10) / 10, hp, clouds, at: observation?.position ? [observation.position.x, observation.position.y, observation.position.z].map(v => Math.round(v * 10) / 10) : null });
			} catch {}
		}, 500);
		const r = await act('fight_target', { targetId: rows.head.uuid, timeoutMs: 12000, fleeAtHealth: 4, ...c.args });
		clearInterval(poll); await sleep(300);
		Object.assign(row, { state: r.state, reasonCode: r.reasonCode, seconds: (Date.now() - t0) / 1000, firstHurtS, healthDrop: before - await dragonHealth(), endPhase: await dragonPhase(), message: (r.message ?? '').slice(0, 600), track });
		if (!(row.healthDrop > 0) && observation?.position) row.line = await lineColumns(observation.position, rows.head.position);
		results.cases.push(row);
		console.log(JSON.stringify({ name: row.name, reasonCode: row.reasonCode, firstHurtS, healthDrop: row.healthDrop, seconds: row.seconds }));
		await writeFile(join(out, 'perch.json'), JSON.stringify(results, null, 2));
	}
	results.summary = results.cases.map(c => ({ name: c.name, reasonCode: c.reasonCode, firstHurtS: c.firstHurtS, healthDrop: c.healthDrop }));
	results.jar = jarPath;
	await writeFile(join(out, 'perch.json'), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results.summary, null, 2));
} finally {
	await writeFile(join(out, 'perch.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
