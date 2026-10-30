#!/usr/bin/env node
// Stream raw traces, retaining only threat/guard/timing evidence. Does not run a player or a provider.
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StandingOrderBook } from '../../coordinator/src/standing-orders.mjs';
import { normalizeMinecraftToolCall } from '../../coordinator/src/native-minecraft-tools.mjs';
const [directory, out] = process.argv.slice(2);
if (!directory || !out) throw new Error('analyze-reflex.mjs RUN_DIRECTORY OUTPUT_DIRECTORY');
await mkdir(out, { recursive: true });
async function* rows(file) {
  let line = 0;
  for await (const text of createInterface({ input: createReadStream(path.join(directory, file)), crlfDelay: Infinity })) {
    line++; if (!text.trim()) continue;
    try { yield { row: JSON.parse(text), ref: `${file}:${line}` }; } catch { throw new Error(`Invalid JSON at ${file}:${line}`); }
  }
}
const tools = [], calls = [], wakes = [];
for await (const { row: r, ref } of rows('provider-turns.private.jsonl')) {
  if (r.model !== 'gpt-6.1-sol') continue;
  calls.push({ at: r.timestamp, durationMs: r.timing?.durationMs, outcome: r.outcome, ref });
  for (const c of r.capture?.calls ?? []) {
    for (const t of c.toolCalls ?? []) {
      let args; try { args = typeof t.arguments === 'string' ? JSON.parse(t.arguments) : t.arguments; } catch { args = null; }
      tools.push({ at: t.at, name: t.name, args, ref, callIndex: c.index });
    }
    for (const i of c.inputs ?? []) if (i.kind !== 'tool_result') {
      let data; try { data = JSON.parse(i.text.slice(i.text.indexOf('\n') + 1)); data = data.data ?? data; } catch { continue; }
      if (data.now?.guard) wakes.push({ at: i.at, guard: data.now.guard, ref });
    }
  }
}
tools.sort((a, b) => a.at - b.at);
const events = [];
for await (const { row: r, ref } of rows('coordinator-private.jsonl')) {
  if (['native_tool_action_progress', 'native_token_usage', 'native_tool_journal_written', 'native_tool_journal_synced'].includes(r.event)) continue;
  const { agentId, traceId, mono, ...event } = r;
  events.push({ ...event, ref });
}
const edits = events.filter(r => ['standing_order_set', 'standing_order_deleted', 'standing_order_fired'].includes(r.event));
for (const e of edits.filter(r => r.event === 'standing_order_set')) {
  const tool = tools.findLast(t => t.at <= e.at && t.name === 'runProgram' && t.args?.standing && e.at - t.at < 1000);
  e.tool = tool;
  if (!tool) throw new Error(`Missing authored install ${e.ref}`);
  e.normalized = normalizeMinecraftToolCall(tool.name, tool.args);
  const hash = createHash('sha256').update(e.normalized.source).digest('hex').slice(0, 12);
  if (e.sourceHash && hash !== e.sourceHash) throw new Error(`Source mismatch ${e.ref}: ${hash} != ${e.sourceHash}`);
  e.origin = tool.args.standing.template ? 'template' : 'live-source';
}
let now = 0, editIndex = 0, revision = null;
const firstWake = events.find(e => e.event === 'native_event_ready' && e.trigger === 'start')?.at ?? -Infinity;
const book = new StandingOrderBook({ now: () => now });
const observations = [], deaths = [], firstThreat = new Map(), firstEntity = new Map(), counts = { alive: 0, guarded: 0, threatSamples: 0, guardedThreatSamples: 0, trueThreatSamples: 0, errorThreatSamples: 0 };
const files = (await readdir(directory)).filter(f => /^protocol.jsonl(?:\.\d+)?$/.test(f)).sort((a, b) => Number(b.split('.').at(-1)) - Number(a.split('.').at(-1)) || 0);
// Rotation suffixes decrease towards the current file.
files.sort((a,b)=>(Number(b.match(/\.(\d+)$/)?.[1])||0)-(Number(a.match(/\.(\d+)$/)?.[1])||0));
for (const file of files) for await (const { row: r, ref } of rows(file)) {
  const e = r.envelope ?? r, p = e.payload ?? {};
  if (e.type === 'goal_control' && p.operation === 'dead') deaths.push({ at: p.death?.diedAtEpochMs ?? p.updatedAtEpochMs, cause: p.death?.cause, revision: p.goalRevision, ref });
  if (e.type !== 'observation' || !p.ready || !p.player) continue;
  now = p.observedAtEpochMs;
  if (now < firstWake) continue;
  if (p.goalRevision !== revision) { book.clear('a'); revision = p.goalRevision; }
  while (editIndex < edits.length && edits[editIndex].at <= now) {
    const edit = edits[editIndex++];
    if (edit.goalRevision !== revision) continue;
    if (edit.event === 'standing_order_set') book.set('a', edit.normalized);
    if (edit.event === 'standing_order_deleted') book.delete('a', edit.id);
    if (edit.event === 'standing_order_fired') book.markFired('a', edit.id);
  }
  book.evaluate('a', p);
  const orders = book.list('a'), guarded = orders.some(g => g.guard), threats = p.threats?.entries ?? [];
  const guard = book.guardCoverage('a');
  counts.alive++; if (guarded) counts.guarded++;
  if (threats.length) { counts.threatSamples++; if (guarded) counts.guardedThreatSamples++; if (guard?.includes('condition true')) counts.trueThreatSamples++; if (orders.some(o => o.conditionError)) counts.errorThreatSamples++; }
  for (const t of threats) if (!firstThreat.has(t.uuid)) firstThreat.set(t.uuid, { at: now, ref, ...t });
  for (const entity of p.entities ?? []) if (!firstEntity.has(entity.uuid)) firstEntity.set(entity.uuid, { at: now, ref, uuid: entity.uuid, type: entity.type, perceivedBy: entity.perceivedBy, distance: entity.distance });
  const sounds = (p.perception?.events ?? []).filter(x => x.type === 'sound' && /creeper|zombie/.test(x.soundId ?? '')).map(x => ({ at: x.observedAtEpochMs, sound: x.soundId, direction: x.direction }));
  observations.push({ at: now, ref, revision, seq: p.eventSequence, health: p.player.health, attention: p.attention, changed: p.changedFacts, guard, conditionErrors: orders.filter(o => o.conditionError).map(o => ({ id:o.id, error:o.conditionError })), threats, sounds });
}
const timelineEvents = new Set(['native_provider_turn_sent','native_provider_turn_acked','native_provider_steer_sent','native_provider_steer_queued','native_turn_completed','native_turn_failed','native_tool_command_sent','native_tool_action_completed','native_program_started','native_program_ended','standing_order_fired','standing_order_set','standing_order_deleted']);
for (const [i, death] of deaths.entries()) {
  const start = death.at - 60000;
  const samples = observations.filter(o => o.at >= start && o.at <= death.at);
  const nearest = samples.at(-1)?.threats.find(t => death.cause.includes('Creeper') ? t.type === 'minecraft:creeper' : t.type === 'minecraft:zombie');
  const timeline = [
    ...samples.map(r => ({ kind:'observation', ...r })),
    ...events.filter(r => r.at >= start && r.at <= death.at + 1000 && timelineEvents.has(r.event)),
    ...tools.filter(t => t.at >= start && t.at <= death.at + 1000).map(t => ({ kind:'model-tool', ...t })),
    { kind:'death', ...death },
  ].sort((a,b)=>a.at-b.at).map(r=>({ relativeMs:r.at-death.at, ...r }));
  await writeFile(path.join(out, `death-${i+1}.json`), JSON.stringify({ death, probableAttacker:nearest?.uuid, firstThreat:firstThreat.get(nearest?.uuid), firstEntity:firstEntity.get(nearest?.uuid) ?? null, timeline }, null, 2));
}
const setEvents = edits.filter(e=>e.event==='standing_order_set');
const latency = events.filter(e=>e.event==='native_tool_command_sent').map(e=>e.dispatchMs).filter(Number.isFinite).sort((a,b)=>a-b);
const firings = edits.filter(e => e.event === 'standing_order_fired');
const guardDispatches = firings.map((f, i) => {
  const next = firings.slice(i + 1).find(g => g.id === f.id)?.at ?? Infinity;
  const action = events.find(e => e.at >= f.at && e.at < next && e.event === 'native_tool_command_sent' && e.callId?.startsWith(`standing-${f.id}-`));
  return { at: f.at, id: f.id, elapsedMs: action ? action.at - f.at : null, actionType: action?.actionType ?? null, ref: f.ref, commandRef: action?.ref ?? null };
});
const summary = { directory, clock:'Epoch milliseconds; display in UTC+08. First threat means earliest retained player observation, not spawn time. Guard conditions replayed from hash-verified source; true does not prove body admission. No artificial history or hidden server state used.', observationWindow: { first: observations[0]?.at, last: observations.at(-1)?.at }, counts, deathCount:deaths.length, deaths, installs:setEvents.map(({ normalized, ...e })=>e), firings:edits.filter(e=>e.event==='standing_order_fired'), wakeGuards:{ total:wakes.length, absent:wakes.filter(w=>w.guard==='none installed').length }, dispatchMs:{ n:latency.length, p50:latency[Math.floor(latency.length*.5)], p95:latency[Math.floor(latency.length*.95)], max:latency.at(-1) } };
summary.guardDispatches = guardDispatches;
summary.authorship = { sourceCalls: tools.filter(t => ['runProgram', 'queueProgram'].includes(t.name) && typeof t.args?.source === 'string').length, savedCalls: tools.filter(t => ['runProgram', 'queueProgram'].includes(t.name) && t.args?.noteKey).length, templateCalls: tools.filter(t => t.args?.standing?.template).length };
await writeFile(path.join(out,'summary.json'), JSON.stringify(summary,null,2));
await writeFile(path.join(out,'model-turns.json'),JSON.stringify(events.filter(e=>/native_(provider_turn_sent|turn_completed|turn_failed)/.test(e.event)),null,2));
console.log(JSON.stringify({ counts, deathCount:deaths.length, installs:setEvents.length, firings:summary.firings.length, wakeGuards:summary.wakeGuards, dispatchMs:summary.dispatchMs },null,2));
