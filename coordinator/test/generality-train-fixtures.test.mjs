import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const suite = JSON.parse(await readFile(new URL('../../scripts/quality/scenarios-train.json', import.meta.url), 'utf8'));
const byId = new Map(suite.scenarios.map(s => [s.id, s]));

test('train coverage includes natural caves, structures, portal travel, progression and an impossible goal', () => {
	assert.ok(suite.scenarios.length >= 26);
	assert.ok(suite.scenarios.some(s => s.setup.naturalCave && s.setup.dimension === 'minecraft:overworld'));
	assert.ok(suite.scenarios.some(s => s.setup.locate?.type === 'structure'));
	assert.ok(suite.scenarios.some(s => s.setup.dimension === 'minecraft:overworld' && s.objective.type === 'dimension' && s.objective.dimension === 'minecraft:the_nether'));
	assert.ok(suite.scenarios.some(s => s.durationBudgetMs === 600000 && s.categories.goalType.includes('progression')));
	assert.ok(suite.scenarios.some(s => s.objective.type === 'unsupported'));
	assert.ok(suite.scenarios.some(s => s.setup.mobs.length >= 3));
	assert.ok(suite.scenarios.filter(s => s.setup.dimension !== 'minecraft:overworld').length >= 5);
	assert.ok(suite.scenarios.every(s => !s.setup.commands.some(c => c.includes('fillbiome'))));
});

test('hazard fixtures prepare safe terrain and defer the hazard until the first decision', () => {
	for (const id of ['T14', 'T15', 'T16', 'T17']) {
		const { setup } = byId.get(id);
		assert.equal(setup.activation, 'first-decision', id);
		assert.ok(setup.finalCommands.length > 0, id);
		assert.ok(!setup.commands.some(c => /minecraft:(?:fire|lava|water)$/.test(c)), id);
	}
	assert.match(byId.get('T16').setup.finalCommands[0], /~18/);
	assert.equal(byId.get('T05').setup.foodLevelTarget, 8);
	for (const id of ['T04', 'T07']) assert.equal(byId.get(id).setup.groundBelowCanopy, true);
});

test('shelter, home and Helper objectives cannot be satisfied by the old accidental setup state', () => {
	assert.equal(byId.get('T04').objective.type, 'shelter');
	assert.equal(byId.get('T09').objective.type, 'shelter');
	assert.ok(byId.get('T09').setup.commands.some(c => c.endsWith('minecraft:grass_block')));
	assert.ok(!/\d+\s*,\s*\d+/.test(byId.get('T10').goal));
	assert.ok(!byId.get('T10').setup.commands.some(c => c.includes('~30')));
	assert.match(byId.get('T25').objective.rcon, /Inventory/);
	assert.doesNotMatch(byId.get('T25').objective.rcon, /minecraft:item/);
	assert.ok(byId.get('T24').setup.commands.some(c => c.includes('kill @e[type=minecraft:ender_dragon]')));
});

test('piglin objective accepts every barter reward instead of one random gravel outcome', () => {
	const s = byId.get('T23');
	assert.equal(s.objective.type, 'inventory-any');
	assert.ok(s.objective.items.some(i => i.item === 'minecraft:enchanted_book'));
	assert.ok(s.objective.items.some(i => i.item === 'minecraft:gravel'));
	assert.ok(s.objective.items.length >= 17);
	assert.ok(s.objective.items.every(i => !s.setup.inventory.some(j => j.item === i.item)));
});
