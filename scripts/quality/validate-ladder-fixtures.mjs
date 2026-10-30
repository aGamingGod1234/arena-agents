#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { applyQualitySetup, activateQualitySetup, qualityCovered } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { itemCount } from '../../coordinator/src/benchmark/quality-metrics.mjs';
import { parseValidationPlayer } from './validate-generality-fixtures.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const p0 = sample => sample.position ? `${sample.position.x} ${sample.position.y} ${sample.position.z}` : null;
const success = text => /time is \d+|has the following entity data/i.test(text);

export async function validateLadderFixture(scenario, command, { agent = 'LadderCheck' } = {}) {
	const checks = [], evidence = [];
	let endermanIndex = 0;
	const check = (name, pass, observed) => checks.push({ name, pass: Boolean(pass), observed });
	const run = async text => {
		const summon = ['L-C2', 'L-C3'].includes(scenario.id) && text.match(/^execute at \S+ run summon minecraft:enderman (\S+) (\S+) (\S+)/);
		if (summon) {
			// Check placement before entity movement; roots and sprouts have no collision and are valid standing space.
			const probe = `execute at ${agent} positioned ${summon.slice(1, 4).join(' ')} if block ~ ~-1 ~ minecraft:warped_nylium if block ~ ~ ~ #minecraft:replaceable if block ~ ~1 ~ #minecraft:replaceable if block ~ ~2 ~ #minecraft:replaceable run time query gametime`;
			const response = String((await command(probe)).text);
			evidence.push({ command: probe, response });
			check(`enderman-standing-ground:${endermanIndex++}`, success(response), summon.slice(1, 4));
		}
		const result = await command(text.replaceAll('{agent}', agent));
		evidence.push({ command: text, response: String(result.text ?? result) });
		return result;
	};
	let setup, sample;
	try {
		const seedText = (await run('seed')).text;
		if (seedText.match(/Seed:\s*\[?(-?\d+)/i)?.[1] !== scenario.seed) throw new Error('Dedicated validation world has the wrong seed');
		await run('tick unfreeze');
		await run(`player ${agent} kill`);
		for (const dimension of ['overworld', 'the_nether', 'the_end']) await run(`execute in minecraft:${dimension} run kill @e[type=!minecraft:player,type=!minecraft:ender_dragon,type=!minecraft:end_crystal]`);
		for (const objective of ['qo_damage', 'qo_death', 'qo_fixture_count']) await run(`scoreboard objectives remove ${objective}`);
		await run('scoreboard objectives add qo_fixture_count dummy');
		await run(`player ${agent} spawn at 134.5 120 488.5 facing 0 0 in minecraft:overworld`);
		for (let i = 0; i < 100; i++) {
			if (success((await run(`data get entity ${agent} Pos`)).text)) break;
			if (i === 99) throw new Error('Fake player did not join');
			await sleep(100);
		}
		setup = await applyQualitySetup(scenario.setup, run, agent);
		sample = parseValidationPlayer((await run(`data get entity ${agent}`)).text);
		check('dimension', sample.dimension === scenario.setup.dimension, sample.dimension);
		check('survival-alive', sample.gameMode === 0 && sample.health > 0, { mode: sample.gameMode, health: sample.health });
		check('no-fire-and-air', sample.fire <= 0 && sample.air >= 300, { fire: sample.fire, air: sample.air });
		const setupDef = scenario.setup;
		if (setupDef.surface) {
			const sky = (await run(`execute in ${setupDef.dimension} as ${agent} at @s positioned over motion_blocking_no_leaves if entity @s[distance=..6] run time query gametime`)).text;
			check('surface-sky-access', success(sky), { y: sample.position?.y, response: sky });
		}
		if (setupDef.expectedBiome) {
			const biome = (await run(`execute in ${setupDef.dimension} as ${agent} at @s if biome ~ ~ ~ ${setupDef.expectedBiome} run time query gametime`)).text;
			check('expected-biome', success(biome), setupDef.expectedBiome);
		}
		if (setupDef.freezeUntilGoalStart) {
			const fresh = setup.definition.freshObservation, p = sample.position;
			const gap = fresh && p ? Math.hypot(fresh.position[0] - p.x, fresh.position[1] - p.y, fresh.position[2] - p.z) : Infinity;
			check('fresh-post-setup-observation', gap < 1.5 && sample.gameMode === 0, { gap, mode: sample.gameMode, ticks: fresh?.ticks });
		}
		if (setupDef.requireCover && p0(sample)) {
			const covered = await qualityCovered(run, setupDef.dimension, p0(sample));
			// Cover is preferred, not required: the setup falls back to open ground when none is near the approach.
			check('approach-cover-recorded', covered === (setup.definition.coverFound === true), { covered, coverFound: setup.definition.coverFound, at: p0(sample) });
		}
		for (const { item, count = 1 } of scenario.setup.inventory ?? []) {
			const actual = itemCount(sample.inventoryNbt, new RegExp(`^${item}$`));
			check(`inventory:${item}`, actual >= count, { expected: count, actual });
		}
		for (const [slot, item] of Object.entries(scenario.setup.armour ?? {})) {
			const response = (await run(`execute if items entity ${agent} armor.${slot} ${item} run time query gametime`)).text;
			check(`armour:${slot}`, success(response), response);
		}
		const ground = (await run(`execute at ${agent} ${scenario.setup.groundBelowCanopy ? 'if block ~ ~ ~ #minecraft:replaceable if block ~ ~1 ~ #minecraft:replaceable' : `if block ~ ~ ~ ${scenario.setup.airBlock ?? 'minecraft:air'} if block ~ ~1 ~ ${scenario.setup.airBlock ?? 'minecraft:air'}`} unless block ~ ~-1 ~ minecraft:air unless block ~ ~-1 ~ minecraft:water unless block ~ ~-1 ~ minecraft:lava unless block ~ ~-1 ~ minecraft:magma_block run time query gametime`)).text;
		check('standing-space-and-support', success(ground), ground);
		if (scenario.setup.standingOn) check('structure-floor', success((await run(`execute at ${agent} if block ~ ~-1 ~ ${scenario.setup.standingOn} run time query gametime`)).text), scenario.setup.standingOn);
		if (['L-C2', 'L-C3'].includes(scenario.id)) {
			const terrain = [];
			for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
				const response = (await run(`execute at ${agent} positioned ~${x} ~ ~${z} if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air unless block ~ ~-1 ~ minecraft:air unless block ~ ~-1 ~ minecraft:lava unless block ~ ~-1 ~ minecraft:warped_wart_block unless block ~ ~-1 ~ minecraft:nether_wart_block run time query gametime`)).text;
				terrain.push({ x, z, supported: success(response) });
			}
			check('ground-level-fighting-footing', terrain.every(p => p.supported), terrain);
			const response = (await run(`execute at ${agent} as @e[type=minecraft:enderman,distance=..40] run data get entity @s Pos`)).text;
			const positions = [...response.matchAll(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/g)].map(m => m.slice(1).map(Number));
			const expected = scenario.setup.mobs.length;
			check('all-enderman-placements-probed', endermanIndex === expected, { expected, probed: endermanIndex });
			const reachable = positions.filter(p => Math.abs(p[1] - sample.position.y) <= 3).length;
			check('endermen-on-player-level', reachable >= expected, { expected, reachable, positions });
		}
		if (scenario.setup.locate) check('locate-receipt', setup.receipts.some(r => r.command.includes(' run locate ') && r.response.includes('[')), setup.definition.locationTarget);
		if (scenario.setup.dimension === 'minecraft:the_end') {
			check('natural-dragon-present', success((await run('execute in minecraft:the_end if entity @e[type=minecraft:ender_dragon] run time query gametime')).text));
		}
		// Step only two ticks to test physical footing without giving fixture threats a combat window.
		await run('tick step 2');
		await sleep(200);
		const held = parseValidationPlayer((await run(`data get entity ${agent}`)).text);
		const drift = sample.position && held.position ? Math.hypot(...['x', 'y', 'z'].map(k => sample.position[k] - held.position[k])) : Infinity;
		check('footing-after-physics', drift < 0.1 && held.health > 0 && held.fire <= 0, { drift, health: held.health, fire: held.fire });
		for (const id of new Set((scenario.setup.mobs ?? []).map(m => m.id))) {
			const expected = scenario.setup.mobs.filter(m => m.id === id).length;
			await run(`execute at ${agent} store result score LadderCount qo_fixture_count if entity @e[type=${id},distance=..64]`);
			const response = (await run('scoreboard players get LadderCount qo_fixture_count')).text;
			const actual = Number(response.match(/has (\d+) \[/)?.[1] ?? NaN);
			check(`nearby-mobs:${id}`, actual >= expected, { expected, actual });
		}
		if (scenario.setup.dimension === 'minecraft:the_end') {
			await run('execute in minecraft:the_end store result score LadderCount qo_fixture_count if entity @e[type=minecraft:end_crystal]');
			const response = (await run('scoreboard players get LadderCount qo_fixture_count')).text;
			const actual = Number(response.match(/has (\d+) \[/)?.[1] ?? NaN);
			check('natural-crystals-present', actual >= 10, actual);
		}
		if (scenario.id === 'L-C1') {
			// Destructive probes run after inventory checks; this disposable player is removed below.
			// Reset the exact fixture stream before every repeat, then compare ordinary seed variants.
			const trials = [];
			const gold = scenario.setup.inventory.find(i => i.item === 'minecraft:gold_ingot').count;
			const fixtureSeed = Number(scenario.setup.commands.find(c => c.startsWith('random reset '))?.match(/piglin_bartering (-?\d+) false true$/)?.[1]);
			if (!Number.isInteger(fixtureSeed)) throw new Error('C1 requires a world-independent, reproducible barter sequence seed');
			for (const seed of [fixtureSeed, fixtureSeed, ...Array.from({ length: 16 }, (_, i) => i)]) {
				await run(`random reset minecraft:gameplay/piglin_bartering ${seed} false true`);
				let pearls = 0, firstGoalDraw = null;
				for (let draw = 1; draw <= gold; draw++) {
					await run(`clear ${agent}`);
					await run(`loot give ${agent} loot minecraft:gameplay/piglin_bartering`);
					const inventory = (await run(`data get entity ${agent} Inventory`)).text;
					pearls += itemCount(inventory, /^minecraft:ender_pearl$/);
					if (pearls >= 4 && firstGoalDraw === null) firstGoalDraw = draw;
				}
				trials.push({ seed, draws: gold, pearls, firstGoalDraw });
			}
			check('barter-fixture-reproducibly-reachable', trials.slice(0, 2).every(t => t.pearls >= 4) && trials[0].pearls === trials[1].pearls, trials.slice(0, 2));
			const variants = trials.slice(2);
			check('barter-typical-streams', variants.filter(t => t.pearls >= 4).length >= variants.length / 2, { successful: variants.filter(t => t.pearls >= 4).length, total: variants.length, trials: variants });
			await run(scenario.setup.commands.find(c => c.startsWith('random reset ')));
		}
		await activateQualitySetup(setup, run, { stage: 'first-decision' });
		return { id: scenario.id, pass: checks.every(c => c.pass), checks, setup, sample, evidence };
	} catch (error) { return { id: scenario.id, pass: false, error: error.stack, checks, setup, sample, evidence }; }
	finally {
		await run(`player ${agent} kill`).catch(() => {});
		await run('tick unfreeze').catch(() => {});
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let client;
	try {
		const args = process.argv.slice(2), values = {};
		for (let i = 0; i < args.length; i += 2) {
			if (!['--fixtures', '--scenarios', '--rcon-port', '--password-file', '--out'].includes(args[i]) || !args[i + 1]) throw new Error(`Invalid argument ${args[i]}`);
			values[args[i].slice(2)] = args[i + 1];
		}
		for (const flag of ['rcon-port', 'password-file', 'out']) if (!values[flag]) throw new Error(`--${flag} is required; use only an owned disposable server`);
		const data = JSON.parse(await readFile(values.fixtures ?? new URL('./ladder.json', import.meta.url), 'utf8'));
		const selected = values.scenarios ? values.scenarios.split(',').map(id => { const s = data.scenarios.find(s => s.id === id); if (!s) throw new Error(`Unknown scenario ${id}`); return s; }) : data.scenarios;
		const password = (await readFile(values['password-file'], 'utf8')).trim();
		for (let i = 0; ; i++) {
			client = new HeadlessRconClient({ port: Number(values['rcon-port']), password, commandTimeoutMs: 120000, maxResponseBytes: 256 * 1024 });
			try { await client.connect(); break; } catch (error) { await client.close(); if (i >= 150) throw error; await sleep(2000); }
		}
		const report = { purpose: 'Setup only; zero model calls. Shared disposable world, unlike fresh-world measured runs.', startedAt: new Date().toISOString(), runs: [] };
		await mkdir(path.dirname(path.resolve(values.out)), { recursive: true });
		for (const scenario of selected) {
			const result = await validateLadderFixture(scenario, text => client.command(text));
			report.runs.push(result);
			console.log(`${result.id}: ${result.pass ? 'PASS' : 'FAIL'} ${result.error ?? result.checks.filter(c => !c.pass).map(c => c.name).join(', ')}`);
			await writeFile(values.out, JSON.stringify(report, null, 2));
		}
		report.endedAt = new Date().toISOString();
		report.pass = report.runs.every(r => r.pass);
		await writeFile(values.out, JSON.stringify(report, null, 2));
		if (!report.pass) process.exitCode = 1;
	} catch (error) { console.error(error.stack); process.exitCode = 1; }
	finally { await client?.close(); }
}
