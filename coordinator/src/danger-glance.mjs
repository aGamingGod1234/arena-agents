// The danger-first line of a wake: what a player standing here takes in at a glance before anything else. Built only
// from facts the body already observes (player.edges, brink, footing, threats, recentDamage); it states facts and never
// picks a move. 5 of 9 deck deaths were bridge falls while the edge facts sat deep in the HUD (VERIFY.md, d41).

const COMPASS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
const MAX_THREATS = 3;

/** Minecraft yaw (0 faces +z south, 90 faces -x west) as an 8-way compass name. */
export function yawCompass(yaw) {
	if (!Number.isFinite(yaw)) return null;
	return COMPASS[((Math.round(yaw / 45) % 8) + 8) % 8];
}

const bare = (id) => String(id).replace(/^minecraft:/, '');
const cells = (n) => `${n} cell${n === 1 ? '' : 's'}`;

function dropText(depth, atLeast, into) {
	const deep = `${depth}${atLeast ? '+' : ''}`;
	return into === 'void' ? 'void' : `${deep}${typeof into === 'string' ? ` to ${into}` : ''}`;
}

function edgeParts(player) {
	const edges = player.edges;
	const parts = [];
	if (edges && typeof edges === 'object') {
		if (Number.isSafeInteger(edges.width)) parts.push(`floor ${edges.width} wide`);
		const drops = (Array.isArray(edges.drops) ? edges.drops : []).filter((row) => typeof row?.dir === 'string' && Number.isFinite(row.drop));
		if (drops.length) parts.push(`drops ${drops.map((row) => `${row.dir} ${dropText(row.drop, row.atLeast === true, row.into)}${row.at > 0 ? ` (${cells(row.at)} out)` : ''}`).join(', ')}`);
		const lava = edges.lava;
		if (lava && typeof lava.dir === 'string' && Number.isFinite(lava.at)) parts.push(`lava ${lava.dir} ${lava.at} away${lava.dy < -1 ? ' below' : ''}`);
		if (parts.length) return parts;
	}
	// Recorded or older bodies without the side glance: the nearest brink, else the footing drop in knockback reach.
	const brink = player.brink;
	if (brink && typeof brink.dir === 'string') {
		parts.push(`drop ${brink.dir} ${brink.below === 'void' ? 'void' : `${brink.drop}${brink.below === 'lava' || brink.below === 'water' ? ` to ${brink.below}` : ''}`}${Number.isFinite(brink.at) ? ` ${brink.at}m away` : ''}`);
		return parts;
	}
	const footing = player.footing;
	if (footing && Number.isFinite(footing.drop) && footing.drop >= 4) {
		const dir = yawCompass(footing.yaw);
		parts.push(`drop ${dir ?? ''}${dir ? ' ' : ''}${dropText(footing.drop, footing.atLeast === true, footing.into)}${Number.isFinite(footing.distance) && footing.distance > 0 ? ` ${footing.distance}m away` : ' beside you'}`);
	}
	return parts;
}

// In view; older samples without the visible flag fall back to the mob's line of sight.
const seen = (row) => row.visible === true || row.visible == null && row.lineOfSight === true;

function threatPart(player) {
	const rows = (Array.isArray(player.threats) ? player.threats : [])
		.filter((row) => row?.targeting === true && seen(row) && typeof row.type === 'string' && Number.isFinite(row.distance))
		.sort((a, b) => a.distance - b.distance);
	if (!rows.length) return null;
	const shown = rows.slice(0, MAX_THREATS).map((row) => `${bare(row.type)} ${Math.round(row.distance)}m`).join(', ');
	return `${rows.length} targeting you: ${shown}${rows.length > MAX_THREATS ? ` +${rows.length - MAX_THREATS}` : ''}`;
}

function hitPart(player) {
	const direction = player.recentDamage?.direction;
	// A hit felt from behind: the screen tilt shows its side; the attacker may not be in view.
	if (typeof direction !== 'string' || !direction.startsWith('back')) return null;
	const seconds = player.recentDamage.secondsAgo;
	return `hit from ${direction.replace('_', '-')}${Number.isFinite(seconds) && seconds > 0 ? ` ${seconds}s ago` : ''}`;
}

/** One short line of current dangers around the body, most immediate first, or null when nothing applies. */
export function dangerGlance(player) {
	if (player == null || typeof player !== 'object' || player.dead === true) return null;
	const parts = [hitPart(player), ...edgeParts(player), threatPart(player)].filter(Boolean);
	return parts.length ? parts.join('; ') : null;
}
