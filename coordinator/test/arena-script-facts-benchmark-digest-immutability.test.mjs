import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createInterpreterFacts } from '../src/arena-script/facts.mjs';

// Exercise the CLI's actual digest without running its timing loop on import.
const source = readFileSync(new URL('../src/benchmark/arena-script-facts-benchmark.mjs', import.meta.url), 'utf8');
const digestSource = source.slice(source.indexOf('function digestOf('), source.indexOf('\nconst cpuMs ='));
const digestOf = new Function(`${digestSource}\nreturn digestOf;`)();
const digest = (value) => {
	const hash = createHash('sha256');
	digestOf(hash, value);
	return hash.digest('hex');
};

test('facts digest distinguishes mutable and frozen arrays, including nested and empty arrays', () => {
	for (const entries of [[], [1, 2], [{ candidates: [1, 2] }]]) {
		assert.notEqual(digest(entries), digest(Object.freeze([...entries])));
		assert.equal(digest(Object.freeze([...entries])), digest(Object.freeze([...entries])));
	}
	assert.notEqual(digest({ candidates: [1, 2] }), digest({ candidates: Object.freeze([1, 2]) }));
});

test('facts digest includes array prototype metadata consistently with records', () => {
	for (const frozen of [false, true]) {
		const standard = [1, 2];
		const noPrototype = Object.setPrototypeOf([1, 2], null);
		if (frozen) { Object.freeze(standard); Object.freeze(noPrototype); }
		assert.notEqual(digest(standard), digest(noPrototype));
		assert.equal(digest(noPrototype), digest(noPrototype));
	}
});

test('facts digest detects a real interpreter candidate array becoming mutable', () => {
	const facts = createInterpreterFacts({});
	assert.ok(Object.isFrozen(facts.world.items));
	const mutableItems = [...facts.world.items];
	const world = Object.freeze(Object.assign(Object.create(Object.getPrototypeOf(facts.world)), facts.world, { items: mutableItems }));
	const regressed = Object.freeze(Object.assign(Object.create(Object.getPrototypeOf(facts)), facts, { world }));
	assert.deepEqual(regressed, facts);
	assert.equal(Object.isFrozen(regressed.world.items), false);
	assert.notEqual(digest(regressed), digest(facts));
});
