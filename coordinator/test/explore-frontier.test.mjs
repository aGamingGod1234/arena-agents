import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExplorationOccupancy, cellKey, extractPosition } from '../src/explore-frontier.mjs';
import { ObservedMemoryStore, UNKNOWN_DIMENSION } from '../src/observed-memory-store.mjs';
import { headingOf } from '../src/search-coverage.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { ModelObservationViews, decodeModelFacts, encodeModelFacts } from '../src/model-fact-encoding.mjs';

function observation({ x = 0.5, y = 64, z = 0.5, yaw = 0, onGround = true, player = {}, blocks = [], landmarks = [], sighted, dimension = 'minecraft:the_nether', gameTime = 20, worldId = 'world-a' } = {}) {
	return { position: { x, y, z }, player: { yaw, onGround, ...player }, world: { dimension, worldId, gameTime }, blocks, landmarks, ...(sighted === undefined ? {} : { sighted }) };
}

/** A completed survey attempt as the server reports it: eye, yaw, pitch, sight range and game time. */
function survey(occupancy, view, { yaw = 0, pitch = 0, range = 256, survey: rows = null } = {}) {
	const { x, y, z } = view.position;
	occupancy.recordSurvey('a', view, { attempt: { x, y: y + 1.62, z, yaw, pitch, range, tick: view.world.gameTime }, survey: rows });
}

// Two seconds per step keeps every step within walking speed, so none of them reads as a teleport.
function walk(occupancy, points, { start = 20, step = 40 } = {}) {
	let tick = start;
	for (const [x, y, z] of points) { occupancy.ingest('a', observation({ x, y, z, gameTime: tick }), { snapshot: false }); tick += step; }
	return tick;
}

test('compass headings follow Minecraft axes: north is -Z and east is +X', () => {
	assert.equal(headingOf(0, -10), 'N');
	assert.equal(headingOf(10, 0), 'E');
	assert.equal(headingOf(0, 10), 'S');
	assert.equal(headingOf(-10, 0), 'W');
	assert.equal(headingOf(10, -10), 'NE');
});

test('candidates are observed footing facts, never a chosen destination, and reading them changes nothing', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[0.5, 64, 0.5], [20.5, 64, 0.5], [40.5, 62, 0.5], [0.5, 64, 0.5]]);
	const view = observation({ gameTime: tick });
	const before = occupancy.snapshot('a');
	const first = occupancy.candidates('a', view);
	assert.equal(first.kind, 'footing');
	assert.equal(first.destination, undefined);
	assert.deepEqual(first.candidates.map(({ x, y, z, footing, dy, heading }) => ({ x, y, z, footing, dy, heading })), [
		{ x: 40, y: 62, z: 0, footing: 'stood', dy: -2, heading: 'E' },
		{ x: 20, y: 64, z: 0, footing: 'stood', dy: 0, heading: 'E' },
	]);
	assert.deepEqual(occupancy.candidates('a', view), first);
	assert.deepEqual(occupancy.snapshot('a'), before);
});

test('blocks seen below the eye become unverified seen_surface rows; fluids, plants, faces above the eye and covered tops do not', () => {
	const occupancy = new ExplorationOccupancy();
	occupancy.ingest('a', observation({ gameTime: 20, blocks: [{ blockId: 'minecraft:netherrack', x: 60, y: 51, z: 0 }], landmarks: [
		{ blockId: 'minecraft:netherrack', x: 0, y: 40, z: -90 },
		{ blockId: 'minecraft:lava', x: 90, y: 31, z: 0 },
		{ blockId: 'minecraft:crimson_roots', x: -90, y: 50, z: 0 },
		{ blockId: 'minecraft:netherrack', x: 0, y: 80, z: 90 },
		{ blockId: 'minecraft:netherrack', x: 60, y: 50, z: 0 },
	] }));
	const result = occupancy.candidates('a', observation({ gameTime: 21 }));
	assert.deepEqual(result.candidates.map(({ x, y, z, footing, dy, heading }) => ({ x, y, z, footing, dy, heading })), [{ x: 0, y: 41, z: -90, footing: 'seen_surface', dy: -23, heading: 'N' }]);
	assert.deepEqual(Object.keys(result.coverage.headings).sort(), ['E', 'N', 'S', 'W'], 'every landmark still counts as seen distance');
});

test('ordering spreads across headings, farthest first within each, and pages with nextOffset', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[20.5, 64, 0.5], [40.5, 64, 0.5], [60.5, 64, 0.5], [0.5, 64, -30.5], [0.5, 64, 0.5]]);
	const view = observation({ gameTime: tick });
	const all = occupancy.candidates('a', view);
	assert.deepEqual(all.candidates.map(({ x, z }) => [x, z]), [[0, -31], [60, 0], [40, 0], [20, 0]]);
	const page = occupancy.candidates('a', view, { limit: 2 });
	assert.equal(page.total, 4);
	assert.equal(page.nextOffset, 2);
	assert.deepEqual(occupancy.candidates('a', view, { limit: 2, offset: 2 }).candidates, all.candidates.slice(2));
	assert.equal(occupancy.candidates('a', view, { radius: 16 }).total, 0, 'radius is horizontal and bounds the list');
});

test('coverage summarizes travel, descent, walked, seen and surveyed headings, and remembers sightings', () => {
	const occupancy = new ExplorationOccupancy();
	let tick = walk(occupancy, [[0.5, 70, 0.5], [10.5, 70, 0.5], [20.5, 67, 0.5], [30.5, 66, 0.5]]);
	occupancy.ingest('a', observation({ x: 30.5, y: 66, z: 0.5, gameTime: tick++, sighted: { structures: [{ blocks: ['minecraft:nether_bricks'], size: 6, x: 30, y: 60, z: -150, distance: 150, bearing: 0, new: true }] } }));
	const surveyView = observation({ x: 30.5, y: 66, z: 0.5, yaw: -90, gameTime: tick++ });
	occupancy.ingest('a', surveyView);
	survey(occupancy, surveyView, { yaw: -90, survey: { poi: [{ blockId: 'minecraft:nether_portal', x: 100, y: 66, z: 0 }], structures: [] } });
	const coverage = occupancy.candidates('a', observation({ x: 30.5, y: 66, z: 0.5, gameTime: tick })).coverage;
	assert.equal(coverage.travelled, 30);
	assert.equal(coverage.descended, 4);
	assert.equal(coverage.climbed, 0);
	assert.deepEqual(coverage.start, { x: 1, y: 70, z: 1 });
	assert.deepEqual(coverage.headings.W, [20, 0], 'the trail keeps the latest stood point per 16-block sector');
	assert.deepEqual(coverage.headings.E, [0, 0, 256, 0], 'a complete survey facing east: its sight range and age, not a searched distance');
	assert.equal(coverage.headings.N, undefined, 'no walk, sighting surface or survey reached north');
	assert.deepEqual(coverage.sightings.map(({ what, heading }) => [what, heading]), [['minecraft:nether_portal', 'E'], ['built:minecraft:nether_bricks', 'N']]);
});

test('move measurement reports feet displacement and sampled ground changes as lower bounds', () => {
	const occupancy = new ExplorationOccupancy();
	walk(occupancy, [[0.5, 70, 0.5]]);
	occupancy.beginTravel('a');
	walk(occupancy, [[3.5, 69, 0.5], [6.5, 66, 0.5], [6.5, 67, 0.5]], { start: 60 });
	occupancy.ingest('a', observation({ x: 7, y: 66, z: 0.5, gameTime: 150, onGround: false }), { snapshot: false });
	assert.deepEqual(occupancy.endTravel('a', { position: { x: 8, y: 68, z: 0.5 }, worldTick: 155 }), { feetDy: -2, descendedAtLeast: 4, climbedAtLeast: 1, lowestGroundY: 66, endOnGround: 'unknown' },
		'an action result sample has no grounding, so its height is feet displacement only');
	assert.equal(occupancy.endTravel('a'), null, 'one measurement per move');
	occupancy.beginTravel('a');
	occupancy.ingest('a', observation({ dimension: 'minecraft:overworld', gameTime: 50 }), { snapshot: false });
	assert.equal(occupancy.endTravel('a'), null, 'a dimension change is not a height change');
});

test('known footing near an unstandable target lists the nearest observed footing only', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[0.5, 64, 0.5], [20.5, 66, 0.5], [40.5, 64, 0.5], [200.5, 64, 0.5]]);
	const footing = occupancy.knownFooting('a', observation({ gameTime: tick }), { x: 24, y: 80, z: 2 });
	assert.deepEqual(footing.map(({ x, y, footing: kind }) => [x, y, kind]), [[20, 66, 'stood'], [40, 64, 'stood'], [0, 64, 'stood']]);
	assert.ok(footing.every((spot) => spot.ageS === undefined && spot.blocked === undefined), 'fresh, unblocked facts carry no flags');
	assert.ok(footing.every((spot) => spot.fromTarget <= 32));
});

test('world and dimension scopes stay separate and a missing dimension stays unknown', () => {
	const occupancy = new ExplorationOccupancy();
	walk(occupancy, [[0.5, 64, 0.5], [40.5, 64, 0.5]]);
	assert.equal(occupancy.candidates('a', observation({ dimension: 'minecraft:overworld' })).total, 0);
	assert.equal(occupancy.candidates('a', observation({ worldId: 'world-b' })).total, 0);
	const unknown = { position: { x: 0.5, y: 64, z: 0.5 }, player: {}, world: { worldId: 'world-a', gameTime: 30 } };
	occupancy.ingest('a', unknown);
	const result = occupancy.candidates('a', unknown);
	assert.equal(result.dimension, UNKNOWN_DIMENSION);
	assert.equal(result.total, 0, 'unknown-dimension facts never borrow the Nether or the overworld');
});

test('search coverage persists per world and dimension; unknown-dimension and session facts are not saved', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'frontier-'));
	try {
		const first = new ExplorationOccupancy({ memoryStore: new ObservedMemoryStore({ directory }) });
		await first.load('a');
		const tick = walk(first, [[0.5, 64, 0.5], [40.5, 60, 0.5]]);
		const view = observation({ x: 40.5, y: 60, gameTime: tick });
		first.ingest('a', view);
		survey(first, view, { yaw: 180, survey: { structures: [{ id: 's1', structure: 'minecraft:fortress', size: 9, x: 40, y: 50, z: -60 }] } });
		first.ingest('a', { position: { x: 0, y: 64, z: 0 }, player: {}, world: { worldId: 'world-a', gameTime: tick + 1 } });
		await first.flush('a');
		const second = new ExplorationOccupancy({ memoryStore: new ObservedMemoryStore({ directory }) });
		await second.load('a');
		const restored = second.candidates('a', observation({ x: 40.5, y: 60, gameTime: tick + 20 }));
		assert.deepEqual(restored.candidates.map(({ x, footing }) => [x, footing]), [[0, 'stood']]);
		assert.equal(restored.coverage.sightings[0].what, 'minecraft:fortress');
		assert.deepEqual(restored.coverage.headings.N.slice(2), [256, 1]);
		assert.equal(restored.coverage.travelled, 40, 'odometer totals persist');
		second.ingest('a', observation({ x: 41.5, y: 62, gameTime: tick + 22 }));
		assert.equal(second.candidates('a', observation({ x: 41.5, y: 62, gameTime: tick + 23 })).coverage.climbed, 0, 'motion continuity is not restored across a restart');
		assert.equal(second.candidates('a', { position: { x: 0, y: 64, z: 0 }, player: {}, world: { worldId: 'world-a', gameTime: tick + 21 } }).total, 0);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('blockId pages remembered blocks of that exact id nearest first', () => {
	const occupancy = new ExplorationOccupancy();
	occupancy.ingest('a', observation({ landmarks: [{ blockId: 'minecraft:glowstone', x: 30, y: 90, z: 0 }, { blockId: 'minecraft:glowstone', x: 5, y: 80, z: 0 }, { blockId: 'minecraft:netherrack', x: 2, y: 63, z: 0 }] }));
	const result = occupancy.candidates('a', observation({ gameTime: 21 }), { blockId: 'minecraft:glowstone', limit: 1 });
	assert.equal(result.kind, 'blocks');
	assert.deepEqual(result.candidates, [{ x: 5, y: 80, z: 0, distance: 5, heading: 'E' }]);
	assert.equal(result.nextOffset, 1);
});

test('missing player position returns no candidates and arguments are bounded', () => {
	const result = new ExplorationOccupancy().candidates('a', { player: { health: 20 } });
	assert.equal(result.kind, 'no_observation');
	assert.deepEqual(result.candidates, []);
	assert.throws(() => new ExplorationOccupancy().candidates('a', observation(), { limit: 25 }), /limit must be/);
	assert.throws(() => new ExplorationOccupancy().candidates('a', observation(), { radius: 8 }), /radius must be/);
});

test('seen landmarks do not count as visited and height layers remain independent', () => {
	const occupancy = new ExplorationOccupancy();
	occupancy.ingest('a', observation({ landmarks: [{ blockId: 'minecraft:stone', x: 0, y: 80, z: 0 }] }));
	const result = occupancy.snapshot('a');
	assert.equal(result.knownCells, 2);
	assert.equal(result.visitedCells, 1);
	assert.equal(result.seenCells, 1);
	assert.notEqual(cellKey(0, 64, 0), cellKey(0, 80, 0));
});

test('occupancy forwards snapshot suppression to the real store', (t) => {
	const memoryStore = new ObservedMemoryStore();
	const occupancy = new ExplorationOccupancy({ memoryStore });
	const queries = t.mock.method(memoryStore, 'query');
	const view = observation({ blocks: [{ blockId: 'minecraft:chest', x: 12, y: 64, z: 0 }] });
	assert.equal(occupancy.ingest('a', view).blocks[0].blockId, 'minecraft:chest');
	assert.equal(queries.mock.callCount(), 1);
	assert.equal(occupancy.ingest('a', { ...view, position: { x: 24, y: 64, z: 0 } }, { snapshot: false }), undefined);
	assert.equal(queries.mock.callCount(), 1, 'discarded snapshots never query/copy retained records');
	assert.equal(occupancy.snapshot('a').visitedCells, 2);
});

test('position adapters accept current wire and nested player shapes', () => {
	assert.deepEqual(extractPosition({ position: { x: 1, y: 2, z: 3 } }), { x: 1, y: 2, z: 3 });
	assert.deepEqual(extractPosition({ player: { position: { x: 1, y: 2, z: 3 } } }), { x: 1, y: 2, z: 3 });
	assert.equal(extractPosition({ player: { health: 20 } }), null);
});

test('recorded Nether memory: default result stays small and holds no under-foot clutter', async () => {
	const { replayNetherFixture } = await import('../src/benchmark/frontier-bytes.mjs');
	const { occupancy, agentId, observation: view } = await replayNetherFixture(ExplorationOccupancy, ObservedMemoryStore);
	const result = occupancy.candidates(agentId, view);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2_500, `bytes ${Buffer.byteLength(JSON.stringify(result))}`);
	assert.ok(result.candidates.length > 0);
	assert.ok(result.candidates.every((entry) => entry.distance >= 8));
});

// Review round 1, defect 1: a survey is an attempt at one pose and range, not a searched cone.
test('survey attempts count for a heading only when the pitched view cone included it', () => {
	const headingsAfter = (pitch) => {
		const occupancy = new ExplorationOccupancy();
		const view = observation({ gameTime: 100 });
		occupancy.ingest('a', view);
		survey(occupancy, view, { yaw: -90, pitch });
		return occupancy.candidates('a', view).coverage.headings;
	};
	assert.deepEqual(Object.keys(headingsAfter(0)).sort(), ['E', 'NE', 'SE'], 'level view: east and its neighbours, not north or south');
	assert.deepEqual(headingsAfter(90), {}, 'looking straight down surveys no horizontal heading');
	assert.deepEqual(headingsAfter(-90), {}, 'looking straight up surveys no horizontal heading');
	assert.deepEqual(Object.keys(headingsAfter(70)), ['E'], 'a steep view only reaches the heading it faces');
});

test('survey attempts keep their fluid-limited range and age, and count only near where they were taken', () => {
	const occupancy = new ExplorationOccupancy();
	const view = observation({ gameTime: 100 });
	occupancy.ingest('a', view);
	survey(occupancy, view, { yaw: -90, range: 1 });
	survey(occupancy, view, { yaw: 180, range: 48 });
	const later = observation({ gameTime: 700 });
	occupancy.ingest('a', later);
	const headings = occupancy.candidates('a', later).coverage.headings;
	assert.deepEqual(headings.E, [0, 0, 1, 30], 'eye in lava: one block of sight, 30 s ago');
	assert.deepEqual(headings.N, [0, 0, 48, 30], 'eye in water: water fog range');
	const elsewhere = observation({ x: 100.5, gameTime: 1000 });
	occupancy.ingest('a', elsewhere);
	assert.equal(occupancy.candidates('a', elsewhere).coverage.headings.E, undefined, 'a survey 100 blocks back says nothing about the view from here');
});

test('an occluded survey reports its sight limit apart from what was actually seen, and implies no sighting', () => {
	const occupancy = new ExplorationOccupancy();
	// A netherrack wall 20 blocks east fills the view; nothing beyond it was observed.
	const wall = Array.from({ length: 6 }, (_, index) => ({ blockId: 'minecraft:netherrack', x: 20, y: 62 + index, z: index - 3 }));
	const view = observation({ gameTime: 100, landmarks: wall });
	occupancy.ingest('a', view);
	survey(occupancy, view, { yaw: -90, survey: { structures: [] } });
	const coverage = occupancy.candidates('a', view).coverage;
	assert.deepEqual(coverage.headings.E, [0, 25, 256, 0], 'seen stops at the wall sector; 256 is only how far the view could have reached');
	assert.deepEqual(coverage.sightings, [], 'an empty survey records no negative or inferred sighting');
});

test('a survey attempt without an explicit pose and range is not recorded', () => {
	const occupancy = new ExplorationOccupancy();
	const view = observation({ gameTime: 100 });
	occupancy.ingest('a', view);
	occupancy.recordSurvey('a', view, { attempt: { x: 0, y: 65.6, z: 0, yaw: 0, range: 256, tick: 100 } });
	occupancy.recordSurvey('a', view, { attempt: null, survey: { structures: [{ structure: 'minecraft:fortress', x: 0, y: 60, z: 90 }] } });
	const coverage = occupancy.candidates('a', view).coverage;
	assert.deepEqual(coverage.headings, {});
	assert.equal(coverage.sightings[0].what, 'minecraft:fortress', 'rows a survey returned are still sightings');
});

// Review round 1, defect 2: a seen block is a surface, not proven footing.
test('seen surfaces exclude roofed blocks and non-full collision shapes, and a side face below the eye stays unverified', () => {
	const occupancy = new ExplorationOccupancy();
	occupancy.ingest('a', observation({ gameTime: 20, blocks: [{ blockId: 'minecraft:netherrack', x: 40, y: 62, z: 0 }], landmarks: [
		// Side face of a block whose top is just below the eye: still listed, but only as a seen surface.
		{ blockId: 'minecraft:netherrack', x: 0, y: 64, z: -12 },
		// Roofed two blocks above: no headroom.
		{ blockId: 'minecraft:netherrack', x: 40, y: 60, z: 0 },
		{ blockId: 'minecraft:nether_brick_fence', x: -40, y: 60, z: 0 },
		{ blockId: 'minecraft:nether_brick_slab', x: 0, y: 60, z: 40 },
		{ blockId: 'minecraft:example_half_block', x: 30, y: 60, z: 40, tags: ['minecraft:slabs'] },
	] }));
	const rows = occupancy.candidates('a', observation({ gameTime: 21 })).candidates;
	assert.deepEqual(rows.map(({ x, y, z, footing }) => [x, y, z, footing]), [[0, 65, -12, 'seen_surface']]);
});

// Review round 1, defect 3: each surface keeps its own observation tick.
test('an unrelated sighting in the same sector does not refresh an old surface (stone then lava)', () => {
	const occupancy = new ExplorationOccupancy();
	occupancy.ingest('a', observation({ gameTime: 20, landmarks: [{ blockId: 'minecraft:stone', x: 20, y: 50, z: 0 }] }));
	occupancy.ingest('a', observation({ gameTime: 2020, landmarks: [{ blockId: 'minecraft:lava', x: 25, y: 45, z: 0 }] }));
	const [row] = occupancy.candidates('a', observation({ gameTime: 2021 })).candidates;
	assert.deepEqual({ x: row.x, y: row.y, footing: row.footing, ageS: row.ageS }, { x: 20, y: 51, footing: 'seen_surface', ageS: 100 });
});

test('a surface later seen covered or changed is dropped, even when it was the higher one', () => {
	const covered = new ExplorationOccupancy();
	covered.ingest('a', observation({ gameTime: 20, landmarks: [{ blockId: 'minecraft:stone', x: 20, y: 50, z: 0 }] }));
	covered.ingest('a', observation({ gameTime: 40, landmarks: [{ blockId: 'minecraft:netherrack', x: 40, y: 48, z: 6 }], blocks: [{ blockId: 'minecraft:netherrack', x: 20, y: 52, z: 0 }] }));
	assert.deepEqual(covered.candidates('a', observation({ gameTime: 41 })).candidates.map(({ x, y, z }) => [x, y, z]), [[40, 49, 6]]);
	const removed = new ExplorationOccupancy();
	removed.ingest('a', observation({ gameTime: 20, landmarks: [{ blockId: 'minecraft:stone', x: 20, y: 50, z: 0 }] }));
	removed.ingest('a', observation({ gameTime: 40, blocks: [{ blockId: 'minecraft:air', x: 20, y: 50, z: 0 }] }));
	assert.deepEqual(removed.candidates('a', observation({ gameTime: 41 })).candidates, []);
});

test('known footing near a target carries age and recent blocked failures', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[0.5, 64, 0.5], [20.5, 66, 0.5]]);
	const later = observation({ x: 20.5, y: 66, gameTime: tick + 2000 });
	occupancy.ingest('a', later);
	occupancy.markBlocked('a', 'minecraft:the_nether', 20, 0, { y: 66, worldId: 'world-a' });
	const footing = occupancy.knownFooting('a', later, { x: 4, y: 64, z: 0 });
	assert.deepEqual(footing.find((spot) => spot.x === 0), { x: 0, y: 64, z: 0, footing: 'stood', fromTarget: 4, ageS: 104 });
	assert.equal(footing.find((spot) => spot.x === 20).blocked, true);
});

// Review round 1, defect 4: one reconciled terminal sample, start-state evidence, lower bounds.
test('travel with no intermediate sample reconciles the terminal sample once', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[0.5, 64, 0.5]]);
	occupancy.beginTravel('a');
	assert.deepEqual(occupancy.endTravel('a', { position: { x: 3.5, y: 60, z: 0.5 }, worldTick: tick + 20 }), { feetDy: -4, lowestGroundY: 64, endOnGround: 'unknown' },
		'feet fell 4; with no foothold sampled after the start, no descent total is claimed');
	occupancy.beginTravel('a');
	assert.deepEqual(occupancy.endTravel('a', observation({ x: 3.5, y: 60, z: 0.5, gameTime: tick + 20 })), { feetDy: -4, descendedAtLeast: 4, lowestGroundY: 60 },
		'a standing terminal sample is one more foothold');
	occupancy.ingest('a', observation({ x: 3.5, y: 60, z: 0.5, gameTime: tick + 20 }));
	occupancy.beginTravel('a');
	assert.deepEqual(occupancy.endTravel('a', observation({ x: 3.5, y: 60, z: 0.5, gameTime: tick + 20 })), { feetDy: 0, lowestGroundY: 60 }, 'an already ingested terminal sample is not counted twice');
});

test('a failed airborne move and a move started mid-air claim no ground they did not stand on', () => {
	const falling = new ExplorationOccupancy();
	let tick = walk(falling, [[0.5, 70, 0.5]]);
	falling.beginTravel('a');
	falling.ingest('a', observation({ x: 2.5, y: 64, z: 0.5, gameTime: tick + 5, onGround: false }));
	assert.deepEqual(falling.endTravel('a', observation({ x: 3.5, y: 58, z: 0.5, gameTime: tick + 8, onGround: false })), { feetDy: -12, lowestGroundY: 70, endOnGround: false });
	const jumped = new ExplorationOccupancy();
	tick = walk(jumped, [[0.5, 70, 0.5]]);
	jumped.ingest('a', observation({ x: 1.5, y: 66, z: 0.5, gameTime: tick + 5, onGround: false }));
	jumped.beginTravel('a');
	jumped.ingest('a', observation({ x: 2.5, y: 60, z: 0.5, gameTime: tick + 10 }));
	assert.deepEqual(jumped.endTravel('a'), { feetDy: -6, lowestGroundY: 60, startOnGround: false }, 'the last grounded Y before the jump is not the start');
});

test('a short dip and climb is reported even when the net feet change is zero', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[0.5, 64, 0.5]]);
	occupancy.beginTravel('a');
	walk(occupancy, [[1.5, 63, 0.5], [2.5, 64, 0.5]], { start: tick });
	assert.deepEqual(occupancy.endTravel('a'), { feetDy: 0, descendedAtLeast: 1, climbedAtLeast: 1, lowestGroundY: 63 });
});

// Review round 1, defect 5: lifecycle and teleports break motion continuity, never coverage.
test('death and respawn are not travel or climb, and keep the places already stood on', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[0.5, 64, 0.5]]);
	occupancy.beginTravel('a');
	occupancy.ingest('a', observation({ x: 0.5, y: 64, z: 0.5, gameTime: tick + 10, player: { dead: true, health: 0 } }));
	assert.equal(occupancy.endTravel('a'), null, 'a death ends the move measurement');
	occupancy.ingest('a', observation({ x: 20.5, y: 80, z: 0.5, gameTime: tick + 100 }));
	const result = occupancy.candidates('a', observation({ x: 20.5, y: 80, z: 0.5, gameTime: tick + 101 }));
	assert.deepEqual([result.coverage.travelled, result.coverage.climbed, result.coverage.descended], [0, 0, 0]);
	assert.deepEqual(result.candidates.map(({ x, y }) => [x, y]), [[0, 64]], 'the earlier foothold stays as coverage');
});

test('short and vertical teleports are not travel; walking on afterwards is', () => {
	const occupancy = new ExplorationOccupancy();
	let tick = walk(occupancy, [[0.5, 64, 0.5]], { step: 1 });
	occupancy.ingest('a', observation({ x: 30.5, y: 64, z: 0.5, gameTime: tick }));
	occupancy.ingest('a', observation({ x: 30.5, y: 96, z: 0.5, gameTime: tick + 1 }));
	tick = walk(occupancy, [[40.5, 96, 0.5]], { start: tick + 41 });
	const coverage = occupancy.candidates('a', observation({ x: 40.5, y: 96, z: 0.5, gameTime: tick })).coverage;
	assert.deepEqual([coverage.travelled, coverage.climbed], [10, 0]);
});

test('riding and samples without grounding evidence add no footholds or height changes', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[0.5, 64, 0.5]]);
	occupancy.ingest('a', observation({ x: 20.5, y: 70, z: 0.5, gameTime: tick + 20, player: { passenger: true, vehicle: { type: 'minecraft:strider' } } }));
	occupancy.ingest('a', { position: { x: 40.5, y: 72, z: 0.5 }, player: {}, world: { worldId: 'world-a', dimension: 'minecraft:the_nether', gameTime: tick + 40 } });
	const result = occupancy.candidates('a', observation({ x: 40.5, y: 72, z: 0.5, gameTime: tick + 41 }));
	assert.equal(result.coverage.travelled, 40, 'riding is still movement');
	assert.deepEqual([result.coverage.climbed, result.coverage.descended], [0, 0]);
	assert.deepEqual(result.candidates.map(({ x }) => x), [0], 'no foothold while riding or without onGround');
});

test('a big jump down counts its descent on landing', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[0.5, 80, 0.5]]);
	occupancy.ingest('a', observation({ x: 3.5, y: 70, z: 0.5, gameTime: tick + 10, onGround: false }));
	occupancy.ingest('a', observation({ x: 5.5, y: 60, z: 0.5, gameTime: tick + 15 }));
	assert.equal(occupancy.candidates('a', observation({ x: 5.5, y: 60, z: 0.5, gameTime: tick + 16 })).coverage.descended, 20);
});

test('leaving a dimension and coming back far away is not travel', () => {
	const occupancy = new ExplorationOccupancy();
	const tick = walk(occupancy, [[0.5, 64, 0.5]]);
	occupancy.ingest('a', observation({ dimension: 'minecraft:overworld', x: 8.5, y: 70, gameTime: tick + 20 }));
	occupancy.ingest('a', observation({ x: 3.5, y: 64, gameTime: tick + 400 }));
	assert.equal(occupancy.candidates('a', observation({ x: 3.5, y: 64, gameTime: tick + 401 })).coverage.travelled, 0);
});

// Round 2 review cases (reviews/exploration-r2-artifacts/review-r2.mjs), with the behaviour the review asked for.

test('a disproven surface stays gone after its contradicting block record is evicted, and after a restart', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'frontier-'));
	try {
		const first = new ExplorationOccupancy({ memoryStore: new ObservedMemoryStore({ directory }) });
		await first.load('a');
		first.ingest('a', observation({ gameTime: 100, landmarks: [{ blockId: 'minecraft:stone', x: 20, y: 50, z: 0 }] }));
		first.ingest('a', observation({ gameTime: 110, landmarks: [{ blockId: 'minecraft:netherrack', x: 40, y: 50, z: 20 }] }));
		first.ingest('a', observation({ gameTime: 120, blocks: [{ blockId: 'minecraft:air', x: 20, y: 50, z: 0 }, { blockId: 'minecraft:netherrack', x: 40, y: 52, z: 20 }] }));
		const later = observation({ gameTime: 200, blocks: Array.from({ length: 1024 }, (_, index) => ({ blockId: 'minecraft:stone', x: 1000 + index, y: 50, z: 0 })) });
		first.ingest('a', later);
		assert.equal(first.candidates('a', later).total, 0, 'a removed block and a buried top stay disproven after 1,024 newer blocks evict both records');
		assert.deepEqual(Object.keys(first.candidates('a', later).coverage.headings).sort(), ['E', 'SE'], 'both sectors keep their sighting history');
		await first.flush('a');
		const second = new ExplorationOccupancy({ memoryStore: new ObservedMemoryStore({ directory }) });
		await second.load('a');
		assert.equal(second.candidates('a', later).total, 0, 'the disproven surfaces are not saved');
		second.ingest('a', observation({ gameTime: 300, landmarks: [{ blockId: 'minecraft:stone', x: 20, y: 50, z: 0 }] }));
		assert.deepEqual(second.candidates('a', observation({ gameTime: 300 })).candidates.map(({ x, y }) => [x, y]), [[20, 51]], 'seen again, it is a surface again');
		second.ingest('a', observation({ gameTime: 310, blocks: [{ blockId: 'minecraft:stone', x: 20, y: 50, z: 0 }, { blockId: 'minecraft:air', x: 20, y: 51, z: 0 }] }));
		assert.equal(second.candidates('a', observation({ gameTime: 310 })).total, 1, 'the same material and open air above agree with it');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('movement the samples cannot explain is uncertain, never a climb', () => {
	const slow = new ExplorationOccupancy();
	slow.ingest('a', observation({ gameTime: 100 }));
	slow.beginTravel('a');
	slow.ingest('a', observation({ x: 20.5, y: 80, gameTime: 110 }));
	assert.deepEqual(slow.endTravel('a'), { feetDy: 16, lowestGroundY: 64, unexplainedGaps: 1 }, 'a grounded 16-block rise in ten ticks is not walking');
	assert.deepEqual(['travelled', 'climbed'].map((field) => slow.candidates('a', observation({ x: 20.5, y: 80, gameTime: 111 })).coverage[field]), [0, 0]);

	const short = new ExplorationOccupancy();
	short.ingest('a', observation({ gameTime: 100 }));
	short.beginTravel('a');
	short.ingest('a', observation({ x: 3.5, y: 65, gameTime: 101 }));
	assert.deepEqual(short.endTravel('a'), { feetDy: 1, lowestGroundY: 64, unexplainedGaps: 1 }, 'three blocks in one tick is not walking');

	const unobserved = new ExplorationOccupancy();
	unobserved.ingest('a', observation({ gameTime: 100 }));
	unobserved.beginTravel('a');
	unobserved.ingest('a', observation({ x: 10.5, y: 66, gameTime: 600 }));
	assert.equal(unobserved.endTravel('a').unexplainedGaps, 1, 'a gap longer than the teleport report window may hide one');
});

test('a teleport the player saw ends the journey, even within walking distance', () => {
	const pearl = new ExplorationOccupancy();
	pearl.ingest('a', observation({ gameTime: 100 }));
	pearl.beginTravel('a');
	pearl.ingest('a', observation({ x: 2.5, y: 65, gameTime: 110, player: { teleportTick: 108 } }));
	assert.equal(pearl.endTravel('a'), null);
	pearl.ingest('a', observation({ x: 3.5, y: 65, gameTime: 120, player: { teleportTick: 108 } }));
	pearl.ingest('a', observation({ x: 4.5, y: 66, gameTime: 130 }));
	const coverage = pearl.candidates('a', observation({ x: 4.5, y: 66, gameTime: 131 })).coverage;
	assert.deepEqual([coverage.travelled, coverage.climbed], [2, 1], 'the same mark again, or an expired one, continues the motion after the teleport');

	const respawn = new ExplorationOccupancy();
	respawn.ingest('a', observation({ gameTime: 100, player: { teleportTick: 20 } }));
	respawn.beginTravel('a');
	respawn.ingest('a', observation({ x: 20.5, y: 80, gameTime: 200, player: { teleportTick: 150 } }));
	assert.equal(respawn.endTravel('a'), null, 'a respawn without a dead sample still carries its teleport mark');

	const terminal = new ExplorationOccupancy();
	terminal.ingest('a', observation({ gameTime: 100 }));
	terminal.beginTravel('a');
	assert.equal(terminal.endTravel('a', { position: { x: 2.5, y: 64, z: 0.5 }, worldTick: 110, onGround: true, teleportTick: 105 }), null, 'an action result carries the mark too');

	// Review round 3: the jar reports a second teleport in the same tick as the next mark (PlayerTeleports.Teleport).
	const sameTick = new ExplorationOccupancy();
	sameTick.ingest('a', observation({ gameTime: 90 }));
	sameTick.ingest('a', observation({ x: 3.5, gameTime: 100, player: { teleportTick: 100 } }));
	sameTick.beginTravel('a');
	sameTick.ingest('a', observation({ x: 4.5, y: 65, gameTime: 100, player: { teleportTick: 101 } }));
	assert.equal(sameTick.endTravel('a'), null, 'a second teleport within one tick is not walking or climbing');
});

test('riding, gliding and launches explain fast movement without inventing footholds', () => {
	const glide = new ExplorationOccupancy();
	glide.ingest('a', observation({ gameTime: 100 }));
	glide.beginTravel('a');
	glide.ingest('a', observation({ y: 67, gameTime: 101, onGround: false, player: { gliding: true } }));
	assert.deepEqual(glide.endTravel('a'), { feetDy: 3, lowestGroundY: 64, endOnGround: false });

	const knockback = new ExplorationOccupancy();
	knockback.ingest('a', { ...observation({ gameTime: 100 }), velocity: { x: 0.9, y: 0.4, z: 0 } });
	knockback.beginTravel('a');
	knockback.ingest('a', observation({ x: 4.5, y: 63, gameTime: 102 }));
	assert.deepEqual(knockback.endTravel('a'), { feetDy: -1, descendedAtLeast: 1, lowestGroundY: 63 }, 'launch velocity at the start of the gap explains it');

	const minecart = new ExplorationOccupancy();
	minecart.ingest('a', observation({ gameTime: 100 }));
	minecart.beginTravel('a');
	minecart.ingest('a', observation({ x: 8.5, y: 70, gameTime: 110, player: { passenger: true } }));
	assert.deepEqual(minecart.endTravel('a'), { feetDy: 6, lowestGroundY: 64, endOnGround: false });
});

test('an authoritative terminal in the same tick as the last sample replaces it without double counting', () => {
	const start = () => {
		const occupancy = new ExplorationOccupancy();
		occupancy.ingest('a', observation({ gameTime: 100 }));
		occupancy.beginTravel('a');
		return occupancy;
	};
	let occupancy = start();
	occupancy.ingest('a', observation({ x: 3.5, y: 60, gameTime: 120, onGround: false }));
	assert.deepEqual(occupancy.endTravel('a', observation({ x: 3.5, y: 60, gameTime: 120 })), { feetDy: -4, descendedAtLeast: 4, lowestGroundY: 60 }, 'its grounding confirms the landing');
	occupancy = start();
	occupancy.ingest('a', observation({ x: 3.5, y: 61, gameTime: 120, onGround: false }));
	assert.deepEqual(occupancy.endTravel('a', observation({ x: 3.5, y: 60, gameTime: 120 })), { feetDy: -4, descendedAtLeast: 4, lowestGroundY: 60 }, 'its position replaces the sample');
	occupancy = start();
	occupancy.ingest('a', observation({ x: 3.5, y: 60, gameTime: 120 }));
	assert.deepEqual(occupancy.endTravel('a', { position: { x: 3.5, y: 60, z: 0.5 }, worldTick: 120, onGround: true }), { feetDy: -4, descendedAtLeast: 4, lowestGroundY: 60 }, 'the landing already ingested is not added twice');
	occupancy = start();
	occupancy.ingest('a', observation({ x: 3.5, y: 60, gameTime: 120, onGround: false }));
	assert.deepEqual(occupancy.endTravel('a', { position: { x: 3.5, y: 60, z: 0.5 }, worldTick: 120 }), { feetDy: -4, lowestGroundY: 64, endOnGround: false }, 'a terminal without flags keeps the same-tick sample\'s grounding');
	occupancy = start();
	occupancy.ingest('a', observation({ x: 3.5, y: 60, gameTime: 120 }));
	assert.deepEqual(occupancy.endTravel('a', { position: { x: 1.5, y: 64, z: 0.5 }, worldTick: 110, onGround: true }), { feetDy: -4, descendedAtLeast: 4, lowestGroundY: 60 }, 'an older terminal is ignored');
});

test('a navigation result states its own grounding', () => {
	const occupancy = new ExplorationOccupancy();
	occupancy.ingest('a', observation({ gameTime: 100 }));
	occupancy.beginTravel('a');
	assert.deepEqual(occupancy.endTravel('a', { position: { x: 3.5, y: 61, z: 0.5 }, worldTick: 120, onGround: true }), { feetDy: -3, descendedAtLeast: 3, lowestGroundY: 61 });
	occupancy.beginTravel('a');
	assert.deepEqual(occupancy.endTravel('a', { position: { x: 3.5, y: 61, z: 0.5 }, worldTick: 120, onGround: false }), { feetDy: -3, lowestGroundY: 64, endOnGround: false }, 'in a fluid or riding the server sends false');
});

test('a saved surface that saved blocks disprove is dropped on load, before those blocks can be evicted', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'frontier-'));
	try {
		const first = new ExplorationOccupancy({ memoryStore: new ObservedMemoryStore({ directory }) });
		await first.load('a');
		first.ingest('a', observation({ gameTime: 100, landmarks: [{ blockId: 'minecraft:stone', x: 20, y: 50, z: 0 }] }));
		await first.flush('a');
		// An older build kept the surface while the air record that disproves it sat in the block map.
		const [file] = (await readdir(directory)).filter((name) => name.endsWith('.json'));
		const saved = JSON.parse(await readFile(join(directory, file), 'utf8'));
		const stone = saved.scopes[0].blocks.find((block) => block.key === '20,50,0');
		Object.assign(stone, { blockId: 'minecraft:air', lastSeenTick: 120 });
		await writeFile(join(directory, file), JSON.stringify(saved));
		const second = new ExplorationOccupancy({ memoryStore: new ObservedMemoryStore({ directory }) });
		await second.load('a');
		const later = observation({ gameTime: 200, blocks: Array.from({ length: 1024 }, (_, index) => ({ blockId: 'minecraft:stone', x: 1000 + index, y: 50, z: 0 })) });
		second.ingest('a', later);
		assert.equal(second.candidates('a', later).total, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('recent travel shows useful displacement and places walked through again, so circling is visible', () => {
	const straight = new ExplorationOccupancy();
	let tick = walk(straight, Array.from({ length: 11 }, (_, i) => [0.5 + i * 8, 64, 0.5]), { step: 40 });
	const line = straight.candidates('a', observation({ x: 80.5, gameTime: tick })).coverage.recent;
	assert.deepEqual(line, { walked: 72, net: 72, revisits: 0 }, 'a straight walk: net equals walked, nothing revisited');
	assert.deepEqual(straight.recentTravel('a', observation({ x: 80.5, gameTime: tick })), line);

	const circling = new ExplorationOccupancy();
	const loop = [[0.5, 0.5], [10.5, 0.5], [10.5, 10.5], [0.5, 10.5]];
	const points = [];
	for (let lap = 0; lap < 4; lap += 1) for (const [x, z] of loop) points.push([x, 64, z]);
	points.push([0.5, 64, 0.5]);
	tick = walk(circling, points, { step: 40 });
	const recent = circling.candidates('a', observation({ gameTime: tick })).coverage.recent;
	assert.ok(recent.walked >= 150 && recent.net <= 10, `four laps: much walking, no displacement ${JSON.stringify(recent)}`);
	assert.ok(recent.revisits >= 10, `laps cross their own track ${JSON.stringify(recent)}`);

	const short = new ExplorationOccupancy();
	tick = walk(short, [[0.5, 64, 0.5], [8.5, 64, 0.5], [16.5, 64, 0.5]]);
	assert.equal(short.candidates('a', observation({ x: 16.5, gameTime: tick })).coverage.recent, undefined, 'too short a walk says nothing');

	const teleported = new ExplorationOccupancy();
	tick = walk(teleported, Array.from({ length: 6 }, (_, i) => [0.5 + i * 8, 64, 0.5]));
	tick = walk(teleported, Array.from({ length: 6 }, (_, i) => [500.5 + i * 8, 64, 0.5]), { start: tick + 1000 });
	assert.deepEqual(teleported.candidates('a', observation({ x: 540.5, gameTime: tick })).coverage.recent, { walked: 32, net: 32, revisits: 0 }, 'a gap starts a new recent walk; net never spans the jump');
});

const recentWalkFixtures = {
	straight: Array.from({ length: 11 }, (_, i) => [0.5 + i * 8, 64, 0.5]),
	longStraight: Array.from({ length: 161 }, (_, i) => [0.5 + i, 64, 0.5]),
	circling: [...Array.from({ length: 4 }, () => [[0.5, 64, 0.5], [10.5, 64, 0.5], [10.5, 64, 10.5], [0.5, 64, 10.5]]).flat(), [0.5, 64, 0.5]],
	ascendingFloors: [...Array.from({ length: 4 }, (_, floor) => [[0.5, 64 + floor * 4, 0.5], [10.5, 65 + floor * 4, 0.5], [10.5, 66 + floor * 4, 10.5], [0.5, 67 + floor * 4, 10.5]]).flat(), [0.5, 80, 0.5]],
};

test('ascending through distinct floors is displacement, not revisiting a flat loop', () => {
	const results = {};
	for (const name of ['circling', 'ascendingFloors']) {
		const occupancy = new ExplorationOccupancy();
		const points = recentWalkFixtures[name];
		const gameTime = walk(occupancy, points);
		const [x, y, z] = points.at(-1);
		results[name] = occupancy.recentTravel('a', observation({ x, y, z, gameTime }));
	}
	assert.deepEqual(results.circling, { walked: 150, net: 10, revisits: 12 });
	assert.deepEqual(results.ascendingFloors, { walked: 150, net: 18, revisits: 0 });
	assert.ok(results.ascendingFloors.revisits < 4, 'a failed move upstairs must not acquire the circling decorator');
});

test('recent displacement is paid within fresh and same-session frontier replies, including surveys and pagination', () => {
	const size = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
	for (const [name, points] of Object.entries(recentWalkFixtures)) for (const surveyed of [false, true]) for (const limit of [8, 1]) {
		const occupancy = new ExplorationOccupancy();
		const gameTime = walk(occupancy, points);
		const [x, y, z] = points.at(-1);
		const view = observation({ x, y, z, gameTime });
		if (surveyed) survey(occupancy, view);
		const value = { ...occupancy.candidates('a', view, { limit }), freshness: { fresh: true, ageMs: 0 } };
		const baseline = structuredClone(value);
		delete baseline.coverage.recent;
		delete baseline.coverage.legend;
		baseline.coverage.headingKey = '[walked, seen] farthest; then [sight range, ageS] of a complete survey near here';
		// Before this change the provider sent all of these fields; the unchanged fact encoder remains the byte baseline.
		const baselineBytes = size(encodeModelFacts(baseline));
		const session = new ModelObservationViews();
		for (const phase of ['fresh', 'same-session']) {
			const shown = presentNativeToolResult(value, { kind: 'explore_frontier', arguments: { limit } }, session);
			shown.commit();
			const text = shown.response.contentItems[0].text;
			assert.ok(size(text) <= baselineBytes, `${name}, survey=${surveyed}, limit=${limit}, ${phase}: ${size(text)} > ${baselineBytes}`);
			const decoded = decodeModelFacts(JSON.parse(text));
			if (decoded.total === undefined) decoded.total = decoded.candidates.length;
			for (const candidate of decoded.candidates) candidate.dy ??= candidate.y - decoded.at.y;
			assert.deepEqual(decoded, value, 'every omitted fact must reconstruct exactly from this same reply');
		}
		assert.ok(surveyed ? value.coverage.legend.includes('nearFullSurvey') : !value.coverage.legend?.includes('Survey'));
	}
});

test('a survey from a different vertical level is not reported as a full survey near here', () => {
	const surveyedAt = (y) => {
		const occupancy = new ExplorationOccupancy();
		const surface = observation({ x: 0.5, y: 64, z: 0.5, gameTime: 20 });
		occupancy.ingest('a', surface, { snapshot: false });
		survey(occupancy, surface);
		const view = observation({ x: 0.5, y, z: 0.5, gameTime: 620 });
		const coverage = occupancy.candidates('a', view, { limit: 8 }).coverage;
		return Object.values(coverage.headings ?? {}).some(row => row.length > 2);
	};
	assert.equal(surveyedAt(64), true, 'same level keeps the survey');
	assert.equal(surveyedAt(64 + 31), true, 'within 32 blocks vertically keeps the survey');
	assert.equal(surveyedAt(-50), false, 'a cave far below the surface survey does not inherit it');
	assert.equal(surveyedAt(64 + 40), false, 'a pillar far above the survey does not inherit it');
});

test('frontier byte benchmark CLI measures from a checkout path containing spaces', async () => {
	const { execFile } = await import('node:child_process');
	const { symlink } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	const scratch = await mkdtemp(join(tmpdir(), 'frontier-cli-'));
	try {
		const spaced = join(scratch, 'repo with spaces');
		await symlink(fileURLToPath(new URL('..', import.meta.url)), spaced, 'junction');
		const run = (args) => new Promise((resolve) => execFile(process.execPath, ['--preserve-symlinks-main', join(spaced, 'src', 'benchmark', 'frontier-bytes.mjs'), ...args], { windowsHide: true }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
		for (const args of [[], [join(spaced, 'src')]]) {
			const { code, stdout } = await run(args);
			assert.equal(code, 0);
			const measurement = JSON.parse(stdout);
			assert.ok(measurement.bytes > 0 && measurement.samples > 0, args.join(' '));
		}
	} finally { await rm(scratch, { recursive: true, force: true }); }
});
