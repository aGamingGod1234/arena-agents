import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reextractReport } from '../../scripts/quality/reextract-scenarios.mjs';

test('paired re-extraction writes outside inputs and updates selected, first-attempt and history metrics', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'quality-v2-reextract-'));
	try {
		const artifact = path.join(dir, 'artifacts');
		await mkdir(path.join(artifact, 'workspace/player-memory'), { recursive: true });
		await writeFile(path.join(artifact, 'manifest.json'), JSON.stringify({ providerWorkspace: path.join(artifact, 'workspace') }));
		await writeFile(path.join(artifact, 'quality-samples.json'), JSON.stringify({ samples: [{ at: 1000, position: { x: 0, y: 40, z: 0 }, health: 5 }, { at: 3000, position: { x: 50, y: 40, z: 0 }, health: 20 }], targets: [] }));
		const rows = [{ type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 1000 } },
			{ type: 'goal_control', agentId: 'a', payload: { operation: 'dead', death: { diedAtEpochMs: 2000, cause: 'burned to death' } } },
			{ type: 'goal_control', agentId: 'a', payload: { operation: 'stop', updatedAtEpochMs: 4000 } }];
		await writeFile(path.join(artifact, 'protocol.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
		await writeFile(path.join(artifact, 'quality-initial-plan.json'), JSON.stringify({ text: '{"steps":[{"label":"Find fortress"}]}', source: 'goal-spec-output', originalBytes: 37, truncated: false }));
		const run = { scenario: 'S1', repetition: 1, pairId: 'S1-r1', artifacts: artifact, measurementStatus: 'UNAVAILABLE', metrics: { firstTurnUnderstanding: { initialPlan: null } },
			profile: { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' }, definition: { setup: { dimension: 'minecraft:the_nether', inventory: [] } } };
		const arm = { coordinatorSha256: 'original', runs: [run], firstAttemptRuns: [run] };
		const input = path.join(dir, 'paired.json'), out = path.join(dir, 'out');
		const before = JSON.stringify({ complete: true, arms: { A: arm, B: arm }, history: [{ ...run, arm: 'A' }], sequence: [] });
		await writeFile(input, before);
		const protocolBefore = await readFile(path.join(artifact, 'protocol.jsonl'), 'utf8');
		for (const unsafe of [dir, artifact, path.join(artifact, 'new-output'), path.join(artifact, 'workspace')]) {
			await assert.rejects(reextractReport(input, { out: unsafe }), /must be separate/);
			assert.equal(await readFile(input, 'utf8'), before);
			assert.equal(await readFile(path.join(artifact, 'protocol.jsonl'), 'utf8'), protocolBefore);
		}
		const report = await reextractReport(input, { out });
		assert.equal(await readFile(input, 'utf8'), before);
		assert.equal(await readFile(path.join(artifact, 'protocol.jsonl'), 'utf8'), protocolBefore);
		assert.equal(report.arms.A.runs[0].metrics.qualityV2.lowHealthOutcomes.died, 1);
		assert.equal(report.arms.B.firstAttemptRuns[0].metrics.qualityV2.lowHealthOutcomes.died, 1);
		assert.equal(report.history[0].metrics.qualityV2.hazardDeathsByType.fire, 1);
		assert.equal(report.arms.A.runs[0].metrics.qualityV2.initialPlan.source, 'goal-spec-output');
		assert.equal(report.arms.A.coordinatorSha256, 'original');
		assert.equal(report.arms.A.metricsExtractorSha256, report.arms.B.metricsExtractorSha256);
		assert.equal(report.qualityV2Summary.A.lowHealthOutcomes.died, 1);
		assert.equal(report.qualityV2Summary.B.hazardDeathsByType.fire, 1);
		assert.ok(await readFile(path.join(out, 'A.json'), 'utf8'));
		assert.ok(await readFile(path.join(out, 'A', 'S1-r1-timeline.txt'), 'utf8'));
	} finally { await rm(dir, { recursive: true, force: true }); }
});
