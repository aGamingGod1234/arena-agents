import { compactEventInstruction } from '../src/dynamic-main.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry, DynamicAgentState } from '../src/agent-registry.mjs';
import { NO_TASK_DANGER_INSTRUCTION } from '../src/dynamic-main.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { DeferredCompletionBridge, FakeBridge, FakePlanner, RecordingGoalSupervisor, record, immutableGoalSpec, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

// The play-test: the model called finish while mobs arrived (awaiting operator confirmation), its next two
// fight attempts never reached Minecraft, and the body stood idle ~20 s. A finished task must never leave the
// agent unable to defend itself, in the same turn or later ones.
const NATIVE_CONFIG = {
	bridge: { port: 25570, secret: 's'.repeat(32) },
	codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } },
};
const ZOMBIE = '00000000-0000-0000-0000-0000000000a1';
const FIGHT = normalizeMinecraftToolCall('act', { actionType: 'fight_target', arguments: { targetId: ZOMBIE, timeoutMs: 15_000 } });
const FINISH = { kind: 'finish', summary: 'Armor equipped.' };
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

function scriptedPlanner(registry, turns) {
	const planner = new FakePlanner(registry);
	planner.outcomes = [];
	planner.steerNativeTurn = async () => {};
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		const turn = planner.requests.length;
		let calls = 0;
		for (const [index, step] of (turns[turn - 1] ?? []).entries()) {
			if (typeof step === 'function') { await step(); continue; }
			calls += 1;
			const outcome = await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: `turn-${turn}`, callId: `call-${turn}-${index}`, tool: step })
				.then((result) => ({ turn, tool: step.kind, result }), (error) => ({ turn, tool: step.kind, error }));
			planner.outcomes.push(outcome);
		}
		return { status: 'completed', toolCalls: calls };
	};
	return planner;
}

async function launch(bridge, turns, predicate = { type: 'operator_confirmed' }, dependencies = {}) {
	const registry = new AgentRegistry();
	const planner = scriptedPlanner(registry, turns);
	const traces = [];
	const run = await start({ bridge, registry, planner, config: NATIVE_CONFIG, traceWriter: { write(event, details) { traces.push({ event, ...details }); } }, ...dependencies });
	bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Equip netherite armor.', goalSpec: immutableGoalSpec('Equip netherite armor.', predicate) } });
	bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 0, y: 64, z: 0 } } } });
	return { registry, planner, traces, run };
}

function awaitConfirmation(bridge, facts = [{ type: 'operator_confirmed', satisfied: false }]) {
	const completion = bridge.sent.find(({ type }) => type === 'goal_completed');
	bridge.emit('goal_completion_result', { agentId: 'agent-a', payload: {
		goalRevision: 1, traceId: completion.payload.traceId, goalFingerprint: completion.payload.goalFingerprint,
		verified: false, reasonCode: 'PREDICATE_FAILED', facts,
	} });
}

const fights = (bridge) => bridge.sent.filter(({ type, payload }) => type === 'action_command' && payload.actionType === 'fight_target');

function resolveFight(bridge, command) {
	bridge.emit('action_result', { agentId: 'agent-a', payload: {
		goalRevision: command.payload.goalRevision, actionId: command.payload.actionId, actionType: 'fight_target', state: 'SUCCEEDED',
		reasonCode: 'TARGET_KILLED', executionStarted: true, eventSequence: 50,
	} });
}

const hurt = (goalRevision, eventSequence, health) => ({ agentId: 'agent-a', payload: {
	goalRevision, eventSequence, attention: true, changedFacts: ['player.health'], observation: { player: { x: 0, y: 64, z: 0, health } },
} });

test('awaiting confirmation: fight_target right after finish in the same turn reaches Minecraft (the play-test idle)', async () => {
	const bridge = new DeferredCompletionBridge();
	const { planner, traces, run } = await launch(bridge, [[FINISH, FIGHT]]);
	try {
		await eventually(() => bridge.sent.some(({ type }) => type === 'goal_completed'));
		awaitConfirmation(bridge);
		await eventually(() => fights(bridge).length === 1);
		assert.equal(planner.outcomes[0].result.state, 'AWAITING_OPERATOR_CONFIRMATION');
		resolveFight(bridge, fights(bridge)[0]);
		await eventually(() => planner.outcomes.length === 2);
		assert.equal(planner.outcomes[1].result?.state, 'SUCCEEDED', 'the fight is not refused for want of a goal work lease');
		assert.equal(traces.filter((row) => row.event === 'native_tool_rejected').length, 0);
		await settle();
		assert.equal(planner.requests.length, 1, 'defending does not reopen the finished goal: no supervisor wake to redo it');
	} finally {
		await run.coordinator.stop();
	}
});

test('awaiting confirmation: danger after the finishing turn wakes the model and its fight dispatches', async () => {
	const bridge = new DeferredCompletionBridge();
	const { planner, run } = await launch(bridge, [[FINISH], [FIGHT]]);
	try {
		await eventually(() => bridge.sent.some(({ type }) => type === 'goal_completed'));
		awaitConfirmation(bridge);
		await eventually(() => planner.outcomes.length === 1);
		await settle();
		bridge.emit('observation', hurt(1, 2, 17));
		await eventually(() => fights(bridge).length === 1);
		assert.equal(planner.requests.length, 2);
		resolveFight(bridge, fights(bridge)[0]);
		await eventually(() => planner.outcomes.length === 2);
		assert.equal(planner.outcomes[1].result?.state, 'SUCCEEDED');
	} finally {
		await run.coordinator.stop();
	}
});

test('a completed task: danger wakes a no-task turn that may defend itself; ordinary sightings do not', async () => {
	const bridge = new FakeBridge();
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const { registry, planner, traces, run } = await launch(bridge, [[FINISH, () => gate, FIGHT], [FIGHT, FINISH]]);
	try {
		await eventually(() => planner.outcomes.length === 1);
		assert.equal(planner.outcomes[0].result.state, 'COMPLETED');
		// Minecraft's satisfyGoal bumps the revision and reports the goal complete.
		bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'complete', goalRevision: 2 } });
		await eventually(() => registry.get('agent-a').state === DynamicAgentState.COMPLETED && registry.get('agent-a').goalRevision === 2);
		release();
		await eventually(() => planner.outcomes.length === 2);
		assert.equal(planner.outcomes[1].result.reasonCode, 'STALE_PLAN');
		assert.match(planner.outcomes[1].result.message, /task is complete[\s\S]*wake you again at once; then you may fight, flee/);
		const rejected = traces.filter((row) => row.event === 'native_tool_rejected');
		assert.deepEqual(rejected.map(({ toolKind, actionType, reasonCode }) => ({ toolKind, actionType, reasonCode })),
			[{ toolKind: 'action', actionType: 'fight_target', reasonCode: 'STALE_PLAN' }], 'the undispatched call is visible in the trace');
		assert.ok(rejected.every((row) => !Object.hasOwn(row, 'arguments') && !Object.hasOwn(row, 'message')), 'no payload text is traced');

		bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 2, eventSequence: 2, observation: { player: { x: 0, y: 64, z: 0 } } } });
		await settle();
		assert.equal(planner.requests.length, 1, 'an ordinary sighting never restarts a finished task');

		bridge.emit('observation', hurt(2, 3, 15));
		await eventually(() => fights(bridge).length === 1);
		assert.equal(planner.requests.length, 2);
		assert.equal(planner.requests[1].input.split('\n')[0], compactEventInstruction(NO_TASK_DANGER_INSTRUCTION));
		assert.equal(fights(bridge)[0].payload.goalRevision, 2, 'the fight runs at the completed revision, without a new task');
		resolveFight(bridge, fights(bridge)[0]);
		await eventually(() => planner.outcomes.length === 4);
		assert.equal(planner.outcomes[2].result?.state, 'SUCCEEDED');
		assert.equal(planner.outcomes[3].error?.code, 'CONVERSATION_ONLY', 'with no task there is nothing to finish again');
		assert.match(planner.outcomes[3].error.message, /only look after yourself/);
		assert.equal(registry.get('agent-a').state, DynamicAgentState.COMPLETED, 'defending never reopens the finished task');
		await settle();
		assert.equal(planner.requests.length, 2, 'a danger turn needs no chat reply and is not retried');
	} finally {
		await run.coordinator.stop();
	}
});

const BREAK = normalizeMinecraftToolCall('act', { actionType: 'break_block', arguments: { x: 1, y: 64, z: 0, expectedBlockId: 'minecraft:stone', timeoutMs: 5_000 } });

test('a danger-woken no-task turn is limited to self-preservation; work still needs takeTask', async () => {
	const bridge = new FakeBridge();
	const { registry, planner, run } = await launch(bridge, [[FINISH], [BREAK]]);
	try {
		await eventually(() => planner.outcomes.length === 1);
		bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'complete', goalRevision: 2 } });
		await eventually(() => registry.get('agent-a').state === DynamicAgentState.COMPLETED);
		bridge.emit('observation', hurt(2, 2, 15));
		await eventually(() => planner.outcomes.length === 2);
		assert.equal(planner.outcomes[1].error?.code, 'CONVERSATION_ONLY');
		assert.match(planner.outcomes[1].error.message, /player request: call takeTask/);
		assert.equal(bridge.sent.filter(({ type }) => type === 'action_command').length, 0, 'breaking blocks is not self-preservation');
	} finally {
		await run.coordinator.stop();
	}
});

test('an operator takeover reported by Minecraft suppresses no-task danger wakes', async () => {
	const bridge = new FakeBridge();
	const { registry, planner, run } = await launch(bridge, [[FINISH], [FIGHT]]);
	try {
		await eventually(() => planner.outcomes.length === 1);
		bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'complete', goalRevision: 2 } });
		await eventually(() => registry.get('agent-a').state === DynamicAgentState.COMPLETED);
		const reserved = hurt(2, 2, 15);
		reserved.payload.observation.player.operatorControlled = true;
		bridge.emit('observation', reserved);
		await settle();
		assert.equal(planner.requests.length, 1, 'the operator owns the body: no turn may act on it');
		bridge.emit('observation', hurt(2, 3, 14));
		await eventually(() => planner.requests.length === 2);
	} finally {
		await run.coordinator.stop();
	}
});

test('awaiting confirmation: work begun while waiting gets its follow-up wake, then waiting resumes', async () => {
	const bridge = new DeferredCompletionBridge();
	const { planner, run } = await launch(bridge, [[FINISH, FIGHT], [], []]);
	const ordinary = (eventSequence) => ({ agentId: 'agent-a', payload: { goalRevision: 1, eventSequence, attention: true, observation: { player: { x: 0, y: 64, z: 0 } } } });
	try {
		await eventually(() => bridge.sent.some(({ type }) => type === 'goal_completed'));
		awaitConfirmation(bridge);
		await eventually(() => fights(bridge).length === 1);
		resolveFight(bridge, fights(bridge)[0]);
		await eventually(() => planner.outcomes.length === 2);
		await settle();
		bridge.emit('observation', ordinary(5));
		await eventually(() => planner.requests.length === 2);
		await settle();
		bridge.emit('observation', ordinary(6));
		await settle();
		assert.equal(planner.requests.length, 2, 'a turn without new body work returns the goal to plain waiting (no redo loop)');
	} finally {
		await run.coordinator.stop();
	}
});

const survivalSamples = [
	['threat', {}, ['threats.targeting']],
	['damage', { health: 18 }, ['player.health']],
	['lava', { inLava: true }, ['player.inLava']],
	['fire', { fire: true }, ['player.onFire']],
	['suffocation', { air: 0 }, ['player.air']],
	['fall', { fallDistance: 8 }, ['player.fallDistance']],
	['low_health', {}, ['survival.low_health_no_food']],
	['drowning', { air: 0 }, []],
];

for (const state of [DynamicAgentState.IDLE, DynamicAgentState.COMPLETED, DynamicAgentState.PAUSED, DynamicAgentState.ERROR]) {
	for (const [trigger, player, changedFacts] of survivalSamples) {
		test(`${state}: ${trigger} admits self-preservation without resuming the parked goal`, async () => {
			const registry = new AgentRegistry();
			const planner = scriptedPlanner(registry, [[FIGHT]]);
			const run = await start({ registry, planner, config: NATIVE_CONFIG,
				initialRegistry: [{ ...record(), state, goalRevision: 1, currentGoal: state === DynamicAgentState.IDLE ? null : 'Wait for the operator.' }] });
			try {
				const before = registry.get('agent-a');
				run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1,
					observation: { player: { health: 20 } } } });
				await settle();
				assert.equal(planner.requests.length, 0, 'ordinary observation stays quiet');
				// Survival fact deltas do not need a caller-supplied urgent priority.
				const sample = { goalRevision: 1, eventSequence: 2, attention: true,
					observation: { player: { health: 20, ...player } }, changedFacts };
				if (trigger !== 'drowning') run.bridge.emit('observation', { agentId: 'agent-a', payload: sample });
				// Drowning is also accepted as an explicit survival reason, without a priority annotation.
				if (trigger === 'drowning') {
					const wire = structuredClone(run.bridge.latestObservations.get('agent-a'));
					wire.eventSequence = 2;
					wire.player.air = 0;
					wire.trigger = 'drowning';
					run.bridge.emit('observation', { agentId: 'agent-a', payload: wire });
				}
				await eventually(() => fights(run.bridge).length === 1);
				assert.equal(planner.requests[0].priority, 'urgent');
				assert.equal(planner.requests[0].preserveState, true);
				resolveFight(run.bridge, fights(run.bridge)[0]);
				await eventually(() => planner.outcomes.length === 1);
				assert.equal(planner.outcomes[0].result?.state, 'SUCCEEDED');
				assert.equal(registry.get('agent-a').state, before.state);
				assert.equal(registry.get('agent-a').goalRevision, before.goalRevision);
				assert.equal(registry.get('agent-a').currentGoal, before.currentGoal);
			} finally { await run.coordinator.stop(); }
		});
	}
}

for (const factual of [
	{ type: 'inventory_contains', itemId: 'minecraft:iron_pickaxe', count: 1 },
	{ type: 'advancement_granted', advancementId: 'minecraft:nether/find_fortress' },
]) {
	test(`finish retains verified ${factual.type} facts through threat and lava turns until operator confirmation`, async () => {
		const bridge = new DeferredCompletionBridge();
		const facts = [{ type: factual.type, satisfied: true, expectedValue: 'required condition', observedValue: 'verified by Minecraft' },
			{ type: 'operator_confirmed', satisfied: false, expectedValue: 'confirmed', observedValue: 'not confirmed' }];
		const { registry, planner, traces, run } = await launch(bridge, [[FINISH], [FIGHT], [], [FIGHT], []],
			{ type: 'all_of', predicates: [factual, { type: 'operator_confirmed' }] });
		try {
			await eventually(() => bridge.sent.some(({ type }) => type === 'goal_completed'));
			awaitConfirmation(bridge, facts);
			await eventually(() => traces.filter(row => row.event === 'native_turn_completed').length === 1);
			assert.match(planner.outcomes[0].result.message, /Minecraft verified the factual goal conditions/);
			assert.match(planner.outcomes[0].result.message, /without operator permission; confirmation stays pending/);
			for (const [index, trigger] of ['threat', 'lava'].entries()) {
				const sequence = 51 + index * 10;
				bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence,
					attention: true, changedFacts: [], observation: { player: { health: 20 } } } });
				await settle();
				assert.equal(planner.requests.length, 1 + index * 2, 'ordinary observation cannot resume finished work');
				const wire = structuredClone(bridge.latestObservations.get('agent-a'));
				wire.eventSequence++;
				wire.trigger = trigger;
				wire.player.inLava = trigger === 'lava';
				bridge.emit('observation', { agentId: 'agent-a', payload: wire });
				await eventually(() => fights(bridge).length === index + 1);
				const request = planner.requests[1 + index * 2];
				assert.equal(request.priority, 'urgent');
				assert.equal(request.preserveState, true);
				assert.match(request.input.split('\n')[0], /defend, flee, escape lava\/fire/);
				assert.match(request.input.split('\n')[0], /Only operator confirmation remains/);
				if (trigger === 'lava') assert.match(request.input.split('\n')[0], /lava\/fire contact/);
				const input = JSON.parse(request.input.slice(request.input.indexOf('\n') + 1));
				assert.deepEqual(input.completion, { state: 'AWAITING_OPERATOR_CONFIRMATION', factsAtFinish: facts });
				resolveFight(bridge, fights(bridge)[index]);
				await eventually(() => traces.filter(row => row.event === 'native_turn_completed').length === 2 + index * 2);
				// A defensive action still owns one result/follow-up wake, then the goal returns to plain waiting.
				bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence + 2,
					attention: false, observation: { player: { health: 20 } } } });
				await eventually(() => traces.filter(row => row.event === 'native_turn_completed').length === 3 + index * 2);
			}
			assert.notEqual(registry.get('agent-a').state, DynamicAgentState.COMPLETED, 'only the operator can confirm');
			assert.equal(registry.get('agent-a').goalRevision, 1);
			assert.equal(bridge.sent.filter(({ type }) => type === 'goal_completed').length, 1, 'defense never rechecks finish');
		} finally { await run.coordinator.stop(); }
	});
}

test('a program checkpoint leaves urgent survival attention deliverable', async () => {
	const bridge = new FakeBridge();
	const checkpoint = { kind: 'run_program', background: true, timeoutMs: 10000,
		source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1); program.checkpoint("Awaiting a model decision");' };
	const { planner, traces, run } = await launch(bridge, [[checkpoint], [], [FIGHT]]);
	try {
		await eventually(() => traces.some(row => row.event === 'native_turn_completed') && bridge.sent.some(row => row.type === 'action_command'));
		const wait = bridge.sent.find(row => row.type === 'action_command');
		bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: wait.payload.actionId,
			actionType: 'wait', state: 'SUCCEEDED', reasonCode: 'WAITED', executionStarted: true, eventSequence: 2 } });
		await eventually(() => planner.requests.length === 2 && traces.filter(row => row.event === 'native_turn_completed').length === 2);
		assert.match(planner.requests[1].input, /PROGRAM_CHECKPOINT/);
		bridge.emit('observation', hurt(1, 10, 18));
		await eventually(() => fights(bridge).length === 1);
		assert.equal(planner.requests[2].priority, 'urgent');
		resolveFight(bridge, fights(bridge)[0]);
		await eventually(() => planner.outcomes.length === 2);
		assert.equal(planner.outcomes[1].result?.state, 'SUCCEEDED');
	} finally { await run.coordinator.stop(); }
});


test('confirmation waiting cannot swallow danger sharing a supervised continuation', async () => {
	const bridge = new DeferredCompletionBridge();
	const supervisor = new RecordingGoalSupervisor();
	const { planner, traces, run } = await launch(bridge, [[FINISH], [FIGHT]], { type: 'operator_confirmed' }, { goalSupervisor: supervisor });
	try {
		await eventually(() => bridge.sent.some(({ type }) => type === 'goal_completed'));
		awaitConfirmation(bridge);
		await eventually(() => traces.some(row => row.event === 'native_turn_completed'));
		await run.coordinator.requestSupervisedObservation(supervisor.activations.at(-1));
		bridge.emit('observation', hurt(1, 2, 18));
		await eventually(() => fights(bridge).length === 1);
		assert.equal(planner.requests.length, 2);
		assert.equal(planner.requests[1].priority, 'urgent');
		resolveFight(bridge, fights(bridge)[0]);
		await eventually(() => planner.outcomes.length === 2);
		assert.equal(planner.outcomes[1].result?.state, 'SUCCEEDED');
	} finally { await run.coordinator.stop(); }
});
