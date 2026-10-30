import test from 'node:test';
import assert from 'node:assert/strict';
import {pearlOptions,PEARL_OPTIONS_BYTES} from '../src/need-sources.mjs';
const position={x:0,y:65,z:0};
test('warped forest fight facts and hunting survive the bounded pearl line before secondary seen and held gold',()=>{
 const observation={world:{dimension:'minecraft:the_nether',biome:'minecraft:warped_forest'},blocks:[{x:4,y:65,z:0,blockId:'minecraft:nether_gold_ore'}],entities:[]};
 const known={blocks:observation.blocks,sightings:[{what:'bastion',kind:'structure',x:200,y:30,z:200}]};
 const fact=pearlOptions({observation,position,known,items:[{itemId:'minecraft:gold_ingot',count:2}]});
 assert.ok(Buffer.byteLength(fact)<=PEARL_OPTIONS_BYTES);
 assert.ok(fact.indexOf('standing in a warped forest')<fact.indexOf('seen gold:'));
 assert.ok(fact.indexOf('enderman fight: 40 health')<fact.indexOf('seen gold:'));
 assert.match(fact,/enderman fight: 40 health.*optional protection, not a prerequisite/);
 assert.doesNotMatch(fact,/look_away|from cover/);
 assert.match(fact,/seen gold: 0 blocks \+ 1 Nether ores/);assert.match(fact,/barter the 2 held gold/);
});
test('seen warped blocks provide a player lead, and an unseen forest has no invented location',()=>{
 const observation={world:{dimension:'minecraft:the_nether'},blocks:[],entities:[]};
 const found=pearlOptions({observation,position,known:{blocks:[{x:20,y:65,z:0,blockId:'minecraft:warped_nylium'}]}});
 assert.ok(found.indexOf('warped forest 20m')<found.indexOf('12 pearls by barter'));
 const unseen=pearlOptions({observation,position});assert.match(unseen,/find a warped forest through visible exploration/);assert.doesNotMatch(unseen,/warped forest .*@/);
});

test('a seen bastion cannot displace the primary forest route when no forest has been found',()=>{
 const observation={world:{dimension:'minecraft:the_nether'},blocks:[],entities:[]};
 const fact=pearlOptions({observation,position,known:{sightings:[{what:'bastion',kind:'structure',x:30,y:50,z:0}]},items:[{itemId:'minecraft:gold_ingot',count:2}]});
 assert.match(fact,/est\. options: primary Nether pearl route: find a warped forest through visible exploration/);
 assert.match(fact,/barter the 2 held gold/);assert.ok(fact.indexOf('primary Nether pearl route')<fact.indexOf('bastion 30m'));
});
