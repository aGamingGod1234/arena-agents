import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildNativeEventInput } from '../dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../model-fact-encoding.mjs';

// Defaults to the reconstructed Nether fixture; no provider or game is started by this measurement.
const fixture = process.argv[2] ? pathToFileURL(process.argv[2]).href : new URL('./fixtures/nether-fixture.mjs', import.meta.url).href;
const { decorated, record, TASK_MEMORY } = await import(fixture);
const measure = (count, replay) => {
 const views = new ModelObservationViews(), rows = [];
 for (let step = 0; step < count; step++) {
  // Owner-shaped reconstruction, not a recording: rotations, eating and health changes.
  if (replay && step > 0 && step % 5 === 0) views.reset();
  const observation = decorated(step);
  if (replay) {
   observation.player.health = step < 6 ? 20 : step < 10 ? 8 : 14;
   const food = observation.inventory.items.find(row => row.itemId === 'minecraft:cooked_beef');
   if (food) food.count = 23 - Math.floor(step / 7);
  }
  const input = buildNativeEventInput(record, { event: 'observation', trigger: 'threat', eventSequence: 200 + step,
   taskMemory: TASK_MEMORY, observation });
  const encoded = encodeNativeEventInput(input, views);
  const payload = decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n') + 1)));
  rows.push({ step, rawBytes: Buffer.byteLength(input), encodedBytes: Buffer.byteLength(encoded),
   mode: payload.observationView?.mode ?? 'unavailable', blocks: JSON.parse(input.slice(input.indexOf('\n') + 1)).observation.blocks.length });
 }
 const mean = values => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
 return { firstBytes: rows[0].encodedBytes, meanBytes: mean(rows.map(row => row.encodedBytes)),
  steadyBytes: mean(rows.slice(1).map(row => row.encodedBytes)), rows };
};
const result = { fixture: measure(8, false), ownerShaped: measure(19, true),
 method: 'Real adaptObservation, composeTwoCallView, event builder and encoder; archived fixture tags. Owner-shaped reconstruction with five-wake context resets, health and inventory changes; not exact event replay. Bytes measured; token/hour conversions are estimates.' };
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
