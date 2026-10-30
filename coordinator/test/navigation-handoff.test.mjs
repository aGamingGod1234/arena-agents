import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { toolResultContent } from '../src/native-minecraft-tools.mjs';

const record = { agentId: 'handoff-agent', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'priority', goalRevision: 1 };
const targetId = '51b8610a-5119-4403-b692-54232b674e86';

test('blocked combat and retreat retain support, health and the reason through model receipt formatting', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => {
		if (type === 'action_command') sent.push(payload);
	} } });
	t.after(() => runtime.disposeAll());
	const support = 'health 19.6; onGround=true; footing below center: minecraft:magma_block at 30,49,27';
	const exits = 'exits: front_left 0.9m up2 landing route unknown (29,52,27)';
	for (const [actionType, reasonCode] of [['flee_from', 'FLEE_BLOCKED'], ['fight_target', 'TARGET_UNREACHABLE']]) {
		const pending = runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'handoff', callId: actionType,
			tool: { kind: 'action', actionType, arguments: { targetId, timeoutMs: 6000, ...(actionType === 'flee_from' ? { distance: 12 } : {}) } } }, record);
		await new Promise(resolve => setImmediate(resolve));
		// The Java controller fixture verifies this prefix precedes the potentially long heading/reach details.
		runtime.onActionResult(record, { actionId: sent.at(-1).actionId, state: 'FAILED', reasonCode,
			message: `body idle; ${support}; ${exits}; no tested heading is safe in seen terrain; ${'yaw probe; '.repeat(300)}`,
			executionStarted: true, physicalAttempted: true });
		const result = await pending;
		const visible = JSON.parse(toolResultContent(result).contentItems[0].text);
		assert.equal(visible.reasonCode, reasonCode);
		assert.ok(visible.failure.blockedBy.includes(support));
		assert.ok(visible.failure.blockedBy.includes(exits));
		assert.ok(visible.failure.blockedBy.includes('no tested heading is safe in seen terrain'));
		assert.ok(visible.failure.blockedBy.length <= 2048);
	}
});

test('an airborne navigation cancellation retains momentum and the qualified height estimate', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => {
		if (type === 'action_command') sent.push(payload);
	} } });
	t.after(() => runtime.disposeAll());
	const pending = runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'handoff', callId: 'navigation',
		tool: { kind: 'action', actionType: 'navigate_to', arguments: { x: 40, y: 58, z: 27, tolerance: 2, sprint: true, timeoutMs: 12000 } } }, record);
	await new Promise(resolve => setImmediate(resolve));
	runtime.onActionResult(record, { actionId: sent[0].actionId, state: 'CANCELLED', reasonCode: 'ACTION_CANCELLED',
		message: 'Cancelled by explicit model decision; navigation input released; health 20.0; onGround=false; airborne; velocity 0.15,-0.16,-0.03 blocks/tick; planned landing 29.5,52.00,27.5; gravity-only estimate 0.20 s to its height; landing contact unverified; momentum continues after release',
		executionStarted: true, physicalAttempted: true });
	const visible = JSON.parse(toolResultContent(await pending).contentItems[0].text);
	assert.equal(visible.reasonCode, 'ACTION_CANCELLED');
	assert.match(visible.message, /airborne.*gravity-only estimate 0\.20 s.*landing contact unverified.*momentum continues after release/);
});
