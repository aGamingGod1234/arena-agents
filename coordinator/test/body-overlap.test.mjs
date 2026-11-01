import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_KEEP_GOING_LEGS, NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

// Overlap: the body keeps working while the model decides (audit 2026-11-01 #6).

function record(overrides = {}) {
	return { agentId: 'agent-a', provider: 'codex', model: 'test-model', reasoningEffort: 'low', serviceTier: 'fast', goalRevision: 3, currentGoal: 'explore', ...overrides };
}

let callOrdinal = 0;
function call(name, args) {
	callOrdinal += 1;
	return { agentId: 'agent-a', goalRevision: 3, turnId: 'turn-1', callId: `call-${callOrdinal}`, tool: normalizeMinecraftToolCall(name, args) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ position = { x: 0, y: 64, z: 0 } } = {}) {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (...args) => sent.push(args) } });
	runtime.updateObservation(record(), { player: { ...position, health: 20 }, observedAtEpochMs: Date.now() }, { eventSequence: 1 });
	const commands = () => sent.filter(([type]) => type === 'action_command').map(([, , payload]) => payload);
	const cancels = () => sent.filter(([type]) => type === 'action_cancel').map(([, , payload]) => payload);
	const finish = (actionId, state = 'SUCCEEDED', { reasonCode = 'ACTION_COMPLETED', at = null } = {}) => runtime.onActionResult(record(), {
		actionId, state, reasonCode, ...(at === null ? {} : { actionObservation: { position: at } }) });
	return { runtime, sent, commands, cancels, finish };
}

test('after starts the next action the moment its predecessor succeeds, and not before', async () => {
	const { runtime, commands, finish } = harness();
	const first = await runtime.execute(call('startAction', { actionType: 'wait', arguments: { durationMs: 2_000 } }), record());
	assert.equal(first.state, 'RUNNING');
	const pending = runtime.execute(call('startAction', { actionType: 'look_at', arguments: { x: 4, y: 65, z: 4 }, after: first.actionId }), record());
	await tick();
	assert.equal(commands().length, 1, 'the successor waits for its predecessor instead of failing with NATIVE_ACTION_IN_PROGRESS');
	finish(first.actionId);
	const second = await pending;
	assert.equal(commands().length, 2);
	assert.equal(commands()[1].actionType, 'look_at');
	assert.equal(second.state, 'RUNNING');
	assert.equal(second.actionId, commands()[1].actionId);
	assert.deepEqual(second.predecessor, { actionId: first.actionId, actionType: 'wait', state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED', durationMs: second.predecessor.durationMs });
	finish(second.actionId);
});

test('a blocking act with after returns its own result and names the predecessor it followed', async () => {
	const { runtime, commands, finish } = harness();
	const first = await runtime.execute(call('startAction', { actionType: 'wait', arguments: { durationMs: 2_000 } }), record());
	const pending = runtime.execute(call('act', { actionType: 'wait', arguments: { durationMs: 100 }, after: first.actionId }), record());
	finish(first.actionId);
	await tick();
	assert.equal(commands().length, 2);
	finish(commands()[1].actionId);
	const result = await pending;
	assert.equal(result.state, 'SUCCEEDED');
	assert.equal(result.predecessor.actionId, first.actionId);
});

test('after does not start anything when the predecessor fails, and reports that failure instead', async () => {
	const { runtime, commands, finish } = harness();
	const first = await runtime.execute(call('startAction', { actionType: 'wait', arguments: { durationMs: 2_000 } }), record());
	const pending = runtime.execute(call('act', { actionType: 'look_at', arguments: { x: 1, y: 64, z: 1 }, after: first.actionId }), record());
	await tick();
	finish(first.actionId, 'FAILED', { reasonCode: 'PATH_BLOCKED' });
	const result = await pending;
	assert.equal(result.state, 'NOT_STARTED');
	assert.equal(result.reasonCode, 'PREDECESSOR_NOT_SUCCEEDED');
	assert.equal(result.predecessor.state, 'FAILED');
	assert.equal(result.predecessor.reasonCode, 'PATH_BLOCKED');
	assert.equal(commands().length, 1, 'the dependent action never reached the body');
});

test('danger during an after wait returns before the successor starts and leaves the running action alone', async () => {
	const { runtime, commands, cancels, finish } = harness();
	const first = await runtime.execute(call('startAction', { actionType: 'wait', arguments: { durationMs: 2_000 } }), record());
	const pending = runtime.execute(call('act', { actionType: 'look_at', arguments: { x: 1, y: 64, z: 1 }, after: first.actionId }), record());
	await tick();
	assert.equal(runtime.interruptBlockingTool('agent-a'), true, 'the after wait is interruptible like a blocking body tool');
	const result = await pending;
	assert.equal(result.state, 'NOT_STARTED');
	assert.equal(result.reasonCode, 'AFTER_INTERRUPTED');
	assert.equal(result.interruptedBy, 'danger');
	assert.equal(result.predecessor.state, 'RUNNING');
	assert.match(result.recoveryHint, /replaceAction/);
	finish(first.actionId);
	await tick();
	assert.equal(commands().length, 1, 'an interrupted successor is never started later');
	assert.equal(cancels().length, 0);
});

test('after accepts the latest handle that already succeeded and rejects a stale one', async () => {
	const { runtime, commands, finish } = harness();
	const first = await runtime.execute(call('startAction', { actionType: 'wait', arguments: { durationMs: 100 } }), record());
	finish(first.actionId);
	const started = await runtime.execute(call('startAction', { actionType: 'wait', arguments: { durationMs: 100 }, after: first.actionId }), record());
	assert.equal(started.state, 'RUNNING');
	assert.equal(commands().length, 2);
	finish(started.actionId);
	await assert.rejects(runtime.execute(call('startAction', { actionType: 'wait', arguments: { durationMs: 100 }, after: first.actionId }), record()), { code: 'STALE_ACTION' });
	assert.equal(commands().length, 2);
});

test('keepGoing returns the first leg with its facts while the next leg already runs', async () => {
	const { runtime, commands, cancels, finish } = harness();
	const pending = runtime.execute(call('act', { actionType: 'travel_to', arguments: { yaw: 90, distance: 32 }, keepGoing: true }), record());
	await tick();
	const leg1 = commands()[0];
	finish(leg1.actionId, 'SUCCEEDED', { at: { x: -32, y: 64, z: 0 } });
	const result = await pending;
	assert.equal(result.state, 'SUCCEEDED');
	assert.equal(commands().length, 2, 'the second leg starts without another model call');
	const leg2 = commands()[1];
	assert.deepEqual(leg2.arguments, leg1.arguments, 'each leg repeats the model\'s own authored leg');
	assert.equal(result.continuing.actionId, leg2.actionId);
	assert.equal(result.continuing.leg, 2);
	// The model's reply: any body call stops the running leg (acknowledged) and then runs as asked.
	const reply = runtime.execute(call('act', { actionType: 'look_at', arguments: { x: 1, y: 64, z: 1 } }), record());
	await tick();
	assert.deepEqual(cancels(), [{ actionId: leg2.actionId, goalRevision: 3 }]);
	assert.equal(commands().length, 2, 'the reply waits for the leg to stop');
	finish(leg2.actionId, 'CANCELLED', { reasonCode: 'ACTION_CANCELLED' });
	await tick();
	assert.equal(commands().length, 3);
	assert.equal(commands()[2].actionType, 'look_at');
	finish(commands()[2].actionId);
	const replied = await reply;
	assert.equal(replied.state, 'SUCCEEDED');
	assert.equal(replied.replacedAction.actionId, leg2.actionId);
	assert.equal(replied.replacedAction.state, 'CANCELLED');
});

test('keepGoing stops at a leg that fails or makes no progress, and at the leg limit', async () => {
	{
		const { runtime, commands, finish } = harness();
		const pending = runtime.execute(call('act', { actionType: 'dig_to', arguments: { pattern: 'tunnel', heading: 'north', maxBlocks: 16 }, keepGoing: true }), record());
		await tick();
		finish(commands()[0].actionId, 'SUCCEEDED', { at: { x: 0.2, y: 64, z: -0.3 } });
		const result = await pending;
		assert.deepEqual(result.keepGoing, { stopped: 'NO_PROGRESS' });
		assert.equal(commands().length, 1);
	}
	{
		const { runtime, commands, finish } = harness();
		const pending = runtime.execute(call('act', { actionType: 'travel_to', arguments: { yaw: 0, distance: 20 }, keepGoing: true }), record());
		await tick();
		finish(commands()[0].actionId, 'FAILED', { reasonCode: 'HOSTILE_NEAR', at: { x: 0, y: 64, z: 10 } });
		const result = await pending;
		assert.equal(result.state, 'FAILED');
		assert.equal(result.continuing, undefined);
		assert.equal(commands().length, 1, 'a stop for a hostile hands back to the model');
	}
	{
		const { runtime, commands, finish } = harness();
		const handle = await runtime.execute(call('startAction', { actionType: 'travel_to', arguments: { yaw: 0, distance: 20 }, keepGoing: true }), record());
		assert.equal(handle.state, 'RUNNING');
		for (let leg = 1; leg <= MAX_KEEP_GOING_LEGS; leg += 1) {
			assert.equal(commands().length, leg);
			finish(commands().at(-1).actionId, 'SUCCEEDED', { at: { x: 0, y: 64, z: 20 * leg } });
			await tick(); await tick();
		}
		assert.equal(commands().length, MAX_KEEP_GOING_LEGS, 'a chain the model never answers still ends and wakes it');
		assert.equal((await runtime.execute(call('actionStatus', {}), record())).state, 'IDLE');
	}
});

test('the first keepGoing handle stays valid for status and cancel across legs', async () => {
	const { runtime, commands, cancels, finish } = harness();
	const handle = await runtime.execute(call('startAction', { actionType: 'travel_to', arguments: { yaw: 0, distance: 20 }, keepGoing: true }), record());
	finish(handle.actionId, 'SUCCEEDED', { at: { x: 0, y: 64, z: 20 } });
	await tick(); await tick();
	const leg2 = commands()[1];
	const status = await runtime.execute(call('actionStatus', { actionId: handle.actionId }), record());
	assert.equal(status.actionId, leg2.actionId);
	assert.equal(status.state, 'RUNNING');
	const cancelling = runtime.execute(call('cancelAction', { actionId: handle.actionId, goalRevision: 3 }), record());
	await tick();
	assert.deepEqual(cancels(), [{ actionId: leg2.actionId, goalRevision: 3 }]);
	finish(leg2.actionId, 'CANCELLED', { reasonCode: 'ACTION_CANCELLED' });
	assert.equal((await cancelling).state, 'CANCELLED');
	await tick();
	assert.equal(commands().length, 2, 'a cancelled chain starts no further leg');
});

test('without keepGoing a body call while an action runs is still refused, as before', async () => {
	const { runtime } = harness();
	await runtime.execute(call('startAction', { actionType: 'wait', arguments: { durationMs: 2_000 } }), record());
	await assert.rejects(runtime.execute(call('act', { actionType: 'look_at', arguments: { x: 1, y: 64, z: 1 } }), record()), { code: 'NATIVE_ACTION_IN_PROGRESS' });
});

test('act and startAction advertise after and keepGoing, and keepGoing is limited to heading legs', () => {
	for (const name of ['act', 'startAction']) {
		const schema = MINECRAFT_DYNAMIC_TOOLS.find((tool) => tool.name === name).inputSchema;
		assert.equal(schema.properties.after.type, 'string');
		assert.equal(schema.properties.keepGoing.type, 'boolean');
	}
	assert.deepEqual(normalizeMinecraftToolCall('act', { actionType: 'navigate_to', arguments: { x: 1, y: 64, z: 1 }, after: 'native:a' }).after, 'native:a');
	assert.equal(normalizeMinecraftToolCall('act', { actionType: 'travel_to', arguments: { yaw: 0, distance: 20 }, keepGoing: false }).keepGoing, undefined);
	for (const [actionType, args] of [['navigate_to', { x: 1, y: 64, z: 1 }], ['travel_to', { x: 100, z: 100 }], ['dig_to', { pattern: 'stairs_down', y: 12 }], ['dig_to', { pattern: 'tunnel', x: 50 }]]) {
		assert.throws(() => normalizeMinecraftToolCall('act', { actionType, arguments: args, keepGoing: true }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' }, actionType);
	}
	assert.throws(() => normalizeMinecraftToolCall('act', { actionType: 'wait', arguments: { durationMs: 100 }, after: '' }));
});
