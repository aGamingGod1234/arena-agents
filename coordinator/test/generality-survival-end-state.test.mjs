import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGeneralityMarkers, predicateMet, summarizeGenerality } from '../src/benchmark/generality-suite.mjs';

const scenario={durationBudgetMs:300000,fixtureActivatedAt:500,setup:{activation:'first-decision'},objective:{type:'survival',minimumMs:270000,endState:{onFire:false,inLava:false,onGround:true}}};
const safe={health:20,onFire:false,inLava:false,onGround:true};
const samples=[{at:100,...safe},{at:500,...safe,onFire:true},{at:300100,...safe}];
const metrics={deaths:0,timeline:[],goalCompleted:false,playWallTimeMs:300000};

test('survival at timeout uses evaluator state despite an operator-confirmed compiled goal',()=>{
 const m=extractGeneralityMarkers({scenario,metrics,samples});
 assert.equal(m.goalPredicateMet,true);
 assert.equal(m.authoritativeGoalCompleted,false);
 assert.equal(m.timeToGoalPredicateMs,300000);
});
test('hazard must be cleared at the end, not merely at some earlier point',()=>{
 for(const changes of [{onFire:true},{inLava:true},{onGround:false},{health:0}]){
  const m=extractGeneralityMarkers({scenario,metrics,samples:[...samples.slice(0,-1),{at:200000,...safe},{at:300100,...safe,...changes}]});
  assert.equal(m.goalPredicateMet,false,JSON.stringify(changes));
 }
 assert.equal(extractGeneralityMarkers({scenario,metrics:{...metrics,deaths:1},samples}).goalPredicateMet,false);
});
test('legitimate early completion closes the survival window, while early interruption does not',()=>{
 const early=[{at:100,...safe},{at:500,...safe,onFire:true},{at:40100,...safe}];
 const protocolRows=[{type:'goal_control',at:100,payload:{operation:'start'}},{type:'goal_control',at:40101,payload:{operation:'complete'}}];
 assert.equal(extractGeneralityMarkers({scenario,metrics:{...metrics,playWallTimeMs:40001},samples:early,protocolRows}).goalPredicateMet,true);
 assert.equal(extractGeneralityMarkers({scenario,metrics:{...metrics,playWallTimeMs:40000},samples:early}).goalPredicateMet,false);
 assert.equal(extractGeneralityMarkers({scenario:{...scenario,fixtureActivatedAt:undefined},metrics,samples}).goalPredicateMet,false);
});
test('missing end-state facts remain unknown; fresh RCON facts supplement sparse terminal observations',()=>{
 const sparse={at:300500,health:20};
 assert.equal(extractGeneralityMarkers({scenario,metrics,samples:[...samples,sparse]}).goalPredicateMet,true);
 assert.equal(extractGeneralityMarkers({scenario,metrics,samples:[...samples,{at:303000,health:20}]}).goalPredicateMet,null);
 assert.equal(predicateMet(scenario.objective,{health:20},{survivalWindowEnded:true,fixtureActivated:true,deaths:0}),null);
 assert.equal(extractGeneralityMarkers({scenario,metrics:{...metrics,deaths:null},samples}).goalPredicateMet,null);
 assert.equal(extractGeneralityMarkers({scenario,metrics,samples:[{at:100,...safe},{at:500,...safe}]}).goalPredicateMet,null);
});
test('a timeout protocol closes the evaluator window even without a completed goal metric',()=>{
 const protocolRows=[{type:'goal_control',at:100,payload:{operation:'start'}},{type:'goal_control',at:300101,payload:{operation:'stop'}}];
 assert.equal(extractGeneralityMarkers({scenario,metrics:{...metrics,playWallTimeMs:null},samples,protocolRows}).goalPredicateMet,true);
});
test('unsupported goals stay unscored rather than lowering success averages',()=>{
 const m=extractGeneralityMarkers({scenario:{objective:{type:'unsupported'}},metrics,samples});
 assert.equal(m.goalPredicateMet,null);
 assert.equal(summarizeGenerality([{arm:'B',categories:{goalType:'unsupported'},markers:m}]).categories[0].success.n,0);
});
