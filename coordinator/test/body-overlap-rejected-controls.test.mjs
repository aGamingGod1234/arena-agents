import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const record = { agentId: 'agent-a', provider: 'codex', model: 'test-model', reasoningEffort: 'low', serviceTier: 'fast', goalRevision: 3, currentGoal: 'explore' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (...args) => sent.push(args) } });
	runtime.updateObservation(record, { player: { x: 0, y: 64, z: 0, health: 20 }, observedAtEpochMs: Date.now() }, { eventSequence: 1 });
	let ordinal = 0;
	return {
		runtime,
		execute: (name, args) => runtime.execute({ agentId: record.agentId, goalRevision: 3, turnId: 'turn-1', callId: `call-${++ordinal}`, tool: normalizeMinecraftToolCall(name, args) }, record),
		commands: () => sent.filter(([type]) => type === 'action_command').map(([, , payload]) => payload),
		cancels: () => sent.filter(([type]) => type === 'action_cancel').map(([, , payload]) => payload),
		finish: (actionId, leg, state = 'SUCCEEDED') => runtime.onActionResult(record, {
			actionId, state, reasonCode: state === 'SUCCEEDED' ? 'ACTION_COMPLETED' : 'ACTION_CANCELLED',
			actionObservation: { position: { x: 0, y: 64, z: 20 * leg } },
		}),
	};
}

const travel = { actionType: 'travel_to', arguments: { yaw: 0, distance: 20 }, keepGoing: true };
const replacement = { actionType: 'wait', arguments: { durationMs: 100 } };

for (const control of ['cancelAction', 'replaceAction']) {
	for (const earlierHandle of [false, true]) {
		test(`stale ${control} using ${earlierHandle ? 'an earlier' : 'the current'} leg handle leaves keepGoing intact`, async () => {
			const h = harness();
			const first = await h.execute('startAction', travel);
			let leg = 1;
			if (earlierHandle) {
				h.finish(first.actionId, leg++);
				await tick();
			}
			const active = h.commands().at(-1);
			await assert.rejects(h.execute(control, { actionId: first.actionId, goalRevision: 2,
				...(control === 'replaceAction' ? replacement : {}) }), { code: 'STALE_ACTION' });
			assert.equal(h.cancels().length, 0, 'a rejected control sends no physical cancellation');
			h.finish(active.actionId, leg++);
			await tick();
			assert.equal(h.commands().length, leg, 'the accepted continuation still starts its next leg');
			assert.deepEqual(h.commands().at(-1).arguments, travel.arguments);
			h.finish(h.commands().at(-1).actionId, leg, 'CANCELLED');
		});
	}
}

test('replacement rejected while a blocking keepGoing call runs leaves its continuation intact', async () => {
	const h = harness();
	const pending = h.execute('act', travel);
	await tick();
	const first = h.commands()[0];
	await assert.rejects(h.execute('replaceAction', { actionId: first.actionId, goalRevision: 3, ...replacement }), { code: 'NATIVE_ACTION_IN_PROGRESS' });
	assert.equal(h.cancels().length, 0);
	h.finish(first.actionId, 1);
	const result = await pending;
	assert.equal(h.commands().length, 2);
	assert.equal(result.continuing.actionId, h.commands()[1].actionId);
	h.finish(h.commands()[1].actionId, 2, 'CANCELLED');
});

for (const control of ['cancelAction', 'replaceAction']) {
	test(`accepted ${control} through an earlier handle stops continuation before cancellation settles`, async () => {
		const h = harness();
		const first = await h.execute('startAction', travel);
		h.finish(first.actionId, 1);
		await tick();
		const second = h.commands()[1];
		const pending = h.execute(control, { actionId: first.actionId, goalRevision: 3,
			...(control === 'replaceAction' ? replacement : {}) });
		await tick();
		assert.deepEqual(h.cancels(), [{ actionId: second.actionId, goalRevision: 3 }]);
		// Success can beat the cancellation acknowledgement. It must not spawn another travel leg.
		h.finish(second.actionId, 2);
		await tick();
		if (control === 'replaceAction') {
			assert.equal(h.commands().length, 3);
			assert.equal(h.commands()[2].actionType, 'wait');
			h.finish(h.commands()[2].actionId, 2);
		}
		await pending;
		assert.equal(h.commands().length, control === 'replaceAction' ? 3 : 2);
	});
}

test('accepted after through an earlier handle still ends continuation and waits for the current leg', async () => {
	const h = harness();
	const first = await h.execute('startAction', travel);
	h.finish(first.actionId, 1);
	await tick();
	const second = h.commands()[1];
	const pending = h.execute('startAction', { ...replacement, after: first.actionId });
	await tick();
	assert.equal(h.commands().length, 2);
	assert.equal(h.cancels().length, 0);
	h.finish(second.actionId, 2);
	const result = await pending;
	assert.equal(h.commands().length, 3);
	assert.equal(h.commands()[2].actionType, 'wait');
	assert.equal(result.predecessor.actionId, second.actionId);
	h.finish(result.actionId, 2);
	await tick();
	assert.equal(h.commands().length, 3, 'after prevents any later continuation leg');
});
