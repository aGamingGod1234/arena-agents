import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	DEFAULT_CAPTURE_OPTIONS, MomentCapture, canonicalJson, detectObservationTriggers, observationSha256, openPlanStep, providerTurnPayload, rawObservation,
} from '../src/decision-eval/capture.mjs';
import { captureTrace, findTraceDirs, readRecordedPlan } from '../../scripts/decision-eval/capture.mjs';

const AGENT = '5d7bfaa2-963c-4f23-b08f-0c34727bc67d';

function observation(at, overrides = {}) {
	const { player = {}, world = {}, ...rest } = overrides;
	return {
		goalRevision: 1, observedAtEpochMs: at, ready: true, status: 'ACTING', position: { x: 0, y: 64, z: 0 },
		player: { health: 20, maxHealth: 20, foodLevel: 20, air: 300, maxAir: 300, inLava: false, onFire: false, underWater: false, fallDistance: 0, skyOpen: true, ...player },
		inventory: { items: [] }, entities: [], blocks: [],
		world: { dimension: 'minecraft:overworld', dayTime: 3000, ...world },
		...rest,
	};
}

const row = (type, payload, direction = 'server_to_coordinator', messageId = `m-${type}`) => ({
	runId: 'run-1', scenarioId: 'scenario-1', direction, envelope: { protocolVersion: 2, agentId: AGENT, type, messageId, payload }, observedAtMs: payload.observedAtEpochMs ?? 0,
});
const start = (goal = 'make a wooden pickaxe') => row('goal_control', { operation: 'start', goalRevision: 1, goal, goalSpec: { originalRequest: goal } });

test('edge triggers fire on entry into each condition', () => {
	const calm = observation(1000);
	const cases = [
		['damage', { player: { health: 15 } }],
		['low_health', { player: { health: 6 } }],
		['low_food', { player: { foodLevel: 5 } }],
		['hazard_lava', { player: { inLava: true, onFire: true } }],
		['hazard_lava', { blocks: [{ x: 1, y: 64, z: 0, blockId: 'minecraft:lava' }] }],
		['hazard_fire', { player: { onFire: true } }],
		['hazard_drowning', { player: { underWater: true, air: 90 } }],
		['hazard_fall', { player: { fallDistance: 6 } }],
		['hostile_near', { entities: [{ type: 'minecraft:creeper', hostile: true, distance: 6, uuid: 'c' }] }],
		['night_falling', { world: { dayTime: 12_100 } }],
	];
	for (const [trigger, overrides] of cases) {
		const fired = detectObservationTriggers(calm, observation(2000, overrides)).map((e) => e.trigger);
		assert.ok(fired.includes(trigger), `${trigger} from ${JSON.stringify(overrides)} fired ${fired}`);
	}
	// Staying in a condition does not fire again.
	const low = observation(2000, { player: { health: 6 } });
	assert.deepEqual(detectObservationTriggers(low, observation(3000, { player: { health: 6 } })).map((e) => e.trigger), []);
	// Distant or passive mobs do not count; creepers count within their own radius.
	assert.deepEqual(detectObservationTriggers(calm, observation(2000, { entities: [{ type: 'minecraft:zombie', hostile: true, distance: 20 }] })), []);
	assert.deepEqual(detectObservationTriggers(calm, observation(2000, { entities: [{ type: 'minecraft:cow', hostile: false, distance: 2 }] })), []);
	assert.equal(detectObservationTriggers(calm, observation(2000, { entities: [{ type: 'minecraft:skeleton', distance: 5 }] }))[0].trigger, 'hostile_near', 'type fallback without the hostile flag');
	// Dead bodies never trigger.
	assert.deepEqual(detectObservationTriggers(calm, observation(2000, { player: { health: 0 } })), []);
});

test('progression triggers fire on a new milestone item, a new structure block in sight and a dimension change', () => {
	const calm = observation(1000, { inventory: { items: [{ itemId: 'minecraft:oak_log', count: 3, slot: 0 }] } });
	const fired = (overrides) => detectObservationTriggers(calm, observation(2000, overrides)).map((e) => e.key);
	assert.deepEqual(fired({ inventory: { items: [{ itemId: 'minecraft:oak_log', count: 3, slot: 0 }, { itemId: 'minecraft:iron_ingot', count: 1, slot: 1 }] } }), ['milestone_gained:iron_ingot']);
	// More of a milestone already carried is not a new milestone; losing one is not either.
	assert.deepEqual(fired({ inventory: { items: [{ itemId: 'minecraft:birch_log', count: 9, slot: 0 }] } }), []);
	assert.deepEqual(fired({ inventory: { items: [] } }), []);
	const fortress = { blocks: [{ x: 10, y: 64, z: 0, blockId: 'minecraft:nether_bricks' }], inventory: calm.inventory };
	const seen = detectObservationTriggers(calm, observation(2000, fortress));
	assert.deepEqual(seen.map((e) => e.trigger), ['structure_seen']);
	assert.deepEqual(seen[0].detail, { blockId: 'minecraft:nether_bricks', distance: 10.5 });
	assert.deepEqual(detectObservationTriggers(observation(2000, fortress), observation(3000, fortress)), [], 'still in sight is not new');
	assert.deepEqual(fired({ world: { dimension: 'minecraft:the_nether' }, inventory: calm.inventory }), ['dimension_change:minecraft:the_nether']);
	// A neutral enderman is a progression mob (pearls); a far one is not in reach of a decision yet.
	assert.deepEqual(fired({ entities: [{ type: 'minecraft:enderman', hostile: false, distance: 20, uuid: 'e' }], inventory: calm.inventory }), ['progression_mob_seen:minecraft:enderman']);
	assert.deepEqual(fired({ entities: [{ type: 'minecraft:enderman', hostile: false, distance: 60, uuid: 'e' }], inventory: calm.inventory }), []);
	// The dragon seen landing on the exit fountain; still perched is the same landing.
	const dragon = (motion) => ({ type: 'minecraft:ender_dragon', perceivedBy: 'sight', distance: 14.2, health: 166, appearance: { motion } });
	const flying = observation(1000, { entities: [dragon('flying')], inventory: calm.inventory });
	const landed = observation(2000, { entities: [dragon('perched'), { ...dragon('perched'), partName: 'head' }], inventory: calm.inventory });
	assert.deepEqual(detectObservationTriggers(flying, landed).map((e) => [e.key, e.detail]), [['dragon_perched', { distance: 14.2, health: 166 }]]);
	assert.deepEqual(detectObservationTriggers(landed, observation(3000, { entities: [dragon('perched')], inventory: calm.inventory })), []);
	// The first observation of a life states what was already there: nothing new.
	assert.deepEqual(detectObservationTriggers(null, observation(2000, fortress)), []);
	assert.deepEqual(detectObservationTriggers(null, landed), []);
	assert.deepEqual(detectObservationTriggers(observation(1000, { player: { health: 0 } }), observation(2000, fortress)), []);
});

test('a milestone gained during a running action is captured on the first observation with no running action', () => {
	const capture = new MomentCapture({ trace: 'runs/progress' });
	const ingot = { items: [{ itemId: 'minecraft:iron_ingot', count: 3, slot: 1 }] };
	capture.ingest(start('beat the game'), 1);
	capture.ingest(row('observation', observation(1000)), 2);
	capture.ingest(row('observation', observation(2000, { inventory: ingot, currentAction: { active: true, actionType: 'furnace_transaction' } })), 3);
	assert.deepEqual(capture.moments.map((m) => m.trigger), []);
	capture.ingest(row('observation', observation(3000, { inventory: ingot, currentAction: { active: false, actionType: 'furnace_transaction' } })), 4);
	assert.deepEqual(capture.moments.map((m) => [m.trigger, m.detail.milestone, m.source.line]), [['milestone_gained', 'iron_ingot', 4]]);
});

test('a milestone consumed or lost before the idle moment is not captured; one still carried is', () => {
	const capture = new MomentCapture({ trace: 'runs/consumed' });
	const busy = { active: true, actionType: 'craft_table' };
	capture.ingest(start('beat the game'), 1);
	capture.ingest(row('observation', observation(1000)), 2);
	// Three ingots appear mid-craft, then the bucket made from them: at idle only the bucket is carried.
	capture.ingest(row('observation', observation(2000, { inventory: { items: [{ itemId: 'minecraft:iron_ingot', count: 3, slot: 1 }] }, currentAction: busy })), 3);
	capture.ingest(row('observation', observation(3000, { inventory: { items: [{ itemId: 'minecraft:bucket', count: 1, slot: 1 }] }, currentAction: busy })), 4);
	capture.ingest(row('observation', observation(4000, { inventory: { items: [{ itemId: 'minecraft:bucket', count: 1, slot: 1 }] }, currentAction: { active: false } })), 5);
	assert.deepEqual(capture.moments.map((m) => m.detail.milestone), ['bucket']);
	// A stack dropped before the action ends is not a milestone either.
	const lost = new MomentCapture({ trace: 'runs/lost' });
	lost.ingest(start('beat the game'), 1);
	lost.ingest(row('observation', observation(1000)), 2);
	lost.ingest(row('observation', observation(2000, { inventory: { items: [{ itemId: 'minecraft:obsidian', count: 4, slot: 2 }] }, currentAction: busy })), 3);
	lost.ingest(row('observation', observation(3000, { currentAction: { active: false } })), 4);
	assert.deepEqual(lost.moments.map((m) => m.trigger), []);
	// Death before idle clears the pending gain; the respawn moment is not a milestone.
	const died = new MomentCapture({ trace: 'runs/died' });
	died.ingest(start('beat the game'), 1);
	died.ingest(row('observation', observation(1000)), 2);
	died.ingest(row('observation', observation(2000, { inventory: { items: [{ itemId: 'minecraft:iron_ingot', count: 3, slot: 1 }] }, currentAction: busy })), 3);
	died.ingest(row('goal_control', { operation: 'dead', goalRevision: 1 }), 4);
	died.ingest(row('observation', observation(5000, { inventory: { items: [{ itemId: 'minecraft:iron_ingot', count: 3, slot: 1 }] }, currentAction: { active: false } })), 5);
	assert.ok(!died.moments.some((m) => m.trigger === 'milestone_gained'));
	// Two genuine gains in one action both stay, on the same observation (one source moment).
	const both = new MomentCapture({ trace: 'runs/both' });
	both.ingest(start('beat the game'), 1);
	both.ingest(row('observation', observation(1000)), 2);
	const gained = { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1, slot: 1 }, { itemId: 'minecraft:shield', count: 1, slot: 2 }] };
	both.ingest(row('observation', observation(2000, { inventory: gained, currentAction: busy })), 3);
	both.ingest(row('observation', observation(3000, { inventory: gained, currentAction: { active: false } })), 4);
	assert.deepEqual(both.moments.map((m) => [m.detail.milestone, m.source.line]).sort(), [['iron_pickaxe', 4], ['shield', 4]]);
});

test('inventory full counts the 36 main slots only', () => {
	const items = Array.from({ length: 36 }, (_, slot) => ({ itemId: 'minecraft:cobblestone', count: 64, slot }));
	const full = observation(2000, { inventory: { items: [...items, { itemId: 'minecraft:iron_helmet', count: 1, slot: 'head' }] } });
	assert.ok(detectObservationTriggers(observation(1000), full).some((e) => e.trigger === 'inventory_full'));
	const almost = observation(2000, { inventory: { items: items.slice(1) } });
	assert.ok(!detectObservationTriggers(observation(1000), almost).some((e) => e.trigger === 'inventory_full'));
	// The production collector emits the selected slot as 'mainhand' instead of its index.
	const held = observation(2000, { inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 'mainhand' }, ...items.slice(1)] } });
	assert.ok(detectObservationTriggers(observation(1000), held).some((e) => e.trigger === 'inventory_full'));
});

test('plan progress and provider turn parsing', () => {
	assert.equal(openPlanStep('open wood[unmet:#logs 0/8]; later:6'), 'wood');
	assert.equal(openPlanStep('open eyes[unmet:ender_eye 0/12]; done stone_tool,iron_gear; later:3'), 'eyes');
	assert.equal(openPlanStep('no plan'), null);
	assert.deepEqual(providerTurnPayload({ input: 'Update. {"format":"minecraft-facts-v1","data":{"goal":"x"}}' }), { goal: 'x' });
	assert.equal(providerTurnPayload({ input: 'no json' }), null);
});

test('raw observations drop the goal revision and hash canonically', () => {
	const raw = rawObservation(observation(1000));
	assert.equal('goalRevision' in raw, false);
	assert.equal(observationSha256({ b: 1, a: [2, { d: 3, c: 4 }] }), observationSha256({ a: [2, { c: 4, d: 3 }], b: 1 }));
	assert.equal(canonicalJson({ b: 1, a: null }), '{"a":null,"b":1}');
});

test('capture pairs failed results with their command, dedupes, and records provenance', () => {
	const capture = new MomentCapture({ trace: 'notes/run/A' });
	let line = 0;
	const feed = (r) => capture.ingest(r, ++line);
	feed(observation(500)); // not a protocol row: ignored
	feed(row('observation', observation(900)));  // before any goal: no moment
	feed(start());
	feed(row('observation', observation(1000)));
	feed(row('action_command', { actionId: 'a1', actionType: 'navigate_to', arguments: { x: 9, y: 64, z: 9 } }, 'coordinator_to_server'));
	feed(row('action_result', { actionId: 'a1', actionType: 'navigate_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'No path' }));
	feed(row('observation', observation(2000, { lastResult: { actionId: 'a1', state: 'FAILED', reasonCode: 'NO_PATH' } })));
	const failure = capture.moments.find((m) => m.trigger === 'failed_action');
	assert.ok(failure);
	assert.equal(failure.detail.reasonCode, 'NO_PATH');
	assert.deepEqual(failure.state.agent.recentResults.at(-1).args, { x: 9, y: 64, z: 9 });
	assert.equal(failure.state.agent.goal, 'make a wooden pickaxe');
	assert.equal(failure.source.trace, 'notes/run/A');
	assert.equal(failure.source.line, 7);
	assert.equal(failure.source.runId, 'run-1');
	assert.equal(failure.source.observationSha256, observationSha256(failure.state.observation));
	assert.equal(failure.state.observation.goalRevision, undefined);
	assert.equal(failure.state.previousObservations.length, DEFAULT_CAPTURE_OPTIONS.previousObservations);
	assert.equal(failure.state.previousObservations.at(-1).observedAtEpochMs, 1000);

	// Repeated hits within the cooldown fold into the first moment.
	feed(row('observation', observation(3000, { player: { health: 18 } })));
	feed(row('observation', observation(4000, { player: { health: 16 } })));
	feed(row('observation', observation(4000 + DEFAULT_CAPTURE_OPTIONS.cooldownMs, { player: { health: 14 } })));
	assert.equal(capture.moments.filter((m) => m.trigger === 'damage').length, 2);
	assert.ok(capture.stats.suppressed >= 1);
});

test('death clears the life and the first live observation after it is a respawn moment', () => {
	const capture = new MomentCapture({ trace: 't' });
	capture.ingest(start('beat the game'));
	capture.ingest(row('observation', observation(1000, { player: { health: 4 } })));
	capture.ingest(row('goal_control', { operation: 'dead', goalRevision: 1, death: { cause: 'blown up by Creeper' } }));
	capture.ingest(row('observation', observation(2000, { player: { health: 0 }, ready: false })));
	capture.ingest(row('observation', observation(3000)));
	const respawn = capture.moments.find((m) => m.trigger === 'respawn');
	assert.ok(respawn);
	assert.equal(respawn.state.previousObservations.every((o) => o.observedAtEpochMs >= 2000), true, 'no observation from the previous life');
	assert.equal(capture.stats.deaths, 1);
});

test('provider turns supply goal, task memory and plan step changes by time', () => {
	const turn = (timestamp, data) => ({ timestamp, agentId: AGENT, executionSettings: { controlProtocol: 'native_tools' }, input: `Update. ${JSON.stringify({ format: 'minecraft-facts-v1', data })}` });
	const capture = new MomentCapture({ trace: 't', turns: [
		turn(900, { goal: 'Beat the game', progress: 'open iron_gear[unmet:armor 0/1 iron+]; later:4', taskMemory: { lessons: [] } }),
		turn(1500, { progress: 'open eyes[unmet:ender_eye 0/12]; done iron_gear; later:3' }),
	] });
	capture.ingest(row('observation', observation(1000)));
	capture.ingest(row('observation', observation(2000)));
	const change = capture.moments.find((m) => m.trigger === 'plan_step_change');
	assert.deepEqual([change.detail.from, change.detail.to], ['iron_gear', 'eyes']);
	assert.equal(change.state.agent.goal, 'Beat the game');
	assert.deepEqual(change.state.agent.taskMemory, { lessons: [] });
});

test('no progress fires once per stall', () => {
	const capture = new MomentCapture({ trace: 't' });
	capture.ingest(start());
	for (let at = 0; at <= 200_000; at += 10_000) capture.ingest(row('observation', observation(1000 + at)));
	assert.equal(capture.moments.filter((m) => m.trigger === 'no_progress').length, 1);
});

test('CLI finds trace folders, reads the recorded plan and captures with relative provenance', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'de-capture-'));
	const dir = path.join(root, 'runs', 'A');
	fs.mkdirSync(path.join(dir, 'player-memory', 'plans'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'protocol.jsonl'), 'ignored subset\n');
	const rows = [start(), row('observation', observation(1000)), row('observation', observation(2000, { player: { health: 12 } }))];
	fs.writeFileSync(path.join(dir, 'quality-protocol.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
	fs.writeFileSync(path.join(dir, 'player-memory', 'plans', 'p.json'), JSON.stringify({ revision: 3, plan: { steps: [
		{ id: 'wood', label: 'Logs', kind: 'inventory', status: 'complete', dependsOn: [], detail: '', evidence: null, check: 'has:#minecraft:logs*4' },
		{ id: 'win', label: 'Win', kind: 'manual', status: 'pending', dependsOn: ['wood'], detail: '', evidence: null, check: null },
	] } }));
	fs.writeFileSync(path.join(root, 'runs', 'live-kill-protocol.jsonl'), '');
	try {
		const traces = findTraceDirs(root);
		assert.deepEqual(traces.map((t) => path.basename(t.protocol)).sort(), ['live-kill-protocol.jsonl', 'quality-protocol.jsonl']);
		const plan = readRecordedPlan(dir);
		assert.deepEqual(plan.steps.map((s) => s.status), ['pending', 'pending'], 'checked steps restart pending');
		const { trace, moments } = await captureTrace(traces.find((t) => t.protocol.endsWith('quality-protocol.jsonl')), { root });
		assert.equal(trace, 'runs/A');
		const damage = moments.find((m) => m.trigger === 'damage');
		assert.equal(damage.source.line, 3);
		assert.equal(damage.source.protocolFile, 'quality-protocol.jsonl');
		assert.equal(damage.state.agent.taskPlan.steps.length, 2);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a hostile still near right after a successful flee is a threat-after-escape moment', () => {
	const capture = new MomentCapture({ trace: 't' });
	const creeper = [{ type: 'minecraft:creeper', hostile: true, distance: 9, uuid: 'c' }];
	capture.ingest(start());
	capture.ingest(row('observation', observation(1000, { entities: creeper })));
	capture.ingest(row('action_command', { actionId: 'f1', actionType: 'flee_from', arguments: { targetId: 'c', distance: 12 } }, 'coordinator_to_server'));
	capture.ingest(row('action_result', { actionId: 'f1', actionType: 'flee_from', state: 'SUCCEEDED', reasonCode: 'FLEE_COMPLETED', observedAtEpochMs: 5000 }));
	capture.ingest(row('observation', observation(6000, { entities: creeper })));
	const moment = capture.moments.find((m) => m.trigger === 'threat_after_escape');
	assert.equal(moment.detail.type, 'minecraft:creeper');
	assert.equal(moment.detail.sinceEscapeMs, 1000);
	// Outside the window it does not fire.
	capture.ingest(row('action_result', { actionId: 'f2', actionType: 'flee_from', state: 'SUCCEEDED', observedAtEpochMs: 7000 }));
	capture.ingest(row('observation', observation(7000 + DEFAULT_CAPTURE_OPTIONS.escapeWindowMs + 1, { entities: creeper })));
	assert.equal(capture.moments.filter((m) => m.trigger === 'threat_after_escape').length, 1);
});

test('the same open plan step for minutes is a stalled-step moment, repeated per stall window', () => {
	const turn = { timestamp: 500, agentId: AGENT, executionSettings: { controlProtocol: 'native_tools' }, input: `U ${JSON.stringify({ data: { goal: 'beat the game', progress: 'open iron_gear[unmet:armor 0/1 iron+]; later:4' } })}` };
	const capture = new MomentCapture({ trace: 't', turns: [turn] });
	for (let at = 1000; at <= 1000 + 2 * DEFAULT_CAPTURE_OPTIONS.planStallMs; at += 20_000) capture.ingest(row('observation', observation(at, { position: { x: at / 1000, y: 64, z: 0 } })));
	const stalls = capture.moments.filter((m) => m.trigger === 'plan_step_stalled');
	assert.equal(stalls.length, 2);
	assert.equal(stalls[0].detail.step, 'iron_gear');
});
