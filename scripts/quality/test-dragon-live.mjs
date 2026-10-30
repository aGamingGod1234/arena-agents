#!/usr/bin/env node
// Provider-free check of the dragon fight body: default bow shots at crystals half hidden by their pillar tops, default
// shots at the flying dragon (lead), an arrow at the perched dragon, and fight_target on the perched dragon's head.
// End runs 2026-10-20: default shots passed 1.1-1.6 blocks over partly hidden crystals; arrows at the flying dragon
// missed by 4-9 blocks; fight_target refused the perched head (TARGET_NOT_LIVING). ARENA_JAR selects the jar (old vs new).
// 2026-10-21: a perched dragon's row read "hovering" from the ground with its last flight velocity, and a model-armed
// target_in_reach -> attack reflex could not strike the dragon at all (its root is not pickable); 2d checks both.
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
const out = resolve(process.argv[2] ?? 'runtime/dragon-live');
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
const uuid = n => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const uuidInts = n => `[I;0,0,0,${n}]`;
const results = { hiddenCrystals: [], flying: [], perchedArrow: null, perchedMelee: null };
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) observation = e.payload; });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free dragon fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('forceload add -64 -64 64 64'); await sleep(2000);
	await command('fill -64 79 -64 64 125 64 minecraft:air'); await command('fill -3 80 -3 3 80 3 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 81 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	await command(`effect give ${agent} minecraft:resistance 1200 4 true`);
	await command(`effect give ${agent} minecraft:saturation 1200 4 true`);
	await command(`item replace entity ${agent} weapon.mainhand with minecraft:bow`);
	await command(`item replace entity ${agent} hotbar.1 with minecraft:iron_sword`);
	await command(`give ${agent} minecraft:arrow 64`);

	// 1. Crystals on 5x5 pillars 25-30 up and 38-52 out: the pillar top hides their middle, only the top shows.
	let n = 100;
	const face = async (x, y, z) => { const dx = x - 0.5, dz = z - 0.5, dy = y + 1 - 82.62; const yaw = Math.atan2(-dx, dz) * 180 / Math.PI; const pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI; await command(`tp ${agent} 0.5 81 0.5 ${yaw.toFixed(1)} ${pitch.toFixed(1)}`); await sleep(500); };
	const spots = [[40, 106, 0], [0, 108, 44], [-36, 110, -20], [30, 105, -34], [-45, 107, 15], [20, 110, 46]];
	for (const [x, y, z] of spots) {
		const id = ++n;
		await command(`fill ${x - 2} 80 ${z - 2} ${x + 2} ${y - 1} ${z + 2} minecraft:obsidian`);
		await command(`summon minecraft:end_crystal ${x + 0.5} ${y} ${z + 0.5} {ShowBottom:0b,UUID:${uuidInts(id)}}`); await sleep(300);
		await face(x, y, z);
		for (let i = 0; i < 10; i++) { await sleep(300); const o = await observe(); if ((o.entities ?? []).some(x => x.uuid === uuid(id))) break; }
		const r = await act('use_ranged', { targetId: uuid(id), drawDurationMs: 1100, timeoutMs: 6000 });
		const broke = r.state === 'SUCCEEDED' && /broke/.test(r.message) && !/something else/.test(r.message);
		results.hiddenCrystals.push({ at: [x, y, z], state: r.state, reasonCode: r.reasonCode, broke, message: r.message });
		await command('kill @e[type=minecraft:end_crystal]'); await command(`fill ${x - 2} 80 ${z - 2} ${x + 2} ${y + 3} ${z + 2} minecraft:air`); await command('kill @e[type=minecraft:arrow]');
	}

	// 2. The End: the real dragon fight, crystals removed so nothing heals it.
	await end('forceload add -48 -48 48 48');
	await end(`tp ${agent} 0.5 120 0.5`);
	await command(`effect give ${agent} minecraft:slow_falling 30 0 true`);
	let dragonSeen = false;
	for (let i = 0; i < 60 && !dragonSeen; i++) { await sleep(1000); dragonSeen = Number.isFinite(await dragonHealth()); }
	await end('kill @e[type=minecraft:end_crystal]');
	await sleep(8000);
	const surfaceY = number(await end('data get entity @p Pos[1]'));
	await end(`tp ${agent} 9.5 ${Math.floor(surfaceY) + 2} 0.5`); await sleep(1500);
	await command(`effect clear ${agent} minecraft:slow_falling`);
	results.start = { dragonSeen, health: await dragonHealth(), phase: await dragonPhase(), surfaceY };

	// 2a. Default arrows at the flying dragon's body.
	await end('data merge entity @e[type=minecraft:ender_dragon,limit=1] {DragonPhase:0}');
	await command(`item replace entity ${agent} weapon.mainhand with minecraft:bow`);
	for (let shot = 0; shot < 10; shot++) {
		await sleep(1500);
		const rows = await parts();
		const body = rows.body ?? rows.head;
		if (!body) { results.flying.push({ shot, skipped: 'no visible part' }); continue; }
		const before = await dragonHealth();
		const r = await act('use_ranged', { targetId: body.uuid, drawDurationMs: 1100, timeoutMs: 6000 });
		await sleep(400);
		results.flying.push({ shot, part: body.partName, state: r.state, reasonCode: r.reasonCode, hurt: /flashed hurt/.test(r.message ?? ''), healthDrop: before - await dragonHealth(), message: r.message });
		await command('kill @e[type=minecraft:arrow]');
	}

	// 2b. Perch: landing phase brings it onto the fountain.
	await end('data merge entity @e[type=minecraft:ender_dragon,limit=1] {DragonPhase:3}');
	let phase = -1;
	for (let i = 0; i < 40 && ![5, 6, 7].includes(phase); i++) { await sleep(500); phase = await dragonPhase(); }
	results.perchPhase = phase;
	{
		const rows = await parts();
		const body = rows.body ?? rows.head;
		const before = await dragonHealth();
		const r = body ? await act('use_ranged', { targetId: body.uuid, drawDurationMs: 1100, timeoutMs: 6000 }) : null;
		results.perchedArrow = r && { phase: await dragonPhase(), state: r.state, reasonCode: r.reasonCode, bounced: /bounced off/.test(r.message ?? ''), healthDrop: before - await dragonHealth(), message: r.message };
	}
	// 2c. fight_target on the perched head with the sword.
	phase = await dragonPhase();
	for (let i = 0; i < 40 && ![5, 6, 7].includes(phase); i++) { await sleep(500); phase = await dragonPhase(); }
	{
		await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
		// Start beside the fountain, a few blocks out from the head, as a player who ran in at the perch (facing it, as
		// a player looks at what it walks to: rows are what is in view).
		await end(`tp ${agent} 6.5 ${Math.floor(results.start.surfaceY) + 1} 0.5 facing 0.5 68 0.5`); await sleep(500);
		let rows = await parts();
		if (rows.head) {
			const { x, z } = rows.head.position, len = Math.hypot(x, z) || 1;
			await end(`tp ${agent} ${(x + x / len * 4).toFixed(1)} ${Math.floor(results.start.surfaceY) + 1} ${(z + z / len * 4).toFixed(1)}`);
			await sleep(1500); rows = await parts();
		}
		const before = await dragonHealth();
		const r = rows.head ? await act('fight_target', { targetId: rows.head.uuid, timeoutMs: 10000 }) : null;
		results.perchedMelee = r && { startPhase: phase, endPhase: await dragonPhase(), state: r.state, reasonCode: r.reasonCode, healthDrop: before - await dragonHealth(), message: r.message };
	}
	// 2d. A fresh landing: the root row as the model reads it, then a model-armed stance reflex (target_in_reach -> attack).
	await end('data merge entity @e[type=minecraft:ender_dragon,limit=1] {DragonPhase:3}');
	phase = -1;
	for (let i = 0; i < 60 && ![5, 6, 7].includes(phase); i++) { await sleep(500); phase = await dragonPhase(); }
	{
		await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
		await end(`tp ${agent} 6.5 ${Math.floor(results.start.surfaceY) + 1} 0.5 facing 0.5 68 0.5`); await sleep(500);
		let rows = await parts();
		if (rows.head) {
			const { x, y, z } = rows.head.position, len = Math.hypot(x, z) || 1;
			// Standing on the ground 1.5 blocks out from the head, within a sword's 3-block reach of it.
			await end(`tp ${agent} ${(x + x / len * 1.5).toFixed(1)} ${results.start.surfaceY} ${(z + z / len * 1.5).toFixed(1)} facing ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`);
			await sleep(500);
		}
		const seen = await observe();
		const root = (seen.entities ?? []).find(e => e.type === 'minecraft:ender_dragon' && !e.partName);
		rows = Object.fromEntries((seen.entities ?? []).filter(e => e.type === 'minecraft:ender_dragon' && e.partName).map(e => [e.partName, e]));
		results.perchedRows = (seen.entities ?? []).filter(e => e.type === 'minecraft:ender_dragon').map(e => ({ part: e.partName ?? 'root', distance: e.distance, position: e.position, perceivedBy: e.perceivedBy }));
		results.agentAt = seen.position;
		results.perchedRow = { phase: await dragonPhase(), seen: root !== undefined, motion: root?.appearance?.motion ?? null, velocity: root?.velocity ?? null, headDistance: rows.head?.distance ?? null };
		const before = await dragonHealth();
		await bridge.send('reflex_update', record.agentId, { revision: 1, yield: false, rules: normalizeReflexEntries([{ id: 'perch-melee', kind: 'stance', priority: 6,
			when: { type: 'target_in_reach', mobs: ['minecraft:ender_dragon'] }, do: { type: 'attack' }, ttlS: 60, maxS: 10, wake: false }]) });
		await sleep(6000);
		const after = await observe();
		results.reflexMelee = { startPhase: results.perchedRow.phase, endPhase: await dragonPhase(), healthDrop: before - await dragonHealth(),
			fired: (after.reflexes?.rules ?? []).find(r => r.id === 'perch-melee')?.fired ?? null, events: (after.reflexes?.events ?? []).filter(e => e.id === 'perch-melee').slice(-4) };
		await bridge.send('reflex_update', record.agentId, { revision: 2, yield: false, rules: [] });
	}
	results.summary = {
		hiddenCrystalHits: results.hiddenCrystals.filter(x => x.broke).length, hiddenCrystalShots: results.hiddenCrystals.length,
		flyingHurt: results.flying.filter(x => x.hurt).length, flyingShots: results.flying.filter(x => !x.skipped).length,
		flyingHealthDrop: results.flying.reduce((s, x) => s + (Number.isFinite(x.healthDrop) ? x.healthDrop : 0), 0),
		perchedArrowBounced: results.perchedArrow?.bounced ?? null, perchedMeleeHealthDrop: results.perchedMelee?.healthDrop ?? null,
		perchedMotion: results.perchedRow?.motion ?? null, perchedSpeed: results.perchedRow?.velocity ? Math.hypot(results.perchedRow.velocity.x, results.perchedRow.velocity.z) : null,
		reflexMeleeHealthDrop: results.reflexMelee?.healthDrop ?? null, jar: jarPath,
	};
	await writeFile(join(out, 'dragon.json'), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results, null, 2));
} finally {
	await writeFile(join(out, 'dragon.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
