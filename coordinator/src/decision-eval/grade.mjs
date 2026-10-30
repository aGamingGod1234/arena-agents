// Grades decision-eval samples: deterministic predicates first, the cross-family judge only for undecided samples of cases
// that carry a rubric. Rates count good answers over answered and graded samples. Errored samples (no decision) and
// ungraded samples (the judge failed, returned nothing, or was off) are reported separately and never counted as answers.
// Only ACCEPTED calls form the graded trajectory: a call the production normaliser rejected never executed, so it is
// kept as a diagnostic and cannot decide the grade.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_THRESHOLD, validateCaseFile } from './schema.mjs';
import { buildContext, canonicalCalls, evaluatePredicate } from './predicates.mjs';
import { sourceWeights } from './sources.mjs';

export const GOOD_VERDICTS = Object.freeze(['good', 'judge_good']);
// Not a player answer: grading could not finish (judge error, missing verdict, judge off for a rubric case).
export const UNGRADED = 'ungraded';

export function isGoodVerdict(verdict) { return GOOD_VERDICTS.includes(verdict); }

// A sample that never reached a decision (provider error, timeout) is excluded from rates instead of counted as bad.
export function sampleErrored(sample) {
	return Boolean(sample?.error) || sample?.stop === 'error';
}

// Returns the deterministic grade, or verdict "needs_judge" when only the rubric can decide.
export function gradeSample(caseDef, sample, context = buildContext(caseDef)) {
	if (sampleErrored(sample)) return { verdict: 'error', source: 'error', reason: sample.error?.code ?? sample.error?.message ?? 'sample errored', goodMatched: [], badMatched: [] };
	const rejectedCalls = (sample.calls ?? []).filter(call => call?.normalizeError).length;
	const calls = canonicalCalls((sample.calls ?? []).filter(call => !call?.normalizeError));
	const expect = caseDef.expect ?? {};
	const matched = key => (expect[key] ?? []).map((predicate, index) => evaluatePredicate(predicate, calls, context) ? index : -1).filter(index => index >= 0);
	const badMatched = matched('bad');
	const goodMatched = matched('good');
	// Bad wins: an answer that flees and then also attacks the creeper is still a bad answer.
	const extra = rejectedCalls ? { rejectedCalls } : {};
	if (badMatched.length) return { verdict: 'bad', source: 'predicate', reason: `bad[${badMatched.join(',')}]`, goodMatched, badMatched, ...extra };
	if (goodMatched.length) return { verdict: 'good', source: 'predicate', reason: `good[${goodMatched.join(',')}]`, goodMatched, badMatched, ...extra };
	// Predicates decide only unambiguous outcomes; everything else is the rubric judge's call, never a default grade.
	if (expect.judge?.rubric) return { verdict: 'needs_judge', source: 'pending', reason: 'no predicate decided', goodMatched, badMatched, ...extra };
	return { verdict: UNGRADED, source: 'no-rubric', reason: 'no predicate decided and the case has no rubric', goodMatched, badMatched, ...extra };
}

// Grades every sample of one or more runs. judge(caseDef, pending[]) resolves undecided samples: it returns
// [{ verdict: 'judge_good'|'judge_bad'|'neutral', rationale, ... }] in the same order. Without a verdict they are ungraded.
export async function gradeSamples(caseById, samples, { judge = null } = {}) {
	const graded = samples.map(sample => {
		const caseDef = caseById.get(sample.caseId);
		if (!caseDef) return { sample, grade: { verdict: 'error', source: 'error', reason: 'unknown case', goodMatched: [], badMatched: [] } };
		return { sample, caseDef, grade: gradeSample(caseDef, sample) };
	});
	const pendingByCase = new Map();
	for (const row of graded) if (row.grade.verdict === 'needs_judge') {
		if (!pendingByCase.has(row.caseDef.id)) pendingByCase.set(row.caseDef.id, []);
		pendingByCase.get(row.caseDef.id).push(row);
	}
	const judgeRuns = [];
	if (judge && pendingByCase.size) {
		await Promise.all([...pendingByCase.values()].map(async rows => {
			try {
				const verdicts = await judge(rows[0].caseDef, rows.map(row => row.sample));
				rows.forEach((row, i) => {
					const v = verdicts?.[i];
					row.grade = v && ['judge_good', 'judge_bad', 'neutral'].includes(v.verdict)
						? { ...row.grade, verdict: v.verdict, source: 'judge', reason: v.rationale ?? '', judge: v.judge ?? null }
						: { ...row.grade, verdict: UNGRADED, source: 'judge-missing', reason: 'judge returned no verdict for this answer' };
				});
				judgeRuns.push({ caseId: rows[0].caseDef.id, answers: rows.length, ok: true });
			} catch (error) {
				for (const row of rows) row.grade = { ...row.grade, verdict: UNGRADED, source: 'judge-error', reason: String(error?.message ?? error).slice(0, 300) };
				judgeRuns.push({ caseId: rows[0].caseDef.id, answers: rows.length, ok: false, error: String(error?.message ?? error).slice(0, 300) });
			}
		}));
	}
	for (const row of graded) if (row.grade.verdict === 'needs_judge') row.grade = { ...row.grade, verdict: UNGRADED, source: 'judge-off', reason: 'judge disabled; predicates undecided' };
	return { graded, judgeRuns };
}

// Per-case counts for stats.compareCases.
export function caseCounts(caseDef, gradedRows) {
	const rows = gradedRows.filter(row => row.sample.caseId === caseDef.id);
	const verdicts = {};
	for (const row of rows) verdicts[row.grade.verdict] = (verdicts[row.grade.verdict] ?? 0) + 1;
	const errors = verdicts.error ?? 0;
	const ungraded = verdicts[UNGRADED] ?? 0;
	return { good: rows.filter(row => isGoodVerdict(row.grade.verdict)).length, n: rows.length - errors - ungraded, errors, ungraded, verdicts };
}

// `cases` is the PLAN: every case a comparison was meant to cover. A planned case with no samples stays as an empty row,
// so missing evidence is counted against coverage instead of disappearing. Source weights are taken within the plan.
export function buildCaseRows(cases, candidateRows, baselineRows = null) {
	const weights = sourceWeights(cases);
	return cases.map(c => ({
		id: c.id, family: c.family, causeClass: c.causeClass, threshold: c.expect?.threshold ?? DEFAULT_THRESHOLD,
		...weights.get(c.id),
		candidate: caseCounts(c, candidateRows),
		baseline: baselineRows ? caseCounts(c, baselineRows) : null,
	}));
}

// ---------- loading ----------

async function readJsonOrJsonl(file) {
	const text = await readFile(file, 'utf8');
	const trimmed = text.trim();
	if (!trimmed) return [];
	try { return JSON.parse(trimmed); } catch {
		return trimmed.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
			try { return JSON.parse(line); } catch (error) { throw new Error(`${file}:${i + 1}: ${error.message}`); }
		});
	}
}

// Cases from a JSON file, or every *.json file in a directory (recursively). Validated against schema v1.
export async function loadCases(target, { validate = true } = {}) {
	const files = [];
	const walk = async p => {
		const info = await stat(p);
		if (info.isDirectory()) for (const entry of (await readdir(p)).sort()) await walk(path.join(p, entry));
		else if (/\.json$/i.test(p)) files.push(p);
	};
	await walk(target);
	const cases = [];
	for (const file of files) {
		const value = await readJsonOrJsonl(file);
		const list = Array.isArray(value) ? value : value?.cases;
		if (!Array.isArray(list)) continue;
		cases.push(...(validate ? validateCaseFile(list, file) : list));
	}
	const seen = new Set();
	for (const c of cases) { if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`); seen.add(c.id); }
	return cases;
}

/**
 * The (caseId, sample) identities a native run file declared it would answer: config.plannedIdentities (merged screens),
 * else config.sampleCounts from config.sampleOffset, else the older config.samples for every rendered case. Null when the
 * file declares no plan (JSONL or bare arrays): its completeness cannot be shown.
 */
export function declaredIdentities(run) {
	const config = run?.config;
	if (!config) return null;
	if (Array.isArray(config.plannedIdentities)) return config.plannedIdentities.map(({ caseId, sample }) => ({ caseId, sample }));
	const offset = Number.isSafeInteger(config.sampleOffset) ? config.sampleOffset : 0;
	const planned = [...Object.keys(run.renders ?? {}), ...(run.summary?.renderErrors ?? []).map((failure) => failure.caseId)];
	const counts = config.sampleCounts ?? (Number.isSafeInteger(config.samples) ? Object.fromEntries(planned.map((id) => [id, config.samples])) : null);
	if (!counts) return null;
	return Object.entries(counts).flatMap(([caseId, count]) => Array.from({ length: count }, (_, i) => ({ caseId, sample: offset + i })));
}

// A run file ({ kind: 'decision-eval-run', results }), a JSONL of sample rows, or a plain array. Several files merge.
export async function loadRun(files) {
	const list = [files].flat();
	const runs = [];
	const samples = [];
	// Files that carry rows without a run header (JSONL, bare arrays): they declare no sample plan.
	const planless = [];
	for (const file of list) {
		const value = await readJsonOrJsonl(file);
		if (Array.isArray(value)) { planless.push(file); samples.push(...value.filter(row => row?.kind === 'decision-eval-sample' || row?.caseId)); }
		else if (Array.isArray(value?.results)) { samples.push(...value.results); runs.push({ file, ...value, results: undefined }); }
		else throw new Error(`${file}: not a decision-eval run`);
	}
	return { files: list, runs, samples, planless };
}

// Cost, tokens, wall time and identity of one arm, from run summaries when present and sample rows otherwise.
export function summarizeArm(run) {
	const samples = run.samples;
	const sum = key => samples.reduce((acc, s) => acc + (Number.isFinite(s.usage?.[key]) ? s.usage[key] : 0), 0);
	const unknownCost = samples.filter(s => !Number.isFinite(s.usage?.costUsd)).length;
	const wallMs = run.runs.reduce((acc, r) => acc + (Number.isFinite(r.summary?.wallMs) ? r.summary.wallMs : 0), 0);
	const latencies = samples.map(s => s.latency?.totalMs).filter(Number.isFinite).sort((a, b) => a - b);
	const pct = q => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : null;
	const values = key => [...new Set(samples.map(s => key(s)).filter(v => v !== undefined && v !== null))];
	return {
		samples: samples.length, errors: samples.filter(sampleErrored).length,
		providers: values(s => s.provider), models: values(s => s.model), commits: values(s => s.build?.commit),
		renderedInputs: values(s => s.rendered?.inputSha256).length,
		costUsd: sum('costUsd'), unknownCostSamples: unknownCost,
		tokens: { input: sum('inputTokens'), cachedInput: sum('cachedInputTokens'), cacheWrite: sum('cacheWriteInputTokens'), output: sum('outputTokens') },
		wallMs: wallMs || null, maxConcurrency: Math.max(0, ...run.runs.map(r => r.summary?.maxConcurrency).filter(Number.isFinite)) || null,
		latencyMs: { p50: pct(0.5), p90: pct(0.9), max: latencies.at(-1) ?? null },
	};
}
