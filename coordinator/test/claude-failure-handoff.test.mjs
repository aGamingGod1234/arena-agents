import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { harness, profile } from './fixtures/claude-service-fixture.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';

const record = { agentId: 'claude-a', provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium', serviceTier: 'priority', goalRevision: 0, currentGoal: 'explore' };
const sample = () => ({ ready: true, observedAtEpochMs: Date.now(), player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] } });
const event = observation => `Wake.\n${JSON.stringify({ event: 'observation', observation })}`;
const usage = (child, id, context) => {
 child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 5, cache_read_input_tokens: context, cache_creation_input_tokens: 200, output_tokens: 1 } } } });
 child.emitLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });
 child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
};

// Opt-in integration against q9's actual provider. No provider hooks are patched by this test.
// FAILURE_HANDOFF_Q9=ad5fb975 reproduces the review; use an updated ref or q9 checkout path to verify its fix.
async function q9Provider(t, ref) {
 const root = await mkdtemp(path.join(tmpdir(), 'failure-handoff-q9-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const cwd = fileURLToPath(new URL('../', import.meta.url));
 const checkout = /[\\/]/.test(ref) && !ref.startsWith('claude/') ? path.resolve(ref) : null;
 const read = name => checkout === null
  ? execFileSync('git', ['show', `${ref}:coordinator/src/${name}`], { cwd, encoding: 'utf8' })
  : readFile(path.join(checkout, 'coordinator/src', name), 'utf8');
 let source = await read('claude-service.mjs');
 const ownedModules = ['context-carry-over.mjs', 'failure-carry-over.mjs', 'handoff-budget.mjs'].filter(name => source.includes(`from './${name}'`));
 const rewrite = text => text.replace(/from '(\.\/[^']+)'/g, (_match, specifier) => {
  const url = specifier === './model-fact-encoding.mjs'
   ? new URL('../src/model-fact-encoding.mjs', import.meta.url)
   : ownedModules.includes(specifier.slice(2))
    ? pathToFileURL(path.join(root, specifier.slice(2)))
    : checkout === null ? new URL(specifier, new URL('../src/claude-service.mjs', import.meta.url))
     : pathToFileURL(path.resolve(checkout, 'coordinator/src', specifier));
  return `from '${url.href}'`;
 });
 for (const name of ownedModules) await writeFile(path.join(root, name), rewrite(await read(name)));
 const file = path.join(root, 'claude-service.mjs');
 await writeFile(file, rewrite(source));
 return (await import(pathToFileURL(file))).ClaudeProviderService;
}

for (const implementation of [process.env.FAILURE_HANDOFF_Q9 ?? 'q9']) {
 for (const steerKind of ['none', 'same-action', 'different-action']) {
  test(`${implementation}: reserved failure survives replacement with ${steerKind} steer exactly once`, { skip: !process.env.FAILURE_HANDOFF_Q9 }, async t => {
   const sent = [];
   const runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => { if (type === 'action_command') sent.push(payload); } } });
   t.after(() => runtime.disposeAll());
   await runtime.execute({ agentId: 'claude-a', goalRevision: 0, turnId: 'before', callId: 'move', tool: { kind: 'start_action', actionType: 'move_to', arguments: { x: 27, y: 64, z: 0, tolerance: 1 } } }, record);
   const actionId = sent.at(-1).actionId;
   runtime.onActionResult(record, { actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'UNIQUE_BLOCKER_HANDOFF', executionStarted: true, physicalAttempted: false });
   const observation = { ...sample(), lastResult: { present: true, actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'UNIQUE_BLOCKER_HANDOFF' } };
   const input = event(runtime.decorateObservation(record, observation, { reservation: {} }));
   let resumed, agent, steer;
   const ProviderService = await q9Provider(t, implementation);
   const { service, children, close } = await harness({ async onUser(child, content) {
    if (children.indexOf(child) === 0) {
     usage(child, 'cross-64k', 70000);
     await child.rpc('tools/call', { name: 'say', arguments: { message: 'thinking' }, _meta: { 'claudecode/toolUseId': 'handoff-read' } });
     child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'retired', session_id: 'session-1' });
    } else {
     resumed = content;
     usage(child, 'replacement', 30000);
     child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
    }
   } }, { contextRotationTokens: 64000 }, { ProviderService });
   try {
    agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
    const result = await agent.act(input, { goalRevision: 0, executeTool: async () => {
     if (steerKind !== 'none') steer = agent.steer(async () => {
      const newest = runtime.decorateObservation(record, observation, { reservation: {} });
      if (steerKind === 'different-action') newest.lastResult = { actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', failure: { code: 'NO_PATH', blockedBy: 'OTHER_BLOCKER', tried: 'move_to 99,64,0' } };
      return event(newest);
     }, { goalRevision: 0 });
     return { state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' };
    } });
    if (steer) await steer;
    assert.equal(result.status, 'completed');
    assert.equal(children.length, 2);
    assert.equal(resumed.split('UNIQUE_BLOCKER_HANDOFF').length - 1, 1);
    assert.equal(resumed.split('move_to 27,64,0').length - 1, 1);
    if (steerKind === 'different-action') {
     assert.equal(resumed.split('OTHER_BLOCKER').length - 1, 1);
     assert.equal(resumed.split('move_to 99,64,0').length - 1, 1);
    }
   } finally { await close(); }
  });
 }
}

const sampleWithResult = lastResult => ({ ready: true, observedAtEpochMs: Date.now(), player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] }, lastResult });
async function failMove(runtime, sent, x) {
  await runtime.execute({ agentId: record.agentId, goalRevision: 0, turnId: 'turn', callId: `move-${x}`, tool: { kind: 'start_action', actionType: 'move_to', arguments: { x, y: 64, z: 0, tolerance: 1 } } }, record);
  const actionId = sent.at(-1).actionId;
  runtime.onActionResult(record, { actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: `BLOCKER_${x}`, executionStarted: true, physicalAttempted: false });
  return sampleWithResult({ present: true, actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: `BLOCKER_${x}` });
}

const done = child => child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fixture' });
for (const mode of ['tool-result', 'status-of-event']) test(`handoff has one blocker for ${mode}`, { skip: !process.env.FAILURE_HANDOFF_Q9 }, async t => {
  const providerOptions = { ProviderService: await q9Provider(t, process.env.FAILURE_HANDOFF_Q9) };
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => { if (type === 'action_command') sent.push(payload); } } });
  t.after(() => runtime.disposeAll());
  const failure = await failMove(runtime, sent, 27);
  let resumed;
  const h = await harness({ async onUser(child, content) {
    if (h.children.indexOf(child) === 0) {
      usage(child, 'cross', 70000);
      await child.rpc('tools/call', { name: 'actionStatus', arguments: { actionId: failure.lastResult.actionId }, _meta: { 'claudecode/toolUseId': 'status-call' } });
      done(child);
    } else { resumed = content; usage(child, 'replacement', 30000); done(child); }
  } }, { contextRotationTokens: 64000 }, providerOptions);
  try {
    const a = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    const input = mode === 'status-of-event' ? event(runtime.decorateObservation(record, failure, { reservation: {} })) : event(sampleWithResult());
    await a.act(input, { goalRevision: 0, executeTool: request => runtime.execute({ ...request, agentId: record.agentId, goalRevision: 0 }, record) });
    assert.equal(h.children.length, 2);
    const count = resumed.split('BLOCKER_27').length - 1;
    assert.equal(count, 1);
  } finally { await h.close(); }
});

test('a rejected tool explanation survives the second receiving context', { skip: !process.env.FAILURE_HANDOFF_Q9 }, async t => {
  const providerOptions = { ProviderService: await q9Provider(t, process.env.FAILURE_HANDOFF_Q9) };
  let calls = 0;
  const h = await harness({ async onUser(child, content) {
    child.received = [...(child.received ?? []), content];
    const index = h.children.indexOf(child);
    if (index === 2) { done(child); return; }
    const contexts = index === 0 ? [70000] : [30000, 70000, 140000];
    for (const [step, context] of contexts.entries()) {
      usage(child, `reject-${index}-${step}`, context);
      const reply = await child.rpc('tools/call', { name: index === 0 ? 'takeTask' : 'say', arguments: index === 0 ? {} : { message: 'continue' }, _meta: { 'claudecode/toolUseId': `reject-call-${index}-${step}` } });
      if (JSON.stringify(reply).includes('SESSION_ROTATED')) { done(child); return; }
    }
    done(child);
  } }, { contextRotationTokens: 64000 }, providerOptions);
  try {
    const a = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    await a.act(event(sampleWithResult()), { goalRevision: 0, executeTool: async () => ++calls === 1
      ? { state: 'REJECTED', reasonCode: 'NO_PLAYER_REQUEST', executed: false, message: 'REJECTED_TOOL_BLOCKER' }
      : { state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' } });
    assert.equal(h.children.length, 3);
    assert.match(h.children[1].received[0], /REJECTED_TOOL_BLOCKER/);
    const second = h.children[2].received[0];
    assert.match(second, /REJECTED_TOOL_BLOCKER/);
  } finally { await h.close(); }
});


test('a runtime sequence keeps blocker, target and partial effect across two handoffs', { skip: !process.env.FAILURE_HANDOFF_Q9 }, async t => {
  const providerOptions = { ProviderService: await q9Provider(t, process.env.FAILURE_HANDOFF_Q9) };
  const sent = [];
  const runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => {
    if (type !== 'action_command') return;
    sent.push(payload);
    queueMicrotask(() => runtime.onActionResult(record, {
      actionId: payload.actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'NESTED_SEQUENCE_BLOCKER',
      executionStarted: true, physicalAttempted: true,
      actionObservation: { observedAtEpochMs: Date.now(), player: { x: 1, y: 64, z: 0, health: 20 } },
    }));
  } } });
  t.after(() => runtime.disposeAll());
  runtime.updateObservation(record, sample(), { eventSequence: 1 });
  const h = await harness({ async onUser(child, content) {
    child.received = [...(child.received ?? []), content];
    const index = h.children.indexOf(child);
    if (index === 2) { done(child); return; }
    for (const [step, context] of (index === 0 ? [70000] : [30000, 800000]).entries()) {
      usage(child, `sequence-${index}-${step}`, context);
      const reply = await child.rpc('tools/call', {
        name: index === 0 ? 'sequence' : 'say',
        arguments: index === 0 ? { actions: [
          { actionType: 'move_to', arguments: { x: 121, y: 64, z: 0, tolerance: 1 } },
          { actionType: 'move_to', arguments: { x: 123, y: 64, z: 0, tolerance: 1 } },
        ] } : { message: 'continue' },
        _meta: { 'claudecode/toolUseId': `sequence-call-${index}-${step}` },
      });
      if (JSON.stringify(reply).includes('SESSION_ROTATED')) { done(child); return; }
    }
    done(child);
  } }, { contextRotationTokens: 64000 }, providerOptions);
  try {
    const agent = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
    let calls = 0;
    const result = await agent.act(event(sample()), { goalRevision: 0, executeTool: request => ++calls === 1
      ? runtime.execute(request, record)
      : { state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' } });
    assert.equal(result.status, 'completed');
    assert.equal(sent.length, 1, 'the failed first step prevents dispatch of the second step');
    assert.equal(h.children.length, 3);
    for (const [index, child] of h.children.slice(1).entries()) {
      const input = child.received[0];
      for (const fact of ['NESTED_SEQUENCE_BLOCKER', 'move_to 121,64,0', 'moved 1m']) {
        assert.equal(input.split(fact).length - 1, 1, `handoff ${index + 1} retains ${fact} exactly once`);
      }
    }
  } finally { await h.close(); }
});
