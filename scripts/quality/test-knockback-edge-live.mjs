#!/usr/bin/env node
// Provider-free check of knockback at a bridge edge. Runs d6/d7 2026-10-20 died five times to falls off high edges
// (fortress bridges 22 blocks over the floor, a pillared stair over a 32-block drop to lava, the dragon on flat
// ground): every footing fact said "drop 1-4, atLeast" over a 20+ block drop, and a cancelled sneaking control frame
// released shift while the body hung over a bridge end. Checks on a 1-wide bridge 22 blocks over stone:
// 1) footing facts beside the bridge (move result and the attention observation after a hit);
// 2) a small fireball (blaze shot) from the side: displacement and fall standing, sneaking, and with a block on the
//    open side; 3) a sneak-walk to the bridge end cancelled mid-frame keeps the body on the bridge.
// ARENA_JAR selects the jar (old vs new). Launch under slot.sh live; operator commands build fixtures only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const out = resolve(process.argv[2] ?? 'runtime/knockback-edge-live');
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
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261021\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=normal\n`);
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
const agent = 'Bridger';
const footings = [];
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
async function observe() { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }); return (await next).payload; }
function command_(type, args) {
	const id = `kb-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'kb-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const done = inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000)
		.then(async e => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return e.payload; });
	return { id, sent: bridge.send('action_command', record.agentId, payload), done };
}
async function act(type, args) { const c = command_(type, args); await c.sent; return c.done; }
const numbers = text => (/\[([^\]]*)\]/.exec(text)?.[1] ?? '').split(',').map(v => Number(v.trim().replace(/[a-z]$/i, '')));
const pos = async () => { const [x, y, z] = numbers(await command(`data get entity ${agent} Pos`)); return { x, y, z }; };
const round = v => Math.round(v * 100) / 100;
const reset = async () => {
	await command(`fill -8 81 -3 8 83 3 minecraft:air`); await command(`fill -8 80 -3 8 80 3 minecraft:air`);
	await command(`fill -6 80 0 6 80 0 minecraft:stone`);
	await command(`kill @e[type=minecraft:small_fireball]`);
	await command(`extinguish ${agent}`).catch(() => {});
	await command(`effect give ${agent} minecraft:instant_health 1 5 true`);
};
/** Fires a small fireball from 3 blocks on the -z side at the body; returns how far the hit carried it and whether it fell. */
async function shot(label, { sneak = false, wall = false } = {}) {
	await reset();
	if (wall) await command(`setblock 0 81 1 minecraft:stone`);
	await command(`tp ${agent} 0.5 81 0.5 -90 10`); await sleep(1500);
	const hold = sneak ? command_('control', { forward: 0, strafe: 0, jump: false, sneak: true, sprint: false, attack: false, use: false, yaw: -90, pitch: 10, selectedSlot: 0, hand: 'main', ticks: 70 }) : null;
	if (hold) { await hold.sent; await sleep(400); }
	const start = await pos();
	await command(`summon minecraft:small_fireball 0.5 81.9 -2.5 {Motion:[0.0,0.0,0.6],acceleration_power:0.0}`);
	let minY = start.y, far = 0, last = start;
	for (let i = 0; i < 30; i++) { await sleep(100); last = await pos(); minY = Math.min(minY, last.y); far = Math.max(far, Math.hypot(last.x - start.x, last.z - start.z)); }
	if (hold) await hold.done.catch(() => null);
	const result = { label, sneak, wall, start, end: { x: round(last.x), y: round(last.y), z: round(last.z) }, horizontal: round(far), fell: round(start.y - minY) };
	console.log(JSON.stringify(result));
	return result;
}
/** Sneak-walks toward the bridge end (x=7 edge) and cancels the frame mid-way; returns whether the body stayed up. */
async function cancelledSneak(cancelAfterMs) {
	await reset();
	await command(`tp ${agent} 4.5 81 0.5 -90 70`); await sleep(1500);
	const frame = command_('control', { forward: 1, strafe: 0, jump: false, sneak: true, sprint: false, attack: false, use: false, yaw: -90, pitch: 70, selectedSlot: 0, hand: 'main', ticks: 80 });
	await frame.sent; await sleep(cancelAfterMs);
	const before = await pos();
	await bridge.send('action_cancel', record.agentId, { goalRevision: record.goalRevision, actionId: frame.id });
	const result = await frame.done.catch(e => ({ state: String(e) }));
	await sleep(2000);
	const after = await pos();
	const row = { cancelAfterMs, xAtCancel: round(before.x), after: { x: round(after.x), y: round(after.y) }, stayed: after.y > 80.5, state: result.state, message: String(result.message ?? '').slice(0, 200) };
	console.log(JSON.stringify(row));
	return row;
}
const results = { footing: {}, shots: [], cancel: [] };
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) { observation = e.payload; if (e.payload.player?.footing) footings.push({ attention: e.payload.attention === true, footing: e.payload.player.footing }); } });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free knockback fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('forceload add -32 -32 32 32'); await sleep(2000);
	// Floor 22 blocks under the bridge's walking surface, like the fortress bridge the runs fell from.
	await command('fill -16 58 -16 16 58 16 minecraft:stone'); await command('fill -16 59 -16 16 100 16 minecraft:air');
	await command('fill -6 80 0 6 80 0 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 81 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	await command(`effect give ${agent} minecraft:saturation 1200 4 true`);
	// Resistance 255 absorbs every hit and landing; knockback is applied before damage, so the push is unchanged.
	await command(`effect give ${agent} minecraft:resistance 1200 255 true`);
	await command(`item replace entity ${agent} hotbar.0 with minecraft:cobblestone 64`);

	// 1. Footing beside the bridge, as a terminal move result reports it (looking along the bridge, not down).
	await command(`tp ${agent} -1.5 81 0.5 -90 10`); await sleep(1500);
	const moved = await act('move_to', { x: 0.5, y: 81, z: 0.5, tolerance: 0.3, sprint: false });
	results.footing.moveResult = /footing \{[^}]*\}/.exec(moved.message ?? '')?.[0] ?? null;

	// 2. Blaze-style shots from the side.
	results.shots.push(await shot('standing'));
	results.shots.push(await shot('sneaking', { sneak: true }));
	results.shots.push(await shot('block on the open side', { wall: true }));
	results.footing.afterHits = footings.filter(f => f.attention).map(f => f.footing).slice(0, 4);

	// 3. A sneak-walk to the bridge end, cancelled while the body hangs over the edge.
	for (const ms of [2500, 3000, 3500]) results.cancel.push(await cancelledSneak(ms));

	results.summary = {
		moveFooting: results.footing.moveResult,
		attentionFooting: results.footing.afterHits[0] ?? null,
		shots: results.shots.map(s => `${s.label}: pushed ${s.horizontal}, fell ${s.fell}`),
		cancelStayed: `${results.cancel.filter(c => c.stayed).length}/${results.cancel.length}`,
		jar: jarPath,
	};
	console.log(JSON.stringify(results.summary, null, 2));
} finally {
	await writeFile(join(out, 'knockback-edge.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
