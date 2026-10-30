import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { survivalFactKeys } from '../src/dynamic-main.mjs';
import { FakePlanner, eventually, immutableGoalSpec, record, start } from './fixtures/dynamic-main-fixture.mjs';

const config = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools',
	launchProfile: { agentId: 'coordinator', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'priority' } } };

async function launch(t, { provider = 'claude', holdTool = false, initialDanger = false, initialWire = {}, callAgeMs = 2_000 } = {}) {
	let now = 0;
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), turns = [], traces = [];
	planner.steers = [];
	planner.steerNativeTurn = async request => { planner.steers.push(request); if (typeof request.input === 'function') await request.input(); };
	planner.requestNativeTurn = request => {
		planner.requests.push(request);
		if (holdTool && planner.requests.length === 1) void request.executeTool({ agentId: 'agent-a', goalRevision: 1,
			turnId: 'turn-1', callId: 'body', tool: normalizeMinecraftToolCall('wait', { durationMs: 10_000 }) }).catch(() => {});
		return new Promise((resolve, reject) => turns.push({ resolve, reject }));
	};
	planner.interrupt = async agentId => {
		planner.interruptions.push(agentId);
		turns.at(-1).reject(Object.assign(new Error('interrupted'), { code: 'STALE_PLAN' }));
	};
	const run = await start({ registry, planner, config, initialRegistry: [{ ...record(), provider, model: provider === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol' }],
		controlNow: () => now, traceWriter: { write: (event, details) => traces.push({ event, ...details }) } });
	t.after(async () => { for (const turn of turns) turn.resolve({ toolCalls: 0 }); await run.coordinator.stop(); });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Get food.', goalSpec: immutableGoalSpec('Get food.') } });
	const observe = (eventSequence, changedFacts = [], player = {}, wire = {}) => run.bridge.emit('observation', { agentId: 'agent-a',
		payload: { ready: true, position: { x: 0, y: 64, z: 0 }, view: { yaw: 0, pitch: 0 },
			inventory: { items: [] }, entities: [], blocks: [], world: { dimension: 'minecraft:overworld', gameTime: 1, dayTime: 1, raining: false, thundering: false },
			goalRevision: 1, eventSequence, observedAtEpochMs: eventSequence, attention: changedFacts.length > 0, changedFacts,
			player: { health: 20, maxHealth: 20, air: 300, maxAir: 300, foodLevel: 20, onGround: true, ...player }, ...wire } });
	observe(1, initialDanger ? ['player.air'] : [], initialDanger ? { air: 150 } : {}, initialWire);
	await eventually(() => planner.requests.length === 1);
	now += callAgeMs;
	return { run, planner, traces, observe, turns, advance: ms => { now += ms; } };
}

for (const [name, facts, player] of [
	['air warning', ['player.air'], { air: 150 }],
	['creeper threat', ['threats.creeper.swelling'], {}],
	['first damage', ['player.health'], { health: 18 }],
]) test(`Claude receives ${name} in a replacement call before any tool boundary`, async t => {
	const { planner, traces, observe } = await launch(t);
	observe(2, facts, player);
	await eventually(() => planner.requests.length === 2);
	assert.equal(planner.interruptions.length, 1);
	assert.equal(planner.steers.length, 0);
	const input = planner.requests[1].input;
	const event = JSON.parse(input.slice(input.indexOf('\n') + 1));
	assert.ok(['suffocation', 'threat', 'damage'].includes(event.trigger));
	if (player.air !== undefined) assert.match(input, /air/);
	if (player.health !== undefined) assert.equal(event.hud.health, '18/20');
	assert.equal(traces.filter(x => x.event === 'native_turn_survival_reissue' && x.phase === 'requested').length, 1);
	observe(3, facts, player.health === undefined ? player : { health: 16 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 1, 'a danger-aware response is allowed to finish');
});

test('Codex keeps its immediate steer path', async t => {
	const { planner, observe } = await launch(t, { provider: 'codex' });
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('a Claude call already started with danger is steered without restart', async t => {
	const { planner, observe } = await launch(t, { initialDanger: true });
	observe(2, ['player.air'], { air: 60 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('danger while a tool runs uses the tool interruption path', async t => {
	const { planner, run, observe } = await launch(t, { holdTool: true });
	await eventually(() => run.bridge.sent.some(x => x.type === 'action_command'));
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('ordinary sightings do not cancel a Claude call', async t => {
	const { planner, observe } = await launch(t);
	observe(2, ['player.foodLevel']);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(planner.interruptions.length, 0);
	assert.equal(planner.requests.length, 1);
});

test('a superseded Claude call cannot dispatch a late routine action', async t => {
	const { planner, run, observe } = await launch(t);
	const unaware = planner.requests[0];
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => planner.requests.length === 2);
	const result = await unaware.executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'late',
		tool: normalizeMinecraftToolCall('wait', { durationMs: 10_000 }) });
	assert.equal(result.reasonCode, 'STALE_PLAN');
	assert.equal(result.executed, false);
	assert.equal(run.bridge.sent.some(x => x.type === 'action_command'), false);
});

const threat = id => ({ uuid: id, type: 'minecraft:creeper', signals: ['swelling'], swelling: true, distance: 4, bearing: 0, targeting: true, lineOfSight: true });
const threatWire = id => ({ threats: { entries: [threat(id)] } });

test('a threat present in a non-urgent wake input is known before its urgent edge', async t => {
	const { planner, observe } = await launch(t, { initialWire: { ...threatWire('creeper-1'), trigger: 'resource_discovery' } });
	observe(2, ['threats.creeper.swelling'], {}, threatWire('creeper-1'));
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('seeing one entity does not establish awareness of a different entity of the same type', async t => {
	const { planner, observe } = await launch(t, { initialWire: threatWire('creeper-1') });
	observe(2, ['threats.creeper.swelling'], {}, threatWire('creeper-2'));
	await eventually(() => planner.requests.length === 2);
});

test('explicit drowning starts an urgent turn that already establishes survival awareness', async t => {
	const { planner, observe } = await launch(t, { initialWire: { trigger: 'drowning' } });
	assert.equal(planner.requests[0].priority, 'urgent');
	observe(2, ['threats.creeper.swelling'], {}, threatWire('creeper-1'));
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('known entities unrelated to the warning do not suppress a survival restart', async t => {
	const entities = [{ uuid: '00000000-0000-4000-8000-000000000001', type: 'minecraft:cow', distance: 3, position: { x: 3, y: 64, z: 0 } }];
	const { planner, observe } = await launch(t, { initialWire: { entities } });
	observe(2, ['threats.creeper.swelling'], {}, { ...threatWire('creeper-2'), entities });
	await eventually(() => planner.requests.length === 2);
});

test('an entity already visible in world facts is known when its threat edge arrives', async t => {
	const id = '00000000-0000-4000-8000-000000000002';
	const entities = [{ uuid: id, type: 'minecraft:creeper', distance: 3, position: { x: 3, y: 64, z: 0 } }];
	const { planner, observe } = await launch(t, { initialWire: { entities } });
	observe(2, ['threats.creeper.swelling'], {}, { ...threatWire(id), entities });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('a non-urgent projectile steer carrying the threat establishes awareness', async t => {
	const { planner, observe } = await launch(t);
	observe(2, [], {}, { ...threatWire('creeper-1'), trigger: 'projectile' });
	await eventually(() => planner.steers.length === 1);
	observe(3, ['threats.creeper.swelling'], {}, threatWire('creeper-1'));
	await eventually(() => planner.steers.length === 2);
	assert.equal(planner.interruptions.length, 0);
});

test('a projectile warning in the input establishes awareness of that projectile before damage', async t => {
	const incomingProjectiles = [{ uuid: '00000000-0000-4000-8000-000000000003', type: 'minecraft:arrow' }];
	const { planner, observe } = await launch(t, { initialWire: { trigger: 'projectile', incomingProjectiles } });
	observe(2, ['player.health'], { health: 18 }, { incomingProjectiles });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('observe results carrying a threat establish awareness', async t => {
	const { planner, run, observe, advance } = await launch(t);
	observe(2, [], {}, threatWire('creeper-1'));
	await eventually(() => run.bridge.latestSequences.get('agent-a') === 2);
	const result = await planner.requests[0].executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'look', tool: { kind: 'observe' } });
	assert.equal(result.observation.player.threats[0].stableId, 'creeper-1');
	advance(2_000);
	observe(4, ['threats.creeper.swelling'], {}, threatWire('creeper-1'));
	await eventually(() => planner.steers.length >= 1);
	assert.equal(planner.interruptions.length, 0);
});

test('calls younger than 1.5 seconds receive a steer without restarting', async t => {
	const { planner, observe } = await launch(t, { callAgeMs: 1_499 });
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('the restart cooldown persists across ordinary turns and expires after 20 seconds', async t => {
	const { planner, observe, turns, advance } = await launch(t);
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => planner.requests.length === 2);
	observe(3, ['player.foodLevel']);
	turns[1].resolve({ toolCalls: 0 });
	await eventually(() => planner.requests.length === 3);
	advance(2_000);
	observe(4, ['threats.creeper.swelling'], {}, threatWire('creeper-1'));
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 1);
	observe(5, ['player.foodLevel']);
	turns[2].resolve({ toolCalls: 0 });
	await eventually(() => planner.requests.length === 4);
	advance(18_000);
	observe(6, ['player.air'], { air: 150 });
	await eventually(() => planner.requests.length === 5);
	assert.equal(planner.interruptions.length, 2);
});

test('a rejected interrupt clears the obsolete-turn gate and delivers danger as a steer', async t => {
	const { planner, observe, traces, run } = await launch(t);
	planner.interrupt = async () => { throw Object.assign(new Error('not sent'), { code: 'TEST_INTERRUPT_FAILED' }); };
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => traces.some(row => row.phase === 'interrupt_failed'));
	await eventually(() => planner.steers.length === 1);
	const pending = planner.requests[0].executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'routine-after-failure',
		tool: normalizeMinecraftToolCall('wait', { durationMs: 10 }) });
	await eventually(() => run.bridge.sent.some(row => row.type === 'action_command'));
	const action = run.bridge.sent.find(row => row.type === 'action_command');
	run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: action.payload.actionId,
		state: 'SUCCEEDED', reasonCode: 'DONE', eventSequence: 3 } });
	assert.notEqual((await pending).reasonCode, 'STALE_PLAN');
});

test('observe and defensive actions remain available while the interrupt drains', async t => {
	const { planner, observe, run, traces } = await launch(t);
	planner.interrupt = async () => new Promise(() => {});
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => traces.some(row => row.phase === 'requested'));
	assert.equal(planner.requests.length, 1);
	const request = planner.requests[0];
	const result = await request.executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'observe-draining', tool: { kind: 'observe' } });
	assert.notEqual(result.reasonCode, 'STALE_PLAN');
	for (const [name, args] of [['flee_from', { targetId: '00000000-0000-4000-8000-000000000001', distance: 8, timeoutMs: 100 }], ['fight_target', { targetId: '00000000-0000-4000-8000-000000000001', timeoutMs: 100 }],
		['block_with_shield', { durationMs: 100 }], ['use_item', { hand: 'main', durationMs: 100 }]]) {
		const pending = request.executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: name, tool: normalizeMinecraftToolCall('act', { actionType: name, arguments: args }) });
		await eventually(() => run.bridge.sent.some(row => row.type === 'action_command' && row.payload.actionType === name));
		const action = run.bridge.sent.findLast(row => row.type === 'action_command');
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: action.payload.actionId,
			state: 'FAILED', reasonCode: 'TARGET_NOT_FOUND', eventSequence: 10 + run.bridge.sent.length } });
		assert.notEqual((await pending).reasonCode, 'STALE_PLAN');
	}
});

for (const [name, changedFacts, player] of [
	['air', ['player.air'], { air: 150 }],
	['threat', ['threats.creeper.swelling'], {}],
]) test(`Claude transport receives fresh ${name} input without emitting an unrelated tool`, async () => {
	const { harness, profile } = await import('./fixtures/claude-service-fixture.mjs');
	const { coordinatorWithProviderAgent } = await import('./fixtures/hazard-provider-fixture.mjs');
	let users = 0, now = 0, run;
	const cli = await harness({ onUser() { users += 1; } });
	try {
		const agent = await cli.service.createAgent(profile({ agentId: 'agent-a' }), { controlProtocol: 'native_tools' });
		await agent.setGoalRevision(1);
		run = await coordinatorWithProviderAgent(agent, 'claude', { controlNow: () => now });
		await eventually(() => users === 1);
		now = 2_000;
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 2, attention: true,
			changedFacts, observation: { player: { x: 0, y: 64, z: 0, ...player } } } });
		await eventually(() => users === 2);
		assert.equal(run.planner.interruptions.length, 1);
		assert.equal(run.planner.steers.length, 0);
		assert.equal(run.bridge.sent.some(x => x.type === 'action_command'), false);
		assert.match(run.planner.requests[1].input, name === 'air' ? /"trigger":"suffocation"/ : /"trigger":"threat"/);
		assert.ok(cli.children[0].lines.some(x => x.type === 'control_request' && x.request?.subtype === 'interrupt'));
	} finally {
		if (run) await run.coordinator.stop();
		await cli.close();
	}
});

for (const ignoreInterrupt of [false, true]) test(`survival reissue trace records cache tokens, interrupt latency and timeout (${ignoreInterrupt})`, async () => {
	const { harness, profile } = await import('./fixtures/claude-service-fixture.mjs');
	const { coordinatorWithProviderAgent } = await import('./fixtures/hazard-provider-fixture.mjs');
	let users = 0, now = 0, run;
	const traces = [];
	const cli = await harness({ ignoreInterrupt, onUser(child) {
		users += 1;
		child.emitLine({ type: 'stream_event', event: { type: 'message_start', message: { id: `call-${users}`,
			usage: { input_tokens: 2, cache_read_input_tokens: 14_938, cache_creation_input_tokens: 1_275, output_tokens: 3 } } } });
	} }, { interruptTimeoutMs: 50 });
	try {
		const agent = await cli.service.createAgent(profile({ agentId: 'agent-a' }), { controlProtocol: 'native_tools' });
		await agent.setGoalRevision(1);
		run = await coordinatorWithProviderAgent(agent, 'claude', { controlNow: () => now,
			traceWriter: { write: (event, details) => traces.push({ event, ...details }) } });
		await eventually(() => users === 1);
		await new Promise(resolve => setImmediate(resolve));
		now = 2_000;
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 2, attention: true,
			changedFacts: ['player.air'], observation: { player: { x: 0, y: 64, z: 0, air: 150 } } } });
		await eventually(() => traces.some(row => row.event === 'native_turn_survival_reissue' && row.phase === 'interrupted'));
		const metrics = traces.find(row => row.event === 'native_turn_survival_reissue' && row.phase === 'interrupted');
		assert.equal(metrics.cacheReadInputTokens, 14_938);
		assert.equal(metrics.cacheCreationInputTokens, 1_275);
		assert.equal(metrics.interruptTimedOut, ignoreInterrupt);
		assert.equal(metrics.interruptAcknowledged, !ignoreInterrupt);
		assert.ok(metrics.interruptLatencyMs >= (ignoreInterrupt ? 40 : 0));
		await eventually(() => users === 2);
	} finally {
		if (run) await run.coordinator.stop();
		await cli.close();
	}
});


test('deep-water air edge wakes urgently with breathable target and dispatches only the model-chosen swim', async t => {
	const { planner, run, observe } = await launch(t);
	const breathable = { x: 0.5, y: 63, z: 0.5, distance: 12, direction: 'up', seconds: 6 };
	observe(2, ['player.air'], { underWater: true, inWater: true, onGround: false, air: 219,
		airSecondsLeft: 11, waterMotion: 'sinking', waterAbove: 'open_water', breathable });
	await eventually(() => planner.requests.length === 2);
	const request = planner.requests[1];
	assert.equal(request.priority, 'urgent');
	const event = JSON.parse(request.input.slice(request.input.indexOf('\n') + 1));
	assert.equal(event.trigger, 'drowning');
	assert.equal(event.hud.airSecondsLeft, 11);
	assert.equal(event.hud.waterMotion, 'sinking');
	assert.equal(event.hud.waterAbove, 'open_water');
	assert.deepEqual(event.hud.breathable, breathable);
	assert.equal(run.bridge.sent.some(row => row.type === 'action_command'), false, 'facts alone never surface the body');
	const pending = request.executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-2', callId: 'surface',
		tool: normalizeMinecraftToolCall('moveTo', { x: breathable.x, y: breathable.y, z: breathable.z, tolerance: 0.5, sprint: true, timeoutMs: 8000 }) });
	await eventually(() => run.bridge.sent.some(row => row.type === 'action_command'));
	const action = run.bridge.sent.find(row => row.type === 'action_command');
	assert.equal(action.payload.actionType, 'navigate_to');
	assert.equal(action.payload.arguments.y, breathable.y);
	run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: action.payload.actionId,
		state: 'SUCCEEDED', reasonCode: 'ARRIVED', eventSequence: 3 } });
	assert.equal((await pending).state, 'SUCCEEDED');
});

test('a Claude turn that knew an earlier drowning episode is reissued for a new one after danger clears', async t => {
	const { planner, observe, advance, traces } = await launch(t, { initialDanger: true });
	observe(2, [], {});
	await new Promise(resolve => setTimeout(resolve, 20));
	advance(6_000);
	observe(3, [], {});
	await eventually(() => traces.some(row => row.event === 'native_turn_survival_episode_closed'));
	observe(4, ['player.air'], { air: 150 });
	await eventually(() => planner.requests.length === 2);
	assert.equal(planner.interruptions.length, 1);
	assert.equal(planner.steers.length, 0);
});

test('a short break in danger stays one episode and is steered without restart', async t => {
	const { planner, observe, advance, traces } = await launch(t, { initialDanger: true });
	observe(2, [], {});
	advance(2_000);
	observe(3, ['player.air'], { air: 150 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
	assert.equal(traces.some(row => row.event === 'native_turn_survival_episode_closed'), false);
});

test('Codex never restarts a turn for a new survival episode', async t => {
	const { planner, observe, advance, traces } = await launch(t, { provider: 'codex', initialDanger: true });
	observe(2, [], {});
	advance(6_000);
	observe(3, [], {});
	observe(4, ['player.air'], { air: 150 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
	assert.equal(traces.some(row => row.event === 'native_turn_survival_episode_closed'), false);
});

for (const provider of ['claude', 'codex']) test(`a ${provider} danger steer queued mid-call ${provider === 'claude' ? 'cuts' : 'does not cut'} the next blocking tool short`, async t => {
	const { planner, observe, run } = await launch(t, { provider, initialDanger: true });
	let deliver;
	planner.steerNativeTurn = request => {
		planner.steers.push(request);
		request.onInterrupt?.();
		return new Promise(resolve => { deliver = resolve; });
	};
	observe(2, ['player.air'], { air: 90 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
	// The model, still generating without the steer, now issues a long body action.
	const pending = planner.requests[0].executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'blind-walk',
		tool: normalizeMinecraftToolCall('moveTo', { x: 30, y: 64, z: 30, tolerance: 1, timeoutMs: 30_000 }) });
	await eventually(() => run.bridge.sent.some(row => row.type === 'action_command'));
	const early = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve({ state: 'STILL_BLOCKED' }), 100).unref())]);
	const action = run.bridge.sent.find(row => row.type === 'action_command');
	if (provider === 'claude') {
		assert.equal(early.state, 'RUNNING');
		assert.equal(early.interruptedBy, 'danger');
		assert.equal(run.bridge.sent.some(row => row.type === 'action_cancel'), false, 'the action is not cancelled; the model decides');
	} else assert.equal(early.state, 'STILL_BLOCKED');
	deliver();
	run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: action.payload.actionId,
		state: 'SUCCEEDED', reasonCode: 'ARRIVED', eventSequence: 3 } });
	await pending;
});

test('a delivered Claude danger steer disarms, so the tool the model then chooses runs to completion', async t => {
	const { planner, observe, run } = await launch(t, { initialDanger: true });
	planner.steerNativeTurn = async request => { planner.steers.push(request); request.onInterrupt?.(); if (typeof request.input === 'function') await request.input(); };
	observe(2, ['player.air'], { air: 90 });
	await eventually(() => planner.steers.length === 1);
	await new Promise(resolve => setImmediate(resolve));
	const pending = planner.requests[0].executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'informed-swim',
		tool: normalizeMinecraftToolCall('moveTo', { x: 0, y: 70, z: 0, tolerance: 1, timeoutMs: 30_000 }) });
	await eventually(() => run.bridge.sent.some(row => row.type === 'action_command'));
	const early = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve({ state: 'STILL_BLOCKED' }), 100).unref())]);
	assert.equal(early.state, 'STILL_BLOCKED');
	const action = run.bridge.sent.find(row => row.type === 'action_command');
	run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: action.payload.actionId,
		state: 'SUCCEEDED', reasonCode: 'ARRIVED', eventSequence: 3 } });
	assert.equal((await pending).state, 'SUCCEEDED');
});

test('drowning damage with no attacker is known from the air the turn already saw', async t => {
	const { planner, observe } = await launch(t, { initialDanger: true });
	observe(2, ['player.health'], { air: 0, health: 18 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('damage with no attacker and no known body danger still reissues an unaware Claude call', async t => {
	const { planner, observe } = await launch(t);
	observe(2, ['player.health'], { health: 18 });
	await eventually(() => planner.requests.length === 2);
	assert.equal(planner.interruptions.length, 1);
});

test('a Claude call already streaming a tool call is steered at that tool instead of restarted', async t => {
	const { planner, observe } = await launch(t);
	planner.requests[0].onProgress({ phase: 'tool_streaming' });
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
});

test('a Claude call too young to restart is reissued once it is old enough if the danger has still not reached it', async t => {
	const { planner, observe, advance, traces } = await launch(t, { callAgeMs: 1_000 });
	// Claude rejects a still-pending steer when its turn is interrupted.
	let rejectSteer;
	planner.steerNativeTurn = request => { planner.steers.push(request); return new Promise((_, reject) => { rejectSteer = reject; }); };
	const interrupt = planner.interrupt;
	planner.interrupt = async agentId => { rejectSteer?.(Object.assign(new Error('turn ended'), { code: 'TURN_NOT_ACTIVE' })); return interrupt(agentId); };
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => planner.steers.length === 1);
	assert.equal(planner.interruptions.length, 0);
	advance(600);
	await eventually(() => planner.requests.length === 2);
	assert.equal(planner.interruptions.length, 1);
	assert.equal(traces.filter(row => row.event === 'native_turn_survival_reissue' && row.phase === 'requested').length, 1);
});

test('a young Claude call whose steer was delivered before the recheck is left to finish', async t => {
	const { planner, observe, advance } = await launch(t, { callAgeMs: 1_000 });
	observe(2, ['player.air'], { air: 150 });
	await eventually(() => planner.steers.length === 1);
	advance(600);
	await new Promise(resolve => setTimeout(resolve, 700));
	assert.equal(planner.interruptions.length, 0);
	assert.equal(planner.requests.length, 1);
});

test('a goal start interrupts the no-task danger turn it supersedes', async t => {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), turns = [];
	planner.steerNativeTurn = async request => { if (typeof request.input === 'function') await request.input(); };
	planner.requestNativeTurn = request => { planner.requests.push(request); return new Promise((resolve, reject) => turns.push({ resolve, reject })); };
	planner.interrupt = async agentId => {
		planner.interruptions.push(agentId);
		turns.at(-1).reject(Object.assign(new Error('interrupted'), { code: 'STALE_PLAN' }));
	};
	const run = await start({ registry, planner, config, initialRegistry: [{ ...record(), provider: 'claude', model: 'claude-opus-5-5' }] });
	t.after(async () => { for (const turn of turns) turn.resolve({ toolCalls: 0 }); await run.coordinator.stop(); });
	// Live rooms spawn mobs while the goal is still being translated: the first hit wakes a no-task turn.
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 0, eventSequence: 1, attention: true, changedFacts: ['player.health'],
		observation: { player: { x: 0, y: 64, z: 0, health: 15 } } } });
	await eventually(() => planner.requests.length === 1);
	assert.equal(planner.requests[0].goalRevision, 0);
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Get food.', goalSpec: immutableGoalSpec('Get food.') } });
	await eventually(() => planner.interruptions.length === 1);
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 2, observation: { player: { x: 0, y: 64, z: 0, health: 15 } } } });
	await eventually(() => planner.requests.some(request => request.goalRevision === 1));
});

test('threats listed beside player in a model wake count as seen', () => {
	// Model wakes carry observation.threats (nearest as player.threat); the turn knows those attackers before they hit.
	const keys = survivalFactKeys({ observation: { threats: [{ uuid: 'skeleton-1', type: 'minecraft:skeleton' }], player: { x: 0, threat: { uuid: 'skeleton-2' } }, entities: [] } });
	assert.deepEqual([...keys].sort(), ['entity:skeleton-1', 'entity:skeleton-2']);
});
