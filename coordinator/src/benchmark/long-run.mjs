import { randomBytes } from 'node:crypto';
import { estimateTokenCostUsd } from '../call-cost.mjs';
import { epoch, itemCount, providerCallTokens, resolveGoalWindow } from './quality-metrics.mjs';

/** The vanilla progression chain from first wood to the dragon, measured from player state only. */
export const LONG_RUN_MILESTONES = Object.freeze([
	{ id: 'wood', label: 'Wood log', item: /(_log|_stem)$/ },
	{ id: 'planks', label: 'Planks', item: /_planks$/ },
	{ id: 'crafting_table', label: 'Crafting table', item: /:crafting_table$/ },
	{ id: 'wooden_pickaxe', label: 'Wooden pickaxe', item: /:wooden_pickaxe$/ },
	{ id: 'stone', label: 'Cobblestone', item: /:(cobblestone|cobbled_deepslate|blackstone)$/ },
	{ id: 'stone_pickaxe', label: 'Stone pickaxe', item: /:stone_pickaxe$/ },
	{ id: 'furnace', label: 'Furnace', item: /:furnace$/ },
	{ id: 'cooked_food', label: 'Cooked food or bread', item: /:(cooked_[a-z_]+|bread|baked_potato)$/ },
	{ id: 'iron_ingot', label: 'Iron ingot', item: /:iron_ingot$/ },
	{ id: 'iron_pickaxe', label: 'Iron pickaxe', item: /:iron_pickaxe$/ },
	{ id: 'iron_armour', label: 'Iron armour piece', item: /:iron_(helmet|chestplate|leggings|boots)$/ },
	{ id: 'bucket', label: 'Bucket', item: /:(water_|lava_)?bucket$/ },
	{ id: 'diamond', label: 'Diamond', item: /:diamond$/ },
	{ id: 'obsidian', label: 'Obsidian', item: /:obsidian$/ },
	{ id: 'flint_and_steel', label: 'Flint and steel', item: /:flint_and_steel$/ },
	{ id: 'nether', label: 'Entered the Nether', dimension: 'minecraft:the_nether', advancement: 'story/enter_the_nether' },
	{ id: 'fortress', label: 'Found a Nether fortress', advancement: 'nether/find_fortress' },
	{ id: 'blaze_rod', label: 'Blaze rod', item: /:blaze_rod$/ },
	{ id: 'ender_pearl', label: 'Ender pearl', item: /:ender_pearl$/ },
	{ id: 'blaze_powder', label: 'Blaze powder', item: /:blaze_powder$/ },
	{ id: 'ender_eye', label: 'Eye of ender', item: /:ender_eye$/ },
	{ id: 'stronghold', label: 'Followed an eye to the stronghold', advancement: 'story/follow_ender_eye' },
	{ id: 'end', label: 'Entered the End', dimension: 'minecraft:the_end', advancement: 'story/enter_the_end' },
	{ id: 'dragon', label: 'Killed the Ender Dragon', advancement: 'end/kill_dragon' },
]);
export const LONG_RUN_ADVANCEMENTS = Object.freeze(['story/iron_tools', 'story/obtain_armor', ...new Set(LONG_RUN_MILESTONES.map(m => m.advancement).filter(Boolean))]);
export const MAX_LONG_RUN_WINDOW_MS = 12 * 60 * 60 * 1000;

export function randomSeed(bytes = randomBytes(8)) { return BigInt.asIntN(64, BigInt(`0x${Buffer.from(bytes).toString('hex')}`)).toString(); }

/**
 * A fresh normal survival world with only the goal. The player starts at the generated world spawn with nothing,
 * respawns by vanilla rules, and the evaluator ends the run when the dragon-kill advancement appears.
 */
export function buildLongRunDefinition({ seed = randomSeed(), windowMs, goal = 'Beat the game', spendCapUsd, unmeteredCallReserveUsd = 0 }) {
	if (!/^-?\d+$/.test(String(seed)) || BigInt(seed) < -(2n ** 63n) || BigInt(seed) >= 2n ** 63n) throw new TypeError('seed must be a signed 64-bit integer');
	if (!Number.isInteger(windowMs) || windowMs < 60000 || windowMs > MAX_LONG_RUN_WINDOW_MS) throw new RangeError(`windowMs must be 60000..${MAX_LONG_RUN_WINDOW_MS}`);
	if (!(spendCapUsd > 0)) throw new RangeError('spendCapUsd must be positive');
	if (typeof goal !== 'string' || !goal.trim() || goal.length > 200) throw new TypeError('goal must be a short non-empty string');
	return { id: 'LONG', version: 1, name: 'fresh-random-seed-long-run', seed: String(seed), goal, durationBudgetMs: windowMs,
		runPolicy: { clock: 'goal-start', continueAfterDeath: true, maxWindowMs: MAX_LONG_RUN_WINDOW_MS, stopOnAdvancement: 'end/kill_dragon' },
		worldSpawn: { policy: 'world_spawn' }, sampledAdvancements: [...LONG_RUN_ADVANCEMENTS], spendCapUsd, unmeteredCallReserveUsd,
		// The generality setup path keeps the player in survival throughout, so no construction message reaches the model.
		setup: { dimension: 'minecraft:overworld', startAt: 'world_spawn', generality: true, commands: [], inventory: [], armour: {}, effects: [], mobs: [], freezeUntilGoalStart: true } };
}

/** Cumulative model calls, tokens and cost over time, from per-call rows (Claude) or thread counters (Codex). */
export function spendSeries(traceRows, profile) {
	const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	const add = (a, b) => Object.fromEntries(Object.keys(zero).map(k => [k, a[k] + (b?.[k] ?? 0)]));
	const finalCalls = new Map(), loose = [];
	for (const row of traceRows) if (row.event === 'native_model_call' && (row.goalRevision === undefined || row.goalRevision >= 1)) {
		if (row.modelCallId) finalCalls.set(row.modelCallId, row); else loose.push(row);
	}
	const calls = [...loose, ...finalCalls.values()].map(r => ({ at: r.endedAt ?? epoch(r), tokens: providerCallTokens(r) })).filter(r => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
	const events = [];
	if (calls.some(c => c.tokens)) {
		let tokens = zero, count = 0;
		for (const c of calls) { tokens = add(tokens, c.tokens); count++; events.push({ at: c.at, calls: count, tokens, costUsd: estimateTokenCostUsd(tokens, profile) }); }
		return { basis: 'per-call rows', events };
	}
	const decisions = calls.length ? calls.map(c => c.at) : traceRows.filter(r => r.event === 'native_decision_timing' && (r.goalRevision === undefined || r.goalRevision >= 1)).map(epoch).filter(Number.isFinite).sort((a, b) => a - b);
	const latest = new Map();
	const counters = traceRows.filter(r => r.event === 'native_token_usage' && r.scope === 'thread_total' && Number.isFinite(epoch(r))).sort((a, b) => epoch(a) - epoch(b));
	const times = [...new Set([...decisions, ...counters.map(epoch)])].sort((a, b) => a - b);
	let index = 0;
	for (const at of times) {
		while (index < counters.length && epoch(counters[index]) <= at) { const r = counters[index++]; latest.set(`${r.agentId}|${r.goalRevision}|${r.sessionKey ?? 'default'}`, providerCallTokens(r)); }
		const tokens = [...latest.values()].reduce(add, zero);
		events.push({ at, calls: decisions.filter(t => t <= at).length, tokens, costUsd: estimateTokenCostUsd(tokens, profile) });
	}
	return { basis: 'thread counters', events };
}

const cumulativeAt = (series, at) => series.events.findLast(e => e.at <= at) ?? { calls: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: 0 };
const delta = (a, b) => ({ calls: a.calls - b.calls, tokens: Object.fromEntries(Object.keys(a.tokens).map(k => [k, a.tokens[k] - b.tokens[k]])),
	costUsd: Number.isFinite(a.costUsd) && Number.isFinite(b.costUsd) ? a.costUsd - b.costUsd : null });

/** First time each milestone shows in sampled player state, observations or advancements, with the spend to reach it. */
export function extractLongRunTimeline({ samples = [], protocolRows = [], traceRows = [], metrics = null, profile, stopRequest = null, windowMs = null, termination = null, authoritativeDragon = false, startedAt: fallbackStart = null, endedAt: fallbackEnd = null, agentId = null }) {
	agentId ??= protocolRows.map(r => r.envelope ?? r).find(e => e.type === 'goal_control' && e.payload?.operation === 'start')?.agentId ?? traceRows.find(r => r.goalRevision >= 1)?.agentId ?? null;
	protocolRows = protocolRows.filter(row => { const e = row.envelope ?? row; return e.type === 'advancement_granted' || e.type === 'observation' ? agentId && e.agentId === agentId : !agentId || !e.agentId || e.agentId === agentId; });
	const window = resolveGoalWindow(protocolRows, { agentId });
	const startedAt = window.startedAt ?? fallbackStart ?? samples[0]?.at ?? null;
	const endedAt = window.endedAt ?? fallbackEnd ?? samples.at(-1)?.at ?? null;
	const inWindow = at => Number.isFinite(at) && (startedAt === null || at >= startedAt) && (endedAt === null || at <= endedAt);
	const observations = protocolRows.map(r => r.envelope ?? r).filter(r => r.type === 'observation').map(r => ({ at: r.payload?.observedAtEpochMs ?? epoch(r),
		dimension: r.payload?.dimension ?? r.payload?.world?.dimension ?? null, items: (r.payload?.inventory?.items ?? []).filter(i => i.count > 0).map(i => i.itemId) })).filter(o => inWindow(o.at)).sort((a, b) => a.at - b.at);
	const points = samples.filter(s => inWindow(s.at)).sort((a, b) => a.at - b.at);
	const advancements = protocolRows.map(r => ({ ...(r.envelope ?? r), observedAtMs: r.observedAtMs ?? (r.envelope ?? r).observedAtMs })).filter(r => r.type === 'advancement_granted');
	const series = spendSeries(traceRows, profile);
	const reached = LONG_RUN_MILESTONES.map(m => {
		const candidates = [];
		if (m.item) {
			const first = points.find(s => itemCount(`${s.inventoryNbt ?? ''}${s.equipmentNbt ?? ''}`, m.item) > 0); if (first) candidates.push({ at: first.at, via: 'sampled inventory' });
			const seen = observations.find(o => o.items.some(id => m.item.test(id))); if (seen) candidates.push({ at: seen.at, via: 'observation inventory' });
		}
		if (m.dimension) {
			const first = points.find(s => s.dimension === m.dimension); if (first) candidates.push({ at: first.at, via: 'sampled dimension' });
			const seen = observations.find(o => o.dimension === m.dimension); if (seen) candidates.push({ at: seen.at, via: 'observation dimension' });
		}
		if (m.id === 'dragon' && authoritativeDragon && window.goalCompleted) candidates.push({ at: window.endedAt, via: 'server-verified dragon attribution' });
		if (m.advancement && !(m.id === 'dragon' && authoritativeDragon)) {
			for (const row of advancements) {
				const p = row.payload ?? {}, at = p.grantedAtEpochMs ?? p.updatedAtEpochMs ?? epoch(row);
				if ((p.advancementId ?? '').replace(/^minecraft:/, '') === m.advancement && inWindow(at)) candidates.push({ at, via: `advancement ${m.advancement}` });
			}
			const first = points.find(s => s.advancements?.includes(m.advancement));
			if (first) candidates.push({ at: first.at, via: `advancement ${m.advancement}` });
		}
		const first = candidates.sort((a, b) => a.at - b.at)[0] ?? null;
		const last = points.at(-1);
		return { id: m.id, label: m.label, reached: Boolean(first), reachedMeaning: 'first observed possession or event; not proof of earnings or retention',
			heldAtStageEnd: m.item && last ? itemCount(`${last.inventoryNbt ?? ''}${last.equipmentNbt ?? ''}`, m.item) > 0 : null, heldAtStageEndObservedAt: m.item ? last?.at ?? null : null, at: first?.at ?? null, elapsedMs: first && startedAt !== null ? first.at - startedAt : null, via: first?.via ?? null };
	});
	let previous = { at: startedAt, spend: cumulativeAt(series, -Infinity) };
	for (const m of reached.filter(r => r.reached).sort((a, b) => a.at - b.at)) {
		const spend = cumulativeAt(series, m.at);
		Object.assign(m, { cumulative: spend, segment: { durationMs: previous.at === null ? null : m.at - previous.at, ...delta(spend, previous.spend) } });
		previous = { at: m.at, spend };
	}
	const deathEvents = metrics?.qualityV2?.deathEvents ?? metrics?.deathEvents ?? [];
	const deaths = deathEvents.filter(e => Number.isFinite(e.at)).map(e => ({ at: e.at, elapsedMs: startedAt === null ? null : e.at - startedAt,
		cause: typeof e.cause === 'string' ? e.cause : e.cause ? JSON.stringify(e.cause) : 'unknown', cumulative: cumulativeAt(series, e.at) }));
	const unexplainedDeaths = Math.max(0, (metrics?.deaths ?? 0) - deaths.length);
	const total = series.events.at(-1) ?? cumulativeAt(series, -Infinity);
	const playedMs = startedAt !== null && endedAt !== null ? endedAt - startedAt : null;
	const dragon = reached.find(m => m.id === 'dragon');
	const stopReason = dragon.reached || (!authoritativeDragon && stopRequest?.reason === 'ADVANCEMENT') ? 'DRAGON_KILLED' : stopRequest?.reason === 'SPEND_CAP' ? 'SPEND_CAP'
		: window.goalCompleted ? 'GOAL_COMPLETED_CLAIM' : Number.isFinite(windowMs) && playedMs !== null && playedMs >= windowMs - 5000 ? 'WALL_CLOCK_BUDGET' : `ENDED_EARLY:${stopRequest?.reason ?? termination ?? 'UNKNOWN_TERMINATION'}`;
	const furthest = LONG_RUN_MILESTONES.findLast(m => reached.find(r => r.id === m.id).reached)?.id ?? null;
	return { startedAt, endedAt, playedMs, stopReason, authoritativeDragon, spendBasis: series.basis, furthestMilestone: furthest, milestonesReached: reached.filter(r => r.reached).length,
		milestones: reached, deaths, unexplainedDeaths, totals: { calls: metrics?.modelCalls ?? total.calls, tokens: total.tokens, playCostUsd: total.costUsd, costEstimateUsd: metrics?.costEstimateUsd ?? null } };
}

const minutes = ms => Number.isFinite(ms) ? `${(ms / 60000).toFixed(1)} min` : '?';
const usd = value => Number.isFinite(value) ? `$${value.toFixed(3)}` : '?';
const charged = t => t ? t.input + t.cacheWrite + t.output : null;

export function formatLongRunTimeline(report) {
	const t = report.timeline;
	const lines = [`# Long run ${report.runId}`, '', `Seed \`${report.seed}\`, ${report.profile.provider} ${report.profile.model} (${report.profile.reasoningEffort}, ${report.profile.serviceTier}), goal "${report.goal}".`,
		`Window ${minutes(report.windowMs)}, played ${minutes(t.playedMs)}, stop: **${t.stopReason}**. Furthest milestone: ${t.furthestMilestone ?? 'none'} (${t.milestonesReached}/${t.milestones.length}).`,
		`Spend: run ${usd(report.spend.usd)} (metered ${usd(report.spend.meteredUsd)}, reserve ${usd(report.spend.reservedUsd)}); ledger committed ${usd(report.ledger.committedUsd)} of cap ${usd(report.ledger.capUsd)}.`, '',
		'| Milestone | First observed at (acquisition only) | Held at stage end | Via | Segment time | Segment calls | Segment charged tokens | Segment cost | Cumulative cost |', '|---|---:|---|---|---:|---:|---:|---:|---:|'];
	for (const m of t.milestones) {
		const stage = report.stageScore?.afterDeath?.samples ? report.stageScore.afterDeath : report.stageScore?.firstLife;
		const held = stage?.milestones?.[m.id]?.heldAtStageEnd;
		lines.push(m.reached ? `| ${m.label} | ${minutes(m.elapsedMs)} | ${held == null ? 'unobserved/event' : held ? 'yes' : 'no'} | ${m.via} | ${minutes(m.segment.durationMs)} | ${m.segment.calls} | ${charged(m.segment.tokens)} | ${usd(m.segment.costUsd)} | ${usd(m.cumulative.costUsd)} |` : `| ${m.label} | not observed | unobserved | | | | | | |`);
	}
	if (report.ending) lines.push('', `Ending: ${report.ending.kind}; reason: ${report.ending.reason}. Unobserved continuation ${report.ending.censored ? 'is censored' : 'after completion is outside the stage'}.`);
	if (report.stageScore?.firstLife) lines.push('', `First life: ${report.stageScore.firstLife.status}; after death: ${report.stageScore.afterDeath.status}. See stage-score.json for resource accounting and death trace.`);
	lines.push('', `Deaths: ${t.deaths.length + t.unexplainedDeaths}`);
	if (t.deaths.length) lines.push('', '| At | Cause | Cumulative cost |', '|---:|---|---:|', ...t.deaths.map(d => `| ${minutes(d.elapsedMs)} | ${d.cause} | ${usd(d.cumulative.costUsd)} |`));
	if (t.unexplainedDeaths) lines.push('', `${t.unexplainedDeaths} deaths had no recorded cause.`);
	if (report.failure || report.diagnostics) lines.push('', `Diagnostic: ${report.failure ?? report.diagnostics}`);
	if (report.observerErrors?.length) lines.push('', 'Evidence limits:', ...report.observerErrors.map(error => `- ${error}`));
	lines.push('', 'Dollar amounts are token-price estimates, not ChatGPT plan charges.', '', `Totals: ${t.totals.calls} model calls, ${charged(t.totals.tokens)} charged tokens (${t.spendBasis}), play cost ${usd(t.totals.playCostUsd)}.`);
	return lines.join('\n') + '\n';
}
