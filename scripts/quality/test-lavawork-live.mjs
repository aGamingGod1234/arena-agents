#!/usr/bin/env node
// Provider-free check of lava work (d12-iron-a/c, 2026-10-21: a tunnel and a stair dug into hidden lava, which flowed onto
// the agent and killed it in 2-7 s while the model's turn ran). This script stands in for the coordinator: operator
// commands build fixtures only; the agent's own break_block, interact_block and reflexes do the work. Scenarios: opening a
// block with lava behind it (unarmed vs in_lava -> leave_lava), breaking obsidian you stand on over lava (unarmed vs armed),
// and casting then mining obsidian from a dry stand beside the pool. Always launch under slot.sh live.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/lavawork-live');
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
const agent = 'Lava';
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
let since = 0;
const events = (o, id) => (o.reflexes?.events ?? []).filter((event) => event.id === id && (event.seq ?? 0) > since);
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
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled live lava fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
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
		for (const fill of ['-8 70 -8 8 90 8 minecraft:air', '-8 70 -8 8 79 8 minecraft:stone']) {
			const reply = await command(`fill ${fill}`);
			if (/too many|cannot|error/i.test(reply)) throw new Error(`reset fill refused: ${reply}`);
		}
		await command(`tp ${agent} 0.5 80 0.5 0 0`);
		await command(`effect clear ${agent}`); await command(`effect give ${agent} minecraft:fire_resistance 2 0 true`);
		await command(`effect give ${agent} minecraft:instant_health 1 5 true`); await command(`effect give ${agent} minecraft:saturation 2 10 true`);
		await command(`clear ${agent}`);
		await setReflexes([]);
		await sleep(2500);
		await command(`effect clear ${agent}`);
	};
	const selected = (name) => only.length === 0 || only.includes(name);
	const scenarios = [];
	const want = (name) => selected(name) && (scenarios.push(name), true);
	const settle = async (name, error) => {
		if (error) results[name] = { ...(results[name] ?? {}), pass: false, error: String(error?.stack ?? error).slice(0, 400) };
		await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
		await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
		console.log(`[scenario] ${name}: ${results[name]?.pass ? 'PASS' : 'FAIL'}`);
	};
	const set = async (spec) => { const reply = await command(`setblock ${spec}`); if (/cannot|error|unknown/i.test(reply)) throw new Error(`setblock refused: ${reply}`); };
	const fill = async (spec) => { const reply = await command(`fill ${spec}`); if (/too many|cannot|error|unknown/i.test(reply)) throw new Error(`fill refused: ${reply}`); };
	const isBlock = async (x, y, z, id) => (await command(`execute if block ${x} ${y} ${z} ${id}`)).includes('passed');
	const lavaAt = (now) => now.player?.hazard === 'lava' || now.player?.harm?.source === 'minecraft:lava' || now.player?.inLava === true;
	const sample = (now) => ({ at: Date.now(), x: now.position?.x, y: now.position?.y, z: now.position?.z, health: health(now), harm: now.player?.harm?.source ?? null,
		hazard: now.player?.hazard ?? null, inLava: lavaAt(now), firing: now.reflexes?.firing?.id ?? null, detail: now.reflexes?.firing?.detail ?? null });
	const give = async (slot, item) => { await command(`item replace entity ${agent} hotbar.${slot} with ${item}`); await sleep(300); };
	const act = async (type, args) => (await startAction(type, args)).result;
	const brief = (result) => ({ state: result.state, reason: result.reasonCode, message: String(result.message ?? JSON.stringify(result.failure ?? '')).slice(0, 400) });
	/** Samples the body for `ms` after an action; `stopWhen` ends early. Rescues a body still in lava at the end (tp out, heal). */
	// Unarmed runs stop at rescueAt health (the lava has shown its cost) so the fixture never needs a death and respawn.
	const watch = async (ms, rows, rescueAt = 0) => {
		const end = Date.now() + ms; let died = false;
		while (Date.now() < end) {
			try { o = await observe(); } catch { died = true; break; }
			rows.push(sample(o));
			if (o.player?.dead || health(o) <= 0) { died = true; break; }
			if (health(o) <= rescueAt) { await rescue(); break; }
			await sleep(200);
		}
		return died;
	};
	// The fixture is built around the agent; it looks all round so its seen terrain holds the new walls and tunnel.
	const lookAround = async (pitch) => { for (const yaw of [90, 180, -90, 0]) await act('control', { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw, pitch, selectedSlot: 0, hand: 'main', ticks: 8 }); };
	const rescue = async () => { await command(`effect give ${agent} minecraft:fire_resistance 10 0 true`); await command(`effect give ${agent} minecraft:instant_health 1 5 true`); await command(`tp ${agent} 0.5 85 -6.5`); await sleep(1500); };
	const respawnIfDead = async () => {
		let dead = false;
		try { o = await observe(); dead = o.player?.dead || health(o) <= 0; } catch { dead = true; }
		if (dead) { await act('respawn', {}).catch(() => {}); await sleep(3000); }
	};

	// A 1-wide tunnel heading +z; the face block at head height hides a lava source (iron-a: breaking the tunnel face).
	const tunnel = async () => {
		await fill('-3 80 -7 3 84 4 minecraft:stone');
		await fill('0 80 -6 0 81 0 minecraft:air');
		await set('0 81 2 minecraft:lava');
		await command(`tp ${agent} 0.5 80 0.5 0 20`); await sleep(1500); await lookAround(20);
	};
	const opened = async (name, rules, rescueAt) => {
		try {
			await reset(); await tunnel();
			await give(0, 'minecraft:diamond_pickaxe'); await act('select_item', { itemId: 'minecraft:diamond_pickaxe' });
			if (rules.length) o = await setReflexes(rules);
			o = await observe(); const before = health(o);
			since = Math.max(0, ...(o.reflexes?.events ?? []).map((row) => row.seq ?? 0));
			const guard = await act('break_block', { x: 0, y: 81, z: 1, expectedBlockId: 'minecraft:stone', timeoutMs: 8000 });
			let broke = guard;
			if (guard.reasonCode === 'LAVA_BEHIND') broke = await act('break_block', { x: 0, y: 81, z: 1, expectedBlockId: 'minecraft:stone', timeoutMs: 8000, acceptLavaRisk: true });
			const rows = []; const died = await watch(12000, rows, rescueAt);
			const inLavaSamples = rows.filter((row) => row.inLava).length;
			results[name] = { healthBefore: before, minHealth: Math.min(...rows.map((row) => row.health ?? 20)), final: rows.at(-1), died, inLavaSamples,
				firstBreak: brief(guard), break: brief(broke), reflexEvents: events(o, 'lava'), rows: rows.filter((_, index) => index % 4 === 0) };
			await respawnIfDead(); if (!died) await rescue();
			await settle(name);
			return results[name];
		} catch (error) { await settle(name, error); return null; }
	};
	if (want('opened-unarmed')) {
		const result = await opened('opened-unarmed', [], 10);
		if (result) { result.pass = /lava now open/.test(result.break.message) && (result.died || result.minHealth < result.healthBefore); await settle('opened-unarmed'); }
	}
	if (want('opened-armed')) {
		const result = await opened('opened-armed', [{ id: 'lava', priority: 9, when: { type: 'in_lava' }, do: { type: 'leave_lava' }, maxS: 4, wake: true }], 0);
		if (result) { result.pass = !result.died && !result.final?.inLava && result.reflexEvents.some((row) => /out of lava/.test(row.detail ?? '')); await settle('opened-armed'); }
	}

	// Cast obsidian left on a deeper lava cell, the rest of the pool already cleared to its stone floor: standing on it
	// and breaking it drops the body into the lava under it, one block below the floor around. (A 1x1 hole through a
	// fully cast ceiling has no exit a vanilla player can climb: the lava surface is too far below the rim.)
	const pool = async () => {
		await fill('-3 79 -3 3 79 3 minecraft:air');
		await set('0 78 0 minecraft:lava');
		await set('0 79 0 minecraft:obsidian');
		await command(`tp ${agent} 0.5 80 0.5 0 60`); await sleep(1500); await lookAround(60);
	};
	const standOn = async (name, rules, rescueAt) => {
		try {
			await reset(); await pool();
			await give(0, 'minecraft:diamond_pickaxe'); await act('select_item', { itemId: 'minecraft:diamond_pickaxe' });
			if (rules.length) o = await setReflexes(rules);
			o = await observe(); const before = health(o);
			since = Math.max(0, ...(o.reflexes?.events ?? []).map((row) => row.seq ?? 0));
			const guard = await act('break_block', { x: 0, y: 79, z: 0, expectedBlockId: 'minecraft:obsidian', timeoutMs: 15000 });
			const broke = guard.reasonCode === 'LAVA_BEHIND' ? await act('break_block', { x: 0, y: 79, z: 0, expectedBlockId: 'minecraft:obsidian', timeoutMs: 15000, acceptLavaRisk: true }) : guard;
			const rows = []; const died = await watch(12000, rows, rescueAt);
			results[name] = { healthBefore: before, minHealth: Math.min(...rows.map((row) => row.health ?? 20)), final: rows.at(-1), died,
				inLavaSamples: rows.filter((row) => row.inLava).length, firstBreak: brief(guard), break: brief(broke), reflexEvents: events(o, 'lava'), rows: rows.filter((_, index) => index % 4 === 0) };
			await respawnIfDead(); if (!died) await rescue();
			await settle(name);
			return results[name];
		} catch (error) { await settle(name, error); return null; }
	};
	if (want('standon-unarmed')) {
		const result = await standOn('standon-unarmed', [], 10);
		if (result) { result.pass = result.break.state === 'SUCCEEDED' && result.inLavaSamples > 0 && (result.died || result.minHealth < result.healthBefore); await settle('standon-unarmed'); }
	}
	if (want('standon-armed')) {
		const result = await standOn('standon-armed', [{ id: 'lava', priority: 9, when: { type: 'in_lava' }, do: { type: 'leave_lava' }, maxS: 6, wake: true }], 0);
		if (result) { result.pass = result.break.state === 'SUCCEEDED' && !result.died && !result.final?.inLava && result.reflexEvents.some((row) => /out of lava/.test(row.detail ?? '')); await settle('standon-armed'); }
	}

	// The safe setup: from dry ground two cells away, pour water beside the pool so it runs onto the lava, take it back,
	// then mine the cast obsidian from the side; a second source under it shows in the break result, not under the feet.
	if (want('cast-safe')) {
		const name = 'cast-safe';
		try {
			await reset();
			// The stand is one block up, so the poured water runs past below the feet instead of pushing the body.
			await set('3 78 0 minecraft:lava'); await set('3 79 0 minecraft:lava'); await set('1 80 0 minecraft:stone');
			await command(`tp ${agent} 1.5 81 0.5 -90 40`); await sleep(1500); await lookAround(40);
			await act('control', { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: -90, pitch: 40, selectedSlot: 0, hand: 'main', ticks: 8 });
			await give(0, 'minecraft:diamond_pickaxe'); await give(1, 'minecraft:water_bucket');
			o = await observe(); const before = health(o);
			await act('select_item', { itemId: 'minecraft:water_bucket' });
			const pour = await act('interact_block', { x: 2, y: 79, z: 0, face: 'up', hand: 'main', expectedItemId: 'minecraft:water_bucket' });
			await sleep(2500);
			const cast = await isBlock(3, 79, 0, 'minecraft:obsidian');
			const scoop = await act('interact_block', { x: 2, y: 80, z: 0, face: 'up', hand: 'main', expectedItemId: 'minecraft:bucket' });
			await sleep(1500);
			await act('select_item', { itemId: 'minecraft:diamond_pickaxe' });
			const mined = await act('break_block', { x: 3, y: 79, z: 0, expectedBlockId: 'minecraft:obsidian', timeoutMs: 15000 });
			const rows = []; await watch(4000, rows);
			results[name] = { healthBefore: before, minHealth: Math.min(...rows.map((row) => row.health ?? 20)), final: rows.at(-1), cast,
				pour: brief(pour), scoop: brief(scoop), mine: brief(mined), inLavaSamples: rows.filter((row) => row.inLava).length };
			results[name].pass = cast && mined.state === 'SUCCEEDED' && /lava now open below/.test(mined.message ?? '') && results[name].inLavaSamples === 0 && results[name].minHealth >= before;
			await settle(name);
		} catch (error) { await settle(name, error); }
	}
	results.status = o?.reflexes;
	await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
	await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
	console.log(JSON.stringify(Object.fromEntries(Object.entries(results).filter(([key]) => key !== 'status').map(([key, value]) => [key, value.pass]))));
	const failed = Object.entries(results).filter(([key, value]) => key !== 'status' && !value.pass).map(([key]) => key);
	if (failed.length > 0) { console.log(JSON.stringify(results, null, 2)); process.exitCode = 1; }
	else console.log('Lava work mechanics verified');
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
