#!/usr/bin/env node
// Provider-free check that a running travel_to survives what used to end it (FIX 3, d41-resume). This script stands in
// for the coordinator over the bridge and checks:
//   zombieStop     a zombie on the route stops travel_to without fightThrough (HOSTILE_NEAR, unchanged);
//   zombieFight    with the model's fightThrough:true the body fights the zombie with its sword and arrives;
//   reflexResume   a model-armed reflex fires mid-trip after a hit; the paused trip resumes and arrives, and its result
//                  names the reflex that paused it.
// Always launch under fix-slot.sh (slot.sh live); ports come from SLOT_PORT_BASE. Operator commands build fixtures and spawn mobs only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/travel-resume-live');
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

let rcon, bridge, record, observation, inbox, revision = 0, ordinal = 0;
const agent = 'Resume';
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
	await bridge.send('reflex_update', record.agentId, { revision, rules: normalizeReflexEntries(rules), yield: false });
	for (let index = 0; index < 40; index += 1) { const o = await observe(); if (o.reflexes?.revision === revision) return o; await sleep(100); }
	throw new Error(`reflex revision ${revision} never echoed`);
}
function startAction(type, args) {
	const id = `reflex-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'travel-resume-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const result = inbox.wait('action_result', (event) => event.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(event.payload.state), 90000)
		.then(async (event) => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return event.payload; });
	return bridge.send('action_command', record.agentId, payload).then(() => ({ id, result }));
}
const events = (o, id) => (o.reflexes?.events ?? []).filter((event) => event.id === id);
const health = (o) => o.player?.health;

const results = {};
const only = (process.env.RESUME_ONLY ?? '').split(',').filter(Boolean);
let o;
try {
	for (let attempt = 0; attempt < 150; attempt += 1) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (error) { await rcon?.close(); if (attempt === 149) throw error; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', (event) => {
		if (event.agentId !== record?.agentId || !event.payload.ready) return;
		observation = event.payload;
		const firing = event.payload.reflexes?.firing;
		timeline.push({ at: Date.now(), firing: firing?.id ?? null, action: event.payload.currentAction?.active ? event.payload.currentAction.actionId ?? true : false, health: event.payload.player?.health, incoming: (event.payload.incomingProjectiles ?? []).map((row) => `${row.type}@${row.etaSeconds}`), yaw: event.payload.view?.yaw, air: event.payload.player?.air, y: event.payload.position?.y });
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
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled live travel resume fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
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
	await command(`effect give ${agent} minecraft:resistance 1000 2 true`);
	// A long stone strip: start at z 0.5, target z 36.5; nothing but the strip and air.
	const resetCourse = async () => {
		await command('kill @e[type=!minecraft:player]'); await command('fill -6 80 -6 6 90 40 minecraft:air'); await command('fill -6 79 -6 6 79 40 minecraft:stone');
		await command(`clear ${agent}`); await command(`effect give ${agent} minecraft:instant_health 1 3 true`);
		await command(`tp ${agent} 0.5 80 0.5 0 0`); await sleep(800); return observe();
	};
	const travel = (extra = {}) => startAction('travel_to', { x: 0.5, y: 80, z: 36.5, tolerance: 2, build: false, timeoutMs: 60000, ...extra });
	const zombie = async () => { await command('summon minecraft:zombie 0.5 80 14.5 {PersistenceRequired:1b,CanPickUpLoot:0b,IsBaby:0b}'); await command('item replace entity @e[type=minecraft:zombie] armor.head with minecraft:leather_helmet'); await sleep(300); };
	const zombies = async () => Number((await command('execute if entity @e[type=minecraft:zombie]')).match(/\d+/)?.[0] ?? 0);

	// zombieStop: without fightThrough the trip hands back at the first hostile, as before.
	if (only.length === 0 || only.includes('zombieStop')) {
		await command('time set noon'); await resetCourse();
		await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`);
		o = await setReflexes([]);
		await zombie();
		const trip = await travel();
		const result = await trip.result;
		o = await observe();
		results.zombieStop = { state: result.state, reasonCode: result.reasonCode, message: result.message?.slice(0, 400), z: o.position?.z };
		results.zombieStop.pass = result.state === 'FAILED' && result.reasonCode === 'HOSTILE_NEAR';
	}

	// zombieFight: fightThrough:true fights the zombie with the carried sword (fight_target rules), then arrives.
	if (only.length === 0 || only.includes('zombieFight')) {
		await command('time set noon'); await resetCourse();
		await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`);
		o = await setReflexes([]);
		await zombie();
		const before = await zombies();
		const trip = await travel({ fightThrough: true });
		const result = await trip.result;
		o = await observe();
		const after = await zombies();
		results.zombieFight = { state: result.state, reasonCode: result.reasonCode, message: result.message?.slice(0, 600), z: o.position?.z, health: health(o), zombiesBefore: before, zombiesAfter: after };
		results.zombieFight.pass = result.state === 'SUCCEEDED' && result.reasonCode === 'ARRIVED' && /fought through zombie/.test(result.message ?? '') && after === 0;
	}

	// reflexResume: a hit mid-trip fires a model-armed rule (select bread); the trip is paused under it, then resumes.
	if (only.length === 0 || only.includes('reflexResume')) {
		await command('time set noon'); await resetCourse();
		await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`); await command(`item replace entity ${agent} hotbar.4 with minecraft:bread 4`);
		o = await setReflexes([{ id: 'hurt-bread', priority: 6, when: { type: 'health_below', value: 19 }, do: { type: 'select', item: 'minecraft:bread' }, maxFirings: 1 }]);
		const trip = await travel();
		let hit = false;
		for (let index = 0; index < 60 && !hit; index += 1) {
			await sleep(100); o = await observe();
			if ((o.position?.z ?? 0) > 6) { await command(`damage ${agent} 4 minecraft:generic`); hit = true; }
		}
		const result = await trip.result;
		o = await observe();
		results.reflexResume = { hit, state: result.state, reasonCode: result.reasonCode, message: result.message?.slice(0, 600), z: o.position?.z, events: events(o, 'hurt-bread'),
			firedDuringTrip: timeline.some((row) => row.firing === 'hurt-bread') || events(o, 'hurt-bread').length > 0 };
		results.reflexResume.pass = hit && result.state === 'SUCCEEDED' && result.reasonCode === 'ARRIVED' && /paused 1 time\(s\) by reflex hurt-bread/.test(result.message ?? '') && /resumed 1 time/.test(result.message ?? '');
	}
	results.status = o?.reflexes;
	await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
	await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
	console.log(JSON.stringify(Object.fromEntries(Object.entries(results).filter(([key]) => key !== 'status').map(([key, value]) => [key, value.pass]))));
	const failed = Object.entries(results).filter(([key, value]) => key !== 'status' && !value.pass).map(([key]) => key);
	if (failed.length > 0) { console.log(JSON.stringify(results, null, 2)); process.exitCode = 1; }
	else console.log('Travel resume mechanics verified');
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
