import assert from 'node:assert/strict';
import test from 'node:test';
import { fightSteerDecision, nativeSteerInterruption } from '../src/dynamic-main.mjs';
import { DangerSteerCoalescer } from '../src/danger-steer-coalescer.mjs';
import { runFightSteerBenchmark } from '../src/benchmark/fight-steer-benchmark.mjs';

const zombieRow = { type: 'minecraft:zombie', uuid: 'z1', signals: ['targeting', 'attacked'] };
function damage({ health = 16, attacker = 'minecraft:zombie', attackerUuid = 'z1', threats = [zombieRow], player = {} } = {}) {
	return { trigger: 'damage', nativeEvent: { event: 'observation', trigger: 'damage', observation: { player: { health, lastAttacker: { type: attacker, uuid: attackerUuid }, threats, ...player } } } };
}
const fight = (extra = {}) => ({ actionId: 'a1', actionType: 'fight_target', arguments: { targetId: 'z1' }, startHealth: 20, ...extra });

test('hits from the mob being fought do not cut that fight short', () => {
	const decision = fightSteerDecision(damage(), fight());
	assert.equal(decision.interruption, null);
	assert.equal(decision.absorbed, true);
	assert.equal(nativeSteerInterruption(damage()), 'danger', 'the plain classifier is unchanged');
});

test('named fights distinguish same-type attackers by UUID', () => {
	const other = damage({ health: 18, attackerUuid: 'z2' });
	assert.equal(fightSteerDecision(other, fight()).interruption, 'danger');
	assert.equal(fightSteerDecision(other, fight()).absorbed, false);
	assert.equal(fightSteerDecision(damage({ health: 18, threats: [] }), fight()).absorbed, true,
		'the target identity does not depend on a visible threat row');
	for (const uuid of [undefined, null, '']) {
		const request = damage(); request.nativeEvent.observation.player.lastAttacker.uuid = uuid;
		assert.equal(fightSteerDecision(request, fight()).interruption, 'danger', 'unproven identity');
	}
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
	assert.equal(fightSteerDecision(damage({ attacker: 'minecraft:skeleton', attackerUuid: 's1' }), fight()).interruption, 'danger', 'other attacker');
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
	for (const policy of [{ targetPolicy: 'nearest_attacker' }, { targetPolicy: 'highest_risk' }, { continueWithAttackers: true }]) {
		assert.equal(fightSteerDecision(damage({ attacker: 'minecraft:husk', attackerUuid: 'h1' }), fight({ arguments: { targetId: 'z1', ...policy } })).interruption, null);
	}
	const farm = { actionId: 'f', actionType: 'fight_until', arguments: { mob: 'minecraft:blaze' }, startHealth: 20 };
	assert.equal(fightSteerDecision(damage({ attacker: 'minecraft:blaze', threats: [] }), farm).interruption, null);
	assert.equal(fightSteerDecision(damage({ attacker: 'minecraft:wither_skeleton', threats: [] }), farm).interruption, 'danger');
});

test('coalesced hits retain same-type attacker identities', () => {
	for (const earlierUuid of ['z1', 'z2', undefined]) {
		const coalescer = new DangerSteerCoalescer();
		coalescer.noteDelivered(damage({ health: 20 }), 0);
		const earlier = damage({ health: 19 });
		earlier.nativeEvent.observation.player.lastAttacker.uuid = earlierUuid;
		assert.equal(coalescer.offer(earlier, 100).action, 'fold');
		assert.equal(coalescer.offer(damage({ health: 18 }), 200).action, 'fold');
		const request = coalescer.flush(2000);
		assert.equal(fightSteerDecision(request, fight()).interruption, earlierUuid === 'z1' ? null : 'danger');
	}
});

test('type-only summaries cannot prove a named target covered earlier hits', () => {
	const request = damage({ health: 18 });
	request.dangerSummary = { hitsSinceLastUpdate: 2, attackers: ['minecraft:zombie'], healthNow: 18 };
	assert.equal(fightSteerDecision(request, fight()).interruption, 'danger');
	assert.equal(fightSteerDecision(request, fight({ arguments: { targetId: 'z1', continueWithAttackers: true } })).absorbed, true);
	const farm = { ...fight(), actionType: 'fight_until', arguments: { mob: 'zombie' } };
	assert.equal(fightSteerDecision(request, farm).absorbed, true);
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
