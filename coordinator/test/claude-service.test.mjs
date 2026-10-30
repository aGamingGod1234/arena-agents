import assert from 'node:assert/strict';
import { parseArenaScript } from '../src/arena-script/parser.mjs';
import { decodeModelFacts } from '../src/model-fact-encoding.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_REASONING_EFFORTS, ClaudeProviderService, buildClaudeLaunch } from '../src/claude-service.mjs';
import { ClaudeToolServer } from '../src/claude-tool-server.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, NATIVE_AGENT_INSTRUCTIONS } from '../src/native-minecraft-tools.mjs';
import { coordinatorWithProviderAgent, emitLavaObservation, returnLavaResult } from './fixtures/hazard-provider-fixture.mjs';

import { harness, profile, AGENTS_TEXT, SKILL_TEXT } from './fixtures/claude-service-fixture.mjs';

test('Claude catalog offers Opus 5.5, Sonnet 5.5, and Fable 5.1 at Low through High only', async () => {
	const { service, close } = await harness();
	try {
		const snapshot = await service.catalog.refresh();
		assert.deepEqual(snapshot.models.map(({ model, displayName }) => [model, displayName]), [
			['claude-opus-5-5', 'Claude Opus 5.5'],
			['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
			['claude-fable-5-1', 'Claude Fable 5.1'],
		]);
		for (const model of snapshot.models) {
			assert.deepEqual(model.reasoningEfforts, ['low', 'medium', 'high']);
			assert.deepEqual(model.serviceTiers, ['priority']);
		}
		assert.deepEqual(CLAUDE_REASONING_EFFORTS, ['low', 'medium', 'high']);
		assert.throws(() => service.catalog.assertSupported('claude-opus-5-5', 'xhigh'), (error) => error.code === 'UNSUPPORTED_THINKING');
		assert.throws(() => service.catalog.assertSupported('claude-opus-5-5', 'high', 'fast'), (error) => error.code === 'UNSUPPORTED_SERVICE_TIER');
		assert.throws(() => new ClaudeProviderService({ cwd: 'C:\\w', reasoningEfforts: ['high', 'max'] }), /must be one of low, medium, high/);
	} finally { await close(); }
});

test('Claude launches in the shared Minecraft workspace with the same instructions and only the Minecraft tools', async () => {
	const { service, children, root, close } = await harness();
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.prewarm();
		const [child] = children;
		assert.equal(child.command, 'claude');
		assert.equal(child.options.cwd, path.join(root, 'workspace'), 'same workspace directory as Codex');
		const flag = (name) => child.args[child.args.indexOf(name) + 1];
		assert.equal(flag('--model'), 'claude-sonnet-5-5');
		assert.equal(flag('--effort'), 'medium');
		assert.equal(flag('--setting-sources'), '');
		assert.equal(flag('--tools'), '');
		assert.equal(flag('--allowedTools'), 'mcp__minecraft');
		assert.equal(flag('--permission-mode'), 'dontAsk');
		for (const required of ['--strict-mcp-config', '--restricted', '--no-session-persistence', '--disable-slash-commands']) assert.ok(child.args.includes(required), required);
		assert.equal(child.options.env.ANTHROPIC_API_KEY, 'anthropic-key');
		assert.equal(child.options.env.OPENAI_API_KEY, undefined);
		assert.equal(child.options.env.ARENA_AGENT_BRIDGE_SECRET, undefined);

		const systemPrompt = await readFile(flag('--system-prompt-file'), 'utf8');
		assert.ok(systemPrompt.startsWith(NATIVE_AGENT_INSTRUCTIONS), 'same native base instructions as Codex');
		assert.ok(systemPrompt.includes(`Workspace instructions for this Minecraft body (authoritative):\n${AGENTS_TEXT}`));
		assert.ok(systemPrompt.includes(`Bundled minecraft-control skill (already loaded; no filesystem read needed):\n${SKILL_TEXT}`));
		assert.ok(systemPrompt.includes('mcp__minecraft__observe'));
		assert.deepEqual(child.tools.map((tool) => tool.name), MINECRAFT_DYNAMIC_TOOLS.map((tool) => tool.name));
		assert.equal(agent.executionSettings.effective.model, 'claude-sonnet-5-5');
		assert.equal(agent.executionSettings.evidence.model, 'provider_reported');
	} finally { await close(); }
});

test('a Claude process that confirms a different model is rejected before any Minecraft tool runs', async () => {
	const executed = [];
	const { service, close } = await harness({
		async onUser(child) {
			child.emitLine({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-opus-5-5' });
			await child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_wrong_model' } }).catch(() => null);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await assert.rejects(agent.act('Goal.', { goalRevision: 0, executeTool: async (request) => { executed.push(request); return { state: 'OK' }; } }),
			(error) => error.code === 'PROVIDER_SETTINGS_MISMATCH');
		assert.deepEqual(executed, []);
		assert.notEqual(agent.executionSettings.effective.model, 'claude-opus-5-5');
	} finally { await close(); }
});

for (const [selected, other] of [['claude-sonnet-5-5', 'claude-opus-5-5'], ['claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022']]) {
test(`a rotated Claude standby that confirms ${other} for selected ${selected} never runs the agent's tools`, async () => {
	const executed = [];
	const { service, children, close } = await harness({
		beforeToolsListed(child) {
			if (children.indexOf(child) === 1) child.args[child.args.indexOf('--model') + 1] = other;
		},
		async onUser(child) {
			if (children.indexOf(child) === 0) {
				usageLine(child, 'standby-model', 85_000);
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'first' }, _meta: { 'claudecode/toolUseId': 'toolu_standby_first' } });
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'old session done', session_id: 'session-1' });
				return;
			}
			child.emitLine({ type: 'system', subtype: 'init', session_id: 'session-2', model: other });
			await child.rpc('tools/call', { name: 'say', arguments: { message: 'wrong model' }, _meta: { 'claudecode/toolUseId': 'toolu_standby_wrong' } }).catch(() => null);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'wrong model done', session_id: 'session-2' });
		},
	}, { contextRotationTokens: 80_000, models: [selected] });
	try {
		const agent = await service.createAgent(profile({ model: selected }), { controlProtocol: 'native_tools' });
		const outcome = await agent.act('Long turn.', { goalRevision: 0, executeTool: async (request) => { executed.push(request.callId); return { state: 'SUCCEEDED', reasonCode: 'DONE' }; } })
			.then((result) => result, (error) => error);
		assert.deepEqual(executed, ['toolu_standby_first'], 'no tool runs from the other-model process');
		if (outcome?.status !== 'completed') assert.equal(outcome?.code, 'PROVIDER_SETTINGS_MISMATCH');
		assert.notEqual(agent.executionSettings.effective.model, other);
	} finally { await close(); }
});
}

for (const [selected, reported, accepted] of [
	['claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', true],
	['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', true],
	['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929[1m]', true],
	['claude-opus-5-5', 'claude-opus-5-5-20261001', false],
	['claude-3-5-haiku-latest', 'claude-3-5-haiku-20241022', true],
	['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20241022[1m]', true],
	['claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022', false],
	['claude-3-5-haiku-latest', 'claude-3-5-sonnet-20241022', false],
]) {
	test(`a Claude init confirming ${reported} for selected ${selected} is ${accepted ? 'accepted' : 'rejected'}`, async () => {
		const { service, close } = await harness({
			onUser(child) {
				child.emitLine({ type: 'system', subtype: 'init', session_id: 'session-1', model: reported });
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1' });
			},
		}, { models: [selected] });
		try {
			const agent = await service.createAgent(profile({ model: selected }), { controlProtocol: 'native_tools' });
			const outcome = agent.act('Goal.', { goalRevision: 0, executeTool: async () => ({}) });
			if (accepted) {
				assert.equal((await outcome).status, 'completed');
				assert.equal(agent.executionSettings.effective.model, reported);
			} else {
				await assert.rejects(outcome, (error) => error.code === 'PROVIDER_SETTINGS_MISMATCH');
			}
		} finally { await close(); }
	});
}

test('a Claude native turn executes Minecraft tools through the coordinator and completes on the result line', async () => {
	const executed = [];
	const { service, close } = await harness({
		async onUser(child, content) {
			child.emitLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking around.' }] } });
			const response = await child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_1' } });
			child.toolResponse = response.result;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: `done: ${content}`, session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const verbose = [];
		const progress = [];
		const result = await agent.act('Goal: gather wood.', {
			goalRevision: 0,
			onVerbose: (stage, message) => verbose.push([stage, message]),
			onProgress: (metadata) => progress.push(metadata),
			executeTool: async (request) => { executed.push(request); return { state: 'OK', nearby: ['minecraft:oak_log'] }; },
		});
		assert.deepEqual(result, { status: 'completed', toolCalls: 1 });
		assert.equal(executed.length, 1);
		assert.equal(executed[0].tool.kind, 'observe');
		assert.equal(executed[0].agentId, 'claude-a');
		assert.equal(executed[0].callId, 'toolu_1');
		assert.deepEqual(verbose.filter(([stage]) => stage !== 'provider_event'), [['agent_message', 'Looking around.']]);
		// Stamped once the MCP response has left the tool server, so the trace does not count formatting as free.
		assert.deepEqual(providerEvents(verbose).filter((entry) => entry.event === 'native_provider_tool_result_sent'), [{ event: 'native_provider_tool_result_sent', callId: 'toolu_1' }]);
		assert.deepEqual(progress.filter((entry) => entry.phase === 'tool_completed'), [{ phase: 'tool_completed', callId: 'toolu_1' }],
			'the planner sees the same publication boundary as for Codex');
		assert.equal(agent.sessionMetadata().sessionState, 'warm');
	} finally { await close(); }
});

test('a Claude call reports tool_streaming as soon as it starts streaming a tool call', async () => {
	const { service, close } = await harness({
		async onUser(child) {
			child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_stream', usage: { input_tokens: 1, output_tokens: 1 } } } });
			child.emitLine({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
			child.emitLine({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_s', name: 'mcp__minecraft__observe', input: {} } } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const progress = [];
		await agent.act('Goal: gather wood.', { goalRevision: 0, onProgress: (metadata) => progress.push(metadata), executeTool: async () => ({}) });
		assert.equal(progress.filter((entry) => entry.phase === 'tool_streaming').length, 1, 'text blocks do not count; the tool block does once');
	} finally { await close(); }
});

test('an exact Claude cancellation runs while earlier tools are still pending, and later writes wait for it', async () => {
	const started = [];
	let releaseObserve;
	const observeGate = new Promise((resolve) => { releaseObserve = resolve; });
	let cancelDone;
	const cancelFinished = new Promise((resolve) => { cancelDone = resolve; });
	const { service, close } = await harness({
		async onUser(child) {
			const observe = child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_slow' } });
			await new Promise((resolve) => setTimeout(resolve, 20));
			const cancel = child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'program-1', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'toolu_cancel' } });
			await new Promise((resolve) => setTimeout(resolve, 5));
			const say = child.rpc('tools/call', { name: 'say', arguments: { message: 'after cancel' }, _meta: { 'claudecode/toolUseId': 'toolu_after' } });
			// Without the bypass the cancel waits behind observe; release it after a bound so the order is reported.
			await Promise.race([cancelFinished, new Promise((resolve) => setTimeout(resolve, 1_000))]);
			releaseObserve();
			await Promise.all([observe, cancel, say]);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act('Cancel the program.', { goalRevision: 0, executeTool: async ({ tool }) => {
			started.push(tool.kind);
			if (tool.kind === 'observe') { await observeGate; started.push('observe_done'); }
			if (tool.kind === 'cancel_program') { cancelDone(); return { state: 'CANCELLED', programId: 'program-1' }; }
			return { state: 'OK' };
		} });
		assert.equal(result.status, 'completed');
		assert.deepEqual(started, ['observe', 'cancel_program', 'observe_done', 'action'],
			'cancellation bypasses the pending observe; the later write still waits behind earlier work');
	} finally { releaseObserve(); await close(); }
});

test('Claude preserves the previous action outcome alongside a replacement error', async () => {
	let response;
	const replacedAction = { actionId: 'native:previous:1', state: 'FAILED', reasonCode: 'NO_PATH' };
	const current = { goalRevision: 0, body: 'free', action: { actionId: 'native:previous:1', state: 'FAILED', reasonCode: 'NO_PATH' } };
	const { service, close } = await harness({ async onUser(child) {
		response = (await child.rpc('tools/call', { name: 'replaceAction', arguments: {
			actionId: replacedAction.actionId, goalRevision: 0, actionType: 'wait', arguments: { durationMs: 1 },
		} })).result;
		child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1' });
	} });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.act('event: escape', { goalRevision: 0, executeTool: async () => {
			throw Object.assign(new Error('replacement send failed'), { code: 'TEST_SEND_FAILED', replacedAction, current });
		} });
		assert.equal(response.isError, true);
		assert.deepEqual(JSON.parse(response.content[0].text), {
			state: 'FAILED', reasonCode: 'TEST_SEND_FAILED', failure: { blockedBy: 'replacement send failed' }, replacedAction, current,
		});
	} finally { await close(); }
});

test('Claude sends every static diagnostic through its MCP error response', async () => {
	const source = 'program.onUnhandledAttention("pause_and_notify");' + Array.from({length:12}, (_,i) => `const v${i}=player["constructor"];`).join('');
	let response; const verbose = [];
	const {service,close} = await harness({async onUser(child) {
		response = (await child.rpc('tools/call', {name:'runProgram',arguments:{source}})).result;
		child.emitLine({type:'result',subtype:'success',is_error:false,result:'done',session_id:'session-1'});
	}});
	try {
		const agent = await service.createAgent(profile(), {controlProtocol:'native_tools'});
		await agent.act('Run authored source.', {goalRevision:0,onVerbose:(stage,message) => verbose.push([stage,message]),executeTool:async () => parseArenaScript(source)});
		const result = decodeModelFacts(JSON.parse(response.content[0].text));
		assert.equal(response.isError, true);
		assert.ok(Array.isArray(result.diagnostics), JSON.stringify(result));
		assert.equal(result.diagnostics.length, 12);
		assert.equal(result.diagnosticsTruncated, false);
		assert.ok(result.failure.blockedBy.length <= 512);
		const rejected = providerEvents(verbose).find(row => row.event === 'native_tool_rejected');
		assert.equal(rejected?.diagnosticCount, 12);
		assert.equal(rejected.diagnosticCodes.length, 12);
		assert.ok(rejected.diagnosticCodes.every(code => code === 'UNSAFE_MEMBER_ACCESS'));
		assert.equal(rejected.diagnosticsTruncated, false);
	} finally { await close(); }
});

test('tool results reach Claude as MCP content and stale or foreign calls are refused', async () => {
	let captured = null;
	const { service, children, close } = await harness({
		async onUser(child) {
			captured = (await child.rpc('tools/call', { name: 'observe', arguments: {} })).result;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.act('Observe.', { goalRevision: 0, executeTool: async () => ({ state: 'OK', health: 20 }) });
		assert.equal(captured.isError, false);
		assert.deepEqual(JSON.parse(captured.content[0].text), { state: 'OK', health: 20 });

		const idle = await children[0].rpc('tools/call', { name: 'observe', arguments: {} });
		assert.equal(idle.result.isError, true);
		assert.equal(JSON.parse(idle.result.content[0].text).reasonCode, 'TURN_NOT_ACTIVE');

		const foreign = await fetch(children[0].mcp.url, { method: 'POST', headers: { authorization: `Bearer ${'0'.repeat(64)}` }, body: '{}' });
		assert.equal(foreign.status, 401);
	} finally { await close(); }
});

test('steering rides along with the next tool result and resolves once delivered', async () => {
	let captured = null;
	let release;
	const { service, children, close } = await harness({
		async onUser(child) {
			await new Promise((resolve) => { release = resolve; });
			captured = (await child.rpc('tools/call', { name: 'observe', arguments: {} })).result;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Goal: build a hut.', { goalRevision: 0, executeTool: async () => ({ state: 'OK' }) });
		await waitFor(() => release !== undefined);
		const steer = agent.steer('A zombie is attacking.', { goalRevision: 0 });
		release();
		assert.deepEqual(await steer, { turnId: '1:1' });
		assert.deepEqual(await turn, { status: 'completed', toolCalls: 1 });
		assert.equal(captured.isError, false);
		assert.deepEqual(JSON.parse(captured.content[0].text), { state: 'OK' });
		assert.match(captured.content[1].text, /Newer coordinator events[\s\S]*A zombie is attacking\./);
		assert.equal(children[0].lines.filter((line) => line.type === 'user').length, 1, 'steers never become extra Claude Code turns');
		await assert.rejects(agent.steer('Too late.', { goalRevision: 0 }), (error) => error.code === 'TURN_NOT_ACTIVE');
	} finally { await close(); }
});

test('Claude returns a blocking body result early and attaches the latest lazily-built steer', async () => {
	let captured = null;
	let releaseExecution;
	let toolStarted;
	const started = new Promise((resolve) => { toolStarted = resolve; });
	const execution = new Promise((resolve) => { releaseExecution = resolve; });
	const { service, close } = await harness({
		async onUser(child) {
			captured = (await child.rpc('tools/call', { name: 'wait', arguments: { durationMs: 30_000 } })).result;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Goal.', { goalRevision: 0, executeTool: async () => { toolStarted(); return execution; } });
		void turn.catch(() => {});
		await started;
		let currentFacts = 'stale zombie facts';
		const steer = agent.steer(() => currentFacts, {
			goalRevision: 0,
			onInterrupt: () => releaseExecution({ state: 'RUNNING', actionId: 'body-action-1', interruptedBy: 'danger' }),
		});
		currentFacts = 'fresh zombie and health facts';
		assert.deepEqual(await Promise.race([steer, new Promise((resolve) => setTimeout(() => resolve('BLOCKED'), 20_000))]), { turnId: '1:1' });
		assert.deepEqual(await turn, { status: 'completed', toolCalls: 1 });
		assert.equal(JSON.parse(captured.content[0].text).actionId, 'body-action-1');
		assert.equal(JSON.parse(captured.content[0].text).state, 'RUNNING');
		assert.match(captured.content[1].text, /fresh zombie and health facts/);
	} finally { releaseExecution({ state: 'RUNNING', actionId: 'body-action-1', interruptedBy: 'danger' }); await close(); }
});

test('Claude releases a superseded steer builder reservation', async () => {
	let captured = null;
	let releaseExecution;
	let finishFirstBuilder;
	let firstBuilderStarted;
	let discarded = 0;
	let signalToolStarted;
	const toolStarted = new Promise((resolve) => { signalToolStarted = resolve; });
	const builderStarted = new Promise((resolve) => { firstBuilderStarted = resolve; });
	const firstBuilder = new Promise((resolve) => { finishFirstBuilder = resolve; });
	const execution = new Promise((resolve) => { releaseExecution = resolve; });
	const { service, close } = await harness({
		async onUser(child) {
			captured = (await child.rpc('tools/call', { name: 'wait', arguments: { durationMs: 30_000 } })).result;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Goal.', { goalRevision: 0, executeTool: async () => { signalToolStarted(); return execution; } });
		void turn.catch(() => {});
		await toolStarted;
		const first = agent.steer(async () => { firstBuilderStarted(); return firstBuilder; }, { goalRevision: 0, onDiscard: () => { discarded += 1; } });
		releaseExecution({ state: 'RUNNING', actionId: 'body-action-1', interruptedBy: 'danger' });
		await builderStarted;
		const latest = agent.steer(async () => 'newest facts', { goalRevision: 0 });
		finishFirstBuilder('obsolete reservation input');
		assert.deepEqual(await first, { turnId: '1:1' });
		assert.deepEqual(await latest, { turnId: '1:1' });
		assert.deepEqual(await turn, { status: 'completed', toolCalls: 1 });
		assert.equal(discarded, 1);
		assert.match(captured.content[1].text, /newest facts/);
		assert.doesNotMatch(captured.content[1].text, /obsolete reservation input/);
	} finally { releaseExecution?.({ state: 'RUNNING', actionId: 'body-action-1', interruptedBy: 'danger' }); finishFirstBuilder?.('cleanup'); await close(); }
});

test('a steer that never reaches a tool boundary is rejected so the coordinator defers it', async () => {
	let release;
	const { service, close } = await harness({
		onUser(child) { release = () => child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' }); },
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Goal.', { goalRevision: 0, executeTool: async () => ({ state: 'OK' }) });
		await waitFor(() => release !== undefined);
		const steer = agent.steer('Late event.', { goalRevision: 0 });
		void steer.catch(() => {});
		release();
		assert.deepEqual(await turn, { status: 'completed', toolCalls: 0 });
		await assert.rejects(steer, (error) => error.code === 'TURN_NOT_ACTIVE');
	} finally { await close(); }
});

test('a new goal revision interrupts the running Claude turn and the next turn waits for its closing result', async () => {
	let turns = 0;
	const { service, children, close } = await harness({
		onUser(child) {
			turns += 1;
			if (turns === 2) child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const first = agent.act('Old goal.', { goalRevision: 0, executeTool: async () => ({ state: 'OK' }) });
		await waitFor(() => turns === 1);
		await agent.setGoalRevision(1);
		await assert.rejects(first, (error) => error.code === 'STALE_PLAN');
		assert.ok(children[0].lines.some((line) => line.type === 'control_request' && line.request.subtype === 'interrupt'));
		assert.deepEqual(await agent.act('New goal.', { goalRevision: 1, executeTool: async () => ({ state: 'OK' }) }), { status: 'completed', toolCalls: 0 });
		assert.equal(children.length, 1, 'the warm process is reused after an acknowledged interrupt');
	} finally { await close(); }
});

test('an unexpected Claude Code exit invalidates the session and fails the active turn', async () => {
	const { service, children, close } = await harness({ onUser(child) { child.stderr.emit('data', 'auth expired'); child.exit(1); } });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await assert.rejects(agent.act('Goal.', { goalRevision: 0, executeTool: async () => ({}) }), (error) => error.code === 'SESSION_INVALIDATED');
		assert.equal(service.getAgent('claude-a'), null);
		assert.equal(children.length, 1);
	} finally { await close(); }
});

test('account-level refusals become non-retryable model errors', async () => {
	const { service, close } = await harness({
		onUser(child) {
			child.emitLine({ type: 'result', subtype: 'success', is_error: true, result: 'Fable 5.1 requires usage credits. Switch to another model, or manage usage credits.', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile({ model: 'claude-fable-5-1' }), { controlProtocol: 'native_tools' });
		await assert.rejects(agent.act('Goal.', { goalRevision: 0, executeTool: async () => ({}) }),
			(error) => error.code === 'MODEL_UNAVAILABLE' && /requires usage credits/.test(error.message));
	} finally { await close(); }
});

test('Claude goal translation is a one-shot JSON decision without tools', async () => {
	const { service, children, close } = await harness({
		oneShot(child) {
			child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '```json\n{"ok":true}\n```', duration_ms: 12, duration_api_ms: 9, usage: { input_tokens: 5, output_tokens: 2 } })));
			child.exit(0);
		},
	});
	try {
		const agent = await service.createAgent(profile({ agentId: 'translator' }), { controlProtocol: 'goal_spec' });
		const decision = await agent.decide('Translate: get wood.', { goalRevision: 0, systemPrompt: '', outputSchema: { type: 'object' }, parseOutput: (text) => JSON.parse(text) });
		assert.deepEqual(decision, { ok: true });
		const [child] = children;
		assert.equal(child.args[child.args.indexOf('--output-format') + 1], 'json');
		assert.equal(child.args[child.args.indexOf('--tools') + 1], '');
		assert.equal(child.args.includes('--mcp-config'), false);
		assert.match(child.oneShotPrompt, /Translate: get wood\.[\s\S]*JSON Schema/);
	} finally { await close(); }
});

test('buildClaudeLaunch keeps the bridge secret out of the child and disables auto-memory', () => {
	const launch = buildClaudeLaunch(profile(), { executable: 'claude', environment: { PATH: 'p', CUSTOM_SECRET: 'x', ANTHROPIC_BASE_URL: 'https://example.invalid' }, bridgeSecretEnvironmentVariable: 'CUSTOM_SECRET' }, {
		cwd: 'C:\\workspace', systemPromptFile: 'C:\\prompt.md', mcpConfig: null, streaming: false,
	});
	assert.equal(launch.options.env.CUSTOM_SECRET, undefined);
	assert.equal(launch.options.env.ANTHROPIC_BASE_URL, 'https://example.invalid');
	assert.equal(launch.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
	assert.equal(launch.options.windowsHide, true);
});

test('buildClaudeLaunch requests Claude fast mode only for the priority tier when the config opts in', () => {
	const settingsOf = (config, overrides) => {
		const { args } = buildClaudeLaunch(profile(overrides), { executable: 'claude', ...config }, { cwd: 'C:\\workspace', systemPromptFile: 'C:\\prompt.md', mcpConfig: null, streaming: true });
		return args.includes('--settings') ? args[args.indexOf('--settings') + 1] : null;
	};
	assert.equal(settingsOf({ fastMode: true }), '{"fastMode":true}');
	assert.equal(settingsOf({}), null, 'opt-in: billed from usage credits');
	assert.equal(settingsOf({ fastMode: false }), null);
	assert.equal(settingsOf({ fastMode: true }, { serviceTier: 'fast' }), null, 'only the priority tier maps to fast mode');
});

test('Claude reports the fast mode state Claude Code returns instead of leaving the tier unreported', async () => {
	const { service, close } = await harness({
		onUser(child) {
			child.emitLine({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sonnet-5-5' });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1', fast_mode_state: 'off', fast_mode_disabled_reason: 'extra_usage_disabled' });
		},
	}, { fastMode: true });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		assert.equal(agent.executionSettings.evidence.serviceTier, 'requested');
		await agent.act('Goal.', { goalRevision: 0, executeTool: async () => ({ state: 'OK' }) });
		assert.equal(agent.executionSettings.evidence.serviceTier, 'provider_reported');
		assert.equal(agent.executionSettings.effective.serviceTier, 'standard');
		assert.deepEqual(agent.executionSettings.limitations, ['claude fast mode off (extra_usage_disabled)']);
	} finally { await close(); }
});

test('without the fast-mode opt-in the priority tier stays an unreported label', async () => {
	const { service, close } = await harness({
		onUser(child) {
			child.emitLine({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sonnet-5-5' });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1', fast_mode_state: 'off' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.act('Goal.', { goalRevision: 0, executeTool: async () => ({ state: 'OK' }) });
		assert.equal(agent.executionSettings.evidence.serviceTier, 'unreported');
		assert.notEqual(agent.executionSettings.effective.serviceTier, 'standard');
	} finally { await close(); }
});

// The deadline only bounds a failure; a passing test never waits for it, so it carries no behaviour under load.
async function waitFor(predicate, timeoutMs = 20_000) {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error('condition was not reached');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test('pending Claude steers are superseded and built at the next tool boundary', async () => {
	let captured = null;
	let release;
	const { service, children, close } = await harness({
		async onUser(child) {
			await new Promise((resolve) => { release = resolve; });
			captured = (await child.rpc('tools/call', { name: 'observe', arguments: {} })).result;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Goal: survive.', { goalRevision: 0, executeTool: async () => ({ state: 'OK' }) });
		await waitFor(() => release !== undefined);
		// The play-test: ~30 threat/damage events while the model was still deciding its first action.
		const steers = [
			agent.steer('obsolete threat snapshot', { goalRevision: 0 }),
			agent.steer('obsolete damage snapshot', { goalRevision: 0 }),
			agent.steer('fresh suffocation facts', { goalRevision: 0 }),
		];
		release();
		for (const steer of steers) assert.deepEqual(await steer, { turnId: '1:1' });
		assert.deepEqual(await turn, { status: 'completed', toolCalls: 1 });
		assert.equal(children[0].lines.filter((line) => line.type === 'control_request' && line.request?.subtype === 'interrupt').length, 0,
			'a steer never interrupts the model mid-reasoning');
		assert.equal(children[0].lines.filter((line) => line.type === 'user').length, 1, 'no restarted or extra turn');
		assert.equal(children.length, 1, 'the warm process and its reasoning are kept');
		assert.equal(captured.content.length, 2, 'the latest pending steer rides on the one tool result');
		assert.match(captured.content[1].text, /fresh suffocation facts/);
		assert.doesNotMatch(captured.content[1].text, /obsolete threat|obsolete damage/);
	} finally { await close(); }
});

// --- Token efficiency: usage, rotation, restarts and fact views ---
const { buildNativeEventInput } = await import('../src/dynamic-main.mjs');
const { representativeProgramWake, representativeRecord } = await import('../src/benchmark/token-budget.mjs');
const nativeEvent = (sequence, change = (wake) => wake) => {
	const wake = representativeProgramWake(sequence);
	wake.conversation = { mode: 'unread', baseSequence: 12, nextSequence: 13, entries: sequence === 1 ? [{ sequence: 13, kind: 'player_message', sourceId: '11111111-1111-4111-8111-111111111111', sourceName: 'Lucas', text: 'meet me at the village' }] : [] };
	return buildNativeEventInput(representativeRecord(), change(wake));
};
const sentPayload = (content) => JSON.parse(content.slice(content.lastIndexOf('\n{') + 1));
const usageLine = (child, id, context) => {
	child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 5, cache_read_input_tokens: context, cache_creation_input_tokens: 200, output_tokens: 1 } } } });
	child.emitLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });
	child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
};
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('Claude per-call usage and timing reach live usage; cost is a per-process running total and output comes from the turn result', async () => {
	let cost = 0;
	const { service, children, close } = await harness({
		async onUser(child) {
			usageLine(child, `msg_${child.lines.length}`, 20_000);
			cost += 0.01;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1', total_cost_usd: cost, usage: { output_tokens: 55 } });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const verbose = [];
		const first = await agent.act('One.', { goalRevision: 0, onVerbose: (stage, message) => verbose.push([stage, message]), executeTool: async () => ({}) });
		assert.deepEqual(first.usage, { calls: 1, input: 5, cacheRead: 20_000, cacheWrite: 200, output: 55, costUsd: 0.01, contextTokens: 20_205 });
		const second = await agent.act('Two.', { goalRevision: 0, executeTool: async () => ({}) });
		assert.equal(Math.round(second.usage.costUsd * 1000), 10, 'the running total is not counted twice');
		const live = JSON.parse(verbose.find(([stage]) => stage === 'live_usage')[1]);
		assert.equal(live.last.inputTokens, 20_205);
		assert.equal(live.cacheWriteInputTokens, 200);
		assert.ok(Number.isSafeInteger(live.call.firstEventMs) && Number.isSafeInteger(live.call.streamMs) && Number.isSafeInteger(live.call.totalMs));
		assert.ok(children[0].args.includes('--include-partial-messages'));
	} finally { await close(); }
});

const modelCall = (verbose) => verbose.filter(([stage]) => stage === 'live_usage').map(([, message]) => JSON.parse(message).call);
function providerEvents(verbose) { return verbose.filter(([stage]) => stage === 'provider_event').map(([, message]) => JSON.parse(message)); }

const latestCallUsage = verbose => [...new Map(verbose.filter(([stage]) => stage === 'live_usage')
	.map(([, text]) => JSON.parse(text)).filter(value => value.call)
	.map(value => [value.call.modelCallId, value])).values()];

test('model-call end time excludes synchronous standby preparation work', async () => {
	let clock = 1000, expectedEnd;
	const verbose = [];
	const h = await harness({
		onUser(child) {
			const originalNow = Date.now;
			try {
				Date.now = () => clock;
				expectedEnd = clock;
				usageLine(child, 'timed-call', 90_000);
			} finally { Date.now = originalNow; }
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const register = h.toolServer.register.bind(h.toolServer);
		h.toolServer.register = options => { clock += 500; return register(options); };
		await agent.act('One.', { goalRevision: 0, onVerbose: (stage, text) => verbose.push([stage, text]), executeTool: async () => ({}) });
		assert.equal(clock, expectedEnd + 500, 'standby registration exercised the synchronous overhead');
		assert.equal(modelCall(verbose)[0].endedAt, expectedEnd);
	} finally { await h.close(); }
});

test('stopping the Claude tool server during listener startup leaves no live route, and a later start still works', async () => {
	const server = new ClaudeToolServer();
	const callTool = async () => ({ content: [] });
	const registering = server.register({ callTool });
	await server.stop();
	const outcome = await registering.then((route) => route, (error) => error);
	let leaked = null;
	if (typeof outcome?.url === 'string') {
		leaked = await fetch(outcome.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${outcome.token}` },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		}).then((response) => response.status, () => null);
		await server.stop();
	}
	assert.equal(leaked, null, 'no authenticated route answers after stop');
	assert.equal(outcome?.code, 'PROVIDER_STOPPED');
	const route = await server.register({ callTool });
	try {
		const response = await fetch(route.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${route.token}` },
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
		});
		assert.equal(response.status, 200, 'a deliberate restart opens a new listener');
	} finally { await server.stop(); }
});

test('removing a Claude agent while its tool route registers unregisters the late route', async () => {
	const h = await harness();
	let releaseRegister;
	const registerGate = new Promise((resolve) => { releaseRegister = resolve; });
	let unregistered = 0;
	let registered = 0;
	try {
		const agent = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const register = h.toolServer.register.bind(h.toolServer);
		h.toolServer.register = async (options) => {
			await registerGate;
			const route = await register(options);
			registered += 1;
			return { ...route, unregister: () => { unregistered += 1; route.unregister(); } };
		};
		const warming = agent.prewarm().catch((error) => error);
		await new Promise((resolve) => setImmediate(resolve));
		await h.service.removeAgent(agent.agentId);
		releaseRegister();
		const error = await warming;
		assert.equal(error?.code, 'AGENT_DISPOSED');
		assert.equal(registered, 1);
		assert.equal(unregistered, 1, 'the late route is unregistered exactly once');
		assert.equal(h.children.length, 0, 'no Claude Code process starts for a removed agent');
	} finally { releaseRegister(); await h.close(); }
});

test('interrupted respawn calls remain traced after the rejected turn has cleared its active callback', async () => {
	let turns = 0;
	const verbose = [];
	const { service, close } = await harness({
		ignoreInterrupt: true,
		onUser(child) {
			turns += 1;
			child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: `respawn-${turns}`, usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 1 } } } });
			if (turns === 2) {
				child.emitLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 10 } } });
				child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
				child.emitLine({ type: 'result', subtype: 'success', usage: { output_tokens: 10 } });
			}
		},
	}, { interruptTimeoutMs: 20 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const first = agent.act('Before death.', { goalRevision: 0, onVerbose: (stage, text) => verbose.push([stage, text]), executeTool: async () => ({}) });
		await waitFor(() => turns === 1);
		const rejection = assert.rejects(first, error => error.code === 'STALE_PLAN');
		await agent.setGoalRevision(1);
		await rejection;
		await agent.act('After respawn.', { goalRevision: 1, onVerbose: (stage, text) => verbose.push([stage, text]), executeTool: async () => ({}) });
		const calls = latestCallUsage(verbose);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].call.interrupted, true);
		assert.equal(calls[0].call.partialMessagesAccepted, true);
		assert.equal(calls[0].call.turnId, '1:1');
		assert.deepEqual(calls.map(value => value.last.cachedInputTokens), [1000, 1000]);
		assert.equal(calls.at(-1).cachedInputTokens, 2000);
		assert.equal(calls.at(-1).outputTokens, 11);
	} finally { await close(); }
});

test('turn output corrections update identified call rows to reconcile with cumulative usage', async () => {
	const verbose = [];
	const { service, close } = await harness({ async onUser(child) {
		usageLine(child, 'output-one', 1000);
		usageLine(child, 'output-two', 1000);
		await settle(20);
		child.emitLine({ type: 'result', subtype: 'success', usage: { output_tokens: 55 } });
	} });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act('Two calls.', { goalRevision: 0, onVerbose: (stage, text) => verbose.push([stage, text]), executeTool: async () => ({}) });
		const calls = latestCallUsage(verbose);
		assert.equal(calls.length, 2);
		assert.equal(calls.reduce((total, value) => total + value.last.outputTokens, 0), 55);
		assert.equal(calls.at(-1).outputTokens, 55);
		assert.equal(result.usage.output, 55);
		assert.ok(calls.every(value => typeof value.call.modelCallId === 'string' && value.call.partialMessagesAccepted));
		const repeated = verbose.filter(([stage]) => stage === 'live_usage').map(([, text]) => JSON.parse(text))
			.filter(value => value.call.modelCallId === calls.at(-1).call.modelCallId);
		assert.equal(repeated[0].call.endedAt, repeated.at(-1).call.endedAt);
		assert.equal(repeated[0].call.totalMs, repeated.at(-1).call.totalMs);
	} finally { await close(); }
});

test('late assistant placeholders cannot mutate already booked streaming call usage', async () => {
	const verbose = [];
	const { service, close } = await harness({ onUser(child) {
		usageLine(child, 'completed-stream', 1000);
		child.emitLine({ type: 'assistant', message: { id: 'completed-stream', content: [], usage: { output_tokens: 100 } } });
		child.emitLine({ type: 'result', subtype: 'success', usage: { output_tokens: 55 } });
	} });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act('Streaming.', { goalRevision: 0, onVerbose: (stage, text) => verbose.push([stage, text]), executeTool: async () => ({}) });
		assert.equal(result.usage.output, 55);
		assert.equal(latestCallUsage(verbose)[0].last.outputTokens, 55);
		assert.equal(latestCallUsage(verbose)[0].outputTokens, 55);
	} finally { await close(); }
});

test('first streamed event arriving after interruption retains the billed turn identity', async () => {
	let child;
	const verbose = [];
	const { service, close } = await harness({ ignoreInterrupt: true, onUser(value) { child = value; } });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const pending = agent.act('Before respawn.', { goalRevision: 0, onVerbose: (stage, text) => verbose.push([stage, text]), executeTool: async () => ({}) });
		await waitFor(() => child !== undefined);
		const rejection = assert.rejects(pending, error => error.code === 'STALE_PLAN');
		const interrupt = agent.interrupt();
		await rejection;
		usageLine(child, 'late-first-event', 1000);
		child.emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: { output_tokens: 40 } });
		await interrupt;
		assert.equal(latestCallUsage(verbose).length, 1);
		assert.equal(latestCallUsage(verbose)[0].call.turnId, '1:1');
	} finally { await close(); }
});

test('disposing during a streaming call emits its billed lower bound once', async () => {
	const verbose = [];
	let started = false;
	const { service, close } = await harness({ onUser(child) {
		child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'stopped-call', usage: { input_tokens: 7, cache_creation_input_tokens: 90, output_tokens: 1 } } } });
		started = true;
	} });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const pending = agent.act('Window end.', { goalRevision: 0, onVerbose: (stage, text) => verbose.push([stage, text]), executeTool: async () => ({}) });
		await waitFor(() => started);
		const rejection = assert.rejects(pending, error => error.code === 'AGENT_DISPOSED');
		await agent.dispose();
		await rejection;
		const calls = latestCallUsage(verbose);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].last.inputTokens, 97);
		assert.equal(calls[0].last.outputTokens, 1);
		assert.equal(calls[0].call.interrupted, true);
	} finally { await close(); }
});

test('model call trace names every tool the model starts, CLI-local ones included, and sends the turn-sent stage', async () => {
	const { service, close } = await harness({
		async onUser(child) {
			child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a', usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 1 } } } });
			child.emitLine({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } } });
			child.emitLine({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'mcp__minecraft__observe', input: {} } } });
			child.emitLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 9 } } });
			child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const verbose = [];
		await agent.act('One.', { goalRevision: 0, onVerbose: (stage, message) => verbose.push([stage, message]), executeTool: async () => ({}) });
		const [call] = modelCall(verbose);
		assert.deepEqual(call.toolNames, ['Read', 'mcp__minecraft__observe']);
		assert.equal(call.toolStartMs.length, 2);
		assert.equal(call.firstEventSource, 'stream');
		assert.equal(call.streamEvents, 5);
		assert.ok(Number.isSafeInteger(call.requestAt) && Number.isSafeInteger(call.firstEventAt) && call.firstEventAt >= call.requestAt);
		assert.ok(Number.isSafeInteger(call.startMs));
		assert.deepEqual(providerEvents(verbose).map((entry) => entry.event), ['native_provider_turn_sent']);
	} finally { await close(); }
});

test('model call timing starts at the first stream event of any kind when message_start is missing', async () => {
	const { service, close } = await harness({
		async onUser(child) {
			child.emitLine({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
			await settle(40);
			child.emitLine({ type: 'assistant', message: { id: 'msg_b', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 3 } } });
			child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const verbose = [];
		await agent.act('One.', { goalRevision: 0, onVerbose: (stage, message) => verbose.push([stage, message]), executeTool: async () => ({}) });
		const [call] = modelCall(verbose);
		assert.equal(call.firstEventSource, 'stream');
		assert.equal(call.startMs, undefined, 'no message_start was seen');
		assert.ok(call.streamMs >= 30, 'generation time is kept instead of collapsing to the assistant message');
		assert.equal(call.totalMs, call.firstEventMs + call.streamMs);
	} finally { await close(); }
});

test('model call without stream events reports that its first event is the assistant message', async () => {
	const { service, close } = await harness({
		async onUser(child) {
			child.emitLine({ type: 'assistant', message: { id: 'msg_c', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 3 } } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const verbose = [];
		await agent.act('One.', { goalRevision: 0, onVerbose: (stage, message) => verbose.push([stage, message]), executeTool: async () => ({}) });
		const [call] = modelCall(verbose);
		assert.equal(call.firstEventSource, 'assistant');
		assert.equal(call.streamEvents, 0);
	} finally { await close(); }
});

test('streamed token events renew liveness at most once a second', async () => {
	const { service, close } = await harness({
		async onUser(child) {
			child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', usage: {} } } });
			for (let index = 0; index < 50; index++) child.emitLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		let progress = 0;
		await agent.act('One.', { goalRevision: 0, onProgress: () => { progress += 1; }, executeTool: async () => ({}) });
		assert.ok(progress <= 3, `progress renewed ${progress} times for 51 stream events`);
	} finally { await close(); }
});

test('rotation waits for hysteresis, happens after a finished turn with a prewarmed session, and carries recent calls, conversation and program state', async () => {
	const { service, children, close } = await harness({
		async onUser(child) {
			const userTurns = child.lines.filter((line) => line.type === 'user').length;
			usageLine(child, `msg_${child.lines.length}`, userTurns < 3 ? 70_000 : 90_000);
			if (children.length === 1 && child.lines.filter((line) => line.type === 'user').length === 1) {
				await child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_1' } });
			}
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const run = (sequence) => agent.act(nativeEvent(sequence), { goalRevision: 0, executeTool: async () => ({ state: 'SUCCEEDED', reasonCode: 'OBSERVED' }) });
		await run(1);
		await run(2);
		await waitFor(() => children.length === 2);
		assert.equal(children.length, 2, 'the standby is warm while the current process still owns the conversation');
		assert.equal(children[0].exitCode, null, 'hysteresis keeps the current process active until three finished turns');
		const second = sentPayload(children[0].lines.filter((line) => line.type === 'user')[1].message.content);
		assert.deepEqual(second.data.sameAsPreviousEvent, ['situation', 'goal', 'goalSpec', 'taskMemory']);
		await run(3);
		await waitFor(() => children.length === 2 && children[0].exitCode !== null);
		assert.equal(children.length, 2, 'the warmed standby becomes the new session without another spawn');
		assert.notEqual(children[0].exitCode, null);
		await run(4);
		const content = children[1].lines.find((line) => line.type === 'user').message.content;
		assert.match(content, /^Session refreshed to keep context small/);
		assert.match(content, /observe \{\} -> SUCCEEDED OBSERVED/);
		assert.match(content, /Lucas: meet me at the village/);
		assert.match(content, /"programId":"native-program-fixture-12"/);
		assert.match(content, /"pendingDecisionId":"native-program-fixture-12:decision-3"/);
		assert.equal(sentPayload(content).data.sameAsPreviousEvent, undefined, 'a fresh session gets the goal and task memory again');
	} finally { await close(); }
});

test('Claude rotates at a tool boundary and delivers the executed tool result once in the same active turn', async () => {
	let toolExecutions = 0;
	let standbyWarmDuringTool = false;
	let resumedInput = null;
	const { service, children, close } = await harness({
		async onUser(child, content) {
			const index = children.indexOf(child);
			if (index === 0) {
				usageLine(child, 'long-turn-over-threshold', 85_000);
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'one execution' }, _meta: { 'claudecode/toolUseId': 'toolu_rotation' } });
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'old process ended', session_id: 'session-1' });
				return;
			}
			resumedInput = content;
			usageLine(child, 'resumed-turn', 30_000);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act(nativeEvent(2), {
			goalRevision: 0,
			executeTool: async () => {
				toolExecutions += 1;
				await waitFor(() => children.length === 2);
				standbyWarmDuringTool = children.length === 2 && !children[1].lines.some((line) => line.type === 'user');
				return { state: 'SUCCEEDED', reasonCode: 'TOOL_RAN' };
			},
		});
		assert.equal(result.status, 'completed');
		assert.equal(result.toolCalls, 1, 'one active turn spans the process handoff');
		assert.equal(toolExecutions, 1, 'the game tool runs once');
		assert.equal(children.length, 2, 'the standby process becomes the active session at the tool boundary');
		assert.equal(standbyWarmDuringTool, true, 'standby startup overlaps execution of the current tool');
		await waitFor(() => children[0].exitCode !== null, 1_000);
		assert.notEqual(children[0].exitCode, null, 'the old process retires after its final result drains in the background');
		assert.match(resumedInput, /^Mid-turn continuation:/);
		assert.match(resumedInput, /Current turn input to continue:[\s\S]*program_attention/);
		assert.match(resumedInput, /Tool result for Minecraft tool "say"/);
		assert.equal((resumedInput.match(/"reasonCode":"TOOL_RAN"/g) ?? []).length, 1, 'the encoded result reaches the replacement model exactly once');
	} finally { await close(); }
});

test('a steer queued before a rotation handoff moves to the replacement session once, with the RUNNING early return', async () => {
	let resumed = null;
	let steerSettled = 0;
	let builds = 0;
	let older = null;
	const { service, children, close } = await harness({
		async onUser(child, content) {
			const index = children.indexOf(child);
			if (index === 0) {
				usageLine(child, 'long-turn-over-threshold', 85_000);
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'long action' }, _meta: { 'claudecode/toolUseId': 'toolu_running' } });
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'old process ended', session_id: 'session-1' });
				return;
			}
			resumed = content;
			usageLine(child, 'resumed-turn', 30_000);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act(nativeEvent(2), {
			goalRevision: 0,
			executeTool: async () => {
				// The body is still busy: the tool returns a RUNNING early result while a newer event waits for this boundary.
				older = agent.steer(async () => { builds += 1; return 'OLDER-SUPERSEDED-EVENT'; }, { goalRevision: 0 });
				void agent.steer(async () => { builds += 1; return 'DANGER-EVENT-NEWEST'; }, { goalRevision: 0 }).then(() => { steerSettled += 1; }, () => {});
				return { state: 'RUNNING', reasonCode: 'ACTION_RUNNING' };
			},
		});
		assert.equal(result.status, 'completed');
		await older;
		assert.equal(children.length, 2, 'the handoff happened at the RUNNING boundary');
		assert.equal((resumed.match(/DANGER-EVENT-NEWEST/g) ?? []).length, 1, 'the pending steer reaches the replacement exactly once');
		assert.equal((resumed.match(/"reasonCode":"ACTION_RUNNING"/g) ?? []).length, 1, 'the RUNNING result reaches the replacement exactly once');
		assert.doesNotMatch(resumed, /Newer coordinator events/, 'the steer is the current input, not a second copy');
		assert.equal(steerSettled, 1, 'the steer waiter resolves once');
		assert.doesNotMatch(resumed, /OLDER-SUPERSEDED-EVENT/);
		assert.equal(builds, 1, 'only the newest builder runs');
	} finally { await close(); }
});

test('Claude carries a failed tool result across a first-turn boundary rotation exactly once', async () => {
	let toolExecutions = 0;
	let resumedInput = null;
	const { service, children, close } = await harness({
		async onUser(child) {
			const index = children.indexOf(child);
			if (index === 0) {
				usageLine(child, 'first-turn-over-threshold', 85_000);
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'will fail' }, _meta: { 'claudecode/toolUseId': 'toolu_failed_rotation' } });
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'old process ended', session_id: 'session-1' });
				return;
			}
			resumedInput = child.lines.find((line) => line.type === 'user').message.content;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act(nativeEvent(1), {
			goalRevision: 0,
			executeTool: async () => {
				toolExecutions += 1;
				throw Object.assign(new Error('fixture body failure'), { code: 'FIXTURE_BODY_FAILED' });
			},
		});
		assert.equal(result.status, 'completed');
		assert.equal(toolExecutions, 1);
		assert.equal(children.length, 2, 'the first long turn can hand off without waiting for an earlier completed turn');
		assert.match(resumedInput, /Tool result for Minecraft tool "say"/);
		assert.equal((resumedInput.match(/"reasonCode":"FIXTURE_BODY_FAILED"/g) ?? []).length, 1);
	} finally { await close(); }
});

test('a cold-restart handoff whose write fails keeps the folded steer for the next turn', async () => {
	let steerSettled = 0;
	let nextInput = null;
	const { service, children, close } = await harness({
		beforeToolsListed(child) { if (children.indexOf(child) === 1) child.stdin.destroyed = true; },
		async onUser(child) {
			if (children.indexOf(child) === 0) {
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'long action' }, _meta: { 'claudecode/toolUseId': 'toolu_cold' } });
				return;
			}
			nextInput = child.lines.filter((line) => line.type === 'user').at(-1).message.content;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await assert.rejects(agent.act(nativeEvent(1), {
			goalRevision: 0,
			executeTool: async () => {
				void agent.steer(async () => 'FOLDED-STEER-TEXT', { goalRevision: 0 }).then(() => { steerSettled += 1; }, () => {});
				children[0].exit(1);
				return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
			},
		}), (error) => error.code === 'PROVIDER_UNAVAILABLE');
		assert.equal(children.length, 2, 'the tool result restarted Claude Code cold');
		assert.equal(steerSettled, 1, 'the steer waiter already resolved when it was folded into the handoff');
		children[1].stdin.destroyed = false;
		await agent.act(nativeEvent(2), { goalRevision: 0, executeTool: async () => ({}) });
		assert.equal((nextInput.match(/FOLDED-STEER-TEXT/g) ?? []).length, 1, 'the folded steer reaches the model in the next turn');
		assert.equal((nextInput.match(/"reasonCode":"ACTION_COMPLETED"/g) ?? []).length, 1, 'the completed tool result is carried once');
	} finally { await close(); }
});

test('a cold-restart handoff stays booked so a goal change cannot hand its running turn to the next goal', async () => {
	let agent;
	const executed = [];
	const { service, children, close } = await harness({
		ignoreInterrupt: true,
		async onUser(child) {
			const index = children.indexOf(child);
			if (index === 0) {
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'old goal action' }, _meta: { 'claudecode/toolUseId': 'toolu_cold_old' } });
				return;
			}
			// The replacement keeps running the old goal's handoff and never closes it before the goal change.
			if (index === 1) return;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'next goal complete', session_id: 'session-3' });
		},
	});
	try {
		agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const first = agent.act(nativeEvent(1), {
			goalRevision: 0,
			executeTool: async (request) => {
				executed.push(request.goalRevision);
				children[0].exit(1);
				return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
			},
		});
		void first.catch(() => {});
		for (let index = 0; index < 200 && !(children[1]?.lines.some((line) => line.type === 'user')); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(children.length, 2, 'the tool result restarted Claude Code cold');
		await agent.setGoalRevision(1);
		await assert.rejects(first);
		const second = await agent.act(nativeEvent(2), { goalRevision: 1, executeTool: async (request) => { executed.push(request.goalRevision); return {}; } });
		assert.equal(second.status, 'completed');
		assert.equal(children[1].lines.filter((line) => line.type === 'user').length, 1,
			'the next goal never reaches the replacement still running the old handoff');
		assert.notEqual(children[1].exitCode, null, 'the unacknowledged replacement turn is retired');
		await children[1].rpc('tools/call', { name: 'say', arguments: { message: 'stale' }, _meta: { 'claudecode/toolUseId': 'toolu_cold_late' } }).catch(() => null);
		assert.deepEqual(executed, [0], 'late old-goal tools from the retired replacement never execute');
	} finally { await close(); }
});

test('interrupting while a standby is pending cancels handoff before it writes a ghost turn', async () => {
	let agent;
	let releaseStandby;
	let startedStandby;
	const standbyStarted = new Promise((resolve) => { startedStandby = resolve; });
	const { service, children, close } = await harness({
		async beforeToolsListed(child) {
			if (children.indexOf(child) === 1) {
				startedStandby();
				await new Promise((resolve) => { releaseStandby = resolve; });
			}
		},
		async onUser(child) {
			if (children.indexOf(child) === 0) {
				usageLine(child, 'interrupt-during-handoff', 85_000);
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'one execution' }, _meta: { 'claudecode/toolUseId': 'toolu_interrupt_handoff' } });
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'interrupted', session_id: 'session-1' });
			}
		},
	}, { contextRotationTokens: 80_000 });
	try {
		agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const first = agent.act('Long turn.', { goalRevision: 0, executeTool: async () => ({ state: 'SUCCEEDED', reasonCode: 'DONE' }) });
		await standbyStarted;
		await agent.interrupt();
		await assert.rejects(first);
		releaseStandby();
		assert.equal(children.filter((child) => child.lines.some((line) => line.type === 'user')).length, 1,
			'the standby never receives the canceled turn handoff');
		assert.equal(children[0].exitCode, null, 'the old session remains current after canceled promotion');
	} finally { releaseStandby?.(); await close(); }
});

test('a failed standby promotion returns the completed tool result to the live session', async () => {
	let executions = 0;
	const { service, children, close } = await harness({
		async beforeToolsListed(child) { if (children.indexOf(child) === 1) child.exit(1); },
		async onUser(child) {
			if (children.indexOf(child) !== 0) return;
			usageLine(child, 'failed-promote', 85_000);
			const response = await child.rpc('tools/call', { name: 'say', arguments: { message: 'already ran' }, _meta: { 'claudecode/toolUseId': 'toolu_failed_promote' } });
			assert.equal(JSON.parse(response.result.content[0].text).reasonCode, 'DONE');
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued on old session', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act('Long turn.', { goalRevision: 0, executeTool: async () => { executions += 1; return { state: 'SUCCEEDED', reasonCode: 'DONE' }; } });
		assert.equal(result.status, 'completed');
		assert.equal(executions, 1);
		assert.equal(children[0].exitCode, null, 'the running process receives the result after standby startup fails');
		assert.equal(children[1].lines.some((line) => line.type === 'user'), false);
	} finally { await close(); }
});

test('a goal change during old-process retirement cannot overwrite the promoted Claude session', async () => {
	let agent;
	let goalChangeStarted = false;
	let releaseGoalChange;
	const goalChanged = new Promise((resolve) => { releaseGoalChange = resolve; });
	const { service, children, close } = await harness({
		async onUser(child, content) {
			if (children.indexOf(child) === 0) {
				usageLine(child, 'before-goal-change', 85_000);
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'one execution' }, _meta: { 'claudecode/toolUseId': 'toolu_goal_change' } });
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'old final', session_id: 'session-1' });
				return;
			}
			await goalChanged;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'next goal complete', session_id: 'session-2' });
		},
	}, { contextRotationTokens: 80_000 }, {
		terminate: async (child) => {
			if (child === children[0] && !goalChangeStarted) {
				goalChangeStarted = true;
				await agent.setGoalRevision(1);
				releaseGoalChange();
			}
			if (child.exitCode === null) child.exit(0);
		},
	});
	try {
		agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const first = agent.act('Old goal.', { goalRevision: 0, executeTool: async () => ({ state: 'SUCCEEDED', reasonCode: 'DONE' }) });
		await assert.rejects(first);
		assert.equal(goalChangeStarted, true, 'the goal changed during the old process retirement window');
		const second = await agent.act('Latest goal.', { goalRevision: 1, executeTool: async () => ({}) });
		assert.equal(second.status, 'completed');
		assert.equal(children.length, 2, 'the second act reuses the promoted process instead of spawning an orphan');
		const replacementInputs = children[1].lines.filter((line) => line.type === 'user').map((line) => line.message.content);
		assert.equal(replacementInputs.length, 2, 'the promoted session contains its handoff and the new goal');
		assert.match(replacementInputs[0], /^Mid-turn continuation/);
		assert.equal(replacementInputs[1], 'Latest goal.');
	} finally { releaseGoalChange(); await close(); }
});

test('Claude rejects a queued tool call from the retired route without executing it', async () => {
	let calls = [];
	let responses = [];
	const { service, children, close } = await harness({
		async onUser(child) {
			if (children.indexOf(child) === 0) {
				usageLine(child, 'parallel-tools', 85_000);
				responses = await Promise.all([
					child.rpc('tools/call', { name: 'say', arguments: { message: 'first' }, _meta: { 'claudecode/toolUseId': 'toolu_first' } }),
					child.rpc('tools/call', { name: 'say', arguments: { message: 'second' }, _meta: { 'claudecode/toolUseId': 'toolu_second' } }),
				]);
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'old process finished', session_id: 'session-1' });
				return;
			}
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act('Long turn.', { goalRevision: 0, executeTool: async ({ tool }) => {
			calls.push(tool.kind);
			await settle(30);
			return { state: 'SUCCEEDED', reasonCode: `RAN_${calls.length}` };
		} });
		assert.equal(result.toolCalls, 1, 'the stale second call is not counted on the replacement route');
		assert.equal(calls.length, 1, 'the stale second call does not execute');
		await waitFor(() => responses.length === 2);
		assert.equal(responses.length, 2);
		assert.ok(responses.every((response) => JSON.parse(response.result.content[0].text).reasonCode === 'SESSION_ROTATED'));
	} finally { await close(); }
});

test('Claude can rotate again during a later long turn', async () => {
	let toolExecutions = 0;
	const { service, children, close } = await harness({
		async onUser(child, content) {
			if (content.startsWith('Mid-turn continuation')) {
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: `session-${children.indexOf(child) + 1}` });
				return;
			}
			usageLine(child, `long-${children.indexOf(child)}-${child.lines.length}`, 85_000);
			await child.rpc('tools/call', { name: 'say', arguments: { message: 'continue' }, _meta: { 'claudecode/toolUseId': `toolu_${children.indexOf(child)}` } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: `session-${children.indexOf(child) + 1}` });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.act('First long turn.', { goalRevision: 0, executeTool: async () => { toolExecutions += 1; return { state: 'SUCCEEDED' }; } });
		await agent.act('Second long turn.', { goalRevision: 0, executeTool: async () => { toolExecutions += 1; return { state: 'SUCCEEDED' }; } });
		assert.equal(toolExecutions, 2);
		assert.equal(children.length, 3, 'the second active turn is allowed its own handoff');
	} finally { await close(); }
});

// A scripted Claude process: each entry is one model call (its context) followed by one tool call; it stops at a handoff.
const scriptedLongTurn = (scripts, { onTool = () => {} } = {}) => ({
	async onUser(child, content) {
		const index = child.scriptIndex ??= scripts.findIndex((_, i) => !scripts.claimed?.has(i));
		(scripts.claimed ??= new Set()).add(index);
		child.received = [...(child.received ?? []), content];
		for (const [step, context] of scripts[index].entries()) {
			usageLine(child, `call-${index}-${step}`, context);
			const response = await child.rpc('tools/call', { name: 'say', arguments: { message: `s${index}-${step}` }, _meta: { 'claudecode/toolUseId': `toolu_${index}_${step}` } });
			onTool(index, step);
			if (JSON.stringify(response).includes('SESSION_ROTATED')) {
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'old process ended', session_id: `session-${index + 1}` });
				return;
			}
		}
		child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: `session-${index + 1}` });
	},
});

test('one long Claude turn repeats funded handoffs, each result reaching the model once', async () => {
	let executions = 0;
	const { service, children, close } = await harness(scriptedLongTurn([
		[50_000, 85_000],
		[40_000, 165_000],
		[40_000, 45_000],
	]), { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act(nativeEvent(2), { goalRevision: 0, executeTool: async () => { executions += 1; return { state: 'SUCCEEDED', reasonCode: `RAN_${executions}` }; } });
		assert.equal(result.status, 'completed');
		assert.equal(executions, 6, 'every game tool runs exactly once');
		assert.equal(children.length, 3, 'the same turn rotated twice');
		for (const [index, reason] of [[1, 'RAN_2'], [2, 'RAN_4']]) {
			const handoff = children[index].received[0];
			assert.match(handoff, /^Mid-turn continuation:/);
			assert.equal((handoff.match(new RegExp(`"reasonCode":"${reason}"`, 'g')) ?? []).length, 1, `${reason} reaches replacement ${index} once`);
		}
	} finally { await close(); }
});

test('a handoff session that starts over the threshold rotates again only after it grows', async () => {
	const { service, children, close } = await harness(scriptedLongTurn([
		[85_000],
		// Even with enough paid reads, a large handoff must grow 20k beyond its first call.
		[170_000, 180_000, 192_000],
		[40_000],
	]), { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.act(nativeEvent(2), { goalRevision: 0, executeTool: async () => ({ state: 'SUCCEEDED' }) });
		assert.equal(children.length, 3);
		assert.equal(children[1].lines.filter((line) => line.type === 'user').length, 1, 'no thrash: the large session was not abandoned at its first boundaries');
	} finally { await close(); }
});

test('a mid-turn handoff keeps the newest turn digests without repeating them and dates an old turn input', async () => {
	const realNow = Date.now;
	let offset = 0;
	Date.now = () => realNow() + offset;
	const { service, children, close } = await harness(scriptedLongTurn([
		[...Array.from({ length: 15 }, () => 30_000), 85_000],
		[40_000],
	], { onTool: (index, step) => { if (index === 0 && step === 14) offset = 45_000; } }), { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.act(nativeEvent(2), { goalRevision: 0, executeTool: async () => ({ state: 'SUCCEEDED' }) });
		assert.equal(children.length, 2);
		const handoff = children[1].received[0];
		assert.doesNotMatch(handoff, /Your most recent tool calls/, 'the turn digests already hold the recent calls');
		const digests = handoff.split('Completed tool calls this turn (one-line digests):\n')[1].split('\n\n')[0].split('\n');
		assert.equal(digests.filter(line => line.startsWith('- say ')).length, 12);
		assert.deepEqual(digests.filter(line => !line.startsWith('- say ')), ['- actionResult -> SUCCEEDED BLOCK_BROKEN (actionId="native:fixture:2")']);
		assert.match(digests.at(-1), /s0-15/, 'the newest completed call is kept');
		assert.match(handoff, /Current turn input to continue \(delivered 4[5-6] s ago; later tool results are newer\):/);
	} finally { Date.now = realNow; await close(); }
});

test('a hung Claude standby times out quickly and is not respawned at each tool boundary', async () => {
	let releaseStandby;
	let calls = 0;
	const keepAlive = setTimeout(() => {}, 20_000);
	const { service, children, close } = await harness({
		async beforeToolsListed(child) {
			if (children.indexOf(child) === 1) await new Promise((resolve) => { releaseStandby = resolve; });
		},
		async onUser(child) {
			for (let index = 0; index < 2; index++) {
				usageLine(child, `hung-${index}`, 85_000);
				calls += 1;
				const started = Date.now();
				await child.rpc('tools/call', { name: 'say', arguments: { message: `boundary-${index}` }, _meta: { 'claudecode/toolUseId': `toolu_hung_${index}` } });
				assert.ok(Date.now() - started < 4_000, 'a hung standby cannot use the full provider startup timeout');
			}
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 80_000, startupTimeoutMs: 5_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act('Two boundaries.', { goalRevision: 0, executeTool: async () => ({ state: 'SUCCEEDED' }) });
		assert.equal(result.toolCalls, 2);
		assert.equal(calls, 2);
		assert.equal(children.length, 2, 'a failed warmup is not retried at the next boundary');
	} finally { clearTimeout(keepAlive); releaseStandby?.(); await close(); }
});

test('Claude books the calls of a retired process that never reports a result, and the replacement result adds to them', async () => {
	let agent;
	const { service, children, close } = await harness({
		async onUser(child) {
			if (children.indexOf(child) === 0) {
				usageLine(child, 'old-process-call', 85_000);
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'one execution' }, _meta: { 'claudecode/toolUseId': 'toolu_usage' } });
				return;
			}
			usageLine(child, 'replacement-process-call', 30_000);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2', total_cost_usd: 0.01, usage: { output_tokens: 5 } });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act('Long turn.', { goalRevision: 0, executeTool: async () => ({ state: 'SUCCEEDED' }) });
		assert.equal(result.usage.calls, 2);
		assert.equal(result.usage.cacheRead, 115_000);
		assert.equal(result.usage.output, 45, 'the new process result adds its five tokens to the retired process forty');
		// 5 input, 85000 read, 200 written and 40 output tokens at the traced price card, plus the reported 0.01.
		assert.equal(Math.round(result.usage.costUsd * 1e5), Math.round((5 * 2e-6 + 85_000 * 0.2e-6 + 200 * 8e-6 + 40 * 20e-6 + 0.01) * 1e5));
	} finally { await close(); }
});

test('Claude books a call that was still streaming when its tool request triggered the handoff', async () => {
	const { service, children, close } = await harness({
		async onUser(child) {
			if (children.indexOf(child) === 0) {
				usageLine(child, 'finished-call', 85_000);
				// The tool request arrives before this call's message_stop, as with a streaming Claude Code.
				child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'open-call', usage: { input_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 100, output_tokens: 1 } } } });
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'once' }, _meta: { 'claudecode/toolUseId': 'toolu_open' } });
				return;
			}
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-2', total_cost_usd: 0.01, usage: { output_tokens: 5 } });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act('Long turn.', { goalRevision: 0, executeTool: async () => ({ state: 'SUCCEEDED' }) });
		assert.equal(result.usage.calls, 2, 'the open call counts as a call');
		assert.equal(result.usage.cacheRead, 175_000);
		const expected = (5 * 2e-6 + 85_000 * 0.2e-6 + 200 * 8e-6 + 40 * 20e-6) + (3 * 2e-6 + 90_000 * 0.2e-6 + 100 * 8e-6 + 1 * 20e-6) + 0.01;
		assert.equal(Math.round(result.usage.costUsd * 1e5), Math.round(expected * 1e5));
	} finally { await close(); }
});

test('Claude stops the replaced process before answering its held request, so it cannot start another model call', async () => {
	let heldRequestAnswered = false;
	let exitedBeforeAnswer = null;
	let terminated = 0;
	const { service, children, close } = await harness({
		async onUser(child) {
			if (children.indexOf(child) === 0) {
				usageLine(child, 'retiring-call', 85_000);
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'once' }, _meta: { 'claudecode/toolUseId': 'toolu_retire' } });
				exitedBeforeAnswer = child.exitCode !== null;
				heldRequestAnswered = true;
				return;
			}
			usageLine(child, 'replacement-call', 30_000);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-2', total_cost_usd: 0.01, usage: { output_tokens: 5 } });
		},
	}, { contextRotationTokens: 80_000 }, {
		terminate: async (child) => {
			if (child === children[0]) terminated += 1;
			if (child.exitCode === null) child.exit(0);
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const result = await agent.act('Long turn.', { goalRevision: 0, executeTool: async () => ({ state: 'SUCCEEDED' }) });
		assert.equal(result.status, 'completed');
		await waitFor(() => heldRequestAnswered);
		assert.equal(terminated, 1, 'the old process is terminated once, immediately');
		assert.equal(exitedBeforeAnswer, true, 'the held request is only released after the old process is gone');
		assert.equal(children[0].lines.filter((line) => line.type === 'user').length, 1, 'the old process never gets another user message');
	} finally { await close(); }
});

test('a warm standby expires even when the turn that warmed it failed', async () => {
	const { service, children, close } = await harness({
		async onUser(child) {
			usageLine(child, 'failing-turn', 85_000);
			await settle(20);
			child.emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 80_000, standbyIdleTimeoutMs: 1_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await assert.rejects(agent.act('Failing long turn.', { goalRevision: 0, executeTool: async () => ({}) }));
		await waitFor(() => children.length === 2);
		assert.equal(children[1].exitCode, null, 'the standby is warm right after the failed turn');
		await waitFor(() => children[1].exitCode !== null);
		assert.notEqual(children[1].exitCode, null, 'an idle standby is not kept for the rest of the process');
	} finally { await close(); }
});

test('rotation still happens when the standby never becomes ready', async () => {
	let releaseStandby;
	const { service, children, close } = await harness({
		async beforeToolsListed(child) {
			if (children.indexOf(child) === 1) await new Promise((resolve) => { releaseStandby = resolve; });
		},
		async onUser(child) {
			usageLine(child, `over-${child.lines.length}`, 90_000);
			await settle(100);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		for (let index = 1; index <= 8; index++) await agent.act(`Turn ${index}`, { goalRevision: 0, executeTool: async () => ({}) });
		await waitFor(() => children[0].exitCode !== null && children[1].exitCode !== null);
		assert.notEqual(children[0].exitCode, null, 'the over-threshold session was replaced');
		assert.notEqual(children[1].exitCode, null, 'the hung standby was stopped, not promoted');
		const restartedInputs = children.slice(2).flatMap((child) => child.lines.filter((line) => line.type === 'user').map((line) => line.message.content));
		assert.match(restartedInputs[0], /^Session refreshed to keep context small/, 'the next turn runs on the fresh session with the carry-over');
	} finally { releaseStandby?.(); await close(); }
});

test('rotation still happens when the shared standby cap leaves this agent without a standby', async () => {
	let releaseBlocker;
	const blockerGate = new Promise((resolve) => { releaseBlocker = resolve; });
	const { service, children, close } = await harness({
		async onUser(child, content) {
			usageLine(child, `over-${child.lines.length}`, 90_000);
			if (content.startsWith('Blocker')) await blockerGate;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 80_000, maxConcurrentStandbys: 1 });
	try {
		const blocker = await service.createAgent(profile({ agentId: 'claude-blocker' }), { controlProtocol: 'native_tools' });
		const other = await service.createAgent(profile({ agentId: 'claude-other' }), { controlProtocol: 'native_tools' });
		const held = blocker.act('Blocker turn that keeps its standby lease.', { goalRevision: 0, executeTool: async () => ({}) });
		await waitFor(() => children.length === 2);
		for (let index = 1; index <= 4; index++) await other.act(`Other turn ${index}`, { goalRevision: 0, executeTool: async () => ({}) });
		await waitFor(() => children.length === 4);
		const otherInputs = children.slice(2).flatMap((child) => child.lines.filter((line) => line.type === 'user').map((line) => line.message.content));
		assert.equal(children.length, 4, 'the capped agent got no standby; it restarted once after its third turn');
		assert.match(otherInputs.at(-1), /^Session refreshed to keep context small[\s\S]*Other turn 4/);
		releaseBlocker();
		await held;
	} finally { releaseBlocker(); await close(); }
});

test('Claude arms rotation carry-over before a slow process stop and consumes it once', async () => {
	let releaseStop;
	let stopStarted;
	const stopGate = new Promise((resolve) => { releaseStop = resolve; });
	const stopping = new Promise((resolve) => { stopStarted = resolve; });
	const { service, children, close } = await harness({
		async onUser(child) {
			usageLine(child, `rotation-${child.lines.length}`, 90_000);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 80_000 }, {
		terminate: async (child) => {
			if (child === children[0]) { stopStarted(); await stopGate; }
			if (child.exitCode === null) child.exit(0);
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		for (let index = 0; index < 3; index++) await agent.act(`Before rotation ${index}`, { goalRevision: 0, executeTool: async () => ({}) });
		await stopping;
		await agent.act('Racing event', { goalRevision: 0, executeTool: async () => ({}) });
		releaseStop();
		await waitFor(() => children[0].exitCode !== null);
		await agent.act('Following event', { goalRevision: 0, executeTool: async () => ({}) });
		const userInputs = children.flatMap((child) => child.lines.filter((line) => line.type === 'user').map((line) => line.message.content));
		assert.match(userInputs.find((text) => text.includes('Racing event')), /^Session refreshed to keep context small/);
		assert.doesNotMatch(userInputs.find((text) => text.includes('Following event')), /earlier turns are not shown/,
			'a completed stop cannot re-arm carry-over already consumed by the racing turn');
	} finally {
		releaseStop();
		await close();
	}
});

test('an unacknowledged interrupt restarts Claude Code without omitted facts from the old session', async () => {
	let answer = true;
	const { service, children, close } = await harness({
		ignoreInterrupt: true,
		async onUser(child) {
			if (answer) child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.act(nativeEvent(1), { goalRevision: 0, executeTool: async () => ({}) });
		answer = false;
		const stuck = agent.act(nativeEvent(2), { goalRevision: 0, executeTool: async () => ({}) });
		void stuck.catch(() => {});
		await waitFor(() => children[0].lines.filter((line) => line.type === 'user').length === 2);
		await agent.interrupt();
		await assert.rejects(stuck);
		answer = true;
		await agent.act(nativeEvent(3), { goalRevision: 0, executeTool: async () => ({}) });
		assert.equal(children.length, 2);
		const content = children[1].lines.find((line) => line.type === 'user').message.content;
		assert.match(content, /^Claude Code restarted/);
		const payload = sentPayload(content).data;
		assert.equal(payload.sameAsPreviousEvent, undefined);
		assert.ok(payload.goalSpec && payload.taskMemory);
	} finally { await close(); }
});

test('a tool result for a settled turn is not committed as an observation baseline', { timeout: 60_000 }, async () => {
	let release;
	let toolStarted;
	const executingTool = new Promise((resolve) => { toolStarted = resolve; });
	let firstView = null;
	let secondView = null;
	const observed = { freshness: { fresh: true }, observation: { world: { worldId: 'w', dimension: 'minecraft:overworld' }, player: { health: 20, x: 1 } } };
	const { service, close } = await harness({
		async onUser(child, content) {
			if (content === 'One.') {
				const response = await child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_1' } });
				firstView = JSON.parse(response.result.content[0].text).observationView;
				return;
			}
			const response = await child.rpc('tools/call', { name: 'observe', arguments: { view: 'changes', afterObservationId: firstView.id }, _meta: { 'claudecode/toolUseId': 'toolu_2' } });
			secondView = JSON.parse(response.result.content[0].text).observationView;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const first = agent.act('One.', { goalRevision: 0, executeTool: () => new Promise((resolve) => { release = () => resolve(observed); toolStarted(); }) });
		void first.catch(() => {});
		await executingTool;
		await agent.interrupt();
		await assert.rejects(first);
		release();
		await waitFor(() => firstView !== null);
		assert.equal(firstView.mode, 'full');
		await agent.act('Two.', { goalRevision: 0, executeTool: async () => observed });
		assert.equal(secondView.mode, 'full', 'a view the model never saw cannot be a changes baseline');
	} finally { await close(); }
});

test('a steer that never reached the model does not become the metadata baseline', async () => {
	const responders = [];
	const { service, children, close } = await harness({
		async onUser(child) { responders.push(() => child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' })); },
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act(nativeEvent(1), { goalRevision: 0, executeTool: async () => ({}) });
		await waitFor(() => responders.length === 1);
		const steer = agent.steer(nativeEvent(2, (wake) => ({ ...wake, taskMemory: { ...wake.taskMemory, revision: 99 } })), { goalRevision: 0 });
		void steer.catch(() => {});
		responders[0]();
		await turn;
		await assert.rejects(steer, (error) => error.code === 'TURN_NOT_ACTIVE');
		const next = agent.act(nativeEvent(3), { goalRevision: 0, executeTool: async () => ({}) });
		await waitFor(() => responders.length === 2);
		responders[1]();
		await next;
		const payload = sentPayload(children[0].lines.filter((line) => line.type === 'user')[1].message.content).data;
		assert.deepEqual(payload.sameAsPreviousEvent, ['situation', 'goal', 'goalSpec', 'taskMemory'], 'compared with the delivered turn, not the rejected steer');
	} finally { await close(); }
});

test('a Claude Code without --include-partial-messages is detected and relaunched without it', async () => {
	const { service, children, close } = await harness({
		rejectPartialMessages: true,
		async onUser(child) {
			child.emitLine({ type: 'assistant', message: { id: 'fallback-call', content: [], usage: { input_tokens: 5, output_tokens: 3 } } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	}, { executable: 'claude-without-partial-messages', startupTimeoutMs: 60_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		// The exit itself fails prewarm; a long startup deadline proves nothing waits for it.
		await assert.rejects(agent.prewarm(), (error) => error.code === 'PROVIDER_UNAVAILABLE');
		const replacement = await service.replaceAgent(profile(), { controlProtocol: 'native_tools' });
		const verbose = [];
		await replacement.act('One.', { goalRevision: 0, onVerbose: (stage, text) => verbose.push([stage, text]), executeTool: async () => ({}) });
		assert.equal(children.at(-1).args.includes('--include-partial-messages'), false);
		assert.ok(children.at(-1).args.includes('stream-json'));
		assert.equal(latestCallUsage(verbose)[0].call.partialMessagesAccepted, false);
	} finally { await close(); }
});

test('Claude context rotation can be disabled', async () => {
	const { service, children, close } = await harness({
		async onUser(child) {
			child.emitLine({ type: 'assistant', message: { id: `msg_${child.lines.length}`, content: [], usage: { input_tokens: 1, cache_read_input_tokens: 150_000, output_tokens: 3 } } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 0 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		for (const text of ['One.', 'Two.', 'Three.', 'Four.']) await agent.act(text, { goalRevision: 0, executeTool: async () => ({}) });
		await settle();
		assert.equal(children.length, 1);
	} finally { await close(); }
});


test('rejected Claude tool calls trace the name and return the validation reason with newer facts', async () => {
 let captured; const verbose = []; let agent;
 const { service, close } = await harness({ async onUser(child) {
  void agent.steer('Landing damage: health 8', { goalRevision: 0 });
  captured = (await child.rpc('tools/call', { name: 'wait', arguments: { durationMs: -1 } })).result;
  child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1' });
 } });
 try {
  agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
  await agent.act('test', { goalRevision: 0, onVerbose: (stage, message) => verbose.push([stage, message]), executeTool: async () => { throw new Error('must not execute'); } });
  const rejected = providerEvents(verbose).find(row => row.event === 'native_tool_rejected');
  assert.equal(rejected.toolName, 'wait'); assert.match(rejected.reason, /durationMs/);
  assert.match(JSON.stringify(captured), /durationMs/); assert.match(JSON.stringify(captured), /Landing damage: health 8/);
 } finally { await close(); }
});

// Review r1 P2-2, with the counters measured live (cancelled call: 2 input, 14,938 cache reads, 1,275 cache writes, 3 output).
test('an interrupted Claude turn is billed to the next turn and itemised as interrupted', async () => {
	let turns = 0;
	const { service, close } = await harness({
		onUser(child) {
			turns += 1;
			if (turns === 1) {
				child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'cancelled', usage: { input_tokens: 2, cache_read_input_tokens: 14_938, cache_creation_input_tokens: 1_275, output_tokens: 3 } } } });
				return;
			}
			child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: `turn-${turns}`, usage: { input_tokens: 2, cache_read_input_tokens: 15_553, cache_creation_input_tokens: 741, output_tokens: 1 } } } });
			child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1', usage: { output_tokens: 14 } });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const first = agent.act('Plan the route.', { goalRevision: 0, executeTool: async () => ({}) });
		await waitFor(() => turns === 1);
		await settle();
		await agent.interrupt();
		await assert.rejects(first, (error) => error.code === 'STALE_PLAN');
		const replacement = await agent.act('Lava.', { goalRevision: 0, executeTool: async () => ({}) });
		assert.deepEqual(replacement.usage.interrupted, { calls: 1, input: 2, cacheRead: 14_938, cacheWrite: 1_275, output: 3, costUsd: null });
		assert.equal(replacement.usage.calls, 2);
		assert.equal(replacement.usage.cacheRead, 14_938 + 15_553);
		assert.equal(replacement.usage.output, 3 + 14, 'the result line counts only the replacement output');
		const later = await agent.act('Later.', { goalRevision: 0, executeTool: async () => ({}) });
		assert.equal(later.usage.interrupted, undefined);
		assert.equal(later.usage.calls, 1);
	} finally { await close(); }
});

// Review r2 P2-3: the interrupted call's closing result reports its real output after the turn was rejected.
test('an interrupted Claude turn carries the output and cost its closing result reports', async () => {
	let turns = 0;
	const { service, children, close } = await harness({
		ignoreInterrupt: true,
		onUser(child) {
			turns += 1;
			if (turns === 1) {
				child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'cancelled', usage: { input_tokens: 20, output_tokens: 3 } } } });
				return;
			}
			child.emitLine({ type: 'assistant', message: { id: 'replacement', content: [], usage: { input_tokens: 30, output_tokens: 1 } } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, usage: { output_tokens: 5 }, total_cost_usd: 0.3 });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const first = agent.act('Plan the route.', { goalRevision: 0, executeTool: async () => ({}) });
		void first.catch(() => {});
		await waitFor(() => turns === 1);
		await settle();
		const interrupt = agent.interrupt();
		await waitFor(() => children[0].lines.some((line) => line.type === 'control_request'));
		children[0].emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: { output_tokens: 40 }, total_cost_usd: 0.1 });
		await interrupt;
		await assert.rejects(first);
		const replacement = await agent.act('Lava.', { goalRevision: 0, executeTool: async () => ({}) });
		assert.deepEqual(replacement.usage.interrupted, { calls: 1, input: 20, cacheRead: 0, cacheWrite: 0, output: 40, costUsd: 0.1 });
		assert.equal(replacement.usage.calls, 2);
		assert.equal(replacement.usage.input, 50);
		assert.equal(replacement.usage.output, 45, '40 billed by the cancelled call plus 5 by the replacement');
		assert.ok(Math.abs(replacement.usage.costUsd - 0.3) < 1e-9);
	} finally { await close(); }
});

test('a replacement that is itself interrupted carries every call and dollar once', async () => {
	let turns = 0;
	const { service, children, close } = await harness({
		ignoreInterrupt: true,
		onUser(child) {
			turns += 1;
			child.emitLine({ type: 'assistant', message: { id: `cost-${turns}`, content: [], usage: { input_tokens: 10 * turns, output_tokens: 3 } } });
			if (turns === 3) child.emitLine({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.6 });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		for (const [index, total] of [[1, 0.1], [2, 0.3]]) {
			const turn = agent.act(`Turn ${index}.`, { goalRevision: 0, executeTool: async () => ({}) });
			void turn.catch(() => {});
			await waitFor(() => turns === index);
			await settle();
			const interrupt = agent.interrupt();
			await settle();
			children[0].emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: total });
			await interrupt;
			await assert.rejects(turn);
		}
		const result = await agent.act('Last.', { goalRevision: 0, executeTool: async () => ({}) });
		assert.deepEqual([result.usage.calls, result.usage.input, result.usage.output], [3, 60, 9]);
		assert.deepEqual([result.usage.interrupted.calls, result.usage.interrupted.input], [2, 30]);
		assert.ok(Math.abs(result.usage.costUsd - 0.6) < 1e-9, 'all three billed costs survive');
	} finally { await close(); }
});

// Review r2 P2-2: an IN_LAVA tool result is the turn's contact; the lava observation after it steers, never cancels.
test('a Claude turn that received an IN_LAVA result is not cancelled by the next lava observation', async () => {
	let response;
	let users = 0;
	const { service, close } = await harness({
		async onUser(child) {
			users += 1;
			if (users !== 1) return;
			response = await child.rpc('tools/call', { name: 'wait', arguments: { durationMs: 1000 }, _meta: { 'claudecode/toolUseId': 'wait-1' } });
		},
	}, { planningTimeoutMs: 20_000 });
	let run;
	try {
		const agent = await service.createAgent(profile({ agentId: 'agent-a' }), { controlProtocol: 'native_tools' });
		await agent.setGoalRevision(1);
		run = await coordinatorWithProviderAgent(agent, 'claude');
		await returnLavaResult(run);
		await waitFor(() => response !== undefined);
		assert.match(JSON.stringify(response), /IN_LAVA/);
		emitLavaObservation(run);
		await waitFor(() => run.planner.interruptions.length > 0 || run.planner.steers.length > 0);
		assert.equal(run.planner.interruptions.length, 0);
	} finally {
		if (run) await run.coordinator.stop();
		await close();
	}
});

test('rotation keeps the newest finished action ID so it can still be replaced, and drops older finished IDs', async () => {
	let call = 0;
	const { service, children, close } = await harness({
		async onUser(child) {
			const userTurns = child.lines.filter((line) => line.type === 'user').length;
			usageLine(child, `msg_${child.lines.length}`, userTurns < 3 ? 70_000 : 90_000);
			if (children.length === 1 && userTurns === 1) {
				await child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_old' } });
				await child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_new' } });
			}
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const run = (sequence) => agent.act(nativeEvent(sequence), { goalRevision: 0,
			executeTool: async () => ({ state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE', actionId: `native:finished-${++call}` }) });
		await run(1); await run(2);
		await waitFor(() => children.length === 2);
		await run(3);
		await waitFor(() => children.length === 2 && children[0].exitCode !== null);
		await run(4);
		const content = children[1].lines.find((line) => line.type === 'user').message.content;
		assert.match(content, /^Session refreshed to keep context small/);
		assert.match(content, /actionId="native:finished-2"/, 'the newest finished action can still be replaced after rotation');
		assert.doesNotMatch(content, /native:finished-1/, 'older finished IDs are not carried');
	} finally { await close(); }
});

test('quality capture retains the first visible model content, including tool-only output', async () => {
	const previous = process.env.ARENA_QUALITY_CAPTURE;
	process.env.ARENA_QUALITY_CAPTURE = '1';
	const { service, close } = await harness({
		async onUser(child) {
			child.emitLine({ type: 'assistant', message: { id: 'first', content: [{ type: 'thinking', thinking: 'private thought' }], usage: {} } });
			child.emitLine({ type: 'assistant', message: { id: 'first', content: [{ type: 'tool_use', name: 'mcp__minecraft__observe', input: { section: 'inventory' } }], usage: {} } });
			child.emitLine({ type: 'assistant', message: { id: 'second', content: [{ type: 'text', text: 'Later message' }], usage: {} } });
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'session-1' });
		},
	});
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const verbose = [];
		await agent.act('Inspect the start.', { goalRevision: 0, onVerbose: (stage, message) => verbose.push([stage, message]), executeTool: async () => ({}) });
		const captures = verbose.filter(([stage]) => stage === 'quality_first_message');
		assert.equal(captures.length, 1);
		assert.equal(JSON.parse(captures[0][1])[0].name, 'mcp__minecraft__observe');
		assert.equal(captures[0][1].includes('private thought'), false);
		assert.equal(captures[0][1].includes('Later message'), false);
	} finally {
		await close();
		if (previous === undefined) delete process.env.ARENA_QUALITY_CAPTURE; else process.env.ARENA_QUALITY_CAPTURE = previous;
	}
});

for (const mode of ['warm', 'cold']) {
	test(`a ${mode} session handoff waits for a running exact cancellation and carries its result`, async () => {
		const executed = [];
		let releaseObserve;
		let releaseCancel;
		const observeGate = new Promise((resolve) => { releaseObserve = resolve; });
		const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
		let continuation = null;
		const { service, children, close } = await harness({
			async onUser(child, content) {
				if (children.indexOf(child) === 0) {
					if (mode === 'warm') usageLine(child, `${mode}-cancel`, 85_000);
					const observe = child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_long_observe' } }).catch(() => null);
					await new Promise((resolve) => setTimeout(resolve, 10));
					const cancel = child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'program-1', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'toolu_late_cancel' } }).catch(() => null);
					await Promise.all([observe, cancel]);
					if (child.exitCode === null) child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'old session', session_id: 'session-1' });
					return;
				}
				continuation ??= content;
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
			},
		}, mode === 'warm' ? { contextRotationTokens: 80_000 } : {});
		try {
			const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
			const turn = agent.act('Stop the program.', { goalRevision: 0, executeTool: async ({ tool, callId }) => {
				executed.push(callId);
				if (tool.kind === 'observe') {
					await observeGate;
					if (mode === 'cold') children[0].exit(1);
					return { state: 'OK' };
				}
				await cancelGate;
				return { state: 'CANCELLED', programId: 'program-1', reasonCode: 'PROGRAM_CANCELLED_MARKER' };
			} });
			await waitFor(() => executed.length === 2);
			releaseObserve();
			await new Promise((resolve) => setTimeout(resolve, 50));
			releaseCancel();
			const result = await turn;
			assert.equal(result.status, 'completed');
			assert.deepEqual(executed, ['toolu_long_observe', 'toolu_late_cancel'], 'each call runs exactly once');
			assert.equal(children.length >= 2, true, 'the turn continued in a replacement session');
			assert.match(continuation ?? '', /toolu_late_cancel/, 'the continuation carries the cancellation result');
			assert.match(continuation, /PROGRAM_CANCELLED_MARKER/);
		} finally { releaseObserve(); releaseCancel(); await close(); }
	});
}

test('an interrupt while an exact cancellation is still running keeps its result for the next turn', async () => {
	const executed = [];
	let releaseCancel;
	const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
	let nextInput = null;
	let agent;
	const { service, close } = await harness({
		async onUser(child, content) {
			if (nextInput === null && !content.includes('Next event.')) {
				const observe = child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_observe_int' } }).catch(() => null);
				const cancel = child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'program-1', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'toolu_cancel_int' } }).catch(() => null);
				await Promise.all([observe, cancel]);
				return;
			}
			nextInput = content;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'next', session_id: 'session-1' });
		},
	});
	try {
		agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const first = agent.act('Stop the program.', { goalRevision: 0, executeTool: async ({ tool, callId }) => {
			executed.push(callId);
			if (tool.kind === 'cancel_program') { await cancelGate; return { state: 'CANCELLED', reasonCode: 'INTERRUPT_CANCEL_MARKER' }; }
			return { state: 'OK' };
		} });
		void first.catch(() => {});
		await waitFor(() => executed.includes('toolu_cancel_int'));
		const interrupting = agent.interrupt();
		releaseCancel();
		await interrupting;
		await assert.rejects(first);
		await agent.act('Next event.', { goalRevision: 0, executeTool: async () => ({}) });
		assert.equal(executed.filter((id) => id === 'toolu_cancel_int').length, 1, 'the cancellation runs once');
		assert.match(nextInput ?? '', /INTERRUPT_CANCEL_MARKER/, 'the next turn learns the cancellation result');
	} finally { releaseCancel(); await close(); }
});

const withinMs = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms))]);

for (const mode of ['warm', 'cold']) {
	test(`a sole exact cancellation at a ${mode} session boundary does not wait on itself`, async () => {
		let continuation = null;
		const { service, children, close } = await harness({
			async onUser(child, content) {
				if (children.indexOf(child) === 0) {
					if (mode === 'warm') usageLine(child, `${mode}-sole`, 85_000);
					await child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'program-sole', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'toolu_sole_cancel' } }).catch(() => null);
					if (child.exitCode === null) child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'old session', session_id: 'session-1' });
					return;
				}
				continuation ??= content;
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
			},
		}, mode === 'warm' ? { contextRotationTokens: 80_000 } : {});
		try {
			const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
			const result = await withinMs(agent.act('Stop it.', { goalRevision: 0, executeTool: async ({ tool }) => {
				if (mode === 'cold' && tool.kind === 'cancel_program') children[0].exit(1);
				return { state: 'CANCELLED', reasonCode: 'SOLE_CANCEL_MARKER' };
			} }), 1_500, 'the turn');
			assert.equal(result.status, 'completed');
			assert.match(continuation ?? '', /SOLE_CANCEL_MARKER/, 'the replacement session receives the cancellation result');
		} finally { await close(); }
	});

	test(`a never-finishing cancellation at a ${mode} boundary cannot block the next turn after an interrupt`, async () => {
		let releaseObserve;
		const observeGate = new Promise((resolve) => { releaseObserve = resolve; });
		const neverCancel = new Promise(() => {});
		const executed = [];
		const { service, children, close } = await harness({
			async onUser(child, content) {
				if (content.includes('Next event.')) {
					child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'next', session_id: 'session-n' });
					return;
				}
				if (children.indexOf(child) !== 0) return;
				if (mode === 'warm') usageLine(child, `${mode}-stuck`, 85_000);
				void child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_stuck_observe' } }).catch(() => null);
				await new Promise((resolve) => setTimeout(resolve, 10));
				void child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'program-stuck', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'toolu_stuck_cancel' } }).catch(() => null);
			},
		}, { ...(mode === 'warm' ? { contextRotationTokens: 80_000 } : {}), planningTimeoutMs: 400 });
		try {
			const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
			const first = agent.act('Stop it.', { goalRevision: 0, executeTool: async ({ tool, callId }) => {
				executed.push(callId);
				if (tool.kind === 'observe') {
					await observeGate;
					if (mode === 'cold') children[0].exit(1);
					return { state: 'OK' };
				}
				return neverCancel;
			} });
			void first.catch(() => {});
			await waitFor(() => executed.length === 2);
			releaseObserve();
			await new Promise((resolve) => setTimeout(resolve, 50));
			await withinMs(agent.interrupt(), 1_500, 'the interrupt');
			await assert.rejects(first);
			const next = await withinMs(agent.act('Next event.', { goalRevision: 0, executeTool: async () => ({}) }), 2_500, 'the next turn');
			assert.equal(next.status, 'completed');
		} finally { releaseObserve(); await close(); }
	});
}

test('an exact cancellation refused during handoff collection carries its exact arguments', async () => {
	let releaseObserve;
	let releaseCancel;
	const observeGate = new Promise((resolve) => { releaseObserve = resolve; });
	const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
	const executed = [];
	let continuation = null;
	let fenced;
	const fencedSeen = new Promise((resolve) => { fenced = resolve; });
	const { service, children, close } = await harness({
		async onUser(child, content) {
			if (children.indexOf(child) === 0) {
				usageLine(child, 'refused-args', 85_000);
				const observe = child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_refused_observe' } }).catch(() => null);
				await new Promise((resolve) => setTimeout(resolve, 10));
				const cancel = child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'program-admitted', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'toolu_admitted' } }).catch(() => null);
				await fencedSeen;
				const refused = await child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'program-distinct-refused-99', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'toolu_refused' } }).catch(() => null);
				assert.match(JSON.stringify(refused), /SESSION_ROTATED/);
				releaseCancel();
				await Promise.all([observe, cancel]);
				return;
			}
			continuation ??= content;
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
		},
	}, { contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Stop it.', { goalRevision: 0, executeTool: async ({ tool, callId }) => {
			executed.push(callId);
			if (tool.kind === 'observe') { await observeGate; return { state: 'OK' }; }
			await cancelGate;
			return { state: 'CANCELLED', reasonCode: 'ADMITTED_CANCEL' };
		} });
		await waitFor(() => executed.length === 2);
		releaseObserve();
		await new Promise((resolve) => setTimeout(resolve, 50));
		fenced();
		const result = await withinMs(turn, 3_000, 'the turn');
		assert.equal(result.status, 'completed');
		assert.deepEqual(executed, ['toolu_refused_observe', 'toolu_admitted'], 'the refused cancellation never runs');
		assert.match(continuation ?? '', /program-distinct-refused-99/, 'the continuation names the refused target so it can be reissued');
	} finally { releaseObserve(); releaseCancel(); await close(); }
});

test('a cold handoff whose control join times out still runs the replacement session without an interrupt', async () => {
	let releaseObserve;
	const observeGate = new Promise((resolve) => { releaseObserve = resolve; });
	const executed = [];
	let continuation = null;
	const { service, children, close } = await harness({
		async onUser(child, content) {
			if (children.indexOf(child) === 0) {
				void child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'original-observe' } }).catch(() => null);
				await new Promise((resolve) => setTimeout(resolve, 10));
				void child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'stuck-program', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'original-cancel' } }).catch(() => null);
				return;
			}
			continuation ??= content;
			await child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'replacement-observe' } }).catch(() => null);
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: 'session-2' });
		},
	}, { planningTimeoutMs: 100 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Stop.', { goalRevision: 0, executeTool: async ({ tool, callId }) => {
			executed.push(callId);
			if (callId === 'replacement-observe') return { state: 'OK' };
			if (tool.kind === 'observe') { await observeGate; children[0].exit(1); return { state: 'OK' }; }
			return new Promise(() => {}); // the old cancellation never finishes
		} });
		void turn.catch(() => {});
		await waitFor(() => executed.length === 2);
		releaseObserve();
		const outcome = await withinMs(turn.then((result) => result, (error) => error), 2_000, 'the recovered turn');
		assert.match(continuation ?? '', /outcome is not confirmed/);
		assert.equal(outcome?.status, 'completed', `the replacement turn completes: ${outcome?.code ?? ''}`);
		assert.ok(executed.includes('replacement-observe'), 'the replacement observe runs despite the stuck old cancellation');
	} finally { releaseObserve(); await close(); }
});

test('a late detached cancellation never retires the replacement session and only reaches carry-over', async () => {
	let releaseObserve;
	let releaseCancel;
	const observeGate = new Promise((resolve) => { releaseObserve = resolve; });
	const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
	const inputs = [];
	const executed = [];
	let cancelReply = null;
	const usage = (child, id, cacheRead) => {
		child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 200, output_tokens: 1 } } } });
		child.emitLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });
		child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
	};
	const { service, children, close } = await harness({
		async onUser(child, content) {
			inputs.push(content);
			const index = children.indexOf(child);
			if (index === 0) {
				void child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'original-observe' } }).catch(() => null);
				await waitFor(() => executed.length === 1);
				cancelReply = child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'old-program', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'old-cancel' } }).catch(() => null);
				return;
			}
			if (index === 1 && inputs.length === 2) {
				await child.rpc('tools/call', { name: 'programStatus', arguments: { programId: 'new-program' }, _meta: { 'claudecode/toolUseId': 'new-status' } });
				usage(child, 'floor', 1_000);
				usage(child, 'large', 85_000);
				await new Promise((resolve) => setTimeout(resolve, 180));
			}
			if (child.exitCode === null) child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: `session-${index}` });
		},
	}, { planningTimeoutMs: 300, contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Stop.', { goalRevision: 0, executeTool: async ({ callId }) => {
			executed.push(callId);
			if (callId === 'original-observe') { await observeGate; children[0].exit(1); return { state: 'OK' }; }
			if (callId === 'old-cancel') { await cancelGate; return { state: 'CANCELLED', programId: 'old-program', reasonCode: 'LATE_OLD_CANCEL_MARKER' }; }
			return { state: 'RUNNING', programId: 'new-program' };
		} });
		void turn.catch(() => {});
		await waitFor(() => executed.length === 2);
		releaseObserve();
		await waitFor(() => inputs.length >= 2);
		await new Promise((resolve) => setTimeout(resolve, 30));
		releaseCancel();
		const result = await withinMs(turn, 3_000, 'the replacement turn');
		await cancelReply;
		assert.equal(result.status, 'completed');
		assert.equal(inputs.length, 2, 'the late cancellation starts no extra continuation');
		assert.equal(children[1].exitCode, null, 'the replacement session stays live');
		await agent.act('Next event.', { goalRevision: 0, executeTool: async () => ({}) });
		const next = inputs.at(-1);
		assert.match(next, /LATE_OLD_CANCEL_MARKER/, 'the late outcome reaches the next turn as carry-over');
		assert.match(next, /retired session/);
		assert.doesNotMatch(next, /Last known program[^\n]*old-program/, 'the late cancel does not replace the current program');
	} finally { releaseObserve(); releaseCancel(); await close(); }
});

const lateUsage = (child, id, cacheRead) => {
	child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 200, output_tokens: 1 } } } });
	child.emitLine({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });
	child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
};

test('a late detached outcome rides on the next mid-turn continuation exactly once', async () => {
	let releaseObserve;
	let releaseCancel;
	const observeGate = new Promise((resolve) => { releaseObserve = resolve; });
	const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
	let cancelSettled;
	const cancelDone = new Promise((resolve) => { cancelSettled = resolve; });
	const inputs = [];
	const executed = [];
	const { service, children, close } = await harness({
		async onUser(child, content) {
			inputs.push(content);
			const index = children.indexOf(child);
			if (index === 0) {
				void child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'original-observe' } }).catch(() => null);
				await waitFor(() => executed.length === 1);
				void child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'old-program', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'old-cancel' } }).catch(() => null).then(cancelSettled);
				return;
			}
			if (index === 1 && inputs.length === 2) {
				await child.rpc('tools/call', { name: 'programStatus', arguments: { programId: 'new-program' }, _meta: { 'claudecode/toolUseId': 'new-status' } });
				lateUsage(child, 'floor', 1_000);
				lateUsage(child, 'large', 85_000);
				await waitFor(() => children.length >= 3);
				releaseCancel();
				await cancelDone;
				await child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'legitimate-boundary' } }).catch(() => null);
			}
			if (child.exitCode === null) child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'continued', session_id: `session-${index}` });
		},
	}, { planningTimeoutMs: 300, contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Stop.', { goalRevision: 0, executeTool: async ({ callId }) => {
			executed.push(callId);
			if (callId === 'original-observe') { await observeGate; children[0].exit(1); return { state: 'OK' }; }
			if (callId === 'old-cancel') { await cancelGate; return { state: 'CANCELLED', programId: 'old-program', reasonCode: 'MIDTURN_LATE_MARKER' }; }
			return callId === 'new-status' ? { state: 'RUNNING', programId: 'new-program' } : { state: 'OK' };
		} });
		void turn.catch(() => {});
		await waitFor(() => executed.length === 2);
		releaseObserve();
		const result = await withinMs(turn, 4_000, 'the turn');
		assert.equal(result.status, 'completed');
		assert.equal(inputs.length, 3, 'only the legitimate boundary adds a continuation');
		assert.match(inputs[2], /MIDTURN_LATE_MARKER/, 'the late outcome reaches the model in that continuation');
		await agent.act('Next event.', { goalRevision: 0, executeTool: async () => ({}) });
		assert.doesNotMatch(inputs.at(-1), /MIDTURN_LATE_MARKER/, 'a delivered late outcome is not repeated');
	} finally { releaseObserve(); releaseCancel(); await close(); }
});

test('a late detached outcome survives an end-of-turn rotation and reaches the next turn', async () => {
	let releaseObserve;
	let releaseCancel;
	let releaseThird;
	const observeGate = new Promise((resolve) => { releaseObserve = resolve; });
	const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
	const thirdGate = new Promise((resolve) => { releaseThird = resolve; });
	const inputs = [];
	const executed = [];
	let cancelReply = null;
	const { service, children, close } = await harness({
		async onUser(child, content) {
			inputs.push(content);
			if (children.indexOf(child) === 0) {
				void child.rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': 'initial' } }).catch(() => null);
				await waitFor(() => executed.length === 1);
				cancelReply = child.rpc('tools/call', { name: 'cancelProgram', arguments: { programId: 'old-program', goalRevision: 0 }, _meta: { 'claudecode/toolUseId': 'old-cancel' } }).catch(() => null);
				return;
			}
			if (inputs.length === 2) {
				await child.rpc('tools/call', { name: 'programStatus', arguments: { programId: 'new-program' }, _meta: { 'claudecode/toolUseId': 'new-status' } });
				lateUsage(child, 'floor', 1_000);
			}
			if (inputs.length === 4) { lateUsage(child, 'large', 85_000); await thirdGate; }
			child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-x' });
		},
	}, { planningTimeoutMs: 300, contextRotationTokens: 80_000 });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		const turn = agent.act('Recover.', { goalRevision: 0, executeTool: async ({ callId }) => {
			executed.push(callId);
			if (callId === 'initial') { await observeGate; children[0].exit(1); return { state: 'OK' }; }
			if (callId === 'old-cancel') { await cancelGate; return { state: 'CANCELLED', programId: 'old-program', reasonCode: 'ROTATION_LATE_MARKER' }; }
			return { state: 'RUNNING', programId: 'new-program' };
		} });
		void turn.catch(() => {});
		await waitFor(() => executed.length === 2);
		releaseObserve();
		await withinMs(turn, 3_000, 'the recovered turn');
		await agent.act('Second recovered turn.', { goalRevision: 0, executeTool: async () => ({}) });
		const third = agent.act('Third recovered turn.', { goalRevision: 0, executeTool: async () => ({}) });
		await waitFor(() => inputs.length === 4 && children.length === 3);
		await new Promise((resolve) => setTimeout(resolve, 30));
		releaseCancel();
		assert.match(JSON.stringify(await cancelReply), /SESSION_ROTATED/);
		releaseThird();
		await withinMs(third, 3_000, 'the third turn');
		await waitFor(() => children[1].exitCode !== null);
		await agent.act('Read historical outcome.', { goalRevision: 0, executeTool: async () => ({}) });
		assert.match(inputs.at(-1), /ROTATION_LATE_MARKER/, 'end-of-turn rotation keeps the undelivered late outcome');
		assert.match(inputs.at(-1), /Last known program[^\n]*new-program/);
		assert.equal(inputs.filter((input) => input.includes('ROTATION_LATE_MARKER')).length, 1, 'delivered once');
	} finally { releaseObserve(); releaseCancel(); releaseThird(); await close(); }
});

test('Claude exposes only queued authored body calls to the current action', async () => {
	const queued = [];
	const { service, close } = await harness({ async onUser(child) {
		await Promise.all([1, 2].map(id => child.rpc('tools/call', { name: 'act', arguments: { actionType: 'look_at', arguments: { x: 1, y: 64, z: 0 } }, _meta: { 'claudecode/toolUseId': `queue-${id}` } })));
		child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'session-1' });
	} });
	try {
		const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.act('Turn and move.', { goalRevision: 0, executeTool: async request => {
			// Wait for admission of the second RPC; local transport can take longer than 10 ms.
			if (queued.length === 0) await waitFor(() => request.hasQueuedBodyAction());
			queued.push(request.hasQueuedBodyAction());
			return { state: 'SUCCEEDED' };
		} });
		assert.deepEqual(queued, [true, false]);
	} finally { await close(); }
});

test('Claude captures every model call, its text, tool calls and the results fed back, only when asked', async () => {
	for (const captureCalls of [true, false]) {
		const { service, close } = await harness({
			async onUser(child) {
				usageLine(child, 'msg_a', 1_000);
				child.emitLine({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'text', text: 'Saying hi.' }, { type: 'tool_use', id: 'toolu_1', name: 'say', input: { message: 'Hi' } }], usage: { input_tokens: 5, output_tokens: 1 } } });
				await child.rpc('tools/call', { name: 'say', arguments: { message: 'Hi' }, _meta: { 'claudecode/toolUseId': 'toolu_1' } });
				usageLine(child, 'msg_b', 1_200);
				child.emitLine({ type: 'assistant', message: { id: 'msg_b', content: [{ type: 'text', text: 'All done.' }], usage: { input_tokens: 5, output_tokens: 1 } } });
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'All done.', session_id: 'session-1', usage: { output_tokens: 80 } });
			},
		});
		try {
			const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
			const result = await agent.act('Goal: greet.', { goalRevision: 0, captureCalls, executeTool: async () => ({ state: 'SUCCEEDED' }) });
			if (!captureCalls) { assert.equal(Object.hasOwn(result, 'nativeCapture'), false); continue; }
			const { calls, input, output, turnId } = result.nativeCapture;
			assert.equal(turnId, '1:1');
			assert.match(input, /Goal: greet\./);
			assert.equal(calls.length, 2);
			assert.equal(calls[0].messageId, 'msg_a');
			assert.equal(calls[0].inputs[0].kind, 'turn_input');
			assert.equal(calls[0].output, 'Saying hi.');
			assert.deepEqual(calls[0].toolCalls.map(({ callId, name, arguments: args }) => [callId, name, JSON.parse(args)]), [['toolu_1', 'say', { message: 'Hi' }]]);
			assert.equal(calls[0].usage.cacheRead, 1_000);
			assert.equal(calls[1].inputs[0].kind, 'tool_result');
			assert.equal(calls[1].inputs[0].callId, 'toolu_1');
			assert.match(calls[1].inputs[0].text, /SUCCEEDED/);
			assert.equal(calls[1].output, 'All done.');
			assert.equal(output, 'Saying hi.\nAll done.');
		} finally { await close(); }
	}
});

for (const mode of ['assistant', 'split_blocks', 'streamed', 'result_only', 'empty']) {
	test(`Claude captures no-tool ${mode} replies, thinking, final content and token counts`, async () => {
		const { service, close } = await harness({
			onUser(child) {
				child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_no_tool', usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 1 } } } });
				if (['assistant', 'split_blocks', 'streamed'].includes(mode)) {
					child.emitLine({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Guard is active.' } } });
					child.emitLine({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: mode === 'assistant' ? 'partial' : 'Waiting.' } } });
				}
				if (mode === 'assistant') child.emitLine({ type: 'assistant', message: { id: 'msg_no_tool', content: [{ type: 'thinking', thinking: 'Guard is active.' }, { type: 'text', text: 'Waiting.' }], usage: { output_tokens: 1 } } });
				if (mode === 'split_blocks') {
					child.emitLine({ type: 'assistant', message: { id: 'msg_no_tool', content: [{ type: 'thinking', thinking: 'Guard is active.' }] } });
					child.emitLine({ type: 'assistant', message: { id: 'msg_no_tool', content: [{ type: 'text', text: 'Waiting.' }] } });
				}
				child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
				child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: mode === 'empty' ? '' : 'Waiting.', session_id: 'session-1', usage: { output_tokens: 1 } });
			},
		});
		try {
			const agent = await service.createAgent(profile(), { controlProtocol: 'native_tools' });
			const result = await agent.act('Urgent danger.', { goalRevision: 0, captureCalls: true, executeTool: async () => assert.fail('no tool calls expected') });
			assert.equal(result.toolCalls, 0);
			assert.equal(result.nativeCapture.output, mode === 'empty' ? '' : 'Waiting.');
			assert.deepEqual(result.nativeCapture.tokens, { input: 1205, output: 1, reasoning: null, cached: 1000, cacheWrite: 200 });
			assert.equal(result.nativeCapture.calls[0].usage.output, 1);
			if (['assistant', 'split_blocks', 'streamed'].includes(mode)) assert.equal(result.nativeCapture.reasoning, 'Guard is active.');
			if (mode === 'split_blocks') assert.equal(result.nativeCapture.finalItems.filter((item) => item.id === 'msg_no_tool').length, 2);
			const final = result.nativeCapture.finalItems.at(-1);
			assert.equal(final.type, 'result');
			assert.equal(JSON.parse(final.content).result, mode === 'empty' ? '' : 'Waiting.');
		} finally { await close(); }
	});
}
