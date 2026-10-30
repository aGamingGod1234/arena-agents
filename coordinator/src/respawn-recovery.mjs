/**
 * What a player knows after a death about getting the dropped items back: whether the death destroyed them (the void,
 * lava), how long they last, and the way back through a portal when the death was in another dimension. Facts from
 * the death screen, the remembered portal crossing and the current sample only; the model decides whether to go.
 *
 * Oct 23 2026, 108 Sol games: after 35 End deaths the body respawned at a bed by the stronghold and never re-entered
 * the End for its kit (the wake said only "death is in another dimension; route distance unknown"); Nether deaths
 * respawned beside the portal and the kit, gold helmet included, stayed behind.
 */
import { headingOf } from './search-coverage.mjs';

const MIN_Y = { 'minecraft:overworld': -64, 'minecraft:the_nether': 0, 'minecraft:the_end': 0 };
const DIMENSION_NAMES = { 'minecraft:overworld': 'the Overworld', 'minecraft:the_nether': 'the Nether', 'minecraft:the_end': 'the End' };
// Vanilla: every End portal entry places the player on the obsidian platform the game rebuilds at 100,49,0.
export const END_ARRIVAL = Object.freeze({ x: 100, y: 49, z: 0 });
export const DROP_LIFETIME_SECONDS = 300;
const GEAR = /_(pickaxe|axe|sword|shovel|helmet|chestplate|leggings|boots)$|^minecraft:(shield|bow|crossbow|bucket|water_bucket|lava_bucket|flint_and_steel|ender_pearl|ender_eye|blaze_rod|blaze_powder|totem_of_undying|elytra|trident|golden_apple|enchanted_golden_apple)$/;

const cell = (p) => `@${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const flat = (a, b) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));
const finite = (p) => [p?.x, p?.y, p?.z].every(Number.isFinite);
export const dimensionName = (id) => DIMENSION_NAMES[id] ?? id;

/** 'void' or 'lava' when the death itself destroyed the drops (vanilla death messages), else null. */
export function dropLoss(death) {
	const cause = typeof death?.cause === 'string' ? death.cause : '';
	if (/fell out of the world|didn't want to live in the same world as/.test(cause)) return 'void';
	if (Number.isFinite(death?.y) && Number.isFinite(MIN_Y[death?.dimensionId]) && death.y < MIN_Y[death.dimensionId]) return 'void';
	if (/tried to swim in lava/.test(cause)) return 'lava';
	return null;
}

/** The death message without the player's name (vanilla messages begin with it). */
export function deathCause(death) {
	const cause = typeof death?.cause === 'string' ? death.cause.trim() : '';
	return cause.replace(/^\S+ (was )?/, '') || 'unknown cause';
}

/** The nearest seen portal block of this id in the sample, with its flat distance from the player. */
export function portalInView(observation, blockId) {
	const at = observation?.position ?? observation?.player;
	if (!finite(at) || observation?.continuity?.rememberedSections?.includes('blocks')) return null;
	const rows = (Array.isArray(observation?.blocks) ? observation.blocks : []).filter((b) => b?.blockId === blockId && finite(b));
	const best = rows.map((b) => ({ ...b, distance: Math.round(Math.hypot(b.x + 0.5 - at.x, b.y - at.y, b.z + 0.5 - at.z)) })).sort((a, b) => a.distance - b.distance)[0];
	return best ?? null;
}

/**
 * The way back to drops left in another dimension, or null when the death is in this one or the way is not known
 * at all. `observation` is the current live sample; `death.portal` the remembered crossing into the death dimension.
 */
export function recoveryRoute(death, observation) {
	const here = observation?.world?.dimension, at = observation?.position ?? observation?.player;
	if (!death || !finite(death) || !finite(at) || typeof death.dimensionId !== 'string' || death.dimensionId === here || here !== 'minecraft:overworld') return null;
	const crossing = death.portal?.from?.dimension === here && finite(death.portal.from) ? death.portal : null;
	if (death.dimensionId === 'minecraft:the_end') {
		const seen = portalInView(observation, 'minecraft:end_portal');
		const portal = seen ? `End portal in view ${seen.distance} blocks away ${cell(seen)}`
			: crossing ? `you entered through the End portal ${cell(crossing.from)}, ${flat(crossing.from, at)} blocks from you` : 'no End portal location remembered';
		return `Way back: ${portal}; jumping in, with any inventory or none, puts you on the obsidian platform at 100,49,0, ${flat(END_ARRIVAL, death)} blocks from the drops. The platform is usually 20-30 blocks of void from the island; without blocks or a pearl, it is a dead end over the void.`;
	}
	if (death.dimensionId === 'minecraft:the_nether') {
		const seen = portalInView(observation, 'minecraft:nether_portal');
		const near = seen ?? (crossing ? { ...crossing.from, distance: flat(crossing.from, at) } : null);
		const portal = seen ? `Nether portal in view ${seen.distance} blocks away ${cell(seen)}`
			: crossing ? `the portal you entered by ${cell(crossing.from)}, ${near.distance} blocks from you` : 'no Overworld Nether portal remembered';
		const to = crossing?.to?.dimension === death.dimensionId && finite(crossing.to) ? crossing.to : null;
		const side = to ? `; it led to ${cell(to)} in the Nether, ${flat(to, death)} blocks from the drops`
			: near ? `; it links to the Nether portal nearest ${Math.floor(near.x / 8)},${Math.floor(near.z / 8)} (1/8 of its x,z), about ${flat({ x: near.x / 8, z: near.z / 8 }, death)} blocks from the drops` : '';
		return `Way back: ${portal}${side}.`;
	}
	return null;
}

/** Drop time left as a player would track it: 5 minutes of ageing, only while someone is within simulation distance. */
export function dropClockText(clock) {
	if (!clock || !Number.isFinite(clock.tickedSeconds)) return 'drops last 5 min while a player is near them';
	const left = Math.max(0, DROP_LIFETIME_SECONDS - clock.tickedSeconds);
	if (left === 0) return 'their 5 min are up: despawned unless picked up';
	const range = Number.isSafeInteger(clock.simulationDistance) ? ` (within ${clock.simulationDistance * 16} blocks)` : '';
	return `${left < 60 ? 'under 1' : `~${Math.floor(left / 60)}`} of 5 min left; they age only while you are near them${range}${clock.tickingNow ? ', ageing now' : ', paused now'}`;
}

const TIER = { netherite: 6, diamond: 5, iron: 4, golden: 4, chainmail: 3, copper: 3, stone: 2, leather: 1, wooden: 1 };
const value = (id) => !GEAR.test(id) ? 0 : TIER[id.replace(/^minecraft:/, '').split('_')[0]] ?? 3;

/** Lost stacks, the most valuable gear first (gold armour ranks with iron: it keeps piglins calm), as `id xN` text. */
export function lostItemsText(rows, limit = 8) {
	const items = (Array.isArray(rows) ? rows : []).filter((row) => typeof row?.itemId === 'string' && row.count > 0);
	const sorted = items.map((row, index) => ({ row, index })).sort((a, b) => value(b.row.itemId) - value(a.row.itemId) || a.index - b.index).map(({ row }) => row);
	const text = sorted.slice(0, limit).map(({ itemId, count }) => `${itemId.replace(/^minecraft:/, '')}${count > 1 ? ` x${count}` : ''}`).join(', ');
	return `${text}${sorted.length > limit ? ` +${sorted.length - limit} more` : ''}`;
}

/**
 * The respawn wake's lead sentence: where the drops of the death just suffered wait, how long, and the way back; or that
 * the death destroyed them. Null without a recent death record with lost items, or once its drop time is spent.
 */
export function respawnLead(recovery, observation, { now = observation?.observedAtEpochMs } = {}) {
	const death = recovery?.lastDeath, at = observation?.position ?? observation?.player;
	const rows = Array.isArray(recovery?.lastLostInventory) ? recovery.lastLostInventory : [];
	if (!death || !finite(death) || !finite(at) || typeof death.dimensionId !== 'string' || rows.length === 0) return null;
	// Wall time alone cannot expire drops in an unloaded dimension.
	const clock = recovery.dropTicking ?? null;
	if (clock && clock.tickedSeconds >= DROP_LIFETIME_SECONDS) return null;
	const here = observation?.world?.dimension;
	const where = death.dimensionId !== here ? `in ${dimensionName(death.dimensionId)} ${cell(death)}`
		: `${flat(death, at)} blocks ${headingOf(death.x - at.x, death.z - at.z)}${Math.abs(death.y - at.y) >= 4 ? ` dy${death.y > at.y ? '+' : ''}${Math.round(death.y - at.y)}` : ''} ${cell(death)}`;
	const loss = dropLoss(death);
	const cause = deathCause(death);
	if (loss === 'void') return `Respawned. Everything carried fell into the void with you (${cause}) and is gone: nothing to recover.`;
	const items = lostItemsText(rows);
	const route = recoveryRoute(death, observation);
	if (loss === 'lava') return `Respawned. You died in lava ${where} (${cause}): drops that fell into it burned; any that landed beside it wait there (${dropClockText(clock)}). Carried then: ${items}.${route ? ` ${route}` : ''}`;
	return `Respawned. Your drops wait where you died ${where} (${cause}): ${items}; ${dropClockText(clock)}.${route ? ` ${route}` : ''}`;
}

/** Only held items, worn slots and remembered sightings; no terrain scan or autonomous recovery choice. */
export function recoveryPreparation(death, observation) {
 if (!finite(death) || typeof death.dimensionId !== 'string') return '';
 const parts = [], memory = observation?.routeMemory;
 const items = observation?.inventory?.items ?? [];
 const hasPick = items.some(i => i.count > 0 && i.itemId?.endsWith('_pickaxe'));
 const wornGold = items.some(i => i.count > 0 && ['head','chest','legs','feet'].includes(i.slot) && /^minecraft:golden_(helmet|chestplate|leggings|boots)$/.test(i.itemId));
 if (memory?.connected === true) parts.push(`Walked retrace route: ${memory.length} blocks, ${memory.waypoints} waypoints; hazards remembered: ${(memory.hazards ?? []).join(', ') || 'none recorded (terrain may have changed)'}. travelTo({x:${death.x},y:${death.y},z:${death.z},dimension:${JSON.stringify(death.dimensionId)},retrace:true}) follows remembered turns with travel safety; enter remembered portals and reissue after the dimension change.`);
 else if (memory) parts.push('No connected walked route to these drops is remembered from this respawn; straight-line distance is not route length.');
 const resources = memory?.seenResources ?? (observation?.continuity?.rememberedSections?.includes('blocks') ? [] : observation?.blocks ?? []).filter(b => finite(b) && /_(log|stem|wood|hyphae|planks)$|^minecraft:(crafting_table|chest|barrel)$/.test(b.blockId ?? '')).map(b => ({...b, dimension: observation.world?.dimension, kind: b.blockId.endsWith('_planks') ? 'planks' : /crafting_table/.test(b.blockId) ? 'crafting table' : /chest|barrel/.test(b.blockId) ? 'chest' : 'wood'})).slice(0,4);
 if (resources.length) parts.push(`Nearest remembered resources (last seen, availability unverified): ${resources.map(r => `${r.kind} ${r.blockId.replace('minecraft:','')} ${cell(r)} in ${dimensionName(r.dimension)}`).join('; ')}.`);
 else if (memory) parts.push('No wood, planks, crafting table or chest location remembered here.');
 if (!hasPick) parts.push('No pickaxe held. Reopening stone/deepslate tunnels needs a pickaxe; an open walked tunnel needs none. Basic tools: 3 logs -> 12 planks -> table + 4 sticks -> wooden pick -> 3 cobblestone -> stone pick. With adjacent logs and exposed stone, measured body time was 0.25 min to a wooden pick and 0.36 min total to a stone pick; travel and thinking are extra. An open route can be walked without a pick; bare-hand stone drops no cobblestone.');
 if ((death.dimensionId === 'minecraft:the_nether' || (memory?.portals ?? []).some(p => p.to === 'minecraft:the_nether')) && !wornGold) parts.push('Piglin territory on the return route: no gold armour worn. Ordinary piglins attack without a worn gold piece; the lost helmet cannot protect you before pickup. Brutes attack through gold. Gold mining or opening chests can anger piglins, including ones out of view.');
 if (death.dimensionId === 'minecraft:the_end') parts.push('End re-entry needs blocks or a pearl for the crossing and protection from knockback. A stronghold library can have oak planks for tools and blocks; bookshelves drop books, not wood. Use planks you have actually seen.');
 parts.push(`Recovery plan checks: tool:pickaxe:wooden+ or tool:pickaxe:stone+; near:${death.dimensionId}@${Math.floor(death.x)},${Math.floor(death.y)},${Math.floor(death.z)}*4 tracks distance to drops; has:<lost item id>*N confirms pickup.`);
 return parts.join(' ');
}
