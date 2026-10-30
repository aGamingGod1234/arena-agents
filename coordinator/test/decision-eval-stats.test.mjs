import assert from 'node:assert/strict';
import test from 'node:test';

import { absoluteVerdict, compareCases, confirmVerdict, fisherOneSided, holmAdjust, hypergeometricPmf, screenVerdict, simulateVerdicts,
	stratifiedExactTest, wilsonInterval } from '../src/decision-eval/stats.mjs';

const close = (actual, expected, tolerance = 1e-3) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('Wilson interval matches reference values and stays inside 0..1', () => {
	const a = wilsonInterval(2, 3);
	close(a.low, 0.2077); close(a.high, 0.9385);
	const b = wilsonInterval(0, 3);
	assert.equal(b.low, 0); close(b.high, 0.5615);
	const c = wilsonInterval(3, 3);
	close(c.low, 0.4385); assert.equal(c.high, 1);
	assert.equal(wilsonInterval(0, 0).rate, null);
});

test('exact tests: hypergeometric pmf, Fisher one-sided and the stratified convolution', () => {
	const pmf = hypergeometricPmf(3, 3, 3);
	close(pmf.reduce((a, b) => a + b, 0), 1, 1e-12);
	close(pmf[0], 0.05);
	// 0/3 vs 3/3 is the most extreme 3-vs-3 table: one-sided p = 1/20.
	close(fisherOneSided({ k1: 0, n1: 3, k0: 3, n0: 3 }).pLower, 0.05);
	close(fisherOneSided({ k1: 2, n1: 3, k0: 3, n0: 3 }).pLower, 0.5);
	// Strata with no split of goods carry no information.
	const tied = stratifiedExactTest([{ k1: 3, n1: 3, k0: 3, n0: 3 }, { k1: 0, n1: 3, k0: 0, n0: 3 }]);
	close(tied.pLower, 1); close(tied.pUpper, 1);
	const two = stratifiedExactTest([{ k1: 0, n1: 3, k0: 3, n0: 3 }, { k1: 0, n1: 3, k0: 3, n0: 3 }]);
	close(two.pLower, 0.0025);
	assert.deepEqual(holmAdjust([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
});

function family(name, count, cand, base, n = 3) {
	return Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}`, family: name, threshold: 0.67, candidate: { good: cand(i), n }, baseline: { good: base(i), n } }));
}

test('a flaky single answer never fails or flags: one case 3/3 -> 0/3 inside an unchanged set', () => {
	const cases = [];
	for (let f = 0; f < 15; f++) cases.push(...family(`f${f}`, 10, () => 3, () => 3));
	cases[0].candidate.good = 0;
	const comparison = compareCases(cases);
	const verdict = screenVerdict(comparison);
	assert.equal(verdict.verdict, 'PASS');
	assert.equal(comparison.cases[0].status, 'regression-suspect');
	assert.deepEqual(verdict.rerunCases, ['f0-0']);
});

test('a real family-wide drop fails; a borderline one is inconclusive and confirm decides on fresh samples', () => {
	const cases = [];
	for (let f = 0; f < 15; f++) cases.push(...family(`f${f}`, 10, () => 3, () => 3));
	const dropped = cases.map(c => (c.family === 'f3' ? { ...c, candidate: { good: 1, n: 3 } } : c));
	const fail = screenVerdict(compareCases(dropped));
	assert.equal(fail.verdict, 'FAIL');
	assert.ok(fail.failing.includes('f3'));
	// Three of ten cases lose two answers each: suggestive, not decisive.
	const partial = cases.map(c => (['f3-0', 'f3-1', 'f3-2'].includes(c.id) ? { ...c, candidate: { good: 1, n: 3 } } : c));
	const screen = screenVerdict(compareCases(partial));
	assert.equal(screen.verdict, 'INCONCLUSIVE');
	assert.deepEqual(screen.rerunFamilies, ['f3']);
	const fresh = (candGood) => compareCases(family('f3', 10, i => (i < 3 ? candGood : 5), () => 5, 5));
	assert.equal(confirmVerdict(fresh(1), screen).verdict, 'FAIL');
	assert.equal(confirmVerdict(fresh(5), screen).verdict, 'PASS');
});

test('improvements, error budget, missing baseline and absolute thresholds', () => {
	const cases = [];
	for (let f = 0; f < 4; f++) cases.push(...family(`f${f}`, 10, () => 3, () => (f === 0 ? 0 : 3)));
	const better = screenVerdict(compareCases(cases));
	assert.equal(better.verdict, 'PASS');
	assert.ok(better.improved.includes('f0'));
	assert.equal(screenVerdict(compareCases(family('a', 5, () => 3, () => 3)), { errorFraction: 0.2 }).verdict, 'INCONCLUSIVE');
	assert.equal(screenVerdict(compareCases([{ id: 'x', family: 'a', threshold: 0.67, candidate: { good: 3, n: 3 }, baseline: null }])).verdict, 'INCONCLUSIVE');
	const absolute = absoluteVerdict(compareCases([
		{ id: 'ok', family: 'a', threshold: 0.67, candidate: { good: 2, n: 3 } },
		{ id: 'low', family: 'a', threshold: 0.67, candidate: { good: 0, n: 3 } },
	]));
	assert.equal(absolute.verdict, 'FAIL');
	assert.deepEqual(absolute.belowThreshold, ['low']);
});

// Simulated error rates of the full CI decision (screen, then confirm with 3 fresh samples when INCONCLUSIVE) on a
// 150-case set (15 families x 10 cases, 3 samples per build). Bounds leave room for Monte Carlo noise at 400 trials.
test('simulation: false FAIL stays rare under no change; real family drops are detected', () => {
	const none = simulateVerdicts({ trials: 400, seed: 3 });
	assert.ok(none.FAIL <= 0.02, `false FAIL ${none.FAIL}`);
	assert.ok(none.screen.INCONCLUSIVE <= 0.15, `null INCONCLUSIVE ${none.screen.INCONCLUSIVE}`);
	const flaky = simulateVerdicts({ trials: 400, seed: 4, errorRate: 0.05 });
	assert.ok(flaky.FAIL <= 0.03, `false FAIL with 5% errors ${flaky.FAIL}`);
	const familyDrop = simulateVerdicts({ trials: 300, seed: 5, candidateRate: (p, f) => (f === 0 ? p - 0.5 : p) });
	assert.ok(familyDrop.FAIL >= 0.9, `detection of a 50-point family drop ${familyDrop.FAIL}`);
	const uniformDrop = simulateVerdicts({ trials: 300, seed: 6, candidateRate: p => p - 0.1 });
	assert.ok(uniformDrop.FAIL >= 0.85, `detection of a 10-point drop everywhere ${uniformDrop.FAIL}`);
});
