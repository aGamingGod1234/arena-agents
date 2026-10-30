import assert from 'node:assert/strict';
import test from 'node:test';
import { presentAppearanceWake } from '../src/appearance-wake-presentation.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { ModelObservationViews, decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';

const decode = input => decodeModelFacts(JSON.parse(input.split('\n')[1]));
const fixture = () => ({
	world: { worldId: 'appearance-test', dimension: 'minecraft:the_nether' },
	position: { x: 0, y: 64, z: 0 },
	entities: [
		{ uuid: 'one', type: 'minecraft:blaze', name: 'Blaze', distance: 5, position: { x: 3, y: 64, z: 4 }, appearance: { airborne: true, charging: true } },
		{ uuid: 'two', type: 'minecraft:enderman', name: 'Named friend', distance: 9, position: { x: 3, y: 64, z: 4 }, appearance: { carriedBlock: 'minecraft:stone', creepy: true } },
	],
	blocks: [{ blockId: 'minecraft:spawner', x: 1, y: 64, z: 2, appearance: { mob: 'minecraft:blaze' } }],
});

test('provider projection preserves exact appearance, custom names and distances without mutating runtime facts', () => {
	const observation = fixture();
	const original = structuredClone(observation);
	const raw = buildNativeEventInput({ currentGoal: 'Observe.', goalRevision: 1 }, { event: 'observation', observation });
	const runtime = decode(raw);
	assert.equal(runtime.conversation.nextSequence, -1);
	assert.deepEqual(runtime.observation.entities[0].appearance, original.entities[0].appearance);
	const head = decode(encodeNativeEventInput(raw));
	assert.deepEqual(head.observation.entityAppearance, { airborne: [0], charging: [0], carriedBlock: { 1: 'minecraft:stone' }, creepy: [1] });
	assert.deepEqual(head.observation.blockAppearance, { mob: { 0: 'minecraft:blaze' } });
	assert.equal(head.observation.entities[0].name, undefined);
	assert.equal(head.observation.entities[0].distance, 5);
	assert.equal(head.observation.entities[1].name, 'Named friend');
	assert.equal(head.observation.entities[1].distance, 9);
	assert.equal(head.conversation, undefined);
	assert.deepEqual(observation, original);
});

test('appearance sections contain only stable visible values and changes do not resend geometry', () => {
	const views = new ModelObservationViews();
	const observation = fixture();
	let reconstructed;
	const send = sequence => {
		const raw = buildNativeEventInput({ currentGoal: 'Observe.', goalRevision: 1 }, { event: 'observation', eventSequence: sequence, observation: { ...observation, observedAtEpochMs: sequence * 1000 } });
		const expected = presentAppearanceWake(decode(raw)).observation;
		const encoded = decode(encodeNativeEventInput(raw, views));
		if (encoded.observationView.mode === 'full') reconstructed = encoded.observation;
		else {
			Object.assign(reconstructed, encoded.observationView.replace);
			for (const key of encoded.observationView.remove) delete reconstructed[key];
		}
		assert.deepEqual(reconstructed, expected);
		return encoded.observationView;
	};
	send(1);
	const stable = send(2);
	assert.equal(stable.replace.entityAppearance, undefined);
	assert.equal(stable.replace.blockAppearance, undefined);
	observation.entities[0].appearance.charging = false;
	observation.blocks[0].appearance.mob = 'minecraft:pig';
	const changed = send(3);
	assert.equal(changed.replace.entities, undefined);
	assert.equal(changed.replace.blocks, undefined);
	assert.deepEqual(changed.replace.entityAppearance.charging, { 0: false });
	assert.deepEqual(changed.replace.blockAppearance, { mob: { 0: 'minecraft:pig' } });
	for (const row of [...observation.entities, ...observation.blocks]) delete row.appearance;
	const removed = send(4);
	assert.ok(removed.remove.includes('entityAppearance'));
	assert.ok(removed.remove.includes('blockAppearance'));
	assert.equal(removed.replace.entities, undefined);
	assert.equal(removed.replace.blocks, undefined);
});

test('appearance row indices follow retained order, grouping preserves true false zero and string values', () => {
	const observation = fixture();
	observation.entities.reverse();
	observation.entities.push({ uuid: 'three', appearance: { charging: true, stage: 0, unknown: null } });
	const shown = presentAppearanceWake({ observation }).observation;
	assert.deepEqual(shown.entityAppearance.charging, [1, 2]);
	assert.deepEqual(shown.entityAppearance.carriedBlock, { 0: 'minecraft:stone' });
	assert.deepEqual(shown.entityAppearance.stage, { 2: 0 });
	assert.deepEqual(shown.entityAppearance.unknown, { 2: null });
	observation.entities = observation.entities.slice(1);
	assert.deepEqual(presentAppearanceWake({ observation }).observation.entityAppearance.charging, [0, 1]);
});

test('provider message savings preserve unread content, sequence, and positive omission count', () => {
	const conversation = { mode: 'unread', baseSequence: 6, nextSequence: 7, entries: [{ sequence: 7, text: 'Watch the blaze.' }], omittedEntries: 2 };
	const raw = { event: 'observation', observation: fixture(), conversation };
	const presented = decode(encodeNativeEventInput(`Event.\n${JSON.stringify(raw)}`));
	assert.deepEqual(presented.conversation, { entries: conversation.entries, omittedEntries: 2 });
	assert.equal(conversation.nextSequence, 7);
	assert.equal(presentAppearanceWake({ ...raw, conversation: { ...conversation, omittedEntries: 0 } }).conversation.omittedEntries, undefined);
});

test('tools and wakes share the same appearance layout across observation baselines', () => {
	const views = new ModelObservationViews();
	const observation = fixture();
	const toolValue = { observation, freshness: { fresh: true }, goalRevision: 1 };
	const tool = views.prepare(toolValue, { kind: 'observe' });
	tool.commit();
	assert.deepEqual(tool.value.observation.entityAppearance.charging, [0]);
	assert.deepEqual(toolValue.observation.entities[0].appearance, { airborne: true, charging: true });
	const event = decode(encodeNativeEventInput(`Event.\n${JSON.stringify({ ...toolValue, event: 'observation' })}`, views));
	assert.equal(event.observationView.mode, 'changes');
	assert.equal(event.observationView.replace.entities, undefined);
	assert.equal(event.observationView.replace.entityAppearance, undefined);
	const postAction = views.prepare({ postAction: toolValue }, { kind: 'action', view: 'changes', afterObservationId: event.observationView.id });
	assert.equal(postAction.value.postAction.observationView.replace.entities, undefined);
	assert.equal(postAction.value.postAction.observationView.replace.entityAppearance, undefined);
});

test('effect tuples preserve zero values and countdowns, leaving unfamiliar effect facts intact', () => {
	const observation = fixture();
	observation.player = { effects: [
		{ effectId: 'minecraft:resistance', amplifier: 0, seconds: 25 },
		{ effectId: 'minecraft:regeneration', amplifier: 2, seconds: 0 },
		{ effectId: 'minecraft:fire_resistance', amplifier: 1, seconds: 8, ambient: true },
		{ effectId: 'minecraft:speed', amplifier: 1, duration: 200 },
	] };
	const source = structuredClone(observation);
	const projected = presentAppearanceWake({ observation }).observation;
	assert.deepEqual(projected.player.effects, [
		['minecraft:resistance', 0, 25], ['minecraft:regeneration', 2, 0],
		source.player.effects[2], source.player.effects[3],
	]);
	assert.deepEqual(presentAppearanceWake({ observation: projected }).observation, projected, 'provider views are idempotent');
	observation.player.effects[0].seconds--;
	const later = presentAppearanceWake({ observation }).observation;
	assert.deepEqual(later.player.effects[0], ['minecraft:resistance', 0, 24]);
	assert.deepEqual(later.entityAppearance, projected.entityAppearance, 'countdowns never alter appearance sections');
	assert.deepEqual(projected.player.effects[0], ['minecraft:resistance', 0, 25], 'earlier views are not mutated');
});

test('spawner groups share mob IDs with short pair arrays and preserve disjoint row membership', () => {
	const observation = { blocks: Array.from({ length: 8 }, (_, x) => ({ x, y: 64, z: 0, blockId: 'minecraft:spawner',
		appearance: { mob: x % 2 ? 'minecraft:enderman' : 'minecraft:blaze' } })) };
	const projected = presentAppearanceWake({ observation }).observation;
	assert.deepEqual(projected.blockAppearance.mob, [
		['minecraft:blaze', '0,2,4,6'], ['minecraft:enderman', '1,3,5,7'],
	]);
	assert.deepEqual(observation.blocks[0].appearance, { mob: 'minecraft:blaze' });
});
