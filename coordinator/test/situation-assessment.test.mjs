import { compactEventInstruction } from '../src/dynamic-main.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { RuntimeMemoryContext } from '../src/runtime-memory-context.mjs';
import { buildNativeEventInput, NEW_CONTEXT_EVENT_INSTRUCTION } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { DEATH, FakePlanner, RecordingGoalSupervisor, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

// The one-time "read your situation" instruction survives advisories, danger and failed deliveries until an event
// carrying it is delivered, and is scoped to one goal revision.

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const OVERWORLD = 'minecraft:overworld';
const NETHER = 'minecraft:the_nether';
const GENERIC = /^Update; act on fresh facts\./;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const instructionOf = (request) => request.input.split('\n')[0];
const wake = (request) => JSON.parse(request.input.split('\n')[1]);

test('start and replace assessments carry unchanged situation and progress in the same provider context', () => {
	const views = new ModelObservationViews();
	const options = { event: 'observation', trigger: 'observation', observation: {
		world: { ...world(NETHER), worldId: 'w1' }, player: { health: 20, armor: 20 }, inventory: { items: [] },
	}, progress: 'done gear; open fortress; strategy:nether' };
	const build = (extra = {}) => buildNativeEventInput({ currentGoal: 'Beat the game.', goalRevision: 1 }, { ...options, ...extra });
	const full = decodeModelFacts(wake({ input: encodeNativeEventInput(build(), views) }));
	const ordinary = decodeModelFacts(wake({ input: encodeNativeEventInput(build(), views) }));
	assert.ok(ordinary.sameAsPreviousEvent.includes('situation'));
	assert.ok(ordinary.sameAsPreviousEvent.includes('progress'));
	for (const trigger of ['start', 'replace']) {
		const input = encodeNativeEventInput(build({ trigger, newContext: true }), views);
		assert.equal(input.split('\n')[0], compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION));
		const payload = decodeModelFacts(wake({ input }));
		assert.equal(payload.situation, full.situation);
		assert.equal(payload.progress, full.progress);
		assert.ok(!payload.sameAsPreviousEvent?.includes('situation'));
		assert.ok(!payload.sameAsPreviousEvent?.includes('progress'));
	}
});

function world(dimension, sequence = 1) {
	return { dimension, gameTime: 1_000 + sequence, dayTime: 1_000 + sequence, raining: false, thundering: false };
}
function observation(sequence, { dimension = OVERWORLD, attention = true, health = 20, changedFacts = ['blocks'], goalRevision = 1 } = {}) {
	return { agentId: 'agent-a', payload: { goalRevision, eventSequence: sequence, attention, observedAtEpochMs: sequence, changedFacts,
		observation: { player: { x: sequence % 7, y: 64, z: 0, health }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} }, world: world(dimension, sequence) } } };
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

test('danger in the crossing sample wakes as danger; the assessment waits for the next calm event', async () => {
	const { run, planner, rows } = await coordinator();
	try {
		run.bridge.emit('observation', observation(2, { dimension: NETHER, health: 12, changedFacts: ['player.health', 'world.dimension'] }));
		await eventually(() => planner.requests.length === 2);
		assert.equal(wake(planner.requests[1]).trigger, 'damage');
		assert.match(instructionOf(planner.requests[1]), GENERIC);
		assert.match(wake(planner.requests[1]).situation, /^the_nether/, 'the header still shows where the danger is');
		await eventually(() => rows.filter(({ event }) => event === 'native_turn_completed').length === 2);
		run.bridge.emit('observation', observation(3, { dimension: NETHER, health: 12 }));
		await eventually(() => planner.requests.length === 3);
		assert.equal(instructionOf(planner.requests[2]), compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION));
		await eventually(() => rows.filter(({ event }) => event === 'native_turn_completed').length === 3);
		run.bridge.emit('observation', observation(4, { dimension: NETHER, health: 12 }));
		await eventually(() => planner.requests.length === 4);
		assert.match(instructionOf(planner.requests[3]), GENERIC);
	} finally { await run.coordinator.stop(); }
});

test('a failed delivery keeps the assessment for the next turn', async () => {
	const { run, planner, rows } = await coordinator({ turns: [() => { throw Object.assign(new Error('turn dropped'), { code: 'INCOMPLETE_TURN' }); }] });
	try {
		run.bridge.emit('observation', observation(2, { dimension: NETHER, changedFacts: ['world.dimension'] }));
		await eventually(() => rows.some(({ event }) => event === 'native_turn_failed'));
		// The Nether arrival also lists its dangers (danger-contexts.mjs), owed like the assessment.
		const arrival = `${compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION)} Entered the Nether: contexts lists its dangers and armed reflexes.`;
		assert.equal(instructionOf(planner.requests[1]), arrival);
		run.bridge.emit('observation', observation(3, { dimension: NETHER }));
		await eventually(() => planner.requests.length === 3);
		assert.equal(instructionOf(planner.requests[2]), arrival, 'the dropped turn did not consume it');
		await eventually(() => rows.filter(({ event }) => event === 'native_turn_completed').length === 2);
		run.bridge.emit('observation', observation(4, { dimension: NETHER }));
		await eventually(() => planner.requests.length === 4);
		assert.match(instructionOf(planner.requests[3]), GENERIC);
	} finally { await run.coordinator.stop(); }
});

test('a new goal revision starts clean: an undelivered assessment of the old goal is not replayed twice', async () => {
	const { run, planner, rows } = await coordinator();
	try {
		// The crossing arrives with danger, so the old goal's assessment is still pending when the goal is replaced.
		run.bridge.emit('observation', observation(2, { dimension: NETHER, health: 12, changedFacts: ['player.health'] }));
		await eventually(() => rows.filter(({ event }) => event === 'native_turn_completed').length === 2);
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'replace', goalRevision: 2, goal: 'Find a fortress.' } });
		await eventually(() => run.registry.get('agent-a').goalRevision === 2);
		run.bridge.emit('observation', observation(3, { dimension: NETHER, health: 12, goalRevision: 2 }));
		await eventually(() => planner.requests.some((request) => request.goalRevision === 2));
		const first = planner.requests.filter((request) => request.goalRevision === 2);
		assert.equal(instructionOf(first[0]), compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION));
		await eventually(() => rows.filter(({ event, goalRevision }) => event === 'native_turn_completed' && goalRevision === 2).length === 1);
		run.bridge.emit('observation', observation(4, { dimension: NETHER, health: 12, goalRevision: 2 }));
		await eventually(() => planner.requests.filter((request) => request.goalRevision === 2).length === 2);
		assert.match(instructionOf(planner.requests.filter((request) => request.goalRevision === 2)[1]), GENERIC);
	} finally { await run.coordinator.stop(); }
});

test('a planning advisory never carries the assessment, so it cannot consume it', () => {
	const input = buildNativeEventInput({ currentGoal: 'g', goalRevision: 1 }, { event: 'program_planning_due', newContext: true, programId: 'p', planningLeadMs: 5000,
		status: { state: 'RUNNING', programVersion: 1 }, observation: { world: world(NETHER), player: { health: 20 }, inventory: { items: [] } } });
	assert.notEqual(instructionOf({ input }), compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION));
	assert.equal(Object.hasOwn(wake({ input }), 'situation'), false);
});

test('a same-dimension death whose respawn arrives as a new revision still re-reads the situation once', async () => {
	// B/S1-r4 control updatedAtEpochMs values span 4,219 ms, with 94 ms from respawn to resume.
	// This synthetic sequence waits for the death turn; the cancellation tests below replay the recorded spacing.
	const { run, planner, rows } = await coordinator();
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'dead', goalRevision: 1, updatedAtEpochMs: 2, death: { ...DEATH, dimensionId: OVERWORLD } } });
		const isDeath = (request) => wake(request).event === 'player_death';
		await eventually(() => planner.requests.some(isDeath));
		assert.match(instructionOf(planner.requests.find(isDeath)), /^Died: /, 'the death wake itself names the death');
		await eventually(() => rows.filter(({ event }) => event === 'native_turn_completed').length === 2);
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'respawn', goalRevision: 1, updatedAtEpochMs: 3, resumeGoal: true } });
		await eventually(() => run.registry.get('agent-a').state === 'STARTING');
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'disconnect', goalRevision: 2, updatedAtEpochMs: 4 } });
		await eventually(() => run.registry.get('agent-a').goalRevision === 2);
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'resume', goalRevision: 3, updatedAtEpochMs: 5 } });
		await eventually(() => run.registry.get('agent-a').goalRevision === 3);
		run.bridge.emit('observation', observation(3, { goalRevision: 3 }));
		await eventually(() => planner.requests.some((request) => request.goalRevision === 3));
		const resumed = planner.requests.filter((request) => request.goalRevision === 3);
		assert.equal(instructionOf(resumed[0]), compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION));
		assert.match(wake(resumed[0]).situation, /^overworld/);
		await eventually(() => rows.filter(({ event, goalRevision }) => event === 'native_turn_completed' && goalRevision === 3).length === 1);
		run.bridge.emit('observation', observation(4, { goalRevision: 3 }));
		await eventually(() => resumed.length < planner.requests.filter((request) => request.goalRevision === 3).length);
		assert.match(instructionOf(planner.requests.filter((request) => request.goalRevision === 3)[1]), GENERIC, 'delivered once');
	} finally { await run.coordinator.stop(); }
});

const RECORDED_CONTROLS = [
	{ operation: 'dead', goalRevision: 1, updatedAtEpochMs: 1791589316686, death: { ...DEATH, dimensionId: OVERWORLD } },
	{ operation: 'respawn', goalRevision: 1, updatedAtEpochMs: 1791589320811, resumeGoal: true },
	{ operation: 'disconnect', goalRevision: 2, updatedAtEpochMs: 1791589320846 },
	{ operation: 'resume', goalRevision: 3, updatedAtEpochMs: 1791589320905 },
];

for (const delayedMemory of [false, true]) test(`a cancelled death input preserves assessment through ${delayedMemory ? 'recorded control spacing' : 'coalesced controls'}`, async (t) => {
	const { run, planner, rows } = await coordinator();
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	let entered = false;
	const taskContext = RuntimeMemoryContext.prototype.taskContext;
	if (delayedMemory) t.mock.method(RuntimeMemoryContext.prototype, 'taskContext', async function(record) {
		if (!entered && record.goalRevision === 1) { entered = true; await gate; }
		return taskContext.call(this, record);
	});
	try {
		// These are recorded control-update times, not packet-arrival timestamps. Only the gated case schedules
		// their real deltas; the other case deliberately supersedes every control in the same synchronous burst.
		for (let index = 0; index < RECORDED_CONTROLS.length; index++) {
			if (delayedMemory && index > 0) {
				if (index === 1) await eventually(() => entered);
				await new Promise((resolve) => setTimeout(resolve, RECORDED_CONTROLS[index].updatedAtEpochMs - RECORDED_CONTROLS[index - 1].updatedAtEpochMs));
			}
			run.bridge.emit('goal_control', { agentId: 'agent-a', payload: RECORDED_CONTROLS[index] });
		}
		release();
		await eventually(() => run.registry.get('agent-a').goalRevision === 3);
		assert.equal(planner.requests.some((request) => wake(request).event === 'player_death'), false, 'no death input reached the provider');
		if (delayedMemory) await eventually(() => rows.some(({ event, errorCode }) => event === 'native_turn_failed' && errorCode === 'STALE_PLAN'));
		run.bridge.emit('observation', observation(2, { goalRevision: 3 }));
		await eventually(() => planner.requests.some((request) => request.goalRevision === 3));
		const resumed = () => planner.requests.filter((request) => request.goalRevision === 3);
		assert.equal(instructionOf(resumed()[0]), compactEventInstruction(NEW_CONTEXT_EVENT_INSTRUCTION));
		assert.match(wake(resumed()[0]).situation, /^overworld/);
		await eventually(() => rows.some(({ event, goalRevision }) => event === 'native_turn_completed' && goalRevision === 3));
		run.bridge.emit('observation', observation(3, { goalRevision: 3 }));
		await eventually(() => resumed().length === 2);
		assert.match(instructionOf(resumed()[1]), GENERIC, 'only successful assessment delivery consumes it');
	} finally { release(); await run.coordinator.stop(); }
});
