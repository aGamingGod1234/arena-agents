import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, appendFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Tail } from '../../scripts/quality/run-scenarios.mjs';
import { readJsonl, writeJsonl } from '../src/benchmark/jsonl-stream.mjs';
import { regenerateLongReport, runLong, parseLongArgs } from '../../scripts/quality/run-long.mjs';
const fixture = async fn => { const dir = await mkdtemp(path.join(tmpdir(), 'long-harness-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };

test('live journal survives rotation to a larger file and split UTF-8, preserving the old inode tail', () => fixture(async dir => {
	const file = path.join(dir, 'protocol.jsonl'), journal = path.join(dir, 'captured.jsonl');
	const first = Buffer.from(JSON.stringify({ label: '木' }) + '\n');
	const split = first.indexOf(Buffer.from('木')) + 1;
	await writeFile(file, first.subarray(0, split));
	const tail = new Tail(file, { journal });
	await tail.poll();
	await appendFile(file, first.subarray(split));
	await rename(file, file + '.1');
	await writeJsonl(file, [{ label: 'replacement'.repeat(10) }, { label: 'last' }]);
	await tail.finish();
	const rows = []; await readJsonl(journal, r => rows.push(r));
	assert.deepEqual(rows.map(r => r.label), ['木', 'replacement'.repeat(10), 'last']);
	assert.equal(tail.droppedLines, 0);
}));

test('streamed JSONL writer and reader handle captures larger than V8 maximum string length', () => fixture(async dir => {
	const module = new URL('../src/benchmark/jsonl-stream.mjs', import.meta.url).href;
	const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', `
		import { constants } from 'node:buffer';
		import { writeJsonl, readJsonl } from ${JSON.stringify(module)};
		const row = { padding: 'x'.repeat(1024 * 1024) };
		const count = Math.ceil(constants.MAX_STRING_LENGTH / row.padding.length) + 1;
		function* records() { for (let i = 0; i < count; i++) yield { ...row, i }; }
		const file = ${JSON.stringify(path.join(dir, 'large.jsonl'))};
		await writeJsonl(file, records());
		let seen = 0; await readJsonl(file, r => { if (r.i !== seen++) throw Error('Lost ordering'); });
		if (seen !== count) throw Error('Lost rows');
		console.log(seen);
	`], { encoding: 'utf8', timeout: 60000 });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(Number(result.stdout) > 500);
}));

test('regeneration recovers rotated evidence, terminal diagnostics, deaths and usage without a ledger', () => fixture(async dir => {
	const start = 1700000000000, windowMs = 60000;
	await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ runId: 'test', provider: 'codex', model: 'gpt-6.1-sol', world: { seed: '1' } }));
	await writeFile(path.join(dir, 'report.json'), JSON.stringify({ classification: 'TIMEOUT', budget: { goalStartedAt: start, playWindowMs: windowMs } }));
	await writeJsonl(path.join(dir, 'protocol.jsonl.1'), [{ type: 'observation', agentId: 'a', payload: { observedAtEpochMs: start + 1000, inventory: { items: [{ itemId: 'minecraft:oak_log', count: 1 }] } } }, { type: 'goal_control', payload: { operation: 'dead', death: { diedAtEpochMs: start + 2000, cause: 'lava' } } }]);
	await writeJsonl(path.join(dir, 'protocol.jsonl'), [{ type: 'goal_control', payload: { operation: 'stop', updatedAtEpochMs: start + windowMs } }]);
	await appendFile(path.join(dir, 'protocol.jsonl'), '{broken\n');
	await writeJsonl(path.join(dir, 'coordinator.jsonl'), [{ event: 'native_decision_timing', agentId: 'a', goalRevision: 1, at: start + 500 }]);
	const report = await regenerateLongReport(dir, path.join(dir, 'out'));
	assert.equal(report.timeline.stopReason, 'WALL_CLOCK_BUDGET');
	assert.equal(report.timeline.milestonesReached, 1);
	assert.equal(report.timeline.totals.calls, 1);
	assert.equal(report.timeline.deaths[0].cause, 'lava');
	assert.ok(report.observerErrors.some(e => e.includes('malformed')));
	assert.match(await readFile(path.join(dir, 'out/long-run.md'), 'utf8'), /Wood log/);
}));

test('execution exception retains discovered artifacts and writes a named failure report', () => fixture(async dir => {
	const raw = path.join(dir, 'raw');
	const { mkdir } = await import('node:fs/promises'); await mkdir(raw);
	await writeFile(path.join(raw, 'manifest.json'), '{}');
	await writeFile(path.join(raw, 'report.json'), JSON.stringify({ classification: 'ERROR', errorCode: 'RCON_INCOMPLETE', diagnostics: 'RCON_INCOMPLETE: codex status agent; received 20000 bytes' }));
	const options = parseLongArgs(['--budget-minutes', '1', '--max-total-cost-usd', '5', '--port-base', '28000', '--out', path.join(dir, 'out'), '--provider', 'codex', '--codex-observer-cap', 'yes']);
	await assert.rejects(runLong(options, { execute: async (_options, { onObserver }) => { onObserver({ directory: raw }); throw new Error('extraction broke'); } }), /extraction broke/);
	const md = await readFile(path.join(dir, 'out/long-run.md'), 'utf8');
	assert.match(md, /ENDED_EARLY:RCON_INCOMPLETE/);
	assert.match(md, /extraction broke/);
}));

test('scenario text report accepts the long-run metric scope', async () => {
 const { formatTimeline } = await import('../../scripts/quality/run-scenarios.mjs');
 const { longMetrics } = await import('../src/benchmark/long-run-artifacts.mjs');
 const metrics = longMetrics({ traceRows: [], protocolRows: [], profile: { provider: 'codex', model: 'gpt-6.1-sol' } });
 assert.match(formatTimeline({ scenario: 'LONG', termination: 'TIMEOUT', metrics }), /LONG.*TIMEOUT/);
});

test('long accounting preserves cached preparation pricing and unknown usage', async () => {
 const { longMetrics } = await import('../src/benchmark/long-run-artifacts.mjs');
 const base = { traceRows: [], protocolRows: [], profile: { provider: 'codex', model: 'gpt-6.1-sol', serviceTier: 'priority' } };
 const row = { goalRevision: 0, provider: 'codex', model: 'gpt-6-luna', tokens: { input: 1000, cached: 400, output: 100 } };
 const m = longMetrics({ ...base, providerRows: [row] });
 assert.equal(m.preparation.costEstimateUsd, (600 * .1 + 400 * .01 + 100 * .5) * 2 / 1e6);
 assert.equal(longMetrics({ ...base, providerRows: [{ ...row, tokens: null }] }).preparation.costEstimateUsd, null);
});


test('long measurement reconciles corrected call usage and rejects missing or mismatched counters', async () => {
 const { longMetrics } = await import('../src/benchmark/long-run-artifacts.mjs');
 const { measurementStatus } = await import('../../scripts/quality/run-scenarios.mjs');
 const profile = { provider:'claude', model:'claude-opus-5-5' };
 const call = { event:'native_model_call', modelCallId:'a', agentId:'a', goalRevision:1, at:1, totalMs:10, inputTokens:10, outputTokens:100, partialMessagesAccepted:true };
 const total = { ...call, event:'native_token_usage', scope:'thread_total' };
 const status = traceRows => measurementStatus(longMetrics({traceRows,protocolRows:[],profile}), [{at:0},{at:2}], [], 0, 'claude');
 assert.equal(status([call,total]), 'MEASURED');
 assert.equal(status([{...call,outputTokens:50},call,total]), 'MEASURED', 'a later physical-call correction replaces its earlier row');
 assert.equal(status([call]), 'INCOMPLETE', 'missing independent session counter');
 assert.equal(status([call,{...total,outputTokens:200}]), 'INCOMPLETE', 'mismatched counter');
 assert.equal(status([{...call,partialMessagesAccepted:false},total]), 'INCOMPLETE', 'partial-message attestation still required');
});
