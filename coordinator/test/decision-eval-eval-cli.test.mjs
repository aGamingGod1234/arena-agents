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

test('an error-only screen answers the incomplete cases again and decides on a new complete screen', { timeout: 240_000 }, async () => {
	const { code, summary, log, root } = await runEval('errors');
	try {
		assert.equal(code, 0, log.slice(-3000));
		assert.equal(summary.screenVerdict, 'INCONCLUSIVE');
		assert.deepEqual(summary.stages.map((stage) => stage.name), ['screen', 'redo']);
		assert.equal(summary.stages[1].ids, 6, 'only the six errored cases are asked again');
		assert.equal(summary.stages[1].offset, 3, 'with sample indexes the screen never used');
		assert.equal(summary.newScreen.verdict, 'PASS');
		assert.equal(summary.verdict, 'PASS');
		assert.equal(summary.coverage.errors, 0, 'the new screen is complete');
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a flagged drop is confirmed on fresh samples listed in a manifest', { timeout: 240_000 }, async () => {
	const { code, summary, log, out, root } = await runEval('drop');
	try {
		assert.equal(summary?.screenVerdict, 'INCONCLUSIVE', log.slice(-3000));
		assert.deepEqual(summary.stages.map((stage) => stage.name), ['screen', 'confirm']);
		const manifest = JSON.parse(await readFile(path.join(out, 'confirm-manifest.json'), 'utf8'));
		assert.ok(manifest.required.every((entry) => entry.sample >= 3), 'confirmation samples are fresh indexes');
		assert.equal(summary.confirmation.verdict, 'PASS');
		assert.ok(summary.confirmation.units.every((unit) => unit.complete));
		assert.equal(summary.verdict, 'PASS');
		assert.equal(code, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a confirmation whose required samples errored stays INCONCLUSIVE', { timeout: 240_000 }, async () => {
	const { code, summary, log, root } = await runEval('confirm-missing');
	try {
		assert.equal(summary?.confirmation?.verdict, 'INCONCLUSIVE', log.slice(-3000));
		assert.equal(summary.verdict, 'INCONCLUSIVE');
		assert.equal(code, 3);
		assert.match(summary.confirmation.reasons.join('\n'), /required samples answered and graded/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a budget that cannot fund the screen plus the confirmation reserve stops before asking anything', { timeout: 240_000 }, async () => {
	const { code, log, summary, root } = await runEval('drop', ['--budget-usd', '1'], { DECISION_EVAL_FIRST_SAMPLE_USD: '0.05', DECISION_EVAL_REPEAT_SAMPLE_USD: '0.05' });
	try {
		assert.equal(code, 2);
		assert.equal(summary, null);
		assert.match(log, /insufficient budget: the screen is estimated at \$\d+\.\d+ but --budget-usd 1 leaves \$0\.70 after reserving 30% for confirmation/);
		assert.doesNotMatch(log, /\[screen:candidate\] \[1\//, 'no sample was asked');
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a confirmation the remaining budget cannot fund is skipped with that reason and stays INCONCLUSIVE', { timeout: 240_000 }, async () => {
	// Screen: 216 samples, estimated $1.0 and billed $2.16 by the fake, within 70% of $4. The confirmation of the six
	// flagged cases at 50 samples each is estimated at $2.76, more than the $1.84 left, so it is not launched.
	const { code, summary, log, root } = await runEval('drop', ['--budget-usd', '4', '--confirm-samples', '50'], { DECISION_EVAL_FIRST_SAMPLE_USD: '0.004', DECISION_EVAL_REPEAT_SAMPLE_USD: '0.004' });
	try {
		assert.equal(summary?.screenVerdict, 'INCONCLUSIVE', log.slice(-2000));
		assert.match(summary.stages.find((stage) => stage.name === 'confirm').skipped, /insufficient budget/);
		assert.equal(summary.verdict, 'INCONCLUSIVE');
		assert.equal(code, 3);
		assert.doesNotMatch(log, /\[confirm:candidate\] \[1\//, 'no confirmation sample was launched');
	} finally { await rm(root, { recursive: true, force: true }); }
});

// Sol r7: an output directory reused from an earlier invocation must never lend its report to a run whose own
// comparison failed. Repeating --cases makes the runner write duplicate rows, which compare refuses (exit 2).
