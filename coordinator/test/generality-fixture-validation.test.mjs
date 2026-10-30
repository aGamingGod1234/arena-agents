import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseValidationArgs, parseValidationPlayer, safeHoldChecks, validateFixture } from '../../scripts/quality/validate-generality-fixtures.mjs';

const entity = ({ mode = 1, health = 20, food = 20, y = 100, fire = -20, air = 300, effects = '[]' } = {}) => `Q4Check has the following entity data: {Pos: [0.5d, ${y}.0d, 0.5d], Dimension: "minecraft:overworld", Health: ${health}.0f, foodLevel: ${food}, foodSaturationLevel: 0.0f, playerGameType: ${mode}, Fire: ${fire}s, Air: ${air}s, active_effects: ${effects}, Inventory: []}`;
const scenario = { id: 'T01', setup: { dimension: 'minecraft:overworld', position: [0.5, 100, 0.5], commands: [], mobs: [] }, categories: {}, objective: { type: 'inventory', items: [{ item: 'minecraft:oak_log', count: 4 }] } };

test('validator requires a port and keeps held-out command evidence private with a pinned hash', () => {
	const common = ['--fixtures', '/private/scenarios.json', '--password-file', '/secret', '--out', '/private/results/live.json', '--rcon-port', '26903'];
	assert.equal(parseValidationArgs(common).port, 26903);
	assert.throws(() => parseValidationArgs(common.slice(0, -2)), /rcon-port/);
	assert.throws(() => parseValidationArgs([...common, '--split', 'heldout']), /SHA-256|sha256/);
	assert.equal(parseValidationArgs([...common, '--split', 'heldout', '--expect-fixture-sha256', 'a'.repeat(64)]).expectedHash, 'a'.repeat(64));
	assert.throws(() => parseValidationArgs([...common, '--split', 'heldout', '--expect-fixture-sha256', 'a'.repeat(64), '--out', path.resolve('/public/live.json')]), /private fixture directory/);
});

test('raw player parser captures game mode, food, fire, air and ticking effects', () => {
	const player = parseValidationPlayer(entity({ mode: 0, health: 6, food: 7, fire: 120, air: 80, effects: '[{id:"minecraft:fire_resistance",duration:100}]' }), 123);
	assert.equal(player.gameMode, 0);
	assert.equal(player.health, 6);
	assert.equal(player.foodLevel, 7);
	assert.equal(player.fire, 120);
	assert.equal(player.air, 80);
	assert.match(player.effects, /duration:100/);
	assert.equal(player.at, 123);
});

test('safe hold fails for damage, gravity, fire, drowning or early ticking effects', () => {
	const safe = parseValidationPlayer(entity());
	assert.ok(safeHoldChecks(safe, safe).every(c => c.pass));
	for (const changed of [{ health: 18 }, { y: 90 }, { fire: 80 }, { air: 280 }, { effects: '[{id:"minecraft:speed",duration:60}]' }, { food: 19 }]) {
		assert.ok(safeHoldChecks(safe, parseValidationPlayer(entity(changed))).some(c => !c.pass), JSON.stringify(changed));
	}
	assert.ok(safeHoldChecks(parseValidationPlayer(entity({ mode: 0 })), parseValidationPlayer(entity({ mode: 0 })), { survival: true }).every(c => c.pass));
});

test('fake live validation waits for Carpet readiness, holds safely, then activates and cleans up', async () => {
	let mode = 1, readinessReads = 0;
	const commands = [], waits = [], stages = [];
	const result = await validateFixture(scenario, async text => {
		commands.push(text);
		if (text === 'data get entity Q4Check Pos') return { text: ++readinessReads <= 2 ? 'No entity was found' : entity({ mode }) };
		if (text === 'data get entity Q4Check') return { text: entity({ mode }) };
		if (text === 'gamerule send_command_feedback') return { text: 'send_command_feedback is currently set to: false' };
		if (text === 'time query time') return { text: 'The time is 1000' };
		return { text: 'ok' };
	}, {
		wait: async ms => waits.push(ms),
		applySetup: async definition => ({ definition, agent: 'Q4Check', receipts: [] }),
		activateSetup: async (receipt, command, options) => { stages.push(options.stage); mode = 0; return receipt; },
	});
	assert.equal(result.pass, true);
	assert.deepEqual(waits, [100, 100, 3000]);
	assert.deepEqual(stages, ['goal-start']);
	assert.equal(commands.at(-1), 'tick unfreeze');
	assert.ok(commands.at(-3).includes('Q4Check kill'));
});

test('hazards and injury fixtures prove safe survival hold until first decision', async () => {
	let mode = 1, activated = false;
	const stages = [], waits = [];
	const fixture = { ...scenario, setup: { ...scenario.setup, activation: 'first-decision' } };
	const result = await validateFixture(fixture, async text => ({ text: text.startsWith('data get entity Q4Check') ? entity({ mode, fire: activated ? 120 : -20 }) : text === 'gamerule send_command_feedback' ? 'send_command_feedback is currently set to: false' : text === 'time query time' ? 'The time is 1000' : 'ok' }), {
		wait: async ms => waits.push(ms),
		applySetup: async definition => ({ definition, agent: 'Q4Check', receipts: [] }),
		activateSetup: async (receipt, command, { stage }) => { stages.push(stage); mode = 0; activated = stage === 'first-decision'; return receipt; },
	});
	assert.equal(result.pass, true);
	assert.deepEqual(stages, ['goal-start', 'first-decision']);
	assert.deepEqual(waits, [3000, 3000]);
	assert.equal(result.pendingDecisionAfter.fire, -20);
	assert.equal(result.sample.fire, 120);
	mode = 1;
	const injuryStages = [], injuryWaits = [];
	const injury = await validateFixture({ ...scenario, categories: { condition: 'low-health' } }, async text => ({ text: text.startsWith('data get entity Q4Check') ? entity({ mode, health: mode === 0 ? 6 : 20 }) : text === 'gamerule send_command_feedback' ? 'send_command_feedback is currently set to: false' : text === 'time query time' ? 'The time is 1000' : 'ok' }), {
		wait: async ms => injuryWaits.push(ms),
		applySetup: async definition => ({ definition, agent: 'Q4Check', receipts: [] }),
		activateSetup: async (receipt, command, { stage }) => { injuryStages.push(stage); mode = 0; return receipt; },
	});
	assert.equal(injury.pass, true);
	assert.deepEqual(injuryStages, ['goal-start', 'first-decision']);
	assert.deepEqual(injuryWaits, [3000, 3000]);
	assert.deepEqual(injury.checks.find(c => c.name === 'predecision-low-health-does-not-regenerate').observed, [6, 6]);
});

test('a preparation failure preserves evidence and cleans up fake players', async () => {
	const commands = [];
	const result = await validateFixture(scenario, async text => { commands.push(text); return { text: text === 'data get entity Q4Check Pos' ? entity() : 'ok' }; }, { applySetup: async () => { throw new Error('bad ground'); }, activateSetup: async () => {} });
	assert.equal(result.pass, false);
	assert.match(result.error, /bad ground/);
	assert.deepEqual(commands.slice(-3), ['player Q4Check kill', 'player Helper kill', 'tick unfreeze']);
});

test('wrong seed refuses setup instead of validating a fixture on a different world', async () => {
	let applied = false;
	const result = await validateFixture({ ...scenario, seed: '123' }, async text => ({ text: text === 'seed' ? 'Seed: [456]' : 'ok' }), {
		applySetup: async () => { applied = true; }, activateSetup: async () => {},
	});
	assert.equal(result.pass, false);
	assert.equal(applied, false);
	assert.equal(result.checks[0].name, 'world-seed');
	assert.match(result.error, /world seed differs/);
});

test('multi-mob fixture requires all declared mobs rather than one matching mob', async () => {
	let mode = 1;
	const fixture = { ...scenario, setup: { ...scenario.setup, mobs: [{ id: 'minecraft:zombie' }, { id: 'minecraft:zombie' }] } };
	const result = await validateFixture(fixture, async text => ({ text: text.startsWith('data get entity Q4Check') ? entity({ mode }) : text === 'gamerule send_command_feedback' ? 'send_command_feedback is currently set to: false' : text === 'scoreboard players get Q4Count qo_fixture_count' ? 'Q4Count has 1 [qo_fixture_count]' : text === 'time query time' ? 'The time is 1000' : 'ok' }), {
		wait: async () => {}, applySetup: async definition => ({ definition, agent: 'Q4Check', receipts: [] }), activateSetup: async receipt => { mode = 0; return receipt; },
	});
	assert.equal(result.pass, false);
	assert.equal(result.checks.find(c => c.name === 'declared-mob-count-minecraft:zombie').observed.actual, 1);
});
