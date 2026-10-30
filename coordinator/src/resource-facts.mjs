// Facts about things the agent already owns: tool wear and workstations it placed.
// They inform the model's choices; nothing here acts, selects or recommends a target.
import { directBlockEvidence, evidenceClock, freshEvidence, provenance } from './fact-provenance.mjs';

export const WORKSTATION_BLOCKS = Object.freeze(new Set(['minecraft:crafting_table', 'minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker']));
// Beyond reach and the local block view, but still close enough that walking back is cheap.
export const LEFT_BEHIND_MIN_DISTANCE = 8;
export const LEFT_BEHIND_MAX_DISTANCE = 64;
const MAX_LEFT_BEHIND_ROWS = 3;
const MAX_TRACKED_PER_AGENT = 16;

/**
 * Model view of inventory wear: damageable rows show usesLeft (maxDamage - damage) instead of damage, so the
 * most worn tool is readable at a glance; rows that cannot wear drop the always-zero damage pair.
 */
export function withToolWear(inventory) {
	if (!Array.isArray(inventory?.items)) return inventory;
	let changed = false;
	const items = inventory.items.map((item) => {
		if (!Number.isSafeInteger(item?.maxDamage) || !Number.isSafeInteger(item?.damage) || item.usesLeft !== undefined) return item;
		const { damage, maxDamage, ...rest } = item;
		if (maxDamage <= 0 && damage !== 0) return item;
		changed = true;
		return maxDamage <= 0 ? rest : { ...rest, maxDamage, usesLeft: Math.max(0, maxDamage - damage) };
	});
	return changed ? { ...inventory, items } : inventory;
}

/** Model-facing tool results: wear on the observation and on post-action observations. Programs keep raw damage. */
export function presentToolWear(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
	const wear = (holder) => holder !== null && typeof holder === 'object' && holder.inventory !== undefined ? { ...holder, inventory: withToolWear(holder.inventory) } : holder;
	let result = value;
	if (result.observation !== undefined) result = { ...result, observation: wear(result.observation) };
	if (result.postAction?.observation !== undefined) result = { ...result, postAction: { ...result.postAction, observation: wear(result.postAction.observation) } };
	return result;
}

/** Workstations this agent placed, from its own confirmed place_block and break_block results. */
export class PlacedWorkstations {
	#agents = new Map();

	onActionResult(agentId, { actionType, arguments: args, state, observedAtEpochMs, actionObservation } = {}, observation = null) {
		if (state !== 'SUCCEEDED' || !['place_block', 'break_block'].includes(actionType)) return;
		const position = blockPosition(args);
		if (position === null) return;
		const scope = observationScope(observation);
		const placed = this.#agents.get(agentId);
		if (actionType === 'break_block') {
			// The receipt names a cell in the world and dimension the agent was in; the same numbers elsewhere are another cell.
			for (const [key, entry] of placed ?? []) if (sameCell(entry, position) && sameScope(entry, scope)) placed.delete(key);
			return;
		}
		if (!WORKSTATION_BLOCKS.has(args.itemId)) return;
		const entries = placed ?? new Map();
		const key = JSON.stringify([scope.worldId, scope.dimension, position.x, position.y, position.z]);
		entries.delete(key);
		const placedAt = Number.isFinite(observedAtEpochMs) ? observedAtEpochMs : observation?.observedAtEpochMs;
		// Ticks are per world: only the receipt's own tick is the placement's; without it, wall time alone orders evidence.
		const placedTick = actionObservation?.worldTick;
		entries.set(key, { blockId: args.itemId, ...position, ...scope, ...(Number.isFinite(placedAt) ? { placedAt } : {}), ...(Number.isSafeInteger(placedTick) ? { placedTick } : {}) });
		while (entries.size > MAX_TRACKED_PER_AGENT) entries.delete(entries.keys().next().value);
		this.#agents.set(agentId, entries);
	}

	/**
	 * Rows for placed workstations of this world and dimension between 8 and 64 blocks away, nearest first. A direct
	 * sighting of another block there, not older than the placement, retires one.
	 */
	leftBehind(agentId, observation = {}) {
		const entries = this.#agents.get(agentId);
		if (entries === undefined || entries.size === 0) return [];
		const scope = observationScope(observation);
		const evidence = directBlockEvidence(observation);
		for (const [key, entry] of entries) {
			const row = evidence.get(`${entry.x},${entry.y},${entry.z}`);
			if (row !== undefined && row.blockId !== entry.blockId && sameScope(entry, scope)
				&& freshEvidence({ observedAtEpochMs: entry.placedAt, lastSeenTick: entry.placedTick }, evidenceClock(row, observation))) entries.delete(key);
		}
		const position = observation.position;
		if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y) || !Number.isFinite(position?.z)) return [];
		return [...entries.values()]
			.filter((entry) => sameScope(entry, scope))
			.map((entry) => ({ blockId: entry.blockId, x: entry.x, y: entry.y, z: entry.z,
				distance: Math.round(Math.hypot(entry.x + 0.5 - position.x, entry.y + 0.5 - position.y, entry.z + 0.5 - position.z)),
				src: provenance('did', { observedAtEpochMs: entry.placedAt }, observation) }))
			.filter((row) => row.distance > LEFT_BEHIND_MIN_DISTANCE && row.distance <= LEFT_BEHIND_MAX_DISTANCE)
			.sort((left, right) => left.distance - right.distance)
			.slice(0, MAX_LEFT_BEHIND_ROWS);
	}

	/** Every tracked placement with its dimension, for facts that need the station rather than its distance band. */
	rows(agentId) {
		return [...(this.#agents.get(agentId)?.values() ?? [])];
	}

	clear(agentId) {
		this.#agents.delete(agentId);
	}
}

// A sample without a world or dimension leaves that part unknown, which matches any (the earlier behaviour).
function observationScope(observation) {
	const world = observation?.world;
	return { worldId: typeof world?.worldId === 'string' ? world.worldId : null, dimension: typeof world?.dimension === 'string' ? world.dimension : null };
}
function sameScope(entry, scope) {
	return (entry.worldId == null || scope.worldId === null || entry.worldId === scope.worldId)
		&& (entry.dimension == null || scope.dimension === null || entry.dimension === scope.dimension);
}
function sameCell(entry, position) { return entry.x === position.x && entry.y === position.y && entry.z === position.z; }

function blockPosition(args) {
	return [args?.x, args?.y, args?.z].every(Number.isSafeInteger) ? { x: args.x, y: args.y, z: args.z } : null;
}
