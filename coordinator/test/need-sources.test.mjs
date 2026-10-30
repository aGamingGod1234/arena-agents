import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSearch, observeSearch, ownSighting, recordPlacement, recordSightings, restoreSearch, serializeSearch, summarizeSearch } from '../src/search-coverage.mjs';
import { ObservedMemoryStore } from '../src/observed-memory-store.mjs';
import { KNOWN_BYTES, NETHER_OPTIONS_BYTES, OPTIONS_BYTES, PEARL_OPTIONS_BYTES, descentRespawnFact, knownLine, needOptions, needResources, obsidianOptions, pearlHuntLine, pickaxeTier, progressionGoal, textResources } from '../src/need-sources.mjs';
import { buildNativeEventInput, withoutOwnSightings } from '../src/dynamic-main.mjs';
import { evaluatePlanCheck, emptyKnown } from '../src/plan-checks.mjs';
import { validateTaskPlan } from '../src/live-task-view.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { factToWireObservation } from './fixtures/dynamic-main-fixture.mjs';

const place = (x, y, z) => ({ x, y, z, distance: 1, bearing: 0 });

test('sightings keep points of interest, built clusters, roomy caves, ore veins and lava with their positions', () => {
	const search = createSearch();
	recordSightings(search, {
		poi: [{ blockId: 'minecraft:bell', ...place(100, 70, -100), new: true }, { blockId: 'minecraft:lectern', ...place(110, 70, -90) }, { blockId: 'minecraft:nether_portal', ...place(0, 64, 40) }, { blockId: 'minecraft:bee_nest', ...place(5, 70, 5) }],
		built: [{ blocks: ['minecraft:oak_planks', 'minecraft:glass'], size: 7, ...place(-50, 64, 0) }],
		caves: [{ air: 60, ...place(0, 20, 30) }, { air: 32, ...place(0, 20, -30) }],
		veins: [{ blockId: 'minecraft:deepslate_iron_ore', visible: 4, ...place(38, -5, 2) }],
		blocks: [{ blockId: 'minecraft:lava', count: 9, ...place(-20, 11, 20) }, { blockId: 'minecraft:spawner', ...place(1, 1, 1) }],
		biomes: [{ biome: 'minecraft:desert', ...place(200, 64, 0) }],
	}, 10);
	const rows = [...search.sightings.values()].map(({ what, kind, via, visible, air }) => [what, kind, via ?? visible ?? air ?? null]);
	assert.deepEqual(rows, [
		['minecraft:bell', 'poi', null], ['minecraft:lectern', 'poi', null], ['minecraft:nether_portal', 'portal', null], ['built:minecraft:oak_planks+minecraft:glass', 'built', null],
		['cave', 'cave', 60], ['minecraft:deepslate_iron_ore', 'vein', 4], ['minecraft:lava', 'lava', null], ['minecraft:spawner', 'spawner', null],
	], 'a 32-air pocket, a bee nest and biomes are not kept');
	const restored = restoreSearch(JSON.parse(JSON.stringify(serializeSearch(search))));
	assert.deepEqual([...restored.sightings.values()], [...search.sightings.values()], 'kinds and counts survive persistence');
	const legacy = restoreSearch({ sightings: [['minecraft:fortress@0,0', { what: 'minecraft:fortress', x: 1, y: 2, z: 3, tick: 4 }]] });
	assert.equal(summarizeSearch(legacy, { x: 0, y: 0, z: 0 }).sightings[0].what, 'minecraft:fortress', 'rows saved before kinds still restore');
	assert.deepEqual(summarizeSearch(search, { x: 0, y: 64, z: 0 }).sightings.map((row) => row.what).sort(),
		['built:minecraft:oak_planks+minecraft:glass', 'minecraft:nether_portal', 'minecraft:spawner'], 'coverage keeps listing places, not caves, veins, lava or single points of interest');
});

test('a strip mine\'s stream of veins and caves never evicts a structure', () => {
	const search = createSearch();
	recordSightings(search, { structures: [{ structure: 'shipwreck', size: 20, ...place(300, 60, 0) }] }, 1);
	for (let index = 0; index < 200; index += 1) recordSightings(search, { veins: [{ blockId: 'minecraft:coal_ore', visible: 2, ...place(index * 16, 16, 0) }], caves: [{ air: 50, ...place(index * 32, 16, 64) }] }, 2 + index);
	assert.ok([...search.sightings.values()].some((row) => row.what === 'shipwreck'));
	assert.ok(search.sightings.size <= 48);
});

test('common caves and ore cannot erase the only remembered source of another material', () => {
	for (const material of ['iron', 'diamond', 'gold', 'coal', 'copper', 'redstone', 'emerald', 'lapis']) {
		const search = createSearch();
		const ore = `minecraft:${material}_ore`;
		const common = material === 'copper' ? 'coal' : 'copper';
		recordSightings(search, { veins: [{ blockId: ore, visible: 2, ...place(-177, 57, 153) }], blocks: [{ blockId: 'minecraft:lava', ...place(0, 16, 0) }] }, 1);
		for (let index = 0; index < 200; index += 1) {
			recordSightings(search, { veins: [{ blockId: `minecraft:${common}_ore`, visible: 3, ...place(index * 16, 16, 0) }], caves: [{ air: 50, ...place(index * 32, 16, 64) }] }, index + 2);
		}
		const rows = [...search.sightings.values()];
		assert.ok(rows.some(row => row.what === ore), `retain the ${material} source without choosing a resource for the model`);
		assert.ok(rows.some(row => row.kind === 'lava'), 'lava is another distinct kind of observed source');
		assert.equal(rows.length, 24, 'diversity shares the existing transient budget');
		assert.deepEqual([...restoreSearch(serializeSearch(search)).sightings.values()], rows);
	}
});

test('stone and deepslate variants share a material budget and eviction keeps newer sources', () => {
	const search = createSearch();
	recordSightings(search, { caves: [{ air: 50, ...place(-32, 16, 0) }], veins: [{ blockId: 'minecraft:iron_ore', visible: 2, ...place(0, 16, 0) }] }, 1);
	for (let index = 1; index <= 40; index += 1) {
		recordSightings(search, { veins: [{ blockId: 'minecraft:deepslate_iron_ore', visible: 2, ...place(index * 16, 16, 0) }] }, index + 2);
	}
	const rows = [...search.sightings.values()];
	assert.equal(rows.length, 24);
	assert.ok(rows.some(row => row.kind === 'cave'), 'a material stream cannot erase the only cave');
	assert.ok(rows.some(row => row.x === 40 * 16));
	assert.ok(!rows.some(row => row.kind === 'vein' && row.x === 0), 'old sources of an overrepresented material are replaced');
	assert.equal(rows.filter(row => row.what === 'minecraft:deepslate_iron_ore').length, 23, 'deepslate is the same material, not a separate protected source kind');
});

test('recorded A15 cave and copper churn preserves the iron source in need options', async () => {
	const { samples } = JSON.parse(await readFile(new URL('./fixtures/iron-source-churn.json', import.meta.url), 'utf8'));
	const memory = new ObservedMemoryStore();
	let observation;
	for (const sample of samples) {
		observation = { ready: true, observedAtEpochMs: sample.elapsedMs, world: { worldId: 'a15-churn', dimension: 'minecraft:overworld', gameTime: sample.gameTime }, position: sample.position, sighted: sample.sighted };
		memory.ingest('a', observation, { snapshot: false });
		assert.ok(memory.knownSources('a', observation).sightings.length <= 24);
	}
	const options = needOptions({ ids: ['minecraft:iron_ingot'], known: memory.knownSources('a', observation), position: observation.position });
	assert.match(options, /^iron: seen iron_ore x1 seen .*@-140,43,168/);
	assert.ok(Buffer.byteLength(options) <= OPTIONS_BYTES);
});

test('survey built clusters need size and constructed material, and never become structure loot', () => {
	const memory = new ObservedMemoryStore();
	const observation = { ready: true, world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime: 10 }, position: { x: 0, y: 64, z: 0 } };
	memory.ingest('a', observation, { snapshot: false });
	const clusters = [
		{ blocks: ['minecraft:snow_block'], size: 1, ...place(-89, 64, 0) },
		{ blocks: ['minecraft:oak_planks'], size: 5, ...place(5, 64, 0) },
		{ blocks: ['minecraft:snow_block', 'minecraft:dirt', 'minecraft:stone'], size: 20, ...place(10, 64, 0) },
		{ blocks: ['minecraft:oak_planks', 'minecraft:glass'], size: 6, ...place(20, 64, 0) },
	];
	// Both passive built rows and older survey structures rows may carry unnamed clusters.
	for (const key of ['built', 'structures']) {
		memory.recordSurvey('a', observation, { survey: { [key]: clusters } });
	}
	const known = memory.knownSources('a', observation);
	assert.deepEqual(known.sightings.map(row => [row.what, row.kind, row.size]), [['built:minecraft:oak_planks+minecraft:glass', 'built', 6]]);
	const line = knownLine({ known, position: observation.position });
	assert.equal(line, 'places: built(oak_planks+glass) size 6 20m E');
	assert.ok(Buffer.byteLength(line) <= KNOWN_BYTES);
	for (const id of ['iron_ingot', 'diamond', 'bread']) {
		assert.match(needOptions({ ids: [`minecraft:${id}`], known, position: observation.position }), /: seen none remembered;/, 'built material alone proves no loot source');
	}
});

test('legacy built prefixes retain their label and size, and stale tiny clusters stay out of known places', () => {
	const sightings = [
		{ what: 'built:minecraft:snow_block', size: 1, ...place(-89, 64, 0) },
		{ what: 'minecraft:snow_block', kind: 'structure', size: 1, ...place(-89, 64, 0) },
		{ what: 'built:minecraft:dirt+minecraft:stone', kind: 'built', size: 40, ...place(5, 64, 0) },
		{ what: 'built:minecraft:oak_planks', size: 6, ...place(20, 64, 0) },
	];
	const search = restoreSearch({ sightings: sightings.map((row, index) => [`old${index}`, { ...row, tick: 1 }]) });
	const known = { sightings: [...search.sightings.values()], blocks: [] };
	const position = { x: 0, y: 64, z: 0 };
	assert.equal(knownLine({ known, position }), 'places: built(oak_planks) size 6 20m E');
	assert.deepEqual(summarizeSearch(search, position).sightings.map(row => row.what), ['built:minecraft:oak_planks']);
	assert.match(needOptions({ ids: ['minecraft:iron_ingot'], known, position }), /^iron: seen none remembered;/);
});

test('sightings are kept on a sample that ends a life and on a sample without a position', () => {
	const search = createSearch();
	observeSearch(search, { player: { dead: true }, sighted: { structures: [{ structure: 'village', size: 40, ...place(10, 64, 10) }] } }, { x: 0, y: 64, z: 0 }, 5);
	assert.equal([...search.sightings.values()][0]?.what, 'village');
	const memory = new ObservedMemoryStore();
	const world = { worldId: 'w', dimension: 'minecraft:overworld', gameTime: 7 };
	memory.ingest('a', { ready: true, world, sighted: { poi: [{ blockId: 'minecraft:bell', ...place(10, 64, 10) }] } }, { snapshot: false });
	assert.deepEqual(memory.knownSources('a', { world }).sightings.map((row) => row.what), ['minecraft:bell']);
});

test('needs map to base resources, directly or through the requirement chain', () => {
	assert.deepEqual(needResources(['minecraft:iron_pickaxe']), ['iron']);
	assert.deepEqual(needResources(['minecraft:ender_eye']), ['ender_pearl', 'blaze_rod']);
	assert.deepEqual(needResources(['minecraft:iron_pickaxe'], 'iron_pickaxe 0/1 @crafting_table missing<-stick 0/2 (@inventory<-#planks 0/2 or @inventory<-bamboo 0/4 mine bamboo)'), ['logs'], 'held iron leaves only the sticks to get');
	assert.deepEqual(needResources(['minecraft:ender_eye'], 'ender_eye 0/12<-(ender_pearl 0/12 kill enderman overworld + blaze_powder 0/12<-blaze_rod 0/6 kill blaze the_nether(unvisited) fortress), nether entry: obsidian 0/10 needs diamond_pickaxe+ or water on lava, flint_and_steel|fire_charge 0/1 iron_ore stone_pickaxe+ held y-24..56~16'),
		['ender_pearl', 'blaze_rod', 'obsidian', 'iron']);
	assert.equal(needOptions({ ids: ['minecraft:dirt'] }), null);
});

test('the options line lists remembered sources nearest first, then typical ways, within its byte cap', () => {
	const position = { x: 0, y: 16, z: 0 };
	const known = {
		sightings: [{ what: 'minecraft:bell', kind: 'poi', x: 100, y: 70, z: -100 }, { what: 'minecraft:iron_ore', kind: 'vein', visible: 4, x: 38, y: 52, z: 2 },
			{ what: 'cave', kind: 'cave', air: 60, x: 0, y: 20, z: 30 }, { what: 'shipwreck', kind: 'structure', x: 900, y: 60, z: 0 }, { what: 'minecraft:coal_ore', kind: 'vein', visible: 3, x: 2, y: 16, z: 2 }],
		blocks: [{ blockId: 'minecraft:iron_ore', x: 39, y: 52, z: 3 }, { blockId: 'minecraft:iron_ore', x: -60, y: 10, z: 0 }, { blockId: 'minecraft:iron_ore', x: -61, y: 10, z: 0 }],
	};
	const line = needOptions({ ids: ['minecraft:iron_ingot'], position, known });
	assert.match(line, /^iron: seen iron_ore x4 seen 38m E dy\+36 y52 @38,52,2, iron_ore x2 60m W dy-6 y10 @-60,10,0; possible cave\(air 60\/125\) 30m S dy\+4 y20 @0,20,30; ways \(typical\): exposed ore/);
	assert.ok(Buffer.byteLength(line) <= OPTIONS_BYTES);
	assert.doesNotMatch(line.split('; ways')[0], /coal_ore|shipwreck/, 'unrelated ore is not an iron source; the nearest three are shown');
	assert.match(needOptions({ ids: ['minecraft:iron_ingot'], position, known: null }), /^iron: seen none remembered; ways \(typical\): /);
	const tight = needOptions({ ids: ['minecraft:iron_ingot'], position, known, cap: 200 });
	assert.ok(Buffer.byteLength(tight) <= 200 && tight.startsWith('iron: seen iron_ore x4 seen 38m E dy+36 y52 @38,52,2, iron_ore x2') && tight.endsWith('...'), 'keep observed alternatives and cut generic advice');
	assert.doesNotMatch(tight, /none remembered/);
	const withDiamond = { ...known, sightings: [...known.sightings, { what: 'minecraft:diamond_ore', kind: 'vein', visible: 2, x: 0, y: -58, z: 4 }] };
	assert.equal(needOptions({ resources: ['iron', 'diamond'], position, known: withDiamond, cap: 200 }), tight, 'a later resource is omitted rather than appended as a clipped fragment');
	// Pearl options price each source and make room for the next resource.
	const eyes = needOptions({ ids: ['minecraft:ender_eye'], position, known });
	assert.match(eyes, /^ender_pearl: 12 more needed \(pearls and eyes held 0\/12: 0 pearls; 0 gold; eyes: 1 per empty End portal frame of 12 .*\), est\. options: 12 pearls by barter take ~188 gold .*; village 141m NE dy\+54: an expert-level cleric sells pearls for emeralds \| blaze_rod: seen none remembered; ways \(typical\): only from blazes/);
});

test('mining options describe excavation costs without ranking them slowest', () => {
	for (const id of ['iron_ingot', 'diamond', 'coal']) {
		const line = needOptions({ ids: [`minecraft:${id}`] });
		assert.doesNotMatch(line, /slowest/);
		assert.match(line, /many blocks per vein/);
		assert.ok(Buffer.byteLength(line) <= OPTIONS_BYTES);
	}
	const iron = needOptions({ ids: ['minecraft:iron_ingot'] });
	assert.match(iron, /stone\+ pick, smelt raw iron/);
	assert.match(iron, /ruined portal nuggets/);
	assert.match(iron, /stone tunnel or staircase near y16 or above y140 in mountains \(many blocks per vein: ~80 breaks, ~3 min; 25 empty breaks are normal\)/);
});

test('nearby opening samples leave room for other leads and show vertical access cost', () => {
	const position = { x: 0, y: 64, z: 0 };
	const cave = (x, y, z) => ({ what: 'cave', kind: 'cave', air: 50, x, y, z });
	const known = { sightings: [cave(15, 64, 15), cave(16, 64, 16), cave(15, 64, 16), cave(16, 84, 16), cave(80, 64, 16)], blocks: [] };
	const line = needOptions({ resources: ['iron'], known, position });
	assert.match(line, /^iron: possible cave/);
	for (const at of ['@15,64,15', '@16,84,16', '@80,64,16']) assert.ok(line.includes(at), line);
	for (const at of ['@16,64,16', '@15,64,16']) assert.ok(!line.includes(at), line);
	assert.match(line, /dy\+20 y84/);
	assert.ok(Buffer.byteLength(line) <= OPTIONS_BYTES);
	const remembered = knownLine({ known, position });
	for (const at of ['@15,64,15', '@16,84,16', '@80,64,16']) assert.ok(remembered.includes(at), remembered);
	assert.equal(known.sightings.length, 5, 'the short presentation does not remove sightings from memory');
	const below = needOptions({ resources: ['iron'], known: { sightings: [cave(1, 16, 0)], blocks: [] }, position });
	assert.match(below, /1m E dy-48 y16/);
});

test('source context shows remembered liquids near ore or an opening without declaring access safe or flooded', () => {
	const position = { x: 0, y: 64, z: 0 };
	const known = { sightings: [{ what: 'cave', kind: 'cave', air: 60, x: 10, y: 64, z: 0 },
		{ what: 'minecraft:iron_ore', kind: 'vein', visible: 2, x: 20, y: 64, z: 0 }],
		blocks: [{ blockId: 'minecraft:water', x: 10, y: 64, z: 1 }, { blockId: 'minecraft:lava', x: 20, y: 65, z: 0 }] };
	for (const line of [needOptions({ resources: ['iron'], known, position }), knownLine({ known, position })]) {
		assert.match(line, /@10,64,0 \(water seen nearby\)/);
		assert.match(line, /@20,64,0 \(lava seen nearby\)/);
		assert.doesNotMatch(line, /safe|flooded|dry access/);
	}
	const far = { ...known, blocks: [{ blockId: 'minecraft:water', x: 10, y: 68, z: 0 }] };
	assert.doesNotMatch(needOptions({ resources: ['iron'], known: far, position }), /seen nearby/);
});

const record = { agentId: 'a1', currentGoal: 'beat the game.', goalRevision: 1 };
const sample = (at, items, extra = {}) => ({ ready: true, observedAtEpochMs: at, position: { x: 0, y: 16, z: 0 }, player: { dead: false }, world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime: Math.floor(at / 50) },
	inventory: { items: items.map(([id, count = 1]) => ({ itemId: `minecraft:${id}`, count })) }, ...extra });
const broke = (views, n) => Promise.all(Array.from({ length: n }, (_, index) => views.actionReceipt(record, { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', actionType: 'break_block', goalRevision: 1,
	worldId: 'w', dimension: 'minecraft:overworld', arguments: { x: index, y: 16, z: 0 }, observedAtEpochMs: 1 + index })));

test('the wake header carries options for the first unfinished step only while it is unmet', async () => {
	const memory = new ObservedMemoryStore();
	let now = 0;
	const views = new LiveTaskViews({ now: () => now, sources: (who, observation, pattern) => memory.knownSources(who.agentId, observation, pattern) });
	views.suggest(record.agentId, record.currentGoal, { steps: [{ id: 'iron', label: 'iron', kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'has:minecraft:iron_ingot*3' }] });
	const seen = sample(0, [['stone_pickaxe']], { sighted: { poi: [{ blockId: 'minecraft:bell', ...place(100, 70, -100), new: true }] } });
	memory.ingest(record.agentId, seen, { snapshot: false });
	await views.observe(record, seen);
	assert.match(views.continuity(record).options, /^iron: possible village\(bell\) 141m NE dy\+54; ways \(typical\)/);
	assert.equal((await views.operate(record, { operation: 'read' })).options, views.continuity(record).options, 'taskPlan read returns the same line');
	await views.observe(record, sample(1000, [['stone_pickaxe'], ['iron_ingot', 3]]));
	assert.equal(views.continuity(record).options, undefined, 'a met step has no options');
});

test('the stall fact counts blocks broken since the step last changed', async () => {
	let now = 0;
	const views = new LiveTaskViews({ now: () => now });
	views.suggest(record.agentId, record.currentGoal, { steps: [{ id: 'iron', label: 'iron', kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'has:minecraft:iron_ingot*3' }] });
	await views.observe(record, sample(0, [['stone_pickaxe']]));
	await broke(views, 410);
	now = 22 * 60_000;
	await views.observe(record, sample(now, [['stone_pickaxe'], ['cobblestone', 64]]));
	assert.match(views.progress(record), /^open iron\[howto:iron_ingot 0\/3; unchanged 22m, 410 blocks broken; /);
	now += 1;
	await views.observe(record, sample(now, [['stone_pickaxe'], ['raw_iron', 1]]));
	await broke(views, 5);
	now += 3 * 60_000;
	await views.observe(record, sample(now, [['stone_pickaxe'], ['raw_iron', 1]]));
	assert.match(views.progress(record), /unchanged 3m, 5 blocks broken/, 'progress restarts the clock and the count');
});

// Review regressions.

test('held ingredients ready to process need no acquisition options', async () => {
	const views = new LiveTaskViews();
	views.suggest(record.agentId, record.currentGoal, { steps: [{ id: 'iron', label: 'iron', kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'has:minecraft:iron_ingot*3' }] });
	await views.observe(record, sample(0, [['stone_pickaxe'], ['raw_iron', 3], ['coal', 3], ['furnace', 1]]));
	assert.match(views.progress(record), /smelt ready/);
	assert.equal(views.continuity(record).options, undefined);
	assert.equal(needResources(['minecraft:iron_ingot'], 'iron_ingot 0/3 smelt ready').length, 0);
	await views.observe(record, sample(1, [['stone_pickaxe'], ['raw_iron', 1], ['coal', 3], ['furnace', 1]]));
	assert.match(views.continuity(record).options, /^iron: /, 'two more raw iron still have to be found');
});

test('a lone workstation or the agent\'s own placements are no village', async () => {
	const position = { x: 0, y: 64, z: 0 };
	const poi = (what, x, z) => ({ what: `minecraft:${what}`, kind: 'poi', x, y: 64, z });
	const village = (sightings, placed = []) => needOptions({ ids: ['minecraft:iron_ingot'], position, known: { sightings, blocks: [] }, placed }).split('; ways')[0];
	assert.equal(village([poi('smoker', 10, 10)]), 'iron: seen none remembered');
	assert.equal(village([poi('white_bed', 10, 10), poi('red_bed', 12, 10)]), 'iron: seen none remembered', 'beds are one kind');
	assert.equal(village([poi('smoker', 10, 10), poi('lectern', 20, 10)]), 'iron: possible village(2 poi) 14m SE');
	assert.equal(village([poi('smoker', 10, 10), poi('lectern', 20, 10)], [{ x: 10, y: 64, z: 10 }]), 'iron: seen none remembered', 'its own smoker is not evidence');
	assert.equal(village([{ what: 'village', kind: 'structure', x: 0, y: 64, z: 50 }]), 'iron: possible village 50m S', 'a named village structure is a village');
	const memory = new ObservedMemoryStore();
	const views = new LiveTaskViews({ sources: (who, observation, pattern) => memory.knownSources(who.agentId, observation, pattern) });
	views.suggest(record.agentId, record.currentGoal, { steps: [{ id: 'iron', label: 'iron', kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'has:minecraft:iron_ingot*3' }] });
	await views.observe(record, sample(0, [['stone_pickaxe']]));
	await views.actionReceipt(record, { state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', actionType: 'place_block', actionId: 'p1', goalRevision: 1, worldId: 'w', dimension: 'minecraft:overworld', arguments: { x: 5, y: 16, z: 5, itemId: 'minecraft:smoker' }, observedAtEpochMs: 10 });
	const seen = sample(20, [['stone_pickaxe']], { sighted: { poi: [{ blockId: 'minecraft:smoker', ...place(5, 16, 5) }, { blockId: 'minecraft:lectern', ...place(20, 16, 5) }] } });
	memory.ingest(record.agentId, seen, { snapshot: false });
	await views.observe(record, seen);
	assert.match(views.continuity(record).options, /^iron: seen none remembered;/, 'the placed smoker leaves one lectern, which is no village');
});

test('a sighting whose block is later seen or broken as something else is withdrawn', () => {
	const memory = new ObservedMemoryStore();
	const world = (gameTime) => ({ worldId: 'w', dimension: 'minecraft:overworld', gameTime });
	const at = { position: { x: 0, y: 50, z: 0 }, ready: true };
	memory.ingest('a', { ...at, world: world(10), sighted: { veins: [{ blockId: 'minecraft:iron_ore', visible: 1, ...place(38, 52, 2) }], blocks: [{ blockId: 'minecraft:lava', ...place(-5, 40, 0) }], poi: [{ blockId: 'minecraft:bell', ...place(30, 64, 30) }] } }, { snapshot: false });
	const whats = () => memory.knownSources('a', { world: world(20) }).sightings.map((row) => row.what).sort();
	assert.deepEqual(whats(), ['minecraft:bell', 'minecraft:iron_ore', 'minecraft:lava']);
	memory.ingest('a', { ...at, world: world(20), blocks: [{ x: 38, y: 52, z: 2, blockId: 'minecraft:air' }, { x: -5, y: 40, z: 0, blockId: 'minecraft:lava' }] }, { snapshot: false });
	assert.deepEqual(whats(), ['minecraft:bell', 'minecraft:lava'], 'air at the vein withdraws it; lava still there stays');
	memory.recordResourceResult('a', { world: world(21) }, { actionType: 'break_block', arguments: { x: 30, y: 64, z: 30 }, state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' });
	assert.deepEqual(whats(), ['minecraft:lava'], 'a broken bell is gone');
});

test('a lava source the agent filled a bucket from is no longer remembered, even while the server repeats its sighting', () => {
	// Recorded d3b-iron-c (2026-10-19, 53.5 min): interact_block at the ruined portal's lava with an empty bucket succeeded,
	// later rows no longer listed the (now air) cell, and passive sighted rows kept naming it, so options said
	// "possible lava 1m W" after the run had used it.
	const memory = new ObservedMemoryStore();
	const world = (gameTime) => ({ worldId: 'w', dimension: 'minecraft:overworld', gameTime });
	const at = (gameTime, extra = {}) => ({ position: { x: 69, y: 81, z: 145 }, ready: true, world: world(gameTime), observedAtEpochMs: gameTime * 50, ...extra });
	const lava = { blockId: 'minecraft:lava', ...place(68, 79, 145) };
	const lavaRows = () => memory.knownSources('a', { world: world(0) }, /lava/);
	memory.ingest('a', at(100, { sighted: { blocks: [lava] }, blocks: [{ x: 68, y: 79, z: 145, blockId: 'minecraft:lava' }] }), { snapshot: false });
	assert.deepEqual(lavaRows().sightings.map((row) => row.what), ['minecraft:lava']);
	assert.equal(lavaRows().blocks.length, 1);
	memory.recordResourceResult('a', at(110), { actionType: 'interact_block', arguments: { x: 68, y: 79, z: 145, face: 'up', hand: 'main', expectedItemId: 'minecraft:bucket' },
		state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED', message: 'Action completed', observedAtEpochMs: 110 * 50 });
	assert.deepEqual(lavaRows().sightings, [], 'the filled source is withdrawn');
	assert.deepEqual(lavaRows().blocks, [], 'the remembered lava block is forgotten');
	memory.ingest('a', at(120, { sighted: { blocks: [lava] } }), { snapshot: false });
	assert.deepEqual(lavaRows().sightings, [], 'a repeated passive sighting without a direct row does not restore it');
	memory.ingest('a', at(130, { blocks: [{ x: 68, y: 79, z: 145, blockId: 'minecraft:lava', lastSeenTick: 105, observedAtEpochMs: 105 * 50 }] }), { snapshot: false });
	assert.deepEqual(lavaRows().blocks, [], 'a delayed row from before the fill cannot bring it back');
	memory.ingest('a', at(140, { sighted: { blocks: [lava] }, blocks: [{ x: 68, y: 79, z: 145, blockId: 'minecraft:lava' }] }), { snapshot: false });
	assert.equal(lavaRows().sightings.length, 1, 'lava seen there again after the fill is remembered again');
});

test('a use_item bucket receipt names the source it took; other bucket uses and unknown cells change nothing', () => {
	const memory = new ObservedMemoryStore();
	const world = (gameTime) => ({ worldId: 'w', dimension: 'minecraft:overworld', gameTime });
	const at = (gameTime, extra = {}) => ({ position: { x: 0, y: -50, z: 0 }, ready: true, world: world(gameTime), observedAtEpochMs: gameTime * 50, ...extra });
	memory.ingest('a', at(10, { sighted: { blocks: [{ blockId: 'minecraft:lava', ...place(3, -55, 0) }, { blockId: 'minecraft:lava', ...place(40, -55, 40) }] } }), { snapshot: false });
	const lava = () => memory.knownSources('a', { world: world(0) }).sightings.filter((row) => row.kind === 'lava').map((row) => `${row.x},${row.y},${row.z}`).sort();
	const use = (message, state = 'SUCCEEDED', reasonCode = 'USE_INPUT_CONFIRMED') => memory.recordResourceResult('a', at(20), { actionType: 'use_item', arguments: { hand: 'main' }, state, reasonCode, message, observedAtEpochMs: 1000 });
	use('The bucket did not act; its ray met minecraft:lava source at 3,-55,0 face up (2.1 m); hand minecraft:bucket -> minecraft:bucket', 'FAILED', 'USE_NOT_ACCEPTED');
	use('Held use for 1 server ticks; accepted interactions=1; bucket ray met minecraft:lava source at 3,-55,0 face up (2.1 m); hand minecraft:water_bucket -> minecraft:bucket');
	assert.deepEqual(lava(), ['3,-55,0', '40,-55,40'], 'a failed use or a pour leaves the source');
	memory.recordResourceResult('a', at(20), { actionType: 'interact_block', arguments: { x: 9, y: -55, z: 9, expectedItemId: 'minecraft:bucket' }, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' });
	memory.recordResourceResult('a', at(20), { actionType: 'interact_block', arguments: { x: 40, y: -55, z: 40, expectedItemId: 'minecraft:water_bucket' }, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' });
	assert.deepEqual(lava(), ['3,-55,0', '40,-55,40'], 'no evidence about the cell, or no empty bucket, removes nothing');
	use('Held use for 1 server ticks; accepted interactions=1; bucket ray met minecraft:lava source at 3,-55,0 face up (2.1 m); hand minecraft:bucket -> minecraft:lava_bucket');
	assert.deepEqual(lava(), ['40,-55,40'], 'the filled source is withdrawn; the other stays');
});

test('the blocks-broken count survives a restart', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'need-sources-'));
	try {
		let now = 0;
		const first = new LiveTaskViews({ directory, now: () => now });
		first.suggest(record.agentId, record.currentGoal, { steps: [{ id: 'iron', label: 'iron', kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'has:minecraft:iron_ingot*3' }] });
		await first.observe(record, sample(0, [['stone_pickaxe']]));
		await broke(first, 10);
		await first.flush();
		now = 5 * 60_000;
		const second = new LiveTaskViews({ directory, now: () => now });
		await second.observe(record, sample(now, [['stone_pickaxe']]));
		assert.match(second.progress(record), /unchanged 5m, 10 blocks broken/);
		await second.flush();
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('a transient sighting that overflows the full map evicts a transient, not a structure', () => {
	const search = createSearch();
	for (let index = 0; index < 40; index += 1) recordSightings(search, { structures: [{ structure: `ruin ${index}`, size: 5, ...place(index * 64, 64, 0) }] }, index);
	for (let index = 0; index < 8; index += 1) recordSightings(search, { veins: [{ blockId: 'minecraft:coal_ore', visible: 1, ...place(index * 16, 16, 500) }] }, 100 + index);
	assert.equal(search.sightings.size, 48);
	recordSightings(search, { caves: [{ air: 50, ...place(0, 10, 900) }] }, 200);
	const whats = [...search.sightings.values()].map((row) => row.what);
	assert.equal(search.sightings.size, 48);
	assert.ok(whats.includes('ruin 0') && whats.includes('cave'), 'the oldest structure stays; the oldest vein went');
	assert.equal(whats.filter((what) => what === 'minecraft:coal_ore').length, 7);
});

test('crying obsidian is not obsidian', () => {
	assert.deepEqual(needResources(['minecraft:crying_obsidian']), ['crying_obsidian']);
	assert.deepEqual(needResources(['minecraft:obsidian']), ['obsidian']);
	const known = { sightings: [{ what: 'minecraft:lava', kind: 'lava', x: 5, y: 10, z: 0 }, { what: 'bastion', kind: 'structure', x: 0, y: 70, z: -40 }], blocks: [{ blockId: 'minecraft:obsidian', x: 1, y: 10, z: 1 }] };
	const crying = needOptions({ ids: ['minecraft:crying_obsidian'], position: { x: 0, y: 10, z: 0 }, known });
	assert.match(crying, /^crying_obsidian: possible bastion 40m N dy\+60; ways \(typical\): ruined portal frames and chests, bastion chests, piglin bartering/);
	assert.doesNotMatch(crying, /lava|water/);
	assert.doesNotMatch(needOptions({ ids: ['minecraft:obsidian'], position: { x: 0, y: 10, z: 0 }, known }), /bastion|crying/);
});

// Round 2 review regressions.

const rootStep = (check) => ({ id: 'need', label: 'need', kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check });

test('unmet roots the step line already counts still get their options', async () => {
	const cases = [['has:minecraft:obsidian*10', /^obsidian: est\. minutes to 10 more frame obsidian from here \(no water bucket held; casting needs one, any water fills a bucket\), cheapest first: dig to the y-55 lava floors ~37[; ]/],
		['has:minecraft:ender_pearl*12', /^ender_pearl: 12 more needed \(pearls and eyes held 0\/12: 0 pearls; 0 gold; eyes: 1 per empty End portal frame of 12 .*\), est\. options: 12 pearls by barter take ~188 gold/],
		['has:minecraft:blaze_rod*6', /^blaze_rod: seen none remembered; ways \(typical\): only from blazes/],
		['has:minecraft:iron_ingot*3', /^iron: seen none remembered; ways \(typical\): exposed ore/]];
	for (const [check, expected] of cases) {
		const views = new LiveTaskViews();
		const who = { ...record, agentId: `root-${check}` };
		views.suggest(who.agentId, who.currentGoal, { steps: [rootStep(check)] });
		await views.observe(who, sample(0, [['iron_pickaxe'], ['bucket']]));
		assert.match(views.continuity(who).options ?? '', expected, check);
	}
});

test('a bell or workstation the agent placed itself never makes a village', async () => {
	const memory = new ObservedMemoryStore();
	const views = new LiveTaskViews({ sources: (who, observation, pattern) => memory.knownSources(who.agentId, observation, pattern) });
	views.suggest(record.agentId, record.currentGoal, { steps: [rootStep('has:minecraft:iron_ingot*3')] });
	await views.observe(record, sample(0, [['stone_pickaxe']]));
	const placeAt = (itemId, x, z, id) => views.actionReceipt(record, { state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', actionType: 'place_block', actionId: id, goalRevision: 1, worldId: 'w', dimension: 'minecraft:overworld', arguments: { x, y: 16, z, itemId }, observedAtEpochMs: 10 });
	await placeAt('minecraft:bell', 5, 5, 'p1');
	await placeAt('minecraft:cauldron', 8, 5, 'p2');
	await placeAt('minecraft:lectern', 9, 5, 'p3');
	const seen = sample(20, [['stone_pickaxe']], { sighted: { poi: [{ blockId: 'minecraft:bell', ...place(5, 16, 5) }, { blockId: 'minecraft:cauldron', ...place(8, 16, 5) }, { blockId: 'minecraft:lectern', ...place(9, 16, 5) }] } });
	memory.ingest(record.agentId, seen, { snapshot: false });
	await views.observe(record, seen);
	assert.match(views.continuity(record).options, /^iron: seen none remembered;/);
	const real = sample(30, [['stone_pickaxe']], { sighted: { poi: [{ blockId: 'minecraft:bell', ...place(6, 16, 5) }] } });
	memory.ingest(record.agentId, real, { snapshot: false });
	await views.observe(record, real);
	assert.match(views.continuity(record).options, /^iron: possible village\(bell\) 8m SE;/, 'a bell beside the agent\'s own blocks is still evidence');
});

test('a cached row does not revive a sighting withdrawn by direct evidence', () => {
	const memory = new ObservedMemoryStore();
	const world = (gameTime) => ({ worldId: 'w', dimension: 'minecraft:overworld', gameTime });
	const at = { position: { x: 0, y: 64, z: 0 }, ready: true };
	const bell = { poi: [{ blockId: 'minecraft:bell', ...place(30, 64, 30) }] };
	const whats = (tick) => memory.knownSources('a', { world: world(tick) }).sightings.map((row) => row.what);
	memory.ingest('a', { ...at, world: world(10), sighted: bell }, { snapshot: false });
	memory.ingest('a', { ...at, world: world(20), sighted: bell, blocks: [{ x: 30, y: 64, z: 30, blockId: 'minecraft:air' }] }, { snapshot: false });
	assert.deepEqual(whats(20), [], 'air and the cached row in one sample withdraw the bell');
	memory.ingest('a', { ...at, world: world(30), sighted: bell }, { snapshot: false });
	assert.deepEqual(whats(30), [], 'a later cached row alone does not revive it');
	memory.ingest('a', { ...at, world: world(40), sighted: bell, blocks: [{ x: 30, y: 64, z: 30, blockId: 'minecraft:bell' }] }, { snapshot: false });
	assert.deepEqual(whats(40), ['minecraft:bell'], 'a newer direct sighting of the bell brings it back');
	const restored = restoreSearch(JSON.parse(JSON.stringify(serializeSearch(memory.search('a', { worldId: 'w', dimension: 'minecraft:overworld' })))));
	assert.equal(restored.withdrawn.size, 0);
});

// Round 3 review regressions.

const placeBell = (views, who, worldId, id) => views.actionReceipt(who, { state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', actionType: 'place_block', actionId: id, goalRevision: 1, worldId, dimension: 'minecraft:overworld', arguments: { x: 5, y: 16, z: 5, itemId: 'minecraft:bell' }, observedAtEpochMs: 10 });
const bellSighting = (at, worldId) => ({ ...sample(at, [['stone_pickaxe']], { sighted: { poi: [{ blockId: 'minecraft:bell', ...place(5, 16, 5) }] } }), world: { worldId, dimension: 'minecraft:overworld', gameTime: at } });

test('a placed bell stays the agent\'s own after a restart', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'need-sources-'));
	try {
		const first = new LiveTaskViews({ directory });
		first.suggest(record.agentId, record.currentGoal, { steps: [rootStep('has:minecraft:iron_ingot*3')] });
		await first.observe(record, sample(0, [['stone_pickaxe']]));
		await placeBell(first, record, 'w', 'p1');
		await first.flush();
		const memory = new ObservedMemoryStore();
		const second = new LiveTaskViews({ directory, sources: (who, observation, pattern) => memory.knownSources(who.agentId, observation, pattern) });
		const seen = bellSighting(20, 'w');
		memory.ingest(record.agentId, seen, { snapshot: false });
		await second.observe(record, seen);
		assert.match(second.continuity(record).options, /^iron: seen none remembered;/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('a bell placed in one world does not hide a natural bell in another', async () => {
	const memory = new ObservedMemoryStore();
	const views = new LiveTaskViews({ sources: (who, observation, pattern) => memory.knownSources(who.agentId, observation, pattern) });
	views.suggest(record.agentId, record.currentGoal, { steps: [rootStep('has:minecraft:iron_ingot*3')] });
	await views.observe(record, sample(0, [['stone_pickaxe']]));
	await placeBell(views, record, 'w', 'p1');
	const other = bellSighting(20, 'w2');
	memory.ingest(record.agentId, other, { snapshot: false });
	views.suggest(record.agentId, record.currentGoal, { steps: [rootStep('has:minecraft:iron_ingot*3')] });
	await views.observe(record, other);
	assert.match(views.continuity(record).options, /^iron: possible village\(bell\) 7m SE;/);
});

test('a newer crosshair hit on the block brings a withdrawn sighting back', () => {
	const memory = new ObservedMemoryStore();
	const world = (gameTime) => ({ worldId: 'w', dimension: 'minecraft:overworld', gameTime });
	const at = { position: { x: 0, y: 64, z: 0 }, ready: true };
	const bell = { poi: [{ blockId: 'minecraft:bell', ...place(30, 64, 30) }] };
	const whats = (tick) => memory.knownSources('a', { world: world(tick) }).sightings.map((row) => row.what);
	memory.ingest('a', { ...at, world: world(10), sighted: bell }, { snapshot: false });
	memory.ingest('a', { ...at, world: world(20), sighted: bell, blocks: [{ x: 30, y: 64, z: 30, blockId: 'minecraft:air' }] }, { snapshot: false });
	assert.deepEqual(whats(20), []);
	memory.ingest('a', { ...at, world: world(40), sighted: bell, interaction: { rayTarget: { type: 'block', blockId: 'minecraft:bell', x: 30, y: 64, z: 30 } } }, { snapshot: false });
	assert.deepEqual(whats(40), ['minecraft:bell']);
});

// Round 4 review regression.

test('a stale bell row in a newer sample does not revive a bell withdrawn by later air', () => {
	const memory = new ObservedMemoryStore();
	const world = (gameTime) => ({ worldId: 'w', dimension: 'minecraft:overworld', gameTime });
	const at = { position: { x: 0, y: 64, z: 0 }, ready: true };
	const bell = { poi: [{ blockId: 'minecraft:bell', ...place(30, 64, 30) }] };
	const whats = (tick) => memory.knownSources('a', { world: world(tick) }).sightings.map((row) => row.what);
	memory.ingest('a', { ...at, world: world(10), sighted: bell }, { snapshot: false });
	memory.ingest('a', { ...at, world: world(20), blocks: [{ x: 30, y: 64, z: 30, blockId: 'minecraft:air' }] }, { snapshot: false });
	memory.ingest('a', { ...at, world: world(30), blocks: [{ x: 30, y: 64, z: 30, blockId: 'minecraft:air' }] }, { snapshot: false });
	assert.deepEqual(whats(30), []);
	memory.ingest('a', { ...at, world: world(40), sighted: bell, blocks: [{ x: 30, y: 64, z: 30, blockId: 'minecraft:bell', lastSeenTick: 25 }] }, { snapshot: false });
	assert.deepEqual(whats(40), [], 'the tick-25 bell row is older than the tick-30 air');
	memory.ingest('a', { ...at, world: world(50), sighted: bell, interaction: { rayTarget: { type: 'block', blockId: 'minecraft:bell', x: 30, y: 64, z: 30 } } }, { snapshot: false });
	assert.deepEqual(whats(50), ['minecraft:bell'], 'a newer crosshair hit still revives it');
});

// Live run 2: no plan, strip mining with a stone pickaxe, memory full but never shown.

const run2 = { agentId: 'run2', currentGoal: 'beat the game.', goalRevision: 1, provider: 'codex', model: 'm', reasoningEffort: 'low' };
const run2Sample = (at, items, extra = {}) => ({ ready: true, observedAtEpochMs: at, position: { x: 76, y: 16, z: -640 }, player: { dead: false },
	world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime: 30_000 + Math.floor(at / 50) }, inventory: { items: items.map(([id, count = 1]) => ({ itemId: `minecraft:${id}`, count })) }, ...extra });

// The production ingress: dynamic-main ingests the wire sample into observed memory, adapts it for the task view, and
// builds the model input from the adapted sample. Only that path shows which shape each store really receives.
const wire = (at, items, extra = {}) => ({ ...factToWireObservation({ player: { x: 76, y: 16, z: -640 }, inventory: { items: items.map(([id, count = 1]) => ({ itemId: `minecraft:${id}`, count })) },
	world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime: 30_000 + Math.floor(at / 50), dayTime: 1000, raining: false, thundering: false } }, 1, Math.floor(at / 50) + 1, true, at), ...extra });
async function ingress(memory, views, who, sample) {
	memory.ingest(who.agentId, sample, { snapshot: false });
	const adapted = adaptObservation(sample);
	await views.observe(who, adapted, sample);
	const input = buildNativeEventInput(who, { event: 'observation', trigger: 'observation', eventSequence: sample.eventSequence, observation: adapted, continuity: views.continuity(who, { observation: adapted }) });
	return JSON.parse(input.slice(input.indexOf('\n') + 1)).now ?? {};
}

test('native source context includes only seen liquids and withdraws directly disproved water', async () => {
	const memory = new ObservedMemoryStore();
	const views = new LiveTaskViews({ sources: (who, o, pattern) => memory.knownSources(who.agentId, o, pattern) });
	const who = { ...run2, agentId: 'liquid-context' };
	const sample = (at, blockId, visible) => {
		const o = wire(at, [['stone_pickaxe']], { sighted: { caves: [{ air: 60, ...place(80, 16, -640) }] } });
		o.blocks.push({ blockId, x: 80, y: 16, z: -639, visible });
		return o;
	};
	const hidden = await ingress(memory, views, who, sample(1000, 'minecraft:water', false));
	assert.doesNotMatch(hidden.options, /water seen nearby/);
	const seen = await ingress(memory, views, who, sample(2000, 'minecraft:water', true));
	assert.match(seen.options, /@80,16,-640 \(water seen nearby\)/);
	assert.match(seen.known, /@80,16,-640 \(water seen nearby\)/);
	const gone = await ingress(memory, views, who, sample(3000, 'minecraft:air', true));
	assert.doesNotMatch(gone.options, /water seen nearby/);
	assert.match(gone.options, /possible cave/, 'withdrawal of water does not certify a dry route or remove the opening');
});

test('replay through production ingress: without a plan the header shows remembered sources, iron options and the mining yield', async () => {
	const memory = new ObservedMemoryStore();
	const views = new LiveTaskViews({ sources: (who, observation, pattern) => memory.knownSources(who.agentId, observation, pattern) });
	const start = wire(0, [['stone_pickaxe']]);
	await ingress(memory, views, run2, start);
	// Its own crafting table seen as a built cluster is neither remembered nor news.
	memory.recordResourceResult(run2.agentId, start, { actionType: 'place_block', arguments: { x: 75, y: 16, z: -652, itemId: 'minecraft:crafting_table' }, state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED' });
	const sighted = { built: [{ blocks: ['minecraft:crafting_table'], size: 1, ...place(75, 16, -652), new: true }],
		veins: [{ blockId: 'minecraft:iron_ore', visible: 2, ...place(77, 25, -600) }, { blockId: 'minecraft:copper_ore', visible: 6, ...place(75, 27, -673) }, { blockId: 'minecraft:coal_ore', visible: 3, ...place(75, 16, -660) }],
		caves: [{ air: 70, ...place(72, 28, -629) }, { air: 50, ...place(70, 20, -650) }, { air: 45, ...place(80, 20, -645) }] };
	const seen = wire(1000, [['stone_pickaxe']], { sighted, changedFacts: ['sighted'] });
	assert.deepEqual(withoutOwnSightings({ attention: true, changedFacts: ['sighted'] }, seen, memory.ownPlacements(run2.agentId, seen)), { attention: false, changedFacts: [] }, 'its own crafting table raises no structure_sighted wake');
	await ingress(memory, views, run2, seen);
	for (let index = 0; index < 160; index += 1) await views.actionReceipt(run2, { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', actionType: 'break_block', goalRevision: 1,
		worldId: 'w', dimension: 'minecraft:overworld', arguments: { x: 76, y: 16, z: -641 - index }, observedAtEpochMs: 2000 + index * 2000 });
	// Held attack broke 40 more; its tally arrives with the control result.
	await views.actionReceipt(run2, { state: 'SUCCEEDED', reasonCode: 'CONTROL_DONE', actionType: 'control', goalRevision: 1, worldId: 'w', dimension: 'minecraft:overworld', arguments: {}, observedAtEpochMs: 330_000, breakOutcome: { blocks: 40 } });
	const header = await ingress(memory, views, run2, wire(331_000, [['stone_pickaxe'], ['cobblestone', 64], ['raw_iron', 2], ['coal', 5]]));
	assert.match(header.known, /^ores: iron_ore x2 seen 40m S dy\+9 y25 @77,25,-600, coal_ore x3 seen 20m N y16 @75,16,-660, copper_ore x6 seen 33m N dy\+11 y27 @75,27,-673; caves: cave\(air 45\/125\) /);
	assert.match(header.options, /^\(best pickaxe stone\) iron: seen iron_ore x2 seen 40m S dy\+9 y25 @77,25,-600; possible cave\(air /, 'the iron vein comes before nearer caves');
	assert.equal(header.mining, 'last 2m: 95 blocks broken; mineral gains near breaks (source unverified): coal 5, raw_iron 2; last 10m: 200 blocks broken, gains coal 5, raw_iron 2');
	assert.doesNotMatch(JSON.stringify(header), /crafting_table/);
});

test('recent yield separates old successes in the native wake without a plan', async () => {
	const memory = new ObservedMemoryStore(), views = new LiveTaskViews();
	const who = { ...run2, agentId: 'recent-yield' };
	await ingress(memory, views, who, wire(0, [['stone_pickaxe']]));
	const receipt = (at, blocks, actionId) => views.actionReceipt(who, { actionId, state: 'SUCCEEDED', reasonCode: 'CONTROL_DONE', actionType: 'control',
		goalRevision: 1, worldId: 'w', observedAtEpochMs: at, breakOutcome: { blocks } });
	await receipt(60_000, 10, 'old');
	await ingress(memory, views, who, wire(61_000, [['stone_pickaxe'], ['coal', 5]]));
	await receipt(300_000, 40, 'recent');
	const header = await ingress(memory, views, who, wire(301_000, [['stone_pickaxe'], ['coal', 5]]));
	assert.equal(header.mining, 'last 2m: 40 blocks broken; mineral gains near breaks (source unverified): none observed; last 10m: 50 blocks broken, gains coal 5');
	const gained = await ingress(memory, views, who, wire(302_000, [['stone_pickaxe'], ['coal', 5], ['raw_iron', 1]]));
	assert.match(gained.mining, /^last 2m: 40 blocks broken; mineral gains near breaks \(source unverified\): raw_iron 1;/);
	assert.match(gained.mining, /last 10m: 50 blocks broken, gains coal 5, raw_iron 1$/);
	const other = wire(303_000, [['stone_pickaxe']]);
	other.world.worldId = 'other';
	await ingress(memory, views, who, other);
	assert.equal(views.continuity(who).mining, undefined, 'another world contributes no old yield');
});

test('needs without a valid plan come from the step or intent words, else the pickaxe tier', async () => {
	assert.deepEqual(textResources('Prepare survival gear ... then iron armor/shield/bucket/tools via safer mine'), ['iron']);
	assert.deepEqual(textResources('craft eyes of ender'), ['ender_pearl', 'blaze_rod']);
	assert.deepEqual([null, 'wooden', 'stone', 'iron', 'diamond'].map((tier) => pickaxeTier(tier ? [{ itemId: `minecraft:${tier}_pickaxe`, count: 1 }] : [])?.resources[0] ?? null), ['logs', 'cobblestone', 'iron', 'diamond', null]);
	const views = new LiveTaskViews();
	const who = { ...record, agentId: 'manual' };
	views.suggest(who.agentId, who.currentGoal, { steps: [{ id: 'gear', label: 'Prepare survival gear', kind: 'manual', status: 'pending', dependsOn: [], detail: 'then iron armor/shield/bucket/tools via safer mine', evidence: null, check: null }] });
	await views.observe(who, sample(0, [['stone_pickaxe']]));
	assert.match(views.continuity(who).options, /^\(step gear\) iron: seen none remembered; ways/);
	await views.operate(who, { operation: 'intent', intent: { step: 'wood', why: 'need logs for a table' } });
	assert.match(views.continuity(who).options, /^\(intent wood\) logs: /, 'the model\'s intent names what it is after first');
});

test('a tool check with a count is a tool check', () => {
	const plan = validateTaskPlan({ steps: [{ id: 'pick', label: 'Stone pickaxe', kind: 'inventory', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'tool:pickaxe:stone+1' }] });
	assert.equal(plan.steps[0].check, 'tool:pickaxe:stone+1');
	const held = { ready: true, observedAtEpochMs: 1, player: { dead: false }, inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }] } };
	assert.equal(evaluatePlanCheck('tool:pickaxe:stone+1', held, emptyKnown()).ok, evaluatePlanCheck('tool:pickaxe:stone+', held, emptyKnown()).ok);
	assert.equal(evaluatePlanCheck('tool:pickaxe:iron+1', held, emptyKnown()).ok, false);
});

test('built clusters of only its own blocks are not sightings; real built clusters and other news stay', () => {
	const search = createSearch();
	const own = [{ x: 0, y: 64, z: 0, blockId: 'minecraft:crafting_table' }, { x: 1, y: 64, z: 0, blockId: 'minecraft:furnace' }];
	for (const row of own) recordPlacement(search, row);
	recordSightings(search, { built: [{ blocks: ['minecraft:furnace', 'minecraft:crafting_table'], size: 2, ...place(0, 64, 0) }, { blocks: ['minecraft:oak_planks', 'minecraft:crafting_table'], size: 6, ...place(4, 64, 4) }] }, 5);
	assert.deepEqual([...search.sightings.values()].map((row) => row.what), ['built:minecraft:oak_planks+minecraft:crafting_table']);
	const payload = { attention: true, changedFacts: ['sighted', 'inventory'] };
	assert.deepEqual(withoutOwnSightings(payload, { sighted: { built: [{ blocks: ['minecraft:crafting_table'], size: 1, ...place(0, 64, 0), new: true }] } }, own), { attention: true, changedFacts: ['inventory'] });
	const village = { sighted: { built: [{ blocks: ['minecraft:crafting_table'], size: 1, ...place(0, 64, 0), new: true }], structures: [{ structure: 'village', size: 40, ...place(90, 64, 0), new: true }] } };
	assert.equal(withoutOwnSightings(payload, village, own), payload, 'a real structure keeps the wake');
	assert.equal(restoreSearch(JSON.parse(JSON.stringify(serializeSearch(search)))).placed.size, 2, 'own placements survive persistence');
});

test('the known line ranks ores, shows cave air and stays within its cap', () => {
	const sightings = [];
	for (let index = 0; index < 30; index += 1) sightings.push({ what: 'minecraft:copper_ore', kind: 'vein', visible: 1, x: index, y: 40, z: 0 });
	sightings.push({ what: 'minecraft:diamond_ore', kind: 'vein', visible: 1, x: 200, y: -58, z: 0 }, { what: 'cave', kind: 'cave', air: 41, x: 0, y: 30, z: 20 }, { what: 'minecraft:lava', kind: 'lava', x: 0, y: 10, z: -5 }, { what: 'shipwreck', kind: 'structure', x: 0, y: 60, z: 300 });
	const line = knownLine({ known: { sightings, blocks: [] }, position: { x: 0, y: 40, z: 0 } });
	assert.ok(Buffer.byteLength(line) <= KNOWN_BYTES);
	assert.match(line, /^ores: diamond_ore x1 seen 200m E dy-98 y-58 @200,-58,0, /);
	assert.match(line, /caves: cave\(air 41\/125\) 20m S dy-10 y30 @0,30,20; places: shipwreck 300m S dy\+20; lava: lava 5m N dy-30 y10$/);
	assert.equal(knownLine({ known: { sightings: [], blocks: [] }, position: { x: 0, y: 0, z: 0 } }), null);
});

test('the mining feedback starts at one break and expires after ten minutes', async () => {
	let now = 0;
	const views = new LiveTaskViews({ now: () => now });
	const who = { ...record, agentId: 'miner' };
	await views.observe(who, sample(0, [['stone_pickaxe']]));
	assert.equal(views.continuity(who).mining, undefined);
	const breakAt = (at, index) => views.actionReceipt(who, { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', actionType: 'break_block', goalRevision: 1, worldId: 'w', dimension: 'minecraft:overworld', arguments: { x: index, y: 16, z: 0 }, observedAtEpochMs: at });
	await breakAt(1, -1);
	await views.observe(who, sample(2, [['stone_pickaxe']]));
	assert.match(views.continuity(who).mining, /^last 10m: 1 block broken;/);
	for (let index = 0; index < 40; index += 1) await breakAt(1000 + index, index);
	for (let index = 0; index < 29; index += 1) await breakAt(700_000 + index, 100 + index);
	now = 700_100;
	await views.observe(who, sample(now, [['stone_pickaxe']]));
	assert.match(views.continuity(who).mining, /^last 10m: 29 blocks broken;/, 'old breaks expire, short mining attempts remain visible');
	await breakAt(700_050, 200);
	assert.equal(views.continuity(who).mining, 'last 10m: 30 blocks broken; mineral gains near breaks (source unverified): none observed');
	await views.observe(who, sample(1_300_100, [['stone_pickaxe']]));
	assert.equal(views.continuity(who).mining, undefined);
});

// Review round 5 regressions.

test('held-attack break tallies count toward the mining yield; break_block tallies are not counted twice', async () => {
	const views = new LiveTaskViews({ now: () => 100_000 });
	const who = { ...record, agentId: 'held-attack' };
	await views.observe(who, sample(0, [['stone_pickaxe']]));
	const result = (actionType, blocks) => views.actionReceipt(who, { state: 'SUCCEEDED', reasonCode: actionType === 'break_block' ? 'BLOCK_BROKEN' : 'CONTROL_DONE', actionType, goalRevision: 1, worldId: 'w', dimension: 'minecraft:overworld', arguments: { x: 1, y: 2, z: 3 }, observedAtEpochMs: 50_000, breakOutcome: { blocks } });
	await result('control_sequence', 29);
	await result('break_block', 1);
	await views.observe(who, sample(60_000, [['stone_pickaxe']]));
	assert.equal(views.continuity(who).mining, 'last 10m: 30 blocks broken; mineral gains near breaks (source unverified): none observed');
});

test('a built cluster counts as its own only where its cells are its placed cells', () => {
	const plank = [{ x: 0, y: 64, z: 0, blockId: 'minecraft:oak_planks' }];
	const tower = { blocks: ['minecraft:oak_planks'], size: 12, x: 3, y: 164, z: 2 };
	assert.equal(ownSighting('built', tower, plank), false, 'one placed plank does not own a structure 100 blocks up');
	assert.equal(ownSighting('built', { ...tower, y: 64, x: 0, z: 0 }, plank), false, 'nor a 12-wide cluster around it');
	const hut = Array.from({ length: 4 }, (_, index) => ({ x: index, y: 64, z: 0, blockId: 'minecraft:oak_planks' }));
	assert.equal(ownSighting('built', { blocks: ['minecraft:oak_planks'], size: 4, x: 0, y: 64, z: 0 }, hut), true);
	assert.equal(ownSighting('built', { blocks: ['minecraft:oak_planks', 'minecraft:glass'], size: 4, x: 0, y: 64, z: 0 }, hut), false, 'glass it never placed');
});

test('options need an acquisition: no tier advice for other goals, no mentions or negations', async () => {
	assert.deepEqual(textResources('inspect server logs'), []);
	assert.deepEqual(textResources('avoid iron golems while mining'), [], 'the negated iron is not a need');
	assert.deepEqual(textResources('do not mine diamonds yet'), []);
	assert.deepEqual(textResources('mine iron and coal'), ['iron', 'coal']);
	for (const goal of ['build a dirt hut', 'say hello to Lucas']) {
		const views = new LiveTaskViews();
		const who = { ...record, agentId: `goal-${goal}`, currentGoal: goal };
		await views.observe(who, sample(0, [['stone_pickaxe']]));
		assert.equal(views.continuity(who)?.options, undefined, goal);
	}
	const views = new LiveTaskViews();
	const dragon = { ...record, agentId: 'dragon', currentGoal: 'kill the ender dragon' };
	await views.observe(dragon, sample(0, [['stone_pickaxe']]));
	assert.match(views.continuity(dragon).options, /^\(best pickaxe stone\) iron: /);
});

test('items gained far from any break are not counted as mined', async () => {
	let now = 0;
	const views = new LiveTaskViews({ now: () => now });
	const who = { ...record, agentId: 'chest' };
	await views.observe(who, sample(0, [['stone_pickaxe']]));
	for (let index = 0; index < 30; index += 1) await views.actionReceipt(who, { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', actionType: 'break_block', goalRevision: 1, worldId: 'w', dimension: 'minecraft:overworld', arguments: { x: index, y: 16, z: 0 }, observedAtEpochMs: 1000 + index });
	await views.observe(who, sample(5000, [['stone_pickaxe'], ['raw_iron', 1]]));
	now = 200_000;
	await views.observe(who, sample(now, [['stone_pickaxe'], ['raw_iron', 1], ['diamond', 5]]));
	await views.observe(who, sample(now + 1, [['stone_pickaxe'], ['raw_iron', 1]]));
	await views.observe(who, sample(now + 2, [['stone_pickaxe'], ['raw_iron', 1], ['diamond', 5]]));
	assert.equal(views.continuity(who).mining, 'last 2m: 0 blocks broken; mineral gains near breaks (source unverified): none observed; last 10m: 30 blocks broken, gains raw_iron 1', 'the diamonds came from a chest, not a break');
});

test('native receipts without a dimension still count breaks and own bells', async () => {
	const memory = new ObservedMemoryStore();
	const views = new LiveTaskViews({ now: () => 0, sources: (who, observation, pattern) => memory.knownSources(who.agentId, observation, pattern) });
	const who = { ...record, agentId: 'native' };
	await views.observe(who, sample(0, [['stone_pickaxe']]));
	const receipt = (fields) => views.actionReceipt(who, { state: 'SUCCEEDED', goalRevision: 1, worldId: 'w', observedAtEpochMs: 10, ...fields });
	await receipt({ reasonCode: 'BLOCK_PLACED', actionType: 'place_block', actionId: 'bell', arguments: { x: 5, y: 16, z: 5, face: 'up', itemId: 'minecraft:bell' } });
	for (let index = 0; index < 30; index += 1) await receipt({ reasonCode: 'BLOCK_BROKEN', actionType: 'break_block', actionId: `b${index}`, arguments: { x: index, y: 16, z: 0, expectedBlockId: 'minecraft:stone', timeoutMs: 5000 } });
	const seen = sample(20, [['stone_pickaxe']], { sighted: { poi: [{ blockId: 'minecraft:bell', ...place(5, 16, 5) }] } });
	memory.ingest(who.agentId, seen, { snapshot: false });
	await views.observe(who, seen);
	assert.equal(views.continuity(who).mining, 'last 10m: 30 blocks broken; mineral gains near breaks (source unverified): none observed');
	assert.match(views.continuity(who).options, /^\(best pickaxe stone\) iron: seen none remembered;/, 'its own bell is still no village');
});

// Review round 6 regressions.

test('namespaced ids in step text stay whole', () => {
	assert.deepEqual(textResources('need minecraft:iron_ingot'), ['iron']);
	assert.deepEqual(textResources('mine minecraft:iron_ore'), ['iron']);
	assert.deepEqual(textResources('step: mine iron'), ['iron'], 'a plain colon still ends a clause');
});

test('a negation before the acquisition verb negates the whole phrase', () => {
	assert.deepEqual(textResources('do not mine any more iron'), []);
	assert.deepEqual(textResources('never collect more coal than needed'), []);
});

test('a place phrase is no progression goal', () => {
	assert.equal(progressionGoal('Plant flowers at the end of the bridge'), false);
	assert.equal(progressionGoal('the nether is scary'), false);
	for (const goal of ['beat the game.', 'kill the ender dragon', 'go to the nether', 'enter the end', 'find a stronghold', 'get full diamond armor']) assert.equal(progressionGoal(goal), true, goal);
});

test('seen spawners and source mobs are remembered and offered as blaze rod and pearl leads (d6-nether-a saw the spawner 23 m away, then lost it)', () => {
	const search = createSearch();
	const nether = { dimension: 'minecraft:the_nether' };
	// A far row shows no mob; in the Nether it is a possible rod lead.
	recordSightings(search, { blocks: [{ blockId: 'minecraft:spawner', ...place(84, 73, 92) }] }, 10, undefined, nether);
	const position = { x: 60, y: 70, z: 90 };
	const known = () => ({ sightings: [...search.sightings.values()], blocks: [] });
	assert.match(needOptions({ ids: ['minecraft:blaze_rod'], position, known: known() }), /^blaze_rod: possible spawner 24m E y73 @84,73,92; ways/);
	// Up close the direct row shows the mob, which a later far row keeps; seen blazes and endermen are leads too.
	recordSightings(search, {}, 20, undefined, { ...nether, blocks: [{ blockId: 'minecraft:spawner', x: 84, y: 73, z: 92, appearance: { mob: 'minecraft:blaze' } }],
		entities: [{ type: 'minecraft:blaze', x: 80.5, y: 75.2, z: 90.5, perceivedBy: 'sight' }, { type: 'minecraft:enderman', x: 20, y: 70, z: 90, perceivedBy: 'sight' },
			{ type: 'minecraft:enderman', x: 0, y: 70, z: 0, perceivedBy: 'sound' }, { type: 'minecraft:wither_skeleton', x: 61, y: 70, z: 90, perceivedBy: 'sight' }] });
	recordSightings(search, { blocks: [{ blockId: 'minecraft:spawner', ...place(84, 73, 92) }] }, 30, undefined, nether);
	assert.equal(search.sightings.get('minecraft:spawner@10,11').mob, 'minecraft:blaze');
	assert.match(needOptions({ ids: ['minecraft:blaze_rod'], position, known: known() }), /^blaze_rod: seen blaze 20m E dy\+5 @80,75,90, spawner\(blaze\) 24m E y73 @84,73,92; ways/);
	assert.match(needOptions({ ids: ['minecraft:ender_pearl'], position, known: known() }), /^ender_pearl: 12 more needed .*; enderman seen 40m W @20,70,90: 0-1 pearl per kill/);
	assert.ok(![...search.sightings.values()].some(row => row.what === 'minecraft:wither_skeleton' || row.x === 0), 'other mobs and heard ones are not leads');
	assert.match(knownLine({ known: known(), position }), /places: spawner\(blaze\) 24m E y73 @84,73,92/);
	// An Overworld dungeon spawner of unseen mob is no rod lead.
	const overworld = createSearch();
	recordSightings(overworld, { blocks: [{ blockId: 'minecraft:spawner', ...place(84, 73, 92) }] }, 10, undefined, { dimension: 'minecraft:overworld' });
	assert.match(needOptions({ ids: ['minecraft:blaze_rod'], position, known: { sightings: [...overworld.sightings.values()], blocks: [] } }), /^blaze_rod: seen none remembered/);
	// Pearl and rod sources both fit an ender eye's line.
	const both = needOptions({ ids: ['minecraft:ender_eye'], position, known: known() });
	assert.match(both, /^ender_pearl: .* \| blaze_rod: seen blaze/);
	assert.ok(Buffer.byteLength(both) <= PEARL_OPTIONS_BYTES, 'a pearl need widens the line for its priced options');
});

test('a Nether sample\'s sighted spawner and seen blazes reach the blaze rod options through memory', () => {
	const memory = new ObservedMemoryStore();
	const world = { worldId: 'w', dimension: 'minecraft:the_nether', gameTime: 100 };
	const observation = { ready: true, observedAtEpochMs: 1, world, position: { x: 60, y: 70, z: 90 },
		sighted: { blocks: [{ blockId: 'minecraft:spawner', ...place(84, 73, 92) }] },
		entities: [{ stableId: 'b1', type: 'minecraft:blaze', x: 82, y: 75, z: 93, perceivedBy: 'sight', alive: true }] };
	memory.ingest('a', observation, { snapshot: false });
	// Later samples no longer show either; memory keeps them.
	const later = { ready: true, observedAtEpochMs: 2, world: { ...world, gameTime: 400 }, position: { x: 40, y: 70, z: 90 } };
	memory.ingest('a', later, { snapshot: false });
	assert.match(needOptions({ ids: ['minecraft:blaze_rod'], known: memory.knownSources('a', later), position: later.position }),
		/^blaze_rod: seen blaze 42m E dy\+5 @82,75,93; possible spawner 44m E y73 @84,73,92; ways/);
	const stale = { ...later, observedAtEpochMs: 3, world: { ...world, gameTime: 7000 } };
	memory.ingest('a', stale, { snapshot: false });
	assert.match(needOptions({ ids: ['minecraft:blaze_rod'], known: memory.knownSources('a', stale), position: stale.position }),
		/^blaze_rod: possible spawner 44m E y73 @84,73,92; ways/, 'a blaze seen over 5 minutes ago is dropped; the spawner stays');
	const memoryAway = memory.knownSources('a', { world: { worldId: 'w', dimension: 'minecraft:overworld' } });
	assert.equal(memoryAway, null, 'Nether sightings stay in the Nether scope');
});

// Nether access options in one unit: expected minutes to the frame obsidian still needed, cheapest first.

const held = (...ids) => ids.map(([id, count = 1]) => ({ itemId: `minecraft:${id}`, count }));
const source = (x, y, z) => ({ blockId: 'minecraft:lava', x, y, z, blockState: '{"level":"0"}' });
const flowing = (x, y, z) => ({ blockId: 'minecraft:lava', x, y, z, blockState: '{"level":"3"}' });
const estimates = (line) => [...line.matchAll(/ ~(<1|\d+)(?= |;|$)/g)].map((match) => match[1] === '<1' ? 0 : Number(match[1]));

test('the obsidian options state every way as expected minutes from here, cheapest first', () => {
	const line = obsidianOptions({ position: { x: 0, y: 16, z: 0 }, items: held(['iron_pickaxe'], ['water_bucket']), cap: 2000 });
	assert.match(line, /^obsidian: est\. minutes to 10 more frame obsidian from here, cheapest first: dig to the y-55 lava floors ~34 \(71-level dig_to shaft 2 in a few calls, then a search: 6 recorded descents, 2 saw a 64-source pool within 4 min, 4 climbed back after 1-16 min without one; 10 casts 13\); search caves and surface above y-20 ~1780 \(26 recorded games spent 1767 min up there and 1 usable pool came into view; vanilla lakes 1 per 200 chunks surface, 1 per 9 underground\)/);
	assert.match(line, /usable = enough still sources \(not flowing or filled\)/);
	assert.match(line, /aquifer water met while digging refills the bucket(;|$)/);
	assert.match(obsidianOptions({ position: { x: 0, y: -54, z: 0 }, items: held(['water_bucket']), cap: 2000 }), /cheapest first: lava-floor depth here ~32 \(search: 6 recorded descents, 2 saw a 64-source pool within 4 min, 4 climbed back after 1-16 min without one; 10 casts 13\)/);
});

test('a remembered lava pool is weighed by its still sources: seen enough, only flowing, or the recorded share', () => {
	const position = { x: 0, y: 64, z: 0 };
	const pool = { what: 'minecraft:lava', kind: 'lava', x: 40, y: 20, z: 0 };
	const items = held(['iron_pickaxe'], ['water_bucket']);
	const rich = obsidianOptions({ position, items, cap: 2000, known: { sightings: [pool], blocks: Array.from({ length: 12 }, (_, i) => source(40 + (i % 4), 20, Math.floor(i / 4))) } });
	assert.match(rich, /cheapest first: lava 40m E dy-44 y20 ~16 \(walk 3, 10 casts 13; 12 still sources seen\); dig to the y-55 lava floors ~36/);
	const fall = obsidianOptions({ position, items, cap: 2000, known: { sightings: [pool], blocks: [flowing(40, 20, 0), flowing(40, 19, 0)] } });
	assert.match(fall, /lava 40m E dy-44 y20 ~37 \(walk 3, 10 casts 13; only flowing seen\)/, 'a lava fall holds no sources to cast: the dig from there is the whole fallback');
	const unknown = obsidianOptions({ position, items, cap: 2000, known: { sightings: [pool], blocks: [] } });
	assert.match(unknown, /lava 40m E dy-44 y20 ~21 \(walk 3, 10 casts 13; usable ~75%\)/);
	const small = obsidianOptions({ position, items, cap: 2000, known: { sightings: [{ ...pool, y: 70, count: 2 }], blocks: [] } });
	assert.match(small, /lava 40m E dy\+6 y70 ~32 \(walk <1, 10 casts 13; usable ~20%\)/, 'small surface lava was a ruined portal\'s or a lava fall in recorded games');
	const lake = obsidianOptions({ position, items, cap: 2000, known: { sightings: [{ ...pool, y: 70, count: 8 }], blocks: [] } });
	assert.match(lake, /lava 40m E dy\+6 y70 ~19 \(walk <1, 10 casts 13; usable ~75%\)/, 'far sight reports 8+ seen blocks only for a large pool');
	for (const text of [rich, fall, unknown, small, lake]) {
		const values = estimates(text);
		assert.deepEqual(values, [...values].sort((left, right) => left - right), text);
	}
});

test('a ruined portal states its missing cells and the lava beside it, and the frame in view replaces the guess', () => {
	const position = { x: 0, y: 70, z: 0 };
	const items = held(['iron_pickaxe'], ['water_bucket'], ['bucket']);
	const portal = { what: 'ruined portal', kind: 'structure', x: 20, y: 70, z: 0 };
	const unseen = obsidianOptions({ position, items, cap: 2000, known: { sightings: [portal, { what: 'minecraft:lava', kind: 'lava', x: 22, y: 69, z: 1 }], blocks: [source(22, 69, 1), flowing(23, 69, 1)] } });
	assert.match(unseen, /ruined portal 20m E ~\d+ \(walk <1, frame unseen \(~5 missing\), 1 lava source beside; (4 carried up from y-55|new frame at y-55 cheaper)\)/);
	assert.doesNotMatch(unseen, /lava 22m/, 'lava beside the portal belongs to it');
	const frame = { x: 20, y: 70, z: 0, axis: 'x', interior: [2, 3], obsidian: 7, needed: 10, lit: false, blocked: [],
		missing: [[20, 69, 0, 'lava source'], [21, 69, 0, 'crying_obsidian'], [22, 70, 0, 'air']] };
	const seen = obsidianOptions({ position, items, frames: [frame], cap: 2000, known: { sightings: [portal], blocks: [source(23, 69, 1), source(24, 69, 1)] } });
	assert.match(seen, /cheapest first: ruined portal 20m E ~5 \(walk <1, frame 7\/10, 3 lava sources beside, 1 crying obsidian to break\)/);
	const own = obsidianOptions({ position, items, frames: [{ ...frame, x: 200 }], cap: 2000, known: { sightings: [], blocks: [] } });
	assert.match(own, /frame in view 200m E ~\d+ \(walk <1, frame 7\/10, 1 lava source beside, 1 crying obsidian to break; 2 carried up from y-55\)/);
	assert.match(obsidianOptions({ position, items, frames: [{ ...frame, lit: true }], cap: 2000 }), /cheapest first: lit portal in view 20m E ~<1/);
	assert.match(obsidianOptions({ position, items, cap: 2000, known: { sightings: [{ what: 'minecraft:nether_portal', kind: 'portal', x: 0, y: 70, z: -300 }], blocks: [] } }), /cheapest first: lit portal 300m N ~1;/);
});

test('held obsidian, lava buckets and a diamond pick change the estimates; remembered obsidian needs a diamond pick', () => {
	const position = { x: 0, y: 16, z: 0 };
	const known = { sightings: [], blocks: [{ blockId: 'minecraft:obsidian', x: 30, y: 16, z: 0 }, { blockId: 'minecraft:obsidian', x: 31, y: 16, z: 0 }] };
	const iron = obsidianOptions({ position, known, items: held(['iron_pickaxe'], ['water_bucket'], ['obsidian', 3], ['lava_bucket', 2]), cap: 2000 });
	assert.match(iron, /^obsidian: est\. minutes to 7 more frame obsidian from here \(held: 3 obsidian, 2 lava buckets \(1 cast each anywhere\)\), cheapest first: dig to the y-55 lava floors ~30 \(71-level dig_to shaft 2 in a few calls, then a search: 6 recorded descents, 2 saw a 64-source pool within 4 min, 4 climbed back after 1-16 min without one; 7 casts 9\)/);
	assert.match(iron, /obsidian x2 30m E \(mining needs a diamond pick\)/);
	const diamond = obsidianOptions({ position, known, items: held(['diamond_pickaxe'], ['water_bucket']), cap: 2000 });
	assert.match(diamond, /cheapest first: dig to the y-55 lava floors ~28 \(71-level dig_to shaft 2 in a few calls, then a search: 6 recorded descents, 2 saw a 64-source pool within 4 min, 4 climbed back after 1-16 min without one; mine 10 7\); obsidian x2 30m E ~28 \(walk <1, mine 2\)/);
	assert.match(obsidianOptions({ position, items: held(['iron_pickaxe'], ['bucket']), cap: 2000 }), /\(no water bucket held; casting needs one, any water fills a bucket\)/);
});

test('the Nether access line keeps every obsidian option and the light within its byte budget', () => {
	const position = { x: 0, y: 70, z: 0 };
	const sightings = [{ what: 'ruined portal', kind: 'structure', x: 100, y: 70, z: 0 }, { what: 'minecraft:nether_portal', kind: 'portal', x: 0, y: 70, z: 900 },
		...Array.from({ length: 6 }, (_, i) => ({ what: 'minecraft:lava', kind: 'lava', x: -200 - i * 40, y: 10 - i * 5, z: 50 }))];
	const line = needOptions({ resources: ['obsidian', 'flint'], basis: 'step nether: Nether access; casting needs no diamond pick', position, known: { sightings, blocks: [] }, items: held(['iron_pickaxe'], ['water_bucket']), cap: NETHER_OPTIONS_BYTES });
	assert.ok(Buffer.byteLength(line) <= NETHER_OPTIONS_BYTES, `${Buffer.byteLength(line)} bytes`);
	assert.match(line, / \| flint: /, 'the light still fits');
	for (const option of ['dig to the y-55 lava floors', 'ruined portal 100m E', 'lit portal 900m S', 'search caves and surface above y-20']) assert.match(line, new RegExp(option), option);
	assert.equal((line.match(/lava \d+m/g) ?? []).length, 6, 'every remembered pool stays listed');
	const values = estimates(line.slice(0, line.indexOf(' | flint')));
	assert.deepEqual(values, [...values].sort((left, right) => left - right));
	assert.ok(Buffer.byteLength(needOptions({ ids: ['minecraft:obsidian'], position, known: { sightings, blocks: [] }, items: held(['water_bucket']) })) <= OPTIONS_BYTES);
});

test('remembered caves are listed beside the obsidian options as where lava lies', () => {
	const line = obsidianOptions({ position: { x: 0, y: 64, z: 0 }, items: held(['iron_pickaxe'], ['water_bucket']), cap: 2000,
		known: { sightings: [{ what: 'cave', kind: 'cave', air: 60, x: 30, y: 40, z: 0 }, { what: 'cave', kind: 'cave', air: 40, x: 0, y: 50, z: -90 }] } });
	assert.match(line, /caves seen: 30m E dy-24 y40, 90m N dy-14 y50 \(lava pools sit in caves; dig_to's look round one names lava in sight\)/);
});

test('above y-20 the measured search there is an option; at the floors the nearby-pool fact leads the notes', () => {
	const high = obsidianOptions({ position: { x: 0, y: 64, z: 0 }, items: held(['iron_pickaxe'], ['water_bucket']), cap: 2000 });
	assert.match(high, /search caves and surface above y-20 ~1780 \(26 recorded games spent 1767 min up there and 1 usable pool came into view/);
	assert.doesNotMatch(high, /unseen surface lava lake/, 'the measured search above y-20 includes the surface walk');
	assert.doesNotMatch(high, /below y-45 the recorded games/);
	const deep = obsidianOptions({ position: { x: 0, y: -50, z: 0 }, items: held(['iron_pickaxe'], ['water_bucket']), cap: NETHER_OPTIONS_BYTES });
	assert.match(deep, /lava-floor depth here ~32 .*below y-45 the recorded games had a 10\+ source pool within 32 blocks at every moment \(median 5\), behind rock until a cave opening or heard lava shows its side/);
	assert.doesNotMatch(deep, /search caves and surface above/);
});

test('before the trip down, the respawn fact shows only while a bed is at hand', () => {
	const position = { x: 0, y: 64, z: 0 };
	assert.equal(descentRespawnFact({ position, items: held(['iron_pickaxe'], ['white_wool', 2]) }), null, 'no bed materials: nothing to gather for');
	assert.equal(descentRespawnFact({ position: { x: 0, y: -10, z: 0 }, items: held(['red_bed']) }), null, 'already down');
	assert.match(descentRespawnFact({ position, items: held(['white_wool', 3]) }), /^trip down: a bed from the 3 wool held \(\+ 3 planks\), placed by the staircase top and used, sets the respawn there; otherwise a death at the floors respawns at the world spawn, and items dropped in lava burn$/);
	assert.match(descentRespawnFact({ position, items: held(['red_bed']) }), /^trip down: the bed carried, placed by the staircase top and used \(by day too\), sets/);
	assert.match(descentRespawnFact({ position, placed: [{ blockId: 'minecraft:red_bed', x: 18, y: 64, z: 24 }], items: [] }), /^trip down: the bed placed 30m away, used \(by day too\), sets/);
	assert.equal(descentRespawnFact({ position, placed: [{ blockId: 'minecraft:red_bed', x: 300, y: 64, z: 0 }], items: [] }), null, 'a far bed is not by this staircase');
});

test('pearlHuntLine names the nearest walkable enderman within 16 m while pearls are open', () => {
	const open = 'has:minecraft:ender_pearl|minecraft:ender_eye*12 pearls';
	const position = { x: 0, y: 50, z: 0 };
	const enderman = (distance, y, extra = {}) => ({ type: 'minecraft:enderman', alive: true, distance, x: distance, y, z: 0, ...extra });
	const observation = (entities, items = [{ itemId: 'minecraft:ender_pearl', count: 1 }]) => ({ entities, inventory: { items } });
	assert.equal(pearlHuntLine({ observation: observation([enderman(7, 51), enderman(12, 50)]), position, open }),
		'enderman 7 m, 1 up, calm, 1 more within 16 m; pearls 1/12 open');
	// The wire form nests the feet position.
	assert.equal(pearlHuntLine({ observation: observation([{ type: 'minecraft:enderman', distance: 5, position: { x: 5, y: 48, z: 0 }, targetingAgent: true }]), position, open }),
		'enderman 5 m, 2 down, angry at you; pearls 1/12 open');
	// A ledge 7 up is skipped for a walkable one farther off; none walkable or none within 16 m gives no line.
	assert.match(pearlHuntLine({ observation: observation([enderman(4, 57), enderman(10, 50)]), position, open }), /^enderman 10 m, level/);
	assert.equal(pearlHuntLine({ observation: observation([enderman(4, 57)]), position, open }), null);
	assert.equal(pearlHuntLine({ observation: observation([enderman(17, 50)]), position, open }), null);
	assert.equal(pearlHuntLine({ observation: { ...observation([enderman(6, 50)]), currentAction: { active: true, actionType: 'travel_to' } }, position, open }),
		'enderman 6 m, level, calm; pearls 1/12 open; your travel_to is still running and does not stop for it');
	// No open pearl need, enough pearls held, or an unknown inventory: no line.
	assert.equal(pearlHuntLine({ observation: observation([enderman(7, 50)]), position, open: 'has:minecraft:blaze_rod*6' }), null);
	assert.equal(pearlHuntLine({ observation: observation([enderman(7, 50)], [{ itemId: 'minecraft:ender_pearl', count: 12 }]), position, open }), null);
	assert.equal(pearlHuntLine({ observation: { entities: [enderman(7, 50)], inventory: { items: [] }, continuity: { rememberedSections: ['inventory'] } }, position, open }), null);
});
