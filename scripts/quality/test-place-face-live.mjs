#!/usr/bin/env node
// Provider-free check of place_block against vanilla clicks (d3b-nether-a bridge): a support face turned from the eye is
// explained with the plane to pass, a player at the edge places, a side-face torch is a wall torch, a body overlap gives the box.
// ARENA_JAR overrides the jar under test (default: this checkout's build).
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=resolve(process.argv[2] ?? 'runtime/place-face-live');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if(!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port=Number(process.env.SLOT_PORT_BASE), server=join(out,'server');
const jar=resolve(process.env.ARENA_JAR ?? join(root,'build/libs/arena-agents-0.2.0.jar'));
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
const agent='Placer';
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
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free place face fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
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
    const id=`place-${++ordinal}`;
    return executeAction({actionId:id,action:{type,arguments:args},provenance:{traceId:id,programId:'place-fixture',stepId:id,eventSequence:observation.eventSequence}});
  }
  const results={};
  const block=async(x,y,z,id)=>/passed/i.test(await command(`execute if block ${x} ${y} ${z} minecraft:${id}`));
  const hold=async(id,n=16)=>{await command(`clear ${agent}`);await command(`item replace entity ${agent} weapon.mainhand with minecraft:${id} ${n}`);await sleep(300);await observe();};
  const at=async(x,y,z,yaw,pitch)=>{await command(`tp ${agent} ${x} ${y} ${z} ${yaw} ${pitch}`);await sleep(800);await observe();};
  const place=(x,y,z,face,item)=>act('place_block',{x,y,z,face,itemId:`minecraft:${item}`});
  const keep=(r,extra={})=>({state:r.state,reasonCode:r.reasonCode,cause:r.cause,message:r.message,...extra});
  await command('fill -6 76 -6 16 86 12 minecraft:air');
  // Bridge end over open air (d3b-nether-a 15,61,87 shifted): the support 1,80,0 on a pillar, destination 0,80,0 west of it.
  await command('fill 1 76 0 1 80 0 minecraft:nether_bricks');
  await at(1.5,81,0.5,90,60);await hold('cobblestone');
  results.awayFromEye=keep(await place(0,80,0,'west','cobblestone'),{placed:await block(0,80,0,'cobblestone')});
  // The same click from the edge, eye past the face plane as a player bridging places it.
  await at(0.75,81,0.5,90,70);await hold('cobblestone');
  results.fromEdge=keep(await place(0,80,0,'west','cobblestone'),{placed:await block(0,80,0,'cobblestone')});
  // A torch clicked on the side of a wall is vanilla's wall torch.
  await command('fill 2 79 4 9 79 7 minecraft:stone');await command('setblock 6 80 5 minecraft:stone');
  await at(3.5,80,5.5,-90,10);await hold('torch');
  results.wallTorch=keep(await place(5,80,5,'west','torch'),{wallTorch:await block(5,80,5,'wall_torch')});
  // Body overlapping the destination: the refusal states the body box.
  await at(8.1,80,6.5,0,60);await hold('cobblestone');
  results.bodyOverlap=keep(await place(7,80,6,'up','cobblestone'));
  // Eye inside the upper half of tall grass: the crosshair meets the grass before the floor face.
  await command('fill 10 79 -2 14 79 2 minecraft:grass_block');
  await command('setblock 11 80 0 minecraft:tall_grass[half=lower]');await command('setblock 11 81 0 minecraft:tall_grass[half=upper]');
  await at(11.5,80,0.5,-90,40);await hold('cobblestone');
  results.eyeInGrass=keep(await place(12,80,0,'up','cobblestone'),{placed:await block(12,80,0,'cobblestone')});
  await writeFile(join(out,'place.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
  const checks={
    awayFromEyePrecise:results.awayFromEye.reasonCode==='NO_PLACEMENT_SUPPORT'&&!results.awayFromEye.placed
      &&/requestedFaceView=the west face of 1,80,0 faces away from your eye: it lies at x=1\.00 and your eye x=1\.50 must be west of x=1\.00/.test(results.awayFromEye.message),
    fromEdgePlaces:results.fromEdge.state==='SUCCEEDED'&&results.fromEdge.placed&&/used face=west support=1,80,0/.test(results.fromEdge.message),
    wallTorchSucceeds:results.wallTorch.state==='SUCCEEDED'&&results.wallTorch.wallTorch,
    bodyBoxStated:results.bodyOverlap.cause==='BODY_IN_DESTINATION'&&/body x 7\.80\.\.8\.40 y 80\.00\.\.81\.80/.test(results.bodyOverlap.message),
    eyeInGrassNamed:!results.eyeInGrass.placed&&/first meets minecraft:tall_grass at 11,81,0 \(your eye is inside it\)/.test(results.eyeInGrass.message),
  };
  await writeFile(join(out,'checks.json'),JSON.stringify(checks,null,2));
  console.log(JSON.stringify(checks,null,2));
  if(!Object.values(checks).every(Boolean))throw new Error('place face live check failed');
  console.log('Place face live check passed');
} finally {
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
