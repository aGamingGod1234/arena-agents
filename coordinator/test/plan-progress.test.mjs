import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveTaskViews, validateTaskPlan, TASK_PLAN_SCHEMA } from '../src/live-task-view.mjs';
import { evaluatePlanCheck, emptyKnown, planProgress, rememberPlanFacts } from '../src/plan-checks.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { ModelObservationViews, decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { buildGoalSpecTranslatorPrompt, GoalSpecTranslator } from '../src/goal-spec-translator.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { record, plan, scenarios, armor, item } from './fixtures/progress/scenarios.mjs';
const checked = check => ({ steps: [{ ...plan.steps[0], check }] });
const sample = () => structuredClone(scenarios[0].observation);
const expected = [
 "open gear[unmet:armor 0/4 iron+, pickaxe missing iron+; diamond_helmet|diamond_chestplate|diamond_leggings|diamond_boots carried, not worn, iron_pickaxe 0/1 @crafting_table missing<-(iron_ingot 0/3 @furnace missing fuel none<-raw_iron 0/3 mine iron_ore needs stone_pickaxe+ y-24..56~16,80..319~232 + stick 0/4 (@inventory<-#planks 0/2 or @inventory<-bamboo 0/8 mine bamboo)), stone_pickaxe 0/1 @crafting_table...]; early nether[before gear]; strategy:tools; later:7",
 "open gear[unmet:armor 0/4 iron+, pickaxe missing iron+; crafting option: iron_ingot 0/27 @furnace missing fuel none<-raw_iron 0/27 mine iron_ore y-24..56~16,80..319~232, iron_pickaxe 0/1 @crafting_table missing<-(iron_ingot + stick 0/2 (@inventory<-#planks 0/2 or @inventory<-bamboo 0/4 mine bamboo))]; strategy:tools; later:8",
 "open gear[unmet:armor 0/4 iron+, pickaxe missing iron+; crafting option: iron_ingot 0/27 @furnace missing fuel none<-raw_iron 0/27 mine iron_ore needs stone_pickaxe+ y-24..56~16,80..319~232, iron_pickaxe 0/1 @crafting_table missing<-(iron_ingot + stick 0/4 (@inventory<-#planks 0/2 or @inventory<-bamboo 0/8 mine bamboo)), stone_pickaxe 0/1 @crafting_table missing<-(#stone_tool_materials 0/3 deepslate|stone...]; strategy:tools; later:8",
 "open stronghold[unmet:seen stronghold]; done gear,eyes; strategy:end; skipped nether,rods,pearls via eyes; later:3",
 "open nether[unmet:visited the_nether]; done gear; early end[before stronghold]; strategy:end; later:6"
];
for (const [index, fixture] of scenarios.entries()) test(`offline progress: ${fixture.name}`, async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, record.currentGoal, plan); await views.observe(record, fixture.observation);
 assert.equal(views.progress(record), expected[index]);
 const statuses = views.snapshot(record).plan.steps;
 const facts = planProgress({ steps: statuses });
 // Presence (nether, end) holds before its prerequisites are proven, so it neither completes nor unlocks later steps.
 if (index === 0) { assert.equal(statuses[1].status, 'pending'); assert.deepEqual(facts.open, ['gear']); }
 if (index === 3) assert.deepEqual(facts.open, ['stronghold']);
 if (index === 4) assert.deepEqual(facts.open, ['nether']);
 // The first step's requirement chain (at most 360 B plus its separator) is outside the 240 B line budget.
 assert.ok(Buffer.byteLength(views.progress(record)) <= 240 + 362);
});

test('check grammar validates IDs, variants, counts, tiers and the bounded boolean grammar', () => {
 for (const check of [null, 'in:minecraft:the_end', 'visited:minecraft:the_nether', 'has:minecraft:oak_log|minecraft:birch_log*8', 'worn:iron+4 & tool:pickaxe:iron+', 'adv:minecraft:story/enter_the_nether | killed:minecraft:blaze', 'seen:minecraft:fortress']) assert.equal(validateTaskPlan(checked(check)).steps[0].check, check);
 for (const [check, reason] of [['in:the_end', /unsupported term/], ['has:minecraft:stone*0', /unsupported term/], ['worn:stone+4', /unsupported term/], ['tool:bow:iron+', /unsupported term/], ['in:minecraft:the_end & seen:minecraft:fortress | killed:minecraft:blaze', /cannot mix/], [Array(5).fill('in:a:b').join(' & '), /at most 4/], ['x'.repeat(161), /1-160/]]) assert.throws(() => validateTaskPlan(checked(check)), reason);
 assert.ok(!TASK_PLAN_SCHEMA.properties.steps.items.required.includes('check'), 'legacy steps may omit check; normalization supplies null');
});

test('live terms lose possession on death while visits, awards, own sightings and verified kills survive restart', async t => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'progress-known-')); t.after(() => rm(directory, { recursive: true, force: true }));
 let views = new LiveTaskViews({ directory });
 const o = sample(); o.inventory.items = [...armor('diamond'), item('diamond_pickaxe'), item('blaze_rod', 7)]; o.sighted.structures = [{ structure: 'nether fortress', x: 10, z: 20 }];
 await views.observe(record, o);
 await views.receipt(record, { advancementId: 'minecraft:story/enter_the_nether', entityType: 'minecraft:blaze' });
 const checks = ['worn:iron+4', 'tool:pickaxe:iron+', 'has:minecraft:blaze_rod*7', 'in:minecraft:the_nether', 'visited:minecraft:the_nether', 'adv:minecraft:story/enter_the_nether', 'seen:minecraft:fortress', 'killed:minecraft:blaze'];
 await views.operate(record, { operation: 'replace', plan: { steps: checks.map((check, i) => ({ ...plan.steps[0], id: `s${i}`, check })) } });
 assert.deepEqual(views.snapshot(record).plan.steps.map(s => s.status), checks.map(() => 'complete'));
 await views.observe(record, { ready: false, player: { dead: true } });
 assert.deepEqual(views.snapshot(record).plan.steps.slice(0, 3).map(s => s.status), ['lost', 'lost', 'lost']); await views.flush();
 views = new LiveTaskViews({ directory }); const fresh = sample(); fresh.world.dimension = 'minecraft:overworld'; await views.observe(record, fresh);
 assert.deepEqual(views.snapshot(record).plan.steps.map(s => s.status), ['lost', 'lost', 'lost', 'lost', 'complete', 'complete', 'complete', 'complete']);
 await views.observe(record, { ...fresh, world: { ...fresh.world, worldId: 'different' } }); assert.equal(views.snapshot(record).plan, null); await views.flush();
});

test('partial checks name unmet terms, OR alternatives stay satisfied and unknown samples cannot invent loss', () => {
 const o = sample(); o.inventory.items = armor('diamond');
 const result = evaluatePlanCheck('worn:iron+4 & tool:pickaxe:iron+', o, emptyKnown());
 assert.equal(result.partial, true); assert.equal(result.reason, 'armor ok, pickaxe missing iron+');
 assert.equal(evaluatePlanCheck('has:minecraft:blaze_rod*7 | in:minecraft:the_nether', o, emptyKnown()).ok, true);
 assert.equal(evaluatePlanCheck('has:minecraft:blaze_rod*7', {}, emptyKnown()).ok, null);
});

test('progress is capped in UTF-8 bytes and history never changes the authored statuses', async () => {
 const views = new LiveTaskViews(); await views.observe(record, sample());
 const p = { steps: Array.from({ length: 48 }, (_, i) => ({ ...plan.steps[0], id: `step_${i}_long`, check: 'has:minecraft:diamond*64', label: 'Diamond supplies' })) };
 await views.operate(record, { operation: 'replace', plan: p });
 assert.ok(Buffer.byteLength(views.progress(record)) <= 240 + 362); assert.match(views.progress(record), /\+\d+ more$/);
 assert.ok(views.snapshot(record).plan.steps.every(s => s.status === 'pending'));
});

test('null checks preserve inventory reconciliation and manual completion behavior', async () => {
 const views = new LiveTaskViews(); await views.observe(record, sample());
 const p = { steps: [{ ...plan.steps[0], check: null, kind: 'manual', status: 'complete' }] };
 await views.operate(record, { operation: 'replace', plan: p }); await views.observe(record, { ready: false, player: { dead: true } });
 assert.equal(views.snapshot(record).plan.steps[0].status, 'complete');
});

test('event puts progress after trigger, retains unchanged short progress and leaves program clocks intact', () => {
 const o = sample(), line = 'plan r1; open gear';
 const input = buildNativeEventInput(record, { trigger: 'start', observation: o, progress: line });
 const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
 assert.deepEqual(Object.keys(payload).slice(0, 5), ['event', 'trigger', 'hud', 'situation', 'progress']);
 assert.equal(payload.observation.world.gameTime, undefined); assert.equal(payload.observation.world.dayTime, undefined); assert.equal(o.world.gameTime, 100);
 const views = new ModelObservationViews(); views.retainEventMetadata(payload); const second = views.retainEventMetadata(payload);
 assert.equal(second.progress, undefined); assert.ok(second.sameAsPreviousEvent.includes('progress'));
 const changed = views.retainEventMetadata({ ...payload, progress: 'plan r2; open rods' }); assert.equal(changed.progress, 'plan r2; open rods');
});

test('observed goal-start state reaches the translator and check-bearing output validates', async () => {
 const request = { requestId: '00000000-0000-4000-8000-000000000001', originalRequest: 'beat the game', candidateIds: ['minecraft:ender_dragon'], playerState: 'minecraft:the_nether; worn:none; carried:diamond_helmet*1,cooked_beef*64' };
 assert.match(buildGoalSpecTranslatorPrompt(request), /Player state now .*minecraft:the_nether/);
 assert.doesNotMatch(buildGoalSpecTranslatorPrompt(request), /Use pending for every unobserved step|Unknown locations must be manual/);
 const translator = new GoalSpecTranslator({ generate: async ({ prompt }) => { assert.match(prompt, /carried:diamond_helmet/); return { requestId: request.requestId, summary: 'Find rods and pearls', predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true }, plan }; } });
 assert.deepEqual((await translator.translate(request)).plan, plan);
 assert.deepEqual(validateProtocolV2Payload('goal_spec_request', request), request);
 for (const [type, payload] of [['advancement_granted', { goalRevision: 1, advancementId: 'minecraft:story/enter_the_nether' }], ['entity_killed', { goalRevision: 1, entityType: 'minecraft:blaze' }], ['plan_facts', { goalRevision: 1, advancements: [], verifiedKills: [] }]]) assert.deepEqual(validateProtocolV2Payload(type, payload), payload);
});

 test('facts collected before a plan are saved and receipts merge across first world load', async t => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'progress-preplan-')); t.after(() => rm(directory, { recursive: true, force: true }));
 let views = new LiveTaskViews({ directory }); await views.receipt(record, { advancementId: 'minecraft:story/enter_the_nether' }); await views.observe(record, sample()); await views.flush();
 views = new LiveTaskViews({ directory }); await views.receipt(record, { entityType: 'minecraft:blaze' }); const o = sample(); o.world.dimension = 'minecraft:overworld'; await views.observe(record, o);
 await views.operate(record, { operation: 'replace', plan: checked('visited:minecraft:the_nether & adv:minecraft:story/enter_the_nether & killed:minecraft:blaze') });
 assert.equal(views.snapshot(record).plan.steps[0].status, 'complete'); await views.flush();
 });

 test('only own named perception grows sightings and repeated nearest-surface rows stay bounded', () => {
 const known = emptyKnown(), o = sample();
 o.entities = [{ type: 'minecraft:blaze', dead: true }]; o.blocks = [{ blockId: 'minecraft:nether_bricks', x: 1, y: 2, z: 3 }];
 rememberPlanFacts(known, o); assert.deepEqual(known.kills, []); assert.deepEqual(known.structuresSeen, []);
 for (let x = 0; x < 100; x++) rememberPlanFacts(known, { ...o, sighted: { structures: [{ structure: 'nether fortress', x, z: 10 }] } });
 assert.deepEqual(known.structuresSeen, [{ id: 'minecraft:fortress', dimension: 'minecraft:the_nether', x: 0, z: 10 }]);
 });

for (const [name, inputs, output, amount] of [
 ['eyes', [['blaze_rod', 7], ['ender_pearl', 12]], 'ender_eye', 12],
 ['tools', [['iron_ingot', 3]], 'iron_pickaxe', 1],
 ['planks', [['oak_log', 4]], 'oak_planks', 16],
]) test(`consumed prerequisites reopen when the crafted dependent is lost: ${name}`, async t => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'progress-consumed-')); t.after(() => rm(directory, { recursive: true, force: true }));
 let views = new LiveTaskViews({ directory });
 const authored = { steps: [...inputs.map(([id, n]) => ({ ...plan.steps[0], id, dependsOn: [], check: `has:minecraft:${id}*${n}` })),
  { ...plan.steps[0], id: output, dependsOn: inputs.map(([id]) => id), check: `has:minecraft:${output}*${amount}` }] };
 views.suggest(record.agentId, record.currentGoal, authored);
 const o = sample(); o.inventory.items = inputs.map(([id, n]) => item(id, n)); await views.observe(record, o);
 assert.ok(views.snapshot(record).plan.steps.slice(0, -1).every(s => s.status === 'complete'));
 o.inventory.items = [item(output, amount)]; await views.observe(record, o);
 assert.equal(views.snapshot(record).plan.steps.at(-1).status, 'complete');
 assert.deepEqual(planProgress(views.snapshot(record).plan).open, []);
 assert.ok(inputs.every(([id]) => planProgress(views.snapshot(record).plan).skipped[id] === output));
 o.inventory.items = amount > 1 ? [item(output, amount - 8 > 0 ? amount - 8 : 1)] : []; await views.observe(record, o);
 assert.ok(views.snapshot(record).plan.steps.slice(0, -1).every(s => s.status === 'lost'));
 assert.deepEqual(planProgress(views.snapshot(record).plan).open, inputs.map(([id]) => id));
 await views.flush(); views = new LiveTaskViews({ directory }); await views.observe(record, o);
 assert.ok(views.snapshot(record).plan.steps.slice(0, -1).every(s => s.status === 'lost'));
 assert.deepEqual(planProgress(views.snapshot(record).plan).open, inputs.map(([id]) => id)); await views.flush();
});

test('multi-parent skips include lost nodes, preserve active nodes and traverse skipped dependents', () => {
 const steps = [
  { id: 'a', status: 'lost', dependsOn: [] }, { id: 'b', status: 'pending', dependsOn: [] },
  { id: 'c', status: 'lost', dependsOn: ['a', 'b'] }, { id: 'active', status: 'active', dependsOn: [] },
  { id: 'done', status: 'complete', dependsOn: ['c', 'active'] },
 ];
 assert.deepEqual(planProgress({ steps }), { skipped: Object.assign(Object.create(null), { c: 'done', a: 'done', b: 'done' }), open: ['active'] });
});

test('one malformed translator check keeps all steps and traces its reason', async () => {
 const request = { requestId: '00000000-0000-4000-8000-000000000001', originalRequest: 'beat the game', candidateIds: ['minecraft:ender_dragon'] };
 const bad = structuredClone(plan); bad.steps[2].check = 'has:minecraft:dirt'; bad.steps[2].kind = 'inventory'; bad.steps[2].evidence = null;
 const traces = [];
 const translator = new GoalSpecTranslator({ trace: (...args) => traces.push(args), generate: async () => ({ requestId: request.requestId, summary: 'Find supplies', predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true }, plan: bad }) });
 const result = await translator.translate(request);
 assert.equal(result.plan.steps.length, plan.steps.length); assert.equal(result.plan.steps[2].check, null);
 assert.equal(result.plan.steps[2].kind, 'manual'); assert.equal(result.plan.steps[1].check, plan.steps[1].check);
 assert.equal(traces[0][0], 'goal_plan_check_invalid'); assert.equal(traces[0][1].stepId, bad.steps[2].id); assert.match(traces[0][1].reason, /unsupported term/);
 assert.equal(TASK_PLAN_SCHEMA.properties.steps.items.properties.check.minLength, 1);
});

test('copper armor, turtle helmet and perception structure IDs', () => {
 const o = sample(); o.inventory.items = [...armor('copper').filter(v => v.slot !== 'head'), { ...item('turtle_helmet'), slot: 'head' }];
 assert.equal(evaluatePlanCheck('worn:copper+4', o, emptyKnown()).ok, true);
 assert.equal(evaluatePlanCheck('worn:iron+1', o, emptyKnown()).ok, true);
 assert.throws(() => validateTaskPlan(checked('seen:minecraft:village')), /unknown perceived structure/);
 assert.throws(() => validateTaskPlan(checked('seen:minecraft:ruined_portal')), /unknown perceived structure/);
 for (const id of ['shipwreck', 'igloo', 'mineshaft', 'stronghold']) assert.equal(validateTaskPlan(checked(`seen:minecraft:${id}`)).steps[0].check, `seen:minecraft:${id}`);
});

test('short unchanged goal is retained when its value exceeds its marker', () => {
 const views = new ModelObservationViews(), value = { goal: 'beat the game', progress: 'open gear', taskMemory: null, observation: sample() };
 views.retainEventMetadata(value); const retained = views.retainEventMetadata(value);
 assert.equal(retained.goal, undefined); assert.ok(retained.sameAsPreviousEvent.includes('goal')); assert.equal(retained.taskMemory, null);
});


test('the main route reopens rods and pearls after eyes are lost', async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, record.currentGoal, plan);
 const o = sample(); o.inventory.items = [...armor('iron'), item('iron_pickaxe'), item('blaze_rod', 7), item('ender_pearl', 12)];
 await views.observe(record, o);
 o.inventory.items = [...armor('iron'), item('iron_pickaxe'), item('ender_eye', 12)]; await views.observe(record, o);
 assert.match(views.progress(record), /skipped rods,pearls via eyes/);
 for (const count of [4, 0]) {
  o.inventory.items = [...armor('iron'), item('iron_pickaxe'), ...(count ? [item('ender_eye', count)] : [])]; await views.observe(record, o);
  assert.match(views.progress(record), /^open rods\[howto:blaze_rod 0\/7; kill blaze the_nether fortress\]; open pearls\[howto:ender_pearl 0\/12\];.*strategy:nether/);
 }
});

test('translator crafted forms use raw sums or separate thresholds, never recipe weights', () => {
 const prompt = buildGoalSpecTranslatorPrompt({ requestId: '00000000-0000-4000-8000-000000000001', originalRequest: 'beat the game', candidateIds: ['minecraft:ender_dragon'] });
 assert.match(prompt, /has: sums held counts across IDs, without craft weighting/);
 assert.match(prompt, /has:minecraft:blaze_rod\*1 \| has:minecraft:blaze_powder\*2, or eyes-based checks/);
 const o = sample(); o.inventory.items = [item('blaze_rod', 3), item('blaze_powder', 8)];
 assert.equal(evaluatePlanCheck('has:minecraft:blaze_rod|minecraft:blaze_powder*12', o, emptyKnown()).ok, false);
 const check = 'has:minecraft:blaze_rod*7 | has:minecraft:blaze_powder*14';
 assert.equal(evaluatePlanCheck(check, o, emptyKnown()).ok, false);
 o.inventory.items = [item('blaze_powder', 14)];
 assert.equal(evaluatePlanCheck(check, o, emptyKnown()).ok, true);
});

test('advancement capture is shared per award invocation for reentrant rewards', async () => {
 const source = await readFile(new URL('../../src/main/java/dev/agaminggod/arenaagents/mixin/PlayerAdvancementsMixin.java', import.meta.url), 'utf8');
 assert.equal((source.match(/@Share\("wasDone"\) LocalBooleanRef wasDone/g) ?? []).length, 2);
 assert.match(source, /wasDone\.set\(/); assert.match(source, /wasDone\.get\(\)/);
 assert.doesNotMatch(source, /@Unique|private boolean/);
});
