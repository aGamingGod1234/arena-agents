import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { howto, howtoHoldings, howtoIndex, resolveHowtoTopic, HOWTO_MAX_LINES, HOWTO_MAX_DEPTH } from '../src/howto.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const world = { ready: true, position: { x: 0, y: 64, z: 0 }, world: { dimension: 'minecraft:overworld' } };
const holding = (items = [], extra = {}) => howtoHoldings({ observation: { ...world, inventory: { items }, ...extra.observation }, placedStations: extra.placedStations ?? [] });
const empty = holding();
const lines = result => result.tree.join('\n');
const handles = result => [...JSON.stringify(result).matchAll(/howto:([^\s"(),;|]+)/g)].map(m => m[1]);

test('the committed index is generated for the pinned Minecraft version', () => {
	const version = readFileSync(new URL('../../gradle.properties', import.meta.url), 'utf8').match(/^minecraft_version=(.+)$/m)[1].trim();
	const index = howtoIndex();
	assert.equal(index.minecraft, version);
	for (const key of ['recipes', 'tags', 'blockDrops', 'harvest', 'toolSets', 'mobDrops', 'loot', 'trades', 'worldgen', 'fuels']) assert.ok(Object.keys(index[key]).length > 0, key);
});

test('several sources are listed in stable game-data order and none is expanded for the model', () => {
	const leather = howto('leather', empty);
	assert.deepEqual(leather.tree.slice(0, 3), ['leather x1 have 0: 4 options', ' 1 craft <- rabbit_hide x4', ' 2 kill cow(chance)|donkey(chance)|+6']);
	assert.equal(leather.tree.length, 5, 'no option is expanded until the model asks');
	assert.equal(leather.expand, 'howto:leather/<n>');
	const chosen = howto('leather/2', empty);
	assert.match(chosen.tree[0], /^leather x1 have 0: option 2\/4 kill cow\(chance\)\|donkey\(chance\)\|\+6/);
	const cake = lines(howto('cake/1', empty));
	assert.doesNotMatch(cake, /emerald/, 'a multi-source input is summarized, not expanded along a runtime-chosen route');
	const planks = howto('#planks', empty);
	assert.deepEqual(planks.tree.slice(0, 2), ['#planks(any of 13) x1 have 0: any member', ' 1 acacia_planks']);
});

test('a single-source chain expands because there is nothing to choose', () => {
	assert.deepEqual(howto('eye of ender', empty).tree, [
		'ender_eye x1 have 0: craft <- ender_pearl x1, blaze_powder x1',
		' ender_pearl x1 have 0: 4 options: 1 kill enderman(chance); 2 trade cleric L4 emerald x5; +2 (howto:ender_pearl)',
		' blaze_powder x1 have 0: craft (makes 2) <- blaze_rod x1',
		'  blaze_rod x1 have 0: kill blaze(player kill+chance) in the_nether fortress',
	]);
});

test('valid sources survive even where generation location is not indexed', () => {
	const obsidian = lines(howto('obsidian', empty));
	assert.match(obsidian, /mine obsidian tool diamond_pickaxe\+ missing/);
	assert.match(lines(howto('obsidian/3', empty)), /location not indexed/);
	assert.match(lines(howto('nether_wart', empty)), /mine nether_wart/);
	assert.match(lines(howto('torch', empty)), /mine torch/, 'breaking a found torch is a real source too');
});

test('fuel readiness counts the burn time each smelt consumes in every furnace type', () => {
	const stick = { itemId: 'minecraft:stick', count: 1, slot: 1 };
	for (const [input, station, topic] of [['raw_iron', 'blast_furnace', 'iron_ingot'], ['beef', 'smoker', 'cooked_beef']]) {
		const holdings = holding([{ itemId: `minecraft:${input}`, count: 1, slot: 0 }, stick], { observation: { blocks: [{ x: 1, y: 64, z: 0, blockId: `minecraft:${station}` }] } });
		const text = lines(howto(topic, holdings));
		assert.doesNotMatch(text, new RegExp(`smelt@${station}[^\\n]*ready`), `${station} with one stick`);
		assert.match(text, new RegExp(`smelt@${station}\\[visible 2m\\]\\+fuel\\[50% held\\]`));
	}
	const coal = holding([{ itemId: 'minecraft:raw_iron', count: 1 }, { itemId: 'minecraft:coal', count: 1 }], { observation: { blocks: [{ x: 1, y: 64, z: 0, blockId: 'minecraft:blast_furnace' }] } });
	assert.match(lines(howto('iron_ingot', coal)), /smelt@blast_furnace\[visible 2m\]\+fuel\[ok\] <- raw_iron x1 ok \(ready\)/);
});

test('a placed or visible station gives access, never a consumable ingredient', () => {
	const holdings = holding([{ itemId: 'minecraft:oak_log', count: 4 }], { observation: { blocks: [{ x: 2, y: 64, z: 0, blockId: 'minecraft:furnace' }] },
		placedStations: [{ blockId: 'minecraft:crafting_table', x: 5, y: 64, z: 0, dimension: 'minecraft:overworld' }] });
	const smoker = lines(howto('smoker', holdings));
	assert.doesNotMatch(smoker, /ready/);
	assert.match(smoker, /craft@crafting_table\[placed 6m\] <- #logs\(any of 48\) x4 ok, furnace x1/);
	assert.match(howto('crafting_table', holdings).tree[0], /^crafting_table x1 have 0, placed 6m:/);
	assert.match(howto('stone', holding([], { observation: { blocks: [{ x: 1, y: 63, z: 0, blockId: 'minecraft:stone' }] } })).tree[0], /^stone x1 have 0:/);
	const kit = holding([{ itemId: 'minecraft:stone_pickaxe', count: 1, damage: 31, maxDamage: 131 }, { itemId: 'minecraft:iron_helmet', count: 1, slot: 'head' }]);
	assert.equal(howto('iron_helmet', kit).tree[0], 'iron_helmet x1 ok worn 1');
	assert.match(lines(howto('raw_iron/1', kit)), /tool stone_pickaxe held 100 uses/);
	const dead = howtoHoldings({ observation: { ...world, player: { dead: true }, inventory: { items: [{ itemId: 'minecraft:stick', count: 4 }] } } });
	assert.equal(howto('stick', dead).holdings, 'unknown (no fresh inventory)');
});

test('singleton tags resolve to their member before looking up sources', () => {
	assert.match(howto('#iron_tool_materials', empty).tree[0], /^iron_ingot x1 have 0: \d+ options/);
	assert.match(howto('#diamond_tool_materials', empty).tree[0], /^diamond x1 have 0: \d+ options/);
});

test('every topic stays within the line and depth bounds and emits only resolvable handles', () => {
	const index = howtoIndex();
	const topics = new Set([...Object.keys(index.recipes), ...Object.keys(index.blockDrops), ...Object.keys(index.mobDrops), ...Object.keys(index.loot), ...Object.keys(index.trades), ...Object.keys(index.tags)]);
	let largest = 0;
	for (const topic of topics) {
		const result = howto(topic, empty);
		assert.ok(result.tree.length <= HOWTO_MAX_LINES, `${topic} lines`);
		for (const line of result.tree) assert.ok(line.match(/^ */)[0].length <= HOWTO_MAX_DEPTH, `${topic} depth: ${line}`);
		for (const handle of handles(result)) {
			if (handle === 'fuel' || handle.endsWith('/<n>')) continue;
			const [id, option] = handle.split('/');
			assert.equal(resolveHowtoTopic(id).id, id, `${topic} handle ${handle}`);
			if (option !== undefined) assert.ok(howto(handle, empty).tree[0].includes(`option ${option}/`), `${topic} handle ${handle}`);
		}
		largest = Math.max(largest, Buffer.byteLength(JSON.stringify(result)));
	}
	assert.ok(largest <= 3_000, `largest answer ${largest} bytes`);
});

test('loot conditions keep variant guards, chances and either-or tools', () => {
	assert.match(lines(howto('white_wool', empty)), /kill sheep\(condition\)/);
	assert.match(lines(howto('oak_leaves', empty)), /mine oak_leaves\(shears or silk touch\)/);
	assert.match(lines(howto('blaze_rod', empty)), /kill blaze\(player kill\+chance\)/);
});

test('generation heights use the generator depth and brewing takes one to three bottles', () => {
	assert.match(lines(howto('ancient_debris/1', empty)), /can generate: the_nether y8\.\.24~16,8\.\.119/);
	const brew = lines(howto('potion:fire_resistance', empty));
	assert.match(brew, /^potion:fire_resistance x1 have \?: brew@brewing_stand\[missing\]\+blaze_powder\(fuel\)\[missing\] \(1-3 bottles per brew\) <- potion:awkward x1, magma_cream x1/m);
	const four = howto('potion:fire_resistance', empty, { count: 4 }).tree[0];
	assert.match(four, /<- potion:awkward x4, magma_cream x2/);
});

test('answers without a found item keep the scope note and topics resolve spelled names', () => {
	assert.deepEqual(resolveHowtoTopic('Minecraft:Iron Pickaxe'), { id: 'iron_pickaxe' });
	const ambiguous = howto('pickaxe', empty);
	assert.equal(ambiguous.found, false);
	assert.ok(ambiguous.scope);
	assert.ok(ambiguous.candidates.includes('howto:iron_pickaxe'));
	assert.ok(howto('not a real thing', empty).scope);
	assert.deepEqual(howto('fuel', holding([{ itemId: 'minecraft:coal', count: 3 }])).held, ['coal x3 (8 smelts each)']);
});

test('the howto section takes a topic, option suffix and option paging', () => {
	assert.deepEqual(normalizeMinecraftToolCall('capabilities', { section: 'howto', topic: 'iron_ingot/2' }), { kind: 'capabilities', section: 'howto', topic: 'iron_ingot/2' });
	assert.deepEqual(normalizeMinecraftToolCall('capabilities', { section: 'howto', topic: 'iron_ingot', offset: 8 }), { kind: 'capabilities', section: 'howto', topic: 'iron_ingot', offset: 8 });
	assert.throws(() => normalizeMinecraftToolCall('capabilities', { section: 'howto' }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	const many = howto('iron_ingot', empty);
	assert.equal(many.nextOffset, 8);
	assert.match(howto('iron_ingot', empty, { offset: 8 }).tree[1], /^ 9 /);
});

test('the capabilities description is the merged text shared with the knowledge branch', () => {
	const description = MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === 'capabilities').description;
	assert.equal(description, 'List action fields, query sections, limits and runtime support; no gameplay. Read each topic once. program: read before writing ArenaScript. control: lists topics; read tool:<name> or action:<actionType> before unfamiliar calls, follow nextOffset; topic all is complete. strategy: mechanics incl ores; no topic lists all. howto: topic <item>: sources vs what you have.');
});

const furnace = { observation: { blocks: [{ x: 1, y: 64, z: 0, blockId: 'minecraft:furnace' }] } };

test('an input and its fuel cannot be the same held item', () => {
	const one = lines(howto('charcoal', holding([{ itemId: 'minecraft:oak_log', count: 1 }], furnace)));
	assert.match(one, /smelt@furnace\[visible 2m\]\+fuel\[none held after inputs\] <- #logs_that_burn\(any of 40\) x1 ok/);
	assert.doesNotMatch(one, /ready/);
	const two = lines(howto('charcoal', holding([{ itemId: 'minecraft:oak_log', count: 2 }], furnace)));
	assert.match(two, /smelt@furnace\[visible 2m\]\+fuel\[ok\] <- #logs_that_burn\(any of 40\) x1 ok \(ready\)/);
	const mixed = lines(howto('charcoal', holding([{ itemId: 'minecraft:oak_log', count: 1 }, { itemId: 'minecraft:stripped_oak_log', count: 1 }], furnace)));
	assert.match(mixed, /\+fuel\[ok\] <- #logs_that_burn\(any of 40\) x1 ok \(ready\)/, 'one tag member is the input, the other the fuel');
	const stand = { observation: { blocks: [{ x: 1, y: 64, z: 0, blockId: 'minecraft:brewing_stand' }] } };
	assert.match(howto('potion:strength', holding([{ itemId: 'minecraft:blaze_powder', count: 1 }], stand)).tree[0], /\+blaze_powder\(fuel\)\[missing\] .*<- potion:awkward x1, blaze_powder x1 ok/);
	assert.doesNotMatch(howto('potion:strength', holding([{ itemId: 'minecraft:blaze_powder', count: 2 }], stand)).tree[0], /blaze_powder\(fuel\)\[missing\]/);
});

const topicsOf = index => new Set([...Object.keys(index.recipes), ...Object.keys(index.blockDrops), ...Object.keys(index.mobDrops), ...Object.keys(index.loot), ...Object.keys(index.trades), ...Object.keys(index.tags)]);
const rootCount = topic => { const head = howto(topic, empty).tree[0]; const m = head.match(/: (\d+) options$/); return m ? Number(m[1]) : 1; };

test('an item shows the same sources wherever it is reached', () => {
	const counts = new Map();
	const count = id => { if (!counts.has(id)) counts.set(id, rootCount(id)); return counts.get(id); };
	let checked = 0;
	for (const topic of topicsOf(howtoIndex())) {
		const total = count(topic);
		for (const query of [topic, ...(total > 1 ? Array.from({ length: Math.min(total, 12) }, (_, i) => `${topic}/${i + 1}`) : [])]) {
			for (const line of howto(query, empty).tree.slice(1)) {
				const m = line.match(/^ +(?:station |tool |fuel )?(\S+) x\d+ [^:]*: (\d+) options: /);
				if (!m) continue;
				assert.equal(Number(m[2]), count(m[1]), `${m[1]} reached from ${query}`);
				checked++;
			}
		}
	}
	assert.ok(checked > 500, `checked ${checked} child menus`);
	assert.match(lines(howto('coal/1', empty)), /coal_block x1 have 0: 2 options: /, 'a cycle no longer removes a source and auto-expands the rest');
	const blast = howto('iron_ingot', holding([{ itemId: 'minecraft:iron_ingot', count: 5 }]), { count: 6 });
	assert.equal(blast.tree[0], 'iron_ingot x6 held 5: 10 options');
});

test('every grouped source and tag member is reachable through option and offset paging', () => {
	const index = howtoIndex();
	const collect = topic => { let text = '', offset = 0; for (;;) { const r = howto(topic, empty, { offset }); assert.ok(r.tree.length <= HOWTO_MAX_LINES && r.tree.every(line => line.match(/^ */)[0].length <= HOWTO_MAX_DEPTH) && Buffer.byteLength(JSON.stringify(r)) <= 3_000, topic); text += `${r.tree.join('\n')}\n`; if (r.nextOffset === undefined) return text; offset = r.nextOffset; } };
	for (const [tag, members] of Object.entries(index.tags)) {
		if (members.length < 2) continue;
		const text = collect(tag);
		for (const member of members) assert.ok(text.includes(` ${member}\n`), `${member} via ${tag}`);
	}
	for (const [item, rows] of Object.entries(index.mobDrops)) {
		const total = rootCount(item);
		let text = '';
		for (let n = 1; n <= total; n++) text += collect(`${item}/${n}`);
		for (const [mob] of rows) assert.ok(new RegExp(`(kill |- |\\|)${mob}\\b`).test(text), `${mob} for ${item}`);
	}
	for (const [item, tables] of Object.entries(index.loot)) {
		const total = rootCount(item);
		let text = '';
		for (let n = 1; n <= total; n++) text += collect(`${item}/${n}`);
		// The bartering table is shown as its priced barter option rather than by name.
		for (const table of tables) assert.ok(table === 'gameplay/piglin_bartering' ? /barter: give gold_ingot x1/.test(text) : text.includes(table), `${table} for ${item}`);
	}
	for (const [item, rows] of Object.entries(index.blockDrops)) {
		const total = rootCount(item);
		let text = '';
		for (let n = 1; n <= total; n++) text += collect(`${item}/${n}`);
		for (const [block] of rows) assert.ok(new RegExp(`(mine |- |\\|)${block}\\b`).test(text), `${block} for ${item}`);
	}
	assert.match(collect('leather/2'), /- hoglin\(chance\)/);
	assert.match(collect('#planks'), / oak_planks\n/);
});

test('a child line agrees with its parent when an earlier input already used the held item', () => {
	const stand = { observation: { blocks: [{ x: 1, y: 64, z: 0, blockId: 'minecraft:brewing_stand' }] } };
	const strength = lines(howto('potion:strength', holding([{ itemId: 'minecraft:blaze_powder', count: 1 }], stand)));
	assert.match(strength, /^ fuel blaze_powder x1 held 1, 1 reserved for other inputs: /m);
	assert.doesNotMatch(strength, /fuel blaze_powder x1 ok/);
	assert.match(lines(howto('potion:strength', holding([{ itemId: 'minecraft:blaze_powder', count: 2 }], stand))), /^potion:strength x1 [^\n]*blaze_powder x1 ok/m);
	assert.doesNotMatch(lines(howto('potion:strength', holding([{ itemId: 'minecraft:blaze_powder', count: 2 }], stand))), /fuel blaze_powder/);
});

test('vanilla use results and bartering are sources with their real inputs', () => {
	const bucket = holding([{ itemId: 'minecraft:bucket', count: 1 }]);
	for (const fluid of ['water', 'lava']) {
		assert.match(lines(howto(`${fluid}_bucket`, bucket)), new RegExp(`use: fill at a ${fluid} source: interact_block on it, or look at it and use_item mode:once <- bucket x1 ok`));
	}
	assert.match(lines(howto('lava_bucket', empty)), /bucket x1 have 0: /, 'the empty bucket is the requirement, expanded like any input');
	assert.match(lines(howto('obsidian', empty)), / 1 use: cast: water flowing onto a lava source makes obsidian in place \(not in the Nether\)[^\n]*<- water_bucket x1/);
	const pearl = howto('ender_pearl', empty);
	assert.match(lines(pearl), / 3 barter: give gold_ingot x1 to a calm adult piglin \(interact_entity holding it, or drop it near\); random return after about 6 s/);
	assert.doesNotMatch(lines(howto('ender_pearl/4', empty)), /piglin_bartering/, 'the barter table is not repeated as chest loot');
	assert.match(lines(howto('ender_pearl/3', holding([{ itemId: 'minecraft:gold_ingot', count: 2 }]))), /\(ready\)/);
	assert.match(lines(howto('ender_pearl/3', empty)), /gold_ingot x1 have 0: /, 'the missing ingot expands to its own sources');
	assert.match(lines(howto('milk_bucket', bucket)), /use: interact_entity with a cow, goat or mooshroom <- bucket x1 ok/);
});
