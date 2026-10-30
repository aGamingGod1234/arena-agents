import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryProgressStore, recoveryPosition } from '../src/recovery-progress-wrap.mjs';
import { composeTwoCallView } from '../src/two-call-llm-wrap.mjs';
import { TaskMemoryStore } from '../src/task-memory-store.mjs';

const OW = 'minecraft:overworld', NETHER = 'minecraft:the_nether';
const scope = { agentId: 'a', worldId: 'w', dimension: OW, goalRevision: 1 };
const death = { cause: 'Zombie', dimensionId: NETHER, x: 10.5, y: 71.1, z: -4.5, diedAtEpochMs: 1000000 };
const live = (x = 0.5, z = 0.5, now = 1001000) => ({ ready: true, observedAtEpochMs: now, world: { worldId: 'w', dimension: OW }, player: { x, y: 71.1, z, dead: false }, inventory: { items: [] } });

test('putting regained items away and taking them back cannot reconcile the same loss twice', () => {
	const store = new RecoveryProgressStore();
	const held = (count) => ({ ...live(), inventory: { items: count ? [{ itemId: 'minecraft:diamond', count }] : [] } });
	// The pre-death sample precedes the death it ends (death sample ordering is checked against it).
	store.remember('a', 1, { ...held(12), observedAtEpochMs: death.diedAtEpochMs - 1000 });
	store.remember('a', 1, { death });
	assert.equal(store.remember('a', 3, held(5)).lastLostInventory[0].count, 7);
	store.remember('a', 3, held(0));
	assert.equal(store.remember('a', 4, held(5)).lastLostInventory[0].count, 7);
	assert.equal(store.remember('a', 4, held(8)).lastLostInventory[0].count, 4);
});

test('unobserved chunk aging never becomes a falling countdown or an expiry claim', () => {
	for (const seconds of [10, 130, 600, 10800]) {
		const view = composeTwoCallView({ observedAtEpochMs: death.diedAtEpochMs + seconds * 1000 }, { lastDeath: death, alreadyHave: [] });
		assert.doesNotMatch(view.recovery.facts, /left|expired|gone/);
		assert.match(view.recovery.facts, /6000 entity-ticking ticks/);
		assert.match(view.recovery.facts, /survival unknown/);
		assert.doesNotMatch(view.recovery.facts, /x=|10.5|Zombie/, 'structured death owns position and cause');
	}
});

test('portal plane contact uses the observed axis and fails closed without it', () => {
	for (const axis of ['x', 'z']) for (const offset of [0.42, 0.44, 0.79]) {
		const player = { x: 10.5, y: 64, z: 10.5, dead: false };
		player[axis === 'x' ? 'z' : 'x'] += offset;
		const block = { blockId: 'minecraft:nether_portal', x: 10, y: 64, z: 10, state: { axis } };
		assert.equal(!!recoveryPosition({ ...live(), player, blocks: [block] }).portal, offset < 0.425);
		assert.equal(recoveryPosition({ ...live(), player, blocks: [{ ...block, state: {} }] }).portal, undefined);
	}
});

test('respawn coordinates retain exact observed fractions and unknown dimensions imply no mismatch', () => {
	const store = new RecoveryProgressStore();
	store.remember('a', 1, { death });
	const snapshot = store.remember('a', 3, live());
	assert.deepEqual(snapshot.lastDeath.respawnedAt, { dimension: OW, x: 0.5, y: 71.1, z: 0.5 });
	const { dimensionId, ...unknown } = snapshot.lastDeath;
	assert.doesNotMatch(composeTwoCallView(live(), { ...snapshot, lastDeath: unknown }).recovery.facts, /another dimension|distance|8:1/);
});

test('recovery owns the latest death while durable task queries retain every record', async () => {
	const store = new TaskMemoryStore();
	const elsewhere = { ...scope, dimension: NETHER };
	await store.observe(elsewhere, { death, lastLiveInventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }] } });
	await store.observe(scope, live());
	const summary = await store.summary(scope, { recoveryDeath: death });
	assert.deepEqual(summary.deaths, []);
	assert.equal(summary.totals.deaths, 1);
	assert.equal((await store.query(elsewhere, { kind: 'deaths' })).entries[0].lostInventory[0].count, 1);
	assert.equal((await store.summary(scope)).deaths.length, 1, 'without recovery, recall remains available');
});

test('nearby death count includes unique observed deaths, causes and a fixed time window across revisions', async () => {
	const store = new TaskMemoryStore();
	for (let index = 0; index < 7; index++) {
		const d = { ...death, dimensionId: OW, x: -23.7, y: 68, z: 452.3, diedAtEpochMs: 1000000 + index * 20000 };
		await store.observe(scope, { death: d });
		await store.observe(scope, { death: d });
		await store.observe({ ...scope, goalRevision: 3 + index }, live(-20.5, 454.5, d.diedAtEpochMs + 1000));
		const summary = await store.summary(scope, { recoveryDeath: d });
		assert.deepEqual(summary.recentDeaths, { withinBlocks: 16, windowSeconds: 300, countsByCause: { Zombie: index + 1 } });
	}
	await store.observe(scope, live(100, 100, 1121000));
	assert.equal((await store.summary(scope)).recentDeaths, undefined, 'walking away is not dying here');
	await store.observe(scope, live(-20.5, 454.5, 1500000));
	assert.equal((await store.summary(scope)).recentDeaths, undefined, 'old deaths age out');
	assert.equal((await store.summary({ ...scope, agentId: 'b' })).recentDeaths, undefined);
	assert.equal((await store.summary({ ...scope, worldId: 'other' })).recentDeaths, undefined);
});
