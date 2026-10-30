import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { extractQualityMetrics, parseEntitySample, itemCount, compareQualityReports } from '../src/benchmark/quality-metrics.mjs';
import { applyQualitySetup, normalizeQualitySetup } from '../src/benchmark/quality-scenarios.mjs';
import { parseArgs } from '../../scripts/quality/run-scenarios.mjs';
import { normalizeHeadlessMatrix } from '../src/headless-matrix.mjs';

const scenarios = JSON.parse(await readFile(new URL('../../scripts/quality/scenarios.json', import.meta.url))).scenarios;
const fixtureBytes = await readFile(new URL('./fixtures/quality-owner-nether.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes);
const profile = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };
const extract = extra => extractQualityMetrics({ scenario: scenarios[0], profile, ...extra });

test('owner real Nether trace: exact model calls, tokens, actions and no invented observations', () => {
	assert.ok(fixtureBytes.length < 300 * 1024);
	const m = extract(fixture);
	assert.equal(m.modelCalls, 55);
	assert.deepEqual(m.tokens, { input: 110, cacheRead: 2316276, cacheWrite: 247612, output: 9701 });
	assert.equal(m.costEstimateUsd, 2.638391);
	assert.equal(m.actions, 38);
	assert.equal(m.toolFailuresByCode.NATIVE_ACTION_IN_PROGRESS, 1);
	assert.equal(m.distancePath, null);
	assert.equal(m.damageTaken, null);
	assert.equal(m.firstTurnUnderstanding.text, null);
	assert.equal(m.initialPlanSteps, null);
	assert.ok(m.timeline.some(r => r.tool === 'fight_target' && r.argsSummary.includes('targetId')));
	assert.ok(m.timeline.some(r => r.tool === 'use_item'));
	assert.ok(m.firstTurnUnderstanding.firstSayText.includes('Nether'));
});

test('physical metrics join trace, audit and notebook without counting duplicate actions', () => {
	const traceRows = [
		{ event: 'native_tool_dispatch_started', actionId: 'move', actionType: 'navigate_to', at: 1000, goalRevision: 1 },
		{ event: 'native_tool_action_completed', actionId: 'move', state: 'FAILED', reasonCode: 'NO_PATH', at: 4000, goalRevision: 1 },
		{ event: 'native_tool_dispatch_started', actionId: 'fight', actionType: 'fight_target', at: 4000, goalRevision: 1 },
		{ event: 'native_tool_dispatch_started', actionId: 'eat', actionType: 'eat_food', at: 5000, goalRevision: 1 },
	];
	const protocolRows = [{ envelope: { type: 'action_command', payload: { actionId: 'fight', actionType: 'fight_target', arguments: { targetId: 'zombie' } } }, observedAtMs: 4000 }];
	const samples = [
		{ at: 1000, position: { x: 0, y: 70, z: 0 }, dimension: 'minecraft:the_nether', health: 20, damageTakenCounter: 0, deathCounter: 0 },
		{ at: 2000, position: { x: 0, y: 70, z: 0 }, dimension: 'minecraft:the_nether', health: 8, damageTakenCounter: 120, deathCounter: 0 },
		{ at: 3000, position: { x: 0, y: 66, z: 0 }, dimension: 'minecraft:the_nether', health: 8, fallDistance: 4, damageTakenCounter: 120, deathCounter: 0 },
		{ at: 5000, position: { x: 3, y: 66, z: 0 }, dimension: 'minecraft:the_nether', health: 8, damageTakenCounter: 120, deathCounter: 0 },
		{ at: 6000, position: { x: 3, y: 66, z: 0 }, dimension: 'minecraft:the_nether', health: 10, damageTakenCounter: 120, deathCounter: 0 },
	];
	const m = extract({ traceRows, protocolRows, samples, targetSamples: [{ actionId: 'fight', verticalDelta: 18 }], startedAt: 1000, endedAt: 6000,
		notebookRows: [{ receipts: { put: [{ actionId: 'move', actionType: 'navigate_to', state: 'FAILED', reasonCode: 'NO_PATH', arguments: { x: 5 } }] } }],
		initialPlan: { plan: { steps: [{ status: 'complete', label: 'Diamond armour equipped in Nether' }, { status: 'pending', label: 'Find fortress' }] } } });
	assert.equal(m.actions, 3);
	assert.equal(m.distanceNet, 5);
	assert.equal(m.distancePath, 7);
	assert.equal(m.timeStuckMs, 1000);
	assert.equal(m.damageTaken, 12);
	assert.equal(m.damageEvents[0].source, 'unknown');
	assert.equal(m.falls, 1);
	assert.equal(m.attacksOnUnreachableTargets, 1);
	assert.equal(m.lowHealthEating[0].delayMs, 3000);
	assert.deepEqual(m.initialPlanSteps, { done: 1, pending: 1, active: 0 });
	assert.equal(m.firstTurnUnderstanding.mentionsDimension, true);
	assert.equal(m.firstTurnUnderstanding.mentionsExistingGear, true);
});

test('server NBT samples parse actual vanilla coordinates, health, inventory and counters', () => {
	const s = parseEntitySample('Agent has the following entity data: {Dimension: "minecraft:the_nether", Health: 8.0f, Pos: [1.5d, -40.0d, 3.2d], FallDistance: 4.0f, OnGround: 0b, Inventory: [{Slot: 0b, count: 10, id: "minecraft:oak_log"}], foodLevel: 20}', 123);
	assert.deepEqual(s.position, { x: 1.5, y: -40, z: 3.2 });
	assert.equal(s.health, 8); assert.equal(s.fallDistance, 4);
	assert.equal(s.dimension, 'minecraft:the_nether');
	assert.equal(itemCount(s.inventoryNbt, /_log$/), 10);
	assert.equal(parseEntitySample('{fall_distance: 7.0d}').fallDistance, 7);
	assert.equal(itemCount('[{components: {"minecraft:damage": 5, "minecraft:custom_data": {id: "minecraft:oak_log", count: 99}}, count: 1, id: "minecraft:iron_pickaxe"}]', /:iron_pickaxe$/), 1);
	assert.equal(itemCount('[{components: {"minecraft:custom_data": {id: "minecraft:oak_log", count: 99}}, count: 1, id: "minecraft:iron_pickaxe"}]', /_log$/), 0);
	const nested = parseEntitySample('{Inventory: [{components: {"minecraft:can_break": {blocks: ["minecraft:stone"], show_in_tooltip: 1b}}, count: 1, id: "minecraft:iron_pickaxe"}], EnderItems: [{count: 10, id: "minecraft:oak_log"}]}');
	assert.equal(itemCount(nested.inventoryNbt, /:iron_pickaxe$/), 1);
	assert.equal(itemCount(nested.inventoryNbt, /_log$/), 0);
});

test('all fixtures are data and execute entirely before the real goal starts', async () => {
	assert.deepEqual(scenarios.map(s => s.id), ['S1', 'S1-deltas', 'S2', 'S3', 'S4', 'S5', 'S5b', 'S6', 'S7']);
	for (const s of scenarios) {
		const commands = [];
		const result = await applyQualitySetup(s.setup, async command => { commands.push(command); return { text: 'fixture_agent has the following entity data: [0d, 0d, 0d]' }; }, 'fixture_agent');
		assert.equal(result.agent, 'fixture_agent');
		assert.ok(commands.includes('gamemode survival fixture_agent'));
		assert.ok(commands.every(c => !c.includes('codex start')));
		assert.ok(commands.at(-1).includes('forceload remove'));
	}
	assert.throws(() => normalizeQualitySetup({ ...scenarios[0].setup, commands: ['say one\nstop'] }));
});

test('a loot salt reseeds every random sequence before the fixture commands', async () => {
	const commands = [];
	await applyQualitySetup({ ...scenarios[0].setup, randomSalt: -7 }, async command => { commands.push(command); return { text: 'fixture_agent has the following entity data: [0d, 0d, 0d]' }; }, 'fixture_agent');
	const reset = commands.indexOf('random reset * -7');
	assert.ok(reset >= 0);
	assert.ok(scenarios[0].setup.commands.every(text => commands.indexOf(text.replaceAll('{agent}', 'fixture_agent')) > reset));
	assert.throws(() => normalizeQualitySetup({ ...scenarios[0].setup, randomSalt: 1.5 }), /randomSalt/);
});

test('fixture setup rejection fails and still releases only its own chunk ticket', async () => {
	const commands = [];
	await assert.rejects(applyQualitySetup(scenarios[0].setup, async c => { commands.push(c); return { text: c.startsWith('give') ? 'Incorrect argument for command' : 'fixture_agent has the following entity data: [0d, 0d, 0d]' }; }, 'fixture_agent'), /QUALITY_SETUP/);
	assert.ok(commands.at(-1).includes('forceload remove'));
});

test('matrix accepts explicit quality interventions and preserves strict natural-world checks', () => {
	const scenario = { id: 'S1', ...profile, task: 'beat the game', timeoutMs: 240000, requireFactualSuccess: true,
		qualitySetup: scenarios[0].setup, assert: [{ type: 'rcon', command: 'data get entity {agent} Pos', match: 'entity data' }],
		world: { mode: 'natural', seed: '20261009' } };
	assert.deepEqual(normalizeHeadlessMatrix({ version: 1, scenarios: [scenario] }).scenarios[0].qualitySetup, scenarios[0].setup);
	assert.throws(() => normalizeHeadlessMatrix({ version: 1, scenarios: [{ ...scenario, requireFactualSuccess: false }] }));
});

test('CLI supports requested Claude and GPT models and rejects misspelled flags', () => {
	const args = parseArgs(['--scenarios', 'S1,S5', '--provider', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'low', '--runs', '2', '--jar', 'build/test.jar', '--out', 'runtime/test']);
	assert.equal(args.provider, 'codex'); assert.equal(args.runs, 2);
	assert.deepEqual(args.scenarios, ['S1', 'S5']);
	assert.throws(() => parseArgs(['--run', '2']));
});

test('comparison includes means, null coverage, tokens and every attempted run', () => {
	const run = (calls, status = 'MEASURED') => ({ scenario: 'S1', profile, measurementStatus: status, metrics: { modelCalls: calls, tokens: { input: calls * 10 } } });
	const [c] = compareQualityReports({ runs: [run(2), run(4), run(0, 'UNAVAILABLE')] }, { runs: [run(4), run(6)] });
	assert.equal(c.metrics.modelCalls.beforeMean, 3); assert.equal(c.metrics.modelCalls.afterMean, 5);
	assert.equal(c.metrics.modelCalls.delta, 2); assert.equal(c.metrics.modelCalls.percent, 2 / 3 * 100);
	assert.equal(c.metrics.modelCalls.before.n, 2);
	assert.equal(c.metrics.damageTaken.delta, null);
	assert.equal(c.tokens.input.delta, 20);
	assert.equal(c.perRun.before.length, 3);
	assert.equal(c.initialPlanSteps.done.delta, null);
	assert.equal(c.lowHealthEatingDelayMs.delta, null);
	const detailed = compareQualityReports({ runs: [{ ...run(2), metrics: { toolFailuresByCode: { NO_PATH: 2 }, goalProgressMilestones: [{ id: '10-logs', elapsedMs: 100 }] } }] },
		{ runs: [{ ...run(2), metrics: { toolFailuresByCode: {}, goalProgressMilestones: [] } }] })[0];
	assert.equal(detailed.toolFailuresByCode.NO_PATH.delta, -2);
	assert.equal(detailed.goalProgressMilestones['10-logs'].reachedShare.delta, -1);
});

test('goal-spec overhead joins token and USD totals without counting native summaries or first-message records twice', () => {
	const rows = [{ event: 'native_model_call', provider: 'claude', agentId: 'agent', goalRevision: 1, totalMs: 10, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 5 }];
	const providerRows = [
		{ executionSettings: { controlProtocol: 'goal_spec' }, provider: 'claude', model: 'claude-sonnet-5-5', tokens: { input: 2, cached: 3, cacheWrite: 4, output: 5 }, costUsd: .03, output: 'Planner JSON' },
		{ traceId: 'quality-first-message', output: 'I am in the Nether with diamond gear.' },
		{ traceId: 'trace-native', executionSettings: { controlProtocol: 'native_tools' }, tokens: { input: 999 }, output: '' },
	];
	const m = extract({ traceRows: rows, providerRows });
	assert.equal(m.modelCalls, 2); assert.equal(m.playModelCalls, 1); assert.equal(m.overheadModelCalls, 1);
	assert.deepEqual(m.tokens, { input: 72, cacheRead: 23, cacheWrite: 14, output: 10 });
	assert.equal(m.costEstimateUsd, m.playCostEstimateUsd + m.overheadCostUsd);
	assert.equal(m.firstTurnUnderstanding.text, 'I am in the Nether with diamond gear.');
	assert.equal(m.firstTurnUnderstanding.mentionsExistingGear, true);
	assert.equal(m.providerMismatches, 0, 'the Sonnet goal translator is preparation, not a gameplay model mismatch');
	assert.equal(extract({ traceRows: rows, providerRows: [{ ...providerRows[0], provider: 'codex' }] }).providerMismatches, 1);
	const unknown = extract({ traceRows: rows, providerRows: [{ ...providerRows[0], costUsd: undefined }] });
	assert.equal(unknown.costEstimateUsd, m.costEstimateUsd);
	assert.equal(unknown.overheadReportedCostUsd, null);
	assert.ok(unknown.playCostEstimateUsd > 0);
});

test('terminal server observation preserves the log milestone before player removal', () => {
	const m = extract({ startedAt: 100, endedAt: 200, protocolRows: [{ type: 'goal_control', at: 200, payload: { operation: 'complete', updatedAtEpochMs: 200 } }, { type: 'observation', payload: {
		status: 'COMPLETED', observedAtEpochMs: 201, inventory: { items: [{ itemId: 'minecraft:oak_log', count: 10 }] },
	} }] });
	assert.deepEqual(m.goalProgressMilestones, [{ id: '10-logs', at: 201, elapsedMs: 101 }]);
});

test('natural Nether starts contain no terrain edits and validate biome and footing', async () => {
	for (const id of ['S1', 'S1-deltas']) {
		const s = scenarios.find(s => s.id === id);
		assert.deepEqual(s.setup.commands, []);
		assert.equal(s.setup.naturalGround, true);
		assert.equal(s.setup.freezeUntilGoalStart, true);
		const commands = [];
		await applyQualitySetup(s.setup, async c => { commands.push(c); return { text: 'fixture_agent has the following entity data: [0d, 0d, 0d]' }; }, 'fixture_agent');
		assert.ok(commands.some(c => c.includes(`if biome ~ ~ ~ ${s.setup.expectedBiome}`)));
		assert.ok(commands.some(c => c.includes('unless block ~ ~-1 ~ minecraft:lava')));
		assert.ok(!commands.some(c => c.includes('fill ') || c.includes('setblock ')));
		await assert.rejects(applyQualitySetup(s.setup, async c => ({ text: c.includes('if biome') ? '' : 'ok' }), 'fixture_agent'), /QUALITY_SETUP_BIOME/);
		await assert.rejects(applyQualitySetup(s.setup, async c => ({ text: c.includes('if biome') ? 'fixture_agent has the following entity data: [0d, 0d, 0d]' : '' }), 'fixture_agent'), /QUALITY_SETUP_GROUND/);
	}
});

test('S5b exposes the elevated husk without altering the archived S5 fixture or defaults', () => {
	const legacy = scenarios.find(s => s.id === 'S5'), variant = scenarios.find(s => s.id === 'S5b');
	assert.equal(createHash('sha256').update(JSON.stringify(legacy)).digest('hex'), 'c78b3ad77168242be8ee0280fc7397c99fb53596f1ac8aa97be5cad87ee9d8fb');
	assert.ok(variant, 'a separate variant is required');
	assert.equal(variant.variantOf, 'S5');
	assert.equal(variant.goal, legacy.goal);
	assert.equal(parseArgs([]).scenarios.includes('S5b'), false);
	const eye = [.5, 1.62, .5];
	const intersects = (target, min, max) => {
		let enter = 0, exit = 1;
		for (let i = 0; i < 3; i++) {
			const delta = target[i] - eye[i];
			if (delta === 0) { if (eye[i] < min[i] || eye[i] > max[i]) return false; continue; }
			const a = (min[i] - eye[i]) / delta, b = (max[i] - eye[i]) / delta;
			enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
		}
		return enter <= exit;
	};
	const [x, y, z] = variant.setup.mobs[0].offset;
	for (const height of [.975, 1.74]) assert.equal(intersects([.5 + x, y + height, .5 + z], [4, 7, 1], [5, 8, 2]), false, 'body centre and eyes clear the single support block');
	assert.equal(intersects([4.5, 19.74, 1.5], [3, 17, 0], [6, 18, 3]), true, 'old wide slab occludes the same eye ray');
	assert.ok(y >= 8 && Math.hypot(x, y, z) > 3, 'target begins beyond melee and pad access');
	assert.ok(variant.setup.commands.includes('execute at {agent} run setblock ~4 ~7 ~1 minecraft:stone'));
	assert.ok(variant.setup.commands.includes('execute at {agent} run tp {agent} ~ ~ ~ -75 -63'), 'initial view faces the visible target');
});

test('used-bed preparation uses empty hands, requires an unforced bed-head receipt and restores the stage position', async () => {
 const setup={dimension:'minecraft:the_nether',position:[9.5,37,24.5],commands:[],inventory:[{item:'minecraft:iron_pickaxe',count:1}],usedBedSpawn:{dimension:'minecraft:overworld',position:[-18,-54,94]},freezeUntilGoalStart:true};
 const calls=[];
 let sneaking=true,bedUsed=false;
 const command=async text=>{
  calls.push(text);
  if(text==='player P unsneak')sneaking=false;
  if(text==='player P use once')bedUsed=!sneaking;
  return {text:/data get entity .* respawn/.test(text)?(bedUsed?'P has the following entity data: {pos: [I; -17, -54, 94], dimension: "minecraft:overworld"}':'Found no elements matching respawn'):/data get entity .* Pos/.test(text)?'P has the following entity data: [9.5d, 37.0d, 24.5d]':'ok'};
 };
 const receipt=await applyQualitySetup(setup,command,'P');
 assert.ok(calls.includes('player P use once'));
 assert.ok(calls.indexOf('clear P')<calls.indexOf('player P use once'));
 assert.ok(calls.indexOf('player P use once')<calls.indexOf('give P minecraft:iron_pickaxe 1'));
 assert.ok(calls.includes('execute in minecraft:the_nether run tp P 9.5 37 24.5'));
 assert.ok(!calls.some(c=>/spawnpoint/.test(c)));
 assert.ok(receipt.receipts.some(r=>r.command==='used bed respawn receipt'));
 for(const respawn of ['{pos: [I; -17, -54, 94], dimension: "minecraft:overworld", forced: 1b}','{pos: [I; 0, 64, 0], dimension: "minecraft:overworld"}']) {
  await assert.rejects(()=>applyQualitySetup(setup,async text=>/data get entity .* respawn/.test(text)?{text:respawn}:command(text),'P'),/BED_NOT_USED/);
 }
 for(const bed of [{dimension:'minecraft:the_nether',position:[0,64,0]},{dimension:'minecraft:overworld',position:[0,64.5,0]},{dimension:'minecraft:overworld',position:[]}])assert.throws(()=>normalizeQualitySetup({...setup,usedBedSpawn:bed}),/usedBedSpawn/);
});
