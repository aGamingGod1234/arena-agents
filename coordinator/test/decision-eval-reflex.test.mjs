import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderWake } from '../src/decision-eval/render.mjs';
import { validateCaseFile, validateCase } from '../src/decision-eval/schema.mjs';

const cases = validateCaseFile(JSON.parse(await readFile(new URL('./fixtures/decision-eval/extra/rx-setup.json', import.meta.url))));

test('reflex setup cases render through production with their authored intent', async () => {
 for (const c of cases) {
  const rendered = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
  assert.match(rendered.input, new RegExp(c.state.agent.intent.step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(rendered.replay.setupResults.every(r => ['SUCCEEDED', 'REFLEXES'].includes(r.state)), c.id);
 }
});

test('prior reflexes and firing failures reach the maintenance wake through production setup', async () => {
 for (const id of ['rx-armed', 'rx-adjust']) {
  const rendered = await renderWake(cases.find(c => c.id === id));
  assert.match(rendered.input, /armed fortress-cover\(stance\)/);
  assert.match(rendered.input, id === 'rx-armed' ? /blocked 3 hit/ : /no shield equipped/);
  assert.ok(rendered.replay.setupResults.some(r => r.state === 'REFLEXES'));
 }
});

test('prior reflex state rejects malformed containers and invalid production rules', async () => {
 const c = structuredClone(cases[0]);
 c.state.agent.reflexes = {};
 assert.throws(() => validateCase(c), /prior live-authored/);
 c.state.agent.reflexes = [{ id: 'bad', when: { type: 'magic' }, do: { type: 'fly' } }];
 await assert.rejects(renderWake(c), /prior reflexes rejected/);
});
