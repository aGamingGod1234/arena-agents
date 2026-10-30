import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { ReflexBook, normalizeReflexEntries } from '../src/reflexes.mjs';

const record = () => ({ agentId: 'agent-a', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'standard', goalRevision: 3, currentGoal: 'beat the game' });
const call = (tool, id = 'call-1') => ({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn-1', callId: id, tool });
const until = async (predicate, label) => { for (let index = 0; index < 200; index += 1) { if (predicate()) return; await new Promise((done) => setTimeout(done, 5)); } assert.fail(`timed out waiting for ${label}`); };

function wire(player = {}, extra = {}) {
	return { ready: true, position: { x: 0.5, y: 64, z: 0.5 }, view: { yaw: 0, pitch: 0 },
		player: { health: 20, maxHealth: 20, foodLevel: 20, onFire: false, inLava: false, air: 300, maxAir: 300, onGround: true, fallDistance: 0, ...player },
		inventory: { selectedSlot: 0, items: [{ slot: 0, itemId: 'minecraft:cooked_beef', count: 6 }] }, entities: [], blocks: [], items: [], ...extra };
}

function harness() {
	const sent = [];
	const events = [];
	const traces = [];
	let sequence = 1;
	let current = wire();
	let runtime;
	const settle = (actionId, state = 'SUCCEEDED', reasonCode = '') => runtime.onActionResult(record(), { actionId, state, reasonCode, executionStarted: true });
	runtime = new NativeToolRuntime({
		trace: (event, fields) => traces.push({ event, ...fields }),
		bridge: { send: async (type, agentId, payload) => {
			sent.push({ type, payload });
			if (type === 'action_command' && payload.actionType !== 'wait') queueMicrotask(() => settle(payload.actionId));
			if (type === 'action_cancel') queueMicrotask(() => settle(payload.actionId, 'CANCELLED', 'CANCELLED'));
		} },
		requestObservation: async () => ({ observation: adaptObservation(current), eventSequence: ++sequence }),
		onProgramEvent: (_record, event) => { events.push(event); },
	});
	const observe = (observation) => { current = observation; runtime.updateObservation(record(), adaptObservation(observation), { eventSequence: ++sequence }); };
	return { runtime, sent, events, traces, observe };
}

const status = (rules, firing, events = []) => ({ revision: 1, ...(firing === undefined ? {} : { firing }), events,
	rules: rules.map((id) => ({ id, kind: 'trigger', state: firing?.id === id ? 'firing' : 'armed', fired: 0, expiresInS: 599 })) });

test('work vocabulary normalizes: tool wear, drops, falls, dusk, used-up stacks, and stop wakes by default', () => {
	const rules = normalizeReflexEntries([
		{ id: 'fresh-pick', when: { type: 'tool_low', uses: 3, tool: 'pickaxe' }, do: { type: 'select', tool: 'pickaxe' } },
		{ id: 'loot', priority: 2, when: [{ type: 'item_nearby', within: 4, items: ['cobblestone'] }, { type: 'inventory_full', not: true }], do: { type: 'pickup' } },
		{ id: 'mlg', priority: 9, when: { type: 'falling', blocks: 5 }, do: { type: 'place', item: 'water_bucket', where: 'below' } },
		{ id: 'dusk', when: { type: 'night' }, do: { type: 'stop' } },
		{ id: 'refill', when: { type: 'stack_used_up', item: 'torch' }, do: { type: 'select', item: 'torch' } },
		{ id: 'quiet-stop', when: { type: 'saturation_empty' }, do: { type: 'stop' }, wake: false },
	]);
	assert.deepEqual(rules[1].when[0], { type: 'item_nearby', within: 4, items: ['minecraft:cobblestone'] });
	assert.deepEqual(rules[2].do, { type: 'place', item: 'minecraft:water_bucket', where: 'below' });
	assert.equal(rules[3].wake, true, 'stop hands the moment to the model');
	assert.equal(rules[5].wake, undefined, 'unless the rule says wake:false');
	assert.throws(() => normalizeReflexEntries([{ id: 'a', when: { type: 'tool_low' }, do: { type: 'eat' } }]), /uses is required/);
	assert.throws(() => normalizeReflexEntries([{ id: 'a', when: { type: 'falling', blocks: 4 }, do: { type: 'place', item: 'dirt', where: 'behind' } }]), /where must be one of ahead, below/);
	assert.throws(() => normalizeReflexEntries([{ id: 'a', when: { type: 'falling', blocks: 4 }, do: { type: 'place', where: 'below' } }]), /item is required/);
});

test('a stop firing is reported once per firing', () => {
	const book = new ReflexBook();
	book.apply('a', normalizeReflexEntries([{ id: 'dusk', when: { type: 'night' }, do: { type: 'stop' } }, { id: 'snack', when: { type: 'hunger_below', value: 6 }, do: { type: 'eat' } }]));
	book.observe('a', status(['dusk', 'snack'], { id: 'snack', ms: 50 }));
	assert.equal(book.stopFiring('a'), null, 'an eat firing is not a stop');
	book.observe('a', status(['dusk', 'snack'], { id: 'dusk', ms: 50 }));
	assert.equal(book.stopFiring('a'), 'dusk');
	book.observe('a', status(['dusk', 'snack'], { id: 'dusk', ms: 100 }));
	assert.equal(book.stopFiring('a'), null, 'the same firing is handled once');
	book.observe('a', status(['dusk', 'snack']));
	book.observe('a', status(['dusk', 'snack'], { id: 'dusk', ms: 50 }));
	assert.equal(book.stopFiring('a'), 'dusk', 'a later firing is new');
});

test('stop: the coordinator cancels the running action while the mod holds the body, and the report wakes the model', async () => {
	const { runtime, sent, events, observe } = harness();
	observe(wire());
	await runtime.execute(call(normalizeMinecraftToolCall('runProgram', { reflexes: [{ id: 'dusk', when: { type: 'night' }, do: { type: 'stop' } }] })), record());
	const waiting = runtime.execute(call({ kind: 'action', actionType: 'wait', arguments: { durationMs: 6000 } }, 'call-wait'), record());
	await until(() => sent.some(({ type }) => type === 'action_command'), 'the wait');
	observe(wire({}, { reflexes: status(['dusk'], { id: 'dusk', ms: 50, detail: 'holding still; stopping the running work' }) }));
	const result = await waiting;
	assert.equal(result.state, 'CANCELLED');
	assert.equal(result.cancelledBy, 'reflex:dusk');
	observe(wire({}, { reflexes: status(['dusk'], undefined, [{ seq: 1, id: 'dusk', outcome: 'done', ms: 150, detail: 'stopped the running action', wake: true }]) }));
	assert.equal(events.at(-1)?.event, 'reflex_report');
	assert.match(runtime.reflexReport(record()), /dusk done: stopped the running action/);
	await runtime.dispose('agent-a', 'test_complete');
});

test('precedence: a standing order waits while a reflex fires and fires after it only if its condition still holds', async () => {
	const { runtime, sent, observe } = harness();
	observe(wire({ health: 12 }));
	await runtime.execute(call(normalizeMinecraftToolCall('runProgram', { reflexes: [{ id: 'snack', when: { type: 'health_below', value: 10 }, do: { type: 'eat' } }] })), record());
	await runtime.execute(call({ kind: 'standing_order', id: 'eat', when: 'player.state().health < 10', ttlS: 300,
		source: 'program.onUnhandledAttention("continue_and_notify", { survival: "continue_and_notify" }); await player.selectItem({ itemId: "minecraft:cooked_beef" });', maxActions: 2, timeoutMs: 5000 }, 'call-order'), record());
	const waiting = runtime.execute(call({ kind: 'action', actionType: 'wait', arguments: { durationMs: 6000 } }, 'call-wait'), record());
	await until(() => sent.some(({ type }) => type === 'action_command'), 'the wait');
	observe(wire({ health: 9 }, { reflexes: status(['snack'], { id: 'snack', ms: 50, detail: 'eating minecraft:cooked_beef' }) }));
	await new Promise((done) => setTimeout(done, 30));
	assert.equal(sent.filter(({ type }) => type === 'action_cancel').length, 0, 'the order does not double the reflex reaction');
	// The reflex ended but health is still low: now the slower, larger reaction runs.
	observe(wire({ health: 9 }, { reflexes: status(['snack'], undefined, [{ seq: 1, id: 'snack', outcome: 'done', ms: 1600, detail: 'ate minecraft:cooked_beef' }]) }));
	const result = await waiting;
	assert.equal(result.cancelledBy, 'standing:eat');
	await runtime.dispose('agent-a', 'test_complete');
});

test('time a reflex held the body moves the program deadline out, bounded to the program timeout', async () => {
	const timers = [];
	let now = 0;
	const executor = new NativeProgramExecutor({ now: () => now, setTimeoutFn: (fn, ms) => { const timer = { fn, ms, at: now, cleared: false }; timers.push(timer); return timer; }, clearTimeoutFn: (timer) => { if (timer) timer.cleared = true; } });
	const done = executor.run(record(), { source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait({ durationMs: 60000 });', timeoutMs: 10_000, programId: 'p-1' },
		{ executeAction: () => new Promise(() => {}), cancelAction: async () => ({ state: 'CANCELLED' }), eventSequence: 1, observation: adaptObservation(wire()) });
	const deadline = () => timers.filter((timer) => !timer.cleared && timer.ms >= 1_000).at(-1);
	assert.equal(deadline().ms, 10_000);
	now = 4_000;
	assert.equal(executor.extendDeadline('agent-a', 'p-1', 3_000), 3_000);
	assert.equal(deadline().ms, 9_000, '4 s ran, 6 s were left, plus 3 s held by the reflex');
	assert.equal(executor.extendDeadline('agent-a', 'other', 1_000), 0, 'only the running program is credited');
	assert.equal(executor.extendDeadline('agent-a', 'p-1', 60_000), 7_000, 'credit stops at the program timeout');
	void executor.cancel('agent-a', 'TEST_DONE').catch(() => {});
	void done;
});

test('hot-floor contact can arm an exit without pretending the body is on fire', () => {
  const [rule] = normalizeReflexEntries([{ id: 'magma', priority: 9, when: { type: 'on_hot_floor' }, do: { type: 'leave_fire' } }]);
  assert.equal(rule.when[0].type, 'on_hot_floor');
  assert.equal(rule.do.type, 'leave_fire');
});
