import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildNativeEventInput, healingFacts } from '../src/dynamic-main.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, minecraftCapabilities, normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';

const food = { slot: 2, itemId: 'minecraft:cooked_beef', nutrition: 8 };
const observation = (player = {}, world = {}) => ({ player: { health: 4.09, maxHealth: 20, foodLevel: 18, saturation: 0,
	bestFood: food, safe: true, ...player }, world, inventory: { items: [] }, entities: [], blocks: [], items: [] });
const event = (obs, trigger = 'fire') => JSON.parse(buildNativeEventInput({ currentGoal: 'Explore.' },
	{ event: 'observation', trigger, observation: obs }).split('\n').slice(1).join('\n'));

test('regeneration eligibility does not imply recovery outruns burning', () => {
	const facts = healingFacts(observation({ onFire: true, fireTicks: 139 }));
	assert.equal(facts.naturalRegen, true);
	assert.equal(facts.regenHPPerSecondMax, 0.25);
	assert.equal(facts.canEat, true);
	assert.deepEqual(facts.burn, { seconds: 7, rawDamage: 6 });
	assert.equal(healingFacts(observation({ foodLevel: 20, saturation: 6 })).regenHPPerSecondMax, 2);
	assert.equal(healingFacts(observation({ foodLevel: 20, saturation: 1.5 })).regenHPPerSecondMax, 0.5);
	assert.equal(healingFacts(observation({ foodLevel: 17 })).regenHPPerSecondMax, 0);
	assert.equal(healingFacts(observation({}, { naturalRegeneration: false })).regenHPPerSecondMax, 0);
	assert.equal(healingFacts(observation({}, { difficulty: 'peaceful' })).regenHPPerSecondMax, null);
	assert.equal(healingFacts(observation({ foodLevel: 20, saturation: undefined })).regenHPPerSecondMax, null);
});

test('eatability is independent of nearby threats and honest about full or unknown hunger', () => {
	assert.equal(healingFacts(observation({ safe: false })).canEat, true);
	assert.equal(healingFacts(observation({ foodLevel: 20 })).canEat, false);
	assert.equal(healingFacts(observation({ foodLevel: undefined })).canEat, null);
	assert.equal(healingFacts(observation({ bestFood: null })).canEat, false);
	assert.equal(healingFacts(observation({ foodLevel: 20, bestFood: { ...food, itemId: 'minecraft:golden_apple', alwaysEdible: true } })).canEat, true);
	assert.match(healingFacts(observation({ bestFood: { ...food, slot: 12 } })).options[0], /select_item, then use_item durationMs:2000/);
});

test('wire eatability includes full-hunger alternatives and component-based always-edible food', () => {
	for (const itemId of ['minecraft:chorus_fruit', 'minecraft:suspicious_stew', 'custom:food']) {
		const raw = { ready: true, position: { x: 0, y: 64, z: 0 }, view: { yaw: 0, pitch: 0 },
			player: { health: 4, maxHealth: 20, foodLevel: 20, saturation: 0 }, inventory: { items: [] }, entities: [], blocks: [],
			survival: { safe: false, canHealNow: false, canEat: true, signals: [], bestFood: { ...food, itemId, alwaysEdible: true } } };
		assert.equal(event(adaptObservation(raw)).healing.canEat, true);
		assert.equal(event(adaptObservation(raw)).healing.bestFood.alwaysEdible, true);
		raw.survival.bestFood = { ...food, alwaysEdible: false };
		assert.equal(event(adaptObservation(raw)).healing.canEat, true, 'an edible alternative counts when steak ranks higher');
		raw.survival.bestFood = undefined;
		assert.equal(event(adaptObservation(raw)).healing.canEat, true, 'risky food still counts even when excluded from bestFood');
	}
	assert.equal(healingFacts(observation({ foodLevel: 20, bestFood: { ...food, alwaysEdible: true } })).canEat, true);
});

test('burning events expose eligibility and eatability without repeating empty food-source lists', () => {
	const payload = event(observation({ onFire: true, fireTicks: 139 }));
	assert.equal(payload.healing.regenHPPerSecondMax, undefined, 'a hidden saturation-dependent rate is not a HUD fact');
	assert.equal(payload.healing.canEat, true);
	assert.equal(payload.healing.foodSources, undefined);
	assert.match(payload.healing.options[0], /control use:true,ticks:40,selectedSlot:2/);
	const contact = event(observation({ onFire: true, hazard: 'fire', fireTicks: 139 }));
	assert.equal(contact.healing.canEat, true);
	assert.equal(contact.healing.options, undefined, 'contact retains the exit-focused policy');
	assert.deepEqual(Object.keys(contact.healing).sort(), ['bestFood', 'burn', 'canEat', 'foodLevel', 'regenFoodReady']);
	const quiet = event(observation(), 'structure_sighted');
	assert.equal(quiet.healing.regenFoodReady, true, 'low health carries food facts even on an unrelated event');
});

test('the complete control tool expresses eating without growing its description', () => {
	const control = MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === 'control');
	assert.match(control.description, /use:true/);
	assert.match(control.description, /40 ticks/);
	assert.ok(Buffer.byteLength(control.description) <= 509);
	assert.equal(normalizeMinecraftToolCall('control', { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false,
		attack: false, use: true, yaw: 0, pitch: 0, selectedSlot: 2, hand: 'main', ticks: 32 }).arguments.use, true);
});

test('on-demand apple use example holds long enough and explains the consumption receipt', () => {
	const reference = minecraftCapabilities({ section: 'control', topic: 'action:use_item' }).reference;
	assert.match(reference, /"durationMs":2000/);
	assert.match(reference, /1\.6 s/);
	assert.match(reference, /unconfirmed/);
	const source = readFileSync(new URL('../src/native-minecraft-tools.mjs', import.meta.url), 'utf8');
	assert.match(source, /Most foods take 1\.6 s/, 'the existing shared instructions stay in place');
});

test('recorded low-health food sample exposes regeneration eligibility during burning', () => {
	const fixtures = JSON.parse(readFileSync(new URL('./fixtures/eating-replay.json', import.meta.url), 'utf8'));
	const trace = fixtures.find(row => row.trace === 'B/S1-r2' && row.series);
	const raw = trace.series.find(row => row.observation.player.foodLevel === 18 && row.observation.player.saturation === 0
		&& row.observation.survival?.safe === true && row.observation.player.health < 7).observation;
	const before = structuredClone(raw);
	const payload = event(adaptObservation(raw), 'damage');
	assert.equal(payload.healing.canEat, true);
	assert.equal(payload.healing.regenFoodReady, true);
	assert.equal(payload.healing.regenHPPerSecondMax, undefined, 'a hidden saturation-dependent rate is not a HUD fact');
	assert.equal(payload.healing.bestFood.slot, 2);
	assert.deepEqual(payload.healing.burn, { remaining: 'not_observed' }, 'a hidden fire timer is not a known duration');
	assert.deepEqual(raw, before, 'fact projection never mutates inputs or dispatches a body action');
});
