import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';

const record = { agentId: 'attention-throttle', goalRevision: 1, provider: 'claude', model: 'selected-model', reasoningEffort: 'low', serviceTier: 'priority' };
const observation = (health = 20, { entities = [], player = {}, blocks = [] } = {}) => ({ player: { x: 0, y: 64, z: 0, health, ...player }, entities, items: [], blocks, inventory: { items: [], tagCounts: {} } });
const turn = () => new Promise(resolve => setImmediate(resolve));

function setup(t, policy = 'continue_and_notify', { elapsed = 30_000 } = {}) {
	let now = 1_000_000, sequence = 1;
	let latestObservation = observation();
	const timers = [], decisions = [], pending = [];
	const executor = new NativeProgramExecutor({
		setTimeoutFn: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { if (timer) timer.cleared = true; },
		now: () => now,
		ordinaryAttentionIntervalMs: 30_000,
	});
	const result = executor.run(record, { source: `program.onUnhandledAttention("${policy}"); await player.wait(1); await player.wait(2);`, programId: 'throttle' }, {
		observation: latestObservation, eventSequence: 1,
		executeAction: () => new Promise((resolve) => { pending.push(resolve); }),
		cancelAction: async () => { for (const resolve of pending.splice(0)) resolve({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED', observation: latestObservation, eventSequence: ++sequence }); return { state: 'CANCELLED' }; },
		onDecision: (status, { priority }) => decisions.push({ decisionId: status.decision?.decisionId, eventSequence: status.decision?.eventSequence, priority }),
	});
	t.after(() => executor.cancel(record.agentId));
	// The window opens when the routine starts; these cases begin once it has run past that first window.
	now += elapsed;
	const sight = (extra = {}) => {
		const { health, entities, player, blocks, ...attention } = extra;
		latestObservation = observation(health, { entities, player, blocks });
		return executor.onObservation(record, { observation: latestObservation, eventSequence: ++sequence, attention: true, priority: 'ordinary', trigger: 'resource_discovery', ...attention });
	};
	const finishAction = () => { for (const resolve of pending.splice(0)) resolve({ state: 'SUCCEEDED', reasonCode: 'DONE', observation: latestObservation, eventSequence: ++sequence }); };
	return { executor, result, timers, decisions, sight, finishAction, advance: (ms) => { now += ms; } };
}

test('ordinary sightings during a running program wake the model once per window and keep one decision handle', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	assert.equal(run.decisions.length, 1, 'the first sighting notifies at once');
	const { decisionId } = run.decisions[0];
	for (let index = 0; index < 5; index++) { run.advance(3_000); run.sight(); await turn(); }
	assert.equal(run.decisions.length, 1, 'repeated ordinary sightings within the window do not wake the model again');
	assert.equal(run.executor.status(record).decision.decisionId, decisionId, 'an in-flight respondProgram stays valid');
	run.advance(16_000);
	run.sight();
	await turn();
	assert.equal(run.decisions.length, 2, 'after the window the latest facts reach the model');
	assert.equal(run.decisions[1].decisionId, decisionId);
	const status = run.executor.respond(record, { programId: 'throttle', decisionId, directive: 'continue' });
	assert.equal(status.engineState, 'ACTIVE');
});

test('an ignored discovery does not remove the launch window for later routine attention', async t => {
	let now = 0;
	let completeAction;
	const timers = [], decisions = [];
	const executor = new NativeProgramExecutor({ now: () => now,
		setTimeoutFn: (callback, ms) => { const timer = { callback, due: now + ms }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { timer.cleared = true; },
	});
	executor.run(record, { timeoutMs: 120000, programId: 'ignored',
		source: 'program.onUnhandledAttention("continue_and_notify", {reassessWhen: () => player.state().x > 0}); await player.wait(1); await player.wait(2);' }, {
		observation: observation(), eventSequence: 1, executeAction: () => new Promise(resolve => { completeAction = resolve; }),
		cancelAction: async () => { completeAction?.({ state: 'CANCELLED', reasonCode: 'CANCELLED' }); return { state: 'CANCELLED' }; }, onDecision: status => decisions.push(status),
	});
	t.after(() => executor.cancel(record.agentId));
	await turn();
	now = 1000;
	executor.onObservation(record, { observation: observation(), eventSequence: 2, attention: true, trigger: 'resource_discovery',
		resourceSightings: [{ observedAtEpochMs: now, block: { x: 1, y: 64, z: 0, blockId: 'minecraft:diamond_ore' } }] });
	await turn();
	now = 2000;
	executor.onObservation(record, { observation: observation(20, { player: { x: 1 } }), eventSequence: 3, attention: true, trigger: 'structure_sighted' });
	await turn();
	assert.equal(decisions.length, 0);
	assert.ok(timers.some(timer => !timer.cleared && timer.due === 30000));
});

test('a deferred ordinary notification is delivered when its window ends', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	run.executor.respond(record, { programId: 'throttle', decisionId: run.decisions[0].decisionId, directive: 'continue' });
	run.advance(5_000);
	run.sight();
	await turn();
	assert.equal(run.decisions.length, 1, 'a new ordinary decision inside the window waits');
	const deferred = run.timers.find(timer => timer.ms === 25_000 && !timer.cleared);
	assert.ok(deferred, 'the remaining window is scheduled');
	run.advance(25_000);
	deferred.callback();
	assert.equal(run.decisions.length, 2);
	assert.notEqual(run.decisions[1].decisionId, run.decisions[0].decisionId);
});

test('urgent attention always notifies at once', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	run.advance(1_000);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 12 });
	await turn();
	assert.equal(run.decisions.length, 2);
	assert.equal(run.decisions[1].priority, 'urgent');
});

test('an urgent batch notifies the latest sequence and accepts continue without a status round trip', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 18 });
	run.sight({ priority: 'urgent', trigger: 'damage', health: 16 });
	run.sight({ priority: 'urgent', trigger: 'damage', health: 14 });
	await turn();
	assert.equal(run.decisions.length, 1, 'urgent observations in one bridge batch coalesce');
	const { decisionId, eventSequence } = run.decisions[0];
	assert.equal(run.executor.status(record).decision.eventSequence, eventSequence, 'the live handle carries the latest observed facts');
	assert.equal(run.executor.status(record).decision.trigger, 'damage');
	assert.equal(eventSequence, 5, 'notification records the facts the model actually received');
	assert.equal(run.executor.respond(record, { programId: 'throttle', decisionId, directive: 'continue' }).engineState, 'ACTIVE');
});

test('continue accepts more damage from the same attacker within the ongoing-danger threshold', async t => {
	const run = setup(t);
	const zombie = { stableId: 'zombie-a', type: 'minecraft:zombie', hostile: true, x: 1, y: 64, z: 0 };
	run.sight();
	await turn();
	run.sight({ priority: 'urgent', trigger: 'damage', health: 18, entities: [zombie], player: { lastAttacker: { uuid: 'zombie-a' } } });
	await turn();
	assert.equal(run.decisions.length, 2, 'the urgent facts are notified after the ordinary attention');
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 16, entities: [zombie], player: { lastAttacker: { uuid: 'zombie-a' } } });
	assert.equal(run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }).engineState, 'ACTIVE');
});

test('continue rejects a health loss greater than two hearts even from the same attacker', async t => {
	const run = setup(t);
	const zombie = { stableId: 'zombie-a', type: 'minecraft:zombie', hostile: true, x: 1, y: 64, z: 0 };
	run.sight();
	await turn();
	run.sight({ priority: 'urgent', trigger: 'damage', health: 18, entities: [zombie], player: { lastAttacker: { uuid: 'zombie-a' } } });
	await turn();
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 12, entities: [zombie], player: { lastAttacker: { uuid: 'zombie-a' } } });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.facts.health.droppedBy, 6);
		return true;
	});
});

test('continue rejects a critical health floor even when the loss is within the bounded delta', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 5 });
	await turn();
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 1 });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.facts.health.lowRemainingHealth, true);
		assert.equal(error.freshDecision.facts.health.current, 1);
		return true;
	});
});

test('continue rejects health loss greater than half of the remaining health', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 11 });
	await turn();
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 7 });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.facts.health.droppedBy, 4);
		assert.equal(error.freshDecision.facts.health.largeRelativeDrop, true);
		return true;
	});
});

test('continue rejects zero air even when the air loss equals the bounded delta', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'suffocation', player: { air: 20 } });
	await turn();
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'suffocation', player: { air: 0 } });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.facts.air.critical, true);
		assert.equal(error.freshDecision.facts.air.current, 0);
		return true;
	});
});

test('continue rejects negative air even when the air loss equals the bounded delta', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'suffocation', player: { air: 0 } });
	await turn();
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'suffocation', player: { air: -20 } });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.facts.air.critical, true);
		assert.equal(error.freshDecision.facts.air.current, -20);
		return true;
	});
});

test('replace answers a drowning decision after air ran down and drowning damage began', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'drowning', player: { air: 140 } });
	await turn();
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 16, player: { air: 0 } });
	const status = run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'replace', source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(3);' });
	assert.notEqual(status, null, 'the same harm worsening while the model replied does not stale its escape');
});

test('replace still rejects a threat that appeared after the drowning decision', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'drowning', player: { air: 140 } });
	await turn();
	const notified = run.decisions.at(-1);
	const drowned = { stableId: 'drowned-1', type: 'minecraft:drowned', hostile: true, x: 3, y: 64, z: 0 };
	run.sight({ priority: 'urgent', trigger: 'drowning', entities: [drowned], player: { air: 100 } });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'replace', source: 'await player.wait(3);' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.deepEqual(error.freshDecision.facts.newThreats.map(({ uuid }) => uuid), ['drowned-1']);
		return true;
	});
});

test('continue rejects a creeper approaching inside three blocks without swelling', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	const creeper = { stableId: 'creeper-close', type: 'minecraft:creeper', hostile: true, swelling: false, x: 3, y: 64, z: 0 };
	run.sight({ priority: 'urgent', trigger: 'threat', entities: [creeper] });
	await turn();
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'threat', entities: [{ ...creeper, x: 1 }] });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.facts.changedThreats[0].changes.closeApproach, true);
		return true;
	});
});

test('continue rejects when the player catches fire', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'damage', player: { onFire: false } });
	await turn();
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 18, player: { onFire: true } });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.deepEqual(error.freshDecision.facts.onFire, { notified: false, current: true });
		return true;
	});
});

test('continue rejects projectiles, TNT, and known hostile types without a hostile flag', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'threat' });
	await turn();
	const notified = run.decisions.at(-1);
	const entities = [
		{ stableId: 'arrow-1', type: 'minecraft:arrow', hostile: false, x: 4, y: 64, z: 0 },
		{ stableId: 'tnt-1', type: 'minecraft:tnt', hostile: false, fuse: 40, x: 5, y: 64, z: 0 },
		{ stableId: 'dragon-1', type: 'minecraft:ender_dragon', hostile: false, x: 8, y: 64, z: 0 },
	];
	run.sight({ priority: 'urgent', trigger: 'threat', entities });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.deepEqual(error.freshDecision.facts.newThreats.map(({ uuid, type }) => [uuid, type]), [
			['arrow-1', 'minecraft:arrow'], ['tnt-1', 'minecraft:tnt'], ['dragon-1', 'minecraft:ender_dragon'],
		]);
		return true;
	});
});

test('continue without eventSequence uses the oldest facts shown for the urgent handle', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 20 });
	await turn();
	const firstNotification = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 16 });
	await turn();
	run.sight({ priority: 'urgent', trigger: 'damage', health: 12 });
	await turn();
	run.sight({ priority: 'urgent', trigger: 'damage', health: 10 });
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: firstNotification.decisionId,
		directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.facts.health.notified, 20);
		assert.equal(error.freshDecision.facts.health.current, 10);
		assert.equal(error.freshDecision.facts.health.droppedBy, 10);
		return true;
	});
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: firstNotification.decisionId,
		eventSequence: firstNotification.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.facts.health.droppedBy, 10);
		return true;
	});
});

test('ordinary facts folded into an urgent handle do not cause a spurious stale response', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 18 });
	await turn();
	const notified = run.decisions.at(-1);
	run.sight({ health: 18 });
	const folded = run.executor.status(record).decision;
	assert.ok(folded.eventSequence > notified.eventSequence);
	assert.equal(run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: folded.eventSequence, directive: 'continue' }).engineState, 'ACTIVE');
});

test('ordinary-to-urgent escalation returns the fresh decision inline for the old handle', async t => {
	const run = setup(t);
	run.sight({ health: 20 });
	await turn();
	const oldHandle = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 18 });
	await turn();
	const current = run.executor.status(record).decision;
	assert.notEqual(current.decisionId, oldHandle.decisionId);
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: oldHandle.decisionId,
		eventSequence: oldHandle.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.decisionId, current.decisionId);
		assert.equal(error.freshDecision.trigger, 'damage');
		assert.match(error.message, /Fresh decision:/);
		return true;
	});
});

test('inline fresh decisions cap threat rows and report omitted threats', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'threat' });
	await turn();
	const notified = run.decisions.at(-1);
	const entities = Array.from({ length: 60 }, (_, index) => ({ stableId: `zombie-${index}`,
		type: 'minecraft:zombie', hostile: true, x: index, y: 64, z: 3 }));
	run.sight({ priority: 'urgent', trigger: 'threat', entities });
	let firstFresh;
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		firstFresh = error.freshDecision;
		assert.equal(error.freshDecision.facts.newThreats.length, 8);
		assert.equal(error.freshDecision.facts.omittedThreats, 52);
		assert.ok(Buffer.byteLength(error.message) < 3_500);
		return true;
	});
	assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: firstFresh.decisionId,
		eventSequence: firstFresh.eventSequence, directive: 'continue' }), (error) => {
		assert.equal(error.code, 'STALE_PROGRAM_DECISION');
		assert.equal(error.freshDecision.facts.newThreats.length, 8);
		assert.equal(error.freshDecision.facts.omittedThreats, 44);
		return true;
	});
});

test('materially new danger rejects continue with fresh decision facts for an immediate retry', async t => {
	const run = setup(t);
	const zombie = { stableId: 'zombie-a', type: 'minecraft:zombie', hostile: true, x: 1, y: 64, z: 0 };
	const creeper = { stableId: 'creeper-b', type: 'minecraft:creeper', hostile: true, swelling: false, x: 4, y: 64, z: 0 };
	run.sight();
	await turn();
	run.sight({ priority: 'urgent', trigger: 'damage', health: 18, entities: [zombie], player: { lastAttacker: { uuid: 'zombie-a' } } });
	await turn();
	assert.equal(run.decisions.length, 2, 'the urgent facts are notified after the ordinary attention');
	const notified = run.decisions.at(-1);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 18, entities: [zombie, creeper], player: { lastAttacker: { uuid: 'zombie-a' } } });
	let rejection;
	try {
		run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
			eventSequence: notified.eventSequence, directive: 'continue' });
	} catch (error) { rejection = error; }
	assert.equal(rejection?.code, 'STALE_PROGRAM_DECISION');
	assert.equal(rejection?.freshDecision?.eventSequence, run.executor.status(record).decision.eventSequence);
	assert.equal(rejection?.freshDecision?.trigger, 'damage');
	assert.deepEqual(rejection?.freshDecision?.facts?.newThreats?.map(({ uuid, type }) => ({ uuid, type })),
		[{ uuid: 'creeper-b', type: 'minecraft:creeper' }]);
	assert.match(rejection?.message ?? '', /Fresh decision:/, 'the fresh handle and facts are inline in the tool rejection');
	assert.equal(run.executor.respond(record, { programId: 'throttle', decisionId: rejection.freshDecision.decisionId,
		eventSequence: rejection.freshDecision.eventSequence, directive: 'continue' }).engineState, 'ACTIVE',
		'the tool rejection itself supplies the retry facts without programStatus');
});

test('continue rejects a newly attacking entity and a creeper that starts swelling', async t => {
	await t.test('new attacker', async subtest => {
		const run = setup(subtest);
		const zombieA = { stableId: 'zombie-a', type: 'minecraft:zombie', hostile: true, x: 1, y: 64, z: 0 };
		const zombieB = { stableId: 'zombie-b', type: 'minecraft:zombie', hostile: true, x: 2, y: 64, z: 0 };
		run.sight();
		await turn();
		run.sight({ priority: 'urgent', trigger: 'damage', health: 18, entities: [zombieA], player: { lastAttacker: { uuid: 'zombie-a' } } });
		await turn();
		const notified = run.decisions.at(-1);
		run.sight({ priority: 'urgent', trigger: 'damage', health: 18, entities: [zombieA, zombieB], player: { lastAttacker: { uuid: 'zombie-b' } } });
		assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
			eventSequence: notified.eventSequence, directive: 'continue' }), { code: 'STALE_PROGRAM_DECISION' });
	});
	await t.test('creeper starts swelling', async subtest => {
		const run = setup(subtest);
		const creeper = { stableId: 'creeper-a', type: 'minecraft:creeper', hostile: true, swelling: false, x: 4, y: 64, z: 0 };
		run.sight();
		await turn();
		run.sight({ priority: 'urgent', trigger: 'threat', entities: [creeper] });
		await turn();
		const notified = run.decisions.at(-1);
		run.sight({ priority: 'urgent', trigger: 'threat', entities: [{ ...creeper, swelling: true }] });
		assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
			eventSequence: notified.eventSequence, directive: 'continue' }), (error) => {
			assert.equal(error.code, 'STALE_PROGRAM_DECISION');
			assert.equal(error.freshDecision.facts.changedThreats[0].changes.swelling, true);
			return true;
		});
	});
});

test('urgent-to-urgent trigger escalation keeps the same decision handle and refreshes the trigger', async t => {
	const run = setup(t);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 18 });
	await turn();
	const decisionId = run.decisions[0].decisionId;
	run.sight({ priority: 'urgent', trigger: 'suffocation', health: 18 });
	await turn();
	assert.equal(run.decisions.length, 2, 'a materially different urgent trigger still notifies');
	assert.equal(run.decisions[1].decisionId, decisionId, 'urgent escalation does not invalidate the handle already shown');
	assert.equal(run.executor.status(record).decision.trigger, 'suffocation');
	assert.equal(run.executor.status(record).decision.eventSequence, 4);
});

test('ordinary attention folded after the last notification is not lost when the model answers continue', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	const first = run.decisions[0].decisionId;
	run.advance(3_000);
	run.sight();
	await turn();
	assert.equal(run.decisions.length, 1);
	const folded = run.executor.status(record).decision;
	assert.equal(folded.decisionId, first);
	assert.equal(folded.eventSequence, 3, 'the folded decision carries the newest facts');
	run.executor.respond(record, { programId: 'throttle', decisionId: first, directive: 'continue' });
	await turn();
	const reopened = run.executor.status(record).decision;
	assert.ok(reopened && reopened.decisionId !== first, 'the unseen sighting opens a new decision');
	const deferred = run.timers.find(timer => !timer.cleared && timer.ms === 27_000);
	assert.ok(deferred, 'through the same window');
	run.advance(27_000);
	deferred.callback();
	assert.equal(run.decisions.length, 2);
	assert.equal(run.decisions[1].decisionId, reopened.decisionId);
});

test('a folded ordinary decision is not rejected for an older eventSequence', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	const notified = run.decisions[0];
	run.advance(3_000);
	run.sight();
	await turn();
	assert.equal(run.executor.status(record).decision.eventSequence, notified.eventSequence + 1);
	assert.equal(run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId,
		eventSequence: notified.eventSequence, directive: 'continue' }).engineState, 'ACTIVE');
});

test('a continue with nothing unseen does not reopen a decision', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	run.executor.respond(record, { programId: 'throttle', decisionId: run.decisions[0].decisionId, directive: 'continue' });
	await turn();
	assert.equal(run.executor.status(record).decision, undefined);
});

test('lava newly in view, lost health or a changed dimension skip the ordinary window', async t => {
	for (const change of [
		(observation) => ({ ...observation, blocks: [{ stableId: '3,63,0', x: 3, y: 63, z: 0, blockId: 'minecraft:lava', tags: [], state: {} }] }),
		(observation) => ({ ...observation, player: { ...observation.player, health: 19 } }),
		(observation) => ({ ...observation, world: { worldId: 'w', dimension: 'minecraft:the_nether' } }),
	]) {
		const run = setup(t);
		run.sight();
		await turn();
		run.executor.respond(record, { programId: 'throttle', decisionId: run.decisions[0].decisionId, directive: 'continue' });
		run.advance(2_000);
		run.sight({ observation: change({ ...observation(), world: { worldId: 'w', dimension: 'minecraft:overworld' } }) });
		await turn();
		assert.equal(run.decisions.length, 2, 'a hazard edge reaches the model at once');
	}
});

test('hazard edges compare against the previous facts only', async () => {
	const { hazardEdge } = await import('../src/native-program-executor.mjs');
	const lava = { blocks: [{ x: 1, y: 2, z: 3, blockId: 'minecraft:lava' }], player: { health: 20, air: 300 } };
	assert.equal(hazardEdge(lava, lava), false, 'lava already in view is not a new edge');
	assert.equal(hazardEdge({ blocks: [], player: { health: 20 } }, lava), true);
	assert.equal(hazardEdge({ player: { health: 20, air: 300 } }, { player: { health: 20, air: 280 } }), true);
	assert.equal(hazardEdge({ player: { onFire: false } }, { player: { onFire: true } }), true);
	assert.equal(hazardEdge({ player: { health: 18 } }, { player: { health: 20 } }), false, 'healing is not a hazard');
	assert.equal(hazardEdge(null, lava), false);
});

test('the window opens when the routine starts, but urgent facts still notify at once', async t => {
	const run = setup(t, 'continue_and_notify', { elapsed: 0 });
	run.sight({ trigger: 'attention' });
	await turn();
	assert.equal(run.decisions.length, 0, 'the model wrote the routine from the facts it had at launch');
	assert.ok(run.timers.some(timer => timer.ms === 30_000 && !timer.cleared), 'the sighting waits for the first window');
	run.advance(1_000);
	run.sight({ priority: 'urgent', trigger: 'damage', health: 15 });
	await turn();
	assert.equal(run.decisions.length, 1);
	assert.equal(run.decisions[0].priority, 'urgent');
});

test('ordinary attention landing between one action result and the next dispatch waits for the window', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	run.executor.respond(record, { programId: 'throttle', decisionId: run.decisions[0].decisionId, directive: 'continue' });
	run.advance(3_000);
	// The observation that follows a broken block arrives right after its result, before the body dispatches again.
	run.finishAction();
	run.sight();
	await turn();
	run.advance(500);
	run.sight();
	await turn();
	assert.equal(run.decisions.length, 1, 'the gap between actions is still inside the routine');
	assert.ok(run.timers.some(timer => timer.ms === 27_000 && !timer.cleared), 'the sighting is delivered when the window ends');
	run.sight({ priority: 'urgent', trigger: 'action_failure' });
	await turn();
	assert.equal(run.decisions.length, 2, 'a failure in the same gap notifies at once');
});

test('the body flipping between acting and starting is not a hazard edge, but death or disconnection is', async () => {
	const { hazardEdge } = await import('../src/native-program-executor.mjs');
	const at = (status, ready = true) => ({ status, ready, player: { health: 20 } });
	assert.equal(hazardEdge(at('ACTING'), at('STARTING')), false);
	assert.equal(hazardEdge(at('STARTING'), at('ACTING')), false);
	assert.equal(hazardEdge(at('ACTING'), at('IDLE')), false);
	assert.equal(hazardEdge(at('ACTING'), at('DEAD')), true);
	assert.equal(hazardEdge(at('ACTING'), at('DISCONNECTED')), true);
	assert.equal(hazardEdge(at('ACTING'), at('ERROR')), true);
	assert.equal(hazardEdge(at('ACTING'), at('ACTING', false)), true, 'losing readiness is still news');
});

test('a routine whose source ran out does not wait out the window for its pending decision', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	run.executor.respond(record, { programId: 'throttle', decisionId: run.decisions[0].decisionId, directive: 'continue' });
	run.advance(3_000);
	run.sight();
	await turn();
	assert.equal(run.decisions.length, 1, 'while the body works the sighting waits for the window');
	assert.ok(run.timers.some(timer => timer.ms === 27_000 && !timer.cleared));
	run.finishAction();
	await turn();
	run.finishAction();
	for (let index = 0; index < 5; index++) await turn();
	assert.equal(run.decisions.length, 2, 'the idle body notifies at once instead of after the window');
	assert.ok(run.timers.filter(timer => timer.ms === 27_000).every(timer => timer.cleared), 'the deferred timer is retired');
});

test('sightings on an idle body fold into the pending decision: one notification, and the in-flight answer stays valid', async t => {
	const run = setup(t);
	run.sight();
	await turn();
	assert.equal(run.decisions.length, 1);
	const { decisionId } = run.decisions[0];
	run.finishAction();
	await turn();
	run.finishAction();
	for (let index = 0; index < 5; index++) await turn();
	for (let index = 0; index < 4; index++) { run.advance(1_000); run.sight(); await turn(); }
	assert.equal(run.decisions.length, 1, 'no new handle and no new wake per observation');
	assert.equal(run.executor.status(record).decision.decisionId, decisionId);
	assert.doesNotThrow(() => run.executor.respond(record, { programId: 'throttle', decisionId, directive: 'continue' }), 'the model answers the handle it was given');
});

test('a resource first seen after launch notifies at once, inside the launch window, while it is still in view', async t => {
	const run = setup(t, 'continue_and_notify', { elapsed: 0 });
	run.advance(1_000);
	run.sight();
	await turn();
	assert.equal(run.decisions.length, 1, 'the model did not have this resource when it wrote the routine');
	const shownSequence = run.decisions[0].eventSequence;
	// The ore leaves view on the next observation: the wake already went out with the observation that showed it.
	run.advance(1_000);
	run.sight({ attention: false });
	await turn();
	assert.equal(run.decisions.length, 1);
	assert.equal(shownSequence, 2, 'the wake carries the observation in which the resource was seen');
});

test('a resource sighting folded into a launch-deferred routine notification brings it forward', async t => {
	const run = setup(t, 'continue_and_notify', { elapsed: 0 });
	run.sight({ trigger: 'attention' });
	await turn();
	assert.equal(run.decisions.length, 0, 'routine progress waits for the launch window');
	run.advance(2_000);
	run.sight();
	await turn();
	assert.equal(run.decisions.length, 1, 'the new resource does not wait behind the routine window');
});

test('routine attention in the same batch after a new resource does not push the resource back to the launch window', async t => {
	const run = setup(t, 'continue_and_notify', { elapsed: 0 });
	run.advance(1_000);
	run.sight();
	run.sight({ trigger: 'attention' });
	await turn();
	assert.equal(run.decisions.length, 1);
});

test('replace answers a shown threat that closed in and hit while far non-targeting mobs came into view', async t => {
	const run = setup(t);
	const skeleton = { stableId: 'wither-a', type: 'minecraft:wither_skeleton', hostile: true, targetingAgent: true, x: 15, y: 64, z: 0 };
	run.sight({ priority: 'urgent', trigger: 'threat', entities: [skeleton] });
	await turn();
	const notified = run.decisions.at(-1);
	const far = [
		{ stableId: 'wither-far-1', type: 'minecraft:wither_skeleton', hostile: true, targetingAgent: false, x: 59, y: 64, z: 10 },
		{ stableId: 'piglin-far', type: 'minecraft:zombified_piglin', hostile: true, targetingAgent: false, x: 0, y: 58, z: 33 },
	];
	run.sight({ priority: 'urgent', trigger: 'damage', health: 15.5, entities: [{ ...skeleton, x: 1.6 }, ...far], player: { lastAttacker: { uuid: 'wither-a' } } });
	const status = run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId, eventSequence: notified.eventSequence,
		directive: 'replace', source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1);' });
	assert.notEqual(status, null, 'the fight answer to the shown wither skeleton lands');
});

test('replace answers a shown blaze whose next volley is in flight and set the player on fire', async t => {
	const run = setup(t);
	const blaze = { stableId: 'blaze-a', type: 'minecraft:blaze', hostile: true, targetingAgent: true, x: 5, y: 69, z: 0 };
	run.sight({ priority: 'urgent', trigger: 'threat', entities: [blaze] });
	await turn();
	const notified = run.decisions.at(-1);
	const shot = { stableId: 'fireball-1', type: 'minecraft:small_fireball', x: 3, y: 65, z: 0 };
	run.sight({ priority: 'urgent', trigger: 'fire', health: 16.3, entities: [blaze, shot], player: { onFire: true, lastAttacker: { uuid: 'blaze-a' } } });
	const status = run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId, eventSequence: notified.eventSequence,
		directive: 'replace', source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1);' });
	assert.notEqual(status, null, 'the reply to the shown blaze lands');
});

test('replace still rejects catching fire with no fire-shooting threat shown, and a new shooter', async t => {
	await t.test('fire with only a wither skeleton shown', async subtest => {
		const run = setup(subtest);
		const skeleton = { stableId: 'wither-a', type: 'minecraft:wither_skeleton', hostile: true, targetingAgent: true, x: 4, y: 64, z: 0 };
		run.sight({ priority: 'urgent', trigger: 'threat', entities: [skeleton] });
		await turn();
		const notified = run.decisions.at(-1);
		run.sight({ priority: 'urgent', trigger: 'fire', entities: [skeleton], player: { onFire: true } });
		assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId, eventSequence: notified.eventSequence,
			directive: 'replace', source: 'await player.wait(1);' }), { code: 'STALE_PROGRAM_DECISION' });
	});
	await t.test('a new blaze with its shot', async subtest => {
		const run = setup(subtest);
		const skeleton = { stableId: 'wither-a', type: 'minecraft:wither_skeleton', hostile: true, targetingAgent: true, x: 4, y: 64, z: 0 };
		run.sight({ priority: 'urgent', trigger: 'threat', entities: [skeleton] });
		await turn();
		const notified = run.decisions.at(-1);
		const blaze = { stableId: 'blaze-b', type: 'minecraft:blaze', hostile: true, targetingAgent: true, x: 10, y: 70, z: 0 };
		const shot = { stableId: 'fireball-2', type: 'minecraft:small_fireball', x: 6, y: 67, z: 0 };
		run.sight({ priority: 'urgent', trigger: 'projectile', entities: [skeleton, blaze, shot] });
		assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId, eventSequence: notified.eventSequence,
			directive: 'replace', source: 'await player.wait(1);' }), (error) => {
			assert.equal(error.code, 'STALE_PROGRAM_DECISION');
			return true;
		});
	});
});

test('replace still rejects a far mob that is targeting the player and a new attacker it was not shown', async t => {
	await t.test('far targeting ghast', async subtest => {
		const run = setup(subtest);
		const skeleton = { stableId: 'wither-a', type: 'minecraft:wither_skeleton', hostile: true, targetingAgent: true, x: 4, y: 64, z: 0 };
		run.sight({ priority: 'urgent', trigger: 'threat', entities: [skeleton] });
		await turn();
		const notified = run.decisions.at(-1);
		const ghast = { stableId: 'ghast-a', type: 'minecraft:ghast', hostile: true, targetingAgent: true, x: 40, y: 70, z: 0 };
		run.sight({ priority: 'urgent', trigger: 'threat', entities: [skeleton, ghast] });
		assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId, eventSequence: notified.eventSequence,
			directive: 'replace', source: 'await player.wait(1);' }), (error) => {
			assert.equal(error.code, 'STALE_PROGRAM_DECISION');
			assert.deepEqual(error.freshDecision.facts.newThreats.map(({ uuid }) => uuid), ['ghast-a']);
			return true;
		});
	});
	await t.test('unseen attacker', async subtest => {
		const run = setup(subtest);
		run.sight({ priority: 'urgent', trigger: 'threat', entities: [] });
		await turn();
		const notified = run.decisions.at(-1);
		run.sight({ priority: 'urgent', trigger: 'damage', health: 16, entities: [], player: { lastAttacker: { uuid: 'blaze-behind', type: 'minecraft:blaze' } } });
		assert.throws(() => run.executor.respond(record, { programId: 'throttle', decisionId: notified.decisionId, eventSequence: notified.eventSequence,
			directive: 'replace', source: 'await player.wait(1);' }), { code: 'STALE_PROGRAM_DECISION' });
	});
});

test('the program deadline waits for the model to answer an urgent decision, bounded by timeoutMs', async t => {
	let now = 0;
	const timers = [];
	const pending = [];
	const executor = new NativeProgramExecutor({ now: () => now,
		setTimeoutFn: (callback, ms) => { const timer = { callback, due: now + ms, cleared: false }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { if (timer) timer.cleared = true; },
	});
	const fire = () => { for (const timer of timers.filter(entry => !entry.cleared && entry.due <= now)) { timer.cleared = true; timer.callback(); } };
	const decisions = [];
	executor.run(record, { timeoutMs: 20_000, programId: 'deadline',
		source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1); await player.wait(2);' }, {
		observation: observation(), eventSequence: 1, executeAction: () => new Promise(resolve => { pending.push(resolve); }),
		cancelAction: async () => { for (const resolve of pending.splice(0)) resolve({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED', observation: observation(), eventSequence: 3 }); return { state: 'CANCELLED' }; },
		onDecision: status => decisions.push(status.decision),
	});
	t.after(() => executor.cancel(record.agentId));
	await turn();
	now = 5_000;
	const skeleton = { stableId: 'wither-a', type: 'minecraft:wither_skeleton', hostile: true, targetingAgent: true, x: 8, y: 64, z: 0 };
	executor.onObservation(record, { observation: observation(20, { entities: [skeleton] }), eventSequence: 2, attention: true, priority: 'urgent', trigger: 'threat' });
	await turn();
	fire();
	const decision = executor.status(record).decision;
	assert.equal(decision.priority, 'urgent');
	now = 20_000;
	fire();
	now = 22_000;
	fire();
	assert.notEqual(executor.status(record), null, 'the deadline does not end the program while the model owes the urgent answer');
	now = 24_000;
	fire();
	executor.respond(record, { programId: 'deadline', decisionId: decision.decisionId, directive: 'replace', source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1);' });
	await turn();
	assert.notEqual(executor.status(record), null, 'the replacement runs');
	const deadline = timers.filter(timer => !timer.cleared).map(timer => timer.due).sort((a, b) => b - a)[0];
	assert.equal(deadline, 20_000 + 19_000, 'the 19 s the routine was held for the answer is credited');
	now = 38_999;
	fire();
	assert.equal(executor.status(record)?.engineState, 'ACTIVE');
	now = 39_000;
	fire();
	for (let index = 0; index < 5; index++) await turn();
	assert.equal(executor.status(record), null, 'the credited deadline still ends the program');
});

test('an unanswered urgent decision still ends at twice timeoutMs', async t => {
	let now = 0;
	const timers = [];
	const executor = new NativeProgramExecutor({ now: () => now,
		setTimeoutFn: (callback, ms) => { const timer = { callback, due: now + ms, cleared: false }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { if (timer) timer.cleared = true; },
	});
	const fire = () => { for (const timer of timers.filter(entry => !entry.cleared && entry.due <= now)) { timer.cleared = true; timer.callback(); } };
	const pending = [];
	executor.run(record, { timeoutMs: 10_000, programId: 'unanswered', source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1);' }, {
		observation: observation(), eventSequence: 1, executeAction: () => new Promise(resolve => { pending.push(resolve); }),
		cancelAction: async () => { for (const resolve of pending.splice(0)) resolve({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED', observation: observation(), eventSequence: 3 }); return { state: 'CANCELLED' }; },
		onDecision: () => {},
	});
	t.after(() => executor.cancel(record.agentId));
	await turn();
	executor.onObservation(record, { observation: observation(18), eventSequence: 2, attention: true, priority: 'urgent', trigger: 'damage' });
	await turn();
	now = 10_000;
	fire();
	now = 19_000;
	fire();
	assert.notEqual(executor.status(record), null);
	now = 20_000;
	fire();
	assert.equal(executor.status(record), null);
});
