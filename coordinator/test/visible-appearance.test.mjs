import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { toolResultContent } from '../src/native-minecraft-tools.mjs';

// Rendered details the Java mod writes only when a mob or block shows something non-default.
const blaze = { uuid: 'blaze-1', type: 'minecraft:blaze', hostile: true, alive: true, position: { x: 4, y: 70, z: 1 }, appearance: { charging: true, airborne: true } };
const crystal = { uuid: 'crystal-1', type: 'minecraft:end_crystal', position: { x: 40, y: 91, z: 0 }, appearance: { caged: true } };
const dragon = { uuid: 'dragon-1', type: 'minecraft:ender_dragon', hostile: true, alive: true, position: { x: 0, y: 70, z: 0 }, appearance: { motion: 'perched' } };
const zombie = { uuid: 'zombie-1', type: 'minecraft:zombie', hostile: true, alive: true, position: { x: 2, y: 64, z: 0 } };
const spawner = { blockId: 'minecraft:spawner', x: 5, y: 65, z: 5, appearance: { mob: 'minecraft:blaze' } };

test('wake events keep mob and spawner appearance as model-visible fields', () => {
	const observation = { inventory: { items: [] }, entities: [blaze, crystal, dragon, zombie], blocks: [spawner, { blockId: 'minecraft:nether_bricks', x: 5, y: 64, z: 5 }] };
	const projected = JSON.parse(buildNativeEventInput({ goalRevision: 1, currentGoal: 'Get blaze rods.' }, { event: 'observation', observation }).split('\n')[1]).observation;
	const byId = Object.fromEntries(projected.entities.map((row) => [row.uuid, row]));
	for (const entity of [blaze, crystal, dragon]) {
		assert.deepEqual(byId[entity.uuid].appearance, entity.appearance, entity.type);
		assert.equal(byId[entity.uuid].omittedFields, undefined, `${entity.type} appearance is not reported as omitted`);
	}
	assert.equal(Object.hasOwn(byId['zombie-1'], 'appearance'), false, 'an ordinary mob gains no appearance bytes');
	const block = projected.blocks.find((row) => row.blockId === 'minecraft:spawner');
	assert.deepEqual(block.appearance, spawner.appearance);
	assert.equal(Object.hasOwn(projected.blocks.find((row) => row.blockId === 'minecraft:nether_bricks'), 'appearance'), false);
});

test('tool results keep appearance on compacted entity and block rows', () => {
	const result = JSON.parse(toolResultContent({ observation: { entities: [blaze, dragon], blocks: [spawner] } }).contentItems[0].text).observation;
	assert.deepEqual(result.entities.find((row) => row.uuid === 'blaze-1').appearance, blaze.appearance);
	assert.deepEqual(result.entities.find((row) => row.uuid === 'dragon-1').appearance, dragon.appearance);
	assert.deepEqual(result.blocks[0].appearance, spawner.appearance);
});

test('sound-only appearance never reaches wakes or tools, including after sight is lost', () => {
	for (const perceivedBy of ['sound', 'sight', 'sound']) {
		const entity = { ...blaze, perceivedBy };
		const observation = { entities: [entity], blocks: [] };
		const wake = JSON.parse(buildNativeEventInput({ goalRevision: 1, currentGoal: 'Observe.' }, { event: 'observation', observation }).split('\n')[1]).observation;
		const tool = JSON.parse(toolResultContent({ observation }).contentItems[0].text).observation;
		for (const projected of [wake, tool]) {
			assert.equal(projected.entities[0].perceivedBy, perceivedBy);
			assert.deepEqual(projected.entities[0].appearance, perceivedBy === 'sight' ? blaze.appearance : undefined);
		}
	}
});
