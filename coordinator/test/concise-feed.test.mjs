import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { withCompletionContract } from './fixtures/completion-contract.mjs';
import { FakePlanner, SOURCE, eventually, factToWireObservation, start } from './fixtures/dynamic-main-fixture.mjs';

const feed = run => run.bridge.sent.filter(message => message.type === 'verbose_event' && message.payload.stage === 'decision').map(message => message.payload.message);
function wake(run) {
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Collect iron.' } });
	const observation = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 } }, 1, 1, false, 1);
	observation.world.worldId = 'concise-feed-world';
	run.bridge.emit('observation', { agentId: 'agent-a', payload: observation });
}

test('concise feed sends accepted model summaries with verbose off and ignores provider fragments', async () => {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry);
	planner.requestPlan = async request => {
		request.onVerbose('output', 'raw provider output');
		return withCompletionContract({ summary: 'Heading south for exposed iron.', directive: 'replace', source: SOURCE }, request.goalRevision);
	};
	const run = await start({ registry, planner });
	try {
		wake(run);
		await eventually(() => feed(run).length === 1);
		assert.deepEqual(feed(run), ['Heading south for exposed iron.']);
		assert.equal(run.bridge.sent.some(message => message.type === 'verbose_event' && message.payload.stage !== 'decision'), false);
	} finally { await run.coordinator.stop(); }
});

test('native concise feed publishes authored intent and reason once per change, using the model plan label', async () => {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry);
	let finished = false;
	planner.requestNativeTurn = async request => {
		request.onVerbose('agent_message', 'Getting ready to search for iron.');
		request.onVerbose('agent_message', 'duplicate provider event');
		const execute = (callId, tool) => request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'feed-turn', callId, tool });
		await execute('plan', { kind: 'task_plan', operation: 'replace', plan: { steps: [
			{ id: 'iron', label: 'Gather exposed iron', kind: 'milestone', status: 'active', dependsOn: [], detail: '', evidence: null },
		] } });
		for (const callId of ['intent-1', 'intent-repeat']) {
			const result = await execute(callId, { kind: 'task_plan', operation: 'intent', intent: { step: 'iron', why: 'The cave south has visible ore' } });
			assert.equal(result.state, 'SUCCEEDED');
		}
		await execute('intent-changed', { kind: 'task_plan', operation: 'intent', intent: { step: 'Return for food', why: 'Hunger is low' } });
		finished = true;
		return { status: 'completed', toolCalls: 4 };
	};
	const run = await start({ registry, planner, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try {
		wake(run);
		await eventually(() => finished);
		assert.deepEqual(feed(run), [
			'Getting ready to search for iron.',
			'Gather exposed iron: The cave south has visible ore',
			'Return for food: Hunger is low',
		]);
	} finally { await run.coordinator.stop(); }
});

test('native concise feed keeps private tool JSON out of chat with verbose off', async () => {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry);
	let finished = false;
	planner.requestNativeTurn = async request => {
		request.onVerbose('agent_message', '{"tool":"move_to","arguments":{"x":1}}');
		request.onVerbose('agent_message', 'Taking the east entrance.');
		finished = true;
		return { status: 'completed', toolCalls: 0 };
	};
	const run = await start({ registry, planner, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try {
		wake(run);
		await eventually(() => finished);
		assert.deepEqual(feed(run), ['Taking the east entrance.']);
	} finally { await run.coordinator.stop(); }
});
