import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { SpendLedger, runSpendUsd, liveSpendUsd, defaultRunReserveUsd, unmeteredProviderCalls } from '../src/benchmark/spend-ledger.mjs';
import { summarizeGenerality } from '../src/benchmark/generality-suite.mjs';
import { parseSuiteArgs, suiteRunAllowance, boundedMap } from '../../scripts/quality/run-generality.mjs';
import { Observer } from '../../scripts/quality/run-scenarios.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const claude = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };

test('item 1: launches reserve first, so three concurrent workers cannot push committed spend past the cap', async () => {
	// $0.45 per window-minute + $0.25 preparation + $2 judges + $4 worst-case call headroom.
	assert.equal(defaultRunReserveUsd(600000), 10.75);
	assert.equal(defaultRunReserveUsd(60000), 6.7);
	assert.equal(defaultRunReserveUsd(600000, { judges: false }), 8.75);
	const ledger = new SpendLedger({ capUsd: 150 });
	// The r3 failure: $149.99 committed, three workers ready to launch 10-minute runs.
	await ledger.reserve('earlier', 149.99); await ledger.settle('earlier', 149.99);
	const launched = await boundedMap([1, 2, 3], 3, async n => ledger.reserve(`run-${n}`, 5));
	assert.deepEqual(launched, [false, false, false]);
	const fresh = new SpendLedger({ capUsd: 12 });
	assert.deepEqual(await boundedMap([1, 2, 3], 3, async n => fresh.reserve(`run-${n}`, 5)), [true, true, false]);
	// Settling replaces the reservation with the actual charge and frees the difference.
	const after = await fresh.settle('run-1', 1.25);
	close(after.committedUsd, 1.25); close(after.reservedUsd, 5);
	assert.equal(await fresh.reserve('run-3', 5), true);
	assert.ok((await fresh.totals()).committedUsd + (await fresh.totals()).reservedUsd <= 12);
	await assert.rejects(fresh.settle('run-1', 1), /not reserved/);
	await assert.rejects(fresh.reserve('run-2', 1), /already exists/);
});

test('observer-metered play stops one call before its cap', async () => {
	const allowance = suiteRunAllowance({ runReserveUsd: null }, { durationBudgetMs: 600000 });
	assert.deepEqual(allowance, { reserveUsd: 10.75, playCapUsd: 8.5 });
	const observer = new Observer('.', { protocolAudit: '', providerTurns: '' }, { spendCapUsd: 0.05, playMetering: 'observer' }, claude);
	const commands = [];
	observer.agent = 'player'; observer.rcon = { command: async text => { commands.push(text); return { text: 'ok' }; } };
	observer.provider = { rows: [] };
	observer.trace = { rows: [{ event: 'native_model_call', goalRevision: 1, modelCallId: 'a', inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 }] };
	await observer.enforceSpendCap();
	assert.deepEqual(commands, []);
	observer.nextSpendCheck = 0;
	observer.trace.rows.push({ event: 'native_model_call', goalRevision: 1, modelCallId: 'b', inputTokens: 20000, cachedInputTokens: 0, outputTokens: 2000 });
	await observer.enforceSpendCap();
	assert.deepEqual(commands, ['codex stop player']);
	assert.equal(observer.stopRequest.reason, 'SPEND_CAP');
	observer.nextSpendCheck = 0; await observer.enforceSpendCap();
	assert.equal(commands.length, 1, 'one stop per run');
});

test('item 2a: runs without model calls are known preparation spend; unknown or cancelled spend is reserved, never Infinity', () => {
	const R = 5;
	assert.deepEqual(runSpendUsd({ termination: 'NO_OBSERVER', metrics: null }, { reserveUsd: R }).usd, 0);
	// The fixer's cold-chunk T12: setup failed before any model call.
	assert.equal(runSpendUsd({ metrics: { modelCalls: 0, costEstimateUsd: null }, judge: { status: 'NO_ACTIONS', judgments: [{ costUsd: 0 }, { costUsd: 0 }], attempts: [], costUsd: 0, unknownSpend: false } }, { reserveUsd: R }).usd, 0);
	assert.equal(runSpendUsd({ metrics: { modelCalls: 0, costEstimateUsd: 0.004 } }, { reserveUsd: R }).usd, 0.004);
	assert.equal(runSpendUsd(null, { reserveUsd: R }).usd, R, 'worker crash or timeout is charged R');
	assert.equal(runSpendUsd({ termination: 'RUNNER_FAILED', metrics: null }, { reserveUsd: R }).usd, R);
	// Judge timeout: known attempts count, the unmetered attempt is reserved.
	const judged = runSpendUsd({ metrics: { modelCalls: 3, costEstimateUsd: 0.25 }, judge: { error: 'timeout', costUsd: null, unknownSpend: true, attempts: [{ costUsd: 0.1 }, { costUsd: null }] } }, { reserveUsd: R });
	close(judged.usd, 0.25 + 0.1 + 0.25); close(judged.reservedUsd, 0.25);
	assert.equal(runSpendUsd({ metrics: { modelCalls: 3, costEstimateUsd: 0.25 }, judge: { error: 'thrown before any attempt' } }, { reserveUsd: R }).usd, 0.75);
	// The r2-era judgments shape still sums.
	close(runSpendUsd({ metrics: { modelCalls: 1, costEstimateUsd: 2 }, judge: { judgments: [{ costUsd: .3 }, { costUsd: .4 }] } }, { reserveUsd: R }).usd, 2.7);
	assert.equal(runSpendUsd({ metrics: { modelCalls: 1, costEstimateUsd: .25 }, judge: { error: 'second pass failed', costUsd: .1, unknownSpend: false } }, { reserveUsd: R }).usd, .35);
	for (const run of [null, { metrics: null }, { metrics: { modelCalls: 4, costEstimateUsd: null } }]) assert.ok(Number.isFinite(runSpendUsd(run, { reserveUsd: R }).usd));
});

test('item 2b: each cut-off Codex call with missing usage is charged the largest metered call, or R/10 without any', () => {
	const metrics = { modelCalls: 3, costEstimateUsd: 0.3, modelCallDetails: [{ phase: 'play', costEstimateUsd: 0.05 }, { phase: 'play', costEstimateUsd: 0.12 }, { phase: 'play', costEstimateUsd: 0.13 }] };
	const charged = runSpendUsd({ metrics, unmeteredProviderCalls: 1 }, { reserveUsd: 5 });
	close(charged.usd, 0.43); close(charged.reservedUsd, 0.13);
	close(runSpendUsd({ metrics: { modelCalls: 2, costEstimateUsd: 0.2 }, unmeteredProviderCalls: 2 }, { reserveUsd: 5 }).usd, 1.2);
	const partial = runSpendUsd({ metrics: { modelCalls: 2, costEstimateUsd: null, modelCallDetails: [{ phase: 'play', costEstimateUsd: 0.1 }, { phase: 'play', costEstimateUsd: null }] } }, { reserveUsd: 5 });
	close(partial.usd, 0.2);
	// The live estimate applies the same rule to provider rows.
	const live = liveSpendUsd({ profile: claude, traceRows: [{ event: 'native_model_call', goalRevision: 1, inputTokens: 1000, outputTokens: 100 }], providerRows: [{ usage: { status: 'available' } }, { usage: { status: 'missing' } }] });
	assert.equal(live.unmetered, 0, 'Claude meters per call; its counter-missing turn rows are not unmetered calls');
	close(live.usd, liveSpendUsd({ profile: claude, traceRows: [{ event: 'native_model_call', goalRevision: 1, inputTokens: 1000, outputTokens: 100 }] }).usd);
	const codex = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'priority' };
	const counters = [{ event: 'native_token_usage', scope: 'thread_total', agentId: 'a', goalRevision: 1, inputTokens: 10000, cachedInputTokens: 0, outputTokens: 500 }];
	const cutoff = liveSpendUsd({ profile: codex, traceRows: counters, providerRows: [{ usage: { status: 'available' } }, { outcome: 'error', usage: { status: 'missing' } }], reserveUsd: 5 });
	assert.equal(cutoff.unmetered, 1); close(cutoff.usd, liveSpendUsd({ profile: codex, traceRows: counters }).usd + 0.5);
	assert.equal(unmeteredProviderCalls([{ event: 'native_model_call', inputTokens: 1, outputTokens: 1 }], [{ usage: { status: 'missing' } }]), 0);
	assert.equal(unmeteredProviderCalls(counters, [{ usage: { status: 'missing' } }, { usage: { status: 'baseline_unknown' } }, { usage: { status: 'available' } }]), 2);
});

test('death-cut Codex turns are metered by the thread counter read after them, and one thread is counted once', () => {
	const codex = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	const counter = (input) => ({ input, output: 10, reasoning: 0, cached: 0, cacheWrite: 0 });
	const turn = (status, start, end, threadId = 't1') => ({ threadId, outcome: status === 'available' ? 'success' : 'error', usage: { status, start, end } });
	// The live run that falsely hit its cap: each death cancelled a turn before any usage update, then the next turn
	// on the same thread read the counter again (start equal to the cut turn's start, so nothing was lost).
	const rows = [turn('baseline_unknown', null, counter(100)), turn('available', counter(100), counter(200))];
	for (let death = 0; death < 9; death += 1) rows.push(turn('missing', counter(200), null), turn('available', counter(200), counter(200)));
	assert.equal(unmeteredProviderCalls([], rows), 0);
	// Until the thread is read again the cut turn stays charged; a counter reset, or another thread's reading, never covers it.
	assert.equal(unmeteredProviderCalls([], [...rows, turn('missing', counter(200), null)]), 1);
	assert.equal(unmeteredProviderCalls([], [turn('counter_reset', null, counter(5)), turn('available', counter(5), counter(9))]), 1);
	assert.equal(unmeteredProviderCalls([], [turn('missing', counter(1), null), turn('available', counter(1), counter(2), 't2')]), 1);
	// Respawns bump the goal revision but keep the thread: its cumulative total is one thread, not one per revision.
	const totals = [1, 3, 5].map((goalRevision) => ({ event: 'native_token_usage', scope: 'thread_total', agentId: 'a', sessionKey: 's', goalRevision, inputTokens: goalRevision * 1000, cachedInputTokens: 0, outputTokens: 10 }));
	close(liveSpendUsd({ profile: codex, traceRows: totals }).usd, liveSpendUsd({ profile: codex, traceRows: totals.slice(-1) }).usd);
	const live = liveSpendUsd({ profile: codex, traceRows: totals, providerRows: rows, reserveUsd: 1000 });
	assert.equal(live.unmetered, 0);
	assert.ok(live.usd + live.perCallUsd < 999.5, 'nine deaths no longer read as a spent $1000 reserve');
});

test('item 3: a shared ledger file or prior spend carries the cap across invocations', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'spend-ledger-'));
	try {
		const file = path.join(dir, 'ledger.json');
		const train = new SpendLedger({ capUsd: 150, file });
		assert.equal(await train.reserve('train/T01', 100), true);
		await train.settle('train/T01', 120);
		assert.equal(await train.reserve('train/T02', 20), true, 'an open reservation survives in the file');
		const heldout = new SpendLedger({ capUsd: 150, file });
		const before = await heldout.totals();
		close(before.committedUsd, 120); close(before.reservedUsd, 20); assert.equal(before.openReservations, 1);
		assert.equal(await heldout.reserve('heldout/H01', 15), false, '120 + 20 + 15 exceeds 150');
		assert.equal(await heldout.reserve('heldout/H01', 10), true);
		assert.equal((JSON.parse(await readFile(file, 'utf8'))).entries['heldout/H01'].state, 'reserved');
		const seeded = new SpendLedger({ capUsd: 150, priorSpendUsd: 146 });
		assert.equal(await seeded.reserve('x', 5), false); assert.equal(await seeded.reserve('x', 4), true);
		// A stale lock without provable ownership fails closed, regardless of its age.
		await writeFile(`${file}.lock`, ''); const old = new Date(Date.now() - 120000);
		await (await import('node:fs/promises')).utimes(`${file}.lock`, old, old);
		await assert.rejects(new SpendLedger({ file, lockTimeoutMs: 25 }).totals(), /stayed locked/);
		await rm(`${file}.lock`);
		const o = parseSuiteArgs(['--arms', 'a', '--out', 'o', '--max-total-cost-usd', '150', '--prior-spend-usd', '37.5', '--ledger', file, '--run-reserve-usd', '6']);
		assert.equal(o.priorSpendUsd, 37.5); assert.equal(o.ledger, path.resolve(file)); assert.equal(o.runReserveUsd, 6); assert.equal(o.maxPlayCostUsd, 150);
		assert.throws(() => parseSuiteArgs(['--arms', 'a', '--out', 'o', '--prior-spend-usd', '-1']), /prior-spend-usd/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('item 4: invalid runs are excluded from success, survival and judge means and counted', () => {
	const base = { arm: 'B', categories: { hazard: 'fire' }, measurementStatus: 'MEASURED' };
	const scored = (success, extra = {}) => ({ ...base, markers: { goalPredicateMet: success, survived: success, deaths: 0 }, judge: { judgments: [0, 1].map(() => ({ scores: Object.fromEntries(['sensibleGoalPursuit', 'situationalAwareness', 'safety', 'efficiency', 'recovery'].map(k => [k, { score: success ? 4 : 1 }])) })) }, ...extra });
	const runs = [scored(true, { pairId: 'ok' }), scored(false, { pairId: 'leak', observerErrors: ['EVALUATOR_INPUT_LEAK: setup text reached model input'] }),
		{ ...base, pairId: 'nowindow', markers: { status: 'UNAVAILABLE', goalPredicateMet: null } }, scored(false, { pairId: 'capped', stopRequest: { reason: 'SPEND_CAP' } })];
	const summary = summarizeGenerality(runs);
	const row = summary.categories.find(r => r.category === 'B/hazard/fire');
	assert.equal(row.runs, 4); assert.equal(row.invalid, 3);
	assert.deepEqual(row.success, { n: 1, mean: 1 }); assert.deepEqual(row.survival, { n: 1, mean: 1 });
	assert.deepEqual(row.judgeScores.sensibleGoalPursuit, { n: 1, mean: 4 });
	assert.deepEqual(summary.invalidRuns.map(r => [r.pairId, r.reasons]), [['leak', ['EVALUATOR_INPUT_LEAK']], ['nowindow', ['NO_VALID_WINDOW']], ['capped', ['SPEND_CAP_STOP']]]);
});
