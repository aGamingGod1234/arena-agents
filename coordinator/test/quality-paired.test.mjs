import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { coordinatorFingerprint, pairedSchedule, runPairedScenarios, validateArmBuild } from '../../scripts/quality/run-scenarios.mjs';
import { pairedTokenConfidence, extractQualityMetrics } from '../src/benchmark/quality-metrics.mjs';
import { applyQualitySetup } from '../src/benchmark/quality-scenarios.mjs';
const profile = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };

test('paired schedule alternates builds for every same-scenario repetition', () => {
	const schedule = pairedSchedule(['S1', 'S5'], 3);
	assert.equal(schedule.map(s => s.arm).join(''), 'ABABBABAABAB');
	assert.deepEqual(schedule.slice(0, 4).map(s => [s.scenario, s.repetition]), [['S1', 1], ['S1', 1], ['S5', 1], ['S5', 1]]);
	assert.throws(() => pairedSchedule(['S1'], 2), /at least 3/);
});

for (const provider of ['claude', 'codex']) test(`paired ${provider} runner routes separate coordinator and JAR builds and persists each pair`, async () => {
	const d = await mkdtemp(path.join(os.tmpdir(), 'quality-paired-'));
	try {
		const arms = {};
		for (const arm of ['A', 'B']) {
			const root = path.join(d, arm);
			await mkdir(path.join(root, 'coordinator/src'), { recursive: true });
			await mkdir(path.join(root, 'coordinator/config/minecraft-agent'), { recursive: true });
			await writeFile(path.join(root, 'coordinator/src/dynamic-main.mjs'), '');
			for (const file of ['config/dynamic-agents.json', 'package.json', 'package-lock.json']) await writeFile(path.join(root, 'coordinator', file), arm);
			await writeFile(path.join(root, `coordinator/src/${provider}-service.mjs`), provider === 'claude'
				? '#emitCallUsage(call) { partialMessagesAccepted: true; modelCallId: id; } ARENA_QUALITY_CAPTURE quality_first_message 8192'
				: "'agent_message'");
			await writeFile(path.join(root, 'coordinator/src/dynamic-main.mjs'), "scope: 'thread_total'; usageSource: 'provider'; nativeUsageTraceFields(value, usageState, usageRecord); ARENA_QUALITY_CAPTURE quality-first-message quality_first_message");
			await writeFile(path.join(root, 'coordinator/src/live-task-view.mjs'), 'export function updateUsage(state) {}');
			await writeFile(path.join(root, 'mod.jar'), arm);
			arms[arm] = { coordinatorRoot: root, jar: path.join(root, 'mod.jar'), commit: arm === 'A' ? 'c6327e81' : 'abcdef00', expectedJarSha256: createHash('sha256').update(arm).digest('hex'), expectedCoordinatorSha256: await coordinatorFingerprint(root) };
		}
		const file = path.join(d, 'arms.json'); await writeFile(file, JSON.stringify(arms));
		const calls = [];
		await runPairedScenarios({ provider, arms: file, out: path.join(d, 'out'), scenarios: ['S1'], runs: 3 }, async opts => {
			calls.push(opts);
			return { coordinatorSha256: opts.expectedCoordinatorSha256, jar: { sha256: opts.expectedJarSha256 }, instrumentationSha256: 'same', scenarioDataSha256: 'same', runs: [{ scenario: 'S1', repetition: opts.repetition }] };
		}, { sleep: async () => {}, now: () => 0 });
		assert.deepEqual(calls.map(c => c.sourceCommit), ['c6327e81', 'abcdef00', 'abcdef00', 'c6327e81', 'c6327e81', 'abcdef00']);
		const result = JSON.parse(await readFile(path.join(d, 'out/results.json')));
		assert.equal(result.complete, true); assert.equal(result.arms.A.runs.length, 3);
		assert.equal(result.pinnedArms.A.qualityCapture.provider, provider);
		assert.deepEqual(result.arms.B.runs.map(r => r.executionOrder), [2, 3, 6]);
		assert.equal(result.arms.B.runs[2].pairId, 'S1-r3');
		await writeFile(path.join(arms.A.coordinatorRoot, `coordinator/src/${provider}-service.mjs`), provider === 'claude'
			? '#emitCallUsage(call) { partialMessagesAccepted: true; modelCallId: id; }' : '');
		const missingCapture = { ...arms.A, expectedCoordinatorSha256: await coordinatorFingerprint(arms.A.coordinatorRoot) };
		await assert.rejects(validateArmBuild(missingCapture, 'A', provider), /first-response capture/);
	} finally { await rm(d, { recursive: true, force: true }); }
});

const run = (i, arm, perCall, rate) => ({ profile, pairId: `S1-r${i}`, executionOrder: 2 * i - (arm === 'A' ? 1 : 0), termination: 'TIMEOUT', providerAttestation: { effective: profile }, measurementStatus: 'MEASURED', metrics: { perCallCoverageComplete: true, tokenReconciliation: { complete: true }, partialMessagesAccepted: true, firstPlayCall: { cacheWarmth: 'warm' }, steadyState: { chargedTokensPerCall: perCall, chargedTokensPerMinute: rate }, modelCallsPerMinute: 10, deaths: 0, firstProgress: null } });
test('paired token gates require log confidence bounds and sign-flip agreement', () => {
	const a = Array.from({ length: 8 }, (_, i) => run(i + 1, 'A', 100, 1000));
	const b = Array.from({ length: 8 }, (_, i) => run(i + 1, 'B', 90, 1040));
	const c = pairedTokenConfidence(a, b);
	assert.equal(c.verdict, 'PASS'); assert.ok(Math.abs(c.perCallLogRatio.upper - Math.log(.9)) < 1e-12);
	assert.ok(Math.abs(c.tokensPerMinutePercent.upper - 4) < 1e-10);
	const rate = value => b.map(r => ({ ...r, metrics: { ...r.metrics, steadyState: { ...r.metrics.steadyState, chargedTokensPerMinute: value } } }));
	assert.equal(pairedTokenConfidence(a, rate(1050)).verdict, 'PASS');
	assert.equal(pairedTokenConfidence(a, rate(1060)).verdict, 'FAIL');
	const spread = b.map((r, i) => ({ ...r, metrics: { ...r.metrics, steadyState: { ...r.metrics.steadyState, chargedTokensPerCall: i % 2 ? 140 : 60 } } }));
	assert.equal(pairedTokenConfidence(a, spread).verdict, 'FAIL');
});
test('missing, incomplete, unordered or duplicate pairs cannot pass', () => {
	const a = [1, 2, 3].map(i => run(i, 'A', 100, 1000)), b = [1, 2, 3].map(i => run(i, 'B', 90, 900));
	assert.equal(pairedTokenConfidence(a, b.slice(0, 2)).verdict, 'INCONCLUSIVE');
	assert.equal(pairedTokenConfidence(a, b.map(r => ({ ...r, measurementStatus: 'INCOMPLETE' }))).verdict, 'INCONCLUSIVE');
	assert.equal(pairedTokenConfidence(a, b.map(r => ({ ...r, executionOrder: 99 }))).verdict, 'INCONCLUSIVE');
	assert.equal(pairedTokenConfidence(a.map(r => ({ ...r, executionOrder: 1 })), b.map(r => ({ ...r, executionOrder: 2 }))).verdict, 'INCONCLUSIVE');
	assert.throws(() => pairedTokenConfidence([...a, a[0]], b), /Duplicate/);
});
test('per-call details reconcile totals and progress excludes fixture gear and dimension', () => {
	const scenario = { setup: { dimension: 'minecraft:the_nether', inventory: [{ item: 'minecraft:ender_pearl', count: 10 }] } };
	const m = extractQualityMetrics({ scenario, profile, startedAt: 1000, endedAt: 61000,
		traceRows: [{ event: 'native_model_call', agentId: 'a', goalRevision: 1, totalMs: 1, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 5 }],
		providerRows: [{ provider: 'claude', model: profile.model, tokens: { input: 2, cached: 3, cacheWrite: 4, output: 5 } }],
		samples: [{ at: 1000, position: { x: 0, y: 0, z: 0 }, dimension: 'minecraft:the_nether', inventoryNbt: '[{id: "minecraft:ender_pearl", count: 10}]' }, { at: 3000, position: { x: 1, y: 0, z: 0 }, dimension: 'minecraft:the_nether', inventoryNbt: '[{id: "minecraft:blaze_rod", count: 1}]' }] });
	assert.equal(m.modelCallDetails.length, 2); assert.equal(m.perCallCoverageComplete, true);
	assert.deepEqual(m.tokensPerCall, { input: 36, cacheRead: 11.5, cacheWrite: 7, output: 5 });
	assert.equal(m.chargedTokensPerCall, 48); assert.equal(m.chargedTokensPerMinute, 96);
	assert.equal(m.timeToFirstProgressMs, 2000); assert.equal(m.firstProgress.kind, 'resource-gain');
});
test('natural piglin fixture requires safe standing ground and explicit presence evidence', async () => {
	const setup = { dimension: 'minecraft:the_nether', position: [0, 70, 0], commands: [], mobs: [{ id: 'minecraft:piglin', offset: [6, 0, 0], naturalGround: true, tag: 'piglin', nbt: '{Tags:["piglin"]}' }] };
	const commands = [];
	await applyQualitySetup(setup, async c => { commands.push(c); return { text: 'player has the following entity data: [0d,0d,0d]' }; }, 'player');
	assert.ok(commands.some(c => c.includes('positioned ~6 ~0 ~0 if block')));
	assert.ok(commands.some(c => c.includes('tag=piglin')));
	await assert.rejects(applyQualitySetup(setup, async c => ({ text: c.includes('if block') ? '' : 'ok' }), 'player'), /MOB_GROUND/);
	const shifted = [];
	await applyQualitySetup(setup, async c => { shifted.push(c); return { text: c.includes('if block') && !c.includes('positioned ~7 ~0 ~0') ? '' : 'player has the following entity data: [0d,0d,0d]' }; }, 'player');
	assert.ok(shifted.some(c => c.includes('summon minecraft:piglin ~7 ~0 ~0')));
});

test('fixture advancements and death respawns cannot count as first progress', () => {
	const m = extractQualityMetrics({ scenario: { setup: { dimension: 'minecraft:the_nether', inventory: [] } }, profile, startedAt: 1000, endedAt: 6000,
		protocolRows: [{ type: 'goal_control', at: 2000, payload: { operation: 'dead' } }],
		samples: [
			{ at: 1000, position: { x: 0, y: 0, z: 0 }, dimension: 'minecraft:the_nether', advancements: ['story/iron_tools'] },
			{ at: 3000, position: { x: 0, y: 0, z: 0 }, dimension: 'minecraft:overworld', advancements: ['story/iron_tools'] },
			{ at: 4000, position: { x: 1, y: 0, z: 0 }, dimension: 'minecraft:overworld', advancements: ['story/iron_tools', 'nether/find_fortress'] },
		] });
	assert.equal(m.timeToFirstProgressMs, 3000); assert.equal(m.firstProgress.advancement, 'nether/find_fortress');
});
