import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { buildCheckpoint, parseInventory, parseEquipment, withBedSpawn } from '../src/benchmark/checkpoint.mjs';
import { buildLongRunDefinition } from '../src/benchmark/long-run.mjs';
import { applyQualitySetup } from '../src/benchmark/quality-scenarios.mjs';
import { normalizeHeadlessScenario } from '../src/headless-matrix.mjs';
import { buildQualityScenario } from '../../scripts/quality/run-scenarios.mjs';
import { parseLongArgs, runLong } from '../../scripts/quality/run-long.mjs';

const profile = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
const at = (min, dimension, [x, y, z], inventoryNbt = '[]', extra = {}) => ({ at: 1e12 + min * 60000, dimension, position: { x, y, z }, inventoryNbt, equipmentNbt: '[]', advancements: [], gameTime: 30000 + min * 1200, deathCounter: 1, ...extra });
const OW = 'minecraft:overworld', NE = 'minecraft:the_nether';

test('inventory and equipment parse from the sampled NBT, keeping tool wear', () => {
	const inv = parseInventory('[{count: 3, Slot: 0b, id: "minecraft:oak_log"}, {components: {"minecraft:damage": 21}, count: 1, Slot: 6b, id: "minecraft:iron_pickaxe"}]');
	assert.deepEqual(inv, [{ id: 'minecraft:oak_log', count: 3, slot: 0, damage: null }, { id: 'minecraft:iron_pickaxe', count: 1, slot: 6, damage: 21 }]);
	assert.deepEqual(parseEquipment('P has the following entity data: {equipment: {chest: {count: 1, id: "minecraft:iron_chestplate"}, offhand: {components: {"minecraft:damage": 5}, count: 1, id: "minecraft:shield"}}, fall_distance: 0.0d}'),
		{ chest: { id: 'minecraft:iron_chestplate', damage: null }, offhand: { id: 'minecraft:shield', damage: 5 } });
	assert.deepEqual(parseEquipment('{}', '[{count: 1, id: "minecraft:iron_helmet"},{count: 1, id: "minecraft:iron_boots"}]'), { head: { id: 'minecraft:iron_helmet', damage: null }, feet: { id: 'minecraft:iron_boots', damage: null } });
});

test('a save point starts at the first sample where the milestone holds, near the saved spot', () => {
	const samples = [at(0, OW, [0, 70, 0]), at(4, OW, [10, 40, 5], '[{count: 1, Slot: 0b, id: "minecraft:iron_pickaxe"}]'), at(9, OW, [50, 70, 50], '[]')];
	const cp = buildCheckpoint(samples, { milestone: 'iron_pickaxe', seed: 7 });
	assert.equal(cp.sampleIndex, 1); assert.equal(cp.minute, 4); assert.equal(cp.seed, '7');
	assert.deepEqual(cp.setup.inventory, [{ item: 'minecraft:iron_pickaxe', count: 1 }]);
	assert.equal(cp.setup.groundBelowCanopy, true, 'an overworld start is found on natural ground, not inside a dug tunnel');
	assert.deepEqual(cp.setup.commands, [], 'no portal before the first crossing');
	assert.throws(() => buildCheckpoint(samples, { milestone: 'fortress', seed: 7 }), /never reached/);
	assert.throws(() => buildCheckpoint(samples, { milestone: 'bogus', seed: 7 }), /Unknown milestone/);
});

test('a Nether save point rebuilds both portals of the last crossing, off the start spot', () => {
	const samples = [at(0, OW, [0, 70, 0]), at(8, OW, [112.3, 64, 691.7]), at(9, NE, [14.5, 62, 86.5],
		'[{count: 1, Slot: 0b, id: "minecraft:flint_and_steel"}]', { entityNbt: 'P has the following entity data: {equipment: {offhand: {count: 1, id: "minecraft:shield"}, head: {count: 1, id: "minecraft:iron_helmet"}}, Air: 300s}' })];
	const cp = buildCheckpoint(samples, { milestone: 'nether', seed: 7 });
	assert.equal(cp.setup.naturalCave, true); assert.equal(cp.setup.caveMinY, 50); assert.equal(cp.setup.caveMaxY, 74);
	assert.deepEqual(cp.setup.armour, { head: 'minecraft:iron_helmet' });
	assert.ok(cp.setup.inventory.some(i => i.item === 'minecraft:shield'), 'the offhand shield goes back in the bag');
	assert.ok(cp.setup.commands.includes('execute in minecraft:overworld run fill 112 64 691 113 66 691 minecraft:nether_portal[axis=x]'));
	// The Nether portal is 3 blocks off the start column, which the 8-block start search can never pick.
	assert.ok(cp.setup.commands.includes('execute in minecraft:the_nether run fill 14 62 89 15 64 89 minecraft:nether_portal[axis=x]'));
	assert.deepEqual(cp.setup.loadChunks.map(c => c.dimension), [OW, NE]);
	// A game that began in the Nether gets its starting portal back.
	const fortress = buildCheckpoint([at(0, NE, [68.5, 42, 64.5]), at(3, NE, [200.5, 50, 10.5], '[]', { advancements: ['nether/find_fortress'] })], { milestone: 'fortress', seed: 7 });
	assert.ok(fortress.setup.commands.includes('execute in minecraft:the_nether run fill 68 42 64 69 44 64 minecraft:nether_portal[axis=x]'));
});

test('a checkpoint long run keeps the long-run rules and replaces only seed and start', async () => {
	const samples = [at(0, OW, [0, 70, 0]), at(8, OW, [112, 64, 691]), at(9, NE, [14.5, 62, 86.5])];
	const cp = buildCheckpoint(samples, { milestone: 'nether', seed: 99 });
	const built = normalizeHeadlessScenario(buildQualityScenario({ ...buildLongRunDefinition({ seed: cp.seed, windowMs: 600000, spendCapUsd: 1 }), setup: cp.setup }, { id: 'cp-1', profile }));
	assert.equal(built.continueAfterDeath, true); assert.equal(built.world.seed, '99'); assert.equal(built.task, 'Beat the game');
	const commands = [];
	const command = async text => { commands.push(text); return { text: /if loaded|time query/.test(text) ? 'The time is 1' : /data get entity .* Pos/.test(text) ? 'P has the following entity data: [14.5d, 62.0d, 86.5d]' : /run tp/.test(text) ? 'Teleported P' : /data get entity/.test(text) ? 'P has the following entity data: {}' : 'ok' }; };
	await applyQualitySetup(structuredClone(cp.setup), command, 'P');
	assert.ok(commands.some(c => c.includes('the_nether run fill 14 62 89 15 64 89 minecraft:nether_portal')));
	assert.ok(!commands.some(c => /gamemode creative/.test(c)), 'the player stays in survival');

	const dir = await mkdtemp(path.join(os.tmpdir(), 'cp-run-'));
	try {
		const file = path.join(dir, 'cp.json'); await writeFile(file, JSON.stringify(cp));
		assert.throws(() => parseLongArgs(['--budget-minutes', '10', '--max-total-cost-usd', '4', '--port-base', '26900', '--out', dir, '--checkpoint', file, '--seed', '1']), /own seed/);
		const options = { ...parseLongArgs(['--budget-minutes', '10', '--max-total-cost-usd', '4', '--port-base', '26900', '--out', path.join(dir, 'out'), '--checkpoint', file, '--jar', 'x.jar']), codexObserverCap: true };
		let seen;
		await runLong(options, { execute: async o => { seen = o; throw new Error('stop after launch'); } }).catch(() => {});
		const definition = seen.definitions[0];
		assert.equal(definition.seed, '99'); assert.equal(definition.setup.dimension, NE); assert.equal(definition.setup.startAt, undefined);
		assert.equal(definition.runPolicy.continueAfterDeath, true); assert.equal(definition.runPolicy.stopOnAdvancement, 'end/kill_dragon');
		assert.equal(definition.checkpoint.milestone, 'nether');
		// Each game from a save point reseeds its loot rolls unless told otherwise.
		assert.ok(Number.isInteger(definition.setup.randomSalt));
		const salted = (extra) => parseLongArgs(['--budget-minutes', '10', '--max-total-cost-usd', '4', '--port-base', '26900', '--out', path.join(dir, 'out'), '--checkpoint', file, '--jar', 'x.jar', ...extra]).randomSalt;
		assert.equal(salted(['--random-salt', '42']), 42);
		assert.equal(salted(['--random-salt', 'none']), null);
		assert.throws(() => salted(['--random-salt', 'x']), /random-salt/);
		assert.throws(() => parseLongArgs(['--budget-minutes', '10', '--max-total-cost-usd', '4', '--port-base', '26900', '--out', dir, '--random-salt', '1']), /with --checkpoint/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the stall report lists milestones, deaths and each long stretch without a new milestone', async () => {
	const { stallReport, formatStallReport } = await import('../../scripts/quality/stall-report.mjs');
	const inv = id => `[{count: 1, Slot: 0b, id: "minecraft:${id}"}]`;
	const r = stallReport([at(0, OW, [0, 70, 0]), at(2, OW, [5, 70, 0], inv('oak_log')), at(20, OW, [300, 90, 0], inv('oak_log'), { deathCounter: 2 }), at(30, OW, [300, 20, 0], inv('oak_planks'))]);
	assert.deepEqual(r.milestones.map(m => [m.id, m.minute]), [['wood', 2], ['planks', 30]]);
	assert.deepEqual(r.deaths, [{ minute: 20, dimension: OW, y: 90 }]);
	assert.equal(r.stalls.length, 1);
	assert.deepEqual({ ...r.stalls[0], change: undefined }, { from: 2, to: 30, minutes: 28, next: 'Planks', dims: ['overworld'], yMin: 20, yMax: 90, walked: 295, deaths: 1, change: undefined });
	assert.match(formatStallReport(r), /2\.0-30\.0 \(28\.0 min\) before "Planks"/);
});

test('a new bed spawn replaces the save point\'s old bed: one bed, one spawn', () => {
	const checkpoint = { setup: { dimension: 'minecraft:the_end', position: [100.5, 49, 0.5], commands: ['execute in minecraft:the_end run fill 98 48 -2 102 48 2 minecraft:obsidian'], inventory: [], loadChunks: [] }, notes: [] };
	withBedSpawn(checkpoint, [256, 69, 2544]);
	withBedSpawn(checkpoint, [323, -28, 2553]);
	const beds = checkpoint.setup.commands.filter(c => /red_bed/.test(c));
	assert.deepEqual(beds, ['execute in minecraft:overworld run setblock 323 -28 2553 minecraft:red_bed[facing=east,part=foot]', 'execute in minecraft:overworld run setblock 324 -28 2553 minecraft:red_bed[facing=east,part=head]']);
	assert.equal(checkpoint.setup.commands.length, 5);
	assert.deepEqual(checkpoint.setup.finalCommands, []);
	assert.deepEqual(checkpoint.setup.usedBedSpawn, { dimension: OW, position: [323, -28, 2553] });
	assert.deepEqual(checkpoint.setup.loadChunks, [{ dimension: 'minecraft:overworld', position: [323, -28, 2553] }]);
	assert.deepEqual(checkpoint.bedSpawn, { dimension: 'minecraft:overworld', position: [323, -28, 2553] });
	assert.equal(checkpoint.notes.filter(n => n.startsWith('Respawn point: a red bed at ')).length, 1);
});
