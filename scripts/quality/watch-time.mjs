#!/usr/bin/env node
// Where the time went: node scripts/quality/watch-time.mjs ARTIFACT_DIR... [--out DIR] [--min 5]
//
// Joins the mod's progress truth (arena-watch/<agentId>-progress.jsonl: real nearest targets, whether a player could
// perceive them and whether the observation carried them, action results) with the plan step timeline replayed through
// the production task view (focus step, its check and every measurable gain, as progress-replay.mjs), the wakes the
// coordinator really sent (coordinator.jsonl), the actions and results (quality-protocol.jsonl) and the model's tool calls
// and intents (provider-turns.private.jsonl). A time episode is a stretch of --min (5) minutes or more in which neither
// the focus step's check metric nor the true distance to its target improved. Each gets the minutes lost, what Sol did,
// and one cause label from TIME_RULES with its evidence. Runs without progress lines are read in degraded mode: labels
// that need the truth are skipped, and an episode no other rule explains is UNKNOWN_TRUTH.
// Writes watch-time.json and watch-time.md (default: the single artifact dir, else the current directory). Reads only.
import { createReadStream, existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parsePlanCheck, planProgress } from '../../coordinator/src/plan-checks.mjs';
import { replay } from './progress-replay.mjs';
import { findWatchDirs, parseWatchLines } from './watch-files.mjs';

export const EPISODE_MIN = 5;
export const SAMPLE_MS = 5_000;
/** A new best true distance this much closer to the focus target counts as progress (walking or digging toward it). */
export const TRUTH_IMPROVE_BLOCKS = 16;
/** Beyond this the target counts as far: a player would have to search or travel for it. */
export const FAR_BLOCKS = 48;
/** A remembered target farther than this from the body is not "known nearby". */
export const KNOWN_BLOCKS = 64;
/** Same failure this many times in a stretch, and at least this share of that action's results: the body keeps failing. */
export const FAILURE_COUNT = 8, FAILURE_SHARE = 0.3;
/** Walked or dug this much in a stretch: the body was searching, not idle. */
export const SEARCH_WALKED = 64, SEARCH_BROKEN = 32;
export const PROGRESS_WAKES = ['no_progress', 'repeated_result'];
/** Labels that name a system part to fix; the others are logged only. */
export const SYSTEM_LABELS = ['TARGET_UNSEEN', 'BODY_FAILING', 'PLAN_NO_CHECK', 'WAKE_IGNORED', 'SLOW_BODY'];
export const LABELS = [...SYSTEM_LABELS, 'TARGET_FAR', 'MODEL_CHOICE', 'UNKNOWN_TRUTH'];

/** Which observation or truth row names which target (the mod's ProgressWatch.deliveredKind, same table). */
export function deliveredKind(text) {
	if (typeof text !== 'string') return null;
	if (text.endsWith('iron_ore')) return 'iron';
	return { 'minecraft:lava': 'lava', 'minecraft:gravel': 'gravel', 'minecraft:obsidian': 'obsidian', 'minecraft:nether_portal': 'nether_portal', 'minecraft:spawner': 'blaze_spawner',
		'minecraft:end_portal_frame': 'portal_room', 'minecraft:nether_bricks': 'fortress', 'minecraft:nether_brick_fence': 'fortress', fortress: 'fortress', 'nether fortress': 'fortress',
		'minecraft:fortress': 'fortress', stronghold: 'stronghold', 'minecraft:stronghold': 'stronghold', 'minecraft:end_crystal': 'crystals', 'minecraft:ender_dragon': 'dragon' }[text] ?? null;
}

/** Vanilla: cave air below y-54 is lava. A depth term this deep or deeper is the lava-floor descent. */
export const LAVA_FLOOR_DEPTH_Y = -50;

/**
 * The targets whose true distance measures a step, from its check terms. A shallow depth term has none (y is its own
 * metric); a lava-floor depth term is measured by the watcher's lava_floor (depth left, then the nearest floor lava).
 */
export function stepTargets(check) {
	let parsed;
	try { parsed = check ? parsePlanCheck(check) : null; } catch { parsed = null; }
	if (!parsed) return [];
	const out = new Set();
	for (const t of parsed.terms) {
		const ids = t.type === 'has' ? t.ids.join(' ') : t.id ?? '';
		if (t.type === 'has' && /iron|bucket|shield/.test(ids) || t.type === 'tool' && t.tier === 'iron' || t.type === 'worn' && t.tier === 'iron') out.add('iron');
		if (t.type === 'has' && /obsidian/.test(ids) || t.type === 'frame') { out.add('lava_pool'); out.add('obsidian'); }
		if (t.type === 'has' && /flint/.test(ids)) out.add('gravel');
		if (t.type === 'lava') out.add('lava_pool');
		if (t.type === 'y' && ['<=', '<'].includes(t.op) && t.value <= LAVA_FLOOR_DEPTH_Y) out.add('lava_floor');
		if (t.type === 'has' && /blaze|ender_eye/.test(ids) || t.type === 'seen' && /fortress|spawner/.test(ids)) { out.add('blaze_spawner'); out.add('fortress'); }
		if (['in', 'visited'].includes(t.type) && ids === 'minecraft:the_nether') { out.add('nether_portal'); out.add('lava_pool'); out.add('obsidian'); }
		if (t.type === 'seen' && /stronghold/.test(ids) || ['in', 'visited'].includes(t.type) && ids === 'minecraft:the_end') { out.add('portal_room'); out.add('stronghold'); }
		if (t.type === 'crystals') out.add('crystals');
		if (t.type === 'killed' && /ender_dragon/.test(ids)) out.add('dragon');
	}
	return [...out];
}

/** Term types with a measurable value the progress clock can see move (tool steps move with their requirement chain). */
const MEASURED = new Set(['has', 'y', 'lava', 'frame', 'crystals', 'worn', 'tool']);
/** Whether a check has a term whose value can improve before it is met; in:/seen:/killed:/adv: alone are all-or-nothing. */
export function measurable(check) {
	try { return Boolean(check) && parsePlanCheck(check).terms.some(t => MEASURED.has(t.type)); } catch { return false; }
}

/** From one progress line: true distance, perceivable-but-unobserved, absent-or-far, and known for a target kind. */
export function truthOf(line, kind) {
	const t = line?.targets?.[kind];
	if (t === undefined) return null;
	if (t === null) return { dist: null, unseen: false, far: true, hidden: false, known: null };
	const pick = (dist, perceivable, inObservation, known) => ({ dist: Number.isFinite(dist) ? dist : null, unseen: perceivable === true && inObservation === false,
		far: !Number.isFinite(dist) || dist > FAR_BLOCKS, hidden: Number.isFinite(dist) && dist <= FAR_BLOCKS && perceivable !== true, known: Number.isFinite(known) ? known : null });
	switch (kind) {
		case 'lava_pool': return pick(t.pool?.dist, t.pool?.perceivable, t.pool?.inObservation, t.known?.dist ?? (t.pool?.inObservation ? t.pool.dist : null));
		case 'fortress': case 'stronghold': {
			// Fortress walls (nether bricks) in sight are how a player perceives one; the start box gives its distance.
			const walls = t.walls?.perceivable;
			return pick(t.dist ?? t.walls?.nearest?.dist, walls ? true : undefined, walls?.inObservation, t.walls?.known?.dist ?? null);
		}
		// Until floor lava is in the scan, the blocks left to descend are the distance (far while more than 48).
		case 'lava_floor': return t.nearest ? pick(t.nearest.dist, t.nearest.perceivable, t.nearest.inObservation, t.nearest.inObservation ? t.nearest.dist : null)
			: pick(t.depth, undefined, undefined, null);
		case 'crystals': return pick(t.nearest?.dist, t.nearest?.perceivable, t.nearest?.inObservation, t.nearest?.inObservation ? t.nearest.dist : null);
		case 'dragon': return pick(t.dist, t.perceivable, t.inObservation, t.inObservation ? t.dist : null);
		default: return pick(t.nearest?.dist, t.perceivable ? true : undefined, t.perceivable?.inObservation, t.known?.dist ?? (t.perceivable?.inObservation ? t.perceivable.dist : null));
	}
}

// ---- Reading a run ----

/** Artifact dirs (holding quality-protocol.jsonl) under the given paths; a long-run output dir names its artifacts. */
export async function findArtifactDirs(dir, depth = 5) {
	if (existsSync(path.join(dir, 'quality-protocol.jsonl'))) return [dir];
	const report = path.join(dir, 'run', 'LONG-r1.json');
	if (existsSync(report)) { try { const art = JSON.parse(await readFile(report, 'utf8')).artifacts; if (art && existsSync(art)) return [art]; } catch { /* unreadable report */ } }
	if (depth <= 0) return [];
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory() || ['server', 'provider-workspaces', 'node_modules', 'world', 'arena-watch', 'logs', 'traces'].includes(entry.name)) continue;
		found.push(...await findArtifactDirs(path.join(dir, entry.name), depth - 1));
	}
	return found;
}

async function* lines(file, filter = null) {
	if (!existsSync(file)) return;
	for await (const line of readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
		if (!line || filter && !filter(line)) continue;
		try { yield JSON.parse(line); } catch { /* a half-written last line */ }
	}
}

/** Progress truth lines for the run, from its artifact copy or its server dir. */
export async function readProgress(dir) {
	const out = [];
	for (const watchDir of await findWatchDirs(dir, 1)) {
		for (const name of (await readdir(watchDir).catch(() => [])).sort()) {
			if (!name.endsWith('-progress.jsonl')) continue;
			out.push(...parseWatchLines(await readFile(path.join(watchDir, name), 'utf8')).rows.filter(r => r.type === 'progress'));
		}
	}
	return out.sort((a, b) => a.atMs - b.atMs);
}

/** Wakes the coordinator really raised for plan progress: native_event_ready with a no_progress or repeated_result trigger. */
export async function readWakes(dir) {
	const out = [];
	for await (const row of lines(path.join(dir, 'coordinator.jsonl'), line => line.includes('native_event_ready') && PROGRESS_WAKES.some(w => line.includes(w)))) {
		if (row.event === 'native_event_ready' && PROGRESS_WAKES.includes(row.trigger)) out.push({ at: row.at, trigger: row.trigger, agentId: row.agentId });
	}
	return out;
}

/** The model's tool calls (name and time) and stated intents, from provider-turns. */
export async function readToolCalls(dir) {
	const calls = [], intents = [];
	for await (const row of lines(path.join(dir, 'provider-turns.private.jsonl'), line => line.includes('"toolCalls"'))) {
		for (const call of row.capture?.calls ?? []) for (const tool of call.toolCalls ?? []) {
			const at = tool.at ?? call.endedAt ?? row.timestamp;
			calls.push({ at, name: tool.name });
			if (tool.name !== 'taskPlan') continue;
			let args; try { args = JSON.parse(tool.arguments); } catch { continue; }
			if (args?.operation === 'intent' && args.intent) intents.push({ at, step: args.intent.step, why: String(args.intent.why ?? '') });
		}
	}
	return { calls: calls.sort((a, b) => a.at - b.at), intents: intents.sort((a, b) => a.at - b.at) };
}

function positionOf(o) {
	const at = o?.position ?? o?.player?.position ?? o?.player;
	return at && [at.x, at.y, at.z].every(Number.isFinite) ? { x: at.x, y: at.y, z: at.z } : null;
}

/** Rows naming a target kind with a position, anywhere in an observation. */
export function observedTargets(element, out = [], depth = 0) {
	if (element === null || typeof element !== 'object' || depth > 12) return out;
	if (Array.isArray(element)) { for (const item of element) { if (item === null || typeof item !== 'object') return out; observedTargets(item, out, depth + 1); } return out; }
	let kind = null;
	for (const key of ['blockId', 'type', 'structure', 'id']) if ((kind = deliveredKind(element[key]))) break;
	if (kind) {
		const at = Number.isFinite(element.x) ? element : element.position;
		if (at && [at.x, at.y, at.z].every(Number.isFinite)) out.push({ kind, x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) });
	}
	for (const [key, value] of Object.entries(element)) if (key !== 'tags' && key !== 'bounds' && value && typeof value === 'object') observedTargets(value, out, depth + 1);
	return out;
}

/** The focus step as the task view's progress clock follows it: the intent's unfinished step, else the first open one. */
export function focusStep(plan, intent) {
	if (!plan?.steps?.length) return null;
	const intended = plan.steps.find(s => s.id === intent?.step && s.status !== 'complete');
	if (intended) return intended;
	const open = planProgress(plan)?.open ?? [];
	return plan.steps.find(s => open.includes(s.id)) ?? null;
}

const MAX_KNOWN = 3000;

/** Replays one artifact dir into a run record: samples every SAMPLE_MS, gains, actions, results, wakes, tool calls, truth. */
export async function collectRun(dir) {
	const samples = [], commands = [], results = [], known = new Map();
	let lastSample = -Infinity, dim = null, dead = false, deaths = 0, agentId = null;
	const remember = (kind, cell) => {
		let cells = known.get(kind); if (!cells) known.set(kind, cells = new Map());
		const key = `${cell.dim}|${cell.x},${cell.y},${cell.z}`;
		cells.delete(key); cells.set(key, cell);
		if (cells.size > MAX_KNOWN) cells.delete(cells.keys().next().value);
	};
	const replayed = await replay(dir, {
		onCommand: (payload, at) => commands.push({ at, actionType: payload.actionType }),
		onResult: (payload, command, at) => results.push({ at, actionType: command.actionType, state: payload.state, reasonCode: payload.reasonCode ?? null }),
		onObservation: ({ at, wire, observation, views, record }) => {
			dim = observation.world?.dimension ?? wire.world?.dimension ?? dim;
			for (const row of observedTargets(wire)) remember(row.kind, { ...row, dim, at });
			const isDead = observation.player?.dead === true;
			if (isDead && !dead) deaths++;
			dead = isDead;
			if (at - lastSample < SAMPLE_MS) return;
			lastSample = at;
			const snapshot = views.snapshot(record), focus = focusStep(snapshot.plan, views.intent(record));
			const pos = positionOf(observation);
			const knownDist = {};
			for (const kind of stepTargets(focus?.check)) {
				let best = null;
				if (pos) for (const cell of known.get(kind)?.values() ?? []) {
					if (cell.dim !== dim) continue;
					const d = Math.hypot(cell.x + 0.5 - pos.x, cell.y + 0.5 - pos.y, cell.z + 0.5 - pos.z);
					if (best === null || d < best) best = d;
				}
				knownDist[kind] = best === null ? null : Math.round(best * 10) / 10;
			}
			samples.push({ at, dim, pos, deaths, plan: Boolean(snapshot.plan?.steps?.length), focus: focus ? { id: focus.id, label: focus.label, check: focus.check ?? null } : null,
				action: wire.currentAction?.active ? wire.currentAction.actionType : null, knownDist });
		},
	});
	const [progress, wakes, tools] = await Promise.all([readProgress(dir), readWakes(dir), readToolCalls(dir)]);
	try { agentId = JSON.parse(await readFile(path.join(dir, 'quality-run.json'), 'utf8')).agentId ?? null; } catch { /* optional */ }
	const ids = [...new Set(progress.map(p => p.agentId))];
	const truth = ids.length > 1 && agentId ? progress.filter(p => p.agentId === agentId) : progress;
	return { dir, startAt: replayed.startAt, endAt: replayed.endAt, gains: replayed.gainsAt.map(g => g.at), wouldWake: replayed.wakes.map(w => ({ at: w.at, trigger: w.kind })),
		samples, commands, results, wakes, calls: tools.calls, intents: tools.intents, progress: truth, deaths };
}

// ---- Episodes ----

function nearestLine(progress, at, toleranceMs = SAMPLE_MS * 1.5) {
	let lo = 0, hi = progress.length - 1;
	if (hi < 0) return null;
	while (lo < hi) { const mid = (lo + hi) >> 1; if (progress[mid].atMs < at) lo = mid + 1; else hi = mid; }
	const candidates = [progress[lo], progress[lo - 1]].filter(Boolean);
	const best = candidates.sort((a, b) => Math.abs(a.atMs - at) - Math.abs(b.atMs - at))[0];
	return best && Math.abs(best.atMs - at) <= toleranceMs ? best : null;
}

/** The focus target's true distance at a sample: the nearest of the step's target kinds present in the line. */
function truthDistance(line, kinds) {
	let best = null;
	for (const kind of kinds) { const t = truthOf(line, kind); if (t?.dist !== null && t?.dist !== undefined && (best === null || t.dist < best)) best = t.dist; }
	return best;
}

/** Dragon health lost (of 200) that counts as progress on an End step: about two sword hits on the head. */
export const DRAGON_HEALTH_PROGRESS = 10;

/**
 * Progress marks: every check gain, every new best true distance to the focus target by TRUTH_IMPROVE_BLOCKS, and on a
 * step whose target is the dragon or its crystals, a new low of dragon health by DRAGON_HEALTH_PROGRESS or a crystal
 * destroyed (live End run d19-end-a: 33 min labelled no progress while the dragon fell from 182 to 114 health).
 */
export function progressMarks(run) {
	const marks = new Set([run.startAt, ...run.gains, run.endAt].filter(Number.isFinite));
	let best = null, dragon = null, crystals = null, focusId;
	const gains = [...run.gains].sort((a, b) => a - b);
	let g = 0;
	for (const s of run.samples) {
		while (g < gains.length && gains[g] <= s.at) { g++; best = dragon = crystals = null; }
		if (s.focus?.id !== focusId) { focusId = s.focus?.id; best = dragon = crystals = null; }
		const line = nearestLine(run.progress, s.at);
		if (!line) continue;
		const kinds = stepTargets(s.focus?.check);
		if (kinds.includes('dragon') || kinds.includes('crystals')) {
			const health = line.targets?.dragon?.health, left = line.targets?.crystals?.left;
			if (Number.isFinite(health)) {
				if (dragon === null) dragon = health;
				else if (health <= dragon - DRAGON_HEALTH_PROGRESS) { marks.add(s.at); dragon = health; }
			}
			if (Number.isFinite(left)) {
				if (crystals !== null && left < crystals) marks.add(s.at);
				crystals = crystals === null ? left : Math.min(crystals, left);
			}
		}
		const d = truthDistance(line, kinds);
		if (d === null) continue;
		if (best === null) { best = d; continue; }
		if (d < best - TRUTH_IMPROVE_BLOCKS) { marks.add(s.at); best = d; }
	}
	return [...marks].sort((a, b) => a - b);
}

const top = (counts, n = 6) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
const inc = (counts, key, by = 1) => { counts[key] = (counts[key] ?? 0) + by; };
const minutes = ms => Math.round(ms / 6_000) / 10;

/** Features of one stretch [from, to] that the rules read. */
export function features(run, from, to) {
	const samples = run.samples.filter(s => s.at >= from && s.at <= to);
	const focusCount = {}, actions = {}, tools = {}, results = {}, failures = {}, byType = {};
	for (const s of samples) inc(focusCount, s.focus ? s.focus.id : '(no plan)');
	const focusId = top(focusCount, 1)[0]?.[0] ?? null;
	const focus = samples.find(s => (s.focus?.id ?? '(no plan)') === focusId)?.focus ?? null;
	const unchecked = samples.filter(s => !s.focus?.check).length, unmeasured = samples.filter(s => s.focus?.check && !measurable(s.focus.check)).length;
	for (const c of run.commands) if (c.at >= from && c.at <= to) inc(actions, c.actionType);
	for (const c of run.calls) if (c.at >= from && c.at <= to) inc(tools, c.name);
	let resultCount = 0, broken = 0;
	for (const r of run.results) {
		if (r.at < from || r.at > to) continue;
		resultCount++;
		inc(byType, r.actionType);
		inc(results, `${r.actionType} ${r.state}${r.state === 'SUCCEEDED' || !r.reasonCode ? '' : ` ${r.reasonCode}`}`);
		if (r.state !== 'SUCCEEDED' && r.state !== 'CANCELLED') inc(failures, `${r.actionType} ${r.state} ${r.reasonCode ?? ''}`.trim());
		if (r.state === 'SUCCEEDED' && /break|mine|dig/.test(r.actionType)) broken++;
	}
	let walked = 0;
	for (let i = 1; i < samples.length; i++) {
		const a = samples[i - 1].pos, b = samples[i].pos;
		if (a && b && samples[i - 1].dim === samples[i].dim) { const step = Math.hypot(b.x - a.x, b.z - a.z); if (step < 200) walked += step; }
	}
	// Truth: per sample, the focus step's targets in the joined progress line.
	let truthSamples = 0, unseen = 0, far = 0, hidden = 0, firstDist = null, lastDist = null, unseenExample = null;
	let knownSamples = 0, knownMin = null, knownExample = null;
	for (const s of samples) {
		const kinds = stepTargets(s.focus?.check);
		const line = nearestLine(run.progress, s.at);
		let knownHere = null;
		for (const kind of kinds) { const d = s.knownDist?.[kind]; if (Number.isFinite(d) && d <= KNOWN_BLOCKS && (knownHere === null || d < knownHere.dist)) knownHere = { kind, dist: d }; }
		if (line && kinds.length) {
			truthSamples++;
			const rows = kinds.map(kind => [kind, truthOf(line, kind)]).filter(([, t]) => t);
			const unseenRow = rows.find(([, t]) => t.unseen);
			if (unseenRow) { unseen++; unseenExample ??= { kind: unseenRow[0], dist: unseenRow[1].dist, at: s.at }; }
			if (rows.length && rows.every(([, t]) => t.far)) far++;
			else if (rows.length && rows.every(([, t]) => t.far || t.hidden)) hidden++;
			const d = truthDistance(line, kinds);
			if (d !== null) { firstDist ??= d; lastDist = d; }
			for (const [kind, t] of rows) if (Number.isFinite(t.known) && t.known <= KNOWN_BLOCKS && (knownHere === null || t.known < knownHere.dist)) knownHere = { kind, dist: t.known };
		}
		if (knownHere) { knownSamples++; knownExample ??= { ...knownHere, at: s.at }; knownMin = knownMin === null ? knownHere.dist : Math.min(knownMin, knownHere.dist); }
	}
	const wakes = run.wakes.filter(w => w.at >= from && w.at <= to);
	const topFailure = top(failures, 1)[0];
	const n = Math.max(1, samples.length);
	return {
		from, to, minutes: minutes(to - from), samples: samples.length, focus, uncheckedShare: unchecked / n, unmeasuredShare: unmeasured / n, plan: samples.some(s => s.plan),
		actions, tools, results, resultCount, topFailure: topFailure ? { key: topFailure[0], count: topFailure[1], of: byType[topFailure[0].split(' ')[0]] ?? topFailure[1] } : null, walked: Math.round(walked), broken,
		truth: run.progress.length > 0 && truthSamples >= Math.max(3, samples.length / 2), truthSamples, unseenShare: truthSamples ? unseen / truthSamples : 0, unseenExample,
		farShare: truthSamples ? far / truthSamples : 0, hiddenShare: truthSamples ? hidden / truthSamples : 0, firstDist, lastDist,
		knownShare: knownSamples / n, knownMin, knownExample, wakes, wouldWake: run.wouldWake.filter(w => w.at >= from && w.at <= to),
		deaths: (samples.at(-1)?.deaths ?? 0) - (samples[0]?.deaths ?? 0),
		intents: run.intents.filter(i => i.at >= from - 60_000 && i.at <= to).slice(-2).map(i => `${i.step}: "${i.why.slice(0, 90)}"`),
		y: samples.length ? [Math.round(Math.min(...samples.filter(s => s.pos).map(s => s.pos.y))), Math.round(Math.max(...samples.filter(s => s.pos).map(s => s.pos.y)))] : null,
	};
}

const pct = share => `${Math.round(share * 100)}%`;
const did = f => top(f.actions, 3).map(([k, v]) => `${k} x${v}`).join(', ') || 'no actions';
const searched = f => f.walked >= SEARCH_WALKED || f.broken >= SEARCH_BROKEN;

/**
 * The cause labels in precedence order: the first rule whose test returns evidence labels the episode. Rules marked
 * needsTruth are skipped without progress lines; then an episode no rule explains is UNKNOWN_TRUTH.
 */
export const TIME_RULES = [
	{ label: 'BODY_FAILING', needsTruth: false, fix: 'body', test: f => f.topFailure && f.topFailure.count >= FAILURE_COUNT && f.topFailure.count >= FAILURE_SHARE * f.topFailure.of
		? `${f.topFailure.key} x${f.topFailure.count} of ${f.topFailure.of} ${f.topFailure.key.split(' ')[0]} results` : null },
	{ label: 'TARGET_UNSEEN', needsTruth: true, fix: 'sensing', test: f => f.unseenShare >= 0.25 && f.unseenExample
		? `${f.unseenExample.kind} perceivable but not in the observation in ${pct(f.unseenShare)} of samples (e.g. ${f.unseenExample.dist} blocks away)` : null },
	{ label: 'PLAN_NO_CHECK', needsTruth: false, fix: 'plan', test: f => f.uncheckedShare >= 0.5
		? (f.plan ? `step ${f.focus?.id ?? '?'} "${f.focus?.label ?? ''}" had no check in ${pct(f.uncheckedShare)} of the stretch` : 'no plan: no step check could measure progress') : null },
	{ label: 'SLOW_BODY', needsTruth: true, fix: 'body speed', test: f => Number.isFinite(f.firstDist) && Number.isFinite(f.lastDist) && f.firstDist - f.lastDist >= 6
		? `closing on the target ${f.firstDist}->${f.lastDist} blocks in ${f.minutes} min (${did(f)})` : null },
	{ label: 'TARGET_FAR', needsTruth: true, fix: null, test: f => (f.farShare >= 0.5 || f.farShare + f.hiddenShare >= 0.5) && searched(f)
		? `target ${f.farShare >= 0.5 ? `absent or beyond ${FAR_BLOCKS} blocks` : 'hidden from sight'} in ${pct(Math.max(f.farShare, f.farShare + f.hiddenShare))} of samples; walked ${f.walked}, broke ${f.broken}` : null },
	{ label: 'WAKE_IGNORED', needsTruth: false, fix: 'wake facts', test: f => {
		const first = f.wakes[0];
		return first && f.to - first.at >= EPISODE_MIN * 60_000 ? `${first.trigger} at +${minutes(first.at - f.from)} min, then ${minutes(f.to - first.at)} more min (${f.wakes.length} wake${f.wakes.length > 1 ? 's' : ''}); did ${did(f)}` : null;
	} },
	{ label: 'MODEL_CHOICE', needsTruth: false, fix: null, test: f => {
		if (f.knownShare >= 0.25 && f.knownExample && !(f.knownMin <= 6)) return `${f.knownExample.kind} known ${f.knownExample.dist} blocks away in ${pct(f.knownShare)} of samples, never within 6; did ${did(f)}`;
		if (f.truth && !searched(f)) return `target not known and no search (walked ${f.walked}, broke ${f.broken}); did ${did(f)}`;
		return null;
	} },
	// Last: an all-or-nothing check (in:the_nether) measures nothing on the way, so no gain and no closer-to fact can show
	// progress; the stage's sub-steps (depth, lava, frame) are what make it measurable.
	{ label: 'PLAN_NO_CHECK', needsTruth: false, fix: 'plan', test: f => f.unmeasuredShare >= 0.5
		? `step ${f.focus?.id ?? '?'} check "${f.focus?.check}" has no measurable term in ${pct(f.unmeasuredShare)} of the stretch; did ${did(f)}` : null },
];

export function labelEpisode(f) {
	for (const rule of TIME_RULES) {
		if (rule.needsTruth && !f.truth) continue;
		const evidence = rule.test(f);
		if (evidence) return { label: rule.label, evidence };
	}
	return f.truth ? { label: 'MODEL_CHOICE', evidence: `no system cause matched; did ${did(f)}` }
		: { label: 'UNKNOWN_TRUTH', evidence: `no progress lines; ${searched(f) ? `searched (walked ${f.walked}, broke ${f.broken})` : 'no search'}, target ${f.knownShare > 0 ? `known in ${pct(f.knownShare)} of samples` : 'never in the observation'}; did ${did(f)}` };
}

/** Time episodes of one run: stretches of minMinutes or more between progress marks, each labelled. */
export function timeEpisodes(run, { minMinutes = EPISODE_MIN } = {}) {
	const marks = progressMarks(run), out = [];
	for (let i = 1; i < marks.length; i++) {
		if (marks[i] - marks[i - 1] < minMinutes * 60_000) continue;
		const f = features(run, marks[i - 1], marks[i]);
		const { label, evidence } = labelEpisode(f);
		out.push({ startMin: minutes(marks[i - 1] - run.startAt), minutesLost: f.minutes, label, evidence, step: f.focus ? `${f.focus.id}${f.focus.check ? ` [${f.focus.check}]` : ''}` : '(no plan)',
			actions: Object.fromEntries(top(f.actions, 8)), tools: Object.fromEntries(top(f.tools, 6)), results: Object.fromEntries(top(f.results, 6)),
			walked: f.walked, broken: f.broken, y: f.y, deaths: f.deaths, truth: f.truth, wakes: f.wakes.map(w => ({ trigger: w.trigger, atMin: minutes(w.at - run.startAt) })),
			wouldWake: f.wouldWake.length, intents: f.intents });
	}
	return out;
}

/** Minutes lost by label and the top system fixes (label and what it was about), ranked by minutes. */
export function summarizeTime(episodes, runMinutes = 0, { topFixes = 8 } = {}) {
	const byLabel = Object.fromEntries(LABELS.map(l => [l, { episodes: 0, minutes: 0 }]));
	const fixes = new Map();
	for (const e of episodes) {
		const row = byLabel[e.label] ??= { episodes: 0, minutes: 0 };
		row.episodes++; row.minutes = Math.round((row.minutes + e.minutesLost) * 10) / 10;
		if (!SYSTEM_LABELS.includes(e.label)) continue;
		const about = e.label === 'PLAN_NO_CHECK' && /no measurable term/.test(e.evidence) ? `${e.step.split(' ')[0]} unmeasurable` : e.label === 'BODY_FAILING' ? e.evidence.split(' x')[0] : e.label === 'TARGET_UNSEEN' ? e.evidence.split(' ')[0] : e.label === 'WAKE_IGNORED' ? e.evidence.split(' ')[0] : e.step.split(' ')[0];
		const key = `${e.label} / ${about}`;
		const fix = fixes.get(key) ?? { name: key, label: e.label, episodes: 0, minutes: 0, examples: [] };
		fix.episodes++; fix.minutes = Math.round((fix.minutes + e.minutesLost) * 10) / 10;
		if (fix.examples.length < 2) fix.examples.push(e.evidence);
		fixes.set(key, fix);
	}
	const lost = Math.round(episodes.reduce((sum, e) => sum + e.minutesLost, 0) * 10) / 10;
	// Episodes in which the current build's no-progress or repeated-result fact would have woken the model (replayed).
	const wouldWake = episodes.filter(e => e.wouldWake > 0);
	return { episodes: episodes.length, minutesLost: lost, runMinutes: Math.round(runMinutes * 10) / 10, byLabel,
		wouldWake: { episodes: wouldWake.length, minutes: Math.round(wouldWake.reduce((sum, e) => sum + e.minutesLost, 0) * 10) / 10 },
		topFixes: [...fixes.values()].sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)).slice(0, topFixes) };
}

export async function buildTimeReport(dirs, options = {}) {
	const runs = [], all = [];
	let total = 0;
	for (const dir of dirs) for (const art of await findArtifactDirs(path.resolve(dir))) {
		const run = await collectRun(art);
		const episodes = timeEpisodes(run, options);
		const runMinutes = Number.isFinite(run.startAt) && Number.isFinite(run.endAt) ? (run.endAt - run.startAt) / 60_000 : 0;
		total += runMinutes; all.push(...episodes);
		runs.push({ run: art, mode: run.progress.length ? 'truth' : 'degraded', progressLines: run.progress.length, wakes: run.wakes.length, ...summarizeTime(episodes, runMinutes), episodeList: episodes });
	}
	return { schemaVersion: 1, generatedAt: new Date().toISOString(), inputs: dirs.map(d => path.resolve(d)), minMinutes: options.minMinutes ?? EPISODE_MIN, runs, total: summarizeTime(all, total) };
}

export function formatTimeSection(s, title = 'All runs') {
	const lines = [`## ${title}`, '', `${s.minutesLost} of ${s.runMinutes} min lost in ${s.episodes} episodes of no progress.${s.wouldWake?.episodes ? ` A current-build progress wake would have fired in ${s.wouldWake.episodes} of them (${s.wouldWake.minutes} min).` : ''}`, '', '| label | episodes | minutes lost |', '|---|---|---|'];
	for (const [label, row] of Object.entries(s.byLabel)) if (row.episodes) lines.push(`| ${label}${SYSTEM_LABELS.includes(label) ? '' : ' (logged)'} | ${row.episodes} | ${row.minutes} |`);
	lines.push('');
	if (s.topFixes.length) {
		lines.push('Top system fixes by minutes lost:', '');
		s.topFixes.forEach((f, i) => { lines.push(`${i + 1}. **${f.name}**: ${f.minutes} min in ${f.episodes} episodes`); for (const ex of f.examples) lines.push(`   - ${ex.slice(0, 260)}`); });
		lines.push('');
	}
	return lines.join('\n');
}

export function formatTimeReport(report) {
	const out = ['# Time lost report', '', `Generated ${report.generatedAt} from ${report.runs.length} run(s); episodes are ${report.minMinutes}+ min without a check gain or a ${TRUTH_IMPROVE_BLOCKS}-block approach to the focus target.`, '',
		formatTimeSection(report.total)];
	for (const r of report.runs) {
		out.push(formatTimeSection(r, `Run ${r.run} (${r.mode}${r.mode === 'truth' ? `, ${r.progressLines} progress lines` : ''})`));
		for (const e of r.episodeList) out.push(`- +${e.startMin} min, ${e.minutesLost} min, **${e.label}**, step ${e.step}: ${e.evidence}. Tools ${Object.entries(e.tools).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; y ${e.y?.join('..') ?? '?'}, walked ${e.walked}, broke ${e.broken}${e.deaths ? `, died ${e.deaths}x` : ''}${e.intents.length ? `; intents ${e.intents.join(' | ')}` : ''}`);
		out.push('');
	}
	return out.join('\n');
}

export function compactTimeLine(report) {
	const t = report.total, f = t.topFixes[0];
	return `${report.runs.length} run(s): ${t.minutesLost} of ${t.runMinutes} min lost in ${t.episodes} episodes; ${Object.entries(t.byLabel).filter(([, r]) => r.episodes).map(([l, r]) => `${l} ${r.minutes}`).join(', ')}${f ? `; top fix ${f.name} (${f.minutes} min)` : ''}`;
}

/** Builds the report for the given dirs and writes watch-time.json and watch-time.md into out. */
export async function writeTimeReport(dirs, out, options = {}) {
	const report = await buildTimeReport(dirs, options);
	await writeFile(path.join(out, 'watch-time.json'), JSON.stringify(report, null, 2) + '\n');
	await writeFile(path.join(out, 'watch-time.md'), formatTimeReport(report));
	return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2), dirs = [];
	let out = null, minMinutes = EPISODE_MIN, perRun = false;
	for (let i = 0; i < argv.length; i++) { if (argv[i] === '--out') out = argv[++i]; else if (argv[i] === '--min') minMinutes = Number(argv[++i]); else if (argv[i] === '--per-run') perRun = true; else dirs.push(argv[i]); }
	if (!dirs.length) { console.error('Usage: node scripts/quality/watch-time.mjs ARTIFACT_DIR... [--out DIR] [--min 5] [--per-run]'); process.exit(2); }
	const single = dirs.length === 1 ? await findArtifactDirs(path.resolve(dirs[0])) : [];
	out = path.resolve(out ?? (single.length === 1 ? single[0] : '.'));
	const report = await writeTimeReport(dirs, out, { minMinutes });
	// --per-run: each artifact dir also gets its own watch-time.json/md (what the dashboard reads).
	if (perRun) for (const run of report.runs) {
		const own = { ...report, inputs: [run.run], runs: [run], total: summarizeTime(run.episodeList, run.runMinutes) };
		await writeFile(path.join(run.run, 'watch-time.json'), JSON.stringify(own, null, 2) + '\n');
		await writeFile(path.join(run.run, 'watch-time.md'), formatTimeReport(own));
	}
	console.log(formatTimeReport(report));
	console.log(`${compactTimeLine(report)}\nWrote ${path.join(out, 'watch-time.json')} and watch-time.md`);
}
