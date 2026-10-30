// The one validation entry point between loaded sample files and every verdict. Screen, confirmation and candidate-only
// comparisons all pass their inputs through validateEvidence; grading and the statistics only accept the object it
// returns (its rows are held privately here), so no verdict code can see a row that did not pass validation.
import { buildCaseRows, declaredIdentities } from './grade.mjs';

const ROWS = new WeakMap();
const key = (caseId, sample) => `${caseId}|${sample}`;

/**
 * One arm's plan. `declared` is the manifest's entries for the arm when a manifest is given, otherwise the union of
 * every native run file's declarations. `known` is true only with a manifest, or when every input file of the arm
 * declares its plan and together they declare at least one identity: any planless input (JSONL or array, even empty,
 * or a native file without a plan) makes the plan unknown.
 */
export function armPlan(name, run, manifest) {
	if (manifest !== null) return { declared: manifest.required.filter((entry) => entry.arm === name).map(({ caseId, sample }) => ({ caseId, sample })), known: true };
	const declared = [];
	let known = run.planless.length === 0 && run.runs.length > 0;
	for (const file of run.runs) {
		const identities = declaredIdentities(file);
		if (identities === null) { known = false; continue; }
		declared.push(...identities);
	}
	return { declared, known: known && declared.length > 0 };
}

/**
 * Validates one stage's inputs against the corpus and the declared plan, independent of file order and type:
 * - every declared identity names a case in the corpus, and is declared once;
 * - every supplied row names a case in the corpus, appears once, and is a declared identity of its arm;
 * - a confirmation neither declares nor supplies an identity of the screen (`reserved`: arm|case|sample keys);
 * - a manifest names only the arms given.
 * Any problem refuses the input. Otherwise every declared identity without a row becomes a missing (errored) row.
 * Returns { problems } or { evidence }; `evidence` carries the plan facts and, privately, the completed rows.
 */
export function validateEvidence({ stage, corpus, arms, manifest = null, reserved = new Set() }) {
	const problems = [];
	const label = stage === 'confirm' ? 'confirm' : 'screen';
	if (manifest !== null) {
		if (!Array.isArray(manifest.required)) return { problems: [`${label} manifest needs a required array`] };
		const names = new Set(arms.map((arm) => arm.name));
		for (const entry of manifest.required) if (!names.has(entry.arm)) problems.push(`${label} manifest names arm ${entry.arm}, which has no input`);
	}
	const rows = {};
	const declaredByArm = {};
	let known = true;
	for (const { name, run } of arms) {
		const plan = armPlan(name, run, manifest);
		if (!plan.known) known = false;
		const declared = new Set();
		for (const { caseId, sample } of plan.declared) {
			const k = key(caseId, sample);
			if (!corpus.has(caseId)) problems.push(`${label}: declared case ${caseId} (${name} #${sample}) is not in the corpus`);
			if (declared.has(k)) problems.push(`${label}: duplicate planned sample ${name} ${caseId}#${sample}`);
			if (reserved.has(`${name}|${k}`)) problems.push(`${label}: declares screen sample ${name} ${caseId}#${sample}`);
			declared.add(k);
		}
		const present = new Set();
		for (const sample of run.samples) {
			const k = key(sample.caseId, sample.sample);
			if (!corpus.has(sample.caseId)) problems.push(`${label}: row for case ${sample.caseId} (${name} #${sample.sample}) is not in the corpus`);
			if (present.has(k)) problems.push(`${label}: duplicate sample ${name} ${sample.caseId}#${sample.sample}`);
			if (reserved.has(`${name}|${k}`)) problems.push(`${label}: reuses screen sample ${name} ${sample.caseId} ${sample.sample}`);
			if (!declared.has(k)) problems.push(`${label}: unplanned sample ${name} ${sample.caseId}#${sample.sample} is not a declared identity (declare it in a native run file or a manifest)`);
			present.add(k);
		}
		if (problems.length) continue;
		const complete = [...run.samples];
		for (const { caseId, sample } of plan.declared) {
			if (present.has(key(caseId, sample))) continue;
			complete.push({ schemaVersion: 1, kind: 'decision-eval-sample', caseId, family: corpus.get(caseId).family, sample, calls: [], stop: 'error', missing: true,
				error: { code: 'MISSING_SAMPLE', message: `declared in the ${label} plan but no sample row was supplied` } });
		}
		rows[name] = complete;
		declaredByArm[name] = plan.declared;
	}
	if (problems.length) return { problems };
	const required = new Map();
	for (const [name, declared] of Object.entries(declaredByArm)) {
		for (const { caseId } of declared) {
			const counts = required.get(caseId) ?? Object.fromEntries(arms.map((arm) => [arm.name, 0]));
			counts[name] += 1;
			required.set(caseId, counts);
		}
	}
	const plannedCases = [...corpus.values()].filter((caseDef) => required.has(caseDef.id));
	const evidence = Object.freeze({
		stage, known, arms: arms.map((arm) => arm.name), required,
		identities: Object.freeze(Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, new Set(list.map((row) => `${name}|${key(row.caseId, row.sample)}`))]))),
		plannedCaseIds: plannedCases.map((caseDef) => caseDef.id),
	});
	ROWS.set(evidence, { rows, plannedCases });
	return { evidence };
}

function inner(evidence) {
	const value = ROWS.get(evidence);
	if (!value) throw new TypeError('decision-eval: rows must come from validateEvidence');
	return value;
}

/** The validated rows of each arm (declared rows plus missing rows), for grading. */
export function evidenceSamples(evidence) {
	const { rows } = inner(evidence);
	return Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, list.map((row) => ({ ...row }))]));
}

/**
 * Per-case rows for the statistics, from graded rows of exactly the validated identities: every graded row must be a
 * validated identity of its arm and every validated identity must be graded once.
 */
export function evidenceCaseRows(evidence, graded) {
	const { plannedCases } = inner(evidence);
	for (const name of evidence.arms) {
		const want = evidence.identities[name];
		const got = new Set();
		for (const row of graded[name] ?? []) {
			const k = `${name}|${key(row.sample.caseId, row.sample.sample)}`;
			if (!want.has(k) || got.has(k)) throw new Error(`decision-eval: graded row ${k} is not a validated identity`);
			got.add(k);
		}
		if (got.size !== want.size) throw new Error(`decision-eval: ${want.size - got.size} validated ${name} rows were not graded`);
	}
	return buildCaseRows(plannedCases, graded.candidate, graded.baseline ?? null);
}
