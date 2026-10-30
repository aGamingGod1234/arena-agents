import test from 'node:test';
import assert from 'node:assert/strict';
import { SpendGate, startAnthropicGateway } from '../src/benchmark/spend-gate.mjs';

test('r8 five-minute cache writes settle at their published rate, not the admission bound', async t => {
 const gate = new SpendGate({ budgetUsd: 3 });
 const usage = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } };
 const gateway = await startAnthropicGateway({ strict: true, gate, profileFor: model => ({ provider: 'claude', model }),
  fetchImpl: async () => Response.json({ id: 'msg_five_minutes', usage }) });
 t.after(() => gateway.close());
 const response = await fetch(gateway.url + '/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 4096,
  cache_control: { type: 'ephemeral', ttl: '5m' }, messages: [{ role: 'user', content: 'x'.repeat(2000) }] }) });
 await response.text();
 assert.equal(gateway.calls[0].usd, .00704);
 assert.equal(gateway.calls[0].responseId, 'msg_five_minutes');
 assert.equal(gateway.calls[0].exactUsage, true);
 assert.deepEqual(gateway.calls[0].usage, usage);
});

test('r8 settlement retains mixed cache durations, unknown duration stays conservative, inconsistent usage cannot reconcile', async t => {
 const samples = [
  { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 750, ephemeral_1h_input_tokens: 250 } }, expected: .0078, exact: true },
  { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 750, ephemeral_1h_input_tokens: 250 } }, expected: .0039, exact: true },
  { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000 }, expected: .01004, exact: false },
  { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 999, ephemeral_1h_input_tokens: 0 } }, exact: false },
  { model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: '1000', ephemeral_1h_input_tokens: 0 } }, exact: false },
 ];
 for (const [index, sample] of samples.entries()) {
  const gate = new SpendGate({ budgetUsd: 3 });
  const gateway = await startAnthropicGateway({ strict: true, gate, profileFor: model => ({ provider: 'claude', model }),
   fetchImpl: async () => Response.json({ id: `msg_${index}`, usage: sample.usage }) });
  t.after(() => gateway.close());
  await (await fetch(gateway.url + '/v1/messages', { method: 'POST', body: JSON.stringify({ model: sample.model, max_tokens: 4096,
   messages: [{ role: 'user', content: 'x'.repeat(2000) }] }) })).text();
  const call = gateway.calls[0];
  assert.equal(call.exactUsage, sample.exact);
  assert.deepEqual(call.usage, sample.usage);
  if (sample.expected !== undefined) assert.equal(call.usd, sample.expected);
  else { assert.equal(call.tokens, null); assert.equal(call.usd, call.worstUsd); assert.equal(call.metered, false); }
 }
});

test('r8 streamed usage keeps response identity and cache durations through final output deltas', async t => {
 const usage = { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 1000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } };
 const gate = new SpendGate({ budgetUsd: 3 });
 const data = value => `data: ${JSON.stringify(value)}\n\n`;
 const gateway = await startAnthropicGateway({ strict: true, gate, profileFor: model => ({ provider: 'claude', model }),
  fetchImpl: async () => new Response(data({ type: 'message_start', message: { id: 'msg_stream', usage } })
   + data({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 100 } }) + data({ type: 'message_stop' })) });
 t.after(() => gateway.close());
 await (await fetch(gateway.url + '/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, max_tokens: 4096,
  messages: [{ role: 'user', content: 'x'.repeat(2000) }] }) })).text();
 assert.equal(gateway.calls[0].usd, .00704);
 assert.equal(gateway.calls[0].responseId, 'msg_stream');
 assert.equal(gateway.calls[0].exactUsage, true);
 assert.deepEqual(gateway.calls[0].usage, { ...usage, output_tokens: 100 });
});
