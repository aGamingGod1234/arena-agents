import assert from 'node:assert/strict';
import test from 'node:test';

import { createInterpreterFacts, changedInterpreterFactDomains } from '../src/arena-script/facts.mjs';
import { ArenaScriptInterpreter, freezeQueryResult, freezeRuntimeResult } from '../src/arena-script/interpreter.mjs';
import { parseArenaScript } from '../src/arena-script/parser.mjs';
import { SCRIPT_BINDINGS } from '../src/arena-script/minecraft-api.mjs';

const prefix = 'program.onUnhandledAttention("continue_and_notify");';
const observation = (tick = 900, player = {}, world = {}) => ({
	player: { health: 17.25, maxHealth: 20, absorption: 1.25, entityId: 1, x: 1.123456, y: 64, z: 0,
		foodLevel: 10, hunger: 10, saturation: 4.25, onFire: true, fire: true, fireTicks: 137,
		air: 58, maxAir: 300, airSecondsLeft: 2.9, skyOpen: false,
		effects: [{ effectId: 'minecraft:poison', duration: 199 }, { effectId: 'minecraft:night_vision', duration: -1 }],
		harm: { source: 'minecraft:on_fire', hpLossPerSecond: 2.4 }, hazard: 'fire', exits: ['front 1m'],
		hurtBy: 'on_fire', recentDamage: { cause: 'arrow', direction: 'left' }, ...player },
	world: { gameTime: tick, dayTime: 13001, naturalRegeneration: true, biome: 'minecraft:plains', dimension: 'minecraft:overworld', raining: true, ...world },
	entities: [{ stableId: 'e', type: 'minecraft:zombie', x: 2.123456, y: 64, z: 0, health: 19.37, maxHealth: 20 }],
	items: [], blocks: [], inventory: { items: [], tagCounts: {} },
});
const vm = source => new ArenaScriptInterpreter(parseArenaScript(prefix + source), SCRIPT_BINDINGS);

test('trusted script facts mask hidden counters while preserving visible aliases, contact and harm rate', () => {
	const raw = observation();
	const facts = createInterpreterFacts(raw);
	for (const key of ['saturation', 'fireTicks', 'airSecondsLeft', 'maxAir']) assert.equal(Object.hasOwn(facts.player, key), false, key);
	assert.equal(facts.player.health, 18);
	assert.equal(facts.player.absorption, 2);
	assert.equal(facts.player.x, 1.123);
	assert.equal(facts.player.airBubbles, 2);
	assert.equal(facts.player.air, 60, 'legacy air guards receive a visible-bubble-derived coarse value');
	assert.equal(facts.player.hunger, 10);
	assert.equal(facts.player.fire, true);
	assert.equal(facts.player.hazard, 'fire');
	assert.deepEqual([...facts.player.exits], ['front 1m']);
	assert.equal(facts.player.hurtBy, 'on_fire');
	assert.equal(facts.player.recentDamage.direction, 'left');
	assert.equal(facts.player.harm.hpLossPerSecond, 2.4);
	assert.equal(facts.player.effects[0].duration, 180);
	assert.equal(facts.player.effects[1].duration, -1);
	for (const key of ['gameTime', 'dayTime', 'naturalRegeneration', 'raining']) assert.equal(Object.hasOwn(facts.world.state, key), false, key);
	assert.equal(facts.world.state.worldTick, 0);
	assert.equal(facts.world.entities[0].health, undefined);
	assert.equal(facts.world.entities[0].maxHealth, undefined);
	assert.equal(facts.world.entities[0].x, 2.123);
	assert.ok(Object.isFrozen(facts.player.effects[0]));
	assert.equal(raw.player.saturation, 4.25, 'runtime/classifier observation is unchanged');
	assert.equal(raw.world.gameTime, 900);
});

test('changes below HUD precision do not trigger public watcher domains', () => {
	const first = createInterpreterFacts(observation());
	const next = createInterpreterFacts(observation(900, { saturation: 9, fireTicks: 131, air: 59, health: 17.75,
		effects: [{ effectId: 'minecraft:poison', duration: 195 }, { effectId: 'minecraft:night_vision', duration: -1 }],
	}), first);
	assert.equal(next, first);
	assert.equal(changedInterpreterFactDomains(first, next), 0);
});

test('public worldTick measures elapsed ticks and resets for body, dimension, death, unavailable facts and rollback', () => {
	let facts = createInterpreterFacts(observation());
	assert.equal(facts.world.state.worldTick, 0);
	facts = createInterpreterFacts(observation(940), facts);
	assert.equal(facts.world.state.worldTick, 40);
	facts = createInterpreterFacts(observation(950, {}, { dimension: 'minecraft:the_nether' }), facts);
	assert.equal(facts.world.state.worldTick, 0);
	facts = createInterpreterFacts(observation(960, {}, { dimension: 'minecraft:the_nether' }), facts);
	assert.equal(facts.world.state.worldTick, 10);
	facts = createInterpreterFacts(observation(970, { entityId: 2 }, { dimension: 'minecraft:the_nether' }), facts);
	assert.equal(facts.world.state.worldTick, 0);
	facts = createInterpreterFacts(observation(975, { entityId: 2, health: 0, dead: true }, { dimension: 'minecraft:the_nether' }), facts);
	assert.equal(facts.world.state.worldTick, undefined);
	facts = createInterpreterFacts(observation(1000, { entityId: 3 }), facts);
	assert.equal(facts.world.state.worldTick, 0);
	facts = createInterpreterFacts({ player: {}, world: {}, inventory: { items: [], tagCounts: {} } }, facts);
	assert.equal(facts.world.state.worldTick, undefined);
	facts = createInterpreterFacts(observation(1040, { entityId: 3 }), facts);
	assert.equal(facts.world.state.worldTick, 0);
	facts = createInterpreterFacts(observation(1030, { entityId: 3 }), facts);
	assert.equal(facts.world.state.worldTick, 0);
});

test('custom unbranded interpreter facts obey the same mask and private elapsed clock', () => {
	const raw = observation();
	const custom = tick => ({ player: raw.player, world: { state: { ...raw.world, gameTime: tick }, entities: raw.entities }, inventory: { items: [], tagCounts: {} } });
	assert.throws(() => vm('program.finish(player.state().saturation);').start(custom(12000)), error => error.code === 'UNKNOWN_MEMBER');
	const program = vm(`
		if (player.state().health !== 18 || player.state().air !== 60) program.finish("wrong precision");
		await player.wait(world.state().worldTick + 1);
		program.finish(world.state().worldTick === 10 && player.state().harm.hpLossPerSecond === 2.4 ? "elapsed" : "leaked");
	`);
	const command = program.start(custom(12000));
	assert.equal(command.call.arguments, 1);
	const done = program.resume({ stateToken: command.stateToken, state: 'SUCCEEDED', reasonCode: 'DONE' }, custom(12010));
	assert.equal(done.summary, 'elapsed');
});

test('inspection results cannot launder semantic hidden player/world/entity numbers', () => {
	const raw = observation();
	raw.world.worldTick = 900;
	const projected = freezeQueryResult(raw);
	for (const key of ['saturation', 'fireTicks', 'airSecondsLeft']) assert.equal(projected.player[key], undefined);
	for (const key of ['gameTime', 'dayTime', 'worldTick', 'naturalRegeneration']) assert.equal(projected.world[key], undefined);
	assert.equal(projected.entities[0].health, undefined);
	const laundering = vm('const page = await world.inspect({section:"entities"}); program.finish(page.player.saturation);');
	const badQuery = laundering.start(createInterpreterFacts(observation()));
	assert.throws(() => laundering.resume({ stateToken: badQuery.stateToken, state: 'SUCCEEDED', reasonCode: 'INSPECTED', value: raw }, createInterpreterFacts(observation())), error => error.code === 'UNKNOWN_MEMBER');
	const program = vm(`const page = await world.inspect({section:"entities",limit:16});
		program.finish(page.player.health === 18 && page.player.air === 60 && page.player.harm.hpLossPerSecond === 2.4 ? "masked" : "wrong precision");`);
	const query = program.start(createInterpreterFacts(observation()));
	const done = program.resume({ stateToken: query.stateToken, state: 'SUCCEEDED', reasonCode: 'INSPECTED', value: raw }, createInterpreterFacts(observation()));
	assert.equal(done.summary, 'masked');
	assert.equal(raw.entities[0].health, 19.37);
});

test('reduced debug applies to public facts and query responses, including a changed dimension before a query resumes', () => {
	const raw = observation(900, {}, { reducedDebugInfo: true });
	const facts = createInterpreterFacts(raw);
	for (const key of ['x', 'y', 'z', 'yaw', 'pitch']) assert.equal(Object.hasOwn(facts.player, key), false, key);
	assert.equal(facts.world.state.biome, undefined);
	const projected = freezeQueryResult(observation(), { reducedDebugInfo: true });
	assert.equal(projected.player.x, undefined);
	assert.equal(projected.world.biome, undefined);
	const program = vm(`const page = await world.inspect({section:"hud"}); program.finish(page.player.x);`);
	const query = program.start(createInterpreterFacts(observation()));
	assert.throws(() => program.resume({ stateToken: query.stateToken, state: 'SUCCEEDED', reasonCode: 'INSPECTED', value: observation() }, facts), error => error.code === 'UNKNOWN_MEMBER');
});

test('masking validates hidden and nested fields before invoking getters or proxy traps', () => {
	let reads = 0;
	const hostile = Object.defineProperty({}, 'saturation', { enumerable: true, get() { reads++; return 4; } });
	assert.throws(() => createInterpreterFacts({ ...observation(), player: hostile }), TypeError);
	assert.throws(() => freezeQueryResult({ player: hostile }));
	const proxy = new Proxy({}, { get() { reads++; return 4; }, ownKeys() { reads++; return []; } });
	assert.throws(() => freezeQueryResult({ player: proxy }));
	const custom = { player: hostile, world: {}, inventory: { items: [], tagCounts: {} } };
	assert.throws(() => vm('await player.wait(1);').start(custom));
	const context = Object.defineProperty({}, 'reducedDebugInfo', { enumerable: true, get() { reads++; return true; } });
	assert.throws(() => freezeQueryResult({ player: { health: 20 } }, context));
	assert.equal(reads, 0);
});

test('absent harm stays explicit null in both trusted and custom public state', () => {
	const facts = createInterpreterFacts({ ...observation(), player: { health: 20 } });
	assert.equal(facts.player.harm, null);
	assert.equal(vm('program.finish(player.state().harm === null ? "quiet" : "wrong");').start({ player: { health: 20 }, world: {}, inventory: { tagCounts: {} } }).summary, 'quiet');
});

test('raw host receipt validation preserves classifier counters and harm before the public projection', () => {
	const raw = { state: 'SUCCEEDED', reasonCode: 'DONE', eventSequence: 12, observation: observation() };
	const receipt = freezeRuntimeResult(raw);
	assert.equal(receipt.observation.player.saturation, 4.25);
	assert.equal(receipt.observation.player.health, 17.25);
	assert.equal(receipt.observation.player.fireTicks, 137);
	assert.equal(receipt.observation.player.air, 58);
	assert.equal(receipt.observation.player.airSecondsLeft, 2.9);
	assert.equal(receipt.observation.world.gameTime, 900);
	assert.equal(receipt.observation.world.naturalRegeneration, true);
	assert.equal(receipt.observation.entities[0].health, 19.37);
	assert.equal(receipt.observation.player.harm.hpLossPerSecond, 2.4);
	assert.ok(Object.isFrozen(receipt.observation.player.harm));
	assert.notEqual(receipt.observation.player, raw.observation.player);
	const publicReceipt = freezeQueryResult(raw);
	assert.equal(publicReceipt.observation.player.saturation, undefined);
	assert.equal(publicReceipt.observation.player.harm.hpLossPerSecond, 2.4);
	let reads = 0;
	const hostile = Object.defineProperty({}, 'gameTime', { enumerable: true, get() { reads++; return 900; } });
	assert.throws(() => freezeRuntimeResult({ observation: { world: hostile } }));
	assert.equal(reads, 0);
});

test('nullable threat fields stay readable by existing authored guards', () => {
	const source = observation(900, { threat: null, highestRiskThreat: null, bestWeapon: null, heardLava: null });
	const facts = createInterpreterFacts(source);
	for (const field of ['threat', 'highestRiskThreat', 'bestWeapon', 'heardLava']) assert.equal(facts.player[field], null, field);
	const result = vm('program.finish(player.state().threat !== null || player.state().highestRiskThreat !== null || player.state().bestWeapon !== null || player.state().heardLava !== null ? "wrong" : "quiet");').start(facts);
	assert.equal(result.summary, 'quiet');
});

test('public projection preserves canonical dense undefined elements without accepting sparse arrays', () => {
	const custom = { player: { health: 20, samples: [undefined] }, world: {}, inventory: { tagCounts: {} } };
	const result = vm('let count = 0; for (const sample of player.state().samples) { if (sample === undefined) count++; } program.finish(count === 1 ? "canonical" : "wrong");').start(custom);
	assert.equal(result.summary, 'canonical');
	assert.equal(createInterpreterFacts({ ...observation(), player: custom.player }).player.samples[0], undefined);
	const holes = new Array(1);
	assert.throws(() => vm('await player.wait(1);').start({ ...custom, player: { health: 20, samples: holes } }));
});
