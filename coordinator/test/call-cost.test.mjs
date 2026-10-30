import assert from 'node:assert/strict';
import test from 'node:test';
import { extractQualityMetrics } from '../src/benchmark/quality-metrics.mjs';
import { estimateTokenCostUsd, TOKEN_PRICES_PER_MILLION } from '../src/call-cost.mjs';
import { SPEED_TOKEN_PRICES_PER_MILLION, deriveRunMetrics } from '../src/benchmark/live-speed-benchmark.mjs';
const profile = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };
const extract = extra => extractQualityMetrics({ scenario: { setup: { dimension: 'minecraft:overworld' } }, profile, ...extra });
test('shared proxy table matches benchmark and coordinator weights', () => {
	assert.equal(SPEED_TOKEN_PRICES_PER_MILLION, TOKEN_PRICES_PER_MILLION);
	const tokens = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 };
	const expected = estimateTokenCostUsd(tokens, profile);
	const speed = deriveRunMetrics({ profile, traceRows: [{ event: 'native_model_call', agentId: 'a', goalRevision: 1, totalMs: 1, inputTokens: 60, cachedInputTokens: 20, cacheWriteInputTokens: 30, outputTokens: 40 }] });
	assert.ok(Math.abs(speed.costEstimateUsd - expected) < 1e-6);
	assert.equal(estimateTokenCostUsd(tokens, { ...profile, model: 'unknown' }), null);
});

test('Codex preparation Luna is priced and priority aliases fast',()=>{
 const tokens={input:1000000,cacheRead:1000000,cacheWrite:1000000,output:1000000};
 const profile={provider:'codex',model:'gpt-6-luna',serviceTier:'standard'};
 assert.equal(estimateTokenCostUsd(tokens,profile),.735);
 assert.equal(estimateTokenCostUsd(tokens,{...profile,serviceTier:'priority'}),1.47);
 assert.equal(estimateTokenCostUsd(tokens,{...profile,serviceTier:'fast'}),1.47);
});
