import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeEventInput, healingFacts } from '../src/dynamic-main.mjs';
import { createFactView } from '../src/arena-script/facts.mjs';
import { presentEventObservation } from '../src/event-observation-presentation.mjs';

const event = observation => JSON.parse(buildNativeEventInput({ currentGoal: 'Gather logs', goalRevision: 1 }, { event: 'observation', observation }).split('\n')[1]).observation;
test('event aliases are removed only when identical; runtime facts remain intact', () => {
 const threat = { uuid: 'mob', stableId: 'mob', type: 'minecraft:zombie', risk: 4 };
 const sound = { sound: 'block.lava.pop', distance: 3 };
 const source = { player: { x: 1, y: 64, z: 2, yaw: 12.123456789, pitch: 3.987654321,
  foodLevel: 18, hunger: 18, onFire: false, fire: false, heard: [sound], heardLava: sound,
  threats: [threat], threat, highestRiskThreat: threat }, inventory: { items: [] }, items: [], entities: [], blocks: [],
  interaction: { input: { yaw: 12.123456789, pitch: 8 }, menu: { type: 'minecraft:inventory', slots: [{ slot: 0, itemId: 'minecraft:oak_planks' }] } } };
 const before = structuredClone(source), projected = presentEventObservation(source);
 for (const field of ['hunger', 'fire', 'heardLava', 'highestRiskThreat']) assert.equal(projected.player[field], undefined);
 assert.equal(projected.player.threats[0].stableId, undefined);
 assert.equal(projected.player.threat.uuid, 'mob');
 assert.equal(projected.player.yaw, before.player.yaw);
 assert.equal(projected.interaction.input.yaw, undefined);
 assert.equal(projected.interaction.input.pitch, 8);
 assert.deepEqual(projected.interaction.menu, before.interaction.menu);
 assert.deepEqual(source, before);
 const runtime = createFactView(source);
 assert.equal(runtime.player.hunger, 18);
 assert.deepEqual({ ...runtime.player.heardLava }, sound);
 assert.equal(runtime.player.highestRiskThreat.uuid, 'mob');
 const divergent = presentEventObservation({ player: { hunger: 8, foodLevel: 18, fire: true, onFire: false } });
 assert.equal(divergent.player.hunger, 8); assert.equal(divergent.player.fire, true);
});

test('wakes show the facts behind safety and healing labels, not the labels; runtime keeps them', () => {
 const food = { slot: 2, itemId: 'minecraft:cooked_beef', nutrition: 8 };
 const source = { player: { health: 12, maxHealth: 20, onFire: true, threats: [], canHealNow: true, safe: true, canEat: true, bestFood: food, healOpportunity: true, lowHealthNoFood: false } };
 const projected = presentEventObservation(source);
 for (const field of ['safe', 'canHealNow', 'healOpportunity']) assert.equal(projected.player[field], undefined);
 assert.equal(projected.player.onFire, true);
 assert.equal(projected.player.canEat, true);
 assert.deepEqual(projected.player.bestFood, food);
 assert.equal(source.player.safe, true);
 assert.equal(createFactView(source).player.canHealNow, true);
});

test('healing facts in wakes carry no verdict labels, supplied or computed; runtime healing keeps them', () => {
 const player = { x: 1, y: 64, z: 2, health: 6, maxHealth: 20, foodLevel: 12, onFire: true, threats: [], safe: true, canHealNow: true, canEat: true,
  bestFood: { slot: 2, itemId: 'minecraft:cooked_beef', nutrition: 8 }, healOpportunity: true, lowHealthNoFood: false };
 const observation = { player, inventory: { items: [] }, items: [], entities: [], blocks: [] };
 const before = structuredClone(observation);
 const supplied = healingFacts(observation), suppliedBefore = structuredClone(supplied);
 const wake = (args) => JSON.parse(buildNativeEventInput({ currentGoal: null, goalRevision: 1 }, { event: 'observation', observation, ...args }).split('\n')[1]);
 for (const [label, args] of [['supplied low_health_idle', { trigger: 'low_health_idle', selfCareWake: true, healing: supplied }], ['computed fire', { trigger: 'fire' }], ['computed low_health', { trigger: 'low_health' }]]) {
  const event = wake(args);
  assert.ok(event.healing, `${label}: the wake has healing facts`);
  for (const field of ['safe', 'canHealNow', 'healOpportunity']) assert.equal(Object.hasOwn(event.healing, field), false, `${label}: healing.${field}`);
  assert.equal(event.healing.canEat, true, `${label}: the facts stay`);
  assert.equal(Object.hasOwn(event.observation.player, 'safe'), false, `${label}: player.safe`);
 }
 assert.equal(healingFacts(observation).safe, true, 'runtime healing keeps the label');
 assert.equal(createFactView(observation).player.safe, true, 'scripts keep the label');
 assert.deepEqual(observation, before);
 assert.deepEqual(supplied, suppliedBefore);
});

test('landmark tag dictionary survives budget pruning and keeps conflicting tags inline', () => {
 const block = { blockId: 'minecraft:stone', stableId: '1,64,2', x: 1, y: 64, z: 2, tags: ['#stone'] };
 const landmark = { blockId: 'minecraft:oak_log', stableId: '3,64,4', x: 3, y: 64, z: 4, tags: ['#logs'], bearing: 12.123456789 };
 const source = { world: { worldId: 'test', dimension: 'minecraft:overworld', extra: 'x'.repeat(30000) }, blocks: [block], landmarks: [landmark] };
 const projected = event(source);
 assert.equal(projected.landmarks[0].stableId, undefined);
 assert.equal(projected.landmarks[0].tags, undefined);
 assert.deepEqual(projected.blockTags['minecraft:oak_log'], ['#logs']);
 assert.equal(projected.landmarks[0].bearing, landmark.bearing);
 assert.deepEqual(source.landmarks[0].tags, ['#logs']);
 const conflict = event({ blocks: [block], landmarks: [{ ...landmark, blockId: 'minecraft:stone', tags: ['#different'] }] });
 assert.deepEqual(conflict.blocks[0].tags, ['#stone']);
 assert.deepEqual(conflict.landmarks[0].tags, ['#different']);
});

test('block unavailable fields share one list only when all rows agree', () => {
 const world = { worldId: 'test', dimension: 'minecraft:overworld', extra: 'x'.repeat(30000) };
 const blocks = [1, 2].map(x => ({ x, y: 64, z: 0, blockId: 'minecraft:stone', extraDetail: true }));
 const projected = event({ world, blocks });
 assert.deepEqual(projected.blockOmittedFields, ['extraDetail']);
 assert.equal(projected.blocks[0].omittedFields, undefined);
 const different = event({ world, blocks: [blocks[0], { ...blocks[1], otherDetail: true }] });
 assert.equal(different.blockOmittedFields, undefined);
 assert.deepEqual(different.blocks[1].omittedFields, ['extraDetail', 'otherDetail']);
});

test('recovery keeps deaths, historical facts and unfamiliar fields', () => {
 const inventory = { items: [{ itemId: 'minecraft:oak_log', count: 2 }] };
 const recovery = { alreadyHave: ['minecraft:oak_log'], facts: 'Currently evidenced: minecraft:oak_log.' };
 assert.equal(presentEventObservation({ inventory, recovery }).recovery, undefined);
 for (const extra of [{ lastDeath: { cause: 'lava' } }, { alreadyHaveFacts: [{ remembered: true }] }, { doNotRedo: ['old base'] }]) {
  const value = { ...recovery, ...extra };
  assert.deepEqual(presentEventObservation({ inventory, recovery: value }).recovery, value);
 }
});

test('wake memory is paid for by removing exact current inventory recovery copies', () => {
 const inventory = { items: [{ itemId: 'minecraft:oak_log', count: 2 }, { itemId: 'minecraft:oak_log', count: 3 }] };
 const recovery = { alreadyHave: ['minecraft:oak_log'], alreadyHaveFacts: [{ kind: 'inventory', itemId: 'minecraft:oak_log', count: 5 }], facts: 'Currently evidenced: minecraft:oak_log.' };
 const source = { inventory, recovery };
 assert.equal(presentEventObservation(source).recovery, undefined);
 assert.deepEqual(source.recovery, recovery);
 assert.deepEqual(presentEventObservation({ inventory, recovery: { ...recovery, lastDeath: { cause: 'lava' } } }).recovery, { lastDeath: { cause: 'lava' } });
 for (const extra of [{ alreadyHaveFacts: [{ ...recovery.alreadyHaveFacts[0], remembered: true }] },
  { alreadyHaveFacts: [{ ...recovery.alreadyHaveFacts[0], count: 4 }] }, { unknown: true }]) {
  const changed = { ...recovery, ...extra };
  assert.deepEqual(presentEventObservation({ inventory, recovery: changed }).recovery, changed);
 }
 assert.deepEqual(presentEventObservation({ inventory, recovery, continuity: { rememberedSections: ['inventory'] } }).recovery, recovery);
 assert.deepEqual(presentEventObservation(source, { inventoryLimit: 1 }).recovery, recovery);
});

test('landmark defaults appear only when stableId or tags were removed', () => {
 const landmark = { blockId: 'minecraft:stone', x: 1, y: 64, z: 2, stableId: 'custom' };
 for (const landmarks of [[], [landmark], [{ ...landmark, tags: ['#different'] }]]) {
  const projected = event({ blocks: [{ ...landmark, tags: ['#stone'] }], landmarks });
  assert.equal(projected.landmarkDefaults, undefined);
 }
 for (const removed of [{ stableId: '1,64,2' }, { tags: ['#stone'] }]) {
  const projected = event({ blocks: [], landmarks: [{ ...landmark, ...removed }] });
  assert.match(projected.landmarkDefaults, /Omitted landmark/);
 }
});

// Synthetic lava-contact variant of the B/S1-r4 death (recorded inLava was false): the sparse death notice is merged with the last live sample, so a corpse
// arrived with 20 armour, hunger 17, burning and a historical 4.6 KB inventory. The recorded main hand was a diamond sword.
const corpse = () => ({
 world: { worldId: 'w', dimension: 'minecraft:the_nether' }, ready: false, status: 'PLAYER_DEAD',
 death: { cause: 'burned to death', dimensionId: 'minecraft:the_nether', x: 65.59, y: 42, z: 69.53, diedAtEpochMs: 1 },
 player: { x: 65.59, y: 42, z: 69.53, yaw: -168, pitch: 13, dead: true, health: 0, maxHealth: 20, gameMode: 'survival', armor: 20, foodLevel: 17, saturation: 0,
  onFire: true, fireTicks: 299, hurtBy: 'on_fire', inLava: true, canHealNow: true, safe: true, bestFood: { slot: 2, itemId: 'minecraft:cooked_beef', nutrition: 8 },
  healOpportunity: true, lowHealthNoFood: false, threats: [], threat: null, highestRiskThreat: null, bestWeapon: null, effects: [],
  heard: [{ sound: 'block.fire.ambient', direction: 'front', elevation: 'level', distance: 3 }] },
 inventory: { items: [] }, lastLiveInventory: { items: [{ itemId: 'minecraft:diamond_sword', count: 1, slot: 'mainhand', tags: ['#minecraft:swords'] }] },
 perception: { latestSequence: 9, events: [{ type: 'sound', soundId: 'minecraft:block.fire.ambient', sequence: 8 }, { type: 'system_message', text: 'x burned to death', sequence: 9 }] },
 recovery: { lastDeath: { cause: 'burned to death' }, lastLostInventory: [{ itemId: 'minecraft:diamond_sword', count: 1 }], alreadyHave: [], facts: 'Last death: burned to death in the_nether at x=66,y=42,z=70. Lost on death: minecraft:diamond_sword.' },
 continuity: { sameGoal: true, phase: 'dead', rememberedSections: ['world'] },
});

test('a dead body keeps only where it died and that it is dead; stale live facts and the last live inventory go', () => {
 const source = corpse(), before = structuredClone(source);
 const projected = presentEventObservation(source);
 assert.deepEqual(projected.player, { x: 65.59, y: 42, z: 69.53, yaw: -168, pitch: 13, dead: true, health: 0, maxHealth: 20, gameMode: 'survival' });
 assert.equal(projected.lastLiveInventory, undefined);
 assert.deepEqual(projected.perception.events.map(row => row.type), ['system_message']);
 // Death, the lost stacks and the continuity facts stay.
 assert.equal(projected.death.cause, 'burned to death');
 assert.deepEqual(projected.recovery, before.recovery);
 assert.equal(projected.continuity.phase, 'dead');
 assert.deepEqual(source, before, 'the runtime observation is untouched');
 // The dead flag may arrive through continuity alone.
 const byPhase = presentEventObservation({ ...corpse(), player: { ...corpse().player, dead: undefined } });
 assert.equal(byPhase.player.armor, undefined);
});

test('a death in lava is not a body in lava: the death wake names the death and gives no exits', () => {
 const input = buildNativeEventInput({ currentGoal: 'beat the game', goalRevision: 1 }, { event: 'player_death', trigger: 'player_death', observation: corpse() });
 assert.match(input.split('\n')[0], /^Died: .+\. While dead only respawn acts\./);
 assert.doesNotMatch(input.split('\n')[0], /in lava or fire/);
 const payload = JSON.parse(input.split('\n')[1]);
 assert.equal(payload.healing, undefined);
 assert.equal(payload.observation.lastLiveInventory, undefined);
 assert.ok(Buffer.byteLength(JSON.stringify(payload.observation.player)) < 200);
});

test('survival defaults are shown only when the server observed survival', () => {
 // Full health: the server sends no survival section and the adapter fills defaults.
 const unobserved = { x: 1, y: 64, z: 2, health: 20, foodLevel: 20, canHealNow: false, bestFood: null, healOpportunity: false, lowHealthNoFood: false, threats: [] };
 const projected = presentEventObservation({ player: unobserved, inventory: { items: [{ itemId: 'minecraft:cooked_beef', count: 16, slot: 2 }] } });
 for (const field of ['canHealNow', 'bestFood', 'healOpportunity', 'lowHealthNoFood']) assert.equal(Object.hasOwn(projected.player, field), false, field);
 assert.equal(projected.player.health, 20);
 // Observed survival (safe is only ever sent with it) keeps every fact, including a true null bestFood; the verdict labels go.
 const observed = { ...unobserved, safe: true };
 const { canHealNow, healOpportunity, safe, ...facts } = observed;
 assert.deepEqual(presentEventObservation({ player: observed, inventory: { items: [] } }).player, facts);
 const hurt = { ...unobserved, health: 6, canHealNow: true, safe: false, bestFood: { slot: 2, itemId: 'minecraft:cooked_beef', nutrition: 8 } };
 assert.deepEqual(presentEventObservation({ player: hurt, inventory: { items: [] } }).player.bestFood, hurt.bestFood);
 // Any non-default value is an observation and stays even without safe.
 const signalled = { ...unobserved, lowHealthNoFood: true };
 assert.equal(presentEventObservation({ player: signalled, inventory: { items: [] } }).player.lowHealthNoFood, true);
});


test('last live inventory stays historical when no recovery stack list replaces it', () => {
 const source = corpse(); delete source.recovery.lastLostInventory;
 assert.deepEqual(presentEventObservation(source).lastLiveInventory, source.lastLiveInventory);
 const phaseOnly = presentEventObservation({ ...source, player: { ...source.player, dead: false, health: 20 } });
 assert.equal(phaseOnly.player.dead, true);
 assert.equal(phaseOnly.player.health, 0);
});

test('runtime recovery restates held stacks without erasing death or remembered evidence', () => {
 const inventory = { items: [{ itemId: 'minecraft:oak_log', count: 2 }, { itemId: 'minecraft:oak_log', count: 3 }] };
 const recovery = { alreadyHave: ['minecraft:oak_log'], alreadyHaveFacts: [{ kind: 'inventory', itemId: 'minecraft:oak_log', count: 5 }], doNotRedo: [], facts: 'Currently evidenced: minecraft:oak_log.' };
 assert.equal(presentEventObservation({ inventory, recovery }).recovery, undefined);
 for (const extra of [{ unfamiliar: true },
  { alreadyHaveFacts: [{ kind: 'inventory', itemId: 'minecraft:oak_log', count: 4 }] },
  { alreadyHaveFacts: [{ kind: 'inventory', itemId: 'minecraft:oak_log', count: 5, remembered: true }] },
  { alreadyHaveFacts: [{ kind: 'placed', blockId: 'minecraft:crafting_table', x: 0, y: 64, z: 0 }] }, { doNotRedo: ['unknown'] }]) {
  const value = { ...recovery, ...extra };
  assert.deepEqual(presentEventObservation({ inventory, recovery: value }).recovery, value);
 }
 assert.deepEqual(inventory.items.map(row => row.count), [2, 3]);
});


test('death recovery retains historical losses while current inventory is presented once', () => {
 const inventory = { items: [{ itemId: 'minecraft:oak_log', count: 5 }] };
 const recovery = { lastDeath: { cause: 'lava' }, lastLostInventory: [{ itemId: 'minecraft:stone', count: 12 }],
  alreadyHave: ['minecraft:oak_log'], alreadyHaveFacts: [{ kind: 'inventory', itemId: 'minecraft:oak_log', count: 5 }], doNotRedo: [],
  facts: 'Last death: lava. Current inventory: minecraft:oak_log. Currently evidenced: minecraft:oak_log. Lost on death: minecraft:stone.' };
 const before = structuredClone(recovery);
 const projected = presentEventObservation({ inventory, recovery });
 assert.deepEqual(projected.recovery.lastDeath, recovery.lastDeath);
 assert.deepEqual(projected.recovery.lastLostInventory, recovery.lastLostInventory);
 assert.equal(projected.recovery.facts, 'Last death: lava. Lost on death: minecraft:stone.');
 assert.equal(projected.recovery.alreadyHave, undefined);
 assert.equal(projected.recovery.alreadyHaveFacts, undefined);
 assert.equal(projected.recovery.doNotRedo, undefined);
 assert.deepEqual(recovery, before);
 // Partial or remembered inventory cannot justify removing any statement about what is carried now.
 const remembered = presentEventObservation({ inventory, recovery, continuity: { rememberedSections: ['inventory'] } });
 assert.deepEqual(remembered.recovery, recovery);
 const different = { ...recovery, alreadyHaveFacts: [{ kind: 'inventory', itemId: 'minecraft:oak_log', count: 4 }] };
 assert.deepEqual(presentEventObservation({ inventory, recovery: different }).recovery, different);
});
