import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { estimateTokenCostUsd } from '../src/call-cost.mjs';
import {
	OPENCODE_PERMISSION, OpenCodeProviderService, RATE_LIMIT_RETRY, buildOpenCodeConfig, buildOpenCodeLaunch,
	classifyOpenCodeError, redactSecrets, retryDelayMs, splitModel,
} from '../src/opencode-service.mjs';
import { PROVIDER_IDS, NATIVE_TOOL_PROVIDERS, TOOL_BOUNDARY_STEER_PROVIDERS } from '../src/provider-identity.mjs';

const DEEPSEEK = 'opencode/deepseek-v4.1-flash-free';
const GLM = 'opencode/glm-5.3-flash-free';
const TOKEN = 'ab'.repeat(32);

test('opencode is a native-tool provider that receives steers at tool boundaries', () => {
	assert.ok(PROVIDER_IDS.includes('opencode'));
	assert.ok(NATIVE_TOOL_PROVIDERS.includes('opencode'));
	assert.deepEqual(TOOL_BOUNDARY_STEER_PROVIDERS, ['claude', 'opencode']);
	assert.deepEqual(splitModel(DEEPSEEK), ['opencode', 'deepseek-v4.1-flash-free']);
	assert.throws(() => splitModel('deepseek'), (error) => error.code === 'UNSUPPORTED_MODEL');
});

test('generated config carries our prompt and route, keeps built-in tools listed and blocks them', () => {
	const config = buildOpenCodeConfig({ prompt: 'PLAY MINECRAFT', mcp: { url: 'http://127.0.0.1:9/mcp', token: TOKEN } });
	assert.equal(config.agent.arena.prompt, 'PLAY MINECRAFT');
	assert.equal(config.agent.arena.mode, 'primary');
	assert.deepEqual(config.mcp.minecraft.headers, { Authorization: `Bearer ${TOKEN}` });
	assert.equal(config.mcp.minecraft.type, 'remote');
	assert.equal(config.mcp.minecraft.oauth, false);
	assert.ok(config.mcp.minecraft.timeout >= 600_000, 'long tools such as runProgram keep their request open');
	assert.ok(config.experimental.mcp_timeout >= 600_000);
	assert.equal(config.experimental.continue_loop_on_deny, true);
	// The free tier rejects requests whose built-in tools were removed, so none is disabled through `tools`.
	assert.equal(config.tools, undefined);
	for (const tool of ['edit', 'bash', 'webfetch', 'websearch', 'task', 'skill', 'glob', 'grep', 'list', 'question', 'external_directory']) {
		assert.equal(config.permission[tool], 'deny', `${tool} is blocked`);
	}
	// `read` must stay listed: every real path is denied, one path that never exists is allowed.
	assert.deepEqual(Object.entries(config.permission.read), [['*', 'deny'], ['/nonexistent-arena-opencode-path', 'allow']]);
	assert.deepEqual(config.permission, JSON.parse(JSON.stringify(OPENCODE_PERMISSION)));
	assert.equal(buildOpenCodeConfig({ prompt: 'x' }).mcp, undefined, 'goal translation runs without tools');
	assert.throws(() => buildOpenCodeConfig({ prompt: ' ' }), TypeError);
});

test('launch isolates OpenCode from the operator setup and never forwards unrelated credentials', () => {
	const environment = {
		PATH: '/usr/bin', HOME: '/home/u', XDG_DATA_HOME: '/home/u/.local/share',
		ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-openai-secret', ARENA_AGENT_BRIDGE_SECRET: 'bridge-secret',
	};
	const launch = buildOpenCodeLaunch({ executable: 'opencode', environment, bridgeSecretEnvironmentVariable: 'ARENA_AGENT_BRIDGE_SECRET' }, { directory: '/tmp/arena-opencode-x', configFile: '/tmp/arena-opencode-x/opencode.json', password: 'pw' });
	assert.deepEqual(launch.args, ['serve', '--pure', '--port', '0', '--hostname', '127.0.0.1']);
	// The idle-server reaper matches "opencode serve --hostname=127.0.0.1"; a live agent server must never match it.
	assert.ok(!`opencode ${launch.args.join(' ')}`.includes('serve --hostname='));
	const env = launch.options.env;
	assert.equal(env.OPENCODE_CONFIG, '/tmp/arena-opencode-x/opencode.json');
	assert.equal(env.XDG_CONFIG_HOME, path.join('/tmp/arena-opencode-x', 'config-home'), 'no global config, AGENTS.md or plugins');
	assert.equal(env.XDG_DATA_HOME, '/home/u/.local/share', 'the saved OpenCode login stays reachable');
	assert.equal(env.OPENCODE_DB, path.join('/tmp/arena-opencode-x', 'opencode.db'));
	assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, '1');
	assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
	assert.equal(env.OPENCODE_SERVER_PASSWORD, 'pw');
	for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ARENA_AGENT_BRIDGE_SECRET']) assert.equal(env[name], undefined, `${name} is not forwarded`);
	assert.ok(!launch.args.some((arg) => arg.includes('pw')), 'the server password is never an argument');
	assert.equal(launch.options.cwd, '/tmp/arena-opencode-x');
});

test('provider errors map to recovery codes; only limits and server faults are retried', () => {
	const api = (data) => ({ name: 'APIError', data: { isRetryable: false, ...data } });
	const cases = [
		[api({ message: 'Too Many Requests', statusCode: 429 }), 'RATE_LIMITED', true],
		[api({ message: 'FreeTierError: daily limit reached' }), 'RATE_LIMITED', true],
		[api({ message: 'Model is overloaded, try again later', statusCode: 400 }), 'RATE_LIMITED', true],
		[{ name: 'UnknownError', data: { message: 'rate limit exceeded for free tier' } }, 'RATE_LIMITED', true],
		[api({ message: 'Bad gateway', statusCode: 502 }), 'PROVIDER_UNAVAILABLE', true],
		[{ name: 'UnknownError', data: { message: 'Upstream request failed: Endpoint is unavailable.' } }, 'PROVIDER_UNAVAILABLE', true],
		[api({ message: "OpenCode's free tier can only be used from within OpenCode. Download it", statusCode: 403 }), 'MODEL_UNAVAILABLE', false],
		[api({ message: 'Unauthorized', statusCode: 401 }), 'AUTHENTICATION_REQUIRED', false],
		[{ name: 'ProviderAuthError', data: { providerID: 'opencode', message: 'no key' } }, 'AUTHENTICATION_REQUIRED', false],
		[{ name: 'MessageAbortedError', data: { message: 'aborted' } }, 'TURN_INTERRUPTED', false],
		[{ name: 'ContextOverflowError', data: { message: 'too long' } }, 'CONTEXT_OVERFLOW', false],
		[api({ message: 'something odd', statusCode: 400 }), 'TURN_FAILED', false],
	];
	for (const [error, code, retryable] of cases) {
		const mapped = classifyOpenCodeError(error);
		assert.equal(mapped.code, code, JSON.stringify(error));
		assert.equal(mapped.retryable, retryable, JSON.stringify(error));
	}
	assert.equal(classifyOpenCodeError(api({ message: 'slow down', statusCode: 429, responseHeaders: { 'Retry-After': '42' } })).retryAfterMs, 42_000);
});

test('retry waits grow, cap, and honour retry-after', () => {
	assert.equal(retryDelayMs(0), RATE_LIMIT_RETRY.baseMs);
	assert.equal(retryDelayMs(1), RATE_LIMIT_RETRY.baseMs * 2);
	assert.equal(retryDelayMs(10), RATE_LIMIT_RETRY.maxMs);
	assert.equal(retryDelayMs(0, 90_000), 90_000);
	assert.equal(retryDelayMs(0, 10 * 60_000), RATE_LIMIT_RETRY.maxMs * 5);
});

test('free OpenCode models cost nothing in every ledger', async () => {
	const tokens = { input: 120_000, cacheRead: 900_000, cacheWrite: 5_000, output: 40_000 };
	for (const model of [DEEPSEEK, GLM]) assert.equal(estimateTokenCostUsd(tokens, { provider: 'opencode', model, serviceTier: 'priority' }), 0);
	const { estimateTokenCostUsd: evalCost } = await import('../src/decision-eval/pricing.mjs');
	assert.equal(evalCost(tokens, { provider: 'opencode', model: DEEPSEEK }), 0);
});

test('secrets never survive redaction', () => {
	const text = `Authorization: Bearer ${TOKEN} password=${'f'.repeat(48)}`;
	const redacted = redactSecrets(text);
	assert.ok(!redacted.includes(TOKEN));
	assert.ok(!redacted.includes('f'.repeat(48)));
});

test('catalog offers the two free models at low, high and max on the priority label only', async () => {
	const service = new OpenCodeProviderService({}, { toolServer: { stop: async () => {} } });
	const snapshot = await service.catalog.refresh();
	assert.equal(snapshot.provider, 'opencode');
	assert.deepEqual(snapshot.models.map((model) => model.model), [DEEPSEEK, GLM]);
	for (const model of snapshot.models) assert.deepEqual(model.reasoningEfforts, ['low', 'high', 'max']);
	assert.throws(() => service.catalog.assertSupported(DEEPSEEK, 'medium'), (error) => error.code === 'UNSUPPORTED_THINKING');
	assert.throws(() => service.catalog.assertSupported(DEEPSEEK, 'low', 'fast'), (error) => error.code === 'UNSUPPORTED_SERVICE_TIER');
	await assert.rejects(service.createAgent({ agentId: 'a', provider: 'claude', model: DEEPSEEK, reasoningEffort: 'low' }), (error) => error.code === 'PROVIDER_MISMATCH');
	await service.stop();
});

/** A scripted stand-in for `opencode serve`: HTTP routes, the event stream and the MCP route. */
function fakeOpenCode({ replies }) {
	const state = { route: null, emit: null, requests: [], written: [], children: [], toolResults: [], terminated: 0, aborted: 0, sessions: 0 };
	const toolServer = {
		register: async ({ callTool }) => { state.route = { callTool }; return { url: 'http://127.0.0.1:1/mcp', token: TOKEN, unregister: () => { state.route = null; } }; },
		stop: async () => {},
	};
	const spawn = (command, args, options) => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.stdin = null;
		state.children.push({ command, args, options });
		setImmediate(() => child.stdout.write('opencode server listening on http://127.0.0.1:4096\n'));
		return child;
	};
	let message = 0;
	const request = async (server, method, pathname, body) => {
		state.requests.push({ method, pathname, body });
		if (method === 'GET' && pathname === '/mcp') return { minecraft: { status: 'connected' } };
		if (method === 'POST' && pathname === '/session') return { id: `ses_${++state.sessions}` };
		if (method === 'POST' && pathname.endsWith('/abort')) { state.aborted += 1; return true; }
		if (method === 'DELETE') return true;
		if (method === 'POST' && pathname.endsWith('/message')) {
			const reply = replies.shift();
			const sessionID = pathname.split('/')[2];
			const id = `msg_${++message}`;
			const info = { id, sessionID, providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' };
			if (reply.error) return { info: { ...info, error: reply.error } };
			if (reply.hold) await reply.hold;
			for (const [index, step] of (reply.steps ?? [reply]).entries()) {
				const stepId = `${id}_${index}`;
				const part = (value) => state.emit({ type: 'message.part.updated', properties: { sessionID, part: { sessionID, messageID: stepId, ...value } } });
				part({ id: `${stepId}a`, type: 'step-start' });
				state.emit({ type: 'message.part.delta', properties: { sessionID, messageID: stepId, partID: `${stepId}b`, field: 'text', delta: 'x' } });
				if (step.tool) {
					part({ id: `${stepId}c`, type: 'tool', callID: `call_${message}_${index}`, tool: `minecraft_${step.tool}`, state: { status: 'running', input: {}, time: { start: 1 } } });
					const result = await state.route.callTool(step.tool, step.args ?? {});
					state.toolResults.push(result);
					if (result.isError) return { info: { ...info, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } };
				}
				part({ id: `${stepId}d`, type: 'text', text: step.text ?? 'ok', time: { start: 1, end: 2 } });
				part({ id: `${stepId}e`, type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: step.cacheRead ?? 9_000, write: 0 } } });
			}
			setImmediate(() => state.emit({ type: 'session.idle', properties: { sessionID } }));
			return { info: { ...info, tokens: { input: 100, output: 20 } }, parts: [] };
		}
		throw new Error(`unexpected ${method} ${pathname}`);
	};
	const openEvents = (server, onEvent) => { state.emit = onEvent; return { close() {} }; };
	return { state, toolServer, spawn, request, openEvents };
}

async function serviceWith(replies, root, config = {}) {
	const fake = fakeOpenCode({ replies });
	// Retry backoffs (seconds) run at once; the 120 s silence deadline keeps its real length.
	const schedule = (fn, ms) => setTimeout(fn, ms >= 100_000 ? ms : Math.min(ms, 5));
	const service = new OpenCodeProviderService({ runtimeRoot: root, environment: { PATH: '/usr/bin', OPENCODE_API_KEY: 'oc-secret-key-value' }, ...config }, {
		toolServer: fake.toolServer, spawn: fake.spawn, request: fake.request, openEvents: fake.openEvents,
		terminate: async () => { fake.state.terminated += 1; }, schedule, cancelSchedule: clearTimeout,
		fs: { writeFile: async (file, content, options) => { fake.state.written.push({ file, content, mode: options?.mode }); return writeFile(file, content, options); } },
	});
	return { service, fake };
}

test('a turn rides out a free-tier limit, traces the retry and reports usage at $0', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-service-test-'));
	try {
		const { service, fake } = await serviceWith([
			{ error: { name: 'APIError', data: { message: 'Too Many Requests', statusCode: 429, isRetryable: false } } },
			{ tool: 'observe', args: { view: 'full' } },
		], root);
		const agent = await service.createAgent({ agentId: 'agent-1', provider: 'opencode', model: DEEPSEEK, reasoningEffort: 'low' });
		await agent.setGoalRevision(1);
		const verbose = [];
		const executed = [];
		const result = await agent.act('Wake event.\n{"trigger":"spawn"}', {
			goalRevision: 1, captureCalls: true,
			onVerbose: (stage, message) => verbose.push([stage, message]),
			executeTool: async (request) => { executed.push(request); return { state: 'COMPLETED', observation: { health: 20 } }; },
		});
		assert.equal(result.status, 'completed');
		assert.equal(result.toolCalls, 1);
		assert.equal(result.providerRetries, 1);
		assert.equal(result.usage.costUsd, 0);
		assert.equal(result.usage.calls, 1);
		assert.equal(result.usage.output, 25, 'reasoning counts as output');
		assert.equal(executed[0].callId, 'call_2_0', 'the MCP call is matched to OpenCode call id');
		const events = verbose.filter(([stage]) => stage === 'provider_event').map(([, message]) => JSON.parse(message));
		const retry = events.find((event) => event.event === 'native_provider_retry');
		assert.equal(retry.reason, 'RATE_LIMITED');
		assert.equal(retry.statusCode, 429);
		assert.equal(retry.retriedBy, 'coordinator');
		assert.ok(retry.waitMs >= RATE_LIMIT_RETRY.baseMs);
		const usage = verbose.filter(([stage]) => stage === 'live_usage').map(([, message]) => JSON.parse(message));
		assert.equal(usage.length, 1);
		assert.equal(usage[0].call.provider, 'opencode');
		assert.equal(usage[0].call.contextTokens, 9_100);
		assert.deepEqual(usage[0].call.toolNames, ['minecraft_observe']);
		const prompts = fake.state.requests.filter((entry) => entry.pathname.endsWith('/message')).map((entry) => entry.body);
		assert.equal(prompts.length, 2);
		assert.deepEqual(prompts[0].model, { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' });
		assert.equal(prompts[0].agent, 'arena');
		assert.equal(prompts[0].variant, 'low');
		assert.match(prompts[1].parts[0].text, /Continue the current turn/);
		assert.equal(verbose.filter(([stage]) => stage === 'agent_message').length, 1);

		// The config file lives in a private directory, is owner-only, and holds the MCP route but no provider key.
		const written = fake.state.written.find((entry) => entry.file.endsWith('opencode.json'));
		assert.equal(written.mode, 0o600);
		assert.ok(written.content.includes(TOKEN));
		assert.ok(!written.content.includes('oc-secret-key-value'));
		// Windows stat reports DOS permissions; the requested owner-only mode is asserted above.
		if (process.platform !== 'win32') {
			assert.equal((await stat(path.dirname(written.file))).mode & 0o777, 0o700);
			assert.equal((await stat(written.file)).mode & 0o777, 0o600);
		}
		const launch = fake.state.children[0];
		assert.ok(!JSON.stringify(launch.args).includes(TOKEN));
		assert.ok(!JSON.stringify(verbose).includes(TOKEN), 'the bearer token never reaches verbose output or traces');
		await service.stop();
		assert.equal(fake.state.terminated, 1);
		assert.deepEqual(await readdir(root), [], 'the private config directory is removed on stop');
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a permanent free-tier refusal fails the turn without retrying', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-service-test-'));
	try {
		const { service, fake } = await serviceWith([
			{ error: { name: 'APIError', data: { message: "OpenCode's free tier can only be used from within OpenCode.", statusCode: 403, isRetryable: false } } },
		], root);
		const agent = await service.createAgent({ agentId: 'agent-2', provider: 'opencode', model: DEEPSEEK, reasoningEffort: 'low' });
		await agent.setGoalRevision(1);
		await assert.rejects(agent.act('Wake.\n{}', { goalRevision: 1, executeTool: async () => ({}) }), (error) => error.code === 'MODEL_UNAVAILABLE');
		assert.equal(fake.state.requests.filter((entry) => entry.pathname.endsWith('/message')).length, 1);
		await service.stop();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('goal translation runs on the same free model without Minecraft tools', async () => {
	const { goalSpecTranslatorProfile } = await import('../src/agent-planner.mjs');
	const record = { agentId: 'a', provider: 'opencode', model: GLM, reasoningEffort: 'low', serviceTier: 'priority', goalRevision: 1 };
	const translator = goalSpecTranslatorProfile(record, 'goal-spec-1');
	assert.equal(translator.provider, 'opencode');
	assert.equal(translator.model, GLM);
	assert.equal(translator.agentId, 'goal-spec-1');
});

test('a long turn moves to a fresh session at a tool boundary once its context passes the threshold', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-service-test-'));
	try {
		const { service, fake } = await serviceWith([
			{ steps: [{ tool: 'observe', cacheRead: 70_000 }, { tool: 'observe' }] },
			{ steps: [{ tool: 'observe', cacheRead: 2_000 }, { text: 'done' }] },
		], root, { contextRotationTokens: 64_000 });
		const agent = await service.createAgent({ agentId: 'agent-3', provider: 'opencode', model: DEEPSEEK, reasoningEffort: 'low' });
		await agent.setGoalRevision(1);
		const verbose = [];
		const result = await agent.act('Wake event.\n{"trigger":"spawn"}', {
			goalRevision: 1, onVerbose: (stage, message) => verbose.push([stage, message]),
			executeTool: async () => ({ state: 'COMPLETED', observation: { health: 20 } }),
		});
		assert.equal(result.status, 'completed');
		assert.equal(result.toolCalls, 3, 'the boundary tool ran once and the turn continued');
		const prompts = fake.state.requests.filter((entry) => entry.pathname.endsWith('/message'));
		assert.deepEqual(prompts.map((entry) => entry.pathname.split('/')[2]), ['ses_1', 'ses_2']);
		const handoff = prompts[1].body.parts[0].text;
		assert.match(handoff, /^Mid-turn continuation/);
		assert.match(handoff, /Current turn input to continue:/);
		assert.match(handoff, /Tool result for Minecraft tool "observe"/);
		assert.equal(fake.state.toolResults[1].isError, true, 'the retired session is told the result moved on');
		assert.ok(fake.state.requests.some((entry) => entry.pathname === '/session/ses_1/abort'));
		const rotated = verbose.filter(([stage]) => stage === 'provider_event').map(([, message]) => JSON.parse(message)).find((event) => event.event === 'native_provider_session_rotated');
		assert.equal(rotated.midTurn, true);
		assert.equal(rotated.contextTokens, 70_100);
		await service.stop();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupting a turn never stops the server under the next turn', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-service-test-'));
	try {
		let release;
		const hold = new Promise((resolve) => { release = resolve; });
		const { service, fake } = await serviceWith([{ hold, text: 'old' }, { text: 'new' }], root, { interruptTimeoutMs: 200_000 });
		const agent = await service.createAgent({ agentId: 'agent-4', provider: 'opencode', model: DEEPSEEK, reasoningEffort: 'low' });
		await agent.setGoalRevision(1);
		const first = agent.act('Wake.\n{}', { goalRevision: 1, executeTool: async () => ({}) }).catch((error) => error.code);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const interrupting = agent.interrupt();
		assert.equal(await first, 'STALE_PLAN');
		// The next turn starts while the interrupted prompt is still open; it waits for that prompt, not the reverse.
		const secondTurn = agent.act('Wake.\n{}', { goalRevision: 1, executeTool: async () => ({}) });
		setTimeout(release, 10);
		const second = await secondTurn;
		const report = await interrupting;
		assert.equal(report.interruptTimedOut, false);
		assert.equal(second.status, 'completed');
		assert.equal(fake.state.terminated, 0, 'the server serving the next turn kept running');
		await service.stop();
	} finally { await rm(root, { recursive: true, force: true }); }
});
