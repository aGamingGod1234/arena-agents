import { createHash } from 'node:crypto';
import { TOKEN_PRICES_PER_MILLION, estimateTokenCostUsd } from '../call-cost.mjs';

export const SPEED_BENCHMARK_SCHEMA_VERSION = 1;
export const SPEED_BENCHMARK_SEED = '20261008';
export const SPEED_BENCHMARK_TIMEOUT_MS = 300_000;

export const DEFAULT_SPEED_PROFILES = Object.freeze([
	Object.freeze({ provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' }),
	Object.freeze({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' }),
]);

export const SPEED_TOKEN_PRICES_PER_MILLION = TOKEN_PRICES_PER_MILLION;

export const SPEED_SCENARIOS = Object.freeze([
	Object.freeze({
		id: 'logs-pickaxe',
		task: 'Gather all 8 oak logs from the compact tree directly in front of you. Use the nearby crafting table to craft one wooden pickaxe from those logs. Verify that the tree is gone, the pickaxe is in your inventory, and at least 6 oak logs remain; then call the complete_goal action immediately.',
		setupBlocks: Object.freeze([
			[0, 201, 1], [0, 202, 1], [0, 203, 1], [0, 204, 1], [1, 201, 1], [1, 202, 1], [1, 203, 1], [1, 204, 1],
		].map(([x, y, z]) => Object.freeze({ x, y, z, blockId: 'minecraft:oak_log' })).concat([
			Object.freeze({ x: -1, y: 201, z: 1, blockId: 'minecraft:crafting_table' }),
		])),
		assertions: Object.freeze([
			Object.freeze({ type: 'lifecycle', state: 'COMPLETED' }),
			Object.freeze({ type: 'rcon', command: 'execute if items entity {agent} container.* minecraft:wooden_pickaxe run data get entity {agent} Inventory', match: 'has the following entity data' }),
			Object.freeze({ type: 'rcon', command: 'execute if items entity {agent} container.* minecraft:oak_log run data get entity {agent} Inventory', match: 'has the following entity data' }),
			...[ [0, 201, 1], [0, 202, 1], [0, 203, 1], [0, 204, 1], [1, 201, 1], [1, 202, 1], [1, 203, 1], [1, 204, 1] ].map(([x, y, z]) => Object.freeze({
				type: 'rcon', command: `execute if block ${x} ${y} ${z} minecraft:air run data get entity {agent} Pos`, match: 'has the following entity data',
			})),
		]),
	}),
	Object.freeze({
		id: 'mine-stone',
		task: 'Use the iron pickaxe already in your inventory to mine all 16 stone blocks of the 4 by 4 stone wall at x=2 to 5, y=201 to 204, z=2 (not the floor). Verify that all 16 blocks are gone, then call the complete_goal action immediately.',
		setupBlocks: Object.freeze(Array.from({ length: 16 }, (_, index) => Object.freeze({
			x: 2 + (index % 4), y: 201 + Math.floor(index / 4), z: 2, blockId: 'minecraft:stone',
		}))),
		assertions: Object.freeze([
			Object.freeze({ type: 'lifecycle', state: 'COMPLETED' }),
			...Array.from({ length: 16 }, (_, index) => {
				const x = 2 + (index % 4), y = 201 + Math.floor(index / 4);
				return Object.freeze({ type: 'rcon', command: `execute if block ${x} ${y} 2 minecraft:air run data get entity {agent} Pos`, match: 'has the following entity data' });
			}),
		]),
	}),
	Object.freeze({
		id: 'walk-120',
		task: 'Walk over the varied terrain to the bright marker about 120 blocks straight ahead. Stop on the gold floor marker at z=120, verify your position, then call the complete_goal action immediately.',
		setupBlocks: Object.freeze([]),
		assertions: Object.freeze([
			Object.freeze({ type: 'lifecycle', state: 'COMPLETED' }),
			Object.freeze({ type: 'rcon', command: 'data get entity {agent} Pos', match: '201.0d, 120.' }),
		]),
	}),
]);

// Scenarios removed until their setup and objective can be verified. zombie-response promised a zombie encounter and an
// iron sword but set up neither, and passed on lifecycle completion plus a readable position.
const UNSUPPORTED_SPEED_SCENARIOS = Object.freeze(['zombie-response']);

export function createSpeedMatrix({ profiles = DEFAULT_SPEED_PROFILES, repetitions = 3, runId = 'live-speed', scenarioIds = null, timeoutMs = SPEED_BENCHMARK_TIMEOUT_MS } = {}) {
	if (!Array.isArray(profiles) || profiles.length === 0) throw new TypeError('profiles must be a non-empty array');
	if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 32) throw new RangeError('repetitions must be in 1..32');
	if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new TypeError('runId must be a safe path segment');
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SPEED_BENCHMARK_TIMEOUT_MS) throw new RangeError(`timeoutMs must be in 1..${SPEED_BENCHMARK_TIMEOUT_MS}`);
	const unsupported = (scenarioIds ?? []).filter((id) => UNSUPPORTED_SPEED_SCENARIOS.includes(id));
	if (unsupported.length) throw new TypeError(`unsupported benchmark scenario: ${unsupported.join(', ')} has no verified encounter setup or objective`);
	const selectedScenarios = scenarioIds === null ? SPEED_SCENARIOS : SPEED_SCENARIOS.filter(({ id }) => scenarioIds.includes(id));
	if (selectedScenarios.length === 0 || (scenarioIds !== null && selectedScenarios.length !== new Set(scenarioIds).size)) throw new TypeError('scenarioIds must select known benchmark scenarios');
	const normalizedProfiles = profiles.map(normalizeProfile);
	const profileKey = (profile) => [profile.provider, profile.model, profile.reasoningEffort, profile.serviceTier].join('|');
	if (new Set(normalizedProfiles.map(profileKey)).size !== normalizedProfiles.length) throw new TypeError('profiles must not repeat the same provider, model, effort and tier');
	// The provider alone names a profile when it is unique; same-provider profiles also carry a digest of the full tuple.
	const providerCounts = new Map();
	for (const profile of normalizedProfiles) providerCounts.set(profile.provider, (providerCounts.get(profile.provider) ?? 0) + 1);
	const profileSegment = (profile) => providerCounts.get(profile.provider) === 1 ? profile.provider
		: `${profile.provider}-${createHash('sha256').update(profileKey(profile)).digest('hex').slice(0, 8)}`;
	const scenarios = [];
	for (let repetition = 1; repetition <= repetitions; repetition += 1) {
		for (const scenario of selectedScenarios) {
			for (const profile of normalizedProfiles) {
				const id = `${runId}-${scenario.id}-${profileSegment(profile)}-r${repetition}`;
				scenarios.push({
					id, provider: profile.provider, model: profile.model, reasoningEffort: profile.reasoningEffort,
					serviceTier: profile.serviceTier, task: scenario.task, timeoutMs, scenarioTimeoutMs: timeoutMs,
					planningTimeoutMs: Math.min(120_000, timeoutMs), rosterSize: 1, repetitions: 1,
					requireFactualSuccess: true,
					...(scenario.setupBlocks.length ? { setupBlocks: scenario.setupBlocks.map((block) => ({ ...block })) } : {}),
					assert: scenario.assertions.map((assertion) => ({ ...assertion })),
					world: { mode: 'arena' },
				});
			}
		}
	}
	return Object.freeze({ version: 1, scenarios: Object.freeze(scenarios.map((scenario) => Object.freeze(scenario))) });
}

export function deriveRunMetrics({ traceRows = [], protocolRows = [], goalStartedAtMs = null, goalCompletedAtMs = null, goalVerifiedAtMs = null, goalObjectiveAtMs = null, tickSamples = [], profile, zombieSpawnAtMs = null, zombieResolutionAtMs = null, zombieResolution = null } = {}) {
	const exactProfile = normalizeProfile(profile);
	const inGoal = (row) => row && Number.isSafeInteger(row.goalRevision) && row.goalRevision >= 1
		&& (row.provider === undefined || row.provider === exactProfile.provider)
		&& (row.model === undefined || row.model === exactProfile.model);
	const scopedTrace = traceRows.filter((row) => inGoal(row) && row.agentId !== undefined);
	const agentId = scopedTrace.find((row) => typeof row.agentId === 'string')?.agentId ?? null;
	const rows = scopedTrace.filter((row) => agentId === null || row.agentId === agentId);
	const callRows = rows.filter((row) => row.event === 'native_model_call');
	const correctedCalls = new Map(callRows.filter(row => row.modelCallId).map(row => [row.modelCallId, row]));
	const modelCalls = callRows.filter(row => !row.modelCallId || correctedCalls.get(row.modelCallId) === row);
	const segments = rows.filter(row => row.event === 'native_decision_timing' && row.outcome === 'completed' && Number.isFinite(row.segmentDurationMs));
	const decisionRounds = segments.map(row => row.segmentDurationMs);
	const tokenCounts = (modelCalls.length > 0 ? tokensFromModelCalls(modelCalls) : null) ?? tokensFromUsageRows(rows);
	const dispatches = uniqueBy(rows.filter((row) => row.event === 'native_tool_dispatch_started' && typeof row.actionId === 'string'), (row) => row.actionId);
	const completions = uniqueBy(rows.filter((row) => row.event === 'native_tool_action_completed' && typeof row.actionId === 'string'), (row) => row.actionId);
	const actions = dispatches.length;
	const actionTimes = new Map(dispatches.map((row) => [row.actionId, eventTime(row)]));
	const completionByAction = new Map(completions.map((row) => [row.actionId, eventTime(row)]));
	const goalEndAtMs = goalVerifiedAtMs ?? goalCompletedAtMs;
	const bodyIdle = bodyIdleTime(dispatches, actionTimes, completionByAction, goalStartedAtMs, goalEndAtMs);
	const wallTimeMs = Number.isFinite(goalStartedAtMs) && Number.isFinite(goalEndAtMs)
		? Math.max(0, goalEndAtMs - goalStartedAtMs)
		: null;
	const wallTimeToVerifiedMs = Number.isFinite(goalStartedAtMs) && Number.isFinite(goalVerifiedAtMs)
		? Math.max(0, goalVerifiedAtMs - goalStartedAtMs) : null;
	const wallTimeToObjectiveMs = Number.isFinite(goalStartedAtMs) && Number.isFinite(goalObjectiveAtMs) ? Math.max(0, goalObjectiveAtMs - goalStartedAtMs) : null;
	const firstCombatActionMs = Number.isFinite(zombieSpawnAtMs) ? firstCombatTime([...rows, ...protocolRows], agentId, zombieSpawnAtMs) : null;
	const tick = summarizeTickSamples(tickSamples.map((sample) => typeof sample === 'number' ? sample : sample?.mspt));
	const costEstimateUsd = tokenCounts === null ? null : estimateTokenCost(tokenCounts, exactProfile);
	return Object.freeze({
		wallTimeMs,
		wallTimeToVerifiedMs,
		wallTimeToObjectiveMs,
		modelRounds: modelCalls.length || rows.filter(row => row.event === 'native_decision_timing').length,
		decisionSegments: decisionRounds.length,
		modelRoundTimingBasis: 'completed provider decision segments; excludes tool execution and queue wait',
		providerUsageTimingMs: { count: modelCalls.filter(row => Number.isFinite(row.totalMs)).length, median: percentile(modelCalls.filter(row => Number.isFinite(row.totalMs)).map(row => row.totalMs), 0.5) },
		tokens: tokenCounts,
		costEstimateUsd,
		costEstimateBasis: 'shared token-cost proxy; Codex fast tier modeled at 2x, Claude proxy fitted to reported CLI costs; subscription usage is not a per-run invoice',
		medianModelRoundMs: percentile(decisionRounds, 0.5),
		p90ModelRoundMs: percentile(decisionRounds, 0.9),
		bodyIdleTimeMs: bodyIdle,
		bodyIdleShare: bodyIdle !== null && wallTimeMs > 0 ? bodyIdle / wallTimeMs : null,
		bodyIdleBasis: 'coordinator dispatch-to-completion timestamps of body actions (chat excluded), merged and clipped to the goal window; a proxy for physical occupancy',
		actions,
		actionsPerMinute: wallTimeMs > 0 ? actions * 60_000 / wallTimeMs : null,
		tickTime: Object.freeze({ source: 'RCON tick-query samples, approximately one sample per second', ...tick }),
		...(Number.isFinite(zombieSpawnAtMs) ? {
			zombie: Object.freeze({
				timeToFirstCombatActionMs: Number.isFinite(firstCombatActionMs) ? Math.max(0, firstCombatActionMs - zombieSpawnAtMs) : null,
				timeToKillOrEscapeMs: Number.isFinite(zombieResolutionAtMs) ? Math.max(0, zombieResolutionAtMs - zombieSpawnAtMs) : null,
				resolution: typeof zombieResolution === 'string' ? zombieResolution : null,
			}),
		} : {}),
	});
}

export function summarizeSpeedBenchmark(runs = []) {
	const groups = new Map();
	for (const run of runs) {
		const profile = normalizeProfile(run.profile);
		const key = [run.scenario, profile.provider, profile.model, profile.reasoningEffort, profile.serviceTier].join('|');
		if (!groups.has(key)) groups.set(key, { scenario: run.scenario, profile, runs: [] });
		groups.get(key).runs.push(run);
	}
	return [...groups.values()].map((group) => {
		const passedRuns = group.runs.filter((run) => run.status === 'PASSED' && run.metrics);
		const metricNames = ['wallTimeMs', 'wallTimeToVerifiedMs', 'wallTimeToObjectiveMs', 'modelRounds', 'costEstimateUsd', 'medianModelRoundMs', 'p90ModelRoundMs', 'bodyIdleTimeMs', 'bodyIdleShare', 'actionsPerMinute'];
		const metrics = Object.fromEntries(metricNames.map((name) => [name, summarizeSamples(passedRuns.map((run) => run.metrics?.[name]))]));
		const tokens = Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output'].map((name) => [name, summarizeSamples(passedRuns.map((run) => run.metrics?.tokens?.[name]))]));
		const tickTime = Object.fromEntries(['meanMs', 'p95Ms', 'maxMs'].map((name) => [name, summarizeSamples(passedRuns.map((run) => run.metrics?.tickTime?.[name]))]));
		return Object.freeze({ scenario: group.scenario, profile: group.profile, attempts: group.runs.length, passed: passedRuns.length,
			failed: group.runs.length - passedRuns.length, metrics, tokens, tickTime });
	});
}

export function compareSpeedBenchmarks(baseline, candidate) {
	const baselineSummary = summarizeSpeedBenchmark(baseline?.runs ?? []);
	const candidateSummary = summarizeSpeedBenchmark(candidate?.runs ?? []);
	const candidates = new Map(candidateSummary.map((row) => [summaryKey(row), row]));
	return baselineSummary.map((before) => {
		const after = candidates.get(summaryKey(before)) ?? null;
		const dimensions = ['wallTimeMs', 'wallTimeToVerifiedMs', 'actionsPerMinute', 'costEstimateUsd', 'medianModelRoundMs', 'p90ModelRoundMs', 'bodyIdleShare'];
		const change = Object.fromEntries(dimensions.map((name) => {
			const baselineMedian = before.metrics[name]?.median ?? null;
			const candidateMedian = after?.metrics[name]?.median ?? null;
			const delta = baselineMedian === null || candidateMedian === null ? null : round(candidateMedian - baselineMedian, 3);
			return [name, { delta, percent: baselineMedian === null || baselineMedian === 0 || candidateMedian === null ? null : round(delta / baselineMedian * 100, 3) }];
		}));
		return Object.freeze({ scenario: before.scenario, profile: before.profile,
			baseline: { attempts: before.attempts, passed: before.passed, wallTimeMs: before.metrics.wallTimeMs, wallTimeToVerifiedMs: before.metrics.wallTimeToVerifiedMs,
				costEstimateUsd: before.metrics.costEstimateUsd, p90ModelRoundMs: before.metrics.p90ModelRoundMs },
			candidate: after === null ? null : { attempts: after.attempts, passed: after.passed, wallTimeMs: after.metrics.wallTimeMs, wallTimeToVerifiedMs: after.metrics.wallTimeToVerifiedMs,
				costEstimateUsd: after.metrics.costEstimateUsd, p90ModelRoundMs: after.metrics.p90ModelRoundMs }, change });
	});
}

export function formatSpeedSummaryMarkdown(report) {
	const rows = summarizeSpeedBenchmark(report.runs ?? []);
	const lines = [
		'# Live speed benchmark', '',
		`- Base commit: \`${report.sourceCommit ?? 'unknown'}\``,
		`- Seed: \`${report.seed ?? SPEED_BENCHMARK_SEED}\``,
		`- Captured: ${report.capturedAt ?? 'unknown'}`,
		'- Method: live headless Fabric server, real coordinator and provider CLI sessions; one fresh arena per repetition.',
		'- Cost uses the shared token-cost proxy: Codex fast tier is modeled at 2x and Claude weights are fitted to reported CLI costs. It does not represent subscription billing.',
		'- Body idle and model round times come from coordinator traces observed by the harness on approximately 20 ms polls because trace rows have no wall timestamps.',
		'- Tick mean/p95/max are statistics of periodic RCON tick-query samples, not a full per-tick histogram.', '',
		'- Spread is the maximum minus minimum among successful repetitions.',
		'| Scenario | Provider / model | Passed | Goal wall time median (spread) | Verified wall time median (spread) | Rounds | Uncached input / cache read / cache write / output tokens | Cost median | Model round p50 / p90 | Body idle median / share | Actions/min | Tick mean / p95 / max |',
		'|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
	];
	for (const row of rows) {
		const p = row.profile, m = row.metrics, tokens = row.tokens, tick = row.tickTime;
		lines.push(`| ${row.scenario} | ${p.provider} / ${p.model} (${p.reasoningEffort}, ${p.serviceTier}) | ${row.passed}/${row.attempts} | ${formatSpread(m.wallTimeMs, ' ms')} | ${formatSpread(m.wallTimeToVerifiedMs, ' ms')} | ${formatSpread(m.modelRounds, '')} | ${formatSpread(tokens.input, '')} / ${formatSpread(tokens.cacheRead, '')} / ${formatSpread(tokens.cacheWrite, '')} / ${formatSpread(tokens.output, '')} | ${formatSpread(m.costEstimateUsd, ' USD')} | ${formatSpread(m.medianModelRoundMs, ' ms')} / ${formatSpread(m.p90ModelRoundMs, ' ms')} | ${formatSpread(m.bodyIdleTimeMs, ' ms')} / ${formatSpread(m.bodyIdleShare, '%', 100)} | ${formatSpread(m.actionsPerMinute, '')} | ${formatSpread(tick.meanMs, ' ms')} / ${formatSpread(tick.p95Ms, ' ms')} / ${formatSpread(tick.maxMs, ' ms')} |`);
	}
	lines.push('', '## Run notes', '', 'Each attempt is stored in the JSON with its status, trace-derived metrics, objective verification, tick samples, and artifact directory. A failed or timed-out run remains in the results and does not contribute to successful-run medians.', '');
	return lines.join('\n');
}

function normalizeProfile(profile) {
	if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError('profile must be an object');
	for (const field of ['provider', 'model', 'reasoningEffort', 'serviceTier']) if (typeof profile[field] !== 'string' || profile[field].trim() === '') throw new TypeError(`profile.${field} must be nonblank`);
	if (!['codex', 'claude'].includes(profile.provider)) throw new TypeError('profile.provider must be codex or claude');
	return Object.freeze({ provider: profile.provider, model: profile.model, reasoningEffort: profile.reasoningEffort, serviceTier: profile.serviceTier });
}

function tokensFromModelCalls(rows) {
	const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	let observedUsage = false;
	for (const row of rows) {
		observedUsage ||= ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens'].some((key) => Number.isFinite(row[key]));
		const cacheRead = tokenValue(row.cachedInputTokens);
		const cacheWrite = tokenValue(row.cacheWriteInputTokens);
		const totalInput = tokenValue(row.inputTokens, tokenValue(row.uncachedInputTokens) + cacheRead + cacheWrite);
		totals.input += Math.max(0, totalInput - cacheRead - cacheWrite);
		totals.cacheRead += cacheRead;
		totals.cacheWrite += cacheWrite;
		totals.output += tokenValue(row.outputTokens);
	}
	return observedUsage ? Object.freeze(totals) : null;
}

function tokensFromUsageRows(rows) {
	const latest = new Map();
	for (const row of rows) if (row.event === 'native_token_usage' && row.scope === 'thread_total') latest.set(`${row.agentId}|${row.goalRevision}|${row.sessionKey ?? 'default'}`, row);
	if (latest.size === 0) return null;
	const result = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	for (const row of latest.values()) {
		const cacheRead = tokenValue(row.cachedInputTokens);
		const cacheWrite = tokenValue(row.cacheWriteInputTokens);
		result.input += Math.max(0, tokenValue(row.inputTokens) - cacheRead - cacheWrite);
		result.cacheRead += cacheRead;
		result.cacheWrite += cacheWrite;
		result.output += tokenValue(row.outputTokens);
	}
	return Object.freeze(result);
}

function estimateTokenCost(tokens, profile) {
	const cost = estimateTokenCostUsd(tokens, profile);
	return cost === null ? null : round(cost, 6);
}

/**
 * Goal-window time with no body action in progress. Body occupancy is the union of each body action's dispatch to its
 * completion (chat runs alongside the body and is excluded), clipped to the goal window, so overlapping actions are not
 * charged twice and initial and final idle count. Unknown (null) when the window or any body action's start or completion
 * is missing.
 */
function bodyIdleTime(dispatches, startByAction, endByAction, windowStart, windowEnd) {
	if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd < windowStart) return null;
	const body = dispatches.filter((row) => row.actionType !== 'chat');
	if (body.length === 0) return null;
	const intervals = [];
	for (const row of body) {
		const start = startByAction.get(row.actionId);
		const end = endByAction.get(row.actionId);
		// A dispatch without a timed completion is missing evidence, not proof that the body stayed busy.
		if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
		const clippedEnd = Math.min(end, windowEnd);
		const clippedStart = Math.max(start, windowStart);
		if (clippedEnd > clippedStart) intervals.push([clippedStart, clippedEnd]);
	}
	intervals.sort((left, right) => left[0] - right[0]);
	let busy = 0;
	let currentStart = null;
	let currentEnd = null;
	for (const [start, end] of intervals) {
		if (currentEnd !== null && start <= currentEnd) { currentEnd = Math.max(currentEnd, end); continue; }
		if (currentEnd !== null) busy += currentEnd - currentStart;
		[currentStart, currentEnd] = [start, end];
	}
	if (currentEnd !== null) busy += currentEnd - currentStart;
	return Math.max(0, windowEnd - windowStart - busy);
}

// The first combat REQUEST after the threat appeared: a coordinator dispatch or an outbound action_command. Completions,
// rejections and progress of a request made before the spawn cannot start the reaction clock.
function firstCombatTime(rows, agentId, spawnAtMs) {
	const events = [];
	for (const wrapped of rows) {
		const row = wrapped?.envelope ? { ...wrapped.envelope, direction: wrapped.direction ?? wrapped.envelope.direction, observedAtMs: wrapped.observedAtMs ?? wrapped.envelope.observedAtMs, harnessObservedAtMs: wrapped.harnessObservedAtMs } : wrapped;
		const request = row.event === 'native_tool_dispatch_started'
			|| (row.type === 'action_command' && (row.direction === undefined || row.direction === 'coordinator_to_server'));
		if (!request) continue;
		if (agentId !== null && row.agentId !== undefined && row.agentId !== agentId) continue;
		if (Number.isSafeInteger(row.goalRevision) && row.goalRevision < 1) continue;
		if (Number.isSafeInteger(row.payload?.goalRevision) && row.payload.goalRevision < 1) continue;
		const type = String(row.actionType ?? row.payload?.actionType ?? '');
		const command = row.type === 'action_command' ? row.payload : row;
		const isCombat = /attack|fight_target|melee/i.test(type) || hasAttackInput(command);
		const at = eventTime(row);
		if (isCombat && Number.isFinite(at) && at >= spawnAtMs) events.push(at);
	}
	return events.length ? Math.min(...events) : null;
}

function hasAttackInput(value, depth = 0) {
	if (!value || typeof value !== 'object' || depth > 4) return false;
	if (value.attack === true) return true;
	return Object.values(value).some((child) => hasAttackInput(child, depth + 1));
}

function eventTime(row) { return Number.isFinite(row.observedAtMs) ? row.observedAtMs : Number.isFinite(row.harnessObservedAtMs) ? row.harnessObservedAtMs : null; }
function uniqueBy(rows, key) { const seen = new Set(); return rows.filter((row) => { const value = key(row); if (seen.has(value)) return false; seen.add(value); return true; }); }
function percentile(values, fraction) {
	const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (!clean.length) return null;
	if (fraction === 0.5 && clean.length % 2 === 0) return round((clean[clean.length / 2 - 1] + clean[clean.length / 2]) / 2, 3);
	return round(clean[Math.ceil(clean.length * fraction) - 1], 3);
}
function summarizeSamples(values) {
	const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (!clean.length) return Object.freeze({ count: 0, median: null, min: null, max: null, spread: null });
	const median = percentile(clean, 0.5);
	return Object.freeze({ count: clean.length, median, min: round(clean[0], 3), max: round(clean.at(-1), 3), spread: round(clean.at(-1) - clean[0], 3) });
}
function summarizeTickSamples(values) {
	const clean = values.filter(Number.isFinite);
	return Object.freeze({ count: clean.length, meanMs: clean.length ? round(clean.reduce((sum, value) => sum + value, 0) / clean.length, 3) : null,
		p95Ms: percentile(clean, 0.95), maxMs: clean.length ? round(Math.max(...clean), 3) : null });
}
function summaryKey(row) { return [row.scenario, row.profile.provider, row.profile.model, row.profile.reasoningEffort, row.profile.serviceTier].join('|'); }
function tokenValue(value, fallback = 0) { return Number.isFinite(value) && value >= 0 ? value : fallback; }
function round(value, places = 3) { const factor = 10 ** places; return Math.round(value * factor) / factor; }
function formatSpread(summary, suffix, multiplier = 1) {
	if (summary?.median === null || summary === null || summary === undefined) return 'n/a';
	const median = round(summary.median * multiplier, 3), spread = round(summary.spread * multiplier, 3);
	return `${median}${suffix} (${spread}${suffix})`;
}
