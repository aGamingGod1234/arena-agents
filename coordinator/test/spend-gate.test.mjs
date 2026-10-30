import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { SpendGate, startAnthropicGateway, worstCallUsd, anthropicResponseUsage, codexJudgeWorstUsd, PREPARATION_ALLOWANCE_USD } from '../src/benchmark/spend-gate.mjs';
import { SpendLedger, runSpendUsd, liveSpendUsd, MIN_SUITE_RESERVE_USD, JUDGE_ALLOWANCE_USD } from '../src/benchmark/spend-ledger.mjs';
import { JudgeAttemptError } from '../src/benchmark/generality-judge.mjs';
import { Observer } from '../../scripts/quality/run-scenarios.mjs';
import { gatedSuiteRun, parseSuiteArgs } from '../../scripts/quality/run-generality.mjs';

const opus = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };
const sol = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium', serviceTier: 'priority' };
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const sse = usage => [`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } })}\n\n`,
	`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage })}\n\n`, 'event: message_stop\ndata: {"type":"message_stop"}\n\n'].join('');
const streamResponse = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });

/** A fake Anthropic upstream that records what the gateway forwarded and answers with the next scripted usage. */
function upstream(replies) {
	const seen = [];
	const fetchImpl = async (url, init) => { const body = JSON.parse(Buffer.from(init.body).toString('utf8')); seen.push({ url, maxTokens: body.max_tokens, bytes: init.body.length }); return replies.shift()(body); };
	return { seen, fetchImpl };
}
async function post(gateway, bytes, maxTokens) {
	const body = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: maxTokens, stream: true, messages: [{ role: 'user', content: 'x'.repeat(Math.max(0, bytes - 120)) }] });
	const response = await fetch(`${gateway.url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
	return { status: response.status, text: await response.text() };
}

test('r4 finding 1: completed-call checks let a large next call pass $4; the gate refuses or shrinks any call whose worst case does not fit', async () => {
	const gate = new SpendGate({ budgetUsd: 4 });
	// Ten calls of about $0.34 each (17,000 output tokens at the $20/M proxy), then the review's 400,000-token request.
	const usage = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 17000 };
	const { seen, fetchImpl } = upstream([...Array.from({ length: 10 }, () => () => streamResponse(sse(usage))), () => streamResponse(sse({ ...usage, output_tokens: 2000 }))]);
	const gateway = await startAnthropicGateway({ gate, profileFor: model => ({ ...opus, model }), fetchImpl });
	try {
		for (let i = 0; i < 10; i++) assert.equal((await post(gateway, 1000, 20000)).status, 200);
		close(gate.totals().chargeUsd, 10 * (1000 * 2 + 17000 * 20) / 1e6);
		const before = gate.totals().chargeUsd;
		const huge = await post(gateway, 400000, 128000);
		assert.equal(huge.status, 400); assert.match(huge.text, /Evaluator spend cap/);
		assert.equal(seen.length, 10, 'the refused request never reached the provider');
		// A small request that only fits with a lower output limit is forwarded with that limit.
		const clamped = await post(gateway, 1000, 128000);
		assert.equal(clamped.status, 200);
		const forwarded = seen.at(-1).maxTokens;
		assert.ok(forwarded < 128000 && forwarded >= 4096, `forwarded max_tokens ${forwarded}`);
		assert.ok(before + worstCallUsd({ inputTokens: seen.at(-1).bytes + 64, outputTokens: forwarded, profile: opus }) <= 4 + 1e-9);
		const totals = gate.totals();
		assert.ok(totals.chargeUsd <= 4, `charged ${totals.chargeUsd}`); assert.equal(totals.overruns.length, 0); assert.equal(totals.denied, 1);
	} finally { await gateway.close(); }
});

test('r4 finding 1: in-flight calls are reserved before they spend, cut-off streams pay reported input plus their whole output allowance, unstarted errors cost nothing', async () => {
	const gate = new SpendGate({ budgetUsd: 1 });
	assert.equal(gate.admit('a', 0.6, 'model call'), true);
	assert.equal(gate.admit('b', 0.6, 'model call'), false, 'a second in-flight call cannot borrow the first one\'s reservation');
	gate.settle('a', 0.2); assert.equal(gate.admit('b', 0.6, 'model call'), true);
	gate.settle('b', null); close(gate.totals().chargeUsd, 0.8);
	const cut = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`;
	const g2 = new SpendGate({ budgetUsd: 10 });
	const bare = ['event: message_start', 'data: {"type":"message_start","message":{}}', '', ''].join('\n');
	const { fetchImpl } = upstream([() => streamResponse(cut), () => new Response('{"type":"error"}', { status: 500 }), () => streamResponse(bare)]);
	const gateway = await startAnthropicGateway({ gate: g2, profileFor: model => ({ ...opus, model }), fetchImpl });
	try {
		// Cut off after message_start: the reported input is exact, the output is charged at its whole allowance.
		await post(gateway, 2000, 1000);
		const cutCharge = (10 * 2 + 1000 * 20) / 1e6;
		close(g2.totals().chargeUsd, cutCharge); assert.equal(gateway.calls[0].metered, false);
		await post(gateway, 2000, 1000);
		close(g2.totals().chargeUsd, cutCharge); assert.equal(gateway.calls[1].usd, 0);
		// Started without any usage: the full worst case stays charged.
		await post(gateway, 2000, 1000);
		const worst = worstCallUsd({ inputTokens: gateway.calls[2].requestBytes + 64, outputTokens: 1000, profile: opus });
		close(g2.totals().chargeUsd, cutCharge + worst);
	} finally { await gateway.close(); }
	assert.deepEqual(anthropicResponseUsage(sse({ input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 9, output_tokens: 11 }), true).final, { input: 5, cacheRead: 7, cacheWrite: 9, output: 11 });
});

test('r4 finding 1: live and settlement charge a missing Codex usage row the same way', () => {
	const R = 4, counters = [{ event: 'native_token_usage', scope: 'thread_total', agentId: 'a', goalRevision: 1, inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 82_500 }];
	const missing = [{ outcome: 'error', usage: { status: 'missing' } }];
	const live = liveSpendUsd({ traceRows: counters, providerRows: missing, profile: sol, reserveUsd: R });
	const metered = liveSpendUsd({ traceRows: counters, profile: sol }).usd;
	close(metered, 3.65);
	const settled = runSpendUsd({ metrics: { modelCalls: 20, costEstimateUsd: metered, playCostEstimateUsd: metered, modelCallDetails: [] }, unmeteredProviderCalls: 1 }, { reserveUsd: R });
	close(live.usd, settled.usd); close(live.usd, 3.65 + R / 10);
	// The observer-metered Codex stop leaves room for one more call at that same charge.
	assert.ok(settled.overReservationUsd > 0, 'an overrun is still reported in full, never clipped');
});

test('observer mode refuses judge retries that exceed estimated remaining allowance', async () => {
	assert.throws(() => parseSuiteArgs(['--arms', 'a', '--out', 'o', '--run-reserve-usd', '0.10']), /at least/);
	assert.ok(MIN_SUITE_RESERVE_USD >= PREPARATION_ALLOWANCE_USD + JUDGE_ALLOWANCE_USD + 1);
	assert.throws(() => parseSuiteArgs(['--arms', 'a', '--out', 'o', '--provider', 'codex']), /codex-observer-cap/);
	const R = 5;
	let gatewayGate = null;
	const gatewayFactory = async ({ gate }) => { gatewayGate = gate; return { url: 'http://127.0.0.1:1', calls: [], close: async () => {}, set gate(g) { gatewayGate = g; }, get gate() { return gatewayGate; } }; };
	const execute = async options => {
		const gate = options.spendGate;
		assert.ok(gate.admit('preparation', PREPARATION_ALLOWANCE_USD, 'preparation'));
		// Claude play spends up to what the gate allows; the judge allowance stays held during play.
		for (let i = 0; gate.admit(`call-${i}`, 0.4, 'model call'); i++) gate.settle(`call-${i}`, 0.39);
		close(gate.available(), gate.budgetUsd - gate.totals().chargeUsd);
		assert.ok(gate.totals().chargeUsd - JUDGE_ALLOWANCE_USD <= R - JUDGE_ALLOWANCE_USD + 1e-9 && gate.totals().byLabel['judge allowance'] === JUDGE_ALLOWANCE_USD);
		gate.settle('preparation', 0.01);
		return { runs: [{ artifacts: null, metrics: { modelCalls: 5 }, setup: null, gate: { ...gate.totals(), playMetering: 'gateway' } }] };
	};
	const attempts = [];
	// A judge that keeps failing and retrying four times at about $0.60 each.
	const judge = async ({ invoke }) => {
		const rows = [];
		for (const [round, attempt] of [[1, 1], [1, 2], [2, 1], [2, 2]]) {
			try { const r = await invoke({ round, attempt, prompt: 'p'.repeat(4000) }); rows.push({ round, attempt, costUsd: r.costUsd }); }
			catch (error) { rows.push({ round, attempt, refused: /refused/.test(error.message), costUsd: error.costUsd }); }
		}
		return { attempts: rows, costUsd: rows.reduce((s, r) => s + (r.costUsd ?? 0), 0), unknownSpend: false };
	};
	const invokeJudge = async args => { attempts.push(args); throw new JudgeAttemptError('bad answer', { costUsd: 0.6 }); };
	const run = await gatedSuiteRun({ reserveUsd: R, codexObserverCap: true, scenario: { id: 'T01', goal: 'g', objective: { type: 'health', minimum: 10 } }, repetition: 1, arm: 'B', judge: { armProvider: 'claude', effort: 'medium', serviceTier: 'priority' }, options: { provider: 'claude', effort: 'low', out: '.' } },
		{ execute, judge, invokeJudge, gatewayFactory, readText: async () => '' });
	const bound = codexJudgeWorstUsd('p'.repeat(4000), sol);
	assert.ok(bound > 0.6, `judge bound ${bound}`);
	assert.ok(run.gate.chargeUsd <= R + 1e-9, `charged ${run.gate.chargeUsd} of ${R}`);
	assert.ok(run.judge.attempts.some(a => a.refused), 'attempts that no longer fit are refused before launch');
	assert.equal(attempts.length, run.judge.attempts.filter(a => !a.refused).length);
	close(runSpendUsd(run, { reserveUsd: R }).usd, run.gate.chargeUsd);
	assert.equal(process.env.ANTHROPIC_BASE_URL, undefined, 'the worker restores its environment');
});

function stoppingObserver({ responses, gate = new SpendGate({ budgetUsd: 1 }), protocolRows = [], options = {} }) {
	const hardStops = [], commands = [];
	const observer = new Observer('.', { protocolAudit: '', providerTurns: '' }, {}, opus, { gate, hardStop: async reason => { hardStops.push(reason); }, stopRetryMs: 0, ...options });
	observer.agent = 'player'; observer.protocol = { rows: protocolRows };
	observer.rcon = { command: async text => { commands.push(text); const next = responses.shift(); if (next instanceof Error) throw next; return { text: next ?? '' }; } };
	return { observer, hardStops, commands, gate };
}

test('r4 finding 2: a failed stop closes the gate, is retried, and escalates to a process-tree stop', async () => {
	const timeout = () => new Error('RCON command timed out');
	const { observer, hardStops, commands, gate } = stoppingObserver({ responses: [timeout(), timeout(), timeout()] });
	await observer.requestStop('SPEND_CAP');
	assert.equal(gate.admit('next', 0.01), false, 'no paid call can start once a stop is requested, even before RCON answers');
	assert.equal(observer.stopRequest.state, 'pending'); assert.equal(observer.stopRequest.failures.length, 1);
	await observer.progressStop(); await observer.progressStop();
	assert.equal(commands.length, 3, 'each poll retries the stop');
	await observer.progressStop();
	assert.deepEqual(hardStops, ['SPEND_CAP']); assert.equal(observer.stopRequest.state, 'escalated');
	await observer.progressStop(); assert.equal(hardStops.length, 1);
	// A rejected answer is not an acknowledgement.
	const rejected = stoppingObserver({ responses: ['Unknown agent player', 'Unknown agent player', 'Unknown agent player'] });
	for (let i = 0; i < 4; i++) i ? await rejected.observer.progressStop() : await rejected.observer.requestStop('ADVANCEMENT');
	assert.deepEqual(rejected.hardStops, ['ADVANCEMENT']);
	// An accepted command that never shows up as a goal stop also escalates after the confirmation window.
	const silent = stoppingObserver({ responses: ['Stopped player', 'Stopped player'], options: { stopConfirmMs: 0 } });
	await silent.observer.requestStop('SPEND_CAP'); await silent.observer.progressStop();
	assert.deepEqual(silent.hardStops, ['SPEND_CAP']);
	// The protocol's goal stop confirms it and nothing is killed.
	const confirmed = stoppingObserver({ responses: ['Stopped player'], protocolRows: [] });
	await confirmed.observer.requestStop('SPEND_CAP');
	confirmed.observer.protocol.rows.push({ type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 1 } }, { type: 'goal_control', agentId: 'a', payload: { operation: 'stop', updatedAtEpochMs: 2 } });
	await confirmed.observer.progressStop();
	assert.equal(confirmed.observer.stopRequest.state, 'confirmed'); assert.deepEqual(confirmed.hardStops, []);
	// A gate refusal ends gateway-metered play through the same path.
	const refused = stoppingObserver({ responses: ['Stopped player'] });
	refused.gate.admit('too-big', 5);
	await refused.observer.enforceSpendCap();
	assert.equal(refused.observer.stopRequest.reason, 'SPEND_CAP');
});

test('r4 finding 3: a prior-spend seed is stored in the ledger and survives reopening without the flag', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'ledger-seed-'));
	try {
		const file = path.join(dir, 'ledger.json');
		const first = new SpendLedger({ capUsd: 150, priorSpendUsd: 146, file });
		assert.equal(await first.reserve('r1', 1), true); await first.settle('r1', 1);
		close((await first.totals()).committedUsd, 147);
		const reopened = new SpendLedger({ capUsd: 150, file });
		const totals = await reopened.totals();
		close(totals.committedUsd, 147); assert.equal(totals.priorSpendUsd, 146); assert.equal(totals.settledRuns, 1);
		assert.equal(await reopened.reserve('r2', 149), false, 'the review reproduction: $149 no longer fits');
		assert.equal(await reopened.reserve('r2', 3), true);
		await assert.rejects(new SpendLedger({ capUsd: 150, priorSpendUsd: 100, file }).totals(), /seeded with prior spend \$146/);
		assert.equal(await new SpendLedger({ capUsd: 150, priorSpendUsd: 146, file }).reserve('r3', 0), true, 'restating the same seed is accepted');
		const unseeded = path.join(dir, 'unseeded.json');
		const plain = new SpendLedger({ capUsd: 10, file: unseeded }); await plain.reserve('x', 1); await plain.settle('x', 1);
		await assert.rejects(new SpendLedger({ capUsd: 10, priorSpendUsd: 5, file: unseeded }).totals(), /can only be set when the ledger is created/);
		assert.equal(parseSuiteArgs(['--arms', 'a', '--out', 'o', '--ledger', file]).priorSpendUsd, null, 'omitting the flag inherits the stored seed');
	} finally { await rm(dir, { recursive: true, force: true }); }
});
