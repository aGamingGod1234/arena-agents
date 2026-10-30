import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';

const corpus = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/extra/nether-route.json', import.meta.url)));

test('nether-route cases keep recorded moments from four 2026-10-19 games and the 2026-10-18 success', () => {
 validateCaseFile(corpus);
 assert.equal(corpus.cases.length, 12);
 assert.equal(new Set(corpus.cases.map(c => c.source.trace)).size, 5);
 for (const c of corpus.cases) {
  assert.equal(c.source.observationSha256, observationSha256(c.state.observation));
  assert.equal(c.source.sourceMomentId, `sm-${createHash('sha256').update(`${c.source.trace}\n${c.source.observationSha256}`).digest('hex').slice(0, 16)}`);
  assert.equal(c.state.observation.currentAction?.active === true, false);
  assert.ok(c.state.observation.inventory.items.some(item => item.itemId === 'minecraft:iron_pickaxe'));
  assert.ok(!c.state.observation.inventory.items.some(item => item.itemId === 'minecraft:obsidian'));
  assert.match(c.expect.judge.rubric, /y-55/);
 }
});

test('the Nether access options and recorded lava or portal leads reach the production wake', async () => {
 for (const c of corpus.cases) {
  const r = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' });
  const data = JSON.parse(r.input.slice(r.input.indexOf('\n') + 1));
  assert.match(data.now.options, /Nether access/);
  if (c.source.leadObservations.count > 0) assert.match(data.now.known, /ruined portal/);
 }
});

test('probe mode continues only through reads, setup and notes', async () => {
 const { probeCall, PROBE_RESULT } = await import('../src/decision-eval/runner.mjs');
 assert.equal(probeCall({ kind: 'capabilities', section: 'program' }), true);
 assert.equal(probeCall({ kind: 'reflexes', reflexes: [] }), true);
 assert.equal(probeCall({ kind: 'action', actionType: 'select_tool' }), true);
 assert.equal(probeCall({ kind: 'sequence', actions: [{ actionType: 'select_tool' }, { actionType: 'look_at' }] }), true);
 assert.equal(probeCall({ kind: 'sequence', actions: [{ actionType: 'select_tool' }, { actionType: 'break_block' }] }), false);
 assert.equal(probeCall({ kind: 'action', actionType: 'break_block' }), false);
 assert.equal(probeCall({ kind: 'action', actionType: 'navigate_to' }), false);
 assert.equal(PROBE_RESULT.reasonCode, 'DECISION_EVAL_PROBE');
});
