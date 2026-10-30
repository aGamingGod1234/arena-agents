import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gradeSample } from '../src/decision-eval/grade.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';

const { cases } = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/train/iron-sourcing.json', import.meta.url)));
const call = (name, args) => ({ name, args });
const verdict = (c, ...calls) => gradeSample(c, { calls }).verdict;
const move = (p) => call('moveTo', { ...p, tolerance: 1, timeoutMs: 5000 });

test('iron sourcing starts with stone tools and no iron at eight distinct recorded moments', () => {
	assert.equal(cases.length, 8);
	assert.equal(new Set(cases.map(c => c.source.sourceMomentId)).size, 8);
	assert.equal(cases.filter(c => c.quick).length, 3);
	for (const c of cases) {
		const o = c.state.observation;
		assert.ok(o.inventory.items.some(i => i.itemId === 'minecraft:stone_pickaxe'));
		assert.ok(o.inventory.items.every(i => !/iron/.test(i.itemId)));
		assert.equal(o.currentAction.active, false);
		assert.equal(c.state.agent.taskPlan.steps.find(s => s.id === 'iron').status, 'active');
	}
});

test('exposed ore hard good requires the reachable observed cell, not merely an iron block name', () => {
	const c = cases[0];
	const ore = { x: -15, y: 68, z: 25, expectedBlockId: 'minecraft:iron_ore', timeoutMs: 5000 };
	const o = c.state.observation;
	assert.ok(o.blocks.some(b => b.blockId === ore.expectedBlockId && b.x === ore.x && b.y === ore.y && b.z === ore.z));
	assert.ok(Math.hypot(ore.x + 0.5 - o.position.x, ore.y + 0.5 - o.position.y - 1.62, ore.z + 0.5 - o.position.z) < 4.5);
	assert.equal(verdict(c, call('mine', ore)), 'good');
	assert.equal(verdict(c, call('mine', { ...ore, x: ore.x + 30 })), 'needs_judge');
	assert.equal(verdict(c, call('mine', { ...ore, expectedBlockId: 'minecraft:stone' })), 'needs_judge');
	assert.equal(verdict(c, call('sequence', { actions: [{ actionType: 'break_block', arguments: ore }, { actionType: 'wait', arguments: { durationMs: 1000 } }] })), 'needs_judge');
});

test('source approaches require real progress to the case coordinates without a blind descent', () => {
	for (const c of cases.filter(c => c.expect.good.some(p => p.approaches))) {
		const to = c.expect.good.find(p => p.approaches).approaches.to;
		const p = c.state.observation.position;
		const destination = { x: to.x, y: Math.floor(p.y), z: to.z };
		assert.equal(verdict(c, move(destination)), 'good', c.id);
		assert.equal(verdict(c, move(p)), 'needs_judge', `${c.id}: stationary`);
		assert.equal(verdict(c, move({ x: 2 * p.x - to.x, y: p.y, z: 2 * p.z - to.z })), 'needs_judge', `${c.id}: wrong direction`);
		assert.equal(verdict(c, move({ ...destination, y: p.y - 20 })), 'needs_judge', `${c.id}: unknown descent`);
	}
});

test('idle and digging underfoot are hard bad; reads alone require context', () => {
	for (const c of cases) {
		assert.equal(verdict(c), 'bad');
		assert.equal(verdict(c, call('wait', { durationMs: 1000 })), 'bad');
		const p = c.state.observation.position;
		const footing = call('mine', { x: Math.floor(p.x), y: Math.floor(p.y) - 1, z: Math.floor(p.z), timeoutMs: 5000 });
		assert.equal(verdict(c, footing), 'bad', c.id);
		for (const name of ['observe', 'lookAround', 'survey', 'exploreFrontier']) {
			assert.equal(verdict(c, call(name, {})), 'needs_judge', `${c.id}: ${name} alone`);
		}
	}
	// No known source: arbitrary movement alone cannot be certified as purposeful search.
	assert.equal(verdict(cases[5], move({ x: 50, y: 78, z: 20 })), 'needs_judge');
});

test('the actual rendered wake carries each derived source and the poor-yield history', async () => {
	for (const [index, needles] of [
		[1, ['iron_slope', '131,87,-218']],
		[4, ['village_east', 'smith chest', 'iron golem']],
		[6, ['unsearched_cave', '400 stone blocks', 'zero raw iron']],
		[7, ['iron_branch', '800 stone blocks', 'zero raw iron']],
	]) {
		const rendered = await renderWake(cases[index], { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' });
		for (const needle of needles) assert.ok(rendered.encodedInput.includes(needle), `${cases[index].id}: ${needle}`);
		assert.equal(rendered.replay.taskMemory.skipped, 0);
		assert.ok(rendered.replay.setupResults.every(r => ['APPLIED', 'SUCCEEDED'].includes(r.state)));
	}
});
