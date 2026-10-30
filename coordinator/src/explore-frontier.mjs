import { CELL_SIZE, ObservedMemoryStore, observationWorldId, observationDimension, observationPosition, observedBlocks, spatialCellKey } from './observed-memory-store.mjs';
import { HEADINGS, createSearch, headingOf, recentTravel, summarizeSearch } from './search-coverage.mjs';

export { CELL_SIZE, observationWorldId };
export const DEFAULT_RADIUS = 128;
export const MIN_RADIUS = 16;
export const MAX_RADIUS = 256;
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 24;
const NEAR = 8;
const OLD_TICKS = 1200;
const ROUND_ROBIN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Lists observed footing and search coverage. Only the model chooses a destination. */
export class ExplorationOccupancy {
	#memory;
	constructor({ memoryStore = new ObservedMemoryStore() } = {}) { this.#memory = memoryStore; }
	ingest(agentId, observation, options = {}) { return this.#memory.ingest(agentId, observation, options); }
	recentlySeen(agentId, observation, record, vocabulary) { return this.#memory.recentlySeen(agentId, observation, record, vocabulary); }
	knownSources(agentId, observation, blockPattern) { return this.#memory.knownSources(agentId, observation, blockPattern); }
	ownPlacements(agentId, observation) { return this.#memory.ownPlacements(agentId, observation); }
	recordResourceResult(agentId, observation, result) { this.#memory.recordResourceResult(agentId, observation, result); }
	load(agentId) { return this.#memory.load(agentId); }
	flush(agentId) { return this.#memory.flush(agentId); }
	markBlocked(agentId, dimension, x, z, options = {}) {
		const current = this.#memory.query(agentId);
		this.#memory.markBlocked(agentId, { worldId: options.worldId ?? current.worldId, dimension, x, y: options.y ?? current.position?.y, z, ...options });
	}
	recordSurvey(agentId, observation, options) { this.#memory.recordSurvey(agentId, observation, options); }
	beginTravel(agentId) { this.#memory.beginTravel(agentId); }
	endTravel(agentId, terminal = null) { return this.#memory.endTravel(agentId, terminal); }
	snapshot(agentId, dimension = null, worldId = undefined) {
		const value = this.#memory.query(agentId, { ...(dimension === null ? {} : { dimension }), worldId, limit: 0 });
		return { worldId: value.worldId, dimension: value.dimension, knownCells: value.knownCells, seenCells: value.seenCells, visitedCells: value.visitedCells, blockedCells: value.blockedCells };
	}
	/** Walked, net displacement and revisited places over the recent walk, or null. */
	recentTravel(agentId, observation) {
		const position = observationPosition(observation);
		return position === null ? null : recentTravel(this.#search(agentId, observation).odometer, position);
	}
	/** Compact search facts for a survey result: coverage without candidates. */
	coverage(agentId, observation) {
		const position = observationPosition(observation);
		if (position === null) return null;
		return summarizeSearch(this.#search(agentId, observation), position, { sightingLimit: 3, odometer: false });
	}
	/**
	 * Footing candidates (where the player stood, or seen surfaces whose footing is unverified) with height change, heading and
	 * flags, plus search coverage. Ordered for spread: one per heading per round, farthest first. blockId instead pages
	 * remembered blocks of that exact id, nearest first.
	 */
	candidates(agentId, observation, { radius = DEFAULT_RADIUS, limit = DEFAULT_LIMIT, offset = 0, blockId = null } = {}) {
		if (!Number.isFinite(radius) || radius < MIN_RADIUS || radius > MAX_RADIUS) throw new TypeError(`radius must be ${MIN_RADIUS}..${MAX_RADIUS}`);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new TypeError(`limit must be 1..${MAX_LIMIT}`);
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > 4096) throw new TypeError('offset must be 0..4096');
		if (blockId !== null && (typeof blockId !== 'string' || blockId.length > 256)) throw new TypeError('blockId must be bounded text');
		const position = observationPosition(observation), dimension = observationDimension(observation), worldId = observationWorldId(observation);
		if (position === null) return { dimension, kind: 'no_observation', candidates: [], reason: 'No observed player position.' };
		const known = this.#memory.query(agentId, { worldId, dimension, nowTick: observation?.world?.gameTime, limit: blockId === null ? 0 : 1024, blockId });
		const at = { x: Math.floor(position.x), y: Math.floor(position.y + 1e-3), z: Math.floor(position.z) };
		const horizontal = (x, z) => Math.round(Math.hypot(x + 0.5 - position.x, z + 0.5 - position.z));
		const page = (all) => ({ candidates: all.slice(offset, offset + limit), total: all.length, ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}) });
		if (blockId !== null) {
			const blocks = new Map(known.blocks.map((block) => [block.key, block]));
			for (const block of observedBlocks(observation)) if (block.blockId === blockId) blocks.set(`${block.x},${block.y},${block.z}`, { ...block, stale: false });
			const rows = [...blocks.values()].map((block) => ({ x: block.x, y: block.y, z: block.z, distance: horizontal(block.x, block.z), heading: headingOf(block.x - position.x, block.z - position.z), ...(block.stale ? { stale: true } : {}) }))
				.filter((row) => row.distance <= radius).sort((left, right) => left.distance - right.distance || left.y - right.y);
			return { dimension, kind: 'blocks', blockId, at, ...page(rows) };
		}
		const blocked = blockedCells(known);
		const tick = known.tick;
		const byHeading = new Map(HEADINGS.map((heading) => [heading, []]));
		for (const spot of this.#memory.footings(agentId, { worldId, dimension })) {
			const distance = horizontal(spot.x, spot.z);
			if (distance < NEAR || distance > radius) continue;
			byHeading.get(headingOf(spot.x + 0.5 - position.x, spot.z + 0.5 - position.z)).push({
				x: spot.x, y: spot.y, z: spot.z, footing: spot.footing, dy: spot.y - at.y, distance, heading: headingOf(spot.x + 0.5 - position.x, spot.z + 0.5 - position.z),
				...(spot.visited ? { visited: true } : {}), ...uncertainty(spot, blocked, tick),
			});
		}
		for (const list of byHeading.values()) list.sort((left, right) => right.distance - left.distance || left.y - right.y);
		const ordered = [];
		for (let round = 0; ordered.length < [...byHeading.values()].reduce((sum, list) => sum + list.length, 0); round += 1) {
			for (const heading of ROUND_ROBIN) { const entry = byHeading.get(heading)[round]; if (entry) ordered.push(entry); }
		}
		return { dimension, kind: 'footing', at, ...page(ordered), coverage: summarizeSearch(this.#search(agentId, observation), position, { tick }) };
	}
	/** Up to three observed footings nearest a target, for a destination that had none, with age and blocked flags; no new world reads. */
	knownFooting(agentId, observation, target, limit = 3) {
		if (![target?.x, target?.y, target?.z].every(Number.isFinite)) return [];
		const worldId = observationWorldId(observation), dimension = observationDimension(observation);
		const known = this.#memory.query(agentId, { worldId, dimension, limit: 0 });
		const blocked = blockedCells(known);
		return this.#memory.footings(agentId, { worldId, dimension })
			.map((spot) => ({ x: spot.x, y: spot.y, z: spot.z, footing: spot.footing, fromTarget: Math.round(Math.hypot(spot.x + 0.5 - target.x, spot.y - target.y, spot.z + 0.5 - target.z)), ...uncertainty(spot, blocked, known.tick) }))
			.filter((spot) => spot.fromTarget <= 32).sort((left, right) => left.fromTarget - right.fromTarget).slice(0, limit);
	}
	clear(agentId) { this.#memory.clear(agentId); }
	#search(agentId, observation) {
		return this.#memory.search(agentId, { worldId: observationWorldId(observation), dimension: observationDimension(observation) }) ?? createSearch();
	}
}

function blockedCells(known) { return new Set(known.cells.filter((cell) => cell.blocked).map((cell) => cell.key)); }

/** Recent move failures there, and the age of facts last observed long ago. */
function uncertainty(spot, blocked, tick) {
	const ageTicks = tick - spot.tick;
	return { ...(blocked.has(spatialCellKey(spot.x, spot.y, spot.z)) ? { blocked: true } : {}), ...(ageTicks > OLD_TICKS ? { ageS: Math.round(ageTicks / 20) } : {}) };
}

export const extractPosition = observationPosition;
export const extractDimension = observationDimension;
export function cellKey(x, y, z) { return z === undefined ? `${Math.floor(x / CELL_SIZE)},${Math.floor(y / CELL_SIZE)}` : spatialCellKey(x, y, z); }
