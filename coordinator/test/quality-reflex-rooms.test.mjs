import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeQualitySetup} from '../src/benchmark/quality-scenarios.mjs';
import {LadderEvaluator,parseSuccessCheck} from '../../scripts/quality/ladder-evaluator.mjs';

const rooms=JSON.parse(await readFile(new URL('../../scripts/quality/reflex-rooms.json',import.meta.url),'utf8')).scenarios;
test('all nine reflex rooms have bounded budgets, supported setups and unmet starting predicates',()=>{
 assert.deepEqual(rooms.map(s=>s.id),['R-BLAZE','R-GHAST','R-CREEPER','R-SKELETON','R-FLOOD','R-VOID','R-TOOLBREAK','R-PIGLIN','R-GRAVEL']);
 for(const room of rooms){
  normalizeQualitySetup(room.setup);
  assert.ok(room.durationBudgetMs>=180000&&room.durationBudgetMs<=360000);
  assert.equal(room.runPolicy.continueAfterDeath,false);
  assert.equal(room.runPolicy.clock,'goal-start');
  const inventoryNbt=JSON.stringify(room.setup.inventory.map(({item,count})=>({id:item.split('[')[0],count})));
  const initial={at:0,gameTime:0,deathCounter:0,health:20,inventoryNbt,dimension:room.setup.dimension,position:Object.fromEntries(['x','y','z'].map((k,i)=>[k,room.setup.position[i]]))};
  const evaluator=new LadderEvaluator(parseSuccessCheck(room.successCheck),{goalStartAt:0,goalStartTick:0,budgetMs:room.durationBudgetMs});
  assert.equal(evaluator.push(initial),null,room.id);
 }
});
test('compound task and survival requires both, counts game ticks and rejects death',()=>{
 const spec=parseSuccessCheck('all: inventory raw_iron >=6 AND survive_duration: 4800 ticks');
 const evaluator=()=>new LadderEvaluator(spec,{goalStartAt:0,goalStartTick:0,budgetMs:300000});
 const sample={at:0,gameTime:0,deathCounter:0,inventoryNbt:'[{id:"minecraft:raw_iron",count:6}]'};
 const e=evaluator();assert.equal(e.push(sample),null);
 assert.equal(e.push({...sample,at:240000,gameTime:4799}),null);
 assert.equal(e.push({...sample,at:240001,gameTime:4800}).pass,true);
 const dead=evaluator();dead.push(sample);
 assert.equal(dead.push({...sample,at:240001,gameTime:4800,deathCounter:1}),null);
 const empty=evaluator();empty.push({...sample,inventoryNbt:'[]'});
 assert.equal(empty.push({...sample,at:240001,gameTime:4800,inventoryNbt:'[]'}),null);
});
test('barter output union composes with survival',()=>{
 const spec=parseSuccessCheck(rooms.find(s=>s.id==='R-PIGLIN').successCheck);
 const e=new LadderEvaluator(spec,{goalStartAt:0,goalStartTick:0,budgetMs:300000});
 assert.equal(e.push({at:0,gameTime:0,deathCounter:0,inventoryNbt:'[]'}),null);
 assert.equal(e.push({at:180000,gameTime:3600,deathCounter:0,inventoryNbt:'[{id:"minecraft:gravel",count:8}]'}).pass,true);
});
test('reflex rooms require their sampled predicate even when a different factual goal completed',async()=>{
 const {evaluateSamples}=await import('../../scripts/quality/ladder-evaluator.mjs');
 const room=rooms.find(s=>s.id==='R-CREEPER');
 const protocolRows=[
  {envelope:{type:'goal_control',payload:{operation:'start',updatedAtEpochMs:1000,goalSpec:{predicate:{type:'inventory_contains',itemId:'minecraft:stone',count:1}}}}},
  {envelope:{type:'goal_control',payload:{operation:'complete',updatedAtEpochMs:31000}}}
 ];
 const samples=[{at:2000,gameTime:20,deathCounter:0,inventoryNbt:''}];
 assert.equal(evaluateSamples(samples,{...room,goalStartAt:1000,protocolRows}).pass,false);
 assert.ok(rooms.every(s=>s.requireSampledSuccess===true));
});
