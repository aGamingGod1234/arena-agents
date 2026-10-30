import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const agent = { agentId: 'successor-test', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'fast', goalRevision: 1 };
const prefix = 'program.onUnhandledAttention("continue_and_notify");';
const source = duration => `${prefix} await player.wait(${duration});`;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
	for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); }
	assert.ok(predicate(), 'expected runtime transition');
}

function setup(t, options = {}) {
	const sent = [], events = [];
	let current = { ready: true, player: { x: 0, y: 64, z: 0, health: 20, dead: false },
		world: { worldId: 'fixture-world', dimension: 'minecraft:overworld' }, inventory: { items: [], tagCounts: {} }, items: [], entities: [], blocks: [] };
	let samples = 0, callId = 0, programStarts = 0, record = { ...agent };
	const runtime = new NativeToolRuntime({
		bridge: { send: async (type, agentId, payload) => {
			sent.push({ type, agentId, payload });
			if (type === 'action_cancel') queueMicrotask(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: payload.goalRevision, state: 'CANCELLED', reasonCode: 'CANCELLED' }));
		} },
		registry: { get: () => record },
		onProgramEvent: (_record, event) => events.push(event),
		onWorkStarted: () => {
			if (++programStarts === 2) options.beforeHandoff?.({ runtime, record, current });
			return () => {};
		},
		requestObservation: async (_record, { afterEventSequence }) => {
			const sample = ++samples;
			await options.beforeSample?.(sample);
			return { eventSequence: afterEventSequence + 1, observation: structuredClone(current) };
		},
		...options.runtime,
	});
	t.after(() => runtime.disposeAll());
	runtime.updateObservation(record, current, { eventSequence: 1 });
	const call = (name, args = {}) => runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: 'selected-model-turn', callId: String(++callId), tool: normalizeMinecraftToolCall(name, args) }, record);
	const commands = () => sent.filter(entry => entry.type === 'action_command');
	const finish = (command, state = 'SUCCEEDED') => runtime.onActionResult(record, { actionId: command.payload.actionId, goalRevision: command.payload.goalRevision, state, reasonCode: state });
	const queue = async (handle, extra = {}) => call('queueProgram', { afterProgramId: handle.programId, goalRevision: record.goalRevision,
		programVersion: (await call('programStatus', { programId: handle.programId })).programVersion,
		precondition: 'player.state().health > 0', source: source(2), maxActions: 1, timeoutMs: 5000, ...extra });
	return { runtime, sent, events, call, commands, finish, queue, samples: () => samples,
		setObservation: (patch, publish = true) => {
			current = { ...current, ...patch };
			if (publish) runtime.updateObservation(record, current, { eventSequence: 100 + ++samples });
		},
		setGoal: revision => { record = { ...record, goalRevision: revision }; },
	};
}

test('ready successor preserves selected-agent provenance and gets its own bounded budget', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { source: source(1), background: true, maxActions: 1, timeoutMs: 5000 });
	await until(() => run.commands().length === 1);
	const queued = await run.queue(handle, { source: `${prefix} await player.wait(program.parameters().duration);`, parameters: { duration: 2 } });
	assert.equal((await run.call('programStatus')).pendingSuccessor.queueId, queued.pendingSuccessor.queueId);
	run.finish(run.commands()[0]);
	await until(() => run.commands().length === 2);
	assert.equal(run.samples(), 1, 'handoff reuses the authoritative sample consumed after the final result');
	assert.equal(run.events.filter(event => event.event === 'program_ended').length, 0, 'handoff suppresses predecessor planner wake');
	const successor = await run.call('programStatus');
	assert.notEqual(successor.programId, handle.programId);
	assert.equal(successor.maxActions, 1);
	assert.equal(run.commands()[1].payload.arguments.durationMs, 2);
	for (const command of run.commands()) {
		assert.equal(command.payload.provenance.model, agent.model);
		assert.equal(command.payload.provenance.reasoningEffort, agent.reasoningEffort);
		assert.equal(command.payload.provenance.serviceTier, agent.serviceTier);
	}
	run.finish(run.commands()[1]);
	await until(() => run.events.some(event => event.event === 'program_ended'));
	assert.equal((await run.call('programStatus')).reasonCode, 'PROGRAM_EXHAUSTED');
});

test('progress wake supplies enough facts to queue and hand off without a status read or extra sample', async t => {
	const timers = [];
	let now = 0;
	t.mock.method(performance, 'now', () => now);
	const executor = new NativeProgramExecutor({ now: () => now,
		setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { if (timer) timer.cleared = true; },
	});
	const run = setup(t, { runtime: { programExecutor: executor, planningLeadTime: () => 20 } });
	const handle = await run.call('runProgram', { source: `${prefix} for (let i = 0; i < 2; i++) await player.wait(20);`, background: true, timeoutMs: 120_000 });
	await until(() => run.commands().length === 1);
	now = 20; run.finish(run.commands()[0]);
	await until(() => run.commands().length === 2);
	const due = timers.findLast(timer => timer.ms === 0 && !timer.cleared);
	assert.ok(due); due.callback();
	const wake = run.events.find(event => event.event === 'program_planning_due');
	assert.equal(wake.programId, handle.programId);
	assert.equal(wake.status.timing.completedActions, 1);
	assert.equal(wake.status.timing.remainingActions, 1);
	assert.ok(wake.status.timing.averageActionMs >= 0);
	assert.deepEqual(wake.observation.inventory.items, []);
	await run.call('queueProgram', { afterProgramId: wake.programId, goalRevision: wake.goalRevision, programVersion: wake.status.programVersion,
		precondition: 'player.state().health > 0', source: source(2), maxActions: 1, timeoutMs: 5000 });
	run.finish(run.commands()[1]);
	await until(() => run.commands().length === 3);
	assert.equal(run.samples(), 2, 'each predecessor action sampled once; handoff requested no extra sample');
	assert.equal(run.events.some(event => event.event === 'program_ended'), false, 'handoff needs no fresh planner turn');
	assert.equal(run.commands()[2].payload.arguments.durationMs, 2, 'only the selected model authored the successor');
	run.finish(run.commands()[2]);
	await until(() => run.events.some(event => event.event === 'program_ended'));
	const result = run.events.find(event => event.event === 'program_ended').result;
	assert.equal(result.timing.completedActions, 1);
	assert.equal(result.freshness.fresh, true);
});

test('body stays reserved during fresh successor prerequisite sampling', async t => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const run = setup(t, { beforeSample: sample => sample === 2 ? gate : undefined,
		beforeHandoff: ({ runtime, record, current }) => runtime.updateObservation(record, current, { eventSequence: 50 }) });
	const handle = await run.call('runProgram', { source: source(1), background: true });
	await until(() => run.commands().length === 1);
	await run.queue(handle);
	run.finish(run.commands()[0]);
	await until(() => run.events.length === 0 && !run.runtime.hasProgram(agent, handle.programId));
	assert.equal((await run.call('wait', { durationMs: 9 })).reasonCode, 'WAIT_ELAPSED', 'a wait watches the successor without taking the body');
	assert.equal(run.commands().length, 1);
	assert.equal((await run.call('programStatus')).state, 'PREPARING');
	release();
	await until(() => run.commands().length === 2);
});

test('successor reuses a post-result push without requesting another sample', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { source: source(1), background: true });
	await until(() => run.commands().length === 1);
	await run.queue(handle);
	run.finish(run.commands()[0]);
	run.setObservation({ player: { x: 2, y: 64, z: 0, health: 20, dead: false } });
	await until(() => run.commands().length === 2);
	assert.equal(run.samples(), 1, 'only the test publication advances the sample counter');
	assert.equal(run.commands()[1].payload.provenance.eventSequence, 101);
});

test('a pre-result publication alone cannot authorize successor handoff', async t => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	let requested = false;
	const run = setup(t, { beforeSample: () => { requested = true; return gate; } });
	const handle = await run.call('runProgram', { source: source(1), background: true });
	await until(() => run.commands().length === 1);
	await run.queue(handle);
	run.setObservation({ player: { x: 2, y: 64, z: 0, health: 20, dead: false } });
	run.finish(run.commands()[0]);
	await until(() => requested);
	assert.equal(run.commands().length, 1);
	release();
	await until(() => run.commands().length === 2);
	assert.equal(run.samples(), 2, 'one pre-result publication and one authoritative post-result request');
});

test('reused successor facts still reject remembered sections and a false authored prerequisite', async t => {
	for (const patch of [{ continuity: { rememberedSections: ['inventory'] } }, { player: { x: 0, y: 64, z: 0, health: 8, dead: false } }]) {
		const run = setup(t);
		const handle = await run.call('runProgram', { source: source(1), background: true });
		await until(() => run.commands().length === 1);
		await run.queue(handle, { precondition: 'player.state().health >= 10' });
		run.finish(run.commands()[0]);
		run.setObservation(patch);
		await until(() => run.events.some(event => event.event === 'program_handoff_rejected'));
		assert.equal(run.commands().length, 1);
		assert.equal(run.samples(), 1);
		assert.equal(run.events.at(-1).result.reasonCode, patch.continuity ? 'FRESH_OBSERVATION_REQUIRED' : 'SUCCESSOR_PRECONDITION_FALSE');
	}
});

test('world or lifecycle changes while acquiring handoff ownership cannot reuse predecessor proof', async t => {
	for (const change of ['world', 'goal', 'lifecycle']) {
		const run = setup(t, { beforeHandoff: ({ runtime, record, current }) => {
			if (change === 'lifecycle') void runtime.dispose(record.agentId, 'goal_stopped');
			else if (change === 'goal') run.setGoal(2);
			else runtime.updateObservation(record, { ...current, world: { ...current.world, dimension: 'minecraft:the_nether' } }, { eventSequence: 50 });
		} });
		const handle = await run.call('runProgram', { source: source(1), background: true });
		await until(() => run.commands().length === 1);
		await run.queue(handle);
		run.finish(run.commands()[0]);
		await tick(); await tick(); await tick();
		assert.equal(run.commands().length, 1);
		assert.equal(run.events.some(event => event.event === 'program_handoff_started'), false);
	}
});

test('cancelled handoff sample cannot emit a stale planner wake over replacement work', async t => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const run = setup(t, { beforeSample: sample => sample === 2 ? gate : undefined,
		beforeHandoff: ({ runtime, record, current }) => runtime.updateObservation(record, current, { eventSequence: 50 }) });
	const handle = await run.call('runProgram', { source: source(1), background: true });
	await until(() => run.commands().length === 1);
	await run.queue(handle);
	run.finish(run.commands()[0]);
	await until(() => !run.runtime.hasProgram(agent, handle.programId));
	const reserved = await run.call('programStatus');
	await run.call('cancelProgram', { programId: reserved.programId, goalRevision: 1 });
	const replacement = await run.call('runProgram', { source: source(3), background: true });
	await until(() => run.commands().length === 2);
	const before = run.events.length;
	release();
	await tick(); await tick();
	assert.ok(run.events.slice(before).every(event => event.event === 'program_planning_due' && event.programId === replacement.programId), 'only the current replacement may emit a preparation advisory');
	assert.equal(run.events.some(event => event.event === 'program_handoff_rejected'), false);
	assert.equal((await run.call('programStatus')).programId, replacement.programId);
	assert.equal(run.commands().length, 2);
});

test('guard uses newly sampled raw facts and fails closed on truthy non-booleans', async t => {
	for (const precondition of ['player.state().health >= 10', 'player.state().health']) {
		const run = setup(t);
		const handle = await run.call('runProgram', { source: source(1), background: true });
		await until(() => run.commands().length === 1);
		await run.queue(handle, { precondition });
		run.setObservation({ player: { x: 0, y: 64, z: 0, health: 8, dead: false } }, false);
		run.finish(run.commands()[0]);
		await until(() => run.events.some(event => event.event === 'program_handoff_rejected'));
		assert.equal(run.commands().length, 1);
		assert.equal(run.events.at(-1).result.reasonCode, 'SUCCESSOR_PRECONDITION_FALSE');
		assert.equal((await run.call('programStatus')).reasonCode, 'SUCCESSOR_PRECONDITION_FALSE');
	}
});

test('queue replacement and withdrawal use exact identities and leave predecessor running', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { source: source(1), background: true });
	await until(() => run.commands().length === 1);
	const first = await run.queue(handle);
	await assert.rejects(run.queue(handle, { precondition: 'await player.wait(1)' }), { code: 'INVALID_PROGRAM_PRECONDITION' });
	assert.equal((await run.call('programStatus')).pendingSuccessor.queueId, first.pendingSuccessor.queueId);
	const second = await run.queue(handle, { source: source(4) });
	await assert.rejects(run.call('cancelQueuedProgram', { afterProgramId: handle.programId, goalRevision: 1, queueId: first.pendingSuccessor.queueId }), { code: 'STALE_PROGRAM_QUEUE' });
	assert.equal((await run.call('programStatus')).pendingSuccessor.queueId, second.pendingSuccessor.queueId);
	await run.call('cancelQueuedProgram', { afterProgramId: handle.programId, goalRevision: 1, queueId: second.pendingSuccessor.queueId });
	assert.equal(run.sent.some(entry => entry.type === 'action_cancel'), false);
	run.finish(run.commands()[0]);
	await until(() => run.events.some(event => event.event === 'program_ended'));
	assert.equal(run.commands().length, 1);
});

test('world roundtrip during async note admission cannot resurrect a stale successor', async t => {
	let release, lookupStarted = false;
	const gate = new Promise(resolve => { release = resolve; });
	const run = setup(t, { runtime: { memoryOperation: async () => { lookupStarted = true; await gate; return { entries: [{ key: 'routine', text: source(2) }], nextOffset: null }; } } });
	const handle = await run.call('runProgram', { source: source(1), background: true });
	await until(() => run.commands().length === 1);
	const admission = run.queue(handle, { source: undefined, noteKey: 'routine' });
	const rejected = assert.rejects(admission, { code: 'STALE_PROGRAM' });
	await until(() => lookupStarted);
	run.setObservation({ world: { worldId: 'fixture-world', dimension: 'minecraft:the_nether' } });
	run.setObservation({ world: { worldId: 'fixture-world', dimension: 'minecraft:overworld' } });
	release();
	await rejected;
	assert.equal((await run.call('programStatus')).pendingSuccessor, undefined);
});

test('death, dimension changes and changed goals discard queued work', async t => {
	for (const patch of [{ ready: false, player: { dead: true } }, { world: { worldId: 'fixture-world', dimension: 'minecraft:the_nether' } }, null]) {
		const run = setup(t);
		const handle = await run.call('runProgram', { source: source(1), background: true });
		await until(() => run.commands().length === 1);
		await run.queue(handle);
		if (patch) run.setObservation(patch);
		else run.setGoal(2);
		run.finish(run.commands()[0]);
		await tick(); await tick(); await tick();
		assert.equal(run.commands().length, 1);
		assert.equal(run.events.some(event => event.event === 'program_handoff_started'), false);
	}
});

test('a failure the program tolerated still hands off to its queued successor', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { source: `${prefix} for (let i = 0; i < 70; i++) { await player.wait(1); }`, background: true, maxActions: 71, timeoutMs: 5000 });
	await until(() => run.commands().length === 1);
	await run.queue(handle);
	for (let i = 0; i < 70; i++) {
		await until(() => run.commands().length === i + 1);
		run.finish(run.commands()[i], i === 0 ? 'FAILED' : 'SUCCEEDED');
	}
	await until(() => run.commands().length === 71);
	assert.equal(run.commands()[70].payload.arguments.durationMs, 2, 'the model-authored successor started');
	assert.equal(run.events.some(event => event.event === 'program_ended'), false, 'handoff needs no planner wake');
	const handoff = run.events.find(event => event.event === 'program_handoff_started');
	assert.equal(handoff.predecessorProgramId, handle.programId);
	assert.equal(handoff.predecessorActionsFailed, 1);
});

async function plannedTail(t) {
	const timers = [];
	let now = 0;
	t.mock.method(performance, 'now', () => now);
	const executor = new NativeProgramExecutor({ now: () => now,
		setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { if (timer) timer.cleared = true; },
	});
	const run = setup(t, { runtime: { programExecutor: executor, planningLeadTime: () => 20 } });
	const handle = await run.call('runProgram', { source: `${prefix} for (let i = 0; i < 2; i++) await player.wait(20);`, background: true, timeoutMs: 120_000 });
	await until(() => run.commands().length === 1);
	now = 20; run.finish(run.commands()[0]);
	await until(() => run.commands().length === 2);
	timers.findLast(timer => timer.ms === 0 && !timer.cleared).callback();
	assert.ok(run.events.some(event => event.event === 'program_planning_due'));
	return { run, handle };
}

test('a runProgram sent after the planning notice starts the moment the program ends naturally', async t => {
	const { run, handle } = await plannedTail(t);
	const next = run.call('runProgram', { source: source(3), background: true, maxActions: 1, timeoutMs: 5000 });
	await tick(); await tick();
	assert.equal(run.commands().length, 2, 'the current program keeps the body until it ends');
	run.finish(run.commands()[1]);
	await until(() => run.commands().length === 3);
	assert.equal(run.commands()[2].payload.arguments.durationMs, 3);
	const result = await next;
	assert.equal(result.predecessor.programId, handle.programId);
	assert.equal(result.predecessor.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(run.events.some(event => event.event === 'program_ended'), false, 'the waiting call reports the natural end itself');
});

test('a tail call never starts after a program that did not exhaust', async t => {
	const { run, handle } = await plannedTail(t);
	const next = run.call('runProgram', { source: source(3), background: true, maxActions: 1, timeoutMs: 5000 });
	await tick(); await tick();
	await run.call('cancelProgram', { programId: handle.programId, goalRevision: 1 });
	const result = await next;
	assert.equal(result.state, 'NOT_STARTED');
	assert.equal(result.executed, false);
	assert.equal(run.commands().length, 2);
});

test('opt-in same-target aim and mine stops if aiming fails', async t => {
	const run = setup(t);
	const pending = run.call('mine', { x: 1, y: 64, z: 2, expectedBlockId: 'minecraft:stone', autoAim: true });
	await until(() => run.commands().length === 1);
	assert.equal(run.commands()[0].payload.actionType, 'look_at');
	run.finish(run.commands()[0], 'FAILED');
	assert.equal((await pending).state, 'FAILED');
	assert.equal(run.commands().length, 1);
});

test('short cold background programs emit only their terminal wake', async t => {
	let now = 0;
	t.mock.method(performance, 'now', () => now);
	for (const actions of [1, 2]) {
		const timers = [];
		const executor = new NativeProgramExecutor({ now: () => now,
			setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeoutFn: () => {} });
		const run = setup(t, { runtime: { programExecutor: executor } });
		await run.call('runProgram', { source: `${prefix} for (let i = 0; i < ${actions}; i++) await player.wait(20);`, background: true });
		for (let i = 0; i < actions; i++) {
			await until(() => run.commands().length === i + 1);
			now += 20; run.finish(run.commands()[i]);
		}
		await until(() => run.events.some(event => event.event === 'program_ended'));
		assert.deepEqual(run.events.map(event => event.event), ['program_ended']);
		assert.equal(timers.length, 1, 'no advisory timer is armed beside the fixed deadline');
	}
});

test('a guard reports its outcome even when the model queued a successful successor', async t => {
	const run = setup(t);
	await run.call('runProgram', { standing: { id: 'low', when: 'player.state().health < 10', guard: true },
		source: 'program.onUnhandledAttention("continue_and_notify", { survival: "continue_and_notify" }); await player.wait(1);', maxActions: 1, timeoutMs: 5000 });
	run.setObservation({ player: { x: 0, y: 64, z: 0, health: 8, dead: false } });
	await until(() => run.commands().length === 1);
	const guard = await run.call('programStatus');
	await run.queue(guard);
	run.setObservation({ player: { x: 0, y: 64, z: 0, health: 20, dead: false } });
	run.finish(run.commands()[0]);
	await until(() => run.commands().length === 2);
	const ended = run.events.find(event => event.event === 'program_ended' && event.programId === guard.programId);
	assert.equal(ended.result.standingOrder.id, 'low');
	assert.equal(ended.result.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.ok(ended.result.successorProgramId);
	assert.equal(run.commands()[1].payload.arguments.durationMs, 2);
	run.finish(run.commands()[1]);
	await until(() => run.events.filter(event => event.event === 'program_ended').length === 2);
});


test('the initial runProgram receipt can queue known work without a status call or planning wake', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', {
		source: `${prefix} await player.wait(1); await player.wait(2);`,
		background: true, maxActions: 2, timeoutMs: 5000,
	});
	await until(() => run.commands().length === 1);
	assert.equal(handle.state, 'RUNNING');
	assert.ok(Number.isSafeInteger(handle.programVersion));
	const queued = await run.call('queueProgram', {
		afterProgramId: handle.programId, goalRevision: handle.goalRevision, programVersion: handle.programVersion,
		source: source(3), precondition: 'player.state().health > 0', maxActions: 1, timeoutMs: 5000,
	});
	assert.equal(queued.state, 'QUEUED');
	assert.equal(run.events.some(event => event.event === 'program_planning_due'), false);
	assert.equal(run.commands().length, 1, 'queuing does not choose or start another action');
	// The provider can finish its turn or think elsewhere; only the exact authored work continues.
	run.finish(run.commands()[0]);
	await until(() => run.commands().length === 2);
	assert.equal(run.commands()[1].payload.arguments.durationMs, 2);
	run.finish(run.commands()[1]);
	await until(() => run.commands().length === 3);
	assert.equal(run.commands()[2].payload.arguments.durationMs, 3);
	assert.equal(run.events.filter(event => event.event === 'program_handoff_started').length, 1);
	assert.equal(run.events.some(event => event.event === 'program_ended'), false, 'successful handoff needs no model wake');
	run.finish(run.commands()[2]);
	await until(() => run.events.some(event => event.event === 'program_ended'));
});
