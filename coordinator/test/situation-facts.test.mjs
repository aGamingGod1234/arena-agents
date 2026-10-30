import { compactEventInstruction } from '../src/dynamic-main.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { buildNativeEventInput, NEW_CONTEXT_EVENT_INSTRUCTION } from '../src/dynamic-main.mjs';
import { ModelObservationViews, decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { dayPhase, situationFacts } from '../src/situation-facts.mjs';

const OVERWORLD = { dimension: 'minecraft:overworld', worldId: 'w', gameTime: 100, dayTime: 1_000, raining: false, thundering: false };
const item = (itemId, slot, count = 1) => ({ itemId, count, slot });
const NO_FOOD = { items: 0, nutrition: 0 };
const observation = ({ world = OVERWORLD, player = { health: 20, skyOpen: true }, items = [], food = NO_FOOD } = {}) => ({ world, player, inventory: { items, ...(food === null ? {} : { food }) } });
/** A minimal wire observation the adapter accepts, for adapter-level checks. */
const wireOf = ({ player = {}, inventory = { items: [], selectedItem: 'minecraft:air' } } = {}) => ({ ready: true, position: { x: 0, y: 64, z: 0 }, view: { yaw: 0, pitch: 0 }, player: { health: 20, ...player },
	inventory, entities: [], blocks: [], items: [], world: OVERWORLD });

// Every weapon and armour item id in the installed Minecraft 26.1.2 Items class (javap of minecraft-common-deobf-26.1.2.jar).
const INSTALLED_TIERED_WEAPONS = ['wooden_sword', 'stone_sword', 'copper_sword', 'iron_sword', 'golden_sword', 'diamond_sword', 'netherite_sword',
	'wooden_axe', 'stone_axe', 'copper_axe', 'iron_axe', 'golden_axe', 'diamond_axe', 'netherite_axe',
	'wooden_spear', 'stone_spear', 'copper_spear', 'iron_spear', 'golden_spear', 'diamond_spear', 'netherite_spear'];
const INSTALLED_SINGLE_WEAPONS = ['mace', 'trident', 'bow', 'crossbow'];
const INSTALLED_ARMOR_TIERS = ['leather', 'golden', 'chainmail', 'copper', 'iron', 'diamond', 'netherite'];

test('situation names armour, tool and weapon tiers from item ids, worn versus carried', () => {
	const nether = { ...OVERWORLD, dimension: 'minecraft:the_nether', biome: 'minecraft:nether_wastes' };
	// The owner's Nether start: four diamond pieces carried, none worn, steak, no tools.
	const carried = ['helmet', 'chestplate', 'leggings', 'boots'].map((piece, slot) => item(`minecraft:diamond_${piece}`, slot));
	assert.equal(situationFacts(observation({ world: nether, player: { health: 20 }, items: [...carried, item('minecraft:cooked_beef', 4, 16)], food: { items: 16, nutrition: 128 } })),
		'the_nether, no day cycle; biome nether_wastes; armor worn 0/4, carried 4 diamond; weapon none; pickaxe none; food 100+ nutrition');
	const mixed = observation({ items: [item('minecraft:iron_helmet', 'head'), item('minecraft:diamond_chestplate', 'chest'), item('minecraft:leather_boots', 9),
		item('minecraft:stone_pickaxe', 0), item('minecraft:diamond_pickaxe', 1), item('minecraft:iron_sword', 2), item('minecraft:diamond_axe', 3),
		item('minecraft:bow', 4), item('minecraft:wooden_sword', 5)] });
	// One entry per weapon kind, the highest material of that kind, in a fixed kind order: no ranking across kinds.
	assert.equal(situationFacts(mixed), 'overworld; armor worn 2/4 diamond+iron, carried 1 leather; weapon iron sword, diamond axe, bow; pickaxe diamond; food none');
	// Kinds of one material share it.
	assert.match(situationFacts(observation({ items: [item('minecraft:diamond_sword', 0), item('minecraft:iron_spear', 1), item('minecraft:diamond_axe', 2)] })), /; weapon diamond sword\+axe, iron spear;/);
	assert.match(situationFacts(observation({ items: [item('minecraft:netherite_leggings', 'legs')] })), /armor worn 1\/4 netherite;/);
	assert.match(situationFacts(observation({ items: [item('minecraft:netherite_sword', 0), item('minecraft:mace', 1), item('minecraft:bow', 2), item('minecraft:crossbow', 3)] })),
		/weapon netherite sword, mace, bow, crossbow;/);
	assert.match(situationFacts(observation()), /armor none; weapon none; pickaxe none; food none$/);
});

test('every installed weapon is recognised, spears included, and a spear-only inventory is armed', () => {
	for (const id of [...INSTALLED_TIERED_WEAPONS, ...INSTALLED_SINGLE_WEAPONS]) {
		assert.match(situationFacts(observation({ items: [item(`minecraft:${id}`, 0)] })), new RegExp(`; weapon ${id.replace('_', ' ')};`), id);
	}
	assert.match(situationFacts(observation({ items: [item('minecraft:diamond_spear', 0)] })), /; weapon diamond spear;/);
	assert.match(situationFacts(observation({ items: [item('minecraft:stone_spear', 0), item('minecraft:netherite_spear', 1), item('minecraft:copper_spear', 2)] })), /; weapon netherite spear;/);
	// Pickaxes and hoes are not weapons, and a pickaxe never reads as an axe.
	assert.match(situationFacts(observation({ items: [item('minecraft:netherite_pickaxe', 0), item('minecraft:iron_hoe', 1)] })), /; weapon none; pickaxe netherite;/);
});

test('elytra is reported apart from armour; turtle helmets stay protective with their own label', () => {
	const elytraSet = [item('minecraft:diamond_helmet', 'head'), item('minecraft:elytra', 'chest'), item('minecraft:diamond_leggings', 'legs'), item('minecraft:diamond_boots', 'feet')];
	assert.match(situationFacts(observation({ items: elytraSet })), /; armor worn 3\/4 diamond; elytra worn; weapon/);
	assert.match(situationFacts(observation({ items: [item('minecraft:elytra', 5)] })), /; armor none; elytra carried; weapon/);
	assert.match(situationFacts(observation({ items: [item('minecraft:iron_chestplate', 'chest'), item('minecraft:elytra', 5)] })), /; armor worn 1\/4 iron; elytra carried;/);
	assert.match(situationFacts(observation({ items: [item('minecraft:turtle_helmet', 'head'), item('minecraft:iron_boots', 'feet')] })), /; armor worn 2\/4 iron\+turtle;/);
	for (const tier of INSTALLED_ARMOR_TIERS) {
		assert.match(situationFacts(observation({ items: ['helmet', 'chestplate', 'leggings', 'boots'].map((piece, index) => item(`minecraft:${tier}_${piece}`, ['head', 'chest', 'legs', 'feet'][index])) })),
			new RegExp(`; armor worn 4/4 ${tier};`), tier);
	}
});

test('food comes from the server food summary: risky food is named, not dropped, and no summary makes no claim', () => {
	// An End player with only chorus fruit: 8 items, 4 hunger points each, flagged for its random teleport.
	const end = { ...OVERWORLD, dimension: 'minecraft:the_end' };
	assert.match(situationFacts(observation({ world: end, player: { health: 20 }, items: [item('minecraft:chorus_fruit', 0, 8)],
		food: { items: 8, nutrition: 32, risky: [{ itemId: 'minecraft:chorus_fruit', count: 8, nutrition: 32 }] } })), /; food 20\+ nutrition \(risky 8 chorus_fruit\)$/);
	assert.match(situationFacts(observation({ items: [item('minecraft:rotten_flesh', 0, 64)],
		food: { items: 64, nutrition: 256, risky: [{ itemId: 'minecraft:rotten_flesh', count: 64, nutrition: 256 }] } })), /; food 200\+ nutrition \(risky 64 rotten_flesh\)$/);
	assert.match(situationFacts(observation({ food: { items: 7, nutrition: 30, risky: [{ itemId: 'minecraft:spider_eye', count: 1, nutrition: 2 }, { itemId: 'minecraft:suspicious_stew', count: 1, nutrition: 6 }] } })),
		/; food 20\+ nutrition \(risky 1 spider_eye, 1 suspicious_stew\)$/);
	assert.match(situationFacts(observation()), /; food none$/);
	assert.doesNotMatch(situationFacts(observation({ food: null, items: [item('minecraft:bread', 0, 3)] })), /food/);
	// The summary is carried through the adapter untouched and rejected when malformed.
	const food = { items: 9, nutrition: 40, risky: [{ itemId: 'minecraft:pufferfish', count: 1, nutrition: 1 }] };
	assert.deepEqual(adaptObservation(wireOf({ inventory: { items: [], selectedItem: 'minecraft:air', food } })).inventory.food, food);
	assert.throws(() => adaptObservation(wireOf({ inventory: { items: [], selectedItem: 'minecraft:air', food: { items: -1, nutrition: 0 } } })));
});

test('situation leaves local time to HUD inspection and names skyless dimensions', () => {
	assert.deepEqual([0, 11_800, 13_000, 23_000, 24_000 + 500].map(dayPhase), ['day', 'sunset soon', 'night', 'sunrise soon', 'day']);
	assert.match(situationFacts(observation({ world: { ...OVERWORLD, dayTime: 13_000 } })), /^overworld;/);
	for (const dimension of ['minecraft:the_nether', 'minecraft:the_end']) {
		assert.match(situationFacts(observation({ world: { ...OVERWORLD, dimension, dayTime: 13_000 }, player: { health: 20 } })), /^the_(nether|end), no day cycle; armor/);
	}
	assert.equal(situationFacts(observation({ player: { dead: true } })), null);
	assert.equal(situationFacts({ player: {} }), null);
});

test('the sky fact rides the player section on its own, so a roof never changes the situation line', () => {
	// The adapter accepts the boolean and rejects anything else.
	assert.equal(adaptObservation(wireOf({ player: { skyOpen: false } })).player.skyOpen, false);
	assert.throws(() => adaptObservation(wireOf({ player: { skyOpen: 1 } })));
	assert.equal(situationFacts(observation({ player: { skyOpen: true } })), situationFacts(observation({ player: { skyOpen: false } })));
	const payload = payloadOf(buildNativeEventInput(record, { event: 'observation', observation: adaptObservation(wireOf({ player: { skyOpen: false } })) }));
	assert.equal(payload.observation.player.skyOpen, false);
	assert.doesNotMatch(payload.situation, /sky/);
});

// Every weapon kind, mixed armour, an elytra and seven risky foods, at the longest phase in a long biome name.
const RISKY = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew', 'chicken'];
const FULL_KIT = [...['helmet', 'chestplate', 'leggings', 'boots'].map((piece, index) => item(`minecraft:netherite_${piece}`, ['head', 'chest', 'legs', 'feet'][index])),
	...['helmet', 'chestplate'].map((piece, slot) => item(`minecraft:golden_${piece}`, slot)), item('minecraft:elytra', 3),
	...['sword', 'axe', 'spear', 'pickaxe'].map((kind, slot) => item(`minecraft:netherite_${kind}`, slot + 4)),
	...INSTALLED_SINGLE_WEAPONS.map((id, slot) => item(`minecraft:${id}`, slot + 8)), ...RISKY.map((id, slot) => item(`minecraft:${id}`, slot + 12))];
const FULL_FOOD = { items: 7, nutrition: 21, risky: RISKY.map((id) => ({ itemId: `minecraft:${id}`, count: 1, nutrition: 3 })) };

test('situation keeps every fact for a complete kit within 350 bytes and is byte-identical for unchanged input', () => {
	const kit = observation({ world: { ...OVERWORLD, biome: 'minecraft:old_growth_spruce_taiga', dayTime: 23_500 }, player: { skyOpen: true }, items: FULL_KIT, food: FULL_FOOD });
	const line = situationFacts(kit);
	assert.ok(Buffer.byteLength(line) <= 350, `${Buffer.byteLength(line)} bytes: ${line}`);
	for (const fact of ['netherite sword+axe+spear', 'mace', 'trident', 'crossbow', 'elytra carried', 'carried 2 golden', ...RISKY]) assert.ok(line.includes(fact), fact);
	assert.equal(situationFacts(structuredClone(kit)), line);
	// Inventory order does not change the line.
	assert.equal(situationFacts({ ...kit, inventory: { ...kit.inventory, items: [...kit.inventory.items].reverse() } }), line);
});

// A Nether series shaped like the owner's run (05:09:54-05:13:27 UTC): carried diamond armour equipped over the first
// wakes, steak eaten after a fall, netherrack terrain, piglins, one biome change, about 220 ticks between wakes.
function netherWire(index) {
	const worn = Math.min(4, index);
	const pieces = ['helmet', 'chestplate', 'leggings', 'boots'];
	const slots = ['head', 'chest', 'legs', 'feet'];
	const position = { x: 40.5 + index * 3.25, y: 70 - (index >= 13 ? 9 : 0), z: -12.5 - index * 1.75 };
	const steak = index >= 16 ? 14 : 16;
	return {
		ready: true, observedAtEpochMs: 1_791_522_594_590 + index * 11_000, position, velocity: { x: 0.1, y: -0.0784, z: -0.05 }, view: { yaw: 120 + index, pitch: 4 },
		player: { health: index >= 13 && index < 16 ? 8 : 20, maxHealth: 20, armor: worn * 4 - (worn === 4 ? 1 : 0), foodLevel: index >= 16 ? 20 : 17, saturation: 2, gameMode: 'survival',
			onGround: true, inWater: false, onFire: false, air: 300, maxAir: 300, suffocating: false, fallDistance: 0, effects: [] },
		inventory: {
			items: [
				...pieces.map((piece, slot) => ({ itemId: `minecraft:diamond_${piece}`, count: 1, slot: slot < worn ? slots[slot] : slot + 1, tags: ['#minecraft:trimmable_armor'] })),
				{ itemId: 'minecraft:cooked_beef', count: steak, slot: 0, hotbar: true, tags: ['#minecraft:meat'] },
				{ itemId: 'minecraft:netherrack', count: Math.min(7, index), slot: 8, hotbar: true, tags: ['#minecraft:mineable/pickaxe'] },
			].filter((row) => row.count > 0),
			tagCounts: { '#minecraft:meat': steak },
			food: { items: steak, nutrition: steak * 8 },
		},
		entities: Array.from({ length: 3 }, (_, mob) => ({ uuid: `0b6d2c1e-3f4a-4b5c-8d9e-${String(mob).padStart(12, '0')}`, type: mob === 2 ? 'minecraft:hoglin' : 'minecraft:piglin',
			position: { x: position.x + 6 + mob * 4, y: position.y + (mob === 1 ? 20 : 0), z: position.z + 3 }, distance: 7 + mob * 4.5, hostile: mob === 2 })),
		blocks: Array.from({ length: 32 }, (_, cell) => ({ x: Math.floor(position.x) + (cell % 8) - 4, y: Math.floor(position.y) - 1 - Math.floor(cell / 8), z: Math.floor(position.z),
			blockId: cell % 7 === 0 ? 'minecraft:nether_quartz_ore' : 'minecraft:netherrack', tags: ['#minecraft:mineable/pickaxe'] })),
		world: { dimension: 'minecraft:the_nether', biome: index >= 12 ? 'minecraft:soul_sand_valley' : 'minecraft:nether_wastes', worldId: 'nether-run',
			gameTime: 18_400 + index * 220, dayTime: 18_400 + index * 220, raining: false, thundering: false, difficulty: 'normal', naturalRegeneration: true },
		currentAction: { active: index % 3 !== 0, ...(index % 3 !== 0 ? { actionId: `a-${index}`, actionType: 'navigate_to' } : {}) },
		lastResult: { present: true, actionId: `a-${index - 1}`, actionType: 'navigate_to', state: 'SUCCEEDED', reasonCode: 'ARRIVED', message: 'Arrived' },
	};
}

/** The same walk in an overworld forest by day: leaves overhead never change the sky fact; a cave is entered at wake 15. */
function forestWire(index) {
	const wire = netherWire(index);
	return { ...wire, player: { ...wire.player, skyOpen: index < 15 },
		world: { ...wire.world, dimension: 'minecraft:overworld', biome: 'minecraft:forest', gameTime: 1_000 + index * 220, dayTime: 1_000 + index * 220 } };
}

/** The review's worst route: overworld at night, in and out from under a roof on every wake. */
function nightRoofWire(index) {
	const wire = forestWire(index);
	return { ...wire, player: { ...wire.player, skyOpen: index % 2 === 0 }, world: { ...wire.world, gameTime: 14_000 + index * 220, dayTime: 14_000 + index * 220 } };
}

/** The night roof route carrying the complete kit. */
function fullKitWire(index) {
	const wire = nightRoofWire(index);
	return { ...wire, world: { ...wire.world, biome: 'minecraft:old_growth_spruce_taiga' },
		inventory: { ...wire.inventory, items: FULL_KIT.map((row) => ({ ...row, tags: [] })), tagCounts: {}, food: FULL_FOOD } };
}

const record = { currentGoal: 'beat the game', currentGoalSpec: null, goalRevision: 1 };
const trigger = (index) => (index === 0 ? 'start' : index === 13 ? 'damage' : 'attention');
const eventInput = (index, wire = netherWire) => buildNativeEventInput(record, { event: 'observation', trigger: trigger(index), eventSequence: index + 1,
	observation: adaptObservation(wire(index)), newContext: index === 0 });
const payloadOf = (input) => JSON.parse(input.slice(input.indexOf('\n') + 1));

test('situation follows trigger, is retained when unchanged and the model-facing world drops clock fields', () => {
	const first = payloadOf(eventInput(0));
	assert.deepEqual(Object.keys(first).slice(0, 4), ['event', 'trigger', 'hud', 'situation']);
	assert.equal(first.situation, 'the_nether, no day cycle; biome nether_wastes; armor worn 0/4, carried 4 diamond; weapon none; pickaxe none; food 100+ nutrition');
	assert.deepEqual(first.observation.world, { dimension: 'minecraft:the_nether', worldId: 'nether-run', difficulty: 'normal' });
	// The food summary is a header input, not another inventory field in the event.
	assert.equal(Object.hasOwn(first.observation.inventory, 'food'), false);
	// Programs, memory and watchers read the runtime observation, which keeps the raw facts.
	const runtime = adaptObservation(forestWire(0));
	buildNativeEventInput(record, { event: 'observation', trigger: 'start', observation: runtime });
	assert.deepEqual([runtime.world.gameTime, runtime.world.dayTime, runtime.world.biome, runtime.player.skyOpen], [1_000, 1_000, 'minecraft:forest', true]);

	const views = new ModelObservationViews();
	encodeNativeEventInput(eventInput(5), views);
	const repeat = decodeModelFacts(JSON.parse(encodeNativeEventInput(eventInput(6), views).split('\n')[1]));
	assert.equal(Object.hasOwn(repeat, 'situation'), false);
	assert.ok(repeat.sameAsPreviousEvent.includes('situation'));
	// An unchanged world section is no longer re-sent in a wake's change view.
	assert.equal(Object.hasOwn(repeat.observationView.replace, 'world'), false);
	const changed = decodeModelFacts(JSON.parse(encodeNativeEventInput(eventInput(12), views).split('\n')[1]));
	assert.match(changed.situation, /biome soul_sand_valley/);
});

test('walking in and out from under a roof never re-sends the situation line', () => {
	const views = new ModelObservationViews();
	const sent = Array.from({ length: 20 }, (_, index) => decodeModelFacts(JSON.parse(encodeNativeEventInput(eventInput(index, fullKitWire), views).split('\n')[1])));
	// Sent once at the start; the sky flips every wake and rides the player section instead.
	assert.deepEqual(sent.map((payload, index) => Object.hasOwn(payload, 'situation') ? index : null).filter((index) => index !== null), [0]);
	assert.deepEqual(sent.slice(1, 4).map((payload) => payload.observationView.replace.player.skyOpen), [false, true, false]);
});

test('a new task context swaps the generic instruction; danger and ordinary wakes keep theirs', () => {
	assert.equal(eventInput(0).split('\n')[0], compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION));
	assert.match(eventInput(5).split('\n')[0], /^Update; act on fresh facts\./);
	const danger = buildNativeEventInput(record, { event: 'program_attention', trigger: 'damage', newContext: true, observation: adaptObservation(netherWire(13)),
		programId: 'p', status: { state: 'RUNNING', decision: { trigger: 'damage', priority: 'urgent' } } });
	assert.match(danger.split('\n')[0], /^low health\. Food 17\/20 cannot regenerate health/);
	assert.match(danger.split('\n')[0], /Respond to the pending program decision after the immediate defense/);
});

// The byte baseline is main's own event builder at this change's merge base, loaded from git and fed what main's server
// sent (no biome, sky or food summary). Skipped only where that commit is unavailable, such as a shallow clone.
const BASE_COMMIT = 'c6327e81';
const SOURCE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
async function mainEventBuilder() {
	let source;
	try { source = execFileSync('git', ['show', `${BASE_COMMIT}:coordinator/src/dynamic-main.mjs`], { cwd: SOURCE_DIRECTORY, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
	catch { return null; }
	const file = path.join(SOURCE_DIRECTORY, `.situation-base-${process.pid}.mjs`);
	fs.writeFileSync(file, source);
	try { return (await import(pathToFileURL(file).href)).buildNativeEventInput; } finally { fs.rmSync(file, { force: true }); }
}
function asMainWire(wire) {
	const { biome, ...world } = wire.world;
	const { skyOpen, ...player } = wire.player;
	const { food, ...inventory } = wire.inventory;
	return { ...wire, world, player, inventory };
}
function replayBytes(baseline, wire) {
	let before = 0, after = 0;
	const oldViews = new ModelObservationViews(), newViews = new ModelObservationViews();
	for (let index = 0; index < 20; index += 1) {
		const args = { event: 'observation', trigger: trigger(index), eventSequence: index + 1 };
		before += Buffer.byteLength(encodeNativeEventInput(baseline(record, { ...args, observation: adaptObservation(asMainWire(wire(index))) }), oldViews));
		after += Buffer.byteLength(encodeNativeEventInput(eventInput(index, wire), newViews));
	}
	return { before, after };
}

test('byte budget: 20-event Nether and forest series cost less than main\'s real event builder', async (t) => {
	const baseline = await mainEventBuilder();
	if (baseline === null) { t.skip(`commit ${BASE_COMMIT} is not available`); return; }
	assert.doesNotMatch(baseline(record, { event: 'observation', observation: adaptObservation(asMainWire(netherWire(1))) }), /"situation"/, 'the baseline is main, not this change');
	for (const [name, wire] of [['nether', netherWire], ['forest', forestWire], ['night roof', nightRoofWire], ['full kit night roof', fullKitWire]]) {
		const { before, after } = replayBytes(baseline, wire);
		assert.ok(after < before, `${name}: after ${after} bytes >= before ${before} bytes`);
	}
});

test('wire validator accepts the biome, sky and food facts the server now sends', () => {
	const payload = { goalRevision: 1, observedAtEpochMs: 10, ready: true, status: 'ready', eventSequence: 1, attention: false, changedFacts: [],
		position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, view: { yaw: 0, pitch: 0 },
		player: { health: 20, maxHealth: 20, armor: 0, foodLevel: 20, saturation: 5, gameMode: 'survival', onGround: true, inWater: false, onFire: false,
			air: 300, maxAir: 300, suffocating: false, fallDistance: 0, effects: [], skyOpen: false },
		inventory: { items: [], selectedItem: 'minecraft:air', food: { items: 8, nutrition: 32, risky: [{ itemId: 'minecraft:chorus_fruit', count: 8, nutrition: 32 }] } },
		entities: [], blocks: [], nearbyContainers: [],
		world: { dimension: 'minecraft:the_end', biome: 'minecraft:the_end', gameTime: 1, dayTime: 1, raining: false, thundering: false },
		currentAction: { active: false }, lastResult: { present: false } };
	const validated = validateProtocolV2Payload('observation', payload);
	assert.equal(validated.player.skyOpen, false);
	assert.deepEqual(validated.inventory.food, payload.inventory.food);
	assert.equal(validated.world.biome, 'minecraft:the_end');
	assert.throws(() => validateProtocolV2Payload('observation', { ...payload, inventory: { ...payload.inventory, food: { items: 1, nutrition: 1, extra: 1 } } }));
});


test('matching tag counts do not prove food identities with component-patched stacks', () => {
	const items = [{ itemId: 'minecraft:cake', count: 1, slot: 0, tags: ['#c:foods'] },
		{ itemId: 'minecraft:stone', count: 1, slot: 1, tags: [] }];
	// Cake is edible after placement; the stone has a FOOD patch. Only the server component summary is authoritative.
	assert.match(situationFacts(observation({ items, food: { items: 1, nutrition: 4 } })), /; food under 20 nutrition$/);
});

test('a full grid is named with the carried stacks that can still take their item; any empty main slot says nothing', () => {
	const stack = (itemId, slot, count, maxStackSize = 64) => ({ itemId, count, slot, maxStackSize });
	// The server reports the held hotbar slot as "mainhand" and the other 35 main slots by number.
	const full = [stack('minecraft:iron_pickaxe', 'mainhand', 1, 1), ...Array.from({ length: 36 }, (_, slot) => slot)
		.filter((slot) => slot !== 7).map((slot) => stack('minecraft:cobblestone', slot, 64))];
	assert.match(situationFacts(observation({ items: full })), /; food none; inventory full, no room$/);
	const partial = full.map((row) => (row.slot === 3 ? stack('minecraft:dirt', 3, 9) : row.slot === 20 ? stack('minecraft:stick', 20, 2) : row));
	assert.match(situationFacts(observation({ items: partial })), /; inventory full, room for dirt, stick$/);
	// Armour and a full offhand never count as main slots; a partial offhand stack still takes its item.
	const offhand = [...full, stack('minecraft:iron_helmet', 'head', 1, 1), stack('minecraft:torch', 'offhand', 5)];
	assert.match(situationFacts(observation({ items: offhand })), /; inventory full, room for torch$/);
	// One empty main slot (no held item): nothing is added, so ordinary play never re-sends the line for capacity.
	assert.doesNotMatch(situationFacts(observation({ items: full.filter((row) => row.slot !== 'mainhand') })), /inventory/);
	const many = full.map((row, index) => (index > 0 && index <= 8 ? stack(`minecraft:item_${index}`, row.slot, 1) : row));
	assert.match(situationFacts(observation({ items: many })), /room for item_1, item_2, item_3, item_4, item_5, item_6, item_7, item_8$/);
	assert.match(situationFacts(observation({ items: many }), many), /room for item_1, item_2, item_3, item_4 \+4 more$/);
});

test('capacity identities survive the inventory row cut, overflow, and unread-message fallback', () => {
	const row = (id, slot, count = 64, maxStackSize = 64) => ({ itemId: `minecraft:${id}`, slot, count, maxStackSize,
		displayName: id.split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' '),
		...(Number.isInteger(slot) ? { hotbar: slot < 9 } : {}) });
	const items = [row('iron_shovel', 'mainhand', 1, 1), ...Array.from({ length: 35 }, (_, i) => row('andesite', i + 1))];
	const room = ['apple', 'bread', 'carrot', 'clay_ball', 'cobblestone', 'dirt'];
	for (const [i, id] of room.entries()) items[30 + i] = row(id, 30 + i, 1);
	for (const limit of [32, 16, 8]) {
		const obs = adaptObservation(wireOf({ inventory: { items, selectedItem: 'minecraft:iron_shovel', selectedSlot: 0 } }));
		const input = buildNativeEventInput(record, { event: 'observation', observation: obs,
			...(limit < 32 ? { taskMemory: { note: 'x'.repeat(20_000) } } : {}),
			...(limit === 8 ? { conversation: [{ sequence: 1, text: 'Collect dirt' }] } : {}) });
		const encoded = encodeNativeEventInput(input, new ModelObservationViews());
		const payload = decodeModelFacts(payloadOf(encoded));
		const retained = payload.observation.inventory.items;
		assert.equal(retained.length, limit);
		if (limit !== 8) {
			assert.equal(payload.observation.snapshotCounts.inventory, 36);
			assert.equal(payload.observation.omittedRows.inventory, 36 - retained.length);
		}
		for (const id of ['cobblestone', 'dirt']) assert.equal(retained.some((item) => item.itemId === `minecraft:${id}`), false);
		for (const id of room) assert.ok(payload.situation.includes(id), `missing headroom for ${id}, limit=${limit}`);
	}
});

test('item rows leave out a displayName that is the id in title case and a hotbar flag that follows from the slot, only when that saves bytes', () => {
	const row = (itemId, slot, displayName, count = 64) => ({ itemId, count, slot, displayName, maxStackSize: 64, ...(Number.isInteger(slot) ? { hotbar: slot < 9 } : {}) });
	const encoded = (items) => buildNativeEventInput(record, { event: 'observation', observation: adaptObservation(wireOf({ inventory: { items, selectedItem: 'minecraft:oak_planks', selectedSlot: 0 } })) });
	const full = [row('minecraft:oak_planks', 'mainhand', 'Oak Planks'), ...Array.from({ length: 20 }, (_, index) => row('minecraft:cobblestone', index + 1, 'Cobblestone')),
		row('minecraft:porkchop', 30, 'Raw Porkchop', 3), row('minecraft:stick', 31, 'Renamed Stick', 2)];
	const before = Buffer.byteLength(encoded(full.map((item) => ({ ...item, displayName: `${item.displayName}!` }))), 'utf8');
	const input = encoded(full);
	const payload = payloadOf(input);
	assert.equal(payload.observation.itemDefaults, 'Omitted item fields: displayName = itemId path in title case; hotbar = slot 0-8.');
	const rows = payload.observation.inventory.items;
	// Default names and slot-implied hotbar flags are gone; a name that differs from the id stays on its row.
	assert.equal(rows.find((item) => item.itemId === 'minecraft:cobblestone').displayName, undefined);
	assert.equal(rows.find((item) => item.itemId === 'minecraft:cobblestone').hotbar, undefined);
	assert.equal(rows.find((item) => item.itemId === 'minecraft:porkchop').displayName, 'Raw Porkchop');
	assert.equal(rows.find((item) => item.itemId === 'minecraft:stick').displayName, 'Renamed Stick');
	// Names that are not defaults keep everything, so the event is the same shape as before; smaller with defaults.
	assert.ok(Buffer.byteLength(input, 'utf8') < before);
	// One short row cannot pay for the note: nothing changes and no note is added.
	const one = payloadOf(encoded([row('minecraft:oak_planks', 'mainhand', 'Oak Planks', 3)]));
	assert.equal(Object.hasOwn(one.observation, 'itemDefaults'), false);
	assert.equal(one.observation.inventory.items[0].displayName, 'Oak Planks');
});
