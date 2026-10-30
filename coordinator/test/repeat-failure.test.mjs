import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { RepeatedFailureLedger } from '../src/repeated-failure.mjs';

const at = (x, z, observedAtEpochMs) => ({ position: { x, y: 66, z }, observedAtEpochMs });

test('a first failure carries no repeat fact', () => {
	const ledger = new RepeatedFailureLedger();
	assert.equal(ledger.record('a', { goalRevision: 1, actionType: 'move_to', arguments: { x: 1 }, state: 'FAILED', reasonCode: 'NO_PATH', observation: at(-30.7, -36.5, 1_000) }), null);
});

test('repeated failures from one block say how often, how recently and how many were identical', () => {
	const ledger = new RepeatedFailureLedger();
	const fail = (args, ms, observation = at(-30.7, -36.5, ms)) => ledger.record('a', { goalRevision: 1, actionType: 'move_to', arguments: args, state: 'FAILED', reasonCode: 'NO_PATH', observation });
	fail({ x: -48 }, 178_000);
	assert.equal(fail({ x: -87 }, 193_000), '2nd from this block in 15s');
	assert.equal(fail({ x: -87 }, 198_000, at(-30.2, -36.9, 198_000)), '3rd from this block in 20s; 2 identical');
	assert.equal(fail({ x: -12 }, 206_000), '4th from this block in 28s');
});

test('a different block, reason, goal or an old failure does not count as a repeat', () => {
	const ledger = new RepeatedFailureLedger();
	const base = { goalRevision: 1, actionType: 'move_to', arguments: { x: 5 }, state: 'FAILED', reasonCode: 'NO_PATH' };
	ledger.record('a', { ...base, observation: at(0.5, 0.5, 1_000) });
	assert.equal(ledger.record('a', { ...base, observation: at(1.5, 0.5, 2_000) }), null, 'another block');
	assert.equal(ledger.record('a', { ...base, reasonCode: 'NO_STANDABLE_PATH', observation: at(0.5, 0.5, 3_000) }), null, 'another reason');
	assert.equal(ledger.record('a', { ...base, goalRevision: 2, observation: at(0.5, 0.5, 4_000) }), null, 'another goal');
	assert.equal(ledger.record('a', { ...base, goalRevision: 2, observation: at(0.5, 0.5, 70_000) }), null, 'older than the window');
	assert.equal(ledger.record('a', { ...base, goalRevision: 2, state: 'CANCELLED', observation: at(0.5, 0.5, 71_000) }), null, 'cancellation is not a failure');
	assert.equal(ledger.record('b', { ...base, goalRevision: 2, observation: at(0.5, 0.5, 72_000) }), null, 'another agent');
	ledger.forget('a');
	assert.equal(ledger.record('a', { ...base, goalRevision: 2, observation: at(0.5, 0.5, 72_000) }), null, 'forgotten history');
});

const runtimeRecord = { agentId: 'agent-a', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority', goalRevision: 3, currentGoal: 'explore' };
const call = (callId, args) => ({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn', callId, tool: { kind: 'action', actionType: 'move_to', arguments: args } });

test('the model sees the repeat fact on its second NO_PATH from the same block', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	const results = [];
	for (const [index, x] of [-48, -87].entries()) {
		const pending = runtime.execute(call(`call-${index}`, { x, y: 68, z: -26, tolerance: 3 }), runtimeRecord);
		await new Promise(resolve => setImmediate(resolve));
		runtime.onActionResult(runtimeRecord, { actionId: sent.at(-1).actionId, state: 'FAILED', reasonCode: 'NO_PATH', executionStarted: true, physicalAttempted: true,
			actionObservation: { position: { x: -30.7, y: 66, z: -36.5 }, observedAtEpochMs: 1_000_000 + index * 15_000 } });
		results.push(await pending);
	}
	assert.equal(results[0].failure.repeat, undefined);
	assert.equal(results[1].failure.repeat, '2nd from this block in 15s');
});

const programRecord = { agentId: 'repeat-program', goalRevision: 1, provider: 'claude', model: 'selected-model', reasoningEffort: 'low', serviceTier: 'priority' };
const quiet = () => ({ player: { x: 29.5, y: 48, z: 30.5, health: 15 }, entities: [], items: [], blocks: [], inventory: { items: [], tagCounts: {} } });
const turn = () => new Promise(resolve => setImmediate(resolve));

function programSetup(t, source) {
	let sequence = 1;
	const decisions = [];
	const commands = [];
	const pending = [];
	const executor = new NativeProgramExecutor({ setTimeoutFn: () => ({}), clearTimeoutFn: () => {}, now: () => 1_000_000 });
	const completion = executor.run(programRecord, { programId: 'mine-loop', source: source ?? `program.onUnhandledAttention("continue_and_notify");
		await program.repeatUntil(() => false, { maxIterations: 8 }, async () => {
			await player.mine({ x: 29, y: 49, z: 29, expectedBlockId: "minecraft:blackstone", timeoutMs: 8000 });
		});` }, {
		observation: quiet(), eventSequence: 1,
		executeAction: async (command) => {
			commands.push(command);
			if (command.action.type !== 'break_block') return new Promise((resolve) => pending.push(resolve));
			return { state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE', executionStarted: false, physicalAttempted: false,
				message: 'The requested block is not the exact block under the crosshair',
				actionObservation: { position: { x: 29.521, y: 48, z: 30.479 }, yaw: 75.714, pitch: 10.784,
					lookedAt: { type: 'block', id: 'minecraft:blackstone', position: { x: 27, y: 49, z: 30 } },
					target: { kind: 'block', position: { x: 29, y: 49, z: 29 } } },
				observation: quiet(), eventSequence: ++sequence };
		},
		cancelAction: async () => { for (const resolve of pending.splice(0)) resolve({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED', observation: quiet(), eventSequence: ++sequence }); return { state: 'CANCELLED' }; },
		onDecision: (status) => decisions.push(status),
	});
	t.after(() => executor.cancel(programRecord.agentId));
	return { executor, decisions, commands, completion, observe: () => executor.onObservation(programRecord, { observation: quiet(), eventSequence: ++sequence, attention: false }) };
}

test('unhandled rejected clicks retain the existing eight-failure limit with concrete evidence', async t => {
	const run = programSetup(t);
	for (let index = 0; index < 6; index++) await turn();
	assert.equal(run.commands.length, 8, 'no new pose-based halt intercepts authored retries');
	const decision = run.executor.status(programRecord).decision;
	assert.equal(decision.trigger, 'action_failure');
	assert.equal(decision.actionFailure.repeats, 8);
	assert.equal(decision.actionFailure.noEffect, true);
	assert.equal(decision.actionFailure.detail, 'The requested block is not the exact block under the crosshair; crosshair on minecraft:blackstone at 27,49,30');
});

test('a replacement answering a halted routine survives routine observations that arrive while the model writes it', async t => {
	const run = programSetup(t);
	for (let index = 0; index < 6; index++) await turn();
	const decision = run.executor.status(programRecord).decision;
	for (let index = 0; index < 7; index++) run.observe();
	const status = run.executor.respond(programRecord, { programId: 'mine-loop', decisionId: decision.decisionId, eventSequence: decision.eventSequence,
		directive: 'replace', source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1);' });
	assert.equal(status.decision, undefined, 'quiet samples are not new danger, so the replacement installs');
	await turn();
	assert.equal(run.commands.at(-1).action.type, 'wait');
});

test('a stale decision handle is told which decision is pending', async t => {
	const run = programSetup(t);
	for (let index = 0; index < 6; index++) await turn();
	const decision = run.executor.status(programRecord).decision;
	assert.throws(() => run.executor.respond(programRecord, { programId: 'mine-loop', decisionId: 'invented', directive: 'replace', source: 'await player.wait(1);' }),
		(error) => error.code === 'STALE_PROGRAM_DECISION' && error.message.includes(`"decisionId":"${decision.decisionId}"`) && error.message.includes('"trigger":"action_failure"'));
	assert.throws(() => run.executor.respond(programRecord, { programId: 'other-program', decisionId: decision.decisionId, directive: 'pause' }),
		(error) => error.code === 'STALE_PROGRAM_DECISION' && error.message.includes('the running program is mine-loop'));
});

test('evicted repeat history reports lower bounds instead of exact ordinals', () => {
	const ledger = new RepeatedFailureLedger();
	const fail = ms => ledger.record('a', { goalRevision: 1, actionType: 'move_to', arguments: { x: 5 }, state: 'FAILED', reasonCode: 'NO_PATH', observation: at(0.5, 0.5, ms) });
	let fact;
	for (let ms = 1; ms <= 30; ms++) fact = fail(ms);
	assert.equal(fact, '17+ from this block in 1s; 17+ identical');
	assert.equal(fail(61_000), null, 'expired omissions no longer make counts uncertain');
	assert.equal(fail(62_000), '2nd from this block in 1s; 2 identical');
});

test('interleaved keys, goal changes and forgetting preserve truthful bounded counts', () => {
	const ledger = new RepeatedFailureLedger();
	const fail = (ms, reasonCode = 'NO_PATH', goalRevision = 1, args = { x: 5 }) => ledger.record('a', { goalRevision, actionType: 'move_to', arguments: args, state: 'FAILED', reasonCode, observation: at(0.5, 0.5, ms) });
	fail(1);
	for (let ms = 2; ms <= 17; ms++) fail(ms, 'OTHER_FAILURE');
	assert.equal(fail(18), null, 'an evicted key has no retained repeat');
	assert.equal(fail(19, 'NO_PATH', 1, { x: 6 }), '2+ from this block in 1s');
	assert.equal(fail(20), '3+ from this block in 1s; 2+ identical');
	assert.equal(fail(21, 'NO_PATH', 2), null);
	assert.equal(fail(22, 'NO_PATH', 2), '2nd from this block in 1s; 2 identical');
	ledger.forget('a');
	assert.equal(fail(23, 'NO_PATH', 2), null);
});

test('the native program path leaves second-failure fallback to the authored handler', async t => {
	const run = programSetup(t, `program.onUnhandledAttention("continue_and_notify");
		await program.repeatUntil(() => false, { maxIterations: 3 }, async () => {
			const result = await player.mine({ x: 29, y: 49, z: 29, expectedBlockId: "minecraft:blackstone", timeoutMs: 8000 });
			if (result.repeat === 2 && result.noEffect && result.detail === "The requested block is not the exact block under the crosshair; crosshair on minecraft:blackstone at 27,49,30") program.finish("authored second-failure fallback");
		});`);
	for (let index = 0; index < 6; index++) await turn();
	assert.equal(run.commands.length, 2);
	const outcome = await run.completion;
	assert.equal(outcome.reasonCode, 'PROGRAM_FINISH_REQUESTED');
	assert.equal(outcome.finishRequested, true);
	assert.equal(run.executor.status(programRecord), null, 'finished programs leave the active registry');
	assert.equal(run.decisions.length, 0);
});
