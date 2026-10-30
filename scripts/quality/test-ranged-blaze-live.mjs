#!/usr/bin/env node
// d41 ranged bar (bars/d41-ranged-1.json): use_ranged against natural AI blazes, 0 model calls.
// Setup W: blaze on a 3x3 platform 3 above the feet, ~10 out, seen through build_shelter's 1x2 window.
// Setup O: blaze on open ground 15 out. Each trial: fresh blaze, up to CALLS use_ranged calls with the deck-c6 model
// arguments, the deck-c6-1 model reflex set armed, stop at kill. Hits are blaze health drops, not the bow's message.
// MODE=volley (d41 ranged-loop): ONE use_ranged untilDead:true collect:true call per trial instead (bar: kill within 20 s
// in >= 4/5 per setup; a dropped rod is picked up when reachable). Setup H (volley only): a NoAI blaze in the open, a
// stone wall raised between after WALL_MS; the volley must stop about 3 s after the wall.
// MODE=fight: one fight_target collect:true call with a diamond sword at a NoAI blaze on the open floor (setup F);
// a dropped rod must be picked up.
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { boot } from './watch-replay.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';
const out = resolve(process.argv[2]), jar = resolve(process.env.ARENA_JAR);
const TRIALS = Number(process.env.TRIALS ?? 5), CALLS = Number(process.env.CALLS ?? 6), GAP_MS = Number(process.env.GAP_MS ?? 1500);
const SETUPS = (process.env.SETUPS ?? 'W,O').split(',');
const MODE = process.env.MODE ?? 'single', WALL_MS = Number(process.env.WALL_MS ?? 1500);
const hash = createHash('sha256'); for await (const chunk of createReadStream(jar)) hash.update(chunk);
await mkdir(out, { recursive: true });
const results = { kind: 'provider-free use_ranged vs AI blazes', mode: MODE, jar, jarSha256: hash.digest('hex'), trials: [] };
// deck-c6-1 model rules (protocol reflex_update revision 1), lava rules dropped (no lava here).
const RULES = [
 { id: 'blaze_shield', kind: 'stance', priority: 7, when: [{ type: 'hostile_near', within: 24, mobs: ['minecraft:blaze'] }], do: { type: 'shield' }, ttlS: 1200, wake: true },
 { id: 'incoming_shield', kind: 'trigger', priority: 8, when: [{ type: 'incoming_projectile', withinS: 2 }], do: { type: 'shield' }, ttlS: 1200, wake: true },
 { id: 'fire_escape', kind: 'trigger', priority: 8, when: [{ type: 'in_fire' }], do: { type: 'leave_fire' }, wake: true, ttlS: 3600 },
 { id: 'burn_escape', kind: 'trigger', priority: 8, when: [{ type: 'on_fire' }], do: { type: 'leave_fire' }, wake: true, ttlS: 3600 },
];
let s, armed = [];
// As native-tool-runtime: a direct command first yields any firing reflex (same rules, yield:true).
const act = async (type, args) => {
 if (armed.length) await s.bridge.send('reflex_update', s.record.agentId, { revision: s.revision, rules: normalizeReflexEntries(armed), yield: true });
 return s.act(type, args);
};
const health = async () => {
 const t = await s.command('data get entity @e[type=minecraft:blaze,tag=r4,limit=1] Health');
 const m = /(-?[\d.]+)f?\s*$/.exec(t.trim()); return m ? Number(m[1]) : 0;
};
const save = () => writeFile(join(out, 'ranged-blaze.json'), JSON.stringify(results, null, 1));
// S: deck c6-4 replayed (agent 75.5,70,92.5; spawner 84,73,92; blaze still at 85.3,73,93.09 beside it), shifted so the
// agent stands at 30.5,101,0.5. NoAI keeps the exact geometry that put 3/3 arrows into the spawner face.
const SITES = { W: { x: 0, blaze: [10.5, 104, 0.5], shelter: true }, O: { x: 60, blaze: [75.5, 101, 0.5], shelter: false },
 S: { x: 30, blaze: [40.3, 104, 1.09], shelter: false, noAI: true },
 F: { x: 85, blaze: [90.5, 101, 0.5], shelter: false, noAI: true },
 H: { x: 85, blaze: [97.5, 101, 0.5], shelter: false, noAI: true, wall: 'fill 91 101 -3 91 106 3 minecraft:stone' } };
const rods = async () => { const t = await s.command('clear Probe minecraft:blaze_rod 0'); const m = /(\d+)/.exec(t ?? ''); return m ? Number(m[1]) : 0; };
try {
 s = await boot(out, { jar, template: process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port: Number(process.env.SLOT_PORT_BASE), seed: 20261028 });
 await s.command('gamerule minecraft:spawn_mobs false'); await s.command('difficulty hard');
 await s.command('time set noon'); await s.command('gamerule minecraft:advance_time false');
 await s.command('forceload add -32 -32 112 32');
 await s.command('fill -24 100 -24 100 100 24 minecraft:stone');
 await s.command('fill -24 101 -24 100 112 24 minecraft:air');
 await s.command('fill 9 103 -1 11 103 1 minecraft:nether_bricks');
 await s.command('fill 39 103 -1 41 103 1 minecraft:nether_bricks'); await s.command('setblock 39 104 0 minecraft:spawner');
 const registered = s.inbox.wait('agent_registered'); await s.command('codex summon gpt-6.1-sol low Probe');
 const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start'); await s.command('codex start Probe Survive for 1200 seconds.');
 s.record.goalRevision = (await started).payload.goalRevision;
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 await s.command('gamemode survival Probe');
 if (process.env.DEBUG) s.bridge.on('action_progress', e => console.log('progress', JSON.stringify(e.payload).slice(0, 300)));
 for (const setup of SETUPS) {
  const site = SITES[setup];
  for (let trial = 0; trial < TRIALS; trial++) {
   armed = []; await s.setReflexes([]);
   for (const type of ['blaze', 'arrow', 'small_fireball', 'item']) await s.command(`kill @e[type=minecraft:${type}]`);
   await s.command(`fill ${site.x - 3} 101 -3 ${Math.min(site.x + 3, site.noAI && !site.wall ? 32 : site.x + 3)} 104 3 minecraft:air`);
   if (site.wall) await s.command(site.wall.replace('minecraft:stone', 'minecraft:air'));
   await s.command(`tp Probe ${site.x + 0.5} 101 0.5 -90 0`); await s.command('clear Probe');
   await s.command('effect clear Probe');
   for (const eff of ['resistance infinite 3', 'fire_resistance infinite 0', 'regeneration infinite 1', 'instant_health 1 4']) await s.command(`effect give Probe minecraft:${eff} true`);
   await s.command('item replace entity Probe hotbar.0 with minecraft:bow');
   await s.command('item replace entity Probe hotbar.1 with minecraft:cobblestone 64');
   await s.command('item replace entity Probe inventory.0 with minecraft:arrow 64');
   await s.command('item replace entity Probe weapon.offhand with minecraft:shield');
   for (const [slot, item] of [['head', 'iron_helmet'], ['chest', 'iron_chestplate'], ['legs', 'iron_leggings'], ['feet', 'iron_boots']]) await s.command(`item replace entity Probe armor.${slot} with minecraft:${item}`);
   await s.observe();
   const row = { setup, trial, calls: [] };
   if (site.shelter) {
    row.build = await s.act('build_shelter', { x: site.x, y: 101, z: 0, opening: 'east', roof: true, itemId: 'minecraft:cobblestone', timeoutMs: 60000 });
    row.build = { state: row.build.state, reasonCode: row.build.reasonCode, message: (row.build.message ?? '').slice(0, 300) };
    if (process.env.DEBUG) console.log('build', JSON.stringify(row.build));
   }
   // Bow in the selected hand on both jars (raw select_item of the held slot gave no result here).
   await s.command('item replace entity Probe weapon.mainhand with minecraft:bow');
   if (process.env.DEBUG) console.log('bow in hand');
   const [bx, by, bz] = site.blaze;
   await s.command(`summon minecraft:blaze ${bx} ${by} ${bz} {Tags:["r4"],PersistenceRequired:1b${site.noAI ? ',NoAI:1b' : ''}}`);
   await s.setReflexes(RULES); armed = RULES;
   await act('look_at', { x: bx, y: by + 1, z: bz });
   row.initialHealth = await health();
   if (MODE === 'fight') {
    await s.command('item replace entity Probe weapon.mainhand with minecraft:diamond_sword');
    const o = await s.observe(), target = (o.entities ?? []).find(x => x.type === 'minecraft:blaze');
    if (!target) row.lostTarget = true;
    else {
     const rodsBefore = await rods(), t0 = Date.now();
     const r = await act('fight_target', { targetId: target.uuid, timeoutMs: 20000, collect: true });
     row.volley = { state: r.state, reasonCode: r.reasonCode, message: (r.message ?? '').slice(0, 1500), ms: Date.now() - t0 };
     row.rodDropSeen = /blaze_rod/.test(r.message ?? '');
     row.rodsGained = (await rods()) - rodsBefore;
    }
    row.finalHealth = await health(); row.kill = row.finalHealth <= 0;
    results.trials.push(row); await save();
    console.log(JSON.stringify({ setup, trial, kill: row.kill, code: row.volley?.reasonCode, ms: row.volley?.ms, rodDropSeen: row.rodDropSeen, rodsGained: row.rodsGained, collect: /collect: (.{0,160})/.exec(row.volley?.message ?? '')?.[1] }));
    continue;
   }
   if (MODE === 'volley') {
    let target = null;
    for (let i = 0; i < 6 && !target; i++) {
     const o = await s.observe();
     target = (o.entities ?? []).find(x => x.type === 'minecraft:blaze' && x.perceivedBy !== 'sound');
     if (!target) await sleep(500);
    }
    if (!target) row.lostTarget = true;
    else {
     const rodsBefore = await rods(), t0 = Date.now();
     const pending = act('use_ranged', { targetId: target.uuid, drawDurationMs: 1000, untilDead: true, timeoutMs: 20000, collect: true });
     if (site.wall) { await sleep(WALL_MS); await s.command(site.wall); row.wallAtMs = Date.now() - t0; }
     const r = await pending;
     row.volley = { state: r.state, reasonCode: r.reasonCode, message: (r.message ?? '').slice(0, 1500), ms: Date.now() - t0 };
     if (site.wall) row.stopAfterWallMs = row.volley.ms - row.wallAtMs;
     row.arrows = Number((/(\d+) arrows? loosed/.exec(r.message ?? '') ?? [])[1] ?? 0);
     row.struck = Number((/(\d+) struck the target/.exec(r.message ?? '') ?? [])[1] ?? 0);
     row.rodDropSeen = /blaze_rod/.test(r.message ?? '');
     row.rodsGained = (await rods()) - rodsBefore;
    }
    row.finalHealth = await health(); row.kill = row.finalHealth <= 0;
    row.killIn20s = row.kill && row.volley?.reasonCode === 'TARGET_KILLED' && row.volley.ms <= 21000;
    results.trials.push(row); await save();
    console.log(JSON.stringify({ setup, trial, kill: row.kill, code: row.volley?.reasonCode, ms: row.volley?.ms, arrows: row.arrows, struck: row.struck, rodDropSeen: row.rodDropSeen, rodsGained: row.rodsGained, stopAfterWallMs: row.stopAfterWallMs }));
    continue;
   }
   for (let call = 0; call < CALLS; call++) {
    const before = await health(); if (before <= 0) break;
    let target = null;
    for (let i = 0; i < 6 && !target; i++) {
     const o = await s.observe();
     target = (o.entities ?? []).find(x => x.type === 'minecraft:blaze' && x.perceivedBy !== 'sound');
     if (!target) await sleep(500);
    }
    if (!target) { row.lostTarget = true; break; }
    const t0 = Date.now();
    const r = await act('use_ranged', { targetId: target.uuid, drawDurationMs: 1000, timeoutMs: 8000 });
    await sleep(600);
    const after = await health();
    row.calls.push({ state: r.state, reasonCode: r.reasonCode, message: (r.message ?? '').slice(0, 400), ms: Date.now() - t0,
     loosed: r.reasonCode === 'OWNED_PROJECTILE_CONFIRMED', before, after, hit: after < before });
    if (after <= 0) break;
    await sleep(GAP_MS);
   }
   row.finalHealth = await health(); row.kill = row.finalHealth <= 0;
   results.trials.push(row); await save();
   console.log(JSON.stringify({ setup, trial, kill: row.kill, calls: row.calls.map(c => `${c.reasonCode}${c.hit ? '+HIT' : ''}`) }));
  }
 }
} finally { await s?.stop().catch(() => {}); await save(); }
const sum = {};
for (const setup of SETUPS) {
 if (MODE === 'fight') {
  const rows = results.trials.filter(t => t.setup === setup);
  sum[setup] = { trials: rows.length, kills: rows.filter(t => t.kill).length, rodDropsSeen: rows.filter(t => t.rodDropSeen).length,
   rodsGained: rows.reduce((n, t) => n + Math.max(0, t.rodsGained ?? 0), 0), codes: rows.reduce((m, t) => (m[t.volley?.reasonCode] = (m[t.volley?.reasonCode] ?? 0) + 1, m), {}) };
  continue;
 }
 if (MODE === 'volley') {
  const rows = results.trials.filter(t => t.setup === setup);
  sum[setup] = { trials: rows.length, killsIn20s: rows.filter(t => t.killIn20s).length, kills: rows.filter(t => t.kill).length,
   arrows: rows.reduce((n, t) => n + (t.arrows ?? 0), 0), struck: rows.reduce((n, t) => n + (t.struck ?? 0), 0),
   rodDropsSeen: rows.filter(t => t.rodDropSeen).length, rodsGained: rows.reduce((n, t) => n + Math.max(0, t.rodsGained ?? 0), 0),
   codes: rows.reduce((m, t) => (m[t.volley?.reasonCode] = (m[t.volley?.reasonCode] ?? 0) + 1, m), {}),
   stopAfterWallMs: rows.map(t => t.stopAfterWallMs).filter(v => v !== undefined), msToEnd: rows.map(t => t.volley?.ms) };
  continue;
 }
 const rows = results.trials.filter(t => t.setup === setup), calls = rows.flatMap(t => t.calls), loosed = calls.filter(c => c.loosed);
 sum[setup] = { trials: rows.length, kills: rows.filter(t => t.kill).length, calls: calls.length, loosed: loosed.length, hits: loosed.filter(c => c.hit).length,
  codes: calls.reduce((m, c) => (m[c.reasonCode] = (m[c.reasonCode] ?? 0) + 1, m), {}) };
}
results.summary = sum; await save(); console.log(JSON.stringify(sum));
