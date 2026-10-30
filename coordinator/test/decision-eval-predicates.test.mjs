import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContext, canonicalCall, canonicalCalls, distanceGain, evaluatePredicate, matchValue, validatePredicate, valuesAtPath } from '../src/decision-eval/predicates.mjs';
import { caseCounts, gradeSample, gradeSamples, loadCases } from '../src/decision-eval/grade.mjs';
import { validatePredicate as schemaValidatePredicate } from '../src/decision-eval/schema.mjs';

import { CREEPER, PIG, ZOMBIE, synthCase } from './fixtures/decision-eval-synth.mjs';

const act = (actionType, args) => ({ index: 0, name: 'mcp__minecraft__act', args: { actionType, arguments: args } });
const ctx = buildContext(synthCase());
const holds = (predicate, calls) => evaluatePredicate(predicate, canonicalCalls(calls), ctx);

test('canonical calls strip the provider prefix and use production normalization for body actions', () => {
	const call = canonicalCall({ name: 'mcp__minecraft__moveTo', args: { x: 9, y: 64, z: 0 } });
	assert.equal(call.tool, 'moveTo');
	assert.equal(call.normalized.actionType, 'navigate_to');
	assert.deepEqual(call.actions.map(a => a.actionType), ['navigate_to']);
	const seq = canonicalCall({ tool: 'sequence', arguments: JSON.stringify({ actions: [{ actionType: 'select_item', arguments: { itemId: 'minecraft:bread' } }, { actionType: 'use_item', arguments: { durationMs: 1800 } }] }) });
	assert.deepEqual(seq.actions.map(a => a.actionType), ['select_item', 'use_item']);
	// Production rejects this (missing timeoutMs is fine, unknown key is not); the raw fallback still sees the choice.
	const invalid = canonicalCall({ name: 'act', args: { actionType: 'flee_from', arguments: { targetId: CREEPER, distance: 12 }, bogus: 1 } });
	assert.ok(invalid.normalizeError);
	assert.deepEqual(invalid.actions.map(a => a.actionType), ['flee_from']);
});

test('matchers cover equality, regex, ranges, membership, existence and negation', () => {
	assert.ok(matchValue('a', 'a'));
	assert.ok(matchValue({ eq: { x: 1 } }, { x: 1 }));
	assert.ok(matchValue({ regex: '^minecraft:(bread|apple)$' }, 'minecraft:bread'));
	assert.ok(!matchValue({ regex: 'bread' }, 7));
	assert.ok(matchValue({ gte: 1, lt: 5 }, 4.9));
	assert.ok(!matchValue({ gte: 1, lt: 5 }, 5));
	assert.ok(matchValue({ range: [0, 10] }, 10));
	assert.ok(matchValue({ in: ['a', 'b'] }, 'b'));
	assert.ok(matchValue({ exists: false }, undefined));
	assert.ok(matchValue({ contains: 'x' }, ['y', 'x']));
	assert.ok(matchValue({ not: { in: [1, 2] } }, 3));
	assert.deepEqual(valuesAtPath({ actions: [{ actionType: 'a' }, { actionType: 'b' }] }, 'actions.*.actionType'), ['a', 'b']);
});

test('tool matches model-facing names only; normalized and action reach body action types', () => {
	const flee = act('flee_from', { targetId: CREEPER, distance: 16, timeoutMs: 8000 });
	assert.ok(holds({ tool: 'act' }, [flee]));
	assert.ok(!holds({ tool: 'flee_from' }, [flee]));
	assert.ok(holds({ action: 'flee_from' }, [flee]));
	assert.ok(holds({ tool: 'act', args: { actionType: 'flee_from', 'arguments.distance': { gte: 12 } } }, [flee]));
	assert.ok(holds({ normalized: { kind: 'action', actionType: 'flee_from' } }, [flee]));
	assert.ok(holds({ normalized: { actionType: 'navigate_to' } }, [{ name: 'moveTo', args: { x: 1, y: 64, z: 1 } }]));
	assert.ok(holds({ tool: 'wait' }, [{ name: 'wait', args: { durationMs: 500 } }]));
	assert.ok(!holds({ tool: 'wait' }, [act('wait', { durationMs: 500 })]));
	assert.ok(holds({ action: 'wait' }, [act('wait', { durationMs: 500 })]));
	assert.ok(holds({ action: ['select_item', 'use_item'], actionArgs: { durationMs: { gte: 1000 } } }, [{ name: 'sequence', args: { actions: [{ actionType: 'select_item', arguments: { itemId: 'minecraft:bread' } }, { actionType: 'use_item', arguments: { durationMs: 1800 } }] } }]));
	assert.ok(!holds({ tool: 'attack' }, [flee]));
});

test('index, any/all/not and none select and combine over the call list', () => {
	const calls = [{ name: 'observe', args: {} }, act('flee_from', { targetId: CREEPER, distance: 16, timeoutMs: 8000 })];
	assert.ok(holds({ tool: 'observe', index: 0 }, calls));
	assert.ok(holds({ action: 'flee_from', index: 'last' }, calls));
	assert.ok(!holds({ action: 'flee_from', index: 'first' }, calls));
	assert.ok(holds({ tool: 'act', index: 1 }, calls));
	assert.ok(holds({ all: [{ tool: 'observe' }, { action: 'flee_from' }] }, calls));
	assert.ok(holds({ any: [{ tool: 'attack' }, { normalized: { actionType: 'flee_from' } }] }, calls));
	assert.ok(holds({ not: { tool: 'attack' } }, calls));
	assert.ok(holds({ none: true }, []));
	assert.ok(!holds({ none: true }, calls));
	assert.ok(holds({ tool: 'observe', count: { max: 1 } }, calls));
	assert.ok(!holds({ bodyAction: true, index: 'every' }, calls));
});

test('awayFrom measures distance gained from a point, the nearest threat or the player', () => {
	const away = { name: 'moveTo', args: { x: -6, y: 64, z: 0 } };
	const toward = { name: 'moveTo', args: { x: 5, y: 64, z: 0 } };
	assert.equal(distanceGain(canonicalCall(away), ctx, 'nearestHostile'), 6);
	assert.ok(holds({ awayFrom: { position: 'threat', minDistance: 4 } }, [away]));
	assert.ok(!holds({ awayFrom: { position: 'threat', minDistance: 4 } }, [toward]));
	assert.ok(holds({ awayFrom: { position: { x: 3, y: 64, z: 0 }, minDistance: 5 } }, [away]));
	assert.ok(holds({ awayFrom: { position: 'player', minDistance: 5 } }, [away]));
	// flee_from the threat gains its distance minus the current separation (16 - 3).
	assert.ok(holds({ awayFrom: { position: 'threat', minDistance: 10 } }, [act('flee_from', { targetId: CREEPER, distance: 16, timeoutMs: 8000 })]));
	// Fleeing the far zombie does not count as getting away from the nearest threat.
	assert.ok(!holds({ awayFrom: { position: 'threat', minDistance: 4 } }, [act('flee_from', { targetId: ZOMBIE, distance: 16, timeoutMs: 8000 })]));
	// Raw control: yaw 90 faces -x; 40 sprint ticks cover about 11 blocks away from the creeper at +x.
	const run = { name: 'control', args: { forward: 1, strafe: 0, jump: false, sneak: false, sprint: true, attack: false, use: false, yaw: 90, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 40 } };
	assert.ok(holds({ awayFrom: { position: 'threat', minDistance: 8 } }, [run]));
	assert.ok(holds({ approaches: { to: { entityType: 'minecraft:pig' }, minDistance: 5 } }, [{ name: 'moveTo', args: { x: 0, y: 64, z: 14 } }]));
});

test('targetsEntity resolves targetId through observed entities; usesItem covers explicit, held and food items', () => {
	assert.ok(holds({ targetsEntity: 'minecraft:creeper' }, [act('fight_target', { targetId: CREEPER, timeoutMs: 8000 })]));
	assert.ok(holds({ targetsEntity: 'creeper' }, [act('attack', { targetId: CREEPER, timeoutMs: 1000 })]));
	assert.ok(!holds({ targetsEntity: 'minecraft:creeper' }, [act('attack', { targetId: ZOMBIE, timeoutMs: 1000 })]));
	assert.ok(holds({ targetsEntity: { hostile: false } }, [act('attack', { targetId: PIG, timeoutMs: 1000 })]));
	const eat = { name: 'sequence', args: { actions: [{ actionType: 'select_item', arguments: { itemId: 'minecraft:bread' } }, { actionType: 'use_item', arguments: { durationMs: 1800 } }] } };
	assert.ok(holds({ usesItem: 'minecraft:bread' }, [eat]));
	assert.ok(holds({ usesItem: 'food' }, [eat]));
	// An unqualified use_item uses the held sword, which is not food.
	assert.ok(!holds({ usesItem: 'food' }, [act('use_item', { durationMs: 1800 })]));
	assert.ok(holds({ usesItem: 'minecraft:stone_sword' }, [act('use_item', { durationMs: 1800 })]));
	assert.ok(holds({ placesBlock: 'minecraft:cobblestone' }, [act('place_block', { x: 1, y: 64, z: 0, face: 'up', itemId: 'minecraft:cobblestone' })]));
	assert.ok(holds({ breaksBlock: 'minecraft:oak_log' }, [{ name: 'mine', args: { x: 1, y: 65, z: 0, expectedBlockId: 'minecraft:oak_log' } }]));
	assert.ok(holds({ waits: true }, [{ name: 'wait', args: { durationMs: 1000 } }]));
	assert.ok(holds({ noBodyAction: true }, [{ name: 'observe', args: {} }]));
	assert.ok(holds({ noBodyAction: true }, [{ name: 'say', args: { message: 'hi' } }]));
	assert.ok(holds({ bodyAction: true }, [{ name: 'runProgram', args: { source: 'x' } }]));
});

test('targetsEntity resolves ids the model read in earlier observations or canned replies, and type selectors', () => {
	const MAGMA = '6e39429c-f976-46f4-afec-6c316cff5fb2';
	const OLD = '44444444-4444-4444-8444-444444444444';
	const base = synthCase();
	const withSources = {
		...base,
		state: { ...base.state, previousObservations: [{ position: { x: 0, y: 64, z: 0 }, entities: [{ uuid: OLD, type: 'minecraft:skeleton', hostile: true }] }] },
		steps: [{ canned: [{ when: { tool: 'act' }, result: { state: 'FAILED', message: `remaining threats: minecraft:magma_cube ${MAGMA} at 1.2 blocks, risk 9` } }] }],
	};
	const context = buildContext(withSources);
	const targets = (predicate, targetId) => evaluatePredicate(predicate, canonicalCalls([act('fight_target', { targetId })]), context);
	assert.ok(targets({ targetsEntity: 'minecraft:magma_cube' }, MAGMA), 'an id named in a canned reply resolves to its type');
	assert.ok(targets({ targetsEntity: 'minecraft:skeleton' }, OLD), 'an id from an earlier observation resolves');
	assert.ok(targets({ targetsEntity: 'minecraft:creeper' }, CREEPER), 'the case observation still resolves first');
	assert.ok(!targets({ targetsEntity: 'minecraft:creeper' }, MAGMA));
	assert.ok(!holds({ targetsEntity: 'minecraft:magma_cube' }, [act('fight_target', { targetId: MAGMA })]), 'unknown without the canned reply');
	assert.equal(context.entities.length, 3, 'the judge-facing entity list stays the case observation');
	assert.ok(holds({ targetsEntity: 'minecraft:item' }, [act('pick_up_item', { targetSelector: 'minecraft:item' })]), 'a type selector names its type');
});

test('usesItem counts selecting food by hotbar slot in a control call, not a repeated current slot', () => {
	const base = synthCase();
	const payload = base.state.observation.envelope.payload;
	payload.inventory.items = [
		{ itemId: 'minecraft:stone_sword', count: 1, slot: 0, hotbar: true },
		{ itemId: 'minecraft:bread', count: 3, slot: 1, hotbar: true },
	];
	const context = buildContext(base);
	const control = (args) => evaluatePredicate({ usesItem: 'food' }, canonicalCalls([{ name: 'control', args: { forward: 0, ticks: 20, ...args } }]), context);
	assert.ok(control({ selectedSlot: 1 }), 'switching to the bread slot selects food');
	assert.ok(control({ selectedSlot: 1, use: true }), 'and holding use eats it');
	assert.ok(!control({ selectedSlot: 0 }), 'the current sword slot is not food');
	assert.ok(!control({ selectedSlot: 0, jump: true }));
});

test('predicates in schema v1 shape pass the schema validator and the engine validator', () => {
	for (const predicate of synthCase().expect.good.concat(synthCase().expect.bad)) {
		assert.doesNotThrow(() => schemaValidatePredicate(predicate));
		assert.deepEqual(validatePredicate(predicate), []);
	}
	assert.ok(validatePredicate({ tooll: 'x' }).length > 0);
	assert.throws(() => holds({ tooll: 'x' }, [{ name: 'observe', args: {} }]), /unknown predicate key/);
});

test('gradeSample: bad wins over good, judge pending without a decision, errors are excluded', () => {
	const c = synthCase();
	const fleeThenHit = { caseId: c.id, sample: 0, calls: [act('flee_from', { targetId: CREEPER, distance: 16, timeoutMs: 8000 }), act('attack', { targetId: CREEPER, timeoutMs: 500 })], stop: 'script_end' };
	assert.equal(gradeSample(c, fleeThenHit).verdict, 'bad');
	assert.equal(gradeSample(c, { calls: [act('flee_from', { targetId: CREEPER, distance: 16, timeoutMs: 8000 })] }).verdict, 'good');
	assert.equal(gradeSample(c, { calls: [{ name: 'observe', args: {} }] }).verdict, 'ungraded', 'undecided without a rubric is never a default grade');
	assert.equal(gradeSample(c, { calls: [], error: { code: 'TIMEOUT' }, stop: 'error' }).verdict, 'error');
	const judged = synthCase({ expect: { good: [{ normalized: { actionType: 'flee_from' } }], judge: { rubric: 'Get away from the creeper first.' }, threshold: 0.67 } });
	assert.equal(gradeSample(judged, { calls: [{ name: 'observe', args: {} }] }).verdict, 'needs_judge');
});

test('gradeSamples sends only undecided samples to the judge and counts rates without errors', async () => {
	const c = synthCase({ expect: { good: [{ normalized: { actionType: 'flee_from' } }], judge: { rubric: 'Get away first.' }, threshold: 0.67 } });
	const byId = new Map([[c.id, c]]);
	const samples = [
		{ caseId: c.id, sample: 0, calls: [act('flee_from', { targetId: CREEPER, distance: 16, timeoutMs: 8000 })] },
		{ caseId: c.id, sample: 1, calls: [{ name: 'moveTo', args: { x: -8, y: 64, z: 0 } }] },
		{ caseId: c.id, sample: 2, calls: [], error: { code: 'X' }, stop: 'error' },
	];
	const seen = [];
	const { graded } = await gradeSamples(byId, samples, { judge: async (caseDef, pending) => { seen.push(...pending.map(s => s.sample)); return pending.map(() => ({ verdict: 'judge_good', rationale: 'moved away' })); } });
	assert.deepEqual(seen, [1]);
	assert.deepEqual(graded.map(r => r.grade.verdict), ['good', 'judge_good', 'error']);
	assert.deepEqual(caseCounts(c, graded), { good: 2, n: 2, errors: 1, ungraded: 0, verdicts: { good: 1, judge_good: 1, error: 1 } });
	const { graded: unjudged } = await gradeSamples(byId, samples);
	assert.equal(unjudged[1].grade.verdict, 'ungraded');
	assert.equal(unjudged[1].grade.source, 'judge-off');
});

// ---------- v1.3 helpers ----------

function caseWith(payloadEdit) {
	const base = synthCase();
	payloadEdit(base.state.observation.envelope.payload);
	return base;
}
const control = (args) => ({ name: 'control', args: { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: 0, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 1, ...args } });

test('escapesHazard needs real motion off every listed hazard block, not a movement tool name', () => {
	// Standing in a lava cell at (0,64,0) with lava along +x; the ground elsewhere is unlisted.
	const lava = caseWith((p) => {
		p.player.inLava = true;
		p.position = { x: 0.5, y: 64, z: 0.5 };
		p.blocks = [{ blockId: 'minecraft:lava', x: 0, y: 64, z: 0 }, { blockId: 'minecraft:lava', x: 1, y: 64, z: 0 }, { blockId: 'minecraft:lava', x: 2, y: 64, z: 0 }];
	});
	const context = buildContext(lava);
	const escapes = (call, spec = {}) => evaluatePredicate({ escapesHazard: spec }, canonicalCalls([call]), context);
	assert.ok(!escapes(control({ ticks: 1 })), 'a zero-motion control is not an escape');
	assert.ok(!escapes({ name: 'moveTo', args: { x: 0.5, y: 64, z: 0.5 } }), 'moving to the current spot is not an escape');
	assert.ok(!escapes({ name: 'moveTo', args: { x: 2.5, y: 64, z: 0.5 } }), 'moving deeper into the listed lava is not an escape');
	assert.ok(escapes({ name: 'moveTo', args: { x: -1.5, y: 64, z: 0.5 } }), 'two blocks onto unlisted ground away from the lava escapes');
	// yaw 90 faces -x: 10 walking ticks cover about 2.2 blocks away from the lava.
	assert.ok(escapes(control({ forward: 1, yaw: 90, ticks: 10 })));
	assert.ok(!escapes(control({ forward: 1, yaw: -90, ticks: 10 })), 'walking along the lava row keeps touching it');
	assert.ok(!escapes({ name: 'moveTo', args: { x: -0.1, y: 64, z: 0.5 } }), 'a step that still overlaps the cell does not escape');
	assert.ok(!escapes(control({ forward: 1, yaw: 90, ticks: 10 }), { blocks: 'nothing_matches', minMove: 5 }), 'minMove applies');
	assert.ok(!escapes(act('flee_from', { targetId: CREEPER, distance: 16, timeoutMs: 8000 })), 'no estimated end position, no escape');
});

test('rises counts a higher destination or held swim-up input, not a short or level move', () => {
	const context = buildContext(synthCase());
	const up = (call, spec = {}) => evaluatePredicate({ rises: spec }, canonicalCalls([call]), context);
	assert.ok(up(control({ jump: true, ticks: 20 })));
	assert.ok(!up(control({ jump: true, ticks: 3 })), 'three ticks of jump is not upward progress');
	assert.ok(up(control({ forward: 1, pitch: -60, ticks: 20 })), 'swimming forward pitched up rises');
	assert.ok(!up(control({ forward: 1, pitch: 10, ticks: 20 })));
	assert.ok(up({ name: 'moveTo', args: { x: 0, y: 67, z: 0 } }));
	assert.ok(!up({ name: 'moveTo', args: { x: 4, y: 64, z: 0 } }));
	const frame = control({ jump: true, ticks: 6 }).args;
	assert.ok(up({ name: 'sequence', args: { actions: [{ actionType: 'control', arguments: frame }, { actionType: 'control', arguments: frame }] } }), 'ticks add up across frames');
});

test('freesSlot needs a whole low-value stack to leave the inventory; discardsItem sees any drop', () => {
	const full = caseWith((p) => {
		p.inventory.selectedItem = 'minecraft:wooden_pickaxe';
		p.interaction = { input: { selectedSlot: 0 }, menu: { containerId: 0, type: 'minecraft:inventory', slotCount: 46, slots: [] } };
		p.inventory.items = [
			{ itemId: 'minecraft:wooden_pickaxe', count: 1, slot: 'mainhand', tags: ['#minecraft:pickaxes'] },
			{ itemId: 'minecraft:dirt', count: 64, slot: 1, hotbar: true, tags: ['#minecraft:dirt'] },
			{ itemId: 'minecraft:cooked_beef', count: 5, slot: 9, hotbar: false, tags: ['#c:foods'] },
		];
	});
	const context = buildContext(full);
	const holdsIn = (predicate, call) => evaluatePredicate(predicate, canonicalCalls([call]), context);
	const junk = { regex: '^minecraft:(dirt|cobblestone)$' };
	assert.ok(holdsIn({ freesSlot: junk }, act('drop_item', { slot: 1, count: 64 })));
	assert.ok(!holdsIn({ freesSlot: junk }, act('drop_item', { slot: 1, count: 1 })), 'dropping one of 64 frees nothing');
	assert.ok(holdsIn({ discardsItem: junk }, act('drop_item', { slot: 1, count: 1 })));
	assert.ok(!holdsIn({ freesSlot: junk }, act('drop_item', { slot: 0, count: 1 })), 'the held pickaxe (selected slot 0) is not junk');
	assert.ok(holdsIn({ discardsItem: 'minecraft:wooden_pickaxe' }, act('drop_item', { slot: 0, count: 1 })), 'the selected slot resolves to the mainhand entry');
	assert.ok(!holdsIn({ freesSlot: junk }, act('place_block', { x: 1, y: 64, z: 0, face: 'up', itemId: 'minecraft:dirt' })), 'placing one block frees nothing');
	const menuThrow = (slot, button) => act('menu_click', { menuId: 'minecraft:inventory', containerId: 0, stateId: 1, slot, button, clickType: 'THROW', expectedItemId: 'minecraft:dirt' });
	assert.ok(holdsIn({ freesSlot: junk }, menuThrow(37, 1)), 'menu slot 37 is hotbar slot 1; button 1 throws the stack');
	assert.ok(!holdsIn({ freesSlot: junk }, menuThrow(37, 0)), 'button 0 throws one item');
	assert.ok(holdsIn({ discardsItem: { regex: 'cooked_beef' } }, act('menu_click', { menuId: 'minecraft:inventory', containerId: 0, stateId: 1, slot: 9, button: 1, clickType: 'THROW', expectedItemId: 'minecraft:cooked_beef' })));
	// A QUICK_MOVE from the player part of an open chest stores the stack; one from a chest slot is looting.
	const chest = caseWith((p) => {
		p.interaction = { input: { selectedSlot: 0 }, menu: { containerId: 4, type: 'minecraft:generic_9x3', slotCount: 63, slots: [] } };
		p.inventory.items = [{ itemId: 'minecraft:cobblestone', count: 64, slot: 9, hotbar: false, tags: [] }, { itemId: 'minecraft:iron_ingot', count: 3, slot: 'mainhand', tags: [] }];
	});
	const chestContext = buildContext(chest);
	const quick = (slot) => evaluatePredicate({ freesSlot: junk }, canonicalCalls([act('menu_click', { menuId: 'minecraft:generic_9x3', containerId: 4, stateId: 1, slot, button: 0, clickType: 'QUICK_MOVE', expectedItemId: 'minecraft:cobblestone' })]), chestContext);
	assert.ok(quick(27), 'menu slot 27 of a 27-slot chest is player slot 9');
	assert.ok(!quick(7));
});

test('clearsLineOfSight credits breaking the block between the eye and the hidden target only', () => {
	const context = buildContext(synthCase());
	// Eye at (0,65.62,0); hidden target block (4,65,0); the block at (2,65,0) is on the line.
	const clears = (x, y, z) => evaluatePredicate({ clearsLineOfSight: { x: 4, y: 65, z: 0 } }, canonicalCalls([{ name: 'mine', args: { x, y, z, expectedBlockId: 'minecraft:stone' } }]), context);
	assert.ok(clears(2, 65, 0));
	assert.ok(!clears(4, 65, 0), 'the target itself is the retry, not a clearing');
	assert.ok(!clears(2, 68, 3), 'a block off the line does not clear it');
	assert.ok(!clears(-2, 65, 0), 'a block behind the player does not clear it');
});

test('firstAction separates a plain retry from a repair step before it; approaches can bound the final distance', () => {
	const target = { x: 6, y: 64, z: 0 };
	const retry = { firstAction: 'break_block', firstActionArgs: { x: target.x, y: target.y, z: target.z } };
	assert.ok(holds(retry, [{ name: 'mine', args: { ...target, expectedBlockId: 'minecraft:oak_log' } }]));
	assert.ok(!holds(retry, [{ name: 'sequence', args: { actions: [{ actionType: 'move_to', arguments: { x: 5, y: 64, z: 0, tolerance: 1 } }, { actionType: 'break_block', arguments: { ...target, expectedBlockId: 'minecraft:oak_log' } }] } }]), 'moving first is a repair');
	const inReach = { approaches: { to: { x: 6.5, y: 64.5, z: 0.5 }, minDistance: 0.5, maxFinalDistance: 4.5 } };
	assert.ok(holds(inReach, [{ name: 'moveTo', args: { x: 4, y: 64, z: 0 } }]));
	assert.ok(!holds(inReach, [{ name: 'moveTo', args: { x: 1, y: 64, z: 0 } }]), 'closer but still out of reach');
	assert.ok(!holds(inReach, [{ name: 'moveTo', args: { x: -4, y: 64, z: 0 } }]));
	assert.ok(holds({ movesAway: { from: 'nearestHostile', minDistance: 1, maxFinalDistance: 8 } }, [{ name: 'moveTo', args: { x: -4, y: 64, z: 0 } }]));
	assert.ok(!holds({ movesAway: { from: 'nearestHostile', minDistance: 1, maxFinalDistance: 5 } }, [{ name: 'moveTo', args: { x: -4, y: 64, z: 0 } }]));
});

test('v1.3 keys validate in the schema and the engine', () => {
	const predicates = [
		{ escapesHazard: { blocks: 'lava|fire', minMove: 0.5 } }, { rises: { minDy: 1, minTicks: 10 } }, { freesSlot: { regex: 'dirt' } },
		{ discardsItem: 'minecraft:dirt' }, { clearsLineOfSight: { x: 1, y: 2, z: 3 } }, { firstAction: ['break_block'], firstActionArgs: { x: 1 } },
		{ approaches: { to: { x: 1, y: 2, z: 3 }, maxFinalDistance: 4.5 } },
	];
	for (const predicate of predicates) {
		assert.doesNotThrow(() => schemaValidatePredicate(predicate), JSON.stringify(predicate));
		assert.deepEqual(validatePredicate(predicate), []);
	}
	assert.throws(() => schemaValidatePredicate({ escapesHazard: { blocks: '(' } }));
	assert.throws(() => schemaValidatePredicate({ rises: { minTicks: -1 } }));
	assert.throws(() => schemaValidatePredicate({ escapesHazard: { radius: 2 } }));
	assert.throws(() => schemaValidatePredicate({ approaches: { to: 'player', maxFinalDistance: -1 } }));
});

// A declared item or ranged use proves intent, not feasibility: the bucket may be absent, the hand may hold a pickaxe,
// there may be no bow or arrows. Committed safety and planning cases must leave those choices to their rubric instead
// of a deterministic good grade.
const committedCase = async (family, id) => {
	const cases = await loadCases(fileURLToPath(new URL(`./fixtures/decision-eval/train/${family}.json`, import.meta.url)));
	return cases.find(c => c.id === id);
};

test('committed hazard cases send unproven water-bucket and ranged answers to the rubric', async () => {
	const bucket = { name: 'sequence', args: { actions: [{ actionType: 'select_item', arguments: { itemId: 'minecraft:water_bucket' } }, { actionType: 'use_item', arguments: { durationMs: 200 } }] } };
	const selectOnly = act('select_item', { itemId: 'minecraft:water_bucket' });
	const useExpected = act('use_item', { durationMs: 200, expectedItemId: 'minecraft:water_bucket' });
	for (const [family, id] of [['burning', 'burning-01'], ['lava-contact', 'lava-contact-01']]) {
		const caseDef = await committedCase(family, id);
		for (const call of [bucket, selectOnly, useExpected]) {
			const grade = gradeSample(caseDef, { caseId: id, calls: [call] });
			assert.notEqual(grade.verdict, 'good', `${id} ${JSON.stringify(call)}`);
		}
	}
	for (const [family, id] of [['creeper-near', 'creeper-near-01'], ['creeper-post-escape', 'creeper-post-escape-03']]) {
		const caseDef = await committedCase(family, id);
		const creeper = JSON.stringify(caseDef.state).match(/"uuid":"([^"]+)","type":"minecraft:creeper"/)[1];
		const ranged = act('use_ranged', { targetId: creeper, drawDurationMs: 1000, timeoutMs: 3000 });
		const grade = gradeSample(caseDef, { caseId: id, calls: [ranged] });
		assert.equal(grade.verdict, 'needs_judge', `${id} ranged without proven bow and arrows`);
	}
});

test('a prerequisite-gap plan that names a keyword but skips the prerequisite is not graded good', async () => {
	const step = (id, label, detail) => ({ id, label, kind: 'manual', status: 'pending', dependsOn: [], detail, check: null, evidence: null });
	const skip = { name: 'taskPlan', args: { operation: 'replace', plan: { steps: [step('stronghold', 'Go straight to stronghold without blaze rods or pearls', 'Skip the nether entirely')] } } };
	for (let n = 1; n <= 6; n++) {
		const id = `plan-prerequisite-gap-0${n}`;
		const caseDef = await committedCase('plan-prerequisite-gap', id);
		const grade = gradeSample(caseDef, { caseId: id, calls: [skip] });
		assert.equal(grade.rejectedCalls, undefined, 'the plan must pass production normalization');
		assert.equal(grade.verdict, 'needs_judge', id);
	}
});
