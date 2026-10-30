import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayContextCost, tokenCost } from '../scripts/context-cost-replay.mjs';

const call = (context, read, write, rotations = 0, turnId = 'a') => ({ contextTokens: context, cachedInputTokens: read,
	cacheWriteInputTokens: write, outputTokens: 100, rotations, turnId });
const longCalls = () => [call(30_000, 20_000, 9_998), ...Array.from({ length: 220 }, (_, index) => {
	const context = 32_000 + index * 2_000;
	return call(context, context - 2_000, 1_998, 0, `turn-${Math.floor(index / 7)}`);
})];

test('replay preserves exact recorded baseline cache categories', () => {
	const calls = [call(50_000, 40_000, 9_998), call(51_000, 45_000, 5_998)];
	const result = replayContextCost(calls);
	assert.ok(Math.abs(result.baselineUsd - tokenCost({ read: 85_000, write: 15_996, input: 4, output: 200 })) < 1e-12);
	assert.equal(result.candidateUsd, result.baselineUsd);
	assert.equal(result.rows[1].projected.write, 5_998);
});

test('repeated economic resets work across ordinary turn boundaries and variable growth', () => {
	const calls = longCalls();
	for (let index = 10; index < calls.length; index += 17) {
		for (let tail = index; tail < calls.length; tail += 1) { calls[tail].contextTokens += 8_000; calls[tail].cachedInputTokens += 8_000; }
		calls[index].cachedInputTokens -= 8_000;
		calls[index].cacheWriteInputTokens += 8_000;
	}
	const result = replayContextCost(calls);
	assert.ok(result.resets > 2);
	assert.ok(result.rows.some((row) => row.turnBoundary));
	for (const row of result.rows.filter((row) => row.reset)) assert.ok(row.quote.creditUsd >= row.quote.estimatedWriteUsd);
	for (const row of result.rows.filter((row) => !row.reset)) assert.equal(row.projected.write, row.measured.write);
});

test('short tails expose positive overhead without claiming neutrality', () => {
	const full = replayContextCost(longCalls());
	const firstReset = full.rows.findIndex((row) => row.reset);
	assert.ok(firstReset > 0);
	const tail = replayContextCost(longCalls().slice(0, firstReset + 1));
	assert.ok(tail.rows.at(-1).candidateCallUsd > tail.rows.at(-1).baselineCallUsd);
	assert.equal(tail.resets, 1);
	assert.ok(tail.maxPrefixOverheadUsd >= 0);
});

test('large receipt byte growth increases the measured write quote and delays a reset', () => {
	const calls = longCalls();
	const ordinary = replayContextCost(calls);
	const large = replayContextCost(calls, { payloadBytesByCall: calls.map((_, index) => index === 0 ? 0 : 100_000) });
	assert.ok(large.rows.findIndex((row) => row.reset) > ordinary.rows.findIndex((row) => row.reset));
	assert.ok(large.rows[1].quote.estimatedWriteUsd > ordinary.rows[1].quote.estimatedWriteUsd);
});

test('baseline resets are reconstructed explicitly rather than imposed on the candidate', () => {
	const calls = [call(30_000, 20_000, 9_998), call(31_000, 29_998, 1_000), call(25_000, 20_000, 4_998, 1)];
	const low = replayContextCost(calls, { boundaryGrowthShare: 0 });
	const high = replayContextCost(calls, { boundaryGrowthShare: 1 });
	assert.equal(low.rows[2].naturalReset, true);
	assert.equal(low.rows[2].reset, false);
	assert.equal(low.rows[2].candidateContext, 31_000);
	assert.equal(high.rows[2].candidateContext, 36_000);
	assert.equal(high.rows[2].projected.write, 4_998);
});

for (const [name, baselineUsd] of [['smoke2-8c1ed360', 3.6234896], ['base1-9d44450c', 4.6779214]]) {
	test(`recorded ${name} baseline remains exact for typical and stress assumptions`, () => {
		const calls = JSON.parse(readFileSync(new URL(`./fixtures/context-cost-replay/${name}.json`, import.meta.url), 'utf8'));
		for (const [handoffTokens, prefixTokens] of [[37_000, 17_330], [60_000, 0]]) for (const boundaryGrowthShare of [0, 1]) {
			const result = replayContextCost(calls, { handoffTokens, prefixTokens, boundaryGrowthShare });
			assert.ok(Math.abs(result.baselineUsd - baselineUsd) < 1e-10);
			assert.equal(result.assumptions.threshold, 64_000);
			assert.equal(result.assumptions.recordedNaturalResetsPreserved, false);
			for (const row of result.rows.filter((row) => row.reset)) assert.ok(row.quote.creditUsd >= row.quote.estimatedWriteUsd);
			assert.ok(Number.isFinite(result.maxPrefixOverheadPercent));
		}
	});
}

test('every replay prefix obeys the paid-read plus unpaid-overrun write bound', () => {
	for (const options of [{}, { handoffTokens: 60_000, prefixTokens: 0 },
		{ payloadBytesByCall: longCalls().map((_, index) => index * 700) }]) {
		const result = replayContextCost(longCalls(), options);
		assert.ok(result.resets > 0);
		for (const { budget } of result.rows) assert.ok(budget.totalElectiveWriteUsd
			<= budget.totalReadUsd + budget.unsettledDebtUsd + 1e-10);
	}
});
