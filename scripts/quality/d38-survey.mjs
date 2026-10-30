import {boot} from './watch-replay.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {applyQualitySetup} from '../../coordinator/src/benchmark/quality-scenarios.mjs';
const base='/home/agaminggod/Desktop/Projects/arena-beat-game';
const out=process.argv[2];await mkdir(out,{recursive:true});
const results={};
for(const seed of ['20261009','-8891462362762682724','20261024','8675309','123456789','987654321']){
 const dir=out+'/'+seed;await mkdir(dir,{recursive:true});
 const s=await boot(dir,{jar:base+'/jars/d25-bb227cbc.jar',template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:Number(process.env.SLOT_PORT_BASE),seed});
 try{
 const reg=s.inbox.wait('agent_registered',()=>true,60000);await s.command('execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low Probe');const e=await reg;s.record={...(e.payload.record??e.payload),agentId:e.agentId};
 const cmd=async text=>({text:await s.command(text)});
 await s.command('gamemode spectator Probe');
 const r={heights:{}};
 const points=seed==='20261009'?[[118,688],[548,501],[327,2554]]:seed==='-8891462362762682724'?[[17,108],[89,64],[74,143],[-1,98],[-14,95]]:[[4,1]];
 if(seed==='20261009'){
  for(const name of ['4-stronghold-search','5-stronghold']){
   const d=JSON.parse(await readFile(base+'/long/checkpoints/'+name+'.json','utf8'));
   const receipt=await applyQualitySetup(d.setup,cmd,'Probe');
   r[name]={pos:receipt.initial.Pos,location:receipt.definition.locationTarget};
   if(name==='5-stronghold'){const a=receipt.initial.Pos.match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/).slice(1).map(Number);points.push([Math.floor(a[0])+4,Math.floor(a[2])+1]);r['5-shaft']=[Math.floor(a[0])+4,Math.floor(a[2])+1];}
   await s.command('tick unfreeze');await s.command('gamemode spectator Probe');
  }
 }
 for(const [x,z] of points){
  await s.command(`execute in minecraft:overworld run forceload add ${x} ${z}`);for(let i=0;i<100;i++){if(/time is \d+/i.test(await s.command(`execute in minecraft:overworld if loaded ${x} 100 ${z} run time query gametime`)))break;await new Promise(r=>setTimeout(r,200));}
  await s.command(`execute in minecraft:overworld positioned ${x+.5} 0 ${z+.5} positioned over motion_blocking_no_leaves run tp Probe ~ ~ ~`);
  const text=await s.command('data get entity Probe Pos');r.heights[`${x},${z}`]=text;
 }
 if(r['5-shaft'])r['5-surface']=Number(r.heights[r['5-shaft'].join(',')].match(/,\s*(-?[\d.]+)d?,/)[1]);
 results[seed]=r;await writeFile(out+'/survey.json',JSON.stringify(results,null,2));console.log(seed,JSON.stringify(r));
 }finally{await s.stop();}
}
