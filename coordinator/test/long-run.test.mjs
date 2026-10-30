import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { buildLongRunDefinition, extractLongRunTimeline, formatLongRunTimeline, randomSeed, LONG_RUN_MILESTONES } from '../src/benchmark/long-run.mjs';
import { applyQualitySetup } from '../src/benchmark/quality-scenarios.mjs';
import { normalizeHeadlessScenario } from '../src/headless-matrix.mjs';
import { SpendLedger } from '../src/benchmark/spend-ledger.mjs';
import { Observer, buildQualityScenario, resolveQualityScenarios } from '../../scripts/quality/run-scenarios.mjs';
import { parseLongArgs, runLong, longRunAllowance } from '../../scripts/quality/run-long.mjs';

const profile = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };
const scenarios = JSON.parse(await readFile(new URL('../../scripts/quality/scenarios.json', import.meta.url))).scenarios;

test('long-run definition is a fresh random-seed survival world at the vanilla world spawn with a 3-hour goal window', () => {
	const seeds = new Set(Array.from({ length: 20 }, () => randomSeed()));
	assert.ok(seeds.size > 15); for (const seed of seeds) assert.ok(BigInt(seed) >= -(2n ** 63n) && BigInt(seed) < 2n ** 63n);
	assert.equal(randomSeed(Buffer.alloc(8, 0xff)), '-1');
	const definition = buildLongRunDefinition({ seed: '123', windowMs: 3 * 3600000, spendCapUsd: 79.5 });
	assert.equal(definition.goal, 'Beat the game');
	const [resolved] = resolveQualityScenarios([definition], { scenarios: ['LONG'] });
	const built = normalizeHeadlessScenario(buildQualityScenario(resolved, { id: 'long-1', profile }));
	assert.equal(built.playWindowMs, 10800000); assert.equal(built.timeoutMs, 10800000 + 300000); assert.equal(built.continueAfterDeath, true);
	assert.deepEqual(built.world.spawn, { policy: 'world_spawn' }); assert.equal(built.world.gameMode, 'survival'); assert.equal(built.world.seed, '123');
	assert.equal(built.task, 'Beat the game', 'the model sees only the goal');
	assert.throws(() => buildLongRunDefinition({ windowMs: 13 * 3600000, spendCapUsd: 1 }), /windowMs/);
	assert.throws(() => buildLongRunDefinition({ windowMs: 600000 }), /spendCapUsd/);
	// Other scenarios keep the one-hour ceiling.
	assert.throws(() => resolveQualityScenarios(scenarios, { scenarios: ['S7'], budget: 7200000 }, () => {}), /1000\.\.3600000/);
});

test('world-spawn start keeps the player at the generated world spawn, in survival', async () => {
	const commands = [];
	const command = async text => { commands.push(text); return { text: text.startsWith('data get entity Player Pos') ? 'Player has the following entity data: [12.5d, 71.0d, -40.5d]' : /if loaded/.test(text) ? 'The time is 1' : 'ok' }; };
	const receipt = await applyQualitySetup(buildLongRunDefinition({ windowMs: 600000, spendCapUsd: 1 }).setup, command, 'Player');
	assert.deepEqual(receipt.definition.position, [12.5, 71, -40.5]);
	assert.ok(!commands.some(c => /gamemode creative/.test(c)), 'the player stays in survival');
	// The only teleport returns the player to the evaluator marker summoned at its own spawn position.
	assert.deepEqual(commands.filter(c => /\btp\b/.test(c)), ['execute at @e[type=minecraft:armor_stand,tag=qo_prepare_Player,limit=1] run tp Player ~ ~ ~']);
	assert.ok(commands.some(c => c.includes('summon minecraft:armor_stand 12.5 71 -40.5')));
	assert.throws(() => normalizeHeadlessScenario(buildQualityScenario({ ...buildLongRunDefinition({ windowMs: 600000, spendCapUsd: 1 }), setup: { dimension: 'minecraft:the_end', startAt: 'world_spawn', commands: [] } }, { profile })), /overworld-only/);
});

test('the observer samples the progression advancements and stops the agent once the dragon is dead', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'long-observer-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const definition = buildLongRunDefinition({ windowMs: 600000, spendCapUsd: 4 });
	const observer = new Observer(directory, { protocolAudit: '', providerTurns: '' }, definition, profile);
	const commands = [];
	observer.agent = 'Player'; observer.capturePlan = async () => {};
	observer.rcon = { command: async text => { commands.push(text); return { text: text.startsWith('data get') ? 'Player has the following entity data: {Pos: [0d, 64d, 0d], Health: 20f, Dimension: "minecraft:the_end"}'
		: text.startsWith('scoreboard') ? 'Player has 0 [qo_death]' : /end\/kill_dragon|story\/enter_the_end/.test(text) ? 'The time is 9' : 'Test failed' }; } };
	await observer.samplePlayer();
	assert.deepEqual(observer.samples[0].advancements, ['story/enter_the_end', 'end/kill_dragon']);
	for (const advancement of ['story/enter_the_nether', 'nether/find_fortress', 'story/follow_ender_eye']) assert.ok(commands.some(c => c.includes(advancement)));
	assert.equal(commands.at(-1), 'codex stop Player'); assert.equal(observer.stopRequest.reason, 'ADVANCEMENT');
});

const sample = (at, items, extra = {}) => ({ at, health: 20, dimension: 'minecraft:overworld', inventoryNbt: `[${items.map(id => `{id:"minecraft:${id}",count:1}`).join(',')}]`, equipmentNbt: '[]', advancements: [], ...extra });
const start = 1_000_000, min = 60000;
const protocolRows = [{ type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: start } }];

test('milestone timeline orders the chain and attributes calls, tokens and cost to each segment', () => {
	const samples = [sample(start + 1000, []), sample(start + 2 * min, ['oak_log']), sample(start + 5 * min, ['oak_planks', 'crafting_table']), sample(start + 9 * min, ['wooden_pickaxe', 'cobblestone']),
		sample(start + 30 * min, ['iron_ingot'], { dimension: 'minecraft:the_nether', advancements: ['story/enter_the_nether'] }), sample(start + 31 * min, [], { dimension: 'minecraft:the_end', advancements: ['story/enter_the_nether', 'story/enter_the_end', 'end/kill_dragon'] })];
	const call = (minute, input, output) => ({ event: 'native_model_call', goalRevision: 1, modelCallId: `c${minute}`, endedAt: start + minute * min, inputTokens: input, cachedInputTokens: 0, outputTokens: output });
	const traceRows = [call(1, 1000, 100), call(4, 1000, 100), call(8, 2000, 200), call(20, 4000, 400)];
	const timeline = extractLongRunTimeline({ samples, protocolRows, traceRows, profile, metrics: { modelCalls: 4, deaths: 2, deathEvents: [{ at: start + 10 * min, cause: 'minecraft:lava' }] }, stopRequest: { reason: 'ADVANCEMENT' }, windowMs: 180 * min });
	const byId = Object.fromEntries(timeline.milestones.map(m => [m.id, m]));
	assert.equal(timeline.stopReason, 'DRAGON_KILLED'); assert.equal(timeline.furthestMilestone, 'dragon');
	assert.equal(byId.wood.elapsedMs, 2 * min); assert.equal(byId.wood.segment.calls, 1); assert.equal(byId.wood.segment.tokens.input, 1000);
	assert.equal(byId.planks.segment.calls, 1); assert.equal(byId.crafting_table.segment.calls, 0, 'same sample, zero-length segment');
	assert.equal(byId.iron_ingot.segment.calls, 1); assert.equal(byId.iron_ingot.segment.tokens.output, 400); assert.equal(byId.nether.via, 'sampled dimension');
	assert.ok(byId.iron_ingot.cumulative.costUsd > byId.wood.cumulative.costUsd);
	assert.equal(byId.diamond.reached, false); assert.equal(byId.fortress.reached, false);
	assert.deepEqual(timeline.deaths.map(d => [d.elapsedMs, d.cause, d.cumulative.calls]), [[10 * min, 'minecraft:lava', 3]]); assert.equal(timeline.unexplainedDeaths, 1);
	assert.equal(LONG_RUN_MILESTONES.at(-1).id, 'dragon');
	const markdown = formatLongRunTimeline({ runId: 'long-x', seed: '1', goal: 'Beat the game', windowMs: 180 * min, profile, spend: { usd: 1, meteredUsd: 1, reservedUsd: 0 }, ledger: { committedUsd: 1, capUsd: 4 }, timeline });
	assert.match(markdown, /stop: \*\*DRAGON_KILLED\*\*/); assert.match(markdown, /\| Diamond \| not observed \|/); assert.match(markdown, /minecraft:lava/);
});

test('Codex thread counters give cumulative spend and a budget stop is reported as the wall-clock budget', () => {
	const counter = (minute, input, output) => ({ event: 'native_token_usage', scope: 'thread_total', agentId: 'a', goalRevision: 1, at: start + minute * min, inputTokens: input, cachedInputTokens: 0, outputTokens: output });
	const decision = minute => ({ event: 'native_decision_timing', goalRevision: 1, at: start + minute * min, segmentDurationMs: 1000 });
	const codex = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'priority' };
	const rows = [...protocolRows, { type: 'goal_control', agentId: 'a', payload: { operation: 'stop', updatedAtEpochMs: start + 10 * min } }];
	const timeline = extractLongRunTimeline({ samples: [sample(start + 1000, []), sample(start + 3 * min, ['birch_log'])], protocolRows: rows, profile: codex, windowMs: 10 * min,
		traceRows: [decision(1), counter(1, 1000, 50), decision(2), counter(2, 3000, 150), decision(6), counter(6, 9000, 450)] });
	const wood = timeline.milestones[0];
	assert.equal(timeline.spendBasis, 'thread counters'); assert.equal(wood.segment.calls, 2); assert.equal(wood.segment.tokens.input, 3000);
	assert.equal(timeline.stopReason, 'WALL_CLOCK_BUDGET'); assert.equal(timeline.totals.tokens.input, 9000);
	assert.equal(extractLongRunTimeline({ samples: [], protocolRows, profile, stopRequest: { reason: 'SPEND_CAP' } }).stopReason, 'SPEND_CAP');
});

test('runLong reserves from the shared ledger, caps live play inside the reservation and settles the actual charge', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'long-run-'));
	try {
		const ledger = path.join(dir, 'ledger.json');
		assert.throws(() => parseLongArgs(['--budget-minutes', '10', '--port-base', '26900', '--out', dir]), /max-total-cost-usd is required/);
		assert.throws(() => parseLongArgs(['--budget-minutes', '800', '--max-total-cost-usd', '4', '--port-base', '26900', '--out', dir]), /budget-minutes/);
		const options = parseLongArgs(['--budget-minutes', '10', '--max-total-cost-usd', '4', '--ledger', ledger, '--port-base', '26900', '--out', path.join(dir, 'out'), '--seed', '42', '--jar', 'x.jar']);
		assert.deepEqual(longRunAllowance(options, 4), { reserveUsd: 4, stopAtUsd: 3.6 });
		assert.deepEqual(longRunAllowance({}, 80), { reserveUsd: 80, stopAtUsd: 79.5 });
		assert.deepEqual(longRunAllowance({ runReserveUsd: 30 }, 80), { reserveUsd: 30, stopAtUsd: 29.5 });
		let seen;
		const artifacts = path.join(dir, 'raw'); await mkdir(artifacts);
		await writeFile(path.join(artifacts, 'quality-samples.json'), JSON.stringify({ samples: [sample(start + 1000, []), sample(start + 2 * min, ['spruce_log'])] }));
		await writeFile(path.join(artifacts, 'quality-protocol.jsonl'), protocolRows.map(r => JSON.stringify(r)).join('\n'));
		await writeFile(path.join(artifacts, 'coordinator.jsonl'), JSON.stringify({ event: 'native_model_call', goalRevision: 1, endedAt: start + min, inputTokens: 1000, outputTokens: 100 }));
		const execute = async o => { seen = o; const reserved = await new SpendLedger({ capUsd: 4, file: ledger }).totals(); assert.equal(reserved.reservedUsd, 4);
			return { jar: { sha256: 'j' }, coordinatorSha256: 'c', runs: [{ artifacts, termination: 'PASSED', measurementStatus: 'MEASURED', observerErrors: [], metrics: { modelCalls: 1, costEstimateUsd: 1.2, deaths: 0 }, unmeteredProviderCalls: 0 }] }; };
		options.codexObserverCap = true;
		const report = await runLong(options, { execute });
		assert.match(report.budgetPolicy, /Observer estimate only/);
		assert.equal(seen.definitions[0].seed, '42'); assert.equal(seen.definitions[0].spendCapUsd, 3.6); assert.equal(seen.definitions[0].durationBudgetMs, 600000); assert.equal(seen.goalStartClock, true);
		assert.equal(report.spend.usd, 1.2); assert.equal(report.ledger.committedUsd, 1.2); assert.equal(report.ledger.reservedUsd, 0);
		assert.equal(report.timeline.milestones[0].reached, true);
		assert.match(await readFile(path.join(options.out, 'long-run.md'), 'utf8'), /Wood log \| 2\.0 min/);
		// A second invocation sees the first one's spend and only gets what is left.
		const second = parseLongArgs(['--budget-minutes', '10', '--max-total-cost-usd', '4', '--ledger', ledger, '--port-base', '26900', '--out', path.join(dir, 'out2'), '--jar', 'x.jar']);
		const failing = async o => { seen = o; throw new Error('server crashed'); };
		await assert.rejects(runLong({ ...second, codexObserverCap: true }, { execute: failing }), /server crashed/);
		assert.ok(Math.abs(seen.definitions[0].spendCapUsd - 2.8 * 0.9) < 1e-9);
		const totals = await new SpendLedger({ capUsd: 4, file: ledger }).totals();
		assert.ok(Math.abs(totals.committedUsd - 4) < 1e-9, 'a failed run is charged its whole reservation');
		const third = parseLongArgs(['--budget-minutes', '10', '--max-total-cost-usd', '4', '--ledger', ledger, '--port-base', '26900', '--out', path.join(dir, 'out3'), '--jar', 'x.jar']);
		await assert.rejects(runLong({ ...third, codexObserverCap: true }, { execute }), /needs at least \$1/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('strict dragon success requires server attribution rather than advancement sampling or a client claim', () => {
 const samples = [sample(start + 1000, [], { advancements: ['end/kill_dragon'] })];
 const complete = { direction: 'server_to_coordinator', type: 'goal_control', payload: { operation: 'complete', updatedAtEpochMs: start + 2000 } };
 const base = { samples, protocolRows, profile, authoritativeDragon: true, stopRequest: { reason: 'ADVANCEMENT' } };
 assert.notEqual(extractLongRunTimeline(base).stopReason, 'DRAGON_KILLED');
 assert.notEqual(extractLongRunTimeline({ ...base, protocolRows: [...protocolRows, { ...complete, direction: 'coordinator_to_server' }] }).stopReason, 'DRAGON_KILLED');
 const result = extractLongRunTimeline({ ...base, protocolRows: [...protocolRows, complete] });
 assert.equal(result.stopReason, 'DRAGON_KILLED');
 assert.equal(result.milestones.at(-1).via, 'server-verified dragon attribution');
});
