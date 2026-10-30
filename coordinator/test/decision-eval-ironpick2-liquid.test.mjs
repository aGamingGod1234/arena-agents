import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';

const { cases } = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/extra/n18-ironpick2-liquid.json', import.meta.url)));

test('liquid-context cases preserve two recorded dry idle moments and disclose reconstruction limits', () => {
 validateCaseFile(cases);
 assert.equal(cases.length, 2);
 assert.equal(new Set(cases.map(c => c.source.trace)).size, 2);
 for (const c of cases) {
  assert.equal(c.source.observationSha256, observationSha256(c.state.observation));
  assert.equal(c.source.sourceMomentId, `sm-${createHash('sha256').update(`${c.source.trace}\n${c.source.observationSha256}`).digest('hex').slice(0, 16)}`);
  assert.equal(c.state.observation.currentAction.active, false);
  assert.equal(c.state.observation.player.onGround, true);
  assert.equal(c.state.observation.player.inWater, false);
  assert.equal(c.state.agent.goal, 'Get an iron pickaxe.');
  assert.match(c.source.agentState, /not reconstructed/);
 }
});

test('recorded ore and cave liquid context reaches the production model input', async () => {
 for (const c of cases) {
  const r = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
  const data = JSON.parse(r.input.slice(r.input.indexOf('\n') + 1));
  assert.match(data.now.options, /water seen nearby/);
  assert.equal(r.replay.unreplayed.length, 0);
 }
});
