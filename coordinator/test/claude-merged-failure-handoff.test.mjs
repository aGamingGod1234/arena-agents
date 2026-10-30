import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness, profile } from './fixtures/claude-service-fixture.mjs';
import { encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
// Captured by Sol's r3 probe using the actual merged q6 runtime and event builder.
const inputs = JSON.parse(readFileSync(new URL('./fixtures/merged-failure-handoff.json', import.meta.url)));
const evidence = [];
const done = child => child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fixture' });
const usage = (child, id, context) => {
 child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 5, cache_read_input_tokens: context, cache_creation_input_tokens: 200 } } } });
 child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
};
test('internal receipt metadata is stripped from historical envelopes', () => {
 assert.doesNotMatch(encodeNativeEventInput(inputs.metadata), /_actionReceipt/);
});
for (const kind of ['raw', 'compact']) for (const steerKind of ['none', 'newer']) test(`${kind} merged q6 failure survives two handoffs once with ${steerKind} steer`, async () => {
 let agent, steer, calls = 0;
 const handoffs = [];
 const h = await harness({ async onUser(child, content) {
  const index = h.children.indexOf(child);
  if (index > 0) handoffs.push(content);
  if (index === 2) { done(child); return; }
  for (const [step, context] of (index === 0 ? [800_000] : [30_000, 800_000]).entries()) {
   usage(child, `${index}-${step}`, context);
   const reply = await child.rpc('tools/call', { name: 'say', arguments: { message: 'continue' } });
   if (JSON.stringify(reply).includes('SESSION_ROTATED')) { done(child); return; }
  }
  done(child);
 } }, { contextRotationTokens: 80_000 });
 try {
  agent = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
  await agent.act(inputs[kind], { goalRevision: 0, executeTool: async () => {
   if (++calls === 1 && steerKind === 'newer') steer = agent.steer('Wake.\n' + JSON.stringify({ event: 'observation', observation: { player: { health: 19 } } }), { goalRevision: 0 });
   return { state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' };
  } });
  if (steer) await steer;
  const blocker = kind === 'raw' ? 'RAW_MERGED_BLOCKER' : 'NESTED_CORRELATED_BLOCKER';
  evidence.push({ kind, steerKind, bytes: handoffs.map(text => Buffer.byteLength(text)), handoffs });
  if (process.env.HANDOFF_BYTES_OUTPUT) writeFileSync(process.env.HANDOFF_BYTES_OUTPUT, JSON.stringify(evidence, null, 2));
  assert.equal(handoffs.length, 2);
  for (const text of handoffs) {
   assert.equal(text.split(blocker).length - 1, 1);
   assert.doesNotMatch(text, /_actionReceipt/);
   if (kind === 'compact') assert.equal(text.split('move_to 27,64,0').length - 1, 1);
  }
 } finally { await h.close(); }
});

test('receipt metadata stripping covers nested result envelopes without mutating facts', () => {
 const internal = { actionId: 'private-id', state: 'FAILED', reasonCode: 'NO_PATH' };
 const fact = { state: 'FAILED', reasonCode: 'NO_PATH', failure: { blockedBy: 'gate', tried: 'move east', changed: 'moved 1m' }, message: 'gate', physicalAttempted: true, _actionReceipt: internal };
 const raw = { event: 'program_ended', program: { programId: 'p', result: { receipts: [fact], results: [{ result: fact }] } }, mergedEvents: [{ event: 'observation', _actionReceipt: internal, observation: { lastResult: fact } }] };
 const encoded = encodeNativeEventInput('Wake.\n' + JSON.stringify(raw));
 assert.doesNotMatch(encoded, /_actionReceipt|private-id|physicalAttempted|"message"/);
 const presented = JSON.parse(encoded.split('\n')[1]);
 assert.deepEqual(presented.program.result.receipts[0].failure, fact.failure);
 assert.deepEqual(presented.program.result.results[0].result.failure, fact.failure);
 assert.deepEqual(presented.mergedEvents[0].observation.lastResult.failure, fact.failure);
 assert.equal(raw.program.result.receipts[0]._actionReceipt, internal);
});
