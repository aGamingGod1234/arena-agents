import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The live gate points this at modules extracted from the exact shipping jar.
const src = process.env.ARENA_CONTRACT_MODULE_ROOT ?? fileURLToPath(new URL('../src/', import.meta.url));
const load = name => import(pathToFileURL(resolve(src, name)).href);
const { ReflexBook, normalizeReflexEntries } = await load('reflexes.mjs');
const { coveringRule } = await load('danger-contexts.mjs');
const { noteCombatDispatch, settleCombatResult, rememberEndCrystals, endCrystalFact } = await load('dragon-fight-facts.mjs');
const rule = { id: 'guard', when: { type: 'hostile_near', within: 8 }, do: { type: 'shield' }, ttlS: 1 };
const normalized = normalizeReflexEntries([rule]);
const danger = { kind: 'melee', mobs: ['zombie'] };

for (const why of ['ttl reached', 'maxFirings reached', 'until condition holds']) {
 test(`server expiry (${why}) retires definition, coverage and later payload`, () => {
  const book = new ReflexBook();
  book.apply('a', normalized);
  const sent = book.payload('a');
  book.observe('a', { revision: sent.revision, rules: [{ id: 'guard', state: 'armed', fired: 0, expiresInS: 1 }], events: [] });
  assert.equal(coveringRule(danger, book.rules('a')), 'guard');
  book.observe('a', { revision: sent.revision, rules: [], events: [{ seq: 1, id: 'guard', outcome: 'expired', detail: why, ms: 0, wake: false }] });
  assert.deepEqual(book.list('a'), []);
  assert.equal(coveringRule(danger, book.rules('a')), null);
  assert.match(book.takeReport('a'), /none armed; expired: guard/);
  book.apply('a', normalizeReflexEntries([{ id: 'other', when: { type: 'on_fire' }, do: { type: 'stop' } }]));
  assert.deepEqual(book.payload('a').rules.map(r => r.id), ['other']);
 });
}

test('a missing expiry event still reconciles an acknowledged absent rule', () => {
 const book = new ReflexBook(); book.apply('a', normalized); const p = book.payload('a');
 book.observe('a', { revision: p.revision, rules: [], events: [] });
 assert.equal(book.has('a'), false); assert.match(book.takeReport('a'), /expired: guard/);
});

test('delayed expiry from an older revision cannot remove a deliberate replacement', () => {
 const book = new ReflexBook(); book.apply('a', normalized); const old = book.payload('a');
 book.apply('a', normalizeReflexEntries([{ ...rule, ttlS: 10 }]));
 book.observe('a', { revision: old.revision, rules: [], events: [{ seq: 1, id: 'guard', outcome: 'expired', detail: 'ttl reached' }] });
 assert.equal(book.payload('a').rules.length, 1);
});

test('pending and physically unavailable rules do not claim danger coverage', () => {
 for (const patch of [{ state: 'pending' }, { state: 'expired' }, { state: 'disabled' }, { state: 'armed', lacks: 'no shield in either hand' }])
  assert.equal(coveringRule(danger, [{ ...normalized[0], ...patch }]), null);
});

for (const [message, state, own] of [
 ['Your arrow: the target broke or died while your arrow was still 12.0 blocks from it (something else did it)', 'SUCCEEDED', false],
 ['Your arrow: you lost sight of it; impact not confirmed', 'SUCCEEDED', false],
 ['Your arrow: it struck the target, which broke or died', 'SUCCEEDED', true],
 ['Your arrow: it struck the target, which broke or died', 'FAILED', false],
]) test(`crystal own-hit attribution: ${state} ${message}`, () => {
 const memory = {};
 rememberEndCrystals(memory, { world: { dimension: 'minecraft:the_end' }, entities: [{ stableId: 'crystal', type: 'minecraft:end_crystal', alive: true, x: 0, y: 70, z: 0 }] });
 noteCombatDispatch(memory, 'shot', 'use_ranged', { targetId: 'crystal' });
 settleCombatResult(memory, { actionId: 'shot', state, message });
 assert.equal(memory.brokenTargets?.has('crystal') === true, own);
 assert.equal(memory.endCrystals.get('crystal').broken, own);
 assert.match(endCrystalFact({ standing: [], broken: own ? 1 : 0 }), new RegExp(`${own ? 1 : 0} broken by your own hits`));
});
