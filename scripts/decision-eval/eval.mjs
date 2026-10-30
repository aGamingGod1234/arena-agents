#!/usr/bin/env node
// One command for a decision-eval check of a candidate build against a baseline build:
//
//   node scripts/decision-eval/eval.mjs --baseline <checkout|commit> [--candidate <checkout|commit>] [--quick | --preflight]
//        [--split train|heldout] [--cases <file|dir>] [--expect-fixture-sha256 <hex|@file>] [--samples 3]
//        [--confirm-samples 3] [--no-confirm] [--concurrency 32] [--out <dir>] [--cache-dir <dir>] [--cache-candidate]
//        [--judge auto|off] [--judge-max-usd 5] [--judge-provider claude|codex|opencode] [--judge-model <id>] [--judge-effort <level>]
//        [--judge-waits n] [--judge-wait-minutes 20] [--budget-usd <x>] [--provider claude|codex|opencode] [--model <id>] [--effort low]
//        [--ids a,b] [--sample-offset n] [--random-view-id] [--keep-worktrees] [--probe]
//
// Each build renders and runs every case with its OWN production code: a commit is checked out into a temporary
// worktree and this checkout's harness (coordinator/src/decision-eval, scripts/decision-eval/run.mjs) is copied in, so
// the harness's relative imports load that build's coordinator. Both arms are graded here, compared, and an
// INCONCLUSIVE screen re-asks the flagged cases with fresh sample indexes before the final verdict. Baseline samples
// are cached by build fingerprint + harness + case + model profile, so a PR whose baseline did not change only pays
// for the candidate. Writes <out>/eval.json and <out>/eval.md. Exit codes: 0 PASS, 1 FAIL, 3 INCONCLUSIVE (only
// with --no-confirm), 2 usage, setup or run error. The judge is the player's cross-family default unless --judge-provider and
// --judge-model pick one (still from another family). Answers left ungraded (for example a free OpenCode judge's usage
// limit) are graded again up to --judge-waits times, --judge-wait-minutes apart; the judge cache keeps every verdict given.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_DIR = path.join('coordinator', 'src', 'decision-eval');
const RUNNER_SCRIPT = path.join('scripts', 'decision-eval', 'run.mjs');
// The OpenCode transport, lent to builds from before the OpenCode provider (each file only where the build lacks it).
const OPENCODE_SHIM = ['opencode-service.mjs', 'provider-environment.mjs'].map((name) => path.join('coordinator', 'src', name));
const PROVIDER_SHIM_MARKER = path.join(HARNESS_DIR, 'provider-shim.json');
const EXIT = { PASS: 0, FAIL: 1, INCONCLUSIVE: 3 };

const { values: args } = parseArgs({
	options: {
		baseline: { type: 'string' }, candidate: { type: 'string' }, cases: { type: 'string', multiple: true }, split: { type: 'string', default: 'train' },
		quick: { type: 'boolean', default: false }, preflight: { type: 'boolean', default: false }, 'expect-fixture-sha256': { type: 'string' }, samples: { type: 'string' }, 'confirm-samples': { type: 'string' }, 'confirm-reserve': { type: 'string', default: '0.3' }, 'cache-epoch': { type: 'string' }, probe: { type: 'boolean', default: false },
		'import-cache': { type: 'string' }, 'import-runtime': { type: 'string' },
		'no-confirm': { type: 'boolean', default: false }, concurrency: { type: 'string', default: '32' }, out: { type: 'string' }, 'cache-dir': { type: 'string' },
		'cache-candidate': { type: 'boolean', default: false }, judge: { type: 'string', default: 'auto' }, 'judge-max-usd': { type: 'string', default: '5' },
		'allow-same-family-judge': { type: 'boolean', default: false }, 'judge-provider': { type: 'string' }, 'judge-model': { type: 'string' }, 'judge-effort': { type: 'string' }, 'judge-waits': { type: 'string' }, 'judge-wait-minutes': { type: 'string', default: '20' },
		'budget-usd': { type: 'string' }, provider: { type: 'string', default: 'claude' }, model: { type: 'string' }, effort: { type: 'string', default: 'low' },
		'random-view-id': { type: 'boolean', default: false }, 'keep-worktrees': { type: 'boolean', default: false }, 'spot-check': { type: 'string' }, ids: { type: 'string' }, 'sample-offset': { type: 'string', default: '0' },
		help: { type: 'boolean', default: false },
	},
});
if (args.help || !args.baseline) {
	const header = (await readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n').slice(1, 18);
	process.stderr.write(`${header.map((line) => line.replace(/^\/\/ ?/, '')).join('\n')}\n`);
	process.exit(args.help ? 0 : 2);
}
const positive = (value, name) => { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) fail(`--${name} must be a positive integer`); return number; };
// Argument errors exit at once; failures after setup throw, so temporary worktrees are still removed.
function fail(message) { process.stderr.write(`eval: ${message}\n`); process.exit(2); }
function abort(message) { throw new Error(message); }
if (!['train', 'heldout'].includes(args.split)) fail('--split must be train or heldout');
// A free OpenCode eval is judged by the other free OpenCode model (judge.mjs crossFamilyJudge), so it costs nothing.
// --preflight is the quick case list with 4 screen samples instead of 6: an explicitly weaker, cheaper per-push check
// (simulate-verdict.mjs: about 40% detection of a 50-point single-family drop against about 70% for --quick). The
// quick check (6/6) stays the PR gate.
if (args.preflight) args.quick = true;
const mode = args.preflight ? 'preflight' : args.quick ? 'quick' : null;
const samples = positive(args.samples ?? (args.preflight ? '4' : args.quick ? '6' : '3'), 'samples');
// Quick screens are small, so their flagged families are confirmed with six fresh samples (simulate-verdict.mjs).
const confirmSamples = positive(args['confirm-samples'] ?? (args.quick ? '6' : '3'), 'confirm-samples');
const confirmReserve = Number(args['confirm-reserve']);
if (!(confirmReserve >= 0 && confirmReserve < 1)) fail('--confirm-reserve must be a fraction from 0 to below 1');
const concurrency = positive(args.concurrency, 'concurrency');
if (args['judge-provider'] && !['claude', 'codex', 'opencode'].includes(args['judge-provider'])) fail('--judge-provider must be claude, codex or opencode');
// The free OpenCode judge stops at once on its usage limit, which resets within hours, so it waits by default (6 hours).
const judgeWaits = Number(args['judge-waits'] ?? (args['judge-provider'] === 'opencode' || (args.provider === 'opencode' && !args['judge-provider']) ? '18' : '0'));
const judgeWaitMs = Number(args['judge-wait-minutes']) * 60_000;
if (!Number.isSafeInteger(judgeWaits) || judgeWaits < 0) fail('--judge-waits must be a nonnegative integer');
if (!(judgeWaitMs > 0)) fail('--judge-wait-minutes must be a positive number');
const heldout = args.split === 'heldout';
const casePaths = (args.cases ?? [heldout ? process.env.DECISION_EVAL_HELDOUT : path.join(harnessRoot, 'coordinator', 'test', 'fixtures', 'decision-eval', 'train')])
	.map((entry) => entry && path.resolve(entry));
if (casePaths.some((entry) => !entry || !existsSync(entry))) fail(heldout ? 'held-out cases live outside the repo: pass --cases <file> or set DECISION_EVAL_HELDOUT' : `case path not found: ${casePaths.join(', ')}`);
if (heldout && args['expect-fixture-sha256'] === undefined) fail('held-out runs need --expect-fixture-sha256 (the committed coordinator/test/fixtures/decision-eval/heldout.sha256)');
const expectFixture = args['expect-fixture-sha256']?.startsWith('@') ? `@${path.resolve(args['expect-fixture-sha256'].slice(1))}` : args['expect-fixture-sha256'];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(args.out ?? path.join(os.tmpdir(), 'arena-decision-eval', `eval-${stamp}`));
const cacheDir = path.resolve(args['cache-dir'] ?? path.join(os.homedir(), '.cache', 'arena-decision-eval'));
const budgetUsd = args['budget-usd'] === undefined ? null : Number(args['budget-usd']);
if (budgetUsd !== null && !(Number.isFinite(budgetUsd) && budgetUsd > 0)) fail('--budget-usd must be a positive number');
const budgetLedger = path.join(out, 'budget-ledger.tsv');
const firstSample = Number(args['sample-offset']);
if (!Number.isSafeInteger(firstSample) || firstSample < 0) fail('--sample-offset must be a nonnegative integer');
const selectedIds = args.ids ? args.ids.split(',').map((id) => id.trim()).filter(Boolean) : null;
await mkdir(out, { recursive: true });
// This invocation's id. Every comparison report must carry it (with the digests of the files it compared) before eval
// uses it, and the summaries of an earlier invocation in a reused --out are removed first, so nothing stale can decide.
const runId = randomBytes(8).toString('hex');
await Promise.all(['eval.json', 'eval.md'].map((name) => rm(path.join(out, name), { force: true })));
const log = createWriteStream(path.join(out, 'eval.log'), { flags: 'a' });
const say = (line) => { process.stderr.write(`${line}\n`); log.write(`${line}\n`); };
const startedAt = performance.now();
const phases = {};
const timed = async (name, fn) => { const at = performance.now(); try { return await fn(); } finally { phases[name] = Math.round(performance.now() - at); } };

async function git(cwd, ...gitArgs) { return (await execFileAsync('git', gitArgs, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim(); }

async function harnessFiles(root) {
	const directory = path.join(root, HARNESS_DIR);
	const names = existsSync(directory) ? (await readdir(directory)).filter((name) => name.endsWith('.mjs')).sort() : [];
	return [...names.map((name) => path.join(HARNESS_DIR, name)), RUNNER_SCRIPT];
}
async function harnessDigest(root) {
	const hash = createHash('sha256');
	// Checkouts of one commit differ only in line endings (core.autocrlf), so those are not a different harness.
	for (const file of await harnessFiles(root)) hash.update(`${file}\0`).update(existsSync(path.join(root, file)) ? (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n') : 'missing');
	return hash.digest('hex');
}

/** A checkout is used in place when it carries this exact harness; a commit gets a temporary worktree with the harness overlaid. */
const temporaryWorktrees = [];
async function resolveBuild(spec, name) {
	if (existsSync(spec)) {
		const root = path.resolve(await git(path.resolve(spec), 'rev-parse', '--show-toplevel'));
		if (root !== harnessRoot && await harnessDigest(root) !== await harnessDigest(harnessRoot)) {
			abort(`${name} checkout ${root} carries a different decision-eval harness; pass a commit instead (it is checked out into a temporary worktree with this harness)`);
		}
		return { spec, root, commit: await git(root, 'rev-parse', 'HEAD'), temporary: false };
	}
	let commit;
	try { commit = await git(harnessRoot, 'rev-parse', '--verify', `${spec}^{commit}`); } catch { abort(`${name}: ${spec} is neither a checkout nor a commit`); }
	const root = path.join(os.tmpdir(), 'arena-decision-eval', 'worktrees', `${name}-${commit.slice(0, 10)}-${randomBytes(3).toString('hex')}`);
	await mkdir(path.dirname(root), { recursive: true });
	await git(harnessRoot, 'worktree', 'add', '--detach', root, commit);
	temporaryWorktrees.push(root);
	for (const file of await harnessFiles(harnessRoot)) {
		await mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await copyFile(path.join(harnessRoot, file), path.join(root, file));
	}
	// A build from before the OpenCode provider has no OpenCode transport. Its own instructions, tools and rendering still
	// decide the prompt; only the transport files it lacks are lent from this checkout. They are hidden from the build's
	// dirty check and listed in PROVIDER_SHIM_MARKER, which run.mjs adds to the sample cache key.
	const providerShim = [];
	if (args.provider === 'opencode') {
		for (const file of OPENCODE_SHIM) {
			const target = path.join(root, file);
			if (existsSync(target) && /opencode/.test(await readFile(target, 'utf8'))) continue;
			const tracked = existsSync(target);
			await copyFile(path.join(harnessRoot, file), target);
			if (tracked) await git(root, 'update-index', '--skip-worktree', file);
			providerShim.push(file);
		}
		if (providerShim.length) await writeFile(path.join(root, PROVIDER_SHIM_MARKER), `${JSON.stringify({ lentFrom: await git(harnessRoot, 'rev-parse', 'HEAD'), files: providerShim })}\n`);
	}
	// Every worktree installs its own locked dependencies; node_modules is never shared.
	await new Promise((resolve, reject) => {
		const child = spawn('npm ci --ignore-scripts --omit=dev --no-audit --no-fund', { cwd: path.join(root, 'coordinator'), shell: true, stdio: ['ignore', 'ignore', 'pipe'] });
		let errorText = '';
		child.stderr.on('data', (chunk) => { errorText += chunk; });
		child.on('error', reject);
		child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`npm ci failed in ${root}: ${errorText.slice(-2000)}`)));
	});
	return { spec, root, commit, temporary: true, providerShim };
}

async function cleanup() {
	if (args['keep-worktrees']) return;
	for (const root of temporaryWorktrees.splice(0)) await git(harnessRoot, 'worktree', 'remove', '--force', root).catch((error) => say(`could not remove worktree ${root}: ${error.message}`));
}

/** Runs one arm through that build's own run.mjs; returns { code, file, run }. */
function runArm(build, { name, file, ids = null, count, offset = 0, cache, armConcurrency, extra = [] }) {
	const runArgs = [path.join(build.root, RUNNER_SCRIPT), ...casePaths.flatMap((entry) => ['--cases', entry]), '--split', args.split,
		...(args.quick ? ['--quick'] : []), ...((ids ?? selectedIds) === null ? [] : ['--ids', (ids ?? selectedIds).join(',')]), '--samples', String(count), '--sample-offset', String(offset),
		'--concurrency', String(armConcurrency), '--provider', args.provider, ...(args.model ? ['--model', args.model] : []), '--effort', args.effort,
		...(expectFixture === undefined ? [] : ['--expect-fixture-sha256', expectFixture]), ...(cache ? ['--cache-dir', cacheDir] : []),
		...(args['cache-epoch'] ? ['--cache-epoch', args['cache-epoch']] : []),
		...(args.probe ? ['--probe'] : []),
		...(cache && args['import-cache'] ? ['--import-cache', path.resolve(args['import-cache']), ...(args['import-runtime'] ? ['--import-runtime', args['import-runtime']] : [])] : []),
		...(args['random-view-id'] ? ['--random-view-id'] : []), ...(file === null ? [] : ['--out', file]), ...extra];
	return new Promise((resolve) => {
		const [stageName, armName] = name.split(':');
		const child = spawn(process.execPath, runArgs, { cwd: build.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECISION_EVAL_STAGE: stageName, DECISION_EVAL_ARM: armName ?? '' } });
		let stdout = '';
		let buffered = '';
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => {
			buffered += chunk;
			const lines = buffered.split('\n');
			buffered = lines.pop();
			for (const line of lines) if (line.trim()) say(`[${name}] ${line.trimEnd()}`);
		});
		child.on('close', async (code) => {
			if (buffered.trim()) say(`[${name}] ${buffered.trimEnd()}`);
			let run = null;
			if (file !== null && code === 0) try { run = JSON.parse(await readFile(file, 'utf8')); } catch { /* reported below */ }
			resolve({ code, file, run, stdout });
		});
	});
}

/** Samples each arm still has to ask for, so concurrency goes where the work is. */
/** What an arm still has to ask (an uncached arm: everything), and how many of those write a new wake to the prompt cache. */
async function missingSamples(build, name, { ids, count, offset, cache }) {
	const report = await runArm(build, { name: `${name}:plan`, file: null, ids, count, offset, cache, armConcurrency: 1, extra: ['--cache-report'] });
	if (report.code !== 0) abort(`${name}: planning lookup failed (exit ${report.code})`);
	return JSON.parse(report.stdout.trim().split('\n').pop());
}

// Measured player prices (Claude Opus 5.5, effort low, eval view id): a case's first fresh sample writes its wake to the
// prompt cache (about $0.07); later samples read it (about $0.02). Estimates add 15%. DECISION_EVAL_FIRST_SAMPLE_USD and
// DECISION_EVAL_REPEAT_SAMPLE_USD override them for another model or for tests.
const FIRST_SAMPLE_USD = Number(process.env.DECISION_EVAL_FIRST_SAMPLE_USD ?? 0.075);
const REPEAT_SAMPLE_USD = Number(process.env.DECISION_EVAL_REPEAT_SAMPLE_USD ?? 0.02);
const estimateUsd = (plans) => Object.values(plans).reduce((sum, plan) => sum + plan.missingFirst * FIRST_SAMPLE_USD + (plan.missing - plan.missingFirst) * REPEAT_SAMPLE_USD, 0) * 1.15;
async function ledgerSpentUsd() {
	try { return (await readFile(budgetLedger, 'utf8')).split('\n').reduce((sum, line) => sum + (Number(line.split('\t')[0]) || 0), 0); }
	catch { return 0; }
}

/**
 * Asks both arms. `stageCap` is the share of the one budget this stage may reach on the shared ledger (the screen stops
 * short of the confirmation reserve). Returns null without asking when the budget cannot fund the stage: the screen
 * refuses to start, a confirmation is skipped with that reason, never launched with no money.
 */
async function runBoth(builds, { stage, ids = null, count, offset, stageCap = budgetUsd }) {
	const dir = path.join(out, stage);
	await mkdir(dir, { recursive: true });
	const plan = { baseline: { cache: true }, candidate: { cache: args['cache-candidate'] } };
	const plans = {};
	for (const arm of ['baseline', 'candidate']) plans[arm] = await missingSamples(builds[arm], arm, { ids, count, offset, cache: plan[arm].cache });
	const estimate = estimateUsd(plans);
	if (budgetUsd !== null) {
		const available = stageCap - await ledgerSpentUsd();
		say(`${stage}: estimated $${estimate.toFixed(2)} for ${plans.baseline.missing + plans.candidate.missing} samples; $${Math.max(0, available).toFixed(2)} available to this stage`);
		if (estimate > available) return { skipped: true, estimate, available, plans };
	}
	const work = { baseline: plans.baseline.missing, candidate: plans.candidate.missing };
	const total = Math.max(1, work.baseline + work.candidate);
	// Both arms together never exceed --concurrency (each asking arm gets at least one slot, so --concurrency 1 runs 1 + 1).
	const baselineShare = work.baseline === 0 ? 1 : work.candidate === 0 ? concurrency : Math.max(1, Math.min(concurrency - 1, Math.round(concurrency * work.baseline / total)));
	const share = (arm) => arm === 'baseline' ? baselineShare : work.candidate === 0 ? 1 : work.baseline === 0 ? concurrency : Math.max(1, concurrency - baselineShare);
	say(`${stage}: baseline ${work.baseline} samples to ask (concurrency ${share('baseline')}), candidate ${work.candidate} (concurrency ${share('candidate')})`);
	// One budget for the whole check: every arm, stage and retry appends its spend to one ledger and stops at its cap.
	const budgetFor = () => budgetUsd === null ? [] : ['--budget-usd', String(stageCap), '--budget-ledger', budgetLedger];
	const [baseline, candidate] = await Promise.all(['baseline', 'candidate'].map((arm) => runArm(builds[arm], {
		name: `${stage}:${arm}`, file: path.join(dir, `${arm}.json`), ids, count, offset, cache: plan[arm].cache, armConcurrency: share(arm), extra: budgetFor(arm),
	})));
	for (const [arm, result] of Object.entries({ baseline, candidate })) if (result.code !== 0 || result.run === null) abort(`${stage} ${arm} run failed (exit ${result.code}); see ${path.join(out, 'eval.log')}`);
	return { baseline, candidate, estimate };
}

const DECIDING = new Map([[0, 'PASS'], [1, 'FAIL'], [3, 'INCONCLUSIVE']]);
const sha256File = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

/**
 * Runs one comparison and returns its report only when it is this invocation's: the child exited with a deciding code
 * (0, 1, 3), the report was written after the previous one was removed, it carries this stage's run id and the digests
 * of exactly the files passed, and its verdict matches the exit code. Anything else is { report: null, error }.
 */
async function compare({ stage, screen = null, confirm = null, manifest = null }) {
	const stageDir = path.join(out, stage);
	await Promise.all(['report.json', 'report.md', 'graded-samples.jsonl'].map((name) => rm(path.join(stageDir, name), { force: true })));
	await rm(path.join(stageDir, 'spot-check'), { recursive: true, force: true });
	const stageRunId = `${runId}:${stage}`;
	const inputs = { candidate: [screen.candidate.file], baseline: [screen.baseline.file],
		...(confirm === null ? {} : { 'confirm-candidate': [confirm.candidate.file], 'confirm-baseline': [confirm.baseline.file] }), ...(manifest === null ? {} : { 'confirm-manifest': [manifest] }) };
	const expected = Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([option, files]) => [option, await Promise.all(files.map(sha256File))])));
	const compareArgs = [path.join(harnessRoot, 'scripts', 'decision-eval', 'compare.mjs'), ...casePaths.flatMap((entry) => ['--cases', entry]), '--run-id', stageRunId,
		'--candidate', screen.candidate.file, '--baseline', screen.baseline.file,
		...(confirm === null ? [] : ['--confirm-candidate', confirm.candidate.file, '--confirm-baseline', confirm.baseline.file, '--confirm-samples', String(confirmSamples)]),
		...(manifest === null ? [] : ['--confirm-manifest', manifest]),
		'--out', path.join(out, stage), '--judge', args.judge,
		...(args['allow-same-family-judge'] ? ['--allow-same-family-judge'] : []),
		...['judge-provider', 'judge-model', 'judge-effort'].flatMap((option) => args[option] ? [`--${option}`, args[option]] : []), '--judge-cache', path.join(cacheDir, 'judge-cache.jsonl'), '--judge-max-usd', args['judge-max-usd'],
		// Held-out wake text and answers never leave the evaluator's machine through spot checks.
		'--spot-check', args['spot-check'] ?? (heldout ? '0' : '12')];
	return new Promise((resolve) => {
		const child = spawn(process.execPath, compareArgs, { cwd: harnessRoot, stdio: ['ignore', 'pipe', 'pipe'] });
		let markdown = '';
		child.stdout.on('data', (chunk) => { markdown += chunk; });
		child.stderr.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim()) say(`[compare:${stage}] ${line.trimEnd()}`); });
		child.on('close', async (code, signal) => {
			if (!DECIDING.has(code)) { resolve({ code, markdown, report: null, error: `compare exited ${code ?? `on signal ${signal}`}` }); return; }
			let report = null;
			try { report = JSON.parse(await readFile(path.join(stageDir, 'report.json'), 'utf8')); } catch { resolve({ code, markdown, report: null, error: 'compare wrote no report' }); return; }
			const problem = report.inputs?.runId !== stageRunId ? `report run id ${report.inputs?.runId ?? 'missing'} is not ${stageRunId}`
				: JSON.stringify(report.inputs?.sha256 ?? null) !== JSON.stringify(expected) ? 'report input digests do not match the files compared'
				: report.verdict !== DECIDING.get(code) ? `report verdict ${report.verdict} does not match exit ${code}` : null;
			resolve(problem === null ? { code, markdown, report } : { code, markdown, report: null, error: problem });
		});
	});
}

const armSummary = (result) => {
	const summary = result.run.summary;
	return {
		build: result.run.build, samples: summary.samples, askedSamples: summary.providerSamples, cachedSamples: summary.cachedSamples ?? 0,
		// A sample is one fresh session asked one moment; it may take several model calls (rejected-call repairs, canned steps).
		modelCalls: summary.modelCalls ?? null, errors: summary.errors, costUsd: summary.costUsd, billedCostUsd: summary.billedCostUsd ?? summary.costUsd,
		cachedCostUsd: summary.cachedCostUsd ?? 0, costPerSampleUsd: summary.costPerSampleUsd,
		wallMs: summary.wallMs, renderMs: summary.renderMs, maxConcurrency: summary.maxConcurrency, meanConcurrency: summary.meanConcurrency,
		rateLimitEvents: summary.rateLimitEvents?.length ?? 0, promptCacheHitRate: summary.promptCache?.hitRate ?? null, latencyMs: summary.latencyMs,
	};
};

/** A screen made of the clean samples of one stage and the fresh samples of another, as a run file per arm. */
async function mergeScreen(stage, keep, replace, replacedIds) {
	const dir = path.join(out, stage);
	await mkdir(dir, { recursive: true });
	const merged = {};
	for (const arm of ['baseline', 'candidate']) {
		const results = [...keep[arm].run.results.filter((row) => !replacedIds.has(row.caseId)), ...replace[arm].run.results];
		// The merged screen declares its plan: the kept cases' planned samples plus the redo stage's planned samples.
		const { declaredIdentities } = await import(pathToFileURL(path.join(harnessRoot, 'coordinator', 'src', 'decision-eval', 'grade.mjs')).href);
		const plannedIdentities = [...(declaredIdentities(keep[arm].run) ?? []).filter((id) => !replacedIds.has(id.caseId)), ...(declaredIdentities(replace[arm].run) ?? [])];
		const file = path.join(dir, `${arm}.json`);
		const summary = { wallMs: (keep[arm].run.summary.wallMs ?? 0) + (replace[arm].run.summary.wallMs ?? 0),
			maxConcurrency: Math.max(keep[arm].run.summary.maxConcurrency ?? 0, replace[arm].run.summary.maxConcurrency ?? 0) };
		await writeFile(file, `${JSON.stringify({ kind: 'decision-eval-run', schemaVersion: 1, build: replace[arm].run.build, config: { plannedIdentities }, results, summary })}\n`);
		merged[arm] = { file, run: { results, summary, config: { plannedIdentities } } };
	}
	return merged;
}

let exitCode = 2;
try {
	say(`decision-eval: baseline ${args.baseline} vs candidate ${args.candidate ?? harnessRoot}; split ${args.split}${mode ? ` (${mode})` : ''}, ${samples} samples; out ${out}`);
	const builds = await timed('setup', async () => ({ baseline: await resolveBuild(args.baseline, 'baseline'), candidate: await resolveBuild(args.candidate ?? harnessRoot, 'candidate') }));
	for (const [arm, build] of Object.entries(builds)) say(`${arm}: ${build.commit.slice(0, 12)} at ${build.root}${build.temporary ? ' (temporary worktree, harness overlaid)' : ''}${build.providerShim?.length ? `; it predates the OpenCode provider, so ${build.providerShim.join(', ')} were lent from this checkout` : ''}`);
	// Every stage asks for sample indexes no earlier stage used, so no sample can count twice.
	let nextOffset = firstSample;
	const stages = [];
	const judgeCost = [];
	const ungraded = (report) => (report.coverage?.ungraded ?? 0) + (report.confirm?.coverage?.ungraded ?? 0);
	const compareStage = async (stage, files, confirm = null, manifest = null) => {
		const once = async () => {
			const result = await timed(`${stage}Compare`, () => compare({ stage, screen: files, confirm, manifest }));
			if (result.report === null) abort(`${stage} comparison failed: ${result.error}`);
			judgeCost.push(result.report.judge?.costUsd ?? 0);
			return result;
		};
		let result = await once();
		// Ungraded answers are a grading outage, not a player result. Cached verdicts are reused, so each wait only pays
		// for the answers still missing; the players are not asked again.
		for (let wait = 1; wait <= judgeWaits && ungraded(result.report) > 0 && args.judge !== 'off'; wait++) {
			const reasons = (await readFile(path.join(out, stage, 'graded-samples.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
				.map((line) => JSON.parse(line).grade).filter((grade) => grade?.source === 'judge-error').map((grade) => grade.reason);
			const limited = reasons.some((reason) => /free usage limit/i.test(reason));
			say(`${stage}: ${ungraded(result.report)} answers ungraded${limited ? ' (judge free usage limit reached)' : reasons[0] ? ` (${reasons[0].slice(0, 160)})` : ''}; waiting ${judgeWaitMs / 60_000} min, then grading again (${wait}/${judgeWaits})`);
			await new Promise((resolve) => setTimeout(resolve, judgeWaitMs));
			result = await once();
		}
		return result;
	};
	const askStage = async (stage, kind, options) => {
		const runs = await timed(stage, () => runBoth(builds, { stage, ...options }));
		if (runs.skipped) {
			stages.push({ name: stage, kind, skipped: `insufficient budget: estimated $${runs.estimate.toFixed(2)}, $${Math.max(0, runs.available).toFixed(2)} available` });
			return runs;
		}
		stages.push({ name: stage, kind, ids: options.ids?.length ?? 'all', offset: options.offset, count: options.count, estimateUsd: Math.round(runs.estimate * 100) / 100,
			arms: { baseline: armSummary(runs.baseline), candidate: armSummary(runs.candidate) } });
		return runs;
	};

	// The screen may use the budget minus the confirmation reserve; it does not start if its estimate does not fit.
	const screenRuns = await askStage('screen', 'screen', { count: samples, offset: nextOffset, stageCap: budgetUsd === null ? null : budgetUsd * (1 - confirmReserve) });
	if (screenRuns.skipped) {
		abort(`insufficient budget: the screen is estimated at $${screenRuns.estimate.toFixed(2)} but --budget-usd ${budgetUsd} leaves $${screenRuns.available.toFixed(2)} after reserving ${Math.round(confirmReserve * 100)}% for confirmation; raise the budget${args.quick ? "" : ", use --quick"} or ask fewer cases (--ids) or --samples`);
	}
	nextOffset += samples;
	let screenFiles = screenRuns;
	let result = await compareStage('screen', screenFiles);
	const firstScreenVerdict = result.report.verdict;
	stages.at(-1).verdict = firstScreenVerdict;
	// Ungraded answers are a grading outage, not a player result: grade once more (cached verdicts are reused).
	if (result.report.coverage?.ungraded > 0 && args.judge !== 'off') {
		say(`screen has ${result.report.coverage.ungraded} ungraded answers; grading again`);
		result = await compareStage('screen-regrade', screenFiles);
	}
	let newScreen = null;
	// Errored samples have no decision: answer those cases again with fresh samples and screen the completed set anew.
	if (result.report.redo?.cases?.length && !args['no-confirm']) {
		const caseIds = result.report.cases.map((row) => row.id);
		const ids = result.report.redo.cases.length > caseIds.length / 2 ? caseIds : result.report.redo.cases;
		say(`screen incomplete: answering ${ids.length} cases again with ${samples} fresh samples per build, then screening the completed set`);
		const redo = await askStage('redo', 'redo', { ids, count: samples, offset: nextOffset });
		nextOffset += samples;
		if (redo.skipped) newScreen = { verdict: 'INCONCLUSIVE', replacedCases: 0, skipped: 'insufficient budget to complete the screen' };
		else {
			screenFiles = await mergeScreen('screen-2', screenFiles, redo, new Set(ids));
			result = await compareStage('screen-2', screenFiles);
			newScreen = { verdict: result.report.verdict, replacedCases: ids.length };
		}
	}
	let confirmation = null;
	if (result.report.verdict === 'INCONCLUSIVE' && result.report.rerun.cases.length && !result.report.redo?.cases?.length && !args['no-confirm']) {
		const ids = result.report.rerun.cases;
		say(`screen INCONCLUSIVE: confirming ${ids.length} cases with ${confirmSamples} fresh samples per source moment (sample indexes from ${nextOffset})`);
		// The manifest follows the runner's split of each source moment's samples across its variants.
		const { loadCases } = await import(pathToFileURL(path.join(harnessRoot, 'coordinator', 'src', 'decision-eval', 'grade.mjs')).href);
		const { allocateSamples } = await import(pathToFileURL(path.join(harnessRoot, 'coordinator', 'src', 'decision-eval', 'sources.mjs')).href);
		const planned = (await Promise.all(casePaths.map((entry) => loadCases(entry, { validate: false })))).flat().filter((c) => ids.includes(c.id));
		const counts = allocateSamples(planned, confirmSamples);
		const required = ['candidate', 'baseline'].flatMap((arm) => ids.flatMap((caseId) => Array.from({ length: counts.get(caseId) ?? confirmSamples }, (_, i) => ({ arm, caseId, sample: nextOffset + i }))));
		const manifest = path.join(out, 'confirm-manifest.json');
		await writeFile(manifest, `${JSON.stringify({ kind: 'decision-eval-confirm-manifest', samples: confirmSamples, required }, null, 1)}\n`);
		const confirm = await askStage('confirm', 'confirm', { ids, count: confirmSamples, offset: nextOffset });
		nextOffset += confirmSamples;
		if (confirm.skipped) {
			confirmation = { verdict: 'INCONCLUSIVE', reasons: [`confirmation not asked: insufficient budget (estimated $${confirm.estimate.toFixed(2)}, $${Math.max(0, confirm.available).toFixed(2)} left)`], units: [], overall: null };
		} else {
			result = await compareStage('final', screenFiles, confirm, manifest);
			confirmation = result.report.confirm;
		}
	}
	// A skipped confirmation leaves the screen's INCONCLUSIVE standing; it never becomes PASS.
	const verdict = confirmation?.units?.length === 0 && confirmation.verdict === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : result.report.verdict;
	const askedStages = stages.filter((stage) => stage.arms);
	const playerCostUsd = askedStages.flatMap((stage) => Object.values(stage.arms)).reduce((sum, arm) => sum + (arm.billedCostUsd ?? 0), 0);
	const judgeCostUsd = judgeCost.reduce((sum, value) => sum + value, 0);
	const playerPhaseMs = stages.reduce((sum, stage) => sum + (phases[stage.name] ?? 0), 0);
	const gradingMs = Object.entries(phases).filter(([name]) => name.endsWith('Compare')).reduce((sum, [, ms]) => sum + ms, 0);
	const summary = {
		kind: 'decision-eval-check', runId, verdict, screenVerdict: firstScreenVerdict, newScreen, confirmation: confirmation === null ? null
			: { verdict: confirmation.verdict, reasons: confirmation.reasons, units: confirmation.units, overall: confirmation.overall },
		split: args.split, quick: args.quick, preflight: args.preflight, samples, confirmSamples,
		builds: Object.fromEntries(Object.entries(builds).map(([arm, build]) => [arm, { spec: build.spec, commit: build.commit, temporary: build.temporary, providerShim: build.providerShim ?? [] }])),
		profile: { provider: args.provider, model: args.model ?? (args.provider === 'opencode' ? 'opencode/deepseek-v4.1-flash-free' : 'claude-opus-5-5'), effort: args.effort, viewSession: args['random-view-id'] ? 'random' : 'eval-fixed' },
		wallMs: Math.round(performance.now() - startedAt), playerPhaseMs, gradingMs, phases, stages,
		samples: { asked: askedStages.flatMap((stage) => Object.values(stage.arms)).reduce((sum, arm) => sum + arm.askedSamples, 0),
			fromCache: askedStages.flatMap((stage) => Object.values(stage.arms)).reduce((sum, arm) => sum + arm.cachedSamples, 0),
			modelCalls: askedStages.flatMap((stage) => Object.values(stage.arms)).reduce((sum, arm) => sum + (arm.modelCalls ?? 0), 0) },
		costUsd: { player: Math.round(playerCostUsd * 1e4) / 1e4, judge: Math.round(judgeCostUsd * 1e4) / 1e4, total: Math.round((playerCostUsd + judgeCostUsd) * 1e4) / 1e4,
			budget: budgetUsd },
		// Families of the final SCREEN (the confirmation, if any, is reported separately above).
		families: (result.report.families ?? []).map((family) => ({ name: family.name, cases: family.cases, sources: family.sources ?? null, decided: family.complete !== false, candidate: family.candidate?.meanCaseRate ?? null,
			baseline: family.baseline?.meanCaseRate ?? null, deltaPts: Number.isFinite(family.meanDelta) ? Math.round(family.meanDelta * 1000) / 10 : null,
			pWorse: family.pWorse ?? null, pWorseHolm: family.pWorseHolm ?? null })),
		continuationCoverage: result.report.continuationCoverage ?? null, uninformativeCases: (result.report.uninformativeCases ?? []).map(c => c.id),
		coverage: result.report.coverage ?? null, coverageMode: result.report.coverageMode ?? null,
		reasons: result.report.reasons ?? [], reports: Object.fromEntries(['screen', 'screen-regrade', 'screen-2', 'final'].filter((stage) => phases[`${stage}Compare`] !== undefined).map((stage) => [stage, path.join(out, stage, 'report.md')])),
	};
	await writeFile(path.join(out, 'eval.json'), `${JSON.stringify(summary, null, 1)}\n`);
	const pct = (value) => value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
	const latency = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : 'n/a';
	const armLine = (stage, arm, value) => `| ${stage} | ${arm} | ${value.askedSamples} | ${value.modelCalls ?? 'n/a'} | ${value.cachedSamples} | $${(value.billedCostUsd ?? 0).toFixed(2)} | ${(value.wallMs / 1000).toFixed(1)} s | ${latency(value.latencyMs?.p50)} / ${latency(value.latencyMs?.p95)} | ${value.maxConcurrency} / ${value.meanConcurrency} | ${pct(value.promptCacheHitRate)} | ${value.errors} |`;
	const markdown = [
		`# Decision eval: ${verdict === 'PASS' && summary.uninformativeCases.length === (result.report.cases?.length ?? 0) && (result.report.cases?.length ?? 0) ? 'UNINFORMATIVE (regression gate PASS)' : verdict}`,
		`Continuation coverage: **${summary.continuationCoverage?.withoutContinuation ?? '?'} / ${summary.continuationCoverage?.total ?? '?'} cases have no continuation**; scripted replies do not execute Minecraft commands.`,
		`${summary.uninformativeCases.length} cases have zero good answers in both arms and are uninformative. A regression gate PASS does not establish successful decisions or gameplay.`, '',
		`Baseline \`${builds.baseline.commit.slice(0, 12)}\` vs candidate \`${builds.candidate.commit.slice(0, 12)}\`, split ${args.split}${mode ? ` (${mode})` : ''}, ${samples} samples per case${confirmation ? `, confirmation ${confirmSamples}` : ''}.`,
		`First screen ${firstScreenVerdict}${newScreen ? `; new screen after answering ${newScreen.replacedCases} incomplete cases again: ${newScreen.verdict}` : ''}${confirmation ? `; confirmation on fresh samples: ${confirmation.verdict}` : ''}. Final: **${verdict}**.`,
		`Wall ${(summary.wallMs / 1000).toFixed(0)} s (asking the model ${(playerPhaseMs / 1000).toFixed(0)} s, grading ${(gradingMs / 1000).toFixed(0)} s). Spend $${summary.costUsd.total.toFixed(2)} (player $${summary.costUsd.player.toFixed(2)} billed, judge $${summary.costUsd.judge.toFixed(2)})${budgetUsd === null ? '' : ` of a $${budgetUsd} player budget`}.`,
		`${summary.samples.asked} samples asked (${summary.samples.modelCalls} model calls), ${summary.samples.fromCache} taken from the cache.`, '',
		'| stage | arm | samples asked | model calls | from cache | billed | wall | p50 / p95 latency | concurrency max / mean | prompt cache read | errors |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
		...stages.flatMap((stage) => stage.arms ? [armLine(stage.name, 'baseline', stage.arms.baseline), armLine(stage.name, 'candidate', stage.arms.candidate)] : [`| ${stage.name} | skipped | ${stage.skipped} | | | | | | | | |`]), '',
		...(heldout ? ['Held-out run: per-case content is kept out of this summary; see the comparison report next to it.', ''] : [result.markdown]),
	].join('\n');
	await writeFile(path.join(out, 'eval.md'), `${markdown}\n`);
	process.stdout.write(`${markdown}\n`);
	say(`verdict ${verdict}; report ${path.join(out, 'eval.md')}`);
	exitCode = EXIT[verdict] ?? 2;
} catch (error) {
	say(`error: ${error.stack ?? error}`);
	exitCode = 2;
} finally {
	await cleanup();
	log.end();
}
process.exitCode = exitCode;
