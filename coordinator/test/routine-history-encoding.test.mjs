import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION } from '../src/native-event-instructions.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, factToWireObservation, start } from './fixtures/dynamic-main-fixture.mjs';

const record = { currentGoal: 'Travel', goalRevision: 1 };
const payload = input => decodeModelFacts(JSON.parse(input.split('\n')[1]));
function wake({ health = 11, x = 10, dayTime = 6000, actionId = 'native:travel:1', active = true,
 actionType = 'move_to', startHealth = 11, reducedDebugInfo = false } = {}) {
 const currentAction = { active, actionId, actionType };
 return {
  event: 'observation', trigger: 'update',
  runningAction: { ...currentAction, arguments: { x: 40, y: 64, z: 40, fleeAtHealth: 6 } },
  runningActionStart: { actionId, health: startHealth },
  observation: {
   player: { x, y: 64, z: 0, health, skyOpen: true }, currentAction,
   world: { worldId: 'history-world', dimension: 'minecraft:overworld', dayTime, reducedDebugInfo },
   inventory: { items: [] }, items: [], entities: [],
   blocks: Array.from({ length: 24 }, (_, x) => ({ x, y: 64, z: 0, blockId: 'minecraft:stone' })),
  },
 };
}

function session() {
 const views = new ModelObservationViews();
 const delivered = new Map();
 return options => {
  const raw = buildNativeEventInput(record, wake(options));
  const original = payload(raw).observation;
  const event = payload(encodeNativeEventInput(raw, views));
  const view = event.observationView;
  let observation;
  if (view.mode === 'full') observation = structuredClone(event.observation);
  else {
   assert.ok(delivered.has(view.baseId), 'changes name an actually delivered baseline');
   observation = structuredClone(delivered.get(view.baseId));
   Object.assign(observation, structuredClone(view.replace));
   for (const key of view.remove) delete observation[key];
  }
  delivered.set(view.id, observation);
  const expected = { ...structuredClone(payload(raw).hud), ...structuredClone(original) };
  const action = expected.currentAction;
  if (Object.hasOwn(action, 'left')) {
   expected.actionDistance = action.left;
   delete action.left;
  }
  if (Object.hasOwn(action, 'hurtWhileRunning')) {
   expected.hurtWhileRunning = action.hurtWhileRunning;
   delete action.hurtWhileRunning;
  }
  assert.deepEqual(observation, expected, 'applying section replacements and removals reconstructs all presented facts');
  return { event, view, observation, original };
 };
}

test('damage and movement replace separate facts without resending unchanged running intent', () => {
 const deliver = session();
 const healthy = deliver();
 assert.equal(healthy.view.mode, 'full');
 assert.equal(healthy.observation.currentAction.to, '40,64,40');
 assert.equal(healthy.observation.actionDistance, 50);
 assert.equal(healthy.observation.hurtWhileRunning, undefined);
 const hurt = deliver({ health: 8 });
 assert.equal(hurt.view.mode, 'changes');
 assert.equal(hurt.view.replace.currentAction, undefined);
 assert.equal(hurt.view.replace.actionDistance, undefined, 'health loss does not resend unchanged distance');
 assert.equal(hurt.view.replace.hurtWhileRunning, '11->8');
 assert.equal(hurt.original.currentAction.hurtWhileRunning, '11->8', 'raw builder contract is unchanged');
 const repeated = deliver({ health: 8 });
 assert.equal(repeated.view.mode, 'changes');
 assert.equal(repeated.view.replace.player, undefined, 'unchanged damage is retained, not resent');
 assert.equal(repeated.view.replace.hurtWhileRunning, undefined);
 assert.equal(repeated.observation.hurtWhileRunning, '11->8');
 const furtherHurt = deliver({ health: 6 });
 assert.equal(furtherHurt.view.replace.currentAction, undefined);
 assert.equal(furtherHurt.view.replace.hurtWhileRunning, '11->6');
 const movedWhileHurt = deliver({ health: 6, x: 40 });
 assert.equal(movedWhileHurt.view.replace.currentAction, undefined);
 assert.equal(movedWhileHurt.view.replace.hurtWhileRunning, undefined, 'movement does not resend unchanged health trend');
 assert.equal(movedWhileHurt.observation.hurtWhileRunning, '11->6');
 const partialHealing = deliver({ health: 9 });
 assert.equal(partialHealing.observation.hurtWhileRunning, '11->9', 'remaining net loss stays factual');
 const healed = deliver({ health: 11 });
 assert.equal(healed.view.replace.currentAction, undefined);
 assert.equal(healed.observation.hurtWhileRunning, undefined, 'no damage trend survives restored health');
 assert.ok(healed.view.remove.includes('hurtWhileRunning'));
 const moved = deliver({ x: 40 });
 assert.equal(moved.view.replace.currentAction, undefined);
 assert.equal(moved.observation.actionDistance, 40);
 const replacement = deliver({ x: 40, health: 6, actionId: 'native:travel:2', startHealth: 6 });
 assert.equal(replacement.observation.currentAction.actionId, 'native:travel:2');
 assert.equal(replacement.observation.hurtWhileRunning, undefined, 'prior action loss does not transfer');
 const ended = deliver({ x: 40, health: 6, actionId: 'native:travel:2', active: false });
 assert.equal(ended.observation.currentAction.active, false);
 assert.equal(ended.observation.actionDistance, undefined);
 assert.equal(ended.observation.hurtWhileRunning, undefined);
 assert.ok(ended.view.remove.includes('actionDistance'));
});

test('coarse sunset facts do not replace the world every tick', () => {
 const deliver = session();
 deliver({ dayTime: 11000 });
 for (const dayTime of [11001, 11770, 12999]) {
  const next = deliver({ dayTime });
  assert.equal(next.view.mode, 'changes');
  assert.equal(next.view.replace.world, undefined);
  assert.equal(next.observation.world.darkIn, 'unknown');
 }
 const night = deliver({ dayTime: 13000 });
 assert.equal(night.observation.sky, 'night');
 assert.equal(night.observation.world.darkIn, undefined);
});

test('fight bailout stays in retained intent and reduced debug never invents action distance', () => {
 const fight = session();
 fight({ actionType: 'fight_target' });
 const hurt = fight({ actionType: 'fight_target', health: 8 });
 assert.equal(hurt.view.mode, 'changes');
 assert.equal(hurt.view.replace.currentAction, undefined);
 assert.equal(hurt.observation.currentAction.fleeAtHealth, 6);
 assert.equal(hurt.observation.hurtWhileRunning, '11->8');
 assert.equal(hurt.observation.actionDistance, undefined);
 const reduced = session()({ reducedDebugInfo: true, health: 8 });
 assert.equal(reduced.observation.currentAction.to, '40,64,40');
 assert.equal(reduced.observation.actionDistance, undefined);
 assert.equal(reduced.observation.hurtWhileRunning, '11->8');
});

test('generic fact encoding and observe tool views preserve their original currentAction contract', () => {
 const observation = payload(buildNativeEventInput(record, wake({ health: 8 }))).observation;
 const source = { observation, freshness: { fresh: true } };
 assert.deepEqual(decodeModelFacts(encodeModelFacts(source)), source);
 const views = new ModelObservationViews();
 const first = views.prepare(source, { kind: 'observe' });
 first.commit();
 assert.deepEqual(first.value.observation.currentAction, observation.currentAction);
 const next = structuredClone(source);
 next.observation.currentAction.hurtWhileRunning = '11->6';
 const changed = views.prepare(next, { kind: 'observe', view: 'changes', afterObservationId: first.value.observationView.id });
 assert.equal(changed.value.observationView.mode, 'changes');
 assert.equal(changed.value.observationView.replace.currentAction.hurtWhileRunning, '11->6');
 assert.equal(changed.value.observationView.replace.player, undefined);
});

test('compact new-context wakes retain orientation while unchanged healthy action facts remain reconstructible', () => {
 const views = new ModelObservationViews();
 const raw = buildNativeEventInput(record, { ...wake(), newContext: true,
  progress: { done: ['Collected wood'], next: ['Reach the authored destination'] } });
 assert.equal(raw.split('\n')[0], ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION);
 const value = payload(raw);
 value.now = { task: 'Travel to the authored destination', last: 'The running move has not ended' };
 const send = line => payload(encodeNativeEventInput(`${line}\n${JSON.stringify(value)}`, views));
 const first = send(ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION);
 assert.equal(first.observationView.mode, 'full');
 const ordinary = send('Update; act on fresh facts.');
 for (const key of ['now', 'situation', 'progress']) {
  assert.ok(ordinary.sameAsPreviousEvent.includes(key), `${key} qualifies for normal metadata retention`);
 }
 const nextContext = send(ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION);
 for (const key of ['now', 'situation', 'progress']) {
  assert.deepEqual(nextContext[key], value[key], `${key} remains explicit at the compact context boundary`);
  assert.ok(!nextContext.sameAsPreviousEvent?.includes(key));
 }
 let reconstructed = structuredClone(first.observation);
 let lastId = first.observationView.id;
 for (const event of [ordinary, nextContext]) {
  const view = event.observationView;
  assert.equal(view.mode, 'changes');
  assert.equal(view.baseId, lastId);
  Object.assign(reconstructed, structuredClone(view.replace));
  for (const key of view.remove) delete reconstructed[key];
  assert.deepEqual(reconstructed, first.observation, 'unchanged facts survive explicit baseline reuse');
  assert.equal(reconstructed.currentAction.to, '40,64,40');
  assert.equal(reconstructed.actionDistance, 50);
  assert.equal(reconstructed.health, 11);
  assert.equal(reconstructed.hurtWhileRunning, undefined);
  lastId = view.id;
 }
});

test('successful compact new-context delivery settles the coordinator assessment exactly once', async t => {
 const registry = new AgentRegistry();
 const planner = new FakePlanner(registry);
 const completed = [];
 planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
 planner.requestNativeTurn = async request => {
  planner.requests.push(request);
  return { toolCalls: 0 };
 };
 const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(),
  traceWriter: { write(event, fields) { if (event === 'native_turn_completed') completed.push(fields); } },
  config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } },
 });
 t.after(() => run.coordinator.stop());
 run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat the game.' } });
 const observe = sequence => {
  const wire = factToWireObservation({
   player: { x: sequence, y: 64, z: 0, health: 20, skyOpen: true },
   world: { dimension: 'minecraft:overworld', gameTime: 1000 + sequence, dayTime: 11770, raining: false, thundering: false },
   inventory: { items: [], tagCounts: {} }, items: [], entities: [], blocks: [],
  }, 1, sequence, true, sequence, ['blocks']);
  wire.player.skyOpen = true;
  run.bridge.emit('observation', { agentId: 'agent-a', payload: wire });
 };
 observe(1);
 await eventually(() => completed.length === 1);
 assert.equal(planner.requests[0].input.split('\n')[0], ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION);
 assert.equal(payload(planner.requests[0].input).observation.world.darkIn, 'unknown');
 observe(2);
 await eventually(() => completed.length === 2);
 assert.match(planner.requests[1].input.split('\n')[0], /^sunset under open sky\./,
  'successful compact assessment delivery clears the pending context');
 assert.equal(payload(planner.requests[1].input).observation.world.darkIn, 'unknown');
});
