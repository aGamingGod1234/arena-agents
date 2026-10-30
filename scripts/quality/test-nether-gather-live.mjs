#!/usr/bin/env node
// Provider-free check of two melee facts behind the Nether gathering guidance (nether-gather), in a real server: this
// script stands in for the coordinator and sends fight_target as a model would. shieldTiming: an angry enderman against
// fight_target {pursue:false, shield:true} in the open (alternate runs add a second enderman), health lost over a
// 15 s fight (compare jars with ARENA_JAR). tunnel: the
// player two cells inside a 1-wide, 2-high stone tunnel and an angry enderman outside, health lost and whether the
// fight kills it. Operator commands build fixtures, spawn mobs and anger them (damage by the player) only.
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. NG_REPEATS (default 3) repeats each scenario.
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build fixtures and spawn mobs only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/nether-gather-live');
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
const agent = 'Reflex';
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
	const result = inbox.wait('action_result', (event) => event.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(event.payload.state), 90000)
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
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled live reflex fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
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
	// Endermen under open sky teleport away in daylight.
	await command('time set midnight'); await command('gamerule minecraft:advance_time false');
	const repeats = Number(process.env.NG_REPEATS ?? 4);
	const enderman = '00000001-0000-0002-0000-000300000009';
	const kit = async () => {
		await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
		await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
		for (const [slot, item] of [['head', 'iron_helmet'], ['chest', 'iron_chestplate'], ['legs', 'iron_leggings'], ['feet', 'iron_boots']]) await command(`item replace entity ${agent} armor.${slot} with minecraft:${item}`);
	};
	// A tough enderman (and optionally a second one) keeps the fight going long enough to measure blocking.
	const tough = 'PersistenceRequired:1b,Health:120f,attributes:[{id:"minecraft:max_health",base:120}]';
	const angerAndFight = async (name, x, z, args, second = null) => {
		await command(`summon minecraft:enderman ${x} 80 ${z} {UUID:[I;1,2,3,9],${tough}}`);
		if (second) await command(`summon minecraft:enderman ${second[0]} 80 ${second[1]} {${tough}}`);
		await sleep(500);
		await command(`execute as @e[type=minecraft:enderman] run damage @s 1 minecraft:player_attack by ${agent}`);
		o = await observe(); const before = health(o);
		const fight = await startAction('fight_target', { targetId: enderman, timeoutMs: 25000, ...args });
		const done = await fight.result; o = await observe();
		const alive = (await command('execute if entity @e[type=minecraft:enderman]')).includes('passed');
		return { result: done.reasonCode, healthLost: Math.round((before - health(o)) * 10) / 10, killed: !alive, ms: done.durationMs ?? null };
	};
	if (want('shieldTiming')) {
		try {
			results.shieldTiming = { runs: [] };
			for (let i = 0; i < repeats; i += 1) {
				await reset(); await kit(); await sleep(1200);
				results.shieldTiming.runs.push(await angerAndFight('shieldTiming', 0.5, 4.5, { pursue: false, shield: true, fleeAtHealth: 4, timeoutMs: 15000 },
					i % 2 === 1 ? [3.5, 3.5] : null));
			}
			const runs = results.shieldTiming.runs;
			results.shieldTiming.meanHealthLost = runs.reduce((a, r) => a + r.healthLost, 0) / runs.length;
			results.shieldTiming.pass = runs.length === repeats;
			await settle('shieldTiming');
		} catch (error) { await settle('shieldTiming', error); }
	}
	if (want('tunnel')) {
		try {
			results.tunnel = { runs: [] };
			for (let i = 0; i < repeats; i += 1) {
				await reset(); await kit();
				// Stone block x -2..2, z 0..4, y 80..83; a 1-wide, 2-high tunnel along x=0 from the mouth at z=4 to z=1.
				await command('fill -2 80 0 2 83 4 minecraft:stone'); await command('fill 0 80 1 0 81 4 minecraft:air');
				await command(`tp ${agent} 0.5 80 2.5 0 0`); await sleep(1200);
				results.tunnel.runs.push(await angerAndFight('tunnel', 0.5, 6.5, { pursue: false, shield: false }));
			}
			const runs = results.tunnel.runs;
			results.tunnel.meanHealthLost = runs.reduce((a, r) => a + r.healthLost, 0) / runs.length;
			results.tunnel.pass = runs.every((r) => r.healthLost <= 0.5) && runs.some((r) => r.killed);
			await settle('tunnel');
		} catch (error) { await settle('tunnel', error); }
	}
	await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results));
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
