import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawnOwnedProcess, terminateChildProcess } from '../src/child-process-lifecycle.mjs';
import { parseLongArgs } from '../../scripts/quality/run-long.mjs';
import { runStrictSmoke, evaluateSmoke, providerUsageCost, verifySmokeReport } from '../../scripts/quality/strict-smoke.mjs';

const fixture = fileURLToPath(new URL('./fixtures/strict-smoke-launcher.cjs', import.meta.url));
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function mockedRun(fault = 'none') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strict-smoke-driver-'));
  const requests = [], providerCalls = [], children = [], launcherDirectories = [];
  const priorExitCode = process.exitCode;
  const upstream = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' });
    const parsed = JSON.parse(body);
    const usage = { input_tokens: 10, output_tokens: fault === 'overrun' ? 1000000 : parsed.max_tokens === 100000 ? 100000 : 100, ...(fault === 'cache5m' ? { cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 } } : fault === 'cache-unknown' ? { cache_creation_input_tokens: 1000 } : {}) };
    const responseId = 'smoke-call-' + requests.length;
    providerCalls.push({ responseId, model: 'claude-opus-5-5', usage });
    response.end(JSON.stringify({ id: responseId, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Inspect the nearby blocks.' }], stop_reason: 'end_turn', usage }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const template = path.join(root, 'template'); await mkdir(template);
  const jar = path.join(root, 'fixture.jar'); await writeFile(jar, 'explicit mocked Minecraft fixture');
  const options = parseLongArgs(['--budget-minutes', '1', '--max-total-cost-usd', '3', '--ledger', path.join(root, 'ledger.json'), '--port-base', '26900', '--out', path.join(root, 'out'), '--jar', jar, '--server-template', template, '--java', process.execPath]);
  try {
    const report = await runStrictSmoke(options, {
      upstream: `http://127.0.0.1:${upstream.address().port}`,
      providerAudit: fault === 'audit-missing' ? null : async ({ runId, startedAt, endedAt }) => {
        if (fault === 'audit-unreadable') throw new Error('Provider audit unreadable');
        const audit = { schemaVersion: 1, source: 'provider', generatedAt: Date.now(), complete: fault !== 'audit-incomplete', scope: { runId, startedAt, endedAt }, calls: structuredClone(providerCalls) };
        audit.billingTotalUsd = providerCalls.reduce((total, call) => total + (call.usage.input_tokens * 4 + call.usage.output_tokens * 20 + (call.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) * 5 + (call.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) * 8) / 1e6, 0);
        if (fault === 'audit-billing') audit.billingTotalUsd = 4;
        if (fault === 'audit-wrong-scope') audit.scope.runId = 'another-run';
        if (fault === 'audit-missing-call') audit.calls = [];
        if (fault === 'audit-wrong-usage') audit.calls[0].usage.output_tokens++;
        return audit;
      },
      timeoutMs: ['no-goal', 'no-gameplay'].includes(fault) ? 4500 : 15000,
      spawnLauncher(command, args, launch) {
        const matrixFile = args[args.indexOf('-MatrixPath') + 1];
        launcherDirectories.push(path.dirname(matrixFile));
        const child = spawnOwnedProcess(process.execPath, [fixture, matrixFile, root, fault], { ...launch, env: { ...launch.env, SMOKE_MOCK_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` } });
        children.push(child); return child;
      },
      configureObserver(observer) {
        if (fault === 'observer-error') observer.errors.push('Review injected unreadable usage file');
        observer.agent = 'SmokePlayer';
        observer.agentId = 'smoke-agent';
        observer.setup = { agent: 'SmokePlayer', definition: {} };
        observer.rcon = { command: async () => ({ text: 'ok' }), close: async () => {} };
        observer.stopRetryMs = 20;
        observer.maxStopFailures = 2;
        observer.samplePlayer = async () => {
          observer.samples.push({ at: Date.now(), health: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'minecraft:overworld', advancements: [] });
        };
      },
    });
    if (fault === 'duplicate-correlation') {
      const auditFile = path.join(root, 'provider-audit.json');
      await writeFile(auditFile, JSON.stringify(report.evidence.providerAudit));
      const verified = await verifySmokeReport(path.join(options.out, 'strict-smoke.json'), auditFile);
      assert.equal(verified.status, report.status, 'offline verification must agree with the full run');
    }
    if (fault === 'audit-missing') {
      assert.equal(report.status, 'INCOMPLETE');
      const auditFile = path.join(root, 'provider-audit.json');
      await writeFile(auditFile, JSON.stringify({ schemaVersion: 1, source: 'provider', generatedAt: Date.now(), complete: true, scope: report.evidence.scope, calls: providerCalls }));
      const reportFile = path.join(options.out, 'strict-smoke.json');
      const verified = await verifySmokeReport(reportFile, auditFile);
      assert.equal(verified.status, 'PASS', JSON.stringify(verified, null, 2));
      await writeFile(auditFile, '{bad audit');
      assert.equal((await verifySmokeReport(reportFile, auditFile)).status, 'FAIL', 'malformed independent audit must fail offline verification');
      await writeFile(auditFile, JSON.stringify(verified.evidence.providerAudit));
      await writeFile(report.evidence.integrity.files[0].path, '{changed evidence}\n');
      assert.equal((await verifySmokeReport(reportFile, auditFile)).status, 'FAIL', 'post-capture evidence damage must fail offline verification');
    }
    const beat = await readFile(path.join(root, 'descendant-heartbeat.txt'), 'utf8').catch(() => '');
    await sleep(100);
    assert.equal(await readFile(path.join(root, 'descendant-heartbeat.txt'), 'utf8').catch(() => ''), beat, 'real owned descendant has exited');
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null, 'real launcher exited');
    return { report, requests };
  } finally {
    process.exitCode = priorExitCode;
    for (const child of children) await terminateChildProcess(child, { timeoutMs: 15000 });
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    const matrixRoot = await readFile(path.join(root, 'matrix-path.txt'), 'utf8').catch(() => null);
    if (matrixRoot) {
      assert.equal(path.dirname(path.resolve(matrixRoot)), path.join(projectRoot, 'runtime/headless-runs'));
      assert.ok(path.basename(matrixRoot).startsWith('strict-smoke-fixture-'));
      await rm(matrixRoot, { recursive: true, force: true });
    }
    for (const directory of launcherDirectories) {
      assert.equal(path.dirname(path.resolve(directory)), path.join(projectRoot, 'runtime/quality'));
      await rm(directory, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('strict smoke passes with real owned processes, real HTTP transport, local probes and forced watchdog escalation', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const { report, requests } = await mockedRun();
  assert.equal(report.status, 'PASS', JSON.stringify(report, null, 2));
  assert.equal(requests.length, 1, 'neither local probe reaches the provider');
  assert.equal(requests[0].body.messages[0].content.length < 1000000, true);
  const mutations = {
    'gateway address absent': e => { e.gatewayUrl = null; },
    'probe precedes gameplay': e => { e.boundary.at = e.goalStartedAt - 1; },
    'retry precedes boundary': e => { e.following.at = e.boundary.at - 1; },
    'auxiliary request': e => { e.auxiliary.push({ event: 'goal_translation_complete', provider: 'codex' }); },
    'live judge request': e => { e.judgeRequests = 1; },
    'unaccounted model request': e => { e.gameplay.push({ ...e.gameplay[0], modelCallId: 'not-forwarded' }); },
    'outbound record missing': e => { e.outbound = []; },
    'duplicate outbound identity': e => { e.outbound.push({ ...e.outbound[0] }); },
    'boundary probe forwarded': e => { e.boundary.forwarded = true; },
    'boundary probe accepted': e => { e.boundary.status = 200; },
    'following request forwarded': e => { e.following.forwarded = true; },
    'following request accepted': e => { e.following.status = 200; },
    'gate remains open': e => { e.gate.closed = false; },
    'wrong closure reason': e => { e.gate.closeReason = 'TIMEOUT'; },
    'no RCON stop failures': e => { e.injectedStopFailures = []; },
    'watchdog did not escalate': e => { e.stop.state = 'confirmed'; e.stop.hardStopped = false; },
    'owned descendants remain': e => { e.cleanup.allMembersExited = false; },
    'launcher remains': e => { e.cleanup.wrapperExited = false; },
    'observation handles remain': e => { e.cleanup.observationHandlesClosed = false; },
    'job ownership handle held during kill': e => { e.cleanup.jobHandleClosedBeforeStop = false; },
    'cleanup proof absent': e => { e.cleanup = null; },
    'sentinel was killed by cleanup': e => { e.sentinel.aliveBeforeStop = false; },
    'sentinel cleanup unconfirmed': e => { e.sentinel.exitConfirmed = false; },
    'gate overrun recorded': e => { e.gate.overruns.push({ worstUsd: 1, actualUsd: 2 }); },
    'pending reservation exceeds cap': e => { e.gate.pendingUsd = 3; e.gate.chargeUsd += 3; },
    'in-flight reservation exceeds cap': e => { e.outbound[0].chargeUsd = 4; e.outbound[0].pendingUsd = 4; e.outbound[0].committedUsd = 0; },
    'unknown provider usage category': e => { const call = e.calls.find(call => !call.denied); call.usage.unaccounted_tool_requests = 1; },
    'ledger disagrees': e => { e.ledger.committedUsd += 0.1; },
    'reported spend disagrees': e => { e.reportChargeUsd += 0.1; },
    'usage charge mismatch': e => { e.calls.find(call => !call.denied).usd = 1; },
    'provider usage missing': e => { e.calls.find(call => !call.denied).tokens = null; },
    'observer error in final evidence': e => { e.integrity.errors.push('unreadable source'); },
    'runner scan error': e => { e.integrity.scanErrors.push('failed directory scan'); },
    'coordinator source changed': e => { e.integrity.sourceChanged = true; },
    'run measurement incomplete': e => { e.integrity.measurementStatus = 'INCOMPLETE'; },
    'usage file integrity false': e => { e.integrity.files[0].ok = false; },
    'required evidence file absent': e => { e.integrity.files.pop(); },
    'provider call billed cost disagrees': e => { e.providerAudit.calls[0].billedUsd = 4; },
    'provider census duplicated call': e => { e.providerAudit.calls.push({ ...e.providerAudit.calls[0] }); },
    'provider census stale': e => { e.providerAudit.generatedAt = e.scope.endedAt - 1; },
    'provider census is gateway self-report': e => { e.providerAudit.source = 'gateway'; },
    'gameplay occurs after boundary': e => { for (const row of e.gameplay) { row.startedAt = e.boundary.at + 10; row.endedAt = e.boundary.at + 20; row.at = row.endedAt; } },
    'gameplay belongs to another agent': e => { e.gameplay[0].agentId = 'other-agent'; },
    'gameplay has an unrelated call identity': e => { e.gameplay[0].modelCallId = 'other-call'; },
    'boundary exceeds minute window': e => { e.boundary.at = e.goalStartedAt + 61000; e.following.at = e.boundary.at + 1; },
    'evidence error': e => { e.errors.push('fixture evidence corrupt'); },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const evidence = structuredClone(report.evidence); mutate(evidence);
    assert.notEqual(evaluateSmoke(evidence).status, 'PASS', name);
  }
});

for (const fault of ['no-goal', 'no-gameplay']) test(`strict smoke is INCOMPLETE when ${fault} prevents the required sequence`, { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const { report } = await mockedRun(fault);
  assert.equal(report.status, 'INCOMPLETE', JSON.stringify(report, null, 2));
});

test('strict smoke fails actual mocked provider overrun despite successful transport and cleanup', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const { report } = await mockedRun('overrun');
  assert.equal(report.status, 'FAIL', JSON.stringify(report, null, 2));
  assert.ok(report.failures.includes('noOverrun'));
  assert.ok(report.failures.includes('cap'));
});

for (const fault of ['auxiliary', 'unaccounted']) test(`strict smoke fails the real mocked run with ${fault} traffic evidence`, { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const { report } = await mockedRun(fault);
  assert.equal(report.status, 'FAIL', JSON.stringify(report, null, 2));
  assert.ok(report.failures.includes(fault === 'auxiliary' ? 'auxiliary' : 'gameplayAccounting'));
});

for (const fault of ['bypass', 'damaged', 'truncated', 'observer-error']) test(`r8 rejects Sol's full ${fault} reproduction`, { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const { report, requests } = await mockedRun(fault);
  assert.equal(report.status, 'FAIL', JSON.stringify(report, null, 2));
  if (fault === 'bypass') { assert.equal(requests.length, 3); assert.equal(report.evidence.outbound.length, 1); }
});

test('r8 late append-only goal and gameplay evidence is INCOMPLETE before the boundary probe', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const { report } = await mockedRun('late');
  assert.equal(report.status, 'INCOMPLETE', JSON.stringify(report, null, 2));
  assert.equal(report.evidence.boundary, null);
});

test('r8 five-minute cache writes reconcile to their published rate and reject the former one-hour charge', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const { report } = await mockedRun('cache5m');
  assert.equal(report.status, 'PASS', JSON.stringify(report, null, 2));
  assert.ok(Math.abs(report.evidence.gate.chargeUsd - 0.00704) < 1e-9);
  const damaged = structuredClone(report.evidence);
  damaged.calls.find(call => !call.denied).usd = 0.01004;
  assert.equal(evaluateSmoke(damaged).status, 'FAIL');
});

for (const fault of ['cache-unknown', 'audit-missing', 'audit-incomplete', 'audit-unreadable', 'audit-billing', 'audit-wrong-scope', 'audit-missing-call', 'audit-wrong-usage']) test(`r8 cannot pass a full run with ${fault}`, { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const { report } = await mockedRun(fault);
  assert.notEqual(report.status, 'PASS', JSON.stringify(report, null, 2));
});


test('provider price reconciliation accepts standard metadata and refuses extra billable categories', () => {
 const usage = { input_tokens: 10, output_tokens: 100, inference_geo: 'global', service_tier: 'standard', output_tokens_details: { thinking_tokens: 50 }, server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 } };
 assert.equal(providerUsageCost(usage), 0.00204);
 assert.equal(providerUsageCost({ ...usage, inference_geo: 'us' }), null);
 assert.equal(providerUsageCost({ ...usage, server_tool_use: { web_search_requests: 1 } }), null);
 assert.equal(providerUsageCost({ ...usage, output_tokens_details: { thinking_tokens: 101 } }), null);
});


test('r9 duplicate native correlations cannot hide an unmatched provider response', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
 const { report, requests } = await mockedRun('duplicate-correlation');
 assert.equal(requests.length, 2);
 assert.equal(report.evidence.gate.chargeUsd, 0.00408);
 assert.equal(report.checks.providerAccounting, true);
 assert.equal(report.checks.integrity, true);
 assert.equal(report.status, 'FAIL', JSON.stringify(report, null, 2));
 assert.equal(report.checks.gameplayAccounting, false);
});

test('r9 distinct responses retain one-to-one matching and same-call usage corrections', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
 const { report } = await mockedRun('distinct-correlations');
 assert.equal(report.status, 'PASS', JSON.stringify(report, null, 2));
 const ambiguous = structuredClone(report.evidence);
 const calls = ambiguous.calls.filter(call => !call.denied);
 calls[0].responseId = 'tail'; calls[1].responseId = 'prefix:tail';
 ambiguous.gameplay[0].modelCallId = 'prefix:tail';
 ambiguous.gameplay[1].modelCallId = 'tail';
 assert.equal(evaluateSmoke(ambiguous).checks.gameplayAccounting, false, 'ambiguous suffix matches must fail independently of other checks');
});
