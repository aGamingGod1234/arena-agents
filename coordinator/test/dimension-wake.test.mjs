import { compactEventInstruction } from '../src/dynamic-main.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { parseArenaScript } from '../src/arena-script/parser.mjs';
import { ArenaScriptEngine } from '../src/arena-script/program-engine.mjs';
import { buildNativeEventInput, classifyObservationTrigger, mergePlannerRequest, NEW_CONTEXT_EVENT_INSTRUCTION } from '../src/dynamic-main.mjs';

// A Nether arrival also lists its dangers and the armed reflexes that sense them (danger-contexts.mjs).
const NETHER_ENTRY = 'Entered the Nether: contexts lists its dangers and armed reflexes.';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

// Travel through a portal reaches the model as its own ordinary notification, whatever program or action owns the body;
// the policy the model authored decides whether its routine pauses.

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const OVERWORLD = 'minecraft:overworld';
const NETHER = 'minecraft:the_nether';
const GENERIC = /^Update; act on fresh facts\./;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const instructionOf = (request) => request.input.split('\n')[0];
const wake = (request) => JSON.parse(request.input.split('\n')[1]);

function world(dimension, sequence = 1) {
	return { dimension, gameTime: 1_000 + sequence, dayTime: 1_000 + sequence, raining: false, thundering: false };
}
function observation(sequence, { dimension = OVERWORLD, attention = true, health = 20, changedFacts = ['blocks'], goalRevision = 1 } = {}) {
	return { agentId: 'agent-a', payload: { goalRevision, eventSequence: sequence, attention, observedAtEpochMs: sequence, changedFacts,
		observation: { player: { x: sequence % 7, y: 64, z: 0, health }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} }, world: world(dimension, sequence) } } };
}

const record = { agentId: 'agent-a', goalRevision: 1, provider: 'codex', model: 'test', reasoningEffort: 'low' };
/** Runs a one-wait program, feeds it an overworld-to-Nether sample, and reports the decisions and body state. */
async function portalDuringProgram({ policy, filter, trigger, priority }) {
	let done;
	const body = new Promise((resolve) => { done = resolve; });
	const decisions = [];
	let cancelled = false;
	const executor = new NativeProgramExecutor();
	const facts = { player: { health: 20 }, world: { dimension: OVERWORLD }, inventory: { items: [] }, blocks: [], entities: [], items: [] };
	const result = executor.run(record, { source: `program.onUnhandledAttention("${policy}"${filter ? ', {reassessWhen:() => false}' : ''}); await player.wait(10000);` },
		{ observation: facts, eventSequence: 1, executeAction: () => body, cancelAction: async () => { cancelled = true; done({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }); }, onDecision: (status) => decisions.push(status.decision) });
	await tick();
	executor.onObservation(record, { observation: { ...facts, player: { health: priority === 'urgent' ? 12 : 20 }, world: { dimension: NETHER } }, eventSequence: 2, attention: true, priority, trigger });
	await tick();
	await tick();
	// A paused run hands control back and ends; a notified one is still running.
	const state = { decisions: decisions.map((decision) => decision.trigger), engineState: executor.status(record)?.engineState ?? 'ENDED', cancelled };
	done({ state: 'SUCCEEDED', reasonCode: 'DONE' });
	await tick();
	await executor.cancel(record);
	await result;
	return state;
}

/** A coordinator whose first turn optionally starts something that owns the body; later turns are scripted. */
async function coordinator({ firstTool = null, turns = [] } = {}) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		const turn = planner.requests.length;
		if (turn === 1) {
			if (firstTool !== null) await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId: 'c1', tool: firstTool });
			return { toolCalls: firstTool === null ? 0 : 1 };
		}
		return await turns[turn - 2]?.(request) ?? { toolCalls: 0 };
	};
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: CONFIG });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat the game.' } });
	run.bridge.emit('observation', observation(1));
	await eventually(() => rows.some(({ event }) => event === 'native_turn_completed'));
	return { run, planner, rows };
}

test('a dimension edge is its own ordinary trigger; danger in the same sample keeps precedence', () => {
	const moved = { previousPlayer: { health: 20 }, dimensionChanged: true };
	assert.deepEqual(classifyObservationTrigger({ attention: true, changedFacts: ['world.dimension'] }, { player: { health: 20 } }, moved),
		{ attention: true, priority: 'ordinary', trigger: 'dimension_changed' });
	// Even a quiet sample (attention false) that crosses dimensions is attention.
	assert.equal(classifyObservationTrigger({ attention: false }, { player: { health: 20 } }, moved).trigger, 'dimension_changed');
	assert.deepEqual(classifyObservationTrigger({ attention: true, changedFacts: ['world.dimension'] }, { player: { health: 12 } }, moved),
		{ attention: true, priority: 'urgent', trigger: 'damage' });
	// An ordinary server reason that arrives with the edge is named as the edge; an urgent one is kept.
	assert.equal(classifyObservationTrigger({ trigger: 'attention' }, { player: { health: 20 } }, moved).trigger, 'dimension_changed');
	assert.equal(classifyObservationTrigger({ trigger: 'lava' }, { player: { health: 20 } }, moved).trigger, 'lava');
	assert.equal(classifyObservationTrigger({ attention: true }, { player: { health: 20 } }, { dimensionChanged: false }).trigger, 'attention');
});

test('a dimension edge outranks ordinary healing in the same sample, after urgent danger', () => {
	const moved = { previousPlayer: { health: 20 }, dimensionChanged: true };
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['world.dimension', 'survival.heal_opportunity'] }, { player: { health: 20 } }, moved).trigger, 'dimension_changed');
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['survival.low_health_no_food'] }, { player: { health: 20 } }, moved).trigger, 'low_health');
	assert.equal(classifyObservationTrigger({ attention: true }, { player: { health: 20 } }, { ...moved, movementLoop: true }).trigger, 'movement_loop');
	// Without the edge, healing keeps its own trigger.
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['survival.heal_opportunity'] }, { player: { health: 20 } }, { dimensionChanged: false }).trigger, 'heal_opportunity');
});

test('programs: the dimension edge notifies past reassessWhen; the authored policy decides the body; danger still pauses it', async () => {
	// Control: an authored waiver still holds back plain attention.
	assert.deepEqual(await portalDuringProgram({ policy: 'continue_and_notify', filter: true, trigger: 'attention', priority: 'ordinary' }),
		{ decisions: [], engineState: 'ACTIVE', cancelled: false });
	for (const filter of [true, false]) {
		assert.deepEqual(await portalDuringProgram({ policy: 'continue_and_notify', filter, trigger: 'dimension_changed', priority: 'ordinary' }),
			{ decisions: ['dimension_changed'], engineState: 'ACTIVE', cancelled: false }, `continue filter=${filter}`);
		assert.deepEqual(await portalDuringProgram({ policy: 'pause_and_notify', filter, trigger: 'dimension_changed', priority: 'ordinary' }),
			{ decisions: ['dimension_changed'], engineState: 'ENDED', cancelled: true }, `pause filter=${filter}`);
	}
	// Damage taken while crossing: the authored danger policy applies and the routine pauses.
	const danger = await portalDuringProgram({ policy: 'pause_and_notify', filter: true, trigger: 'damage', priority: 'urgent' });
	assert.deepEqual(danger.decisions, ['damage']);
	assert.equal(danger.cancelled, true);
});

test('a standalone action does not hold the dimension wake; it carries the assessment once', async () => {
	const { run, planner, rows } = await coordinator({ firstTool: { kind: 'start_action', actionType: 'wait', arguments: { durationMs: 5000 } } });
	try {
		assert.equal(instructionOf(planner.requests[0]), compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION), 'the goal start carries it');
		// An ordinary sighting is held for the running action ...
		run.bridge.emit('observation', observation(2, { changedFacts: ['sighted'] }));
		await eventually(() => rows.some(({ event }) => event === 'native_wake_deferred_for_action'));
		// ... the portal is not.
		run.bridge.emit('observation', observation(3, { dimension: NETHER, changedFacts: ['world.dimension'] }));
		await eventually(() => planner.requests.length === 2);
		assert.equal(wake(planner.requests[1]).trigger, 'dimension_changed');
		assert.equal(instructionOf(planner.requests[1]), `${compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION)} ${NETHER_ENTRY}`);
		assert.match(wake(planner.requests[1]).situation, /^the_nether, no day cycle;/);
		await eventually(() => rows.filter(({ event }) => event === 'native_turn_completed').length === 2);
		// Delivered: the next wake is an ordinary one.
		run.bridge.emit('observation', observation(4, { dimension: NETHER, changedFacts: ['blocks'], attention: true, health: 20 }));
		const command = run.bridge.sent.find(({ type }) => type === 'action_command');
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state: 'SUCCEEDED', reasonCode: 'WAIT_DONE', actionType: 'wait', eventSequence: 50 } });
		run.bridge.emit('observation', observation(51, { dimension: NETHER }));
		await eventually(() => planner.requests.length === 3);
		assert.match(instructionOf(planner.requests[2]), GENERIC);
	} finally { await run.coordinator.stop(); }
});

for (const [policy, paused] of [['continue_and_notify', false], ['pause_and_notify', true]]) {
	for (const changedFacts of [['world.dimension'], ['world.dimension', 'survival.heal_opportunity']]) {
		test(`a ${policy} program with a reassessWhen waiver reaches the model on a portal (${changedFacts.join(' + ')})`, async () => {
			const tool = { kind: 'run_program', background: true, timeoutMs: 30_000,
				source: `program.onUnhandledAttention("${policy}", {reassessWhen:() => false}); await player.wait(20000);` };
			const { run, planner } = await coordinator({ firstTool: tool });
			const commands = () => run.bridge.sent.filter((message) => message.type === 'action_command');
			try {
				await eventually(() => commands().length === 1);
				// Ordinary progress inside the waiver does not wake the model.
				run.bridge.emit('observation', observation(2, { changedFacts: ['blocks'] }));
				await tick(); await tick();
				assert.equal(planner.requests.length, 1);
				// A healing chance in the same sample does not swallow the crossing.
				run.bridge.emit('observation', observation(3, { dimension: NETHER, changedFacts }));
				await eventually(() => planner.requests.length >= 2);
				const event = wake(planner.requests[1]);
				assert.equal(event.event, 'program_attention');
				assert.equal(event.program.decision.trigger, 'dimension_changed');
				assert.equal(instructionOf(planner.requests[1]), `${compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION)} ${NETHER_ENTRY}`);
				assert.equal(run.bridge.sent.some((message) => message.type === 'action_cancel'), paused, paused ? 'the authored pause releases the wait' : 'the authored wait keeps running');
			} finally { await run.coordinator.stop(); }
		});
	}
}

test('a standalone action does not hold a portal crossing that arrives with a healing chance', async () => {
	const { run, planner } = await coordinator({ firstTool: { kind: 'start_action', actionType: 'wait', arguments: { durationMs: 5000 } } });
	try {
		run.bridge.emit('observation', observation(2, { dimension: NETHER, changedFacts: ['world.dimension', 'survival.heal_opportunity'] }));
		await eventually(() => planner.requests.length === 2);
		assert.equal(wake(planner.requests[1]).trigger, 'dimension_changed');
		assert.equal(instructionOf(planner.requests[1]), `${compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION)} ${NETHER_ENTRY}`);
	} finally { await run.coordinator.stop(); }
});

test('a queued dimension wake keeps its name when a routine wake merges into it; danger still takes over', () => {
	const wakeOf = (trigger, priority = 'ordinary') => ({ goalRevision: 1, priority, trigger, nativeEvent: { event: 'observation', trigger, observation: { trigger } } });
	const merged = mergePlannerRequest(wakeOf('dimension_changed'), wakeOf('attention'));
	assert.deepEqual([merged.trigger, merged.nativeEvent.trigger, merged.nativeEvent.observation.trigger], ['dimension_changed', 'dimension_changed', 'attention'], 'newest facts, the crossing named');
	const danger = mergePlannerRequest(wakeOf('dimension_changed'), wakeOf('damage', 'urgent'));
	assert.deepEqual([danger.priority, danger.trigger, danger.nativeEvent.trigger], ['urgent', 'damage', 'damage']);
	assert.equal(mergePlannerRequest(wakeOf('attention'), wakeOf('structure_sighted')).trigger, 'structure_sighted');
});

test('queued danger and a crossing merge in either order into a danger wake that shows the Nether', () => {
	const facts = (dimension, health) => ({ player: { x: 0, y: 64, z: 0, health }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} }, world: world(dimension) });
	const wakeOf = (trigger, priority, dimension) => ({ goalRevision: 1, priority, trigger, nativeEvent: { event: 'observation', trigger, observation: facts(dimension, 12) } });
	const damage = wakeOf('damage', 'urgent', OVERWORLD);
	const crossing = wakeOf('dimension_changed', 'ordinary', NETHER);
	for (const [label, merged] of [['danger first', mergePlannerRequest(damage, crossing)], ['crossing first', mergePlannerRequest(crossing, wakeOf('damage', 'urgent', NETHER))]]) {
		assert.deepEqual([merged.priority, merged.trigger, merged.nativeEvent.trigger], ['urgent', 'damage', 'damage'], label);
		// The crossing raises the pending assessment (newContext); danger keeps its own instruction and the next wake carries it.
		const input = buildNativeEventInput({ goalRevision: 1, currentGoal: 'Beat the game.' }, { ...merged.nativeEvent, newContext: true });
		assert.match(instructionOf({ input }), GENERIC, label);
		assert.equal(wake({ input }).trigger, 'damage', label);
		assert.match(wake({ input }).situation, /^the_nether/, `${label}: the header shows the new dimension`);
	}
	const routine = { ...damage, priority: 'ordinary', trigger: 'attention', nativeEvent: { ...damage.nativeEvent, trigger: 'attention' } };
	assert.equal(mergePlannerRequest(damage, routine).nativeEvent.trigger, 'damage', 'any later ordinary wake leaves danger named');
});

/** An engine with an interrupt watcher on health below 19, so one sample can carry a watcher edge and a portal. */
function watcherEngine(policy) {
	const dispatched = [], cancelled = [], requests = [];
	const engine = new ArenaScriptEngine({ dispatch: (command) => dispatched.push(command), cancel: (actionId) => cancelled.push(actionId), requestModel: (context) => requests.push(context) });
	const facts = (health, dimension) => ({ player: { x: 0, y: 64, z: 0, health }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} }, world: { dimension } });
	engine.install({ agentId: 'agent-a', goalRevision: 1, modelIdentity: 'model-a', programId: 'program-a', version: 1, eventSequence: 1, observation: facts(20, OVERWORLD),
		compiled: parseArenaScript(`program.onUnhandledAttention("${policy}"); program.watch(() => player.state().health < 19, {mode:"interrupt",after:"resume"}, async () => {await player.wait(9);}); await player.wait(1000);`) });
	return { engine, dispatched, cancelled, requests, facts };
}

test('engine: a portal that coincides with a watcher edge notifies and keeps the authored handler action', () => {
	const run = watcherEngine('pause_and_notify');
	run.engine.ingestObservation({ observation: run.facts(18, NETHER), eventSequence: 2, attention: true, priority: 'ordinary', trigger: 'dimension_changed' });
	assert.deepEqual(run.requests.map((request) => request.trigger), ['dimension_changed']);
	// The interrupt cancelled the main wait for the handler; the pause policy did not take the handler's turn away.
	assert.deepEqual(run.cancelled, [run.dispatched[0].actionId]);
	run.engine.ingestActionResult({ actionId: run.dispatched[0].actionId, state: 'CANCELLED', reasonCode: 'INPUT_RELEASED', eventSequence: 2 });
	assert.deepEqual(run.dispatched.map((command) => command.action.arguments), [1000, 9], 'the handler runs once the interrupt lands');
	assert.equal(run.engine.snapshot().status, 'ACTIVE');
});

test('engine: routine attention coalesced behind a portal notification keeps the dimension trigger', () => {
	const { engine, requests } = watcherEngine('continue_and_notify');
	const facts = (health) => ({ player: { x: 0, y: 64, z: 0, health }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} }, world: { dimension: NETHER } });
	engine.ingestObservation({ observation: facts(20), eventSequence: 2, attention: true, priority: 'ordinary', trigger: 'dimension_changed' });
	engine.ingestObservation({ observation: facts(20), eventSequence: 3, attention: true, priority: 'ordinary', trigger: 'structure_sighted' });
	assert.equal(requests.length, 1);
	engine.applyDirective({ directive: 'continue', ...requests[0] });
	assert.equal(requests[1].trigger, 'dimension_changed');
	assert.equal(requests[1].eventSequence, 3);
	// Danger still takes precedence over it.
	engine.ingestObservation({ observation: facts(12), eventSequence: 4, attention: true, priority: 'urgent', trigger: 'damage' });
	engine.applyDirective({ directive: 'continue', ...requests.at(-1) });
	assert.equal(requests.at(-1).trigger, 'damage');
});
