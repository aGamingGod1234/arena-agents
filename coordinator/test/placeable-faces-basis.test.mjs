// Review of PR #94: placeableFaces depends on the held item, so the item basis must reach every model input.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProtocolV2Payload, validateProtocolV2Envelope } from "../src/protocol-v2.mjs";
import { adaptObservation } from "../src/observation-adapter.mjs";
import { presentNativeToolResult } from "../src/codex-service.mjs";
import { decodeModelFacts } from "../src/model-fact-encoding.mjs";
import { buildNativeEventInput } from "../src/dynamic-main.mjs";
function readyServerObservation(goalRevision = 4) {
	return {
		goalRevision,
		observedAtEpochMs: 20,
		eventSequence: 7,
		attention: false,
		changedFacts: [],
		ready: true,
		status: 'PLANNING',
		position: { x: 10.5, y: 64, z: -3.5 },
		velocity: { x: 0, y: 0, z: 0 },
		view: { yaw: 90, pitch: 0 },
		player: {
			health: 18,
			maxHealth: 20,
			armor: 6,
			foodLevel: 14,
			saturation: 2.5,
			gameMode: 'survival',
			onGround: true,
			inWater: false,
			onFire: false,
			air: 300,
			maxAir: 300,
			suffocating: false,
			fallDistance: 0,
			lastAttacker: {
				uuid: '00000000-0000-0000-0000-000000000001',
				type: 'minecraft:zombie',
				distance: 3.25,
			},
			effects: [{ effectId: 'minecraft:speed', amplifier: 1, duration: 120 }],
		},
		interaction: {
			mainHandItemId: 'minecraft:bread',
			offHandItemId: 'minecraft:shield',
			usingItem: false,
			activeHand: 'none',
			useRemainingTicks: 0,
			attackCooldown: 1,
			input: {
				active: true, forward: 1, strafe: 0, jump: false, sneak: false, sprint: true,
				attack: false, use: false, yaw: 90, pitch: 0, selectedSlot: 2, hand: 'main_hand',
			},
			menu: {
				type: 'minecraft:inventory',
				cursor: { itemId: 'minecraft:air', count: 0 },
				slots: [{ slot: 0, itemId: 'minecraft:air', count: 0 }],
				capabilities: [],
			},
			rayTarget: { type: 'block', x: 11, y: 64, z: -3, face: 'north', blockId: 'minecraft:oak_log' },
		},
		inventory: {
			items: [
				{ itemId: 'minecraft:iron_chestplate', count: 1, damage: 0, maxDamage: 240, slot: 'chest', tags: ['#minecraft:trimmable_armor'] },
				{ itemId: 'minecraft:bread', count: 4, damage: 0, maxDamage: 0, slot: 2, hotbar: true, tags: ['#minecraft:food'] },
			],
			tagCounts: { '#minecraft:trimmable_armor': 1, '#minecraft:food': 4 },
			selectedItem: 'minecraft:bread',
		},
		entities: [{
			uuid: '00000000-0000-0000-0000-000000000001',
			type: 'minecraft:zombie',
			name: 'Zombie',
			distance: 3.25,
			tags: ['#minecraft:hostile'],
			position: { x: 12, y: 64, z: -2 },
		}, {
			uuid: '00000000-0000-0000-0000-000000000002',
			type: 'minecraft:player',
			name: 'Operator',
			distance: 5,
			position: { x: 15, y: 64, z: -3 },
			isPlayer: true,
		}, {
			uuid: '00000000-0000-0000-0000-000000000003',
			type: 'minecraft:item',
			name: 'Oak Log',
			distance: 1.5,
			position: { x: 10.5, y: 64, z: -2.5 },
			itemId: 'minecraft:oak_log',
			count: 1,
			tags: ['#minecraft:item'],
		}],
		blocks: [{
			x: 11, y: 64, z: -3, blockId: 'minecraft:oak_log', placeableFaces: ['up', 'north'], tags: ['#minecraft:logs'],
		}],
		landmarks: [{
			x: 28, y: 66, z: -1, blockId: 'minecraft:oak_log', distance: 17.8, bearing: 24, elevation: 3, tags: ['#minecraft:logs'],
		}],
		nearbyContainers: [{
			x: 12,
			y: 64,
			z: -4,
			blockId: 'minecraft:chest',
			distance: 2.5,
			withinInteractionRange: true,
			capabilities: ['transfer_container'],
		}],
		world: {
			dimension: 'minecraft:overworld',
			gameTime: 200,
			dayTime: 200,
			raining: false,
			thundering: false,
		},
		currentAction: { active: false },
		lastResult: { present: false },
	};
}

for (const standIn of [false, true]) test(`wake events keep which item placeableFaces was judged for (stand-in ${standIn})`, () => {
  const wire=readyServerObservation();
  wire.blocks[0].blockId='minecraft:oak_slab';
  wire.blocks[0].placeableFaces=standIn?['up','south']:['south'];
  wire.blocks[0].tags=[];
  const held=standIn?'minecraft:bread':'minecraft:oak_slab';
  wire.inventory.selectedItem=held;
  wire.inventory.items[1].itemId=held;
  wire.interaction.mainHandItemId=held;
  wire.coverage={mode:'sampled_visible',complete:false,blocksRadius:6,landmarkDistanceLimit:64,entitiesDistanceLimit:128,sections:{blocks:{returned:1,complete:false,placeableFacesFor:standIn?'minecraft:cobblestone':'minecraft:oak_slab',...(standIn?{placeableFacesStandIn:true}:{})},entities:{returned:3,complete:false},landmarks:{returned:1,complete:false},nearbyContainers:{returned:1,complete:false}}};
  const normalized=validateProtocolV2Envelope({protocolVersion:2,serverInstanceId:'server-instance',agentId:'agent-a',type:'observation',messageId:'review-94',payload:wire},{direction:'server_to_coordinator'}).payload;
  assert.deepEqual(normalized.coverage,wire.coverage);
  const facts=adaptObservation(normalized);
  assert.deepEqual(facts.coverage,wire.coverage);
  const {response}=presentNativeToolResult({observation:facts},{kind:'observe'});
  const tool=decodeModelFacts(JSON.parse(response.contentItems[0].text)).observation;
  assert.deepEqual(tool.coverage,wire.coverage);
  for(const event of ['observation','program_planning_due']) {
    const input=buildNativeEventInput({currentGoal:'Build a bridge',goalRevision:4},{event,trigger:'observation',observation:facts});
    const wake=JSON.parse(input.split('\n')[1]).observation;
    assert.equal(wake.coverage.sections.blocks.placeableFacesFor,wire.coverage.sections.blocks.placeableFacesFor,`${event} keeps the item basis`);
    assert.equal(wake.coverage.sections.blocks.placeableFacesStandIn,standIn?true:undefined,`${event} keeps the stand-in flag`);
  }
});
