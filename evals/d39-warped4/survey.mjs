// Operator-only preparation. Locate responses and terrain probes never enter player memory.
import {boot,replayPort} from '../../scripts/quality/watch-replay.mjs';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const [checkpointDir,outRoot,jar]=process.argv.slice(2);
if(!process.env.SLOT_PORT_BASE)throw Error('Run under slot.sh live');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];
for(const [ordinal,seed] of ['123456789','8675309','987654321','20261024'].entries()){
 const cp=JSON.parse(await readFile(path.join(checkpointDir,`9-nether-entry-${seed}-v2.json`),'utf8'));
 const out=path.join(outRoot,seed);await mkdir(out,{recursive:true});if((await readdir(out)).length)throw Error('Fresh output required');
 const s=await boot(out,{jar,template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:replayPort(Number(process.env.SLOT_PORT_BASE),ordinal),world:null,seed});
 try{
  const dim='minecraft:the_nether';
  const locate=await s.command(`execute in ${dim} positioned ${cp.setup.position.join(' ')} run locate biome minecraft:warped_forest`);
  const match=locate.match(/\[(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/);if(!match)throw Error(`Locate failed: ${locate}`);
  const [x,y,z]=match.slice(1).map(Number);
  await s.command(`execute in ${dim} run forceload add ${x-64} ${z-64} ${x+64} ${z+64}`);
  for(let i=0;i<100;i++){
   if(/time is \d+/i.test(await s.command(`execute in ${dim} if loaded ${x} 64 ${z} run time query gametime`)))break;
   if(i===99)throw Error('CHUNK_NOT_READY');await sleep(250);
  }
  let position=null;
  const offsets=[[0,0],...Array.from({length:17},(_,a)=>Array.from({length:17},(_,b)=>[(a-8)*8,(b-8)*8])).flat().filter(([dx,dz])=>dx||dz).sort((a,b)=>Math.hypot(...a)-Math.hypot(...b))];
  search:for(const [dx,dz]of offsets)for(let sy=110;sy>=8;sy--){
   const at=[x+dx,sy,z+dz];
   const response=await s.command(`execute in ${dim} positioned ${at.join(' ')} if biome ~ ~ ~ minecraft:warped_forest if block ~ ~-1 ~ minecraft:warped_nylium if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air run time query gametime`);
   if(/time is \d+/i.test(response)){position=[at[0]+.5,sy,at[2]+.5];break search;}
  }
  if(!position)throw Error('NO_NATURAL_WARPED_STANDING_POINT');
  const save=structuredClone(cp);
  save.fixtureVersion=2;save.variantOf=`9-nether-entry-${seed}-v2.json`;
  save.milestone=`warped-forest-${seed}-v2`;
  save.source='Prepared natural warped-forest start; travel from the original portal is not measured.';
  save.setup.position=position;save.setup.expectedBiome='minecraft:warped_forest';
  // Keep the original return portal fixture loaded while preparing the distant start.
  for(const dx of [-8,8])for(const dz of [-8,8])save.setup.loadChunks.push({dimension:dim,position:[Math.floor(cp.setup.position[0])+dx,cp.setup.position[1],Math.floor(cp.setup.position[2])+dz]});
  save.setup.armour.head='minecraft:iron_helmet';
  save.setup.inventory=save.setup.inventory.filter(i=>!/^minecraft:(ender_pearl|ender_eye|golden_)/.test(i.item));
  save.notes=['Version 2: natural warped-forest floor, realistic unenchanted iron kit, shield, food and carried building blocks.','No shelter, mob, gold or pearl is placed at the forest start. Original portal and used Overworld bed camp remain.','Forest travel, route safety and repeated return trips remain unmeasured. No route or biome location is given to the model.','Gold is secondary supply: mine seen ore along travel and barter held currency when safe.'];
  await writeFile(path.join(out,'checkpoint.json'),JSON.stringify(save,null,2)+'\n');
  const row={seed,operatorOnly:true,portal:cp.setup.position,locate,located:[x,y,z],position,horizontalDistance:Math.hypot(position[0]-cp.setup.position[0],position[2]-cp.setup.position[2]),threeDimensionalDistance:Math.hypot(...position.map((v,i)=>v-cp.setup.position[i])),accessTravelMeasured:false,routeSafetyVerified:false};
  results.push(row);await writeFile(path.join(out,'survey.json'),JSON.stringify(row,null,2)+'\n');
  await writeFile(path.join(outRoot,'survey-results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(row));
 }finally{await s.stop();}
}
