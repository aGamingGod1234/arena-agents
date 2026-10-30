#!/usr/bin/env node
// Model-free verification of one checkpoint in a fresh disposable world. Launch under slot.sh live.
// node scripts/quality/test-savepoints-live.mjs CHECKPOINT OUT [JAR]
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {boot} from './watch-replay.mjs';
import {applyQualitySetup,activateQualitySetup} from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import {parseInventory,parseEquipment} from '../../coordinator/src/benchmark/checkpoint.mjs';
const [file,out,jar='/home/agaminggod/Desktop/Projects/arena-beat-game/jars/d25-bb227cbc.jar',mode]=process.argv.slice(2);
if(!file||!out||!process.env.SLOT_PORT_BASE)throw new Error('CHECKPOINT OUT [JAR], under slot.sh live');
await mkdir(out,{recursive:true});if((await readdir(out)).length)throw new Error('Use a fresh output directory');
const bytes=await readFile(file),cp=JSON.parse(bytes),AGENT='Probe',OW='minecraft:overworld',spawnControl=mode==='--spawn-control';
const r={checkpoint:path.basename(file),sha256:createHash('sha256').update(bytes).digest('hex'),seed:cp.seed,jar,modelCalls:0,startedAt:new Date().toISOString()};
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const number=text=>Number(String(text).match(/(?:entity data:\s*|time is |has )(-?\d+(?:\.\d+)?)/)?.[1]??String(text).match(/(-?\d+(?:\.\d+)?)[fdb]?\s*$/)?.[1]);
const pos=text=>String(text).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number);
let s;
try{
 s=await boot(out,{jar:path.resolve(jar),template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:Number(process.env.SLOT_PORT_BASE),seed:cp.seed,spawnMonsters:true});
 s.bridge.on('message',e=>{const revision=e.payload.goalRevision??e.payload.record?.goalRevision??e.payload.control?.goalRevision;if(s.record&&e.agentId===s.record.agentId&&Number.isInteger(revision))s.record.goalRevision=Math.max(s.record.goalRevision,revision);});
 const command=async text=>({text:await s.command(text)});
 const loaded=async (dim,x,z)=>{for(let i=0;i<100;i++){if(/time is \d+/i.test(await s.command(`execute in ${dim} if loaded ${x} 100 ${z} run time query gametime`)))return;await sleep(200);}throw new Error('Verification chunk did not load');};
 let e;
 for(let attempt=0;attempt<3&&!e;attempt++){
  const registered=s.inbox.wait('agent_registered',()=>true,45000).catch(()=>null);
  r.summon=await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
  e=await registered;
 }
 if(!e)throw new Error(`Agent never registered: ${r.summon}`);
 s.record={...(e.payload.record??e.payload),agentId:e.agentId};
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const started=s.inbox.wait('goal_control',g=>g.payload.operation==='start');await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);s.record.goalRevision=(await started).payload.goalRevision;
 await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
 const receipt=await applyQualitySetup({...cp.setup,randomSalt:380038},command,AGENT);
 await activateQualitySetup(receipt,command,{stage:'goal-start'});await activateQualitySetup(receipt,command,{stage:'first-decision'});
 await s.command('tick unfreeze');
 r.setup={pos:pos(await s.command(`data get entity ${AGENT} Pos`)),dimension:await s.command(`data get entity ${AGENT} Dimension`),bedReceipt:receipt.receipts.find(x=>x.command==='used bed respawn receipt')??null};
 const counts=items=>{const c={};for(const i of items)c[i.id]=(c[i.id]??0)+i.count;return c;};
 const expected=counts(cp.setup.inventory.map(i=>({id:i.item.replace(/\[.*$/,''),count:i.count??1})));
 const actual=counts(parseInventory(await s.command(`data get entity ${AGENT} Inventory`)));
 const equipment=parseEquipment(await s.command(`data get entity ${AGENT}`));
 r.kit={expected,actual,equipment,pass:Object.entries(expected).every(([k,v])=>(actual[k]??0)>=v)&&Object.entries(cp.setup.armour??{}).every(([slot,item])=>equipment[slot]?.id===item.replace(/\[.*$/,''))};
 if(cp.lavaPool){const [x,y,z]=cp.lavaPool.edge;r.naturalPool={sources:0};for(let dx=-3;dx<=0;dx++)for(let dz=-2;dz<=2;dz++){if(/time is \d+/i.test(await s.command(`execute in ${OW} if block ${x+dx} ${y} ${z+dz} minecraft:lava[level=0] run time query gametime`)))r.naturalPool.sources++;}if(r.naturalPool.sources<cp.lavaPool.minimumSources)throw new Error('Natural casting pool was damaged by camp preparation');}
 if(cp.endRecovery){r.endRecovery={bridgeBlocks:0,ladderBlocks:0};for(let x=48;x<=100;x++){const text=await s.command(`execute in minecraft:the_end unless block ${x} 48 0 minecraft:air if block ${x} 49 0 minecraft:air if block ${x} 50 0 minecraft:air run time query gametime`);if(x===48)continue;if(!/time is \d+/i.test(text))throw new Error('End arrival bridge is obstructed or missing');r.endRecovery.bridgeBlocks++;}for(let y=49;y<60;y++){if(!/time is \d+/i.test(await s.command(`execute in minecraft:the_end if block 48 ${y} 0 minecraft:ladder[facing=east] run time query gametime`)))throw new Error('End shelter surface ladder is missing');r.endRecovery.ladderBlocks++;}for(let x=54;x<=97;x++)for(const z of [-1,1])if(!/time is \d+/i.test(await s.command(`execute in minecraft:the_end if block ${x} 49 ${z} minecraft:end_stone run time query gametime`)))throw new Error('End bridge guard is missing');}
 if(cp.netherExit){const [x,y,z]=cp.netherExit;const text=await s.command(`execute in minecraft:the_nether if block ${x} ${y} ${z} minecraft:air if block ${x} ${y+1} ${z} minecraft:air unless block ${x} ${y-1} ${z} #minecraft:replaceable unless block ${x} ${y-1} ${z} minecraft:lava run time query gametime`);r.naturalExit={pass:/time is \d+/i.test(text),receipt:text};if(!r.naturalExit.pass)throw new Error('Nether shelter does not open onto natural standing ground');}

 if(cp.fixtureVersion===2&&cp.variantOf?.startsWith('6-')){
  const hazards=JSON.parse(await readFile(new URL('../../evals/d38-savepoints/portal-room-truth.json',import.meta.url),'utf8'));r.portalRoom={oldLavaCells:hazards.lava.length,oldSpawners:hazards.spawner.length,remaining:[]};
  for(const [type,positions] of Object.entries(hazards))for(const p of positions){const text=await s.command(`execute in ${OW} if block ${p.join(' ')} minecraft:${type} run time query gametime`);if(/time is \d+/i.test(text))r.portalRoom.remaining.push({type,position:p});}
  if(r.portalRoom.remaining.length)throw new Error('Portal-room lava or silverfish spawner remains');
 }
 r.safety={samples:[],wallMs:0,ticks:0};const begin=Date.now(),tick0=number(await s.command('time query gametime'));
 while(!spawnControl&&(Date.now()-begin<60000||r.safety.ticks<1200)){
  const health=number(await s.command(`data get entity ${AGENT} Health`));const deaths=number(await s.command(`scoreboard players get ${AGENT} qo_death`))||0;
  r.safety.samples.push({ms:Date.now()-begin,health,deaths,pos:pos(await s.command(`data get entity ${AGENT} Pos`))});
  if(!health||deaths)throw new Error('Unsafe start: body died during 60-second idle');
  r.safety.ticks=number(await s.command('time query gametime'))-tick0;if(Date.now()-begin>180000)throw new Error('Safety window did not advance 1200 ticks');await sleep(2000);
 }
 if(spawnControl){await sleep(5000);r.safety.skipped='Spawn-control baseline only';}
 r.safety.wallMs=Date.now()-begin;r.safety.minHealth=Math.min(...r.safety.samples.map(x=>x.health));r.safety.pass=r.safety.minHealth===20;
 if(cp.fixtureVersion===2&&/^(2b-|9-nether-entry-sol)/.test(path.basename(file))){
  const portals={};for(const c of cp.setup.commands){const m=c.match(/^execute in (minecraft:[a-z_]+) run fill (-?\d+) (-?\d+) (-?\d+) .* minecraft:nether_portal/);if(m)portals[m[1]]=m.slice(2,5).map(Number);}
  const NE='minecraft:the_nether',ow=portals[OW],ne=portals[NE];if(!ow||!ne)throw new Error('Missing linked portal pair');
  const arrive=async(dim,at)=>{for(let i=0;i<160;i++){if((await s.command(`data get entity ${AGENT} Dimension`)).includes(dim)){const actual=pos(await s.command(`data get entity ${AGENT} Pos`));if(actual&&Math.hypot(...actual.map((n,j)=>n-at[j]))<5)return actual;}await sleep(250);}throw new Error('Portal did not link to its prepared counterpart');};
  const cooldown=async()=>{for(let i=0;i<160;i++){const text=await s.command(`data get entity ${AGENT} PortalCooldown`);if(/Found no elements/i.test(text)||number(text)===0)return;await sleep(250);}throw new Error('Vanilla portal cooldown did not expire');};
  await cooldown();await s.command(`execute in ${NE} run tp ${AGENT} ${ne[0]+1.5} ${ne[1]} ${ne[2]+.5}`);
  r.portalRoundTrip={overworld:await arrive(OW,ow)};
  await s.command(`execute in ${OW} run tp ${AGENT} ${ow[0]+.5} ${ow[1]} ${ow[2]-.5}`);await cooldown();
  await s.command(`execute in ${OW} run tp ${AGENT} ${ow[0]+1.5} ${ow[1]} ${ow[2]+.5}`);
  r.portalRoundTrip.nether=await arrive(NE,ne);r.portalRoundTrip.health=number(await s.command(`data get entity ${AGENT} Health`));if(r.portalRoundTrip.health!==20)throw new Error('Portal round trip damaged the body');r.portalRoundTrip.pass=true;
  await s.command(`execute in ${NE} run tp ${AGENT} ${cp.setup.position.join(' ')}`);
 }
 const bed=cp.bedSpawn.position,[bx,by,bz]=bed;
 await s.command(`execute in ${OW} run forceload add ${bx} ${bz}`);await loaded(OW,bx,bz);
 r.respawnConfig=await s.command(`data get entity ${AGENT} respawn`);
 const respawn=async()=>{
  // Dimension changes and respawns give the fake vanilla client 60 game ticks of load immunity.
  // Under chunk-generation load, four wall seconds can contain fewer than 60 ticks.
  const loadTick=number(await s.command('time query gametime'));
  while(number(await s.command('time query gametime'))-loadTick<65)await sleep(250);
  const dead=s.inbox.wait('goal_control',g=>g.payload.operation==='dead',20000).catch(()=>null);
  await s.command(`kill ${AGENT}`);if(!(await dead))throw new Error('Death not captured');await sleep(1000);
  const action=await s.act('respawn',{});
  // The current body cancels its action receipt when respawn changes DEAD to STARTING.
  // Judge the actual new vanilla player and record that receipt, rather than treating it as a second death.
  await sleep(1500);
  await s.bridge.send('agent_ready',s.record.agentId,{goalRevision:s.record.goalRevision,reconciled:false});
  const health=number(await s.command(`data get entity ${AGENT} Health`));if(!(health>0))throw new Error('Respawn did not create a living body');
  return {pos:pos(await s.command(`data get entity ${AGENT} Pos`)),dimension:await s.command(`data get entity ${AGENT} Dimension`),health,action:action.state,reasonCode:action.reasonCode};
 };
 r.bedRespawn=await respawn();r.bedRespawn.pass=/overworld/.test(r.bedRespawn.dimension)&&r.bedRespawn.pos&&Math.hypot(r.bedRespawn.pos[0]-(bx+1),r.bedRespawn.pos[1]-by,r.bedRespawn.pos[2]-(bz+.5))<=3;
 const chest=await s.command(`execute in ${OW} run data get block ${bx-1} ${by} ${bz+1} Items`);
 const table=await s.command(`execute in ${OW} if block ${bx+2} ${by} ${bz-1} minecraft:crafting_table run time query gametime`);
 const chestItems=[...chest.matchAll(/\{[^{}]*\}/g)].map(m=>({id:m[0].match(/id: "([^"]+)"/)?.[1],count:Number(m[0].match(/count: (\d+)/)?.[1])}));
 r.spareKit={chest,table,pass:(cp.spareKit??[]).every(([id,count])=>chestItems.some(i=>i.id===`minecraft:${id}`&&i.count>=count))&&/time is \d+/i.test(table)};
 r.route={pass:true,kind:cp.recoveryRoute?.kind??'surface-camp',checks:0};
 const test=async text=>{const response=await s.command(text);r.route.checks++;if(!/time is \d+/i.test(response))throw new Error(`Route check failed: ${text}: ${response}`);};
 if(cp.recoveryRoute){
  const {bottom:[x,y,z],top:[,top]}=cp.recoveryRoute;
  for(let h=y;h<top;h++)await test(`execute in ${OW} if block ${x} ${h} ${z} minecraft:ladder[facing=west] if block ${x+1} ${h} ${z} minecraft:cobblestone run time query gametime`);
  await test(`execute in ${OW} if block ${x} ${top} ${z} minecraft:air if block ${x} ${top+1} ${z} minecraft:air run time query gametime`);
  for(let a=bx;a<x;a++)await test(`execute in ${OW} if block ${a} ${by} ${z} minecraft:air if block ${a} ${by+1} ${z} minecraft:air run time query gametime`);
  // Ascend the actual ladder with vanilla inputs in survival, after collecting no special recovery equipment.
  await s.command(`execute in ${OW} run tp ${AGENT} ${x+.5} ${by} ${z+.5} -90 0`);
  await s.command(`player ${AGENT} move forward`);
  const until=Date.now()+Math.max(30000,(top-by)*550);let at;
  while(Date.now()<until){at=pos(await s.command(`data get entity ${AGENT} Pos`));if(at?.[1]>=top-.3)break;await sleep(700);}
  await s.command(`player ${AGENT} stop`);r.route.climbedTo=at;r.route.pass=at?.[1]>=top-.3;
  if(!r.route.pass)throw new Error('Vanilla ladder ascent did not reach the surface');
 }
 // A distinctive, safe world spawn in the disposable copy proves fallback even for beds beside natural world spawn.
 await s.command(`execute in ${OW} run forceload add 4096 4096`);await loaded(OW,4096,4096);
 await s.command(`execute in ${OW} run fill 4092 299 4092 4100 299 4100 minecraft:cobblestone`);
 await s.command(`execute in ${OW} run fill 4092 300 4092 4100 319 4100 minecraft:air`);
 await s.command('setworldspawn 4096 300 4096');await s.command('gamerule minecraft:respawn_radius 0');
 await s.command(`execute in ${OW} run setblock ${bx} ${by} ${bz} minecraft:air`);await s.command(`execute in ${OW} run setblock ${bx+1} ${by} ${bz} minecraft:air`);
 await sleep(4000);r.brokenBedRespawn=await respawn();r.brokenBedRespawn.expectedWorldSpawn=[4096.5,300,4096.5];r.brokenBedRespawn.pass=/overworld/.test(r.brokenBedRespawn.dimension)&&r.brokenBedRespawn.pos&&Math.hypot(...r.brokenBedRespawn.pos.map((n,i)=>n-r.brokenBedRespawn.expectedWorldSpawn[i]))<3;
 r.pass=[r.kit,r.safety,r.spareKit,r.route,r.bedRespawn,r.brokenBedRespawn].every(x=>x.pass);
}catch(error){r.error=String(error.stack??error);r.pass=false;}finally{await s?.stop().catch(()=>{});}
r.finishedAt=new Date().toISOString();await writeFile(path.join(out,'result.json'),JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({checkpoint:r.checkpoint,pass:r.pass,error:r.error}));process.exitCode=r.pass?0:1;
