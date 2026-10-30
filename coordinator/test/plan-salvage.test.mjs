import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalSpecTranslator } from '../src/goal-spec-translator.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';

const request = { requestId: '00000000-0000-4000-8000-000000000001', originalRequest: 'Gather logs', candidateIds: ['minecraft:oak_log'] };
const step = (id, dependsOn = [], detail = '') => ({ id, label: id, kind: 'inventory', status: 'pending', dependsOn, detail, check: 'has:minecraft:oak_log*4', evidence: null });
const translate = (steps, traces = []) => new GoalSpecTranslator({
	generate: async () => ({ requestId: request.requestId, summary: 'Gather logs', predicate: { type: 'inventory_contains', itemId: 'minecraft:oak_log', count: 4 }, plan: { steps } }),
	trace: (event, fields) => traces.push({ event, ...fields }),
}).translate(request);

test('mutual-cycle cuts agree in both listing orders and keep missing logs open', async () => {
	const logs = step('logs', ['planks']);
	const planks = { ...step('planks', ['logs']), check: 'has:minecraft:oak_planks*4' };
	const dependencies = [];
	for (const steps of [[logs, planks], [planks, logs]]) {
		const traces = [];
		const { plan } = await translate(steps, traces);
		dependencies.push(Object.fromEntries(plan.steps.map(s => [s.id, s.dependsOn])));
		assert.equal(traces.filter(t => t.event === 'goal_plan_step_degraded').length, 2);
		const record = { agentId: 'cycle', currentGoal: 'Gather logs', goalRevision: 1 };
		const views = new LiveTaskViews(); views.suggest(record.agentId, record.currentGoal, plan);
		await views.observe(record, { ready: true, observedAtEpochMs: 1000, player: { dead: false, health: 20, x: 0, y: 64, z: 0 }, world: { worldId: 'cycle-world', dimension: 'minecraft:overworld' }, inventory: { items: [{ itemId: 'minecraft:oak_planks', count: 4, slot: 1 }] }, blocks: [] });
		assert.match(views.progress(record), /open logs\[howto:oak_log 0\/4\]/);
		assert.doesNotMatch(views.progress(record), /skipped logs/);
	}
	assert.deepEqual(dependencies, [{ logs: [], planks: [] }, { planks: [], logs: [] }]);
});

test('a three-cycle cuts every cyclic edge and preserves its downstream dependency', async () => {
	const { plan } = await translate([step('a', ['b']), step('b', ['c']), step('c', ['a']), step('tail', ['c'])]);
	assert.deepEqual(plan.steps.map(s => s.dependsOn), [[], [], [], ['c']]);
});

test('aggregate step count keeps the usable prefix and removes dependencies on the dropped tail', async () => {
	const traces = [], steps = Array.from({ length: 49 }, (_, i) => step(`s${i}`));
	steps[0].dependsOn = ['s48'];
	const { plan } = await translate(steps, traces);
	assert.equal(plan.steps.length, 48);
	assert.deepEqual(plan.steps, steps.slice(0, 48).map((s, i) => i === 0 ? { ...s, dependsOn: [] } : s));
	assert.ok(traces.some(t => t.event === 'goal_plan_step_dropped' && t.stepId === 's48' && /48/.test(t.reason)));
	assert.ok(!traces.some(t => t.event === 'goal_plan_invalid'));
});

test('aggregate bytes keep unchanged usable steps below 12 KiB and remove dangling dependencies', async () => {
	const traces = [], steps = Array.from({ length: 40 }, (_, i) => step(`s${i}`, [], 'Gather logs from an observed tree. '.repeat(6).slice(0, 200)));
	steps[0].dependsOn = ['s39'];
	assert.ok(Buffer.byteLength(JSON.stringify({ steps })) > 12_288);
	const { plan } = await translate(steps, traces);
	assert.ok(plan.steps.length > 0 && plan.steps.length < 40);
	assert.ok(Buffer.byteLength(JSON.stringify(plan)) <= 12_288);
	assert.deepEqual(plan.steps, steps.slice(0, plan.steps.length).map((s, i) => i === 0 ? { ...s, dependsOn: [] } : s));
	assert.ok(traces.some(t => t.event === 'goal_plan_step_dropped' && /12 KiB/.test(t.reason)));
	assert.ok(!traces.some(t => t.event === 'goal_plan_invalid'));
});

test('all-invalid steps return a valid completion goal without an empty advisory plan', async () => {
	const traces = [];
	const result = await translate([null, { ...step('invalid id!') }], traces);
	assert.ok(!Object.hasOwn(result, 'plan'));
	assert.equal(result.predicate.itemId, 'minecraft:oak_log');
	assert.equal(traces.filter(t => t.event === 'goal_plan_step_dropped').length, 2);
});
