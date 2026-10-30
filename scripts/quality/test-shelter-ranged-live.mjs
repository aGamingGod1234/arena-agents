#!/usr/bin/env node
// Isolated bow/shield and snowball mechanics, separate from natural-spawner yield and model decision scores.
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { boot } from './watch-replay.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';
const out = resolve(process.argv[2]), jar = resolve(process.env.ARENA_JAR);
const hash = createHash('sha256'); for await (const chunk of createReadStream(jar)) hash.update(chunk);
await mkdir(out, { recursive: true });
const results = { kind: 'provider-free isolated ranged mechanics; fixture health is evaluator-only', jarSha256: hash.digest('hex'), cases: [] };
let s, rules = [];
const act = async (type, args) => {
 await s.bridge.send('reflex_update', s.record.agentId, { revision: s.revision, rules: normalizeReflexEntries(rules), yield: true });
 return s.act(type, args);
};
const health = async () => {
 const t = await s.command('data get entity @e[type=minecraft:blaze,tag=d38_ranged,limit=1] Health');
 return /(-?[\d.]+)f?\s*$/.exec(t.trim())?.[1] * 1 || 0;
};
try {
 s = await boot(out, { jar, template: process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port: Number(process.env.SLOT_PORT_BASE), seed: 20261009 });
 await s.command('gamerule minecraft:spawn_mobs false');
 await s.command('forceload add -32 -32 96 32');
 await s.command('fill -24 100 -24 80 100 24 minecraft:stone');
 await s.command('fill -24 101 -24 80 106 24 minecraft:air');
 const registered = s.inbox.wait('agent_registered'); await s.command('codex summon gpt-6.1-sol low Probe');
 const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start'); await s.command('codex start Probe Survive for 1200 seconds.');
 s.record.goalRevision = (await started).payload.goalRevision;
 await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
 await s.command('gamemode survival Probe');
 const cases = [['north',6,0,true,'bow'], ['east',10,1,true,'bow'], ['south',14,2,true,'bow'], ['west',6,0,false,'bow'], ['east',6,0,true,'snowball'], ['east',6,0,false,'bow','south']];
 for (let i=0; i<cases.length; i++) {
  rules = []; await s.setReflexes(rules);
  await s.command('kill @e[type=minecraft:blaze]'); await s.command('kill @e[type=minecraft:item]');
  await s.command('kill @e[type=minecraft:arrow]');
  const [opening, range, rise, roof, weapon, sideWindow] = cases[i], x=i*12;
  await s.command(`tp Probe ${x+0.5} 101 0.5 0 0`); await s.command('clear Probe');
  await s.command('item replace entity Probe hotbar.0 with minecraft:cobblestone 48');
  await s.command('item replace entity Probe hotbar.1 with minecraft:iron_pickaxe');
  await s.command(`item replace entity Probe hotbar.2 with minecraft:${weapon} ${weapon==='bow'?1:16}`);
  await s.command('item replace entity Probe inventory.0 with minecraft:arrow 64');
  await s.command('item replace entity Probe weapon.offhand with minecraft:shield');
  await s.observe();
  const row = { opening, range, rise, roof, weapon, shots: [] };
  row.build = await act('build_shelter', { x, y:101, z:0, opening, roof, itemId:'minecraft:cobblestone', timeoutMs:60000 });
  if (row.build.state==='SUCCEEDED') {
   const [dx,dz]={north:[0,-1],east:[1,0],south:[0,1],west:[-1,0]}[sideWindow ?? opening];
   if (sideWindow) {
    await act('select_item',{itemId:'minecraft:iron_pickaxe'});
    row.sideWindow={ direction:sideWindow, result:await act('break_block',{x:x+dx,y:102,z:dz,expectedBlockId:'minecraft:cobblestone',timeoutMs:15000}) };
   }
   await s.command(`summon minecraft:blaze ${x+0.5+dx*range} ${101+rise} ${0.5+dz*range} {Tags:["d38_ranged"],NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`);
   await act('look_at', {x:x+0.5+dx*range,y:102+rise,z:0.5+dz*range});
   let o=await s.observe(); const target=o.entities?.find(e=>e.type==='minecraft:blaze'&&e.perceivedBy!=='sound');
   rules=[{id:'guard',kind:'stance',priority:6,when:{type:'hostile_near',within:24,mobs:['minecraft:blaze']},do:{type:'shield'},ttlS:600},{id:'shot',kind:'trigger',priority:9,when:{type:'incoming_projectile',withinS:1},do:{type:'shield'},ttlS:600}];
   o=await s.setReflexes(rules);
   await act('wait', {durationMs:1000}); o=await s.observe();
   row.armedReflexes=o.reflexes; row.guardReady=o.reflexes?.firing?.id==='guard';
   await act('select_item', {itemId:`minecraft:${weapon}`});
   row.initialHealth=await health();
   if(target) for(let shot=0;shot<(weapon==='bow'?4:7);shot++) {
    const before=await health(); if(before<=0) break;
    const result=weapon==='bow'
     ? await act('use_ranged',{targetId:target.uuid,drawDurationMs:1000,trackTarget:true,timeoutMs:10000})
     : await act('use_item',{durationMs:50,mode:'once',expectedItemId:'minecraft:snowball',aimX:target.position.x,aimY:target.position.y+0.9,aimZ:target.position.z});
    await act('wait',{durationMs:600});
    row.shots.push({result,before,after:await health()});
   }
   row.finalHealth=await health(); row.finalInventory=(await s.observe()).inventory;
  }
  results.cases.push(row); await writeFile(join(out,'ranged.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(row));
 }
} finally { await s?.stop().catch(()=>{}); await writeFile(join(out,'ranged.json'),JSON.stringify(results,null,2)); }
if(results.cases.length!==6||results.cases.some(c=>c.build.state!=='SUCCEEDED'||c.sideWindow&&c.sideWindow.result.state!=='SUCCEEDED'||!c.guardReady||c.finalHealth!==0||!c.shots.length||c.shots.some(s=>s.result.state!=='SUCCEEDED'))) process.exitCode=1;
