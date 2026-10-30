// Nether fixture reconstructed from the recorded 2026-10-09 run, not an exact event recording.
// Tags are archived vanilla/Fabric 26.1.2 values; runtime facts use the production adapter.
import { adaptObservation } from '../../observation-adapter.mjs';
import { composeTwoCallView } from '../../two-call-llm-wrap.mjs';

// ---- vanilla + Fabric conventional tags, resolved like holder.tags() ----
const recordedTags = {"item": {"minecraft:diamond_helmet": ["#minecraft:head_armor", "#minecraft:trimmable_armor"], "minecraft:diamond_chestplate": ["#minecraft:chest_armor", "#minecraft:trimmable_armor"], "minecraft:diamond_leggings": ["#minecraft:leg_armor", "#minecraft:trimmable_armor"], "minecraft:diamond_boots": ["#minecraft:foot_armor", "#minecraft:trimmable_armor"], "minecraft:diamond_sword": ["#c:tools", "#minecraft:breaks_decorated_pots", "#minecraft:swords"], "minecraft:cooked_beef": ["#c:animal_foods", "#minecraft:meat", "#minecraft:wolf_food"], "minecraft:diamond_pickaxe": ["#c:tools", "#minecraft:breaks_decorated_pots", "#minecraft:cluster_max_harvestables", "#minecraft:pickaxes"], "minecraft:diamond_axe": ["#c:tools", "#minecraft:axes", "#minecraft:breaks_decorated_pots"], "minecraft:cobblestone": ["#minecraft:stone_crafting_materials", "#minecraft:stone_tool_materials"], "minecraft:torch": [], "minecraft:flint_and_steel": ["#minecraft:creeper_igniters"], "minecraft:bow": ["#minecraft:skeleton_preferred_weapons", "#minecraft:wither_skeleton_disliked_weapons"], "minecraft:arrow": ["#minecraft:arrows"], "minecraft:shield": []}, "block": {"minecraft:netherrack": ["#c:netherracks", "#minecraft:base_stone_nether", "#minecraft:infiniburn_end", "#minecraft:infiniburn_nether", "#minecraft:infiniburn_overworld", "#minecraft:nether_carver_replaceables", "#minecraft:sculk_replaceable", "#minecraft:sculk_replaceable_world_gen", "#minecraft:supports_wither_rose"], "minecraft:soul_sand": ["#minecraft:enables_bubble_column_push_up", "#minecraft:nether_carver_replaceables", "#minecraft:sculk_replaceable", "#minecraft:sculk_replaceable_world_gen", "#minecraft:soul_fire_base_blocks", "#minecraft:soul_speed_blocks", "#minecraft:support_override_snow_layer", "#minecraft:supports_nether_wart", "#minecraft:supports_wither_rose", "#minecraft:triggers_ambient_dried_ghast_block_sounds", "#minecraft:wither_summon_base_blocks"], "minecraft:nether_gold_ore": ["#minecraft:gold_ores", "#minecraft:guarded_by_piglins"], "minecraft:lava": ["#minecraft:enchantment_power_transmitter", "#minecraft:geode_invalid_blocks", "#minecraft:replaceable", "#minecraft:strider_warm_blocks"], "minecraft:glowstone": [], "minecraft:nether_quartz_ore": [], "minecraft:magma_block": ["#minecraft:cannot_support_kelp", "#minecraft:cannot_support_seagrass", "#minecraft:enables_bubble_column_drag_down", "#minecraft:happy_ghast_avoids", "#minecraft:infiniburn_end", "#minecraft:infiniburn_nether", "#minecraft:infiniburn_overworld"], "minecraft:gravel": ["#c:gravels", "#minecraft:azalea_root_replaceable", "#minecraft:enderman_holdable", "#minecraft:goats_spawnable_on", "#minecraft:lush_ground_replaceable", "#minecraft:overworld_carver_replaceables", "#minecraft:sculk_replaceable", "#minecraft:sculk_replaceable_world_gen", "#minecraft:supports_bamboo", "#minecraft:trail_ruins_replaceable"], "minecraft:crimson_nylium": ["#minecraft:enderman_holdable", "#minecraft:huge_brown_mushroom_can_place_on", "#minecraft:huge_red_mushroom_can_place_on", "#minecraft:nether_carver_replaceables", "#minecraft:nylium", "#minecraft:overrides_mushroom_light_requirement", "#minecraft:sculk_replaceable", "#minecraft:sculk_replaceable_world_gen", "#minecraft:supports_crimson_fungus", "#minecraft:supports_crimson_roots", "#minecraft:supports_nether_sprouts", "#minecraft:supports_warped_fungus", "#minecraft:supports_warped_roots"], "minecraft:crimson_stem": ["#minecraft:completes_find_tree_tutorial", "#minecraft:crimson_stems", "#minecraft:lava_pool_stone_cannot_replace", "#minecraft:logs", "#minecraft:parrots_spawnable_on", "#minecraft:prevents_nearby_leaf_decay"], "minecraft:nether_wart_block": ["#minecraft:completes_find_tree_tutorial", "#minecraft:nether_carver_replaceables", "#minecraft:wart_blocks"]}};
function loadTags(kind) { return id => recordedTags[kind][id] ?? []; }
const itemTags = loadTags('item'), blockTags = loadTags('block');

// ---- Nether-run fixture (mid-run: armoured, piglins around, walking a ridge) ----
const uuid = (n) => `${(0x8024feae + n).toString(16).padStart(8, '0')}-5730-4f67-84be-00a13e73b0${String(n).padStart(2, '0')}`;
const fp = (s) => [...Buffer.from(s.padEnd(32, '#'))].map(b => (b * 7 % 256).toString(16).padStart(2, '0')).join('').slice(0, 64);
const INVENTORY = [
	['minecraft:diamond_helmet', 1, 'head', 363], ['minecraft:diamond_chestplate', 1, 'chest', 528], ['minecraft:diamond_leggings', 1, 'legs', 495], ['minecraft:diamond_boots', 1, 'feet', 429],
	['minecraft:diamond_sword', 1, 0, 1561], ['minecraft:cooked_beef', 23, 1, 0], ['minecraft:diamond_pickaxe', 1, 2, 1561], ['minecraft:diamond_axe', 1, 3, 1561],
	['minecraft:cobblestone', 48, 4, 0], ['minecraft:torch', 16, 5, 0], ['minecraft:flint_and_steel', 1, 6, 64], ['minecraft:bow', 1, 7, 384], ['minecraft:arrow', 32, 8, 0],
	['minecraft:shield', 1, 'offhand', 336],
];
const display = (id) => id.replace('minecraft:', '').split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
function wireInventory() {
	const items = INVENTORY.map(([itemId, count, slot, maxDamage]) => ({ itemId, count, damage: maxDamage > 0 ? 12 : 0, maxDamage, tags: itemTags(itemId),
		maxStackSize: maxDamage > 0 ? 1 : 64, displayName: display(itemId), fingerprint: fp(itemId), slot, ...(typeof slot === 'number' ? { hotbar: slot < 9 } : {}) }));
	const tagCounts = {};
	for (const it of items) for (const t of it.tags) tagCounts[t] = (tagCounts[t] ?? 0) + it.count;
	return { items, tagCounts: Object.fromEntries(Object.entries(tagCounts).sort().slice(0, 128)), selectedItem: 'minecraft:diamond_sword' };
}
const full = (p) => [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }];
function wireBlocks(px, py, pz) {
	const rows = [];
	const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
	const pick = (x, y, z) => { const h = Math.abs((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) % 100;
		return h < 4 ? 'minecraft:nether_gold_ore' : h < 7 ? 'minecraft:nether_quartz_ore' : h < 9 ? 'minecraft:magma_block' : h < 12 ? 'minecraft:gravel' : h < 14 ? 'minecraft:soul_sand' : 'minecraft:netherrack'; };
	for (let r = 1; rows.length < 128 && r <= 6; r++) for (let dy = -2; dy <= 2 && rows.length < 128; dy++) for (let dx = -r; dx <= r && rows.length < 128; dx++) for (let dz = -r; dz <= r && rows.length < 128; dz++) {
		if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
		const y = cy + dy - 1; if (dy > 0 && (dx + dz) % 3 !== 0) continue;
		const blockId = pick(cx + dx, y, cz + dz);
		rows.push({ x: cx + dx, y, z: cz + dz, blockId, state: {}, bounds: full(), boundsTruncated: false, replaceable: false, tags: blockTags(blockId), placeableFaces: r <= 4 && dy === -1 ? ['up'] : [] });
	}
	rows.splice(20, 1, { x: cx + 5, y: cy - 3, z: cz - 2, blockId: 'minecraft:lava', state: { level: '0' }, bounds: [], boundsTruncated: false, replaceable: true, tags: blockTags('minecraft:lava'), placeableFaces: [], fluid: { type: 'minecraft:lava', height: 0.8888889 } });
	return rows;
}
function wireLandmarks(px, py, pz, yaw) {
	const ids = ['minecraft:lava', 'minecraft:glowstone', 'minecraft:nether_gold_ore', 'minecraft:nether_quartz_ore', 'minecraft:magma_block', 'minecraft:soul_sand', 'minecraft:gravel', 'minecraft:crimson_nylium', 'minecraft:crimson_stem', 'minecraft:nether_wart_block', 'minecraft:shroomlight', 'minecraft:blackstone'];
	return Array.from({ length: 24 }, (_, i) => { const x = Math.round(px + 40 * Math.cos(i)) , y = Math.round(py - 10 + (i % 7) * 4), z = Math.round(pz + 40 * Math.sin(i * 1.3));
		const dx = x + 0.5 - px, dy = y + 0.5 - py - 1.62, dz = z + 0.5 - pz; const d = Math.hypot(dx, dy, dz);
		let bearing = Math.atan2(-dx, dz) * 180 / Math.PI - yaw; bearing = ((bearing + 540) % 360) - 180;
		return { x, y, z, blockId: ids[i % ids.length], distance: d, bearing, elevation: Math.asin(dy / d) * 180 / Math.PI, tags: blockTags(ids[i % ids.length]) }; });
}
function entity(n, type, name, px, py, pz, ex, ey, ez, extra) {
	const d = Math.hypot(ex - px, ey - py, ez - pz);
	return { uuid: uuid(n), type, name, distance: d, position: { x: ex, y: ey, z: ez }, pickable: true,
		velocity: { x: 0.0213345 * n, y: -0.0784000015258789, z: -0.01876543 }, yaw: 127.34567 + n, pitch: 12.5, pose: 'standing',
		bounds: [{ minX: ex - 0.3, minY: ey, minZ: ez - 0.3, maxX: ex + 0.3, maxY: ey + 1.95, maxZ: ez + 0.3 }],
		equipment: extra.equipment ?? [], usingItem: false, onFire: false, alive: true, hostile: extra.hostile, ...(extra.risk === undefined ? {} : { potentialRisk: extra.risk, ...(extra.active ? { risk: extra.risk } : {}), expectedHitDamage: extra.hit }),
		health: extra.health, maxHealth: extra.health, targetingAgent: extra.targeting ?? false, perceivedBy: 'sight' };
}
function wireObservation(step) {
	const px = 369.68449059 + step * 2.8734567, py = 87 + (step % 3) * 0.41999998688698, pz = -177.96306679230216 - step * 1.234567, yaw = 93.45678 + step * 7.3, pitch = 12.3456;
	const ents = [
		entity(1, 'minecraft:piglin', 'Piglin', px, py, pz, px + 4.2 - step * 0.3, py, pz + 3.1, { hostile: true, risk: 4.2, active: true, hit: 5, health: 16, targeting: true, equipment: [{ slot: 'mainhand', itemId: 'minecraft:golden_sword', enchanted: false }] }),
		entity(2, 'minecraft:piglin', 'Piglin', px, py, pz, px - 7.5, py - 6, pz + 9.25, { hostile: true, risk: 2.8, active: true, hit: 4, health: 16, targeting: true, equipment: [{ slot: 'mainhand', itemId: 'minecraft:crossbow', enchanted: false }] }),
		entity(3, 'minecraft:zombified_piglin', 'Zombified Piglin', px, py, pz, px + 12.75, py + 2, pz - 8.5, { hostile: false, risk: 3.1, hit: 8, health: 20, equipment: [{ slot: 'mainhand', itemId: 'minecraft:golden_sword', enchanted: false }] }),
		entity(4, 'minecraft:zombified_piglin', 'Zombified Piglin', px, py, pz, px + 18.5, py - 3, pz + 14.2, { hostile: false, risk: 3.1, hit: 8, health: 20, equipment: [{ slot: 'mainhand', itemId: 'minecraft:golden_sword', enchanted: false }] }),
		entity(5, 'minecraft:hoglin', 'Hoglin', px, py, pz, px - 21.3, py + 1, pz - 15.7, { hostile: true, risk: 1.4, hit: 6, health: 40 }),
		entity(6, 'minecraft:strider', 'Strider', px, py, pz, px + 30.1, py - 18, pz + 5.5, { hostile: false, health: 20 }),
	];
	const threat = (e, signals) => ({ uuid: e.uuid, type: e.type, distance: Math.round(e.distance * 10) / 10, bearing: 41.3 + e.distance, targeting: e.targetingAgent, swelling: false, lineOfSight: true, signals,
		risk: e.risk ?? 0, riskFactors: { distance: 0.6, damage: 0.5, armor: 0.2, health: 0.3, lineOfSight: 1 }, expectedHitDamage: e.expectedHitDamage, closingSpeed: 1.8, approaching: true, etaSeconds: 1.9, contactRisk: 5.6 });
	return {
		goalRevision: 1, observedAtEpochMs: 1791522700000 + step * 3000, ready: true, status: 'ready', eventSequence: 200 + step, attention: true, changedFacts: ['threats'],
		position: { x: px, y: py, z: pz }, velocity: { x: 0.21587654321, y: -0.0784000015258789, z: -0.0934567 }, view: { yaw, pitch },
		player: { health: 14, maxHealth: 20, armor: 20, foodLevel: 17, saturation: 3.2000003, gameMode: 'survival', onGround: true, inWater: false, onFire: false, air: 300, maxAir: 300, underWater: false,
			suffocating: false, fallDistance: 0, pose: 'standing', swimming: false, gliding: false, sprinting: true, crouching: false, onClimbable: false, inLava: false, horizontalCollision: false, verticalCollision: true, passenger: false,
			lastAttacker: { uuid: ents[0].uuid, type: 'minecraft:piglin', distance: ents[0].distance }, effects: [] },
		threats: { entries: [threat(ents[0], ['targeting', 'attacked']), threat(ents[1], ['targeting', 'ranged_sight'])], bestWeapon: { slot: 0, itemId: 'minecraft:diamond_sword' } },
		survival: { canHealNow: false, safe: false, bestFood: { slot: 1, itemId: 'minecraft:cooked_beef', nutrition: 8 }, signals: [] },
		heard: [{ sound: 'entity.piglin.angry', source: 'hostile', direction: 'right', elevation: 'level', distance: 5, count: 2, secondsAgo: 1 }, { sound: 'entity.zombified_piglin.ambient', source: 'hostile', direction: 'behind', elevation: 'level', distance: 14, secondsAgo: 3 }, { sound: 'block.lava.pop', source: 'block', direction: 'left', elevation: 'below', distance: 9, count: 3, secondsAgo: 2 }],
		interaction: { mainHandItemId: 'minecraft:diamond_sword', offHandItemId: 'minecraft:shield', usingItem: false, activeHand: 'main_hand', useRemainingTicks: 0, attackCooldown: 1,
			input: { active: true, forward: 1, strafe: 0, jump: false, sneak: false, sprint: true, attack: false, use: false, yaw, pitch, selectedSlot: 0, hand: 'main' },
			menu: { type: 'minecraft:inventory', containerId: 0, stateId: 41 + step, slotCount: 46, cursor: { itemId: 'minecraft:air', count: 0 },
				slots: Array.from({ length: 16 }, (_, i) => { const armor = [null, null, null, null, null, 'minecraft:diamond_helmet', 'minecraft:diamond_chestplate', 'minecraft:diamond_leggings', 'minecraft:diamond_boots', null, null, null, null, null, null, null][i];
					return armor ? { itemId: armor, count: 1, fingerprint: fp(armor), slot: i } : { itemId: 'minecraft:air', count: 0, slot: i }; }),
				offset: 0, hasMore: true, capabilities: ['click'] },
			rayTarget: { type: 'block', x: Math.floor(px) + 2, y: Math.floor(py) - 1, z: Math.floor(pz) + 1, face: 'up', blockId: 'minecraft:netherrack' } },
		inventory: wireInventory(),
		entities: ents,
		blocks: wireBlocks(px, py, pz),
		landmarks: wireLandmarks(px, py, pz, yaw),
		sighted: { veins: [{ x: 402, y: 61, z: -170, distance: 41, bearing: -33, blockId: 'minecraft:nether_gold_ore', visible: 3 }], caves: [{ x: 351, y: 70, z: -160, distance: 29, bearing: 120, air: 46 }] },
		nearbyContainers: [],
		world: { dimension: 'minecraft:the_nether', worldId: '90d02e6f-539e-4e64-ae51-268325811832', gameTime: 6417 + step * 60, dayTime: 18000, raining: false, thundering: false, difficulty: 'normal', naturalRegeneration: true },
		currentAction: { active: true, actionId: `native:c162b18d-ecef-478b-a9b1-60d8317276c5:${20 + step}:00000000-0000-4000-8000-00000000:1`, actionType: 'move_to' },
		lastResult: { present: true, actionId: `native:c162b18d-ecef-478b-a9b1-60d8317276c5:${19 + step}:00000000-0000-4000-8000-00000000:1`, actionType: 'move_to', state: 'SUCCEEDED', reasonCode: 'DESTINATION_REACHED', message: 'Reached 366,89,-184 within tolerance 3.' },
		perception: { latestSequence: 40 + step, events: [{ type: 'sound', soundId: 'minecraft:entity.piglin.angry', direction: 'east', range: 'near', elevation: 'level', sequence: 39 + step, gameTime: 6400 + step * 60, dimension: 'minecraft:the_nether', observedAtEpochMs: 1791522699000 + step * 3000 }], bossBars: [], earliestSequence: 1 },
		coverage: { mode: 'sampled_visible', complete: false, blocksRadius: 6, landmarkDistanceLimit: 256, entitiesDistanceLimit: 128, sections: { entities: { returned: 6, complete: false }, blocks: { returned: 128, complete: false }, landmarks: { returned: 24, complete: false }, nearbyContainers: { returned: 0, complete: false } } },
	};
}
const GOAL = 'beat the game';
const GOAL_SPEC = null;
const record = { agentId: '00000000-0000-4000-8000-000000000001', goalRevision: 1, currentGoal: GOAL, currentGoalSpec: GOAL_SPEC };
const TASK_MEMORY = { worldId: '90d02e6f-539e-4e64-ae51-268325811832', dimension: 'minecraft:the_nether', revision: 0, currentGoalRevision: 1, historical: true, progress: [], routes: [], places: [], lessons: [], assets: [], deaths: [], totals: { entries: 0, assets: 0, deaths: 0 }, query: 'Use taskMemory query for route waypoints, earlier records and pagination. Reobserve routes and drops before acting.' };

function decorated(step) {
	const facts = adaptObservation(wireObservation(step));
	const view = composeTwoCallView(facts, null, { occupancy: null, agentId: record.agentId });
	return { ...view, freshness: { fresh: true } };
}
export { decorated, record, TASK_MEMORY };
