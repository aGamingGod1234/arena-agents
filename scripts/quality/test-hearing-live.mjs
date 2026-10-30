#!/usr/bin/env node
// Provider-free check of client-only sounds in hearing. d18-end-a (2026-10-21): 0 wing flaps against 18,227 dragon
// ambient sounds; in 25 dangerous approaches the dragon was behind the agent and out of view, a real player hears its
// flaps getting louder. Checks: 1) next to an open lava pool behind the agent, heard rows carry lava pops/ambient;
// 2) in the End from the 6-end save point (seed 20261009, obsidian platform at 100.5 49 0.5, facing away from the island),
// heard rows carry entity.ender_dragon.flap with distance and direction while the dragon flies behind, out of view.
// ARENA_JAR selects the jar (old vs new). Always launch under slot.sh live; operator commands build fixtures only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const jarPath = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const out = resolve(process.argv[2] ?? 'runtime/hearing-live');
const checkpoint = JSON.parse(await readFile(process.env.ARENA_END_CHECKPOINT ?? '/home/agaminggod/Desktop/Projects/arena-beat-game/long/checkpoints/6-end.json', 'utf8'));
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
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=${checkpoint.seed}\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=8\nsimulation-distance=8\npause-when-empty-seconds=-1\nmax-players=4\ndifficulty=normal\n`);
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
let rcon, bridge, record, observation, inbox;
const agent = 'Listener';
const command = async s => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(s)).text;
};
const end = s => command(`execute in minecraft:the_end run ${s}`);
let lastAny = null;
async function observe() {
	for (let attempt = 0; ; attempt++) {
		const seq = observation?.eventSequence ?? 0;
		const next = inbox.wait('observation', e => e.agentId === record.agentId && e.payload.ready && e.payload.eventSequence > seq, 15000);
		await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision });
		try { return (await next).payload; } catch (error) { console.error('observe retry', attempt, JSON.stringify(lastAny)); if (attempt === 3) throw error; }
	}
}
const vector = text => { const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(text); return m ? m.slice(1).map(Number) : null; };
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
/** Samples hearing, view and the true dragon position every ~0.5 s; `push` (optional) sends the dragon behind every 45 s. */
async function segment(name, place, seconds, push) {
	const samples = [];
	const begun = Date.now();
	let lastPlace = 0, lastPush = 0;
	while (Date.now() - begun < seconds * 1000) {
		const now = (Date.now() - begun) / 1000;
		if (now - lastPlace > 2) { await place(); lastPlace = now; }
		if (push && now > 50 && now - lastPush > 45) { await push(); await end('data merge entity @e[type=minecraft:ender_dragon,limit=1] {DragonPhase:0}'); lastPush = now; }
		const o = await observe();
		const dragon = vector(await end('data get entity @e[type=minecraft:ender_dragon,limit=1] Pos'));
		const me = vector(await command(`data get entity ${agent} Pos`));
		const yaw = Number((/\[(-?[\d.]+)f/.exec(await command(`data get entity ${agent} Rotation`)) ?? [])[1]);
		const dragonRows = (o.entities ?? []).filter(r => r.type === 'minecraft:ender_dragon').length;
		let truth = null;
		if (dragon && me) {
			const dx = dragon[0] - me[0], dy = dragon[1] - (me[1] + 1.62), dz = dragon[2] - me[2];
			const bearing = ((Math.atan2(-dx, dz) * 180 / Math.PI - yaw) % 360 + 540) % 360 - 180;
			truth = { distance: round(Math.hypot(dx, dy, dz)), bearing: Math.round(bearing), behind: Math.abs(bearing) > 90 };
		}
		const heard = (o.heard ?? []).filter(r => r.sound.startsWith('entity.ender_dragon.'));
		samples.push({ t: round(now), truth, dragonRows, heard });
		await sleep(250);
	}
	await writeFile(join(out, `end-${name}-samples.json`), JSON.stringify(samples, null, 2));
	const flapOf = s => s.heard.find(h => h.sound === 'entity.ender_dragon.flap');
	const behindUnseen = samples.filter(s => s.truth?.behind && s.dragonRows === 0 && s.truth.distance <= 80);
	const behindWithFlap = behindUnseen.filter(s => flapOf(s) && !flapOf(s).secondsAgo);
	const errors = behindWithFlap.map(s => Math.abs(flapOf(s).distance - s.truth.distance)).sort((a, b) => a - b);
	const near = behindUnseen.filter(s => s.truth.distance <= 25).map(s => ({ t: s.t, trueDistance: s.truth.distance, bearing: s.truth.bearing, flap: flapOf(s) ?? null }));
	return { samples: samples.length,
		samplesWithFlap: samples.filter(flapOf).length,
		samplesWithGrowl: samples.filter(s => s.heard.some(h => h.sound === 'entity.ender_dragon.growl')).length,
		samplesWithAmbient: samples.filter(s => s.heard.some(h => h.sound === 'entity.ender_dragon.ambient')).length,
		behindOutOfViewWithin80: behindUnseen.length, ofThoseWithFreshFlapRow: behindWithFlap.length,
		within25BehindOutOfView: near.length, ofThoseWithFreshFlapRow25: near.filter(s => s.flap && !s.flap.secondsAgo).length,
		flapDistanceErrorMedian: errors[Math.floor(errors.length / 2)] ?? null, flapDistanceErrorP90: errors[Math.floor(errors.length * 0.9)] ?? null,
		minTrueDistanceBehind: behindUnseen.length ? Math.min(...behindUnseen.map(s => s.truth.distance)) : null,
		nearBehindExamples: near.slice(0, 16) };
}
const results = { lava: {}, end: {} };
try {
	for (let i = 0; i < 150; i++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (e) { await rcon?.close(); if (i === 149) throw e; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', e => { if (e.agentId === record?.agentId) lastAny = { ready: e.payload.ready, status: e.payload.status, seq: e.payload.eventSequence, sampleOnly: e.payload.sampleOnly }; if (e.agentId === record?.agentId && e.payload.ready) observation = e.payload; });
	bridge.on('goal_spec_request', e => { bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Controlled live hearing fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free hearing fixture', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	await command('gamerule minecraft:send_command_feedback false'); await command(`time set ${checkpoint.setup.time}`); await command('weather clear');
	await command('forceload add -32 -32 32 32'); await sleep(2000);
	await command('fill -16 79 -16 16 90 16 minecraft:air'); await command('fill -16 78 -16 16 78 16 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 79 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const e = await registered; record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', e => e.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await command(`gamemode survival ${agent}`);
	await command(`effect give ${agent} minecraft:resistance 1200 4 true`);
	await command(`effect give ${agent} minecraft:saturation 1200 4 true`);

	// 1. A 3x3 lava pool in the floor 6-8 blocks behind the agent (open to air), which faces away from it.
	await command('fill 6 78 -1 8 78 1 minecraft:lava');
	await command(`tp ${agent} 0.5 79 0.5 90 0`); await sleep(1000);
	const lavaRows = [];
	for (let i = 0; i < 60; i++) {
		await sleep(500);
		const o = await observe();
		const heard = (o.heard ?? []).filter(r => r.sound.includes('lava'));
		lavaRows.push({ t: round(i * 0.5), seen: (o.blocks ?? []).some?.(b => /lava/.test(JSON.stringify(b))) ?? null, heard });
	}
	const withLava = lavaRows.filter(r => r.heard.length);
	results.lava = { samples: lavaRows.length, samplesWithHeardLava: withLava.length, firstHeardAtS: withLava[0]?.t ?? null,
		sounds: [...new Set(withLava.flatMap(r => r.heard.map(h => h.sound)))], example: withLava.at(-1)?.heard ?? null,
		distances: [...new Set(withLava.flatMap(r => r.heard.map(h => h.distance)))].sort((a, b) => a - b), directions: [...new Set(withLava.flatMap(r => r.heard.map(h => h.direction)))] };
	console.log(JSON.stringify(results.lava));

	// 2. The End save point: its setup commands, then the agent on the platform facing east, away from the island.
	// Slow falling and a re-place every 2 s keep a knockback from carrying the body into the void; neither changes hearing.
	await command(`effect give ${agent} minecraft:slow_falling 1200 0 true`);
	await end('forceload add -48 -48 48 48');
	await end('forceload add 80 -16 112 16');
	for (const c of checkpoint.setup.commands) await command(c);
	const [px, py, pz] = checkpoint.setup.position;
	const place = () => end(`tp ${agent} ${px} ${py} ${pz} -90 0`);
	await place();
	let dragonSeen = false;
	for (let i = 0; i < 40 && !dragonSeen; i++) { await sleep(1000); dragonSeen = vector(await end('data get entity @e[type=minecraft:ender_dragon,limit=1] Pos')) !== null; }
	results.end.dragonSpawnedNaturally = dragonSeen;
	if (!dragonSeen) await end('summon minecraft:ender_dragon 0 80 0 {DragonPhase:0}');
	await sleep(2000);
	results.end.platform = await segment('platform', place, 150, () => end(`tp @e[type=minecraft:ender_dragon,limit=1] ${px - 35} ${py + 12} ${pz} -90 0`));

	// 3. On the island ground 25 blocks east of the fountain, facing east: no crystals left, so the circling dragon
	// strafes and charges the player (HoldingPattern picks a player 1 time in crystals + 3), passing close behind.
	await end('kill @e[type=minecraft:end_crystal]');
	await end(`tp ${agent} 25.5 100 0.5 -90 0`);
	let ground = null;
	for (let i = 0; i < 40; i++) { await sleep(1000); const o = await observe(); if (o.player?.onGround) { ground = o.position; break; } }
	const groundY = Math.floor(ground?.y ?? 64);
	results.end.groundY = groundY;
	results.end.island = await segment('island', () => end(`tp ${agent} 25.5 ${groundY} 0.5 -90 0`), 150, null);
	await writeFile(join(out, 'hearing.json'), JSON.stringify(results, null, 2));
	console.log(JSON.stringify(results, null, 2));
} finally {
	await writeFile(join(out, 'hearing.json'), JSON.stringify(results, null, 2)).catch(() => {});
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise(r => child.once('exit', r)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
