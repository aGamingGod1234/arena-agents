import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptObservation } from '../src/observation-adapter.mjs';

const BLAZE = '00000000-0000-0000-0000-0000000000c1';
const ZOMBIE = '00000000-0000-0000-0000-0000000000c2';

const threat = (uuid, type, distance, dy, extra = {}) => ({ uuid, type, distance, bearing: 0, targeting: true, swelling: false,
	lineOfSight: true, signals: ['targeting'], visible: true, dy, risk: 40, expectedHitDamage: 3, ...extra });
// A seen mob's box: 0.6 wide, standing with its feet at (x, y, z).
const mob = (uuid, type, x, y, z, height = 1.8) => ({ uuid, type, position: { x, y, z }, distance: Math.hypot(x, y - 70, z),
	bounds: { minX: x - 0.3, minY: y, minZ: z - 0.3, maxX: x + 0.3, maxY: y + height, maxZ: z + 0.3 } });

function wire({ threats, entities, pose }) {
	return {
		ready: true,
		position: { x: 0, y: 70, z: 0 },
		view: { yaw: 0, pitch: 0 },
		player: { health: 20, foodLevel: 18, onFire: false, air: 300, fallDistance: 0, ...(pose ? { pose } : {}) },
		inventory: { items: [], tagCounts: {} },
		entities,
		blocks: [],
		threats: { entries: threats },
	};
}

const rows = (observation) => Object.fromEntries(adaptObservation(observation).player.threats.map((row) => [row.uuid, row]));

test('a blaze 3 up and 11.7 across is out of melee reach, with its offset from the feet', () => {
	const facts = rows(wire({ threats: [threat(BLAZE, 'minecraft:blaze', 12.1, 3, { shot: 'clear' })], entities: [mob(BLAZE, 'minecraft:blaze', 11.7, 73, 0)] }));
	assert.equal(facts[BLAZE].melee, 'out of reach (3.0 up, 11.7 across)');
	assert.equal(facts[BLAZE].shot, 'clear');
});

test('a box within 3 blocks of the eye is in reach (zombie level, blaze 1.9 above the eye); 4 up and 2.8 across is not', () => {
	const facts = rows(wire({
		threats: [threat(ZOMBIE, 'minecraft:zombie', 2.5, 0), threat(BLAZE, 'minecraft:blaze', 4.3, 3.5)],
		entities: [mob(ZOMBIE, 'minecraft:zombie', 2.5, 70, 0, 1.95), mob(BLAZE, 'minecraft:blaze', 0, 73.5, 2.5)],
	}));
	assert.equal(facts[ZOMBIE].melee, 'in reach');
	assert.equal(facts[BLAZE].melee, 'in reach', 'eye 71.62 to a box from 73.5 and 2.2 across is 2.9: inside reach');
	const far = rows(wire({ threats: [threat(BLAZE, 'minecraft:blaze', 4.3, 3.5)], entities: [mob(BLAZE, 'minecraft:blaze', 0, 74, 2.8)] }));
	assert.match(far[BLAZE].melee, /^out of reach \(4\.0 up, 2\.8 across\)$/);
	assert.equal(far[BLAZE].shot, undefined, 'no body line reported, no shot claim');
});

test('a mob below the feet reads as down, and a crouching eye is lower', () => {
	const below = rows(wire({ threats: [threat(ZOMBIE, 'minecraft:zombie', 4, -3)], entities: [mob(ZOMBIE, 'minecraft:zombie', 2, 67, 0, 1.95)] }));
	assert.equal(below[ZOMBIE].melee, 'out of reach (3.0 down, 2.0 across)');
	// Standing, the eye (71.62) is 3.02 above the box top (68.6); crouching (71.27) brings it inside reach.
	const box = mob(ZOMBIE, 'minecraft:zombie', 0.3, 66.65, 0, 1.95);
	assert.match(rows(wire({ threats: [threat(ZOMBIE, 'minecraft:zombie', 3.4, -3.35)], entities: [box] }))[ZOMBIE].melee, /^out of reach/);
	assert.equal(rows(wire({ threats: [threat(ZOMBIE, 'minecraft:zombie', 3.4, -3.35)], entities: [box], pose: 'crouching' }))[ZOMBIE].melee, 'in reach');
});

test('a blocked eye line names the block; an unseen threat carries no reach or shot claim', () => {
	const facts = rows(wire({
		threats: [threat(BLAZE, 'minecraft:blaze', 9, 3, { shot: 'minecraft:nether_brick_fence' }), threat(ZOMBIE, 'minecraft:zombie', 6, 0, { visible: false })],
		entities: [mob(BLAZE, 'minecraft:blaze', 8.5, 73, 0)],
	}));
	assert.equal(facts[BLAZE].shot, 'blocked by nether_brick_fence');
	assert.match(facts[BLAZE].melee, /^out of reach/);
	assert.equal(facts[ZOMBIE].melee, undefined);
	assert.equal(facts[ZOMBIE].shot, undefined);
	// A heard threat whose box is still listed gets no reach claim either.
	const heard = rows(wire({ threats: [threat(ZOMBIE, 'minecraft:zombie', 2, 0, { visible: false })], entities: [mob(ZOMBIE, 'minecraft:zombie', 2, 70, 0, 1.95)] }));
	assert.equal(heard[ZOMBIE].melee, undefined);
});

test('melee candidacy follows the eye-to-box reach when the box is seen', () => {
	// Centre 3.2 across and 1 up: the box edge is 2.9 from the feet column, so it is in reach although the centre is past 3.
	const near = rows(wire({ threats: [threat(BLAZE, 'minecraft:blaze', 3.35, 1)], entities: [mob(BLAZE, 'minecraft:blaze', 3.2, 71, 0)] }));
	assert.equal(near[BLAZE].melee, 'in reach');
	assert.equal(near[BLAZE].meleeCandidate, true);
	const far = rows(wire({ threats: [threat(BLAZE, 'minecraft:blaze', 2.9, 3)], entities: [mob(BLAZE, 'minecraft:blaze', 0, 74, 2.8)] }));
	assert.match(far[BLAZE].melee, /^out of reach/);
	assert.equal(far[BLAZE].meleeCandidate, false, 'a centre within 3 but a box out of reach is not a melee candidate');
	const unseen = rows(wire({ threats: [threat(ZOMBIE, 'minecraft:zombie', 2.5, 0, { visible: false })], entities: [] }));
	assert.equal(unseen[ZOMBIE].meleeCandidate, true, 'no seen box: range alone, as before');
});
