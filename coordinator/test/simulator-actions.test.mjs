import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { ACTION_FIELDS, MAX_CONVERSATION_LENGTH } from '../src/constants.mjs';
import { validateAction } from '../src/schema.mjs';
import { ActionRuntime, SUPPORTED_SIMULATOR_ACTIONS } from '../src/simulator/action-runtime.mjs';
import { MAX_PLAYER_INVENTORY_ITEMS, VirtualWorld } from '../src/simulator/virtual-world.mjs';

const PLAYER = 'alice';
const MOB = '00000000-0000-4000-8000-000000000001';

function command(actionId, actionType, argumentsValue, overrides = {}) {
	return {
		agentId: PLAYER,
		goalRevision: 1,
		actionId,
		actionType,
		arguments: argumentsValue,
		provenance: {
			provider: 'simulator',
			model: 'fixture',
			reasoningEffort: 'low',
			serviceTier: 'fast',
			programId: 'simulator',
			programVersion: 1,
			sourceStepId: actionId,
			eventSequence: 1,
		},
		...overrides,
	};
}

function world(overrides = {}) {
	return VirtualWorld.fromScenario({
		seed: 7,
		agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true } },
		blocks: [0, 1, 2].map((x) => ({ x, y: 0, z: 0, blockId: 'minecraft:stone' })),
		items: [],
		entities: [],
		...overrides,
	});
}

function run(runtime, simulationWorld, actionId, limit = 200) {
	let result;
	for (let index = 0; index < limit && !result; index += 1) {
		runtime.tick(simulationWorld);
		result = runtime.resultFor(actionId);
	}
	return result;
}

test('action runtime validates exact production action fields and rejects unknown fields', () => {
	assert.deepEqual(ACTION_FIELDS.move_to, ['x', 'y', 'z', 'tolerance', 'sprint']);
	const runtime = new ActionRuntime();
	assert.throws(() => runtime.accept(command('bad', 'move_to', { x: 1, y: 1, z: 0, tolerance: 0.1, sprint: false, extra: true })), /UNKNOWN_FIELD|INVALID_ACTION/);
});

test('movement is a multi-tick action with displacement and a bounded yaw rate', () => {
	const simulationWorld = world();
	const runtime = new ActionRuntime();
	runtime.accept(command('walk', 'move_to', { x: 2, y: 1, z: 0, tolerance: 0.1, sprint: true }));
	const start = simulationWorld.playerState(PLAYER);
	const first = runtime.tick(simulationWorld);
	const afterFirst = simulationWorld.playerState(PLAYER);
	assert.deepEqual(first, []);
	assert.equal(runtime.snapshot().active[0].actionType, 'move_to');
	assert.ok(afterFirst.position.x >= start.position.x, 'movement must displace over ticks');
	assert.ok(Math.abs(afterFirst.yaw - start.yaw) <= 12, 'yaw must be rate limited');
	const result = run(runtime, simulationWorld, 'walk');
	assert.equal(result.state, 'SUCCEEDED');
	assert.ok(simulationWorld.playerState(PLAYER).position.x >= 1.8);
});

test('movement rejects a destination whose actor body intersects a solid block', () => {
	const simulationWorld = world({
		blocks: [
			{ x: 0, y: 0, z: 0, blockId: 'minecraft:stone' },
			{ x: 1, y: 0, z: 0, blockId: 'minecraft:stone' },
			{ x: 2, y: 0, z: 0, blockId: 'minecraft:stone' },
			{ x: 1, y: 1, z: 0, blockId: 'minecraft:stone' },
		],
	});
	const runtime = new ActionRuntime();
	runtime.accept(command('blocked-destination', 'navigate_to', {
		x: 1.2, y: 1, z: 0, tolerance: 1, sprint: false, timeoutMs: 1_000,
	}));
	const result = run(runtime, simulationWorld, 'blocked-destination');
	assert.equal(result.state, 'FAILED');
	assert.equal(result.reasonCode, 'DESTINATION_BLOCKED');
	assert.ok(simulationWorld.playerState(PLAYER).position.x < 1, 'failed movement must not enter the wall');
});

test('movement times out after physics stops the actor at a wall', () => {
	const simulationWorld = world({
		blocks: [0, 1, 2, 3].map((x) => ({ x, y: 0, z: 0, blockId: 'minecraft:stone' })).concat([
			{ x: 1, y: 1, z: 0, blockId: 'minecraft:stone' },
		]),
	});
	const runtime = new ActionRuntime();
	runtime.accept(command('wall-stall', 'navigate_to', {
		x: 3, y: 1, z: 0, tolerance: 0.1, sprint: false, timeoutMs: 1_000,
	}));
	const result = run(runtime, simulationWorld, 'wall-stall');
	assert.equal(result.state, 'TIMED_OUT');
	assert.equal(result.reasonCode, 'ACTION_TIMEOUT');
	assert.ok(simulationWorld.playerState(PLAYER).position.x <= 0.7, 'physics must keep the actor on the near side of the wall');
});

test('mining takes simulated time, then removes the block and creates the declared drop', () => {
	const simulationWorld = world({ blocks: [{ x: 1, y: 1, z: 0, blockId: 'minecraft:stone' }] });
	const runtime = new ActionRuntime();
	runtime.accept(command('mine', 'break_block', { x: 1, y: 1, z: 0, expectedBlockId: 'minecraft:stone', timeoutMs: 1_000 }));
	runtime.tick(simulationWorld);
	assert.ok(simulationWorld.blockAt(1, 1, 0), 'target must remain until mining completes');
	assert.equal(runtime.resultFor('mine'), undefined);
	const result = run(runtime, simulationWorld, 'mine');
	assert.equal(result.state, 'SUCCEEDED');
	assert.equal(simulationWorld.blockAt(1, 1, 0), null);
	assert.equal(simulationWorld.observation(PLAYER).inventory.items.find((item) => item.itemId === 'minecraft:cobblestone')?.count, 1);
});

test('mining needs a clear line from the eye to some point of the block, as in game', () => {
	const floor = [-1, 0, 1, 2, 3].map((x) => ({ x, y: 0, z: 0, blockId: 'minecraft:stone' }));
	const wall = [];
	for (const y of [1, 2, 3]) for (const z of [-1, 0, 1]) wall.push({ x: 1, y, z, blockId: 'minecraft:dirt' });
	const hidden = world({ blocks: [...floor, ...wall, { x: 2, y: 2, z: 0, blockId: 'minecraft:stone' }] });
	const runtime = new ActionRuntime();
	runtime.accept(command('through-wall', 'break_block', { x: 2, y: 2, z: 0, expectedBlockId: 'minecraft:stone', timeoutMs: 1_000 }));
	const blocked = run(runtime, hidden, 'through-wall');
	assert.equal(blocked.state, 'FAILED');
	assert.equal(blocked.reasonCode, 'TARGET_NOT_VISIBLE');
	assert.ok(hidden.blockAt(2, 2, 0) && hidden.blockAt(1, 2, 0), 'target and wall stay');
	assert.deepEqual(hidden.observation(PLAYER).inventory.items, [], 'nothing is credited');

	// One wall block removed at eye height: part of the target's west face shows through the gap, so it is minable.
	const partial = world({ blocks: [...floor, ...wall.filter((block) => !(block.y === 2 && block.z === 0)), { x: 2, y: 2, z: 0, blockId: 'minecraft:stone' }] });
	const partialRuntime = new ActionRuntime();
	partialRuntime.accept(command('through-gap', 'break_block', { x: 2, y: 2, z: 0, expectedBlockId: 'minecraft:stone', timeoutMs: 1_000 }));
	assert.equal(run(partialRuntime, partial, 'through-gap').state, 'SUCCEEDED');

	// A wall placed while mining stops the action before the block breaks.
	const open = world({ blocks: [...floor, { x: 2, y: 2, z: 0, blockId: 'minecraft:stone' }] });
	const openRuntime = new ActionRuntime();
	openRuntime.accept(command('walled-mid-mine', 'break_block', { x: 2, y: 2, z: 0, expectedBlockId: 'minecraft:stone', timeoutMs: 1_000 }));
	openRuntime.tick(open);
	assert.equal(openRuntime.resultFor('walled-mid-mine'), undefined, 'mining is under way');
	for (const block of wall) open.addBlock(block);
	const stopped = run(openRuntime, open, 'walled-mid-mine');
	assert.equal(stopped.reasonCode, 'TARGET_NOT_VISIBLE');
	assert.ok(open.blockAt(2, 2, 0), 'the target survives');
});

test('mining finds the reachable and visible parts the server would aim at', () => {
	const mine = (position, blocks, target) => {
		const simulationWorld = world({ agents: { [PLAYER]: { position, onGround: true } }, blocks });
		const runtime = new ActionRuntime();
		runtime.accept(command('parity', 'break_block', { ...target, expectedBlockId: 'minecraft:stone', timeoutMs: 1_000 }));
		return run(runtime, simulationWorld, 'parity');
	};
	// Only the point of the west face nearest the eye is within 4.5 blocks; the face middle and a fixed grid are not.
	const far = mine({ x: -0.4999, y: 1, z: 0.5 }, [{ x: -1, y: 0, z: 0, blockId: 'minecraft:stone' }, { x: 4, y: 2, z: 0, blockId: 'minecraft:stone' }], { x: 4, y: 2, z: 0 });
	assert.equal(far.reasonCode, 'BROKEN', 'the nearest reachable face point counts');
	// A block above the gap hides all of the target but a strip about 0.05 blocks high along the bottom of its west face.
	const strip = mine({ x: 0.3, y: 1, z: 0.5 }, [
		{ x: 0, y: 0, z: 0, blockId: 'minecraft:stone' }, { x: 3, y: 0, z: 0, blockId: 'minecraft:stone' }, { x: 2, y: 1, z: 0, blockId: 'minecraft:stone' },
	], { x: 3, y: 0, z: 0 });
	assert.equal(strip.reasonCode, 'BROKEN', 'a thin exposed strip counts');
	const out = mine({ x: -0.6, y: 1, z: 0.5 }, [{ x: -1, y: 0, z: 0, blockId: 'minecraft:stone' }, { x: 4, y: 2, z: 0, blockId: 'minecraft:stone' }], { x: 4, y: 2, z: 0 });
	assert.equal(out.reasonCode, 'TARGET_TOO_FAR', 'past reach still fails');
});

test('mining judges the shared server parity cases as the server does', () => {
	// TargetSightlineVerification checks the server's TargetSightline.block against the same file.
	const { cases } = JSON.parse(readFileSync(new URL('./fixtures/mining-sightline-parity.json', import.meta.url), 'utf8'));
	assert.ok(cases.length >= 9);
	for (const entry of cases) {
		const [x, y, z] = entry.feet;
		const [tx, ty, tz] = entry.target;
		const simulationWorld = VirtualWorld.fromScenario({
			seed: 7,
			agents: { [PLAYER]: { position: { x, y, z }, onGround: true, gameMode: entry.gameMode } },
			blocks: [...entry.blocks, entry.target].map(([bx, by, bz]) => ({ x: bx, y: by, z: bz, blockId: 'minecraft:stone' })),
			items: [],
			entities: [],
		});
		// One finished mining tick, with the body held exactly where the server case puts the eye.
		const result = simulationWorld.performSimulationAction(PLAYER, { type: 'break_block', arguments: { x: tx, y: ty, z: tz, expectedBlockId: 'minecraft:stone', timeoutMs: 1_000 } }, { elapsedTicks: 100 });
		assert.equal(result.reasonCode === 'BROKEN', entry.visible, `${entry.name}: ${result.reasonCode}`);
	}
});

test('select_item selects equivalent stacks and refuses differing durability, as the server does', () => {
	const held = (items, gameMode = 'survival') => world({ agents: { [PLAYER]: {
		position: { x: 0, y: 1, z: 0 }, onGround: true, gameMode,
		inventory: { items, selectedItem: 'minecraft:stick' },
	} } });
	const select = (simulationWorld, itemId) => {
		const runtime = new ActionRuntime();
		runtime.accept(command(`select-${itemId}`, 'select_item', { itemId }));
		return run(runtime, simulationWorld, `select-${itemId}`);
	};
	const empty = held([{ itemId: 'minecraft:stick', count: 1, slot: 0 }]);
	const missing = select(empty, 'minecraft:diamond_sword');
	assert.equal(missing.reasonCode, 'ITEM_NOT_FOUND');
	assert.equal(empty.observation(PLAYER).inventory.selectedItem, 'minecraft:stick', 'a failed selection keeps the held item');
	const owned = held([{ itemId: 'minecraft:stick', count: 1, slot: 0 }, { itemId: 'minecraft:diamond_sword', count: 1, slot: 2 }]);
	assert.equal(select(owned, 'minecraft:diamond_sword').state, 'SUCCEEDED');
	assert.equal(owned.observation(PLAYER).inventory.selectedItem, 'minecraft:diamond_sword');
	assert.equal(select(held([{ itemId: 'minecraft:diamond_sword', count: 1, slot: 12 }]), 'minecraft:diamond_sword').reasonCode, 'ITEM_NOT_IN_HOTBAR');
	assert.equal(select(held([{ itemId: 'minecraft:diamond_sword', count: 0, slot: 1 }]), 'minecraft:diamond_sword').reasonCode, 'ITEM_NOT_FOUND');
	assert.equal(select(held([{ itemId: 'minecraft:torch', count: 4, slot: 1 }, { itemId: 'minecraft:torch', count: 4, slot: 3 }]), 'minecraft:torch').state, 'SUCCEEDED');
	assert.equal(select(held([{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0, damage: 0 }, { itemId: 'minecraft:stone_pickaxe', count: 1, slot: 1, damage: 10 }]), 'minecraft:stone_pickaxe').reasonCode, 'AMBIGUOUS_ITEM');
	for (const components of [
		{ 'minecraft:custom_name': 'Named blade' },
		{ 'minecraft:enchantments': { 'minecraft:sharpness': 3 } },
		{ 'minecraft:custom_data': { owner: 'agent', values: [1, 2] } },
	]) {
		const items = [{ itemId: 'minecraft:diamond_sword', count: 1, slot: 0, components },
			{ itemId: 'minecraft:diamond_sword', count: 2, slot: 1, components: {} }];
		assert.equal(select(held(items), 'minecraft:diamond_sword').reasonCode, 'AMBIGUOUS_ITEM', 'distinct components require an exact slot');
		items[1].components = structuredClone(components);
		assert.equal(select(held(items), 'minecraft:diamond_sword').state, 'SUCCEEDED', 'identical components remain interchangeable across counts');
	}
	const reordered = held([
		{ itemId: 'minecraft:diamond_sword', count: 1, slot: 0, components: { name: 'a', enchantments: { a: 1, b: 2 } } },
		{ itemId: 'minecraft:diamond_sword', count: 1, slot: 1, components: { enchantments: { b: 2, a: 1 }, name: 'a' } },
	]);
	assert.equal(select(reordered, 'minecraft:diamond_sword').state, 'SUCCEEDED', 'component map key order does not change equality');

	const creative = held([], 'creative');
	assert.equal(select(creative, 'minecraft:diamond_sword').state, 'SUCCEEDED', 'creative takes an absent item');
	assert.deepEqual(creative.observation(PLAYER).inventory.items.map(({ itemId, count, slot }) => ({ itemId, count, slot })),
		[{ itemId: 'minecraft:diamond_sword', count: 1, slot: 0 }], 'into the empty selected hotbar slot, as a real stack');
	const occupied = held([{ itemId: 'minecraft:stick', count: 1, slot: 0 }], 'creative');
	assert.equal(select(occupied, 'minecraft:diamond_sword').reasonCode, 'HOTBAR_SLOT_OCCUPIED', 'creative cannot take an item into an occupied slot');
	assert.equal(occupied.observation(PLAYER).inventory.selectedItem, 'minecraft:stick', 'the failure keeps the held stick');
	assert.equal(occupied.observation(PLAYER).inventory.items.length, 1, 'and adds no stack');
});

test('crafting consumes one recipe and emits its full batch', () => {
	const simulationWorld = world({ agents: { [PLAYER]: {
		position: { x: 0, y: 1, z: 0 },
		onGround: true,
		inventory: { items: [{ itemId: 'minecraft:oak_log', count: 2, slot: 0 }] },
	} } });
	const runtime = new ActionRuntime();
	runtime.accept(command('craft', 'craft_inventory', { recipeId: 'minecraft:planks', count: 1, timeoutMs: 1_000 }));
	const result = run(runtime, simulationWorld, 'craft');
	assert.equal(result.state, 'SUCCEEDED');
	const items = simulationWorld.observation(PLAYER).inventory.items;
	assert.equal(items.find((item) => item.itemId === 'minecraft:oak_log')?.count ?? 0, 1);
	assert.equal(items.find((item) => item.itemId === 'minecraft:oak_planks')?.count, 4);
});

test('placement consumes the item and verifies the final block postcondition', () => {
	const simulationWorld = world({ agents: { [PLAYER]: {
		position: { x: 0, y: 1, z: 0 },
		onGround: true,
		inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 1, slot: 0 }] },
	} } });
	const runtime = new ActionRuntime();
	runtime.accept(command('place', 'place_block', { x: 1, y: 1, z: 0, face: 'up', itemId: 'minecraft:cobblestone' }));
	const result = run(runtime, simulationWorld, 'place');
	assert.equal(result.state, 'SUCCEEDED');
	assert.equal(simulationWorld.blockAt(1, 1, 0).blockId, 'minecraft:cobblestone');
	assert.equal(simulationWorld.observation(PLAYER).inventory.items.find((item) => item.itemId === 'minecraft:cobblestone')?.count ?? 0, 0);
});

test('combat uses cooldown-limited hits and shield mitigation', () => {
	const simulationWorld = world({
		agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true } },
		entities: [{ id: MOB, type: 'minecraft:zombie', position: { x: 1, y: 1, z: 0 }, health: 10, maxHealth: 10 }],
	});
	const runtime = new ActionRuntime();
	runtime.accept(command('shield', 'block_with_shield', { durationMs: 200 }));
	runtime.tick(simulationWorld);
	const before = simulationWorld.playerState(PLAYER).health;
	simulationWorld.damage(PLAYER, 4, { uuid: MOB, type: 'minecraft:zombie', distance: 1 });
	assert.ok(simulationWorld.playerState(PLAYER).health >= before - 2, 'shield must mitigate damage');
	runtime.cancel('shield');
	runtime.accept(command('attack', 'attack', { targetId: MOB, timeoutMs: 1_000 }));
	const result = run(runtime, simulationWorld, 'attack', 100);
	assert.equal(result.state, 'SUCCEEDED');
	assert.ok(simulationWorld.entityState(MOB).health < 10);
});

test('death and respawn use the recorded checkpoint, and timeout is measured in virtual ticks', () => {
	const simulationWorld = world({ agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true, health: 1 } } });
	simulationWorld.recordCheckpoint(PLAYER, { x: 8, y: 1, z: 8 });
	simulationWorld.damage(PLAYER, 5);
	const runtime = new ActionRuntime();
	runtime.accept(command('respawn', 'respawn', {}));
	const respawnResult = run(runtime, simulationWorld, 'respawn');
	assert.equal(respawnResult.state, 'SUCCEEDED');
	assert.deepEqual(simulationWorld.playerState(PLAYER).position, { x: 8, y: 1, z: 8 });

	const stalled = new ActionRuntime();
	stalled.accept(command('timeout', 'navigate_to', { x: 50, y: 1, z: 0, tolerance: 0.1, sprint: false, timeoutMs: 1 }));
	const timedOut = run(stalled, simulationWorld, 'timeout', 10);
	assert.equal(timedOut.state, 'TIMED_OUT');
	assert.equal(timedOut.reasonCode, 'ACTION_TIMEOUT');
});

test('cancellation fences stale completion and unsupported actions fail explicitly', () => {
	const simulationWorld = world();
	const runtime = new ActionRuntime();
	runtime.accept(command('cancel-me', 'navigate_to', { x: 30, y: 1, z: 0, tolerance: 0.1, sprint: false, timeoutMs: 1_000 }));
	runtime.tick(simulationWorld);
	assert.equal(runtime.cancel('cancel-me').state, 'CANCELLED');
	runtime.tick(simulationWorld);
	assert.equal(runtime.resultFor('cancel-me').state, 'CANCELLED');
	runtime.accept(command('unknown', 'set_door', { x: 1, y: 1, z: 0, open: true }));
	runtime.tick(simulationWorld);
	assert.equal(runtime.resultFor('unknown').reasonCode, 'SIMULATOR_UNSUPPORTED_ACTION');
});

test('mining keeps the target block and inventory bytes unchanged when its drop cannot fit', () => {
	const inventory = Array.from({ length: MAX_PLAYER_INVENTORY_ITEMS }, (_, slot) => ({ itemId: `minecraft:fixture_${slot}`, count: 1, slot }));
	const simulationWorld = world({
		agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true, inventory: { items: inventory } } },
		blocks: [{ x: 0, y: 0, z: 0, blockId: 'minecraft:stone' }, { x: 1, y: 1, z: 0, blockId: 'minecraft:stone' }],
	});
	const before = simulationWorld.inventories(PLAYER);
	const runtime = new ActionRuntime();
	runtime.accept(command('full-mine', 'break_block', { x: 1, y: 1, z: 0, expectedBlockId: 'minecraft:stone', timeoutMs: 1_000 }));
	const result = run(runtime, simulationWorld, 'full-mine');
	assert.equal(result.state, 'FAILED');
	assert.equal(result.reasonCode, 'WORLD_CAPACITY_EXCEEDED');
	assert.deepEqual(simulationWorld.blockAt(1, 1, 0).blockId, 'minecraft:stone');
	assert.deepEqual(simulationWorld.inventories(PLAYER), before);
});

test('crafting restores exact inventory bytes when output insertion fails at capacity', () => {
	const inventory = [{ itemId: 'minecraft:oak_log', count: 1, slot: 0 }, ...Array.from({ length: MAX_PLAYER_INVENTORY_ITEMS - 1 }, (_, index) => ({ itemId: `minecraft:fixture_${index}`, count: 1, slot: index + 1 }))];
	const simulationWorld = world({ agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true, inventory: { items: inventory } } } });
	const before = simulationWorld.inventories(PLAYER);
	const originalAdd = simulationWorld.addInventoryItem.bind(simulationWorld);
	simulationWorld.addInventoryItem = (agentId, itemId, count) => itemId === 'minecraft:oak_planks' ? (() => { throw Object.assign(new Error('fixture output capacity'), { code: 'WORLD_CAPACITY_EXCEEDED' }); })() : originalAdd(agentId, itemId, count);
	const runtime = new ActionRuntime();
	runtime.accept(command('full-craft', 'craft_inventory', { recipeId: 'minecraft:planks', count: 4, timeoutMs: 1_000 }));
	const result = run(runtime, simulationWorld, 'full-craft');
	assert.equal(result.state, 'FAILED');
	assert.deepEqual(simulationWorld.inventories(PLAYER), before);
});

test('placement requires solid face support and an authoritative desired state without consuming on failure', () => {
	const simulationWorld = world({ agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true, inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 1, slot: 0 }] } } } });
	const before = simulationWorld.inventories(PLAYER);
	const unsupported = new ActionRuntime();
	unsupported.accept(command('bad-support', 'place_block', { x: 4, y: 1, z: 0, face: 'up', itemId: 'minecraft:cobblestone' }));
	const unsupportedResult = run(unsupported, simulationWorld, 'bad-support');
	assert.equal(unsupportedResult.reasonCode, 'PLACEMENT_UNSUPPORTED');
	assert.deepEqual(simulationWorld.inventories(PLAYER), before);

	const mismatchWorld = world({ agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true, inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 1, slot: 0 }] } } } });
	const originalBlockAt = mismatchWorld.blockAt.bind(mismatchWorld);
	mismatchWorld.blockAt = (...args) => {
		const block = originalBlockAt(...args);
		return block?.blockId === 'minecraft:cobblestone' ? { ...block, desiredState: 'mismatch' } : block;
	};
	const mismatch = new ActionRuntime();
	mismatch.accept(command('bad-state', 'place_block', { x: 1, y: 1, z: 0, face: 'up', itemId: 'minecraft:cobblestone', desiredState: 'facing=north' }));
	const mismatchResult = run(mismatch, mismatchWorld, 'bad-state');
	assert.equal(mismatchResult.reasonCode, 'PLACEMENT_STATE_MISMATCH');
	assert.equal(mismatchWorld.blockAt(1, 1, 0), null);
	assert.equal(mismatchWorld.inventories(PLAYER).items.find((item) => item.itemId === 'minecraft:cobblestone')?.count, 1);
});

test('placement treats null desiredState as absent and rolls back normalize or insert failures exactly', () => {
	const simulationWorld = world({ agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true, inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 1, slot: 0 }] } } } });
	const runtime = new ActionRuntime();
	runtime.accept(command('place-null-state', 'place_block', { x: 1, y: 1, z: 0, face: 'up', itemId: 'minecraft:cobblestone', desiredState: null }));
	const result = run(runtime, simulationWorld, 'place-null-state');
	assert.equal(result.state, 'SUCCEEDED');
	assert.equal(simulationWorld.blockAt(1, 1, 0).desiredState, undefined);
	assert.equal(simulationWorld.inventories(PLAYER).items.find((item) => item.itemId === 'minecraft:cobblestone')?.count ?? 0, 0);

	const invalidWorld = world({ agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true, inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 1, slot: 0 }] } } } });
	const beforeInvalid = invalidWorld.inventories(PLAYER);
	assert.throws(() => invalidWorld.performSimulationAction(PLAYER, { type: 'place_block', arguments: { x: 1, y: 1, z: 0, face: 'up', itemId: 'minecraft:cobblestone', desiredState: '' } }), /desiredState/);
	assert.deepEqual(invalidWorld.inventories(PLAYER), beforeInvalid);
	assert.equal(invalidWorld.blockAt(1, 1, 0), null);

	const fullWorld = world({
		agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true, inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 1, slot: 0 }] } } },
		blocks: Array.from({ length: 256 }, (_, index) => ({ x: index, y: 0, z: 0, blockId: 'minecraft:stone' })),
	});
	const beforeInsert = fullWorld.inventories(PLAYER);
	const insertResult = fullWorld.performSimulationAction(PLAYER, { type: 'place_block', arguments: { x: 255, y: 1, z: 0, face: 'up', itemId: 'minecraft:cobblestone', desiredState: null } });
	assert.equal(insertResult.reasonCode, 'WORLD_CAPACITY_EXCEEDED');
	assert.deepEqual(fullWorld.inventories(PLAYER), beforeInsert);
	assert.equal(fullWorld.blockAt(255, 1, 0), null);
});

test('direct messages accept the production code-point maximum and reject one beyond it', () => {
	const simulationWorld = world();
	const maximum = '😀'.repeat(MAX_CONVERSATION_LENGTH);
	assert.equal([...maximum].length, MAX_CONVERSATION_LENGTH);
	const action = { type: 'chat', message: maximum, audience: 'direct', recipientId: MOB };
	const overMaximum = `${maximum}${[...maximum][0]}`;
	assert.doesNotThrow(() => validateAction(action));
	assert.throws(() => validateAction({ ...action, message: overMaximum }), /OUT_OF_RANGE|MAX_CONVERSATION_LENGTH|message/);
	assert.equal(simulationWorld.recordDirectMessage(PLAYER, 'bob', maximum).message, maximum);
	assert.throws(() => simulationWorld.recordDirectMessage(PLAYER, 'bob', `${maximum}😀`), /MESSAGE_TOO_LARGE/);
});

test('every production action type is implemented or terminates with an explicit simulator failure', () => {
	const uuid = MOB;
	const inputFrame = { forward: 1, strafe: 0, jump: false, sneak: false, sprint: true, attack: false, use: false, yaw: 0, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 1 };
	const validArguments = {
		move_to: { x: 1, y: 1, z: 0, tolerance: 0.1, sprint: false },
		control: inputFrame,
		control_sequence: { frames: [inputFrame], maxTicks: 1 },
		look_at: { x: 1, y: 1, z: 0 },
		attack: { targetId: uuid, timeoutMs: 1_000 },
		fight_target: { targetId: uuid, timeoutMs: 1_000, fleeAtHealth: 6 },
		fight_until: { mob: 'minecraft:zombie', untilItem: 'minecraft:rotten_flesh', untilCount: 1, timeoutMs: 1_000 },
		flee_from: { targetId: uuid, distance: 8, timeoutMs: 1_000 },
		select_item: { itemId: 'minecraft:stick' },
		use_item: { durationMs: 1 },
		break_block: { x: 1, y: 1, z: 0, expectedBlockId: 'minecraft:stone', timeoutMs: 1_000 },
		pick_up_item: { targetSelector: uuid },
		place_block: { x: 1, y: 1, z: 0, face: 'up', itemId: 'minecraft:cobblestone' },
		chat: { message: 'hi', audience: 'direct', recipientId: uuid },
		wait: { durationMs: 1 },
		set_door: { x: 1, y: 1, z: 0, open: true },
		drop_item: { slot: 0, count: 1 },
		navigate_to: { x: 1, y: 1, z: 0, tolerance: 0.1, sprint: false, timeoutMs: 1_000 },
		build_shelter: { x: 0, y: 1, z: 0, opening: 'east', itemId: 'minecraft:cobblestone', timeoutMs: 1_000 },
		dig_to: { pattern: 'stairs_down', y: -10, timeoutMs: 1_000 },
		cast_obsidian: { x: 0, y: 1, z: 0, frame: true, timeoutMs: 1_000 },
		barter_until: { itemId: 'minecraft:ender_pearl', count: 1, timeoutMs: 1_000 },
		travel_to: { x: 1, z: 0, tolerance: 1, timeoutMs: 1_000 },
		transfer_container: { x: 1, y: 1, z: 0, sourceKind: 'player', sourceSlot: 0, destinationKind: 'container', destinationSlot: 0, count: 1, expectedItemId: 'minecraft:stick', timeoutMs: 1_000 },
		craft_inventory: { recipeId: 'minecraft:planks', count: 1, timeoutMs: 1_000 },
		craft_table: { recipeId: 'minecraft:planks', x: 1, y: 0, z: 0, count: 1, timeoutMs: 1_000 },
		furnace_transaction: { x: 1, y: 0, z: 0, operation: 'insert_input', inventorySlot: 0, count: 1, expectedItemId: 'minecraft:stick', timeoutMs: 1_000 },
		equip_item: { sourceSlot: 0, targetSlot: 'head', expectedItemId: 'minecraft:stick' },
		select_tool: { sourceSlot: 0, hotbarSlot: 0, expectedItemId: 'minecraft:stick', minRemainingDurability: 0 },
		block_with_shield: { durationMs: 1 },
		use_ranged: { targetId: uuid, drawDurationMs: 1, timeoutMs: 1_000 },
		interact_block: { x: 1, y: 0, z: 0, face: 'up', hand: 'main', expectedItemId: 'minecraft:stick' },
		interact_entity: { targetId: uuid, hand: 'main', expectedItemId: 'minecraft:stick' },
		dismount: {},
		start_fall_flying: {},
		wake_up: {},
		set_flight: { enabled: true },
		write_sign: { x: 1, y: 1, z: 0, front: true, lines: ['marker', '', '', ''], expectedLines: ['', '', '', ''] },
		edit_book: { slot: 0, pages: ['field notes'], expectedFingerprint: 'fixture-fingerprint' },
		menu_click: { menuId: 'menu', containerId: 1, stateId: 0, slot: 0, button: 0, clickType: 'PICKUP', expectedItemId: 'minecraft:stick', expectedCount: 1 },
		menu_close: { menuId: 'menu', containerId: 1, stateId: 0 },
		beacon_effects: { menuId: 'menu', containerId: 1, stateId: 0, primaryEffectId: 'minecraft:speed', secondaryEffectId: 'minecraft:regeneration' },
		menu_transfer: { menuId: 'menu', sourceSlot: 0, destinationSlot: 1, count: 1, expectedItemId: 'minecraft:stick', timeoutMs: 1_000 },
		menu_button: { menuId: 'menu', buttonId: 0, timeoutMs: 1_000 },
		anvil_rename: { menuId: 'menu', name: 'name', timeoutMs: 1_000 },
		respawn: {},
	};
	assert.deepEqual(Object.keys(validArguments).sort(), Object.keys(ACTION_FIELDS).sort(), 'each production action needs a valid fixture before simulator support can be evaluated');
	for (const actionType of Object.keys(ACTION_FIELDS)) {
		const simulationWorld = world({ entities: [{ id: uuid, type: 'minecraft:zombie', position: { x: 1, y: 1, z: 0 }, health: 3, maxHealth: 3 }], blocks: [{ x: 0, y: 0, z: 0, blockId: 'minecraft:stone' }, { x: 1, y: 0, z: 0, blockId: 'minecraft:crafting_table' }, { x: 1, y: 1, z: 0, blockId: 'minecraft:stone' }], agents: { [PLAYER]: { position: { x: 0, y: 1, z: 0 }, onGround: true, inventory: { items: [{ itemId: 'minecraft:stick', count: 4, slot: 0 }, { itemId: 'minecraft:cobblestone', count: 4, slot: 1 }, { itemId: 'minecraft:oak_log', count: 4, slot: 2 }] } } } });
		const runtime = new ActionRuntime();
		const actionId = `coverage-${actionType}`;
		runtime.accept(command(actionId, actionType, validArguments[actionType]));
		runtime.tick(simulationWorld);
		if (runtime.resultFor(actionId) === undefined) runtime.cancel(actionId);
		const result = runtime.resultFor(actionId);
		assert.ok(result && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(result.state), `${actionType} must terminate or be explicitly cancellable`);
		if (!SUPPORTED_SIMULATOR_ACTIONS.includes(actionType)) assert.equal(result.reasonCode, 'SIMULATOR_UNSUPPORTED_ACTION', `${actionType} must not silently succeed`);
	}
});
