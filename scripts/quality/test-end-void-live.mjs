#!/usr/bin/env node
// Provider-free check of End void edges. Live End runs died by "fell out of the world": d6-end-a (build 5694ee19) had a
// dragon-fireball sprint_away reflex run the body 8.4 blocks east to an island rim, then the model's raw 20-tick sprint,
// authored from the old position, ran it over the rim. Checks: 1) rim: the same fireball, reflex and stale sprint on a
// 21x21 end-stone island; 2) platform: the same on the vanilla 5x5 spawn platform at 100,48,0; 3) a raw sprint and a
// control_sequence frame off the platform stop with VOID_EDGE, a sneaking walk stays on (vanilla) and a stale sprint
// after the reflex never falls. ARENA_JAR selects the jar (old vs new). Launch under slot.sh live.
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
const out = resolve(process.argv[2] ?? 'runtime/end-void-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true, jarSha256: createHash('sha256').update(await readFile(jarPath)).digest('hex'), node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
await cp(jarPath, join(server, 'mods/arena-agents-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261017\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=normal\n`);
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
let rcon, bridge, record, observation, inbox, ordinal = 0, revision = 0;
const agent = 'Rim';
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
const end = s => command(`execute in minecraft:the_end run ${s}`);
async function observe() { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }); return (await next).payload; }
async function act(type, args) {
	const id = `void-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'end-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const next = inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000);
	await bridge.send('action_command', record.agentId, payload);
	const r = (await next).payload;
	await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision });
	return r;
}
async function setReflexes(rules) {
	revision += 1;
	await bridge.send('reflex_update', record.agentId, { revision, rules: normalizeReflexEntries(rules), yield: false });
	for (let i = 0; i < 40; i++) { const o = await observe(); if (o.reflexes?.revision === revision) return o; await sleep(100); }
	throw new Error(`reflex revision ${revision} never echoed`);
}
const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(text.trim()) ?? [])[1]);
const health = async () => number(await command(`data get entity ${agent} Health`));
const results = {};
const frame = (over) => ({ forward: 1, strafe: 0, jump: false, sneak: false, sprint: true, attack: false, use: false, yaw: -90, pitch: 10, selectedSlot: 0, hand: 'main', ...over });
const pos = async () => { const o = await observe(); return { x: Math.round(o.position.x * 100) / 100, y: Math.round(o.position.y * 100) / 100, z: Math.round(o.position.z * 100) / 100, dead: o.player?.dead ?? null }; };
const clearMobs = async () => { await end('kill @e[type=minecraft:ender_dragon]'); await end('kill @e[type=minecraft:enderman]'); await end('kill @e[type=minecraft:area_effect_cloud]'); await end('kill @e[type=minecraft:dragon_fireball]'); };
const fireballEvents = (o) => (o.reflexes?.events ?? []).filter(e => e.id === 'end-fireball').map(e => `${e.outcome}: ${e.detail}`);
/** Arms the d6-end-a reflex, sends a dragon fireball at the body from the west, waits out the firing, then the model's stale sprint east. */
async function fireballThenSprint(spawn, from) {
	await clearMobs();
	await end(`tp ${agent} ${spawn.join(' ')} 90 10`); await sleep(1500);
	await command(`effect give ${agent} minecraft:instant_health 1 5 true`);
	await setReflexes([{ id: 'end-fireball', kind: 'trigger', priority: 9, when: { type: 'fireball_incoming', withinS: 2 }, do: { type: 'sprint_away', blocks: 8 }, ttlS: 600 }]);
	const start = await pos();
	await end(`summon minecraft:dragon_fireball ${from.join(' ')} {Motion:[0.6d,0.0d,0.0d],acceleration_power:0.05d}`);
	let o, events = [];
	for (let i = 0; i < 60 && events.length === 0; i++) { await sleep(150); o = await observe(); events = fireballEvents(o); }
	await sleep(800);
	const afterReflex = await pos();
	const sprint = await act('control', frame({ ticks: 20 }));
	await sleep(1500);
	const final = await pos();
	await setReflexes([]);
	return { start, reflex: events, afterReflex, sprint: { reasonCode: sprint.reasonCode, message: sprint.message }, final };
}
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) observation = e.payload; });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free End void fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('forceload add -16 -16 16 16'); await sleep(2000);
	await command('fill -4 80 -4 4 80 4 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 81 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	await command(`effect give ${agent} minecraft:saturation 1200 4 true`);
	await command(`effect give ${agent} minecraft:resistance 1200 4 true`);
	await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`);
	// Fixtures in the End: a 21x21 end-stone island far south of the main island, and the vanilla spawn platform.
	await end('forceload add -32 268 32 332'); await end('forceload add 80 -16 112 16'); await sleep(2000);
	await end('fill -10 56 290 10 56 310 minecraft:end_stone'); await end('fill -10 57 290 10 60 310 minecraft:air');
	await end('fill 98 48 -2 102 48 2 minecraft:obsidian'); await end('fill 98 49 -2 102 52 2 minecraft:air');
	const onPlatform = p => p.y >= 48.9 && p.x > 97.7 && p.x < 103.3 && p.z > -2.3 && p.z < 3.3;
	const onRim = p => p.y >= 56.9 && p.x > -10.3 && p.x < 11.3 && p.z > 289.7 && p.z < 311.3;
	const back = async () => { await end(`tp ${agent} 100.5 49 0.5 90 10`); await sleep(1200); };

	// 1. Rim (d6-end-a replica): the body 8 blocks from the east rim, the fireball from the west.
	results.rim = await fireballThenSprint([2.5, 57, 300.5], [-12.5, 58.6, 300.5]);
	results.rim.onIsland = onRim(results.rim.final);
	await back();
	// 2. The same on the vanilla spawn platform.
	results.platform = await fireballThenSprint([100.5, 49, 0.5], [88.5, 50.6, 0.5]);
	results.platform.onPlatform = onPlatform(results.platform.final);
	await back();
	// 3. Raw frames from the platform centre: a sprint east, a control_sequence frame east, a sneaking walk east.
	{
		const sprint = await act('control', frame({ ticks: 20 })); await sleep(1500);
		results.sprint = { reasonCode: sprint.reasonCode, message: sprint.message, final: await pos() };
		results.sprint.onPlatform = onPlatform(results.sprint.final);
		await back();
		const sequence = await act('control_sequence', { maxTicks: 40, frames: [frame({ ticks: 20, yaw: 0 }), frame({ ticks: 20 })] }); await sleep(1500);
		results.sequence = { reasonCode: sequence.reasonCode, message: sequence.message, final: await pos() };
		results.sequence.onPlatform = onPlatform(results.sequence.final);
		await back();
		const sneak = await act('control', frame({ ticks: 40, sneak: true, sprint: false })); await sleep(1000);
		results.sneak = { reasonCode: sneak.reasonCode, final: await pos() };
		results.sneak.onPlatform = onPlatform(results.sneak.final);
		await back();
		const jump = await act('control', frame({ ticks: 4, jump: true, sprint: false, forward: 0 })); await sleep(1000);
		results.jumpInPlace = { reasonCode: jump.reasonCode, final: await pos() };
	}
	// 4. Water clutch at an island rim (d6-end-b: the placed source's flow carried the landed body off the rim).
	{
		await clearMobs();
		await command(`item replace entity ${agent} hotbar.3 with minecraft:water_bucket`);
		await setReflexes([{ id: 'end-fall', kind: 'trigger', priority: 8, when: { type: 'falling', blocks: 4 }, do: { type: 'place', item: 'minecraft:water_bucket', where: 'below' }, ttlS: 600 }]);
		await end(`tp ${agent} 10.5 66 300.5 -90 30`);
		let o, events = [];
		for (let i = 0; i < 60; i++) { await sleep(150); o = await observe(); events = (o.reflexes?.events ?? []).filter(e => e.id === 'end-fall').map(e => `${e.outcome}: ${e.detail}`); if (events.length && o.player?.onGround) break; }
		await sleep(4000);
		const final = await pos();
		const water = (await end('execute if block 10 57 300 minecraft:water')).includes('passed');
		results.clutchEdge = { reflex: events, final, onIsland: onRim(final), waterLeft: water, bucket: (await command(`data get entity ${agent} Inventory[{Slot:3b}].id`)).trim() };
		await end('fill -10 57 290 10 60 310 minecraft:air'); await setReflexes([]);
	}
	results.summary = {
		clutchEdgeOnIsland: results.clutchEdge.onIsland, clutchEdgeReflex: results.clutchEdge.reflex, clutchEdgeWaterLeft: results.clutchEdge.waterLeft,
		rimOnIsland: results.rim.onIsland, rimSprint: results.rim.sprint.reasonCode, rimReflex: results.rim.reflex,
		platformOnPlatform: results.platform.onPlatform, platformSprint: results.platform.sprint.reasonCode, platformReflex: results.platform.reflex,
		sprintStopped: results.sprint.reasonCode, sprintOnPlatform: results.sprint.onPlatform,
		sequenceStopped: results.sequence.reasonCode, sequenceOnPlatform: results.sequence.onPlatform,
		sneakOnPlatform: results.sneak.onPlatform, sneakResult: results.sneak.reasonCode, jar: jarPath,
	};
	await writeFile(join(out, 'end-void.json'), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results, null, 2));
} finally {
	await writeFile(join(out, 'end-void.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
