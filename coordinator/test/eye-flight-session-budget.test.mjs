import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { representativeRecord, representativeProgramWake } from '../src/benchmark/token-budget.mjs';
import { ModelObservationViews, encodeNativeEventInput, decodeModelFacts } from '../src/model-fact-encoding.mjs';

const baseline = JSON.parse(await readFile(new URL('./fixtures/eye-flight-twelve-throws-baseline.json', import.meta.url), 'utf8'));
// Sol's advancing tape has one wake per throw, 35 seconds apart. Previous
// flight evidence expires between throws; no quiet wakes amortize the cost.
function throwWake(i, variant) {
  const wake = representativeProgramWake(i + 1);
  if (variant === 'new-decisions') wake.status.decision.decisionId = `native-program-fixture-12:decision-${i + 3}`;
  if (variant === 'no-program') {
    wake.event = 'observation'; wake.trigger = 'perception_changed'; delete wake.programId; delete wake.status;
  }
  const from = { x: 100.5 + i * 100, y: 65.5, z: -20.5 - i * 60 };
  const outcome = [4, 9].includes(i) ? 'shattered' : 'dropped';
  const yaw = -135 + i * 3;
  const radians = yaw * Math.PI / 180;
  const to = { x: from.x - Math.sin(radians) * 11.3, y: from.y + (i === 11 ? -8 : 8), z: from.z + Math.cos(radians) * 11.3 };
  const event = { type: 'eye_of_ender_flight', flightId: 400 + i, sequence: 20 + i,
   gameTime: 4000 + i * 700, observedAtEpochMs: 200000 + i * 35000,
   dimension: 'minecraft:overworld', from, to, yaw, flewBlocks: 11.3,
   vertical: i === 11 ? 'sank' : 'rose', outcome,
   ...(outcome === 'dropped' ? { droppedAt: { ...to, y: 66 } } : {}) };
  wake.observation.observedAtEpochMs = event.observedAtEpochMs;
  Object.assign(wake.observation.player, from, { yaw, pitch: i === 11 ? 30 : -30 });
  const eye = { slot: 0, itemId: 'minecraft:ender_eye', count: 15 - (i > 4 ? 1 : 0) - (i > 9 ? 1 : 0) };
  wake.observation.inventory = { items: [eye], selectedItem: eye };
  wake.observation.interaction = { lookedAt: null, menu: null, hotbar: [eye], usingItem: false };
  wake.observation.blocks = []; wake.observation.entities = []; wake.observation.landmarks = [];
  wake.observation.items = outcome === 'dropped' ? [{ uuid: `eye-drop-${i}`, itemId: 'minecraft:ender_eye', count: 1, ...event.droppedAt, distance: 11.3 }] : [];
  wake.observation.coverage = { complete: true };
  wake.observation.lastResult = { actionId: `throw-${i}`, state: 'SUCCEEDED', reasonCode: 'ITEM_USED' };
  wake.observation.perception = { latestSequence: event.sequence, earliestSequence: event.sequence, events: [event], bossBars: [] };
  return { wake, event };
}

for (const [variant, expectedBase] of [['current-sequence', 20421], ['new-decisions', 20426], ['no-program', 16725]]) {
  test(`advancing twelve-throw ${variant} session stays below pinned base with last seen height`, () => {
    const base = baseline.variants[variant];
    assert.equal(base.total, expectedBase);
    assert.equal(base.bytes.reduce((sum, bytes) => sum + bytes, 0), expectedBase);
    assert.equal(base.bytes.length, 12);
    const views = new ModelObservationViews();
    let total = 0;
    for (let i = 0; i < 12; i++) {
      const { wake, event } = throwWake(i, variant);
      const input = encodeNativeEventInput(buildNativeEventInput(representativeRecord(), wake), views);
      total += Buffer.byteLength(input);
      const decoded = decodeModelFacts(JSON.parse(input.slice(input.indexOf('\n') + 1)));
      const content = decoded.observation ?? decoded.observationView.replace;
      const flights = Object.entries(content).filter(([key]) => /^eye[0-9]/.test(key));
      assert.equal(flights.length, 1, 'each throw delivers its own changed evidence');
      assert.equal(flights[0][0], `eye${event.flightId}`);
      assert.match(flights[0][1], new RegExp(event.outcome === 'dropped' ? 'drop[+@]' : 'broke'));
      assert.match(flights[0][1], new RegExp(`${event.yaw}/`));
      assert.match(flights[0][1], i === 11 ? / down@58 / : / up@74 /);
      if (i > 0) assert.ok(decoded.observationView.remove.includes(`eye${event.flightId - 1}`), 'expired prior throw is removed');
    }
    assert.ok(total <= expectedBase, `${variant}: base ${expectedBase}, head ${total}, saving ${expectedBase - total}`);
  });
}
