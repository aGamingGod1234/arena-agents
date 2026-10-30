import assert from 'node:assert/strict';
import test from 'node:test';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { ModelObservationViews, decodeModelFacts, presentInventoryTagCounts } from '../src/model-fact-encoding.mjs';
import { minecraftCapabilities } from '../src/native-minecraft-tools.mjs';

const payload = result => decodeModelFacts(JSON.parse(result.response.contentItems[0].text));
test('tag totals are derivable only from the exact retained rows, without changing runtime food/tool facts', () => {
 const items = [
  { itemId: 'minecraft:chicken', count: 3, tags: ['#c:foods', '#c:foods/food_poisoning'] },
  { itemId: 'custom:fruit', count: 2, tags: ['#c:foods', '#custom:unfamiliar'] },
  { itemId: 'minecraft:iron_pickaxe', count: 1, tags: ['#c:enchantables', '#minecraft:enchantable/mining'] },
 ];
 const tagCounts = { '#c:foods': 5, '#c:foods/food_poisoning': 3, '#custom:unfamiliar': 2, '#c:enchantables': 1, '#minecraft:enchantable/mining': 1 };
 const observation = { inventory: { items, tagCounts }, player: { health: 8 } };
 const before = structuredClone(observation);
 const result = presentInventoryTagCounts(observation);
 assert.match(result.inventory.tagCounts, /sum items/);
 assert.deepEqual(result.inventory.items, items);
 assert.deepEqual(observation, before);
 for (const inventory of [
  { items: items.slice(1), tagCounts },
  { items: items.map(({ tags, ...row }) => row), tagCounts },
  { items, tagCounts: { ...tagCounts, '#unseen:food': 3 } },
 ]) {
  const incomplete = { inventory };
  assert.equal(presentInventoryTagCounts(incomplete), incomplete, 'missing or truncated rows must keep aggregate facts');
 }
});

for (const section of ['all', 'program', 'control', 'strategy']) {
 test(`${section} reference reuse requires delivery, retains live metadata, and resets with the provider context`, () => {
  const views = new ModelObservationViews();
  const tool = { kind: 'capabilities', section };
  const staticValue = minecraftCapabilities({ section });
  const first = presentNativeToolResult({ ...staticValue, executionSettings: { speed: 1 } }, tool, views);
  const full = payload(first);
  assert.ok(full.referenceId);
  assert.deepEqual(payload(presentNativeToolResult(staticValue, tool, views)).referenceId, full.referenceId, 'undelivered replies must be restated');
  first.commit();
  const repeat = payload(presentNativeToolResult({ ...staticValue, executionSettings: { speed: 2 }, taskMemory: { revision: 3 } }, tool, views));
  assert.equal(repeat.sameAsReference, full.referenceId);
  assert.deepEqual(repeat.executionSettings, { speed: 2 });
  assert.deepEqual(repeat.taskMemory, { revision: 3 });
  assert.ok(JSON.stringify(repeat).length < JSON.stringify(full).length / 2);
  views.reset();
  first.commit(); // A late completion from the retired context cannot prime the new one.
  assert.equal(payload(presentNativeToolResult(staticValue, tool, views)).sameAsReference, undefined);
 });
}

test('changed documentation and holdings-sensitive how-to are always delivered', () => {
 const views = new ModelObservationViews();
 const tool = { kind: 'capabilities', section: 'program' };
 const original = minecraftCapabilities({ section: 'program' });
 const first = presentNativeToolResult(original, tool, views);
 first.commit();
 const changed = payload(presentNativeToolResult({ ...original, reference: `${original.reference}\nChanged contract.` }, tool, views));
 assert.equal(changed.sameAsReference, undefined);
 assert.match(changed.reference, /Changed contract/);
 const howto = { version: 1, reference: 'current holdings '.repeat(100) };
 const liveTool = { kind: 'capabilities', section: 'howto', topic: 'iron' };
 presentNativeToolResult(howto, liveTool, views).commit();
 assert.equal(payload(presentNativeToolResult(howto, liveTool, views)).reference, howto.reference);
});
