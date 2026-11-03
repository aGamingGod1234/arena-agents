import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

for (const name of ['startAction', 'act']) {
	for (const reason of ['disposed', 'goal_respawn']) {
		test(`${name} after rejects a successful predecessor from a disposed lifecycle (${reason})`, async t => {
			const record = { agentId: 'agent-after-disposal', provider: 'codex', model: 'test-model', reasoningEffort: 'low', serviceTier: 'fast', goalRevision: 3, currentGoal: 'explore' };
			const commands = [];
			const runtime = new NativeToolRuntime({ bridge: { send: async (type, _agentId, payload) => {
				if (type !== 'action_command') return;
				commands.push(payload);
				// Let a mistakenly dispatched blocking successor finish so the regression fails without hanging.
				if (commands.length > 1) setImmediate(() => finish(payload.actionId));
			} } });
			t.after(() => runtime.dispose(record.agentId));
			const observe = () => runtime.updateObservation(record,
				{ player: { x: 0, y: 64, z: 0, health: 20 }, observedAtEpochMs: Date.now() }, { eventSequence: 1 });
			let ordinal = 0;
			const execute = (toolName, after) => runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision,
				turnId: 'turn-after-disposal', callId: `after-disposal-${++ordinal}`,
				tool: normalizeMinecraftToolCall(toolName, { actionType: 'wait', arguments: { durationMs: 100 },
					...(after === undefined ? {} : { after }) }) }, record);
			const finish = actionId => runtime.onActionResult(record, { actionId, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' });
			observe();
			const first = await execute('startAction');
			const pending = execute(name, first.actionId);
			const rejected = assert.rejects(pending, { code: 'STALE_NATIVE_TOOL' });
			assert.equal(commands.length, 1);
			// Resolve success and retire its lifecycle in the same turn, before the successor resumes.
			assert.equal(finish(first.actionId), true);
			await runtime.dispose(record.agentId, reason);
			observe();
			assert.equal(record.goalRevision, 3, 'respawn keeps the goal revision while retiring execution authority');
			await rejected;
			assert.equal(commands.length, 1, 'the retired lifecycle must not dispatch a successor');
			assert.equal((await runtime.execute({ agentId: record.agentId, goalRevision: 3, turnId: 'turn-after-disposal',
				callId: 'status-after-disposal', tool: normalizeMinecraftToolCall('actionStatus', {}) }, record)).state, 'IDLE');
			const fresh = await execute('startAction');
			assert.equal(fresh.state, 'RUNNING', 'new lifecycle calls retain execution authority at the same goal revision');
			assert.equal(commands.length, 2);
			finish(fresh.actionId);
		});
	}
}
