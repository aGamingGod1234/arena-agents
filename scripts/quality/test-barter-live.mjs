#!/usr/bin/env node
// Provider-free check of piglin bartering through production actions (d5-iron-h went to a bastion for pearls): with a
// golden helmet worn, a gold ingot handed over with interact_entity, and one dropped with drop_item near a calm adult
// piglin, are each taken and answered with a barter return the body then collects with pick_up_item. Also checks that
// drop_item, like a vanilla Q drop, leaves the player as the thrown item's owner.
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=resolve(process.argv[2] ?? 'runtime/barter-live');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if(!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port=Number(process.env.SLOT_PORT_BASE), server=join(out,'server');
// BARTER_JAR compares another build (the base jar) on the same fixture.
const jar=resolve(process.env.BARTER_JAR ?? join(root,'build/libs/arena-agents-0.2.0.jar'));
await mkdir(out,{recursive:true});
if((await readdir(out)).length)throw new Error('Use a fresh output directory');
await writeFile(join(out,'manifest.json'),JSON.stringify({kind:'provider-free live mechanics',aiPerformanceMeasured:false,fixtureSetupUsesOperatorCommands:true,jarSha256:createHash('sha256').update(await readFile(jar)).digest('hex'),jar,node:process.version},null,2));
await cp(template,server,{recursive:true});
for(const name of await readdir(join(server,'mods'))) if(name.startsWith('arena-agents-')) {
  const {unlink}=await import('node:fs/promises'); await unlink(join(server,'mods',name));
}
await cp(jar,join(server,'mods/arena-agents-0.2.0.jar'));
const secret=randomBytes(32).toString('hex');
await writeFile(join(out,'secret.txt'),secret,{mode:0o600});
await writeFile(join(server,'server.properties'),`online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port+2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port+1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261021\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=5\nsimulation-distance=5\npause-when-empty-seconds=-1\nmax-players=4\n`);
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
let rcon,bridge,record,observation;
const agent='Barter';
const command=async s=>{
  if(rcon.state==='closed'){rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,commandTimeoutMs:5000});await rcon.connect();}
  return (await rcon.command(s)).text;
};
async function observe(){const seq=observation?.eventSequence??0;const next=inbox.wait('observation',e=>e.agentId===record.agentId&&e.payload.ready&&e.payload.eventSequence>seq);await bridge.send('request_observation',record.agentId,{goalRevision:record.goalRevision});return (await next).payload;}
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
try {
  for(let i=0;i<150;i++){try{rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,connectTimeoutMs:500,commandTimeoutMs:5000});await rcon.connect();break}catch(e){await rcon?.close();if(i===149)throw e;await sleep(1000)}}
  bridge=new MultiplexedServerBridge({port,secret},{});inbox=new Inbox(bridge);
  bridge.on('observation',e=>{if(e.agentId===record?.agentId&&e.payload.ready){observation=e.payload}});
  bridge.on('goal_spec_request',e=>{bridge.send('goal_spec_proposal',e.agentId,{requestId:e.payload.requestId,summary:'Controlled live mechanics fixture',predicate:{type:'survive_duration',ticks:12000}}).catch(()=>{});});
  const ready=inbox.wait('ready');bridge.start();await ready;
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free barter fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty easy');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');
  await command('forceload add -16 -16 32 32');await sleep(2000);
  await command('fill -6 75 -6 12 90 12 minecraft:air');await command('fill -6 79 -6 12 79 12 minecraft:stone');
  const registered=inbox.wait('agent_registered');console.log(await command(`execute positioned 0.5 80 0.5 run codex summon gpt-6.1-sol low ${agent}`));
  const e=await registered;record={...(e.payload.record??e.payload),agentId:e.agentId};
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  const started=inbox.wait('goal_control',e=>e.payload.operation==='start');await command(`codex start ${agent} Survive for 600 seconds.`);record.goalRevision=(await started).payload.goalRevision;
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  await command(`gamemode survival ${agent}`);
  await command(`effect give ${agent} minecraft:resistance 600 4 true`);
  // A glass pen keeps the piglin within reach of the drops; worn gold keeps it calm.
  await command('fill -3 80 -3 4 82 4 minecraft:glass hollow');await command('fill -2 80 -2 3 82 3 minecraft:air');
  await command(`item replace entity ${agent} armor.head with minecraft:golden_helmet`);
  await command(`clear ${agent}`);await command(`item replace entity ${agent} armor.head with minecraft:golden_helmet`);
  await command(`item replace entity ${agent} hotbar.0 with minecraft:gold_ingot 4`);
  await command(`item replace entity ${agent} hotbar.1 with minecraft:cobblestone 4`);
  async function act(type,args){
    const id=`barter-${++ordinal}`;
    return executeAction({actionId:id,action:{type,arguments:args},provenance:{traceId:id,programId:'barter-fixture',stepId:id,eventSequence:observation.eventSequence}});
  }
  const at=async(x,y,z,yaw,pitch)=>{await command(`tp ${agent} ${x} ${y} ${z} ${yaw} ${pitch}`);await sleep(600);observation=await observe();};
  const gold=()=>(observation.inventory?.items??[]).filter(i=>i.itemId==='minecraft:gold_ingot').reduce((n,i)=>n+i.count,0);
  const carried=()=>(observation.inventory?.items??[]).filter(i=>!['head','chest','legs','feet','offhand'].includes(i.slot));
  const inventoryIds=()=>{const counts=new Map();for(const i of carried())counts.set(i.itemId,(counts.get(i.itemId)??0)+i.count);return counts;};
  const results={};
  // A: drop_item keeps the owner like a vanilla Q drop.
  await at(0.5,80,0.5,0,30);
  let r=await act('drop_item',{slot:1,count:1});
  await sleep(300);
  const thrower=await command('data get entity @e[type=minecraft:item,limit=1,sort=nearest,x=0,y=80,z=1] Thrower');
  results.dropOwner={state:r.state,reasonCode:r.reasonCode,thrower};
  await command('kill @e[type=minecraft:item]');
  // The piglin: adult, immune to Overworld zombification, persistent.
  await command('summon minecraft:piglin 0.5 80 2.5 {IsImmuneToZombification:1b,PersistenceRequired:1b,UUID:[I;0,0,0,7]}');
  const piglin='00000000-0000-0000-0000-000000000007';
  await at(0.5,80,0.5,0,10);
  await sleep(1500);
  // B: hand one ingot over with interact_entity.
  await command(`tp @e[type=minecraft:piglin] 0.5 80 2.0`);
  observation=await observe();
  r=await act('select_item',{itemId:'minecraft:gold_ingot'});
  observation=await observe();
  r=await act('interact_entity',{targetId:piglin,hand:'main',expectedItemId:'minecraft:gold_ingot'});
  observation=await observe();
  results.handOver={state:r.state,reasonCode:r.reasonCode,message:r.message,goldAfter:gold()};
  // Barter answer after about 6 s of admiring.
  const returns=async()=>{
    for(let i=0;i<20;i++){
      await sleep(1000);observation=await observe();
      const drops=(observation.entities??[]).filter(x=>x.type==='minecraft:item'&&x.itemId!=='minecraft:gold_ingot');
      if(drops.length) return drops;
    }
    return [];
  };
  let drops=await returns();
  results.handReturn=drops.map(d=>({itemId:d.itemId,count:d.count,distance:Math.round(d.distance??-1)}));
  // Collect what was thrown with pick_up_item.
  results.handPickups=[];
  for(const d of drops){r=await act("pick_up_item",{targetSelector:d.stableId??d.uuid});results.handPickups.push({itemId:d.itemId,state:r.state,reasonCode:r.reasonCode});}
  observation=await observe();
  results.inventoryAfterHand=Object.fromEntries(inventoryIds());
  await command('kill @e[type=minecraft:item]');
  // C: drop one ingot ahead toward the piglin with drop_item.
  await at(0.5,80,0.5,0,25);
  const slot=carried().find(i=>i.itemId==='minecraft:gold_ingot');
  r=await act('drop_item',{slot:typeof slot?.slot==='number'?slot.slot:0,count:1});
  observation=await observe();
  results.dropGold={state:r.state,reasonCode:r.reasonCode,goldAfter:gold()};
  drops=await returns();
  results.dropReturn=drops.map(d=>({itemId:d.itemId,count:d.count,distance:Math.round(d.distance??-1)}));
  const piglinState=await command('data get entity @e[type=minecraft:piglin,limit=1] Brain.memories');
  results.piglinCalm=!/angry_at/.test(piglinState);
  await writeFile(join(out,'barter.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
  const ok=results.dropOwner.state==='SUCCEEDED'&&/\[I;/.test(results.dropOwner.thrower)
    &&results.handOver.state==='SUCCEEDED'&&results.handReturn.length>0&&results.handPickups.some(p=>p.state==='SUCCEEDED')
    &&results.dropGold.state==='SUCCEEDED'&&results.dropReturn.length>0&&results.piglinCalm;
  if(!ok)throw new Error('barter live check failed');
  console.log('Barter live check passed');
} finally {
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
