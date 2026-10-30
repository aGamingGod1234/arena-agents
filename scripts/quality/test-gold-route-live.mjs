#!/usr/bin/env node
// Test-only model-free controller, never exposed as a player routine. All decisions
// consume production player observations. /locate and vanilla stats are result-only.
// CHECKPOINT OUT JAR [seconds=600] [salt=1], under slot.sh live.
import { readFile, writeFile, mkdir, appendFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { boot } from './watch-replay.mjs';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { validateAction } from '../../coordinator/src/schema.mjs';
const [cpFile,outArg,jarArg,secondsArg='600',saltArg='1']=process.argv.slice(2);
const out=path.resolve(outArg),jar=path.resolve(jarArg),seconds=Number(secondsArg);
if(!process.env.SLOT_PORT_BASE||!process.env.ARENA_HEADLESS_SERVER_TEMPLATE)throw Error('Use a live slot and server template');
await mkdir(out,{recursive:true});if((await readdir(out)).length)throw Error('Output must be fresh');
const cp=JSON.parse(await readFile(cpFile,'utf8')),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const result={seed:cp.seed,checkpoint:path.basename(cpFile),providerCalls:0,secondsRequested:seconds,salt:Number(saltArg),
 controllerSha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),jarSha256:createHash('sha256').update(await readFile(jar)).digest('hex'),actions:{},mined:{},refusals:{}};
let s,facts,dead=false,started=0,active=false,cycle=0;
const cells=new Map(),visits=new Map(),blocked=new Map(),oresSeen=new Set(),openedDoors=new Set();
const key=b=>`${b.x},${b.y},${b.z}`;
const source=b=>/^minecraft:(nether_gold_ore|gold_block)$/.test(b.blockId);
const ground=b=>/^minecraft:(netherrack|blackstone|basalt|smooth_basalt|polished_basalt|soul_sand|soul_soil|warped_nylium|crimson_nylium|cobblestone|polished_blackstone_bricks|cracked_polished_blackstone_bricks)$/.test(b.blockId);
const save=()=>writeFile(path.join(out,'result.json'),JSON.stringify({...result,minutes:started?(Date.now()-started)/60000:0,dead,oresSeen:oresSeen.size},null,2));
async function observe(){
 const sent=Date.now();const wait=s.inbox.wait('observation',e=>e.agentId===s.record.agentId&&(e.payload.observedAtEpochMs??0)>=sent-50,15000);
 await s.bridge.send('request_observation',s.record.agentId,{goalRevision:s.record.goalRevision});
 const raw=(await wait).payload;s.observation=raw;
 if(!raw.ready){if(raw.status==='PLAYER_DEAD')dead=true;return facts;}
 facts=adaptObservation(raw);
 for(const b of [...(facts.blocks??[]),...(facts.landmarks??[])]){
  if(![b.x,b.y,b.z].every(Number.isFinite))continue;
  cells.set(key(b),{...b,seenAt:Date.now()});if(source(b))oresSeen.add(key(b));
 }
 return facts;
}
async function act(type,args){
 validateAction({type,...args});result.actions[type]=(result.actions[type]??0)+1;
 const at=Date.now(),r=await s.act(type,args);
 await appendFile(path.join(out,'actions.jsonl'),JSON.stringify({seconds:started?(at-started)/1000:0,type,args,state:r.state,reason:r.reasonCode,message:r.message,ms:Date.now()-at})+'\n');
 if(r.state!=='SUCCEEDED')result.refusals[r.reasonCode]=(result.refusals[r.reasonCode]??0)+1;
 return r;
}
async function select(itemId){
 const row=facts.inventory.items.find(i=>i.itemId===itemId);if(!row)return false;
 if(row.slot>8)await act('select_tool',{sourceSlot:row.slot,hotbarSlot:8,expectedItemId:itemId,minRemainingDurability:0});
 await act('select_item',{itemId});return true;
}
function guarded(){
 return facts.entities.some(e=>/^minecraft:piglin(_brute)?$/.test(e.type)&&e.distance<=20)||
  (facts.player?.heard??[]).some(e=>/^entity\.piglin(_brute)?\./.test(e.sound??'')&&e.distance<=20&&(e.secondsAgo??0)<=5);
}
async function scan(){
 const p=facts.player;
 for(let i=0;i<6&&!dead;i++){
  const a=(i+cycle%6)*Math.PI/3;
  await act('look_at',{x:p.x+20*Math.cos(a),y:p.y+1,z:p.z+20*Math.sin(a)});
  await sleep(150);await observe();
 }
}
async function openDoor(){
 const p=facts.player;
 const door=[...cells.values()].find(b=>b.blockId==='minecraft:oak_door'&&!openedDoors.has(`${b.x},${b.z}`)&&
  Math.hypot(b.x+.5-p.x,b.y+.5-(p.y+1.62),b.z+.5-p.z)<4.5);
 if(!door)return false;
 const r=await act('set_door',{x:door.x,y:door.y,z:door.z,open:true});
 if(r.state==='SUCCEEDED'){
  openedDoors.add(`${door.x},${door.z}`);
  // Exploration goal is relative to the visible door and this body's position, never a world scan.
  const dx=door.x+.5-p.x,dz=door.z+.5-p.z;
  const x=door.x+.5+(Math.abs(dx)>=Math.abs(dz)?Math.sign(dx)*8:0);
  const z=door.z+.5+(Math.abs(dz)>Math.abs(dx)?Math.sign(dz)*8:0);
  await observe();
  await act('travel_to',{x,z,tolerance:1,build:true,minHealth:12,timeoutMs:20000});
 }
 await observe();return r.state==='SUCCEEDED';
}
async function mine(){
 if(guarded())return false;
 const p=facts.player;
 const ores=[...cells.values()].filter(b=>source(b)&&(blocked.get(key(b))??0)<Date.now())
  .map(b=>({...b,d:Math.hypot(b.x+.5-p.x,b.y+.5-(p.y+1.62),b.z+.5-p.z)}))
  .filter(b=>b.d<=4.6&&!(Math.floor(p.x)===b.x&&Math.floor(p.z)===b.z&&b.y<p.y))
  .sort((a,b)=>Number(b.blockId==='minecraft:gold_block')-Number(a.blockId==='minecraft:gold_block')||a.d-b.d);
 if(!ores.length)return false;
 const b=ores[0];await select('minecraft:iron_pickaxe');await observe();
 if(dead||guarded())return false;
 const r=await act('break_block',{x:b.x,y:b.y,z:b.z,expectedBlockId:b.blockId,timeoutMs:6000});
 if(r.state==='SUCCEEDED'){result.mined[b.blockId]=(result.mined[b.blockId]??0)+1;cells.delete(key(b));}
 else blocked.set(key(b),Date.now()+45000);
 await observe();return true;
}
async function move(){
 const p=facts.player;
 const sources=[...cells.values()].filter(b=>source(b)&&(blocked.get(key(b))??0)<Date.now()&&Date.now()-b.seenAt<180000);
 const target=sources.map(b=>({...b,d:Math.hypot(b.x+.5-p.x,b.y+.5-p.y,b.z+.5-p.z)}))
  .filter(b=>b.d<32).sort((a,b)=>a.d-b.d)[0];
 if(target&&!guarded()){
  await select('minecraft:iron_pickaxe');await observe();
  const dy=target.y-p.y;
  const r=Math.abs(dy)>3
   ?await act('dig_to',{x:target.x,z:target.z,y:target.y+(dy<0?1:-1),pattern:dy<0?'stairs_down':'stairs_up',maxBlocks:48,timeoutMs:30000})
   :await act('travel_to',{x:target.x+.5,z:target.z+.5,y:target.y+1,tolerance:3,build:true,minHealth:12,timeoutMs:20000});
  if(r.state!=='SUCCEEDED')blocked.set(key(target),Date.now()+45000);
  await observe();return true;
 }
 const candidates=[...cells.values()].filter(b=>ground(b)&&Date.now()-b.seenAt<20000&&
   Math.abs(b.y+1-p.y)<=3.1&&Math.hypot(b.x+.5-p.x,b.z+.5-p.z)>=2.5&&Math.hypot(b.x+.5-p.x,b.z+.5-p.z)<=16)
  .map(b=>{
   const target={x:b.x+.5,y:b.y+1,z:b.z+.5};const v=visits.get(key(b))??0;
   const nearest=Math.min(30,...sources.map(o=>Math.hypot(o.x+.5-target.x,o.y+.5-(target.y+1.62),o.z+.5-target.z)));
   return {b,target,score:nearest+v*6+Math.abs(b.y+1-p.y)*3};
  }).sort((a,b)=>a.score-b.score);
 const c=candidates[0];if(!c)return false;
 visits.set(key(c.b),(visits.get(key(c.b))??0)+1);
 const r=await act('navigate_to',{...c.target,tolerance:.6,sprint:false,timeoutMs:5000});
 if(r.state!=='SUCCEEDED')visits.set(key(c.b),(visits.get(key(c.b))??0)+5);
 await observe();return true;
}
try{
 s=await boot(out,{jar,template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:Number(process.env.SLOT_PORT_BASE),world:null,seed:cp.seed,spawnMonsters:true,goalTicks:100000});
 const registered=s.inbox.wait('agent_registered',()=>true,45000);
 let summon;
 for(let n=0;n<20;n++){
  summon=await s.command('execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low Probe');
  if(!summon.includes('MODEL_CATALOG_UNAVAILABLE'))break;
  await s.bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Model-free gold route',reasoningEfforts:['low'],serviceTiers:['default']}]});await sleep(100);
 }
 if(!summon.includes('Creating')){registered.catch(()=>{});throw Error('Summon refused');}
 const e=await registered;s.record={...(e.payload.record??e.payload),agentId:e.agentId};
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const start=s.inbox.wait('goal_control',e=>e.payload.operation==='start');await s.command('codex start Probe Survive for 5000 seconds.');
 s.record.goalRevision=(await start).payload.goalRevision;await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 s.bridge.on('observation',e=>{if(active&&e.agentId===s.record.agentId&&e.payload.status==='PLAYER_DEAD')dead=true;});
 const receipt=await applyQualitySetup({...cp.setup,randomSalt:Number(saltArg)},async text=>({text:await s.command(text)}),'Probe');
 await activateQualitySetup(receipt,async text=>({text:await s.command(text)}),{stage:'goal-start'});
 await activateQualitySetup(receipt,async text=>({text:await s.command(text)}),{stage:'first-decision'});
 await s.command('tick unfreeze');await s.command('difficulty normal');await observe();
 const sh=facts.inventory.items.find(i=>i.itemId==='minecraft:shield');if(sh)await act('equip_item',{sourceSlot:sh.slot,targetSlot:'offhand',expectedItemId:sh.itemId});
 // The camp door is player-visible preparation. It is opened by the body, not operator commands.
 const door=facts.blocks.find(b=>b.blockId==='minecraft:oak_door');
 if(door)await act('set_door',{x:door.x,y:door.y,z:door.z,open:true});
 started=Date.now();active=true;result.start={...facts.player};result.startedAt=new Date(started).toISOString();await save();
 while(!dead&&Date.now()-started<seconds*1000){
  await observe();if(dead)break;
  const threat=facts.entities.find(e=>e.targetingAgent&&e.distance<12);
  if(threat){
   await select('minecraft:iron_sword');await observe();
   if(facts.player.health<12)await act('flee_from',{targetId:threat.stableId,distance:12,timeoutMs:5000});
   else await act('fight_target',{targetId:threat.stableId,pursue:false,shield:true,fleeAtHealth:10,timeoutMs:10000});
   continue;
  }
  if(facts.player.foodLevel<18&&await select('minecraft:cooked_beef')){await act('use_item',{durationMs:1800,expectedItemId:'minecraft:cooked_beef'});await observe();}
  const drop=facts.items.find(e=>/^minecraft:(gold_nugget|gold_ingot|gold_block)$/.test(e.itemId)&&e.distance<8);
  if(drop){await act('pick_up_item',{targetSelector:drop.stableId});continue;}
  if(await mine()){await save();continue;}
  await scan();if(dead)break;
  if(await openDoor())continue;
  if(await mine()){await save();continue;}
  if(!await move())await sleep(400);
  cycle++;await save();
 }
 result.endInventory=facts?.inventory?.items;result.endPosition=facts?.player;result.elapsedSeconds=(Date.now()-started)/1000;
 result.completedWindow=result.elapsedSeconds>=seconds||dead;
 // Result-only commands after scoring; never consumed by policy functions above.
 result.locate=await s.command(`execute in minecraft:the_nether positioned ${cp.setup.position.join(' ')} run locate structure minecraft:bastion_remnant`);
 await s.command('save-all flush');
}catch(error){result.error=String(error.stack??error);}
finally{active=false;await s?.stop().catch(()=>{});}
// Vanilla earned pickups and mining counters, independent of controller action counts.
for(const f of await readdir(path.join(out,'server/world/players/stats')).catch(()=>[])){
 const stats=JSON.parse(await readFile(path.join(out,'server/world/players/stats',f),'utf8')).stats??{};
 result.stats=stats;const pickup=stats['minecraft:picked_up']??{};
 result.ingotsGained=(pickup['minecraft:gold_ingot']??0)+(pickup['minecraft:gold_nugget']??0)/9+(pickup['minecraft:gold_block']??0)*9;
}
await save();console.log(JSON.stringify({seed:result.seed,minutes:result.elapsedSeconds/60,ingotsGained:result.ingotsGained,mined:result.mined,error:result.error,dead}));
process.exitCode=result.error?1:0;
