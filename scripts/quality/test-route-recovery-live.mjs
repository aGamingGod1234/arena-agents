#!/usr/bin/env node
// Model-free death/retrace through production actions. Fixture commands construct terrain and cause death only.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { boot } from './watch-replay.mjs';
const out=resolve(process.argv[2]);
const only=process.argv[3];
const jar=resolve(process.env.RECOVERY_JAR ?? 'build/libs/arena-agents-0.2.0.jar');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port=Number(process.env.SLOT_PORT_BASE);
if(!template||!port||!process.env.JAVA_HOME) throw Error('Use slot.sh live with template and JAVA_HOME');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const OW='minecraft:overworld',N='minecraft:the_nether',E='minecraft:the_end',A='Probe';
const results=[];
let server;
process.on('SIGTERM',()=>{server?.child.kill('SIGTERM');process.exit(143);});
async function observe(s) {
 await s.bridge.send('request_observation',s.record.agentId,{goalRevision:s.record.goalRevision});
 await sleep(300);
 if(!s.observation?.ready) throw Error('No ready body observation');
 return s.observation;
}
async function act(s,type,args,wait=125000) {
 const id=`recover-${++s.ordinal}`;
 const next=s.inbox.wait('action_result',e=>e.payload.actionId===id&&['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(e.payload.state),wait);
 try {await s.bridge.send('action_command',s.record.agentId,{actionId:id,traceId:id,goalRevision:s.record.goalRevision,actionType:type,arguments:args,provenance:{provider:s.record.provider,model:s.record.model,reasoningEffort:s.record.reasoningEffort,serviceTier:s.record.serviceTier,traceId:id,programId:'route-recovery-fixture',programVersion:1,sourceStepId:id,eventSequence:s.observation?.eventSequence??0}});}catch(e){next.catch(()=>{});throw e;}
 const r=(await next).payload;
 await s.bridge.send('action_result_ack',s.record.agentId,{actionId:id,goalRevision:s.record.goalRevision});
 return r;
}
const control=(yaw,ticks,jump=false)=>({forward:1,strafe:0,jump,sneak:false,sprint:false,attack:false,use:false,yaw,pitch:25,selectedSlot:0,hand:'main',ticks,instantLook:true});
async function walk(s,x,y,z){const r=await act(s,'travel_to',{x,y,z,tolerance:1,build:false,timeoutMs:60000});if(r.state!=='SUCCEEDED')throw Error(`outbound: ${JSON.stringify(r)}`);return r;}
async function dim(s,target){for(let i=0;i<50;i++){const o=await observe(s);if(o.world.dimension===target)return o;await sleep(200);}throw Error(`no ${target}`);}
for(const scenario of (only==='ladder'?['ladder']:['cave','nether','end']).filter(x=>!only||x===only)) {
 const dir=join(out,scenario);await mkdir(dir,{recursive:true});
 const s=server=await boot(dir,{jar,template,port,seed:20261024});
 try {
  await s.command('difficulty peaceful');await s.command('time set 1000');
  await s.command('forceload add -16 -16 64 64');await sleep(1000);
  const y=['cave','ladder'].includes(scenario)?-30:100;
  if(scenario==='ladder') {
   await s.command('fill -3 -30 -3 4 -6 3 minecraft:air');
   await s.command('fill -3 -31 -3 4 -31 3 minecraft:stone');
   await s.command('fill -1 -30 -1 -1 -9 1 minecraft:stone');
   await s.command('fill 0 -30 0 0 -10 0 minecraft:ladder[facing=east]');
   await s.command('fill 1 -11 -2 4 -11 2 minecraft:stone');
  } else if(scenario==='cave') {
   await s.command('fill -3 -32 -3 29 -27 29 minecraft:stone');
   await s.command('fill -1 -30 -1 25 -28 1 minecraft:air');
   await s.command('fill 23 -30 -1 25 -28 25 minecraft:air');
  } else {
   await s.command('fill -3 99 -4 14 99 4 minecraft:stone');await s.command('fill -3 100 -4 14 105 4 minecraft:air');
   if(scenario==='nether') {
    await s.command('fill 8 99 -2 8 103 2 minecraft:obsidian');await s.command('fill 8 100 -1 8 102 1 minecraft:nether_portal[axis=z]');
   } else {await s.command('fill 7 99 -2 11 99 2 minecraft:end_portal_frame[eye=true]');await s.command('fill 8 99 -1 10 99 1 minecraft:end_portal');}
  }
  const spawnX=scenario==='ladder'?1.5:0.5;
  const registered=s.inbox.wait('agent_registered');await s.command(`execute positioned ${spawnX} ${y} 0.5 run codex summon gpt-6.1-sol low ${A}`);
  const e=await registered;s.record={...(e.payload.record??e.payload),agentId:e.agentId};
  s.bridge.on('goal_control',e=>{if(e.agentId===s.record.agentId&&Number.isSafeInteger(e.payload.goalRevision)){s.record.goalRevision=e.payload.goalRevision;s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false}).catch(()=>{});}});
  await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
  const started=s.inbox.wait('goal_control',e=>e.payload.operation==='start');await s.command(`codex start ${A} Survive for 1200 seconds.`);s.record.goalRevision=(await started).payload.goalRevision;
  await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
  await s.command(`spawnpoint ${A} ${Math.floor(spawnX)} ${y} 0`);
  for(let run=1;run<=Number(process.env.RECOVERY_REPS??3);run++) {
   const result={scenario,run,steps:[]};results.push(result);
   try {
    await s.command(`give ${A} minecraft:iron_pickaxe 1`);await s.command(`give ${A} minecraft:iron_sword 1`);await s.command(`give ${A} minecraft:cobblestone 16`);
    let destination={x:24.5,y,z:24.5},dimension=OW;
    if(scenario==='ladder') {
     result.steps.push(await act(s,'control',{...control(90,1),forward:0,pitch:0}));
     result.steps.push(await act(s,'navigate_to',{x:0.5,y,z:0.5,tolerance:0.2,sprint:false,timeoutMs:20000}));
     destination={x:2.5,y:-10,z:0.5};const climb=()=>act(s,'navigate_to',{...destination,tolerance:0.5,sprint:false,timeoutMs:60000});
     let climbed=await climb();result.steps.push(climbed);
     if(climbed.reasonCode==='REACHED_FRONTIER') {result.steps.push(await act(s,'control',{...control(-90,1),forward:0,pitch:25}));climbed=await climb();result.steps.push(climbed);}
     if(climbed.state!=='SUCCEEDED')throw Error(`ladder outbound: ${JSON.stringify(climbed)}`);
    }
    else if(scenario==='cave') {await walk(s,24.5,y,0.5);await walk(s,24.5,y,24.5);}
    else {
     await walk(s,6.5,y,0.5);await observe(s);
     if(scenario==='end') result.steps.push(await act(s,'control',control(-90,30,true)));
     else {
      result.steps.push(await act(s,'navigate_to',{x:8.5,y,z:0.5,tolerance:0.2,sprint:false,timeoutMs:30000}));
      result.steps.push(await act(s,'control',{...control(-90,100),forward:0}));
     }
     dimension=scenario==='end'?E:N;
     const arrival=await dim(s,dimension);result.arrival=arrival.position;
     const base={x:Math.floor(arrival.position.x),y:Math.floor(arrival.position.y),z:Math.floor(arrival.position.z)};
     if(scenario==='end') {
      await s.command(`execute in ${E} run fill 78 48 -4 108 48 25 minecraft:end_stone`);
      await s.command(`execute in ${E} run fill 78 49 -4 108 53 25 minecraft:air`);
      destination={x:84.5,y:49,z:20.5};await walk(s,84.5,49,0.5);await walk(s,84.5,49,20.5);
     } else {
      // Keep the arrival portal intact; clear a two-turn walking corridor away from its frame.
      await s.command(`execute in ${N} run fill ${base.x-3} ${base.y-1} ${base.z-3} ${base.x+27} ${base.y-1} ${base.z+27} minecraft:stone keep`);
      await s.command(`execute in ${N} run fill ${base.x+2} ${base.y} ${base.z-1} ${base.x+25} ${base.y+3} ${base.z+1} minecraft:air`);
      await s.command(`execute in ${N} run fill ${base.x+23} ${base.y} ${base.z-1} ${base.x+25} ${base.y+3} ${base.z+25} minecraft:air`);
      // Keep scattered death drops on one visible floor; this fixture measures retrace, not excavation for thrown items.
      await s.command(`execute in ${N} run fill ${base.x+19} ${base.y-1} ${base.z+19} ${base.x+31} ${base.y-1} ${base.z+31} minecraft:stone`);
      await s.command(`execute in ${N} run fill ${base.x+19} ${base.y} ${base.z+19} ${base.x+31} ${base.y+5} ${base.z+31} minecraft:air`);
      destination={x:base.x+24.5,y:base.y,z:base.z+24.5};await walk(s,destination.x,base.y,base.z+0.5);await walk(s,destination.x,base.y,destination.z);
     }
    }
    const before=await observe(s);console.log('outbound',scenario,before.position,before.routeMemory);result.deathPosition=before.position;destination={...before.position};result.destination=destination;
    await sleep(3500);const dead=s.inbox.wait('goal_control',e=>e.payload.operation==='dead');await s.command(`kill ${A}`);await dead;
    result.dropProof=await s.command(`execute in ${dimension} positioned ${before.position.x} ${before.position.y} ${before.position.z} run data get entity @e[type=minecraft:item,limit=1,sort=nearest]`);
    const diedAt=Date.now();result.steps.push(await act(s,'respawn',{}));await dim(s,OW);await sleep(750);
    const spawned=await observe(s);result.spawnPosition=spawned.position;result.respawnRoute=spawned.routeMemory;
    if(Math.hypot(spawned.position.x-spawnX,spawned.position.y-y,spawned.position.z-0.5)>3)throw Error('Fixture respawn missed the prepared camp');
    if(!result.respawnRoute?.death || Math.hypot(result.respawnRoute.death.x-result.deathPosition.x,result.respawnRoute.death.y-result.deathPosition.y,result.respawnRoute.death.z-result.deathPosition.z)>2) throw Error('Respawn route facts lost the death position');
    // The scripted model chooses retrace. No coordinates from the fixture's world scans or item entities enter it.
    for(let attempt=0;attempt<5;attempt++) {
     const current=await observe(s);
     const d=current.world.dimension===dimension?Math.hypot(current.position.x-destination.x,current.position.y-destination.y,current.position.z-destination.z):Infinity;
     if(d<=3) break;
     const r=await act(s,'travel_to',{...destination,dimension,retrace:true,build:false,tolerance:1,timeoutMs:110000});result.steps.push(r);
     if(r.reasonCode==='DIMENSION_TRANSITION'){await sleep(700);continue;}
     if(r.state!=='SUCCEEDED')break;
    }
    const after=await observe(s);
    result.secondsToDropPoint=(Date.now()-diedAt)/1000;
    result.distance=after.world.dimension===dimension?Math.hypot(after.position.x-destination.x,after.position.y-destination.y,after.position.z-destination.z):null;
    result.reached=result.distance!==null&&result.distance<=3;
    // Pick up only stacks the player's current observation actually sees.
    for(let n=0;n<4;n++) {const o=await observe(s);for(const item of o.entities??[])if(item.type==='minecraft:item')result.steps.push(await act(s,'pick_up_item',{targetSelector:item.stableId??item.uuid}));if(!o.inventory.items.some(i=>i.itemId==='minecraft:iron_pickaxe'))result.steps.push(await act(s,'control',{...control(n===3?-90:n*90,1),forward:0,pitch:70}));}
    const final=await observe(s);result.finalPosition=final.position;result.finalEntities=final.entities;const inventory=final.inventory.items;result.inventory=inventory;result.pickaxeRecovered=inventory.some(i=>i.itemId==='minecraft:iron_pickaxe');result.kitRecovered=result.pickaxeRecovered&&inventory.some(i=>i.itemId==='minecraft:iron_sword');
    result.secondsToPick=(Date.now()-diedAt)/1000;result.secondsToKit=result.kitRecovered?result.secondsToPick:null;result.ok=result.reached;
   } catch(error){result.error=String(error.stack??error);result.ok=false;}
   await writeFile(join(out,'results.json'),JSON.stringify({jar,results},null,2));console.log(JSON.stringify(result));
   if(!result.ok)break;
   // Cave repeats walk home; other fixtures reset only between trials, creating no graph edge.
   if(scenario==='cave') {await walk(s,24.5,y,0.5);await walk(s,0.5,y,0.5);}
   else {
    // Fixture-only reset between trials. Teleport creates no graph edge.
    await s.command(`execute in ${OW} run tp ${A} ${spawnX} ${y} 0.5`);await sleep(1500);
   }
   await s.command(`clear ${A}`);
  }
  if(process.env.RECOVERY_TOOLS==='1' && scenario==='cave' && results.filter(r=>r.scenario==='cave').every(r=>r.ok)) {
   const tool={kind:'measured-tool-path',steps:[]};const t0=Date.now();
   await s.command(`clear ${A}`);
   for(let dy=0;dy<3;dy++) await s.command(`setblock 3 ${y+dy} 0 minecraft:oak_log`);
   for(let dy=2;dy>=0;dy--) tool.steps.push(await act(s,'break_block',{x:3,y:y+dy,z:0,expectedBlockId:'minecraft:oak_log',timeoutMs:20000}));
   for(let round=0;round<3;round++) for(const item of (await observe(s)).entities??[]) if(item.type==='minecraft:item')tool.steps.push(await act(s,'pick_up_item',{targetSelector:item.stableId??item.uuid}));
   tool.logsSeconds=(Date.now()-t0)/1000;
   tool.steps.push(await act(s,'craft_inventory',{recipeId:'minecraft:oak_planks',count:12,timeoutMs:20000}));
   tool.steps.push(await act(s,'craft_inventory',{recipeId:'minecraft:crafting_table',count:1,timeoutMs:20000}));
   tool.steps.push(await act(s,'craft_inventory',{recipeId:'minecraft:stick',count:4,timeoutMs:20000}));
   tool.steps.push(await act(s,'place_block',{x:0,y,z:1,face:'up',itemId:'minecraft:crafting_table'}));
   tool.steps.push(await act(s,'craft_table',{recipeId:'minecraft:wooden_pickaxe',x:0,y,z:1,count:1,timeoutMs:20000}));
   tool.woodenPickSeconds=(Date.now()-t0)/1000;
   let inv=(await observe(s)).inventory.items;let pick=inv.find(i=>i.itemId==='minecraft:wooden_pickaxe');
   if(pick) tool.steps.push(await act(s,'select_item',{itemId:'minecraft:wooden_pickaxe'}));
   for(let x=1;x<=3;x++) await s.command(`setblock ${x} ${y} 2 minecraft:stone`);
   for(let x=1;x<=3;x++) tool.steps.push(await act(s,'break_block',{x,y,z:2,expectedBlockId:'minecraft:stone',timeoutMs:20000}));
   for(let round=0;round<3;round++) for(const item of (await observe(s)).entities??[]) if(item.type==='minecraft:item')tool.steps.push(await act(s,'pick_up_item',{targetSelector:item.stableId??item.uuid}));
   tool.steps.push(await act(s,'craft_table',{recipeId:'minecraft:stone_pickaxe',x:0,y,z:1,count:1,timeoutMs:20000}));
   tool.stonePickSeconds=(Date.now()-t0)/1000;tool.inventory=(await observe(s)).inventory.items;tool.ok=tool.inventory.some(i=>i.itemId==='minecraft:stone_pickaxe');
   await writeFile(join(out,'tool-path.json'),JSON.stringify(tool,null,2));console.log(JSON.stringify(tool));
   const shaft={steps:[]};
   shaft.steps.push(await act(s,'navigate_to',{x:0.5,y,z:0.5,tolerance:0.2,sprint:false,timeoutMs:30000}));
   await s.command(`give ${A} minecraft:cobblestone 16`);await s.command(`give ${A} minecraft:water_bucket 1`);
   await s.command(`fill -1 ${y-9} -1 1 ${y-1} 1 minecraft:stone`);
   shaft.steps.push(await act(s,'dig_to',{pattern:'shaft',y:y-8,maxShaftY:y-8,throughCaves:false,timeoutMs:110000}));
   shaft.bottom=(await observe(s)).position;
   shaft.steps.push(await act(s,'travel_to',{x:0.5,y,z:0.5,retrace:true,build:true,tolerance:1,timeoutMs:110000}));
   shaft.top=(await observe(s)).position;shaft.ok=Math.abs(shaft.top.y-y)<1 && Math.abs(shaft.bottom.y-(y-8))<1;
   await writeFile(join(out,'shaft.json'),JSON.stringify(shaft,null,2));console.log(JSON.stringify({kind:'shaft',...shaft}));
  }
 } catch(error) {await writeFile(join(dir,'fixture-error.json'),JSON.stringify({error:String(error.stack??error)},null,2));throw error;} finally {await s.stop();server=null;}
 if(results.some(r=>!r.ok)) break;
}
process.exit(results.length===3*Number(process.env.RECOVERY_REPS??3)&&results.every(r=>r.ok)?0:only&&results.every(r=>r.ok)?0:1);
