import { compactEventInstruction } from '../src/dynamic-main.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { buildNativeEventInput, burnFacts, classifyObservationTrigger, imminentLavaFlow, LAVA_FLOW_TRIGGER, lavaFlowLine, lavaFlowWakeDue, nativeSteerInterruption, FIRE_CONTACT_INSTRUCTION, HAZARD_CONTACT_INSTRUCTION, healingFacts, inHazardContact, isHazardContactRequest, nativeObservationSignature, turnUsageTraceFields } from '../src/dynamic-main.mjs';
import { minecraftStrategyReference, STRATEGY_REFERENCE_TOPICS } from '../src/minecraft-strategy-reference.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { validateAction } from '../src/schema.mjs';
import { SURVIVAL_TRIGGERS } from '../src/arena-script/program-engine.mjs';
import { FakePlanner, immutableGoalSpec, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

const NATIVE_CONFIG = {
	bridge: { port: 25570, secret: 's'.repeat(32) },
	codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } },
};
const EXITS = ['front_right 1.4m up1 (-8,70,0)', 'left 2.1m 1lava (-10,69,1)'];
const payloadOf = (input) => JSON.parse(input.slice(input.indexOf('\n') + 1));

test('hazard contact means lava or touching fire, never fire resistance, a hot floor or burning after leaving', () => {
	assert.equal(inHazardContact({ inLava: true }), true);
	assert.equal(inHazardContact({ hazard: 'lava' }), true);
	assert.equal(inHazardContact({ onFire: true, hazard: 'fire', exits: EXITS }), true, 'Minecraft names the fire block the body touches');
	// Review r1 P2-3, measured live: magma gave inLava:false, onFire:false, hurtBy hot_floor and four exits.
	assert.equal(inHazardContact({ inLava: false, onFire: false, hazard: 'hot_floor', hurtBy: 'hot_floor', exits: EXITS }), false,
		'exits on magma are not proof of lava or fire');
	assert.equal(inHazardContact({ onFire: true, exits: EXITS }), false, 'exits alone prove nothing');
	assert.equal(inHazardContact({ onFire: true, fireTicks: 200 }), false, 'burning on dry ground is not contact');
	assert.equal(inHazardContact({ hazard: 'fire', effects: [{ effectId: 'minecraft:fire_resistance' }] }), false);
	assert.equal(inHazardContact({ inLava: true, effects: [{ effectId: 'minecraft:fire_resistance', amplifier: 0, duration: 600 }] }), false);
	const observation = (player) => ({ player });
	for (const trigger of ['threat', 'fall', 'suffocation', 'low_health', 'movement_loop']) {
		assert.equal(isHazardContactRequest({ trigger, nativeEvent: { trigger, observation: observation({ inLava: true }) } }), true, trigger);
	}
	assert.equal(isHazardContactRequest({ trigger: 'lava', nativeEvent: { trigger: 'lava', observation: observation({ inLava: true }) } }), true);
	assert.equal(isHazardContactRequest({ trigger: 'fire', nativeEvent: { trigger: 'fire', observation: observation({ onFire: true, fireTicks: 120 }) } }), false);
	assert.equal(isHazardContactRequest({ trigger: 'damage', nativeEvent: { trigger: 'damage', observation: observation({ inLava: true }) } }), true,
		'lava contact costs health, so its event is often classified as damage');
	assert.equal(isHazardContactRequest({ trigger: 'damage', nativeEvent: { trigger: 'damage', observation: observation({ onFire: true }) } }), false);
	assert.equal(isHazardContactRequest({ trigger: 'damage', nativeEvent: { trigger: 'damage', observation: observation({ hazard: 'hot_floor', exits: EXITS }) } }), false,
		'magma damage never cancels a call');
	assert.equal(isHazardContactRequest({ trigger: 'structure_sighted', nativeEvent: { trigger: 'structure_sighted', observation: observation({ inLava: true }) } }), false);
});

test('fire and lava events carry the burn, food and carried food', () => {
	assert.equal(burnFacts({ onFire: false }), null);
	assert.deepEqual(burnFacts({ fireTicks: 281 }), { seconds: 15, rawDamage: 14 }, 'on_fire deals 1 HP per second through armour, before Resistance or Fire Protection');
	assert.deepEqual(burnFacts({ fireTicks: 100, effects: [{ effectId: 'minecraft:fire_resistance' }] }), { seconds: 5, rawDamage: 0 });
	const observation = {
		player: { x: 0, y: 70, z: 0, health: 10.9, maxHealth: 20, foodLevel: 15, saturation: 0, onFire: true, fireTicks: 290, hazard: 'fire', exits: EXITS,
			bestFood: { slot: 3, itemId: 'minecraft:cooked_beef', nutrition: 8 } },
		inventory: { items: [] }, entities: [], blocks: [], items: [],
	};
	assert.equal(healingFacts(observation).burn.rawDamage, 14);
	for (const trigger of ['fire', 'lava', 'damage']) {
		const payload = payloadOf(buildNativeEventInput({ currentGoal: 'Find a fortress.' }, { event: 'observation', trigger, observation }));
		assert.equal(payload.healing.foodLevel, 15);
		assert.equal(payload.healing.bestFood.itemId, 'minecraft:cooked_beef');
		assert.deepEqual(payload.healing.burn, { remaining: 'not_observed' });
		assert.equal(payload.healing.options, undefined, 'contact facts do not offer an eating menu');
		assert.deepEqual(payload.observation.player.exits, EXITS, 'the steer names the same exits as the stopped action');
	}
	const quiet = payloadOf(buildNativeEventInput({ currentGoal: 'Find a fortress.' }, { event: 'observation', trigger: 'structure_sighted', observation }));
	assert.equal(quiet.healing, undefined, 'only hazard and healing events pay for healing facts');
});

test('burning on dry ground keeps food options and names the continuing burn', () => {
	for (const trigger of ['damage', 'lava', 'fire']) {
		const input = buildNativeEventInput({ currentGoal: 'Find a fortress.' }, { event: 'program_attention', trigger: 'program_attention',
			status: { decision: { trigger, priority: 'urgent' } }, observation: {
				player: { health: 10, maxHealth: 20, foodLevel: 15, onFire: true, fireTicks: 200,
					bestFood: { slot: 3, itemId: 'minecraft:cooked_beef', nutrition: 8 } }, inventory: { items: [] },
			} });
		assert.match(input.split('\n')[0], /[Bb]urn (?:continues )?after exit/);
		assert.doesNotMatch(input.split('\n')[0], /fight_target or flee_from/);
		assert.ok(payloadOf(input).healing.options.some(option => option.includes('eat carried')));
	}
});

test('only a lava or fire contact event carries the hazard line, and it never says eating outpaces the burn', () => {
	const inLava = { player: { x: 0, y: 66, z: 0, health: 12, maxHealth: 20, foodLevel: 18, inLava: true, hazard: 'lava', fireTicks: 300, exits: EXITS }, inventory: { items: [] }, entities: [], blocks: [], items: [] };
	for (const trigger of ['lava', 'damage', 'threat', 'fall', 'suffocation', 'low_health', 'movement_loop']) {
		const input = buildNativeEventInput({ currentGoal: 'Find a fortress.' }, { event: 'observation', trigger, observation: inLava });
		assert.ok(input.startsWith(`${compactEventInstruction(HAZARD_CONTACT_INSTRUCTION)}\n`), trigger);
	}
	assert.match(HAZARD_CONTACT_INSTRUCTION, /Move horizontally out now, holding jump toward higher exits/);
	assert.match(HAZARD_CONTACT_INSTRUCTION, /^Live Minecraft event: lava\/fire contact/);
	assert.ok(Buffer.byteLength(HAZARD_CONTACT_INSTRUCTION) <= 239);
	assert.match(HAZARD_CONTACT_INSTRUCTION, /Lava costs ~8 HP\/s/);
	assert.doesNotMatch(HAZARD_CONTACT_INSTRUCTION, /eat|heals? faster|faster than/);
	const generic = 'Update. Use fresh facts for the goal. Keep authorised routines; answer program decisions.';
	// Keep the contact line within its original absolute byte budget, even when the generic line gets shorter.
	assert.ok(Buffer.byteLength(HAZARD_CONTACT_INSTRUCTION) <= 239);
	// Live d8-nether-a/b: a blaze fireball's fire block under the feet is not lava; its line names the fire block.
	const inFire = { player: { ...inLava.player, inLava: false, hazard: 'fire', onFire: true, harm: { source: 'minecraft:in_fire', ongoing: true, exits: EXITS } } };
	for (const trigger of ['fire', 'damage', 'threat']) {
		const input = buildNativeEventInput({ currentGoal: 'Find a fortress.' }, { event: 'observation', trigger, observation: inFire });
		assert.ok(input.startsWith(`${compactEventInstruction(FIRE_CONTACT_INSTRUCTION)}\n`), trigger);
	}
	assert.doesNotMatch(FIRE_CONTACT_INSTRUCTION, /lava|jump/i);
	const magma = { player: { ...inLava.player, inLava: false, hazard: 'hot_floor' } };
	assert.match(buildNativeEventInput({ currentGoal: 'Find a fortress.' }, { event: 'observation', trigger: 'damage', observation: magma }).split('\n')[0], /[Bb]urn (?:continues )?after exit/);
	const strategy = minecraftStrategyReference({ topic: 'hazards' }).reference;
	assert.doesNotMatch(strategy, /faster than the burn/);
	assert.match(strategy, /20 food with saturation, natural regeneration can outpace ordinary burning/);
	assert.match(strategy, /player.effects.duration is in ticks/);
	assert.doesNotMatch(strategy, /nothing outpaces lava/);
	assert.doesNotMatch(strategy, /Eat as soon/, 'facts, not an instruction');
});

test('a turn that carries an interrupted generation traces its share', () => {
	const interrupted = { calls: 1, input: 2, cacheRead: 14_938, cacheWrite: 1_275, output: 3 };
	const fields = turnUsageTraceFields({ calls: 2, input: 4, cacheRead: 30_491, cacheWrite: 2_016, output: 17, costUsd: null, interrupted });
	assert.equal(fields.interruptedModelCalls, 1);
	assert.equal(fields.interruptedTokens, 16_218);
	assert.equal(fields.cachedInputTokens, 30_491, 'the totals already include it');
	assert.equal(turnUsageTraceFields({ calls: 1, input: 1, cacheRead: 1, cacheWrite: 0, output: 1 }).interruptedTokens, undefined);
});

test('ticking hazard counters do not count as changed world facts', () => {
	const base = { player: { health: 12, onFire: true } };
	const signature = nativeObservationSignature({ ...base, player: { ...base.player, hazard: 'fire', fireTicks: 200, hurtBy: 'on_fire', lavaSeen: ['(1,2,3) 3s ago'] } });
	assert.equal(nativeObservationSignature({ ...base, player: { ...base.player, fireTicks: 180, lavaSeen: ['(1,2,3) 4s ago'] } }), signature);
	assert.equal(nativeObservationSignature({ ...base, player: { ...base.player, fireTicks: 160, exits: EXITS } }), signature);
});

test('the lava and fire strategy topic is on demand', () => {
	assert.ok(STRATEGY_REFERENCE_TOPICS.includes('hazards'));
	const { reference } = minecraftStrategyReference({ topic: 'hazards' });
	assert.match(reference, /15 s/);
	assert.match(reference, /armour does not reduce/);
	assert.match(reference, /Water or rain ends burning/);
	assert.match(reference, /LAVA_BEHIND/);
});

test('mine accepts acceptLavaRisk without growing its schema', () => {
	const call = normalizeMinecraftToolCall('mine', { x: 1, y: 70, z: 0, expectedBlockId: 'minecraft:netherrack', acceptLavaRisk: true });
	assert.equal(call.arguments.acceptLavaRisk, true);
	assert.equal(normalizeMinecraftToolCall('mine', { x: 1, y: 70, z: 0, expectedBlockId: 'minecraft:netherrack' }).arguments.acceptLavaRisk, undefined);
	assert.throws(() => validateAction({ type: 'break_block', x: 1, y: 70, z: 0, expectedBlockId: 'minecraft:netherrack', timeoutMs: 15_000, acceptLavaRisk: 'yes' }));
	const mine = MINECRAFT_DYNAMIC_TOOLS.find((tool) => tool.name === 'mine');
	// Measured on main c6327e81: 1,090 bytes. The new field is paid for by trimming the description.
	assert.ok(Buffer.byteLength(JSON.stringify(mine)) <= 1_090, 'mine schema bytes must not grow');
});

function hazardPlanner(registry, { holdToolInFirstTurn = false } = {}) {
	const planner = new FakePlanner(registry);
	planner.steers = [];
	planner.steerNativeTurn = async (request) => { planner.steers.push(request); };
	const turns = [];
	planner.requestNativeTurn = (request) => {
		planner.requests.push(request);
		let reject;
		const promise = new Promise((resolve, rejectTurn) => { reject = rejectTurn; turns.push({ resolve, reject }); });
		if (holdToolInFirstTurn && planner.requests.length === 1) {
			void request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId: 'call-1',
				tool: normalizeMinecraftToolCall('wait', { durationMs: 10_000 }) }).catch(() => {});
		}
		return promise;
	};
	planner.interrupt = async (agentId) => {
		planner.interruptions.push(agentId);
		turns.at(-1)?.reject(Object.assign(new Error('Claude turn was interrupted'), { code: 'STALE_PLAN' }));
	};
	planner.finishAll = () => { for (const turn of turns) turn.resolve({ status: 'completed', toolCalls: 0 }); };
	return planner;
}

async function launch(options) {
	const registry = new AgentRegistry();
	const planner = hazardPlanner(registry, options);
	const traces = [];
	const run = await start({ registry, planner, config: NATIVE_CONFIG, controlNow: options?.fixedClock === true ? () => 1000 : undefined,
		traceWriter: { write(event, details) { traces.push({ event, ...details }); } } });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Find a fortress.', goalSpec: immutableGoalSpec('Find a fortress.') } });
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: options?.initialLava
		? { x: 0, y: 66, z: 0, inLava: true, hazard: 'lava', fire: true, fireTicks: 300, exits: EXITS } : { x: 0, y: 70, z: 0 } } } });
	await eventually(() => planner.requests.length === 1);
	await new Promise((resolve) => setTimeout(resolve, 5));
	return { registry, planner, traces, run };
}

const lava = (eventSequence) => ({ agentId: 'agent-a', payload: { goalRevision: 1, eventSequence, attention: true, changedFacts: ['player.inLava'],
	observation: { player: { x: 0, y: 66, z: 0, health: 14, fire: true, inLava: true, hazard: 'lava', fireTicks: 300, exits: EXITS } } } });
const dry = (eventSequence) => ({ agentId: 'agent-a', payload: { goalRevision: 1, eventSequence, observation: { player: { x: 0, y: 66, z: 2, inLava: false } } } });

// Whole-stack review b1: an older folded hit must not overwrite the later contact on reissue.
test('folded arrow hit then lava contact: reissued turn shows the latest lava facts', async () => {
	const { planner, traces, run } = await launch({ fixedClock: true });
	try {
		const hit = (eventSequence, health) => ({ agentId: 'agent-a', payload: { goalRevision: 1, eventSequence, attention: true, trigger: 'damage',
			observation: { player: { x: 0, y: 70, z: 0, health, inLava: false } } } });
		run.bridge.emit('observation', hit(2, 18));
		await eventually(() => planner.steers.length === 1);
		run.bridge.emit('observation', hit(3, 16));
		await eventually(() => traces.some(({ event }) => event === 'native_turn_steer_coalesced'));
		run.bridge.emit('observation', { ...lava(4), payload: { ...lava(4).payload, trigger: 'damage',
			observation: { player: { ...lava(4).payload.observation.player, health: 12 } } } });
		await eventually(() => planner.requests.length === 2);
		const input = planner.requests[1].input;
		const reissued = payloadOf(input);
		assert.ok(input.startsWith(`${compactEventInstruction(HAZARD_CONTACT_INSTRUCTION)}\n`));
		assert.equal(reissued.hud.inLava, true);
		assert.equal(reissued.hud.health, '12/20');
		assert.deepEqual(reissued.observation.player.exits, EXITS);
		assert.equal(reissued.dangerSinceLastUpdate.foldedEvents, 1);
		assert.equal(planner.interruptions.length, 1);
		assert.equal(traces.filter(({ event }) => event === 'native_turn_hazard_reissue').length, 1);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

test('lava contact during a model call reissues the turn with the event, once per contact', async () => {
	const { planner, traces, run } = await launch();
	try {
		run.bridge.emit('observation', lava(2));
		await eventually(() => planner.requests.length === 2);
		assert.equal(planner.interruptions.length, 1);
		assert.equal(planner.steers.length, 0, 'the event goes into the reissued turn, not a steer the old call would hold');
		const reissued = payloadOf(planner.requests[1].input);
		assert.ok(['lava', 'damage'].includes(reissued.trigger));
		assert.equal(reissued.hud.inLava, true);
		assert.deepEqual(reissued.observation.player.exits, EXITS);
		assert.equal(reissued.healing.burn.remaining, 'not_observed', 'burn facts ride damage events while burning');
		const trace = traces.find(({ event }) => event === 'native_turn_hazard_reissue');
		assert.ok(['lava', 'damage'].includes(trace.trigger));
		assert.ok(Number.isFinite(trace.callAgeMs));
		assert.equal(trace.deliveredContact, 0, 'the cancelled call had received no contact');
		assert.ok(trace.contact > 0);
		// Still in the same contact: later lava events steer the reissued call instead of cancelling it again.
		run.bridge.emit('observation', lava(3));
		await eventually(() => planner.steers.length === 1);
		assert.equal(planner.interruptions.length, 1);
		assert.equal(planner.requests.length, 2);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

test('lava contact while a tool runs is steered with that tool, never reissued', async () => {
	const { planner, traces, run } = await launch({ holdToolInFirstTurn: true });
	try {
		await eventually(() => run.bridge.sent.some(({ type }) => type === 'action_command'));
		run.bridge.emit('observation', lava(2));
		await eventually(() => planner.steers.length === 1);
		assert.equal(planner.interruptions.length, 0);
		assert.equal(planner.requests.length, 1);
		assert.equal(traces.some(({ event }) => event === 'native_turn_hazard_reissue'), false);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

// Review r1 P3-1 fixture: with a fixed control clock the turn starts with lava and exits already in its input.
test('a call whose input already names the lava contact is steered, never cancelled', async () => {
	const { planner, traces, run } = await launch({ initialLava: true, fixedClock: true });
	try {
		assert.equal(payloadOf(planner.requests[0].input).hud.inLava, true);
		run.bridge.emit('observation', lava(2));
		await eventually(() => planner.steers.length === 1);
		assert.equal(planner.interruptions.length, 0);
		assert.equal(planner.requests.length, 1);
		assert.equal(traces.some(({ event }) => event === 'native_turn_hazard_reissue'), false);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

// Review r1 P2-2 fixture: leaving and re-entering a pool three times used to cancel three generations.
test('stepping in and out of a pool while escaping cancels one generation, then steers', async () => {
	const { planner, run } = await launch();
	try {
		run.bridge.emit('observation', lava(2));
		await eventually(() => planner.requests.length === 2);
		for (let index = 0; index < 2; index++) {
			run.bridge.emit('observation', dry(3 + index * 2));
			await new Promise((resolve) => setTimeout(resolve, 5));
			run.bridge.emit('observation', lava(4 + index * 2));
			await eventually(() => planner.steers.length === index + 1);
		}
		assert.equal(planner.interruptions.length, 1);
		assert.equal(planner.requests.length, 2);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

test('magma damage during a model call steers and never cancels', async () => {
	const { planner, run } = await launch();
	try {
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 2, attention: true, trigger: 'damage',
			observation: { player: { x: 0, y: 66, z: 0, health: 15, inLava: false, fire: false, hazard: 'hot_floor', hurtBy: 'hot_floor', exits: EXITS } } } });
		await eventually(() => planner.steers.length === 1);
		assert.equal(planner.interruptions.length, 0);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

// Integration with q-danger: a lava hit folded while a tool ran is flushed when the model asks for its next tool, so it
// rides on that tool's result. Cancelling there would throw away a call that already reached a tool boundary.
test('a folded lava hit flushed at a tool boundary steers and never cancels', async () => {
	const { planner, traces, run } = await launch({ holdToolInFirstTurn: true });
	try {
		await eventually(() => run.bridge.sent.some(({ type }) => type === 'action_command'));
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 2, attention: true, trigger: 'damage',
			observation: { player: { x: 0, y: 70, z: 0, health: 16, inLava: false } } } });
		await eventually(() => planner.steers.length === 1);
		run.bridge.emit('observation', { ...lava(3), payload: { ...lava(3).payload, trigger: 'damage', observation: { player: { ...lava(3).payload.observation.player, health: 15.5 } } } });
		await eventually(() => planner.steers.length === 2);
		run.bridge.emit('observation', { ...lava(4), payload: { ...lava(4).payload, trigger: 'damage', observation: { player: { ...lava(4).payload.observation.player, health: 15 } } } });
		await eventually(() => traces.some(({ event }) => event === 'native_turn_steer_coalesced'));
		const command = run.bridge.sent.find(({ type }) => type === 'action_command');
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state: 'SUCCEEDED',
			executionStarted: true, eventSequence: 5 } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		planner.requests[0].onProgress({ phase: 'tool_queued', toolName: 'look' });
		await eventually(() => planner.steers.length === 3);
		assert.equal(planner.interruptions.length, 0);
		assert.equal(traces.some(({ event }) => event === 'native_turn_hazard_reissue'), false);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

// Review r2 P2-2: the contact can reach the turn as a tool result first, or only as one after the body left the lava.
for (const observedFirst of [true, false]) {
	test(`an IN_LAVA tool result makes the turn aware, observed first: ${observedFirst}`, async () => {
		const { planner, run } = await launch({ holdToolInFirstTurn: true });
		try {
			await eventually(() => run.bridge.sent.some((message) => message.type === 'action_command'));
			const command = run.bridge.sent.find((message) => message.type === 'action_command');
			if (observedFirst) {
				run.bridge.emit('observation', lava(2));
				await eventually(() => planner.steers.length === 1);
			}
			run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state: 'FAILED',
				reasonCode: 'IN_LAVA', message: 'The body entered lava; this action stopped.', executionStarted: true, eventSequence: 3 } });
			await new Promise((resolve) => setTimeout(resolve, 30));
			run.bridge.emit('observation', dry(4));
			await new Promise((resolve) => setTimeout(resolve, 10));
			run.bridge.emit('observation', lava(5));
			await eventually(() => planner.steers.length + planner.interruptions.length >= (observedFirst ? 2 : 1));
			assert.equal(planner.interruptions.length, 0, 'the turn received the contact in its tool result');
		} finally {
			planner.finishAll();
			await run.coordinator.stop();
		}
	});
}

// d24, q-km92y2 (Sol, 419cfd23): player.lavaFlow named the flow 2.95 s before contact, classified as ordinary attention
// while the model sat in a 4.5 s call; the contact reissue came with 16 HP left and 2.5 s to live.
const FLOW = { from: '-11,-51,97', at: '-9,-51,97', inS: 3 };
const flowing = (eventSequence, lavaFlow = FLOW) => ({ agentId: 'agent-a', payload: { goalRevision: 1, eventSequence, attention: true, changedFacts: ['blocks.-11,-51,97'],
	observation: { player: { x: -8.3, y: -52, z: 97.5, health: 20, inLava: false, lavaFlow } } } });

test('a seen lava flow due at the body within 4 s is an urgent wake, once per body cell it heads for', () => {
	const player = { inLava: false, lavaFlow: FLOW };
	assert.deepEqual(imminentLavaFlow(player), { from: [-11, -51, 97], at: [-9, -51, 97], inS: 3 });
	assert.equal(imminentLavaFlow({ lavaFlow: { ...FLOW, inS: 5 } }), null, 'further off than a reply needs');
	assert.equal(imminentLavaFlow({ inLava: true, lavaFlow: FLOW }), null, 'contact has its own wake');
	assert.equal(imminentLavaFlow({ lavaFlow: FLOW, effects: [{ effectId: 'minecraft:fire_resistance' }] }), null);
	assert.equal(imminentLavaFlow({ lavaFlow: { from: 'x', at: '-9,-51,97', inS: 1 } }), null);
	const payload = { attention: true, changedFacts: ['blocks.-11,-51,97'] };
	assert.deepEqual(classifyObservationTrigger(payload, { player }, { previousPlayer: {} }), { attention: true, priority: 'urgent', trigger: LAVA_FLOW_TRIGGER });
	assert.equal(classifyObservationTrigger(payload, { player: { ...player, lavaFlow: { ...FLOW, from: '-10,-51,97', inS: 1.5 } } }, { previousPlayer: player }).priority, 'ordinary',
		'without per-agent state, a flow the previous sample showed is not news');
	assert.equal(classifyObservationTrigger(payload, { player }, { previousPlayer: player, lavaFlowDue: true }).trigger, LAVA_FLOW_TRIGGER);
	assert.equal(classifyObservationTrigger(payload, { player }, { previousPlayer: {}, lavaFlowDue: false }).priority, 'ordinary');
	assert.equal(classifyObservationTrigger(payload, { player: { inLava: true, lavaFlow: FLOW } }, { previousPlayer: player, lavaFlowDue: true }).trigger, 'lava');
	// A body stepping in and out of the flow's path wakes once per 10 s, however often the fact flickers.
	const state = {};
	assert.deepEqual([0, 500, 1_000, 9_900, 10_000, 12_000].map((at) => lavaFlowWakeDue(state, at === 500 ? {} : player, at)), [true, false, false, false, true, false]);
	assert.equal(isHazardContactRequest({ priority: 'urgent', trigger: LAVA_FLOW_TRIGGER, nativeEvent: { trigger: LAVA_FLOW_TRIGGER, observation: { player } } }), true);
	assert.equal(nativeSteerInterruption({ nativeEvent: { trigger: LAVA_FLOW_TRIGGER, observation: { player } } }), 'danger');
	assert.ok(SURVIVAL_TRIGGERS.has(LAVA_FLOW_TRIGGER), 'a running program pauses for it like other survival danger');
});

test('the flow line names where the lava comes from, the cell, when, and where to step or dam', () => {
	const line = lavaFlowLine({ player: { lavaFlow: FLOW }, position: { x: -8.3, y: -52, z: 97.48 }, blocks: [] });
	assert.equal(line, 'Live Minecraft event: seen lava from -11,-51,97 reaches your cell -9,-51,97 in ~3s; lava kills ~2.5 s after contact. '
		+ 'Before then: step out of its path to -8,-52,97, dam its inflow -10,-51,97 with a block, or arm lava_flowing -> leave_lava/place_block, faster than a reply.');
	assert.ok(Buffer.byteLength(line) <= 300);
	assert.match(lavaFlowLine({ player: { lavaFlow: FLOW }, position: { y: -52 }, blocks: [{ blockId: 'minecraft:lava', x: -8, y: -53, z: 97 }] }),
		/step out of its path, dam its inflow -10,-51,97/, 'no step cell over seen lava');
	assert.match(lavaFlowLine({ player: { lavaFlow: { from: '-9,-50,97', at: '-9,-51,97', inS: 1 } } }), /step out from under it, dam its inflow -9,-50,97/);
	assert.equal(lavaFlowLine({ player: { lavaFlow: { ...FLOW, inS: 6 } } }), null);
});

test('a flow wake during a model call reissues the turn with the flow line; the contact after it reissues again', async () => {
	const { planner, traces, run } = await launch();
	try {
		run.bridge.emit('observation', flowing(2));
		await eventually(() => planner.requests.length === 2);
		assert.equal(planner.interruptions.length, 1, 'the call planning without the flow is cancelled, like a contact');
		const input = planner.requests[1].input;
		assert.match(input, /seen lava from -11,-51,97 reaches your cell -9,-51,97 in ~3s/);
		assert.equal(payloadOf(input).trigger, LAVA_FLOW_TRIGGER);
		assert.equal(traces.filter(({ event }) => event === 'native_turn_hazard_reissue').length, 1);
		// The same flow advancing toward the same cell steers nothing new and cancels nothing.
		run.bridge.emit('observation', flowing(3, { ...FLOW, from: '-10,-51,97', inS: 1.5 }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(planner.interruptions.length, 1);
		// Contact is a new episode: the turn knew only the flow, so it is reissued with the contact.
		run.bridge.emit('observation', lava(4));
		await eventually(() => planner.requests.length === 3);
		assert.equal(planner.interruptions.length, 2);
		assert.equal(payloadOf(planner.requests[2].input).hud.inLava, true);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});
