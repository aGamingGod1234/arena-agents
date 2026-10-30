import test from 'node:test';
import assert from 'node:assert/strict';
import { GOLD_SOURCE_BYTES, goldSourceFact } from '../src/gold-source-facts.mjs';
import { pearlOptions, PEARL_OPTIONS_BYTES } from '../src/need-sources.mjs';
const dimension='minecraft:the_nether', position={x:0,y:64,z:0};
const block=(x,y,z,blockId='minecraft:nether_gold_ore')=>({x,y,z,blockId});
const observe=blocks=>({world:{dimension},blocks});
test('a seen vein is deduplicated, priced as nuggets and separated from disconnected sightings',()=>{
 const rows=[block(2,64,0),block(3,64,0),block(9,64,0),block(9,65,0,'minecraft:gold_block')];
 const fact=goldSourceFact(observe(rows),{blocks:[rows[0]]},position);
 assert.match(fact,/1 blocks \+ 3 Nether ores \(~10.3 ingots/);
 assert.match(fact,/@2,64,0 dy\+0: 2 connected seen ores \(~0.9 ingots\)/);
 assert.match(fact,/Route\/clearance unverified; sightings may have changed/);
});
test('current visible air withdraws a remembered source without inventing buried neighbours',()=>{
 const known={blocks:[block(2,64,0),block(3,64,0)]};
 const fact=goldSourceFact(observe([block(2,64,0,'minecraft:air')]),known,position);
 assert.match(fact,/0 blocks \+ 1 Nether ores/);assert.match(fact,/@3,64,0.*1 connected/);
 assert.equal(goldSourceFact(observe([block(2,64,0,'minecraft:air')]),{blocks:[block(2,64,0)]},position),null);
});
test('unseen, audible-only, foreign-dimension and cached current rows cannot fund gold',()=>{
 const bad=[{...block(2,64,0),visible:false},{...block(3,64,0),perceivedBy:'sound'},{...block(4,64,0),dimension:'minecraft:overworld'}];
 assert.equal(goldSourceFact(observe([]),{blocks:bad},position),null);
 assert.equal(goldSourceFact({...observe([block(2,64,0)]),continuity:{rememberedSections:['blocks']}},null,position),null);
 assert.equal(goldSourceFact({blocks:[block(2,64,0)]},null,position),null);
});
test('a closed chest promises no gold and held gold is never counted as a seen block',()=>{
 assert.equal(goldSourceFact(observe([block(1,64,0,'minecraft:chest')]),null,position),null);
 const fact=pearlOptions({observation:observe([block(2,64,0)]),position,items:[{itemId:'minecraft:gold_ingot',count:2}]});
 assert.match(fact,/2 gold/);assert.match(fact,/0 blocks \+ 1 Nether ores \(~0.4 ingots/);assert.ok(Buffer.byteLength(fact)<=PEARL_OPTIONS_BYTES);
});
test('the fact stays in its reserved bytes at coordinate and memory limits',()=>{
 const rows=Array.from({length:1024},(_,i)=>block(-30000000+i,-2048,30000000,i%2?'minecraft:nether_gold_ore':'minecraft:gold_block'));
 const fact=goldSourceFact(observe([]),{blocks:rows},{x:30000000,y:2048,z:-30000000});
 assert.ok(Buffer.byteLength(fact)<=GOLD_SOURCE_BYTES);assert.equal(PEARL_OPTIONS_BYTES,720+GOLD_SOURCE_BYTES+2);
});
