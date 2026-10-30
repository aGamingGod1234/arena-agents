import assert from 'node:assert/strict';
import test from 'node:test';
import { DEATH } from './fixtures/dynamic-main-fixture.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { visiblePlayer } from '../src/player-visible-facts.mjs';
import { buildNativeEventInput, nativeObservationSignature, routinePerceptionChange, classifyObservationTrigger } from '../src/dynamic-main.mjs';
import { createInterpreterFacts } from '../src/arena-script/facts.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { normalizeInspectionQuery, validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, normalizeMinecraftToolCall, toolResultContent } from '../src/native-minecraft-tools.mjs';

const observation = () => ({
	player: { x: 1.123456789, y: 64, z: 0, health: 17.2, maxHealth: 20, absorption: 3.1,
		foodLevel: 18, saturation: 1.234, air: 135, maxAir: 300, airSecondsLeft: 6.75, onFire: true, fireTicks: 199, skyOpen: false,
		effects: [{ effectId: 'minecraft:speed', amplifier: 0, duration: 199 }] },
	entities: [{ type: 'minecraft:zombie', health: 7.32, maxHealth: 20, stableId: 'mob', x: 2, y: 64, z: 0 }],
	inventory: { selectedItem: 'minecraft:iron_pickaxe', selectedSlot: 2, items: [] },
	world: { dimension: 'minecraft:overworld', gameTime: 1234, dayTime: 13000, raining: true, thundering: true, biome: 'minecraft:plains', naturalRegeneration: false },
});
const delivered = value => decodeModelFacts(JSON.parse(value.response.contentItems[0].text));
const publicWorlds = source => [
	(() => { const wake = JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }).split('\n')[1]); return { ...wake.observation.world, dayPhase: wake.hud?.sky }; })(),
	delivered(presentNativeToolResult({ observation: source }, { kind: 'observe' })).observation.world,
	JSON.parse(toolResultContent({ observation: source }).contentItems[0].text).observation.world,
	createInterpreterFacts(source).world.state,
];

test('visible weather and sunset never promise minutes of safety before surface spawning', () => {
	for (const dayTime of [11_000, 11_770, 12_980]) {
		for (const [raining, thundering] of [[false, false], [true, false], [true, true]]) {
			const source = observation();
			source.player.skyOpen = true;
			Object.assign(source.world, { dayTime, raining, thundering });
			for (const world of publicWorlds(source)) {
				assert.equal(world.dayPhase, 'sunset');
				assert.equal(world.raining, raining);
				assert.equal(world.thundering, thundering);
				assert.equal(world.darkIn, 'unknown', 'sunset gives no elapsed-time guarantee or safe spawning window');
			}
		}
	}
});

test('reduced debug preserves visible sunset uncertainty without exposing a countdown', () => {
	for (const [raining, thundering] of [[false, false], [true, false], [true, true]]) {
		const source = observation();
		source.player.skyOpen = true;
		Object.assign(source.world, { dayTime: 11_770, raining, thundering, reducedDebugInfo: true, darkIn: '~2 min' });
		for (const world of publicWorlds(source)) {
			assert.equal(world.dayPhase, 'sunset');
			assert.equal(world.darkIn, 'unknown');
			assert.equal(world.biome, undefined);
		}
	}
});

test('a clock under cover cannot distinguish outside weather or revive a stale sky forecast', () => {
	for (const hasClock of [false, true]) {
		const outputs = [];
		for (const [raining, thundering] of [[false, false], [true, false], [true, true]]) {
			const source = observation();
			Object.assign(source.world, { dayTime: 11_770, raining, thundering, darkIn: '~2 min' });
			source.inventory.items = hasClock ? [{ slot: 35, itemId: 'minecraft:clock', count: 1 }] : [];
			const worlds = publicWorlds(source);
			for (const world of worlds) {
				assert.equal(world.dayPhase, hasClock ? 'sunset' : undefined);
				assert.equal(world.raining, undefined);
				assert.equal(world.thundering, undefined);
				assert.equal(world.darkIn, undefined);
			}
			outputs.push(worlds);
		}
		assert.deepEqual(outputs[0], outputs[1], 'rain is hidden under cover even with a clock');
		assert.deepEqual(outputs[0], outputs[2], 'thunder is hidden under cover even with a clock');
	}
});

test('neither a carried clock nor open sky supplies an Overworld phase in skyless dimensions', () => {
	for (const dimension of ['minecraft:the_nether', 'minecraft:the_end']) {
		for (const skyOpen of [false, true]) {
			for (const hasClock of [false, true]) {
				const source = observation();
				source.player.skyOpen = skyOpen;
				Object.assign(source.world, { dimension, dayTime: 11_770, darkIn: '~2 min' });
				source.inventory.items = hasClock ? [{ slot: 35, itemId: 'minecraft:clock', count: 1 }] : [];
				for (const world of publicWorlds(source)) {
					assert.equal(world.dayPhase, undefined);
					assert.equal(world.darkIn, undefined);
				}
			}
		}
	}
});

test('visible sky phases survive every public boundary without revealing the clock under cover', () => {
	for (const [dayTime, phase] of [[0, 'day'], [11000, 'sunset'], [14000, 'night'], [23000, 'sunrise'], [38000, 'night']]) {
		const source = observation();
		source.player.skyOpen = true;
		source.world.dayTime = dayTime;
		const wake = JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }).split('\n')[1]);
		const facts = createInterpreterFacts(source);
		// A sunset or night sky leads the wake in hud instead of repeating in its world facts.
		assert.equal(wake.observation.world.dayPhase ?? wake.hud?.sky, phase);
		assert.equal(wake.observation.world.dayTime, undefined);
		for (const world of [delivered(presentNativeToolResult({ observation: source }, { kind: 'observe' })).observation.world,
			JSON.parse(toolResultContent({ observation: source }).contentItems[0].text).observation.world, facts.world.state]) {
			assert.equal(world.dayPhase, phase);
			assert.equal(world.dayTime, undefined);
			assert.equal(world.darkIn, phase === 'sunset' ? 'unknown' : undefined);
		}
		assert.doesNotMatch(wake.situation, /day|sunset|night|sunrise/);
	}
	for (const [skyOpen, dimension] of [[false, 'minecraft:overworld'], [true, 'minecraft:the_nether'], [true, 'minecraft:the_end']]) {
		const source = observation();
		source.player.skyOpen = skyOpen;
		source.world.dimension = dimension;
		assert.equal(delivered(presentNativeToolResult({ observation: source }, { kind: 'observe' })).observation.world.dayPhase, undefined);
		assert.equal(createInterpreterFacts(source).world.state.dayPhase, undefined);
	}
});

test('the hidden full-air HUD row adds no wake bytes while diving and refilling remain visible', () => {
	for (const [underWater, air, expected] of [[false, 300, undefined], [true, 300, 10], [false, 270, 9]]) {
		const source = observation();
		Object.assign(source.player, { underWater, air });
		const wake = JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }).split('\n')[1]);
		// Water state and the visible bar keep the same section while diving and refilling.
		assert.equal(wake.observation.player.airBubbles, undefined);
		assert.equal(wake.hud.air, expected === undefined ? 'above water' : `${underWater ? 'underwater' : 'above water'} ${expected}/10 bubbles`);
		assert.equal(wake.hud?.air?.match(/underwater (\d+)\/10 bubbles/)?.[1], underWater ? String(expected) : undefined);
		assert.equal(delivered(presentNativeToolResult({ observation: source }, { kind: 'observe' })).observation.player.airBubbles, expected);
		const facts = createInterpreterFacts(source);
		assert.equal(facts.player.airBubbles, expected);
		assert.equal(facts.player.air, expected === undefined ? 300 : expected * 30, 'legacy guards keep the computable coarse full-air value');
	}
});

test('a carried vanilla clock makes the coarse phase known under cover but never in another dimension', () => {
	const source = observation();
	source.world.dayTime = 14000;
	source.inventory.items = [{ slot: 35, itemId: 'minecraft:clock', count: 1 }];
	const wake = JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }).split('\n')[1]);
	assert.equal(wake.observation.world.dayPhase, undefined);
	assert.equal(wake.hud.sky, 'night');
	assert.equal(delivered(presentNativeToolResult({ observation: source }, { kind: 'observe' })).observation.world.dayPhase, 'night');
	assert.equal(createInterpreterFacts(source).world.state.dayPhase, 'night');
	source.world.dimension = 'minecraft:the_nether';
	assert.equal(createInterpreterFacts(source).world.state.dayPhase, undefined, 'a vanilla clock spins outside the overworld');
});

test('moving sunset to the HUD preserves the routine-safety darkIn fact', () => {
	const source = observation();
	source.player.skyOpen = true;
	source.world.dayTime = 11000;
	source.world.darkIn = '~2 min';
	const wake = JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }).split('\n')[1]);
	assert.equal(wake.hud.sky, 'sunset');
	assert.equal(wake.observation.world.dayPhase, undefined);
	assert.equal(wake.observation.world.darkIn, 'unknown');
	assert.equal(source.world.darkIn, '~2 min');
});

test('addressed player chat and advancement toasts ride another wake without becoming attention', () => {
	const payload = { attention: true, changedFacts: ['perception'] };
	for (const type of ['player_chat', 'advancement_toast']) {
		const events = [{ type, sequence: 4, text: 'Visible text' }];
		const wire = { perception: { events, latestSequence: 4 } };
		assert.equal(routinePerceptionChange(payload, wire, 3), true);
		assert.equal(classifyObservationTrigger({ ...payload, attention: false, changedFacts: [] }, { player: {} }).attention, false);
		assert.equal(routinePerceptionChange(payload, { perception: { events: [...events, { type: 'system_message', sequence: 5, text: 'Whisper' }] } }, 3), false);
		assert.equal(routinePerceptionChange({ ...payload, changedFacts: ['perception', 'player.health'] }, wire, 3), false);
	}
});

test('absolute action and teleport ticks stay runtime-only while the perceived reposition remains available', () => {
	const raw = { observation: { ...observation(), player: { ...observation().player, teleportTick: 12000 } },
		actionObservation: { worldTick: 12020, teleportTick: 12000, position: { x: 1, y: 64, z: 0 } } };
	for (const result of [delivered(presentNativeToolResult(raw, { kind: 'observe' })), JSON.parse(toolResultContent(raw).contentItems[0].text)]) {
		assert.equal(result.observation.player.teleportTick, undefined);
		assert.equal(result.observation.player.repositionedRecently, true);
		assert.equal(result.actionObservation.worldTick, undefined);
		assert.equal(result.actionObservation.teleportTick, undefined);
		assert.equal(result.actionObservation.repositionedRecently, true);
		assert.deepEqual(result.actionObservation.position, { x: 1, y: 64, z: 0 });
	}
	assert.equal(raw.observation.player.teleportTick, 12000);
	assert.equal(raw.actionObservation.worldTick, 12020);
});

test('HUD inspection passes the native and wire request contracts and advertises the fact families', () => {
	assert.equal(normalizeMinecraftToolCall('inspect', { section: 'hud' }).section, 'hud');
	assert.deepEqual(normalizeInspectionQuery({ section: 'hud' }), { section: 'hud', offset: 0, limit: 16 });
	assert.throws(() => normalizeInspectionQuery({ section: 'hud', slot: 1 }));
	assert.match(MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === 'inspect').description, /hud:.*XP.*F3 light/);
});

test('both provider presentation and bounded fallback expose HUD cues without hidden counters', () => {
	const source = observation(), before = structuredClone(source);
	const value = { observation: source, postAction: { observation: source }, healing: { saturation: 1.234, regenHPPerSecondMax: 0.412, naturalRegen: true, foodLevel: 18, burn: { seconds: 10, rawDamage: 9 } } };
	for (const result of [delivered(presentNativeToolResult(value, { kind: 'observe' })), JSON.parse(toolResultContent(value).contentItems[0].text)]) {
		for (const facts of [result.observation, result.postAction.observation]) {
			assert.equal(facts.entities[0].health, undefined);
			assert.equal(facts.player.saturation, undefined);
			assert.equal(facts.player.hungerShaking, false);
			assert.equal(facts.player.fireTicks, undefined);
			assert.equal(facts.player.airBubbles, 5);
			assert.equal(facts.player.airSecondsLeft, undefined);
			assert.equal(facts.world.naturalRegeneration, undefined);
			assert.equal(facts.player.health, 18);
			assert.equal(facts.player.absorption, 4);
			assert.equal(facts.player.x, 1.123);
			assert.deepEqual(facts.player.effects[0], Array.isArray(facts.player.effects[0])
				? ['minecraft:speed', 0, 9] : { effectId: 'minecraft:speed', amplifier: 0, seconds: 9 });
			assert.equal(facts.world.dayTime, undefined);
			assert.equal(facts.world.raining, undefined);
		}
		assert.deepEqual(result.healing, { foodLevel: 18, regenFoodReady: true, burn: { remaining: 'not_observed' } });
	}
	assert.deepEqual(source, before, 'program samples keep their original facts');
});

test('HUD facts survive model deltas and reduced debug info hides the debug view', () => {
	const views = new ModelObservationViews(), source = observation();
	const first = presentNativeToolResult({ observation: source }, { kind: 'observe' }, views);
	first.commit();
	const full = delivered(first);
	const changed = observation();
	changed.player.absorption = 0;
	changed.world.reducedDebugInfo = true;
	const next = delivered(presentNativeToolResult({ observation: changed }, { kind: 'observe', view: 'changes', afterObservationId: full.observationView.id }, views));
	assert.equal(next.observation.player.absorption, 0);
	assert.equal(next.observation.player.x, undefined);
	assert.equal(next.observation.world.biome, undefined);
});

test('wakes use the same visible vitals and retain selected slot and death screen', () => {
	const value = observation();
	value.player.recentDamage = { cause: 'fire', direction: 'left', secondsAgo: 0 };
	const result = JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: value }).split('\n')[1]);
	assert.equal(result.observation.inventory.selectedSlot, 2);
	assert.equal(result.observation.player.saturation, undefined);
	assert.equal(result.hud.recentDamage.direction, 'left');
	assert.doesNotMatch(result.situation, /night/);
	const death = validateProtocolV2Payload('observation', { ready: false, status: 'PLAYER_DEAD', goalRevision: 1, observedAtEpochMs: 1, deathScreen: { message: 'Player fell from a high place', score: 42 } });
	assert.equal(adaptObservation(death).deathScreen.score, 42);
});


test('recent damage age alone never creates a new decision wake', () => {
	const source = observation();
	source.player.recentDamage = { cause: 'fire', direction: 'left', secondsAgo: 0 };
	const later = structuredClone(source);
	later.player.recentDamage.secondsAgo = 1;
	assert.equal(nativeObservationSignature(source), nativeObservationSignature(later));
});


test('harm is shared by runtime and all model outputs without duplicate hazard state', () => {
	const wire = { ready: true, position: { x: 0, y: 64, z: 0 }, view: { yaw: 0, pitch: 0 }, player: {
		health: 10, maxHealth: 20, foodLevel: 18, saturation: 0, harm: { source: 'minecraft:on_fire', hpLossPerSecond: 2.3, exits: [] },
		hazard: 'fire', fireTicks: 100, hurtBy: 'on_fire', exits: [], recentDamage: { cause: 'minecraft:on_fire', secondsAgo: 0 } },
		inventory: { items: [] }, entities: [], blocks: [] };
	const runtime = adaptObservation(wire);
	assert.equal(runtime.player.harm.hpLossPerSecond, 2.3);
	const model = delivered(presentNativeToolResult({ observation: runtime }, { kind: 'observe' })).observation.player;
	assert.deepEqual(model.harm, runtime.player.harm);
	for (const field of ['hazard', 'fireTicks', 'hurtBy', 'exits', 'recentDamage']) assert.equal(model[field], undefined);
	assert.equal(runtime.player.hazard, 'fire', 'programs keep existing facts for compatibility');
	runtime.player.recentDamage = { cause: 'minecraft:arrow', direction: 'right', secondsAgo: 0 };
	const changed = delivered(presentNativeToolResult({ observation: runtime }, { kind: 'observe' })).observation.player;
	assert.equal(changed.recentDamage.cause, 'minecraft:arrow', 'a distinct recent hit remains known while another source is ongoing');
});


test('death score crosses goal control while old snapshots remain compatible', () => {
	const payload = { operation: 'dead', goalRevision: 1, updatedAtEpochMs: 3, death: { ...DEATH, score: 42 } };
	assert.equal(validateProtocolV2Payload('goal_control', payload).death.score, 42);
	assert.equal(validateProtocolV2Payload('goal_control', { ...payload, death: DEATH }).death.score, undefined);
});


test('perceived harm before any hit presents normally with an unknown loss rate', () => {
	const source = observation();
	source.player.harm = { source: 'minecraft:starve', options: ['food'], exits: [] };
	const model = delivered(presentNativeToolResult({ observation: source }, { kind: 'observe' })).observation.player;
	assert.equal(model.harm.source, 'minecraft:starve');
	assert.equal(model.harm.hpLossPerSecond, undefined);
	const wake = JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }).split('\n')[1]);
	assert.equal(wake.hud.harm.source, 'minecraft:starve');
});

test('an open screen ID leads the wake once and tool results retain the menu action fields', () => {
	const menu = { type: 'minecraft:generic_9x3', containerId: 4, stateId: 1, slots: [], capabilities: ['menu_click', 'menu_close'] };
	const wakeOf = (patch) => {
		const source = observation();
		Object.assign(source.player, { onFire: false, fireTicks: 0, health: 20, ...patch });
		source.interaction = { menu };
		return JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }).split('\n')[1]);
	};
	const calm = wakeOf({});
	assert.equal(calm.hud.menuId, 'minecraft:generic_9x3');
	assert.equal(calm.observation.interaction.menu.menuId, undefined);
	assert.equal(calm.observation.interaction.menu.type, undefined);
	assert.equal(wakeOf({ underWater: true, air: 140 }).hud.air, 'underwater 5/10 bubbles');
	assert.equal(wakeOf({ onFire: true, fireTicks: 100 }).hud.onFire, true);
	assert.equal(wakeOf({ health: 3.2 }).hud.health, '4/20');
	assert.equal(wakeOf({ inLava: true, hazard: 'lava' }).hud.inLava, true);
	const inventory = { type: 'minecraft:inventory', containerId: 0, stateId: 3 };
	const source = observation();
	source.interaction = { menu: inventory };
	assert.deepEqual(JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }).split('\n')[1]).observation.interaction.menu, inventory, 'the always-present inventory menu keeps its shape');
	const observed = delivered(presentNativeToolResult({ observation: { ...observation(), interaction: { menu } } }, { kind: 'observe' }));
	assert.equal(observed.observation.interaction.menu.menuId, 'minecraft:generic_9x3');
});


test('HUD promotion preserves every danger fact once, including on planning wakes', () => {
	for (const event of ['observation', 'program_planning_due']) {
		const source = observation();
		Object.assign(source.player, { underWater: true, air: 0, health: 3.2, skyOpen: true });
		source.world.dayTime = 11000;
		source.world.darkIn = '~2 min';
		source.interaction = { menu: { type: 'minecraft:furnace', containerId: 4, stateId: 7, slots: [] } };
		const before = structuredClone(source);
		const wake = JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { event, observation: source }).split('\n')[1]);
		assert.deepEqual(wake.hud, { onFire: true, health: '4/20', air: 'underwater 0/10 bubbles', airSecondsLeft: 0, foodLevel: 18, hungerShaking: false, sky: 'sunset', menuId: 'minecraft:furnace' });
		for (const key of ['airBubbles', 'underWater', 'health', 'maxHealth']) assert.equal(wake.observation.player[key], undefined);
		assert.deepEqual(wake.observation.interaction.menu, { containerId: 4, stateId: 7, slots: [] });
		assert.equal(wake.observation.world.darkIn, 'unknown');
		assert.equal(wake.mode, undefined, 'the active goal already supplies task ownership');
		assert.deepEqual(source, before, 'runtime observations remain unmodified');
	}
});

test('HUD deltas retain only unchanged cues and clear them on recovery or a world reset', () => {
	const views = new ModelObservationViews();
	const source = observation();
	source.world.worldId = 'hud-world';
	Object.assign(source.player, { underWater: true, air: 0, health: 4, skyOpen: true });
	const encode = () => decodeModelFacts(JSON.parse(encodeNativeEventInput(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }), views).split('\n')[1]));
	const first = encode();
	assert.equal(first.observation.air, 'underwater 0/10 bubbles');
	assert.equal(first.observation.health, '4/20');
	const repeated = encode();
	assert.deepEqual(repeated.observationView.replace, {});
	source.player.air = 30;
	assert.equal(encode().observationView.replace.air, 'underwater 1/10 bubbles');
	Object.assign(source.player, { underWater: false, air: 300, health: 20, onFire: false });
	source.world.dayTime = 0;
	const recovered = encode();
	assert.equal(recovered.hud, undefined);
	assert.ok(!recovered.sameAsPreviousEvent?.includes('hud'));
	assert.equal(recovered.observationView.replace.health, '20/20');
	assert.equal(recovered.observationView.replace.air, 'above water');
	assert.equal(recovered.observationView.replace.sky, 'day');
	assert.deepEqual(recovered.observationView.remove, ['airSecondsLeft']);
	source.player.underWater = true;
	source.world.worldId = 'another-world';
	assert.equal(encode().observation.air, 'underwater 10/10 bubbles');
});

const dangerRepro = variant => ({
 observedAtEpochMs: 1000,
 player: { x: 0, y: 64, z: 0, health: variant === 'sky-only' ? 4 : 20, maxHealth: 20, foodLevel: 18, underWater: true, air: 140, maxAir: 300, skyOpen: true },
 world: { worldId: 'repro-world', dimension: 'minecraft:overworld', dayTime: variant === 'sky-only' ? 10999 : 14000 },
 inventory: { items: [] }, entities: [], blocks: [],
 interaction: { menu: { type: 'minecraft:generic_9x3', containerId: 4, stateId: 1, slots: [], capabilities: ['menu_click', 'menu_close'] } },
});

test('changing air while moving and crossing sunset keep stable HUD sections out of same-session wakes', () => {
 for (const [variant, baseBytes] of [['air-moving', 676], ['sky-only', 750]]) {
  const source = dangerRepro(variant), views = new ModelObservationViews();
  const encode = sequence => encodeNativeEventInput(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { event: 'observation', trigger: 'observation', eventSequence: sequence, observation: source }), views);
  encode(1);
  source.observedAtEpochMs += variant === 'air-moving' ? 1500 : 50;
  if (variant === 'air-moving') { source.player.x += 0.125; source.player.air = 110; source.world.dayTime += 30; }
  else source.world.dayTime = 11000;
  const input = encode(2), payload = decodeModelFacts(JSON.parse(input.split('\n')[1]));
  const replace = payload.observationView.replace;
  assert.equal(replace.health, undefined);
  assert.equal(replace.menuId, undefined);
  assert.deepEqual(payload.observationView.remove, []);
  if (variant === 'air-moving') {
   assert.equal(replace.air, 'underwater 4/10 bubbles');
   assert.equal(replace.sky, undefined);
  } else {
   assert.equal(replace.sky, 'sunset');
   assert.equal(replace.air, undefined);
  }
  assert.ok(Buffer.byteLength(input) <= baseBytes, `${variant}: ${Buffer.byteLength(input)} > base ${baseBytes}`);
 }
});

test('stationary and closing threats lead menu and work facts without inventing movement or timing', () => {
 for (const type of ['minecraft:zombie', 'minecraft:creeper', 'minecraft:drowned']) {
  for (const event of ['observation', 'program_planning_due']) {
   const source = dangerRepro('air-moving');
   source.player.threats = [{ uuid: 'contact-mob', type, distance: 2.2, bearing: 90, targeting: true, swelling: type === 'minecraft:creeper', lineOfSight: true, signals: ['imminent', 'targeting', ...(type === 'minecraft:creeper' ? ['swelling'] : [])], approaching: false, closingSpeed: 0 }];
   source.player.lastAttacker = { type, distance: 2.2 };
   const before = structuredClone(source), views = new ModelObservationViews();
   const render = () => {
    const raw = buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { event, observation: source });
    return decodeModelFacts(JSON.parse(encodeNativeEventInput(raw, views).split('\n')[1]));
   };
   const fresh = render(), text = JSON.stringify(fresh), threat = fresh.observation.threats[0];
   assert.equal(threat.type, type);
   assert.equal(threat.distance, 2.2);
   assert.equal(threat.approaching, false);
   assert.equal(threat.etaSeconds, undefined);
   if (type === 'minecraft:creeper') assert.ok(threat.signals.includes('swelling'));
   assert.ok(text.indexOf('"threats"') < text.indexOf('"menuId"'));
   assert.ok(text.indexOf('"threats"') < text.indexOf('"goal"'));
   assert.equal(fresh.observation.player.threats, undefined);
   assert.deepEqual(source, before);
   Object.assign(source.player.threats[0], { distance: 1.8, approaching: true, closingSpeed: 1, etaSeconds: 1.8 });
   const changed = render(), delta = changed.observationView.replace;
   assert.equal(delta.threats[0].approaching, true);
   assert.equal(delta.threats[0].distance, 1.8);
   assert.equal(delta.menuId, undefined);
   assert.ok(JSON.stringify(changed).indexOf('"threats"') < JSON.stringify(changed).indexOf('"goal"'));
  }
 }
});

test('suffocation and hunger are front facts and unknown maximum health stays unknown', () => {
 const source = dangerRepro('air-moving');
 delete source.player.maxHealth;
 Object.assign(source.player, { health: 2, foodLevel: 0, saturation: 0, suffocating: true, harm: { source: 'minecraft:in_wall', exits: [] } });
 const raw = JSON.parse(buildNativeEventInput({ currentGoal: 'Survive', goalRevision: 1 }, { observation: source }).split('\n')[1]);
 assert.equal(raw.hud.health, 2);
 assert.equal(raw.hud.foodLevel, 0);
 assert.equal(raw.hud.hungerShaking, true);
 assert.equal(raw.hud.suffocating, true);
 assert.equal(raw.hud.harm.source, 'minecraft:in_wall');
 assert.ok(JSON.stringify(raw).indexOf('"harm"') < JSON.stringify(raw).indexOf('"menuId"'));
});


test('submerged air seconds and breathable targets survive repeated public projection and tool receipts', () => {
	const source = observation();
	const breathable = { x: 0.5, y: 68.75, z: 1.5, distance: 6, direction: 'up_south', seconds: 3 };
	Object.assign(source.player, { underWater: true, air: 179, airSecondsLeft: 9, waterMotion: 'sinking', waterAbove: 'open_water', breathable });
	const once = visiblePlayer(source.player);
	assert.equal(visiblePlayer(once).airSecondsLeft, 9);
	for (const player of [
		delivered(presentNativeToolResult({ observation: source }, { kind: 'observe' })).observation.player,
		JSON.parse(toolResultContent({ observation: source }).contentItems[0].text).observation.player,
		createInterpreterFacts(source).player,
	]) {
		assert.equal(player.airSecondsLeft, 9);
		assert.deepEqual(JSON.parse(JSON.stringify(player.breathable)), breathable);
		assert.equal(player.waterMotion, 'sinking');
	}
});
