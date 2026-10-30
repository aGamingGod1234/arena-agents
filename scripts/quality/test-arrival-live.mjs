#!/usr/bin/env node
// Provider-free check of the first seconds after a Nether arrival (d14-iron-e, 2026-10-21: 55 s after its portal
// entry the agent walked into a pit under a lava fall and died; the arrival wake never reached the model). The
// terrain is the real one: the run's seed regenerates the Nether there. This script stands in for the coordinator:
// operator commands only place the body and keep it alive; the agent's own navigate_to and control do the moving.
// Scenarios (ARRIVAL_ONLY=a,b): dump (the blocks around the pit; with its default 4 s wait it also leaves the seen
// terrain the run had, so a following pit reproduces the run's legs exactly), pit (the run's three navigate_to legs
// from the portal), pitleg (the last leg alone), pillar[-unarmed|-armed] (the run's jump-and-place under the lava fall,
// with and without in_lava -> leave_lava; a measurement). Always launch under slot.sh live, e.g.
// ARRIVAL_ONLY=dump,pit,pillar slot.sh live node scripts/quality/test-arrival-live.mjs <fresh dir>.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/arrival-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const jar = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
// The seed of the iron-pickaxe-morning save point every d13/d14 iron game ran on.
const SEED = '-8891462362762682724';
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), node: process.version, seed: SEED }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
await cp(jar, join(server, 'mods/arena-agents-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=${SEED}\nspawn-protection=0\nview-distance=5\nsimulation-distance=5\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=false\n`);
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

let rcon, bridge, record, observation, inbox, ordinal = 0, revision = 0;
const agent = 'Arrive';
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
	const id = `arrival-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'arrival-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const result = inbox.wait('action_result', (event) => event.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(event.payload.state), 90000)
		.then(async (event) => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return event.payload; });
	return bridge.send('action_command', record.agentId, payload).then(() => ({ id, result }));
}
const results = {};
const only = (process.env.ARRIVAL_ONLY ?? '').split(',').filter(Boolean);
const want = (name) => only.length === 0 || only.includes(name);
const nether = (text) => command(`execute in minecraft:the_nether run ${text}`);
const act = async (type, args) => (await startAction(type, args)).result;
const brief = (result) => ({ state: result.state, reason: result.reasonCode, message: String(result.message ?? JSON.stringify(result.failure ?? '')).slice(0, 500), travel: result.travel ?? null });
const settle = async (name, error) => {
	if (error) results[name] = { ...(results[name] ?? {}), pass: false, error: String(error?.stack ?? error).slice(0, 600) };
	await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
	console.log(`[scenario] ${name}: ${results[name]?.pass ? 'PASS' : 'FAIL'}`);
};
try {
	for (let attempt = 0; attempt < 300; attempt += 1) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (error) { await rcon?.close(); if (attempt === 299) throw error; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', (event) => { if (event.agentId === record?.agentId && event.payload.ready) observation = event.payload; });
	bridge.on('message', (event) => {
		if (!['observation', 'action_progress', 'heartbeat'].includes(event.type)) console.log(`[in] ${event.type} ${JSON.stringify(event.payload).slice(0, 160)}`);
		const registered = ['agent_registered', 'registry_entry'].includes(event.type) ? { goalRevision: event.payload.goalRevision ?? event.payload.record?.goalRevision, operation: 'registered' } : null;
		const control = registered ?? (event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null);
		if (control == null || event.agentId !== record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= record.goalRevision) return;
		if (['queue', 'dequeue'].includes(control.operation)) return;
		record.goalRevision = control.goalRevision;
		bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	});
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled live arrival fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free arrival fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] });
	await command('difficulty peaceful'); await command('gamerule minecraft:send_command_feedback false'); await command('gamerule minecraft:spawn_mobs false');
	await command('time set noon'); await nether('forceload add -16 -32 48 48'); await sleep(3000);
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 120 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const summoned = await registered; record = { ...(summoned.payload.record ?? summoned.payload), agentId: summoned.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', (event) => event.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await sleep(2000); await observe();
	await command(`gamemode survival ${agent}`); await command(`clear ${agent}`);
	const keepAlive = async () => { await command(`effect give ${agent} minecraft:fire_resistance 60 0 true`); await command(`effect give ${agent} minecraft:saturation 60 10 true`); await command(`effect give ${agent} minecraft:regeneration 60 4 true`); };
	const look = async (yaws, pitch) => { for (const yaw of yaws) await act('control', { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw, pitch, selectedSlot: 0, hand: 'main', ticks: 6 }); };

	if (want('dump')) {
		const name = 'dump';
		try {
			const ids = ['minecraft:air', 'minecraft:cave_air', 'minecraft:lava', 'minecraft:netherrack', 'minecraft:soul_sand', 'minecraft:magma_block', 'minecraft:gravel', 'minecraft:nether_quartz_ore', 'minecraft:nether_gold_ore', 'minecraft:obsidian', 'minecraft:nether_portal'];
			const glyph = { 'minecraft:air': '.', 'minecraft:cave_air': '.', 'minecraft:lava': 'L', 'minecraft:netherrack': '#', 'minecraft:soul_sand': 's', 'minecraft:magma_block': 'm', 'minecraft:gravel': 'g', 'minecraft:nether_quartz_ore': 'q', 'minecraft:nether_gold_ore': 'o', 'minecraft:obsidian': 'O', 'minecraft:nether_portal': 'P' };
			await command(`execute in minecraft:the_nether run tp ${agent} 16.5 50 0.5`);
			// Springs flow once their chunk ticks: give falls time to reach the floor, as they had in the run.
			await sleep(Number(process.env.ARRIVAL_DUMP_WAIT_MS ?? 4000));
			const layers = {};
			const [y0, y1] = (process.env.ARRIVAL_DUMP_Y ?? '29,40').split(',').map(Number);
			for (let y = y0; y <= y1; y += 1) {
				const rows = [];
				for (let z = -6; z <= 8; z += 1) {
					let row = '';
					for (let x = 10; x <= 26; x += 1) {
						let mark = '?';
						for (const id of ids) if ((await nether(`execute if block ${x} ${y} ${z} ${id}`)).includes('passed')) { mark = glyph[id]; break; }
						row += mark;
					}
					rows.push(`z=${String(z).padStart(3)} ${row}`);
				}
				layers[y] = rows;
			}
			results[name] = { legend: 'x 10..26 left to right; . air, L lava, # netherrack, s soul sand, m magma, g gravel, q/o ores, ? other', layers, pass: true };
			await settle(name);
		} catch (error) { await settle(name, error); }
	}

	// d14-iron-e: from 10.5,37,22.5 beside its portal, navigate_to 24,38,-3 (an exploreFrontier "seen_surface" candidate),
	// then 23.5,39,-2.5, then 16.5,38,1.5. The run's third leg descended 3 into 17,33,0 under falling lava.
	if (want('pit')) {
		const name = 'pit';
		try {
			await keepAlive();
			await command(`execute in minecraft:the_nether run tp ${agent} 10.5 37 22.5 180 10`);
			// The run walked these legs ~45 s after arriving: the spring's lava fall had reached the pit by then.
			await sleep(Number(process.env.ARRIVAL_PIT_WAIT_MS ?? 40000));
			await look([-145, 180, 135, 90, 0, -90], 10);
			const legs = [];
			const track = [];
			const sampler = setInterval(() => { if (observation?.position) track.push({ x: observation.position.x, y: observation.position.y, z: observation.position.z, health: observation.player?.health, inLava: observation.player?.inLava === true }); }, 250);
			for (const target of [{ x: 24, y: 38, z: -3, tolerance: 0.5, sprint: true }, { x: 23.5, y: 39, z: -2.5, tolerance: 0.3, sprint: true }, { x: 16.5, y: 38, z: 1.5, tolerance: 0.3, sprint: false }]) {
				const result = await act('navigate_to', { ...target, timeoutMs: 30000 });
				{ const now = await observe(); legs.push({ target, result: brief(result), at: now.position, inLava: now.player?.inLava === true, footing: now.player?.footing ?? null }); }
			}
			clearInterval(sampler);
			const low = Math.min(...track.map((row) => row.y));
			results[name] = { legs, lowestY: low, inLavaSamples: track.filter((row) => row.inLava).length, track: track.filter((_, index) => index % 4 === 0) };
			// The run reached 17.8,32.9,0.6 (a pit under falling lava). Passing means no leg ends below y35 beside that fall.
			results[name].pass = results[name].inLavaSamples === 0 && !legs.some((leg) => leg.at && leg.at.y < 34 && Math.abs(leg.at.x - 17.5) < 2 && Math.abs(leg.at.z - 0.5) < 2);
			await settle(name);
		} catch (error) { await settle(name, error); }
	}
	// The deciding leg alone, from where the run's second leg stopped (16.34,36,0.11, a 5-block drop into the lava sea
	// beside it): navigate_to 16.5,38,1.5. The run's navigator descended 3 into the pit at 17,33,0 under the lava fall.
	if (want('pitleg')) {
		const name = 'pitleg';
		try {
			await command(`effect give ${agent} minecraft:fire_resistance 120 0 true`);
			await command(`execute in minecraft:the_nether run tp ${agent} 16.34 36 0.11 122 30`);
			await sleep(Number(process.env.ARRIVAL_PIT_WAIT_MS ?? 40000));
			await look([122, 55, -10, -90, 180], 30);
			const result = await act('navigate_to', { x: 16.5, y: 38, z: 1.5, tolerance: 0.3, sprint: false, timeoutMs: 30000 });
			const now = await observe();
			const lavaAbove = (await nether('execute if block 17 35 0 minecraft:lava')).includes('passed');
			results[name] = { result: brief(result), at: now.position, lavaAbove };
			results[name].pass = !(now.position.y < 34 && Math.abs(now.position.x - 17.5) < 1.5 && Math.abs(now.position.z - 0.5) < 1.5);
			await settle(name);
		} catch (error) { await settle(name, error); }
	}

	// d14-iron-e's last move: standing in that pit, jump and place a block under the feet (a pillar) with the lava fall
	// right above the head. Armed (in_lava -> leave_lava, as the run had it) and unarmed; fire resistance off.
	const setReflexes = async (rules) => {
		revision += 1;
		await bridge.send('reflex_update', record.agentId, { revision, rules: normalizeReflexEntries(rules), yield: false });
		for (let index = 0; index < 40; index += 1) { const now = await observe(); if (now.reflexes?.revision === revision) return now; await sleep(100); }
		throw new Error(`reflex revision ${revision} never echoed`);
	};
	for (const armed of [false, true]) {
		const name = armed ? 'pillar-armed' : 'pillar-unarmed';
		if (!want(name) && !want('pillar')) continue;
		try {
			// Fire resistance holds while the spring's fall reaches the pit; it is cleared just before the move.
			await command(`effect give ${agent} minecraft:fire_resistance 120 0 true`); await command(`effect give ${agent} minecraft:instant_health 1 5 true`);
			await command(`execute in minecraft:the_nether run tp ${agent} 17.8 32.875 0.6 55 80`);
			let lavaAbove = false;
			for (let waited = 0; waited < 90 && !lavaAbove; waited += 1) { lavaAbove = (await nether('execute if block 17 35 0 minecraft:lava')).includes('passed'); if (!lavaAbove) await sleep(1000); }
			const pitLava = { head: (await nether('execute if block 17 34 0 minecraft:lava')).includes('passed'), feet: (await nether('execute if block 17 33 0 minecraft:lava')).includes('passed') };
			await command(`item replace entity ${agent} hotbar.7 with minecraft:cobblestone 16`);
			await setReflexes(armed ? [{ id: 'lava', priority: 9, when: { type: 'in_lava' }, do: { type: 'leave_lava' }, maxS: 5, wake: true }] : []);
			await command(`execute in minecraft:the_nether run tp ${agent} 17.8 32.875 0.6 55 80`);
			const before = await observe();
			await command(`effect clear ${agent}`); await command(`effect give ${agent} minecraft:instant_health 1 5 true`);
			const since = Math.max(0, ...(before.reflexes?.events ?? []).map((row) => row.seq ?? 0));
			await act('control', { forward: 0, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false, yaw: 55, pitch: 80, selectedSlot: 7, hand: 'main', ticks: 7 });
			const place = await act('place_block', { x: 17, y: 33, z: 0, face: 'up', itemId: 'minecraft:cobblestone' }).catch((error) => ({ state: 'ERROR', message: String(error) }));
			const rows = []; let died = false; let rescued = false; const end = Date.now() + 10000;
			while (Date.now() < end) {
				let now; try { now = await observe(); } catch { died = true; break; }
				rows.push({ t: Date.now(), health: now.player?.health, inLava: now.player?.inLava === true, y: now.position?.y, firing: now.reflexes?.firing?.id ?? null });
				if (now.player?.dead || now.player?.health <= 0) { died = true; break; }
				if (now.player?.health <= 6) { await command(`effect give ${agent} minecraft:fire_resistance 30 0 true`); await command(`effect give ${agent} minecraft:instant_health 1 5 true`); await command(`execute in minecraft:the_nether run tp ${agent} 10.5 37 22.5`); rescued = true; break; }
				await sleep(200);
			}
			const last = await observe().catch(() => null);
			const events = (last?.reflexes?.events ?? []).filter((row) => row.id === 'lava' && (row.seq ?? 0) > since);
			results[name] = { lavaAbove, pitLava, place: brief(place), minHealth: Math.min(...rows.map((row) => row.health ?? 20)), inLavaSamples: rows.filter((row) => row.inLava).length, died, rescuedAt6: rescued, reflexEvents: events, rows };
			// Measurement only: pass means the fixture reproduced the lava over the pit.
			results[name].pass = lavaAbove;
			if (died) { await act('respawn', {}).catch(() => {}); await sleep(3000); }
			await command(`effect give ${agent} minecraft:fire_resistance 30 0 true`);
			await settle(name);
		} catch (error) { await settle(name, error); }
	}
	console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.pass]))));
	if (Object.values(results).some((value) => !value.pass)) process.exitCode = 1;
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(15000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
