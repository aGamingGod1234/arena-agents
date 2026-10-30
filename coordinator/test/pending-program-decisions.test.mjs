import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { decodeModelFacts } from '../src/model-fact-encoding.mjs';
import { DECISION_REMINDER_INTERVAL_MS, NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { FakePlanner, eventually, ManualTimerQueue, resolveNativeSteerInput, start } from './fixtures/dynamic-main-fixture.mjs';

const payload = request => decodeModelFacts(JSON.parse(request.input.slice(request.input.indexOf('\n') + 1)));
const tick = () => new Promise(setImmediate);

async function fixture(t, { policy = 'pause_and_notify' } = {}) {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), timers = new ManualTimerQueue();
	const traces = [], steers = [], completions = [];
	let installed;
	planner.steerNativeTurn = async request => { await resolveNativeSteerInput(request); steers.push(request); };
	planner.requestNativeTurn = async request => {
		planner.requests.push(request);
		if (planner.requests.length === 1) {
			installed = await request.executeTool({ agentId: request.agentId, goalRevision: 1, turnId: 'initial', callId: 'program',
				tool: { kind: 'run_program', background: true, timeoutMs: 120000,
					source: `program.onUnhandledAttention("${policy}", {survival:"${policy}"}); await player.wait(100000);` } });
			return { status: 'completed', toolCalls: 1 };
		}
		return new Promise(resolve => { completions.push(resolve); });
	};
	const run = await start({ registry, planner, goalSchedule: timers.schedule, cancelGoalSchedule: timers.cancel,
		traceWriter: { write: (event, fields) => traces.push({ event, ...fields }) },
		config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	t.after(async () => { await run.coordinator.stop(); for (const resolve of completions) resolve({ status: 'completed', toolCalls: 0 }); });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Explore safely.' } });
	let sequence = 1;
	const observe = (health = 20, attention = false) => run.bridge.emit('observation', { agentId: 'agent-a', payload: {
		goalRevision: 1, eventSequence: sequence++, attention, changedFacts: attention ? ['player.health'] : [],
		observation: { player: { x: 0, y: 64, z: 0, health } },
	} });
	observe();
	await eventually(() => traces.some(row => row.event === 'native_turn_completed'));
	const execute = (request, tool) => request.executeTool({ agentId: request.agentId, goalRevision: 1, turnId: 'decision', callId: `call-${sequence++}`, tool });
	const cancelBody = async () => {
		await eventually(() => run.bridge.sent.some(row => row.type === 'action_cancel'));
		const cancel = run.bridge.sent.find(row => row.type === 'action_cancel');
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence++,
			actionId: cancel.payload.actionId, state: 'CANCELLED', reasonCode: 'CANCELLED' } });
	};
	return { ...run, planner, traces, steers, completions, observe, execute, cancelBody, installed };
}

test('an empty completed decision turn re-asks with the same live handle and concrete choices', async t => {
	const h = await fixture(t);
	h.observe(18, true);
	await h.cancelBody();
	await eventually(() => h.planner.requests.length === 2);
	const first = payload(h.planner.requests[1]);
	assert.ok(first.program.decision);
	h.completions[0]({ status: 'completed', toolCalls: 0 });
	await eventually(() => h.planner.requests.length === 3);
	const reminder = h.planner.requests[2], shown = payload(reminder);
	assert.match(shown.program.decision.request, /Call respondProgram before ending this turn/);
	assert.equal(shown.program.programId, h.installed.programId);
	assert.equal(shown.program.decision.decisionId, first.program.decision.decisionId);
	assert.ok(shown.program.decision.directives.includes('replace'));
	assert.ok(shown.program.decision.directives.includes('pause'));
	assert.equal(h.traces.filter(row => row.event === 'native_program_decision_followup').length, 1);
	assert.equal(h.bridge.sent.filter(row => row.type === 'action_command').length, 1, 'reminding authors no body action');
	assert.equal(h.steers.length, 0, 'the follow-up starts after completion instead of preempting inference');
});

test('a danger steer carries the live decision and fresh permitted options even when its envelope is an observation', async t => {
	const h = await fixture(t, { policy: 'continue_and_notify' });
	h.observe(18, true);
	await eventually(() => h.planner.requests.length === 2);
	const first = payload(h.planner.requests[1]);
	h.observe(10, true);
	await eventually(() => h.steers.length > 0);
	const shown = payload(h.steers.at(-1));
	assert.equal(shown.program.programId, first.program.programId);
	assert.equal(shown.program.decision.decisionId, first.program.decision.decisionId);
	assert.match(shown.program.decision.request, /Call respondProgram before ending this turn/);
	assert.ok(shown.program.decision.directives.includes('continue'), 'the presented fresh facts can be answered directly');
	const response = await h.execute(h.planner.requests[1], { kind: 'respond_program', programId: shown.program.programId,
		decisionId: shown.program.decision.decisionId, eventSequence: shown.program.decision.eventSequence, directive: 'continue' });
	assert.equal(response.engineState, 'ACTIVE');
	assert.equal(response.decision, undefined);
	h.completions[0]({ status: 'completed', toolCalls: 1 });
	await tick(); await tick();
	assert.equal(h.traces.filter(row => row.event === 'native_program_decision_followup').length, 0, 'answered decisions do not get reminders');
	assert.equal(h.bridge.sent.filter(row => row.type === 'action_command').length, 1, 'the existing authored action keeps running');
});

test('a fresh turn after an unrelated wake retains an unanswered program decision', async t => {
	const h = await fixture(t, { policy: 'continue_and_notify' });
	h.observe(18, true);
	await eventually(() => h.planner.requests.length === 2);
	const decision = payload(h.planner.requests[1]).program.decision;
	// Conversation is another real entry point that used to omit the pending program entirely.
	h.bridge.emit('conversation_event', { agentId: 'agent-a', payload: { sequence: 1, goalRevision: 1,
		kind: 'player_message', scope: 'direct', recipientId: 'agent-a', observedAtEpochMs: 2,
		sourceId: '00000000-0000-4000-8000-000000000001', sourceName: 'Lucas', operator: false, text: 'How is it going?' } });
	await eventually(() => h.steers.some(request => payload(request).event === 'player_message'));
	const conversation = payload(h.steers.find(request => payload(request).event === 'player_message'));
	assert.equal(conversation.program.decision.decisionId, decision.decisionId);
	assert.equal(conversation.conversation.entries[0].text, 'How is it going?');
	h.completions[0]({ status: 'completed', toolCalls: 0 });
	await eventually(() => h.planner.requests.length === 3);
	const shown = payload(h.planner.requests[2]);
	assert.equal(shown.program.decision.decisionId, decision.decisionId);
	assert.ok(shown.program.decision.directives.length > 0);
});

test('an attention delivery queued before replacement cannot resurrect the answered handle or old program version', async t => {
	const h = await fixture(t, { policy: 'continue_and_notify' });
	h.observe(18, true);
	await eventually(() => h.planner.requests.length === 2);
	const request = h.planner.requests[1], first = payload(request).program;
	let release, waiting;
	const gate = new Promise(resolve => { release = resolve; });
	t.after(release);
	h.planner.steerNativeTurn = async request => { waiting = request; await gate; await resolveNativeSteerInput(request); h.steers.push(request); };
	h.observe(16, true);
	await eventually(() => waiting !== undefined);
	await h.execute(request, { kind: 'respond_program', programId: first.programId,
		decisionId: first.decision.decisionId, eventSequence: first.decision.eventSequence, directive: 'replace',
		source: 'program.onUnhandledAttention("continue_and_notify", {survival:"continue_and_notify"}); await player.wait(90000);' });
	await h.cancelBody();
	let current;
	for (let index = 0; index < 10; index++) {
		current = await h.execute(request, { kind: 'program_status', programId: first.programId });
		if (current.programVersion === 2) break;
		await tick();
	}
	assert.equal(current.programVersion, 2);
	assert.equal(current.decision, undefined);
	release();
	await eventually(() => h.steers.length > 0);
	const shown = payload(h.steers.at(-1));
	assert.equal(shown.program.programVersion, 2, 'the queued version-1 envelope is refreshed before delivery');
	assert.equal(shown.program.decision, undefined, 'decision-1 was already answered by the model');
	const history = shown.mergedEvents.filter(event => event.program?.decision?.decisionId === first.decision.decisionId);
	assert.equal(history.length, 1, 'owed historical facts are retained once');
	assert.equal(history[0].program.decision.historical, true);
	assert.equal(history[0].program.decision.request, undefined);
	assert.equal(h.bridge.sent.filter(row => row.type === 'action_command').length, 2, 'only the two authored waits execute');
});

function executorFixture(t) {
	const record = { agentId: 'pending', goalRevision: 1, provider: 'codex', model: 'selected-model', reasoningEffort: 'low' };
	const observation = health => ({ player: { x: 0, y: 64, z: 0, health }, inventory: { items: [] }, entities: [], items: [], blocks: [] });
	let now = 1000, finishAction;
	const timers = [], decisions = [];
	const executor = new NativeProgramExecutor({ now: () => now,
		setTimeoutFn: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { if (timer) timer.cleared = true; },
	});
	const result = executor.run(record, { programId: 'pending', timeoutMs: 120000,
		source: 'program.onUnhandledAttention("continue_and_notify", {survival:"continue_and_notify"}); await player.wait(100000);' }, {
		observation: observation(20), eventSequence: 1, executeAction: () => new Promise(resolve => { finishAction = resolve; }),
		cancelAction: async () => { finishAction?.({ state: 'CANCELLED', reasonCode: 'CANCELLED' }); },
		onDecision: status => decisions.push(status.decision),
	});
	t.after(() => executor.cancel(record.agentId));
	const observe = (health, sequence, attention = true) => executor.onObservation(record, { observation: observation(health),
		eventSequence: sequence, attention, priority: 'urgent', trigger: 'damage' });
	return { executor, record, result, timers, decisions, observe, advance: ms => { now += ms; } };
}

test('repeated unanswered completions keep requesting the decision, paced and cancelled by a fresh model input or answer', async t => {
	const h = executorFixture(t);
	await tick(); h.observe(18, 2); await tick();
	assert.equal(h.decisions.length, 1);
	assert.equal(h.executor.remindDecision(h.record), true);
	assert.equal(h.decisions.length, 2, 'the first unanswered completion is re-asked immediately');
	assert.equal(h.executor.remindDecision(h.record), true);
	const waiting = h.timers.find(timer => timer.ms === DECISION_REMINDER_INTERVAL_MS && !timer.cleared);
	assert.ok(waiting, 'a rapid second empty completion is paced');
	assert.equal(h.decisions.length, 2);
	h.executor.status(h.record);
	assert.equal(waiting.cleared, false, 'an internal status read does not consume the follow-up');
	h.executor.status(h.record, { presentDecision: true });
	assert.equal(waiting.cleared, true, 'another model input takes ownership instead of receiving a timer steer');
	waiting.callback();
	assert.equal(h.decisions.length, 2, 'a cancelled callback cannot preempt inference');
	h.executor.remindDecision(h.record);
	const next = h.timers.at(-1);
	waiting.callback();
	h.advance(DECISION_REMINDER_INTERVAL_MS); next.callback();
	assert.equal(h.decisions.length, 3, 'a still-unanswered decision is not forgotten after one reminder');
	h.executor.remindDecision(h.record);
	const afterAnswer = h.timers.at(-1);
	await h.executor.respond(h.record, { programId: 'pending', decisionId: h.decisions.at(-1).decisionId, directive: 'pause' });
	assert.equal(afterAnswer.cleared, true);
	afterAnswer.callback();
	assert.equal(h.decisions.length, 3);
	assert.equal(h.executor.remindDecision(h.record), false);
});

test('presenting fresh pending facts permits their answer while earlier unshown danger still fails the stale-facts gate', async t => {
	const h = executorFixture(t);
	await tick(); h.observe(18, 2); await tick();
	const old = h.decisions[0];
	h.observe(8, 3, false);
	assert.equal(h.decisions.length, 1, 'quiet facts do not issue a new attention wake');
	const response = { kind: 'respond_program', programId: 'pending', decisionId: old.decisionId, eventSequence: old.eventSequence, directive: 'continue' };
	assert.equal(h.executor.operationRejection(h.record, response)?.code, 'STALE_PROGRAM_DECISION');
	const fresh = h.executor.status(h.record, { presentDecision: true }).decision;
	assert.equal(fresh.eventSequence, 3);
	assert.ok(fresh.directives.includes('continue'));
	assert.equal(h.executor.operationRejection(h.record, response)?.code, 'STALE_PROGRAM_DECISION', 'presenting newer facts does not bless an older response');
	const answered = h.executor.respond(h.record, { ...response, eventSequence: fresh.eventSequence });
	assert.equal(answered.engineState, 'ACTIVE');
	assert.equal(answered.decision, undefined);
});
