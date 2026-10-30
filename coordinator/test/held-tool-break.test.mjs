import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { buildNativeEventInput, classifyObservationTrigger } from '../src/dynamic-main.mjs';
import { heldToolBreak } from '../src/held-tool-break.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

// A held tool breaking (the sound and particles a player sees and hears) reaches the model while a program runs, with
// what broke and the tools of the same kind still held. Nothing swaps the tool: the model decides (live f734: a program kept
// selecting the empty slot 7 and mined bare-handed for 3.5 min while an iron pickaxe sat in slot 5).

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wake = (request) => JSON.parse(request.input.split('\n')[1]);

const tool = (slot, itemId, damage, maxDamage) => ({ slot, itemId, count: 1, damage, maxDamage });
/** The f734 inventory: a stone pickaxe at its last use held from hotbar slot 7. */
function inventory({ held = tool('mainhand', 'minecraft:stone_pickaxe', 130, 131), selectedSlot = 7 } = {}) {
	return { selectedSlot, selectedItem: held?.itemId ?? 'minecraft:air', tagCounts: {}, items: [
		...(held === null ? [] : [held]), tool('offhand', 'minecraft:shield', 0, 336), { slot: 1, itemId: 'minecraft:cobblestone', count: 64 },
		tool(4, 'minecraft:stone_sword', 0, 131), tool(5, 'minecraft:iron_pickaxe', 126, 250), tool(35, 'minecraft:wooden_pickaxe', 55, 59),
	] };
}
const BROKEN = { itemId: 'minecraft:stone_pickaxe', hand: 'mainhand', slot: 7,
	sameKind: [{ itemId: 'minecraft:iron_pickaxe', slot: 5, usesLeft: 124 }, { itemId: 'minecraft:wooden_pickaxe', slot: 35, usesLeft: 4 }] };

test('a held tool at its last uses gone from the hand and the inventory is a break, with the same-kind tools still held', () => {
	assert.deepEqual(heldToolBreak(inventory(), inventory({ held: null })), BROKEN);
	// An offhand tool too.
	const offhand = { selectedSlot: 0, items: [tool('offhand', 'minecraft:shears', 237, 238)] };
	assert.deepEqual(heldToolBreak(offhand, { selectedSlot: 0, items: [] }), { itemId: 'minecraft:shears', hand: 'offhand', sameKind: [] });
});

test('a tool that leaves the hand without breaking is not a break', () => {
	// Plenty of uses left: moved, dropped or stored, not broken.
	assert.equal(heldToolBreak(inventory({ held: tool('mainhand', 'minecraft:stone_pickaxe', 20, 131) }), inventory({ held: null })), null);
	// Another hotbar slot selected: the worn pickaxe is still in slot 7.
	const moved = inventory({ held: tool('mainhand', 'minecraft:iron_pickaxe', 126, 250), selectedSlot: 5 });
	moved.items = moved.items.filter((row) => row.slot !== 5).concat(tool(7, 'minecraft:stone_pickaxe', 130, 131));
	assert.equal(heldToolBreak(inventory(), moved), null);
	// Same count after (the stack was moved within the inventory).
	const shuffled = inventory({ held: null });
	shuffled.items.push(tool(20, 'minecraft:stone_pickaxe', 130, 131));
	assert.equal(heldToolBreak(inventory(), shuffled), null);
	// Still held, one more use spent.
	assert.equal(heldToolBreak(inventory({ held: tool('mainhand', 'minecraft:stone_pickaxe', 129, 131) }), inventory()), null);
	assert.equal(heldToolBreak(null, inventory({ held: null })), null);
});

test('the break is its own ordinary trigger; danger in the same sample keeps precedence', () => {
	const signals = { previousPlayer: { health: 20 }, toolBreak: BROKEN };
	assert.deepEqual(classifyObservationTrigger({ attention: true, changedFacts: [] }, { player: { health: 20 } }, signals),
		{ attention: true, priority: 'ordinary', trigger: 'tool_broke' });
	// A quiet heartbeat sample is attention too, and an ordinary server reason in the same sample is named as the break.
	assert.equal(classifyObservationTrigger({ attention: false }, { player: { health: 20 } }, signals).trigger, 'tool_broke');
	assert.equal(classifyObservationTrigger({ attention: true, trigger: 'attention' }, { player: { health: 20 } }, signals).trigger, 'tool_broke');
	assert.equal(classifyObservationTrigger({ attention: true }, { player: { health: 12 } }, signals).trigger, 'damage');
	assert.equal(classifyObservationTrigger({ attention: true }, { player: { health: 20 } }, { previousPlayer: { health: 20 } }).trigger, 'attention');
	const event = wake({ input: buildNativeEventInput({ agentId: 'agent-a', goalRevision: 1 }, { event: 'observation', trigger: 'tool_broke',
		observation: { player: { health: 20 }, inventory: inventory({ held: null }), toolBroke: BROKEN } }) });
	assert.deepEqual(event.observation.toolBroke, BROKEN, 'the wake names what broke and the spares');
});

const record = { agentId: 'agent-a', goalRevision: 1, provider: 'codex', model: 'test', reasoningEffort: 'low' };
test('programs: the break notifies at once, past reassessWhen and the ordinary window; the authored policy decides the body', async () => {
	for (const [policy, paused] of [['continue_and_notify', false], ['pause_and_notify', true]]) {
		let done;
		const body = new Promise((resolve) => { done = resolve; });
		const decisions = [];
		let cancelled = false;
		const executor = new NativeProgramExecutor();
		const facts = { player: { health: 20 }, world: { dimension: 'minecraft:overworld' }, inventory: inventory(), blocks: [], entities: [], items: [] };
		const result = executor.run(record, { source: `program.onUnhandledAttention("${policy}", {reassessWhen:() => false}); await player.wait(10000);` },
			{ observation: facts, eventSequence: 1, executeAction: () => body, cancelAction: async () => { cancelled = true; done({ state: 'CANCELLED', reasonCode: 'INPUT_RELEASED' }); }, onDecision: (status) => decisions.push(status.decision) });
		await tick();
		executor.onObservation(record, { observation: { ...facts, inventory: inventory({ held: null }) }, eventSequence: 2, attention: true, priority: 'ordinary', trigger: 'tool_broke' });
		await tick(); await tick();
		assert.deepEqual(decisions.map((decision) => decision.trigger), ['tool_broke'], policy);
		assert.equal(cancelled, paused, policy);
		done({ state: 'SUCCEEDED', reasonCode: 'DONE' });
		await tick();
		await executor.cancel(record);
		await result;
	}
});

function observation(sequence, inv, changedFacts = ['blocks']) {
	return { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence, attention: true, observedAtEpochMs: sequence, changedFacts,
		observation: { player: { x: 0, y: 64, z: 0, health: 20 }, items: [], entities: [], blocks: [], inventory: inv,
			world: { dimension: 'minecraft:overworld', gameTime: 1_000 + sequence, dayTime: 1_000 + sequence, raining: false, thundering: false } } } };
}

test('a background mining program reaches the model when its held pickaxe breaks, with the spare pickaxes', async () => {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
	const program = { kind: 'run_program', background: true, timeoutMs: 30_000,
		source: 'program.onUnhandledAttention("continue_and_notify", {reassessWhen:() => false}); await player.wait(20000);' };
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		if (planner.requests.length === 1) await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId: 'c1', tool: program });
		return { toolCalls: planner.requests.length === 1 ? 1 : 0 };
	};
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: CONFIG });
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Mine iron.' } });
		run.bridge.emit('observation', observation(1, inventory()));
		await eventually(() => run.bridge.sent.some((message) => message.type === 'action_command'));
		// Ordinary progress inside the waiver does not wake the model.
		run.bridge.emit('observation', observation(2, inventory()));
		await tick(); await tick();
		assert.equal(planner.requests.length, 1);
		run.bridge.emit('observation', observation(3, inventory({ held: null }), []));
		await eventually(() => planner.requests.length >= 2);
		const event = wake(planner.requests[1]);
		assert.equal(event.event, 'program_attention');
		assert.equal(event.program.decision.trigger, 'tool_broke');
		assert.deepEqual(event.observation.toolBroke, BROKEN);
		assert.equal(run.bridge.sent.some((message) => message.type === 'action_cancel'), false, 'the authored routine keeps running; nothing swaps the tool');
	} finally { await run.coordinator.stop(); }
});
