import test from 'node:test';
import assert from 'node:assert/strict';
import { combatFacts } from '../src/combat-facts.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const observation = () => ({ ready: true, player: { health: 20, maxHealth: 20, foodLevel: 20 }, world: { dimension: 'minecraft:the_nether' }, inventory: { items: [] }, entities: [] });
test('Nether mechanics distinguish worn gold from carried gold and expose cube/enderman hazards', () => {
	const o = observation();
	o.inventory.items = [{ itemId: 'minecraft:golden_boots', count: 1, slot: 2 }];
	assert.match(combatFacts(o), /Gold armor not worn/);
	o.inventory.items[0].slot = 'feet';
	assert.match(combatFacts(o), /Gold armor worn/);
	assert.match(combatFacts(o), /breaking gold blocks, gold ores \(nether too\) or gilded blackstone angers all piglins within 16 blocks, even unseen behind walls.*breaking chests, barrels or shulker boxes does too; opening a chest.*that see you/);
	assert.doesNotMatch(combatFacts(o), /Piglins within 16 now|Barter:/);
	o.entities = [{ type: 'minecraft:piglin', distance: 9 }, { type: 'minecraft:piglin', distance: 20 }];
	assert.match(combatFacts(o), /Piglins within 16 now: 1\./);
	o.inventory.items.push({ itemId: 'minecraft:gold_ingot', count: 3, slot: 4 });
	assert.match(combatFacts(o), /Barter: a calm adult piglin takes a gold ingot .*interact_entity.*dropped near it.*per ingot: ender pearls 2-4 at 2\.1% \(~15 ingots per pearl\), fire resistance potion 1\.7% \+ splash 1\.7%, obsidian 8\.5%/);
	assert.match(combatFacts(o), /sword sweep.*neutral neighbors/);
	o.entities = [{ type: 'minecraft:magma_cube' }, { type: 'minecraft:enderman' }];
	assert.match(combatFacts(o), /even when tiny.*split on death/);
	assert.match(combatFacts(o), /2-high gap blocks their body/);
	assert.match(combatFacts(o), /pursue:false/);
	assert.doesNotMatch(combatFacts(o), /Blazes:|Wither skeletons/);
	o.entities = [{ type: 'minecraft:blaze' }, { type: 'minecraft:wither_skeleton' }];
	assert.match(combatFacts(o), /Blazes: .*3 small fireballs.*shield facing the shots blocks them; a solid block between you and the blaze stops the volley/);
	assert.match(combatFacts(o), /Wither skeletons are 2.4 blocks tall: a 2-block-high gap/);
	assert.match(combatFacts(o), /each hit restarts 10 s of Wither \(1 HP per 2 s, can kill, unlike poison\); drinking milk clears it/);
	assert.match(combatFacts(o), /placed water evaporates in the Nether/);
	assert.match(combatFacts(o), /select a bow and use_ranged with targetId, drawDurationMs:1000 and no aim fields/);
	assert.match(combatFacts(o), /omit it if it hides hovering targets/);
	assert.match(combatFacts(o), /mine that block for another window; keep the feet-level walls/);
	assert.match(combatFacts(o), /fight_target pursue:false only when a blaze enters reach/);
	assert.match(combatFacts(o), /open the sill with break_block, collect, then return and rebuild if safe/);
	assert.doesNotMatch(combatFacts(o), /kills one in/);
	o.inventory.items.push({ itemId: 'minecraft:stone_sword', count: 1, slot: 1 }, { itemId: 'minecraft:iron_sword', count: 1, slot: 2 });
	assert.match(combatFacts(o), /Your iron sword kills one in 4 hits \(3 falling crits\)\./);
	o.continuity = { rememberedSections: ['inventory'] };
	assert.match(combatFacts(o), /Gold armor unknown/);
	o.player.dead = true;
	assert.equal(combatFacts(o), null);
});
test('bailout and attacked-only threats lead with immediate defense, not another fight', () => {
	const o = observation();
	o.player.health = 9;
	o.lastResult = { actionType: 'fight_target', reasonCode: 'LOW_HEALTH_BAILOUT', state: 'FAILED' };
	const record = { currentGoal: 'Gather pearls', goalRevision: 1 };
	const wake = () => buildNativeEventInput(record, { event: 'observation', observation: o, trigger: 'observation' });
	assert.match(wake().split('\n')[0], /combat stopped.*no retreat.*Repeating.*digging in/);
	const pending = buildNativeEventInput(record, { event: 'observation', observation: o, status: { decision: { priority: 'urgent', trigger: 'threat' } } });
	assert.match(pending.split('\n')[0], /combat stopped.*Respond to the pending/);
	o.currentAction = { active: true, actionType: 'flee_from', actionId: 'escape' };
	assert.doesNotMatch(wake().split('\n')[0], /body idle/);
	delete o.currentAction;
	delete o.lastResult;
	o.player.threats = [{ uuid: 'piglin', type: 'minecraft:piglin', signals: ['attacked'] }];
	assert.match(wake().split('\n')[0], /nearby attacker and low health/);
	assert.match(wake().split('\n')[0], /reachable cover or digging in \(a 1x1 hole 2 deep with one block over it is fully enclosed/, 'digging in needs no carried blocks');
	o.player.health = 15;
	assert.match(wake().split('\n')[0], /nearby threat.*supported cover placement, digging in \(a 1x1 hole 2 deep/);
	o.player.health = 20;
	o.entities = [{ type: 'minecraft:piglin', hostile: false, distance: 1 }];
	assert.match(wake().split('\n')[0], /attacker beside a calm piglin.*Sword sweeps/);
	// Run d9-nether-e: a calm zombified piglin beside a blaze fight.
	o.entities = [{ type: 'minecraft:zombified_piglin', hostile: false, targetingAgent: false, distance: 1.34 }];
	assert.match(wake().split('\n')[0], /attacker beside a calm zombified piglin 1\.3m away\. A sword sweep or stray hit makes it and every zombified piglin within 35 blocks hostile/);
	o.entities[0].targetingAgent = true;
	assert.doesNotMatch(wake().split('\n')[0], /calm zombified/);
	o.entities = [{ type: 'minecraft:zombified_piglin', hostile: false, distance: 7 }];
	assert.doesNotMatch(wake().split('\n')[0], /calm zombified/);
	assert.match(combatFacts(o), /Zombified piglins stay calm until you hurt one \(a sword sweep or stray arrow counts\); then it and every zombified piglin within 35 blocks \(10 up or down\) attack for 20-39 s\./);
});
test('a worn-down offhand shield states its uses left while threats are near', () => {
	const o = observation();
	o.player.threats = [{ uuid: 'z', type: 'minecraft:zombified_piglin', targeting: true }];
	o.inventory.items = [{ itemId: 'minecraft:shield', slot: 'offhand', count: 1, damage: 330, maxDamage: 336 }];
	assert.match(combatFacts(o), /Offhand shield: 6 uses left; each blocked hit of 3\+ damage costs 1 \+ that damage\./);
	o.inventory.items[0].damage = 100;
	assert.doesNotMatch(combatFacts(o), /Offhand shield/);
	o.inventory.items[0].damage = 330;
	o.player.threats = [];
	assert.doesNotMatch(combatFacts(o), /Offhand shield/);
});
test('the production normalizer accepts explicit hold-ground fights and rejects ambiguous values', () => {
	const arguments_ = { targetId: '11111111-1111-1111-1111-111111111111', timeoutMs: 6000, pursue: false, sneak: true, shield: true };
	const call = normalizeMinecraftToolCall('act', { actionType: 'fight_target', arguments: arguments_ });
	assert.equal(call.arguments.pursue, false);
	assert.equal(call.arguments.sneak, true);
	assert.equal(call.arguments.shield, true);
	for (const field of ['sneak', 'shield']) assert.throws(() => normalizeMinecraftToolCall('act', { actionType: 'fight_target', arguments: { ...arguments_, [field]: 'true' } }));
	assert.throws(() => normalizeMinecraftToolCall('act', { actionType: 'fight_target', arguments: { ...arguments_, pursue: 'false' } }));
});
test('enderman facts carry the vanilla gaze rule and who it applies to now', () => {
	const o = observation();
	o.world.dimension = 'minecraft:the_end';
	o.entities = [
		{ type: 'minecraft:enderman', stableId: 'calm-1', appearance: { eyeContact: true } },
		{ type: 'minecraft:enderman', stableId: 'angry-1', distance: 27.4, appearance: { screaming: true } },
	];
	o.player.threats = [{ uuid: 'angry-1', type: 'minecraft:enderman' }, { uuid: 'angry-2', type: 'minecraft:enderman' }];
	const facts = combatFacts(o);
	assert.match(facts, /stared at \(worn carved pumpkin prevents\)/);
	assert.match(facts, /looking away never calms one/);
	assert.match(facts, /2-high gap blocks their body/);
	assert.match(facts, /Staring at calm-1\./);
	assert.match(facts, /Angry: 2 \(nearest 27m\)\./);
	assert.match(facts, /standing water keeps them off/);
	o.entities = [{ type: 'minecraft:enderman', stableId: 'calm-1' }];
	o.player.threats = [];
	assert.doesNotMatch(combatFacts(o), /Staring at|Angry:/);
});
test('a seen stronghold portal room names where its lava lies', () => {
	const o = observation();
	o.world.dimension = 'minecraft:overworld';
	o.blocks = [{ blockId: 'minecraft:spawner', x: 5, y: 3, z: 6 }, { blockId: 'minecraft:mossy_stone_bricks', x: 4, y: 3, z: 6 }];
	assert.match(combatFacts(o), /portal room.*1x3 strip along each side wall beside the entrance.*3x3 pool under the portal/);
	assert.doesNotMatch(combatFacts(o), /fight_target pursues/);
	o.blocks = [{ blockId: 'minecraft:spawner', x: 5, y: 3, z: 6 }, { blockId: 'minecraft:mossy_cobblestone', x: 4, y: 3, z: 6 }];
	assert.equal(combatFacts(o), null, 'a dungeon spawner among cobblestone is not a portal room');
	o.blocks = [{ blockId: 'minecraft:end_portal_frame', x: 4, y: 3, z: 8 }];
	assert.match(combatFacts(o), /portal room/);
	o.blocks[0].visible = false;
	assert.equal(combatFacts(o), null);
});

test('dragon facts name the fling, the water landing and an End bucket that cannot refill', () => {
	const base = { ready: true, player: {}, world: { dimension: 'minecraft:the_end' }, entities: [{ type: 'minecraft:ender_dragon', distance: 40 }] };
	const carried = combatFacts({ ...base, inventory: { items: [{ itemId: 'minecraft:water_bucket', count: 1 }] } });
	assert.match(carried, /Ender dragon: .*fling a player.*landing alone can kill.*falling reflex is not\. Water bucket carried\./);
	const empty = combatFacts({ ...base, inventory: { items: [{ itemId: 'minecraft:bucket', count: 1 }] }, landmarks: [{ blockId: 'minecraft:water', x: -51, y: 71, z: 1, distance: 62 }] });
	assert.match(empty, /No water bucket: the End has no natural water, so an empty bucket refills only from water you placed \(a source block\)\. Water seen at -51,71,1\./);
	assert.match(combatFacts({ ...base, inventory: { items: [] } }), /No water bucket carried\./);
	assert.doesNotMatch(combatFacts({ ...base, entities: [] }) ?? '', /Ender dragon/);
});
test('a bastion or a brute in sight states bastion looting rules; held or active fire resistance states its vanilla protection', () => {
	const o = observation();
	assert.doesNotMatch(combatFacts(o), /Piglin brutes|Fire resistance/);
	o.sighted = { structures: [{ structure: 'bastion', x: 40, y: 60, z: -20, distance: 55.2 }] };
	assert.match(combatFacts(o), /Bastion seen 55m off at 40,60,-20\. Piglin brutes \(axe, 50 health\) attack on sight whatever you wear and never respawn/);
	assert.match(combatFacts(o), /treasure room \(gold blocks and chests at a center over lava, brutes, magma cube spawners\)/);
	delete o.sighted;
	o.entities = [{ type: 'minecraft:piglin_brute', distance: 12 }];
	assert.match(combatFacts(o), /^(?!.*Bastion seen).*Piglin brutes \(axe, 50 health\)/);
	o.entities = [];
	o.inventory.items = [{ itemId: 'minecraft:potion', displayName: 'Potion of Fire Resistance', count: 2, slot: 3 }, { itemId: 'minecraft:potion', displayName: 'Water Bottle', count: 1, slot: 4 }];
	assert.match(combatFacts(o), /Fire resistance held \(2 to drink\): use_item gives 3:00 in which fire, lava and blaze fireballs deal no damage .*Drink it before entering a fortress, fighting blazes or crossing near lava/);
	o.player.effects = [{ effectId: 'minecraft:fire_resistance', amplifier: 0, duration: 2410 }];
	assert.match(combatFacts(o), /Fire resistance active, 2:00 left: fire, lava and blaze fireballs deal no damage until it ends/);
	assert.doesNotMatch(combatFacts(o), /Fire resistance held/);
});

test('threat wake lists the combat options the carried gear allows, in no preferred order', async () => {
	const { carriedCombatOptions } = await import('../src/dynamic-main.mjs');
	const inv = (items) => ({ inventory: { items } });
	assert.doesNotMatch(carriedCombatOptions(inv([{ itemId: 'minecraft:bow', count: 1 }])), /use_ranged/, 'a bow without arrows cannot shoot');
	assert.match(carriedCombatOptions(inv([{ itemId: 'minecraft:bow', count: 1 }, { itemId: 'minecraft:arrow', count: 12 }, { itemId: 'minecraft:spectral_arrow', count: 2 }])), /fight_target \(melee\), use_ranged \(bow, 14 arrows\), flee_from/);
	assert.match(carriedCombatOptions(inv([{ itemId: 'minecraft:crossbow', count: 1 }, { itemId: 'minecraft:firework_rocket', count: 3, slot: 'offhand' }])), /use_ranged \(crossbow, 3 rockets\)/);
	assert.doesNotMatch(carriedCombatOptions(inv([{ itemId: 'minecraft:crossbow', count: 1 }, { itemId: 'minecraft:firework_rocket', count: 3, slot: 5 }])), /use_ranged/, 'a crossbow loads rockets only from a hand');
	assert.match(carriedCombatOptions(inv([{ itemId: 'minecraft:shield', count: 1, slot: 'offhand' }])), /block_with_shield \(offhand shield\)/);
	assert.match(carriedCombatOptions(inv([{ itemId: 'minecraft:shield', count: 1, slot: 'mainhand' }])), /block_with_shield \(main-hand shield\)/);
	assert.doesNotMatch(carriedCombatOptions(inv([{ itemId: 'minecraft:shield', count: 1, slot: 7 }])), /block_with_shield/, 'a stowed shield cannot block');
	assert.match(carriedCombatOptions({ continuity: { rememberedSections: ['inventory'] }, inventory: { items: [] } }), /use_ranged \(needs a bow or crossbow and ammunition; inventory not shown\)/);
	assert.doesNotMatch(carriedCombatOptions(inv([])), /use_ranged|block_with_shield|defend|prefer|first/);
});
