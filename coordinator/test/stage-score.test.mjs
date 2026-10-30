import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { scoreStageRun, resourceCounts, classifyEnding } from '../../scripts/quality/stage-score.mjs';
import { recordOperatorStop } from '../../scripts/quality/operator-stop.mjs';
import { parseLogAdvancements, evaluateSamples } from '../../scripts/quality/ladder-evaluator.mjs';
import { deriveRunMetrics } from '../src/benchmark/live-speed-benchmark.mjs';
import { buildReport, renderMarkdown } from '../src/decision-eval/report.mjs';
import { compareCases, screenVerdict } from '../src/decision-eval/stats.mjs';

const inventory = items => `[${Object.entries(items).map(([id, n]) => `{id: "minecraft:${id}", count: ${n}}`).join(', ')}]`;

test('equivalent resources survive rod/powder/eye recipes without invented gain or loss', () => {
	assert.deepEqual(resourceCounts({}), { rods: null, pearlsEyes: null, gold: null });
	assert.deepEqual(resourceCounts({ inventoryNbt: inventory({ blaze_rod: 2, blaze_powder: 2, ender_eye: 4, ender_pearl: 3, gold_block: 2, gold_nugget: 9 }) }), { rods: 5, pearlsEyes: 7, gold: 19 });
});

test('streaming stage score preserves a first-life failure when an operator censors recovery', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'd38-measure-test-'));
	try {
		await writeFile(path.join(dir, 'long-run.json'), JSON.stringify({ windowMs: 10000, definition: { setup: { inventory: [{ item: 'minecraft:blaze_rod', count: 6 }, { item: 'minecraft:gold_ingot', count: 10 }] } } }));
		const rows = [
			{ at: 1000, health: 20, deathCounter: 0, damageTakenCounter: 0, inventoryNbt: inventory({ blaze_rod: 6, gold_ingot: 10 }) },
			{ at: 2000, health: 10, deathCounter: 0, damageTakenCounter: 100, inventoryNbt: inventory({ blaze_powder: 12, gold_ingot: 8, ender_pearl: 2 }) },
			{ at: 3000, health: 0, deathCounter: 1, damageTakenCounter: 200, inventoryNbt: '[]' },
			{ at: 4000, health: 20, deathCounter: 1, damageTakenCounter: 200, inventoryNbt: inventory({ blaze_powder: 2 }) },
		];
		await writeFile(path.join(dir, 'quality-samples.jsonl'), rows.map(s => JSON.stringify(s)).join('\n') + '\n{truncated');
		await writeFile(path.join(dir, 'quality-protocol.jsonl'), [
			{ observedAtMs: 1000, envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 1000 } } },
			{ observedAtMs: 2500, envelope: { type: 'action_result', agentId: 'a', payload: { actionId: 'x', actionType: 'wait', state: 'SUCCEEDED', message: 'done', replayProof: 'fixture-private-receipt-proof' } } },
		].map(r => JSON.stringify(r)).join('\n'));
		await recordOperatorStop(dir, 'checkpoint recovery ends here', { at: 5000 });
		const scored = await scoreStageRun(dir);
		assert.equal(scored.ending.kind, 'stopped');
		assert.equal(scored.ending.at, 5000);
		assert.equal(scored.firstLife.status, 'observed_death');
		assert.equal(scored.afterDeath.status, 'censored');
		assert.equal(scored.firstLife.resources.rods.supplied, 6);
		assert.equal(scored.firstLife.damageTakenCounterDelta, 200);
		assert.equal(scored.afterDeath.damageTakenCounterDelta, 0);
		assert.equal(scored.firstLife.resources.rods.observedGains, 0);
		assert.equal(scored.firstLife.resources.rods.lost, 6);
		assert.equal(scored.afterDeath.resources.rods.lost, 0, 'do not count the first death twice');
		assert.equal(scored.afterDeath.resources.rods.recoveredOrEarned, 1);
		assert.equal(scored.firstLife.resources.pearlsEyes.earned, null, 'an inventory gain alone does not prove earnings');
		assert.equal(scored.firstLife.resources.gold.spent, null, 'a decrease alone does not prove barter');
		assert.equal(scored.firstLife.resources.gold.unexplainedDecrease, 2);
		assert.equal(scored.firstLife.milestones.blaze_rod.heldAtStageEnd, false);
		assert.ok(scored.firstLifeDeathTrace.gaps.length);
		assert.equal(scored.firstLifeDeathTrace.actionReceipts[0].message, 'done');
		assert.doesNotMatch(JSON.stringify(scored), /fixture-private-receipt-proof|replayProof/);
		assert.ok(scored.coverage.diagnostics.some(s => s.includes('malformed')));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('budget, failure, and missing termination provenance remain distinct', () => {
	assert.equal(classifyEnding({ startedAt: 1000, lastAt: 61000, windowMs: 60000, termination: 'TIMEOUT' }).kind, 'budget_end');
	assert.equal(classifyEnding({ termination: 'NO_OBSERVER' }).kind, 'failure');
	assert.equal(classifyEnding({ termination: 'SIGTERM' }).kind, 'unknown');
	assert.equal(classifyEnding({ operatorStop: { status: 'stop_failed', at: 1000, reason: 'worker refused stop' } }).kind, 'failure');
});

test('log advancements require the agent AND an absolute in-window event timestamp', () => {
	const start = Date.parse('2026-10-24T10:00:00Z');
	const log = '[2026-10-24T10:00:02Z] [Server/INFO]: OtherPlayer has made the advancement [Free the End]\n'
		+ '[2026-10-24T09:59:59Z] [Server/INFO]: Sol has made the advancement [Free the End]\n'
		+ '[10:00:02] [Server/INFO]: Sol has made the advancement [Free the End]\n'
		+ '[2026-10-24T10:00:03Z] [Server/INFO]: Sol has made the advancement [Free the End]';
	const scope = { agentName: 'Sol', goalStartAt: start, goalEndAt: start + 5000 };
	const events = parseLogAdvancements(log, scope);
	assert.deepEqual(events, [{ id: 'end/kill_dragon', at: start + 3000, agentName: 'Sol' }]);
	assert.deepEqual(parseLogAdvancements(log), []);
	const options = { successCheck: 'advancement: end/kill_dragon', durationBudgetMs: 5000, goalStartAt: start, agentName: 'Sol' };
	assert.equal(evaluateSamples([], { ...options, logAdvancements: events }).pass, true);
	assert.equal(evaluateSamples([], { ...options, logAdvancements: ['end/kill_dragon'] }).pass, false);
	assert.equal(evaluateSamples([], { ...options, logAdvancements: [{ ...events[0], agentName: 'OtherPlayer' }] }).pass, false);
});

test('decision latency uses seconds-long provider boundaries instead of usage bookkeeping', () => {
	const common = { agentId: 'a', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol' };
	const m = deriveRunMetrics({ profile: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' }, traceRows: [
		{ ...common, event: 'native_model_call', totalMs: 11 },
		{ ...common, event: 'native_decision_timing', outcome: 'completed', segmentDurationMs: 5000 },
	] });
	assert.equal(m.medianModelRoundMs, 5000);
	assert.equal(m.providerUsageTimingMs.median, 11);
});

test('zero-good paired PASS and missing continuations are prominent in reports', () => {
	const cases = [{ id: 'a', family: 'fight', candidate: { good: 0, n: 3 }, baseline: { good: 0, n: 3 } }];
	const comparison = compareCases(cases), verdict = screenVerdict(comparison);
	const report = buildReport({ comparison, verdict, baseline: {}, candidate: {}, caseDefinitions: [{ id: 'a' }] });
	const md = renderMarkdown(report);
	assert.match(md, /UNINFORMATIVE/);
	assert.match(md, /1\/1 cases have no continuation/);
	assert.match(md, /both arms have zero good/);
});
