#!/usr/bin/env node
// Provider-free replay of recorded spots where an armed reflex failed when it fired (research page i7r72tvssr4t,
// Oct 22: 236 "no safe heading away", 54 take_cover "no cell out of sight", water clutches that died mid-fall). Each
// spot loads a copy of the saved run world (terrain only; read only), puts a new agent at the recorded position and
// view, arms the rule the game had armed, makes the same threat with vanilla means (a dragon fireball's breath cloud,
// summoned mobs, a fall from the recorded height) and records what the body did. ARENA_JAR selects the jar, so the
// old and new builds replay the same spots. Always launch under slot.sh live; ports come from SLOT_PORT_BASE.
// SPOTS=a,b selects spots. No model calls.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const out = resolve(process.argv[2] ?? 'runtime/reflex-failspots-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port = Number(process.env.SLOT_PORT_BASE);
const runs = '/home/agaminggod/Desktop/Projects';
const run = (build, id, scenario) => join(runs, `aa-run-${build}/runtime/headless-runs/${id}/${scenario}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const END = 'minecraft:the_end', OVERWORLD = 'minecraft:overworld';

// Recorded spots: position, view and threat from the failing observation; rules as the game armed them.
const cloudRule = (within, blocks) => [{ id: 'cloud', kind: 'trigger', priority: 9, when: { type: 'cloud_near', within }, do: { type: 'sprint_away', blocks }, maxS: 3 }];
const fallRule = [{ id: 'fall', kind: 'trigger', priority: 9, when: { type: 'falling', blocks: 4 }, do: { type: 'place', item: 'minecraft:water_bucket', where: 'below' }, maxS: 5 }];
const endKit = { 'hotbar.1': 'minecraft:iron_sword', 'hotbar.2': 'minecraft:end_stone 64', 'hotbar.3': 'minecraft:water_bucket', 'hotbar.5': 'minecraft:cooked_beef 23' };
const SPOTS = [
	{ name: 'breathEdgeA', kind: 'cloud', world: run('617e2d5d', 'run-1792549073765-49c8e2d9', 'q-hhfpa1-2a32-LONG-r1-ae04bd69'), dim: END,
		recorded: 'd12-end-b 617e2d5d t=1792549231889: a fireball burst on the body near the east rim while it looked up at the dragon; endcloud sprint_away failed "no safe heading away" twice; died to breath 9 s later',
		pos: [53.07, 56, 39.46], view: [-176.4, -51.3], health: 20, cloud: [52.63, 56, 39.5], rules: cloudRule(4, 8), kit: endKit },
	{ name: 'breathEdgeB', kind: 'cloud', world: run('62ac775e', 'run-1792507159633-d5044e49', 'q-gshc4c-9ddc-LONG-r1-fe2eb708'), dim: END,
		recorded: '62ac775e t=1792507834465: a fireball burst on the body near the east rim, view up at the dragon; end_cloud sprint_away failed "no safe heading away"',
		pos: [64.33, 57, 7.92], view: [77.9, -32], health: 20, cloud: [64.33, 57, 7.92], rules: cloudRule(4, 8), kit: endKit },
	{ name: 'breathEdgeC', kind: 'cloud', world: run('04c7eb6f', 'run-1792582873400-9aa9bbd3', 'q-i1k580-d749-LONG-r1-6e942af6'), dim: END,
		recorded: '04c7eb6f t=1792582962539: a fireball burst on the body near the east rim, view up at the dragon; cloud sprint_away failed "no safe heading away"',
		pos: [63.88, 57, 10.4], view: [139, -31.4], health: 20, cloud: [63.88, 57, 10.4], rules: cloudRule(4, 8), kit: endKit },
	{ name: 'breathInCloud', kind: 'cloud', world: run('62ac775e', 'run-1792506079963-a2c7baa8', 'q-gru6ii-25f3-LONG-r1-bc645a0a'), dim: END,
		recorded: 'd5-end-a 62ac775e t=1792507151358: dragon-cloud sprint_away failed "no safe heading away" standing in the cloud near the west rim; died 1.5 s later',
		pos: [-52.5, 58, 0.3], view: [96.6, 10], health: 7.5, cloud: [-52.58, 58, 0.49], rules: cloudRule(3, 4), kit: endKit },
	{ name: 'breathOverTunnel', kind: 'cloud', world: run('04c7eb6f', 'run-1792567648303-a893e20b', 'q-hshte8-dde4-LONG-r1-f872b573'), dim: END,
		recorded: 'd13-end-a 04c7eb6f t=1792567953666: in a dug pit 3 below a breath cloud on the surface; end-cloud sprint_away failed "no safe heading away" 7 times and the rule disabled itself',
		pos: [50.61, 54, 30.89], view: [91.7, 10], health: 15.7, cloud: [47.95, 57, 30.7], rules: cloudRule(4, 8), kit: endKit },
	...[
		{ name: 'coverAsRecorded', kit: {}, rules: [{ id: 'shots', kind: 'trigger', priority: 8, when: { type: 'health_below', value: 19 }, do: { type: 'take_cover', within: 5 }, maxS: 4 }] },
		{ name: 'coverWithBlocks', kit: { 'hotbar.0': 'minecraft:dirt 16' }, rules: [{ id: 'shots', kind: 'trigger', priority: 8, when: { type: 'health_below', value: 19 }, do: { type: 'take_cover', within: 5 }, maxS: 4 }] },
		{ name: 'escapeAsRecorded', kit: {}, rules: [{ id: 'escape', kind: 'trigger', priority: 8, when: { type: 'hostile_near', within: 6 }, do: { type: 'sprint_away', blocks: 8 }, maxS: 4 }] },
	].map(variant => ({ ...variant, kind: 'cover', world: run('b897d153', 'run-1792600835076-c2b9f3d5', 'q-ic94fw-d319-LONG-r1-b9895d6e'), dim: OVERWORLD,
		recorded: 'b897d153 t=1792601854318: take_cover "no cell out of sight of 2 mobs within 5 steps" and sprint_away "no safe heading away" after a respawn at night, empty inventory',
		pos: [17.5, 72, 81.5], view: [0, 0], health: 20, mobs: [['skeleton', 18.27, 71, 86.8], ['zombie', 25.8, 71, 87.87], ['zombie', 32.6, 70, 105.0]] })),
	// d19: a tunnel that bends behind the body. Every straight heading away from the zombie is a wall one or two cells
	// out; the way the body walked in (west one cell, then north) is the escape a player takes.
	{ name: 'tunnelBend', kind: 'tunnel', world: run('b897d153', 'run-1792600835076-c2b9f3d5', 'q-ic94fw-d319-LONG-r1-b9895d6e'), dim: OVERWORLD,
		recorded: 'd18 live runs: sprint_away "no safe heading away: wall NE, N, E, NW..." in tunnels; built here as a bent glass tunnel in the air',
		pos: [1.5, 150, 0.5], view: [-90, 10], health: 20, origin: [17, 150, 81], kit: {},
		rules: [{ id: 'escape', kind: 'trigger', priority: 8, when: { type: 'hostile_near', within: 8 }, do: { type: 'sprint_away', blocks: 8 }, maxS: 5 }] },
	{ name: 'clutchThrowA', kind: 'clutch', world: run('a2985f4a', 'run-1792562432092-33d32965', 'q-hpe0li-2874-LONG-r1-a68748bc'), dim: END,
		recorded: 'd12p-end-a a2985f4a: thrown off a pillar top at y124; fallwater fired "falling; ground not in reach yet" until the body hit the ground (63-block fall)',
		pos: [-17.64, 123.53, -42.16], view: [-88, 30], health: 14.8, kit: { 'hotbar.3': 'minecraft:water_bucket', 'hotbar.7': 'minecraft:bow' }, rules: fallRule },
	{ name: 'clutchThrowB', kind: 'clutch', world: run('617e2d5d', 'run-1792550360234-1ba78c6e', 'q-hi79vm-8312-LONG-r1-292afbbe'), dim: END,
		recorded: 'd12-end-d 617e2d5d: thrown to y96; fall fired, then "could not aim at the below face" as the ground came in reach',
		pos: [-22.0, 94.71, -13.16], view: [0, 30], health: 20, kit: { 'hotbar.3': 'minecraft:water_bucket', 'hotbar.7': 'minecraft:shield' }, rules: fallRule },
	{ name: 'clutchThrowC', kind: 'clutchRun', world: run('617e2d5d', 'run-1792555104723-806f05a3', 'q-hl0ypx-49ea-LONG-r1-e307354d'), dim: END,
		recorded: 'd12-end-i 617e2d5d: thrown off the y81 pillar with ~0.3 b/t of sideways speed; end_fall fired and the body died on landing. Replayed as a sprint jump off the same pillar toward the recorded landing',
		pos: [-17.36, 81, -36.64], view: [147, 20], health: 20, kit: { 'hotbar.3': 'minecraft:water_bucket' }, rules: fallRule },
];
const only = (process.env.SPOTS ?? '').split(',').filter(Boolean);
const results = { jar: jarPath, spots: {} };
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jarSha256: createHash('sha256').update(await readFile(jarPath)).digest('hex'), node: process.version }, null, 2));

// A stopped run must not leave its server holding the slot's ports.
let liveServer = null;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (liveServer?.exitCode === null) liveServer.kill('SIGKILL'); process.exit(1); });

class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', e => this.accept(e)); bridge.on('ready', e => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex(w => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex(e => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: e => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}

/** One server on a copy of {@code world}; returns the helpers a spot needs. */
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
	await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=false\ndifficulty=normal\n`);
	const log = await open(join(dir, 'server.log'), 'a');
	const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Darenaagents.bridgePort=${port}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${join(dir, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
	const s = { child, log, secret, record: null, observation: null, ordinal: 0, revision: 0 };
	liveServer = child;
	for (let i = 0; i < 150; i++) { try { s.rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 30000 }); await s.rcon.connect(); break; } catch (e) { await s.rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	s.command = async (text) => { if (s.rcon.state === 'closed') { s.rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 30000 }); await s.rcon.connect(); } return (await s.rcon.command(text)).text; };
	s.bridge = new MultiplexedServerBridge({ port, secret }, {}); s.inbox = new Inbox(s.bridge);
	s.bridge.on('observation', e => { if (e.agentId === s.record?.agentId && e.payload.ready) s.observation = e.payload; });
	s.bridge.on('goal_spec_request', e => { s.bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = s.inbox.wait('ready'); s.bridge.start(); await ready;
	await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free failspot fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await s.command('gamerule minecraft:send_command_feedback false');
	await s.command('scoreboard objectives add deaths deathCount');
	s.observeOrNull = async () => { try { return await s.observe(); } catch { return null; } };
	s.observe = async () => { const seq = s.observation?.eventSequence ?? 0; const next = s.inbox.wait('observation', e => e.agentId === s.record.agentId && e.payload.ready && e.payload.eventSequence > seq); await s.bridge.send('request_observation', s.record.agentId, { goalRevision: s.record.goalRevision }); return (await next).payload; };
	s.act = async (type, args) => {
		const id = `spot-${++s.ordinal}`;
		const payload = { actionId: id, traceId: id, goalRevision: s.record.goalRevision, actionType: type, arguments: args,
			provenance: { provider: s.record.provider, model: s.record.model, reasoningEffort: s.record.reasoningEffort, serviceTier: s.record.serviceTier, traceId: id, programId: 'failspot-fixture', programVersion: 1, sourceStepId: id, eventSequence: s.observation?.eventSequence ?? 0 } };
		const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000);
		await s.bridge.send('action_command', s.record.agentId, payload);
		const r = (await next).payload;
		await s.bridge.send('action_result_ack', s.record.agentId, { actionId: id, goalRevision: s.record.goalRevision });
		return r;
	};
	s.setReflexes = async (rules) => {
		s.revision += 1;
		await s.bridge.send('reflex_update', s.record.agentId, { revision: s.revision, rules: normalizeReflexEntries(rules), yield: false });
		for (let i = 0; i < 40; i++) { const o = await s.observe(); if (o.reflexes?.revision === s.revision) return o; await sleep(100); }
		throw new Error(`reflex revision ${s.revision} never echoed`);
	};
	s.stop = async () => {
		await s.command('stop').catch(() => {});
		s.bridge?.stop(); await s.rcon?.close();
		await Promise.race([new Promise(r => child.once('exit', r)), sleep(15000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
	};
	return s;
}

const agent = 'Probe';
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const round = v => Math.round(v * 100) / 100;

/** Summons the agent at the spot (a new body knows no terrain yet), in the spot's dimension, with the recorded view. */
async function place(s, spot, kit) {
	const at = `execute in ${spot.dim} run`;
	await s.command(`execute in ${spot.dim} run forceload add ${Math.floor(spot.pos[0]) - 24} ${Math.floor(spot.pos[2]) - 24} ${Math.floor(spot.pos[0]) + 24} ${Math.floor(spot.pos[2]) + 24}`);
	if (!s.record) {
		const registered = s.inbox.wait('agent_registered');
		console.log(await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${agent}`));
		const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		const started = s.inbox.wait('goal_control', e => e.payload.operation === 'start'); await s.command(`codex start ${agent} Survive for 1200 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
		await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
		await s.command(`gamemode survival ${agent}`);
	}
	await s.setReflexes([]);
	// Through another dimension, so the body arrives with no terrain memory: what it knows is what the recorded view shows.
	await s.command(`execute in ${spot.dim === END ? OVERWORLD : END} run tp ${agent} 0.5 200 0.5`); await sleep(500);
	await s.command(`clear ${agent}`);
	for (const [slot, item] of Object.entries(kit ?? {})) await s.command(`item replace entity ${agent} ${slot} with ${item}`);
	await s.command(`effect clear ${agent}`);
	await s.command(`effect give ${agent} minecraft:saturation 2 10 true`);
	await s.command(`${at} tp ${agent} ${spot.pos.join(' ')} ${spot.view.join(' ')}`);
	await s.command(`${at} kill @e[type=minecraft:ender_dragon]`); await s.command(`${at} kill @e[type=minecraft:enderman]`);
	await s.command(`${at} kill @e[type=minecraft:area_effect_cloud]`); await s.command(`${at} kill @e[type=minecraft:skeleton]`); await s.command(`${at} kill @e[type=minecraft:zombie]`);
	// A dimension change leaves the body invulnerable for 60 ticks (vanilla): wait it out before damage counts.
	await sleep(3500);
	await s.command(`effect give ${agent} minecraft:instant_health 1 5 true`); await sleep(700);
	if (spot.health < 20) await s.command(`damage ${agent} ${round(20 - spot.health)} minecraft:generic`);
	await sleep(1000);
	// Air or not around the feet, recorded so a reader can see the footing (#: not air).
	if (!spot.terrain || process.env.DUMP_AT) {
		const [fx, fy, fz] = spot.pos.map(Math.floor);
		spot.terrain = {};
		for (let dy = 2; dy >= -2; dy--) {
			const rows = [];
			for (let dz = -3; dz <= 3; dz++) {
				let row = '';
				for (let dx = -3; dx <= 3; dx++) row += dx === 0 && dz === 0 && (dy === 0 || dy === 1) ? '@' : (await s.command(`execute in ${spot.dim} if block ${fx + dx} ${fy + dy} ${fz + dz} minecraft:air`)).includes('passed') ? '.' : '#';
				rows.push(row);
			}
			spot.terrain[`y${fy + dy}`] = rows;
		}
	}
}

const eventsOf = (o, ids, since) => (o.reflexes?.events ?? []).filter(e => ids.includes(e.id) && (e.seq ?? 0) > since).map(e => ({ outcome: e.outcome, detail: e.detail, ms: e.ms }));
const deaths = async (s) => number(await s.command(`scoreboard players get ${agent} deaths`)) || 0;
const health = async (s) => { const text = await s.command(`data get entity ${agent} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };

async function cloudSpot(s, spot) {
	await place(s, spot, spot.kit);
	const ids = spot.rules.map(r => r.id);
	let o = await s.setReflexes(spot.rules);
	const since = Math.max(0, ...(o.reflexes?.events ?? []).map(e => e.seq ?? 0));
	const before = await health(s);
	const deathsBefore = await deaths(s);
	// The breath cloud a dragon fireball leaves where it lands, at the recorded cloud's column.
	const [cx, cy, cz] = spot.cloud;
	await s.command(`execute in ${spot.dim} run summon minecraft:dragon_fireball ${cx} ${cy + 1.5} ${cz} {Motion:[0d,-0.6d,0d],acceleration_power:0.1d}`);
	const track = [];
	let died = false;
	const start = Date.now();
	while (Date.now() - start < 7000) {
		const next = await s.observeOrNull();
		if (!next) { died = true; break; }
		o = next;
		track.push({ t: Date.now() - start, x: round(o.position?.x ?? 0), y: round(o.position?.y ?? 0), z: round(o.position?.z ?? 0), hp: round(o.player?.health ?? 0), firing: o.reflexes?.firing?.detail ?? null });
		if ((o.player?.health ?? 1) <= 0) break;
		await sleep(250);
	}
	o = (await s.observeOrNull()) ?? o;
	const events = eventsOf(o, ids, since);
	const after = await health(s);
	died = died || (await deaths(s)) > deathsBefore;
	const final = track.at(-1);
	const fromCloud = Math.hypot(final.x - cx, final.z - cz);
	return { recorded: spot.recorded, terrainRowsNorthToSouthColsWestToEast: spot.terrain, events, healthBefore: before, healthAfter: after, lost: round(before - after), died,
		finalDistanceFromCloud: round(fromCloud), track,
		escapeFailed: events.some(e => e.outcome === 'failed'), moved: round(Math.hypot(final.x - spot.pos[0], final.z - spot.pos[2])) };
}

async function coverSpot(s, spot, variant) {
	await s.command('time set 18000');
	await place(s, spot, variant.kit);
	const ids = variant.rules.map(r => r.id);
	let o = await s.setReflexes(variant.rules);
	const since = Math.max(0, ...(o.reflexes?.events ?? []).map(e => e.seq ?? 0));
	const before = await health(s);
	const deathsBefore = await deaths(s);
	for (const [type, x, y, z] of spot.mobs) await s.command(`execute in ${spot.dim} run summon minecraft:${type} ${x} ${y} ${z} {PersistenceRequired:1b}`);
	const track = [];
	let died = false;
	const start = Date.now();
	let ended = null;
	while (Date.now() - start < 12000) {
		const next = await s.observeOrNull();
		if (!next) { died = true; break; }
		o = next;
		const events = eventsOf(o, ids, since);
		track.push({ t: Date.now() - start, x: round(o.position?.x ?? 0), z: round(o.position?.z ?? 0), hp: round(o.player?.health ?? 0), firing: o.reflexes?.firing?.detail ?? null });
		if (events.length && !o.reflexes?.firing && ended === null) ended = Date.now();
		if (ended !== null && Date.now() - ended > 2500) break;
		if ((o.player?.health ?? 1) <= 0) break;
		await sleep(250);
	}
	o = (await s.observeOrNull()) ?? o;
	const events = eventsOf(o, ids, since);
	const after = await health(s);
	died = died || (await deaths(s)) > deathsBefore;
	const final = track.at(-1);
	await s.command(`execute in ${spot.dim} run kill @e[type=minecraft:skeleton]`); await s.command(`execute in ${spot.dim} run kill @e[type=minecraft:zombie]`);
	await s.command(`execute in ${spot.dim} run fill ${Math.floor(spot.pos[0]) - 3} ${spot.pos[1]} ${Math.floor(spot.pos[2]) - 3} ${Math.floor(spot.pos[0]) + 3} ${spot.pos[1] + 1} ${Math.floor(spot.pos[2]) + 3} minecraft:air replace minecraft:dirt`);
	return { recorded: spot.recorded, terrainRowsNorthToSouthColsWestToEast: spot.terrain, kit: variant.kit, events, healthBefore: before, healthAfter: after, lost: round(before - after), died,
		moved: round(Math.hypot(final.x - spot.pos[0], final.z - spot.pos[2])), failed: events.some(e => e.outcome === 'failed'), track: track.filter((_, i) => i % 2 === 0) };
}

async function tunnelSpot(s, spot) {
	const [ox, oy, oz] = spot.origin;
	const at = (dx, dy, dz) => `${ox + dx} ${oy + dy} ${oz + dz}`;
	await s.command(`execute in ${spot.dim} run forceload add ${ox - 24} ${oz - 24} ${ox + 24} ${oz + 24}`); await sleep(1500);
	await s.command('time set 6000');
	// Glass shell, then the two legs: east (x 0..8, z 0) and north (x 0, z -8..0), two blocks high.
	await s.command(`execute in ${spot.dim} run fill ${at(-2, -1, -10)} ${at(10, 2, 2)} minecraft:glass`);
	await s.command(`execute in ${spot.dim} run fill ${at(0, 0, 0)} ${at(8, 1, 0)} minecraft:air`);
	await s.command(`execute in ${spot.dim} run fill ${at(0, 0, -8)} ${at(0, 1, 0)} minecraft:air`);
	const world = (dx, dz) => [ox + dx + 0.5, oy, oz + dz + 0.5];
	await place(s, { ...spot, pos: world(0, -7), view: [0, 10] }, spot.kit);
	// Walk in along the tunnel, so its cells are ground the body has walked (as the way it came is in a cave).
	const walked = [];
	for (const [dx, dz] of [[0, -4], [0, 0], [1, 0]]) {
		const [x, y, z] = world(dx, dz);
		walked.push((await s.act('move_to', { x, y, z, tolerance: 0.4 })).state);
	}
	await s.act('control', { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: -90, pitch: 10, selectedSlot: 0, hand: 'main', ticks: 10 });
	const ids = spot.rules.map(r => r.id);
	let o = await s.setReflexes(spot.rules);
	const since = Math.max(0, ...(o.reflexes?.events ?? []).map(e => e.seq ?? 0));
	const start0 = [o.position.x, o.position.z];
	// A zombie that stands where it is summoned: the threat stays in the east leg.
	await s.command(`execute in ${spot.dim} run summon minecraft:zombie ${world(6, 0).join(' ')} {NoAI:1b,PersistenceRequired:1b}`);
	const track = [];
	const start = Date.now();
	while (Date.now() - start < 7000) {
		o = (await s.observeOrNull()) ?? o;
		track.push({ t: Date.now() - start, x: round(o.position?.x ?? 0), z: round(o.position?.z ?? 0), firing: o.reflexes?.firing?.detail ?? null });
		await sleep(250);
	}
	const events = eventsOf(o, ids, since);
	const final = track.at(-1);
	await s.command(`execute in ${spot.dim} run kill @e[type=minecraft:zombie]`);
	return { recorded: spot.recorded, walkedIn: walked, events, startedAt: start0.map(round), final: [final.x, final.z],
		fromZombie: round(Math.hypot(final.x - world(6, 0)[0], final.z - world(6, 0)[2])), escaped: !events.some(e => e.outcome === 'failed') && final.z < oz - 1, track: track.filter((_, i) => i % 2 === 0) };
}

async function clutchSpot(s, spot) {
	// Arm while standing on a barrier at the recorded point: the rule must be live before the fall begins.
	const floor = [Math.floor(spot.pos[0]), Math.floor(spot.pos[1]) - 1, Math.floor(spot.pos[2])].join(' ');
	await s.command(`execute in ${spot.dim} run forceload add ${Math.floor(spot.pos[0]) - 24} ${Math.floor(spot.pos[2]) - 24} ${Math.floor(spot.pos[0]) + 24} ${Math.floor(spot.pos[2]) + 24}`); await sleep(1500);
	if (spot.kind !== 'clutchRun') console.log(await s.command(`execute in ${spot.dim} run setblock ${floor} minecraft:barrier`));
	await place(s, { ...spot, pos: spot.kind === 'clutchRun' ? spot.pos : [spot.pos[0], Math.floor(spot.pos[1]), spot.pos[2]] }, spot.kit);
	let o = await s.setReflexes(spot.rules);
	const since = Math.max(0, ...(o.reflexes?.events ?? []).map(e => e.seq ?? 0));
	if (spot.kind === 'clutchRun') {
		// A sprint jump off the pillar toward the recorded landing (about 0.3 blocks a tick sideways, as the throw).
		await s.command(`effect give ${agent} minecraft:instant_health 1 5 true`); await sleep(500);
		s.pending = s.act('control', { forward: 1, strafe: 0, jump: true, sneak: false, sprint: true, attack: false, use: false, yaw: spot.view[0], pitch: spot.view[1], selectedSlot: 0, hand: 'main', ticks: 30 });
	} else {
		await s.command(`execute in ${spot.dim} run setblock ${floor} minecraft:air`);
	}
	const before = spot.health;
	const deathsBefore = await deaths(s);
	const track = [];
	let maxFall = 0, landed = false, died = false;
	const start = Date.now();
	while (Date.now() - start < 9000) {
		const next = await s.observeOrNull();
		if (!next) { died = true; break; }
		o = next;
		maxFall = Math.max(maxFall, o.player?.fallDistance ?? 0);
		track.push({ t: Date.now() - start, y: round(o.position?.y ?? 0), fall: round(o.player?.fallDistance ?? 0), hp: round(o.player?.health ?? 0), firing: o.reflexes?.firing?.detail ?? null });
		if ((o.player?.health ?? 1) <= 0) break;
		if ((o.player?.onGround || o.player?.inWater) && maxFall > 4) { landed = true; break; }
		await sleep(100);
	}
	await sleep(2500);
	await s.pending?.catch(() => {});
	o = (await s.observeOrNull()) ?? o;
	const after = await health(s);
	died = died || (await deaths(s)) > deathsBefore;
	const events = eventsOf(o, spot.rules.map(r => r.id), since);
	const lost = round(before - after);
	return { recorded: spot.recorded, terrainRowsNorthToSouthColsWestToEast: spot.terrain, events, healthBefore: before, healthAfter: after, lost, died, landed, maxFall: round(maxFall),
		waterPlaced: events.some(e => /placed/.test(e.detail ?? '')), track: track.filter((_, i) => i % 3 === 0) };
}

for (const spot of SPOTS) {
	if (only.length && !only.includes(spot.name)) continue;
	const dir = join(out, spot.name);
	await mkdir(dir, { recursive: true });
	let s;
	try {
		s = await boot(dir, spot.world);
		// DUMP_AT=x,y,z: only record the terrain around that point of the spot's world.
		if (process.env.DUMP_AT) { const at = process.env.DUMP_AT.split(',').map(Number); const probe = { ...spot, pos: at, health: 20, terrain: null }; await place(s, probe, {}); results.spots[spot.name] = { at, terrain: probe.terrain }; continue; }
		if (spot.kind === 'cloud') results.spots[spot.name] = await cloudSpot(s, spot);
		else if (spot.kind === 'cover') results.spots[spot.name] = await coverSpot(s, spot, spot);
		else if (spot.kind === 'tunnel') results.spots[spot.name] = await tunnelSpot(s, spot);
		else results.spots[spot.name] = await clutchSpot(s, spot);
	} catch (error) {
		results.spots[spot.name] = { ...(results.spots[spot.name] ?? {}), error: String(error?.stack ?? error).slice(0, 600) };
	} finally {
		await s?.stop().catch(() => {});
		await rm(join(dir, 'server'), { recursive: true, force: true }).catch(() => {});
		await writeFile(join(out, 'failspots.json'), JSON.stringify(results, null, 2));
	}
	console.log(`[spot] ${spot.name}: ${JSON.stringify(Object.fromEntries(Object.entries(results.spots).filter(([k]) => k.startsWith(spot.name.replace(/[A-Z].*$/, ''))).map(([k, v]) => [k, { events: v.events, lost: v.lost, died: v.died, error: v.error }])))}`);
}
await writeFile(join(out, 'failspots.json'), JSON.stringify(results, null, 2));
process.exit(0);
