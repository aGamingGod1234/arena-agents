import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_REFLEXES, MAX_REFLEXES, ReflexBook, normalizeReflexEntries } from '../src/reflexes.mjs';

const OVERWORLD = 'minecraft:overworld', NETHER = 'minecraft:the_nether';
const live = (dimension = OVERWORLD) => ({ world: { dimension }, player: { health: 20 } });
const dead = () => ({ player: { dead: true }, status: 'PLAYER_DEAD' });
const ids = (book) => book.list('a').map((row) => `${row.id}${row.default ? '*' : ''}`);
const FIRE = { id: 'burn', when: { type: 'on_fire' }, do: { type: 'leave_fire' } };

test('the default survival rules arm at spawn as canonical rules the mod accepts', () => {
	const book = new ReflexBook();
	assert.equal(book.observeContext('a', { ready: false }), false, 'no arming before a live sample');
	assert.equal(book.observeContext('a', live()), true, 'spawn arms them');
	assert.deepEqual(ids(book), ['default-lava*', 'default-fire*', 'default-air*', 'default-edge*']);
	const sent = book.payload('a');
	assert.equal(sent.revision, 1);
	// The defaults pass the same validation as a model's rules.
	assert.deepEqual(sent.rules, normalizeReflexEntries(DEFAULT_REFLEXES.map(({ ttlMs, ...rule }) => ({ ...rule, ttlS: ttlMs / 1_000 }))));
	assert.equal(book.observeContext('a', live()), false, 'an unchanged context sends nothing');
	assert.match(book.takeReport('a'), /^armed default-lava, default-fire, default-air, default-edge\(stance\)$/, 'the wake lists them by id, without their definitions');
});

test('the model switches a default off by id until the next respawn or dimension change; "*" removes only its own rules', () => {
	const book = new ReflexBook();
	book.observeContext('a', live());
	book.apply('a', normalizeReflexEntries([{ id: 'default-edge', remove: true }, FIRE]));
	assert.deepEqual(ids(book), ['default-lava*', 'default-fire*', 'default-air*', 'burn']);
	assert.equal(book.observeContext('a', live()), false, 'switched off stays off in the same context');
	book.apply('a', normalizeReflexEntries([{ id: '*', remove: true }]));
	assert.deepEqual(ids(book), ['default-lava*', 'default-fire*', 'default-air*'], '"*" leaves the defaults');
	assert.equal(book.observeContext('a', live(NETHER)), true, 'a dimension change arms the defaults again');
	assert.deepEqual(ids(book), ['default-lava*', 'default-fire*', 'default-air*', 'default-edge*']);
	book.apply('a', normalizeReflexEntries([{ id: 'default-air', remove: true }]));
	assert.equal(book.observeContext('a', dead()), false);
	assert.equal(book.observeContext('a', live(NETHER)), true, 'a respawn arms the defaults again');
	assert.ok(ids(book).includes('default-air*'));
});

test('a default the model replaces by id is its own rule and is not overwritten; defaults do not use the rule allowance of the model', () => {
	const book = new ReflexBook();
	book.observeContext('a', live());
	book.apply('a', normalizeReflexEntries([{ id: 'default-lava', priority: 9, when: { type: 'lava_flowing', withinS: 4 }, do: { type: 'leave_lava' } }]));
	book.observeContext('a', live(NETHER));
	const lava = book.rules('a').find((rule) => rule.id === 'default-lava');
	assert.equal(lava.when[0].type, 'lava_flowing', 'the model\'s replacement survives a dimension change');
	assert.equal(book.list('a').find((row) => row.id === 'default-lava').default, undefined);
	// default-lava is now the model's own: 11 more fill its 12.
	book.apply('a', normalizeReflexEntries(Array.from({ length: MAX_REFLEXES - 1 }, (_, index) => ({ ...FIRE, id: `own-${index}` }))));
	assert.equal(book.payload('a').rules.length, MAX_REFLEXES + 3);
	assert.throws(() => book.apply('a', normalizeReflexEntries([{ ...FIRE, id: 'one-more' }])), /At most 12 reflexes of your own besides the default rules/);
});

test('a default the mod reports expired is armed again on the next sample', () => {
	const book = new ReflexBook();
	book.observeContext('a', live());
	const revision = book.payload('a').revision;
	const rows = ['default-fire', 'default-air', 'default-edge'].map((id) => ({ id, kind: 'trigger', state: 'armed', fired: 0, expiresInS: 3_000 }));
	book.observe('a', { revision, rules: rows, events: [{ seq: 1, id: 'default-lava', outcome: 'expired', ms: 0, detail: 'ttl reached' }] });
	assert.ok(!ids(book).includes('default-lava*'));
	assert.equal(book.observeContext('a', live()), true);
	assert.ok(ids(book).includes('default-lava*'));
});
