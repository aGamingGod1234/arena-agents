import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseLadderArgs, runLadder, ladderRow, formatLadderReport } from '../../scripts/quality/run-ladder.mjs';
import { normalizeQualitySetup, applyQualitySetup } from '../src/benchmark/quality-scenarios.mjs';
import { readArtifactReport } from '../src/benchmark/report-artifacts.mjs';

test('parallel workers require bounded distinct port blocks', () => {
	assert.throws(() => parseLadderArgs(['--parallel', '2']), /port-base/);
	assert.throws(() => parseLadderArgs(['--parallel', '0']), /1..8/);
	assert.throws(() => parseLadderArgs(['--parallel', '2', '--port-base', '65530']), /exceed/);
	assert.throws(() => parseLadderArgs(['--arms', 'arms.json']), /paired/);
	const options = parseLadderArgs(['--parallel', '2', '--port-base', '28100']);
	assert.equal(options.runs, 1);
	assert.equal(options.scenarios, null);
});

test('ladder uses supported setups, non-premet inventory goals, and bounded budgets', async () => {
	const data = JSON.parse(await readFile(new URL('../../scripts/quality/ladder.json', import.meta.url), 'utf8'));
	assert.ok(data.scenarios.length >= 18 && data.scenarios.length <= 24);
	assert.equal(new Set(data.scenarios.map(s => s.id)).size, data.scenarios.length);
	for (const s of data.scenarios) {
		normalizeQualitySetup(s.setup);
		assert.ok(s.durationBudgetMs >= 300000 && s.durationBudgetMs <= 1200000);
		assert.equal(s.runPolicy.clock, 'goal-start');
		assert.ok(s.notes && s.successCheck && s.startState);
		for (const previous of s.handoffFrom) assert.ok(data.scenarios.some(s => s.id === previous));
	}
	assert.throws(() => normalizeQualitySetup({ ...data.scenarios[0].setup, standingOn: 'stone bricks' }), /standingOn/);
});

test('parallel execution isolates ports and artifacts, keeps failed launches and repetitions', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'ladder-'));
	const active = new Set(), dirs = new Set(), calls = [];
	try {
		const options = parseLadderArgs(['--scenarios', 'L-A1,L-A3,L-H1', '--runs', '2', '--parallel', '2', '--port-base', '28100', '--out', out]);
		const runs = await runLadder(options, async o => {
			assert.ok(!active.has(o.portBase)); active.add(o.portBase);
			assert.ok(!dirs.has(o.out)); dirs.add(o.out); calls.push(o);
			await new Promise(r => setTimeout(r, o.scenarios[0] === 'L-A1' ? 15 : 2));
			active.delete(o.portBase);
			if (o.scenarios[0] === 'L-A3') throw new Error('occupied port');
			return { runs: [{ scenario: o.scenarios[0], repetition: o.repetition, profile: { provider: o.provider }, goalCompleted: true, measurementStatus: 'MEASURED', metrics: { playWallTimeMs: 60000, deaths: 0, bodyIdleShare: 0.25, toolFailuresByCode: {} } }] };
		});
		assert.equal(calls.length, 6);
		assert.equal(runs.length, 6);
		assert.equal(runs.filter(r => r.termination === 'LAUNCH_ERROR').length, 2);
		assert.deepEqual([...new Set(calls.map(o => o.portBase))].sort(), [28100, 28110]);
		const report = await readArtifactReport(path.join(out, 'results.json'));
		assert.deepEqual(report.runs.map(r => r.scenario), ['L-A1', 'L-A1', 'L-A3', 'L-A3', 'L-H1', 'L-H1']);
		assert.match(await readFile(path.join(out, 'ladder-report.md'), 'utf8'), /occupied port/);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('report distinguishes verified completion, missing evidence and observed failure', () => {
	const pass = { scenario: 'L-A1', goalCompleted: true, measurementStatus: 'INCOMPLETE', metrics: { playWallTimeMs: 120000, bodyIdleShare: 0.2, deaths: 0, toolFailuresByCode: { BLOCKED: 2 } } };
	assert.equal(ladderRow(pass).bodyBusyPct, 80);
	assert.equal(ladderRow(pass).minutesToGoal, 2);
	assert.equal(ladderRow({ ...pass, goalCompleted: false }).minutesToGoal, null);
	assert.equal(ladderRow({ metrics: null }).deaths, null);
	assert.equal(ladderRow({ metrics: null }).bodyBusyPct, null);
	assert.match(formatLadderReport([pass]), /PASS \(INCOMPLETE\)/);
});

test('fixture construction waits for both dimensions and releases every owned chunk after failure', async () => {
	const commands = [];
	const setup = { dimension: 'minecraft:the_nether', position: [0,80,0], freezeUntilGoalStart: true,
		loadChunks: [{ dimension: 'minecraft:overworld', position: [3,81,-3] }], commands: ['fill 0 0 0 1 1 1 minecraft:stone'] };
	await assert.rejects(applyQualitySetup(setup, async c => {
		commands.push(c);
		return { text: c.startsWith('fill ') ? 'That position is not loaded' : c.includes(' if loaded ') ? 'The time is 0' : 'ok' };
	}, 'Check'), /not loaded/);
	assert.ok(commands.some(c => c.includes('minecraft:the_nether if loaded 0 80 0')));
	assert.ok(commands.some(c => c.includes('minecraft:overworld if loaded 3 81 -3')));
	assert.ok(commands.includes('execute in minecraft:overworld run forceload remove 3 -3'));
	assert.equal(commands.at(-1), 'execute in minecraft:the_nether run forceload remove 0 0');
});

test('structure placement requires the declared floor and checks frozen summoned entities after a tick', async () => {
	const commands = [];
	await applyQualitySetup({ dimension: 'minecraft:the_nether', position: [0,80,0], standingOn: 'minecraft:nether_bricks', airBlock: 'minecraft:cave_air',
		caveMaxY: 50, caveMinY: 49, freezeUntilGoalStart: true, commands: [],
		mobs: [{ id: 'minecraft:piglin', offset: [6,0,0], tag: 'trader' }] }, async c => {
		commands.push(c);
		return { text: c.includes(' if loaded ') ? 'The time is 0' : c.includes(' run tp ') && c.includes(' if block ') ? 'Teleported Check' : 'Check has the following entity data: [0d,50d,0d]' };
	}, 'Check');
	assert.ok(commands.some(c => c.includes('if block ~ ~-1 ~ minecraft:nether_bricks run tp')));
	assert.ok(commands.some(c => c.includes('if block ~ ~ ~ minecraft:cave_air if block ~ ~1 ~ minecraft:cave_air')));
	const summon = commands.findIndex(c => c.includes(' summon minecraft:piglin'));
	const verify = commands.findIndex(c => c.includes('tag=trader'));
	assert.ok(commands.slice(summon + 1, verify).includes('tick step 1'));
});

test('every ladder successCheck parses into a machine-readable evaluator spec', async () => {
	const { parseSuccessCheck } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const data = JSON.parse(await readFile(new URL('../../scripts/quality/ladder.json', import.meta.url), 'utf8'));
	for (const s of data.scenarios) assert.ok(parseSuccessCheck(s.successCheck).type, s.id);
	assert.deepEqual(parseSuccessCheck('inventory_contains_any: cooked_beef|cooked_porkchop >=20'), { type: 'inventory', items: ['minecraft:cooked_beef', 'minecraft:cooked_porkchop'], count: 20, sum: true });
	assert.throws(() => parseSuccessCheck('vibes: good'), /Unparseable/);
});

test('evaluator passes on any in-budget sample and reports time to pass', async () => {
	const { LadderEvaluator, parseSuccessCheck } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const inv = (...items) => `[${items.map(([id, count], i) => `{count: ${count}, Slot: ${i}b, id: "minecraft:${id}"}`).join(', ')}]`;
	const run = (check, samples, options) => { const e = new LadderEvaluator(parseSuccessCheck(check), options); for (const s of samples) if (e.push(s)) break; return e.finish(); };
	const crafts = run('inventory: iron_pickaxe, bucket >=1', [
		{ at: 1000, inventoryNbt: inv(['iron_pickaxe', 1]) }, { at: 5000, inventoryNbt: inv(['iron_pickaxe', 1], ['bucket', 1]) }], { goalStartAt: 1000, budgetMs: 10000 });
	assert.deepEqual([crafts.pass, crafts.timeToPassMs], [true, 4000]);
	assert.equal(run('inventory: bucket >=1', [{ at: 20000, inventoryNbt: inv(['bucket', 1]) }], { goalStartAt: 1000, budgetMs: 10000 }).pass, false, 'after the budget');
	const any = run('inventory_contains_any: cooked_beef|cooked_porkchop >=20', [{ at: 1, inventoryNbt: inv(['cooked_beef', 12], ['cooked_porkchop', 8]) }], { goalStartAt: 0 });
	assert.equal(any.pass, true);
	assert.equal(run('any advancement: nether/find_fortress OR nether/find_bastion', [{ at: 1, advancements: ['nether/find_bastion'] }], { goalStartAt: 0 }).pass, true);
	const near = { at: 1, dimension: 'minecraft:overworld', position: { x: 3, y: 81, z: 1 }, inventoryNbt: inv(['ender_eye', 12]) };
	const check = 'all: inventory ender_eye >=12 AND position_within overworld (2,81,0) radius6';
	assert.equal(run(check, [near], { goalStartAt: 0 }).pass, true);
	assert.equal(run(check, [{ ...near, dimension: 'minecraft:the_nether' }], { goalStartAt: 0 }).pass, false);
	assert.equal(run('advancement: story/enter_the_nether', [{ at: 1, advancements: [] }], { goalStartAt: 0, logAdvancements: ['story/enter_the_nether'] }).pass, false, 'unscoped advancement strings cannot prove success');
});

test('survive check needs the full duration and no death', async () => {
	const { LadderEvaluator, parseSuccessCheck } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const spec = parseSuccessCheck('survive_duration: 100 ticks; any death fails attempt');
	const feed = samples => { const e = new LadderEvaluator(spec, { goalStartAt: 0 }); samples.forEach(s => e.push(s)); return e.finish(); };
	assert.equal(feed([{ at: 1000, deathCounter: 0 }, { at: 5000, deathCounter: 0 }]).pass, true);
	assert.equal(feed([{ at: 1000, deathCounter: 0 }, { at: 2000, deathCounter: 1 }, { at: 9000, deathCounter: 1 }]).pass, false);
	assert.equal(feed([{ at: 1000, deathCounter: 0 }, { at: 4000, deathCounter: 0 }]).pass, false);
});

test('ladder rows separate the evaluator verdict from the agent goalCompleted', () => {
	const row = ladderRow({ scenario: 'L-A3', goalCompleted: false, measurementStatus: 'MEASURED', metrics: { playWallTimeMs: 300000 }, evaluation: { status: 'EVALUATED', pass: true, timeToPassMs: 27000, source: 'samples' } });
	assert.deepEqual([row.result, row.goalCompleted, row.evaluatorPass, row.minutesToGoal], ['PASS', false, true, 0.45]);
	assert.match(formatLadderReport([{ scenario: 'L-A3', goalCompleted: false, evaluation: { status: 'EVALUATED', pass: true, timeToPassMs: 27000 } }]), /\| PASS .*\| 0\.45 \| pass \| no \|/);
});

test('surface starts use the heightmap with the advertised biome and fail setup instead of going underground', async () => {
	const data = JSON.parse(await readFile(new URL('../../scripts/quality/ladder.json', import.meta.url), 'utf8'));
	const a1 = data.scenarios.find(s => s.id === 'L-A1').setup;
	assert.equal(a1.expectedBiome, 'minecraft:forest');
	assert.equal(a1.locate.id, 'minecraft:forest');
	const commands = [];
	await applyQualitySetup({ ...a1, locate: undefined, commands: [] }, async c => {
		commands.push(c);
		return { text: c.includes(' if loaded ') ? 'The time is 0' : c.includes(' run tp ') && c.includes('motion_blocking_no_leaves') ? 'Teleported Check' : 'Check has the following entity data: [134.5d,66d,488.5d]' };
	}, 'Check');
	const search = commands.find(c => c.includes(' run tp ') && c.includes('motion_blocking_no_leaves'));
	assert.ok(search.includes('if biome ~ ~ ~ minecraft:forest'));
	assert.ok(commands.some(c => c.includes('as Check at @s positioned over motion_blocking_no_leaves if entity @s[distance=..6]')));
	assert.ok(!commands.some(c => / positioned [\d.]+ -?\d+ [\d.]+ if block/.test(c)), 'no vertical scan for surface starts');
	await assert.rejects(applyQualitySetup({ ...a1, locate: undefined, commands: [] }, async c => ({ text: c.includes(' if loaded ') ? 'The time is 0' : c.includes('motion_blocking_no_leaves') && c.includes(' run tp ') ? 'Nothing matched' : 'Check has the following entity data: [134.5d,66d,488.5d]' }), 'Check'), /QUALITY_SETUP_SURFACE_GROUND_SEARCH/);
});

test('frozen fixtures step observation ticks after setup and record the prepared pose', async () => {
	const commands = [];
	const receipt = await applyQualitySetup({ dimension: 'minecraft:overworld', position: [0, 80, 0], freezeUntilGoalStart: true, commands: [] },
		async c => { commands.push(c); return { text: c.includes(' if loaded ') ? 'The time is 0' : 'Check has the following entity data: [1d,70d,2d]' }; }, 'Check');
	assert.deepEqual(receipt.definition.freshObservation.position, [1, 70, 2]);
	const survival = commands.lastIndexOf('gamemode survival Check');
	assert.ok(commands.slice(survival).filter(c => c === 'tick step 1').length >= 3);
});

const sample = (at, gameTime, extra = {}) => ({ at, gameTime, position: { x: 0, y: 64, z: 0 }, dimension: 'minecraft:overworld', health: 20, deathCounter: 0, advancements: [], ...extra });

test('survive_duration counts game ticks, not wall time', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const check = { successCheck: 'survive_duration: 1000 ticks; any death fails attempt', durationBudgetMs: 600000, goalStartAt: 0 };
	// Server at half speed: 50 s of wall time is only 500 ticks.
	const slow = Array.from({ length: 51 }, (_, i) => sample(i * 1000, 100 + i * 10));
	assert.equal(evaluateSamples(slow, check).pass, false);
	// Server at full speed passes at exactly 1000 ticks after the goal-start tick.
	const fast = Array.from({ length: 60 }, (_, i) => sample(i * 1000, 100 + i * 20));
	const ok = evaluateSamples(fast, check);
	assert.equal(ok.pass, true);
	assert.equal(ok.passTicks, 1000);
	assert.equal(ok.timeToPassMs, 50000);
});

test('samples without gameTime take their tick from the protocol observation clock', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const rows = [0, 60000].map(at => ({ envelope: { type: 'observation', payload: { observedAtEpochMs: at, world: { gameTime: at / 100 } } } }));
	const samples = Array.from({ length: 61 }, (_, i) => sample(i * 1000, undefined));
	const slow = evaluateSamples(samples, { successCheck: 'survive_duration: 1000 ticks', durationBudgetMs: 600000, goalStartAt: 0, protocolRows: rows });
	assert.equal(slow.pass, false); // 60 s of wall time is only 600 ticks on this clock
});

test('a later death never overwrites a recorded pass', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const samples = [sample(0, 0), sample(1000, 20, { advancements: ['nether/find_fortress'] }), sample(2000, 40, { deathCounter: 1 })];
	const evaluation = evaluateSamples(samples, { successCheck: 'advancement: nether/find_fortress', durationBudgetMs: 60000, goalStartAt: 0 });
	assert.equal(evaluation.pass, true);
	assert.equal(evaluation.timeToPassMs, 1000);
	assert.equal(evaluation.postPass.died, true);
	assert.deepEqual(evaluation.evidence.advancements, ['nether/find_fortress']);
	const row = ladderRow({ scenario: 'L-B1', goalCompleted: false, termination: 'DEAD', evaluation, metrics: { playWallTimeMs: 3000, deaths: 1 } });
	assert.equal(row.result, 'PASS');
	assert.match(row.passedThen, /passed, then died at 2\.0s/);
});

test('a recorded pass survives a failing re-evaluation and relabels the runner termination', async () => {
	const { keepRecordedPass } = await import('../../scripts/quality/run-ladder.mjs');
	const recorded = { status: 'EVALUATED', pass: true, source: 'samples' };
	assert.equal(keepRecordedPass(recorded, { status: 'NO_ARTIFACTS', pass: false }), recorded);
	assert.equal(keepRecordedPass(undefined, { status: 'EVALUATED', pass: false }).pass, false);
});

test('EVALUATOR_PASS requests runner closeout before any owned-process hard stop', async () => {
	const { Observer } = await import('../../scripts/quality/run-scenarios.mjs');
	let kills = 0;
	const dir = await mkdtemp(path.join(os.tmpdir(), 'arena-closeout-'));
	const o = new Observer(dir, { protocolAudit: '', providerTurns: '' }, {}, {}, { stopRetryMs: 0, hardStop: async () => { kills++; } });
	o.agent = 'player'; o.rcon = { command: async () => ({ text: 'Stopped player' }) };
	await o.requestStop('EVALUATOR_PASS', { timeToPassMs: 1 });
	await o.progressStop();
	assert.equal(kills, 0);
	assert.equal(o.stopRequest.state, 'pending');
	assert.equal(JSON.parse(await readFile(path.join(dir, 'quality-stop.json'), 'utf8')).reason, 'EVALUATOR_PASS');
	await rm(dir, { recursive: true, force: true });
	const p = new Observer('.', { protocolAudit: '', providerTurns: '' }, {}, {}, { stopRetryMs: 0, hardStop: async () => { kills++; } });
	p.agent = 'player'; p.rcon = { command: async () => ({ text: 'Stopped player' }) };
	await p.requestStop('ADVANCEMENT');
	await p.progressStop();
	assert.equal(kills, 0); // other reasons keep waiting for the goal to end
});

test('server completion of a different predicate cannot replace the requested advancement', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const rows = (predicate) => [
		{ envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 1000, goalSpec: { predicate } } } },
		{ envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'complete', updatedAtEpochMs: 31000 } } },
	];
	const check = { successCheck: 'advancement: story/mine_stone', durationBudgetMs: 600000, goalStartAt: 1000 };
	const samples = [{ at: 2000, advancements: [], inventoryNbt: '' }];
	const factual = evaluateSamples(samples, { ...check, protocolRows: rows({ type: 'inventory_contains', itemId: 'minecraft:stone', count: 1 }) });
	assert.deepEqual([factual.pass, factual.source, factual.timeToPassMs], [false, null, null]);
	const row = ladderRow({ scenario: 'L-A3', goalCompleted: true, evaluation: factual, metrics: { playWallTimeMs: 31000 } });
	assert.deepEqual([row.result, row.evaluatorSource, row.minutesToGoal], ['FAIL', null, null]);
	assert.match(formatLadderReport([{ scenario: 'L-A3', goalCompleted: true, evaluation: factual }]), /\| fail \| yes \| n\/a \|/);
	const confirmed = evaluateSamples(samples, { ...check, protocolRows: rows({ type: 'operator_confirmed' }) });
	assert.equal(confirmed.pass, false);
});
