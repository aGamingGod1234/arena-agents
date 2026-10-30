#!/usr/bin/env node
// Provider-free check of the fight footwork (FightMotion) against the 2026-10-23 combat deaths: the same fight_target
// calls a model makes, on fixtures built with operator commands, base jar vs new jar (ARENA_JAR). Each scenario runs
// REPEATS times with a fresh full-health body in iron armour with an iron sword (and a shield where the call asks for one):
//   zombies   three zombies, fight_target continueWithAttackers (night-surface melee deaths)
//   ledge     a wither skeleton on a 7-wide bridge deck 16 blocks up, the body 1.5 from the east edge (fortress knock-offs)
//   skeletons two skeletons 10 blocks out (overworld arrow deaths)
//   blazes    two blazes hovering 6 blocks out over a brick floor (fortress blaze deaths)
//   enderman  an angry enderman, fight_target shield:true (End enderman deaths); enderman_bare without a shield
//   edge_escape away_from_edge {blocks:8} armed on edge_near as the model would, the body 1.5 from the edge of a 25x25
//             deck 17 blocks up: how far inland it gets, how fast; edge_dragon the same on dragon_charging, a dragon
//             hovering 10 blocks off and 6 up (a summoned dragon hovers where it spawns)
// Reports per scenario: survived, fell off, health lost, kills, time, and the footwork counts the result names.
//   node scripts/quality/test-footwork-live.mjs OUT_DIR [scenario,...]   (launch under slot.sh live; ARENA_JAR selects the jar)
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
const out = resolve(process.argv[2] ?? 'runtime/footwork-live');
const only = process.argv[3] ? process.argv[3].split(',') : null;
const REPEATS = Number(process.env.REPEATS ?? 3);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const jarSha = createHash('sha256').update(await readFile(jarPath)).digest('hex');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true, jarSha256: jarSha, node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
await cp(jarPath, join(server, 'mods/arena-agents-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261024\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=normal\n`);
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
const agent = 'Footwork';
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
async function observe() { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }); return (await next).payload; }
function command_(type, args) {
	const id = `fw-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'fw-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const done = inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000)
		.then(async e => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return e.payload; });
	return { id, sent: bridge.send('action_command', record.agentId, payload), done };
}
async function act(type, args) { const c = command_(type, args); await c.sent; return c.done; }
const number = text => Number(/(-?[\d.]+)[a-z]?$/i.exec(String(text).trim())?.[1]);
// Health plus absorption: the body carries 20 absorption so a bad run costs health, not the fixture.
const agentHealth = async () => number(await command(`data get entity ${agent} Health`)) + number(await command(`data get entity ${agent} AbsorptionAmount`));
const agentY = async () => number(await command(`data get entity ${agent} Pos[1]`));
async function entityIds(type, count) {
	for (let i = 0; i < 12; i++) {
		const o = await observe();
		const rows = (o.entities ?? []).filter(e => e.type === type && e.alive !== false).map(e => e.uuid);
		if (rows.length >= count) return rows;
		await sleep(300);
	}
	throw new Error(`fewer than ${count} ${type} observed`);
}
async function freshBody(x, y, z, yaw, shield, armour) {
	await command(`effect clear ${agent}`);
	await command(`tp ${agent} ${x} ${y} ${z} ${yaw} 0`);
	await command(`effect give ${agent} minecraft:instant_health 1 10 true`);
	await command(`effect give ${agent} minecraft:saturation 2 10 true`);
	await command(`effect give ${agent} minecraft:absorption 120 4 true`);
	await command(`extinguish ${agent}`).catch(() => {});
	await command(`data merge entity ${agent} {Fire:0s}`).catch(() => {});
	await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`);
	await command(`item replace entity ${agent} weapon.offhand with ${shield ? 'minecraft:shield' : 'minecraft:air'}`);
	for (const [slot, item] of [['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']]) await command(`item replace entity ${agent} ${slot} with ${armour ? `minecraft:${item}` : 'minecraft:air'}`);
	await sleep(1200);
}
const clearMobs = () => command('kill @e[type=!minecraft:player,type=!minecraft:item]').then(() => command('kill @e[type=minecraft:item]'));

const SCENARIOS = {
	zombies: { at: [0.5, 64, 0.5, -90], shield: false, armour: false, health: 40, mobs: [['zombie', 5.5, 64, 0.5], ['zombie', 5.5, 64, 2.5], ['zombie', 5.5, 64, -1.5]],
		args: ids => ({ targetId: ids[0], continueWithAttackers: true, timeoutMs: 30000 }), type: 'minecraft:zombie' },
	ledge: { at: [103.5, 81, 0.5, 90], shield: false, health: 80, mobs: [['wither_skeleton', 100.5, 81, 0.5]], fallBelow: 78,
		args: ids => ({ targetId: ids[0], timeoutMs: 25000 }), type: 'minecraft:wither_skeleton' },
	skeletons: { at: [0.5, 64, 0.5, -90], shield: false, armour: false, health: 30, mobs: [['skeleton', 10.5, 64, 0.5], ['skeleton', 10.5, 64, 4.5]],
		args: ids => ({ targetId: ids[0], continueWithAttackers: true, timeoutMs: 30000 }), type: 'minecraft:skeleton' },
	blazes: { at: [-39.5, 64, 0.5, -90], shield: false, health: 40, mobs: [['blaze', -34.5, 66, 0.5], ['blaze', -34.5, 66, 3.5]],
		args: ids => ({ targetId: ids[0], continueWithAttackers: true, timeoutMs: 30000 }), type: 'minecraft:blaze' },
	enderman: { at: [0.5, 64, 0.5, -90], shield: true, health: 60, mobs: [['enderman', 4.5, 64, 0.5]], anger: 'enderman',
		args: ids => ({ targetId: ids[0], shield: true, timeoutMs: 30000 }), type: 'minecraft:enderman' },
	// away_from_edge moved by a deterministic trigger (the body 1.5 from a 17-block drop), and by a hovering dragon.
	edge_escape: { at: [63.5, 81, 0.5, -90], shield: false, edge: true, when: { type: 'edge_near', within: 2, direction: 'any', drop: 5 } },
	edge_dragon: { at: [63.5, 81, 0.5, -90], shield: false, edge: true, dragon: true, when: { type: 'dragon_charging', within: 48 } },
	enderman_bare: { at: [0.5, 64, 0.5, -90], shield: false, health: 60, mobs: [['enderman', 4.5, 64, 0.5]], anger: 'enderman',
		args: ids => ({ targetId: ids[0], timeoutMs: 30000 }), type: 'minecraft:enderman' },
};

const results = { jar: jarPath, jarSha256: jarSha, scenarios: {} };
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) observation = e.payload; });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free footwork fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('gamerule minecraft:spawn_mobs false').catch(() => command('gamerule doMobSpawning false'));
	console.log('regen off:', await command('gamerule minecraft:natural_health_regeneration false'));
	await command('gamerule minecraft:advance_time false').catch(() => command('gamerule doDaylightCycle false'));
	await command('forceload add -64 -32 112 32'); await sleep(2000);
	// Open arena: stone floor (top y 63) x -24..24; a blaze yard x -48..-28 of nether bricks.
	await command('fill -24 63 -24 24 63 24 minecraft:stone'); await command('fill -24 64 -24 24 90 24 minecraft:air');
	await command('fill -48 63 -12 -28 63 12 minecraft:nether_bricks'); await command('fill -48 64 -12 -28 90 12 minecraft:air');
	// A fortress-bridge deck at y 80 (feet 81), x 80..104, z -3..3, 17 blocks over the floor; open air round it.
	await command('fill 74 64 -10 112 100 10 minecraft:air'); await command('fill 74 63 -10 112 63 10 minecraft:stone');
	await command('fill 80 80 -3 104 80 3 minecraft:nether_bricks');
	// An island deck at y 80 (feet 81), x 40..64, z -12..12; its east edge is the lip at x 65.
	await command('fill 36 64 -16 70 100 16 minecraft:air'); await command('fill 36 63 -16 70 63 16 minecraft:stone');
	await command('fill 40 80 -12 64 80 12 minecraft:end_stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 64 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); console.log(await command(`codex start ${agent} Survive for 1200 seconds.`)); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	for (const [name, scenario] of Object.entries(SCENARIOS)) {
		if (only && !only.includes(name)) continue;
		const runs = [];
		for (let repeat = 0; repeat < REPEATS; repeat++) {
			await clearMobs();
			const [x, y, z, yaw] = scenario.at;
			await freshBody(x, y, z, yaw, scenario.shield, scenario.armour !== false);
			if (scenario.edge) {
				let revision = (results.reflexRevision ?? 0) + 1; results.reflexRevision = revision;
				const rules = normalizeReflexEntries([{ id: 'throw', kind: 'trigger', priority: 8, when: scenario.when, do: { type: 'away_from_edge', blocks: 8 }, maxS: 10 }]);
				await bridge.send('reflex_update', record.agentId, { revision, rules, yield: false }).catch(error => console.log('reflex_update', String(error)));
				await sleep(800);
				const armed = (await observe()).reflexes;
				const sinceSeq = Math.max(0, ...(armed?.events ?? []).map(ev => ev.seq ?? 0));
				const startedAt = Date.now();
				if (scenario.dragon) await command(`summon minecraft:ender_dragon ${x - 10} ${y + 6} ${z} {PersistenceRequired:1b,DragonPhase:10}`);
				let reachedAt = null, lowestY = y, finalX = x;
				while (Date.now() - startedAt < 15000) {
					const pos = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(await command(`data get entity ${agent} Pos`).catch(() => '')) ?? [];
					finalX = Number(pos[1]); lowestY = Math.min(lowestY, Number(pos[2]));
					// Clearance 8 from the lip at x 65 means x <= 57.
					if (reachedAt === null && finalX <= 57.0) reachedAt = Date.now() - startedAt;
					await sleep(250);
				}
				const events = ((await observe()).reflexes?.events ?? []).filter(ev => ev.id === 'throw' && (ev.seq ?? 0) > sinceSeq).map(ev => `${ev.outcome}: ${String(ev.detail ?? '').slice(0, 120)}`);
				const run = { armed: armed?.rules?.map(r => `${r.id}:${r.state}`) ?? null, error: armed?.error ?? null, fromLip: Math.round((65 - finalX) * 100) / 100,
					reachedClearanceMs: reachedAt, fell: lowestY < 78, survived: lowestY >= 78, events };
				runs.push(run); console.log(name, repeat, JSON.stringify(run));
				await command('kill @e[type=minecraft:ender_dragon]');
				await bridge.send('reflex_update', record.agentId, { revision: ++results.reflexRevision, rules: [], yield: false }).catch(() => {});
				continue;
			}
			const before = await agentHealth();
			for (const [type, mx, my, mz] of scenario.mobs) await command(`summon minecraft:${type} ${mx} ${my} ${mz} {PersistenceRequired:1b,attributes:[{id:"minecraft:max_health",base:${scenario.health}}],Health:${scenario.health}f}`);
			await sleep(600);
			if (scenario.anger) await command(`damage @e[type=minecraft:${scenario.anger},limit=1,sort=nearest] 1 minecraft:player_attack by ${agent}`);
			let ids;
			try { ids = await entityIds(scenario.type, 1); } catch (error) { runs.push({ error: String(error) }); continue; }
			const startedAt = Date.now();
			let lowestY = y, alive = true;
			const track = [];
			const fight = command_('fight_target', scenario.args(ids));
			await fight.sent;
			const watch = (async () => { while (!fight.settled) { const yy = await agentY().catch(() => NaN); if (Number.isFinite(yy)) lowestY = Math.min(lowestY, yy); if (process.env.TRACK) { const near = await command(`execute at ${agent} as @e[type=${scenario.type},sort=nearest,limit=1] run data get entity @s Pos`).catch(() => ''); const me = await command(`data get entity ${agent} Pos`).catch(() => ''); const a = (/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(me) ?? []).slice(1).map(Number), b = (/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(near) ?? []).slice(1).map(Number); track.push({ t: Date.now() - startedAt, x: a[0], y: a[1], z: a[2], hp: await agentHealth().catch(() => NaN), d: a.length && b.length ? Math.round(Math.hypot(a[0] - b[0], a[2] - b[2]) * 100) / 100 : null }); } await sleep(250); } })();
			const result = await fight.done.catch(err => ({ state: 'ERROR', reasonCode: String(err), message: '' }));
			fight.settled = true; await watch;
			const seconds = (Date.now() - startedAt) / 1000;
			const after = await agentHealth().catch(() => NaN);
			if (result.reasonCode === 'AGENT_DEAD' || !(after > 0)) alive = false;
			const message = String(result.message ?? '');
			const kills = [.../kills: ([^;(]*)/.exec(message)?.[1]?.matchAll(/(\d+)x minecraft:/g) ?? []].reduce((sum, m) => sum + Number(m[1]), 0);
			const run = { state: result.state, reasonCode: result.reasonCode, survived: alive, fell: scenario.fallBelow ? lowestY < scenario.fallBelow : false,
				healthLost: Math.round((before - (alive ? after : 0)) * 10) / 10, kills, seconds: Math.round(seconds * 10) / 10,
				footwork: /footwork: ([^;]*)/.exec(message)?.[1] ?? null, message: message.slice(0, 600), ...(process.env.TRACK ? { track } : {}) };
			runs.push(run);
			console.log(name, repeat, JSON.stringify(run));
			if (!alive) {
				// Respawn the fixture body for the next run.
				await act('respawn', {}).catch(() => {});
				await sleep(2000);
				await command(`gamemode survival ${agent}`);
			}
		}
		if (scenario.edge) { results.scenarios[name] = { runs, survived: `${runs.filter(r => r.survived).length}/${runs.length}`, meanFromLip: Math.round(runs.reduce((a, r) => a + r.fromLip, 0) / runs.length * 100) / 100, reached: `${runs.filter(r => r.reachedClearanceMs !== null).length}/${runs.length}` }; console.log(name, JSON.stringify(results.scenarios[name])); continue; }
		const ok = runs.filter(r => !r.error);
		results.scenarios[name] = { runs, survived: `${ok.filter(r => r.survived && !r.fell).length}/${ok.length}`,
			meanHealthLost: ok.length ? Math.round(ok.reduce((s, r) => s + r.healthLost, 0) / ok.length * 10) / 10 : null,
			kills: ok.reduce((s, r) => s + r.kills, 0), meanSeconds: ok.length ? Math.round(ok.reduce((s, r) => s + r.seconds, 0) / ok.length * 10) / 10 : null };
		console.log(name, JSON.stringify(results.scenarios[name]));
	}
	console.log(JSON.stringify(Object.fromEntries(Object.entries(results.scenarios).map(([k, v]) => [k, { survived: v.survived, meanHealthLost: v.meanHealthLost, kills: v.kills, meanSeconds: v.meanSeconds }])), null, 2));
} finally {
	await writeFile(join(out, 'footwork.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
