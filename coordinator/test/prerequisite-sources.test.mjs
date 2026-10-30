import test from 'node:test';
import assert from 'node:assert/strict';
import { howto, howtoHoldings, howtoIndex, howtoSources } from '../src/howto.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';

const holding = (items = []) => howtoHoldings({ observation: { ready: true, position: { x: 0, y: 64, z: 0 }, world: { dimension: 'minecraft:overworld' }, inventory: { items: items.map(([id, count = 1]) => ({ itemId: `minecraft:${id}`, count })) } } });
const overworld = ['minecraft:overworld'];

test('affordable crafts remain visible beside a compound need with bucket alternatives', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('gear', 'tool:pickaxe:iron+ & has:minecraft:bucket|minecraft:water_bucket|minecraft:lava_bucket*1')] });
 await views.observe(record, sample(0, [['stone_pickaxe'], ['iron_ingot', 3], ['stick', 2], ['crafting_table']]));
 let header = views.continuity(record);
 assert.match(header.craft, /options share materials/);
 assert.match(header.craft, /iron_pickaxe \(3 iron_ingot \+ 2 stick|iron_pickaxe \(2 stick \+ 3 iron_ingot/);
 assert.match(header.craft, /bucket \(3 iron_ingot; crafting_table held\/seen, placement\/reach unverified\)/);
 assert.match(header.plan, /unmet:/, 'one affordable recipe does not complete either or both requirements');
 assert.ok(Buffer.byteLength(header.craft) <= 360);
 await views.observe(record, sample(1, [['iron_pickaxe'], ['iron_ingot', 3]]));
 header = views.continuity(record);
 assert.doesNotMatch(header.craft, /iron_pickaxe/);
 assert.match(header.craft, /bucket \(3 iron_ingot; crafting_table missing\)/);
 await views.observe(record, sample(2, [['iron_pickaxe'], ['water_bucket'], ['iron_ingot', 3]]));
 assert.equal(views.continuity(record).craft, undefined, 'filled bucket already satisfies the alternative');
});

test('affordable craft facts use fresh direct ingredients and never promise a whole requested batch', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('gear', 'has:minecraft:bucket*8')] });
 for (const items of [[['raw_iron', 3]], [['iron_ingot', 2]]]) {
  await views.observe(record, sample(0, items));
  assert.equal(views.continuity(record).craft, undefined);
 }
 const o = sample(1, [['iron_ingot', 3]]);
 await views.observe(record, o);
 assert.match(views.continuity(record).craft, /^one craft each from held inputs/);
 assert.match(views.continuity(record).plan, /0\/8/);
 await views.observe(record, { ...sample(2, [['iron_ingot', 3]]), continuity: { rememberedSections: ['inventory'] } });
 assert.equal(views.continuity(record).craft, undefined);
});

test('the index records where mobs spawn from biome spawners and structure spawn overrides', () => {
	const spawns = howtoIndex().mobSpawns;
	assert.deepEqual(spawns.blaze, ['the_nether fortress']);
	assert.deepEqual(spawns.enderman, ['overworld', 'the_end', 'the_nether']);
	assert.deepEqual(spawns.wither_skeleton, ['the_nether fortress']);
	assert.match(howto('blaze_rod', holding()).tree[0], /kill blaze\(player kill\+chance\) in the_nether fortress$/);
});

test('gated sources name the hidden tool tier, ore depth and dimension behind a requirement', () => {
	const stone = holding([['stone_pickaxe'], ['stick', 4]]);
	assert.deepEqual(howtoSources(['minecraft:iron_pickaxe'], stone, { visited: overworld }), ['iron_ore stone_pickaxe+ held y-24..56~16,80..319~232']);
	assert.deepEqual(howtoSources(['minecraft:iron_pickaxe'], holding([['wooden_pickaxe']]), { visited: overworld }), ['iron_ore needs stone_pickaxe+ y-24..56~16,80..319~232']);
	assert.deepEqual(howtoSources(['minecraft:diamond_pickaxe'], stone, { visited: overworld }), ['diamond_ore needs iron_pickaxe+ y-64..16~-64']);
	assert.deepEqual(howtoSources(['minecraft:obsidian'], stone), ['obsidian needs diamond_pickaxe+', 'obsidian cast: water onto a lava source (strategy:portals)'], 'block-use sources the registries lack are named as mechanics');
	assert.equal(howto('lava_bucket', stone).blockUse, 'fill: empty bucket on a lava source');
	assert.deepEqual(howtoSources(['minecraft:ender_eye'], stone, { visited: overworld }), ['kill blaze in the_nether(unvisited) fortress', 'nether portal: obsidian x10 + flint_and_steel|fire_charge'], 'pearls also spawn here, so only the blaze is gated; the unvisited Nether adds its entry');
	assert.deepEqual(howtoSources(['minecraft:ender_eye'], stone, { visited: [...overworld, 'minecraft:the_nether'] }), ['kill blaze in the_nether fortress']);
});

test('a requirement reachable with what is held reports no gate', () => {
	for (const id of ['wooden_pickaxe', 'crafting_table', 'cooked_beef', 'torch', 'ender_pearl']) assert.deepEqual(howtoSources([`minecraft:${id}`], holding()), [], id);
	assert.deepEqual(howtoSources(['minecraft:stone_pickaxe'], holding([['wooden_pickaxe']])), []);
	assert.deepEqual(howtoSources(['minecraft:iron_pickaxe'], holding([['stone_pickaxe'], ['raw_iron', 3], ['stick', 2], ['coal', 3]])), [], 'held raw iron only needs smelting');
	assert.deepEqual(howtoSources(['minecraft:stone_pickaxe'], holding(), { visited: overworld }), ['deepslate|stone needs wooden_pickaxe+', 'blackstone needs wooden_pickaxe+ the_nether(unvisited)', 'nether portal: obsidian x10 + flint_and_steel|fire_charge'], 'sources behind one gate share an entry; unvisited dimensions sort last');
});

const record = { agentId: 'a1', currentGoal: 'Beat the game', goalRevision: 1 };
const step = (id, check) => ({ id, label: id, kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check });
const sample = (at, items) => ({ ready: true, observedAtEpochMs: at, player: { dead: false }, world: { worldId: 'w', dimension: 'minecraft:overworld' }, inventory: { items: items.map(([id, count = 1]) => ({ itemId: `minecraft:${id}`, count })) } });

test('a non-expandable sibling keeps the known prerequisite chain visible', async () => {
 const views = new LiveTaskViews();
 await views.observe(record, sample(0, [['stone_pickaxe'], ['iron_ingot', 3], ['oak_planks', 2]]));
 for (const check of [
  'tool:pickaxe:iron+ & has:minecraft:bucket|minecraft:water_bucket|minecraft:lava_bucket*1',
  'tool:pickaxe:iron+ & visited:minecraft:the_nether',
 ]) {
  await views.operate(record, { operation: 'replace', plan: { steps: [step('gear', check)] } });
  await views.observe(record, sample(1, [['stone_pickaxe'], ['iron_ingot', 3], ['oak_planks', 2]]));
  const header = views.continuity(record);
  assert.match(header.plan, /iron_pickaxe 0\/1.*stick 0\/2/);
  assert.match(header.plan, /@inventory<-inputs held/);
  assert.doesNotMatch(header.plan, /raw_iron 0\/3/, 'held ingots need no extra ore');
 }
 // An OR check does not turn its independent alternatives into simultaneous requirements.
 await views.operate(record, { operation: 'replace', plan: { steps: [step('either', 'tool:pickaxe:iron+ | has:minecraft:bucket*1')] } });
 assert.equal((await views.operate(record, { operation: 'read' })).prerequisites, undefined);
});

test('the first unfinished step states how long it and its recipe chain have been unchanged', async () => {
	let now = 0;
	const views = new LiveTaskViews({ now: () => now });
	views.suggest(record.agentId, record.currentGoal, { steps: [step('iron', 'has:minecraft:iron_ingot*3'), step('food', 'has:minecraft:cooked_beef*5')] });
	await views.observe(record, sample(0, [['stone_pickaxe']]));
	assert.doesNotMatch(views.progress(record), /unchanged/);
	await views.observe(record, sample(5 * 60_000, [['stone_pickaxe'], ['dirt', 4]]));
	assert.match(views.progress(record), /^open iron\[howto:iron_ingot 0\/3; unchanged 5m, 0 blocks broken; /, 'dirt is not on the iron chain');
	assert.doesNotMatch(views.progress(record), /food\[[^\]]*unchanged/, 'only the first unfinished step carries the clock');
	await views.observe(record, sample(6 * 60_000, [['stone_pickaxe'], ['raw_iron', 2]]));
	assert.doesNotMatch(views.progress(record), /unchanged/, 'mined raw iron is progress toward ingots');
	await views.observe(record, sample(9 * 60_000, [['stone_pickaxe'], ['raw_iron', 2]]));
	assert.match(views.progress(record), /unchanged 3m/);
});

test('strategy topic follows the unmet requirement instead of labels and other open steps', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [
  { ...step('prepare', 'has:minecraft:iron_ingot*3 & has:minecraft:ender_eye*12'), label: 'Prepare for the End' },
  { ...step('later', 'has:minecraft:diamond*3'), label: 'Mine diamonds' },
 ] });
 await views.observe(record, sample(0, [['ender_eye', 12]]));
 assert.match(views.progress(record), /strategy:sourcing/);
 await views.observe(record, sample(1, [['iron_ingot', 3]]));
 assert.match(views.progress(record), /strategy:nether(?:;|$)/, 'eyes are gated only by Nether blazes, so the Nether topic, not the End');
 assert.doesNotMatch(views.progress(record), /strategy:(?:resources|sourcing)/);
 await views.observe(record, sample(2, [['iron_ingot', 3], ['blaze_powder', 12]]));
 assert.match(views.progress(record), /strategy:end(?:;|$)/, 'with powder held, pearls are reachable here and the eye name decides');
});

for (const tier of ['wooden', 'stone', 'iron']) test(`a missing ${tier} tool selects its mechanics even in another dimension`, async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('prepare', `tool:pickaxe:${tier}+`)] });
 const observation = sample(0, []);
 observation.world.dimension = 'minecraft:the_nether';
 await views.observe(record, observation);
 assert.match(views.progress(record), /strategy:tools/);
});

test('plan reads return the whole chain the wake line abbreviates', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('iron', 'has:minecraft:iron_ingot*3')] });
 await views.observe(record, sample(0, [['wooden_pickaxe']]));
 const result = await views.operate(record, { operation: 'read' });
 assert.deepEqual(result.prerequisites, { step: 'iron', chain: ['@furnace missing fuel 33%<-raw_iron 0/3 mine iron_ore needs stone_pickaxe+ y-24..56~16,80..319~232', 'stone_pickaxe 0/1 @crafting_table missing<-(#stone_tool_materials 0/3 + stick 0/2 (@inventory<-#planks 0/2 or @inventory<-bamboo 0/4 mine bamboo))'] });
 assert.ok(views.progress(record).includes(result.prerequisites.chain[0]));
});

// Review r1 finding 1: the wake itself carries the chain from the open step down to what can be done now.
test('the open step line carries its prerequisite chain down to sources and gates', async () => {
	const views = new LiveTaskViews();
	views.suggest(record.agentId, record.currentGoal, { steps: [step('eyes', 'has:minecraft:ender_eye*12')] });
	await views.observe(record, sample(0, [['stone_pickaxe'], ['stick', 4]]));
	const line = views.progress(record);
	assert.match(line, /^open eyes\[howto:ender_eye 0\/12; <-ender_pearl 0\/12 kill enderman overworld \+ blaze_powder 0\/12<-blaze_rod 0\/6 kill blaze the_nether\(unvisited\) fortress, nether entry: obsidian 0\/10 needs diamond_pickaxe\+/);
	assert.ok(Buffer.byteLength(line.slice(line.indexOf('; <-'), line.indexOf(']'))) <= 362, 'the chain keeps its own budget');
	const other = { ...record, agentId: 'a2', currentGoal: 'Beat the dragon again' };
	views.suggest(other.agentId, other.currentGoal, { steps: [step('pick', 'tool:pickaxe:iron+')] });
	await views.observe(other, sample(0, [['wooden_pickaxe']]));
	assert.match(views.progress(other), /raw_iron 0\/3 mine iron_ore needs stone_pickaxe\+ y-24\.\.56~16/);
	assert.match((await views.operate(other, { operation: 'read' })).prerequisites.chain.join(', '), /stone_pickaxe 0\/1/, 'the full chain retains the missing mining tool and its inputs');
	await views.observe(other, sample(1, [['stone_pickaxe'], ['iron_ingot', 3], ['stick', 2]]));
	assert.doesNotMatch(views.progress(other), /<-/, 'nothing left to gather leaves no chain');
});

// Review r1 finding 2: partial ingredients count against the whole checked quantity.
test('chain quantities net held partial ingredients against the whole requirement', async () => {
	const views = new LiveTaskViews();
	views.suggest(record.agentId, record.currentGoal, { steps: [step('eyes', 'has:minecraft:ender_eye*12')] });
	await views.observe(record, sample(0, [['stone_pickaxe'], ['ender_pearl', 1], ['blaze_powder', 1]]));
	assert.match(views.progress(record), /ender_pearl 1\/12 kill enderman overworld \+ blaze_powder 1\/12<-blaze_rod 0\/6 kill blaze/, 'one pearl and one powder leave eleven of each, six rods');
	assert.match(views.progress(record), /strategy:nether/);
	const iron = { ...record, agentId: 'a3', currentGoal: 'Iron' };
	views.suggest(iron.agentId, iron.currentGoal, { steps: [step('iron', 'has:minecraft:iron_ingot*7')] });
	await views.observe(iron, sample(0, [['stone_pickaxe'], ['raw_iron', 1]]));
	assert.match(views.progress(iron), /<-raw_iron 1\/7 mine iron_ore/, 'one raw iron does not satisfy seven ingots');
	const index = (await import('../src/howto.mjs')).howtoChain([{ id: 'minecraft:iron_pickaxe', count: 1 }, { id: 'minecraft:iron_ingot', count: 24 }], holding([['stone_pickaxe'], ['stick', 2]]));
	assert.match(index.key, /iron_ingot 0\/27/, 'shared ingredients are counted once across needs');
});

// Review r1 finding 3: progress anywhere on the chain resets the unchanged clock.
test('the unchanged clock counts partial ingredients, mining tools, stations and fuel as progress', async () => {
	let now = 0;
	const views = new LiveTaskViews({ now: () => now });
	views.suggest(record.agentId, record.currentGoal, { steps: [step('iron', 'has:minecraft:iron_ingot*7')] });
	await views.observe(record, sample(0, [['wooden_pickaxe'], ['raw_iron', 1]]));
	await views.observe(record, sample(5 * 60_000, [['stone_pickaxe'], ['raw_iron', 2], ['coal', 3], ['furnace', 1]]));
	assert.doesNotMatch(views.progress(record), /unchanged/, 'the review case: more raw iron, a stone pickaxe, coal and a furnace');
	for (const [at, items, why] of [[6, [['stone_pickaxe'], ['raw_iron', 2], ['coal', 3]], 'furnace placed or dropped'], [7, [['stone_pickaxe'], ['raw_iron', 2]], 'fuel spent']]) {
		await views.observe(record, sample(at * 60_000, items));
		assert.doesNotMatch(views.progress(record), /unchanged/, why);
	}
	await views.observe(record, sample(10 * 60_000, [['stone_pickaxe'], ['raw_iron', 2], ['dirt', 9]]));
	assert.match(views.progress(record), /unchanged 3m/, 'items off the chain are not progress');
});

test('full game: checked Nether access keeps portal sources instead of inventing a diamond prerequisite', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('nether', 'visited:minecraft:the_nether')] });
 await views.observe(record, sample(0, [['iron_pickaxe'], ['bucket']]));
 assert.match(views.continuity(record).options, /step nether: Nether access; casting needs no diamond pick/);
 assert.match(views.continuity(record).options, /obsidian:.*water.*lava source/);
 assert.doesNotMatch(views.continuity(record).options, /diamond: seen/);
 // An unrelated checked world outcome does not invent a new tool tier either.
 await views.operate(record, { operation: 'replace', plan: { steps: [step('dragon', 'killed:minecraft:ender_dragon')] } });
 assert.equal(views.continuity(record).options, undefined);
});

test('full game: Nether access names deep lava, the dig cost, aquifer water, and flint until a light is held', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('nether', 'visited:minecraft:the_nether')] });
 const surface = sample(0, [['iron_pickaxe'], ['bucket']]);
 surface.player = { ...surface.player, x: 0.5, y: 70, z: 0.5 };
 await views.observe(record, surface);
 let options = views.continuity(record).options;
 assert.match(options, /obsidian: est\. minutes to 10 more frame obsidian from here \(no water bucket held; casting needs one, any water fills a bucket\), cheapest first: dig to the y-55 lava floors ~40 \(125-level dig_to descent 8 in a few calls, then a search: 6 recorded descents, 2 saw a 64-source pool within 4 min, 4 climbed back after 1-16 min without one; 10 casts 13\); search caves and surface above y-20 ~1780/);
 assert.match(options, /6 recorded descents, 2 saw a 64-source pool within 4 min/);
 assert.match(options, /flint: .*gravel.*flint and steel = flint \+ iron ingot/, 'no light held: flint is named beside obsidian');
 const lit = sample(1, [['iron_pickaxe'], ['water_bucket'], ['flint_and_steel']]);
 lit.player = { ...lit.player, x: 0.5, y: 70, z: 0.5 };
 await views.observe(record, lit);
 options = views.continuity(record).options;
 assert.match(options, /obsidian: est\. minutes to 10 more frame obsidian from here, cheapest first/, 'the held water bucket casts');
 assert.doesNotMatch(options, /flint:/, 'a held flint and steel lights the frame');
 // Without a known position the vanilla ways stay.
 await views.observe(record, sample(2, [['iron_pickaxe'], ['bucket']]));
 assert.match(views.continuity(record).options, /obsidian: seen none remembered; ways \(typical\): water on a lava source makes 1 obsidian in place \(frame 10\); lava lies in caves/);
});

test('full game: Nether access states the Nether facts once a portal is at hand, until food, armour and gold are carried', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('nether', 'visited:minecraft:the_nether')] });
 await views.observe(record, sample(0, [['iron_pickaxe'], ['water_bucket'], ['flint_and_steel'], ['wheat', 9], ['cooked_beef', 3]]));
 let options = views.continuity(record).options;
 assert.match(options, /obsidian:/);
 assert.doesNotMatch(options, /Nether facts/, 'while still searching for lava the facts line is not shown');
 const framed = sample(0.5, [['iron_pickaxe'], ['water_bucket'], ['flint_and_steel'], ['cooked_beef', 3], ['obsidian', 4]]);
 framed.sighted = { portalFrames: [{ axis: 'x', interior: [2, 3], obsidian: 6, needed: 10, missing: [], blocked: [], lit: false }] };
 await views.observe(record, framed);
 assert.match(views.continuity(record).options, /Nether facts: /, 'held plus framed obsidian completes a portal');
 await views.observe(record, sample(0.7, [['iron_pickaxe'], ['water_bucket'], ['flint_and_steel'], ['wheat', 9], ['cooked_beef', 3], ['obsidian', 10]]));
 options = views.continuity(record).options;
 assert.match(options, /Nether facts: no food there early except hoglins in crimson forests; each armour point cuts most damage 4%; a death there drops everything carried and respawns at the Overworld spawn/);
 assert.doesNotMatch(options, /carried \d|\d\/4 worn/, 'no kit counts that read as a checklist');
 assert.match(options, /option golden helmet, before entering or soon after: 5 gold ingots, 2 armour like an iron helmet .*brutes ignore it; gold: Overworld gold ore \(iron pickaxe.*Nether gold ore \(any pickaxe; 2-6 nuggets each, 9 nuggets = 1 ingot/, 'the gold helmet is a priced option with its sources');
 const armoured = sample(1, [['iron_pickaxe'], ['water_bucket'], ['flint_and_steel'], ['cooked_beef', 3], ['obsidian', 10]]);
 armoured.inventory.items.push({ itemId: 'minecraft:iron_chestplate', count: 1, slot: 'chest' });
 armoured.player.armor = 6;
 await views.observe(record, armoured);
 assert.match(views.continuity(record).options, /Nether facts: /, 'armour alone does not end the facts line');
 armoured.observedAtEpochMs = 2;
 armoured.inventory.items.push({ itemId: 'minecraft:bread', count: 5 });
 await views.observe(record, armoured);
 assert.match(views.continuity(record).options, /piglins attack a player wearing no gold armour piece \| option golden helmet/, 'no gold worn: the piglin rule and the helmet option stay');
 armoured.observedAtEpochMs = 2.5;
 armoured.inventory.items.push({ itemId: 'minecraft:gold_ingot', count: 3 }, { itemId: 'minecraft:gold_nugget', count: 20 });
 await views.observe(record, armoured);
 assert.match(views.continuity(record).options, /5 gold ingots \(5 held: craft it at a crafting table, then equip it\)/, 'held ingots and nuggets count toward the helmet');
 armoured.observedAtEpochMs = 3;
 armoured.inventory.items.push({ itemId: 'minecraft:golden_boots', count: 1, slot: 'feet' });
 await views.observe(record, armoured);
 assert.doesNotMatch(views.continuity(record).options, /Nether facts/, '8 food, some armour and a gold piece: nothing to add');
});

test('full game: the staircase cost to the lava floors counts from where the agent stands', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('nether', 'visited:minecraft:the_nether')] });
 const deep = sample(0, [['iron_pickaxe'], ['water_bucket'], ['flint_and_steel']]);
 deep.player = { ...deep.player, x: 10.5, y: 16, z: 3.5 };
 await views.observe(record, deep);
 assert.match(views.continuity(record).options, /cheapest first: dig to the y-55 lava floors ~34 \(71-level dig_to shaft 2 in a few calls, then a search: 6 recorded descents, 2 saw a 64-source pool within 4 min, 4 climbed back after 1-16 min without one; 10 casts 13\)/);
 const floor = sample(1, [['iron_pickaxe'], ['water_bucket'], ['flint_and_steel']]);
 floor.player = { ...floor.player, x: 10.5, y: -54, z: 3.5 };
 await views.observe(record, floor);
 assert.match(views.continuity(record).options, /cheapest first: lava-floor depth here ~32/);
});

test('full game: a manual preparation step first still points at the open Nether milestone, not diamonds', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [
  { id: 'kit', label: 'Weapon and some food', kind: 'manual', status: 'pending', dependsOn: [], detail: 'Stone or better sword and a few food items for the Nether.', evidence: null, check: null },
  step('nether', 'in:minecraft:the_nether')] });
 await views.observe(record, sample(0, [['iron_pickaxe'], ['bucket'], ['flint_and_steel']]));
 const options = views.continuity(record).options;
 assert.match(options, /step nether: Nether access/);
 assert.doesNotMatch(options, /diamond: seen|best pickaxe iron/);
});

test('full game: empty-bucket checks stay literal while reporting the filled capability that survived', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('gear', 'tool:pickaxe:iron+ & has:minecraft:bucket*1')] });
 await views.observe(record, sample(0, [['iron_pickaxe'], ['water_bucket']]));
 assert.match(views.progress(record), /bucket 0\/1; have:water_bucket \(check requires empty\)/);
 assert.equal((await views.operate(record, { operation: 'read' })).plan.steps[0].status, 'pending');
 const flexible = 'tool:pickaxe:iron+ & has:minecraft:bucket|minecraft:water_bucket|minecraft:lava_bucket*1';
 await views.operate(record, { operation: 'replace', plan: { steps: [step('gear', flexible)] } });
 assert.equal((await views.operate(record, { operation: 'read' })).plan.steps[0].status, 'complete');
 await views.observe(record, sample(1, [['iron_pickaxe'], ['lava_bucket']]));
 assert.equal((await views.operate(record, { operation: 'read' })).plan.steps[0].status, 'complete');
 await views.observe(record, sample(2, [['iron_pickaxe']]));
 assert.equal((await views.operate(record, { operation: 'read' })).plan.steps[0].status, 'lost');
});

test('full game: the bed-by-the-portal option shows once a portal is at hand, and before the End once an eye is held', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('nether', 'visited:minecraft:the_nether'), step('end', 'in:minecraft:the_end')] });
 await views.observe(record, sample(0, [['iron_pickaxe'], ['bucket']]));
 assert.doesNotMatch(views.continuity(record).options, /option bed by the/, 'no portal at hand yet');
 await views.observe(record, sample(1, [['iron_pickaxe'], ['water_bucket'], ['flint_and_steel'], ['obsidian', 10]]));
 let options = views.continuity(record).options;
 assert.match(options, /option bed by the nether portal: a bed \(3 wool: shear or kill 3 sheep, \+ 3 planks\) placed beside it and used \(by day too\) sets the Overworld respawn there; beds explode in the Nether and End/);
 assert.match(options, /dropped items lie ~5 min where you died and can be picked up unless lava, fire or the void destroyed them/);
 await views.observe(record, sample(2, [['iron_pickaxe'], ['water_bucket'], ['flint_and_steel'], ['obsidian', 10], ['white_bed']]));
 assert.match(views.continuity(record).options, /option bed by the nether portal: the bed carried placed beside it/);
 const end = new LiveTaskViews();
 end.suggest(record.agentId, record.currentGoal, { steps: [step('end', 'in:minecraft:the_end')] });
 await end.observe(record, sample(0, [['iron_pickaxe']]));
 assert.doesNotMatch(end.continuity(record).options ?? '', /option bed by the/);
 await end.observe(record, sample(1, [['iron_pickaxe'], ['ender_eye', 12]]));
 assert.match(end.continuity(record).options, /option bed by the end portal: /);
});

test('full game: in the Nether with pearls or rods open, the bastion-first and fortress-first routes stand with holdings and sightings', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [{ ...step('nether', 'visited:minecraft:the_nether'), status: 'complete' }, step('rods', 'has:minecraft:blaze_rod*6'), step('pearls', 'has:minecraft:ender_pearl|minecraft:ender_eye*12')] });
 const nether = sample(0, [['iron_pickaxe'], ['gold_ingot', 7]]);
 nether.world.dimension = 'minecraft:the_nether';
 nether.player = { ...nether.player, x: 0.5, y: 60, z: 0.5 };
 await views.observe(record, nether);
 let options = views.continuity(record).options;
 assert.match(options, /Nether route, your choice: bastion first = barter gold with calm adult piglins \(per ingot: 2\.1% 2-4 ender pearls, ~15 ingots per pearl; 3\.4% fire resistance potion; 8\.5% obsidian; 8\.5% crying obsidian\)/);
 assert.match(options, /fortress first = blaze rods \(their only source\); risk: blaze fire, wither skeletons, lava; fire resistance \(potion 3:00\)/);
 assert.match(options, /now: gold armour not worn, 7 gold ingots, 0 fire resistance potions; bastion not seen yet; fortress not seen yet \| option golden helmet now: 5 of the held gold ingots at a crafting table, then equip it/);
 const kitted = sample(1, [['iron_pickaxe'], ['gold_ingot', 2]]);
 kitted.world.dimension = 'minecraft:the_nether';
 kitted.player = { ...kitted.player, x: 0.5, y: 60, z: 0.5 };
 kitted.inventory.items.push({ itemId: 'minecraft:golden_helmet', count: 1, slot: 'head' }, { itemId: 'minecraft:splash_potion', displayName: 'Splash Potion of Fire Resistance', count: 1 });
 await views.observe(record, kitted);
 options = views.continuity(record).options;
 assert.match(options, /now: gold armour worn, 2 gold ingots, 1 fire resistance potions/);
 assert.doesNotMatch(options, /option golden helmet/, 'a worn gold piece ends the helmet option');
 const done = new LiveTaskViews();
 done.suggest(record.agentId, record.currentGoal, { steps: [step('end', 'in:minecraft:the_end')] });
 await done.observe(record, { ...kitted, observedAtEpochMs: 2 });
 assert.doesNotMatch(done.continuity(record).options ?? '', /Nether route/, 'no rods or pearls open: no route line');
 const overworld = new LiveTaskViews();
 overworld.suggest(record.agentId, record.currentGoal, { steps: [step('pearls', 'has:minecraft:ender_pearl*12')] });
 await overworld.observe(record, { ...kitted, observedAtEpochMs: 3, world: { worldId: 'w', dimension: 'minecraft:overworld' } });
 assert.doesNotMatch(overworld.continuity(record).options ?? '', /Nether route/, 'only in the Nether');
});

test('full game: a portal kit step shows the Nether access options, naming the missing kit and the respawn before the trip down', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [step('water', 'has:minecraft:water_bucket*1'), { ...step('light', 'has:minecraft:flint_and_steel|minecraft:fire_charge*1'), dependsOn: ['water'] },
  { ...step('nether', 'in:minecraft:the_nether'), dependsOn: ['light'] }] });
 const surface = sample(0, [['iron_pickaxe'], ['bucket'], ['red_bed']]);
 surface.player = { ...surface.player, x: 0.5, y: 70, z: 0.5 };
 await views.observe(record, surface);
 const options = views.continuity(record).options;
 assert.match(options, /^\(step nether: Nether access; casting needs no diamond pick\) obsidian: est\. minutes .*\(no water bucket held; casting needs one, any water fills a bucket\), cheapest first: dig to the y-55 lava floors ~40/);
 assert.match(options, / \| flint: .*gravel/);
 assert.match(options, / \| trip down: the bed carried, placed by the staircase top and used \(by day too\), sets the respawn there/);
});

test('full game: open pearls price each source from the gold held, sightings and the time of day', async () => {
 const views = new LiveTaskViews();
 views.suggest(record.agentId, record.currentGoal, { steps: [{ ...step('nether', 'visited:minecraft:the_nether'), status: 'complete' }, step('rods', 'has:minecraft:blaze_rod*6'), step('pearls', 'has:minecraft:ender_pearl|minecraft:ender_eye*12')] });
 const nether = sample(0, [['iron_pickaxe'], ['gold_ingot', 10], ['ender_pearl', 2]]);
 nether.world = { ...nether.world, dimension: 'minecraft:the_nether', dayTime: 6000 };
 nether.player = { ...nether.player, x: 0.5, y: 60, z: 0.5 };
 await views.observe(record, nether);
 let options = views.continuity(record).options;
 // The rods step comes first: the pearl line follows its needs, ahead of the route line.
 assert.match(options, /^blaze_rod: .* \| ender_pearl: 10 more needed \(pearls and eyes held 2\/12: 2 pearls; 10 gold; eyes: 1 per empty End portal frame of 12 \(a frame starts filled 10% of the time\), 1 in 5 thrown to find the stronghold breaks\), est\. options: primary Nether pearl route: find a warped forest through visible exploration; mine seen ore and barter held gold as secondary supply; barter the 10 held gold: ~0\.6 pearls expected, 81% chance of none, ~1 min \(6 s per ingot per piglin, several at once\)/);
 assert.match(options, /10 pearls by barter take ~157 gold \(~18 gold blocks\) \| Nether route/);
 assert.doesNotMatch(options, /2-high tunnel/, 'no enderman option, no fight rule');
 // Overworld by day with no enderman: nothing to act on, no line; at night it returns.
 const day = new LiveTaskViews();
 day.suggest(record.agentId, record.currentGoal, { steps: [step('rods', 'has:minecraft:blaze_rod*6'), step('pearls', 'has:minecraft:ender_pearl*12')] });
 await day.observe(record, { ...sample(1, [['iron_sword']]), player: { dead: false, x: 0.5, y: 70, z: 0.5 }, world: { worldId: 'w', dimension: 'minecraft:overworld', dayTime: 3000 } });
 assert.doesNotMatch(day.continuity(record).options ?? '', /ender_pearl:/);
 await day.observe(record, { ...sample(2, [['iron_sword']]), player: { dead: false, x: 0.5, y: 70, z: 0.5 }, world: { worldId: 'w', dimension: 'minecraft:overworld', dayTime: 15000 } });
 assert.match(day.continuity(record).options, /ender_pearl: 12 more needed .*night now: endermen spawn/);
 // A first step that needs pearls carries the line once, in its needs.
 const first = new LiveTaskViews();
 first.suggest(record.agentId, record.currentGoal, { steps: [step('pearls', 'has:minecraft:ender_pearl*12')] });
 await first.observe(record, { ...nether, observedAtEpochMs: 3 });
 options = first.continuity(record).options;
 assert.equal(options.match(/ender_pearl: \d+ more needed/g)?.length, 1);
});

test('full game: pearls partly gathered keep their place on the plan line, and a pearl source in view leads the options', async () => {
 const views = new LiveTaskViews();
 // The d30-ngold-a plan after a lucky barter: stale Overworld steps and long route steps would fill the line first.
 const long = 'Bastion route: seek useful pearls, fire resistance or supplies; piglin brutes remain hostile.';
 views.suggest(record.agentId, record.currentGoal, { steps: [step('lava', 'lava:10'), step('water', 'has:minecraft:water_bucket*1'), { ...step('nether', 'in:minecraft:the_nether'), status: 'complete' },
  { ...step('bastion', null), kind: 'manual', detail: long, dependsOn: ['nether'] }, { ...step('fortress', 'seen:minecraft:fortress'), dependsOn: ['nether'] },
  { ...step('rods', 'has:minecraft:blaze_rod*6'), dependsOn: ['fortress'] }, { ...step('pearls', 'has:minecraft:ender_pearl|minecraft:ender_eye*12'), dependsOn: ['nether'] }] });
 const after = sample(0, [['iron_pickaxe'], ['gold_ingot', 3], ['ender_pearl', 5], ['ender_eye', 1]]);
 after.world = { ...after.world, dimension: 'minecraft:the_nether', dayTime: 6000 };
 after.player = { ...after.player, x: 0.5, y: 60, z: 0.5 };
 after.entities = [{ type: 'minecraft:piglin', stableId: 'p1', x: 2.5, y: 60, z: 0.5, distance: 2, alive: true }];
 await views.observe(record, after);
 const shown = views.continuity(record);
 assert.match(shown.plan, /open pearls\[unmet:ender_pearl\|ender_eye 6\/12\]/);
 assert.ok(Buffer.byteLength(shown.plan) <= 260, shown.plan);
 assert.match(shown.options, /^ender_pearl: 6 more needed \(pearls and eyes held 6\/12: 5 pearls, 1 eyes; 3 gold; .*est\. options: primary Nether pearl route: find a warped forest through visible exploration; mine seen ore and barter held gold as secondary supply; barter the 3 held gold: ~0\.2 pearls expected, 94% chance of none, <1 min with the 1 calm piglin in view/);
 assert.match(shown.options, /6 pearls by barter take ~94 gold \(~11 gold blocks\)/);
 // Gold spent: still the open need, ahead of the route line.
 const spent = { ...after, observedAtEpochMs: 1, inventory: sample(1, [['iron_pickaxe'], ['ender_pearl', 6]]).inventory };
 await views.observe(record, spent);
 assert.match(views.continuity(record).options, /^ender_pearl: 6 more needed .* \| Nether route/);
 // An enderman in view: its hunt and the fight rule lead the pearl line, ahead of the barter sums.
 const enderman = { ...spent, observedAtEpochMs: 2, entities: [{ type: 'minecraft:enderman', stableId: 'e1', x: 10.5, y: 60, z: 0.5, distance: 10, alive: true }] };
 await views.observe(record, enderman);
 assert.match(views.continuity(record).options, /^ender_pearl: 6 more needed .*est\. options: 1 enderman in view: 0-1 pearl per kill .*; enderman fight: 40 health, hits ~7 .*optional protection, not a prerequisite; a stare at its eyes provokes one; collect its pearl; 6 pearls by barter take/);
});
