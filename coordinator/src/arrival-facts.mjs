// One line of what a player sees in the first second after a dimension change: the portal behind them (the way
// back), the nearest seen lava, an open drop beside the feet and hostile mobs in view. Only observed facts; it names
// no response. It rides on the wake that first reports the dimension change (the changed line), nowhere else.

const LAVA_RANGE = 16;
const HOSTILE_RANGE = 32;
// Mobs that attack a player on sight there (piglins unless gold is worn; the combat line carries that rule).
const HOSTILE = new Set(['minecraft:ghast', 'minecraft:piglin', 'minecraft:piglin_brute', 'minecraft:hoglin', 'minecraft:magma_cube',
	'minecraft:blaze', 'minecraft:wither_skeleton', 'minecraft:skeleton', 'minecraft:zombie', 'minecraft:creeper',
	'minecraft:spider', 'minecraft:endermite', 'minecraft:shulker']);

const finite = (...values) => values.every(Number.isFinite);
const bare = (id) => id.replace(/^minecraft:/, '');

/** 8-way compass heading from one point to another (north is -z, east is +x). */
function heading(dx, dz) {
	if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return '';
	const names = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
	const angle = Math.atan2(-dx, dz);
	return names[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
}

/** True when the wake's changed line reports a dimension change (not a respawn). */
export function reportsDimensionChange(changed) {
	return typeof changed === 'string' && /(^|; )dimension [a-z_]+->[a-z_]+/.test(changed);
}

export function arrivalFacts(observation) {
	const player = observation?.player;
	const at = finite(player?.x, player?.y, player?.z) ? player : observation?.position;
	if (observation?.ready !== true || observation.player?.dead === true || !finite(at?.x, at?.y, at?.z)) return null;
	const distance = (row) => Math.hypot(row.x + 0.5 - at.x, row.y + 0.5 - at.y, row.z + 0.5 - at.z);
	const parts = [];
	const frames = (observation.sighted?.portalFrames ?? []).filter((row) => row?.lit === true && finite(row.x, row.y, row.z));
	const portals = frames.length > 0 ? frames : [...(observation.sighted?.poi ?? []), ...(observation.blocks ?? [])]
		.filter((row) => row?.blockId === 'minecraft:nether_portal' && finite(row.x, row.y, row.z));
	const portal = portals.sort((a, b) => distance(a) - distance(b))[0];
	if (portal !== undefined) parts.push(`portal ${portal.x},${portal.y},${portal.z}`);
	const lava = [...(observation.blocks ?? []), ...(observation.landmarks ?? [])]
		.filter((row) => row?.blockId === 'minecraft:lava' && row.visible !== false && finite(row.x, row.y, row.z));
	const cells = new Map();
	for (const row of lava) {
		const d = distance(row);
		if (d <= LAVA_RANGE) cells.set(`${row.x},${row.y},${row.z}`, { ...row, d });
	}
	if (cells.size === 0) parts.push(`no lava seen within ${LAVA_RANGE}`);
	else {
		const near = [...cells.values()].sort((a, b) => a.d - b.d)[0];
		const dy = Math.floor(near.y) - Math.floor(at.y);
		const side = heading(near.x + 0.5 - at.x, near.z + 0.5 - at.z);
		parts.push(`lava seen within ${LAVA_RANGE}: ${cells.size} cell${cells.size === 1 ? '' : 's'}, nearest ${Math.round(near.d)}m${side ? ` ${side}` : ''}${dy === 0 ? '' : ` dy${dy > 0 ? '+' : ''}${dy}`} at ${near.x},${near.y},${near.z}`);
	}
	const footing = observation.player?.footing;
	if (finite(footing?.drop) && footing.drop >= 4 && finite(footing.yaw)) {
		parts.push(`open drop ${footing.drop}${footing.atLeast === true ? '+' : ''} beside you at yaw ${footing.yaw}${footing.into === 'lava' ? ' into lava' : ''}`);
	}
	const groups = new Map();
	for (const entity of observation.entities ?? []) {
		if (entity?.alive === false || !HOSTILE.has(entity?.type) || !finite(entity.distance) || entity.distance > HOSTILE_RANGE) continue;
		const group = groups.get(entity.type) ?? { count: 0, nearest: Infinity, targeting: false };
		group.count += 1;
		group.nearest = Math.min(group.nearest, entity.distance);
		group.targeting ||= entity.targetingAgent === true;
		groups.set(entity.type, group);
	}
	const hostiles = [...groups].sort((a, b) => a[1].nearest - b[1].nearest)
		.map(([type, group]) => `${bare(type)}${group.count > 1 ? ` x${group.count}` : ''} ${Math.round(group.nearest)}m${group.targeting ? ' targeting you' : ''}`);
	parts.push(hostiles.length === 0 ? `no hostile mob in view within ${HOSTILE_RANGE}` : `in view: ${hostiles.join(', ')}`);
	return parts.join('; ');
}
