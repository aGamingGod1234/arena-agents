#!/usr/bin/env node
// d37 provider-free probe: can the body kill real blazes at a real fortress spawner and keep the rods? Seed 20261009
// (the 3-fortress save point world), its kit plus a bow, 64 arrows and one legal 16-snowball stack, full
// health and no absorption. A fixed script stands in for the model and makes only calls a model makes: fight_target on
// the nearest seen blaze (pursue, shield, continueWithAttackers), pick_up_item on a seen blaze rod, eat below 10 health,
// otherwise wait 1 s. GAP_MS adds idle time before every call (Sol's measured turn time is about 5 s).
//   node scripts/quality/test-blaze-spawner-live.mjs OUT_DIR   (under slot.sh live; ARENA_JAR, ARENA_HEADLESS_SERVER_TEMPLATE,
//   JAVA_HOME; VARIANTS=gap0,gap5,cover REPEATS=3 RUN_S=240 SPAWNER=84,73,92 PURSUE=1 START_MODE=deck|rim)
//   SHELTER=1 calls build_shelter first, then holds ground; OPENING=east by default.
//   RANGED=bow|snowball equips that arm, shoots observed blazes outside melee reach, and explicitly opens the sill
//   for witnessed rods before returning and rebuilding. ROOF=0 omits the optional roof.
//   When only hunting sounds remain, the stand-in peeks through a known wall in that coarse cardinal direction.
//   Sounds guide looking/mining only; shots still require a visually acquired target.
//   This policy is a fixture stand-in, never product automation.
//   Desktop: run-blaze-spawner-desktop.ps1 uses the runner JDK/template and enforces the RAM/CPU guard.
import { writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { DEFAULT_REFLEXES } from '../../coordinator/src/reflexes.mjs';
import { planCountDefault } from '../../coordinator/src/plan-count.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const out = resolve(process.argv[2] ?? 'runtime/blaze-spawner-live');
const REPEATS = Number(process.env.REPEATS ?? 3), RUN_S = Number(process.env.RUN_S ?? 240);
const VARIANTS = (process.env.VARIANTS ?? 'gap0,gap5,cover').split(',');
const SPAWNER = (process.env.SPAWNER ?? '84,73,92').split(',').map(Number);
const START_MODE = process.env.START_MODE ?? 'deck';
if (!['deck','rim','platform','floor'].includes(START_MODE)) throw new Error('START_MODE must be deck, rim, platform or floor');
// d41 platform: the two micro save points' starts (evals/d41-micro/checkpoints fortress-platform.json, fortress-floor.json).
const FIXED_STARTS = { platform: [81.5, 73, 92.5], floor: [75.5, 70, 92.5] };
// Each save point's own setup: the platform's 4x3 brick deck beside the spawner and its tagged blazes (offsets from the start).
const SAVE_POINT = {
	platform: { fills: ['fill 80 72 91 83 72 93 minecraft:nether_bricks'], blazes: [[4, 1, 0]] },
	floor: { fills: [], blazes: [[6, 3, 0], [9, 3, 1]] },
}[START_MODE];
const FOOD = SAVE_POINT ? 'minecraft:bread' : 'minecraft:cooked_beef';
// OPENER=ranged (d41 platform): the first call of a trial is the live model's opening on these save points
// (batch 4, 6/6 runs): use_ranged untilDead on the nearest seen blaze, 1 s draw, 20 s timeout, fleeAtHealth 10.
const OPENER = process.env.OPENER ?? 'none';
const SHIELD_STANCE = process.env.SHIELD_STANCE !== '0';
const TRACE = process.env.TRACE !== '0';
let callGap = 0;
let lastSampleAt = 0;
let reflexRevision = 0, runDeadline = Infinity, armedRules = [], windowRods = 0, goalOrdinal = 0, survivalTicks = 24000;
const PURSUE = process.env.PURSUE !== '0';
const SHELTER = process.env.SHELTER === '1';
const ROOF = process.env.ROOF !== '0';
const OPENING = process.env.OPENING ?? 'east';
const RANGED = process.env.RANGED ?? 'none';
// STANDIN=until (d41 fight-until): the stand-in makes one fight_until call (blaze -> UNTIL rods, WEAPON) and repeats it
// only after the skill hands back, eating below 10 health; LOW_HP=1 sets fleeAtHealth 14 to exercise the health stop.
const STANDIN = process.env.STANDIN ?? 'script', UNTIL = Number(process.env.UNTIL ?? 3), WEAPON = process.env.WEAPON ?? 'auto';
const LOW_HP = process.env.LOW_HP === '1';
// STANDIN=count (d41 fight-count): the same loop, but the call is fight_target on the nearest seen blaze with
// untilItem blaze_rod + untilCount UNTIL (count mode); no blaze in view -> fight_until. DEFAULTS=1 also arms the default
// survival reflexes (coordinator DEFAULT_REFLEXES) beside the shield rules, as the combined build does.
const DEFAULTS = process.env.DEFAULTS === '1';
// STANDIN=plan (d41 blaze-survive): the stand-in makes a plain fight_target on the nearest seen blaze (no untilItem) while
// a plan step 'blaze_rod PLAN_NEED' with has:minecraft:blaze_rod*PLAN_NEED is open; the coordinator's own plan-count
// default (plan-count.mjs) turns it into count mode. No blaze in view: look toward a heard one, else wait 1 s.
const PLAN_NEED = Number(process.env.PLAN_NEED ?? 6);
if (!['none', 'bow', 'snowball'].includes(RANGED)) throw new Error('RANGED must be none, bow or snowball');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
async function sha256(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
const jarSha = await sha256(jarPath);
const harnessSha = await sha256(fileURLToPath(import.meta.url));
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true, jarSha256: jarSha, harnessSha256: harnessSha, shelter: SHELTER, roof: ROOF, ranged: RANGED, kitExtra: { bow: 1, arrows: 64, snowballs: 16 }, primaryScore: 'rods held in last observation inside window; zero on death', opening: OPENING, shieldStance: SHIELD_STANCE, incomingProjectileGuard: SHIELD_STANCE, terrainReset: 'original 3x3 shell and spawner restored by clone before each trial', freshBodyPerTrial: true, previousProjectilesCleared: true, gapBeforeEveryBodyCall: true, startMode: START_MODE, naturalMobSpawning: false, seed: '20261009', spawner: SPAWNER, variants: VARIANTS, repeats: REPEATS, runS: RUN_S, pursue: PURSUE }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
await cp(jarPath, join(server, 'mods/arena-agents-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261009\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=normal\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), [`-Darenaagents.bridgePort=${port}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${join(out, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
await writeFile(join(out, 'server.pid'), String(child.pid));
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', e => this.accept(e)); bridge.on('ready', e => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex(w => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex(e => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: e => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}
let rcon, bridge, record, observation, inbox, ordinal = 0;
let lastWindowObservation = null, lastWindowObservationAt = 0;
let agent = 'Blazer', trialOrdinal = 0;
const kills = [], goalEvents = [];
const trace = await open(join(out, 'trace.jsonl'), 'a');
const traceRow = row => TRACE ? trace.write(JSON.stringify(row) + '\n') : Promise.resolve();
// d41 rods: ground truth for where rods lie (operator query, not the body's perception), every 3 s inside a window.
let rodProbeBusy = false;
setInterval(async () => {
	if (!TRACE || rodProbeBusy || !Number.isFinite(runDeadline) || Date.now() > runDeadline) return;
	rodProbeBusy = true;
	try {
		const reply = await nether(`execute positioned ${SPAWNER.join(' ')} as @e[type=minecraft:item,distance=..32] run data get entity @s Pos`);
		const rods = [...String(reply).matchAll(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/g)].map(m => [1,2,3].map(i => Math.round(Number(m[i])*10)/10));
		await traceRow({ items: true, at: Date.now(), s: Math.round((Date.now() - (runDeadline - RUN_S*1000))/100)/10, rods });
	} catch {}
	rodProbeBusy = false;
}, 3000).unref?.();
async function armShield() {
	armedRules = (DEFAULTS ? DEFAULT_REFLEXES.map(rule => ({ ...rule })) : []).concat(SHIELD_STANCE ? [{id:'guard',kind:'stance',priority:6,when:{type:'hostile_near',within:24,mobs:['minecraft:blaze']},do:{type:'shield'},ttlMs:600000},{id:'shot',kind:'trigger',priority:9,when:{type:'incoming_projectile',withinS:1},do:{type:'shield'},ttlMs:600000}] : []);
	await bridge.send('reflex_update', record.agentId, {revision: ++reflexRevision, rules: armedRules,yield:false});
}
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 30000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
const nether = s => command(`execute in minecraft:the_nether run ${s}`);
async function serverTick() {
	const reply = await command('time query gametime');
	const match = /time is\s+(\d+)/i.exec(reply) ?? /(\d+)\s*$/.exec(reply);
	if (!match) throw new Error('Unknown gametime reply: '+reply);
	return Number(match[1]);
}
async function observe(ms = 30000) { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq, ms); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }).catch(() => {}); return (await next).payload; }
// Health from the server; a dead player reads 0 (or the query fails while it is respawning).
const serverHealth = async () => { const t = await command(`data get entity ${agent} Health`).catch(() => ''); const m = /(-?[\d.]+)f?\s*$/.exec(t.trim()); return m ? Number(m[1]) : 0; };
async function act(type, args, ms = 65000, retried = false) {
	if (!retried && callGap) await sleep(Math.min(callGap, Math.max(0, runDeadline - Date.now())));
	if (Date.now() >= runDeadline) return {state:"CANCELLED",reasonCode:"FIXTURE_RUN_DEADLINE",message:"Four-minute measurement window ended"};
	ms = Math.min(ms, Math.max(1,runDeadline-Date.now()));
	const id = `bz-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'bz-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const done = inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), ms)
		.then(async e => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return e.payload; });
	try {
		// Match NativeToolRuntime: model body commands yield a held stance before publication (movement/fights compose).
		await bridge.send('reflex_update',record.agentId,{revision:reflexRevision,rules:armedRules,yield:true});
		await bridge.send('action_command', record.agentId, payload);
	}
	catch (error) {
		if (error?.code !== 'STALE_GOAL_REVISION' || retried) throw error;
		const m = /current revision (\d+)/.exec(String(error.message)); if (m) record.goalRevision = Number(m[1]);
		await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
		return act(type, args, ms, true);
	}
	return done.catch(async err => {
		const cancelled = inbox.wait('action_result', e=>e.payload.actionId===id && ['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(e.payload.state),10000).catch(()=>null);
		await bridge.send('action_cancel',record.agentId,{actionId:id,goalRevision:record.goalRevision}).catch(()=>{});
		await cancelled;
		return {state:'ERROR',reasonCode:'FIXTURE_ACTION_DEADLINE',message:String(err)};
	}).then(async res=>{ await traceRow({at:Date.now(),command:type,args,result:res});return res; });
}
const passed = text => /Test passed/i.test(text);
// The acceptance start is on the broad deck; START_MODE=rim preserves the old outside-rim hard case.
// A standing cell near the spawner: air at feet and head, solid non-lava floor, at the spawner's level or one below.
async function standCell() {
	const [sx, sy, sz] = SPAWNER, cells = [];
	if (FIXED_STARTS[START_MODE]) {
		const [x,y,z] = FIXED_STARTS[START_MODE].map(Math.floor);
		for (const fill of SAVE_POINT.fills) await nether(fill);
		if (!passed(await nether(`execute if block ${x} ${y} ${z} minecraft:air if block ${x} ${y+1} ${z} minecraft:air unless block ${x} ${y-1} ${z} minecraft:air`))) throw new Error(START_MODE+' start is not standable');
		return FIXED_STARTS[START_MODE];
	}
	if (START_MODE === 'deck') {
		const [x,y,z] = [sx-1,sy,sz-1];
		if (!passed(await nether(`execute if block ${x} ${y} ${z} minecraft:air if block ${x} ${y+1} ${z} minecraft:air unless block ${x} ${y-1} ${z} minecraft:air unless block ${x} ${y-1} ${z} minecraft:lava unless block ${x} ${y-1} ${z} #minecraft:fences`))) throw new Error('Broad-deck start is not standable');
		return [x+0.5,y,z+0.5];
	}

	for (let dy = -1; dy <= 0; dy++) for (let dx = -7; dx <= 7; dx++) for (let dz = -7; dz <= 7; dz++) {
		const d = Math.hypot(dx, dz); if (d < 3 || d > 7) continue; cells.push([sx + dx, sy + dy, sz + dz, d]);
	}
	cells.sort((a, b) => Math.abs(a[3] - 4.5) - Math.abs(b[3] - 4.5));
	for (const [x, y, z] of cells) {
		const t = await nether(`execute if block ${x} ${y} ${z} minecraft:air if block ${x} ${y + 1} ${z} minecraft:air unless block ${x} ${y - 1} ${z} minecraft:air unless block ${x} ${y - 1} ${z} minecraft:lava unless block ${x} ${y - 1} ${z} #minecraft:fences`);
		if (passed(t)) return [x + 0.5, y, z + 0.5];
	}
	throw new Error('no standing cell near the spawner');
}
async function kit() {
	await command(`clear ${agent}`);
	if (SAVE_POINT) {
		// The micro save points' kit (checkpoint setup.inventory/armour), shield already in the offhand.
		await command(`effect clear ${agent}`);
		await command(`effect give ${agent} minecraft:instant_health 1 10 true`);
		await command(`effect give ${agent} minecraft:saturation 1 10 true`);
		await command(`extinguish ${agent}`).catch(() => {});
		await command(`item replace entity ${agent} hotbar.0 with minecraft:bow`);
		await command(`item replace entity ${agent} hotbar.1 with minecraft:arrow 64`);
		await command(`item replace entity ${agent} hotbar.2 with minecraft:iron_sword`);
		await command(`item replace entity ${agent} hotbar.4 with minecraft:cobblestone 32`);
		await command(`item replace entity ${agent} hotbar.5 with minecraft:bread 16`);
		await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
		for (const [slot, item] of [['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']]) await command(`item replace entity ${agent} ${slot} with minecraft:${item}`);
		return;
	}
	await command(`effect clear ${agent}`);
	await command(`effect give ${agent} minecraft:instant_health 1 10 true`);
	await command(`effect give ${agent} minecraft:saturation 1 10 true`);
	await command(`extinguish ${agent}`).catch(() => {});
	await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`);
	await command(`item replace entity ${agent} hotbar.1 with minecraft:iron_pickaxe`);
	await command(`item replace entity ${agent} hotbar.2 with minecraft:cooked_beef 24`);
	await command(`item replace entity ${agent} hotbar.3 with minecraft:cobblestone 47`);
	await command(`item replace entity ${agent} hotbar.4 with minecraft:nether_bricks 20`);
	await command(`item replace entity ${agent} hotbar.5 with minecraft:water_bucket`);
	await command(`item replace entity ${agent} hotbar.6 with minecraft:bow`);
	await command(`item replace entity ${agent} inventory.0 with minecraft:arrow 64`);
	await command(`item replace entity ${agent} hotbar.7 with minecraft:snowball 16`);
	await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
	for (const [slot, item] of [['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']]) await command(`item replace entity ${agent} ${slot} with minecraft:${item}`);
}
// After a death: respawn as a player does, then wait until the body is alive and observed again.
async function recover() {
	for (let i = 0; i < 20; i++) {
		await bridge.send('catalog_snapshot', 'server', catalog()).catch(() => {});
		await act('respawn', {}, 10000).catch(() => {});
		await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
		await sleep(2000);
		if ((await serverHealth()) > 0) { try { await observe(5000); return true; } catch {} }
	}
	return false;
}
const catalog = () => ({ refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free blaze fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] });
const rodsHeld = o => (o.inventory?.items ?? []).filter(i => i.itemId === 'minecraft:blaze_rod').reduce((s, i) => s + (i.count ?? 0), 0);

const results = { jar: jarPath, jarSha256: jarSha, variants: {} };
try {
	for (let i = 0; i < 240; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 30000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 239) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) { observation = e.payload; if (Number.isFinite(runDeadline) && Date.now() <= runDeadline) { windowRods = Math.max(windowRods,rodsHeld(e.payload)); lastWindowObservation = e.payload; lastWindowObservationAt = Date.now();
		// 1 Hz body samples (position, health, fire, blazes) for reading deaths; fixture evidence only.
		if (Date.now() - lastSampleAt >= 1000) { lastSampleAt = Date.now(); const p = e.payload; traceRow({ sample: true, at: lastSampleAt, s: Math.round((lastSampleAt - (runDeadline - RUN_S*1000))/100)/10, position: p.position, health: p.player?.health, onFire: p.player?.onFire, fireTicks: p.player?.fireTicks, onGround: p.player?.onGround, action: p.currentAction?.actionType ?? p.action?.actionType, blazes: (p.entities ?? []).filter(x => x.type === 'minecraft:blaze' || x.type === 'minecraft:small_fireball').map(x => [x.type.slice(10,15), Math.round(x.position.x*10)/10, Math.round(x.position.y*10)/10, Math.round(x.position.z*10)/10]) }).catch(() => {}); } } } });
	bridge.on('message', e => {
		if (e.type === 'entity_killed') kills.push({ at: Date.now(), type: e.payload?.entityType });
		if (e.type === 'goal_control' && record && e.agentId === record.agentId && Number.isFinite(e.payload?.goalRevision)) record.goalRevision = e.payload.goalRevision;
		if (e.type === 'goal_control') { goalEvents.push({ at: Date.now(), operation: e.payload?.operation, revision: e.payload?.goalRevision }); traceRow({at:Date.now(),event:'goal_control',payload:e.payload}).catch(()=>{}); }
	});
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: survivalTicks } }).catch(() => {}); });
	const ready = inbox.wait('ready', () => true, 240000); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', catalog());
	await command('gamerule minecraft:send_command_feedback false');
	// Passive evaluator counter: vanilla increments bow-use stats when an arrow is actually released.
	await command('scoreboard objectives add d39_bow minecraft.used:minecraft.bow');
	const spawnRule = await command('gamerule minecraft:spawn_mobs false');
	if (!/false/i.test(spawnRule)) throw new Error('Could not isolate natural mob spawning: '+spawnRule);
	console.log('Natural mob spawning disabled; block spawner remains vanilla.');
	const [sx, sy, sz] = SPAWNER;
	await nether(`forceload add ${sx - 48} ${sz - 48} ${sx + 48} ${sz + 48}`); await sleep(8000);
	const spawnerOk = passed(await nether(`execute if block ${sx} ${sy} ${sz} minecraft:spawner`));
	results.spawnerPresent = spawnerOk; console.log('spawner present:', spawnerOk);
	if (process.env.SURVEY) {
		// d41 rods: operator block map round the spawner (y 69..76), one row per y: '#' solid, '.' air, 'S' spawner.
		const [sx,,sz] = SPAWNER, map = [];
		for (let y = 69; y <= 76; y++) for (let z = sz-10; z <= sz+10; z++) {
			let row = '';
			for (let x = sx-14; x <= sx+8; x++) row += passed(await nether(`execute if block ${x} ${y} ${z} minecraft:air`)) ? '.' : passed(await nether(`execute if block ${x} ${y} ${z} minecraft:spawner`)) ? 'S' : '#';
			map.push(`y${y} z${z} x${sx-14}: ${row}`);
		}
		await writeFile(join(out, 'survey.txt'), map.join('\n') + '\n');
	}
	if (!spawnerOk) throw new Error('Required vanilla fortress spawner is absent');
	const cell = await standCell(); results.cell = cell; console.log('standing cell', cell);
	// The goal may mine a fence. Every repeat starts from the same original blocks and spawner timer.
	// This fixture-only backup is outside player perception and is never sent to the stand-in or body.
	await nether('forceload add 10000 10000'); await sleep(1000);
	const snapshot = await nether(`clone ${sx-2} ${sy} ${sz-2} ${sx} ${sy+2} ${sz} 10000 180 10000 replace normal`);
	if (!/cloned\s+\d+\s+block/i.test(snapshot)) throw new Error('Could not snapshot original trial terrain: '+snapshot);
	results.terrainSnapshot = snapshot;
	for (const variant of VARIANTS) {
		const gap = variant === 'cover' ? 5000 : Number(/gap(\d+)/.exec(variant)?.[1] ?? 0) * 1000;
		callGap = gap;
		const runs = [];
		for (let repeat = 0; repeat < REPEATS; repeat++) {
			runDeadline = Infinity; armedRules = [];
			if (record) {
				// A surviving stance still owns input: end it while its registered body exists.
				await bridge.send('reflex_update',record.agentId,{revision:++reflexRevision,rules:[],yield:true});
				let cleared = (await serverHealth()) <= 0;
				for (let i=0;i<20 && !cleared;i++) {
					const ended = await observe();
					if (ended.reflexes?.revision === reflexRevision && !ended.reflexes.rules?.length) { cleared = true; break; }
				}
				await sleep(100);
				if (!cleared) throw new Error('Old body reflexes did not clear before removal');
				await command(`codex remove ${agent}`);
			}
			record = null; observation = null; agent = `Blazer${trialOrdinal++}`;
			const registered = inbox.wait('agent_registered');
			await command(`codex summon gpt-6.1-sol low ${agent}`);
			const fresh = await registered; record = { ...(fresh.payload.record ?? fresh.payload), agentId: fresh.agentId };
			await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
			await command(`gamemode survival ${agent}`);
			await bridge.send('reflex_update',record.agentId,{revision:++reflexRevision,rules:[],yield:false});
			for (const mob of ['blaze','wither_skeleton','skeleton','magma_cube','zombified_piglin','piglin','hoglin','ghast']) await nether(`kill @e[type=minecraft:${mob},distance=..40,x=${sx},y=${sy},z=${sz}]`);
			for (const projectile of ['small_fireball','arrow','snowball']) await nether(`kill @e[type=minecraft:${projectile}]`);
			await nether('kill @e[type=minecraft:item]');
			await nether(`fill ${sx-12} ${sy-1} ${sz-12} ${sx+12} ${sy+8} ${sz+12} minecraft:air replace minecraft:fire`);
			// d41 rods: blocks a body placed (pillars, shelters) do not carry into the next trial (fortresses hold no cobblestone).
			await nether(`fill ${sx-16} ${sy-4} ${sz-12} ${sx+12} ${sy+6} ${sz+12} minecraft:air replace minecraft:cobblestone`);
			const restored = await nether(`clone 10000 180 10000 10002 182 10002 ${sx-2} ${sy} ${sz-2} replace normal`);
			if (!/cloned\s+\d+\s+block/i.test(restored)) throw new Error('Could not restore trial terrain: '+restored);
			await nether(`random reset minecraft:entities/blaze ${2026100900 + repeat}`);
			if (SAVE_POINT) for (const fill of SAVE_POINT.fills) await nether(fill);
			await command(`execute in minecraft:the_nether run tp ${agent} ${cell[0]} ${cell[1]} ${cell[2]} 0 0`);
			await kit();
			const survivalSeconds = 1200 + goalOrdinal++; survivalTicks = survivalSeconds * 20;
			const restart = inbox.wait('goal_control', e=>e.agentId===record.agentId && e.payload.operation==='start');
			const taskStart = await command(`codex start ${agent} Survive for ${survivalSeconds} seconds.`);
			console.log("trial task", variant, repeat, taskStart);
			record.goalRevision = (await restart).payload.goalRevision;
			await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
			await armShield(); await sleep(1500);
			// Priming a shield stance can walk; the measured trial starts at the authored deck cell.
			await nether(`tp ${agent} ${cell[0]} ${cell[1]} ${cell[2]} 0 0`);
			if (SAVE_POINT) for (const [dx, dy, dz] of SAVE_POINT.blazes) await nether(`summon minecraft:blaze ${cell[0]+dx} ${cell[1]+dy} ${cell[2]+dz} {PersistenceRequired:1b}`);
			const startServerTick = await serverTick();
			const run = { startServerTick, variant, gap, deaths: 0, kills: 0, rodItemsSeen: 0, rodsPicked: 0, rodsAtEnd: 0, minHealth: 20, calls: {}, fightResults: {}, firstBlazeS: null, firstKillS: null, damageWhileIdleS: 0 };
			const rodIds = new Set(), startedAt = Date.now(), killMark = kills.length;
			runDeadline = startedAt + RUN_S*1000; windowRods = 0; lastWindowObservation = null; lastWindowObservationAt = 0;
			const knownRods = new Map();
			const shelterArgs = { x: Math.floor(cell[0]), y: cell[1], z: Math.floor(cell[2]), opening: OPENING, itemId: 'minecraft:cobblestone', roof: ROOF, timeoutMs: 120000 };
			const [openX, openZ] = { east: [1,0], west: [-1,0], north: [0,-1], south: [0,1] }[OPENING];
			const openingHead = [shelterArgs.x+openX,shelterArgs.y+1,shelterArgs.z+openZ].join(',');
			const peekedHeads = new Set([openingHead]);
			let maxRods = 0, blockedWindow = null;
			let o = await observe().catch(async () => { await recover(); return observe(); }), dead = false;
			// A spawner blaze can land a fireball during setup; heal and re-place up to three times before judging the start.
			for (let i = 0; i < 3 && (o.player?.health !== 20 || Math.hypot(o.position.x-cell[0],o.position.y-cell[1],o.position.z-cell[2])>0.4); i++) {
				for (const mob of ['blaze', 'small_fireball']) await nether(`kill @e[type=minecraft:${mob},distance=..40,x=${sx},y=${sy},z=${sz}]`);
				await command(`extinguish ${agent}`).catch(() => {}); await command(`effect give ${agent} minecraft:instant_health 1 10 true`);
				await nether(`tp ${agent} ${cell[0]} ${cell[1]} ${cell[2]} 0 0`); await sleep(1000); o = await observe();
			}
			run.initialPosition = o.position; run.initialHealth = o.player?.health;
			if (run.initialHealth !== 20 || Math.hypot(o.position.x-cell[0],o.position.y-cell[1],o.position.z-cell[2])>0.4)
				throw new Error('Invalid initial trial state: '+JSON.stringify({position:o.position,health:run.initialHealth}));
			if (SHELTER) {
				const args = shelterArgs;
				run.shelterResult = await act('build_shelter', args, 125000);
				run.shelterCells = [];
				for (let y=0;y<2;y++) for(let x=-1;x<=1;x++) for(let z=-1;z<=1;z++) if(x||z) run.shelterCells.push([args.x+x,args.y+y,args.z+z]);
				const back = {east:[-1,0],west:[1,0],north:[0,1],south:[0,-1]}[OPENING];
				run.shelterCells.push([args.x+back[0],args.y+2,args.z+back[1]],[args.x,args.y+2,args.z]);
			}
			if (variant === 'cover') {
				const dx = Math.sign(sx + 0.5 - cell[0]), dz = Math.sign(sz + 0.5 - cell[2]);
				const x = Math.floor(cell[0]) + (Math.abs(sx + 0.5 - cell[0]) >= Math.abs(sz + 0.5 - cell[2]) ? dx : 0);
				const z = Math.floor(cell[2]) + (x === Math.floor(cell[0]) ? dz : 0);
				run.coverCells = [0,1].map(dy => [x,cell[1]+dy,z]);
				run.coverResults = [];
				for (const [x,y,z] of run.coverCells) { await act('look_at',{x:x+0.5,y:y-0.5,z:z+0.5}); const r=await act('place_block',{x,y,z,face:'up',itemId:'minecraft:cobblestone'}); run.coverResults.push({state:r.state,reason:r.reasonCode,message:r.message}); }
			}
			while (Date.now() - startedAt < RUN_S * 1000) {
				if (Date.now() >= runDeadline) break;
				try { o = await observe(8000); } catch { if ((await serverHealth()) <= 0) { run.deaths++; dead = true; break; } continue; }
				if (Date.now() >= runDeadline) break;
				maxRods = Math.max(maxRods, rodsHeld(o));
				await traceRow({variant,repeat,s:Math.round((Date.now()-startedAt)/100)/10,position:o.position,inventoryRods:rodsHeld(o),player:o.player,reflexes:o.reflexes,entities:o.entities});
				const hp = o.player?.health ?? 20; run.minHealth = Math.min(run.minHealth, hp);
				if (hp <= 0 || o.status === 'DEAD' || o.player?.dead) { run.deaths++; dead = true; break; }
				const ents = (o.entities ?? []).filter(x => x.alive !== false);
				for (const r of ents.filter(x => x.type === 'minecraft:item' && x.itemId === 'minecraft:blaze_rod')) {
					rodIds.add(r.uuid);
					if (RANGED !== 'none') knownRods.set(r.uuid, { uuid:r.uuid, at:Date.now(), x:Math.floor(r.position.x), y:Math.floor(r.position.y), z:Math.floor(r.position.z) });
				}
				const rod = ents.filter(x => x.type === 'minecraft:item' && x.itemId === 'minecraft:blaze_rod' && x.distance < 10 && (!SHELTER || RANGED !== 'none' && x.position.y >= cell[1]-0.5 || Math.hypot(x.position.x-cell[0],x.position.z-cell[2]) <= 1.8)).sort((a, b) => a.distance - b.distance)[0] ?? [...knownRods.values()].find(r=>Date.now()-r.at<60000 && (!SHELTER || RANGED !== 'none' && r.y >= cell[1]-0.5 || Math.hypot(r.x+0.5-cell[0],r.z+0.5-cell[2]) <= 1.8));
				const blaze = ents.filter(x => x.type === 'minecraft:blaze' && (!SHELTER || x.perceivedBy !== 'sound')).sort((a, b) => a.distance - b.distance)[0];
				const heard = ents.find(x => x.type === 'minecraft:blaze' && x.perceivedBy === 'sound');
				if (blaze && run.firstBlazeS === null) run.firstBlazeS = Math.round((Date.now() - startedAt) / 1000);
				let type, args;
				if (STANDIN === 'until' || STANDIN === 'count' || STANDIN === 'plan') {
					if (rodsHeld(o) >= (STANDIN === 'plan' ? PLAN_NEED : UNTIL)) { run.reachedS ??= Math.round((Date.now() - startedAt) / 1000); break; }
					if (hp < 10 && !LOW_HP) { await act('select_item', { itemId: FOOD }); type = 'use_item'; args = { durationMs: 1700, expectedItemId: FOOD }; }
					else if (STANDIN === 'plan') {
						if (OPENER === 'ranged' && !run.opened && blaze && blaze.perceivedBy !== 'sound') {
							run.opened = true;
							if ((o.inventory?.selectedItemId ?? o.inventory?.selectedItem) !== 'minecraft:bow') await act('select_item', { itemId: 'minecraft:bow' });
							type = 'use_ranged'; args = { targetId: blaze.uuid, drawDurationMs: 1000, untilDead: true, timeoutMs: 20000, fleeAtHealth: 10 };
						} else if (blaze && blaze.perceivedBy !== 'sound' && blaze.distance <= 24) {
							const plain = { kind: 'action', actionType: 'fight_target', arguments: { targetId: blaze.uuid, timeoutMs: 15000 } };
							const counted = planCountDefault(plain, { needs: [{ id: 'minecraft:blaze_rod', have: rodsHeld(o), need: PLAN_NEED, step: 'rods', label: `blaze_rod ${PLAN_NEED}` }], entities: ents });
							if (!counted.note) throw new Error('plan count default did not apply');
							type = 'fight_target'; args = counted.tool.arguments; (run.planNotes ??= []).push(counted.note.slice(0, 200));
						} else if (heard) { type = 'look_at'; args = { x: heard.position.x, y: heard.position.y + 1, z: heard.position.z }; }
						else { type = 'wait'; args = { durationMs: 1000 }; }
					}
					else if (STANDIN === 'count' && blaze && blaze.perceivedBy !== 'sound' && blaze.distance <= 24) { type = 'fight_target'; args = { targetId: blaze.uuid, untilItem: 'minecraft:blaze_rod', untilCount: UNTIL, fleeAtHealth: LOW_HP ? 14 : 6, timeoutMs: Math.max(1000, Math.min(600000, runDeadline - Date.now())) }; }
					else { type = 'fight_until'; args = { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: UNTIL, weapon: WEAPON, fleeAtHealth: LOW_HP ? 14 : 6, timeoutMs: Math.max(1000, Math.min(600000, runDeadline - Date.now())) }; }
					const res = await act(type, args, Math.max(1000, runDeadline - Date.now(), type === 'fight_target' ? 180000 : 0) + 20000);
					run.calls[type] = (run.calls[type] ?? 0) + 1;
					if (type === 'use_ranged') (run.openerResults ??= []).push(`${Math.round((Date.now() - startedAt) / 1000)}s ${res.reasonCode}: ${String(res.message ?? '').slice(0, 900)}`);
					if (type === 'fight_until' || type === 'fight_target') {
						const m = String(res.message ?? '');
						const fire = m.match(/fire: ([0-9.]+) s burning, (\d+) steps? off fire; shield: raised (\d+) times? at shots, (\d+) blocked; cover: (\d+) moves?/);
						if (fire) { run.fireS = (run.fireS ?? 0) + Number(fire[1]); run.fireSteps = (run.fireSteps ?? 0) + Number(fire[2]); run.shieldRaised = (run.shieldRaised ?? 0) + Number(fire[3]); run.shieldBlocks = (run.shieldBlocks ?? 0) + Number(fire[4]); run.coverMoves = (run.coverMoves ?? 0) + Number(fire[5]); }
						run.fightResults[res.reasonCode] = (run.fightResults[res.reasonCode] ?? 0) + 1;
						(run.untilMessages ??= []).push(`${Math.round((Date.now() - startedAt) / 1000)}s ${res.reasonCode}: ${String(res.message ?? '').slice(0, 1200)}`);
						if (res.reasonCode === 'UNTIL_COUNT_REACHED') run.reachedS ??= Math.round((Date.now() - startedAt) / 1000);
						if (LOW_HP && res.reasonCode === 'LOW_HEALTH_BAILOUT') { run.lowHealthStop = { hp: (await observe(5000).catch(() => o)).player?.health }; break; }
					}
					if (res.reasonCode === 'AGENT_DEAD') { run.deaths++; dead = true; break; }
					continue;
				}
				if (hp < 10) { await act('select_item', { itemId: FOOD }); type = 'use_item'; args = { durationMs: 1700, expectedItemId: FOOD }; }
				else if (blockedWindow) {
					await act('select_item', { itemId: 'minecraft:iron_pickaxe' });
					type = 'break_block'; args = { ...blockedWindow, expectedBlockId:'minecraft:cobblestone', timeoutMs:15000 }; blockedWindow = null;
				}
				else if (rod && (RANGED === 'none' || !blaze)) {
					if (SHELTER && RANGED !== 'none') {
						await act('select_item', { itemId: 'minecraft:iron_pickaxe' });
						await act('break_block', { x: shelterArgs.x+openX, y: shelterArgs.y, z: shelterArgs.z+openZ, expectedBlockId: 'minecraft:cobblestone', timeoutMs: 15000 });
					}
					type = 'pick_up_item'; args = { targetSelector: rod.uuid };
				}
				else if (blaze && RANGED !== 'none' && (blaze.distance > 2.8 || Math.abs(blaze.position.y-o.position.y)>1.5)) {
					const itemId = RANGED === 'bow' ? 'minecraft:bow' : 'minecraft:snowball';
					if ((o.inventory?.items ?? []).some(i=>i.itemId === (RANGED === 'bow' ? 'minecraft:arrow' : itemId) && i.count>0)) {
						if ((o.inventory?.selectedItemId ?? o.inventory?.selectedItem) !== itemId) await act('select_item', { itemId });
						if (RANGED === 'bow') { type = 'use_ranged'; args = { targetId: blaze.uuid, drawDurationMs: 1000, trackTarget: true, timeoutMs: 10000 }; }
						else { type = 'use_item'; args = { durationMs: 50, mode: 'once', expectedItemId: itemId, aimX: blaze.position.x, aimY: blaze.position.y+0.9, aimZ: blaze.position.z }; }
					} else { type = 'wait'; args = { durationMs: 1000 }; }
				}
				else if (blaze) { await act('select_item', { itemId: 'minecraft:iron_sword' }); type = 'fight_target'; args = { targetId: blaze.uuid, pursue: SHELTER ? false : PURSUE, shield: true, continueWithAttackers: !SHELTER, fleeAtHealth: 6, timeoutMs: RANGED === 'none' ? 15000 : 2500 }; }
				else if (SHELTER && RANGED !== 'none' && heard) {
					// Use only a cardinal bearing from hearing, never its hidden UUID or exact position for a shot.
					const dx=heard.position.x-o.position.x, dz=heard.position.z-o.position.z;
					const hx=Math.abs(dx)>=Math.abs(dz)?Math.sign(dx):0, hz=hx?0:Math.sign(dz);
					const head={x:shelterArgs.x+hx,y:shelterArgs.y+1,z:shelterArgs.z+hz}, key=[head.x,head.y,head.z].join(',');
					if ((hx||hz) && !peekedHeads.has(key)) {
						peekedHeads.add(key);
						await act('select_item',{itemId:'minecraft:iron_pickaxe'});
						type='break_block'; args={...head,expectedBlockId:'minecraft:cobblestone',timeoutMs:15000};
						run.heardPeeks=(run.heardPeeks??0)+1;
					} else {
						type='look_at'; args={x:o.position.x+hx*8,y:o.position.y+(hx||hz?1.6:heard.position.y<o.position.y?-4:6),z:o.position.z+hz*8};
						run.heardLooks=(run.heardLooks??0)+1;
					}
				}
				else { type = 'wait'; args = { durationMs: 1000 }; }
				const res = await act(type, args);
				await traceRow({variant,repeat,s:Math.round((Date.now()-startedAt)/100)/10,type,args,result:res});
				for (const m of String(res.message ?? '').matchAll(/minecraft:blaze_rod at (-?\d+),(-?\d+),(-?\d+) uuid=([a-f0-9-]{36})/g)) { knownRods.set(m[4],{uuid:m[4],at:Date.now(),x:Number(m[1]),y:Number(m[2]),z:Number(m[3])}); rodIds.add(m[4]); }
				if (type === 'pick_up_item') knownRods.delete(args.targetSelector);
				run.calls[type] = (run.calls[type] ?? 0) + 1;
				if (type === 'fight_target') { run.fightResults[res.reasonCode] = (run.fightResults[res.reasonCode] ?? 0) + 1; (run.fightMessages ??= []).length < 12 && run.fightMessages.push(`${Math.round((Date.now() - startedAt) / 1000)}s d=${blaze.distance.toFixed(1)} dy=${(blaze.position.y - o.position.y).toFixed(1)} hp=${hp.toFixed(1)} ${res.reasonCode}: ${String(res.message ?? '').slice(0, 260)}`); }
				if (type === 'use_ranged') {
					(run.rangedResults ??= {})[res.reasonCode] = (run.rangedResults[res.reasonCode] ?? 0) + 1;
					(run.rangedMessages ??= []).push({ s: Math.round((Date.now()-startedAt)/1000), reason: res.reasonCode, message: res.message });
					const block = /meets minecraft:cobblestone at (-?\d+),(-?\d+),(-?\d+) before the target/.exec(res.message ?? '');
					if (SHELTER && res.reasonCode === 'TARGET_OBSTRUCTED' && block) {
						const [x,y,z] = block.slice(1).map(Number);
						// The stand-in reads the named obstruction and mines only its known head-height wall, keeping the sill.
						if (y === shelterArgs.y+1 && Math.abs(x-shelterArgs.x)+Math.abs(z-shelterArgs.z) === 1) blockedWindow = {x,y,z};
					}
				}
				if (type === 'break_block') {
					(run.windowChanges ??= []).push({ args, result:res });
					if (res.state === 'SUCCEEDED') peekedHeads.add([args.x,args.y,args.z].join(','));
				}
				if (type === 'pick_up_item' && res.state === 'SUCCEEDED') run.rodsPicked++;
				if (type === 'pick_up_item' && SHELTER && RANGED !== 'none' && res.reasonCode !== 'AGENT_DEAD') {
					const returned = await act('build_shelter', shelterArgs, 125000);
					(run.returnShelters ??= []).push(returned);
					if (returned.state === 'SUCCEEDED') { peekedHeads.clear(); peekedHeads.add(openingHead); }
				}
				if (res.reasonCode === 'AGENT_DEAD') { run.deaths++; dead = true; break; }
			}
			runDeadline = Infinity;
			run.kills = kills.slice(killMark).filter(k => k.type === 'minecraft:blaze').length;
			const firstKill = kills.slice(killMark).find(k => k.type === 'minecraft:blaze'); if (firstKill) run.firstKillS = Math.round((firstKill.at - startedAt) / 1000);
			run.otherKills = kills.slice(killMark).filter(k => k.type !== 'minecraft:blaze').map(k => k.type);
			run.rodItemsSeen = rodIds.size; run.seconds = Math.round((Date.now() - startedAt) / 1000);
			run.endServerTick = await serverTick();
			run.approxTps = (run.endServerTick-startServerTick)/((Date.now()-startedAt)/1000);
			if (dead) { run.recovered = false; run.minHealth = 0; }
			else {
				// Never credit a pickup observed only after the cutoff, or inventory lost on death.
				if ((await serverHealth()) <= 0) { run.deaths++; run.minHealth = 0; }
				else run.rodsAtEnd = rodsHeld(lastWindowObservation ?? {});
				run.endObservationAgeMs = lastWindowObservationAt ? Math.max(0, startedAt+RUN_S*1000-lastWindowObservationAt) : null;
			}
			const bowScore = await command(`scoreboard players get ${agent} d39_bow`);
			run.shotsFired = Number(/has (\d+) /.exec(bowScore)?.[1] ?? 0);
			run.shotsRefused = run.rangedResults?.TARGET_OBSTRUCTED ?? 0;
			run.bowCounterReceipt = bowScore;
			run.pickupCallsSucceeded = run.rodsPicked; run.rodsPicked = windowRods; run.maxInventoryInsideWindow = windowRods; run.maxInventoryObserved = maxRods;
			if (run.shelterCells) for (const [x,y,z] of [...run.shelterCells].reverse()) await nether(`fill ${x} ${y} ${z} ${x} ${y} ${z} minecraft:air replace minecraft:cobblestone`);
			if (run.coverCells) for (const [x,y,z] of [...run.coverCells].reverse()) await nether(`fill ${x} ${y} ${z} ${x} ${y} ${z} minecraft:air replace minecraft:cobblestone`);
			runs.push(run); console.log(variant, repeat, JSON.stringify(run));
			results.variants[variant] = { runs, partial: true };
			await writeFile(join(out, 'blaze-spawner.json'), JSON.stringify(results, null, 2)).catch(() => {});
		}
		const sum = k => runs.reduce((s, r) => s + r[k], 0);
		results.variants[variant] = { runs, deaths: sum('deaths'), kills: sum('kills'), rodItemsSeen: sum('rodItemsSeen'), rodsPicked: sum('rodsPicked'), rodsAtEnd: sum('rodsAtEnd'), minutes: Math.round(sum('seconds') / 6) / 10 };
		console.log(variant, JSON.stringify(results.variants[variant], (k, v) => k === 'runs' ? undefined : v));
	}
} finally {
	results.goalEvents = goalEvents;
	await writeFile(join(out, 'blaze-spawner.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(15000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close(); await trace.close();
}
