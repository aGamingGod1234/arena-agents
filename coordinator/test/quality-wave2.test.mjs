import assert from 'node:assert/strict';
import test from 'node:test';
import { extractQualityMetrics, compareQualityReports } from '../src/benchmark/quality-metrics.mjs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Observer, validateQualityCapture } from '../../scripts/quality/run-scenarios.mjs';

const profile = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };
const scenario = { setup: { dimension: 'minecraft:the_nether', inventory: [] } };
const row = (type, at, payload) => ({ type, at, payload });
const sample = (at, health = 20, x = 0, extra = {}) => ({ at, health, position: { x, y: 40, z: 0 }, dimension: 'minecraft:the_nether', ...extra });
const observation = (at, health = 20, x = 0, input = {}, extra = {}) => row('observation', at, { observedAtEpochMs: at, position: { x, y: 40, z: 0 }, world: { dimension: 'minecraft:the_nether' }, player: { health }, interaction: { input }, ...extra });
const action = (id, at, type, args = {}, code = 'NO_PATH', state = 'FAILED') => [row('action_command', at, { actionId: id, actionType: type, arguments: args }), row('action_result', at + 10, { actionId: id, state, reasonCode: code })];
const dead = (at, cause = 'burned to death') => row('goal_control', at, { operation: 'dead', death: { diedAtEpochMs: at, cause } });
const extract = extra => extractQualityMetrics({ scenario, profile, startedAt: 0, endedAt: 60000, ...extra });

test('v2 counts failed fights by code without target samples while keeping legacy metrics', () => {
	const codes = ['APPROACH_BLOCKED', 'TARGET_NOT_VISIBLE', 'NO_SEEN_ROUTE', 'NO_PATH', 'LOW_HEALTH'];
	const m = extract({ protocolRows: codes.flatMap((code, i) => action(String(i), i * 100, 'fight_target', { targetId: 'cube' }, code)) });
	assert.equal(m.attacksOnUnreachableTargets, 1);
	assert.equal(m.qualityV2.failedFightRequests, 5);
	assert.deepEqual(m.qualityV2.failedFightRequestsByCode, Object.fromEntries(codes.map(code => [code, 1])));
	assert.equal(m.qualityV2.attacksOnUnreachableTargets, 4);
	assert.equal(m.qualityV2.combatActionsWithoutTargetSample, 5);
});

test('v2 sampled unreachable attacks require a failed request and exclude stop cancellation', () => {
	const protocolRows = [
		...action('killed', 100, 'fight_target', {}, 'TARGET_KILLED', 'SUCCEEDED'),
		...action('bailed', 200, 'fight_target', {}, 'LOW_HEALTH_BAILOUT', 'SUCCEEDED'),
		...action('failed', 300, 'fight_target', {}, 'UNKNOWN_FAILURE'),
		...action('cancelled', 400, 'fight_target', {}, 'ACTION_CANCELLED', 'CANCELLED'),
		row('goal_control', 400, { operation: 'stop' }),
	];
	const m = extract({ protocolRows, targetSamples: ['killed', 'bailed', 'failed', 'cancelled'].map(actionId => ({ actionId, verticalDelta: 5 })) });
	assert.equal(m.attacksOnUnreachableTargets, 4, 'legacy sampled-height rule retained');
	assert.deepEqual(m.qualityV2.unreachableAttacks.map(a => a.actionId), ['failed']);
});

test('v2 classifies additional mob deaths without confusing void or falling objects with falls', () => {
	const causes = ['was impaled by Drowned', 'was killed by Witch using magic', 'was spitted by Llama',
		'was pummeled by Snow Golem', 'was obliterated by a sonically-charged shriek',
		'fell out of the world', 'was squashed by a falling anvil', 'was squashed by a falling block'];
	const v = extract({ protocolRows: causes.map((c, i) => dead((i + 1) * 1000, c)) }).qualityV2;
	assert.deepEqual(v.deathEvents.map(d => d.hazardType), ['mob', 'mob', 'mob', 'mob', 'mob', 'other', 'other', 'other']);
});

test('v2 recognizes all additional edible items in requests and raw held-food use', () => {
	for (const item of ['beetroot', 'dried_kelp', 'tropical_fish', 'pufferfish', 'honey_bottle', 'chorus_fruit', 'spider_eye']) {
		for (const requested of [false, true]) {
			const itemId = `minecraft:${item}`;
			const protocolRows = [observation(0, 5, 0, {}, { interaction: { mainHandItemId: itemId, input: { active: true, use: !requested } } }),
				...(requested ? action('use', 100, 'use_item', {}, 'OK', 'SUCCEEDED') : []), dead(500)];
			assert.equal(extract({ protocolRows }).qualityV2.foodUsedBelow6HpBeforeDeath[0].used, true, `${item} requested=${requested}`);
		}
	}
});

test('v2 low-health outcomes close at death before respawn and retain censored episodes', () => {
	const m = extract({ samples: [sample(0, 5), sample(2000, 20), sample(3000, 7), sample(5000, 12), sample(6000, 6), sample(8000, 10), sample(9000, 6)],
		protocolRows: [dead(1000), ...action('eat', 6500, 'eat_food', {}, 'FOOD_EATEN', 'SUCCEEDED')] });
	assert.equal(m.lowHealthRecoveredWithoutEating.length, 2, 'legacy respawn definition retained');
	assert.deepEqual(m.qualityV2.lowHealthOutcomes, { recoveredByHealing: 1, recoveredWithoutEating: 1, died: 1, censored: 1 });
	assert.equal(m.qualityV2.lowHealthEpisodes[0].outcome, 'died');
	assert.equal(m.qualityV2.lowHealthEpisodes[0].endedAt, 1000);
});

test('v2 detects deaths from counters or respawn when dead events are absent', () => {
	for (const protocolRows of [[], [row('goal_control', 1000, { operation: 'respawn' })]]) {
		const m = extract({ protocolRows, samples: [sample(0, 5, 0, { deathCounter: 0 }), sample(1000, 20, 50, { deathCounter: 1 })] });
		assert.equal(m.qualityV2.lowHealthOutcomes.died, 1);
		assert.equal(m.qualityV2.lowHealthOutcomes.recoveredWithoutEating, 0);
		assert.equal(m.qualityV2.deathEvents.length, 1);
	}
});

test('counter samples delayed until after respawn do not invent a second death', () => {
	const v = extract({ protocolRows: [row('goal_control', 1000, { operation: 'respawn' })],
		samples: [sample(0, 5, 0, { deathCounter: 0 }), sample(1500, 20, 50, { deathCounter: 1 })] }).qualityV2;
	assert.equal(v.deathEvents.length, 1);
	assert.equal(v.lowHealthOutcomes.died, 1);
});

test('counter increments before respawn pair each death only once', () => {
	const v = extract({ protocolRows: [row('goal_control', 1500, { operation: 'respawn' }), row('goal_control', 2500, { operation: 'respawn' })],
		samples: [sample(0, 5, 0, { deathCounter: 0 }), sample(1000, 0, 0, { deathCounter: 1 }), sample(2000, 0, 0, { deathCounter: 2 })] }).qualityV2;
	assert.equal(v.deathEvents.length, 2);
});

test('a counter-proven death cannot become healing through earlier raw recovery', () => {
	const v = extract({ protocolRows: [observation(1500, 20)], samples: [sample(0, 5, 0, { deathCounter: 0 }), sample(2000, 20, 0, { deathCounter: 1 })] }).qualityV2;
	assert.equal(v.lowHealthOutcomes.died, 1);
	assert.equal(v.lowHealthOutcomes.recoveredWithoutEating, 0);
});

test('two counter deaths between samples retain separate respawn lives', () => {
	for (const respawns of [[], [row('goal_control', 500, { operation: 'respawn' }), row('goal_control', 1500, { operation: 'respawn' })]]) {
		const v = extract({ protocolRows: [...respawns, observation(500, 20), observation(1000, 5), observation(1500, 20)],
			samples: [sample(0, 5, 0, { deathCounter: 0 }), sample(2000, 20, 0, { deathCounter: 2 })] }).qualityV2;
		assert.deepEqual(v.deathEvents.map(d => d.at), [500, 1500]);
		assert.equal(v.lowHealthOutcomes.died, 2);
		assert.equal(v.lowHealthOutcomes.recoveredWithoutEating, 0);
	}
});

test('off-hand food identity is independent of selected main-hand slot', () => {
	for (const offHandItemId of ['minecraft:diamond_sword', 'minecraft:cooked_beef']) {
		const mainHandItemId = offHandItemId === 'minecraft:diamond_sword' ? 'minecraft:cooked_beef' : 'minecraft:diamond_sword';
		const v = extract({ protocolRows: [observation(0, 5, 0, {}, { interaction: { mainHandItemId, offHandItemId, input: {} }, inventory: { items: [{ slot: 0, itemId: mainHandItemId }] } }),
			...action('use', 100, 'control', { use: true, hand: 'off_hand', selectedSlot: 0 }, 'OK', 'SUCCEEDED'), dead(500)] }).qualityV2;
		assert.equal(v.foodUsedBelow6HpBeforeDeath[0].used, offHandItemId === 'minecraft:cooked_beef');
	}
});

test('direct mob fireball deaths remain distinct from environmental burning', () => {
	const v = extract({ protocolRows: [dead(1000, 'was fireballed by Ghast'), dead(2000, 'burned to death whilst fighting Wither'), dead(3000, 'fell from a high place whilst escaping Wither')] }).qualityV2;
	assert.equal(v.hazardDeathsByType.mob, 1);
	assert.equal(v.hazardDeathsByType.fire, 1);
	assert.equal(v.hazardDeathsByType.fall, 1);
});

test('a mixed authoritative and inferred death between counter samples stays two deaths', () => {
	const v = extract({ protocolRows: [dead(500), row('goal_control', 700, { operation: 'respawn' }), row('goal_control', 1700, { operation: 'respawn' })],
		samples: [sample(0, 5, 0, { deathCounter: 0 }), sample(2000, 20, 50, { deathCounter: 2 })] }).qualityV2;
	assert.equal(v.deathEvents.length, 2);
});

test('zero-health observations at the death timestamp cannot open a respawn episode', () => {
	const v = extract({ protocolRows: [observation(0, 5), dead(1000), observation(1000, 0), observation(1500, 0), observation(2000, 20)] }).qualityV2;
	assert.equal(v.lowHealthEpisodeCount, 1);
	assert.equal(v.lowHealthOutcomes.recoveredWithoutEating, 0);
});

test('repeated failures match complete canonical arguments and reset after movement or success', () => {
	const protocolRows = [observation(0), ...action('a', 100, 'navigate_to', { x: 5, z: 0 }),
		observation(1000), ...action('b', 1100, 'navigate_to', { z: 0, x: 5 }),
		...action('look', 1200, 'look_at', {}, 'OK', 'SUCCEEDED'),
		observation(2000), ...action('c', 2100, 'navigate_to', { x: 5, z: 0 }),
		observation(3000, 20, 2), observation(4000), ...action('d', 4100, 'navigate_to', { x: 5, z: 0 }),
		...action('e', 4200, 'navigate_to', { x: 5, z: 0 }, 'OK', 'SUCCEEDED'), ...action('f', 4300, 'navigate_to', { x: 5, z: 0 })];
	const v = extract({ protocolRows }).qualityV2;
	assert.equal(v.repeatedIdenticalFailingRequests, 2);
	assert.equal(v.repeatedFailureGroups[0].requests, 3);
});

test('stationary sprint uses raw positions, excludes actual movement, gaps and death boundaries', () => {
	const input = { active: true, sprint: true, forward: 1 };
	const stationary = Array.from({ length: 7 }, (_, i) => observation(i * 500, 20, .01 * i, input));
	assert.equal(extract({ protocolRows: stationary }).qualityV2.stationarySprintSeconds, 3);
	assert.equal(extract({ samples: [sample(0), sample(4000)], protocolRows: stationary.map((r, i) => observation(i * 500, 20, i / 2, input)) }).qualityV2.stationarySprintSeconds, 0);
	assert.equal(extract({ protocolRows: [stationary[0], observation(5000, 20, 0, input)] }).qualityV2.stationarySprintSeconds, 0);
	assert.equal(extract({ protocolRows: [...stationary, dead(1500)] }).qualityV2.stationarySprintSeconds, 0);
	assert.equal(extract({ samples: [sample(0), sample(4000)] }).qualityV2.stationarySprintSeconds, null);
});

test('food below 6 HP is per life, strict threshold, explicit use, and not selection alone', () => {
	const food = extra => ({ interaction: { mainHandItemId: 'minecraft:cooked_beef', input: { active: true, use: true }, ...extra } });
	const v = extract({ protocolRows: [observation(0, 5, 0, {}, food()), dead(1000, 'tried to swim in lava'), row('goal_control', 1200, { operation: 'respawn' }),
		observation(2000, 6, 0, {}, food()), ...action('select', 2200, 'select_item', { itemId: 'minecraft:cooked_beef' }, 'OK', 'SUCCEEDED'),
		observation(2500, 5), dead(3000, 'was slain by Zombie')] }).qualityV2;
	assert.deepEqual(v.foodUsedBelow6HpBeforeDeath.map(d => d.used), [true, false]);
	assert.deepEqual(v.hazardDeathsByType, { lava: 1, fire: 0, fall: 0, mob: 1, other: 0, unknown: 0 });
});

test('fresh held-item evidence replaces stale food selection and cannot cross death', () => {
	const hand = (at, item) => observation(at, 5, 0, {}, { interaction: { mainHandItemId: item, input: {} } });
	const v = extract({ protocolRows: [hand(0, 'minecraft:diamond_sword'), ...action('select', 100, 'select_item', { itemId: 'minecraft:cooked_beef' }, 'OK', 'SUCCEEDED'),
		hand(500, 'minecraft:diamond_sword'), ...action('use', 600, 'use_item', {}, 'OK', 'SUCCEEDED'), dead(1000),
		...action('after-death', 1100, 'use_item', {}, 'OK', 'SUCCEEDED'), dead(2000)] }).qualityV2;
	assert.equal(v.foodUsedBelow6HpBeforeDeath[0].used, false);
	assert.equal(v.foodUsedBelow6HpBeforeDeath[1].used, null);
});

test('failed eating remains an attempt and all death types preserve unknown causes', () => {
	const causes = ['tried to swim in lava', 'burned to death', 'fell from a high place', 'was shot by Skeleton', 'drowned', null];
	const v = extract({ samples: [sample(0, 5)], protocolRows: [...action('eat', 100, 'eat_food', {}, 'FAILED_USE'), ...causes.map((c, i) => dead((i + 1) * 1000, c))] }).qualityV2;
	assert.equal(v.foodUsedBelow6HpBeforeDeath[0].used, true);
	assert.equal(v.foodUsedBelow6HpBeforeDeath[0].completed, false);
	assert.deepEqual(v.hazardDeathsByType, { lava: 1, fire: 1, fall: 1, mob: 1, other: 1, unknown: 1 });
});

test('quality preflight rejects live coordinators without first-response instrumentation', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-capture-'));
	try {
		await mkdir(path.join(dir, 'coordinator/src'), { recursive: true });
		await writeFile(path.join(dir, 'coordinator/src/dynamic-main.mjs'), '');
		await writeFile(path.join(dir, 'coordinator/src/claude-service.mjs'), '');
		await assert.rejects(validateQualityCapture(dir, 'claude'), /first-response capture/);
		const root = path.resolve(import.meta.dirname, '../..');
		assert.equal((await validateQualityCapture(root, 'claude')).verified, true);
		assert.equal((await validateQualityCapture(root, 'codex')).verified, true);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('single-run capture preflight records missing instrumentation without refusing descriptive runs', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-capture-single-'));
	try {
		for (const provider of ['claude', 'codex']) {
			const result = await validateQualityCapture(dir, provider, { required: false });
			assert.equal(result.verified, false);
			assert.equal(result.provider, provider);
			assert.match(result.reason, /b725a2a9/);
			await assert.rejects(validateQualityCapture(dir, provider), /first-response capture/);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('observer captures bounded preparation plan while dead without sampling the player', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-plan-'));
	try {
		const observer = new Observer(dir, { providerWorkspace: dir }, {}, {});
		const legacyPlan = { plan: { steps: [{ label: 'Original plan' }] }, updatedAt: 23, worldId: 'world', goalRevision: 7 };
		await mkdir(path.join(dir, 'player-memory/plans'), { recursive: true });
		await writeFile(path.join(dir, 'player-memory/plans', 'plan.json'), JSON.stringify(legacyPlan));
		observer.trace = { poll: async () => [] };
		observer.provider = { poll: async () => [], rows: [{ timestamp: 1, executionSettings: { controlProtocol: 'goal_spec' }, output: JSON.stringify({ plan: { steps: [{ label: 'Find fortress' }] } }) }] };
		observer.protocol = { rows: [dead(1000)], poll: async () => observer.protocol.rows };
		await observer.poll();
		assert.equal(observer.samples.length, 0);
		assert.deepEqual(observer.initialPlan, legacyPlan);
		const capture = JSON.parse(await readFile(path.join(dir, 'quality-initial-plan.json'), 'utf8'));
		assert.equal(capture.source, 'goal-spec-output');
		assert.equal(JSON.parse(capture.text).steps[0].label, 'Find fortress');
		assert.ok(Buffer.byteLength(capture.text) <= 32768);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('bounded v2 first response is UTF-8 safe and a late response is not initial evidence', () => {
	const m = extract({ providerRows: [{ traceId: 'first-turn', timestamp: 1, output: '' }, { traceId: 'quality-first-message', timestamp: 2, output: '🔥'.repeat(9000) }] });
	assert.ok(Buffer.byteLength(m.qualityV2.firstResponse.text) <= 8192);
	assert.equal(m.qualityV2.firstResponse.truncated, true);
	assert.equal(m.qualityV2.firstResponse.text.includes('\ufffd'), false);
	assert.equal(m.qualityV2.firstResponse.initialResponseVerified, false);
	assert.equal(m.firstTurnUnderstanding.text.length, 18000, 'legacy output left unchanged');
});

test('nested raw observations carry timestamps, stationary sprint and critical food use', () => {
	const rows = Array.from({ length: 7 }, (_, i) => ({ type: 'observation', at: 9999, payload: { observation: observation(i * 500, 5, 0,
		{ active: true, forward: 1, sprint: true }, { interaction: { mainHandItemId: 'minecraft:cooked_beef', input: { active: true, forward: 1, sprint: true, use: true } } }).payload } }));
	const v = extract({ protocolRows: [...rows, dead(3500)] }).qualityV2;
	assert.equal(v.stationarySprintSeconds, 3);
	assert.equal(v.foodUsedBelow6HpBeforeDeath[0].used, true);
});

test('comparison exposes versioned metrics and codes, preserving missing evidence as null', () => {
	const run = protocolRows => ({ scenario: 'S1', profile, measurementStatus: 'MEASURED', metrics: extract({ protocolRows }) });
	const c = compareQualityReports({ runs: [run(action('a', 100, 'fight_target', {}, 'APPROACH_BLOCKED'))] }, { runs: [run([])] })[0];
	assert.equal(c.qualityV2.failedFightRequestsByCode.APPROACH_BLOCKED.delta, -1);
	assert.equal(c.qualityV2.metrics.attacksOnUnreachableTargets.beforeMean, 1);
	assert.equal(c.qualityV2.metrics.stationarySprintSeconds.afterMean, null);
});
