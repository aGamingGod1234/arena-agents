import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The whole eval.mjs flow (screen, redo into a new screen, confirmation with a manifest) on a scripted fake provider:
// no model calls. Both arms run this checkout; the script decides each answer by arm, stage, case and sample.
const evalCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'decision-eval', 'eval.mjs');
const replay = JSON.parse(await readFile(new URL('./fixtures/decision-eval/g1-replay-sample.json', import.meta.url), 'utf8'));
const cases = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((family) => Array.from({ length: 6 }, (_, i) => ({
	id: `${family}${i}`, family: `fam-${family}`, causeClass: 'test', split: 'train',
	state: { observation: replay.observations[0], agent: { goal: replay.goal, goalSpec: replay.goalSpec } },
	expect: { good: [{ tool: 'moveTo' }], bad: [{ tool: 'say' }] },
})));

const MODULE = `
const good = [{ name: 'moveTo', args: { x: 1, y: 64, z: 1 } }];
const bad = [{ name: 'say', args: { message: 'hm' } }];
export async function answer({ caseId, sample, arm, stage }) {
	const scenario = process.env.FAKE_SCENARIO;
	if (scenario === 'fail' && arm === 'candidate' && caseId.startsWith('b')) return { calls: bad };
	if (scenario === 'errors' && stage === 'screen' && arm === 'candidate' && caseId.startsWith('a')) return { error: 'PROVIDER_UNAVAILABLE' };
	if (scenario === 'drop' || scenario === 'confirm-missing') {
		if (stage === 'screen' && arm === 'candidate' && caseId.startsWith('b') && sample < 2 && Number(caseId.slice(1)) < 3) return { calls: bad };
		if (scenario === 'confirm-missing' && stage === 'confirm' && arm === 'candidate') return { error: 'PROVIDER_UNAVAILABLE' };
	}
	return { calls: good };
}
`;

async function runEval(scenario, extra = [], envExtra = {}) {
	const root = await mkdtemp(path.join(tmpdir(), `decision-eval-flow-${scenario}-`));
	const casesFile = path.join(root, 'cases.json');
	const fake = path.join(root, 'fake.mjs');
	await writeFile(casesFile, JSON.stringify(cases));
	await writeFile(fake, MODULE);
	const out = path.join(root, 'out');
	const result = await new Promise((resolve) => execFile(process.execPath, [evalCli, '--baseline', '.', '--cases', casesFile, '--provider', 'fake', '--judge', 'off',
		'--samples', '3', '--concurrency', '8', '--out', out, '--cache-dir', path.join(root, 'cache'), '--budget-usd', '50', ...extra],
	{ timeout: 240_000, env: { ...process.env, DECISION_EVAL_FAKE_PROVIDER: fake, FAKE_SCENARIO: scenario, DECISION_EVAL_FIRST_SAMPLE_USD: '0.01', DECISION_EVAL_REPEAT_SAMPLE_USD: '0.01', ...envExtra } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
	let summary = null;
	try { summary = JSON.parse(await readFile(path.join(out, 'eval.json'), 'utf8')); } catch { /* asserted by the caller */ }
	const log = await readFile(path.join(out, 'eval.log'), 'utf8').catch(() => '');
	return { ...result, summary, log, root, out };
}

// Split from decision-eval-eval-cli.test.mjs so each file stays inside the runner's 60 s per-file timeout on Windows CI.
async function seededRuns(seedScenario, rerunScenario) {
	const root = await mkdtemp(path.join(tmpdir(), `decision-eval-reuse-${seedScenario}-`));
	const casesFile = path.join(root, 'cases.json');
	const fake = path.join(root, 'fake.mjs');
	await writeFile(casesFile, JSON.stringify(cases));
	await writeFile(fake, MODULE);
	const out = path.join(root, 'out');
	const once = (scenario, extraCases) => new Promise((resolve) => execFile(process.execPath, [evalCli, '--baseline', '.', '--cases', casesFile, ...extraCases, '--provider', 'fake',
		'--judge', 'off', '--samples', '3', '--concurrency', '8', '--out', out, '--cache-dir', path.join(root, 'cache'), '--no-confirm', '--spot-check', '0'],
	{ timeout: 240_000, env: { ...process.env, DECISION_EVAL_FAKE_PROVIDER: fake, FAKE_SCENARIO: scenario } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
	const seed = await once(seedScenario, []);
	const seedReport = JSON.parse(await readFile(path.join(out, 'screen', 'report.json'), 'utf8'));
	const rerun = await once(rerunScenario, ['--cases', casesFile]);
	const summary = await readFile(path.join(out, 'eval.json'), 'utf8').then(JSON.parse, () => null);
	const report = await readFile(path.join(out, 'screen', 'report.json'), 'utf8').then(JSON.parse, () => null);
	return { root, casesFile, fake, out, seed, seedReport, rerun, summary, report };
}

for (const [seedScenario, seedCode, rerunScenario] of [['pass', 0, 'fail'], ['fail', 1, 'pass']]) {
	test(`a reused output directory holding a ${seedCode === 0 ? 'PASS' : 'FAIL'} cannot decide a run whose comparison is refused`, { timeout: 480_000 }, async () => {
		const { root, seed, seedReport, rerun, summary, report } = await seededRuns(seedScenario, rerunScenario);
		try {
			assert.equal(seed.code, seedCode, seed.stderr.slice(-2000));
			assert.match(seedReport.inputs.runId, /^[0-9a-f]{16}:screen$/);
			assert.match(rerun.stderr, /\[compare:screen\] refusing: \d+ input problems/);
			assert.equal(rerun.code, 2, `the refused comparison is a run error, not the old verdict
${rerun.stderr.slice(-2000)}`);
			assert.match(rerun.stderr, /screen comparison failed: compare exited 2/);
			assert.equal(summary, null, 'no eval.json: the old one was removed and no new one written');
			assert.equal(report, null, 'the old screen report was removed before the comparison ran');
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}

// The PR entry point checks a commit out into a temporary worktree, so it runs the committed harness: skip when the
// harness under test has uncommitted changes, rather than test stale code.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (args) => new Promise((resolve) => execFile('git', args, { cwd: repoRoot }, (error, stdout) => resolve(error ? null : stdout.trim())));
const harnessDirty = await git(['status', '--porcelain', '--', 'scripts/decision-eval', 'coordinator/src/decision-eval']);
test('the PR script reports a refused comparison as an error even with a reused PASS directory', {
	timeout: 900_000, skip: harnessDirty === null ? 'git unavailable' : harnessDirty !== '' ? 'the decision-eval harness has uncommitted changes; the PR script runs the committed HEAD' : false,
}, async () => {
	const { root, casesFile, fake, out, seed } = await seededRuns('pass', 'pass');
	try {
		assert.equal(seed.code, 0);
		const head = await git(['rev-parse', 'HEAD']);
		const ciCheck = path.join(repoRoot, 'scripts', 'decision-eval', 'ci-check.mjs');
		const pr = await new Promise((resolve) => execFile(process.execPath, [ciCheck, '--base', head, '--head', head, '--cases', casesFile, '--cases', casesFile, '--provider', 'fake',
			'--judge', 'off', '--samples', '3', '--concurrency', '8', '--out', out, '--cache-dir', path.join(root, 'cache'), '--no-confirm', '--spot-check', '0'],
		{ cwd: repoRoot, timeout: 900_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, DECISION_EVAL_FAKE_PROVIDER: fake, FAKE_SCENARIO: 'fail' } },
		(error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: `${stdout}${stderr}` })));
		assert.match(pr.output, /\[compare:screen\] refusing: \d+ input problems/);
		assert.doesNotMatch(pr.output, /verdict PASS/);
		assert.equal(pr.code, 2, pr.output.slice(-3000));
		assert.equal(await readFile(path.join(out, 'eval.json'), 'utf8').catch(() => null), null);
	} finally { await rm(root, { recursive: true, force: true }); }
});
