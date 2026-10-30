#!/usr/bin/env node
// Provider-free check of the fighting-position fact on the 2-nether fortress (seed 20261009, spawner 84,73,92).
// Chapter games 2026-10-21 died where the body stood: knocked off fortress bridges (d9-nether-d at 59.6,69,92.7;
// d11-nether-g at 46.2,69,82.3 from full health), or burned and shot while placing cover one block per turn
// (d11-nether-c 67.6,70,84.8; d11-nether-e 78,70,96; d11-nether-f 70.6,70,100.7). At each spot the body looks around
// and up (as lookAround with a pitch does), a still blaze appears in sight, and the threat observation's footing, stand and the wake's
// edge note are recorded. ARENA_JAR selects the jar. Launch under slot.sh live; operator commands build fixtures only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { edgeNote } from '../../coordinator/src/dynamic-main.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const out = resolve(process.argv[2] ?? 'runtime/fight-position-live');
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
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261009\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=normal\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Darenaagents.bridgePort=${port}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${join(out, 'secret.txt')}`, '-Xms512M', '-Xmx3G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
await writeFile(join(out, 'server.pid'), String(child.pid));
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', e => this.accept(e)); bridge.on('ready', e => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex(w => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex(e => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: e => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}
let rcon, bridge, record, observation, inbox, ordinal = 0;
const agent = 'Stander';
const nether = 'execute in minecraft:the_nether run';
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 60000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
const attention = [];
async function observe() { const seq = observation?.eventSequence ?? 0; const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq); await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision }); return (await next).payload; }
async function act(type, args) {
	const id = `fp-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'fp-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const done = inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), 65000);
	await bridge.send('action_command', record.agentId, payload);
	const r = (await done).payload;
	await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision });
	return r;
}
const air = async (x, y, z) => /passed/i.test(await command(`execute in minecraft:the_nether if block ${x} ${y} ${z} minecraft:air`));
const spots = [
	{ label: 'd9-nether-d knocked off here (blaze)', x: 59.6, y: 69, z: 92.7 },
	{ label: 'd11-nether-g knocked off at full health (wither skeleton)', x: 46.2, y: 69, z: 82.3 },
	{ label: 'd11-nether-c fireballed by blaze', x: 67.6, y: 70, z: 84.8 },
	{ label: 'd11-nether-e slain by blaze', x: 78.5, y: 70, z: 96.5 },
	{ label: 'd11-nether-f slain by wither skeleton', x: 70.6, y: 70, z: 100.7 },
	{ label: 'd11-nether-d withered away on the bridge', x: 45.1, y: 64, z: 90.4 },
	{ label: 'd10-nether-a slain by blaze (north)', x: 58.5, y: 71, z: 25.5 },
	{ label: 'spawner balcony beside the spawner', x: 83.5, y: 73, z: 91.5 },
	{ label: 'roofed room north of the spawner', x: 81.5, y: 70, z: 85.5 },
	{ label: 'bridge crossing west of the spawner', x: 75.5, y: 70, z: 92.5 },
];
const results = { spots: [] };
try {
	for (let i = 0; i < 300; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 60000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 299) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId && e.payload.ready) { observation = e.payload; if (e.payload.attention === true) attention.push(e.payload); } });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live mechanics fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free fight position fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false');
	await command('gamerule minecraft:spawn_mobs false').catch(() => command('gamerule doMobSpawning false'));
	await command(`${nether} forceload add 0 0 112 112`); await sleep(3000);
	const registered = inbox.wait('agent_registered', () => true, 120000);
	console.log(await command(`execute in minecraft:the_nether positioned 16.5 62 86.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	for (const effect of ['resistance 1200 255', 'fire_resistance 1200 0', 'saturation 1200 4']) await command(`effect give ${agent} minecraft:${effect} true`);
	await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`);
	await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
	for (const spot of spots) {
		await command('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
		await command(`${nether} tp ${agent} ${spot.x} ${spot.y} ${spot.z} 0 0`); await sleep(1500);
		let o = await observe();
		const row = { label: spot.label, at: o.position, onGround: o.player?.onGround };
		// Look around, down at the terrain within a push and up at any roof, as lookAround with a pitch does.
		for (let heading = 0; heading < 8; heading++) {
			const a = Math.PI / 4 * heading;
			await act('look_at', { x: spot.x + Math.cos(a) * 4, y: spot.y - 1.5, z: spot.z + Math.sin(a) * 4 });
			await act('look_at', { x: spot.x + Math.cos(a) * 3, y: spot.y + 5, z: spot.z + Math.sin(a) * 3 });
		}
		// A still blaze in sight: the first open offset whose blaze the threat scan reports (it needs line of sight).
		let blaze = null, threatObs = null;
		for (const [dx, dy, dz] of [[6, 2, 0], [-6, 2, 0], [0, 2, 6], [0, 2, -6], [4, 1, 4], [-4, 1, -4], [4, 1, -4], [-4, 1, 4], [3, 0, 0], [-3, 0, 0], [0, 0, 3], [0, 0, -3], [0, 3, 0]]) {
			const bx = Math.floor(spot.x) + dx, by = Math.floor(spot.y) + dy, bz = Math.floor(spot.z) + dz;
			if (!(await air(bx, by, bz) && await air(bx, by + 1, bz))) continue;
			attention.length = 0;
			await command(`${nether} summon minecraft:blaze ${bx + 0.5} ${by} ${bz + 0.5} {NoAI:1b,Invulnerable:1b,PersistenceRequired:1b}`);
			await act('look_at', { x: bx + 0.5, y: by + 1, z: bz + 0.5 });
			const started = Date.now();
			while (Date.now() - started < 3000 && threatObs === null) {
				o = await observe();
				threatObs = attention.find(p => p.player?.stand !== undefined) ?? attention.find(p => Object.keys(p.threats ?? {}).length > 0) ?? null;
				if (!threatObs) await sleep(300);
			}
			if (threatObs) { blaze = [bx + 0.5, by, bz + 0.5]; break; }
			await command('execute in minecraft:the_nether run kill @e[type=minecraft:blaze]');
		}
		const p = threatObs ?? o;
		row.blaze = blaze; row.threats = Object.keys(p.threats ?? {}).length; row.footing = p.player?.footing ?? null; row.stand = p.player?.stand ?? null;
		row.note = edgeNote({ ...p.player, threats: [{ type: 'minecraft:blaze' }] }).trim();
		results.spots.push(row);
		console.log(JSON.stringify(row));
	}
} finally {
	await writeFile(join(out, 'fight-position.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(15000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
