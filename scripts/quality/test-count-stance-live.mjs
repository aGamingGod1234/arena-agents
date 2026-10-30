#!/usr/bin/env node
// Provider-free check (d41 review 3, round 2) that count mode keeps the model's stance outside sword engagements: a
// fight_target with untilItem/untilCount, pursue:false and sneak:true fights from where the body stands, crouched the
// whole call, and hands back (ON_FIRE) instead of stepping off a fire block it was told not to move from. A control run
// without pursue:false steps off the same fire. Operator commands build fixtures only. Launch under fix-slot.sh.
// Round 3 adds controller-level targeting and stance runs: 'no-switch' (continueWithAttackers:false, a blaze hovering out
// of reach, an attacking piglin in sword reach: the fight never touches the piglin) with its control 'switch-default' (the
// engine's own sword turn still swings at it), 'no-creeper' (follow-through on, an attacking creeper beside the named
// blaze: never selected after the kill) and 'bow-crouch' (sneak:true count fight with a bow at hovering blazes, rods
// falling to the floor and onto a ledge: crouched every sample, handing back when a return needs releasing sneak).
// Round 4 adds roof-crouch (approach, obstruction clearing and roof placement) and stationary-retarget (a new
// out-of-reach policy target gets its own 20-second wait, even after the previous target used almost all of its wait).
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/count-stance-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const jar = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
await cp(jar, join(server, 'mods/arena-agents-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261018\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=5\nsimulation-distance=5\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=false\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Darenaagents.bridgePort=${port}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${join(out, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
await writeFile(join(out, 'server.pid'), String(child.pid));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', (event) => this.accept(event)); bridge.on('ready', (event) => this.accept({ type: 'ready', ...event })); }
	accept(event) { const index = this.waiters.findIndex((waiter) => waiter.type === event.type && waiter.match(event)); if (index >= 0) this.waiters.splice(index, 1)[0].done(event); else { this.events.push(event); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) {
		const index = this.events.findIndex((event) => event.type === type && match(event));
		if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
		return new Promise((resolveWait, reject) => { const waiter = { type, match, done: (event) => { clearTimeout(timer); resolveWait(event); } }; const timer = setTimeout(() => { this.waiters = this.waiters.filter((entry) => entry !== waiter); reject(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(waiter); });
	}
}

let rcon, bridge, record, observation, inbox, revision = 0, ordinal = 0, armed = [];
const agent = 'Stance';
const timeline = [];
const command = async (text) => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(text)).text;
};
async function observe() {
	const sequence = observation?.eventSequence ?? 0;
	const next = inbox.wait('observation', (event) => event.agentId === record.agentId && event.payload.ready && event.payload.eventSequence > sequence);
	await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision });
	return (await next).payload;
}
/** As the coordinator sends a model's rules: normalized by reflexes.mjs, the complete set, a new revision. */
async function setReflexes(rules) {
	revision += 1;
	armed = rules;
	await bridge.send('reflex_update', record.agentId, { revision, rules: normalizeReflexEntries(rules), yield: false });
	for (let index = 0; index < 40; index += 1) { const o = await observe(); if (o.reflexes?.revision === revision) return o; await sleep(100); }
	throw new Error(`reflex revision ${revision} never echoed`);
}
/** What the coordinator sends before a direct model body command while a reflex fires: the same rules, yield set. */
async function yieldReflexes() {
	revision += 1;
	await bridge.send('reflex_update', record.agentId, { revision, rules: normalizeReflexEntries(armed), yield: true });
}
function startAction(type, args) {
	const id = `reflex-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'reflex-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const result = inbox.wait('action_result', (event) => event.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(event.payload.state), 240000)
		.then(async (event) => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return event.payload; });
	return bridge.send('action_command', record.agentId, payload).then(() => ({ id, result }));
}
const events = (o, id) => (o.reflexes?.events ?? []).filter((event) => event.id === id);
const health = (o) => o.player?.health;

const results = {};
const only = (process.env.REFLEX_ONLY ?? '').split(',').filter(Boolean);
let o;
try {
	for (let attempt = 0; attempt < 150; attempt += 1) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (error) { await rcon?.close(); if (attempt === 149) throw error; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', (event) => {
		if (event.agentId !== record?.agentId || !event.payload.ready) return;
		observation = event.payload;
		const firing = event.payload.reflexes?.firing;
		timeline.push({ at: Date.now(), firing: firing?.id ?? null, detail: firing?.detail ?? null, using: event.payload.interaction?.usingItem ?? null, x: event.payload.position?.x, action: event.payload.currentAction?.active ? event.payload.currentAction.actionId ?? true : false, health: event.payload.player?.health, incoming: (event.payload.incomingProjectiles ?? []).map((row) => `${row.type}@${row.etaSeconds}`), yaw: event.payload.view?.yaw, air: event.payload.player?.air, y: event.payload.position?.y });
	});
	// Follow goal revisions (the accepted goal spec bumps it); reflex rules are not tied to a revision.
	bridge.on('message', (event) => {
		if (!['observation', 'action_progress', 'heartbeat'].includes(event.type)) console.log(`[in] ${event.type} ${JSON.stringify(event.payload).slice(0, 160)}`);
		const registered = ['agent_registered', 'registry_entry'].includes(event.type) ? { goalRevision: event.payload.goalRevision ?? event.payload.record?.goalRevision, operation: 'registered' } : null;
		const control = registered ?? (event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null);
		if (control == null || event.agentId !== record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= record.goalRevision) return;
		if (['queue', 'dequeue'].includes(control.operation)) return;
		record.goalRevision = control.goalRevision;
		bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	});
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled count stance fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free reflex fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] });
	await command('difficulty normal'); await command('gamerule minecraft:send_command_feedback false'); await command('gamerule minecraft:spawn_mobs false');
	await command('time set noon'); await command('forceload add -32 -32 48 48'); await sleep(2000);
	await command('fill -24 75 -24 40 95 40 minecraft:air'); await command('fill -24 79 -24 40 79 40 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 80 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const summoned = await registered; record = { ...(summoned.payload.record ?? summoned.payload), agentId: summoned.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', (event) => event.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await sleep(2000); await observe();
	await command(`gamemode survival ${agent}`); await command(`clear ${agent}`);
	await command(`effect give ${agent} minecraft:saturation 5 10 true`);


	const reset = async () => {
		await command('kill @e[type=!minecraft:player]');
		// Each fill stays under vanilla's 32,768-block limit (a larger one is refused and leaves the last fixture standing).
		for (const fill of ['-12 80 -12 20 90 24 minecraft:air', '-12 79 -12 20 79 24 minecraft:stone', '-2 70 -1 2 78 6 minecraft:stone']) {
			const reply = await command(`fill ${fill}`);
			if (/too many|cannot|error/i.test(reply)) throw new Error(`reset fill refused: ${reply}`);
		}
		await command(`effect give ${agent} minecraft:instant_health 1 5 true`); await command(`effect give ${agent} minecraft:saturation 2 10 true`);
		await command(`clear ${agent}`); await command(`tp ${agent} 0.5 80 0.5 0 0`);
		await setReflexes([]);
		await sleep(1000);
	};
	const selected = (name) => only.length === 0 || only.includes(name);
	// Each scenario runs on its own: a failure is recorded and the next one still runs; results are saved as they come.
	const scenarios = [];
	const want = (name) => selected(name) && (scenarios.push(name), true);
	const settle = async (name, error) => {
		if (error) results[name] = { ...(results[name] ?? {}), pass: false, error: String(error?.stack ?? error).slice(0, 400) };
		await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
		await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
		console.log(`[scenario] ${name}: ${results[name]?.pass ? 'PASS' : 'FAIL'}`);
	};
	const debug = process.env.REFLEX_DEBUG === '1';
	const until = async (ms, test) => { const end = Date.now() + ms; while (Date.now() < end) { o = await observe(); if (debug) console.log(`[debug] ${JSON.stringify({ rules: o.reflexes?.rules, firing: o.reflexes?.firing, error: o.reflexes?.error, pos: o.position })}`); if (test(o)) return true; await sleep(debug ? 1000 : 250); } return false; };
	const block = async (x, y, z) => (await command(`execute if block ${x} ${y} ${z} minecraft:air`)).includes('passed') ? 'air' : 'solid';
	const firingSeen = (id) => timeline.some((row) => row.firing === id);
	const fireCells = async (spec) => { const reply = await command(`fill ${spec} minecraft:fire replace minecraft:air`); if (/cannot|error|unknown/i.test(reply)) throw new Error(`fire fill refused: ${reply}`); };
	// Netherrack floor: fire on it never burns out (infiniburn), as on the fortress's netherrack and bricks it stays lit.
	const netherFloor = async () => { await command('fill -6 79 -6 6 79 6 minecraft:netherrack'); await command('fill -6 80 -6 6 82 6 minecraft:air'); };
	// Food below 18 stops natural regeneration, so the health a burn costs shows (reset tops food up to full).
	const noRegen = async () => { await command(`effect clear ${agent}`); await command(`effect give ${agent} minecraft:hunger 30 255 true`); const drained = await until(20000, (now) => now.player?.foodLevel <= 16); await command(`effect clear ${agent}`); if (!drained) throw new Error(`food still ${o.player?.foodLevel}`); };
	const fireAt = (now) => now.player?.hazard === 'fire' || now.player?.harm?.source === 'minecraft:in_fire';
	const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
	const row = (now) => ({ at: Date.now(), x: now.position?.x, y: now.position?.y, z: now.position?.z, crouching: now.player?.crouching ?? null, pose: now.player?.pose ?? null,
		action: now.currentAction?.active ? now.currentAction.actionId ?? true : false, health: health(now), using: now.interaction?.usingItem ?? null, mainHand: now.interaction?.mainHandItemId ?? null });
	const kit = async () => {
		await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
		await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
		await command(`item replace entity ${agent} hotbar.1 with minecraft:cobblestone 32`);
	};
	/** Runs one count fight and samples the body until it ends; the husks stand still (NoAI) and do not burn (husk). */
	const countFight = async (args, during, duringAfterMs = 0) => {
		o = await observe();
		const start = row(o);
		const { result } = await startAction('fight_target', { targetId: uuid(1), untilItem: 'minecraft:rotten_flesh', untilCount: 5, timeoutMs: 15000, ...args });
		const rows = []; let done = null;
		result.then((value) => { done = value; }, () => {});
		const end = Date.now() + 230000;
		let fired = false;
		while (!done && Date.now() < end) {
			o = await observe(); rows.push(row(o));
			if (!fired && during && rows.length >= 6 && Date.now() - start.at >= duringAfterMs) { fired = true; await during(); }
			await sleep(200);
		}
		const final = done ?? await Promise.race([result, sleep(15000).then(() => null)]);
		const moved = Math.max(0, ...rows.map((r) => Math.hypot(r.x - start.x, r.z - start.z)));
		const active = rows.filter((r) => r.action);
		return { start, final: final && { state: final.state, reason: final.reasonCode, message: String(final.message ?? JSON.stringify(final.failure ?? '')) },
			seconds: (Date.now() - start.at) / 1000,
			bowSamples: active.filter((r) => r.using && r.mainHand === 'minecraft:bow').length,
			moved: Math.round(moved * 100) / 100, samples: active.length, crouched: active.filter((r) => r.crouching).length,
			// The first second covers the call's start (the first tick crouches the body).
			lateSamples: active.filter((r) => r.at - start.at >= 1000).length, lateCrouched: active.filter((r) => r.at - start.at >= 1000 && r.crouching).length, rows: rows.filter((r, i) => i % 5 === 0 || !r.crouching) };
	};
	// Fire on netherrack in the cell the body stands in now (netherrack keeps it lit).
	const fireUnderfoot = async () => { const x = Math.floor(o.position.x), z = Math.floor(o.position.z); await command(`setblock ${x} 79 ${z} minecraft:netherrack`); await command(`setblock ${x} 80 ${z} minecraft:fire`); };
	const healthOf = async (n) => { const reply = await command(`data get entity ${uuid(n)} Health`); const m = /(-?[\d.]+)f/.exec(reply); return m ? Number(m[1]) : null; };
	const alive = async (n) => (await command(`execute if entity ${uuid(n)}`)).includes('passed');
	const tough = async () => { await command(`effect give ${agent} minecraft:resistance 240 4 true`); };
	/** A blaze that hovers where it is put and never shoots (NoAI); out of sword reach when 4+ blocks above the feet. */
	const blaze = async (n, x, y, z) => command(`summon minecraft:blaze ${x} ${y} ${z} {NoAI:1b,NoGravity:1b,UUID:[I;0,0,0,${n}]}`);
	const husks = async () => {
		// One in sword reach ahead, one 6 blocks off that a pursuing fight would walk to.
		await command('summon minecraft:husk 0.5 80 2.3 {NoAI:1b,UUID:[I;0,0,0,1]}');
		await command('summon minecraft:husk 0.5 80 7.5 {NoAI:1b,UUID:[I;0,0,0,2]}');
		await sleep(1500);
	};

	// pursue:false + sneak:true: kills the husk in reach, never walks to the far one, crouched every sample.
	if (want('still')) {
		try {
			await reset(); await kit(); await husks();
			const run = await countFight({ pursue: false, sneak: true });
			const killed = (await command(`execute if entity ${uuid(1)}`)).includes('passed') === false;
			results.still = { ...run, nearKilled: killed };
			results.still.pass = run.final != null && run.final.reason !== 'ACTION_EXCEPTION' && killed && run.moved < 0.5 && run.lateSamples >= 10 && run.lateCrouched === run.lateSamples;
			await settle('still');
		} catch (error) { await settle('still', error); }
	}
	// pursue:false in fire: hands back ON_FIRE where it stands.
	if (want('fire-still')) {
		try {
			await reset(); await kit(); await husks();
			const run = await countFight({ pursue: false, sneak: true }, fireUnderfoot);
			results['fire-still'] = run;
			results['fire-still'].pass = run.final?.reason === 'ON_FIRE' && run.moved < 0.5;
			await settle('fire-still');
		} catch (error) { await settle('fire-still', error); }
	}
	// Control: the default stance steps off the same fire and fights on.
	if (want('fire-default')) {
		try {
			await reset(); await kit(); await husks();
			const run = await countFight({}, fireUnderfoot);
			results['fire-default'] = run;
			results['fire-default'].pass = run.final != null && run.final.reason !== 'ON_FIRE' && run.final.reason !== 'ACTION_EXCEPTION' && /\d+ steps? off fire/.test(run.final.message) && !/0 steps off fire/.test(run.final.message);
			await settle('fire-default');
		} catch (error) { await settle('fire-default', error); }
	}
	// The piglin attacks a player without gold armour. Force anger too, then witness its angry_at memory and record its
	// health before the fight, so an untouched mob cannot pass merely because it never attacked.
	const reachSetup = async () => {
		await reset(); await kit(); await tough();
		await blaze(1, 0.5, 86, 2.5);
		await command('summon minecraft:piglin 0.5 80 2.5 {UUID:[I;0,0,0,2],PersistenceRequired:1b,IsImmuneToZombification:1b,HandItems:[{id:"minecraft:golden_sword",count:1},{}]}');
		await command(`damage ${uuid(2)} 1 minecraft:player_attack by ${agent}`);
		await sleep(1500);
		const memory = await command(`data get entity ${uuid(2)} Brain.memories`);
		if (!memory.includes('angry_at')) throw new Error(`Piglin did not become angry: ${memory}`);
		return { health: await healthOf(2), angry: true };
	};
	if (want('no-switch')) {
		try {
			const before = await reachSetup();
			const run = await countFight({ targetId: uuid(1), untilItem: 'minecraft:blaze_rod', untilCount: 1, pursue: false, continueWithAttackers: false });
			const piglinHealth = await healthOf(2);
			results['no-switch'] = { ...run, rows: undefined, before, piglinHealth, piglinAlive: await alive(2) };
			results['no-switch'].pass = run.final?.reason === 'TARGET_OUT_OF_REACH' && piglinHealth === before.health
				&& !/sword turned|in-reach attacker|piglin in sword reach/.test(run.final.message);
			await settle('no-switch');
		} catch (error) { await settle('no-switch', error); }
	}
	// Positive control: follow-through on allows the count engine to turn to the same attacking piglin.
	if (want('switch-default')) {
		try {
			const before = await reachSetup();
			const run = await countFight({ targetId: uuid(1), untilItem: 'minecraft:blaze_rod', untilCount: 1, pursue: false });
			const piglinHealth = await healthOf(2);
			results['switch-default'] = { ...run, rows: undefined, before, piglinHealth, piglinAlive: await alive(2) };
			results['switch-default'].pass = run.final != null && run.final.reason !== 'ACTION_EXCEPTION'
				&& (piglinHealth === null || piglinHealth < before.health) && /sword turned/.test(run.final.message);
			await settle('switch-default');
		} catch (error) { await settle('switch-default', error); }
	}
	// (b) follow-through on (continueWithAttackers:true): after the named blaze dies, an attacking creeper (fuse never
	// completes, no blast) is never selected (round 3 MUST 2).
	if (want('no-creeper')) {
		try {
			await reset(); await kit(); await tough();
			await blaze(1, 0.5, 80, 2.4);
			await command('summon minecraft:creeper 2.5 80 1.5 {UUID:[I;0,0,0,3],Fuse:32767s,ExplosionRadius:0b,PersistenceRequired:1b}');
			await sleep(1500);
			const run = await countFight({ targetId: uuid(1), untilItem: 'minecraft:blaze_rod', untilCount: 5, timeoutMs: 15000, continueWithAttackers: true });
			const creeperHealth = await healthOf(3);
			results['no-creeper'] = { ...run, rows: undefined, blazeKilled: !(await alive(1)), creeperHealth, creeperAlive: await alive(3) };
			results['no-creeper'].pass = run.final != null && run.final.reason !== 'ACTION_EXCEPTION' && results['no-creeper'].blazeKilled && creeperHealth === 20
				&& !/creeper/.test(run.final.message.replace(/remaining threats?[^;]*/gi, ''));
			await settle('no-creeper');
		} catch (error) { await settle('no-creeper', error); }
	}
	// (c) A real bow volley followed by a walk to floor drops. The injected rod makes collection independent of loot RNG.
	if (want('bow-crouch')) {
		try {
			await reset(); await kit(); await tough();
			await command(`item replace entity ${agent} hotbar.2 with minecraft:bow`);
			await command(`item replace entity ${agent} hotbar.3 with minecraft:arrow 64`);
			await blaze(1, 0.5, 83, 9.5);
			await sleep(1500);
			const floorRod = async () => command('summon minecraft:item 0.5 81 5.5 {Item:{id:"minecraft:blaze_rod",count:1},PickupDelay:10s}');
			const run = await countFight({ untilItem: 'minecraft:blaze_rod', untilCount: 1, sneak: true }, floorRod);
			const rods = Number(/Found (\d+)/.exec(await command(`clear ${agent} minecraft:blaze_rod 0`))?.[1] ?? 0);
			results['bow-crouch'] = { ...run, blazeKilled: !(await alive(1)), rods };
			results['bow-crouch'].pass = run.final?.reason === 'UNTIL_COUNT_REACHED' && results['bow-crouch'].blazeKilled
				&& rods > 0 && run.moved > 1 && run.bowSamples > 0 && run.lateSamples >= 20 && run.lateCrouched === run.lateSamples;
			await settle('bow-crouch');
		} catch (error) { await settle('bow-crouch', error); }
	}
	// A separate ledge drop is seen mid-volley. A return that needs stepping off the edge must hand back with
	// SNEAK_HOLDS_EDGE, rather than releasing the model's crouch in LedgeFetch's pillar, cross or return children.
	if (want('ledge-crouch')) {
		try {
			await reset(); await kit(); await tough();
			await command(`item replace entity ${agent} hotbar.2 with minecraft:bow`);
			await command(`item replace entity ${agent} hotbar.3 with minecraft:arrow 64`);
			// One high: its top is visible from crouched eye height, so the test supplies acquired terrain for the trip.
			await command('fill 6 80 4 8 80 6 minecraft:stone');
			// Acquire the landing through the body's real look action. Earlier scenarios may have recorded air here, and
			// merely spawning a ledge off to the side does not guarantee that perception's terrain rays hit its top.
			for (const aim of [{ x: 7.5, y: 80.99, z: 5.5 }, { x: 0.5, y: 83, z: 9.5 }]) {
				const look = await startAction('look_at', aim);
				const result = await look.result;
				if (result.state !== 'SUCCEEDED') throw new Error(`Landing setup look failed: ${result.reasonCode}`);
				await sleep(500); await observe();
			}
			await blaze(1, 0.5, 83, 9.5);
			await sleep(1500);
			const ledgeRod = async () => command('summon minecraft:item 7.5 84 5.5 {Item:{id:"minecraft:blaze_rod",count:1},PickupDelay:10s}');
			const run = await countFight({ untilItem: 'minecraft:blaze_rod', untilCount: 9, sneak: true }, ledgeRod);
			results['ledge-crouch'] = run;
			results['ledge-crouch'].pass = run.final?.reason === 'SNEAK_HOLDS_EDGE' && run.bowSamples > 0
				&& run.moved > 1 && run.lateSamples >= 20 && run.lateCrouched === run.lateSamples;
			await settle('ledge-crouch');
		} catch (error) { await settle('ledge-crouch', error); }
	}
	// A roof count call must hold sneak through the shelter's higher-priority navigation, building and clearing leases.
	if (want('roof-crouch')) {
		try {
			await reset(); await kit(); await tough();
			await command(`item replace entity ${agent} hotbar.2 with minecraft:iron_axe`);
			// Only the cell one block east has firm ground all around: construction must approach it first.
			for (const [x, z] of [[-1, 0], [0, -1], [0, 1]]) await command(`setblock ${x} 79 ${z} minecraft:air`);
			await command('setblock 1 80 -1 minecraft:oak_fence');
			for (const aim of [{ x: 1.5, y: 79, z: 0.5 }, { x: 1.5, y: 80.5, z: -0.5 }, { x: 0.5, y: 81, z: 9.5 }]) {
				const look = await startAction('look_at', aim); await look.result; await sleep(500); await observe();
			}
			await command('summon minecraft:enderman 0.5 80 9.5 {NoAI:1b,PersistenceRequired:1b,UUID:[I;0,0,0,1]}');
			await sleep(1500);
			// End after construction, independently of enderman aggression and pearl loot RNG.
			const run = await countFight({ untilItem: 'minecraft:ender_pearl', untilCount: 1, roof: true, sneak: true },
				() => command(`give ${agent} minecraft:ender_pearl 1`), 25000);
			const fenceCleared = !(await command('execute if block 1 80 -1 minecraft:oak_fence')).includes('passed');
			const ceiling = (await command('execute if block 1 82 0 minecraft:cobblestone')).includes('passed');
			results['roof-crouch'] = { ...run, fenceCleared, ceiling };
			results['roof-crouch'].pass = run.final != null && run.final.reason !== 'ACTION_EXCEPTION'
				&& fenceCleared && ceiling && /roof: 1 build/.test(run.final.message)
				&& run.moved > 0.5 && run.lateSamples >= 20 && run.lateCrouched === run.lateSamples;
			await settle('roof-crouch');
		} catch (error) { await settle('roof-crouch', error); }
	}
	// After 17 seconds on A, a nearer attacking blaze B (still outside sword reach) triggers nearest_attacker.
	if (want('stationary-retarget')) {
		try {
			await reset(); await kit(); await tough();
			await blaze(1, 0.5, 86, 9.5); await sleep(1500);
			let introducedAt = null;
			const introduce = async () => {
				introducedAt = Date.now();
				await command('summon minecraft:blaze 0.5 85 4.5 {NoGravity:1b,PersistenceRequired:1b,UUID:[I;0,0,0,2]}');
				await command(`damage ${uuid(2)} 1 minecraft:player_attack by ${agent}`);
				await sleep(1000);
				// NoAI stops decisions, but NoGravity retains velocity. Freeze both and restore the intended distance.
				await command(`data merge entity ${uuid(2)} {NoAI:1b,Motion:[0.0d,0.0d,0.0d]}`);
				await command(`tp ${uuid(2)} 0.5 85 4.5`);
			};
			const run = await countFight({ untilItem: 'minecraft:blaze_rod', untilCount: 1, pursue: false, shield: false, targetPolicy: 'nearest_attacker' }, introduce, 17000);
			const secondsAfterB = introducedAt == null ? null : (Date.now() - introducedAt) / 1000;
			results['stationary-retarget'] = { ...run, rows: undefined, secondsAfterB };
			results['stationary-retarget'].pass = run.final?.reason === 'TARGET_OUT_OF_REACH' && run.moved < 0.5
				&& run.seconds >= 36 && run.seconds < 50 && secondsAfterB >= 19
				&& run.final.message.includes(`nearest_attacker: switched to minecraft:blaze ${uuid(2)}`)
				&& run.final.message.includes(`minecraft:blaze ${uuid(2)} stayed out of sword reach`);
			await settle('stationary-retarget');
		} catch (error) { await settle('stationary-retarget', error); }
	}
	// pursue:false, no bow, the named blaze hovering out of sword reach: hands back TARGET_OUT_OF_REACH early (round 3 NOTE).
	if (want('still-unreachable')) {
		try {
			await reset(); await kit(); await tough();
			await blaze(1, 0.5, 86, 2.5);
			await sleep(1500);
			const began = Date.now();
			const run = await countFight({ targetId: uuid(1), untilItem: 'minecraft:blaze_rod', untilCount: 1, pursue: false });
			results['still-unreachable'] = { ...run, rows: undefined, seconds: Math.round((Date.now() - began) / 1000) };
			results['still-unreachable'].pass = run.final?.reason === 'TARGET_OUT_OF_REACH' && run.moved < 0.5 && results['still-unreachable'].seconds < 40;
			await settle('still-unreachable');
		} catch (error) { await settle('still-unreachable', error); }
	}
	results.status = o?.reflexes;
	await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
	await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
	console.log(JSON.stringify(Object.fromEntries(Object.entries(results).filter(([key]) => key !== 'status').map(([key, value]) => [key, value.pass]))));
	const failed = Object.entries(results).filter(([key, value]) => key !== 'status' && !value.pass).map(([key]) => key);
	if (failed.length > 0) { console.log(JSON.stringify(results, null, 2)); process.exitCode = 1; }
	else console.log('Count stance verified');
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
