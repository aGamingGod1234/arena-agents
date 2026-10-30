export const MAX_RESOURCE_SIGHTINGS = 8;
export const MAX_RESOURCE_SIGHTING_BYTES = 1536;

const RESOURCE_SUFFIXES = ['_log', '_wood', '_ore', '_crop', '_crops', '_flower', '_mushroom',
	'crafting_table', 'furnace', 'chest', 'barrel', 'hay_block', 'pumpkin', 'melon'];
const RESOURCE_TAGS = new Set(['#minecraft:logs', '#minecraft:ores', '#minecraft:crops', '#minecraft:flowers']);

/** Terrain is a discovery only when the model's stated goal names it. */
export function isDiscoveryBlock(block, record = {}) {
	const id = typeof block?.blockId === 'string' ? block.blockId.toLowerCase() : '';
	if (!id) return false;
	if (!id.endsWith('_leaves') && ((Array.isArray(block.tags) ? block.tags : []).some(tag => RESOURCE_TAGS.has(tag))
		|| RESOURCE_SUFFIXES.some(suffix => id.endsWith(suffix)))) return true;
	const goal = `${record.currentGoal ?? ''} ${JSON.stringify(record.currentGoalSpec ?? '')}`.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ');
	const name = id.split(':').at(-1).replaceAll('_', ' ');
	const kind = name.split(' ').at(-1);
	const names = new Set([name, kind]);
	if (kind === 'leaves') names.add('leaf');
	else if (kind.endsWith('s')) names.add(kind.slice(0, -1));
	else names.add(`${kind}s`);
	return [...names].some(word => word.length >= 3 && ` ${goal} `.includes(` ${word} `));
}

export function resourceBlockFact(block) {
	const tags = (Array.isArray(block.tags) ? block.tags : []).filter(tag => RESOURCE_TAGS.has(tag));
	return { x: block.x, y: block.y, z: block.z, blockId: block.blockId,
		// Nonstandard ids still carry the observed resource tag that established relevance.
		...(!RESOURCE_SUFFIXES.some(suffix => block.blockId.endsWith(suffix)) && tags.length ? { tags } : {}) };
}

export function resourceSightingKey(sighting) {
	return JSON.stringify([sighting.dimension, sighting.block ?? sighting.item]);
}

/** Retain a few recent, observed facts; no single row can monopolize the carrier. */
export function boundedResourceSightings(record, ...groups) {
	const retained = new Map();
	let bytes = 2;
	for (const group of groups) for (const entry of Array.isArray(group) ? group : []) {
		const block = entry?.block, item = entry?.item;
		if (block ? record !== null && !isDiscoveryBlock(block, record) : !item) continue;
		const source = block ?? item;
		if (!['x', 'y', 'z'].every(axis => Number.isFinite(source[axis]))) continue;
		const id = block ? block.blockId : item.itemId;
		if (typeof id !== 'string' || id.length > 256 || (!block && (typeof item.stableId !== 'string' || item.stableId.length > 256))) continue;
		const fact = block ? resourceBlockFact(block)
			: { stableId: item.stableId, itemId: id, x: item.x, y: item.y, z: item.z,
				...(Number.isSafeInteger(item.count) && item.count > 0 ? { count: item.count } : {}) };
		const sighting = {
			...(Number.isSafeInteger(entry.observedAtEpochMs) ? { observedAtEpochMs: entry.observedAtEpochMs } : {}),
			...(typeof entry.dimension === 'string' && entry.dimension.length <= 128 ? { dimension: entry.dimension } : {}),
			[block ? 'block' : 'item']: fact,
		};
		const size = Buffer.byteLength(JSON.stringify(sighting)) + 1;
		if (size + 2 > MAX_RESOURCE_SIGHTING_BYTES) continue;
		const key = resourceSightingKey(sighting);
		if (retained.has(key)) { bytes -= retained.get(key).size; retained.delete(key); }
		retained.set(key, { sighting, size }); bytes += size;
		while (retained.size > MAX_RESOURCE_SIGHTINGS || bytes > MAX_RESOURCE_SIGHTING_BYTES) {
			const oldest = retained.keys().next().value;
			bytes -= retained.get(oldest).size; retained.delete(oldest);
		}
	}
	return [...retained.values()].map(row => row.sighting);
}
