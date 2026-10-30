#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import * as setupApi from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { loadGeneralityFixtures, predicateMet } from '../../coordinator/src/benchmark/generality-suite.mjs';
import { parseEntitySample, itemCount } from '../../coordinator/src/benchmark/quality-metrics.mjs';

const dimensions = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const succeeded = text => /(?:the )?time is \d+|has the following entity data/i.test(text);

export function parseValidationArgs(argv) {
	const values = {}, flags = new Set(['--fixtures', '--split', '--expect-fixture-sha256', '--rcon-port', '--password-file', '--out', '--scenarios']);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--help') return { help: true };
		if (!flags.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument ${argv[i]}`);
		values[argv[i].slice(2)] = argv[++i];
	}
	const split = values.split ?? 'train';
	if (!['train', 'heldout'].includes(split)) throw new Error('--split must be train or heldout');
	for (const name of ['fixtures', 'password-file', 'out']) if (!values[name]) throw new Error(`--${name} is required`);
	const port = Number(values['rcon-port']);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--rcon-port is required and must be 1024..65535');
	if (values['expect-fixture-sha256'] && !/^[a-f0-9]{64}$/i.test(values['expect-fixture-sha256'])) throw new Error('--expect-fixture-sha256 must be a SHA-256');
	if (split === 'heldout' && !values['expect-fixture-sha256']) throw new Error('Held-out validation requires --expect-fixture-sha256');
	const fixtures = path.resolve(values.fixtures), out = path.resolve(values.out);
	// Live evidence includes fixture commands. Keep private evidence beside its private definitions.
	if (split === 'heldout') {
		const relative = path.relative(path.dirname(fixtures), out);
		if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Held-out --out must be inside the private fixture directory');
	}
	return { split, fixtures, out, port, passwordFile: path.resolve(values['password-file']), expectedHash: values['expect-fixture-sha256']?.toLowerCase(), ids: values.scenarios?.split(',') ?? null };
}

export function parseValidationPlayer(text, at = Date.now()) {
	const sample = parseEntitySample(text, at);
	const number = (...names) => {
		for (const name of names) { const match = String(text).match(new RegExp(`\\b${name}:\\s*(-?[\\d.]+)`)); if (match) return Number(match[1]); }
		return null;
	};
	return { ...sample, foodLevel: number('food_level', 'foodLevel'), saturation: number('food_saturation_level', 'foodSaturationLevel'), air: number('Air', 'air'), fire: number('Fire', 'fire'), gameMode: number('playerGameType', 'player_game_type'), effects: String(text).match(/\b(?:active_effects|ActiveEffects):\s*(\[[\s\S]*?\])(?=,|\s*})/)?.[1] ?? '[]' };
}

export function safeHoldChecks(before, after, { survival = false, allowTimedEffects = false } = {}) {
	const positionDelta = before.position && after.position ? Math.hypot(...['x', 'y', 'z'].map(k => before.position[k] - after.position[k])) : null;
	return [
		{ name: 'predecision-safe-mode', pass: (survival ? [0] : [1, 3]).includes(before.gameMode) && (survival ? [0] : [1, 3]).includes(after.gameMode), observed: [before.gameMode, after.gameMode] },
		{ name: 'predecision-health-stable', pass: before.health > 0 && before.health === after.health, observed: [before.health, after.health] },
		{ name: 'predecision-position-stable', pass: Number.isFinite(positionDelta) && positionDelta < 0.05, observed: positionDelta },
		{ name: 'predecision-no-fire', pass: Number.isFinite(before.fire) && Number.isFinite(after.fire) && before.fire <= 0 && after.fire <= 0, observed: [before.fire, after.fire] },
		{ name: 'predecision-air-stable', pass: before.air >= 300 && after.air >= 300, observed: [before.air, after.air] },
		...(allowTimedEffects ? [] : [{ name: 'predecision-effects-not-running', pass: before.effects === '[]' && after.effects === '[]', observed: [before.effects, after.effects] }]),
		{ name: 'predecision-food-stable', pass: Number.isFinite(before.foodLevel) && before.foodLevel === after.foodLevel, observed: [before.foodLevel, after.foodLevel] },
	];
}

export async function validateFixture(scenario, command, { wait = delay, holdMs = 3000, agent = 'Q4Check', applySetup = setupApi.applyQualitySetup, activateSetup = setupApi.activateQualitySetup } = {}) {
	if (typeof activateSetup !== 'function') throw new Error('activateQualitySetup is required for live validation');
	const evidence = [], checks = [];
	const run = async text => {
		const result = await command(text.replaceAll('{agent}', agent));
		const response = String(result?.text ?? result);
		evidence.push({ at: Date.now(), command: text, response });
		return { ...result, text: response };
	};
	const check = (name, pass, observed) => checks.push({ name, pass: Boolean(pass), observed });
	let prepared, activated, before, held, pendingDecisionBefore, pendingDecisionAfter, sample;
	try {
		if (scenario.seed !== undefined) {
			const response = (await run('seed')).text;
			const actual = response.match(/Seed:\s*\[?(-?\d+)/i)?.[1];
			check('world-seed', actual === scenario.seed, { expected: scenario.seed, actual: actual ?? null, response });
			if (actual !== scenario.seed) throw new Error('Dedicated server world seed differs from the versioned fixture');
		}
		await run('tick unfreeze');
		await run('player Helper kill');
		await run(`player ${agent} kill`);
		// This entry point is solely for an evaluator-owned, disposable server.
		for (const dimension of dimensions) await run(`execute in ${dimension} run kill @e[type=!minecraft:player,type=!minecraft:ender_dragon]`);
		for (const objective of ['qo_damage', 'qo_death', 'qo_fixture_count']) await run(`scoreboard objectives remove ${objective}`);
		await run('scoreboard objectives add qo_fixture_count dummy');
		const spawned = await run(`player ${agent} spawn at 0 120 0 facing 0 0 in minecraft:overworld`);
		if (/unknown|incorrect|failed|already logged|could not/i.test(spawned.text)) throw new Error(`Carpet fake player creation failed: ${spawned.text}`);
		for(let ready=0;ready<100;ready++){
			if(/has the following entity data/.test((await run(`data get entity ${agent} Pos`)).text)) break;
			await wait(100);
			if(ready===99) throw new Error('Carpet player did not join');
		}
		prepared = await applySetup(scenario.setup, run, agent);
		const feedback = (await run('gamerule send_command_feedback')).text;
		check('setup-command-feedback-disabled', /\bfalse\b/i.test(feedback) && !/\btrue\b/i.test(feedback), feedback);
		before = parseValidationPlayer((await run(`data get entity ${agent}`)).text);
		if (prepared.definition.expectedBiome) {
			const response = (await run(`execute at ${agent} if biome ~ ~ ~ ${prepared.definition.expectedBiome} run data get entity ${agent} Pos`)).text;
			check('declared-biome-before-hazard', succeeded(response), response);
		}
		if (prepared.definition.naturalGround) {
			const response = (await run(`execute at ${agent} if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air unless block ~ ~-1 ~ minecraft:air unless block ~ ~-1 ~ #minecraft:leaves unless block ~ ~-1 ~ minecraft:water unless block ~ ~-1 ~ minecraft:lava unless block ~ ~-1 ~ minecraft:magma_block run data get entity ${agent} Pos`)).text;
			check('natural-standing-ground-before-hazard', succeeded(response), response);
		}
		await wait(holdMs);
		held = parseValidationPlayer((await run(`data get entity ${agent}`)).text);
		checks.push(...safeHoldChecks(before, held, {survival: scenario.setup.generality === true}));
		activated = await activateSetup(prepared, run, { stage: 'goal-start' });
		const conditions = Array.isArray(scenario.categories?.condition) ? scenario.categories.condition : [scenario.categories?.condition];
		if (prepared.definition.activation === 'first-decision' || conditions.includes('low-health')) {
			pendingDecisionBefore = parseValidationPlayer((await run(`data get entity ${agent}`)).text);
			await wait(holdMs);
			pendingDecisionAfter = parseValidationPlayer((await run(`data get entity ${agent}`)).text);
			checks.push(...safeHoldChecks(pendingDecisionBefore, pendingDecisionAfter, { survival: true, allowTimedEffects: prepared.definition.activation !== 'first-decision' }).map(c => ({ ...c, name: `goal-start-${c.name}` })));
			if (conditions.includes('low-health')) check('predecision-low-health-does-not-regenerate', pendingDecisionBefore.health > 0 && pendingDecisionBefore.health < 20 && pendingDecisionAfter.health === pendingDecisionBefore.health, [pendingDecisionBefore.health, pendingDecisionAfter.health]);
			activated = await activateSetup(prepared, run, { stage: 'first-decision' });
		}
		sample = parseValidationPlayer((await run(`data get entity ${agent}`)).text);
		const definition = activated?.definition ?? prepared.definition;
		check('activated-survival-mode', sample.gameMode === 0, sample.gameMode);
		check('activated-player-alive', sample.health > 0, sample.health);
		check('declared-dimension', sample.dimension === definition.dimension, sample.dimension);
		for (const { item, count = 1 } of definition.inventory ?? []) {
			const actual = itemCount(sample.inventoryNbt, new RegExp(`^${item}$`));
			check(`starting-inventory-${item}`, actual >= count, { expectedMinimum: count, actual });
		}
		for (const [slot, item] of Object.entries(definition.armour ?? {})) {
			const actual = itemCount(sample.equipmentNbt, new RegExp(`^${item}$`));
			check(`starting-armour-${slot}`, actual >= 1, { expected: item, actual });
		}
		for (const effect of definition.effects ?? []) check(`activated-effect-${effect.id}`, sample.effects.includes(effect.id), sample.effects);
		if (conditions.includes('low-health')) check('declared-low-health', sample.health > 0 && sample.health < 20, sample.health);
		if (conditions.includes('on-fire')) {
			const response = (await run(`execute at ${agent} if block ~ ~ ~ minecraft:fire run time query gametime`)).text;
			check('activated-fire-hazard', sample.fire > 0 || succeeded(response), { fire: sample.fire, response });
		}
		if (conditions.includes('underwater')) {
			const response = (await run(`execute at ${agent} if block ~ ~ ~ minecraft:water run time query gametime`)).text;
			check('activated-underwater-hazard', succeeded(response), response);
		}
		if (conditions.includes('falling')) check('activated-falling-hazard', sample.fallDistance > 1 || sample.position?.y > held.position?.y + 5, { fallDistance: sample.fallDistance, held: held.position, activated: sample.position });
		if (conditions.includes('in-lava')) {
			const responses = [];
			for (const y of [0, -1]) responses.push((await run(`execute at ${agent} if block ~ ~${y} ~ minecraft:lava run time query gametime`)).text);
			check('activated-lava-hazard', responses.some(succeeded), responses);
		}
		if (Number.isFinite(definition.foodLevelTarget)) check('target-food-level', sample.foodLevel >= 1 && sample.foodLevel <= definition.foodLevelTarget, { requestedMaximum: definition.foodLevelTarget, actual: sample.foodLevel });
		for (const mob of definition.mobs ?? []) {
			if (!mob.tag) continue;
			const response = (await run(`execute in ${definition.dimension} run data get entity @e[type=${mob.id},tag=${mob.tag},limit=1]`)).text;
			check(`declared-mob-${mob.tag}`, succeeded(response), response);
		}
		for (const id of new Set((definition.mobs ?? []).map(m => m.id))) {
			const expected = definition.mobs.filter(m => m.id === id).length;
			await run(`execute at ${agent} store result score Q4Count qo_fixture_count if entity @e[type=${id},distance=..64]`);
			const response = (await run('scoreboard players get Q4Count qo_fixture_count')).text;
			const count = Number(response.match(/has (\d+) \[/)?.[1] ?? NaN);
			check(`declared-mob-count-${id}`, count >= expected, { expectedMinimum: expected, actual: count, response });
		}
		if (definition.dimension === 'minecraft:the_end') {
			const response = (await run('execute in minecraft:the_end if entity @e[type=minecraft:ender_dragon] run time query gametime')).text;
			check('end-basics-no-undeclared-dragon', !succeeded(response), response);
		}
		if (scenario.categories?.goalType === 'help' || definition.commands.some(c => /player Helper spawn/.test(c))) {
			const response = (await run('data get entity Helper')).text;
			check('helper-player-exists', succeeded(response), response);
		}
		const objective = scenario.objective;
		if (objective.rcon) sample.objectiveMet = succeeded((await run(objective.rcon)).text);
		if (objective.type === 'shelter' || objective.predicates?.some(p => p.type === 'shelter')) sample.shelterEnclosed = await setupApi.sampleQualityShelter(run, agent);
		sample.dayTime = Number((await run('time query time')).text.match(/time is (\d+)/i)?.[1] ?? NaN);
		const initialMet = predicateMet(objective, sample, { initialDimension: sample.dimension, initialHealth: sample.health, elapsedMs: 0, deaths: 0, locationTarget: definition.locationTarget });
		check('objective-not-premet', !initialMet, initialMet);
		return { id: scenario.id, pass: checks.every(c => c.pass), checks, holdMs, prepared, activated, before, held, pendingDecisionBefore, pendingDecisionAfter, sample, evidence };
	} catch (error) {
		return { id: scenario.id, pass: false, checks, holdMs, error: error.stack ?? error.message, prepared, activated, before, held, pendingDecisionBefore, pendingDecisionAfter, sample, evidence };
	} finally {
		await run(`player ${agent} kill`).catch(() => {});
		await run('player Helper kill').catch(() => {});
		await run('tick unfreeze').catch(() => {});
	}
}

export async function validateGeneralityFixtures(options) {
	const data = await loadGeneralityFixtures(options.fixtures, options.split, options.expectedHash);
	if (options.expectedHash && data.sha256 !== options.expectedHash) throw new Error('Fixture SHA-256 differs from the expected value');
	const selected = options.ids ? options.ids.map(id => { const s = data.scenarios.find(s => s.id === id); if (!s) throw new Error(`Unknown scenario ${id}`); return s; }) : data.scenarios;
	const password = (await readFile(options.passwordFile, 'utf8')).trim();
	const client = new HeadlessRconClient({ port: options.port, password, commandTimeoutMs: 120000, maxResponseBytes: 256 * 1024 });
	const report = { version: 1, split: options.split, fixtureSha256: data.sha256, startedAt: new Date().toISOString(), purpose: 'Setup and initial-state validation only; no model calls or goal-solving actions.', runs: [] };
	await mkdir(path.dirname(options.out), { recursive: true });
	try {
		await client.connect();
		for (const scenario of selected) {
			report.runs.push(await validateFixture(scenario, command => client.command(command),{agent:`Q4${scenario.id}`}));
			await writeFile(options.out, JSON.stringify(report, null, 2));
		}
	} finally { await client.close(); }
	report.endedAt = new Date().toISOString();
	report.pass = report.runs.length === selected.length && report.runs.every(r => r.pass);
	await writeFile(options.out, JSON.stringify(report, null, 2));
	return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseValidationArgs(process.argv.slice(2));
		if (options.help) console.log('Use only an evaluator-owned disposable server. --fixtures FILE --split train|heldout --rcon-port PORT --password-file FILE --out FILE [--scenarios T01,T02] [--expect-fixture-sha256 HASH]. Held-out outputs must stay inside the private fixture directory.');
		else { const report = await validateGeneralityFixtures(options); console.log(JSON.stringify({ split: report.split, fixtures: report.runs.length, passed: report.runs.filter(r => r.pass).length, failed: report.runs.filter(r => !r.pass).length })); if (!report.pass) process.exitCode = 1; }
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
