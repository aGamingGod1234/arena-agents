import { compactEventInstruction } from '../src/dynamic-main.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DangerSteerCoalescer } from '../src/danger-steer-coalescer.mjs';
import { BURNING_INSTRUCTION, buildNativeEventInput, burnFacts } from '../src/dynamic-main.mjs';

const request = player => ({ trigger: 'damage', nativeEvent: { event: 'observation', trigger: 'damage', observation: { player } } });

test('leaving contact while still burning folds and flushes the latest body state', () => {
	const coalescer = new DangerSteerCoalescer();
	coalescer.noteDelivered(request({ health: 13, onFire: true, hazard: 'fire', fireTicks: 160 }), 0);
	assert.equal(coalescer.offer(request({ health: 12, onFire: true, hazard: 'fire', fireTicks: 159 }), 100).action, 'fold');
	assert.equal(coalescer.offer(request({ health: 12, onFire: true, fireTicks: 150 }), 200).action, 'fold');
	assert.equal(coalescer.offer(request({ health: 11, onFire: true, fireTicks: 149 }), 300).action, 'fold', 'ordinary burn countdown still folds');
	const flushed = coalescer.flush(2000);
	assert.equal(flushed.nativeEvent.observation.player.fireTicks, 149);
	assert.equal(flushed.nativeEvent.observation.player.hazard, undefined);
});

test('lava reached during an already burning damage turn is new danger, and extinguishing is a new fact', () => {
	const coalescer = new DangerSteerCoalescer();
	coalescer.noteDelivered(request({ health: 18, onFire: true, fireTicks: 100 }), 0);
	assert.equal(coalescer.offer(request({ health: 17, onFire: true, inLava: true, fireTicks: 300 }), 100).action, 'deliver');
	assert.equal(coalescer.offer(request({ health: 17, onFire: true, inLava: true, fireTicks: 300 }), 200).action, 'fold');
	assert.equal(coalescer.offer(request({ health: 17, onFire: false, inWater: true }), 300).action, 'fold');
	assert.equal(coalescer.flush(2000).nativeEvent.observation.player.inWater, true);
});

test('an immediate fire event establishes contact awareness without adding a redundant damage delivery', () => {
	const coalescer = new DangerSteerCoalescer();
	coalescer.noteDelivered(request({ health: 16 }), 0);
	coalescer.offer({ trigger: 'fire', nativeEvent: { event: 'observation', observation: { player: { health: 16, hazard: 'fire', onFire: true } } } }, 100);
	assert.equal(coalescer.offer(request({ health: 15, hazard: 'fire', onFire: true, fireTicks: 160 }), 200).action, 'fold');
});

test('a damage request without a body sample cannot claim that a known burn ended', () => {
	const coalescer = new DangerSteerCoalescer();
	coalescer.noteDelivered(request({ health: 16, onFire: true, fireTicks: 160 }), 0);
	assert.equal(coalescer.offer({ trigger: 'damage', nativeEvent: { event: 'observation', trigger: 'damage' } }, 100).action, 'fold');
});

test('residual burn damage names burn persistence and extinguishing without claiming a terrain contact', () => {
	const input = buildNativeEventInput({ currentGoal: 'Reach the fortress.' }, { event: 'observation', trigger: 'damage', observation: {
		player: { health: 5, maxHealth: 20, foodLevel: 18, onFire: true, fireTicks: 159 }, inventory: { items: [] },
	} });
	// Pinned independently of BURNING_INSTRUCTION so a reworded constant cannot become its own expectation.
	assert.equal(input.split('\n')[0], 'burn after exit. Move clear of nearby fire/lava first. Water/rain extinguish; fire resistance blocks damage. Burn time unknown; food in healing.');
	assert.equal(input.split('\n')[0], compactEventInstruction(BURNING_INSTRUCTION));
	assert.match(BURNING_INSTRUCTION, /^Live Minecraft event:/);
	assert.match(input.split('\n')[0], /burn after exit/i);
	assert.match(input.split('\n')[0], /Water.*rain.*extinguish/);
	assert.match(input.split('\n')[0], /fire resistance/i);
	assert.doesNotMatch(input.split('\n')[0], /body is in lava|player.exits/);
	assert.equal(JSON.parse(input.slice(input.indexOf('\n') + 1)).healing.burn.remaining, 'not_observed');
});

test('burn damage does not assume a short fire resistance effect lasts for the whole burn', () => {
	assert.deepEqual(burnFacts({ fireTicks: 300, effects: [{ effectId: 'minecraft:fire_resistance', duration: 100 }] }), { seconds: 15, rawDamage: 10 });
	assert.deepEqual(burnFacts({ fireTicks: 300, effects: [{ effectId: 'minecraft:fire_resistance', duration: -1 }] }), { seconds: 15, rawDamage: 0 });
});

test('hazard danger events pay for landing and burn facts while other triggers keep terrain detail', () => {
	const blocks = Array.from({ length: 32 }, (_, x) => ({ blockId: 'minecraft:stone', x, y: 63, z: 0, distance: x }));
	const payload = (player, trigger = 'damage', status) => {
		const input = buildNativeEventInput({ currentGoal: 'Reach the fortress.' }, {
			event: status ? 'program_attention' : 'observation', trigger, status, observation: { player, blocks, inventory: { items: [] } },
		});
		return JSON.parse(input.slice(input.indexOf('\n') + 1));
	};
	const hazard = payload({ health: 12, inLava: true, fireTicks: 300 });
	assert.equal(hazard.observation.blocks.length, 12);
	assert.equal(hazard.observation.snapshotCounts.blocks, 32);
	assert.equal(hazard.observation.omittedRows.blocks, 20);
	blocks[20] = { blockId: 'minecraft:water', x: 20, y: 63, z: 0, distance: 20 };
	assert.ok(payload({ health: 12, onFire: true, fireTicks: 150 }).observation.blocks.some(row => row.blockId === 'minecraft:water'),
		'visible water survives the smaller burn-event terrain budget');
	assert.equal(payload({ health: 12 }).observation.blocks.length, 32, 'ordinary damage keeps its terrain detail');
	for (const trigger of ['structure_sighted', 'chat', 'start', 'movement_loop']) {
		assert.equal(payload({ health: 12, onFire: true, fireTicks: 150 }, trigger).observation.blocks.length, 32, trigger);
	}
	assert.equal(payload({ health: 12, onFire: true, fireTicks: 150 }, 'program_attention', { decision: { trigger: 'damage' } }).observation.blocks.length, 12);
});

for (const [name, pattern] of [['steady lava', [true]], ['alternating lava/burning', [true, false]], ['3 lava : 1 burning', [true, true, true, false]]]) {
	test(`${name} keeps damage deliveries at the ordinary fold rate`, () => {
		const coalescer = new DangerSteerCoalescer();
		coalescer.noteDelivered(request({ health: 20, onFire: true, inLava: true, fireTicks: 300 }), 0);
		let delivered = 0;
		for (let i = 1; i <= 20; i++) {
			const lava = pattern[i % pattern.length];
			const result = coalescer.offer(request({ health: 20 - i * 0.5, onFire: true, inLava: lava, fireTicks: lava ? 300 : 300 - i * 10 }), i * 500);
			if (result.action === 'deliver') delivered++;
		}
		assert.equal(delivered, 5);
	});
}

test('first contact, a worse contact and an independent health emergency bypass the fold', () => {
	const coalescer = new DangerSteerCoalescer();
	coalescer.noteDelivered(request({ health: 18 }), 0);
	assert.equal(coalescer.offer(request({ health: 18, onFire: true }), 100).action, 'deliver');
	assert.equal(coalescer.offer(request({ health: 18, onFire: true, hazard: 'fire' }), 200).action, 'deliver');
	assert.equal(coalescer.offer(request({ health: 18, onFire: true, inLava: true }), 300).action, 'deliver');
	assert.equal(coalescer.offer(request({ health: 18, onFire: true }), 400).action, 'fold');
	assert.equal(coalescer.offer(request({ health: 13, onFire: true, inLava: true }), 500).action, 'deliver');
});

test('a worse contact after a sustained recovery is new danger again', () => {
	const coalescer = new DangerSteerCoalescer();
	coalescer.noteDelivered(request({ health: 18, inLava: true }), 0);
	assert.equal(coalescer.offer(request({ health: 18 }), 2000).action, 'deliver');
	assert.equal(coalescer.offer(request({ health: 18, inLava: true }), 2100).action, 'deliver');
});

test('surface bobbing folds at every sample phase, including a timer flush carrying burning', () => {
	for (const cadence of [100, 250, 500]) for (let phase = 0; phase < 2000; phase += 50) {
		const coalescer = new DangerSteerCoalescer();
		coalescer.noteDelivered(request({ health: 18, onFire: true, inLava: true }), 0);
		const deliveries = [0];
		let due = null;
		for (let i = 0, at = phase + cadence; at <= 10000; i++, at += cadence) {
			if (due !== null && due <= at) {
				assert.ok(coalescer.flush(due));
				deliveries.push(due);
				due = null;
			}
			const result = coalescer.offer(request({ health: 18, onFire: true, inLava: i % 2 === 0 }), at);
			if (result.action === 'deliver') {
				deliveries.push(at);
				due = null;
			} else due ??= at + result.dueInMs;
		}
		if (due !== null && due <= 10000) deliveries.push(due);
		assert.ok(deliveries.length <= 6, `${cadence} ms, phase ${phase}: ${deliveries}`);
		for (let i = 1; i < deliveries.length; i++) {
			assert.ok(deliveries[i] - deliveries[i - 1] >= 2000, `${cadence} ms, phase ${phase}: ${deliveries}`);
		}
	}
});

test('a folded lava sample keeps the observed peak when the timer delivers a milder sample', () => {
	const coalescer = new DangerSteerCoalescer();
	coalescer.noteDelivered(request({ health: 18, onFire: true, inLava: true }), 0);
	assert.equal(coalescer.offer(request({ health: 18, onFire: true, inLava: true }), 1900).action, 'fold');
	assert.equal(coalescer.offer(request({ health: 18, onFire: true }), 1950).action, 'fold');
	assert.equal(coalescer.flush(2000).nativeEvent.observation.player.inLava, undefined);
	assert.equal(coalescer.offer(request({ health: 18, onFire: true, inLava: true }), 2100).action, 'fold');
	assert.equal(coalescer.offer(request({ health: 13, onFire: true, inLava: true }), 2150).action, 'deliver', 'a health emergency still gets through');
});

test('raw burn damage counts full damage ticks, including resistance expiry between hits', () => {
	for (const [fireTicks, rawDamage] of [[1, 0], [19, 0], [20, 1], [21, 1], [281, 14], [300, 15]]) {
		assert.equal(burnFacts({ fireTicks }).rawDamage, rawDamage, String(fireTicks));
	}
	assert.equal(burnFacts({ fireTicks: 281, effects: [{ effectId: 'minecraft:fire_resistance', duration: 100 }] }).rawDamage, 9);
});

test('Nether residual burn lead says water evaporates instead of offering it as an extinguisher', () => {
	const input = buildNativeEventInput({ currentGoal: 'Reach the fortress.' }, { event: 'observation', trigger: 'damage', observation: {
		player: { health: 5, onFire: true, fireTicks: 160, harm: { source: 'minecraft:on_fire', ongoing: true, waterEvaporates: true, options: ['leave_fire', 'fire_resistance'] } },
		world: { dimension: 'minecraft:the_nether' }, inventory: { items: [] },
	} });
	assert.match(input.split('\n')[0], /Water evaporates here; fire resistance blocks damage/);
	assert.doesNotMatch(input.split('\n')[0], /Water\/rain extinguish/);
});
