import assert from 'node:assert/strict';
import test from 'node:test';

import { arrivalFacts, reportsDimensionChange } from '../src/arrival-facts.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { protectedNativeWake } from '../src/native-wake-events.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';

const NETHER = { dimension: 'minecraft:the_nether', worldId: 'w', gameTime: 100, dayTime: 1_000, raining: false, thundering: false };
// d14-iron-e's arrival spot beside its portal (9,37,24), with the lava sea and a piglin as the run later saw them.
const arrivalWire = ({ blocks = [], landmarks = [], entities = [], player = {} } = {}) => ({ ready: true, position: { x: 9.4, y: 37, z: 24.5 }, view: { yaw: 0, pitch: 0 },
	player: { health: 20, ...player }, inventory: { items: [], selectedItem: 'minecraft:air' }, entities, items: [], world: NETHER,
	blocks: [{ blockId: 'minecraft:nether_portal', x: 9, y: 37, z: 24 }, ...blocks], landmarks });
const record = { currentGoal: 'beat the game', currentGoalSpec: null, goalRevision: 1 };
const payloadOf = (input) => JSON.parse(input.slice(input.indexOf('\n') + 1));

test('the arrival line names the portal, the nearest seen lava with its offset, and hostile mobs in view', () => {
	const line = arrivalFacts(adaptObservation(arrivalWire({
		blocks: [{ blockId: 'minecraft:lava', x: 14, y: 33, z: 24 }, { blockId: 'minecraft:lava', x: 15, y: 33, z: 24 }],
		landmarks: [{ blockId: 'minecraft:lava', x: 24, y: 31, z: -17, distance: 44, bearing: 150, elevation: -8 }],
		entities: [{ uuid: 'p1', type: 'minecraft:piglin', x: 0, y: 37, z: 40, distance: 18.2, hostile: true, alive: true, targetingAgent: false },
			{ uuid: 'g1', type: 'minecraft:ghast', x: 30, y: 60, z: 0, distance: 40, hostile: true, alive: true }],
	})));
	assert.match(line, /^portal 9,37,24; /);
	assert.match(line, /lava seen within 16: 2 cells, nearest 6m E dy-4 at 14,33,24/);
	assert.match(line, /in view: piglin 18m$/);
	assert.doesNotMatch(line, /ghast/, 'beyond 32 blocks is not the arrival spot');
});

test('the arrival line says plainly when no lava or hostile mob is seen, and reports an open drop beside the feet', () => {
	const line = arrivalFacts(adaptObservation(arrivalWire({ player: { footing: { drop: 5, into: 'lava', yaw: 122 } } })));
	assert.match(line, /no lava seen within 16/);
	assert.match(line, /open drop 5 beside you at yaw 122 into lava/);
	assert.match(line, /no hostile mob in view within 32/);
});

test('only the wake whose changed line reports a dimension change carries the arrival line', () => {
	assert.equal(reportsDimensionChange('dimension overworld->the_nether; first sight: bastion'), true);
	assert.equal(reportsDimensionChange('respawned in overworld without pre-death gear: steps needing it are unmet'), false);
	assert.equal(reportsDimensionChange(null), false);
	const observation = adaptObservation(arrivalWire());
	const arrived = payloadOf(buildNativeEventInput(record, { event: 'observation', trigger: 'dimension_changed', observation, newContext: true, changed: 'dimension overworld->the_nether' }));
	assert.match(arrived.arrival, /^portal 9,37,24; no lava seen within 16; no hostile mob in view within 32$/);
	const later = payloadOf(buildNativeEventInput(record, { event: 'observation', trigger: 'attention', observation, changed: 'health 20->12' }));
	assert.equal(later.arrival, undefined);
});

test('a dimension change is a protected wake, so it steers into a running turn instead of waiting for it to end', () => {
	assert.equal(protectedNativeWake({ priority: 'ordinary', trigger: 'dimension_changed', nativeEvent: { event: 'observation', trigger: 'dimension_changed' } }), true);
	assert.equal(protectedNativeWake({ priority: 'ordinary', trigger: 'attention', nativeEvent: { event: 'observation', trigger: 'attention' } }), false);
});
