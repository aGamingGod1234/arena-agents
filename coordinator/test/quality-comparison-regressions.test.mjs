import assert from 'node:assert/strict';
import test from 'node:test';
import { compareQualityReports } from '../src/benchmark/quality-metrics.mjs';
const profile = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };
const report = runs => ({ harnessCommit: 'h', instrumentationSha256: 'i', coordinatorSha256: 'c', jar: { sha256: 'j' }, scenarioDataSha256: 's', runs });
const run = (cost, completed = false, status = 'MEASURED') => ({ scenario: 'S1', profile, definition: { durationBudgetMs: 60000 }, measurementStatus: status, runnerStatus: 'PASSED', metrics: { costEstimateUsd: cost, wallTimeMs: 60000, playWallTimeMs: 60000, goalCompleted: completed, lowHealthEpisodeCount: 0 } });
test('completion compares true protocol success and costs of completed goals', () => {
	const c = compareQualityReports(report([run(1), run(3, true)]), report([run(.1)]))[0];
	assert.equal(c.completion.before.rate, .5); assert.equal(c.completion.after.rate, 0);
	assert.equal(c.completedGoals.costUsd.beforeMean, 3); assert.equal(c.completedGoals.costUsd.afterMean, null);
});
test('comparison rejects scenario, instrumentation and budget mismatches and records arm changes', () => {
	const b = report([run(1)]), a = report([run(2)]);
	for (const key of ['scenarioDataSha256', 'instrumentationSha256']) assert.throws(() => compareQualityReports(b, { ...a, [key]: 'changed' }), /mismatch/);
	assert.throws(() => compareQualityReports(b, report([{ ...run(2), definition: { durationBudgetMs: 1 } }])), /durationBudgetMs/);
	const c = compareQualityReports(b, { ...a, coordinatorSha256: 'changed', jar: { sha256: 'changed' } })[0];
	assert.equal(c.conditions.status, 'MATCHED'); assert.deepEqual(c.conditions.armDifferences, ['coordinatorSha256', 'jarSha256']);
	assert.equal(compareQualityReports({ runs: [run(1)] }, { runs: [run(2)] })[0].conditions.status, 'UNVERIFIABLE');
});
test('comparison n and spread exclude unmeasured and null values, count zero health episodes', () => {
	const c = compareQualityReports(report([run(1), run(3), run(null), run(99, false, 'INCOMPLETE')]), report([run(2)]))[0];
	assert.deepEqual(c.metrics.costEstimateUsd.before, { n: 2, mean: 2, median: 2, min: 1, max: 3, range: 2 });
	assert.equal(c.beforeMeasured, 3); assert.equal(c.zeroLowHealthEpisodes.beforeMean, 1);
});
test('comparison validates per-run setup even when the report scenario hashes match', () => {
	const b = report([{ ...run(1), definition: { durationBudgetMs: 60000, repetition: 1, setup: { dimension: 'nether' } } }]);
	const same = report([{ ...run(2), definition: { setup: { dimension: 'nether' }, repetition: 2, durationBudgetMs: 60000 } }]);
	assert.equal(compareQualityReports(b, same)[0].conditions.status, 'MATCHED');
	const different = report([{ ...run(2), definition: { durationBudgetMs: 60000, setup: { dimension: 'end' } } }]);
	assert.throws(() => compareQualityReports(b, different), /per-run scenario definition/);
});

test('a live instrumentation hash cannot hide unequal re-extraction code', () => {
	const b = { ...report([run(1)]), reextraction: { extractorSha256: 'first' } };
	const a = { ...report([run(2)]), reextraction: { extractorSha256: 'second' } };
	assert.throws(() => compareQualityReports(b, a), /extractorSha256 mismatch/);
	assert.equal(compareQualityReports(b, report([run(2)]))[0].conditions.status, 'UNVERIFIABLE');
	assert.equal(compareQualityReports(b, { ...a, reextraction: b.reextraction })[0].conditions.status, 'MATCHED');
});
