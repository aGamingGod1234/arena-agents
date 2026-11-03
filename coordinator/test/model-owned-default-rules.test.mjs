import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_REFLEXES, ReflexBook, normalizeReflexEntries } from '../src/reflexes.mjs';

const live = { world: { dimension: 'minecraft:overworld' }, player: { health: 20 } };

test('wire ownership follows the book, including identical replacements and custom default-prefix rules', () => {
	const book = new ReflexBook();
	book.observeContext('a', live);
	assert.ok(book.payload('a').rules.every(rule => rule.coordinatorDefault === true));
	const arrow = DEFAULT_REFLEXES.find(rule => rule.id === 'default-arrow');
	const { ttlMs, ...definition } = arrow;
	book.apply('a', normalizeReflexEntries([
		{ ...definition, ttlS: ttlMs / 1000 },
		{ id: 'default-fire', when: { type: 'in_fire' }, do: { type: 'place', item: 'water_bucket', where: 'below' }, wake: true },
		{ id: 'default-custom', when: { type: 'night' }, do: { type: 'shield' }, wake: true },
	]));
	book.observeContext('a', { ...live, world: { dimension: 'minecraft:the_nether' } });
	const rules = book.payload('a').rules;
	for (const id of ['default-arrow', 'default-fire', 'default-custom']) {
		assert.equal(rules.find(rule => rule.id === id).coordinatorDefault, undefined, id);
	}
	assert.equal(rules.find(rule => rule.id === 'default-fire').wake, true);
	assert.equal(rules.find(rule => rule.id === 'default-eat').coordinatorDefault, true);
	book.apply('a', normalizeReflexEntries([{ id: '*', remove: true }]));
	assert.ok(!book.payload('a').rules.some(rule => rule.id === 'default-custom'));
	assert.ok(book.payload('a').rules.every(rule => rule.coordinatorDefault === true));
});

test('the model cannot set coordinator ownership', () => {
	assert.throws(() => normalizeReflexEntries([
		{ id: 'default-custom', when: { type: 'night' }, do: { type: 'shield' }, coordinatorDefault: true },
	]), /coordinatorDefault/);
});
