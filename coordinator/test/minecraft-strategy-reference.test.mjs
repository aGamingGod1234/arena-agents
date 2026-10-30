import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveTaskViews } from '../src/live-task-view.mjs';
import { STRATEGY_REFERENCE_TOPICS, situationStrategyTopic, strategyHints } from '../src/minecraft-strategy-reference.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, NATIVE_AGENT_INSTRUCTIONS, minecraftCapabilities, normalizeMinecraftToolCall, toolResultContent } from '../src/native-minecraft-tools.mjs';

test('strategy knowledge is an on-demand capabilities section with bounded whole topics', () => {
	const index = minecraftCapabilities({ section: 'strategy' });
	assert.equal(index.section, 'strategy');
	assert.match(index.detail, /queries perform no gameplay/i);
	assert.deepEqual(index.topics.map(({ id }) => id), [...STRATEGY_REFERENCE_TOPICS]);
	assert.deepEqual(minecraftCapabilities().strategyReference, { tool: 'capabilities', arguments: { section: 'strategy' } });
	for (const topic of STRATEGY_REFERENCE_TOPICS) {
		assert.deepEqual(normalizeMinecraftToolCall('capabilities', { section: 'strategy', topic }), { kind: 'capabilities', section: 'strategy', topic });
		const page = minecraftCapabilities({ section: 'strategy', topic });
		const rendered = toolResultContent(page).contentItems[0].text;
		// Whole-inventory travel description adds exactly 32 UTF-8 bytes to this topic.
		assert.ok(Buffer.byteLength(rendered, 'utf8') <= (topic === 'nether' ? 4_128 : 4_096), `${topic} stays a small single read`);
		assert.deepEqual(JSON.parse(rendered), page, 'transport keeps the whole topic');
		assert.doesNotMatch(page.reference, /<!-- \/?registry-/, 'generator markers stay in source, outside model-facing topics');
	}
	for (const args of [{ section: 'strategy', topic: 'cheats' }, { section: 'strategy', topic: 'water', offset: 0 }, { section: 'program', topic: 'water' }]) {
		assert.throws(() => normalizeMinecraftToolCall('capabilities', args), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	}
	// Live d4e: the stronghold search asked for topic "stronghold", failed, and never read The End.
	for (const [asked, topic] of [['stronghold', 'end'], ['The End', 'end'], ['eye_of_ender', 'end'], ['blaze', 'nether']]) {
		assert.deepEqual(normalizeMinecraftToolCall('capabilities', { section: 'strategy', topic: asked }), { kind: 'capabilities', section: 'strategy', topic });
	}
	assert.ok(!NATIVE_AGENT_INSTRUCTIONS.includes('strategy'), 'always-loaded instructions do not grow');
	const description = MINECRAFT_DYNAMIC_TOOLS.find((tool) => tool.name === 'capabilities').description;
	assert.ok(Buffer.byteLength(description) <= 384, 'contract and topic discovery fit the existing description budget');
	for (const contract of ['List action fields, query sections, limits and runtime support; no gameplay.', 'Read each topic once.', 'read before writing ArenaScript', 'read tool:<name> or action:<actionType> before unfamiliar calls, follow nextOffset; topic all is complete.']) assert.ok(description.includes(contract), contract);
	assert.match(description, /strategy:[^.]*\bores\b/);
	assert.ok(description.includes('no topic lists all.'), 'the topic index remains discoverable after merging other sections');
});

test('visible situations supply a small knowledge pointer without a goal or plan', () => {
	const observation = (extra = {}) => ({ player: { dead: false, foodLevel: 20 }, world: { dimension: 'minecraft:overworld', dayTime: 1000 }, inventory: { items: [] }, entities: [], blocks: [], ...extra });
	const item = (itemId) => ({ itemId, count: 1 });
	const cases = [
		[observation({ player: { onFire: true } }), 'hazards'],
		[observation({ player: { inLava: true }, world: { dimension: 'minecraft:the_nether' } }), 'hazards'],
		[observation({ player: { hazard: 'hot_floor' } }), 'hazards'],
		[observation({ player: { underWater: true } }), 'water'],
		[observation({ player: { foodLevel: 17 } }), 'survival'],
		[observation({ player: { skyOpen: true }, world: { dimension: 'minecraft:overworld', dayTime: 14000 } }), 'survival'],
		[observation({ inventory: { items: [item('minecraft:chicken')] } }), 'survival'],
		[observation({ inventory: { items: [item('minecraft:cod')] } }), 'survival'],
		[observation({ blocks: [{ blockId: 'minecraft:diamond_ore' }] }), 'tools'],
		[observation({ blocks: [{ blockId: 'minecraft:stone' }] }), 'tools'],
		[observation({ inventory: { items: [item('minecraft:copper_pickaxe')] }, blocks: [{ blockId: 'minecraft:deepslate_diamond_ore' }] }), 'tools'],
		[observation({ inventory: { items: [item('minecraft:golden_pickaxe')] }, blocks: [{ blockId: 'minecraft:iron_ore' }] }), 'tools'],
		[observation({ entities: [{ hostile: true, alive: true }] }), 'combat'],
		[observation({ world: { dimension: 'minecraft:the_nether' } }), 'nether'],
		[observation({ world: { dimension: 'minecraft:the_end' } }), 'end'],
	];
	for (const [facts, expected] of cases) {
		assert.equal(situationStrategyTopic(facts), expected);
		assert.ok(STRATEGY_REFERENCE_TOPICS.includes(expected));
		assert.ok(Buffer.byteLength(`; strategy:${expected}`) <= 25, 'no extra JSON wrapper');
	}
	for (const facts of [null, observation(), observation({ player: { dead: true, onFire: true } }), observation({ player: { inWater: true } }),
		observation({ player: { skyOpen: false }, world: { dimension: 'minecraft:overworld', dayTime: 14000 } }),
		observation({ world: { dimension: 'minecraft:overworld', dayTime: 14000 } }),
		observation({ inventory: { items: [item('minecraft:cooked_chicken')] } }),
		observation({ inventory: { items: [item('minecraft:chicken'), item('minecraft:furnace')] } }),
		observation({ inventory: { items: [item('minecraft:potato')] }, blocks: [{ blockId: 'minecraft:smoker' }] }),
		observation({ inventory: { items: [item('minecraft:beef'), item('minecraft:campfire')] } }),
		observation({ inventory: { items: [item('minecraft:salmon')] }, blocks: [{ blockId: 'minecraft:soul_campfire' }] }),
		observation({ inventory: { items: [item('minecraft:iron_pickaxe')] }, blocks: [{ blockId: 'minecraft:diamond_ore' }] }),
		observation({ entities: [{ hostile: true, alive: false }] })]) {
		assert.equal(situationStrategyTopic(facts), null);
		const topic = situationStrategyTopic(facts);
		assert.equal(topic === null ? '' : `; strategy:${topic}`, '', 'unmatched situation contributes zero bytes');
	}
});

test('survival knowledge covers mechanics, hazards and optional progression', () => {
	const read = (topic) => minecraftCapabilities({ section: 'strategy', topic }).reference;
	const checks = {
		resources: [/Overworld ore/, /Nether ore/, /The End has no natural ore/, /232/, /peak 16/, /Cooking needs fuel, not an underground/],
		tools: [/Bare hands[^.]*no cobblestone/, /Copper has stone-tier/, /gold is fast/i, /diamond,netherite/, /Silk Touch/, /deepslate ores/],
		survival: [/saturation/, /exhaustion/, /18\+/, /10 ticks/, /starvation/, /cooked beef/],
		combat: [/hitbox/, /Height\/gaps\/walls/, /Spears/, /crit/, /shield/, /toughness/],
		'hostile-mobs': [/Husk/, /parched/, /Breeze/, /Creaking/, /Shulker/, /Piglin brute/],
		'neutral-mobs': [/Enderman/, /Zombified piglin/, /Bees/, /Nautilus/, /Polar bears/],
		'passive-mobs': [/Allay/, /Axolotl/, /Sniffer/, /Happy ghast/, /Copper golem/],
		bosses: [/Dragon/, /Wither/, /Elder guardian/, /Warden/],
		farming: [/9x9/, /5 min/, /20 min/, /Golden dandelion/, /Breeding:/],
		villages: [/restock/, /First trade locks/, /no longer sell name tags/, /Weakness/, /Raid Omen/],
		enchanting: [/15 properly spaced/, /40\+ levels/, /Grindstone/, /Mending/],
		brewing: [/20 cycles/, /awkward/, /Weakness/, /lingering/, /undead/],
		shelter: [/Hard zombies/, /bottom slabs/, /Cooking needs fuel/],
		spawning: [/block light 0/, /24/, /128/, /Nether rules vary/],
		portals: [/10 blocks/, /Crying obsidian invalid/, /8:1/, /Y unscaled/],
		navigation: [/compass world spawn/, /Anchor holds 4/, /Nether\/End beds explode/],
		transport: [/Boat/, /Cart/, /Horse/, /Saddles craft/, /pauses air without refilling/],
		redstone: [/0-15/, /Piston/, /Hopper/, /crafter/],
		weather: [/24,000/, /Thunder/, /phantoms/],
		death: [/6,000/, /unloaded chunks pause/, /128/, /32/, /tamed-wolf/],
		nether: [/babies take them without bartering/i, /not guaranteed a structure/, /blackstone substitutes/, /weight 10 of 469 \(about 2\.13%\)/],
		end: [/immune to arrows while perched/, /respawn anchors explode/, /Outer islands/],
		'beat-the-game': [/not a fresh-start route/, /empty frames determine/, /optional, not victory/, /topic sourcing/],
		sourcing: [/choice between ways, not one method/, /taskPlan options line/, /unchanged Nm, N blocks broken/, /no armour and stone tools/, /iron armour, a sword and a shield/, /iron golem \(3-5 ingots/, /strip mining is steady but costs many blocks per vein/, /observed lit, clear of mobs and close to an exit/, /Y -59/, /water bucket onto lava sources/, /0-1 rod per player/, /2-4 per pearl barter/, /hay bales/],
	};
	for (const [topic, patterns] of Object.entries(checks)) for (const pattern of patterns) assert.match(read(topic), pattern, topic);
	assert.match(read('nether'), /^- \*\*Piglins:\*\*[^\r\n]*\r?\n  Pearl barter weight 10 of 469 \(about 2\.13%\)\.\r?\n- \*\*Dangers:\*\*/m, 'barter fact continues the Piglins bullet without splitting the list');
});

test('topics remain facts and options rather than authored game scripts', () => {
	const orders = /(?:^|[.;:!] |\*\* )(?:Look (?:around|before)|Swim through|For a mob[^.;]*find a way|Melee the dragon|prepare for the End|Use it when|Watch blocks|Mine (?:all|the whole)|Take workstations|Use the most worn|Finish the most worn|Stand on the floor|Carry (?:blocks|the food)|carry a bow|Do not dig|Check (?:for|how|each)|Head for|Count the|Destroy the|Keep blocks|Survey from|Note the direction|plan on|stay back|sneak and avoid|choose legs|keep clear of|never dig|do X then Y)\b/m;
	for (const topic of STRATEGY_REFERENCE_TOPICS) {
		const reference = minecraftCapabilities({ section: 'strategy', topic }).reference;
		assert.equal(orders.exec(reference), null, topic);
		assert.doesNotMatch(reference, /^\d+\. /m, `${topic}: no numbered walkthrough`);
	}
});

test('sizing up a situation offers questions and tradeoffs with conditional starting knowledge', () => {
	const reference = minecraftCapabilities({ section: 'strategy', topic: 'size-up' }).reference;
	for (const label of ['Health and armour', 'Hunger and food', 'Light and time', 'Threats', 'Weather', 'Shelter', 'Gear', 'Place', 'Way home']) assert.ok(reference.includes(`**${label}.**`), label);
	assert.match(reference, /The order and the conclusions are yours[\s\S]*What can kill me before this finishes\?[\s\S]*Trade-offs players weigh/);
	assert.match(reference, /each applies only where the answer is no[\s\S]*Gear already held may satisfy prerequisites/);
	assert.match(reference, /light requirements vary by mob/);
	assert.doesNotMatch(reference, /every later tool needs sticks|their mobs ignore light|wood in the Nether/);
	// Held gear credits only the prerequisites it covers, and danger is a question for the model, not a ranking.
	assert.match(reference, /only the ones it covers: diamond armour covers armour, not an iron bucket or shield/);
	assert.doesNotMatch(reference, /outranks|change the cost of continuing|has no iron step/);
	assert.match(reference, /What could end this step before it finishes, and what would continuing cost then\?$/);
	assert.doesNotMatch(reference, /questions under all the others|cheapest safe next prerequisite|costs the whole inventory|Below about half health|Overworld ores absent|`changed`/);
	assert.match(reference, /risks carried items if you die\. Death normally drops them/);
	assert.match(reference, /What does each possible prerequisite cost and risk\?/);
	assert.match(reference, /Nether lacks iron, coal and diamond ore; it has Nether gold, quartz and ancient debris/);
	assert.match(reference, /surviving drops can be recovered before 6,000 ticking entity ticks/);
});

test('task plans point to relevant strategy topics for unfinished steps only', async () => {
	assert.equal(strategyHints({ goal: 'say hello', plan: null }), null);
	const iron = strategyHints({ goal: 'get full iron armor', plan: null });
	assert.deepEqual(iron.topics, ['sourcing', 'resources', 'structures']);
	assert.deepEqual(iron.read, { tool: 'capabilities', arguments: { section: 'strategy', topic: 'sourcing' } });
	assert.equal(strategyHints({ goal: 'loot a village' }).advice, 'strategy:structures: mechanics and options.');
	const dragon = strategyHints({ goal: 'beat the game', plan: { steps: [
		{ label: 'Mine iron for bucket', detail: 'caves first', status: 'pending' },
		{ label: 'Swim the flooded cave', detail: '', status: 'complete' },
		{ label: 'Enter the Nether', detail: 'cast obsidian portal', status: 'pending' },
	] } });
	assert.ok(dragon.topics.includes('beat-the-game') && dragon.topics.includes('nether') && dragon.topics.includes('resources'));
	assert.ok(!dragon.topics.includes('water'), 'completed steps add no pointers');

	const record = { agentId: 'agent-s', currentGoal: 'Get iron armor', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' };
	const views = new LiveTaskViews();
	await views.observe(record, { ready: true, observedAtEpochMs: 1000, player: { dead: false }, world: { worldId: 'world-s', dimension: 'minecraft:overworld' }, inventory: { items: [] }, blocks: [] });
	const read = await views.operate(record, { operation: 'read' });
	assert.deepEqual(read.strategy.topics, ['sourcing', 'resources', 'structures']);
	assert.equal(read.advisory, true);
});

test('task plan strategy hints include the observed dimension without goal keywords', async () => {
	const nether = strategyHints({ goal: 'say hello', dimension: 'minecraft:the_nether' });
	const end = strategyHints({ goal: 'say hello', dimension: 'minecraft:the_end' });
	assert.deepEqual(nether.topics, ['nether']);
	assert.deepEqual(end.topics, ['end']);
	assert.equal(nether.advice, 'strategy:nether: mechanics and options.');
	assert.equal(end.advice, 'strategy:end: mechanics and options.');
	assert.doesNotMatch(nether.advice, /before this step/i);
	assert.doesNotMatch(end.advice, /before this step/i);

	const record = { agentId: 'agent-dimension', currentGoal: 'say hello', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' };
	const views = new LiveTaskViews();
	await views.observe(record, { ready: true, observedAtEpochMs: 1000, player: { dead: false }, world: { worldId: 'world-dimension', dimension: 'minecraft:the_nether' }, inventory: { items: [] }, blocks: [] });
	const read = await views.operate(record, { operation: 'read' });
	assert.deepEqual(read.strategy.topics, ['nether']);
});

test('specific mechanics add to existing plan topics while wakes keep a single pointer', async () => {
	assert.equal(strategyHints({ goal: 'mine iron with a pickaxe' }).read.arguments.topic, 'tools');
	assert.deepEqual(strategyHints({ goal: 'mine iron with a pickaxe' }).topics, ['tools', 'sourcing', 'resources', 'structures']);
	assert.equal(strategyHints({ goal: 'trade for ender pearls' }).read.arguments.topic, 'villages');
	assert.equal(strategyHints({ goal: 'enchant diamond gear' }).read.arguments.topic, 'enchanting');
	assert.equal(strategyHints({ goal: 'make a wheat farm by water' }).read.arguments.topic, 'farming');
	assert.equal(strategyHints({ goal: 'test a circuit' }), null, 'the schema index discovers new domains without new wake payloads');
	assert.deepEqual(strategyHints({ goal: 'say hello', plan: { steps: [{ label: 'mine with pickaxe', status: 'complete' }] } }), null);
	const record = { agentId: 'agent-mechanics', currentGoal: 'Mine iron with a pickaxe and smelt it', goalRevision: 1 };
	const views = new LiveTaskViews();
	await views.observe(record, { ready: true, observedAtEpochMs: 1000, player: {}, world: { worldId: 'world-mechanics', dimension: 'minecraft:overworld' }, inventory: { items: [] }, blocks: [] });
	await views.operate(record, { operation: 'replace', plan: { steps: [{ id: 'iron', label: 'Mine iron', kind: 'manual', detail: 'Craft an iron pickaxe', status: 'pending', dependsOn: [], evidence: null, check: null }] } });
	const read = await views.operate(record, { operation: 'read' });
	assert.deepEqual(read.strategy.topics, ['tools', 'sourcing', 'resources', 'structures']);
	const progress = views.progress(record);
	assert.match(JSON.stringify(progress), /strategy:tools/);
	assert.doesNotMatch(JSON.stringify(progress), /strategy:resources|mechanics and options|"topics"/);
});

test('resource needs point to sourcing without displacing Nether, End or mechanics pointers', () => {
	assert.equal(strategyHints({ goal: 'beat the game', plan: { steps: [{ label: 'Get iron for armour', status: 'pending' }] } }).read.arguments.topic, 'sourcing');
	assert.equal(strategyHints({ goal: 'find diamonds' }).read.arguments.topic, 'sourcing');
	for (const [goal, first] of [['build an obsidian portal', 'nether'], ['blaze rod', 'nether'], ['nether blaze rod ender eye', 'nether'], ['ender pearl ender eye', 'nether'], ['trade for ender pearls', 'villages']]) {
		const hints = strategyHints({ goal });
		assert.equal(hints.read.arguments.topic, first, goal);
		assert.ok(hints.topics.includes('sourcing'), `${goal}: plan reads still list sourcing`);
	}
	for (const goal of ['say hello', 'beat the game', 'collect 8 oak logs', 'build a house']) assert.ok(!(strategyHints({ goal })?.topics ?? []).includes('sourcing'), goal);
	assert.equal(strategyHints({ goal: 'say hello', plan: { steps: [{ label: 'Mine iron', status: 'complete' }] } }), null);
	const resources = minecraftCapabilities({ section: 'strategy', topic: 'resources' }).reference;
	assert.match(resources, /topic sourcing/);
	assert.match(resources, /many blocks broken per vein found/);
	assert.doesNotMatch(resources, /Peak 16 underground/, 'the ore table no longer leads with a strip-mining height');
});
