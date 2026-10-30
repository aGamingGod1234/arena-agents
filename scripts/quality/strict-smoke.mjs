import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runLong, parseLongArgs } from './run-long.mjs';
import { runScenarios } from './run-scenarios.mjs';
import { startAnthropicGateway } from '../../coordinator/src/benchmark/spend-gate.mjs';
import { SpendLedger } from '../../coordinator/src/benchmark/spend-ledger.mjs';
import { providerCallTokens } from '../../coordinator/src/benchmark/quality-metrics.mjs';
import { spawnOwnedProcess, terminateChildProcess, prepareOwnedJobStop } from '../../coordinator/src/child-process-lifecycle.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
const sum = values => values.reduce((a, b) => a + b, 0);
const exited = child => child && (child.exitCode !== null || child.signalCode !== null);
const hash = body => createHash('sha256').update(body).digest('hex');
// Reconcile actual provider categories independently of admission's conservative ceiling.
// https://platform.claude.com/docs/en/about-claude/pricing
export function providerUsageCost(usage) {
 const valid = value => Number.isSafeInteger(value) && value >= 0;
 if (!usage || Object.keys(usage).some(key => !['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation', 'inference_geo', 'service_tier', 'output_tokens_details', 'server_tool_use'].includes(key)) || !valid(usage.input_tokens) || !valid(usage.output_tokens)) return null;
 if (usage.inference_geo !== undefined && usage.inference_geo !== 'global' || usage.service_tier !== undefined && usage.service_tier !== 'standard') return null;
 if (usage.output_tokens_details !== undefined && (!usage.output_tokens_details || Object.keys(usage.output_tokens_details).some(key => key !== 'thinking_tokens') || !valid(usage.output_tokens_details.thinking_tokens) || usage.output_tokens_details.thinking_tokens > usage.output_tokens)) return null;
 if (usage.server_tool_use !== undefined && usage.server_tool_use !== null && (Object.keys(usage.server_tool_use).some(key => !['web_search_requests', 'web_fetch_requests'].includes(key)) || Object.values(usage.server_tool_use).some(value => value !== 0))) return null;
 const read = usage.cache_read_input_tokens ?? 0, writes = usage.cache_creation_input_tokens ?? 0;
 if (!valid(read) || !valid(writes)) return null;
 if (usage.cache_creation && Object.keys(usage.cache_creation).some(key => !['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'].includes(key))) return null;
 const five = usage.cache_creation?.ephemeral_5m_input_tokens ?? (writes === 0 ? 0 : null);
 const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? (writes === 0 ? 0 : null);
 if (!valid(five) || !valid(hour) || five + hour !== writes) return null;
 return (usage.input_tokens * 4 + usage.output_tokens * 20 + read * .2 + five * 5 + hour * 8) / 1e6;
}
const tokenKey = tokens => tokens ? ['input', 'output', 'cacheRead', 'cacheWrite'].map(key => tokens[key]).join(':') : null;
const matchesId = (row, call) => typeof call.responseId === 'string' && call.responseId.length > 0 && typeof row.modelCallId === 'string' && (row.modelCallId === call.responseId || row.modelCallId.endsWith(':' + call.responseId));
const correlated = (row, calls) => {
 const matches = calls.filter(call => matchesId(row, call));
 return matches.length === 1 ? matches[0] : null;
};
function completeGameplayAccounting(rows, calls) {
 if (rows.length !== calls.length || new Set(calls.map(call => call.responseId)).size !== calls.length) return false;
 const consumed = new Set();
 for (const row of rows) {
  const call = correlated(row, calls);
  if (!call || consumed.has(call.responseId) || tokenKey(providerCallTokens(row)) !== tokenKey(call.tokens)) return false;
  consumed.add(call.responseId);
 }
 return consumed.size === calls.length;
}
const usageKey = usage => usage ? JSON.stringify([usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0, usage.cache_creation?.ephemeral_5m_input_tokens ?? 0, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0]) : null;

function auditCheck(e, billed) {
 const audit = e.providerAudit;
 if (!audit) return null;
 if (audit.schemaVersion !== 1 || audit.source !== 'provider' || audit.complete !== true || !Array.isArray(audit.calls)
  || !e.scope || !['runId', 'startedAt', 'endedAt'].every(key => audit.scope?.[key] === e.scope[key]) || !(audit.generatedAt >= e.scope.endedAt)) return false;
 if (audit.calls.length !== billed.length || new Set(audit.calls.map(call => call.responseId)).size !== audit.calls.length) return false;
 let total = 0;
 for (const call of audit.calls) {
  const gateway = billed.find(row => row.responseId === call.responseId);
  const cost = providerUsageCost(call.usage);
  if (!gateway || call.model !== 'claude-opus-5-5' || cost === null || usageKey(call.usage) !== usageKey(gateway.usage) || !same(cost, gateway.usd)
   || call.billedUsd !== undefined && !same(call.billedUsd, cost)) return false;
  total += cost;
 }
 return total <= 3 + 1e-9 && same(total, e.gate.chargeUsd) && (audit.billingTotalUsd === undefined || same(audit.billingTotalUsd, total));
}

export function evaluateSmoke(e) {
 try {
 const billed = e.calls.filter(call => !call.denied);
 const final = billed.filter(call => call.status === 200 && call.tokens);
 const end = e.goalStartedAt + 60000;
 const sequencePresent = Number.isFinite(e.goalStartedAt) && e.gameplay.length > 0 && e.boundary && e.following;
 const gameplayIdentity = e.gameplay.length && e.goalAgentId && Number.isSafeInteger(e.goalRevision) ? e.gameplay.every(row => row.agentId === e.goalAgentId && row.goalRevision === e.goalRevision && correlated(row, final)) : null;
 const sequenceValid = sequencePresent && gameplayIdentity && Number.isFinite(e.goalObservedAt) && Number.isFinite(e.gameplayObservedAt)
  && e.goalStartedAt <= e.goalObservedAt && e.goalObservedAt <= e.gameplayObservedAt && e.gameplayObservedAt <= e.boundary.at
  && e.boundary.at <= e.boundary.completedAt && e.boundary.completedAt <= e.following.at && e.following.at <= e.following.completedAt && e.following.completedAt <= end
  && e.gameplay.some(row => { const call = correlated(row, final); return call && call.at >= e.goalStartedAt && call.at <= row.endedAt && row.endedAt <= e.gameplayObservedAt && (row.requestAt ?? row.startedAt) >= e.goalStartedAt && (row.requestAt ?? row.startedAt) <= row.endedAt && row.at <= e.boundary.at; });
 const checks = {
  gatewayAddress: typeof e.gatewayUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(e.gatewayUrl),
  sequence: sequenceValid ? true : null,
  gameplayIdentity,
  boundary: e.boundary ? e.boundary.status === 400 && e.boundary.forwarded === false && /Evaluator spend cap:/.test(e.boundary.reason ?? '') : null,
  closedRetry: e.following ? e.following.status === 400 && e.following.forwarded === false && e.gate.closed && e.gate.closeReason === 'SPEND_CAP' : null,
  escalation: e.boundary && e.stop ? e.stop.reason === 'SPEND_CAP' && e.stop.hardStopped === true && e.injectedStopFailures.length > 0 : null,
  cleanup: e.cleanup ? e.cleanup.status === 'COMPLETE' && e.cleanup.allMembersExited === true && e.cleanup.frozenMemberCount > 0 && e.cleanup.jobHandleClosedBeforeStop === true && e.cleanup.wrapperExited === true && e.cleanup.observationHandlesClosed === true : null,
  sentinel: e.sentinel.aliveBeforeStop === true && e.sentinel.exitConfirmed === true,
  auxiliary: e.auxiliary.length === 0 && e.judgeRequests === 0,
  outboundAccounting: billed.length === e.outbound.length && e.outbound.every(out => out.pendingUsd >= out.worstUsd && billed.some(call => call.id === out.id)) && new Set(e.outbound.map(out => out.id)).size === e.outbound.length,
  gameplayAccounting: e.gameplay.length ? completeGameplayAccounting(e.gameplay, final) : null,
  providerAccounting: auditCheck(e, billed),
  integrity: e.integrity ? e.integrity.errors.length === 0 && e.integrity.scanErrors.length === 0 && e.integrity.sourceChanged === false && e.integrity.measurementStatus === 'MEASURED' && e.integrity.files.length === 3 && e.integrity.files.every(file => file.ok === true) : null,
  noOverrun: e.gate.overruns.length === 0,
  cap: Number.isFinite(e.gate.chargeUsd) && e.gate.chargeUsd <= 3 + 1e-9 && e.gate.chargeUsd >= 0 && same(e.gate.chargeUsd, e.gate.committedUsd + e.gate.pendingUsd) && e.outbound.every(call => call.chargeUsd <= 3 + 1e-9 && same(call.chargeUsd, call.pendingUsd + call.committedUsd)),
  ledger: e.ledger ? same(e.ledger.committedUsd + e.ledger.reservedUsd, e.gate.chargeUsd) && same(e.reportChargeUsd, e.gate.chargeUsd) : null,
  rates: billed.length ? billed.every(call => call.exactUsage === true && same(call.usd, providerUsageCost(call.usage))) && same(sum(billed.map(call => call.usd)), e.gate.chargeUsd) : null,
  errors: e.errors.length === 0,
 };
 // Missing goal/gameplay naturally lacks a measured window; damaged evidence is still a failure.
 if (!sequencePresent && e.integrity && e.integrity.errors.length === 0 && e.integrity.scanErrors.length === 0 && e.integrity.sourceChanged === false && e.integrity.files.length === 3 && e.integrity.files.every(file => file.ok)) checks.integrity = null;
 const failures = Object.keys(checks).filter(key => checks[key] === false);
 const missing = Object.keys(checks).filter(key => checks[key] === null);
 return { status: failures.length ? 'FAIL' : e.timedOut || missing.length ? 'INCOMPLETE' : 'PASS', checks, failures, missing };
 } catch { return { status: 'INCOMPLETE', checks: { evidenceShape: null }, failures: [], missing: ['evidenceShape'] }; }
}

async function evidenceIntegrity(observer, result) {
 const run = result?.runs?.[0];
 const integrity = { errors: [...(observer?.errors ?? []), ...(run?.observerErrors ?? []), ...(run?.terminalObserverErrors ?? []).map(error => error.message)], scanErrors: result?.scanErrors ?? ['Missing runner result'], sourceChanged: result?.sourceChangedDuringRun ?? null, measurementStatus: run?.measurementStatus ?? null, files: [] };
 if (!observer) return integrity;
 for (const tail of [observer.trace, observer.protocol, observer.provider]) {
  const file = { path: tail.file, name: path.basename(tail.file), ok: false };
  try {
   const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(tail.file));
   const lines = text.split(/\r?\n/).filter(line => line.trim());
   const rows = lines.map(line => JSON.parse(line));
   const normalized = row => { const { observedAtMs, ...rest } = row; return JSON.stringify(rest); };
   file.ok = (!text || text.endsWith('\n')) && !tail.droppedLines && !tail.truncations && rows.length === tail.rows.length && rows.every((row, index) => normalized(row) === normalized(tail.rows[index]));
   file.sha256 = hash(text); file.rows = rows.length;
  } catch (error) { file.error = error.message; }
  integrity.files.push(file);
 }
 return integrity;
}

export async function runStrictSmoke(options, { spawnLauncher = spawnOwnedProcess, upstream = 'https://api.anthropic.com', fetchImpl = fetch, configureObserver = null, providerAudit = null, timeoutMs = 360000 } = {}) {
 if (process.platform !== 'win32') throw new Error('Strict smoke requires Windows owned-job cleanup evidence');
 if (options.provider !== 'claude' || options.model !== 'claude-opus-5-5' || options.capUsd !== 3 || options.windowMs !== 60000 || options.codexObserverCap || options.goal !== 'Beat the game' || options.priorSpendUsd || options.runReserveUsd || options.arms) throw new Error('Smoke requires exact Beat the game, Claude Opus 5.5, 1 minute, $3, and no prior spend/observer/arms override');
 if (!options.ledger || existsSync(options.ledger) || existsSync(options.out)) throw new Error('Smoke requires fresh ledger and output paths');
 await mkdir(options.out, { recursive: true });
 const scope = { runId: randomUUID(), startedAt: Date.now(), endedAt: null };
 await writeFile(path.join(options.out, 'smoke-scope.json'), JSON.stringify(scope));
 const evidence = { scope, providerAudit: null, integrity: null, goalAgentId: null, goalRevision: null, goalObservedAt: null, gameplayObservedAt: null, gatewayUrl: null, outbound: [], calls: [], goalStartedAt: null, gameplay: [], auxiliary: [], judgeRequests: 0, boundary: null, following: null, gate: { chargeUsd: 0, overruns: [] }, stop: null, injectedStopFailures: [], cleanup: null, sentinel: {}, ledger: null, reportChargeUsd: null, errors: [], timedOut: false };
 const evidencePath = path.join(options.out, 'owned-job-proof.json');
 const journal = path.join(options.out, 'gateway-outbound.jsonl');
 let gateway, gate, launcher, observer, sequence, longReport, runnerResult, monitorBusy = false;
 let journalQueue = Promise.resolve();
 const start = performance.now();
 let preparingStop;
 const prepareStop = () => preparingStop ??= (async () => {
  try { await prepareOwnedJobStop(launcher); } catch (error) { evidence.errors.push(error.message); }
 })();
 const stopLauncher = async () => {
  if (!launcher || exited(launcher)) return;
  await prepareStop();
  await terminateChildProcess(launcher, { timeoutMs: 15000 });
 };
 // This sentinel is created before any suite job exists; only this retained child handle can stop it.
 const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
 let sentinelError;
 sentinel.on('error', error => { sentinelError = error; });
 const record = async event => { evidence.outbound.push(event); journalQueue = journalQueue.then(() => appendFile(journal, JSON.stringify(event) + '\n')); await journalQueue; };
 const send = async body => {
  const text = JSON.stringify(body), sha = hash(text), at = Date.now();
  const response = await fetch(gateway.url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: AbortSignal.timeout(5000) });
  const responseText = await response.text();
  let reason = ''; try { reason = JSON.parse(responseText).error?.message ?? ''; } catch {}
  return { reason, status: response.status, at, completedAt: Date.now(), requestSha256: sha, forwarded: evidence.outbound.some(call => call.requestSha256 === sha) };
 };
 const collect = () => {
  if (!observer) return;
  const starts = observer.protocol.rows.filter(row => row.direction === 'server_to_coordinator' && (row.envelope ?? row).agentId === observer.agentId && (row.envelope ?? row).type === 'goal_control' && (row.envelope ?? row).payload?.operation === 'start');
  const last = starts.at(-1); evidence.goalStartedAt = last ? (last.envelope ?? last).payload.updatedAtEpochMs ?? last.observedAtMs : null;
  if (last) { evidence.goalAgentId = (last.envelope ?? last).agentId; evidence.goalRevision = (last.envelope ?? last).payload.goalRevision ?? null; evidence.goalObservedAt ??= Date.now(); }
  const calls = new Map();
  for (const row of observer.trace.rows) if (row.event === 'native_model_call') calls.set(row.modelCallId ?? JSON.stringify(row), row);
  evidence.gameplay = [...calls.values()].filter(row => row.goalRevision >= 1 && row.provider === 'claude' && row.model === options.model);
  evidence.auxiliary = [...calls.values()].filter(row => !evidence.gameplay.includes(row));
  for (const row of observer.provider.rows) if (row.provider !== 'claude' || row.goalRevision < 1) evidence.auxiliary.push({ provider: row.provider, goalRevision: row.goalRevision });
  if (evidence.goalStartedAt !== null && gateway?.calls.some(call => !call.denied && evidence.gameplay.some(row => row.agentId === evidence.goalAgentId && row.goalRevision === evidence.goalRevision && matchesId(row, call)))) evidence.gameplayObservedAt ??= Date.now();
  evidence.stop = observer.stopRequest ?? null;
 };
 const monitor = async () => {
  if (monitorBusy) return;
  monitorBusy = true;
  try {
   collect();
   if (performance.now() - start > timeoutMs || evidence.goalStartedAt !== null && Date.now() - evidence.goalStartedAt > 60000) {
    evidence.timedOut = true; gate?.close('SMOKE_INCOMPLETE'); await stopLauncher(); return;
   }
   if (!sequence && evidence.gameplayObservedAt !== null && gateway && evidence.goalStartedAt !== null && evidence.gameplay.length && evidence.outbound.some(call => call.at >= evidence.goalStartedAt)) {
    sequence = (async () => {
     evidence.boundary = await send({ model: options.model, max_tokens: 4096, messages: [{ role: 'user', content: 'x'.repeat(1000000) }] });
     await observer.enforceSpendCap();
     evidence.following = await send({ model: options.model, max_tokens: 4096, messages: [{ role: 'user', content: 'smoke: refused after gate closure' }] });
    })();
    await sequence;
   }
   if (performance.now() - start > timeoutMs || evidence.goalStartedAt !== null && Date.now() - evidence.goalStartedAt > 60000 && !sequence) {
    evidence.timedOut = true; gate?.close('SMOKE_INCOMPLETE');
    await stopLauncher();
   }
  } catch (error) { evidence.errors.push(error.message); gate?.close('SMOKE_ERROR'); await stopLauncher(); }
  finally { monitorBusy = false; }
 };
 const timer = setInterval(() => { void monitor(); }, 50);
 try {
  longReport = await runLong(options, { execute: async args => {
   gate = args.spendGate;
   runnerResult = await runScenarios(args, {
    gatewayFactory: async settings => {
     gateway = await startAnthropicGateway({ ...settings, upstream, fetchImpl, onOutbound: record });
     evidence.gatewayUrl = gateway.url;
     await writeFile(path.join(options.out, 'gateway.json'), JSON.stringify({ url: gateway.url }));
     return gateway;
    },
    spawnLauncher: (command, args, settings) => launcher = spawnLauncher(command, args, { ...settings, ownedJobEvidencePath: evidencePath }),
    onObserver: value => {
     observer = value;
     configureObserver?.(observer);
     const hardStop = observer.hardStop;
     observer.hardStop = async reason => { await prepareStop(); await hardStop(reason); };
     observer.stopCommand = async command => { evidence.injectedStopFailures.push({ at: Date.now(), command }); return { text: 'Error: smoke injected RCON stop failure' }; };
    },
   });
   return runnerResult;
  } });
 } catch (error) { evidence.errors.push(error.message); }
 finally {
  clearInterval(timer);
  while (monitorBusy) await sleep(20);
  await sequence?.catch(() => {});
  gate?.close('SMOKE_FINISHED');
  await stopLauncher().catch(error => evidence.errors.push(error.message));
  collect();
  evidence.calls = gateway?.calls ?? [];
  evidence.gate = gate?.totals() ?? evidence.gate;
  evidence.reportChargeUsd = longReport?.spend.usd ?? null;
  evidence.judgeRequests = runnerResult?.runs?.reduce((total, run) => total + (run.judge?.attempts?.length ?? 0), 0) ?? 0;
  const proofDeadline = performance.now() + 12000;
  while (launcher && !existsSync(evidencePath) && performance.now() < proofDeadline) await sleep(50);
  try { evidence.cleanup = JSON.parse(await readFile(evidencePath, 'utf8')); } catch { /* Missing ownership proof cannot pass. */ }
  evidence.sentinel.aliveBeforeStop = !sentinelError && !exited(sentinel);
  await terminateChildProcess(sentinel).catch(error => evidence.errors.push(error.message));
  evidence.sentinel.exitConfirmed = exited(sentinel);
  if (existsSync(options.ledger)) evidence.ledger = await new SpendLedger({ file: options.ledger, capUsd: 3 }).totals();
  await journalQueue;
  evidence.integrity = await evidenceIntegrity(observer, runnerResult);
  scope.endedAt = Date.now();
  await writeFile(path.join(options.out, 'smoke-scope.json'), JSON.stringify(scope));
  try { evidence.providerAudit = providerAudit ? await providerAudit({ ...scope }) : options.providerAuditFile ? JSON.parse(await readFile(options.providerAuditFile, 'utf8')) : null; } catch (error) { evidence.errors.push('Provider audit: ' + error.message); }
 }
 const result = { ...evaluateSmoke(evidence), evidence };
 await writeFile(path.join(options.out, 'strict-smoke.json'), JSON.stringify(result, null, 2));
 return result;
}

export async function verifySmokeReport(reportFile, auditFile) {
 const result = JSON.parse(await readFile(reportFile, 'utf8'));
 const evidence = result.evidence;
 try { evidence.providerAudit = JSON.parse(await readFile(auditFile, 'utf8')); }
 catch (error) { evidence.errors.push('Provider audit: ' + error.message); }
 for (const file of evidence.integrity?.files ?? []) {
  try { if (hash(await readFile(file.path)) !== file.sha256) evidence.errors.push('Evidence changed after capture: ' + file.name); }
  catch (error) { evidence.errors.push('Evidence unreadable after capture: ' + error.message); }
 }
 const verified = { ...evaluateSmoke(evidence), evidence };
 await writeFile(path.join(path.dirname(reportFile), 'strict-smoke-verified.json'), JSON.stringify(verified, null, 2));
 return verified;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const args = process.argv.slice(2);
  let result;
  if (args[0] === '--verify') {
   if (args.length !== 4 || args[2] !== '--provider-audit') throw new Error('Use --verify REPORT --provider-audit PROVIDER_EXPORT');
   result = await verifySmokeReport(path.resolve(args[1]), path.resolve(args[3]));
  } else {
   const auditIndex = args.indexOf('--provider-audit');
   let providerAuditFile;
   if (auditIndex !== -1) { if (!args[auditIndex + 1]) throw new Error('--provider-audit requires a file'); providerAuditFile = path.resolve(args[auditIndex + 1]); args.splice(auditIndex, 2); }
   const options = parseLongArgs(args);
   if (options.help) console.log('Use run-long arguments with --provider claude --model claude-opus-5-5 --budget-minutes 1 --max-total-cost-usd 3 and fresh --ledger/--out. PASS additionally requires --provider-audit FILE, or later --verify REPORT --provider-audit FILE. Windows only.');
   else result = await runStrictSmoke({ ...options, providerAuditFile });
  }
  if (result) { console.log(`Strict smoke: ${result.status}`); process.exitCode = result.status === 'PASS' ? 0 : result.status === 'INCOMPLETE' ? 2 : 1; }
 } catch (error) { console.error(error); process.exitCode = 1; }
}
