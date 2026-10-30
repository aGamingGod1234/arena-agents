import assert from 'node:assert/strict';
import test from 'node:test';
import { armedRulesAt, armedRuleId, hands } from '../../scripts/quality/watch-incidents.mjs';

const call = (at, entries) => ({ at, agentId: 'a', tool: 'act', entries });
const shield = { id: 'shield', kind: 'stance', priority: 6, when: { type: 'hostile_near', within: 16 }, do: { type: 'shield' }, ttlS: 600 };
const shots = { id: 'shots', kind: 'trigger', priority: 8, when: { type: 'incoming_projectile' }, do: { type: 'shield' }, ttlS: 600 };

test('armed rules rebuild from provider turns when the Watcher names them rule:trigger', () => {
	assert.equal(armedRuleId('shield:hostile_near'), 'shield');
	assert.equal(armedRuleId('melee'), 'melee');
	const calls = [call(1000, [shield]), call(2000, [shots])];
	const armed = armedRulesAt(calls, { agentId: 'a', atMs: 3000, armedIds: ['shield:hostile_near'] });
	assert.deepEqual(armed.rules.map(r => r.id), ['shield']);
	assert.deepEqual(armed.missingFromProviderTurns, []);
	const both = armedRulesAt(calls, { agentId: 'a', atMs: 3000, armedIds: ['shield:hostile_near', 'shots:incoming_projectile', 'gone:falling'] });
	assert.deepEqual(both.rules.map(r => r.id), ['shield', 'shots']);
	assert.deepEqual(both.missingFromProviderTurns, ['gone']);
});

test('a rule the Watcher saw armed is kept past its wall-clock ttl (the mod counts server ticks)', () => {
	const calls = [call(0, [{ ...shield, ttlS: 60 }])];
	assert.deepEqual(armedRulesAt(calls, { agentId: 'a', atMs: 90_000, armedIds: ['shield:hostile_near'] }).rules.map(r => r.id), ['shield']);
	assert.deepEqual(armedRulesAt(calls, { agentId: 'a', atMs: 90_000 }).rules, []);
});

test('the hands are kept slot by slot with the offhand shield and the held slot', () => {
	const sample = {
		inventoryNbt: '[{count: 1, Slot: 0b, id: "minecraft:birch_log"}, {components: {"minecraft:damage": 19}, count: 1, Slot: 4b, id: "minecraft:iron_sword"}]',
		entityNbt: 'ha has the following entity data: {SelectedItemSlot: 4, equipment: {offhand: {components: {"minecraft:damage": 65}, count: 1, id: "minecraft:shield"}}, fall_distance: 0.0d}',
	};
	assert.deepEqual(hands(sample), {
		slots: [{ slot: 0, item: 'minecraft:birch_log', count: 1 }, { slot: 4, item: 'minecraft:iron_sword[minecraft:damage=19]', count: 1 }],
		offhand: 'minecraft:shield[minecraft:damage=65]', selectedSlot: 4,
	});
});
