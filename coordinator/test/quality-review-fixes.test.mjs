import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractQualityMetrics, pairedTokenConfidence, compareQualityReports, signFlipPermutation } from '../src/benchmark/quality-metrics.mjs';
import { deriveRunMetrics } from '../src/benchmark/live-speed-benchmark.mjs';
const profile = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };
const run = (i, arm, extra = {}) => ({ scenario: 'S1', profile, pairId: `S1-r${i}`, executionOrder: 2 * i - (arm === 'A' ? 1 : 0), termination: 'TIMEOUT', measurementStatus: 'MEASURED', providerAttestation: { requested: profile, effective: profile }, metrics: { perCallCoverageComplete: true, tokenReconciliation: { complete: true }, partialMessagesAccepted: true, chargedTokensPerCall: arm === 'A' ? 100 : 80, chargedTokensPerMinute: arm === 'A' ? 1000 : 800, steadyState: { chargedTokensPerCall: arm === 'A' ? 100 : 80, chargedTokensPerMinute: arm === 'A' ? 1000 : 800, costPerCallUsd: arm === 'A' ? 1 : .8, costPerMinuteUsd: arm === 'A' ? 10 : 8 }, firstPlayCall: { cacheWarmth: 'warm' }, modelCallsPerMinute: 10, actionsPerMinute: 10, deaths: 0, firstProgress: { at: 1000 }, goalCompleted: false, playWallTimeMs: 60000, timeToFirstProgressMs: 1000 }, ...extra });
const pairs = () => ['A', 'B'].map(arm => Array.from({ length: 8 }, (_, i) => run(i + 1, arm)));
test('reviewer PASS-on-crash and model mismatch reproductions are now inconclusive', () => {
 const [a, b] = pairs();
 for (const termination of ['ERROR', 'DEAD', 'PROFILE_MISMATCH', 'ASSERTION_MISMATCH', 'CLEANUP_FAILURE']) assert.equal(pairedTokenConfidence(a, b.map(r => ({ ...r, termination, metrics: { ...r.metrics, deaths: 3, chargedTokensPerMinute: 50 } }))).verdict, 'INCONCLUSIVE');
 assert.equal(pairedTokenConfidence(a, b.map(r => ({ ...r, providerAttestation: { effective: { ...profile, model: 'other' } } }))).verdict, 'INCONCLUSIVE');
 assert.equal(pairedTokenConfidence(a, b.map(r => ({ ...r, metrics: { ...r.metrics, rateLimitedProviderRows: 1 } }))).verdict, 'INCONCLUSIVE');
});
test('single verdict prevents idle cost pass and guards completion, deaths and progress', () => {
 const [a, b] = pairs();
 assert.equal(pairedTokenConfidence(a, b).verdict, 'PASS');
 for (const metrics of [{ modelCallsPerMinute: .1, actionsPerMinute: .1 }, { deaths: 3 }, { firstProgress: null }]) assert.equal(pairedTokenConfidence(a, b.map(r => ({ ...r, metrics: { ...r.metrics, ...metrics } }))).verdict, 'COST_PASS_QUALITY_REGRESSION');
 assert.equal(pairedTokenConfidence(a.map(r => ({ ...r, goalCompleted: true })), b).verdict, 'COST_PASS_QUALITY_REGRESSION');
});
test('log ratios are scale independent, BA is accepted and exact permutation must agree', () => {
 const [a, b] = pairs();
 for (let i = 0; i < 8; i += 2) [a[i].executionOrder, b[i].executionOrder] = [b[i].executionOrder, a[i].executionOrder];
 const result = pairedTokenConfidence(a, b);
 assert.equal(result.verdict, 'PASS'); assert.ok(Math.abs(result.perCallLogRatio.mean - Math.log(.8)) < 1e-12); assert.equal(result.signFlip.perCall.pValue, 1 / 256);
 assert.equal(pairedTokenConfidence(a.slice(0, 4), b.slice(0, 4)).verdict, 'FAIL');
 const scale = r => ({ ...r, metrics: { ...r.metrics, steadyState: { ...r.metrics.steadyState, chargedTokensPerCall: r.metrics.steadyState.chargedTokensPerCall * Number(r.pairId.endsWith('1') ? 100 : 1) } } });
 assert.equal(pairedTokenConfidence(a.map(scale), b.map(scale)).perCallLogRatio.mean, result.perCallLogRatio.mean);
 assert.equal(pairedTokenConfidence(a, b.map(r => ({ ...r, metrics: { ...r.metrics, firstPlayCall: { cacheWarmth: 'cold' } } }))).verdict, 'PASS');
});
const call = (id, at, input, cacheRead = 0, output = 10) => ({ event: 'native_model_call', modelCallId: id, agentId: 'a', goalRevision: 1, model: profile.model, at, totalMs: 1000, inputTokens: input + cacheRead, cachedInputTokens: cacheRead, outputTokens: output, partialMessagesAccepted: true });
const extract = extra => extractQualityMetrics({ profile, scenario: { setup: { dimension: 'minecraft:overworld', inventory: [] } }, startedAt: 0, endedAt: 60000, ...extra });
const usage = (input, cached, output) => ({ event: 'native_token_usage', scope: 'thread_total', agentId: 'a', goalRevision: 1, inputTokens: input + cached, cachedInputTokens: cached, outputTokens: output });
test('steady state excludes prep and first play; reconciliation checks each category and call corrections', () => {
 const rows = [call('first', 10000, 1000, 100), call('second', 20000, 100), call('second', 20000, 100, 0, 12), usage(1100, 100, 22)];
 const m = extract({ traceRows: rows, providerRows: [{ provider: 'claude', model: profile.model, tokens: { input: 5000, cacheWrite: 5000, output: 1000 } }] });
 assert.equal(m.playModelCalls, 2); assert.equal(m.steadyState.chargedTokensPerCall, 112); assert.equal(m.steadyState.chargedTokensPerMinute, 134.4); assert.equal(m.preparation.chargedTokens, 11000); assert.equal(m.firstPlayCall.cacheWarmth, 'warm'); assert.equal(m.firstPlayCall.tokens.cacheRead, 100); assert.equal(m.tokenReconciliation.complete, true);
 assert.equal(extract({ traceRows: [call('first', 10000, 100), usage(110, 0, 10)] }).tokenReconciliation.complete, false);
 assert.equal(extract({ traceRows: [call('first', 10000, 100), usage(100, 1, 10)] }).tokenReconciliation.complete, false);
 assert.equal(extract({ traceRows: [call('first', 10000, 100), usage(102, 0, 10)] }).tokenReconciliation.complete, true);
});
test('progress summary includes censored windows and death cause counts', () => {
 const [a, b] = pairs(); b[0].metrics.firstProgress = null; b[0].metrics.timeToFirstProgressMs = null; b[0].metrics.deathEvents = [{ cause: 'fall' }];
 const report = runs => ({ runs, coordinatorSha256: 'c', jar: { sha256: 'j' }, harnessCommit: 'h', instrumentationSha256: 'i', scenarioDataSha256: 's' });
 for (const r of [...a, ...b]) r.definition = { durationBudgetMs: 60000 };
 const comparison = compareQualityReports(report(a), report(b))[0];
 assert.equal(comparison.progress.after.censored, 1); assert.equal(comparison.progress.after.timeMs.mean, 8375); assert.equal(comparison.deathCauses.after.fall, 1); assert.equal(comparison.tokenConfidence.interpretation, 'DESCRIPTIVE'); assert.equal('verdict' in comparison.tokenConfidence, false);
});

test('reconciliation rejects >2% discrepancies independently in all four categories across respawns', () => {
 const base = { ...call('c', 10000, 100, 100, 100), cacheWriteInputTokens: 100, inputTokens: 300 };
 const thread = { ...usage(100, 100, 100), cacheWriteInputTokens: 100, inputTokens: 300, sessionKey: 'same' };
 for (const category of ['input', 'cacheRead', 'cacheWrite', 'output']) {
  const changed = { ...base };
  if (category === 'input') changed.inputTokens += 3;
  if (category === 'cacheRead') { changed.cachedInputTokens += 3; changed.inputTokens += 3; }
  if (category === 'cacheWrite') { changed.cacheWriteInputTokens += 3; changed.inputTokens += 3; }
  if (category === 'output') changed.outputTokens += 3;
  const reconciliation = extract({ traceRows: [changed, thread] }).tokenReconciliation;
  assert.equal(reconciliation.complete, false); assert.equal(reconciliation.categories[category].difference, 3);
 }
 const m = extract({ traceRows: [base, { ...thread, inputTokens: 150, cachedInputTokens: 50, cacheWriteInputTokens: 50, outputTokens: 50 }, { ...thread, goalRevision: 3 }] });
 assert.equal(m.tokenReconciliation.complete, true); assert.equal(m.tokenReconciliation.threadTotals.output, 100);
 assert.equal(extract({ traceRows: [base], providerRows: [{ traceId: 'play', model: profile.model, executionSettings: { effective: { model: 'fallback' } } }] }).providerMismatches, 1);
});
test('permutation agrees with brute-force enumeration, and pooled 24-pair weighting is equal', () => {
 const values = [-.2, -.1, .04, -.07, .03];
 let sums = [0]; for (const v of values) sums = sums.flatMap(s => [s - v, s + v]);
 const observed = values.reduce((n, v) => n + v, 0);
 assert.equal(signFlipPermutation(values).pValue, sums.filter(s => s <= observed + 1e-12).length / sums.length);
 const a = [], b = [];
 for (const scenario of ['S1', 'S1-deltas', 'S5']) for (let i = 1; i <= 8; i++) {
  for (const [arm, runs] of [['A', a], ['B', b]]) runs.push({ ...run(i, arm), scenario, pairId: `${scenario}-r${i}`, executionOrder: (a.length + b.length) + 1 });
 }
 const result = pairedTokenConfidence(a, b);
 assert.equal(result.pairs, 24); assert.equal(result.verdict, 'PASS'); assert.equal(result.signFlip.perCall.pValue, 1 / 2 ** 24);
});
test('actual retry chronology fences mixed old/new attempts even if original order is adjacent', () => {
 const [a, b] = pairs(); a[0].actualExecutionOrder = 20; b[0].actualExecutionOrder = 23;
 assert.equal(pairedTokenConfidence(a, b).verdict, 'INCONCLUSIVE');
 a[0].actualExecutionOrder = 22;
 assert.equal(pairedTokenConfidence(a, b).verdict, 'PASS');
});

test('real comparison CLI emits one pooled verdict with descriptive scenario intervals', async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-verdict-'));
 try {
  const [a, b] = pairs();
  for (const r of [...a, ...b]) r.definition = { durationBudgetMs: 60000 };
  const report = runs => ({ runs, coordinatorSha256: 'c', jar: { sha256: 'j' }, harnessCommit: 'h', instrumentationSha256: 'i', scenarioDataSha256: 's' });
  const file = path.join(directory, 'paired.json');
  await writeFile(file, JSON.stringify({ complete: true, arms: { A: report(a), B: report(b) } }));
  const cli = fileURLToPath(new URL('../../scripts/quality/compare-scenarios.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, file], { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.overall.verdict, 'PASS'); assert.equal((stdout.match(/"verdict"/g) ?? []).length, 1); assert.equal(result.scenarios[0].tokenConfidence.interpretation, 'DESCRIPTIVE');
  b[0].termination = 'ERROR';
  await writeFile(file, JSON.stringify({ complete: true, arms: { A: report(a), B: report(b) } }));
  const failed = JSON.parse((await promisify(execFile)(process.execPath, [cli, file], { windowsHide: true })).stdout);
  assert.equal(failed.overall.verdict, 'INCONCLUSIVE');
 } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shared speed extractor counts corrected native call IDs once', () => {
 const rows = [call('one', 1000, 100, 0, 2), call('one', 1000, 100, 0, 12)];
 const metrics = deriveRunMetrics({ traceRows: rows, profile });
 assert.equal(metrics.modelRounds, 1); assert.equal(metrics.tokens.output, 12); assert.equal(metrics.tokens.input, 100);
});

test('first-call warmth is descriptive per pair and one mismatch cannot void steady-state gates', () => {
 const [a, b] = pairs();
 b[0].metrics.firstPlayCall = { cacheWarmth: 'cold' };
 const result = pairedTokenConfidence(a, b);
 assert.equal(result.verdict, 'PASS');
 assert.equal(result.cacheWarmthMatched, false); assert.equal(result.cacheWarmthMismatches, 1);
 assert.deepEqual(result.perPair[0].firstCallWarmth, { A: 'warm', B: 'cold' });
 assert.equal(pairedTokenConfidence(a, b.map(r => ({ ...r, metrics: { ...r.metrics, firstPlayCall: null } }))).verdict, 'PASS');
});

test('saved model rounds pass unless actions or progress also drops', () => {
 const [a, b] = pairs();
 const fewer = b.map(r => ({ ...r, metrics: { ...r.metrics, modelCallsPerMinute: 5 } }));
 assert.equal(pairedTokenConfidence(a, fewer).verdict, 'PASS');
 assert.equal(pairedTokenConfidence(a, fewer.map(r => ({ ...r, metrics: { ...r.metrics, actionsPerMinute: 7 } }))).verdict, 'COST_PASS_QUALITY_REGRESSION');
 assert.equal(pairedTokenConfidence(a, fewer.map(r => ({ ...r, metrics: { ...r.metrics, firstProgress: null } }))).qualityGuards.callsPerMinute.status, 'REGRESSED');
 assert.equal(pairedTokenConfidence(a, fewer.map(r => ({ ...r, metrics: { ...r.metrics, actionsPerMinute: null } }))).verdict, 'INCONCLUSIVE', 'missing activity evidence cannot establish a healthy stall guard');
});

test('first-attempt failure guard counts incomplete measurement, balanced failures and missing originals', () => {
 const [a, b] = pairs();
 const fail = (runs, count, changes) => runs.map((r, i) => ({ ...r, ...(i < count ? changes : {}) }));
 const options = (firstAttemptsBefore, firstAttemptsAfter) => ({ firstAttemptsBefore, firstAttemptsAfter });
 const onlyB = pairedTokenConfidence(a, b, options(a, fail(b, 1, { measurementStatus: 'INCOMPLETE' })));
 assert.equal(onlyB.verdict, 'COST_PASS_QUALITY_REGRESSION');
 assert.deepEqual(onlyB.qualityGuards.firstAttemptFailures.B.byMeasurementStatus, { INCOMPLETE: 1 });
 const balanced = pairedTokenConfidence(a, b, options(fail(a, 1, { termination: 'ERROR' }), fail(b, 1, { measurementStatus: 'INCOMPLETE' })));
 assert.equal(balanced.verdict, 'PASS');
 assert.equal(pairedTokenConfidence(a, b, options(fail(a, 2, { termination: 'ERROR' }), fail(b, 1, { termination: 'ERROR' }))).verdict, 'PASS');
 assert.equal(pairedTokenConfidence(a, b, options(a, b.map(r => ({ ...r, retry: true, retryAttempt: 1 })))).verdict, 'INCONCLUSIVE');
});

test('body idle is goal time with no body action running: overlapping chat is not charged and edges count', () => {
 const t = (event, actionId, actionType, at) => ({ event, agentId: 'a', goalRevision: 1, actionId, actionType, observedAtMs: at });
 const span = (id, type, start, end) => [t('native_tool_dispatch_started', id, type, start), ...(end === null ? [] : [t('native_tool_action_completed', id, type, end)])];
 const idle = (rows, start = 0, end = 1000) => deriveRunMetrics({ traceRows: rows.flat(), profile, goalStartedAtMs: start, goalCompletedAtMs: end });
 const overlap = idle([span('b1', 'break_block', 0, 100), span('c1', 'chat', 10, 200), span('b2', 'break_block', 900, 1000)]);
 assert.equal(overlap.bodyIdleTimeMs, 800); assert.equal(overlap.bodyIdleShare, 0.8);
 assert.equal(idle([span('b1', 'break_block', 0, 400), span('b2', 'break_block', 600, 1000)]).bodyIdleTimeMs, 200);
 // Initial and final idle count; overlapping body actions are merged; a repeated completion row is one action.
 assert.equal(idle([span('b1', 'break_block', 100, 500), span('b2', 'navigate_to', 300, 700), [t('native_tool_action_completed', 'b1', 'break_block', 500)]]).bodyIdleTimeMs, 400);
 // Clipped to the goal window.
 assert.equal(idle([span('b1', 'break_block', -500, 100), span('b2', 'break_block', 800, 1500)]).bodyIdleTimeMs, 700);
 // A missing completion is missing evidence: the figure is unknown, not shortened by assuming the action ran on.
 assert.equal(idle([span('b1', 'break_block', 100, 200), span('b2', 'break_block', 800, 900)]).bodyIdleTimeMs, 800);
 assert.equal(idle([span('b1', 'break_block', 100, null), span('b2', 'break_block', 800, 900)]).bodyIdleTimeMs, null);
 assert.equal(idle([span('b1', 'break_block', 100, 200), span('b2', 'break_block', 800, null)]).bodyIdleShare, null);
 // Unknown, not zero, without a goal window or with a dispatch lacking a timestamp.
 assert.equal(deriveRunMetrics({ traceRows: span('b1', 'break_block', 0, 100), profile }).bodyIdleTimeMs, null);
 assert.equal(idle([[{ ...t('native_tool_dispatch_started', 'b1', 'break_block', 0), observedAtMs: undefined }]]).bodyIdleTimeMs, null);
});

test('zombie reaction counts only a combat request made after the threat appeared', () => {
 const spawn = 100;
 const metrics = rows => deriveRunMetrics({ traceRows: rows, profile, zombieSpawnAtMs: spawn }).zombie.timeToFirstCombatActionMs;
 const dispatch = (actionId, at) => ({ event: 'native_tool_dispatch_started', agentId: 'a', goalRevision: 1, actionId, actionType: 'fight_target', observedAtMs: at });
 const completed = (actionId, at) => ({ event: 'native_tool_action_completed', agentId: 'a', goalRevision: 1, actionId, actionType: 'fight_target', state: 'FAILED', observedAtMs: at });
 assert.equal(metrics([dispatch('f1', 90), completed('f1', 110)]), null);
 assert.equal(metrics([dispatch('f1', 90), completed('f1', 110), dispatch('f2', 120)]), 20);
 const command = (direction, at) => ({ direction, envelope: { type: 'action_command', agentId: 'a', payload: { actionId: 'f3', goalRevision: 1, actionType: 'fight_target' } }, observedAtMs: at });
 assert.equal(deriveRunMetrics({ traceRows: [dispatch('f1', 90)], protocolRows: [command('coordinator_to_server', 130)], profile, zombieSpawnAtMs: spawn }).zombie.timeToFirstCombatActionMs, 30);
 assert.equal(deriveRunMetrics({ traceRows: [dispatch('f1', 90)], protocolRows: [command('server_to_coordinator', 130)], profile, zombieSpawnAtMs: spawn }).zombie.timeToFirstCombatActionMs, null);
});
