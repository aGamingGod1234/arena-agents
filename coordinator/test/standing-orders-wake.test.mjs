import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentRegistry } from '../src/agent-registry.mjs';
import { classifyObservationTrigger } from '../src/dynamic-main.mjs';
import { FakePlanner, start, eventually, factToWireObservation, ManualTimerQueue } from './fixtures/dynamic-main-fixture.mjs';

const POLICY = 'program.onUnhandledAttention("continue_and_notify", { survival: "continue_and_notify" });';
const THREAT = '00000000-0000-4000-8000-0000000000aa';
/** The wake event exactly as presented to the model. */
const presented = (request) => JSON.parse(request.input.slice(request.input.indexOf('\n') + 1));
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

/**
 * The production coordinator with a planner whose first turn runs the given tools; every later turn only reads
 * capabilities. Counts scheduled model turns, which is what a wake costs.
 */
async function coordinatorWith(firstTurnTools = [], options = {}) {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), timers = new ManualTimerQueue();
	const results = [];
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		const tools = planner.requests.length === 1 ? firstTurnTools : [{ kind: 'capabilities' }];
		for (const [index, tool] of tools.entries()) {
			results.push(await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: `turn-${planner.requests.length}`, callId: `call-${planner.requests.length}-${index}`, tool }).catch((error) => ({ error: error.code })));
		}
		return { status: 'completed', toolCalls: tools.length };
	};
	const run = await start({ registry, planner, goalSchedule: timers.schedule, cancelGoalSchedule: timers.cancel, ...options,
		config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Travel safely.' } });
	const raw = factToWireObservation({ player: { health: 20 } }, 1, 1, false, 1000);
	run.bridge.emit('observation', { agentId: 'agent-a', payload: raw });
	await eventually(() => planner.requests.length === 1);
	await settle();
	let sequence = 1;
	const emit = (changedFacts, player = {}, extra = {}) => {
		sequence += 1;
		const sample = structuredClone(raw);
		Object.assign(sample, { eventSequence: sequence, observedAtEpochMs: 1000 + sequence * 50, attention: true, changedFacts, ...extra });
		Object.assign(sample.player, player);
		run.bridge.emit('observation', { agentId: 'agent-a', payload: sample });
	};
	// As the server publishes a change of the drop ahead alone: no attention, no changed fact, sampleOnly.
	const emitSample = (dropAhead) => {
		// Spaced so a program's own queried sample (the fixture answers with the next sequence) never collides.
		sequence += 10;
		const sample = structuredClone(raw);
		Object.assign(sample, { eventSequence: sequence, observedAtEpochMs: 1000 + sequence * 50, attention: false, changedFacts: [], sampleOnly: true });
		if (dropAhead === null) delete sample.player.dropAhead;
		else sample.player.dropAhead = dropAhead;
		run.bridge.emit('observation', { agentId: 'agent-a', payload: sample });
	};
	const commands = () => run.bridge.sent.filter(({ type }) => type === 'action_command');
	return { run, planner, results, emit, emitSample, commands, nextSequence: () => (sequence += 1000) };
}

// Review r2 finding 1: the scheduling boundary, not the classifier, decides whether a model turn happens.
test('a drop edge alone schedules no model turn, on the first and on repeated approaches', async () => {
	const { run, planner, emitSample } = await coordinatorWith();
	try {
		emitSample({ drop: 9, at: 2 });
		await settle();
		emitSample({ drop: 1, atLeast: true, at: 3 });
		await settle();
		emitSample(null);
		await settle();
		emitSample({ drop: 9, at: 1 });
		await settle();
		assert.equal(planner.requests.length, 1, 'three approaches, no extra model turn');
	} finally { await run.coordinator.stop(); }
});

test('the edge sample still reaches an authored standing order, which fires without a model turn', async () => {
	const { run, planner, results, emitSample } = await coordinatorWith([{ kind: 'standing_order', id: 'edge', when: 'player.state().dropAhead !== null', ttlS: 300,
		source: `${POLICY} await player.wait(50);`, maxActions: 2, timeoutMs: 3000 }]);
	try {
		assert.equal(results[0].state, 'STANDING');
		const before = run.bridge.sent.filter(({ type }) => type === 'action_command').length;
		emitSample({ drop: 9, at: 2 });
		await eventually(() => run.bridge.sent.filter(({ type }) => type === 'action_command').length > before);
		assert.equal(run.bridge.sent.filter(({ type }) => type === 'action_command').at(-1).payload.actionType, 'wait');
		assert.equal(planner.requests.length, 1, 'the reflex itself costs no model turn');
	} finally { await run.coordinator.stop(); }
});

// Review r2 finding 2: the drop is ignored as a reason; every other reason in the same sample still wakes.
test('a drop in the same sample never hides another wake reason', async () => {
	const { run, planner, emit } = await coordinatorWith();
	try {
		emit(['player.dropAhead', `threats.${THREAT}.targeting`], { dropAhead: { drop: 9, at: 2 } });
		await eventually(() => planner.requests.length === 2);
		assert.equal(presented(planner.requests[1]).trigger, 'threat');
	} finally { await run.coordinator.stop(); }
});

test('with a running program, the edge alone neither pauses nor wakes; a threat in the same sample still does', async () => {
	const { run, planner, results, emit, emitSample } = await coordinatorWith([{ kind: 'run_program', background: true, maxActions: 4, timeoutMs: 60_000,
		source: 'program.onUnhandledAttention("pause_and_notify"); await player.wait(50000);' }]);
	try {
		assert.equal(results[0].state, 'RUNNING');
		emitSample({ drop: 9, at: 2 });
		await settle();
		assert.equal(planner.requests.length, 1);
		emit(['player.dropAhead', `threats.${THREAT}.targeting`], { dropAhead: { drop: 9, at: 1 } }, { threats: { entries: [{ uuid: THREAT, type: 'minecraft:zombie', distance: 4, bearing: 10, targeting: true, swelling: false, lineOfSight: true, signals: ['targeting'], risk: 2 }] } });
		await eventually(() => planner.requests.length >= 2);
		assert.equal(presented(planner.requests[1]).event, 'program_attention');
	} finally { await run.coordinator.stop(); }
});

test('classifier: with the drop ignored, loop, resource, dimension and damage signals keep their wakes', () => {
	const sample = { player: { health: 20 } };
	const edge = { attention: false, changedFacts: [], sampleOnly: true };
	assert.deepEqual(classifyObservationTrigger(edge, sample), { attention: false, priority: 'ordinary', trigger: 'observation', sampleOnly: true });
	// Review r3 finding 1: forced attention (an action result) beside the edge fact is not a sample; it keeps its wake.
	assert.deepEqual(classifyObservationTrigger({ attention: true, changedFacts: ['player.dropAhead'] }, sample), { attention: true, priority: 'ordinary', trigger: 'attention' });
	assert.equal(classifyObservationTrigger(edge, sample, { movementLoop: true }).trigger, 'movement_loop');
	assert.equal(classifyObservationTrigger(edge, sample, { resourceDiscovery: true }).trigger, 'resource_discovery');
	assert.equal(classifyObservationTrigger(edge, sample, { dimensionChanged: true }).trigger, 'dimension_changed');
	assert.equal(classifyObservationTrigger(edge, { player: { health: 15 } }, { previousPlayer: { health: 20 } }).trigger, 'damage');
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['player.dropAhead', 'player.fallDistance'] }, sample).trigger, 'fall');
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['player.dropAhead', 'player.health'] }, sample).sampleOnly, undefined);
});


/** The model's own wait runs while a structure sighting is held for it; the action then succeeds. */
async function heldSightingThenCompletion() {
	const holdTimers = [];
	const fixture = await coordinatorWith([{ kind: 'start_action', actionType: 'wait', arguments: { durationMs: 5000 } }], {
		setWakeHoldTimeout: (callback, delayMs) => { const timer = { callback, delayMs, cleared: false }; holdTimers.push(timer); return timer; },
		clearWakeHoldTimeout: (timer) => { timer.cleared = true; },
	});
	fixture.emit(['sighted']);
	await eventually(() => holdTimers.length === 1);
	const command = fixture.commands().at(-1);
	fixture.run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state: 'SUCCEEDED', reasonCode: 'WAIT_DONE', actionType: 'wait', eventSequence: 50 } });
	await eventually(() => holdTimers[0].cleared);
	return fixture;
}

// Review r3 finding 1: the server forces the completion observation for the action result; a drop seen in the same
// sample is listed beside it. The completion and the held sighting still wake the model at once.
test('a completion observation that also carries the drop wakes with the held sighting', async () => {
	const { run, planner, emit } = await heldSightingThenCompletion();
	try {
		emit(['player.dropAhead'], { dropAhead: { drop: 9, at: 2 } });
		await eventually(() => planner.requests.length === 2);
		assert.equal(presented(planner.requests[1]).trigger, 'structure_sighted');
	} finally { await run.coordinator.stop(); }
});

test('a drop sample arriving after the action ended does not swallow its held wake', async () => {
	const { run, planner, emitSample } = await heldSightingThenCompletion();
	try {
		emitSample({ drop: 9, at: 2 });
		await eventually(() => planner.requests.length === 2);
		assert.equal(presented(planner.requests[1]).trigger, 'structure_sighted');
	} finally { await run.coordinator.stop(); }
});

// Review r3 finding 2, coordinator half: every drop change the server samples reaches the order book. A condition on the
// depth first turns true on the deeper drop, a retreat clears it, and the next approach fires again.
test('drop samples drive an order through changing depth, retreat and a second approach', async () => {
	const { run, results, emitSample, commands, nextSequence } = await coordinatorWith([{ kind: 'standing_order', id: 'deep', ttlS: 300,
		when: 'player.state().dropAhead !== null && player.state().dropAhead.drop >= 6', source: `${POLICY} await player.wait(50);`, maxActions: 2, timeoutMs: 3000 }]);
	try {
		assert.equal(results[0].state, 'STANDING');
		const settleWait = () => { const command = commands().at(-1); run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state: 'SUCCEEDED', reasonCode: 'WAIT_DONE', actionType: 'wait', eventSequence: nextSequence() } }); };
		const before = commands().length;
		emitSample({ drop: 4, at: 2 });
		await settle();
		assert.equal(commands().length, before, 'a 4-block drop does not meet the authored depth');
		emitSample({ drop: 9, at: 2 });
		await eventually(() => commands().length === before + 1);
		settleWait();
		emitSample({ drop: 9, at: 1 });
		await settle();
		assert.equal(commands().length, before + 1, 'the same edge does not refire');
		emitSample(null);
		await new Promise((resolve) => setTimeout(resolve, 2_100));
		emitSample({ drop: 9, at: 2 });
		await eventually(() => commands().length === before + 2);
	} finally { await run.coordinator.stop(); }
});

// R4: distance-only samples must evaluate the model's own threshold immediately, without a model wake.
test('a distance-only sample fires an authored threshold before any heartbeat', async () => {
	const { run, planner, results, emitSample, commands } = await coordinatorWith([{ kind: 'standing_order', id: 'near', ttlS: 300,
		when: 'player.state().dropAhead !== null && player.state().dropAhead.at <= 1', source: `${POLICY} await player.wait(50);`, maxActions: 2, timeoutMs: 3000 }]);
	try {
		assert.equal(results[0].state, 'STANDING');
		const before = commands().length;
		emitSample({ drop: 9, at: 3 });
		await settle();
		assert.equal(commands().length, before);
		emitSample({ drop: 9, at: 1 });
		await eventually(() => commands().length === before + 1);
		assert.equal(planner.requests.length, 1);
	} finally { await run.coordinator.stop(); }
});

test('a standing guard reacts while the model is thinking with no program, and reports activation and fallback outcomes', async () => {
	const { guardThinkingFixture } = await import('./fixtures/dynamic-main-fixture.mjs');
	const run = await guardThinkingFixture(`${POLICY}
		const id = player.state().threat.uuid;
		const flee = await tryResult(player.fleeFrom({ targetId: id, distance: 12, timeoutMs: 3000 }));
		if (flee.reasonCode === "FLEE_BLOCKED") { await player.fightTarget({ targetId: id, timeoutMs: 5000 }); }`);
	try {
		assert.equal(run.installed.state, 'STANDING');
		assert.equal(run.bridge.sent.some(({ type }) => type === 'action_command'), false, 'no body program or action was running');
		const sample = structuredClone(run.raw);
		Object.assign(sample, { eventSequence: 100, observedAtEpochMs: 1100, attention: true, changedFacts: [`threats.${THREAT}.targeting`],
			threats: { entries: [{ uuid: THREAT, type: 'minecraft:zombie', distance: 3, bearing: 10, targeting: true, swelling: false, lineOfSight: true, signals: ['targeting'], risk: 2 }] } });
		run.bridge.emit('observation', { agentId: 'agent-a', payload: sample });
		const commands = () => run.bridge.sent.filter(({ type }) => type === 'action_command');
		await eventually(() => commands().length === 1);
		assert.equal(run.isThinking(), true, 'the model has not returned or authored another command');
		assert.equal(commands()[0].payload.actionType, 'flee_from');
		assert.equal(commands()[0].payload.arguments.targetId, THREAT);
		await eventually(() => run.steers.some(({ input }) => input.includes('program_guard_activated')));
		const settle = (command, state, reasonCode, sequence) => {
			run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, actionType: command.payload.actionType, state, reasonCode, eventSequence: sequence, executionStarted: true } });
			const after = structuredClone(sample);
			Object.assign(after, { eventSequence: sequence + 1, observedAtEpochMs: 1100 + sequence, attention: false, changedFacts: [] });
			if (state === 'SUCCEEDED') after.threats.entries = [];
			run.bridge.emit('observation', { agentId: 'agent-a', payload: after });
		};
		settle(commands()[0], 'FAILED', 'FLEE_BLOCKED', 200);
		await eventually(() => commands().length === 2);
		assert.equal(run.isThinking(), true);
		assert.equal(commands()[1].payload.actionType, 'fight_target');
		settle(commands()[1], 'SUCCEEDED', 'TARGET_KILLED', 300);
		await eventually(() => run.steers.some(({ input }) => input.includes('program_ended') && input.includes('FLEE_BLOCKED')));
		const input = run.steers.findLast(({ input }) => input.includes('program_ended')).input;
		const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
		assert.match(payload.now.guardOutcome, /fired 1x, 2 actions \(flee_from 1x, fight_target 1x\).*last FLEE_BLOCKED/);
		assert.equal(run.planner.requests.length, 1, 'the guard and fallback needed no second model turn');
		assert.equal(run.isThinking(), true);
	} finally { run.releaseModel(); await run.coordinator.stop(); }
});


test('repeated quick guard failures send one urgent activation while the real coordinator keeps the model thinking', async () => {
	const { guardThinkingFixture } = await import('./fixtures/dynamic-main-fixture.mjs');
	const run = await guardThinkingFixture(`${POLICY} await player.fleeFrom({ targetId: player.state().threat.uuid, distance: 12, timeoutMs: 3000 });`);
	try {
		let sequence = 1000;
		const sample = structuredClone(run.raw);
		sample.threats = { entries: [{ uuid: THREAT, type: 'minecraft:zombie', distance: 3, bearing: 10, targeting: true, swelling: false, lineOfSight: true, signals: ['targeting'], risk: 2 }] };
		const emit = () => {
			Object.assign(sample, { eventSequence: sequence += 100, observedAtEpochMs: sequence, attention: false, changedFacts: [], sampleOnly: true });
			run.bridge.emit('observation', { agentId: 'agent-a', payload: structuredClone(sample) });
		};
		const commands = () => run.bridge.sent.filter(({ type }) => type === 'action_command');
		for (const [index, delay] of [0, 300, 550].entries()) {
			if (delay) await new Promise(resolve => setTimeout(resolve, delay));
			emit();
			await eventually(() => commands().length === index + 1);
			const command = commands()[index];
			run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, actionType: 'flee_from', state: 'FAILED', reasonCode: 'FLEE_BLOCKED', eventSequence: ++sequence, executionStarted: true } });
			emit();
			await settle();
		}
		assert.equal(run.steers.filter(({ input }) => input.includes('program_guard_activated')).length, 1);
		assert.equal(run.steers.filter(({ input }) => input.includes('program_ended')).length, 0);
		assert.equal(run.planner.requests.length, 1);
		assert.equal(run.isThinking(), true);
		sample.threats.entries = [];
		emit();
		await eventually(() => run.steers.some(({ input }) => input.includes('program_ended')));
		const end = run.steers.find(({ input }) => input.includes('program_ended'));
		assert.ok(end.input.includes('FLEE_BLOCKED'));
		assert.match(end.input, /"activations":3/);
	} finally { run.releaseModel(); await run.coordinator.stop(); }
});


test('model wakes report guard absence for legacy orders and coverage for installed guards', async () => {
	for (const kind of ['none', 'legacy', 'guard']) {
		const tools = kind === 'none' ? [] : [{ kind: 'standing_order', id: 'defense', when: 'player.state().health < 5',
			source: `${POLICY} await player.wait(50);`, ...(kind === 'guard' ? { guard: true } : { ttlS: 300 }) }];
		const { run, planner, emit } = await coordinatorWith(tools);
		try {
			assert.equal(presented(planner.requests[0]).now.guard, 'none installed');
			emit(['sighted']);
			await eventually(() => planner.requests.length === 2);
			assert.equal(presented(planner.requests[1]).now?.guard, kind === 'guard' ? 'defense: installed, condition false, fired 0x' : 'none installed');
		} finally { await run.coordinator.stop(); }
	}
});
