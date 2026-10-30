import assert from 'node:assert/strict';
import test from 'node:test';
import { WakeFilter, pearlsOpen, shownKinds } from '../src/wake-filter.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

const ZOMBIE = '11111111-1111-1111-1111-111111111111';
const SKELETON = '22222222-2222-2222-2222-222222222222';
const urgent = (trigger) => ({ attention: true, priority: 'urgent', trigger });
const sample = ({ health = 20, attacker = null, threats = [], entities = [], items = [], onFire = false, inLava = false, sighted } = {}) => ({
	player: { health, maxHealth: 20, onFire, inLava, threats, ...(attacker === null ? {} : { lastAttacker: { uuid: ZOMBIE, type: attacker, distance: 2 } }) },
	entities, inventory: { items }, ...(sighted === undefined ? {} : { sighted }),
});
const zombieRow = { uuid: ZOMBIE, type: 'minecraft:zombie', distance: 3, signals: ['targeting'] };
const skeletonRow = { uuid: SKELETON, type: 'minecraft:skeleton', distance: 9, signals: ['clear_shot'] };

test('hits by a kind the model was shown are summed into the next wake; a new kind, low health or lava wakes at once', () => {
	const filter = new WakeFilter();
	// The model's last wake showed a zombie.
	assert.equal(filter.take('a', sample({ threats: [zombieRow] })), null);
	assert.deepEqual(filter.decide('a', { attention: urgent('damage'), observation: sample({ health: 17, attacker: 'minecraft:zombie', threats: [zombieRow] }) }), { verdict: 'hold', reason: 'hit absorbed' });
	assert.equal(filter.decide('a', { attention: urgent('damage'), observation: sample({ health: 14, attacker: 'minecraft:zombie', threats: [zombieRow] }) }).verdict, 'hold');
	assert.equal(filter.decide('a', { attention: urgent('threat'), observation: sample({ threats: [zombieRow] }), changedFacts: [`threats.${ZOMBIE}.targeting`] }).verdict, 'hold');
	const skeleton = filter.decide('a', { attention: urgent('threat'), observation: sample({ threats: [zombieRow, skeletonRow] }), changedFacts: [`threats.${SKELETON}.clear_shot`] });
	assert.deepEqual(skeleton, { verdict: 'wake', reason: 'new hostile kind: skeleton' });
	const creeper = { uuid: SKELETON, type: 'minecraft:creeper', distance: 3, signals: ['swelling'] };
	assert.deepEqual(filter.decide('a', { attention: urgent('threat'), observation: sample({ threats: [creeper] }), changedFacts: [`threats.${SKELETON}.swelling`] }), { verdict: 'wake', reason: 'threat signal swelling' }, 'a swelling creeper wakes even once its kind is known');
	assert.equal(filter.decide('a', { attention: urgent('damage'), observation: sample({ health: 8, attacker: 'minecraft:zombie', threats: [zombieRow] }) }).reason, 'health at or below the low floor');
	assert.equal(filter.decide('a', { attention: urgent('damage'), observation: sample({ health: 15, attacker: 'minecraft:zombie', inLava: true }) }).reason, 'lava at the body');
	assert.equal(filter.decide('a', { attention: urgent('damage'), observation: sample({ health: 15 }) }).reason, 'damage with no seen attacker');
	for (const trigger of ['lava', 'lava_flow', 'drowning', 'fall', 'cloud', 'movement_loop', 'low_health']) assert.equal(filter.decide('a', { attention: urgent(trigger), observation: sample() }).verdict, 'wake', trigger);
	const line = filter.take('a', sample({ health: 14, threats: [zombieRow, skeletonRow] }));
	assert.equal(line, 'not woken for: 2 hit(s) taken (zombie 2, health 20 -> 14); 1 threat signal(s) from zombie');
	assert.equal(filter.take('a', sample()), null, 'the summary is delivered once');
});

test('a burn is held only while an armed fire rule handles it; no rule or a failed firing wakes', () => {
	const filter = new WakeFilter();
	filter.take('a', sample());
	const burning = sample({ onFire: true, health: 18 });
	assert.equal(filter.decide('a', { attention: urgent('fire'), observation: burning, reflexRules: [], reflexEvents: [{ seq: 4, id: 'default-fire', outcome: 'failed' }] }).reason, 'burning with no fire rule armed');
	const rules = [{ id: 'default-fire', do: { type: 'leave_fire' }, state: 'armed' }];
	assert.equal(filter.decide('a', { attention: urgent('fire'), observation: burning, reflexRules: rules, reflexEvents: [{ seq: 4, id: 'default-fire', outcome: 'failed' }] }).verdict, 'hold', 'a failure before the hold began is old news');
	assert.equal(filter.decide('a', { attention: urgent('damage'), observation: burning, reflexRules: rules, reflexEvents: [{ seq: 4, id: 'default-fire', outcome: 'failed' }] }).verdict, 'hold', 'burn damage is judged as fire');
	assert.equal(filter.decide('a', { attention: urgent('fire'), observation: burning, reflexRules: rules, reflexEvents: [{ seq: 5, id: 'default-fire', outcome: 'failed' }] }).reason, 'burning after a fire rule failed');
	assert.equal(filter.decide('a', { attention: urgent('fire'), observation: burning, reflexRules: [{ ...rules[0], state: 'disabled' }] }).reason, 'burning with no fire rule armed');
	assert.match(filter.take('a', burning), /2 fire contact\(s\) with a fire rule armed/);
});

test('discoveries wake: a fortress or portal sighted, an enderman in range while pearls are open; routine updates and items are summed', () => {
	const filter = new WakeFilter();
	filter.take('a', sample({ items: [{ itemId: 'minecraft:blaze_rod', count: 1 }] }));
	const plain = { attention: true, priority: 'ordinary', trigger: 'attention' };
	assert.equal(filter.decide('a', { attention: plain, observation: sample({ items: [{ itemId: 'minecraft:blaze_rod', count: 1 }] }) }).verdict, 'default');
	assert.equal(filter.decide('a', { attention: { ...plain, trigger: 'structure_sighted' }, observation: sample({ sighted: { structures: [{ type: 'minecraft:fortress', new: true }] } }) }).reason, 'fortress sighted');
	assert.equal(filter.decide('a', { attention: { ...plain, trigger: 'structure_sighted' }, observation: sample({ sighted: { structures: [{ type: 'minecraft:village', new: true }] } }) }).verdict, 'default', 'other sightings keep the ordinary hold');
	const enderman = sample({ entities: [{ type: 'minecraft:enderman', distance: 14 }] });
	assert.equal(filter.decide('a', { attention: plain, observation: enderman, goalText: 'Collect 6 blaze rods.' }).verdict, 'default', 'pearls are not open for a rod goal');
	assert.equal(filter.decide('a', { attention: plain, observation: enderman, goalText: 'Beat the game.' }).reason, 'enderman in range while pearls are open');
	assert.equal(filter.decide('a', { attention: plain, observation: enderman, goalText: 'Beat the game.' }).verdict, 'default', 'the same enderman kind does not wake twice before the next wake');
	assert.equal(pearlsOpen('Beat the game.', sample({ items: [{ itemId: 'minecraft:ender_pearl', count: 9 }, { itemId: 'minecraft:ender_eye', count: 3 }] })), false, '12 pearls plus eyes close it');
	assert.equal(filter.take('a', sample({ items: [{ itemId: 'minecraft:blaze_rod', count: 3 }] })), 'not woken for: items gained blaze_rod +2; 3 routine update(s)');
	assert.deepEqual([...shownKinds(sample({ attacker: 'minecraft:blaze' }))], ['minecraft:blaze']);
});

// ---- Through the coordinator: a running action, hits from a known kind, and the wake it owes. ----

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wakeOf = (request) => JSON.parse(request.input.split('\n')[1]);

function observation(sequence, { attention = false, health = 20, changedFacts, attacker, threats } = {}) {
	return { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence, attention, observedAtEpochMs: sequence, ...(changedFacts === undefined ? {} : { changedFacts }),
		observation: { player: { x: 0, y: 64, z: 0, health, ...(attacker === undefined ? {} : { lastAttacker: { uuid: ZOMBIE, type: attacker, distance: 2 } }) },
			items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} }, ...(threats === undefined ? {} : { threats: { entries: threats } }) } } };
}

/** Starts a goal whose first turn starts a 60 s wait (the model's own running action) and ends its turn. */
export async function startWithRunningAction() {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' });
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		if (planner.requests.length === 1) {
			await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId: 'c1', tool: { kind: 'start_action', actionType: 'wait', arguments: { durationMs: 60_000 } } });
			return { toolCalls: 1 };
		}
		return { toolCalls: 0 };
	};
	const timers = [];
	const run = await start({ registry, planner, setWakeHoldTimeout: (callback, delayMs) => { const timer = { callback, delayMs }; timers.push(timer); return timer; }, clearWakeHoldTimeout: () => {},
		traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: CONFIG });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Fight.' } });
	run.bridge.emit('observation', observation(1, { attention: true, changedFacts: ['blocks'], attacker: 'minecraft:zombie' }));
	await eventually(() => run.bridge.sent.some(({ type }) => type === 'action_command'));
	await eventually(() => rows.some(({ event }) => event === 'native_turn_completed'));
	const command = run.bridge.sent.find(({ type }) => type === 'action_command');
	const finish = () => run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state: 'SUCCEEDED', reasonCode: 'WAIT_DONE', actionType: 'wait', eventSequence: 500 } });
	return { run, planner, rows, finish, timers };
}

test('while its action runs, hits from the zombie the model saw are not wakes; the completion wake sums them', async () => {
	const { run, planner, rows, finish, timers } = await startWithRunningAction();
	try {
		run.bridge.emit('observation', observation(2, { attention: true, health: 17, changedFacts: ['player.health'], attacker: 'minecraft:zombie' }));
		run.bridge.emit('observation', observation(3, { attention: true, health: 14, changedFacts: ['player.health'], attacker: 'minecraft:zombie' }));
		run.bridge.emit('observation', observation(4, { attention: true, changedFacts: ['blocks'] }));
		await eventually(() => rows.filter(({ event }) => event === 'native_wake_filtered').length === 2);
		await tick();
		assert.equal(planner.requests.length, 1, 'no model call for hits the body is taking at safe health');
		assert.equal(timers.length, 0, 'absorbed hits and routine updates arm no release deadline');
		finish();
		run.bridge.emit('observation', observation(501, { attention: true, changedFacts: ['lastResult'] }));
		await eventually(() => planner.requests.length === 2);
		assert.equal(wakeOf(planner.requests[1]).now?.whileActing, 'not woken for: 2 hit(s) taken (zombie 2, health 20 -> 14); 1 routine update(s)');
	} finally { await run.coordinator.stop(); }
});

test('while its action runs, a hit from a new kind or at the low floor wakes the model at once', async () => {
	const { run, planner } = await startWithRunningAction();
	try {
		run.bridge.emit('observation', observation(2, { attention: true, health: 16, changedFacts: ['player.health'], attacker: 'minecraft:skeleton' }));
		await eventually(() => planner.requests.length === 2);
		assert.equal(planner.requests[1].priority, 'urgent');
		assert.equal(wakeOf(planner.requests[1]).trigger, 'damage');
		run.bridge.emit('observation', observation(3, { attention: true, health: 7, changedFacts: ['player.health'], attacker: 'minecraft:skeleton' }));
		await eventually(() => planner.requests.length === 3);
	} finally { await run.coordinator.stop(); }
});
