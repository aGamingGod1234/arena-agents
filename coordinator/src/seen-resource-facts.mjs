import { MAX_ENTITIES } from './constants.mjs';

export const RECENT_TICKS = 2400;
export const RECENT_SECONDS = 120;
export const RECENT_BYTES = 600;
export const RECENT_ROWS = 6;
export const MAX_REMEMBERED_ITEMS = 32;
const AIR = /(^|:)(air|cave_air|void_air)$/;
const STOP = new Set(['minecraft', 'gather', 'collect', 'find', 'get', 'one', 'some', 'the', 'and', 'with', 'from', 'make', 'craft', 'build', 'beat', 'game']);
const words = text => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).map(word => word.replace(/s$/, '')).filter(word => word.length >= 3 && !STOP.has(word));

/**
 * Only vocabulary supplied by the goal, its predicate or the model's own active plan steps
 * (exact ids/#tags plus label words); no inferred recipe or plan.
 */
export function resourceFilter(record, vocabulary = null) {
	const ids = new Set();
	const visit = predicate => {
		if (!predicate || typeof predicate !== 'object') return;
		for (const field of ['itemId', 'blockId']) if (typeof predicate[field] === 'string') ids.add(predicate[field]);
		for (const id of predicate.itemIds ?? []) if (typeof id === 'string') ids.add(id);
		for (const child of predicate.predicates ?? []) visit(child);
	};
	visit(record?.currentGoalSpec?.predicate);
	for (const id of vocabulary?.ids ?? []) if (typeof id === 'string') ids.add(id);
	const tokens = new Set([...words(record?.currentGoal ?? record?.currentGoalSpec?.originalRequest), ...words(vocabulary?.text)]);
	return (row, item = false) => {
		const id = item ? row.itemId : row.blockId;
		if (AIR.test(id)) return false;
		if (ids.has(id) || (row.tags ?? []).some(tag => ids.has(tag))) return true;
		const labels = words([id, ...(row.tags ?? [])].join(' '));
		return labels.some(word => tokens.has(word));
	};
}

export function seenAge(row, observation, tick) {
	if (row.lastSeenTick > tick) return null;
	const elapsed = Number.isFinite(observation?.observedAtEpochMs) && Number.isFinite(row.seenAtEpochMs)
		? (observation.observedAtEpochMs - row.seenAtEpochMs) / 1000 : (tick - row.lastSeenTick) / 20;
	return elapsed >= 0 && elapsed <= RECENT_SECONDS && tick - row.lastSeenTick <= RECENT_TICKS ? Math.ceil(elapsed) : null;
}

export function observedItems(observation) {
	if (observation?.continuity?.rememberedSections?.includes('items') || observation?.continuity?.rememberedSections?.includes('entities')) return [];
	const rows = observation?.items ?? observation?.entities?.filter(row => row?.type === 'minecraft:item') ?? [];
	if (rows.length === 0) return [];
	const entities = new Map((observation?.entities ?? []).map(row => [row.stableId ?? row.uuid, row]));
	return rows.flatMap(row => {
		const position = row?.position ?? row;
		const stableId = row?.stableId ?? row?.uuid;
		const velocity = row?.velocity ?? entities.get(stableId)?.velocity;
		return typeof stableId === 'string' && stableId.length <= 256 && typeof row?.itemId === 'string' && row.itemId.length <= 256
			&& Number.isSafeInteger(row.count) && row.count > 0 && [position?.x, position?.y, position?.z].every(Number.isFinite)
			&& row.visible !== false && row.perceivedBy !== 'sound'
			? [{ stableId, itemId: row.itemId, count: row.count, x: position.x, y: position.y, z: position.z,
				...([velocity?.x, velocity?.y, velocity?.z].every(Number.isFinite) ? { moving: Math.hypot(velocity.x, velocity.y, velocity.z) > 1e-6 } : {}),
				...(Array.isArray(row.tags) ? { tags: row.tags.filter(tag => typeof tag === 'string').slice(0, 32) } : {}) }] : [];
	});
}

/** Fresh visible count growth can reconcile one unambiguous, stationary merge donor. */
export function mergedItemSightings(remembered, current, observation, previousTick) {
	const entities = observation?.entities;
	if (!Array.isArray(entities) || entities.length >= MAX_ENTITIES || observation?.coverage?.mode !== 'sampled_visible'
		|| observation.coverage.sections?.entities?.returned !== entities.length
		|| observation.continuity?.rememberedSections?.some(section => ['entities', 'items'].includes(section))) return [];
	const present = new Set(current.map(row => row.stableId));
	const proposals = new Map();
	for (const item of current) {
		const previous = remembered.get(item.stableId);
		if (!previous || previous.lastSeenTick !== previousTick || previous.itemId !== item.itemId || item.count <= previous.count) continue;
		const candidates = [...remembered.values()].filter(row => !present.has(row.stableId) && row.lastSeenTick === previousTick
			&& row.itemId === item.itemId
			&& Math.abs(row.x - item.x) < 0.75 && Math.abs(row.z - item.z) < 0.75 && Math.abs(row.y - item.y) < 0.25);
		// Ambiguous donors or count changes stay historical instead of spending the same growth twice.
		if (candidates.length !== 1 || candidates[0].moving !== false || candidates[0].count !== item.count - previous.count) continue;
		const id = candidates[0].stableId;
		proposals.set(id, (proposals.get(id) ?? 0) + 1);
	}
	return [...proposals].filter(([, count]) => count === 1).map(([id]) => id);
}

/** The hit cell is directly observed; the wire does not establish the geometry of the ray before it. */
export function blockContradictionEvidence(observation) {
	const target = observation?.interaction?.rayTarget;
	if (target?.type !== 'block' || typeof target.blockId !== 'string'
		|| ![target.x, target.y, target.z].every(Number.isSafeInteger)
		|| observation.continuity?.rememberedSections?.includes('interaction')) return null;
	return { keys: [`${target.x},${target.y},${target.z}`], contradicts: row => row.blockId !== target.blockId };
}

export function observedBlocks(observation) {
	const result = new Map();
	for (const [section, list] of [['landmarks', observation?.landmarks], ['nearbyContainers', observation?.nearbyContainers], ['blocks', observation?.nearby?.blocks], ['blocks', observation?.blocks]]) {
		if (observation?.continuity?.rememberedSections?.includes(section)) continue;
		for (const block of Array.isArray(list) ? list : []) {
			const position = block?.position ?? block;
			if (!position || ![position.x, position.y, position.z].every(Number.isFinite) || typeof block.blockId !== 'string' || block.blockId.length > 256 || block.visible === false || block.stale === true || block.perceivedBy === 'sound') continue;
			const key = `${position.x},${position.y},${position.z}`;
			const previous = result.get(key);
			const blockState = observedBlockState(block) ?? (previous?.blockId === block.blockId ? previous.blockState : undefined);
			const fullCube = Array.isArray(block.bounds) && block.boundsTruncated === false
				? block.bounds.some(box => box?.minX === 0 && box.minY === 0 && box.minZ === 0 && box.maxX === 1 && box.maxY === 1 && box.maxZ === 1)
				: previous?.blockId === block.blockId ? previous.fullCube : undefined;
			result.set(key, { x: position.x, y: position.y, z: position.z, blockId: block.blockId, ...(Array.isArray(block.tags) ? { tags: block.tags.filter(tag => typeof tag === 'string').slice(0, 32) } : {}), ...(fullCube !== undefined ? { fullCube } : {}), ...(blockState ? { blockState } : {}),
				// A row may report when it was itself observed; evidence consumers compare that clock, not the sample's.
				...(Number.isFinite(block.lastSeenTick) ? { lastSeenTick: block.lastSeenTick } : {}), ...(Number.isFinite(block.observedAtEpochMs) ? { observedAtEpochMs: block.observedAtEpochMs } : {}) });
		}
	}
	return [...result.values()];
}

function observedBlockState(block) {
	// The wire carries a property map; sort it so serialization order cannot clear failures.
	if (block.state && typeof block.state === 'object' && !Array.isArray(block.state) && Object.values(block.state).every((value) => typeof value === 'string')) {
		return JSON.stringify(Object.fromEntries(Object.entries(block.state).sort(([left], [right]) => left.localeCompare(right)))).slice(0, 1024);
	}
	return typeof block.blockState === 'string' ? block.blockState.slice(0, 1024) : undefined;
}
