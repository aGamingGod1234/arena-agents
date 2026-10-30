import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { gradeSample } from '../src/decision-eval/grade.mjs';
import { callMatches, buildContext } from '../src/decision-eval/match.mjs';
import { blockDrop, canonicalCall, collectsWithoutRoom, inventoryHasRoom } from '../src/decision-eval/predicates.mjs';
import { validatePredicate } from '../src/decision-eval/schema.mjs';

// Review r2 (P1-1): predicates decide only unambiguous outcomes; everything else is undecided and goes to the judge
// (verdict needs_judge, every train case carries a rubric). The calls below are the reviewer's exact reproductions
// (q8-r2-predicate-repro.mjs / q8-r2-predicate-audit.jsonl), graded on the real train fixtures.

const trainDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'decision-eval', 'train');
const cases = new Map(fs.readdirSync(trainDir).filter((name) => name.endsWith('.json'))
	.flatMap((name) => JSON.parse(fs.readFileSync(path.join(trainDir, name), 'utf8')).cases).map((c) => [c.id, c]));
const byId = (id) => { const c = cases.get(id); assert.ok(c, `fixture ${id}`); return c; };
const act = (actionType, args) => ({ name: 'act', args: { actionType, arguments: args } });
const call = (name, args) => ({ name, args });
const grade = (id, calls) => gradeSample(byId(id), { calls });
const verdict = (id, calls) => grade(id, calls).verdict;
// The reviewer's calls must be valid production calls, otherwise grading ignores them.
const accepted = (calls) => calls.every((c) => !canonicalCall(c).normalizeError);

test('failure-reason-contrast-05: only freeing the occupied hotbar slot 5 or swapping the porkchop into it is a hard good', () => {
	const dropFood = [act('drop_item', { slot: 10, count: 1 })];
	assert.ok(accepted(dropFood));
	assert.equal(verdict('failure-reason-contrast-05', dropFood), 'bad', 'dropping the requested food is discarding food, not good');
	const chicken = [act('select_tool', { sourceSlot: 9, hotbarSlot: 5, expectedItemId: 'minecraft:chicken', minRemainingDurability: 0 })];
	assert.ok(accepted(chicken));
	assert.equal(verdict('failure-reason-contrast-05', chicken), 'needs_judge', 'another source into the same occupied slot is not good');
	assert.equal(verdict('failure-reason-contrast-05', [act('drop_item', { slot: 5, count: 2 })]), 'good', 'dropping the feathers frees slot 5');
	const swap = [act('menu_click', { menuId: 'minecraft:inventory', containerId: 0, stateId: 0, slot: 10, button: 5, clickType: 'SWAP', expectedItemId: 'minecraft:porkchop', expectedCount: 1 })];
	assert.ok(accepted(swap));
	assert.equal(verdict('failure-reason-contrast-05', swap), 'good', 'SWAP of the porkchop slot with hotbar button 5');
	assert.equal(verdict('failure-reason-contrast-05', [act('select_tool', { sourceSlot: 10, hotbarSlot: 5, expectedItemId: 'minecraft:porkchop', minRemainingDurability: 0 })]), 'bad', 'the identical retry');
});

test('failure-reason-contrast-07: equipping a sword to the offhand is not good; moving the crafting table into the hotbar is', () => {
	const offhand = [act('equip_item', { sourceSlot: 5, targetSlot: 'offhand', expectedItemId: 'minecraft:iron_sword' })];
	assert.ok(accepted(offhand));
	assert.equal(verdict('failure-reason-contrast-07', offhand), 'needs_judge');
	assert.equal(verdict('failure-reason-contrast-07', [act('menu_click', { menuId: 'minecraft:inventory', containerId: 0, stateId: 0, slot: 9, button: 3, clickType: 'SWAP', expectedItemId: 'minecraft:crafting_table', expectedCount: 1 })]), 'good');
});

test('failure-reason-contrast-03: mining a far unrelated block is undecided; the reported block id is good', () => {
	const far = [call('mine', { x: 2000, y: 85, z: 2000, expectedBlockId: 'minecraft:grass_block' })];
	assert.ok(accepted(far));
	assert.equal(verdict('failure-reason-contrast-03', far), 'needs_judge');
	assert.equal(verdict('failure-reason-contrast-03', [call('mine', { x: 2, y: 85, z: -8, expectedBlockId: 'minecraft:grass_block' })]), 'good');
	assert.equal(verdict('failure-reason-contrast-03', [call('mine', { x: 2, y: 85, z: -8, expectedBlockId: 'minecraft:dirt' })]), 'bad', 'the identical retry');
});

test('unreachable-target-01: mining far unrelated stone is undecided; a larger arrival area at the same place is good', () => {
	const far = [call('mine', { x: 2000, y: 90, z: 2000, expectedBlockId: 'minecraft:stone' })];
	assert.ok(accepted(far));
	assert.equal(verdict('unreachable-target-01', far), 'needs_judge');
	assert.equal(verdict('unreachable-target-01', [call('moveTo', { x: -4.5, y: 91, z: 4.5, tolerance: 3 })]), 'good');
	assert.equal(verdict('unreachable-target-01', [call('moveTo', { x: -4.5, y: 91, z: 4.5, tolerance: 1.5 })]), 'bad', 'the identical move');
});

test('failed-interaction-retry-02: dropping an arbitrary carried resource is not good', () => {
	const drop = [act('drop_item', { slot: 0, count: 1 })];
	assert.ok(accepted(drop));
	assert.notEqual(verdict('failed-interaction-retry-02', drop), 'good');
	assert.equal(verdict('failed-interaction-retry-02', drop), 'needs_judge');
});

test('failure-reason-contrast-01: mine with autoAim at the failed birch log (crosshair mismatch, in reach) is good', () => {
	const aimed = [call('mine', { x: -8, y: 81, z: 15, expectedBlockId: 'minecraft:birch_log', autoAim: true })];
	assert.ok(accepted(aimed));
	assert.equal(verdict('failure-reason-contrast-01', aimed), 'good');
	assert.equal(verdict('failure-reason-contrast-01', [call('mine', { x: -8, y: 81, z: 15, expectedBlockId: 'minecraft:birch_log' })]), 'bad', 'the plain identical retry');
	assert.equal(verdict('failure-reason-contrast-01', [call('mine', { x: -10, y: 81, z: 12, expectedBlockId: 'minecraft:birch_log', autoAim: true })]), 'needs_judge', 'another log off the sight line is an alternative target for the judge');
});

test('wrong-tool-01/02: a 3x3 pickaxe recipe in the 2x2 grid is not good; at a placed table it is', () => {
	for (const id of ['wrong-tool-01', 'wrong-tool-02']) {
		const grid = [act('craft_inventory', { recipeId: 'minecraft:stone_pickaxe', count: 1, timeoutMs: 10000 })];
		assert.ok(accepted(grid));
		assert.equal(verdict(id, grid), 'needs_judge', `${id} 2x2 grid`);
		const p = byId(id).state.observation.position;
		const x = Math.floor(p.x) + 1, y = Math.floor(p.y), z = Math.floor(p.z);
		const atTable = [call('sequence', { actions: [
			{ actionType: 'place_block', arguments: { x, y, z, face: 'up', itemId: 'minecraft:crafting_table' } },
			{ actionType: 'craft_table', arguments: { recipeId: 'minecraft:stone_pickaxe', count: 1, x, y, z, timeoutMs: 10000 } },
		] })];
		assert.ok(accepted(atTable));
		assert.equal(verdict(id, atTable), 'good', `${id} table`);
	}
	assert.equal(verdict('wrong-tool-01', [call('mine', { x: 332, y: 82, z: 365, expectedBlockId: 'minecraft:coal_ore' })]), 'bad', 'mining coal with no pickaxe');
});

test('inventory-full-06: mining stone whose cobblestone fits the 9/64 stack is not bad; mining grass whose dirt cannot fit is', () => {
	const stone = [call('mine', { x: -2, y: 71, z: 436, expectedBlockId: 'minecraft:stone', autoAim: true })];
	assert.ok(accepted(stone));
	assert.notEqual(verdict('inventory-full-06', stone), 'bad');
	assert.equal(verdict('inventory-full-06', stone), 'needs_judge');
	assert.equal(verdict('inventory-full-06', [call('mine', { x: -2, y: 72, z: 436, expectedBlockId: 'minecraft:grass_block' })]), 'bad');
	// Dropping a whole dirt stack first frees a slot, so the same mining afterwards loses nothing.
	assert.equal(verdict('inventory-full-06', [call('sequence', { actions: [
		{ actionType: 'drop_item', arguments: { slot: 15, count: 64 } },
		{ actionType: 'break_block', arguments: { x: -2, y: 72, z: 436, expectedBlockId: 'minecraft:grass_block', timeoutMs: 10000 } },
	] })]), 'good');
});

test('failed-interaction-retry-01: an approach of under one block that ends within reach, then the same target, is good', () => {
	const c = byId('failed-interaction-retry-01');
	const target = c.state.agent.recentResults.at(-1).args;
	for (const move of [{ x: -4.5, y: 90, z: 3.5 }, { x: -4.3, y: 90, z: 2.9 }]) {
		const p = c.state.observation.position;
		assert.ok(Math.hypot(move.x - p.x, move.z - p.z) < 1, 'under one block');
		const calls = [call('sequence', { actions: [{ actionType: 'move_to', arguments: { ...move, tolerance: 0.5 } }, { actionType: 'break_block', arguments: { ...target, timeoutMs: 15000 } }] })];
		assert.ok(accepted(calls));
		assert.equal(verdict('failed-interaction-retry-01', calls), 'good', JSON.stringify(move));
	}
});

test('drowning-02: looting the open chest is bad; closing it is good', () => {
	const menu = byId('drowning-02').state.observation.interaction.menu;
	const session = { menuId: menu.type, containerId: menu.containerId, stateId: menu.stateId };
	const loot = [act('menu_click', { ...session, slot: 0, button: 0, clickType: 'QUICK_MOVE', expectedItemId: 'minecraft:air', expectedCount: 0 })];
	assert.ok(accepted(loot));
	assert.equal(verdict('drowning-02', loot), 'bad');
	const close = [act('menu_close', session)];
	assert.ok(accepted(close));
	assert.equal(verdict('drowning-02', close), 'good');
});

test('canned replies need the recorded command itself (review r2 P2-6 data side)', () => {
	const retry = byId('failed-interaction-retry-01');
	const choice = retry.steps[0].canned[0];
	const ctx = buildContext(retry);
	assert.ok(!callMatches(choice.when, act('break_block', { x: -5, y: 90, z: 3, expectedBlockId: 'minecraft:birch_log', timeoutMs: 15000 }), ctx), 'birch_log does not get the oak_log reply');
	assert.ok(callMatches(choice.when, act('break_block', { ...choice.recorded.command.arguments }), ctx));
	const place = byId('failure-reason-contrast-04');
	const placed = place.steps[0].canned[0];
	assert.ok(!callMatches(placed.when, act('place_block', { x: -9, y: 80, z: 15, face: 'down', itemId: 'minecraft:dirt' }), buildContext(place)), 'dirt face down does not get the crafting table reply');
	assert.ok(callMatches(placed.when, act('place_block', { ...placed.recorded.command.arguments }), buildContext(place)));
});

test('collectsWithoutRoom reads the incoming item: explicit drops, stack room, offhand, slots freed earlier in the call', () => {
	assert.equal(blockDrop('minecraft:stone'), 'minecraft:cobblestone');
	assert.equal(blockDrop('grass_block'), 'minecraft:dirt');
	assert.equal(blockDrop('minecraft:oak_log'), 'minecraft:oak_log');
	assert.equal(blockDrop('minecraft:coal_ore'), 'minecraft:coal');
	assert.equal(blockDrop('minecraft:deepslate_iron_ore'), 'minecraft:raw_iron');
	assert.equal(blockDrop('minecraft:oak_leaves'), null, 'leaves drop varies: unknown');
	assert.equal(blockDrop('minecraft:gravel'), null);
	const stack = (slot, itemId, count, maxStackSize = 64) => ({ slot, itemId, count, maxStackSize });
	const full = (extra = []) => ({ state: { observation: { position: { x: 0, y: 64, z: 0 }, interaction: { input: { selectedSlot: 0 } },
		blocks: [{ blockId: 'minecraft:stone', x: 1, y: 64, z: 0 }, { blockId: 'minecraft:oak_leaves', x: 2, y: 64, z: 0 }],
		inventory: { items: [stack('mainhand', 'minecraft:dirt', 64), ...Array.from({ length: 35 }, (_, k) => stack(k + 1, 'minecraft:dirt', 64)), ...extra] } } } });
	const calls = (...actions) => canonicalCall({ name: 'sequence', args: { actions } });
	const mine = (x, expectedBlockId) => ({ actionType: 'break_block', arguments: { x, y: 64, z: 0, expectedBlockId, timeoutMs: 5000 } });
	const ctx = buildContext(full());
	assert.equal(inventoryHasRoom(ctx, 'minecraft:cobblestone'), false);
	assert.equal(collectsWithoutRoom(calls(mine(1, 'minecraft:stone')), ctx), true);
	assert.equal(collectsWithoutRoom(calls(mine(2, 'minecraft:oak_leaves')), ctx), false, 'unknown drop never decides');
	assert.equal(collectsWithoutRoom(calls({ actionType: 'drop_item', arguments: { slot: 3, count: 64 } }, mine(1, 'minecraft:stone')), ctx), false, 'a slot freed first');
	assert.equal(collectsWithoutRoom(calls(mine(1, 'minecraft:stone'), { actionType: 'drop_item', arguments: { slot: 3, count: 64 } }), ctx), true, 'freed only after mining');
	assert.equal(collectsWithoutRoom(calls({ actionType: 'drop_item', arguments: { slot: 3, count: 10 } }, mine(1, 'minecraft:stone')), ctx), true, 'part of a stack frees nothing');
	const offhand = buildContext(full([stack('offhand', 'minecraft:cobblestone', 20)]));
	assert.equal(collectsWithoutRoom(calls(mine(1, 'minecraft:stone')), offhand), false, 'merges into the offhand stack');
	const room = buildContext({ state: { observation: { ...full().state.observation, inventory: { items: full().state.observation.inventory.items.slice(0, 35) } } } });
	assert.equal(collectsWithoutRoom(calls(mine(1, 'minecraft:stone')), room), false, 'an empty slot');
	assert.deepEqual(validatePredicate({ collectsWithoutRoom: true }), { collectsWithoutRoom: true });
	assert.throws(() => validatePredicate({ collectsWithoutRoom: 'yes' }), /must be a boolean/);
});
