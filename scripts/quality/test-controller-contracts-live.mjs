// Provider-free controller contracts against the actual installed mod jar.
// Run on Desktop with the same RAM/CPU guard as winrunner; no model or provider is invoked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { boot, uuidOf } from './watch-replay.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const moduleRoot = process.env.ARENA_CONTRACT_MODULE_ROOT ?? fileURLToPath(new URL('../../coordinator/src/', import.meta.url));
const [{ ReflexBook, normalizeReflexEntries }, { coveringRule }, { noteCombatDispatch, settleCombatResult }] = await Promise.all(
 ['reflexes.mjs', 'danger-contexts.mjs', 'dragon-fight-facts.mjs'].map(name => import(pathToFileURL(resolve(moduleRoot, name)).href)));


const out = resolve(process.argv[2]);
const jar = resolve(process.argv[3]);
const only = new Set((process.env.CONTROLLER_ONLY ?? '').split(',').filter(Boolean));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = {};
const hash = createHash('sha256');
for await (const chunk of createReadStream(jar)) hash.update(chunk);
await mkdir(out, { recursive: true });
await writeFile(join(out, 'manifest.json'), JSON.stringify({ jar, sha256: hash.digest('hex'), kind: 'real Fabric server, provider-free', startedAt: new Date().toISOString() }, null, 2));
let s;
const frame = patch => ({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: 0, pitch: 10, selectedSlot: 0, hand: 'main', ticks: 20, instantLook: true, ...patch });
const shield = { id: 'guard', kind: 'stance', when: { type: 'hostile_near', mobs: ['husk'], within: 12 }, do: { type: 'shield' }, maxS: 20 };
const numeric = text => Number((/(-?\d+(?:\.\d+)?)[fdb]?\s*$/.exec(String(text).trim()) ?? [])[1]);
async function check(name, run) {
 if (only.size && !only.has(name)) return;
 try { results[name] = { pass: true, ...await run() }; }
 catch (e) { results[name] = { ...(results[name] ?? {}), pass: false, error: String(e.stack ?? e) }; }
 await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
 console.log(name, JSON.stringify(results[name]));
}
async function sampleUntil(predicate, ms = 8000) {
 const deadline = Date.now() + ms;
 while (Date.now() < deadline) { const o = await s.observe(); if (predicate(o)) return o; await sleep(100); }
 throw new Error('observation condition timed out');
}
async function reset() {
 await s.setReflexes([]);
 // Vanilla keeps a dying mob's body for twenty ticks; move old fixture targets out of the next shot/attack lane.
 await s.command('tp @e[tag=d38target] 200 81 200');
 await s.command('kill @e[type=!minecraft:player]');
 await s.command('fill -24 79 -24 24 80 48 minecraft:stone');
 await s.command('fill -24 81 -24 24 88 48 minecraft:air');
 await s.command('tp Probe 0.5 81 0.5 0 10');
 await s.command('clear Probe');
 await s.command('effect clear Probe');
 await s.command('effect give Probe minecraft:resistance 120 4 true');
 await s.command('effect give Probe minecraft:saturation 120 10 true');
 await sleep(500);
 return s.observe();
}
async function target(type = 'husk', z = 2.5, x = 0.5) {
 await s.command(`summon minecraft:${type} ${x} 81 ${z} {NoAI:1b,PersistenceRequired:1b,Silent:1b,Tags:["d38target"]}`);
 const uuid = uuidOf(await s.command('data get entity @e[tag=d38target,limit=1] UUID'));
 assert.ok(uuid, 'fixture target exists');
 await sampleUntil(o => (o.entities ?? []).some(e => e.uuid === uuid || e.stableId === uuid));
 return uuid;
}
async function raise() {
 await s.setReflexes([shield]);
 return sampleUntil(o => o.reflexes?.firing?.id === 'guard');
}
async function yieldHands() {
 s.revision++;
 await s.bridge.send('reflex_update', s.record.agentId, { revision: s.revision, rules: normalizeReflexEntries([shield]), yield: true });
}
async function arrowLaunched() {
 for (let i = 0; i < 80; i++) {
  if (uuidOf(await s.command('data get entity @e[type=minecraft:arrow,limit=1] UUID'))) return;
  await sleep(25);
 }
 throw new Error('bow never loosed an arrow');
}
async function bowSetup(type = 'husk', z = 35.5) {
 await reset();
 await s.command('item replace entity Probe weapon.mainhand with minecraft:bow');
 await s.command('give Probe minecraft:arrow 64');
 return target(type, z);
}
try {
 s = await boot(out, { jar, template: process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port: Number(process.env.SLOT_PORT_BASE), seed: 20261025 });
 // boot's catalog is provider-free; explicitly match the player's required default service tier.
 await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Controller contract fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] });
 await s.command('gamerule minecraft:spawn_mobs false');
 await s.command('forceload add -32 -32 32 80');
 await s.command('time set noon');
 const registration = s.inbox.wait('agent_registered');
 await s.command('execute positioned 0.5 100 0.5 run codex summon gpt-6.1-sol low Probe');
 const e = await registration; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
 s.bridge.on('message', event => {
  const control = event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null;
  if (event.agentId === s.record.agentId && Number.isSafeInteger(control?.goalRevision) && control.goalRevision > s.record.goalRevision) {
   s.record.goalRevision = control.goalRevision;
   s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
  }
 });
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
 await s.command('codex start Probe Survive for 1200 seconds.');
 s.record.goalRevision = (await started).payload.goalRevision;
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 await s.command('gamemode survival Probe');
 await sleep(500);

 await check('shieldHands', async () => {
  const trials = [];
  results.shieldHands = { trials };
  for (const sequence of [false, true]) {
   await reset(); const targetId = await target();
   await s.command('item replace entity Probe weapon.mainhand with minecraft:iron_sword');
   await s.command('item replace entity Probe weapon.offhand with minecraft:shield');
   await raise();
   await sampleUntil(o => o.interaction?.rayTarget?.uuid === targetId);
   await yieldHands();
   const attack = frame({ attack: true, ticks: 16 });
   const r = sequence ? await s.act('control_sequence', { frames: [frame({ forward: 0.05, ticks: 3 }), attack], maxTicks: 100 }) : await s.act('control', attack);
   const hp = numeric(await s.command('data get entity @e[tag=d38target,limit=1] Health'));
   const delivered = !Number.isFinite(hp) || hp < 20;
   trials.push({ type: sequence ? 'sequence' : 'control', targetId, result: r, targetHealth: hp });
   assert.ok(delivered || r.state !== 'SUCCEEDED', 'attack either physically damages or reports interruption');
   assert.ok(delivered, 'shield yields to the authored attack');
  }
  await reset(); await target();
  await s.command('item replace entity Probe weapon.mainhand with minecraft:snowball 8');
  await s.command('item replace entity Probe weapon.offhand with minecraft:shield');
  await raise(); await yieldHands();
  const r = await s.act('control', frame({ use: true, ticks: 8 }));
  const count = numeric(await s.command('data get entity Probe SelectedItem.count'));
  assert.ok(count < 8 || r.state !== 'SUCCEEDED', 'use consumes a snowball or reports interruption');
  assert.ok(count < 8, 'main-hand use physically happens');
  return { trials, use: { count, result: r } };
 });

 await check('shieldAnalog', async () => {
  const trials = [];
  for (const [forward, yaw] of [[0.05, 90], [0.15, 90], [0.15, 45]]) {
   await reset(); await target();
   await s.command('item replace entity Probe weapon.offhand with minecraft:shield');
   const before = await raise();
   const r = await s.act('control', frame({ forward, yaw, ticks: 40 }));
   const after = await s.observe();
   const dx = after.position.x - before.position.x, dz = after.position.z - before.position.z;
   assert.equal(r.state, 'SUCCEEDED');
   const radians = yaw * Math.PI / 180;
   assert.ok(dx < -0.015 && Math.abs(dx * Math.cos(radians) + dz * Math.sin(radians)) < Math.hypot(dx, dz) * 0.15, 'fractional motion preserves its requested world direction');
   assert.equal(after.reflexes?.firing?.id, 'guard', 'movement continues under the raised shield');
   trials.push({ forward, yaw, dx, dz, distance: Math.hypot(dx, dz) });
  }
  const ratio = trials[1].distance / trials[0].distance;
  assert.ok(ratio > 2.4 && ratio < 3.6, '0.15 moves three times as far as 0.05');
  results.shieldAnalog = { trials, ratio };
  assert.ok(Math.abs(trials[2].distance / trials[1].distance - 1) < 0.1, 'turning the shield 45 degrees preserves physical movement magnitude');
  return { trials, ratio };
 });

 await check('expiry', async () => {
  const trials = [];
  for (const kind of ['ttl', 'maxFirings', 'until']) {
   await reset(); await target();
   await s.command('item replace entity Probe weapon.mainhand with minecraft:iron_sword');
   const rule = kind === 'ttl' ? { id: 'exp', when: { type: 'on_fire' }, do: { type: 'stop' }, ttlS: 1 }
    : kind === 'maxFirings' ? { id: 'exp', when: { type: 'hostile_near', within: 10 }, do: { type: 'select', item: 'minecraft:iron_sword' }, maxFirings: 1 }
    : { id: 'exp', when: { type: 'on_fire' }, do: { type: 'stop' }, until: { type: 'hostile_near', within: 10 } };
   const book = new ReflexBook(); book.apply(s.record.agentId, normalizeReflexEntries([rule]));
   // Use the same monotonically increasing revision as the other fixtures.
   while (book.payload(s.record.agentId).revision <= s.revision) book.apply(s.record.agentId, []), book.apply(s.record.agentId, normalizeReflexEntries([rule]));
   let p = book.payload(s.record.agentId); s.revision = p.revision;
   await s.bridge.send('reflex_update', s.record.agentId, p);
   const expired = await sampleUntil(o => o.reflexes?.revision === p.revision && !o.reflexes.rules.some(x => x.id === 'exp') && (o.reflexes.events ?? []).some(x => x.id === 'exp' && x.outcome === 'expired'), 9000);
   results.expiry = { kind, payload: p, serverStatus: expired.reflexes };
   book.observe(s.record.agentId, expired.reflexes);
   assert.equal(book.has(s.record.agentId), false);
   assert.equal(coveringRule({ kind: 'melee', mobs: ['husk'] }, book.rules(s.record.agentId)), null);
   const report = book.takeReport(s.record.agentId); assert.match(report, /expired: exp/);
   book.apply(s.record.agentId, normalizeReflexEntries([{ id: 'unrelated', when: { type: 'on_fire' }, do: { type: 'stop' } }]));
   p = book.payload(s.record.agentId); s.revision = p.revision;
   assert.deepEqual(p.rules.map(x => x.id), ['unrelated']);
   await s.bridge.send('reflex_update', s.record.agentId, p);
   const after = await sampleUntil(o => o.reflexes?.revision === p.revision);
   assert.ok(!after.reflexes.rules.some(x => x.id === 'exp'));
   trials.push({ kind, report, events: expired.reflexes.events });
  }
  return { trials };
 });

 await check('crystalOwnership', async () => {
  const targetId = await bowSetup('end_crystal', 35.5);
  const action = s.act('use_ranged', { targetId, drawDurationMs: 1100, timeoutMs: 6000 });
  await arrowLaunched();
  await s.command('kill @e[tag=d38target]');
  const r = await action;
  const memory = {}; noteCombatDispatch(memory, r.actionId, 'use_ranged', { targetId }); settleCombatResult(memory, r);
  assert.ok(!memory.brokenTargets?.has(targetId), 'external destruction earns zero own-hit credit');
  const ownTarget = await bowSetup('end_crystal', 12.5);
  const own = await s.act('use_ranged', { targetId: ownTarget, drawDurationMs: 1100, timeoutMs: 6000 });
  noteCombatDispatch(memory, own.actionId, 'use_ranged', { targetId: ownTarget }); settleCombatResult(memory, own);
  assert.ok(memory.brokenTargets?.has(ownTarget), 'a real arrow collision and destruction earns own-hit credit');
  return { external: r, own };
 });

 await check('arrowFeedback', async () => {
  const targetId = await bowSetup();
  const action = s.act('use_ranged', { targetId, drawDurationMs: 1100, timeoutMs: 6000, aimX: 5.5, aimY: 100, aimZ: 35.5 });
  await arrowLaunched();
  await s.command('damage @e[tag=d38target,limit=1] 1 minecraft:generic');
  const unrelated = await action;
  assert.doesNotMatch(unrelated.message, /it struck|flashed hurt/, 'unrelated hurt is not this arrow hitting');
  const hiddenId = await bowSetup();
  const flight = s.act('use_ranged', { targetId: hiddenId, drawDurationMs: 1100, timeoutMs: 6000, aimX: 0.5, aimY: 100, aimZ: 60 });
  await arrowLaunched();
  await s.command('tick freeze');
  await s.command('fill -4 81 1 4 110 1 minecraft:stone');
  await s.command('tick unfreeze');
  const hidden = await flight;
  results.arrowFeedback = { unrelated, hidden };
  assert.match(hidden.message, /lost sight.*not confirmed/, 'watch ends when visibility is lost');
  assert.doesNotMatch(hidden.message, /closest|above the|below the|stuck in|flashed hurt|it struck/, 'no precise hidden flight feedback');
  return { unrelated, hidden };
 });

 await check('swimDetour', async () => {
  await reset();
  await s.command('fill -7 79 -2 6 85 5 minecraft:stone');
  const cells = [];
  for (let x = 0; x >= -3; x--) cells.push([x, 0]);
  for (let z = 1; z <= 3; z++) cells.push([-3, z]);
  for (let x = -2; x <= 3; x++) cells.push([x, 3]);
  for (let z = 2; z >= 0; z--) cells.push([3, z]);
  for (const [x, z] of cells) await s.command(`fill ${x} 81 ${z} ${x} 83 ${z} minecraft:water`);
  await s.command('fill 3 84 0 3 86 0 minecraft:air');
  // Acquire the complete tunnel through ordinary visible observations before exercising the guard.
  await s.command('effect give Probe minecraft:water_breathing 60 0 true');
  for (const [x, z] of cells.filter((_, i) => i % 3 === 0).concat([[3, 0]])) {
   for (const yaw of [0, 90, 180, -90]) {
    await s.command(`tp Probe ${x + 0.5} 81 ${z + 0.5} ${yaw} -30`); await sleep(100); await s.observe();
   }
  }
  await s.command('tp Probe 0.5 81 0.5 90 -10'); await sleep(200);
  await s.command('effect clear Probe minecraft:water_breathing');
  const starting = await s.observe();
  await s.setReflexes([{ id: 'air', priority: 9, when: { type: 'air_below', bubbles: 10 }, do: { type: 'swim_up' }, maxS: 20 }]);
  const track = []; const deadline = Date.now() + 24000;
  while (Date.now() < deadline) {
   const o = await s.observe(); track.push({ pos: o.position, air: o.player?.air, firing: o.reflexes?.firing, events: o.reflexes?.events });
   if ((o.reflexes?.events ?? []).some(e => e.id === 'air' && ['done', 'failed', 'timeout'].includes(e.outcome))) break;
   await sleep(150);
  }
  results.swimDetour = { starting: { position: starting.position, player: starting.player }, track };
  const events = track.flatMap(x => x.events ?? []);
  assert.ok(!events.some(e => /no progress swimming/.test(e.detail ?? '')), 'a reachable acquired detour is not mistaken for a stall');
  assert.ok(events.some(e => e.id === 'air' && e.outcome === 'done' && /surfaced/.test(e.detail)), 'the swimmer follows the detour to breathable air');
  return { track, starting: { position: starting.position, breathable: starting.player?.breathable } };
 });
} finally { await s?.stop(); }
assert.ok(Object.values(results).every(r => r.pass), 'all selected shipping-jar contracts must pass');
