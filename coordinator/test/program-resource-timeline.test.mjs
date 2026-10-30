import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeEventInput, classifyObservationTrigger, mergePlannerRequest, rememberResources, settleOwnBreak, startOwnBreak } from '../src/dynamic-main.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';

const record = { agentId: 'resource-timeline', goalRevision: 1, provider: 'claude', model: 'selected-model', reasoningEffort: 'low', currentGoal: 'Gather resources' };
const turn = () => new Promise(resolve => setImmediate(resolve));
const target = { x: 0, y: 64, z: 0 };
const chest = { x: 1, y: 64, z: 0, blockId: 'minecraft:chest' };
const ore = { x: 0, y: 65, z: 0, blockId: 'minecraft:diamond_ore' };
const diamond = { stableId: 'other-player-diamond', itemId: 'minecraft:diamond', count: 1, x: 0.5, y: 64.2, z: 0.5 };
const blockRow = block => ({ stableId: `${block.x},${block.y},${block.z}`, ...block });
const exposure = (blocks) => ({
	observedAtEpochMs: 1_000,
	target: { kind: 'block', position: target, beforeId: 'minecraft:oak_log', afterId: 'minecraft:air', worldChanged: true },
	progress: { value: 1, basis: 'world_mutation', verified: true },
	revealedBlocks: blocks.map(block => ({ position: { x: block.x, y: block.y, z: block.z }, blockId: block.blockId, face: 'down' })),
});

function timeline(t) {
	let now = 0, sequence = 1;
	const state = { resources: new Set(), brokenBlocks: [] };
	const timers = [], wakes = [], pending = [];
	let latest = { observedAtEpochMs: now, player: { x: -1, y: 64, z: 0, health: 20 }, blocks: [blockRow({ ...target, blockId: 'minecraft:oak_log' })], items: [], entities: [], inventory: { items: [] } };
	rememberResources(state, latest);
	const executor = new NativeProgramExecutor({ now: () => now,
		setTimeoutFn: (callback, ms) => { const timer = { callback, due: now + ms, cleared: false }; timers.push(timer); return timer; },
		clearTimeoutFn: timer => { if (timer) timer.cleared = true; },
	});
	executor.run(record, { source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1); await player.wait(2);', programId: 'timeline', timeoutMs: 120_000 }, {
		observation: latest, eventSequence: sequence,
		executeAction: () => new Promise(resolve => pending.push(resolve)),
		cancelAction: async () => { for (const resolve of pending.splice(0)) resolve({ state: 'CANCELLED' }); return { state: 'CANCELLED' }; },
		onDecision: status => wakes.push({ at: now, status, input: JSON.parse(buildNativeEventInput(record, { event: 'program_attention', programId: 'timeline', status, observation: latest }).split('\n').slice(1).join('\n')) }),
	});
	t.after(() => executor.cancel(record.agentId));
	return { state, wakes, executor,
		start: () => startOwnBreak(state, 'break-1', target),
		settle: (success, at, evidence) => settleOwnBreak(state, 'break-1', success, at, evidence),
		publish: async (at, { blocks = [], items = [], trigger } = {}) => {
			await turn();
			now = at;
			latest = { ...latest, observedAtEpochMs: at, blocks: blocks.map(blockRow), items };
			const discovery = rememberResources(state, latest);
			const attention = classifyObservationTrigger({ attention: false }, latest, { resourceDiscovery: discovery, resourceSightings: state.resourceSightings });
			executor.onObservation(record, { observation: latest, eventSequence: ++sequence, ...attention, ...(trigger === undefined ? {} : { trigger }) });
			await turn();
			return discovery;
		},
		fire: async at => { now = at; for (const timer of [...timers]) if (!timer.cleared && timer.due <= now) { timer.cleared = true; timer.callback(); } await turn(); },
	};
}

for (const [name, facts] of [['neighbour placed independently', { blocks: [chest] }], ['nearby item dropped independently', { items: [diamond] }]]) {
	test(`${name} beside a fresh successful break wakes in the same publication`, async t => {
		const run = timeline(t);
		run.start(); run.settle(true, 1_000, exposure([ore]));
		assert.equal(await run.publish(1_000, facts), true);
		assert.deepEqual(run.wakes.map(wake => wake.at), [1_000]);
		assert.equal(await run.publish(60_001, facts), false, 'identity was acknowledged by its discovery, not discarded by proximity');
	});
}

test('a failed in-flight break cannot consume a resource seen before its result', async t => {
	const run = timeline(t);
	run.start();
	assert.equal(await run.publish(1_000, { items: [diamond], blocks: [chest] }), true);
	run.settle(false, 1_100, exposure([ore]));
	assert.deepEqual(run.wakes.map(wake => wake.at), [1_000]);
	assert.equal(await run.publish(60_001, { items: [diamond], blocks: [chest] }), false);
});

test('a late success cannot retroactively suppress an already published discovery', async t => {
	const run = timeline(t);
	run.start();
	assert.equal(await run.publish(1_000, { blocks: [ore] }), true);
	assert.deepEqual(run.wakes.map(wake => wake.at), [1_000]);
	run.settle(true, 10_000, { ...exposure([ore]), observedAtEpochMs: 10_000 });
	assert.equal(await run.publish(10_100, { blocks: [ore] }), false);
	assert.equal(run.wakes.length, 1);
});

test('only confirmed faces are suppressed among simultaneous discoveries', async t => {
	const run = timeline(t);
	run.start(); run.settle(true, 1_000, exposure([ore]));
	assert.equal(await run.publish(1_000, { blocks: [ore, chest], items: [diamond] }), true);
	assert.equal(run.wakes.length, 1);
	assert.deepEqual(run.state.resourceSightings.map(sighting => sighting.block?.blockId ?? sighting.item.itemId).sort(), ['minecraft:chest', 'minecraft:diamond']);
});

test('a directly confirmed exposure is quiet and its association cannot suppress a later arrival', async t => {
	const run = timeline(t);
	run.start(); run.settle(true, 1_000, exposure([ore]));
	assert.equal(await run.publish(1_000, { blocks: [ore] }), false);
	assert.equal(run.wakes.length, 0);
	assert.equal(run.state.brokenBlocks.length, 0, 'the successful break evidence belongs to one post-result publication');
	assert.equal(await run.publish(2_000, { blocks: [chest] }), true);
	assert.equal(run.wakes.length, 1);
});

test('a deferred discovery that leaves view retains its dated sighting in the wake', async t => {
	const run = timeline(t);
	await run.publish(1_000, { blocks: [chest] });
	run.executor.respond(record, { programId: 'timeline', decisionId: run.wakes[0].status.decision.decisionId, directive: 'continue' });
	await run.publish(4_000, { blocks: [ore], items: [diamond] });
	await run.publish(5_000);
	assert.equal(run.wakes.length, 1);
	await run.fire(31_000);
	assert.equal(run.wakes.length, 2);
	assert.deepEqual(run.wakes[1].input.resourceSightings.map(sighting => sighting.block?.blockId ?? sighting.item.itemId).sort(), ['minecraft:diamond', 'minecraft:diamond_ore']);
	const now = run.wakes[1].input.observation.observedAtEpochMs;
	assert.ok(Number.isFinite(now));
	assert.ok(run.wakes[1].input.resourceSightings.every(sighting => sighting.src === `seen ${Math.ceil((now - 4_000) / 1000)}s` && sighting.observedAtEpochMs === undefined), 'each sighting carries its age at this wake');
	assert.deepEqual(run.wakes[1].input.observation.blocks, [], 'a prior sighting is not presented as currently visible');
});


test('a discovery keeps its prompt wake when another ordinary trigger wins classification', async t => {
	const run = timeline(t);
	assert.equal(await run.publish(1_000, { blocks: [ore], trigger: 'structure_sighted' }), true);
	assert.deepEqual(run.wakes.map(wake => wake.at), [1_000]);
});

test('coalesced program wakes preserve all dated discoveries through danger and program end', () => {
	const oreSighting = { observedAtEpochMs: 1_000, block: ore };
	const diamondSighting = { observedAtEpochMs: 4_000, item: diamond };
	const request = (event, sightings, priority = 'ordinary') => ({ goalRevision: 1, priority, trigger: 'resource_discovery', nativeEvent: {
		event, programId: 'timeline', observation: { player: {}, blocks: [], items: [], observedAtEpochMs: 5_000 },
		...(event === 'program_attention' ? { status: { decision: { resourceSightings: sightings } } } : { result: { resourceSightings: sightings } }),
	} });
	let queued = mergePlannerRequest(request('program_attention', [oreSighting]), request('program_attention', [diamondSighting]));
	queued = mergePlannerRequest(queued, { goalRevision: 1, priority: 'urgent', trigger: 'damage', nativeEvent: { event: 'observation', observation: { player: { health: 18 }, blocks: [], items: [] } } });
	queued = mergePlannerRequest(queued, request('program_ended', [diamondSighting]));
	const built = JSON.parse(buildNativeEventInput(record, queued.nativeEvent).split('\n').slice(1).join('\n'));
	assert.deepEqual(built.resourceSightings, [{ block: ore, src: 'seen 4s' }, { item: diamond, src: 'seen 1s' }], 'queue merging retains each sighting once, dated by its age');
	const nextGoal = mergePlannerRequest(queued, { ...request('program_attention', []), goalRevision: 2 });
	assert.equal(nextGoal.nativeEvent.resourceSightings, undefined, 'old-goal sightings do not cross the revision fence');
});

test('leaves and bulk terrain discover only when explicitly relevant to the model goal', () => {
	const blocks = [blockRow({ x: 4, y: 64, z: 0, blockId: 'minecraft:oak_leaves', tags: ['#minecraft:leaves'] }),
		blockRow({ x: 5, y: 64, z: 0, blockId: 'minecraft:stone' })];
	const state = { resources: new Set(), brokenBlocks: [] };
	assert.equal(rememberResources(state, { blocks }, { currentGoal: 'Beat the game' }), false);
	assert.equal(rememberResources(state, { blocks }, { currentGoal: 'Collect oak leaves and stone' }), true);
	assert.deepEqual(state.resourceSightings.map(s => s.block.blockId), ['minecraft:oak_leaves', 'minecraft:stone']);
});

test('resource relevance established by an observed tag survives retention and event construction', () => {
	const state = { resources: new Set(), brokenBlocks: [] };
	assert.equal(rememberResources(state, { blocks: [{ x: 0, y: 64, z: 0, blockId: 'example:deposit', tags: ['#minecraft:ores'] }] }), true);
	const event = { event: 'observation', observation: { player: {}, blocks: [], items: [] }, resourceSightings: state.resourceSightings };
	const built = JSON.parse(buildNativeEventInput(record, event).split('\n').slice(1).join('\n'));
	assert.equal(built.resourceSightings[0].block.blockId, 'example:deposit');
	assert.deepEqual(built.resourceSightings[0].block.tags, ['#minecraft:ores']);
});

test('a deferred carrier is bounded while the independent discovery still owns its wake', async t => {
	const run = timeline(t);
	await run.publish(1000, { blocks: [chest] });
	run.executor.respond(record, { programId: 'timeline', decisionId: run.wakes[0].status.decision.decisionId, directive: 'continue' });
	await run.publish(4000, { blocks: Array.from({ length: 100 }, (_, x) => ({ ...ore, x: 100 + x })) });
	const sightings = run.executor.status(record).decision.resourceSightings;
	assert.ok(sightings.length <= 8);
	assert.ok(Buffer.byteLength(JSON.stringify(sightings)) <= 1536);
	await run.publish(5000);
	await run.fire(31_000);
	assert.deepEqual(run.wakes.map(w => w.at), [1000, 31_000]);
});

test('a proof whose face is absent from its first publication expires conservatively', async t => {
	const run = timeline(t);
	run.start(); run.settle(true, 1000, exposure([ore]));
	assert.equal(await run.publish(1000), false);
	assert.equal(await run.publish(1500, { blocks: [ore] }), true);
	assert.deepEqual(run.wakes.map(w => w.at), [1500]);
});
