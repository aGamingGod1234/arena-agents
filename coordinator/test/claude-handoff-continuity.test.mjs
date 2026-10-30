import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, profile } from './fixtures/claude-service-fixture.mjs';
const event = 'Live Minecraft event\n' + JSON.stringify({ goal: 'Beat Minecraft', goalRevision: 0, observation: { player: { health: 20 }, lastResult: { actionType: 'navigate', state: 'RUNNING', reasonCode: 'ACTION_STARTED' } } });
function usage(child, id, context) {
  child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 5, cache_read_input_tokens: context, cache_creation_input_tokens: 200, output_tokens: 1 } } } });
  child.emitLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });
  child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
}
const done = child => child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fixture' });
const observations = {};

// The preceding turn produced an action handle; this turn has only read tools.
for (const terminal of [false, true]) test(`handoff retains prior-turn ${terminal ? 'terminal' : 'running'} handle after six reads`, async () => {
  const handle = terminal ? 'native:prior-finished-action' : 'native:prior-open-action';
  const input = terminal ? 'Live Minecraft event\n' + JSON.stringify({ goal: 'Beat Minecraft', goalRevision: 0, observation: { player: { health: 20 }, lastResult: { actionType: 'navigate_to', state: 'FAILED', reasonCode: 'TIMED_OUT' } } }) : event;
  let executions = 0;
  const h = await harness({ async onUser(child, content) {
    child.received = [...(child.received ?? []), content];
    if (h.children.indexOf(child) > 0) { done(child); return; }
    if (child.received.length === 1) {
      usage(child, 'prior-turn', 30_000);
      const started = await child.rpc('tools/call', terminal
        ? { name: 'moveTo', arguments: { x: 100, y: 64, z: 100 } }
        : { name: 'startAction', arguments: { actionType: 'navigate_to', arguments: { x: 100, y: 64, z: 100 } } });
      assert.ok(JSON.stringify(started).includes(handle));
      if (!terminal) await child.rpc('tools/call', { name: 'startAction', arguments: { actionType: 'navigate_to', arguments: { x: 101, y: 64, z: 100 } } });
      done(child); return;
    }
    for (let i = 0; i < 6; i++) {
      usage(child, `read-${i}`, i === 5 ? 85_000 : 40_000);
      const reply = await child.rpc('tools/call', { name: 'capabilities', arguments: { section: 'control' } });
      if (JSON.stringify(reply).includes('SESSION_ROTATED')) return;
    }
    done(child);
  } }, { contextRotationTokens: 80_000 });
  try {
    const a = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    const executeTool = async ({ tool }) => {
      executions++;
      return ['action', 'start_action'].includes(tool.kind) ? { state: terminal ? 'FAILED' : 'RUNNING', reasonCode: terminal ? 'TIMED_OUT' : 'ACTION_STARTED', actionId: !terminal && executions === 2 ? 'native:second-open-action' : handle } : { section: 'control', tools: [] };
    };
    await a.act(input, { goalRevision: 0, executeTool });
    await a.act(input, { goalRevision: 0, executeTool });
    const handoff = h.children[1].received[0];
    const key = terminal ? 'priorTurnTerminalHandle' : 'priorTurnHandle';
    observations[key] = { children: h.children.length, executions, handlePresent: handoff.includes(handle), handoff };
    assert.equal(executions, terminal ? 7 : 8);
    if (!terminal) assert.match(handoff, /native:second-open-action/);
    assert.equal(observations[key].handlePresent, true);
  } finally { await h.close(); }
});

// A failure that the first replacement sees is not restated at the second replacement.
for (const state of ['FAILED', 'REJECTED']) test(`second handoff retains delivered ${state} blocker and partial effect`, async () => {
  let executions = 0;
  const h = await harness({ async onUser(child, content) {
    child.received = [...(child.received ?? []), content];
    const index = h.children.indexOf(child);
    if (index === 2) { done(child); return; }
    const contexts = index === 0 ? [85_000] : [40_000, 85_000, 165_000];
    for (let i = 0; i < contexts.length; i++) {
      usage(child, `${index}-${i}`, contexts[i]);
      const reply = await child.rpc('tools/call', index === 0
        ? { name: 'moveTo', arguments: { x: 100, y: 64, z: 100 } }
        : { name: 'capabilities', arguments: { section: 'control' } });
      if (JSON.stringify(reply).includes('SESSION_ROTATED')) return;
    }
    done(child);
  } }, { contextRotationTokens: 80_000 });
  try {
    const a = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    await a.act(event, { goalRevision: 0, executeTool: async () => ++executions === 1
      ? { state, reasonCode: 'FIXTURE_BLOCKED', actionId: 'native:failed', message: 'fixture blocker: target is behind the closed gate', failure: { tried: 'navigate to fixture target', changed: 'moved 1m', blockedBy: 'fixture blocker: target is behind the closed gate' } }
      : { section: 'control', tools: [] } });
    const first = h.children[1].received[0], second = h.children[2].received[0];
    observations.secondHandoffFailure = { executions, firstHasBlocker: first.includes('target is behind the closed gate'), secondHasBlocker: second.includes('target is behind the closed gate'), secondHasCode: second.includes('FIXTURE_BLOCKED'), first, second };
    assert.equal(observations.secondHandoffFailure.firstHasBlocker, true);
    assert.equal(observations.secondHandoffFailure.secondHasBlocker, true);
    assert.match(second, /moved 1m/);
    assert.match(second, /navigate to fixture target/);
  } finally { await h.close(); }
});

for (const placement of ['root', 'merged-observation', 'merged-program', 'merged-program-receipt'])
for (const steerKind of ['none', 'same-action', 'different-action']) test(`${placement} reserved event failure survives two handoffs exactly once with ${steerKind} steer`, async () => {
  const original = { actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', failure: { tried: 'move_to 27,64,0', blockedBy: 'ORIGINAL_BLOCKER', changed: 'moved 1m', repeat: { count: 2 }, validWhen: 'route clear' } };
  const next = { actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', failure: { tried: 'move_to 99,64,0', blockedBy: 'OTHER_BLOCKER' } };
  const input = value => `Wake.\n${JSON.stringify({ observation: { lastResult: value } })}`;
  let agent, steer, executions = 0;
  const h = await harness({ async onUser(child, content) {
    child.received = [...(child.received ?? []), content];
    const index = h.children.indexOf(child);
    if (index === 2) { done(child); return; }
    for (const [step, context] of (index === 0 ? [85_000] : [40_000, 165_000]).entries()) {
      usage(child, `reserved-${index}-${step}`, context);
      const reply = await child.rpc('tools/call', { name: 'say', arguments: { message: 'continue' } });
      if (JSON.stringify(reply).includes('SESSION_ROTATED')) { done(child); return; }
    }
    done(child);
  } }, { contextRotationTokens: 80_000 });
  try {
    agent = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    const initial = placement === 'root' ? input(original) : `Wake.\n${JSON.stringify({ event: 'program_ended', program: { programId: 'new-success', result: { state: 'SUCCEEDED' } }, mergedEvents: [placement === 'merged-observation' ? { event: 'action_result', observation: { lastResult: original } } : { event: 'program_ended', program: { programId: 'failed-program', result: placement === 'merged-program' ? { state: original.state, reasonCode: original.reasonCode, failure: original.failure } : { state: 'FAILED', reasonCode: 'PROGRAM_FAILED', receipts: [{ ...original, actionId: 'failed-action' }] } } }] })}`;
    await agent.act(initial, { goalRevision: 0, executeTool: async () => {
      if (++executions === 1 && steerKind !== 'none') steer = agent.steer(input(steerKind === 'different-action' ? next : { actionType: original.actionType, state: original.state, reasonCode: original.reasonCode }), { goalRevision: 0 });
      return { state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' };
    } });
    if (steer) await steer;
    assert.equal(h.children.length, 3);
    for (const child of h.children.slice(1)) {
      const handoff = child.received[0];
      for (const fact of ['ORIGINAL_BLOCKER', 'move_to 27,64,0', 'moved 1m', 'route clear']) assert.equal(handoff.split(fact).length - 1, 1, fact);
      if (steerKind === 'different-action') for (const fact of ['OTHER_BLOCKER', 'move_to 99,64,0']) assert.equal(handoff.split(fact).length - 1, 1, fact);
    }
  } finally { await h.close(); }
});

for (const steerKind of ['same-action', 'different-action']) test(`bare failed receipt in succeeded program survives two handoffs with ${steerKind} steer`, async () => {
  const original = { actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', failure: { tried: 'move_to 27,64,0', blockedBy: 'ORIGINAL_BLOCKER', changed: 'moved 1m', repeat: { count: 2 }, validWhen: 'route clear' } };
  const next = { actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', failure: { tried: 'move_to 99,64,0', blockedBy: 'OTHER_BLOCKER' } };
  const input = value => `Wake.\n${JSON.stringify({ observation: { lastResult: value } })}`;
  let agent, steer, executions = 0;
  const h = await harness({ async onUser(child, content) {
    child.received = [...(child.received ?? []), content];
    const index = h.children.indexOf(child);
    if (index === 2) { done(child); return; }
    for (const [step, context] of (index === 0 ? [85_000] : [40_000, 165_000]).entries()) {
      usage(child, `reserved-${index}-${step}`, context);
      const reply = await child.rpc('tools/call', { name: 'say', arguments: { message: 'continue' } });
      if (JSON.stringify(reply).includes('SESSION_ROTATED')) { done(child); return; }
    }
    done(child);
  } }, { contextRotationTokens: 80_000 });
  try {
    agent = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    const initial = `Wake.\n${JSON.stringify({ event: 'program_ended', program: { programId: 'caught-failure', result: { state: 'SUCCEEDED', reasonCode: 'PROGRAM_EXHAUSTED', receipts: [{ actionId: 'executor:failed-action', actionType: 'move_to', sourceStepId: 'step:1', state: 'FAILED', reasonCode: 'BARE_RECEIPT_NO_PATH' }] } } })}`;
    await agent.act(initial, { goalRevision: 0, executeTool: async () => {
      if (++executions === 1 && steerKind !== 'none') steer = agent.steer(input(steerKind === 'different-action' ? next : { actionType: original.actionType, state: original.state, reasonCode: original.reasonCode }), { goalRevision: 0 });
      return { state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' };
    } });
    if (steer) await steer;
    assert.equal(h.children.length, 3);
    for (const child of h.children.slice(1)) {
      const handoff = child.received[0];
      // Terminal handle digests also name this receipt; its factual carry-over is retained once.
      const receipts = handoff.split('\n').filter(line => line.startsWith('Earlier failure receipt:'));
      assert.equal(receipts.filter(line => line.includes('executor:failed-action') && line.includes('BARE_RECEIPT_NO_PATH')).length, 1);
      assert.doesNotMatch(handoff, /not reported/);
      if (steerKind === 'different-action') for (const fact of ['OTHER_BLOCKER', 'move_to 99,64,0']) assert.equal(handoff.split(fact).length - 1, 1, fact);
    }
  } finally { await h.close(); }
});

test('internal action identity joins compact event and named status through a newer steer and second handoff', async () => {
  const receipt = { actionId: 'native:correlated', actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', failure: { tried: 'move_to 27,64,0', blockedBy: 'CORRELATED_BLOCKER' } };
  const { actionId, ...compact } = receipt;
  const input = `Wake.\n${JSON.stringify({ event: 'observation', _actionReceipt: { actionId, state: receipt.state, reasonCode: receipt.reasonCode }, observation: { lastResult: compact } })}`;
  let agent, steer, calls = 0;
  const h = await harness({ async onUser(child, content) {
    child.received = [...(child.received ?? []), content];
    const index = h.children.indexOf(child);
    if (index === 2) { done(child); return; }
    for (const [step, context] of (index === 0 ? [85_000] : [40_000, 165_000]).entries()) {
      usage(child, `correlated-${index}-${step}`, context);
      const reply = await child.rpc('tools/call', index === 0
        ? { name: 'actionStatus', arguments: { actionId } }
        : { name: 'say', arguments: { message: 'continue' } });
      if (JSON.stringify(reply).includes('SESSION_ROTATED')) { done(child); return; }
    }
    done(child);
  } }, { contextRotationTokens: 80_000 });
  try {
    agent = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    await agent.act(input, { goalRevision: 0, executeTool: async () => {
      if (++calls === 1) return { ...receipt, failure: { blockedBy: receipt.failure.blockedBy } };
      if (calls === 2) steer = agent.steer('Wake.\n' + JSON.stringify({ observation: { player: { health: 19 } } }), { goalRevision: 0 });
      return { state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' };
    } });
    if (steer) await steer;
    assert.equal(h.children.length, 3);
    for (const child of h.children.slice(1)) {
      const handoff = child.received[0];
      assert.equal(handoff.split('CORRELATED_BLOCKER').length - 1, 1);
      assert.equal(handoff.split('move_to 27,64,0').length - 1, 1);
      assert.doesNotMatch(handoff, /_actionReceipt/);
    }
  } finally { await h.close(); }
});

for (const envelope of ['sequence', 'program']) test(`${envelope} nested failure keeps target, blocker and effect through three handoffs`, async () => {
  const failure = { actionId: 'nested:failed', actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', failure: { tried: 'move_to 121,64,0', changed: 'moved 1m', blockedBy: 'NESTED_SEQUENCE_BLOCKER' } };
  let executions = 0;
  const h = await harness({ async onUser(child, content) {
    child.received = [...(child.received ?? []), content];
    const index = h.children.indexOf(child);
    if (index === 3) { done(child); return; }
    for (const [step, context] of (index === 0 ? [70_000] : [30_000, 800_000]).entries()) {
      usage(child, `nested-${index}-${step}`, context);
      const reply = await child.rpc('tools/call', index === 0 && envelope === 'sequence'
        ? { name: 'sequence', arguments: { actions: [{ actionType: 'move_to', arguments: { x: 121, y: 64, z: 0, tolerance: 1 } }, { actionType: 'move_to', arguments: { x: 123, y: 64, z: 0, tolerance: 1 } }] } }
        : { name: 'say', arguments: { message: 'continue' } });
      if (JSON.stringify(reply).includes('SESSION_ROTATED')) { done(child); return; }
    }
    done(child);
  } }, { contextRotationTokens: 64_000 });
  try {
    const a = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    await a.act(event, { goalRevision: 0, executeTool: async () => ++executions !== 1
      ? { state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' }
      : envelope === 'sequence' ? { state: 'FAILED', results: [failure] }
        : { programId: 'program:fixture', result: { state: 'FAILED', receipts: [failure] } } });
    assert.equal(h.children.length, 4);
    for (const child of h.children.slice(1)) for (const fact of ['NESTED_SEQUENCE_BLOCKER', 'move_to 121,64,0', 'moved 1m']) {
      assert.equal(child.received[0].split(fact).length - 1, 1, fact);
    }
  } finally { await h.close(); }
});
