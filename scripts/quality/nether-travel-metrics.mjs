#!/usr/bin/env node
// Read only the gameplay protocol, never provider workspaces. Teleports and sampling gaps are reported, not movement.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const [file, output, startArg, endArg] = process.argv.slice(2);
const windowStart = startArg === undefined ? null : Number(startArg), windowEnd = endArg === undefined ? null : Number(endArg);
if ((windowStart !== null && !Number.isFinite(windowStart)) || (windowEnd !== null && (!Number.isFinite(windowEnd) || windowStart === null || windowEnd < windowStart))) throw new Error('Invalid playing-window timestamps');
if (!file || !output) throw new Error('Usage: nether-travel-metrics.mjs quality-protocol.jsonl out.json [playing-start-ms playing-end-ms]');
const NETHER = 'minecraft:the_nether';
let last = null, last10 = null, entry = null, netherMs = 0, pathBlocks = 0, path10Blocks = 0, gaps = 0, excludedJumps = 0, deaths = 0, dead = false;
let firstFortress = null, maxFromEntry = 0, activeMs = 0, travelGain = 0, travelCalls = 0;
const calls = new Map(), reasons = {}, results = new Set();
let tickSpan = 0, tickWallMs = 0;
for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
 let row; try { row = JSON.parse(line); } catch { continue; }
 const e = row.envelope ?? row, p = e.payload ?? {};
 if (e.type === 'observation') {
  const o = p.observation ?? p, at = o.position, time = o.observedAtEpochMs, dimension = o.world?.dimension;
  const isDead = o.status === 'PLAYER_DEAD' || o.player?.health <= 0;
  if (!Number.isFinite(time)) continue;
  if (windowStart !== null && time < windowStart || windowEnd !== null && time > windowEnd) { last = null; last10 = null; continue; }
  if (isDead && !dead) deaths++;
  if (isDead !== dead) { dead = isDead; last = null; last10 = null; }
  if (!at) continue;
  if (dimension === NETHER && !isDead) entry ??= { ...at, atMs: time };
  if (last?.dimension === NETHER && dimension === NETHER && time >= last.time) {
   const dt = time - last.time;
   netherMs += dt;
   const ticks = o.world?.gameTime;
   if (dt > 0 && Number.isFinite(ticks) && Number.isFinite(last.ticks) && ticks >= last.ticks) {
    tickSpan += ticks - last.ticks; tickWallMs += dt;
   }
   if (dt <= 5000) {
    const step = Math.hypot(at.x - last.at.x, at.z - last.at.z);
    if (step <= Math.max(2, dt / 1000 * 10)) pathBlocks += step; else excludedJumps++;
   } else gaps++;
  }
  if (dimension === NETHER && !isDead && entry) {
   maxFromEntry = Math.max(maxFromEntry, Math.hypot(at.x - entry.x, at.z - entry.z));
   if (!last10) last10 = { at, time };
   else if (time - last10.time >= 10000) {
    const step = Math.hypot(at.x - last10.at.x, at.z - last10.at.z);
    if (step < 200) path10Blocks += step;
    last10 = { at, time };
   }
   const structures = o.sighted?.structures ?? [];
   const fortress = structures.find(s => /fortress/i.test(s.structure ?? '') || (s.blocks ?? []).some(b => /(^|:)nether_brick/.test(b)));
   const bricks = [...(o.blocks ?? []), ...(o.landmarks ?? [])].find(b => /(^|:)nether_brick/.test(b.blockId ?? ''));
   if (!firstFortress && (fortress || bricks)) firstFortress = { netherMinutes: netherMs / 60000, wallMinutes: (time - entry.atMs) / 60000, wallFromGameStartMinutes: windowStart === null ? null : (time - windowStart) / 60000, at: { ...at }, seen: fortress ?? bricks };
  }
  if (dimension !== NETHER) last10 = null;
  last = { dimension, at, time, ticks: o.world?.gameTime };
 } else if (e.type === 'action_command' && p.actionType === 'travel_to' && last?.dimension === NETHER) calls.set(p.actionId, last.time);
 else if (e.type === 'action_result' && calls.has(p.actionId) && !results.has(p.actionId) && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(p.state)) {
  results.add(p.actionId); travelCalls++; activeMs += p.elapsedMs ?? 0; reasons[p.reasonCode] = (reasons[p.reasonCode] ?? 0) + 1;
  const gain = /covered (-?[\d.]+) blocks toward it/.exec(p.message ?? ''); if (gain) travelGain += Number(gain[1]);
 }
}
const minutes = netherMs / 60000;
const report = { protocol: file, playingWindow: { startedAt: windowStart, endedAt: windowEnd }, netherMinutes: minutes, pathBlocks, path10Blocks, blocksPerNetherMinute: minutes ? path10Blocks / minutes : null,
 sampledPathBlocksPerNetherMinute: minutes ? pathBlocks / minutes : null,
 maxFromEntry, maxDisplacementPerNetherMinute: minutes ? maxFromEntry / minutes : null, firstFortress, deaths,
 travel: { calls: travelCalls, activeMinutes: activeMs / 60000, netGain: travelGain, netBlocksPerActiveMinute: activeMs ? travelGain / (activeMs / 60000) : null, reasons },
 serverTickRate: tickWallMs ? tickSpan / (tickWallMs / 1000) : null,
 sampling: { displacementCadenceSeconds: 10, gapsOver5s: gaps, excludedJumps } };
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ netherMinutes: minutes, blocksPerNetherMinute: report.blocksPerNetherMinute, firstFortressMinutes: firstFortress?.netherMinutes ?? null, deaths, travelNetBlocksPerActiveMinute: report.travel.netBlocksPerActiveMinute }));
