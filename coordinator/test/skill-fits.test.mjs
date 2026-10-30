import test from 'node:test';
import assert from 'node:assert/strict';
import { skillFitsLine } from '../src/skill-fits.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const NETHER = 'minecraft:the_nether', OVERWORLD = 'minecraft:overworld';
const item = (id, count = 1, slot) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}) });
const sample = ({ dimension = NETHER, items = [], entities = [], blocks = [], landmarks = [], currentAction } = {}) => ({
	ready: true, observedAtEpochMs: 1_000, world: { worldId: 'w', dimension }, position: { x: 0, y: 64, z: 0 },
	player: { dead: false, health: 20 }, inventory: { items }, entities, blocks, landmarks, ...(currentAction ? { currentAction } : {}),
});
const mob = (type, distance, extra = {}) => ({ type: `minecraft:${type}`, distance, alive: true, ...extra });
const rods = { id: 'minecraft:blaze_rod', have: 1, need: 6 };
const pearls = { id: 'minecraft:ender_pearl', have: 0, need: 12 };
const obsidian = { id: 'minecraft:obsidian', have: 0, need: 10 };
const lava = (x, y, z) => ({ blockId: 'minecraft:lava', x, y, z, state: { level: '0' } });
const goldKit = [item('gold_ingot', 32), item('golden_boots', 1, 'feet')];

test('fight_until blaze: rods open, in the Nether, a spawner or blaze within 24 m, a weapon', () => {
	const gear = [item('iron_sword'), item('bow'), item('arrow', 40)];
	const spawner = { blockId: 'minecraft:spawner', x: 8, y: 64, z: 0 };
	assert.equal(skillFitsLine({ observation: sample({ items: gear, blocks: [spawner] }), needs: [rods] }),
		'fight_until mob:minecraft:blaze untilItem:minecraft:blaze_rod untilCount:6 (spawner 8 m, iron_sword, bow + 40 arrows, rods 1/6)');
	// A remembered blaze spawner counts; a blaze in view is the fact when no spawner is near.
	assert.match(skillFitsLine({ observation: sample({ items: gear }), needs: [rods], sightings: [{ kind: 'spawner', mob: 'minecraft:blaze', x: 0, y: 70, z: 10 }] }), /\(spawner 12 m,/);
	assert.match(skillFitsLine({ observation: sample({ items: [item('diamond_sword')], entities: [mob('blaze', 4.2)] }), needs: [rods] }), /\(blaze 4 m, diamond_sword, rods 1\/6\)$/);
	// Each precondition alone keeps the line off.
	assert.equal(skillFitsLine({ observation: sample({ items: gear, entities: [mob('blaze', 30)] }), needs: [rods] }), null, 'too far');
	assert.equal(skillFitsLine({ observation: sample({ items: [item('cobblestone', 64)], entities: [mob('blaze', 5)] }), needs: [rods] }), null, 'no weapon');
	assert.equal(skillFitsLine({ observation: sample({ dimension: OVERWORLD, items: gear, entities: [mob('blaze', 5)] }), needs: [rods] }), null, 'not in the Nether');
	assert.equal(skillFitsLine({ observation: sample({ items: gear, entities: [mob('blaze', 5)] }), needs: [{ ...rods, have: 6 }] }), null, 'rods met');
	assert.equal(skillFitsLine({ observation: sample({ items: gear, entities: [mob('blaze', 5)], currentAction: { active: true, actionType: 'fight_until' } }), needs: [rods] }), null, 'already running');
});

test('fight_until enderman: pearls open, an enderman within 24 m, a melee weapon', () => {
	assert.equal(skillFitsLine({ observation: sample({ dimension: OVERWORLD, items: [item('stone_sword'), item('iron_axe')], entities: [mob('enderman', 10.4)] }), needs: [pearls] }),
		'fight_until mob:minecraft:enderman untilItem:minecraft:ender_pearl untilCount:12 (enderman 10 m, iron_axe, pearls 0/12)');
	assert.equal(skillFitsLine({ observation: sample({ items: [item('bow'), item('arrow', 20)], entities: [mob('enderman', 10)] }), needs: [pearls] }), null, 'a bow alone never fights an enderman');
	assert.equal(skillFitsLine({ observation: sample({ items: [item('iron_sword')], entities: [mob('enderman', 10, { alive: false })] }), needs: [pearls] }), null, 'dead');
	assert.equal(skillFitsLine({ observation: sample({ items: [item('iron_sword')], entities: [mob('enderman', 10)] }), needs: [] }), null, 'no open need');
});

test('barter_until: pearls open, gold held, gold armour worn, a calm adult piglin within 16 m', () => {
	const piglin = mob('piglin', 6.2);
	assert.equal(skillFitsLine({ observation: sample({ items: goldKit, entities: [piglin] }), needs: [{ ...pearls, have: 4 }] }),
		'barter_until itemId:minecraft:ender_pearl count:8 (piglin 6 m, gold 32, gold armour worn, pearls 4/12)');
	assert.equal(skillFitsLine({ observation: sample({ items: [item('gold_ingot', 32), item('golden_boots')], entities: [piglin] }), needs: [pearls] }), null, 'boots carried, not worn');
	assert.equal(skillFitsLine({ observation: sample({ items: [item('golden_boots', 1, 'feet')], entities: [piglin] }), needs: [pearls] }), null, 'no gold');
	assert.equal(skillFitsLine({ observation: sample({ items: goldKit, entities: [mob('piglin', 6, { baby: true }), mob('piglin', 7, { targetingAgent: true }), mob('piglin', 20)] }), needs: [pearls] }), null, 'baby, angry, too far');
	// An enderman in reach comes first for the same pearls when a melee weapon is held.
	assert.match(skillFitsLine({ observation: sample({ items: [...goldKit, item('iron_sword')], entities: [piglin, mob('enderman', 9)] }), needs: [pearls] }), /^fight_until mob:minecraft:enderman/);
});

test('cast_obsidian: obsidian open, outside the Nether, a water bucket, a still lava source within 16 m', () => {
	const kit = [item('water_bucket'), item('bucket')];
	assert.equal(skillFitsLine({ observation: sample({ dimension: OVERWORLD, items: kit, blocks: [lava(3, 64, 0), lava(9, 64, 0)] }), needs: [obsidian] }),
		'cast_obsidian x:3 y:64 z:0 count:10 or frame:true at a frame corner (lava source 3 m, water_bucket + bucket, obsidian 0/10)');
	// Without an empty bucket only count mode fits; a remembered pool cell counts.
	assert.equal(skillFitsLine({ observation: sample({ dimension: OVERWORLD, items: [item('water_bucket'), item('obsidian', 4)] }), needs: [{ ...obsidian, have: 4 }],
		lavaPools: [{ dimension: OVERWORLD, x: 0, y: 60, z: 5, sources: 2, cells: ['0,60,5', '1,60,5'] }] }),
	'cast_obsidian x:0 y:60 z:5 count:6 (lava source 6 m, water_bucket, obsidian 4/10)');
	assert.equal(skillFitsLine({ observation: sample({ dimension: OVERWORLD, items: [item('bucket')], blocks: [lava(3, 64, 0)] }), needs: [obsidian] }), null, 'no water bucket');
	assert.equal(skillFitsLine({ observation: sample({ items: kit, blocks: [lava(3, 64, 0)] }), needs: [obsidian] }), null, 'water evaporates in the Nether');
	assert.equal(skillFitsLine({ observation: sample({ dimension: OVERWORLD, items: kit, blocks: [{ ...lava(3, 64, 0), state: { level: '2' } }, lava(30, 64, 0)] }), needs: [obsidian] }), null, 'flowing or too far');
});

test('stale or dead samples show no skill, and the line is the first fitting need in plan order', () => {
	const o = sample({ items: [item('iron_sword')], entities: [mob('blaze', 5), mob('enderman', 6)] });
	assert.match(skillFitsLine({ observation: o, needs: [pearls, rods] }), /mob:minecraft:enderman/);
	assert.match(skillFitsLine({ observation: o, needs: [rods, pearls] }), /mob:minecraft:blaze/);
	assert.equal(skillFitsLine({ observation: { ...o, continuity: { rememberedSections: ['inventory'] } }, needs: [rods] }), null);
	assert.equal(skillFitsLine({ observation: { ...o, player: { dead: true } }, needs: [rods] }), null);
});

const record = () => ({ agentId: 'agent-skill', currentGoal: 'beat the game', currentGoalSpec: null, goalRevision: 1 });
const step = (id, check) => ({ id, label: id, kind: 'inventory', status: 'pending', dependsOn: [], detail: '', evidence: null, check });

test('skill line: plan has-checks and an open Nether entry feed it; it follows goalNow in the encoded wake', async () => {
	const views = new LiveTaskViews(), r = record();
	const nether = sample({ items: [item('iron_sword'), item('blaze_rod', 2)], entities: [mob('blaze', 7)] });
	await views.observe(r, nether);
	await views.operate(r, normalizeMinecraftToolCall('taskPlan', { operation: 'replace', plan: { steps: [step('rods', 'has:minecraft:blaze_rod*6 | has:minecraft:ender_eye*12'), step('pearls', 'has:minecraft:ender_pearl*12')] } }));
	const line = views.skillLine(r);
	assert.equal(line, 'fight_until mob:minecraft:blaze untilItem:minecraft:blaze_rod untilCount:6 (blaze 7 m, iron_sword, rods 2/6)');
	const input = buildNativeEventInput(r, { event: 'observation', trigger: 'attention', observation: nether, goalNow: views.goalLine(r), skillFits: line, continuity: views.continuity(r) });
	const json = encodeNativeEventInput(input, new ModelObservationViews());
	const body = json.slice(json.indexOf('\n') + 1), facts = decodeModelFacts(JSON.parse(body));
	assert.equal(facts.skillFits, line);
	assert.ok(body.indexOf('"goalNow"') < body.indexOf('"skillFits"') && body.indexOf('"skillFits"') < body.indexOf('"observation"'));
	const planning = buildNativeEventInput(r, { event: 'program_planning_due', trigger: 'program_planning_due', observation: nether, skillFits: line });
	assert.equal(JSON.parse(planning.slice(planning.indexOf('\n') + 1)).skillFits, undefined);

	// Overworld: no obsidian check, but an open Nether entry needs a 10-obsidian frame.
	const casting = new LiveTaskViews(), c = record();
	await casting.observe(c, sample({ dimension: OVERWORLD, items: [item('water_bucket'), item('obsidian', 3)], blocks: [lava(2, 64, 0)] }));
	await casting.operate(c, normalizeMinecraftToolCall('taskPlan', { operation: 'replace', plan: { steps: [step('nether', 'in:minecraft:the_nether')] } }));
	assert.equal(casting.skillLine(c), 'cast_obsidian x:2 y:64 z:0 count:7 (lava source 2 m, water_bucket, obsidian 3/10)');
	assert.equal(casting.skillLine({ ...c, currentGoal: '' }), null);
});
