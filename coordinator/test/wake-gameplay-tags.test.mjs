import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';

// Every reviewed gameplay tag, including those absent from the recorded train wakes.
const GAMEPLAY_TAGS = [
	'animals_spawnable_on', 'armadillo_spawnable_on', 'axolotls_spawnable_on',
	'bats_spawnable_on', 'camels_spawnable_on', 'foxes_spawnable_on', 'frogs_spawnable_on',
	'goats_spawnable_on', 'mooshrooms_spawnable_on', 'parrots_spawnable_on',
	'rabbits_spawnable_on', 'wolves_spawnable_on', 'enderman_holdable', 'happy_ghast_avoids',
	'huge_brown_mushroom_can_place_on', 'huge_red_mushroom_can_place_on', 'moss_replaceable',
	'replaceable_by_mushrooms', 'replaceable_by_trees', 'sculk_replaceable', 'snaps_goat_horn',
	'sniffer_diggable_block', 'strider_warm_blocks', 'azalea_grows_on', 'azalea_root_replaceable',
	'beneath_bamboo_podzol_replaceable', 'beneath_tree_podzol_replaceable',
	'cannot_replace_below_tree_trunk', 'features_cannot_replace', 'lush_ground_replaceable',
].map((tag) => `#minecraft:${tag}`);

function render(tags, section = 'blocks') {
	const observation = {
		ready: true, observedAtEpochMs: 1,
		player: { x: 0, y: 64, z: 0, dead: false, health: 20 },
		world: { dimension: 'minecraft:overworld' }, inventory: { items: [] },
		[section]: [{ x: 1, y: 63, z: 0, blockId: 'minecraft:stone', tags }],
	};
	return buildNativeEventInput({ agentId: 'a1', currentGoal: 'Explore', goalRevision: 1 },
		{ event: 'observation', trigger: 'observation', observation });
}

for (const section of ['blocks', 'landmarks']) {
	test(`wake ${section} preserve all reviewed gameplay and growth tags`, () => {
		for (const tag of GAMEPLAY_TAGS) assert.ok(render([tag], section).includes(tag), tag);
	});
}

test('wake tag filtering preserves unknown, convention, sound and tutorial facts', () => {
	const tags = [
		'#minecraft:new_spawnable_on', '#minecraft:future_carver_replaceables',
		'#minecraft:replaceable_by_future_growth', '#example:sculk_replaceable_world_gen',
		'#minecraft:camel_sand_step_sound_blocks', '#minecraft:combination_step_sound_blocks',
		'#minecraft:inside_step_sound_blocks', '#minecraft:triggers_ambient_desert_sand_block_sounds',
		'#minecraft:triggers_ambient_desert_dry_vegetation_block_sounds',
		'#minecraft:triggers_ambient_dried_ghast_block_sounds', '#minecraft:completes_find_tree_tutorial',
		'#c:ore_bearing_ground/stone', '#c:ore_bearing_ground/deepslate',
		'#c:ore_bearing_ground/netherrack', '#c:ore_rates/dense', '#c:ore_rates/singular', '#c:ore_rates/sparse',
	];
	for (const tag of tags) assert.ok(render([tag]).includes(tag), tag);
});

test('wake filters exact generation-only tags without altering source observation', () => {
	const tags = ['#minecraft:overworld_carver_replaceables', '#minecraft:nether_carver_replaceables',
		'#minecraft:sculk_replaceable_world_gen', '#minecraft:stone_ore_replaceables',
		'#minecraft:geode_invalid_blocks', '#minecraft:lava_pool_stone_cannot_replace',
		'#minecraft:ice_spike_replaceable', '#minecraft:trail_ruins_replaceable',
		'#minecraft:forest_rock_can_place_on', '#minecraft:sculk_replaceable'];
	const before = [...tags];
	const text = render(tags);
	for (const tag of tags.slice(0, -1)) assert.ok(!text.includes(tag), tag);
	assert.ok(text.includes('#minecraft:sculk_replaceable'));
	assert.deepEqual(tags, before);
});
