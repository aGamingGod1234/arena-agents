#!/usr/bin/env node
// Provider-free check of a vanilla caged End crystal (EndSpikeFeature guarded spike, generated in the End). End runs
// 2026-10-21 lost 297 arrows in cage walls and 20-30 minutes a game on the two caged crystals. Checks: 1) the facts
// (appearance caged, the coordinator's crystal fact with the cage, method and height above the player); 2) the inspect
// row's arrowFromHere and the use_ranged refusals name the bars and what makes it hittable; 3) through the body: pillar
// up beside the cage, break the two wall bars, then a default bow shot from the ground on that side breaks it;
// 4) an open crystal hidden by its own pillar's top edge names how far out it shows, and a shot from there hits.
// Operator commands only build the fixture (items, teleports to fixture spots, dragon removal). ARENA_JAR selects the
// jar. Launch under slot.sh live.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { rememberEndCrystals, endCrystalFact } from '../../coordinator/src/dragon-fight-facts.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const out = resolve(process.argv[2] ?? 'runtime/caged-crystal-live');
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
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261017\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=8\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=peaceful\n`);
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
const agent = 'Caged';
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
const end = s => command(`execute in minecraft:the_end run ${s}`);
async function observe() { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }); return (await next).payload; }
async function inspect(query) {
	const requestId = `inspect-${++ordinal}`;
	const next = inbox.wait('inspection_result', e => e.payload.requestId === requestId);
	await bridge.send('inspection_request', record.agentId, { goalRevision: record.goalRevision, requestId, query });
	const r = (await next).payload;
	return r.result ?? r.error;
}
const actions = [];
async function act(type, args, eventSequence = observation?.eventSequence ?? 0) {
	const id = `cage-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'cage-fixture', programVersion: 1, sourceStepId: id, eventSequence } };
	const next = inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000);
	await bridge.send('action_command', record.agentId, payload);
	const r = (await next).payload;
	await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision });
	const row = { type, args, state: r.state, reasonCode: r.reasonCode, message: r.message ?? r.failure?.blockedBy ?? null, failure: r.failure ?? null };
	actions.push(row); await writeFile(join(out, 'actions.json'), JSON.stringify(actions, null, 2));
	return row;
}
const passed = text => /passed/i.test(text);
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }; };
// EndSpikeFeature.SpikeCacheLoader: ten pillars 42 blocks out round the centre.
const spikes = Array.from({ length: 10 }, (_, i) => ({ x: Math.floor(42 * Math.cos(2 * (-Math.PI + Math.PI / 10 * i))), z: Math.floor(42 * Math.sin(2 * (-Math.PI + Math.PI / 10 * i))) }));
const crystalRows = o => (o.entities ?? []).filter(e => e.type === 'minecraft:end_crystal');
const nearestCrystal = (o, spike) => crystalRows(o).find(e => Math.floor(e.position.x) === spike.x && Math.floor(e.position.z) === spike.z);
const facts = (o, state) => endCrystalFact(rememberEndCrystals(state, { world: { dimension: 'minecraft:the_end' }, entities: crystalRows(o).map(e => ({ stableId: e.uuid, type: e.type, perceivedBy: 'sight', x: e.position.x, y: e.position.y, z: e.position.z, appearance: e.appearance })) }), { y: o.position?.y });
async function groundAt(x, z) {
	for (let y = 80; y > 30; y--) if (passed(await end(`execute if block ${x} ${y} ${z} minecraft:end_stone`))) return y + 1;
	return null;
}
async function stand(x, y, z, faceX, faceY, faceZ) {
	const dx = faceX - x, dz = faceZ - z, dy = faceY - (y + 1.62);
	const yaw = Math.atan2(-dx, dz) * 180 / Math.PI, pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
	await end(`tp ${agent} ${x} ${y} ${z} ${yaw.toFixed(1)} ${pitch.toFixed(1)}`); await sleep(1500);
	await end('kill @e[type=minecraft:ender_dragon]');
	return observe();
}
async function seen(o, spike) { for (let i = 0; i < 10 && !nearestCrystal(o, spike); i++) { await sleep(300); o = await observe(); } return o; }
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) observation = e.payload; });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free caged crystal fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('forceload add -16 -16 16 16'); await sleep(2000);
	await command('fill -4 80 -4 4 80 4 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 81 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	await command(`effect give ${agent} minecraft:saturation 1200 4 true`);
	await command(`item replace entity ${agent} hotbar.0 with minecraft:bow`);
	await command(`item replace entity ${agent} hotbar.1 with minecraft:iron_pickaxe`);
	await command(`item replace entity ${agent} hotbar.2 with minecraft:cobblestone 64`);
	await command(`give ${agent} minecraft:arrow 64`);
	await end('forceload add -64 -64 64 64'); await sleep(4000);
	// The two guarded spikes: bars two blocks out at the crystal's height (heights 79 and 82, crystals at 80 and 83).
	const caged = [];
	for (const spike of spikes) for (const cy of [80, 83]) if (passed(await end(`execute if block ${spike.x + 2} ${cy} ${spike.z} minecraft:iron_bars`))) caged.push({ ...spike, cy });
	results.caged = caged;
	check('two caged spikes found', caged.length === 2, caged);
	const cage = caged[0];
	// The outward side (away from the centre), where the island floor is.
	const sx = Math.abs(cage.x) >= Math.abs(cage.z) ? Math.sign(cage.x) : 0, sz = sx === 0 ? Math.sign(cage.z) : 0;
	const centre = { x: cage.x + 0.5, y: cage.cy + 1, z: cage.z + 0.5 };
	let groundSpot = null;
	for (const outward of [20, 18, 22, 16, 24, 26, 14]) {
		const gx = cage.x + sx * outward, gz = cage.z + sz * outward, gy = await groundAt(gx, gz);
		if (gy !== null) { groundSpot = { x: gx + 0.5, y: gy, z: gz + 0.5, outward }; break; }
	}
	results.groundSpot = groundSpot;
	// 1. Facts from the ground.
	let o = await seen(await stand(groundSpot.x, groundSpot.y, groundSpot.z, centre.x, centre.y, centre.z), cage);
	const row = nearestCrystal(o, cage);
	results.appearance = row?.appearance ?? null;
	check('observation row reads caged', row?.appearance?.caged === true, row?.appearance);
	const state = {};
	results.factFromGround = facts(o, state);
	check('crystal fact names the cage, the method and the height above the player', /caged \(beside it feet y=\d+, \d+ above you\)/.test(results.factFromGround) && /arrows stick in the side walls/.test(results.factFromGround) && /break the 2 wall bars/.test(results.factFromGround), results.factFromGround);
	// 2. Tool messages: inspect, default shot, a hand-chosen aim over the cage.
	const inspected = await inspect({ section: 'entities', entityType: 'minecraft:end_crystal', limit: 16 });
	const inspectRow = (inspected.entities ?? inspected.rows ?? inspected.candidates ?? []).find?.(r => r.uuid === row.uuid) ?? JSON.stringify(inspected).match(/"arrowFromHere":"[^"]*"/g);
	results.inspectFromGround = inspectRow?.arrowFromHere ?? inspectRow;
	check('inspect says the bars block arrows and what opens it', /blocked: arrows stop at minecraft:iron_bars/.test(JSON.stringify(results.inspectFromGround)) && /wall bars at its height/.test(JSON.stringify(results.inspectFromGround)), results.inspectFromGround);
	const shot = await act('use_ranged', { targetId: row.uuid, drawDurationMs: 1100, timeoutMs: 6000 });
	results.defaultShotFromGround = shot;
	check('default shot is refused naming the bars and the way to open it', shot.state === 'FAILED' && shot.reasonCode === 'TARGET_OBSTRUCTED' && /iron_bars/.test(shot.message) && /wall bars at its height/.test(shot.message), shot.message);
	const aimed = await act('use_ranged', { targetId: row.uuid, drawDurationMs: 1100, timeoutMs: 6000, aimX: centre.x, aimY: centre.y + 3, aimZ: centre.z });
	results.aimedShotFromGround = aimed;
	check('hand-chosen aim into the wall is refused before loosing', aimed.state === 'FAILED' && /iron_bars/.test(aimed.message ?? ''), aimed.message);
	// 3. Through the body: pillar beside the cage, break the two wall bars at the crystal's height.
	const standX = cage.x + sx * 3, standZ = cage.z + sz * 3;
	const baseY = await groundAt(standX, standZ);
	results.pillarBase = baseY;
	await stand(standX + 0.5, baseY, standZ + 0.5, centre.x, centre.y, centre.z);
	await act('select_item', { itemId: 'minecraft:cobblestone' });
	const pillarStarted = Date.now();
	let feet = baseY;
	for (let i = 0; i < 80 && feet < cage.cy; i++) {
		await act('control', { forward: 0, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: true, yaw: 0, pitch: 90, selectedSlot: 2, hand: 'main', ticks: 10 });
		o = await observe(); feet = Math.floor(o.position.y + 1e-6);
	}
	await sleep(600); o = await observe(); feet = Math.floor(o.position.y + 1e-6);
	results.pillar = { from: baseY, to: feet, target: cage.cy, seconds: Math.round((Date.now() - pillarStarted) / 100) / 10, at: o.position };
	check('pillared up beside the cage to the crystal height through the body', feet >= cage.cy, results.pillar);
	const inspectTop = await inspect({ section: 'entities', entityType: 'minecraft:end_crystal', limit: 16 });
	results.inspectFromPillarBeforeBreak = JSON.stringify(inspectTop).match(/"arrowFromHere":"[^"]*"/g);
	await act('select_item', { itemId: 'minecraft:iron_pickaxe' });
	const bars = [[cage.x + sx * 2, cage.cy, cage.z + sz * 2], [cage.x + sx * 2, cage.cy + 1, cage.z + sz * 2]];
	results.breaks = [];
	for (const [x, y, z] of bars) results.breaks.push(await act('break_block', { x, y, z, expectedBlockId: 'minecraft:iron_bars', timeoutMs: 10000 }));
	check('both wall bars broken through the body', results.breaks.every(b => b.state === 'SUCCEEDED'), results.breaks.map(b => `${b.state} ${b.reasonCode}`));
	o = await seen(await observe(), cage);
	results.appearanceOpened = nearestCrystal(o, cage)?.appearance ?? null;
	results.factOpened = facts(o, state);
	check('appearance and fact list the opened bars', (results.appearanceOpened?.cageOpen ?? []).length === 2 && /open bars/.test(results.factOpened), { appearance: results.appearanceOpened, fact: results.factOpened });
	const inspectOpen = await inspect({ section: 'entities', entityType: 'minecraft:end_crystal', limit: 16 });
	results.inspectFromPillarAfterBreak = JSON.stringify(inspectOpen).match(/"arrowFromHere":"[^"]*"/g);
	// Back to the ground on that side (fixture teleport), then a default shot through the gap.
	await act('select_item', { itemId: 'minecraft:bow' });
	results.gapShots = [];
	for (const outward of [groundSpot.outward, groundSpot.outward + 6, groundSpot.outward - 4]) {
		const gx = cage.x + sx * outward, gz = cage.z + sz * outward, gy = await groundAt(gx, gz);
		if (gy === null) continue;
		o = await seen(await stand(gx + 0.5, gy, gz + 0.5, centre.x, centre.y, centre.z), cage);
		const target = nearestCrystal(o, cage);
		if (!target) { results.gapShots.push({ outward, error: 'crystal gone' }); break; }
		const r = await act('use_ranged', { targetId: target.uuid, drawDurationMs: 1100, timeoutMs: 6000 });
		results.gapShots.push({ outward, ground: gy, state: r.state, reasonCode: r.reasonCode, message: r.message });
		if (r.state === 'SUCCEEDED' && /broke/.test(r.message ?? '')) break;
	}
	// Hit rate through the gap: a fresh crystal in the opened cage, default shots from 20 blocks out on that side.
	{
		const gx = cage.x + sx * 20, gz = cage.z + sz * 20, gy = await groundAt(gx, gz);
		let hits = 0, shots = 0; const misses = [];
		for (let i = 0; i < Number(process.env.GAP_SHOTS ?? 8); i++) {
			await end('kill @e[type=minecraft:end_crystal,distance=..4,x=' + centre.x + ',y=' + cage.cy + ',z=' + centre.z + ']');
			await end(`summon minecraft:end_crystal ${centre.x} ${cage.cy} ${centre.z} {ShowBottom:0b}`);
			o = await seen(await stand(gx + 0.5, gy, gz + 0.5, centre.x, centre.y, centre.z), cage);
			const target = nearestCrystal(o, cage);
			if (!target) continue;
			const r = await act('use_ranged', { targetId: target.uuid, drawDurationMs: 1100, timeoutMs: 6000 });
			shots++;
			if (r.state === 'SUCCEEDED' && /broke/.test(r.message ?? '')) hits++; else misses.push(r.message);
		}
		results.gapRate = { hits, shots, misses };
	}
	check('a default bow shot from the ground through the gap breaks the caged crystal', results.gapShots.some(s => s.state === 'SUCCEEDED' && /broke/.test(s.message ?? '')), results.gapShots);
	// 4. An open crystal hidden by its own pillar's top edge from close below.
	const open = spikes.filter(s => !caged.some(c => c.x === s.x && c.z === s.z)).map(s => ({ ...s, out: Math.abs(s.x) >= Math.abs(s.z) ? [Math.sign(s.x), 0] : [0, Math.sign(s.z)] }));
	results.pillarEdge = null;
	// Walk in from far out until the crystal's own pillar top hides it from the eye (seen first from farther out).
	for (const spike of open) {
		let target = null, entry = null;
		for (const dist of [30, 24]) {
			const gx = spike.x + spike.out[0] * dist, gz = spike.z + spike.out[1] * dist, gy = await groundAt(gx, gz);
			if (gy === null) continue;
			const far = await seen(await stand(gx + 0.5, gy, gz + 0.5, spike.x + 0.5, 100, spike.z + 0.5), spike);
			const row = nearestCrystal(far, spike);
			// A player who saw it from out here walks in and shoots it: the command names that sighting.
			if (row) { target = { uuid: row.uuid, position: row.position, seenAt: far.eventSequence }; break; }
		}
		if (!target) continue;
		for (const dist of [5, 7, 9, 11]) {
			const gx = spike.x + spike.out[0] * dist, gz = spike.z + spike.out[1] * dist, gy = await groundAt(gx, gz);
			if (gy === null) continue;
			o = await stand(gx + 0.5, gy, gz + 0.5, spike.x + 0.5, 100, spike.z + 0.5);
			const r = await act('use_ranged', { targetId: target.uuid, drawDurationMs: 1100, timeoutMs: 6000 }, target.seenAt);
			const advised = Number((/clears that edge from about (\d+) blocks out/.exec(r.message ?? '') ?? [])[1]);
			if (r.state === 'SUCCEEDED' && /broke/.test(r.message ?? '')) { entry = { spike, brokeAt: dist }; break; }
			if (Number.isFinite(advised)) { entry = { spike, dist, crystalY: target.position.y, first: { state: r.state, reasonCode: r.reasonCode, message: r.message }, advised }; break; }
		}
		if (!entry?.advised) continue;
		const far = Math.ceil(entry.advised) + 2, fx = spike.x + spike.out[0] * far, fz = spike.z + spike.out[1] * far, fy = await groundAt(fx, fz);
		if (fy !== null) {
			o = await seen(await stand(fx + 0.5, fy, fz + 0.5, spike.x + 0.5, 100, spike.z + 0.5), spike);
			const again = nearestCrystal(o, spike) ?? target;
			const r2 = await act('use_ranged', { targetId: again.uuid, drawDurationMs: 1100, timeoutMs: 6000 });
			entry.fromAdvised = { far, ground: fy, state: r2.state, reasonCode: r2.reasonCode, message: r2.message };
		}
		results.pillarEdge = entry;
		break;
	}
	check('pillar-edge refusal says how far out the crystal shows', Number.isFinite(results.pillarEdge?.advised), results.pillarEdge?.first?.message);
	check('a shot from the advised distance is not refused at the pillar', results.pillarEdge?.fromAdvised && results.pillarEdge.fromAdvised.reasonCode !== 'TARGET_OBSTRUCTED', results.pillarEdge?.fromAdvised);
	results.summary = Object.fromEntries(Object.entries(results.checks).map(([k, v]) => [k, v.ok]));
	await writeFile(join(out, 'caged.json'), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results, null, 2));
} finally {
	await writeFile(join(out, 'caged.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
