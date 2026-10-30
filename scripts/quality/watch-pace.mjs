#!/usr/bin/env node
// Where the wall clock went, by who held it: node scripts/quality/watch-pace.mjs RUN_DIR... [--json]
//
// RUN_DIR is a long-run output dir (sub/long/<name>) or an artifact dir holding coordinator.jsonl. Every 250 ms of play
// is put in one class from the coordinator's own timing events:
//   act+think  a body action ran while the model generated (programs and steers overlap the two)
//   act        a body action ran (not wait) and the model was not generating
//   wait       only a wait action ran: the body stood still by the model's choice
//   think      the model generated and no body action ran: the body idled for the model
//   think:program  the same while a program was alive (paused for a decision, or between its actions)
//   idle       neither: between actions inside a program, waiting for a wake, or coordinator overhead
// Model time is native_decision_timing segments (turn or tool result sent to next tool request or turn end); actions run
// from native_tool_dispatch_started to native_tool_action_completed. Rows are split by dimension (the watcher's progress
// lines) and by milestone segment (the long run's milestone report), and End rows add crystal and dragon pace.
// Reads only.
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { findArtifactDirs, readProgress } from './watch-time.mjs';

export const BUCKET_MS = 250;
export const CLASSES = ['act+think', 'act', 'wait', 'think', 'think:program', 'idle'];
const WAIT_TYPES = new Set(['wait']);

async function* rows(file, filter) {
	if (!existsSync(file)) return;
	for await (const line of readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
		if (!line || filter && !filter(line)) continue;
		try { yield JSON.parse(line); } catch { /* half-written line */ }
	}
}

/** Model segments, action spans (with type) and program spans from coordinator.jsonl. */
export async function readSpans(dir) {
	const model = [], actions = [], programs = [], dispatched = new Map(), started = new Map();
	let first = Infinity, last = -Infinity;
	const paused = [], pausedAt = new Map();
	const wanted = /native_decision_timing|native_tool_dispatch_started|native_tool_action_completed|native_program_started|native_program_ended|native_program_paused|native_program_responded/;
	for await (const r of rows(path.join(dir, 'coordinator.jsonl'), line => wanted.test(line))) {
		if (!Number.isFinite(r.at)) continue;
		first = Math.min(first, r.at); last = Math.max(last, r.at);
		switch (r.event) {
			case 'native_decision_timing':
				if (Number.isFinite(r.segmentDurationMs)) model.push([r.at - r.segmentDurationMs, r.at]);
				break;
			case 'native_tool_dispatch_started': dispatched.set(r.actionId, { at: r.at, type: r.actionType }); break;
			case 'native_tool_action_completed': {
				const d = dispatched.get(r.actionId);
				const start = d?.at ?? r.at - (r.durationMs ?? 0);
				actions.push({ start, end: r.at, type: d?.type ?? 'unknown', state: r.state, reason: r.reasonCode });
				dispatched.delete(r.actionId);
				break;
			}
			case 'native_program_started': started.set(r.programId, r.at); break;
			case 'native_program_ended': {
				const s = started.get(r.programId);
				if (s != null) programs.push([s, r.at]);
				const p = pausedAt.get(r.programId);
				if (p != null) { paused.push([p, r.at]); pausedAt.delete(r.programId); }
				break;
			}
			case 'native_program_paused': if (!pausedAt.has(r.programId)) pausedAt.set(r.programId, r.at); break;
			case 'native_program_responded': {
				const p = pausedAt.get(r.programId);
				if (p != null) { paused.push([p, r.at]); pausedAt.delete(r.programId); }
				break;
			}
		}
	}
	return { model, actions, programs, paused, first, last };
}

/** Per-bucket class over [from, to). */
export function classify({ model, actions, programs = [], paused = [] }, from, to) {
	const n = Math.max(0, Math.ceil((to - from) / BUCKET_MS));
	const think = new Uint8Array(n), act = new Uint8Array(n), wait = new Uint8Array(n);
	const mark = (arr, s, e) => { for (let i = Math.max(0, Math.floor((s - from) / BUCKET_MS)); i < Math.min(n, Math.ceil((e - from) / BUCKET_MS)); i++) arr[i] = 1; };
	for (const [s, e] of model) mark(think, s, e);
	for (const a of actions) mark(WAIT_TYPES.has(a.type) ? wait : act, a.start, a.end);
	const program = new Uint8Array(n);
	for (const [s, e] of programs) mark(program, s, e);
	const out = new Array(n);
	// think:program: a program was alive (often paused for the model's decision) yet no action ran.
	for (let i = 0; i < n; i++) out[i] = act[i] ? (think[i] ? 'act+think' : 'act') : think[i] ? (program[i] ? 'think:program' : 'think') : wait[i] ? 'wait' : 'idle';
	return out;
}

function tally(classes, from, keyOf) {
	const out = new Map();
	for (let i = 0; i < classes.length; i++) {
		const key = keyOf(from + i * BUCKET_MS);
		if (key == null) continue;
		const row = out.get(key) ?? Object.fromEntries(CLASSES.map(c => [c, 0]));
		row[classes[i]] += BUCKET_MS / 60_000;
		out.set(key, row);
	}
	return out;
}

/** The milestone report next to a long run's output (sorted reached milestones). */
async function readMilestones(runDir) {
	const report = path.join(runDir, 'long-run.json');
	if (!existsSync(report)) return [];
	try {
		const art = JSON.parse(await readFile(report, 'utf8')).timeline?.milestones?.reportArtifact?.path;
		if (!art) return [];
		const list = JSON.parse(await readFile(path.join(runDir, art), 'utf8'));
		return list.filter(m => m.reached && Number.isFinite(m.at)).sort((a, b) => a.at - b.at);
	} catch { return []; }
}

const sum = row => CLASSES.reduce((t, c) => t + row[c], 0);
const fmt = v => v.toFixed(1);

/** Action pace: count, total and median duration and failures per action type. */
export function actionPace(actions, from, to) {
	const by = new Map();
	for (const a of actions) {
		if (a.end < from || a.start >= to) continue;
		const row = by.get(a.type) ?? { n: 0, ms: 0, failed: 0, durations: [] };
		row.n++; row.ms += a.end - a.start; row.durations.push(a.end - a.start);
		if (a.state !== 'SUCCEEDED') row.failed++;
		by.set(a.type, row);
	}
	return [...by.entries()].map(([type, r]) => ({ type, n: r.n, min: r.ms / 60_000, medianMs: r.durations.sort((x, y) => x - y)[r.durations.length >> 1], failed: r.failed }))
		.sort((a, b) => b.min - a.min);
}

/** End pace from progress truth: crystal kill times and dragon health over time. */
export function endPace(progress) {
	const end = progress.filter(p => p.dim === 'minecraft:the_end');
	if (!end.length) return null;
	const t0 = end[0].atMs, crystals = [];
	let prev = null, lastKill = t0, hp0 = null, hp = null;
	for (const p of end) {
		const left = p.targets?.crystals?.left;
		if (Number.isFinite(left)) { if (prev != null && left < prev) { crystals.push({ atMin: (p.atMs - t0) / 60_000, gapMin: (p.atMs - lastKill) / 60_000, killed: prev - left }); lastKill = p.atMs; } prev = left; }
		const h = p.targets?.dragon?.health;
		if (Number.isFinite(h)) { hp0 ??= h; hp = h; }
	}
	const dragon = end.filter(p => p.targets?.dragon);
	const seen = dragon.filter(p => p.targets.dragon.inObservation).length;
	const near = dragon.filter(p => p.targets.dragon.dist <= 24);
	// Since the watcher reports inView: an unseen dragon in the view cone with a clear line is one the observation dropped.
	const unseen = dragon.filter(p => !p.targets.dragon.inObservation && typeof p.targets.dragon.inView === 'boolean');
	return { minutes: (end.at(-1).atMs - t0) / 60_000, crystals, dragonHp: [hp0, hp], dragonInObservation: dragon.length ? seen / dragon.length : null,
		unseenInView: unseen.length ? unseen.filter(p => p.targets.dragon.inView).length / unseen.length : null, unseenSamples: unseen.length,
		dragonNearInObservation: near.length ? near.filter(p => p.targets.dragon.inObservation).length / near.length : null, nearSamples: near.length };
}

/** Walking pace from progress positions while a move action ran (blocks per minute of moving). */
export function walkPace(progress, actions) {
	const moves = actions.filter(a => /move_to|navigate_to|follow_entity|flee_from/.test(a.type)).sort((a, b) => a.start - b.start);
	let blocks = 0, ms = 0;
	for (let i = 1; i < progress.length; i++) {
		const a = progress[i - 1], b = progress[i];
		if (a.dim !== b.dim || b.atMs - a.atMs > 10_000) continue;
		const moving = moves.some(m => m.start <= a.atMs && m.end >= b.atMs);
		if (!moving) continue;
		blocks += Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z); ms += b.atMs - a.atMs;
	}
	return ms ? { blocksPerMin: blocks / (ms / 60_000), minutes: ms / 60_000 } : null;
}

export async function pace(runDir) {
	const [dir] = await findArtifactDirs(runDir);
	if (!dir) throw new Error(`no artifact dir under ${runDir}`);
	const spans = await readSpans(dir);
	const progress = await readProgress(dir);
	const from = spans.first, to = spans.last;
	const classes = classify(spans, from, to);
	const dimAt = (() => {
		let i = 0;
		return t => { while (i + 1 < progress.length && progress[i + 1].atMs <= t) i++; return progress[i]?.dim?.replace('minecraft:', '') ?? 'unknown'; };
	})();
	const byDim = tally(classes, from, dimAt);
	const milestones = await readMilestones(runDir);
	const segments = [];
	let segStart = from, segName = 'start';
	for (const m of milestones.filter(m => m.at > from)) { segments.push({ name: `${segName} -> ${m.id}`, from: segStart, to: m.at }); segStart = m.at; segName = m.id; }
	segments.push({ name: `${segName} -> end of run`, from: segStart, to });
	const bySegment = segments.map(s => {
		const sub = classes.slice(Math.max(0, Math.floor((s.from - from) / BUCKET_MS)), Math.floor((s.to - from) / BUCKET_MS));
		const row = tally(sub, s.from, () => 'all').get('all') ?? Object.fromEntries(CLASSES.map(c => [c, 0]));
		return { ...s, ...row };
	});
	return { dir, minutes: (to - from) / 60_000, byDim: Object.fromEntries(byDim), bySegment, actions: actionPace(spans.actions, from, to),
		end: endPace(progress), walk: walkPace(progress, spans.actions), modelSegments: spans.model.length,
		modelMedianMs: spans.model.map(([s, e]) => e - s).filter(ms => ms > 50).sort((a, b) => a - b).at(-1) == null ? null
			: (list => list[list.length >> 1])(spans.model.map(([s, e]) => e - s).filter(ms => ms > 50).sort((a, b) => a - b)) };
}

export function render(name, p) {
	const out = [`## ${name}`, '', `${fmt(p.minutes)} min of play; model segments ${p.modelSegments}, median generating segment ${p.modelMedianMs == null ? '-' : (p.modelMedianMs / 1000).toFixed(1) + ' s'}.`, ''];
	const table = (title, entries) => {
		out.push(`| ${title} | min | ${CLASSES.join(' | ')} |`, `|---|---:|${CLASSES.map(() => '---:').join('|')}|`);
		for (const [key, row] of entries) { const t = sum(row); out.push(`| ${key} | ${fmt(t)} | ${CLASSES.map(c => `${fmt(row[c])} (${t ? Math.round(100 * row[c] / t) : 0}%)`).join(' | ')} |`); }
		out.push('');
	};
	table('dimension', Object.entries(p.byDim));
	table('milestone segment', p.bySegment.filter(s => s.to - s.from >= 60_000).map(s => [s.name, s]));
	out.push('| action | n | min | median s | failed |', '|---|---:|---:|---:|---:|');
	for (const a of p.actions.slice(0, 14)) out.push(`| ${a.type} | ${a.n} | ${fmt(a.min)} | ${(a.medianMs / 1000).toFixed(1)} | ${a.failed} |`);
	out.push('');
	if (p.walk) out.push(`Walking: ${fmt(p.walk.blocksPerMin)} blocks/min over ${fmt(p.walk.minutes)} min of move actions (sprinting is ~336 blocks/min, walking ~259).`, '');
	if (p.end) {
		const e = p.end;
		out.push(`End: ${fmt(e.minutes)} min; crystals destroyed at ${e.crystals.map(c => fmt(c.atMin)).join(', ') || 'none'} min; dragon ${e.dragonHp[0]} -> ${e.dragonHp[1]} hp; dragon in the observation in ${e.dragonInObservation == null ? '-' : Math.round(100 * e.dragonInObservation) + '%'} of samples (${e.dragonNearInObservation == null ? '-' : Math.round(100 * e.dragonNearInObservation) + '%'} of ${e.nearSamples} samples within 24 blocks)${e.unseenInView == null ? '' : `; of ${e.unseenSamples} samples without it, ${Math.round(100 * e.unseenInView)}% had it in view`}.`, '');
	}
	return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2), json = args.includes('--json');
	for (const dir of args.filter(a => !a.startsWith('--'))) {
		const p = await pace(path.resolve(dir));
		console.log(json ? JSON.stringify({ run: dir, ...p }) : render(path.basename(path.resolve(dir)), p));
	}
}
