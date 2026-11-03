import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeObservationSignature } from '../src/dynamic-main.mjs';
import { runIdleWakeBenchmark } from '../scripts/idle-wake-benchmark.mjs';

const observation = (player = {}, entities = [], extra = {}) => ({
	player: { x: 10.2, y: 64, z: -3.7, yaw: 90, pitch: 10, health: 20, foodLevel: 20, saturation: 5, ...player },
	entities, velocity: { x: 0, y: -0.08, z: 0 }, ...extra,
});
const cow = (x, distance) => ({ stableId: 'cow-1', type: 'minecraft:cow', x, y: 64, z: 0, distance, velocity: { x: 0.05, y: 0, z: 0 } });

test('sub-block drift, view direction, velocity and saturation are not changes', () => {
	const base = nativeObservationSignature(observation());
	assert.equal(nativeObservationSignature(observation({ x: 10.9, z: -3.1 })), base);
	assert.equal(nativeObservationSignature(observation({ yaw: -45, pitch: 0 })), base);
	assert.equal(nativeObservationSignature(observation({ saturation: 1.2 })), base);
	assert.equal(nativeObservationSignature(observation({}, [], { velocity: { x: 0.3, y: 0, z: 0 } })), base);
});

test('real changes to the body still change the signature', () => {
	const base = nativeObservationSignature(observation());
	assert.notEqual(nativeObservationSignature(observation({ x: 11.1 })), base, 'a new block');
	assert.notEqual(nativeObservationSignature(observation({ health: 19 })), base);
	assert.notEqual(nativeObservationSignature(observation({ foodLevel: 19 })), base);
});

test('nearby entities change by block; distant ones only by arrival and departure', () => {
	const near = nativeObservationSignature(observation({}, [cow(5.2, 5)]));
	assert.equal(nativeObservationSignature(observation({}, [cow(5.8, 5.6)])), near, 'same block nearby');
	assert.notEqual(nativeObservationSignature(observation({}, [cow(6.1, 6.1)])), near, 'next block nearby');
	const far = nativeObservationSignature(observation({}, [cow(30.2, 30)]));
	assert.equal(nativeObservationSignature(observation({}, [cow(34.9, 34.9)])), far, 'wandering far away');
	assert.notEqual(nativeObservationSignature(observation()), far, 'leaving is a change');
});

test('benchmark: noise heartbeats no longer wake an idle model, real changes still do', async () => {
	const rows = await runIdleWakeBenchmark();
	for (const row of rows.filter(entry => entry.noise)) assert.ok(row.extraTurns <= 1, `${row.scenario}: ${row.extraTurns} extra turns (at most the first sighting)`);
	for (const row of rows.filter(entry => !entry.noise)) assert.equal(row.extraTurns, row.heartbeats, `${row.scenario} wakes on every real change`);
});
