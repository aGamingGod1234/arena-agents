import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { SpendGate, startAnthropicGateway } from '../src/benchmark/spend-gate.mjs';
import { SpendLedger } from '../src/benchmark/spend-ledger.mjs';
import { runLong, parseLongArgs } from '../../scripts/quality/run-long.mjs';
import { gatedSuiteRun } from '../../scripts/quality/run-generality.mjs';
import { runScenarios } from '../../scripts/quality/run-scenarios.mjs';

// This used to exit before launch even for the exact server-verifiable dragon goal.
// Exercise real long owner, file ledger, scenario owner, gateway and settlement, with only the matrix/provider mocked.
test('r6: strict long runner launches with no auxiliary allowance and counts every upstream request', async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'strict-launch-'));
 let scenarioReport;
 const priorExitCode = process.exitCode;
 const outbound = [], launches = [];
 try {
  const template = path.join(dir, 'template'); await mkdir(template);
  const jar = path.join(dir, 'fixture.jar'); await writeFile(jar, 'mock matrix only');
  const ledger = path.join(dir, 'ledger.json');
  const options = parseLongArgs(['--budget-minutes', '1', '--max-total-cost-usd', '3', '--ledger', ledger, '--port-base', '26900', '--out', path.join(dir, 'out'), '--jar', jar, '--server-template', template, '--java', process.execPath]);
  const gatewayFactory = args => startAnthropicGateway({ ...args, fetchImpl: async (url, init) => {
   const body = JSON.parse(init.body); outbound.push({ url, body });
   assert.ok(args.gate.pendingUsd > 0, 'provider cannot see a request without a reservation');
   return new Response(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 100 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const spawnLauncher = (command, args, launch) => {
   launches.push(launch);
   const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
   setImmediate(async () => {
    try {
     assert.equal(launch.env.ARENA_STRICT_SPEND_GATE, '1');
     assert.match(launch.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
     const totals = await new SpendLedger({ file: ledger, capUsd: 3 }).totals();
     assert.equal(totals.reservedUsd, 3);
     const body = { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'play' }] };
     const send = (route, value) => fetch(launch.env.ANTHROPIC_BASE_URL + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
     assert.equal((await send('/v1/messages', body)).status, 200);
     assert.equal((await send('/v1/messages', { ...body, messages: [{ role: 'user', content: 'x'.repeat(1000000) }] })).status, 400);
     assert.equal((await send('/v1/messages/batches', { requests: [body] })).status, 400);
     child.exitCode = 0; child.emit('close', 0, null);
    } catch (error) { child.emit('error', error); }
   });
   return child;
  };
  const report = await runLong(options, { execute: async args => { scenarioReport = await runScenarios(args, { gatewayFactory, spawnLauncher }); return scenarioReport; } });
  assert.equal(launches.length, 1); assert.equal(outbound.length, 1);
  assert.match(report.budgetPolicy, /^Strict:/);
  assert.equal(scenarioReport.runs[0].gate.preparationDisabled, true);
  assert.equal(scenarioReport.runs[0].gate.byLabel.preparation, undefined);
  assert.equal(scenarioReport.runs[0].gate.byLabel['judge allowance'], undefined);
  assert.ok(report.spend.usd > 0 && report.spend.usd <= 3);
  assert.equal((await new SpendLedger({ file: ledger, capUsd: 3 }).totals()).committedUsd, report.spend.usd);
 } finally {
  process.exitCode = priorExitCode;
  if (scenarioReport?.launcherLogs) await rm(scenarioReport.launcherLogs, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
 }
});

test('r6: strict suite never invokes a live judge or reserves estimated auxiliary spend', async () => {
 let play = 0, judges = 0;
 const run = await gatedSuiteRun({ reserveUsd: 3, scenario: { id: 'LONG', goal: 'Beat the game', categories: [], objective: { type: 'health', minimum: 1 } }, arm: 'B', repetition: 1, judge: { provider: 'codex' }, options: { provider: 'claude' } }, {
  gatewayFactory: async ({ strict }) => { assert.equal(strict, true); return { strict, url: 'http://127.0.0.1:1', close: async () => {} }; },
  execute: async ({ spendGate }) => { play++; assert.equal(spendGate.pendingUsd, 0); return { runs: [{ metrics: { modelCalls: 0 }, artifacts: null }] }; },
  judge: async () => { judges++; throw new Error('unbounded judge must not run'); },
  invokeJudge: async () => { judges++; throw new Error('unbounded judge must not run'); },
 });
 assert.equal(play, 1); assert.equal(judges, 0); assert.equal(run.judge.deferred, true); assert.equal(run.gate.chargeUsd, 0);
});

test('r6: strict mode refuses unsupported provider and uncompiled goals before any launch', async () => {
 let launches = 0;
 for (const options of [{ provider: 'codex', goal: 'Beat the game' }, { provider: 'claude', goal: 'Gather wood' }]) {
  await assert.rejects(runLong(options, { execute: async () => { launches++; } }), /Strict/);
 }
 await assert.rejects(runScenarios({ provider: 'codex', spendGate: new SpendGate({ budgetUsd: 3 }) }), /Strict/);
 assert.equal(launches, 0);
});
