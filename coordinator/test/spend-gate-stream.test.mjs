import test from 'node:test';
import assert from 'node:assert/strict';
import { SpendGate, startAnthropicGateway, anthropicResponseUsage } from '../src/benchmark/spend-gate.mjs';

const profile = { provider: 'claude', model: 'claude-opus-5-5', serviceTier: 'priority' };
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const start = event({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } });
const delta = (reason, output = 5) => event({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: output } });
const stop = event({ type: 'message_stop' });

test('r5 interrupted nonterminal usage retains the output allowance and refuses another oversized call', async () => {
	const gate = new SpendGate({ budgetUsd: 0.45 });
	let forwarded = 0;
	const gateway = await startAnthropicGateway({ gate, profileFor: () => profile, fetchImpl: async () => {
		forwarded++;
		return { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: (async function* () {
			yield Buffer.from(start + delta(null));
			throw new Error('socket lost before terminal usage');
		})() };
	} });
	const request = () => fetch(`${gateway.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: profile.model, max_tokens: 20000, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
	try {
		await (await request()).text();
		assert.ok(Math.abs(gate.totals().chargeUsd - 0.40002) < 1e-9, `charged ${gate.totals().chargeUsd}`);
		assert.equal(gateway.calls[0].metered, false);
		assert.equal(gate.totals().unmeteredSettlements, 1);
		assert.equal(gateway.calls[0].tokens, null);
		assert.equal((await request()).status, 400);
		assert.equal(forwarded, 1);
	} finally { await gateway.close(); }
});

test('stream final accounting requires complete terminal events and valid cumulative usage', () => {
	for (const text of [start + delta(null), start + delta('end_turn'), start + delta(null) + stop,
		start + delta('end_turn') + stop.trimEnd(),
		start + delta('end_turn', -1) + stop, start + delta('end_turn', '5') + stop,
		start + delta(null, 8) + delta('end_turn', 5) + stop,
		start + event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }) + stop,
		start + delta('end_turn') + event({ type: 'error', error: { type: 'overloaded_error' } }) + stop]) {
		assert.equal(anthropicResponseUsage(text, true).final, null, text);
	}
	assert.deepEqual(anthropicResponseUsage(start + delta(null, 3) + delta('end_turn', 5) + stop, true).final,
		{ input: 10, cacheRead: 0, cacheWrite: 0, output: 5 });
});
