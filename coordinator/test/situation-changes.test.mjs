import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentRegistry } from '../src/agent-registry.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start } from './fixtures/dynamic-main-fixture.mjs';
import { SITUATION_CHANGED_FIELD, SituationChangeTracker, situationChanges, situationSnapshot } from '../src/situation-changes.mjs';

const OVERWORLD = 'minecraft:overworld';
const NETHER = 'minecraft:the_nether';
const gear = (itemId, slot = 0) => ({ itemId: `minecraft:${itemId}`, count: 1, slot, maxDamage: 250 });
const KIT = [gear('iron_pickaxe'), gear('iron_sword', 1), gear('iron_helmet', 'head')];

function observation({ dimension = OVERWORLD, biome = 'minecraft:plains', dayTime = 1_000, health = 20, foodLevel = 20, y = 70, skyOpen = true, items = KIT, structures = [], dead = false, ...player } = {}) {
	return {
		ready: true,
		world: { worldId: 'w', dimension, biome, dayTime },
		player: { x: 0, y, z: 0, dead, health, maxHealth: 20, foodLevel, ...(dimension === OVERWORLD ? { skyOpen } : {}), ...player },
		inventory: { items },
		...(structures.length === 0 ? {} : { sighted: { structures: structures.map((structure) => ({ structure, distance: 40 })) } }),
	};
}

/** Delivers each wake in order and returns the changed line of each one. */
function replay(samples, tracker = new SituationChangeTracker()) {
	return samples.map(({ at, delivered = true, ...options }) => {
		const { event, trigger, hpReported, lavaReported, strategyTopic, ...facts } = options;
		const { text, token } = tracker.line(observation(facts), { at, event, trigger, hpReported, lavaReported, strategyTopic });
		tracker.settle(token, delivered);
		return text;
	});
}

const changeOf = (before, after, options) => situationChanges(situationSnapshot(observation(before)), situationSnapshot(observation(after)), options).map(({ kind, text }) => [kind, text]);

test('each change kind is one factual phrase naming what it makes untrue', () => {
	assert.deepEqual(changeOf({}, { dimension: NETHER, biome: 'minecraft:nether_wastes' }), [['dimension', 'dimension overworld->the_nether']]);
	assert.deepEqual(changeOf({ dayTime: 12_000 }, { dayTime: 13_800 }), [['time', 'night began']]);
	assert.deepEqual(changeOf({ dayTime: 22_000 }, { dayTime: 23_400 }), [['time', 'dawn']]);
	assert.deepEqual(changeOf({}, { biome: 'minecraft:desert' }), [['biome', 'biome plains->desert']]);
	assert.deepEqual(changeOf({}, { items: [KIT[1], KIT[2]] }), [['gear', 'lost iron pickaxe: steps needing it are unmet']]);
	assert.deepEqual(changeOf({}, { items: [] }), [['gear', 'lost iron helmet+pickaxe+sword: steps needing them are unmet']]);
	assert.deepEqual(changeOf({}, { health: 9 }), [['health', 'health 20->9']]);
	assert.deepEqual(changeOf({ foodLevel: 19, health: 14 }, { foodLevel: 5, health: 14 }), [['food', 'food 19->5: no food-based healing or sprinting']]);
	assert.deepEqual(changeOf({}, { inLava: true }), [['lava', 'in lava']]);
	assert.deepEqual(changeOf({}, { underWater: true }), [['water', 'under water']]);
	assert.deepEqual(changeOf({}, { y: 40, skyOpen: false }), [['cover', 'no open sky above']]);
	assert.deepEqual(changeOf({ dimension: NETHER, biome: 'minecraft:nether_wastes' }, { items: [] }, { died: true }),
		[['death', 'respawned in overworld without pre-death gear: steps needing it are unmet']]);
	assert.deepEqual(changeOf({}, {}, { died: true }), [['death', 'respawned after death']], 'keepInventory: nothing was lost');
});

test('only material changes count; facts the wake already reports are not repeated', () => {
	for (const [before, after] of [
		[{ biome: 'minecraft:forest' }, { biome: 'minecraft:birch_forest' }], [{ biome: 'minecraft:snowy_plains' }, { biome: 'minecraft:grove' }],
		[{ health: 20 }, { health: 15 }], [{ foodLevel: 17 }, { foodLevel: 14 }], [{ dayTime: 1_000 }, { dayTime: 11_500 }],
		// The Nether has no sky to lose.
		[{ dimension: NETHER, biome: 'minecraft:nether_wastes' }, { dimension: NETHER, biome: 'minecraft:nether_wastes', y: 30 }],
	]) assert.deepEqual(changeOf(before, after), [], JSON.stringify(after));
	assert.deepEqual(changeOf({}, { biome: 'minecraft:cherry_grove' }).map(([kind]) => kind), ['biome'], 'cherry_grove is not snowy');
	assert.deepEqual(changeOf({ dimension: NETHER, biome: 'minecraft:nether_wastes' }, { dimension: NETHER, biome: 'minecraft:soul_sand_valley' }).map(([kind]) => kind), ['biome'],
		'each Nether biome is its own family');
	assert.deepEqual(changeOf({}, { health: 6 }, { hpReported: true }), []);
	assert.deepEqual(changeOf({}, { inLava: true }, { lavaReported: true }), []);
	assert.equal(situationSnapshot(observation({ dead: true })), null);
});

// Review q5-orientation r1 findings: each change states only what the observation and game rules support.
test('r1 P2-1: sky cover is reported as observed, never inferred as a cave from Y', () => {
	const END = { dimension: 'minecraft:the_end', biome: 'minecraft:the_end' };
	for (const [label, before, after] of [
		['high mountain cave', { y: 100 }, { y: 100, skyOpen: false }],
		['low roof', { y: 62 }, { y: 62, skyOpen: false }],
		// The End has sky light, so the collector reports skyOpen there too.
		['End', { ...END, skyOpen: true }, { ...END, skyOpen: false }],
	]) {
		const observe = (facts) => ({ ...observation(facts), player: { ...observation(facts).player, skyOpen: facts.skyOpen ?? true } });
		const changes = situationChanges(situationSnapshot(observe(before)), situationSnapshot(observe(after))).map(({ text }) => text);
		assert.deepEqual(changes, ['no open sky above'], label);
	}
	assert.deepEqual(changeOf({ dimension: NETHER, biome: 'minecraft:nether_wastes' }, { dimension: NETHER, biome: 'minecraft:nether_wastes', y: 20 }), [], 'the Nether reports no sky');
});

test('r1 P2-2: water and dawn keep only consequences the observed facts support', () => {
	assert.deepEqual(changeOf({}, { underWater: true, effects: [{ effectId: 'minecraft:water_breathing', amplifier: 0, duration: 3600 }] }), [['water', 'under water']]);
	const dawn = (weather) => {
		const facts = (dayTime) => ({ ...observation({ dayTime }), world: { ...observation({ dayTime }).world, ...weather } });
		return situationChanges(situationSnapshot(facts(22_000)), situationSnapshot(facts(23_400))).map(({ text }) => text);
	};
	// r2: even a clear dawn does not stop every surface spawn (patrols, slimes), so the turn is reported alone.
	assert.deepEqual(dawn({ raining: false, thundering: false }), ['dawn']);
	assert.deepEqual(dawn({ raining: true, thundering: true }), ['dawn'], 'thunderstorm darkness still allows spawns');
	assert.deepEqual(dawn({ raining: true, thundering: false }), ['dawn'], 'weather unknown to the light rule claims nothing');
	assert.deepEqual(dawn({}), ['dawn'], 'unobserved weather claims nothing');
	// Spawning depends on difficulty, gamerules, light and per-mob rules the line does not see: no spawn claim either way.
	for (const text of [...dawn({ raining: false, thundering: false }), ...changeOf({ dayTime: 12_000 }, { dayTime: 13_800 }).map(([, line]) => line)]) assert.doesNotMatch(text, /spawn|hostile|burn/);
});

test('r1 P2-3: crossing the healing and sprinting food thresholds is reported at any size of drop', () => {
	assert.deepEqual(changeOf({ foodLevel: 18, health: 14 }, { foodLevel: 17, health: 14 }), [['food', 'food 17: no food-based healing']]);
	assert.deepEqual(changeOf({ foodLevel: 18 }, { foodLevel: 17 }), [], 'at full health there is no healing to lose');
	assert.deepEqual(changeOf({ foodLevel: 18, health: 14 }, { foodLevel: 17, health: 14 }, { healingReported: true }), [], 'the healing section already states it');
	assert.deepEqual(changeOf({ foodLevel: 7 }, { foodLevel: 6 }), [['food', 'food 6: no sprinting']]);
	assert.deepEqual(changeOf({ foodLevel: 20 }, { foodLevel: 19 }), []);
	const ruled = (world, player = {}) => {
		const facts = (foodLevel) => { const base = observation({ foodLevel, health: 14, ...player }); return { ...base, world: { ...base.world, ...world } }; };
		return situationChanges(situationSnapshot(facts(18)), situationSnapshot(facts(17))).map(({ text }) => text);
	};
	// HUD parity: the hidden gamerule is never read; below 18, food never heals whatever it says.
	assert.deepEqual(ruled({ naturalRegeneration: false }), ['food 17: no food-based healing']);
	assert.deepEqual(ruled({ difficulty: 'peaceful' }), ['food 17: no food-based healing']);
	// Gradual depletion reports the crossing once; eating back and dropping again soon is held by the cooldown.
	assert.deepEqual(replay([
		{ at: 0, foodLevel: 20, health: 14 }, { at: 10_000, foodLevel: 19, health: 14 }, { at: 20_000, foodLevel: 18, health: 14 }, { at: 30_000, foodLevel: 17, health: 14 },
		{ at: 40_000, foodLevel: 18, health: 14 }, { at: 50_000, foodLevel: 17, health: 14 }, { at: 100_000, foodLevel: 17, health: 14 },
	]), [null, null, null, 'food 17: no food-based healing', null, null, 'food 17: no food-based healing']);
});

test('r1 P3: dawn after a quick sleep is not held by the cooldown; dark forest is its own family', () => {
	assert.deepEqual(replay([{ at: 0, dayTime: 12_900 }, { at: 5_000, dayTime: 13_100 }, { at: 15_000, dayTime: 23_100 }]),
		[null, 'night began', 'dawn']);
	assert.deepEqual(changeOf({ biome: 'minecraft:forest' }, { biome: 'minecraft:dark_forest' }), [['biome', 'biome forest->dark_forest']]);
});

// Review q4-hud-parity r1, merge section: the line shows nothing the HUD-parity model view hides.
test('hud parity: hearts round up as drawn, absorption counts, and hidden sky, clock and biome stay hidden', () => {
	assert.deepEqual(changeOf({ health: 9.5 }, { health: 3.2 }), [['health', 'health 10->4']], 'ceil, as the HUD draws hearts');
	assert.deepEqual(changeOf({ health: 20, absorption: 8 }, { health: 20, absorption: 0 }), [['health', 'health 20->20, absorption 8->0']]);
	assert.deepEqual(changeOf({ health: 20, absorption: 4 }, { health: 17, absorption: 0 }), [['health', 'health 20->17, absorption 4->0']]);
	assert.deepEqual(changeOf({ dayTime: 12_000, skyOpen: false, y: 40 }, { dayTime: 13_800, skyOpen: false, y: 40 }), [], 'no sky in view: no clock');
	for (const text of replay([{ at: 0, dayTime: 12_000 }, { at: 5_000, dayTime: 13_800 }])) assert.doesNotMatch(text ?? '', /d+s ago/, 'no exact clock');
	const hidden = (biome) => { const base = observation({ biome }); return { ...base, world: { ...base.world, reducedDebugInfo: true } }; };
	assert.deepEqual(situationChanges(situationSnapshot(hidden('minecraft:plains')), situationSnapshot(hidden('minecraft:desert'))), [], 'reduced debug info hides the biome');
});

// Review q5-orientation r3: an absorption loss held by the cooldown stays owed, like every other held change.
test('r3: an absorption loss during the cooldown is reported once the cooldown ends', () => {
	assert.deepEqual(replay([
		{ at: 0, absorption: 16 }, { at: 1_000, absorption: 8 }, { at: 2_000, absorption: 16 },
		{ at: 3_000, absorption: 8 }, { at: 62_000, absorption: 8 }, { at: 70_000, absorption: 8 },
	]), [null, 'health 20->20, absorption 16->8', null, null, 'health 20->20, absorption 16->8', null]);
});

test('replay: Nether kit, death, overworld respawn; each change is reported once', () => {
	const NETHER_KIT = [gear('diamond_pickaxe'), gear('diamond_sword', 1), gear('diamond_helmet', 'head'), gear('diamond_boots', 'feet')];
	const nether = { dimension: NETHER, biome: 'minecraft:nether_wastes', items: NETHER_KIT };
	assert.deepEqual(replay([
		{ at: 0, trigger: 'start', ...nether, structures: ['nether fortress'] },
		{ at: 5_000, ...nether, structures: ['nether fortress'] },
		{ at: 9_000, ...nether, structures: ['nether fortress', 'bastion remnant'] },
		{ at: 12_000, event: 'player_death', ...nether, dead: true },
		{ at: 15_000, trigger: 'respawn', items: [] },
		{ at: 20_000, items: [] },
	]), [null, null, 'first sight: bastion remnant', null,
		'respawned in overworld without pre-death gear: steps needing it are unmet', null]);
});

test('replay: nightfall, cave and biome ride on the next wake, debounced by net change and a cooldown', () => {
	assert.deepEqual(replay([
		{ at: 0, dayTime: 12_000 },
		{ at: 10_000, dayTime: 13_200, y: 50, skyOpen: false },
		// Out of the cave and back in between wakes: no net change, nothing to say.
		{ at: 20_000, dayTime: 13_400, y: 52, skyOpen: false },
		{ at: 30_000, dayTime: 13_600, biome: 'minecraft:desert' },
		// Back over the border at once: held by the cooldown ...
		{ at: 40_000, dayTime: 13_800 },
		{ at: 60_000, dayTime: 14_200 },
		// ... and reported once the cooldown ends, because it still differs from what the model last read.
		{ at: 95_000, dayTime: 14_900 },
		{ at: 120_000, dayTime: 15_400 },
	// Night fell while under cover, so it is first seen, and reported, back under open sky.
	]), [null, 'no open sky above', null,
		'biome plains->desert; night began', null, null, 'biome desert->plains', null]);
});

test('an undelivered wake keeps its changes owed, and a steer built during an in-flight turn does not repeat them', () => {
	const tracker = new SituationChangeTracker();
	const settle = ({ token }, delivered) => tracker.settle(token, delivered);
	settle(tracker.line(observation(), { at: 0 }), true);
	const lost = observation({ items: [] });
	const failed = tracker.line(lost, { at: 1_000 });
	assert.match(failed.text, /^lost iron/);
	settle(failed, false);
	const turn = tracker.line(lost, { at: 2_000 });
	assert.match(turn.text, /^lost iron/, 'still owed after the failed delivery');
	const steer = tracker.line(observation({ items: [], health: 8 }), { at: 3_000 });
	assert.equal(steer.text, 'health 20->8', 'the in-flight turn already carries the loss');
	settle(steer, true);
	settle(turn, true);
	assert.equal(tracker.line(observation({ items: [], health: 8 }), { at: 4_000 }).text, null, 'the older turn does not roll the baseline back');
});

test('a death is owed through a failed respawn delivery, and a strategy topic is pointed to once', () => {
	const tracker = new SituationChangeTracker();
	const settle = ({ token }, delivered) => tracker.settle(token, delivered);
	const first = tracker.line(observation(), { at: 0, strategyTopic: 'survival' });
	assert.deepEqual([first.text, first.strategy], [null, 'survival'], 'a first wake may carry a pointer');
	settle(first, true);
	tracker.line(observation({ dead: true }), { at: 1_000, event: 'player_death' });
	settle(tracker.line(observation({ items: [] }), { at: 2_000 }), false);
	const respawn = tracker.line(observation({ items: [] }), { at: 3_000, strategyTopic: 'survival' });
	assert.deepEqual([respawn.text, respawn.strategy], ['respawned without pre-death gear: steps needing it are unmet', null], 'survival was already pointed to');
	settle(respawn, true);
	const lava = tracker.line(observation({ items: [], inLava: true }), { at: 4_000, lavaReported: true, strategyTopic: 'hazards' });
	assert.deepEqual([lava.text, lava.strategy], [null, 'hazards'], 'a pointer needs no other change');
	settle(lava, false);
	assert.equal(tracker.line(observation({ items: [], inLava: true }), { at: 5_000, lavaReported: true, strategyTopic: 'hazards' }).strategy, 'hazards', 'an undelivered pointer stays owed');
});

test('coordinator: the next existing wake carries a dimension change once, then ordinary wakes carry nothing', async () => {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'low' });
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		// The first delivery of the crossing fails, so its retry must carry it again.
		if (planner.requests.length === 2) throw Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
		return { toolCalls: 0 };
	};
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } },
		config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	const completed = (count) => eventually(() => rows.filter(({ event }) => event === 'native_turn_completed').length === count);
	const sample = (sequence, dimension, changedFacts) => ({ agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence, attention: true, observedAtEpochMs: sequence, changedFacts,
		observation: { player: { x: sequence, y: 64, z: 0, health: 20 }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} },
			world: { dimension, gameTime: 1_000 + sequence, dayTime: 1_000 + sequence, raining: false, thundering: false } } } });
	const wakeOf = (index) => JSON.parse(planner.requests[index].input.split('\n')[1]);
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat the game.' } });
		run.bridge.emit('observation', sample(1, OVERWORLD, ['blocks']));
		await completed(1);
		assert.equal(Object.hasOwn(wakeOf(0), 'changed'), false, 'a first view has nothing to compare with');
		run.bridge.emit('observation', sample(2, NETHER, ['world.dimension']));
		await eventually(() => planner.requests.length === 2);
		assert.equal(wakeOf(1).changed, 'dimension overworld->the_nether');
		await eventually(() => rows.some(({ event }) => event === 'native_turn_failed'));
		run.bridge.emit('observation', sample(3, NETHER, ['blocks']));
		await eventually(() => planner.requests.length === 3);
		assert.equal(wakeOf(2).changed, 'dimension overworld->the_nether', 'still owed after the failed delivery');
		await completed(2);
		run.bridge.emit('observation', sample(4, NETHER, ['blocks']));
		await eventually(() => planner.requests.length === 4);
		assert.equal(Object.hasOwn(wakeOf(3), 'changed'), false, 'delivered once');
	} finally { await run.coordinator.stop(); }
});

test('the wake carries the line beside situation, never on a planning advisory', () => {
	const record = { agentId: 'a', currentGoal: 'g', goalRevision: 1 };
	const payload = (options) => JSON.parse(buildNativeEventInput(record, { observation: observation(), ...options }).split('\n')[1]);
	const wake = payload({ changed: 'biome plains->desert' });
	assert.equal(SITUATION_CHANGED_FIELD, 'changed');
	assert.equal(wake.changed, 'biome plains->desert');
	assert.deepEqual(Object.keys(wake).slice(Object.keys(wake).indexOf('situation'), Object.keys(wake).indexOf('situation') + 2), ['situation', 'changed']);
	assert.equal(Object.hasOwn(payload({}), 'changed'), false);
	assert.equal(Object.hasOwn(payload({ event: 'program_planning_due', changed: 'x' }), 'changed'), false);
	// The pointer is a bare id: at most 22 bytes for the longest current topic id, with no other change needed.
	const pointed = payload({ strategy: 'survival' });
	assert.equal(pointed.strategy, 'survival');
	assert.equal(Buffer.byteLength(JSON.stringify({ a: 1, strategy: 'survival' })) - Buffer.byteLength(JSON.stringify({ a: 1 })), 22);
	assert.equal(Object.hasOwn(payload({ event: 'program_planning_due', strategy: 'survival' }), 'strategy'), false);
});
