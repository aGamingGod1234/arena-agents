import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMinecraftToolCall, toolResultContent, minecraftCapabilities } from '../src/native-minecraft-tools.mjs';
import { buildNativeEventInput, classifyObservationTrigger, nativeObservationSignature } from '../src/dynamic-main.mjs';

const load = { x: 1, y: 64, z: 2, operation: 'load', inventorySlot: 9, count: 8, expectedItemId: 'minecraft:raw_iron', fuelSlot: 10, fuelCount: 1, expectedFuelItemId: 'minecraft:coal', timeoutMs: 5000 };
test('furnace load and take all normalize as one native action each', () => {
	for (const args of [load, { x: 1, y: 64, z: 2, operation: 'take_output', timeoutMs: 5000 }]) {
		const call = normalizeMinecraftToolCall('act', { actionType: 'furnace_transaction', arguments: args });
		assert.deepEqual(call.arguments, args);
	}
	const capability = minecraftCapabilities().actions.find(action => action.actionType === 'furnace_transaction');
	assert.deepEqual(capability.requiredFields, ['x', 'y', 'z', 'operation', 'timeoutMs']);
});
test('furnace load rejects missing or conflicting chosen stacks', () => {
	for (const args of [{ ...load, fuelSlot: 9 }, { ...load, fuelCount: 0 }, { ...load, fuelCount: undefined }, { ...load, inventorySlot: 36 }, { ...load, operation: 'insert_input' }]) {
		assert.throws(() => normalizeMinecraftToolCall('act', { actionType: 'furnace_transaction', arguments: args }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	}
});
test('furnace completion is ordinary model attention and survives compact tool facts', () => {
	const furnaces = [{ dimension: 'minecraft:overworld', x: 1, y: 64, z: 2, state: 'loaded', input: { count: 0 }, fuel: { count: 0 }, output: { itemId: 'minecraft:iron_ingot', count: 8 }, readySequence: 1, message: 'furnace at 1,64,2: 8 minecraft:iron_ingot ready' }];
	assert.deepEqual(classifyObservationTrigger({ attention: true, changedFacts: ['furnaces'] }, { furnaces }), { attention: true, priority: 'ordinary', trigger: 'furnace_ready' });
	const compact = JSON.parse(toolResultContent({ observation: { player: { health: 20 }, furnaces, details: 'x'.repeat(40000) } }).contentItems[0].text);
	assert.deepEqual(compact.observation.furnaces, furnaces);
	const event = buildNativeEventInput({ agentId: 'agent', goalRevision: 1 }, { event: 'observation', trigger: 'furnace_ready', observation: { player: { health: 20 }, furnaces } });
	assert.match(event, /8 minecraft:iron_ingot ready/);
});


test('furnace clock refreshes do not wake idle models but completed counts remain actionable', () => {
	const before = { furnaces: [{ x: 1, state: 'loaded', input: { count: 8 }, observedAtEpochMs: 1000, estimatedReadyAtEpochMs: 81000 }] };
	const after = { furnaces: [{ ...before.furnaces[0], observedAtEpochMs: 2000, estimatedReadyAtEpochMs: 81050 }] };
	assert.equal(nativeObservationSignature(before), nativeObservationSignature(after));
	after.furnaces[0].input = { count: 0 };
	assert.notEqual(nativeObservationSignature(before), nativeObservationSignature({ furnaces: [{ ...after.furnaces[0], input: { count: 0 }, readySequence: 1 }] }));
});
