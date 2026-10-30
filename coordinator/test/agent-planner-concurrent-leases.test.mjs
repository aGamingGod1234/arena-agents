import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentPlanner, nativeToolLeaseMs } from '../src/agent-planner.mjs';
import { planCountDefault } from '../src/plan-count.mjs';
import { PlanningScheduler } from '../src/planning-scheduler.mjs';

const RECORD = { agentId: 'lease-agent', goalRevision: 1, provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'priority' };
const NAVIGATE = { kind: 'action', actionType: 'navigate', arguments: { timeoutMs: 240_000 } };
const STALE_CANCEL = { kind: 'cancel_action', actionId: 'stale-action', goalRevision: 1 };

test('a rejected stale cancel restores the pending navigation deadline and survives 131 seconds', async (t) => {
	const h = await harness(t);
	const navigation = h.start('navigation', NAVIGATE);
	assert.equal(h.clock.nextDeadline(), 245_000);
	h.clock.advanceTo(1_000);
	const cancel = h.start('cancel', STALE_CANCEL);
	const rejected = assert.rejects(cancel.promise, { code: 'STALE_ACTION' });
	cancel.gate.reject(Object.assign(new Error('stale action'), { code: 'STALE_ACTION' }));
	await rejected;
	assert.equal(h.clock.nextDeadline(), 245_000, 'restore the original absolute deadline, not a fresh navigation budget');
	h.clock.advanceTo(131_000);
	assert.equal(h.options.signal.aborted, false);
	assert.equal(h.scheduler.activeCount, 1);
	h.clock.advanceTo(200_000);
	navigation.gate.resolve({ state: 'SUCCEEDED' });
	await navigation.promise;
	assert.equal(h.clock.nextDeadline(), 325_000, 'provider lease resumes only after all tools settle');
	await h.finish();
});

test('overlapping reads and provider progress cannot extend an older navigation deadline', async (t) => {
	const h = await harness(t);
	const navigation = h.start('navigation', NAVIGATE);
	for (const time of [100_000, 200_000, 244_000]) {
		h.clock.advanceTo(time);
		const read = h.start(`read-${time}`, { kind: 'observe' });
		assert.equal(h.clock.nextDeadline(), Math.min(245_000, time + 130_000));
		read.gate.resolve({ state: 'SUCCEEDED' });
		await read.promise;
		h.options.onProgress({ phase: 'provider' });
		assert.equal(h.clock.nextDeadline(), 245_000);
	}
	const expired = assert.rejects(h.run, { code: 'PLANNING_LEASE_EXPIRED', phase: 'tool', budgetExhausted: false });
	h.clock.advanceTo(245_000);
	await expired;
	assert.equal(h.options.signal.aborted, true);
	navigation.gate.resolve({ state: 'CANCELLED' });
	await navigation.promise;
});

test('a later long tool cannot hide a hung earlier read deadline', async (t) => {
	const h = await harness(t);
	const read = h.start('read', { kind: 'observe' });
	h.clock.advanceTo(1_000);
	const navigation = h.start('navigation', NAVIGATE);
	assert.equal(h.clock.nextDeadline(), 130_000);
	const expired = assert.rejects(h.run, { code: 'PLANNING_LEASE_EXPIRED', phase: 'tool' });
	h.clock.advanceTo(130_000);
	await expired;
	for (const tool of [read, navigation]) tool.gate.resolve({ state: 'CANCELLED' });
	await Promise.all([read.promise, navigation.promise]);
});

test('out-of-order settlements preserve the remaining deadline, first arrival, and provider-only segments', async (t) => {
	const h = await harness(t);
	h.clock.advanceTo(17);
	h.options.onProgress({ phase: 'tool_queued', callId: 'read', toolName: 'observe', requestArrivedAt: 17 });
	h.clock.advanceTo(57);
	const read = h.start('read', { kind: 'observe' }, { requestArrivedAt: 17, queueWaitMs: 40 });
	h.clock.advanceTo(1_000);
	const navigation = h.start('navigation', NAVIGATE);
	assert.equal(h.clock.nextDeadline(), 130_057);
	h.clock.advanceTo(2_000);
	read.gate.resolve({ state: 'SUCCEEDED' });
	await read.promise;
	assert.equal(h.clock.nextDeadline(), 246_000);
	h.clock.advanceTo(3_000);
	const cancel = h.start('cancel', STALE_CANCEL);
	cancel.gate.resolve({ state: 'FAILED' });
	await cancel.promise;
	assert.equal(h.clock.nextDeadline(), 246_000);
	h.clock.advanceTo(200_000);
	navigation.gate.resolve({ state: 'SUCCEEDED' });
	await navigation.promise;
	h.clock.advanceTo(200_023);
	const tail = h.start('tail', { kind: 'observe' });
	h.clock.advanceTo(200_028);
	tail.gate.resolve({ state: 'SUCCEEDED' });
	await tail.promise;
	h.clock.advanceTo(200_035);
	await h.finish();
	const timing = h.planner.getNativeDecisionTiming(RECORD.agentId);
	assert.equal(timing.firstToolRequestLifetimeCount, 1);
	assert.equal(timing.firstToolRequestP50Ms, 17);
	assert.equal(timing.firstUsableToolP50Ms, 2_000);
	assert.equal(timing.count, 2);
	assert.equal(timing.p50Ms, 17);
	assert.equal(timing.p95Ms, 23);
	assert.deepEqual(h.rows.filter(row => row.event === 'native_decision_timing').map(row => row.fields.segmentDurationMs), [17, 23, 7]);
	assert.equal(h.rows.find(row => row.event === 'native_tool_queue_timing').fields.queueWaitMs, 40);
});

// A 15 s fight the plan promotes to count mode runs the fight_until engine for at least 180 s (ServerActionExecutor
// countFight) plus up to 15 s of drop collection; its lease must not expire at the original call's 20 s.
const BLAZE = 'blaze-uuid-1';
const FIGHT = { kind: 'action', actionType: 'fight_target', arguments: { targetId: BLAZE, timeoutMs: 15_000 } };
const promote = (tool) => planCountDefault(tool, {
	needs: [{ id: 'minecraft:blaze_rod', have: 0, need: 6 }], entities: [{ uuid: BLAZE, type: 'minecraft:blaze' }] }).tool;

test('a fight promoted to count mode by the plan keeps its lease past the original 15 s budget', async (t) => {
	const h = await harness(t, { normalizeTool: promote });
	const fight = h.start('fight', FIGHT);
	assert.equal(h.clock.nextDeadline(), 200_000, '180 s count run + 15 s collect + 5 s settlement grace');
	h.clock.advanceTo(20_000);
	assert.equal(h.options.signal.aborted, false, 'no PLANNING_LEASE_EXPIRED at the unpromoted 20 s');
	h.clock.advanceTo(190_000);
	assert.equal(h.options.signal.aborted, false);
	fight.gate.resolve({ state: 'SUCCEEDED' });
	await fight.promise;
	await h.finish();
});

test('count-mode lease budgets follow the Java engine: promotion to 180 s, cap 600 s, collect default on', () => {
	const lease = (actionType, args) => nativeToolLeaseMs({ kind: 'action', actionType, arguments: args }, 125_000);
	assert.equal(lease('fight_target', { targetId: BLAZE, untilItem: 'minecraft:blaze_rod', untilCount: 6, timeoutMs: 15_000 }), 200_000);
	assert.equal(lease('use_ranged', { targetId: BLAZE, untilItem: 'minecraft:blaze_rod', untilCount: 6, collect: false }), 185_000);
	assert.equal(lease('fight_target', { targetId: BLAZE, untilItem: 'minecraft:blaze_rod', untilCount: 6, timeoutMs: 900_000 }), 620_000);
	assert.equal(lease('fight_until', { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 6 }), 200_000, 'fight_until default 180 s, not the 125 s fallback');
	assert.equal(lease('fight_until', { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 6, timeoutMs: 60_000 }), 80_000);
	assert.equal(lease('fight_target', { targetId: BLAZE, timeoutMs: 15_000 }), 20_000, 'a single fight keeps its own budget');
});

async function harness(t, { normalizeTool = null } = {}) {
	const clock = fakeClock();
	const scheduler = new PlanningScheduler({ maxConcurrent: 1, maxPending: 0, ...clock });
	const ready = deferred();
	const turn = deferred();
	const gates = new Map();
	const rows = [];
	const agent = { async setGoalRevision() {}, act(_input, options) { ready.resolve(options); return turn.promise; } };
	const planner = new AgentPlanner({
		registry: { assertCurrentRevision: () => RECORD, get: () => RECORD, setState() {} },
		scheduler, now: clock.now,
		codexService: { async createAgent() { return agent; }, getAgent() { return agent; } },
		nativeTimingSink: (event, fields) => rows.push({ event, fields }),
	});
	const run = planner.requestNativeTurn({ agentId: RECORD.agentId, goalRevision: RECORD.goalRevision, input: 'navigate',
		executeTool: request => gates.get(request.callId).promise, normalizeTool });
	// Attach immediately so a failing deadline assertion still cleans up without an unhandled rejection.
	run.catch(() => {});
	const options = await ready.promise;
	t.after(async () => {
		for (const gate of gates.values()) gate.resolve({ state: 'CANCELLED' });
		turn.resolve({ status: 'completed' });
		await run.catch(() => {});
		scheduler.close();
	});
	return {
		clock, scheduler, planner, run, options, rows,
		start(callId, tool, metadata = {}) {
			const gate = deferred();
			gates.set(callId, gate);
			return { gate, promise: options.executeTool({ callId, tool, ...metadata }) };
		},
		async finish() { turn.resolve({ status: 'completed' }); assert.equal((await run).status, 'completed'); },
	};
}

function fakeClock() {
	let now = 0;
	const timers = new Set();
	return {
		now: () => now,
		scheduleTimeout(callback, delay) { const timer = { callback, at: now + delay }; timers.add(timer); return timer; },
		cancelTimeout(timer) { timers.delete(timer); },
		nextDeadline() { return Math.min(...Array.from(timers, timer => timer.at)); },
		advanceTo(target) {
			assert.ok(target >= now);
			for (;;) {
				const next = [...timers].sort((a, b) => a.at - b.at)[0];
				if (!next || next.at > target) break;
				now = next.at;
				timers.delete(next);
				next.callback();
			}
			now = target;
		},
	};
}

function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}
