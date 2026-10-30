import { compactEventInstruction } from '../src/dynamic-main.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';

import { buildNativeEventInput, GENERIC_FACTS_INSTRUCTION } from '../src/dynamic-main.mjs';
import { PLANNING_TAIL_NOTE } from '../src/native-tool-runtime.mjs';

const record = {
	currentGoal: 'Beat Minecraft',
	currentGoalSpec: { originalRequest: 'Beat Minecraft' },
	goalRevision: 4,
};

function payloadOf(input) {
	return JSON.parse(input.slice(input.indexOf('\n') + 1));
}

test('failure recovery keeps the blocker beside fresh geometry and leaves decisions and danger in control', () => {
	const observation = {
		player: { health: 20, underWater: false },
		lastResult: { actionType: 'break_block', state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE', failure: { blockedBy: 'A leaf blocks the interaction ray' } },
		blocks: [{ x: 1, y: 64, z: 2, blockId: 'minecraft:oak_leaves' }],
	};
	const input = buildNativeEventInput(record, { observation });
	assert.match(input.split('\n')[0], /Action failed: break_block TARGET_NOT_VISIBLE/);
	assert.equal(payloadOf(input).observation.lastResult.failure.blockedBy, 'A leaf blocks the interaction ray');
	assert.ok(payloadOf(input).observation.blocks.some(block => block.blockId === 'minecraft:oak_leaves'));
	const pending = buildNativeEventInput(record, { observation, status: { decision: { decisionId: 'pending', trigger: 'attention' } } });
	assert.doesNotMatch(pending.split('\n')[0], /No program decision is pending/);
	const danger = buildNativeEventInput(record, { trigger: 'drowning', observation: { ...observation, player: { health: 18, underWater: true, airSecondsLeft: 0 } } });
	assert.match(danger.split('\n')[0], /drowning/);
	assert.doesNotMatch(danger.split('\n')[0], /Action failed/);
	const running = buildNativeEventInput(record, { observation: { ...observation, currentAction: { active: true, actionId: 'new', actionType: 'break_block' } } });
	assert.match(running.split('\n')[0], /break_block is running; lastResult describes an earlier action/);
	assert.equal(payloadOf(running).observation.currentAction.actionId, 'new');
	const unrelated = buildNativeEventInput(record, { observation: { ...observation, currentAction: { active: true, actionId: 'new-route', actionType: 'navigate_to' } } });
	assert.equal(unrelated.split('\n')[0], compactEventInstruction(GENERIC_FACTS_INSTRUCTION), 'an old mining failure does not bias an unrelated running route toward continuation');
});

test('an open container with current danger leads even before a danger threshold event', () => {
	for (const player of [{ underWater: true, airSecondsLeft: 8.9 }, { onFire: true, hazard: 'fire' }, { lastAttacker: { type: 'minecraft:zombie' } }]) {
		const observation = { player: { health: 20, ...player }, interaction: { menu: { type: 'minecraft:generic_9x3', containerId: 2 } } };
		const input = buildNativeEventInput(record, { observation });
		assert.match(input.split('\n')[0], /Use one sequence: menu_close \(menuId:"minecraft:generic_9x3"\), then /);
		assert.ok(input.split('\n')[0].includes(player.underWater ? 'then get air.' : player.hazard === 'fire' ? 'then move horizontally out of fire/lava.' : 'then defend or escape.'));
		assert.equal(payloadOf(input).hud.menuId, 'minecraft:generic_9x3');
		const inventory = buildNativeEventInput(record, { observation: { ...observation, interaction: { menu: { type: 'minecraft:inventory', containerId: 0 } } } });
		assert.doesNotMatch(inventory.split('\n')[0], /menu_close/);
	}
});

test('native death input keeps last live inventory, recovery, and empty current items', () => {
	const input = buildNativeEventInput(record, {
		event: 'player_death',
		trigger: 'player_death',
		observation: {
			death: { cause: 'lava', x: 12, y: 64, z: -8, dimensionId: 'minecraft:overworld' },
			player: { dead: true, health: 0, x: 12, y: 64, z: -8 },
			inventory: { items: [] },
			continuity: { sameGoal: true, phase: 'dead' },
			lastLiveInventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }] },
			recovery: {
				lastDeath: { cause: 'lava', x: 12, y: 64, z: -8, dimensionId: 'minecraft:overworld' },
				lastLostInventory: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }],
				alreadyHave: ['minecraft:crafting_table'],
				facts: 'Current inventory is empty. Lost on death: minecraft:stone_pickaxe.',
			},
			failureClass: 'recover',
			options: [{ id: 'recover_corpse', feasible: true, moveTo: { x: 12, y: 64, z: -8 } }],
			world: { dimension: 'minecraft:overworld' },
		},
	});
	assert.equal(input.split('\n')[0], 'Died: lava. While dead only respawn acts.', 'the death leads, not a generic update');
	assert.match(input, /"phase":"dead"/);
	assert.match(input, /lastLostInventory/);
	assert.match(input, /minecraft:stone_pickaxe/);
	assert.match(input, /Current inventory is empty/);
	assert.match(input, /recover_corpse/);
});

test('a death wake names the death and the hostiles at the respawn point, not the failure the death ended', () => {
	const observation = {
		death: { cause: 'ha_q_ghbs7 was slain by Zombie', x: -87, y: 72, z: 27, dimensionId: 'minecraft:overworld', respawnX: null, respawnY: null, respawnZ: null },
		player: { dead: true, health: 0, x: -87, y: 72, z: 27 },
		inventory: { items: [] },
		entities: [
			{ stableId: 'z1', type: 'minecraft:zombie', x: -63.9, y: 71, z: 22, hostile: true },
			{ stableId: 'z2', type: 'minecraft:zombie', x: -60.7, y: 72, z: 19.7, hostile: true },
			{ stableId: 's1', type: 'minecraft:skeleton', x: -84.7, y: 72, z: 27.5, hostile: true },
			{ stableId: 'r1', type: 'minecraft:rabbit', x: -66, y: 71, z: 23, hostile: false },
		],
		lastResult: { actionId: 'a1', actionType: 'break_block', state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE' },
		world: { dimension: 'minecraft:overworld' },
	};
	const taskMemory = { deaths: [
		{ position: { x: -109, y: 61, z: -69 }, respawnedAt: { dimension: 'minecraft:overworld', x: -60.5, y: 72, z: 19.5 } },
		{ position: { x: -100, y: 71, z: -58 }, respawnedAt: { dimension: 'minecraft:overworld', x: -65.5, y: 71, z: 22.5 } },
	] };
	const named = { ...record, name: 'ha_q_ghbs7' };
	const first = buildNativeEventInput(named, { event: 'player_death', trigger: 'player_death', observation, taskMemory }).split('\n')[0];
	assert.equal(first, 'Died: slain by Zombie. While dead only respawn acts. No bed set; last respawn -65,71,23: hostiles within 16 blocks of it now: zombie x2.');
	const bed = buildNativeEventInput(named, { event: 'player_death', trigger: 'player_death', taskMemory,
		observation: { ...observation, death: { ...observation.death, respawnDimensionId: 'minecraft:overworld', respawnX: -85, respawnY: 72, respawnZ: 30 } } }).split('\n')[0];
	assert.match(bed, /Set respawn -85,72,30: hostiles within 16 blocks of it now: skeleton\.$/);
	const unknown = buildNativeEventInput(named, { event: 'player_death', trigger: 'player_death', observation }).split('\n')[0];
	assert.equal(unknown, 'Died: slain by Zombie. While dead only respawn acts.', 'no respawn point known, no claim about it');
	const alive = buildNativeEventInput(record, { event: 'player_death', trigger: 'player_death', taskMemory,
		observation: { ...observation, player: { dead: false, health: 20, x: -65, y: 71, z: 22 } } }).split('\n')[0];
	assert.doesNotMatch(alive, /^Died/, 'once respawned the death line is gone');
});

test('oversized native event input keeps death recovery instead of dropping it', () => {
	const input = buildNativeEventInput(record, {
		event: 'player_death',
		trigger: 'player_death',
		observation: {
			death: { cause: 'lava', x: 1, y: 64, z: 1, dimensionId: 'minecraft:overworld' },
			player: { dead: true, health: 0 },
			inventory: { items: Array.from({ length: 64 }, (_, index) => ({ itemId: `minecraft:filler_${index}`, count: 64 })) },
			recovery: {
				lastDeath: { cause: 'lava', x: 1, y: 64, z: 1, dimensionId: 'minecraft:overworld' },
				lastLostInventory: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }],
				alreadyHave: ['minecraft:crafting_table'],
				facts: 'Lost on death: minecraft:iron_pickaxe.',
			},
			failureClass: 'recover',
			world: { dimension: 'minecraft:overworld', extra: 'n'.repeat(20_000) },
			blocks: [...Array.from({ length: 200 }, (_, index) => ({ blockId: 'minecraft:stone', x: index, y: 64, z: 0 })), { blockId: 'minecraft:lava', x: 400, y: 64, z: 0 }],
			continuity: { sameGoal: true, phase: 'dead' },
		},
		conversation: Array.from({ length: 12 }, (_, sequence) => ({ sequence: sequence + 1, text: `event-${sequence + 1}` })),
	});
	const payload = payloadOf(input);
	assert.match(input, /lastDeath/);
	assert.match(input, /iron_pickaxe/);
	assert.match(input, /"phase":"dead"/);
	assert.ok(payload.observation.blocks.some(({ blockId }) => blockId === 'minecraft:lava'));
	assert.equal(payload.observation.snapshotCounts.blocks, 201);
	assert.equal(payload.observation.omittedRows.blocks, 189);
	assert.equal(payload.observation.omittedRows.inventory, 48);
	assert.deepEqual(payload.conversation.entries.map(entry => entry.sequence), Array.from({ length: 12 }, (_, index) => index + 1));
	assert.equal(payload.conversation.nextSequence, 12);
	assert.equal(payload.conversation.omittedEntries, 0, 'optional world compaction makes room for the entire unread conversation');
	assert.ok(Buffer.byteLength(input, 'utf8') <= 20_000);
});

test('planning due input carries timing and version while keeping the current routine advisory', () => {
	const input = buildNativeEventInput(record, {
		event: 'program_planning_due',
		programId: 'program-1',
		planningLeadMs: 2_000,
		status: { state: 'RUNNING', engineState: 'ACTIVE', programVersion: 7, deadlineEpochMs: 9_000,
			planningBasis: 'measured_progress', timing: { elapsedMs: 4000, completedActions: 8, averageActionMs: 500, remainingActions: 3, estimatedRemainingMs: 1500,
				byAction: [{ actionType: 'break_block', count: 8, averageMs: 500 }] } },
		observation: {
			observedAtEpochMs: 8_000,
			coverage: { complete: false, sections: { blocks: { returned: 1, total: 40, omittedByWire: 39 } } },
			player: { x: 4, y: 65, z: -2 },
			blocks: [{ blockId: 'minecraft:lava', x: 4, y: 64, z: -2 }],
			currentAction: { type: 'move_to', state: 'RUNNING' },
		},
	});
	const payload = payloadOf(input);
	assert.match(input, /prepare the next intention while the current routine runs/i);
	assert.match(input, /no pending decisionId needed/i);
	assert.equal(payload.event, 'program_planning_due');
	assert.equal(payload.trigger, 'program_planning_due');
	assert.deepEqual(payload.program, {
		programId: 'program-1', state: 'RUNNING', engineState: 'ACTIVE', programVersion: 7,
		deadlineEpochMs: 9_000, planningLeadMs: 2_000,
		planningBasis: 'measured_progress', next: PLANNING_TAIL_NOTE, timing: { elapsedMs: 4000, completedActions: 8, averageActionMs: 500, remainingActions: 3, estimatedRemainingMs: 1500,
			byAction: [{ actionType: 'break_block', count: 8, averageMs: 500 }] },
	});
	assert.equal(payload.observation.observedAtEpochMs, 8_000);
	assert.equal(payload.observation.coverage.sections.blocks.omittedByWire, 39);
	assert.equal(payload.observation.blocks[0].blockId, 'minecraft:lava');
	assert.equal(payload.observation.currentAction.state, 'RUNNING');
	assert.equal(Object.hasOwn(payload.program, 'decision'), false);
});

test('oversized task memory and observation context never leave a player message undeliverable', () => {
	const exploration = {
		kind: 'candidates',
		candidates: Array.from({ length: 32 }, (_, index) => ({
			id: `block:${index},64,${-index}`, kind: 'observed_block', position: { x: index + 0.5, y: 64.5, z: -index + 0.5 },
			blockId: 'minecraft:birch_log', blockState: { axis: 'y', waterlogged: 'false', facing: 'north' },
			distance: 3.1415926535 * (index + 1), seen: true, visited: false, blocked: false, stale: false, reachability: 'unknown',
		})),
		totalCandidates: 180, truncated: true, knownCells: 96, reason: 'Distance-sorted facts. Reachability is unknown; choose a target explicitly.',
	};
	const build = (conversation) => buildNativeEventInput(record, {
		event: 'observation',
		taskMemory: { summary: 's'.repeat(3_000), steps: Array.from({ length: 120 }, (_, index) => ({ step: index, note: 'n'.repeat(160) })) },
		observation: {
			player: { x: 32, y: 107, z: 1015, health: 20, skyOpen: true },
			world: { dimension: 'minecraft:overworld', dayTime: 11000, darkIn: '~2 min', raining: false, thundering: false },
			inventory: { items: Array.from({ length: 20 }, (_, index) => ({ itemId: `minecraft:item_${index}`, count: 3, slot: index })) },
			blocks: Array.from({ length: 32 }, (_, index) => ({ blockId: 'minecraft:oak_leaves', x: index, y: 108, z: 1015, blockState: { distance: '3', persistent: 'false' } })),
			exploration,
			ownedPlacements: Array.from({ length: 40 }, (_, index) => ({ blockId: 'minecraft:crafting_table', x: index, y: 107, z: 1016, placedAtTick: 1_000 + index })),
		},
		conversation,
	});
	const message = { sequence: 2, text: 'Operator takeover report: An operator controlled your body for 13 s. Moved 1 block.' };
	const payload = payloadOf(build([message]));
	assert.deepEqual(payload.conversation.entries.map(({ sequence }) => sequence), [2], 'the unread message is delivered');
	assert.equal(payload.conversation.omittedEntries, 0);
	assert.equal(payload.hud.sky, 'sunset', 'visible phase survives even the minimal unread-message context');
	assert.equal(payload.observation.world.darkIn, 'unknown', 'routine-safety sky timing survives the same budget trimming');
	assert.equal(payload.observation.world.dayPhase, undefined, 'the phase leads in hud instead of repeating');
	assert.equal(payload.observation.world.raining, false);
	assert.equal(payload.observation.world.thundering, false);
	assert.ok(payload.observation.exploration === undefined || payload.observation.exploration.candidates.length <= 8, 'exploration is trimmed under budget pressure');
	assert.equal(payload.taskMemory.truncated, true, 'oversized task memory is cut to an excerpt');
	assert.ok(payload.contextTrimmed.taskMemory > 16_384, 'the trimmed context names what outgrew the budget');
	assert.equal(payload.observation.inventory.items.length, 8);
	assert.equal(payload.observation.blocks, undefined);
	assert.equal(payload.observation.snapshotCounts.inventory, 20);
	assert.equal(payload.observation.omittedRows.inventory, 12, 'omission counts describe the rows minimal context keeps');
	assert.equal(payload.observation.omittedRows.blocks, 32);
	assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 16_384 + Buffer.byteLength(JSON.stringify(record.currentGoal), 'utf8'));
	const followUp = payloadOf(build([message, { sequence: 3, text: 'please continue getting the stone pickaxe' }]));
	assert.deepEqual(followUp.conversation.entries.map(({ sequence }) => sequence), [2, 3], 'a follow-up DM is delivered too');
});


test('budget-compacted wake sequence retains observation identity and metadata', () => {
 const views = new ModelObservationViews();
 const goal = { ...record, currentGoal: 'g'.repeat(100), currentGoalSpec: { originalRequest: 'g'.repeat(100) } };
 const sample = (step, worldId = 'budget-world', repeats = 30) => buildNativeEventInput(goal, {
  event: 'observation', eventSequence: step,
  taskMemory: { facts: 'remember '.repeat(repeats) },
  ...(repeats > 30 ? { conversation: [{ sequence: 1, text: 'x'.repeat(8000) }] } : {}),
  observation: { world: { worldId, dimension: 'minecraft:the_nether', extra: 'x'.repeat(30000) },
   entities: [{ uuid: 'piglin', type: 'minecraft:zombified_piglin' }],
   player: { x: step, health: 20 }, inventory: { items: [{ itemId: 'minecraft:cooked_beef', count: 16 }] },
   continuity: { phase: 'alive' } },
 });
 const first = decodeModelFacts(payloadOf(encodeNativeEventInput(sample(1), views)));
 assert.equal(first.observation.world.worldId, 'budget-world');
 assert.equal(first.observationView.mode, 'full');
 const second = decodeModelFacts(payloadOf(encodeNativeEventInput(sample(2), views)));
 assert.equal(second.observationView.mode, 'changes');
 assert.equal(second.observationView.baseId, first.observationView.id);
 assert.deepEqual(second.observationView.replace.player, { x: 2 });
 assert.equal(first.observation.health, 20);
 assert.equal(second.observationView.replace.health, undefined);
 assert.equal(second.observationView.replace.inventory, undefined);
 // A spec that only restates the goal text is presented empty, too small to need omission.
 assert.deepEqual(second.goalSpec, {});
 assert.deepEqual(second.sameAsPreviousEvent, ['situation', 'goal', 'taskMemory']);
 assert.equal(second.conversation, undefined);
 const other = decodeModelFacts(payloadOf(encodeNativeEventInput(sample(3, 'other-world'), views)));
 assert.equal(other.observationView.mode, 'full');
 assert.equal(other.sameAsPreviousEvent, undefined);
 const minimalViews = new ModelObservationViews();
 const normal = decodeModelFacts(payloadOf(encodeNativeEventInput(sample(0), minimalViews)));
 assert.equal(normal.observation.entities[0].uuid, 'piglin');
 const minimalFirst = decodeModelFacts(payloadOf(encodeNativeEventInput(sample(1, 'budget-world', 5000), minimalViews)));
 assert.ok(minimalFirst.contextTrimmed);
 assert.ok(minimalFirst.observationView.remove.includes('entities'));
 assert.equal(minimalFirst.observationView.replace.entities, undefined);
 const minimalNext = decodeModelFacts(payloadOf(encodeNativeEventInput(sample(2, 'budget-world', 5000), minimalViews)));
 assert.equal(minimalNext.observationView.mode, 'changes');
 assert.ok(!minimalNext.observationView.remove.includes('entities'), 'the minimal baseline has no stale entities');
});

test('an ordinary update states no preference for keeping running work, with or without an action running', () => {
	for (const currentAction of [{ active: true, actionId: 'native:a:1', actionType: 'move_to' }, { active: false }]) {
		const input = buildNativeEventInput(record, { event: 'observation', trigger: 'observation', observation: { player: { health: 20, maxHealth: 20 }, currentAction } });
		assert.equal(input.split('\n')[0], compactEventInstruction(GENERIC_FACTS_INSTRUCTION));
	}
	assert.equal(GENERIC_FACTS_INSTRUCTION, 'Update. Use fresh facts for the goal.');
	assert.doesNotMatch(GENERIC_FACTS_INSTRUCTION, /[Kk]eep authorised routines/);
});

test('a running action reports the hearts lost since it was first seen running, and only a drop', () => {
	const running = { active: true, actionId: 'native:a:2', actionType: 'fight_target' };
	const wake = (health, start) => payloadOf(buildNativeEventInput(record, { event: 'observation', trigger: 'damage',
		observation: { player: { health, maxHealth: 20 }, currentAction: running }, runningActionStart: start })).observation.currentAction;
	assert.equal(wake(7.3, { actionId: 'native:a:2', health: 10.3 }).hurtWhileRunning, '11->8');
	assert.equal(wake(12, { actionId: 'native:a:2', health: 10.3 }).hurtWhileRunning, undefined, 'healing is not news here');
	assert.equal(wake(7.3, { actionId: 'native:a:1', health: 20 }).hurtWhileRunning, undefined, 'another handle says nothing about this one');
	assert.equal(wake(7.3, null).hurtWhileRunning, undefined);
});

test('a running action shows what it was started to do: travel destination and distance left, a fight bailout', () => {
	const wake = (currentAction, runningAction) => payloadOf(buildNativeEventInput(record, { event: 'observation', trigger: 'observation',
		observation: { player: { x: 10, y: 64, z: 0, health: 20, maxHealth: 20 }, currentAction }, runningAction })).observation.currentAction;
	const move = { active: true, actionId: 'native:a:3', actionType: 'move_to' };
	assert.deepEqual(wake(move, { actionId: 'native:a:3', actionType: 'move_to', arguments: { x: 40, y: 64, z: 40, tolerance: 1 } }),
		{ ...move, to: '40,64,40', left: 50 });
	assert.deepEqual(wake(move, { actionId: 'native:a:9', actionType: 'move_to', arguments: { x: 40, y: 64, z: 40 } }), move, 'arguments of another handle are not this action');
	const fight = { active: true, actionId: 'native:a:4', actionType: 'fight_target' };
	assert.equal(wake(fight, { actionId: 'native:a:4', actionType: 'fight_target', arguments: { targetId: 'z', fleeAtHealth: 6 } }).fleeAtHealth, 6);
	assert.deepEqual(wake({ active: false }, null), { active: false });
});

test('running distance uses visible coordinates even when its authored destination is unseen', () => {
 const currentAction = { active: true, actionId: 'native:a:3', actionType: 'move_to' };
 const runningAction = { ...currentAction, arguments: { x: 40, y: 64, z: 40 } };
 for (const reducedDebugInfo of [false, true]) {
  const input = buildNativeEventInput(record, { event: 'observation', observation: {
   player: { x: 10, y: 64, z: 0, health: 8 }, world: { reducedDebugInfo }, entities: [], blocks: [], currentAction,
  }, runningAction, runningActionStart: { actionId: currentAction.actionId, health: 11 } });
  const shown = payloadOf(input).observation;
  assert.equal(shown.currentAction.to, '40,64,40', 'the model remembers its own request');
  assert.equal(shown.currentAction.left, reducedDebugInfo ? undefined : 50);
  assert.equal(shown.player.x, reducedDebugInfo ? undefined : 10);
  assert.equal(shown.currentAction.hurtWhileRunning, '11->8');
 }
});

test('new-context and healing wakes do not prefer continuing a routine', () => {
 for (const options of [{ newContext: true }, { trigger: 'low_health_food' }]) {
  const input = buildNativeEventInput(record, { event: 'observation', ...options, observation: { player: { health: 8 } } });
  assert.doesNotMatch(input.split('\n')[0], /keep authorised routines/i);
  assert.match(input.split('\n')[0], /^low health(?: with food in reach)?\./);
  if (options.newContext) assert.doesNotMatch(input.split('\n')[0], /program decision/);
 }
});

test('survival facts lead even when a fresh context has no pending program decision', () => {
 const base = { health: 20, maxHealth: 20, foodLevel: 20, gameMode: 'survival' };
 for (const [player, world, expected] of [
  [{ underWater: true, air: 100, maxAir: 300 }, {}, /^drowning\. 5s air left/],
  [{ foodLevel: 4, bestFood: { slot: 2, itemId: 'minecraft:bread', nutrition: 5 } }, {}, /^low food/],
  [{ health: 3 }, {}, /^low health/],
  [{ skyOpen: true }, { dimension: 'minecraft:overworld', dayTime: 12000 }, /^sunset/],
  [{ threats: [{ uuid: 'creeper', type: 'minecraft:creeper', targeting: true }] }, {}, /^nearby threat/],
  [{ onFire: true }, { dimension: 'minecraft:the_nether' }, /^burn after exit.*Water evaporates/],
 ]) {
  const observation = { player: { ...base, ...player }, world, inventory: { items: [] } };
  const before = structuredClone(observation);
  const input = buildNativeEventInput(record, { event: 'observation', trigger: 'start', newContext: player.skyOpen !== true, observation });
  assert.match(input.split('\n')[0], expected);
  assert.doesNotMatch(input.split('\n')[0], /program decision|program awaits/);
  assert.deepEqual(observation, before, 'presentation never changes runtime facts or chooses a body action');
  if (player.foodLevel === 4) assert.match(payloadOf(input).healing.options[0], /selectedSlot:2/);
 }
});

test('a detached program checkpoint wake carries the model\'s own reason', async () => {
	const { buildNativeEventInput } = await import('../src/dynamic-main.mjs');
	const input = buildNativeEventInput({ agentId: 'agent-a', goalRevision: 1, currentGoal: 'Beat Minecraft' }, {
		event: 'program_ended', programId: 'p1',
		result: { state: 'YIELDED', reasonCode: 'PROGRAM_CHECKPOINT', summary: 'no iron in this cave; need a new area', actions: 3, actionsSucceeded: 3, actionsFailed: 0, receipts: [] },
	});
	assert.match(input, /no iron in this cave; need a new area/);
});


test('low health below regeneration hunger calls for food instead of working while healing', () => {
 for (const foodLevel of [15, 17, 18, 20]) {
  const observation = { player: { health: 6.3, maxHealth: 20, foodLevel, gameMode: 'survival' }, inventory: { items: [] } };
  const before = structuredClone(observation);
  const input = buildNativeEventInput(record, { event: 'observation', trigger: 'start', newContext: true, observation });
  const line = input.split('\n')[0];
  if (foodLevel < 18) {
   assert.match(line, new RegExp(`Food ${foodLevel}/20 cannot regenerate health`));
   assert.match(line, /obtain a visible food source before routine work/);
   assert.doesNotMatch(line, /work while healing/);
  } else assert.match(line, /safe nearby work while healing/);
  assert.deepEqual(observation, before, 'the wake teaches from hunger without choosing an action or changing facts');
 }
});


test('threat wakes offer supported cover after a blocked escape without choosing it for the player', () => {
 const observation = { player: { health: 20, maxHealth: 20, foodLevel: 20, gameMode: 'survival', threats: [{ uuid: 'archer', type: 'minecraft:skeleton', distance: 10, targeting: true }] }, lastResult: { actionType: 'flee_from', state: 'FAILED', reasonCode: 'FLEE_BLOCKED' }, inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 8, slot: 'mainhand' }] } };
 const before = structuredClone(observation);
 const input = buildNativeEventInput(record, { event: 'observation', trigger: 'threat', newContext: true, observation });
 assert.match(input.split('\n')[0], /supported cover placement/);
 assert.match(input.split('\n')[0], /After blocked flight or a failed cover search, build cover or open a different exit/);
 assert.deepEqual(observation, before);
});
