import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';

const record = { currentGoal: 'Beat Minecraft', goalRevision: 1 };
const payload = input => decodeModelFacts(JSON.parse(input.slice(input.indexOf('\n') + 1)));
const render = wake => payload(buildNativeEventInput(record, wake));
function wake() {
 const currentAction = { active: true, actionId: 'native:travel:1', actionType: 'move_to' };
 return {
  event: 'observation', trigger: 'damage',
  runningAction: { ...currentAction, arguments: { x: 40, y: 64, z: 40 } },
  runningActionStart: { actionId: currentAction.actionId, health: 11 },
  observation: {
   player: { x: 10, y: 64, z: 0, health: 8, skyOpen: true }, currentAction,
   world: { worldId: 'test-world', dimension: 'minecraft:overworld', dayTime: 11000, raining: false, thundering: false },
   inventory: { items: [{ itemId: 'minecraft:apple', count: 3 }] },
   items: [], entities: [], blocks: [],
   coverage: { complete: false, sections: { blocks: { returned: 0, total: 10, omittedByWire: 10 } } },
  },
 };
}
function expandedCoverage(observation) {
 return Object.fromEntries(Object.entries(observation.snapshotCounts).map(([section, count]) => [section, {
  availableInSnapshot: count,
  ...(observation.omittedRows?.[section] === undefined ? {} : { omitted: observation.omittedRows[section] }),
 }]));
}

test('routine coverage transposes counts without losing routine or upstream coverage facts', () => {
 const source = wake();
 const observation = render(source).observation;
 assert.equal(observation.currentAction.to, '40,64,40');
 assert.equal(observation.currentAction.left, 50);
 assert.equal(observation.currentAction.hurtWhileRunning, '11->8');
 assert.ok(observation.world.darkIn !== undefined);
 assert.equal(observation.resultCoverage, undefined);
 assert.equal(observation.omittedRows, undefined);
 assert.deepEqual(expandedCoverage(observation), {
  inventory: { availableInSnapshot: 1 }, items: { availableInSnapshot: 0 },
  entities: { availableInSnapshot: 0 }, blocks: { availableInSnapshot: 0 },
 });
 const legacy = structuredClone(source);
 delete legacy.runningAction;
 delete legacy.runningActionStart;
 legacy.observation.world.dayTime = 6000;
 const original = render(legacy).observation;
 assert.deepEqual(observation.coverage, original.coverage, 'bridge coverage remains independent of local row counts');
 assert.deepEqual(observation.inventory, original.inventory);
 assert.deepEqual(observation.player, original.player);
 const fight = wake();
 fight.observation.currentAction.actionType = 'fight_target';
 fight.runningAction = { ...fight.observation.currentAction, arguments: { fleeAtHealth: 6 } };
 assert.equal(render(fight).observation.currentAction.fleeAtHealth, 6);
});

test('ordinary wakes keep the same compact coverage and optional section counts are exact', () => {
 const source = wake();
 delete source.runningAction;
 delete source.runningActionStart;
 source.observation.world.dayTime = 6000;
 const ordinary = render(source).observation;
 assert.equal(ordinary.resultCoverage, undefined);
 assert.ok(ordinary.snapshotCounts);
 source.runningActionStart = { actionId: source.observation.currentAction.actionId, health: 11 };
 source.observation.landmarks = [{ blockId: 'minecraft:stone', x: 1, y: 64, z: 1 }];
 source.observation.nearbyContainers = [];
 source.observation.options = [];
 const compact = render(source).observation;
 assert.equal(compact.snapshotCounts.landmarks, 1);
 assert.equal(compact.snapshotCounts.nearbyContainers, 0);
 assert.equal(compact.snapshotCounts.options, 0);
 assert.equal(compact.omittedRows, undefined);
});

test('overflow compaction reports final retained counts and preserves running facts', () => {
 const source = wake();
 source.observation.world.extra = 'x'.repeat(20_000);
 source.observation.blocks = Array.from({ length: 201 }, (_, x) => ({ blockId: 'minecraft:stone', x, y: 64, z: 0 }));
 source.observation.entities = Array.from({ length: 40 }, (_, x) => ({ type: 'minecraft:cow', uuid: `cow-${x}`, x, y: 64, z: 0 }));
 const compact = render(source).observation;
 for (const section of ['blocks', 'entities']) {
  assert.equal(compact.snapshotCounts[section], source.observation[section].length);
  assert.equal(compact.omittedRows[section], source.observation[section].length - compact[section].length);
 }
 assert.ok(compact.blocks.length < 32, 'the oversized event reached the overflow trimming path');
 assert.equal(compact.currentAction.to, '40,64,40');
 assert.equal(compact.currentAction.left, 50);
 assert.equal(compact.currentAction.hurtWhileRunning, '11->8');
});

test('encoded successive wake views reconstruct changed and removed compact coverage', () => {
 const views = new ModelObservationViews();
 let reconstructed;
 let changes = 0;
 const check = source => {
  const raw = buildNativeEventInput(record, source);
  const wire = payload(encodeNativeEventInput(raw, views));
  if (wire.observationView?.mode === 'changes') {
   changes++;
   for (const key of wire.observationView.remove) delete reconstructed[key];
   Object.assign(reconstructed, wire.observationView.replace);
  } else reconstructed = wire.observation;
  const expected = { ...payload(raw).hud, ...payload(raw).observation };
  // Delivery isolates volatile readings; reconstruct the same facts from their encoded locations.
  if (expected.currentAction?.left !== undefined) { expected.actionDistance = expected.currentAction.left; delete expected.currentAction.left; }
  if (expected.currentAction?.hurtWhileRunning !== undefined) { expected.hurtWhileRunning = expected.currentAction.hurtWhileRunning; delete expected.currentAction.hurtWhileRunning; }
  assert.deepEqual(reconstructed, expected);
  return reconstructed;
 };
 const source = wake();
 source.observation.entities = Array.from({ length: 40 }, (_, x) => ({ type: 'minecraft:cow', uuid: `cow-${x}`, x, y: 64, z: 0 }));
 assert.equal(check(source).omittedRows.entities, 24);
 source.observation.entities = [];
 assert.equal(check(source).snapshotCounts.entities, 0);
 assert.equal(reconstructed.omittedRows, undefined);
 delete source.runningAction;
 delete source.runningActionStart;
 source.observation.world.dayTime = 6000;
 assert.equal(check(source).resultCoverage, undefined);
 assert.ok(reconstructed.snapshotCounts);
 assert.ok(changes > 0, 'a following wake exercises the encoded changes view');
});

test('coverage stays in one section across sunset, recovery and action end', () => {
 const views = new ModelObservationViews();
 const source = wake();
 const send = () => payload(encodeNativeEventInput(buildNativeEventInput(record, source), views));
 source.observation.world.dayTime = 10999;
 delete source.runningAction;
 delete source.runningActionStart;
 source.observation.currentAction = { active: false };
 const first = send();
 assert.deepEqual(first.observation.snapshotCounts, { inventory: 1, items: 0, entities: 0, blocks: 0 });
 for (const dayTime of [11000, 13000, 6000]) {
  source.observation.world.dayTime = dayTime;
  const next = send().observationView;
  assert.equal(next.replace.snapshotCounts, undefined);
  assert.equal(next.replace.resultCoverage, undefined);
  assert.ok(!next.remove.includes('snapshotCounts'));
  assert.ok(!next.remove.includes('resultCoverage'));
 }
 Object.assign(source, wake());
 send();
 source.observation.currentAction.active = false;
 delete source.runningAction;
 delete source.runningActionStart;
 const ended = send().observationView;
 assert.equal(ended.replace.snapshotCounts, undefined);
 assert.ok(!ended.remove.includes('snapshotCounts'));
});

test('planning has one advisory instruction with or without routine facts', () => {
 const source = wake();
 source.event = 'program_planning_due';
 const active = buildNativeEventInput(record, source).split('\n')[0];
 delete source.runningAction;
 delete source.runningActionStart;
 source.observation.currentAction = { active: false };
 source.observation.world.dayTime = 6000;
 const idle = buildNativeEventInput(record, source).split('\n')[0];
 assert.equal(active, idle);
 assert.match(idle, /Advisory: no pending decisionId needed/);
 assert.match(idle, /Use current programVersion and timing/);
 assert.match(idle, /do not blindly renew or cancel/);
});

test('ending an action never expands the unchanged wake instruction', () => {
 for (const patch of [
  {}, { newContext: true }, { awaitingConfirmation: true },
  { trigger: 'low_health_food' },
  { event: 'program_attention', status: { decision: { trigger: 'damage', priority: 'urgent' } } },
  { conversationOnly: true, dangerWake: true },
  { conversationOnly: true, selfCareWake: true },
  { conversationOnly: true },
 ]) {
  const source = { ...wake(), ...patch };
  source.observation.world.dayTime = 6000;
  const running = buildNativeEventInput(record, source).split('\n')[0];
  source.observation.currentAction.active = false;
  delete source.runningAction;
  delete source.runningActionStart;
  assert.equal(buildNativeEventInput(record, source).split('\n')[0], running);
 }
});
