import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { ModelObservationViews, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start, factToWireObservation } from './fixtures/dynamic-main-fixture.mjs';

const record = { agentId: 'agent-a', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority', goalRevision: 3, currentGoal: 'explore' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sample = x => ({ ready: true, observedAtEpochMs: Date.now(), position: { x, y: 64, z: 0 }, player: { position: { x, y: 64, z: 0 }, health: 20 }, inventory: { items: [] } });
async function failMove(runtime, sent, x, callId) {
  const pending = runtime.execute({ agentId: record.agentId, goalRevision: 3, turnId: 'turn', callId, tool: { kind: 'start_action', actionType: 'move_to', arguments: { x, y: 64, z: 0, tolerance: 1 } } }, record);
  await tick(); await pending;
  const actionId = sent.at(-1).actionId;
  runtime.onActionResult(record, { actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: `blocked route to ${x}`, executionStarted: true, physicalAttempted: false });
  return { ...sample(0), lastResult: { present: true, actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: `blocked route to ${x}` } };
}

test('a historical status read must not make the current delivered failure owed again', async t => {
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
  t.after(() => runtime.disposeAll());
  const older = await failMove(runtime, sent, 9, 'older');
  runtime.decorateObservation(record, older);
  const current = await failMove(runtime, sent, 12, 'current');
  const reservation = {};
  runtime.decorateObservation(record, current, { reservation });
  runtime.settleFailureDelivery(reservation.failure, true);
  assert.equal(runtime.decorateObservation(record, current, { reservation: {} }).lastResult.failure, undefined);
  await runtime.execute({ agentId: record.agentId, goalRevision: 3, turnId: 'turn', callId: 'read-old', tool: { kind: 'action_status', actionId: older.lastResult.actionId } }, record);
  const repeated = runtime.decorateObservation(record, current, { reservation: {} });
  assert.equal(repeated.lastResult.failure, undefined);
});

test('a late failure from a pre-reset action still needs its target in the new context', async t => {
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
  t.after(() => runtime.disposeAll());
  const pending = runtime.execute({ agentId: record.agentId, goalRevision: 3, turnId: 'old-context', callId: 'late-result', tool: { kind: 'start_action', actionType: 'move_to', arguments: { x: 19, y: 64, z: 0, tolerance: 1 } } }, record);
  await tick(); await pending;
  const actionId = sent.at(-1).actionId;
  const views = new ModelObservationViews();
  views.reset();
  encodeNativeEventInput(`Wake.\n${JSON.stringify({ event: 'observation', observation: sample(0) })}`, views);
  runtime.onActionResult(record, { actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'blocked route to 19', executionStarted: true, physicalAttempted: false });
  const failure = { ...sample(0), lastResult: { present: true, actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'blocked route to 19' } };
  const wake = runtime.decorateObservation(record, failure, { reservation: {} });
  const encoded = encodeNativeEventInput(`Wake.\n${JSON.stringify({ event: 'action_result', observation: wake })}`, views);
  assert.match(encoded, /"tried":"move_to 19,64,0"/);
});

test('a rejected turn cleanup must retain the target of its still-owed failure', async t => {
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
  t.after(() => runtime.disposeAll());
  const failure = await failMove(runtime, sent, 23, 'rejected-target');
  const rejected = {};
  assert.equal(runtime.decorateObservation(record, failure, { reservation: rejected }).lastResult.failure.tried, 'move_to 23,64,0');
  runtime.settleFailureDelivery(rejected.failure, false);
  await runtime.dispose(record.agentId, 'native_turn_failed');
  const retry = runtime.decorateObservation(record, failure, { reservation: {} });
  const encoded = encodeNativeEventInput(`Wake.\n${JSON.stringify({ event: 'action_result', observation: retry })}`, new ModelObservationViews());
  assert.match(encoded, /"tried":"move_to 23,64,0"/);
});

test('an input consumed by a model tool call is delivered even if the rest of the turn fails', async () => {
  const registry = new AgentRegistry(), planner = new FakePlanner(registry), rows = [];
  planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  planner.requestNativeTurn = async request => {
    planner.requests.push(request);
    if (planner.requests.length === 2) {
      await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'consumed', callId: 'status-unknown', tool: { kind: 'action_status', actionId: 'unknown-action' } });
      throw Object.assign(new Error('provider failed after model consumed input and called a tool'), { code: 'INCOMPLETE_TURN' });
    }
    return { toolCalls: 0 };
  };
  const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
  const observation = (sequence, failed) => {
    const wire = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] }, world: { dimension: 'minecraft:overworld', gameTime: sequence, dayTime: sequence, raining: false, thundering: false } }, 1, sequence, true, Date.now(), ['blocks']);
    if (failed) wire.lastResult = { present: true, actionId: 'consumed-provider-action', actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'A concrete blocked route' };
    return { agentId: 'agent-a', payload: wire };
  };
  try {
    run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Explore' } });
    run.bridge.emit('observation', observation(1, false));
    await eventually(() => rows.some(row => row.event === 'native_turn_completed'));
    run.bridge.emit('observation', observation(2, true));
    await eventually(() => rows.some(row => row.event === 'native_turn_failed'));
    run.bridge.emit('observation', observation(3, true));
    await eventually(() => rows.filter(row => row.event === 'native_turn_completed').length >= 2);
    const third = JSON.parse(planner.requests[2].input.split('\n')[1]).observation.lastResult;
    assert.equal(third.failure, undefined);
  } finally { await run.coordinator.stop(); }
});

test('cleanup preserves each owed target and a historical read cannot consume a newer target', async t => {
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, _agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
  t.after(() => runtime.disposeAll());
  const older = await failMove(runtime, sent, 31, 'older-owed');
  const newer = await failMove(runtime, sent, 47, 'newer-owed');
  const oldReservation = {};
  assert.equal(runtime.decorateObservation(record, older, { reservation: oldReservation }).lastResult.failure.tried, 'move_to 31,64,0');
  runtime.settleFailureDelivery(oldReservation.failure, false);
  await runtime.execute({ agentId: record.agentId, goalRevision: 3, turnId: 'turn', callId: 'historical-read', tool: { kind: 'action_status', actionId: older.lastResult.actionId } }, record);
  await runtime.dispose(record.agentId, 'native_turn_failed');
  const retry = {};
  assert.equal(runtime.decorateObservation(record, newer, { reservation: retry }).lastResult.failure.tried, 'move_to 47,64,0');
  runtime.settleFailureDelivery(retry.failure, true);
  assert.equal(runtime.decorateObservation(record, newer, { reservation: {} }).lastResult.failure, undefined);
});

test('a retired body cannot lend its request target to a new lifecycle', async t => {
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, _agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
  t.after(() => runtime.disposeAll());
  const older = await failMove(runtime, sent, 53, 'retired-target');
  await runtime.dispose(record.agentId, 'goal_respawn');
  const next = { ...record, goalRevision: record.goalRevision + 1 };
  assert.equal(runtime.decorateObservation(next, older, { reservation: {} }).lastResult.failure.tried, undefined);
});
