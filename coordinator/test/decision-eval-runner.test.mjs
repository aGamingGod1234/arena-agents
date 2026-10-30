import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { estimateCallCostUsd } from '../src/claude-service.mjs';
import { callMatches } from '../src/decision-eval/match.mjs';
import { renderPrefix, renderWake, sha256 } from '../src/decision-eval/render.mjs';
import { buildFingerprint, createClaudeAdapter, runPool, runSample } from '../src/decision-eval/runner.mjs';
import { validateSampleResult } from '../src/decision-eval/schema.mjs';

const replay = JSON.parse(await readFile(new URL('./fixtures/decision-eval/g1-replay-sample.json', import.meta.url), 'utf8'));
const baseCase = (extra = {}) => ({
	id: 'runner-case', family: 'runner', causeClass: 'runner', split: 'train',
	state: { observation: replay.observations[0], agent: { goal: replay.goal, goalSpec: replay.goalSpec } },
	expect: { good: [{ tool: 'moveTo' }] },
	...extra,
});
const rendered = await renderWake(baseCase());

/** Claude Code stand-in: real MCP calls to the production tool server, scripted per user message. */
class FakeClaudeCode extends EventEmitter {
	constructor(args, script) {
		super();
		this.args = args;
		this.pid = 7_000;
		this.exitCode = null;
		this.signalCode = null;
		this.stdout = new EventEmitter();
		this.stdout.setEncoding = () => {};
		this.stderr = new EventEmitter();
		this.stdin = new EventEmitter();
		this.stdin.destroyed = false;
		this.stdin.write = (text) => { for (const line of String(text).split('\n').filter(Boolean)) this.#onLine(JSON.parse(line)); return true; };
		this.stdin.end = () => {};
		this.script = script;
		this.mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.minecraft;
		this.systemPromptFile = args[args.indexOf('--system-prompt-file') + 1];
		queueMicrotask(() => { this.connected = this.#connect(); });
	}
	async rpc(method, params = {}) {
		const response = await fetch(this.mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...this.mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: Math.random(), method, params }) });
		return response.json();
	}
	async call(name, args, id) {
		this.line({ type: 'assistant', message: { id: `msg_${id}`, usage: { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 500, output_tokens: 60 }, content: [{ type: 'tool_use', id, name: `mcp__minecraft__${name}`, input: args }] } });
		const response = await this.rpc('tools/call', { name, arguments: args, _meta: { 'claudecode/toolUseId': id } });
		return response.result.content[0].text;
	}
	line(value) { this.stdout.emit('data', `${JSON.stringify(value)}\n`); }
	exit(code = 0) { this.exitCode = code; this.emit('close', code, null); }
	async #connect() {
		await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code' } });
		this.tools = (await this.rpc('tools/list')).result.tools;
		this.line({ type: 'system', subtype: 'init', session_id: 'session-1', model: this.args[this.args.indexOf('--model') + 1] });
	}
	#onLine(message) {
		if (message.type === 'user') void Promise.resolve(this.connected).then(() => this.script(this, message.message.content)).catch(() => {});
		if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
			this.interrupted = true;
			this.line({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
			this.line({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'session-1' });
		}
	}
}

async function withAdapter(script, fn) {
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-runner-'));
	const children = [];
	const adapter = createClaudeAdapter({
		root, interruptTimeoutMs: 1_000, planningTimeoutMs: 5_000, environment: { PATH: 'test' },
		spawn: (command, args) => { const child = new FakeClaudeCode(args, script); children.push(child); return child; },
		terminate: async (child) => { if (child.exitCode === null) child.exit(0); },
	});
	await adapter.start();
	try { return await fn(adapter, children); } finally { await adapter.stop(); await rm(root, { recursive: true, force: true }); }
}

test('one call is captured with raw and normalized arguments, never executed, and the sent bytes equal the render', async () => {
	let received = null;
	await withAdapter(async (child, content) => {
		received = content;
		child.toolResult = await child.call('moveTo', { x: 3, y: 64, z: -2 }, 'toolu_1');
	}, async (adapter, children) => {
		const result = await runSample(adapter, { testCase: baseCase(), rendered, sample: 0, sampleId: 'runner-a' });
		validateSampleResult(result);
		assert.equal(result.stop, 'script_end');
		assert.equal(result.error, null);
		assert.equal(result.calls.length, 1);
		assert.deepEqual(result.calls[0].args, { x: 3, y: 64, z: -2 });
		assert.equal(result.calls[0].normalized.kind, 'action');
		assert.equal(result.calls[0].normalized.actionType, 'navigate_to');
		assert.equal(children[0].interrupted, true, 'the runner interrupts the turn instead of letting it continue');
		assert.match(children[0].toolResult, /DECISION_EVAL_STOPPED|TURN_NOT_ACTIVE/);
		assert.equal(result.rendered.sentMatches, true);
		assert.equal(sha256(received.replace(/observation-[0-9a-f-]{36}-/g, 'observation-session-')), rendered.encodedSha256);
		const prefix = await renderPrefix({ provider: 'claude' });
		assert.equal(result.rendered.sentInstructionsSha256, sha256(prefix.instructions.systemPrompt), 'the launched system prompt is the rendered prefix');
		assert.deepEqual(children[0].tools, prefix.tools, 'the tools Claude Code listed are the rendered prefix');
		assert.equal(result.usage.modelCalls, 1);
		assert.equal(result.usage.cachedInputTokens, 40_000);
		assert.equal(result.usage.costUsd, Math.round(estimateCallCostUsd({ input: 10, cacheRead: 40_000, cacheWrite: 500, output: 60 }) * 1e6) / 1e6);
		assert.equal(result.usage.costSource, 'estimate');
	});
});

test('the eval view session makes samples byte-identical; without it the production service sends its random id', async () => {
	const sent = async (options) => {
		const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-view-'));
		const received = [];
		const adapter = createClaudeAdapter({
			root, interruptTimeoutMs: 1_000, planningTimeoutMs: 5_000, environment: { PATH: 'test' }, ...options,
			spawn: (command, args) => new FakeClaudeCode(args, async (child, content) => { received.push(content); await child.call('moveTo', { x: 3, y: 64, z: -2 }, 'toolu_v'); }),
			terminate: async (child) => { if (child.exitCode === null) child.exit(0); },
		});
		await adapter.start();
		try {
			for (const sample of [0, 1]) {
				const result = await runSample(adapter, { testCase: baseCase(), rendered, sample, sampleId: `view-${sample}` });
				assert.equal(result.rendered.sentMatches, true);
			}
		} finally { await adapter.stop(); await rm(root, { recursive: true, force: true }); }
		return received;
	};
	const evalBytes = await sent({});
	assert.equal(evalBytes[0], evalBytes[1], 'repeated samples send identical wake bytes, so the second reads the prompt cache');
	assert.match(evalBytes[0], /observation-00000000-0000-4000-8000-000000000000-1/);
	const production = await sent({ viewSession: null });
	const ids = production.map((text) => text.match(/observation-([0-9a-f-]{36})-1/)[1]);
	assert.notEqual(ids[0], ids[1], 'without the option each production session names its views randomly, as before');
	assert.equal(production[0].replaceAll(ids[0], '00000000-0000-4000-8000-000000000000'), evalBytes[0], 'the option changes nothing but the id');
});

test('for a build without the option the adapter shows the model the eval id and maps it back in tool arguments', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-translate-'));
	const received = [];
	const adapter = createClaudeAdapter({
		root, interruptTimeoutMs: 1_000, planningTimeoutMs: 5_000, environment: { PATH: 'test' }, viewIdMode: 'translated',
		spawn: (command, args) => new FakeClaudeCode(args, async (child, content) => {
			received.push(content);
			const id = content.match(/observation-[0-9a-f-]{36}-1/)[0];
			child.observed = await child.call('observe', { view: 'changes', afterObservationId: id }, 'toolu_t');
		}),
		terminate: async (child) => { if (child.exitCode === null) child.exit(0); },
	});
	await adapter.start();
	try {
		assert.equal(adapter.viewIdMode, 'translated');
		const result = await runSample(adapter, { testCase: baseCase(), rendered, sample: 0, sampleId: 'translate-0' });
		assert.equal(result.viewIdMode, 'translated');
		assert.match(received[0], /observation-00000000-0000-4000-8000-000000000000-1/, 'the model reads the eval id');
		assert.equal(result.rendered.sentMatches, true);
		assert.equal(result.calls[0].args.afterObservationId, 'observation-00000000-0000-4000-8000-000000000000-1', 'raw arguments are what the model sent');
		assert.match(result.calls[0].normalized.afterObservationId, /^observation-[0-9a-f-]{36}-1$/);
		assert.doesNotMatch(result.calls[0].normalized.afterObservationId, /00000000-0000-4000-8000-000000000000/, 'production receives its own session id');
	} finally { await adapter.stop(); await rm(root, { recursive: true, force: true }); }
});

test('a canned step returns the recorded result through the production presenter and the next call is captured', async () => {
	const testCase = baseCase({ steps: [{ canned: [
		{ when: { tool: 'control' }, result: { state: 'FAILED', reasonCode: 'WRONG_BRANCH' } },
		{ when: { tool: 'moveTo', args: { x: { gte: 0 } } }, result: { state: 'FAILED', reasonCode: 'PATH_BLOCKED', message: 'A wall blocks the route.' } },
	] }] });
	const seen = [];
	await withAdapter(async (child) => {
		seen.push(await child.call('moveTo', { x: 3, y: 64, z: -2 }, 'toolu_1'));
		seen.push(await child.call('mine', { x: 3, y: 64, z: -1, expectedBlockId: 'minecraft:stone' }, 'toolu_2'));
	}, async (adapter) => {
		const result = await runSample(adapter, { testCase, rendered, sample: 1, sampleId: 'runner-b' });
		assert.equal(result.stop, 'script_end');
		assert.deepEqual(result.calls.map((call) => [call.name, call.canned]), [['moveTo', { step: 0, choice: 1 }], ['mine', null]]);
		assert.match(seen[0], /PATH_BLOCKED/);
		assert.match(seen[0], /A wall blocks the route/);
	});
});

test('an off-script call stops the sample and a rejected call does not advance the script', async () => {
	const testCase = baseCase({ steps: [{ canned: [{ when: { tool: 'control' }, result: { state: 'SUCCEEDED' } }] }] });
	let rejection = null;
	await withAdapter(async (child) => {
		rejection = await child.call('moveTo', { x: 'far' }, 'toolu_1');
		await child.call('moveTo', { x: 1, y: 64, z: 1 }, 'toolu_2');
	}, async (adapter) => {
		const result = await runSample(adapter, { testCase, rendered, sample: 2, sampleId: 'runner-c' });
		assert.equal(result.stop, 'off_script');
		assert.equal(result.calls.length, 2);
		assert.equal(result.calls[0].normalized, null);
		assert.ok(result.calls[0].normalizeError.length > 0);
		assert.match(rejection, /x|number|invalid/i);
		assert.equal(result.calls[1].normalized.actionType, 'navigate_to');
		assert.equal(result.calls[1].canned, null);
	});
});

test('a turn that ends without tool calls is recorded as turn_end', async () => {
	await withAdapter(async (child) => {
		child.line({ type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 3 }, content: [{ type: 'text', text: 'Thinking it over.' }] } });
		child.line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1', total_cost_usd: 0.0123, usage: { output_tokens: 3 } });
	}, async (adapter) => {
		const result = await runSample(adapter, { testCase: baseCase(), rendered, sample: 0, sampleId: 'runner-d' });
		assert.equal(result.stop, 'turn_end');
		assert.deepEqual(result.calls, []);
		assert.equal(result.text, 'Thinking it over.');
		assert.equal(result.usage.costSource, 'provider');
		assert.equal(result.usage.costUsd, 0.0123);
	});
});

test('the pool caps concurrency, shares rate-limit backoff and retries', async () => {
	let clock = 0;
	const sleeps = [];
	const attempts = new Map();
	let running = 0;
	let peak = 0;
	const pool = await runPool([0, 1, 2, 3, 4, 5], {
		concurrency: 3, baseBackoffMs: 1_000,
		now: () => clock,
		sleep: async (ms) => { sleeps.push(ms); clock += ms; },
		attempt: async (task) => {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setImmediate(resolve));
			clock += 100;
			running -= 1;
			const tries = (attempts.get(task) ?? 0) + 1;
			attempts.set(task, tries);
			if (task === 2 && tries === 1) return { error: { code: 'RATE_LIMITED', rateLimited: true }, latency: {} };
			if (task === 4 && tries === 1) return { error: { code: 'PROVIDER_START_TIMEOUT', rateLimited: false }, latency: {} };
			if (task === 5) return { error: { code: 'MODEL_UNAVAILABLE', rateLimited: false }, latency: {} };
			return { error: null, latency: {} };
		},
	});
	assert.equal(peak, 3);
	assert.equal(pool.maxConcurrency, 3);
	assert.equal(pool.rateLimitEvents.length, 1);
	assert.ok(sleeps.length >= 1 && sleeps[0] >= 750 && sleeps[0] <= 1_250);
	assert.deepEqual([...attempts.entries()].sort(), [[0, 1], [1, 1], [2, 2], [3, 1], [4, 2], [5, 1]]);
	assert.equal(pool.results[2].error, null);
	assert.equal(pool.results[2].latency.attempts, 2);
	assert.equal(pool.results[5].error.code, 'MODEL_UNAVAILABLE');
});

test('when predicates match tool names, argument and normalized paths', () => {
	const call = { name: 'moveTo', args: { x: 3, target: { type: 'minecraft:zombie' } }, normalized: { kind: 'action', actionType: 'navigate_to' } };
	assert.equal(callMatches({ tool: ['control', 'moveTo'], args: { x: { gte: 2, lt: 4 }, 'target.type': { regex: 'zombie$' } } }, call), true);
	assert.equal(callMatches({ normalized: { actionType: { in: ['flee_from'] } } }, call), false);
	assert.equal(callMatches({ not: { tool: 'mine' }, all: [{ args: { y: { exists: false } } }] }, call), true);
	const context = { position: { x: 0, y: 64, z: 0 }, entities: [], entityById: new Map(), items: [], selectedItem: null };
	assert.equal(callMatches({ tool: 'moveTo', awayFrom: { position: 'player', minDistance: 2 } }, { name: 'moveTo', args: { x: 3, y: 64, z: 0 } }, context), true, 'helpers read the case observation');
	assert.equal(callMatches({ action: 'navigate_to' }, call), true, 'extension keys are evaluated, never ignored');
	assert.equal(callMatches({ action: 'flee_from' }, call), false);
	assert.equal(callMatches({ none: true }, call), false);
});

test('codex samples capture raw arguments from the app-server tool request and stop by interrupt', async () => {
	const { FakeSharedTransport } = await import('./fixtures/codex-service-fixture.mjs');
	const { createCodexAdapter } = await import('../src/decision-eval/runner.mjs');
	const transport = new FakeSharedTransport();
	transport.autoComplete = false;
	let input = null;
	const request = transport.request.bind(transport);
	transport.request = async (method, params, options) => {
		const response = await request(method, params, options);
		if (method === 'turn/start') {
			input = params.input[0].text;
			queueMicrotask(() => transport.emit('serverRequest', { id: 1, method: 'item/tool/call', params: { threadId: params.threadId, turnId: response.turn.id, callId: 'call-1', tool: 'moveTo', arguments: { x: 5, y: 64, z: 5 } } }));
		}
		return response;
	};
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-codex-'));
	const adapter = createCodexAdapter({ model: 'gpt-5.6-sol', effort: 'high', root, transport, minecraftWorkspace: { prepare: async () => ({ cwd: root, selectedCapabilityRoots: [], instructions: 'agents', skillInstructions: 'skill' }) } });
	await adapter.start();
	try {
		const result = await runSample(adapter, { testCase: baseCase(), rendered, sample: 0, sampleId: 'codex-a' });
		assert.equal(result.stop, 'script_end');
		assert.deepEqual(result.calls.map((call) => [call.name, call.args, call.normalized.actionType]), [['moveTo', { x: 5, y: 64, z: 5 }, 'navigate_to']]);
		assert.equal(sha256(input.replace(/observation-[0-9a-f-]{36}-/g, 'observation-session-')), rendered.encodedSha256, 'codex receives the rendered wake');
		assert.ok(transport.calls.some((call) => call.method === 'turn/interrupt'));
		const threadStart = transport.calls.find((call) => call.method === 'thread/start').params;
		assert.equal(threadStart.dynamicTools.length > 20, true);
	} finally { await adapter.stop(); await rm(root, { recursive: true, force: true }); }
});

test('the build fingerprint ignores the decision-eval harness, which is hashed on its own and overlaid on older builds', async () => {
	const { execFile } = await import('node:child_process');
	const { mkdir, writeFile } = await import('node:fs/promises');
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-fingerprint-'));
	const git = (...args) => new Promise((resolve, reject) => execFile('git', args, { cwd: root }, (error, stdout) => error ? reject(error) : resolve(stdout)));
	try {
		await git('init', '-q');
		await mkdir(path.join(root, 'coordinator', 'src', 'decision-eval'), { recursive: true });
		await writeFile(path.join(root, 'coordinator', 'src', 'decision-eval', 'runner.mjs'), 'harness\n');
		await writeFile(path.join(root, 'game.mjs'), 'build\n');
		await git('add', '.');
		await git('-c', 'user.email=eval@example.invalid', '-c', 'user.name=eval', 'commit', '-qm', 'base');
		const clean = await buildFingerprint(root, { prefixSha256: 'p' });
		assert.equal(clean.dirty, false);
		await writeFile(path.join(root, 'coordinator', 'src', 'decision-eval', 'runner.mjs'), 'overlaid harness\r\n');
		const overlaid = await buildFingerprint(root, { prefixSha256: 'p' });
		assert.equal(overlaid.dirty, false, 'an overlaid harness leaves the build clean');
		assert.equal(overlaid.fingerprint, clean.fingerprint);
		await writeFile(path.join(root, 'game.mjs'), 'changed build\n');
		assert.equal((await buildFingerprint(root, { prefixSha256: 'p' })).dirty, true, 'a production change makes it dirty');
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a canned reply fires only for the recorded command itself, never for a materially different call', async () => {
	const { cannedChoice, commandMatches } = await import('../src/decision-eval/match.mjs');
	const { buildContext } = await import('../src/decision-eval/predicates.mjs');
	const { normalizeMinecraftToolCall } = await import('../src/native-minecraft-tools.mjs');
	const load = async (family, id) => JSON.parse(await readFile(new URL(`./fixtures/decision-eval/train/${family}.json`, import.meta.url), 'utf8')).cases.find((c) => c.id === id);
	const call = (tool, args) => ({ name: tool, args, normalized: normalizeMinecraftToolCall(tool, args) });
	const retry = await load('failed-interaction-retry', 'failed-interaction-retry-01');
	const recordedRetry = retry.steps[0].canned[0].recorded.command;
	const at = { x: recordedRetry.arguments.x, y: recordedRetry.arguments.y, z: recordedRetry.arguments.z };
	assert.equal(cannedChoice(retry.steps[0], call('act', { actionType: recordedRetry.actionType, arguments: recordedRetry.arguments }), buildContext(retry)), 0, 'the recorded command gets its reply');
	// Review r2: break_block at the recorded spot but expecting birch_log matched a reply recorded for oak_log.
	const birch = call('act', { actionType: 'break_block', arguments: { ...at, expectedBlockId: 'minecraft:birch_log', timeoutMs: 15000 } });
	assert.notEqual(recordedRetry.arguments.expectedBlockId, 'minecraft:birch_log');
	assert.equal(cannedChoice(retry.steps[0], birch, buildContext(retry)), -1, 'a different expected block is a different command');
	const contrast = await load('failure-reason-contrast', 'failure-reason-contrast-04');
	const recordedPlace = contrast.steps[0].canned[0].recorded.command;
	// Review r2: placing dirt face down matched the reply recorded for a crafting table face up.
	const dirt = call('act', { actionType: 'place_block', arguments: { x: recordedPlace.arguments.x, y: recordedPlace.arguments.y, z: recordedPlace.arguments.z, face: 'down', itemId: 'minecraft:dirt' } });
	assert.equal(cannedChoice(contrast.steps[0], dirt, buildContext(contrast)), -1);
	assert.equal(commandMatches(recordedPlace, { kind: 'action', actionType: 'place_block', arguments: { ...recordedPlace.arguments, timeoutMs: 9999 } }), true, 'only the time budget is non-semantic');
	// A sequence whose first action is the recorded command is not that command.
	const prefix = call('sequence', { actions: [{ actionType: recordedPlace.actionType, arguments: recordedPlace.arguments }, { actionType: 'wait', arguments: { durationMs: 500 } }] });
	assert.equal(commandMatches(recordedPlace, prefix.normalized), false);
});
