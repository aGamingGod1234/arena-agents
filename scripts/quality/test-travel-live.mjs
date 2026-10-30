#!/usr/bin/env node
// Provider-free Nether travel courses: node scripts/quality/test-travel-live.mjs COURSES.json OUT_DIR --mode navigate|travel [--jar JAR] [--only ID,...] [--checkpoints DIR] [--budget MINUTES]
// Each course starts from a long-run save point (seed, dimension, position, inventory) and heads for a target: the nearest
// structure or biome of a kind (vanilla /locate, run by this test only and never shown to the body), a heading and
// distance, or an exact cell {x,y,z,tolerance} (arrival there also needs the feet within heightTolerance, default 0.6, of y).
// One server boots per seed; the body is reset from the save point before every course. No model call is made:
//   navigate  a scripted stand-in for the model's navigate_to legs: look toward the target, then navigate_to the seen
//             landmark (observation.landmarks) that gets closest to the target 6-28 blocks away, else a point 20 blocks
//             along the bearing; repeat until arrival, the course budget or 12 legs in a row without progress.
//   travel    travel_to toward the target, re-issued after each stop that leaves the body able to go on.
// Reports per course: arrival, wall time, horizontal progress toward the target per minute, path length, the action
// results by reason, damage taken, fire and lava contact (sampled every 0.5 s) and deaths. Launch under slot.sh live
// (SLOT_PORT_BASE) with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup, parseLocatedPosition } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { boot } from './watch-replay.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
const [coursesFile, outArg] = argv.filter((value, i) => !value.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const mode = flag('--mode', 'travel');
const jar = path.resolve(flag('--jar', path.join(root, 'build/libs/arena-agents-0.2.0.jar')));
const only = flag('--only', null)?.split(',');
const checkpointDir = flag('--checkpoints', null);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!coursesFile || !outArg || !template || !port || !process.env.JAVA_HOME || !['navigate', 'travel'].includes(mode)) {
	throw new Error('Usage: COURSES.json OUT_DIR --mode navigate|travel [--jar JAR] [--only IDS] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
}
const spec = JSON.parse(await readFile(coursesFile, 'utf8'));
const courses = spec.courses.filter(course => !only || only.includes(course.id));
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const AGENT = 'Probe';
const COURSE_BUDGET_MS = Number(flag('--budget', spec.budgetMinutes ?? 12)) * 60_000;
const ARRIVAL = spec.arrivalBlocks ?? 16;
// Plain building blocks a stand-in model would move to the hotbar (travel_to's own choice of blocks is the server's).
const BLOCKS = /^minecraft:(netherrack|cobblestone|cobbled_deepslate|blackstone|basalt|smooth_basalt|dirt|stone|deepslate|andesite|diorite|granite|tuff|end_stone|[a-z_]+_planks)$/;

const results = [];
const bySeed = new Map();
// The server a course runs on is stopped on every way out, so a killed or failed run never leaves one behind.
let current = null;
const stopServer = () => { try { current?.child?.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('SIGTERM', () => { stopServer(); process.exit(143); });
process.on('SIGINT', () => { stopServer(); process.exit(130); });
process.on('exit', stopServer);
process.on('unhandledRejection', error => console.error(`unhandled: ${error?.message ?? error}`));
for (const course of courses) {
	const checkpoint = JSON.parse(await readFile(path.resolve(checkpointDir ?? spec.checkpointDir ?? path.dirname(coursesFile), course.checkpoint), 'utf8'));
	course.loaded = checkpoint;
	if (!bySeed.has(checkpoint.seed)) bySeed.set(checkpoint.seed, []);
	bySeed.get(checkpoint.seed).push(course);
}

/** One action with a long result wait (travel_to runs for minutes). */
async function act(s, type, args, waitMs) {
	const id = `course-${++s.ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: s.record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: s.record.provider, model: s.record.model, reasoningEffort: s.record.reasoningEffort, serviceTier: s.record.serviceTier, traceId: id, programId: 'travel-course', programVersion: 1, sourceStepId: id, eventSequence: s.observation?.eventSequence ?? 0 } };
	const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), waitMs);
	try { await s.bridge.send('action_command', s.record.agentId, payload); } catch (error) { next.catch(() => {}); throw error; }
	const result = (await next).payload;
	await s.bridge.send('action_result_ack', s.record.agentId, { actionId: id, goalRevision: s.record.goalRevision });
	return result;
}

async function registerAgent(s) {
	let e = null, summon = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
		summon = await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${summon}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
}

/**
 * The first ready observation made after this request. (watch-replay's observe waits for a higher event sequence, which
 * an idle body on a jar that raises no new events never sends.)
 */
async function observe(s) {
	for (let attempt = 1; ; attempt++) {
		// A dead body sends only PLAYER_DEAD observations, never a ready one.
		if (s.seen?.at(-1)?.status === 'PLAYER_DEAD') throw new Error('PLAYER_DEAD');
		const sentAt = Date.now();
		const next = s.inbox.wait('observation', e => e.agentId === s.record.agentId && e.payload.ready
			&& (e.payload.observedAtEpochMs ?? 0) >= sentAt - 50, 15_000);
		try { await s.bridge.send('request_observation', s.record.agentId, { goalRevision: s.record.goalRevision }); } catch (error) { next.catch(() => {}); throw error; }
		try { const observation = (await next).payload; s.observation = observation; return observation; } catch (error) { if (attempt >= 3) throw error; }
	}
}

const horizontal = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
// A cell target also counts the height left; the other targets are horizontal only.
const remaining = (at, target) => Number.isFinite(target.y) ? Math.hypot(horizontal(at, [target.x, 0, target.z]), at[1] - target.y) : horizontal(at, [target.x, 0, target.z]);
const arrivedAt = (at, target) => Number.isFinite(target.y)
	? horizontal(at, [target.x, 0, target.z]) <= target.tolerance && Math.abs(at[1] - target.y) <= target.heightTolerance
	: horizontal(at, [target.x, 0, target.z]) <= ARRIVAL;
const positionOf = observation => observation?.position ? [observation.position.x, observation.position.y, observation.position.z] : null;

async function locateTarget(s, course, start, dim) {
	if (course.target.type === 'heading') {
		const yaw = course.target.yaw * Math.PI / 180;
		return { x: start[0] - Math.sin(yaw) * course.target.distance, z: start[2] + Math.cos(yaw) * course.target.distance, located: `heading ${course.target.yaw} ${course.target.distance}` };
	}
	if (course.target.type === 'cell') {
		const { x, y, z, tolerance = 3, heightTolerance = 0.6 } = course.target;
		return { x, y, z, tolerance, heightTolerance, located: `cell ${x} ${y} ${z} tolerance ${tolerance}` };
	}
	const kind = course.target.type === 'biome' ? 'biome' : 'structure';
	const text = await s.command(`execute in ${dim} positioned ${start.map(Math.floor).join(' ')} run locate ${kind} ${course.target.id}`);
	const [x, z] = parseLocatedPosition(text);
	return { x: x + 0.5, z: z + 0.5, located: String(text) };
}

/** The scripted stand-in for model-chosen navigate_to legs. */
async function navigateLeg(s, target, run) {
	const here = positionOf(await observe(s));
	const bearing = Math.atan2(target.z - here[2], target.x - here[0]);
	// Look toward the target first, as a model's lookAround would, so the landmarks cover that way.
	await act(s, 'look_at', { x: here[0] + Math.cos(bearing) * 20, y: here[1] - 2, z: here[2] + Math.sin(bearing) * 20 }, 20_000).catch(() => null);
	await sleep(300);
	const observation = await observe(s);
	const at = positionOf(observation);
	const before = horizontal(at, [target.x, 0, target.z]);
	let best = null;
	const failed = top => run.failedLegs.some(f => Math.hypot(f[0] - top[0], f[1] - top[1], f[2] - top[2]) <= 2.5);
	for (const row of observation.landmarks ?? []) {
		if (!Number.isFinite(row.x) || /lava|fire|magma|air/.test(row.blockId)) continue;
		const top = [row.x + 0.5, row.y + 1, row.z + 0.5];
		const reach = horizontal(top, at);
		if (reach < 6 || reach > 28 || Math.abs(top[1] - at[1]) > 12) continue;
		const left = horizontal(top, [target.x, 0, target.z]);
		if (left < before - 2 && !failed(top) && (!best || left < best.left)) best = { top, left };
	}
	// With no landmark left, a point 20 blocks out, turning further from the bearing after each failure there.
	const turn = [0, 30, -30, 60, -60, 90, -90][run.bearingTries++ % 7] * Math.PI / 180;
	const destination = best?.top ?? [at[0] + Math.cos(bearing + turn) * 20, at[1], at[2] + Math.sin(bearing + turn) * 20];
	run.legChoices[best ? 'landmark' : 'bearing'] += 1;
	const result = await act(s, 'navigate_to', { x: destination[0], y: destination[1], z: destination[2], tolerance: 1, sprint: true, timeoutMs: 30_000 }, 45_000);
	// A model reads the failure and does not send the same leg again.
	if (result.state !== 'SUCCEEDED') run.failedLegs.push(destination);
	else run.bearingTries = 0;
	return result;
}

async function travelLeg(s, target, run, remainingMs) {
	const args = { x: target.x, z: target.z, ...(Number.isFinite(target.y) ? { y: target.y, tolerance: target.tolerance } : { tolerance: ARRIVAL }), timeoutMs: Math.max(5_000, Math.min(600_000, remainingMs)),
		...(run.stopWhenSeen ? { stopWhenSeen: run.stopWhenSeen } : {}), ...(typeof run.build === 'boolean' ? { build: run.build } : {}) };
	return act(s, 'travel_to', args, args.timeoutMs + 30_000);
}

async function runCourse(s, course) {
	const checkpoint = course.loaded;
	const dim = checkpoint.setup.dimension;
	// A body that died on the previous course respawns first (setup teleports and equips a living player).
	if (s.dead) {
		await act(s, 'respawn', {}, 30_000).catch(() => null);
		await sleep(2000);
		s.dead = false;
	}
	// A save point's portal-frame fills find nothing to replace when the terrain there is already open; that is done.
	const command = async text => { const reply = String(await s.command(text)); return { text: /No blocks were filled/.test(reply) ? 'Filled 0 blocks' : reply }; };
	await s.command(`effect clear ${AGENT}`);
	await s.command(`clear ${AGENT}`);
	const receipt = await applyQualitySetup(checkpoint.setup, command, AGENT);
	await activateQualitySetup(receipt, command, { stage: 'goal-start' });
	await activateQualitySetup(receipt, command, { stage: 'first-decision' });
	await s.command('tick unfreeze').catch(() => {});
	await s.command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
	await s.command(`effect give ${AGENT} minecraft:instant_health 1 10 true`);
	await s.command(`scoreboard players set ${AGENT} deaths 0`);
	await sleep(1500);
	const startObservation = await observe(s);
	const start = positionOf(startObservation);
	const target = await locateTarget(s, course, start, dim);
	const run = { id: course.id, mode, checkpoint: course.checkpoint, target: { x: round(target.x), ...(Number.isFinite(target.y) ? { y: target.y } : {}), z: round(target.z), located: target.located }, start: start.map(v => round(v, 2)),
		startDistance: round(remaining(start, target)), legChoices: { landmark: 0, bearing: 0 }, failedLegs: [], bearingTries: 0, detours: 0, stopWhenSeen: course.stopWhenSeen ?? null, build: course.build, results: {}, actions: 0, failures: 0,
		damage: 0, actionDamage: 0, actionDamageEvents: 0, minHealth: 20, fireSamples: 0, lavaSamples: 0, deaths: 0, path: 0, stops: [] };
	// The optional idle probe also counts vanilla damage statistics, so regeneration cannot hide a hit.
	let damageScore = null, damageScoreInitial = null;
	if (Number.isFinite(course.afterStopWatchMs) && course.afterStopWatchMs > 0) {
		run.damageStatisticReceipt = await s.command('scoreboard objectives add d38_damage minecraft.custom:minecraft.damage_taken');
		damageScore = async () => {
			const text = String(await s.command(`scoreboard players get ${AGENT} d38_damage`));
			const match = /has (-?\d+) \[d38_damage\]/.exec(text);
			if (match) return Number(match[1]);
			if (text.includes('none is set')) return 0;
			throw new Error(`Cannot read diagnostic damage statistic: ${text.slice(0, 180)}`);
		};
		damageScoreInitial = await damageScore();
	}
	const clockObservation = await observe(s);
	const startGameTick = clockObservation.world?.gameTime;
	let lastGameTick = startGameTick;
	const startedAt = Date.now();
	let last = start, health = startObservation.player?.health ?? 20, sampling = true, noProgress = 0;
	// Health, fire and lava sampled beside the actions (observations are answered while an action runs).
	const sampler = (async () => {
		while (sampling) {
			const o = await observe(s).catch(() => null);
			if (Number.isFinite(o?.world?.gameTime)) lastGameTick = o.world.gameTime;
			if (o?.player) {
				const p = positionOf(o);
				if (p) { run.path += horizontal(p, last); last = p; }
				if (o.player.health < health) run.damage += health - o.player.health;
				health = o.player.health;
				run.minHealth = Math.min(run.minHealth, health);
				if (o.player.onFire) run.fireSamples += 1;
				if (o.player.inLava) run.lavaSamples += 1;
			}
			await sleep(500);
		}
	})();
	// A dead body's observations say PLAYER_DEAD (the scoreboard objective did not count every death).
	const deathCount = async () => s.seen.at(-1)?.status === 'PLAYER_DEAD' ? Math.max(1, run.deaths)
		: Number(/has (\d+) \[deaths\]/.exec(String(await s.command(`scoreboard players get ${AGENT} deaths`)))?.[1] ?? 0);
	try {
		try {
		while (Date.now() - startedAt < COURSE_BUDGET_MS) {
			if (await deathCount() > 0) { run.deaths = await deathCount(); s.dead = true; break; }
			const here = positionOf(await observe(s));
			if (arrivedAt(here, target)) break;
			const before = remaining(here, target);
			let result;
			try {
				result = mode === 'navigate' ? await navigateLeg(s, target, run) : await travelLeg(s, target, run, COURSE_BUDGET_MS - (Date.now() - startedAt));
			} catch (error) {
				// A body that died mid-leg answers no observation; count the death, anything else is a harness error.
				if (await deathCount() > 0) { run.deaths = await deathCount(); s.dead = true; break; }
				throw error;
			}
			run.actions += 1;
			const reportedDamage = /^Took ([\d.]+) damage \(/.exec(String(result.message ?? ''));
			if (reportedDamage) { run.actionDamage += Number(reportedDamage[1]); run.actionDamageEvents++; }
			const key = `${result.state} ${result.reasonCode}`;
			run.results[key] = (run.results[key] ?? 0) + 1;
			if (result.state !== 'SUCCEEDED') run.failures += 1;
			if (mode === 'travel') {
				run.stops.push({ at: round((Date.now() - startedAt) / 1000), state: result.state, reasonCode: result.reasonCode, message: String(result.message ?? '').slice(0, 600) });
				if (process.env.TRAVEL_VERBOSE) console.log(JSON.stringify(run.stops.at(-1)));
			}
			else if (result.state !== 'SUCCEEDED') run.stops.push({ reasonCode: result.reasonCode, message: String(result.message ?? '').slice(0, 300) });
			const deaths = await deathCount();
			if (deaths > 0) { run.deaths = deaths; s.dead = true; break; }
			if (result.reasonCode === 'TARGET_SEEN') { run.targetSeen = String(result.message).split(';')[0]; break; }
			// Standing in for the model on a hostile stop: the mob is removed (counted) and the trip goes on.
			const hostile = result.reasonCode === 'HOSTILE_NEAR' ? /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(String(result.message))?.[0] : null;
			if (hostile) { run.hostilesRemoved = (run.hostilesRemoved ?? 0) + 1; await s.command(`kill ${hostile}`); continue; }
			// Out of blocks with more in the main inventory: the stand-in model swaps a stack onto the hotbar, as select_tool lets it.
			if (result.reasonCode === 'OUT_OF_BLOCKS' && /in the main inventory/.test(String(result.message))) {
				const items = (await observe(s)).inventory?.items ?? [];
				const stack = items.filter(item => item.slot >= 9 && item.slot < 36 && BLOCKS.test(item.itemId)).sort((a, b) => b.count - a.count)[0];
				if (stack) {
					const swap = await act(s, 'select_tool', { sourceSlot: stack.slot, hotbarSlot: 8, expectedItemId: stack.itemId, minRemainingDurability: 0 }, 20_000);
					run.blockSwaps = (run.blockSwaps ?? 0) + 1;
					if (swap.state === 'SUCCEEDED') continue;
				}
			}
			// A better tool in the main inventory: the stand-in model moves a pickaxe to the hotbar, as select_tool lets it.
			if (/better tool is in the main inventory/.test(String(result.message)) && (run.toolSwaps ?? 0) < 3) {
				const items = (await observe(s)).inventory?.items ?? [];
				const pick = items.filter(item => item.slot >= 9 && item.slot < 36 && /_pickaxe$/.test(item.itemId)).sort((a, b) => /netherite|diamond|iron/.test(b.itemId) - /netherite|diamond|iron/.test(a.itemId))[0];
				if (pick) {
					const swap = await act(s, 'select_tool', { sourceSlot: pick.slot, hotbarSlot: 7, expectedItemId: pick.itemId, minRemainingDurability: 1 }, 20_000);
					run.toolSwaps = (run.toolSwaps ?? 0) + 1;
					if (swap.state === 'SUCCEEDED') continue;
				}
			}
			// After a burn the stand-in model lets the flames go out before setting off again.
			if (['TRAVEL_DAMAGED', 'ON_FIRE', 'IN_LAVA'].includes(result.reasonCode)) {
				for (let i = 0; i < 16 && (await observe(s)).player?.onFire; i++) await sleep(1000);
			}
			// No way on (or lava came at it): the stand-in model tries one detour heading (60 degrees off, alternating sides)
			// before going on.
			if (mode === 'travel' && ['NO_ROUTE', 'BUILD_FAILED', 'LAVA_INCOMING', 'TUNNEL_FLOODED'].includes(result.reasonCode) && run.detours < 4) {
				const at = positionOf(await observe(s));
				const bearing = Math.atan2(target.z - at[2], target.x - at[0]) + (run.detours % 2 === 0 ? 1 : -1) * Math.PI / 3;
				run.detours += 1;
				const detour = await act(s, 'travel_to', { x: at[0] + Math.cos(bearing) * 30, z: at[2] + Math.sin(bearing) * 30, tolerance: 4, timeoutMs: 60_000, ...(typeof run.build === 'boolean' ? { build: run.build } : {}) }, 90_000);
				run.actions += 1;
				run.results[`${detour.state} ${detour.reasonCode} (detour)`] = (run.results[`${detour.state} ${detour.reasonCode} (detour)`] ?? 0) + 1;
				run.stops.push({ at: round((Date.now() - startedAt) / 1000), state: detour.state, reasonCode: detour.reasonCode, detour: true, message: String(detour.message ?? '').slice(0, 400) });
			}
			const after = positionOf(await observe(s));
			noProgress = remaining(after, target) < before - 2 ? 0 : noProgress + 1;
			if (noProgress >= (mode === 'navigate' ? 12 : 3)) { run.gaveUp = `no progress over ${noProgress} actions`; break; }
		}
		} catch (error) {
			if (String(error?.message) !== 'PLAYER_DEAD' && await deathCount() === 0) throw error;
			run.deaths = Math.max(1, run.deaths);
			s.dead = true;
		}
	} finally {
		if (Number.isFinite(course.afterStopWatchMs) && course.afterStopWatchMs > 0 && !s.dead) {
			const damageBefore = run.damage, healthBefore = health, statBefore = await damageScore();
			await sleep(course.afterStopWatchMs);
			const statAfter = await damageScore();
			run.damageTakenDeci = statAfter - damageScoreInitial;
			run.idleWatch = { durationMs: course.afterStopWatchMs, damage: run.damage - damageBefore, healthBefore, healthAfter: health, damageTakenDeci: statAfter - statBefore,
				position: last, note: "No further actions during this interval; diagnostic only, excluded from original course bar" };
			if (await deathCount() > 0) { run.deaths = Math.max(1, run.deaths); s.dead = true; }
		}
		sampling = false;
		await sampler;
	}
	const endObservation = s.dead ? null : await observe(s);
	const end = s.dead ? last : positionOf(endObservation);
	if (Number.isFinite(endObservation?.world?.gameTime)) lastGameTick = endObservation.world.gameTime;
	const endedAt = Date.now();
	const wallMs = endedAt - startedAt;
	delete run.failedLegs;
	// Sampling can miss a hit followed by regeneration inside 500 ms. These two measurements overlap.
	run.damageLowerBound = Math.max(run.damage, run.actionDamage);
	run.end = end.map(v => round(v, 2));
	run.endDistance = round(remaining(end, target));
	if (Number.isFinite(target.y)) run.endHeightOffset = round(end[1] - target.y, 2);
	run.arrived = arrivedAt(end, target) || run.targetSeen !== undefined;
	run.wallSeconds = round(wallMs / 1000);
	run.progressBlocks = round(run.startDistance - run.endDistance);
	run.blocksPerMinute = round(run.progressBlocks / (wallMs / 60_000));
	run.startedAtEpochMs = startedAt;
	run.endedAtEpochMs = endedAt;
	run.gameTicks = Number.isFinite(startGameTick) && Number.isFinite(lastGameTick) ? Math.max(0, lastGameTick - startGameTick) : null;
	run.gameSeconds = run.gameTicks === null ? null : run.gameTicks / 20;
	run.observedTicksPerSecond = run.gameTicks === null ? null : round(run.gameTicks / (wallMs / 1000), 2);
	run.blocksPerGameMinute = run.gameTicks > 0 ? round(run.progressBlocks / (run.gameTicks / 1200)) : null;
	run.gameClockSource = s.dead ? 'last alive observation; death may omit the final sampling interval' : 'ready observation world.gameTime';
	run.pathBlocks = round(run.path);
	// The same legs with the model choosing each one: Sol took about 5 s per call on Oct 23.
	run.blocksPerMinuteWithModel5s = round(run.progressBlocks / ((wallMs + run.actions * 5_000) / 60_000));
	return run;
}

for (const [seed, group] of bySeed) {
	const dir = path.join(out, `seed-${seed}`);
	await mkdir(dir, { recursive: true });
	const s = await boot(dir, { jar, template, port, world: null, seed, goalTicks: 20 * 60 * 60 * 4, bridgeReadyMs: 180_000 });
	current = s;
	try {
		// Diagnostics for a course that errors: what the server last sent.
		s.seen = []; s.results = [];
		s.bridge.on('observation', e => { if (e.agentId === s.record?.agentId) { s.seen.push({ at: Date.now(), ready: e.payload.ready, status: e.payload.status, seq: e.payload.eventSequence, health: e.payload.player?.health }); if (s.seen.length > 50) s.seen.shift(); } });
		s.bridge.on('action_result', e => { s.results.push({ at: Date.now(), actionId: e.payload.actionId, state: e.payload.state, reasonCode: e.payload.reasonCode }); if (s.results.length > 20) s.results.shift(); });
		// Follow goal revisions (a death and respawn bump them), as test-fire-live does.
		s.bridge.on('message', (event) => {
			const control = event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null;
			if (control == null || event.agentId !== s.record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= s.record.goalRevision) return;
			if (['queue', 'dequeue'].includes(control.operation)) return;
			s.record.goalRevision = control.goalRevision;
			s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
		});
		await registerAgent(s);
		await s.command('difficulty normal');
		await s.command('gamerule minecraft:do_daylight_cycle false').catch(() => {});
		// Terrain is what the courses measure; mobs the world generated still appear and are handled as stops.
		await s.command('gamerule minecraft:spawn_mobs false').catch(() => {});
		await s.command('gamerule doMobSpawning false').catch(() => {});
		for (const course of group) {
			try {
				const run = await runCourse(s, course);
				results.push(run);
				console.log(JSON.stringify({ id: run.id, arrived: run.arrived, wallSeconds: run.wallSeconds, blocksPerMinute: run.blocksPerMinute, startDistance: run.startDistance, endDistance: run.endDistance, failures: run.failures, actions: run.actions, deaths: run.deaths, damage: run.damage, fire: run.fireSamples, lava: run.lavaSamples }));
			} catch (error) {
				results.push({ id: course.id, mode, error: String(error?.stack ?? error), lastObservations: s.seen.slice(-12), lastResults: s.results.slice(-6) });
				console.log(JSON.stringify({ id: course.id, error: String(error?.message ?? error) }));
			}
			await writeFile(path.join(out, 'results.json'), JSON.stringify({ mode, jar, results }, null, 2));
		}
	} finally {
		await s.stop().catch(() => {});
		// Worlds are large and only the results matter.
		if (!process.env.KEEP_WORLDS) {
			try {
				await rm(path.join(dir, 'server'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
			} catch (error) {
				if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
				// Windows can retain a working-directory/file handle briefly after the server stops. Keep completed measurements.
				await writeFile(path.join(dir, 'cleanup-warning.json'), JSON.stringify({ code: error.code, message: error.message, retained: path.join(dir, 'server') }, null, 2));
				console.warn(`World cleanup retained a busy directory: ${error.code}`);
			}
		}
	}
}
await writeFile(path.join(out, 'results.json'), JSON.stringify({ mode, jar, results }, null, 2));
console.log(JSON.stringify(results.map(r => ({ id: r.id, arrived: r.arrived, bpm: r.blocksPerMinute, wall: r.wallSeconds, results: r.results })), null, 1));
