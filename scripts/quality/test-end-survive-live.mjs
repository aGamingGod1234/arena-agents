#!/usr/bin/env node
// Provider-free check of End survival body and facts. End runs 2026-10-20 (build 62ac775e) died to dragon knockback
// falls of 19-26 blocks (2) and a crystal shot from 2.6 blocks (its blast threw the player off a pillar); no run ever
// armed a water-bucket fall reflex. Checks: 1) falling -> place water_bucket below lands a 25-block sprint off a
// pillar and a 45-block drop without damage (a 12-block fall without it is the control); 2) a crystal row's
// blastDamageIfBroken matches the health a real break takes; 3) footing facts over the End void say void.
// ARENA_JAR selects the jar (old vs new). Always launch under slot.sh live; operator commands build fixtures only.
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
const out = resolve(process.argv[2] ?? 'runtime/end-survive-live');
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
const agent = 'Lander';
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
const end = s => command(`execute in minecraft:the_end run ${s}`);
async function observe() { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }); return (await next).payload; }
async function act(type, args) {
	const id = `end-${++ordinal}`;
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
const results = { clutch: {}, crystal: {}, void: {} };
/** Land after a fall (or time out): health lost, final y, whether water is under the feet, reflex reports. */
async function landing(before, ms = 8000) {
	const deadline = Date.now() + ms;
	let o;
	await sleep(600);
	while (Date.now() < deadline) { o = await observe(); if (o.player?.onGround || o.player?.inWater) break; await sleep(100); }
	await sleep(1500);
	o = await observe();
	return { lost: Math.round((before - await health()) * 10) / 10, y: o.position?.y, inWater: o.player?.inWater ?? null, reports: (o.reflexes?.events ?? []).filter(e => e.id === 'mlg').map(e => `${e.outcome}: ${e.detail}`) };
}
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) observation = e.payload; });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free End fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('forceload add -32 -32 32 32'); await sleep(2000);
	await command('fill -16 80 -16 16 80 16 minecraft:stone'); await command('fill -16 81 -16 16 130 16 minecraft:air');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 81 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	await command(`effect give ${agent} minecraft:saturation 1200 4 true`);
	await command(`item replace entity ${agent} armor.head with minecraft:iron_helmet`);
	await command(`item replace entity ${agent} armor.chest with minecraft:iron_chestplate`);
	await command(`item replace entity ${agent} armor.legs with minecraft:iron_leggings`);
	await command(`item replace entity ${agent} armor.feet with minecraft:iron_boots`);
	await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`);
	const kit = async () => { await command(`item replace entity ${agent} hotbar.3 with minecraft:water_bucket`); await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`); await command(`fill -16 81 -16 16 81 16 minecraft:air replace minecraft:water`); };
	const heal = async () => { await command(`effect give ${agent} minecraft:instant_health 1 5 true`); await sleep(600); };
	// A 1x1 stone pillar whose top is `top`; the agent stands on it facing +x, then sprints 0.75 s off its edge.
	const sprintOff = async (top) => {
		await command(`fill 0 81 0 0 ${top} 0 minecraft:stone`);
		await command(`tp ${agent} 0.5 ${top + 1} 0.5 -90 20`); await sleep(1200);
		await heal(); const before = await health();
		await act('control', { forward: 1, strafe: 0, jump: false, sneak: false, sprint: true, attack: false, use: false, yaw: -90, pitch: 20, selectedSlot: 0, hand: 'main', ticks: 15 });
		const landed = await landing(before);
		await command(`fill 0 81 0 0 ${top} 0 minecraft:air`);
		return { top, fall: top - 80, ...landed };
	};

	// 1. Fall clutch.
	await kit();
	await setReflexes([]);
	results.clutch.control12 = await sprintOff(92);
	await kit();
	await setReflexes([{ id: 'mlg', kind: 'trigger', priority: 9, when: { type: 'falling', blocks: 4 }, do: { type: 'place', item: 'minecraft:water_bucket', where: 'below' }, ttlS: 600 }]);
	results.clutch.sprint25 = await sprintOff(105);
	await kit();
	{
		await command(`tp ${agent} 3.5 125 3.5 0 30`); await heal(); const before = await health();
		results.clutch.drop45 = { fall: 45, ...await landing(before, 10000) };
	}
	await setReflexes([]);

	// 2. Crystal blast: rows at 3, 9.5 and 11.5 blocks; break the 9.5-block one as the agent and compare (7 blocks would kill).
	await command(`tp ${agent} 0.5 81 0.5 -90 0`); await heal(); await sleep(800);
	for (const [x, n] of [[3.5, 1], [10, 2], [12, 3]]) await command(`summon minecraft:end_crystal ${x} 81 0.5 {ShowBottom:0b,UUID:[I;0,0,0,${n}]}`);
	await sleep(1000);
	{
		const o = await observe();
		const rows = (o.entities ?? []).filter(r => r.type === 'minecraft:end_crystal');
		results.crystal.rows = rows.map(r => ({ distance: Math.round(r.distance * 10) / 10, blastDamageIfBroken: r.blastDamageIfBroken ?? null }));
		await command('kill @e[type=minecraft:end_crystal,x=3.5,y=81,z=0.5,distance=..1]'); await command('kill @e[type=minecraft:end_crystal,x=12,y=81,z=0.5,distance=..1]');
		await sleep(500);
		const predicted = rows.find(r => r.uuid === '00000000-0000-0000-0000-000000000002')?.blastDamageIfBroken ?? null;
		// Saturation regenerates about 1 health per 0.5 s at full hunger: clear it so the blast is measured alone.
		await command(`effect clear ${agent} minecraft:saturation`); await command(`effect give ${agent} minecraft:hunger 5 255 true`); await sleep(1000);
		const before = await health();
		await command(`damage @e[type=minecraft:end_crystal,limit=1] 1 minecraft:player_attack by ${agent}`);
		await sleep(300);
		results.crystal.break9 = { predicted, lost: Math.round((before - await health()) * 10) / 10 };
	}

	// 3. Footing over the End void: a 3x3 obsidian platform 300 blocks south of the island, standing at its +z edge.
	await end('forceload add -16 284 16 316'); await sleep(1500);
	await end('fill -1 69 299 1 69 301 minecraft:obsidian');
	await end(`tp ${agent} 0.5 70 301.6 0 30`); await sleep(2500);
	await heal();
	{
		const o = await observe();
		results.void.groundAhead = o.player?.groundAhead ?? null;
		const r = await act('control', { forward: 0, strafe: 0, jump: false, sneak: true, sprint: false, attack: false, use: false, yaw: 0, pitch: 30, selectedSlot: 0, hand: 'main', ticks: 2 });
		results.void.controlMessage = r.message;
	}
	results.summary = {
		control12Lost: results.clutch.control12.lost,
		sprint25Lost: results.clutch.sprint25.lost, drop45Lost: results.clutch.drop45.lost,
		crystalPredicted: results.crystal.break9.predicted, crystalLost: results.crystal.break9.lost,
		voidGroundAhead: results.void.groundAhead?.status ?? null, voidInControl: /void/.test(results.void.controlMessage ?? ''), jar: jarPath,
	};
	await writeFile(join(out, 'end-survive.json'), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results, null, 2));
} finally {
	await writeFile(join(out, 'end-survive.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
