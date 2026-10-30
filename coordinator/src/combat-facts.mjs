import { DRAGON_FINISH_FACTS, endCrystalFact } from './dragon-fight-facts.mjs';
import { BARTER_ODDS } from './need-sources.mjs';

const STRONGHOLD_MASONRY = /^minecraft:(mossy_|cracked_|chiseled_)?stone_bricks$|^minecraft:infested_/;
const PORTAL_ROOM_LAVA = 'Stronghold portal room (vanilla): lava sits at floor level in a 1x3 strip along each side wall beside the entrance, and in a 3x3 pool under the portal inside the raised frame platform; the silverfish spawner is on the stairs up to the frame.';

/** A stronghold portal room is in sight: its end portal frame, or its silverfish spawner among stronghold masonry. */
function portalRoomSeen(observation) {
	const blocks = (Array.isArray(observation.blocks) ? observation.blocks : []).filter(b => b?.visible !== false);
	const ids = new Set(blocks.map(b => b.blockId));
	return ids.has('minecraft:end_portal_frame') || ids.has('minecraft:spawner') && [...ids].some(id => STRONGHOLD_MASONRY.test(id));
}

/** The vanilla gaze rule plus who it applies to now: eye contact from the observed appearance, anger from signals. */
function endermanFact(observation, threats) {
	const endermen = (observation.entities ?? []).filter(e => e.type === 'minecraft:enderman' && e.alive !== false);
	const id = e => e.stableId ?? e.uuid;
	const contact = endermen.filter(e => e.appearance?.eyeContact === true).map(id).filter(Boolean);
	const angry = new Map();
	for (const e of [...endermen.filter(e => e.appearance?.screaming === true || e.targetingAgent === true), ...threats.filter(t => t.type === 'minecraft:enderman')]) {
		if (id(e) && !Number.isFinite(angry.get(id(e)))) angry.set(id(e), e.distance);
	}
	// How near the closest angry one is: a pearl or path choice needs it (run d9-end-b pearled beside one 27 m off).
	const nearest = Math.min(...[...angry.values()].filter(Number.isFinite));
	// EnderMan cannot path into water, refuses water as a teleport destination and is hurt and teleported by its touch.
	return 'Endermen turn hostile if attacked or stared at (worn carved pumpkin prevents); looking away never calms one. A 2-high gap blocks their body; standing water keeps them off.'
		+ (contact.length ? ` Staring at ${contact.slice(0, 2).join(', ')}.` : '')
		+ (angry.size ? ` Angry: ${angry.size}${Number.isFinite(nearest) ? ` (nearest ${Math.round(nearest)}m)` : ''}.` : '');
}

/**
 * EnderDragon.knockBack: bodies inside its wings' reach are pushed 4 blocks/tick away and lifted, so a pass over open
 * ground throws a player far and high (run d7-end-a: thrown from y64 to y73, killed by the landing at 6.5 HP).
 * The End has no natural water, so an emptied bucket stays empty unless placed water is scooped back.
 */
function dragonFact(observation) {
	const items = observation.continuity?.rememberedSections?.includes('inventory') ? null : observation.inventory?.items;
	const has = id => Array.isArray(items) && items.some(e => e.itemId === `minecraft:${id}` && e.count > 0);
	const water = !Array.isArray(items) ? '' : has('water_bucket') ? ' Water bucket carried.'
		: has('bucket') ? ` No water bucket: the End has no natural water, so an empty bucket refills only from water you placed (a source block).${seenWater(observation)}` : ' No water bucket carried.';
	return `Ender dragon: its wings and body fling a player many blocks, up to about 10 high, even on flat ground; the landing alone can kill. Water placed below before landing cancels fall damage; a turn is too slow to place it mid-fall, a falling reflex is not.${water} ${DRAGON_FINISH_FACTS}`;
}

function seenWater(observation) {
	const rows = [...(observation.blocks ?? []), ...(observation.landmarks ?? [])].filter(b => b?.blockId === 'minecraft:water' && [b.x, b.y, b.z].every(Number.isFinite));
	const nearest = rows.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))[0];
	return nearest ? ` Water seen at ${nearest.x},${nearest.y},${nearest.z}.` : '';
}

// Sword attack damage (vanilla tiers); a falling critical deals 1.5x. Blaze health is 20.
const SWORD_DAMAGE = { wooden_sword: 4, golden_sword: 4, stone_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8 };
function swordHits(observation) {
	if (observation.continuity?.rememberedSections?.includes('inventory')) return '';
	const best = (observation.inventory?.items ?? []).filter(e => e?.count > 0).map(e => [e.itemId?.replace(/^minecraft:/, ''), SWORD_DAMAGE[e.itemId?.replace(/^minecraft:/, '')]])
		.filter(([, damage]) => Number.isFinite(damage)).sort((a, b) => b[1] - a[1])[0];
	if (!best) return '';
	return ` Your ${best[0].replace('_', ' ')} kills one in ${Math.ceil(20 / best[1])} hits (${Math.ceil(20 / (best[1] * 1.5))} falling crits).`;
}

/** The nearest bastion in sight now (sighted.structures), as distance and position; null when none. */
function bastionSeen(observation) {
	const rows = (Array.isArray(observation.sighted?.structures) ? observation.sighted.structures : [])
		.filter((row) => /^bastion/.test(row?.structure ?? '') && [row.x, row.y, row.z].every(Number.isFinite)).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
	return rows.length ? `seen${Number.isFinite(rows[0].distance) ? ` ${Math.round(rows[0].distance)}m off` : ''} at ${rows[0].x},${rows[0].y},${rows[0].z}` : null;
}

// Potions.FIRE_RESISTANCE lasts 3600 ticks; a splash measures distance box to box, so one at your feet gives about the same.
function fireResistanceFact(observation) {
	if (observation.continuity?.rememberedSections?.includes('inventory')) return null;
	const effect = (Array.isArray(observation.player?.effects) ? observation.player.effects : []).find((row) => row?.effectId === 'minecraft:fire_resistance');
	if (effect) {
		const seconds = effect.duration === -1 ? null : Math.floor((effect.duration ?? 0) / 20);
		return `Fire resistance active${seconds === null ? '' : `, ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`}: fire, lava and blaze fireballs deal no damage until it ends; lava still hides the floor and slows you.`;
	}
	const held = (observation.inventory?.items ?? []).filter((item) => /^minecraft:(splash_)?potion$/.test(item?.itemId ?? '') && /fire resistance/i.test(item.displayName ?? '') && item.count > 0);
	if (!held.length) return null;
	const drink = held.reduce((sum, item) => sum + (item.itemId === 'minecraft:potion' ? item.count : 0), 0), splash = held.reduce((sum, item) => sum + (item.itemId === 'minecraft:splash_potion' ? item.count : 0), 0);
	return `Fire resistance held (${[drink ? `${drink} to drink` : '', splash ? `${splash} splash` : ''].filter(Boolean).join(', ')}): use_item gives 3:00 in which fire, lava and blaze fireballs deal no damage (drinking takes 1.6 s; a splash thrown at your feet works too). Drink it before entering a fortress, fighting blazes or crossing near lava; lava kills in seconds without it.`;
}

// Installed vanilla mechanics attached to observed mobs, structures and worn gear, never hidden mob intentions.
export function combatFacts(observation) {
	if (observation?.ready !== true || observation.player?.dead === true
		|| observation.continuity?.rememberedSections?.includes('player')) return null;
	const threats = Array.isArray(observation.player?.threats) ? observation.player.threats : [];
	const types = new Set([...(observation.entities ?? []).filter(e => e.alive !== false), ...threats].map(e => e.type));
	const facts = [];
	if (observation.world?.dimension === 'minecraft:the_nether' || types.has('minecraft:piglin')) {
		const items = observation.inventory?.items;
		const worn = Array.isArray(items) && !observation.continuity?.rememberedSections?.includes('inventory')
			? items.some(e => ['head', 'chest', 'legs', 'feet'].includes(e.slot) && e.count > 0 && /^minecraft:golden_(helmet|chestplate|leggings|boots)$/.test(e.itemId)) : null;
		// PiglinAi.angerNearbyPiglins: a 16-block box around the player; breaking needs no line of sight, opening does.
		const near = (observation.entities ?? []).filter(e => e.type === 'minecraft:piglin' && e.alive !== false && Number.isFinite(e.distance) && e.distance <= 16).length;
		facts.push(`Gold armor ${worn === null ? 'unknown' : worn ? 'worn' : 'not worn'}: one worn piece stops ordinary piglin on-sight aggression (held gold does not; brutes ignore gold). Still, breaking gold blocks, gold ores (nether too) or gilded blackstone angers all piglins within 16 blocks, even unseen behind walls (silence does not prove clearance); breaking chests, barrels or shulker boxes does too; opening a chest, barrel or shulker box angers those within 16 that see you; hitting one (sword sweeps too) angers it.${near ? ` Piglins within 16 now: ${near}.` : ''} Sword sweeps hit neutral neighbors: choose separation, or select a held axe and use attack; fight_target selects its own hotbar weapon.`);
		// ZombifiedPiglin.alertOthers: FOLLOW_RANGE 35 horizontally, 10 vertically; PERSISTENT_ANGER_TIME 20-39 s.
		if (types.has('minecraft:zombified_piglin')) facts.push('Zombified piglins stay calm until you hurt one (a sword sweep or stray arrow counts); then it and every zombified piglin within 35 blocks (10 up or down) attack for 20-39 s.');
		const gold = Array.isArray(items) && items.some(e => e.itemId === 'minecraft:gold_ingot' && e.count > 0);
		if (gold && types.has('minecraft:piglin')) facts.push(`Barter: a calm adult piglin takes a gold ingot handed to it (interact_entity holding it) or dropped near it, examines it ~6 s, then throws one random return toward you (${BARTER_ODDS}); baby piglins keep it; several piglins barter at once.`);
		const bastion = bastionSeen(observation);
		if (bastion || types.has('minecraft:piglin_brute')) facts.push(`${bastion ? `Bastion ${bastion}. ` : ''}Piglin brutes (axe, 50 health) attack on sight whatever you wear and never respawn; ordinary piglins there guard loot. Bastion kinds: housing units (many piglins, chests on each floor), hoglin stables (hoglins attack and drop porkchops), bridge (a bridge to a keep with chests), treasure room (gold blocks and chests at a center over lava, brutes, magma cube spawners). Players loot by first blocking the view of piglins near a chest (place blocks, or open it from a sealed side), breaking gold only with no piglin within 16, and fighting brutes from a 1-wide corridor or from above.`);
		const fire = fireResistanceFact(observation);
		if (fire) facts.push(fire);
	}
	// Blaze.BlazeAttackGoal: 60 charging ticks, then 3 small fireballs 6 ticks apart, then 100 ticks before the next charge.
	if (types.has('minecraft:blaze')) facts.push(`Players often enclose themselves before a blaze fight: build_shelter at x,y,z (interior feet cell), opening north/south/east/west, itemId a carried solid block, roof true by default (omit it if it hides hovering targets). It clears partial wall obstructions with hotbar tools and touching fire, then builds two-high walls with an eye-height fighting window above a sill, so knockback stays inside and walls stop shots. Build before pressure. Hovering blazes beyond melee reach can be shot from the window: select a bow and use_ranged with targetId, drawDurationMs:1000 and no aim fields for ballistic aim; shield and bow cannot be used together. If the arc names a shelter head-height wall as its obstruction, mine that block for another window; keep the feet-level walls. Use fight_target pursue:false only when a blaze enters reach. Pick up witnessed rods; for drops outside, open the sill with break_block, collect, then return and rebuild if safe. The model chooses whether and where. Blaze fights hold the deck and leave fire with pursue:true. With shield:true they guard at range and wait for reach; unshielded blocked approaches return control. Idle: shield stance maxS up to 600 (default 600); hostile_near targetId tracks one UUID. Fight receipts give drop UUIDs/last-seen positions for pick_up_item. Blazes: 20 health, fire-immune, hover; with line of sight within 48 blocks they charge, then fire 3 small fireballs (5 damage + fire each; a miss lights a fire block where it lands) about every 8 s, and hit in melee within 2 blocks. A raised shield facing the shots blocks them; a solid block between you and the blaze stops the volley; snowballs deal 3; placed water evaporates in the Nether.${swordHits(observation)}`);
	// BlocksAttacks (shield): a blocked hit of 3+ damage costs 1 + floor(damage) uses (run d9-nether-e: it broke mid-fight).
	const shield = (observation.inventory?.items ?? []).find(e => e?.slot === 'offhand' && e.itemId === 'minecraft:shield');
	const shieldLeft = Number.isFinite(shield?.usesLeft) ? shield.usesLeft : Number.isFinite(shield?.maxDamage) && Number.isFinite(shield?.damage) ? shield.maxDamage - shield.damage : null;
	if (threats.length && Number.isFinite(shieldLeft) && shieldLeft <= 60 && !observation.continuity?.rememberedSections?.includes('inventory')) facts.push(`Offhand shield: ${shieldLeft} uses left; each blocked hit of 3+ damage costs 1 + that damage.`);
	// WitherSkeleton.doHurtTarget: MobEffects.WITHER for 200 ticks; amplifier 0 hurts 1 every 40 ticks. Milk clears effects.
	if (types.has('minecraft:wither_skeleton')) facts.push('Wither skeletons are 2.4 blocks tall: a 2-block-high gap or tunnel keeps them out; each hit restarts 10 s of Wither (1 HP per 2 s, can kill, unlike poison); drinking milk clears it.');
	if (types.has('minecraft:magma_cube')) facts.push('Magma cubes damage on contact even when tiny; larger cubes split on death. A kill can leave several attackers.');
	if (types.has('minecraft:enderman')) facts.push(endermanFact(observation, threats));
	if (types.has('minecraft:ender_dragon')) facts.push(dragonFact(observation));
	if (facts.length || types.has('minecraft:blaze')) facts.push('fight_target pursues by default (including drops up to 3); pursue:false aims/swings without movement or backoff. Knockback can still move you. Choose footing/cover before combat.');
	if (observation.world?.dimension === 'minecraft:overworld' && portalRoomSeen(observation)) facts.push(PORTAL_ROOM_LAVA);
	const crystals = observation.world?.dimension === 'minecraft:the_end' ? endCrystalFact(observation.endCrystals, observation.player) : null;
	if (crystals !== null) facts.push(crystals);
	return facts.length ? facts.join(' ') : null;
}
