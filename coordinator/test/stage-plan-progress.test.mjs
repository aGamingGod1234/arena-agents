import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveTaskViews, validateTaskPlan } from '../src/live-task-view.mjs';
import { emptyKnown, evaluatePlanCheck, parsePlanCheck, rememberPlanFacts, restoreKnown } from '../src/plan-checks.mjs';
import { NO_PROGRESS_MS, REPEAT_COUNT, repeatSignature } from '../src/step-progress.mjs';
import { buildGoalSpecTranslatorPrompt } from '../src/goal-spec-translator.mjs';
import { composeContinuityHeader } from '../src/continuity-header.mjs';

const T0 = 1_800_000_000_000;
const record = { agentId: 'a1', goalRevision: 1, currentGoal: 'Beat the game', currentGoalSpec: { originalRequest: 'Beat the game', fingerprint: 'f1' } };
const step = (id, check, dependsOn = [], kind = 'milestone') => ({ id, label: id.replace('_', ' '), kind, status: 'pending', dependsOn, detail: '', evidence: null, check });
// The Nether stage as the translator now writes it.
const stagePlan = { steps: [
 step('kit', 'tool:pickaxe:iron+ & has:minecraft:bucket|minecraft:water_bucket|minecraft:lava_bucket*1'),
 step('floors', 'y<=-50', ['kit'], 'world'), step('pool', 'lava:10', ['floors'], 'world'), step('water', 'has:minecraft:water_bucket*1', ['kit'], 'inventory'),
 step('frame', 'frame:10', ['pool', 'water'], 'world'), step('nether', 'in:minecraft:the_nether', ['frame'], 'world'),
 step('end', 'in:minecraft:the_end', ['nether'], 'world'), step('crystals', 'crystals<=0', ['end'], 'world'), step('dragon', 'killed:minecraft:ender_dragon', ['crystals']),
] };
const kit = [{ itemId: 'minecraft:iron_pickaxe', count: 1, slot: 'main' }, { itemId: 'minecraft:water_bucket', count: 1, slot: 'main' }];
function sample(at, { y = 60, items = kit, blocks = [], sighted, dimension = 'minecraft:overworld', endCrystals } = {}) {
 return { ready: true, observedAtEpochMs: at, world: { worldId: 'w1', dimension }, player: { x: 0, y, z: 0, dead: false, health: 20 },
  inventory: { items: structuredClone(items) }, blocks, ...(sighted ? { sighted } : {}), ...(endCrystals ? { endCrystals } : {}) };
}
const lava = (x, y, z) => ({ blockId: 'minecraft:lava', state: { level: '0' }, x, y, z });

test('stage terms parse, stay bounded and read observed depth, lava, frames and crystals', () => {
 for (const check of ['y<=-50', 'y>=10', 'lava:10', 'frame:10', 'frame:lit', 'crystals<=0', 'seen:minecraft:spawner', 'y<=-50 & lava:4']) assert.equal(validateTaskPlan({ steps: [step('s', check)] }).steps[0].check, check);
 for (const check of ['y<-50', 'y<=-9999', 'lava:0', 'lava:33', 'frame:0', 'frame:dark', 'crystals<=100', 'seen:minecraft:chest']) assert.throws(() => parsePlanCheck(check), /Invalid plan check/);
 const known = emptyKnown();
 const o = sample(T0, { y: -53.4, blocks: [lava(1, -54, 2), lava(2, -54, 2), { ...lava(3, -54, 2), state: { level: '4' } }, { blockId: 'minecraft:spawner', x: 5, y: -50, z: 5 }],
  sighted: { portalFrames: [{ axis: 'z', interior: [2, 3], obsidian: 6, needed: 10, missing: [], blocked: [], lit: false, x: 9, y: -54, z: 9 }] } });
 assert.equal(rememberPlanFacts(known, o), true);
 const read = check => evaluatePlanCheck(check, o, known).terms.map(t => [t.ok, t.reason, t.metric]);
 assert.deepEqual(read('y<=-50'), [[true, 'y -54 (<=-50)', -54]]);
 assert.deepEqual(read('lava:3'), [[false, 'still lava sources seen 2/3', 2]]);
 assert.deepEqual(read('frame:10'), [[false, 'frame obsidian 6/10', 6]]);
 assert.deepEqual(read('frame:lit'), [[false, 'no lit frame seen', undefined]]);
 assert.deepEqual(read('crystals<=0'), [[null, 'crystals ?', undefined]]);
 assert.equal(evaluatePlanCheck('seen:minecraft:spawner', o, known).ok, true);
 // Distinct source cells add up over samples; a cell seen twice counts once.
 rememberPlanFacts(known, sample(T0 + 1, { y: -53, blocks: [lava(2, -54, 2), lava(2, -54, 3), lava(2, -54, 4)] }));
 assert.equal(evaluatePlanCheck('lava:4', o, known).ok, true);
 // A depth or a sighting is presence: it can hold before the earlier steps.
 assert.equal(evaluatePlanCheck('y<=-50 & lava:4', o, known).presenceOnly, true);
 // The End tally as last seen, caged ones named.
 const end = sample(T0 + 2, { dimension: 'minecraft:the_end', endCrystals: { standing: [{ x: 1, y: 90, z: 1, caged: true }, { x: 2, y: 80, z: 2 }], broken: 6 } });
 rememberPlanFacts(known, end);
 assert.deepEqual(evaluatePlanCheck('crystals<=0', end, known).terms.map(t => [t.ok, t.reason]), [[false, 'crystals 2 standing (1 caged) of 8 seen']]);
 const restored = restoreKnown(JSON.parse(JSON.stringify(known)));
 assert.deepEqual(restored.crystals, known.crystals);
 assert.deepEqual(restored.lavaPools.map(p => p.sources), [4]);
 assert.equal(restored.frames[0].obsidian, 6);
});

test('spawn:bed reads the bed-use message, the death screen target and a lost bed, and survives a restore', () => {
 assert.equal(validateTaskPlan({ steps: [step('bed', 'spawn:bed')] }).steps[0].check, 'spawn:bed');
 assert.throws(() => parsePlanCheck('spawn:anchor'), /Invalid plan check/);
 const known = emptyKnown();
 const read = o => evaluatePlanCheck('spawn:bed', o, known).terms.map(t => [t.ok, t.reason])[0];
 assert.deepEqual(read(sample(T0)), [false, 'no respawn set seen']);
 // Using a bed by day prints "Respawn point set"; the bed beside the player is the respawn cell.
 const used = { ...sample(T0 + 1), blocks: [{ blockId: 'minecraft:red_bed', x: 2, y: 60, z: 1 }], perception: { events: [{ type: 'system_message', text: 'Respawn point set', observedAtEpochMs: T0 + 1 }] } };
 assert.equal(rememberPlanFacts(known, used), true);
 assert.deepEqual(read(used), [true, 'respawn set 2,60,1']);
 assert.deepEqual(restoreKnown(JSON.parse(JSON.stringify(known))).spawn, known.spawn);
 // The same event seen again changes nothing.
 assert.equal(rememberPlanFacts(known, used), false);
 // The bed broken: the next respawn message says so.
 rememberPlanFacts(known, { ...sample(T0 + 5), perception: { events: [{ type: 'system_message', text: 'You have no home bed or charged respawn anchor, or it was obstructed', observedAtEpochMs: T0 + 5 }] } });
 assert.deepEqual(read(sample(T0 + 6)), [false, 'respawn: world spawn']);
 // The death screen names the respawn target.
 rememberPlanFacts(known, { ready: false, player: { dead: true }, death: { cause: 'a slain', diedAtEpochMs: T0 + 9, respawnDimensionId: 'minecraft:overworld', respawnX: -18, respawnY: -54, respawnZ: 94 } });
 assert.deepEqual(read(sample(T0 + 10)), [true, 'respawn set -18,-54,94']);
 rememberPlanFacts(known, { ready: false, player: { dead: true }, death: { cause: 'a slain', diedAtEpochMs: T0 + 20, respawnDimensionId: null, respawnX: null, respawnY: null, respawnZ: null } });
 assert.equal(known.spawn.kind, 'world');
});

test('the translator asks for ordered, checked sub-steps in the long stages', () => {
 const prompt = buildGoalSpecTranslatorPrompt({ requestId: '729d84a7-4e34-4a03-84c4-f89f8f103bfd', originalRequest: 'Beat the game', candidateIds: ['minecraft:ender_dragon'] });
 for (const term of ['check lava:10', 'below y-54 cave air is lava', 'check y<=-45', 'check frame:10', 'seen:minecraft:spawner', 'crystals<=0', 'a later sub-step met skips the earlier ones', 'caged crystals count too', 'check spawn:bed', 'a bed used beside the End portal']) assert.ok(prompt.includes(term), term);
});

test('no progress for the threshold states the focus step, its numbers and where the time went, once per window', async () => {
 let now = T0;
 const views = new LiveTaskViews({ now: () => now });
 await views.observe(record, sample(now, { y: 66 }));
 await views.operate(record, { operation: 'replace', plan: stagePlan });
 await views.observe(record, sample(now, { y: 60 }));
 // Staircasing down is progress on the depth step: each new low resets the clock.
 for (let i = 1; i <= 8; i++) { now += 60_000; await views.observe(record, sample(now, { y: 60 - i * 8 })); assert.equal(views.progressWake(record), null); }
 // Then a trip back to the surface for food: no step closer.
 await views.operate(record, { operation: 'intent', intent: { step: 'floors', why: 'No food left; resupply mutton on the surface' } });
 const food = [...kit, { itemId: 'minecraft:cooked_mutton', count: 3 }, { itemId: 'minecraft:cobblestone', count: 40 }];
 for (let t = 1; t * 60_000 < NO_PROGRESS_MS; t++) { now += 60_000; await views.observe(record, sample(now, { y: Math.min(70, -4 + t * 10), items: food })); assert.equal(views.progressWake(record), null); }
 now += 60_000; await views.observe(record, sample(now, { y: 70, items: food }));
 assert.equal(views.progressWake(record), 'no_progress');
 assert.equal(views.progressWake(record), null, 'one wake per window');
 const header = views.continuity(record);
 assert.match(header.progress, /^step floors "floors": no plan step completed or measurably closer for 10 min \(y 70 \(<=-50\), 10 min ago -4\); since then: y -4->70 \(range -4\.\.70\); held \+3 cooked_mutton, \+40 stone\/dirt; your intents floors: "No food left; resupply mutton on the surface"$/);
 // It re-arms after another window without progress, and a new low clears it.
 now += NO_PROGRESS_MS; await views.observe(record, sample(now, { y: 70, items: food }));
 assert.equal(views.progressWake(record), 'no_progress');
 assert.match(views.continuity(record).progress, /for 20 min/);
 now += 60_000; await views.observe(record, sample(now, { y: -5, items: food }));
 assert.equal(views.continuity(record).progress, undefined);
});

test('a long climb back toward the step after the fact is stated is not stated again', async () => {
 let now = T0;
 const views = new LiveTaskViews({ now: () => now });
 await views.observe(record, sample(now, { y: -55 }));
 await views.operate(record, { operation: 'replace', plan: stagePlan });
 await views.observe(record, sample(now, { y: -55 }));
 // Up the staircase (samples are continuous, so the depth step is lost near y-49) and on to the surface.
 for (let t = 1; t * 60_000 <= NO_PROGRESS_MS; t++) { now += 60_000; await views.observe(record, sample(now, { y: [-49, -30, 0, 40][t - 1] ?? 80 })); }
 assert.equal(views.progressWake(record), 'no_progress');
 // Back down a staircase for the next window: closer than when stated, still above the depth step.
 for (let t = 1; t * 60_000 <= NO_PROGRESS_MS; t++) { now += 60_000; await views.observe(record, sample(now, { y: 80 - t * 9 })); }
 assert.equal(views.progressWake(record), null);
 // The header keeps current numbers.
 assert.match(views.continuity(record).progress, /for 20 min \(y -10 \(<=-50\)/);
});

test('a completed sub-step is progress, but a live check flickering at its threshold is not', async () => {
 let now = T0;
 const views = new LiveTaskViews({ now: () => now });
 await views.observe(record, sample(now, { y: -45 }));
 await views.operate(record, { operation: 'replace', plan: stagePlan });
 await views.observe(record, sample(now, { y: -45 }));
 now += 60_000; await views.observe(record, sample(now, { y: -50 }));
 // From here the depth flickers -49/-50 on a cave floor for the whole window with nothing else changing.
 for (let t = 0; t * 30_000 <= NO_PROGRESS_MS + 60_000; t++) { now += 30_000; await views.observe(record, sample(now, { y: t % 2 ? -49 : -50 })); }
 assert.ok(views.continuity(record).progress?.includes('no plan step completed'), 'flicker is not progress');
 // Seeing still lava up close is progress on the pool step and clears the fact.
 now += 30_000; await views.observe(record, sample(now, { y: -50, blocks: [lava(3, -51, 3)] }));
 assert.equal(views.continuity(record).progress, undefined);
});

test('the same no-effect result repeated wakes once with the action, the result and the unchanged step', async () => {
 let now = T0;
 const views = new LiveTaskViews({ now: () => now });
 const crystals = { standing: [{ x: 40, y: 92, z: 0, caged: true }], broken: 9 };
 await views.observe(record, sample(now, { dimension: 'minecraft:the_end', endCrystals: crystals }));
 // The whole stage plan from an End checkpoint: the End is reached by presence before its earlier steps are proven.
 await views.operate(record, { operation: 'replace', plan: stagePlan });
 await views.observe(record, sample(now, { dimension: 'minecraft:the_end', endCrystals: crystals }));
 const shot = i => ({ actionId: `shot-${i}`, goalRevision: 1, worldId: 'w1', dimension: 'minecraft:the_end', actionType: 'use_ranged', state: 'SUCCEEDED', reasonCode: 'OWNED_PROJECTILE_CONFIRMED', arguments: { targetId: 'crystal-1' }, observedAtEpochMs: now,
  message: `Arrow loosed (aim point 41.9,121.0,-0.0: 18.3 blocks above the target's visible point for drop over 62 blocks); missed: stuck in minecraft:iron_bars at 40,${91 + (i % 2)},1; closest pass 1.${i} blocks from the target's box` });
 for (let i = 0; i < REPEAT_COUNT - 1; i++) { now += 20_000; await views.actionReceipt(record, shot(i)); await views.observe(record, sample(now, { dimension: 'minecraft:the_end', endCrystals: crystals })); assert.equal(views.progressWake(record), null); }
 // A different outcome is another key and does not add up.
 await views.actionReceipt(record, { ...shot(99), message: 'Arrow loosed (aim); it struck the target, which broke or died' });
 now += 20_000; await views.actionReceipt(record, shot(REPEAT_COUNT));
 await views.observe(record, sample(now, { dimension: 'minecraft:the_end', endCrystals: crystals }));
 assert.equal(views.progressWake(record), 'repeated_result');
 assert.equal(views.continuity(record).repeats, `use_ranged ${REPEAT_COUNT} times in 2 min with the same result: shot stopped by minecraft:iron_bars (loosed, stuck in it); no plan step completed or measurably closer since the first (step crystals: crystals 1 standing (1 caged) of 10 seen)`);
});

test('repeat signatures keep failures and misses, and skip effects, cancels and chat', () => {
 assert.equal(repeatSignature({ actionType: 'break_block', state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', message: 'Broke stone' }), null);
 assert.equal(repeatSignature({ actionType: 'move_to', state: 'CANCELLED', reasonCode: 'CANCELLED' }), null);
 assert.equal(repeatSignature({ actionType: 'chat', state: 'FAILED', reasonCode: 'X' }), null);
 const blocked = repeatSignature({ actionType: 'use_ranged', state: 'FAILED', reasonCode: 'TARGET_OBSTRUCTED', message: 'No line from this eye reaches the target unblocked; arrows stop at minecraft:iron_bars at -40,80,-2', arguments: { targetId: 'c' } });
 assert.equal(blocked.key, 'use_ranged|stopped by minecraft:iron_bars');
 assert.equal(blocked.target, 'c');
 // A shot that flew into the bars and one refused for the barred line are the same cause.
 const a = repeatSignature({ actionType: 'use_ranged', state: 'SUCCEEDED', message: 'Arrow loosed (x); missed: stuck in minecraft:iron_bars at -11,82,-38; closest' });
 const b = repeatSignature({ actionType: 'use_ranged', state: 'SUCCEEDED', message: 'Arrow loosed (y); missed: stuck in minecraft:iron_bars at 3,90,7' });
 assert.equal(a.key, b.key);
 assert.equal(a.key, blocked.key);
 const air = repeatSignature({ actionType: 'use_ranged', state: 'SUCCEEDED', message: 'Arrow loosed (y); missed: stuck in minecraft:air at 3,90,7' });
 assert.equal(air.key, 'use_ranged|missed: stuck in minecraft:air at #,#,#');
});

test('a depth sub-step keeps the Nether access options of its stage', async () => {
 let now = T0;
 const views = new LiveTaskViews({ now: () => now });
 await views.observe(record, sample(now, { y: 40 }));
 await views.operate(record, { operation: 'replace', plan: stagePlan });
 await views.observe(record, sample(now, { y: 40 }));
 assert.match(views.continuity(record).options, /Nether access/);
});

test('the header places progress and repeats beside the plan line', () => {
 const header = composeContinuityHeader({ goal: 'g', progress: 'open x', stepProgress: 'step x: no progress', repeats: 'use_ranged 8 times' });
 assert.deepEqual(Object.keys(header), ['plan', 'progress', 'repeats']);
});

test('the coordinator wakes the model once with no_progress when quiet samples show no plan progress for the threshold', async () => {
 const { AgentRegistry } = await import('../src/agent-registry.mjs');
 const { FakePlanner, RecordingGoalSupervisor, eventually, start } = await import('./fixtures/dynamic-main-fixture.mjs');
 const { normalizeMinecraftToolCall } = await import('../src/native-minecraft-tools.mjs');
 const registry = new AgentRegistry();
 const planner = new FakePlanner(registry);
 const rows = [];

 planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' });
 planner.requestNativeTurn = async (request) => {
  planner.requests.push(request);
  if (planner.requests.length === 1) {
   await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 't1', callId: 'c1',
    tool: normalizeMinecraftToolCall('taskPlan', { operation: 'replace', plan: { steps: [step('floors', 'y<=-50', [], 'world')] } }) });
   return { toolCalls: 1 };
  }
  return { toolCalls: 0 };
 };
 const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
 const base = Date.now();
 const sampleAt = (sequence, minutes, attention) => ({ agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence, attention, observedAtEpochMs: base + minutes * 60_000, changedFacts: attention ? ['blocks'] : [],
  observation: { ready: true, observedAtEpochMs: base + minutes * 60_000, player: { x: 0, y: 70, z: 0, health: 20 }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} }, world: { worldId: 'w1', dimension: 'minecraft:overworld', gameTime: 1_000 + sequence, dayTime: 1_000 + sequence, raining: false, thundering: false } } } });
 run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat the game.' } });
 run.bridge.emit('observation', sampleAt(1, 0, true));
 await eventually(() => rows.some(({ event }) => event === 'native_turn_completed'));
 // Quiet samples (no attention) at the surface: the depth step does not move.
 // Delivered one at a time: samples queued behind each other coalesce to the latest.
 for (let minute = 1; minute <= 11; minute++) { run.bridge.emit('observation', sampleAt(1 + minute, minute, false)); await new Promise(resolve => setTimeout(resolve, 30)); }
 await eventually(() => planner.requests.some(request => /"trigger":"no_progress"/.test(request.input)));
 const woken = planner.requests.filter(request => /"trigger":"no_progress"/.test(request.input));
 assert.equal(woken.length, 1);
 assert.match(woken[0].input, /"progress":"step floors \\"floors\\": no plan step completed or measurably closer for 10 min/);
 await run.coordinator.stop();
});

test('shots stopped by iron bars keep counting while other crystals break, and the line says the plan moved', async () => {
 let now = T0;
 const views = new LiveTaskViews({ now: () => now });
 const two = { standing: [{ x: 40, y: 92, z: 0, caged: true }, { x: -40, y: 80, z: 0 }], broken: 8 };
 const one = { standing: [{ x: 40, y: 92, z: 0, caged: true }], broken: 9 };
 const end = crystals => sample(now, { dimension: 'minecraft:the_end', endCrystals: crystals });
 await views.observe(record, end(two));
 await views.operate(record, { operation: 'replace', plan: stagePlan });
 await views.observe(record, end(two));
 const shot = i => ({ actionId: `bar-${i}`, goalRevision: 1, worldId: 'w1', dimension: 'minecraft:the_end', actionType: 'use_ranged', state: i % 2 ? 'FAILED' : 'SUCCEEDED', reasonCode: i % 2 ? 'TARGET_OBSTRUCTED' : 'OWNED_PROJECTILE_CONFIRMED', arguments: { targetId: 'caged' }, observedAtEpochMs: now,
  message: i % 2 ? 'No line from this eye reaches the target unblocked; arrows stop at minecraft:iron_bars at 40,91,1' : 'Arrow loosed (aim); missed: stuck in minecraft:iron_bars at 40,91,1' });
 for (let i = 0; i < REPEAT_COUNT; i++) {
  now += 30_000; await views.actionReceipt(record, shot(i));
  // The open crystal breaks halfway: plan progress, but not for the caged one the shots keep hitting the bars of.
  await views.observe(record, end(i < REPEAT_COUNT / 2 ? two : one));
 }
 assert.equal(views.progressWake(record), 'repeated_result');
 assert.match(views.continuity(record).repeats, new RegExp(`^use_ranged ${REPEAT_COUNT} times in 4 min with the same result: shot stopped by minecraft:iron_bars \\(.*\\); other plan progress meanwhile \\(step crystals: crystals 1 standing \\(1 caged\\) of 10 seen\\)$`));
});

test('the beat-the-game plan prompt offers a gold piece before the Nether, the bastion-first route and fire resistance before the fortress', () => {
 const prompt = buildGoalSpecTranslatorPrompt({ requestId: '729d84a7-4e34-4a03-84c4-f89f8f103bfd', originalRequest: 'Beat the game', candidateIds: ['minecraft:ender_dragon'] });
 assert.match(prompt, /Nether preparation step that Nether access does not depend on: a gold armour piece, check has:minecraft:golden_helmet\|minecraft:golden_chestplate\|minecraft:golden_leggings\|minecraft:golden_boots\*1/);
 assert.match(prompt, /a bastion first \(a manual step, check null, since a seen check completes on sight before any loot or barter; detail: barter gold with calm piglins for ender pearls \(~15 ingots per pearl\)/);
 assert.match(prompt, /seen:minecraft:fortress, detail: fortresses and bastions share 432-block regions, one structure each, so a seen bastion's region holds no fortress; the wake lists the regions not yet seen; Nether fog ends at 96 blocks; drink fire resistance, if held, before entering/);
 assert.match(prompt, /List the bastion step before the fortress steps and do not label it optional/);
});
