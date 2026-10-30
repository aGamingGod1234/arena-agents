import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { RuntimeMemoryContext } from '../src/runtime-memory-context.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';

const record = { agentId: 'placement-test', currentGoal: 'Build tools', goalRevision: 1 };
const step = (id, check, dependsOn = [], kind = 'inventory', evidence = null) => ({ id, label: id, detail: '', status: 'pending', check, dependsOn, kind, evidence });
const observation = (items = [], extra = {}) => ({ ready: true, observedAtEpochMs: 1000, player: { dead: false, x: 10, y: 64, z: 7 }, world: { worldId: 'placement-world', dimension: 'minecraft:overworld' }, inventory: { items: items.map(([itemId, count]) => ({ itemId: `minecraft:${itemId}`, count })) }, blocks: [], ...extra });
const placed = (item = 'crafting_table', at = 1100, actionId = 'placed-1', x = 7) => ({ worldId: 'placement-world', dimension: 'minecraft:overworld', goalRevision: 1, actionId, actionType: 'place_block', arguments: { x, y: 64, z: 7, itemId: `minecraft:${item}`, face: 'up' }, state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', observedAtEpochMs: at });
const dead = { ready: false, player: { dead: true } };
const status = (view, id) => view.snapshot(record).plan.steps.find(s => s.id === id).status;
async function make(steps, options = {}, o = observation()) {
 const view = new LiveTaskViews({ now: () => 2100, ...options });
 view.suggest(record.agentId, record.currentGoal, { steps }); await view.observe(record, o); return view;
}

test('PLACED1 own successful table placement stays complete with age and distance through death', async () => {
 const view = await make([step('table', 'has:minecraft:crafting_table*1'), step('pick', 'tool:pickaxe:wooden+', ['table']), step('stone', 'has:minecraft:cobblestone*8', ['pick'])], {}, observation([['crafting_table', 1]]));
 await view.actionReceipt(record, placed()); await view.observe(record, observation([], { observedAtEpochMs: 1200 }));
 assert.equal(status(view, 'table'), 'complete');
 assert.match(view.progress(record), /table\[placed crafting_table at 7,64,7, 1s ago, 3m\]/);
 await view.observe(record, dead); await view.observe(record, observation([], { observedAtEpochMs: 2000 }));
 assert.equal(status(view, 'table'), 'complete'); assert.match(view.progress(record), /open pick/);
});

test('PLACED2 placed furnace proves the item and exact world step, surviving restart and death', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'plan-placement-')); t.after(() => rm(directory, { recursive: true, force: true }));
 const evidence = { itemIds: [], count: 1, dimension: 'minecraft:overworld', x: 7, y: 64, z: 7, blockId: 'minecraft:furnace' };
 let view = await make([step('furnace_item', 'has:minecraft:furnace*1'), step('furnace', null, ['furnace_item'], 'world', evidence), step('smelt', null, ['furnace'], 'manual')], { directory }, observation([['furnace', 1]]));
 await view.actionReceipt(record, placed('furnace')); await view.observe(record, observation([], { observedAtEpochMs: 1200 }));
 assert.equal(status(view, 'furnace_item'), 'complete'); assert.equal(status(view, 'furnace'), 'complete');
 await view.observe(record, dead); await view.flush();
 view = new LiveTaskViews({ directory, now: () => 2100 }); await view.observe(record, observation([], { observedAtEpochMs: 2000 }));
 assert.equal(status(view, 'furnace'), 'complete'); assert.match(view.progress(record), /open smelt/);
 await view.observe(record, dead); assert.equal(status(view, 'furnace_item'), 'complete');
 await view.flush();
});

test('only fresh direct exact-cell contradictions or own successful breaks withdraw placement credit', async () => {
 for (const ownBreak of [false, true]) {
  const view = await make([step('table', 'has:minecraft:crafting_table*1')]); await view.actionReceipt(record, placed());
  for (const extra of [
   { blocks: [] },
   { blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:air', visible: false }] },
   { blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:air', perceivedBy: 'sound' }] },
   { interaction: { rayTarget: { type: 'miss', x: 20, y: 64, z: 7, blockId: 'minecraft:air' } } },
   { interaction: { rayTarget: { type: 'block', x: 20, y: 64, z: 7, blockId: 'minecraft:stone' } } },
   { continuity: { rememberedSections: ['interaction'] }, interaction: { rayTarget: { type: 'block', x: 7, y: 64, z: 7, blockId: 'minecraft:air' } } },
   { continuity: { rememberedSections: ['blocks'] }, blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:air' }] },
   { observedAtEpochMs: 1000, blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:air' }] },
   { ready: false, blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:air' }] },
   { world: { worldId: 'placement-world', dimension: 'minecraft:the_nether' }, blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:air' }] },
  ]) { await view.observe(record, observation([], { observedAtEpochMs: 1500, ...extra })); assert.equal(status(view, 'table'), 'complete'); }
  if (ownBreak) await view.actionReceipt(record, { ...placed(), actionType: 'break_block', state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', observedAtEpochMs: 1800 });
  else await view.observe(record, observation([], { observedAtEpochMs: 1800, interaction: { rayTarget: { type: 'block', x: 7, y: 64, z: 7, blockId: 'minecraft:air' } } }));
  assert.equal(status(view, 'table'), 'lost'); assert.match(view.progress(record), /open table/);
  await view.actionReceipt(record, placed()); assert.equal(status(view, 'table'), 'lost', 'terminal replay cannot restore withdrawn credit');
  await view.observe(record, dead); await view.observe(record, observation([], { observedAtEpochMs: 2000 })); assert.equal(status(view, 'table'), 'lost');
 }
});

test('a seen table, failed placement, already-present target, wrong world or stale goal earns no own-placement credit', async () => {
 for (const receipt of [{ ...placed(), state: 'FAILED' }, { ...placed(), reasonCode: 'TARGET_ALREADY_SATISFIED' }, { ...placed(), worldId: 'another-world' }, { ...placed(), goalRevision: 2 }]) {
  const view = await make([step('table', 'has:minecraft:crafting_table*1')]); await view.actionReceipt(record, receipt);
  await view.observe(record, observation([], { observedAtEpochMs: 1500, blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:crafting_table' }] }));
  assert.notEqual(status(view, 'table'), 'complete');
 }
});

test('placement counts respect quantity, multiple positions, alternatives and Boolean checks', async () => {
 const view = await make([step('two', 'has:minecraft:crafting_table*2'), step('and', 'has:minecraft:crafting_table*1 & has:minecraft:oak_log*4')]);
 await view.actionReceipt(record, placed()); await view.actionReceipt(record, placed());
 await view.observe(record, observation([], { observedAtEpochMs: 1500 })); assert.notEqual(status(view, 'two'), 'complete'); assert.notEqual(status(view, 'and'), 'complete');
 await view.actionReceipt(record, placed('crafting_table', 1600, 'placed-2', 8)); await view.observe(record, observation([], { observedAtEpochMs: 1800 }));
 assert.equal(status(view, 'two'), 'complete'); assert.notEqual(status(view, 'and'), 'complete');
});

test('correlated runtime receipts credit placements only after matching dispatch storage', async () => {
 const view = await make([step('table', 'has:minecraft:crafting_table*1')]);
 const memory = new RuntimeMemoryContext({ onReceipt: (identity, receipt) => view.actionReceipt({ ...record, ...identity }, receipt) });
 memory.observe(record, observation());
 const receipt = placed();
 assert.equal(await memory.recordResult(record, receipt), false); assert.notEqual(status(view, 'table'), 'complete');
 await memory.recordDispatch(record, receipt); assert.equal(await memory.recordResult(record, receipt), true);
 await view.observe(record, observation([], { observedAtEpochMs: 1500 })); assert.equal(status(view, 'table'), 'complete');
});

test('restart drops life-bound presence proof without forgetting placement or historical visits', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'plan-presence-')); t.after(() => rm(directory, { recursive: true, force: true }));
 const view = await make([step('eyes', 'has:minecraft:ender_eye*12'), step('ow', 'visited:minecraft:overworld', ['eyes'], 'world')], { directory }, observation([['ender_eye', 12]])); await view.flush();
 const restored = new LiveTaskViews({ directory }); await restored.observe(record, observation());
 assert.doesNotMatch(restored.progress(record), /skipped eyes/); assert.equal(status(restored, 'ow'), 'pending');
 await restored.flush();
});

test('__proto__ IDs have no inherited skipped fact', async () => {
 const view = await make([step('__proto__', null, [], 'manual')]); assert.equal(view.progress(record), 'open __proto__[unverified:__proto__]');
});

test('loss-at-death counts only factual completed possession losses and survives restart', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'plan-death-loss-')); t.after(() => rm(directory, { recursive: true, force: true }));
 let view = await make([step('pick', 'tool:pickaxe:wooden+')], { directory }, observation([['wooden_pickaxe', 1]]));
 await view.observe(record, dead); await view.observe(record, dead); await view.observe(record, observation());
 assert.match(view.progress(record), /lost at death ×1/);
 await view.observe(record, observation([['wooden_pickaxe', 1]])); await view.observe(record, dead); await view.flush();
 view = new LiveTaskViews({ directory }); await view.observe(record, observation()); assert.match(view.progress(record), /lost at death ×2/);
 await view.flush();
});

test('a stale held-item snapshot cannot count the placed item twice', async () => {
 const view = await make([step('tables', 'has:minecraft:crafting_table*2')], {}, observation([['crafting_table', 1]]));
 await view.actionReceipt(record, placed()); assert.notEqual(status(view, 'tables'), 'complete');
 await view.observe(record, observation([['crafting_table', 1]], { observedAtEpochMs: 1500 })); assert.equal(status(view, 'tables'), 'complete');
 await view.observe(record, dead); assert.equal(status(view, 'tables'), 'lost', 'one placed table cannot replace the second table lost at death');
});

test('placed count also credits exact item-evidence steps and preserves other-dimension memory honestly', async () => {
 const evidence = { itemIds: ['minecraft:crafting_table'], count: 1, dimension: null, x: null, y: null, z: null, blockId: null };
 const view = await make([step('table', null, [], 'inventory', evidence)]); await view.actionReceipt(record, placed());
 await view.observe(record, dead); assert.equal(status(view, 'table'), 'complete');
 await view.observe(record, observation([], { observedAtEpochMs: 1500, world: { worldId: 'placement-world', dimension: 'minecraft:the_nether' } }));
 assert.equal(status(view, 'table'), 'complete'); assert.match(view.progress(record), /ago, overworld/);
});

test('withdrawal never reuses a pre-placement held snapshot or keeps unknown credit green', async () => {
 for (const unready of [false, true]) {
  const view = await make([step('table', 'has:minecraft:crafting_table*1')], {}, observation([['crafting_table', 1]]));
  await view.actionReceipt(record, placed());
  if (unready) await view.observe(record, { ready: false, player: { dead: false } });
  await view.actionReceipt(record, { ...placed(), actionId: 'break-1', actionType: 'break_block', reasonCode: 'BLOCK_BROKEN', observedAtEpochMs: 1800 });
  assert.equal(status(view, 'table'), 'lost');
 }
});

test('remembered inventory never supplies the second held item beside a placed item', async () => {
 const view = await make([step('tables', 'has:minecraft:crafting_table*2')], {}, observation([['crafting_table', 1]]));
 await view.actionReceipt(record, placed());
 await view.observe(record, observation([['crafting_table', 1]], { observedAtEpochMs: 1500, continuity: { rememberedSections: ['inventory'] } }));
 assert.notEqual(status(view, 'tables'), 'complete');
});

test('remembered inventory does not withdraw exact item-evidence completion', async () => {
 const evidence = { itemIds: ['minecraft:crafting_table'], count: 1, dimension: null, x: null, y: null, z: null, blockId: null };
 const view = await make([step('table', null, [], 'inventory', evidence)], {}, observation([['crafting_table', 1]]));
 assert.equal(status(view, 'table'), 'complete');
 await view.observe(record, observation([], { observedAtEpochMs: 1500, continuity: { rememberedSections: ['inventory'] } }));
 assert.equal(status(view, 'table'), 'complete', 'a reused survey is not evidence of item loss');
 await view.observe(record, observation([], { observedAtEpochMs: 1600 })); assert.equal(status(view, 'table'), 'lost');
});

test('direct position-shaped landmark and container rows contradict only their own exact cell', async () => {
 for (const section of ['landmarks', 'nearbyContainers', 'blocks']) {
  const view = await make([step('table', 'has:minecraft:crafting_table*1')]); await view.actionReceipt(record, placed());
  const row = { position: { x: 7, y: 64, z: 7 }, blockId: 'minecraft:air' };
  await view.observe(record, observation([], { observedAtEpochMs: 1500, [section]: [row], continuity: { rememberedSections: [section] } })); assert.equal(status(view, 'table'), 'complete');
  await view.observe(record, observation([], { observedAtEpochMs: 1600, [section]: [row] })); assert.equal(status(view, 'table'), 'lost');
 }
});

test('withdrawn exact world credit cannot return from remembered or pre-break block rows', async () => {
 const evidence = { itemIds: [], count: 1, dimension: 'minecraft:overworld', x: 7, y: 64, z: 7, blockId: 'minecraft:crafting_table' };
 const blocks = [{ x: 7, y: 64, z: 7, blockId: 'minecraft:crafting_table' }];
 for (const ownBreak of [false, true]) {
  const view = await make([step('station', null, [], 'world', evidence)]); await view.actionReceipt(record, placed());
  await view.observe(record, observation([], { observedAtEpochMs: 1200, blocks }));
  if (ownBreak) await view.actionReceipt(record, { ...placed(), actionId: 'break', actionType: 'break_block', reasonCode: 'BLOCK_BROKEN', observedAtEpochMs: 1500 });
  else await view.observe(record, observation([], { observedAtEpochMs: 1500, blocks, continuity: { rememberedSections: ['blocks'] }, interaction: { rayTarget: { type: 'block', x: 7, y: 64, z: 7, blockId: 'minecraft:air' } } }));
  assert.equal(status(view, 'station'), 'lost'); assert.match(view.progress(record), /open station/);
  await view.observe(record, observation([], { observedAtEpochMs: 1800, blocks })); assert.equal(status(view, 'station'), 'complete', 'a genuinely later direct sighting may prove the exact world predicate again');
  if (ownBreak) await view.actionReceipt(record, { ...placed(), actionId: 'second-break', actionType: 'break_block', reasonCode: 'BLOCK_BROKEN', observedAtEpochMs: 1900 });
  else await view.observe(record, observation([], { observedAtEpochMs: 1900, interaction: { rayTarget: { type: 'block', x: 7, y: 64, z: 7, blockId: 'minecraft:air' } } }));
  assert.equal(status(view, 'station'), 'lost', 'a later contradiction must withdraw re-sighted world evidence too');
 }
});

test('compact placement text reports the nearest own station without choosing a body action', async () => {
 const view = await make([step('table', 'has:minecraft:crafting_table*1')]); await view.actionReceipt(record, placed()); await view.actionReceipt(record, placed('crafting_table', 1200, 'second', 100));
 await view.observe(record, observation([], { observedAtEpochMs: 1500 })); assert.match(view.progress(record), /at 7,64,7, 1s ago, 3m/);
 await view.observe(record, observation([], { observedAtEpochMs: 1600, player: { dead: false, x: 103, y: 64, z: 7 } })); assert.match(view.progress(record), /at 100,64,7, 0s ago, 3m/);
});

test('the coordinator adapter path retains source visibility and continuity for plan evidence', async () => {
 const wire = { ready: true, observedAtEpochMs: 1500, position: { x: 10, y: 64, z: 7 }, view: { yaw: 0, pitch: 0 }, player: {}, world: { worldId: 'placement-world', dimension: 'minecraft:overworld', gameTime: 100, dayTime: 100, raining: false, thundering: false }, inventory: { items: [] }, entities: [], blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:air', perceivedBy: 'sound' }] };
 const view = await make([step('table', 'has:minecraft:crafting_table*1')]); await view.actionReceipt(record, placed());
 await view.observe(record, adaptObservation(wire), wire); assert.equal(status(view, 'table'), 'complete');
 delete wire.blocks[0].perceivedBy; wire.continuity = { rememberedSections: ['blocks'] };
 await view.observe(record, adaptObservation(wire), wire); assert.equal(status(view, 'table'), 'complete');
 delete wire.continuity; wire.observedAtEpochMs = 1800;
 await view.observe(record, adaptObservation(wire), wire); assert.equal(status(view, 'table'), 'lost');
});

test('building receipts keep an earlier table and only plan-relevant material cells', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'plan-building-'));
 const evidence = { itemIds: [], count: 1, dimension: 'minecraft:overworld', x: 500, y: 64, z: 7, blockId: 'minecraft:cobblestone' };
 const view = await make([step('table', 'has:minecraft:crafting_table*1'), step('wall', null, [], 'world', evidence)], { directory });
 t.after(async () => { await view.flush(); await rm(directory, { recursive: true, force: true }); });
 await view.actionReceipt(record, placed());
 for (let i = 0; i < 1000; i++) await view.actionReceipt(record, placed('cobblestone', 1200 + i, `build-${i}`, 100 + i));
 await view.observe(record, observation([], { observedAtEpochMs: 3000 }));
 assert.equal(status(view, 'table'), 'complete'); assert.equal(status(view, 'wall'), 'complete');
 await view.flush();
 const saved = JSON.parse(await readFile(join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))), 'utf8'));
 assert.equal(saved.known.placements.length, 2);
 const file = join(directory, (await readdir(directory)).find(name => name.endsWith('.json')));
 saved.known.placements.push(...Array.from({ length: 2000 }, (_, i) => ({ ...saved.known.placements[1], x: 1000 + i, placedAt: 4000 + i, actionId: `old-building-${i}` })));
 await writeFile(file, JSON.stringify(saved));
 const restored = new LiveTaskViews({ directory }); await restored.observe(record, observation([], { observedAtEpochMs: 7000 })); await restored.flush();
 assert.equal(status(restored, 'table'), 'complete'); assert.equal(status(restored, 'wall'), 'complete');
 assert.equal(JSON.parse(await readFile(file, 'utf8')).known.placements.length, 2);
});

test('placement history is capped oldest-first on receipt and legacy restart', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'plan-cap-'));
 const view = await make([step('table', 'has:minecraft:crafting_table*1')], { directory });
 t.after(async () => { await view.flush(); await rm(directory, { recursive: true, force: true }); });
 for (let i = 0; i < 1100; i++) await view.actionReceipt(record, placed('crafting_table', 1200 + i, `station-${i}`, i));
 await view.flush();
 const file = join(directory, (await readdir(directory)).find(name => name.endsWith('.json')));
 const saved = JSON.parse(await readFile(file, 'utf8'));
 assert.equal(saved.known.placements.length, 1024);
 assert.equal(saved.known.placements[0].actionId, 'station-76');
 saved.known.placements = Array.from({ length: 2000 }, (_, i) => ({ ...saved.known.placements[0], x: i, placedAt: 1200 + i, actionId: `legacy-${i}`, ignored: 'x'.repeat(1000) }));
 await writeFile(file, JSON.stringify(saved));
 const restored = new LiveTaskViews({ directory });
 await restored.observe(record, observation([], { observedAtEpochMs: 4000 })); await restored.flush();
 const bounded = JSON.parse(await readFile(file, 'utf8'));
 assert.equal(bounded.known.placements.length, 1024);
 assert.equal(bounded.known.placements[0].actionId, 'legacy-976');
 assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 200_000);
 assert.equal(status(restored, 'table'), 'complete');
});

test('a direct re-sighting takes precedence over conflicting ray evidence like seen-memory', async () => {
 const view = await make([step('table', 'has:minecraft:crafting_table*1')]); await view.actionReceipt(record, placed());
 await view.observe(record, observation([], { observedAtEpochMs: 1500,
  blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:crafting_table' }],
  interaction: { rayTarget: { type: 'block', x: 7, y: 64, z: 7, blockId: 'minecraft:air' } } }));
 assert.equal(status(view, 'table'), 'complete');
});

test('anvil wear keeps functional credit but a different block still withdraws it', async () => {
 const view = await make([step('anvil', 'has:minecraft:anvil*1')]); await view.actionReceipt(record, placed('anvil'));
 for (const blockId of ['minecraft:chipped_anvil', 'minecraft:damaged_anvil']) {
  await view.observe(record, observation([], { observedAtEpochMs: 1500, blocks: [{ x: 7, y: 64, z: 7, blockId }] }));
  assert.equal(status(view, 'anvil'), 'complete');
 }
 await view.observe(record, observation([], { observedAtEpochMs: 1600, interaction: { rayTarget: { type: 'block', x: 7, y: 64, z: 7, blockId: 'minecraft:chipped_anvil' } } }));
 assert.equal(status(view, 'anvil'), 'complete');
 await view.observe(record, observation([], { observedAtEpochMs: 1700, blocks: [{ x: 7, y: 64, z: 7, blockId: 'minecraft:air' }] }));
 assert.equal(status(view, 'anvil'), 'lost');
});
