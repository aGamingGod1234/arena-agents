// Public model and script facts follow the HUD; the runtime classifier retains the original samples.
export function visiblePlayer(player) {
	if (player === null || typeof player !== 'object') return player;
	const result = { ...player };
	if (result.foodLevel !== undefined) delete result.hunger;
	if (result.onFire !== undefined) delete result.fire;
	for (const field of ['threat', 'highestRiskThreat', 'bestWeapon', 'heardLava']) if (result[field] === null) delete result[field];
	if (Number.isFinite(result.saturation)) {
		// Vanilla shakes the hunger icons when the hidden saturation reserve is empty.
		result.hungerShaking = result.saturation <= 0;
		delete result.saturation;
	}
	delete result.fireTicks;
	if (Number.isSafeInteger(result.teleportTick)) result.repositionedRecently = true;
	delete result.teleportTick;
	if (result.harm != null) {
		for (const field of ['hazard', 'exits', 'hurtBy']) delete result[field];
		if (result.recentDamage?.cause === result.harm.source) delete result.recentDamage;
		else if (result.recentDamage && result.recentDamage.direction === result.harm.direction) {
			const { direction, ...damage } = result.recentDamage;
			result.recentDamage = damage;
		}
	}
	if (Number.isFinite(result.air) && Number.isFinite(result.maxAir) && result.maxAir > 0
		&& (result.underWater === true || result.air < result.maxAir)) {
		result.airBubbles = Math.max(0, Math.ceil((result.air - 2) * 10 / result.maxAir));
	}
	if (result.underWater === true && Number.isFinite(result.air)) result.airSecondsLeft = Math.round(Math.max(0, result.air) / 2) / 10;
	else if (result.underWater !== true) delete result.airSecondsLeft;
	for (const field of ['air', 'maxAir']) delete result[field];
	for (const field of ['health', 'maxHealth', 'absorption']) {
		if (Number.isFinite(result[field])) result[field] = Math.ceil(result[field]);
	}
	for (const field of ['x', 'y', 'z', 'yaw', 'pitch']) {
		if (Number.isFinite(result[field])) result[field] = Math.round(result[field] * 1000) / 1000;
	}
	if (Array.isArray(result.effects)) result.effects = result.effects.map(({ duration, ...effect }) => ({
		...effect, ...(duration === undefined ? {} : { seconds: duration === -1 ? 'infinite' : Math.floor(duration / 20) }),
	}));
	return result;
}

export function visibleWorld(world, player, inventory) {
	if (world === null || typeof world !== 'object') return world;
	const { gameTime, dayTime, naturalRegeneration, simulationDistance, darkIn, ...result } = world;
	const clock = inventory?.selectedItem === 'minecraft:clock'
		|| inventory?.items?.some(item => item?.itemId === 'minecraft:clock' && item.count > 0) === true;
	if ((world.dimension ?? world.dimensionId) === 'minecraft:overworld' && (player?.skyOpen === true || clock)) {
		if (Number.isFinite(dayTime)) {
			const tick = ((dayTime % 24_000) + 24_000) % 24_000;
			result.dayPhase = tick < 11_000 ? 'day' : tick < 13_000 ? 'sunset' : tick < 23_000 ? 'night' : 'sunrise';
			// The sky or a clock gives a coarse phase, not minutes until spawning:
			// weather changes skylight, and the day cycle need not advance at the nominal rate.
			if (player?.skyOpen === true && result.dayPhase === 'sunset') result.darkIn = 'unknown';
		}
	} else delete result.dayPhase;
	if (player?.skyOpen !== true) {
		delete result.raining;
		delete result.thundering;
	}
	if (world.reducedDebugInfo === true) delete result.biome;
	return result;
}

export function visibleHealing(healing, player) {
	if (healing === null || typeof healing !== 'object') return healing;
	const { saturation, regenHPPerSecondMax, naturalRegen, ...result } = healing;
	if (Number.isFinite(result.foodLevel)) result.regenFoodReady = result.foodLevel >= 18;
	if (result.burn !== undefined) result.burn = { remaining: 'not_observed' };
	for (const field of ['health', 'maxHealth']) if (Number.isFinite(result[field])) result[field] = Math.ceil(result[field]);
	if (player?.harm != null) delete result.burn;
	for (const field of ['health', 'maxHealth', 'safe']) if (player?.[field] !== undefined && result[field] === player[field]) delete result[field];
	return result;
}

export function visibleEntity(entity) {
	if (entity === null || typeof entity !== 'object' || typeof entity.type !== 'string' || !entity.type.startsWith('minecraft:')) return entity;
	// Vanilla shows the player's hearts, not another living entity's exact health.
	const { health, maxHealth, ...result } = entity;
	// Older snapshots can still carry visual detail on a sound-only row.
	if (result.perceivedBy === 'sound') delete result.appearance;
	return result;
}

export function visibleObservation(observation) {
	if (observation === null || typeof observation !== 'object') return observation;
	const player = visiblePlayer(observation.player);
	if (observation.world?.reducedDebugInfo === true && player) {
		for (const field of ['x', 'y', 'z', 'yaw', 'pitch']) delete player[field];
	}
	const result = { ...observation, ...(player === undefined ? {} : { player }),
		...(observation.world === undefined ? {} : { world: visibleWorld(observation.world, observation.player, observation.inventory) }),
	};
	for (const field of ['position', 'view']) {
		if (result[field] && typeof result[field] === 'object') result[field] = Object.fromEntries(Object.entries(result[field]).map(([key, value]) => [key, Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value]));
	}
	if (observation.world?.reducedDebugInfo === true) {
		delete result.position;
		delete result.view;
	}
	return result;
}

// An open screen named by the field every menu action takes, so a click or close can copy it as observed. The player's own
// inventory menu is always present and keeps its established shape.
export function visibleMenu(menu) {
	if (menu === null || typeof menu !== 'object' || typeof menu.type !== 'string' || !('containerId' in menu) || menu.type === 'minecraft:inventory') return menu;
	const { type, ...rest } = menu;
	return { menuId: type, ...rest };
}

// All provider tool responses share this boundary, including post-action and sequence observations.
export function visibleToolResult(value) {
	if (Array.isArray(value)) return value.map(visibleToolResult);
	if (value === null || typeof value !== 'object') return value;
	const result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visibleToolResult(entry)]));
	if (result.kind === 'footing' && Array.isArray(result.candidates)) {
		// Complete lists already give their total. Candidate Y and the current Y give the exact height change.
		if (result.nextOffset === undefined && result.total === result.candidates.length) delete result.total;
		if (Number.isFinite(result.at?.y)) for (const candidate of result.candidates) {
			if (Number.isFinite(candidate.y) && candidate.dy === candidate.y - result.at.y) delete candidate.dy;
		}
	}
	if (result.target?.kind === 'position') {
		// Movement receipts use the same milliblock/degree presentation as ordinary observations.
		// Runtime navigation and its threshold decisions retain the original full-precision sample.
		const rounded = number => Number.isFinite(number) ? Math.round(number * 1000) / 1000 : number;
		for (const field of ['position', 'velocity']) {
			if (result[field] && typeof result[field] === 'object') result[field] = Object.fromEntries(Object.entries(result[field]).map(([key, number]) => [key, rounded(number)]));
		}
		for (const field of ['yaw', 'pitch']) if (Object.hasOwn(result, field)) result[field] = rounded(result[field]);
		if (Object.hasOwn(result.target, 'distanceRemaining')) result.target.distanceRemaining = rounded(result.target.distanceRemaining);
		if (result.lookedAt) {
			if (result.lookedAt.position) result.lookedAt.position = Object.fromEntries(Object.entries(result.lookedAt.position).map(([key, number]) => [key, rounded(number)]));
			if (Object.hasOwn(result.lookedAt, 'hitDistance')) result.lookedAt.hitDistance = rounded(result.lookedAt.hitDistance);
		}
	}
	// Action receipts also carry internal absolute ticks; elapsed timing stays in their ordinary duration fields.
	delete result.worldTick;
	if (Number.isSafeInteger(result.teleportTick)) result.repositionedRecently = true;
	delete result.teleportTick;
	if (result.healing !== undefined) result.healing = visibleHealing(result.healing, result.observation?.player ?? result.player);
	if (result.menu !== undefined) result.menu = visibleMenu(result.menu);
	return result.player === undefined ? visibleEntity(result) : visibleObservation(result);
}
