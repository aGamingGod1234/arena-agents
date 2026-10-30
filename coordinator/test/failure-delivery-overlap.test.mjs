import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start, factToWireObservation, resolveNativeSteerInput } from './fixtures/dynamic-main-fixture.mjs';
const record = { agentId: 'claude-a', provider: 'claude', model: 'fixture', reasoningEffort: 'medium', serviceTier: 'priority', goalRevision: 0, currentGoal: 'explore' };
const sample = lastResult => ({ ready: true, observedAtEpochMs: Date.now(), player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] }, lastResult });
async function failMove(runtime, sent, x) {
  await runtime.execute({ agentId: record.agentId, goalRevision: 0, turnId: 'turn', callId: `move-${x}`, tool: { kind: 'start_action', actionType: 'move_to', arguments: { x, y: 64, z: 0, tolerance: 1 } } }, record);
  const actionId = sent.at(-1).actionId;
  runtime.onActionResult(record, { actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: `BLOCKER_${x}`, executionStarted: true, physicalAttempted: false });
  return sample({ present: true, actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: `BLOCKER_${x}` });
}
for (const cleanup of [false, true]) test(`late authoritative failure retains its target after uncertain dispatch, cleanup=${cleanup}`, async t => {
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => { if (type === 'action_command') { sent.push(payload); throw Object.assign(new Error('connection lost after send'), { code: 'BRIDGE_LOST' }); } } } });
  t.after(() => runtime.disposeAll());
  await assert.rejects(runtime.execute({ agentId: record.agentId, goalRevision: 0, turnId: 'turn', callId: 'uncertain', tool: { kind: 'start_action', actionType: 'move_to', arguments: { x: 111, y: 64, z: 0, tolerance: 1 } } }, record));
  const actionId = sent[0].actionId;
  const status = await runtime.execute({ agentId: record.agentId, goalRevision: 0, turnId: 'turn', callId: 'unknown-status', tool: { kind: 'action_status', actionId } }, record);
  assert.equal(status.state, 'UNKNOWN');
  assert.equal(status.arguments, undefined, 'request metadata stays private');
  if (cleanup) await runtime.dispose(record.agentId, 'native_turn_failed');
  assert.equal(runtime.onActionResult(record, { actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'LATE_BLOCKER', executionStarted: true, physicalAttempted: false }), true);
  const wake = runtime.decorateObservation(record, sample({ present: true, actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'LATE_BLOCKER' }), { reservation: {} });
  assert.equal(wake.lastResult.failure.tried, 'move_to 111,64,0');
});

test('accepted reservations for different failures both settle without replay', async t => {
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => { if (type === 'action_command') sent.push(payload); } } });
  t.after(() => runtime.disposeAll());
  const a = await failMove(runtime, sent, 21), b = await failMove(runtime, sent, 22);
  const ar = {}, br = {};
  runtime.decorateObservation(record, a, { reservation: ar });
  runtime.decorateObservation(record, b, { reservation: br });
  runtime.settleFailureDelivery(ar.failure, true);
  runtime.settleFailureDelivery(br.failure, true);
  const repeated = runtime.decorateObservation(record, a, { reservation: {} });
  assert.equal(repeated.lastResult.failure, undefined);
});

test('coordinator consumption still settles the original failure after a distinct steer', async () => {
  const registry = new AgentRegistry(), planner = new FakePlanner(registry), rows = [], steers = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  planner.requestNativeTurn = async request => {
    planner.requests.push(request);
    if (planner.requests.length === 1) await gate;
    return { status: 'completed', toolCalls: 0 };
  };
  planner.steerNativeTurn = async request => {
    await resolveNativeSteerInput(request);
    steers.push(request);
    await planner.requests[0].executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'consumed-after-steer', callId: 'status-unknown', tool: { kind: 'action_status', actionId: 'unknown-action' } });
    return { turnId: 'thinking' };
  };
  const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
  const observation = (sequence, action) => {
    const wire = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] }, world: { dimension: 'minecraft:overworld', gameTime: sequence, dayTime: sequence, raining: false, thundering: false } }, 1, sequence, true, Date.now(), ['blocks']);
    wire.lastResult = { present: true, actionId: action, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: `COORDINATOR_${action}` };
    return { agentId: 'agent-a', payload: wire };
  };
  try {
    run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Explore' } });
    run.bridge.emit('observation', observation(1, 'A'));
    await eventually(() => planner.requests.length === 1);
    assert.match(planner.requests[0].input, /COORDINATOR_A/);
    run.bridge.emit('observation', observation(2, 'B'));
    run.bridge.emit('conversation_event', { agentId: 'agent-a', payload: { sequence: 1, kind: 'player_message', sourceId: 'player-a', recipientId: 'agent-a', scope: 'direct', text: 'Continue exploring.', goalRevision: 1, observedAtEpochMs: Date.now() } });
    await eventually(() => rows.some(row => row.event === 'native_turn_steered'));
    assert.match(steers[0].input, /COORDINATOR_B/);
    release();
    await eventually(() => rows.filter(row => row.event === 'native_turn_completed').length >= planner.requests.length);
    const countBefore = planner.requests.length;
    run.bridge.emit('observation', observation(3, 'A'));
    await eventually(() => planner.requests.length > countBefore);
    const input = planner.requests.at(-1).input;
    assert.equal(JSON.parse(input.split('\n')[1]).observation.lastResult.failure, undefined);
  } finally { release(); await run.coordinator.stop(); }
});


for (const acceptA of [false, true]) test(`overlapping rejection settles only its own input, acceptA=${acceptA}`, async t => {
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => { if (type === 'action_command') sent.push(payload); } } });
  t.after(() => runtime.disposeAll());
  const a = await failMove(runtime, sent, 31), b = await failMove(runtime, sent, 32);
  const ar = {}, br = {};
  runtime.decorateObservation(record, a, { reservation: ar });
  runtime.decorateObservation(record, b, { reservation: br });
  // Complete the newer input first, as a fast steer can overtake the original turn.
  runtime.settleFailureDelivery(br.failure, !acceptA);
  runtime.settleFailureDelivery(ar.failure, acceptA);
  const consumed = acceptA ? a : b, owed = acceptA ? b : a;
  const stale = acceptA ? br.failure : ar.failure;
  assert.equal(runtime.decorateObservation(record, consumed, { reservation: {} }).lastResult.failure, undefined);
  const retry = {};
  assert.ok(runtime.decorateObservation(record, owed, { reservation: retry }).lastResult.failure);
  runtime.settleFailureDelivery(stale, true);
  runtime.settleFailureDelivery(retry.failure, false);
  assert.ok(runtime.decorateObservation(record, owed, { reservation: {} }).lastResult.failure, 'an old token cannot consume a replacement reservation');
});

test('retiring an uncertain receipt also retires its private request metadata', async t => {
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => {
    if (type === 'action_command') { sent.push(payload); throw new Error('lost publication'); }
  } } });
  t.after(() => runtime.disposeAll());
  await assert.rejects(runtime.execute({ agentId: record.agentId, goalRevision: 0, turnId: 'turn', callId: 'retired', tool: { kind: 'start_action', actionType: 'move_to', arguments: { x: 61, y: 64, z: 0, tolerance: 1 } } }, record));
  await runtime.dispose(record.agentId, 'goal_respawn');
  assert.equal(runtime.onActionResult(record, { actionId: sent[0].actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'retired failure' }), false);
});

// LIVE-STEER-001: a delivered failure retained in quiet snapshots must not steer every passive entity movement.
test('a delivered failure steers once while quiet entity motion keeps it retained', async () => {
  const registry = new AgentRegistry(), planner = new FakePlanner(registry), rows = [], steers = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  planner.requestNativeTurn = async request => { planner.requests.push(request); await gate; return { toolCalls: 1 }; };
  planner.steerNativeTurn = async request => { await resolveNativeSteerInput(request); steers.push(request); return { turnId: 'turn-1' }; };
  const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
  const observe = (sequence, { lastResult = { present: false }, health = 20 } = {}) => {
    const attention = health < 20;
    const wire = factToWireObservation({ player: { x: 0, y: 64, z: 0, health } }, 1, sequence, attention, 1_000 + sequence);
    // A passive cow wanders: only entity rows change, so the actionable signature changes every heartbeat.
    wire.entities = [{ uuid: 'cow-1', type: 'minecraft:cow', name: 'Cow', distance: 5 + sequence / 10, position: { x: 5 + sequence / 10, y: 64, z: 0 }, hostile: false, targetingAgent: false }];
    wire.lastResult = lastResult;
    run.bridge.emit('observation', { agentId: 'agent-a', payload: wire });
  };
  const failed = actionId => ({ present: true, actionId, actionType: 'navigate_to', state: 'FAILED', reasonCode: 'REACHED_FRONTIER', message: `FRONTIER_${actionId}` });
  const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat Minecraft.' } });
    observe(1);
    await eventually(() => planner.requests.length === 1);
    // The novel failure is owed to the model and steers the open turn once with its facts.
    observe(2, { lastResult: failed('action9') });
    await eventually(() => steers.length === 1);
    assert.match(steers[0].input, /REACHED_FRONTIER/);
    for (let sequence = 3; sequence <= 22; sequence++) { observe(sequence, { lastResult: failed('action9') }); await settle(); }
    assert.equal(steers.length, 1, `twenty quiet snapshots retaining the delivered failure add no steers (saw ${steers.length - 1} extra; 20 before the fix)`);
    // A different failed action is new information and still steers.
    observe(23, { lastResult: failed('action10') });
    await eventually(() => steers.length === 2);
    assert.match(steers[1].input, /FRONTIER_action10|REACHED_FRONTIER/);
    // Genuine damage still steers with urgent priority.
    observe(24, { lastResult: failed('action10'), health: 14 });
    await eventually(() => steers.length === 3);
    assert.equal(rows.filter(row => row.event === 'native_event_ready' && row.mode === 'steer').at(-1).priority, 'urgent');
    assert.equal(run.bridge.sent.filter(message => message.type === 'action_command').length, 0);
  } finally { release(); await run.coordinator.stop(); }
});

test('a rejected failure steer leaves the failure owed to the next quiet snapshot', async () => {
  const registry = new AgentRegistry(), planner = new FakePlanner(registry), attempts = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  planner.requestNativeTurn = async request => { planner.requests.push(request); await gate; return { toolCalls: 1 }; };
  planner.steerNativeTurn = async request => {
    await resolveNativeSteerInput(request);
    attempts.push(request);
    if (attempts.length === 1) throw Object.assign(new Error('steer rejected'), { code: 'STEER_REJECTED' });
    return { turnId: 'turn-1' };
  };
  const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
  const observe = (sequence, lastResult) => {
    const wire = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 } }, 1, sequence, false, 1_000 + sequence);
    wire.entities = [{ uuid: 'cow-1', type: 'minecraft:cow', name: 'Cow', distance: 5 + sequence / 10, position: { x: 5 + sequence / 10, y: 64, z: 0 }, hostile: false, targetingAgent: false }];
    wire.lastResult = lastResult;
    run.bridge.emit('observation', { agentId: 'agent-a', payload: wire });
  };
  const failed = { present: true, actionId: 'action9', actionType: 'navigate_to', state: 'FAILED', reasonCode: 'REACHED_FRONTIER', message: 'FRONTIER_action9' };
  try {
    run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat Minecraft.' } });
    observe(1, { present: false });
    await eventually(() => planner.requests.length === 1);
    observe(2, failed);
    await eventually(() => attempts.length === 1);
    observe(3, failed);
    await eventually(() => attempts.length >= 2);
    assert.ok(JSON.parse(attempts.at(-1).input.split('\n')[1]).observation.lastResult.failure, 'the owed failure keeps its facts after rejection');
  } finally { release(); await run.coordinator.stop(); }
});

test('a rejected failure steer retries through identical quiet heartbeats while the turn stays open', async () => {
  const registry = new AgentRegistry(), planner = new FakePlanner(registry), attempts = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  planner.requestNativeTurn = async request => { planner.requests.push(request); await gate; return { toolCalls: 1 }; };
  planner.steerNativeTurn = async request => {
    await resolveNativeSteerInput(request);
    attempts.push(request);
    if (attempts.length === 1) throw Object.assign(new Error('steer rejected'), { code: 'STEER_REJECTED' });
    return { turnId: 'turn-1' };
  };
  const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
  // Nothing moves: every snapshot after the failure has the same actionable signature.
  const observe = (sequence, lastResult) => {
    const wire = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 } }, 1, sequence, false, 1_000 + sequence);
    wire.lastResult = lastResult;
    run.bridge.emit('observation', { agentId: 'agent-a', payload: wire });
  };
  const failed = { present: true, actionId: 'action9', actionType: 'navigate_to', state: 'FAILED', reasonCode: 'REACHED_FRONTIER', message: 'FRONTIER_action9' };
  const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat Minecraft.' } });
    observe(1, { present: false });
    await eventually(() => planner.requests.length === 1);
    observe(2, failed);
    await eventually(() => attempts.length === 1);
    for (let sequence = 3; sequence <= 22; sequence++) { observe(sequence, failed); await settle(); }
    assert.equal(attempts.length, 2, `the owed failure is retried once and then settles (saw ${attempts.length} attempts)`);
    assert.ok(JSON.parse(attempts.at(-1).input.split('\n')[1]).observation.lastResult, 'the retry carries the failed result');
  } finally { release(); await run.coordinator.stop(); }
});

test('a failure the runtime only returned as a tool result still steers once until a steer is accepted', () => {
  const runtime = new NativeToolRuntime({ bridge: { send: async () => {} } });
  const failure = { present: true, actionId: 'action-blocking', actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'blocked' };
  // Executor bookkeeping (a blocking action returning its failure) marks the text delivered before publication.
  runtime.decorateObservation(record, sample(failure), { reservation: null, deliver: true });
  assert.equal(runtime.failureSteerOwed(record, failure), true, 'tool-result bookkeeping alone does not settle wake protection');
  const steer = {};
  runtime.decorateObservation(record, sample(failure), { reservation: steer });
  assert.ok(steer.steer, 'the steer input carries a steer token');
  assert.equal(runtime.failureSteerOwed(record, failure), false, 'a steer in flight is not repeated');
  runtime.settleFailureSteer(steer.steer, false);
  assert.equal(runtime.failureSteerOwed(record, failure), true, 'a rejected steer leaves the failure owed');
  const retry = {};
  runtime.decorateObservation(record, sample(failure), { reservation: retry });
  runtime.settleFailureSteer(retry.steer, true);
  assert.equal(runtime.failureSteerSettled(record, failure.actionId), true, 'an accepted steer settles it');
  assert.equal(runtime.failureSteerOwed(record, failure), false);
  runtime.disposeAll();
});

test('a failure whose steers are always rejected retries a bounded number of times on identical heartbeats', async () => {
  const registry = new AgentRegistry(), planner = new FakePlanner(registry), attempts = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  planner.requestNativeTurn = async request => { planner.requests.push(request); await gate; return { toolCalls: 1 }; };
  planner.steerNativeTurn = async request => {
    await resolveNativeSteerInput(request);
    attempts.push(request);
    throw Object.assign(new Error('steer rejected'), { code: 'STEER_REJECTED' });
  };
  const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
  const observe = (sequence, lastResult) => {
    const wire = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 } }, 1, sequence, false, 1_000 + sequence);
    wire.lastResult = lastResult;
    run.bridge.emit('observation', { agentId: 'agent-a', payload: wire });
  };
  const failed = { present: true, actionId: 'action9', actionType: 'navigate_to', state: 'FAILED', reasonCode: 'REACHED_FRONTIER', message: 'FRONTIER_action9' };
  const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat Minecraft.' } });
    observe(1, { present: false });
    await eventually(() => planner.requests.length === 1);
    observe(2, failed);
    await eventually(() => attempts.length === 1);
    for (let sequence = 3; sequence <= 102; sequence++) { observe(sequence, failed); await settle(); }
    assert.ok(attempts.length <= 3, `100 identical heartbeats after persistent rejection make at most 3 steer attempts (saw ${attempts.length})`);
  } finally { release(); await run.coordinator.stop(); }
});

for (const [snapshots, builder] of [['moving', true], ['moving', false], ['identical', false]]) {
  test(`review r3: rejected failure steers stay bounded with ${snapshots} snapshots, input ${builder ? 'built' : 'never built'}, and the successor carries one failure envelope`, async () => {
    const registry = new AgentRegistry(), planner = new FakePlanner(registry);
    let attempts = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    planner.requestNativeTurn = async request => { planner.requests.push(request); if (planner.requests.length === 1) await gate; return { toolCalls: 1 }; };
    planner.steerNativeTurn = async request => {
      attempts++;
      // A provider can refuse a steer before it ever asks for the input.
      if (builder) await resolveNativeSteerInput(request);
      throw Object.assign(new Error('steer rejected'), { code: 'STEER_REJECTED' });
    };
    const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
    const observe = (sequence, lastResult) => {
      const wire = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 } }, 1, sequence, false, 1_000 + sequence);
      if (snapshots === 'moving') wire.entities = [{ uuid: 'cow-1', type: 'minecraft:cow', name: 'Cow', distance: 5 + sequence / 100, position: { x: 5 + sequence / 100, y: 64, z: 0 }, hostile: false, targetingAgent: false }];
      wire.lastResult = lastResult;
      run.bridge.emit('observation', { agentId: 'agent-a', payload: wire });
    };
    const failed = { present: true, actionId: 'action9', actionType: 'navigate_to', state: 'FAILED', reasonCode: 'REACHED_FRONTIER', message: 'FRONTIER_action9' };
    const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
    try {
      run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat Minecraft.' } });
      observe(1, { present: false });
      await eventually(() => planner.requests.length === 1);
      observe(2, failed);
      await eventually(() => attempts >= 1);
      for (let sequence = 3; sequence <= 202; sequence++) { observe(sequence, failed); await settle(); }
      assert.ok(attempts <= 3, `200 heartbeats after persistent rejection make at most 3 steer attempts (saw ${attempts}; 201 before the fix)`);
      release();
      await eventually(() => planner.requests.length >= 2);
      const successor = planner.requests[1];
      const envelopes = successor.nativeEvent?.mergedEvents ?? [successor.nativeEvent];
      const failureCopies = envelopes.filter(event => event?.observation?.lastResult?.actionId === 'action9').length;
      assert.ok(failureCopies <= 1, `the successor carries the owed failure once, not once per heartbeat (saw ${failureCopies})`);
    } finally { release(); await run.coordinator.stop(); }
  });
}
