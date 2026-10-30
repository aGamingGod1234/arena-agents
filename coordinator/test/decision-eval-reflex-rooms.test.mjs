import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderWake } from '../src/decision-eval/render.mjs';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { observationSha256, sha256 } from '../src/decision-eval/capture.mjs';

const cases = validateCaseFile(JSON.parse(await readFile(new URL('./fixtures/decision-eval/extra/rx-teach2.json', import.meta.url))));

test('room first wakes retain raw provenance and distinguish visible threats from setup', async () => {
 const recorded = cases.filter(c => c.id.startsWith('rx2-'));
 assert.equal(recorded.length, 9);
 for (const c of recorded) {
  assert.equal(observationSha256(c.state.observation), c.source.observationSha256, c.id);
  assert.equal(c.source.sourceMomentId, 'sm-' + sha256(c.source.trace + '\n' + c.source.observationSha256).slice(0, 16));
  assert.equal(c.source.providerTurnLines.length, 1);
  const rendered = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
  assert.ok(rendered.input.includes(c.state.agent.goal), c.id);
  if (c.id.includes('creeper')) assert.match(rendered.input, /creeper/);
  if (c.id.endsWith('-threat')) assert.match(rendered.input, new RegExp(c.id.includes('ghast') ? 'ghast' : 'blaze'));
 }
});

test('the zero-score families replay both prior protection and firing reports', async () => {
 for (const id of ['rx-water', 'rx-pickaxe', 'rx-armed', 'rx-adjust']) {
  const c = cases.find(c => c.id === id);
  assert.ok(c);
  assert.ok(c.source.derived);
  const rendered = await renderWake(c);
  if (id === 'rx-armed') assert.match(rendered.input, /blocked 3 hit/);
  if (id === 'rx-adjust') assert.match(rendered.input, /no shield equipped/);
 }
});

test('recorded combat rules are installed before replaying their firing state', async () => {
 for (const [id, rule, report] of [
  ['rx2-combat-blaze-threat', 'shield-near', /shield-near/],
  ['rx2-combat-ghast-threat', 'ghast_shield', /no shield in either hand/],
 ]) {
  const c = cases.find(c => c.id === id);
  assert.ok(c.state.agent.reflexes.some(r => r.id === rule));
  assert.equal(c.source.reflexUpdateLines.length, 1);
  const rendered = await renderWake(c);
  assert.ok(rendered.replay.setupResults.some(r => r.state === 'REFLEXES'));
  assert.match(rendered.input, report);
 }
});
