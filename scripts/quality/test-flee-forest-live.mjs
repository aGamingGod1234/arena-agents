#!/usr/bin/env node
// Provider-free check of flee_from speed in a real forest: this script stands in for the coordinator and sends the
// production flee_from action from several forest spots, a zombie a few blocks away on each side, then reports the
// body's ground speed, sprint share and outcome. A vanilla player sprints about 5.6 m/s and outruns a zombie.
// The world is a copy of a saved run world (FLEE_WORLD, read only): the forest where game d2b-iron-c died to a
// zombie at the respawn point. Always launch under slot.sh live; ports come from SLOT_PORT_BASE.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/flee-forest-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
const world = process.env.FLEE_WORLD;
if (!template || !world || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE, FLEE_WORLD and launch under slot.sh live');
const jar = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	world, jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
await cp(jar, join(server, 'mods/arena-agents-0.2.0.jar'));
// Terrain only: no saved players, entities or lock from the source run.
await cp(world, join(server, 'world'), { recursive: true, filter: (path) => !/[\\/](players|entities)([\\/]|$)|session\.lock$/.test(path.slice(world.length)) });
await rm(join(server, 'world', 'session.lock'), { force: true });
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=false\n`);
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

let rcon, bridge, record, observation, inbox, ordinal = 0;
const agent = 'Flee';
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
function startAction(type, args) {
	const id = `flee-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'flee-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const result = inbox.wait('action_result', (event) => event.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(event.payload.state), 90000)
		.then(async (event) => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return event.payload; });
	return bridge.send('action_command', record.agentId, payload).then(() => ({ id, result }));
}

// Spots where d2b-iron-c respawned or died in the forest, and the zombie's side (dx, dz) at 4 blocks.
const spots = [[9.5, 90.5], [10.5, 92.5], [16.5, 80.5], [24.5, 79.5], [26.5, 86.5], [15.5, 88.5]];
const sides = [[4, 0], [-4, 0], [0, 4], [0, -4]];
const fresh = process.env.FLEE_FRESH !== '0';
const only = (process.env.FLEE_ONLY ?? '').split(',').filter(Boolean).map(Number);
const flees = [];
try {
	for (let attempt = 0; attempt < 150; attempt += 1) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (error) { await rcon?.close(); if (attempt === 149) throw error; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', (event) => { if (event.agentId === record?.agentId && event.payload.ready) observation = event.payload; });
	bridge.on('message', (event) => {
		const registered = ['agent_registered', 'registry_entry'].includes(event.type) ? { goalRevision: event.payload.goalRevision ?? event.payload.record?.goalRevision, operation: 'registered' } : null;
		const control = registered ?? (event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null);
		if (control == null || event.agentId !== record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= record.goalRevision) return;
		if (['queue', 'dequeue'].includes(control.operation)) return;
		record.goalRevision = control.goalRevision;
		bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	});
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled live flee fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free flee fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] });
	await command('difficulty normal'); await command('gamerule minecraft:send_command_feedback false'); await command('gamerule minecraft:spawn_mobs false');
	await command('time set midnight'); await command('gamerule minecraft:advance_time false'); await command('forceload add -48 32 80 160'); await sleep(3000);
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 9.5 72 90.5 run codex summon gpt-6.1-sol low ${agent}`));
	const summoned = await registered; record = { ...(summoned.payload.record ?? summoned.payload), agentId: summoned.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', (event) => event.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await sleep(2000); await observe();
	await command(`gamemode survival ${agent}`); await command(`clear ${agent}`);

	const repeat = Number(process.env.FLEE_REPEAT ?? 1);
	let run = 0;
	for (let pass = 0; pass < repeat; pass += 1) {
	let index = 0;
	for (const [sx, sz] of spots) {
		for (const [dx, dz] of sides) {
			index += 1;
			if (only.length && !only.includes(index)) continue;
			run += 1;
			const uuid = `00000001-0000-0002-0000-0003${run.toString(16).padStart(8, '0')}`;
			await command('kill @e[type=minecraft:zombie]');
			await command(`effect give ${agent} minecraft:instant_health 1 5 true`); await command(`effect give ${agent} minecraft:saturation 2 10 true`);
			await command(`effect give ${agent} minecraft:resistance 30 4 true`);
			// Face the zombie, as a player who has just seen it.
			const yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
			// As after a respawn the body knows no terrain: a dimension change empties its seen-terrain memory.
			if (fresh) { await command(`execute in minecraft:the_nether run tp ${agent} 0.5 140 0.5`); await sleep(1500); }
			await command(`execute in minecraft:overworld positioned ${sx} 0 ${sz} positioned over motion_blocking_no_leaves run tp ${agent} ~ ~ ~ ${yaw.toFixed(1)} 0`);
			await sleep(1500);
			await command(`execute positioned ${sx + dx} 0 ${sz + dz} positioned over motion_blocking_no_leaves run summon minecraft:zombie ~ ~ ~ {UUID:[I;1,2,3,${run}],IsBaby:0b,PersistenceRequired:1b,CanPickUpLoot:0b}`);
			let o = null;
			for (let wait = 0; wait < 20; wait += 1) { o = await observe(); if ((o.entities ?? []).some((entity) => entity.uuid === uuid || entity.stableId === uuid)) break; await sleep(100); }
			const start = o.position ?? { x: o.player.x, y: o.player.y, z: o.player.z };
			if (index === (only[0] ?? 1)) await writeFile(join(out, 'observation.json'), JSON.stringify(o, null, 1));
			const t0 = Date.now();
			const flee = await startAction('flee_from', { targetId: uuid, distance: 24, timeoutMs: 8000 });
			const samples = [];
			let done = null;
			flee.result.then((result) => { done = result; });
			while (done == null && Date.now() - t0 < 20000) {
				const now = await observe();
				const p = now.position ?? now.player;
				const z = (now.entities ?? []).find((entity) => entity.uuid === uuid || entity.stableId === uuid);
				samples.push({ t: Date.now() - t0, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), sprinting: now.player?.sprinting, collision: now.player?.horizontalCollision,
					onGround: now.player?.onGround, health: now.player?.health, zombie: z?.position ? +Math.hypot(z.position.x - p.x, z.position.z - p.z).toFixed(1) : null, yaw: now.view?.yaw == null ? null : +now.view.yaw.toFixed(0) });
				await sleep(100);
			}
			const result = await flee.result;
			const last = samples.at(-1) ?? start;
			const net = Math.hypot(last.x - start.x, last.z - start.z);
			let path = 0; for (let i = 1; i < samples.length; i += 1) path += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
			const seconds = (last.t ?? 0) / 1000;
			const row = { index, run, spot: [sx, sz], side: [dx, dz], state: result.state, reasonCode: result.reasonCode, message: result.message, seconds,
				netMps: seconds > 0 ? +(net / seconds).toFixed(2) : 0, pathMps: seconds > 0 ? +(path / seconds).toFixed(2) : 0,
				sprintShare: samples.length ? +(samples.filter((row) => row.sprinting).length / samples.length).toFixed(2) : 0,
				collisionShare: samples.length ? +(samples.filter((row) => row.collision).length / samples.length).toFixed(2) : 0,
				minZombie: Math.min(...samples.map((row) => row.zombie ?? 99)), samples };
			flees.push(row);
			console.log(`[flee ${index}#${run}] spot ${sx},${sz} side ${dx},${dz}: ${result.reasonCode} net ${row.netMps} m/s path ${row.pathMps} m/s sprint ${row.sprintShare} collide ${row.collisionShare} minZombie ${row.minZombie} | ${String(result.message).slice(0, 220)}`);
			await writeFile(join(out, 'flees.json'), JSON.stringify(flees, null, 1));
		}
	}
	}
	const moving = flees.filter((row) => row.reasonCode !== 'TARGET_NOT_VISIBLE');
	const mean = (rows, key) => rows.length ? +(rows.reduce((sum, row) => sum + row[key], 0) / rows.length).toFixed(2) : 0;
	const summary = { flees: flees.length, meanNetMps: mean(moving, 'netMps'), meanPathMps: mean(moving, 'pathMps'), meanSprintShare: mean(moving, 'sprintShare'),
		slow: moving.filter((row) => row.netMps < 3.5).map((row) => row.index), outcomes: Object.fromEntries([...new Set(flees.map((row) => row.reasonCode))].map((code) => [code, flees.filter((row) => row.reasonCode === code).length])) };
	await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary));
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
