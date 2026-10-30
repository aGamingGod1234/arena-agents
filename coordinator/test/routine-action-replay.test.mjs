import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { FakePlanner, immutableGoalSpec, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/routine-action-replay.json', import.meta.url)));
const config = {
	bridge: { port: 25570, secret: 's'.repeat(32) },
	codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-6-astra', reasoningEffort: 'medium', serviceTier: 'priority' } },
};
// FakePlanner captures the builder input before the provider's production encoder.
const payloadOf = input => decodeModelFacts(JSON.parse(encodeNativeEventInput(input).split('\n')[1]));
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

// Derived contract variants of the recorded low-health moment. The source observations
// remain immutable in the fixture. Only the declared state below changes, with the
// observed action handle replaced by the handle emitted by real tool execution.
const variants = [
	{ id: 'routine-travel-damage', type: 'navigate_to' },
	{ id: 'routine-fight-damage', type: 'fight_target' },
	{ id: 'routine-travel-storm', type: 'navigate_to', storm: true },
	{ id: 'routine-travel-clock-covered', type: 'navigate_to', covered: true },
	{ id: 'routine-travel-reduced-debug', type: 'navigate_to', reducedDebug: true },
	{ id: 'routine-travel-other-handle', type: 'navigate_to', otherHandle: true },
];

for (const variant of variants) test(`${variant.id}: authored arguments reach the production wake`, async () => {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const turns = [];
	const steers = [];
	planner.requestNativeTurn = request => {
		planner.requests.push(request);
		return new Promise(resolve => turns.push(resolve));
	};
	planner.steerNativeTurn = async request => {
		steers.push(typeof request.input === 'function' ? await request.input() : request.input);
		return { turnId: 'routine-replay' };
	};
	const run = await start({ registry, planner, config });
	let pendingAction;
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: {
			operation: 'start', goalRevision: 1, goal: 'Beat Minecraft', goalSpec: immutableGoalSpec('Beat Minecraft'),
		} });
		const previous = structuredClone(fixture.previous);
		const observation = structuredClone(fixture.observation);
		for (const raw of [previous, observation]) {
			raw.goalRevision = 1;
			raw.player.skyOpen = !variant.covered;
			raw.world.dayTime = 11000;
			raw.world.raining = variant.storm === true || variant.covered === true;
			raw.world.thundering = variant.storm === true;
			raw.world.reducedDebugInfo = variant.reducedDebug === true;
			if (variant.covered) {
				raw.inventory.items.push({ itemId: 'minecraft:clock', count: 1, slot: 7, hotbar: true, damage: 0, maxDamage: 0 });
			}
		}
		// Start from the earlier recorded player state, before the derived action dispatch.
		previous.currentAction = { active: false };
		run.bridge.emit('observation', { agentId: 'agent-a', payload: previous });
		await eventually(() => planner.requests.length === 1);
		const destination = { x: observation.position.x + 30, y: observation.position.y, z: observation.position.z + 40 };
		const args = variant.type === 'navigate_to'
			? { ...destination, timeoutMs: 30000 }
			: { targetId: observation.player.lastAttacker.uuid, fleeAtHealth: 6, timeoutMs: 30000 };
		pendingAction = planner.requests[0].executeTool({ agentId: 'agent-a', goalRevision: 1,
			turnId: 'routine-replay', callId: 'start-action', tool: normalizeMinecraftToolCall('act', { actionType: variant.type, arguments: args }) });
		await eventually(() => run.bridge.sent.some(message => message.type === 'action_command'));
		const command = run.bridge.sent.find(message => message.type === 'action_command').payload;
		assert.equal(command.actionType, variant.type);
		const actionId = variant.otherHandle ? 'derived:another-action' : command.actionId;
		const running = { active: true, actionId, actionType: variant.type };
		// An ordered heartbeat establishes health after the model's action dispatch.
		previous.eventSequence += 1;
		previous.currentAction = running;
		previous.attention = false;
		previous.changedFacts = [];
		run.bridge.emit('observation', { agentId: 'agent-a', payload: previous });
		await settle();
		observation.eventSequence = previous.eventSequence + 1;
		observation.currentAction = running;
		run.bridge.emit('observation', { agentId: 'agent-a', payload: observation });
		// The heartbeat can also steer, so wait for the actual damage sample.
		await eventually(() => steers.some(input => payloadOf(input).eventSequence === observation.eventSequence));
		const wake = payloadOf(steers.findLast(input => payloadOf(input).eventSequence === observation.eventSequence)).observation;
		assert.equal(wake.hurtWhileRunning, '11->8');
		if (variant.otherHandle) {
			assert.equal(wake.currentAction.to, undefined, 'no runtime arguments belong to this different handle');
			assert.equal(wake.actionDistance, undefined);
		} else if (variant.type === 'navigate_to') {
			assert.equal(wake.currentAction.to, `${destination.x},${destination.y},${destination.z}`);
			assert.equal(wake.actionDistance, variant.reducedDebug ? undefined : 50);
		} else assert.equal(wake.currentAction.fleeAtHealth, 6);
		if (variant.reducedDebug) assert.equal(wake.player.x, undefined);
		if (variant.storm) assert.equal(wake.world.darkIn, 'unknown');
		if (variant.covered) assert.equal(wake.world.darkIn, undefined);
		if (variant.covered) {
			assert.equal(wake.world.raining, undefined);
			assert.equal(wake.world.thundering, undefined);
			assert.equal(wake.sky, 'sunset', 'carried clock still exposes time');
		}
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: {
			goalRevision: 1, actionId: command.actionId, actionType: variant.type,
			state: 'CANCELLED', reasonCode: 'ACTION_CANCELLED',
		} });
		await pendingAction;
	} finally {
		for (const finish of turns) finish({ status: 'completed', toolCalls: 1 });
		await run.coordinator.stop();
		await pendingAction?.catch(() => {});
	}
});
