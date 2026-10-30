import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';
const corpus=JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/portal-casting.json',import.meta.url)));

test('captured portal decisions preserve raw observations and render conditional knowledge through production', async () => {
 validateCaseFile(corpus);
 assert.equal(new Set(corpus.cases.map(c=>c.source.sourceMomentId)).size,4);
 for (const [index,c] of corpus.cases.entries()) {
  assert.equal(observationSha256(c.state.observation),c.source.observationSha256);
  const rendered=await renderWake(c,{provider:'codex',model:'gpt-6.1-sol'});
  assert.equal(rendered.encodedInput.includes('Casting:'),index !== 2,'no current lava sight in the third moment');
  if(index!==2) assert.ok(rendered.encodedInput.includes('an empty bucket scoops it back'));
 }
});
