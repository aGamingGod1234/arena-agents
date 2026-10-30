import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONTEXT_ROTATION_TOKENS } from '../src/context-carry-over.mjs';
import { HandoffBudget } from '../src/handoff-budget.mjs';

// Repository price proxy, not a provider invoice.
export const PRICE_PER_MILLION = { read: 0.2, write: 8, input: 2, output: 20 };
export function tokenCost(categories) {
	return Object.entries(PRICE_PER_MILLION).reduce((sum, [key, price]) => sum + categories[key] * price / 1e6, 0);
}
function categories(call) {
	const result = { read: call.cachedInputTokens, write: call.cacheWriteInputTokens,
		input: call.contextTokens - call.cachedInputTokens - call.cacheWriteInputTokens, output: call.outputTokens };
	if (Object.values(result).some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Invalid recorded token categories');
	return result;
}

/** Candidate resets use the production economic policy, not recorded reset dates.
 * Calls and outputs stay fixed. Growth hidden by a baseline reset is an explicit scenario,
 * from zero to all its non-read input; this interval is not a proven trace-derived bound.
 * The trace has no payload-byte series: the default holds bytes constant, with no size-growth surcharge.
 */
export function replayContextCost(calls, { threshold = DEFAULT_CONTEXT_ROTATION_TOKENS, handoffTokens = 37_000,
	prefixTokens = 17_330, boundaryGrowthShare = 1, payloadBytesByCall = [] } = {}) {
	if (!(threshold > 0 && handoffTokens >= prefixTokens && prefixTokens >= 0
		&& boundaryGrowthShare >= 0 && boundaryGrowthShare <= 1)) throw new Error('Invalid replay parameters');
	const budget = new HandoffBudget();
	let context = 0, floor = null, baselineUsd = 0, candidateUsd = 0, resets = 0;
	let maxPrefixOverheadUsd = 0, maxPrefixOverheadIndex = null, maxPrefixOverheadPercent = 0;
	const rows = [];
	for (const [index, call] of calls.entries()) {
		const measured = categories(call), projected = { ...measured };
		const previous = calls[index - 1];
		const naturalReset = previous !== undefined && call.rotations !== previous.rotations;
		const payloadBytes = payloadBytesByCall[index] ?? 0;
		let reset = false, quote = null;
		if (previous === undefined) {
			context = call.contextTokens;
			budget.startSession(payloadBytes);
		} else {
			quote = budget.quote(payloadBytes);
			if (context >= threshold && (floor === null || context - floor >= threshold / 4)
				&& budget.reserve(payloadBytes)) {
				reset = true;
				resets += 1;
				context = handoffTokens;
				floor = context;
				projected.read = prefixTokens;
				projected.write = handoffTokens - projected.read - projected.input;
				budget.startSession(payloadBytes);
			} else {
				const growth = naturalReset ? Math.round((measured.write + measured.input) * boundaryGrowthShare)
					: call.contextTokens - previous.contextTokens;
				context += growth;
				if (naturalReset) projected.write = Math.max(0, growth - projected.input);
				projected.read = context - projected.write - projected.input;
			}
		}
		if (Object.values(projected).some((value) => value < 0)) throw new Error('Scenario cannot fit recorded uncached input or writes');
		budget.noteUsage({ cacheRead: projected.read, cacheWrite: projected.write, input: projected.input });
		const baselineCallUsd = tokenCost(measured), candidateCallUsd = tokenCost(projected);
		baselineUsd += baselineCallUsd;
		candidateUsd += candidateCallUsd;
		const cumulativeDeltaUsd = candidateUsd - baselineUsd;
		if (cumulativeDeltaUsd > maxPrefixOverheadUsd) { maxPrefixOverheadUsd = cumulativeDeltaUsd; maxPrefixOverheadIndex = index; }
		maxPrefixOverheadPercent = Math.max(maxPrefixOverheadPercent, 100 * cumulativeDeltaUsd / baselineUsd);
		rows.push({ index, baselineContext: call.contextTokens, candidateContext: context, naturalReset, reset,
			turnBoundary: previous !== undefined && previous.turnId !== call.turnId,
			measured, projected, quote, budget: budget.snapshot, baselineCallUsd, candidateCallUsd, cumulativeDeltaUsd });
	}
	const mean = (key) => rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
	return { assumptions: { threshold, handoffTokens, prefixTokens, boundaryGrowthShare, recordedNaturalResetsPreserved: false,
		unchangedCallsOutputs: true, payloadByteGrowthKnown: payloadBytesByCall.length > 0 }, calls: rows.length, resets, baselineUsd, candidateUsd,
		deltaUsd: candidateUsd - baselineUsd, deltaPercent: baselineUsd ? 100 * (candidateUsd - baselineUsd) / baselineUsd : 0,
		maxPrefixOverheadUsd, maxPrefixOverheadIndex, maxPrefixOverheadPercent,
		baselineMeanContext: mean('baselineContext'), candidateMeanContext: mean('candidateContext'),
		candidatePeakContext: Math.max(0, ...rows.map((row) => row.candidateContext)), budget: budget.snapshot, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [file] = process.argv.slice(2);
	if (!file) throw new Error('Usage: node scripts/context-cost-replay.mjs coordinator.jsonl-or-fixture.json');
	const content = readFileSync(file, 'utf8');
	const calls = content.trimStart().startsWith('[') ? JSON.parse(content) : content.split(/\r?\n/).filter(Boolean).map(JSON.parse)
		.filter((row) => row.event === 'native_model_call' && row.goalRevision >= 1);
	const scenarios = [];
	for (const [scenario, handoffTokens, prefixTokens] of [['typical-assumption', 37_000, 17_330], ['stress-assumption', 60_000, 0]]) {
		for (const boundaryGrowthShare of [0, 1]) scenarios.push({ scenario, ...replayContextCost(calls, { handoffTokens, prefixTokens, boundaryGrowthShare }) });
	}
	console.log(JSON.stringify(scenarios, null, 2));
}
