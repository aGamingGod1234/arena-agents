import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { representativeProgramWake, representativeRecord } from '../src/benchmark/token-budget.mjs';
import { ModelObservationViews, encodeNativeEventInput, decodeModelFacts, encodeModelFacts } from '../src/model-fact-encoding.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { presentEyeFlightWake } from '../src/eye-flight-presentation.mjs';

const parse = input => decodeModelFacts(JSON.parse(input.slice(input.indexOf('\n') + 1)));
const flightKeys = value => Object.keys(value).filter(key => /^eye[0-9]/.test(key));
const facts = count => Array.from({ length: count }, (_, i) => ({ type: 'eye_of_ender_flight', flightId: 400 + i, sequence: 20 + i,
	gameTime: 400 + i * 40, observedAtEpochMs: 184000 + i * 2000, dimension: 'minecraft:overworld', from: { x: 100.5, y: 65.5, z: -20.5 },
	to: { x: 108.5, y: 73.5, z: -28.5 }, yaw: -135, heading: 'northeast', flewBlocks: 11.3, vertical: 'rose', outcome: 'dropped', droppedAt: { x: 108.5, y: 66, z: -28.5 } }));
function fixture() {
	const wake = representativeProgramWake(1);
	wake.observation.observedAtEpochMs = 200000;
	wake.observation.perception = { latestSequence: 19, earliestSequence: 1, events: [], bossBars: [] };
	const build = () => buildNativeEventInput(representativeRecord(), wake);
	const views = new ModelObservationViews();
	const send = () => encodeNativeEventInput(build(), views);
	const tool = (kind = 'observe', view = 'full', afterObservationId) => {
		const sample = { observation: structuredClone(wake.observation), freshness: { fresh: true }, goalRevision: parse(build()).goalRevision };
		return presentNativeToolResult(kind === 'observe' ? sample : { state: 'SUCCEEDED', postAction: sample }, { kind, view, afterObservationId }, views);
	};
	return { wake, build, views, send, tool };
}

// Independent Sol r2 delivery fixture, including the real native tool presentation/commit path.
for (const prior of ['wake', 'observe', 'action', 'sequence']) for (const count of [1, 2, 3, 4, 8]) {
	test(`${count} unseen flights arrive after delivered ${prior} without replacing inventory or interaction`, () => {
		const { wake, build, views, send, tool } = fixture();
		send();
		if (prior !== 'wake') tool(prior).commit();
		wake.observation.perception.latestSequence = 20 + count;
		wake.observation.perception.events = facts(count);
		const raw = build();
		const fresh = encodeNativeEventInput(raw, new ModelObservationViews());
		const same = encodeNativeEventInput(raw, views);
		assert.equal(flightKeys(parse(fresh).observation).length, count, 'fresh context receives every flight');
		const replacement = parse(same).observationView.replace;
		assert.equal(flightKeys(replacement).length, count, 'all unseen flights are delivered');
		assert.equal(replacement.inventory, undefined);
		assert.equal(replacement.interaction, undefined);
	});
}

test('delivered flights remain usable by exact view while only one changed or newly seen flight is serialized', () => {
	const { wake, views, send, tool } = fixture();
	send();
	wake.observation.perception.events = facts(8);
	wake.observation.perception.latestSequence = 28;
	const first = parse(send());
	assert.equal(flightKeys(first.observationView.replace).length, 8);
	wake.observation.observedAtEpochMs += 8000;
	const quiet = parse(send());
	assert.deepEqual(flightKeys(quiet.observationView.replace), []);
	const delta = tool('observe', 'changes', quiet.observationView.id);
	const observed = decodeModelFacts(JSON.parse(delta.response.contentItems[0].text));
	assert.deepEqual(flightKeys(observed.observationView.replace), []);
	delta.commit();
	const updated = wake.observation.perception.events[3];
	updated.gameTime += 160; updated.sequence = 29; updated.droppedAt.y = 64;
	const landing = parse(send());
	assert.deepEqual(flightKeys(landing.observationView.replace), ['eye403']);
	assert.deepEqual(landing.observationView.remove, []);
	assert.match(landing.observationView.replace['eye403'], /drop\+8,-2,-8/);
	// Reconstruct retained evidence exactly, including all seven unchanged bearings.
	const current = { ...first.observationView.replace };
	delete current['eye403']; Object.assign(current, landing.observationView.replace);
	assert.deepEqual(Object.fromEntries(flightKeys(current).map(key => [key, current[key]])),
		Object.fromEntries(Object.entries(presentEyeFlightWake(wake.observation)).filter(([key]) => /^eye[0-9]/.test(key))));
	wake.observation.perception.events.shift();
	const expired = parse(send());
	assert.deepEqual(flightKeys(expired.observationView.replace), []);
	assert.ok(expired.observationView.remove.includes('eye400'));
	views.forgetEventView();
	assert.equal(flightKeys(parse(send()).observation).length, 7, 'uncertain delivery resets to complete still-retained evidence');
});

test('an undelivered tool reply cannot consume flight evidence', () => {
	const { wake, send, tool } = fixture(); send();
	wake.observation.perception.events = facts(8);
	tool(); // Prepared, but never committed as delivered.
	assert.equal(flightKeys(parse(send()).observationView.replace).length, 8);
});

test('flight fact encoding preserves distinct flight identities', () => {
	const value = presentEyeFlightWake({ perception: { events: facts(4) }, world: { dimension: 'minecraft:overworld' } });
	const packed = encodeModelFacts(value);
	assert.deepEqual(decodeModelFacts(packed), value);
});

test('common presentation preserves arbitrary tool coverage values and remains idempotent', () => {
	const observation = { resultCoverage: { blocks: { availableInSnapshot: 12, omitted: 3, retained: 9 }, omittedFields: ['blocks[].details'], omittedSections: [], complete: false, unknown: null } };
	const rendered = presentEyeFlightWake(observation);
	assert.strictEqual(rendered, observation);
	assert.deepEqual(rendered.resultCoverage, observation.resultCoverage);
	assert.equal(rendered.snapshotCounts, undefined);
	assert.equal(rendered.omittedFromSnapshot, undefined);
	assert.deepEqual(presentEyeFlightWake(rendered), rendered);
});

test('a newly observed flight does not resend seven different delivered trajectories', () => {
	const { wake, send } = fixture(); send();
	wake.observation.perception.events = facts(8).map((event, index) => ({ ...event,
		from: { ...event.from, x: event.from.x + index }, to: { ...event.to, x: event.to.x + index },
		droppedAt: { ...event.droppedAt, x: event.droppedAt.x + index } }));
	const delivered = parse(send());
	assert.equal(new Set(Object.values(delivered.observationView.replace).filter(value => typeof value === 'string')).size, 8);
	wake.observation.perception.events.shift();
	wake.observation.perception.events.push({ ...facts(1)[0], flightId: 408, sequence: 28, gameTime: 720 });
	const next = parse(send());
	assert.deepEqual(flightKeys(next.observationView.replace), ['eye408']);
	assert.deepEqual(next.observationView.remove, ['eye400']);
});

test('advancing clocks and moving the player do not resend delivered flight evidence', () => {
	const { wake, send } = fixture();
	send();
	wake.observation.perception.events = facts(1);
	assert.deepEqual(flightKeys(parse(send()).observationView.replace), ['eye400']);
	wake.observation.observedAtEpochMs += 8000;
	wake.observation.perception.events[0].gameTime += 160;
	wake.observation.perception.events[0].observedAtEpochMs += 8000;
	assert.deepEqual(flightKeys(parse(send()).observationView.replace), []);
	wake.observation.player.x += 30;
	wake.observation.player.yaw += 90;
	const moved = parse(send());
	assert.ok(moved.observationView.replace.player);
	assert.deepEqual(flightKeys(moved.observationView.replace), []);
});
