// Evaluator-only natural Nether exits, matching Overworld surface camps, and structure truth.
import {boot} from './watch-replay.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const out=process.argv[2]??'/tmp/d38-savepoints-caves-v3';await mkdir(out,{recursive:true});const results={};
for(const seed of ['20261024','8675309','123456789','987654321']){
 const dir=out+'/'+seed;await mkdir(dir,{recursive:true});const s=await boot(dir,{jar:'/home/agaminggod/Desktop/Projects/arena-beat-game/jars/d25-bb227cbc.jar',template:process.env.ARENA_HEADLESS_SERVER_TEMPLATE,port:Number(process.env.SLOT_PORT_BASE),seed});
 try{
 const loaded=async(dim,x,z)=>{await s.command(`execute in ${dim} run forceload add ${x} ${z}`);for(let i=0;i<100;i++){if(/time is \d+/i.test(await s.command(`execute in ${dim} if loaded ${x} 64 ${z} run time query gametime`)))return;await new Promise(r=>setTimeout(r,200));}throw new Error('Chunk did not load');};
 let found;
 for(const [x,z] of [[-4,-2],[4,-2],[-4,6],[-12,-2],[-4,-10],[12,-2],[-4,14],[-20,-2],[-4,-18]]){
 await loaded('minecraft:the_nether',x,z);
 for(let y=110;y>=33;y--){
 const text=await s.command(`execute in minecraft:the_nether if block ${x} ${y} ${z} minecraft:air if block ${x} ${y+1} ${z} minecraft:air unless block ${x} ${y-1} ${z} #minecraft:replaceable unless block ${x} ${y-1} ${z} minecraft:lava unless block ${x} ${y-1} ${z} minecraft:magma_block run time query gametime`);
 if(/time is \d+/i.test(text)){found={portal:[x+4,y,z+2],exit:[x,y,z],receipt:text};break;}
 }if(found)break;
 }
 if(!found)throw new Error('No natural standing ground around entry on '+seed);
 const [nx,,nz]=found.portal,x=nx*8,z=nz*8;await loaded('minecraft:overworld',x+4,z+1);
 await s.command(`execute in minecraft:overworld run summon minecraft:marker ${x+4.5} 200 ${z+1.5} {Tags:["d38height"]}`);await new Promise(r=>setTimeout(r,150));
 await s.command(`execute in minecraft:overworld positioned ${x+4.5} 0 ${z+1.5} positioned over motion_blocking_no_leaves run tp @e[type=minecraft:marker,tag=d38height,limit=1] ~ ~ ~`);
 found.surfaceReceipt=await s.command('execute in minecraft:overworld run data get entity @e[type=minecraft:marker,tag=d38height,limit=1] Pos');
 const y=Number(found.surfaceReceipt.match(/,\s*(-?[\d.]+)d?,/)[1]);found.campBed=[x,y,z];
 found.structures={};for(const kind of ['fortress','bastion_remnant']){
 const receipt=await s.command(`execute in minecraft:the_nether positioned ${nx} 64 ${nz} run locate structure minecraft:${kind}`);const m=receipt.match(/\[(-?\d+), ~?(-?\d+|~), (-?\d+)\]/);if(!m)throw new Error('Locate failed: '+receipt);const sx=Number(m[1]),sz=Number(m[3]);found.structures[kind]={position:[sx,sz],distanceBlocks:Math.hypot(sx-nx,sz-nz),receipt};}
 results[seed]=found;await writeFile(out+'/survey.json',JSON.stringify(results,null,2));console.log(seed,JSON.stringify(found));
 }finally{await s.stop();}
}
