// One compact line of what materially changed since the last wake the model actually received, built only from facts
// a player sees (F3, the HUD, their own inventory, what is in view). It names changes and never suggests a response.
// The comparison is against the last delivered state, so a change that reverts between wakes is never reported and a
// failed delivery keeps its changes owed. The line adds no wakes: it rides on whichever wake comes next.

import { dayPhase } from './situation-facts.mjs';

/** Payload field that carries the line; other wake text may refer to it by this name. */
export const SITUATION_CHANGED_FIELD = 'changed';
/** Payload field naming a newly matching on-demand strategy topic. A bare id costs less than any wrapper or suffix. */
export const STRATEGY_POINTER_FIELD = 'strategy';

// A border biome flickering, or a roof edge walked in and out of, must not re-report every wake.
const REPEAT_COOLDOWN_MS = 60_000;
// About three hearts, or three food points: a drop a player notices on the HUD at once.
const LARGE_DROP = 6;
// Food thresholds from the game's own rules: healing from food needs 18+, sprinting needs more than 6. Both hold whatever
// the gamerules say: below 18 food never heals, so the line needs no hidden setting.
const HEALING_FOOD = 18;
const SPRINT_FOOD = 7;
const MAX_LOST_LISTED = 6;

const bare = (id) => (typeof id === 'string' ? id.replace(/^minecraft:/, '') : null);

// Ordered: the first family whose pattern matches wins, so snowy_beach is snowy and stony_peaks is mountains.
const BIOME_FAMILIES = [
	['caves', /caves|deep_dark/], ['ocean', /ocean/], ['river', /river/], ['mushroom', /mushroom/],
	['snowy', /snowy|frozen|ice_spikes|^grove$|jagged/], ['beach', /beach|shore/], ['badlands', /badlands/], ['desert', /desert/],
	['mountains', /peaks|slopes|windswept|stony/], ['jungle', /jungle|bamboo/], ['swamp', /swamp/], ['savanna', /savanna/],
	['taiga', /taiga/], ['dark_forest', /^dark_forest$/], ['forest', /forest|cherry|birch/], ['plains', /plains|meadow|sunflower/],
	['end', /^end_|the_end|small_end_islands|the_void/],
];

function biomeFamily(dimension, biome) {
	const id = bare(biome);
	if (id === null) return null;
	// Every Nether biome differs in hazards and mobs, so each is its own family.
	if (dimension === 'minecraft:the_nether') return id;
	return BIOME_FAMILIES.find(([, pattern]) => pattern.test(id))?.[0] ?? id;
}

function durableCounts(observation) {
	const counts = new Map();
	for (const row of Array.isArray(observation?.inventory?.items) ? observation.inventory.items : []) {
		if (typeof row?.itemId !== 'string' || !(row.maxDamage > 0)) continue;
		counts.set(row.itemId, (counts.get(row.itemId) ?? 0) + Math.max(1, row.count ?? 1));
	}
	return counts;
}

function nightSide(dayTime) {
	const phase = dayPhase(dayTime);
	return phase === null ? null : phase === 'night';
}

/** The facts compared between wakes, or null when the body is not observable (dead, not ready). */
export function situationSnapshot(observation) {
	const world = observation?.world, player = observation?.player;
	if (typeof world?.dimension !== 'string' || player === null || typeof player !== 'object' || player.dead === true || observation.ready === false) return null;
	// Only what the HUD and screen show: the sky's phase only under open sky (no clock), the biome only where F3 shows it,
	// and hearts rounded up the way the HUD draws them.
	const skyVisible = world.dimension === 'minecraft:overworld' && player.skyOpen === true;
	const biome = typeof world.biome === 'string' && world.reducedDebugInfo !== true ? world.biome : null;
	const hearts = (value) => (Number.isFinite(value) ? Math.ceil(value) : null);
	const health = hearts(player.health);
	return {
		dimension: world.dimension,
		biome,
		biomeFamily: biomeFamily(world.dimension, biome),
		// null where the sky is not in view: unknown, not changed.
		night: skyVisible ? nightSide(world.dayTime) : null,
		health,
		absorption: hearts(player.absorption) ?? 0,
		food: Number.isFinite(player.foodLevel) ? player.foodLevel : null,
		// Losing food-based healing changes nothing at full health; damage wakes carry the healing facts themselves.
		hurt: health !== null && hearts(player.maxHealth) !== null && health < hearts(player.maxHealth),
		// Creative and spectator players are not limited by hunger; the game mode is on screen.
		foodSprints: !['creative', 'spectator'].includes(player.gameMode),
		underWater: player.underWater === true,
		lava: player.inLava === true,
		// The column above the head is roofed or open, as the player sees looking up; absent where there is no sky (Nether).
		skyOpen: typeof player.skyOpen === 'boolean' ? player.skyOpen : null,
		gear: durableCounts(observation),
		structures: new Set((Array.isArray(observation.sighted?.structures) ? observation.sighted.structures : [])
			.map((row) => row?.structure).filter((kind) => typeof kind === 'string')),
	};
}

// "diamond helmet+chestplate+sword, shield": pieces sharing a material share one name.
function itemList(ids) {
	const groups = new Map();
	for (const id of ids.map(bare)) {
		const match = /^([a-z]+)_([a-z_]+)$/.exec(id);
		const [material, piece] = match !== null && /^(?:wooden|stone|iron|golden|diamond|netherite|leather|chainmail|copper|turtle)$/.test(match[1]) ? [match[1], match[2]] : [id, null];
		groups.set(material, [...(groups.get(material) ?? []), ...(piece === null ? [] : [piece])]);
	}
	const named = [...groups].map(([material, pieces]) => pieces.length === 0 ? material : `${material} ${pieces.join('+')}`);
	return named.length <= MAX_LOST_LISTED ? named.join(', ') : `${named.slice(0, MAX_LOST_LISTED).join(', ')} +${named.length - MAX_LOST_LISTED} more`;
}

/**
 * Changes between two snapshots, in a fixed order. Each names what it makes untrue (held items, healing, sprinting,
 * dimension) only where observed facts and game rules establish it, never what to do about it. died marks a
 * death since the baseline, which explains a full health bar and an empty inventory. hpReported, healingReported and
 * lavaReported skip what the wake reports itself.
 */
export function situationChanges(before, after, { died = false, hpReported = false, healingReported = false, lavaReported = false, uncoveredReported = false } = {}) {
	const changes = [];
	const add = (kind, text) => changes.push({ kind, text });
	const lost = [...before.gear.keys()].filter((id) => !after.gear.has(id)).sort();
	// After a death the wake's recovery facts list every lost stack, so the line only names what the loss breaks.
	const moved = before.dimension !== after.dimension;
	// A respawn in another dimension is one fact: where the body now is.
	if (died) add('death', `respawned${moved ? ` in ${bare(after.dimension)}` : ''}${lost.length === 0 ? ' after death' : ' without pre-death gear: steps needing it are unmet'}`);
	if (moved && !died) add('dimension', `dimension ${bare(before.dimension)}->${bare(after.dimension)}`);
	else if (!moved && before.biomeFamily !== null && after.biomeFamily !== null && before.biomeFamily !== after.biomeFamily) add('biome', `biome ${bare(before.biome)}->${bare(after.biome)}`);
	if (before.night !== null && after.night !== null && before.night !== after.night) {
		// The observed turn only: which mobs spawn depends on difficulty, gamerules, light and spawn rules this line does not see.
		add('time', after.night ? 'night began' : 'dawn');
	}
	if (lost.length > 0 && !died) add('gear', `lost ${itemList(lost)}: steps needing ${lost.length === 1 ? 'it' : 'them'} are unmet`);
	// Hearts plus absorption hearts, as drawn; absorption is named only when it changed.
	if (!died && !hpReported && before.health !== null && after.health !== null && before.health + before.absorption - after.health - after.absorption >= LARGE_DROP) {
		add('health', `health ${before.health}->${after.health}${before.absorption === after.absorption ? '' : `, absorption ${before.absorption}->${after.absorption}`}`);
	}
	if (!died && before.food !== null && after.food !== null) {
		// A threshold crossed is news at any size of drop; a large drop is news even between thresholds.
		const lostAbilities = [...(!healingReported && after.hurt && before.food >= HEALING_FOOD && after.food < HEALING_FOOD ? ['food-based healing'] : []),
			...(after.foodSprints && before.food >= SPRINT_FOOD && after.food < SPRINT_FOOD ? ['sprinting'] : [])];
		if (lostAbilities.length > 0 || before.food - after.food >= LARGE_DROP) {
			// The level is the news for a threshold; the fall is the news for a large drop.
			const level = before.food - after.food >= LARGE_DROP ? `${before.food}->${after.food}` : `${after.food}`;
			add('food', `food ${level}${lostAbilities.length === 0 ? '' : `: no ${lostAbilities.join(' or ')}`}`);
		}
	}
	if (after.lava && !before.lava && !lavaReported) add('lava', 'in lava');
	// Observed transitions only: air use and light depend on effects and blocks this line does not see.
	if (after.underWater && !before.underWater) add('water', 'under water');
	if (after.skyOpen === false && before.skyOpen === true) add('cover', 'no open sky above');
	// Current dangers (context or mobs present) that no armed reflex senses, named when that set changes.
	if (!uncoveredReported && typeof after.uncovered === 'string' && after.uncovered.length > 0 && after.uncovered !== before.uncovered) add('uncovered', `no armed rule for ${after.uncovered}`);
	return changes;
}

// Fields that a change kind compares; a held kind keeps its old values so it is still reported once its cooldown ends.
const KIND_FIELDS = { uncovered: ['uncovered'], biome: ['biome', 'biomeFamily'], time: ['night'], health: ['health', 'absorption'], food: ['food'], lava: ['lava'], water: ['underWater'], cover: ['skyOpen'] };

/**
 * Per-agent tracker. line() describes the wake being built; settle(token, true) after delivery makes that wake's state
 * the baseline. A wake built while an earlier one is still in flight compares with the in-flight state, so a turn and
 * the steers that follow it report each change once. Nothing commits for an undelivered wake.
 */
export class SituationChangeTracker {
	#committed = { token: 0, baseline: null, seen: new Set(), pointed: new Set(), lastReported: new Map() };
	#inFlight = new Map();
	#sequence = 0;
	#deathToken = 0;

	/**
	 * Returns { text, strategy, token } for this wake; text is null when nothing material changed. strategyTopic is the
	 * on-demand topic matching what is in view; strategy repeats it only the first time, since a topic is read once.
	 */
	line(observation, { at = Date.now(), event = null, trigger = null, hpReported = false, healingReported = false, lavaReported = false, strategyTopic = null, uncovered = null, uncoveredReported = false } = {}) {
		const token = ++this.#sequence;
		const reference = [...this.#inFlight.values()].at(-1) ?? this.#committed;
		// A death is a fact once seen, whether or not the wake showing the body reaches the model.
		if (event === 'player_death' || observation?.player?.dead === true || trigger === 'respawn' && reference.baseline !== null) this.#deathToken = token;
		const current = situationSnapshot(observation);
		if (current === null) return { text: null, strategy: null, token };
		current.uncovered = Array.isArray(uncovered) ? uncovered.join(', ') : '';
		const firstStructures = [...current.structures].filter((kind) => !reference.seen.has(kind)).sort();
		const seen = new Set([...reference.seen, ...firstStructures]);
		const topic = typeof strategyTopic === 'string' && strategyTopic.length > 0 && !reference.pointed.has(strategyTopic) ? strategyTopic : null;
		const pointed = topic === null ? reference.pointed : new Set([...reference.pointed, topic]);
		if (reference.baseline === null) {
			// A first view has nothing to compare with; what is already in sight is not "first sight" news.
			this.#inFlight.set(token, { token, baseline: current, seen, pointed, lastReported: reference.lastReported });
			return { text: null, strategy: topic, token };
		}
		// Reported once: by the first live wake built after the death, unless that wake is never delivered.
		const died = this.#deathToken > reference.token;
		const changes = situationChanges(reference.baseline, current, { died, hpReported, healingReported, lavaReported, uncoveredReported });
		// Death, dimension, lost gear and the day-night turn are always news; other kinds wait out a short cooldown and stay owed.
		const lastReported = new Map(reference.lastReported);
		const baseline = { ...current };
		// A sky or biome out of view is unknown now, not changed: keep what the model last read until it is seen again.
		for (const field of ['night', 'biome', 'biomeFamily']) if (current[field] === null) baseline[field] = reference.baseline[field];
		const parts = [];
		for (const { kind, text } of changes) {
			if (!['death', 'dimension', 'gear', 'time'].includes(kind) && at - (lastReported.get(kind) ?? Number.NEGATIVE_INFINITY) < REPEAT_COOLDOWN_MS) {
				for (const field of KIND_FIELDS[kind] ?? []) baseline[field] = reference.baseline[field];
				continue;
			}
			lastReported.set(kind, at);
			parts.push(text);
		}
		if (firstStructures.length > 0) parts.push(`first sight: ${firstStructures.join(', ')}`);
		this.#inFlight.set(token, { token, baseline, seen, pointed, lastReported });
		return { text: parts.length === 0 ? null : parts.join('; '), strategy: topic, token };
	}

	settle(token, delivered) {
		const entry = this.#inFlight.get(token);
		if (entry === undefined) return;
		this.#inFlight.delete(token);
		if (!delivered || token < this.#committed.token) return;
		// Older in-flight wakes are superseded by this delivery; newer ones were built on it and stay.
		for (const older of this.#inFlight.keys()) if (older < token) this.#inFlight.delete(older);
		this.#committed = entry;
	}
}
