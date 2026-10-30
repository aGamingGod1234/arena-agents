import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { ModelObservationViews, decodeModelFacts, encodeNativeEventInput, presentItemTags, presentRequestableInventoryDetail, roundModelNumbers } from '../src/model-fact-encoding.mjs';

const originalObservation = JSON.parse(readFileSync(new URL('./fixtures/appearance-budget.json', import.meta.url), 'utf8'));
const decode = input => decodeModelFacts(JSON.parse(input.split('\n')[1]));
const clone = structuredClone;
const strip = value => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object'
	? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'appearance').map(([key, child]) => [key, strip(child)])) : value;
const record = observation => ({ currentGoal: 'Observe.', goalRevision: observation.goalRevision });
const build = (observation, options = {}) => buildNativeEventInput(record(observation), { event: 'observation', ...options, observation });

function group(count) {
	const observation = clone(originalObservation);
	const source = observation.entities.find(row => row.type === 'minecraft:enderman');
	observation.entities = Array.from({ length: count }, (_, i) => {
		const row = { ...clone(source), uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Friend ${i}`,
			hostile: true, targetingAgent: true, risk: source.potentialRisk,
			position: { ...source.position, z: source.position.z + i / 10 },
			appearance: { carriedBlock: 'minecraft:grass_block', screaming: true, ...(i === 0 ? { eyeContact: true } : {}) } };
		delete row.potentialRisk;
		if (row.bounds) { row.bounds.minZ += i / 10; row.bounds.maxZ += i / 10; }
		row.distance = Math.hypot(row.position.x - observation.position.x, row.position.y - observation.position.y, row.position.z - observation.position.z);
		return row;
	});
	observation.coverage.sections.entities.returned = count;
	delete observation.threats;
	delete observation.survival;
	observation.heard = [];
	return observation;
}

function stages(observation) {
	const moving = clone(observation);
	for (const row of moving.entities) {
		row.position.x += 0.25;
		if (row.bounds) { row.bounds.minX += 0.25; row.bounds.maxX += 0.25; }
		row.distance = Math.hypot(row.position.x - moving.position.x, row.position.y - moving.position.y, row.position.z - moving.position.z);
	}
	const values = [clone(observation), clone(observation), moving, strip(moving), strip(moving), clone(observation)];
	function advance(value) {
		if (!value || typeof value !== 'object') return;
		for (const [key, child] of Object.entries(value)) {
			if (typeof child === 'number' && key === 'observedAtEpochMs') value[key] += 1000;
			else if (typeof child === 'number' && ['gameTime', 'dayTime'].includes(key)) value[key] += 20;
			else if (typeof child === 'number' && key === 'duration') value[key] = Math.max(0, child - 20);
			else if (typeof child === 'number' && key === 'seconds') value[key] = Math.max(0, child - 1);
			else advance(child);
		}
	}
	values.forEach((value, index) => { for (let tick = 0; tick < index; tick++) advance(value); });
	return values;
}

// Consumer-side expansion deliberately does not import the production projection.
function selectedRows(selector) {
	if (Array.isArray(selector)) return selector;
	return selector.split(',').flatMap(run => {
		assert.match(run, /^\d+(?:-\d+)?$/);
		const [start, end = start] = run.split('-').map(Number);
		assert.ok(end >= start);
		return Array.from({ length: end - start + 1 }, (_, index) => start + index);
	});
}
function expand(observation) {
	const restored = clone(observation);
	for (const [section, field] of [['entities', 'entityAppearance'], ['blocks', 'blockAppearance']]) {
		for (const [key, values] of Object.entries(restored[field] ?? {})) {
			const pairs = Array.isArray(values) && Array.isArray(values[0]) ? values.flatMap(([value, selector]) => selectedRows(selector).map(row => [row, value]))
				: typeof values === 'string' || Array.isArray(values) ? selectedRows(values).map(row => [row, true]) : Object.entries(values);
			const visited = new Set();
			for (const [index, value] of pairs) {
				assert.ok(restored[section]?.[index], `valid ${section} row ${index}`);
				assert.ok(!visited.has(Number(index)), 'a field occurs only once per row');
				visited.add(Number(index));
				(restored[section][index].appearance ??= {})[key] = value;
			}
		}
		delete restored[field];
	}
	if (restored.player?.effects) restored.player.effects = restored.player.effects.map(effect => Array.isArray(effect) ? { effectId: effect[0], amplifier: effect[1], seconds: effect[2] } : effect);
	for (const row of restored.entities ?? []) {
		if (Array.isArray(row.bounds)) {
			assert.equal(row.bounds.length, 6);
			row.bounds = Object.fromEntries(['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].map((key, i) => [key, row.bounds[i]]));
		}
		if (row.name === undefined && row.type?.startsWith('minecraft:')) row.name = row.type.slice(10).split('_').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
	}
	return restored;
}
function apply(previous, payload) {
	if (payload.observationView.mode !== 'changes') return clone(payload.observation);
	assert.ok(previous);
	const observation = { ...previous, ...clone(payload.observationView.replace) };
	for (const key of payload.observationView.remove) delete observation[key];
	return observation;
}

// Frozen reference measurements from 9d44450c and Sol's exact custom-name constructors.
const baseline = { 4: [6144, 1200, 2520, 1200, 1200, 2511], 8: [7084, 1200, 3465, 1200, 1200, 3451], 16: [8960, 1200, 5358, 1200, 1200, 5325] };
for (const count of [4, 8, 16]) test(`${count} named hostile endermen fit base across fresh, stable, moving, transition, cleared and reacquired wakes`, t => {
	t.mock.method(Date, 'now', () => 1791849600000);
	const views = new ModelObservationViews();
	let previous;
	for (const [stage, observation] of stages(group(count)).entries()) {
		const raw = build(observation);
		const encoded = encodeNativeEventInput(raw, views);
		assert.ok(Buffer.byteLength(encoded) <= baseline[count][stage], `stage ${stage}: ${Buffer.byteLength(encoded)} > ${baseline[count][stage]} base bytes`);
		previous = apply(previous, decode(encoded));
		const rawFacts = decode(raw);
		// Encoding projects HUD facts into independent observation sections (menu-danger); stack fingerprints and
		// own-inventory menu slots are named for inspect instead of repeated; item tags are listed once per itemId and
		// measured distances/velocity show 3 decimals.
		assert.deepEqual(expand(previous), roundModelNumbers(presentItemTags(presentRequestableInventoryDetail({ ...(rawFacts.hud ?? {}), ...rawFacts.observation }))), `stage ${stage}: exact retained facts`);
		assert.equal(previous.entities.length, count);
		for (const row of expand(previous).entities) assert.deepEqual(row.appearance, observation.entities.find(source => source.uuid === row.uuid).appearance);
	}
});

for (const [context, length, options] of [['ordinary', 484, {}], ['self-care', 376, { conversationOnly: true, selfCareWake: true, trigger: 'low_health_idle' }]]) {
	test(`${context} raw budget drops appearance before hostile rows, block facts or unread messages`, t => {
		t.mock.method(Date, 'now', () => 1791849600000);
		const observation = stages(group(16))[2];
		const conversation = [{ sequence: 2, text: 'Please report visible mobs and terrain before moving. '.repeat(12).slice(0, length) }];
		const source = clone(observation);
		const control = decode(build(strip(observation), { ...options, conversation }));
		const candidateRaw = build(observation, { ...options, conversation });
		const candidate = decode(candidateRaw);
		assert.equal(candidate.observation.entities.length, 16);
		assert.ok(candidate.observation.entities.every(row => row.hostile && row.targetingAgent));
		assert.equal(candidate.observation.blocks.length, source.blocks.length);
		for (const block of candidate.observation.blocks) for (const key of ['placeableFaces', 'replaceable', 'boundsTruncated']) assert.ok(Object.hasOwn(block, key), `block retains ${key}`);
		assert.deepEqual(strip(candidate.observation), control.observation, 'all nonappearance observation paths survive, including block bounds and placement');
		assert.deepEqual(candidate.conversation, control.conversation);
		assert.deepEqual(candidate.conversation.entries, conversation);
		assert.equal(candidate.observation.entities.some(row => row.appearance), false, 'appearance is sacrificed first at the raw boundary');
		const encoded = decode(encodeNativeEventInput(candidateRaw));
		assert.deepEqual(expand(encoded.observation), roundModelNumbers({ ...(candidate.hud ?? {}), ...candidate.observation }));
		assert.deepEqual(encoded.conversation.entries, conversation);
		assert.deepEqual(observation, source, 'budgeting never mutates source observations');
	});
}
