#!/usr/bin/env node
// Provider-free check that fight_target kill results report the drops the player saw and whether one falls into lava
// (d3b-nether-b: a blaze shot down over the lava room dropped its rod into lava; the result said nothing).
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=resolve(process.argv[2] ?? 'runtime/kill-drops-live');
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
const agent='Drops';
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
  await bridge.send('catalog_snapshot','server',{refreshedAtEpochMs:Date.now(),models:[{provider:'codex',model:'gpt-6.1-sol',id:'gpt-6.1-sol',displayName:'Provider-free kill drops fixture',reasoningEfforts:['low'],serviceTiers:['priority']}]});
  await command('difficulty easy');await command('gamerule minecraft:send_command_feedback false');await command('time set noon');
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
    const id=`drops-${++ordinal}`;
    const r=await executeAction({actionId:id,action:{type,arguments:args},provenance:{traceId:id,programId:'drops-fixture',stepId:id,eventSequence:observation.eventSequence}});
    return r;
  }
  await command('fill -4 79 -4 8 79 8 minecraft:stone');
  await command(`effect give ${agent} minecraft:resistance 600 4 true`);
  await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
  const results={};
  const at=async(x,y,z,yaw,pitch)=>{await command(`tp ${agent} ${x} ${y} ${z} ${yaw} ${pitch}`);await sleep(600);await observe();};
  const uuid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
  const fight=async(n)=>{await sleep(400);await observe();return act('fight_target',{targetId:uuid(n),pursue:false,timeoutMs:8000});};
  // A: a chicken on the floor in front of the body; raw chicken is a guaranteed drop.
  await at(0.5,80,0.5,0,20);
  await command('summon minecraft:chicken 0.5 80 2.5 {NoAI:1b,UUID:[I;0,0,0,1]}');
  let r=await fight(1);
  results.floor={state:r.state,reasonCode:r.reasonCode,message:r.message};
  await command('kill @e[type=minecraft:item]');
  // B: the same kill over a lava pool: the drop falls into lava and burns.
  await command('fill 2 77 -1 4 79 1 minecraft:lava');
  await at(0.5,80,0.5,-90,0);
  await command('summon minecraft:chicken 3.0 80.4 0.5 {NoAI:1b,NoGravity:1b,UUID:[I;0,0,0,2]}');
  r=await fight(2);
  results.overLava={state:r.state,reasonCode:r.reasonCode,message:r.message};
  await command('fill 2 77 -1 4 79 1 minecraft:stone');await command('kill @e[type=minecraft:item]');
  // C: a blaze shot down over the floor: its rod (0-1 per player kill) is reported either way.
  await at(0.5,80,0.5,0,-10);
  await command('summon minecraft:blaze 0.5 80.5 2.5 {NoAI:1b,NoGravity:1b,Health:1f,UUID:[I;0,0,0,3]}');
  r=await fight(3);
  results.blaze={state:r.state,reasonCode:r.reasonCode,message:r.message};
  await writeFile(join(out,'drops.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
  const ok=results.floor.reasonCode==='TARGET_KILLED'&&/drops seen: .*minecraft:chicken at /.test(results.floor.message)&&!/burns/.test(results.floor.message)
    &&results.overLava.reasonCode==='TARGET_KILLED'&&/minecraft:chicken at [-\d]+,80,[-\d]+ \(over lava 1 below: burns\)/.test(results.overLava.message)
    &&results.blaze.reasonCode==='TARGET_KILLED'&&/drops seen: (1x minecraft:blaze_rod at |none from minecraft:blaze)/.test(results.blaze.message);
  if(!ok)throw new Error('kill drops live check failed');
  console.log('Kill drops live check passed');
} finally {
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
