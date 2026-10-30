import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {parseArenaScript} from '../src/arena-script/parser.mjs';
import {ArenaScriptEngine} from '../src/arena-script/program-engine.mjs';
import {minecraftCapabilities,normalizeMinecraftToolCall} from '../src/native-minecraft-tools.mjs';

const reference=readFileSync(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/references/routine-examples.md',import.meta.url),'utf8');
const fixture=readFileSync(new URL('./fixtures/routine-programs.md',import.meta.url),'utf8');
const examples=Object.fromEntries([...fixture.matchAll(/```js routine-(\w+)\n([\s\S]*?)```/g)].map(m=>[m[1],m[2]]));
test('mechanics topic is fully retrievable and exposes facts without stored programs',()=>{
  let actual='',offset=0;
  do {const args={section:'control',topic:'routines',offset};assert.deepEqual(normalizeMinecraftToolCall('capabilities',args),{kind:'capabilities',...args});const page=minecraftCapabilities(args);assert.ok(Buffer.byteLength(JSON.stringify(page))<=15000);actual+=page.reference;offset=page.nextOffset;}while(offset!==undefined);
  assert.equal(actual,reference);
  assert.doesNotMatch(actual,/```|runProgram\.source|program\.onUnhandledAttention/);
  assert.match(actual,/10 obsidian/);
  assert.match(actual,/Write programs live/);
});
test('historical test fixture programs still compile',()=>{
  for(const name of ['portal','pillar','bridge','blaze'])assert.doesNotThrow(()=>parseArenaScript(examples.common+examples[name]),name);
});
test('historical test fixture guard hands back before exposed work on initial danger',()=>{
  for(const name of ['portal','pillar','bridge','blaze'])for(const hazard of [{health:4},{health:20,fire:true},{health:20,inLava:true},{health:20,underWater:true,airSecondsLeft:2},{health:20,suffocating:true},{health:20,threat:{uuid:'other'}}]){
    const actions=[],requests=[];
    const engine=new ArenaScriptEngine({dispatch:c=>actions.push(c),cancel(){},requestModel:r=>requests.push(r)});
    engine.install({agentId:'routine-test',goalRevision:1,modelIdentity:'test',programId:'routine',version:1,compiled:parseArenaScript(examples.common+examples[name]),parameters:{minHealth:10,minAir:10,allowedThreat:null,placeWater:true,waterStand:{x:0,y:64,z:0},height:1,base:{x:0,y:64,z:0},dx:1,dz:0,length:1,nether:false,start:{x:0,y:63,z:0},supportId:'minecraft:stone',targetId:'target',ranged:false,weaponId:'minecraft:iron_sword',cover:{x:0,y:64,z:0}},observation:{player:{x:0,y:64,z:0,health:20,threat:null,fire:false,inLava:false,suffocating:false,underWater:false,airSecondsLeft:15,...hazard},inventory:{items:[{itemId:'minecraft:iron_sword',count:1,slot:0}],selectedSlot:0},world:{dimension:'minecraft:overworld'},entities:[{stableId:'target',type:'minecraft:blaze',x:2,y:64,z:0}],blocks:[]},eventSequence:1});
    assert.equal(actions.length,0,`${name} ${JSON.stringify(hazard)}`);
    assert.equal(requests.length,1);
  }
});
test('bridge returns a changed support to the model before stepping toward the gap',()=>{
  const actions=[],queries=[];
  const engine=new ArenaScriptEngine({dispatch:c=>actions.push(c),cancel(){},requestModel(){},inspect:q=>queries.push(q)});
  const observation={player:{x:0.5,y:64,z:0.5,health:20,threat:null,fire:false,inLava:false,suffocating:false,underWater:false},inventory:{items:[]},entities:[],blocks:[]};
  engine.install({agentId:'routine-test',goalRevision:1,modelIdentity:'test',programId:'routine',version:1,compiled:parseArenaScript(examples.common+examples.bridge),parameters:{minHealth:10,minAir:10,allowedThreat:null,dx:1,dz:0,length:2,nether:false,start:{x:0,y:63,z:0},supportId:'minecraft:stone'},observation,eventSequence:1});
  assert.equal(actions[0].action.type,'look_at');
  engine.ingestActionResult({actionId:actions[0].actionId,state:'SUCCEEDED',reasonCode:'LOOKED',eventSequence:1});
  engine.ingestObservation({observation,eventSequence:2});
  engine.ingestQueryResult({queryId:queries[0].queryId,value:{state:'SUCCEEDED',reasonCode:'INSPECTED',block:{x:0,y:63,z:0,blockId:'minecraft:lava'}}});
  assert.equal(engine.snapshot().status,'PAUSED');
  assert.equal(actions.length,1);
});
