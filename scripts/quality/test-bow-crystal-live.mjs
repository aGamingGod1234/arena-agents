#!/usr/bin/env node
// Provider-free check of use_ranged against stationary end crystals: hit rate of default (no aim field) shots on crystals
// 20-45 blocks away and 10-35 blocks up, a crystal behind the archer, and a crystal caged in iron bars.
// End runs 2026-10-20 hand-aimed 40-52 shots per game. ARENA_JAR overrides the jar (old vs new comparison).
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const jarPath=resolve(process.env.ARENA_JAR ?? join(root,'build/libs/arena-agents-0.2.0.jar'));
const out=resolve(process.argv[2] ?? 'runtime/bow-crystal-live');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if(!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port=Number(process.env.SLOT_PORT_BASE), server=join(out,'server');
await mkdir(out,{recursive:true});
if((await readdir(out)).length)throw new Error('Use a fresh output directory');
await writeFile(join(out,'manifest.json'),JSON.stringify({kind:'provider-free live mechanics',aiPerformanceMeasured:false,fixtureSetupUsesOperatorCommands:true,jarSha256:createHash('sha256').update(await readFile(jarPath)).digest('hex'),node:process.version},null,2));
await cp(template,server,{recursive:true});
for(const name of await readdir(join(server,'mods'))) if(name.startsWith('arena-agents-')) {
  const {unlink}=await import('node:fs/promises'); await unlink(join(server,'mods',name));
}
await cp(jarPath,join(server,'mods/arena-agents-0.2.0.jar'));
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
const agent='Archer';
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
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free bow fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty peaceful');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');
  await command('forceload add -64 -64 64 64');await sleep(2000);
  await command('fill -50 79 -50 50 120 50 minecraft:air');await command('fill -3 80 -3 3 80 3 minecraft:stone');
  const registered=inbox.wait('agent_registered');console.log(await command(`execute positioned 0.5 81 0.5 run codex summon gpt-6.1-sol low ${agent}`));
  const e=await registered;record={...(e.payload.record??e.payload),agentId:e.agentId};
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  const started=inbox.wait('goal_control',e=>e.payload.operation==='start');await command(`codex start ${agent} Survive for 600 seconds.`);record.goalRevision=(await started).payload.goalRevision;
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  await command(`gamemode survival ${agent}`);
  await command(`effect give ${agent} minecraft:resistance 600 4 true`);
  await command(`item replace entity ${agent} weapon.mainhand with minecraft:bow`);
  await command(`give ${agent} minecraft:arrow 64`);
  async function act(type,args,eventSequence=observation.eventSequence){
    const id=`bow-${++ordinal}`;
    return executeAction({actionId:id,action:{type,arguments:args},provenance:{traceId:id,programId:'bow-fixture',stepId:id,eventSequence}});
  }
  const uuid=n=>`00000000-0000-0000-0000-${n.toString(16).padStart(12,'0')}`;
  const uuidInts=n=>`[I;0,0,0,${n}]`;
  let n=100;
  const face=async(x,y,z)=>{const dx=x-0.5,dz=z-0.5,dy=y+1-82.62;const yaw=Math.atan2(-dx,dz)*180/Math.PI;const pitch=-Math.atan2(dy,Math.hypot(dx,dz))*180/Math.PI;
    await command(`tp ${agent} 0.5 81 0.5 ${yaw.toFixed(1)} ${pitch.toFixed(1)}`);await sleep(500);};
  const crystal=async(x,y,z,id,pillar=true)=>{if(pillar)await command(`fill ${x} 80 ${z} ${x} ${y-1} ${z} minecraft:obsidian`);
    await command(`summon minecraft:end_crystal ${x+0.5} ${y} ${z+0.5} {ShowBottom:0b,UUID:${uuidInts(id)}}`);await sleep(300);};
  const shot=async(id,extra={})=>{
    // A ranged command names an entity from a delivered observation; wait until the crystal is in one.
    for(let i=0;i<10;i++){await sleep(300);const o=await observe();if((o.entities??[]).some(x=>x.uuid===uuid(id)))break;
      if(i===9)console.log('not observed',uuid(id),(o.entities??[]).map(x=>x.type+':'+x.uuid).join(' '));}
    return act('use_ranged',{targetId:uuid(id),drawDurationMs:1100,timeoutMs:6000,...extra});};
  const results={open:[],behind:null,caged:null,cagedAimed:null};
  // Open crystals in front, 20-45 blocks out and 10-35 up, as on End pillars seen from the island floor.
  const spots=[[20,95,0],[0,106,30],[-30,110,-15],[25,90,-35],[-40,100,20],[35,115,25],[-15,92,-40],[42,100,-5]];
  for(const [x,y,z] of spots){
    const id=++n; await crystal(x,y,z,id); await face(x,y,z);
    const r=await shot(id);
    const broke=r.state==='SUCCEEDED'&&/broke/.test(r.message)&&!/something else/.test(r.message);
    results.open.push({at:[x,y,z],state:r.state,reasonCode:r.reasonCode,broke,message:r.message});
    await command(`kill @e[type=minecraft:end_crystal]`);await command(`fill ${x} 80 ${z} ${x} ${y+3} ${z} minecraft:air`);await command('kill @e[type=minecraft:arrow]');
  }
  // A crystal behind the archer with a clear line: a player turns round to shoot it.
  { const id=++n; await crystal(0,95,-25,id); await face(0,95,-25);
    let seen=null; for(let i=0;i<10&&!seen;i++){await sleep(300);const o=await observe();if((o.entities??[]).some(x=>x.uuid===uuid(id)))seen=o.eventSequence;}
    // Seen a moment ago, then turned away: the bow turns back to it.
    await command(`tp ${agent} 0.5 81 0.5 0 0`); await sleep(500); await observe();
    const r=await act('use_ranged',{targetId:uuid(id),drawDurationMs:1100,timeoutMs:6000},seen??observation.eventSequence); results.behind={state:r.state,reasonCode:r.reasonCode,broke:/broke/.test(r.message??''),message:r.message};
    await command(`kill @e[type=minecraft:end_crystal]`);await command('fill 0 80 -25 0 98 -25 minecraft:air'); }
  // A crystal inside an iron-bar cage (walls two blocks out and a roof), like the two guarded End spikes.
  { const id=++n, x=-25, y=92, z=0;
    await command(`fill ${x-2} ${y-1} ${z-2} ${x+2} ${y+3} ${z+2} minecraft:iron_bars hollow`);await command(`fill ${x-2} ${y-1} ${z-2} ${x+2} ${y-1} ${z+2} minecraft:obsidian`);
    await crystal(x,y,z,id,false); await face(x,y,z);
    let r=await shot(id); results.caged={state:r.state,reasonCode:r.reasonCode,message:r.message};
    r=await shot(id,{aimX:x+0.5,aimY:y+4,aimZ:z+0.5}); results.cagedAimed={state:r.state,reasonCode:r.reasonCode,message:r.message}; }
  const hits=results.open.filter(x=>x.broke).length;
  results.summary={openHits:hits,openShots:results.open.length,jar:jarPath};
  await writeFile(join(out,'bow.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally {
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
