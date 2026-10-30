import assert from 'node:assert/strict';
import test from 'node:test';
import { MEASURED_SESSION, estimateHourlyTokens, measureTokenBudget, representativeProgramWake, representativeRecord } from '../src/benchmark/token-budget.mjs';
import { EVENT_BLOCK_DEFAULTS, buildNativeEventInput } from '../src/dynamic-main.mjs';
import { ModelObservationViews, decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';

const payload = (input) => decodeModelFacts(JSON.parse(input.slice(input.indexOf('\n') + 1)));


// The builder applies its budget before transposing the coverage labels for delivery.
const beforeCoveragePacking = value => {
 const copy = structuredClone(value), observation = copy.observation;
 if (observation.snapshotCounts) {
  observation.resultCoverage = Object.fromEntries(Object.entries(observation.snapshotCounts).map(([key, count]) => [key, {
   availableInSnapshot: count, ...(observation.omittedRows?.[key] === undefined ? {} : { omitted: observation.omittedRows[key] }),
  }]));
  delete observation.snapshotCounts;
  delete observation.omittedRows;
 }
 return copy;
};

test('a representative program wake stays inside its byte budget for every provider', () => {
	const sizes = measureTokenBudget();
	// Before: 15,759 raw bytes sent to Claude on every wake (Codex: 12,685 encoded).
	assert.ok(sizes.eventRawBytes <= 11_000, `raw event ${sizes.eventRawBytes} bytes`);
	assert.ok(sizes.eventEncodedFirstBytes <= 9_000, `first encoded event ${sizes.eventEncodedFirstBytes} bytes`);
	assert.ok(sizes.eventEncodedRepeatBytes <= 7_500, `repeat encoded event ${sizes.eventEncodedRepeatBytes} bytes`);
	assert.ok(sizes.eventEncodedRepeatBytes < sizes.eventEncodedFirstBytes / 2,
		`repeated wake event delta ${sizes.eventEncodedRepeatBytes} bytes vs full ${sizes.eventEncodedFirstBytes} bytes`);
	// 27,965 -> 29,106 bytes: the survey tool and lookAround's survey option (far sight) added 1,141 bytes.
	// 29,106 -> 30,073 bytes: travelTo, one call for a whole trip instead of a decision every few blocks.
	// 30,073 -> 30,364 bytes: digTo (claude/d31-dig) merged beside travelTo.
	// 30,364 -> 30,389 bytes: shaft and maxShaftY in the merged digTo signature (+25 B).
	// 30,822 -> 30,854 bytes: use_item and interact_block accept acceptLavaRisk (d41-portal LAVA_POUR_AT_BODY, +32 B).
	// 30,854 -> 30,898 bytes: use_ranged untilDead?/fleeAtHealth?/collect? and fight_target collect? (d41-ranged-loop, +44 B).
	// 30,898 -> 31,124 bytes: travel_to fightThrough (d41-resume, +226 B).
	// 31,124 -> 31,277 bytes: the fight_until action (d41-fight-until, +153 B).
	// 31,277 -> 31,950 bytes: cast_obsidian and barter_until (d41-cast-barter, +673 B).
	// 31,950 -> 32,195 bytes: fight_target/use_ranged count mode and fight_until roof (d41-fight-count, +245 B).
	// 32,195 -> 32,323 bytes: fight_target/use_ranged single and the plan-count act sentence (d41-blaze-survive, +128 B).
	assert.ok(sizes.toolSchemaBytes <= 32_323, `tool schemas ${sizes.toolSchemaBytes} bytes`);
});

test('unchanged goal, goalSpec and taskMemory are named instead of repeated within one provider context', () => {
	const record = representativeRecord();
	const views = new ModelObservationViews();
	const first = payload(encodeNativeEventInput(buildNativeEventInput(record, representativeProgramWake(1)), views));
	assert.ok(first.goalSpec && first.taskMemory);
	assert.equal(first.sameAsPreviousEvent, undefined);
	const second = payload(encodeNativeEventInput(buildNativeEventInput(record, representativeProgramWake(2)), views));
	assert.deepEqual(second.sameAsPreviousEvent, ['situation', 'goal', 'goalSpec', 'taskMemory']);
	assert.equal(second.conversation, undefined);
	assert.equal(second.goalSpec, undefined);
	assert.equal(second.goal, undefined, 'short fields are retained when their value exceeds the marker');

	const changed = representativeProgramWake(3);
	// A store revision alone is bookkeeping: it no longer defeats the omission.
	changed.taskMemory = { ...changed.taskMemory, revision: 42 };
	assert.deepEqual(payload(encodeNativeEventInput(buildNativeEventInput(record, changed), views)).sameAsPreviousEvent, ['situation', 'goal', 'goalSpec', 'taskMemory']);
	changed.taskMemory = { ...changed.taskMemory, lessons: [{ kind: 'lesson', key: 'lava', label: 'Lava', summary: 'Lava below the fortress bridge.' }] };
	const third = payload(encodeNativeEventInput(buildNativeEventInput(record, changed), views));
	assert.deepEqual(third.sameAsPreviousEvent, ['situation', 'goal', 'goalSpec', 'program']);
	assert.equal(third.taskMemory.lessons[0].key, 'lava');
	assert.equal(third.taskMemory.revision, undefined);

	views.reset();
	assert.equal(payload(encodeNativeEventInput(buildNativeEventInput(record, representativeProgramWake(4)), views)).sameAsPreviousEvent, undefined, 'a new provider context gets everything again');
	const nether = representativeProgramWake(5);
	nether.observation.world = { ...nether.observation.world, dimension: 'minecraft:the_nether' };
	assert.equal(payload(encodeNativeEventInput(buildNativeEventInput(record, nether), views)).sameAsPreviousEvent, undefined, 'another world identity is a new baseline');

	const failed = new ModelObservationViews();
	encodeNativeEventInput(buildNativeEventInput(record, representativeProgramWake(6)), failed);
	failed.forgetEventView();
	assert.equal(payload(encodeNativeEventInput(buildNativeEventInput(record, representativeProgramWake(7)), failed)).sameAsPreviousEvent, undefined, 'an undelivered turn is not a baseline');
});

test('event blocks omit only fields that follow from the row, and say so', () => {
	const wake = representativeProgramWake(1);
	wake.observation.blocks = [
		{ stableId: '1,64,0', x: 1, y: 64, z: 0, blockId: 'minecraft:stone', tags: ['minecraft:mineable/pickaxe'], state: {}, bounds: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }] },
		{ stableId: '2,64,0', x: 2, y: 64, z: 0, blockId: 'minecraft:oak_slab', tags: ['minecraft:slabs'], state: { type: 'bottom' }, bounds: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }] },
		{ stableId: 'custom', x: 3, y: 64, z: 0, blockId: 'minecraft:dirt', tags: ['a'] },
		{ stableId: '4,64,0', x: 4, y: 64, z: 0, blockId: 'minecraft:dirt', tags: ['b'] },
	];
	const observation = payload(buildNativeEventInput(representativeRecord(), wake)).observation;
	assert.equal(observation.blockDefaults, EVENT_BLOCK_DEFAULTS);
	assert.deepEqual(observation.blockTags, { 'minecraft:stone': ['minecraft:mineable/pickaxe'], 'minecraft:oak_slab': ['minecraft:slabs'] });
	assert.deepEqual(observation.blocks[0], { x: 1, y: 64, z: 0, blockId: 'minecraft:stone' });
	assert.deepEqual(observation.blocks[1], { x: 2, y: 64, z: 0, blockId: 'minecraft:oak_slab', state: { type: 'bottom' }, bounds: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }] });
	assert.equal(observation.blocks[2].stableId, 'custom', 'a stableId that is not x,y,z is kept');
	assert.deepEqual(observation.blocks[2].tags, ['a'], 'disagreeing tags for one blockId stay on the rows');
	assert.deepEqual(observation.blocks[3].tags, ['b']);
});

test('sight, workstation and tool-wear facts stay small next to a representative wake', async () => {
	const { encodeNativeEventInput: encode } = await import('../src/model-fact-encoding.mjs');
	const { withToolWear } = await import('../src/resource-facts.mjs');
	const sizes = (mutate) => {
		const wake = representativeProgramWake(1);
		mutate(wake.observation);
		const raw = buildNativeEventInput(representativeRecord(), wake);
		return { raw: Buffer.byteLength(raw), encoded: Buffer.byteLength(encode(raw)) };
	};
	const base = sizes(() => {});
	const cave = { x: -452, y: 80, z: 131, distance: 15, bearing: -34, air: 61 };
	const vein = { blockId: 'minecraft:iron_ore', x: -441, y: 84, z: 126, distance: 4, bearing: 12, visible: 3 };
	const structure = { structure: 'village', x: -400, y: 63, z: 200, distance: 90, bearing: -20, new: true };
	const typical = sizes((observation) => { observation.sighted = { caves: [cave], veins: [vein] }; });
	const full = sizes((observation) => { observation.sighted = { structures: Array(4).fill(structure), caves: Array(3).fill(cave), veins: Array(4).fill(vein) }; });
	const leftBehind = sizes((observation) => { observation.leftBehind = [{ blockId: 'minecraft:crafting_table', x: -436, y: 86, z: 120, distance: 21 }]; });
	// Measured when added: typical +190 raw/+190 encoded, all 11 rows +1,032/+475, one workstation +92/+92;
	// tool wear on Java-shaped rows: raw 10,557 -> 10,311, encoded 8,104 -> 8,202.
	assert.ok(typical.encoded - base.encoded <= 256, `typical sighted costs ${typical.encoded - base.encoded} bytes`);
	assert.ok(full.encoded - base.encoded <= 900, `every sighted row costs ${full.encoded - base.encoded} bytes`);
	assert.ok(leftBehind.encoded - base.encoded <= 128, `one left-behind workstation costs ${leftBehind.encoded - base.encoded} bytes`);
	// Java sends damage:0/maxDamage:0 on every stack; the model view keeps wear only where it can change.
	const javaRows = (observation) => { observation.inventory.items = observation.inventory.items.map((item) => ({ damage: 0, maxDamage: 0, ...item })); };
	assert.deepEqual(sizes(javaRows), base, 'the always-zero damage pair on blocks never reaches the model');
	const rows = representativeProgramWake(1).observation.inventory;
	javaRows({ inventory: rows });
	assert.ok(Buffer.byteLength(JSON.stringify(withToolWear(rows))) < Buffer.byteLength(JSON.stringify(rows)), 'wear rows are smaller than raw rows');
});

test('the hourly estimate counts the context each call re-reads', () => {
	const unbounded = estimateHourlyTokens({ calls: MEASURED_SESSION.modelCalls, turns: MEASURED_SESSION.turns, prefixTokens: 15_000, eventTokens: 4_000, toolResultTokens: 1_000, toolResults: 416, maxContextTokens: 160_000 });
	const rotated = estimateHourlyTokens({ calls: MEASURED_SESSION.modelCalls, turns: MEASURED_SESSION.turns, prefixTokens: 15_000, eventTokens: 4_000, toolResultTokens: 1_000, toolResults: 416, maxContextTokens: 64_000 });
	assert.ok(rotated.averageContextTokens < unbounded.averageContextTokens);
	assert.equal(rotated.averageContextTokens, 15_000 + 24_500);
});

test('model call and turn usage become flat trace fields', async () => {
	const { modelCallTraceFields, turnUsageTraceFields } = await import('../src/dynamic-main.mjs');
	assert.deepEqual(modelCallTraceFields({ last: { inputTokens: 70_205, cachedInputTokens: 70_000, cacheWriteInputTokens: 200, outputTokens: 40 },
		call: { provider: 'claude', turnId: '1:2', contextTokens: 70_205, rotations: 1, firstEventMs: 2_100, streamMs: 900, totalMs: 3_000, extra: 'ignored' } }),
	{ provider: 'claude', turnId: '1:2', contextTokens: 70_205, inputTokens: 70_205, cachedInputTokens: 70_000, cacheWriteInputTokens: 200, outputTokens: 40, rotations: 1, firstEventMs: 2_100, streamMs: 900, totalMs: 3_000 });
	assert.deepEqual(turnUsageTraceFields({ calls: 2, input: 5, cacheRead: 9, cacheWrite: 1, output: 7, costUsd: null, contextTokens: 15 }),
		{ modelCalls: 2, inputTokens: 5, cachedInputTokens: 9, cacheWriteInputTokens: 1, outputTokens: 7, contextTokens: 15 });
	assert.deepEqual(turnUsageTraceFields(undefined), {});
	assert.deepEqual(modelCallTraceFields({ call: { handoffBudget: { creditUsd: -0.1, totalReadUsd: 0.2, totalElectiveWriteUsd: 0.3, unsettledDebtUsd: 0.1, lastPayloadBytes: 1400, reservedWriteUsd: null, privateText: 'discard', lastWriteUsd: Infinity } } }).handoffBudget,
		{ creditUsd: -0.1, totalReadUsd: 0.2, totalElectiveWriteUsd: 0.3, unsettledDebtUsd: 0.1, lastPayloadBytes: 1400 });
});

test('mixed terrain still packs into one row table with optional columns and reconstructs exactly', async () => {
	const { mixedTerrainBlocks } = await import('../src/benchmark/token-budget.mjs');
	const { encodeModelFacts } = await import('../src/model-fact-encoding.mjs');
	const sizes = measureTokenBudget();
	assert.ok(sizes.mixedTerrainEncodedBytes <= 10_000, `mixed terrain event ${sizes.mixedTerrainEncodedBytes} bytes`);
	const wake = representativeProgramWake(1);
	wake.observation.blocks = mixedTerrainBlocks();
	const raw = buildNativeEventInput(representativeRecord(), wake);
	const encoded = JSON.parse(encodeNativeEventInput(raw).slice(raw.indexOf('\n') + 1));
	assert.ok(Array.isArray(encoded.data.observation.blocks.$rows.optional));
	const expected = JSON.parse(raw.slice(raw.indexOf('\n') + 1));
	expected.observation = { ...expected.hud, ...expected.observation };
	delete expected.hud;
	assert.deepEqual(expected.conversation.entries, []);
	assert.equal(expected.conversation.omittedEntries, 0);
	delete expected.conversation;
	assert.deepEqual(decodeModelFacts(encoded), expected);
	const nulls = [{ a: 1, b: null }, { a: 2 }, { a: 3, b: 4 }];
	assert.deepEqual(decodeModelFacts(encodeModelFacts({ rows: nulls, pad: 'x'.repeat(1_100) })).rows, nulls, 'a real null in a sometimes-missing column stays exact');
});

test('budget compaction keeps block tags only for retained rows', () => {
	const wake = representativeProgramWake(1);
	wake.observation.blocks = Array.from({ length: 32 }, (_, index) => ({ stableId: `${index},64,0`, x: index, y: 64, z: 0, blockId: `minecraft:block_${index}`, tags: [`minecraft:tag_${index}`, 'x'.repeat(300)] }));
	const observation = payload(buildNativeEventInput(representativeRecord(), wake)).observation;
	assert.ok(observation.blocks.length < 32, 'the oversized event was compacted');
	assert.deepEqual(Object.keys(observation.blockTags).sort(), observation.blocks.map((block) => block.blockId).sort());
});

test('raw sound perception events are dropped from model inputs only when heard is present', async () => {
	const { presentHeardSounds } = await import('../src/model-fact-encoding.mjs');
	const events = [{ sequence: 1, type: 'sound', soundId: 'minecraft:block.lava.pop' }, { sequence: 2, type: 'title', text: 'Night' }];
	const silent = representativeProgramWake(1);
	silent.observation.perception = { latestSequence: 2, events };
	assert.equal(payload(buildNativeEventInput(representativeRecord(), silent)).observation.perception.events.length, 2, 'no heard section: unchanged');
	const hearing = representativeProgramWake(1);
	hearing.observation.perception = { latestSequence: 2, events };
	hearing.observation.player = { ...hearing.observation.player, heard: [{ sound: 'lava', direction: 'ahead', elevation: 'level', distance: 6 }] };
	const perception = payload(buildNativeEventInput(representativeRecord(), hearing)).observation.perception;
	assert.deepEqual(perception.events.map((event) => event.type), ['title']);
	assert.equal(perception.soundEventsInHeard, 1);
	const tool = presentHeardSounds({ state: 'SUCCEEDED', observation: { heard: [], perception: { events } } });
	assert.deepEqual(tool.observation.perception.events.map((event) => event.type), ['title']);
	const plain = { observation: { perception: { events } } };
	assert.equal(presentHeardSounds(plain).observation.perception, plain.observation.perception);
});

test('a perception change made only of new sounds is not attention when heard is present', async () => {
	const { routinePerceptionChange, classifyObservationTrigger } = await import('../src/dynamic-main.mjs');
	const wire = (events, heard = []) => ({ heard, perception: { latestSequence: events.at(-1)?.sequence ?? 0, events } });
	const sounds = [{ sequence: 4, type: 'sound' }, { sequence: 5, type: 'sound' }];
	const payloadFor = { attention: true, changedFacts: ['perception'] };
	assert.equal(routinePerceptionChange(payloadFor, wire(sounds), 3), true);
	assert.equal(routinePerceptionChange(payloadFor, wire([...sounds, { sequence: 6, type: 'title' }]), 3), false, 'a title is still news');
	assert.equal(routinePerceptionChange({ ...payloadFor, changedFacts: ['perception', 'heard'] }, wire(sounds), 3), false, 'heard lava keeps its own fact');
	assert.equal(routinePerceptionChange(payloadFor, { perception: wire(sounds).perception }, 3), false, 'without heard nothing changes');
	assert.equal(routinePerceptionChange(payloadFor, wire(sounds), undefined), false, 'unknown baseline');
	assert.equal(classifyObservationTrigger({ attention: false, changedFacts: [] }, {}).attention, false);
});

test('an eye of ender flight reaches the next wake as attention, beside the heard summary', async () => {
	const { routinePerceptionChange } = await import('../src/dynamic-main.mjs');
	const flight = { sequence: 7, type: 'eye_of_ender_flight', from: { x: 0.5, y: 70, z: 0.5 }, to: { x: 8.5, y: 78, z: -7.5 }, yaw: -135, heading: 'northeast', flewBlocks: 11.3, vertical: 'rose', outcome: 'shattered' };
	const wake = representativeProgramWake(1);
	wake.observation.perception = { latestSequence: 8, events: [flight, { sequence: 8, type: 'sound', soundId: 'minecraft:entity.ender_eye.death' }] };
	wake.observation.player = { ...wake.observation.player, heard: [{ sound: 'ender_eye', direction: 'ahead', elevation: 'level', distance: 6 }] };
	const observation = payload(buildNativeEventInput(representativeRecord(), wake)).observation;
	assert.deepEqual(observation.perception.events, [flight], 'raw builder retains the wire flight for final encoding');
	const { encodeNativeEventInput, ModelObservationViews, decodeModelFacts } = await import('../src/model-fact-encoding.mjs');
	const projected = decodeModelFacts(payload(encodeNativeEventInput(buildNativeEventInput(representativeRecord(), wake), new ModelObservationViews()))).observation;
	assert.deepEqual(projected.perception.events, []);
	assert.equal(projected['eye7'], '1,70,1 -135/11 up@78 broke');
	assert.equal(routinePerceptionChange({ attention: true, changedFacts: ['perception'] }, { heard: [], perception: wake.observation.perception }, 6), false, 'a flight is news, not routine sound');
});

test('rotating the recorded Sol Codex session at 64k context tokens halves its input', async () => {
	const { readFile } = await import('node:fs/promises');
	const { replayContextRotation } = await import('../src/benchmark/token-budget.mjs');
	const { DEFAULT_CONTEXT_ROTATION_TOKENS } = await import('../src/context-carry-over.mjs');
	const series = JSON.parse(await readFile(new URL('./fixtures/codex-sol-context-series.json', import.meta.url), 'utf8'));
	const calls = series.calls.map(([context, cached]) => ({ context, cached }));
	const prefixTokens = calls[0].context;
	const before = replayContextRotation({ calls, turnEnds: series.turnEnds, prefixTokens, thresholdTokens: 0 });
	const after = replayContextRotation({ calls, turnEnds: series.turnEnds, prefixTokens, thresholdTokens: DEFAULT_CONTEXT_ROTATION_TOKENS });
	// Recorded: 68 calls, 6,883,432 input tokens, 101,227 average context, 253,672 uncached.
	assert.equal(before.inputTokens, 6_883_432);
	assert.ok(after.inputTokens <= before.inputTokens * 0.5, `${after.inputTokens} input tokens after rotation`);
	assert.ok(after.averageContextTokens < 50_000, `${after.averageContextTokens} average context tokens`);
	// Each fresh thread's first call is counted wholly uncached, so uncached input grows a little; weighting cached input at
	// a tenth of the uncached price the session still costs about a third less.
	const weighted = ({ inputTokens, uncachedInputTokens }) => uncachedInputTokens + (inputTokens - uncachedInputTokens) / 10;
	assert.ok(weighted(after) <= weighted(before) * 0.7, `${Math.round(weighted(after))} vs ${Math.round(weighted(before))} weighted tokens`);
});

test('discoveries omitted by the current block row budget retain their dated sightings', () => {
	const wake = representativeProgramWake(1);
	wake.observation.blocks = Array.from({ length: 40 }, (_, x) => ({ stableId: `${x},64,0`, x, y: 64, z: 0, blockId: 'minecraft:diamond_ore' }));
	wake.status.decision.resourceSightings = wake.observation.blocks.map(({ x, y, z, blockId }) => ({ observedAtEpochMs: 1_000, block: { x, y, z, blockId } }));
	const built = payload(buildNativeEventInput(representativeRecord(), wake));
	assert.equal(built.observation.blocks.length, 32);
	assert.equal(built.resourceSightings.length, 8);
	assert.deepEqual(built.resourceSightings.map(sighting => sighting.block.x), [32, 33, 34, 35, 36, 37, 38, 39]);
	assert.equal(built.program.decision.resourceSightings, undefined, 'each sighting is carried once');
});

test('overflow compaction bounds discoveries removed from the initial current view', () => {
	const wake = representativeProgramWake(1);
	wake.observation.blocks = Array.from({ length: 32 }, (_, x) => ({ stableId: `${x},64,0`, x, y: 64, z: 0, blockId: `minecraft:sample_${x}_ore`, tags: ['x'.repeat(250)] }));
	wake.status.decision.resourceSightings = wake.observation.blocks.map(({ x, y, z, blockId }) => ({ observedAtEpochMs: 1_000, block: { x, y, z, blockId } }));
	const built = payload(buildNativeEventInput(representativeRecord(), wake));
	assert.ok(built.observation.blocks.length < 32, 'the oversized current view was compacted');
	assert.ok((built.resourceSightings ?? []).length <= 8);
	assert.ok((built.resourceSightings ?? []).length > 0, 'some omitted ore facts still fit');
	assert.ok(Buffer.byteLength(JSON.stringify(built.resourceSightings ?? [])) <= 1536);
	assert.ok(Buffer.byteLength(JSON.stringify(built)) <= 16_384 + Buffer.byteLength(JSON.stringify(built.goal)));
});

test('leaf-heavy history leaves room for current facts and an unread player message', () => {
	const wake = representativeProgramWake(1);
	wake.status.decision.resourceSightings = Array.from({ length: 102 }, (_, x) => ({ observedAtEpochMs: 1000,
		block: { x, y: 64, z: 0, blockId: x < 13 ? 'minecraft:oak_log' : 'minecraft:oak_leaves' } }));
	wake.conversation = { baseSequence: 0, nextSequence: 1, entries: [{ sequence: 1, text: 'Please bring the wood back.' }] };
	const withoutHistory = structuredClone(wake);
	delete withoutHistory.status.decision.resourceSightings;
	const baseline = payload(buildNativeEventInput(representativeRecord(), withoutHistory));
	const input = buildNativeEventInput(representativeRecord(), wake);
	const built = payload(input);
	assert.deepEqual(built.observation, baseline.observation);
	assert.equal(built.conversation.entries.length, 1);
	assert.ok((built.resourceSightings ?? []).length <= 8);
	assert.ok((built.resourceSightings ?? []).every(s => !s.block.blockId.endsWith('_leaves')));
	assert.ok(Buffer.byteLength(input.slice(input.indexOf('\n') + 1)) <= 16_384 + Buffer.byteLength(JSON.stringify(built.goal)));
});

test('sightings yield before observation context or unread messages at the event byte limit', () => {
	const wake = representativeProgramWake(1);
	wake.conversation = { baseSequence: 0, nextSequence: 1, entries: [{ sequence: 1, text: 'Bring supplies.' }] };
	const record = representativeRecord();
	const budget = 16_384 + Buffer.byteLength(JSON.stringify(record.currentGoal));
	const baseline = payload(buildNativeEventInput(record, wake));
	wake.conversation.entries[0].text += 'x'.repeat(budget - Buffer.byteLength(JSON.stringify(beforeCoveragePacking(baseline))) - 50);
	const expected = payload(buildNativeEventInput(record, wake));
	wake.status.decision.resourceSightings = Array.from({ length: 8 }, (_, x) => ({ observedAtEpochMs: 1000,
		block: { x: 100 + x, y: 64, z: 0, blockId: 'minecraft:diamond_ore' } }));
	const built = payload(buildNativeEventInput(record, wake));
	assert.deepEqual(built.observation, expected.observation);
	assert.deepEqual(built.conversation, expected.conversation);
	assert.equal(built.resourceSightings, undefined);
});

test('oversized UTF-8 sighting rows remain bounded and cannot prevent message delivery', () => {
	const wake = representativeProgramWake(1);
	wake.conversation = [{ sequence: 1, text: 'Bring supplies.' }];
	wake.status.decision.resourceSightings = Array.from({ length: 40 }, (_, x) => ({ observedAtEpochMs: 1000,
		dimension: '界'.repeat(128), item: { stableId: '界'.repeat(256), itemId: '界'.repeat(256), x, y: 64, z: 0 } }));
	const built = payload(buildNativeEventInput(representativeRecord(), wake));
	assert.equal(built.conversation.entries.length, 1);
	assert.equal(built.resourceSightings, undefined, 'a single over-budget row is skipped');
});
