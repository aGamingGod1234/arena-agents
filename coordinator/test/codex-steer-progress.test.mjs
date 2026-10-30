import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexService } from '../src/codex-service.mjs';
import { FakeSharedTransport } from './fixtures/codex-service-fixture.mjs';
import { coordinatorWithProviderAgent } from './fixtures/hazard-provider-fixture.mjs';
import { eventually } from './fixtures/dynamic-main-fixture.mjs';

const tick = () => new Promise(setImmediate);
async function harness(t, executeTool = null) {
	const transport = new FakeSharedTransport();
	transport.autoComplete = false;
	const service = new CodexService({ cwd: process.cwd(), contextRotationTokens: 0 }, { transport });
	t.after(() => service.stop());
	const agent = await service.createAgent({ agentId: 'steering', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' }, { controlProtocol: 'native_tools' });
	const executions = [];
	const turn = agent.act('Continue the task.', { goalRevision: 0, captureCalls: true, executeTool: async request => {
		executions.push(request);
		if (executeTool !== null) return executeTool(request);
		return { state: 'SUCCEEDED' };
	} });
	void turn.catch(() => {});
	await tick();
	const call = (id, tool = 'inspect', args = { section: 'inventory' }) => transport.emit('serverRequest', {
		id, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: id, tool, arguments: args },
	});
	return { transport, agent, turn, call, executions };
}

test('one-token samplings cannot reopen mid-call steering before a model tool decision', async t => {
	const h = await harness(t);
	await h.agent.steer('First danger: burning.');
	let latest = 'health 6'; let builds = 0; let delivered = false;
	const pending = h.agent.steer(() => { builds++; return latest; }).then(result => { delivered = true; return result; });
	await tick();
	for (let i = 0; i < 4; i++) h.transport.emit('notification', { method: 'thread/tokenUsage/updated', params: {
		threadId: 'thread-1', tokenUsage: { total: { inputTokens: 60000 + i * 4000, outputTokens: i + 1 }, last: { inputTokens: 60000 + i * 4000, outputTokens: 1 } },
	} });
	await tick();
	assert.equal(h.transport.calls.filter(c => c.method === 'turn/steer').length, 1);
	assert.equal(builds, 0, 'fresh facts are built at delivery, not while the model is thinking');
	assert.equal(delivered, false);
	assert.equal(h.executions.length, 0, 'steering never authors player actions');
	latest = 'health 3; guard finished; choose your next action';
	h.call('read');
	assert.deepEqual(await pending, { turnId: 'turn-1' });
	const reply = h.transport.calls.find(c => c.method === '$respond' && c.id === 'read');
	assert.match(JSON.stringify(reply.result), /health 3; guard finished/);
	assert.doesNotMatch(JSON.stringify(reply.result), /health 6/);
	assert.equal(builds, 1);
	await h.agent.steer('New danger after a tool result.');
	assert.equal(h.transport.calls.filter(c => c.method === 'turn/steer').length, 2);
	h.transport.complete('thread-1', 'turn-1');
	assert.equal((await h.turn).toolCalls, 1);
});

test('undelivered steering rejects at a no-tool completion so the coordinator can start a fresh turn', async t => {
	const h = await harness(t);
	h.transport.message = '';
	await h.agent.steer('First danger.');
	const pending = assert.rejects(h.agent.steer('Latest danger.'), error => error.code === 'TURN_NOT_ACTIVE');
	await tick();
	h.transport.complete('thread-1', 'turn-1');
	assert.equal((await h.turn).toolCalls, 0);
	await pending;
	assert.equal(h.transport.calls.filter(c => c.method === 'turn/steer').length, 1);
	assert.equal(h.executions.length, 0);
});

test('a queued steer is retired on interruption and cannot leak into a successor', async t => {
	const h = await harness(t);
	await h.agent.steer('First danger.');
	const pending = assert.rejects(h.agent.steer('Old goal facts.'), error => error.code === 'TURN_NOT_ACTIVE');
	const interrupted = assert.rejects(h.turn, error => error.code === 'STALE_PLAN');
	await tick();
	await h.agent.interrupt();
	await interrupted; await pending;
	const successor = h.agent.act('New goal facts.', { goalRevision: 0, executeTool: async () => ({}) });
	await tick();
	await h.agent.steer('Fresh danger.');
	h.transport.complete('thread-1', 'turn-2');
	await successor;
	assert.equal(h.transport.calls.filter(c => c.method === 'turn/steer').length, 2);
});

test('parallel read results deliver a coalesced update once and acknowledge every waiter', async t => {
	const h = await harness(t);
	await h.agent.steer('First danger.');
	const first = h.agent.steer('Older feedback.');
	const latest = h.agent.steer('Latest feedback.');
	await tick();
	h.call('read-a'); h.call('read-b');
	await Promise.all([first, latest]);
	await tick();
	const replies = h.transport.calls.filter(c => c.method === '$respond');
	assert.equal(replies.filter(c => JSON.stringify(c.result).includes('Latest feedback.')).length, 1);
	assert.equal(replies.some(c => JSON.stringify(c.result).includes('Older feedback.')), false);
	h.transport.complete('thread-1', 'turn-1');
	assert.equal((await h.turn).toolCalls, 2);
});

test('new body feedback supersedes a deferred model update without losing its acknowledgement', async t => {
	let release;
	const body = new Promise(resolve => { release = resolve; });
	const h = await harness(t, async () => { await body; return { state: 'SUCCEEDED' }; });
	t.after(release);
	await h.agent.steer('First danger.');
	const earlier = h.agent.steer('Older inference feedback.');
	await tick(); h.call('body', 'wait', { durationMs: 1000 }); await tick();
	let interruptions = 0;
	const latest = h.agent.steer('Latest body feedback.', { onInterrupt: () => { interruptions++; release(); } });
	await Promise.all([earlier, latest]);
	const reply = h.transport.calls.find(c => c.method === '$respond' && c.id === 'body');
	assert.match(JSON.stringify(reply.result), /Latest body feedback/);
	assert.doesNotMatch(JSON.stringify(reply.result), /Older inference feedback/);
	assert.equal(interruptions, 1);
	h.transport.complete('thread-1', 'turn-1'); await h.turn;
});

test('interruption retires an update while its fresh-fact builder is still pending', async t => {
	const h = await harness(t);
	await h.agent.steer('First danger.');
	let release;
	const facts = new Promise(resolve => { release = resolve; });
	const pending = assert.rejects(h.agent.steer(() => facts), error => error.code === 'TURN_NOT_ACTIVE');
	const interrupted = assert.rejects(h.turn, error => error.code === 'STALE_PLAN');
	await tick(); h.call('read'); await tick();
	await h.agent.interrupt(); await interrupted; await pending;
	release('Stale feedback.'); await tick();
	assert.equal(h.transport.calls.some(c => c.method === '$respond'), false);
});

test('transport failure rejects steering claimed by a read result', async t => {
	const h = await harness(t);
	await h.agent.steer('First danger.');
	const pending = assert.rejects(h.agent.steer('Latest feedback.'), error => error.code === 'TOOL_RESPONSE_DELIVERY_FAILED');
	const failed = assert.rejects(h.turn, error => error.code === 'TOOL_RESPONSE_DELIVERY_FAILED');
	await tick(); h.transport.rejectRespond = true; h.call('read');
	await pending; await failed;
});

test('a failed mid-call steer leaves the next update deliverable immediately', async t => {
	const h = await harness(t);
	const request = h.transport.request.bind(h.transport);
	let reject = true;
	h.transport.request = async (...args) => {
		if (args[0] === 'turn/steer' && reject) { reject = false; throw Object.assign(new Error('rejected'), { code: 'RPC_ERROR' }); }
		return request(...args);
	};
	await assert.rejects(h.agent.steer('Rejected danger.'), error => error.code === 'RPC_ERROR');
	await h.agent.steer('Accepted danger.');
	assert.equal(h.transport.calls.filter(c => c.method === 'turn/steer').length, 1);
	h.transport.complete('thread-1', 'turn-1'); await h.turn;
});

test('the coordinator reissues undelivered drowning facts after a no-tool turn ends', async t => {
	const transport = new FakeSharedTransport(); transport.autoComplete = false;
	transport.message = '';
	const service = new CodexService({ cwd: process.cwd(), contextRotationTokens: 0 }, { transport });
	t.after(() => service.stop());
	const agent = await service.createAgent({ agentId: 'agent-a', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' }, { controlProtocol: 'native_tools' });
	await agent.setGoalRevision(1);
	const run = await coordinatorWithProviderAgent(agent, 'codex');
	t.after(() => run.coordinator.stop());
	await eventually(() => transport.calls.some(c => c.method === 'turn/start'));
	await tick();
	await agent.steer('First danger.');
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 2, attention: true, changedFacts: ['player.air'], observation: {
		player: { x: 0, y: 60, z: 0, health: 20, inWater: true, underWater: true, air: 40, maxAir: 300 },
	} } });
	await eventually(() => run.planner.steers.length > 0);
	await tick();
	assert.equal(transport.calls.filter(c => c.method === 'turn/steer').length, 1);
	transport.complete('thread-1', 'turn-1');
	await eventually(() => transport.calls.filter(c => c.method === 'turn/start').length === 2);
	assert.match(transport.calls.filter(c => c.method === 'turn/start')[1].params.input[0].text, /drowning|air/i);
	assert.equal(run.bridge.sent.filter(c => c.type === 'action_command').length, 0);
	transport.complete('thread-1', 'turn-2');
});
