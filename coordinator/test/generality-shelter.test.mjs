import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleQualityShelter } from '../src/benchmark/quality-scenarios.mjs';

function fakeWorld() {
 const blocks=new Map(),queries=[];
 const set=(x,y,z,block)=>blocks.set(`${x},${y},${z}`,block);
 const command=async text=>{
  queries.push(text);
  assert.ok(Buffer.byteLength(text)<1400,'command fits Minecraft RCON receive buffer');
  assert.match(text,/^execute at Player (?:unless block .+ )+run time query gametime$/);
  const checks=[...text.matchAll(/unless block ~(-?\d+) ~(-?\d+) ~(-?\d+) (#[a-z_:]+(?:\[open=true\])?|minecraft:[a-z_]+)/g)];
  assert.ok(checks.length);
  const matched=checks.some(m=>{
   const actual=blocks.get(`${+m[1]},${+m[2]},${+m[3]}`)??'minecraft:air',expected=m[4];
   return actual===expected || expected==='#minecraft:leaves'&&/_leaves$/.test(actual)
    || expected==='#minecraft:replaceable'&&/(?:air|grass|fern|water|lava|snow)$/.test(actual)
    || expected==='#minecraft:flowers'&&/dandelion|poppy/.test(actual);
  });
  return {text:matched?'Test failed':'The time is 1000'};
 };
 return {set,command,queries};
}
function room(world,{minX=-1,maxX=1,minZ=-1,maxZ=1,height=3,block='minecraft:cobblestone',roof=block}={}) {
 for(let x=minX-1;x<=maxX+1;x++)for(let z=minZ-1;z<=maxZ+1;z++){
  world.set(x,-1,z,block);world.set(x,height,z,roof);
  if(x===minX-1||x===maxX+1||z===minZ-1||z===maxZ+1)for(let y=0;y<height;y++)world.set(x,y,z,block);
 }
}
test('leaf canopy is not shelter even with solid walls',async()=>{
 const world=fakeWorld();room(world,{roof:'minecraft:oak_leaves'});
 assert.equal(await sampleQualityShelter(world.command,'Player'),false);
});
test('one-cell box and three-high ordinary rooms are shelters',async()=>{
 for(const options of [{minX:0,maxX:0,minZ:0,maxZ:0,height:2},{height:3},{height:4}]){
  const world=fakeWorld();room(world,options);
  assert.equal(await sampleQualityShelter(world.command,'Player'),true,JSON.stringify(options));
 }
});
test('off-centre player and hillside materials do not require a centred 3x3 room',async()=>{
 for(const block of ['minecraft:andesite','minecraft:grass_block','minecraft:granite']){
  const world=fakeWorld();room(world,{minX:0,maxX:3,minZ:-1,maxZ:1,block});
  assert.equal(await sampleQualityShelter(world.command,'Player'),true,block);
 }
});
test('one ordinary doorway is allowed, but an open wall is not enclosure',async()=>{
 const world=fakeWorld();room(world);
 world.set(0,0,-2,'minecraft:air');world.set(0,1,-2,'minecraft:air');world.set(0,3,-2,'minecraft:air');
 assert.equal(await sampleQualityShelter(world.command,'Player'),true);
 world.set(1,0,-2,'minecraft:air');world.set(1,1,-2,'minecraft:air');world.set(1,3,-2,'minecraft:air');
 assert.equal(await sampleQualityShelter(world.command,'Player'),false);
});
test('natural overhang, fluid roof and plants cannot pass',async()=>{
 for(const block of ['minecraft:water','minecraft:lava','minecraft:dandelion']){
  const world=fakeWorld();room(world,{roof:block});
  assert.equal(await sampleQualityShelter(world.command,'Player'),false,block);
 }
 const world=fakeWorld();for(let x=-5;x<=5;x++)for(let z=-5;z<=5;z++){
  world.set(x,-1,z,'minecraft:stone');world.set(x,3,z,'minecraft:stone');
 }
 assert.equal(await sampleQualityShelter(world.command,'Player'),false);
});
test('flood fill has a finite room bound and samples only read-only blocks',async()=>{
 const world=fakeWorld();room(world,{minX:-12,maxX:12,minZ:-12,maxZ:12});
 assert.equal(await sampleQualityShelter(world.command,'Player'),false);
 assert.ok(world.queries.length<1000);
 assert.ok(world.queries.every(q=>q.endsWith('run time query gametime')));
});
test('a block predicate syntax failure is visible rather than silently making shelters unwinnable',async()=>{
 await assert.rejects(sampleQualityShelter(async()=>({text:'Unknown block tag minecraft:missing'}),'Player'),/QUALITY_SHELTER_SAMPLE/);
});
