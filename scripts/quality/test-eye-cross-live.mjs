#!/usr/bin/env node
// Provider-free check of eye of ender bearings on seed 20261009 (ladder L-F1, 800 blocks east of the stronghold):
// two watched throws from spots 200 blocks apart must report a crossing within 30 blocks of /locate, and a throw
// facing away must report the eye lost from view with no travel length. Stronghold runs 2026-10-20 read 0.6-1.9 block
// glimpses as "anchor nearby" and dug 100-340 blocks short. ARENA_JAR overrides the jar (old vs new comparison).
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { presentEyeFlightWake } from '../../coordinator/src/eye-flight-presentation.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const jarPath=resolve(process.env.ARENA_JAR ?? join(root,'build/libs/arena-agents-0.2.0.jar'));
const out=resolve(process.argv[2] ?? 'runtime/eye-cross-live');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if(!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port=Number(process.env.SLOT_PORT_BASE), server=join(out,'server');
await mkdir(out,{recursive:true});
if((await readdir(out)).length)throw new Error('Use a fresh output directory');
await writeFile(join(out,'manifest.json'),JSON.stringify({kind:'provider-free live mechanics',aiPerformanceMeasured:false,fixtureSetupUsesOperatorCommands:true,jarSha256:createHash('sha256').update(await readFile(jarPath)).digest('hex'),node:process.version},null,2));
await cp(template,server,{recursive:true});
for(const name of await readdir(join(server,'mods'))) if(name.startsWith('arena-agents-')) await unlink(join(server,'mods',name));
await cp(jarPath,join(server,'mods/arena-agents-0.2.0.jar'));
const secret=randomBytes(32).toString('hex');
await writeFile(join(out,'secret.txt'),secret,{mode:0o600});
await writeFile(join(server,'server.properties'),`online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port+2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port+1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261009\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\n`);
const log=await open(join(out,'server.log'),'a');
const child=spawn(`${process.env.JAVA_HOME}/bin/java`,[`-Darenaagents.bridgePort=${port}`,'-Darenaagents.coordinatorAutoStart=false',`-Darenaagents.bridgeSecretFile=${join(out,'secret.txt')}`,'-Xms512M','-Xmx3G','-jar','fabric-server-launch.jar','nogui'],{cwd:server,stdio:['ignore',log.fd,log.fd]});
await writeFile(join(out,'server.pid'),String(child.pid));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Inbox {
  events=[]; waiters=[];
  constructor(bridge){bridge.on('message',e=>this.accept(e));bridge.on('ready',e=>this.accept({type:'ready',...e}));}
  accept(e){const i=this.waiters.findIndex(w=>w.type===e.type&&w.match(e));if(i>=0)this.waiters.splice(i,1)[0].done(e);else {this.events.push(e);if(this.events.length>1024)this.events.shift();}}
  wait(type,match=()=>true,ms=30000){const i=this.events.findIndex(e=>e.type===type&&match(e));if(i>=0)return Promise.resolve(this.events.splice(i,1)[0]);return new Promise((res,rej)=>{const w={type,match,done:e=>{clearTimeout(t);res(e)}};const t=setTimeout(()=>{this.waiters=this.waiters.filter(x=>x!==w);rej(new Error(`TIMEOUT ${type}`))},ms);this.waiters.push(w)});}
}
let rcon,bridge,record,observation,inbox,ordinal=0;
const agent='Seeker';
const command=async s=>{
  if(rcon.state==='closed'){rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,commandTimeoutMs:60000});await rcon.connect();}
  return (await rcon.command(s)).text;
};
async function observe(){const seq=observation?.eventSequence??0;const next=inbox.wait('observation',e=>e.agentId===record.agentId&&e.payload.ready&&e.payload.eventSequence>seq);await bridge.send('request_observation',record.agentId,{goalRevision:record.goalRevision});return (await next).payload;}
async function act(type,args){
  const id=`eye-${++ordinal}`;
  const payload={actionId:id,traceId:id,goalRevision:record.goalRevision,actionType:type,arguments:args,
    provenance:{provider:record.provider,model:record.model,reasoningEffort:record.reasoningEffort,serviceTier:record.serviceTier,traceId:id,programId:'eye-fixture',programVersion:1,sourceStepId:id,eventSequence:observation.eventSequence}};
  const next=inbox.wait('action_result',e=>e.payload.actionId===id&&['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(e.payload.state),65000);
  await bridge.send('action_command',record.agentId,payload);
  const r=(await next).payload;
  await bridge.send('action_result_ack',record.agentId,{actionId:id,goalRevision:record.goalRevision});
  return r;
}
const results={throws:[],stronghold:null};
try {
  for(let i=0;i<300;i++){try{rcon=new HeadlessRconClient({host:'127.0.0.1',port:port+1,password:secret,connectTimeoutMs:500,commandTimeoutMs:60000});await rcon.connect();break}catch(e){await rcon?.close();if(i===299)throw e;await sleep(1000)}}
  bridge=new MultiplexedServerBridge({port,secret},{});inbox=new Inbox(bridge);
  bridge.on('observation',e=>{if(e.agentId===record?.agentId&&e.payload.ready){observation=e.payload}});
  bridge.on('goal_spec_request',e=>{bridge.send('goal_spec_proposal',e.agentId,{requestId:e.payload.requestId,summary:'Controlled live mechanics fixture',predicate:{type:'survive_duration',ticks:12000}}).catch(()=>{});});
  const ready=inbox.wait('ready');bridge.start();await ready;
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free eye fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty peaceful');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');await command('weather clear');
  // Truth from the same locate the ladder setup uses (start = located stronghold + 800 east).
  const located=await command('execute in minecraft:overworld positioned 1048.5 64 2536.5 run locate structure minecraft:stronghold');
  const m=/\[(-?\d+), [^,]+, (-?\d+)\]/.exec(located); if(!m) throw new Error(`locate failed: ${located}`);
  results.stronghold={x:Number(m[1])+0.5,z:Number(m[2])+0.5,locate:located};
  // Throw spots: the L-F1 start, 200 blocks south of it, and the start again facing away from the flight.
  const spots=[{x:1048.5,z:2536.5,yaw:90,label:'start facing west'},{x:1048.5,z:2736.5,yaw:104,label:'200 south facing west-northwest'},{x:1048.5,z:2536.5,yaw:-90,label:'start facing east (away)'}];
  for(const s of spots) await command(`forceload add ${Math.floor(s.x)-48} ${Math.floor(s.z)-48} ${Math.floor(s.x)+48} ${Math.floor(s.z)+48}`);
  const registered=inbox.wait('agent_registered',()=>true,120000);
  console.log(await command(`execute in minecraft:overworld positioned ${spots[0].x} 200 ${spots[0].z} positioned over motion_blocking_no_leaves run codex summon gpt-6.1-sol low ${agent}`));
  const e=await registered;record={...(e.payload.record??e.payload),agentId:e.agentId};
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  const started=inbox.wait('goal_control',e=>e.payload.operation==='start');await command(`codex start ${agent} Survive for 600 seconds.`);record.goalRevision=(await started).payload.goalRevision;
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  await command(`gamemode survival ${agent}`);await command(`effect give ${agent} minecraft:resistance 600 4 true`);
  await command(`item replace entity ${agent} weapon.mainhand with minecraft:ender_eye 16`);
  for(const spot of spots){
    // A stone pad keeps every throw on dry footing whatever the biome.
    await command(`execute in minecraft:overworld positioned ${spot.x} 200 ${spot.z} positioned over motion_blocking_no_leaves run fill ~-1 ~-1 ~-1 ~1 ~-1 ~1 minecraft:stone`);
    await command(`execute in minecraft:overworld positioned ${spot.x} 200 ${spot.z} positioned over motion_blocking_no_leaves run tp ${agent} ~ ~ ~ ${spot.yaw} -10`);
    await sleep(1500); observation=await observe();
    const before=new Set((observation.perception?.events??[]).filter(x=>x.type==='eye_of_ender_flight').map(x=>x.flightId));
    const r=await act('use_item',{durationMs:250,mode:'once',expectedItemId:'minecraft:ender_eye'});
    await sleep(7000); observation=await observe();
    const flight=(observation.perception?.events??[]).filter(x=>x.type==='eye_of_ender_flight'&&!before.has(x.flightId)).at(-1)??null;
    const compact=flight?Object.entries(presentEyeFlightWake({world:observation.world,perception:{events:[flight]}})).find(([k])=>/^eye\d/.test(k))?.[1]??null:null;
    results.throws.push({spot,use:{state:r.state,reasonCode:r.reasonCode},flight,compact});
    console.log(spot.label,'->',compact??'no flight event');
    await command('kill @e[type=minecraft:item]');
  }
  const crossing=results.throws.map(t=>t.flight?.cross).find(Boolean);
  const error=crossing?Math.hypot(crossing.x-results.stronghold.x,crossing.z-results.stronghold.z):null;
  const away=results.throws[2]?.flight;
  results.summary={crossing,errorBlocks:error,crossWithin30:error!==null&&error<=30,
    // Facing away, a player sees nothing or a glimpse; a glimpse must not claim how far the eye flew.
    awayClaimsNoShortTravel:away==null||away.outcome!=='unseen'||(away.lostFromView===true&&away.flewBlocks===undefined),jar:jarPath};
  await writeFile(join(out,'eye-cross.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results.summary,null,2));
} finally {
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(15000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
