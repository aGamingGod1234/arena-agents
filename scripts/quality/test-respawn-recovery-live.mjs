#!/usr/bin/env node
// Provider-free check of the facts the respawn wake states, through the production bridge actions:
//   node scripts/quality/test-respawn-recovery-live.mjs OUT_DIR [AWAY_SECONDS]
// 1. By day, place a bed and use it: "Respawn point set" and the respawn target moves to the bed.
// 2. Walk into a lit End portal: arrival on the obsidian platform at 100,49,0.
// 3. Die in the End with a kit; respawn with the agent's own respawn action: at the bed, in the Overworld.
// 4. Stay away AWAY_SECONDS (default 60), walk into the End portal with an empty inventory: arrival on the platform,
//    the drops still there with an age of only the ticks a player was near them, and a walk over them picks them up.
// Operator commands only build the fixture (floor, portal, kit, the death itself). No model call is made.
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/respawn-recovery-live');
const awaySeconds = Number(process.argv[3] ?? 60);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE || !process.env.JAVA_HOME) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME and launch under slot.sh live');
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const jar = join(root, 'build/libs/arena-agents-0.2.0.jar');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
await cp(jar, join(server, 'mods/arena-agents-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261024\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=peaceful\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Darenaagents.bridgePort=${port}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${join(out, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', (e) => this.accept(e)); bridge.on('ready', (e) => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex((w) => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex((e) => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: (e) => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}
const AGENT = 'Recover';
const result = { awaySeconds, steps: {} };
let rcon, bridge, inbox, record, observation, ordinal = 0;
const command = async (text) => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 10000 }); await rcon.connect(); }
	return (await rcon.command(text)).text;
};
async function observe() {
	const seq = observation?.eventSequence ?? 0;
	const next = inbox.wait('observation', (e) => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq);
	await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision });
	return (observation = (await next).payload);
}
async function act(type, args) {
	const id = `recover-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'recover-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const next = inbox.wait('action_result', (e) => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000);
	await bridge.send('action_command', record.agentId, payload);
	const r = (await next).payload;
	await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision });
	return { state: r.state, reasonCode: r.reasonCode ?? null, message: r.message ?? null };
}
const dimension = async () => String(await command(`data get entity ${AGENT} Dimension`)).match(/"([^"]+)"/)?.[1] ?? null;
const pos = async () => String(await command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map((v) => Math.round(Number(v) * 10) / 10) ?? null;
const held = (o) => (o?.inventory?.items ?? []).filter((i) => i.count > 0).map((i) => `${i.itemId.replace('minecraft:', '')}x${i.count}`);
async function waitDimension(id, ms = 20000) {
	for (let at = Date.now(); Date.now() - at < ms; await sleep(250)) if ((await dimension()) === id) return true;
	return false;
}
// The End drops sit on a stone ledge 12 blocks from the arrival point, so arriving does not walk over them.
const DROP = [88, 49, 0];
const itemsNearDrop = async () => {
	const count = await command(`execute in minecraft:the_end if entity @e[type=minecraft:item,x=${DROP[0]}.5,y=${DROP[1]},z=${DROP[2]}.5,distance=..8]`);
	const age = await command(`execute in minecraft:the_end run data get entity @e[type=minecraft:item,x=${DROP[0]}.5,y=${DROP[1]},z=${DROP[2]}.5,distance=..8,limit=1,sort=nearest] Age`);
	return { count: Number(String(count).match(/count: (\d+)/i)?.[1] ?? (/passed/i.test(count) ? 1 : 0)), raw: count, age: Number(String(age).match(/(-?\d+)s?$/)?.[1] ?? NaN) };
};
try {
	for (let i = 0; i < 180; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 10000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 179 || child.exitCode !== null) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', (e) => { if (e.agentId === record?.agentId && e.payload.ready) observation = e.payload; });
	// A death and respawn advance the goal revision; later requests must carry the current one.
	bridge.on('goal_control', (e) => { if (e.agentId === record?.agentId && Number.isSafeInteger(e.payload?.goalRevision) && e.payload.goalRevision !== record.goalRevision) {
		record.goalRevision = e.payload.goalRevision;
		bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	} });
	bridge.on('goal_spec_request', (e) => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free respawn fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set 1000');
	await command('forceload add -16 -16 32 32'); await sleep(2000);
	// Overworld: stone floor at y79, a lit End portal (3x3 at x4..6 z-1..1) and room for a bed at 0,80,2.
	await command('fill -5 80 -5 12 90 8 minecraft:air'); await command('fill -5 79 -5 12 79 8 minecraft:stone');
	await command('fill 3 79 -2 7 79 2 minecraft:end_portal_frame[eye=true]'); await command('fill 4 79 -1 6 79 1 minecraft:end_portal');
	const registered = inbox.wait('agent_registered'); await command(`execute positioned 0.5 80 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', (g) => g.payload.operation === 'start'); await command(`codex start ${AGENT} Survive for 1200 seconds.`);
	record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${AGENT}`); await command(`clear ${AGENT}`); await command(`give ${AGENT} minecraft:white_bed 1`);
	await observe();
	result.respawnAtStart = await command(`data get entity ${AGENT} respawn`);

	// 1. A bed placed and used by day sets the respawn there.
	result.steps.place = await act('place_block', { x: 0, y: 80, z: 2, face: 'up', itemId: 'minecraft:white_bed' });
	const placed = await observe();
	const bed = placed.blocks.find((b) => b.blockId === 'minecraft:white_bed');
	result.steps.use = bed ? await act('interact_block', { x: bed.x, y: bed.y, z: bed.z, face: 'up', hand: 'main', expectedItemId: 'minecraft:air' }) : { error: 'bed not observed' };
	await sleep(500);
	const used = await observe();
	result.dayTimeAtUse = used.world?.dayTime % 24000;
	result.messagesAtUse = (used.perception?.events ?? []).filter((ev) => ev.type === 'system_message' || ev.type === 'action_bar').map((ev) => ev.text);
	result.respawnAfterUse = await command(`data get entity ${AGENT} respawn`);
	result.bedSetsSpawnByDay = result.dayTimeAtUse < 12000 && result.messagesAtUse.includes('Respawn point set') && /pos/i.test(result.respawnAfterUse);

	// 2. Into the End portal with the kit: arrival on the obsidian platform at 100,49,0.
	for (const item of ['iron_pickaxe', 'iron_sword', 'golden_helmet']) await command(`give ${AGENT} minecraft:${item} 1`);
	await command(`give ${AGENT} minecraft:cobblestone 16`);
	await observe();
	result.kitBefore = held(observation);
	// The pool itself is no standable arrival cell (move_to: NO_STANDABLE_PATH), so walk in as a player does: face it, step up the frame.
	result.steps.approach1 = await act('move_to', { x: 1.5, y: 80, z: 0.5, tolerance: 0.6, sprint: false });
	result.steps.enter1 = await act('control', { forward: 1, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false, yaw: -90, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 30, instantLook: true });
	result.enteredEnd1 = await waitDimension('minecraft:the_end');
	await sleep(1500);
	result.arrival1 = await pos();
	// A stone ledge from the platform toward the island; the death happens at its far end.
	await command('execute in minecraft:the_end run forceload add 80 -16 112 16'); await sleep(1500);
	await command('execute in minecraft:the_end run fill 80 48 -8 97 48 8 minecraft:stone');
	await command('execute in minecraft:the_end run forceload remove 80 -16 112 16');
	await command(`execute in minecraft:the_end run tp ${AGENT} ${DROP[0]}.5 ${DROP[1]} ${DROP[2]}.5`);
	await sleep(1000);
	const dead = inbox.wait('goal_control', (g) => g.payload.operation === 'dead', 20000).catch(() => null);
	await sleep(3500); // a body just arrived in another dimension is invulnerable for 60 ticks
	await command(`kill ${AGENT}`);
	const death = await dead;
	result.death = death?.payload?.death ?? null;
	const diedAt = Date.now();
	await sleep(1500);
	result.dropsAtDeath = await itemsNearDrop();

	// 3. The agent's own respawn: at the bed in the Overworld.
	result.steps.respawn = await act('respawn', {});
	result.respawnedInOverworld = await waitDimension('minecraft:overworld');
	await sleep(1000);
	result.respawnPos = await pos();
	result.respawnAtBed = result.respawnedInOverworld && result.respawnPos && Math.hypot(result.respawnPos[0] - 0.5, result.respawnPos[2] - 2.5) <= 3;
	const back = await observe();
	result.inventoryAfterRespawn = held(back);

	// 4. Away from the End, then back in with nothing: the drops wait, aged only while a player was near them.
	const waitMs = Math.max(0, awaySeconds * 1000 - (Date.now() - diedAt));
	await sleep(waitMs);
	result.secondsAway = Math.round((Date.now() - diedAt) / 1000);
	result.steps.approach2 = await act('move_to', { x: 1.5, y: 80, z: 0.5, tolerance: 0.6, sprint: false });
	result.steps.enter2 = await act('control', { forward: 1, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false, yaw: -90, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 30, instantLook: true });
	result.enteredEnd2 = await waitDimension('minecraft:the_end');
	await sleep(1500);
	result.arrival2 = await pos();
	result.dropsOnReturn = await itemsNearDrop();
	result.steps.pickup = await act('move_to', { x: DROP[0] + 0.5, y: DROP[1], z: DROP[2] + 0.5, tolerance: 0.6, sprint: false });
	// Where the stacks lie (operator read, for the report only), then walk over each one.
	result.dropCells = [];
	for (let i = 0; i < 4; i++) {
		const text = await command(`execute in minecraft:the_end as @e[type=minecraft:item,x=${DROP[0]}.5,y=${DROP[1]},z=${DROP[2]}.5,distance=..8,sort=nearest,limit=1] run data get entity @s Pos`);
		const at = String(text).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number);
		if (!at) break;
		result.dropCells.push(at.map((v) => Math.round(v * 10) / 10));
		result.steps[`walk-${i}`] = await act('move_to', { x: Math.floor(at[0]) + 0.5, y: Math.floor(at[1]), z: Math.floor(at[2]) + 0.5, tolerance: 0.6, sprint: false });
		await sleep(700);
	}
	// Drops scatter a few blocks; collect each seen stack with the agent's own pick-up action.
	for (let round = 0; round < 3; round++) {
		const seen = await observe();
		result.itemsSeen ??= (seen.items ?? []).map((item) => ({ stableId: item.stableId ?? null, itemId: item.itemId ?? item.item?.itemId ?? null, distance: item.distance ?? null }));
		const rows = (seen.items ?? []).filter((item) => typeof item.stableId === 'string');
		if (!rows.length) break;
		for (const item of rows) result.steps[`pick-${round}-${item.stableId}`] = await act('pick_up_item', { targetSelector: item.stableId });
	}
	await sleep(1500);
	const after = await observe();
	result.inventoryAfterPickup = held(after);
	result.recovered = ['iron_pickaxe', 'iron_sword', 'golden_helmet'].every((id) => (after.inventory?.items ?? []).some((i) => i.itemId === `minecraft:${id}`));
	result.ok = result.bedSetsSpawnByDay && result.enteredEnd1 && result.respawnAtBed && result.enteredEnd2 && result.dropsOnReturn.count > 0
		&& result.dropsOnReturn.age < 20 * Math.min(30, result.secondsAway) && result.recovered;
} catch (error) {
	result.error = String(error?.stack ?? error);
} finally {
	await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result));
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close().catch(() => {});
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(15000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
process.exit(result.ok ? 0 : 1);
