import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderWake } from '../src/decision-eval/render.mjs';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';

const cases = validateCaseFile(JSON.parse(await readFile(new URL('./fixtures/decision-eval/extra/work-safety.json', import.meta.url))));

test('recorded work hazards render with their existing authored protection and escape facts', async () => {
 for (const c of cases) {
  const rendered = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
  assert.ok(rendered.replay.setupResults.some(r => r.state === 'REFLEXES'), c.id);
  for (const rule of c.state.agent.reflexes) assert.ok(rendered.input.includes(rule.id), `${c.id}: ${rule.id}`);
  if (c.id === 'ws-wall') assert.match(rendered.input, /suffocat|solid block/);
  if (['ws-deep-water', 'ws-shallow-water'].includes(c.id)) assert.match(rendered.input, /breathable|surface/);
  if (c.id.includes('skeleton')) assert.match(rendered.input, /minecraft:skeleton/);
  assert.equal(rendered.replay.unreplayed.filter(x => !x.startsWith('recentResults:')).length, 0, c.id);
 }
});
