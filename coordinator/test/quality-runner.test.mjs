import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { pairedTokenConfidence } from '../src/benchmark/quality-metrics.mjs';
import { readArtifactReport } from '../src/benchmark/report-artifacts.mjs';
import { coordinatorFingerprint, instrumentationFingerprint, INSTRUMENTATION_FILES, parseArgs, pairedSchedule, validateArmBuild, runPairedScenarios } from '../../scripts/quality/run-scenarios.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const git = promisify(execFile);
const healthy = () => ({ measurementStatus: 'MEASURED', termination: 'TIMEOUT', providerAttestation: { mismatches: [] }, metrics: { perCallCoverageComplete: true, deaths: 0, modelCallsPerMinute: 10, steadyState: { chargedTokensPerCall: 100, chargedTokensPerMinute: 1000 }, chargedTokensPerCall: 100, chargedTokensPerMinute: 1000, tokenReconciliation: { complete: true }, partialMessagesAccepted: true, rateLimited: false, firstPlayCall: { cacheWarmth: 'warm' } } });
async function fixture() {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-runner-'));
	const arms = {};
	for (const arm of ['A', 'B']) {
		const root = path.join(dir, arm);
		await mkdir(path.join(root, 'coordinator/src'), { recursive: true });
		await mkdir(path.join(root, 'coordinator/config/minecraft-agent'), { recursive: true });
		for (const file of ['src/dynamic-main.mjs', 'config/minecraft-agent/AGENTS.md', 'config/dynamic-agents.json', 'package.json', 'package-lock.json']) await writeFile(path.join(root, 'coordinator', file), arm);
		await writeFile(path.join(root, 'coordinator/src/claude-service.mjs'), '#emitCallUsage(call) { partialMessagesAccepted: true; modelCallId: id; } ARENA_QUALITY_CAPTURE quality_first_message 8192');
		await writeFile(path.join(root, 'coordinator/src/dynamic-main.mjs'), "scope: 'thread_total'; usageSource: 'provider'; nativeUsageTraceFields(value, usageState, usageRecord); ARENA_QUALITY_CAPTURE quality-first-message quality_first_message");
		await writeFile(path.join(root, 'coordinator/src/live-task-view.mjs'), 'export function updateUsage(state) {}');
		await writeFile(path.join(root, 'mod.jar'), arm);
		arms[arm] = { coordinatorRoot: root, jar: path.join(root, 'mod.jar'), commit: arm === 'A' ? 'c6327e81' : 'abcdef00', expectedJarSha256: sha(arm), expectedCoordinatorSha256: await coordinatorFingerprint(root) };
	}
	const armsFile = path.join(dir, 'arms.json'); await writeFile(armsFile, JSON.stringify(arms));
	return { dir, arms, options: { arms: armsFile, out: path.join(dir, 'out'), scenarios: ['S1'], runs: 3 } };
}
function executor(arms, calls, failPair = null) {
	return async options => {
		const arm = options.sourceCommit === arms.A.commit ? 'A' : 'B';
		calls.push({ arm, options });
		return { coordinatorSha256: arms[arm].expectedCoordinatorSha256, jar: { sha256: arms[arm].expectedJarSha256 }, instrumentationSha256: 'fixed', scenarioDataSha256: 'fixed', runs: [{ ...healthy(), scenario: options.scenarios[0], repetition: options.repetition, ...(failPair === options.repetition && arm === 'B' ? { termination: 'ERROR' } : {}) }] };
	};
}
const fakeTiming = () => { let ms = 0; return { now: () => ms, sleep: async gap => { ms += gap; } }; };

test('paired retry and comparison read external call details without losing first attempts', async () => {
	const f = await fixture();
	try {
		const details = Array.from({ length: 80 }, (_, index) => ({ index, text: 'call'.repeat(20) }));
		const first = executor(f.arms, [], 2);
		await runPairedScenarios(f.options, async options => {
			const report = await first(options); report.runs[0].metrics.modelCallDetails = details; return report;
		}, fakeTiming());
		const calls = [];
		await runPairedScenarios({ ...f.options, retryFailed: true }, executor(f.arms, calls), fakeTiming());
		assert.deepEqual(calls.map(c => c.arm), ['B', 'A']);
		const file = path.join(f.options.out, 'results.json'), saved = await readArtifactReport(file);
		assert.deepEqual(saved.history[0].metrics.modelCallDetails, details);
		assert.deepEqual(saved.arms.B.firstAttemptRuns.find(r => r.repetition === 2).metrics.modelCallDetails, details);
		const cli = fileURLToPath(new URL('../../scripts/quality/compare-scenarios.mjs', import.meta.url));
		const { stdout } = await git(process.execPath, [cli, file], { windowsHide: true });
		assert.ok(JSON.parse(stdout).overall);
	} finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('final defaults are eight pairs on only S1, S1-deltas, S5; retry is a flag', () => {
	const options = parseArgs([]);
	assert.equal(options.runs, 8); assert.deepEqual(options.scenarios, ['S1', 'S1-deltas', 'S5']);
	const schedule = pairedSchedule(options.scenarios, options.runs);
	assert.equal(schedule.length, 48);
	for (const arm of ['A', 'B']) assert.equal(schedule.filter(row => row.arm === arm && row.armOrderPosition === 1).length, 12);
	assert.equal(parseArgs(['--arms', 'arms.json', '--retry-failed']).retryFailed, true);
	assert.throws(() => parseArgs(['--retry-failed']), /requires --arms/);
});
test('pins and package/lock fingerprints are enforced before any execution', async () => {
	const f = await fixture();
	try {
		const initial = await coordinatorFingerprint(f.arms.A.coordinatorRoot);
		for (const file of ['package.json', 'package-lock.json']) {
			const target = path.join(f.arms.A.coordinatorRoot, 'coordinator', file);
			await writeFile(target, 'changed'); assert.notEqual(await coordinatorFingerprint(f.arms.A.coordinatorRoot), initial);
			await writeFile(target, 'A');
		}
		await assert.rejects(validateArmBuild({ ...f.arms.A, expectedJarSha256: '0'.repeat(64) }, 'A'), /JAR hash mismatch/);
		await assert.rejects(validateArmBuild({ ...f.arms.A, expectedCoordinatorSha256: '0'.repeat(64) }, 'A'), /coordinator hash mismatch/);
		await assert.rejects(validateArmBuild({ ...f.arms.A, expectedJarSha256: undefined }, 'A'), /expectedJarSha256/);
		await writeFile(f.options.arms, JSON.stringify({ A: f.arms.A, B: f.arms.A }));
		let called = false;
		await assert.rejects(runPairedScenarios(f.options, async () => { called = true; }, fakeTiming()), /identical/);
		assert.equal(called, false);
	} finally { await rm(f.dir, { recursive: true, force: true }); }
});
test('Git builds require a matching HEAD and clean index/worktree', async () => {
	const f = await fixture();
	try {
		const root = f.arms.A.coordinatorRoot, opts = { cwd: root, windowsHide: true };
		await git('git', ['init', '--quiet'], opts);
		await git('git', ['add', '.'], opts);
		await git('git', ['-c', 'user.name=Quality tests', '-c', 'user.email=quality@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'], opts);
		const head = (await git('git', ['rev-parse', 'HEAD'], opts)).stdout.trim();
		assert.equal((await validateArmBuild({ ...f.arms.A, commit: head.slice(0, 8) }, 'A')).gitHead, head);
		await assert.rejects(validateArmBuild({ ...f.arms.A, commit: '1234567' }, 'A'), /HEAD/);
		await writeFile(path.join(root, 'untracked.txt'), 'dirty');
		await assert.rejects(validateArmBuild({ ...f.arms.A, commit: head }, 'A'), /dirty Git tree/);
	} finally { await rm(f.dir, { recursive: true, force: true }); }
});
test('instrumentation includes RCON, recorder and sourced PowerShell helpers', async () => {
	for (const file of ['coordinator/src/headless-rcon.mjs', 'coordinator/src/provider-turn-recorder.mjs', 'scripts/offline-server-policy.ps1', 'scripts/project-metadata.ps1', 'scripts/quality/launch-scenarios.ps1']) assert.ok(INSTRUMENTATION_FILES.includes(file));
	const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-instrumentation-'));
	try {
		for (const file of INSTRUMENTATION_FILES) { const target = path.join(dir, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, 'original'); }
		const before = await instrumentationFingerprint(dir);
		await writeFile(path.join(dir, 'coordinator/src/provider-turn-recorder.mjs'), 'changed');
		assert.notEqual(await instrumentationFingerprint(dir), before);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
test('retry reruns entire failed BA pair, preserving originals, order and fixed gap', async () => {
	const f = await fixture();
	try {
		const first = []; await runPairedScenarios(f.options, executor(f.arms, first, 2), fakeTiming());
		assert.deepEqual(first.map(call => call.arm), ['A', 'B', 'B', 'A', 'A', 'B']);
		const calls = []; await runPairedScenarios({ ...f.options, retryFailed: true }, executor(f.arms, calls), fakeTiming());
		assert.deepEqual(calls.map(call => call.arm), ['B', 'A']);
		assert.deepEqual(calls.map(call => call.options.repetition), [2, 2]);
		const saved = JSON.parse(await readFile(path.join(f.options.out, 'results.json')));
		assert.equal(saved.history.length, 2); assert.equal(saved.sequence.length, 8);
		const retried = saved.arms.B.runs.find(run => run.repetition === 2);
		assert.equal(retried.executionOrder, 3); assert.equal(retried.originalExecutionOrder, 3);
		assert.equal(retried.actualExecutionOrder, 7); assert.equal(retried.retry, true); assert.equal(retried.retryAttempt, 1);
		assert.equal(retried.armOrderPosition, 1); assert.equal(retried.cacheGap.actualMs, 60000);
		assert.ok(calls.every(call => call.options.out.endsWith('attempt-2')));
		const noCalls = []; await runPairedScenarios({ ...f.options, retryFailed: true }, executor(f.arms, noCalls), fakeTiming());
		assert.equal(noCalls.length, 0);
		await assert.rejects(runPairedScenarios(f.options, executor(f.arms, []), fakeTiming()), /fresh output/);
		await assert.rejects(runPairedScenarios({ ...f.options, retryFailed: true, runs: 8 }, executor(f.arms, []), fakeTiming()), /Retry configuration/);
	} finally { await rm(f.dir, { recursive: true, force: true }); }
});
test('retry keeps healthy pairs whose measured first-call warmth did not match', async () => {
	const f = await fixture();
	try {
		const normal = executor(f.arms, []);
		await runPairedScenarios(f.options, async options => {
			const report = await normal(options);
			if (options.sourceCommit === f.arms.B.commit && options.repetition === 1) report.runs[0].metrics.firstPlayCall.cacheWarmth = 'cold';
			return report;
		}, fakeTiming());
		const calls = [];
		await runPairedScenarios({ ...f.options, retryFailed: true }, executor(f.arms, calls), fakeTiming());
		assert.deepEqual(calls, []);
	} finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('interrupted retry cannot reuse a healthy old mate from a different physical execution', async () => {
 const f = await fixture();
 try {
  await runPairedScenarios(f.options, executor(f.arms, []), fakeTiming());
  const file = path.join(f.options.out, 'results.json'), saved = JSON.parse(await readFile(file));
  const mixed = saved.arms.B.runs.find(run => run.repetition === 1);
  mixed.actualExecutionOrder = 99;
  await writeFile(file, JSON.stringify(saved));
  const calls = [];
  await runPairedScenarios({ ...f.options, retryFailed: true }, executor(f.arms, calls), fakeTiming());
  assert.deepEqual(calls.map(call => [call.arm, call.options.repetition]), [['A', 1], ['B', 1]]);
 } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('argument parsing and scheduling refuse more than 40 pairs before any launch', () => {
	assert.equal(parseArgs(['--arms', 'arms.json', '--scenarios', 'S1,S2,S3,S4,S5', '--runs', '8']).scenarios.length, 5);
	assert.throws(() => parseArgs(['--arms', 'arms.json', '--scenarios', 'S1,S2,S3,S4,S5,S6', '--runs', '8']), /40.*pairs/);
	assert.throws(() => pairedSchedule(['S1', 'S2', 'S3', 'S4', 'S5', 'S6'], 8), /40.*pairs/);
});

test('preflight refuses either arm without both trace patches before any execution', async () => {
	const f = await fixture();
	try {
		for (const arm of ['A', 'B']) {
			assert.equal((await validateArmBuild(f.arms[arm], arm)).tracePatchVerified, true);
			for (const file of ['claude-service.mjs', 'dynamic-main.mjs', 'live-task-view.mjs']) {
				const target = path.join(f.arms[arm].coordinatorRoot, 'coordinator/src', file), original = await readFile(target);
				await writeFile(target, 'unpatched');
				const drift = { ...f.arms[arm], expectedCoordinatorSha256: await coordinatorFingerprint(f.arms[arm].coordinatorRoot) };
				await writeFile(f.options.arms, JSON.stringify({ ...f.arms, [arm]: drift }));
				let called = false;
				await assert.rejects(runPairedScenarios(f.options, async () => { called = true; }, fakeTiming()), new RegExp(`Arm ${arm} requires.*trace-schema patches`));
				assert.equal(called, false);
				await writeFile(target, original);
			}
		}
	} finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('retry preserves B-only first-attempt failures in pooled and separate-arm CLI verdicts', async () => {
	const f = await fixture();
	try {
		f.options.runs = 8;
		const execute = failB => async options => {
			const report = await executor(f.arms, [])(options);
			const run = report.runs[0], arm = options.sourceCommit === f.arms.A.commit ? 'A' : 'B';
			Object.assign(report, { harnessCommit: 'h' });
			run.profile = { provider: 'claude' };
			run.definition = { durationBudgetMs: 60000 };
			run.metrics.actionsPerMinute = 10;
			if (arm === 'B') {
				run.metrics.steadyState = { chargedTokensPerCall: 80, chargedTokensPerMinute: 800 };
				if (failB && options.repetition === 1) run.termination = 'ERROR';
			}
			return report;
		};
		await runPairedScenarios(f.options, execute(true), fakeTiming());
		await runPairedScenarios({ ...f.options, retryFailed: true }, execute(false), fakeTiming());
		const saved = JSON.parse(await readFile(path.join(f.options.out, 'results.json')));
		const result = pairedTokenConfidence(saved.arms.A.runs, saved.arms.B.runs, { firstAttemptsBefore: saved.arms.A.firstAttemptRuns, firstAttemptsAfter: saved.arms.B.firstAttemptRuns });
		assert.equal(result.verdict, 'COST_PASS_QUALITY_REGRESSION');
		assert.deepEqual(result.qualityGuards.firstAttemptFailures.B.byTermination, { ERROR: 1 });
		assert.equal(result.qualityGuards.firstAttemptFailures.A.failures, 0);
		assert.equal(saved.history.length, 2);
		const cli = fileURLToPath(new URL('../../scripts/quality/compare-scenarios.mjs', import.meta.url));
		for (const args of [[path.join(f.options.out, 'results.json')], [path.join(f.options.out, 'A.json'), path.join(f.options.out, 'B.json')]]) {
			const { stdout } = await git(process.execPath, [cli, ...args], { windowsHide: true });
			assert.equal(JSON.parse(stdout).overall.verdict, 'COST_PASS_QUALITY_REGRESSION');
		}
		delete saved.arms.A.firstAttemptRuns; delete saved.arms.B.firstAttemptRuns;
		await writeFile(path.join(f.options.out, 'legacy.json'), JSON.stringify(saved));
		const { stdout } = await git(process.execPath, [cli, path.join(f.options.out, 'legacy.json')], { windowsHide: true });
		assert.equal(JSON.parse(stdout).overall.qualityGuards.firstAttemptFailures.B.failures, 1, 'legacy checkpoint reconstructs originals from history and sequence');
		await runPairedScenarios({ ...f.options, retryFailed: true }, execute(false), fakeTiming());
		const again = JSON.parse(await readFile(path.join(f.options.out, 'B.json')));
		assert.equal(again.firstAttemptRuns.filter(run => run.termination === 'ERROR').length, 1, 'second retry retains the original failure');
	} finally { await rm(f.dir, { recursive: true, force: true }); }
});
