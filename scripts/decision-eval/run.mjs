#!/usr/bin/env node
// Decision-eval runner: render each case through this build, ask the play model N times, capture its tool calls
// without executing them, and write a run file for compare.mjs. See coordinator/src/decision-eval/schema.mjs.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (name) => import(pathToFileURL(path.join(repositoryRoot, 'coordinator', 'src', 'decision-eval', name)).href);
const [{ validateCaseFile, DECISION_EVAL_SCHEMA_VERSION }, { renderPrefix, renderWake }, runner, { allocateSamples }] = await Promise.all([
	source('schema.mjs'), source('render.mjs'), source('runner.mjs'), source('sources.mjs'),
]);

const USAGE = `Usage: node scripts/decision-eval/run.mjs --cases <file|dir> [options]
  --cases <file|dir>            case JSON file or directory of .json files (repeatable)
  --split train|heldout|all     cases to run (default train)
  --quick                       only cases marked quick
  --ids a,b                     only these case ids
  --limit <n>                   first n cases after filtering
  --samples <n>                 samples per case (default 3)
  --concurrency <n>             provider calls in flight (default 16)
  --provider claude|codex|opencode  play provider (default claude)
  --model <id>                  play model (default claude-opus-5-5)
  --effort <level>              reasoning effort (default low, the gameplay profile)
  --out <file.json>             run file; samples also stream to <file>.jsonl
  --expect-fixture-sha256 <hex|@file>   required for held-out cases; the run refuses a mismatched case set
  --max-calls <n>               cap captured calls per sample (default steps + 4)
  --probe                       diagnostic only: reads, setup and notes get a fixed skip reply and the sample continues
                                to the first world action (not production-faithful; use its own --cache-epoch)
  --budget-usd <x>              stop starting samples once spent cost reaches x (every attempt counts, retries too)
  --budget-ledger <file>        share the budget: each attempt's cost is appended here and the total of the file is
                                checked before every sample, so several runs (arms, stages) share one --budget-usd
  --cache-epoch <text>          part of the cache key; change it to retire cached samples (default 1)
  --import-cache <dir>          reuse samples of an older cache only where build, prefix, wake bytes, profile and
                                view mode provably match (never for multi-step cases); they are re-filed here
  --import-runtime <version>    the provider CLI version the imported cache ran on; must equal today's
  --root <dir>                  runtime directory for provider workspaces (default OS temp)
  --sample-offset <n>           number samples from n (confirm runs use fresh indexes after the screen's)
  --cache-dir <dir>             reuse finished samples of this build, case and model profile; store new ones
  --random-view-id              name observation views with a random id per session, as production does
                                (default: one fixed eval id, so repeated samples read the wake from the prompt cache)
  --cache-report                render, look up the cache, print { cached, missing } as JSON and exit
  --dry-run                     render only; no model calls`;

const { values: args } = parseArgs({
	options: {
		cases: { type: 'string', multiple: true }, split: { type: 'string', default: 'train' }, quick: { type: 'boolean', default: false },
		ids: { type: 'string' }, limit: { type: 'string' }, samples: { type: 'string', default: '3' }, concurrency: { type: 'string', default: '16' },
		provider: { type: 'string', default: runner.DEFAULT_PLAY_PROFILE.provider }, model: { type: 'string' }, effort: { type: 'string', default: runner.DEFAULT_PLAY_PROFILE.effort },
		out: { type: 'string' }, 'expect-fixture-sha256': { type: 'string' }, 'max-calls': { type: 'string' }, probe: { type: 'boolean', default: false }, 'budget-usd': { type: 'string' }, 'budget-ledger': { type: 'string' }, 'cache-epoch': { type: 'string', default: '1' },
		root: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
		'sample-offset': { type: 'string', default: '0' }, 'cache-dir': { type: 'string' }, 'import-cache': { type: 'string' }, 'import-runtime': { type: 'string' }, 'random-view-id': { type: 'boolean', default: false }, 'cache-report': { type: 'boolean', default: false },
	},
});
if (args.help || !args.cases?.length) { console.log(USAGE); process.exit(args.help ? 0 : 2); }
const positive = (value, name) => { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) { console.error(`--${name} must be a positive integer`); process.exit(2); } return number; };
const samples = positive(args.samples, 'samples');
const concurrency = positive(args.concurrency, 'concurrency');
const provider = args.provider;
// "fake" exists for orchestration tests only: DECISION_EVAL_FAKE_PROVIDER names a module whose answer({ caseId, sample,
// arm, stage }) returns { calls, error } for each sample. No model is called.
const fakeProvider = provider === 'fake' && process.env.DECISION_EVAL_FAKE_PROVIDER ? (await import(pathToFileURL(path.resolve(process.env.DECISION_EVAL_FAKE_PROVIDER)).href)).answer : null;
if (!['claude', 'codex', 'opencode'].includes(provider) && fakeProvider === null) { console.error('--provider must be claude, codex or opencode'); process.exit(2); }
const model = args.model ?? (provider === 'codex' ? null : provider === 'opencode' ? 'opencode/deepseek-v4.1-flash-free' : runner.DEFAULT_PLAY_PROFILE.model);
// The fake provider renders exactly what a Claude session would receive.
const renderProvider = fakeProvider !== null ? 'claude' : provider;
if (model === null) { console.error('--model is required for codex'); process.exit(2); }
const effort = args.effort;
const budgetUsd = args['budget-usd'] === undefined ? Infinity : Number(args['budget-usd']);
if (!(budgetUsd > 0) || Number.isNaN(budgetUsd)) { console.error('--budget-usd must be a positive number'); process.exit(2); }
const maxCalls = args['max-calls'] === undefined ? null : positive(args['max-calls'], 'max-calls');
const budgetLedger = args['budget-ledger'] === undefined ? null : path.resolve(args['budget-ledger']);
// Spend recorded by every run sharing the ledger, this one included. Within one run, concurrent workers can start
// up to one batch of samples (at most --concurrency) before their costs are recorded.
async function ledgerSpentUsd() {
	if (budgetLedger === null) return null;
	try { return (await readFile(budgetLedger, 'utf8')).split('\n').reduce((sum, line) => sum + (Number(line.split('\t')[0]) || 0), 0); }
	catch { return 0; }
}
const sampleOffset = Number(args['sample-offset']);
if (!Number.isSafeInteger(sampleOffset) || sampleOffset < 0) { console.error('--sample-offset must be a nonnegative integer'); process.exit(2); }
const viewSession = args['random-view-id'] ? null : runner.EVAL_VIEW_SESSION;

/** Case files and the SHA-256 of the case set: each file's bytes hashed, then the sorted name/hash list. */
async function loadCases(inputs) {
	const files = [];
	for (const input of inputs) {
		const resolved = path.resolve(input);
		if ((await stat(resolved)).isDirectory()) {
			for (const name of (await readdir(resolved)).filter((entry) => entry.endsWith('.json')).sort()) files.push(path.join(resolved, name));
		} else files.push(resolved);
	}
	const cases = [];
	const digests = [];
	for (const file of files) {
		const bytes = await readFile(file);
		digests.push(`${path.basename(file)}\0${createHash('sha256').update(bytes).digest('hex')}`);
		cases.push(...validateCaseFile(JSON.parse(bytes.toString('utf8')), path.basename(file)));
	}
	const setSha256 = files.length === 1 ? createHash('sha256').update(await readFile(files[0])).digest('hex')
		: createHash('sha256').update(digests.sort().join('\n')).digest('hex');
	return { files, cases, setSha256 };
}

const percentile = (values, p) => {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

const startedAt = new Date().toISOString();
const { files, cases: loaded, setSha256 } = await loadCases(args.cases);
// An empty --ids is a caller bug (an empty re-ask list), never "all cases".
if (args.ids !== undefined && args.ids.split(',').every((id) => id.trim() === '')) { console.error('--ids is empty'); process.exit(2); }
const ids = args.ids ? new Set(args.ids.split(',').map((id) => id.trim()).filter(Boolean)) : null;
let cases = loaded.filter((entry) => (args.split === 'all' || entry.split === args.split) && (!args.quick || entry.quick === true) && (ids === null || ids.has(entry.id)));
if (args.limit !== undefined) cases = cases.slice(0, positive(args.limit, 'limit'));
if (cases.length === 0) { console.error('no cases selected'); process.exit(2); }
// --samples is the budget per recorded source moment, split across its derived variants (sources.mjs).
const sampleCounts = allocateSamples(cases, samples);
const maxCount = Math.max(...sampleCounts.values());
const inPlan = (testCase, sample) => sample < sampleOffset + sampleCounts.get(testCase.id);
if (cases.some((entry) => entry.split === 'heldout') || args['expect-fixture-sha256'] !== undefined) {
	let expected = args['expect-fixture-sha256'];
	if (expected?.startsWith('@')) expected = (await readFile(expected.slice(1), 'utf8')).trim().split(/\s+/)[0];
	if (expected === undefined) { console.error('held-out cases need --expect-fixture-sha256'); process.exit(3); }
	if (expected.toLowerCase() !== setSha256) { console.error(`refusing: case set SHA-256 ${setSha256} does not match the expected ${expected}`); process.exit(3); }
}

const runRoot = path.resolve(args.root ?? runner.defaultRunRoot(), `${provider}-${Date.now().toString(36)}`);
const prefix = await renderPrefix({ provider: renderProvider, model, reasoningEffort: effort });
const build = await runner.buildFingerprint(repositoryRoot, prefix);
console.error(`build ${build.commit?.slice(0, 12) ?? 'unknown'}${build.dirty ? ' (dirty)' : ''} prefix ${prefix.prefixSha256.slice(0, 12)}; ${cases.length} cases x ${samples} samples, ${provider} ${model} ${effort}`);

// Renders share the process clock, so they run one at a time before any model call.
const renderStarted = performance.now();
const renders = new Map();
const renderErrors = [];
for (const testCase of cases) {
	try { renders.set(testCase.id, await renderWake(testCase, { provider: renderProvider, model, reasoningEffort: effort })); }
	catch (error) { renderErrors.push({ caseId: testCase.id, code: error.code ?? 'RENDER_FAILED', message: String(error.message).slice(0, 512) }); }
}
const renderMs = Math.round(performance.now() - renderStarted);
console.error(`rendered ${renders.size}/${cases.length} cases in ${renderMs} ms${renderErrors.length ? `; ${renderErrors.length} failed` : ''}`);

/**
 * Cached samples are keyed by everything that decides them: the build (commit, dirty diff, rendered prefix), the
 * harness code, the model profile and view-id mode, then per case its full definition and this build's rendered wake.
 */
// Line endings follow core.autocrlf per checkout, so they are not part of any harness identity.
const harnessText = async (name) => (await readFile(path.join(repositoryRoot, 'coordinator', 'src', 'decision-eval', name), 'utf8')).replace(/\r\n/g, '\n');
/**
 * The harness code that decides ANSWERS, not grades: the renderer (what the model receives) and the runner's session
 * protocol version (runner.RUNNER_PROTOCOL, bumped whenever opening a session or sending the wake changes). Grading code
 * (predicates, judge, stats, reports) never invalidates samples. Multi-step cases also depend on how canned replies are
 * chosen, so their case key adds multiStepHarnessSha256.
 */
async function harnessSha256() {
	return createHash('sha256').update(`render.mjs\0${await harnessText('render.mjs')}\0protocol\0${runner.RUNNER_PROTOCOL ?? 'unversioned'}${await openCodeShimText()}`).digest('hex');
}
/** eval.mjs lends the OpenCode transport to builds from before it (decision-eval/provider-shim.json); lent code is part of the answer's identity. */
async function openCodeShimText() {
	let marker;
	try { marker = JSON.parse(await readFile(path.join(repositoryRoot, 'coordinator', 'src', 'decision-eval', 'provider-shim.json'), 'utf8')); } catch { return ''; }
	const texts = await Promise.all(marker.files.map(async (file) => `${file}\0${(await readFile(path.join(repositoryRoot, file), 'utf8')).replace(/\r\n/g, '\n')}`));
	return `\0provider-shim\0${texts.join('\0')}`;
}
const multiStepHarnessSha256 = createHash('sha256').update((await Promise.all(['runner.mjs', 'match.mjs', 'predicates.mjs'].map(async (name) => `${name}\0${await harnessText(name)}`))).join('\0')).digest('hex');
async function dirtyDiffSha256() {
	if (!build.dirty) return '';
	const { execFile } = await import('node:child_process');
	const diff = await new Promise((resolve) => execFile('git', ['diff', 'HEAD', ...runner.HARNESS_PATHSPEC], { cwd: repositoryRoot, maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => resolve(error ? `unreadable ${Date.now()}` : stdout)));
	return createHash('sha256').update(diff).digest('hex');
}
const cacheDir = args['cache-dir'] === undefined || args['dry-run'] ? null : path.resolve(args['cache-dir']);
const runtime = args['dry-run'] ? null : fakeProvider !== null ? { provider: 'fake', command: process.env.DECISION_EVAL_FAKE_PROVIDER, version: 'fake' } : await runner.providerRuntime(provider, { model, effort });
const cacheBuildKey = cacheDir === null ? null : runner.cacheIdentity({
	fingerprint: build.fingerprint, harnessSha256: await harnessSha256(), dirtyDiffSha256: await dirtyDiffSha256(), provider, model, effort, viewSession,
	// Probe answers are not production answers, so they never share a cache entry with them.
	maxCalls, runtime, epoch: args.probe ? `${args['cache-epoch']}:probe` : args['cache-epoch'],
});
// A case's answers depend on its recorded state, its canned steps and the wake this build renders, not on its
// expectations or rubric, so re-authoring grading never invalidates samples.
const caseAnswerKey = (testCase) => createHash('sha256').update(`${JSON.stringify({ state: testCase.state, steps: testCase.steps ?? null })}\n${renders.get(testCase.id).encodedSha256}${testCase.steps?.length ? `\n${multiStepHarnessSha256}` : ''}`).digest('hex').slice(0, 16);
const cacheFile = (testCase) => path.join(cacheDir, cacheBuildKey.slice(0, 24), `${testCase.id}-${caseAnswerKey(testCase)}.jsonl`);
const importDir = args['import-cache'] === undefined ? null : path.resolve(args['import-cache']);
const importedResults = [];
/**
 * Samples of an older cache (an earlier harness version) are reused only when they provably answered the same input:
 * the same build commit and clean tree, the same rendered prefix and wake bytes, the same profile, view-id mode and
 * call limit, sent bytes that matched the render, and no canned steps. The runtime is checked by the caller.
 */
async function importCached(testCase) {
	// The old rows do not name their CLI version, so the caller states it and it must equal today's runtime.
	if (importDir === null || args.probe || testCase.steps?.length || !runtime?.version || args['import-runtime'] !== runtime.version) return [];
	const render = renders.get(testCase.id);
	const rows = [];
	for (const folder of await readdir(importDir).catch(() => [])) {
		const files = (await readdir(path.join(importDir, folder)).catch(() => [])).filter((name) => name.startsWith(`${testCase.id}-`) && name.endsWith('.jsonl'));
		for (const name of files) {
			for (const line of (await readFile(path.join(importDir, folder, name), 'utf8')).split('\n').filter(Boolean)) {
				const row = JSON.parse(line);
				if (row.caseId !== testCase.id || row.error !== null || row.build?.commit !== build.commit || row.build?.dirty === true || build.dirty) continue;
				if (row.rendered?.prefixSha256 !== prefix.prefixSha256 || row.rendered?.encodedSha256 !== render.encodedSha256 || row.rendered?.sentMatches !== true) continue;
				if (row.provider !== provider || row.model !== model || row.effort !== effort || maxCalls !== null) continue;
				if ((viewSession === null) !== (row.viewIdMode === 'random')) continue;
				rows.push({ ...row, importedFrom: path.join(folder, name) });
			}
		}
	}
	return rows;
}
async function readCached(testCase) {
	let rows = [];
	try { rows = (await readFile(cacheFile(testCase), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { /* none yet */ }
	const found = new Map(rows.filter((row) => row.error === null && row.caseId === testCase.id).map((row) => [row.sample, row]));
	for (const row of await importCached(testCase)) {
		if (found.has(row.sample)) continue;
		found.set(row.sample, row);
		importedResults.push(row);
		await mkdir(path.dirname(cacheFile(testCase)), { recursive: true });
		await appendFile(cacheFile(testCase), `${JSON.stringify(row)}\n`);
	}
	return found;
}

function fakeSample(testCase, sample, { calls = [], error = null, costUsd = 0.01 } = {}) {
	return { schemaVersion: DECISION_EVAL_SCHEMA_VERSION, kind: 'decision-eval-sample', caseId: testCase.id, family: testCase.family, causeClass: testCase.causeClass, split: testCase.split,
		sample, provider: 'fake', model, effort, rendered: {}, calls: calls.map((call, index) => ({ index, normalized: null, normalizeError: null, canned: null, ...call })),
		stop: error ? 'error' : 'script_end', text: null, error: error ? { code: error, message: error, rateLimited: false } : null,
		usage: { modelCalls: calls.length || 1, costUsd }, latency: { totalMs: 1 }, grade: null };
}

const outFile = args.out === undefined ? null : path.resolve(args.out);
const streamFile = outFile === null ? null : outFile.replace(/\.json$/i, '') + '.jsonl';
if (outFile !== null) { await mkdir(path.dirname(outFile), { recursive: true }); await writeFile(streamFile, ''); }
const rowBase = (testCase) => ({ build: { commit: build.commit, dirty: build.dirty, fingerprint: build.fingerprint } });
const prefixFields = { instructionsSha256: prefix.instructionsSha256, instructionsBytes: prefix.instructionsBytes, toolsSha256: prefix.toolsSha256, toolsBytes: prefix.toolsBytes, prefixSha256: prefix.prefixSha256 };

const results = [];
for (const failure of renderErrors) {
	const testCase = cases.find((entry) => entry.id === failure.caseId);
	for (let sample = sampleOffset; sample < sampleOffset + sampleCounts.get(testCase.id); sample += 1) results.push({
		schemaVersion: DECISION_EVAL_SCHEMA_VERSION, kind: 'decision-eval-sample', caseId: testCase.id, family: testCase.family, causeClass: testCase.causeClass, split: testCase.split,
		sample, provider, model, effort, ...rowBase(testCase), rendered: { ...prefixFields }, calls: [], stop: 'error', text: null,
		error: { code: failure.code, message: failure.message, rateLimited: false }, usage: null, latency: null, grade: null,
	});
}

let pool = { results: [], wallMs: 0, maxConcurrency: 0, meanConcurrency: 0, rateLimitEvents: [] };
let spentUsd = 0;
const cachedResults = [];
if (!args['dry-run'] && renders.size > 0) {
	// Sample-major order spreads each case's samples across the run, so later samples find the wake in the prompt cache.
	const tasks = [];
	const cached = new Map();
	if (cacheDir !== null) for (const testCase of cases) if (renders.has(testCase.id)) cached.set(testCase.id, await readCached(testCase));
	for (let sample = sampleOffset; sample < sampleOffset + maxCount; sample += 1) {
		for (const testCase of cases) {
			if (!renders.has(testCase.id) || !inPlan(testCase, sample)) continue;
			const hit = cached.get(testCase.id)?.get(sample);
			if (hit !== undefined) cachedResults.push({ ...hit, cached: true });
			else tasks.push({ testCase, sample });
		}
	}
	if (cacheDir !== null) console.error(`cache ${cacheBuildKey.slice(0, 12)}: ${cachedResults.length} of ${cachedResults.length + tasks.length} samples reused`);
	if (args['cache-report']) {
		// missingFirst: samples that will write their wake to the prompt cache (the costly ones), for budget estimates.
		const firstOf = new Map();
		for (const task of tasks) if (!firstOf.has(task.testCase.id)) firstOf.set(task.testCase.id, task.sample);
		console.log(JSON.stringify({ cached: cachedResults.length, missing: tasks.length, missingFirst: firstOf.size, sampleCounts: Object.fromEntries(sampleCounts), cacheBuildKey, build }));
		process.exit(0);
	}
	results.push(...cachedResults);
	const adapter = fakeProvider !== null ? { provider: 'fake', model, effort, async start() {}, async stop() {} } : provider === 'claude'
		? runner.createClaudeAdapter({ model, effort, root: runRoot, viewSession })
		// DECISION_EVAL_OPENCODE_POOL=off starts one OpenCode server per sample instead of sharing pooled servers.
		: provider === 'opencode' ? runner.createOpenCodeAdapter({ model, effort, root: runRoot, viewSession, pooled: process.env.DECISION_EVAL_OPENCODE_POOL !== 'off' })
		: runner.createCodexAdapter({ model, effort, root: runRoot, viewSession });
	if (tasks.length > 0) await adapter.start();
	let done = 0;
	if (cacheDir !== null) await mkdir(path.join(cacheDir, cacheBuildKey.slice(0, 24)), { recursive: true });
	if (tasks.length > 0) try {
		pool = await runner.runPool(tasks, {
			concurrency,
			attempt: async ({ testCase, sample }, { tries }) => {
				const shared = await ledgerSpentUsd();
				if ((shared ?? spentUsd) >= budgetUsd) {
					return { schemaVersion: DECISION_EVAL_SCHEMA_VERSION, kind: 'decision-eval-sample', caseId: testCase.id, family: testCase.family, causeClass: testCase.causeClass, split: testCase.split,
						sample, provider, model, effort, rendered: {}, calls: [], stop: 'error', text: null, error: { code: 'BUDGET_EXHAUSTED', message: `spent ${(shared ?? spentUsd).toFixed(4)} of ${budgetUsd} USD`, rateLimited: false }, usage: null, latency: {}, grade: null };
				}
				const result = fakeProvider !== null ? fakeSample(testCase, sample, await fakeProvider({ caseId: testCase.id, sample, arm: process.env.DECISION_EVAL_ARM ?? null, stage: process.env.DECISION_EVAL_STAGE ?? null }))
					: await runner.runSample(adapter, {
						testCase, rendered: renders.get(testCase.id), sample, sampleId: `de-${testCase.id}-${sample}-${tries}`.slice(0, 120),
						maxCalls, probe: args.probe,
					});
				// Every attempt is billed, including ones the pool retries, so each is recorded.
				spentUsd += result.usage?.costUsd ?? 0;
				if (budgetLedger !== null && (result.usage?.costUsd ?? 0) > 0) await appendFile(budgetLedger, `${result.usage.costUsd}\t${testCase.id}#${sample}\n`);
				return result;
			},
			onResult: (result, index) => {
				done += 1;
				Object.assign(result, rowBase(), { rendered: { ...result.rendered, ...prefixFields } });
				if (streamFile !== null) void appendFile(streamFile, `${JSON.stringify(result)}\n`).catch(() => {});
				if (cacheDir !== null && result.error === null) void appendFile(cacheFile(tasks[index].testCase), `${JSON.stringify(result)}\n`).catch(() => {});
				const call = result.calls[0];
				console.error(`[${done}/${tasks.length}] ${result.caseId}#${result.sample} ${result.stop}${call ? ` ${call.name}` : ''}${result.error ? ` ${result.error.code}` : ''} ${result.latency?.totalMs ?? '-'} ms $${(result.usage?.costUsd ?? 0).toFixed(4)}`);
			},
		});
	} finally { await adapter.stop(); }
	results.push(...pool.results);
}

// Spend, latency and token figures cover the samples this run asked for; reused cached samples are counted apart.
const provided = results.filter((row) => row.usage !== null && row.error?.code !== 'BUDGET_EXHAUSTED' && row.cached !== true);
const inputTokens = provided.reduce((sum, row) => sum + (row.usage?.inputTokens ?? 0), 0);
const cacheReadTokens = provided.reduce((sum, row) => sum + (row.usage?.cachedInputTokens ?? 0), 0);
const stops = {};
for (const row of results) stops[row.stop] = (stops[row.stop] ?? 0) + 1;
const costUsd = provided.reduce((sum, row) => sum + (row.usage?.costUsd ?? 0), 0);
const modelCalls = provided.reduce((sum, row) => sum + (row.usage?.modelCalls ?? 0), 0);
const summary = {
	cases: cases.length, rendered: renders.size, renderErrors, renderMs,
	// Renders are exact production renderings of the reconstructed supported state; these cases had supplied state left out.
	unreplayedStateCases: [...renders.values()].filter((value) => (value.replay?.unreplayed ?? []).length > 0).length,
	// Kinds of supplied state no replay reached, by the first word of each entry (recentResults, taskMemory, continuity).
	unreplayedByKind: [...renders.values()].flatMap((value) => [...new Set((value.replay?.unreplayed ?? []).map((entry) => String(entry).split(/[: ]/)[0]))])
		.reduce((counts, kind) => ({ ...counts, [kind]: (counts[kind] ?? 0) + 1 }), {}),
	samples: results.length, providerSamples: provided.length,
	errors: results.filter((row) => row.error).length, stops,
	cachedSamples: cachedResults.length, importedSamples: importedResults.length, cachedCostUsd: Math.round(cachedResults.reduce((sum, row) => sum + (row.usage?.costUsd ?? 0), 0) * 1e6) / 1e6,
	sampleOffset, viewSession: viewSession === null ? 'random' : 'eval-fixed',
	promptCache: {
		inputTokens, cacheReadTokens, cacheWriteTokens: provided.reduce((sum, row) => sum + (row.usage?.cacheWriteInputTokens ?? 0), 0),
		hitRate: inputTokens ? Math.round((cacheReadTokens / inputTokens) * 1e4) / 1e4 : null,
	},
	wallMs: pool.wallMs, maxConcurrency: pool.maxConcurrency, meanConcurrency: pool.meanConcurrency, rateLimitEvents: pool.rateLimitEvents,
	costUsd: Math.round(costUsd * 1e6) / 1e6, billedCostUsd: Math.round(spentUsd * 1e6) / 1e6, modelCalls, costPerSampleUsd: provided.length ? Math.round((costUsd / provided.length) * 1e6) / 1e6 : null,
	costPerModelCallUsd: modelCalls ? Math.round((costUsd / modelCalls) * 1e6) / 1e6 : null,
	latencyMs: { p50: percentile(provided.map((row) => row.latency?.totalMs), 0.5), p95: percentile(provided.map((row) => row.latency?.totalMs), 0.95) },
	firstCallMs: { p50: percentile(provided.map((row) => row.latency?.firstCallMs), 0.5), p95: percentile(provided.map((row) => row.latency?.firstCallMs), 0.95) },
	bootMs: { p50: percentile(provided.map((row) => row.latency?.bootMs), 0.5), p95: percentile(provided.map((row) => row.latency?.bootMs), 0.95) },
	modelFirstCallMs: { p50: percentile(provided.map((row) => row.latency?.modelFirstCallMs), 0.5), p95: percentile(provided.map((row) => row.latency?.modelFirstCallMs), 0.95) },
	sentMatches: { true: provided.filter((row) => row.rendered?.sentMatches === true).length, false: provided.filter((row) => row.rendered?.sentMatches === false).length },
	sentInstructionsMatch: provided.filter((row) => row.rendered?.sentInstructionsSha256 !== undefined && row.rendered.sentInstructionsSha256 === (prefix.instructions.systemPrompt === undefined ? null : createHash('sha256').update(prefix.instructions.systemPrompt).digest('hex'))).length,
};
const run = {
	schemaVersion: DECISION_EVAL_SCHEMA_VERSION, kind: 'decision-eval-run', startedAt, finishedAt: new Date().toISOString(), build,
	config: { provider, model, effort, samples, sampleCounts: Object.fromEntries(sampleCounts), concurrency, split: args.split, quick: args.quick, casesPaths: files, casesSha256: setSha256, dryRun: args['dry-run'], budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : null, budgetLedger, maxCalls, probe: args.probe, runtime, cacheEpoch: args['cache-epoch'],
		sampleOffset, viewSession: viewSession === null ? 'random' : 'eval-fixed', cacheBuildKey },
	renders: Object.fromEntries([...renders].map(([id, value]) => [id, { inputSha256: value.inputSha256, encodedSha256: value.encodedSha256, inputBytes: value.inputBytes, encodedBytes: value.encodedBytes, trigger: value.trigger, replay: value.replay, ...(value.triggerMismatch ? { triggerMismatch: value.triggerMismatch } : {}) }])),
	results, summary,
};
if (outFile !== null) await writeFile(outFile, `${JSON.stringify(run, null, 1)}\n`);
console.error(JSON.stringify(summary));
process.exit(0);
