#!/usr/bin/env node
// Provider-free body parity fixtures through the real action bridge; --candidate checks opt-in combat options.
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build/reset fixtures only.
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const out=resolve(process.argv[2] ?? 'runtime/routines/live');
const template=process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
const jar=process.env.NETHERBODY_JAR ?? join(root,'build/libs/arena-agents-0.2.0.jar');
if(!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const port=Number(process.argv[process.argv.indexOf('--port-base')+1]), server=join(out,'server');
if(port!==Number(process.env.SLOT_PORT_BASE))throw new Error('Use --port-base $SLOT_PORT_BASE');
await mkdir(out,{recursive:true});
if((await readdir(out)).length)throw new Error('Use a fresh output directory');
const reference=await readFile(fileURLToPath(import.meta.url),'utf8');
await writeFile(join(out,'fixture-source.mjs'),reference);
await writeFile(join(out,'manifest.json'),JSON.stringify({kind:'provider-free live mechanics',aiPerformanceMeasured:false,fixtureSetupUsesOperatorCommands:true,referenceSha256:createHash('sha256').update(reference).digest('hex'),jarSha256:createHash('sha256').update(await readFile(jar)).digest('hex'),node:process.version},null,2));
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
const agent='Netherbody';
const results=[];
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
async function reset(dim,x,y,z){
  await command(`gamemode spectator ${agent}`);
  await command('difficulty peaceful');await sleep(150);
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
  bridge.on('observation',e=>{if(e.agentId===record?.agentId&&e.payload.ready){observation=e.payload}});
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
  await bridge.send('agent_ready',record.agentId,{goalRevision:record.goalRevision,reconciled:false});
  await command('gamerule minecraft:do_mob_spawning false');
  await command('gamerule minecraft:natural_health_regeneration false');
  await command('difficulty normal');
  await command('player Vanilla spawn at 0.5 80 0.5 facing -90 0 in minecraft:overworld in survival');
  async function act(type,args){return executeAction({actionId:`body-${++ordinal}`,action:{type,arguments:args},provenance:{traceId:`body-${ordinal}`,programId:"netherbody-fixture",programVersion:1,stepId:`step-${ordinal}`,eventSequence:observation.eventSequence}});}
  async function save(name,data){results.push({name,...data});await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({name,reason:data.result?.reasonCode,pos:data.pos,position:data.after?.position}));}
  const candidate=process.argv.includes('--candidate');
  async function setup(x=0,z=0){
    await reset('minecraft:overworld',x,80,z);
    await command('difficulty normal');
    await command('tp Vanilla -3 80 -3');
    await command(`fill ${x-4} 79 ${z-4} ${x+10} 79 ${z+4} minecraft:nether_bricks`);
    await command(`gamemode survival ${agent}`);await sleep(300);await observe();
  }
  for(let repeat=0;repeat<3;repeat++){
    for(const [name,offset,item] of [['adjacent',0.5,'cobblestone'],['overlap',0.85,'cobblestone'],['slab-clear',0.85,'oak_slab']]){
      await setup();if(name==='slab-clear')await command(`tp ${agent} 0.85 80.5 0.5 -90 45`);
      else await command(`tp ${agent} ${offset} 80 0.5 -90 45`);
      if(name==='slab-clear')await command('setblock 0 80 0 minecraft:oak_slab');
      await command(`give ${agent} minecraft:${item} 8`);await act('select_item',{itemId:`minecraft:${item}`});await sleep(200);
      const before=await observe();
      const result=await act('place_block',{x:1,y:80,z:0,face:'up',faceMode:'strict',itemId:`minecraft:${item}`});
      await save(`${name}-${repeat}`,{result,before,after:await observe()});
    }
    // Bridge from the block beneath the player's feet: lean over its edge to expose the side.
    await setup();await command('fill -4 79 -4 10 79 4 minecraft:air');await command('setblock 0 79 0 minecraft:nether_bricks');
    await command(`tp ${agent} 1.15 80 0.5 90 70`);await sleep(100);
    await save(`underfoot-side-${repeat}`,{before:await observe(),result:await act('place_block',{x:1,y:79,z:0,face:'east',faceMode:'strict',itemId:'minecraft:cobblestone'}),after:await observe()});
    for(const sneak of [false,true]){
      await setup();await command('fill 1 79 -4 10 79 4 minecraft:air');
      const result=await act('control',{forward:1,strafe:0,jump:false,sneak,sprint:false,attack:false,use:false,yaw:-90,pitch:0,selectedSlot:0,hand:'main',ticks:35});
      await save(`walk-edge-${sneak}-${repeat}`,{result,after:await observe()});
    }
    for(const mode of ['fight','control','vanilla'])for(const sneak of [false,true]){
      await setup();await command('fill 1 79 -4 10 79 4 minecraft:air');
      await command('summon minecraft:zombie -1.5 80 0.5 {NoAI:1b,Silent:1b,PersistenceRequired:1b,Tags:["body-attacker"]}');
      await command(`execute as ${agent} at @s run tp @s ~ ~ ~ 90 0`);await sleep(250);
      const target=(await observe()).entities.find(e=>e.type==='minecraft:zombie');
      if(!target)throw new Error('missing zombie');
      const who=mode==='vanilla'?'Vanilla':agent;
      if(mode==='vanilla'){await command('player Vanilla kill');await command('player Vanilla spawn at 0.85 80 0.5 facing 90 0 in minecraft:overworld in survival');
        // A fresh vanilla player has a 60-tick respawn damage grace period. Let it expire before the hit.
        await sleep(4500);}
      await command(`tp ${who} 0.85 80 0.5 90 0`);
      let running,stance;
      if(mode==='vanilla'){await command(`tp ${agent} -3.5 80 3.5 90 0`);stance=await command(`player Vanilla ${sneak?'sneak':'unsneak'}`);}
      else if(mode==='control')running=act('control',{forward:0,strafe:0,jump:false,sneak,sprint:false,attack:false,use:false,yaw:90,pitch:0,selectedSlot:0,hand:'main',ticks:35});
      else running=act('fight_target',{targetId:target.uuid,pursue:false,timeoutMs:1800,...(candidate?{sneak}: {})});
      await sleep(450);const before=await observe();
      const damage=await command(`damage ${who} 1 minecraft:mob_attack by @e[tag=body-attacker,limit=1]`);
      await sleep(650);const pos=await command(`data get entity ${who} Pos`);const during=await observe();
      const result=await running;await save(`knockback-${mode}-${sneak}-${repeat}`,{damage,stance,pos,before,during,result,after:await observe()});
    }
    for(const shield of [false,true]){
      await setup();await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
      await command('summon minecraft:zombie 2.5 80 0.5 {NoAI:1b,Silent:1b,PersistenceRequired:1b,Tags:["body-attacker"],Health:100f,attributes:[{id:"minecraft:max_health",base:100.0}]}');
      const target=(await observe()).entities.find(e=>e.type==='minecraft:zombie');
      if(!target)throw new Error('missing zombie');
      const start=Date.now();const samples=[];
      const running=act('fight_target',{targetId:target.uuid,pursue:false,timeoutMs:3500,...(candidate?{sneak:true,shield}: {})});
      for(let j=0;j<12;j++){await sleep(200);samples.push({ms:Date.now()-start,observation:await observe()});if(j===3)await command(`damage ${agent} 3 minecraft:mob_attack by @e[tag=body-attacker,limit=1]`);}
      await save(`shield-fight-${shield}-${repeat}`,{samples,result:await running,after:await observe(),targetHealth:await command(`data get entity ${target.uuid} Health`)});
    }
    await setup();await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
    const running=act('control',{forward:0,strafe:0,jump:false,sneak:true,sprint:false,attack:false,use:true,yaw:-90,pitch:0,selectedSlot:0,hand:'off',ticks:30});
    await sleep(500);await save(`shield-control-sneak-${repeat}`,{during:await observe(),result:await running,after:await observe()});
    if(candidate){
      await setup();await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
      await command('summon minecraft:zombie 4.5 80 0.5 {NoAI:1b}');await sleep(200);
      const target=(await observe()).entities.find(e=>e.type==='minecraft:zombie');
      const running=act('fight_target',{targetId:target.uuid,pursue:false,sneak:true,shield:true,timeoutMs:10000});
      const actionId=`body-${ordinal}`;await sleep(500);const during=await observe();
      await bridge.send('action_cancel',record.agentId,{actionId,goalRevision:record.goalRevision});
      await save(`cancel-shield-${repeat}`,{during,result:await running,after:await observe()});
      await command(`item replace entity ${agent} weapon.offhand with minecraft:air`);
      await save(`missing-shield-${repeat}`,{result:await act('fight_target',{targetId:target.uuid,pursue:false,shield:true,timeoutMs:1000}),after:await observe()});
    }
    // Fireballs at head height distinguish a real two-block screen from a foot-height block.
    for(const height of [0,1,2]){
      await setup();
      for(let y=80;y<80+height;y++)await act('place_block',{x:1,y,z:0,face:'up',faceMode:'strict',itemId:'minecraft:cobblestone'});
      const before=await observe();
      const shot=await command('summon minecraft:small_fireball 5.5 81.2 0.5 {Motion:[-0.5d,0.0d,0.0d]}');
      await sleep(1200);await save(`fireball-cover-${height}-${repeat}`,{shot,before,after:await observe()});
      await command('kill @e[type=minecraft:small_fireball]');
      await command('setblock 0 80 0 minecraft:water');await command(`tp ${agent} 0.5 80 0.5 -90 0`);await sleep(200);
    }
    await setup();
    for(const y of [80,81])await act('place_block',{x:1,y,z:0,face:'up',faceMode:'strict',itemId:'minecraft:cobblestone'});
    await command('summon minecraft:zombie -1.5 80 0.5 {NoAI:1b,Tags:["body-attacker"]}');
    await command(`execute as ${agent} at @s run tp @s ~ ~ ~ 90 0`);await sleep(300);
    const before=await observe();
    await command(`damage ${agent} 1 minecraft:mob_attack by @e[tag=body-attacker,limit=1]`);
    await sleep(900);await save(`backstop-${repeat}`,{before,after:await observe()});
  }
  await command('player Vanilla kill');
  const failures=[];
  const check=(ok,name)=>{if(!ok)failures.push(name);};
  for(const r of results){
    const name=r.name;
    if(/^(adjacent|slab-clear|underfoot-side)-/.test(name))check(r.result.reasonCode==='BLOCK_PLACED',name);
    if(name.startsWith('overlap-')){
      check(r.result.causeCode==='BODY_IN_DESTINATION'||r.result.message.includes('BODY_IN_DESTINATION'),name);
      const support=r.before.blocks.find(b=>b.x===1&&b.y===79&&b.z===0);
      check(support && support.placeableFaces.includes('up')===!candidate,name+' fact');
    }
    if(name.startsWith('slab-clear-')||name.startsWith('adjacent-'))check(r.before.blocks.find(b=>b.x===1&&b.y===79&&b.z===0)?.placeableFaces.includes('up'),name+' fact');
    if(name.startsWith('walk-edge-true'))check(r.after.position.y===80,name);
    if(name.startsWith('walk-edge-false'))check(r.after.position.y<79,name);
    if(name.startsWith('knockback-')){
      const xyz=r.pos.match(/\[([^\]]+)\]/)?.[1].split(',').map(v=>Number(v.trim().replace(/d$/,'')));
      check(xyz&&xyz[0]>1.3&&xyz[1]<79,name);
      if(candidate&&name.startsWith('knockback-fight-true'))check(r.before.interaction.input.sneak&&r.before.player.crouching,name+' crouch');
    }
    if(name.startsWith('shield-fight-')){
      const enabled=candidate&&name.startsWith('shield-fight-true');
      check(r.samples.some(s=>s.observation.interaction.usingItem)===enabled,name+' shield');
      check(!r.after.interaction.usingItem&&!r.after.interaction.input.sneak,name+' release');
      check(r.result.message.includes('hits 0')===false,name+' attacks');
      check(Math.min(...r.samples.map(s=>s.observation.player.health))===(enabled?20:17),name+' protection');
    }
    if(name.startsWith('cancel-shield-'))check(r.during.interaction.usingItem&&r.during.player.crouching&&r.result.state==='CANCELLED'&&!r.after.interaction.usingItem&&!r.after.interaction.input.sneak,name);
    if(name.startsWith('missing-shield-'))check(r.result.reasonCode==='SHIELD_NOT_EQUIPPED',name);
    if(name.startsWith('shield-control-sneak-'))check(r.during.interaction.usingItem&&r.during.player.crouching&&!r.after.interaction.usingItem,name);
    if(name.startsWith('fireball-cover-'))check(name.startsWith('fireball-cover-2')?r.after.player.health===20:r.after.player.health<20,name);
    if(name.startsWith('backstop-'))check(r.after.position.y===80&&r.after.position.x<0.71,name);
  }
  await writeFile(join(out,'verdict.json'),JSON.stringify({candidate,checks:results.length,failures},null,2));
  if(failures.length)throw new Error(`Fixture failures: ${failures.join(', ')}`);
} finally {
  if(rcon)await command('stop').catch(()=>{});
  bridge?.stop();await rcon?.close();
  await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);if(child.exitCode===null)child.kill('SIGTERM');await log.close();
}
