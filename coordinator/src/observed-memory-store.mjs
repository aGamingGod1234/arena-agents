import { MAX_REMEMBERED_ITEMS, RECENT_BYTES, RECENT_ROWS, mergedItemSightings, observedBlocks, observedItems, resourceFilter, seenAge } from './seen-resource-facts.mjs';
import { FactLifecycle, ageText, deadSample, directBlockEvidence, evidenceClock, freshEvidence, invalidated } from './fact-provenance.mjs';
export { observedBlocks } from './seen-resource-facts.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileTurn } from './file-turns.mjs';
import { advanceTravel, contradictSightings, contradictSurface, createSearch, recordPlacement, finishTravel, footings, observeSearch, recordLook, recordSightings, restoreSearch, seenWith, serializeSearch, startTravel } from './search-coverage.mjs';

export const CELL_SIZE = 8;
const SESSION_WORLD = `session:${randomUUID()}`;
const MAX_FILE_BYTES = 4_194_304;
const MAX_RAY_DISPROOFS = 256;

export function observationWorldId(observation) {
	const value = observation?.world?.worldId ?? observation?.worldId;
	return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : SESSION_WORLD;
}

// A sample without a dimension stays unknown: it never joins, or persists into, a real dimension's facts.
export const UNKNOWN_DIMENSION = 'unknown';

export function observationDimension(observation) {
	const value = observation?.world?.dimension ?? observation?.world?.dimensionId;
	return typeof value === 'string' && value.length > 0 ? (value.includes(':') ? value : `minecraft:${value}`) : UNKNOWN_DIMENSION;
}

export function observationPosition(observation) {
	const value = observation?.position ?? observation?.player?.position ?? observation?.player;
	return value && [value.x, value.y, value.z].every(Number.isFinite) ? { x: value.x, y: value.y, z: value.z } : null;
}

export function spatialCellKey(x, y, z) {
	return [x, y, z].map((value) => Math.floor(value / CELL_SIZE)).join(',');
}

/** One coordinator instance owns each agent file; writes replace complete bounded records. */
export class AtomicAgentStore {
	#directory; #namespace; #writes = new Map(); #partition; #persistedParts = new Map();
	constructor({ directory = null, namespace, partition = null }) {
		this.#directory = directory === null ? null : resolve(directory);
		this.#namespace = namespace;
		this.#partition = partition;
	}
	async read(agentId) {
		if (this.#directory === null) return null;
		await this.#writes.get(agentId);
		const saved = await this.#readRecord(agentId);
		const keys = saved === null ? null : this.#partition?.keys(saved);
		if (keys == null) return saved;
		const parts = new Map();
		for (const key of keys) parts.set(key, await this.#readRecord(this.#partitionKey(agentId, key)));
		return this.#partition.join(saved, parts);
	}
	async #readRecord(agentId) {
		try {
			const file = this.#path(agentId), bytes = await fileTurn(file, () => readFile(file));
			if (bytes.length > MAX_FILE_BYTES) throw new Error('MEMORY_FILE_TOO_LARGE');
			return JSON.parse(bytes.toString('utf8'));
		} catch (error) { if (error.code === 'ENOENT') return null; throw error; }
	}
	write(agentId, value) {
		if (this.#directory === null) return Promise.resolve();
		// Capture every owner record before yielding, preserving snapshot/ACK fences.
		const split = this.#partition?.split(value);
		const encoded = JSON.stringify(split?.manifest ?? value);
		const parts = split ? [...split.parts].map(([key, part]) => [this.#partitionKey(agentId, key), JSON.stringify(part)]) : [];
		if ([encoded, ...parts.map(([, bytes]) => bytes)].some(bytes => Buffer.byteLength(bytes) > MAX_FILE_BYTES)) return Promise.reject(new Error('MEMORY_FILE_TOO_LARGE'));
		const previous = this.#writes.get(agentId) ?? Promise.resolve();
		const pending = previous.catch(() => {}).then(async () => {
			await mkdir(this.#directory, { recursive: true });
			for (const [key, bytes] of parts) {
				const fingerprint = createHash('sha256').update(bytes).digest('hex');
				if (this.#persistedParts.get(key) === fingerprint) continue;
				await this.#writeRecord(key, bytes);
				this.#persistedParts.set(key, fingerprint);
			}
			// Publish new owners only after their files. Legacy manifests remain intact
			// on migration failure; existing owners are independently atomic records.
			await this.#writeRecord(agentId, encoded);
		});
		this.#writes.set(agentId, pending);
		return pending.finally(() => { if (this.#writes.get(agentId) === pending) this.#writes.delete(agentId); });
	}
	#partitionKey(agentId, key) { return `part:${createHash('sha256').update(JSON.stringify([agentId, key])).digest('hex')}`; }
	#writeRecord(agentId, encoded) {
		const target = this.#path(agentId);
		return fileTurn(target, async () => {
			const temporary = `${target}.${randomUUID()}.tmp`;
			try {
				const file = await open(temporary, 'wx', 0o600);
				try { await file.writeFile(encoded, 'utf8'); await file.sync(); } finally { await file.close(); }
				await rename(temporary, target);
			} finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
		});
	}
	#path(agentId) {
		if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 256) throw new TypeError('agentId must be bounded text');
		return join(this.#directory, `${this.#namespace}-${createHash('sha256').update(agentId).digest('hex')}.json`);
	}
}

const FLUIDS = new Set(['minecraft:lava', 'minecraft:water']);
// The server's own bucket receipt for use_item (BucketUse): the cell the empty bucket's source-only ray met and the hand change.
const BUCKET_USE = /bucket ray met (minecraft:(?:lava|water)) source at (-?\d+),(-?\d+),(-?\d+) face [a-z]+ \([0-9.]+ m\); hand minecraft:bucket -> (minecraft:(?:lava|water))_bucket(?:;|$)/;

/**
 * The fluid source cell a successful empty-bucket use took, or null. interact_block with an empty bucket succeeds only
 * when the bucket's source-only ray met exactly the requested cell, so its arguments name the cell; it counts only where
 * memory already holds that cell as a fluid (a remembered block or a lava sighting). use_item names the cell and the
 * hand change in its receipt; both must agree.
 */
function bucketFill({ actionType, args, state, reasonCode, message }, scope) {
	if (state !== 'SUCCEEDED') return null;
	if (actionType === 'use_item' && reasonCode === 'USE_INPUT_CONFIRMED' && typeof message === 'string') {
		const met = BUCKET_USE.exec(message);
		return met && met[1] === met[5] ? { x: Number(met[2]), y: Number(met[3]), z: Number(met[4]) } : null;
	}
	if (actionType !== 'interact_block' || args?.expectedItemId !== 'minecraft:bucket' || ![args.x, args.y, args.z].every(Number.isSafeInteger)) return null;
	const key = `${args.x},${args.y},${args.z}`;
	const remembered = FLUIDS.has(scope.blocks.get(key)?.blockId)
		|| [...scope.search.sightings.values()].some((row) => row.kind === 'lava' && row.x === args.x && row.y === args.y && row.z === args.z);
	return remembered ? { x: args.x, y: args.y, z: args.z } : null;
}

/** Retains only observations and action failures, partitioned by world, dimension and height. */
export class ObservedMemoryStore {
	#agents = new Map(); #loads = new Map(); #loaded = new Set(); #epochs = new Map(); #lifecycles = new Map(); #disk; #maximumCells; #maximumBlocks; #maximumScopes; #staleAfterTicks; #blockedForTicks;
	constructor({ directory = null, maximumCells = 256, maximumBlocks = 1024, maximumScopes = 16, staleAfterTicks = 1200, blockedForTicks = 200 } = {}) {
		for (const value of [maximumCells, maximumBlocks, maximumScopes, staleAfterTicks, blockedForTicks]) {
			if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('memory bounds must be positive integers');
		}
		if (maximumCells > 2048 || maximumBlocks > 2048 || maximumScopes > 32) throw new TypeError('memory capacity exceeds the durable record budget');
		this.#disk = new AtomicAgentStore({ directory, namespace: 'observed' });
		this.#maximumCells = maximumCells; this.#maximumBlocks = maximumBlocks; this.#maximumScopes = maximumScopes;
		this.#staleAfterTicks = staleAfterTicks; this.#blockedForTicks = blockedForTicks;
	}
	load(agentId) {
		if (this.#loaded.has(agentId)) return Promise.resolve();
		if (this.#loads.has(agentId)) return this.#loads.get(agentId);
		const pending = this.#load(agentId, this.#epochs.get(agentId) ?? 0);
		this.#loads.set(agentId, pending);
		return pending.finally(() => { if (this.#loads.get(agentId) === pending) this.#loads.delete(agentId); });
	}
	async #load(agentId, epoch) {
		const saved = await this.#disk.read(agentId);
		if ((this.#epochs.get(agentId) ?? 0) !== epoch) return;
		if (saved === null) { this.#loaded.add(agentId); return; }
		if (saved.version !== 1 || !Array.isArray(saved.scopes)) throw new Error('INVALID_OBSERVED_MEMORY');
		const scopes = new Map();
		for (const scope of saved.scopes.slice(-this.#maximumScopes)) {
			if (typeof scope.worldId !== 'string' || typeof scope.dimension !== 'string' || !Array.isArray(scope.cells) || !Array.isArray(scope.blocks) || !Number.isSafeInteger(scope.tick)) throw new Error('INVALID_OBSERVED_MEMORY');
			if (scope.worldId.startsWith('session:') || scope.dimension === UNKNOWN_DIMENSION) continue;
			const cells = new Map(scope.cells.filter(validCell).slice(-this.#maximumCells).map((cell) => [cell.key, projectCell(cell)]));
			const blocks = new Map(scope.blocks.filter(validBlock).slice(-this.#maximumBlocks).map((block) => [block.key, projectBlock(block)]));
			const search = restoreSearch(scope.search);
			// A saved surface that saved blocks disprove is dropped now, before those block records can be evicted.
			for (const block of blocks.values()) if (search.surfaceCells.size > 0) contradictSurface(search, block.key, block.blockId);
			scopes.set(scopeKey(scope.worldId, scope.dimension), { worldId: scope.worldId, dimension: scope.dimension, tick: scope.tick, position: observationPosition({ position: scope.position }), cells, blocks, items: new Map(), search });
		}
		const live = this.#agents.get(agentId);
		if (live) for (const [key, scope] of live.scopes) {
			const previous = scopes.get(key);
			const merged = previous && scope.tick >= previous.tick ? {
				...scope, cells: new Map([...previous.cells, ...scope.cells]), blocks: new Map([...previous.blocks, ...scope.blocks]),
			} : scope;
			scopes.delete(key); scopes.set(key, merged);
		}
		trim(scopes, this.#maximumScopes);
		const agent = { scopes, current: live?.current ?? null };
		this.#bound(agent);
		this.#agents.set(agentId, agent);
		this.#loaded.add(agentId);
	}
	async flush(agentId) {
		const epoch = this.#epochs.get(agentId) ?? 0;
		await this.load(agentId);
		if ((this.#epochs.get(agentId) ?? 0) !== epoch) return;
		const agent = this.#agents.get(agentId);
		// Drops may move or despawn while offline, so only durable block sightings are restored.
		return this.#disk.write(agentId, { version: 1, scopes: agent ? [...agent.scopes.values()].filter((scope) => !scope.worldId.startsWith('session:') && scope.dimension !== UNKNOWN_DIMENSION).map(({ items: _transientDrops, rayDisproofs: _sessionDisproofs, sampleWallMs: _sessionWall, ...scope }) => ({ ...scope, cells: [...scope.cells.values()], blocks: [...scope.blocks.values()], search: serializeSearch(scope.search) })) : [] });
	}
	ingest(agentId, observation, { snapshot = true, admitted = false } = {}) {
		const worldId = observationWorldId(observation), dimension = observationDimension(observation);
		const agent = this.#agent(agentId);
		const key = scopeKey(worldId, dimension);
		let scope = agent.scopes.get(key);
		const tick = Number.isSafeInteger(observation?.world?.gameTime) && observation.world.gameTime >= 0 ? observation.world.gameTime : (scope?.tick ?? 0) + 1;
		const wall = Number.isFinite(observation?.observedAtEpochMs) ? observation.observedAtEpochMs : null;
		// `admitted`: the caller already ordered this sample by the producer's authoritative event sequence (the native
		// runtime rejects older ones), so a lower tick can only be a real rollback; wall clocks may be skewed and are not
		// consulted. Without that ordering, a lower tick with an older (or equal) wall time is taken as a delayed sample.
		if (!admitted && scope && tick < scope.tick && wall !== null && Number.isFinite(scope.sampleWallMs) && wall <= scope.sampleWallMs) {
			return snapshot ? this.query(agentId, { worldId, dimension }) : undefined;
		}
		if (!scope || tick < scope.tick) scope = { worldId, dimension, tick, position: null, cells: new Map(), blocks: new Map(), items: new Map(), search: createSearch() };
		if (wall !== null && !(scope.sampleWallMs >= wall)) scope.sampleWallMs = wall;
		const previousTick = agent.current === key ? scope.tick : null;
		scope.tick = tick;
		if (!this.#lifecycles.has(agentId)) this.#lifecycles.set(agentId, new FactLifecycle());
		const change = this.#lifecycles.get(agentId).observe(observation);
		// Entering a scope (portal, world change, restart, or a sample without a dimension) continues no earlier motion in it,
		// nor does a body that died or respawned; coverage stays.
		if (agent.current !== key || invalidated('body', change)) scope.search.motion = null;
		agent.current = key;
		agent.scopes.delete(key); agent.scopes.set(key, scope);
		trim(agent.scopes, this.#maximumScopes);
		const position = observationPosition(observation);
		if (position !== null) {
			scope.position = position;
			this.#cell(scope, position, { visited: true });
		}
		const evidence = directBlockEvidence(observation);
		for (const block of evidence.values()) {
			if (block.via !== 'row') continue;
			const key = `${block.x},${block.y},${block.z}`;
			const previous = scope.blocks.get(key);
			// A row reporting an older observation than the stored one cannot replace it; a newer row stores its own time.
			const clock = evidenceClock(block, observation);
			if (previous && !freshEvidence({ lastSeenTick: previous.lastSeenTick, observedAtEpochMs: previous.seenAtEpochMs }, clock)) continue;
			// A crosshair disproof removed the block but keeps its clock: an older row cannot bring it back.
			const disproved = scope.rayDisproofs?.get(key);
			if (!previous && disproved && !freshEvidence(disproved, clock)) continue;
			scope.rayDisproofs?.delete(key);
			const rowTick = Number.isSafeInteger(block.lastSeenTick) && block.lastSeenTick <= tick ? block.lastSeenTick : tick;
			const rowEpoch = Number.isFinite(block.observedAtEpochMs) ? block.observedAtEpochMs : observation.observedAtEpochMs;
			const sameBlock = previous?.blockId === block.blockId;
			// Landmark/container summaries can omit properties; absence is not a state change.
			const blockState = block.blockState ?? (sameBlock ? previous.blockState : undefined);
			const blockStateObservedTick = block.blockState !== undefined ? rowTick : previous?.blockStateObservedTick ?? previous?.lastSeenTick;
			const changed = previous !== undefined && (!sameBlock || previous.blockState !== undefined && block.blockState !== undefined && previous.blockState !== block.blockState);
			this.#cell(scope, block, { seen: true, changed });
			// Checked when a block's identity is new or changed: its record can be evicted long before the sector's surface.
			if (!sameBlock && scope.search.surfaceCells.size > 0) contradictSurface(scope.search, key, block.blockId);
			scope.blocks.delete(key);
			scope.blocks.set(key, { key, x: block.x, y: block.y, z: block.z, blockId: block.blockId, ...(block.tags ? { tags: block.tags } : sameBlock && previous.tags ? { tags: previous.tags } : {}),
				...(block.fullCube !== undefined ? { fullCube: block.fullCube } : sameBlock && !changed && previous.fullCube !== undefined ? { fullCube: previous.fullCube } : {}),
				...(Number.isFinite(rowEpoch) ? { seenAtEpochMs: rowEpoch } : {}), ...(blockState ? { blockState, blockStateObservedTick } : {}), firstSeenTick: Math.min(previous?.firstSeenTick ?? rowTick, rowTick), lastSeenTick: rowTick });
		}
		// The rows were stored above; the crosshair's hit cell, the other direct evidence, can only disprove.
		for (const [key, hit] of evidence) {
			const block = hit.via === 'ray' ? scope.blocks.get(key) : undefined;
			if (block && block.lastSeenTick !== tick && block.blockId !== hit.blockId && freshEvidence({ lastSeenTick: block.lastSeenTick, observedAtEpochMs: block.seenAtEpochMs }, evidenceClock(hit, observation))) {
				scope.blocks.delete(key);
				// Session-only and bounded: enough to order delayed rows against this disproof.
				scope.rayDisproofs ??= new Map();
				scope.rayDisproofs.delete(key);
				scope.rayDisproofs.set(key, evidenceClock(hit, observation));
				trim(scope.rayDisproofs, MAX_RAY_DISPROOFS);
				contradictSurface(scope.search, key, 'unknown');
			}
		}
		trim(scope.blocks, this.#maximumBlocks);
		const currentItems = observedItems(observation);
		for (const id of mergedItemSightings(scope.items, currentItems, observation, previousTick)) scope.items.delete(id);
		for (const item of currentItems) {
			scope.items.delete(item.stableId);
			scope.items.set(item.stableId, { ...item, lastSeenTick: tick,
				...(Number.isFinite(observation.observedAtEpochMs) ? { seenAtEpochMs: observation.observedAtEpochMs } : {}) });
		}
		trim(scope.items, MAX_REMEMBERED_ITEMS);
		// This sample's direct evidence (rows and the crosshair's hit, at their own ticks) unless the remembered row is
		// newer: a stale row in this sample must not outrank the later observation that withdrew a sighting.
		const sightingAt = (x, y, z) => {
			const block = evidence.get(`${x},${y},${z}`), stored = scope.blocks.get(`${x},${y},${z}`);
			if (block === undefined) return stored;
			if (stored !== undefined && !freshEvidence({ lastSeenTick: stored.lastSeenTick, observedAtEpochMs: stored.seenAtEpochMs }, evidenceClock(block, observation))) return stored;
			return { blockId: block.blockId, lastSeenTick: Number.isSafeInteger(block.lastSeenTick) && block.lastSeenTick <= tick ? block.lastSeenTick : tick };
		};
		if (position !== null) {
			// After this sample's blocks, so a block it shows above a seen top already counts.
			const sample = observeSearch(scope.search, observation, position, tick, blockLookup(scope), sightingAt);
			if (agent.travel?.scope === key) advanceTravel(agent.travel.measure, sample);
		} else recordSightings(scope.search, observation?.sighted && typeof observation.sighted === 'object' ? observation.sighted : {}, tick, sightingAt, seenWith(observation));
		// After this sample's sightings are recorded: a vein, lava pool or point of interest whose own block a row now
		// shows as something else is gone, even if a cached row in the same sample still names it.
		if (scope.search.sightings.size > 0 && evidence.size > 0) contradictSightings(scope.search, (x, y, z) => {
			const block = evidence.get(`${x},${y},${z}`);
			if (block === undefined) return undefined;
			return { blockId: block.blockId, tick: Number.isSafeInteger(block.lastSeenTick) && block.lastSeenTick <= tick ? block.lastSeenTick : tick };
		});
		this.#bound(agent);
		// Observation-only callers can skip copying every retained cell and block.
		if (snapshot) return this.query(agentId, { worldId, dimension });
	}
	/** Compact past sightings for the current goal, distinct from current perception. */
	recentlySeen(agentId, observation, record = {}, vocabulary = null) {
		if (observation?.ready === false || observation?.death || deadSample(observation)) return null;
		const scope = this.#agents.get(agentId)?.scopes.get(scopeKey(observationWorldId(observation), observationDimension(observation)));
		if (!scope) return null;
		const tick = observation?.world?.gameTime ?? scope.tick;
		const relevant = resourceFilter(record, vocabulary);
		const currentBlocks = observedBlocks(observation);
		const visibleBlocks = new Set(currentBlocks.map(row => `${row.x},${row.y},${row.z}`));
		const visibleItems = new Set(observedItems(observation).map(row => row.stableId));
		const candidates = [];
		for (const [kind, values] of [['blocks', scope.blocks], ['items', scope.items]]) {
			for (const row of values.values()) {
				const item = kind === 'items';
				if ((item ? visibleItems : visibleBlocks).has(item ? row.stableId : row.key) || !relevant(row, item)) continue;
				const ageS = seenAge(row, observation, tick);
				if (ageS === null) continue;
				candidates.push({ kind, tick: row.lastSeenTick, row: {
					...(item ? { stableId: row.stableId, itemId: row.itemId, count: row.count } : { blockId: row.blockId }),
					x: item ? Math.round(row.x * 10) / 10 : row.x, y: item ? Math.round(row.y * 10) / 10 : row.y, z: item ? Math.round(row.z * 10) / 10 : row.z, src: `seen ${ageText(ageS)}`,
				} });
			}
		}
		candidates.sort((a, b) => b.tick - a.tick || a.kind.localeCompare(b.kind));
		// Each row's src says it is a sighting and how old; it may have changed since.
		const result = {};
		let count = 0;
		const blockIds = new Set();
		for (const { kind, row } of candidates) {
			if (kind === 'blocks' && blockIds.has(row.blockId)) continue;
			const rows = result[kind] ?? [];
			if (Buffer.byteLength(JSON.stringify({ ...result, [kind]: [...rows, row] })) > RECENT_BYTES) continue;
			result[kind] = [...rows, row];
			if (kind === 'blocks') blockIds.add(row.blockId);
			if (++count >= RECENT_ROWS) break;
		}
		return count === 0 ? null : result;
	}
	/** An action the player attempted can disprove the target without revealing any new world state. */
	recordResourceResult(agentId, observation, { actionType, arguments: args, state, reasonCode, message = null, observedAtEpochMs = null }) {
		const scope = this.#agents.get(agentId)?.scopes.get(scopeKey(observationWorldId(observation), observationDimension(observation)));
		if (!scope) return;
		const filled = bucketFill({ actionType, args, state, reasonCode, message }, scope);
		if (filled !== null) {
			// The bucket took this source: a remembered fluid block or lava sighting there is gone, and a delayed row older
			// than this receipt cannot bring it back.
			const key = `${filled.x},${filled.y},${filled.z}`;
			if (FLUIDS.has(scope.blocks.get(key)?.blockId)) scope.blocks.delete(key);
			scope.rayDisproofs ??= new Map();
			scope.rayDisproofs.delete(key);
			scope.rayDisproofs.set(key, evidenceClock(Number.isFinite(observedAtEpochMs) ? { observedAtEpochMs } : {}, observation));
			trim(scope.rayDisproofs, MAX_RAY_DISPROOFS);
			contradictSightings(scope.search, (x, y, z) => x === filled.x && y === filled.y && z === filled.z ? { blockId: 'minecraft:air', tick: scope.tick } : undefined);
		}
		if (actionType === 'pick_up_item' && (state === 'SUCCEEDED' && ['ITEM_PICKED_UP', 'ITEM_ALREADY_PICKED_UP'].includes(reasonCode) || ['ITEM_NOT_FOUND', 'ITEM_UNAVAILABLE'].includes(reasonCode))) {
			scope.items.delete(args?.targetSelector);
		}
		// Its own placements are not discoveries: built clusters of them are never sightings.
		if (actionType === 'place_block' && state === 'SUCCEEDED' && reasonCode === 'BLOCK_PLACED' && args) recordPlacement(scope.search, { x: args.x, y: args.y, z: args.z, blockId: args.itemId });
		if (actionType === 'break_block' && state === 'SUCCEEDED' && reasonCode === 'BLOCK_BROKEN' && args) {
			recordPlacement(scope.search, args, false);
			const key = `${args.x},${args.y},${args.z}`;
			scope.blocks.delete(key);
			contradictSurface(scope.search, key, 'minecraft:air');
			contradictSightings(scope.search, (x, y, z) => x === args.x && y === args.y && z === args.z ? { blockId: 'minecraft:air', tick: scope.tick } : undefined);
		}
	}
	markBlocked(agentId, { worldId, dimension, x, y, z, tick, reasonCode = 'PATH_BLOCKED' }) {
		const agent = this.#agents.get(agentId);
		const scope = agent?.scopes.get(scopeKey(worldId, dimension));
		if (!scope || ![x, y, z].every(Number.isFinite)) return;
		const cell = this.#cell(scope, { x, y, z }, {});
		cell.blockedAtTick = Number.isSafeInteger(tick) ? tick : scope.tick;
		cell.blockedUntilTick = cell.blockedAtTick + this.#blockedForTicks;
		cell.reasonCode = String(reasonCode).slice(0, 128);
		this.#bound(agent);
	}
	query(agentId, { worldId, dimension, nowTick, blockId = null, limit = 1024 } = {}) {
		if (nowTick !== undefined && (!Number.isSafeInteger(nowTick) || nowTick < 0)) throw new TypeError('nowTick must be a nonnegative integer');
		if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a nonnegative integer');
		const agent = this.#agents.get(agentId);
		const current = agent?.scopes.get(agent.current);
		worldId ??= current?.worldId ?? SESSION_WORLD;
		dimension ??= current?.dimension ?? UNKNOWN_DIMENSION;
		const scope = agent?.scopes.get(scopeKey(worldId, dimension));
		const tick = nowTick ?? scope?.tick ?? 0;
		const cells = scope ? [...scope.cells.values()].map((cell) => ({ ...cell, blocked: (cell.blockedUntilTick ?? -1) > tick, stale: tick - cell.lastObservedTick > this.#staleAfterTicks })) : [];
		const blocks = scope && limit > 0 ? [...scope.blocks.values()].filter((block) => blockId === null || block.blockId === blockId).slice(-Math.min(limit, this.#maximumBlocks)).map((block) => {
			const value = { ...block, stale: tick - block.lastSeenTick > this.#staleAfterTicks };
			// Identity-only sightings cannot make old door/container properties current again.
			if (tick - (block.blockStateObservedTick ?? block.lastSeenTick) > this.#staleAfterTicks) delete value.blockState;
			return value;
		}) : [];
		return { worldId, dimension, tick, position: scope?.position ? { ...scope.position } : null, cells, blocks, knownCells: cells.length, seenCells: cells.filter((cell) => cell.seen).length, visitedCells: cells.filter((cell) => cell.visited).length, blockedCells: cells.filter((cell) => cell.blocked).length };
	}
	/** The coverage record of one scope, or null; callers must not mutate it. */
	search(agentId, { worldId, dimension } = {}) {
		const agent = this.#agents.get(agentId);
		const current = agent?.scopes.get(agent.current);
		return agent?.scopes.get(scopeKey(worldId ?? current?.worldId, dimension ?? current?.dimension))?.search ?? null;
	}
	/**
	 * Remembered sources in the observation's world and dimension: every kept sighting, remembered blocks whose id
	 * matches blockPattern, and where the player recently stood (trail). Rows are copies with their last-seen tick; they
	 * may have changed since.
	 */
	knownSources(agentId, observation, blockPattern = null) {
		const scope = this.#agents.get(agentId)?.scopes.get(scopeKey(observationWorldId(observation), observationDimension(observation)));
		if (!scope) return null;
		const blocks = [];
		if (blockPattern instanceof RegExp) for (const block of scope.blocks.values()) if (blockPattern.test(block.blockId)) blocks.push({ blockId: block.blockId, x: block.x, y: block.y, z: block.z, ...(block.blockState ? { blockState: block.blockState } : {}), tick: block.lastSeenTick });
		return { sightings: [...scope.search.sightings.values()].map((row) => ({ ...row })), blocks, placed: [...scope.search.placed.values()],
			trail: [...scope.search.trail.values()].map(({ x, z }) => ({ x, z })), tick: scope.tick };
	}
	/** Blocks the agent placed in the observation's world and dimension, as { x, y, z, blockId }. */
	ownPlacements(agentId, observation) {
		const scope = this.#agents.get(agentId)?.scopes.get(scopeKey(observationWorldId(observation), observationDimension(observation)));
		return scope ? [...scope.search.placed.values()] : [];
	}
	/** Observed footing of one scope, with surfaces later seen changed or covered left out. */
	footings(agentId, { worldId, dimension } = {}) {
		const agent = this.#agents.get(agentId);
		const current = agent?.scopes.get(agent.current);
		const scope = agent?.scopes.get(scopeKey(worldId ?? current?.worldId, dimension ?? current?.dimension));
		return scope ? footings(scope.search, blockLookup(scope)) : [];
	}
	/** Records one completed survey attempt at the pose and range the server reported, and the structures it returned. */
	recordSurvey(agentId, observation, { attempt = null, survey = null } = {}) {
		const agent = this.#agents.get(agentId);
		const scope = agent?.scopes.get(scopeKey(observationWorldId(observation), observationDimension(observation)));
		if (!scope) return;
		if (attempt !== null) recordLook(scope.search, { ...attempt, tick: Number.isSafeInteger(attempt.tick) ? attempt.tick : scope.tick });
		if (survey && typeof survey === 'object') recordSightings(scope.search, survey, scope.tick, blockLookup(scope), { dimension: observationDimension(observation) });
	}
	/** Starts measuring one move from the latest sample of the current scope. */
	beginTravel(agentId) {
		const agent = this.#agents.get(agentId);
		if (!agent) return;
		const scope = agent.scopes.get(agent.current);
		const measure = scope ? startTravel(scope.search) : null;
		agent.travel = measure === null ? null : { scope: agent.current, measure };
	}
	/**
	 * Feet displacement and sampled ground changes since beginTravel, folding in the terminal sample once; null after a
	 * death, teleport or scope change.
	 */
	endTravel(agentId, terminal = null) {
		const agent = this.#agents.get(agentId);
		const travel = agent?.travel;
		if (agent) agent.travel = null;
		if (!travel || agent.current !== travel.scope) return null;
		const scope = agent.scopes.get(travel.scope);
		if (!scope) return null;
		// Action results carry only position and worldTick; a full sample also names its world and dimension.
		if (terminal?.world !== undefined && (observationWorldId(terminal) !== scope.worldId || observationDimension(terminal) !== scope.dimension)) return null;
		const position = terminal === null ? null : observationPosition(terminal);
		const gameTime = terminal?.worldTick ?? terminal?.world?.gameTime;
		return finishTravel(travel.measure, scope.search, position === null ? null : { observation: terminal, position, tick: Number.isSafeInteger(gameTime) ? gameTime : null });
	}
	clear(agentId) {
		for (const id of agentId === undefined ? new Set([...this.#agents.keys(), ...this.#loads.keys(), ...this.#loaded]) : [agentId]) {
			this.#agents.delete(id); this.#loaded.delete(id); this.#loads.delete(id); this.#lifecycles.delete(id);
			this.#epochs.set(id, (this.#epochs.get(id) ?? 0) + 1);
		}
	}
	#bound(agent) {
		for (const [field, maximum] of [['cells', this.#maximumCells], ['blocks', this.#maximumBlocks], ['items', MAX_REMEMBERED_ITEMS]]) {
			let excess = [...agent.scopes.values()].reduce((sum, scope) => sum + scope[field].size, 0) - maximum;
			for (const scope of agent.scopes.values()) {
				while (excess > 0 && scope[field].size > 0) { scope[field].delete(scope[field].keys().next().value); excess--; }
				if (excess <= 0) break;
			}
		}
	}
	#agent(agentId) {
		let agent = this.#agents.get(agentId);
		if (!agent) { agent = { scopes: new Map(), current: null }; this.#agents.set(agentId, agent); }
		return agent;
	}
	#cell(scope, position, { seen = false, visited = false, changed = false }) {
		const key = spatialCellKey(position.x, position.y, position.z);
		const cell = scope.cells.get(key) ?? { key, seen: false, visited: false, firstObservedTick: scope.tick };
		cell.seen ||= seen; cell.visited ||= visited;
		cell.lastObservedTick = scope.tick;
		if (seen) cell.lastSeenTick = scope.tick;
		if (visited) cell.lastVisitedTick = scope.tick;
		if (visited || changed) { delete cell.blockedAtTick; delete cell.blockedUntilTick; delete cell.reasonCode; }
		scope.cells.delete(key); scope.cells.set(key, cell); trim(scope.cells, this.#maximumCells);
		return cell;
	}
}

function blockLookup(scope) {
	return (x, y, z) => scope.blocks.get(`${x},${y},${z}`);
}

function scopeKey(worldId, dimension) { return JSON.stringify([worldId, dimension]); }
function trim(map, maximum) { while (map.size > maximum) map.delete(map.keys().next().value); }
function validCell(cell) { return cell && typeof cell.key === 'string' && /^-?\d+,-?\d+,-?\d+$/.test(cell.key) && Number.isSafeInteger(cell.lastObservedTick) && typeof cell.seen === 'boolean' && typeof cell.visited === 'boolean'; }
function validBlock(block) { return block && typeof block.key === 'string' && [block.x, block.y, block.z].every(Number.isFinite) && typeof block.blockId === 'string' && block.blockId.length <= 256 && Number.isSafeInteger(block.lastSeenTick); }
function projectCell(cell) {
	return Object.fromEntries(['key', 'seen', 'visited', 'firstObservedTick', 'lastObservedTick', 'lastSeenTick', 'lastVisitedTick', 'blockedAtTick', 'blockedUntilTick', 'reasonCode'].filter((field) => cell[field] !== undefined).map((field) => [field, cell[field]]));
}
function projectBlock(block) {
	return { key: block.key, x: block.x, y: block.y, z: block.z, blockId: block.blockId, ...(typeof block.fullCube === 'boolean' ? { fullCube: block.fullCube } : {}), ...(Array.isArray(block.tags) ? { tags: block.tags.filter(tag => typeof tag === 'string').slice(0, 32) } : {}), ...(Number.isFinite(block.seenAtEpochMs) ? { seenAtEpochMs: block.seenAtEpochMs } : {}), ...(typeof block.blockState === 'string' ? { blockState: block.blockState.slice(0, 1024), blockStateObservedTick: Number.isSafeInteger(block.blockStateObservedTick) && block.blockStateObservedTick >= 0 && block.blockStateObservedTick <= block.lastSeenTick ? block.blockStateObservedTick : block.lastSeenTick } : {}), firstSeenTick: block.firstSeenTick, lastSeenTick: block.lastSeenTick };
}
