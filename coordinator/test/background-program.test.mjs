import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';

const record = { agentId: 'survivor', provider: 'codex', model: 'test', reasoningEffort: 'high', goalRevision: 1 };
const prefix = 'program.onUnhandledAttention("continue_and_notify");';
const observation = (health = 20) => ({ player: { x: 0, y: 64, z: 0, health }, inventory: { items: [], tagCounts: {} }, items: [], entities: [], blocks: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('measured preparation detaches foreground reasoning without a new decision or deadline extension', async t => {
	const timers = new Map(); let timerId = 0;
	const executor = new NativeProgramExecutor({ now: () => 0, setTimeoutFn: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeoutFn: id => timers.delete(id) });
	const events = [];
	const run = setup(t, { programExecutor: executor, planningLeadTime: () => 200,
		onProgramEvent: (_record, event) => events.push(event) });
	const pending = run.call('runProgram', { timeoutMs: 1000, expectedDurationMs: 1000, source: `${prefix} await player.wait(1000); await player.wait(2);` });
	await tick();
	assert.equal(run.commands().length, 1);
	const originalDeadline = [...timers.values()].find(timer => timer.ms === 1000);
	[...timers.values()].find(timer => timer.ms === 800).fn();
	const advisory = await pending;
	assert.equal(advisory.advisory, 'program_planning_due');
	assert.equal(advisory.planningLeadMs, 200);
	assert.equal(advisory.engineState, 'ACTIVE');
	assert.equal(advisory.decision, undefined);
	assert.equal(events.length, 0, 'the returned foreground advisory must not also steer the same caller');
	assert.equal(run.runtime.canPrepareProgram(record, advisory.programId, advisory.programVersion), true);
	assert.equal(run.runtime.canPrepareProgram(record, advisory.programId, advisory.programVersion + 1), false);
	run.finish(run.commands()[0]);
	await tick();
	assert.equal(run.commands().length, 2);
	originalDeadline.fn();
	await tick();
	assert.equal(run.runtime.canPrepareProgram(record, advisory.programId, advisory.programVersion), false);
	run.finish(run.commands()[1], 'CANCELLED');
	await tick();
	assert.equal((await run.call('programStatus')).reasonCode, 'PROGRAM_DEADLINE');
	assert.equal(events.at(-1).event, 'program_ended');
});

function setup(t, overrides = {}) {
	const sent = [];
	let current = observation();
	const runtime = new NativeToolRuntime({
		bridge: { send: async (type, agentId, payload) => sent.push({ type, agentId, payload: validateProtocolV2Payload(type, payload) }) },
		requestObservation: async (_record, { afterEventSequence }) => ({ observation: current, eventSequence: afterEventSequence + 1 }),
		...overrides,
	});
	t.after(() => runtime.disposeAll());
	runtime.updateObservation(record, current, { eventSequence: 1 });
	let callId = 0;
	const call = (name, args = {}, agent = record) => runtime.execute({ agentId: agent.agentId, goalRevision: agent.goalRevision, turnId: 'turn', callId: String(++callId), tool: normalizeMinecraftToolCall(name, args) }, agent);
	const commands = () => sent.filter(entry => entry.type === 'action_command');
	const finish = (command, state = 'SUCCEEDED') => runtime.onActionResult(record, { actionId: command.payload.actionId, goalRevision: 1, state, reasonCode: state });
	return { runtime, sent, call, commands, finish, observe: (health, eventSequence) => {
		current = observation(health);
		runtime.updateObservation(record, current, { eventSequence, attention: true, priority: 'urgent', trigger: 'health_changed' });
	} };
}

test('background watcher reacts after returning control to the model and waits for cancellation acknowledgement', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, timeoutMs: 5000, source: `${prefix}
		program.watch(() => player.state().health < 10, { mode: "interrupt" }, async () => { await player.wait(9); });
		await player.wait(1000);` });
	assert.equal(handle.state, 'RUNNING');
	assert.ok(handle.deadlineEpochMs > Date.now());
	await run.call('observe'); // The model can gather facts while the body routine owns control.
	const watched = await run.call('wait', { durationMs: 1 }); // Watching its own routine leaves the body to the program.
	assert.equal(watched.reasonCode, 'WAIT_ELAPSED');
	assert.equal(watched.program.state, 'RUNNING');
	assert.equal(run.commands().length, 1);
	await tick();
	run.observe(4, 10);
	await tick();
	assert.equal(run.sent.filter(entry => entry.type === 'action_cancel').length, 1);
	assert.equal(run.commands().length, 1, 'watcher must wait for the original input to be released');
	run.finish(run.commands()[0], 'CANCELLED');
	// Real bridge receipts also publish a forced attention wake with no new facts.
	run.runtime.updateObservation(record, observation(4), { eventSequence: 11, attention: true, changedFacts: [], trigger: 'attention' });
	await tick();
	assert.equal(run.commands().length, 2);
	assert.equal(run.commands()[1].payload.arguments.durationMs, 9);
	assert.equal(run.commands()[1].payload.provenance.programId, handle.programId);
	run.finish(run.commands()[1]);
	await tick();
	const result = await run.call('programStatus', { programId: handle.programId });
	assert.equal(result.reasonCode, 'PROGRAM_IDLE');
	assert.deepEqual(result.receipts.map(receipt => receipt.state), ['CANCELLED', 'SUCCEEDED']);
	assert.equal(result.goalRevision, 1);
});

test('explicit urgent attention requests a decision without stopping continue-and-notify work', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000); await player.wait(2);` });
	await tick();
	run.runtime.updateObservation(record, observation(), { eventSequence: 10, attention: true, changedFacts: [], priority: 'urgent', trigger: 'conversation' });
	run.finish(run.commands()[0]);
	await tick();
	assert.equal(run.commands().length, 2);
	const result = await run.call('programStatus', { programId: handle.programId });
	assert.equal(result.decision.trigger, 'conversation');
	assert.equal(result.engineState, 'ACTIVE');
	const accepted = await run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: result.decision.decisionId, directive: 'continue' });
	assert.equal(accepted.decision, undefined);
	run.finish(run.commands()[1]);
});

test('ordinary discoveries do not repeat an unresolved urgent program interruption', async t => {
	const events = [];
	const run = setup(t, { onProgramEvent: (_record, event) => events.push(event) });
	await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000);` });
	await tick();
	run.observe(10, 10);
	await tick();
	assert.equal(events.at(-1).priority, 'urgent');
	const notified = events.length, decisionId = events.at(-1).status.decision.decisionId;
	run.runtime.updateObservation(record, observation(10), { eventSequence: 11, attention: true, priority: 'ordinary', trigger: 'resource_discovery', changedFacts: ['blocks'] });
	await tick();
	assert.equal(events.length, notified, 'a later discovery folds into the decision the model already holds instead of waking it again');
	const status = await run.call('programStatus');
	assert.equal(status.decision.decisionId, decisionId, 'the in-flight handle stays valid');
	assert.equal(status.decision.priority, 'urgent', 'the pending hazard is still represented');
});

test('program cancellation fences the next command and stale handles cannot cancel replacements', async t => {
	const run = setup(t);
	const source = `${prefix} await player.wait(1000); await player.wait(2);`;
	const handle = await run.call('runProgram', { background: true, source });
	await tick();
	const cancelled = run.call('cancelProgram', { programId: handle.programId, goalRevision: 1 });
	await tick();
	assert.equal((await run.call('programStatus')).state, 'CANCELLING');
	await assert.rejects(run.call('runProgram', { background: true, source }), { code: 'NATIVE_PROGRAM_IN_PROGRESS' });
	run.finish(run.commands()[0], 'CANCELLED');
	assert.equal((await cancelled).state, 'CANCELLED');
	assert.equal(run.commands().length, 1);
	const next = await run.call('runProgram', { background: true, source });
	assert.notEqual(next.programId, handle.programId);
	await assert.rejects(run.call('cancelProgram', { programId: handle.programId, goalRevision: 1 }), { code: 'STALE_PROGRAM' });
	await assert.rejects(run.call('cancelProgram', { programId: next.programId, goalRevision: 0 }), { code: 'STALE_PROGRAM' });
	assert.equal((await run.call('programStatus')).programId, next.programId);
});

test('pause-and-notify retains the continuation until the model explicitly resumes it', async t => {
	const events = [];
	const run = setup(t, { onProgramEvent: (_record, event) => events.push(event) });
	const handle = await run.call('runProgram', { background: true, source: 'program.onUnhandledAttention("pause_and_notify"); await player.wait(1000); await player.wait(player.state().health);' });
	await tick();
	run.observe(9, 10);
	await tick();
	assert.equal(run.sent.filter(entry => entry.type === 'action_cancel').length, 1);
	assert.equal(run.commands().length, 1);
	run.finish(run.commands()[0], 'CANCELLED');
	await tick();
	const status = await run.call('programStatus');
	assert.equal(status.engineState, 'SUSPENDED');
	assert.equal(events[0].event, 'program_attention');
	run.observe(7, 20);
	await tick();
	assert.equal(run.commands().length, 1, 'fresh facts must not resume a suspended body');
	const fresh = await run.call('programStatus');
	assert.equal(fresh.decision.eventSequence, 20);
	assert.equal(fresh.decision.decisionId, status.decision.decisionId, 'urgent notifications refresh facts without invalidating the stable handle');
	await run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: fresh.decision.decisionId, eventSequence: fresh.decision.eventSequence, directive: 'continue' });
	await tick();
	assert.equal(run.commands()[1].payload.arguments.durationMs, 7);
	run.finish(run.commands()[1]);
	await tick();
	assert.equal(events.at(-1).event, 'program_ended');
	assert.equal(events.at(-1).result.reasonCode, 'PROGRAM_EXHAUSTED');
});

test('a newer attention invalidates the decision and replacement waits for input release', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000); await player.wait(2);` });
	await tick();
	run.observe(10, 10);
	const old = (await run.call('programStatus')).decision;
	run.observe(4, 11);
	await assert.rejects(run.call('respondProgram', { programId: handle.programId, goalRevision: 1,
		decisionId: old.decisionId, eventSequence: old.eventSequence, directive: 'continue' }), error =>
		error.code === 'STALE_PROGRAM_DECISION' && error.freshDecision.eventSequence === 11 && error.message.includes('Fresh decision:'),
	'materially changed health returns fresh facts inline');
	const status = await run.call('programStatus');
	await assert.rejects(run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: status.decision.decisionId, directive: 'replace', source: 'broken (' }));
	assert.equal(run.sent.filter(entry => entry.type === 'action_cancel').length, 0, 'invalid replacement cannot disrupt current work');
	await run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: status.decision.decisionId, eventSequence: status.decision.eventSequence, directive: 'replace', source: `${prefix} await player.wait(8);` });
	assert.equal(run.commands().length, 1);
	run.finish(run.commands()[0], 'CANCELLED');
	await tick();
	assert.equal(run.commands()[1].payload.arguments.durationMs, 8);
	assert.equal(run.commands()[1].payload.provenance.programVersion, 2);
	assert.equal((await run.call('programStatus')).deadlineEpochMs, handle.deadlineEpochMs);
	run.finish(run.commands()[1]);
	await tick();
	assert.equal(run.commands().length, 2, 'the replaced continuation never runs');
});

test('a repeated deterministic failure replaces an older pending decision and requires a revised routine', async t => {
	const events = [];
	const run = setup(t, { onProgramEvent: (_record, event) => events.push(event) });
	const handle = await run.call('runProgram', { background: true, source: `${prefix} for (let i = 0; i < 3; i++) { await player.wait(1000); }` });
	await tick();
	run.observe(10, 10);
	const old = (await run.call('programStatus')).decision;
	run.finish(run.commands()[0], 'TIMED_OUT');
	await tick();
	run.finish(run.commands()[1], 'TIMED_OUT');
	await tick();
	const current = await run.call('programStatus');
	assert.equal(current.decision.trigger, 'action_failure');
	assert.equal(current.decision.actionFailure.reasonCode, 'TIMED_OUT');
	assert.equal(events.at(-1).status.decision.decisionId, current.decision.decisionId);
	assert.equal(current.decision.decisionId, old.decisionId, 'urgent trigger refresh keeps one stable decision handle');
	await assert.rejects(run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: old.decisionId, directive: 'continue' }), { code: 'PROGRAM_REPLACEMENT_REQUIRED' });
	await assert.rejects(run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: current.decision.decisionId, eventSequence: current.decision.eventSequence, directive: 'continue' }), { code: 'PROGRAM_REPLACEMENT_REQUIRED' });
	await run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: current.decision.decisionId, eventSequence: current.decision.eventSequence, directive: 'replace', source: `${prefix} await player.wait(3);` });
	assert.equal(run.commands()[2].payload.arguments.durationMs, 3);
});

test('a foreground call releases the model on attention while its authored routine keeps running', async t => {
	const run = setup(t);
	const pending = run.call('runProgram', { source: `${prefix} await player.wait(1000); await player.wait(2);` });
	await tick();
	run.observe(9, 10);
	const handle = await pending;
	assert.equal(handle.decision.trigger, 'health_changed');
	assert.equal(handle.state, 'RUNNING');
	run.finish(run.commands()[0]);
	await tick();
	assert.equal(run.commands().length, 2);
	const finish = run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: handle.decision.decisionId, directive: 'finish' });
	await tick();
	run.finish(run.commands()[1], 'CANCELLED');
	assert.equal((await finish).reasonCode, 'PROGRAM_FINISH_REQUESTED');
	assert.equal(run.sent.some(entry => entry.type === 'goal_completed'), false, 'program finish is not proof of the goal');
});

test('cancel a background notebook load without waiting for storage or allowing late dispatch', async t => {
	let release;
	const run = setup(t, { memoryOperation: async () => new Promise(resolve => { release = resolve; }) });
	const handle = await run.call('runProgram', { background: true, noteKey: 'guard' });
	assert.equal(handle.state, 'PREPARING');
	assert.equal((await run.call('cancelProgram', { programId: handle.programId, goalRevision: 1 })).state, 'CANCELLED');
	release({ entries: [{ key: 'guard', text: `${prefix} await player.wait(1);` }] });
	await tick();
	assert.equal(run.commands().length, 0);
	assert.equal((await run.call('programStatus')).state, 'CANCELLED');
});

test('background syntax failures are readable results and release ownership', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: 'not valid javascript !!!' });
	await tick();
	const result = await run.call('programStatus', { programId: handle.programId });
	assert.equal(result.state, 'FAILED');
	assert.equal(run.commands().length, 0);
	const next = await run.call('runProgram', { background: true, source: `${prefix} program.finish("request verification");` });
	await tick();
	assert.equal((await run.call('programStatus', { programId: next.programId })).reasonCode, 'PROGRAM_FINISH_REQUESTED');
	assert.equal((await run.call('programStatus', { programId: handle.programId })).state, 'UNKNOWN_PROGRAM');
});

test('lifecycle disposal cancels a background program and prevents old continuation or receipts', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: `${prefix} await player.wait(100); await player.wait(2);` });
	await tick();
	await run.runtime.dispose(record.agentId, 'goal_stop');
	await tick();
	assert.equal(run.commands().length, 1);
	assert.equal((await run.call('programStatus', { programId: handle.programId })).state, 'UNKNOWN_PROGRAM');
	assert.equal(run.sent.filter(entry => entry.type === 'action_cancel').length, 1);
});

test('background deadlines cancel input and remain bounded without model polling', async t => {
	const timers = new Map(); let timerId = 0;
	const executor = new NativeProgramExecutor({ setTimeoutFn: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeoutFn: id => timers.delete(id) });
	const run = setup(t, { programExecutor: executor });
	const handle = await run.call('runProgram', { background: true, timeoutMs: 250, source: `${prefix} await player.wait(1000); await player.wait(2);` });
	await tick();
	[...timers.values()].find(timer => timer.ms === 250).fn();
	await tick();
	assert.equal(run.sent.filter(entry => entry.type === 'action_cancel').length, 1);
	run.finish(run.commands()[0], 'CANCELLED');
	await tick();
	assert.equal((await run.call('programStatus', { programId: handle.programId })).reasonCode, 'PROGRAM_DEADLINE');
	assert.equal(run.commands().length, 1);
	assert.equal(timers.size, 0);
});

test('background contracts reject invalid flags and incomplete cancellation handles', () => {
	for (const [name, args] of [
		['runProgram', { source: prefix, background: 'true' }],
		['cancelProgram', { programId: 'p' }],
		['programStatus', { goalRevision: 1 }],
	]) assert.throws(() => normalizeMinecraftToolCall(name, args), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
});

test('unconfirmed background cancellation cannot release the body for a new action', async t => {
	const timers = new Map(); let timerId = 0;
	const executor = new NativeProgramExecutor({ setTimeoutFn: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeoutFn: id => timers.delete(id) });
	const run = setup(t, { programExecutor: executor });
	const handle = await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000); await player.wait(2);` });
	await tick();
	const pending = run.call('cancelProgram', { programId: handle.programId, goalRevision: 1 });
	await tick();
	[...timers.values()].find(timer => timer.ms === 5000).fn();
	assert.equal((await pending).state, 'UNKNOWN');
	await assert.rejects(run.call('wait', { durationMs: 1 }), { code: 'NATIVE_ACTION_IN_PROGRESS' });
	assert.equal(run.commands().length, 1);
	run.finish(run.commands()[0], 'CANCELLED');
	await tick();
	assert.equal((await run.call('actionStatus')).state, 'IDLE');
});

test('exact program lease expiry bounds hung preparation and fences its late lookup', async t => {
	let release;
	const leases = [];
	const run = setup(t, { memoryOperation: async () => new Promise(resolve => { release = resolve; }),
		onWorkStarted: (_record, kind, options) => {
			const lease = { kind, ...options, released: false }; leases.push(lease);
			return () => { lease.released = true; };
		} });
	const handle = await run.call('runProgram', { background: true, noteKey: 'guard', timeoutMs: 250 });
	assert.equal(handle.state, 'PREPARING');
	assert.equal(leases[0].programId, handle.programId);
	assert.equal(await run.runtime.expireProgram({ ...record, goalRevision: 2 }, handle.programId), null);
	assert.equal(await run.runtime.expireProgram(record, 'obsolete-program'), null);
	assert.equal(leases[0].released, false, 'foreign expiry cannot release preparation');
	const result = await run.runtime.expireProgram(record, handle.programId);
	assert.equal(result.state, 'TIMED_OUT');
	assert.equal(result.reasonCode, 'PROGRAM_DEADLINE');
	assert.equal(leases[0].released, true);
	release({ entries: [{ key: 'guard', text: `${prefix} await player.wait(1);` }] }); await tick();
	assert.equal(run.commands().length, 0, 'late preparation lost dispatch authority');
	assert.deepEqual(await run.call('programStatus', { programId: handle.programId }), result);
});

test('program expiry keeps uncertain input fenced and cannot cancel a successor', async t => {
	const timers = new Map(); let timerId = 0;
	const executor = new NativeProgramExecutor({ setTimeoutFn: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeoutFn: id => timers.delete(id) });
	const run = setup(t, { programExecutor: executor });
	const handle = await run.call('runProgram', { background: true, timeoutMs: 250, source: `${prefix} await player.wait(1000);` }); await tick();
	const pending = run.runtime.expireProgram(record, handle.programId); await tick();
	assert.equal(run.sent.filter(entry => entry.type === 'action_cancel').length, 1);
	[...timers.values()].find(timer => timer.ms === 5000).fn();
	assert.equal((await pending).reasonCode, 'PROGRAM_CANCEL_ACK_TIMEOUT');
	assert.equal((await run.call('programStatus', { programId: handle.programId })).state, 'UNKNOWN');
	await assert.rejects(run.call('wait', { durationMs: 1 }), { code: 'NATIVE_ACTION_IN_PROGRESS' });
	assert.equal(run.commands().length, 1);
	run.finish(run.commands()[0], 'CANCELLED'); await tick();
	const successor = await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000);` }); await tick();
	assert.equal(await run.runtime.expireProgram(record, handle.programId), null);
	assert.equal((await run.call('programStatus', { programId: successor.programId })).state, 'RUNNING');
	assert.equal(run.sent.filter(entry => entry.type === 'action_cancel').length, 1);
});

test('a wait during the model\'s own program returns as soon as the program ends', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000);` });
	await tick();
	const waiting = run.call('wait', { durationMs: 60_000 });
	await tick();
	run.finish(run.commands()[0]);
	const result = await waiting;
	assert.equal(result.reasonCode, 'PROGRAM_ENDED');
	assert.equal(result.program.programId, handle.programId);
	assert.equal(result.program.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.ok(result.waitedMs < 60_000);
	assert.equal(run.commands().length, 1, 'the wait itself never sends body input');
});

test('a wait during the model\'s own program returns the decision instead of idling past it', async t => {
	const run = setup(t);
	await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000); await player.wait(2);` });
	await tick();
	const waiting = run.call('wait', { durationMs: 60_000 });
	await tick();
	run.observe(4, 10);
	const result = await waiting;
	assert.equal(result.reasonCode, 'PROGRAM_DECISION');
	assert.equal(result.program.decision.trigger, 'health_changed');
	assert.deepEqual(result.program.decision.directives, ['replace', 'pause', 'finish'], 'continue still needs the existing low-health fresh-fact check');
	const again = await run.call('wait', { durationMs: 60_000 });
	assert.equal(again.reasonCode, 'PROGRAM_DECISION_PENDING', 'a pending decision is reported at once, never waited out');
});

test('a same-turn wait after a background program already ended reports that end instead of idling', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: `${prefix} program.finish("done");` });
	await tick();
	const result = await run.call('wait', { durationMs: 60_000 });
	assert.equal(result.reasonCode, 'PROGRAM_ENDED');
	assert.equal(result.waitedMs, 0);
	assert.equal(result.program.programId, handle.programId);
	assert.equal(run.commands().length, 0);
	// The end is reported once; a later wait is an ordinary body wait.
	const later = run.call('wait', { durationMs: 5 });
	await tick();
	assert.equal(run.commands().length, 1);
	run.finish(run.commands()[0]);
	assert.equal((await later).state, 'SUCCEEDED');
});

test('a wait in a later turn is not cut short by an earlier program end', async t => {
	const run = setup(t);
	await run.call('runProgram', { background: true, source: `${prefix} program.finish("done");` });
	await tick();
	const later = run.runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'next-turn', callId: 'w1', tool: normalizeMinecraftToolCall('wait', { durationMs: 5 }) }, record);
	await tick();
	assert.equal(run.commands().length, 1, 'the wait runs as an ordinary body wait');
	run.finish(run.commands()[0]);
	assert.equal((await later).state, 'SUCCEEDED');
});

test('after repeated action failure the offered directives match what respondProgram accepts', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: `${prefix} for (let i = 0; i < 3; i++) { await player.wait(1000); }` });
	await tick();
	run.finish(run.commands()[0], 'TIMED_OUT');
	await tick();
	run.finish(run.commands()[1], 'TIMED_OUT');
	await tick();
	const status = await run.call('programStatus');
	assert.equal(status.decision.trigger, 'action_failure');
	assert.deepEqual(status.decision.directives, ['replace', 'pause', 'finish'], 'continue is never offered when it would be refused');
	const error = await run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: status.decision.decisionId, eventSequence: status.decision.eventSequence, directive: 'continue' }).catch(e => e);
	assert.equal(error.code, 'PROGRAM_REPLACEMENT_REQUIRED');
	assert.equal(error.current.body, 'program');
	assert.equal(error.current.program.programId, handle.programId);
	assert.equal(error.current.program.decision.decisionId, status.decision.decisionId);
	assert.deepEqual(error.current.program.decision.directives, ['replace', 'pause', 'finish']);
	assert.deepEqual(error.current.next, ['actionStatus', 'replaceAction', 'respondProgram', 'programStatus', 'cancelProgram']);
	assert.equal(run.commands().length, 2, 'the rejection neither continues nor replaces the routine');
});

test('a stale decision handle is rejected with the current decision handle', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000);` });
	await tick();
	run.observe(4, 10);
	const status = await run.call('programStatus');
	const error = await run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: 'not-a-decision', directive: 'continue' }).catch(e => e);
	assert.equal(error.code, 'STALE_PROGRAM_DECISION');
	assert.equal(error.current.program.decision.decisionId, status.decision.decisionId);
	assert.equal(error.current.program.decision.eventSequence, status.decision.eventSequence);
	assert.ok(error.current.next.includes('respondProgram'));
});

test('a decision answered after the program ended is rejected with its terminal result', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000);` });
	await tick();
	run.finish(run.commands()[0]);
	await tick();
	const error = await run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: `${handle.programId}:decision-1`, directive: 'continue' }).catch(e => e);
	assert.equal(error.code, 'STALE_PROGRAM_DECISION');
	assert.equal(error.current.body, 'free');
	assert.deepEqual(error.current.program, { programId: handle.programId, state: 'YIELDED', reasonCode: 'PROGRAM_EXHAUSTED' });
	assert.equal(error.current.action.actionId, run.commands()[0].payload.actionId);
	assert.deepEqual(error.current.next, ['actionStatus', 'replaceAction', 'programStatus']);
});

test('cancelling an action that already ended is rejected with its terminal receipt', async t => {
	const run = setup(t);
	const pending = run.call('wait', { durationMs: 5 });
	await tick();
	const actionId = run.commands()[0].payload.actionId;
	run.finish(run.commands()[0]);
	await pending;
	const error = await run.call('cancelAction', { actionId, goalRevision: 1 }).catch(e => e);
	assert.equal(error.code, 'STALE_ACTION');
	assert.equal(error.current.body, 'free');
	assert.equal(error.current.action.actionId, actionId);
	assert.equal(error.current.action.state, 'SUCCEEDED');
	assert.deepEqual(error.current.next, ['actionStatus', 'replaceAction', 'programStatus'], 'a terminal handle still accepts replacement');
});

test('a program awaiting its cancellation receipt offers no decision and no respondProgram', async t => {
	const run = setup(t);
	const handle = await run.call('runProgram', { background: true, source: `${prefix} await player.wait(1000); await player.wait(2);` });
	await tick();
	run.observe(4, 10);
	await tick();
	const before = await run.call('programStatus');
	assert.deepEqual(before.decision.directives, ['replace', 'pause', 'finish']);
	const cancelling = run.call('cancelProgram', { programId: handle.programId, goalRevision: 1 });
	await tick();
	const status = await run.call('programStatus');
	assert.equal(status.state, 'CANCELLING');
	assert.deepEqual(status.decision?.directives ?? [], [], 'nothing is offered that respondProgram would refuse');
	for (const directive of ['continue', 'replace', 'pause', 'finish']) {
		const error = await run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: before.decision.decisionId,
			eventSequence: before.decision.eventSequence, directive, ...(directive === 'replace' ? { source: 'await player.wait(1);' } : {}) }).catch(e => e);
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.deepEqual(error.current.program.decision?.directives ?? [], []);
		assert.deepEqual(error.current.next, ['actionStatus', 'programStatus', 'cancelProgram'], 'status reads and repeated program cancellation are accepted while the receipt is outstanding');
	}
	assert.equal(run.commands().length, 1, 'no rejected answer touched the body');
	run.finish(run.commands()[0], 'CANCELLED');
	assert.equal((await cancelling).state, 'CANCELLED');
});

test('background notifications preserve deferred resource sightings through the native runtime', async t => {
	let now = 0;
	const timers = [], events = [];
	const executor = new NativeProgramExecutor({ now: () => now,
		setTimeoutFn: (callback, ms) => { const timer = { callback, due: now + ms, cleared: false }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { if (timer) timer.cleared = true; },
	});
	const run = setup(t, { programExecutor: executor, onProgramEvent: (_record, event) => events.push(event) });
	const handle = await run.call('runProgram', { background: true, timeoutMs: 120_000, source: `${prefix} await player.wait(1000); await player.wait(2);` });
	await tick();
	const first = { observedAtEpochMs: 1_000, block: { x: 1, y: 64, z: 0, blockId: 'minecraft:chest' } };
	now = 1_000;
	run.runtime.updateObservation(record, observation(), { eventSequence: 2, attention: true, trigger: 'resource_discovery', priority: 'ordinary', resourceSightings: [first] });
	await tick();
	assert.equal(events.length, 1);
	assert.deepEqual(events[0].status.decision.resourceSightings, [first]);
	await run.call('respondProgram', { programId: handle.programId, goalRevision: 1, decisionId: events[0].status.decision.decisionId, directive: 'continue' });
	const second = { observedAtEpochMs: 4_000, block: { x: 0, y: 65, z: 0, blockId: 'minecraft:diamond_ore' } };
	now = 4_000;
	run.runtime.updateObservation(record, observation(), { eventSequence: 3, attention: true, trigger: 'resource_discovery', priority: 'ordinary', resourceSightings: [second] });
	run.runtime.updateObservation(record, observation(), { eventSequence: 4, attention: false });
	await tick();
	assert.equal(events.length, 1);
	now = 31_000;
	const deferred = timers.find(timer => !timer.cleared && timer.due === now);
	assert.ok(deferred);
	deferred.callback();
	await tick();
	assert.equal(events.length, 2);
	assert.deepEqual(events[1].status.decision.resourceSightings, [second]);
	assert.deepEqual(events[1].observation.blocks, []);
	assert.equal((await run.call('programStatus')).decision.resourceSightings, undefined, 'shown sightings do not repeat on later status calls');
});

test('respondProgram returns a discovery folded into an already-notified paused handle', async t => {
	const events = [];
	const run = setup(t, { onProgramEvent: (_record, event) => events.push(event) });
	const handle = await run.call('runProgram', { background: true,
		source: 'program.onUnhandledAttention("pause_and_notify"); await player.wait(1000); await player.wait(2);' });
	await tick();
	run.runtime.updateObservation(record, observation(), { eventSequence: 2, attention: true, trigger: 'resource_discovery' });
	await tick();
	const command = run.commands()[0];
	run.finish(command, 'CANCELLED');
	await tick();
	const sighting = { observedAtEpochMs: 4000, block: { x: 2, y: 64, z: 0, blockId: 'minecraft:diamond_ore' } };
	run.runtime.updateObservation(record, observation(), { eventSequence: 4, attention: true, trigger: 'resource_discovery', resourceSightings: [sighting] });
	await tick();
	assert.equal(events.length, 1, 'the paused handle is notified once');
	const response = await run.call('respondProgram', { programId: handle.programId, goalRevision: 1,
		decisionId: events[0].status.decision.decisionId, directive: 'replace', source: `${prefix} await player.wait(2);` });
	assert.deepEqual(response.resourceSightings, [sighting], 'the real model tool response carries the folded discovery');
});

test('empty defensive watcher warning is delivered only once per program version', async t => {
	const run = setup(t);
	const result = await run.call('runProgram', { background: true, source: `program.onUnhandledAttention("pause_and_notify");
		program.watch(() => player.state().health < 20,{mode:"interrupt",after:"reconsider"},async () => {});
		await player.wait(1000);` });
	assert.match(result.warnings[0], /empty handler supplies no defense/);
	assert.equal((await run.call('programStatus')).warnings, undefined);
	assert.equal((await run.call('programStatus')).warnings, undefined);
	run.observe(19, 2);
	await tick();
	run.finish(run.commands()[0], 'CANCELLED');
	await tick();
	const status = await run.call('programStatus');
	const replacement = await run.call('respondProgram', { programId: result.programId, goalRevision: 1,
		decisionId: status.decision.decisionId, directive: 'replace', source: `program.onUnhandledAttention("pause_and_notify");
		program.watch(() => player.state().health < 10,{mode:"interrupt"},() => undefined); await player.wait(1000);` });
	assert.equal(replacement.programVersion, result.programVersion + 1);
	assert.match(replacement.warnings[0], /empty handler supplies no defense/);
	assert.equal((await run.call('programStatus')).warnings, undefined);
});
