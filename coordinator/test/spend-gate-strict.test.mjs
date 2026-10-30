import test from 'node:test';
import assert from 'node:assert/strict';
import { SpendGate, startAnthropicGateway } from '../src/benchmark/spend-gate.mjs';
const model = 'claude-opus-5-5';
const request = () => ({ model, max_tokens: 4096, messages: [{ role: 'user', content: 'play' }] });
async function fixture(t, budgetUsd = 1) {
 const outbound = [];
 const gate = new SpendGate({ budgetUsd });
 const gateway = await startAnthropicGateway({ gate, strict: true, profileFor: name => ({ provider: 'claude', model: name }), fetchImpl: async (url, init) => {
  outbound.push({ url, request: JSON.parse(init.body), reserved: gate.pendingUsd });
  return new Response('interrupted provider response');
 } });
 t.after(() => gateway.close());
 const send = async (body, route = '/v1/messages', method = 'POST') => {
  const res = await fetch(gateway.url + route, { method, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  await res.text(); return res.status;
 };
 return { outbound, gate, gateway, send };
}
test('strict gateway counts every outbound call and refuses arbitrary routes, batches and unsupported payloads before provider access', async t => {
 const { outbound, send } = await fixture(t);
 for (const [route, method] of [['/v1/messages/batches','POST'], ['/v1/complete','POST'], ['/v1/models','GET'], ['/v1/messages/count_tokens','POST'], ['/v1/messages','GET']]) {
  assert.equal(await send(request(), route, method), 400, route);
 }
 const invalid = [
  { ...request(), model: 'unknown-model' },
  { ...request(), tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
  { ...request(), tools: [{ type: 'bash_20250124', name: 'bash' }] },
  { ...request(), messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image' } }] }] },
  { ...request(), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'document', source: { type: 'file', file_id: 'x' } }] }] }] },
  { ...request(), mcp_servers: [{ type: 'url', url: 'https://example.test' }] },
  { ...request(), service_tier: 'priority' },
 ];
 for (const body of invalid) assert.equal(await send(body), 400, JSON.stringify(body));
 assert.equal(outbound.length, 0, 'every fetchImpl outbound is counted, not only Messages');
});
test('strict gateway admits text and custom-tool history only with a pending reservation, then refuses retry that no longer fits', async t => {
 const { outbound, gate, send } = await fixture(t, 0.09);
 const body = { ...request(), tools: [{ name: 'act', description: 'Game action', input_schema: { type: 'object', properties: { action: { type: 'string' } } } }],
  messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'act', input: { action: 'look' } }] },
   { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'world' }] }] }] };
 assert.equal(await send(body, '/v1/messages?beta=true'), 200);
 assert.ok(outbound[0].reserved > 0);
 assert.equal(await send(body), 400);
 assert.equal(outbound.length, 1);
 assert.ok(gate.totals().chargeUsd <= gate.budgetUsd);
});

test('strict published pricing uses full input and worst cache rates and accounts for custom-tool system tokens', async t => {
 const gate = new SpendGate({ budgetUsd: 1 });
 let forwarded;
 const gateway = await startAnthropicGateway({ strict: true, gate, profileFor: name => ({ provider: 'claude', model: name }), fetchImpl: async (url, init) => {
  forwarded = init;
  return Response.json({ usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } });
 } });
 t.after(() => gateway.close());
 assert.equal(gateway.strict, true);
 const body = JSON.stringify({ ...request(), tools: [{ name: 'act', input_schema: { type: 'object' } }] });
 const res = await fetch(gateway.url + '/v1/messages', { method: 'POST', body, headers: { 'anthropic-beta': 'oauth-2025-04-20,fast-mode-2026-01-01', 'x-inference-geo': 'us', authorization: 'Bearer fake' } });
 await res.text();
 assert.equal(res.status, 200);
 assert.equal(forwarded.headers['anthropic-beta'], 'oauth-2025-04-20');
 assert.equal(forwarded.headers['x-inference-geo'], undefined);
 assert.equal(forwarded.headers.authorization, 'Bearer fake');
 assert.equal(gateway.calls[0].worstUsd, ((Buffer.byteLength(body) + 64 + 286) * 8 + 4096 * 20) / 1e6);
 assert.equal(gate.totals().chargeUsd, (100 * 4 + 10 * 20 + 20 * 8 + 30 * .2) / 1e6);
});


test('strict CLI keep-all context edit launches, but server compaction cannot reach the provider', async t => {
 const { outbound, send } = await fixture(t);
 const body = { ...request(), thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
  context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } };
 assert.equal(await send(body), 200);
 assert.equal(outbound.length, 1);
 assert.ok(outbound[0].reserved > 0);
 assert.deepEqual(outbound[0].request.context_management, body.context_management);
 for (const edit of [{ type: 'compact_20260112' }, { type: 'clear_thinking_20251015', keep: 'all', compact: true }]) {
  assert.equal(await send({ ...body, context_management: { edits: [edit] } }), 400);
 }
 assert.equal(outbound.length, 1);
});
