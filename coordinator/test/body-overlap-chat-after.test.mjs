import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const record = { agentId: 'agent-chat-after', provider: 'codex', model: 'test-model', reasoningEffort: 'low', serviceTier: 'fast', goalRevision: 3, currentGoal: 'arrive' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(t) {
	const commands = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, _agentId, payload) => {
		if (type !== 'action_command') return;
		commands.push(payload);
		// Acknowledge real runtime dispatch so blocking act also completes on the broken path.
		if (payload.actionType === 'chat') setImmediate(() => finish(payload.actionId, 'SUCCEEDED', 'CHAT_SENT'));
	} } });
	t.after(() => runtime.dispose());
	runtime.updateObservation(record, { player: { x: 0, y: 64, z: 0, health: 20 }, observedAtEpochMs: Date.now() }, { eventSequence: 1 });
	let ordinal = 0;
	const execute = (name, args) => runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision,
		turnId: 'turn-chat-after', callId: `chat-after-${++ordinal}`, tool: normalizeMinecraftToolCall(name, args) }, record);
	const finish = (actionId, state = 'SUCCEEDED', reasonCode = 'ACTION_COMPLETED') => runtime.onActionResult(record, { actionId, state, reasonCode });
	const start = () => execute('startAction', { actionType: 'wait', arguments: { durationMs: 2_000 } });
	const chat = (name, after) => execute(name, { actionType: 'chat', arguments: { message: 'I have arrived.' }, ...(after === undefined ? {} : { after }) });
	return { commands, finish, start, chat };
}

for (const name of ['act', 'startAction']) {
	test(`${name} chat waits for a successful predecessor before dispatch`, async t => {
		const { commands, finish, start, chat } = harness(t);
		const first = await start();
		const pending = chat(name, first.actionId);
		await tick();
		const sentBeforeCompletion = commands.length;
		finish(first.actionId);
		const result = await pending;
		assert.equal(sentBeforeCompletion, 1, 'chat must wait while the predecessor runs');
		assert.equal(commands.length, 2);
		assert.equal(commands[1].actionType, 'chat');
		assert.equal(result.state, name === 'act' ? 'SUCCEEDED' : 'RUNNING');
		assert.equal(result.predecessor.actionId, first.actionId);
		assert.equal(result.predecessor.state, 'SUCCEEDED');
		await tick();
	});

	test(`${name} chat does not dispatch when its predecessor fails`, async t => {
		const { commands, finish, start, chat } = harness(t);
		const first = await start();
		const pending = chat(name, first.actionId);
		await tick();
		finish(first.actionId, 'FAILED', 'PATH_BLOCKED');
		const result = await pending;
		assert.equal(result.state, 'NOT_STARTED');
		assert.equal(result.reasonCode, 'PREDECESSOR_NOT_SUCCEEDED');
		assert.equal(result.predecessor.actionId, first.actionId);
		assert.equal(result.predecessor.state, 'FAILED');
		assert.equal(result.predecessor.reasonCode, 'PATH_BLOCKED');
		assert.equal(commands.length, 1, 'failed arrival must suppress the announcement');
	});

	test(`${name} chat rejects unknown and superseded predecessor handles`, async t => {
		const { commands, finish, start, chat } = harness(t);
		await assert.rejects(chat(name, 'native:unknown'), { code: 'STALE_ACTION' });
		assert.equal(commands.length, 0);
		const first = await start();
		finish(first.actionId);
		const second = await start();
		finish(second.actionId);
		await assert.rejects(chat(name, first.actionId), { code: 'STALE_ACTION' });
		assert.equal(commands.length, 2);
	});

	test(`${name} chat without after still dispatches alongside a running body`, async t => {
		const { commands, finish, start, chat } = harness(t);
		const first = await start();
		const result = await chat(name);
		assert.equal(commands.length, 2);
		assert.equal(commands[1].actionType, 'chat');
		assert.equal(result.state, name === 'act' ? 'SUCCEEDED' : 'RUNNING');
		finish(first.actionId);
		await tick();
	});
}
