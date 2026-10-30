import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildNativeEventInput, classifyObservationTrigger } from '../src/dynamic-main.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { encodeNativeEventInput, decodeModelFacts } from '../src/model-fact-encoding.mjs';
import { createInterpreterFacts } from '../src/arena-script/facts.mjs';
import { goalSpecFingerprint } from '../src/goal-spec.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { compactStandingOrder, MAX_STANDING_ORDERS, MAX_STANDING_REPORT_BYTES, STANDING_REFIRE_MS, StandingOrderBook, standingOrderCause } from '../src/standing-orders.mjs';

const fields = { originalRequest: 'beat the game', predicate: { type: 'inventory_contains', itemId: 'minecraft:ender_eye', count: 12 }, createdAtTick: 10 };
const record = () => ({ agentId: 'agent-a', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority',
	goalRevision: 3, currentGoal: fields.originalRequest, currentGoalSpec: { ...fields, fingerprint: goalSpecFingerprint(fields) } });
const call = (tool, id = 'call-1') => ({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn-1', callId: id, tool });
const POLICY = 'program.onUnhandledAttention("continue_and_notify", { survival: "continue_and_notify" });';
const threat = (index) => ({ uuid: `00000000-0000-4000-8000-00000000000${index}`, type: 'minecraft:zombie', distance: 2 + index, bearing: 30 * index,
	targeting: true, swelling: false, lineOfSight: true, signals: ['targeting'], risk: 2 });

/** A wire observation as the server publishes it; only the facts a scenario changes are overridden. */
function wire(player = {}, extra = {}) {
	return { ready: true, position: { x: 0.5, y: 64, z: 0.5 }, view: { yaw: 0, pitch: 0 },
		player: { health: 20, maxHealth: 20, foodLevel: 20, onFire: false, inLava: false, air: 300, maxAir: 300, onGround: true, fallDistance: 0, ...player },
		inventory: { selectedSlot: 0, items: [{ slot: 0, itemId: 'minecraft:cooked_beef', count: 6 }, { slot: 1, itemId: 'minecraft:water_bucket', count: 1 }] },
		entities: [], blocks: [], items: [], ...extra };
}

function harness({ book = new StandingOrderBook(), holdActions = new Set(), failActions = new Set(), programExecutor = null, failureMessage = '' } = {}) {
	const sent = [];
	const events = [];
	const traces = [];
	let sequence = 1;
	let current = wire();
	let runtime;
	const settle = (actionId, state = 'SUCCEEDED', reasonCode = '') => runtime.onActionResult(record(), { actionId, state, reasonCode, executionStarted: true, ...(state === 'FAILED' && failureMessage ? { message: failureMessage } : {}) });
	runtime = new NativeToolRuntime({
		standingOrders: book,
		programExecutor,
		trace: (event, fields) => traces.push({ event, ...fields }),
		bridge: { send: async (type, agentId, payload) => {
			sent.push({ type, payload });
			if (type === 'action_command' && !holdActions.has(payload.actionType)) queueMicrotask(() => failActions.has(payload.actionType) ? settle(payload.actionId, 'FAILED', failActions instanceof Map ? failActions.get(payload.actionType) : 'ITEM_NOT_FOUND') : settle(payload.actionId));
			if (type === 'action_cancel') queueMicrotask(() => settle(payload.actionId, 'CANCELLED', 'CANCELLED'));
		} },
		requestObservation: async () => ({ observation: adaptObservation(current), eventSequence: ++sequence }),
		onProgramEvent: (_record, event) => { events.push(event); },
	});
	// The coordinator stores adapted samples (dynamic-main adapts each wire observation before the runtime sees it).
	const observe = (observation, options = {}) => { current = observation; runtime.updateObservation(record(), observation.ready === true ? adaptObservation(observation) : observation, { ...options, eventSequence: ++sequence }); };
	return { runtime, sent, events, traces, observe, settle };
}

const commands = (sent) => sent.filter(({ type }) => type === 'action_command').map(({ payload }) => payload);

test('guard wake status exposes a rejected behind-player condition and missing facts without claiming protection', () => {
	const book = new StandingOrderBook();
	const args = { id: 'reflex', guard: true, source: POLICY, when: 'player.state().threat !== null && player.state().threat.visible' };
	book.set('a', args);
	assert.equal(book.guardCoverage('a'), 'reflex: installed, condition unchecked, fired 0x');
	const behind = wire({}, { threats: { entries: [{ ...threat(1), visible: false, targetable: true, type: 'minecraft:creeper', swelling: true }] } });
	assert.equal(book.evaluate('a', behind), null);
	assert.equal(book.guardCoverage('a'), 'reflex: installed, condition false, fired 0x');
	book.set('a', { ...args, when: 'player.state().threat !== null && player.state().threat.targetable' });
	assert.equal(book.evaluate('a', behind)?.id, 'reflex');
	book.markFired('a', 'reflex');
	assert.equal(book.guardCoverage('a'), 'reflex: installed, condition true, fired 1x');
	book.set('a', { ...args, when: 'player.state().missingFact' });
	assert.equal(book.evaluate('a', behind), null);
	assert.match(book.guardCoverage('a'), /condition error UNKNOWN_MEMBER/);
	book.rearm('a');
	book.evaluate('a', behind);
	assert.match(book.guardCoverage('a'), /condition error UNKNOWN_MEMBER/);
});
async function until(predicate, label) {
	for (let index = 0; index < 200; index += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(`timed out waiting for ${label}`);
}

test('runProgram standing installs, replaces and deletes orders without running them', () => {
	assert.deepEqual(normalizeMinecraftToolCall('runProgram', { source: POLICY, standing: { id: 'eat', when: 'player.state().fire', ttlS: 120 } }),
		{ kind: 'standing_order', id: 'eat', when: 'player.state().fire', ttlS: 120, source: POLICY, maxActions: 16, timeoutMs: 10_000 });
	assert.deepEqual(normalizeMinecraftToolCall('runProgram', { standing: { id: 'eat' } }), { kind: 'standing_order', id: 'eat' });
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { source: POLICY, standing: { id: 'eat' } }), /takes only standing.id/);
	assert.equal(normalizeMinecraftToolCall('runProgram', { source: POLICY, background: true, standing: { id: 'eat', when: 'true' } }).kind, 'standing_order');
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { source: POLICY, standing: { id: 'bad id', when: 'true' } }), /standing.id/);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { source: POLICY, standing: { id: 'eat', when: 'true', ttlS: 1801 } }), /ttlS/);
	const schema = MINECRAFT_DYNAMIC_TOOLS.find((tool) => tool.name === 'runProgram').inputSchema.properties.standing;
	// The schema stays a bare object to keep always-sent bytes flat; the normalizer enforces the shape the description names.
	assert.deepEqual(schema, { type: 'object' });
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { source: POLICY, standing: { when: 'true' } }), /standing.id/);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { source: POLICY, standing: { id: 'eat', when: 'true', every: 5 } }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { source: POLICY, standing: { id: 'eat', when: 'x'.repeat(5000) } }), /standing.when/);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { source: POLICY, standing: 'eat' }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
});

test('survival template is opt-in: danger alone installs nothing and sends no body commands', async () => {
	const { runtime, sent, observe } = harness({ holdActions: new Set(['control']) });
	try {
		const danger = wire({ underWater: false, onFire: true, inLava: true }, {
			world: { dimension: 'minecraft:the_nether', gameTime: 0, dayTime: 0, raining: false, thundering: false },
		});
		observe(danger);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(runtime.hasStandingGuard(record()), false);
		assert.equal(runtime.standingGuardCoverage(record()), null);
		assert.deepEqual(commands(sent), []);
		// A model command remains usable in danger without a guard or a decision gate.
		const result = await runtime.execute(call(normalizeMinecraftToolCall('wait', { durationMs: 1 })), record());
		assert.notEqual(result.error?.code, 'GUARD_DECISION_REQUIRED');
		assert.equal(commands(sent)[0].actionType, 'wait');
		const installed = await runtime.execute(call(normalizeMinecraftToolCall('runProgram', {
			standing: { template: 'survival' }, background: true,
		})), record());
		assert.equal(installed.state, 'STANDING');
		assert.equal(runtime.standingGuardCoverage(record()), 'survival: installed, condition true, fired 1x');
		await until(() => commands(sent).some(row => row.actionType === 'control'), 'explicitly installed lava response');
		assert.equal(commands(sent).at(-1).arguments.jump, true);
		const deleted = await runtime.execute(call(normalizeMinecraftToolCall('runProgram', { standing: { id: 'survival' }, background: true })), record());
		assert.equal(deleted.state, 'DELETED');
		const count = commands(sent).length;
		observe(danger);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(runtime.standingGuardCoverage(record()), null);
		assert.equal(commands(sent).length, count, 'deletion never causes a replacement guard to install');
	} finally { await runtime.dispose('agent-a', 'agent_removed'); }
});

test('an order whose own danger would pause it is refused with the declaration that fixes it', async () => {
	const { runtime, observe } = harness();
	observe(wire());
	await assert.rejects(runtime.execute(call({ kind: 'standing_order', id: 'eat', when: 'player.state().fire', ttlS: 60,
		source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1);' }), record()), { code: 'STANDING_ORDER_WOULD_PAUSE' });
	await runtime.dispose('agent-a', 'test_complete');
});

test('the order book fires on a rising edge, debounces flicker, expires and bounds its size', () => {
	let now = 0;
	const book = new StandingOrderBook({ now: () => now });
	book.set('a', { id: 'drown', when: 'player.state().air < 100', source: POLICY, ttlS: 60 });
	assert.equal(book.evaluate('a', wire({ air: 300 })), null);
	assert.equal(book.evaluate('a', wire({ air: 90 }))?.id, 'drown');
	book.markFired('a', 'drown');
	assert.equal(book.evaluate('a', wire({ air: 60 })), null, 'a held condition is not a new edge');
	assert.equal(book.evaluate('a', wire({ air: 300 })), null);
	now = 500;
	assert.equal(book.evaluate('a', wire({ air: 80 })), null, 'a flicker inside the refire window waits');
	now = STANDING_REFIRE_MS;
	assert.equal(book.evaluate('a', wire({ air: 70 }))?.id, 'drown', 'a due edge fires once the refire window passes while it still holds');
	for (let index = 1; index < MAX_STANDING_ORDERS; index += 1) book.set('a', { id: `o${index}`, when: 'false', source: POLICY });
	assert.throws(() => book.set('a', { id: 'extra', when: 'true', source: POLICY }), { code: 'STANDING_ORDER_LIMIT' });
	assert.throws(() => book.set('a', { id: 'o1', when: 'player.state(', source: POLICY }), { code: 'INVALID_PROGRAM_PRECONDITION' });
	now = 60_000;
	assert.deepEqual(book.list('a').map(({ id }) => id), ['o1', 'o2', 'o3'], 'the 60 s order expired');
});

test('a condition reading world facts still sees them while player-only conditions skip copying the world', () => {
	const book = new StandingOrderBook();
	book.set('a', { id: 'lava', when: 'world.blocks({ blockId: "minecraft:lava" }).length > 0', source: POLICY });
	const lava = wire({}, { blocks: [{ x: 1, y: 63, z: 0, blockId: 'minecraft:lava' }] });
	assert.equal(book.evaluate('a', adaptObservation(wire())), null);
	assert.equal(book.evaluate('a', adaptObservation(lava))?.id, 'lava');
	assert.equal(book.list('a')[0].conditionError, undefined);
});

test('a condition naming a fact this sample lacks never fires and is reported on the order', () => {
	const book = new StandingOrderBook();
	book.set('a', { id: 'rate', when: 'player.state().harm.hpLossPerSecond > 2', source: POLICY });
	assert.equal(book.evaluate('a', wire({ health: 5 })), null);
	assert.equal(book.list('a')[0].conditionError, 'UNKNOWN_MEMBER');
});

// Burning B deaths: 7-10 HP, about 1 HP/s, 5-7 s per model turn spent on wait/move_to. The order eats at once and
// cancels the model's own wait; the firing, its cause and what it preempted come back as a program result.
test('burning: an eat order preempts the model wait the moment health crosses its threshold', async () => {
	const { runtime, sent, events, observe } = harness({ holdActions: new Set(['wait']) });
	observe(wire({ onFire: true, health: 12 }));
	const installed = await runtime.execute(call({ kind: 'standing_order', id: 'eat', when: 'player.state().fire && player.state().health < 10', ttlS: 300,
		source: `${POLICY} await player.selectItem({ itemId: "minecraft:cooked_beef" }); await player.useItem({ durationMs: 1600 });`, maxActions: 4, timeoutMs: 5000 }), record());
	assert.equal(installed.state, 'STANDING');
	assert.deepEqual(installed.standingOrders.map(({ id }) => id), ['eat']);
	const waiting = runtime.execute(call({ kind: 'action', actionType: 'wait', arguments: { durationMs: 6000 } }, 'call-wait'), record());
	await until(() => commands(sent).length === 1, 'the model wait');
	observe(wire({ onFire: true, health: 11 }));
	assert.equal(sent.filter(({ type }) => type === 'action_cancel').length, 0, 'above the threshold nothing fires');
	const crossedAt = performance.now();
	observe(wire({ onFire: true, health: 9 }));
	const waitResult = await waiting;
	assert.equal(waitResult.state, 'CANCELLED');
	assert.equal(waitResult.cancelledBy, 'standing:eat');
	await until(() => events.some(({ event }) => event === 'program_ended'), 'the order result');
	const latencyMs = performance.now() - crossedAt;
	assert.deepEqual(commands(sent).slice(1).map(({ actionType }) => actionType), ['select_item', 'use_item']);
	const ended = events.find(({ event }) => event === 'program_ended').result;
	assert.equal(ended.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.equal(ended.standingOrder.id, 'eat');
	assert.deepEqual(ended.standingOrder.cause, { health: 9, hunger: 20, fallDistance: 0, fire: true });
	assert.equal(ended.standingOrder.preempted[0].actionType, 'wait');
	assert.ok(latencyMs < 1000, `the reflex started within one sample, not a model round (${latencyMs.toFixed(0)} ms)`);
	await runtime.dispose('agent-a', 'test_complete');
});

// Live run: urgent fire attention arrived while the order ate; the order then held the body to its deadline waiting for
// a model answer. Its authored continue_and_notify is now applied, and it ends as soon as its last action does.
test('danger arriving during an order does not hold the body after the reflex ends', async () => {
	const { runtime, sent, events, observe, settle } = harness({ holdActions: new Set(['use_item']) });
	observe(wire({ onFire: true, health: 12 }));
	await runtime.execute(call({ kind: 'standing_order', id: 'eat', when: 'player.state().fire && player.state().health < 10', ttlS: 300, timeoutMs: 8000,
		source: `${POLICY} await player.selectItem({ itemId: "minecraft:cooked_beef" }); await player.useItem({ durationMs: 1600 });` }), record());
	observe(wire({ onFire: true, health: 9 }));
	await until(() => commands(sent).some(({ actionType }) => actionType === 'use_item'), 'the eat action');
	observe(wire({ onFire: true, health: 8 }), { attention: true, priority: 'urgent', trigger: 'fire' });
	observe(wire({ onFire: true, health: 7 }), { attention: true, priority: 'urgent', trigger: 'damage' });
	await new Promise((resolve) => setTimeout(resolve, 20));
	settle(commands(sent).find(({ actionType }) => actionType === 'use_item').actionId);
	await until(() => events.some(({ event }) => event === 'program_ended'), 'the order end');
	const ended = events.find(({ event }) => event === 'program_ended').result;
	assert.equal(ended.reasonCode, 'PROGRAM_EXHAUSTED');
	assert.ok(ended.standingOrder.continuedAttention >= 1);
	assert.equal(events.some(({ event }) => event === 'program_attention'), false, 'the reflex does not wake the model mid-way');
	await runtime.dispose('agent-a', 'test_complete');
});

// A11 live runs: at low health every urgent sample failed the fresh-facts gate meant for model answers, so the
// order's own continue_and_notify was rejected as STALE_PROGRAM_DECISION and woke the model (C1 35x, D1 38x).
for (const guard of [false, true]) test(`an order continues past urgent attention at low health without waking the model, guard=${guard}`, async () => {
	const { runtime, sent, events, traces, observe, settle } = harness({ holdActions: new Set(['use_item']) });
	observe(wire({ onFire: true, health: 12 }));
	await runtime.execute(call({ kind: 'standing_order', id: 'eat', when: 'player.state().fire && player.state().health < 10', ...(guard ? { guard: true } : { ttlS: 300 }), timeoutMs: 8000,
		source: `${POLICY} await player.selectItem({ itemId: "minecraft:cooked_beef" }); await player.useItem({ durationMs: 1600 });` }), record());
	observe(wire({ onFire: true, health: 9 }));
	await until(() => commands(sent).some(({ actionType }) => actionType === 'use_item'), 'the eat action');
	observe(wire({ onFire: true, health: 5 }), { attention: true, priority: 'urgent', trigger: 'fire' });
	observe(wire({ onFire: true, health: 4 }), { attention: true, priority: 'urgent', trigger: 'damage' });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(traces.filter(({ event }) => event === 'standing_order_continue_failed').length, 0);
	assert.equal(events.some(({ event }) => event === 'program_attention'), false);
	settle(commands(sent).find(({ actionType }) => actionType === 'use_item').actionId);
	await until(() => !runtime.hasProgram(record()), 'the handler end');
	if (guard) observe(wire({ onFire: false, health: 20 }));
	await until(() => events.some(({ event }) => event === 'program_ended'), 'the order end');
	assert.ok(events.find(({ event }) => event === 'program_ended').result.standingOrder.continuedAttention >= 1);
	await runtime.dispose('agent-a', 'test_complete');
});

test('drowning: a swim-up order fires on the air edge with an idle body, once per dive', async () => {
	const { runtime, sent, events, observe } = harness();
	observe(wire({ air: 300, underWater: true }));
	await runtime.execute(call({ kind: 'standing_order', id: 'surface', when: 'player.state().air < 150', ttlS: 600,
		source: `${POLICY} await player.control({ forward: 0, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false, yaw: 0, pitch: -60, selectedSlot: 0, hand: "main", ticks: 40 });` }), record());
	// Air reads as HUD bubbles (30 per bubble): raw 110 shows 4 bubbles, 120.
	observe(wire({ air: 110, underWater: true }));
	await until(() => events.some(({ event }) => event === 'program_ended'), 'the surface order');
	assert.equal(commands(sent)[0].actionType, 'control');
	assert.equal(commands(sent)[0].arguments.jump, true);
	observe(wire({ air: 100, underWater: true }));
	observe(wire({ air: 40, underWater: true }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(commands(sent).length, 1, 'the same dive does not refire');
	await runtime.dispose('agent-a', 'test_complete');
});

// A program the model is running keeps the body (its own watchers answer first); once it pauses for the model's
// decision, the order takes over at once instead of waiting a model round.
test('mob swarm: an order defers to a running program and preempts it once danger pauses it', async () => {
	const { runtime, sent, events, observe } = harness({ holdActions: new Set(['wait']) });
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'swarm', when: 'player.state().threats.length >= 3', ttlS: 600,
		source: `${POLICY} await player.blockWithShield({ durationMs: 750 });` }), record());
	const started = await runtime.execute(call({ kind: 'run_program', source: 'program.onUnhandledAttention("pause_and_notify"); await player.wait(60000);', background: true, maxActions: 4, timeoutMs: 60_000 }, 'call-program'), record());
	await until(() => commands(sent).length === 1, 'the routine wait');
	const swarm = wire({ health: 16 }, { threats: { entries: [threat(1), threat(2), threat(3)] } });
	observe(swarm);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sent.filter(({ type }) => type === 'action_cancel').length, 0, 'an active program is not preempted');
	observe(swarm, { attention: true, priority: 'urgent', trigger: 'threat' });
	await until(() => commands(sent).some(({ actionType }) => actionType === 'block_with_shield'), 'the shield order');
	await until(() => events.some(({ event, result }) => event === 'program_ended' && result?.standingOrder !== undefined), 'the order result');
	const order = events.find(({ result }) => result?.standingOrder !== undefined).result.standingOrder;
	assert.deepEqual(order.preempted, [{ programId: started.programId }]);
	assert.equal(order.cause.threats, 3);
	await runtime.dispose('agent-a', 'test_complete');
});

test('falling: a bucket order fires mid-air and a seen drop ahead fires an order without waking the model', async () => {
	const { runtime, sent, events, observe } = harness();
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'mlg', when: 'player.state().fallDistance > 5 && inventory.count("minecraft:water_bucket") > 0', ttlS: 600,
		source: `${POLICY} await player.selectItem({ itemId: "minecraft:water_bucket" }); await player.useItem({ durationMs: 50, mode: "once" });` }), record());
	await runtime.execute(call({ kind: 'standing_order', id: 'edge', when: 'player.state().dropAhead !== null && player.state().dropAhead.drop >= 6', ttlS: 600,
		source: `${POLICY} await player.control({ forward: -1, strafe: 0, jump: false, sneak: true, sprint: false, attack: false, use: false, yaw: 0, pitch: 0, selectedSlot: 0, hand: "main", ticks: 10 });` }, 'call-2'), record());
	observe(wire({ onGround: false, fallDistance: 6.5 }));
	await until(() => events.filter(({ event }) => event === 'program_ended').length === 1, 'the bucket order');
	assert.deepEqual(commands(sent).map(({ actionType }) => actionType), ['select_item', 'use_item']);
	observe(wire({ dropAhead: { drop: 9, at: 2 } }));
	await until(() => events.filter(({ event }) => event === 'program_ended').length === 2, 'the edge order');
	assert.equal(commands(sent).at(-1).arguments.sneak, true);
	assert.deepEqual(events.at(-1).result.standingOrder.cause.dropAhead, { drop: 9, at: 2 });
	// Review r1 finding 6: the edge is about a second away, faster than any model round; it serves orders, not wakes.
	// The server publishes it alone as a sampleOnly sample (see MultiplexedServerBridgeVerification).
	const raised = classifyObservationTrigger({ attention: false, changedFacts: [], sampleOnly: true }, wire({ dropAhead: { drop: 9, at: 2 } }));
	assert.equal(raised.attention, false);
	assert.equal(raised.sampleOnly, true);
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['player.dropAhead', 'player.health'] }, wire({ health: 15 })).trigger, 'damage',
		'other facts in the same sample still wake as before');
	await runtime.dispose('agent-a', 'test_complete');
});

test('starvation: an order whose condition already holds fires on install; deleting it stops further firings', async () => {
	const { runtime, sent, events, observe } = harness();
	observe(wire({ foodLevel: 4, health: 14 }));
	await runtime.execute(call({ kind: 'standing_order', id: 'hungry', when: 'player.state().hunger <= 6', ttlS: 900,
		source: `${POLICY} await player.selectItem({ itemId: "minecraft:cooked_beef" }); await player.useItem({ durationMs: 1600 });` }), record());
	await until(() => events.some(({ event }) => event === 'program_ended'), 'the eat order');
	assert.equal(events[0].result.standingOrder.cause.hunger, 4);
	const deleted = await runtime.execute(call({ kind: 'standing_order', id: 'hungry' }, 'call-delete'), record());
	assert.deepEqual(deleted, { state: 'DELETED', id: 'hungry', standingOrders: [] });
	observe(wire({ foodLevel: 20 }));
	observe(wire({ foodLevel: 3 }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(commands(sent).length, 2);
	await runtime.dispose('agent-a', 'test_complete');
});

test('orders survive death and respawn but no dead or not-ready sample fires them', async () => {
	const { runtime, sent, observe } = harness();
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'low', when: 'player.state().health < 6', source: `${POLICY} await player.wait(1);` }), record());
	observe({ ready: false, status: 'PLAYER_DEAD', player: { health: 0, dead: true } });
	await runtime.dispose('agent-a', 'goal_dead');
	observe(wire({ health: 20 }));
	observe(wire({ health: 4 }));
	await until(() => commands(sent).length === 1, 'the order after respawn');
	await runtime.dispose('agent-a', 'agent_removed');
	observe(wire({ health: 20 }));
	observe(wire({ health: 3 }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(commands(sent).length, 1, 'removing the agent forgets its orders');
});

test('a firing cause reports player-visible facts only, from wire and stored (adapted) samples alike', () => {
	const sample = wire({ health: 7.25, onFire: true, harm: { hpLossPerSecond: 1.5 } }, { threats: { entries: [threat(1)] } });
	assert.deepEqual(standingOrderCause(sample), { health: 8, hunger: 20, fallDistance: 0, fire: true, hpLossPerSecond: 1.5, threats: 1 });
	assert.deepEqual(standingOrderCause(adaptObservation(sample)), { health: 8, hunger: 20, fallDistance: 0, fire: true, hpLossPerSecond: 1.5, threats: 1 });
});

// Review r1 finding 1: only attention the order's own source continues is acknowledged; the rest reaches the model.
test('an order paused by its authored ordinary policy, or by an action failure, delivers the decision to the model', async () => {
	const { runtime, sent, events, observe } = harness({ holdActions: new Set(['wait']) });
	observe(wire({ onFire: true, health: 12 }));
	await runtime.execute(call({ kind: 'standing_order', id: 'eat', when: 'player.state().fire && player.state().health < 10', ttlS: 300, timeoutMs: 8000,
		source: 'program.onUnhandledAttention("pause_and_notify", { survival: "continue_and_notify" }); await player.wait(5000); await player.selectItem({ itemId: "minecraft:cooked_beef" });' }), record());
	observe(wire({ onFire: true, health: 9 }));
	await until(() => commands(sent).some(({ actionType }) => actionType === 'wait'), 'the order wait');
	observe(wire({ onFire: true, health: 9 }, { items: [{ uuid: '00000000-0000-4000-8000-0000000000aa', itemId: 'minecraft:stick', count: 1, x: 1, y: 64, z: 1 }] }), { attention: true, priority: 'ordinary', trigger: 'attention' });
	await until(() => events.some(({ event }) => event === 'program_attention'), 'the ordinary decision');
	const status = await runtime.execute(call({ kind: 'program_status' }, 'call-status'), record());
	assert.equal(status.engineState, 'SUSPENDED', 'the authored pause holds');
	assert.equal(commands(sent).some(({ actionType }) => actionType === 'select_item'), false, 'nothing continued without the model');
	assert.equal(status.standingOrder.id, 'eat');
	await runtime.dispose('agent-a', 'test_complete');
});

test('an order action failure is delivered to the model, never answered by the runtime', async () => {
	// As reproduced in review: repeated failed selections raise action_failure, which the runtime must not answer.
	const { runtime, sent, events, observe } = harness({ failActions: new Set(['select_item']) });
	observe(wire({ onFire: true, health: 12 }));
	await runtime.execute(call({ kind: 'standing_order', id: 'eat', when: 'player.state().fire && player.state().health < 10', ttlS: 300, timeoutMs: 8000, maxActions: 16,
		source: `${POLICY} await program.repeatUntil(() => false, { maxIterations: 8 }, async () => { await tryResult(player.selectItem({ itemId: "minecraft:cooked_beef" })); }); await player.useItem({ durationMs: 1600 });` }), record());
	observe(wire({ onFire: true, health: 9 }));
	await until(() => events.some(({ event, status }) => event === 'program_attention' || event === 'program_ended'), 'the failure decision');
	assert.equal(events.find(({ event }) => event === 'program_attention')?.status.decision.trigger, 'action_failure', JSON.stringify(events.map(({ event, result }) => [event, result?.reasonCode])));
	assert.equal(commands(sent).some(({ actionType }) => actionType === 'use_item'), false);
	await runtime.dispose('agent-a', 'test_complete');
});

// Review r1 finding 4: a new body starts each condition afresh, keeping source and remaining time.
test('an order true before death fires again on the first live respawn sample', async () => {
	let now = 1_000_000;
	const book = new StandingOrderBook({ now: () => now });
	const { runtime, sent, events, observe } = harness({ book });
	observe(wire({ onFire: true, health: 12 }));
	await runtime.execute(call({ kind: 'standing_order', id: 'low', when: 'player.state().health < 10', ttlS: 300, source: `${POLICY} await player.wait(1);` }), record());
	observe(wire({ health: 8 }));
	await until(() => events.filter(({ event }) => event === 'program_ended').length === 1, 'the first firing');
	observe({ ready: false, status: 'PLAYER_DEAD', player: { health: 0, dead: true } });
	await runtime.dispose('agent-a', 'goal_respawn');
	now += 500; // still inside the refire window of the old body
	observe(wire({ health: 6 }));
	await until(() => commands(sent).length === 2, 'a firing in the new body');
	assert.equal(book.list('agent-a')[0].expiresInS, 300, 'remaining time is kept');
	await runtime.dispose('agent-a', 'test_complete');
});

// Review r1 finding 2: the firing report reaches the model through the real presenters.
test('the firing report survives the wake presenter and tool-result compaction; cancelledBy survives compact action results', () => {
	const standingOrder = { id: 'eat', when: 'player.state().fire && player.state().health < 10', firedAtMs: 1_791_635_751_854,
		cause: { health: 9, hunger: 12, air: 300, fallDistance: 0, fire: true }, preempted: [{ actionId: 'native:a:1', actionType: 'wait' }], continuedAttention: 1 };
	const result = { state: 'YIELDED', reasonCode: 'PROGRAM_EXHAUSTED', programId: 'p1', goalRevision: 3, actions: 2, actionsSucceeded: 2, actionsFailed: 0, programVersion: 1, standingOrder,
		receipts: Array.from({ length: 200 }, (_, index) => ({ actionId: `p1:${index}`, bodyActionId: `native:x:${index}`, actionType: 'wait', sourceStepId: `step-${index}`, state: 'SUCCEEDED', reasonCode: `ACTION_COMPLETED_${index}`, executionStarted: true, physicalAttempted: true, detail: randomBytes(64).toString('hex') })) };
	const wake = buildNativeEventInput({ agentId: 'agent-a', goalRevision: 3, currentGoal: 'beat the game' }, { event: 'program_ended', trigger: 'program_ended', programId: 'p1', result, observation: wire({ health: 9 }) });
	const presented = JSON.parse(wake.slice(wake.indexOf('\n') + 1));
	assert.equal(presented.program.result.standingOrder.id, 'eat');
	assert.deepEqual(presented.program.result.standingOrder.cause, standingOrder.cause);
	const status = buildNativeEventInput({ agentId: 'agent-a', goalRevision: 3, currentGoal: 'beat the game' }, { event: 'program_attention', trigger: 'damage', programId: 'p1',
		status: { state: 'RUNNING', engineState: 'SUSPENDED', programVersion: 1, decision: { decisionId: 'p1:decision-1', trigger: 'damage', priority: 'urgent' }, standingOrder }, observation: wire({ health: 9 }) });
	assert.equal(JSON.parse(status.slice(status.indexOf('\n') + 1)).program.standingOrder.id, 'eat');
	assert.ok(JSON.stringify(result).length > 28_000);
	const view = (text) => { const parsed = JSON.parse(text); return parsed.data ?? parsed; };
	const compactedText = presentNativeToolResult(result, { kind: 'program_status' }).response.contentItems[0].text;
	assert.ok(compactedText.length < 28_000, 'the program result was compacted');
	const compacted = view(compactedText);
	assert.equal(compacted.standingOrder.id, 'eat');
	assert.equal(compacted.standingOrder.preempted[0].actionType, 'wait');
	const action = { state: 'CANCELLED', reasonCode: 'ACTION_CANCELLED', actionId: 'native:a:1', cancelledBy: 'standing:eat',
		actionObservation: { blocks: Array.from({ length: 400 }, (_, index) => ({ x: index, y: 64, z: 0, blockId: `minecraft:b${randomBytes(24).toString('hex')}` })) } };
	const actionText = presentNativeToolResult(action, { kind: 'action', actionType: 'wait' }).response.contentItems[0].text;
	assert.equal(view(actionText).cancelledBy, 'standing:eat');
});

test('ArenaScript reads dropAhead as null when the observation omits it', () => {
	assert.equal(createInterpreterFacts({ player: { health: 20 } }).player.dropAhead, null);
	assert.equal(createInterpreterFacts({ player: { health: 20, dropAhead: { drop: 9, at: 2 } } }).player.dropAhead.drop, 9);
});

// Review r3 finding 4: the stated ceiling holds for any text, counting UTF-8 multi-byte characters and JSON escapes.
test('a firing report stays within its byte ceiling whatever its text fields hold, without splitting a character', () => {
	const int = Number.MAX_SAFE_INTEGER;
	for (const big of [-Number.MAX_VALUE, -0.0000012345678901234567]) {
		for (const character of ['a', '€', '\u0000', '\u{1F600}', ' ', '"']) {
			const fill = (count) => character.repeat(count);
			const report = compactStandingOrder({ id: fill(500), when: fill(5000), firedAtMs: -int, continuedAttention: -int,
				cause: { health: big, hunger: big, air: big, airBubbles: big, fallDistance: big, hpLossPerSecond: big, threats: big, fire: true, inLava: true, dropAhead: { drop: big, at: big, atLeast: true, into: fill(500) } },
				preempted: [0, 1, 2].map(() => ({ actionId: fill(900), actionType: fill(900), programId: fill(900) })) });
			const serialized = JSON.stringify(report);
			assert.ok(Buffer.byteLength(serialized, 'utf8') <= MAX_STANDING_REPORT_BYTES, `${JSON.stringify(character)}: ${Buffer.byteLength(serialized, 'utf8')} B`);
			const excerpt = report.when ?? report.whenExcerpt;
			assert.ok(excerpt.length > 0 && [...excerpt].every((part) => part === character), 'whole characters only');
			if (report.whenExcerpt !== undefined) assert.equal(report.guardsOmitted, true);
		}
	}
	const typical = compactStandingOrder({ id: 'eat-when-burning', when: 'player.state().fire && player.state().health < 10', firedAtMs: 1_760_000_000_000,
		cause: { health: 9.5, hunger: 12, air: 300, fallDistance: 0, fire: true, hpLossPerSecond: 1 }, preempted: [{ actionId: 'native:7e0430fb-c767-4a71-8dec-46f7caf7d334:2:agent-a:1', actionType: 'wait' }], continuedAttention: 1 });
	assert.ok(Buffer.byteLength(JSON.stringify(typical)) < 400, 'a typical firing is about 350 bytes');
});

// R4: exercise the encoded wake and compact tool response, not just the helper.
function presentedOrderReports(standingOrder, observation = wire()) {
	const result = { state: 'YIELDED', reasonCode: 'PROGRAM_EXHAUSTED', programId: 'p1', goalRevision: 3, standingOrder,
		receipts: Array.from({ length: 200 }, (_, i) => ({ actionId: `x${i}`, actionType: 'wait', state: 'SUCCEEDED', detail: randomBytes(256).toString('hex') })) };
	const wake = buildNativeEventInput(record(), { event: 'program_ended', trigger: 'program_ended', programId: 'p1', result, observation });
	const encoded = encodeNativeEventInput(wake);
	const event = decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n') + 1)));
	const tool = JSON.parse(presentNativeToolResult(result, { kind: 'program_status' }).response.contentItems[0].text);
	return [event.program.result.standingOrder, (tool.data ?? tool).standingOrder];
}

test('firing reports use HUD health and air bubbles in encoded wakes and compact tool responses', () => {
	const sample = wire({ health: 17.25, air: 58, maxAir: 300, underWater: true });
	const facts = createInterpreterFacts(adaptObservation(sample));
	assert.equal(facts.player.health, 18);
	assert.equal(facts.player.airBubbles, 2);
	for (const input of [sample, adaptObservation(sample)]) {
		const order = { id: 'breath', when: 'player.state().air < 150', cause: standingOrderCause(input) };
		for (const report of presentedOrderReports(order, sample)) {
			assert.equal(report.cause.health, facts.player.health);
			assert.equal(report.cause.airBubbles, facts.player.airBubbles);
			assert.equal(report.cause.air, undefined, 'no internal air counter');
		}
	}
});

test('firing reports retain accepted safety guards and trim preemption text before conditions', () => {
	const first = 'player.state().dropAhead !== null && player.state().dropAhead.drop >= 6 && !player.state().dropAhead.atLeast && player.state().onGround && player.state().health > 0 && player.state().air >= 150 && inventory.count("minecraft:water_bucket") > 0';
	const guards = ' && player.state().dropAhead.into !== "water" && player.state().health < 10';
	for (const when of [first.padEnd(256) + guards, first.padEnd(850) + guards]) {
		const normalized = normalizeMinecraftToolCall('runProgram', { standing: { id: 'edge', when, ttlS: 300 }, source: POLICY });
		const book = new StandingOrderBook(); book.set('a', normalized);
		assert.equal(book.list('a')[0].when, when);
		const full = { id: 'edge', when, cause: { health: 9, airBubbles: 10, dropAhead: { drop: 9, at: 1, into: 'lava' } },
			preempted: [0, 1].map(() => ({ actionId: 'a'.repeat(128), programId: 'p'.repeat(128), actionType: 'w'.repeat(64) })) };
		for (const report of [compactStandingOrder(full), ...presentedOrderReports(full)]) {
			assert.equal(report.when, when);
			assert.equal(report.guardsOmitted, undefined);
			assert.ok(Buffer.byteLength(JSON.stringify(report)) <= MAX_STANDING_REPORT_BYTES);
		}
	}
});

test('an oversized escaped condition explicitly reports omitted guards through both presenters and recompaction', () => {
	const when = 'true /*' + '"'.repeat(900) + '*/ && player.state().health < 10';
	const normalized = normalizeMinecraftToolCall('runProgram', { standing: { id: 'guarded', when, ttlS: 300 }, source: POLICY });
	const book = new StandingOrderBook(); book.set('a', normalized);
	assert.equal(book.list('a')[0].when, when);
	const full = { id: 'guarded', when, cause: { health: 9 }, preempted: [{ actionId: 'a'.repeat(128), actionType: 'wait' }] };
	const compact = compactStandingOrder(full);
	for (const report of [compact, compactStandingOrder(compact), ...presentedOrderReports(full)]) {
		assert.equal(report.when, undefined, 'never label a partial authorization as the full condition');
		assert.equal(report.guardsOmitted, true);
		assert.ok(report.whenExcerpt.length > 0);
		assert.ok(when.startsWith(report.whenExcerpt));
		assert.ok(Buffer.byteLength(JSON.stringify(report)) <= MAX_STANDING_REPORT_BYTES);
	}
});

test('a firing admitted by a body that respawns while preemption is awaited never runs in the replacement body', async () => {
	for (const replacementBurning of [false, true]) {
		const sent = [];
		let sequence = 1;
		let current = wire({ onFire: true, health: 12 });
		let runtime;
		runtime = new NativeToolRuntime({ bridge: { send: async (type, _agentId, payload) => {
			sent.push({ type, payload });
			if (type === 'action_command' && payload.actionType === 'select_item') queueMicrotask(() => runtime.onActionResult(record(), { actionId: payload.actionId, state: 'SUCCEEDED', reasonCode: '', executionStarted: true }));
		} }, requestObservation: async () => ({ eventSequence: ++sequence, observation: adaptObservation(current) }) });
		const observe = (observation) => { current = observation; runtime.updateObservation(record(), adaptObservation(observation), { eventSequence: ++sequence }); };
		observe(current);
		await runtime.execute(call({ kind: 'standing_order', id: 'eat', when: 'player.state().fire && player.state().health < 10', ttlS: 300,
			source: `${POLICY} await player.selectItem({ itemId: "minecraft:cooked_beef" });` }), record());
		await runtime.execute(call({ kind: 'start_action', actionType: 'wait', arguments: { durationMs: 6000 } }, 'wait'), record());
		observe(wire({ onFire: true, health: 9 }));
		assert.equal(sent.filter(({ type }) => type === 'action_cancel').length, 1, 'the order waits for the model action to cancel');
		const disposal = runtime.dispose('agent-a', 'goal_respawn');
		observe(replacementBurning ? wire({ onFire: true, health: 8 }) : wire({ health: 20 }));
		await disposal;
		for (let index = 0; index < 30; index += 1) await new Promise((resolve) => setImmediate(resolve));
		const fired = commands(sent).filter(({ actionType }) => actionType === 'select_item').length;
		assert.equal(fired, replacementBurning ? 1 : 0, replacementBurning ? 'the preserved order fires once for the burning replacement' : 'a healthy replacement body is not fed by the old firing');
		await runtime.dispose('agent-a', 'test_complete');
	}
});

test('standing guards normalize without TTL and remain level-triggered until explicitly cleared', () => {
	const tool = normalizeMinecraftToolCall('runProgram', { standing: { id: 'defend', when: 'player.state().health < 10', guard: true }, source: POLICY });
	assert.equal(tool.guard, true);
	assert.equal(tool.ttlS, undefined);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { standing: { id: 'defend', when: 'true', guard: true, ttlS: 10 }, source: POLICY }), /omit ttlS/);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { standing: { id: 'defend', when: 'true', guard: 'yes' }, source: POLICY }), /boolean/);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { standing: { id: 'defend', guard: true } }), /only standing.id/);
	let now = 0;
	const book = new StandingOrderBook({ now: () => now });
	book.set('a', tool);
	const low = wire({ health: 8 });
	assert.equal(book.evaluate('a', low)?.id, 'defend');
	book.markFired('a', 'defend');
	now = 100;
	assert.equal(book.evaluate('a', low), null, 'rapid no-op handlers are bounded');
	now = 250;
	assert.equal(book.evaluate('a', low)?.id, 'defend', 'the same held danger fires without a false edge');
	book.markFired('a', 'defend');
	now = 86_400_000;
	assert.equal(book.evaluate('a', low)?.id, 'defend', 'no implicit expiry');
	assert.deepEqual(book.list('a')[0], { id: 'defend', when: tool.when, guard: true, fired: 2, activations: 2 });
	book.delete('a', 'defend');
	assert.equal(book.evaluate('a', low), null);
});

test('a standing guard interrupts a running routine and yields to an explicit model defense', async () => {
	const { runtime, observe, sent, events } = harness({ holdActions: new Set(['wait', 'fight_target', 'flee_from']) });
	observe(wire());
	const id = threat(1).uuid;
	await runtime.execute(call({ kind: 'standing_order', id: 'defend', guard: true, when: 'player.state().threat !== null',
		source: `${POLICY} await player.fightTarget({ targetId: player.state().threat.uuid, timeoutMs: 5000 });` }), record());
	const routine = await runtime.execute(call({ kind: 'run_program', background: true, source: `${POLICY} await player.wait(5000); await player.selectItem({ itemId: "minecraft:cooked_beef" });`, timeoutMs: 10000 }, 'routine'), record());
	await until(() => commands(sent).some(({ actionType }) => actionType === 'wait'), 'the routine body');
	observe(wire({}, { threats: { entries: [threat(1)] } }));
	await until(() => commands(sent).some(({ actionType }) => actionType === 'fight_target'), 'the guard preemption');
	assert.equal(events.find(({ event }) => event === 'program_guard_activated').status.standingOrder.preempted[0].programId, routine.programId);
	assert.equal(commands(sent).some(({ actionType }) => actionType === 'select_item'), false, 'abandoned work stays abandoned');
	const firstFight = commands(sent).find(({ actionType }) => actionType === 'fight_target');
	const defense = await runtime.execute(call({ kind: 'start_action', actionType: 'flee_from', arguments: { targetId: id, distance: 12, timeoutMs: 5000 } }, 'manual-defense'), record());
	assert.equal(defense.state, 'RUNNING');
	assert.ok(sent.some(({ type, payload }) => type === 'action_cancel' && payload.actionId === firstFight.actionId));
	observe(wire({ health: 6 }, { threats: { entries: [threat(1)] } }));
	assert.equal(commands(sent).filter(({ actionType }) => actionType === 'fight_target').length, 1, 'explicit model defense owns the body until terminal');
	const cleared = await runtime.execute(call({ kind: 'standing_order', id: 'defend' }, 'clear'), record());
	assert.equal(cleared.state, 'DELETED');
	await runtime.dispose('agent-a', 'test_complete');
});

test('standing guards execute authored blocked-flee and unreachable-fight fallbacks without a model decision', async () => {
	const { runtime, observe, sent, events, traces } = harness({ failActions: new Map([['flee_from', 'FLEE_BLOCKED'], ['fight_target', 'TARGET_UNREACHABLE']]) });
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'defend', guard: true, when: 'player.state().threat !== null', source: `${POLICY}
		const id = player.state().threat.uuid;
		const flee = await tryResult(player.fleeFrom({ targetId: id, distance: 12, timeoutMs: 3000 }));
		if (flee.reasonCode === "FLEE_BLOCKED") {
			const fight = await tryResult(player.fightTarget({ targetId: id, timeoutMs: 3000 }));
			if (fight.reasonCode === "TARGET_UNREACHABLE") { await player.blockWithShield({ durationMs: 500 }); }
		}` }), record());
	observe(wire({}, { threats: { entries: [threat(1)] } }));
	await until(() => traces.some(({ event }) => event === 'native_program_ended'), 'all authored fallbacks');
	observe(wire());
	await until(() => events.some(({ event }) => event === 'program_ended'), 'episode outcome');
	assert.deepEqual(commands(sent).map(({ actionType }) => actionType), ['flee_from', 'fight_target', 'block_with_shield']);
	const result = events.find(({ event }) => event === 'program_ended').result;
	assert.equal(result.standingOrder.id, 'defend');
	assert.equal(result.actionsFailed, 2);
	assert.equal(events.some(({ event }) => event === 'program_attention'), false);
	await runtime.dispose('agent-a', 'test_complete');
});

test('clearing or replacing an executing guard cancels its old source before it can issue another action', async () => {
	for (const replace of [false, true]) {
		const { runtime, observe, sent, events } = harness({ holdActions: new Set(['fight_target', 'block_with_shield']) });
		observe(wire());
		await runtime.execute(call({ kind: 'standing_order', id: 'defend', guard: true, when: 'player.state().threat !== null', source: `${POLICY} await player.fightTarget({ targetId: player.state().threat.uuid, timeoutMs: 5000 }); await player.wait(1);` }), record());
		observe(wire({}, { threats: { entries: [threat(1)] } }));
		await until(() => commands(sent).length === 1, 'old guard');
		await runtime.execute(call({ kind: 'standing_order', id: 'defend', ...(replace ? { guard: true, when: 'player.state().threat !== null', source: `${POLICY} await player.blockWithShield({ durationMs: 500 });` } : {}) }, 'edit-guard'), record());
		await until(() => events.some(({ event }) => event === 'program_ended'), 'cancelled response report');
		if (replace) await until(() => commands(sent).some(({ actionType }) => actionType === 'block_with_shield'), 'replacement guard');
		assert.equal(commands(sent).some(({ actionType }) => actionType === 'wait'), false);
		assert.equal(events.find(({ event }) => event === 'program_ended').result.state, 'CANCELLED');
		assert.equal(sent.filter(({ type }) => type === 'action_cancel').length, 1);
		await runtime.dispose('agent-a', 'test_complete');
	}
});

test('a guard refires on unchanged heartbeats and survives respawn with the new unarmed body facts', async () => {
	let now = 1000;
	const { runtime, observe, sent, events, traces } = harness({ book: new StandingOrderBook({ now: () => now }) });
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'low', guard: true, when: 'player.state().health < 10', source: `${POLICY} await player.wait(1);` }), record());
	observe(wire({ health: 8 }));
	await until(() => traces.filter(({ event }) => event === 'native_program_ended').length === 1, 'the first response');
	now += 300;
	assert.equal(runtime.refreshObservation(record(), adaptObservation(wire({ health: 8 })), { eventSequence: 1000 }), true);
	await until(() => traces.filter(({ event }) => event === 'native_program_ended').length === 2, 'response on unchanged heartbeat');
	await runtime.dispose('agent-a', 'goal_respawn');
	observe(wire({ health: 8 }, { inventory: { items: [], selectedItem: 'minecraft:air' } }));
	await until(() => commands(sent).length === 3, 'response in the new unarmed body');
	await runtime.dispose('agent-a', 'agent_removed');
});

test('clearing a guard while routine cancellation is pending prevents the admitted source from starting', async () => {
	const sent = [];
	let runtime;
	runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => { sent.push({ type, payload }); } } });
	runtime.updateObservation(record(), adaptObservation(wire()), { eventSequence: 1 });
	await runtime.execute(call({ kind: 'standing_order', id: 'low', guard: true, when: 'player.state().health < 10', source: `${POLICY} await player.wait(1);` }), record());
	const action = await runtime.execute(call({ kind: 'start_action', actionType: 'wait', arguments: { durationMs: 5000 } }, 'routine'), record());
	runtime.updateObservation(record(), adaptObservation(wire({ health: 8 })), { eventSequence: 2 });
	assert.equal(sent.filter(({ type }) => type === 'action_cancel').length, 1);
	await runtime.execute(call({ kind: 'standing_order', id: 'low' }, 'clear'), record());
	runtime.onActionResult(record(), { actionId: action.actionId, state: 'CANCELLED', reasonCode: 'MODEL_CANCELLED', executionStarted: true });
	for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
	assert.equal(commands(sent).length, 1, 'the deleted guard never dispatches its admitted handler');
	await runtime.dispose('agent-a', 'test_complete');
});


test('the optional defensive example fights healthy nearby melee threats, retreats low or from creepers, and follows authored fallbacks', async () => {
	const reference = JSON.parse(readFileSync(new URL('./fixtures/standing-programs.json', import.meta.url), 'utf8'));
	const example = reference.defense;
	for (const scenario of [
		{ health: 20, type: 'minecraft:zombie', expected: ['fight_target'] },
		{ health: 20, type: 'minecraft:skeleton', expected: ['fight_target'] },
		{ health: 6, type: 'minecraft:zombie', expected: ['flee_from'] },
		{ health: 20, type: 'minecraft:creeper', expected: ['flee_from'] },
		{ health: 6, type: 'minecraft:zombie', fail: ['flee_from', 'FLEE_BLOCKED'], expected: ['flee_from', 'fight_target'] },
		{ health: 6, type: 'minecraft:zombie', fail: ['flee_from', 'TARGET_GONE'], expected: ['flee_from'] },
		{ health: 20, type: 'minecraft:zombie', fail: ['fight_target', 'TARGET_UNREACHABLE'], expected: ['fight_target', 'flee_from'] },
	]) {
		const { runtime, observe, sent, events, traces } = harness({ failActions: new Map(scenario.fail ? [scenario.fail] : []) });
		observe(wire());
		await runtime.execute(call(normalizeMinecraftToolCall(example.tool, example.arguments)), record());
		observe(wire({ health: scenario.health }, { threats: { entries: [{ ...threat(1), type: scenario.type, swelling: scenario.type === 'minecraft:creeper' }] } }));
		await until(() => traces.some(({ event }) => event === 'native_program_ended'), 'the documented defensive response');
		observe(wire());
		await until(() => events.some(({ event }) => event === 'program_ended'), 'the defensive episode end');
		assert.deepEqual(commands(sent).map(({ actionType }) => actionType), scenario.expected);
		await runtime.dispose('agent-a', 'test_complete');
	}
});

test('a guard lets a program-owned defensive primitive finish before taking routine work', async () => {
	const { runtime, observe, sent, events, settle } = harness({ holdActions: new Set(['fight_target', 'wait']) });
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'low', guard: true, when: 'player.state().health < 10', source: `${POLICY} await player.wait(1);` }), record());
	await runtime.execute(call({ kind: 'run_program', background: true, source: `${POLICY} await player.fightTarget({ targetId: "${threat(1).uuid}", timeoutMs: 5000 });` }, 'chosen-defense'), record());
	await until(() => commands(sent).length === 1, 'the chosen program defense');
	observe(wire({ health: 8 }));
	assert.equal(sent.filter(({ type }) => type === 'action_cancel').length, 0, 'the guard preserves the newer authored defense');
	settle(commands(sent)[0].actionId);
	await until(() => events.some(({ event }) => event === 'program_guard_activated'), 'the guard after the defense');
	assert.deepEqual(commands(sent).map(({ actionType }) => actionType), ['fight_target', 'wait']);
	await runtime.dispose('agent-a', 'test_complete');
});


test('persistent threat with quickly failing source backs off and coalesces one episode', async () => {
	let now = 0;
	const book = new StandingOrderBook({ now: () => now });
	const { runtime, observe, events, traces } = harness({ book, failActions: new Map([['flee_from', 'FLEE_BLOCKED']]) });
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'defend', guard: true, when: 'player.state().threat !== null',
		source: `${POLICY} await player.fleeFrom({ targetId: player.state().threat.uuid, distance: 12, timeoutMs: 3000 });` }), record());
	const danger = wire({}, { threats: { entries: [threat(1)] } });
	observe(danger);
	await until(() => traces.filter(({ event }) => event === 'native_program_ended').length === 1, 'first failure');
	for (const [index, delay] of [250, 500, 1000, 2000, 4000, 5000, 5000].entries()) {
		now += delay - 1;
		observe(danger);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(traces.filter(({ event }) => event === 'native_program_ended').length, index + 1, 'no early retry');
		now += 1;
		observe(danger);
		await until(() => traces.filter(({ event }) => event === 'native_program_ended').length === index + 2, 'bounded retry');
	}
	assert.equal(events.length, 1, 'repeated outcomes cost no wake');
	assert.equal(events[0].priority, 'urgent');
	assert.equal(events[0].status.standingOrder.activations, 1);
	const status = await runtime.execute(call({ kind: 'program_status' }), record());
	assert.deepEqual(status.standingOrder.lastOutcome, { state: 'FAILED', reasonCode: 'FLEE_BLOCKED' });
	assert.equal(status.standingOrder.activations, 8);
	observe(wire());
	assert.equal(events.length, 2, 'one start and one end for the episode');
	assert.equal(events[1].priority, 'ordinary');
	assert.equal(events[1].result.standingOrder.activations, 8);
	assert.equal(events[1].result.standingOrder.lastOutcome.reasonCode, 'FLEE_BLOCKED');
	const compact = compactStandingOrder(events[1].result.standingOrder);
	assert.equal(compact.activations, 8);
	assert.deepEqual(compact.lastOutcome, status.standingOrder.lastOutcome);
	const wake = buildNativeEventInput(record(), events[1]);
	assert.ok(wake.includes('FLEE_BLOCKED') && wake.includes('activations'));
	const toolText = presentNativeToolResult(status, { kind: 'program_status' }).response.contentItems[0].text;
	const toolView = JSON.parse(toolText);
	assert.deepEqual((toolView.data ?? toolView).standingOrder.lastOutcome, status.standingOrder.lastOutcome);
	now += 1;
	observe(danger);
	await until(() => events.length === 3, 'a fresh episode starts immediately');
	assert.equal(events[2].status.standingOrder.activations, 1);
	await runtime.dispose('agent-a', 'agent_removed');
});

test('a changed guard outcome category can wake urgently once while the condition stays true', async () => {
	let now = 0;
	const failures = new Map([['flee_from', 'FLEE_BLOCKED']]);
	const { runtime, observe, events, traces } = harness({ book: new StandingOrderBook({ now: () => now }), failActions: failures });
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'defend', guard: true, when: 'player.state().threat !== null',
		source: `${POLICY} await player.fleeFrom({ targetId: player.state().threat.uuid, distance: 12, timeoutMs: 3000 });` }), record());
	const danger = wire({}, { threats: { entries: [threat(1)] } });
	observe(danger);
	await until(() => traces.filter(({ event }) => event === 'native_program_ended').length === 1, 'first outcome');
	failures.set('flee_from', 'FLEE_TIMED_OUT');
	now = 250;
	observe(danger);
	await until(() => events.length === 2, 'changed outcome');
	assert.equal(events[1].priority, 'urgent');
	assert.equal(events[1].result.standingOrder.activations, 2);
	assert.equal(events[1].result.standingOrder.lastOutcome.reasonCode, 'FLEE_TIMED_OUT');
	now = 750;
	observe(danger);
	await until(() => traces.filter(({ event }) => event === 'native_program_ended').length === 3, 'same outcome');
	assert.equal(events.length, 2);
	await runtime.dispose('agent-a', 'agent_removed');
});

test('new goal text or revision clears standing guards while respawn preserves them', async () => {
	for (const change of [{ currentGoal: 'Build a house' }, { goalRevision: 4 }]) {
		const book = new StandingOrderBook();
		const { runtime, observe, sent } = harness({ book });
		observe(wire());
		await runtime.execute(call({ kind: 'standing_order', id: 'old', guard: true, when: 'player.state().health < 10', source: `${POLICY} await player.wait(1);` }), record());
		await runtime.dispose('agent-a', 'goal_respawn');
		assert.equal(book.has('agent-a'), true);
		runtime.updateObservation({ ...record(), ...change }, adaptObservation(wire({ health: 8 })), { eventSequence: 100 });
		assert.equal(book.has('agent-a'), false);
		assert.equal(commands(sent).length, 0, 'old policy does not run in new intent');
		await runtime.dispose('agent-a', 'agent_removed');
	}
	const book = new StandingOrderBook();
	const { runtime, observe } = harness({ book });
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'old', guard: true, when: 'false', source: POLICY }), record());
	await runtime.dispose('agent-a', 'goal_replace');
	assert.equal(book.has('agent-a'), false, 'goal admission clears guards before any new sample');
});

test('a guard waits for model dispatch through journal preparation and bridge publication', async () => {
	let releaseJournal, releaseSend;
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, _id, payload) => {
		sent.push({ type, payload });
		if (type === 'action_command') await new Promise(resolve => { releaseSend = resolve; });
	} }, notebook: {
		writeNote: async () => {}, query: async () => ({}), recordReceipt: async () => {}, recordUnknown: async () => {},
		recordDispatch: async () => { await new Promise(resolve => { releaseJournal = resolve; }); },
	} });
	const sample = wire({}, { world: { worldId: 'world-a', dimension: 'minecraft:overworld', gameTime: 0, dayTime: 0, raining: false, thundering: false } });
	runtime.updateObservation(record(), adaptObservation(sample), { eventSequence: 1 });
	await runtime.execute(call({ kind: 'standing_order', id: 'low', guard: true, when: 'player.state().health < 10', source: `${POLICY} await player.wait(1);` }), record());
	const dispatch = runtime.execute(call({ kind: 'start_action', actionType: 'wait', arguments: { durationMs: 5000 } }, 'model-command'), record());
	await until(() => releaseJournal !== undefined, 'model journal');
	const danger = adaptObservation({ ...sample, player: { ...sample.player, health: 8 } });
	runtime.updateObservation(record(), danger, { eventSequence: 2 });
	assert.equal((await runtime.execute(call({ kind: 'action_status' }), record())).state, 'PREPARING');
	assert.equal(sent.length, 0, 'guard cannot cancel the preparing model command');
	releaseJournal();
	await until(() => releaseSend !== undefined, 'model bridge publication');
	runtime.updateObservation(record(), danger, { eventSequence: 3 });
	assert.deepEqual(commands(sent).map(({ actionType }) => actionType), ['wait']);
	assert.equal(sent.some(({ type }) => type === 'action_cancel'), false, 'guard waits until publication completes');
	releaseSend();
	assert.equal((await dispatch).state, 'RUNNING');
	await runtime.execute(call({ kind: 'standing_order', id: 'low' }, 'clear'), record());
	await runtime.dispose('agent-a', 'agent_removed');
});



test('documented drowning guard uses air seconds and the live breathable destination', async () => {
	const reference = JSON.parse(readFileSync(new URL('./fixtures/standing-programs.json', import.meta.url), 'utf8'));
	const spec = reference.air;
	for (const hasTarget of [true, false]) {
		const { runtime, sent, observe } = harness({ holdActions: new Set(['move_to', 'control']) });
		try {
			observe(wire({ underWater: false }));
			await runtime.execute(call(normalizeMinecraftToolCall(spec.tool, spec.arguments)), record());
			assert.equal(commands(sent).length, 0, 'guard installs without moving a dry body');
			const breathable = hasTarget ? { x: 2.5, y: 68, z: 0.5, distance: 8, direction: 'up_east', seconds: 4 } : null;
			observe(wire({ underWater: true, air: 179, airSecondsLeft: 9, breathable, waterAbove: 'blocked', waterMotion: 'sinking' }));
			await until(() => commands(sent).length === 1, 'the authored water response');
			assert.equal(commands(sent)[0].actionType, hasTarget ? 'move_to' : 'control');
			if (hasTarget) for (const key of ['x', 'y', 'z']) assert.equal(commands(sent)[0].arguments[key], breathable[key]);
			else {
				assert.equal(commands(sent)[0].arguments.jump, true);
				assert.equal(commands(sent)[0].arguments.ticks, 20);
			}
			observe(wire({ underWater: false }));
		} finally { await runtime.dispose('agent-a', 'test_complete'); }
	}
});


test('the always-loaded survival example installs and dispatches its authored danger responses', async () => {
	const skill = readFileSync(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/SKILL.md', import.meta.url), 'utf8');
	// The model no longer sees a named template (owner rule: programs are written live); the runtime keeps it, so test it directly.
	assert.doesNotMatch(skill, /"template":"survival"/);
	const example = { tool: 'runProgram', arguments: { standing: { template: 'survival' } } };
	const escape = { x: 4.5, y: 64, z: 0.5 }, water = { x: 2.5, y: 64, z: 0.5 };
	const b = { x: 1.5, y: 67, z: 0.5 };
	const cases = [
		{ threats: [{...threat(1), visible:true, targetable:true}], expected: ['fight_target', 'move_to'], fail: new Map([['fight_target', 'LOW_HEALTH_BAILOUT']]) },
		{ threats: [{ ...threat(1), visible:true, targetable:true, type: 'minecraft:creeper' }], expected: ['move_to'], destination: escape },
		{ player: { onFire: true }, expected: ['move_to'], destination: escape },
		{ player: { inLava: true }, water, expected: ['move_to'], destination: water },
		{ player: { underWater: true, air: 60, breathable: b }, expected: ['move_to'], destination: b },
		{ player: { health: 7 }, food: true, expected: ['move_to', 'select_item', 'use_item'], destination: escape },
	];
	for (const scenario of cases) {
		const { runtime, sent, observe } = harness({ failActions: scenario.fail ?? new Set() });
		try {
			observe(wire({ underWater: false, breathable: null }));
			const args = { ...example.arguments, parameters: { escape, water: scenario.water ?? null } };
			const installed = await runtime.execute(call(normalizeMinecraftToolCall(example.tool, args)), record());
			assert.equal(installed.state, 'STANDING');
			assert.equal(runtime.hasStandingGuard(record()), true);
			observe(wire({ underWater: false, breathable: null, ...scenario.player }, {
				threats: { entries: scenario.threats ?? [] },
				...(scenario.water ? { world: { dimension: 'minecraft:overworld', gameTime: 0, dayTime: 0, raining: false, thundering: false } } : {}),
				...(scenario.food ? { survival: { canHealNow: true, safe: true, bestFood: { slot: 0, itemId: 'minecraft:cooked_beef', nutrition: 8 }, signals: [] } } : {}),
			}));
			await until(() => commands(sent).length >= scenario.expected.length, scenario.expected.join(','));
			assert.deepEqual(commands(sent).map(command => command.actionType), scenario.expected);
			if (scenario.destination) {
				const { x, y, z } = commands(sent)[0].arguments;
				assert.deepEqual({ x, y, z }, scenario.destination);
			}
		} finally { await runtime.dispose('agent-a', 'agent_removed'); }
	}
});

test('guard feedback counts no-op firings and retains failures across later successful actions', async () => {
	for (const noOp of [true, false]) {
		let now = 0;
		const book = new StandingOrderBook({ now: () => now });
		const { runtime, observe, traces } = harness({ book, failActions: new Set(['select_item']), failureMessage: 'Agent does not have minecraft:water_bucket' });
		observe(wire());
		await runtime.execute(call({ kind: 'standing_order', id: 'survival', guard: true, when: 'player.state().health < 10',
			source: noOp ? POLICY : `${POLICY} await player.selectItem({ itemId: "minecraft:water_bucket" }); await player.wait(1);` }), record());
		for (let count = 1; count <= 4; count++) {
			now += 5000;
			observe(wire({ health: 8 }));
			await until(() => traces.filter(row => row.event === 'native_program_ended').length === count, 'guard end');
		}
		const feedback = runtime.guardFeedback(record());
		assert.match(feedback, new RegExp(`guard survival fired 4x, ${noOp ? 0 : 8} actions`));
		if (noOp) assert.match(feedback, /outcome repeated 4x/);
		else {
			assert.match(feedback, /select_item 4x, wait 4x/);
			assert.match(feedback, /ITEM_NOT_FOUND Agent does not have minecraft:water_bucket \(repeat 4\)/);
		}
		const status = await runtime.execute(call({ kind: 'program_status' }), record());
		const shown = JSON.parse(presentNativeToolResult(status, { kind: 'program_status' }).response.contentItems[0].text);
		assert.equal((shown.data ?? shown).standingOrder.outcome, feedback);
		await runtime.dispose('agent-a', 'test_complete');
	}
});

test('a guard whose internal continue fails releases its slot and can fire again', async () => {
	class RejectedContinue extends NativeProgramExecutor {
		respond() { throw Object.assign(new Error('injected rejection'), { code: 'STALE_PROGRAM_DECISION' }); }
	}
	let now = 0;
	const { runtime, observe, sent, traces, events } = harness({ book: new StandingOrderBook({ now: () => now }), programExecutor: new RejectedContinue(), holdActions: new Set(['wait']) });
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'survival', guard: true, when: 'player.state().health < 10', source: `${POLICY} await player.wait(5000);` }), record());
	observe(wire({ health: 8 }));
	await until(() => commands(sent).length === 1, 'first firing');
	observe(wire({ health: 7 }), { attention: true, priority: 'urgent', trigger: 'damage' });
	await until(() => traces.some(row => row.reasonCode === 'STANDING_CONTINUE_FAILED'), 'clean end');
	assert.equal(runtime.hasProgram(record()), false);
	assert.equal(events.find(row => row.event === 'program_ended').result.reasonCode, 'STANDING_CONTINUE_FAILED');
	now = 5000;
	observe(wire({ health: 7 }));
	await until(() => commands(sent).length === 2, 'second firing');
	await runtime.dispose('agent-a', 'test_complete');
});

test('a guard halted by repeated action failures ends at its decision and can fire again', async () => {
	let now = 0;
	const { runtime, observe, traces, events } = harness({ book: new StandingOrderBook({ now: () => now }), failActions: new Set(['select_item']) });
	observe(wire());
	await runtime.execute(call({ kind: 'standing_order', id: 'survival', guard: true, when: 'player.state().health < 10', maxActions: 32,
		source: `${POLICY} program.repeatUntil(() => false, { maxIterations: 16 }, async () => { await player.selectItem({ itemId: "minecraft:water_bucket" }); });` }), record());
	observe(wire({ health: 8 }));
	await until(() => traces.some(row => row.reasonCode === 'STANDING_DECISION_REQUIRED'), 'guard failure decision ends');
	assert.equal(runtime.hasProgram(record()), false);
	assert.equal(events.find(row => row.event === 'program_ended').result.decision.trigger, 'action_failure');
	now = 5000;
	observe(wire({ health: 8 }));
	await until(() => traces.filter(row => row.reasonCode === 'STANDING_DECISION_REQUIRED').length === 2, 'refiring after failure');
	await runtime.dispose('agent-a', 'test_complete');
});

test('D1 invalid same-id replacement preserves the working survival guard atomically', async () => {
	const { runtime, observe } = harness();
	try {
		observe(wire());
		await runtime.execute(call(normalizeMinecraftToolCall('runProgram', { standing: { template: 'survival' } })), record());
		const previous = runtime.standingGuardCoverage(record());
		await assert.rejects(runtime.execute(call(normalizeMinecraftToolCall('runProgram', {
			standing: { id: 'survival', when: 'player.state().threat !== null', guard: true },
			source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1);',
		}), 'invalid-replacement'), record()), { code: 'STANDING_ORDER_WOULD_PAUSE' });
		assert.equal(runtime.standingGuardCoverage(record()), previous);
		assert.equal(runtime.hasStandingGuard(record()), true);
	} finally { await runtime.dispose('agent-a', 'test_complete'); }
});

test('template receipts confirm accepted root and standing parameters while failed edits keep the same guard', async () => {
	const { runtime, observe, sent } = harness();
	try {
		observe(wire());
		const install = args => runtime.execute(call(normalizeMinecraftToolCall('runProgram', args)), record());
		const first = await install({ standing: { template: 'survival', id: 'custom', threats: false, fallDepth: 6, fleeAtHealth: 12 }, parameters: { airBelowS: 8 } });
		const receipt = decodeModelFacts(JSON.parse(presentNativeToolResult(first, { kind: 'standing_order' }).response.contentItems[0].text));
		assert.equal(receipt.template, 'survival');
		assert.equal(receipt.parameters.threats, false);
		assert.equal(receipt.parameters.fallDepth, 6);
		assert.equal(receipt.parameters.airBelowS, 8);
		assert.equal(receipt.parameters.fightAtHealth, 12, 'the action spelling is reported as the shared canonical threshold');
		assert.equal(receipt.parameters.airHoldTicks, 80, 'defaults are also explicit');
		assert.equal(first.standingOrders.length, 1);
		assert.throws(() => normalizeMinecraftToolCall('runProgram', {
			standing: { template: 'survival', id: 'custom', threats: true }, parameters: { threats: false },
		}), /Conflicting/);
		assert.equal(runtime.standingGuardCoverage(record()), 'custom: installed, condition error UNKNOWN_MEMBER, fired 0x');
		const replaced = await install({ standing: { template: 'survival', id: 'custom', threats: true }, parameters: { fallDepth: 2 } });
		assert.equal(replaced.parameters.threats, true);
		assert.equal(replaced.parameters.fallDepth, 2);
		assert.deepEqual(replaced.standingOrders.map(order => order.id), ['custom']);
		assert.match(runtime.standingGuardCoverage(record()), /^custom: installed, condition error UNKNOWN_MEMBER, fired 0x/);
		assert.equal(commands(sent).length, 0, 'installing or editing chooses no body action');
	} finally { await runtime.dispose('agent-a', 'test_complete'); }
});
