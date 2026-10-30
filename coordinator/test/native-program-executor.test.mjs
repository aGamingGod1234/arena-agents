import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { MAX_RECEIPT_MESSAGE_BYTES, NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { validateAction } from '../src/schema.mjs';
import { encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';

const record = { agentId: 'agent-a', goalRevision: 1, provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'priority' };
const prefix = 'program.onUnhandledAttention("continue_and_notify");';
function observation(health = 20) { return { player: { x: 0, y: 64, z: 0, health }, entities: [], items: [], blocks: [], inventory: { items: [], tagCounts: {} } }; }
function turn() { return new Promise((resolve) => setImmediate(resolve)); }
function setup(overrides = {}, options = {}) {
	let sequence = 1;
	const commands = [], cancels = [];
	const executor = new NativeProgramExecutor(options);
	const context = { observation: observation(), eventSequence: sequence,
		executeAction: async (command) => { commands.push(command); return { state: 'SUCCEEDED', reasonCode: 'DONE' }; },
		cancelAction: async (actionId, reason) => { cancels.push({ actionId, reason }); },
		refreshObservation: async () => ({ observation: observation(), eventSequence: ++sequence }), ...overrides };
	return { executor, context, commands, cancels };
}

test('terminal action receipts keep raw classifier facts while scripts receive the shared visible harm rate', async () => {
	const raw = { ...observation(17.25), world: { gameTime: 12000 }, player: {
		...observation(17.25).player, absorption: 1.25, saturation: 4.25, fireTicks: 137, air: 58,
		harm: { source: 'minecraft:on_fire', hpLossPerSecond: 2.3 },
	} };
	const run = setup({ executeAction: async () => ({ state: 'SUCCEEDED', reasonCode: 'DONE', observation: raw, eventSequence: 2 }) });
	const received = [];
	const onObservation = run.executor.onObservation;
	run.executor.onObservation = function (record, payload) { received.push(payload.observation); return onObservation.call(this, record, payload); };
	const result = await run.executor.run(record, { source: `${prefix} await player.wait(1);
		if (player.state().harm.source !== "minecraft:on_fire" || player.state().harm.hpLossPerSecond !== 2.3) program.checkpoint("wrong");
		program.finish("shared");` }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_FINISH_REQUESTED');
	assert.equal(result.finishRequested, true);
	assert.equal(received.length, 1);
	assert.equal(received[0].player.health, 17.25);
	assert.equal(received[0].player.absorption, 1.25);
	assert.equal(received[0].player.saturation, 4.25);
	assert.equal(received[0].player.fireTicks, 137);
	assert.equal(received[0].player.air, 58);
	assert.equal(received[0].world.gameTime, 12000);
	assert.equal(received[0].player.harm.hpLossPerSecond, 2.3);
});

test('ArenaScript taskMemory reaches the same validated durable memory operation without a body action', async () => {
	const requests = [];
	const run = setup({ memoryOperation: async (operation) => { requests.push(operation); return { state: 'SUCCEEDED', reasonCode: 'TASK_MEMORY_WRITTEN' }; } });
	const result = await run.executor.run(record, { source: `${prefix} await world.taskMemory({operation:"remember",entry:{kind:"place",key:"base",label:"Base",summary:"Observed entrance",position:{x:0,y:64,z:0}}});` }, run.context);
	assert.equal(requests.length, 1); assert.equal(requests[0].operation, 'task'); assert.equal(requests[0].arguments.entry.key, 'base');
	assert.equal(requests[0].provenance.model, record.model); assert.equal(run.commands.length, 0); assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
});

// A11 F1: the validator's text was dropped, so the model read blockedBy "not reported" for a bad faceMode.
test('an invalid action argument ends the program with the validator text', async () => {
	const run = setup();
	const result = await run.executor.run(record, { source: `${prefix}
		await player.placeBlock({ x: 1, y: 64, z: 1, face: "up", itemId: "minecraft:cobblestone", faceMode: "auto" });
	` }, run.context);
	assert.equal(result.reasonCode, 'INVALID_FIELD');
	assert.match(result.message, /^player.placeBlock: action.faceMode must be one of preferred, strict; legal fields: .*; required:/);
	const shown = JSON.parse(presentNativeToolResult(result, { kind: 'run_program' }).response.contentItems[0].text);
	assert.equal((shown.data ?? shown).failure.blockedBy, result.message);
	assert.equal(run.commands.length, 0);
});

test('explicit ranged options survive ArenaScript execution', async () => {
	const run = setup();
	const result = await run.executor.run(record, { source: `${prefix}
		await player.useRanged({ targetId: "11111111-1111-1111-1111-111111111111", drawDurationMs: 1000, timeoutMs: 3000, aimX: 2, aimY: 65, aimZ: 3 });
		await player.useItem({ durationMs: 1000, mode: "once", aimX: 55, aimY: 72, aimZ: 8 });
		await player.useItem({ durationMs: 1, mode: "inspect", aimX: 60, aimY: 65, aimZ: 0 });
	` }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(run.commands[0].action.arguments.aimY, 65);
	assert.deepEqual(run.commands[1].action.arguments, { durationMs: 1000, mode: 'once', aimX: 55, aimY: 72, aimZ: 8 });
	assert.deepEqual(run.commands[2].action.arguments, { durationMs: 1, mode: 'inspect', aimX: 60, aimY: 65, aimZ: 0 });
});

test('a reusable authored routine takes detached coordinates and counts while observations and identity stay authoritative', async () => {
	const source = `${prefix}
		const args = program.parameters();
		for (const target of args.targets) await player.navigateTo({ x: target.x, y: target.y, z: target.z, tolerance: 1, sprint: false, timeoutMs: 5000 });
		await player.craftInventory({ recipeId: args.recipeId, count: args.count, timeoutMs: 5000 });
		await player.wait(player.state().health);
	`;
	const original = { targets: [{ x: 2, y: 64, z: 3 }], recipeId: 'minecraft:planks', count: 1,
		observation: observation(99), agentId: 'other-agent', goalRevision: 999, model: 'other-model' };
	const first = setup({ refreshObservation: async () => ({ observation: observation(18), eventSequence: ++sequence }) });
	let sequence = 1;
	const pending = first.executor.run(record, { source, parameters: original }, first.context);
	original.targets[0].x = 99; original.count = 99;
	const one = await pending;
	assert.equal(first.commands[0].action.arguments.x, 2);
	assert.equal(first.commands[1].action.arguments.count, 1);
	assert.equal(first.commands[2].action.arguments.durationMs, 18);
	for (const command of first.commands) {
		assert.equal(command.provenance.agentId, record.agentId);
		assert.equal(command.provenance.goalRevision, record.goalRevision);
		assert.equal(command.provenance.model, record.model);
	}
	assert.equal(one.actionsSucceeded, 3); assert.equal(one.actionsFailed, 0); assert.equal(one.programVersion, 1);
	const second = setup();
	const two = await second.executor.run(record, { source, parameters: { targets: [{ x: 5, y: 65, z: 6 }, { x: 7, y: 66, z: 8 }], recipeId: 'minecraft:planks', count: 2 } }, second.context);
	assert.deepEqual(second.commands.filter((command) => command.action.type === 'navigate_to').map((command) => command.action.arguments.x), [5, 7]);
	assert.equal(second.commands[2].action.arguments.count, 2);
	assert.equal(two.actionsSucceeded, 4); assert.equal(two.actionsFailed, 0);
	assert.equal(one.reasonCode, 'PROGRAM_EXHAUSTED'); assert.equal(two.reasonCode, 'PROGRAM_EXHAUSTED');
});

test('executor rejects invalid parameter data before installing timers or dispatching actions', () => {
	const timers = [];
	const run = setup({}, { setTimeoutFn: (...args) => { timers.push(args); } });
	for (const parameters of [{ count: Infinity }, JSON.parse('{"__proto__":{}}'), { value: 'x'.repeat(4096) }]) {
		assert.throws(() => run.executor.run(record, { source: `${prefix} await player.wait(1);`, parameters }, run.context), (error) => error.code === 'INVALID_PROGRAM_PARAMETERS');
	}
	assert.equal(timers.length, 0);
	assert.equal(run.commands.length, 0);
	assert.equal(run.executor.status(record), null);
});

test('an authored known cave leg consumes fresh progress without another decision or broad inspection', async () => {
	let sequence = 1, release, current = { ...observation(), blocks: [{stableId:'landing',blockId:'minecraft:stone',x:6,y:63,z:2}] };
	const decisions = [], inspections = [], commands = [];
	const run = setup({ observation: current,
		executeAction: (command) => { commands.push(command); return new Promise(resolve => { release = resolve; }); },
		onDecision: (status) => decisions.push(status), inspect: (query) => { inspections.push(query); },
		refreshObservation: async () => ({observation:current,eventSequence:++sequence}),
	});
	const pending = run.executor.run(record, { source: `program.onUnhandledAttention("pause_and_notify", {reassessWhen:() => world.blocks({stableId:"landing",blockId:"minecraft:stone"}).length !== 1 || world.entities().length > 0});
		for (const leg of program.parameters().legs) {
			const moved = await player.navigateTo({x:leg.x,y:leg.y,z:leg.z,tolerance:0.4,sprint:false,timeoutMs:5000});
			if (!moved.succeeded) program.checkpoint(moved.reason);
		}`,
		parameters: {legs:[{x:3,y:64,z:0},{x:6,y:64,z:2}]},
	}, run.context);
	for (const [index, point] of [{x:3,y:64,z:0},{x:6,y:64,z:2}].entries()) {
		for (let update = 0; update < 3; update++) {
			current = {...current,player:{...current.player,...point}};
			run.executor.onObservation(record,{observation:current,eventSequence:++sequence,attention:true,trigger:'attention'});
		}
		assert.equal(run.executor.status(record).decision, undefined);
		release({state:'SUCCEEDED',reasonCode:'DESTINATION_REACHED'});
		await turn();
		assert.equal(commands.length, Math.min(2,index+2));
	}
	const result = await pending;
	assert.deepEqual(commands.map(command => command.action.arguments.x), [3,6]);
	assert.equal(result.reasonCode,'PROGRAM_EXHAUSTED'); assert.equal(result.actionsSucceeded,2);
	assert.deepEqual(decisions,[]); assert.deepEqual(inspections,[]); assert.deepEqual(run.cancels,[]);
});

test('a missing observed landing yields before the next cave leg and cancels only the selected action', async () => {
	let sequence = 1, release, current = {...observation(),blocks:[{stableId:'landing',blockId:'minecraft:stone',x:6,y:63,z:2}]};
	const commands = [], cancelled = [];
	const run = setup({observation:current,
		executeAction: command => {commands.push(command); return new Promise(resolve => {release = resolve;});},
		cancelAction: async actionId => {cancelled.push(actionId); release({state:'CANCELLED',reasonCode:'INPUT_RELEASED'});},
		refreshObservation: async () => ({observation:current,eventSequence:++sequence}),
	});
	const pending = run.executor.run(record,{source:`program.onUnhandledAttention("pause_and_notify", {reassessWhen:() => world.blocks({stableId:"landing",blockId:"minecraft:stone"}).length !== 1}); await player.navigateTo({x:3,y:64,z:0,tolerance:0.4,sprint:false,timeoutMs:5000}); await player.navigateTo({x:6,y:64,z:2,tolerance:0.4,sprint:false,timeoutMs:5000});`},run.context);
	current = {...current,blocks:[]};
	run.executor.onObservation(record,{observation:current,eventSequence:++sequence,attention:true,trigger:'attention'});
	const result = await pending;
	assert.equal(result.reasonCode,'MODEL_DECISION_REQUIRED'); assert.equal(commands.length,1);
	assert.deepEqual(cancelled,[commands[0].actionId]); assert.equal(result.actionsFailed,1);
});

test('an authored blocked-leg checkpoint stops on its first receipt despite a false ordinary reassessment condition', async () => {
	const run = setup({executeAction:async command => {run.commands.push(command);return {state:'FAILED',reasonCode:'NO_STANDABLE_PATH'};}});
	const result = await run.executor.run(record,{source:`program.onUnhandledAttention("pause_and_notify",{reassessWhen:() => false});
		for (const leg of program.parameters().legs) {
			const moved = await player.navigateTo({x:leg.x,y:leg.y,z:leg.z,tolerance:0.4,sprint:false,timeoutMs:5000});
			if (!moved.succeeded) program.checkpoint(moved.reason);
		}`,parameters:{legs:[{x:3,y:64,z:0},{x:6,y:64,z:2}]},},run.context);
	assert.equal(result.reasonCode,'PROGRAM_CHECKPOINT'); assert.equal(result.actionsFailed,1);
	assert.equal(run.commands.length,1); assert.equal(result.receipts[0].reasonCode,'NO_STANDABLE_PATH');
});
test('a success-gated program does not chain from an unverified near stop', async () => {
	const run = setup({executeAction:async command => {run.commands.push(command);return {state:'FAILED',reasonCode:'DESTINATION_NEAR_UNVERIFIED'};}});
	const result = await run.executor.run(record,{source:`program.onUnhandledAttention("pause_and_notify",{reassessWhen:() => false});
		for (const leg of program.parameters().legs) {
			const moved = await player.navigateTo({x:leg.x,y:leg.y,z:leg.z,tolerance:0.4,sprint:false,timeoutMs:5000});
			if (!moved.succeeded) program.checkpoint(moved.reason);
		}`,parameters:{legs:[{x:3,y:64,z:0},{x:6,y:64,z:2}]},},run.context);
	assert.equal(result.reasonCode,'PROGRAM_CHECKPOINT'); assert.equal(result.actionsFailed,1);
	assert.equal(run.commands.length,1); assert.equal(result.receipts[0].reasonCode,'DESTINATION_NEAR_UNVERIFIED');
});

test('full-run terminal action counts preserve handled failures outside the receipt ring', async () => {
	let index = 0;
	const run = setup({ executeAction: async (command) => {
		run.commands.push(command);
		return index++ === 0 ? { state: 'FAILED', reasonCode: 'BLOCKED' } : { state: 'SUCCEEDED', reasonCode: 'DONE' };
	} });
	const result = await run.executor.run(record, { source: `${prefix} await tryResult(player.wait(1)); for (let i = 0; i < 64; i++) await player.wait(2);`, maxActions: 65 }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(result.actions, 65);
	assert.equal(result.actionsFailed, 1);
	assert.equal(result.actionsSucceeded, 64);
	assert.equal(result.omittedReceipts, 1);
	assert.equal(result.receipts.length, 64);
	assert.ok(result.receipts.every((receipt) => receipt.state === 'SUCCEEDED'));
});

test('expected duration schedules one advisory while preserving the original hard deadline', async () => {
	const timers = [], advisories = [];
	let release;
	const run = setup({ executeAction: () => new Promise((resolve) => { release = resolve; }), onPlanningDue: (status, details) => advisories.push({ status, details }),
		cancelAction: async () => release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }) },
		{ now: () => 0, setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeoutFn: () => {} });
	const pending = run.executor.run(record, { source: `${prefix} await player.wait(1);`, timeoutMs: 100, expectedDurationMs: 60, planningLeadMs: 25 }, run.context);
	assert.equal(timers[0].ms, 100);
	const advisory = timers.find((timer) => timer.ms === 35);
	assert.ok(advisory);
	advisory.callback(); advisory.callback();
	assert.equal(advisories.length, 1);
	assert.equal(run.cancels.length, 0);
	timers[0].callback();
	const result = await pending;
	assert.equal(result.reasonCode, 'PROGRAM_DEADLINE');
	assert.equal(result.actionsFailed, 1);
	assert.equal(result.actionsSucceeded, 0);
	assert.throws(() => run.executor.run(record, { source: prefix, timeoutMs: 100, expectedDurationMs: 101 }, run.context));
});

test('omitting expected duration leaves cold timing unknown instead of using timeout', async () => {
	const timers = [], advisories = [];
	let release;
	const run = setup({ executeAction: () => new Promise(resolve => { release = resolve; }), onPlanningDue: status => advisories.push(status),
		cancelAction: async () => release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }) },
		{ setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeoutFn: () => {} });
	const pending = run.executor.run(record, { source: `${prefix} await player.wait(1);`, timeoutMs: 100, planningLeadMs: 25 }, run.context);
	assert.equal(timers[0].ms, 100);
	assert.deepEqual(timers.map(timer => timer.ms), [100]);
	assert.equal(advisories.length, 0);
	assert.equal(run.cancels.length, 0);
	timers[0].callback();
	assert.equal((await pending).reasonCode, 'PROGRAM_DEADLINE');
});

test('measured continuation wakes before a short loop ends despite a long timeout', async () => {
	for (const loop of ['for (const target of program.parameters().targets)', 'for (let i = 0; i < 5; i++)', 'for (let i = 0; i < 5; i += 1)', 'for (let i = 5; i > 0; i -= 1)']) {
		const timers = [], advisories = [];
		let now = 0, release;
		const run = setup({ executeAction: command => { run.commands.push(command); return new Promise(resolve => { release = resolve; }); },
			onPlanningDue: (status, details) => advisories.push({ status, details }) }, {
			now: () => now,
			setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
			clearTimeoutFn: timer => { if (timer) timer.cleared = true; },
		});
		const pending = run.executor.run(record, { source: `${prefix} ${loop} { await player.wait(20); }`,
			parameters: { targets: [1, 2, 3, 4, 5] }, timeoutMs: 120_000, planningLeadMs: 40,
			...(loop.includes('+=') ? { expectedDurationMs: 100_000 } : {}) }, run.context);
		const obsoleteEstimate = timers.find(timer => timer.ms === 99_960);
		assert.equal(run.executor.status(record).timing.remainingActions, 5);
		for (let action = 0; action < 3; action++) {
			now += 20; release({ state: 'SUCCEEDED', reasonCode: 'DONE' }); await turn();
		}
		assert.equal(run.commands.length, 4);
		obsoleteEstimate?.callback(); assert.equal(advisories.length, 0, 'measured progress fences the older model estimate');
		const due = timers.findLast(timer => !timer.cleared && timer.ms === 0);
		assert.ok(due, 'two remaining 20 ms actions fit the measured 40 ms planning lead');
		due.callback(); due.callback();
		assert.equal(advisories.length, 1);
		assert.equal(advisories[0].details.basis, 'measured_progress');
		assert.equal(advisories[0].status.timing.remainingActions, 2);
		assert.equal(advisories[0].status.timing.estimatedRemainingMs, 40);
		assert.equal(advisories[0].status.timing.averageActionMs, 20);
		assert.deepEqual(run.cancels, []);
		for (let action = 3; action < 5; action++) {
			now += 20; release({ state: 'SUCCEEDED', reasonCode: 'DONE' }); await turn();
		}
		const result = await pending;
		assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
		assert.deepEqual(result.receipts.map(receipt => receipt.durationMs), [20, 20, 20, 20, 20]);
		assert.equal(result.timing.elapsedMs, 100);
		assert.deepEqual(result.timing.byAction, [{ actionType: 'wait', count: 5, averageMs: 20 }]);
		assert.equal(result.freshness.fresh, true);
		assert.deepEqual(result.observation.inventory, observation().inventory);
	}
});

test('unknown continuation never substitutes timeout for progress and stale cancelled timers stay inert', async () => {
	const timers = [], advisories = [];
	let release;
	const run = setup({ executeAction: () => new Promise(resolve => { release = resolve; }), onPlanningDue: status => advisories.push(status),
		cancelAction: async () => release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }) }, {
		now: () => 0, setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeoutFn() {},
	});
	const pending = run.executor.run(record, { source: `${prefix} async function work() { await player.wait(10); } for (let i = 0; i < 2; i++) await work();`, timeoutMs: 120_000, planningLeadMs: 5000 }, run.context);
	assert.equal(run.executor.status(record).timing.remainingActions, undefined);
	assert.deepEqual(timers.map(timer => timer.ms), [120_000]);
	await run.executor.cancel(record.agentId);
	const result = await pending;
	assert.equal(result.freshness.fresh, false, 'cancellation does not prove post-action effects');
	for (const timer of timers) timer.callback();
	assert.deepEqual(advisories, []);
});

test('final-action preparation works without planner telemetry', async () => {
	const timers = [], advisories = [];
	let now = 0, release;
	const run = setup({ executeAction: () => new Promise(resolve => { release = resolve; }), onPlanningDue: (status, details) => advisories.push({ status, details }) }, {
		now: () => now, setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeoutFn() {},
	});
	const pending = run.executor.run(record, { source: `${prefix} await player.wait(2000); await player.wait(2000);`, expectedDurationMs: 60_000, timeoutMs: 120_000 }, run.context);
	assert.deepEqual(timers.map(timer => timer.ms), [120_000]);
	now = 2000; release({ state: 'SUCCEEDED', reasonCode: 'DONE' }); await turn();
	const due = timers.findLast(timer => timer.ms === 0);
	assert.ok(due);
	due.callback();
	assert.equal(advisories.length, 1);
	assert.equal(advisories[0].details.basis, 'final_action');
	assert.equal(advisories[0].status.timing.averageActionMs, 2000);
	now = 4000; release({ state: 'SUCCEEDED', reasonCode: 'DONE' });
	assert.equal((await pending).reasonCode, 'PROGRAM_EXHAUSTED');
	due.callback(); assert.equal(advisories.length, 1);
});

test('an unresolved decision prevents natural exhaustion and remains visible in a deadline outcome', async () => {
	const timers = [];
	let clock = 0;
	const run = setup({ onDecision() {} }, { now: () => clock, setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeoutFn: () => {} });
	const pending = run.executor.run(record, { source: `${prefix} await player.wait(1);` }, run.context);
	run.executor.onObservation(record, { observation: observation(9), eventSequence: 2, attention: true, priority: 'urgent', trigger: 'health_changed' });
	await turn();
	assert.equal(run.executor.status(record).decision.trigger, 'health_changed');
	// The wait for an urgent answer is credited up to timeoutMs; past twice timeoutMs the deadline ends the program.
	clock = 10_000_000;
	timers[0].callback();
	const result = await pending;
	assert.equal(result.reasonCode, 'PROGRAM_DEADLINE');
	assert.equal(result.actionsSucceeded, 1);
	assert.equal(result.decision.priority, 'urgent');
	assert.equal(result.decision.trigger, 'health_changed');
});

test('a superseded continue is still rejected after an urgent decision replaces the facts', async () => {
	const decisions = [];
	let release;
	const run = setup({
		onDecision: status => decisions.push(status.decision),
		executeAction: () => new Promise(resolve => { release = resolve; }),
		cancelAction: async () => release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED', observation: observation(12), eventSequence: 4 }),
	});
	const pending = run.executor.run(record, { programId: 'superseded-continue', source: `${prefix} await player.wait(1000);` }, run.context);
	run.executor.onObservation(record, { observation: observation(20), eventSequence: 2, attention: true, priority: 'ordinary', trigger: 'resource_discovery' });
	await turn();
	const oldDecisionId = run.executor.status(record).decision.decisionId;
	run.executor.onObservation(record, { observation: observation(12), eventSequence: 3, attention: true, priority: 'urgent', trigger: 'damage' });
	await turn();
	assert.notEqual(run.executor.status(record).decision.decisionId, oldDecisionId);
	assert.throws(() => run.executor.respond(record, { programId: 'superseded-continue', decisionId: oldDecisionId, directive: 'continue' }), { code: 'STALE_PROGRAM_DECISION' });
	await run.executor.cancel(record.agentId);
	await pending;
});

for (const directive of ['pause', 'finish']) {
	test(`a superseded ${directive} applies to the live decision for the same program`, async () => {
		const decisions = [];
		let release;
		const run = setup({
			onDecision: status => decisions.push(status.decision),
			executeAction: () => new Promise(resolve => { release = resolve; }),
			cancelAction: async () => release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED', observation: observation(12), eventSequence: 4 }),
		});
		const programId = `superseded-${directive}`;
		const pending = run.executor.run(record, { programId, source: `${prefix} await player.wait(1000);` }, run.context);
		run.executor.onObservation(record, { observation: observation(20), eventSequence: 2, attention: true, priority: 'ordinary', trigger: 'resource_discovery' });
		await turn();
		const oldDecisionId = run.executor.status(record).decision.decisionId;
		run.executor.onObservation(record, { observation: observation(12), eventSequence: 3, attention: true, priority: 'urgent', trigger: 'damage' });
		await turn();
		assert.notEqual(run.executor.status(record).decision.decisionId, oldDecisionId);
		const result = await run.executor.respond(record, { programId, decisionId: oldDecisionId, directive });
		assert.equal(result.reasonCode, directive === 'pause' ? 'MODEL_PAUSED' : 'PROGRAM_FINISH_REQUESTED');
		await pending;
	});
}

test('source replacement keeps the run parameters and reports its final version and complete action totals', async () => {
	let release;
	const commands = [];
	const run = setup({
		onDecision() {},
		executeAction: (command) => {
			commands.push(command);
			return commands.length === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ state: 'SUCCEEDED', reasonCode: 'DONE' });
		},
		cancelAction: async () => release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }),
	});
	const pending = run.executor.run(record, { programId: 'parameter-replacement', source: `${prefix} await player.wait(1);`, parameters: { count: 9 } }, run.context);
	run.executor.onObservation(record, { observation: observation(9), eventSequence: 2, attention: true });
	const decision = run.executor.status(record).decision;
	run.executor.respond(record, { programId: 'parameter-replacement', decisionId: decision.decisionId, directive: 'replace', source: `${prefix} const args = program.parameters(); await player.wait(args.count);` });
	const result = await pending;
	assert.deepEqual(commands.map((command) => command.action.arguments.durationMs), [1, 9]);
	assert.equal(result.programVersion, 2);
	assert.equal(result.actionsSucceeded, 1);
	assert.equal(result.actionsFailed, 1);
	assert.equal(result.decision, undefined);
});

test('native programs use the same candidate arithmetic and exact authored commands, returning to their caller at exhaustion', async () => {
	const run = setup({ observation: { ...observation(), entities: [
		{ stableId: '11111111-1111-1111-1111-111111111111', type: 'minecraft:pig', x: 2, y: 64, z: 2, velocity: { x: 1, y: 0, z: 0 } },
	] } });
	const result = await run.executor.run(record, { source: `${prefix}
		let target = null;
		for (const candidate of world.entities()) if (candidate.velocity.x > 0) target = candidate;
		await player.control({ forward: 0, strafe: 1, jump: false, sneak: true, sprint: false, attack: false, use: false,
			yaw: math.atan2(target.z, target.x) * 180 / 3.141592653589793, pitch: 0, selectedSlot: 0, hand: "main", ticks: 2 });
		await player.wait(2);
	` }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(result.actions, 2);
	assert.equal(run.commands[0].action.arguments.yaw, 45);
	assert.deepEqual(run.commands[1].action, { type: 'wait', arguments: { durationMs: 2 } });
	for (const command of run.commands) {
		validateAction({ type: command.action.type, ...command.action.arguments });
		assert.equal(command.provenance.model, record.model);
		assert.equal(command.provenance.reasoningEffort, record.reasoningEffort);
		assert.match(command.provenance.programId, /^native-program-/);
		assert.match(command.provenance.stepId, /^step-/);
	}
	assert.equal(result.receipts[0].state, 'SUCCEEDED');
	assert.equal(run.cancels.length, 0);
});

test('queries and notes retain model authorship without acquiring physical action identity', async () => {
	const queries = [], memories = [];
	const run = setup({ inspect: async (query) => { queries.push(query); return { state: 'SUCCEEDED', menu: { menuId: 'minecraft:generic_9x3', containerId: 3, stateId: 9 } }; },
		memoryOperation: async (request) => { memories.push(request); return { state: 'SUCCEEDED', entries: [] }; } });
	const result = await run.executor.run(record, { source: `${prefix}
		const page = await world.inspect({ section: "menu" });
		await world.remember({ key: "container", text: "Inspected the nearby container." });
		await world.queryMemory({ kind: "notes", offset: 2, limit: 4 });
		await player.menuClose({ menuId: page.menu.menuId, containerId: page.menu.containerId, stateId: page.menu.stateId });
	` }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(run.commands.length, 1);
	assert.equal(run.commands[0].action.arguments.stateId, 9);
	assert.equal(queries.length, 1);
	assert.equal(memories[0].provenance.model, record.model);
	assert.match(memories[0].provenance.sourceStepId, /^step-/);
	assert.equal(memories[0].provenance.actionId, undefined);
	assert.equal(memories[1].arguments.offset, 2);
});

test('an authored interrupt watcher cancels the exact body command before issuing its authored response', async () => {
	let release;
	let sequence = 2;
	const commands = [], cancelled = [];
	const run = setup({ executeAction: (command) => {
		commands.push(command);
		return commands.length === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ state: 'SUCCEEDED', reasonCode: 'DONE' });
	}, cancelAction: async (actionId) => { cancelled.push(actionId); release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }); },
	refreshObservation: async () => ({ observation: observation(4), eventSequence: ++sequence }) });
	const pending = run.executor.run(record, { source: `${prefix}
		program.watch(() => player.state().health < 10, { mode: "interrupt" }, async () => { await player.wait(9); });
		await player.wait(100);
	` }, run.context);
	run.executor.onObservation(record, { observation: observation(4), eventSequence: 2, attention: true, priority: 'urgent', trigger: 'health_changed' });
	const result = await pending;
	assert.deepEqual(commands.map((command) => command.action.arguments.durationMs), [100, 9]);
	assert.deepEqual(cancelled, [commands[0].actionId]);
	assert.equal(result.receipts[0].state, 'CANCELLED');
	assert.equal(result.reasonCode, 'PROGRAM_IDLE');
});

test('continue attention waits for the current action and returns before any further command', async () => {
	let release;
	const commands = [];
	const run = setup({ executeAction: (command) => { commands.push(command); return new Promise((resolve) => { release = resolve; }); } });
	const pending = run.executor.run(record, { source: `${prefix} await player.wait(100); await player.wait(2);` }, run.context);
	run.executor.onObservation(record, { observation: observation(9), eventSequence: 2, attention: true, priority: 'urgent', trigger: 'health_changed' });
	assert.equal(run.cancels.length, 0);
	release({ state: 'SUCCEEDED', reasonCode: 'DONE' });
	const result = await pending;
	assert.equal(result.reasonCode, 'MODEL_DECISION_REQUIRED');
	assert.equal(result.trigger, 'health_changed');
	assert.equal(commands.length, 1);
	assert.equal(run.cancels.length, 0);
});

test('pause attention honors the model-authored cancellation policy', async () => {
	let release;
	const run = setup({ executeAction: () => new Promise((resolve) => { release = resolve; }),
		cancelAction: async () => { release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }); } });
	const pending = run.executor.run(record, { source: 'program.onUnhandledAttention("pause_and_notify"); await player.wait(100); await player.wait(2);' }, run.context);
	run.executor.onObservation(record, { observation: observation(9), eventSequence: 2, attention: true, priority: 'urgent', trigger: 'health_changed' });
	const result = await pending;
	assert.equal(result.reasonCode, 'MODEL_DECISION_REQUIRED');
	assert.equal(result.actions, 1);
	assert.equal(result.receipts[0].state, 'CANCELLED');
});
test('threat attention cancels navigation while the controller is observing a continuation', async () => {
	let release;
	const run = setup({ executeAction: () => new Promise((resolve) => { release = resolve; }),
		cancelAction: async () => { release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }); } });
	const pending = run.executor.run(record, { source: 'program.onUnhandledAttention("pause_and_notify"); await player.navigateTo({x:3,y:64,z:0,tolerance:1,sprint:false,timeoutMs:5000}); await player.wait(2);' }, run.context);
	run.executor.onObservation(record, { observation: { ...observation(), entities: [{ stableId: 'threat', type: 'minecraft:zombie', attacking: true, x: 1, y: 64, z: 0 }] }, eventSequence: 2, attention: true, priority: 'urgent', trigger: 'threat' });
	const result = await pending;
	assert.equal(result.reasonCode, 'MODEL_DECISION_REQUIRED');
	assert.equal(result.actions, 1);
	assert.equal(result.receipts[0].state, 'CANCELLED');
});

test('action budget and missing fresh facts stop execution without adding a strategy or retry', async () => {
	const bounded = setup();
	const limited = await bounded.executor.run(record, { source: `${prefix} await player.wait(1); await player.wait(2);`, maxActions: 1 }, bounded.context);
	assert.equal(limited.reasonCode, 'PROGRAM_ACTION_LIMIT');
	assert.equal(bounded.commands.length, 1);
	const stale = setup({ refreshObservation: async () => ({ observation: observation(), eventSequence: 1 }) });
	const stopped = await stale.executor.run(record, { source: `${prefix} await player.wait(1); await player.wait(2);` }, stale.context);
	assert.equal(stopped.reasonCode, 'FRESH_OBSERVATION_REQUIRED');
	assert.equal(stale.commands.length, 1);
	assert.equal(stopped.receipts[0].state, 'SUCCEEDED');
});

test('deadlines cancel exact inputs and unresolved acknowledgements are reported as unknown', async () => {
	const timers = [];
	const cancelled = [];
	const run = setup({ executeAction: () => new Promise(() => {}), cancelAction: async (actionId) => { cancelled.push(actionId); } },
		{ setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeoutFn: () => {} });
	const pending = run.executor.run(record, { source: `${prefix} await player.wait(100);`, timeoutMs: 10 }, run.context);
	timers[0].callback();
	assert.equal(cancelled.length, 1);
	assert.equal(timers[1].ms, 5000);
	timers[1].callback();
	const result = await pending;
	assert.equal(result.state, 'UNKNOWN');
	assert.equal(result.reasonCode, 'PROGRAM_CANCEL_ACK_TIMEOUT');
	assert.equal(result.receipts.length, 0);
});

test('a late cancellation failure cannot stop the interrupt handler after the old action acknowledges', async () => {
	const commands = [], releases = [];
	let rejectCancel;
	let sequence = 2;
	const run = setup({
		executeAction: (command) => {
			commands.push(command);
			return new Promise((resolve) => { releases.push(resolve); });
		},
		cancelAction: () => new Promise((resolve, reject) => { rejectCancel = reject; }),
		refreshObservation: async () => ({ observation: observation(4), eventSequence: ++sequence }),
	});
	const pending = run.executor.run(record, { source: `${prefix}
		program.watch(() => player.state().health < 10, { mode: "interrupt" }, async () => { await player.wait(9); });
		await player.wait(100);
	` }, run.context);
	run.executor.onObservation(record, { observation: observation(4), eventSequence: 2, attention: true, priority: 'urgent', trigger: 'health_changed' });
	releases[0]({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' });
	await turn();
	assert.deepEqual(commands.map((command) => command.action.arguments.durationMs), [100, 9]);
	rejectCancel(Object.assign(new Error('late cancellation transport failure'), { code: 'BRIDGE_DISCONNECTED' }));
	await turn();
	assert.notEqual(run.executor.status(record), null, 'the acknowledged cancellation must not invalidate the running handler');
	releases[1]({ state: 'SUCCEEDED', reasonCode: 'DONE' });
	const result = await pending;
	assert.equal(result.reasonCode, 'PROGRAM_IDLE');
	assert.deepEqual(result.receipts.map((receipt) => receipt.state), ['CANCELLED', 'SUCCEEDED']);
});

test('a cancellation transport failure remains unknown while its original action is still pending', async () => {
	const commands = [], cancelled = [];
	const run = setup({
		executeAction: (command) => { commands.push(command); return new Promise(() => {}); },
		cancelAction: async (actionId) => {
			cancelled.push(actionId);
			throw Object.assign(new Error('cancellation transport failed'), { code: 'BRIDGE_DISCONNECTED' });
		},
	});
	const pending = run.executor.run(record, { source: `${prefix}
		program.watch(() => player.state().health < 10, { mode: "interrupt" }, async () => { await player.wait(9); });
		await player.wait(100);
	` }, run.context);
	run.executor.onObservation(record, { observation: observation(4), eventSequence: 2, attention: true, priority: 'urgent', trigger: 'health_changed' });
	const result = await pending;
	assert.equal(result.state, 'UNKNOWN');
	assert.equal(result.reasonCode, 'BRIDGE_DISCONNECTED');
	assert.deepEqual(cancelled, [commands[0].actionId]);
	assert.equal(commands.length, 1, 'the handler must not dispatch without cancellation acknowledgement');
	assert.deepEqual(result.receipts, []);
});

test('planning-ahead sends one advisory before the deadline without interrupting the body', async () => {
	const timers = [];
	const advisories = [];
	const executor = new NativeProgramExecutor({
		now: () => 0,
		setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
		clearTimeoutFn: () => {},
	});
	const run = setup({ onPlanningDue: (status, details) => advisories.push({ status, details }) });
	const pending = executor.run(record, {
		source: `${prefix} await player.wait(1);`, timeoutMs: 100, expectedDurationMs: 100, planningLeadMs: 25,
	}, { ...run.context, onPlanningDue: (status, details) => advisories.push({ status, details }) });
	const due = timers.find((timer) => timer.ms === 75);
	assert.ok(due, 'the advisory is scheduled one measured lead time before the deadline');
	due.callback();
	due.callback();
	assert.equal(advisories.length, 1);
	assert.equal(advisories[0].status.programVersion, 1);
	assert.equal(advisories[0].status.engineState, 'ACTIVE');
	assert.deepEqual(advisories[0].details, { planningLeadMs: 25, basis: 'model_expected_duration' });
	assert.equal(run.cancels.length, 0);
	assert.equal((await pending).reasonCode, 'PROGRAM_EXHAUSTED');
});

test('planning-ahead does not replace a real hazard decision and stale version timers are fenced', async () => {
	const timers = [];
	const advisories = [];
	let release;
	let calls = 0;
	const executor = new NativeProgramExecutor({
		now: () => 0,
		setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
		clearTimeoutFn: () => {},
	});
	const run = setup({
		executeAction: () => ++calls === 1
			? new Promise((resolve) => { release = resolve; })
			: Promise.resolve({ state: 'SUCCEEDED', reasonCode: 'DONE' }),
		onDecision: () => {},
		onPlanningDue: (status, details) => advisories.push({ status, details }),
	});
	const pending = executor.run(record, {
		source: `${prefix} await player.wait(100); await player.wait(2);`, timeoutMs: 100, expectedDurationMs: 100, planningLeadMs: 25, programId: 'planning-ahead-test',
	}, { ...run.context, onPlanningDue: (status, details) => advisories.push({ status, details }) });
	const due = timers.find((timer) => timer.ms === 75);
	executor.onObservation(record, { observation: observation(9), eventSequence: 2, attention: true, priority: 'urgent', trigger: 'health_changed' });
	await turn();
	const decision = executor.status(record).decision;
	assert.equal(decision.trigger, 'health_changed');
	executor.respond(record, { programId: 'planning-ahead-test', decisionId: decision.decisionId, directive: 'replace', source: `${prefix} await player.wait(3);` });
	// The timer was armed for version 1. Replaying it after replacement must
	// not send an advisory carrying stale program-version authority.
	due.callback();
	assert.equal(advisories.length, 0);
	release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' });
	await pending;
});

test('cancelled query results cannot release later body actions and finish remains a model request', async () => {
	let release;
	const run = setup({ inspect: () => new Promise((resolve) => { release = resolve; }) });
	const pending = run.executor.run(record, { source: `${prefix} await world.inspect({ section: "menu" }); await player.wait(1);` }, run.context);
	await run.executor.cancel(record.agentId);
	release({ state: 'SUCCEEDED', menu: null });
	await turn();
	assert.equal((await pending).state, 'CANCELLED');
	assert.equal(run.commands.length, 0);
	assert.equal(run.cancels.length, 0);
	const finished = await run.executor.run(record, { source: `${prefix} program.finish("ready for verification");` }, run.context);
	assert.equal(finished.finishRequested, true);
	assert.equal(finished.state, 'YIELDED');
	assert.equal(finished.reasonCode, 'PROGRAM_FINISH_REQUESTED');
});

test('sandbox errors and action callback failures never invoke a replacement provider or fabricate completion', async () => {
	const run = setup({ executeAction: async () => { throw Object.assign(new Error('transport unavailable'), { code: 'BRIDGE_DISCONNECTED' }); } });
	assert.throws(() => run.executor.run(record, { source: `${prefix} globalThis.fetch("invalid");` }, run.context));
	const result = await run.executor.run(record, { source: `${prefix} await player.wait(1); await player.wait(2);` }, run.context);
	assert.equal(result.state, 'UNKNOWN');
	assert.equal(result.reasonCode, 'BRIDGE_DISCONNECTED');
	assert.equal(result.actions, 1);
	assert.equal(result.receipts.length, 0);
});

test('nonterminal body callback results release the exact inputs and remain unknown', async () => {
	const run = setup({ executeAction: async () => ({ state: 'RUNNING', reasonCode: 'STARTED' }) });
	const result = await run.executor.run(record, { source: `${prefix} await player.wait(1); await player.wait(2);` }, run.context);
	await turn();
	assert.equal(result.state, 'UNKNOWN');
	assert.equal(result.reasonCode, 'INVALID_ACTION_RESULT');
	assert.equal(result.receipts.length, 0);
	assert.equal(run.cancels.length, 1);
	assert.equal(run.cancels[0].reason, 'INVALID_ACTION_RESULT');
});

test('program identities are unique in production and reproducible only with an injected replay session', async () => {
	const source = `${prefix} program.checkpoint("ready");`;
	const first = setup(), second = setup();
	const one = await first.executor.run(record, { source }, first.context);
	const two = await second.executor.run(record, { source }, second.context);
	assert.notEqual(one.programId, two.programId);
	const replayOne = setup({}, { sessionId: 'synthetic-replay' });
	const replayTwo = setup({}, { sessionId: 'synthetic-replay' });
	assert.equal((await replayOne.executor.run(record, { source }, replayOne.context)).programId,
		(await replayTwo.executor.run(record, { source }, replayTwo.context)).programId);
});

test('break evidence reaches program receipts and script results only when it is informative', async () => {
	const outcomes = [{ blocks: 1, correctTool: false, noDropsSeen: true, handChanged: false }, { blocks: 1, held: 'minecraft:stone_pickaxe', correctTool: true, noDropsSeen: false, handChanged: false }];
	const run = setup({ executeAction: async (command) => { run.commands.push(command); return { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', message: 'Broken with hand', breakOutcome: outcomes.shift() }; } });
	const result = await run.executor.run(record, { source: `${prefix}
		const bare = await tryResult(player.mine({ x: 1, y: 64, z: 0, expectedBlockId: "minecraft:stone", timeoutMs: 5000 }));
		if (bare.noDropsSeen && bare.correctTool === false) await player.mine({ x: 2, y: 64, z: 0, expectedBlockId: "minecraft:stone", timeoutMs: 5000 });
	` }, run.context);
	assert.equal(run.commands.length, 2, 'the script branched on the bare-hand break evidence');
	assert.deepEqual([result.receipts[0].held, result.receipts[0].correctTool, result.receipts[0].noDropsSeen], ['minecraft:air', false, true], 'an empty hand is named explicitly');
	assert.equal(['held', 'correctTool', 'noDropsSeen', 'message'].some((key) => key in result.receipts[1]), false, 'a normal break adds no receipt bytes');
	assert.equal(result.receipts[0].message, 'Broken with hand', 'a drop-less break keeps the body explanation');
});

test('failed program steps keep the newest body explanation, bounded in encoded bytes', async () => {
	const why = (x) => `No part of it is visible within reach from this eye; minecraft:short_grass at ${x},64,0 is in the way; seen terrain shows it from feet at 3,64,1`;
	const run = setup({ executeAction: async (command) => { run.commands.push(command);
		return { state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE', message: why(command.action.arguments.x) + ' "quoted"'.repeat(40) }; } });
	const result = await run.executor.run(record, { source: `${prefix}
		for (let x = 1; x <= 4; x++) await tryResult(player.mine({ x, y: 64, z: 1, expectedBlockId: "minecraft:stone", timeoutMs: 5000 }));
	` }, run.context);
	assert.equal(result.receipts.length, 4);
	assert.deepEqual(result.receipts.map((receipt) => 'message' in receipt), [false, false, false, true], 'only the newest failure keeps its message');
	assert.ok(result.receipts[3].message.startsWith(why(4)), 'the blocker and standing spot reach the model');
	assert.ok(Buffer.byteLength(JSON.stringify(result.receipts[3].message)) - 2 <= MAX_RECEIPT_MESSAGE_BYTES, 'escapes count toward the byte cap');
});

test('a full receipt history pays for the sparse message column within the prefix saving', async () => {
	for (const text of ['x'.repeat(160), '"x" '.repeat(120), '\u0000'.repeat(160), '火🔥'.repeat(160)]) {
		const run = setup({ executeAction: async (command) => ({
			state: command.action.arguments.x < 64 ? 'SUCCEEDED' : 'FAILED',
			reasonCode: command.action.arguments.x < 64 ? 'BLOCK_BROKEN' : 'TARGET_NOT_VISIBLE',
			executionStarted: false, physicalAttempted: false, message: text,
		}) });
		const result = await run.executor.run(record, { source: `${prefix}
			for (let x = 1; x <= 64; x++) await tryResult(player.mine({ x, y: 64, z: 0, expectedBlockId: "minecraft:stone", timeoutMs: 5000 }));
		` }, run.context);
		assert.equal(result.receipts.length, 64);
		assert.equal(result.receipts.filter(receipt => 'message' in receipt).length, 1);
		const wakeBytes = receipts => Buffer.byteLength(encodeNativeEventInput(`Update.\n${JSON.stringify({
			event: 'program_exhausted', observation: observation(), program: { result: { receipts } },
		})}`));
		const withoutMessages = result.receipts.map(({ message, ...receipt }) => receipt);
		// The measured always-sent saving is 547 bytes; include the encoder's null cells, not only the text.
		assert.ok(wakeBytes(result.receipts) - wakeBytes(withoutMessages) <= 547);
	}
});

test('a tool used up on removal stays named in the program receipt and script result', async () => {
	// Normal drops with the right tool, but the pickaxe broke: the hand changed, so the removal-time item is kept.
	const run = setup({ executeAction: async (command) => { run.commands.push(command); return { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', message: 'Broken with wooden_pickaxe; drops seen',
		breakOutcome: { blocks: 1, held: 'minecraft:wooden_pickaxe', correctTool: true, noDropsSeen: false, handChanged: true } }; } });
	const result = await run.executor.run(record, { source: `${prefix}
		const broken = await tryResult(player.mine({ x: 1, y: 64, z: 0, expectedBlockId: "minecraft:stone", timeoutMs: 5000 }));
		await player.wait(broken.held === "minecraft:wooden_pickaxe" ? 7 : 9);
	` }, run.context);
	assert.equal(run.commands[1].action.arguments.durationMs, 7, 'the script saw the removal-time tool');
	assert.equal(result.receipts[0].held, 'minecraft:wooden_pickaxe');
	assert.equal('correctTool' in result.receipts[0] || 'noDropsSeen' in result.receipts[0], false);
});

test('a reported normal break gives the script its affirmative facts without adding receipt fields', async () => {
	const run = setup({ executeAction: async (command) => { run.commands.push(command); return { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', message: 'Broken with stone_pickaxe; drops seen',
		breakOutcome: { blocks: 1, held: 'minecraft:stone_pickaxe', correctTool: true, noDropsSeen: false, handChanged: false } }; } });
	const result = await run.executor.run(record, { source: `${prefix}
		const broken = await tryResult(player.mine({ x: 1, y: 64, z: 0, expectedBlockId: "minecraft:stone", timeoutMs: 5000 }));
		await player.wait(broken.held === "minecraft:stone_pickaxe" && broken.correctTool === true && broken.noDropsSeen === false ? 7 : 9);
	` }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(run.commands[1].action.arguments.durationMs, 7);
	assert.equal(['held', 'correctTool', 'noDropsSeen'].some((key) => key in result.receipts[0]), false, 'defaults stay out of receipts');
});

test('break facts the body did not report read as null in scripts, never as a tool or drop claim', async () => {
	const results = [
		{ state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' },
		{ state: 'FAILED', reasonCode: 'TARGET_AIR', executionStarted: false, physicalAttempted: false },
		{ state: 'SUCCEEDED', reasonCode: 'DONE' },
		{ state: 'TIMED_OUT', reasonCode: 'ACTION_TIMEOUT', breakOutcome: { blocks: 0, held: 'minecraft:iron_pickaxe', correctTool: false, noDropsSeen: false, handChanged: false } },
	];
	const run = setup({ executeAction: async (command) => { run.commands.push(command); return results.shift() ?? { state: 'SUCCEEDED', reasonCode: 'DONE' }; } });
	const result = await run.executor.run(record, { source: `${prefix}
		const unknown = (r) => r.held === null && r.correctTool === null && r.noDropsSeen === null;
		const missing = await tryResult(player.mine({ x: 1, y: 64, z: 0, expectedBlockId: "minecraft:stone", timeoutMs: 5000 }));
		const early = await tryResult(player.mine({ x: 2, y: 64, z: 0, expectedBlockId: "minecraft:stone", timeoutMs: 5000 }));
		const waited = await tryResult(player.wait(1));
		const attempt = await tryResult(player.mine({ x: 3, y: 64, z: 0, expectedBlockId: "minecraft:obsidian", timeoutMs: 5000 }));
		const attemptFacts = attempt.held === "minecraft:iron_pickaxe" && attempt.correctTool === false && attempt.noDropsSeen === null;
		await player.wait(unknown(missing) && unknown(early) && unknown(waited) && attemptFacts ? 7 : 9);
	`, maxActions: 6 }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED', JSON.stringify(result));
	assert.equal(run.commands.at(-1).action.arguments.durationMs, 7);
});

test('the published portal-crossing fragment checkpoints on CANCELLED/DIMENSION_TRANSITION with fresh destination facts and never retries old coordinates', async () => {
	const reference = readFileSync(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/references/control-reference.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
	const fragment = reference.slice(reference.indexOf('## Portals and dimension changes')).match(/```javascript\n([\s\S]*?)```/)[1];
	const leg = { x: 40, y: 64, z: -12, tolerance: 1, sprint: true, timeoutMs: 30000 };
	const facts = (dimension) => ({ ...observation(), world: { dimension, worldId: 'fixture' } });
	const cases = [
		{ name: 'fresh nether sample', terminal: { state: 'CANCELLED', reasonCode: 'DIMENSION_TRANSITION', executionStarted: true, physicalAttempted: true }, refreshed: 'minecraft:the_nether', reason: 'PROGRAM_CHECKPOINT', dimension: 'minecraft:the_nether' },
		{ name: 'fresh end sample', terminal: { state: 'CANCELLED', reasonCode: 'DIMENSION_TRANSITION', executionStarted: true, physicalAttempted: true }, refreshed: 'minecraft:the_end', reason: 'PROGRAM_CHECKPOINT', dimension: 'minecraft:the_end' },
		{ name: 'no newer sample', terminal: { state: 'CANCELLED', reasonCode: 'DIMENSION_TRANSITION', executionStarted: true, physicalAttempted: true }, refreshed: null, reason: 'FRESH_OBSERVATION_REQUIRED' },
		{ name: 'death control', terminal: { state: 'FAILED', reasonCode: 'AGENT_DEAD', executionStarted: true, physicalAttempted: true }, refreshed: 'minecraft:overworld', reason: 'PROGRAM_CHECKPOINT' },
		{ name: 'cancel control', terminal: { state: 'CANCELLED', reasonCode: 'INPUT_RELEASED', executionStarted: true, physicalAttempted: true }, refreshed: 'minecraft:overworld', reason: 'PROGRAM_CHECKPOINT' },
		{ name: 'arrival control', terminal: { state: 'SUCCEEDED', reasonCode: 'DONE' }, refreshed: 'minecraft:overworld', reason: 'PROGRAM_EXHAUSTED' },
	];
	for (const row of cases) {
		let sequence = 1;
		const run = setup({ observation: facts('minecraft:overworld'),
			executeAction: async (command) => { run.commands.push(command); return row.terminal; },
			refreshObservation: async () => row.refreshed === null ? { observation: facts('minecraft:overworld'), eventSequence: sequence } : { observation: facts(row.refreshed), eventSequence: ++sequence } });
		const result = await run.executor.run(record, { source: `${prefix}\n${fragment}`, parameters: { leg } }, run.context);
		assert.equal(result.reasonCode, row.reason, row.name);
		// Exactly the one authored leg: the runtime neither retries nor continues old-dimension coordinates.
		assert.equal(run.commands.length, 1, row.name);
		assert.deepEqual([run.commands[0].action.arguments.x, run.commands[0].action.arguments.y, run.commands[0].action.arguments.z], [leg.x, leg.y, leg.z], row.name);
		assert.equal(result.receipts[0].reasonCode, row.terminal.reasonCode, row.name);
		assert.equal(result.receipts[0].state, row.terminal.state, row.name);
		if (row.dimension) assert.equal(result.observation.world.dimension, row.dimension, row.name);
	}
});

test('status and results report shared command usage per version separately from the run-wide physical allowance', async () => {
	let release;
	const commands = [], inspections = [];
	const run = setup({
		onDecision() {},
		inspect: async (query) => { inspections.push(query); return { state: 'SUCCEEDED', section: 'inventory', entries: [] }; },
		executeAction: (command) => {
			commands.push(command);
			return commands.length === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ state: 'SUCCEEDED', reasonCode: 'DONE' });
		},
		cancelAction: async () => release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }),
	});
	const pending = run.executor.run(record, { programId: 'budget-report', maxActions: 10, source: `${prefix} await world.inspect({section:"inventory"}); await player.wait(1); await player.wait(2);` }, run.context);
	for (let i = 0; i < 5 && commands.length === 0; i++) await turn();
	assert.equal(inspections.length, 1);
	assert.equal(commands.length, 1);
	const status = run.executor.status(record);
	assert.deepEqual(status.budget, { commandsUsed: 2, commandsRemaining: 2046, queriesUsed: 1, actionsUsed: 1, actionsRemaining: 9 });
	// Publishing the budget is a read of existing counters: no query or body command.
	run.executor.status(record); run.executor.status(record);
	assert.equal(inspections.length, 1);
	assert.equal(commands.length, 1);
	run.executor.onObservation(record, { observation: observation(9), eventSequence: 2, attention: true });
	const decision = run.executor.status(record).decision;
	run.executor.respond(record, { programId: 'budget-report', decisionId: decision.decisionId, directive: 'replace', source: `${prefix} await player.wait(5);` });
	const result = await pending;
	assert.equal(result.programVersion, 2);
	// Replacement starts a fresh shared command budget; physical actions stay counted against the run.
	assert.deepEqual(result.budget, { commandsUsed: 1, commandsRemaining: 2047, queriesUsed: 0, actionsUsed: 2, actionsRemaining: 8 });
});

test('a checkpoint or finish returns the model its own reason', async () => {
	for (const [call, reasonCode] of [['program.checkpoint("no iron in this cave; need a new area")', 'PROGRAM_CHECKPOINT'],
		['program.finish("crafted the iron pickaxe")', 'PROGRAM_FINISH_REQUESTED']]) {
		const run = setup();
		const result = await run.executor.run(record, { source: `${prefix} ${call};` }, run.context);
		assert.equal(result.reasonCode, reasonCode);
		assert.match(result.summary, reasonCode === 'PROGRAM_CHECKPOINT' ? /no iron in this cave/ : /crafted the iron pickaxe/);
	}
	const idle = setup();
	assert.equal((await idle.executor.run(record, { source: `${prefix} await player.wait(1);` }, idle.context)).summary, undefined,
		'a program that just ends has no summary');
});

test('a partial craft keeps its explanation in the receipt and reaches the script as detail', async () => {
	const message = 'Crafted 4 of 12 minecraft:oak_planks: only 1 minecraft:oak_log was carried';
	let refreshes = 0;
	const run = setup({
		executeAction: async (command) => { run.commands.push(command); return { state: 'SUCCEEDED', reasonCode: 'CRAFT_PARTIAL', message }; },
		refreshObservation: async () => { refreshes += 1; return { observation: observation(), eventSequence: 2 + refreshes }; },
	});
	const result = await run.executor.run(record, { source: `${prefix}
		const made = await player.craftInventory({ recipeId: "minecraft:oak_planks", count: 12, timeoutMs: 5000 });
		if (made.reasonCode === "CRAFT_PARTIAL" && made.detail === "${message}") program.finish("saw partial");
		program.checkpoint("missed partial");` }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_FINISH_REQUESTED', `the script saw the partial detail: ${JSON.stringify(result)}`);
	assert.equal(result.receipts[0].reasonCode, 'CRAFT_PARTIAL');
	assert.equal(result.receipts[0].message, message, 'the partial explanation survives in the receipt');
	assert.equal(refreshes, 1, 'one terminal sample, no extra inspect');
	const full = setup({ executeAction: async () => ({ state: 'SUCCEEDED', reasonCode: 'CRAFT_CONFIRMED', message: 'Crafted 12 minecraft:oak_planks' }) });
	const whole = await full.executor.run(record, { source: `${prefix} await player.craftInventory({ recipeId: "minecraft:oak_planks", count: 12, timeoutMs: 5000 }); program.finish("ok");` }, full.context);
	assert.equal(whole.receipts[0].message, undefined, 'a full success stays compact');
});

test('bounded memory query limits are dispatched bounded and reported to the script', async () => {
	const memories = [];
	const run = setup({ memoryOperation: async (request) => { memories.push(request); return { state: 'SUCCEEDED', entries: [] }; } });
	const result = await run.executor.run(record, { source: `${prefix}
		const page = await world.queryMemory({ kind: "notes", limit: 500 });
		await world.remember({ key: "seen", text: page.adjusted.limit });
	` }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(memories[0].arguments.limit, 64);
	assert.match(memories[1].arguments.text, /^64 \(max, asked 500\)/);
});

function controlledPlanning() {
	const timers = [], advisories = [];
	let now = 0, release, completed = 0;
	const run = setup({
		executeAction: command => { run.commands.push(command); return new Promise(resolve => { release = resolve; }); },
		refreshObservation: async () => ({ eventSequence: completed + 1, observation: { ...observation(), inventory: {
			items: [{ itemId: 'minecraft:oak_log', count: completed }], tagCounts: { '#minecraft:logs': completed },
		} } }),
		onPlanningDue: (status, details) => advisories.push({ status, details }),
		cancelAction: async () => release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }),
	}, { now: () => now, setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { if (timer) timer.cleared = true; } });
	return { ...run, timers, advisories,
		advance: ms => { now += ms; },
		complete: async ms => { now += ms; completed++; release({ state: 'SUCCEEDED', reasonCode: 'DONE', durationMs: ms }); await turn(); },
		due: () => timers.findLast(timer => !timer.cleared && timer !== timers[0]),
	};
}

test('condition progress estimates the observed end rather than maxIterations', async () => {
	for (const condition of ['inventory.count("minecraft:oak_log") >= 8', 'inventory.countTag("#minecraft:logs") > 7']) {
		const run = controlledPlanning();
		const pending = run.executor.run(record, { source: `${prefix} await program.repeatUntil(() => ${condition}, { maxIterations: 64 }, async () => { await player.wait(1000); });`,
			timeoutMs: 120_000, planningLeadMs: 2000 }, run.context);
		assert.equal(run.executor.status(record).timing.estimatedRemainingMs, undefined, 'no invented gain before the first iteration');
		await run.complete(1000);
		assert.equal(run.executor.status(record).timing.remainingActions, 7);
		assert.equal(run.executor.status(record).timing.estimatedRemainingMs, 7000);
		assert.equal(run.executor.status(record).timing.basis, 'observed_count_progress');
		assert.equal(run.due().ms, 5000);
		for (let i = 1; i < 6; i++) await run.complete(1000);
		assert.equal(run.due().ms, 0); run.due().callback();
		assert.equal(run.advisories.length, 1);
		await run.complete(1000); await run.complete(1000);
		assert.equal((await pending).actionsSucceeded, 8);
	}
});

test('remaining estimate is bounded by expected duration and the hard deadline', async () => {
	for (const expectedDurationMs of [undefined, 3500]) {
		const run = controlledPlanning();
		const pending = run.executor.run(record, { source: `${prefix} for (let i = 0; i < 10; i++) await player.wait(1000);`,
			timeoutMs: 4000, planningLeadMs: 1000, expectedDurationMs }, run.context);
		await run.complete(1000);
		assert.equal(run.executor.status(record).timing.estimatedRemainingMs, 9000);
		assert.equal(run.due().ms, expectedDurationMs === undefined ? 2000 : 1500);
		await run.executor.cancel(record.agentId); await pending;
	}
});

test('an upper bound times the planning notice where the exact continuation is unknown', async () => {
	for (const work of [
		'for (let i = 0; i < 10; i++) { const r = await tryResult(player.wait(1000)); if (!r.succeeded) break; }',
		'program.watch(() => player.state().health < 10, { mode: "boundary" }, async () => { await player.wait(1); }); for (let i = 0; i < 10; i += 1) await player.wait(1000);',
		'for (let i = 0; i < 10; i += 1) { if (player.state().health > 10) { await player.wait(1000); } else { await player.wait(1000); } }',
	]) {
		const run = controlledPlanning();
		const pending = run.executor.run(record, { source: `${prefix} ${work}`, timeoutMs: 120_000, planningLeadMs: 2000 }, run.context);
		assert.equal(run.executor.status(record).timing.remainingActionsAtMost, 10);
		assert.equal(run.executor.status(record).timing.estimatedRemainingMsAtMost, undefined, 'no duration before the first measured action');
		await run.complete(1000);
		const timing = run.executor.status(record).timing;
		assert.equal(timing.remainingActions, undefined, 'the exact estimate stays unknown');
		assert.equal(timing.remainingActionsAtMost, 9);
		assert.equal(timing.estimatedRemainingMsAtMost, 9000);
		assert.equal(run.due().ms, 7000);
		run.due().callback();
		assert.equal(run.advisories.length, 1);
		assert.equal(run.advisories[0].details.basis, 'measured_bound');
		await run.executor.cancel(record.agentId); await pending;
	}
});

test('a later program borrows measured action durations from earlier programs for its bound', async () => {
	const run = controlledPlanning();
	const loop = 'for (let i = 0; i < 6; i++) { const r = await tryResult(player.wait(1000)); if (!r.succeeded) break; }';
	const first = run.executor.run(record, { source: `${prefix} ${loop}`, timeoutMs: 120_000, planningLeadMs: 2000 }, run.context);
	for (let i = 0; i < 6; i++) await run.complete(1000);
	assert.equal((await first).reasonCode, 'PROGRAM_EXHAUSTED');
	const second = run.executor.run(record, { source: `${prefix} ${loop}`, timeoutMs: 120_000, planningLeadMs: 2000 }, run.context);
	assert.equal(run.executor.status(record).timing.estimatedRemainingMsAtMost, 6000);
	assert.equal(run.due().ms, 4000);
	await run.executor.cancel(record.agentId); await second;
});

test('work shorter than a model response still gets one planning notice when enough of it remains', async () => {
	for (const [actions, notices] of [[6, 1], [3, 0]]) {
		const run = controlledPlanning();
		const pending = run.executor.run(record, { source: `${prefix} for (let i = 0; i < ${actions}; i++) await player.wait(1000);`, timeoutMs: 120_000, planningLeadMs: 12_000 }, run.context);
		await run.complete(1000);
		const due = run.due();
		if (notices) { assert.equal(due.ms, 0); due.callback(); }
		else assert.ok(due === undefined || due.ms !== 0 || due.cleared);
		assert.equal(run.advisories.length, notices);
		await run.executor.cancel(record.agentId); await pending;
	}
});

for (const work of [
	'await program.repeatUntil(() => player.state().health < 10, { maxIterations: 64 }, async () => { await player.wait(1000); });',
	'for (let i = 0; i < 64; i++) { await player.wait(1000); if (player.state().health < 10) break; }',
	'for (let i = 0; i < 64; i++) { await player.wait(1000); if (player.state().health > 10) await player.wait(1000); }',
	'program.watch(() => player.state().health < 10, { mode: "boundary" }, async () => { await player.wait(1); }); await player.wait(1000);',
]) {
	test(`unpredictable control flow stays unknown and accepts an explicit duration: ${work.slice(0, 45)}`, async () => {
		const run = controlledPlanning();
		const pending = run.executor.run(record, { source: `${prefix} ${work}`, timeoutMs: 120_000, planningLeadMs: 1000, expectedDurationMs: 8000 }, run.context);
		assert.equal(run.executor.status(record).timing.remainingActions, undefined);
		assert.equal(run.due().ms, 7000);
		await run.executor.cancel(record.agentId); await pending;
	});
}

test('mixed action estimates require each type and weight navigation separately from cheap looks', async () => {
	const run = controlledPlanning();
	const navigate = 'await player.navigateTo({ x: 2, y: 64, z: 0, tolerance: 1, sprint: false, timeoutMs: 30000 });';
	const look = 'await player.lookAt({ x: 2, y: 64, z: 0 });';
	const pending = run.executor.run(record, { source: `${prefix} ${look} ${navigate} ${navigate} ${navigate} ${look}`, timeoutMs: 120_000, planningLeadMs: 2000 }, run.context);
	await run.complete(10);
	assert.equal(run.executor.status(record).timing.estimatedRemainingMs, undefined, 'cheap look duration cannot price unseen navigation');
	assert.equal(run.due(), undefined);
	await run.complete(10_000);
	assert.equal(run.executor.status(record).timing.estimatedRemainingMs, 20_010);
	assert.equal(run.due().ms, 18_010);
	await run.executor.cancel(record.agentId); await pending;
});

test('an advisory re-arms once when measured remaining work grows substantially', async () => {
	const run = controlledPlanning();
	const pending = run.executor.run(record, { source: `${prefix} for (let i = 0; i < 5; i++) await player.wait(2000);`, timeoutMs: 120_000, planningLeadMs: 2000 }, run.context);
	await run.complete(2000);
	const first = run.due(); run.advance(first.ms); first.callback();
	assert.equal(run.advisories.length, 1);
	await run.complete(20_000);
	const second = run.due(); assert.notEqual(second, first); assert.equal(second.ms, 31_000);
	run.advance(second.ms); second.callback();
	assert.equal(run.advisories.length, 2);
	await run.complete(30_000);
	assert.equal(run.due(), second, 'even further growth cannot cause a third advisory');
	await run.executor.cancel(record.agentId); await pending;
});

for (const planningLeadMs of [undefined, 5000]) {
	test(`short programs do not wake too late to prepare a successor: lead=${planningLeadMs}`, async () => {
		const run = controlledPlanning();
		const pending = run.executor.run(record, { source: `${prefix} await player.wait(20); await player.wait(20);`, timeoutMs: 120_000, planningLeadMs }, run.context);
		await run.complete(20);
		assert.equal(run.due(), undefined);
		await run.complete(20);
		assert.equal((await pending).reasonCode, 'PROGRAM_EXHAUSTED');
		assert.equal(run.advisories.length, 0);
	});
}

test('placement causes reach native program branches and retained receipts', async () => {
	const run = setup({ executeAction: async command => {
		run.commands.push(command);
		return command.action.type === 'place_block'
			? { state: 'FAILED', reasonCode: 'NO_PLACEMENT_SUPPORT', cause: 'SUPPORT_FACE_HIDDEN', message: 'requestedSupport=0,64,0' }
			: { state: 'SUCCEEDED', reasonCode: 'DONE' };
	} });
	const result = await run.executor.run(record, { source: `${prefix}
		const placed = await tryResult(player.placeBlock({x:1,y:64,z:0,face:"east",itemId:"minecraft:obsidian",faceMode:"strict"}));
		await player.wait(placed.cause === "SUPPORT_FACE_HIDDEN" ? 7 : 9);
	` }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(run.commands[0].action.arguments.faceMode, 'strict');
	assert.equal(run.commands[1].action.arguments.durationMs, 7);
	assert.equal(result.receipts[0].cause, 'SUPPORT_FACE_HIDDEN');
});


test('direct script mining defaults and harmless move timeout are repaired with visible receipt notes', async () => {
	const run = setup();
	const result = await run.executor.run(record, { source: `${prefix}
		await player.mine({x:1,y:64,z:2});
		await player.breakBlock({x:2,y:64,z:2});
		await player.moveTo({x:3,y:64,z:2,tolerance:1,timeoutMs:4000});
	` }, run.context);
	assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(run.commands.length, 3);
	assert.equal(run.commands[0].action.arguments.timeoutMs, 15_000);
	assert.equal(run.commands[1].action.arguments.timeoutMs, 15_000);
	assert.equal(run.commands[2].action.arguments.timeoutMs, undefined);
	assert.match(result.receipts[0].adjusted.timeoutMs, /15000.*default/);
	assert.match(result.receipts[2].adjusted.timeoutMs, /move_to.*navigate_to/);
	assert.match(presentNativeToolResult(result, {kind:'run_program'}).response.contentItems[0].text, /adjusted/);
});

test('direct script boundary rejection names its method and legal fields before any body work', async () => {
	const run = setup();
	const result = await run.executor.run(record, {source: `${prefix} const args={x:1,y:64,z:2,tolerance:1,wrong:true}; await player.moveTo(args);`}, run.context);
	assert.equal(result.state, 'FAILED'); assert.equal(run.commands.length, 0);
	assert.match(result.message, /player.moveTo: .*wrong.*legal fields: x, y, z, tolerance, sprint/);
});

test('a compound bounded loop stops on its flag and never resets its counter bound', async () => {
	for (const stopAt of [3, 99]) {
		const run = setup();
		const result = await run.executor.run(record, {source:`${prefix} let stop=false; for(let i=0;i<8 && !stop;i++){await player.wait(1); stop=i>=${stopAt};}`},run.context);
		assert.equal(result.reasonCode, 'PROGRAM_EXHAUSTED');
		assert.equal(run.commands.length, Math.min(stopAt + 1, 8));
	}
});


test('mining checkpoints retain yield across replacement programs and show healthy picks with current wear', async () => {
	let now = 1000, sequence = 1, broken = 0;
	const who = {...record, currentGoal:'beat the game.'};
	const views = new LiveTaskViews({now:()=>now});
	const sample = () => ({...observation(), ready:true, observedAtEpochMs:now,
		world:{worldId:'checkpoints',dimension:'minecraft:overworld'},
		inventory:{selectedSlot:0,items:[{itemId:'minecraft:stone_pickaxe',count:1,slot:0,maxDamage:131,damage:broken}, {itemId:'minecraft:raw_iron',count:broken>=8?2:0,slot:1}]}});
	await views.observe(who, sample());
	const run = setup({observation:sample(), refreshObservation:async()=>({observation:sample(),eventSequence:++sequence}), executeAction:async command=>{
		now+=100; broken++;
		await views.actionReceipt(who,{actionId:command.actionId,programId:command.provenance.programId,goalRevision:1,worldId:'checkpoints',dimension:'minecraft:overworld',actionType:'break_block',arguments:command.action.arguments,state:'SUCCEEDED',reasonCode:'BLOCK_BROKEN',observedAtEpochMs:now});
		await views.observe(who,sample());
		return {state:'SUCCEEDED',reasonCode:'BLOCK_BROKEN',observation:sample(),eventSequence:++sequence};
	}});
	const source=`${prefix} for(let i=0;i<8;i++){await player.mine({x:i,y:64,z:1});}`;
	for(const programId of ['first-excavation','replacement-excavation']) {
		const result=await run.executor.run(who,{programId,source},run.context);
		assert.equal(result.reasonCode,'PROGRAM_EXHAUSTED');
	}
	const nowFacts=views.continuity(who);
	assert.match(nowFacts.mining,/last 10m: 16 blocks broken;.*raw_iron 2; picks now: stone_pickaxe slot 0: 115 uses left/);
	assert.equal(nowFacts.tools,undefined,'ordinary low-wear warnings retain their existing threshold');
	const stale={...sample(),observedAtEpochMs:now+1,continuity:{rememberedSections:['inventory']}};
	assert.doesNotMatch(views.continuity(who,{observation:stale}).mining,/picks now/,'stale inventory never supplies current durability');
});

test('one authored program executes 1024 actions and 1024 queries beyond two minutes without a model boundary', async () => {
	let clock = 0;
	const timers = [], decisions = [];
	const run = setup({
		executeAction: async command => { run.commands.push(command); clock += 150; return {state:'SUCCEEDED',reasonCode:'DONE'}; },
		inspect: async () => ({state:'SUCCEEDED',reasonCode:'INSPECTED'}),
		onDecision: decision => decisions.push(decision),
	}, {now:()=>clock,setTimeoutFn:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},clearTimeoutFn:()=>{}});
	const result = await run.executor.run(record, {source:`${prefix}
		for(let i=0;i<1024;i++) { await world.inspect({section:"inventory"}); await player.wait(1); }`,maxActions:1024,timeoutMs:600000},run.context);
	assert.equal(result.reasonCode,'PROGRAM_EXHAUSTED');
	assert.equal(result.actionsSucceeded,1024);
	assert.deepEqual(result.budget,{commandsUsed:2048,commandsRemaining:0,queriesUsed:1024,actionsUsed:1024,actionsRemaining:0});
	assert.equal(clock,153600);
	assert.equal(timers[0].ms,600000);
	assert.equal(decisions.length,0);
	assert.ok(run.commands.every(command=>command.provenance.modelIdentity === record.model));
});

test('native onError runs only the authored recovery and later craft phase with no model request', async () => {
	const decisions = [];
	const run = setup({executeAction:async command=>{
		run.commands.push(command);
		return command.action.type === 'navigate_to' ? {state:'FAILED',reasonCode:'NO_STANDABLE_PATH'} : {state:'SUCCEEDED',reasonCode:'DONE'};
	},onDecision:decision=>decisions.push(decision)});
	const result = await run.executor.run(record,{source:`${prefix}
		const r=await tryResult(player.navigateTo({x:10,y:64,z:0,tolerance:1,sprint:true,timeoutMs:5000}),async failed=>{
			if(failed.reasonCode!=="NO_STANDABLE_PATH") program.checkpoint(failed.reasonCode);
			return await player.wait(2);
		});
		if(!r.succeeded) program.checkpoint(r.reasonCode);
		await player.craftInventory({recipeId:"minecraft:stick",count:4,timeoutMs:5000});`},run.context);
	assert.equal(result.reasonCode,'PROGRAM_EXHAUSTED');
	assert.deepEqual(run.commands.map(command=>command.action.type),['navigate_to','wait','craft_inventory']);
	assert.deepEqual(result.receipts.map(receipt=>receipt.state),['FAILED','SUCCEEDED','SUCCEEDED']);
	assert.equal(decisions.length,0);
});

test('onError cannot override deadline or explicit cancellation fences', async () => {
	for (const stop of ['deadline', 'cancel']) {
		let release;
		const timers = [];
		const run = setup({
			executeAction: command => { run.commands.push(command); return new Promise(resolve => { release = resolve; }); },
			cancelAction: async actionId => { run.cancels.push(actionId); release({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }); },
		}, { setTimeoutFn: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeoutFn: () => {} });
		const pending = run.executor.run(record, { source: `${prefix} await tryResult(player.wait(100), async failed => { return await player.wait(2); }); await player.wait(3);`, timeoutMs: 600000 }, run.context);
		if (stop === 'deadline') timers[0].callback();
		else await run.executor.cancel(record.agentId);
		const result = await pending;
		assert.equal(result.reasonCode, stop === 'deadline' ? 'PROGRAM_DEADLINE' : 'PROGRAM_CANCELLED');
		assert.equal(run.commands.length, 1, 'neither the fallback nor next phase dispatches after cancellation');
		assert.deepEqual(run.cancels, [run.commands[0].actionId]);
	}
});

test('onError cannot treat an uncertain transport outcome as a failed physical receipt', async () => {
	const run = setup({ executeAction: async command => {
		run.commands.push(command);
		throw Object.assign(new Error('lost transport'), { code: 'BRIDGE_DISCONNECTED' });
	} });
	const result = await run.executor.run(record, { source: `${prefix} await tryResult(player.wait(1), async failed => { return await player.wait(2); }); await player.wait(3);` }, run.context);
	assert.equal(result.state, 'UNKNOWN');
	assert.equal(result.reasonCode, 'BRIDGE_DISCONNECTED');
	assert.equal(run.commands.length, 1);
});
