#!/usr/bin/env node
// Provider-free build_shelter checks on uneven ground (OPUS-PLAN E6): wall or sill cells over a lower step, a two-block
// step, a slope and a deep pit beside a seen solid block. Usage under fix-slot.sh: ARENA_JAR=... node <this> OUT_DIR
import { mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { boot } from './watch-replay.mjs';
const out=resolve(process.argv[2]), jar=resolve(process.env.ARENA_JAR), template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
const hash=createHash('sha256');for await(const chunk of createReadStream(jar))hash.update(chunk);
await mkdir(out,{recursive:true});
const results={kind:'provider-free build_shelter on uneven ground; no combat claim',jarSha256:hash.digest('hex'),cases:[]};
// Each case carves air at [dx,y,dz] offsets around a 1x1 interior at (x,101,0) on a stone floor whose top is y=100.
const cases=[
 {id:'step1-east',opening:'north',roof:true,air:[[1,100,0]]},
 {id:'step1-two-walls-and-sill',opening:'south',roof:true,air:[[1,100,0],[-1,100,0],[0,100,1]]},
 {id:'step2-east',opening:'north',roof:true,air:[[1,100,0],[1,99,0]]},
 {id:'slope-east-sill',opening:'east',roof:true,air:[[1,100,-1],[1,100,0],[1,100,1],[2,100,-1],[2,100,0],[2,100,1],[2,99,-1],[2,99,0],[2,99,1]]},
 {id:'pit-beside-pillar',opening:'north',roof:false,air:[[1,100,0],[1,99,0],[1,98,0],[1,97,0]],stone:[[2,101,0]]},
 {id:'flat-control',opening:'west',roof:true,air:[]},
];
let s;
try {
 s=await boot(out,{jar,template,port:Number(process.env.SLOT_PORT_BASE),seed:20261009});
 await s.command('gamerule minecraft:spawn_mobs false');
 await s.command('difficulty normal');
 await s.command('forceload add -16 -16 48 16');
 await s.command('fill -8 95 -8 40 100 8 minecraft:stone');
 await s.command('fill -8 101 -8 40 108 8 minecraft:air');
 const registered=s.inbox.wait('agent_registered');await s.command('codex summon gpt-6.1-sol low Probe');
 const e=await registered;s.record={...(e.payload.record??e.payload),agentId:e.agentId};
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const started=s.inbox.wait('goal_control',g=>g.payload.operation==='start');await s.command('codex start Probe Survive for 1200 seconds.');
 s.record.goalRevision=(await started).payload.goalRevision;
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 await s.command('gamemode survival Probe');
 for(let i=0;i<cases.length;i++){
  const c=cases[i],x=i*6;
  for(const [dx,y,dz] of c.air)await s.command(`setblock ${x+dx} ${y} ${dz} minecraft:air`);
  for(const [dx,y,dz] of c.stone??[])await s.command(`setblock ${x+dx} ${y} ${dz} minecraft:stone`);
  await s.command(`tp Probe ${x+0.5} 101 0.5 0 30`);
  await s.command('clear Probe');
  await s.command('give Probe minecraft:cobblestone 48');
  await s.command('give Probe minecraft:iron_pickaxe');
  // Let perception see the carved cells the way a player glances around before building.
  for(const yaw of [0,90,180,270])await s.act('look_at',{x:x+0.5-Math.sin(yaw*Math.PI/180)*3,y:99,z:0.5+Math.cos(yaw*Math.PI/180)*3}).catch(()=>null);
  const before=await s.observe();
  const result=await s.act('build_shelter',{x,y:101,z:0,opening:c.opening,itemId:'minecraft:cobblestone',roof:c.roof,timeoutMs:60000});
  const o=await s.observe();
  // Operator check of the finished enclosure (walls on 3 sides at y 101-102, sill, roof if asked).
  const [ox,oz]={north:[0,-1],east:[1,0],south:[0,1],west:[-1,0]}[c.opening];
  const cells=[];
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
   if(dx===ox&&dz===oz){cells.push([x+dx,101,dz]);continue;}
   cells.push([x+dx,101,dz],[x+dx,102,dz]);
  }
  if(c.roof)cells.push([x,103,0]);
  let solid=0;
  for(const [bx,by,bz] of cells)if(/test passed/i.test(await s.command(`execute if block ${bx} ${by} ${bz} minecraft:cobblestone`))||/test passed/i.test(await s.command(`execute unless block ${bx} ${by} ${bz} #minecraft:replaceable`)))solid++;
  const row={id:c.id,opening:c.opening,roof:c.roof,result,enclosure:`${solid}/${cells.length}`,enclosed:solid===cells.length,startPosition:before.position,position:o.position,health:o.health};
  results.cases.push(row);
  await writeFile(join(out,'shelter-terrain.json'),JSON.stringify(results,null,2));
  console.log(c.id,result.state,result.reasonCode,row.enclosure,String(result.message).slice(0,240));
 }
} finally {await s?.stop().catch(()=>{});await writeFile(join(out,'shelter-terrain.json'),JSON.stringify(results,null,2));}
if(results.cases.length!==cases.length||results.cases.some(c=>c.result.state!=='SUCCEEDED'||!c.enclosed))process.exitCode=1;
