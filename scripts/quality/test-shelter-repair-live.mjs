#!/usr/bin/env node
// Held-out body contracts: repair, visible firing choices, and an obstruction appearing DURING a draw.
// Operator mutations below are fixture setup only; none are fed to the body as hidden knowledge.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { boot } from './watch-replay.mjs';
const out=resolve(process.argv[2]); await mkdir(out,{recursive:true});
const report={kind:'provider-free held-out mechanics',cases:[]};
let s;
const check=(ok,message)=>{ if(!ok) throw new Error(message); };
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try {
 s=await boot(out,{jar:process.env.ARENA_JAR,template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:Number(process.env.SLOT_PORT_BASE),seed:20261009});
 await s.command('gamerule minecraft:spawn_mobs false');
 await s.command('forceload add -32 -32 64 32');
 await s.command('fill -20 100 -20 60 100 20 minecraft:stone');
 await s.command('fill -20 101 -20 60 107 20 minecraft:air');
 const registered=s.inbox.wait('agent_registered'); await s.command('codex summon gpt-6.1-sol low Probe');
 const e=await registered; s.record={...(e.payload.record??e.payload),agentId:e.agentId};
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const started=s.inbox.wait('goal_control',g=>g.payload.operation==='start');
 await s.command('codex start Probe Survive for 1200 seconds.'); s.record.goalRevision=(await started).payload.goalRevision;
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 await s.command('gamemode survival Probe');
 await s.command('tp Probe 0.5 101 0.5 -90 0');
 await s.command('item replace entity Probe hotbar.0 with minecraft:cobblestone 64');
 await s.command('item replace entity Probe hotbar.1 with minecraft:iron_pickaxe');
 await s.command('item replace entity Probe hotbar.2 with minecraft:bow');
 await s.command('item replace entity Probe inventory.0 with minecraft:arrow 64');
 await s.command('item replace entity Probe weapon.offhand with minecraft:shield');
 await s.observe();
 const args={x:0,y:101,z:0,opening:'east',roof:true,itemId:'minecraft:cobblestone',timeoutMs:30000};
 const build=await s.act('build_shelter',args); check(build.state==='SUCCEEDED','initial shelter: '+JSON.stringify(build));
 report.cases.push({name:'initial shelter',result:build});
 // Let the hidden support's short terrain memory expire. Repair must inspect the ceiling underside.
 await delay(11000);
 const intact=await s.act('build_shelter',args); report.cases.push({name:'intact shelter after terrain memory expires',result:intact});
 check(intact.state==='SUCCEEDED'&&intact.message.includes('placed=0'),'intact repair: '+JSON.stringify(intact));
 await s.command('setblock -1 103 0 minecraft:air');
 const missingCap=await s.act('build_shelter',args); report.cases.push({name:'hidden scaffold removed, roof intact',result:missingCap});
 check(missingCap.state==='SUCCEEDED'&&missingCap.message.includes('placed=0'),'hidden cap repaired unnecessarily: '+JSON.stringify(missingCap));
 await s.act('select_item',{itemId:'minecraft:iron_pickaxe'});
 const exit=await s.act('break_block',{x:1,y:101,z:0,expectedBlockId:'minecraft:cobblestone',timeoutMs:15000});
 check(exit.state==='SUCCEEDED','cannot open exit');
 await s.act('look_at',{x:3.5,y:101.5,z:0.5});
 await s.command('summon minecraft:item 3.5 101 0.5 {Item:{id:"minecraft:blaze_rod",count:3},PickupDelay:0s}');
 let o=await s.observe(); const rod=o.entities?.find(e=>e.itemId==='minecraft:blaze_rod'); check(rod,'fixture rod not visible');
 const pickup=await s.act('pick_up_item',{targetSelector:rod.uuid});
 const returned=await s.act('build_shelter',args); o=await s.observe();
 report.cases.push({name:'witnessed three-rod collection and reentry',pickup,result:returned,position:o.position,inventory:o.inventory,player:o.player});
 check(pickup.state==='SUCCEEDED'&&returned.state==='SUCCEEDED','pickup/reentry failed');
 check((o.inventory.items??[]).some(i=>i.itemId==='minecraft:blaze_rod'&&i.count===3),'three rods not retained');
 check(returned.message.includes('placed=1'),'repair should replace only exit sill: '+returned.message);
 // Both a blocked and an open target are in the current view. The refusal must report the latter,
 // keep the model's chosen UUID, and consume no ammunition.
 await s.command('summon minecraft:blaze 6.5 101 0.5 {Tags:["open"],NoAI:1b,NoGravity:1b}');
 await s.command('summon minecraft:blaze 6.5 101 3.5 {Tags:["blocked"],NoAI:1b,NoGravity:1b}');
 await s.act('look_at',{x:6.5,y:102,z:1.5});
 o=await s.observe(); let targets=o.entities.filter(e=>e.type==='minecraft:blaze'&&e.perceivedBy!=='sound');
 const open=targets.find(e=>Math.abs(e.position.z-0.5)<0.1), blocked=targets.find(e=>e.position.z>3);
 // A glass wall preserves sight but blocks arrows at a named coordinate.
 await s.command('fill 3 101 1 3 104 4 minecraft:glass');
 await s.act('select_item',{itemId:'minecraft:bow'});
 if(blocked&&open) {
  const refusalStartedAt=Date.now();
  const refused=await s.act('use_ranged',{targetId:blocked.uuid,drawDurationMs:1000,trackTarget:true,timeoutMs:10000});
  report.cases.push({name:'blocked shot reports visible alternatives without retargeting',result:refused,wallMs:Date.now()-refusalStartedAt,openId:open.uuid,blockedId:blocked.uuid});
  check(refused.reasonCode==='TARGET_OBSTRUCTED'&&refused.message.includes('minecraft:glass')&&refused.message.includes(open.uuid),'blocked shot missing block or alternative: '+JSON.stringify(refused));
  check(refused.elapsedMs<=150&&Date.now()-refusalStartedAt<=200,'blocked shot did not return within two ticks plus transport');
 } else throw new Error('both fixture targets must be visually acquired: '+JSON.stringify(targets));
 // Remove the obstruction and place a new one after the transaction has begun drawing.
 await s.command('fill 3 101 1 3 104 4 minecraft:air');
 const shot=s.act('use_ranged',{targetId:open.uuid,drawDurationMs:1000,trackTarget:true,timeoutMs:10000});
 await delay(350); const blockAt=Date.now(); await s.command('setblock 1 102 0 minecraft:glass');
 const dynamic=await shot;
 report.cases.push({name:'new obstruction during draw',result:dynamic,returnAfterBlockMs:Date.now()-blockAt});
 check(dynamic.reasonCode==='TARGET_OBSTRUCTED'&&dynamic.message.includes('1,102,0'),'dynamic obstruction missing: '+JSON.stringify(dynamic));
 check(Date.now()-blockAt<=200,'dynamic obstruction did not return within two ticks plus transport');
 await s.command('setblock 1 102 0 minecraft:chest');
 const protectedWindow=await s.act('build_shelter',args);
 report.cases.push({name:'precise block entity obstruction',result:protectedWindow});
 check(protectedWindow.reasonCode==='SHELTER_BLOCKED'&&protectedWindow.message.includes('minecraft:chest')&&protectedWindow.message.includes('1, 102, 0'),'repair did not name protected obstruction');
 await s.command('setblock 1 102 0 minecraft:air');
 await s.command('kill @e[type=minecraft:blaze]');
 await s.command('fill 2 98 -1 10 100 1 minecraft:air');
 await s.command('summon minecraft:blaze 6.5 99 0.5 {NoAI:1b,NoGravity:1b}');
 await s.act('look_at',{x:6.5,y:100.7,z:0.5});
 o=await s.observe(); const low=o.entities.find(e=>e.type==='minecraft:blaze'&&e.perceivedBy!=='sound');
 check(low,'lower target upper body is not visible through the eye-height slot');
 const throughSlot=await s.act('use_ranged',{targetId:low.uuid,drawDurationMs:1000,trackTarget:true,timeoutMs:10000});
 report.cases.push({name:'same lower target through eye-height slot over intact sill',result:throughSlot});
 check(throughSlot.state==='SUCCEEDED'&&throughSlot.message.includes('struck the target'),'upper-body arrow did not hit through the slot: '+JSON.stringify(throughSlot));
 report.passed=true;
} catch(error) {report.error=String(error.stack??error);process.exitCode=1;}
finally {await s?.stop().catch(()=>{});await writeFile(join(out,'repair.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
