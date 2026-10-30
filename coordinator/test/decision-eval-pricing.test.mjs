import assert from 'node:assert/strict';
import test from 'node:test';

import { CALL_PRICE_USD, estimateCallCostUsd } from '../src/claude-service.mjs';
import { estimateJudgeCostUsd, JUDGE_PRICES_PER_MILLION } from '../src/decision-eval/judge.mjs';
import { codexTokens, estimateTokenCostUsd, TOKEN_PRICES_PER_MILLION } from '../src/decision-eval/pricing.mjs';
import { readFile } from 'node:fs/promises';

import { renderWake } from '../src/decision-eval/render.mjs';
import { encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';

const replay = JSON.parse(await readFile(new URL('./fixtures/decision-eval/g1-replay-sample.json', import.meta.url), 'utf8'));

test('the shared Claude rows equal the production Claude proxy', () => {
	for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
		const row = TOKEN_PRICES_PER_MILLION[`claude:${model}`];
		for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) assert.ok(Math.abs(row[key] / 1e6 - CALL_PRICE_USD[key]) < 1e-15, `${model} ${key}`);
	}
	const call = { input: 120, cacheRead: 17_330, cacheWrite: 6_300, output: 140 };
	assert.ok(Math.abs(estimateTokenCostUsd(call, { provider: 'claude', model: 'claude-opus-5-5' }) - estimateCallCostUsd(call)) < 1e-12);
});

test('GPT prices apply the priority tier multiplier and split cached input', () => {
	const tokens = codexTokens({ inputTokens: 30_000, cachedInputTokens: 24_000, outputTokens: 500 });
	assert.deepEqual(tokens, { input: 6_000, cacheRead: 24_000, cacheWrite: 0, output: 500 });
	const base = (6_000 * 2 + 24_000 * 0.1 + 500 * 10) / 1e6;
	assert.equal(estimateTokenCostUsd(tokens, { provider: 'codex', model: 'gpt-6.1-sol', serviceTier: 'default' }), base);
	assert.equal(estimateTokenCostUsd(tokens, { provider: 'codex', model: 'gpt-6.1-sol', serviceTier: 'priority' }), base * 2);
	assert.equal(estimateTokenCostUsd(tokens, { provider: 'codex', model: 'unknown-model' }), null);
	assert.equal(codexTokens({ inputTokens: null, outputTokens: 1 }), null);
});

test('the judge prices through the same table', () => {
	assert.equal(JUDGE_PRICES_PER_MILLION, TOKEN_PRICES_PER_MILLION);
	assert.equal(estimateJudgeCostUsd, estimateTokenCostUsd);
});

test('observation views keep a random per-session id unless an eval session is given', async () => {
	const { input } = await renderWake({ id: 'view-id', family: 'view', causeClass: 'view', split: 'train',
		state: { observation: replay.observations[0], agent: { goal: replay.goal, goalSpec: replay.goalSpec } }, expect: { good: [{ tool: 'moveTo' }] } });
	const ids = (text) => [...text.matchAll(/observation-([0-9a-f-]{36})-\d+/g)].map((match) => match[1]);
	const first = encodeNativeEventInput(input, new ModelObservationViews());
	const second = encodeNativeEventInput(input, new ModelObservationViews());
	const absent = encodeNativeEventInput(input, new ModelObservationViews({}));
	assert.ok(ids(first).length > 0, 'the wake names its observation view');
	for (const text of [first, second, absent]) for (const id of ids(text)) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.notEqual(ids(first)[0], ids(second)[0], 'production sessions stay distinct');
	const swap = (text) => text.replaceAll(ids(text)[0], 'SESSION');
	assert.equal(swap(first), swap(second), 'only the session id differs between production sessions');
	assert.equal(swap(absent), swap(first));
	const fixed = '00000000-0000-4000-8000-000000000000';
	const evalA = encodeNativeEventInput(input, new ModelObservationViews({ session: fixed }));
	const evalB = encodeNativeEventInput(input, new ModelObservationViews({ session: fixed }));
	assert.equal(evalA, evalB, 'eval sessions send identical bytes');
	assert.equal(evalA, swap(first).replaceAll('SESSION', fixed), 'and differ from production only by the id');
});
