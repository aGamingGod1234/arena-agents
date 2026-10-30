// Decision-eval comparison reports: one JSON document for tools and CI, one short markdown page for people, and a spot-check
// file of sampled graded answers with the context the model saw, so a person can audit the grading itself.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalCalls } from './predicates.mjs';
import { VERDICT_RULE, mulberry32 } from './stats.mjs';

const pct = value => (value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`);
const pts = value => (value === null || value === undefined ? 'n/a' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}`);
const usd = value => (Number.isFinite(value) ? `$${value.toFixed(2)}` : 'n/a');
const secs = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : 'n/a');

// Worst first: biggest drop against baseline, then lowest candidate rate.
function worstFirst(a, b) {
	const da = a.meanDelta ?? 0, db = b.meanDelta ?? 0;
	if (da !== db) return da - db;
	return (a.candidate.meanCaseRate ?? 1) - (b.candidate.meanCaseRate ?? 1);
}

export function buildReport({ comparison, verdict, confirm = null, candidate, baseline = null, judge = null, gradeMs = null, rule = VERDICT_RULE, generatedAt = new Date().toISOString(), inputs = {}, coverageMode = null, caseDefinitions = [] }) {
	const regressions = comparison.cases.filter(r => ['regression-suspect', 'below-threshold-new', 'worse-known-weak'].includes(r.status))
		.sort((a, b) => (a.pWorse ?? 1) - (b.pWorse ?? 1) || (a.delta ?? 0) - (b.delta ?? 0));
	const improvements = comparison.cases.filter(r => r.status === 'improvement-suspect').sort((a, b) => (a.pBetter ?? 1) - (b.pBetter ?? 1));
	const cost = {
		candidateUsd: candidate?.costUsd ?? null, baselineUsd: baseline?.costUsd ?? null, judgeUsd: judge?.costUsd ?? 0,
	};
	cost.totalUsd = [cost.candidateUsd, cost.baselineUsd, cost.judgeUsd].filter(Number.isFinite).reduce((a, b) => a + b, 0);
	// The confirmation decides only the units the screen flagged. A screen FAIL stands; a screen with undecided
	// (incomplete) units cannot become PASS through a confirmation of other units.
	const final = verdict.planUnknown ? 'INCONCLUSIVE' : !confirm ? verdict.verdict
		: verdict.verdict === 'FAIL' || confirm.verdict === 'FAIL' ? 'FAIL'
		: confirm.verdict === 'PASS' && verdict.incomplete ? 'INCONCLUSIVE' : confirm.verdict;
	return {
		schemaVersion: 1, kind: 'decision-eval-comparison', generatedAt, inputs,
		verdict: final, screenVerdict: verdict.verdict, reasons: confirm ? [...confirm.reasons, ...verdict.reasons.map(r => `screen: ${r}`)] : verdict.reasons,
		continuationCoverage: { total: caseDefinitions.length, withoutContinuation: caseDefinitions.filter(c => !c.steps?.length).length,
			basis: 'scripted replies only; no Minecraft execution' },
		uninformativeCases: comparison.cases.filter(c => c.candidate.n > 0 && c.baseline?.n > 0 && c.candidate.good === 0 && c.baseline.good === 0),
		mode: baseline ? 'paired' : 'absolute', rule,
		overall: comparison.overall, families: [...comparison.families].sort(worstFirst),
		regressions, improvements, improvedFamilies: verdict.improved ?? [],
		rerun: { families: verdict.rerunFamilies ?? [], all: verdict.rerunAll ?? false, cases: verdict.rerunCases ?? [] },
		// Cases whose screen evidence is incomplete (errored or ungraded samples): complete them, then screen again.
		redo: { cases: verdict.redoCases ?? [] }, coverage: verdict.coverage ?? null, coverageMode,
		// The screen families and cases above always describe the SCREEN samples; the confirmation stage, if any, is its
		// own comparison of fresh samples and is reported here with its units, coverage and families.
		confirm: confirm === null ? null : {
			verdict: confirm.verdict, reasons: confirm.reasons, confirmed: confirm.confirmed, units: confirm.units, coverage: confirm.coverage ?? null,
			overall: confirm.comparison?.overall ?? null, families: confirm.comparison ? [...confirm.comparison.families].sort(worstFirst) : [],
			cases: confirm.comparison?.cases ?? [],
		},
		candidate, baseline, judge, cost,
		wall: { candidateMs: candidate?.wallMs ?? null, baselineMs: baseline?.wallMs ?? null, gradeMs },
		cases: comparison.cases,
	};
}

export function renderMarkdown(report, { maxFamilies = 20, maxCases = 15 } = {}) {
	const lines = [];
	const allZero = report.verdict === 'PASS' && report.uninformativeCases?.length === report.cases.length && report.cases.length > 0;
	lines.push(`# Decision eval: ${allZero ? 'UNINFORMATIVE (regression gate PASS)' : report.verdict}`, '');
	if (report.continuationCoverage) lines.push(`Continuation coverage: **${report.continuationCoverage.withoutContinuation}/${report.continuationCoverage.total} cases have no continuation**. Continuations use scripted replies; commands are not executed in Minecraft.`, '');
	if (report.uninformativeCases?.length) lines.push(`**${report.uninformativeCases.length} cases are uninformative: both arms have zero good answers.** PASS means no detected regression, not success on these cases.`, '');
	if (report.screenVerdict !== report.verdict) lines.push(`Screen verdict ${report.screenVerdict}; confirm run decided ${report.verdict}.`, '');
	for (const reason of report.reasons.slice(0, 8)) lines.push(`- ${reason}`);
	if (report.reasons.length) lines.push('');
	if (report.coverageMode?.mode === 'predicate-only') {
		lines.push(`Predicate-only mode (diagnostic): only hard predicate decisions are graded; ${report.coverage?.ungraded ?? 0} answers the judge would decide stay ungraded, so units relying on them cannot decide.`, '');
	}
	if (report.coverage) {
		lines.push(`Screen completeness: ${report.coverage.planned} planned samples, ${report.coverage.errors} errored, ${report.coverage.ungraded} ungraded (${(report.coverage.incompleteFraction * 100).toFixed(1)}% incomplete).`, '');
	}
	const o = report.overall;
	lines.push(`## Screen`, '', `Overall: ${o.cases} cases, candidate ${o.candidate.good}/${o.candidate.n} good (mean case rate ${pct(o.candidate.meanCaseRate)})`
		+ (o.baseline ? `, baseline ${o.baseline.good}/${o.baseline.n} (${pct(o.baseline.meanCaseRate)}), delta ${pts(o.meanDelta)} pts, p(worse) ${fmtP(o.pWorse)}` : '') + '.', '');
	lines.push('## Families (worst first)', '', 'Rates and deltas weigh each recorded source moment once (derived variants share its weight); rows are cases, sources are distinct recorded moments.', '', '| family | rows (sources) | candidate | baseline | delta pts | p worse (Holm) | decided | below threshold |', '|---|---:|---:|---:|---:|---:|---|---:|');
	for (const f of report.families.slice(0, maxFamilies)) {
		lines.push(`| ${f.name} | ${f.cases} (${f.sources ?? f.cases}) | ${pct(f.candidate.meanCaseRate)} | ${pct(f.baseline?.meanCaseRate)} | ${pts(f.meanDelta)} | ${fmtP(f.pWorse)} (${fmtP(f.pWorseHolm)}) | ${f.complete === false ? 'no: incomplete' : 'yes'} | ${f.belowThreshold} |`);
	}
	if (report.families.length > maxFamilies) lines.push(`| ... ${report.families.length - maxFamilies} more | | | | | | | |`);
	lines.push('');
	const caseTable = (title, rows) => {
		lines.push(`## ${title}`, '');
		if (!rows.length) { lines.push('None.', ''); return; }
		lines.push('| case | family | candidate | baseline | threshold | status | p |', '|---|---|---:|---:|---:|---|---:|');
		for (const r of rows.slice(0, maxCases)) {
			lines.push(`| ${r.id} | ${r.family} | ${r.candidate.good}/${r.candidate.n} | ${r.baseline ? `${r.baseline.good}/${r.baseline.n}` : 'n/a'} | ${r.threshold ?? 'n/a'} | ${r.status} | ${fmtP(r.status === 'improvement-suspect' ? r.pBetter : r.pWorse)} |`);
		}
		if (rows.length > maxCases) lines.push(`| ... ${rows.length - maxCases} more | | | | | | |`);
		lines.push('');
	};
	caseTable('Regressions and new threshold misses', report.regressions);
	caseTable('Improvements', report.improvements);
	caseTable('Uninformative: zero good in both arms', (report.uninformativeCases ?? []).map(c => ({ ...c, status: 'uninformative' })));
	if (report.rerun.families.length || report.rerun.all) {
		lines.push(`Re-ask with fresh samples: ${report.rerun.all ? 'all cases' : `${report.rerun.families.join(', ')} (${report.rerun.cases.length} cases)`}.`, '');
	}
	if (report.redo.cases.length) lines.push(`Incomplete evidence in ${report.redo.cases.length} cases: answer and grade them again, then screen again.`, '');
	if (report.confirm) {
		const c = report.confirm;
		lines.push(`## Confirmation (fresh samples): ${c.verdict}`, '');
		for (const reason of c.reasons.slice(0, 8)) lines.push(`- ${reason}`);
		lines.push('', '| unit | coverage | delta pts | p worse | Holm |', '|---|---:|---:|---:|---:|');
		for (const u of c.units) lines.push(`| ${u.name} | ${u.coverage.have}/${u.coverage.wanted} | ${pts(u.delta)} | ${fmtP(u.p)} | ${fmtP(u.pHolm)} |`);
		if (c.overall) lines.push('', `Confirmation samples overall: candidate ${c.overall.candidate.good}/${c.overall.candidate.n}${c.overall.baseline ? `, baseline ${c.overall.baseline.good}/${c.overall.baseline.n}` : ''}.`);
		lines.push('');
	}
	lines.push('## Cost and time', '', '| arm | samples | errors | cost | wall | p50 / p90 latency | concurrency |', '|---|---:|---:|---:|---:|---:|---:|');
	for (const [name, arm] of [['candidate', report.candidate], ['baseline', report.baseline]]) if (arm) {
		lines.push(`| ${name} ${arm.commits?.map(c => String(c).slice(0, 8)).join(',') ?? ''} | ${arm.samples} | ${arm.errors} | ${usd(arm.costUsd)}${arm.unknownCostSamples ? ` (+${arm.unknownCostSamples} unpriced)` : ''} | ${secs(arm.wallMs)} | ${secs(arm.latencyMs?.p50)} / ${secs(arm.latencyMs?.p90)} | ${arm.maxConcurrency ?? 'n/a'} |`);
	}
	if (report.judge) {
		const j = report.judge;
		lines.push(`| judge ${j.config?.provider}:${j.config?.model} | ${j.answersJudged} answers, ${j.calls} calls, ${j.cacheHits} cached | ${j.failures} | ${usd(j.costUsd)} | ${secs(j.wallMs)} | | |`);
	}
	lines.push('', `Total ${usd(report.cost.totalUsd)}. Grading ${secs(report.wall.gradeMs)}.`, '');
	lines.push(`Rule: FAIL when a family (Holm across families) or the overall set drops with p < ${report.rule.failAlpha} and at least ${report.rule.minEffect * 100} pts (overall ${report.rule.overallMinEffect * 100}); INCONCLUSIVE when a family drop has Holm p < ${report.rule.familyScreenAlpha} or the overall p < ${report.rule.overallScreenAlpha}, then re-ask those cases. Single cases never fail the screen.`);
	return lines.join('\n') + '\n';
}

function fmtP(p) {
	if (p === null || p === undefined) return 'n/a';
	return p < 0.001 ? p.toExponential(1) : p.toFixed(3);
}

// ---------- spot-check sampler ----------

// Picks graded answers for human review: judge-graded and non-good answers first, spread across families, then good ones.
export function selectSpotChecks(gradedRows, count = 12, seed = 11) {
	const rng = mulberry32(seed);
	const rows = gradedRows.filter(row => row.caseDef && row.grade.verdict !== 'error').map(row => ({ row, r: rng() }));
	const priority = ({ row }) => (row.grade.source === 'judge' ? 0 : row.grade.verdict === 'good' ? 3 : row.grade.verdict === 'neutral' ? 1 : 2);
	const buckets = new Map();
	for (const entry of rows.sort((a, b) => priority(a) - priority(b) || a.r - b.r)) {
		const key = `${priority(entry)}`;
		if (!buckets.has(key)) buckets.set(key, []);
		buckets.get(key).push(entry);
	}
	const picked = [];
	const familiesSeen = new Map();
	// Round-robin over priority buckets so good answers are audited too, preferring families not yet sampled.
	const order = [...buckets.keys()].sort();
	while (picked.length < count && order.some(key => buckets.get(key).length)) {
		for (const key of order) {
			const bucket = buckets.get(key);
			if (!bucket.length || picked.length >= count) continue;
			bucket.sort((a, b) => (familiesSeen.get(a.row.caseDef.family) ?? 0) - (familiesSeen.get(b.row.caseDef.family) ?? 0) || a.r - b.r);
			const { row } = bucket.shift();
			familiesSeen.set(row.caseDef.family, (familiesSeen.get(row.caseDef.family) ?? 0) + 1);
			picked.push(row);
		}
	}
	return picked;
}

// renderContext(caseDef, sample) -> Promise<string|null> returns what the model saw (instructions omitted by default).
export async function writeSpotChecks(dir, rows, { renderContext = null, title = 'Decision-eval spot check' } = {}) {
	await mkdir(dir, { recursive: true });
	const parts = [`# ${title}`, '', `${rows.length} graded answers. For each: does the grade match what a sensible player should do? Mark disagreements.`, ''];
	const jsonl = [];
	for (const [i, row] of rows.entries()) {
		const { caseDef, sample, grade } = row;
		let context = null;
		if (renderContext) {
			try { context = await renderContext(caseDef, sample); } catch (error) { context = `(render failed: ${error.message})`; }
		}
		const calls = canonicalCalls(sample.calls).map(call => ({ tool: call.tool, args: call.args, ...(call.normalizeError ? { normalizeError: call.normalizeError } : {}), ...(call.canned ? { canned: call.canned } : {}) }));
		parts.push(`## ${i + 1}. ${caseDef.id} (${caseDef.family}) arm=${sample.__arm ?? 'n/a'} sample=${sample.sample ?? '?'}`, '');
		parts.push(`Grade: **${grade.verdict}** via ${grade.source}${grade.reason ? `: ${grade.reason}` : ''}`, '');
		if (caseDef.rationale) parts.push(`Player sense: ${caseDef.rationale}`, '');
		if (caseDef.expect?.judge?.rubric) parts.push(`Rubric: ${caseDef.expect.judge.rubric}`, '');
		parts.push('Expectations:', '```json', JSON.stringify({ good: caseDef.expect?.good ?? [], bad: caseDef.expect?.bad ?? [] }, null, 1).slice(0, 3000), '```', '');
		parts.push('Calls:', '```json', JSON.stringify(calls, null, 1).slice(0, 4000), '```', '');
		if (sample.text) parts.push(`Assistant text: ${String(sample.text).slice(0, 600)}`, '');
		parts.push('<details><summary>Context the model saw</summary>', '', '```', (context ?? `(no renderer available; raw state)\n${JSON.stringify(caseDef.state, null, 1)}`).slice(0, 20000), '```', '</details>', '');
		jsonl.push({ caseId: caseDef.id, family: caseDef.family, arm: sample.__arm ?? null, sample: sample.sample ?? null, verdict: grade.verdict, source: grade.source, reason: grade.reason, calls, humanVerdict: null });
	}
	await writeFile(path.join(dir, 'spot-check.md'), parts.join('\n'));
	await writeFile(path.join(dir, 'spot-check.jsonl'), jsonl.map(row => JSON.stringify(row)).join('\n') + '\n');
	return { markdown: path.join(dir, 'spot-check.md'), jsonl: path.join(dir, 'spot-check.jsonl'), count: rows.length };
}
