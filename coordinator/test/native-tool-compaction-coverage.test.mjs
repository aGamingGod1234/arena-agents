import assert from 'node:assert/strict';
import { presentFailures, withFailureSchema } from '../src/failure-schema.mjs';
import { withToolWear } from '../src/resource-facts.mjs';
import test from 'node:test';
import { MAX_TOOL_RESULT_BYTES, toolResultContent } from '../src/native-minecraft-tools.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { decodeModelFacts } from '../src/model-fact-encoding.mjs';

const item = { slot: 0, itemId: 'minecraft:iron_pickaxe', count: 1, damage: 240, maxDamage: 250, tags: ['#minecraft:pickaxes'] };
const inventory = { items: [item], selectedSlot: 0, selectedItem: item, tagCounts: { '#minecraft:pickaxes': 1 } };
const encode = value => {
	const text = toolResultContent(value).contentItems[0].text;
	assert.ok(Buffer.byteLength(text) <= MAX_TOOL_RESULT_BYTES);
	return JSON.parse(text);
};

// Item tags are presented once per itemId in observation.itemTags; put them back on the rows to compare facts.
function withRowItemTags(observation) {
	const { itemTags = {}, ...rest } = observation;
	if (!Array.isArray(rest.inventory?.items)) return rest;
	return { ...rest, inventory: { ...rest.inventory, items: rest.inventory.items.map((row) => Object.hasOwn(itemTags, row.itemId) ? { ...row, tags: itemTags[row.itemId] } : row) } };
}

test('footing presentation omits only counts and height changes reconstructable from the same reply', () => {
	const complete = { kind: 'footing', at: { x: 0, y: 64, z: 0 }, candidates: [{ x: 10, y: 68, z: 0, dy: 4, footing: 'stood' }], total: 1 };
	const copy = structuredClone(complete);
	const shown = encode(complete);
	assert.equal(shown.total, undefined);
	assert.equal(shown.candidates[0].dy, undefined);
	assert.equal(shown.candidates[0].y - shown.at.y, complete.candidates[0].dy);
	assert.deepEqual(complete, copy, 'raw script facts and runtime objects retain their fields');
	const page = encode({ ...complete, total: 2, nextOffset: 1 });
	assert.equal(page.total, 2);
	assert.equal(page.nextOffset, 1);
	const uncertain = encode({ ...complete, at: undefined, candidates: [{ y: 68, dy: null }] });
	assert.equal(uncertain.candidates[0].dy, null);
	const inconsistent = encode({ ...complete, candidates: [{ y: 68, dy: 5 }] });
	assert.equal(inconsistent.candidates[0].dy, 5, 'do not hide inconsistent evidence');
	assert.equal(encode({ ...complete, kind: 'blocks' }).total, 1, 'other result kinds keep their existing presentation');
});

test('movement receipt presentation rounds body measurements without changing navigation decisions or raw samples', () => {
	const observation = {
		position: { x: 170.123456789, y: 63.999999999, z: -321.87654321 },
		velocity: { x: 0.0123456789, y: -0.123456789, z: 0.000123456 }, yaw: 89.999991, pitch: -0.123456,
		collision: { horizontal: true, vertical: false, inWall: false },
		lookedAt: { type: 'block', position: { x: 171, y: 64.123456789, z: -321.333333333 }, id: 'minecraft:stone', face: 'west', hitDistance: 0.87654321 },
		target: { kind: 'position', position: { x: 200.123456789, y: 64, z: -320.5 }, distanceRemaining: 29.99987654321, tolerance: 0.0123456789, standable: null },
		progress: { value: 0.999999999, basis: 'world_position', verified: true },
	};
	const input = { state: 'FAILED', reasonCode: 'NO_PROGRESS', message: 'Body remains at water edge; beyond unseen', actionObservation: observation };
	const before = structuredClone(input);
	const output = encode(input);
	assert.deepEqual(input, before, 'rendering must not mutate runtime, receipt, or script facts');
	assert.deepEqual(output.actionObservation.position, { x: 170.123, y: 64, z: -321.877 });
	assert.deepEqual(output.actionObservation.velocity, { x: 0.012, y: -0.123, z: 0 });
	assert.equal(output.actionObservation.yaw, 90);
	assert.equal(output.actionObservation.lookedAt.hitDistance, 0.877);
	assert.equal(output.actionObservation.target.distanceRemaining, 30);
	assert.deepEqual(output.actionObservation.target.position, observation.target.position, 'requested endpoint must not be rounded');
	assert.equal(output.actionObservation.target.tolerance, observation.target.tolerance);
	assert.equal(output.actionObservation.target.standable, null, 'unknown is not false');
	assert.deepEqual(output.actionObservation.progress, observation.progress, 'rounding progress to one would falsely imply arrival');
	assert.deepEqual(output.actionObservation.collision, observation.collision);
	assert.equal(output.failure.blockedBy, input.message);
	assert.equal(output.message, undefined, 'the blocker is presented once in the failure schema');
	assert.ok(Buffer.byteLength(JSON.stringify(output)) < Buffer.byteLength(JSON.stringify(withFailureSchema(input))) - 80);
	const block = { ...observation, target: { ...observation.target, kind: 'block' } };
	assert.deepEqual(encode({ actionObservation: block }).actionObservation, block, 'other action results keep their existing presentation');
	assert.deepEqual(encode({ results: [input] }).results[0], output, 'sequence and standalone receipts share presentation');
	const provider = presentNativeToolResult(input, { kind: 'action', actionType: 'navigate_to' });
	assert.deepEqual(decodeModelFacts(JSON.parse(provider.response.contentItems[0].text)), output);
});

test('replacement outcome retains the previous terminal state when large action facts are compacted', () => {
	const replacedAction = { actionId: 'native:previous:1', state: 'FAILED', reasonCode: 'NO_PATH' };
	const result = encode({ state: 'SUCCEEDED', reasonCode: 'FLED', replacedAction,
		postAction: { observation: { player: { health: 8 }, detail: 'x'.repeat(30_000) } } });
	assert.equal(result.state, 'SUCCEEDED');
	assert.deepEqual(result.replacedAction, replacedAction);
});

test('native compaction preserves selected item, tag totals, durability, targets and threats', () => {
	const observation = {
		player: { health: 8, air: 60 }, inventory,
		entities: [{ stableId: '550e8400-e29b-41d4-a716-446655440000', typeId: 'minecraft:zombie', hostile: true, alive: true, health: 12, maxHealth: 20, x: 2, y: 64, z: 1, distanceSquared: 5 }],
		items: [{ stableId: '550e8400-e29b-41d4-a716-446655440001', itemId: 'minecraft:oak_log', count: 2, x: 1, y: 64, z: 1 }],
		blocks: [{ blockId: 'minecraft:oak_log', x: 1, y: 64, z: 2, tags: ['#minecraft:logs'] }],
	};
	const original = structuredClone(observation);
	const result = encode({ observation, detail: 'x'.repeat(20_000) }).observation;
	assert.deepEqual(result.inventory, inventory);
	assert.deepEqual(result.entities, observation.entities);
	assert.deepEqual(result.items, observation.items);
	assert.deepEqual(result.blocks, observation.blocks);
	assert.deepEqual(result.resultCoverage.omittedFields, []);
	assert.deepEqual(result.resultCoverage.omittedSections, []);
	assert.equal(result.resultCoverage.inventory.retained, 1);
	assert.equal(result.resultCoverage.entities.detailsOmitted, false);
	assert.deepEqual(observation, original, 'presentation must not mutate authoritative facts');
});

test('field omissions remain explicit even when every observation row is retained', () => {
	const observation = {
		inventory: { ...inventory, extra: { recipeHints: ['bulky'] } },
		entities: [{ stableId: 'entity-1', hostile: false, alive: true, omittedFields: ['upstreamDetail'], equipment: { description: 'x'.repeat(20_000) } }],
		blocks: [{ blockId: 'minecraft:stone', x: 1, y: 64, z: 1, properties: { lit: false } }],
		world: { worldId: 'world-1', dimension: 'minecraft:overworld', weather: 'rain' },
		lastResult: { state: 'FAILED', reasonCode: 'BLOCKED', message: 'details' },
		options: { extraAction: true },
		coverage: { inventory: { complete: true } },
		resultCoverage: { omittedFields: ['player.priorField'], omittedSections: ['previousSection'] },
	};
	const result = encode({ observation }).observation;
	assert.equal(result.resultCoverage.entities.retained, 1);
	assert.equal(result.resultCoverage.entities.availableInSnapshot, 1);
	assert.equal(result.resultCoverage.entities.detailsOmitted, true);
	assert.deepEqual(result.entities[0].omittedFields, ['upstreamDetail'], 'retain earlier projection omissions through further compaction');
	assert.equal(Object.hasOwn(result, 'items'), false, 'compaction must not invent empty dropped-item facts');
	assert.equal(result.resultCoverage.inventory.retained, 1);
	assert.deepEqual(result.coverage, observation.coverage, 'server row coverage keeps its original meaning');
	assert.deepEqual(result.resultCoverage.omittedFields, [
		'blocks[].properties', 'entities[].equipment', 'inventory.extra', 'options', 'player.priorField', 'world.weather',
	]);
	assert.deepEqual(result.resultCoverage.omittedSections.sort(), ['options', 'previousSection']);
});

test('row omissions and retained-row field omissions are independently reported', () => {
	const observation = {
		inventory: { ...inventory, items: Array.from({ length: 20 }, (_, slot) => ({ ...item, slot })) },
		entities: Array.from({ length: 40 }, (_, index) => ({ stableId: `entity-${index}`, hostile: true, alive: true, extra: 'x'.repeat(1000) })),
	};
	const result = encode({ observation }).observation;
	assert.equal(result.resultCoverage.inventory.availableInSnapshot, 20);
	assert.equal(result.resultCoverage.inventory.retained, 16);
	assert.equal(result.resultCoverage.entities.availableInSnapshot, 40);
	assert.equal(result.resultCoverage.entities.retained, 32);
	assert.deepEqual(result.resultCoverage.omittedFields, ['entities[].extra']);
	assert.deepEqual(result.resultCoverage.omittedSections, []);
});

test('postAction inventory fallback preserves cheap facts and labels projected item fields', () => {
	const value = {
		state: 'SUCCEEDED', completed: 2,
		results: [{ actionType: 'look_at', state: 'SUCCEEDED' }, { actionType: 'break_block', state: 'SUCCEEDED' }],
		postAction: {
			eventSequence: 7, freshness: { fresh: true },
			goalSpec: { predicate: { type: 'inventory_contains_any', count: 1, itemIds: Array.from({ length: 64 }, (_, i) => `minecraft:item_${i}_${'x'.repeat(238)}`) } },
			observation: { inventory: { ...inventory, items: [{ ...item, details: { lore: 'bulky' } }] }, player: { health: 8 } },
		},
	};
	const result = encode(value);
	assert.equal(result.state, 'SUCCEEDED');
	assert.equal(result.results.length, 2);
	assert.equal(result.postAction.freshness.fresh, true);
	assert.equal(result.postAction.eventSequence, 7);
	assert.deepEqual(result.postAction.observation.inventory, inventory);
	assert.deepEqual(result.postAction.observation.resultCoverage.omittedFields, ['inventory.items[].details', 'player']);
	assert.equal(result.postAction.observation.resultCoverage.inventory.retained, 1);
});

test('in-budget results retain their exact representation and do not acquire omission warnings', () => {
	const value = { observation: { inventory, entities: [] } };
	assert.deepEqual(encode(value), value);
});

const present = (value, kind) => {
	const { response } = presentNativeToolResult(value, { kind });
	assert.equal(response.success, true);
	const text = response.contentItems[0].text;
	assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_TOOL_RESULT_BYTES);
	return decodeModelFacts(JSON.parse(text));
};

for (const kind of ['sequence', 'action']) test(`provider presentation budgets large tag totals without losing ${kind} receipts`, () => {
	const tagCounts = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`minecraft:tag_${i}_${'x'.repeat(170)}`, i + 1]));
	const receipt = index => ({ actionId: `native-action-${index}`, actionType: 'break_block',
		state: index === 7 ? 'FAILED' : 'SUCCEEDED', reasonCode: index === 7 ? 'TARGET_OBSTRUCTED' : 'BLOCK_BROKEN',
		executionStarted: true, physicalAttempted: index !== 7 });
	const { actionType, ...actionReceipt } = receipt(7);
	const value = {
		...(kind === 'sequence' ? { state: 'FAILED', completed: 8, failedAt: 7, results: Array.from({ length: 8 }, (_, i) => receipt(i)) } : actionReceipt),
		postAction: { eventSequence: 42, freshness: { fresh: true }, observation: { inventory: { ...inventory, tagCounts } } },
	};
	const original = structuredClone(value);
	const result = present(value, kind);
	assert.equal(result.state, 'FAILED');
	if (kind === 'sequence') {
		assert.equal(result.completed, 8);
		assert.equal(result.failedAt, 7);
		assert.deepEqual(result.results, presentFailures(value).results, 'every authoritative receipt keeps its identity and status');
	} else {
		for (const [key, expected] of Object.entries(withFailureSchema(actionReceipt))) assert.deepEqual(result[key], expected);
	}
	assert.equal(result.postAction.eventSequence, 42);
	assert.equal(result.postAction.freshness.fresh, true);
	assert.deepEqual(withRowItemTags(result.postAction.observation).inventory.items, withToolWear(inventory).items, 'the model reads wear as usesLeft');
	assert.equal(result.postAction.observation.inventory.selectedSlot, inventory.selectedSlot);
	assert.deepEqual(result.postAction.observation.inventory.selectedItem, inventory.selectedItem);
	assert.equal(Object.hasOwn(result.postAction.observation.inventory, 'tagCounts'), false);
	assert.deepEqual(result.postAction.observation.resultCoverage.omittedFields, ['inventory.tagCounts']);
	assert.deepEqual(result.postAction.observation.resultCoverage.inventory, { retained: 1, availableInSnapshot: 1 });
	assert.deepEqual(value, original, 'presentation must not mutate the original receipt or inventory');
});

test('provider presentation marks truncated recovery arrays even when retained entries have identical fields', () => {
	const value = { detail: 'x'.repeat(20_000), observation: { inventory, recovery: {
		lastLostInventory: Array.from({ length: 20 }, (_, slot) => ({ slot, itemId: 'minecraft:oak_log', count: 1 })),
		alreadyHave: Array.from({ length: 20 }, (_, i) => `minecraft:item_${i}`),
		alreadyHaveFacts: Array.from({ length: 20 }, (_, i) => ({ itemId: `minecraft:item_${i}`, provenance: 'remembered' })),
	} } };
	const result = present(value, 'observe').observation;
	assert.equal(result.recovery.lastLostInventory.length, 8);
	assert.deepEqual(result.recovery.lastLostInventory, value.observation.recovery.lastLostInventory.slice(0, 8));
	assert.deepEqual(result.recovery.alreadyHave, value.observation.recovery.alreadyHave.slice(-16));
	assert.deepEqual(result.recovery.alreadyHaveFacts, value.observation.recovery.alreadyHaveFacts.slice(-16));
	for (const path of ['recovery.lastLostInventory', 'recovery.alreadyHave', 'recovery.alreadyHaveFacts']) {
		assert.ok(result.resultCoverage.omittedFields.includes(path), `${path} must report missing entries`);
	}
	assert.deepEqual(result.resultCoverage.omittedSections, [], 'partly retained recovery is not an absent section');
});

test('provider postAction fallback unions prior section omissions with newly omitted sections', () => {
	const value = { state: 'SUCCEEDED', completed: 2,
		results: [{ actionType: 'look_at', state: 'SUCCEEDED' }, { actionType: 'break_block', state: 'SUCCEEDED' }],
		postAction: { eventSequence: 7, freshness: { fresh: true },
			goalSpec: { predicate: { type: 'inventory_contains_any', count: 1, itemIds: Array.from({ length: 64 }, (_, i) => `minecraft:item_${i}_${'x'.repeat(238)}`) } },
			observation: { inventory, player: { health: 8 }, resultCoverage: {
				omittedFields: ['earlier.field'], omittedSections: ['earlierSection', 'player'],
			} },
		},
	};
	const original = structuredClone(value);
	const result = present(value, 'sequence');
	assert.equal(result.completed, 2);
	assert.equal(result.postAction.truncated, true);
	assert.deepEqual(withRowItemTags(result.postAction.observation).inventory, withToolWear(inventory), 'the model reads wear as usesLeft');
	assert.deepEqual(result.postAction.observation.resultCoverage.omittedSections.sort(), ['earlierSection', 'player']);
	assert.deepEqual(result.postAction.observation.resultCoverage.omittedFields, ['earlier.field', 'player']);
	assert.deepEqual(value, original);
});
