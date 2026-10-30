import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentRegistry } from '../src/agent-registry.mjs';
import { detectMovementLoop } from '../src/dynamic-main.mjs';
import { FakePlanner, eventually, start, resolveNativeSteerInput } from './fixtures/dynamic-main-fixture.mjs';

const cells = (...points) => points.map(([x, z]) => `${x},64,${z}`);
const square = [[1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]];
// The body's own ground walk, and the impulse a hit leaves in the sample that reports it (as in the skeleton capture).
const walking = { velocity: { x: 0.1, y: -0.078, z: 0 }, onGround: true };
const impulse = { velocity: { x: 0.3, y: 0.36, z: 0.3 } };

test('a loop is any recent route retraced, whatever its length', () => {
	assert.equal(detectMovementLoop(cells([0, 0], [1, 0], [0, 0], [1, 0])), true, 'back and forth');
	assert.equal(detectMovementLoop(cells([0, 0], [1, 0], [1, 1], [0, 0], [1, 0], [1, 1])), true, 'triangle');
	assert.equal(detectMovementLoop(cells([0, 0], [1, 0], [1, 1], [0, 1], [0, 0], [1, 0], [1, 1], [0, 1])), true, 'square');
	const ring = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
	assert.equal(detectMovementLoop(cells(...ring, ...ring)), true, 'ring around a 3x3 block');
	assert.equal(detectMovementLoop(cells([5, 5], [6, 5], [0, 0], [1, 0], [1, 1], [0, 0], [1, 0], [1, 1])), true, 'older history does not hide a fresh loop');
});

test('travel that does not retrace a route is not a loop', () => {
	assert.equal(detectMovementLoop(cells([0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0])), false, 'straight');
	assert.equal(detectMovementLoop(cells([0, 0], [1, 0], [1, 1], [0, 0], [1, 0])), false, 'one lap is a return, not a loop yet');
	assert.equal(detectMovementLoop(cells([0, 0], [1, 0], [1, 1], [2, 1], [2, 0], [3, 0], [4, 0])), false, 'detour around an obstacle');
	assert.equal(detectMovementLoop(cells([0, 0], [1, 0], [2, 0], [3, 0], [2, 0], [1, 0], [0, 0])), false, 'walking back the way it came');
	assert.equal(detectMovementLoop(cells([0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [3, 2], [3, 3])), false, 'diagonal staircase');
});

async function harness({ rejectLoopOnce = false } = {}) {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const steers = [];
	planner.requestNativeTurn = async request => { planner.requests.push(request); await gate; return { status: 'completed', toolCalls: 0 }; };
	planner.steerNativeTurn = async request => {
		const input = await resolveNativeSteerInput(request);
		const event = JSON.parse(input.slice(input.indexOf('\n') + 1));
		if (rejectLoopOnce && (event.movementLoop === true || event.trigger === 'movement_loop')) {
			rejectLoopOnce = false;
			throw Object.assign(new Error('Rejected test delivery'), { code: 'TURN_STEER_FAILED' });
		}
		steers.push(input);
		return { turnId: 'thinking' };
	};
	const run = await start({ registry, planner, config: {
		bridge: { port: 27710, secret: 's'.repeat(32) },
		codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } },
	} });
	let sequence = 0;
	let lastHealth = 20;
	const flush = async () => { for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve)); };
	const loopRequests = () => run.bridge.sent.filter(message => message.type === 'request_observation').length;
	const observe = async (at, x, z, health = 20, hurtBy = undefined, { velocity, player = {} } = {}) => {
		lastHealth = health;
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: ++sequence, attention: health < 20, observedAtEpochMs: at,
			observation: { ...(velocity === undefined ? {} : { velocity }), player: { x, y: 64, z, health, ...(hurtBy === undefined ? {} : { hurtBy }), ...player },
				items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} } } } });
		await flush();
	};
	// answer: the server answers a request_observation with a fresh observation; emulate it so pending attention can merge.
	const progress = async (at, x, z, { answer = false, ...body } = {}) => {
		const asked = loopRequests();
		run.bridge.emit('action_progress', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: 'walk-1', state: 'RUNNING', progress: 0.5, elapsedMs: 100, observedAtEpochMs: at,
			actionObservation: { observedAtEpochMs: at, position: { x, y: 64, z }, ...body } } });
		await flush();
		if (answer && loopRequests() > asked) await observe(at, x, z, lastHealth, undefined, { velocity: body.velocity });
	};
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Find a fortress.' } });
	await observe(1_000, 0.5, 0.5);
	await eventually(() => planner.requests.length === 1);
	const triggerOf = input => { try { return JSON.parse(input.slice(input.indexOf('\n') + 1)).trigger; } catch { return /movement_loop/.test(input) ? 'movement_loop' : '?'; } };
	return {
		steers, observe, progress, flush, loopRequests,
		triggers: () => steers.map(triggerOf).filter(trigger => trigger !== 'attention'),
		loopSteers: () => steers.filter(input => { const event = JSON.parse(input.slice(input.indexOf('\n') + 1)); return event.trigger === 'movement_loop' || event.movementLoop === true; }).length,
		stop: async () => { release(); await run.coordinator.stop(); },
	};
}

test('walking a square twice wakes the model once with movement_loop', async () => {
	const run = await harness();
	try {
		let at = 1_000;
		for (const [x, z] of [...square, ...square, ...square]) await run.observe(at += 1_000, x, z);
		assert.equal(run.loopSteers(), 1, 'one unresolved loop reports once');
	} finally { await run.stop(); }
});

test('being knocked back and forth between two blocks by hits is not a movement loop', async () => {
	const run = await harness();
	try {
		let at = 1_000;
		for (let hit = 0; hit < 8; hit += 1) {
			const [from, to] = hit % 2 === 0 ? [0.4, 1.6] : [1.6, 0.4];
			// The damage tick still shows the old block; the shove shows in the next sample, as in the skeleton capture.
			await run.observe(at += 2_000, from, 0.5, 17, 'mob_attack by zombie');
			await run.observe(at + 300, to, 0.5, 17, 'mob_attack by zombie');
			await run.observe(at + 1_500, to, 0.5, 20);
		}
		await eventually(() => run.steers.length > 0);
		assert.equal(run.loopSteers(), 0, 'the hits wake the model as damage, not as a loop it walked');
	} finally { await run.stop(); }
});

test('progress positions of a shove taken before the hurt observation arrives are withdrawn', async () => {
	const run = await harness();
	try {
		let at = 1_000;
		for (let hit = 0; hit < 6; hit += 1) {
			const x = hit % 2 === 0 ? 1.6 : 0.4;
			at += 3_000;
			await run.progress(at - 20, x, 0.5);
			await run.observe(at, x, 0.5, 17);
			await run.observe(at + 1_500, x, 0.5, 20);
		}
		assert.equal(run.loopRequests(), 0);
		assert.equal(run.loopSteers(), 0);
	} finally { await run.stop(); }
});

test('a shove that completes a walked route in progress is withdrawn with its queued alert; the damage still wakes', async () => {
	const run = await harness();
	try {
		await run.observe(3_000, 1.5, 0.5);
		await run.observe(5_000, 0.5, 0.5);
		await run.progress(6_980, 1.5, 0.5);
		assert.equal(run.loopRequests(), 1, 'the progress loop asks for an observation');
		await run.observe(7_000, 1.5, 0.5, 18, 'arrow by minecraft:skeleton', impulse);
		await run.observe(8_500, 1.5, 0.5, 18, 'arrow by minecraft:skeleton');
		assert.deepEqual(run.triggers(), ['damage']);
	} finally { await run.stop(); }
});

test('walking a route under hits keeps the walked steps, so the retraced route still reports once', async () => {
	const run = await harness();
	try {
		let at = 1_000;
		let health = 20;
		for (let index = 1; index <= 16; index += 1) {
			const [x, z] = square[index % 4];
			if (index % 2 === 0) await run.observe(at += 1_000, x, z, health -= 0.5, 'arrow by minecraft:skeleton', impulse);
			else await run.progress(at += 1_000, x, z, { ...walking, answer: true });
		}
		assert.equal(run.loopSteers(), 1);
	} finally { await run.stop(); }
});

test('a hit that moves the body to no other cell erases no walked step', async () => {
	const run = await harness();
	try {
		const lap = async (at, hitAt = null) => {
			for (const [index, [x, z]] of square.entries()) {
				await run.progress(at + index * 1_000, x, z, walking);
				if (hitAt === index) await run.observe(at + index * 1_000 + 200, x, z, 19.5, 'arrow by minecraft:skeleton', impulse);
			}
		};
		await lap(2_000, 1);
		assert.equal(run.loopRequests(), 0);
		await lap(6_000);
		assert.equal(run.loopRequests(), 1, 'the second lap closes the loop on its last cell, as it would without the hit');
	} finally { await run.stop(); }
});

test('a loop closed while burning reaches the model in the fire wake', async () => {
	const run = await harness();
	try {
		let at = 1_000;
		for (let index = 0; index < 12; index += 1) {
			const [x, z] = square[index % 4];
			// The start cell is the square's last cell, so the second lap closes the loop on sample 6: the burning one.
			await run.observe(at += 1_000, x, z, 20, undefined, index === 6 ? { player: { fire: true } } : {});
		}
		assert.deepEqual(run.triggers(), ['fire']);
		assert.equal(run.loopSteers(), 1);
	} finally { await run.stop(); }
});

test('a loop walked in lava reaches the model while damage continues', async () => {
	const run = await harness();
	try {
		let at = 1_000;
		// Health falls on every sample of the first two laps, including the one that closes the loop.
		for (let index = 0; index < 8; index += 1) await run.observe(at += 1_000, ...square[index % 4], 20 - (index + 1) * 0.5, 'lava');
		assert.ok(run.triggers().includes('damage'));
		await eventually(() => run.loopSteers() === 1);
		assert.equal(run.loopSteers(), 1, 'the damage wake carries the loop without another wake');
		for (let index = 8; index < 12; index += 1) await run.observe(at += 1_000, ...square[index % 4], 16);
		assert.ok(run.triggers().every(trigger => trigger === 'damage'));
		assert.equal(run.loopSteers(), 1);
	} finally { await run.stop(); }
});

test('danger in the observation a progress loop asked for carries the loop in that wake', async () => {
	const run = await harness();
	try {
		await run.observe(3_000, 1.5, 0.5);
		await run.observe(5_000, 0.5, 0.5);
		await run.progress(6_500, 1.5, 0.5, walking);
		assert.equal(run.loopRequests(), 1);
		await run.observe(7_000, 1.5, 0.5, 18, 'lava');
		await run.observe(8_000, 1.5, 0.5, 18);
		assert.deepEqual(run.triggers(), ['damage']);
		assert.equal(run.loopSteers(), 1);
	} finally { await run.stop(); }
});

test('damage that pushes nobody (lava) does not hide a walked loop, a pushing hit does', async () => {
	for (const [hurtBy, expected] of [['lava', 1], ['arrow by skeleton', 0]]) {
		const run = await harness();
		try {
			await run.observe(1_100, 0.5, 0.5, 18, hurtBy);
			for (const [index, x] of [1.5, 0.5, 1.5].entries()) await run.progress(1_200 + 100 * index, x, 0.5);
			assert.equal(run.loopRequests(), expected, hurtBy);
		} finally { await run.stop(); }
	}
});

test('standing at a block centre while being nudged is not a loop', async () => {
	const run = await harness();
	try {
		let at = 1_000;
		for (let index = 0; index < 8; index += 1) await run.progress(at += 500, index % 2 === 0 ? 0.49 : 0.51, 0.5);
		assert.equal(run.loopRequests(), 0);
	} finally { await run.stop(); }
});


test('ground walking on every hurt observation keeps a loop, including steps in the hit lead', async () => {
	for (const spacing of [1, 2]) {
		const run = await harness();
		try {
			let health = 20;
			for (let index = 0; index < 12; index += 1) {
				if (index % spacing === 0) health -= 0.5;
				await run.observe(2_000 + index * 1_000, ...square[index % 4], health, 'arrow by minecraft:skeleton', { velocity: walking.velocity });
			}
			await run.observe(14_000, ...square[3], health);
			assert.equal(run.loopSteers(), 1, `hits every ${spacing} samples`);
		} finally { await run.stop(); }
	}
});

test('a walked step twenty ms before a hit in the same cell stays in the route', async () => {
	const run = await harness();
	try {
		for (let index = 0; index < 8; index += 1) {
			const at = 2_000 + index * 1_000;
			await run.progress(at - 20, ...square[index % 4], walking);
			await run.observe(at, ...square[index % 4], 20 - (index + 1) * 0.5, 'arrow by minecraft:skeleton', { velocity: walking.velocity });
		}
		await eventually(() => run.loopSteers() === 1);
		assert.equal(run.loopSteers(), 1);
	} finally { await run.stop(); }
});

test('the existing fire wake carries the loop fact with no additional loop wake', async () => {
	const run = await harness();
	try {
		for (let index = 0; index < 12; index += 1) {
			await run.observe(2_000 + index * 1_000, ...square[index % 4], 20, undefined, index === 6 ? { player: { fire: true } } : {});
		}
		const fire = run.steers.map(input => JSON.parse(input.slice(input.indexOf('\n') + 1))).find(event => event.trigger === 'fire');
		assert.equal(fire?.movementLoop, true);
		assert.deepEqual(run.triggers(), ['fire']);
	} finally { await run.stop(); }
});


test('a loop fact remains owed after its fire steer is rejected', async () => {
	const run = await harness({ rejectLoopOnce: true });
	try {
		for (let index = 0; index < 7; index += 1) await run.observe(2_000 + index * 1_000, ...square[index % 4], 20, undefined, index === 6 ? { player: { fire: true } } : {});
		assert.equal(run.loopSteers(), 0, 'the rejected delivery does not acknowledge the loop');
		await run.observe(9_000, ...square[3]);
		await run.observe(10_000, ...square[0]);
		assert.equal(run.loopSteers(), 1, 'the next eligible delivery includes it once');
	} finally { await run.stop(); }
});


test('ground speed during a known airborne shove is its settling drift, not another walked step', async () => {
	const run = await harness();
	try {
		for (let hit = 0; hit < 4; hit += 1) {
			const at = 2_000 + hit * 2_000;
			await run.observe(at, 0.5, 0.5, 18, 'arrow by minecraft:skeleton', impulse);
			await run.observe(at + 500, 1.5, 0.5, 18, 'arrow by minecraft:skeleton', { velocity: walking.velocity });
			await run.observe(at + 1_000, 0.5, 0.5, 20);
		}
		assert.equal(run.loopSteers(), 0);
	} finally { await run.stop(); }
});
