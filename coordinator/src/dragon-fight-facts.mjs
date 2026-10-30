// Dragon fight facts a player sees or remembers: the dragon landing on the exit fountain, and the End crystals seen
// standing or broken by the player's own shots. End runs 2026-10-21 (d11-end-f, d7-end-b): every fountain perch came and
// went unannounced (about 5 s with nobody within 20 blocks), and after a session refresh d11-end-f spent its last
// 4 minutes looking for a caged crystal its own arrow had broken 23 minutes earlier.

export const DRAGON_PERCHED_TRIGGER = 'dragon_perched';
// One wake per landing: perched samples within this gap belong to the same perch (rows drop out while out of view).
const PERCH_GAP_MS = 15_000;
const MAX_CRYSTALS = 16;
const MAX_SHOTS = 32;
const BROKE = /broke or died/;

const dragonRows = observation => (Array.isArray(observation?.entities) ? observation.entities : [])
	.filter(row => row?.type === 'minecraft:ender_dragon' && row.alive !== false && row.perceivedBy !== 'sound');
const rounded = value => Math.round(value * 10) / 10;

/**
 * A new landing of the dragon on the exit fountain in this sample (its root row reads appearance.motion "perched"),
 * or null. Updates the per-life signal state.
 */
export function dragonPerchEdge(state, observation, sampledAt) {
	const root = dragonRows(observation).find(row => typeof row.partName !== 'string');
	if (root === undefined) return null;
	const at = Number.isFinite(sampledAt) ? sampledAt : Date.now();
	if (root.appearance?.motion !== 'perched') {
		state.dragonPerchSeenAt = null;
		return null;
	}
	const continuing = Number.isFinite(state.dragonPerchSeenAt) && at - state.dragonPerchSeenAt <= PERCH_GAP_MS;
	state.dragonPerchSeenAt = at;
	return continuing ? null : perchedDragon(observation);
}

/** The perched dragon in this sample (its distance, health and head row), or null when none is seen perched. */
export function perchedDragon(observation) {
	const rows = dragonRows(observation);
	const root = rows.find(row => typeof row.partName !== 'string');
	if (root?.appearance?.motion !== 'perched') return null;
	const head = rows.find(row => row.partName === 'head');
	return {
		distance: Number.isFinite(root.distance) ? rounded(root.distance) : null,
		...(Number.isFinite(root.health) ? { health: rounded(root.health) } : {}),
		...(head === undefined ? {} : { head: { id: head.stableId, x: rounded(head.x), y: rounded(head.y), z: rounded(head.z), ...(Number.isFinite(head.distance) ? { distance: rounded(head.distance) } : {}) } }),
	};
}

// EnderDragon.hurt: parts other than the head take damage / 4 + min(damage, 1); a sitting dragon that has taken more
// than a quarter of its max health (50) since it landed takes off. AbstractDragonSittingPhase.onHurt: a sitting dragon
// takes no arrow damage. DragonSittingScanningPhase: a player within 20 blocks (10 up or down) is turned to for 1.25 s,
// then roared at for 2 s (DragonSittingAttackingPhase); DragonSittingFlamingPhase puts a radius-5 Instant Damage cloud
// 2.5 blocks beyond the head 0.5 s in and removes it at 10 s, up to 4 breaths; with nobody near it takes off after 5 s.
// EnderDragon.aiStep, while its hurtTime is 0, perched too: bodies in each wing's box grown 4 sideways and 2 up/down
// (moved 2 down) are pushed 4 away (damage only in flight), and the head and neck boxes grown 1 hurt for 10.
// End runs 2026-10-21 (617e2d5d, 10 games): 85 of 115 perches lasted about 4.5 s, all with the player 16-88 blocks out;
// 30 lasted 31-56 s, all with the player within 26. Every breath cloud sat 2.5 blocks beyond the head.
export const PERCH_FACTS = 'Perched, arrows bounce off it; its head takes full melee damage, other parts about a quarter. With no player within 20 blocks (10 up or down) it takes off after about 5 s. With one, it turns to them (about 1 s), roars (2 s), then breathes: a cloud of radius 5 centred 2.5 blocks beyond its head for about 10 s, 6 damage a second through armour; up to 4 breaths, so it stays about 50 s. Even perched, its wings throw anyone within about 6 blocks of either wing (its sides and back, past the sides of its head), and its head and neck hurt 10 on contact; both pause for half a second after each hit it takes. Straight out in front of its head is clear of the wings; its breath lands there. 50 damage in one perch makes it take off.';

// These are useful before the landing wake: a distant player's reply often outlasts the whole empty perch.
export const DRAGON_FINISH_FACTS = 'The dragon lands on the bedrock exit fountain in the island centre, not a pillar or the arrival platform. With the crystals gone it cannot heal. A player waiting on open ground 10-15 blocks from the fountain is within its 20-block perch range before it lands; from farther away the empty perch lasts only about 5 seconds, often less than a reply. Its head takes full melee damage: an iron sword recharges in 0.625 seconds, so nine charged hits take about 6 seconds and force takeoff. The sides and back are in the wings; the front is in the breath cloud when it breathes. A visible cloud lasts about 10 seconds, then that ground clears; the fountain remains the next landing spot. An open mouth shows anger, not its target: dragon hits anger endermen too. A gaze guard must outrank movement reflexes so it can turn your view off calm endermen while a dodge runs.';

// Vanilla full-charge melee damage: a sword is 4 + its tier's bonus, these axes 7-10 (ToolMaterial, Items).
const MELEE_DAMAGE = Object.freeze({ netherite_sword: 8, netherite_axe: 10, diamond_sword: 7, diamond_axe: 9, iron_sword: 6, iron_axe: 9,
	stone_sword: 5, stone_axe: 9, copper_sword: 5, golden_sword: 4, golden_axe: 7, wooden_sword: 4, wooden_axe: 7 });
// fight_target picks a sword before an axe; the facts name the weapon it would swing.
const meleeRank = id => (id.endsWith('_sword') ? 100 : 0) + MELEE_DAMAGE[id];

/** The carried weapon a head hit would use and its damage, or null when none is carried. */
function carriedMelee(observation) {
	if (observation?.continuity?.rememberedSections?.includes('inventory')) return null;
	const ids = (Array.isArray(observation?.inventory?.items) ? observation.inventory.items : [])
		.filter(row => row?.count > 0 && typeof row.itemId === 'string').map(row => row.itemId.replace(/^minecraft:/, ''))
		.filter(id => MELEE_DAMAGE[id] !== undefined);
	if (ids.length === 0) return null;
	const id = ids.sort((a, b) => meleeRank(b) - meleeRank(a))[0];
	return { name: id.replace(/_/g, ' '), damage: MELEE_DAMAGE[id] };
}

/** Kill arithmetic for the perched dragon: its health, the carried weapon's head hit, hits and perches left. */
export function perchKillMath(observation, health) {
	const weapon = carriedMelee(observation);
	const left = Number.isFinite(health) && health > 0 ? Math.ceil(health) : null;
	const parts = [];
	if (left !== null) parts.push(`Dragon health ${left} of 200.`);
	if (weapon) parts.push(`Your ${weapon.name} hits the head for ${weapon.damage} (a dragon part takes no criticals)`
		+ (left !== null ? `: about ${Math.ceil(left / weapon.damage)} hits, at most 50 damage a perch, so at least ${Math.ceil(left / 50)} perches.` : '.'));
	else parts.push('No sword or axe carried: a bare hand hits the head for 1.');
	return parts.join(' ');
}

/** The wake's lead line; a program decision built from a later sample reads the dragon from that sample. */
export function dragonPerchLine(observation) {
	const perch = perchedDragon(observation) ?? observation?.dragonPerch;
	if (perch == null) return `Live Minecraft event: the ender dragon landed on the exit fountain and is not seen perched now. ${PERCH_FACTS}`;
	const head = perch.head;
	const where = head ? ` Head ${head.id} at ${head.x},${head.y},${head.z}${Number.isFinite(head.distance) ? `, ${head.distance} blocks from you` : ''}.` : '';
	return `Live Minecraft event: the ender dragon landed on the exit fountain${Number.isFinite(perch.distance) ? `, ${perch.distance} blocks away` : ''}.${where} ${PERCH_FACTS} ${perchKillMath(observation, perch.health)} A sprint covers about 5.6 blocks a second.`;
}

/** Records the target of a dispatched shot or fight, so its result can name a crystal the player broke. */
export function noteCombatDispatch(state, actionId, actionType, args) {
	if (!['use_ranged', 'fight_target', 'attack'].includes(actionType) || typeof args?.targetId !== 'string' || typeof actionId !== 'string') return;
	state.combatShots ??= new Map();
	state.combatShots.set(actionId, args.targetId);
	while (state.combatShots.size > MAX_SHOTS) state.combatShots.delete(state.combatShots.keys().next().value);
}

/** A shot whose result says the target broke (or a fight that killed it) marks that remembered crystal broken. */
export function settleCombatResult(state, payload) {
	const target = state.combatShots?.get(payload?.actionId);
	if (target === undefined || !['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(payload.state)) return;
	state.combatShots.delete(payload.actionId);
	const message = payload.message ?? '';
	const broke = payload.state === 'SUCCEEDED' && !/something else|lost sight|not confirmed/i.test(message)
			&& (BROKE.test(message) || payload.reasonCode === 'TARGET_KILLED');
	const external = /target broke or died.*something else/i.test(message);
	if (!broke && !external) return;
	const key = broke ? 'brokenTargets' : 'externallyBrokenTargets';
	state[key] ??= new Set();
	state[key].add(target);
	while (state[key].size > MAX_SHOTS) state[key].delete(state[key].values().next().value);
	const crystal = state.endCrystals?.get(target);
	if (crystal) { if (broke) crystal.broken = true; else crystal.external = true; }
}

/** Remembers End crystals in sight; returns the tally the End facts show, or null outside the End or before any. */
export function rememberEndCrystals(state, observation) {
	if (observation?.world?.dimension !== 'minecraft:the_end') return null;
	state.endCrystals ??= new Map();
	const remembered = observation.continuity?.rememberedSections?.includes('entities');
	if (!remembered) for (const row of Array.isArray(observation.entities) ? observation.entities : []) {
		if (row?.type !== 'minecraft:end_crystal' || row.alive === false || row.perceivedBy === 'sound' || typeof row.stableId !== 'string') continue;
		if (![row.x, row.y, row.z].every(Number.isFinite)) continue;
		const known = state.endCrystals.get(row.stableId);
		const caged = row.appearance?.caged === true || known?.caged === true;
		// Gaps in its cage as last seen: broken bars beside or above it.
		const open = Array.isArray(row.appearance?.cageOpen) ? row.appearance.cageOpen.filter(cell => typeof cell === 'string').slice(0, 6) : row.appearance?.caged === true ? [] : known?.open ?? [];
		state.endCrystals.set(row.stableId, { x: Math.floor(row.x), y: Math.floor(row.y), z: Math.floor(row.z), caged, ...(caged && open.length ? { open } : {}),
			broken: state.brokenTargets?.has(row.stableId) === true, external: state.externallyBrokenTargets?.has(row.stableId) === true });
		while (state.endCrystals.size > MAX_CRYSTALS) state.endCrystals.delete(state.endCrystals.keys().next().value);
	}
	if (state.endCrystals.size === 0) return null;
	const rows = [...state.endCrystals.values()];
	return { standing: rows.filter(row => !row.broken && !row.external).map(({ x, y, z, caged, open }) => ({ x, y, z, ...(caged ? { caged } : {}), ...(open ? { open } : {}) })), broken: rows.filter(row => row.broken).length, ...(rows.some(row => row.external && !row.broken) ? { external: rows.filter(row => row.external && !row.broken).length } : {}) };
}

// EndSpikeFeature: the two guarded spikes put bars on the 5x5 ring 2 blocks out from the bedrock row (crystal y - 1) to
// crystal y + 2 and over the whole top at y + 2. Side walls are solid panes to arrows; the top is a bar grid with holes
// about 0.9 blocks square. IronBarsBlock strength 5 needs a pickaxe (iron about 1.3 s; a bare hand 1/100 speed, 25 s).
// EndCrystal.hurtServer: a power-6 blast at the crystal (ThreatDamage.explosionDamage, full exposure: 56 at 3 blocks,
// 33 at 6, 14 at 9) that breaks blocks round it. End runs 2026-10-21 (617e2d5d, a2985f4a): 297 arrows stuck in these
// walls and 318 shots refused at them; d11-end-f spent 30 of 45 min on the two caged crystals.
export const CAGED_CRYSTAL_FACTS = 'Caged (iron bars 2 blocks out on every side from 1 below to 2 above the crystal, barred on top): arrows stick in the side walls from any spot; the barred top is a grid arrows pass from above. Players pillar up beside the cage to the crystal\'s height, break the 2 wall bars there (pickaxe about 1.3 s each, bare hand 25 s; more bars beside them widen the gap against arrow scatter), then shoot it through that gap from the ground on that side. A crystal\'s blast deals about 56 at 3 blocks, 33 at 6, 14 at 9 before armour and blows up ordinary blocks near it, such as a pillar beside the cage.';

/** One remembered crystal; a caged one adds where a player stands beside it to break its wall bars. */
function crystalEntry(row, player) {
	if (!row.caged) return `${row.x},${row.y},${row.z}`;
	const feet = Number.isFinite(player?.y) ? Math.floor(player.y + 1e-6) : null;
	const above = feet === null ? '' : row.y > feet ? `, ${row.y - feet} above you` : row.y === feet ? ', your height' : `, ${feet - row.y} below you`;
	return `${row.x},${row.y},${row.z} caged (beside it feet y=${row.y}${above}${row.open?.length ? `; open bars ${row.open.join(' ')}` : ''})`;
}

export function endCrystalFact(tally, player = null) {
	if (tally == null) return null;
	const standing = tally.standing.map(row => crystalEntry(row, player)).join('; ');
	const caged = tally.standing.some(row => row.caged) ? ` ${CAGED_CRYSTAL_FACTS}` : '';
	return `End crystals you have seen: ${tally.standing.length} standing when last seen${standing ? ` (${standing})` : ''}, ${tally.broken} broken by your own hits${tally.external ? `, ${tally.external} destroyed by something else` : ''}. The 10 obsidian pillars each start with one; standing crystals heal the dragon, and each turn of its circling lands it on the fountain with chance 1/(crystals left + 3).${caged}`;
}
