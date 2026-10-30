#!/usr/bin/env node
// Provider-free check of the Nether fight deaths on 57eddf18/88c4dfcc (2026-10-21):
// 1) footing within a hit's push: d9-nether-d and d10-nether-b were knocked off fortress bridges whose edge was two
//    cells away, where the beside-the-feet probe said nothing (checked on the terminal move result);
// 2) a fight_target with shield:true whose offhand shield breaks mid-fight (d9-nether-e: the fight ended
//    SHIELD_NOT_EQUIPPED with the angry zombified piglin on 2.9 HP and the idle body died 3.5 s later);
// 3) a sword sweep from fight_target that hurts a calm zombified piglin beside the target (d9-nether-e's provocation).
// ARENA_JAR selects the jar (old vs new). Launch under slot.sh live; operator commands build fixtures only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const out = resolve(process.argv[2] ?? 'runtime/nether-fight-live');
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
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261022\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=normal\n`);
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
let rcon, bridge, record, observation, inbox, ordinal = 0;
const agent = 'Fighter';
const footings = [];
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
async function observe() { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }); return (await next).payload; }
function command_(type, args) {
	const id = `nf-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'nf-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const done = inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000)
		.then(async e => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return e.payload; });
	return { id, sent: bridge.send('action_command', record.agentId, payload), done };
}
async function act(type, args) { const c = command_(type, args); await c.sent; return c.done; }
const numbers = text => (/\[([^\]]*)\]/.exec(text)?.[1] ?? '').split(',').map(v => Number(v.trim().replace(/[a-z]$/i, '')));
const health = async selector => Number(/([\d.]+)f?$/.exec((await command(`data get entity ${selector} Health`)).trim())?.[1]);
async function entityId(type) {
	for (let i = 0; i < 10; i++) {
		const o = await observe();
		const row = (o.entities ?? []).find(e => e.type === type && e.alive !== false);
		if (row) return row.uuid;
		await sleep(300);
	}
	throw new Error(`no ${type} observed`);
}
const mob = (type, x, z, extra = '') => command(`summon ${type} ${x} 81 ${z} {NoAI:1b,PersistenceRequired:1b,Rotation:[90f,0f],attributes:[{id:"minecraft:max_health",base:100.0}],Health:100.0f${extra}}`);
const results = { footing: {}, shieldBreak: {}, sweep: {} };
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) { observation = e.payload; if (e.payload.player?.footing) footings.push({ attention: e.payload.attention === true, footing: e.payload.player.footing }); } });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free nether fight fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('gamerule minecraft:spawn_mobs false').catch(() => command('gamerule doMobSpawning false'));
	await command('forceload add -32 -32 32 32'); await sleep(2000);
	// A fortress-bridge-like deck: 9x9 at y80, 22 blocks over the floor, open on the east two cells from the body.
	await command('fill -16 58 -16 16 58 16 minecraft:stone'); await command('fill -16 59 -16 16 100 16 minecraft:air');
	await command('fill -6 80 -4 2 80 4 minecraft:nether_bricks');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 81 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	await command(`effect give ${agent} minecraft:saturation 1200 4 true`);
	await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`);
	await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);

	// 1. Footing with the open edge two cells east, as the terminal move result reports it.
	await command(`tp ${agent} -0.5 81 0.5 -90 35`); await sleep(1500);
	const moved = await act('move_to', { x: 0.5, y: 81, z: 0.5, tolerance: 0.3, sprint: false });
	results.footing.moveResult = /footing \{[^}]*\}/.exec(moved.message ?? '')?.[0] ?? null;
	// Resistance 255 keeps the fixture body alive through the fights below.
	await command(`effect give ${agent} minecraft:resistance 1200 255 true`);

	// 2. shield:true fight whose offhand shield breaks after 1.5 s.
	await command(`tp ${agent} 0.5 81 0.5 -90 0`);
	await mob('minecraft:zombie', 2.5, 0.5); await sleep(800);
	const zombie = await entityId('minecraft:zombie');
	const fight = command_('fight_target', { targetId: zombie, pursue: false, shield: true, timeoutMs: 5000 });
	await fight.sent; await sleep(1500);
	const before = await health(`@e[type=minecraft:zombie,limit=1]`);
	await command(`item replace entity ${agent} weapon.offhand with minecraft:air`);
	const result = await fight.done;
	const after = await health(`@e[type=minecraft:zombie,limit=1]`);
	results.shieldBreak = { state: result.state, reasonCode: result.reasonCode, zombieHealthAtBreak: before, zombieHealthAfter: after, hitsAfterBreak: before > after, notesBreak: /shield broke/.test(result.message ?? ''), message: String(result.message ?? '').slice(0, 300) };
	console.log(JSON.stringify(results.shieldBreak));
	await command('kill @e[type=minecraft:zombie]');

	// 3. A sweep from fight_target at a zombie with a calm zombified piglin beside it.
	await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
	await command(`tp ${agent} 0.5 81 0.5 -90 0`);
	await mob('minecraft:zombie', 2.5, 0.5); await mob('minecraft:zombified_piglin', 2.5, 1.7); await sleep(800);
	const target = await entityId('minecraft:zombie');
	const pigBefore = await health('@e[type=minecraft:zombified_piglin,limit=1]');
	const swept = await act('fight_target', { targetId: target, pursue: false, timeoutMs: 3000 });
	const pigAfter = await health('@e[type=minecraft:zombified_piglin,limit=1]');
	results.sweep = { state: swept.state, piglinHurt: pigAfter < pigBefore, pigBefore, pigAfter, reported: /sweep also hit calm minecraft:zombified_piglin/.test(swept.message ?? ''), message: String(swept.message ?? '').slice(0, 400) };
	console.log(JSON.stringify(results.sweep));

	results.summary = {
		moveFooting: results.footing.moveResult,
		shieldBreak: `${results.shieldBreak.state} ${results.shieldBreak.reasonCode}; hits after break ${results.shieldBreak.hitsAfterBreak}; noted ${results.shieldBreak.notesBreak}`,
		sweep: `piglin hurt ${results.sweep.piglinHurt}; reported ${results.sweep.reported}`,
		jar: jarPath,
	};
	console.log(JSON.stringify(results.summary, null, 2));
} finally {
	await writeFile(join(out, 'nether-fight.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
