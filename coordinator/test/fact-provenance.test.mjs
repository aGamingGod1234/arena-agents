import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactLifecycle, LIFECYCLE_BINDINGS, deadSample, directBlockEvidence, freshEvidence, invalidated, provenance } from '../src/fact-provenance.mjs';
import { AtomicAgentStore, ObservedMemoryStore } from '../src/observed-memory-store.mjs';
import { TaskMemoryStore } from '../src/task-memory-store.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { PlacedWorkstations } from '../src/resource-facts.mjs';
import { RecoveryProgressStore } from '../src/recovery-progress-wrap.mjs';
import { createSearch, observeSearch } from '../src/search-coverage.mjs';

// One replayed life shared by the store tests: alive in the Overworld, a death (by any of the dead-sample shapes), a
// respawn, a trip to the Nether and back, then a coordinator restart reading the saved records.
const WORLD = 'replay-world', OVERWORLD = 'minecraft:overworld', NETHER = 'minecraft:the_nether';
const table = 'minecraft:crafting_table', log = 'minecraft:oak_log';
const live = (tick, extra = {}) => ({ ready: true, observedAtEpochMs: tick * 50, position: { x: 0, y: 64, z: 0 }, player: { dead: false, health: 20, x: 0, y: 64, z: 0 },
	world: { worldId: WORLD, dimension: OVERWORLD, gameTime: tick }, inventory: { items: [] }, blocks: [], ...extra });
const DEATHS = {
	flag: tick => ({ ready: false, observedAtEpochMs: tick * 50, player: { dead: true } }),
	phase: tick => ({ ready: true, observedAtEpochMs: tick * 50, player: { health: 5 }, continuity: { phase: 'dead' } }),
	health: tick => ({ ready: true, observedAtEpochMs: tick * 50, player: { health: 0 } }),
	status: tick => ({ observedAtEpochMs: tick * 50, status: 'PLAYER_DEAD' }),
};
const nether = (tick, extra = {}) => live(tick, { world: { worldId: WORLD, dimension: NETHER, gameTime: tick }, ...extra });
const placeReceipt = (tick, x = 20) => ({ actionId: `place-${tick}`, actionType: 'place_block', arguments: { x, y: 64, z: 0, itemId: table, face: 'up' },
	state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', observedAtEpochMs: tick * 50, actionObservation: { worldTick: tick, observedAtEpochMs: tick * 50 } });

test('one death test covers every dead-sample shape the stores used to test separately', () => {
	for (const [shape, sample] of Object.entries(DEATHS)) assert.equal(deadSample(sample(1)), true, shape);
	assert.equal(deadSample(live(1)), false);
	assert.equal(deadSample({ ready: false }), false, 'a not-ready sample is not a death');
});

test('direct evidence is current rows plus the crosshair cell; remembered, sound, hidden and stale rows are not evidence', () => {
	const ray = { type: 'block', x: 1, y: 64, z: 0, blockId: 'minecraft:stone' };
	const cells = directBlockEvidence(live(1, { blocks: [{ x: 1, y: 64, z: 0, blockId: log }, { x: 2, y: 64, z: 0, blockId: log, perceivedBy: 'sound' },
		{ x: 3, y: 64, z: 0, blockId: log, visible: false }, { x: 4, y: 64, z: 0, blockId: log, stale: true }], interaction: { rayTarget: ray } }));
	assert.deepEqual([...cells.keys()], ['1,64,0']);
	assert.equal(cells.get('1,64,0').blockId, log, 'a row for the hit cell takes precedence');
	const rayOnly = directBlockEvidence(live(1, { interaction: { rayTarget: { ...ray, x: 9 } } }));
	assert.deepEqual([...rayOnly.values()].map(cell => [cell.x, cell.via]), [[9, 'ray']]);
	const remembered = directBlockEvidence(live(1, { blocks: [{ x: 1, y: 64, z: 0, blockId: log }], interaction: { rayTarget: ray },
		continuity: { rememberedSections: ['blocks', 'interaction'] } }));
	assert.equal(remembered.size, 0, 'a remembered copy is not a fresh sighting');
});

test('newer evidence only: an older sample cannot change a fact, and a receipt outranks a same-tick sample without wall time', () => {
	assert.equal(freshEvidence({ lastSeenTick: 10, observedAtEpochMs: 500 }, { lastSeenTick: 9, observedAtEpochMs: 600 }), false);
	assert.equal(freshEvidence({ lastSeenTick: 10 }, { lastSeenTick: 10 }), true);
	assert.equal(freshEvidence({ source: 'action_receipt', lastSeenTick: 10, observedAtEpochMs: 500 }, { lastSeenTick: 10 }), false);
	assert.equal(freshEvidence(null, {}), true);
});

test('the envelope is one short field: source, age, and a later disproof', () => {
	const now = { observedAtEpochMs: 10_000_000 };
	assert.equal(provenance('seen', { observedAtEpochMs: now.observedAtEpochMs - 42_000 }, now), 'seen 42s');
	assert.equal(provenance('did', { observedAtEpochMs: now.observedAtEpochMs - 240_000 }, now, { observedAtEpochMs: now.observedAtEpochMs - 20_000 }), 'did 4m; disproved 20s');
	assert.equal(provenance('told', { observedAtEpochMs: now.observedAtEpochMs - 3 * 3_600_000 }, now), 'told 3h');
	assert.equal(provenance('inferred', { tick: 100 }, { tick: 300 }), 'inferred 10s', 'ticks when wall time is missing');
	assert.equal(provenance('seen', {}, now), 'seen', 'an unknown age is left out, not guessed');
	assert.equal(provenance('seen', { observedAtEpochMs: now.observedAtEpochMs + 5 }, now), 'seen', 'a clock from the future is unknown');
	assert.throws(() => provenance('guessed', {}, now));
	assert.ok(Buffer.byteLength(JSON.stringify({ src: provenance('did', { observedAtEpochMs: 0 }, { observedAtEpochMs: 240_000 }, { observedAtEpochMs: 220_000 }) })) <= 32);
});

test('the binding table decides what each lifecycle change ends; a rotation ends no stored fact', () => {
	assert.deepEqual(Object.keys(LIFECYCLE_BINDINGS), ['carried', 'life', 'body', 'world', 'note']);
	assert.equal(invalidated('carried', { died: true }), true);
	assert.equal(invalidated('world', { died: true }), false, 'a player remembers where things are after dying');
	assert.equal(invalidated('world', { dimension: { from: OVERWORLD, to: NETHER } }), false, 'world facts are scoped per dimension, not erased');
	assert.equal(invalidated('life', { restarted: true }), true);
	assert.equal(invalidated('body', { respawned: true }), true);
	assert.equal(invalidated('note', { died: true, world: {}, restarted: true }), false);
	assert.equal(invalidated('carried', { rotated: true }), false);
	assert.equal(invalidated('carried', null), false);
	assert.throws(() => invalidated('guess', {}));
});

test('lifecycle replay: death, respawn, portal and restart, and what a mark written before them reads afterwards', () => {
	const lifecycle = new FactLifecycle('run-1');
	assert.equal(lifecycle.observe(live(1)), null);
	const mark = lifecycle.mark();
	assert.deepEqual(mark, { deaths: 0, dimension: OVERWORLD, session: 'run-1' });
	assert.deepEqual(lifecycle.observe(DEATHS.phase(2)), { died: true });
	assert.equal(lifecycle.observe(DEATHS.flag(3)), null, 'one death, however many dead samples');
	assert.deepEqual(lifecycle.observe(live(4)), { respawned: true });
	assert.deepEqual(lifecycle.observe(nether(5)), { dimension: { from: OVERWORLD, to: NETHER } });
	assert.deepEqual(lifecycle.since(mark), { deaths: 1, dimension: { from: OVERWORLD, to: NETHER } });
	const restored = FactLifecycle.restore(JSON.parse(JSON.stringify(lifecycle)), { session: 'run-2' });
	assert.deepEqual(restored.observe(nether(6)), { restarted: true });
	assert.deepEqual(restored.since(mark), { deaths: 1, dimension: { from: OVERWORLD, to: NETHER }, restarted: true });
	assert.equal(restored.observe(nether(7)), null);
	const sameRun = FactLifecycle.restore(JSON.parse(JSON.stringify(lifecycle)), { session: 'run-1' });
	assert.equal(sameRun.observe(nether(6)), null, 'a record saved by this run is not a restart');
	const early = new FactLifecycle('run-3'); early.observe(DEATHS.flag(1));
	assert.equal(FactLifecycle.restore({ deaths: 2, session: 'run-2' }, { after: early }).deaths, 3, 'a death seen before the saved record loaded still counts');
});

test('seen-memory replay: sightings outlive death and travel with their age, and only a direct sighting removes one', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'fact-seen-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const record = { currentGoal: 'collect oak logs' };
	const memory = new ObservedMemoryStore({ directory });
	await memory.load('a');
	memory.ingest('a', live(100, { blocks: [{ x: 5, y: 64, z: 0, blockId: log }] }));
	for (const shape of Object.keys(DEATHS)) assert.equal(memory.recentlySeen('a', DEATHS[shape](110), record), null, `${shape}: a dead body reads no memory`);
	memory.ingest('a', DEATHS.flag(110));
	memory.ingest('a', live(120));
	assert.deepEqual(memory.recentlySeen('a', live(120), record), { blocks: [{ blockId: log, x: 5, y: 64, z: 0, src: 'seen 1s' }] }, 'a respawned player still remembers it');
	memory.ingest('a', nether(130));
	assert.equal(memory.recentlySeen('a', nether(130), record), null, 'another dimension has its own memory');
	memory.ingest('a', live(140));
	assert.equal(memory.recentlySeen('a', live(140), record).blocks[0].src, 'seen 2s');
	await memory.flush('a');
	const restarted = new ObservedMemoryStore({ directory });
	await restarted.load('a');
	restarted.ingest('a', live(150));
	assert.equal(restarted.recentlySeen('a', live(150), record).blocks[0].src, 'seen 3s', 'the age survives a restart');
	restarted.ingest('a', live(160, { blocks: [{ x: 5, y: 64, z: 0, blockId: log }], continuity: { rememberedSections: ['blocks', 'interaction'] }, interaction: { rayTarget: { type: 'block', x: 5, y: 64, z: 0, blockId: 'minecraft:air' } } }));
	assert.notEqual(restarted.recentlySeen('a', live(161), record), null, 'remembered sections and a remembered ray are not evidence');
	restarted.ingest('a', live(170, { interaction: { rayTarget: { type: 'block', x: 5, y: 64, z: 0, blockId: 'minecraft:air' } } }));
	assert.equal(restarted.recentlySeen('a', live(171), record), null, 'the crosshair saw the cell empty');
});

test('task-memory replay: own receipt, disproof, death, dimension and restart each show in the row envelope', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'fact-task-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const scope = { agentId: 'a', goalRevision: 1, worldId: WORLD, dimension: OVERWORLD };
	const netherScope = { ...scope, dimension: NETHER };
	const store = new TaskMemoryStore({ directory });
	await store.observe(scope, live(100, { inventory: { items: [{ itemId: table, count: 1 }] } }));
	await store.remember(scope, { kind: 'place', key: 'base', label: 'base', summary: 'shelter by the lake', position: { x: 0, y: 64, z: 0 } });
	await store.recordReceipt(scope, placeReceipt(110));
	await store.observe(scope, live(120));
	let summary = await store.summary(scope);
	assert.equal(summary.assets[0].src, 'did 1s');
	assert.equal(summary.places[0].src, 'told 1s');
	assert.equal(summary.historical, undefined, 'src replaces the blanket historical flag');
	assert.equal(summary.places[0].source, undefined);
	await store.observe(scope, live(160, { blocks: [{ x: 20, y: 64, z: 0, blockId: 'minecraft:air' }] }));
	summary = await store.summary(scope);
	assert.deepEqual([summary.assets[0].state, summary.assets[0].src], ['missing', 'did 3s; disproved 0s'], 'the claim and the sighting that disproved it');
	await store.observe(scope, live(170, { inventory: { items: [{ itemId: table, count: 1 }] } }));
	assert.ok((await store.summary(scope)).assets.some(asset => asset.state === 'carried'));
	await store.observe(scope, { ...DEATHS.flag(180), world: { worldId: WORLD, dimension: OVERWORLD }, death: { cause: 'lava', diedAtEpochMs: 180 * 50, x: 1, y: 60, z: 1 } });
	await store.observe(scope, live(200));
	summary = await store.summary(scope);
	assert.equal(summary.deaths[0].src, 'seen 1s');
	assert.equal(summary.deaths[0].diedAtEpochMs, undefined, 'the age replaces the raw clock');
	assert.equal(summary.assets.some(asset => asset.state === 'carried'), false, 'carried items end at death');
	await store.observe(netherScope, nether(220));
	assert.deepEqual((await store.summary(netherScope)).places, [], 'each dimension keeps its own records');
	await store.flush();
	const restarted = new TaskMemoryStore({ directory });
	await restarted.observe(scope, live(240));
	summary = await restarted.summary(scope);
	assert.equal(summary.places[0].src, 'told 7s', 'a note keeps its written age across a restart');
	assert.equal(summary.assets[0].src, 'did 7s; disproved 4s');
	assert.equal(summary.deaths.length, 1);
	await restarted.flush();
});

test('plan replay: death in any dead shape ends presence, restart re-proves it, and the lifecycle mark survives both', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'fact-plan-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const record = { agentId: 'a', currentGoal: 'Visit the Nether', goalRevision: 1 };
	const steps = [{ id: 'gear', label: 'gear', detail: '', status: 'pending', check: 'has:minecraft:flint_and_steel*1', dependsOn: [], kind: 'inventory', evidence: null },
		{ id: 'there', label: 'there', detail: '', status: 'pending', check: 'in:minecraft:the_nether', dependsOn: ['gear'], kind: 'world', evidence: null }];
	const status = (views, id) => views.snapshot(record).plan.steps.find(step => step.id === id).status;
	const flint = { inventory: { items: [{ itemId: 'minecraft:flint_and_steel', count: 1 }] } };
	for (const shape of Object.keys(DEATHS)) {
		const views = new LiveTaskViews({ now: () => 0 });
		views.suggest(record.agentId, record.currentGoal, { steps });
		await views.observe(record, nether(100, flint));
		assert.equal(status(views, 'there'), 'complete');
		await views.observe(record, DEATHS[shape](110));
		await views.observe(record, nether(120));
		assert.notEqual(status(views, 'there'), 'complete', `${shape}: presence is life-bound`);
		assert.equal(views.lifecycle(record).deaths, 1, shape);
	}
	const views = new LiveTaskViews({ directory, now: () => 0 });
	views.suggest(record.agentId, record.currentGoal, { steps });
	await views.observe(record, live(100, flint));
	const mark = views.lifecycle(record).mark();
	await views.observe(record, DEATHS.flag(110));
	await views.observe(record, nether(120, flint));
	assert.equal(status(views, 'there'), 'complete');
	assert.deepEqual(views.lifecycle(record).since(mark), { deaths: 1, dimension: { from: OVERWORLD, to: NETHER } });
	await views.flush();
	const restarted = new LiveTaskViews({ directory, now: () => 0 });
	await restarted.observe(record, nether(130));
	assert.notEqual(status(restarted, 'there'), 'complete', 'a restart may have missed a death');
	assert.equal(restarted.lifecycle(record).deaths, 1);
	assert.equal(restarted.lifecycle(record).since(mark).deaths, 1);
	await restarted.observe(record, nether(140, flint));
	assert.equal(status(restarted, 'there'), 'complete', 're-proven by fresh evidence');
	await restarted.flush();
});

test('placed-workstation replay: kept through death, hidden in other dimensions, retired only by direct evidence or own receipt', () => {
	const placed = new PlacedWorkstations();
	const at = (tick, extra = {}) => live(tick, { position: { x: 0, y: 64, z: 0 }, ...extra });
	placed.onActionResult('a', { actionType: 'place_block', arguments: { x: 20, y: 64, z: 0, itemId: table }, state: 'SUCCEEDED', observedAtEpochMs: 100 * 50 }, live(99));
	assert.deepEqual(placed.leftBehind('a', at(160)), [{ blockId: table, x: 20, y: 64, z: 0, distance: 21, src: 'did 3s' }]);
	assert.equal(placed.leftBehind('a', at(200)).length, 1, 'the station outlives the agent dying (world binding)');
	assert.deepEqual(placed.leftBehind('a', nether(210, { position: { x: 0, y: 64, z: 0 } })), []);
	for (const row of [{ perceivedBy: 'sound' }, { visible: false }]) assert.equal(placed.leftBehind('a', at(220, { blocks: [{ x: 20, y: 64, z: 0, blockId: 'minecraft:air', ...row }] })).length, 1);
	assert.equal(placed.leftBehind('a', at(220, { landmarks: [{ x: 20, y: 64, z: 0, blockId: 'minecraft:air' }], continuity: { rememberedSections: ['landmarks'] } })).length, 1, 'a remembered landmark is not a sighting');
	assert.equal(placed.leftBehind('a', nether(225, { blocks: [{ x: 20, y: 64, z: 0, blockId: 'minecraft:netherrack' }] })).length, 0);
	assert.equal(placed.leftBehind('a', at(226)).length, 1, 'a Nether block at the same numbers is not the Overworld cell');
	assert.deepEqual(placed.leftBehind('a', at(230, { interaction: { rayTarget: { type: 'block', x: 20, y: 64, z: 0, blockId: 'minecraft:air' } } })), [], 'the crosshair saw it gone');
	placed.onActionResult('a', { actionType: 'place_block', arguments: { x: 30, y: 64, z: 0, itemId: table }, state: 'SUCCEEDED' }, live(240));
	placed.onActionResult('a', { actionType: 'break_block', arguments: { x: 30, y: 64, z: 0 }, state: 'SUCCEEDED' }, live(241));
	assert.deepEqual(placed.leftBehind('a', at(250)), []);
});

test('recovery replay: a remembered placed station survives death, and the same direct evidence or own break receipt ends it', () => {
	const recovery = new RecoveryProgressStore();
	const station = { blocks: [{ x: 3, y: 64, z: 0, blockId: 'minecraft:furnace' }] };
	const remembered = observation => recovery.snapshot('a', observation)?.alreadyHaveFacts.filter(entry => entry.remembered) ?? [];
	recovery.remember('a', 1, live(100, station));
	recovery.remember('a', 1, { ...DEATHS.flag(110), death: { cause: 'fall', diedAtEpochMs: 110 * 50, x: 0, y: 64, z: 0, dimensionId: OVERWORLD } });
	recovery.remember('a', 1, live(120));
	assert.equal(remembered(live(120)).length, 1, 'world binding: a death does not erase a placed station');
	assert.equal(remembered(nether(130)).length, 0, 'shown only in its own dimension');
	recovery.remember('a', 1, live(140, { blocks: [{ x: 3, y: 64, z: 0, blockId: 'minecraft:air', perceivedBy: 'sound' }] }));
	assert.equal(remembered(live(141)).length, 1, 'a sound is not a sighting');
	recovery.recordResult('a', live(150), { actionType: 'break_block', arguments: { x: 3, y: 64, z: 0 }, state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' });
	assert.equal(remembered(live(151)).length, 0, 'the agent broke it');
	recovery.remember('a', 1, live(160, station));
	recovery.remember('a', 1, live(170, { interaction: { rayTarget: { type: 'block', x: 3, y: 64, z: 0, blockId: 'minecraft:air' } } }));
	assert.equal(remembered(live(171)).length, 0, 'the crosshair saw it gone');
});

test('search motion replay: death, respawn and portal end one journey (body binding)', () => {
	const search = createSearch();
	const step = (observation, x) => observeSearch(search, observation, { x, y: 64, z: 0 }, observation.world?.gameTime ?? 0);
	step(live(100), 0); step(live(101), 0.2);
	assert.equal(step(live(102), 0.4).continuity, 'same');
	for (const shape of Object.keys(DEATHS)) {
		assert.equal(step({ ...DEATHS[shape](103), world: { gameTime: 103 } }, 0.4).continuity, 'break', shape);
		assert.equal(search.motion, null, shape);
		step(live(104), 0.4);
	}
	const memory = new ObservedMemoryStore();
	memory.ingest('a', live(100)); memory.ingest('a', live(101, { position: { x: 0.2, y: 64, z: 0 } }));
	memory.ingest('a', nether(102));
	memory.ingest('a', live(103));
	assert.notEqual(memory.search('a', { worldId: WORLD, dimension: OVERWORLD }).motion?.tick, 101, 'returning through a portal does not continue the old motion');
});

test('task-memory replay: a death in another dimension is still recalled after the respawn and a restart', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'fact-diedin-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const scope = { agentId: 'a', goalRevision: 1, worldId: WORLD, dimension: OVERWORLD };
	const netherScope = { ...scope, dimension: NETHER };
	const store = new TaskMemoryStore({ directory });
	await store.observe(netherScope, nether(100, { inventory: { items: [{ itemId: 'minecraft:diamond_helmet', count: 1 }] } }));
	await store.observe(netherScope, { ...DEATHS.flag(110), world: { worldId: WORLD, dimension: NETHER }, death: { cause: 'lava', diedAtEpochMs: 110 * 50, x: 0, y: 40, z: 0 } });
	await store.observe(scope, live(130));
	const before = (await store.summary(scope)).deaths;
	assert.deepEqual(before.map(death => [death.dimension, death.cause, death.src]), [[NETHER, 'lava', 'seen 1s']]);
	await store.flush();
	const restarted = new TaskMemoryStore({ directory });
	await restarted.observe(scope, live(150));
	assert.deepEqual((await restarted.summary(scope)).deaths.map(death => [death.dimension, death.cause, death.src]), [[NETHER, 'lava', 'seen 2s']], 'the restarted coordinator still knows where it died');
	await restarted.observe(scope, { ...DEATHS.flag(160), world: { worldId: WORLD, dimension: OVERWORLD }, death: { cause: 'fall', diedAtEpochMs: 160 * 50, x: 0, y: 64, z: 0 } });
	await restarted.observe(scope, live(170));
	assert.deepEqual((await restarted.summary(scope)).deaths.map(death => death.cause), ['fall'], 'a newer death here replaces the pointer elsewhere');
	await restarted.flush();
});

// Review r1 findings: each replay failed on 41c248e1.
const R1_CELL = { x: 20, y: 64, z: 0 };
const r1Receipt = tick => ({ actionId: `place-${tick}`, actionType: 'place_block', arguments: { ...R1_CELL, itemId: table }, state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED',
	observedAtEpochMs: tick * 50, actionObservation: { worldTick: tick, observedAtEpochMs: tick * 50 } });
const r1Scope = { agentId: 'a', goalRevision: 1, worldId: WORLD, dimension: OVERWORLD };

test('r1-1 an older row or sample cannot change a fact newer evidence established, in every store', async () => {
	const memory = new TaskMemoryStore();
	await memory.recordReceipt(r1Scope, r1Receipt(20));
	await memory.observe(r1Scope, live(30, { blocks: [{ ...R1_CELL, blockId: 'minecraft:air', lastSeenTick: 10, observedAtEpochMs: 500 }] }));
	assert.equal((await memory.summary(r1Scope)).assets[0].state, 'placed', 'task memory: the row was seen before the placement');
	const placed = new PlacedWorkstations();
	placed.onActionResult('a', { actionType: 'place_block', arguments: { ...R1_CELL, itemId: table }, state: 'SUCCEEDED', observedAtEpochMs: 5_000 }, live(99));
	placed.leftBehind('a', live(101, { observedAtEpochMs: 500, blocks: [{ ...R1_CELL, blockId: 'minecraft:air' }] }));
	assert.equal(placed.leftBehind('a', live(102)).length, 1, 'workstations: a sample older than the placement');
	const recovery = new RecoveryProgressStore();
	recovery.remember('a', 1, live(100, { blocks: [{ ...R1_CELL, blockId: table }] }));
	recovery.remember('a', 1, live(10, { blocks: [{ ...R1_CELL, blockId: 'minecraft:air' }] }));
	assert.equal(recovery.snapshot('a', live(110)).alreadyHaveFacts.filter(entry => entry.remembered).length, 1, 'recovery: an older sample');
});

test('r1-2 recovery only takes in stations the shared evidence rule accepts', () => {
	for (const row of [{ perceivedBy: 'sound' }, { visible: false }, { stale: true }]) {
		const recovery = new RecoveryProgressStore();
		recovery.remember('a', 1, live(10, { blocks: [{ ...R1_CELL, blockId: table, ...row }] }));
		assert.equal(recovery.snapshot('a', live(11))?.alreadyHaveFacts.length ?? 0, 0, JSON.stringify(row));
	}
	const recovery = new RecoveryProgressStore();
	recovery.remember('a', 1, live(10, { blocks: [{ ...R1_CELL, blockId: table }], continuity: { rememberedSections: ['blocks'] } }));
	assert.equal(recovery.snapshot('a', live(11))?.alreadyHaveFacts.length ?? 0, 0, 'remembered section');
});

test('r1-3 carried items end at every death shape, while the loss record survives for later death details', async () => {
	for (const shape of Object.keys(DEATHS)) {
		const memory = new TaskMemoryStore();
		await memory.observe(r1Scope, live(1, { inventory: { items: [{ itemId: table, count: 3 }] } }));
		await memory.observe(r1Scope, { ...DEATHS[shape](2), world: { worldId: WORLD, dimension: OVERWORLD } });
		assert.equal((await memory.summary(r1Scope)).assets.some(asset => asset.state === 'carried'), false, `task memory, ${shape}`);
		await memory.observe(r1Scope, { ...DEATHS.flag(3), world: { worldId: WORLD, dimension: OVERWORLD }, death: { cause: 'lava', diedAtEpochMs: 150, x: 0, y: 64, z: 0 } });
		assert.deepEqual((await memory.summary(r1Scope)).deaths[0].lostInventory, [{ itemId: table, count: 3 }], `task memory loss, ${shape}`);
		const recovery = new RecoveryProgressStore();
		recovery.remember('a', 1, live(10, { inventory: { items: [{ itemId: table, count: 3 }] } }));
		const corpse = { ...DEATHS[shape](11), inventory: undefined };
		recovery.remember('a', 1, corpse);
		assert.equal(recovery.snapshot('a', corpse)?.alreadyHaveFacts.some(entry => entry.kind === 'inventory') ?? false, false, `recovery, ${shape}`);
		recovery.remember('a', 1, { ...DEATHS.flag(12), death: { cause: 'lava', diedAtEpochMs: 600, x: 0, y: 64, z: 0, dimensionId: OVERWORLD } });
		assert.deepEqual(recovery.snapshot('a', live(13)).lastLostInventory, [{ itemId: table, count: 3 }], `recovery loss, ${shape}`);
	}
});

test('r1-4 workstation cells and receipts belong to one world and dimension', () => {
	const place = () => { const placed = new PlacedWorkstations(); placed.onActionResult('a', { actionType: 'place_block', arguments: { ...R1_CELL, itemId: table }, state: 'SUCCEEDED', observedAtEpochMs: 4_950 }, live(99)); return placed; };
	const netherBreak = place();
	netherBreak.onActionResult('a', { actionType: 'break_block', arguments: R1_CELL, state: 'SUCCEEDED' }, nether(101));
	assert.equal(netherBreak.leftBehind('a', live(102)).length, 1, 'a Nether break at the same numbers');
	const otherWorld = place();
	assert.equal(otherWorld.leftBehind('a', live(102, { world: { worldId: 'other', dimension: OVERWORLD, gameTime: 102 } })).length, 0, 'another world');
	assert.equal(otherWorld.leftBehind('a', live(103)).length, 1, 'kept for its own world');
	const ownBreak = place();
	ownBreak.onActionResult('a', { actionType: 'break_block', arguments: R1_CELL, state: 'SUCCEEDED' }, live(101));
	assert.equal(ownBreak.leftBehind('a', live(102)).length, 0);
});

test('r1-5 the dead state survives a restart, and only a living body ends a death', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'fact-corpse-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const record = { agentId: 'a', currentGoal: 'visit', goalRevision: 1 };
	const before = new LiveTaskViews({ directory });
	await before.observe(record, live(1));
	const lifecycle = before.lifecycle(record);
	const mark = lifecycle.mark();
	await before.observe(record, live(2, { player: { dead: true } }));
	await before.flush();
	assert.equal(lifecycle, before.lifecycle(record), 'holders of the lifecycle keep a current reference');
	const after = new LiveTaskViews({ directory });
	await after.observe(record, live(3, { player: { dead: true } }));
	assert.equal(after.lifecycle(record).deaths, 1, 'the same corpse after a restart is not a second death');
	assert.equal(after.lifecycle(record).since(mark).deaths, 1);
	await after.flush();
	const sparse = new FactLifecycle('run-1');
	sparse.observe(live(1)); sparse.observe({ player: { dead: true } });
	assert.equal(sparse.observe({ status: 'AGENT_NOT_READY' }), null, 'a bodiless sample is not a respawn');
	assert.equal(sparse.observe({ player: { dead: true } }), null, 'so the next corpse sample is the same death');
	assert.equal(sparse.deaths, 1);
	assert.deepEqual(sparse.observe(live(5)), { respawned: true });
});

test('r1-6 src names the evidence that supports the fact now, and death losses are inferred', async () => {
	const memory = new TaskMemoryStore();
	await memory.recordReceipt(r1Scope, r1Receipt(100));
	await memory.observe(r1Scope, live(1300, { blocks: [{ ...R1_CELL, blockId: table }] }));
	assert.equal((await memory.summary(r1Scope)).assets[0].src, 'seen 0s', 'a later sighting, not the minute-old placement');
	await memory.observe(r1Scope, live(1500, { blocks: [{ ...R1_CELL, blockId: 'minecraft:air' }] }));
	assert.equal((await memory.summary(r1Scope)).assets[0].src, 'seen 10s; disproved 0s');
	const placedOnly = new TaskMemoryStore();
	await placedOnly.recordReceipt(r1Scope, r1Receipt(100));
	await placedOnly.observe(r1Scope, live(1500, { blocks: [{ ...R1_CELL, blockId: 'minecraft:air' }] }));
	assert.equal((await placedOnly.summary(r1Scope)).assets[0].src, 'did 1m; disproved 0s');
	const loss = new TaskMemoryStore();
	await loss.observe(r1Scope, live(1, { inventory: { items: [{ itemId: table, count: 3 }] } }));
	await loss.observe(r1Scope, { ...DEATHS.flag(2), world: { worldId: WORLD, dimension: OVERWORLD }, death: { cause: 'lava', diedAtEpochMs: 100, ...R1_CELL } });
	const [death] = (await loss.summary(r1Scope)).deaths;
	assert.deepEqual([death.src, death.lostSrc], ['seen 0s', 'inferred']);
});

// Review r2: one invariant per area, each over every consumer of that class. Each failed on 53474c6c.
const R2 = { x: 20, y: 64, z: 0 };
const r2Row = (blockId, clock = {}) => ({ ...R2, blockId, ...clock });
const r2Scope = { agentId: 'a', goalRevision: 1, worldId: WORLD, dimension: OVERWORLD };
const r2Record = { agentId: 'a', currentGoal: 'keep a table', goalRevision: 1 };
const dated = tick => ({ lastSeenTick: tick, observedAtEpochMs: tick * 50 });
const r2Place = tick => ({ ...r2Scope, actionId: `place-${tick}`, actionType: 'place_block', arguments: { ...R2, itemId: table, face: 'up' }, state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED',
	observedAtEpochMs: tick * 50, actionObservation: { worldTick: tick, observedAtEpochMs: tick * 50 } });

// Every store that remembers the cell: establish a table at tick 20, then read whether it is still believed there.
const CELL_CONSUMERS = {
	'seen-memory': () => { const m = new ObservedMemoryStore(); return {
		establish: async () => m.ingest('a', live(20, { blocks: [r2Row(table)] })),
		sample: async o => m.ingest('a', o),
		holds: async () => m.query('a').blocks.some(b => b.key === '20,64,0' && b.blockId === table) } },
	'task-memory': () => { const m = new TaskMemoryStore(); return {
		establish: async () => m.recordReceipt(r2Scope, r2Place(20)),
		sample: async o => m.observe(r2Scope, o),
		holds: async () => (await m.summary(r2Scope)).assets.some(a => a.state === 'placed') } },
	'plan placement': () => { const v = new LiveTaskViews({ now: () => 0 }); v.suggest('a', r2Record.currentGoal, { steps: [{ id: 'station', label: 'station', detail: '', status: 'pending', dependsOn: [], kind: 'inventory', check: 'has:minecraft:crafting_table*1', evidence: null }] }); return {
		establish: async () => { await v.observe(r2Record, live(19)); await v.actionReceipt(r2Record, r2Place(20)); },
		sample: async o => v.observe(r2Record, o),
		holds: async () => v.snapshot(r2Record).plan.steps[0].status === 'complete' } },
	'plan world step': () => { const v = new LiveTaskViews({ now: () => 0 }); v.suggest('a', r2Record.currentGoal, { steps: [{ id: 'built', label: 'built', detail: '', status: 'pending', dependsOn: [], kind: 'world', check: null, evidence: { itemIds: [], count: 1, dimension: OVERWORLD, ...R2, blockId: table } }] }); return {
		establish: async () => { await v.observe(r2Record, live(19)); await v.actionReceipt(r2Record, r2Place(20)); },
		sample: async o => v.observe(r2Record, o),
		holds: async () => v.snapshot(r2Record).plan.steps[0].status === 'complete' } },
	'placed workstations': () => { const p = new PlacedWorkstations(); return {
		establish: async () => p.onActionResult('a', { actionType: 'place_block', arguments: { ...R2, itemId: table }, state: 'SUCCEEDED', observedAtEpochMs: 20 * 50, actionObservation: { worldTick: 20, observedAtEpochMs: 20 * 50 } }, live(20)),
		sample: async o => p.leftBehind('a', o),
		holds: async () => p.leftBehind('a', live(1000)).length === 1 } },
	recovery: () => { const r = new RecoveryProgressStore(); return {
		establish: async () => r.remember('a', 1, live(20, { blocks: [r2Row(table)] })),
		sample: async o => r.remember('a', 1, o),
		holds: async () => (r.snapshot('a', live(1000))?.alreadyHaveFacts ?? []).some(e => e.kind === 'placed') } },
};

// A row may carry either clock or both, and they may disagree; any clock older than the fact keeps it (r3 #1).
const OLDER_ROW_CLOCKS = [dated(10), { lastSeenTick: 10 }, { lastSeenTick: 10, observedAtEpochMs: 1500 }, { observedAtEpochMs: 500 }];

test('r2 invariant: in every store, evidence dated before a fact cannot change it, while newer evidence can', async () => {
	for (const [name, make] of Object.entries(CELL_CONSUMERS)) for (const clock of OLDER_ROW_CLOCKS) {
		const label = `${name}, row ${JSON.stringify(clock)}`;
		const store = make();
		await store.establish();
		assert.equal(await store.holds(), true, `${label}: established`);
		await store.sample(live(30, { blocks: [r2Row('minecraft:air', clock)] }));
		assert.equal(await store.holds(), true, `${label}: an air row dated before the table, in a newer sample`);
		// Seen-memory's backwards-clock reset is follow-up F3 (see the todo test below).
		if (name !== 'seen-memory') {
			await store.sample(live(15, { blocks: [r2Row('minecraft:air')] }));
			assert.equal(await store.holds(), true, `${label}: an older sample`);
		}
		await store.sample(live(40, { blocks: [r2Row('minecraft:air')] }));
		assert.equal(await store.holds(), false, `${label}: newer direct evidence disproves it`);
	}
});

test('r2 invariant: a disproof outlives the fact, so only a sighting newer than the disproof restores it', async () => {
	const restorable = { 'seen-memory': CELL_CONSUMERS['seen-memory'], recovery: CELL_CONSUMERS.recovery, 'task-memory': CELL_CONSUMERS['task-memory'] };
	for (const [name, make] of Object.entries(restorable)) {
		const store = make();
		await store.establish();
		await store.sample(live(30, { blocks: [r2Row('minecraft:air')] }));
		assert.equal(await store.holds(), false, `${name}: disproved`);
		// Seen-memory's backwards-clock reset is follow-up F3 (see the todo test below).
		if (name !== 'seen-memory') {
			await store.sample(live(25, { blocks: [r2Row(table)] }));
			assert.equal(await store.holds(), false, `${name}: an older sample`);
		}
		await store.sample(live(40, { blocks: [r2Row(table, dated(28))] }));
		assert.equal(await store.holds(), false, `${name}: a newer sample carrying a row dated before the disproof`);
		await store.sample(live(50, { blocks: [r2Row(table)] }));
		assert.equal(await store.holds(), true, `${name}: a sighting after the disproof`);
	}
});

test('r2 invariant: a corpse never carries; after death only fresh inventory proves possession; losses stay accountable', async () => {
	const revivals = { absent: live(5, { inventory: undefined }), remembered: live(5, { continuity: { rememberedSections: ['inventory'] } }), fresh: live(5, { inventory: { items: [{ itemId: table, count: 1 }] } }) };
	for (const shape of Object.keys(DEATHS)) for (const corpseInventory of [false, true]) for (const [revival, sample] of Object.entries(revivals)) {
		const label = `${shape}, corpse ${corpseInventory ? 'lists' : 'omits'} inventory, ${revival} revival`;
		const corpse = { ...DEATHS[shape](3), world: { worldId: WORLD, dimension: OVERWORLD }, inventory: corpseInventory ? { items: [{ itemId: table, count: 3 }] } : undefined };
		const memory = new TaskMemoryStore();
		await memory.observe(r2Scope, live(1, { inventory: { items: [{ itemId: table, count: 3 }] } }));
		await memory.observe(r2Scope, corpse);
		const carried = async () => (await memory.summary(r2Scope)).assets.filter(a => a.state === 'carried').reduce((n, a) => n + a.count, 0);
		assert.equal(await carried(), 0, `task memory dead: ${label}`);
		await memory.observe(r2Scope, sample);
		assert.equal(await carried(), revival === 'fresh' ? 1 : 0, `task memory revived: ${label}`);
		const recovery = new RecoveryProgressStore();
		recovery.remember('a', 1, live(1, { inventory: { items: [{ itemId: table, count: 3 }] } }));
		const held = observation => (recovery.snapshot('a', observation)?.alreadyHaveFacts ?? []).filter(e => e.kind === 'inventory').reduce((n, e) => n + e.count, 0);
		assert.equal(held(recovery.remember('a', 1, corpse) && corpse), 0, `recovery dead: ${label}`);
		recovery.remember('a', 1, sample);
		assert.equal(held(sample), revival === 'fresh' ? 1 : 0, `recovery revived: ${label}`);
		const details = { ...DEATHS.flag(4), world: { worldId: WORLD, dimension: OVERWORLD }, death: { cause: 'lava', diedAtEpochMs: 3 * 50, x: 0, y: 64, z: 0, dimensionId: OVERWORLD } };
		recovery.remember('a', 1, details);
		await memory.observe(r2Scope, details);
		assert.deepEqual(recovery.snapshot('a', live(6)).lastLostInventory, [{ itemId: table, count: 3 }], `recovery delayed loss: ${label}`);
		assert.deepEqual((await memory.summary(r2Scope)).deaths.at(-1).lostInventory, [{ itemId: table, count: 3 }], `task memory delayed loss: ${label}`);
	}
});

test('r2 invariant: a receipt belongs to the world and dimension the action was dispatched in, wherever the body is now', async () => {
	const { NativeToolRuntime } = await import('../src/native-tool-runtime.mjs');
	const record = { agentId: 'a', currentGoal: 'test', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'priority' };
	const ow = tick => live(tick, { position: { x: 0, y: 64, z: 0 } });
	const ne = tick => nether(tick, { position: { x: 0, y: 64, z: 0 } });
	const act = async (runtime, sent, actionType, args, moveTo, sequence) => {
		const pending = runtime.execute({ agentId: 'a', goalRevision: 1, turnId: `t${sequence}`, callId: `c${sequence}`, tool: { kind: 'action', actionType, arguments: args } }, record);
		await new Promise(resolve => setImmediate(resolve));
		runtime.updateObservation(record, moveTo, { eventSequence: sequence });
		const command = sent.filter(args => args[0] === 'action_command').at(-1)[2];
		runtime.onActionResult(record, { actionId: command.actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: actionType === 'place_block' ? 'BLOCK_PLACED' : 'BLOCK_BROKEN', observedAtEpochMs: moveTo.observedAtEpochMs });
		await pending;
	};
	for (const [from, to] of [[ow, ne], [ne, ow]]) {
		const sent = [];
		const runtime = new NativeToolRuntime({ registry: { get: () => record }, bridge: { send: async (...args) => sent.push(args) } });
		runtime.updateObservation(record, from(10), { eventSequence: 1 });
		await act(runtime, sent, 'place_block', { ...R2, itemId: table, face: 'up' }, to(20), 2);
		assert.equal(runtime.decorateObservation(record, to(21)).leftBehind, undefined, 'not in the dimension the body moved to');
		runtime.updateObservation(record, from(30), { eventSequence: 3 });
		assert.equal(runtime.decorateObservation(record, from(31)).leftBehind?.length, 1, 'in the dimension it was placed');
		await act(runtime, sent, 'break_block', { ...R2 }, to(40), 4);
		runtime.updateObservation(record, from(50), { eventSequence: 5 });
		assert.equal(runtime.decorateObservation(record, from(51)).leftBehind, undefined, 'a break dispatched there removes it');
		await runtime.dispose('a', 'test_complete');
	}
});

test('r2 invariant: deaths count exactly the living-to-dead transitions; unready and bodiless samples change nothing', () => {
	const vocabulary = {
		live: live(1), corpse: { player: { dead: true } }, zero: { player: { health: 0 } },
		unready: { status: 'AGENT_NOT_READY' }, unreadyBody: { status: 'AGENT_NOT_READY', player: {}, position: { x: 0, y: 64, z: 0 } },
		unreadyWorld: { status: 'AGENT_NOT_READY', world: { worldId: 'other' } }, notReady: { ready: false, position: { x: 0, y: 64, z: 0 } }, emptyPlayer: { player: {} },
		bodilessWorld: { world: { worldId: 'other', dimension: NETHER } }, rememberedBody: live(3, { continuity: { rememberedSections: ['player', 'position'] } }),
		unreadyCorpse: { status: 'AGENT_NOT_READY', player: { dead: true }, world: { worldId: 'other' } },
	};
	const names = Object.keys(vocabulary);
	// Every sequence of three after a living start: 1,331 cases.
	for (const a of names) for (const b of names) for (const c of names) {
		const life = new FactLifecycle('run');
		life.observe(vocabulary.live);
		let expected = 0, dead = false;
		for (const name of [a, b, c]) {
			const before = JSON.stringify(life.toJSON());
			life.observe(vocabulary[name]);
			if (name === 'corpse' || name === 'zero') { if (!dead) expected++; dead = true; }
			else if (name === 'live') dead = false;
			else assert.equal(JSON.stringify(life.toJSON()), before, `${a},${b},${c}: ${name} changed the lifecycle`);
		}
		assert.equal(life.deaths, expected, `${a},${b},${c}`);
		assert.equal(life.dead, dead, `${a},${b},${c}`);
	}
});

test('r2 invariant: what a restarted coordinator reads equals what the live one knew, after every step and any reload', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'fact-life-persist-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const record = { agentId: 'a', currentGoal: 'persist', goalRevision: 1 };
	const inWorld = (worldId, tick, extra = {}) => live(tick, { world: { worldId, dimension: OVERWORLD, gameTime: tick }, ...extra });
	const corpse = (worldId, tick) => ({ ...DEATHS.flag(tick), world: { worldId } });
	const steps = [inWorld('A', 1), corpse('A', 2), inWorld('A', 3), inWorld('B', 4), corpse('B', 5), inWorld('B', 6), inWorld('A', 7), inWorld('B', 8), inWorld('A', 9), corpse('A', 10), inWorld('A', 11)];
	const views = new LiveTaskViews({ directory });
	let deaths = 0, dead = false;
	for (const [index, sample] of steps.entries()) {
		await views.observe(record, sample);
		if (deadSample(sample)) { if (!dead) deaths++; dead = true; } else dead = false;
		assert.equal(views.lifecycle(record).deaths, deaths, `step ${index}: a reload adds no death`);
		await views.flush();
		// What a restarted coordinator adopts: the saved record of the world this sample was in.
		const file = createHash('sha256').update(JSON.stringify([sample.world.worldId, record.agentId, record.currentGoal])).digest('hex');
		const saved = FactLifecycle.restore(JSON.parse(await readFile(join(directory, `${file}.json`), 'utf8')).lifecycle, { session: 'restarted' });
		assert.deepEqual([saved.deaths, saved.dead], [deaths, dead], `step ${index}: persisted`);
	}
});

// Review r3: the four fixes in scope. Each failed on 3895983d.
test('r3 a revival boundary is saved, so late death details are charged correctly on both sides of a restart', async t => {
	for (const restart of [false, true]) for (const [label, diedAt, expected] of [['a later death', 7 * 50, []], ['the earlier death', 3 * 50, [{ itemId: table, count: 3 }]]]) {
		const directory = await mkdtemp(join(tmpdir(), 'fact-revival-')); t.after(() => rm(directory, { recursive: true, force: true }));
		let memory = new TaskMemoryStore({ directory });
		await memory.observe(r2Scope, live(1, { inventory: { items: [{ itemId: table, count: 3 }] } }));
		await memory.observe(r2Scope, { ...DEATHS.health(3), world: { worldId: WORLD, dimension: OVERWORLD }, position: { x: 0, y: 64, z: 0 } });
		await memory.flush();
		await memory.observe(r2Scope, live(5));
		await memory.flush();
		if (restart) memory = new TaskMemoryStore({ directory });
		await memory.observe(r2Scope, { ...DEATHS.flag(7), world: { worldId: WORLD, dimension: OVERWORLD }, death: { cause: 'fall', diedAtEpochMs: diedAt, x: 5, y: 64, z: 5 } });
		assert.deepEqual((await memory.summary(r2Scope)).deaths.at(-1).lostInventory, expected, `${restart ? 'restarted' : 'same run'}: details for ${label}`);
		await memory.flush();
	}
});

test('r3 a sample without current body evidence changes neither the lifecycle nor the plan or its world', async () => {
	const record = { agentId: 'a', currentGoal: 'keep the plan', goalRevision: 1 };
	const views = new LiveTaskViews({ now: () => 0 });
	views.suggest('a', record.currentGoal, { steps: [{ id: 'there', label: 'there', detail: '', status: 'pending', check: 'in:minecraft:the_nether', dependsOn: [], kind: 'world', evidence: null }] });
	await views.observe(record, live(1));
	await views.observe(record, DEATHS.flag(2));
	const before = JSON.stringify(views.lifecycle(record));
	for (const sample of [{ status: 'AGENT_NOT_READY', world: { worldId: 'B', dimension: OVERWORLD } }, { world: { worldId: 'B', dimension: NETHER } },
		{ ...live(3), ready: undefined, continuity: { rememberedSections: ['player', 'position'] } }]) {
		await views.observe(record, sample);
		assert.notEqual(views.snapshot(record).plan, null, `${JSON.stringify(sample)}: the plan of world ${WORLD} stays`);
		assert.equal(JSON.stringify(views.lifecycle(record)), before, `${JSON.stringify(sample)}: lifecycle unchanged`);
	}
	await views.observe(record, DEATHS.flag(4));
	assert.equal(views.lifecycle(record).deaths, 1, 'a remembered body did not revive the corpse');
});

test('r3 death counts merge exactly past any size: overlapping copies add nothing, independent histories add up', async t => {
	const dieTimes = (life, count, from = 0) => { for (let i = 0; i < count; i++) { life.observe(live(from + i * 2)); life.observe(DEATHS.flag(from + i * 2 + 1)); } };
	const life = new FactLifecycle('run');
	dieTimes(life, 1);
	const first = JSON.parse(JSON.stringify(life));
	dieTimes(life, 256, 10);
	const current = JSON.parse(JSON.stringify(life));
	life.adopt(first); life.adopt(current); life.adopt(first);
	assert.equal(life.deaths, 257, 'adopting older and current copies of the same history');
	const a = new FactLifecycle('A'), b = new FactLifecycle('B');
	dieTimes(a, 257); dieTimes(b, 257);
	a.adopt(JSON.parse(JSON.stringify(b)));
	assert.equal(a.deaths, 514, 'two independent histories');
	a.adopt(JSON.parse(JSON.stringify(b)));
	assert.equal(a.deaths, 514);
	const directory = await mkdtemp(join(tmpdir(), 'fact-overflow-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const record = { agentId: 'a', currentGoal: 'travel', goalRevision: 1 };
	const views = new LiveTaskViews({ directory });
	const inWorld = (worldId, tick, extra = {}) => live(tick, { world: { worldId, dimension: OVERWORLD, gameTime: tick }, ...extra });
	await views.observe(record, inWorld('A', 1)); await views.observe(record, { ...DEATHS.flag(2), world: { worldId: 'A' } }); await views.flush();
	await views.observe(record, inWorld('B', 3));
	for (let i = 0; i < 256; i++) { await views.observe(record, inWorld('B', 4 + i * 2)); await views.observe(record, { ...DEATHS.flag(5 + i * 2), world: { worldId: 'B' } }); }
	await views.flush();
	for (const world of ['A', 'B', 'A', 'B']) { await views.observe(record, inWorld(world, 600)); await views.flush(); assert.equal(views.lifecycle(record).deaths, 257, `back in ${world}`); }
});

// Review r4: the two blockers. Each failed on 8d93d492.
test('r4 legacy death records keep their identities when migrated, so overlapping copies from different runs add nothing', async t => {
	// Records as the per-death-id format saved them: run 1 saved world A after death 1; run 2 restored it and saved B after death 2.
	const savedA = { deaths: 1, deathIds: ['death-1'], dead: true, dimension: OVERWORLD, worldId: 'A', session: 'old-run-1' };
	const savedB = { deaths: 2, deathIds: ['death-1', 'death-2'], dead: true, dimension: OVERWORLD, worldId: 'B', session: 'old-run-2' };
	const merged = FactLifecycle.restore(savedB, { session: 'new-run' }).adopt(savedA).adopt(savedB);
	assert.equal(merged.deaths, 2);
	assert.equal(FactLifecycle.restore({ deaths: 1, session: 'x' }, { session: 'new' }).adopt({ deaths: 2, session: 'y' }).deaths, 2, 'total-only copies of one history');
	const later = FactLifecycle.restore(JSON.parse(JSON.stringify(merged)), { session: 'newer' }).adopt(savedA);
	later.observe(live(20)); later.observe(DEATHS.flag(21));
	assert.equal(later.adopt(savedB).deaths, 3, 'a new death on top of migrated history');
	const directory = await mkdtemp(join(tmpdir(), 'fact-migrate-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const record = { agentId: 'a', currentGoal: 'travel', goalRevision: 1 };
	const plan = { steps: [{ id: 'keep', label: 'keep', detail: '', check: null, kind: 'manual', status: 'pending', dependsOn: [], evidence: null }] };
	for (const [world, lifecycle] of [['A', savedA], ['B', savedB]]) {
		const file = createHash('sha256').update(JSON.stringify([world, 'a', 'travel'])).digest('hex');
		await writeFile(join(directory, `${file}.json`), JSON.stringify({ version: 1, plan, lifecycle }));
	}
	const views = new LiveTaskViews({ directory });
	const counts = [];
	for (const [world, tick] of [['B', 10], ['A', 11], ['B', 12], ['A', 13]]) {
		await views.observe(record, live(tick, { world: { worldId: world, dimension: OVERWORLD, gameTime: tick } })); await views.flush();
		counts.push(views.lifecycle(record).deaths);
	}
	assert.deepEqual(counts, [2, 2, 2, 2], 'persisted travel between the two legacy records');
});

test('r4 a workstation receipt never takes a tick from another world; without its own tick, wall time orders it', async () => {
	const { NativeToolRuntime } = await import('../src/native-tool-runtime.mjs');
	const record = { agentId: 'a', currentGoal: 'test', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'priority' };
	const sample = (worldId, tick, at, blocks = []) => ({ ready: true, observedAtEpochMs: at, world: { worldId, dimension: OVERWORLD, gameTime: tick }, player: { health: 20 }, position: { x: 0, y: 64, z: 0 }, inventory: { items: [] }, blocks });
	for (const withActionTick of [false, true]) {
		const sent = [], runtime = new NativeToolRuntime({ registry: { get: () => record }, bridge: { send: async (...args) => sent.push(args) } });
		runtime.updateObservation(record, sample('A', 10, 500), { eventSequence: 1 });
		const pending = runtime.execute({ agentId: 'a', goalRevision: 1, turnId: 't', callId: 'c', tool: { kind: 'action', actionType: 'place_block', arguments: { ...R2, itemId: table, face: 'up' } } }, record);
		await new Promise(resolve => setImmediate(resolve));
		runtime.updateObservation(record, sample('B', 10_000, 1000), { eventSequence: 2 });
		const command = sent.find(args => args[0] === 'action_command')[2];
		runtime.onActionResult(record, { actionId: command.actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', observedAtEpochMs: 1100,
			...(withActionTick ? { actionObservation: { worldTick: 20, observedAtEpochMs: 1100 } } : {}) });
		await pending;
		const returned = sample('A', 30, 1500, [{ ...R2, blockId: 'minecraft:air' }]);
		runtime.updateObservation(record, returned, { eventSequence: 3 });
		runtime.decorateObservation(record, returned);
		assert.equal(runtime.decorateObservation(record, sample('A', 31, 1550)).leftBehind?.length ?? 0, 0, `seen gone in its own world, receipt ${withActionTick ? 'with' : 'without'} its tick`);
		await runtime.dispose('a', 'test_complete');
	}
});

// Follow-ups (pre-existing on base, documented in REPORT-r4): known failures kept visible instead of silently passing,
// one case per test so each runs.
const followupHolds = recovery => (recovery.snapshot('a', live(1000))?.alreadyHaveFacts ?? []).some(entry => entry.kind === 'placed');
test('F2a a later air sighting raises the recovery disproof', () => {
	const recovery = new RecoveryProgressStore();
	for (const [tick, id] of [[10, table], [30, 'minecraft:air'], [50, 'minecraft:air']]) recovery.remember('a', 1, live(tick, { blocks: [r2Row(id)] }));
	recovery.remember('a', 1, live(60, { blocks: [r2Row(table, dated(40))] }));
	assert.equal(followupHolds(recovery), false);
});
test('F2b an older break receipt does not lower the recovery disproof', () => {
	const recovery = new RecoveryProgressStore();
	recovery.remember('a', 1, live(10, { blocks: [r2Row(table)] }));
	for (const tick of [50, 30]) recovery.recordResult('a', live(tick), { actionType: 'break_block', arguments: R2, state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', observedAtEpochMs: tick * 50 });
	recovery.remember('a', 1, live(60, { blocks: [r2Row(table, dated(40))] }));
	assert.equal(followupHolds(recovery), false);
});
test('F2c recovery disproof eviction keeps a rejection floor', () => {
	const recovery = new RecoveryProgressStore();
	for (let i = 0; i < 33; i++) {
		recovery.remember('a', 1, live(10 + i * 2, { blocks: [{ x: 20 + i, y: 64, z: 0, blockId: table }] }));
		recovery.remember('a', 1, live(11 + i * 2, { blocks: [{ x: 20 + i, y: 64, z: 0, blockId: 'minecraft:air' }] }));
	}
	recovery.remember('a', 1, live(100, { blocks: [r2Row(table, dated(10))] }));
	assert.equal(followupHolds(recovery), false);
});
const seenHolds = memory => memory.query('a').blocks.some(block => block.key === '20,64,0' && block.blockId === table);
test('F3a seen-memory keeps the clock of a crosshair disproof', () => {
	const memory = new ObservedMemoryStore();
	memory.ingest('a', live(20, { blocks: [r2Row(table)] }));
	memory.ingest('a', live(30, { interaction: { rayTarget: { type: 'block', ...R2, blockId: 'minecraft:stone' } } }));
	assert.equal(seenHolds(memory), false, 'the ray disproves the table');
	memory.ingest('a', live(40, { blocks: [r2Row(table, dated(25))] }));
	assert.equal(seenHolds(memory), false, 'an older dated row cannot bring it back');
	memory.ingest('a', live(41, { blocks: [r2Row(table, dated(31))] }));
	assert.equal(seenHolds(memory), true, 'a sighting newer than the disproof reestablishes it');
});
test('F3b a delayed older sample is not a world rollback in seen-memory', () => {
	const memory = new ObservedMemoryStore();
	memory.ingest('a', live(30, { blocks: [r2Row('minecraft:air')] }));
	memory.ingest('a', live(20, { blocks: [r2Row(table)] }));
	assert.equal(seenHolds(memory), false, 'lower tick and older wall time: a delayed sample changes nothing');
	memory.ingest('a', live(31, { blocks: [r2Row(table)] }));
	assert.equal(seenHolds(memory), true, 'a newer sample still updates the cell');
	memory.ingest('a', live(5, { observedAtEpochMs: 100_000, blocks: [r2Row('minecraft:stone')] }));
	assert.equal(seenHolds(memory), false, 'a lower tick with a later wall time is a rollback and resets the scope');
});
const lateInventory = [live(1, { inventory: { items: [{ itemId: table, count: 3 }] } }), { ...DEATHS.health(3), world: { worldId: WORLD, dimension: OVERWORLD } }, live(2, { inventory: { items: [{ itemId: table, count: 3 }] } })];
test('F5a task memory: a delayed living inventory sample does not cross a newer death', async () => {
	const memory = new TaskMemoryStore();
	for (const sample of lateInventory) await memory.observe(r2Scope, sample);
	assert.equal((await memory.summary(r2Scope)).assets.some(asset => asset.state === 'carried'), false);
});
test('F5b recovery: a delayed living inventory sample does not cross a newer death', () => {
	const recovery = new RecoveryProgressStore();
	for (const sample of lateInventory) recovery.remember('a', 1, sample);
	assert.equal((recovery.snapshot('a', live(4, { inventory: undefined }))?.alreadyHaveFacts ?? []).some(entry => entry.kind === 'inventory'), false);
});
test('F5 control: a living sample newer than the death restores possession in both stores', async () => {
	const revived = [...lateInventory, live(4, { inventory: { items: [{ itemId: table, count: 1 }] } })];
	const memory = new TaskMemoryStore();
	for (const sample of revived) await memory.observe(r2Scope, sample);
	assert.equal((await memory.summary(r2Scope)).assets.some(asset => asset.state === 'carried'), true);
	const recovery = new RecoveryProgressStore();
	for (const sample of revived) recovery.remember('a', 1, sample);
	assert.equal((recovery.snapshot('a', live(5, { inventory: undefined }))?.alreadyHaveFacts ?? []).some(entry => entry.kind === 'inventory'), true);
});
test('F2 control: a station seen after the newest disproof returns, and an older receipt cannot remove it', () => {
	const recovery = new RecoveryProgressStore();
	for (const [tick, id] of [[10, table], [30, 'minecraft:air'], [50, 'minecraft:air'], [70, table]]) recovery.remember('a', 1, live(tick, { blocks: [r2Row(id)] }));
	assert.equal(followupHolds(recovery), true, 'a newer sighting reestablishes the station');
	recovery.recordResult('a', live(60), { actionType: 'break_block', arguments: R2, state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', observedAtEpochMs: 60 * 50 });
	assert.equal(followupHolds(recovery), true, 'a receipt older than the sighting does not remove it');
	recovery.recordResult('a', live(80), { actionType: 'break_block', arguments: R2, state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', observedAtEpochMs: 80 * 50 });
	assert.equal(followupHolds(recovery), false);
});
const carriedTables = async memory => (await memory.summary(r2Scope)).assets.filter(asset => asset.state === 'carried').length > 0;
const recoveryHolds = (recovery, probe) => (recovery.snapshot('a', probe)?.alreadyHaveFacts ?? []).some(entry => entry.kind === 'inventory');
const tables = (count) => ({ inventory: { items: [{ itemId: table, count }] } });
test('F5 review: a replacement world with lower ticks but later wall time is not fenced by the old world\'s death', () => {
	const recovery = new RecoveryProgressStore();
	const worldB = (tick, at, extra = {}) => live(tick, { observedAtEpochMs: at, world: { worldId: 'replacement-world', dimension: OVERWORLD, gameTime: tick }, ...extra });
	recovery.remember('a', 1, live(100, tables(1)));
	recovery.remember('a', 1, { ...DEATHS.health(110), world: { worldId: WORLD, dimension: OVERWORLD, gameTime: 110 } });
	recovery.remember('a', 2, worldB(5, 10_000, tables(2)));
	assert.equal(recoveryHolds(recovery, worldB(6, 10_050, { inventory: undefined })), true);
});
test('F5 review: a death in the Nether fences a delayed Overworld living sample', async () => {
	const memory = new TaskMemoryStore();
	const netherScope = { ...r2Scope, dimension: NETHER };
	await memory.observe(r2Scope, live(100, tables(1)));
	await memory.observe(netherScope, nether(108));
	await memory.observe(netherScope, { ...DEATHS.health(110), world: { worldId: WORLD, dimension: NETHER, gameTime: 110 } });
	await memory.observe(r2Scope, live(105, tables(1)));
	assert.equal(await carriedTables(memory), false, 'neither the old Overworld record nor the delayed sample is carried by the next body');
});
for (const [label, late] of [
	['late corpse sample', { ...DEATHS.health(3), world: { worldId: WORLD, dimension: OVERWORLD, gameTime: 3 } }],
	['late detailed death', { ...DEATHS.health(3), world: { worldId: WORLD, dimension: OVERWORLD, gameTime: 3 }, death: { x: 0, y: 64, z: 0, cause: 'zombie', dimensionId: OVERWORLD, diedAtEpochMs: 150 } }],
]) {
	test(`F5 review: a ${label} for an earlier death does not end the revived body`, async () => {
		const samples = [live(1, tables(1)), { ...DEATHS.health(3), world: { worldId: WORLD, dimension: OVERWORLD, gameTime: 3 } }, live(4, tables(2)), late];
		const memory = new TaskMemoryStore();
		for (const sample of samples) await memory.observe(r2Scope, sample);
		assert.equal(await carriedTables(memory), true, 'task memory keeps the revived body\'s inventory');
		assert.equal((await memory.query(r2Scope, { kind: 'trail' })).entries[0].waypoints.length > 0, true, 'and its route');
		const recovery = new RecoveryProgressStore();
		for (const sample of samples) recovery.remember('a', 1, sample);
		assert.equal(recoveryHolds(recovery, live(5, { inventory: undefined })), true, 'recovery keeps the revived body\'s inventory');
	});
}
const reloadable = async (t) => { const directory = await mkdtemp(join(tmpdir(), 'lifecycle-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; };
const netherScope = { ...r2Scope, dimension: NETHER };
const netherCorpse = tick => ({ ...DEATHS.health(tick), world: { worldId: WORLD, dimension: NETHER, gameTime: tick } });
test('F5 r2: a Nether death fences a delayed Overworld sample after reload, even if the Overworld was not loaded at the death', async (t) => {
	const directory = await reloadable(t);
	const first = new TaskMemoryStore({ directory });
	await first.observe(r2Scope, live(100, tables(2)));
	await first.flush();
	const second = new TaskMemoryStore({ directory });
	await second.observe(netherScope, nether(108));
	await second.observe(netherScope, netherCorpse(110));
	await second.flush();
	const third = new TaskMemoryStore({ directory });
	assert.equal(await carriedTables(third), false, 'the Overworld record loaded after the death is the previous body');
	await third.observe(r2Scope, live(105, tables(2)));
	assert.equal(await carriedTables(third), false, 'a delayed pre-death Overworld sample stays fenced');
	await third.flush();
});
test('F5 r2: a delayed earlier Nether death cannot erase the living Overworld body after reload', async (t) => {
	const directory = await reloadable(t);
	const first = new TaskMemoryStore({ directory });
	await first.observe(netherScope, nether(100, tables(2)));
	await first.observe(r2Scope, live(120, tables(2)));
	await first.observe(r2Scope, live(130, tables(2)));
	await first.flush();
	const second = new TaskMemoryStore({ directory });
	assert.equal(await carriedTables(second), true);
	await second.observe(netherScope, { ...netherCorpse(110), death: { x: 0, y: 64, z: 0, cause: 'lava', dimensionId: NETHER, diedAtEpochMs: 110 * 50 } });
	assert.equal(await carriedTables(second), true, 'the living body keeps its inventory');
	assert.equal((await second.query(r2Scope, { kind: 'trail' })).entries[0].waypoints.length > 0, true, 'and its route');
	await second.flush();
});
test('F5 r2: an unchanged stationary heartbeat still fences a late corpse after reload', async (t) => {
	const directory = await reloadable(t);
	const first = new TaskMemoryStore({ directory });
	await first.observe(r2Scope, live(100, tables(2)));
	await first.flush();
	await first.observe(r2Scope, live(120, tables(2)));
	await first.flush();
	const second = new TaskMemoryStore({ directory });
	await second.observe(r2Scope, { ...DEATHS.health(110), world: { worldId: WORLD, dimension: OVERWORLD, gameTime: 110 } });
	assert.equal(await carriedTables(second), true);
	await second.flush();
});
test('F5 r2: a same-world producer rollback (lower tick, later wall time) starts a new body epoch', async () => {
	const corpse = { ...DEATHS.health(5), observedAtEpochMs: 10_000, world: { worldId: WORLD, dimension: OVERWORLD, gameTime: 5 } };
	const memory = new TaskMemoryStore();
	await memory.observe(r2Scope, live(100, { observedAtEpochMs: 5_000, ...tables(2) }));
	await memory.observe(r2Scope, corpse);
	assert.equal(await carriedTables(memory), false, 'a death after the rollback ends the body');
	const revived = new TaskMemoryStore();
	await revived.observe(r2Scope, live(100, { observedAtEpochMs: 5_000, ...tables(1) }));
	await revived.observe(r2Scope, { ...DEATHS.health(110), observedAtEpochMs: 5_500, world: { worldId: WORLD, dimension: OVERWORLD, gameTime: 110 } });
	await revived.observe(r2Scope, live(5, { observedAtEpochMs: 10_000, ...tables(2) }));
	assert.equal(await carriedTables(revived), true, 'a living sample after the rollback establishes possession');
	await revived.observe(r2Scope, live(105, { observedAtEpochMs: 5_250, ...tables(1) }));
	assert.equal((await revived.summary(r2Scope)).assets.find(asset => asset.state === 'carried')?.count ?? 2, 2, 'a sample from the retired epoch changes nothing');
});
test('F5 r2: recovery keeps each world\'s death fence when the body moves between worlds', () => {
	const recovery = new RecoveryProgressStore();
	recovery.remember('a', 1, live(100, { observedAtEpochMs: 5_000, ...tables(2) }));
	recovery.remember('a', 1, { ...DEATHS.health(110), observedAtEpochMs: 5_500, world: { worldId: WORLD, dimension: OVERWORLD, gameTime: 110 } });
	const worldB = (tick, at, extra = {}) => live(tick, { observedAtEpochMs: at, world: { worldId: 'replacement-world', dimension: OVERWORLD, gameTime: tick }, ...extra });
	recovery.remember('a', 2, worldB(5, 10_000));
	recovery.remember('a', 2, live(105, { observedAtEpochMs: 5_250, ...tables(2) }));
	assert.equal(recoveryHolds(recovery, worldB(6, 10_050, { inventory: undefined })), false, 'a delayed sample from the retired world restores nothing');
});

// Holds lifecycle-record writes after their snapshot is taken, as AtomicAgentStore captures state at call time.
function holdLifecycleWrites(t) {
	const original = AtomicAgentStore.prototype.write;
	const gate = { holding: false, started: Promise.withResolvers(), release: Promise.withResolvers() };
	t.mock.method(AtomicAgentStore.prototype, 'write', async function (key, value) {
		if (!gate.holding || value?.book === undefined) return original.call(this, key, value);
		const snapshot = structuredClone(value);
		gate.started.resolve();
		await gate.release.promise;
		return original.call(this, key, snapshot);
	});
	return gate;
}
const overworldCorpse = tick => ({ ...DEATHS.health(tick), world: { worldId: WORLD, dimension: OVERWORLD, gameTime: tick } });
test('F5 r3: a revival during a held lifecycle write still reaches disk before flush resolves', async (t) => {
	const directory = await reloadable(t);
	const memory = new TaskMemoryStore({ directory });
	await memory.observe(r2Scope, live(100, tables(2)));
	await memory.flush();
	const gate = holdLifecycleWrites(t);
	gate.holding = true;
	await memory.observe(r2Scope, overworldCorpse(110));
	await gate.started.promise;
	await memory.observe(r2Scope, live(120, tables(2)));
	const flushed = memory.flush();
	gate.holding = false;
	gate.release.resolve();
	await flushed;
	const reloaded = new TaskMemoryStore({ directory });
	await reloaded.observe(r2Scope, overworldCorpse(115));
	assert.equal(await carriedTables(reloaded), true, 'the persisted revival fences the late corpse');
	await reloaded.flush();
});
test('F5 r3: a heartbeat during a held flush write is drained by the next flush', async (t) => {
	const directory = await reloadable(t);
	const memory = new TaskMemoryStore({ directory });
	await memory.observe(r2Scope, live(100, tables(2)));
	await memory.flush();
	await memory.observe(r2Scope, live(110, tables(2)));
	const gate = holdLifecycleWrites(t);
	gate.holding = true;
	const first = memory.flush();
	await gate.started.promise;
	await memory.observe(r2Scope, live(120, tables(2)));
	const second = memory.flush();
	gate.holding = false;
	gate.release.resolve();
	await Promise.all([first, second]);
	const reloaded = new TaskMemoryStore({ directory });
	await reloaded.observe(r2Scope, overworldCorpse(115));
	assert.equal(await carriedTables(reloaded), true, 'the heartbeat fence written by flush fences the late corpse');
	await reloaded.flush();
});
test('F5 r4: a heartbeat during every lifecycle write cannot keep flush from returning', async (t) => {
	const directory = await reloadable(t);
	const memory = new TaskMemoryStore({ directory });
	await memory.observe(r2Scope, live(100, tables(2)));
	await memory.flush();
	await memory.observe(r2Scope, live(110, tables(2)));
	const original = AtomicAgentStore.prototype.write;
	let bookWrites = 0, tick = 110;
	t.mock.method(AtomicAgentStore.prototype, 'write', async function (key, value) {
		if (value?.book === undefined) return original.call(this, key, value);
		bookWrites++;
		const snapshot = structuredClone(value);
		// The observation stream keeps going while the write is on disk; capped so the old drain loop also ends.
		if (bookWrites < 50) await memory.observe(r2Scope, live(++tick, tables(2)));
		return original.call(this, key, snapshot);
	});
	await memory.flush();
	assert.ok(bookWrites <= 2, `flush writes what was dirty when called and returns (saw ${bookWrites} lifecycle writes; 50 before the fix)`);
});
