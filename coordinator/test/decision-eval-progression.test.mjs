import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeSample } from '../src/decision-eval/grade.mjs';

// Progression families (q9): the hard predicates decide only the unambiguous outcomes. These checks pin what they
// decide on the committed cases with canonical calls: the stage's obvious next step is good, idling is bad, and a
// plausible alternative stays with the judge.
const trainDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'decision-eval', 'train');
const FAMILIES = ['progression-next-milestone', 'progression-efficiency', 'nether-fortress-search', 'blaze-fight', 'enderman-pearl-hunt',
	'late-stage-next-step', 'transition-prep', 'eye-of-ender-stronghold', 'end-fight-basics'];
const cases = new Map(FAMILIES.flatMap((f) => JSON.parse(fs.readFileSync(path.join(trainDir, `${f}.json`), 'utf8')).cases).map((c) => [c.id, c]));
const verdict = (id, calls) => gradeSample(cases.get(id), { calls }).verdict;
const act = (actionType, args) => ({ name: 'act', args: { actionType, arguments: args } });
const moveTo = (p) => ({ name: 'moveTo', args: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } });
const wait = { name: 'wait', args: { durationMs: 2000 } };
const entity = (id, type) => cases.get(id).state.observation.entities.filter((e) => e.type === type).sort((a, b) => a.distance - b.distance)[0];

test('every progression family is present with real or documented derived cases and one quick case', () => {
	for (const family of FAMILIES) {
		const members = [...cases.values()].filter((c) => c.family === family);
		assert.ok(members.length >= 5 && members.length <= 10, `${family} has ${members.length} cases`);
		assert.equal(members.filter((c) => c.quick).length, 1, `${family} has one quick case`);
		for (const c of members.filter((x) => x.source.derived)) assert.ok(c.source.derived.edits.some((e) => /kit|End/.test(e)), `${c.id} documents its edit`);
	}
	// The real progression families come from recorded moments only.
	for (const family of ['progression-next-milestone', 'progression-efficiency', 'nether-fortress-search', 'blaze-fight']) assert.ok([...cases.values()].filter((c) => c.family === family).every((c) => !c.source.derived), `${family} is all recorded moments`);
});

test('the obvious next step of each stage is good, idling is bad, alternatives go to the judge', () => {
	const ironPickaxe = act('craft_table', { recipeId: 'minecraft:iron_pickaxe', count: 1, x: 0, y: 64, z: 0, timeoutMs: 5000 });
	// No table in reach: a table craft at an unverified spot is the judge's call; the 2x2 inventory grid cannot make it.
	assert.equal(verdict('progression-next-milestone-01', [ironPickaxe]), 'needs_judge');
	assert.equal(verdict('progression-next-milestone-01', [act('craft_inventory', { recipeId: 'minecraft:iron_pickaxe', count: 1, timeoutMs: 5000 })]), 'bad', 'iron pickaxe needs the table grid');
	assert.equal(verdict('progression-next-milestone-01', [act('craft_table', { recipeId: 'minecraft:stone_pickaxe', count: 1, x: 0, y: 64, z: 0, timeoutMs: 5000 })]), 'bad', 'a tier already owned');
	assert.equal(verdict('progression-next-milestone-01', [wait]), 'bad');
	assert.equal(verdict('progression-next-milestone-01', [act('craft_inventory', { recipeId: 'minecraft:ender_eye', count: 1, timeoutMs: 5000 })]), 'bad', 'eyes without powder and pearls');
	// Ten ingots carried: more iron ore is the time sink; the pickaxe is the step.
	assert.equal(verdict('progression-efficiency-01', [ironPickaxe]), 'needs_judge');
	assert.equal(verdict('progression-efficiency-01', [act('craft_inventory', { recipeId: 'minecraft:iron_pickaxe', count: 1, timeoutMs: 5000 })]), 'bad');
	// Only a wooden pickaxe is carried: iron ore mined with it drops nothing.
	assert.equal(verdict('progression-efficiency-03', [{ name: 'mine', args: { x: 0, y: 40, z: 0, expectedBlockId: 'minecraft:iron_ore' } }]), 'bad');
	assert.equal(verdict('progression-efficiency-01', [{ name: 'mine', args: { x: 0, y: 40, z: 0, expectedBlockId: 'minecraft:iron_ore' } }]), 'bad');
	assert.equal(verdict('progression-efficiency-01', [act('craft_table', { recipeId: 'minecraft:iron_sword', count: 1, x: 0, y: 64, z: 0, timeoutMs: 5000 })]), 'needs_judge');
});

test('Nether: route geometry and combat remain rubric decisions', () => {
	const c = cases.get('nether-fortress-search-01');
	const bricks = [...c.state.observation.blocks, ...c.state.observation.landmarks].filter((b) => /nether_brick/.test(b.blockId))
		.sort((a, b) => Math.hypot(a.x - c.state.observation.position.x, a.z - c.state.observation.position.z) - Math.hypot(b.x - c.state.observation.position.x, b.z - c.state.observation.position.z))[0];
	assert.equal(verdict('nether-fortress-search-01', [moveTo({ x: bricks.x, y: bricks.y, z: bricks.z })]), 'needs_judge');
	assert.equal(verdict('nether-fortress-search-01', [wait]), 'bad');
	const p = c.state.observation.position;
	assert.equal(verdict('nether-fortress-search-01', [moveTo({ x: 2 * p.x - bricks.x, y: p.y, z: 2 * p.z - bricks.z })]), 'needs_judge', 'walking away is the judge\'s call');
	const blaze = entity('blaze-fight-01', 'minecraft:blaze');
	// Melee success depends on reach and the other threats: the judge's call. No bow or arrows: shooting is impossible.
	assert.equal(verdict('blaze-fight-01', [act('fight_target', { targetId: blaze.uuid, timeoutMs: 10000 })]), 'needs_judge');
	for (const id of ['blaze-fight-01', 'blaze-fight-06']) assert.equal(verdict(id, [act('use_ranged', { targetId: entity(id, 'minecraft:blaze').uuid, drawDurationMs: 1000, timeoutMs: 5000 })]), 'bad');
	assert.equal(verdict('blaze-fight-01', [wait]), 'bad');
	// A fight that failed for lack of a route: the identical fight again is bad.
	const failed = [...cases.values()].find((x) => x.family === 'blaze-fight' && x.state.agent.recentResults.at(-1)?.result?.reasonCode === 'NO_SEEN_ROUTE');
	const last = failed.state.agent.recentResults.at(-1);
	assert.equal(gradeSample(failed, { calls: [act('fight_target', { targetId: last.args.targetId, timeoutMs: 10000 })] }).verdict, 'bad');
});

test('pearls: equipment alone does not prove a safe enderman approach', () => {
	const late = cases.get('enderman-pearl-hunt-01');
	const e = entity('enderman-pearl-hunt-01', 'minecraft:enderman');
	assert.equal(verdict('enderman-pearl-hunt-01', [act('fight_target', { targetId: e.uuid, timeoutMs: 10000 })]), 'needs_judge');
	const early = [...cases.values()].find((c) => c.family === 'enderman-pearl-hunt' && !c.source.derived && /pair2/.test(c.source.trace));
	const e2 = early.state.observation.entities.find((x) => x.type === 'minecraft:enderman');
	assert.equal(gradeSample(early, { calls: [act('fight_target', { targetId: e2.uuid, timeoutMs: 10000 })] }).verdict, 'needs_judge');
	// Equipment in the late-stage twin still does not establish safe combat geometry.
	const twin = [...cases.values()].find((c) => c.family === 'enderman-pearl-hunt' && c.source.derived && c.source.sourceMomentId === early.source.sourceMomentId);
	if (twin) assert.equal(gradeSample(twin, { calls: [act('fight_target', { targetId: e2.uuid, timeoutMs: 10000 })] }).verdict, 'needs_judge');
	assert.ok(late);
});

test('late stages: blaze powder, the portal, the eye throw and the end crystals', () => {
	assert.equal(verdict('late-stage-next-step-03', [act('craft_inventory', { recipeId: 'minecraft:blaze_powder', count: 1, timeoutMs: 5000 })]), 'good');
	assert.equal(verdict('late-stage-next-step-03', [wait]), 'bad');
	assert.equal(verdict('late-stage-next-step-03', [act('craft_inventory', { recipeId: 'minecraft:ender_eye', count: 1, timeoutMs: 5000 })]), 'needs_judge', 'eyes need powder first');
	assert.equal(verdict('late-stage-next-step-05', [act('craft_inventory', { recipeId: 'minecraft:bucket', count: 1, timeoutMs: 5000 })]), 'bad', 'bucket needs the table grid');
	// Lighting and placement need recorded geometry, not just carried items.
	assert.equal(verdict('transition-prep-02', [act('use_item', { expectedItemId: 'minecraft:flint_and_steel', durationMs: 100 })]), 'needs_judge');
	assert.equal(verdict('transition-prep-02', [act('place_block', { x: 0, y: 64, z: 0, itemId: 'minecraft:obsidian', face: 'up' })]), 'needs_judge');
	// use_item only checks the held item (a pickaxe is held): selecting the eye first makes the throw.
	const eyeUse = act('use_item', { expectedItemId: 'minecraft:ender_eye', durationMs: 100 });
	const selectThenUse = { name: 'sequence', args: { actions: [{ actionType: 'select_item', arguments: { itemId: 'minecraft:ender_eye' } }, { actionType: 'use_item', arguments: { expectedItemId: 'minecraft:ender_eye', durationMs: 100 } }] } };
	for (const id of ['eye-of-ender-stronghold-01', 'transition-prep-05']) {
		assert.equal(verdict(id, [eyeUse]), 'needs_judge', `${id}: use_item alone keeps the held tool`);
		assert.equal(verdict(id, [selectThenUse]), 'needs_judge', `${id}: select then use throws the eye`);
	}
	const crystal = entity('end-fight-basics-01', 'minecraft:end_crystal');
	assert.equal(verdict('end-fight-basics-01', [act('use_ranged', { targetId: crystal.uuid, drawDurationMs: 1000, timeoutMs: 5000 })]), 'needs_judge', 'a target alone does not prove safe aim or a clear shot');
	assert.equal(verdict('end-fight-basics-01', [wait]), 'bad');
	// Eye-following movement needs a safe route; direction alone is not hard success.
	const flight = [...cases.values()].find((c) => c.family === 'eye-of-ender-stronghold' && c.state.observation.entities.some((e) => e.type === 'minecraft:eye_of_ender'));
	const eye = flight.state.observation.entities.find((e) => e.type === 'minecraft:eye_of_ender');
	const p = flight.state.observation.position;
	const along = { x: p.x + (eye.position.x - p.x) * 5, y: p.y, z: p.z + (eye.position.z - p.z) * 5 };
	const back = { x: p.x - (eye.position.x - p.x) * 5, y: p.y, z: p.z - (eye.position.z - p.z) * 5 };
	assert.equal(gradeSample(flight, { calls: [moveTo(along)] }).verdict, 'needs_judge');
	assert.equal(gradeSample(flight, { calls: [moveTo(back)] }).verdict, 'needs_judge');
});

test('End grading does not infer a perch or attackable parts from a stationary parent', () => {
 const c = cases.get('end-fight-basics-03');
 const dragon = entity(c.id, 'minecraft:ender_dragon');
 for (const action of ['use_ranged', 'fight_target']) assert.equal(verdict(c.id, [act(action, { targetId: dragon.uuid })]), 'needs_judge');
 assert.match(c.expect.judge.rubric, /entity list is sampled/);
 assert.doesNotMatch(c.expect.judge.rubric, /head part|every end crystal is destroyed/i);
 assert.equal(verdict('transition-prep-03', [wait]), 'needs_judge', 'full hunger permits safe regeneration');
 assert.equal(verdict('end-fight-basics-05', [wait]), 'needs_judge');
});

test('derived progression cases discard stale results and declare every kit', () => {
 for (const c of cases.values()) if (c.source.derived) {
  assert.deepEqual(c.state.observation.lastResult, { present: false }, c.id);
  assert.deepEqual(c.state.observation.changedFacts, [], c.id);
  assert.ok(c.source.derived.invariants.kit, c.id);
 }
 const original = cases.get('end-fight-basics-01'), variant = cases.get('end-fight-basics-05');
 assert.equal(original.source.sourceMomentId, variant.source.sourceMomentId);
 assert.equal(variant.state.observation.player.health, 6);
 assert.equal(variant.state.observation.player.foodLevel, 9);
});

test('accepted but impossible review calls never receive a hard good, while feasible one-craft controls do', async () => {
 const { normalizeMinecraftToolCall } = await import('../src/native-minecraft-tools.mjs');
 const craft = (recipeId, count = 1, type = 'craft_inventory') => act(type, { recipeId, count, timeoutMs: 5000, ...(type === 'craft_table' ? { x: 0, y: 64, z: 0 } : {}) });
 const checks = [
  ['progression-next-milestone-01', craft('minecraft:iron_pickaxe')],
  ['progression-efficiency-01', craft('minecraft:iron_pickaxe')],
  ['progression-efficiency-01', craft('minecraft:iron_pickaxe', 1, 'craft_table')],
  ['late-stage-next-step-05', craft('minecraft:bucket')],
  ['late-stage-next-step-03', craft('minecraft:ender_eye')],
  ['late-stage-next-step-03', craft('minecraft:blaze_powder', 64)],
  ['late-stage-next-step-06', craft('minecraft:flint_and_steel', 64)],
  ['transition-prep-02', act('place_block', { x: 0, y: 64, z: 0, itemId: 'minecraft:obsidian', face: 'up' })],
  ['transition-prep-02', act('use_item', { expectedItemId: 'minecraft:flint_and_steel', durationMs: 100 })],
  ...['transition-prep-05', 'eye-of-ender-stronghold-01'].map(id => [id, act('use_item', { expectedItemId: 'minecraft:ender_eye', durationMs: 100 })]),
 ];
 for (const id of ['blaze-fight-01', 'blaze-fight-06']) {
  const e = entity(id, 'minecraft:blaze');
  const shot = act('use_ranged', { targetId: e.uuid, drawDurationMs: 1000, timeoutMs: 5000 });
  checks.push([id, shot], [id, { name: 'sequence', args: { actions: [{ actionType: 'use_ranged', arguments: shot.args.arguments }, { actionType: 'look_at', arguments: e.position }] } }]);
 }
 for (const [id, call] of checks) {
  call.normalized = normalizeMinecraftToolCall(call.name, call.args);
  assert.notEqual(verdict(id, [call]), 'good', `${id}: ${JSON.stringify(call.args)}`);
 }
 for (const [id, recipe] of [['late-stage-next-step-03', 'minecraft:blaze_powder'], ['late-stage-next-step-06', 'minecraft:flint_and_steel']]) {
  const call = craft(recipe); call.normalized = normalizeMinecraftToolCall(call.name, call.args);
  assert.equal(verdict(id, [call]), 'good');
 }
});

test('hard-positive crafts require a complete single-call single-action answer', async () => {
 const { normalizeMinecraftToolCall } = await import('../src/native-minecraft-tools.mjs');
 const craft = (recipeId, count = 1) => ({ actionType: 'craft_inventory', arguments: { recipeId, count, timeoutMs: 5000 } });
 const powder = craft('minecraft:blaze_powder'), flint = craft('minecraft:flint_and_steel');
 const accepted = (name, args) => ({ name, args, normalized: normalizeMinecraftToolCall(name, args) });
 for (const [id, steps] of [
  ['late-stage-next-step-03', [craft('minecraft:ender_eye', 12), powder]],
  ['late-stage-next-step-06', [flint, flint]],
  ['late-stage-next-step-03', [craft('minecraft:blaze_powder', 14), craft('minecraft:ender_eye', 12)]],
 ]) assert.equal(verdict(id, [accepted('sequence', { actions: steps })]), 'needs_judge', `${id}: composite trajectories need judging`);
 for (const [id, step] of [['late-stage-next-step-03', powder], ['late-stage-next-step-06', flint]]) {
  const one = accepted('act', step);
  assert.equal(verdict(id, [one]), 'good');
  assert.equal(verdict(id, [one, one]), 'needs_judge', 'multiple separate tool calls cannot reuse the single-craft positive');
 }
});
