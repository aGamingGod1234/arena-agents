// One definition, shared by every fact store, of where a remembered fact came from, which evidence may change it, and
// which lifecycle changes end it. Stores keep their own data and bounds; they ask here instead of deciding again.
import { randomUUID } from 'node:crypto';
import { blockContradictionEvidence, observedBlocks } from './seen-resource-facts.mjs';

/**
 * Where a fact came from. seen: the player's own direct observation. did: the agent's own confirmed action receipt.
 * inferred: derived from other facts (a death's lost inventory from the last live one). told: written by a model or
 * another agent; only its author retires it.
 */
export const SOURCES = Object.freeze(['seen', 'did', 'inferred', 'told']);

/** A sample of a dead body: death, a dead phase, zero health or a dead status. Nothing in it describes a live body. */
export function deadSample(observation) {
	const player = currentSection(observation, 'player') ? observation?.player ?? {} : {};
	return player.dead === true || (Number.isFinite(player.health) && player.health <= 0) || observation?.continuity?.phase === 'dead' || observation?.status === 'PLAYER_DEAD';
}

// A remembered copy of a section describes an earlier body, not the current one.
function currentSection(observation, section) { return !observation?.continuity?.rememberedSections?.includes(section); }

/** A sample that says nothing about the body: the agent is not ready, or the sample is unready without being a corpse. */
export function unreadySample(observation) {
	return observation?.status === 'AGENT_NOT_READY' || (observation?.ready === false && !deadSample(observation));
}

/**
 * A sample showing a living body: not dead or unready, and with current body evidence, either vitals (alive flag or
 * positive health) or a ready sample placing the body. An empty player record is not a body.
 */
export function liveSample(observation) {
	if (deadSample(observation) || unreadySample(observation)) return false;
	const player = currentSection(observation, 'player') ? observation?.player : undefined;
	if (player !== null && typeof player === 'object' && (player.dead === false || (Number.isFinite(player.health) && player.health > 0))) return true;
	const position = currentSection(observation, 'position') ? observation?.position ?? player?.position ?? player : player?.position ?? player;
	return observation?.ready === true && [position?.x, position?.y, position?.z].every(Number.isFinite);
}

/** Whether the sample carries current evidence of the body, living or dead. Only such a sample may change lifecycle or plan state. */
export function bodySample(observation) { return !unreadySample(observation) && (deadSample(observation) || liveSample(observation)); }

/**
 * Whether the sample is a current observation of the agent: body evidence, or the server's own ready flag (the agent
 * is present in the world it names). Scope may follow it; a ready flag alone does not revive a corpse.
 */
export function currentSample(observation) { return !unreadySample(observation) && (observation?.ready === true || bodySample(observation)); }

/** When this evidence was observed: the row's own clocks, else the sample's. Compare with freshEvidence before it changes a fact. */
export function evidenceClock(row, observation) {
	const tick = observation?.world?.gameTime ?? observation?.worldTick;
	const lastSeenTick = Number.isFinite(row?.lastSeenTick) ? row.lastSeenTick : Number.isFinite(tick) ? tick : undefined;
	const observedAtEpochMs = Number.isFinite(row?.observedAtEpochMs) ? row.observedAtEpochMs : Number.isFinite(observation?.observedAtEpochMs) ? observation.observedAtEpochMs : undefined;
	return { ...(lastSeenTick === undefined ? {} : { lastSeenTick }), ...(observedAtEpochMs === undefined ? {} : { observedAtEpochMs }) };
}

/**
 * When a body sample says the body was in that state: the sample's clocks, and for death details no later than the
 * recorded death time. Body lifecycle facts are ordered by these clocks: a living sample older than the newest death
 * describes the previous body, and a death sample older than the newest living sample describes an earlier death.
 */
export function bodyClock(observation) {
	const clock = evidenceClock(null, observation);
	const diedAt = observation?.death?.diedAtEpochMs;
	if (Number.isFinite(diedAt) && !(clock.observedAtEpochMs <= diedAt)) clock.observedAtEpochMs = diedAt;
	return clock;
}

/** The newer of two clocks, field by field; null when neither carries a clock. */
export function laterClock(previous, next) {
	const clock = {};
	for (const field of ['lastSeenTick', 'observedAtEpochMs']) {
		const values = [previous?.[field], next?.[field]].filter(Number.isFinite);
		if (values.length > 0) clock[field] = Math.max(...values);
	}
	return Object.keys(clock).length === 0 ? null : clock;
}

/** True when `sample` is older than `clock` on a clock both carry. */
export function clockPrecedes(clock, sample) {
	if (clock === null || clock === undefined || sample === null || sample === undefined) return false;
	return ['lastSeenTick', 'observedAtEpochMs'].some((field) => Number.isFinite(clock[field]) && Number.isFinite(sample[field]) && sample[field] < clock[field]);
}

const MAX_LIFECYCLE_WORLDS = 8;

/** An empty per-agent body lifecycle book: one fence per world, plus which world the body is in now. */
export function createLifecycleBook() { return { active: null, activeSinceMs: null, worlds: {} }; }

/**
 * The body lifecycle entry ({ epochStartMs, deathClock, liveClock }) that orders this sample, or null when the sample
 * belongs to a retired world or producer epoch and must not change body facts.
 * - A sample from another world switches the active world only when it is not older (wall time) than the switch to the
 *   current one; each world keeps its own fence, so returning to it later still honours its deaths.
 * - In one world, a sample with a lower game tick but a later wall time than everything seen is a producer rollback
 *   (a restored or replaced save): it starts a new epoch whose tick clocks start afresh. Samples older than that epoch's
 *   start are retired. A sample lower on every clock is only delayed and is ordered by the fences as usual.
 */
export function lifecycleFor(book, worldId, clock) {
	const wall = clock?.observedAtEpochMs;
	const world = typeof worldId === 'string' && worldId.length > 0 ? worldId : book.active ?? '';
	if (world !== book.active) {
		if (book.active !== null && Number.isFinite(book.activeSinceMs) && Number.isFinite(wall) && wall < book.activeSinceMs) return null;
		book.active = world;
		book.activeSinceMs = Number.isFinite(wall) ? wall : book.activeSinceMs;
	}
	let entry = book.worlds[world];
	if (entry === undefined) {
		entry = book.worlds[world] = { epochStartMs: null, deathClock: null, liveClock: null };
		const names = Object.keys(book.worlds);
		for (const name of names.slice(0, Math.max(0, names.length - MAX_LIFECYCLE_WORLDS))) if (name !== world) delete book.worlds[name];
	}
	if (Number.isFinite(entry.epochStartMs) && Number.isFinite(wall) && wall < entry.epochStartMs) return null;
	const top = laterClock(entry.deathClock, entry.liveClock);
	if (Number.isFinite(top?.lastSeenTick) && Number.isFinite(clock?.lastSeenTick) && clock.lastSeenTick < top.lastSeenTick
		&& Number.isFinite(top?.observedAtEpochMs) && Number.isFinite(wall) && wall > top.observedAtEpochMs) {
		Object.assign(entry, { epochStartMs: wall, deathClock: null, liveClock: null });
	}
	return entry;
}

/**
 * The evidence rule: only a cell this sample shows directly can change or remove a remembered block. Rows come from
 * sections the sample observed now (not remembered copies), visible and not perceived by sound; the crosshair's hit cell
 * also counts, and a row for the same cell takes precedence over it. Returns cell key -> { x, y, z, blockId, via }.
 */
export function directBlockEvidence(observation) {
	const cells = new Map(observedBlocks(observation).map(block => [cellKey(block), { ...block, via: 'row' }]));
	const hit = blockContradictionEvidence(observation);
	if (hit !== null && !cells.has(hit.keys[0])) {
		const { x, y, z, blockId } = observation.interaction.rayTarget;
		cells.set(hit.keys[0], { x, y, z, blockId, via: 'ray' });
	}
	return cells;
}

/** The directly observed block that disproves a remembered `blockId` at `cell`, or null. */
export function disprovingBlock(cells, cell, blockId, same = (left, right) => left === right) {
	const seen = cells.get(cellKey(cell));
	return seen !== undefined && !same(seen.blockId, blockId) ? seen : null;
}

export function cellKey(cell) { return `${cell.x},${cell.y},${cell.z}`; }

/**
 * Whether `next` evidence may replace `previous`: it must not be older on any clock both carry. A receipt is not
 * overridden by an observation of the same tick that lacks wall time.
 */
export function freshEvidence(previous, next) {
	if (!previous) return true;
	let comparable = false;
	for (const field of ['lastSeenTick', 'observedAtEpochMs']) {
		if (!Number.isFinite(previous[field])) continue;
		if (!Number.isFinite(next[field])) continue;
		comparable = true;
		if (next[field] < previous[field]) return false;
	}
	if (previous.source === 'action_receipt' && next.lastSeenTick === previous.lastSeenTick && !Number.isFinite(next.observedAtEpochMs) && Number.isFinite(previous.observedAtEpochMs)) return false;
	return comparable || !['lastSeenTick', 'observedAtEpochMs'].some(field => Number.isFinite(previous[field]));
}

/** Like freshEvidence, and strictly newer on at least one clock both carry. */
export function newerEvidence(previous, next) {
	if (!freshEvidence(previous, next)) return false;
	return ['lastSeenTick', 'observedAtEpochMs'].some(field => Number.isFinite(previous?.[field]) && Number.isFinite(next?.[field]) && next[field] > previous[field]);
}

/** Whole seconds from `at` to `now` ({ observedAtEpochMs } or { tick }; wall time first), or null when unknown or negative. */
export function factAge(at, now) {
	const epoch = value => value?.observedAtEpochMs ?? value?.seenAtEpochMs;
	const tick = value => value?.tick ?? value?.lastSeenTick;
	const seconds = Number.isFinite(epoch(at)) && Number.isFinite(epoch(now)) ? (epoch(now) - epoch(at)) / 1000
		: Number.isFinite(tick(at)) && Number.isFinite(tick(now)) ? (tick(now) - tick(at)) / 20 : null;
	return seconds === null || seconds < 0 ? null : Math.ceil(seconds);
}

// Whole units, rounded down, so a remembered row's text changes at most once a minute after its first minute and the
// unchanged-field omission between wakes keeps working.
export function ageText(seconds) {
	return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 172_800 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86_400)}d`;
}

/**
 * The fact envelope as the model reads it, one short field: source and age, then when newer direct evidence
 * disagreed, for example "did 4m; disproved 20s". An unknown age is left out rather than guessed.
 */
export function provenance(source, at, now, disprovedAt = null) {
	if (!SOURCES.includes(source)) throw new TypeError(`unknown fact source ${source}`);
	const age = factAge(at, now);
	let text = age === null ? source : `${source} ${ageText(age)}`;
	if (disprovedAt !== null && disprovedAt !== undefined) {
		const since = factAge(disprovedAt, now);
		text += since === null ? '; disproved' : `; disproved ${ageText(since)}`;
	}
	return text;
}

/**
 * What each kind of remembered fact is bound to, and so which lifecycle changes end it:
 * - carried: what the body holds or wears; a death drops it.
 * - life: ordering proofs that hold within one life and one coordinator run (a restart may have missed a death).
 * - body: continuity of the body's own movement (trail, motion, travel); any jump in where the body is breaks it.
 * - world: blocks seen or placed, per world and dimension; a player remembers them through death and travel.
 * - note: model-authored; only its author retires it.
 * A provider context rotation forgets the conversation, not the world, so it ends no stored fact.
 */
export const LIFECYCLE_BINDINGS = Object.freeze({
	carried: Object.freeze(['died', 'world']),
	life: Object.freeze(['died', 'restarted', 'world']),
	body: Object.freeze(['died', 'respawned', 'dimension', 'world', 'restarted']),
	world: Object.freeze(['world']),
	note: Object.freeze([]),
});

/** Whether `change` (from FactLifecycle) ends facts with this binding. */
export function invalidated(binding, change) {
	const ends = LIFECYCLE_BINDINGS[binding];
	if (ends === undefined) throw new TypeError(`unknown fact binding ${binding}`);
	return change !== null && change !== undefined && ends.some(kind => Boolean(change[kind]));
}

const PROCESS_SESSION = `${process.pid}:${Date.now()}`;

/**
 * One agent's lifecycle as its samples show it: deaths, respawns, dimension and world changes, and coordinator
 * restarts (a restored record from another run). Stores hold one per agent and invalidate through LIFECYCLE_BINDINGS.
 */
export class FactLifecycle {
	// Deaths are counted per origin: each lifecycle object is one origin numbering its own deaths 1, 2, 3... A saved
	// record carries the highest number it knows for every origin, and merging keeps the highest per origin. So adopting
	// any copy of the same history (world A -> B -> A -> B, a second writer) adds nothing, independent histories add up,
	// and no compaction limit can break that.
	#origins = new Map(); #origin = randomUUID(); #dead = false; #dimension = null; #worldId = null; #session; #restarted = false; #samples = 0;

	constructor(session = PROCESS_SESSION) { this.#session = session; }

	/** A new lifecycle holding a record saved by toJSON (see adopt). */
	static restore(saved, { after = null, session = after?.#session ?? PROCESS_SESSION } = {}) {
		const lifecycle = new FactLifecycle(session);
		if (after !== null) { lifecycle.#origins = new Map(after.#origins); lifecycle.#origin = after.#origin; lifecycle.#dead = after.#dead; lifecycle.#dimension = after.#dimension; lifecycle.#worldId = after.#worldId; lifecycle.#samples = after.#samples; }
		return lifecycle.adopt(saved);
	}

	/**
	 * Folds in a record saved by toJSON, in place, so holders of this object keep a current reference. Deaths it already
	 * knows change nothing. When this object has seen no sample yet, the saved life boundary (dead or alive), dimension
	 * and world hold. A record from another coordinator run makes the next sample report `restarted`.
	 */
	adopt(saved) {
		if (saved === null || typeof saved !== 'object') return this;
		const origins = saved.deathOrigins !== null && typeof saved.deathOrigins === 'object' && !Array.isArray(saved.deathOrigins) ? Object.entries(saved.deathOrigins) : legacyOrigins(saved);
		for (const [origin, count] of origins) if (origin.length <= 128 && Number.isSafeInteger(count) && count > 0) this.#origins.set(origin, Math.max(this.#origins.get(origin) ?? 0, count));
		if (this.#samples === 0 && typeof saved.dead === 'boolean') this.#dead = saved.dead;
		if ((this.#samples === 0 || this.#dimension === null) && identifier(saved.dimension)) this.#dimension = saved.dimension;
		if ((this.#samples === 0 || this.#worldId === null) && typeof saved.worldId === 'string' && saved.worldId.length > 0 && saved.worldId.length <= 256) this.#worldId = saved.worldId;
		if (saved.session !== this.#session) this.#restarted = true;
		return this;
	}

	/** Folds one sample in; returns what changed ({ died, respawned, dimension, world, restarted }) or null. */
	observe(observation) {
		// Only current evidence of the body, living or dead, changes anything, the world included; an unready, bodiless or
		// remembered-body sample leaves even a pending restart for a real sample.
		if (!bodySample(observation)) return null;
		const change = {};
		this.#samples++;
		if (this.#restarted) { change.restarted = true; this.#restarted = false; }
		const dead = deadSample(observation);
		// Only a sample showing a living body ends a death; an unready or bodiless sample says nothing about revival.
		const live = liveSample(observation);
		if (dead && !this.#dead) { this.#origins.set(this.#origin, (this.#origins.get(this.#origin) ?? 0) + 1); change.died = true; }
		if (live && this.#dead) change.respawned = true;
		if (dead) this.#dead = true; else if (live) this.#dead = false;
		const worldId = observation?.world?.worldId;
		if (typeof worldId === 'string' && worldId.length > 0 && worldId.length <= 256) {
			if (this.#worldId !== null && worldId !== this.#worldId) change.world = { from: this.#worldId, to: worldId };
			this.#worldId = worldId;
		}
		// A corpse sample may lack or repeat the world; only a live body's dimension moves it.
		const dimension = observation?.world?.dimension;
		if (live && identifier(dimension)) {
			if (this.#dimension !== null && dimension !== this.#dimension) change.dimension = { from: this.#dimension, to: dimension };
			this.#dimension = dimension;
		}
		return Object.keys(change).length === 0 ? null : change;
	}

	get dead() { return this.#dead; }
	get deaths() { let total = 0; for (const count of this.#origins.values()) total += count; return total; }
	get dimension() { return this.#dimension; }

	/** A point to compare later state against, for facts written now (the working intent, for example). */
	mark() { return { deaths: this.deaths, ...(this.#dimension === null ? {} : { dimension: this.#dimension }), session: this.#session }; }

	/** What happened since `mark`: deaths since, the dimension then and now, and whether the coordinator restarted. */
	since(mark) {
		const deaths = Number.isSafeInteger(mark?.deaths) ? Math.max(0, this.deaths - mark.deaths) : 0;
		return {
			deaths,
			...(identifier(mark?.dimension) && this.#dimension !== null && mark.dimension !== this.#dimension ? { dimension: { from: mark.dimension, to: this.#dimension } } : {}),
			...(typeof mark?.session === 'string' && mark.session !== this.#session ? { restarted: true } : {}),
		};
	}

	toJSON() { return { deaths: this.deaths, deathOrigins: Object.fromEntries(this.#origins), dead: this.#dead, ...(this.#dimension === null ? {} : { dimension: this.#dimension }), ...(this.#worldId === null ? {} : { worldId: this.#worldId }), session: this.#session }; }
}

// A record from before origins keeps its deduplication: each itemised death id is an origin of one death, so overlapping
// copies saved by different runs still share it. Deaths it no longer itemised (or a record with only a total) are
// merged by their highest count under one key, since copies of one history share those earliest deaths.
function legacyOrigins(saved) {
	const ids = Array.isArray(saved.deathIds) ? [...new Set(saved.deathIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 64))] : [];
	const rest = Number.isSafeInteger(saved.deaths) ? saved.deaths - ids.length : 0;
	return [...ids.map(id => [`id:${id}`, 1]), ...(rest > 0 ? [['legacy:unitemised', rest]] : [])];
}

function identifier(value) { return typeof value === 'string' && value.length <= 128 && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value); }
