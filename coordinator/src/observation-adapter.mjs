import { types as nodeTypes } from 'node:util';

import { MAX_BLOCKS, MAX_EFFECTS, MAX_ENTITIES, MAX_INVENTORY_SUMMARIES, MAX_LANDMARKS, MAX_OBSERVATION_TAGS, MAX_TAG_COUNT_ENTRIES } from './constants.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COORDINATE_FIELDS = ['x', 'y', 'z'];

/** Converts one validated protocol-v2 observation into the narrow ArenaScript fact shape. */
export function adaptObservation(value) {
	const source = ownDataRecord(value, 'wire observation');
	if (source.ready === false) return { ...emptyFacts(source.status === 'PLAYER_DEAD'), ready: false, ...(source.deathScreen === undefined ? {} : { deathScreen: extensionValue(source.deathScreen, 'deathScreen') }), status: optionalIdentifier(source.status, 'wire observation.status') ?? 'unavailable' };
	if (source.ready !== true) throw new TypeError('wire observation.ready must be boolean');

	const position = vector(source.position, 'wire observation.position');
	const view = vector(source.view, 'wire observation.view', ['yaw', 'pitch']);
	const playerSource = ownDataRecord(source.player, 'wire observation.player');
	const player = {
		x: position.x,
		y: position.y,
		z: position.z,
		yaw: view.yaw,
		pitch: view.pitch,
		dead: false,
	};
	copyNumber(playerSource, player, 'health');
	copyNumber(playerSource, player, 'maxHealth');
	copyNumber(playerSource, player, 'foodLevel', 'hunger');
	copyNumber(playerSource, player, 'foodLevel');
	copyNumber(playerSource, player, 'armor');
	copyNumber(playerSource, player, 'absorption');
	copyNumber(playerSource, player, 'saturation');
	copyNumber(playerSource, player, 'air');
	copyNumber(playerSource, player, 'maxAir');
	copyBoolean(playerSource, player, 'onFire', 'fire');
	copyBoolean(playerSource, player, 'onFire');
	copyBoolean(playerSource, player, 'onGround');
	copyBoolean(playerSource, player, 'inWater');
	copyBoolean(playerSource, player, 'suffocating');
	// Eyes under water and the seconds of breath left before drowning damage starts.
	copyBoolean(playerSource, player, 'underWater');
	copyNumber(playerSource, player, 'airSecondsLeft');
	copyExtensions(playerSource, player, ['waterMotion', 'waterAbove', 'breathable']);
	// Present (true) only while an operator's /takeover owns the body.
	copyBoolean(playerSource, player, 'operatorControlled');
	copyNumber(playerSource, player, 'fallDistance');
	copyBoolean(playerSource, player, 'skyOpen');
	copyNumber(playerSource, player, 'fallDamage');
	copyExtensions(playerSource, player, ['footing', 'stand', 'recentDamage', 'harm', 'clouds']);
	copyExtensions(playerSource, player, ['dropAhead', 'groundAhead', 'brink', 'edges']);
	if (Object.hasOwn(playerSource, 'gameMode')) player.gameMode = identifier(playerSource.gameMode, 'player.gameMode');
	if (Object.hasOwn(playerSource, 'effects')) player.effects = effectFacts(playerSource.effects);
	if (Object.hasOwn(playerSource, 'lastAttacker')) player.lastAttacker = attackerFacts(playerSource.lastAttacker);
	for (const field of ['swimming', 'gliding', 'sprinting', 'crouching', 'onClimbable', 'inLava', 'horizontalCollision', 'verticalCollision', 'passenger']) copyBoolean(playerSource, player, field);
	// Hazard facts, each present only while it applies: the hazard block touched (lava, fire, hot_floor), burn ticks
	// left, seen standable exits, what last hurt the body, lava seen within 4 blocks in the last 30 s, now out of view,
	// and a seen lava flow on its way to the body (lavaFlow: the lava it spreads from, the body cell, about when).
	copyExtensions(playerSource, player, ['pose', 'vehicle', 'hazard', 'fireTicks', 'exits', 'hurtBy', 'lavaSeen', 'lavaFlow']);
	Object.assign(player, threatFacts(source.threats, reachBody(source, playerSource)));
	Object.assign(player, survivalFacts(source.survival));
	if (source.incomingProjectiles !== undefined) player.incomingProjectiles = boundedDataArray(source.incomingProjectiles, 'incomingProjectiles', 8).map((row) => ({ ...ownDataRecord(row, 'incoming projectile') }));
	player.heard = heardFacts(source.heard);
	// Nearest heard lava (pops, rumble, dripping) or null, so a watch condition can guard mining without a loop.
	player.heardLava = player.heard.filter((entry) => entry.sound.includes('lava')).reduce((best, entry) => best === null || entry.distance < best.distance ? entry : best, null);

	const entities = boundedDataArray(source.entities, 'entities', MAX_ENTITIES)
		.map((value, index) => entityFacts(value, index));
	const entityIds = new Set();
	for (const entity of entities) {
		if (entityIds.has(entity.stableId)) throw new TypeError(`duplicate entity identity '${entity.stableId}'`);
		entityIds.add(entity.stableId);
	}
	const items = entities
		.filter((entity) => entity.type === 'minecraft:item')
		.map(({ stableId, itemId, count, distance, tags, x, y, z }) => ({ stableId, itemId, count, ...(distance === undefined ? {} : { distance }), ...(tags === undefined ? {} : { tags }), x, y, z }));

	const blocks = boundedDataArray(source.blocks, 'blocks', MAX_BLOCKS)
		.map((value, index) => blockFacts(value, index));
	const blockIds = new Set();
	for (const block of blocks) {
		if (blockIds.has(block.stableId)) throw new TypeError(`duplicate block identity '${block.stableId}'`);
		blockIds.add(block.stableId);
	}
	const landmarks = Object.hasOwn(source, 'landmarks')
		? boundedDataArray(source.landmarks, 'landmarks', MAX_LANDMARKS).map((value, index) => landmarkFacts(value, index))
		: undefined;

	const inventorySource = ownDataRecord(source.inventory, 'wire observation.inventory');
	const inventoryItems = boundedDataArray(inventorySource.items, 'inventory.items', MAX_INVENTORY_SUMMARIES)
		.map((value, index) => inventoryFacts(value, index));

	const tagCounts = tagCountsFacts(inventorySource.tagCounts);
	const food = Object.hasOwn(inventorySource, 'food') ? foodFacts(inventorySource.food) : undefined;
	return {
		ready: true,
		...(Object.hasOwn(source, 'observedAtEpochMs') ? { observedAtEpochMs: nonNegativeInteger(source.observedAtEpochMs, 'observedAtEpochMs') } : {}),
		...(Object.hasOwn(source, 'routeMemory') ? { routeMemory: extensionValue(source.routeMemory, 'routeMemory') } : {}),
		...(Object.hasOwn(source, 'coverage') ? { coverage: extensionValue(source.coverage, 'coverage') } : {}),
		...(Object.hasOwn(source, 'furnaces') ? { furnaces: extensionValue(source.furnaces, 'furnaces') } : {}),
		...(Object.hasOwn(source, 'perception') ? { perception: extensionValue(source.perception, 'perception') } : {}),
		...(Object.hasOwn(source, 'status') ? { status: identifier(source.status, 'wire observation.status') } : {}),
		...(Object.hasOwn(source, 'velocity') ? { velocity: vector(source.velocity, 'wire observation.velocity') } : {}),
		player,
		items,
		entities,
		blocks,
		...(landmarks === undefined ? {} : { landmarks }),
		inventory: {
			items: inventoryItems,
			...(Object.hasOwn(inventorySource, 'selectedItem') ? { selectedItem: identifier(inventorySource.selectedItem, 'inventory.selectedItem') } : {}),
			...(Object.hasOwn(inventorySource, 'selectedSlot') ? { selectedSlot: nonNegativeInteger(inventorySource.selectedSlot, 'inventory.selectedSlot') } : {}),
			...(tagCounts === undefined ? {} : { tagCounts }),
			...(food === undefined ? {} : { food }),
		},
		...(Object.hasOwn(source, 'nearbyContainers') ? { nearbyContainers: nearbyContainerFacts(source.nearbyContainers) } : {}),
		...(Object.hasOwn(source, 'world') ? { world: worldFacts(source.world) } : {}),
		...(Object.hasOwn(source, 'currentAction') ? { currentAction: currentActionFacts(source.currentAction) } : {}),
		...(Object.hasOwn(source, 'lastResult') ? { lastResult: lastResultFacts(source.lastResult) } : {}),
		...(Object.hasOwn(source, 'interaction') ? { interaction: interactionFacts(source.interaction) } : {}),
		// Structures, caves and ore veins in line of sight; the protocol already bounded and validated each row.
		...(Object.hasOwn(source, 'sighted') ? { sighted: extensionValue(source.sighted, 'sighted') } : {}),
		// The model's reflex rules as the mod runs them (state, firing, recent reports).
		...(Object.hasOwn(source, 'reflexes') ? { reflexes: extensionValue(source.reflexes, 'reflexes') } : {}),
	};
}

/** Alias kept explicit for callers that want to document the protocol boundary. */
export const adaptWireObservation = adaptObservation;

function emptyFacts(dead = false) {
	return { player: { dead }, items: [], entities: [], blocks: [], inventory: { items: [] } };
}

function entityFacts(value, index) {
	const source = ownDataRecord(value, `entities[${index}]`);
	const stableId = immutableIdentity(source, `entities[${index}]`);
	const point = coordinateSource(source, `entities[${index}]`);
	const type = identifier(source.type, `entities[${index}].type`);
	const result = { stableId, type, x: point.x, y: point.y, z: point.z };
	if (Object.hasOwn(source, 'name')) result.name = boundedText(source.name, `entities[${index}].name`, 256, true);
	if (Object.hasOwn(source, 'isPlayer')) result.isPlayer = boolean(source.isPlayer, `entities[${index}].isPlayer`);
	if (Object.hasOwn(source, 'distance')) result.distance = finiteNumber(source.distance, `entities[${index}].distance`);
	if (Object.hasOwn(source, 'tags')) result.tags = tags(source.tags, `entities[${index}].tags`);
	if (type === 'minecraft:item') {
		result.itemId = identifier(source.itemId, `entities[${index}].itemId`);
		result.count = positiveInteger(source.count, `entities[${index}].count`);
	}
	copyExtensions(source, result, ['velocity', 'yaw', 'pitch', 'pose', 'bounds', 'equipment', 'usingItem', 'onFire', 'pickable', 'parentId', 'partName',
		'alive', 'hostile', 'health', 'maxHealth', 'targetingAgent', 'swelling', 'fuse', 'perceivedBy', 'potentialRisk', 'risk', 'expectedHitDamage', 'blastDamageIfBroken', 'arrowFromHere', 'appearance']);
	return result;
}

/** Recent sounds as a player fact: [{ sound, source?, direction, elevation, distance, count?, secondsAgo? }], always present ([] when silent). */
export function heardFacts(value) {
	if (value === undefined) return [];
	return boundedDataArray(value, 'heard', 6).map((entry, index) => {
		const row = ownDataRecord(entry, `heard[${index}]`);
		return {
			sound: boundedText(row.sound, `heard[${index}].sound`, 128),
			...(row.source === undefined ? {} : { source: identifier(row.source, `heard[${index}].source`) }),
			direction: identifier(row.direction, `heard[${index}].direction`),
			elevation: identifier(row.elevation, `heard[${index}].elevation`),
			distance: nonNegativeInteger(row.distance, `heard[${index}].distance`),
			...(row.count === undefined ? {} : { count: positiveInteger(row.count, `heard[${index}].count`) }),
			...(row.secondsAgo === undefined ? {} : { secondsAgo: nonNegativeInteger(row.secondsAgo, `heard[${index}].secondsAgo`) }),
		};
	});
}

const THREAT_URGENCY = Object.freeze({ swelling: 3, creeper_close: 2, attacked: 2, imminent: 2, ranged_aiming: 2, targeting: 1, ranged_sight: 1 });

/**
 * Healing facts as player facts: canHealNow (hurt, safe and able to eat), canEat (any carried food), healFood (best safe food edible now, when it
 * differs from bestFood), bestFood ({ slot, itemId, nutrition, alwaysEdible } or
 * null), safe, and the debounced signals healOpportunity / lowHealthNoFood. Always present so conditions never fail.
 */
export function survivalFacts(value) {
	if (value === undefined) return { canHealNow: false, bestFood: null, healOpportunity: false, lowHealthNoFood: false };
	const source = ownDataRecord(value, 'wire observation.survival');
	const signals = boundedDataArray(source.signals, 'survival.signals', 2).map((signal) => identifier(signal, 'survival signal'));
	const food = source.bestFood === undefined ? null : ownDataRecord(source.bestFood, 'survival.bestFood');
	const heal = source.healFood === undefined ? null : ownDataRecord(source.healFood, 'survival.healFood');
	return {
		canHealNow: boolean(source.canHealNow, 'survival.canHealNow'),
		...(source.canEat === undefined ? {} : { canEat: boolean(source.canEat, 'survival.canEat') }),
		safe: boolean(source.safe, 'survival.safe'),
		bestFood: food === null ? null : { slot: nonNegativeInteger(food.slot, 'bestFood.slot'), itemId: identifier(food.itemId, 'bestFood.itemId'), nutrition: nonNegativeInteger(food.nutrition, 'bestFood.nutrition'),
			...(food.alwaysEdible === undefined ? {} : { alwaysEdible: boolean(food.alwaysEdible, 'bestFood.alwaysEdible') }) },
		...(heal === null ? {} : { healFood: { slot: nonNegativeInteger(heal.slot, 'healFood.slot'), itemId: identifier(heal.itemId, 'healFood.itemId'),
			nutrition: nonNegativeInteger(heal.nutrition, 'healFood.nutrition'),
			...(heal.alwaysEdible === undefined ? {} : { alwaysEdible: boolean(heal.alwaysEdible, 'healFood.alwaysEdible') }) } }),
		healOpportunity: signals.includes('heal_opportunity'),
		lowHealthNoFood: signals.includes('low_health_no_food'),
	};
}

/**
 * Server-sensed threats as player facts so watcher conditions can read them directly:
 * player.state().threats (highest risk first), player.state().threat (the most urgent signal, or null),
 * player.state().highestRiskThreat (or null) and player.state().bestWeapon ({ slot, itemId } or null).
 * Always present, so conditions never hit a missing member.
 */
export function threatFacts(value, body = null) {
	if (value === undefined) return { threats: [], threat: null, highestRiskThreat: null, bestWeapon: null };
	const source = ownDataRecord(value, 'wire observation.threats');
	const threats = boundedDataArray(source.entries, 'threats.entries', 8).map((entry, index) => {
		const row = ownDataRecord(entry, `threats.entries[${index}]`);
		const signals = boundedDataArray(row.signals, `threats.entries[${index}].signals`, 6).map((signal) => identifier(signal, 'threat signal'));
		const visible = row.visible === undefined ? null : boolean(row.visible, 'threat visible');
		const targetable = row.targetable === undefined ? (visible === true ? true : null) : boolean(row.targetable, 'threat targetable');
		const reach = visible === true ? meleeReach(body, row.uuid) : {};
		// With a seen box, melee candidacy is the same eye-to-box reach the melee fact states; without one, range alone.
		const meleeCandidate = row.type !== 'minecraft:creeper' && (reach.melee === undefined ? row.distance <= 3 : reach.melee === 'in reach');
		return {
			stableId: identifier(row.uuid, 'threat uuid'), uuid: identifier(row.uuid, 'threat uuid'), type: identifier(row.type, 'threat type'),
			distance: finiteNumber(row.distance, 'threat distance'), bearing: finiteNumber(row.bearing, 'threat bearing'),
			targeting: boolean(row.targeting, 'threat targeting'), swelling: boolean(row.swelling, 'threat swelling'),
			lineOfSight: boolean(row.lineOfSight, 'threat lineOfSight'), signals,
			// Range alone is only a melee candidate; neither visibility nor targetability proves a route.
			visible, targetable, reachable: null, meleeCandidate, perception: visible === true ? 'visible' : visible === false ? 'heard_or_latched' : 'unknown',
			...(row.dy === undefined ? {} : { dy: finiteNumber(row.dy, 'threat dy') }),
			...(row.holding === undefined ? {} : { holding: identifier(row.holding, 'threat holding') }),
			...reach,
			...(row.shot === undefined ? {} : { shot: row.shot === 'clear' ? 'clear' : `blocked by ${identifier(row.shot, 'threat shot').replace(/^minecraft:/u, '')}` }),
			risk: row.risk === undefined ? 0 : finiteNumber(row.risk, 'threat risk'),
			...(row.expectedHitDamage === undefined ? {} : { expectedHitDamage: finiteNumber(row.expectedHitDamage, 'threat expectedHitDamage') }),
			...(row.closingSpeed === undefined ? {} : { closingSpeed: finiteNumber(row.closingSpeed, 'threat closingSpeed') }),
			...(row.approaching === undefined ? {} : { approaching: boolean(row.approaching, 'threat approaching') }),
			...(row.etaSeconds === undefined ? {} : { etaSeconds: finiteNumber(row.etaSeconds, 'threat etaSeconds') }),
			...(row.contactRisk === undefined ? {} : { contactRisk: finiteNumber(row.contactRisk, 'threat contactRisk') }),
		};
	}).sort((left, right) => right.risk - left.risk || left.distance - right.distance);
	const urgency = (threat) => Math.max(0, ...threat.signals.map((signal) => THREAT_URGENCY[signal] ?? 0));
	const threat = threats.reduce((best, next) => best === null || urgency(next) > urgency(best) ? next : best, null);
	const weapon = source.bestWeapon === undefined ? null : ownDataRecord(source.bestWeapon, 'threats.bestWeapon');
	return {
		threats,
		threat,
		highestRiskThreat: threats[0] ?? null,
		bestWeapon: weapon === null ? null : { slot: nonNegativeInteger(weapon.slot, 'bestWeapon.slot'), itemId: identifier(weapon.itemId, 'bestWeapon.itemId') },
	};
}

// Vanilla Player eye heights by pose and the survival entity interaction range (Player.DEFAULT_ENTITY_INTERACTION_RANGE).
const EYE_HEIGHT = Object.freeze({ standing: 1.62, crouching: 1.27, swimming: 0.4, fall_flying: 0.4, spin_attack: 0.4, sleeping: 0.2 });
const MELEE_REACH = 3;

/** The eye and the seen entity boxes that melee reach needs; null when the body reports no position. */
function reachBody(source, playerSource) {
	const feet = source.position;
	if (!feet || ![feet.x, feet.y, feet.z].every(Number.isFinite)) return null;
	const pose = typeof playerSource?.pose === 'string' ? playerSource.pose : 'standing';
	const bounds = new Map();
	for (const entity of Array.isArray(source.entities) ? source.entities : []) {
		const box = entity?.bounds;
		if (typeof entity?.uuid === 'string' && box && ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every((key) => Number.isFinite(box[key]))) bounds.set(entity.uuid, box);
	}
	return { feet, eyeY: feet.y + (EYE_HEIGHT[pose] ?? EYE_HEIGHT.standing), bounds };
}

/**
 * Whether a seen threat is inside vanilla melee reach: the eye within 3 blocks of its box, as the client's attack check.
 * Out of reach names how far up and across it is from the feet (the same terms fight_target uses), so the choice of
 * weapon or position does not wait for a failed swing. No box seen, no claim.
 */
function meleeReach(body, uuid) {
	const box = body?.bounds.get(uuid);
	if (!box) return {};
	const { feet, eyeY } = body;
	const gap = (low, high, at) => Math.max(low - at, 0, at - high);
	const reach = Math.hypot(gap(box.minX, box.maxX, feet.x), gap(box.minY, box.maxY, eyeY), gap(box.minZ, box.maxZ, feet.z));
	if (reach < MELEE_REACH) return { melee: 'in reach' };
	const up = Math.round((box.minY - feet.y) * 10) / 10;
	const across = Math.round(Math.hypot((box.minX + box.maxX) / 2 - feet.x, (box.minZ + box.maxZ) / 2 - feet.z) * 10) / 10;
	return { melee: `out of reach (${up >= 0 ? `${up.toFixed(1)} up` : `${(-up).toFixed(1)} down`}, ${across.toFixed(1)} across)` };
}

function blockFacts(value, index) {
	const source = ownDataRecord(value, `blocks[${index}]`);
	const point = coordinateSource(source, `blocks[${index}]`);
	const stableId = `${point.x},${point.y},${point.z}`;
	const result = {
		stableId,
		blockId: identifier(source.blockId, `blocks[${index}].blockId`),
		...(Object.hasOwn(source, 'placeableFaces') ? { placeableFaces: identifierList(source.placeableFaces, `blocks[${index}].placeableFaces`, 6) } : {}),
		...(Object.hasOwn(source, 'tags') ? { tags: tags(source.tags, `blocks[${index}].tags`) } : {}),
		x: point.x, y: point.y, z: point.z,
	};
	copyExtensions(source, result, ['state', 'bounds', 'boundsTruncated', 'replaceable', 'fluid', 'text', 'appearance']);
	return result;
}

function landmarkFacts(value, index) {
	const source = ownDataRecord(value, `landmarks[${index}]`);
	const point = coordinateSource(source, `landmarks[${index}]`);
	return {
		stableId: `${point.x},${point.y},${point.z}`,
		blockId: identifier(source.blockId, `landmarks[${index}].blockId`),
		distance: nonNegativeNumber(source.distance, `landmarks[${index}].distance`),
		bearing: boundedNumber(source.bearing, `landmarks[${index}].bearing`, -180, 180),
		elevation: boundedNumber(source.elevation, `landmarks[${index}].elevation`, -90, 90),
		...(Object.hasOwn(source, 'tags') ? { tags: tags(source.tags, `landmarks[${index}].tags`) } : {}),
		x: point.x, y: point.y, z: point.z,
	};
}

function inventoryFacts(value, index) {
	const source = ownDataRecord(value, `inventory.items[${index}]`);
	const slot = source.slot;
	if (!(Number.isSafeInteger(slot) && slot >= 0) && typeof slot !== 'string') throw new TypeError(`inventory.items[${index}].slot must be a slot identifier`);
	const result = {
		itemId: identifier(source.itemId, `inventory.items[${index}].itemId`),
		count: nonNegativeInteger(source.count, `inventory.items[${index}].count`),
		slot,
		...(Object.hasOwn(source, 'tags') ? { tags: tags(source.tags, `inventory.items[${index}].tags`) } : {}),
	};
	if (Object.hasOwn(source, 'damage')) result.damage = nonNegativeInteger(source.damage, `inventory.items[${index}].damage`);
	if (Object.hasOwn(source, 'maxDamage')) result.maxDamage = nonNegativeInteger(source.maxDamage, `inventory.items[${index}].maxDamage`);
	if (Object.hasOwn(source, 'hotbar')) result.hotbar = boolean(source.hotbar, `inventory.items[${index}].hotbar`);
	copyExtensions(source, result, ['displayName', 'fingerprint', 'maxStackSize', 'tooltip', 'tooltipTruncated']);
	return result;
}

function effectFacts(value) {
	return boundedDataArray(value, 'player.effects', MAX_EFFECTS).map((entry, index) => {
		const source = ownDataRecord(entry, `player.effects[${index}]`);
		return {
			effectId: identifier(source.effectId, `player.effects[${index}].effectId`),
			amplifier: nonNegativeInteger(source.amplifier, `player.effects[${index}].amplifier`),
			duration: effectDuration(source.duration, `player.effects[${index}].duration`),
		};
	});
}

function effectDuration(value, field) {
	// Preserve the vanilla infinite sentinel used by the validated observation protocol.
	return value === -1 ? -1 : nonNegativeInteger(value, field);
}

function nearbyContainerFacts(value) {
	return boundedDataArray(value, 'nearbyContainers', 16).map((entry, index) => {
		const source = ownDataRecord(entry, `nearbyContainers[${index}]`);
		return {
			x: integer(source.x, `nearbyContainers[${index}].x`),
			y: integer(source.y, `nearbyContainers[${index}].y`),
			z: integer(source.z, `nearbyContainers[${index}].z`),
			blockId: identifier(source.blockId, `nearbyContainers[${index}].blockId`),
			distance: finiteNumber(source.distance, `nearbyContainers[${index}].distance`),
			withinInteractionRange: boolean(source.withinInteractionRange, `nearbyContainers[${index}].withinInteractionRange`),
			capabilities: identifierList(source.capabilities, `nearbyContainers[${index}].capabilities`, 32),
		};
	});
}

function worldFacts(value) {
	const source = ownDataRecord(value, 'wire observation.world');
	return {
		dimension: identifier(source.dimension, 'world.dimension'),
		...(Object.hasOwn(source, 'reducedDebugInfo') ? { reducedDebugInfo: boolean(source.reducedDebugInfo, 'world.reducedDebugInfo') } : {}),
		...(Object.hasOwn(source, 'biome') ? { biome: identifier(source.biome, 'world.biome') } : {}),
		...(Object.hasOwn(source, 'worldId') ? { worldId: identifier(source.worldId, 'world.worldId') } : {}),
		gameTime: nonNegativeInteger(source.gameTime, 'world.gameTime'),
		dayTime: nonNegativeInteger(source.dayTime, 'world.dayTime'),
		...(source.sleep === undefined ? {} : { sleep: {
			bedExplodes: boolean(ownDataRecord(source.sleep, 'world.sleep').bedExplodes, 'world.sleep.bedExplodes'),
			timeAllowsSleep: boolean(source.sleep.timeAllowsSleep, 'world.sleep.timeAllowsSleep'),
		} }),
		raining: boolean(source.raining, 'world.raining'),
		thundering: boolean(source.thundering, 'world.thundering'),
		...(Object.hasOwn(source, 'difficulty') ? { difficulty: identifier(source.difficulty, 'world.difficulty') } : {}),
		...(Object.hasOwn(source, 'naturalRegeneration') ? { naturalRegeneration: boolean(source.naturalRegeneration, 'world.naturalRegeneration') } : {}),
		...(Object.hasOwn(source, 'simulationDistance') ? { simulationDistance: positiveInteger(source.simulationDistance, 'world.simulationDistance') } : {}),
	};
}

function currentActionFacts(value) {
	const source = ownDataRecord(value, 'wire observation.currentAction');
	const active = boolean(source.active, 'currentAction.active');
	return active ? {
		active,
		actionId: identifier(source.actionId, 'currentAction.actionId'),
		actionType: identifier(source.actionType, 'currentAction.actionType'),
	} : { active };
}

function lastResultFacts(value) {
	const source = ownDataRecord(value, 'wire observation.lastResult');
	const present = boolean(source.present, 'lastResult.present');
	return present ? {
		present,
		actionId: identifier(source.actionId, 'lastResult.actionId'),
		actionType: identifier(source.actionType, 'lastResult.actionType'),
		state: identifier(source.state, 'lastResult.state'),
		reasonCode: identifier(source.reasonCode, 'lastResult.reasonCode'),
		message: boundedText(source.message, 'lastResult.message', 2_048, true),
	} : { present };
}

function interactionFacts(value) {
	const source = ownDataRecord(value, 'wire observation.interaction');
	const input = ownDataRecord(source.input, 'interaction.input');
	const menu = ownDataRecord(source.menu, 'interaction.menu');
	const cursor = ownDataRecord(menu.cursor, 'interaction.menu.cursor');
	const ray = ownDataRecord(source.rayTarget, 'interaction.rayTarget');
	return {
		mainHandItemId: identifier(source.mainHandItemId, 'interaction.mainHandItemId'),
		offHandItemId: identifier(source.offHandItemId, 'interaction.offHandItemId'),
		usingItem: boolean(source.usingItem, 'interaction.usingItem'),
		activeHand: identifier(source.activeHand, 'interaction.activeHand'),
		useRemainingTicks: nonNegativeInteger(source.useRemainingTicks, 'interaction.useRemainingTicks'),
		attackCooldown: finiteNumber(source.attackCooldown, 'interaction.attackCooldown'),
		input: {
			active: boolean(input.active, 'interaction.input.active'),
			forward: finiteNumber(input.forward, 'interaction.input.forward'),
			strafe: finiteNumber(input.strafe, 'interaction.input.strafe'),
			jump: boolean(input.jump, 'interaction.input.jump'),
			sneak: boolean(input.sneak, 'interaction.input.sneak'),
			sprint: boolean(input.sprint, 'interaction.input.sprint'),
			attack: boolean(input.attack, 'interaction.input.attack'),
			use: boolean(input.use, 'interaction.input.use'),
			yaw: finiteNumber(input.yaw, 'interaction.input.yaw'),
			pitch: finiteNumber(input.pitch, 'interaction.input.pitch'),
			selectedSlot: nonNegativeInteger(input.selectedSlot, 'interaction.input.selectedSlot'),
			hand: identifier(input.hand, 'interaction.input.hand'),
		},
		menu: {
			type: identifier(menu.type, 'interaction.menu.type'),
			cursor: stackDetails(cursor, 'interaction.menu.cursor'),
			slots: boundedDataArray(menu.slots, 'interaction.menu.slots', 64).map((entry, index) => {
				const slot = ownDataRecord(entry, `interaction.menu.slots[${index}]`);
				return { slot: nonNegativeInteger(slot.slot, `interaction.menu.slots[${index}].slot`), ...stackDetails(slot, `interaction.menu.slots[${index}]`) };
			}),
			capabilities: identifierList(menu.capabilities, 'interaction.menu.capabilities', 8),
			...extensionFields(menu, ['containerId', 'stateId', 'slotCount', 'offset', 'hasMore', 'details']),
		},
		rayTarget: ray.type === 'block' ? {
			type: 'block', x: integer(ray.x, 'interaction.rayTarget.x'), y: integer(ray.y, 'interaction.rayTarget.y'), z: integer(ray.z, 'interaction.rayTarget.z'),
			face: identifier(ray.face, 'interaction.rayTarget.face'), blockId: identifier(ray.blockId, 'interaction.rayTarget.blockId'),
		} : ray.type === 'entity' ? { type: 'entity', uuid: identifier(ray.uuid, 'interaction.rayTarget.uuid'), entityType: identifier(ray.entityType, 'interaction.rayTarget.entityType') } : { type: identifier(ray.type, 'interaction.rayTarget.type') },
	};
}

function stackDetails(source, label) {
	return {
		itemId: identifier(source.itemId, `${label}.itemId`),
		count: nonNegativeInteger(source.count, `${label}.count`),
		...extensionFields(source, ['displayName', 'fingerprint', 'damage', 'maxDamage', 'maxStackSize', 'tooltip', 'tooltipTruncated', 'x', 'y', 'pickupAllowed', 'slotLimit']),
	};
}

function extensionFields(source, fields) {
	const result = {};
	copyExtensions(source, result, fields);
	return result;
}

function copyExtensions(source, target, fields) {
	for (const field of fields) if (Object.hasOwn(source, field)) target[field] = extensionValue(source[field], field);
}

/** Preserve bounded protocol extension data without invoking accessors or accepting executable values. */
function extensionValue(value, label, depth = 0, budget = { bytes: 0 }) {
	if (depth > 10) throw new TypeError(`${label} exceeds nesting bound`);
	if (value === null || typeof value === 'boolean') return value;
	if (typeof value === 'number') return finiteNumber(value, label);
	if (typeof value === 'string') {
		budget.bytes += Buffer.byteLength(value, 'utf8');
		if (value.length > 8_192 || budget.bytes > 32_768) throw new TypeError(`${label} exceeds text bound`);
		return value;
	}
	if (Array.isArray(value)) return boundedDataArray(value, label, 256)
		.map((entry, index) => extensionValue(entry, `${label}[${index}]`, depth + 1, budget));
	const record = ownDataRecord(value, label);
	const keys = Object.keys(record);
	if (keys.length > 128) throw new TypeError(`${label} exceeds field bound`);
	return Object.fromEntries(keys.map((key) => [key, extensionValue(record[key], `${label}.${key}`, depth + 1, budget)]));
}

function tags(value, label) {
	const values = boundedDataArray(value, label, MAX_OBSERVATION_TAGS).map((tag, index) => {
		if (typeof tag !== 'string' || !tag.startsWith('#') || tag.length < 2 || tag.length > 256) throw new TypeError(`${label}[${index}] must be a tag identifier`);
		return tag;
	});
	if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique`);
	return values;
}

function identifierList(value, label, maximum) {
	const values = boundedDataArray(value, label, maximum).map((entry, index) => identifier(entry, `${label}[${index}]`));
	if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique`);
	return values;
}

/** The server's summary of carried food, read from the installed food components; risky foods are named. */
function foodFacts(value) {
	const source = ownDataRecord(value, 'wire observation.inventory.food');
	const risky = Object.hasOwn(source, 'risky')
		? boundedDataArray(source.risky, 'inventory.food.risky', MAX_INVENTORY_SUMMARIES).map((row, index) => {
			const entry = ownDataRecord(row, `inventory.food.risky[${index}]`);
			return { itemId: identifier(entry.itemId, `inventory.food.risky[${index}].itemId`), count: nonNegativeInteger(entry.count, `inventory.food.risky[${index}].count`),
				nutrition: nonNegativeInteger(entry.nutrition, `inventory.food.risky[${index}].nutrition`) };
		})
		: undefined;
	return { items: nonNegativeInteger(source.items, 'inventory.food.items'), nutrition: nonNegativeInteger(source.nutrition, 'inventory.food.nutrition'),
		...(risky === undefined ? {} : { risky }) };
}

function tagCountsFacts(value) {
	if (value === undefined) return undefined;
	const source = ownDataRecord(value, 'wire observation.inventory.tagCounts');
	const keys = Object.keys(source);
	if (keys.length > MAX_TAG_COUNT_ENTRIES) throw new TypeError(`tagCounts exceeds bound of ${MAX_TAG_COUNT_ENTRIES}`);
	const result = {};
	for (const key of keys) {
		if (!key.startsWith('#') || key.length < 2 || key.length > 256) throw new TypeError(`tagCounts key must be a tag identifier`);
		result[key] = nonNegativeInteger(source[key], `tagCounts.${key}`);
	}
	return result;
}

function coordinateSource(source, label) {
	if (Object.hasOwn(source, 'position')) return vector(source.position, `${label}.position`);
	const point = {};
	for (const field of COORDINATE_FIELDS) point[field] = finiteNumber(source[field], `${label}.${field}`);
	return point;
}

function vector(value, label, fields = COORDINATE_FIELDS) {
	const source = ownDataRecord(value, label);
	const result = {};
	for (const field of fields) result[field] = finiteNumber(source[field], `${label}.${field}`);
	return result;
}

function immutableIdentity(source, label) {
	const field = Object.hasOwn(source, 'uuid') ? 'uuid' : Object.hasOwn(source, 'id') ? 'id' : null;
	if (field === null) throw new TypeError(`${label} requires an immutable uuid or id`);
	return identifier(source[field], `${label}.${field}`);
}

function copyNumber(source, target, sourceField, targetField = sourceField) {
	if (Object.hasOwn(source, sourceField)) target[targetField] = finiteNumber(source[sourceField], `player.${sourceField}`);
}

function copyBoolean(source, target, sourceField, targetField = sourceField) {
	if (Object.hasOwn(source, sourceField)) {
		if (typeof source[sourceField] !== 'boolean') throw new TypeError(`player.${sourceField} must be boolean`);
		target[targetField] = source[sourceField];
	}
}

function attackerFacts(value) {
	const source = ownDataRecord(value, 'wire observation.player.lastAttacker');
	if (Reflect.ownKeys(source).some((key) => !['uuid', 'type', 'distance'].includes(key))) {
		throw new TypeError('wire observation.player.lastAttacker has an invalid schema');
	}
	return {
		uuid: identifier(source.uuid, 'player.lastAttacker.uuid'),
		type: identifier(source.type, 'player.lastAttacker.type'),
		distance: finiteNumber(source.distance, 'player.lastAttacker.distance'),
	};
}

function identifier(value, label) {
	if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError(`${label} must be a nonblank identifier`);
	return value;
}

function optionalIdentifier(value, label) {
	return value === undefined ? undefined : identifier(value, label);
}

function boundedText(value, label, maximumCodePoints, allowEmpty = false) {
	if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || [...value].length > maximumCodePoints) {
		throw new TypeError(`${label} must be bounded text`);
	}
	return value;
}

function boolean(value, label) {
	if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
	return value;
}

function finiteNumber(value, label) {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
	return value;
}

function nonNegativeNumber(value, label) {
	const number = finiteNumber(value, label);
	if (number < 0) throw new TypeError(`${label} must be non-negative`);
	return number;
}

function boundedNumber(value, label, minimum, maximum) {
	const number = finiteNumber(value, label);
	if (number < minimum || number > maximum) throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
	return number;
}

function positiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
	return value;
}

function integer(value, label) {
	if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
	return value;
}

function nonNegativeInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
	return value;
}

function boundedDataArray(value, label, maximum) {
	// A plain array with exactly its indices and `length` as own keys needs one descriptor check per element.
	// Anything else takes the exhaustive path below, which also names the failure.
	if (Array.isArray(value) && !nodeTypes.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype) {
		const length = value.length;
		if (length <= maximum && Reflect.ownKeys(value).length === length + 1) {
			const copied = new Array(length);
			let index = 0;
			for (; index < length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) break;
				copied[index] = descriptor.value;
			}
			if (index === length) return copied;
		}
	}
	return exhaustiveBoundedDataArray(value, label, maximum);
}

function exhaustiveBoundedDataArray(value, label, maximum) {
	if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a plain array`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) throw new TypeError(`${label} has unsafe keys`);
	const length = descriptors.length;
	if (!length || length.get || length.set || !Number.isSafeInteger(length.value)) throw new TypeError(`${label} has invalid length`);
	if (length.value > maximum) throw new TypeError(`${label} exceeds bound of ${maximum}`);
	const copied = [];
	for (let index = 0; index < length.value; index += 1) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw new TypeError(`${label} must be dense own data`);
		copied.push(descriptor.value);
	}
	if (keys.length !== length.value + 1) throw new TypeError(`${label} must not have holes or custom keys`);
	return copied;
}

function ownDataRecord(value, label) {
	if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) throw new TypeError(`${label} must be a plain data record`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) throw new TypeError(`${label} must be a plain data record`);
	const record = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) throw new TypeError(`${label} contains an unsafe key`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw new TypeError(`${label}.${key} must be own data`);
		record[key] = descriptor.value;
	}
	return record;
}
