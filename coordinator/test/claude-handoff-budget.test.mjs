import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, profile } from './fixtures/claude-service-fixture.mjs';

test('real MCP boundary defers an expensive reset, then books replacement write surprise as debt', async () => {
	const verbose = [];
	const usage = (child, id, read, write) => {
		child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: write } } } });
		child.emitLine({ type: 'stream_event', event: { type: 'message_stop' } });
	};
	const done = child => child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fixture' });
	const h = await harness({ async onUser(child) {
		if (h.children.indexOf(child) > 0) {
			usage(child, 'replacement', 17_330, 60_000);
			done(child);
			return;
		}
		for (let i = 0; i < 30; i++) {
			usage(child, `read-${i}`, 100_000, 30_000);
			const reply = await child.rpc('tools/call', { name: 'capabilities', arguments: { section: 'control' } });
			if (JSON.stringify(reply).includes('SESSION_ROTATED')) { done(child); return; }
		}
		done(child);
	} });
	try {
		const agent = await h.service.createAgent(profile(), { controlProtocol: 'native_tools' });
		await agent.act('Continue exploring.', { goalRevision: 0, executeTool: async () => ({ tools: [] }),
			onVerbose: (stage, text) => verbose.push([stage, text]) });
		const calls = verbose.filter(([stage]) => stage === 'live_usage').map(([, text]) => JSON.parse(text).call);
		const fundedCalls = calls.filter(call => call.rotations === 0).length;
		assert.ok(fundedCalls >= 13 && fundedCalls <= 30, `rotation after ${fundedCalls} calls; size alone cannot pay the $0.24 write`);
		const last = calls.at(-1).handoffBudget;
		assert.ok(last.unsettledDebtUsd > 0.20, 'unexpected cache creation is charged before another reset');
		assert.ok(Math.abs(last.totalElectiveWriteUsd - 0.480004) < 1e-9);
		for (const { handoffBudget: state } of calls) assert.ok(state.totalElectiveWriteUsd <= state.totalReadUsd + state.unsettledDebtUsd + 1e-9);
	} finally { await h.close(); }
});
