import assert from 'node:assert/strict';
import test from 'node:test';
import { ArenaScriptInterpreter } from '../src/arena-script/interpreter.mjs';
import { createInterpreterFacts } from '../src/arena-script/facts.mjs';
import { SCRIPT_BINDINGS } from '../src/arena-script/minecraft-api.mjs';
import { parseArenaScript } from '../src/arena-script/parser.mjs';
import { composeContinuityHeader } from '../src/continuity-header.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { normalizeMinecraftToolCall, MINECRAFT_DYNAMIC_TOOLS, NATIVE_AGENT_INSTRUCTIONS } from '../src/native-minecraft-tools.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { ARENA_SCRIPT_API_REFERENCE } from '../src/prompts.mjs';
import { validateAction } from '../src/schema.mjs';
import { StandingOrderBook, MAX_STANDING_SOURCE_BYTES, MAX_STANDING_WHEN_BYTES } from '../src/standing-orders.mjs';
import { standingGuardCoverage } from '../src/standing-templates.mjs';

const install = (parameters = {}, standing = {}) => normalizeMinecraftToolCall('runProgram', { standing: { template: 'survival', ...standing }, parameters });
const target = { x: -2.5, y: 68, z: 4.5 };
const mob = { uuid: '00000000-0000-4000-8000-000000000001', type: 'minecraft:zombie', distance: 2, bearing: 20, targeting: true,
	lineOfSight: true, visible: true, targetable: true, swelling: false, signals: ['targeting'], risk: 2 };
const world = dimension => ({ dimension, gameTime: 0, dayTime: 0, raining: false, thundering: false });
function observation(player = {}, extra = {}) {
	return { ready: true, position: { x: 0.5, y: 64, z: 0.5 }, view: { yaw: 30, pitch: 5 },
		player: { health: 20, foodLevel: 20, inWater: false, underWater: false, onFire: false, inLava: false, air: 300, maxAir: 300, breathable: null, ...player },
		inventory: { selectedSlot: 2, items: [] }, entities: [], blocks: [], world: world('minecraft:overworld'), ...extra };
}
function firstResponse(observed, parameters = {}) {
	const tool = install(parameters);
	const book = new StandingOrderBook();
	book.set('a', tool);
	const order = book.evaluate('a', observed);
	assert.equal(book.list('a')[0].conditionError, undefined);
	assert.ok(order, 'the reported hazard must trigger the installed guard');
	const facts = createInterpreterFacts(adaptObservation(observed));
	const vm = new ArenaScriptInterpreter(parseArenaScript(order.source), SCRIPT_BINDINGS, { parameters: tool.parameters });
	const first = vm.start(facts);
	assert.equal(first.kind, 'command');
	const action = validateAction({ type: first.call.primitive, ...first.call.arguments });
	return { action, first, vm, facts };
}

test('survival template normalizes to one bounded standing guard with optional parameters', () => {
	const tool = install();
	assert.equal(tool.kind, 'standing_order');
	assert.equal(tool.id, 'survival');
	assert.equal(tool.guard, true);
	assert.equal(tool.parameters.escape, null);
	assert.equal(tool.parameters.water, null);
	assert.equal(tool.maxActions, 8);
	assert.equal(tool.timeoutMs, 20_000);
	assert.ok(Buffer.byteLength(tool.source) <= MAX_STANDING_SOURCE_BYTES);
	assert.ok(Buffer.byteLength(tool.when) <= MAX_STANDING_WHEN_BYTES);
	assert.equal(install({}, { id: 'g1' }).id, 'g1');
	assert.equal(new StandingOrderBook().evaluate('a', observation({ inLava: true })), null);
	assert.ok(Buffer.byteLength(NATIVE_AGENT_INSTRUCTIONS) <= 1500);
	// Merged shaft signature: API reference 14,695 -> 14,722 (+27 B), dynamic tools 30,904 -> 30,929 (+25 B).
	// 14,813 -> 14,847: useItem/interactBlock signatures gain acceptLavaRisk? (d41-portal LAVA_POUR_AT_BODY).
	assert.ok(Buffer.byteLength(ARENA_SCRIPT_API_REFERENCE) <= 15_228); // +18: fightTarget/useRanged single? (d41-blaze-survive); +64: fightTarget/useRanged untilItem?/untilCount?, roof? (d41-fight-count); +48: useRanged untilDead?/fleeAtHealth?/collect?, fightTarget collect? (d41-ranged-loop); +15: travelTo fightThrough? (d41-resume); +118: player.fightUntil (d41-fight-until); +118: castObsidian/barterUntil (d41-cast-barter)
	// +36 B: the stage check terms in the taskPlan check description; +11 B: spawn:bed; +282 B: the dig_to action; +1,509 B: the travel_to action.
	// +32 B: acceptLavaRisk on use_item and interact_block (d41-portal).
	assert.ok(Buffer.byteLength(JSON.stringify(MINECRAFT_DYNAMIC_TOOLS)) <= 32_863) // +128 B: d41-blaze-survive single? and the plan-count act sentence; +44 B: d41-ranged-loop use_ranged/fight_target options; +226 B: d41-resume travelTo fightThrough; +153 B: d41-fight-until fight_until; +673 B: d41-cast-barter cast_obsidian/barter_until
});

test('background is ignored for templates, authored guards, legacy orders and deletion', () => {
	for (const args of [
		{ standing: { template: 'survival' } },
		{ standing: { id: 'g', when: 'player.state().fire', guard: true }, source: install().source },
		{ standing: { id: 'g', when: 'true', ttlS: 10 }, source: install().source },
		{ standing: { id: 'g' } },
	]) for (const background of [true, false]) {
		assert.deepEqual(normalizeMinecraftToolCall('runProgram', { ...args, background }), normalizeMinecraftToolCall('runProgram', args));
	}
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { standing: { template: 'survival' }, background: 'yes' }), /background/);
});

test('template branches and thresholds are model choices and invalid overrides are rejected', () => {
	for (const toggle of ['air', 'fire', 'lava', 'projectiles', 'clouds', 'fall', 'threats']) {
		assert.equal(install({ [toggle]: false }).parameters[toggle], false);
		assert.throws(() => install({ [toggle]: 1 }), /must be boolean/);
	}
	for (const parameters of [{ airBelowS: 16 }, { fightAtHealth: -1 }, { healBelow: 21 }, { fallWithin: 9 }, { escape: { x: 0, y: 64 } }, { water: 'near' }, { invented: true }]) {
		assert.throws(() => install(parameters), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	}
	for (const args of [{ parameters: null }, { standing: { template: 'survival', id: null } }, { source: install().source }, { noteKey: 'custom' }, { standing: { template: 'survival', when: 'true' } }, { standing: { template: 'unknown' } },
		{ standing: { template: 'survival', guard: false } }, { standing: { template: 'survival', ttlS: 10 } }]) {
		assert.throws(() => normalizeMinecraftToolCall('runProgram', { standing: { template: 'survival' }, ...args }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	}
	const book = new StandingOrderBook();
	book.set('a', install({ air: false, fire: false, lava: false, clouds: false, projectiles: false, fall: false, threats: false, healBelow: 0 }));
	assert.equal(book.evaluate('a', observation({ underWater: true, air: 0, inLava: true, onFire: true, dropAhead: { at: 0, drop: 16, atLeast: true } }, { threats: { entries: [mob] } })), null);
	book.set('a', install({ airBelowS: 4 }));
	assert.equal(book.evaluate('a', observation({ underWater: true, air: 100 })), null);
	assert.ok(book.evaluate('a', observation({ underWater: true, air: 60 })));
});

test('low air moves to the exact reported breathable target and rises only when no target was reported', () => {
	const move = firstResponse(observation({ underWater: true, air: 60, breathable: target })).action;
	assert.equal(move.type, 'move_to');
	for (const key of ['x', 'y', 'z']) assert.equal(move[key], target[key]);
	const rise = firstResponse(observation({ underWater: true, air: 0 })).action;
	assert.equal(rise.type, 'control');
	assert.equal(rise.jump, true);
	assert.equal(rise.forward, 0);
});

test('F1 breathing reaches air then holds authored jump to refill instead of immediately sinking', () => {
	for (const airHoldTicks of [80, 40, 0]) {
		const { first, vm } = firstResponse(observation({ inWater: true, underWater: true, air: 200, breathable: target }), { airBelowS: 11, airHoldTicks });
		const surfaced = createInterpreterFacts(adaptObservation(observation({ inWater: true, underWater: false, air: 200 })));
		const hold = vm.resume({ stateToken: first.stateToken, state: 'SUCCEEDED', reasonCode: 'DESTINATION_REACHED' }, surfaced);
		if (airHoldTicks === 0) { assert.equal(hold.kind, 'idle'); continue; }
		assert.equal(hold.kind, 'command');
		const action = validateAction({ type: hold.call.primitive, ...hold.call.arguments });
		assert.equal(action.type, 'control');
		assert.equal(action.ticks, Math.floor(airHoldTicks));
		assert.equal(action.jump, true);
		assert.equal(action.forward, 0);
		assert.equal(action.strafe, 0);
		assert.equal(action.sneak, false);
		assert.equal(vm.resume({ stateToken: hold.stateToken, state: 'SUCCEEDED', reasonCode: 'CONTROL_SEGMENT_COMPLETED' }, surfaced).kind, 'idle', 'no onward travel is invented');
	}
	assert.equal(install().parameters.airHoldTicks, 80);
	for (const airHoldTicks of [-1, 201, 0.5]) assert.throws(() => install({ airHoldTicks }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
});

test('breathing hold is skipped on a failed route or a dry arrival', () => {
	for (const state of ['FAILED', 'SUCCEEDED']) {
		const { first, vm } = firstResponse(observation({ inWater: true, underWater: true, air: 60, breathable: target }));
		const dry = createInterpreterFacts(adaptObservation(observation()));
		assert.equal(vm.resume({ stateToken: first.stateToken, state, reasonCode: state === 'FAILED' ? 'NO_STANDABLE_PATH' : 'DESTINATION_REACHED' }, dry).kind, 'idle');
	}
});

test('fire and lava use only reported safe exits, skipping lava routes, gaps and unseen landings', () => {
	for (const hazard of [{ onFire: true }, { inLava: true }]) {
		const action = firstResponse(observation({ ...hazard, harm: { exits: [
			'left 2.0m 1lava (2,64,0)', 'right 2.0m 1gap (3,64,0)', 'back 2.0m unseen (4,64,0)',
			'front 2.0m up3 landing (5,67,0)', 'left 2.0m (-2,64,0)',
		] } })).action;
		assert.equal(action.type, 'move_to');
		assert.deepEqual({ x: action.x, y: action.y, z: action.z }, { x: -1.5, y: 64, z: 0.5 });
	}
	const rise = firstResponse(observation({ inLava: true })).action;
	assert.equal(rise.jump, true);
	assert.equal(rise.forward, 0, 'no invented route through unknown lava');
});

test('water destinations are ignored in Nether and used only in reported water-compatible dimensions', () => {
	for (const dimension of ['minecraft:overworld', 'minecraft:the_end', 'minecraft:the_nether']) {
		const escape = { x: 8.5, y: 64, z: 0.5 };
		const action = firstResponse(observation({ inLava: true }, { world: world(dimension) }), { water: target, escape }).action;
		const expected = dimension === 'minecraft:the_nether' ? escape : target;
		for (const key of ['x', 'y', 'z']) assert.equal(action[key], expected[key]);
	}
});

test('incoming projectiles use the observed bearing to dodge or a carried shield', () => {
	for (const bearing of [-40, 40]) {
		const dodge = firstResponse(observation({}, { incomingProjectiles: [{ bearing, damaging: true, shieldBlockable: false, etaSeconds: 1.39 }] })).action;
		assert.equal(dodge.type, 'control');
		assert.equal(dodge.strafe, bearing >= 0 ? 1 : -1);
		assert.equal(dodge.yaw, 30);
	}
	const { first, vm, facts, action } = firstResponse(observation({}, { incomingProjectiles: [{ bearing: 0, damaging: true, shieldBlockable: true, etaSeconds: 1.39 }],
		inventory: { selectedSlot: 2, items: [{ slot: 3, itemId: 'minecraft:shield', count: 1 }] } }));
	assert.equal(action.type, 'block_with_shield');
	assert.equal(action.durationMs, 1700);
	const fallback = vm.resume({ stateToken: first.stateToken, state: 'FAILED', reasonCode: 'SHIELD_NOT_EQUIPPED' }, facts);
	assert.equal(fallback.call.primitive, 'control');
});

test('harmful cloud contact or entry uses its reported exit with a bounded fallback when absent', () => {
	for (const exposure of [{ contact: true }, { entering: true }]) {
		const action = firstResponse(observation({ clouds: [{ harmful: true, ...exposure, exitRoute: "walkable", nearestExit: { x: -3, y: 64, z: 2 } }] })).action;
		assert.equal(action.type, 'move_to');
		assert.deepEqual({ x: action.x, y: action.y, z: action.z }, { x: -2.5, y: 64, z: 2.5 });
	}
	const action = firstResponse(observation({ clouds: [{ harmful: true, contact: true }] }), { escape: target }).action;
	assert.equal(action.type, 'move_to');
	assert.equal(action.x, target.x);
	const book = new StandingOrderBook(); book.set('a', install());
	for (const cloud of [{ harmful: true, contact: false, entering: false }, { arming: true, contact: true }, { harmful: false, contact: true }]) {
		assert.equal(book.evaluate('a', observation({ clouds: [cloud] })), null);
	}
});

test('fall and void edges stop and crouch before projectile or threat movement', () => {
	for (const dropAhead of [{ at: 3, drop: 6 }, { at: 0, drop: 16, atLeast: true }]) {
		const action = firstResponse(observation({ dropAhead }, { incomingProjectiles: [{ damaging: true, bearing: 30 }], threats: { entries: [mob] } })).action;
		assert.equal(action.type, 'control');
		assert.equal(action.sneak, true);
		assert.equal(action.forward, 0);
		assert.equal(action.strafe, 0);
	}
	const book = new StandingOrderBook(); book.set('a', install({ fallWithin: 1 }));
	assert.equal(book.evaluate('a', observation({ dropAhead: { at: 3, drop: 16, atLeast: true } })), null);
});

test('visible hostiles fight when healthy and close; creepers and low health use a reported safe exit', () => {
	for (const [enemy, health, expected] of [[mob, 20, 'fight_target'], [{ ...mob, type: 'minecraft:creeper' }, 20, 'move_to'], [mob, 5, 'move_to']]) {
		const action = firstResponse(observation({ health, exits: [{ ...target, safe: true }] }, { threats: { entries: [enemy] } })).action;
		assert.equal(action.type, expected);
		if (expected === 'fight_target') assert.equal(action.targetId, enemy.uuid);
		else for (const key of ['x', 'y', 'z']) assert.equal(action[key], target[key] + (key === 'y' ? 0 : 0.5));
	}
});

test('survival engagement is strictly above its own bailout threshold, including custom thresholds', () => {
	for (const fightAtHealth of [6, 10, 14]) {
		for (const health of [fightAtHealth - 0.1, fightAtHealth, fightAtHealth + 0.1]) {
			const observed = observation({ health }, { threats: { entries: [mob] } });
			const parameters = { fightAtHealth, healBelow: 0 };
			const book = new StandingOrderBook(); book.set('a', install(parameters));
			assert.equal(book.evaluate('a', observed) !== null, health > fightAtHealth);
			assert.equal(book.list('a')[0].feedback.threats[0].response,
				health > fightAtHealth ? 'fight_then_escape_if_available' : 'skipped_no_supported_escape');
			// With a model-chosen escape, equality follows the existing escape branch without a zero-hit fight first.
			const { action } = firstResponse(observed, { ...parameters, escape: target });
			assert.equal(action.type, health > fightAtHealth ? 'fight_target' : 'move_to');
			if (action.type === 'fight_target') assert.equal(action.fleeAtHealth, fightAtHealth);
			else assert.equal(action.x, target.x);
		}
	}
});

test('coverage checks both trigger and response plus disabled branches, and follows edits and deletion', () => {
	const tool = install();
	const full = 'survival covers air,fire,lava,projectile,cloud,fall,threat';
	assert.equal(standingGuardCoverage(tool), full);
	assert.equal(standingGuardCoverage({ ...tool, id: 'g1', when: 'player.state().threat !== null' }), 'g1 missing: air,fire,lava,projectile,cloud,fall');
	assert.equal(standingGuardCoverage({ ...tool, source: 'await player.fleeFrom({targetId:player.state().threat.uuid});' }), 'survival missing: air,fire,lava,projectile,cloud,fall');
	assert.equal(standingGuardCoverage(install({ air: false, fall: false })), 'survival missing: air,fall');
	const book = new StandingOrderBook(); book.set('a', tool);
	assert.equal(book.guardCoverage('a'), 'survival: installed, condition unchecked, fired 0x');
	book.set('a', install({ fall: false }));
	assert.equal(book.guardCoverage('a'), 'survival: installed, condition unchecked, fired 0x');
	book.delete('a', 'survival');
	assert.equal(book.guardCoverage('a'), null);
	assert.deepEqual(composeContinuityHeader({ goal: 'g', guardInstalled: true, guardCoverage: full }), { guard: full });
	const views = new LiveTaskViews();
	assert.equal(views.continuity({ agentId: 'a', currentGoal: 'g', goalRevision: 1 }, { guardInstalled: true, guardCoverage: full }).guard, full);
	const encoded = new ModelObservationViews();
	const event = { now: { guard: full }, observation: { ready: true, world: { worldId: 'w', dimension: 'minecraft:overworld' } } };
	encoded.retainEventMetadata(event);
	assert.equal(encoded.retainEventMetadata(event).now.guard, full);
});

test('derived exit facts reject nested accessors before reading them and invent no missing destination', () => {
	let reads = 0;
	const exit = Object.defineProperty({}, 'x', { enumerable: true, get() { reads++; return 5; } });
	assert.throws(() => createInterpreterFacts({ player: { clouds: [{ contact: true, harmful: true, nearestExit: exit }] } }), TypeError);
	assert.throws(() => createInterpreterFacts({ player: { harm: { exits: [exit] } } }), TypeError);
	assert.equal(reads, 0);
	const facts = createInterpreterFacts({ player: {} });
	assert.deepEqual([...facts.player.exitCells], []);
	assert.equal(facts.player.cloudExit, null);
});

test('H1 retained ETA and uncertain cloud exit never become shield protection or a trusted route', () => {
	const observed = observation({}, { incomingProjectiles: [{ type: 'minecraft:dragon_fireball', bearing: 0, damaging: true, shieldBlockable: false, etaSeconds: 1.39 }],
		inventory: { selectedSlot: 2, items: [{ slot: 'offhand', itemId: 'minecraft:shield', count: 1 }] } });
	assert.equal(firstResponse(observed).action.type, 'control');
	const cloud = { source: 'dragon_breath', harmful: true, contact: true, nearestExit: { x: 57, y: 58, z: -2 }, exitRoute: 'unverified' };
	assert.equal(firstResponse(observation({ clouds: [cloud] }), { escape: target }).action.x, target.x);
	const facts = createInterpreterFacts(adaptObservation(observation({ clouds: [cloud] })));
	assert.equal(facts.player.cloudExit.route, 'unverified');
	const vm = new ArenaScriptInterpreter(parseArenaScript(install().source), SCRIPT_BINDINGS, { parameters: install().parameters });
	assert.equal(vm.start(facts).kind, 'checkpoint');
});
test('small dry edges do not trigger fall guard; shallow lava does and depth is model-tunable', () => {
	for (const drop of [1, 2, 3]) {
		const book = new StandingOrderBook(); book.set('a', install());
		assert.equal(book.evaluate('a', observation({ dropAhead: { at: 1, drop } })), null);
	}
	assert.equal(firstResponse(observation({ dropAhead: { at: 1, drop: 1, into: 'lava' } })).action.sneak, true);
	assert.equal(firstResponse(observation({ dropAhead: { at: 1, drop: 2 } }), { fallDepth: 2 }).action.sneak, true);
});


test('survival skips latched, heard-only, untargetable and unsupported threats without interrupting work', () => {
	for (const enemy of [
		{ ...mob, visible: false, targetable: false },
		{ ...mob, visible: false, targetable: true },
		{ ...mob, visible: true, targetable: false },
		{ ...mob, type: 'minecraft:creeper' },
		{ ...mob, distance: 8 },
	]) {
		const book = new StandingOrderBook(); book.set('a', install());
		assert.equal(book.evaluate('a', observation({}, { threats: { entries: [enemy] } })), null);
		const report = book.list('a')[0].feedback.threats[0];
		assert.equal(report.uuid, enemy.uuid);
		assert.equal(report.visible, enemy.visible);
		assert.equal(report.targetable, enemy.targetable);
		assert.equal(report.reachable, null, 'visibility never proves a route');
		assert.match(report.response, /^skipped_/);
		assert.match(book.feedback('a'), /skipped_/);
	}
});

test('threat escape prefers a reported safe cell over model escape and skips unsafe exits', () => {
	const enemy = { ...mob, type: 'minecraft:creeper' };
	const safe = firstResponse(observation({ exits: ['E clear (4,64,2)'] }, { threats: { entries: [enemy] } }), { escape: target }).action;
	assert.equal(safe.type, 'move_to'); assert.equal(safe.x, 4.5); assert.equal(safe.z, 2.5);
	const authored = firstResponse(observation({ exits: ['E 2lava (4,64,2)'] }, { threats: { entries: [enemy] } }), { escape: target }).action;
	assert.equal(authored.type, 'move_to'); assert.equal(authored.x, target.x);
	const book = new StandingOrderBook(); book.set('a', install());
	assert.equal(book.evaluate('a', observation({ exits: ['E 2lava (4,64,2)'] }, { threats: { entries: [enemy] } })), null);
});
