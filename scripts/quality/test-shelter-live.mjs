#!/usr/bin/env node
// Provider-free construction checks on an open platform, separate from the real-spawner acceptance bar.
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { boot } from './watch-replay.mjs';
const out=resolve(process.argv[2]), jar=resolve(process.env.ARENA_JAR), template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
const hash=createHash('sha256');for await(const chunk of createReadStream(jar))hash.update(chunk);
await mkdir(out,{recursive:true});
const results={kind:'provider-free construction mechanics; no combat acceptance claim',jarSha256:hash.digest('hex'),cases:[]};
let s;
try {
 s=await boot(out,{jar,template,port:Number(process.env.SLOT_PORT_BASE),seed:20261009});
 await s.command('gamerule minecraft:spawn_mobs false');
 await s.command('difficulty normal');
 await s.command('forceload add -16 -16 32 32');
 await s.command('fill -8 100 -8 24 100 8 minecraft:stone');
 await s.command('fill -8 101 -8 24 106 8 minecraft:air');
 const cases=[['north','minecraft:cobblestone',true],['east','minecraft:nether_bricks',true],['south','minecraft:cobbled_deepslate',true],['west','minecraft:cobblestone',false]];
 for(let i=0;i<cases.length;i++){
  if(i===0){
  const registered=s.inbox.wait('agent_registered');await s.command('codex summon gpt-6.1-sol low Probe');
  const e=await registered;s.record={...(e.payload.record??e.payload),agentId:e.agentId};
  await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
  const started=s.inbox.wait('goal_control',g=>g.payload.operation==='start');await s.command('codex start Probe Survive for 1200 seconds.');
  s.record.goalRevision=(await started).payload.goalRevision;
  await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
  await s.command('gamemode survival Probe');
  }
  const [opening,itemId,roof]=cases[i],x=i*5;
  await s.command('kill @e[type=minecraft:blaze]');
  await s.command(`tp Probe ${x+0.5} 101 0.5 0 0`);
  await s.command('clear Probe');
  await s.command(`give Probe ${itemId} 48`);
  await s.command('give Probe minecraft:iron_pickaxe');
  if(i===1)await s.command(`setblock ${x} 102 -1 minecraft:nether_brick_fence`);
  await new Promise(r=>setTimeout(r,500));
  const before=await s.observe();
  const floor=await s.command(`execute if block ${x} 100 0 minecraft:stone run time query gametime`);
  if(!/time is/i.test(floor)||Math.hypot(before.position.x-x-0.5,before.position.y-101,before.position.z-0.5)>1.0)throw new Error('Invalid construction fixture setup '+JSON.stringify({floor,position:before.position}));
  let ignition;const timer=i===2?setTimeout(()=>{ignition=s.command(`setblock ${x} 101 0 minecraft:fire`);},800):null;
  const result=await s.act('build_shelter',{x,y:101,z:0,opening,itemId,roof,timeoutMs:60000});
  if(timer)clearTimeout(timer);await ignition;
  let o=await s.observe();
  const row={opening,itemId,roof,result,startPosition:before.position,position:o.position};
  if(result.state==='SUCCEEDED'){
   const [dx,dz]={north:[0,-1],east:[1,0],south:[0,1],west:[-1,0]}[opening];
   await s.command(`give Probe minecraft:iron_sword`);
   await s.command(`summon minecraft:blaze ${x+0.5+dx*2} 102 ${0.5+dz*2} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`);
   await s.act('look_at',{x:x+0.5+dx*2,y:102.9,z:0.5+dz*2});
   o=await s.observe();
   const blaze=o.entities?.find(e=>e.type==='minecraft:blaze'&&e.alive!==false);
   row.fight=blaze?await s.act('fight_target',{targetId:blaze.uuid,pursue:false,timeoutMs:8000}):{state:'ERROR',reasonCode:'FIXTURE_BLAZE_NOT_SEEN'};
   await s.command('kill @e[type=minecraft:item]');
   o=await s.observe();
   row.rodsBeforeDiagnosticDrops=(o.inventory?.items??[]).filter(i=>i.itemId==='minecraft:blaze_rod').reduce((n,i)=>n+i.count,0);
   // Diagnostic drops only: this checks vanilla pickup inside and on the sill, not natural-loot yield.
   await s.command(`summon minecraft:item ${x+0.5} 101.2 0.5 {Item:{id:"minecraft:blaze_rod",count:1},PickupDelay:0s}`);
   await s.command(`summon minecraft:item ${x+0.5+dx*0.8} 102.2 ${0.5+dz*0.8} {Item:{id:"minecraft:blaze_rod",count:1},PickupDelay:0s}`);
   await s.act('wait',{durationMs:1000});o=await s.observe();
   row.rodsAfterDiagnosticDrops=(o.inventory?.items??[]).filter(i=>i.itemId==='minecraft:blaze_rod').reduce((n,i)=>n+i.count,0);
  }
  results.cases.push(row);
  await writeFile(join(out,'shelter.json'),JSON.stringify(results,null,2));
  console.log(opening,roof,result.state,result.reasonCode,result.message);
 }
} finally {await s?.stop().catch(()=>{});await writeFile(join(out,'shelter.json'),JSON.stringify(results,null,2));}
if(results.cases.length!==4||results.cases.some(c=>c.result.state!=='SUCCEEDED'||c.fight?.state!=='SUCCEEDED'||c.rodsAfterDiagnosticDrops-c.rodsBeforeDiagnosticDrops<2))process.exitCode=1;
