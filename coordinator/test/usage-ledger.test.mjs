import assert from 'node:assert/strict';
import test from 'node:test';

import { callCostUsd, registerDiscoveredPrice } from '../src/call-cost.mjs';
import { UsageLedger, hoursUntil, seriesRates, warningLevel } from '../src/usage-ledger.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function clock(start = 1_800_000_000_000) {
	const state = { now: start };
	return { now: () => state.now, advance: (ms) => { state.now += ms; return state.now; }, state };
}

const sol = { agentId: 'sol-1', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default', goalRevision: 1 };
const deep = { agentId: 'deep-1', provider: 'opencode', model: 'opencode/deepseek-v4.1-flash-free', reasoningEffort: 'low', serviceTier: 'priority', goalRevision: 1 };
const opus = { agentId: 'opus-1', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority', goalRevision: 3 };

test('warning thresholds: yellow under 3 h, red under 1 h', () => {
	assert.equal(warningLevel(null), 'none');
	assert.equal(warningLevel(3), 'none');
	assert.equal(warningLevel(2.99), 'yellow');
	assert.equal(warningLevel(1), 'yellow');
	assert.equal(warningLevel(0.99), 'red');
	assert.equal(warningLevel(0), 'red');
	assert.equal(hoursUntil(16, 4), 4);
	assert.equal(hoursUntil(0, 4), 0);
	assert.equal(hoursUntil(10, 0), null, 'nothing used means no projection');
});

test('series rates need two minutes of samples and report per minute (last 10 min) and per hour (last hour)', () => {
	const now = 10 * HOUR;
	assert.deepEqual(seriesRates([{ at: now - MINUTE, value: 1 }, { at: now, value: 2 }], now), { perMinute: null, perHour: null });
	const rates = seriesRates([{ at: now - HOUR, value: 10 }, { at: now - 10 * MINUTE, value: 15 }, { at: now, value: 16 }], now);
	assert.equal(rates.perHour, 6);
	assert.ok(Math.abs(rates.perMinute - 0.1) < 1e-9);
});

test('Codex cumulative thread totals: repeated reports are not double counted and each timed call counts once', () => {
	const time = clock();
	const ledger = new UsageLedger({ now: time.now });
	ledger.registerAgent(sol);
	time.advance(10_000);
	ledger.recordUsage(sol, { threadId: 't1', inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50, reasoningOutputTokens: 20,
		last: { inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50, reasoningOutputTokens: 20 }, call: { provider: 'codex', requestAt: time.state.now - 4_000, endedAt: time.state.now, totalMs: 4_000 } });
	ledger.recordUsage(sol, { threadId: 't1', inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50, reasoningOutputTokens: 20 });
	time.advance(10_000);
	ledger.recordUsage(sol, { threadId: 't1', inputTokens: 2_500, cachedInputTokens: 2_000, outputTokens: 90, reasoningOutputTokens: 30,
		call: { provider: 'codex', requestAt: time.state.now - 1_000, endedAt: time.state.now, totalMs: 1_000 } });
	const row = ledger.agentRow('sol-1');
	assert.equal(row.calls, 2);
	assert.deepEqual(row.tokens, { input: 2_500, cached: 2_000, uncached: 500, cacheWrite: 0, output: 90, reasoning: 30 });
	assert.equal(row.busyMs, 5_000);
	assert.equal(row.busyPercent, 25, '5 s of model calls in 20 s since the agent started');
	// 500 uncached x $2 + 2000 cached x $0.1 + 90 out x $10 per million.
	assert.ok(Math.abs(row.costUsd - (500 * 2 + 2_000 * 0.1 + 90 * 10) / 1e6) < 1e-9);
	assert.deepEqual([row.model, row.effort, row.tier], ['gpt-6.1-sol', 'low', 'default']);
	assert.equal(row.last.input, 1_500);
});

test('per-call reports (Claude, OpenCode) count each call; a new session thread uses the call figures', () => {
	const time = clock();
	const ledger = new UsageLedger({ now: time.now });
	const report = (totals, last, ms) => ({ threadId: 'claude:opus-1:1', ...totals, last, call: { provider: 'claude', totalMs: ms, endedAt: time.state.now } });
	ledger.recordUsage(opus, report({ inputTokens: 10_000, cachedInputTokens: 0, cacheWriteInputTokens: 9_000, outputTokens: 100 }, { inputTokens: 10_000, cachedInputTokens: 0, cacheWriteInputTokens: 9_000, outputTokens: 100 }, 3_000));
	time.advance(5_000);
	ledger.recordUsage(opus, report({ inputTokens: 20_500, cachedInputTokens: 9_000, cacheWriteInputTokens: 10_000, outputTokens: 180 }, { inputTokens: 10_500, cachedInputTokens: 9_000, cacheWriteInputTokens: 1_000, outputTokens: 80 }, 2_000));
	// A rotated session keeps process-wide totals; the first report on the new thread counts its own call only.
	time.advance(5_000);
	ledger.recordUsage(opus, { threadId: 'claude:opus-1:2', inputTokens: 31_000, cachedInputTokens: 9_000, cacheWriteInputTokens: 20_000, outputTokens: 200,
		last: { inputTokens: 10_500, cachedInputTokens: 0, cacheWriteInputTokens: 10_000, outputTokens: 20 }, call: { provider: 'claude', totalMs: 1_000, endedAt: time.state.now } });
	const row = ledger.agentRow('opus-1');
	assert.equal(row.calls, 3);
	assert.deepEqual(row.tokens, { input: 31_000, cached: 9_000, uncached: 2_000, cacheWrite: 20_000, output: 200, reasoning: 0 });
	assert.equal(row.busyMs, 6_000);
	assert.ok(row.costUsd > 0);
});

test('free models cost $0 and show a list-price equivalent when one is known', () => {
	registerDiscoveredPrice('opencode', 'opencode/deepseek-v4.1-flash-free', { free: true, listPrice: { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2 } });
	registerDiscoveredPrice('opencode', 'opencode/big-pickle', { free: true });
	assert.deepEqual(callCostUsd({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }, { provider: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' }), { costUsd: 0, listCostUsd: 1.5, free: true });
	assert.deepEqual(callCostUsd({ input: 5, cacheRead: 0, cacheWrite: 0, output: 5 }, { provider: 'opencode', model: 'opencode/big-pickle' }), { costUsd: 0, listCostUsd: null, free: true });
	assert.deepEqual(callCostUsd({ input: 5, cacheRead: 0, cacheWrite: 0, output: 5 }, { provider: 'codex', model: 'gpt-9-unknown' }), { costUsd: null, listCostUsd: null, free: false });
	const time = clock();
	const ledger = new UsageLedger({ now: time.now });
	ledger.recordUsage(deep, { threadId: 'opencode:deep-1:1', inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000, last: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, call: { totalMs: 500 } });
	const row = ledger.agentRow('deep-1');
	assert.deepEqual([row.costUsd, row.listCostUsd, row.free], [0, 1.5, true]);
});

test('a goal revision keeps lifetime totals and starts fresh per-goal values', () => {
	const time = clock();
	const ledger = new UsageLedger({ now: time.now });
	const call = (record, totals) => ledger.recordUsage(record, { threadId: 't', ...totals, call: { totalMs: 100 } });
	call(sol, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 });
	call({ ...sol, goalRevision: 2 }, { inputTokens: 300, cachedInputTokens: 0, outputTokens: 30 });
	const row = ledger.agentRow('sol-1');
	assert.equal(row.calls, 2);
	assert.equal(row.tokens.input, 300);
	assert.deepEqual([row.goal.revision, row.goal.calls, row.goal.tokens.input], [2, 1, 200]);
});

test('agent rates per minute and per hour', () => {
	const time = clock();
	const ledger = new UsageLedger({ now: time.now });
	ledger.registerAgent(sol);
	for (let index = 1; index <= 30; index += 1) {
		time.advance(MINUTE);
		ledger.recordUsage(sol, { threadId: 't', inputTokens: index * 1_000, cachedInputTokens: 0, outputTokens: index * 10, call: { totalMs: 1_000 } });
	}
	const row = ledger.agentRow('sol-1');
	assert.equal(row.perMinute.calls, 1);
	assert.equal(row.perMinute.tokensIn, 1_000);
	assert.equal(row.perHour.calls, 60, 'thirty calls in thirty minutes is sixty an hour');
	assert.ok(Math.abs(row.busyPercent - 100 / 60) < 0.1);
});

test('plan-percent windows: rate, projection, reset-first and one warning per level change', () => {
	const time = clock();
	const warnings = [];
	const ledger = new UsageLedger({ now: time.now, onWarning: (warning) => warnings.push(warning) });
	ledger.registerAgent(sol);
	ledger.setAccount('codex', { name: 'some...', plan: 'pro' });
	const resetsAt = Math.floor((time.state.now + 30 * 24 * HOUR) / 1000);
	ledger.recordAllowance('codex', { primary: { usedPercent: 80, windowDurationMins: 10080, resetsAt }, secondary: null });
	time.advance(30 * MINUTE);
	ledger.recordAllowance('codex', { primary: { usedPercent: 84, windowDurationMins: 10080, resetsAt }, secondary: null });
	let account = ledger.accountRow('codex');
	assert.equal(account.windows[0].perHour, 8);
	assert.equal(account.windows[0].hoursToLimit, 2, '16% left at 8%/h');
	assert.deepEqual([account.warning, account.account, account.plan, account.limitKind], ['yellow', 'some...', 'pro', 'plan_percent']);
	assert.deepEqual(account.agents, ['sol-1'], 'account rows name their agents instead of being copied into them');
	assert.equal(warnings.length, 1);
	assert.match(warnings[0].message, /Codex \(some...\) usage warning: weekly window 84% used, about 2 h to the limit/);
	// Same level again: no repeat.
	ledger.recordAllowance('codex', { primary: { usedPercent: 84, windowDurationMins: 10080, resetsAt }, secondary: null });
	assert.equal(warnings.length, 1);
	time.advance(30 * MINUTE);
	ledger.recordAllowance('codex', { primary: { usedPercent: 92, windowDurationMins: 10080, resetsAt }, secondary: null });
	account = ledger.accountRow('codex');
	assert.equal(account.warning, 'red');
	assert.deepEqual(warnings.map((warning) => warning.level), ['yellow', 'red']);
	// A window that resets before the projected limit does not warn.
	const soon = Math.floor((time.state.now + 10 * MINUTE) / 1000);
	const other = new UsageLedger({ now: time.now });
	other.recordAllowance('codex', { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: soon } });
	time.advance(5 * MINUTE);
	other.recordAllowance('codex', { primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: soon } });
	assert.deepEqual([other.accountRow('codex').windows[0].resetsFirst, other.accountRow('codex').warning], [true, 'none']);
});

test('credits: balance burn rate and hours left', () => {
	const time = clock();
	const ledger = new UsageLedger({ now: time.now });
	ledger.recordAllowance('codex', { credits: { hasCredits: true, unlimited: false, balance: '4300' } });
	time.advance(HOUR);
	ledger.recordAllowance('codex', { credits: { hasCredits: true, unlimited: false, balance: '4015' } });
	const credits = ledger.accountRow('codex').credits;
	assert.deepEqual([credits.remaining, credits.perHour], [4015, 285]);
	assert.equal(credits.hoursToLimit, 14.09);
	assert.equal(ledger.limitSummaries().codex, 'credits 4015');
});

test('Claude windows from rate_limit_event and the provider status', () => {
	const time = clock();
	const ledger = new UsageLedger({ now: time.now });
	ledger.recordAllowance('claude', { provider: 'claude', status: 'allowed_warning', windows: [{ id: 'five_hour', usedPercent: 91, windowMins: 300, resetsAt: time.state.now + HOUR }], overage: false });
	const row = ledger.accountRow('claude');
	assert.deepEqual([row.windows[0].usedPercent, row.warning], [91, 'yellow']);
	assert.equal(ledger.limitSummaries().claude, '5-hour 91% used');
});

test('request-limited accounts (OpenCode free): request rates and 429s', () => {
	const time = clock();
	const warnings = [];
	const ledger = new UsageLedger({ now: time.now, onWarning: (warning) => warnings.push(warning) });
	for (let index = 0; index < 20; index += 1) {
		time.advance(30_000);
		ledger.recordUsage(deep, { threadId: 'opencode:deep-1:1', inputTokens: (index + 1) * 100, cachedInputTokens: 0, outputTokens: index + 1, call: { totalMs: 1_000 } });
	}
	let row = ledger.accountRow('opencode');
	assert.deepEqual([row.limitKind, row.requests.perMinute, row.requests.perHour, row.warning], ['requests', 2, 20, 'none']);
	ledger.recordRateLimited('opencode');
	row = ledger.accountRow('opencode');
	assert.deepEqual([row.requests.rateLimited.total, row.warning], [1, 'red']);
	time.advance(20 * MINUTE);
	ledger.evaluateAll();
	assert.equal(ledger.accountRow('opencode').warning, 'yellow', 'a 429 within the hour stays a caution');
	assert.deepEqual(warnings.map((warning) => warning.level), ['red', 'yellow']);
});

test('the roster covers every agent at once plus one row per account', () => {
	const time = clock();
	const ledger = new UsageLedger({ now: time.now });
	ledger.recordUsage(sol, { threadId: 't', inputTokens: 100, cachedInputTokens: 0, outputTokens: 1, call: { totalMs: 1 } });
	ledger.recordUsage(deep, { threadId: 'o', inputTokens: 100, cachedInputTokens: 0, outputTokens: 1, call: { totalMs: 1 } });
	ledger.recordAllowance('codex', { primary: { usedPercent: 10, windowDurationMins: 10080 } });
	const roster = ledger.roster([sol, deep, opus]);
	assert.deepEqual(roster.agents.map((row) => [row.agentId, row.calls]), [['sol-1', 1], ['deep-1', 1], ['opus-1', 0]]);
	assert.deepEqual(roster.accounts.map((row) => row.provider).sort(), ['claude', 'codex', 'opencode']);
	assert.equal(roster.agents.some((row) => 'windows' in row || 'credits' in row), false, 'agents never carry account data');
	ledger.removeAgent('deep-1');
	assert.deepEqual(ledger.roster().agents.map((row) => row.agentId), ['sol-1', 'opus-1']);
	assert.ok(Buffer.byteLength(JSON.stringify(roster)) < 8_000);
});
