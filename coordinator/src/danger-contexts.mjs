// Dangerous contexts a player sets up for on entry (dusk on the surface, a respawn, lava nearby, a Nether or End arrival,
// a fortress, low health with hostiles near), the dangers each holds, and which of the model's own armed reflexes senses
// each danger. Facts only: nothing here arms, picks or ranks a rule; the model writes every rule.
// Recorded deaths, Oct 20-22: 37% came within 4.5 s of the first damage, faster than a ~6 s danger reply, so survival
// rests on rules armed before the danger; 43 deaths had none armed where one was expressible, 83 had lost an earlier one.

import { dayPhase } from './situation-facts.mjs';

const bare = (id) => (typeof id === 'string' ? id.replace(/^minecraft:/, '') : '');
const DAY_TICKS = 24_000;

/**
 * Danger kinds. `senses` are reflex condition types that react to it whatever their mob/projectile filter (a filter, when
 * present, must name one of the danger's mobs or projectiles); `filtered` count only with such a filter.
 * `actions` are the reflex actions a player-speed answer to it could use.
 */
export const DANGERS = Object.freeze({
	melee: { label: 'melee hits', senses: ['target_in_reach', 'hostile_near', 'attacked_from_behind'], filtered: ['exposed'], actions: ['attack', 'step_back', 'shield', 'take_cover', 'sprint_away'] },
	creeper: { label: 'creeper blast', senses: ['creeper_fusing'], filtered: ['hostile_near', 'exposed'], actions: ['sprint_away', 'take_cover'], mobs: ['creeper'] },
	ranged: { label: 'arrows and shots', senses: ['incoming_projectile', 'exposed'], filtered: ['hostile_near'], actions: ['shield', 'take_cover'], projectiles: ['arrow', 'spectral_arrow', 'potion', 'trident'] },
	fireballs: { label: 'fireballs', senses: ['fireball_incoming', 'incoming_projectile'], filtered: ['hostile_near', 'exposed'], actions: ['deflect', 'shield', 'sprint_away', 'take_cover'], projectiles: ['fireball', 'small_fireball', 'dragon_fireball'] },
	lava: { label: 'lava contact', senses: ['in_lava', 'lava_near', 'lava_flowing'], filtered: [], actions: ['leave_lava', 'place_block', 'step_back', 'stop'] },
	// Its own entry so an in_lava rule does not read as covering it: lava kills in about 2.5 s after contact, and only
	// lava_flowing fires before contact (d24: Sol armed in_lava alone at a pool and died to a flow it saw 3 s ahead).
	flow: { label: 'lava flow before contact', senses: ['lava_flowing'], filtered: [], actions: ['leave_lava', 'place_block'] },
	burning: { label: 'burning', senses: ['on_fire', 'in_fire'], filtered: [], actions: ['leave_fire', 'place'] },
	falls: { label: 'falls and knockback off edges', senses: ['falling', 'edge_near'], filtered: [], actions: ['place', 'sneak', 'step_back', 'away_from_edge'] },
	// 18 of the 2026-10-23 End deaths were bodies the dragon threw off towers, the arrival platform and island edges.
	throw: { label: 'dragon throws off edges', senses: ['dragon_charging'], filtered: [], actions: ['away_from_edge'], mobs: ['ender_dragon'] },
	enderman: { label: 'enderman', senses: ['enderman_gaze', 'enderman_provoked'], filtered: ['hostile_near', 'target_in_reach'], actions: ['look_away', 'shield', 'attack'], mobs: ['enderman'] },
	breath: { label: 'dragon breath', senses: ['cloud_near'], filtered: [], actions: ['sprint_away', 'move_to_cell'] },
	low_health: { label: 'low health', senses: ['health_below'], filtered: [], actions: ['sprint_away', 'take_cover', 'eat'] },
});

// Mob -> danger kind, for mobs actually present.
const MOB_DANGER = new Map([
	...['zombie', 'husk', 'drowned', 'zombie_villager', 'spider', 'cave_spider', 'vindicator', 'silverfish', 'slime', 'magma_cube', 'hoglin', 'zoglin', 'piglin', 'piglin_brute', 'zombified_piglin', 'wither_skeleton', 'endermite', 'ravager', 'warden'].map((mob) => [mob, 'melee']),
	['creeper', 'creeper'],
	...['skeleton', 'stray', 'bogged', 'pillager', 'witch'].map((mob) => [mob, 'ranged']),
	...['blaze', 'ghast'].map((mob) => [mob, 'fireballs']),
	['enderman', 'enderman'],
	['ender_dragon', 'breath'],
]);

/** Contexts: label, the dangers they hold (kind plus the mobs that bring it), and the rule lifetime that matches them. */
export const CONTEXTS = Object.freeze({
	night: { label: 'night on the surface', dangers: [['melee', ['zombie', 'spider']], ['creeper', ['creeper']], ['ranged', ['skeleton']]], lasts: 'night' },
	respawn: { label: 'respawn', dangers: [], lasts: null },
	lava: { label: 'lava nearby', dangers: [['lava', []], ['flow', []], ['burning', []]], lasts: 'lava' },
	nether: { label: 'the Nether', dangers: [['fireballs', ['ghast']], ['lava', []], ['flow', []], ['burning', []], ['falls', []]], lasts: 'dimension' },
	fortress: { label: 'a Nether fortress', dangers: [['fireballs', ['blaze']], ['melee', ['wither_skeleton']], ['falls', []]], lasts: 'dimension' },
	end: { label: 'the End', dangers: [['enderman', ['enderman']], ['breath', ['ender_dragon']], ['throw', ['ender_dragon']], ['falls', []]], lasts: 'dimension' },
	low_health: { label: 'low health with hostiles near', dangers: [['low_health', []]], lasts: null },
});

const LAVA_NEAR_BLOCKS = 8;
const FORTRESS_MOB_BLOCKS = 24;
const HOSTILE_NEAR_BLOCKS = 12;
const PRESENT_MOB_BLOCKS = 16;
const LOW_HEALTH = 8;
// A context left and re-entered within this window is the same visit (lava flickers in and out of view while mining).
const REENTRY_MS = { lava: 180_000, fortress: 300_000, low_health: 60_000 };

function rowsOf(value) { return Array.isArray(value) ? value : []; }

/** Overworld time of day: night for mobs runs from dusk (12000) until sunrise burns them (about 23500). */
export function isNightTime(dayTime) {
	if (!Number.isFinite(dayTime)) return null;
	const tick = ((dayTime % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
	return tick >= 12_000 && tick < 23_500;
}

/** A block row's distance: as listed, else from the player's position to the block centre (adapted rows drop it). */
function blockDistance(row, player) {
	if (Number.isFinite(row?.distance)) return row.distance;
	if (![row?.x, row?.y, row?.z, player?.x, player?.y, player?.z].every(Number.isFinite)) return Infinity;
	return Math.hypot(row.x + 0.5 - player.x, row.y + 0.5 - player.y, row.z + 0.5 - player.z);
}

/** Whether lava is in contact, seen within a few blocks, or heard that close (pops and rumble through rock). */
export function lavaNear(observation, within = LAVA_NEAR_BLOCKS) {
	const player = observation?.player ?? {};
	if (player.inLava === true) return true;
	if (Number.isFinite(player.heardLava?.distance) && player.heardLava.distance <= within) return true;
	for (const row of [...rowsOf(observation?.blocks), ...rowsOf(observation?.landmarks)]) {
		if (row?.blockId === 'minecraft:lava' && blockDistance(row, player) <= within) return true;
	}
	return false;
}

/** Mobs present: [type without namespace, distance], from threats and hostile entity rows. */
function presentMobs(observation, within) {
	const mobs = new Map();
	const add = (type, distance, hostile) => {
		const id = bare(type);
		if (!id || !Number.isFinite(distance) || distance > within || hostile === false) return;
		if (!mobs.has(id) || mobs.get(id) > distance) mobs.set(id, distance);
	};
	for (const row of rowsOf(observation?.player?.threats)) add(row?.type, row?.distance, true);
	for (const row of rowsOf(observation?.entities)) if (row?.alive !== false) add(row?.type, row?.distance, row?.hostile === true || row?.targetingAgent === true);
	return mobs;
}

function healthLow(player) {
	if (!Number.isFinite(player?.health) || player.dead === true) return false;
	const max = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 20;
	return player.health <= Math.min(LOW_HEALTH, max * 0.4);
}

/** The contexts that hold now (respawn is an event, not a state, and is never listed here). */
export function activeContexts(observation) {
	const world = observation?.world ?? {}, player = observation?.player ?? {};
	const active = new Set();
	if (player.dead === true || observation?.ready === false || typeof world.dimension !== 'string') return active;
	const dimension = world.dimension;
	if (dimension === 'minecraft:overworld' && isNightTime(world.dayTime) && (player.skyOpen === true || Number.isFinite(observation?.position?.y ?? player.y) && (observation?.position?.y ?? player.y) >= 62)) active.add('night');
	if (lavaNear(observation)) active.add('lava');
	if (dimension === 'minecraft:the_nether') {
		active.add('nether');
		const mobs = presentMobs(observation, FORTRESS_MOB_BLOCKS);
		const bricks = rowsOf(observation?.blocks).some((row) => /nether_brick/.test(row?.blockId ?? '') && blockDistance(row, player) <= 12);
		const sighted = rowsOf(observation?.sighted?.structures).some((row) => /fortress/.test(row?.structure ?? '') && Number.isFinite(row.distance) && row.distance <= 48);
		if (mobs.has('blaze') || mobs.has('wither_skeleton') || bricks || sighted) active.add('fortress');
	}
	if (dimension === 'minecraft:the_end') active.add('end');
	if (healthLow(player) && presentMobs(observation, HOSTILE_NEAR_BLOCKS).size > 0) active.add('low_health');
	return active;
}

/** Danger instances ({kind, mobs}) of the given contexts plus the mobs present now, merged by kind. */
export function currentDangers(observation, contexts = activeContexts(observation)) {
	const byKind = new Map();
	const add = (kind, mobs) => {
		const entry = byKind.get(kind) ?? { kind, mobs: new Set() };
		for (const mob of mobs) entry.mobs.add(mob);
		byKind.set(kind, entry);
	};
	for (const context of contexts) for (const [kind, mobs] of CONTEXTS[context]?.dangers ?? []) add(kind, mobs);
	for (const [mob] of presentMobs(observation, PRESENT_MOB_BLOCKS)) {
		const kind = MOB_DANGER.get(mob);
		if (kind !== undefined) add(kind, [mob]);
	}
	// Hostiles in reach at low health: a fall-back rule on health is the one a player keeps for that.
	if (contexts.has('low_health')) add('low_health', []);
	return [...byKind.values()].map(({ kind, mobs }) => ({ kind, mobs: [...mobs].sort() }));
}

function filterMatches(condition, danger) {
	const spec = DANGERS[danger.kind];
	const mobs = rowsOf(condition.mobs).map(bare);
	const projectiles = rowsOf(condition.projectiles).map(bare);
	if (mobs.length > 0) return [...danger.mobs, ...(spec.mobs ?? [])].some((mob) => mobs.includes(mob));
	if (projectiles.length > 0) return (spec.projectiles ?? []).some((id) => projectiles.includes(id));
	return null;
}

/** The id of an armed rule that senses this danger, or null. */
export function coveringRule(danger, rules) {
	const spec = DANGERS[danger.kind];
	if (spec === undefined) return null;
	for (const rule of rowsOf(rules)) {
		if (['disabled', 'pending', 'expired', 'yielded'].includes(rule?.state) || rule?.lacks) continue;
		for (const condition of rowsOf(Array.isArray(rule?.when) ? rule.when : [rule?.when])) {
			if (condition == null || condition.not === true) continue;
			const filter = filterMatches(condition, danger);
			if (spec.senses.includes(condition.type) && filter !== false) return rule.id;
			if (spec.filtered.includes(condition.type) && filter === true) return rule.id;
		}
	}
	return null;
}

function dangerName(danger) {
	const label = DANGERS[danger.kind].label;
	return danger.mobs.length === 0 || danger.kind === 'creeper' || danger.kind === 'enderman' ? label : `${label} (${danger.mobs.join(', ')})`;
}

/** {name: "rule <id>" | "no rule: senses -> actions"} for each danger. */
export function dangerCoverage(dangers, rules) {
	const rows = {};
	for (const danger of dangers) {
		const spec = DANGERS[danger.kind];
		const rule = coveringRule(danger, rules);
		rows[dangerName(danger)] = rule !== null ? `rule ${rule}` : `no rule: ${spec.senses.join('|')} -> ${spec.actions.join('|')}`;
	}
	return rows;
}

/** Current dangers no armed rule senses, as short names; empty when all are covered or none hold. */
export function uncoveredDangers(observation, rules) {
	return currentDangers(observation).filter((danger) => coveringRule(danger, rules) === null).map(dangerName);
}

/**
 * Per-agent entry edges. observe() runs on every live sample and returns contexts newly entered (owed until a wake that
 * carries them is delivered); line() builds the wake section from what is owed; settle() commits or keeps it.
 */
export class ContextEntryTracker {
	#active = new Set();
	#lastActiveAt = new Map();
	#nights = new Set();
	#dead = false;
	#seenLive = false;
	#owed = new Map();
	#inFlight = new Map();
	#sequence = 0;

	observe(observation, at = Date.now()) {
		const player = observation?.player ?? {};
		if (player.dead === true || observation?.death != null || observation?.status === 'PLAYER_DEAD') {
			this.#dead = true;
			this.#active = new Set();
			this.#owed.clear();
			return [];
		}
		if (observation?.ready === false || typeof observation?.world?.dimension !== 'string') return [];
		const entered = [];
		if (this.#dead && this.#seenLive) entered.push('respawn');
		// Contexts already holding on the first sample are owed to the next wake (a start or resume always wakes), not a wake of their own.
		const first = !this.#seenLive;
		this.#dead = false;
		this.#seenLive = true;
		const now = activeContexts(observation);
		for (const context of now) {
			const wasActive = this.#active.has(context);
			const last = this.#lastActiveAt.get(context);
			this.#lastActiveAt.set(context, at);
			if (wasActive) continue;
			if (context === 'night') {
				// One entry per night, however often the sky is lost and seen again.
				const night = Math.floor((observation.world.dayTime + 12_000) / DAY_TICKS);
				if (this.#nights.has(night)) continue;
				this.#nights.add(night);
			} else if (REENTRY_MS[context] !== undefined && Number.isFinite(last) && at - last < REENTRY_MS[context]) continue;
			entered.push(context);
		}
		// Lava passed or health recovered before the wake went out is no longer news; a night, an arrival or a respawn is.
		for (const context of [...this.#owed.keys()]) if (!now.has(context) && ['lava', 'low_health'].includes(context)) this.#owed.delete(context);
		this.#active = now;
		for (const context of entered) this.#owed.set(context, at);
		return first ? [] : entered;
	}

	/** Whether entries are owed (the caller makes sure a wake carries them). */
	owed() { return this.#owed.size > 0; }

	/** The wake section for owed entries: [{entered, dangers, lasts?}], or null. */
	line(observation, rules) {
		const token = ++this.#sequence;
		const contexts = [...this.#owed.keys()];
		this.#inFlight.set(token, contexts);
		if (contexts.length === 0) return { value: null, token };
		const active = activeContexts(observation);
		const value = [];
		for (const context of contexts) {
			const spec = CONTEXTS[context];
			// A respawn lists what the place holds now (time of day, mobs present), since the body starts over there.
			// Low health lists the mobs present too; other contexts list what they hold, mobs in view or not.
			const dangers = context === 'respawn' ? currentDangers(observation, active)
				: context === 'low_health' ? currentDangers(observation, new Set([context]))
				: currentDangers({ ...observation, player: { ...observation?.player, threats: [] }, entities: [] }, new Set([context]));
			if (dangers.length === 0) continue;
			value.push({ entered: spec.label, dangers: dangerCoverage(dangers, rules), ...(spec.lasts ? { lasts: spec.lasts } : {}) });
		}
		return { value: value.length === 0 ? null : value, token };
	}

	settle(token, delivered) {
		const contexts = this.#inFlight.get(token);
		if (contexts === undefined) return;
		this.#inFlight.delete(token);
		if (delivered) for (const context of contexts) this.#owed.delete(context);
	}
}

/** Coordinator-side rule lifetimes ({lasts}) a rule can be scoped to instead of only ttlS. */
export const RULE_LIFETIMES = Object.freeze(['night', 'dimension', 'lava']);
const LAVA_LEFT_MS = 60_000;

/** Lifetime state captured when a rule is armed. */
export function lifetimeStart(lasts, observation, at = Date.now()) {
	const world = observation?.world ?? {};
	return { lasts, dimension: typeof world.dimension === 'string' ? world.dimension : null, sawNight: isNightTime(world.dayTime) === true, sawLava: lavaNear(observation), lavaAt: lavaNear(observation) ? at : null };
}

/**
 * Advances a lifetime with a live sample. Returns the reason it ended ("dawn", "left the_nether", "away from lava"), or
 * null while it holds. Night ends at the first dawn after a night was seen (a rule armed by day lasts the coming night).
 */
export function lifetimeEnded(state, observation, at = Date.now()) {
	const world = observation?.world ?? {}, player = observation?.player ?? {};
	if (player.dead === true || observation?.ready === false || typeof world.dimension !== 'string') return null;
	if (state.lasts === 'dimension') {
		if (state.dimension === null) { state.dimension = world.dimension; return null; }
		return world.dimension !== state.dimension ? `left ${bare(state.dimension)}` : null;
	}
	if (state.lasts === 'night') {
		const night = isNightTime(world.dayTime);
		if (night === true) state.sawNight = true;
		return night === false && state.sawNight && dayPhase(world.dayTime) === 'day' ? 'dawn' : null;
	}
	if (state.lasts === 'lava') {
		if (lavaNear(observation, 12)) { state.sawLava = true; state.lavaAt = at; return null; }
		return state.sawLava && Number.isFinite(state.lavaAt) && at - state.lavaAt >= LAVA_LEFT_MS ? 'away from lava' : null;
	}
	return null;
}
