import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { buildNativeEventInput, classifyObservationTrigger, heardLavaNear } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { dangerGlance, yawCompass } from '../src/danger-glance.mjs';

const record = () => ({ agentId: 'agent-goal', currentGoal: 'beat the game', currentGoalSpec: null, goalRevision: 1 });
const operate = (views, r, value) => views.operate(r, normalizeMinecraftToolCall('taskPlan', value));
const step = (id, check, dependsOn = [], status = 'pending') => ({ id, label: id, kind: 'inventory', status, dependsOn, detail: '', evidence: null, check });
const sample = (items, player = {}) => ({ ready: true, observedAtEpochMs: 1_000, world: { worldId: 'w', dimension: 'minecraft:the_nether' },
	player: { dead: false, health: 20, ...player }, inventory: { items } });
const NETHER_PLAN = [
	step('rods', 'has:minecraft:blaze_rod*6 | has:minecraft:ender_eye*12'),
	step('pearls', 'has:minecraft:ender_pearl*12'),
	step('flint', 'has:minecraft:flint_and_steel*1'),
	step('eyes', 'has:minecraft:ender_eye*12', ['rods', 'pearls']),
	step('end', 'visited:minecraft:the_end', ['eyes']),
];

test('goal line: counted needs as have/need from the plan checks, then the step being worked', async () => {
	const views = new LiveTaskViews(), r = record();
	await views.observe(r, sample([{ itemId: 'minecraft:blaze_rod', count: 1 }]));
	await operate(views, r, { operation: 'replace', plan: { steps: NETHER_PLAN } });
	// Either-or checks count their leading item; one-off items stay off unless they are the step worked; no duplicates.
	assert.equal(views.goalLine(r), 'blaze_rod 1/6, ender_pearl 0/12, ender_eye 0/12; next: rods');
	await operate(views, r, { operation: 'intent', intent: { step: 'flint', why: 'light the portal' } });
	assert.equal(views.goalLine(r), 'flint_and_steel 0/1, blaze_rod 1/6, ender_pearl 0/12, ender_eye 0/12; next: flint');
});

test('goal line: a met either-or step drops out, and the line survives a death sample', async () => {
	const views = new LiveTaskViews(), r = record();
	await views.observe(r, sample([{ itemId: 'minecraft:blaze_rod', count: 6 }, { itemId: 'minecraft:ender_pearl', count: 3 }]));
	await operate(views, r, { operation: 'replace', plan: { steps: NETHER_PLAN } });
	assert.equal(views.goalLine(r), 'ender_pearl 3/12, ender_eye 0/12; next: pearls');
	await views.observe(r, { ready: false, observedAtEpochMs: 2_000, world: { worldId: 'w', dimension: 'minecraft:the_nether' }, player: { dead: true } });
	assert.match(views.goalLine(r), /ender_pearl 0\/12/);
	assert.equal(views.goalLine({ ...r, currentGoal: '' }), null);
});

test('goal line leads the encoded wake, ahead of the observation', async () => {
	const views = new LiveTaskViews(), r = record();
	const observation = sample([{ itemId: 'minecraft:blaze_rod', count: 2 }]);
	await views.observe(r, observation);
	await operate(views, r, { operation: 'replace', plan: { steps: NETHER_PLAN } });
	const input = buildNativeEventInput(r, { event: 'observation', trigger: 'attention', observation, goalNow: views.goalLine(r), continuity: views.continuity(r) });
	const encoded = encodeNativeEventInput(input, new ModelObservationViews());
	const facts = decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n') + 1)));
	assert.equal(facts.goalNow, 'blaze_rod 2/6, ender_pearl 0/12, ender_eye 0/12; next: rods');
	const json = encoded.slice(encoded.indexOf('\n') + 1);
	assert.ok(json.indexOf('"goalNow"') < json.indexOf('"observation"'), 'goal counts come before the observation');
});

test('danger line: bridge width, drops with depth and bottom, lava a step away, threats targeting, hit from behind', () => {
	const player = {
		edges: { width: 3, drops: [{ dir: 'E', at: 1, drop: 18, into: 'lava' }, { dir: 'W', at: 1, drop: 18, into: 'lava' }, { dir: 'S', at: 0, drop: 30, atLeast: true }], lava: { dir: 'NE', at: 2, dy: -2 } },
		threats: [
			{ type: 'minecraft:blaze', distance: 6.4, targeting: true, visible: true },
			{ type: 'minecraft:wither_skeleton', distance: 2.2, targeting: true, visible: true },
			{ type: 'minecraft:ghast', distance: 30, targeting: true, visible: false },
			{ type: 'minecraft:zombified_piglin', distance: 4, targeting: false, visible: true },
		],
		recentDamage: { cause: 'mob_attack', direction: 'back_left', secondsAgo: 0 },
	};
	assert.equal(dangerGlance(player), 'hit from back-left; floor 3 wide; drops E 18 to lava (1 cell out), W 18 to lava (1 cell out), S 30+; lava NE 2 away below; 2 targeting you: wither_skeleton 2m, blaze 6m');
	// A hit from the front is in view already; nothing around the body is no line.
	assert.equal(dangerGlance({ recentDamage: { direction: 'front' } }), null);
	assert.equal(dangerGlance({ dead: true, edges: player.edges }), null);
	assert.equal(dangerGlance({ edges: { drops: [{ dir: 'N', at: 0, drop: 60, into: 'void' }] } }), 'drops N void');
});

test('danger line falls back to the brink, then the footing drop, for bodies without the side glance', () => {
	assert.equal(dangerGlance({ brink: { dir: 'W', at: 0.35, below: 'lava', drop: 27 } }), 'drop W 27 to lava 0.35m away');
	assert.equal(dangerGlance({ footing: { drop: 20, yaw: 45, distance: 1.8 } }), 'drop SW 20 1.8m away');
	assert.equal(dangerGlance({ footing: { drop: 23, into: 'lava', yaw: -90 } }), 'drop E 23 to lava beside you');
	// A short step is no drop.
	assert.equal(dangerGlance({ footing: { drop: 2, yaw: 0 } }), null);
	assert.deepEqual([0, 90, 180, -90, -135].map(yawCompass), ['S', 'W', 'N', 'E', 'NE']);
});

test('danger line leads the wake and the raw side glance is not repeated in the player facts', () => {
	const observation = sample([], { edges: { width: 1, drops: [{ dir: 'E', at: 0, drop: 12, into: 'lava' }, { dir: 'W', at: 0, drop: 12, into: 'lava' }] } });
	const input = buildNativeEventInput(record(), { event: 'observation', trigger: 'attention', observation });
	const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
	assert.equal(payload.danger, 'floor 1 wide; drops E 12 to lava, W 12 to lava');
	assert.equal(payload.observation.player.edges, undefined);
	const keys = Object.keys(payload);
	assert.ok(keys.indexOf('danger') < keys.indexOf('observation'));
	// Program planning wakes carry neither line.
	const planning = buildNativeEventInput(record(), { event: 'program_planning_due', trigger: 'program_planning_due', observation, goalNow: 'x 0/2' });
	const planned = JSON.parse(planning.slice(planning.indexOf('\n') + 1));
	assert.equal(planned.danger, undefined);
	assert.equal(planned.goalNow, undefined);
});

test('lava heard nearby wakes the model once as lava_heard; far lava and a hit from behind keep their own wakes', () => {
	const near = { player: { health: 20 }, heard: [{ sound: 'minecraft:block.lava.pop', direction: 'left', elevation: 'below', distance: 9 }] };
	const far = { player: { health: 20 }, heard: [{ sound: 'minecraft:block.lava.ambient', direction: 'left', elevation: 'level', distance: 24 }] };
	assert.equal(heardLavaNear(near), true);
	assert.equal(heardLavaNear(far), false);
	assert.deepEqual(classifyObservationTrigger({ attention: true, changedFacts: ['heard'] }, near), { attention: true, priority: 'ordinary', trigger: 'lava_heard' });
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['heard'] }, far).trigger, 'attention');
	// Felt, not seen: a hit from behind is a health drop and wakes urgently as damage; the danger line names its side.
	const hit = { player: { health: 15, recentDamage: { cause: 'mob_attack', direction: 'back' } } };
	assert.deepEqual(classifyObservationTrigger({ attention: true, changedFacts: ['player.health'] }, hit, { previousPlayer: { health: 20 } }), { attention: true, priority: 'urgent', trigger: 'damage' });
	assert.equal(dangerGlance(hit.player), 'hit from back');
});
