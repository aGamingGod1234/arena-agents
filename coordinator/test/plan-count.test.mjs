import test from 'node:test';
import assert from 'node:assert/strict';
import { planCountDefault } from '../src/plan-count.mjs';
import { validateAction } from '../src/schema.mjs';

const BLAZE = '11111111-1111-4111-8111-111111111111';
const ENDER = '22222222-2222-4222-8222-222222222222';
const ZOMBIE = '33333333-3333-4333-8333-333333333333';
const entities = [
	{ uuid: BLAZE, type: 'minecraft:blaze', distance: 6 },
	{ uuid: ENDER, type: 'minecraft:enderman', distance: 9 },
	{ uuid: ZOMBIE, type: 'minecraft:zombie', distance: 3 },
];
const rods = { id: 'minecraft:blaze_rod', have: 1, need: 6, step: 'rods', label: 'blaze_rod 6' };
const pearls = { id: 'minecraft:ender_pearl', have: 0, need: 12, step: 'pearls', label: 'pearls' };
const fight = (targetId, extra = {}) => ({ kind: 'action', actionType: 'fight_target', arguments: { targetId, timeoutMs: 15000, ...extra } });

test('a fight_target on a blaze runs to the open plan step rod count', () => {
	const { tool, note } = planCountDefault(fight(BLAZE), { needs: [rods], entities });
	assert.deepEqual(tool.arguments, { targetId: BLAZE, timeoutMs: 15000, untilItem: 'minecraft:blaze_rod', untilCount: 6 });
	assert.match(note, /Count mode from your plan: step "blaze_rod 6" checks has:minecraft:blaze_rod\*6 \(held 1\)/);
	assert.match(note, /single:true fights one target only/);
	assert.match(note, /cancelAction stops the run/);
	assert.doesNotThrow(() => validateAction({ type: tool.actionType, ...tool.arguments }));
});

test('use_ranged on an enderman picks the pearl need, skipping other needs', () => {
	const ranged = { kind: 'action', actionType: 'use_ranged', arguments: { targetId: ENDER, drawDurationMs: 1000 } };
	const { tool, note } = planCountDefault(ranged, { needs: [rods, pearls], entities });
	assert.equal(tool.arguments.untilItem, 'minecraft:ender_pearl');
	assert.equal(tool.arguments.untilCount, 12);
	assert.match(note, /this use_ranged on minecraft:enderman/);
	assert.doesNotThrow(() => validateAction({ type: tool.actionType, ...tool.arguments }));
});

test('the model own count, single:true, or no fitting need keep the call as written', () => {
	const own = fight(BLAZE, { untilItem: 'minecraft:blaze_rod', untilCount: 2 });
	assert.deepEqual(planCountDefault(own, { needs: [rods], entities }), { tool: own });
	const single = planCountDefault(fight(BLAZE, { single: true }), { needs: [rods], entities });
	assert.deepEqual(single.tool.arguments, { targetId: BLAZE, timeoutMs: 15000 });
	assert.equal(single.note, undefined);
	// Met need, other mob, unseen target, no plan.
	assert.equal(planCountDefault(fight(BLAZE), { needs: [{ ...rods, have: 6 }], entities }).note, undefined);
	assert.equal(planCountDefault(fight(ZOMBIE), { needs: [rods], entities }).note, undefined);
	assert.equal(planCountDefault(fight('44444444-4444-4444-8444-444444444444'), { needs: [rods], entities }).note, undefined);
	assert.equal(planCountDefault(fight(BLAZE), { needs: [], entities }).note, undefined);
	assert.equal(planCountDefault(fight(BLAZE), { needs: [pearls], entities }).note, undefined);
});

test('single:false is stripped and other actions pass through untouched', () => {
	const { tool } = planCountDefault(fight(ZOMBIE, { single: false }), { needs: [rods], entities });
	assert.equal(Object.hasOwn(tool.arguments, 'single'), false);
	const walk = { kind: 'action', actionType: 'navigate_to', arguments: { x: 1, y: 2, z: 3 } };
	assert.equal(planCountDefault(walk, { needs: [rods], entities }).tool, walk);
});

test('schema: single is a boolean and excludes an explicit count', () => {
	assert.doesNotThrow(() => validateAction({ type: 'fight_target', targetId: BLAZE, timeoutMs: 15000, single: true }));
	assert.throws(() => validateAction({ type: 'fight_target', targetId: BLAZE, timeoutMs: 15000, single: 'yes' }), /boolean/);
	assert.throws(() => validateAction({ type: 'fight_target', targetId: BLAZE, timeoutMs: 15000, single: true, untilItem: 'minecraft:blaze_rod', untilCount: 3 }), /exclude/);
});
