import assert from 'node:assert/strict';
import test from 'node:test';

import { compareCases, confirmVerdict, minUsable, screenVerdict, unitCoverage } from '../src/decision-eval/stats.mjs';

// Reproductions from reviews/q8-decision-eval-r2.md (q8-r2-stats-reproductions.mjs), turned into the expected outcomes.

test('a family that is 90% ungraded cannot FAIL from its one surviving case', () => {
	const rows = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, family: 'f',
		candidate: i ? { good: 0, n: 0, ungraded: 10 } : { good: 0, n: 10 },
		baseline: i ? { good: 0, n: 0, ungraded: 10 } : { good: 10, n: 10 } }));
	const verdict = screenVerdict(compareCases(rows));
	assert.equal(verdict.verdict, 'INCONCLUSIVE');
	assert.deepEqual(verdict.failing, []);
	assert.equal(verdict.incomplete, true);
	assert.notEqual(verdict.verdict, 'FAIL', 'the scenario needs a screen that did not fail');
	assert.deepEqual(verdict.incompleteUnits, ['f', '(overall)']);
	assert.equal(verdict.redoCases.length, 9, 'the nine ungraded cases are listed for completion');
});

test('a complete family may still FAIL while an unrelated family is incomplete, with the planned multiplicity kept', () => {
	const failing = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, family: 'a', candidate: { good: 0, n: 3 }, baseline: { good: 3, n: 3 } }));
	const missing = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, family: 'b', candidate: { good: 0, n: 0, errors: 3 }, baseline: { good: 3, n: 3 } }));
	const comparison = compareCases([...failing, ...missing]);
	const verdict = screenVerdict(comparison);
	assert.equal(verdict.verdict, 'FAIL');
	assert.deepEqual(verdict.failing, ['a']);
	const b = comparison.families.find((f) => f.name === 'b');
	assert.equal(b.complete, false);
	assert.equal(b.pWorseHolm, 1, 'an incomplete family enters Holm at p = 1');
	const a = comparison.families.find((f) => f.name === 'a');
	assert.ok(Math.abs(a.pWorseHolm - Math.min(1, 2 * a.pWorse)) < 1e-12, 'Holm still counts both planned families');
});

test('every planned case needs paired usable evidence: a case missing in one arm blocks its family', () => {
	assert.equal(minUsable(3), 2);
	assert.equal(minUsable(1), 1);
	const rows = [
		...Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, family: 'f', candidate: { good: 3, n: 3 }, baseline: { good: 3, n: 3 } })),
		{ id: 'hole', family: 'f', candidate: { good: 0, n: 0, errors: 3 }, baseline: { good: 3, n: 3 } },
	];
	const coverage = unitCoverage(compareCases(rows).cases, { maxIncomplete: 0.2 });
	assert.deepEqual(coverage.shortCases, ['hole']);
	assert.equal(coverage.complete, false, 'per-arm share is 90% but one case has no candidate evidence');
	assert.equal(screenVerdict(compareCases(rows)).verdict, 'INCONCLUSIVE');
});

test('confirmation keeps every planned hypothesis: a missing unit is p = 1 and the survivor is not easier to confirm', () => {
	const flagged = { rerunFamilies: ['f1', 'f2'], rerunCases: ['a', 'b'], caseFamilies: { a: 'f1', b: 'f2' } };
	const partial = compareCases([
		{ id: 'a', family: 'f1', candidate: { good: 2, n: 6 }, baseline: { good: 6, n: 6 } },
		{ id: 'b', family: 'f2', candidate: { good: 0, n: 0, errors: 6 }, baseline: { good: 0, n: 0, errors: 6 } },
	]);
	const verdict = confirmVerdict(partial, flagged, { samples: 6 });
	assert.equal(verdict.verdict, 'INCONCLUSIVE', 'Sol: FAIL at Holm 0.0303 before; with both planned hypotheses Holm is 0.0606');
	const f1 = verdict.units.find((u) => u.name === 'f1');
	assert.ok(Math.abs(f1.pHolm - 0.0606060606) < 1e-6);
	assert.equal(verdict.units.find((u) => u.name === 'f2').complete, false);
});

test('confirmation coverage is per arm and per case: one wholly missing candidate case is INCONCLUSIVE, not PASS', () => {
	const ids = Array.from({ length: 5 }, (_, i) => `h${i}`);
	const armHole = compareCases(ids.map((id, i) => ({ id, family: 'hole',
		candidate: i ? { good: 10, n: 10 } : { good: 0, n: 0, errors: 10 }, baseline: { good: 10, n: 10 } })));
	const verdict = confirmVerdict(armHole, { rerunFamilies: ['hole'], rerunCases: ids, caseFamilies: Object.fromEntries(ids.map((id) => [id, 'hole'])) }, { samples: 10 });
	assert.equal(verdict.verdict, 'INCONCLUSIVE', 'pooled 90% used to PASS with candidate at 80% and h0 unanswered');
	assert.deepEqual(verdict.units[0].coverage.shortCases, ['h0']);
	assert.equal(verdict.units[0].coverage.candidate.share, 0.8);
});

test('a source moment weighs one however many derived variants it has (the live drowning confirmation)', () => {
	// Fresh confirmation: 02 and 05 share trace A2 line 14442; 01 improves 3/3 vs 2/3; 03, 04 and 06 are 3/3 in both arms.
	const rows = [
		{ id: 'drowning-01', source: 'B:13899', sourceWeight: 1, candidate: { good: 3, n: 3 }, baseline: { good: 2, n: 3 } },
		{ id: 'drowning-02', source: 'A2:14442', sourceWeight: 0.5, candidate: { good: 0, n: 3 }, baseline: { good: 3, n: 3 } },
		{ id: 'drowning-03', source: 'T15:322', sourceWeight: 1, candidate: { good: 3, n: 3 }, baseline: { good: 3, n: 3 } },
		{ id: 'drowning-04', source: 'A:4629', sourceWeight: 1, candidate: { good: 3, n: 3 }, baseline: { good: 3, n: 3 } },
		{ id: 'drowning-05', source: 'A2:14442', sourceWeight: 0.5, candidate: { good: 0, n: 3 }, baseline: { good: 3, n: 3 } },
		{ id: 'drowning-06', source: 'A2:14522', sourceWeight: 1, candidate: { good: 3, n: 3 }, baseline: { good: 3, n: 3 } },
	].map((row) => ({ ...row, family: 'drowning' }));
	const weighted = compareCases(rows).families[0];
	assert.ok(Math.abs(weighted.pWorse - 0.14875) < 1e-9, `source-weighted exact p ${weighted.pWorse}`);
	assert.ok(Math.abs(weighted.meanDelta - (-1 + 1 / 3) / 5) < 1e-12, 'source-weighted delta -13.3 pts');
	assert.equal(weighted.cases, 6);
	assert.equal(weighted.sources, 5);
	// Row weighting (every variant weighs one) reproduces the reported p = 0.025 and -27.8 pts.
	const rowWeighted = compareCases(rows.map((row) => ({ ...row, sourceWeight: 1, source: row.id }))).families[0];
	assert.ok(Math.abs(rowWeighted.pWorse - 0.025) < 1e-9);
	assert.ok(Math.abs(rowWeighted.meanDelta - (-5 / 18)) < 1e-12);
	// The local finding stays visible per case.
	const cases = compareCases(rows).cases.filter((row) => row.status === 'regression-suspect').map((row) => row.id);
	assert.deepEqual(cases, ['drowning-02', 'drowning-05']);
});

test('a confirmation PASS cannot override a screen whose other units were incomplete', async () => {
	const { buildReport } = await import('../src/decision-eval/report.mjs');
	const rows = [
		...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, family: 'a', candidate: { good: i < 2 ? 1 : 3, n: 3 }, baseline: { good: 3, n: 3 } })),
		...Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, family: 'b', candidate: { good: 0, n: 0, ungraded: 3 }, baseline: { good: 3, n: 3 } })),
	];
	const comparison = compareCases(rows);
	const verdict = screenVerdict(comparison);
	assert.equal(verdict.incomplete, true);
	const report = buildReport({ comparison, verdict, confirm: { verdict: 'PASS', reasons: [], confirmed: [], units: [] }, candidate: null });
	assert.equal(report.verdict, 'INCONCLUSIVE');
	assert.equal(buildReport({ comparison, verdict, confirm: { verdict: 'FAIL', reasons: [], confirmed: ['a'], units: [] }, candidate: null }).verdict, 'FAIL');
});
