import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, factToWireObservation, eventually, start, resolveNativeSteerInput } from './fixtures/dynamic-main-fixture.mjs';

const running = (actionId = 'native:a:2') => ({ active: true, actionId, actionType: 'move_to' });
const payload = (sequence, health, action, attention = true) => ({
	...factToWireObservation({ player: { health } }, 1, sequence, attention, sequence),
	currentAction: action,
});
const drain = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

async function fixture(t) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const inputs = [];
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	planner.requestNativeTurn = async request => {
		planner.requests.push(request);
		inputs.push(JSON.parse(request.input.slice(request.input.indexOf('\n') + 1)));
		await gate;
		return { status: 'completed', toolCalls: 0 };
	};
	planner.steerNativeTurn = async request => {
		const input = await resolveNativeSteerInput(request);
		inputs.push(JSON.parse(input.slice(input.indexOf('\n') + 1)));
		return { turnId: 'health-test' };
	};
	const run = await start({ registry, planner, config: {
		bridge: { port: 25570, secret: 's'.repeat(32) },
		codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } },
	} });
	t.after(async () => { release(); await run.coordinator.stop(); });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Travel to the destination.' } });
	const emit = value => run.bridge.emit('observation', { agentId: 'agent-a', payload: value });
	emit(payload(536, 10.333, running()));
	await eventually(() => planner.requests.length === 1);
	return { ...run, planner, inputs, emit };
}

for (const [name, staleAction] of [['inactive', { active: false }], ['different handle', running('native:old:1')]]) {
	test(`stale ${name} observation cannot rewind running health`, async t => {
		const run = await fixture(t);
		run.emit(payload(535, 20, staleAction));
		await drain();
		run.emit(payload(537, 7.333, running()));
		await eventually(() => run.inputs.some(input => input.hud?.health === '8/20'));
		assert.equal(run.inputs.at(-1).observation.currentAction.hurtWhileRunning, '11->8');
	});
}

test('accepted quiet snapshots preserve the baseline and reset it when the handle changes', async t => {
	const run = await fixture(t);
	run.emit(payload(537, 10.333, running(), false));
	await drain();
	run.emit(payload(538, 12.333, running('native:new:3'), false));
	await drain();
	run.emit(payload(539, 7.333, running('native:new:3')));
	await eventually(() => run.inputs.some(input => input.hud?.health === '8/20'));
	assert.equal(run.inputs.at(-1).observation.currentAction.hurtWhileRunning, '13->8');
});

test('accepted inspection-only sample starts the running health baseline', async t => {
	const run = await fixture(t);
	run.bridge.automaticInspections = false;
	const request = run.planner.requests[0];
	const sample = request.executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'health-test', callId: 'sample', tool: { kind: 'observe' } });
	await eventually(() => run.bridge.sent.some(message => message.type === 'inspection_request'));
	const inspection = run.bridge.sent.findLast(message => message.type === 'inspection_request');
	const observation = payload(537, 15.333, running('native:sample:3'));
	// A requested sample need not also arrive as a pushed bridge observation.
	run.bridge.replyInspection(inspection, { observation, eventSequence: 537 });
	await sample;
	run.emit(payload(538, 7.333, running('native:sample:3')));
	await eventually(() => run.inputs.some(input => input.hud?.health === '8/20'));
	assert.equal(run.inputs.at(-1).observation.currentAction.hurtWhileRunning, '16->8');
});
