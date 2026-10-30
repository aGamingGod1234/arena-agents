import { evaluatePlanCheck, planProgress } from './plan-checks.mjs';
import { codePointLength } from './text-length.mjs';

/**
 * Whether the plan is moving: facts for the model, never a choice. A plan step completing, or an unmet check term's
 * measurable value reaching a new best (a lower y on a y<= step, more held items, more frame obsidian, fewer standing
 * crystals), is progress. When none happens for NO_PROGRESS_MS, or one action keeps returning the same no-effect
 * result REPEAT_COUNT times, the task view states it once and asks for a wake.
 *
 * Thresholds are from recorded games (scripts/quality/progress-replay.mjs); the measured numbers are beside each.
 * The clock lives with the task view, not its saved file: a coordinator restart starts it again.
 */
// 21 d13-d15 iron games (37 h) with a translator stage plan: 95% of the gaps between plan progress end within 4.8 min,
// yet 59% of game time sits in gaps of 10+ min. 10 min gives 2.5 wakes/h (every game); 5 min 7.7/h, 15 min 1.6/h.
export const NO_PROGRESS_MS = 10 * 60_000;
// Same games: 8 identical no-effect results give 1.9 wakes/h (iron) and 1.3/h in 19 End games, including the two
// caged-crystal episodes (shots into iron bars, d12-end-c and d12-end-f); 4 gives 13/h.
export const REPEAT_COUNT = 8;
const REPEAT_WINDOW_MS = 10 * 60_000;
// A live check flickering at its threshold (y-50 / y-49 on a cave floor) is not a new completion each time.
const RECOMPLETE_MS = 120_000;
const MAX_TRACKED = 16, MAX_REPEATS = 64, MAX_INTENTS = 8, LINE_BYTES = 480;

export function resetProgress(state) { state.progress = null; state.alarms = {}; state.repeats = []; state.repeatAlarmed = {}; }

/** The model's own stated intents, so a no-progress fact can quote what the time went to. */
export function noteIntent(state, intent, at) {
 state.intentLog = [...(state.intentLog ?? []), { at, step: intent.step, why: intent.why }].slice(-MAX_INTENTS);
}

/**
 * Updates the plan's progress clock from the current sample (focus: the intent's step, else the first open step).
 * Returns true when a no-progress fact became due now.
 */
export function trackProgress(state, focus, at, { noProgressMs = NO_PROGRESS_MS, onGain = null, chain = null } = {}) {
 const steps = state.plan?.steps ?? [];
 if (!steps.length || !focus || !Number.isFinite(at)) { state.progress = null; delete state.alarms?.progress; return false; }
 state.alarms ??= {};
 const o = state.observation;
 const complete = steps.filter(s => s.status === 'complete').map(s => s.id);
 // Steps already true by presence count as reached, so the steps they make moot are not measured.
 // Steps a later completed step made moot (the depth step once a frame is lit) are not measured either.
 const early = new Set(state.early ?? []);
 const facts = planProgress({ steps: steps.map(s => early.has(s.id) ? { ...s, status: 'complete' } : s) });
 const open = facts?.open ?? [], skipped = facts?.skipped ?? {};
 // Every unfinished checked step is measured: a later sub-step moving (obsidian salvaged for the frame) is progress too.
 const tracked = [...new Set([focus.id, ...open, ...steps.filter(s => s.status !== 'complete' && !early.has(s.id) && !skipped[s.id]).map(s => s.id)])]
  .map(id => steps.find(s => s.id === id)).filter(s => s?.check).slice(0, MAX_TRACKED);
 const values = Object.fromEntries(tracked.map(step => [step.id, Object.fromEntries(evaluatePlanCheck(step.check, o, state.known).terms
  .filter(t => t.ok !== true && Number.isFinite(t.metric)).map(t => [t.raw, { value: t.metric, better: t.better }]))]));
 // Ingredients gathered toward the focus step (raw iron 0/3 -> 2/3 on the way to a pickaxe) are progress too.
 const held = typeof chain === 'function' && focus.check ? chainHeld(chain(focus)) : null;
 if (held !== null) (values[focus.id] ??= {})['chain'] = { value: held, better: 'higher' };
 let p = state.progress;
 const y = playerY(o);
 if (p && y !== null) { p.snapshot.minY = Math.min(p.snapshot.minY ?? y, y); p.snapshot.maxY = Math.max(p.snapshot.maxY ?? y, y); }
 if (!p) {
  state.progress = { lastGain: at, alarmAt: null, complete, completedAt: {}, best: bests(values), start: bests(values), snapshot: snapshot(state, at) };
  return false;
 }
 let gained = false;
 for (const id of complete) if (!p.complete.includes(id)) {
  if (!(at - (p.completedAt[id] ?? -Infinity) < RECOMPLETE_MS)) gained = true;
  p.completedAt[id] = at;
 }
 // A step that was met and is no longer (it climbed back up, used its items) measures again from where it is now.
 for (const id of p.complete) if (!complete.includes(id)) delete p.best[id];
 p.complete = complete;
 for (const [id, terms] of Object.entries(values)) {
  const best = p.best[id] ??= {};
  for (const [raw, { value, better }] of Object.entries(terms)) {
   if (!Object.hasOwn(best, raw)) { best[raw] = value; continue; }
   if (better === 'lower' ? value < best[raw] : value > best[raw]) { best[raw] = value; gained = true; }
  }
 }
 if (gained) {
  onGain?.({ at, from: p.lastGain, step: focus.id });
  p.lastGain = at; p.alarmAt = null; p.start = bests(values); p.snapshot = snapshot(state, at);
  delete state.alarms.progress;
  return false;
 }
 if (at - p.lastGain < noProgressMs || p.alarmAt !== null && at - p.alarmAt < noProgressMs) return false;
 // Moving back toward the step since the last statement (a long staircase down after a surface trip) is not stated again.
 const now = values[focus.id] ?? {}, before = p.alarmValues ?? {};
 const closer = p.alarmAt !== null && Object.entries(now).some(([raw, { value, better }]) => Object.hasOwn(before, raw) && (better === 'lower' ? value < before[raw] : value > before[raw]));
 p.alarmAt = at; p.alarmValues = Object.fromEntries(Object.entries(now).map(([raw, v]) => [raw, v.value]));
 if (closer) return false;
 state.alarms.progress = { at, woken: false };
 return true;
}

/**
 * Counts terminal results that changed nothing (a failure, or a shot that missed or was stopped) by action and cause
 * within REPEAT_WINDOW_MS. Each one changed nothing itself, so other plan progress meanwhile (another crystal broken)
 * does not reset the count; the line says whether the plan moved. Returns true when one reached REPEAT_COUNT.
 */
export function noteRepeat(state, receipt, at, focus, { repeatCount = REPEAT_COUNT, onRepeat = null } = {}) {
 const sig = repeatSignature(receipt);
 if (sig === null || !Number.isFinite(at)) return false;
 state.alarms ??= {}; state.repeatAlarmed ??= {};
 state.repeats = [...(state.repeats ?? []).filter(r => r.at > at - REPEAT_WINDOW_MS), { at, key: sig.key, text: sig.text, target: sig.target }].slice(-MAX_REPEATS);
 const same = state.repeats.filter(r => r.key === sig.key && r.at > (state.repeatAlarmed[sig.key] ?? -Infinity));
 onRepeat?.({ at, key: sig.key, count: same.length, first: same[0].at });
 if (same.length < repeatCount) return false;
 state.repeatAlarmed[sig.key] = at;
 const minutes = Math.max(1, Math.round((at - same[0].at) / 60_000));
 const targets = new Set(same.map(r => r.target).filter(Boolean)).size;
 const step = focus ? stepFacts(state, focus) : null;
 const moved = (state.progress?.lastGain ?? -Infinity) >= same[0].at;
 state.alarms.repeat = { at, woken: false, line: bound(`${receipt.actionType} ${same.length} times in ${minutes} min with the same result: ${sig.text}${targets > 1 ? ` (${targets} targets)` : ''}; ${moved ? 'other plan progress meanwhile' : 'no plan step completed or measurably closer since the first'}${step ? ` (${step})` : ''}`) };
 return true;
}

/** The kind of a stated but not yet woken fact, marking it woken; null when none. */
export function takeProgressWake(state) {
 for (const kind of ['repeat', 'progress']) {
  const alarm = state.alarms?.[kind];
  if (alarm && !alarm.woken) { alarm.woken = true; return kind === 'repeat' ? 'repeated_result' : 'no_progress'; }
 }
 return null;
}

/** Header lines while they still hold, with current numbers; a repeat fact lapses with its window. */
export function progressFacts(state, now, focus) {
 const alarms = state.alarms ?? {}, facts = {};
 if (alarms.progress && state.progress && focus && Number.isFinite(now)) facts.progress = progressLine(state, focus, Math.max(now, state.progress.lastGain));
 if (alarms.repeat && !(now - alarms.repeat.at > REPEAT_WINDOW_MS)) facts.repeats = alarms.repeat.line;
 return facts;
}

/** The held side of every have/need pair in a requirement chain ("raw_iron 2/3 ... stick 0/2" -> 2). */
function chainHeld(key) {
 if (typeof key !== 'string' || !key) return null;
 let total = 0;
 for (const [, have, need] of key.matchAll(/(\d+)\/(\d+)/g)) total += Math.min(Number(have), Number(need));
 return total;
}

function bests(values) { return Object.fromEntries(Object.entries(values).map(([id, terms]) => [id, Object.fromEntries(Object.entries(terms).map(([raw, v]) => [raw, v.value]))])); }

function snapshot(state, at) {
 const y = playerY(state.observation);
 return { at, items: (state.liveInventory ?? []).map(({ itemId, count }) => ({ itemId, count })), broken: state.broken ?? 0, deaths: state.deaths ?? 0, ...(y === null ? {} : { y, minY: y, maxY: y }) };
}
function playerY(o) { const at = o?.position ?? o?.player?.position ?? o?.player; return o?.player?.dead !== true && Number.isFinite(at?.y) ? Math.floor(at.y) : null; }

function stepFacts(state, step) {
 if (!step.check) return `step ${step.id}: unchecked`;
 const result = evaluatePlanCheck(step.check, state.observation, state.known);
 const unmet = result.terms.filter(t => t.ok !== true);
 return `step ${step.id}: ${(unmet.length ? unmet : result.terms).map(t => t.reason).join(result.any ? ' or ' : ', ')}`;
}

function progressLine(state, focus, at) {
 const p = state.progress, minutes = Math.floor((at - p.lastGain) / 60_000);
 const terms = focus.check ? evaluatePlanCheck(focus.check, state.observation, state.known).terms.filter(t => t.ok !== true) : [];
 const was = terms.map(t => {
  const start = p.start?.[focus.id]?.[t.raw];
  return `${t.reason}${Number.isFinite(start) && Number.isFinite(t.metric) && start !== t.metric ? `, ${minutes} min ago ${start}` : ''}`;
 });
 const head = `step ${focus.id} "${focus.label}": no plan step completed or measurably closer for ${minutes} min${was.length ? ` (${was.join('; ')})` : focus.check ? '' : ' (unchecked step)'}`;
 const s = p.snapshot, since = [], y = playerY(state.observation);
 if (y !== null && Number.isFinite(s.y)) since.push(`y ${s.y}->${y} (range ${s.minY}..${s.maxY})`);
 const delta = inventoryDelta(s.items, state.liveInventory ?? []);
 since.push(delta.length ? `held ${delta.join(', ')}` : 'held items unchanged');
 if ((state.broken ?? 0) > s.broken) since.push(`${state.broken - s.broken} blocks broken`);
 if ((state.deaths ?? 0) > s.deaths) since.push(`died ${state.deaths - s.deaths}x`);
 const intents = (state.intentLog ?? []).filter(i => i.at >= s.at).slice(-2).map(i => `${i.step}: "${clip(i.why, 70)}"`);
 if (intents.length) since.push(`your intents ${intents.join(', ')}`);
 return bound(`${head}; since then: ${since.join('; ')}`);
}

// Blocks every dig yields; summed so the items the time went to stay visible.
const BULK = /^minecraft:(cobblestone|cobbled_deepslate|stone|deepslate|andesite|diorite|granite|tuff|calcite|dirt|coarse_dirt|gravel|sand|red_sand|sandstone|netherrack|basalt|blackstone|soul_sand|soul_soil|end_stone)$/;
function inventoryDelta(before, after) {
 const totals = new Map();
 for (const { itemId, count } of before) totals.set(itemId, (totals.get(itemId) ?? 0) - count);
 for (const { itemId, count } of after) totals.set(itemId, (totals.get(itemId) ?? 0) + count);
 let bulk = 0;
 for (const [id, n] of totals) if (BULK.test(id)) { bulk += n; totals.delete(id); }
 const rows = [...totals].filter(([, n]) => n !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5).map(([id, n]) => `${n > 0 ? '+' : ''}${n} ${id.replace(/^minecraft:/, '')}`);
 return bulk ? [...rows, `${bulk > 0 ? '+' : ''}${bulk} stone/dirt`] : rows;
}

/** A result that changed nothing, keyed by action and outcome; null for an effective or model-cancelled result. */
export function repeatSignature(receipt) {
 const type = receipt?.actionType, state = receipt?.state, message = typeof receipt?.message === 'string' ? receipt.message : '';
 if (typeof type !== 'string' || ['chat', 'wait'].includes(type) || state === 'CANCELLED') return null;
 const target = typeof receipt.arguments?.targetId === 'string' ? receipt.arguments.targetId
  : ['x', 'y', 'z'].every(k => Number.isSafeInteger(receipt.arguments?.[k])) ? `${receipt.arguments.x},${receipt.arguments.y},${receipt.arguments.z}` : null;
 // A shot stopped by a block is one cause whether it flew and stuck there or was refused for the blocked line.
 const stop = message.match(/(?:stuck in|arrows stop at) (minecraft:[a-z0-9_]+)/)?.[1];
 if (stop && stop !== 'minecraft:air' && (state === 'SUCCEEDED' || state === 'FAILED')) {
  return { key: `${type}|stopped by ${stop}`, text: `shot stopped by ${stop} (${state === 'SUCCEEDED' ? 'loosed, stuck in it' : `not loosed, ${receipt.reasonCode}`})`, target };
 }
 if (state === 'SUCCEEDED') {
  const at = message.search(/\bmissed\b/i);
  if (at < 0) return null;
  const text = message.slice(at).split(';')[0].trim();
  return { key: `${type}|${text.replace(/-?\d+(?:\.\d+)?/g, '#')}`, text: clip(text, 120), target };
 }
 if (!['FAILED', 'TIMED_OUT', 'REJECTED'].includes(state) || typeof receipt.reasonCode !== 'string') return null;
 const block = message.match(/minecraft:[a-z0-9_]+/)?.[0];
 const text = `${state} ${receipt.reasonCode}${block ? ` (${block})` : ''}`;
 return { key: `${type}|${text}`, text: message ? `${text}: ${clip(message, 100)}` : text, target };
}

function clip(text, max) { const value = String(text ?? ''); return codePointLength(value) <= max ? value : `${[...value].slice(0, max - 1).join('')}…`; }
function bound(text) {
 if (Buffer.byteLength(text) <= LINE_BYTES) return text;
 let out = '';
 for (const ch of text) { if (Buffer.byteLength(out + ch) > LINE_BYTES - 3) break; out += ch; }
 return `${out}...`;
}
