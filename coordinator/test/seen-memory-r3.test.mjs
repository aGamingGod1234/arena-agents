import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ObservedMemoryStore } from '../src/observed-memory-store.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/seen-memory-r3-wire.json', import.meta.url), 'utf8'));
const owner = { agentId: 'replay', currentGoal: 'gather oak logs' };
// Shared wire fields and entity tuples keep only the recorded samples needed by these regressions.
const readSamples = run => {
	const { base, interactionBase, observationBase, entityRows, entityTypes, samples } = fixtures[run];
	return samples.map(({ atMs, observation }) => ({ atMs, observation: adaptObservation({ ...base, ...observationBase, ...observation,
		world: { ...base.world, ...observation.world },
		...(observation.interaction ? { interaction: { ...interactionBase, ...observation.interaction } } : {}),

		entities: observation.entities.map(index => entityRows[index]).map(([index, count, x, y, z, vx, vy, vz]) => ({ ...entityTypes[index],
			position: { x, y, z }, ...(count === null ? {} : { count }), ...(vx === undefined ? {} : { velocity: { x: vx, y: vy, z: vz } }) })),
	}) }));
};
const pastItems = (memory, observation) => memory.recentlySeen(owner.agentId, observation, owner)?.items ?? [];

for (const [run, obsolete, surviving, mergeAt] of [
	['S5-r3', 'a76c6661-ae53-4911-99bb-0a463372b7da', '96166041-03d2-4f3a-8765-6a719ae14f9d', 52551],
	['S5-r8', 'b3e205ea-934c-4ad1-b196-da9f7312cef3', '2f802948-de71-4a6e-9957-70f2c3ff1a6d', 69213],
]) test(`recorded B/${run} visible merge retires the obsolete UUID at ${mergeAt} ms`, () => {
	const memory = new ObservedMemoryStore();
	const [before, after] = readSamples(run);
	assert.equal(after.atMs, mergeAt);
	assert.equal(before.observation.items.find(row => row.stableId === surviving).count, 1);
	assert.equal(after.observation.items.find(row => row.stableId === surviving).count, 2);
	memory.ingest(owner.agentId, before.observation, { snapshot: false });
	memory.ingest(owner.agentId, after.observation, { snapshot: false });
	assert.ok(!pastItems(memory, after.observation).some(row => row.stableId === obsolete));
	const offView = { ...after.observation, items: [], entities: [], interaction: undefined };
	memory.ingest(owner.agentId, offView, { snapshot: false });
	assert.equal(pastItems(memory, offView).find(row => row.stableId === surviving).count, 2);
	assert.ok(!pastItems(memory, offView).some(row => row.stableId === obsolete));
});

test('recorded B/S5-r8 x2 stack stays historical from 71964 ms until its unchanged 77564 ms sighting', () => {
	const memory = new ObservedMemoryStore();
	const samples = readSamples('S5-r8');
	const before = samples.find(row => row.atMs === 71865).observation;
	const absent = samples.find(row => row.atMs === 71964).observation;
	const reappeared = samples.find(row => row.atMs === 77564).observation;
	const id = '2f802948-de71-4a6e-9957-70f2c3ff1a6d';
	const item = before.items.find(row => row.stableId === id);
	assert.deepEqual(reappeared.items.find(row => row.stableId === id), item);
	assert.equal(absent.items.some(row => row.stableId === id), false);
	memory.ingest(owner.agentId, before, { snapshot: false });
	memory.ingest(owner.agentId, absent, { snapshot: false });
	assert.equal(pastItems(memory, absent).find(row => row.stableId === id)?.count, 2);
	assert.equal(pastItems(memory, { ...absent, observedAtEpochMs: reappeared.observedAtEpochMs - 1 }).find(row => row.stableId === id)?.count, 2);
	memory.ingest(owner.agentId, reappeared, { snapshot: false });
	assert.equal(pastItems(memory, reappeared).some(row => row.stableId === id), false);
	const pickup = samples.find(row => row.atMs === 77765).observation;
	assert.equal(reappeared.inventory.items[0].count, 7);
	assert.equal(pickup.inventory.items[0].count, 9);
});

test('count growth preserves uncertain donors instead of inferring a merge from partial visibility alone', () => {
	const [before, after] = readSamples('S5-r8').map(row => row.observation);
	const donor = before.items.find(row => row.stableId.startsWith('b3e205ea'));
	const stationary = before.entities.find(row => row.stableId === donor.stableId);
	for (const changes of [
		{ before: { entities: before.entities.map(row => row === stationary ? { ...row, velocity: { x: 0.1, y: 0, z: 0 } } : row) } },
		{ after: { continuity: { rememberedSections: ['entities'] } } },
		{ after: { coverage: undefined } },
		{ after: { entities: Array(64).fill({}) } },
		{ after: { items: after.items.map(row => ({ ...row, count: 3 })) } },
		{ before: { items: [...before.items, { ...donor, stableId: 'ambiguous-donor' }] } },
		{ stale: true },
		{ otherScope: true },
	]) {
		const memory = new ObservedMemoryStore();
		memory.ingest(owner.agentId, { ...before, ...changes.before }, { snapshot: false });
		if (changes.stale) memory.ingest(owner.agentId, { ...before, world: { ...before.world, gameTime: before.world.gameTime + 1 }, items: [], entities: [] }, { snapshot: false });
		if (changes.otherScope) memory.ingest(owner.agentId, { ...before, world: { ...before.world, dimension: 'minecraft:the_nether' }, items: [], entities: [] }, { snapshot: false });
		const observation = { ...after, ...changes.after };
		memory.ingest(owner.agentId, observation, { snapshot: false });
		assert.ok(pastItems(memory, observation).some(row => row.stableId === donor.stableId));
	}
});

test('recorded B/S1-r1 airborne hit at 50046 ms does not erase unchanged netherrack at 63,42,68', () => {
	const memory = new ObservedMemoryStore();
	const [before, ray, reappeared] = readSamples('S1-r1');
	const cell = '63,42,68';
	memory.ingest(owner.agentId, before.observation, { snapshot: false });
	assert.equal(ray.atMs, 50046);
	assert.equal(ray.observation.player.onGround, false);
	assert.deepEqual(ray.observation.interaction.rayTarget, { type: 'block', x: 63, y: 42, z: 67, face: 'up', blockId: 'minecraft:netherrack' });
	memory.ingest(owner.agentId, ray.observation, { snapshot: false });
	assert.equal(memory.query(owner.agentId).blocks.find(row => row.key === cell)?.blockId, 'minecraft:netherrack');
	const historical = memory.recentlySeen(owner.agentId, ray.observation, { ...owner, currentGoal: 'mine netherrack' });
	assert.ok(historical.blocks.some(row => row.x === 63 && row.y === 42 && row.z === 68));
	assert.equal(reappeared.atMs, 50545);
	memory.ingest(owner.agentId, reappeared.observation, { snapshot: false });
	assert.equal(memory.query(owner.agentId).blocks.find(row => row.key === cell)?.blockId, 'minecraft:netherrack');
});


test('acknowledged prior pickup retires the consumed UUID without inventing another inventory gain', () => {
	const memory = new ObservedMemoryStore();
	const before = readSamples('S5-r8')[0].observation;
	const drop = before.items[0];
	memory.ingest(owner.agentId, before, { snapshot: false });
	const offView = { ...before, items: [], entities: [], interaction: undefined };
	assert.ok(pastItems(memory, offView).some(row => row.stableId === drop.stableId));
	memory.recordResourceResult(owner.agentId, offView, { actionType: 'pick_up_item', arguments: { targetSelector: drop.stableId },
		state: 'SUCCEEDED', reasonCode: 'ITEM_ALREADY_PICKED_UP' });
	assert.equal(pastItems(memory, offView).some(row => row.stableId === drop.stableId), false);
	assert.deepEqual(offView.inventory, before.inventory, 'historical receipt changes memory, not inventory');
});
