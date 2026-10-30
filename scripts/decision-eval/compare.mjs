#!/usr/bin/env node
// Grades decision-eval runs and compares a candidate build against a baseline build.
//
//   node scripts/decision-eval/compare.mjs --cases <file|dir> --candidate <run.json> [--baseline <run.json>]
//        [--confirm-candidate <run.json> --confirm-baseline <run.json>] [--out <dir>] [--judge auto|off]
//        [--judge-provider claude|codex|opencode] [--judge-model <id>] [--judge-effort <level>] [--judge-cache <file>]
//        [--judge-max-usd 5] [--spot-check 12] [--no-validate] [--confirm-manifest <file>] [--confirm-samples 3]
//        [--screen-manifest <file>]
//
// Exit codes: 0 PASS, 1 FAIL, 3 INCONCLUSIVE (re-ask the listed cases with --confirm-*), 2 usage or input error.
// Run files may repeat (--candidate a.json --candidate b.json) and merge. Confirm runs must hold FRESH samples only:
// a sample (arm, case, sample index) that appears twice, or that the screen already used, is an input error. The
// manifest ({ required: [{ caseId, arm, sample }] }, written by eval.mjs) lists every confirmation sample the verdict
// needs; without it the confirmation files' own native declarations are its plan. Every input set (screen and
// confirmation, paired or candidate-only) passes evidence.mjs validateEvidence: rows and declarations must name corpus
// cases and declared identities, and declared samples without a row are missing. Missing evidence stays INCONCLUSIVE.
// --judge off is predicate-only mode: only hard predicate decisions are graded, the rest stays ungraded (diagnostic only).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evidenceCaseRows, evidenceSamples, validateEvidence } from '../../coordinator/src/decision-eval/evidence.mjs';
import { gradeSamples, loadCases, loadRun, summarizeArm } from '../../coordinator/src/decision-eval/grade.mjs';
import { closeOpenCodeJudgeServer, createJudge } from '../../coordinator/src/decision-eval/judge.mjs';
import { buildReport, renderMarkdown, selectSpotChecks, writeSpotChecks } from '../../coordinator/src/decision-eval/report.mjs';
import { absoluteVerdict, compareCases, confirmVerdict, sampleCoverage, screenVerdict } from '../../coordinator/src/decision-eval/stats.mjs';

const EXIT = { PASS: 0, FAIL: 1, INCONCLUSIVE: 3 };
const REPEATABLE = new Set(['cases', 'candidate', 'baseline', 'confirm-candidate', 'confirm-baseline']);

const INPUT_FILES = ['candidate', 'baseline', 'confirm-candidate', 'confirm-baseline', 'screen-manifest', 'confirm-manifest'];
/** SHA-256 of every input file by option, in the order given: { candidate: [hex, ...], ... }. */
export async function inputDigests(options) {
	const digests = {};
	for (const option of INPUT_FILES) {
		const files = [options[option] ?? []].flat();
		if (files.length) digests[option] = await Promise.all(files.map(async (file) => createHash('sha256').update(await readFile(file)).digest('hex')));
	}
	return digests;
}

export function parseArgs(argv) {
	const options = { judge: 'auto', 'spot-check': '12', 'judge-max-usd': '5' };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
		const key = arg.slice(2);
		if (key === 'no-validate' || key === 'help' || key === 'allow-same-family-judge') { options[key] = true; continue; }
		const value = argv[++i];
		if (value === undefined) throw new Error(`${arg} needs a value`);
		if (REPEATABLE.has(key)) (options[key] ??= []).push(value); else options[key] = value;
	}
	return options;
}

// Grades exactly the validated rows of one stage (evidenceSamples refuses anything validateEvidence did not return).
async function gradeEvidence(caseById, evidence, options, judges) {
	const samplesByArm = evidenceSamples(evidence);
	// One judge per player family; answers of both arms for a case go to one judge call when they share a family.
	const tagged = Object.entries(samplesByArm).flatMap(([name, samples]) => samples.map(sample => ({ ...sample, __arm: name })));
	const byProvider = new Map();
	// OpenCode hosts two free model families, so its players are told apart by model.
	for (const sample of tagged) {
		const provider = sample.provider ?? 'claude';
		const family = provider === 'opencode' ? `${provider}:${sample.model ?? ''}` : provider;
		if (!byProvider.has(family)) byProvider.set(family, { provider, model: sample.model ?? null, samples: [] });
		byProvider.get(family).samples.push(sample);
	}
	const rows = [];
	for (const [family, { provider, model, samples }] of byProvider) {
		let judge = null;
		if (options.judge !== 'off') {
			if (!judges.has(family)) judges.set(family, createJudge({ playerProvider: provider, playerModel: model, cacheFile: options['judge-cache'],
				maxSpendUsd: Number(options['judge-max-usd']),
				overrides: { ...(options['judge-provider'] ? { provider: options['judge-provider'] } : {}), ...(options['judge-model'] ? { model: options['judge-model'] } : {}),
					...(options['judge-effort'] ? { effort: options['judge-effort'] } : {}),
					...((options['allow-same-family-judge'] || process.env.AA_JUDGE_ALLOW_SAME_FAMILY === '1') ? { allowSameFamily: true } : {}) } }));
			judge = judges.get(family);
		}
		const { graded } = await gradeSamples(caseById, samples, { judge });
		rows.push(...graded);
	}
	return Object.fromEntries(Object.keys(samplesByArm).map((name) => [name, rows.filter(row => row.sample.__arm === name)]));
}

// Spot checks show reviewers the wake bytes this build sends a fresh session (renderWake renders run one at a time,
// which writeSpotChecks does). The instructions and tool definitions are shared by every case and left out.
async function loadRenderer() {
	const { renderWake } = await import(pathToFileURL(fileURLToPath(new URL('../../coordinator/src/decision-eval/render.mjs', import.meta.url))).href);
	return async (caseDef, sample) => {
		const rendered = await renderWake(caseDef, { ...(sample.provider ? { provider: sample.provider } : {}), ...(sample.model ? { model: sample.model } : {}) });
		const note = sample.rendered?.inputSha256 && ![rendered.inputSha256, rendered.encodedSha256].includes(sample.rendered.inputSha256)
			? `(note: this build renders a different input than the sample recorded, ${sample.rendered.inputSha256.slice(0, 12)})\n` : '';
		return `${note}${rendered.encodedInput}`;
	};
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help || !options.cases || !options.candidate) {
		process.stderr.write('usage: compare.mjs --cases <file|dir> --candidate <run.json> [--baseline <run.json>] [--out <dir>] [--judge auto|off]\n');
		return 2;
	}
	const started = Date.now();
	const allCases = (await Promise.all(options.cases.map(p => loadCases(p, { validate: !options['no-validate'] })))).flat();
	// Predicate-only mode grades only the hard predicate decisions; every undecided answer stays ungraded, so coverage
	// keeps any unit that relies on them from deciding. It is a diagnostic, not a gate.
	const predicateOnly = options.judge === 'off';
	const cases = allCases;
	const coverageMode = { mode: predicateOnly ? 'predicate-only' : 'judged', cases: allCases.length };
	const caseById = new Map(cases.map(c => [c.id, c]));
	const out = options.out ? path.resolve(options.out) : null;
	if (out) { await mkdir(out, { recursive: true }); options['judge-cache'] ??= path.join(out, 'judge-cache.jsonl'); }
	const readManifest = async (option) => (options[option] ? JSON.parse(await readFile(options[option], 'utf8')) : null);
	const refuse = (problems) => {
		process.stderr.write(`refusing: ${problems.length} input problems\n${problems.slice(0, 20).map(p => `  ${p}`).join('\n')}\n`);
		return 2;
	};
	// Loaded files go straight into validation; from here on only the validated evidence is used.
	const screenArms = [{ name: 'candidate', run: await loadRun(options.candidate) }];
	if (options.baseline) screenArms.push({ name: 'baseline', run: await loadRun(options.baseline) });
	const screenCheck = validateEvidence({ stage: 'screen', corpus: caseById, arms: screenArms, manifest: await readManifest('screen-manifest') });
	if (screenCheck.problems) return refuse(screenCheck.problems);
	const screen = screenCheck.evidence;
	let confirmEvidence = null;
	if (options['confirm-candidate'] || options['confirm-baseline']) {
		if (!options['confirm-candidate'] || !options['confirm-baseline'] || !options.baseline) return refuse(['confirmation needs --baseline, --confirm-candidate and --confirm-baseline']);
		const confirmArms = [{ name: 'candidate', run: await loadRun(options['confirm-candidate']) }, { name: 'baseline', run: await loadRun(options['confirm-baseline']) }];
		const reserved = new Set(Object.values(screen.identities).flatMap((set) => [...set]));
		const confirmCheck = validateEvidence({ stage: 'confirm', corpus: caseById, arms: confirmArms, manifest: await readManifest('confirm-manifest'), reserved });
		if (confirmCheck.problems) return refuse(confirmCheck.problems);
		confirmEvidence = confirmCheck.evidence;
	}
	const judges = new Map();
	const graded = await gradeEvidence(caseById, screen, options, judges);
	const comparison = compareCases(evidenceCaseRows(screen, graded));
	// Completeness (errored and ungraded samples) is measured on the graded case rows, both arms together.
	let verdict = options.baseline ? screenVerdict(comparison) : { ...absoluteVerdict(comparison), improved: [], rerunFamilies: [], rerunCases: [] };
	// An unknown plan decides nothing: neither PASS nor FAIL, here or after a confirmation (buildReport keeps it).
	if (!screen.known) {
		verdict = { ...verdict, verdict: 'INCONCLUSIVE', planUnknown: true, incomplete: true,
			reasons: [...verdict.reasons, 'the sample plan is unknown (an input file declares no plan; pass --screen-manifest), so completeness cannot be shown and nothing is decided'] };
	}
	let confirm = null;
	if (confirmEvidence !== null) {
		const confirmGraded = await gradeEvidence(caseById, confirmEvidence, options, judges);
		const confirmComparison = compareCases(evidenceCaseRows(confirmEvidence, confirmGraded));
		// The required samples per case and arm are the confirmation's declared plan; a flagged case it does not declare
		// still needs --confirm-samples per arm, so its evidence counts as missing.
		const samples = Number(options['confirm-samples'] ?? 3);
		const screenWithFamilies = { ...verdict, caseFamilies: Object.fromEntries(cases.map(c => [c.id, c.family])) };
		confirm = { ...confirmVerdict(confirmComparison, screenWithFamilies, { required: confirmEvidence.required, samples }), comparison: confirmComparison,
			coverage: sampleCoverage(confirmComparison.cases) };
		if (!confirmEvidence.known) {
			confirm = { ...confirm, verdict: 'INCONCLUSIVE', planUnknown: true,
				reasons: [...confirm.reasons, 'the confirmation plan is unknown (a confirmation file declares no plan; pass --confirm-manifest), so it decides nothing'] };
		}
	}
	const judgeLedger = judges.size ? [...judges.values()].map(j => j.ledger).reduce((acc, l) => ({
		config: acc.config ?? l.config, calls: acc.calls + l.calls, cacheHits: acc.cacheHits + l.cacheHits, answersJudged: acc.answersJudged + l.answersJudged,
		costUsd: acc.costUsd + l.costUsd, unknownCostCalls: acc.unknownCostCalls + l.unknownCostCalls, unknownCostReservedUsd: acc.unknownCostReservedUsd + (l.unknownCostReservedUsd ?? 0), failures: acc.failures + l.failures, wallMs: acc.wallMs + l.wallMs,
	}), { config: null, calls: 0, cacheHits: 0, answersJudged: 0, costUsd: 0, unknownCostCalls: 0, unknownCostReservedUsd: 0, failures: 0, wallMs: 0 }) : null;
	const report = buildReport({
		comparison, verdict, confirm, caseDefinitions: cases.filter(c => comparison.cases.some(row => row.id === c.id)), judge: judgeLedger, gradeMs: Date.now() - started,
		candidate: summarizeArm({ ...screenArms[0].run, samples: evidenceSamples(screen).candidate }),
		baseline: screenArms[1] ? summarizeArm({ ...screenArms[1].run, samples: evidenceSamples(screen).baseline }) : null,
		inputs: { cases: options.cases, candidate: options.candidate, baseline: options.baseline ?? null, confirm: confirm ? [options['confirm-candidate'], options['confirm-baseline']] : null,
			screenManifest: options['screen-manifest'] ?? null,
			// The caller's id for this invocation and the bytes it compared, so a caller can tell this report from an older
			// one left in the same output directory.
			runId: options['run-id'] ?? null, sha256: await inputDigests(options),
			confirmManifest: options['confirm-manifest'] ?? null },
		coverageMode,
	});
	const markdown = renderMarkdown(report);
	if (out) {
		await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
		await writeFile(path.join(out, 'report.md'), markdown);
		const gradedRows = [...graded.candidate, ...(graded.baseline ?? [])];
		await writeFile(path.join(out, 'graded-samples.jsonl'), gradedRows.map(({ sample, grade }) => {
			const { __arm, ...rest } = sample;
			return JSON.stringify({ arm: __arm, ...rest, grade: { verdict: grade.verdict === 'needs_judge' ? 'neutral' : grade.verdict, source: grade.source, reason: grade.reason } });
		}).join('\n') + '\n');
		const spot = Number(options['spot-check']);
		if (spot > 0) await writeSpotChecks(path.join(out, 'spot-check'), selectSpotChecks(gradedRows, spot), { renderContext: await loadRenderer() });
	}
	process.stdout.write(markdown);
	return EXIT[report.verdict] ?? 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then(code => { process.exitCode = code; }, error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 2; })
		.finally(() => closeOpenCodeJudgeServer());
}
