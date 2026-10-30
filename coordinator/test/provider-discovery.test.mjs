import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ProviderDiscovery,
	buildProviderRows,
	createAccountReaders,
	openCodeListPrices,
	parseClaudeAuthStatus,
	parseClaudeRateLimitEvent,
	parseCodexAccount,
	parseCodexLoginStatus,
	parseCodexRateLimits,
	parseOpenCodeAuthList,
	parseOpenCodeModels,
	playableOpenCodeModels,
	redactEmail,
} from '../src/provider-discovery.mjs';
import { NATIVE_TOOL_PROVIDERS, PROVIDER_IDS, TOOL_BOUNDARY_STEER_PROVIDERS, normalizeProviderId } from '../src/provider-identity.mjs';
import { PROVIDER_REGISTRY } from '../src/provider-registry.mjs';
import { PROVIDER_CLI } from '../src/provider-cli-health.mjs';
import { normalizeCatalog } from '../src/model-catalog-cache.mjs';

// Fixtures are real outputs captured on the Mini PC (2026-10-22), emails and ids replaced.
const CLAUDE_AUTH_STATUS = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "someone.example@gmail.com",
  "orgId": "00000000-0000-0000-0000-000000000000",
  "orgName": "someone.example@gmail.com's Organization",
  "subscriptionType": "max"
}`;
const OPENCODE_AUTH_LIST = '\u001b[0m\n┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n●  OpenCode \u001b[90mapi\n│\n└  1 credentials\n';
const OPENCODE_MODELS_VERBOSE = `opencode/beam-free
{
  "id": "beam-free",
  "providerID": "opencode",
  "name": "Beam Free",
  "status": "active",
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "capabilities": { "reasoning": true, "toolcall": true },
  "variants": { "low": { "reasoningEffort": "low" }, "medium": {}, "high": {}, "xhigh": {}, "max": {} }
}
opencode/big-pickle
{
  "id": "big-pickle",
  "name": "Big Pickle",
  "status": "active",
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "capabilities": { "toolcall": true },
  "variants": {}
}
opencode/deepseek-v4.1-flash-free
{
  "id": "deepseek-v4.1-flash-free",
  "name": "DeepSeek V4.1 Flash Free",
  "status": "active",
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "capabilities": { "toolcall": true },
  "variants": { "low": {}, "high": {}, "max": {} }
}
opencode/paid-no-tools
{
  "id": "paid-no-tools",
  "name": "Paid Without Tools",
  "status": "active",
  "cost": { "input": 1, "output": 2 },
  "capabilities": { "toolcall": false },
  "variants": {}
}
opencode/old-model
{
  "id": "old-model",
  "name": "Old",
  "status": "deprecated",
  "cost": { "input": 1, "output": 2 },
  "capabilities": { "toolcall": true }
}
`;
const CODEX_RATE_LIMITS = { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: { usedPercent: 84, windowDurationMins: 10080, resetsAt: 1793165163 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '4288.0518257500' }, planType: 'pro', rateLimitReachedType: null } };

test('provider ids, native-tool and steer lists all come from the registry', () => {
	assert.deepEqual(PROVIDER_IDS, Object.keys(PROVIDER_REGISTRY));
	assert.deepEqual(Object.keys(PROVIDER_CLI).sort(), [...PROVIDER_IDS].sort(), 'every adapter declares how to probe its CLI');
	assert.deepEqual(NATIVE_TOOL_PROVIDERS, PROVIDER_IDS.filter((id) => PROVIDER_REGISTRY[id].nativeTools));
	assert.deepEqual(TOOL_BOUNDARY_STEER_PROVIDERS, PROVIDER_IDS.filter((id) => PROVIDER_REGISTRY[id].toolBoundarySteer));
	assert.equal(normalizeProviderId('OpenCode'), 'opencode');
	assert.throws(() => normalizeProviderId('kimi'), /must be one of codex, gemini, claude, opencode/);
});

test('emails are reduced to a short prefix', () => {
	assert.equal(redactEmail('someone.example@gmail.com'), 'some...');
	assert.equal(redactEmail('ab@x.io'), 'ab...');
	assert.equal(redactEmail(null), null);
});

test('Codex login status, account and rate limits', () => {
	assert.deepEqual(parseCodexLoginStatus('Logged in using ChatGPT\n'), { signedIn: true, method: 'ChatGPT' });
	assert.deepEqual(parseCodexLoginStatus('Logged in using an API key'), { signedIn: true, method: 'API key' });
	assert.deepEqual(parseCodexLoginStatus('Not logged in'), { signedIn: false, method: null });
	assert.deepEqual(parseCodexAccount({ account: { type: 'chatgpt', email: 'someone.example@gmail.com', planType: 'pro' }, requiresOpenaiAuth: true }),
		{ name: 'some...', plan: 'pro', method: 'ChatGPT' });
	assert.deepEqual(parseCodexAccount({ account: { type: 'apiKey' } }), { name: null, plan: null, method: 'API key' });
	assert.equal(parseCodexAccount({ account: null }), null);
	assert.deepEqual(parseCodexRateLimits(CODEX_RATE_LIMITS), {
		windows: [{ id: 'primary', usedPercent: 84, windowMins: 10080, resetsAt: 1_793_165_163_000 }],
		credits: { hasCredits: true, unlimited: false, balance: 4288.05182575 },
		plan: 'pro',
		reached: null,
	});
	// The live notification carries the same snapshot without the wrapper.
	assert.equal(parseCodexRateLimits(CODEX_RATE_LIMITS.rateLimits).windows[0].usedPercent, 84);
});

test('Claude auth status keeps only the email prefix and plan; the org name never leaves', () => {
	const parsed = parseClaudeAuthStatus(CLAUDE_AUTH_STATUS);
	assert.deepEqual(parsed, { signedIn: true, name: 'some...', plan: 'max', method: 'claude.ai' });
	assert.equal(JSON.stringify(parsed).includes('gmail'), false);
	assert.equal(parseClaudeAuthStatus('{"loggedIn": false}').signedIn, false);
	assert.equal(parseClaudeAuthStatus('error: unknown command').signedIn, null);
});

test('Claude rate_limit_event becomes plan windows in percent', () => {
	const windows = parseClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1_793_000_000, rateLimitType: 'five_hour', utilization: 0.91,
		unifiedWindows: { five_hour: { utilization: 0.91, resetsAt: 1_793_000_000 }, seven_day: { utilization: 0.4, resetsAt: 1_793_500_000 } } } });
	assert.equal(windows.status, 'allowed_warning');
	assert.deepEqual(windows.windows.map((window) => [window.id, Math.round(window.usedPercent), window.windowMins]), [['five_hour', 91, 300], ['seven_day', 40, 10_080]]);
	const single = parseClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.12 } });
	assert.deepEqual(single.windows.map((window) => Math.round(window.usedPercent)), [12]);
	assert.deepEqual(parseClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }).windows, []);
});

test('OpenCode auth list and models: playable models, free flag and variants as reasoning levels', () => {
	assert.deepEqual(parseOpenCodeAuthList(OPENCODE_AUTH_LIST), { signedIn: true, credentials: ['OpenCode api'] });
	assert.equal(parseOpenCodeAuthList('0 credentials').signedIn, false);
	const models = parseOpenCodeModels(OPENCODE_MODELS_VERBOSE);
	assert.deepEqual(models.map((model) => model.id), ['opencode/beam-free', 'opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free', 'opencode/paid-no-tools', 'opencode/old-model']);
	const playable = playableOpenCodeModels(models);
	assert.deepEqual(playable.map((model) => [model.id, model.free, model.efforts]), [
		['opencode/beam-free', true, ['low', 'medium', 'high', 'xhigh', 'max']],
		['opencode/big-pickle', true, ['default']],
		['opencode/deepseek-v4.1-flash-free', true, ['low', 'high', 'max']],
	]);
	// Plain `opencode models` (no JSON) still lists ids.
	assert.deepEqual(parseOpenCodeModels('opencode/glm-5.3-flash-free\nopencode/other\n').map((model) => [model.id, model.free]), [['opencode/glm-5.3-flash-free', true], ['opencode/other', false]]);
});

test('free OpenCode models get the list price of their paid twin from the models.dev cache', () => {
	const prices = openCodeListPrices({ opencode: { models: {
		'deepseek-v4.1-flash': { cost: { input: 0.3, output: 1.2, cache_read: 0.006 } },
		'glm-5.3-flash': { cost: { input: 0, output: 0 } },
	} } }, ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/big-pickle']);
	assert.deepEqual(prices, { 'opencode/deepseek-v4.1-flash-free': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 } });
});

test('Codex model/list keeps the CLI default model and default effort', () => {
	const models = normalizeCatalog([
		{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], serviceTiers: [{ id: 'priority' }] },
		{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], serviceTiers: [{ id: 'priority' }] },
	]).map((model) => ({ ...model, provider: 'codex' }));
	const rows = buildProviderRows({ catalogModels: models });
	const codex = rows.find((row) => row.id === 'codex');
	assert.equal(codex.defaultModel, 'gpt-6.1-sol');
	assert.deepEqual(codex.models.map((model) => [model.id, model.defaultEffort, model.tiers]), [['gpt-6-astra', 'medium', ['default', 'priority']], ['gpt-6.1-sol', 'low', ['default', 'priority']]]);
});

test('provider rows: a missing or signed-out CLI keeps its row but offers no models', () => {
	const catalogModels = [
		{ provider: 'claude', id: 'claude-opus-5-5', model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', reasoningEfforts: ['low'], serviceTiers: ['priority'] },
		{ provider: 'opencode', id: 'opencode/big-pickle', model: 'opencode/big-pickle', displayName: 'Big Pickle', reasoningEfforts: ['default'], serviceTiers: ['priority'], free: true },
		{ provider: 'gemini', id: 'gemini-3.1-pro', model: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', reasoningEfforts: ['low'], serviceTiers: [] },
	];
	const rows = buildProviderRows({
		catalogModels,
		health: {
			claude: { status: 'unauthenticated', version: '2.1.303', checkedAtEpochMs: 5 },
			opencode: { status: 'ok', version: '1.19.3', checkedAtEpochMs: 6 },
			gemini: { status: 'missing', version: null, checkedAtEpochMs: 7 },
		},
		accounts: { opencode: { signedIn: true, name: null, plan: 'Zen', method: 'OpenCode api' } },
		limits: { codex: 'weekly 84% used' },
	});
	const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
	assert.deepEqual([byId.claude.installed, byId.claude.signedIn, byId.claude.models.length], [true, false, 0]);
	assert.deepEqual([byId.gemini.installed, byId.gemini.models.length], [false, 0]);
	assert.deepEqual([byId.opencode.signedIn, byId.opencode.account, byId.opencode.plan, byId.opencode.models[0].free, byId.opencode.limitKind], [true, 'OpenCode api', 'Zen', true, 'requests']);
	// Unknown health (probes disabled) keeps the provider usable.
	assert.deepEqual([byId.codex.installed, byId.codex.signedIn, byId.codex.limit], [null, null, 'weekly 84% used']);
});

test('discovery scans every adapter, reads accounts only for installed CLIs and rescans on demand', async () => {
	const checks = [];
	const health = { enabled: true, invalidate: () => checks.push('invalidate'), check: async (id) => { checks.push(id); return { provider: id, status: id === 'gemini' ? 'missing' : 'ok', version: '1.0', checkedAtEpochMs: 10 }; } };
	const read = [];
	const discovery = new ProviderDiscovery({ cliHealth: health, now: () => 99, accountReaders: {
		codex: async () => { read.push('codex'); return { signedIn: true, name: 'some...', plan: 'pro' }; },
		gemini: async () => { read.push('gemini'); return {}; },
		claude: async () => { throw new Error('status failed'); },
	} });
	const seen = [];
	discovery.onChange((state) => seen.push(state.checkedAt));
	const state = await discovery.refresh({ force: true });
	assert.deepEqual(checks.filter((entry) => entry !== 'invalidate').sort(), [...PROVIDER_IDS].sort());
	assert.deepEqual(read, ['codex'], 'a missing CLI is not asked for its account');
	assert.equal(state.accounts.claude, null, 'a failed reader leaves the account unknown');
	assert.deepEqual(seen, [99]);
	assert.equal(discovery.rows([]).find((row) => row.id === 'codex').plan, 'pro');
	assert.equal(new ProviderDiscovery({ cliHealth: null }).enabled, false);
});

test('account readers run only read-only status commands', async () => {
	const calls = [];
	const execFile = (command, args, options, callback) => {
		calls.push([command, ...args]);
		const out = command === 'claude' ? CLAUDE_AUTH_STATUS : command === 'opencode' ? OPENCODE_AUTH_LIST : 'Logged in using ChatGPT';
		callback(null, out, '');
	};
	const readers = createAccountReaders({ execFile });
	assert.deepEqual(await readers.codex(), { signedIn: true, name: null, plan: null, method: 'ChatGPT' });
	assert.equal((await readers.claude()).plan, 'max');
	assert.equal((await readers.opencode()).signedIn, true);
	assert.deepEqual(calls, [['codex', 'login', 'status'], ['claude', 'auth', 'status', '--json'], ['opencode', 'auth', 'list']]);
	// With the app-server running, Codex reads the account and its limits there instead.
	const live = createAccountReaders({ execFile, codexService: { readAccount: async () => ({ account: { name: 'some...', plan: 'pro', method: 'ChatGPT' }, rateLimits: { windows: [] } }) } });
	assert.deepEqual(await live.codex(), { signedIn: true, name: 'some...', plan: 'pro', method: 'ChatGPT', rateLimits: { windows: [] } });
});
