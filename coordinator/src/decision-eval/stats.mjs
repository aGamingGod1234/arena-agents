// Statistics for decision-eval: good-rates with Wilson intervals, exact paired candidate-vs-baseline tests, and the CI verdict.
//
// Decision rule (see VERDICT_RULE and arena-quality-research/notes/decision-eval/grade/REPORT.md for simulated error rates):
// Unit of judgement is the cause-class family, never one moment. Each case contributes its candidate and baseline good counts.
// Under "no change", within each case the good answers are exchangeable between builds, so given the case's total good count the
// candidate count is hypergeometric. The family statistic is the sum of candidate good counts; its exact null distribution is the
// convolution of the per-case hypergeometrics (a conditional, exact Cochran-Mantel-Haenszel test with no normal approximation).
//   FAIL          some family or the overall set drops with Holm-adjusted one-sided p < failAlpha AND mean per-case drop >= minEffect.
//   INCONCLUSIVE  no FAIL, but some family drops with unadjusted p < screenAlpha and mean drop >= minEffect, or too many errored
//                 samples. The report lists those families and their cases to re-ask with fresh samples (confirm stage).
//   PASS          otherwise.
// Confirm stage: re-asking flagged units with FRESH samples and testing only those samples (Holm over the flagged units) keeps the
// error rate valid despite the data-dependent selection. Single cases are reported (Fisher exact, Wilson) but do not set the
// screen verdict: with 3 samples a 3/3 to 0/3 swing happens by chance in about one of 150 borderline cases.

export const VERDICT_RULE = Object.freeze({
	failAlpha: 0.005,
	familyScreenAlpha: 0.20,
	overallScreenAlpha: 0.05,
	minEffect: 0.10,
	// The overall unit needs the ESTIMATED drop to reach this floor, so a true drop of exactly the floor fails only about
	// half the time. 0.03 lets a real 5-point drop clear it: with 6 samples per case the DeepSeek train suite detects it 92%
	// of the time at 1% false FAILs (simulation on the d21 per-case rates); at 0.05 detection stayed near 50% at any n.
	overallMinEffect: 0.03,
	confirmAlpha: 0.05,
	maxErrorFraction: 0.10,
	// A family whose samples are this incomplete (errored or ungraded) cannot be judged at all.
	maxFamilyIncompleteFraction: 0.20,
	// Confirmation needs at least this share of its required samples answered and graded, in every flagged unit.
	minConfirmCoverage: 0.90,
	z: 1.959963984540054,
});

/**
 * Completeness of a comparison: planned samples that produced no decision (errored) or no grade (ungraded), overall and
 * per family, both arms together. Incomplete samples are never counted as answers, so a large share means the rates
 * describe a different set of moments than the one intended. Used for reporting; deciding is gated by unitCoverage.
 */
export function sampleCoverage(caseRows) {
	const families = new Map();
	const total = { planned: 0, errors: 0, ungraded: 0 };
	const incompleteCases = [];
	for (const row of caseRows) {
		const arms = [row.candidate, row.baseline].filter(Boolean);
		const errors = arms.reduce((sum, arm) => sum + (arm.errors ?? 0), 0);
		const ungraded = arms.reduce((sum, arm) => sum + (arm.ungraded ?? 0), 0);
		const planned = arms.reduce((sum, arm) => sum + arm.n + (arm.errors ?? 0) + (arm.ungraded ?? 0), 0);
		const family = families.get(row.family) ?? { name: row.family, planned: 0, errors: 0, ungraded: 0 };
		for (const target of [family, total]) { target.planned += planned; target.errors += errors; target.ungraded += ungraded; }
		families.set(row.family, family);
		const empty = !row.candidate || !row.baseline || row.candidate.n === 0 || row.baseline.n === 0;
		if (errors + ungraded > 0 || empty) incompleteCases.push({ id: row.id, family: row.family, errors, ungraded });
	}
	const fraction = (unit) => unit.planned ? (unit.errors + unit.ungraded) / unit.planned : 0;
	return {
		...total, incompleteFraction: fraction(total), incompleteCases,
		families: [...families.values()].map((family) => ({ ...family, incompleteFraction: fraction(family) })),
	};
}

/**
 * The stated minimum of paired usable evidence: a case counts toward a unit's decision only when EACH arm has at least
 * half of the samples planned for that arm answered and graded, and at least one.
 */
export function minUsable(planned) { return Math.max(1, Math.ceil(planned / 2)); }

const plannedOf = (arm) => arm ? arm.n + (arm.errors ?? 0) + (arm.ungraded ?? 0) : 0;
const ARMS = ['candidate', 'baseline'];

/**
 * Whether a unit (family, overall, or a confirmation unit) has enough evidence to decide anything. Arms are measured
 * apart: each arm's usable share must reach 1 - maxIncomplete, and every planned case must meet minUsable in both arms.
 * `required` (confirmation) maps case id to { candidate, baseline } planned counts; otherwise the recorded count of the
 * arm is the plan, and a planned case with no samples in one arm is planned like the other arm (at least one).
 */
export function unitCoverage(rows, { maxIncomplete, required = null } = {}) {
	const arms = { candidate: { planned: 0, usable: 0 }, baseline: { planned: 0, usable: 0 } };
	const shortCases = [];
	for (const row of rows) {
		let short = false;
		for (const arm of ARMS) {
			const other = arm === 'candidate' ? 'baseline' : 'candidate';
			const planned = required?.get(row.id)?.[arm] ?? Math.max(plannedOf(row[arm]), plannedOf(row[other]), 1);
			const usable = Math.min(planned, row[arm]?.n ?? 0);
			arms[arm].planned += planned;
			arms[arm].usable += usable;
			if (usable < minUsable(planned)) short = true;
		}
		if (short) shortCases.push(row.id);
	}
	for (const arm of ARMS) arms[arm].share = arms[arm].planned ? arms[arm].usable / arms[arm].planned : 0;
	const complete = rows.length > 0 && shortCases.length === 0 && ARMS.every((arm) => 1 - arms[arm].share <= maxIncomplete + 1e-12);
	return { complete, arms, shortCases };
}

export function wilsonInterval(successes, n, z = VERDICT_RULE.z) {
	if (!Number.isFinite(n) || n <= 0) return { rate: null, low: 0, high: 1, n: 0 };
	const p = successes / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const half = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
	return { rate: p, low: Math.max(0, center - half), high: Math.min(1, center + half), n };
}

const logFactorials = [0];
function logFactorial(n) {
	for (let i = logFactorials.length; i <= n; i++) logFactorials[i] = logFactorials[i - 1] + Math.log(i);
	return logFactorials[n];
}
function logChoose(n, k) { return k < 0 || k > n ? -Infinity : logFactorial(n) - logFactorial(k) - logFactorial(n - k); }

// P(X = k) for X candidate goods when `total` goods are split between n1 candidate and n0 baseline samples.
export function hypergeometricPmf(n1, n0, total) {
	const lo = Math.max(0, total - n0), hi = Math.min(n1, total);
	const pmf = new Array(n1 + 1).fill(0);
	const denom = logChoose(n1 + n0, total);
	for (let k = lo; k <= hi; k++) pmf[k] = Math.exp(logChoose(n1, k) + logChoose(n0, total - k) - denom);
	return pmf;
}

function convolve(a, b) {
	const out = new Array(a.length + b.length - 1).fill(0);
	for (let i = 0; i < a.length; i++) if (a[i]) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
	return out;
}

// A pmf over k, stretched so value k sits at index k * weight.
function stretch(pmf, weight) {
	if (weight === 1) return pmf;
	const out = new Array((pmf.length - 1) * weight + 1).fill(0);
	pmf.forEach((p, k) => { out[k * weight] = p; });
	return out;
}

/**
 * strata: [{ k1, n1, k0, n0, weight }] with integer weights (default 1). The statistic is sum(weight * k1); its exact
 * null distribution is the convolution of each stratum's hypergeometric, scaled by its weight. Returns exact one-sided
 * p-values for "candidate worse" (lower) and "candidate better" (upper).
 */
export function stratifiedExactTest(strata) {
	const usable = strata.filter(s => s.n1 > 0 && s.n0 > 0);
	let dist = [1];
	let observed = 0, expected = 0;
	for (const s of usable) {
		const weight = s.weight ?? 1;
		const total = s.k1 + s.k0;
		dist = convolve(dist, stretch(hypergeometricPmf(s.n1, s.n0, total), weight));
		observed += weight * s.k1;
		expected += weight * s.n1 * total / (s.n1 + s.n0);
	}
	if (!usable.length) return { pLower: 1, pUpper: 1, observed: 0, expected: 0, strata: 0 };
	// A small tolerance keeps ties of equal probability on the inclusive side despite floating point error.
	const pLower = Math.min(1, dist.slice(0, observed + 1).reduce((a, b) => a + b, 0) + 1e-12);
	const pUpper = Math.min(1, dist.slice(observed).reduce((a, b) => a + b, 0) + 1e-12);
	return { pLower, pUpper, observed, expected, strata: usable.length };
}

export function fisherOneSided({ k1, n1, k0, n0 }) {
	return stratifiedExactTest([{ k1, n1, k0, n0 }]);
}

// Holm step-down adjusted p-values, same order as the input.
export function holmAdjust(pValues) {
	const order = pValues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
	const adjusted = new Array(pValues.length);
	let running = 0;
	order.forEach(([p, i], rank) => {
		running = Math.max(running, Math.min(1, (pValues.length - rank) * p));
		adjusted[i] = running;
	});
	return adjusted;
}

function rate(k, n) { return n > 0 ? k / n : null; }
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => a / gcd(a, b) * b;

// cases: [{ id, family, threshold, source, sourceWeight, candidate: {good, n, errors, ungraded}, baseline: {...} | null }]
// sourceWeight is 1 / (variants of the same recorded source moment in the case set); a source group weighs one in total.
export function compareCases(cases, rule = VERDICT_RULE) {
	const caseRows = cases.map(c => {
		const cand = c.candidate ?? { good: 0, n: 0, errors: 0 };
		const base = c.baseline ?? null;
		const ci = wilsonInterval(cand.good, cand.n, rule.z);
		const row = {
			id: c.id, family: c.family, causeClass: c.causeClass ?? null, threshold: c.threshold ?? null,
			source: c.source ?? c.id, sourceWeight: c.sourceWeight ?? 1,
			candidate: { good: cand.good, n: cand.n, errors: cand.errors ?? 0, ungraded: cand.ungraded ?? 0, rate: ci.rate, low: ci.low, high: ci.high },
			baseline: null, delta: null, pWorse: null, pBetter: null,
		};
		if (base) {
			const bci = wilsonInterval(base.good, base.n, rule.z);
			row.baseline = { good: base.good, n: base.n, errors: base.errors ?? 0, ungraded: base.ungraded ?? 0, rate: bci.rate, low: bci.low, high: bci.high };
			if (cand.n > 0 && base.n > 0) {
				const test = fisherOneSided({ k1: cand.good, n1: cand.n, k0: base.good, n0: base.n });
				row.delta = rate(cand.good, cand.n) - rate(base.good, base.n);
				row.pWorse = test.pLower;
				row.pBetter = test.pUpper;
			}
		}
		row.status = caseStatus(row);
		return row;
	});
	const families = [...new Set(caseRows.map(r => r.family))].map(family => unitSummary(family, caseRows.filter(r => r.family === family)));
	const overall = unitSummary('(overall)', caseRows);
	return { cases: caseRows, families, overall };
}

function caseStatus(row) {
	const { candidate: c, baseline: b, threshold } = row;
	if (c.n === 0) return 'no-data';
	const meets = threshold === null || c.rate >= threshold;
	const confidentlyBelow = threshold !== null && c.high < threshold;
	const baseMeets = b && b.n > 0 && (threshold === null || b.rate >= threshold);
	if (b && b.n > 0 && row.pWorse < 0.10 && row.delta <= -1 / 3) return baseMeets ? 'regression-suspect' : 'worse-known-weak';
	if (b && b.n > 0 && row.pBetter < 0.10 && row.delta >= 1 / 3) return 'improvement-suspect';
	if (confidentlyBelow) return baseMeets ? 'below-threshold-new' : 'below-threshold-known';
	return meets ? 'pass' : 'below-threshold-noisy';
}

// Each source moment weighs one in total, split across its variants; the exact test uses integer weights L / variants.
function unitSummary(name, rows) {
	const paired = rows.filter(r => r.baseline && r.candidate.n > 0 && r.baseline.n > 0);
	const variants = (r) => Math.max(1, Math.round(1 / (r.sourceWeight ?? 1)));
	const scale = paired.reduce((acc, r) => lcm(acc, variants(r)), 1);
	const test = stratifiedExactTest(paired.map(r => ({ k1: r.candidate.good, n1: r.candidate.n, k0: r.baseline.good, n0: r.baseline.n, weight: scale / variants(r) })));
	const weighted = (list, value) => {
		const total = list.reduce((a, r) => a + (r.sourceWeight ?? 1), 0);
		return total ? list.reduce((a, r) => a + (r.sourceWeight ?? 1) * value(r), 0) / total : null;
	};
	const answered = rows.filter(r => r.candidate.n > 0);
	const good = rows.reduce((a, r) => a + r.candidate.good, 0), n = rows.reduce((a, r) => a + r.candidate.n, 0);
	return {
		name, cases: rows.length, sources: new Set(rows.map(r => r.source)).size, pairedCases: paired.length,
		candidate: { good, n, meanCaseRate: weighted(answered, r => r.candidate.rate), pooled: wilsonInterval(good, n) },
		baseline: paired.length ? { good: paired.reduce((a, r) => a + r.baseline.good, 0), n: paired.reduce((a, r) => a + r.baseline.n, 0), meanCaseRate: weighted(paired, r => r.baseline.rate) } : null,
		// Source-weighted mean of per-case differences: every recorded source moment weighs the same, however many
		// derived variants it has.
		meanDelta: paired.length ? weighted(paired, r => r.delta) : null,
		pWorse: paired.length ? test.pLower : null, pBetter: paired.length ? test.pUpper : null,
		belowThreshold: rows.filter(r => r.status.startsWith('below-threshold')).length,
	};
}

// Screen verdict from one candidate run and one baseline run.
// Every planned family is one hypothesis in a single Holm family; the pre-specified overall unit is tested once on its
// own. Coverage is a prerequisite: a unit whose evidence is incomplete (unitCoverage) enters Holm with p = 1 and can
// neither fail nor flag. A complete unit may still FAIL while another is incomplete; PASS needs every unit complete.
// INCONCLUSIVE has two remedies: `rerun*` lists drops to confirm with fresh samples, `redo*` lists cases whose evidence
// must be completed before the units that contain them can decide.
export function screenVerdict(comparison, { errorFraction = 0, rule = VERDICT_RULE } = {}) {
	const coverage = sampleCoverage(comparison.cases);
	const rowsOf = (name) => comparison.cases.filter((row) => row.family === name);
	for (const unit of comparison.families) {
		unit.coverage = unitCoverage(rowsOf(unit.name), { maxIncomplete: rule.maxFamilyIncompleteFraction });
		unit.complete = unit.coverage.complete && unit.pWorse !== null;
	}
	const overall = comparison.overall;
	overall.coverage = unitCoverage(comparison.cases, { maxIncomplete: rule.maxErrorFraction });
	overall.complete = overall.coverage.complete && overall.pWorse !== null && errorFraction <= rule.maxErrorFraction;
	const families = comparison.families;
	const adjustedWorse = holmAdjust(families.map((u) => (u.complete ? u.pWorse : 1)));
	const adjustedBetter = holmAdjust(families.map((u) => (u.complete ? u.pBetter : 1)));
	families.forEach((u, i) => { u.pWorseHolm = adjustedWorse[i]; u.pBetterHolm = adjustedBetter[i]; });
	overall.pWorseHolm = overall.complete ? overall.pWorse : 1;
	overall.pBetterHolm = overall.complete ? overall.pBetter : 1;
	const units = [...families, overall];
	const effect = u => u === overall ? rule.overallMinEffect : rule.minEffect;
	const screen = u => u === overall ? rule.overallScreenAlpha : rule.familyScreenAlpha;
	const decisive = units.filter((u) => u.complete);
	const failing = decisive.filter(u => u.pWorseHolm < rule.failAlpha && u.meanDelta <= -effect(u));
	const flagged = decisive.filter(u => !failing.includes(u) && u.pWorseHolm < screen(u) && u.meanDelta <= -effect(u));
	const improved = decisive.filter(u => u.pBetterHolm < screen(u) && u.meanDelta >= effect(u));
	const incompleteUnits = units.filter((u) => !u.complete);
	const reasons = [];
	let verdict = 'PASS';
	for (const u of failing) reasons.push(`${u.name}: mean good-rate ${fmt(u.meanDelta)} vs baseline, Holm p=${u.pWorseHolm.toExponential(2)}`);
	for (const u of flagged) reasons.push(`${u.name}: drop ${fmt(u.meanDelta)} (p=${u.pWorse.toFixed(3)}, Holm ${u.pWorseHolm.toFixed(3)}); re-ask with fresh samples`);
	for (const u of incompleteUnits) {
		const c = u.coverage;
		reasons.push(`${u.name}: incomplete evidence, not decided (usable candidate ${c.arms.candidate.usable}/${c.arms.candidate.planned}, baseline ${c.arms.baseline.usable}/${c.arms.baseline.planned}; ${c.shortCases.length} cases below ${'the minimum of half their planned samples per arm'})`);
	}
	if (failing.length) verdict = 'FAIL';
	else if (flagged.length || incompleteUnits.length) verdict = 'INCONCLUSIVE';
	const rerun = [...failing, ...flagged].filter(u => u !== overall).map(u => u.name);
	// An overall-only drop has no family to point at; the confirm stage then re-asks the whole set.
	const rerunAll = [...failing, ...flagged].includes(overall) && rerun.length === 0;
	const rerunCases = comparison.cases.filter(r => rerunAll || rerun.includes(r.family) || r.status === 'regression-suspect').map(r => r.id);
	// Cases to answer or grade again: short of the minimum, errored or ungraded, in any unit that could not decide.
	const blocked = new Set(incompleteUnits.flatMap((u) => u === overall ? comparison.cases.map((r) => r.id) : rowsOf(u.name).map((r) => r.id)));
	const redoCases = incompleteUnits.length === 0 ? [] : coverage.incompleteCases.map((row) => row.id).filter((id) => blocked.has(id));
	return { verdict, reasons, failing: failing.map(u => u.name), flagged: flagged.map(u => u.name), improved: improved.map(u => u.name),
		rerunFamilies: rerun, rerunAll, rerunCases, incomplete: incompleteUnits.length > 0, incompleteUnits: incompleteUnits.map((u) => u.name), redoCases,
		coverage: { incompleteFraction: Math.max(errorFraction, coverage.incompleteFraction), errors: coverage.errors, ungraded: coverage.ungraded, planned: coverage.planned,
			incompleteFamilies: families.filter((u) => !u.complete).map((u) => u.name) } };
}

// Confirm verdict: tests only FRESH samples for the units the screen flagged. `required` maps case id to the samples each
// arm had to answer ({ candidate, baseline }); default `samples` per arm. A unit decides only with complete evidence:
// each arm answered and graded at least minConfirmCoverage of the unit's required samples, and every required case has
// minUsable samples in both arms. Holm runs over EVERY planned unit, incomplete ones at p = 1, so a lost unit never makes
// another easier to confirm. Missing evidence never turns into PASS.
export function confirmVerdict(confirmComparison, screen, { rule = VERDICT_RULE, required = null, samples = 3 } = {}) {
	const flaggedFamilies = screen.rerunFamilies ?? [];
	const rerunCases = screen.rerunCases ?? [];
	const rows = new Map(confirmComparison.cases.map((row) => [row.id, row]));
	const familyOf = (id) => rows.get(id)?.family ?? screen.caseFamilies?.[id];
	const requiredMap = new Map(rerunCases.map((id) => [id, required?.get(id) ?? { candidate: samples, baseline: samples }]));
	const rowFor = (id) => rows.get(id) ?? { id, family: familyOf(id), candidate: { good: 0, n: 0 }, baseline: { good: 0, n: 0 } };
	const unitCases = (unit) => unit.kind === 'overall' ? rerunCases : unit.kind === 'family' ? rerunCases.filter((id) => familyOf(id) === unit.family) : [unit.caseId];
	const plan = [
		...flaggedFamilies.map((family) => ({ kind: 'family', name: family, family, minEffect: rule.minEffect, stats: confirmComparison.families.find((f) => f.name === family) })),
		...(screen.rerunAll ? [] : rerunCases.filter((id) => !flaggedFamilies.includes(familyOf(id))).map((id) => ({ kind: 'case', name: `case ${id}`, caseId: id, minEffect: rule.minEffect, stats: rows.get(id) }))),
		...(screen.rerunAll ? [{ kind: 'overall', name: '(overall)', minEffect: rule.overallMinEffect, stats: confirmComparison.overall }] : []),
	];
	const units = plan.map((unit) => {
		const coverage = unitCoverage(unitCases(unit).map(rowFor), { maxIncomplete: 1 - rule.minConfirmCoverage, required: requiredMap });
		const p = unit.stats?.pWorse ?? null;
		const delta = unit.kind === 'case' ? unit.stats?.delta ?? null : unit.stats?.meanDelta ?? null;
		return { ...unit, coverage, p, delta, complete: coverage.complete && p !== null };
	});
	const adjusted = holmAdjust(units.map((unit) => (unit.complete ? unit.p : 1)));
	const confirmed = units.filter((unit, i) => unit.complete && adjusted[i] < rule.confirmAlpha && unit.delta <= -unit.minEffect);
	const missing = units.filter((unit) => !unit.complete);
	let verdict, reasons;
	if (confirmed.length) {
		verdict = 'FAIL';
		reasons = confirmed.map((unit) => `${unit.name} confirmed on fresh samples (drop ${fmt(unit.delta)})`);
		for (const unit of missing) reasons.push(`${unit.name}: incomplete confirmation evidence, counted at p = 1`);
	} else if (!units.length) {
		verdict = 'INCONCLUSIVE';
		reasons = ['the screen flagged nothing to confirm'];
	} else if (missing.length) {
		verdict = 'INCONCLUSIVE';
		reasons = missing.map((unit) => `${unit.name}: confirmation evidence incomplete (candidate ${unit.coverage.arms.candidate.usable}/${unit.coverage.arms.candidate.planned}, baseline ${unit.coverage.arms.baseline.usable}/${unit.coverage.arms.baseline.planned} required samples answered and graded; ${unit.coverage.shortCases.length} cases below the per-case minimum; need ${Math.round(rule.minConfirmCoverage * 100)}% per arm)`);
	} else {
		verdict = 'PASS';
		reasons = ['flagged drops did not reproduce on fresh samples'];
	}
	return {
		verdict, confirmed: confirmed.map((unit) => unit.name), reasons,
		units: units.map((unit, i) => ({ name: unit.name, p: unit.p, delta: unit.delta, pHolm: adjusted[i], complete: unit.complete,
			coverage: { have: unit.coverage.arms.candidate.usable + unit.coverage.arms.baseline.usable, wanted: unit.coverage.arms.candidate.planned + unit.coverage.arms.baseline.planned,
				candidate: unit.coverage.arms.candidate, baseline: unit.coverage.arms.baseline, shortCases: unit.coverage.shortCases } })),
	};
}

// Without a baseline: only absolute thresholds. Cases confidently below threshold make it FAIL when they exceed what noise explains.
// Without a baseline: only absolute thresholds, with the same evidence prerequisite as paired comparisons. A case FAILs
// only on complete evidence (at least half its planned samples answered and graded); PASS needs every case complete and
// at most maxErrorFraction of the candidate's planned samples errored or ungraded. An outage is INCONCLUSIVE.
export function absoluteVerdict(comparison, rule = VERDICT_RULE) {
	const planned = (row) => row.candidate.n + (row.candidate.errors ?? 0) + (row.candidate.ungraded ?? 0);
	const complete = (row) => planned(row) > 0 && row.candidate.n >= minUsable(planned(row));
	const below = comparison.cases.filter(r => r.threshold !== null && complete(r) && r.candidate.high < r.threshold);
	const short = comparison.cases.filter((row) => !complete(row));
	const total = comparison.cases.reduce((sum, row) => sum + Math.max(planned(row), 1), 0);
	const usable = comparison.cases.reduce((sum, row) => sum + Math.min(row.candidate.n, Math.max(planned(row), 1)), 0);
	const incompleteFraction = total ? 1 - usable / total : 1;
	const incomplete = short.length > 0 || incompleteFraction > rule.maxErrorFraction || comparison.cases.length === 0;
	const coverage = sampleCoverage(comparison.cases);
	const reasons = below.map(r => `${r.id}: ${r.candidate.good}/${r.candidate.n} good, Wilson high ${r.candidate.high.toFixed(2)} < threshold ${r.threshold}`);
	if (incomplete) reasons.push(`incomplete evidence: ${usable}/${total} planned samples answered and graded, ${short.length} cases below the minimum of half their planned samples`);
	for (const family of comparison.families) family.complete = comparison.cases.filter((row) => row.family === family.name).every(complete);
	return {
		verdict: below.length ? 'FAIL' : incomplete ? 'INCONCLUSIVE' : 'PASS',
		reasons, belowThreshold: below.map(r => r.id), incomplete, redoCases: short.map((row) => row.id),
		coverage: { incompleteFraction, errors: coverage.errors, ungraded: coverage.ungraded, planned: coverage.planned, incompleteFamilies: comparison.families.filter((f) => !f.complete).map((f) => f.name) },
	};
}

function fmt(delta) { return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} pts`; }

// Deterministic PRNG for simulations and stable sampling.
export function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function binomial(rng, n, p) { let k = 0; for (let i = 0; i < n; i++) if (rng() < p) k++; return k; }

// Typical decision-eval case mix: most moments are answered well, a minority are hard or borderline.
export function defaultRateModel(rng) {
	const u = rng();
	if (u < 0.55) return 0.85 + rng() * 0.15;
	if (u < 0.85) return 0.55 + rng() * 0.30;
	return 0.15 + rng() * 0.40;
}

// Simulates the CI decision on synthetic results with known truth. candidateRate(p, family, case) gives the candidate's true
// good-rate for a case whose baseline rate is p. When the screen is INCONCLUSIVE the flagged units are re-asked with
// confirmSamples fresh samples per build (set confirmSamples 0 to report the screen alone).
export function simulateVerdicts({ trials = 2000, families = 15, casesPerFamily = 10, samples = 3, baselineSamples = samples,
	confirmSamples = 3, errorRate = 0, seed = 1, rateModel = defaultRateModel, candidateRate = (p) => p, rule = VERDICT_RULE } = {}) {
	const rng = mulberry32(seed);
	const screenCounts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
	const finalCounts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
	let confirmCalls = 0;
	const draw = (truth, ids, n1Count, n0Count) => {
		let errors = 0, total = 0;
		const cases = truth.filter(t => !ids || ids.has(t.id)).map(t => {
			let n1 = 0, n0 = 0;
			for (let s = 0; s < n1Count; s++) if (rng() >= errorRate) n1++; else errors++;
			for (let s = 0; s < n0Count; s++) if (rng() >= errorRate) n0++; else errors++;
			total += n1Count + n0Count;
			return { id: t.id, family: t.family, threshold: 0.67, candidate: { good: binomial(rng, n1, t.pc), n: n1, errors: n1Count - n1 }, baseline: { good: binomial(rng, n0, t.p), n: n0, errors: n0Count - n0 } };
		});
		return { comparison: compareCases(cases, rule), errorFraction: total ? errors / total : 0 };
	};
	for (let t = 0; t < trials; t++) {
		const truth = [];
		for (let f = 0; f < families; f++) for (let c = 0; c < casesPerFamily; c++) {
			const p = rateModel(rng);
			truth.push({ id: `f${f}c${c}`, family: `f${f}`, p, pc: Math.min(1, Math.max(0, candidateRate(p, f, c))) });
		}
		const first = draw(truth, null, samples, baselineSamples);
		let screen = screenVerdict(first.comparison, { errorFraction: first.errorFraction, rule });
		screenCounts[screen.verdict]++;
		// Like eval: incomplete cases are answered again with fresh samples (errors still possible) and screened anew.
		if (screen.verdict !== 'FAIL' && screen.redoCases.length) {
			const redoIds = new Set(screen.redoCases);
			confirmCalls += redoIds.size * (samples + baselineSamples);
			const redo = draw(truth, redoIds, samples, baselineSamples);
			const merged = [...first.comparison.cases.filter((row) => !redoIds.has(row.id)), ...redo.comparison.cases];
			screen = screenVerdict(compareCases(merged, rule), { rule });
		}
		let final = screen.verdict;
		if (screen.verdict === 'INCONCLUSIVE' && confirmSamples > 0 && screen.rerunCases.length) {
			const ids = new Set(screen.rerunCases);
			confirmCalls += ids.size * confirmSamples * 2;
			final = confirmVerdict(draw(truth, ids, confirmSamples, confirmSamples).comparison, screen, { rule, samples: confirmSamples }).verdict;
		}
		finalCounts[final]++;
	}
	const share = counts => Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / trials]));
	return { trials, screen: share(screenCounts), final: share(finalCounts), meanConfirmCalls: confirmCalls / trials,
		PASS: finalCounts.PASS / trials, FAIL: finalCounts.FAIL / trials, INCONCLUSIVE: finalCounts.INCONCLUSIVE / trials };
}
