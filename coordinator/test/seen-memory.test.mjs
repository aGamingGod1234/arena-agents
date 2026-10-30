import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservedMemoryStore } from '../src/observed-memory-store.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { readFileSync } from 'node:fs';
import { adaptObservation } from '../src/observation-adapter.mjs';

const log = { blockId: 'minecraft:oak_log', x: -5, y: 94, z: 0, tags: ['#minecraft:logs'] };
const drop = { stableId: '00000000-0000-4000-8000-000000000001', itemId: 'minecraft:oak_log', count: 2, x: -4.77, y: 91, z: 0.45 };
const record = { agentId: 'a', goalRevision: 1, currentGoal: 'gather 10 logs', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low' };
const view = (tick, extra = {}) => ({ ready: true, world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime: tick },
	observedAtEpochMs: 100000 + tick * 50, player: { x: 0, y: 90, z: 0, yaw: 90, pitch: 0, pose: 'standing' },
	blocks: [], landmarks: [], items: [], entities: [], ...extra });
const memoryView = (memory, observation, owner = record) => memory.recentlySeen(owner.agentId, observation, owner);

test('off-view logs and drops retain their own age and compact identities, without duplicating current sightings', () => {
	const memory = new ObservedMemoryStore();
	memory.ingest('a', view(100, { landmarks: [log], items: [drop] }), { snapshot: false });
	assert.equal(memoryView(memory, view(100, { landmarks: [log], items: [drop] })), null);
	memory.ingest('a', view(340), { snapshot: false });
	const seen = memoryView(memory, view(340));
	assert.equal(seen.status, undefined, 'each row says it is a sighting and how old');
	assert.deepEqual(seen.blocks, [{ blockId: log.blockId, x: -5, y: 94, z: 0, src: 'seen 12s' }]);
	assert.deepEqual(seen.items, [{ stableId: drop.stableId, itemId: drop.itemId, count: 2, x: -4.8, y: 91, z: 0.5, src: 'seen 12s' }]);
	memory.ingest('a', view(400, { landmarks: [{ ...log, blockId: 'minecraft:birch_log', x: -6 }] }), { snapshot: false });
	assert.equal(memoryView(memory, view(400)).blocks.find(row => row.x === -5).src, 'seen 15s');
});

test('block contradictions stay removed after cache eviction and persistence', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'seen-contradiction-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const memory = new ObservedMemoryStore({ directory });
	memory.ingest('a', view(100, { landmarks: [log] }), { snapshot: false });
	memory.ingest('a', view(101, { blocks: [{ ...log, blockId: 'minecraft:air' }] }), { snapshot: false });
	memory.ingest('a', view(102, { blocks: Array.from({ length: 1100 }, (_, x) => ({ blockId: 'minecraft:stone', x, y: 64, z: 12 })) }), { snapshot: false });
	assert.equal(memoryView(memory, view(103)), null);
	await memory.flush('a');
	const restored = new ObservedMemoryStore({ directory });
	await restored.load('a');
	assert.equal(memoryView(restored, view(103)), null);
});

test('drop updates replace count and position; explicit pickup and missing-target receipts invalidate the selected identity', () => {
	for (const reasonCode of ['ITEM_PICKED_UP', 'ITEM_NOT_FOUND', 'ITEM_UNAVAILABLE']) {
		const memory = new ObservedMemoryStore();
		memory.ingest('a', view(100, { items: [drop] }), { snapshot: false });
		memory.ingest('a', view(120, { items: [{ ...drop, count: 3, x: -4 }] }), { snapshot: false });
		assert.equal(memoryView(memory, view(140)).items[0].count, 3);
		memory.recordResourceResult('a', view(140), { actionType: 'pick_up_item', arguments: { targetSelector: drop.stableId }, state: reasonCode === 'ITEM_PICKED_UP' ? 'SUCCEEDED' : 'FAILED', reasonCode });
		assert.equal(memoryView(memory, view(140)), null);
		memory.ingest('a', view(141), { snapshot: false });
		assert.equal(memoryView(memory, view(141)), null);
	}
});

test('partial entity samples preserve absent drops even inside pickup reach', () => {
	const item = { ...drop, x: 0.5, y: 90, z: 1.5 };
	const player = { x: 0.5, y: 90, z: 0.5, yaw: 0, pitch: 0, pose: 'standing' };
	const coverage = { mode: 'sampled_visible', entitiesDistanceLimit: 128, sections: { entities: { returned: 0, complete: false } } };
	for (const extra of [{ player: { ...player, z: -1 } }, { entities: Array(64).fill({}) },
		{ continuity: { rememberedSections: ['items'] } }, { continuity: { rememberedSections: ['entities'] } },
		{ coverage: undefined }, { player: { ...player, pose: 'swimming' } }, {}]) {
		const memory = new ObservedMemoryStore();
		memory.ingest('a', view(100, { items: [item] }), { snapshot: false });
		memory.ingest('a', view(120, { player, coverage, ...extra }), { snapshot: false });
		assert.equal(memoryView(memory, view(140)).items[0].stableId, item.stableId);
	}
});

test('recorded partial wire samples do not prove removal from pickup proximity or inventory growth', () => {
	const { samples } = JSON.parse(readFileSync(new URL('./fixtures/seen-memory-wire.json', import.meta.url), 'utf8'));
	const memory = new ObservedMemoryStore();
	const [before, after] = samples.map(adaptObservation);
	assert.equal(before.items.length, 1);
	assert.equal(after.items.length, 0);
	assert.equal(after.inventory.items[0].count, 1);
	assert.ok(samples.every(row => row.blocks.every(block => block.blockId !== 'minecraft:air')));
	memory.ingest('a', before, { snapshot: false });
	assert.equal(memoryView(memory, { ...before, items: [], entities: [] }).items.length, 1);
	memory.ingest('a', after, { snapshot: false });
	assert.equal(memoryView(memory, after).items[0].stableId, before.items[0].stableId);
});

test('a fresh hit at the exact remembered cell contradicts its identity and survives persistence', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'seen-ray-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const memory = new ObservedMemoryStore({ directory });
	const block = { ...log, x: 0, y: 91, z: 2, bounds: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }], boundsTruncated: false };
	const player = { x: 0.5, y: 90, z: 0.5, yaw: 0, pitch: 0, pose: 'standing' };
	const after = view(120, { player, interaction: { rayTarget: { type: 'block', blockId: 'minecraft:stone', x: 0, y: 91, z: 2 } } });
	memory.ingest('a', view(100, { player, blocks: [block] }), { snapshot: false });
	await memory.flush('a');
	const restored = new ObservedMemoryStore({ directory });
	await restored.load('a');
	restored.ingest('a', after, { snapshot: false });
	assert.equal(memoryView(restored, after), null);
	await restored.flush('a');
	const reloaded = new ObservedMemoryStore({ directory });
	await reloaded.load('a');
	assert.equal(memoryView(reloaded, after), null);
});

test('bulk terrain gives one remembered location per block ID even when a different location is visible', () => {
	const memory = new ObservedMemoryStore();
	memory.ingest('a', view(100, { blocks: Array.from({ length: 20 }, (_, x) => ({ blockId: 'minecraft:stone', x, y: 80, z: 9 })) }), { snapshot: false });
	const owner = { ...record, currentGoal: 'mine 3 stone and craft a furnace' };
	assert.equal(memoryView(memory, view(120), owner).blocks.length, 1);
	const current = view(120, { blocks: [{ blockId: 'minecraft:stone', x: 30, y: 80, z: 9 }] });
	assert.equal(memoryView(memory, current, owner).blocks.length, 1);
});

test('moving and stationary drops keep their historical location when lost from a partial view', () => {
	for (const [velocity, count] of [[{ x: 0, y: 0.15, z: 0 }, 1], [{ x: 0, y: 0, z: 0 }, 1]]) {
		const memory = new ObservedMemoryStore();
		const before = view(100, { items: [drop], entities: [{ ...drop, type: 'minecraft:item', velocity }] });
		memory.ingest('a', before, { snapshot: false });
		const after = view(120, { coverage: { mode: 'sampled_visible', sections: { entities: { returned: 0, complete: false } } } });
		memory.ingest('a', after, { snapshot: false });
		assert.equal(memoryView(memory, after)?.items?.length ?? 0, count);
	}
});

test('uncertain crosshair rays and partial or unknown block shapes preserve sightings', () => {
	const cube = { ...log, x: 0, y: 91, z: 2, bounds: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }], boundsTruncated: false };
	const player = { x: 0.5, y: 90, z: 0.5, yaw: 0, pitch: 0, pose: 'standing' };
	const rayTarget = { type: 'block', blockId: 'minecraft:stone', x: 0, y: 91, z: 4 };
	for (const [block, extra] of [[cube, { interaction: { rayTarget: { type: 'miss' } } }],
		[cube, { interaction: { rayTarget: { ...rayTarget, z: 1 } } }], [cube, { player: { ...player, yaw: 180 } }],
		[cube, { player: { ...player, x: 0 } }], [cube, { continuity: { rememberedSections: ['interaction'] } }],
		[{ ...cube, bounds: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }] }, {}],
		[{ ...cube, bounds: undefined }, {}], [cube, { blocks: [cube] }]]) {
		const memory = new ObservedMemoryStore();
		memory.ingest('a', view(100, { player, blocks: [block] }), { snapshot: false });
		const after = view(120, { player, interaction: { rayTarget }, ...extra });
		memory.ingest('a', after, { snapshot: false });
		assert.equal(memory.query('a', { blockId: log.blockId }).blocks.length, 1);
	}
});

test('drop coordinates are rounded for presentation while receipts keep the exact selector', () => {
	const memory = new ObservedMemoryStore();
	const item = { ...drop, x: -4.283651806069192, y: 91.68747045359376, z: 3.375064598991853 };
	memory.ingest('a', view(100, { items: [item] }), { snapshot: false });
	const row = memoryView(memory, view(120)).items[0];
	assert.deepEqual(row, { stableId: drop.stableId, itemId: drop.itemId, count: 2, x: -4.3, y: 91.7, z: 3.4, src: 'seen 1s' });
	assert.ok(Buffer.byteLength(JSON.stringify(row)) < 135);
	memory.recordResourceResult('a', view(120), { actionType: 'pick_up_item', arguments: { targetSelector: row.stableId }, state: 'SUCCEEDED', reasonCode: 'ITEM_PICKED_UP' });
	assert.equal(memoryView(memory, view(120)), null);
});

test('recency, world and dimension, relevance, capacity and byte limits keep wake memory bounded', () => {
	const memory = new ObservedMemoryStore();
	memory.ingest('a', view(100, { landmarks: Array.from({ length: 50 }, (_, x) => ({ ...log, x })), items: [drop] }), { snapshot: false });
	const seen = memoryView(memory, view(120));
	assert.ok(seen.blocks.length + (seen.items?.length ?? 0) <= 6);
	assert.ok(Buffer.byteLength(JSON.stringify(seen)) <= 600);
	assert.equal(memoryView(memory, view(2601)), null);
	assert.equal(memoryView(memory, view(120, { world: { worldId: 'other', dimension: 'minecraft:overworld', gameTime: 120 } })), null);
	assert.equal(memoryView(memory, view(120, { world: { worldId: 'w', dimension: 'minecraft:the_nether', gameTime: 120 } })), null);
	assert.equal(memoryView(memory, view(120), { ...record, currentGoal: 'gather diamonds' }), null);
	assert.equal(memoryView(memory, view(90)), null, 'older render cannot reveal future sightings');
	assert.equal(memoryView(memory, view(120), { ...record, agentId: 'other' }), null);
	memory.ingest('a', view(20), { snapshot: false });
	assert.equal(memoryView(memory, view(21)), null, 'tick rollback resets this scope');
});

test('runtime memory reaches the real event builder and is omitted when empty', async () => {
	const runtime = new NativeToolRuntime({ bridge: { send: async () => {} } });
	await runtime.initializeMemory('a');
	runtime.updateObservation(record, view(100, { landmarks: [log], items: [drop] }), { eventSequence: 1 });
	runtime.updateObservation(record, view(340), { eventSequence: 2 });
	const observation = runtime.decorateObservation(record, view(340));
	for (const event of ['observation', 'program_planning_due']) {
		const input = buildNativeEventInput(record, { event, observation });
		const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
		assert.equal(payload.observation.recentlySeen.items[0].count, 2);
		assert.equal(payload.observation.recentlySeen.blocks[0].src, 'seen 12s');
		const empty = buildNativeEventInput(record, { event, observation: view(340) });
		assert.doesNotMatch(empty, /recentlySeen/);
	}
	await runtime.dispose('a', 'shutdown');
});

test('explicit block samples override conflicting landmark summaries and broken-block receipts invalidate memory', () => {
	const memory = new ObservedMemoryStore();
	memory.ingest('a', view(100, { landmarks: [log] }), { snapshot: false });
	memory.ingest('a', view(120, { blocks: [{ ...log, blockId: 'minecraft:air' }], landmarks: [log] }), { snapshot: false });
	assert.equal(memoryView(memory, view(140)), null);
	memory.ingest('a', view(150, { landmarks: [log] }), { snapshot: false });
	memory.recordResourceResult('a', view(150), { actionType: 'break_block', arguments: { x: log.x, y: log.y, z: log.z }, state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' });
	assert.equal(memoryView(memory, view(160)), null);
});

test('remembered sections do not refresh sightings, and unrelated predicates do not infer resource plans', () => {
	const memory = new ObservedMemoryStore();
	memory.ingest('a', view(100, { landmarks: [log], items: [drop] }), { snapshot: false });
	memory.ingest('a', view(300, { landmarks: [log], items: [drop], continuity: { rememberedSections: ['landmarks', 'items'] } }), { snapshot: false });
	assert.equal(memoryView(memory, view(320)).items[0].src, 'seen 11s');
	assert.equal(memoryView(memory, view(320)).blocks[0].src, 'seen 11s');
	assert.equal(memoryView(memory, view(320), { ...record, currentGoal: 'beat the game' }), null);
	assert.equal(memoryView(memory, view(320), { ...record, currentGoal: 'get it', currentGoalSpec: { predicate: { type: 'inventory_contains', itemId: log.blockId, count: 10 } } }).blocks[0].blockId, log.blockId);
});

test('wall-clock age catches paused ticks and volatile drops do not survive unobserved restarts', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'seen-restart-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const memory = new ObservedMemoryStore({ directory });
	memory.ingest('a', view(100, { items: [drop] }), { snapshot: false });
	assert.equal(memoryView(memory, view(100, { observedAtEpochMs: 226000 })), null);
	await memory.flush('a');
	const restored = new ObservedMemoryStore({ directory });
	await restored.load('a');
	assert.equal(memoryView(restored, view(110)), null);
});

test('runtime receipt invalidation reaches the next wake without another observation', async () => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (...args) => sent.push(args) }, requestObservation: async () => { throw new Error('offline'); } });
	await runtime.initializeMemory('a');
	runtime.updateObservation(record, view(100, { items: [drop] }), { eventSequence: 1 });
	runtime.updateObservation(record, view(120), { eventSequence: 2 });
	const pending = runtime.execute({ agentId: 'a', goalRevision: 1, turnId: 'pickup', callId: 'pickup',
		tool: { kind: 'action', actionType: 'pick_up_item', arguments: { targetSelector: drop.stableId } } }, record);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(runtime.onActionResult(record, { actionId: sent[0][2].actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'ITEM_PICKED_UP' }), true);
	assert.equal(runtime.decorateObservation(record, view(140)).recentlySeen, undefined);
	assert.equal((await pending).state, 'SUCCEEDED');
	await runtime.dispose('a', 'shutdown');
});

test('explicit vocabulary from active authored plan steps selects remembered resources under a broad goal', async () => {
	const { LiveTaskViews } = await import('../src/live-task-view.mjs');
	const iron = { blockId: 'minecraft:iron_ore', x: 6, y: 60, z: 2, tags: ['#minecraft:iron_ores'] };
	const broad = { ...record, currentGoal: 'Beat Minecraft' };
	const memory = new ObservedMemoryStore();
	memory.ingest('a', view(100, { landmarks: [log, iron] }), { snapshot: false });
	const ids = (seen) => (seen?.blocks ?? []).map(row => row.blockId).sort();
	// Baseline: a resource-free final goal selects neither sighting.
	assert.equal(memory.recentlySeen('a', view(340), broad), null);
	assert.deepEqual(ids(memory.recentlySeen('a', view(340), broad, { ids: [], text: 'Get iron' })), ['minecraft:iron_ore']);
	assert.deepEqual(ids(memory.recentlySeen('a', view(340), broad, { ids: ['#minecraft:logs'], text: 'Stock up' })), ['minecraft:oak_log']);
	assert.deepEqual(ids(memory.recentlySeen('a', view(340), broad, { ids: ['minecraft:iron_ore'], text: 'x' })), ['minecraft:iron_ore']);
	// Exact ids only: an ingot step does not infer its ore.
	assert.equal(memory.recentlySeen('a', view(340), broad, { ids: ['minecraft:iron_ingot'], text: 'Smelt' }), null);
	// Wrong world, stale rows and contradicted cells stay out.
	assert.equal(memory.recentlySeen('a', view(340, { world: { worldId: 'other', dimension: 'minecraft:overworld', gameTime: 340 } }), broad, { ids: [], text: 'Get iron' }), null);
	assert.equal(memory.recentlySeen('a', view(3000), broad, { ids: [], text: 'Get iron' }), null);
	memory.ingest('a', view(350, { blocks: [{ ...iron, blockId: 'minecraft:air' }] }), { snapshot: false });
	assert.equal(memory.recentlySeen('a', view(360), broad, { ids: [], text: 'Get iron' }), null);

	// End to end: the runtime asks the live plan for its active steps on every decorated view.
	const views = new LiveTaskViews();
	const runtime = new NativeToolRuntime({ bridge: { send: async () => {} }, requestObservation: async () => { throw new Error('offline'); },
		planVocabulary: (owner, worldId) => views.activeResourceVocabulary(owner, worldId) });
	await runtime.initializeMemory('a');
	const live = (tick, extra = {}) => ({ ...view(tick, extra), inventory: { items: [] } });
	await views.observe(broad, live(100));
	runtime.updateObservation(broad, live(100, { landmarks: [log, iron] }), { eventSequence: 1 });
	const evidence = { itemIds: ['minecraft:raw_iron'], count: 3, dimension: null, x: null, y: null, z: null, blockId: null };
	const step = (status) => ({ steps: [{ id: 'iron', label: 'Get iron', kind: 'inventory', status, dependsOn: [], detail: '', evidence, check: null }] });
	assert.equal(runtime.decorateObservation(broad, live(340)).recentlySeen, undefined);
	await views.operate(broad, { operation: 'replace', plan: step('pending') });
	assert.equal(runtime.decorateObservation(broad, live(340)).recentlySeen, undefined, 'pending steps are not the current work');
	await views.operate(broad, { operation: 'replace', plan: step('active') });
	assert.deepEqual(ids(runtime.decorateObservation(broad, live(340)).recentlySeen), ['minecraft:iron_ore']);
	assert.equal(runtime.decorateObservation({ ...broad, goalRevision: 2 }, live(340)).recentlySeen, undefined, 'a new goal revision retires the vocabulary');
	await views.operate(broad, { operation: 'replace', plan: { steps: [{ id: 'portal', label: 'Light the portal', kind: 'milestone', status: 'active', dependsOn: [], detail: '', evidence: null, check: null }] } });
	assert.equal(runtime.decorateObservation(broad, live(340)).recentlySeen, undefined, 'an obsolete step contributes nothing');
	await runtime.dispose('a', 'shutdown');
});
