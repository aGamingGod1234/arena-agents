import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';

// Recorded d13/d14 iron games: the wake before a detour off the Nether route (drift-0x) and 10+ minutes into one
// (drift-1x). drift.json carries the recorded plan; drift-fine.json the same moments with a translator stage plan.
const load = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/decision-eval/extra/${name}`, import.meta.url)));
const recorded = load('drift.json'), fine = load('drift-fine.json');

test('drift cases pair recorded moments with the recorded plan and with a stage plan', () => {
 validateCaseFile(recorded); validateCaseFile(fine);
 assert.deepEqual(recorded.cases.map(c => c.id), fine.cases.map(c => c.id));
 for (const [index, c] of recorded.cases.entries()) {
  const f = fine.cases[index];
  assert.equal(c.source.observationSha256, observationSha256(c.state.observation));
  assert.deepEqual(f.state.observation, c.state.observation);
  assert.equal(f.expect.judge.rubric, c.expect.judge.rubric);
  assert.ok(f.state.agent.taskPlan.steps.some(s => s.check === 'y<=-50') && f.state.agent.taskPlan.steps.some(s => s.check === 'frame:10'));
 }
});

test('the stage plan renders sub-step facts, and 10+ minutes into a detour the progress fact', async () => {
 for (const c of fine.cases) {
  const r = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' });
  const now = JSON.parse(r.input.slice(r.input.indexOf('\n') + 1)).now;
  if (c.id === 'drift-02') assert.match(now.plan, /intent pool\[unmet:still lava sources seen 0\/10/);
  if (c.id >= 'drift-10') assert.match(now.progress, /no plan step completed or measurably closer for 1[01] min/);
 }
});
