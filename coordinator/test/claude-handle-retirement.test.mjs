import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, profile } from './fixtures/claude-service-fixture.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { ToolDigests } from '../src/context-carry-over.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { encodeNativeEventInput, decodeModelFacts } from '../src/model-fact-encoding.mjs';
const event = lastResult => `Wake.\n${JSON.stringify({ event: 'observation', goalRevision: 0, observation: { player: { health: 20 }, lastResult } })}`;
const done = child => child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fixture' });
function usage(child, id, context) {
  child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 5, cache_read_input_tokens: context, cache_creation_input_tokens: 200, output_tokens: 1 } } } });
  child.emitLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });
  child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
}
for (const count of [20, 60]) test(`${count} asynchronous completions delivered by steer retire across two handoffs`, async t => {
  const sent = [], ids = [], steers = [], handoffs = [];
  const record = { ...profile(), goalRevision: 0, currentGoal: 'explore' };
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => { if (type === 'action_command') sent.push(payload); } } });
  let agent, scriptError;
  const h = await harness({ async onUser(child, content) {
    try {
      const generation = h.children.indexOf(child);
      if (generation > 0) handoffs.push(content);
      if (generation === 2) { done(child); return; }
      for (let i = 0; i < count; i++) {
        usage(child, `start-${generation}-${i}`, 30_000);
        await child.rpc('tools/call', { name: 'startAction', arguments: { actionType: 'move_to', arguments: { x: i + 1, y: 64, z: 0, tolerance: 1 } }, _meta: { 'claudecode/toolUseId': `start-${generation}-${i}` } });
        const actionId = sent.at(-1).actionId;
        ids.push(actionId);
        assert.equal(runtime.onActionResult(record, { actionId, state: 'SUCCEEDED', reasonCode: 'DESTINATION_REACHED' }), true);
        const terminal = await runtime.execute({ agentId: record.agentId, goalRevision: 0, turnId: 'verify', callId: 'status', tool: { kind: 'action_status', actionId } }, record);
        steers.push(agent.steer(event(terminal), { goalRevision: 0 }));
        usage(child, `read-${generation}-${i}`, i === count - 1 ? 800_000 : 30_000);
        const reply = await child.rpc('tools/call', { name: 'capabilities', arguments: { section: 'control' } });
        if (JSON.stringify(reply).includes('SESSION_ROTATED')) return;
      }
      done(child);
    } catch (error) { scriptError = error; done(child); }
  } }, { contextRotationTokens: 80_000 });
  try {
    agent = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    await agent.act(event(null), { goalRevision: 0, executeTool: request => request.tool.kind === 'start_action' ? runtime.execute(request, record) : { section: 'control', tools: [] } });
    if (scriptError) throw scriptError;
    await Promise.all(steers);
    assert.equal(handoffs.length, 2);
    assert.equal(runtime.hasCurrent(record), false);
    t.diagnostic(`handoff bytes: ${handoffs.map(value => Buffer.byteLength(value)).join(', ')}`);
    for (const [index, handoff] of handoffs.entries()) {
      assert.doesNotMatch(handoff, /startAction[^\n]*RUNNING[^\n]*actionId=/);
      assert.ok(handoff.includes(ids[(index + 1) * count - 1]));
      assert.ok(!handoff.includes(ids[0]), 'old completed IDs leave the replacement');
      assert.ok(Buffer.byteLength(handoff) < 3000, `handoff bytes ${Buffer.byteLength(handoff)}`);
    }
  } finally { await h.close(); runtime.disposeAll(); }
});

test('nested receipts retire their own IDs and invalidation retires handles without truncating open IDs', () => {
  const digests = new ToolDigests(2);
  const open = `still-open:${'x'.repeat(120)}`;
  for (const actionId of ['replaced', 'observed', open]) digests.push('startAction', '{}', { state: 'RUNNING', actionId });
  digests.push('observe', '{}', { postAction: { observation: { lastResult: { actionId: 'observed', state: 'SUCCEEDED' } } }, replacedAction: { actionId: 'replaced', state: 'CANCELLED' } });
  for (let i = 0; i < 6; i++) digests.push('observe', '{}', {});
  assert.ok(digests.lines().join('\n').includes(open));
  assert.doesNotMatch(digests.lines().join('\n'), /observed/);
  assert.match(digests.lines().join('\n'), /replaced/);
  digests.invalidateHandles();
  assert.doesNotMatch(digests.lines().join('\n'), /actionId=/);
});

test('compacted terminal event preserves exact identity internally and strips it before model presentation', () => {
  const actionId = `terminal:${'z'.repeat(120)}`;
  const input = buildNativeEventInput({ ...profile(), currentGoal: 'explore', goalRevision: 0 }, { event: 'program_planning_due', observation: { player: { health: 20 }, lastResult: { actionId, state: 'SUCCEEDED', reasonCode: 'DESTINATION_REACHED' } } });
  const value = JSON.parse(input.slice(input.indexOf('\n') + 1));
  assert.equal(value._actionReceipt.actionId, actionId);
  const digests = new ToolDigests(1);
  digests.push('startAction', '{}', { actionId, state: 'RUNNING' });
  digests.noteDelivered(value);
  digests.push('observe', '{}', {});
  assert.match(digests.lines().join('\n'), /SUCCEEDED/);
  assert.doesNotMatch(digests.lines().join('\n'), /RUNNING/);
  assert.ok(digests.lines().join('\n').includes(actionId));
  const encoded = encodeNativeEventInput(input);
  assert.ok(!encoded.includes('_actionReceipt'));
  const presented = decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n') + 1)));
  assert.equal(presented.observation.lastResult.state, 'SUCCEEDED');
});


test('unidentified terminal facts never guess a handle; UNKNOWN_ACTION invalidates only the exact ID', () => {
  const digests = new ToolDigests(2);
  for (const actionId of ['left-open', 'invalid']) digests.push('startAction', '{}', { actionId, state: 'RUNNING' });
  digests.noteDelivered({ observation: { lastResult: { actionType: 'move_to', state: 'SUCCEEDED', reasonCode: 'DESTINATION_REACHED' } } });
  assert.match(digests.lines().join('\n'), /invalid/);
  assert.match(digests.lines().join('\n'), /left-open/);
  digests.push('actionStatus', '{}', { actionId: 'invalid', state: 'UNKNOWN_ACTION' });
  for (let i = 0; i < 6; i++) digests.push('observe', '{}', {});
  assert.doesNotMatch(digests.lines().join('\n'), /invalid/);
  assert.match(digests.lines().join('\n'), /left-open/);
});

test('pre-decoration receipt identity retires a handle even when q6-style presentation omits it', () => {
  const receipt = { actionId: 'async:failed-target', state: 'FAILED', reasonCode: 'NO_PATH' };
  const input = buildNativeEventInput({ ...profile(), currentGoal: 'explore', goalRevision: 0 }, {
    event: 'observation', actionReceipt: receipt,
    observation: { player: { health: 20 }, lastResult: { state: receipt.state, reasonCode: receipt.reasonCode } },
  });
  const raw = JSON.parse(input.split('\n')[1]);
  assert.equal(raw._actionReceipt.actionId, receipt.actionId);
  const digests = new ToolDigests(1);
  digests.push('startAction', '{}', { actionId: receipt.actionId, state: 'RUNNING' });
  digests.noteDelivered(raw);
  digests.push('observe', '{}', {});
  assert.doesNotMatch(digests.lines().join('\n'), /RUNNING/);
  assert.match(digests.lines().join('\n'), /async:failed-target/);
  assert.doesNotMatch(encodeNativeEventInput(input), /_actionReceipt/);
});
