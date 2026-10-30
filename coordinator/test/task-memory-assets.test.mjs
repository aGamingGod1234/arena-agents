import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskMemoryStore } from '../src/task-memory-store.mjs';
import { RuntimeMemoryContext } from '../src/runtime-memory-context.mjs';
import { AtomicAgentStore } from '../src/observed-memory-store.mjs';

const scope = { agentId: 'sol', goalRevision: 1, worldId: 'world', dimension: 'minecraft:overworld' };
const record = { agentId: scope.agentId, goalRevision: 1 };
const table = 'minecraft:crafting_table', furnace = 'minecraft:furnace';
const p = (x = 0, y = 64, z = 0) => ({ x, y, z });
const sight = (tick, blocks = [], items = []) => ({ ready: true, world: { worldId: scope.worldId, dimension: scope.dimension, gameTime: tick },
 observedAtEpochMs: tick * 50, player: p(), blocks, inventory: { items } });
const receipt = (type, id, position, tick, actionId = `a-${tick}`) => ({ actionId, actionType: type,
 arguments: { ...position, ...(type === 'place_block' ? { itemId: id, face: 'up' } : { expectedBlockId: id, timeoutMs: 15000 }) },
 state: 'SUCCEEDED', reasonCode: type === 'place_block' ? 'BLOCK_PLACED' : 'BLOCK_BROKEN', actionObservation: { worldTick: tick, observedAtEpochMs: tick * 50 } });
const assets = async store => (await store.query(scope, { kind: 'assets' })).entries;

test('own station removal, inventory pickup and placement give distinct factual states', async () => {
 const store = new TaskMemoryStore();
 await store.observe(scope, sight(1, [{ ...p(2), blockId: table }]));
 await store.recordReceipt(scope, receipt('break_block', table, p(2), 2));
 assert.equal((await assets(store))[0].state, 'destroyed', 'breaking does not prove collection');
 await store.observe(scope, sight(3, [], [{ itemId: table, count: 1 }]));
 assert.equal((await store.summary(scope)).assets[0].state, 'carried');
 await store.recordReceipt(scope, receipt('place_block', table, p(5), 4));
 await store.observe(scope, sight(5));
 const known = await assets(store);
 assert.equal(known.find(a => a.position?.x === 5).state, 'placed');
 assert.equal(known.filter(a => a.state === 'carried').length, 0);
 const placed = (await store.summary(scope)).assets[0];
 assert.deepEqual(placed, { blockId: table, state: 'placed', position: p(5), distance: 5, dy: 0, src: 'did 1s' });
 await store.flush();
});

test('fresh sight or exact ray hit can contradict a station; absence, old, remembered and sound rows cannot', async () => {
 const store = new TaskMemoryStore();
 await store.recordReceipt(scope, receipt('place_block', furnace, p(1), 20));
 for (const observation of [sight(30), sight(10, [{ ...p(1), blockId: 'minecraft:air' }]),
  { ...sight(30, [{ ...p(1), blockId: 'minecraft:air' }]), continuity: { rememberedSections: ['blocks'] } },
  sight(30, [{ ...p(1), blockId: 'minecraft:air', visible: false }]),
  sight(30, [{ ...p(1), blockId: 'minecraft:air', perceivedBy: 'sound' }]),
  sight(30, [{ ...p(1), blockId: 'minecraft:air', stale: true }])]) {
  await store.observe(scope, observation);
  assert.equal((await assets(store))[0].state, 'placed');
 }
 await store.observe(scope, { ...sight(31), interaction: { rayTarget: { type: 'block', ...p(1), blockId: 'minecraft:air' } } });
 assert.equal((await assets(store))[0].state, 'missing');
 await store.observe(scope, sight(32, [{ ...p(1), blockId: table }]));
 assert.equal((await assets(store))[0].blockId, table);
 assert.equal((await assets(store))[0].state, 'placed');
 await store.flush();
});

test('old and replayed receipts cannot undo newer direct evidence or claim another agent station', async () => {
 const store = new TaskMemoryStore();
 const broken = receipt('break_block', furnace, p(1), 20);
 await store.recordReceipt(scope, broken);
 await store.observe(scope, sight(21, [{ ...p(1), blockId: furnace }]));
 await store.recordReceipt(scope, broken);
 await store.recordReceipt({ ...scope, agentId: 'other' }, receipt('break_block', furnace, p(1), 22));
 assert.equal((await assets(store))[0].state, 'placed');
 assert.equal((await store.query({ ...scope, worldId: 'other' }, { kind: 'assets' })).total, 0);
 assert.equal((await store.query({ ...scope, dimension: 'minecraft:the_nether' }, { kind: 'assets' })).total, 0);
 for (const state of ['FAILED', 'CANCELLED', 'TIMED_OUT']) await store.recordReceipt(scope, { ...broken, state });
 await store.recordReceipt(scope, { ...broken, reasonCode: 'TARGET_ALREADY_SATISFIED' });
 assert.equal((await assets(store))[0].state, 'placed');
 await store.flush();
});

test('fresh carried counts retain their own verification age across partial and remembered inventory', async () => {
 const store = new TaskMemoryStore();
 await store.observe(scope, sight(20, [], [{ itemId: table, count: 1 }, { itemId: table, count: 2 }]));
 await store.observe(scope, { ...sight(60), continuity: { rememberedSections: ['inventory'] } });
 assert.deepEqual((await store.summary(scope)).assets[0], { blockId: table, state: 'carried', count: 3, src: 'seen 2s' });
 await store.observe(scope, sight(10));
 assert.equal((await store.summary(scope)).assets[0].count, 3);
 await store.observe(scope, sight(61));
 assert.deepEqual((await store.summary(scope)).assets, []);
 await store.flush();
 const unknownAge = new TaskMemoryStore();
 await unknownAge.observe(scope, { ready: true, position: p(), inventory: { items: [{ itemId: table, count: 1 }] } });
 for (const tick of [70, 80]) await unknownAge.observe(scope, { ...sight(tick), inventory: {} });
 assert.equal((await unknownAge.summary(scope)).assets[0].src, 'seen', 'partial samples cannot invent inventory verification time');
 await unknownAge.flush();
});

test('summary favors carried, nearby and level stations then latest verification; keeps authored base', async () => {
 const store = new TaskMemoryStore();
 const base = { kind: 'place', key: 'home', label: 'My base', position: p(100), summary: 'My named base stays here.' };
 await store.remember(scope, base);
 for (const [x, y, tick] of [[4, 64, 10], [-4, 64, 30], [0, 70, 40], [100, 64, 50], [200, 64, 60], [300, 64, 70], [400, 64, 80]])
  await store.observe(scope, sight(tick, [{ ...p(x, y), blockId: table }]));
 await store.observe(scope, sight(100, [], [{ itemId: furnace, count: 1 }]));
 const summary = await store.summary(scope);
 assert.deepEqual(summary.assets.slice(0, 4).map(a => a.state === 'carried' ? a.state : a.position.x), ['carried', -4, 4, 0]);
 assert.equal(summary.assets.length, 6);
 assert.equal(summary.assets[3].dy, 6);
 assert.equal(summary.places[0].label, base.label);
 assert.equal((await store.query(scope, { kind: 'place' })).entries[0].summary, base.summary);
 assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 6000);
 await store.flush();
});

test('runtime correlates receipt arguments and dispatch dimension, refreshes wakes and reloads durable assets', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'my-stuff-receipt-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const store = new TaskMemoryStore({ directory }), memory = new RuntimeMemoryContext({ taskMemory: store });
 memory.observe(record, sight(1));
 const placed = receipt('place_block', table, p(1), 2);
 await memory.recordDispatch(record, { ...placed, goalRevision: 1 });
 assert.equal(await memory.recordResult(record, { ...placed, arguments: { ...p(999), itemId: furnace } }), true);
 assert.equal(memory.peekTaskContext(record).assets[0].position.x, 1, 'terminal arguments cannot replace durable dispatch');
 assert.equal((await new TaskMemoryStore({ directory }).summary(scope)).assets[0].state, 'placed');
 const broken = receipt('break_block', table, p(1), 3);
 await memory.recordDispatch(record, { ...broken, goalRevision: 1 });
 memory.observe(record, { ...sight(4), world: { worldId: scope.worldId, dimension: 'minecraft:the_nether', gameTime: 4 } });
 await memory.recordResult(record, broken);
 assert.deepEqual((await memory.taskContext(record)).assets, [], 'old-dimension receipt cannot leak into this wake');
 assert.equal((await new TaskMemoryStore({ directory }).summary(scope)).assets[0].state, 'destroyed');
 await memory.flush();
});

test('station receipt persistence failure remains retryable after the notebook accepted the result', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'my-stuff-retry-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const store = new TaskMemoryStore({ directory }), memory = new RuntimeMemoryContext({ taskMemory: store });
 memory.observe(record, sight(1)); await memory.flush();
 const placed = receipt('place_block', table, p(1), 2);
 await memory.recordDispatch(record, { ...placed, goalRevision: 1 });
 const write = AtomicAgentStore.prototype.write; let fail = true;
 t.mock.method(AtomicAgentStore.prototype, 'write', function (...args) {
  return fail ? Promise.reject(new Error('asset disk unavailable')) : write.apply(this, args);
 });
 await assert.rejects(memory.recordResult(record, placed), /TASK_MEMORY_WRITE_FAILED/);
 fail = false;
 await memory.recordResult(record, placed);
 assert.equal((await new TaskMemoryStore({ directory }).summary(scope)).assets[0].state, 'placed');
 await memory.flush();
});

test('retry after a failed asset write persists newer sighting rather than replaying old destruction', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'my-stuff-newer-retry-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const store = new TaskMemoryStore({ directory });
 const write = AtomicAgentStore.prototype.write; let fail = true;
 t.mock.method(AtomicAgentStore.prototype, 'write', function (...args) {
  return fail ? Promise.reject(new Error('asset disk unavailable')) : write.apply(this, args);
 });
 const broken = receipt('break_block', table, p(1), 2);
 await assert.rejects(store.recordReceipt(scope, broken), /TASK_MEMORY_WRITE_FAILED/);
 await store.observe(scope, sight(3, [{ ...p(1), blockId: table }]));
 fail = false;
 await store.recordReceipt(scope, broken);
 await store.flush();
 assert.equal((await new TaskMemoryStore({ directory }).summary(scope)).assets[0].state, 'placed');
});

test('replay the live starter, forest and underground station sequence without abandoned workstation ghosts', async () => {
 const { actions, verification } = JSON.parse(await readFile(new URL('./fixtures/station-memory-replay.json', import.meta.url), 'utf8'));
 const memory = new RuntimeMemoryContext();
 // This reduced fixture keeps only station dispatches, verified results and their original journal line numbers.
 memory.observe(record, sight(1));
 for (const [line, type, x, y, z, id, tick, at] of actions) {
  const result = receipt(type, id, p(x, y, z), tick, `journal-${line}`);
  result.actionObservation = { ...(tick === null ? {} : { worldTick: tick }), observedAtEpochMs: at };
  await memory.recordDispatch(record, { ...result, goalRevision: 1 });
  await memory.recordResult(record, result);
  if (type === 'place_block') {
   memory.observe(record, { ...sight(tick ?? 1, [{ ...p(x, y, z), blockId: id }]), observedAtEpochMs: at + 1 });
   await memory.taskContext(record);
  }
 }
 memory.observe(record, { ...verification, world: { ...verification.world, worldId: scope.worldId } });
 const context = await memory.taskContext(record);
 assert.equal(context.assets.filter(a => a.state === 'placed' || a.availability === 'last_observed').length, 1);
 assert.deepEqual(context.assets.find(a => a.state === 'placed').position, p(134, 68, 486));
 assert.equal(context.assets.filter(a => a.state === 'carried').length, 2);
 const all = await memory.execute(record, { operation: 'task', arguments: { operation: 'query', query: { kind: 'assets' } } });
 assert.equal(all.entries.filter(a => a.state === 'destroyed').length, 5);
 await memory.flush();
});
