import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const record = { agentId: 'agent-sight', provider: 'codex', model: 'test-model', reasoningEffort: 'low', serviceTier: 'fast', goalRevision: 3, currentGoal: 'explore' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const [actionType, args, ordinaryReason] of [
	['travel_to', { yaw: 0, distance: 100, stopWhenSeen: 'minecraft:lava' }, 'ARRIVED'],
	['dig_to', { pattern: 'tunnel', heading: 'north', maxBlocks: 16, stopWhenSeen: 'minecraft:lava' }, 'DIG_LIMIT_REACHED'],
]) {
	for (const name of ['act', 'startAction']) {
		for (const sightLeg of [1, 2]) {
			test(`${name} keepGoing ${actionType} stops on TARGET_SEEN in leg ${sightLeg}`, async (t) => {
				const commands = [];
				const runtime = new NativeToolRuntime({ bridge: { send: async (type, _agentId, payload) => {
					if (type === 'action_command') commands.push(payload);
				} } });
				t.after(() => runtime.dispose());
				runtime.updateObservation(record, { player: { x: 0, y: 64, z: 0, health: 20 }, observedAtEpochMs: Date.now() }, { eventSequence: 1 });
				const request = (toolName, arguments_) => ({ agentId: record.agentId, goalRevision: record.goalRevision,
					turnId: 'turn-sight', callId: toolName, tool: normalizeMinecraftToolCall(toolName, arguments_) });
				const pending = runtime.execute(request(name, { actionType, arguments: args, keepGoing: true }), record);
				await tick();
				const firstId = commands[0].actionId;
				for (let leg = 1; leg <= sightLeg; leg += 1) {
					assert.equal(commands.length, leg, 'ordinary completion starts the next leg');
					runtime.onActionResult(record, { actionId: commands.at(-1).actionId, state: 'SUCCEEDED',
						reasonCode: leg === sightLeg ? 'TARGET_SEEN' : ordinaryReason,
						actionObservation: { position: { x: 0, y: 64, z: 10 * leg } } });
					await tick();
				}
				const result = await pending;
				assert.equal(commands.length, sightLeg, 'seeing the requested landmark must not dispatch another leg despite movement');
				const status = await runtime.execute(request('actionStatus', { actionId: firstId }), record);
				assert.equal(status.state, 'SUCCEEDED');
				assert.equal(status.reasonCode, 'TARGET_SEEN', 'the original handle retains the terminal sight receipt');
				if (name === 'act' && sightLeg === 1) {
					assert.equal(result.reasonCode, 'TARGET_SEEN');
					assert.equal(result.continuing, undefined);
					assert.deepEqual(result.keepGoing, { stopped: 'TARGET_SEEN' });
				}
			});
		}
	}
}
