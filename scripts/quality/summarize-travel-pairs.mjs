#!/usr/bin/env node
import path from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function summarizeCourses(entries) {
 const courses = entries.map(e => e.result), active = courses.filter(r => r.id !== 'gold2-seen');
 const sum = (rows, key) => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);
 const seconds = sum(active, 'wallSeconds'), blocks = sum(active, 'progressBlocks');
 const completeClock = active.length > 0 && active.every(r => Number.isFinite(r.gameTicks) && r.gameTicks >= 0);
 const gameTicks = completeClock ? sum(active, 'gameTicks') : null;
 const damage = courses.reduce((n, r) => n + Math.max(Number(r.damage) || 0, Number(r.damageLowerBound) || 0,
  Number(r.actionDamage) || (r.stops ?? []).reduce((total, stop) => total + Number(/^Took ([\d.]+) damage \(/.exec(stop.message ?? '')?.[1] ?? 0), 0)), 0);
 return { courses: courses.length, substantiveCourses: active.length, seconds, blocks, pace: seconds > 0 ? blocks / seconds * 60 : null,
  gameTicks, observedTPS: gameTicks !== null && seconds > 0 ? gameTicks / seconds : null,
  gamePace: gameTicks > 0 ? blocks / (gameTicks / 1200) : null,
  deaths: sum(courses, 'deaths'), fire: sum(courses, 'fireSamples'), lava: sum(courses, 'lavaSamples'), damage, sampledDamage: sum(courses, 'damage'),
  arrivals: courses.filter(r => r.arrived).length, actions: sum(courses, 'actions') };
}

export function compareCoursePair(base, candidate) {
 const ratio = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null;
 const wallRatio = ratio(candidate.pace, base.pace), gameRatio = ratio(candidate.gamePace, base.gamePace);
 return { wallRatio, gameRatio, orderFlipsAfterTPSAdjustment: wallRatio !== null && gameRatio !== null && (wallRatio - 1) * (gameRatio - 1) < 0 };
}

async function smallJson(file) {
 if ((await stat(file)).size > 1024 * 1024) throw Error('Unexpectedly large result metadata: ' + file);
 return JSON.parse((await readFile(file, 'utf8')).replace(/^\ufeff/, ''));
}

export async function summarizePairStudy(stateFile) {
 const study = await smallJson(stateFile), entries = [], pairs = [];
 for (const pair of study.pairs.filter(p => p.state === 'COMPLETE')) {
  const attempt = pair.attempts.find(a => a.index === pair.acceptedAttempt);
  if (!attempt || attempt.state !== 'COMPLETE') throw Error('Missing accepted pair attempt');
  const armEntries = {};
  for (const arm of ['base', 'candidate']) {
   const meta = attempt[arm], raw = await smallJson(path.join(meta.out, 'results.json'));
   if (raw.results.length !== 1 || raw.results[0].error || raw.results[0].id !== pair.courseId) throw Error('Mismatched paired result');
   raw.results[0].damageLowerBound = summarizeCourses([{ result: raw.results[0] }]).damage;
   const result = Object.fromEntries(Object.entries(raw.results[0]).filter(([key]) => key !== 'stops' && key !== 'path'));
   const entry = { pair: pair.pair, run: pair.run, arm, source: meta.out, jar: raw.jar, nativeExitCode: meta.exitCode, cleanupWarning: meta.cleanupWarning ?? null, host: meta.host ?? null, cpuCount: meta.cpuCount ?? null, cpuAffinityMask: meta.cpuAffinityMask ?? null, reusedBaseline: meta.reusedBaseline ?? false, hostCpu: meta.hostCpu, result };
   entries.push(entry); armEntries[arm] = entry;
  }
  pairs.push({ pair: pair.pair, run: pair.run, courseId: pair.courseId, attempts: pair.attempts.length, bootstrapFailures: attempt.bootstrapFailures ?? [], loadFlags: pair.loadFlags ?? [],
   ...compareCoursePair(summarizeCourses([armEntries.base]), summarizeCourses([armEntries.candidate])) });
 }
 const base = summarizeCourses(entries.filter(e => e.arm === 'base')), candidate = summarizeCourses(entries.filter(e => e.arm === 'candidate'));
 const runs = [1, 2].map(run => ({ run, base: summarizeCourses(entries.filter(e => e.arm === 'base' && e.run === run)),
  candidate: summarizeCourses(entries.filter(e => e.arm === 'candidate' && e.run === run)) }));
 const histogram = {};
 for (const e of entries.filter(e => e.arm === 'candidate' && e.result.id !== 'gold2-seen')) for (const [range, count] of Object.entries(e.result.acquiredSightHistogram ?? {})) histogram[range] = (histogram[range] ?? 0) + count;
 const sectors = Object.values(histogram).reduce((n, v) => n + v, 0), measuredSight = sectors ? Object.entries(histogram).reduce((n, [range, count]) => n + Number(range) * count, 0) / sectors : null;
 const unavailable = study.pairs.filter(p => p.state !== 'COMPLETE').map(p => ({ pair: p.pair, run: p.run, courseId: p.courseId, state: p.state, attempts: p.attempts.length }));
 return { runtimeHead: study.runtimeHead, protocol: study.protocol, method: 'Fresh world per course/arm, base then candidate, two rounds; matched CPU budgets within each pair, retained in arm metadata. Only complete matched attempts enter aggregates. Pace excludes initially-visible gold2-seen; safety counts include it. Game minutes are observed world.gameTime /1200. Host CPU is sampled during each physical course interval.',
  requestedPairs: study.pairs.length, acceptedPairs: pairs.length, unavailable, base, candidate, runs,
  hosts: [...new Set(entries.map(e => e.host))].map(host => ({ host, base: summarizeCourses(entries.filter(e => e.arm === 'base' && e.host === host)), candidate: summarizeCourses(entries.filter(e => e.arm === 'candidate' && e.host === host)) })),
  pairs, entries, measuredSight,
  roundedReplaySight: measuredSight === null ? null : Math.max(1, Math.min(64, Math.round(measuredSight))), histogram,
  comparison: compareCoursePair(base, candidate),
  bars: { completeTwoRounds: pairs.length === study.pairs.length && study.pairs.length === 14,
   candidate100WallBlocksPerMinuteBothRounds: runs.every(r => r.candidate.substantiveCourses === 6 && r.candidate.pace >= 100),
   candidate100GameBlocksPerMinuteBothRounds: runs.every(r => r.candidate.substantiveCourses === 6 && r.candidate.gamePace >= 100),
   noCandidateDeathsFireLava: candidate.deaths === 0 && candidate.fire === 0 && candidate.lava === 0,
   pairsWithLoadFlags: pairs.filter(p => p.loadFlags.length).length,
   pairsWhosePaceOrderFlipsAfterTPSAdjustment: pairs.filter(p => p.orderFlipsAfterTPSAdjustment).length } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
 const [stateFile, output] = process.argv.slice(2);
 if (!stateFile || !output) throw Error('Usage: summarize-travel-pairs.mjs STATE.json OUT.json');
 const result = await summarizePairStudy(stateFile);
 await writeFile(output, JSON.stringify(result, null, 2));
 console.log(JSON.stringify({ acceptedPairs: result.acceptedPairs, base: result.base, candidate: result.candidate, bars: result.bars }));
}
