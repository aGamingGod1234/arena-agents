#!/usr/bin/env node
// Provider-free replay of an incident library (scripts/quality/watch-incidents.mjs):
//   node scripts/quality/watch-replay.mjs LIBRARY_DIR [--jar JAR] [--only ID,...] [--out FILE] [--compare OLD.json] [--window-s 12]
// Each incident boots a server on a copy of the run's saved world (or the seed when the world was not kept), puts a
// new agent at the save point (dimension, position, inventory, armour, health, time of day), arms the reflex rules the
// model had armed when the danger opened, and after the save point's lead re-creates the danger with vanilla means
// (summons the source mob, or sets the source block when the spot is empty). No model call is made: the body only
// runs its reflexes (and the recorded body action when the episode carries one as {actionType, arguments}). Reports
// survived/died per incident and writes LIBRARY_DIR/replays/<jar sha>-<time>.json, so old and new jars can be compared.
// A hand-made variant's incident.replay may add prepare (commands run in the dimension before the body arrives), source
// (the danger to re-create instead of the episode's) and leadMs (when to re-create it), besides also (more mobs), at
// (where the body starts instead of the save point) and action (a body action sent once the danger is re-created, its
// "$source" arguments naming the re-created mob and "$also0", "$also1"... the extra mobs; a list of actions runs in order), and after ([{atMs, command}]:
// commands run in the dimension that many ms after the danger is re-created, such as a hit with knockback), and cancel ({atMs} or
// {onLip: true}: cancel the recorded body action then, as a superseding turn does).
// Launch under slot.sh live (SLOT_PORT_BASE) with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set; REPLAY_TRACK_ALL=1 (or REPLAY_FULL_TRACK=1) keeps every
// track sample with the firing detail, inLava, onGround and lavaFlow.
import { readFile, writeFile, mkdir, mkdtemp, cp, readdir, unlink, open, rm } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const round = v => Math.round(v * 100) / 100;
const AGENT = 'Probe';
const OVERWORLD = 'minecraft:overworld', END = 'minecraft:the_end';
// How far from the body a re-created mob starts when the episode does not say where it was (blocks).
const START_DISTANCE = { creeper: 4, skeleton: 10, stray: 10, bogged: 10, pillager: 10, blaze: 9, ghast: 18, witch: 8, enderman: 5, piglin: 5, piglin_brute: 5, hoglin: 5, zoglin: 5, wither_skeleton: 4 };

/** Every incident.json under the library, sorted by id. */
export async function listIncidents(library) {
	const found = [];
	for (const run of await readdir(library, { withFileTypes: true }).catch(() => [])) {
		if (!run.isDirectory() || run.name === 'replays') continue;
		for (const entry of await readdir(path.join(library, run.name), { withFileTypes: true })) {
			const file = path.join(library, run.name, entry.name, 'incident.json');
			if (entry.isDirectory() && existsSync(file)) found.push({ dir: path.dirname(file), incident: JSON.parse(await readFile(file, 'utf8')) });
		}
	}
	return found.sort((a, b) => a.incident.id.localeCompare(b.incident.id));
}

/** How the danger is re-created: an entity summon, a block set where empty, or nothing (terrain, fall, void, air). */
export function recreation(episode, { bodyAt, savepointAt }) {
	const type = String(episode.source?.type ?? '');
	const id = type.startsWith('minecraft:') ? type : null;
	if (id && Array.isArray(episode.source?.block)) return { kind: 'block', id, at: episode.source.block };
	if (id && (episode.source?.entityId != null || !Array.isArray(episode.source?.block))) {
		const name = id.slice('minecraft:'.length);
		// A recorded source position is kept relative to where the body was when the episode opened.
		const src = episode.source.pos;
		if (src && episode.pos) return { kind: 'entity', id, offset: [src.x - episode.pos.x, src.y - episode.pos.y, src.z - episode.pos.z], from: 'source.pos' };
		const d = START_DISTANCE[name] ?? 6;
		let dx = (episode.pos?.x ?? bodyAt[0] + 1) - savepointAt[0], dz = (episode.pos?.z ?? bodyAt[2]) - savepointAt[2];
		const len = Math.hypot(dx, dz);
		if (len < 0.5) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
		return { kind: 'entity', id, offset: [round(dx * d), 0, round(dz * d)], from: `default ${d} blocks toward the episode position` };
	}
	return { kind: 'none', id: type || null };
}

class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', e => this.accept(e)); bridge.on('ready', e => this.accept({ type: 'ready', ...e })); }
	accept(e) { const i = this.waiters.findIndex(w => w.type === e.type && w.match(e)); if (i >= 0) this.waiters.splice(i, 1)[0].done(e); else { this.events.push(e); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) { const i = this.events.findIndex(e => e.type === type && match(e)); if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { type, match, done: e => { clearTimeout(t); res(e); } }; const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(w); }); }
}

let liveServer = null;

/** Each live slot reserves 100 ports; rotate starts so a closing RCON socket cannot poison the next case. */
export const replayPort = (base, index) => base + (index % 25) * 4;

/** A failed start never reaches the caller's stop handle. Its copied test world has nothing to save. */
export async function abortReplayBoot(s) {
	s.bridge?.stop();
	await s.rcon?.close().catch(() => {});
	if (s.child.exitCode === null && s.child.signalCode === null) {
		await new Promise(resolve => {
			const timer = setTimeout(resolve, 5000);
			s.child.once('exit', () => { clearTimeout(timer); resolve(); });
			s.child.kill('SIGKILL');
		});
	}
	await s.log.close();
}

/** One server on a copy of the incident's world (or the seed); mirrors test-reflex-failspots-live.mjs. */
export async function boot(dir, { jar, template, port, world, seed, goalTicks = 24000, spawnMonsters = false, readyTimeoutMs = 30000, bridgeReadyMs = readyTimeoutMs }) {
	const server = path.join(dir, 'server');
	await cp(template, server, { recursive: true });
	for (const name of await readdir(path.join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(path.join(server, 'mods', name));
	await cp(jar, path.join(server, 'mods/arena-agents-0.2.0.jar'));
	if (world) await cp(world, path.join(server, 'world'), { recursive: true });
	await rm(path.join(server, 'world', 'session.lock'), { force: true });
	const secret = randomBytes(32).toString('hex');
	await writeFile(path.join(dir, 'secret.txt'), secret, { mode: 0o600 });
	await writeFile(path.join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\n${world ? '' : `level-seed=${seed}\n`}spawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=${spawnMonsters}\ndifficulty=normal\n`);
	const log = await open(path.join(dir, 'server.log'), 'a');
	const java = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
	const child = spawn(java, [`-Darenaagents.bridgePort=${port}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${path.join(dir, 'secret.txt')}`, '-Xms512M', '-Xmx2G', ...(process.env.REPLAY_JAVA_OPTS ?? '').split(' ').filter(Boolean), '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
	const s = { child, log, record: null, observation: null, ordinal: 0, revision: 0 };
	s.stop = async () => {
		if (s.command) await s.command('stop').catch(() => {});
		s.bridge?.stop(); await s.rcon?.close();
		if (child.exitCode === null) {
			await Promise.race([new Promise(r => child.once('exit', r)), sleep(15000)]);
			if (child.exitCode === null) child.kill('SIGTERM');
		}
		await log.close();
	};
	liveServer = child;
	try {
		for (let i = 0; i < 180; i++) { try { s.rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 30000 }); await s.rcon.connect(); break; } catch (e) { await s.rcon?.close(); if (i === 179 || child.exitCode !== null) throw e; await sleep(1000); } }
		s.command = async text => { if (s.rcon.state === 'closed') { s.rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 30000 }); await s.rcon.connect(); } return (await s.rcon.command(text)).text; };
		s.bridge = new MultiplexedServerBridge({ port, secret }, {}); s.inbox = new Inbox(s.bridge);
		s.bridge.on('observation', e => { if (e.agentId === s.record?.agentId && e.payload.ready) s.observation = e.payload; });
		s.bridge.on('goal_spec_request', e => { s.bridge.send('goal_spec_proposal', e.agentId, { requestId: e.payload.requestId, summary: 'Incident replay', predicate: { type: 'survive_duration', ticks: goalTicks } }).catch(() => {}); });
		const ready = s.inbox.wait('ready', () => true, bridgeReadyMs); s.bridge.start(); await ready;
		await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free incident replay', reasoningEfforts: ['low'], serviceTiers: ['default'] }] });
		await s.command('gamerule minecraft:send_command_feedback false');
		await s.command('scoreboard objectives add deaths deathCount');
		s.observe = async () => { const seq = s.observation?.eventSequence ?? 0; const next = s.inbox.wait('observation', e => e.agentId === s.record.agentId && e.payload.ready && e.payload.eventSequence > seq); await s.bridge.send('request_observation', s.record.agentId, { goalRevision: s.record.goalRevision }); return (await next).payload; };
		s.observeOrNull = async () => { try { return await s.observe(); } catch { return null; } };
		s.act = async (type, args, waitMs = 65000) => {
			const id = `replay-${++s.ordinal}`;
			s.lastActionId = id;
			const payload = { actionId: id, traceId: id, goalRevision: s.record.goalRevision, actionType: type, arguments: args,
				provenance: { provider: s.record.provider, model: s.record.model, reasoningEffort: s.record.reasoningEffort, serviceTier: s.record.serviceTier, traceId: id, programId: 'incident-replay', programVersion: 1, sourceStepId: id, eventSequence: s.observation?.eventSequence ?? 0 } };
			const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), Math.max(65000, waitMs));
			// A command the bridge refuses never gets a result: drop the wait so it cannot reject later, unhandled.
			try { await s.bridge.send('action_command', s.record.agentId, payload); } catch (error) { next.catch(() => {}); throw error; }
			const r = (await next).payload;
			await s.bridge.send('action_result_ack', s.record.agentId, { actionId: id, goalRevision: s.record.goalRevision });
			return r;
		};
		s.setReflexes = async rules => {
			s.revision += 1;
			// As the coordinator's ReflexBook: a context lifetime (lasts) is the coordinator's; the mod gets the longest ttl instead.
			const sent = normalizeReflexEntries(rules).map(({ lasts, ...rule }) => (lasts !== undefined && rule.ttlMs === undefined ? { ...rule, ttlMs: 3_600_000 } : rule));
			await s.bridge.send('reflex_update', s.record.agentId, { revision: s.revision, rules: sent, yield: false });
			for (let i = 0; i < 40; i++) { const o = await s.observe(); if (o.reflexes?.revision === s.revision) return o; await sleep(100); }
			throw new Error(`reflex revision ${s.revision} never echoed`);
		};

		return s;
	} catch (error) {
		await abortReplayBoot(s);
		throw error;
	}
}

const number = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
const deaths = async s => number(await s.command(`scoreboard players get ${AGENT} deaths`)) || 0;
const health = async s => { const text = await s.command(`data get entity ${AGENT} Health`); return /No entity|not found/i.test(text) ? 0 : number(text); };

async function replayOne(s, { incident, savepoint }, { windowMs }) {
	const setup = savepoint.setup, episode = incident.episode, dim = setup.dimension;
	const pos = incident.replay?.at ?? setup.position, at = `execute in ${dim} run`;
	await s.command(`execute in ${dim} run forceload add ${Math.floor(pos[0]) - 24} ${Math.floor(pos[2]) - 24} ${Math.floor(pos[0]) + 24} ${Math.floor(pos[2]) + 24}`);
	const registered = s.inbox.wait('agent_registered');
	await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
	const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start'); await s.command(`codex start ${AGENT} Survive for 1200 seconds.`); s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command(`gamemode survival ${AGENT}`);
	// Through another dimension, so the body arrives knowing no terrain, as a respawned or newly arrived player.
	await s.command(`execute in ${dim === END ? OVERWORLD : END} run tp ${AGENT} 0.5 200 0.5`); await sleep(500);
	await s.command(`clear ${AGENT}`);
	// The hands as they were (slots, offhand, held item) when the incident recorded them, else the save point's bag.
	const hands = incident.savepoint.hands;
	if (hands?.slots?.length || hands?.offhand) {
		for (const { slot, item, count } of hands.slots ?? []) if (slot >= 0 && slot <= 35) await s.command(`item replace entity ${AGENT} container.${slot} with ${item} ${count}`);
		if (hands.offhand) await s.command(`item replace entity ${AGENT} weapon.offhand with ${hands.offhand}`);
	} else for (const { item, count } of setup.inventory ?? []) await s.command(`give ${AGENT} ${item} ${count}`);
	for (const [slot, item] of Object.entries(setup.armour ?? {})) await s.command(`item replace entity ${AGENT} armor.${slot} with ${item}`);
	await s.command(`effect clear ${AGENT}`);
	await s.command(`effect give ${AGENT} minecraft:saturation 2 10 true`);
	if (Number.isFinite(setup.time)) await s.command(`time set ${setup.time}`);
	// A hand-made variant may restore terrain first (incident.replay.prepare: commands), such as clearing a lava flow the
	// saved world kept after the incident so it can be re-created as it advanced.
	for (const command of incident.replay?.prepare ?? []) await s.command(`${at} ${command}`);
	await s.command(`${at} tp ${AGENT} ${pos.join(' ')}`);
	// A dimension change leaves the body invulnerable for 60 ticks (vanilla): wait it out before damage counts.
	await sleep(3500);
	await s.command(`effect give ${AGENT} minecraft:instant_health 1 5 true`); await sleep(700);
	const target = incident.savepoint.health;
	if (Number.isFinite(target) && target < 20) await s.command(`damage ${AGENT} ${round(20 - target)} minecraft:generic`);
	await sleep(500);
	const held = hands?.slots?.find(row => row.slot === hands.selectedSlot);
	if (held) await s.act('select_item', { itemId: held.item.replace(/\[.*$/, '') }).catch(() => null);
	let o = await s.setReflexes(incident.reflexes.rules ?? []);
	const ids = (incident.reflexes.rules ?? []).map(r => r.id);
	const since = Math.max(0, ...(o.reflexes?.events ?? []).map(ev => ev.seq ?? 0));
	// The mod's view of each rule once armed (state, and what its action lacks), as the model would read it.
	const armedStatus = (o.reflexes?.rules ?? []).map(({ id, state, lacks }) => ({ id, state, ...(lacks ? { lacks } : {}) }));
	const before = await health(s), deathsBefore = await deaths(s);
	const action = episode.body?.action, late = incident.replay?.action ?? null;
	let pending = !late && action && typeof action === 'object' && action.actionType ? s.act(action.actionType, action.arguments ?? {}).catch(error => ({ state: 'ERROR', error: error.message })) : null;
	const start = Date.now(), lead = Math.max(0, incident.replay?.leadMs ?? incident.savepoint.leadMs ?? 0);
	const track = [];
	let died = false, minHealth = before, recreated = null, cancelled = null;
	while (Date.now() - start < lead + windowMs) {
		if (!recreated && Date.now() - start >= lead) {
			const body = [o.position?.x ?? pos[0], o.position?.y ?? pos[1], o.position?.z ?? pos[2]];
			recreated = recreation(incident.replay?.source ? { ...episode, source: incident.replay.source } : episode, { bodyAt: body, savepointAt: pos });
			// Stand a mob on the nearest open footing at its column (two air blocks over a solid one), not inside a hill.
			const summon = async (id, offset) => {
				const p = body.map((v, i) => round(v + offset[i]));
				const [bx, by, bz] = p.map(Math.floor);
				const air = async y => (await s.command(`execute in ${dim} if block ${bx} ${y} ${bz} minecraft:air`)).includes('passed');
				for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, 5, 6]) if (await air(by + dy) && await air(by + dy + 1) && !await air(by + dy - 1)) { p[1] = by + dy; break; }
				return { at: p, reply: await s.command(`${at} summon ${id} ${p[0]} ${p[1]} ${p[2]} {PersistenceRequired:1b}`) };
			};
			if (recreated.kind === 'entity') Object.assign(recreated, await summon(recreated.id, recreated.offset));
			else if (recreated.kind === 'block') recreated.reply = await s.command(`${at} setblock ${recreated.at.join(' ')} ${recreated.id} keep`);
			// A hand-made variant may name more mobs that took part ({id, offset} from the body), such as a second zombie.
			if (Array.isArray(incident.replay?.also)) { recreated.also = []; for (const m of incident.replay.also) recreated.also.push(await summon(m.id, m.offset)); }
			if (late) {
				// Nearest to where it was summoned: an rcon command runs at the world origin, where another mob of the kind may be nearer.
				const uuid = async (id, p) => uuidOf(await s.command(`execute in ${dim} positioned ${p.join(' ')} run data get entity @e[type=${id},sort=nearest,limit=1] UUID`));
				const names = { $source: recreated.kind === 'entity' ? await uuid(recreated.id, recreated.at) : null };
				for (const [i, m] of (incident.replay.also ?? []).entries()) names[`$also${i}`] = await uuid(m.id, recreated.also[i].at);
				// A list runs in order, each once the one before has ended (a break that opens lava, then the step after it).
				const steps = (Array.isArray(late) ? late : [late]).map(step => ({ actionType: step.actionType,
					arguments: Object.fromEntries(Object.entries(step.arguments ?? {}).map(([k, v]) => [k, v in names ? names[v] : v])) }));
				recreated.action = steps.length === 1 ? steps[0] : steps;
				pending = (async () => {
					let last = null;
					for (const step of steps) { last = await s.act(step.actionType, step.arguments); (recreated.results ??= []).push({ actionType: step.actionType, state: last.state, reasonCode: last.reasonCode ?? null, message: last.message ?? null }); }
					return last;
				})().catch(error => ({ state: 'ERROR', error: error.message }));
			}
		}
		for (const step of incident.replay?.after ?? []) {
			// step.near [x, y, z, r]: the step's clock starts once the body is within r blocks (horizontally) of the point
			// (a recorded hit that landed where the body walked to, whatever its pace on replay).
			if (step.near && !step.nearAt && recreated && o.position && Math.hypot(o.position.x - step.near[0], o.position.z - step.near[2]) <= step.near[3]) step.nearAt = Date.now();
			const zero = step.near ? step.nearAt : start + lead;
			if (step.done || !recreated || !zero || Date.now() - zero < step.atMs) continue;
			step.done = true;
			(recreated.after ??= []).push({ command: step.command, reply: String(await s.command(`${at} ${step.command}`)).slice(0, 160) });
		}
		// A hand-made variant may cancel the recorded body action as the coordinator does when a turn supersedes it
		// (incident.replay.cancel: {atMs} after the start, or {onLip: true}: the first tick the body stands with its middle
		// over an open cell, as at a bridge's edge), to replay what the body does when an action ends mid-move.
		const cancel = incident.replay?.cancel;
		if (cancel && !cancelled && pending && s.lastActionId && Date.now() - start >= (cancel.atMs ?? 0)) {
			let now = !cancel.onLip;
			if (cancel.onLip && o.player?.onGround && o.position) {
				// The middle over an open cell, at least onLip (a number) past the edge of a neighbouring block underfoot.
				const { x, y, z } = o.position, [bx, by, bz] = [x, y, z].map(Math.floor);
				const air = async (cx, cz) => (await s.command(`execute in ${dim} if block ${cx} ${by - 1} ${cz} minecraft:air`)).includes('passed');
				if (await air(bx, bz)) {
					const need = typeof cancel.onLip === 'number' ? cancel.onLip : 0;
					for (const [dx, dz, past] of [[-1, 0, x - bx], [1, 0, bx + 1 - x], [0, -1, z - bz], [0, 1, bz + 1 - z]]) {
						if (past >= need && !await air(bx + dx, bz + dz)) { now = true; break; }
					}
				}
			}
			if (now) {
				cancelled = { atMs: Date.now() - start, at: [o.position?.x, o.position?.y, o.position?.z].map(round) };
				await s.bridge.send('action_cancel', s.record.agentId, { goalRevision: s.record.goalRevision, actionId: s.lastActionId });
			}
		}
		const next = await s.observeOrNull();
		if (!next) { died = true; break; }
		o = next;
		const hp = o.player?.health ?? 0;
		minHealth = Math.min(minHealth, hp);
		const fullTrack = process.env.REPLAY_TRACK_ALL || process.env.REPLAY_FULL_TRACK === '1';
		track.push({ t: Date.now() - start, x: round(o.position?.x ?? 0), y: round(o.position?.y ?? 0), z: round(o.position?.z ?? 0), hp: round(hp), firing: o.reflexes?.firing?.id ?? null,
			...(fullTrack ? { detail: o.reflexes?.firing?.detail ?? null, inLava: o.player?.inLava ?? null, onGround: o.player?.onGround ?? null, lavaFlow: o.player?.lavaFlow ?? null } : {}) });
		if (hp <= 0) { died = true; break; }
		await sleep(process.env.REPLAY_FULL_TRACK === '1' ? 50 : 250);
	}
	o = (await s.observeOrNull()) ?? o;
	const events = (o.reflexes?.events ?? []).filter(ev => ids.includes(ev.id) && (ev.seq ?? 0) > since).map(ev => ({ id: ev.id, outcome: ev.outcome, detail: ev.detail, ms: ev.ms }));
	died = died || (await deaths(s)) > deathsBefore;
	// Where the re-created mob ended, so a reader can tell a survived replay from a danger that never engaged.
	if (recreated?.kind === 'entity') {
		const text = await s.command(`${at} data get entity @e[type=${recreated.id},sort=nearest,limit=1] Pos`).catch(() => '');
		const m = String(text).match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/);
		const last = track.at(-1);
		recreated.end = m ? m.slice(1).map(v => round(Number(v))) : null;
		recreated.endDistance = m && last ? round(Math.hypot(Number(m[1]) - last.x, Number(m[2]) - last.y, Number(m[3]) - last.z)) : null;
	}
	const bodyAction = pending ? await Promise.race([pending, sleep(2000).then(() => ({ state: 'STILL_RUNNING' }))]) : null;
	const after = died ? 0 : await health(s);
	return { armedStatus, survived: !died, died, ...(cancelled ? { cancelled } : {}), healthBefore: round(before), healthAfter: round(after), minHealth: round(Math.min(minHealth, after)), events, recreated, bodyAction: bodyAction ? { state: bodyAction.state, reasonCode: bodyAction.reasonCode ?? null, message: bodyAction.message ?? null, error: bodyAction.error ?? null } : null, track: (process.env.REPLAY_TRACK_ALL || process.env.REPLAY_FULL_TRACK === '1') ? track : track.filter((_, i) => i % 4 === 0) };
}

/** "[I; a, b, c, d]" (an entity's UUID data) as the usual dashed hex string, or null. */
export function uuidOf(text) {
	const m = String(text).match(/\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/);
	if (!m) return null;
	const hex = m.slice(1).map(v => (Number(v) >>> 0).toString(16).padStart(8, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function compareReplays(oldResult, newResult) {
	const rows = [];
	for (const [id, now] of Object.entries(newResult.incidents)) {
		const was = oldResult.incidents[id];
		rows.push({ id, old: was ? (was.error ? 'error' : was.died ? 'died' : 'survived') : 'absent', new: now.error ? 'error' : now.died ? 'died' : 'survived' });
	}
	return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2), opts = { windowMs: 12000 };
	let library = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--jar') opts.jar = argv[++i]; else if (a === '--only') opts.only = argv[++i].split(','); else if (a === '--out') opts.out = argv[++i];
		else if (a === '--compare') opts.compare = argv[++i]; else if (a === '--window-s') opts.windowMs = Number(argv[++i]) * 1000; else library = a;
	}
	if (!library) { console.error('Usage: node scripts/quality/watch-replay.mjs LIBRARY_DIR [--jar JAR] [--only ID,...] [--out FILE] [--compare OLD.json] [--window-s 12]'); process.exit(2); }
	const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
	if (!template || !port || !process.env.JAVA_HOME) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME, and launch under slot.sh live (SLOT_PORT_BASE)');
	library = path.resolve(library);
	const jar = path.resolve(opts.jar ?? process.env.ARENA_JAR ?? path.join(root, 'build/libs/arena-agents-0.2.0.jar'));
	const jarHash = createHash('sha256');
	for await (const chunk of createReadStream(jar)) jarHash.update(chunk);
	const jarSha256 = jarHash.digest('hex');
	for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (liveServer?.exitCode === null) liveServer.kill('SIGKILL'); process.exit(1); });
	const results = { kind: 'provider-free incident replay', modelCalls: 0, jar, jarSha256, library, startedAt: new Date().toISOString(), windowMs: opts.windowMs, incidents: {} };
	const out = path.resolve(opts.out ?? path.join(library, 'replays', `${jarSha256.slice(0, 8)}-${results.startedAt.replace(/[:.]/g, '-')}.json`));
	await mkdir(path.dirname(out), { recursive: true });
	let incidentOrdinal = 0;
	for (const { dir, incident } of await listIncidents(library)) {
		if (opts.only && !opts.only.some(id => incident.id === id || incident.id.endsWith(`/${id}`))) continue;
		const work = await mkdtemp(path.join(tmpdir(), 'incident-replay-'));
		const base = { recorded: { kind: incident.episode.kind, outcome: incident.episode.outcome, diagnosis: incident.episode.diagnosis, evidence: incident.episode.evidence }, armed: (incident.reflexes.rules ?? []).map(r => r.id) };
		let s;
		try {
			const savepoint = JSON.parse(await readFile(path.join(dir, incident.savepoint.file), 'utf8'));
			const world = incident.run.world ? path.resolve(dir, incident.run.world) : null;
			s = await boot(work, { jar, template, port: replayPort(port, incidentOrdinal++), world: world && existsSync(world) ? world : null, seed: incident.run.seed });
			results.incidents[incident.id] = { ...base, terrain: world && existsSync(world) ? 'saved world' : 'regenerated from seed', ...await replayOne(s, { incident, savepoint }, opts) };
		} catch (error) {
			results.incidents[incident.id] = { ...base, error: String(error?.stack ?? error).slice(0, 600) };
		} finally {
			await s?.stop().catch(() => {});
			// REPLAY_KEEP=1 keeps the server directory (server.log with any REPLAY_JAVA_OPTS diagnostics) for reading.
			if (s && process.env.REPLAY_KEEP !== '1') await rm(work, { recursive: true, force: true }).catch(() => {});
			await writeFile(out, JSON.stringify(results, null, 2) + '\n');
		}
		const r = results.incidents[incident.id];
		console.log(`[incident] ${incident.id} (${base.recorded.kind} ${base.recorded.outcome}): ${r.error ? `ERROR ${r.error.split('\n')[0]}` : `${r.died ? 'DIED' : 'survived'}, hp ${r.healthBefore} -> ${r.healthAfter} (min ${r.minHealth}), reflexes ${r.events.map(ev => `${ev.id}:${ev.outcome}`).join(' ') || 'none fired'}`}`);
	}
	results.finishedAt = new Date().toISOString();
	const all = Object.values(results.incidents);
	results.summary = { incidents: all.length, survived: all.filter(r => r.survived).length, died: all.filter(r => r.died).length, errors: all.filter(r => r.error).length };
	if (opts.compare) results.comparison = { against: path.resolve(opts.compare), rows: compareReplays(JSON.parse(await readFile(opts.compare, 'utf8')), results) };
	await writeFile(out, JSON.stringify(results, null, 2) + '\n');
	console.log(`${results.summary.survived}/${results.summary.incidents} survived, ${results.summary.died} died, ${results.summary.errors} errors; ${out}`);
	for (const row of results.comparison?.rows ?? []) console.log(`  ${row.id}: ${row.old} -> ${row.new}${row.old !== row.new ? '  CHANGED' : ''}`);
	process.exit(0);
}
