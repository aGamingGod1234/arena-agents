import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';
import { howtoIndex } from '../src/howto.mjs';
import { gradeSample } from '../src/decision-eval/grade.mjs';

const { cases } = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/extra/n18-ironpick.json', import.meta.url)));
const count = (c, id) => c.state.observation.inventory.items.filter(i => i.itemId === `minecraft:${id}`).reduce((n, i) => n + i.count, 0);

test('ironpick cases retain capture provenance and explicitly document action-boundary and inventory variants', () => {
 validateCaseFile(cases);
 assert.equal(cases.length, 6);
 assert.equal(new Set(cases.map(c => c.source.sourceMomentId)).size, 3);
 for (const c of cases) {
  const source = c.source.derived.from;
  assert.ok(c.source.derived.edits.length > 0);
  assert.equal(c.source.observationSha256, observationSha256(c.state.observation));
  assert.equal(c.source.sourceMomentId, `sm-${createHash('sha256').update(`${source.trace}\n${source.observationSha256}`).digest('hex').slice(0, 16)}`);
  assert.equal(c.state.observation.currentAction.active, false);
  for (const section of ['Good:', 'Bad:', 'Neutral:']) assert.ok(c.expect.judge.rubric.includes(section));
  assert.equal(gradeSample(c, { calls: [{ name: 'finish', args: {} }] }).verdict, 'bad');
 }
 assert.deepEqual(cases.map(c => count(c, 'iron_ingot')), [4, 3, 4, 0, 3, 3]);
 assert.equal(count(cases[4], 'stick'), 0);
 assert.equal(count(cases[4], 'oak_planks'), 2);
 assert.equal(count(cases[5], 'iron_pickaxe'), 1);
});

test('the recorded fuel deficit cannot finish a pickaxe by burning its required sticks', () => {
 const c = cases[3], fuels = howtoIndex().fuels;
 assert.equal(count(c, 'raw_iron'), 4);
 assert.equal(count(c, 'stick'), 2);
 assert.equal(count(c, 'oak_planks'), 1);
 assert.equal(count(c, 'wooden_pickaxe'), 1);
 assert.equal(fuels.oak_planks / 200, 1.5);
 assert.equal(fuels.wooden_pickaxe / 200, 1);
 assert.equal(fuels.stick / 200, 0.5);
 assert.equal(fuels.coal / 200, 8);
 assert.equal((fuels.oak_planks + fuels.wooden_pickaxe) / 200, 2.5);
 assert.equal(count(c, 'coal'), 0);
});

test('ironpick variants keep inventory menu mirrors consistent', () => {
 for (const c of cases) {
  const o = c.state.observation, menu = o.interaction.menu;
  const size = menu.slotCount - 36, selected = o.interaction.input.selectedSlot;
  for (const slot of menu.slots) {
   const index = slot.slot - size;
   const playerMenu = menu.containerId === 0 || menu.type === 'minecraft:inventory';
   if (!playerMenu && index < 0) continue;
   let key = playerMenu ? ({ 5: 'head', 6: 'chest', 7: 'legs', 8: 'feet', 45: 'offhand' }[slot.slot]
    ?? (slot.slot >= 9 && slot.slot <= 35 ? slot.slot : slot.slot >= 36 && slot.slot <= 44 ? slot.slot - 36 : undefined))
    : index < 27 ? index + 9 : index - 27;
   if (key === undefined) continue;
   if (key === selected) key = 'mainhand';
   const item = o.inventory.items.find(i => i.slot === key);
   assert.equal(slot.itemId, item?.itemId ?? 'minecraft:air', `${c.id}: slot ${slot.slot}`);
   assert.equal(slot.count, item?.count ?? 0, `${c.id}: slot ${slot.slot}`);
  }
 }
});

test('every ironpick case reaches a production wake with its actual capability gaps', async () => {
 for (const c of cases) {
  const rendered = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol' });
  assert.ok(rendered.replay.setupResults.every(r => r.state === 'APPLIED'));
  assert.deepEqual(rendered.replay.unreplayed, []);
  const input = JSON.parse(rendered.input.slice(rendered.input.indexOf('\n') + 1));
  if (c.id === 'n18-ironpick-05') {
   assert.match(input.now.plan, /stick 0\/2/);
   assert.match(input.now.craft, /bucket/);
  } else if (c.id === 'n18-ironpick-06') {
   assert.doesNotMatch(input.now.plan, /pickaxe missing/);
   assert.match(input.now.craft, /bucket/);
  } else if (count(c, 'iron_ingot') >= 3) assert.match(input.now.craft, /iron_pickaxe/);
 }
});
