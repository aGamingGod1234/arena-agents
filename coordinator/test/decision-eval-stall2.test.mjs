import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';

const files = ['source', 'route', 'iron'].map(name => JSON.parse(fs.readFileSync(new URL(`./fixtures/decision-eval/extra/stall2-${name}.json`, import.meta.url))));
const cases = files.flatMap(file => file.cases);

test('stall2 families retain distinct source moments, explicit variants and complete grading rubrics', () => {
  validateCaseFile(cases);
  for (const file of files) {
    assert.equal(file.cases.length, 4);
    assert.ok(file.cases.every(c => c.family === file.family && c.causeClass === file.causeClass));
    assert.equal(new Set(file.cases.map(c => c.source.sourceMomentId)).size, 4);
  }
  for (const c of cases) {
    assert.equal(c.source.observationSha256, observationSha256(c.state.observation), c.id);
    const source = c.source.derived?.from ?? c.source;
    assert.equal(c.source.sourceMomentId, `sm-${createHash('sha256').update(`${source.trace}\n${source.observationSha256}`).digest('hex').slice(0, 16)}`);
    assert.ok(Number.isSafeInteger(source.line) && source.line > 0);
    assert.ok(source.protocolFile.startsWith('protocol.jsonl') || source.protocolFile === 'quality-protocol.jsonl');
    for (const part of ['Good:', 'Bad:', 'Neutral:']) assert.ok(c.expect.judge.rubric.includes(part), c.id);
    assert.ok(c.state.agent.recentResults.every(r => r.result.observedAtEpochMs <= c.state.observation.observedAtEpochMs), c.id);
    if (c.source.derived) assert.ok(c.source.derived.edits.length > 0);
  }
  assert.equal(cases.filter(c => c.source.derived).length, 4);
  assert.equal(cases.find(c => c.id === 'stall2-source-02').source.sourceMomentId, cases.find(c => c.id === 'stall2-iron-04').source.sourceMomentId);
});

test('stall2 capability variants preserve the distinction between held ingots and ore needing smelting', () => {
  const iron = files.find(f => f.family === 'stall2-iron').cases;
  const count = (c, id) => c.state.observation.inventory.items.filter(i => i.itemId === `minecraft:${id}`).reduce((n, i) => n + i.count, 0);
  assert.deepEqual(iron.map(c => count(c, 'iron_ingot')), [6, 3, 3, 0]);
  assert.equal(count(iron[1], 'iron_pickaxe'), 1);
  assert.equal(count(iron[3], 'raw_iron'), 3);
  for (const c of iron) {
    assert.equal(c.state.observation.currentAction.active, false);
    assert.equal(count(c, 'bucket'), 0);
  }
});

test('stall2 production replay exposes authored failed-source memory and the still-burning successful escape', async () => {
  for (const id of ['stall2-source-03', 'stall2-route-04']) {
    const c = cases.find(c => c.id === id);
    const rendered = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol' });
    assert.equal(rendered.replay.taskMemory.skipped, 0);
    assert.ok(rendered.replay.taskMemory.written >= 6);
    assert.match(rendered.encodedInput, /178 breaks\/10m yielded only 1 iron/);
    if (id === 'stall2-route-04') {
      assert.equal(c.state.observation.player.onFire, true);
      assert.equal(c.state.observation.lastResult.reasonCode, 'DESTINATION_REACHED');
      assert.match(rendered.encodedInput, /"onFire":true/);
    }
  }
});
