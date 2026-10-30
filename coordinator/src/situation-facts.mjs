// One compact line of the stable facts a player knows at a glance (F3, the HUD, their own inventory): where they are
// and what they carry. Pure and byte-stable, so an unchanged line is retained between events instead of re-sent.
// Health, food level, threats and Y are left out: the event already shows them prominently. So is the sky above
// (player.skyOpen), which flips as the player walks under cover and must not re-send the rest of this line.

const ARMOR_TIERS = ['leather', 'golden', 'chainmail', 'turtle', 'copper', 'iron', 'diamond', 'netherite'];
const TOOL_TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];
const ARMOR_PIECE = /^(?:minecraft:)?([a-z_]+?)_(helmet|chestplate|leggings|boots)$/;
const WORN_SLOTS = new Set(['head', 'chest', 'legs', 'feet']);
const PICKAXE = /^(?:minecraft:)?([a-z_]+?)_pickaxe$/;
// Every weapon kind the installed game has, in a fixed order; the line names what is carried, not which one to use.
const TIERED_WEAPONS = ['sword', 'axe', 'spear'];
const SINGLE_WEAPONS = ['mace', 'trident', 'bow', 'crossbow'];
const TIERED_WEAPON = new RegExp(`^(?:minecraft:)?([a-z_]+?)_(${TIERED_WEAPONS.join('|')})$`);
const DAY_TICKS = 24_000;

const bare = (id) => (typeof id === 'string' ? id.replace(/^minecraft:/, '') : null);
const rank = (tiers, tier) => tiers.indexOf(tier);

/** Coarse overworld phase, so the line changes four times a day rather than every wake. */
export function dayPhase(dayTime) {
	if (!Number.isFinite(dayTime)) return null;
	const tick = ((dayTime % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
	if (tick < 11_000) return 'day';
	if (tick < 13_000) return 'sunset soon';
	if (tick < 23_000) return 'night';
	return 'sunrise soon';
}

function highestTier(rows, pattern, kind) {
	let best = null;
	for (const row of rows) {
		const match = pattern.exec(row.itemId);
		if (match === null || (kind !== undefined && match[2] !== kind)) continue;
		if (best === null || rank(TOOL_TIERS, match[1]) > rank(TOOL_TIERS, best)) best = match[1];
	}
	return best;
}

function armorSummary(rows) {
	const worn = [], carried = [];
	let elytra = null;
	for (const row of rows) {
		// An elytra takes the chest slot but gives no protection, so it is named on its own.
		if (bare(row.itemId) === 'elytra') { elytra = WORN_SLOTS.has(row.slot) ? 'worn' : elytra ?? 'carried'; continue; }
		const match = ARMOR_PIECE.exec(row.itemId);
		if (match === null) continue;
		if (WORN_SLOTS.has(row.slot)) worn.push(match[1]);
		else for (let piece = 0; piece < Math.max(1, row.count ?? 1); piece++) carried.push(match[1]);
	}
	const parts = [];
	if (worn.length === 0 && carried.length === 0) parts.push('armor none');
	else {
		// Highest tier first, so the line reads the same whatever slot order the inventory arrives in.
		const tiers = (pieces) => [...new Set(pieces)].sort((left, right) => rank(ARMOR_TIERS, right) - rank(ARMOR_TIERS, left) || left.localeCompare(right)).join('+');
		const wornText = `worn ${worn.length}/4${worn.length === 0 ? '' : ` ${tiers(worn)}`}`;
		parts.push(carried.length === 0 ? `armor ${wornText}` : `armor ${wornText}, carried ${carried.length} ${tiers(carried)}`);
	}
	if (elytra !== null) parts.push(`elytra ${elytra}`);
	return parts;
}

function weaponSummary(rows) {
	const carries = (id) => rows.some((row) => bare(row.itemId) === id);
	// Kinds of one tier share it: "netherite sword+axe, iron spear, bow".
	const byTier = new Map();
	for (const kind of TIERED_WEAPONS) {
		const tier = highestTier(rows, TIERED_WEAPON, kind);
		if (tier !== null) byTier.set(tier, [...(byTier.get(tier) ?? []), kind]);
	}
	const weapons = [...[...byTier].map(([tier, kinds]) => `${tier} ${kinds.join('+')}`), ...SINGLE_WEAPONS.filter(carries)];
	return `weapon ${weapons.length === 0 ? 'none' : weapons.join(', ')}`;
}

// Carried nutrition in coarse bands (20 fills an empty bar): a glance at the hotbar, not a count. Exact stacks are in the
// inventory rows, and a band rarely changes per bite, so eating does not re-send this whole line.
const NUTRITION_BANDS = [200, 100, 50, 20];

/**
 * Food from the server's summary of the installed food components: every edible item counts, and foods with a harmful
 * or teleporting effect (or a suspicious stew's unknown one) are named, never silently dropped. No summary, no claim.
 */
function foodSummary(food) {
	if (food === null || typeof food !== 'object' || !Number.isFinite(food.items)) return null;
	if (food.items === 0) return 'food none';
	const risky = Array.isArray(food.risky) ? food.risky.filter((row) => typeof row?.itemId === 'string') : [];
	const riskyText = risky.length === 0 ? '' : ` (risky ${risky.map((row) => `${row.count} ${bare(row.itemId)}`).join(', ')})`;
	const band = NUTRITION_BANDS.find((floor) => food.nutrition >= floor);
	return `food ${band === undefined ? 'under 20' : `${band}+`} nutrition${riskyText}`;
}

// The 36 main slots (hotbar and grid) that take pickups; the held hotbar slot is reported as "mainhand".
const MAIN_SLOTS = 36;
const MAX_ROOM_NAMES = 4;

/**
 * What a glance at a full grid shows: no empty slot, and which carried stacks could still take more of their item.
 * Nothing while a main slot is empty, so the line stays unchanged through ordinary play.
 */
function capacitySummary(rows, retainedItems) {
	const main = rows.filter((row) => row.slot === 'mainhand' || (Number.isInteger(row.slot) && row.slot >= 0 && row.slot < MAIN_SLOTS));
	if (main.length < MAIN_SLOTS) return null;
	// Vanilla also merges a pickup into a matching offhand stack.
	const room = [...new Set([...main, ...rows.filter((row) => row.slot === 'offhand')]
		.filter((row) => Number.isFinite(row.maxStackSize) && Number.isFinite(row.count) && row.count < row.maxStackSize)
		.map((row) => bare(row.itemId)))].sort();
	if (room.length === 0) return 'inventory full, no room';
	const complete = `inventory full, room for ${room.join(', ')}`;
	if (!Array.isArray(retainedItems)) return complete;
	// A shortened name is recoverable only from a retained row that proves stack headroom.
	const visibleRoom = new Set(retainedItems.filter((row) =>
		(row.slot === 'mainhand' || row.slot === 'offhand' || (Number.isInteger(row.slot) && row.slot >= 0 && row.slot < MAIN_SLOTS))
		&& typeof row.itemId === 'string' && Number.isFinite(row.count) && Number.isFinite(row.maxStackSize) && row.count < row.maxStackSize)
		.map((row) => bare(row.itemId)));
	const shown = room.filter((name, index) => index < MAX_ROOM_NAMES || !visibleRoom.has(name));
	const omitted = room.length - shown.length;
	const compact = `inventory full, room for ${shown.join(', ')}${omitted > 0 ? ` +${omitted} more` : ''}`;
	return compact.length < complete.length ? compact : complete;
}

/** The situation line for an adapted observation, or null when the body is not observable. */
export function situationFacts(observation, retainedItems = null) {
	const world = observation?.world;
	const player = observation?.player;
	if (typeof world?.dimension !== 'string' || player === null || typeof player !== 'object' || player.dead === true) return null;
	const rows = (Array.isArray(observation.inventory?.items) ? observation.inventory.items : [])
		.filter((row) => typeof row?.itemId === 'string');
	const dimension = bare(world.dimension);
	const parts = [world.dimension === 'minecraft:overworld' ? dimension : `${dimension}, no day cycle`];
	if (world.reducedDebugInfo !== true && typeof world.biome === 'string') parts.push(`biome ${bare(world.biome)}`);
	parts.push(...armorSummary(rows), weaponSummary(rows));
	const pickaxe = highestTier(rows, PICKAXE);
	parts.push(`pickaxe ${pickaxe ?? 'none'}`);
	const food = foodSummary(observation.inventory?.food);
	if (food !== null) parts.push(food);
	const capacity = capacitySummary(rows, retainedItems);
	if (capacity !== null) parts.push(capacity);
	return parts.join('; ');
}
