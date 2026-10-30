// Evaluator-owned success checks for the route ladder. The check is read from the ladder data's
// `successCheck` text and judged against what the evaluator sampled over RCON (inventory, position,
// advancements, deaths) plus the server log. Nothing here is ever sent to the model.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { epoch, itemCount, parseJsonl, resolveGoalWindow } from '../../coordinator/src/benchmark/quality-metrics.mjs';

const mc = id => id.includes(':') ? id : `minecraft:${id}`;
const bare = id => id.replace(/^minecraft:/, '');

// Vanilla advancement titles as printed in the server log ("<name> has made the advancement [Title]").
export const ADVANCEMENT_TITLES = {
	'story/enter_the_nether': 'We Need to Go Deeper', 'nether/find_fortress': 'A Terrible Fortress',
	'nether/find_bastion': 'Those Were the Days', 'story/follow_ender_eye': 'Eye Spy',
	'story/enter_the_end': 'The End?', 'end/kill_dragon': 'Free the End',
};

function inventoryClauses(body) {
	return body.split(/\s+AND\s+/).map(part => {
		const m = part.trim().match(/^(.+?)\s*>=\s*(\d+)$/);
		if (!m) throw new Error(`Unparseable inventory clause: ${part}`);
		return m[1].split(',').map(s => s.trim()).filter(Boolean).map(id => ({ type: 'inventory', items: [mc(id)], count: Number(m[2]) }));
	}).flat();
}
function clause(text) {
	let m;
	if (/^(survive_duration|inventory_contains_any):/.test(text)) return parseSuccessCheck(text);
	if ((m = text.match(/^inventory\s+(.+)$/))) return all(inventoryClauses(m[1]));
	if ((m = text.match(/^position_within\s+(\w+)\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)\s*radius\s*(\d+(?:\.\d+)?)$/)))
		return { type: 'position', dimension: `minecraft:${m[1]}`, center: [+m[2], +m[3], +m[4]], radius: +m[5] };
	throw new Error(`Unparseable clause: ${text}`);
}
const all = of => of.length === 1 ? of[0] : { type: 'all', of };

/** Machine-readable form of a ladder `successCheck` string. */
export function parseSuccessCheck(text) {
	const t = String(text).trim();
	let m;
	if ((m = t.match(/^all:\s*(.+)$/))) return all(m[1].split(/\s+AND\s+/).map(clause));
	if ((m = t.match(/^any advancement:\s*(.+)$/))) return { type: 'any', of: m[1].split(/\s+OR\s+/).map(id => ({ type: 'advancement', id: id.trim() })) };
	if ((m = t.match(/^advancement:\s*(\S+)$/))) return { type: 'advancement', id: m[1] };
	if ((m = t.match(/^inventory_contains_any:\s*(.+?)\s*>=\s*(\d+)$/)))
		return { type: 'inventory', items: m[1].split('|').map(s => mc(s.trim())), count: Number(m[2]), sum: true };
	if ((m = t.match(/^inventory:\s*(.+)$/))) return all(inventoryClauses(m[1]));
	if ((m = t.match(/^survive_duration:\s*(\d+)\s*ticks/))) return { type: 'survive', ticks: Number(m[1]) };
	if ((m = t.match(/^entity_killed_by_agent:\s*(\w+)/))) {
		if (bare(m[1]) !== 'ender_dragon') throw new Error(`No kill evidence mapping for ${m[1]}`);
		return { type: 'advancement', id: 'end/kill_dragon' };
	}
	if (/^position_within\s/.test(t)) return clause(t);
	throw new Error(`Unparseable successCheck: ${t}`);
}

/** Advancement ids the evaluator must sample for this check. */
export function checkAdvancements(spec) {
	if (spec.type === 'advancement') return [spec.id];
	return (spec.of ?? []).flatMap(checkAdvancements);
}

function inventoryHolds(spec, sample) {
	const text = sample.inventoryNbt || '';
	const counts = spec.items.map(id => itemCount(text, new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)));
	return (spec.sum ? counts.reduce((a, b) => a + b, 0) : counts[0]) >= spec.count;
}
// Survival is judged on game ticks (sample.gameTime against the tick at goal start). The server can run below
// 20 TPS, so wall time is only the fallback for samples that carry no game clock.
function survivedTicks(sample, ctx) {
	if (Number.isFinite(sample.gameTime) && Number.isFinite(ctx.goalStartTick)) return sample.gameTime - ctx.goalStartTick;
	return (sample.at - ctx.goalStartAt) / 50;
}
function holds(spec, sample, ctx) {
	switch (spec.type) {
		case 'all': return spec.of.every(s => holds(s, sample, ctx));
		case 'any': return spec.of.some(s => holds(s, sample, ctx));
		case 'inventory': return inventoryHolds(spec, sample);
		case 'advancement': return (sample.advancements ?? []).includes(spec.id);
		case 'position': {
			const p = sample.position;
			return Boolean(p) && sample.dimension === spec.dimension && Math.hypot(p.x - spec.center[0], p.y - spec.center[1], p.z - spec.center[2]) <= spec.radius;
		}
		case 'survive': return !ctx.died && survivedTicks(sample, ctx) >= spec.ticks;
		default: throw new Error(`Unknown check type ${spec.type}`);
	}
}

/**
 * Feed samples in time order. Only samples inside [goalStartAt, goalStartAt + budgetMs] count.
 * Log evidence must carry agent identity and an absolute in-window event time.
 */
export class LadderEvaluator {
	constructor(spec, { goalStartAt = null, goalStartTick = null, budgetMs = Infinity, logAdvancements = [], agentName = null } = {}) {
		Object.assign(this, { spec, goalStartAt, goalStartTick, budgetMs, logAdvancements: logAdvancements.filter(e => e && typeof e === 'object' && agentName && e.agentName === agentName && Number.isFinite(goalStartAt) && Number.isFinite(e.at) && e.at >= goalStartAt && e.at <= goalStartAt + budgetMs), result: null, deathBaseline: null, died: false });
	}
	trackDeath(sample) {
		const deaths = sample.deathCounter;
		if (!Number.isFinite(deaths)) return;
		this.deathBaseline ??= deaths;
		if (deaths > this.deathBaseline && !this.died) { this.died = true; this.diedAt = sample.at; this.diedTick = sample.gameTime ?? null; }
	}
	push(sample) {
		if (this.result) {
			// A recorded pass is final; a later death is reported next to it, never over it.
			this.trackDeath(sample);
			if (this.died && !this.result.postPass) this.result.postPass = { died: true, diedAt: this.diedAt, diedAfterPassMs: this.diedAt - this.result.passAt, diedTick: this.diedTick };
			return this.result;
		}
		this.goalStartAt ??= sample.at;
		if (sample.at < this.goalStartAt || sample.at - this.goalStartAt > this.budgetMs) return null;
		if (!Number.isFinite(this.goalStartTick) && Number.isFinite(sample.gameTime)) this.goalStartTick = sample.gameTime;
		this.trackDeath(sample);
		if (this.died && checkNeedsSurvival(this.spec)) return null;
		if (holds(this.spec, sample, this)) this.result = { pass: true, passAt: sample.at, timeToPassMs: sample.at - this.goalStartAt, source: 'samples',
			passTicks: Number.isFinite(sample.gameTime) && Number.isFinite(this.goalStartTick) ? sample.gameTime - this.goalStartTick : null, evidence: evidenceSample(this.spec, sample) };
		return this.result;
	}
	finish(lastSampleAt = null) {
		if (this.result) return this.result;
		// Log fallback applies to advancement-only evidence that was never sampled.
		for (const event of [...this.logAdvancements].sort((a, b) => a.at - b.at)) {
			const ids = this.logAdvancements.filter(e => e.at <= event.at).map(e => e.id);
			if (holds(spec_with_log(this.spec), { advancements: ids }, this)) return { pass: true, passAt: event.at, timeToPassMs: event.at - this.goalStartAt, source: 'server-log', agentName: event.agentName };
		}
		return { pass: false, passAt: null, timeToPassMs: null, source: null, died: this.died, lastSampleAt };
	}
}
// Compact record of the sample that satisfied the check (never the full entity NBT).
function evidenceSample(spec, sample) {
	const leaves = s => s.of ? s.of.flatMap(leaves) : [s];
	const inventory = Object.fromEntries(leaves(spec).filter(l => l.type === 'inventory').flatMap(l => l.items)
		.map(id => [id, itemCount(sample.inventoryNbt || '', new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))]));
	return { at: sample.at, gameTime: sample.gameTime ?? null, position: sample.position ?? null, dimension: sample.dimension ?? null, health: sample.health ?? null,
		deathCounter: sample.deathCounter ?? null, ...(Object.keys(inventory).length ? { inventory } : {}),
		...(leaves(spec).some(l => l.type === 'advancement') ? { advancements: sample.advancements ?? [] } : {}) };
}
const checkNeedsSurvival = spec => spec.type === 'survive' || (spec.of ?? []).some(checkNeedsSurvival);
// Only the advancement leaves can be judged from the log; every other leaf is treated as unmet.
function spec_with_log(spec) {
	const hasOnlyAdvancements = s => s.type === 'advancement' || (['all', 'any'].includes(s.type) && s.of.every(hasOnlyAdvancements));
	return hasOnlyAdvancements(spec) ? spec : { type: 'all', of: [{ type: 'advancement', id: '__never__' }] };
}

export function parseLogAdvancements(logText, { agentName = null, goalStartAt = null, goalEndAt = null } = {}) {
	// Vanilla's HH:mm:ss lines lack a date and timezone. They cannot prove an absolute run window.
	if (!agentName || !Number.isFinite(goalStartAt) || !Number.isFinite(goalEndAt)) return [];
	const events = [];
	for (const line of String(logText).split(/\r?\n/)) {
		const player = line.match(/(?:^|[ :\]])(\S+) has made the advancement \[([^\]]+)\]/);
		const stamp = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/);
		if (!player || player[1] !== agentName || !stamp) continue;
		const at = Date.parse(stamp[0]);
		const id = Object.entries(ADVANCEMENT_TITLES).find(([, title]) => title === player[2])?.[0];
		if (id && at >= goalStartAt && at <= goalEndAt) events.push({ id, at, agentName });
	}
	return events;
}

async function readIf(file) { return readFile(file, 'utf8').catch(() => null); }
async function serverLogText(dir) {
	const logs = path.join(dir, 'server', 'logs');
	const names = (await readdir(logs).catch(() => [])).filter(n => n.endsWith('.log'));
	return (await Promise.all(names.map(n => readIf(path.join(logs, n))))).filter(Boolean).join('\n');
}

// The server's game clock as seen by the coordinator: [epoch ms, game tick] pairs from protocol observations.
export function protocolClock(protocolRows) {
	const points = [];
	for (const row of protocolRows) {
		const e = row.envelope ?? row, p = e.payload;
		if (e.type === 'observation' && Number.isFinite(p?.observedAtEpochMs) && Number.isFinite(p?.world?.gameTime)) points.push([p.observedAtEpochMs, p.world.gameTime]);
	}
	return points.sort((a, b) => a[0] - b[0]);
}
export function tickAt(clock, at) {
	if (!clock.length || !Number.isFinite(at)) return null;
	if (at <= clock[0][0]) return clock[0][1];
	let lo = 0, hi = clock.length - 1;
	if (at >= clock[hi][0]) return clock[hi][1];
	while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (clock[mid][0] <= at) lo = mid; else hi = mid; }
	const [t0, k0] = clock[lo], [t1, k1] = clock[hi];
	return t1 === t0 ? k0 : Math.round(k0 + (k1 - k0) * (at - t0) / (t1 - t0));
}

// Minecraft verified a factual goal predicate (the run stopped on goalCompleted); the last sample may predate the final change.
export function serverVerifiedPass(protocolRows, goalStartAt = null, budgetMs = Infinity) {
	const window = resolveGoalWindow(protocolRows);
	if (!window.goalCompleted || window.endedAt == null) return null;
	const events = protocolRows.map(r => r.envelope ?? r);
	const start = events.find(e => e.type === 'goal_control' && e.payload?.operation === 'start' && e.payload.goalSpec);
	const confirmed = JSON.stringify([start?.payload?.goalSpec?.predicate, events.filter(e => e.type === 'goal_completion_result').map(e => e.payload?.facts)]).includes('operator_confirmed');
	if (confirmed) return null;
	const startAt = goalStartAt ?? window.startedAt;
	const timeToPassMs = Number.isFinite(startAt) ? window.endedAt - startAt : null;
	if (Number.isFinite(timeToPassMs) && timeToPassMs > budgetMs) return null;
	return { pass: true, passAt: window.endedAt, timeToPassMs, source: 'server' };
}

/** Judge sampled evidence; samples without gameTime get one interpolated from the protocol clock when it is available. */
export function evaluateSamples(samples, { successCheck, durationBudgetMs, goalStartAt = null, protocolRows = [], logAdvancements = [], agentName = null, requireSampledSuccess = false }) {
	const spec = parseSuccessCheck(successCheck);
	const clock = protocolClock(protocolRows);
	const timed = clock.length ? samples.map(s => Number.isFinite(s.gameTime) ? s : { ...s, gameTime: tickAt(clock, s.at) }) : samples;
	const goalStartTick = Number.isFinite(goalStartAt) && clock.length ? tickAt(clock, goalStartAt) : null;
	const evaluator = new LadderEvaluator(spec, { goalStartAt, goalStartTick, budgetMs: durationBudgetMs, logAdvancements, agentName });
	for (const s of timed) evaluator.push(s);
	let result = evaluator.finish(timed.at(-1)?.at ?? null);
	// A server goal completion may prove a different predicate. It cannot replace this successCheck.
	// Sampling stops with the run, so a death after the pass is also read from the protocol's goal lifecycle.
	if (result.pass && result.passAt != null && !result.postPass) {
		const dead = protocolRows.map(r => ({ ...(r.envelope ?? r), observedAtMs: r.observedAtMs })).find(e => e.type === 'goal_control' && e.payload?.operation === 'dead' && epoch(e) > result.passAt);
		if (dead) result.postPass = { died: true, diedAt: epoch(dead), diedAfterPassMs: epoch(dead) - result.passAt, diedTick: null };
	}
	return { ...result, evaluatorVersion: 2, status: 'EVALUATED', check: successCheck, spec, samples: samples.length, clock: spec.type === 'survive' || JSON.stringify(spec).includes('"survive"') ? (Number.isFinite(timed[0]?.gameTime) ? 'game-ticks' : 'wall-fallback') : undefined };
}

/** Judge one run from its artifact directory (quality-samples.json, quality-protocol.jsonl, server log). */
export async function evaluateArtifacts(directory, { successCheck, durationBudgetMs, requireSampledSuccess = false }) {
	parseSuccessCheck(successCheck);
	const samplesText = await readIf(path.join(directory, 'quality-samples.json'));
	if (samplesText === null) return { pass: false, status: 'NO_SAMPLES', check: successCheck, timeToPassMs: null, source: null };
	const samples = JSON.parse(samplesText).samples ?? [];
	const protocol = parseJsonl((await readIf(path.join(directory, 'quality-protocol.jsonl'))) ?? '');
	const runner = JSON.parse(await readIf(path.join(directory, 'report.json')) ?? '{}');
	const agentName = runner.generatedName ?? null;
	const goalStartAt = resolveGoalWindow(protocol).startedAt ?? runner.budget?.goalStartedAt ?? null;
	return evaluateSamples(samples, { successCheck, durationBudgetMs, requireSampledSuccess, goalStartAt, protocolRows: protocol, agentName,
		logAdvancements: parseLogAdvancements(await serverLogText(directory), { agentName, goalStartAt, goalEndAt: Number.isFinite(goalStartAt) ? goalStartAt + durationBudgetMs : null }) });
}
