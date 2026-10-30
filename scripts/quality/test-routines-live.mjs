#!/usr/bin/env node
// Provider-free mechanics checks of the exact optional examples through the runProgram executor.
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { NativeProgramExecutor } from '../../coordinator/src/native-program-executor.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=resolve(process.argv[2] ?? 'runtime/routines/live');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if(!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port=Number(process.env.SLOT_PORT_BASE), server=join(out,'server');
await mkdir(out,{recursive:true});
if((await readdir(out)).length)throw new Error('Use a fresh output directory');
const reference=await readFile(join(root,'coordinator/test/fixtures/routine-programs.md'),'utf8');
await writeFile(join(out,'routine-examples.md'),reference);
await writeFile(join(out,'manifest.json'),JSON.stringify({kind:'provider-free live mechanics',aiPerformanceMeasured:false,fixtureSetupUsesOperatorCommands:true,referenceSha256:createHash('sha256').update(reference).digest('hex'),jarSha256:createHash('sha256').update(await readFile(join(root,'build/libs/arena-agents-0.2.0.jar'))).digest('hex'),node:process.version},null,2));
await cp(template,server,{recursive:true});
for(const name of await readdir(join(server,'mods'))) if(name.startsWith('arena-agents-')) {
  const {unlink}=await import('node:fs/promises'); await unlink(join(server,'mods',name));
}
await cp(join(root,'build/libs/arena-agents-0.2.0.jar'),join(server,'mods/arena-agents-0.2.0.jar'));
const secret=randomBytes(32).toString('hex');
await writeFile(join(out,'secret.txt'),secret,{mode:0o600});
await writeFile(join(server,'server.properties'),`online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port+2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port+1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261017\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=5\nsimulation-distance=5\npause-when-empty-seconds=-1\nmax-players=4\n`);
const {open}=await import('node:fs/promises');
const log=await open(join(out,'server.log'),'a');
const child=spawn(`${process.env.JAVA_HOME}/bin/java`,[`-Darenaagents.bridgePort=${port}`,'-Darenaagents.coordinatorAutoStart=false',`-Darenaagents.bridgeSecretFile=${join(out,'secret.txt')}`,'-Xms512M','-Xmx2G','-jar','fabric-server-launch.jar','nogui'],{cwd:server,stdio:['ignore',log.fd,log.fd]});
await writeFile(join(out,'server.pid'),String(child.pid));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Inbox {
  events=[]; waiters=[];
  constructor(bridge){bridge.on('message',e=>this.accept(e));bridge.on('ready',e=>this.accept({type:'ready',...e}));}
  accept(e){const i=this.waiters.findIndex(w=>w.type===e.type&&w.match(e));if(i>=0)this.waiters.splice(i,1)[0].done(e);else {this.events.push(e);if(this.events.length>1024)this.events.shift();}}
  wait(type,match=()=>true,ms=30000){const i=this.events.findIndex(e=>e.type===type&&match(e));if(i>=0)return Promise.resolve(this.events.splice(i,1)[0]);return new Promise((res,rej)=>{const w={type,match,done:e=>{clearTimeout(t);res(e)}};const t=setTimeout(()=>{this.waiters=this.waiters.filter(x=>x!==w);rej(new Error(`TIMEOUT ${type}`))},ms);this.waiters.push(w)});}
}
let rcon,bridge,record,observation,executor,active=false;
const agent='Routines';
const results=[];
const command=async s=>{
  if(rcon.state==='closed'){rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,commandTimeoutMs:5000});await rcon.connect();}
  return (await rcon.command(s)).text;
};
async function observe(){const seq=observation?.eventSequence??0;const next=inbox.wait('observation',e=>e.agentId===record.agentId&&e.payload.ready&&e.payload.eventSequence>seq);await bridge.send('request_observation',record.agentId,{goalRevision:record.goalRevision});return (await next).payload;}
async function inspect(query){const requestId=`inspect-${++ordinal}`;const next=inbox.wait('inspection_result',e=>e.payload.requestId===requestId);await bridge.send('inspection_request',record.agentId,{requestId,goalRevision:record.goalRevision,query:{offset:0,limit:16,...query}});const p=(await next).payload;if(p.error)throw new Error(JSON.stringify(p.error));return {state:'SUCCEEDED',reasonCode:'INSPECTED',...p.result};}
let ordinal=0,inbox;
const actions=[];
async function executeAction(c){
  const args=c.action.arguments;
  const payload={actionId:c.actionId,traceId:c.provenance.traceId,goalRevision:record.goalRevision,actionType:c.action.type,arguments:args,
    provenance:{provider:record.provider,model:record.model,reasoningEffort:record.reasoningEffort,serviceTier:record.serviceTier,traceId:c.provenance.traceId,programId:c.provenance.programId,programVersion:c.provenance.programVersion??1,sourceStepId:c.provenance.stepId,eventSequence:c.provenance.eventSequence}};
  const next=inbox.wait('action_result',e=>e.payload.actionId===c.actionId&&['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(e.payload.state),65000);
  await bridge.send('action_command',record.agentId,payload);
  const r=(await next).payload;
  await bridge.send('action_result_ack',record.agentId,{actionId:c.actionId,goalRevision:record.goalRevision});
  actions.push({type:c.action.type,args,state:r.state,reasonCode:r.reasonCode,message:r.message});
  await writeFile(join(out,'actions.json'),JSON.stringify(actions,null,2));
  return r;
}
const common={minHealth:10,minAir:10,allowedThreat:null};
async function loadPrograms(){const doc=await readFile(join(root,'coordinator/test/fixtures/routine-programs.md'),'utf8');return Object.fromEntries([...doc.matchAll(/```js routine-(\w+)\n([\s\S]*?)```/g)].map(m=>[m[1],m[2]]));}
async function run(name,parameters,verify,body=name){
  if(name.startsWith('frame-')){for(const yaw of [-180,-90,0,90]){await command(`execute as ${agent} at @s run tp @s ~ ~ ~ ${yaw} 25`);await observe();}}
  await command(`gamemode survival ${agent}`);
  await sleep(250);
  const programs=await loadPrograms();
  const before=await observe();const start=actions.length;active=true;
  await writeFile(join(out,'before.json'),JSON.stringify(before,null,2));
  let result;
  try{result=await executor.run(record,{source:programs.common+programs[body],parameters:{...common,...parameters},maxActions:512,timeoutMs:120000,observationIntervalMs:100},{observation:before,eventSequence:before.eventSequence,executeAction,cancelAction:async actionId=>{await bridge.send('action_cancel',record.agentId,{actionId,goalRevision:record.goalRevision,});},refreshObservation:observe,inspect});}
  finally{active=false;}
  const after=await observe();
  const pass=result.reasonCode==='PROGRAM_EXHAUSTED'&&await verify(after);
  results.push({name,pass,sourceSha256:createHash('sha256').update(programs.common+programs[body]).digest('hex'),parameters,result,after,actions:actions.slice(start)});
  console.log(JSON.stringify({name,pass,reason:result.reasonCode,trigger:result.trigger,actions:actions.length-start,position:after.position}));
  await writeFile(join(out,'results.json'),JSON.stringify({kind:'provider-free live runProgram mechanics',aiPerformanceMeasured:false,results},null,2));
  return pass;
}
async function reset(dim,x,y,z){
  await command(`gamemode spectator ${agent}`);
  await command('difficulty peaceful');
  await command(`execute in ${dim} run forceload add ${x-16} ${z-16} ${x+32} ${z+32}`);
  for(let i=0;i<100;i++){if(/time is/.test(await command(`execute in ${dim} if loaded ${x} ${y} ${z} run time query gametime`)))break;await sleep(100)}
  await command(`execute in ${dim} run fill ${x-5} ${y-5} ${z-5} ${x+20} ${y+12} ${z+10} minecraft:air`);
  await command(`execute in ${dim} run fill ${x-4} ${y-1} ${z-4} ${x+2} ${y-1} ${z+4} minecraft:stone`);
  await command(`execute in ${dim} run tp ${agent} ${x+0.5} ${y} ${z+0.5} -90 0`);
  await command(`clear ${agent}`);await command(`effect give ${agent} minecraft:instant_health 1 5 true`);
  await command(`give ${agent} minecraft:cobblestone 64`);
  await sleep(250); await observe();
}
try {
  for(let i=0;i<150;i++){try{rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,connectTimeoutMs:500,commandTimeoutMs:5000});await rcon.connect();break}catch(e){await rcon?.close();if(i===149)throw e;await sleep(1000)}}
  bridge=new MultiplexedServerBridge({port,secret},{});inbox=new Inbox(bridge);
  bridge.on('observation',e=>{if(e.agentId===record?.agentId&&e.payload.ready){observation=e.payload;if(active)executor.onObservation(record,e.payload)}});
  bridge.on('goal_spec_request',e=>{bridge.send('goal_spec_proposal',e.agentId,{requestId:e.payload.requestId,summary:'Controlled live mechanics fixture',predicate:{type:'survive_duration',ticks:12000}}).catch(()=>{});});
  const ready=inbox.wait('ready');bridge.start();await ready;
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free routines fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty peaceful');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');
  await command('forceload add -16 -16 32 32');await sleep(2000);
  await command('fill -5 75 -5 20 90 10 minecraft:air');await command('fill -4 79 -4 2 79 4 minecraft:stone');
  const registered=inbox.wait('agent_registered');console.log(await command(`execute positioned 0.5 80 0.5 run codex summon gpt-6.1-sol low ${agent}`));
  const e=await registered;record={...(e.payload.record??e.payload),agentId:e.agentId};
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  const started=inbox.wait('goal_control',e=>e.payload.operation==='start');await command(`codex start ${agent} Survive for 600 seconds.`);record.goalRevision=(await started).payload.goalRevision;
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});executor=new NativeProgramExecutor();
  let selection=process.env.ROUTINES_ONLY ?? 'all';
  for(let round=0;round<20;round++){
  const only=selection==='all'?null:selection;
  if(!only||only==='pillar')for(const [i,h] of [1,2,3].entries()){
    const x=i*32;await reset('minecraft:overworld',x,80,0);
    await run(`pillar-${h}`,{base:{x,y:80,z:0},supportId:'minecraft:stone',blockId:'minecraft:cobblestone',height:h},o=>o.position.y>=80+h-0.1,'pillar');
  }
  if(!only||only==='bridge')for(const [i,dx,dz,len] of [[0,1,0,2],[1,0,1,3],[2,-1,0,4]]){
    const x=i*32;await reset('minecraft:overworld',x,80,32);
    await command(`fill ${x-4} 79 28 ${x+4} 79 36 minecraft:air`);await command(`setblock ${x} 79 32 minecraft:stone`);
    await run(`bridge-${dx}-${dz}-${len}`,{start:{x,y:79,z:32},supportId:'minecraft:stone',blockId:'minecraft:cobblestone',dx,dz,length:len,nether:false},o=>Math.abs(o.position.x-(x+dx*len+0.5))<0.2&&Math.abs(o.position.z-(32+dz*len+0.5))<0.2,'bridge');
  }
  if(!only||only==='nether')for(const [i,dx,dz,len] of [[0,1,0,2],[1,0,1,3],[2,-1,0,4]]){
    const x=i*32;await reset('minecraft:the_nether',x,80,32);
    await command(`execute in minecraft:the_nether run fill ${x-5} 76 27 ${x+10} 76 42 minecraft:lava`);
    await command(`execute in minecraft:the_nether run fill ${x-4} 79 28 ${x+4} 79 36 minecraft:air`);await command(`execute in minecraft:the_nether run fill ${x-dz} 79 ${32+dx} ${x+dz} 79 ${32-dx} minecraft:stone`);
    await run(`nether-${dx}-${dz}-${len}`,{start:{x,y:79,z:32},supportId:'minecraft:stone',blockId:'minecraft:cobblestone',dx,dz,length:len,nether:true},o=>Math.abs(o.position.x-(x+dx*len+0.5))<0.2&&Math.abs(o.position.z-(32+dz*len+0.5))<0.2&&o.player.health>=20,'bridge');
  }
  if(!only||only==='portal')for(let i=0;i<3;i++){
    const x=i*32;await reset('minecraft:overworld',x,80,64);
    await command(`fill ${x-4} 79 60 ${x+10} 79 70 minecraft:stone`);
    await command(`fill ${x+1} 80 65 ${x+4} 80 65 minecraft:stone`);
    await command(`fill ${x+1} 80 67 ${x+4} 80 67 minecraft:stone`);
    await command(`setblock ${x+4} 80 66 minecraft:stone`);
    await command(`setblock ${x+1} 80 66 minecraft:stone`);
    await command(`fill ${x} 80 64 ${x+4} 80 64 minecraft:stone`);
    await command(`setblock ${x+1} 79 62 minecraft:lava`);
    await command(`give ${agent} minecraft:water_bucket`);
    const params={placeWater:true,reclaim:false,ignite:false,waterStand:{x:x+2.5,y:81,z:65.5},water:{x:x+3,y:79,z:66,face:'up',blockId:'minecraft:stone'},casts:[{source:{x:x+1,y:79,z:62},sourceStand:{x:x+0.5,y:80,z:61.5},stand:{x:x+2.5,y:81,z:65.5},support:{x:x+2,y:79,z:66,face:'up',blockId:'minecraft:stone'},target:{x:x+2,y:80,z:66,before:'minecraft:water'},wet:{x:x+3,y:80,z:66}}]};
    if(i===1){
      await command(`setblock ${x+2} 80 67 minecraft:air`);
      await command(`setblock ${x+2} 80 68 minecraft:stone`);
      params.water={x:x+2,y:79,z:67,face:'up',blockId:'minecraft:stone'};
      params.casts[0].wet={x:x+2,y:80,z:67};
    }
    if(i===2){
      await command(`setblock ${x+3} 80 66 minecraft:stone`);
      params.water={x:x+3,y:80,z:66,face:'up',blockId:'minecraft:stone'};
      params.casts[0].wet={x:x+2,y:81,z:66};
    }
    await command(`tp ${agent} ${x+2.5} 81 65.5 0 30`);
    await run(`portal-${i}`,params,async o=>/time is/.test(await command(`execute if block ${x+2} 80 66 minecraft:obsidian run time query gametime`))&&o.player.health>=20,'portal');
  }
  if(!only||only==='frame'){
    const x=128,z=96;await reset('minecraft:overworld',x,80,z);
    await command(`fill ${x-4} 79 ${z-8} ${x+13} 79 ${z+4} minecraft:stone`);
    await command(`fill ${x-4} 78 ${z-6} ${x+13} 78 ${z-6} minecraft:stone`);
    await command(`fill ${x-3} 80 ${z-6} ${x+13} 80 ${z-3} minecraft:stone`);
    await command(`fill ${x-3} 81 ${z-6} ${x+13} 81 ${z-2} minecraft:stone`);
    await command(`fill ${x-2} 81 ${z-2} ${x+5} 81 ${z-2} minecraft:stone`);
    await command(`fill ${x} 79 ${z+1} ${x+3} 85 ${z+1} minecraft:stone`);
    for(const dx of [0,3])for(const y of [80,84])await command(`setblock ${x+dx} ${y} ${z} minecraft:cobblestone`);
    for(let i=0;i<10;i++)await command(`setblock ${x+i} 81 ${z-5} minecraft:lava`);
    await command(`give ${agent} minecraft:water_bucket`);
    await command(`give ${agent} minecraft:iron_pickaxe`);
    await command(`give ${agent} minecraft:flint_and_steel`);
    await command(`tp ${agent} ${x+1.5} 82 ${z-1.5} 0 0`);
    let source=0;
    for(const column of [1,2]){
      const side=column===1?0:3;
      const chosen=[{dx:side,y:81,wy:81},{dx:side,y:82,wy:82},{dx:side,y:83,wy:83},{dx:column,y:80,wy:81},{dx:column,y:84,wy:85}];
      for(const [batchIndex,batch] of [chosen.slice(0,3),chosen.slice(3)].entries()){
        const casts=batch.map(t=>{const sx=x+source++;return {source:{x:sx,y:81,z:z-5},sourceStand:{x:sx+0.5,y:82,z:z-3.5},stand:{x:x+t.dx+0.5,y:82,z:z-1.5},support:t.y===80?{x:x+t.dx,y:79,z,face:'up',blockId:'minecraft:stone'}:{x:x+t.dx,y:t.y,z:z+1,face:'north',blockId:'minecraft:stone'},target:{x:x+t.dx,y:t.y,z},wet:{x:x+column,y:t.wy,z}}});
        const params={placeWater:batchIndex===0,reclaim:batchIndex===1,ignite:column===2&&batchIndex===1,frame:[...Array.from({length:3},(_,i)=>[{x,y:81+i,z},{x:x+3,y:81+i,z}]).flat(),{x:x+1,y:80,z},{x:x+2,y:80,z},{x:x+1,y:84,z},{x:x+2,y:84,z}],lightStand:{x:x+1.5,y:82,z:z-2.5},bottom:{x:x+1,y:80,z},waterStand:{x:x+column+0.5,y:82,z:z-1.5},water:{x:x+column,y:85,z:z+1,face:'north',blockId:'minecraft:stone'},waterSource:{x:x+column,y:85,z},reclaimStand:{x:x+column+0.5,y:82,z:z-1.5},casts};
        const passed=await run(`frame-column-${column}-batch-${batchIndex}`,params,async o=>{for(const c of casts)if(!/time is/.test(await command(`execute if block ${c.target.x} ${c.target.y} ${c.target.z} minecraft:obsidian run time query gametime`)))return false;return o.player.health===20},'portal');
        if(!passed)break;
      }
    }
  }
  if(!only||only==='blaze')for(let i=0;i<3;i++){
    const x=i*32;await reset('minecraft:the_nether',x,80,64);
    await command(`execute in minecraft:the_nether run fill ${x-4} 79 60 ${x+12} 79 70 minecraft:nether_bricks`);
    await command(`execute in minecraft:the_nether run fill ${x+1} 80 65 ${x+1} 82 65 minecraft:nether_bricks`);
    await command(`execute in minecraft:the_nether run fill ${x-1} 83 62 ${x+10} 83 66 minecraft:nether_bricks`);
    await command(`give ${agent} minecraft:iron_sword`);await command(`give ${agent} minecraft:bow`);await command(`give ${agent} minecraft:arrow 32`);
    await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
    await command(`item replace entity ${agent} armor.chest with minecraft:iron_chestplate`);
    await command(`difficulty normal`);
    await command(`execute in minecraft:the_nether run summon minecraft:blaze ${x+(i===0?5.5:i===1?7.5:10.5)} 80 64.5 {PersistenceRequired:1b}`);
    await command(`execute in minecraft:the_nether run tp ${agent} ${x+0.5} 80 64.5 -90 0`);
    await sleep(250);
    await command(`gamemode survival ${agent}`);await sleep(250);
    const obs=await observe();await writeFile(join(out,`blaze-${i}-before.json`),JSON.stringify(obs,null,2));const target=obs.entities.find(e=>e.type==='minecraft:blaze');
    if(!target)throw new Error('BLAZE_NOT_VISIBLE');
    await run(`blaze-${i}`,{targetId:target.uuid,allowedThreat:target.uuid,cover:{x:x+0.5,y:80,z:65.5},peek:{x:x+(i===0?2.5:0.5),y:80,z:64.5},weaponId:"minecraft:iron_sword",ranged:i!==0},async o=>{const healthText=await command(`execute in minecraft:the_nether run data get entity ${target.uuid} Health`);const health=Number(healthText.match(/data: ([0-9.]+)f/)?.[1]);return o.player.health>=20&&health<20;},'blaze');
    await writeFile(join(out,`blaze-${i}-target-after.txt`),await command(`execute in minecraft:the_nether run data get entity ${target.uuid} Health`));
    await command('difficulty peaceful');
  }
  if(!process.env.ROUTINES_WATCH)break;
  console.log('Waiting for next file (pillar|bridge|nether|portal|frame|blaze|all|stop)');
  const next=join(out,'next');let found=false;
  for(let i=0;i<600;i++){
    try{selection=(await readFile(next,'utf8')).trim();const {unlink}=await import('node:fs/promises');await unlink(next);found=true;break;}catch{}await sleep(1000);
  }
  if(!found||selection==='stop')break;
  }
  process.exitCode=results.some(r=>!r.pass)?1:0;

} finally {
  if(record)await executor?.cancel(record.agentId).catch(()=>{});
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
