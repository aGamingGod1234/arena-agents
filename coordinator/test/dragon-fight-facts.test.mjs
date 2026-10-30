import test from 'node:test';
import assert from 'node:assert/strict';
import { combatFacts } from '../src/combat-facts.mjs';
import { buildNativeEventInput, classifyObservationTrigger } from '../src/dynamic-main.mjs';
import { dragonPerchEdge, dragonPerchLine, endCrystalFact, noteCombatDispatch, rememberEndCrystals, settleCombatResult } from '../src/dragon-fight-facts.mjs';

const HEAD = '00000000-0000-0000-0000-0000000000a1';
const dragon = (motion, extra = {}) => ({ stableId: 'dragon', type: 'minecraft:ender_dragon', alive: true, perceivedBy: 'sight', x: 0.5, y: 67.8, z: 0.4, distance: 9.6, appearance: { motion }, ...extra });
const head = { stableId: HEAD, type: 'minecraft:ender_dragon', parentId: 'dragon', partName: 'head', perceivedBy: 'sight', x: 2.2, y: 68.4, z: -3.1, distance: 7.2 };
const end = (entities) => ({ ready: true, observedAtEpochMs: 0, player: { health: 20, maxHealth: 20, foodLevel: 20 }, world: { dimension: 'minecraft:the_end' }, inventory: { items: [] }, entities });

test('a fountain landing is one urgent wake with the head and the vanilla perch rules', () => {
	const state = {};
	assert.equal(dragonPerchEdge(state, end([dragon('flying')]), 1_000), null);
	const perch = dragonPerchEdge(state, end([dragon('perched'), head]), 2_000);
	assert.deepEqual(perch, { distance: 9.6, head: { id: HEAD, x: 2.2, y: 68.4, z: -3.1, distance: 7.2 } });
	// Rows that drop out of view, or more perched samples, belong to the same landing.
	assert.equal(dragonPerchEdge(state, end([]), 3_000), null);
	assert.equal(dragonPerchEdge(state, end([dragon('perched')]), 6_000), null);
	// Seen flying again, the next landing wakes again.
	assert.equal(dragonPerchEdge(state, end([dragon('ascending')]), 9_000), null);
	assert.notEqual(dragonPerchEdge(state, end([dragon('perched')]), 40_000), null);
	// A landing heard only, or a dead dragon, is no sight of a perch.
	assert.equal(dragonPerchEdge({}, end([dragon('perched', { perceivedBy: 'sound' })]), 0), null);

	assert.deepEqual(classifyObservationTrigger({ attention: false, changedFacts: [] }, end([dragon('perched'), head]), { dragonPerch: perch }),
		{ attention: true, priority: 'urgent', trigger: 'dragon_perched' });
	// Damage in the same sample keeps its own wake.
	assert.equal(classifyObservationTrigger({ attention: true, changedFacts: ['player.health'] }, end([]), { dragonPerch: perch }).trigger, 'damage');

	const record = { currentGoal: 'Defeat the Ender Dragon', goalRevision: 1 };
	const o = { ...end([dragon('perched'), head]), dragonPerch: perch };
	const lead = buildNativeEventInput(record, { event: 'observation', observation: o, trigger: 'dragon_perched', priority: 'urgent' }).split('\n')[0];
	assert.match(lead, /dragon landed on the exit fountain, 9\.6 blocks away\. Head 0{8}-0{4}-0{4}-0{4}-0{10}a1 at 2\.2,68\.4,-3\.1, 7\.2 blocks from you\./);
	assert.match(lead, /arrows bounce off.*head takes full melee damage.*within 20 blocks \(10 up or down\)/);
	const decision = buildNativeEventInput(record, { event: 'observation', observation: end([dragon('flying')]), status: { decision: { priority: 'urgent', trigger: 'dragon_perched' } } }).split('\n')[0];
	assert.match(decision, /landed on the exit fountain and is not seen perched now\..*Answer program decisions\.$/);
});

test('the perch wake states the breath geometry and the kill arithmetic for the carried weapon', () => {
	const items = [{ itemId: 'minecraft:stone_sword', count: 1, slot: 'hotbar.1' }, { itemId: 'minecraft:iron_sword', count: 1, slot: 'mainhand' }, { itemId: 'minecraft:diamond_axe', count: 1, slot: 'hotbar.2' }];
	const o = { ...end([dragon('perched', { health: 166 }), head]), inventory: { items } };
	const line = dragonPerchLine(o);
	assert.match(line, /cloud of radius 5 centred 2\.5 blocks beyond its head for about 10 s/);
	assert.match(line, /its wings throw anyone within about 6 blocks of either wing \(its sides and back.*Straight out in front of its head is clear of the wings; its breath lands there\./);
	assert.match(line, /50 damage in one perch makes it take off/);
	// fight_target swings a sword before an axe: the best sword, not the axe's 9.
	assert.match(line, /Dragon health 166 of 200\. Your iron sword hits the head for 6 \(a dragon part takes no criticals\): about 28 hits, at most 50 damage a perch, so at least 4 perches\./);
	assert.match(dragonPerchLine({ ...end([dragon('perched', { health: 40 }), head]), inventory: { items: [] } }), /Dragon health 40 of 200\. No sword or axe carried: a bare hand hits the head for 1\./);
});

test('the ordinary flying-dragon wake gives the fountain and timing facts before a short perch', () => {
	const o = end([dragon('flying')]);
	const facts = combatFacts(o);
	assert.match(facts, /waiting on open ground 10-15 blocks from the fountain/);
	assert.match(facts, /empty perch lasts only about 5 seconds, often less than a reply/);
	assert.match(facts, /iron sword recharges in 0\.625 seconds/);
	assert.match(facts, /visible cloud lasts about 10 seconds/);
	assert.match(facts, /gaze guard must outrank movement reflexes/);
	assert.match(facts, /open mouth shows anger, not its target/);
	const input = buildNativeEventInput({ currentGoal: 'Defeat the Ender Dragon', goalRevision: 1 },
		{ event: 'observation', observation: o, trigger: 'observation' });
	assert.match(input, /bedrock exit fountain/);
});

test('End crystals seen stay remembered, and a crystal broken by your own shot is counted broken', () => {
	const state = {};
	const crystal = (id, x, y, z, caged = false) => ({ stableId: id, type: 'minecraft:end_crystal', perceivedBy: 'sight', x, y, z, ...(caged ? { appearance: { caged: true } } : {}) });
	assert.equal(rememberEndCrystals(state, { ...end([crystal('c1', 0, 90, 0)]), world: { dimension: 'minecraft:overworld' } }), null);
	rememberEndCrystals(state, end([crystal('north', -11.5, 83, -39.5, true), crystal('west', -41.5, 80, -0.5, true)]));
	noteCombatDispatch(state, 'shot-1', 'use_ranged', { targetId: 'north' });
	noteCombatDispatch(state, 'shot-2', 'use_ranged', { targetId: 'west' });
	settleCombatResult(state, { actionId: 'shot-1', state: 'SUCCEEDED', message: 'Arrow loosed (aim point -12.9,87.9,-39.0); it struck the target, which broke or died' });
	settleCombatResult(state, { actionId: 'shot-2', state: 'SUCCEEDED', message: 'Arrow loosed; missed: stuck in minecraft:iron_bars at -40,80,0' });
	// Out of sight later: memory, not this sample, answers.
	const tally = rememberEndCrystals(state, end([]));
	assert.deepEqual(tally, { standing: [{ x: -42, y: 80, z: -1, caged: true }], broken: 1 });
	assert.match(endCrystalFact(tally), /^End crystals you have seen: 1 standing when last seen \(-42,80,-1 caged \(beside it feet y=80\)\), 1 broken by your own hits\. The 10 obsidian pillars/);
	// Caged: the cage, why ground arrows fail, the vanilla way through, where to stand relative to the player, and the blast.
	const fact = endCrystalFact(tally, { y: 62 });
	assert.match(fact, /-42,80,-1 caged \(beside it feet y=80, 18 above you\)/);
	assert.match(fact, /arrows stick in the side walls from any spot/);
	assert.match(fact, /pillar up beside the cage to the crystal's height, break the 2 wall bars there/);
	assert.match(fact, /blast deals about 56 at 3 blocks/);
	assert.doesNotMatch(endCrystalFact({ standing: [{ x: 1, y: 90, z: 1 }], broken: 0 }), /Caged/);
	const facts = combatFacts({ ...end([]), endCrystals: tally });
	assert.match(facts, /End crystals you have seen: 1 standing/);
	assert.equal(combatFacts({ ...end([]), world: { dimension: 'minecraft:overworld' }, endCrystals: tally }), null);
});

test('A caged crystal remembers the gaps last seen in its cage', () => {
	const state = {};
	const seen = (appearance) => end([{ stableId: 'west', type: 'minecraft:end_crystal', perceivedBy: 'sight', x: -41.5, y: 80, z: -0.5, appearance }]);
	rememberEndCrystals(state, seen({ caged: true }));
	let tally = rememberEndCrystals(state, seen({ caged: true, cageOpen: ['-40,80,-1', '-40,81,-1'] }));
	assert.deepEqual(tally.standing, [{ x: -42, y: 80, z: -1, caged: true, open: ['-40,80,-1', '-40,81,-1'] }]);
	assert.match(endCrystalFact(tally, { y: 61.5 }), /-42,80,-1 caged \(beside it feet y=80, 19 above you; open bars -40,80,-1 -40,81,-1\)/);
	// Out of sight the last seen gaps stay.
	tally = rememberEndCrystals(state, end([]));
	assert.deepEqual(tally.standing[0].open, ['-40,80,-1', '-40,81,-1']);
});
