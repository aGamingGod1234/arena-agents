import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start, resolveNativeSteerInput } from './fixtures/dynamic-main-fixture.mjs';

// Decision boundaries the model did not cause: a program event that reaches a turn which is still making tool calls rides
// on its next tool result instead of starting another turn after it, and routine perception queued behind a turn that
// left a program running belongs to that program.

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const OVERWORLD = 'minecraft:overworld';
const NETHER = 'minecraft:the_nether';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function observation(sequence, { dimension = OVERWORLD, attention = true, changedFacts = ['blocks'] } = {}) {
	return { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence, attention, observedAtEpochMs: sequence, changedFacts,
		observation: { player: { x: sequence % 7, y: 64, z: 0, health: 20 }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} },
			world: { dimension, gameTime: 1_000 + sequence, dayTime: 1_000 + sequence, raining: false, thundering: false } } } };
}

/** The first turn stays open (making tool calls) until released; `during` runs inside it. Later turns end at once. */
async function coordinator(during) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	const steers = [];
	let release;
	const open = new Promise((resolve) => { release = resolve; });
	planner.steerNativeTurn = async (request) => { await resolveNativeSteerInput(request); steers.push(request); };
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		if (planner.requests.length > 1) return { toolCalls: 0 };
		const call = (callId, tool) => request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId, tool });
		await during({ call });
		await open;
		return { toolCalls: 2 };
	};
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: CONFIG });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Gather wood.' } });
	run.bridge.emit('observation', observation(1));
	await eventually(() => planner.requests.length === 1);
	const commands = () => run.bridge.sent.filter((message) => message.type === 'action_command');
	const endTurn = async () => {
		release();
		await eventually(() => rows.some(({ event }) => event === 'native_turn_completed'));
		await tick(); await tick();
	};
	return { run, planner, rows, steers, commands, endTurn };
}

const program = (policy, body) => ({ kind: 'run_program', background: true, timeoutMs: 30_000, source: `program.onUnhandledAttention("${policy}"); ${body}` });

test('a running routine\'s ordinary decision reaches a turn still making tool calls as a steer, not a new turn', async () => {
	const { run, planner, steers, commands, endTurn } = await coordinator(async ({ call }) => {
		await call('c1', program('continue_and_notify', 'await player.wait(20000);'));
	});
	try {
		await eventually(() => commands().length === 1);
		// A portal crossing always notifies past the ordinary window; the authored routine keeps running.
		run.bridge.emit('observation', observation(2, { dimension: NETHER, changedFacts: ['world.dimension'] }));
		await eventually(() => steers.length === 1);
		assert.match(steers[0].input, /program_attention/);
		assert.equal(planner.requests.length, 1, 'delivery does not preempt the active model turn');
		await endTurn();
		assert.equal(planner.requests.length, 2, 'ending without answering gets one concrete reminder');
		assert.match(planner.requests[1].input, /Call respondProgram before ending this turn/);
		assert.equal(run.bridge.sent.some((message) => message.type === 'action_cancel'), false, 'the routine keeps running');
	} finally { await run.coordinator.stop(); }
});

test('a decision that paused the body reaches the next model boundary without waiting for turn end', async () => {
	const { run, planner, steers, commands, endTurn } = await coordinator(async ({ call }) => {
		await call('c1', program('pause_and_notify', 'await player.wait(20000);'));
	});
	try {
		await eventually(() => commands().length === 1);
		run.bridge.emit('observation', observation(2, { dimension: NETHER, changedFacts: ['world.dimension'] }));
		await eventually(() => run.bridge.sent.some((message) => message.type === 'action_cancel'));
		await eventually(() => steers.some((request) => /program_attention/.test(request.input)));
		assert.equal(planner.requests.length, 1, 'the current model turn owns the decision first');
		await endTurn();
		assert.equal(planner.requests.length, 2, 'the paused body cannot suppress an unanswered-decision reminder');
	} finally { await run.coordinator.stop(); }
});

for (const state of ['SUCCEEDED', 'FAILED']) test(`a program ending with ${state} is reported inside its running turn`, async () => {
	const { run, planner, steers, commands, endTurn } = await coordinator(async ({ call }) => {
		await call('c1', program('continue_and_notify', 'await player.wait(5);'));
	});
	try {
		await eventually(() => commands().length === 1);
		const command = commands()[0];
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state,
			reasonCode: state === 'SUCCEEDED' ? 'WAIT_DONE' : 'ACTION_FAILED', actionType: 'wait', eventSequence: run.bridge.latestSequences.get('agent-a') + 1 } });
		await eventually(() => steers.length === 1);
		assert.match(steers[0].input, /program_ended/);
		if (state === 'FAILED') assert.match(steers[0].input, /ACTION_FAILED/);
		await endTurn();
		assert.equal(planner.requests.length, 1, 'the ended program was already reported');
	} finally { await run.coordinator.stop(); }
});

test('a program end rejected by a closing provider turn gets a new turn', async () => {
	const { run, planner, rows, commands, endTurn } = await coordinator(async ({ call }) => {
		await call('c1', program('continue_and_notify', 'await player.wait(5);'));
	});
	try {
		planner.steerNativeTurn = async () => { throw Object.assign(new Error('Turn closed'), { code: 'TURN_NOT_ACTIVE' }); };
		await eventually(() => commands().length === 1);
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: commands()[0].payload.actionId,
			state: 'SUCCEEDED', reasonCode: 'WAIT_DONE', actionType: 'wait', eventSequence: run.bridge.latestSequences.get('agent-a') + 1 } });
		await eventually(() => rows.some(({ event }) => event === 'native_turn_steer_deferred'));
		await endTurn();
		await eventually(() => planner.requests.length === 2);
		assert.match(planner.requests[1].input, /program_ended/);
	} finally { await run.coordinator.stop(); }
});

test('a merged program failure survives rejection of an earlier in-turn notice', async () => {
	let execute;
	const { run, planner, rows, commands, endTurn } = await coordinator(async ({ call }) => {
		execute = call;
		await call('c1', program('continue_and_notify', 'await player.wait(5);'));
	});
	let deliver;
	const delivery = new Promise((resolve) => { deliver = resolve; });
	let steering = false;
	try {
		planner.steerNativeTurn = async (request) => {
			steering = true;
			await delivery;
			await resolveNativeSteerInput(request);
			throw Object.assign(new Error('Turn closed'), { code: 'TURN_NOT_ACTIVE' });
		};
		await eventually(() => commands().length === 1);
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: commands()[0].payload.actionId,
			state: 'SUCCEEDED', reasonCode: 'WAIT_DONE', actionType: 'wait', eventSequence: run.bridge.latestSequences.get('agent-a') + 1 } });
		await eventually(() => steering);
		await execute('c2', program('continue_and_notify', 'await player.wait(5);'));
		await eventually(() => commands().length === 2);
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: commands()[1].payload.actionId,
			state: 'FAILED', reasonCode: 'ACTION_FAILED', actionType: 'wait', eventSequence: run.bridge.latestSequences.get('agent-a') + 1 } });
		await eventually(() => rows.filter(({ event, eventName, mode }) => event === 'native_event_ready' && eventName === 'program_ended' && mode === 'steer').length === 2);
		deliver();
		await eventually(() => rows.some(({ event }) => event === 'native_turn_steer_deferred'));
		await endTurn();
		await eventually(() => planner.requests.length === 2);
		assert.match(planner.requests[1].input, /program_ended/);
		assert.match(planner.requests[1].input, /ACTION_FAILED/);
	} finally { deliver(); await run.coordinator.stop(); }
});

for (const startsProgram of [true, false]) {
	test(`routine perception queued in a turn that ${startsProgram ? 'leaves a program running is left to it' : 'leaves the body idle still wakes the model'}`, async () => {
		let proceed;
		const sampled = new Promise((resolve) => { proceed = resolve; });
		const { run, planner, rows, endTurn } = await coordinator(async ({ call }) => {
			await sampled;
			if (startsProgram) await call('c1', program('continue_and_notify', 'await player.wait(20000);'));
		});
		try {
			// The model is still deciding: this sample queues behind the turn.
			run.bridge.emit('observation', observation(2, { changedFacts: ['entities'] }));
			await eventually(() => rows.some(({ event, mode }) => event === 'native_event_ready' && mode === 'pending'));
			proceed();
			await endTurn();
			if (startsProgram) {
				assert.equal(planner.requests.length, 1, 'the program owns ordinary progress');
				assert.ok(rows.some(({ event }) => event === 'native_wake_left_to_program'));
			} else {
				await eventually(() => planner.requests.length === 2);
			}
		} finally { proceed(); await run.coordinator.stop(); }
	});
}
