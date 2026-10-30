#!/usr/bin/env node
// A scripted model stand-in, never a production routine. Truth samples measure outcomes only.
// Both arms use the v2 End world's kit and terrain, all crystals removed, and start beside the fountain
// to isolate the fight after crystal clearing. No commands change the world once the clock starts.
import {createReadStream} from 'node:fs';
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeReflexEntries} from '../../coordinator/src/reflexes.mjs';
import {boot} from './watch-replay.mjs';
import {applyQualitySetup,activateQualitySetup} from '../../coordinator/src/benchmark/quality-scenarios.mjs';
const REFLEX_RULES = [{id:'cloud',priority:8,when:{type:'cloud_near',within:4},do:{type:'sprint_away',blocks:10},ttlS:3600,maxS:3},{id:'ball',priority:8,when:{type:'fireball_incoming',withinS:2},do:{type:'sprint_away',blocks:10},ttlS:3600,maxS:3},{id:'fall',priority:9,when:{type:'falling',blocks:4},do:{type:'place',item:'minecraft:water_bucket',where:'below'},ttlS:3600,maxS:3},{id:'gaze',kind:'stance',priority:9,when:{type:'enderman_gaze'},do:{type:'look_away'},ttlS:3600},{id:'angry-shield',kind:'stance',priority:8,when:{type:'enderman_provoked',within:4},do:{type:'shield'},ttlS:3600}];
normalizeReflexEntries(REFLEX_RULES);
const [checkpoint,out,jar,seconds='360',targetMode='head']=process.argv.slice(2);
if(!out||!jar||!process.env.SLOT_PORT_BASE||!process.env.JAVA_HOME||!process.env.ARENA_HEADLESS_SERVER_TEMPLATE)throw Error('CHECKPOINT OUT JAR [SECONDS] [head|root], under slot.sh live');
await mkdir(out,{recursive:true});if((await readdir(out)).length)throw Error('Use a fresh output directory');const bytes=await readFile(checkpoint),cp=JSON.parse(bytes),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const number=t=>Number(String(t).match(/(-?\d+(?:\.\d+)?)[fdb]?\s*$/)?.[1]);
const jarHash=createHash('sha256');for await(const chunk of createReadStream(jar))jarHash.update(chunk);
const result={standinSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),checkpoint:basename(checkpoint),checkpointSha256:createHash('sha256').update(bytes).digest('hex'),jarSha256:jarHash.digest('hex'),targetMode,modelCalls:0,startOverride:JSON.parse(process.env.DRAGON_PROBE_START??'[12.5,64,0.5]'),actions:[],track:[]};let s,clock,poll,dead=false;
async function act(type,args){const t=Date.now();const r=await s.act(type,args);result.actions.push({s:clock?(t-clock)/1000:null,type,args,state:r.state,code:r.reasonCode,message:r.message});await writeFile(resolve(out,'result.json'),JSON.stringify(result,null,2));return r;}
try{
 // Desktop initial chunk saves can hold authentication past 30 s; this is before the fight clock.
 s=await boot(resolve(out),{jar:resolve(jar),template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:Number(process.env.SLOT_PORT_BASE),seed:cp.seed,spawnMonsters:true,readyTimeoutMs:180000});
 await s.bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Model-free stand-in',reasoningEfforts:['low'],serviceTiers:['default']}]});
 s.bridge.on('goal_control',e=>{if(e.payload.operation==='dead')dead=true;});
 const registered=s.inbox.wait('agent_registered');
 for(let retry=0;retry<10;retry++){result.summon=await s.command('execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low Probe');if(!result.summon.includes('MODEL_CATALOG_UNAVAILABLE'))break;await sleep(200);}
 console.log(result.summon);const e=await registered;s.record={...(e.payload.record??e.payload),agentId:e.agentId};
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});const started=s.inbox.wait('goal_control',g=>g.payload.operation==='start');await s.command('codex start Probe Survive for 1200 seconds.');s.record.goalRevision=(await started).payload.goalRevision;await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const command=async text=>({text:await s.command(text)});const receipt=await applyQualitySetup({...cp.setup,randomSalt:380038},command,'Probe');await activateQualitySetup(receipt,command,{stage:'goal-start'});await activateQualitySetup(receipt,command,{stage:'first-decision'});await s.command('tick unfreeze');await sleep(3000);
 await s.command('execute in minecraft:the_end run kill @e[type=minecraft:end_crystal]');await sleep(1000);await s.command('execute in minecraft:the_end run kill @e[type=minecraft:area_effect_cloud]');
 await s.observe();await act('equip_item',{sourceSlot:2,targetSlot:'offhand',expectedItemId:'minecraft:shield'});
 await s.setReflexes(REFLEX_RULES);
 await s.command(`execute in minecraft:the_end run tp Probe ${result.startOverride.join(' ')} 0 45`);
 result.initialHealth=number(await s.command('data get entity Probe Health'));if(dead||result.initialHealth<19.99)throw Error('Fixture body was hurt before the measured fight');
 await s.observe();clock=Date.now();let busy=false;
 const sample=async()=>{if(busy)return;busy=true;try{const health=number(await s.command('execute in minecraft:the_end run data get entity @e[type=minecraft:ender_dragon,limit=1] Health'));const phase=number(await s.command('execute in minecraft:the_end run data get entity @e[type=minecraft:ender_dragon,limit=1] DragonPhase'));result.track.push({s:(Date.now()-clock)/1000,hp:health,phase,health:number(await s.command('data get entity Probe Health')),pos:s.observation?.position});}finally{busy=false}};await sample();poll=setInterval(()=>sample().catch(()=>{}),1000);
 while(!dead&&Date.now()-clock<Number(seconds)*1000){const o=await s.observe();if(o.player.health<=0||o.status==='DEAD')break;
  const items=o.inventory?.items??[];if(o.player.foodLevel<=17){await act('select_item',{itemId:'minecraft:cooked_beef'});await act('use_item',{durationMs:1800});continue;}
  result.lastSeen={at:(Date.now()-clock)/1000,entities:o.entities?.filter(x=>x.type==='minecraft:ender_dragon')};
  const angry=o.entities?.find(x=>x.type==='minecraft:enderman'&&x.targetingAgent&&x.distance<=8&&x.uuid);
  if(angry){await act('fight_target',{targetId:angry.uuid,pursue:true,shield:true,timeoutMs:12000});continue;}
  const root=o.entities?.find(x=>x.type==='minecraft:ender_dragon'&&!x.partName);const head=o.entities?.find(x=>x.type==='minecraft:ender_dragon'&&x.partName==='head');
  if(root?.appearance?.motion==='perched'&&head){await act('fight_target',{targetId:targetMode==='root'?root.uuid:head.uuid,pursue:true,shield:true,fleeAtHealth:8,timeoutMs:12000});}
  else if(Math.hypot(o.position.x,o.position.z)>17){await act('move_to',{x:result.startOverride[0],y:result.startOverride[1],z:result.startOverride[2],sprint:true,tolerance:2});}
  else {await act('look_at',{x:0,y:68,z:0});await act('wait',{durationMs:1000});}
 }
 clearInterval(poll);await sample();const first=result.track.find(x=>Number.isFinite(x.hp)),last=result.track.filter(x=>Number.isFinite(x.hp)).at(-1);result.elapsedS=(Date.now()-clock)/1000;result.hpLost=first.hp-last.hp;result.hpPerMinute=result.hpLost/(result.elapsedS/60);result.bestHp=Math.min(...result.track.map(x=>x.hp).filter(Number.isFinite));result.deaths=Math.max(Number(dead),number(await s.command('scoreboard players get Probe deaths'))||0,Number(result.track.at(-1)?.health===0));result.killed=result.bestHp<=0;console.log(JSON.stringify({hpPerMinute:result.hpPerMinute,deaths:result.deaths,bestHp:result.bestHp,elapsedS:result.elapsedS}));
}catch(e){result.error=e.stack;process.exitCode=1;console.error(e);}finally{clearInterval(poll);await writeFile(resolve(out,'result.json'),JSON.stringify(result,null,2));await s?.stop();}
