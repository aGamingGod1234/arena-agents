// One wake fact: a goal skill (fight_until, barter_until, cast_obsidian) whose preconditions hold right now, with the
// call's fields and the facts that make it fit. It names a call the model may make; nothing runs from it.

export const SKILL_FITS_BYTES = 240;
// fight_until's default area radius; barter_until and cast_obsidian look for piglins and lava within 16 blocks.
const FIGHT_RANGE = 24;
const BARTER_RANGE = 16;
const LAVA_RANGE = 16;
const MELEE = /^minecraft:(wooden|golden|stone|copper|iron|diamond|netherite)_(sword|axe)$/;
const GOLD_ARMOUR = /^minecraft:golden_(helmet|chestplate|leggings|boots)$/;
const WORN = new Set(['head', 'chest', 'legs', 'feet']);

/**
 * needs: the plan's open counted needs in plan order, { id, have, need } (have < need). sightings: remembered source rows
 * (kind spawner with mob or nether). lavaPools: remembered still lava ({ dimension, x, y, z, sources, cells }).
 * Returns at most one line, or null when no goal skill fits.
 */
export function skillFitsLine({ observation: o = null, needs = [], sightings = [], lavaPools = [] } = {}) {
	if (!live(o) || !Array.isArray(o.inventory?.items) || remembered(o, 'inventory') || !needs.length) return null;
	const at = o.position ?? o.player?.position ?? o.player;
	if (![at?.x, at?.y, at?.z].every(Number.isFinite)) return null;
	const items = o.inventory.items.filter(i => i?.count > 0);
	const count = re => items.filter(i => re.test(i.itemId ?? '')).reduce((n, i) => n + i.count, 0);
	const entities = remembered(o, 'entities') ? [] : (o.entities ?? []).filter(e => e?.alive !== false && Number.isFinite(e?.distance));
	const nearest = (type, range, ok = () => true) => entities.filter(e => e.type === type && e.distance <= range && ok(e)).sort((a, b) => a.distance - b.distance)[0] ?? null;
	const away = row => Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z);
	const dimension = o.world?.dimension;
	const running = o.currentAction?.active === true ? o.currentAction.actionType : null;
	const melee = items.filter(i => MELEE.test(i.itemId)).sort((a, b) => tier(b.itemId) - tier(a.itemId))[0]?.itemId.slice(10) ?? null;
	const bow = count(/^minecraft:(bow|crossbow)$/) > 0 ? count(/^minecraft:(arrow|spectral_arrow|tipped_arrow)$/) : 0;
	const m = n => `${Math.round(n)} m`;

	const blaze = need => {
		if (dimension !== 'minecraft:the_nether' || running === 'fight_until' || (!melee && !bow)) return null;
		const blocks = remembered(o, 'blocks') ? [] : [...(o.blocks ?? []), ...(o.landmarks ?? [])];
		const spawners = [...blocks.filter(b => b?.blockId === 'minecraft:spawner' && [b.x, b.y, b.z].every(Number.isFinite)),
			...sightings.filter(r => r?.kind === 'spawner' && (r.mob === 'minecraft:blaze' || r.mob === undefined && r.nether === true) && [r.x, r.y, r.z].every(Number.isFinite))]
			.map(away).filter(d => d <= FIGHT_RANGE).sort((a, b) => a - b);
		const mob = nearest('minecraft:blaze', FIGHT_RANGE);
		if (!spawners.length && !mob) return null;
		const gear = [melee, bow ? `bow + ${bow} arrows` : null].filter(Boolean).join(', ');
		return `fight_until mob:minecraft:blaze untilItem:minecraft:blaze_rod untilCount:${need.need} (${spawners.length ? `spawner ${m(spawners[0])}` : `blaze ${m(mob.distance)}`}, ${gear}, rods ${need.have}/${need.need})`;
	};
	const enderman = need => {
		// An enderman is always fought in melee (fight_until never shoots one).
		if (running === 'fight_until' || !melee) return null;
		const mob = nearest('minecraft:enderman', FIGHT_RANGE);
		return mob && `fight_until mob:minecraft:enderman untilItem:minecraft:ender_pearl untilCount:${need.need} (enderman ${m(mob.distance)}, ${melee}, pearls ${need.have}/${need.need})`;
	};
	const barter = need => {
		const gold = count(/^minecraft:gold_ingot$/);
		if (running === 'barter_until' || gold === 0 || !items.some(i => WORN.has(i.slot) && GOLD_ARMOUR.test(i.itemId))) return null;
		const piglin = nearest('minecraft:piglin', BARTER_RANGE, e => e.baby !== true && e.targetingAgent !== true);
		return piglin && `barter_until itemId:minecraft:ender_pearl count:${Math.min(64, need.need - need.have)} (piglin ${m(piglin.distance)}, gold ${gold}, gold armour worn, pearls ${need.have}/${need.need})`;
	};
	const cast = need => {
		// Water poured in the Nether evaporates, so casting is an Overworld (or End) fact.
		if (dimension === 'minecraft:the_nether' || running === 'cast_obsidian' || count(/^minecraft:water_bucket$/) === 0) return null;
		const seen = remembered(o, 'blocks') ? [] : (o.blocks ?? []).filter(b => b?.blockId === 'minecraft:lava' && String(b.state?.level) === '0' && b.visible !== false);
		const pools = lavaPools.filter(p => p?.dimension === dimension).flatMap(p => Array.isArray(p.cells) && p.cells.length ? p.cells.map(c => { const [x, y, z] = String(c).split(',').map(Number); return { x, y, z }; }) : [p]);
		const source = [...seen, ...pools].filter(c => [c.x, c.y, c.z].every(Number.isFinite)).map(c => ({ c, d: away(c) })).filter(r => r.d <= LAVA_RANGE).sort((a, b) => a.d - b.d)[0];
		if (!source) return null;
		const bucket = count(/^minecraft:bucket$/) > 0;
		return `cast_obsidian x:${source.c.x} y:${source.c.y} z:${source.c.z} count:${Math.min(64, need.need - need.have)}${bucket ? ' or frame:true at a frame corner' : ''} (lava source ${m(source.d)}, water_bucket${bucket ? ' + bucket' : ''}, obsidian ${need.have}/${need.need})`;
	};
	const ways = { 'minecraft:blaze_rod': [blaze], 'minecraft:ender_pearl': [enderman, barter], 'minecraft:obsidian': [cast] };
	for (const need of needs) {
		if (!(need?.have < need?.need)) continue;
		for (const way of ways[need.id] ?? []) {
			const line = way(need);
			if (line) return Buffer.byteLength(line) <= SKILL_FITS_BYTES ? line : null;
		}
	}
	return null;
}

function live(o) { return o?.ready === true && o.player?.dead !== true && o.continuity?.phase !== 'dead'; }
function remembered(o, section) { return o.continuity?.rememberedSections?.includes(section) === true; }
function tier(id) { return ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'].indexOf(id.slice(10).split('_')[0]); }
