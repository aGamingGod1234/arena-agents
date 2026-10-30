import assert from 'node:assert/strict';
import test from 'node:test';
import { presentEyeFlightWake } from '../src/eye-flight-presentation.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { representativeProgramWake, representativeRecord } from '../src/benchmark/token-budget.mjs';
import { encodeNativeEventInput, ModelObservationViews, decodeModelFacts } from '../src/model-fact-encoding.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';

const flight = { type: 'eye_of_ender_flight', sequence: 7, observedAtEpochMs: 1000, gameTime: 80, dimension: 'minecraft:overworld',
	from: { x: 0.5, y: 70, z: 0.5 }, to: { x: 8.5, y: 78, z: -7.5 }, yaw: -135, heading: 'northeast', flewBlocks: 11.3, vertical: 'rose', outcome: 'shattered' };
const flights = observation => Object.fromEntries(Object.entries(observation).filter(([key]) => /^eye[0-9]/.test(key)));
const read = input => JSON.parse(input.slice(input.indexOf('\n') + 1));

for (const path of ['wake', 'observe']) test(`${path} delivers distinct last seen eye heights even when the ending is unseen`, () => {
	const render = height => {
		const wake = representativeProgramWake(1);
		wake.observation.perception = { events: [{ ...flight, flightId: 43, outcome: 'unseen',
			from: { x: 100.5, y: height < 0 ? -20.5 : 65.5, z: -20.5 },
			to: height === undefined ? undefined : { x: 108.5, y: height, z: -28.5 } }] };
		if (path === 'wake') return decodeModelFacts(read(encodeNativeEventInput(buildNativeEventInput(representativeRecord(), wake), new ModelObservationViews()))).observation.eye43;
		const prepared = presentNativeToolResult({ observation: wake.observation, freshness: { fresh: true } }, { kind: 'observe', view: 'full' }, new ModelObservationViews());
		return decodeModelFacts(JSON.parse(prepared.response.contentItems[0].text)).observation.eye43;
	};
	assert.match(render(69.5), /up@70 unseen$/);
	assert.match(render(77.5), /up@78 unseen$/);
	assert.match(render(-12.4), /up@-12 unseen$/);
	assert.match(render(undefined), /up unseen$/);
});

test('a changed last seen eye height replaces its flight once in the delivered view', () => {
	const wake = representativeProgramWake(1);
	wake.observation.perception = { events: [{ ...flight, flightId: 43, outcome: 'unseen', to: { ...flight.to, y: 69.5 } }] };
	const views = new ModelObservationViews();
	const send = () => decodeModelFacts(read(encodeNativeEventInput(buildNativeEventInput(representativeRecord(), wake), views)));
	assert.match(send().observation.eye43, /up@70 unseen$/);
	wake.observation.perception.events[0].to.y = 77.5;
	assert.match(send().observationView.replace.eye43, /up@78 unseen$/);
	wake.observation.observedAtEpochMs += 8000;
	assert.equal(send().observationView.replace.eye43, undefined);
});

test('bounded perception events remain unchanged and do not bypass production encoding', () => {
	const wake = representativeProgramWake(1);
	wake.observation.perception = { events: '[BOUNDED]', bossBars: '[BOUNDED]' };
	assert.strictEqual(presentEyeFlightWake(wake.observation), wake.observation);
	const raw = buildNativeEventInput(representativeRecord(), wake);
	const encoded = encodeNativeEventInput(raw, new ModelObservationViews());
	assert.ok(Buffer.byteLength(encoded) < Buffer.byteLength(raw));
	assert.equal(decodeModelFacts(read(encoded)).observation.perception.events, '[BOUNDED]');
});

test('flight presentation keeps both bearings, stable timestamps, positions and outcomes without changing the wire', () => {
	const observation = { observedAtEpochMs: 2500, world: { dimension: 'minecraft:overworld' }, perception: {
		events: [{ type: 'title', text: 'hello' }, flight, { ...flight, sequence: 8, from: { x: 300, y: 70, z: 0 }, outcome: 'dropped' }] } };
	const original = structuredClone(observation);
	const result = presentEyeFlightWake(observation);
	assert.deepEqual(result.perception.events, [{ type: 'title', text: 'hello' }]);
	assert.deepEqual(flights(result), {
		'eye7': '1,70,1 -135/11 up@78 broke',
		'eye8': '300,70,0 -135/11 up@78 dropped',
	});
	assert.deepEqual(observation, original);
});

test('unseen flights have no fabricated endpoint or bearing and cross-dimension facts retain their dimension', () => {
	const result = presentEyeFlightWake({ world: { dimension: 'minecraft:the_end' }, perception: { events: [
		{ type: flight.type, from: flight.from, sequence: 9, gameTime: 80, dimension: 'minecraft:overworld', outcome: 'unseen' },
	] } });
	assert.deepEqual(flights(result), { 'eye9': 'minecraft:overworld 1,70,1 unseen' });
});

test('flight projection preserves inventory, interaction and coverage exactly; no-flight input keeps identity', () => {
	const observation = { inventory: { selectedItem: { slot: 0, itemId: 'minecraft:iron_pickaxe', count: 1 }, items: [
		{ slot: 0, itemId: 'minecraft:iron_pickaxe', count: 1, displayName: 'Iron Pickaxe' },
		{ slot: 'mainhand', itemId: 'minecraft:iron_pickaxe', count: 1, displayName: 'My pick' },
	] }, interaction: { mainHandItemId: 'minecraft:iron_pickaxe', offHandItemId: 'minecraft:shield', hotbar: [{ slot: 0, itemId: 'minecraft:iron_pickaxe' }] },
	resultCoverage: { blocks: { availableInSnapshot: 12, omitted: 3, retained: 9 } }, snapshotCounts: { blocks: 12 }, omittedFromSnapshot: { blocks: 3 },
	perception: { latestSequence: 7, events: [flight] } };
	const original = structuredClone(observation);
	const result = presentEyeFlightWake(observation);
	for (const section of ['inventory', 'interaction', 'resultCoverage', 'snapshotCounts', 'omittedFromSnapshot']) {
		assert.strictEqual(result[section], observation[section], section);
		assert.deepEqual(result[section], original[section], section);
	}
	assert.equal(result.perception.latestSequence, 7);
	assert.deepEqual(observation, original);
	const ordinary = { ...observation, perception: { events: [] } };
	assert.strictEqual(presentEyeFlightWake(ordinary), ordinary);
	const absent = { inventory: observation.inventory };
	assert.strictEqual(presentEyeFlightWake(absent), absent);
});

test('late flight formatting preserves actual omission counts after planning and overflow trimming', () => {
	for (const event of ['program_planning_due', 'program_attention']) {
		const wake = representativeProgramWake(1);
		wake.event = event;
		wake.observation.perception = { events: [flight] };
		wake.observation.blocks = Array.from({ length: 50 }, (_, index) => ({ ...wake.observation.blocks[index % 32],
			state: { description: 'x'.repeat(500) } }));
		const raw = buildNativeEventInput(representativeRecord(), wake);
		assert.equal(read(raw).observation.perception.events[0].type, 'eye_of_ender_flight');
		const result = decodeModelFacts(read(encodeNativeEventInput(raw, new ModelObservationViews()))).observation;
		// Routine coverage is presented as snapshotCounts and omittedRows (menu-danger compaction).
		assert.equal(result.snapshotCounts.blocks, 50);
		assert.equal(result.omittedRows.blocks, 50 - result.blocks.length);
		assert.deepEqual(result.snapshotCounts, read(raw).observation.snapshotCounts);
		assert.equal(Object.keys(flights(result)).length, 1);
	}
});

test('urgent flight wakes keep the danger instruction and threat facts', () => {
	const wake = representativeProgramWake(1);
	wake.status.decision.priority = 'urgent';
	wake.status.decision.trigger = 'damage';
	wake.observation.player.inLava = true;
	wake.observation.perception = { events: [] };
	const base = buildNativeEventInput(representativeRecord(), wake);
	wake.observation.perception.events = [flight];
	const head = buildNativeEventInput(representativeRecord(), wake);
	assert.equal(head.split('\n')[0], base.split('\n')[0]);
	assert.deepEqual(read(head).observation.player, read(base).observation.player);
	assert.deepEqual(read(head).observation.entities, read(base).observation.entities);
});

test('ordinary to flight to quiet to landing to expiry changes only the sections whose facts changed', () => {
	const wake = representativeProgramWake(1);
	wake.observation.world.worldId = 'flight-session';
	wake.observation.observedAtEpochMs = 2500;
	wake.observation.perception = { latestSequence: 6, earliestSequence: 1, events: [], bossBars: [] };
	const views = new ModelObservationViews();
	const send = () => decodeModelFacts(read(encodeNativeEventInput(buildNativeEventInput(representativeRecord(), wake), views)));
	const ordinary = send();
	wake.observation.perception.latestSequence = 7;
	wake.observation.perception.events = [{ ...flight, flightId: 43, outcome: 'unseen' }];
	const first = send();
	assert.ok(Object.hasOwn(first.observationView.replace, 'eye43'));
	for (const section of ['inventory', 'interaction', 'snapshotCounts']) {
		assert.ok(!Object.hasOwn(first.observationView.replace, section), section);
	}
	const retained = first.observationView.replace['eye43'];
	wake.observation.observedAtEpochMs += 8000;
	const quiet = send();
	assert.ok(!Object.hasOwn(quiet.observationView.replace, 'eye43'));
	assert.equal(quiet.observationView.replace['eye43'], undefined);
	wake.observation.perception.latestSequence = 8;
	wake.observation.perception.events = [{ ...flight, flightId: 43, sequence: 8, observedAtEpochMs: 10600, outcome: 'dropped', droppedAt: { x: 8.5, y: 64, z: -7.5 } }];
	const landed = send();
	assert.ok(Object.hasOwn(landed.observationView.replace, 'eye43'));
	assert.match(landed.observationView.replace['eye43'], /-135\/11 up@78 drop@9,64,-7/);
	assert.notDeepEqual(landed.observationView.replace['eye43'], retained);
	wake.observation.perception.events = [];
	wake.observation.observedAtEpochMs += 30001;
	const expired = send();
	assert.ok(expired.observationView.remove.includes('eye43'));
	let reconstructed = structuredClone(ordinary.observation);
	for (const event of [first, quiet, landed, expired]) {
		for (const key of event.observationView.remove) delete reconstructed[key];
		Object.assign(reconstructed, event.observationView.replace);
	}
	const rawFacts = read(buildNativeEventInput(representativeRecord(), wake));
	// Encoding projects HUD facts into independent observation sections (menu-danger).
	assert.deepEqual(reconstructed, { ...(rawFacts.hud ?? {}), ...rawFacts.observation });
});

test('flight presentation is idempotent and changing the wake clock leaves flight evidence identical', () => {
	const observation = { observedAtEpochMs: 2500, world: { dimension: flight.dimension }, perception: { latestSequence: 7, events: [flight] },
		resultCoverage: { blocks: { availableInSnapshot: 50, omitted: 18, complete: false, reason: 'budget' } } };
	const result = presentEyeFlightWake(observation);
	assert.deepEqual(presentEyeFlightWake(result), result);
	observation.observedAtEpochMs += 8000;
	assert.deepEqual(flights(presentEyeFlightWake(observation)), flights(result));
});

test('fresh flight projection rounds only presentation and retains evidence identity', () => {
	const wire = { ...flight, flightId: 43, yaw: -134.7, flewBlocks: 11.3, outcome: 'dropped', droppedAt: { x: 8.5, y: 64.2, z: -7.5 } };
	const original = structuredClone(wire);
	const projected = presentEyeFlightWake({ perception: { events: [wire] }, world: { dimension: wire.dimension } });
	assert.deepEqual(flights(projected), { 'eye43': '1,70,1 -135/11 up@78 drop@9,64,-7' });
	assert.deepEqual(wire, original);
});

test('stronghold reference describes the sinking inference without prescribing digging', async () => {
	const { readFile } = await import('node:fs/promises');
	const guide = await readFile(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/references/strategy-guide.md', import.meta.url), 'utf8');
	const paragraph = guide.split('\n').find(line => line.startsWith('- **Finding the stronghold:**'));
	assert.match(paragraph, /sinking eye indicates.*nearby horizontally and usually underground/);
	assert.doesNotMatch(paragraph, /\b(?:so dig|dig down|you (?:must|should|need to) dig)\b/i);
});

const position = value => value.split(',').map(Number);
const roundPosition = point => ['x', 'y', 'z'].map(axis => Math.round(point[axis]));

for (const [label, from, drop, marker] of [
	['absolute', { x: 0.5, y: 70, z: 0.5 }, { x: 8.5, y: 64.2, z: -7.5 }, '@'],
	['relative', { x: 1200.5, y: 65.5, z: -880.5 }, { x: 1208.4, y: 64.4, z: -888.7 }, '+'],
]) test(`${label} drop position reconstructs from the rounded throw origin`, () => {
	const wire = { ...flight, flightId: 53, from, droppedAt: drop, outcome: 'dropped' };
	const projected = presentEyeFlightWake({ world: { dimension: flight.dimension }, perception: { events: [wire] } });
	const parts = projected.eye53.split(' ');
	const origin = position(parts[0]);
	const ending = parts.at(-1);
	assert.equal(ending[4], marker);
	const encoded = position(ending.slice(5));
	const reconstructed = marker === '+' ? encoded.map((n, i) => n + origin[i]) : encoded;
	assert.deepEqual(origin, roundPosition(from));
	assert.deepEqual(reconstructed, roundPosition(drop));
});

test('player movement and wake clocks do not change a retained flight or its stable key', () => {
	const observation = { observedAtEpochMs: 3000, player: { x: 0, y: 64, z: 0, yaw: 0 }, world: { dimension: flight.dimension },
		perception: { events: [{ ...flight, flightId: 53 }] } };
	const initial = flights(presentEyeFlightWake(observation));
	observation.player = { x: 400, y: 90, z: -300, yaw: 180 };
	observation.observedAtEpochMs += 8000;
	observation.perception.events[0].gameTime += 160;
	observation.perception.events[0].observedAtEpochMs += 8000;
	assert.deepEqual(flights(presentEyeFlightWake(observation)), initial);
});

test('missing bearing or distance remains unknown and endpoint distance is geometric', () => {
	const present = extra => presentEyeFlightWake({ perception: { events: [{ type: flight.type, flightId: 53,
		from: { x: 0, y: 64, z: 0 }, outcome: 'unseen', ...extra }] } }).eye53;
	assert.equal(present({}), '0,64,0 unseen');
	assert.equal(present({ yaw: -90 }), '0,64,0 -90/? unseen');
	assert.equal(present({ flewBlocks: 10.2 }), '0,64,0 ?/10 unseen');
	assert.equal(present({ to: { x: 3, y: 90, z: 4 }, vertical: 'sank' }), '0,64,0 ?/5 down@90 unseen');
	assert.equal(present({ to: { x: 3, y: 90, z: 4 } }), '0,64,0 ?/5 y90 unseen');
	assert.equal(present({ outcome: 'dropped', vertical: 'level' }), '0,64,0 level dropped');
});

// Live d4e search: "Eye travelled only 1.9 blocks: anchor nearby" read a 1.9-block glimpse as the whole flight.
test('a flight lost from view shows an unknown length and a crossing shows where two bearing lines meet', () => {
	const result = presentEyeFlightWake({ world: { dimension: 'minecraft:overworld' }, perception: { events: [
		{ ...flight, sequence: 10, from: { x: 365.6, y: 68.9, z: 2600.7 }, to: { x: 364.8, y: 69.5, z: 2601.2 }, yaw: 118, flewBlocks: undefined, lostFromView: true, vertical: undefined, outcome: 'unseen' },
		{ ...flight, sequence: 11, from: { x: 637.7, y: 63, z: 2688.5 }, to: { x: 626.5, y: 71.1, z: 2684.2 }, yaw: 110.7, flewBlocks: 12, outcome: 'dropped',
			cross: { x: 257, z: 2545 }, crossBlocks: 407, crossFlightId: 911 },
	] } });
	assert.deepEqual(flights(result), {
		eye10: '366,69,2601 118/? y70 unseen',
		eye11: '638,63,2689 111/12 up@71 dropped cross@257,2545 407 from throw',
	});
});
