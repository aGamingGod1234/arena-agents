import assert from 'node:assert/strict';
import test from 'node:test';

import { goalSpecFingerprint } from '../src/goal-spec.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';

const fields = { originalRequest: 'beat the game', predicate: { type: 'inventory_contains', itemId: 'minecraft:ender_eye', count: 12 }, createdAtTick: 10 };
const record = () => ({ agentId: 'agent-a', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority',
	goalRevision: 3, currentGoal: fields.originalRequest, currentGoalSpec: { ...fields, fingerprint: goalSpecFingerprint(fields) } });
const frame = (overrides) => ({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: 90, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 5, ...overrides });

async function control(message, args) {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (...entry) => { sent.push(entry); } } });
	runtime.updateObservation(record(), { entities: [] }, { eventSequence: 1 });
	const tool = { kind: 'action', actionType: 'control', arguments: frame(args) };
	const pending = runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn-1', callId: 'call-1', tool }, record());
	await new Promise((resolve) => setImmediate(resolve));
	runtime.onActionResult(record(), { actionId: sent[0][2].actionId, state: 'SUCCEEDED', reasonCode: 'CONTROL_SEGMENT_COMPLETED', message });
	return JSON.parse(presentNativeToolResult(await pending, tool).response.contentItems[0].text);
}

// final-3: the model scanned four headings with control turns, read only "Control segment completed", then walked
// off a 9-block rim it could have seen. The server now names the seen edge ahead and the fall; both must reach the model.
test('a control turn result carries the seen drop ahead to the model unchanged', async () => {
	const presented = await control('Control segment completed after a 3-tick view turn; ahead {"drop":9,"at":2}');
	assert.equal(presented.state, 'SUCCEEDED');
	assert.match(presented.message, /; ahead \{"drop":9,"at":2\}$/);
});

test('a control segment that fell reports its height and fall damage to the model', async () => {
	const presented = await control('Control segment completed; fell 9 blocks; fall HP sum 7.0', { forward: 1, jump: true, pitch: 20, ticks: 40 });
	assert.match(presented.message, /fell 9 blocks; fall HP sum 7\.0/);
});

// The named landing is the worst drop; HP sums every fall in the action.
test('a mixed solid/water action keeps total fall damage separate from the water landing', async () => {
	const presented = await control('Control segment completed; fell 10 blocks into water; fall HP sum 7.0', { forward: 1, ticks: 40 });
	assert.match(presented.message, /fell 10 blocks into water; fall HP sum 7\.0$/);
});
