import { boot } from '../../scripts/quality/watch-replay.mjs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const [checkpointDir,outRoot,jar]=process.argv.slice(2);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const seed of ['123456789','8675309','987654321','20261024']) {
 const cp=JSON.parse(await readFile(path.join(checkpointDir,`9-nether-entry-${seed}-v2.json`),'utf8'));
 const out=path.join(outRoot,seed);await mkdir(out,{recursive:true});if((await readdir(out)).length)throw Error('Use a fresh survey output directory');
 const s=await boot(out,{jar,template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:Number(process.env.SLOT_PORT_BASE),world:null,seed});
 try {
  const [px,py,pz]=cp.setup.position.map(Math.floor),dim='minecraft:the_nether';
  await s.command(`execute in ${dim} run forceload add ${px-112} ${pz-112} ${px+112} ${pz+112}`);
  await sleep(12000);
  const loaded=await s.command(`execute in ${dim} if loaded ${px} ${py} ${pz} run time query gametime`);
  if(!/time is \d+/i.test(loaded))throw Error('Portal fixture chunk did not load');
  const fixture=[];
  for(const c of cp.setup.commands.filter(c=>c.startsWith(`execute in ${dim}`))){
   const response=await s.command(c);
   if(/not loaded|incorrect|unknown|failed/i.test(response))throw Error(`Fixture placement failed: ${response}`);
   fixture.push({command:c,response});
  }
  const locate=await s.command(`execute in ${dim} positioned ${px} ${py} ${pz} run locate structure minecraft:bastion_remnant`);
  const m=locate.match(/\[(-?\d+),[^,]*,\s*(-?\d+)\]/);if(!m)throw Error(locate);
  const [x,z]=m.slice(1).map(Number);
  await s.command(`execute in ${dim} run forceload add ${px-112} ${pz-112} ${px+112} ${pz+112}`);
  await sleep(12000);await s.command('save-all flush');
  await s.command(`execute in ${dim} run forceload remove all`);
  await s.command(`execute in ${dim} run forceload add ${x-96} ${z-96} ${x+96} ${z+96}`);
  await sleep(12000);await s.command('save-all flush');
  const result={seed,portal:cp.setup.position,locate,bastion:[x,z],forceloadRadii:{portal:112,bastion:96},operatorOnly:true,fixture};
  await writeFile(path.join(out,'survey.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await s.stop();}
}
