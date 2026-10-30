import test from 'node:test';
import assert from 'node:assert/strict';
import { howtoChain, howtoHoldings } from '../src/howto.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
const observation = (items, minute = 0, blocks = []) => ({ ready: true, observedAtEpochMs: minute * 60_000, player: { dead: false }, world: { worldId: 'r2', dimension: 'minecraft:overworld' }, inventory: { items: items.map(([id, count = 1, slot]) => ({ itemId: `minecraft:${id}`, count, slot })) }, blocks });
const chain = (needs, items, blocks = []) => howtoChain(needs, howtoHoldings({ observation: observation(items, 0, blocks) }), { visited: ['minecraft:overworld'] }).key;
const need = (id, count) => [{ id, count }];
const record = { agentId: 'r2', currentGoal: 'Progress', goalRevision: 1 };
function plan(check) {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [{ id: 'need', label: 'need', check, kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null }] });
 return views;
}
test('R2.1 supplied ingredients create no acquisition gates', () => {
 const iron = chain(need('iron_ingot', 7), [['raw_iron', 7], ['coal'], ['furnace'], ['wooden_pickaxe']]);
 assert.match(iron, /smelt ready/); assert.doesNotMatch(iron, /stone_pickaxe|mine iron/);
 const eyes = chain(need('ender_eye', 12), [['ender_pearl', 12], ['blaze_rod', 6]]);
 assert.doesNotMatch(eyes, /nether|obsidian|flint|stone_pickaxe/);
 assert.match(eyes, /blaze_powder.*craft ready/);
 for (const needs of [[{ id: 'oak_planks', count: 4 }, { id: '#planks', count: 2 }], [{ id: '#planks', count: 2 }, { id: 'oak_planks', count: 4 }]]) assert.equal(chain(needs, [['oak_planks', 4], ['spruce_planks', 2]]), '');
});
test('R2.2 station alternatives retain quantities and partial progress resets the clock', async () => {
 const views = plan('has:minecraft:cooked_beef*5');
 await views.observe(record, observation([['beef'], ['coal'], ['furnace']]));
 const before = (await views.operate(record, { operation: 'read' })).prerequisites.chain.join(' ');
 assert.match(before, /beef 1\/5/); assert.match(before, /smoker/); assert.match(before, /campfire/);
 await views.observe(record, observation([['beef', 2], ['coal'], ['furnace']], 5));
 assert.match(views.progress(record), /beef 2\/5/); assert.doesNotMatch(views.progress(record), /unchanged/);
 const distinct = chain(need('stick', 12), [['oak_planks'], ['bamboo', 2]]);
 assert.match(distinct, /#planks 1\/6/); assert.match(distinct, /bamboo 2\/24/);
});
test('R2.3 held or visible blast furnace remains a usable station alternative', () => {
 for (const [items, blocks] of [[ [['blast_furnace']], [] ], [[], [{ blockId: 'minecraft:blast_furnace', distance: 2 }]]]) {
  const text = chain(need('iron_ingot', 7), [['raw_iron', 7], ['coal'], ...items], blocks);
  assert.match(text, /@blast_furnace\((held|visible)\) smelt ready/);
  assert.doesNotMatch(text, /@blast_furnace missing/);
 }
});
test('R2.4 carried acceptable armor needs wearing, not more materials', async () => {
 for (const armor of ['iron_boots', 'diamond_boots']) {
  const views = plan('worn:iron+1'); await views.observe(record, observation([[armor]]));
  assert.match(views.progress(record), /carried, not worn/);
  assert.doesNotMatch(views.progress(record), /iron_ingot|raw_iron|stone_pickaxe/);
  assert.match((await views.operate(record, { operation: 'read' })).prerequisites.chain.join(' '), /carried, not worn/);
 }
 const views = plan('worn:iron+2'); await views.observe(record, observation([['iron_boots', 2]]));
 const text = (await views.operate(record, { operation: 'read' })).prerequisites.chain.join(' ');
 assert.match(text, /crafting option: iron_ingot 0\/5/);
 const shared = plan('tool:pickaxe:iron+ & worn:iron+1'); await shared.observe(record, observation([]));
 assert.match(shared.progress(record), /crafting option: iron_pickaxe/);
});
test('R2.5 recipe inputs cannot also be fuel or shared readiness supply', () => {
 const text = chain(need('charcoal', 1), [['oak_log'], ['furnace']]);
 assert.match(text, /fuel none after inputs/); assert.doesNotMatch(text, /smelt ready/);
 assert.match(chain(need('charcoal', 1), [['oak_log'], ['coal'], ['furnace']]), /smelt ready/);
 const shared = chain([{ id: 'iron_sword', count: 1 }, { id: 'iron_pickaxe', count: 1 }], [['iron_ingot', 3], ['stick', 3], ['crafting_table']]);
 assert.doesNotMatch(shared, /craft ready/); assert.match(shared, /iron_ingot 3\/5/);
 const meals = chain([{ id: 'cooked_beef', count: 5 }, { id: 'cooked_porkchop', count: 5 }], [['beef', 5], ['porkchop', 5], ['coal'], ['furnace']]);
 assert.doesNotMatch(meals, /smelt ready/); assert.match(meals, /fuel 80%/);
});
test('R2.6 either held portal ignition item satisfies entry ignition', () => {
 for (const item of ['fire_charge', 'flint_and_steel']) {
  const text = chain(need('ender_eye', 12), [['obsidian', 10], [item]]);
  assert.doesNotMatch(text, /entry:|flint_and_steel 0|iron_ingot|stone_pickaxe/);
 }
 assert.match(chain(need('ender_eye', 12), [['obsidian', 10]]), /flint_and_steel\|fire_charge 0\/1/);
});
