#!/usr/bin/env node
// Provider-free check of a gold save point: node scripts/quality/test-gold-checkpoint-live.mjs CHECKPOINT.json OUT_DIR [JAR]
// Boots the checkpoint's seed, prepares an agent body with the production applyQualitySetup and activateQualitySetup,
// and reports: the worn helmet and carried gold, the nearest bastion (vanilla /locate, for the report only), the facts
// the coordinator renders from the live observation (combat facts, Nether route option), whether a summoned adult
// piglin stays calm with the helmet worn and turns on the body once it is removed, and, with gold carried, whether a
// gold ingot handed over with interact_entity comes back as a barter return (RANDOM_SALT=N reseeds its loot rolls).
// No model call is made; operator commands build the fixture only. Launch under slot.sh live (SLOT_PORT_BASE) with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { combatFacts } from '../../coordinator/src/combat-facts.mjs';
import { netherRouteOption } from '../../coordinator/src/need-sources.mjs';
import { boot } from './watch-replay.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [checkpointFile, outArg, jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!checkpointFile || !outArg || !template || !port || !process.env.JAVA_HOME) throw new Error('Usage: CHECKPOINT.json OUT_DIR [JAR] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Probe';
const dim = checkpoint.setup.dimension;
const result = { checkpoint: path.basename(checkpointFile) };
const s = await boot(out, { jar: path.resolve(jarArg ?? path.join(root, 'build/libs/arena-agents-0.2.0.jar')), template, port, world: null, seed: checkpoint.seed });
const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
const passed = text => /Test passed/.test(String(text));
const count = text => Number(/count: (\d+)/i.exec(String(text))?.[1] ?? 0);
let piglinOrdinal = 0;
// A fresh adult piglin beside the body. Its attack target is not saved in NBT, so the observation's targetingAgent
// (the mob's current target is this body) tells whether it turned on the player.
async function piglinTurns(at, seconds) {
	const id = ++piglinOrdinal, uuid = `00000000-0000-0000-0000-00000000000${id}`;
	await s.command(`execute in ${dim} run summon minecraft:piglin ${at[0] + 2.5} ${at[1]} ${at[2]} {PersistenceRequired:1b,IsImmuneToZombification:1b,UUID:[I;0,0,0,${id}]}`);
	let target = false, seen = false;
	for (let i = 0; i < seconds * 2 && !target; i++) {
		await sleep(500);
		// The body sees only what it faces: turn it toward the piglin, as a player looking at it would.
		await s.command(`execute as ${AGENT} at @s run tp @s ~ ~ ~ facing entity ${uuid} eyes`);
		const row = ((await s.observe()).entities ?? []).find(entity => entity.uuid === uuid);
		seen ||= row !== undefined;
		target = row?.targetingAgent === true;
	}
	return { uuid, seen, target };
}
try {
	let e = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
		result.summon = await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${result.summon}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const command = async text => ({ text: await s.command(text) });
	// RANDOM_SALT reseeds the save point's loot sequences, so its barters differ from every other game's.
	const receipt = await applyQualitySetup({ ...checkpoint.setup, ...(process.env.RANDOM_SALT ? { randomSalt: Number(process.env.RANDOM_SALT) } : {}) }, command, AGENT);
	await activateQualitySetup(receipt, command, { stage: 'goal-start' });
	await activateQualitySetup(receipt, command, { stage: 'first-decision' });
	await s.command('tick unfreeze').catch(() => {});
	await s.command('difficulty normal');
	const at = await pos();
	result.start = { pos: at, dimension: await s.command(`data get entity ${AGENT} Dimension`) };
	result.helmet = await s.command(`execute if items entity ${AGENT} armor.head minecraft:golden_helmet`);
	result.helmetWorn = passed(result.helmet);
	result.goldIngots = count(await s.command(`execute if items entity ${AGENT} container.* minecraft:gold_ingot`));
	result.bastion = await s.command(`execute in ${dim} positioned ${at.map(Math.floor).join(' ')} run locate structure minecraft:bastion_remnant`);
	result.fortress = await s.command(`execute in ${dim} positioned ${at.map(Math.floor).join(' ')} run locate structure minecraft:fortress`);
	await sleep(3000);
	const observation = adaptObservation(await s.observe());
	result.rendered = {
		combat: combatFacts(observation),
		route: netherRouteOption({ observation, position: observation.player ?? null, open: 'has:minecraft:ender_pearl*12 has:minecraft:blaze_rod*6' }),
		sightedStructures: observation.sighted?.structures ?? [],
	};
	// A sealed 7x3x7 room at the body keeps the piglin beside it and the Nether's lava out.
	const [x, y, z] = at.map(Math.floor);
	await s.command(`execute in ${dim} run fill ${x - 4} ${y - 1} ${z - 4} ${x + 4} ${y + 3} ${z + 4} minecraft:netherrack hollow`);
	await s.command(`execute in ${dim} run fill ${x - 3} ${y} ${z - 3} ${x + 3} ${y + 2} ${z + 3} minecraft:air`);
	await s.command(`effect give ${AGENT} minecraft:resistance 120 4 true`);
	result.withHelmet = await piglinTurns(at, 8);
	if (result.goldIngots > 0 && !result.withHelmet.target) {
		await s.command(`execute in ${dim} run tp ${result.withHelmet.uuid} ${at[0] + 1.5} ${at[1]} ${at[2]}`);
		await s.command(`execute as ${AGENT} at @s run tp @s ~ ~ ~ facing entity ${result.withHelmet.uuid} eyes`);
		const held = ((await s.observe()).inventory?.items ?? []).find(item => item.itemId === 'minecraft:gold_ingot');
		// Gold carried outside the hotbar moves there first, as select_item's own failure tells a player to do.
		if (Number.isInteger(held?.slot) && held.slot > 8) result.toHotbar = (await s.act('select_tool', { sourceSlot: held.slot, hotbarSlot: 8, expectedItemId: 'minecraft:gold_ingot', minRemainingDurability: 0 })).state;
		await s.observe();
		const select = await s.act('select_item', { itemId: 'minecraft:gold_ingot' });
		await s.command(`execute as ${AGENT} at @s run tp @s ~ ~ ~ facing entity ${result.withHelmet.uuid} eyes`);
		await sleep(300);
		// The target must be in the observation the action's provenance names, so that view becomes the current one.
		s.observation = await s.observe();
		const piglin = (s.observation.entities ?? []).find(row => row.uuid === result.withHelmet.uuid);
		const hand = await s.act('interact_entity', { targetId: result.withHelmet.uuid, hand: 'main', expectedItemId: 'minecraft:gold_ingot' });
		let drops = [];
		for (let i = 0; i < 20 && !drops.length; i++) {
			await sleep(1000);
			drops = ((await s.observe()).entities ?? []).filter(row => row.type === 'minecraft:item' && row.itemId !== 'minecraft:gold_ingot');
		}
		result.barter = { piglinInView: piglin ? { distance: piglin.distance, stableId: piglin.stableId ?? null } : (s.observation.entities ?? []).map(row => row.type), eventSequence: s.observation.eventSequence, select: select.state, selectReason: select.reasonCode ?? null, hand: hand.state, reasonCode: hand.reasonCode ?? null, returns: drops.map(row => ({ itemId: row.itemId, count: row.count })),
			goldAfter: count(await s.command(`execute if items entity ${AGENT} container.* minecraft:gold_ingot`)) };
	}
	await s.command(`kill ${result.withHelmet.uuid}`);
	await s.command('kill @e[type=minecraft:item]');
	// Control: the same body without the helmet is attacked, so a calm piglin above means the gold, not a blind check.
	await s.command(`item replace entity ${AGENT} armor.head with minecraft:air`);
	result.withoutHelmet = await piglinTurns(at, 10);
	result.ok = result.helmetWorn && result.withHelmet.seen && !result.withHelmet.target && result.withoutHelmet.target
		&& (result.goldIngots === 0 || (result.barter?.hand === 'SUCCEEDED' && result.barter.returns.length > 0));
} catch (error) {
	result.error = String(error?.stack ?? error);
} finally {
	await s.stop().catch(() => {});
}
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
