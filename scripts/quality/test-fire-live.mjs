#!/usr/bin/env node
// Provider-free check of standing in fire (Nether blaze deaths d8-nether-a/b, 2026-10-21: a fireball lit a fire block at the
// agent's feet, which re-ignited it every tick for 5-7 s while the model's turn ran). This script stands in for the
// coordinator: it places fire under the agent (operator commands build fixtures only) and checks the facts (harm.source
// in_fire, exits), an armed in_fire -> leave_fire reflex against no reflex, and break_block on a fire block (a punch puts
// fire out in vanilla). Always launch under slot.sh live; ports come from SLOT_PORT_BASE.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/fire-live');
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
const agent = 'Fire';
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
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled live fire fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
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
	const sample = (now) => ({ at: Date.now(), x: now.position?.x, z: now.position?.z, health: health(now), harm: now.player?.harm?.source ?? null, hazard: now.player?.hazard ?? null, onFire: now.player?.onFire ?? null, exits: now.player?.harm?.exits ?? now.player?.exits ?? null });

	// No reflex: the body stays in the fire block and the facts must say so (in_fire, with fire-free exits).
	if (want('unarmed')) {
		try {
			await reset(); await netherFloor(); await noRegen();
			await command(`item replace entity ${agent} armor.chest with minecraft:iron_chestplate`);
			o = await observe(); const before = health(o);
			await fireCells('-1 80 -1 1 80 1');
			const rows = [];
			const end = Date.now() + 5000;
			while (Date.now() < end) { o = await observe(); rows.push(sample(o)); await sleep(500); }
			const inFire = rows.filter((row) => row.harm === 'minecraft:in_fire').length;
			results.unarmed = { healthBefore: before, health: health(o), rows: rows.filter((_, index) => index % 2 === 0), inFireSamples: inFire, samples: rows.length };
			results.unarmed.pass = inFire >= rows.length - 2 && health(o) < before && rows.at(-1).exits?.length > 0;
			await settle('unarmed');
		} catch (error) { await settle('unarmed', error); }
	}
	// Armed: in_fire -> leave_fire steps the body out of a 3x3 fire patch at once.
	if (want('armed')) {
		try {
			await reset(); await netherFloor(); await noRegen();
			await command(`item replace entity ${agent} armor.chest with minecraft:iron_chestplate`);
			o = await setReflexes([{ id: 'flames', priority: 9, when: { type: 'in_fire' }, do: { type: 'leave_fire' }, maxS: 3 }]);
			const since = Math.max(0, ...(o.reflexes?.events ?? []).map((row) => row.seq ?? 0));
			const before = health(o);
			const lit = Date.now();
			await fireCells('-1 80 -1 1 80 1');
			const left = await until(8000, (now) => events(now, 'flames').some((row) => (row.seq ?? 0) > since && row.outcome === 'done'));
			const outAt = Date.now();
			await sleep(Math.max(0, 5000 - (outAt - lit))); o = await observe();
			const mine = events(o, 'flames').filter((row) => (row.seq ?? 0) > since);
			results.armed = { healthBefore: before, health: health(o), events: mine, outAfterMs: outAt - lit, final: sample(o) };
			results.armed.pass = left && mine.some((row) => row.outcome === 'done' && /out of fire/.test(row.detail ?? '')) && !fireAt(o);
			await setReflexes([]);
			await settle('armed');
		} catch (error) { await settle('armed', error); }
	}
	// Hot floors hurt without setting on_fire. An armed contact exit must leave them; an unlit campfire stays quiet.
	for (const [name, blockId, lit] of [
		['hot_magma', 'minecraft:magma_block', true],
		['hot_campfire', 'minecraft:campfire[lit=true]', true],
		['cold_campfire', 'minecraft:campfire[lit=false]', false],
	]) {
		if (!want(name)) continue;
		try {
			await reset(); await noRegen();
			o = await setReflexes([{ id: 'hot', priority: 9, when: { type: 'on_hot_floor' }, do: { type: 'leave_fire' }, maxS: 5 }]);
			const since = Math.max(0, ...(o.reflexes?.events ?? []).map(row => row.seq ?? 0));
			const before = health(o);
			await command(`setblock 0 79 0 ${blockId}`);
			const began = Date.now();
			const completed = lit ? await until(8000, now => events(now, 'hot').some(row => (row.seq ?? 0) > since && row.outcome === 'done')) : false;
			const elapsedMs = Date.now() - began;
			await sleep(2000); o = await observe();
			const mine = events(o, 'hot').filter(row => (row.seq ?? 0) > since);
			results[name] = { healthBefore: before, health: health(o), events: mine, elapsedMs, final: sample(o) };
			results[name].pass = lit
				? completed && health(o) > 0 && !mine.some(row => ['failed', 'timeout'].includes(row.outcome))
					&& o.player?.hazard !== 'hot_floor' && mine.some(row => /out of hot_floor/.test(row.detail ?? ''))
				: mine.length === 0 && health(o) === before;
			await setReflexes([]);
			await settle(name);
		} catch (error) { await settle(name, error); }
	}
	// A punch puts fire out: break_block on the fire block in front, then on the one under the body.
	if (want('punch')) {
		try {
			await reset(); await netherFloor();
			await fireCells('0 80 2 0 80 2');
			const ahead = await (await startAction('break_block', { x: 0, y: 80, z: 2, timeoutMs: 8000 })).result;
			const aheadGone = (await command('execute if block 0 80 2 minecraft:air')).includes('passed');
			await fireCells('0 80 0 0 80 0');
			await sleep(500);
			const feet = await (await startAction('break_block', { x: 0, y: 80, z: 0, timeoutMs: 8000 })).result;
			const feetGone = (await command('execute if block 0 80 0 minecraft:air')).includes('passed');
			o = await observe();
			results.punch = { ahead: { state: ahead.state, reason: ahead.reasonCode, message: String(ahead.message ?? JSON.stringify(ahead.failure ?? '')).slice(0, 300), gone: aheadGone },
				feet: { state: feet.state, reason: feet.reasonCode, message: String(feet.message ?? JSON.stringify(feet.failure ?? '')).slice(0, 300), gone: feetGone }, final: sample(o) };
			results.punch.pass = aheadGone && feetGone;
			await settle('punch');
		} catch (error) { await settle('punch', error); }
	}
	results.status = o?.reflexes;
	await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
	await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
	console.log(JSON.stringify(Object.fromEntries(Object.entries(results).filter(([key]) => key !== 'status').map(([key, value]) => [key, value.pass]))));
	const failed = Object.entries(results).filter(([key, value]) => key !== 'status' && !value.pass).map(([key]) => key);
	if (failed.length > 0) { console.log(JSON.stringify(results, null, 2)); process.exitCode = 1; }
	else console.log('Fire mechanics verified');
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
