import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, start, eventually } from './fixtures/dynamic-main-fixture.mjs';

test('coordinator traces billed calls from an obsolete goal without updating the current public view', async () => {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), traces = [];
	let request, resolveTurn;
	planner.requestNativeTurn = async value => {
		request = value;
		await new Promise(resolve => { resolveTurn = resolve; });
		return { status: 'completed', toolCalls: 1 };
	};
	const run = await start({ registry, planner, memoryDirectory: null,
		config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } },
		traceWriter: { write: (event, fields) => traces.push({ event, ...fields }) } });
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Survive.' } });
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 1, y: 64, z: 0 } } } });
		await eventually(() => request !== undefined);
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'stop', goalRevision: 2 } });
		await eventually(() => registry.get('agent-a').goalRevision === 2);
		request.onVerbose('live_usage', JSON.stringify({ threadId: 'claude:agent-a:1', inputTokens: 1205,
			cachedInputTokens: 1000, cacheWriteInputTokens: 200, outputTokens: 9, totalTokens: 1214,
			last: { inputTokens: 1205, cachedInputTokens: 1000, cacheWriteInputTokens: 200, outputTokens: 9 },
			call: { provider: 'claude', turnId: '1:1', modelCallId: '1:1:restart', partialMessagesAccepted: true, interrupted: true } }));
		const call = traces.find(row => row.event === 'native_model_call');
		assert.ok(call, 'stale goal billing remains measurable');
		assert.equal(call.goalRevision, 1);
		assert.equal(call.modelCallId, '1:1:restart');
		assert.equal(call.partialMessagesAccepted, true);
		assert.equal(call.interrupted, true);
		const total = traces.find(row => row.event === 'native_token_usage');
		assert.equal(total.inputTokens, 1205);
		assert.equal(total.outputTokens, 9);
		assert.equal(registry.get('agent-a').goalRevision, 2);
	} finally { resolveTurn?.(); await run.coordinator.stop(); }
});

for (const provider of ['claude', 'codex']) test(`${provider} native token traces retain legacy last, interval and per-minute usage after a goal change`, async () => {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), traces = [];
	let request, resolveTurn;
	planner.requestNativeTurn = async value => {
		request = value;
		await new Promise(resolve => { resolveTurn = resolve; });
		return { status: 'completed', toolCalls: 1 };
	};
	const run = await start({ registry, planner, memoryDirectory: null,
		config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } },
		traceWriter: { write: (event, fields) => traces.push({ event, ...fields }) } });
	try {
		const value = (scale, at) => ({ threadId: `${provider}:agent-a:1`, reportedAtEpochMs: at,
			inputTokens: 1205 * scale, cachedInputTokens: 1000 * scale, cacheWriteInputTokens: 200 * scale,
			outputTokens: 9 * scale, reasoningOutputTokens: 2 * scale, totalTokens: 1214 * scale,
			last: { inputTokens: 1205, cachedInputTokens: 1000, cacheWriteInputTokens: 200, outputTokens: 9, reasoningOutputTokens: 2, totalTokens: 1214 } });
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Survive.' } });
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 1, y: 64, z: 0 } } } });
		await eventually(() => request !== undefined);
		request.onVerbose('live_usage', JSON.stringify(value(1, 1000)));
		request.onVerbose('live_usage', JSON.stringify(value(2, 2000)));
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'stop', goalRevision: 2 } });
		await eventually(() => registry.get('agent-a').goalRevision === 2);
		request.onVerbose('live_usage', JSON.stringify(value(3, 3000)));
		request.onVerbose('live_usage', JSON.stringify(value(3, 4000)));
		const rows = traces.filter(row => row.event === 'native_token_usage');
		assert.equal(rows.length, 4);
		for (const row of rows) {
			for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']) assert.equal(row[`last${key[0].toUpperCase()}${key.slice(1)}`], value(1, 0)[key]);
			assert.equal(row.lastUncachedInputTokens, 205);
			assert.equal(row.goalRevision, 1);
		}
		for (const row of rows.slice(1)) {
			assert.equal(row.observedElapsedMs, 1000);
			for (const [key, count] of [['inputTokens', 1205], ['cachedInputTokens', 1000], ['uncachedInputTokens', 205], ['outputTokens', 9]]) {
				assert.equal(row[`interval${key[0].toUpperCase()}${key.slice(1)}`], count);
				assert.equal(row[`${key}PerMinute`], count * 60);
			}
		}
		assert.equal(rows[2].uncachedInputTokens, 615);
		assert.equal(rows[2].usageSource, 'provider');
		assert.equal(traces.some(row => row.event === 'native_model_call'), false, 'Codex-style usage needs no call object');
	} finally { resolveTurn?.(); await run.coordinator.stop(); }
});
