import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/fullgame-deaths.json', import.meta.url)));
const cases = fixture.cases;
const byId = suffix => cases.find(c => c.id === `deaths-${suffix}`);
const header = (player, trigger = 'damage') => buildNativeEventInput({ agentId: 'death-test', goalRevision: 1, currentGoal: 'Beat the game' }, {
	event: 'program_attention', trigger: 'program_attention', programId: 'p',
	status: { state: 'RUNNING', engineState: 'SUSPENDED', decision: { decisionId: 'p:1', trigger, priority: 'urgent' } },
	observation: { player, inventory: { items: [] }, blocks: [], entities: [] },
}).split('\n')[0];

test('recorded death cases preserve raw observations and render all eight decision checkpoints', async () => {
	validateCaseFile(fixture);
	assert.equal(cases.length, 8);
	for (const c of cases) {
		assert.equal(observationSha256(c.state.observation), c.source.observationSha256, c.id);
		assert.equal(c.source.sourceMomentId, `sm-${createHash('sha256').update(`${c.source.trace}\n${c.source.observationSha256}`).digest('hex').slice(0, 16)}`);
		const rendered = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol' });
		assert.ok(rendered.encodedInput.length > 100, c.id);
		if (c.id.includes('gravel')) assert.match(rendered.instruction, /suffocating inside a solid block/);
		if (c.id.includes('zombie')) assert.match(rendered.instruction, /bailout health/);
		if (c.id.includes('creeper')) assert.match(rendered.instruction, /Choose flee_from now/);
	}
});

test('recorded raw traversal and falling gravel retain the actual cause evidence', () => {
	const gravel = byId('gravel-head').state.observation;
	assert.equal(gravel.player.suffocating, true);
	assert.equal(gravel.player.harm.source, 'minecraft:in_wall');
	assert.ok(gravel.blocks.some(b => b.blockId === 'minecraft:gravel' && b.x === -8 && b.y === 77 && b.z === -122));
	const before = byId('water-exit').state.observation;
	assert.equal(before.player.inWater, true);
	assert.equal(before.player.health, 6.5);
	const falling = byId('fall-airborne').state.observation;
	assert.equal(falling.currentAction.actionType, 'control');
	assert.equal(falling.interaction.input.forward, 1);
	assert.equal(falling.interaction.input.jump, true);
	assert.ok(falling.player.fallDistance > 4);
	assert.equal(falling.player.fallDamage, 1);
});

test('active suffocation overrides generic damage and full-food recovery across health levels', () => {
	for (const health of [20, 19, 7, 1]) {
		const line = header({ health, foodLevel: 20, suffocating: true });
		assert.match(line, /Break the observed block.*cancelProgram/);
		assert.doesNotMatch(line, /^danger\. Reply/);
	}
	assert.doesNotMatch(header({ health: 20, suffocating: false }), /suffocating inside/);
});

test('an imminent creeper overrides a pending melee decision even when another mob ranks first', () => {
	for (const signal of ['imminent', 'creeper_close', 'swelling']) {
		const line = header({ health: 15, threats: [
			{ uuid: 'skeleton', type: 'minecraft:skeleton', targeting: true },
			{ uuid: 'creeper', type: 'minecraft:creeper', distance: 4.9, signals: [signal], swelling: signal === 'swelling' },
		] }, 'threat');
		assert.match(line, /creeper creeper 4.9m.*flee_from now.*during a fight/);
		assert.match(line, /Respond to the pending program decision after/);
	}
});

test('fall instructions distinguish a grounded unknown edge from an already airborne body', () => {
	assert.match(header({ health: 6.5, onGround: true, dropAhead: { drop: 1, atLeast: true, at: 3 } }, 'fall'), /stop forward\/jump input before the edge.*Unknown depth/);
	assert.match(header({ health: 6.5, onGround: false, fallDistance: 4.04, fallDamage: 1 }, 'fall'), /already falling.*sneak cannot undo/);
	const voidFall = header({ health: 20, onGround: false, fallDistance: 4.06, fallDamage: 1, harm: { source: 'minecraft:fell_out_of_world', options: ['known_support', 'flight', 'teleport'] } }, 'fall');
	assert.match(voidFall, /falling into the void.*no landing or water bucket stops it.*ender pearl/);
	assert.doesNotMatch(voidFall, /Choose reachable water/);
});

test('fireball and cloud lines name a void edge beside or ahead of the body', () => {
	const incomingProjectiles = [{ type: 'minecraft:dragon_fireball', etaSeconds: 1.4, bearing: 20, damaging: true }];
	assert.match(header({ health: 20, incomingProjectiles, footing: { drop: 57, into: 'void', yaw: -90 } }, 'projectile'), /hits in 1.4s, bearing 20\. Void edge beside you at yaw -90\./);
	assert.match(header({ health: 20, incomingProjectiles, dropAhead: { at: 3, drop: 54, atLeast: false, into: 'void' } }, 'projectile'), /Void 3 blocks ahead\./);
	assert.doesNotMatch(header({ health: 20, incomingProjectiles, dropAhead: { at: 3, drop: 4 } }, 'projectile'), /Void/);
});

test('danger lines name an open drop beside the body and what a hit does there', async () => {
	const { edgeNote } = await import('../src/dynamic-main.mjs');
	const incomingProjectiles = [{ type: 'minecraft:small_fireball', etaSeconds: 0.6, bearing: 80, damaging: true }];
	assert.match(header({ health: 20, incomingProjectiles, footing: { drop: 22, yaw: 90 } }, 'projectile'),
		/incoming small_fireball hits in 0.6s, bearing 80\. Open drop 22 blocks beside you at yaw 90, a fall costs ~19 HP of your 20\. A hit knocks you about 3 blocks away from the hitter, airborne, so sneaking does not hold the edge; a solid block on that side stops the push\./);
	assert.match(edgeNote({ footing: { drop: 31, into: 'lava', yaw: -4 } }), /^ Open drop 31 blocks beside you at yaw -4 into lava\. A hit knocks/);
	assert.match(edgeNote({ health: 12, footing: { drop: 9, atLeast: true, yaw: 0 } }), /Open drop 9\+ blocks .*~6\+ HP of your 12/);
	// Runs d9-nether-d/d10-nether-b: knocked off fortress bridges whose edge was two cells away, not beside the feet.
	assert.match(edgeNote({ health: 9, footing: { drop: 19, yaw: 106, distance: 1.4 } }), /^ Open drop 19 blocks 1\.4 blocks from you at yaw 106, a fall costs ~16 HP of your 9\. A hit knocks you about 3 blocks/);
	assert.match(edgeNote({ footing: { drop: 60, into: 'void', yaw: 10, distance: 2 } }), /^ Void edge 2 blocks from you at yaw 10\.$/);
	assert.equal(edgeNote({ footing: { drop: 3, atLeast: true, yaw: 0 } }), '');
	assert.equal(edgeNote({ footing: { drop: 8, into: 'water', yaw: 0 } }), '');
});

test('threat lines name the nearest push-safe and roofed stands the mod found in seen terrain', async () => {
	const { edgeNote, standNote } = await import('../src/dynamic-main.mjs');
	const blaze = [{ type: 'minecraft:blaze', distance: 7 }];
	// Live 2026-10-21 at d9-nether-d's knock-off spot (59.6,69,92.7 on seed 20261009): a fall of 19 beside the feet.
	const exposed = { here: { pushSafe: false, roof: false, walls: 0 }, pushSafe: { x: 64, y: 69, z: 95, steps: 8, roof: false, walls: 0, open: 'N,E,S,W' },
		covered: { x: 83, y: 70, z: 83, steps: 14, roof: true, walls: 2, open: 'S,W' }, searchedSteps: 16 };
	const note = edgeNote({ health: 20, threats: blaze, footing: { drop: 19, yaw: 175 }, stand: exposed });
	assert.match(note, /Open drop 19 blocks beside you.* Nearest push-safe stand \(no open drop within 3 blocks\): 64,69,95, 8 steps \(no roof, 0 walls, open N,E,S,W\)\. Nearest roofed push-safe stand: 83,70,83, 14 steps \(roof, 2 walls, open S,W\); shots reach it only through open sides\.$/);
	assert.equal(standNote({ threats: blaze, stand: { here: { pushSafe: false }, searchedSteps: 16 } }), ' No push-safe stand within 16 steps of seen footing.');
	// Push-safe here: a roofed stand is news against shooters only.
	const safeHere = { here: { pushSafe: true, roof: false, walls: 0 }, covered: { x: 1, y: 64, z: 2, steps: 3, roof: true, walls: 3, open: 'S' } };
	assert.match(standNote({ threats: blaze, stand: safeHere }), /^ Nearest roofed push-safe stand: 1,64,2, 3 steps \(roof, 3 walls, open S\)/);
	assert.equal(standNote({ threats: [{ type: 'minecraft:zombie' }], stand: safeHere }), '');
	// The same cell is named once.
	assert.doesNotMatch(standNote({ threats: blaze, stand: { here: { pushSafe: false }, pushSafe: { x: 1, y: 2, z: 3, steps: 1, roof: true, walls: 2 }, covered: { x: 1, y: 2, z: 3, steps: 1, roof: true, walls: 2 } } }), /roofed/);
	assert.equal(standNote({}), '');
});
