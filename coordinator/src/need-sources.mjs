// For an open step's needs: the base resource each comes from, the remembered places that could supply it, and the
// vanilla ways to get it with typical yields. Facts only; the model weighs them and chooses where to go.
import { headingOf, notableBuilt, sightingKind } from './search-coverage.mjs';
import { TOOLS } from './plan-checks.mjs';
import { goldSourceFact, GOLD_SOURCE_BYTES } from './gold-source-facts.mjs';

export const OPTIONS_BYTES = 360;
// Nether access needs a frame and a light: room for both resources' sources and sightings.
export const NETHER_OPTIONS_BYTES = 900;
export const KNOWN_BYTES = 300;
// SightedFeatures counts a cave's air inside a 5x5x5 box around the seen opening, so 125 is the most a row can say.
const CAVE_BOX_AIR = 125;
const KNOWN_ROWS = 3;
// Mobs wander and despawn: a source mob seen more than 5 minutes (game ticks) ago is no longer offered.
const MOB_FRESH_TICKS = 6000;
const short = (id) => String(id).replace(/^#?minecraft:/, '');
// Vanilla 26.1 gameplay/piglin_bartering: weights out of 469 per ingot; pearls weight 10, 2-4 each, so ~15.6 ingots per pearl.
const BARTER_PEARL = '~15 gold ingots per pearl';
export const BARTER_ODDS = 'per ingot: ender pearls 2-4 at 2.1% (~15 ingots per pearl), fire resistance potion 1.7% + splash 1.7%, obsidian 8.5%, crying obsidian 1-3 8.5%, also string, quartz, fire charges, gravel, soul sand';
// Gold ore: iron pickaxe, raw gold smelts to an ingot; nether gold ore drops 2-6 nuggets with any pickaxe.
const GOLD_WAYS = 'Overworld gold ore (iron pickaxe, smelt raw gold; most near y-16, also exposed in badlands), Nether gold ore (any pickaxe; 2-6 nuggets each, 9 nuggets = 1 ingot; breaking it angers piglins within 16), bastion gold blocks (9 ingots) and chests, ruined portal chests';

/**
 * Base resources in the order checked: item ids (without namespace) that come from it, which sightings and remembered
 * blocks can supply it, and the vanilla ways to get it. Mining options describe depth and excavation cost.
 */
const RESOURCES = [
	{ name: 'iron', ids: /^(raw_iron|iron_[a-z_]+|deepslate_iron_ore|bucket|water_bucket|lava_bucket|shield|flint_and_steel|shears|compass|anvil|hopper|minecart|blast_furnace|smithing_table|iron_bars|chain|lantern|tripwire_hook)$/,
		sighting: (row, kind) => kind === 'vein' && /iron_ore$/.test(row.what) || kind === 'cave' || kind === 'village'
			|| kind === 'structure' && /^(shipwreck|ruined portal|mineshaft|pillager outpost|desert temple|minecraft:)/.test(row.what),
		blocks: /(^|:)(deepslate_)?iron_ore$|(^|:)raw_iron_block$/,
		ways: 'exposed ore (hills/cliffs, dry caves; stone+ pick, smelt raw iron); stone tunnel or staircase near y16 or above y140 in mountains (many blocks per vein: ~80 breaks, ~3 min; 25 empty breaks are normal); iron golem 3-5 ingots, village/shipwreck/mineshaft loot, ruined portal nuggets' },
	{ name: 'flint', ids: /^(flint|flint_and_steel)$/,
		sighting: () => false,
		blocks: /(^|:)gravel$/,
		ways: 'gravel (river and lake beds, beaches, patches in stone at every depth): ~1 flint per 10 broken, shovel fastest, re-placing and re-breaking retries; flint and steel = flint + iron ingot' },
	{ name: 'diamond', ids: /^(diamond|diamond_[a-z_]+|deepslate_diamond_ore|enchanting_table|jukebox)$/,
		sighting: (row, kind) => kind === 'vein' && /diamond_ore$/.test(row.what) || kind === 'cave' && row.y < 0 || kind === 'village'
			|| kind === 'structure' && /^(shipwreck|desert temple|mineshaft)/.test(row.what),
		blocks: /(^|:)(deepslate_)?diamond_ore$/,
		ways: 'exposed in deep caves (most common near y-59), village toolsmith/weaponsmith, desert temple, shipwreck treasure chests, mine ~y-59 (steady; many blocks per vein)' },
	{ name: 'obsidian', ids: /^(obsidian|nether_portal|ender_chest|beacon)$/,
		sighting: (row, kind) => kind === 'lava' || kind === 'portal' || kind === 'structure' && /^ruined portal/.test(row.what),
		blocks: /(^|:)obsidian$/,
		ways: 'water on a lava source makes 1 obsidian in place (frame 10); lava lies in caves (cave air below y-54 is lava, pools sit in caves higher up), rarely open to the sky; a staircase through rock sees only what it breaks; ruined portals; mining needs a diamond pick' },
	// Not interchangeable with obsidian: water on lava never makes it.
	{ name: 'crying_obsidian', ids: /^(crying_obsidian|respawn_anchor)$/,
		sighting: (row, kind) => kind === 'structure' && /^(ruined portal|bastion)/.test(row.what),
		blocks: /(^|:)crying_obsidian$/,
		ways: 'ruined portal frames and chests, bastion chests, piglin bartering with gold; mining it needs a diamond pickaxe' },
	{ name: 'ender_pearl', ids: /^(ender_pearl|ender_eye|end_crystal)$/,
		sighting: (row, kind) => kind === 'village' || kind === 'mob' && row.what === 'minecraft:enderman' || kind === 'structure' && /^bastion/.test(row.what),
		ways: `endermen (0-1 pearl each; common in warped forests, deserts at night), piglin barter (${BARTER_PEARL}), village clerics` },
	{ name: 'gold', ids: /^(gold_ingot|gold_nugget|raw_gold|gold_block|(deepslate_|nether_)?gold_ore|golden_(helmet|chestplate|leggings|boots))$/,
		sighting: (row, kind) => kind === 'vein' && /gold_ore$/.test(row.what) || kind === 'structure' && /^(bastion|ruined portal)/.test(row.what),
		blocks: /(^|:)((deepslate_|nether_)?gold_ore|gold_block|raw_gold_block)$/,
		ways: GOLD_WAYS },
	// A spawner seen from afar shows no mob; in the Nether only fortresses (blaze) and bastion treasure rooms (magma cube) have one.
	{ name: 'blaze_rod', ids: /^(blaze_rod|blaze_powder|brewing_stand|ender_eye)$/,
		sighting: (row, kind) => kind === 'structure' && /^nether fortress/.test(row.what) || kind === 'mob' && row.what === 'minecraft:blaze'
			|| kind === 'spawner' && (row.mob === 'minecraft:blaze' || row.mob === undefined && row.nether === true),
		ways: 'only from blazes (0-1 rod each, ~half) at fortress spawners (active within 16 blocks) and in fortress pieces' },
	{ name: 'coal', ids: /^(coal|charcoal|coal_ore|deepslate_coal_ore|coal_block|torch|soul_torch|campfire|fire_charge)$/,
		sighting: (row, kind) => kind === 'vein' && /coal_ore$/.test(row.what) || kind === 'cave',
		blocks: /(^|:)(deepslate_)?coal_ore$/,
		ways: 'exposed coal ore on cliffs and in caves (common y0-128), smelt logs for charcoal, mine (many blocks per vein)' },
	{ name: 'logs', ids: /^(logs|planks|[a-z_]+_(log|wood|planks|stem|hyphae)|stick|crafting_table|chest|barrel|[a-z_]+_boat|wooden_[a-z_]+|bowl|ladder)$/,
		sighting: (row, kind) => kind === 'village',
		blocks: /(^|:)[a-z_]+_(log|stem)$/,
		ways: 'trees (typically 4-7 logs each), village houses' },
	{ name: 'cobblestone', ids: /^(cobblestone|cobbled_deepslate|stone|stone_[a-z_]+|cobblestone_[a-z_]+|furnace)$/,
		sighting: () => false,
		ways: 'stone under the soil, in hillsides and cave walls; any pickaxe mines it as cobblestone' },
	{ name: 'food', ids: /^(bread|cooked_[a-z_]+|beef|porkchop|chicken|mutton|rabbit|cod|salmon|apple|carrot|potato|baked_potato|wheat|golden_carrot|sweet_berries|melon_slice|pumpkin_pie|cookie)$/,
		sighting: (row, kind) => kind === 'village',
		blocks: /(^|:)hay_block$/,
		ways: 'animals (1-3 meat each), village crops, hay bales and chests, fishing' },
];

/** Every block pattern a resource or the known line can be remembered by, for prefiltering remembered blocks. */
export const SOURCE_BLOCKS = new RegExp([...RESOURCES.filter((resource) => resource.blocks).map((resource) => resource.blocks.source), '(^|:)[a-z_]+_ore$', '(^|:)ancient_debris$', '(^|:)(water|lava)$'].join('|'));

// Words a step or intent uses for a resource, beside the item ids the resource table already knows.
const WORDS = Object.freeze({ iron: ['iron'], diamond: ['diamond'], obsidian: ['obsidian'], portal: ['obsidian'], pearl: ['ender_pearl'], ender: ['ender_pearl'],
	eye: ['ender_pearl', 'blaze_rod'], blaze: ['blaze_rod'], fortress: ['blaze_rod'], gold: ['gold'], golden: ['gold'], coal: ['coal'], torch: ['coal'], flint: ['flint'], gravel: ['flint'], wood: ['logs'], log: ['logs'], tree: ['logs'],
	plank: ['logs'], stone: ['cobblestone'], food: ['food'], meat: ['food'], bread: ['food'] });

// A clause names a resource as something to acquire only beside one of these verbs, and not when a negation comes before
// its verb or within three words before the resource.
const ACQUIRE = /^(need|needs|needed|get|gets|getting|mine|mines|mining|collect|collecting|craft|crafting|make|making|smelt|smelting|gather|gathering|obtain|find|harvest|chop|dig|digging|prepare|preparing|loot|trade|barter|kill|hunt|farm|fill|equip)$/;
const NEGATION = /^(not|no|never|without|avoid|avoiding|skip|ignore|stop|don|dont|won|cannot|can)$/;

/**
 * Base resources free text (a step's label and detail, an intent) asks to acquire, in order: a resource word in a clause
 * with an acquisition verb, unless a negation precedes that verb or the word ("avoid iron golems", "do not mine any more
 * iron" and "inspect server logs" name none). Namespaced ids ("minecraft:iron_ingot") stay whole.
 */
export function textResources(text) {
	const names = [];
	// A colon ends a clause only when it is not inside a namespaced id.
	for (const clause of String(text ?? '').toLowerCase().replace(/\b[a-z0-9_.-]+:(?=[a-z0-9_])/g, '').split(/[.;:!?,]+|\bthen\b/)) {
		const words = clause.split(/[^a-z_]+/).filter(Boolean);
		const verb = words.findIndex((word) => ACQUIRE.test(word));
		if (verb < 0 || words.slice(0, verb).some((word) => NEGATION.test(word))) continue;
		words.forEach((word, index) => {
			if (word.length < 3 || words.slice(Math.max(0, index - 3), index).some((before) => NEGATION.test(before))) return;
			const forms = [word, word.replace(/s$/, ''), word.replace(/es$/, '')];
			const found = forms.map((form) => WORDS[form]).find(Boolean) ?? [RESOURCES.find((row) => forms.some((form) => row.ids.test(form)))?.name].filter(Boolean);
			for (const name of found) if (!names.includes(name)) names.push(name);
		});
	}
	return names;
}

// Explicit progression intent: an action on the game, the dragon, a dimension, a stronghold or tiered gear. A bare place
// phrase ("at the end of the bridge") is not one.
const PROGRESSION = [
	/\b(beat|finish|complete|win)\b[^.;]*\b(game|minecraft)\b/,
	/\b(kill|defeat|slay|fight|beat)\b[^.;]*\b(ender ?dragon|the dragon)\b/,
	/\b(enter|reach|go to|get to|travel to|visit|open|build|light|find|make)\b[^.;]*\b(the nether|nether|the end dimension|the end|end portal|nether portal)\b/,
	/\b(find|locate|reach)\b[^.;]*\bstronghold\b/,
	/\b(get|make|craft|obtain|wear|full)\b[^.;]*\b(diamond|iron|netherite)\b[^.;]*\b(gear|armou?r|tools?|pickaxe|sword|axe)\b/,
	/\bspeed ?run\b/,
];

/** Whether a goal states progression through the game, where the next pickaxe tier is always on the way. */
export function progressionGoal(goal) {
	const text = String(goal ?? '').toLowerCase();
	return PROGRESSION.some((pattern) => pattern.test(text));
}

/** The best pickaxe held and the material of the next tier, as a fact; null past diamond. */
export function pickaxeTier(items) {
	let best = -1;
	for (const item of items ?? []) {
		const match = /^minecraft:([a-z]+)_pickaxe$/.exec(item?.itemId ?? '');
		if (match && item.count > 0) best = Math.max(best, TOOLS.indexOf(match[1]));
	}
	const tier = best < 0 ? null : TOOLS[best];
	const next = tier === null ? 'logs' : ['wooden', 'golden'].includes(tier) ? 'cobblestone' : ['stone', 'copper'].includes(tier) ? 'iron' : tier === 'iron' ? 'diamond' : null;
	return next === null ? null : { basis: `best pickaxe ${tier ?? 'none'}`, resources: [next] };
}

/**
 * Items the requirement chain text (howtoChain) still has to acquire: short entries ("id have/need way") that are not a
 * recipe waiting on its own inputs ("<-", or alternative recipes in brackets), ready to process ("ready") or held inputs
 * waiting on a station ("@station").
 * Alternatives ("a|b") stay together.
 */
export function chainLeaves(chainKey) {
	const text = String(chainKey);
	const entries = [...text.matchAll(/([#a-z0-9_|]+) (\d+)\/(\d+)/g)];
	return entries.flatMap((entry, index) => {
		if (Number(entry[2]) >= Number(entry[3])) return [];
		const way = text.slice(entry.index + entry[0].length, entries[index + 1]?.index ?? text.length).split(/, |\)| \+ /)[0];
		return way.startsWith('<-') || /\bready\b/.test(way) || /^ ?[@(]/.test(way) ? [] : [entry[1]];
	});
}

/**
 * Base resources still to acquire, in order. With a requirement chain only its acquisition leaves count, so held
 * ingredients ready to smelt or craft need no source; without one, the needed item ids. Unknown ids add nothing.
 */
export function needResources(ids, chainKey = null) {
	const items = chainKey === null ? ids.map(short) : chainLeaves(chainKey);
	const names = [];
	for (const item of items) {
		// Of alternatives ("flint_and_steel|fire_charge"), the first one a resource yields.
		const resource = item.split('|').map((id) => id.replace(/^#/, '')).map((id) => RESOURCES.find((row) => row.ids.test(id))).find(Boolean);
		if (resource && !names.includes(resource.name)) names.push(resource.name);
		if (chainKey === null) for (const row of RESOURCES) if (row.ids.test(item) && !names.includes(row.name)) names.push(row.name);
	}
	return names;
}

/**
 * Villages from remembered points of interest, per 64-block area: a bell, or at least two kinds of villager point of
 * interest (beds count as one kind). Points the agent placed itself are not evidence. A named village structure row is
 * already a sighting of its own.
 */
function villages(sightings, placed) {
	// A bed fills two cells and the row may name either: a placed bed beside a bed row on the same level counts as it.
	const bed = (id) => /_bed$/.test(id ?? '');
	const own = (row) => placed.some((p) => p.y === row.y && (p.x === row.x && p.z === row.z
		|| bed(row.what) && bed(p.blockId ?? p.itemId) && Math.abs(p.x - row.x) + Math.abs(p.z - row.z) === 1));
	const areas = new Map();
	for (const row of sightings) {
		if (sightingKind(row) !== 'poi' || own(row)) continue;
		const key = `${Math.floor(row.x / 64)},${Math.floor(row.z / 64)}`;
		if (!areas.has(key)) areas.set(key, []);
		areas.get(key).push(row);
	}
	return [...areas.values()].flatMap((rows) => {
		const bell = rows.find((row) => row.what === 'minecraft:bell');
		const kinds = new Set(rows.map((row) => /_bed$/.test(row.what) ? 'bed' : row.what));
		if (!bell && kinds.size < 2) return [];
		const at = bell ?? rows[0];
		return [{ what: 'village', kind: 'village', via: bell ? 'bell' : `${kinds.size} poi`, x: at.x, y: at.y, z: at.z }];
	});
}

/** One remembered source as text: what, how much when known, horizontal distance, 8-point heading and depth. */
function sourceText(row, position, blocks = []) {
	const distance = Math.round(Math.hypot(row.x - position.x, row.z - position.z));
	const dy = Math.round(row.y - position.y);
	const where = `${distance}m${distance < 1 ? '' : ` ${headingOf(row.x - position.x, row.z - position.z)}`}${Math.abs(dy) >= 4 ? ` dy${dy > 0 ? '+' : ''}${dy}` : ''}`;
	const depth = ` y${Math.round(row.y)}`;
	const coordinates = ` @${row.x},${row.y},${row.z}`;
	// Positive remembered sightings only: nearby water proves neither flooding nor dry access. These
	// cells were already visible to the player; this performs no scan of the source's surroundings.
	const liquids = ['cave', 'vein', 'block'].includes(row.kind) ? ['water', 'lava'].filter(id => blocks.some(block => block.blockId === `minecraft:${id}`
		&& Math.hypot(block.x - row.x, block.y - row.y, block.z - row.z) <= 3)) : [];
	const nearby = liquids.length ? ` (${liquids.join('/')} seen nearby)` : '';
	switch (row.kind) {
		case 'vein': return `${short(row.what)} x${row.visible} seen ${where}${depth}${coordinates}${nearby}`;
		case 'block': return `${short(row.what)}${row.count > 1 ? ` x${row.count}` : ''} ${where}${depth}${coordinates}${nearby}`;
		case 'cave': return `cave${Number.isFinite(row.air) ? `(air ${row.air}/${CAVE_BOX_AIR})` : ''} ${where}${depth}${coordinates}${nearby}`;
		case 'built': return `built(${row.what.replace(/^built:/, '').split('+').map(short).join('+')}) size ${row.size} ${where}`;
		case 'lava': return `lava ${where}${depth}`;
		case 'village': return `village(${short(row.via)}) ${where}`;
		case 'portal': return `${short(row.what)} ${where}`;
		case 'spawner': return `spawner${row.mob ? `(${short(row.mob)})` : ''} ${where}${depth}${coordinates}`;
		case 'mob': return `${short(row.what)} ${where}${coordinates}`;
		default: return `${row.what === 'village' ? 'village' : row.what.includes(':') ? 'structure' : row.what} ${where}`;
	}
}

/**
 * Remembered sources of one resource: the resource itself seen first, then places that may hold it, each nearest first.
 * Sightings, then remembered blocks grouped per 8-block cell.
 */
function knownRows(resource, known, position, placed) {
	const sightings = known?.sightings ?? [];
	const rows = [...sightings, ...villages(sightings, placed)].flatMap((row) => {
		const kind = sightingKind(row);
		// A named village structure is a village too.
		const as = kind === 'structure' && row.what === 'village' ? 'village' : kind;
		if (as === 'mob' && Number.isFinite(known?.tick) && Number.isFinite(row.tick) && known.tick - row.tick > MOB_FRESH_TICKS) return [];
		return as !== 'poi' && resource.sighting(row, as) ? [{ ...row, kind }] : [];
	});
	if (resource.blocks) {
		const groups = new Map();
		for (const block of known?.blocks ?? []) {
			if (!resource.blocks.test(block.blockId)) continue;
			const key = `${block.blockId}@${Math.floor(block.x / 8)},${Math.floor(block.y / 8)},${Math.floor(block.z / 8)}`;
			const group = groups.get(key);
			if (group === undefined) groups.set(key, { kind: 'block', what: block.blockId, x: block.x, y: block.y, z: block.z, count: 1 });
			else group.count += 1;
		}
		// A vein sighting already names the same ore close by.
		for (const group of groups.values()) if (!rows.some((row) => row.kind === 'vein' && short(row.what) === short(group.what) && Math.hypot(row.x - group.x, row.y - group.y, row.z - group.z) <= 8)) rows.push(group);
	}
	// The resource itself seen (its ore vein or block, a source mob or spawner) comes before places that may hold it
	// (a spawner of unseen mob, then caves and structures).
	const direct = (row) => ['vein', 'block', 'mob'].includes(row.kind) || row.kind === 'spawner' && row.mob !== undefined ? 0 : row.kind === 'spawner' ? 1 : 2;
	const sorted = rows.map((row) => ({ row, distance: Math.hypot(row.x - position.x, row.y - position.y, row.z - position.z) }))
		.sort((left, right) => direct(left.row) - direct(right.row) || left.distance - right.distance);
	return distinctOpenings(sorted.map(({ row }) => row)).map(row => ({ direct: direct(row) === 0, text: sourceText(row, position, known?.blocks) }));
}

// Nearby samples must not crowd every other lead out of either short view. Presentation only: this asserts
// no connection between caves and leaves the full sightings in memory. Input order keeps the nearest sample.
function distinctOpenings(rows) {
	const shown = [];
	for (const row of rows) {
		if (row.kind !== 'cave' || !shown.some(other => other.kind === 'cave' && Math.hypot(row.x - other.x, row.y - other.y, row.z - other.z) < 8)) shown.push(row);
	}
	return shown;
}

// Obsidian estimates, in minutes from where the agent stands. Measured in recorded games unless marked vanilla.
const WALK_MPS = 4.3;
// dig_to, provider-free surface-to-y-55 runs (Oct 24, reports/dig-to-live-2026-10-24-r2.json): 262-526 s of digging for
// 118-134 levels (about 3.5 s per level with its own turns, drops and cave crossings) plus the model's turn at each of the
// 1-3 stops between calls (mostly a mob in sight), so ~8 min from y63 against ~11 min for the model-driven staircase.
const STAIR_MIN = 4 / 60;
// dig_to shaft (1x1 straight down with a water bucket, steep_down below y-20), the same kind of runs (Oct 24,
// reports/dig-descent-live-2026-10-24.json): 3-4.5 min of digging for 120-130 levels in 1-4 calls (1 s per level in the
// shaft, 2.7 s in steep_down below y-20) plus the model's turn at each stop.
const SHAFT_MIN = 2 / 60;
// d5-iron-h cast a 10-block frame at a y42 lava pool in ~13 min.
const CAST_MIN = 1.3;
// Diamond pick: water over a source, then a 9.4 s break (vanilla) and the pickup; mined obsidian is then placed.
const MINE_MIN = 0.5, FRAME_MIN = 2;
// Vanilla: crying obsidian in a frame cell breaks in ~42 s with an iron pick (no drop), 9.4 s with a diamond pick.
const CRYING_MIN = 0.7, CRYING_DIAMOND_MIN = 0.16;
const FLOOR_Y = -55;
// Vanilla: below y-54 cave air is lava, so the floors there are still sources.
const FLOOR_USABLE = 0.95;
// Those floors lie in caves. Watcher truth, 6 recorded descents to y-45 and below (d19-iron-a/b, d21-iron-a/b on Oct 22;
// q-kjq0vh, w-lap-seed-e random seeds on Oct 23): 2 had a 64-source pool in their observation 1.7 and 3.9 min after
// arriving, 4 climbed back after 0.8-15.8 min without one; 37 min down there for 2 pools is ~19 min per pool. Below y-45 a
// 10+ source pool lay within 32 blocks in every sampled moment (median 5 blocks), so the search is short but blind.
const FLOOR_MISS_MIN = 19;
const FLOOR_SEARCH = `search: 6 recorded descents, 2 saw a 64-source pool within 4 min, 4 climbed back after 1-16 min without one`;
// Above y-20 the same 26 recorded Overworld games (Oct 22-23) spent 1767 min and 1 pool of 10+ still sources came into
// their observation (a surface lake); caves up there hold small pools and lava falls.
const UPPER_MIN = 1767, UPPER_POOLS = 1, UPPER_Y = -20;
const DEEP_NOTE = 'below y-45 the recorded games had a 10+ source pool within 32 blocks at every moment (median 5), behind rock until a cave opening or heard lava shows its side';
const CAVE_ROWS = 2;
// 76 recorded games (Oct 20-21) saw 4 distinct underground lava places up close; 3 held 10+ still sources, 1 was a
// lava fall (only flowing lava).
const POOL_USABLE = 0.75;
// Small surface lava seen up close in the same games: 0 of 2 (a ruined portal's 1-2 sources, a lava fall's 1).
const SURFACE_USABLE = 0.2, SURFACE_Y = 56, LARGE_POOL = 8;
// The recorded ruined portal had 1-2 lava sources beside it and missed 5 of its 12 frame cells.
const PORTAL_SOURCES = 1, PORTAL_MISSING = 5;
// The same games walked 54 km on the surface (y55+) and sighted 1 large surface lava pool; vanilla generates ~1 surface
// lava lake per 200 chunks against ~1 underground per 9.
const SURFACE_LAKE_M = 54_000;
const FRAME_SITE_M = 24;

const minutes = (value) => Math.max(0, value);
const round = (value) => value < 1 ? '<1' : `${Math.round(value)}`;
/** Digging minutes from y down to the lava floors: a shaft with a water bucket held, else a staircase. */
const digFrom = (y, shaft = false) => minutes(y - FLOOR_Y) * (shaft ? SHAFT_MIN : STAIR_MIN);
/** The descent plus the recorded search down there before usable lava (none was met in the recorded descents). */
const floorFrom = (y, shaft = false) => digFrom(y, shaft) + FLOOR_MISS_MIN;
/** One lava bucket carried up from the floors and back, walking the staircase both ways. */
const tripFrom = (y) => 2 * minutes(y - FLOOR_Y) * Math.SQRT2 / WALK_MPS / 60;
const near = (a, b, horizontal, vertical) => Math.hypot(a.x - b.x, a.z - b.z) <= horizontal && Math.abs(a.y - b.y) <= vertical;
const isSource = (block) => block.blockId === 'minecraft:lava' && /"level":"0"/.test(block.blockState ?? '');
const isFlowing = (block) => block.blockId === 'minecraft:lava' && /"level":"[1-9]/.test(block.blockState ?? '');

/** Walking, or staircase digging for the part below, from the agent to a remembered place. */
function reach(position, row) {
	const horizontal = Math.hypot(row.x - position.x, row.z - position.z), dy = row.y - position.y;
	if (dy < -4) return -dy * STAIR_MIN + minutes(horizontal + dy) / WALK_MPS / 60;
	return (horizontal + minutes(dy)) / WALK_MPS / 60;
}

function where(position, row) {
	const distance = Math.round(Math.hypot(row.x - position.x, row.z - position.z));
	const dy = Math.round(row.y - position.y);
	return `${distance}m${distance < 1 ? '' : ` ${headingOf(row.x - position.x, row.z - position.z)}`}${Math.abs(dy) >= 4 ? ` dy${dy > 0 ? '+' : ''}${dy}` : ''}`;
}

/**
 * Every way to the obsidian a Nether frame still needs, each as expected minutes from the agent's situation, cheapest
 * first: digging to the lava floors, each remembered lava pool (weighted by the chance it holds enough still sources),
 * ruined portals and frames in view (missing cells, lava beside them), a lit portal, remembered obsidian with a diamond
 * pick, and an unseen surface lava lake. Facts for the model to weigh; nothing here chooses. frames: portalFrames rows.
 */
export function obsidianOptions({ position, known = null, placed = [], items = [], frames = [], needed = 10, cap = OPTIONS_BYTES } = {}) {
	const count = (pattern) => (items ?? []).reduce((sum, item) => sum + (pattern.test(item?.itemId ?? '') && item.count > 0 ? item.count : 0), 0);
	const heldObsidian = count(/^minecraft:obsidian$/), lavaBuckets = count(/^minecraft:lava_bucket$/);
	const diamond = count(/^minecraft:(diamond|netherite)_pickaxe$/) > 0;
	const water = count(/^minecraft:water_bucket$/) > 0;
	const casts = Math.max(0, needed - heldObsidian);
	const build = (n) => n <= 0 ? 0 : diamond ? n * MINE_MIN + FRAME_MIN : n * CAST_MIN;
	const buildText = (n) => n <= 0 ? 'frame' : diamond ? `mine ${n} ${round(build(n))}` : `${n} casts ${round(build(n))}`;
	const sightings = (known?.sightings ?? []).map((row) => ({ ...row, kind: sightingKind(row) }));
	const blocks = known?.blocks ?? [];
	const options = [];
	const add = (estimate, text) => options.push({ estimate, text });

	// Frames: ruined portals remembered and any frame in view, merged when they are the same place.
	const sites = sightings.filter((row) => row.kind === 'structure' && /^ruined portal/.test(row.what)).map((row) => ({ at: row, ruined: true, frame: null }));
	for (const frame of frames ?? []) {
		if (![frame?.x, frame?.y, frame?.z].every(Number.isFinite)) continue;
		if (frame.lit === true) { add(reach(position, frame), `lit portal in view ${where(position, frame)} ~${round(reach(position, frame))}`); continue; }
		const site = sites.find((other) => near(other.at, frame, 12, 12));
		if (site) site.frame = frame; else sites.push({ at: frame, ruined: false, frame });
	}
	for (const row of sightings) if (row.kind === 'portal' && /nether_portal$/.test(row.what)) add(reach(position, row), `lit portal ${where(position, row)} ~${round(reach(position, row))}`);
	const pools = sightings.filter((row) => row.kind === 'lava');
	const used = new Set();
	for (const site of sites) {
		const beside = pools.filter((row) => near(row, site.at, FRAME_SITE_M, 16));
		beside.forEach((row) => used.add(row));
		const seen = blocks.filter((block) => block.blockId === 'minecraft:lava' && (near(block, site.at, FRAME_SITE_M, 16) || beside.some((row) => near(block, row, 8, 8))));
		const checked = seen.some((block) => block.blockState !== undefined);
		const sources = checked ? seen.filter(isSource).length : beside.length ? PORTAL_SOURCES : 0;
		const frame = site.frame;
		const missing = frame ? Math.max(0, frame.needed - frame.obsidian) : PORTAL_MISSING;
		const crying = frame ? (frame.missing ?? []).filter((cell) => /crying_obsidian/.test(cell?.[3] ?? '')).length : 0;
		const inCell = frame ? (frame.missing ?? []).filter((cell) => /^lava source$/.test(cell?.[3] ?? '')).length : 0;
		const toCast = Math.max(0, missing - heldObsidian);
		const short = Math.max(0, toCast - lavaBuckets - sources - inCell);
		const walk = reach(position, site.at);
		const finish = walk + toCast * CAST_MIN + crying * (diamond ? CRYING_DIAMOND_MIN : CRYING_MIN) + (short > 0 ? floorFrom(site.at.y, water) + short * tripFrom(site.at.y) : 0);
		// Lava too far below: a fresh frame cast at the floors under it is the same trip without the carrying.
		const fresh = walk + floorFrom(site.at.y, water) + build(casts);
		const estimate = Math.min(finish, fresh);
		const name = site.ruined ? 'ruined portal' : 'frame in view';
		const state = frame ? `frame ${frame.obsidian}/${frame.needed}` : `frame unseen (~${PORTAL_MISSING} missing)`;
		const lava = `${checked || !beside.length ? `${sources + inCell} lava source${sources + inCell === 1 ? '' : 's'} beside` : `lava beside not seen up close (~${PORTAL_SOURCES} source assumed)`}${crying ? `, ${crying} crying obsidian to break` : ''}`;
		const rest = short > 0 ? (estimate === fresh ? `; new frame at y${FLOOR_Y} cheaper` : `; ${short} carried up from y${FLOOR_Y}`) : '';
		add(estimate, `${name} ${where(position, site.at)} ~${round(estimate)} (walk ${round(walk)}, ${state}, ${lava}${rest})`);
	}
	// Each remembered lava pool away from frames: its chance of holding enough still sources weighs the fallback dig.
	const sourcesNeeded = Math.max(0, casts - lavaBuckets);
	for (const row of pools) {
		if (used.has(row)) continue;
		const seen = blocks.filter((block) => block.blockId === 'minecraft:lava' && near(block, row, 8, 8));
		const still = seen.filter(isSource).length, flowing = seen.filter(isFlowing).length;
		// Far sight reports a pool past 24 blocks only with 8+ seen blocks, so a count that large is a lake.
		const usable = still >= sourcesNeeded ? 1 : row.y <= FLOOR_Y + 5 ? FLOOR_USABLE : still === 0 && flowing > 0 ? 0
			: row.y >= SURFACE_Y && !(row.count >= LARGE_POOL) ? SURFACE_USABLE : POOL_USABLE;
		const walk = reach(position, row);
		const estimate = walk + build(casts) + (1 - usable) * floorFrom(row.y, water);
		const evidence = still >= sourcesNeeded ? `${still} still sources seen` : still === 0 && flowing > 0 ? 'only flowing seen' : `usable ~${Math.round(usable * 100)}%${still ? `, ${still} still seen` : ''}`;
		add(estimate, `lava ${where(position, row)} y${Math.round(row.y)} ~${round(estimate)} (walk ${round(walk)}, ${buildText(casts)}; ${evidence})`);
	}
	// Remembered obsidian away from frames: only a diamond pick mines it.
	const groups = new Map();
	for (const block of blocks) {
		if (block.blockId !== 'minecraft:obsidian' || sites.some((site) => near(block, site.at, 16, 16)) || placed.some((p) => p.x === block.x && p.y === block.y && p.z === block.z)) continue;
		const key = `${Math.floor(block.x / 8)},${Math.floor(block.y / 8)},${Math.floor(block.z / 8)}`;
		const group = groups.get(key);
		if (group) group.count += 1; else groups.set(key, { ...block, count: 1 });
	}
	const unmined = [];
	for (const group of groups.values()) {
		if (!diamond) { unmined.push(`obsidian x${group.count} ${where(position, group)} (mining needs a diamond pick)`); continue; }
		const take = Math.min(group.count, casts), walk = reach(position, group);
		const estimate = walk + take * MINE_MIN + FRAME_MIN + (casts > take ? floorFrom(group.y, water) + (casts - take) * MINE_MIN : 0);
		add(estimate, `obsidian x${group.count} ${where(position, group)} ~${round(estimate)} (walk ${round(walk)}, mine ${take})`);
	}
	const y = Math.floor(position.y);
	if (y - FLOOR_Y <= 5) add(floorFrom(y, water) + build(casts), `lava-floor depth here ~${round(floorFrom(y, water) + build(casts))} (${FLOOR_SEARCH}; ${buildText(casts)})`);
	else add(floorFrom(y, water) + build(casts), `dig to the y${FLOOR_Y} lava floors ~${round(floorFrom(y, water) + build(casts))} (${y - FLOOR_Y}-level dig_to ${water ? 'shaft' : 'descent'} ${round(digFrom(y, water))} in a few calls, then a ${FLOOR_SEARCH}; ${buildText(casts)})`);
	// Above y-20 the measured search there replaces the walking estimate for a surface lake, which it includes.
	const surface = SURFACE_LAKE_M / WALK_MPS / 60;
	if (y > UPPER_Y) add(UPPER_MIN / UPPER_POOLS + build(casts), `search caves and surface above y${UPPER_Y} ~${round(UPPER_MIN / UPPER_POOLS + build(casts))} (26 recorded games spent ${UPPER_MIN} min up there and ${UPPER_POOLS} usable pool came into view; vanilla lakes 1 per 200 chunks surface, 1 per 9 underground)`);
	else add(surface + build(casts), `unseen surface lava lake ~${round(surface + build(casts))} (recorded games: 1 large surface pool per 54 km walked = ${round(surface)} min at ${WALK_MPS} m/s; vanilla lakes 1 per 200 chunks surface, 1 per 9 underground)`);
	options.sort((left, right) => left.estimate - right.estimate);

	const held = [heldObsidian ? `${heldObsidian} obsidian` : '', lavaBuckets ? `${lavaBuckets} lava bucket${lavaBuckets > 1 ? 's' : ''} (1 cast each anywhere)` : ''].filter(Boolean);
	const head = `obsidian: est. minutes to ${casts} more frame obsidian from here${held.length ? ` (held: ${held.join(', ')})` : ''}${!water && !diamond ? ' (no water bucket held; casting needs one, any water fills a bucket)' : ''}, cheapest first: `;
	// Caves seen: where lava is. The caves met in 12 measured descents (Oct 24) were mostly small; their look round showed lava within 16 blocks on 1.
	const caves = sightings.filter((row) => row.kind === 'cave' && [row.x, row.y, row.z].every(Number.isFinite))
		.sort((a, b) => Math.hypot(a.x - position.x, a.y - position.y, a.z - position.z) - Math.hypot(b.x - position.x, b.y - position.y, b.z - position.z)).slice(0, CAVE_ROWS);
	const caveNote = caves.length ? [`caves seen: ${caves.map((row) => `${where(position, row)} y${Math.round(row.y)}`).join(', ')} (lava pools sit in caves; dig_to's look round one names lava in sight)`] : [];
	const deep = y <= FLOOR_Y + 15 ? [DEEP_NOTE] : [];
	const notes = [...deep, ...caveNote, ...unmined, 'water on a lava source casts 1 obsidian in place', 'aquifer water met while digging refills the bucket',
		'usable = enough still sources (not flowing or filled)', 'staircase cobblestone crafts stone pickaxes'];
	// Every option stays listed: detail goes first, then whole notes, before any option is shortened.
	const brief = options.map((option) => option.text.replace(/ \([^()]*(\([^()]*\)[^()]*)*\)$/, ''));
	for (const body of [options.map((option) => option.text), options.map((option, index) => index === 0 ? option.text : brief[index]), brief]) {
		let text = `${head}${body.join('; ')}`;
		if (Buffer.byteLength(text) > cap) continue;
		for (const note of notes) if (Buffer.byteLength(`${text}; ${note}`) <= cap) text += `; ${note}`;
		return text;
	}
	return boundBytes(`${head}${brief.join('; ')}`, cap);
}

function resourceText(resource, known, position, placed, cap, context = {}) {
	if (resource.name === 'obsidian' && position !== null) return obsidianOptions({ position, known, placed, ...context, cap });
	if (resource.name === 'ender_pearl' && position !== null) return boundBytes(pearlOptions({ position, known, items: context.items, observation: context.observation, needed: context.pearls ?? 12 }), cap);
	const seen = position === null ? [] : knownRows(resource, known, position, placed);
	const ways = `; ways (typical): ${resource.ways}`;
	if (!seen.length) return `${resource.name}: seen none remembered${ways}`;
	let facts;
	for (let count = Math.min(KNOWN_ROWS, seen.length); count >= 1; count -= 1) {
		const rows = seen.slice(0, count);
		const direct = rows.filter(row => row.direct).map(row => row.text);
		const leads = rows.filter(row => !row.direct).map(row => row.text);
		facts = `${resource.name}: ${[...(direct.length ? [`seen ${direct.join(', ')}`] : []), ...(leads.length ? [`possible ${leads.join(', ')}`] : [])].join('; ')}`;
		if (Buffer.byteLength(facts) <= cap) break;
	}
	// Keep observed alternatives before generic methods: shortening the methods must not erase another source.
	return boundBytes(`${facts}${ways}`, cap);
}

/**
 * The options line for an open step's needs: per base resource still to acquire, remembered sources nearest first,
 * then typical vanilla ways. Resources after the first are added only while the whole line fits; the first is cut at
 * the cap, except that obsidian, whose options shorten without losing any, leaves room for the resources after it.
 * Null when nothing left to acquire maps to a known resource. placed: blocks the agent placed ({ x, y, z }); items and
 * frames (held inventory, portalFrames in view) feed the obsidian estimates; observation (dimension, time, entities in
 * view) and pearls (the count the step asks for) feed the pearl estimates.
 */
export function needOptions({ ids = [], chainKey = null, resources = null, basis = null, position = null, known = null, placed = [], items = [], frames = [], observation = null, pearls = null, cap = OPTIONS_BYTES } = {}) {
	const names = resources ?? needResources(ids, chainKey);
	if (names.length === 0) return null;
	// Pearl options price every source; the line makes room for them.
	if (names.includes('ender_pearl') && position !== null) cap = Math.max(cap, PEARL_OPTIONS_BYTES);
	// Where the resource came from when no checked step names it: the step's words or the pickaxe tier held.
	let line = basis === null ? '' : `(${basis}) `;
	const context = { items, frames, observation, pearls };
	const texts = names.map((name) => name === 'obsidian' ? null : resourceText(RESOURCES.find((row) => row.name === name), known, position, placed, cap, context));
	names.forEach((name, index) => {
		const resource = RESOURCES.find((row) => row.name === name);
		const first = line === '' || line.endsWith(') ');
		const room = cap - Buffer.byteLength(line) - (first ? 0 : 3);
		const reserve = name === 'obsidian' ? texts.slice(index + 1).reduce((sum, text) => sum + Buffer.byteLength(text) + 3, 0) : 0;
		const text = resourceText(resource, known, position, placed, Math.max(room - reserve, Math.floor(room / 2)), context);
		if (first) line = boundBytes(`${line}${text}`, cap);
		else if (Buffer.byteLength(text) <= room) line += ` | ${text}`;
	});
	return line;
}

const ORE_RANK = ['diamond', 'iron', 'gold', 'redstone', 'lapis', 'coal', 'emerald', 'copper'];
const oreRank = (id) => { const rank = ORE_RANK.findIndex((ore) => short(id).replace(/^deepslate_/, '').startsWith(ore)); return rank < 0 ? ORE_RANK.length : rank; };

/**
 * What memory holds that can supply something, whatever the plan: places (structures, villages, portals, built
 * clusters), exposed ore by priority (diamond, iron, gold, redstone, lapis, coal, then others), caves with their air
 * count, and lava, each nearest first with distance, heading and depth. Groups take turns within the byte cap. Null when
 * nothing is remembered. placed: blocks the agent placed, never evidence of a village.
 */
export function knownLine({ known = null, position = null, placed = [], cap = KNOWN_BYTES } = {}) {
	if (position === null || known === null) return null;
	const sightings = known.sightings ?? [];
	const distance = (row) => Math.hypot(row.x - position.x, row.y - position.y, row.z - position.z);
	const nearest = (rows) => rows.map((row) => ({ row, distance: distance(row) })).sort((left, right) => left.distance - right.distance).map(({ row }) => row);
	const byKind = (kinds) => sightings.flatMap((row) => { const kind = sightingKind(row); return kinds.includes(kind) && (kind !== 'built' || notableBuilt(row)) ? [{ ...row, kind }] : []; });
	const veins = byKind(['vein']);
	const blocks = new Map();
	for (const block of known.blocks ?? []) {
		if (!/(_ore|ancient_debris)$/.test(block.blockId)) continue;
		const key = `${block.blockId}@${Math.floor(block.x / 8)},${Math.floor(block.y / 8)},${Math.floor(block.z / 8)}`;
		const group = blocks.get(key);
		if (group === undefined) blocks.set(key, { kind: 'block', what: block.blockId, x: block.x, y: block.y, z: block.z, count: 1 });
		else group.count += 1;
	}
	const ores = [...veins, ...[...blocks.values()].filter((group) => !veins.some((row) => short(row.what) === short(group.what) && Math.hypot(row.x - group.x, row.y - group.y, row.z - group.z) <= 8))]
		.map((row) => ({ row, rank: oreRank(row.what), distance: distance(row) })).sort((left, right) => left.rank - right.rank || left.distance - right.distance).map(({ row }) => row);
	const groups = [['ores', ores], ['caves', distinctOpenings(nearest(byKind(['cave'])))], ['places', nearest([...byKind(['structure', 'portal', 'built', 'spawner']), ...villages(sightings, placed)])], ['lava', nearest(byKind(['lava']))]]
		.map(([label, rows]) => ({ label, texts: rows.map((row) => sourceText(row, position, known.blocks)), shown: [] }));
	const render = () => groups.filter((group) => group.shown.length).map((group) => `${group.label}: ${group.shown.join(', ')}`).join('; ');
	for (let rank = 0, added = true; added; rank += 1) {
		added = false;
		for (const group of groups) {
			if (rank >= group.texts.length || group.shown.length < rank) continue;
			group.shown.push(group.texts[rank]);
			if (Buffer.byteLength(render()) > cap) group.shown.pop(); else added = true;
		}
	}
	const line = render();
	return line.length ? line : null;
}

const FOOD = RESOURCES.find((row) => row.name === 'food').ids;
const WORN = new Set(['head', 'chest', 'legs', 'feet']);

/**
 * Before a first Nether entry, what the kit carries for it: edible food and worn armour, with the vanilla costs of
 * both. Null once the kit has 8 food and some armour, or without an inventory. Sol entered with neither and turned back.
 * Only once a portal is at hand (a seen lit frame, or held plus framed obsidian completes one): shown during the lava
 * search, Sol read it as a gate and climbed out of its staircases for food in every game. Plain facts without the
 * carried counts or crafting costs: "food 0 carried; armour 0/4 worn" read as a checklist and sent Sol away from a lit
 * portal to gather (drift-05).
 */
export function netherReadiness(observation) {
	const items = observation?.inventory?.items;
	if (!Array.isArray(items) || !portalAtHand(observation)) return null;
	const food = items.reduce((sum, item) => sum + (item?.count > 0 && item.itemId !== 'minecraft:wheat' && FOOD.test(short(item.itemId ?? '')) ? item.count : 0), 0);
	const worn = items.filter((item) => WORN.has(item?.slot) && /_(helmet|chestplate|leggings|boots)$/.test(item.itemId ?? '')).length;
	const gold = items.some((item) => WORN.has(item?.slot) && /^minecraft:golden_(helmet|chestplate|leggings|boots)$/.test(item.itemId ?? ''));
	if (food >= 8 && worn > 0 && gold) return null;
	return `Nether facts: no food there early except hoglins in crimson forests; each armour point cuts most damage 4%; a death there drops everything carried and respawns at the Overworld spawn or the last bed used there${gold ? '' : `; piglins attack a player wearing no gold armour piece | ${goldHelmetOption(items)}`}`;
}

/** Gold held as ingots, nuggets counted as ninths (rounded down). */
function goldIngots(items) {
	const count = (id) => items.reduce((sum, item) => sum + (item?.itemId === id && item.count > 0 ? item.count : 0), 0);
	return count('minecraft:gold_ingot') + Math.floor(count('minecraft:gold_nugget') / 9) + count('minecraft:gold_block') * 9;
}

/**
 * The golden helmet as a priced option, before or on entering the Nether: Sol died to piglins in every Nether test
 * without gold. Its cost, its sources and the gold already held; never a gate before the portal.
 */
export function goldHelmetOption(items) {
	const ingots = goldIngots(items);
	return `option golden helmet, before entering or soon after: 5 gold ingots${ingots >= 5 ? ` (${ingots} held: craft it at a crafting table, then equip it)` : ingots ? ` (${ingots} held)` : ''}, 2 armour like an iron helmet (swapping loses no protection, only durability); one worn gold piece keeps ordinary piglins neutral, brutes ignore it; gold: ${GOLD_WAYS}`;
}

// Pearl sources, vanilla 26.1 unless marked measured. Barter: weight 10 of 469 per ingot, 2-4 pearls (mean 3), ~15.6 ingots
// per pearl; test-barter-odds-live with a fresh loot salt per trial measured 190 pearls from 3350 ingots (~17.6 per pearl).
const BARTER_HIT = 10 / 469, PEARLS_PER_INGOT = BARTER_HIT * 3;
// test-barter-odds-live (2026-10-24): 6.0 game seconds per ingot with one piglin, 0.76 with eight bartering at once.
const BARTER_S = 6;
// minecraft:entities/enderman: 0-1 pearl (uniform), +0-1 per looting level; 18 from 40 salted kills measured.
const ENDER_DROP = 0.5;
// test-enderman-live (2026-10-24, iron sword): drawn by a look at its eyes, then fight_target pursue:false killed it in
// 5.5 s on open ground (3 of 3) and 8.4 s from a hillside tunnel (3 of 3), no damage taken; with walking up, ~0.5 min each.
const ENDER_FIGHT_MIN = 0.5;
// Existing options plus the new bounded sighting fact and its separator.
export const PEARL_OPTIONS_BYTES = 720 + GOLD_SOURCE_BYTES + 2;
const WARPED = /^minecraft:warped_(nylium|stem|wart_block|fungus|roots)$/;
const PIGLIN_SIGHT = 16;

/**
 * Every way to the pearls a step still needs, as expected pearls and minutes from the agent's situation: bartering the
 * gold held (and how much gold the rest takes), a bastion's gold, endermen in a warped forest or seen nearby, Overworld
 * endermen at night, and the tunnel that keeps an angry one from hitting. Facts for the model to weigh; it chooses.
 */
export function pearlOptions({ observation = null, position = null, known = null, items = [], needed = 12 } = {}) {
	const count = (pattern) => (items ?? []).reduce((sum, item) => sum + (pattern.test(item?.itemId ?? '') && item.count > 0 ? item.count : 0), 0);
	const held = count(/^minecraft:ender_pearl$/), eyes = count(/^minecraft:ender_eye$/);
	const more = Math.max(0, needed - held - eyes);
	const gold = goldIngots(items ?? []);
	const dimension = observation?.world?.dimension ?? null;
	const entities = (observation?.entities ?? []).filter((row) => row?.alive !== false);
	const piglins = entities.filter((row) => row.type === 'minecraft:piglin' && row.baby !== true && !row.targetingAgent && Number.isFinite(row.distance) && row.distance <= 48).length;
	const per = (ingots) => ingots * BARTER_S / Math.min(Math.max(piglins, 1), 8) / 60;
	const parts = [];
	const ingotsFor = Math.ceil(more / PEARLS_PER_INGOT);
	const seenGold = goldSourceFact(observation, known, position);
	if (seenGold) parts.push(seenGold);
	if (gold > 0) parts.push(`barter the ${gold} held gold: ~${(gold * PEARLS_PER_INGOT).toFixed(1)} pearls expected, ${Math.round((1 - BARTER_HIT) ** gold * 100)}% chance of none, ${round(per(gold)) === '<1' ? '<1' : `~${round(per(gold))}`} min${piglins ? ` with the ${piglins} calm piglin${piglins === 1 ? '' : 's'} in view` : ''} (${BARTER_S} s per ingot per piglin, several at once)`);
	parts.push(`${more} pearls by barter take ~${ingotsFor} gold (~${Math.ceil(ingotsFor / 9)} gold blocks)${gold ? '' : `; 10 gold gives none ${Math.round((1 - BARTER_HIT) ** 10 * 100)}% of the time`}`);
	const sightings = position === null ? [] : (known?.sightings ?? []).map((row) => ({ ...row, kind: sightingKind(row) }));
	const nearest = (rows) => rows.filter((row) => [row.x, row.y, row.z].every(Number.isFinite)).sort((a, b) => Math.hypot(a.x - position.x, a.z - position.z) - Math.hypot(b.x - position.x, b.z - position.z))[0] ?? null;
	const bastion = nearest(sightings.filter((row) => row.kind === 'structure' && /^bastion/.test(row.what ?? '')));
	if (bastion) parts.push(`bastion ${where(position, bastion)} @${bastion.x},${bastion.y},${bastion.z} (walk ${round(reach(position, bastion))} min): gold blocks 9 ingots each, breaking angers piglins within ${PIGLIN_SIGHT} even unseen; its chests hold gold too`);
	else if (dimension === 'minecraft:the_nether') parts.push('bastion not seen yet');
	const fresh = (row) => !Number.isFinite(known?.tick) || !Number.isFinite(row.tick) || known.tick - row.tick <= MOB_FRESH_TICKS;
	const enderman = nearest(sightings.filter((row) => row.kind === 'mob' && row.what === 'minecraft:enderman' && fresh(row)));
	const inView = entities.filter((row) => row.type === 'minecraft:enderman').length;
	const warpedHere = observation?.world?.biome === 'minecraft:warped_forest';
	const warped = warpedHere ? null : nearest((known?.blocks ?? []).filter((block) => WARPED.test(block.blockId)));
	const kill = ENDER_DROP > 0 ? (1 / ENDER_DROP) * ENDER_FIGHT_MIN : 0;
	const hunt = (lead) => `${lead}: 0-1 pearl per kill (~${ENDER_DROP} each), ~${round(kill)} min per pearl once one is near`;
	const leads = [warpedHere ? 'standing in a warped forest, where endermen are the usual mob' : warped ? `warped forest ${where(position, warped)} (walk ${round(reach(position, warped))} min), where endermen are the usual mob` : '',
		inView ? `${inView} enderm${inView === 1 ? 'an' : 'en'} in view` : enderman ? `enderman seen ${where(position, enderman)} @${enderman.x},${enderman.y},${enderman.z}` : ''].filter(Boolean);
	if (leads.length) parts.push(hunt(leads.join(', ')));
	else if (dimension === 'minecraft:the_nether') {
		if (parts.at(-1) === 'bastion not seen yet') parts.pop();
		parts.unshift('primary Nether pearl route: find a warped forest through visible exploration; mine seen ore and barter held gold as secondary supply');
	}
	const village = nearest([...sightings.filter((row) => row.kind === 'structure' && row.what === 'village'), ...villages(known?.sightings ?? [], [])]);
	if (village) parts.push(`village ${where(position, village)}: an expert-level cleric sells pearls for emeralds`);
	if (dimension === 'minecraft:overworld' && Number.isFinite(observation?.world?.dayTime)) {
		const tick = ((observation.world.dayTime % 24000) + 24000) % 24000;
		const night = tick >= 13000 && tick < 23000;
		parts.push(night ? 'night now: endermen spawn in the dark on open ground (about 1 in 50 night spawns), seen from afar standing tall' : `endermen spawn at night (in ~${round((13000 - tick + (tick >= 13000 ? 24000 : 0)) / 20 / 60)} min), about 1 in 50 night spawns`);
	}
	if (warpedHere || warped || inView || enderman || parts.some((part) => part.startsWith('night now'))) parts.push('enderman fight: 40 health, hits ~7 (~4 through full iron); iron sword 6 per hit (~7 hits); a 2-high gap or standing water is optional protection, not a prerequisite; a stare at its eyes provokes one; collect its pearl');
	// Put the model's primary route and enderman fight facts before secondary currency facts.
	if (inView || warpedHere || warped) {
		const lead = parts.findIndex((part) => part.includes(': 0-1 pearl per kill'));
		parts.unshift(...parts.splice(lead, 1), ...parts.splice(-1));
	}
	// Eyes for the End portal: 12 frames, each already filled 10% of the time (vanilla); 1 in 5 eyes thrown breaks.
	const why = needed >= 10 ? '; eyes: 1 per empty End portal frame of 12 (a frame starts filled 10% of the time), 1 in 5 thrown to find the stronghold breaks' : '';
	return boundBytes(`ender_pearl: ${more} more needed (pearls and eyes held ${held + eyes}/${needed}: ${held} pearls${eyes ? `, ${eyes} eyes` : ''}; ${gold} gold${why}), est. options: ${parts.join('; ')}`, PEARL_OPTIONS_BYTES);
}

// A hunt line names an enderman only this near: c3 forest games had one within 16 m for 13 min/h and started ~5 fights/h.
export const HUNT_RANGE = 16;
// Within 3 blocks up or down a player walks, jumps or steps the gap; beyond that the approach needs blocks or digging.
const HUNT_CLIMB = 3;

/**
 * The nearest enderman in view within HUNT_RANGE and HUNT_CLIMB blocks of the player's height (no path check), while pearls are still an open need:
 * distance, height, mood and the pearl count, so the model can weigh this fight against travel. Null otherwise.
 */
export function pearlHuntLine({ observation = null, position = null, open = '' } = {}) {
	if (position === null || !/\bender_(pearl|eye)\b|\b(ender )?pearls?\b|\beyes? of ender\b/i.test(open ?? '')) return null;
	const items = observation?.inventory?.items;
	if (!Array.isArray(items) || observation.continuity?.rememberedSections?.includes('inventory')) return null;
	const needed = pearlsWanted(open) ?? 12;
	const held = items.reduce((sum, item) => sum + (/^minecraft:ender_(pearl|eye)$/.test(item?.itemId ?? '') && item.count > 0 ? item.count : 0), 0);
	if (held >= needed) return null;
	const near = (observation.entities ?? []).filter((row) => row?.type === 'minecraft:enderman' && row.alive !== false && Number.isFinite(row.distance)
		&& row.distance <= HUNT_RANGE && Number.isFinite(row.y ?? row.position?.y)).sort((a, b) => a.distance - b.distance);
	// The wire sample nests the feet position; the adapted observation the coordinator keeps flattens it to x/y/z.
	const feet = (row) => row.y ?? row.position.y;
	const reachable = near.filter((row) => Math.abs(feet(row) - position.y) <= HUNT_CLIMB);
	const target = reachable[0];
	if (!target) return null;
	const dy = Math.round(feet(target) - position.y);
	const angry = target.targetingAgent === true || target.appearance?.screaming === true;
	const others = near.length - 1;
	// c3 123456789-2: the model let a running travel_to carry it past endermen 6-9 m away; the walk is part of the fact.
	const action = observation.currentAction?.active === true ? observation.currentAction.actionType : null;
	return `enderman ${Math.round(target.distance)} m, ${dy === 0 ? 'level' : dy > 0 ? `${dy} up` : `${-dy} down`}, ${angry ? 'angry at you' : 'calm'}`
		+ `${others > 0 ? `, ${others} more within ${HUNT_RANGE} m` : ''}; pearls ${held}/${needed} open`
		+ `${/^(travel_to|navigate_to)$/.test(action ?? '') ? `; your ${action} is still running and does not stop for it` : ''}`;
}

/** A pearl source to act on now: an enderman in view, or a calm adult piglin within 48 while gold is held. */
export function pearlSourceInView(observation) {
	const entities = (observation?.entities ?? []).filter((row) => row?.alive !== false);
	if (entities.some((row) => row.type === 'minecraft:enderman')) return true;
	return goldIngots(observation?.inventory?.items ?? []) > 0 && entities.some((row) => row.type === 'minecraft:piglin' && row.baby !== true && !row.targetingAgent && Number.isFinite(row.distance) && row.distance <= 48);
}

/** The pearl count a plan check or step text asks for (pearls or eyes), or null when it names none. */
export function pearlsWanted(text) {
	const value = String(text ?? '');
	const check = /ender_(?:pearl|eye)[a-z_:|#]*\*(\d+)/.exec(value), words = /\b(\d+) (?:ender )?(?:pearls|eyes of ender|ender eyes)\b/i.exec(value);
	return check ? Number(check[1]) : words ? Number(words[1]) : null;
}

const NETHER_NEEDS = /\b(ender_pearl|ender_eye|blaze_rod|blaze_powder|ender pearls?|pearls|blaze rods?|eyes? of ender)\b/i;

/**
 * In the Nether while rods or pearls are still to get: the bastion-first and fortress-first routes with their vanilla
 * payoff and risk, then what the player holds and has seen for each. The model chooses; this names no target.
 */
export function netherRouteOption({ observation = null, known = null, position = null, open = '' } = {}) {
	const items = observation?.inventory?.items;
	if (observation?.world?.dimension !== 'minecraft:the_nether' || !Array.isArray(items) || observation.continuity?.rememberedSections?.includes('inventory')
		|| !NETHER_NEEDS.test(open)) return null;
	const worn = items.some((item) => WORN.has(item?.slot) && /^minecraft:golden_(helmet|chestplate|leggings|boots)$/.test(item.itemId ?? ''));
	const fire = items.reduce((sum, item) => sum + (/^minecraft:(splash_|lingering_)?potion$/.test(item?.itemId ?? '') && /fire resistance/i.test(item.displayName ?? '') && item.count > 0 ? item.count : 0), 0);
	const seen = (pattern) => {
		const rows = position === null ? [] : (known?.sightings ?? []).filter((row) => sightingKind(row) === 'structure' && pattern.test(row.what ?? ''))
			.sort((a, b) => Math.hypot(a.x - position.x, a.z - position.z) - Math.hypot(b.x - position.x, b.z - position.z));
		return rows.length ? `seen ${where(position, rows[0])} @${rows[0].x},${rows[0].y},${rows[0].z}` : 'not seen yet';
	};
	return `Nether route, your choice: bastion first = barter gold with calm adult piglins (per ingot: 2.1% 2-4 ender pearls, ~15 ingots per pearl; 3.4% fire resistance potion; 8.5% obsidian; 8.5% crying obsidian); bastion gold blocks (9 ingots each) and chests fund it; risk: brutes attack even with gold worn, and breaking gold or opening chests near piglins angers them`
		+ ` | fortress first = blaze rods (their only source); risk: blaze fire, wither skeletons, lava; fire resistance (potion 3:00) makes fire, lava and blaze fireballs harmless`
		+ ` | now: gold armour ${worn ? 'worn' : 'not worn'}, ${goldIngots(items)} gold ingots, ${fire} fire resistance potions; bastion ${seen(/^bastion/)}; fortress ${seen(/fortress/)}`
		+ (worn ? '' : goldIngots(items) >= 5 ? ' | option golden helmet now: 5 of the held gold ingots at a crafting table, then equip it; 2 armour like iron, keeps ordinary piglins neutral; held gold alone does not'
			: ' | option golden helmet: 5 gold ingots, 2 armour like iron, keeps ordinary piglins neutral; Nether gold ore gives 2-6 nuggets with any pickaxe (9 = 1 ingot), mined where no piglin is within 16');
}

/** A Nether portal is at hand: a lit frame in view, or held plus framed obsidian completes one. */
export function portalAtHand(observation) {
	const items = observation?.inventory?.items;
	if (!Array.isArray(items)) return false;
	const obsidian = items.reduce((sum, item) => sum + (item?.itemId === 'minecraft:obsidian' && item.count > 0 ? item.count : 0), 0);
	const frame = Array.isArray(observation?.sighted?.portalFrames) ? observation.sighted.portalFrames[0] : null;
	const framed = Number.isFinite(frame?.obsidian) ? frame.obsidian : 0;
	const needed = Number.isFinite(frame?.needed) ? frame.needed : 10;
	return frame?.lit === true || obsidian + framed >= needed;
}

/**
 * The respawn option a prepared player weighs at the portal into the Nether or the End, with its vanilla price.
 * Every game on 2026-10-23 entered both with no bed and no wool, so each death there respawned at the world spawn,
 * far from the portal and the dropped kit. Facts and a priced option only; the model decides.
 */
export function bedSpawnOption(observation, target) {
	const items = observation?.inventory?.items;
	if (!Array.isArray(items) || observation?.world?.dimension !== 'minecraft:overworld') return null;
	const bed = items.some((item) => item?.count > 0 && /_bed$/.test(item.itemId ?? ''));
	const cost = bed ? 'the bed carried' : 'a bed (3 wool: shear or kill 3 sheep, + 3 planks)';
	return `option bed by the ${target} portal: ${cost} placed beside it and used (by day too) sets the Overworld respawn there; beds explode in the Nether and End; a death then respawns a short walk from the portal instead of the world spawn; dropped items lie ~5 min where you died and can be picked up unless lava, fire or the void destroyed them`;
}

/**
 * Before the trip down to the lava floors, while a bed is at hand (placed nearby, carried, or 3 wool held): where a death
 * down there would respawn. Sol held a bed in 6 of 10 random-seed games on 2026-10-23 and never used one; the one that
 * filled a lava bucket at y-55 died there and respawned at the world spawn with nothing. Null without bed materials, so
 * the fact never sends the player off to gather for it.
 */
export function descentRespawnFact({ position = null, placed = [], items = [] } = {}) {
	if (position === null || position.y <= 0) return null;
	const count = (pattern) => (items ?? []).reduce((sum, item) => sum + (item?.count > 0 && pattern.test(item.itemId ?? '') ? item.count : 0), 0);
	const bed = (placed ?? []).filter((p) => /_bed$/.test(p?.blockId ?? p?.itemId ?? '') && [p.x, p.z].every(Number.isFinite))
		.map((p) => ({ p, d: Math.hypot(p.x - position.x, p.z - position.z) })).sort((a, b) => a.d - b.d)[0];
	const how = bed && bed.d <= 48 ? `the bed placed ${Math.round(bed.d)}m away, used (by day too),`
		: count(/_bed$/) > 0 ? 'the bed carried, placed by the staircase top and used (by day too),'
			: count(/_wool$/) >= 3 ? 'a bed from the 3 wool held (+ 3 planks), placed by the staircase top and used,' : null;
	return how === null ? null : `trip down: ${how} sets the respawn there; otherwise a death at the floors respawns at the world spawn, and items dropped in lava burn`;
}

function boundBytes(text, cap) {
	if (Buffer.byteLength(text) <= cap) return text;
	let bounded = '';
	for (const character of text) {
		if (Buffer.byteLength(`${bounded}${character}...`) > cap) return `${bounded}...`;
		bounded += character;
	}
	return bounded;
}
