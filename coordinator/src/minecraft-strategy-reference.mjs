import { readFileSync } from 'node:fs';

// Optional progression knowledge, read on demand through capabilities section
// strategy so it never grows the always-loaded instructions. It informs the
// model's choices; it never selects a route or issues gameplay.
const STRATEGY_GUIDE = readFileSync(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/references/strategy-guide.md', import.meta.url), 'utf8');
const COOKABLE_FOODS = new Set(JSON.parse(readFileSync(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/references/cookable-foods.json', import.meta.url), 'utf8')).items);
const PICKAXE_MATERIALS = new Map([...STRATEGY_GUIDE.matchAll(/^\| ([a-z_]+) \| ([a-z,]+) \| /gm)].map(([, block, materials]) => [`minecraft:${block}`, new Set(materials.split(','))]));

const TOPIC_TITLES = Object.freeze({
	resources: 'Getting ores and resources',
	sourcing: 'Choosing how to get a resource',
	structures: 'Structures and loot',
	water: 'Water and swimming',
	survival: 'Survival basics',
	'size-up': 'Sizing up a situation',
	hazards: 'Lava and fire',
	'beat-the-game': 'Beating the game',
	nether: 'The Nether',
	end: 'The End',
	tools: 'Tools and drops',
	combat: 'Combat and equipment',
	'hostile-mobs': 'Hostile mobs',
	'neutral-mobs': 'Neutral mobs',
	'passive-mobs': 'Passive mobs',
	bosses: 'Bosses',
	farming: 'Farming and breeding',
	villages: 'Villages and trading',
	enchanting: 'Enchanting and repairs',
	brewing: 'Brewing',
	shelter: 'Building and shelter',
	spawning: 'Light and spawning',
	portals: 'Lava and portals',
	navigation: 'Navigation and respawn',
	transport: 'Transport',
	redstone: 'Survival redstone',
	weather: 'Weather and time',
	death: 'Death and despawn',
});

const TOPICS = new Map();
const headings = [...STRATEGY_GUIDE.matchAll(/^## ([^\r\n]+)\r?$/gm)].map((match) => ({ title: match[1], offset: match.index }));
for (const [id, title] of Object.entries(TOPIC_TITLES)) {
	const index = headings.findIndex((heading) => heading.title === title);
	if (index < 0) throw new Error(`Missing Minecraft strategy guide heading: ${title}`);
	TOPICS.set(id, { title, text: STRATEGY_GUIDE.slice(headings[index].offset, headings[index + 1]?.offset ?? STRATEGY_GUIDE.length).replace(/^[ \t]*<!-- \/?registry-(?:pickaxe-table|barter-odds) -->\r?\n/gm, '').trimEnd() });
}

export const STRATEGY_REFERENCE_TOPICS = Object.freeze([...TOPICS.keys()]);

/** Topic id for an id, a title or a subject word ("stronghold" is in The End); null when nothing matches. */
export function resolveStrategyTopic(topic) {
	if (typeof topic !== 'string') return null;
	const key = topic.trim().toLowerCase();
	if (TOPICS.has(key)) return key;
	for (const [id, entry] of TOPICS) if (entry.title.toLowerCase() === key) return id;
	const words = key.replace(/[_-]+/g, ' ');
	return [...HINT_RULES, ...MECHANICS_HINT_RULES].find(([, pattern]) => pattern.test(words))?.[0] ?? null;
}

/** A knowledge pointer from fresh player-visible facts, never an action or plan. */
export function situationStrategyTopic(observation) {
	const player = observation?.player;
	if (!player || player.dead === true) return null;
	if (player.onFire === true || player.fire === true || player.inLava === true || ['fire', 'lava', 'hot_floor'].includes(player.hazard)) return 'hazards';
	if (player.underWater === true) return 'water';
	if (Array.isArray(observation.entities) && observation.entities.some((entity) => entity.alive !== false && (entity.hostile === true || entity.targetingAgent === true))) return 'combat';
	if (Number.isFinite(player.foodLevel) && player.foodLevel < 18) return 'survival';
	const world = observation.world;
	const time = Number.isFinite(world?.dayTime) ? ((world.dayTime % 24_000) + 24_000) % 24_000 : null;
	if (world?.dimension === 'minecraft:overworld' && time >= 13_000 && time < 23_000 && player.skyOpen === true) return 'survival';
	const items = observation.inventory?.items;
	const blocks = Array.isArray(observation.blocks) ? observation.blocks : [];
	if (Array.isArray(items)) {
		const cookingStation = (id) => ['minecraft:furnace', 'minecraft:smoker', 'minecraft:campfire', 'minecraft:soul_campfire'].includes(id);
		if (items.some((row) => row.count > 0 && COOKABLE_FOODS.has(row.itemId)) && !items.some((row) => row.count > 0 && cookingStation(row.itemId)) && !blocks.some((row) => cookingStation(row.blockId))) return 'survival';
		const pickaxes = items.filter((row) => row.count > 0 && /^minecraft:[a-z]+_pickaxe$/.test(row.itemId)).map((row) => row.itemId.slice('minecraft:'.length, -'_pickaxe'.length).replace('golden', 'gold'));
		if (blocks.some((row) => {
			const materials = PICKAXE_MATERIALS.get(row.blockId?.replace('minecraft:deepslate_', 'minecraft:'));
			return materials && !pickaxes.some((material) => materials.has(material));
		})) return 'tools';
	}
	if (world?.dimension === 'minecraft:the_nether') return 'nether';
	if (world?.dimension === 'minecraft:the_end') return 'end';
	return null;
}

export function minecraftStrategyReference({ topic } = {}) {
	if (topic === undefined) return {
		version: 1, section: 'strategy',
		detail: 'Optional Minecraft options. The model chooses whether to read; queries perform no gameplay.',
		topics: [...TOPICS].map(([id, entry]) => ({ id, title: entry.title })),
	};
	const entry = TOPICS.get(topic);
	if (entry === undefined) throw new TypeError(`Unknown Minecraft strategy topic: ${topic}`);
	return { version: 1, section: 'strategy', topic, title: entry.title, reference: entry.text };
}

const MECHANICS_HINT_RULES = [
	['tools', /\b(pickaxe|tool tier|bare.hand|drops?)\b/i],
	['combat', /\b(combat|crit|shield|bow|melee|fight)\b/i],
	['farming', /\b(farm|farming|breed|wheat|crops?)\b/i],
	['villages', /\b(trade|trading|villagers?)\b/i],
	['enchanting', /\b(enchant|enchanting|anvil|grindstone|mending)\b/i],
	['brewing', /\b(brew|brewing|potions?)\b/i],
	['navigation', /\b(compass|maps?|respawn|coordinates?)\b/i],
	['transport', /\b(boats?|minecarts?|horses?|elytra|nautilus)\b/i],
	['redstone', /\b(pistons?|hoppers?|repeaters?|circuit)\b/i],
	['death', /\b(death|despawn|recover items)\b/i],
	['spawning', /\b(spawn.proof|spawning|mob farm|light level)\b/i],
	['shelter', /\b(shelter|build a house|base)\b/i],
	['weather', /\b(weather|thunder|rain|daylight)\b/i],
	['survival', /\b(hunger|saturation|regenerat|food|cook)\b/i],
];

// sourcing appears twice: iron and diamonds lead with it because several ways compete for them; for portal,
// rod and pearl needs it follows the Nether/End topics, which stay the wake pointer for those steps.
const HINT_RULES = [
	['sourcing', /\b(iron|diamonds?)\b/i],
	['resources', /\b(iron|diamonds?|ores?|coal|copper|gold|redstone|lapis|emeralds?|ancient debris|netherite|mine|mining|strip)\b/i],
	['structures', /\b(iron|diamonds?|loot|chests?|village|shipwreck|treasure|temple|mineshaft|armou?r)\b/i],
	['water', /\b(water|swim|swimming|ocean|river|flooded|underwater|drown)\b/i],
	['nether', /\b(nether|portal|obsidian|blaze|fortress|bastion|piglins?|pearls?)\b/i],
	['end', /\b(dragon|stronghold|eyes? of ender|ender eyes?|end portal|the end)\b/i],
	['sourcing', /\b(obsidian|blaze rods?|ender pearls?|pearls?)\b/i],
	['beat-the-game', /\b(beat the game|ender dragon|kill the dragon|dragon)\b/i],
];

/**
 * Topic pointers for the current dimension, goal and unfinished plan steps.
 * Only names on-demand topics; the model decides whether to read them.
 */
export function strategyHints({ goal = null, plan = null, dimension = null, includeMechanics = false } = {}) {
	const texts = [typeof goal === 'string' ? goal : goal?.text ?? goal?.originalRequest ?? ''];
	for (const step of Array.isArray(plan?.steps) ? plan.steps : []) {
		if (step?.status === 'complete') continue;
		texts.push([step?.label, step?.detail].filter((value) => typeof value === 'string').join(' '));
	}
	const text = texts.join('\n');
	const dimensionTopic = dimension === 'minecraft:the_nether' ? 'nether' : dimension === 'minecraft:the_end' ? 'end' : null;
	const rules = HINT_RULES.filter(([, pattern]) => pattern.test(text));
	const matches = rules.map(([topic]) => topic);
	// The wake emits only the first topic. Additional mechanics stay discoverable
	// in plan reads without removing the original resource/progression topics.
	const primaryText = rules.length > 0 ? texts.find((value) => rules[0][1].test(value)) : includeMechanics ? text : null;
	const specific = primaryText === null ? null : MECHANICS_HINT_RULES.find(([, pattern]) => pattern.test(primaryText));
	if ((matches.length > 0 || includeMechanics) && specific) matches.unshift(specific[0]);
	const topics = [...new Set([...(dimensionTopic === null ? [] : [dimensionTopic]), ...matches])];
	if (topics.length === 0) return null;
	return { topics, read: { tool: 'capabilities', arguments: { section: 'strategy', topic: topics[0] } }, advice: `strategy:${topics[0]}: mechanics and options.` };
}
