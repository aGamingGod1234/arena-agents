import { extractDimension, observationWorldId } from './explore-frontier.mjs';
import { observationPosition } from './observed-memory-store.mjs';
import { bodyClock, cellKey, clockPrecedes, createLifecycleBook, deadSample, directBlockEvidence, disprovingBlock, evidenceClock, freshEvidence, laterClock, lifecycleFor } from './fact-provenance.mjs';

const MAX_PLACED = 16;
const MAX_DROPPED = 16;
export const MAX_EVER_POSSESSED = 128;
const WORKSTATION_BLOCKS = new Set([
	'minecraft:crafting_table',
	'minecraft:furnace',
	'minecraft:blast_furnace',
	'minecraft:smoker',
	'minecraft:chest',
	'minecraft:trapped_chest',
	'minecraft:barrel',
	'minecraft:ender_chest',
	'minecraft:enchanting_table',
	'minecraft:anvil',
	'minecraft:chipped_anvil',
	'minecraft:damaged_anvil',
	'minecraft:smithing_table',
	'minecraft:grindstone',
	'minecraft:brewing_stand',
	'minecraft:lodestone',
	'minecraft:respawn_anchor',
	'minecraft:end_portal_frame',
]);

/**
 * Coordinator-side recovery wrap for the two-call native LLM.
 * Minecraft remains authoritative for inventory, drops, and placed blocks.
 * This store only remembers the last live snapshot across death/respawn so
 * observe/say/mine/moveTo results can name last death and currently evidenced progress.
 */
export class RecoveryProgressStore {
	#agents = new Map();

	remember(agentId, goalRevision, observation = {}) {
		const id = requireAgentId(agentId);
		if (!Number.isSafeInteger(goalRevision) || goalRevision < 0) throw new TypeError('goalRevision must be a nonnegative safe integer');
		const previous = this.#agents.get(id) ?? emptyRecord(goalRevision);
		// A respawn can arrive as a new goal revision (disconnect, resume): what the last death cost is still a fact then.
		const next = previous.goalRevision === goalRevision ? cloneRecord(previous) : {
			...emptyRecord(goalRevision, previous.lastDeath, previous.lastLostInventory),
			// Retain loss accounting privately; an old held stack is not evidence of current inventory.
			lastLive: previous.lastLive, portal: previous.portal, crossings: (previous.crossings ?? []).slice(), dropTicking: previous.dropTicking, simulationDistance: previous.simulationDistance, accountedInventory: previous.accountedInventory.slice(), deathInventory: previous.deathInventory ?? null, lifecycle: previous.lifecycle ? structuredClone(previous.lifecycle) : null,
		};
		if (hasDurableObservationFacts(observation)) ingestObservation(next, observation);
		this.#agents.set(id, next);
		return this.snapshot(id, observation);
	}

	wrap(agentId, goalRevision, observation = {}) {
		if (Number.isSafeInteger(goalRevision) && goalRevision >= 0) this.remember(agentId, goalRevision, observation);
		return attachRecovery(observation, this.snapshot(agentId, observation));
	}

	snapshot(agentId, observation = {}) {
		const record = this.#agents.get(requireAgentId(agentId));
		if (record === undefined) return deriveRecovery(null, observation);
		return deriveRecovery(record, observation);
	}

	/**
	 * An own break receipt disproves a remembered placed station at that cell, as a direct sighting would. `observation`
	 * carries the world and dimension the action was dispatched in.
	 */
	recordResult(agentId, observation, { actionType, arguments: args, state, reasonCode, observedAtEpochMs } = {}) {
		const record = this.#agents.get(requireAgentId(agentId));
		if (record === undefined || actionType !== 'break_block' || state !== 'SUCCEEDED' || reasonCode !== 'BLOCK_BROKEN' || ![args?.x, args?.y, args?.z].every(Number.isSafeInteger)) return;
		const cell = { x: args.x, y: args.y, z: args.z, dimension: extractDimension(observation), worldId: observationWorldId(observation) };
		const clock = Number.isFinite(observedAtEpochMs) ? { observedAtEpochMs } : evidenceClock(null, observation);
		// An older receipt cannot remove a station seen again after it.
		record.placed = record.placed.filter((item) => !sameCell(item, cell) || !freshEvidence(item, clock));
		rememberDisproof(record, cell, clock);
	}

	forget(agentId) {
		this.#agents.delete(requireAgentId(agentId));
	}

	clear() {
		this.#agents.clear();
	}
}

export function wrapObservationWithRecovery(observation, snapshot) {
	return attachRecovery(observation, snapshot);
}

export function deriveRecoveryFacts(record, observation = {}) {
	return deriveRecovery(record, observation);
}

/** True when the payload carries world facts worth ingesting into recovery memory. */
export function hasDurableObservationFacts(observation) {
	if (observation === null || typeof observation !== 'object') return false;
	return observation.death != null
		|| observation.inventory !== undefined
		|| observation.player !== undefined
		|| observation.blocks !== undefined
		|| observation.items !== undefined
		|| observation.status !== undefined
		|| observation.position !== undefined
		|| observation.world !== undefined;
}

/** Compatibility field only. Crafting decisions belong to the selected model. */
export function doNotRedoFor() { return []; }

function ingestObservation(record, observation) {
	// Body lifecycle clocks are kept per world (and producer epoch); see lifecycleFor.
	const clock = bodyClock(observation);
	const lifecycle = lifecycleFor(record.lifecycle ??= createLifecycleBook(), observation?.world?.worldId ?? observation?.worldId, clock);
	const died = (observation?.death !== undefined && observation.death !== null) || deadSample(observation);
	// A sample from a retired world or producer epoch describes nothing current.
	if (lifecycle === null) return;
	// A death sample older than the newest living sample describes an earlier death: it may add history, never end this body.
	const earlierDeath = died && clockPrecedes(lifecycle.liveClock, clock);
	if (died && !earlierDeath) lifecycle.deathClock = laterClock(lifecycle.deathClock, clock);
	if (observation?.death !== undefined && observation.death !== null) {
		const nextDeath = normalizeDeath(observation.death);
		const isNewDeath = record.lastDeath === null || !sameDeath(record.lastDeath, nextDeath);
		if (earlierDeath) {
			if (isNewDeath && !(record.lastDeath?.diedAtEpochMs > nextDeath.diedAtEpochMs)) {
				const held = record.deathInventory;
				const lost = observation.lastLiveInventory !== undefined ? inventoryItems({ inventory: observation.lastLiveInventory })
					: held && Array.isArray(held.items) ? held.items.slice() : [];
				record.lastLostInventory = lost;
				record.lastDeath = Object.freeze({ ...nextDeath, ...(record.lastLive ? { respawnedAt: point(record.lastLive) } : {}) });
				record.everPossessed = uniqueIds([...record.everPossessed, ...lost.map((item) => item.itemId)]);
			}
			return;
		}
		const lost = lostInventoryAtDeath(record, observation);
		if (isNewDeath) {
			record.lastLostInventory = lost;
			record.inventory = [];
			record.deathInventory = null;
			record.accountedInventory = [];
			const portal = record.portal ?? crossingInto(record, nextDeath.dimensionId);
			record.lastDeath = Object.freeze({ ...nextDeath, ...(portal ? { portal } : {}) });
			// The body stays at the death site until respawn, so its chunk ticks the drops until then.
			record.dropTicking = Number.isFinite(nextDeath.diedAtEpochMs) ? { nearMs: 0, lastAt: nextDeath.diedAtEpochMs, lastNear: true } : null;
			record.lastLive = null;
			record.portal = null;
		}
		record.everPossessed = uniqueIds([...record.everPossessed, ...lost.map((item) => item.itemId), ...record.lastLostInventory.map((item) => item.itemId)]);
		return;
	}
	// Carried facts end with the body (LIFECYCLE_BINDINGS.carried) whatever shape the death sample has, including a
	// corpse sample that lists inventory. What was held stays privately as the loss record for death details that may
	// arrive later, with the time the body came back so a later death is not charged with it.
	if (earlierDeath) return;
	if (Number.isSafeInteger(observation?.world?.simulationDistance)) record.simulationDistance = observation.world.simulationDistance;
	if (deadSample(observation)) {
		const held = hasCurrentSection(observation, 'inventory') ? inventoryItems(observation) : record.inventory;
		if (held.length > 0) record.deathInventory = { items: held, revivedAt: null };
		record.inventory = [];
	}
	const inventory = inventoryItems(observation);
	const dropped = droppedItems(observation);
	const placed = placedAssets(observation);
	// A living sample older than the newest death describes the previous body.
	const alive = !deadSample(observation) && observation?.ready !== false && !clockPrecedes(lifecycle.deathClock, clock);
	const live = alive ? recoveryPosition(observation) : null;
	if (live !== null || (alive && hasCurrentSection(observation, 'inventory'))) lifecycle.liveClock = laterClock(lifecycle.liveClock, clock);
	if (live !== null) {
		if (record.lastDeath !== null && record.lastDeath.respawnedAt === undefined) {
			record.lastDeath = Object.freeze({ ...record.lastDeath, respawnedAt: point(live) });
		} else if (record.lastLive !== null && (record.lastLive.worldId !== live.worldId || record.lastLive.dimension !== live.dimension)) {
			record.portal = observedPortalTransition(record.lastLive, live);
			rememberCrossing(record, record.lastLive, live);
		}
		record.lastLive = live;
		advanceDropTicking(record, live, observation.observedAtEpochMs);
		if (record.deathInventory && record.deathInventory.revivedAt === null) record.deathInventory = { ...record.deathInventory, revivedAt: observation.observedAtEpochMs ?? Number.MAX_SAFE_INTEGER };
	}
	if (inventory.length > 0) {
		record.everPossessed = uniqueIds([...record.everPossessed, ...inventory.map((item) => item.itemId)]);
	}
	if (alive && hasCurrentSection(observation, 'inventory')) {
		if (inventory.length > 0 && record.lastLostInventory.length > 0) {
			// Inventory alone cannot distinguish new loot from a stack taken back out of a chest.
			// Reconcile only counts above the largest evidenced possession since this death.
			const acquired = subtractRecovered(inventory, record.accountedInventory);
			record.lastLostInventory = subtractRecovered(record.lastLostInventory, acquired);
		}
		record.inventory = inventory;
		if (record.lastLostInventory.length > 0) {
			const previousCounts = new Map(record.accountedInventory.map(({ itemId, count }) => [itemId, count]));
			const heldCounts = new Map(inventory.map(({ itemId, count }) => [itemId, count]));
			record.accountedInventory = record.lastLostInventory.map(({ itemId }) => ({ itemId,
				count: Math.max(previousCounts.get(itemId) ?? 0, heldCounts.get(itemId) ?? 0) }));
		} else record.accountedInventory = [];
	}
	if (dropped.length > 0) record.dropped = dropped;
	const cells = directBlockEvidence(observation);
	record.placed = record.placed.filter((item) => {
		const seen = disproof(cells, item, observation);
		if (seen !== null) rememberDisproof(record, item, seen);
		return seen === null;
	});
	// A cell already disproved and seen again without a station keeps advancing its disproof clock.
	for (const entry of record.disproved ?? []) {
		const seen = cells.get(cellKey(entry));
		if (!seen || entry.dimension !== (extractDimension(observation) ?? null) || entry.worldId !== observationWorldId(observation)
			|| placed.some((item) => sameCell(item, entry))) continue;
		rememberDisproof(record, entry, evidenceClock(seen, observation));
	}
	if (placed.length > 0) {
		mergePlaced(record, placed);
		record.everPossessed = uniqueIds([...record.everPossessed, ...placed.map((item) => item.blockId)]);
	}
}

function deriveRecovery(record, observation) {
	// A corpse holds nothing; what it listed is the private loss record, not possession.
	const currentInventory = deadSample(observation) ? []
		: hasCurrentSection(observation, 'inventory') ? inventoryItems(observation) : [...(record?.inventory ?? [])];
	const currentDropped = droppedItems(observation);
	const currentPlaced = placedAssets(observation).filter((item) => !disprovedLater(record, item));
	const observedDeath = observation?.death != null ? normalizeDeath(observation.death) : null;
	const lastDeath = observedDeath === null || sameDeath(record?.lastDeath, observedDeath)
		? record?.lastDeath ?? null : observedDeath;
	const lastLostInventory = record?.lastLostInventory ?? [];
	const rememberedPlaced = uncontradictedPlaced(record?.placed ?? [], observation);
	const alreadyHaveFacts = compactAlreadyHave([
		...currentInventory.map((item) => ({ kind: 'inventory', ...item, ...(hasCurrentSection(observation, 'inventory') ? {} : { remembered: true }) })),
		...currentDropped.map((item) => ({ kind: 'dropped', ...item })),
		...currentPlaced.map((item) => ({ kind: 'placed', ...withoutClock(item) })),
		...rememberedPlaced
			.filter((item) => placedInCurrentDimension(item, observation) && !currentPlaced.some((current) => samePlaced(current, item)))
			.map((item) => ({ kind: 'placed', ...withoutClock(item), remembered: true })),
	]);
	const alreadyHave = uniqueIds(alreadyHaveFacts.map((entry) => entry.itemId ?? entry.blockId));
	const doNotRedo = doNotRedoFor(alreadyHave);
	if (lastDeath === null && alreadyHave.length === 0 && lastLostInventory.length === 0 && doNotRedo.length === 0) return null;
	const dropTicking = lastDeath !== null && record?.lastDeath === lastDeath ? dropTickingView(record, observation) : null;
	return Object.freeze({
		...(lastDeath === null ? {} : { lastDeath }),
		...(dropTicking === null ? {} : { dropTicking }),
		...(lastLostInventory.length === 0 ? {} : { lastLostInventory: lastLostInventory.map(cloneItem) }),
		alreadyHave,
		alreadyHaveFacts,
		doNotRedo,
	});
}

function attachRecovery(observation, recovery) {
	const source = observation === null || observation === undefined ? {} : observation;
	if (recovery === null) return source;
	return { ...source, recovery };
}

function inventoryItems(observation) {
	const raw = observation?.inventory;
	const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
	// Aggregate before accounting so slot moves and split stacks do not change
	// recovery counts, and a full inventory does not silently lose its final slots.
	const counts = new Map();
	for (const item of items.map(summarizeStack).filter(Boolean)) counts.set(item.itemId, (counts.get(item.itemId) ?? 0) + item.count);
	return [...counts].map(([itemId, count]) => Object.freeze({ itemId, count }));
}

function droppedItems(observation) {
	const items = hasCurrentSection(observation, 'items') && Array.isArray(observation?.items) ? observation.items : [];
	const fromEntities = hasCurrentSection(observation, 'entities') && Array.isArray(observation?.entities)
		? observation.entities.filter((entity) => entity?.type === 'minecraft:item')
		: [];
	return [...items, ...fromEntities].map(summarizeDrop).filter(Boolean).slice(0, MAX_DROPPED);
}

function placedAssets(observation) {
	const placed = [];
	// Without an observed dimension the station's dimension stays unknown rather than defaulting.
	const dimension = observationHasDimension(observation) ? extractDimension(observation) : null;
	// The same direct evidence that can disprove a remembered station is the only evidence that adds one.
	for (const block of directBlockEvidence(observation).values()) {
		const blockId = block.blockId;
		if (!WORKSTATION_BLOCKS.has(blockId)) continue;
		placed.push(Object.freeze({
			blockId,
			x: block.x,
			y: block.y,
			z: block.z,
			...(dimension === null ? {} : { dimension }),
			worldId: observationWorldId(observation),
			...evidenceClock(block, observation),
		}));
	}
	return uniquePlaced(placed).slice(0, MAX_PLACED);
}

function hasCurrentSection(observation, section) {
	return observation?.[section] !== undefined && !observation?.continuity?.rememberedSections?.includes(section);
}

function currentBlocks(observation) {
	return ['blocks', 'nearbyContainers'].flatMap((section) => hasCurrentSection(observation, section) && Array.isArray(observation[section]) ? observation[section] : []);
}

function uncontradictedPlaced(placed, observation) {
	const cells = directBlockEvidence(observation);
	return placed.filter((item) => disproof(cells, item, observation) === null);
}

/** The clock of fresh direct evidence in this sample that disproves a remembered station, or null. */
function disproof(cells, item, observation) {
	const seen = disprovingBlock(cells, item, item.blockId);
	if (!seen || item.dimension !== extractDimension(observation) || item.worldId !== observationWorldId(observation)) return null;
	const clock = evidenceClock(seen, observation);
	return freshEvidence(item, clock) ? clock : null;
}

// Disproofs outlive the station they removed, so an older row cannot bring it back; one per cell, its clocks only
// move forward. Past the cap the evicted clocks become a per-world/dimension floor older evidence cannot cross.
const MAX_DISPROOFS = 32;
function rememberDisproof(record, cell, clock) {
	const previous = (record.disproved ?? []).find((entry) => sameCell(entry, cell));
	const kept = (record.disproved ?? []).filter((entry) => entry !== previous);
	kept.push(Object.freeze({ worldId: cell.worldId, dimension: cell.dimension ?? null, x: cell.x, y: cell.y, z: cell.z, ...latestClock(previous, clock) }));
	for (const evicted of kept.slice(0, Math.max(0, kept.length - MAX_DISPROOFS))) {
		const floors = record.disproofFloors ?? [];
		const floor = floors.find((entry) => entry.worldId === evicted.worldId && entry.dimension === evicted.dimension);
		record.disproofFloors = [...floors.filter((entry) => entry !== floor),
			Object.freeze({ worldId: evicted.worldId, dimension: evicted.dimension, ...latestClock(floor, evicted) })];
	}
	record.disproved = kept.slice(-MAX_DISPROOFS);
}
function latestClock(previous, next) {
	const clock = {};
	for (const field of ['lastSeenTick', 'observedAtEpochMs']) {
		const values = [previous?.[field], next?.[field]].filter(Number.isFinite);
		if (values.length > 0) clock[field] = Math.max(...values);
	}
	return clock;
}
function disprovedLater(record, item) {
	return (record?.disproved ?? []).some((entry) => sameCell(entry, item) && !freshEvidence(entry, item))
		|| (record?.disproofFloors ?? []).some((floor) => floor.worldId === item.worldId && floor.dimension === (item.dimension ?? null) && !freshEvidence(floor, item));
}
function sameCell(left, right) {
	return left.x === right.x && left.y === right.y && left.z === right.z && (left.dimension ?? null) === (right.dimension ?? null) && left.worldId === right.worldId;
}

function mergePlaced(record, placed) {
	// An older sighting does not replace a newer one's clock, nor bring back a station a newer sighting disproved.
	const fresher = placed.filter((item) => !disprovedLater(record, item) && !record.placed.some((old) => samePlaced(old, item) && !freshEvidence(old, item)));
	if (fresher.length > 0) record.disproved = (record.disproved ?? []).filter((entry) => !fresher.some((item) => sameCell(entry, item)));
	record.placed = uniquePlaced([...fresher, ...record.placed]).slice(0, MAX_PLACED);
}

function summarizeStack(value) {
	const itemId = typeof value?.itemId === 'string' && value.itemId.length > 0 ? value.itemId : null;
	if (itemId === null || itemId === 'minecraft:air') return null;
	if (value.count !== undefined && (!Number.isSafeInteger(value.count) || value.count <= 0)) return null;
	const count = value.count ?? 1;
	return Object.freeze({ itemId, count });
}

function summarizeDrop(value) {
	const stack = summarizeStack(value);
	if (stack === null) return null;
	return Object.freeze({
		...stack,
		...(typeof value.stableId === 'string' ? { stableId: value.stableId } : {}),
		...(Number.isFinite(value.x) ? { x: value.x, y: value.y, z: value.z } : {}),
	});
}

function normalizeDeath(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const cause = typeof value.cause === 'string' && value.cause.trim().length > 0 ? value.cause.trim().slice(0, 256) : 'unknown';
	const dimensionId = typeof value.dimensionId === 'string' && value.dimensionId.length > 0 ? value.dimensionId : null;
	const x = Number.isFinite(value.x) ? value.x : 0;
	const y = Number.isFinite(value.y) ? value.y : 0;
	const z = Number.isFinite(value.z) ? value.z : 0;
	const diedAtEpochMs = Number.isSafeInteger(value.diedAtEpochMs) && value.diedAtEpochMs > 0 ? value.diedAtEpochMs : null;
	return Object.freeze({
		cause,
		...(dimensionId === null ? {} : { dimensionId }),
		x,
		y,
		z,
		...(diedAtEpochMs === null ? {} : { diedAtEpochMs }),
	});
}

function compactAlreadyHave(entries) {
	const seen = new Set();
	const result = [];
	for (const entry of entries) {
		const key = `${entry.kind}:${entry.itemId ?? entry.blockId}:${entry.worldId ?? ''}:${entry.dimension ?? ''}:${entry.x ?? ''}:${entry.y ?? ''}:${entry.z ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(Object.freeze({ ...entry }));
	}
	return Object.freeze(result);
}

function uniquePlaced(entries) {
	const seen = new Set();
	const result = [];
	for (const entry of entries) {
		const key = `${entry.blockId}:${entry.worldId ?? ''}:${entry.dimension ?? ''}:${entry.x}:${entry.y}:${entry.z}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

function samePlaced(left, right) {
	return left.blockId === right.blockId
		&& left.worldId === right.worldId
		&& left.x === right.x && left.y === right.y && left.z === right.z
		&& (left.dimension ?? null) === (right.dimension ?? null);
}

function placedInCurrentDimension(item, observation) {
	if ((observation?.world?.worldId !== undefined || observation?.worldId !== undefined) && item.worldId !== observationWorldId(observation)) return false;
	if (!observationHasDimension(observation)) return true;
	return item.dimension === extractDimension(observation);
}

function observationHasDimension(observation) {
	return typeof observation?.world?.dimension === 'string' && observation.world.dimension.length > 0
		|| typeof observation?.world?.dimensionId === 'string' && observation.world.dimensionId.length > 0;
}

function lostInventoryAtDeath(record, observation) {
	if (observation.lastLiveInventory !== undefined) {
		return inventoryItems({ inventory: observation.lastLiveInventory });
	}
	// The corpse's inventory belongs to this death unless the body came back before it.
	const held = record.deathInventory;
	const diedAt = observation.death?.diedAtEpochMs;
	if (held && (held.revivedAt === null || Number.isFinite(diedAt) && diedAt <= held.revivedAt)) return held.items.slice();
	return record.inventory.slice();
}

// Evidence clocks order remembered stations; they are not part of what the model reads.
function withoutClock({ lastSeenTick, observedAtEpochMs, ...item }) { return item; }

function sameDeath(left, right) {
	if (left == null || right == null) return false;
	return left.cause === right.cause
		&& left.x === right.x && left.y === right.y && left.z === right.z
		&& (left.dimensionId ?? null) === (right.dimensionId ?? null)
		&& left.diedAtEpochMs === right.diedAtEpochMs;
}

function cloneItem(item) {
	return Object.freeze({ ...item });
}

function uniqueIds(values, max = MAX_EVER_POSSESSED) {
	const seen = new Set();
	const newestFirst = [];
	const source = Array.isArray(values) ? values : [];
	for (let index = source.length - 1; index >= 0; index -= 1) {
		const value = source[index];
		if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue;
		seen.add(value);
		newestFirst.push(value);
		if (newestFirst.length >= max) break;
	}
	return Object.freeze(newestFirst.reverse());
}

function subtractRecovered(lost, recovered) {
	const remaining = lost.map((item) => ({ itemId: item.itemId, count: item.count }));
	for (const stack of recovered) {
		let leftover = stack.count;
		for (const lostStack of remaining) {
			if (leftover <= 0) break;
			if (lostStack.itemId !== stack.itemId || lostStack.count <= 0) continue;
			const take = Math.min(lostStack.count, leftover);
			lostStack.count -= take;
			leftover -= take;
		}
	}
	return remaining.filter((item) => item.count > 0).map((item) => Object.freeze(item));
}

function emptyRecord(goalRevision, lastDeath = null, lastLostInventory = []) {
	return {
		goalRevision,
		lastDeath,
		inventory: [],
		accountedInventory: [],
		lastLostInventory: lastLostInventory.slice(),
		lastLive: null,
		deathInventory: null,
		lifecycle: null,
		disproved: [],
		disproofFloors: [],
		portal: null,
		crossings: [],
		dropTicking: null,
		simulationDistance: null,
		dropped: [],
		placed: [],
		everPossessed: [],
	};
}

function cloneRecord(record) {
	return {
		goalRevision: record.goalRevision,
		lastDeath: record.lastDeath,
		inventory: record.inventory.slice(),
		accountedInventory: record.accountedInventory.slice(),
		lastLostInventory: record.lastLostInventory.slice(),
		lastLive: record.lastLive,
		deathInventory: record.deathInventory ?? null,
		lifecycle: record.lifecycle ? structuredClone(record.lifecycle) : null,
		disproved: (record.disproved ?? []).slice(),
		disproofFloors: (record.disproofFloors ?? []).slice(),
		portal: record.portal,
		crossings: (record.crossings ?? []).slice(),
		dropTicking: record.dropTicking ? { ...record.dropTicking } : null,
		simulationDistance: record.simulationDistance ?? null,
		dropped: record.dropped.slice(),
		placed: record.placed.slice(),
		everPossessed: record.everPossessed.slice(),
	};
}

const PORTALS = new Set(['minecraft:nether_portal', 'minecraft:end_portal', 'minecraft:end_gateway']);
const INSTANT_PORTALS = new Set(['minecraft:end_portal', 'minecraft:end_gateway']);

// Only observed portal contact at a live dimension edge is evidence. An initial sample or a respawn is not a portal.
export function recoveryPosition(observation) {
	if (!observationHasDimension(observation) || deadSample(observation) || observation.ready === false) return null;
	const position = observationPosition(observation);
	if (position === null) return null;
	const dimension = extractDimension(observation);
	const portal = currentBlocks(observation).find((block) => PORTALS.has(block.blockId) && block.visible !== false
		&& Number.isFinite(block.x) && Number.isFinite(block.y) && Number.isFinite(block.z)
		&& portalIntersectsBody(block, position)
		&& block.y + 1 > position.y && block.y < position.y + 1.8);
	// A Nether portal takes 4 s inside, so samples see the contact; an End portal or gateway teleports on first contact,
	// so the last sample before the change shows it beside the body.
	const near = portal ? null : currentBlocks(observation).filter((block) => INSTANT_PORTALS.has(block.blockId) && block.visible !== false
		&& [block.x, block.y, block.z].every(Number.isFinite) && Math.abs(block.y - position.y) <= 4
		&& Math.hypot(block.x + 0.5 - position.x, block.z + 0.5 - position.z) <= 5)
		.sort((a, b) => Math.hypot(a.x + 0.5 - position.x, a.z + 0.5 - position.z) - Math.hypot(b.x + 0.5 - position.x, b.z + 0.5 - position.z))[0];
	return { ...position, dimension, worldId: observationWorldId(observation), ...(portal ? { portal: point({ ...portal, dimension }) } : {}), ...(near ? { nearPortal: point({ ...near, dimension }) } : {}) };
}

// A dimension change between two live samples of one world, through a portal the sample saw the body in or beside.
const MAX_CROSSINGS = 6;
function rememberCrossing(record, previous, current) {
	if (previous.worldId !== current.worldId || previous.dimension === current.dimension) return;
	// A crossing with no portal seen beside the body keeps the last one that saw it.
	const from = previous.portal ?? previous.nearPortal ?? null;
	if (from === null) return;
	const crossing = Object.freeze({ from, to: current.portal ?? point(current) });
	record.crossings = [...(record.crossings ?? []).filter((row) => !(row.from.dimension === crossing.from.dimension && row.to.dimension === crossing.to.dimension)), crossing].slice(-MAX_CROSSINGS);
}

/** The remembered way into a dimension: the last crossing that arrived there, from any earlier life in this world. */
function crossingInto(record, dimension) {
	const row = (record.crossings ?? []).findLast((entry) => entry.to.dimension === dimension);
	return row ? Object.freeze({ from: row.from, to: row.to, source: 'remembered_crossing' }) : null;
}

export function observedPortalTransition(previous, current) {
	const from = previous.portal ?? previous.nearPortal;
	if (previous.worldId !== current.worldId || previous.dimension === current.dimension || !from) return null;
	return Object.freeze({ from, ...(current.portal ? { to: current.portal } : {}), source: previous.portal ? 'observed_portal_contact_before_dimension_change' : 'observed_portal_beside_body_before_dimension_change' });
}

// Vanilla ages a dropped item only while its chunk is entity-ticking: within the server's simulation distance
// (Chebyshev, in chunks) of a player. The agent knows only its own presence, so another player can only shorten this.
const DROP_LIFETIME_MS = 300_000;

function dropTickingNear(record, live) {
	const death = record.lastDeath;
	if (!Number.isSafeInteger(record.simulationDistance) || live.dimension !== death.dimensionId) return live.dimension === death.dimensionId ? null : false;
	const chunks = Math.max(Math.abs(Math.floor(live.x / 16) - Math.floor(death.x / 16)), Math.abs(Math.floor(live.z / 16) - Math.floor(death.z / 16)));
	return chunks <= record.simulationDistance;
}

function advanceDropTicking(record, live, at) {
	const clock = record.dropTicking;
	if (!clock || record.lastDeath === null || !Number.isFinite(at) || at < clock.lastAt) return;
	const nearMs = clock.lastNear === true ? clock.nearMs + (at - clock.lastAt) : clock.nearMs;
	const near = dropTickingNear(record, live);
	// Unknown range makes the whole clock unknown from here on.
	record.dropTicking = near === null || clock.lastNear === null ? { nearMs, lastAt: at, lastNear: null } : { nearMs, lastAt: at, lastNear: near };
}

function dropTickingView(record, observation) {
	const clock = record.dropTicking;
	if (!clock || clock.lastNear === null || !Number.isSafeInteger(record.simulationDistance)) return null;
	const at = observation?.observedAtEpochMs;
	const nearMs = clock.nearMs + (clock.lastNear && Number.isFinite(at) && at > clock.lastAt ? at - clock.lastAt : 0);
	return Object.freeze({ simulationDistance: record.simulationDistance, tickedSeconds: Math.floor(Math.min(nearMs, DROP_LIFETIME_MS) / 1000), tickingNow: clock.lastNear });
}

function point(value) {
	return Object.freeze({ dimension: value.dimension, x: value.x, y: value.y, z: value.z });
}

function portalIntersectsBody(block, position) {
	// Nether portals are 0.25 thick; the player's half-width is 0.3. Unknown axis proves no contact.
	const axis = block.state?.axis;
	if (block.blockId === 'minecraft:nether_portal' && axis !== 'x' && axis !== 'z') return false;
	const halfX = block.blockId === 'minecraft:nether_portal' && axis === 'z' ? 0.125 : 0.5;
	const halfZ = block.blockId === 'minecraft:nether_portal' && axis === 'x' ? 0.125 : 0.5;
	return Math.abs(block.x + 0.5 - position.x) < halfX + 0.3
		&& Math.abs(block.z + 0.5 - position.z) < halfZ + 0.3;
}

function requireAgentId(agentId) {
	if (typeof agentId !== 'string' || agentId.trim().length === 0) throw new TypeError('agentId must be nonblank');
	return agentId;
}
