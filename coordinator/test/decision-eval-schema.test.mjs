import assert from 'node:assert/strict';
import test from 'node:test';

import { DecisionEvalSchemaError, casePreviousObservations, validateCase, validateCaseFile, validatePredicate, validateSampleResult } from '../src/decision-eval/schema.mjs';

const baseCase = () => ({
	id: 'creeper-post-escape-03',
	family: 'creeper-post-escape',
	causeClass: 'threat-after-escape',
	split: 'train',
	source: { trace: 'pair2/B2/protocol.jsonl', atMs: 123456, note: 'PAIR2 B2' },
	state: {
		observation: { player: { x: 0, y: 64, z: 0, health: 12 }, entities: [{ type: 'minecraft:creeper', x: 3, y: 64, z: 0 }] },
		agent: { goal: 'make a wooden pickaxe', taskPlan: null, intent: null },
		wakeReason: 'threat',
	},
	steps: [{ canned: [{ when: { tool: 'moveTo' }, result: { state: 'FAILED', reasonCode: 'PATH_BLOCKED' } }] }],
	expect: {
		good: [{ tool: ['moveTo', 'control'], awayFrom: { position: 'threat', minDistance: 4 }, index: 0 }],
		bad: [{ tool: 'mine', index: 'first' }, { not: { any: [{ tool: 'moveTo' }, { none: true }] } }],
		judge: null,
		threshold: 0.67,
	},
});

test('a complete case validates and keeps its shape', () => {
	const value = baseCase();
	assert.equal(validateCase(value), value);
	assert.deepEqual(validateCaseFile({ cases: [value] }), [value]);
});

test('matchers cover equality, regex, ranges, membership, presence and negation', () => {
	validatePredicate({ args: { x: 3, 'target.type': { regex: '^minecraft:', flags: 'i' }, y: { gte: 60, lt: 70 }, item: { in: ['a', 'b'] }, tags: { contains: 'x' }, slot: { exists: false }, kind: { not: { eq: 'wait' } } } });
	validatePredicate({ normalized: { kind: 'action', actionType: { in: ['navigate_to', 'flee_from'] } } });
	validatePredicate({ targetsEntity: ['minecraft:zombie'], usesItem: 'minecraft:bread' });
});

test('v1.2 accepts the grade engine extension keys, matchers and wildcard paths', () => {
	validatePredicate({ tool: 'sequence', args: { 'actions.*.actionType': 'flee_from' }, index: -1 });
	validatePredicate({ action: ['flee_from', 'navigate_to'], actionArgs: { distance: { range: [8, null] } }, index: 'every' });
	validatePredicate({ movesAway: { from: 'nearestHostile', minDistance: 4, minFinalDistance: 8 }, approaches: { to: { entityType: 'minecraft:cow' } } });
	validatePredicate({ usesItem: 'food', placesBlock: { tag: '#minecraft:logs' }, breaksBlock: { regex: '_ore$' }, waits: false, noBodyAction: false, bodyAction: true });
	validatePredicate({ tool: 'act', count: { min: 1, max: 2 }, args: { actionType: { anyOf: ['eat', { regex: '^use_' }] } } });
	assert.throws(() => validatePredicate({ waits: 'yes' }), /waits/);
	assert.throws(() => validatePredicate({ count: { atLeast: 1 } }), /count/);
	assert.throws(() => validatePredicate({ usesItem: { edible: true } }), /unknown item spec key/);
	assert.throws(() => validatePredicate({ args: { 'a.**': 1 } }), /path/);
});

test('invalid shapes name the failing path', () => {
	const cases = [
		[(c) => { c.split = 'test'; }, /split/],
		[(c) => { delete c.state.observation; }, /state\.observation/],
		[(c) => { c.state.agent.goal = ' '; }, /agent\.goal/],
		[(c) => { c.expect.good[0].index = 1.5; }, /index/],
		[(c) => { c.expect.good[0].bogus = 1; }, /unknown predicate key 'bogus'/],
		[(c) => { c.expect.bad[0] = { args: { x: { between: 1 } } }; }, /unknown matcher key 'between'/],
		[(c) => { c.expect.bad[0] = { args: { x: { regex: '(' } } }; }, /regex/],
		[(c) => { c.steps[0].canned[0].result = 'ok'; }, /recorded tool result/],
		[(c) => { c.expect = { threshold: 0.5 }; }, /needs good or bad predicates/],
		[(c) => { c.expect.threshold = 2; }, /0\.\.1/],
		[(c) => { c.expect.good[0].awayFrom = { position: 'there', minDistance: 1 }; }, /awayFrom\.position/],
	];
	for (const [mutate, pattern] of cases) {
		const value = baseCase();
		mutate(value);
		assert.throws(() => validateCase(value), (error) => error instanceof DecisionEvalSchemaError && pattern.test(error.message), String(pattern));
	}
	assert.throws(() => validateCaseFile([baseCase(), baseCase()]), /duplicate case id/);
});

test('previous observations accept the single and list forms', () => {
	const value = baseCase();
	assert.deepEqual(casePreviousObservations(value), []);
	value.state.previousObservation = { player: { x: 1 } };
	assert.deepEqual(casePreviousObservations(value), [{ player: { x: 1 } }]);
	value.state.previousObservations = [{ player: { x: 2 } }];
	assert.deepEqual(casePreviousObservations(value), [{ player: { x: 2 } }]);
});

test('sample results validate their call list and stop reason', () => {
	const row = { schemaVersion: 1, kind: 'decision-eval-sample', caseId: 'a', sample: 0, calls: [{ index: 0, name: 'moveTo', args: { x: 1 } }], stop: 'script_end', grade: null };
	assert.equal(validateSampleResult(row), row);
	assert.throws(() => validateSampleResult({ ...row, stop: 'done' }), /stop/);
	assert.throws(() => validateSampleResult({ ...row, calls: [{ index: 1, name: 'x', args: {} }] }), /calls\[0\]/);
});

test('a top-level threshold is rejected even when it equals expect.threshold', () => {
	for (const threshold of [0.67, 0.6]) {
		assert.throws(() => validateCase({ ...baseCase(), threshold }), /expect\.threshold/);
	}
});
