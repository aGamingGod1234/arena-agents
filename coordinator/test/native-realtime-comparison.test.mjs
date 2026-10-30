import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { NATIVE_REALTIME_WORKLOAD, runNativeRealtimeTrial, summarizeComparison, summarizeNearestRank } from '../src/benchmark/native-realtime-comparison.mjs';

test('nearest-rank summaries retain missing event-dependent measurements', () => {
	assert.deepEqual(summarizeNearestRank([2, null, 4, 1]), {
		count: 3,
		missing: 1,
		min: 1,
		p50: 2,
		p95: 4,
		max: 4,
	});
});

test('paired event metrics never turn an absent baseline into a zero delta', () => {
	const sample = (arm, metrics) => ({
		arm,
		pairingKey: 'pair-1',
		order: arm === 'baseline' ? 1 : 2,
		status: 'passed',
		metrics,
		observed: { nativeEventObserved: arm === 'optimized', bodyContinuity: arm === 'optimized', controllerFollowed: true, bodyActionCount: 2 },
	});
	const summary = summarizeComparison([
		sample('baseline', { preparationLeadMs: null, usefulOverlapMs: null, decisionGapMs: 100, bodyActionDurationMs: 220 }),
		sample('optimized', { preparationLeadMs: 200, usefulOverlapMs: 120, decisionGapMs: 2, bodyActionDurationMs: 220 }),
	]);
	assert.equal(summary.pairedDeltaOptimizedMinusBaselineMs.preparationLeadMs.count, 0);
	assert.equal(summary.pairedDeltaOptimizedMinusBaselineMs.preparationLeadMs.missing, 1);
	assert.equal(summary.pairedDeltaOptimizedMinusBaselineMs.usefulOverlapMs.count, 0);
	assert.equal(summary.pairedDeltaOptimizedMinusBaselineMs.decisionGapMs.p50, -98);
});

test('real executor trial measures explicit successor handoff and body continuity', async () => {
	const baselineLike = await runNativeRealtimeTrial(NativeProgramExecutor, {
		arm: 'baseline',
		repetition: 0,
		actionDurationMs: 220,
		config: { ...NATIVE_REALTIME_WORKLOAD, planningLeadMs: undefined },
		pairingKey: 'pair-1',
		order: 1,
	});
	assert.equal(baselineLike.status, 'passed');
	assert.equal(baselineLike.observed.nativeEventObserved, false);
	assert.equal(baselineLike.observed.preparationTrigger, 'program_completion');
	assert.equal(baselineLike.observed.bodyActionCount, 2);
	assert.equal(baselineLike.observed.controllerFollowed, true);
	assert.ok(baselineLike.metrics.decisionGapMs >= 80, `expected completion-triggered gap, got ${baselineLike.metrics.decisionGapMs}`);
	assert.equal(baselineLike.metrics.usefulOverlapMs, null);

	const optimized = await runNativeRealtimeTrial(NativeProgramExecutor, {
		arm: 'optimized',
		repetition: 0,
		actionDurationMs: 220,
		config: NATIVE_REALTIME_WORKLOAD,
		pairingKey: 'pair-1',
		order: 2,
	});
	assert.equal(optimized.status, 'passed');
	assert.equal(optimized.observed.nativeEventObserved, true);
	assert.equal(optimized.observed.preparationTrigger, 'native_event');
	assert.equal(optimized.observed.bodyContinuity, true);
	assert.ok(optimized.metrics.usefulOverlapMs > 0);
	assert.ok(optimized.metrics.decisionGapMs >= 0,
		`successor handoff gap must be non-negative, got ${optimized.metrics.decisionGapMs}`);
});

test('workload certification needs the expected body commands and successful receipts, not just exhaustion', async () => {
	const trial = (Executor, config = NATIVE_REALTIME_WORKLOAD, arm = 'optimized') => runNativeRealtimeTrial(Executor, {
		arm, repetition: 0, actionDurationMs: 220, config, pairingKey: 'pair-1', order: 1,
	});
	// An executor regression that drops every action but still reports exhaustion.
	class DroppingExecutor {
		async run() { return { state: 'YIELDED', reasonCode: 'PROGRAM_EXHAUSTED', actions: 0, receipts: [] }; }
	}
	const dropped = await trial(DroppingExecutor);
	assert.equal(dropped.status, 'failed');
	assert.ok(dropped.failedChecks.includes('firstCommandsMatchWorkload'));
	assert.ok(dropped.failedChecks.includes('controllerFollowed'));
	// Dispatches the action but its receipt failed.
	class FailedReceiptExecutor {
		async run(record, options, context) {
			await context.executeAction({ action: { type: 'wait', arguments: { durationMs: 1 } } });
			return { state: 'YIELDED', reasonCode: 'PROGRAM_EXHAUSTED', actions: 1, receipts: [{ actionType: 'wait', state: 'FAILED' }] };
		}
	}
	const failedReceipt = await trial(FailedReceiptExecutor);
	assert.equal(failedReceipt.status, 'failed');
	assert.ok(failedReceipt.failedChecks.includes('firstReceiptsSucceeded'));
	// A real executor running an accepted no-op override, or a different command shape, does not certify the workload.
	const noop = await trial(NativeProgramExecutor, { ...NATIVE_REALTIME_WORKLOAD, source: 'program.onUnhandledAttention("continue_and_notify");' });
	assert.equal(noop.status, 'failed');
	const wrongShape = await trial(NativeProgramExecutor, { ...NATIVE_REALTIME_WORKLOAD, source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(5);' });
	assert.equal(wrongShape.status, 'failed');
	assert.ok(wrongShape.failedChecks.includes('firstCommandsMatchWorkload'));

	// Two equally empty arms are not factual parity.
	const droppedBaseline = await trial(DroppingExecutor, NATIVE_REALTIME_WORKLOAD, 'baseline');
	const summary = summarizeComparison([droppedBaseline, { ...dropped, pairingKey: 'pair-1' }]);
	assert.equal(summary.factualParity.pairedOutcomeParityCount, 0);
	// The real default workload in both arms is parity.
	const realBaseline = await trial(NativeProgramExecutor, { ...NATIVE_REALTIME_WORKLOAD, planningLeadMs: undefined }, 'baseline');
	const realOptimized = await trial(NativeProgramExecutor);
	assert.equal(realBaseline.status, 'passed');
	assert.equal(realOptimized.status, 'passed');
	assert.equal(summarizeComparison([realBaseline, realOptimized]).factualParity.pairedOutcomeParityCount, 1);
});

test('a declared two-action workload certifies in both arms through the real executor', async () => {
	const wait = Object.freeze({ type: 'wait', arguments: Object.freeze({ durationMs: 1 }) });
	const config = { ...NATIVE_REALTIME_WORKLOAD, source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1); await player.wait(1);', expectedActions: [wait, wait] };
	const trial = (arm, overrides = {}) => runNativeRealtimeTrial(NativeProgramExecutor, { arm, repetition: 0, actionDurationMs: 220, config: { ...config, ...overrides }, pairingKey: 'pair-1', order: 1 });
	const baseline = await trial('baseline', { planningLeadMs: undefined });
	const optimized = await trial('optimized');
	assert.equal(baseline.status, 'passed', JSON.stringify(baseline.failedChecks));
	assert.equal(optimized.status, 'passed', JSON.stringify(optimized.failedChecks));
	assert.equal(baseline.observed.controllerFollowed, true);
	assert.ok(baseline.metrics.decisionGapMs >= 0);
	assert.equal(summarizeComparison([baseline, optimized]).factualParity.pairedOutcomeParityCount, 1);
	// Declaring two actions but running one still fails.
	const short = await trial('optimized', { source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1);' });
	assert.equal(short.status, 'failed');
});
