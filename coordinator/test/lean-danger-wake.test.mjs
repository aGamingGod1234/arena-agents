import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildNativeEventInput, isLeanDangerWake, LEAN_DANGER_NOTE } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';

// Audit 2026-11-01 #9: a danger wake leads with its summary and carries only what the decision needs.

const ZOMBIE = '00000000-0000-0000-0000-0000000000aa';
const GRASS_TAGS = ['#minecraft:animals_spawnable_on', '#minecraft:azalea_grows_on', '#minecraft:dirt', '#minecraft:enderman_holdable', '#minecraft:mineable/shovel',
	'#minecraft:sniffer_diggable_block', '#minecraft:supports_bamboo', '#minecraft:supports_big_dripleaf'];
const SWORD_TAGS = ['#c:enchantables', '#c:tools', '#c:tools/melee_weapon', '#minecraft:breaks_decorated_pots', '#minecraft:enchantable/durability', '#minecraft:swords'];
const BREAD_TAGS = ['#c:foods', '#c:foods/bread', '#minecraft:villager_picks_up'];

function record() {
	return { agentId: 'agent-a', name: 'Agent', goalRevision: 1, currentGoal: 'Get iron', currentGoalSpec: null };
}

function observation({ health = 9 } = {}) {
	return {
		observedAtEpochMs: 1_000, eventSequence: 5,
		world: { worldId: 'world-a', dimension: 'minecraft:overworld' },
		player: { x: 10.123456789, y: 64, z: -3.987654321, health, maxHealth: 20, foodLevel: 18,
			heard: [{ sound: 'entity.zombie.step', direction: 'front', elevation: 'level', distance: 3, count: 6 },
				{ sound: 'entity.player.attack.sweep', direction: 'here', elevation: 'level', distance: 2 },
				{ sound: 'entity.creeper.primed', direction: 'back', elevation: 'level', distance: 4 }] },
		inventory: {
			items: [{ itemId: 'minecraft:stone_sword', count: 1, slot: 0, tags: SWORD_TAGS }, { itemId: 'minecraft:bread', count: 3, slot: 1, tags: BREAD_TAGS }],
			tagCounts: Object.fromEntries([...SWORD_TAGS.map((tag) => [tag, 1]), ...BREAD_TAGS.map((tag) => [tag, 3])]),
			selectedSlot: 0,
		},
		entities: [{ uuid: ZOMBIE, stableId: ZOMBIE, type: 'minecraft:zombie', x: 11.5602580870658, y: 64, z: -3.35550261943195, distance: 1.4, hostile: true, alive: true, targetingAgent: true,
			velocity: { x: -0.1140000015258789, y: -0.0784000015258789, z: 0 }, bounds: [11.2602580870658, 64, -3.65550261943195, 11.8602580870658, 65.95, -3.05550261943195] }],
		blocks: [{ x: 10, y: 63, z: -4, blockId: 'minecraft:grass_block', tags: GRASS_TAGS }, { x: 9, y: 63, z: -4, blockId: 'minecraft:grass_block', tags: GRASS_TAGS }],
		landmarks: [{ x: 20, y: 64, z: 0, distance: 10.4, blockId: 'minecraft:snow', tags: ['#minecraft:mineable/shovel', '#minecraft:snow'] },
			{ x: 14, y: 63, z: 2, distance: 6.9, blockId: 'minecraft:lava', tags: [] }],
		items: [],
	};
}

const facts = (input) => decodeModelFacts(JSON.parse(input.slice(input.indexOf('\n') + 1)));

test('a danger wake drops tag noise, routine sounds, far landmarks and hit boxes but keeps every decision fact', () => {
	const lean = facts(encodeNativeEventInput(buildNativeEventInput(record(), { event: 'observation', trigger: 'damage', observation: observation() })));
	const full = facts(encodeNativeEventInput(buildNativeEventInput(record(), { event: 'observation', trigger: 'attention', observation: observation({ health: 20 }) })));
	assert.equal(lean.observation.omittedForDanger, LEAN_DANGER_NOTE);
	assert.equal(full.observation.omittedForDanger, undefined, 'an ordinary wake is unchanged');
	// Tags: digging and weapon/food facts stay, worldgen and enchantment trivia go.
	assert.deepEqual(lean.observation.blockTags['minecraft:grass_block'], ['#minecraft:dirt', '#minecraft:mineable/shovel']);
	assert.ok(full.observation.blockTags['minecraft:grass_block'].includes('#minecraft:supports_bamboo'));
	const leanItems = Object.fromEntries(lean.observation.inventory.items.map((row) => [row.itemId, row]));
	assert.ok(leanItems['minecraft:stone_sword'], 'every carried stack is still listed');
	assert.ok(leanItems['minecraft:bread']);
	const itemTags = lean.observation.itemTags ?? {};
	assert.deepEqual(itemTags['minecraft:stone_sword'] ?? leanItems['minecraft:stone_sword'].tags, ['#c:tools', '#c:tools/melee_weapon', '#minecraft:swords']);
	assert.deepEqual(itemTags['minecraft:bread'] ?? leanItems['minecraft:bread'].tags, ['#c:foods', '#c:foods/bread']);
	// Sounds: footsteps and the fight's own swings go; a fusing creeper behind stays.
	assert.deepEqual(lean.observation.player.heard.map((row) => row.sound), ['entity.creeper.primed']);
	assert.equal(full.observation.player.heard.length, 3);
	// Landmarks: the lava stays as an escape fact, the far snow goes and is counted as omitted.
	assert.deepEqual(lean.observation.landmarks.map((row) => row.blockId), ['minecraft:lava']);
	assert.equal(lean.observation.omittedRows.landmarks, 1);
	// The mob keeps its identity, distance and targeting; its position is rounded and its hit box left out.
	const zombie = lean.observation.entities.find((row) => (row.stableId ?? row.uuid) === ZOMBIE);
	assert.equal(zombie.targetingAgent, true);
	assert.equal(zombie.distance, 1.4);
	assert.deepEqual([zombie.x, zombie.y, zombie.z], [11.6, 64, -3.4]);
	assert.equal(zombie.bounds, undefined);
	assert.deepEqual(zombie.velocity, { x: -0.11, y: -0.08, z: 0 });
	assert.deepEqual([lean.observation.player.x, lean.observation.player.z], [10.1, -4]);
	assert.equal(lean.observation.health, '9/20');
	assert.equal(lean.observation.blocks.length, 2, 'the cells around the body all stay');
	assert.ok(Buffer.byteLength(JSON.stringify(lean)) < Buffer.byteLength(JSON.stringify(full)));
});

test('a danger wake puts the danger, threat and intent lines ahead of the observation', () => {
	const continuity = { goal: 'Get iron', intent: 'mine iron', guard: 'none installed' };
	const order = (trigger, health) => Object.keys(facts(encodeNativeEventInput(buildNativeEventInput(record(), { event: 'observation', trigger, observation: observation({ health }), continuity, goalNow: 'iron 0/3' }))));
	const lean = order('damage', 9);
	assert.ok(lean.indexOf('now') < lean.indexOf('observation'), `now leads the observation: ${lean.join(',')}`);
	assert.ok(lean.indexOf('goalNow') < lean.indexOf('observation'));
	const ordinary = order('attention', 20);
	assert.ok(ordinary.indexOf('observation') < ordinary.indexOf('now'), 'ordinary wakes keep their order');
});

test('lean wakes are the survival decisions: danger triggers, low health, hazards and a low-health bail-out', () => {
	assert.equal(isLeanDangerWake({ trigger: 'damage' }), true);
	assert.equal(isLeanDangerWake({ trigger: 'low_health' }), true);
	assert.equal(isLeanDangerWake({ trigger: 'attention', observation: { player: { onFire: true } } }), true);
	assert.equal(isLeanDangerWake({ trigger: 'program_attention', status: { decision: { priority: 'urgent', trigger: 'threat' } } }), true);
	assert.equal(isLeanDangerWake({ trigger: 'resource_discovery', observation: { lastResult: { reasonCode: 'LOW_HEALTH_BAILOUT' } } }), true);
	assert.equal(isLeanDangerWake({ trigger: 'resource_discovery', observation: { lastResult: { reasonCode: 'LOW_HEALTH_BAILOUT' }, currentAction: { active: true } } }), false);
	assert.equal(isLeanDangerWake({ trigger: 'attention' }), false);
	assert.equal(isLeanDangerWake({ trigger: 'damage', conversationOnly: true }), false);
	assert.equal(isLeanDangerWake({ trigger: 'damage', conversationOnly: true, dangerWake: true }), true);
});

test('the recorded 9 HP zombie bail-out wake is about 30% smaller and still carries the whole decision', async () => {
	const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/train/melee-threat-low-health.json', import.meta.url)));
	const rendered = await renderWake(fixture.cases.find((entry) => entry.id === 'melee-threat-low-health-fullgame-zombie'), { provider: 'codex', model: 'gpt-6.1-sol' });
	const wake = facts(rendered.encodedInput);
	// Measured before this change: 17,164 encoded bytes (docs/audits/2026-11-01-agent-performance-audit.md section C).
	assert.ok(rendered.encodedBytes <= 12_500, `lean bail-out wake is ${rendered.encodedBytes} bytes`);
	assert.match(rendered.encodedInput.slice(0, rendered.encodedInput.indexOf('\n')), /bailout health/);
	const keys = Object.keys(wake);
	assert.ok(keys.indexOf('danger') < keys.indexOf('now') && keys.indexOf('now') < keys.indexOf('observation'));
	const observed = wake.observation;
	assert.equal(observed.omittedForDanger, LEAN_DANGER_NOTE);
	assert.equal(observed.health, '9/20');
	assert.equal(observed.threats.length, 4, 'every threat row stays');
	assert.equal(observed.lastResult.reasonCode, 'LOW_HEALTH_BAILOUT');
	assert.equal(observed.player.bestWeapon.itemId, 'minecraft:stone_sword');
	assert.equal(observed.blocks.length, 12, 'every nearby cell the rows carried stays');
	assert.ok(observed.inventory.items.some((row) => row.itemId === 'minecraft:rotten_flesh'));
	assert.ok(observed.itemTags['minecraft:rotten_flesh'].includes('#c:foods'));
	assert.ok(observed.blockTags['minecraft:dirt'].includes('#minecraft:mineable/shovel'), 'dig-in facts stay');
	assert.equal(observed.entities.filter((row) => row.type === 'minecraft:zombie').length, 4);
	assert.ok(observed.entities.every((row) => row.bounds === undefined));
});
