import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyObservationTrigger, detectMovementLoop, rememberResources, routinePerceptionChange, settleOwnBreak, startOwnBreak } from '../src/dynamic-main.mjs';

const observation = { player: { fire: false }, blocks: [] };

test('actual injury outranks ordinary work, while healing and visible lava are not urgent danger', () => {
	assert.deepEqual(classifyObservationTrigger({ attention: false }, { player: { health: 18 }, blocks: [] }, { previousPlayer: { health: 20 } }), { attention: true, priority: 'urgent', trigger: 'damage' });
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['player.health'] }, { player: { health: 19 } }, { previousPlayer: { health: 18 } }).priority, 'ordinary');
	assert.equal(classifyObservationTrigger({ attention: false }, { player: { inLava: false }, blocks: [{ blockId: 'minecraft:lava' }] }).attention, false);
	assert.equal(classifyObservationTrigger({ attention: false }, { player: { inLava: true } }).trigger, 'lava');
	assert.equal(classifyObservationTrigger({ trigger: 'damage' }, observation).priority, 'urgent');
});

test('movement loop signal requires two repeated positions', () => {
	assert.equal(detectMovementLoop(['0,64,0', '1,64,0', '0,64,0', '1,64,0']), true);
	assert.equal(detectMovementLoop(['0,64,0', '1,64,0', '2,64,0', '3,64,0']), false);
	assert.equal(detectMovementLoop(['0,64,0', '1,64,0', '0,64,0']), false);
});

test('movement loop is promoted to urgent native attention', () => {
	assert.deepEqual(classifyObservationTrigger(
		{ attention: false },
		observation,
		{ movementLoop: true },
	), { attention: true, priority: 'urgent', trigger: 'movement_loop' });
});

test('new observed resource is promoted without misclassifying ordinary heartbeats', () => {
	assert.deepEqual(classifyObservationTrigger(
		{ attention: false },
		observation,
		{ resourceDiscovery: true },
	), { attention: true, priority: 'ordinary', trigger: 'resource_discovery' });
	assert.deepEqual(classifyObservationTrigger({ attention: false }, observation), {
		attention: false,
		priority: 'ordinary',
		trigger: 'observation',
	});
});

test('confirmed exposed faces are quiet while uncertain drops and diagonal blocks stay discoveries', () => {
	const log = (x, y, z) => ({ x, y, z, blockId: 'minecraft:oak_log', tags: ['#minecraft:logs'] });
	const leaves = (x, y, z) => ({ x, y, z, blockId: 'minecraft:oak_leaves', tags: ['#minecraft:leaves'] });
	const state = { resources: new Set(), brokenBlocks: [] };
	assert.equal(rememberResources(state, { observedAtEpochMs: 1_000, blocks: [log(-5, 90, 0)] }), true, 'the first trunk is news');
	assert.equal(rememberResources(state, { observedAtEpochMs: 1_100, blocks: [], landmarks: [log(-5, 90, 0)] }), false, 'the same log seen as a landmark is one sighting');
	startOwnBreak(state, 'break-1', { x: -5, y: 90, z: 0 });
	assert.equal(rememberResources(state, { observedAtEpochMs: 1_950, items: [{ stableId: 'drop-1', itemId: 'minecraft:oak_log', x: -4.6, y: 90.2, z: 0.4 }] }),
		true, 'a drop seen before success is known cannot be suppressed');
	settleOwnBreak(state, 'break-1', true, 2_000, {
		target: { kind: 'block', position: { x: -5, y: 90, z: 0 }, worldChanged: true },
		progress: { value: 1, basis: 'world_mutation', verified: true },
		revealedBlocks: [{ position: { x: -5, y: 91, z: 0 }, blockId: 'minecraft:oak_log', face: 'down' }],
	});
	assert.equal(rememberResources(state, { observedAtEpochMs: 2_500, blocks: [log(-5, 91, 0)] }), false, 'the exact confirmed face above was exposed by the successful break');
	assert.equal(rememberResources(state, { observedAtEpochMs: 2_550, blocks: [leaves(-4, 91, 1)] }, { currentGoal: 'Gather leaves' }), true, 'a goal-relevant diagonal block has no shared face with the removed block');
	assert.equal(rememberResources(state, { observedAtEpochMs: 2_600, blocks: [log(-5, 91, 0)] }), false);
	assert.equal(rememberResources(state, { observedAtEpochMs: 2_700, blocks: [log(12, 90, -14)] }), true, 'a tree away from the work is still news');
	assert.equal(rememberResources(state, { observedAtEpochMs: 2_800, items: [{ stableId: 'drop-2', itemId: 'minecraft:apple', x: 6, y: 90, z: 6 }] }), true, 'a drop elsewhere is still news');
});

test('breaks without confirmed exposure evidence leave unrelated sightings as news', () => {
	const state = { resources: new Set(), brokenBlocks: [] };
	startOwnBreak(state, 'old-break', { x: 0, y: 64, z: 0 });
	settleOwnBreak(state, 'old-break', true, 10_000);
	const diamond = { items: [{ stableId: 'other-player-diamond', itemId: 'minecraft:diamond', x: 0.5, y: 60, z: 0.5 }] };
	assert.equal(rememberResources(state, { observedAtEpochMs: 10_300, ...diamond }), true, 'an item four blocks below the broken block is not its drop');
	const chest = { blocks: [{ x: 1, y: 64, z: 0, blockId: 'minecraft:chest' }] };
	assert.equal(rememberResources(state, { observedAtEpochMs: 60_000, ...chest }), true, 'a chest placed next to an old break is news');
	assert.equal(state.brokenBlocks.length, 0, 'the old break no longer explains anything');

	startOwnBreak(state, 'missed', { x: 20, y: 64, z: 0 });
	settleOwnBreak(state, 'missed', false, 61_000);
	assert.equal(rememberResources(state, { observedAtEpochMs: 61_100, blocks: [{ x: 21, y: 64, z: 0, blockId: 'minecraft:iron_ore' }] }), true, 'a break that failed exposed nothing');

	startOwnBreak(state, 'abandoned', { x: 40, y: 64, z: 0 });
	startOwnBreak(state, 'next', { x: 50, y: 64, z: 0 });
	assert.equal(rememberResources(state, { observedAtEpochMs: 62_000, blocks: [{ x: 41, y: 64, z: 0, blockId: 'minecraft:coal_ore' }] }), true, 'a newer dispatch ends an unanswered break');
});

test('the agent\'s own chat, action echoes and others\' public chat are routine perception', () => {
	const wire = (events) => ({ perception: { latestSequence: events.at(-1).sequence, events } });
	const payload = { attention: true, changedFacts: ['perception'] };
	assert.equal(routinePerceptionChange(payload, wire([{ sequence: 4, type: 'system_message', text: '[Iris] Mining a block' }]), 3, 'Iris'), true);
	assert.equal(routinePerceptionChange(payload, wire([{ sequence: 4, type: 'chat', text: '<Iris> 9/10 logs' }]), 3, 'Iris'), true);
	assert.equal(routinePerceptionChange(payload, wire([{ sequence: 4, type: 'chat', text: '<Axiom> need help' }]), 3, 'Iris'), true, 'public chat is context only (chat policy 2026-10-11)');
	assert.equal(routinePerceptionChange(payload, wire([{ sequence: 4, type: 'chat', text: '<Iris> hi' }, { sequence: 5, type: 'title', text: 'Night' }]), 3, 'Iris'), false);
	assert.equal(routinePerceptionChange(payload, wire([{ sequence: 4, type: 'chat', text: '<Iris> hi' }]), 3), true, 'a public line is context even when the own name is unknown');
});

for (const trigger of ['low_health', 'drowning']) {
	test(`explicit ${trigger} is urgent without a priority annotation`, () => {
		assert.deepEqual(classifyObservationTrigger({ trigger }, observation), { attention: true, priority: 'urgent', trigger });
	});
}
test('an ordinary named wake cannot mask simultaneous injury or lava contact', () => {
	assert.equal(classifyObservationTrigger({ trigger: 'observation' }, { player: { inLava: true } }).trigger, 'lava');
	assert.equal(classifyObservationTrigger({ trigger: 'resource_discovery' }, { player: { health: 18 } }, { previousPlayer: { health: 20 } }).trigger, 'damage');
});
