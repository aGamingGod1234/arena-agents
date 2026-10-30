#!/usr/bin/env node
// Provider-free check that use_item with a bucket fills from, and reports, the source it was aimed at (d2c-iron-c casting).
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=resolve(process.argv[2] ?? 'runtime/bucket-aim-live');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if(!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port=Number(process.env.SLOT_PORT_BASE), server=join(out,'server');
await mkdir(out,{recursive:true});
if((await readdir(out)).length)throw new Error('Use a fresh output directory');
await writeFile(join(out,'manifest.json'),JSON.stringify({kind:'provider-free live mechanics',aiPerformanceMeasured:false,fixtureSetupUsesOperatorCommands:true,jarSha256:createHash('sha256').update(await readFile(join(root,'build/libs/arena-agents-0.2.0.jar'))).digest('hex'),node:process.version},null,2));
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
let rcon,bridge,record,observation;
const agent='Bucket';
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
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free bucket aim fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty peaceful');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');
  await command('forceload add -16 -16 32 32');await sleep(2000);
  await command('fill -5 75 -5 20 90 10 minecraft:air');await command('fill -4 79 -4 2 79 4 minecraft:stone');
  const registered=inbox.wait('agent_registered');console.log(await command(`execute positioned 0.5 80 0.5 run codex summon gpt-6.1-sol low ${agent}`));
  const e=await registered;record={...(e.payload.record??e.payload),agentId:e.agentId};
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  const started=inbox.wait('goal_control',e=>e.payload.operation==='start');await command(`codex start ${agent} Survive for 600 seconds.`);record.goalRevision=(await started).payload.goalRevision;
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  await command('fill -4 79 -4 5 79 8 minecraft:stone');
  await command(`gamemode survival ${agent}`);
  async function act(type,args){
    const id=`bucket-${++ordinal}`;
    const r=await executeAction({actionId:id,action:{type,arguments:args},provenance:{traceId:id,programId:'bucket-fixture',stepId:id,eventSequence:observation.eventSequence}});
    return r;
  }
  await command('fill -4 79 -4 8 79 8 minecraft:stone');
  const results={};
  const is=async(x,y,z,id)=>/passed/i.test(await command(`execute if block ${x} ${y} ${z} minecraft:${id}`));
  const hold=async id=>{await command(`item replace entity ${agent} weapon.mainhand with minecraft:${id}`);await sleep(300);await observe();};
  const at=async(x,y,z,yaw,pitch)=>{await command(`tp ${agent} ${x} ${y} ${z} ${yaw} ${pitch}`);await sleep(600);await observe();};
  const use=(expected,x,y,z)=>act('use_item',{mode:'once',durationMs:250,expectedItemId:`minecraft:${expected}`,aimX:x,aimY:y,aimZ:z});
  // Game d2c-iron-c geometry shifted by (-78,+40,-112): coolant source at 0,80,0 walled by obsidian, the fresh cast at
  // 1,80,0 between it and the eye. The straight line to the source's center crosses that obsidian.
  const pool=async()=>{await command('fill -2 80 -2 2 82 2 minecraft:air');
    for(const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]])await command(`setblock ${x} 80 ${z} minecraft:obsidian`);
    await command('setblock 0 80 0 minecraft:water');};
  await pool();await at(2.43,80,0.51,90,10);await hold('bucket');
  let r=await use('bucket',0.5,80.5,0.5);
  results.hiddenCenter={state:r.state,reasonCode:r.reasonCode,message:r.message,filled:await is(0,80,0,'air')};
  await pool();await command('setblock 0 81 0 minecraft:obsidian');await at(2.43,80,0.51,90,10);await hold('bucket');
  r=await use('bucket',0.5,80.5,0.5);
  results.sealed={state:r.state,reasonCode:r.reasonCode,message:r.message,stillWater:await is(0,80,0,'water')};
  await pool();await at(6.5,80,0.5,90,10);await hold('bucket');
  r=await use('bucket',0.5,80.5,0.5);
  results.outOfReach={state:r.state,reasonCode:r.reasonCode,message:r.message};
  await command('fill -2 80 -2 2 82 2 minecraft:air');await at(3.5,80,0.5,0,30);await hold('water_bucket');
  r=await use('water_bucket',3.5,80.0,2.5);
  results.pour={state:r.state,reasonCode:r.reasonCode,message:r.message,placed:await is(3,80,2,'water')};
  // The y-55 route at a lava pool: fill a bucket with lava from the pool edge, then pour water into the pool and scoop it
  // back. Vanilla converts each lava source the water touches to obsidian (the 4 sides of the poured cell).
  const lavaPool=async()=>{await command('fill -3 80 -3 3 82 3 minecraft:air');await command('fill -3 80 -3 3 80 3 minecraft:stone');
    await command('fill -1 80 -1 1 80 1 minecraft:lava');};
  const cells=async id=>{let n=0;for(let x=-1;x<=1;x++)for(let z=-1;z<=1;z++)if(await is(x,80,z,id))n++;return n;};
  await lavaPool();await at(2.5,81,0.5,90,40);await hold('bucket');
  r=await use('bucket',1.5,80.9,0.5);
  results.lavaFill={state:r.state,reasonCode:r.reasonCode,message:r.message,emptied:await is(1,80,0,'air')};
  await lavaPool();await at(2.5,81,0.5,90,40);await hold('water_bucket');
  // A filled bucket's ray ignores fluids (vanilla): aimed at the lava surface it lands on the floor beyond, so aim at the
  // center cell's floor.
  r=await use('water_bucket',0.5,80.05,0.5);await sleep(1500);
  results.poolCast={state:r.state,reasonCode:r.reasonCode,message:r.message,obsidian:await cells('obsidian'),lava:await cells('lava'),centerWater:await is(0,80,0,'water')};
  await hold('bucket');
  r=await use('bucket',0.5,80.5,0.5);await sleep(1500);
  results.scoop={state:r.state,reasonCode:r.reasonCode,message:r.message,centerEmpty:await is(0,80,0,'air'),obsidian:await cells('obsidian')};
  await writeFile(join(out,'bucket.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
  const ok=results.hiddenCenter.state==='SUCCEEDED'&&results.hiddenCenter.filled&&/water_bucket/.test(results.hiddenCenter.message)
    &&results.sealed.reasonCode==='TARGET_OBSTRUCTED'&&results.sealed.stillWater
    &&results.outOfReach.reasonCode==='TARGET_TOO_FAR'
    &&results.pour.state==='SUCCEEDED'&&results.pour.placed&&/minecraft:stone at 3,79,2 face up/.test(results.pour.message)
    &&results.lavaFill.state==='SUCCEEDED'&&results.lavaFill.emptied&&/lava_bucket/.test(results.lavaFill.message)
    &&results.poolCast.state==='SUCCEEDED'&&results.poolCast.centerWater&&results.poolCast.obsidian===4
    &&results.scoop.state==='SUCCEEDED'&&results.scoop.centerEmpty&&/water_bucket/.test(results.scoop.message);
  if(!ok)throw new Error('bucket aim live check failed');
  console.log('Bucket aim live check passed');
} finally {
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
