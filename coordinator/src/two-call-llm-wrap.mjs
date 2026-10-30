/** Shapes factual recovery, exploration candidates and action failure categories. */

import { ExplorationOccupancy } from './explore-frontier.mjs';
import { RecoveryProgressStore, doNotRedoFor } from './recovery-progress-wrap.mjs';
import { dropLoss, recoveryRoute, recoveryPreparation } from './respawn-recovery.mjs';

const PATH_FAILURE_CODES = new Set([
	'DESTINATION_NEAR_UNVERIFIED',
	'PATH_BLOCKED',
	'NO_PROGRESS',
	'DESTINATION_BLOCKED',
	'TARGET_NOT_LOADED',
	'NO_PATH',
	'NO_STANDABLE_PATH',
	'PATH_LIMIT_REACHED',
	'NO_FRONTIER',
]);

const TARGET_FAILURE_CODES = new Set([
	'TARGET_NOT_VISIBLE',
	'TARGET_OBSTRUCTED',
	'TARGET_OUT_OF_RANGE',
	'TARGET_TOO_FAR',
	'TARGET_CHANGED',
	'ACTION_TIMEOUT',
	'STALE_REVISION',
	'EXPECTED_BLOCK_MISMATCH',
	'NO_OBSERVATION',
]);

const SUCCESS_REASON_CODES = new Set([
	'DONE',
	'BLOCK_BROKEN',
	'DESTINATION_REACHED',
	'ACTION_COMPLETED',
	'CONTROL_SEGMENT_COMPLETED',
	'TARGET_ALREADY_SATISFIED',
	'BLOCK_PLACED',
	'ITEM_PICKED_UP',
	'CUE_IN_VIEW',
	'COMPLETION_VERIFIED',
]);

const LIFECYCLE_FAILURE_CODES = new Set([
	'PLAYER_DEAD',
	'PLAYER_UNAVAILABLE',
	'AGENT_DEAD',
	'AGENT_NOT_DEAD',
]);

const CAPABILITY_FAILURE_CODES = new Set([
	'RECIPE_NOT_FOUND',
	'UNSUPPORTED_ACTION',
	'SIMULATOR_UNSUPPORTED_ACTION',
]);


export { doNotRedoFor };

/** Unit facade over recovery + occupancy. Production uses NativeToolRuntime's stores. */
export class TwoCallLlmWrap {
	#recovery = new RecoveryProgressStore();
	#occupancy = new ExplorationOccupancy();

	ingest(agentId, observation = {}, { goalRevision = 0 } = {}) {
		this.#recovery.remember(agentId, goalRevision, observation);
		this.#occupancy.ingest(agentId, observation, { snapshot: false });
		return this.#recovery.snapshot(agentId, observation);
	}

	decorate(agentId, observation = {}) {
		const snapshot = this.#recovery.snapshot(agentId, observation);
		return composeTwoCallView(observation, snapshot, {
			occupancy: this.#occupancy,
			agentId,
		});
	}

	ingestAndDecorate(agentId, observation = {}, options = {}) {
		this.ingest(agentId, observation, options);
		return this.decorate(agentId, observation, options);
	}
}

export function wrapTwoCallObservation(observation = {}, recoveryState = {}, { goal = null } = {}) {
	const recovery = recoveryFromState(observation, recoveryState);
	return composeTwoCallView(observation, recovery, {
		occupancy: null,
		agentId: 'wrap',
		goal,
	});
}

export function classifyBodyFailure(reasonCode, state = undefined) {
	const code = typeof reasonCode === 'string' ? reasonCode : '';
	if (code.length === 0) return null;
	const normalizedState = typeof state === 'string' ? state : '';
	if (normalizedState === 'SUCCEEDED' || normalizedState === 'COMPLETED') return null;
	if (SUCCESS_REASON_CODES.has(code)) return null;
	if (LIFECYCLE_FAILURE_CODES.has(code)) return 'lifecycle';
	if (PATH_FAILURE_CODES.has(code)) return 'path';
	if (CAPABILITY_FAILURE_CODES.has(code)) return 'capability';
	if (TARGET_FAILURE_CODES.has(code)) return 'target';
	if (code.length > 0) return 'action';
	return null;
}

export function composeTwoCallView(observation = {}, recovery = null, {
	occupancy = null,
	agentId = null,
} = {}) {
	const failureClass = inferFailureClass(observation);
	const sourceRecovery = normalizeRecovery(observation, recovery);
	// The drop clock is presented only as prose in facts.
	const normalized = sourceRecovery === null ? null : Object.fromEntries(Object.entries(sourceRecovery).filter(([key]) => key !== 'doNotRedo' && key !== 'dropTicking'));
	const lastDeath = normalized?.lastDeath ?? observation.death ?? null;
	const facts = recoveryFacts({ recovery: normalized, lastDeath, observation, dropTicking: sourceRecovery?.dropTicking ?? null });
	const recoveryView = normalized === null
		? (facts.length === 0 ? null : { alreadyHave: [], facts })
		: { ...normalized, facts };
	// The clock stays readable for the wake header's death-drop lead without a second copy in the model's JSON.
	if (recoveryView !== null && sourceRecovery?.dropTicking) Object.defineProperty(recoveryView, 'dropTicking', { value: sourceRecovery.dropTicking, enumerable: false });
	const exploration = occupancy !== null && typeof occupancy.candidates === 'function' && agentId !== null
		? occupancy.candidates(agentId, observation) : null;
	const { options: _oldOptions, failureClass: _oldFailureClass, exploration: _oldExploration, ...currentFacts } = observation;
	return {
		...currentFacts,
		...(recoveryView === null ? {} : { recovery: recoveryView }),
		...(exploration === null ? {} : { exploration }),
		...(failureClass === null ? {} : { failureClass }),
	};
}

function inferFailureClass(observation) {
	const classified = classifyBodyFailure(observation.lastResult?.reasonCode, observation.lastResult?.state);
	if (classified !== null) return classified;
	if (observation.continuity?.phase === 'dead' || observation.player?.dead === true || observation.death != null) {
		return 'lifecycle';
	}
	return null;
}

function recoveryFacts({ recovery, lastDeath, observation, dropTicking = null }) {
	const parts = [];
	if (lastDeath !== null) {
		// Position, cause, respawn and portal are already in lastDeath; prose adds only derived facts.
		parts.push(deathRecoveryFacts(lastDeath, observation, dropTicking));
	}
	const entries = Array.isArray(recovery?.alreadyHaveFacts) ? recovery.alreadyHaveFacts : null;
	const have = entries === null ? itemIds(recovery) : entries.filter((entry) => entry.remembered !== true).map((entry) => entry.itemId ?? entry.blockId);
	if (have.length > 0) parts.push(`Currently evidenced: ${unique(have).join(', ')}.`);
	const remembered = entries?.filter((entry) => entry.remembered === true).map((entry) => entry.itemId ?? entry.blockId) ?? [];
	if (remembered.length > 0) parts.push(`Remembered (not currently verified): ${unique(remembered).join(', ')}.`);
	// The lost stacks are already listed with counts in lastLostInventory.
	return parts.join(' ');
}

function deathRecoveryFacts(death, observation, dropTicking = null) {
	const elapsed = Number.isFinite(observation.observedAtEpochMs) && Number.isFinite(death.diedAtEpochMs)
		? Math.max(0, (observation.observedAtEpochMs - death.diedAtEpochMs) / 1000) : null;
	const age = elapsed === null ? '' : `Died ${Math.floor(elapsed / 60)} min ago. `;
	const loss = dropLoss(death);
	// The void keeps nothing: no drop clock or way back to state.
	const parts = [loss === 'void' ? `${age}That death was in the void: its drops are gone.` : `${age}${dropClockFact(dropTicking)}`];
	const from = loss === 'void' ? null : death.respawnedAt;
	if (from && typeof death.dimensionId === 'string') {
		if (from.dimension === death.dimensionId) {
			parts.push(`Horizontal distance to death: ${Math.round(Math.hypot(death.x - from.x, death.z - from.z))} blocks.`);
		} else if (from.dimension === 'minecraft:overworld' && death.dimensionId === 'minecraft:the_nether' && recoveryRoute(death, observation) === null) {
			parts.push(`Death's Overworld projection (8:1), horizontal not route distance: ${Math.round(Math.hypot(death.x * 8 - from.x, death.z * 8 - from.z))} blocks.`);
		} else {
			parts.push(recoveryRoute(death, observation) ?? 'Death is in another dimension; route distance unknown.');
		}
	}
	if (loss === 'lava') parts.push('That death was in lava: drops that fell into it burned.');
	parts.push(recoveryPreparation(death, observation));
	const night = nightUnarmed(observation);
	if (night) parts.push(night);
	return parts.join(' ');
}

// Respawning with nothing at night, or beside a mob camping the spawn point, led straight into further deaths in Day 2
// games (bare-handed fights, flights that stalled in forest): the odds of that fight and the cheapest enclosure, stated
// as vanilla facts.
function nightUnarmed(observation) {
	const tick = Number.isSafeInteger(observation?.world?.dayTime) ? observation.world.dayTime % 24_000 : null;
	const items = observation?.inventory?.items;
	if (observation?.world?.dimension !== 'minecraft:overworld' || !Array.isArray(items)) return null;
	if (items.some((item) => item?.count > 0 && /_(sword|axe|helmet|chestplate|leggings|boots)$|^minecraft:shield$/.test(item.itemId ?? ''))) return null;
	const night = tick !== null && tick >= 13_000 && tick < 23_000;
	const near = (observation.player?.threats ?? []).some((threat) => Number.isFinite(threat?.distance) && threat.distance <= 16);
	if (!night && !near) return null;
	return `${night ? 'Night, n' : 'N'}o weapon or armour: a fist deals 1 damage and a zombie has 20 health${night ? '; monsters keep spawning on dark ground until dawn (tick 23000)' : ''}. A 1x1 hole 2 deep with one block over it is fully enclosed; dirt breaks by hand in under 1 s.`;
}

function dropClockFact(clock) {
	if (clock === null || !Number.isSafeInteger(clock.simulationDistance) || !Number.isFinite(clock.tickedSeconds)) {
		return 'Drops: 6000 entity-ticking ticks (5 min at 20 TPS); ticking/survival unknown.';
	}
	// Whole minutes keep the text byte-stable between minute boundaries.
	const left = Math.max(0, 300 - clock.tickedSeconds);
	const remaining = left === 0 ? 'none of the 5 min left (despawned unless picked up)'
		: left < 60 ? 'under 1 min left' : `about ${Math.floor(left / 60)} of 5 min left`;
	const now = left === 0 ? '' : clock.tickingNow ? '; ageing now' : '; paused now, you are beyond that range';
	return `Drops age only in entity-ticking chunks, within ${clock.simulationDistance} chunks (simulation distance) of a player, and wait elsewhere. From your own presence: ${remaining}${now}; another player near them ages them too. Lava, fire, cactus and the void destroy drops.`;
}

function normalizeRecovery(observation, recovery) {
	if (recovery === null && observation?.recovery === undefined) {
		return recoveryFromState(observation, {});
	}
	const source = recovery ?? observation.recovery ?? null;
	if (source === null) return null;
	if (Array.isArray(source.alreadyHave) && source.alreadyHave.some((entry) => entry !== null && typeof entry === 'object')) {
		return {
			...source,
			lastDeath: source.lastDeath ?? observation.death ?? null,
		};
	}
	const alreadyHave = itemIds(source);
	const lastDeath = source.lastDeath ?? observation.death ?? null;
	const lastLostInventory = Array.isArray(source.lastLostInventory) ? source.lastLostInventory : [];
	const doNotRedo = Array.isArray(source.doNotRedo) && source.doNotRedo.length > 0
		? source.doNotRedo
		: doNotRedoFor(alreadyHave);
	if (lastDeath === null && alreadyHave.length === 0 && lastLostInventory.length === 0 && !(Array.isArray(doNotRedo) && doNotRedo.length > 0)) {
		return null;
	}
	return {
		...source,
		...(lastDeath === null ? {} : { lastDeath }),
		alreadyHave,
		doNotRedo,
		...(lastLostInventory.length === 0 ? {} : { lastLostInventory }),
	};
}

function recoveryFromState(observation, recoveryState = {}) {
	const inventoryIds = inventoryItemIds(observation);
	const alreadyHave = unique([
		...inventoryIds,
		...(Array.isArray(recoveryState.alreadyHave) ? itemIds({ alreadyHave: recoveryState.alreadyHave }) : []),
	]);
	const lastDeath = recoveryState.lastDeath ?? observation.death ?? null;
	const lastLostInventory = Array.isArray(recoveryState.lastLostInventory) ? recoveryState.lastLostInventory : [];
	const doNotRedo = doNotRedoFor(alreadyHave);
	if (lastDeath === null && alreadyHave.length === 0 && lastLostInventory.length === 0) return null;
	return {
		...(lastDeath === null ? {} : { lastDeath }),
		alreadyHave,
		...(Array.isArray(recoveryState.alreadyHaveFacts) ? { alreadyHaveFacts: recoveryState.alreadyHaveFacts } : {}),
		doNotRedo,
		...(lastLostInventory.length === 0 ? {} : { lastLostInventory }),
	};
}

function itemIds(recovery) {
	const have = recovery?.alreadyHave ?? [];
	if (have.length === 0) return [];
	if (typeof have[0] === 'string') return have;
	return have.map((entry) => entry?.itemId ?? entry?.blockId).filter((value) => typeof value === 'string');
}

function inventoryItemIds(observation) {
	const raw = observation?.inventory;
	const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
	return items.map((item) => item?.itemId).filter((value) => typeof value === 'string' && value !== 'minecraft:air');
}

function unique(values) {
	return [...new Set(values.filter(Boolean))];
}
