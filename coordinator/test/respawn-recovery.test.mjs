import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryProgressStore } from '../src/recovery-progress-wrap.mjs';
import { composeTwoCallView } from '../src/two-call-llm-wrap.mjs';
import { TaskMemoryStore } from '../src/task-memory-store.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { RuntimeMemoryContext } from '../src/runtime-memory-context.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';

const OW = 'minecraft:overworld', NETHER = 'minecraft:the_nether';
const death = { cause: 'fell', dimensionId: NETHER, x: 20, y: 64, z: 30, diedAtEpochMs: 1_000_000 };
const scope = { agentId: 'a', worldId: 'w', dimension: OW, goalRevision: 1 };
const live = (dimension, x = 10, z = 10, portal = false) => ({
	ready: true, observedAtEpochMs: 1_000_000, player: { dead: false, x: portal ? x + 0.5 : x, y: 64, z: portal ? z + 0.5 : z },
	world: { worldId: 'w', dimension }, inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }] },
	blocks: portal ? [{ blockId: 'minecraft:nether_portal', x, y: 64, z, state: { axis: 'x' } }] : [],
});

test('only observed portal contact at a live dimension change is remembered across respawn revisions', () => {
	const store = new RecoveryProgressStore();
	store.remember('a', 1, live(OW, 80, 80, true));
	store.remember('a', 1, live(NETHER, 10, 10, true));
	store.remember('a', 1, live(NETHER, 20, 30));
	const lost = store.remember('a', 1, { death });
	assert.deepEqual(lost.lastDeath.portal.from, { dimension: OW, x: 80, y: 64, z: 80 });
	assert.deepEqual(lost.lastDeath.portal.to, { dimension: NETHER, x: 10, y: 64, z: 10 });
	const respawn = { ...live(OW, 0, 0), inventory: { items: [] }, observedAtEpochMs: 1_090_000 };
	const restored = store.remember('a', 3, respawn);
	assert.deepEqual(restored.lastDeath.respawnedAt, { dimension: OW, x: 0, y: 64, z: 0 });
	assert.deepEqual(restored.lastDeath.portal, lost.lastDeath.portal);
	assert.equal(restored.lastLostInventory[0].itemId, 'minecraft:iron_pickaxe');
	store.remember('a', 3, live(OW, 100, 100));
	assert.deepEqual(store.snapshot('a').lastDeath.respawnedAt, restored.lastDeath.respawnedAt, 'walking does not move the reference');
	store.remember('a', 3, { death });
	assert.deepEqual(store.snapshot('a').lastDeath, restored.lastDeath, 'duplicate death rendering does not erase recovery facts');
});

test('initial samples, dimension changes without contact, worlds and respawns do not fabricate a portal', () => {
	for (const before of [null, live(OW), { ...live(OW, 10, 10, true), player: { dead: false, x: 11.4, y: 64, z: 10 } },
		{ ...live(OW, 10, 10, true), world: { worldId: 'other', dimension: OW } }]) {
		const store = new RecoveryProgressStore();
		if (before) store.remember('a', 1, before);
		store.remember('a', 1, live(NETHER, 20, 30, true));
		assert.equal(store.remember('a', 1, { death }).lastDeath.portal, undefined);
		store.remember('a', 3, live(OW, 80, 80, true));
		assert.equal(store.remember('a', 3, { death: { ...death, dimensionId: OW, diedAtEpochMs: 2_000_000 } }).lastDeath.portal, undefined);
	}
});

test('elapsed age and the loaded-tick lifetime give no countdown or recovery advice', () => {
	const remembered = { lastDeath: { ...death, respawnedAt: { dimension: OW, x: 0, y: 64, z: 0 } }, lastLostInventory: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }], alreadyHave: [] };
	const facts = (now, lastDeath = remembered.lastDeath) => composeTwoCallView({ observedAtEpochMs: now }, { ...remembered, lastDeath }).recovery.facts;
	assert.match(facts(1_090_000), /Died 1 min ago\. Drops: 6000 entity-ticking ticks \(5 min at 20 TPS\); ticking\/survival unknown/);
	assert.equal(facts(1_090_000), facts(1_119_000), 'an unchanged minute stays byte-stable');
	assert.match(facts(1_300_000), /Died 5 min ago/);
	assert.match(facts(9_000_000), /Died 133 min ago/);
	assert.doesNotMatch(facts(undefined), /Died \d|left/);
	assert.match(facts(1_090_000), /Overworld projection \(8:1\), horizontal not route distance: 288 blocks/);
	assert.match(facts(1_090_000, { ...remembered.lastDeath, dimensionId: OW }), /Horizontal distance to death: 36 blocks/);
	assert.match(facts(1_090_000, { ...remembered.lastDeath, dimensionId: 'minecraft:the_end' }), /route distance unknown/);
	assert.doesNotMatch(facts(1_090_000), /go back|rebuild|should|are gone|recover_corpse/i);
});

test('a respawn with no weapon or armour at night or beside a mob states the fight odds and the cheapest enclosure, nothing more', () => {
	const remembered = { lastDeath: { ...death, dimensionId: OW, respawnedAt: { dimension: OW, x: 0, y: 64, z: 0 } }, lastLostInventory: [], alreadyHave: [] };
	const facts = (dayTime, items = [], dimension = OW, threats = []) => composeTwoCallView({ observedAtEpochMs: 1_090_000, world: { dimension, dayTime }, inventory: { items }, player: { threats } }, remembered).recovery.facts;
	assert.match(facts(24_000 * 3 + 14_000), /Night, no weapon or armour: a fist deals 1 damage and a zombie has 20 health/);
	assert.match(facts(14_000), /1x1 hole 2 deep with one block over it is fully enclosed/);
	assert.doesNotMatch(facts(6_000), /weapon/, 'daytime, nothing near');
	const camped = facts(6_000, [], OW, [{ type: 'minecraft:zombie', distance: 3 }]);
	assert.match(camped, /^.*No weapon or armour: a fist deals 1 damage/, 'a mob beside the respawn point by day');
	assert.doesNotMatch(camped, /Night|until dawn/);
	assert.doesNotMatch(facts(6_000, [], OW, [{ type: 'minecraft:zombie', distance: 30 }]), /weapon/, 'a distant mob');
	assert.doesNotMatch(facts(14_000, [{ itemId: 'minecraft:stone_sword', count: 1 }]), /Night/, 'armed');
	assert.doesNotMatch(facts(14_000, [{ itemId: 'minecraft:leather_helmet', count: 1 }]), /Night/, 'armoured');
	assert.doesNotMatch(facts(14_000, [], NETHER), /Night/, 'no night in the Nether');
	assert.doesNotMatch(facts(14_000), /go back|rebuild|should|are gone|recover_corpse/i);
});

test('task memory retains the observed portal and latest cross-dimension death, scoped to its agent and world', async () => {
	const store = new TaskMemoryStore();
	await store.observe(scope, live(OW, 80, 80, true));
	await store.observe({ ...scope, dimension: NETHER }, live(NETHER, 10, 10, true));
	await store.observe({ ...scope, dimension: NETHER }, { death });
	const after = { ...scope, goalRevision: 3 };
	await store.observe(after, { ...live(OW, 0, 0), inventory: { items: [] } });
	const summary = await store.summary(after);
	assert.equal(summary.deaths[0].dimension, NETHER);
	assert.equal(summary.totals.deaths, 1);
	assert.equal(summary.deaths[0].lostInventory[0].itemId, 'minecraft:iron_pickaxe');
	assert.equal(summary.deaths[0].portal.from.dimension, OW);
	assert.deepEqual(summary.deaths[0].respawnedAt, { dimension: OW, x: 0, y: 64, z: 0 });
	assert.equal((await store.summary({ ...after, agentId: 'b' })).deaths.length, 0);
	assert.equal((await store.summary({ ...after, worldId: 'other' })).deaths.length, 0);
	assert.equal((await store.query(after, { kind: 'deaths' })).total, 0, 'queries stay dimension-scoped');
	await store.flush();
});

test('production observation, task memory and event input retain death facts through dead then revision 3 respawn', async () => {
	let record = { agentId: 'a', goalRevision: 1, currentGoal: 'beat the game', provider: 'codex', model: 'test', reasoningEffort: 'high' };
	const memory = new RuntimeMemoryContext();
	const runtime = new NativeToolRuntime({ registry: { get: () => record }, bridge: { send: async () => {} }, memoryObservation: (r, o, options) => memory.observe(r, o, options) });
	runtime.updateObservation(record, live(OW, 80, 80, true), { eventSequence: 1 });
	runtime.updateObservation(record, live(NETHER, 10, 10, true), { eventSequence: 2 });
	await runtime.dispose(record.agentId, 'goal_dead');
	runtime.updateObservation(record, { death }, { eventSequence: 3, force: true });
	const dead = runtime.decorateObservation(record, { death });
	assert.equal(dead.recovery.lastDeath.portal.from.dimension, OW);
	for (const reason of ['goal_respawn', 'goal_disconnect', 'goal_resume']) await runtime.dispose(record.agentId, reason);
	record = { ...record, goalRevision: 3 };
	const after = { ...live(OW, 0, 0), inventory: { items: [] }, observedAtEpochMs: 1_090_000 };
	runtime.updateObservation(record, after, { eventSequence: 4 });
	const taskMemory = await memory.taskContext(record);
	const input = buildNativeEventInput(record, { event: 'observation', trigger: 'resume', observation: runtime.decorateObservation(record, after), taskMemory });
	const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
	assert.equal(payload.observation.recovery.lastLostInventory[0].itemId, 'minecraft:iron_pickaxe');
	assert.match(payload.observation.recovery.facts, /Died 1 min ago/);
	assert.deepEqual(payload.observation.recovery.lastDeath.respawnedAt, { dimension: OW, x: 0, y: 64, z: 0 });
	assert.deepEqual(payload.taskMemory.deaths, []);
	assert.equal(payload.taskMemory.totals.deaths, 1);
	assert.doesNotMatch(input, /entered the_nether/);
	await memory.flush();
});

test('drop clock counts only time the agent kept the death chunk within simulation distance', () => {
	const store = new RecoveryProgressStore();
	const at = (x, z, now, simulationDistance = 6) => ({ ready: true, observedAtEpochMs: now, player: { dead: false, x, y: 64, z },
		world: { worldId: 'w', dimension: OW, simulationDistance }, inventory: { items: [] } });
	store.remember('a', 1, { ...at(119, -76, 1_000), inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }] } });
	store.remember('a', 1, { death: { cause: 'drowned', dimensionId: OW, x: 119.5, y: 37, z: -75.6, diedAtEpochMs: 2_000 } });
	const facts = (snapshot, now) => composeTwoCallView({ observedAtEpochMs: now }, snapshot).recovery;
	// Respawn 10 chunks away: the 4 s on the death screen aged them, nothing since.
	let view = facts(store.remember('a', 1, at(-40, -46, 6_000)), 6_000);
	assert.match(view.facts, /within 6 chunks \(simulation distance\)/);
	assert.match(view.facts, /about 4 of 5 min left; paused now/);
	assert.doesNotMatch(JSON.stringify(view), /dropTicking/, 'the model reads the clock as prose only');
	assert.equal(view.dropTicking.tickingNow, false, 'the wake header can still read it');
	view = facts(store.remember('a', 1, at(-40, -46, 900_000)), 900_000);
	assert.match(view.facts, /Died 14 min ago\..*about 4 of 5 min left; paused now/);
	// Coming within range resumes ageing, across a goal revision too.
	store.remember('a', 2, at(60, -80, 1_000_000));
	view = facts(store.remember('a', 2, at(60, -80, 1_240_000)), 1_240_000);
	assert.match(view.facts, /under 1 min left; ageing now/);
	view = facts(store.remember('a', 2, at(60, -80, 1_400_000)), 1_400_000);
	assert.match(view.facts, /none of the 5 min left/);
	assert.doesNotMatch(view.facts, /go back|rebuild|should|are gone|recover_corpse/i);
});

test('without a reported simulation distance the drop clock stays unknown', () => {
	const store = new RecoveryProgressStore();
	store.remember('a', 1, { death: { cause: 'fell', dimensionId: OW, x: 0, y: 64, z: 0, diedAtEpochMs: 1_000 } });
	const live = { ready: true, observedAtEpochMs: 5_000, player: { dead: false, x: 300, y: 64, z: 0 }, world: { worldId: 'w', dimension: OW }, inventory: { items: [] } };
	assert.match(composeTwoCallView({ observedAtEpochMs: 5_000 }, store.remember('a', 1, live)).recovery.facts, /ticking\/survival unknown/);
});
