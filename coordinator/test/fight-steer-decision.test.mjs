import assert from 'node:assert/strict';
import test from 'node:test';
import { fightSteerDecision, nativeSteerInterruption } from '../src/dynamic-main.mjs';
import { runFightSteerBenchmark } from '../src/benchmark/fight-steer-benchmark.mjs';

const zombieRow = { type: 'minecraft:zombie', uuid: 'z1', signals: ['targeting', 'attacked'] };
function damage({ health = 16, attacker = 'minecraft:zombie', threats = [zombieRow], player = {} } = {}) {
	return { trigger: 'damage', nativeEvent: { event: 'observation', trigger: 'damage', observation: { player: { health, lastAttacker: { type: attacker, uuid: 'x' }, threats, ...player } } } };
}
const fight = (extra = {}) => ({ actionId: 'a1', actionType: 'fight_target', arguments: { targetId: 'z1' }, startHealth: 20, ...extra });

test('hits from the mob being fought do not cut that fight short', () => {
	const decision = fightSteerDecision(damage(), fight());
	assert.equal(decision.interruption, null);
	assert.equal(decision.absorbed, true);
	assert.equal(nativeSteerInterruption(damage()), 'danger', 'the plain classifier is unchanged');
});

test('without a running fight every hit still interrupts', () => {
	assert.equal(fightSteerDecision(damage(), null).interruption, 'danger');
	assert.equal(fightSteerDecision(damage(), { actionId: 'n', actionType: 'navigate_to', arguments: {} }).interruption, 'danger');
});

test('falling into a lower health band cuts the fight once, then the band is the new reference', () => {
	const first = fightSteerDecision(damage({ health: 13.5 }), fight());
	assert.equal(first.interruption, 'danger');
	assert.deepEqual(first.cut, { actionId: 'a1', health: 13.5 });
	assert.equal(fightSteerDecision(damage({ health: 12 }), fight(), first.cut).interruption, null, 'same band after the cut');
	assert.equal(fightSteerDecision(damage({ health: 9.5 }), fight(), first.cut).interruption, 'danger', 'next band');
	assert.equal(fightSteerDecision(damage({ health: 12 }), fight(), { actionId: 'older', health: 20 }).interruption, 'danger',
		'state from an earlier fight is ignored; this fight started at 20');
});

test('the decision is pure, so evaluating one steer twice agrees', () => {
	const request = damage({ health: 13 });
	assert.deepEqual(fightSteerDecision(request, fight()), fightSteerDecision(request, fight()));
});

test('new information still interrupts a fight', () => {
	assert.equal(fightSteerDecision(damage({ attacker: 'minecraft:skeleton' }), fight()).interruption, 'danger', 'other attacker');
	assert.equal(fightSteerDecision(damage({ attacker: 'minecraft:player' }), fight({ arguments: { targetId: 'z1', continueWithAttackers: true } })).interruption, 'danger', 'players are never absorbed');
	assert.equal(fightSteerDecision(damage({ player: { inLava: true } }), fight()).interruption, 'danger', 'hazard');
	assert.equal(fightSteerDecision({ ...damage(), trigger: 'lava', nativeEvent: { ...damage().nativeEvent, trigger: 'lava' } }, fight()).interruption, 'danger', 'lava trigger');
	const creeper = { type: 'minecraft:creeper', uuid: 'c1', signals: ['swelling'] };
	assert.equal(fightSteerDecision(damage({ threats: [zombieRow, creeper] }), fight()).interruption, 'danger', 'swelling creeper');
	const projectile = damage({ player: { incomingProjectiles: [{ type: 'minecraft:arrow', damaging: true }] } });
	projectile.nativeEvent.trigger = 'projectile'; projectile.trigger = 'projectile';
	assert.equal(fightSteerDecision(projectile, fight()).interruption, 'danger', 'incoming arrow');
	const unknown = damage(); delete unknown.nativeEvent.observation.player.lastAttacker;
	assert.equal(fightSteerDecision(unknown, fight()).interruption, 'danger', 'unknown attacker');
});

test('follow-through fights absorb other mob attackers; fight_until absorbs its own mob kind', () => {
	assert.equal(fightSteerDecision(damage({ attacker: 'minecraft:husk' }), fight({ arguments: { targetId: 'z1', targetPolicy: 'nearest_attacker' } })).interruption, null);
	const farm = { actionId: 'f', actionType: 'fight_until', arguments: { mob: 'minecraft:blaze' }, startHealth: 20 };
	assert.equal(fightSteerDecision(damage({ attacker: 'minecraft:blaze', threats: [] }), farm).interruption, null);
	assert.equal(fightSteerDecision(damage({ attacker: 'minecraft:wither_skeleton', threats: [] }), farm).interruption, 'danger');
});

test('benchmark: hits from the fought mob cut the fight only at health bands', () => {
	const rows = runFightSteerBenchmark();
	const [half, one, three, control] = rows;
	assert.deepEqual([half.before.interruptions, half.after.interruptions], [12, 2]);
	assert.deepEqual([one.before.interruptions, one.after.interruptions], [14, 3]);
	assert.deepEqual([three.before.interruptions, three.after.interruptions], [17, 3]);
	assert.equal(control.after.interruptions, control.before.interruptions, 'an attacker outside the fight still interrupts every steer');
	for (const row of rows) assert.equal(row.after.delivered, row.before.delivered, 'every steer is still delivered to the model');
});
