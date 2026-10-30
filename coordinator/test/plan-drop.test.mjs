import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTaskViews, validateTaskPlan } from '../src/live-task-view.mjs';
import { evaluatePlanCheck, emptyKnown } from '../src/plan-checks.mjs';
import { buildGoalSpecTranslatorPrompt, GoalSpecTranslator } from '../src/goal-spec-translator.mjs';

const requestId = '9a0cb875-61fd-429d-a227-019367f24369';
const logIds = ['acacia', 'birch', 'cherry', 'dark_oak', 'jungle', 'mangrove', 'oak', 'pale_oak', 'spruce'].flatMap(wood => [`minecraft:${wood}_log`, `minecraft:stripped_${wood}_log`]);
const LOG_TAGS = ['#c:natural_logs', '#minecraft:logs', '#minecraft:logs_that_burn', '#minecraft:oak_logs'];
const step = (id, label, kind, check, dependsOn = [], evidence = null) => ({ id, label, kind, status: 'pending', dependsOn, detail: '', check, evidence });
// Recorded translator output, benchmark final-3 arm B S5-r1 (the same plan shape in all 8 runs).
const recordedS5 = {
 requestId, summary: 'Find nearest trees; punch and collect logs from them until holding 10 logs of any type; pick up dropped logs.',
 predicate: { type: 'inventory_contains_any', itemIds: logIds, count: 10 },
 plan: { steps: [
  { id: 'find_trees', label: 'Locate nearby trees', kind: 'world', status: 'pending', dependsOn: [], detail: 'Explore the overworld to find a cluster of trees.', check: null, evidence: null },
  { id: 'collect_logs', label: 'Collect 10 logs', kind: 'inventory', status: 'pending', dependsOn: ['find_trees'], detail: 'Break tree trunks and pick up the drops until holding 10 logs of any type.', check: 'has:minecraft:oak_log|minecraft:birch_log|minecraft:spruce_log|minecraft:jungle_log|minecraft:acacia_log|minecraft:dark_oak_log|minecraft:mangrove_log|minecraft:cherry_log*10', evidence: null },
 ] },
};
const translate = async (output, traces = []) => new GoalSpecTranslator({ trace: (...args) => traces.push(args), generate: async () => structuredClone(output) })
 .translate({ requestId, originalRequest: 'gather 10 logs', candidateIds: logIds });
const obs = (dimension, items, extra = {}) => ({ ready: true, observedAtEpochMs: 1000, player: { dead: false, health: 20, x: 0, y: 64, z: 0 }, world: { worldId: 'drop-world', dimension: `minecraft:${dimension}` }, inventory: { items }, blocks: [], items: [], entities: [], sighted: { structures: [] }, ...extra });
const held = (id, count, tags = []) => ({ itemId: `minecraft:${id}`, count, slot: 1, tags });

test('recorded S5 translator plan survives: one invalid step degrades instead of dropping the plan', async () => {
 const traces = [];
 const result = await translate(recordedS5, traces);
 assert.ok(result.plan, 'advisory plan kept');
 assert.deepEqual(result.plan.steps.map(s => [s.id, s.kind, s.check, s.dependsOn]), [['find_trees', 'manual', null, []], ['collect_logs', 'manual', null, ['find_trees']]]);
 assert.deepEqual(traces.map(t => [t[0], t[1].stepId]), [['goal_plan_step_degraded', 'find_trees'], ['goal_plan_check_invalid', 'collect_logs'], ['goal_plan_step_degraded', 'collect_logs']]);
 assert.match(traces[0][1].reason, /World steps require/);
 assert.ok(!traces.some(t => t[0] === 'goal_plan_invalid'));
});

test('unusable steps are dropped alone and references to them are removed', async () => {
 const output = structuredClone(recordedS5);
 output.plan.steps[1].check = 'has:#minecraft:logs*10';
 output.plan.steps.unshift({ ...output.plan.steps[0], id: 'bad id!' }, 'not a step');
 output.plan.steps.push(step('craft', 'Craft planks', 'inventory', 'has:#minecraft:planks*4', ['collect_logs', 'bad id!', 'ghost']));
 output.plan.steps.push({ ...step('dup', 'Dup', 'manual', null), evidence: { itemIds: ['NOT AN ID'], count: 1, dimension: null, x: null, y: null, z: null, blockId: null } });
 const traces = [];
 const result = await translate(output, traces);
 assert.deepEqual(result.plan.steps.map(s => s.id), ['find_trees', 'collect_logs', 'craft', 'dup']);
 assert.deepEqual(result.plan.steps[2].dependsOn, ['collect_logs']);
 assert.equal(result.plan.steps[3].evidence, null);
 assert.equal(traces.filter(t => t[0] === 'goal_plan_step_dropped').length, 2);
});

test('item tag checks use observed tagCounts and reject overlapping alternatives', () => {
 assert.equal(validateTaskPlan({ steps: [step('logs', 'Logs', 'inventory', 'has:#minecraft:logs*10')] }).steps[0].check, 'has:#minecraft:logs*10');
 assert.throws(() => validateTaskPlan({ steps: [step('wool', 'Wool', 'inventory', 'has:#minecraft:wool|minecraft:string*3')] }), /stands alone/);
 assert.throws(() => validateTaskPlan({ steps: [step('x', 'X', 'inventory', 'has:#logs*10')] }), /unsupported term/);
 const o = obs('overworld', [held('oak_log', 6, LOG_TAGS), held('birch_log', 3, ['#minecraft:logs']), held('dirt', 9)]);
 o.inventory.tagCounts = { '#minecraft:logs': 9 };
 assert.deepEqual([evaluatePlanCheck('has:#minecraft:logs*10', o, emptyKnown()).ok, evaluatePlanCheck('has:#minecraft:logs*10', o, emptyKnown()).reason], [false, '#logs 9/10']);
 assert.throws(() => evaluatePlanCheck('has:#minecraft:logs|minecraft:oak_log*10', o, emptyKnown()), /stands alone/);
 o.inventory.items.push(held('stripped_spruce_log', 1, ['#minecraft:logs']));
 o.inventory.tagCounts['#minecraft:logs'] = 10;
 assert.equal(evaluatePlanCheck('has:#minecraft:logs*10', o, emptyKnown()).ok, true);
});

test('translator prompt offers the tag form and the tool schema stays within its byte budget', async () => {
 const prompt = buildGoalSpecTranslatorPrompt({ requestId, originalRequest: 'gather 10 logs', candidateIds: logIds });
 assert.match(prompt, /has:#minecraft:logs\*1/);
 assert.match(prompt, /Preserve quantities explicitly requested by the user/);
 const { TASK_PLAN_SCHEMA } = await import('../src/live-task-view.mjs');
 // +36 B: the stage check terms (y<=N, lava:N, frame:N, crystals<=N) in the check description; +11 B: spawn:bed.
 assert.ok(Buffer.byteLength(JSON.stringify(TASK_PLAN_SCHEMA)) <= 1428);
 assert.match(TASK_PLAN_SCHEMA.properties.steps.items.properties.check.description, /#tag/);
});

// Recorded saved plan shape, benchmark final-3 arm B S1-deltas-r7 (same in 6 B plans).
const respawnPlan = { steps: [
 step('blaze_rods', 'Blaze rods', 'inventory', 'has:minecraft:blaze_rod*7 | has:minecraft:blaze_powder*14 | has:minecraft:ender_eye*12'),
 step('ender_pearls', 'Ender pearls', 'inventory', 'has:minecraft:ender_pearl*12 | has:minecraft:ender_eye*12'),
 step('eyes', 'Eyes of ender', 'inventory', 'has:minecraft:ender_eye*12', ['blaze_rods', 'ender_pearls']),
 step('overworld', 'Return to the Overworld', 'world', 'in:minecraft:overworld', ['eyes']),
 step('stronghold', 'Find a stronghold', 'world', 'seen:minecraft:stronghold', ['overworld']),
 step('portal', 'Enter the End', 'world', 'visited:minecraft:the_end', ['stronghold']),
 step('dragon', 'Kill the dragon', 'milestone', 'killed:minecraft:ender_dragon', ['portal']),
] };
const record = { agentId: 'drop-fixture', currentGoal: 'beat the game', goalRevision: 1 };
const status = views => Object.fromEntries(views.snapshot(record).plan.steps.map(s => [s.id, s.status]));

test('respawning or starting in the Overworld is not progress past missing eyes', async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, record.currentGoal, respawnPlan);
 await views.observe(record, obs('the_nether', []));
 await views.observe(record, { ready: false, player: { dead: true } });
 await views.observe(record, obs('overworld', []));
 assert.equal(status(views).overworld, 'pending');
 const line = views.progress(record);
 assert.match(line, /^open blaze_rods\[/); assert.match(line, /early overworld\[before eyes\]/);
 assert.doesNotMatch(line, /open stronghold|skipped/);
 const fresh = new LiveTaskViews(); fresh.suggest(record.agentId, record.currentGoal, respawnPlan);
 await fresh.observe(record, obs('overworld', []));
 assert.equal(status(fresh).overworld, 'pending'); assert.doesNotMatch(fresh.progress(record), /open stronghold/);
});

test('presence completes once prerequisites hold, and death clears it', async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, record.currentGoal, respawnPlan);
 await views.observe(record, obs('overworld', [held('ender_eye', 12)]));
 assert.equal(status(views).overworld, 'complete'); assert.match(views.progress(record), /open stronghold/);
 await views.observe(record, { ready: false, player: { dead: true } });
 assert.equal(status(views).overworld, 'lost');
 await views.observe(record, obs('overworld', []));
 assert.notEqual(status(views).overworld, 'complete'); assert.doesNotMatch(views.progress(record), /open stronghold/);
});

test('possession still proves consumed prerequisites out of order', async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, record.currentGoal, respawnPlan);
 await views.observe(record, obs('overworld', [held('ender_eye', 12)]));
 assert.deepEqual([status(views).blaze_rods, status(views).eyes], ['complete', 'complete']);
 await views.observe(record, obs('overworld', [held('ender_eye', 2)], { sighted: { structures: [{ structure: 'stronghold', x: 10, z: 10 }] } }));
 assert.equal(status(views).stronghold, 'complete');
 assert.match(views.progress(record), /open portal/);
});
