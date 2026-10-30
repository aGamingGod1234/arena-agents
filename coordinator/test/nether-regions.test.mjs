import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKED_BLOCKS, fortressSearchOption, knownRegions, regionOf, searchRegions, sightedComplex, structureRegion } from '../src/nether-regions.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';

const nether = { world: { worldId: 'w', dimension: 'minecraft:the_nether' } };
const arrival = { x: 9.5, y: 37, z: 24.5 };
// The Oct 23 save point 9-nether-entry: arrival beside a bastion, a second bastion seen to the north-west.
const oct23 = [{ what: 'bastion', kind: 'structure', x: -7, y: 64, z: 46 }, { what: 'built:minecraft:polished_blackstone_bricks', kind: 'built', x: -85, y: 68, z: -127, size: 9 }];

test('regions follow the 27-chunk grid from chunk 0, and a block in a region\'s last 64 joins the nearer start ground', () => {
	assert.deepEqual(regionOf(0, 0), { rx: 0, rz: 0 });
	assert.deepEqual(regionOf(-1, 431), { rx: -1, rz: 0 });
	assert.deepEqual(regionOf(432, -432), { rx: 1, rz: -1 });
	// x -7 lies 425 blocks into region -1, past its start ground (0..367): 7 blocks from region 0's start ground.
	assert.deepEqual(structureRegion(-7, 46), { rx: 0, rz: 0 });
	assert.deepEqual(structureRegion(390, 100), { rx: 0, rz: 0 }, '23 past its own start ground, 42 before the next region');
	assert.deepEqual(structureRegion(420, 100), { rx: 1, rz: 0 });
	assert.deepEqual(structureRegion(200, 200), { rx: 0, rz: 0 });
});

test('fortress bricks and bastion materials name the region\'s structure; ruined portal blackstone alone does not', () => {
	assert.equal(sightedComplex({ what: 'nether fortress', kind: 'structure' }), 'fortress');
	assert.equal(sightedComplex({ what: 'built:minecraft:nether_bricks+minecraft:nether_brick_fence', kind: 'built', size: 3 }), 'fortress');
	assert.equal(sightedComplex({ what: 'bastion', kind: 'structure' }), 'bastion');
	assert.equal(sightedComplex({ what: 'built:minecraft:gilded_blackstone', kind: 'built', size: 1 }), 'bastion');
	assert.equal(sightedComplex({ what: 'built:minecraft:polished_blackstone_bricks', kind: 'built', size: 9 }), 'bastion');
	assert.equal(sightedComplex({ what: 'built:minecraft:polished_blackstone_bricks', kind: 'built', size: 3 }), null, 'a small cluster may be a ruined portal');
	assert.equal(sightedComplex({ what: 'ruined portal', kind: 'structure' }), null);
	const regions = knownRegions([...oct23, { what: 'nether fortress', kind: 'structure', x: 20, y: 60, z: 30 }], arrival);
	assert.equal(regions.get('0,0').kind, 'fortress', 'one structure per region: bricks outrank a bastion guess');
});

test('the offered regions skip known bastion regions and start ground already seen, nearest unseen ground on average first', () => {
	const known = knownRegions(oct23, arrival);
	const offered = searchRegions(arrival, known, 25);
	assert.ok(!offered.some((r) => (r.rx === 0 && r.rz === 0) || (r.rx === -1 && r.rz === -1)), 'bastion regions are left out');
	assert.ok(offered.every((r, i) => i === 0 || offered[i - 1].average <= r.average));
	assert.ok(offered.every((r) => r.target.distance > CHECKED_BLOCKS - 1), 'ground near where the player stands counts as seen');
	const walked = searchRegions(arrival, known, 25, [{ x: -200, z: 150 }, { x: -300, z: 200 }]);
	const west = (rows) => rows.find((r) => r.rx === -1 && r.rz === 0);
	assert.ok(west(walked).unseen < west(offered).unseen, 'standing in a region marks part of its start ground seen');
});

test('the fortress search row: only in the Nether, while rods are open and no fortress is known', () => {
	const row = fortressSearchOption({ observation: nether, known: { sightings: oct23, trail: [] }, position: arrival, open: 'has:minecraft:blaze_rod*6' });
	assert.match(row, /^Fortress search, your choice: fortresses and bastions share one grid of 432-block regions/);
	assert.match(row, /about half are fortresses \(weight 2 of 5, plus where a bastion would start in basalt deltas\)/);
	assert.match(row, /Nether fog hides everything past 96/);
	assert.match(row, /bastion seen, so no fortress in: x 0\.\.431 z 0\.\.431 \(@-7,46\); x -432\.\.-1 z -432\.\.-1 \(@-85,-127\)/);
	assert.match(row, /regions with nothing seen yet, nearest unseen start ground on average first: W x -432\.\.-1 z 0\.\.431: nearest unseen start ground @-128,80 148 blocks ~0\.6 min walking/);
	assert.equal(fortressSearchOption({ observation: nether, known: { sightings: oct23 }, position: arrival, open: 'has:minecraft:ender_pearl*12' }), null, 'pearls only: no rods to find');
	assert.equal(fortressSearchOption({ observation: { world: { dimension: 'minecraft:overworld' } }, known: null, position: arrival, open: 'blaze_rod' }), null);
	const seen = { ...nether, sighted: { structures: [{ structure: 'nether fortress', x: 60, y: 70, z: 90, distance: 80 }] } };
	assert.equal(fortressSearchOption({ observation: seen, known: { sightings: oct23 }, position: arrival, open: 'blaze_rod' }), null, 'a fortress in sight ends the search');
	const far = { ...nether, sighted: { structures: [{ blocks: ['minecraft:nether_bricks'], x: 60, y: 70, z: 90, distance: 90 }] } };
	assert.equal(fortressSearchOption({ observation: far, known: null, position: arrival, open: 'blaze_rod' }), null, 'far bricks are a fortress too');
});

test('the wake options carry the fortress search beside the Nether route, with remembered sightings and trail', async () => {
	const record = { agentId: 'a1', currentGoal: 'Beat the game', goalRevision: 1 };
	const step = (id, check) => ({ id, label: id, kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check });
	const views = new LiveTaskViews({ sources: () => ({ sightings: oct23, blocks: [], placed: [], trail: [] }) });
	views.suggest(record.agentId, record.currentGoal, { steps: [step('rods', 'has:minecraft:blaze_rod*6')] });
	await views.observe(record, { ready: true, observedAtEpochMs: 0, player: { dead: false, x: arrival.x, y: arrival.y, z: arrival.z }, ...nether, inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }] } });
	const options = views.continuity(record).options;
	assert.match(options, /Nether route, your choice: .* \| Fortress search, your choice: /);
	assert.match(options, /bastion seen, so no fortress in: x 0\.\.431 z 0\.\.431/);
});
