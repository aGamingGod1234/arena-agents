import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseLocatedPosition, applyQualitySetup, activateQualitySetup } from '../src/benchmark/quality-scenarios.mjs';
import { loadGeneralityFixtures, validatePredicate, predicateMet, extractGeneralityMarkers, summarizeGenerality, buildGeneralityJudgeTimeline, findGeneralityInputLeaks } from '../src/benchmark/generality-suite.mjs';
import { parseSuiteArgs, suiteSchedule, boundedMap } from '../../scripts/quality/run-generality.mjs';
import { runSpendUsd } from '../src/benchmark/spend-ledger.mjs';

test('train fixtures retain 28 unique versioned short goals and all biome/dimension categories',async()=>{
 const data=await loadGeneralityFixtures(new URL('../../scripts/quality/scenarios-train.json',import.meta.url)); assert.equal(data.scenarios.length,28); assert.equal(data.sha256.length,64);
 assert.deepEqual(new Set(data.scenarios.map(s=>s.categories.dimension)),new Set(['overworld','nether','end']));
 assert.ok(new Set(data.scenarios.map(s=>s.categories.biome)).size>=9);
});
test('heldout is explicit and private; parser rejects duplicates, deadlines and malformed predicates',async()=>{
 assert.throws(()=>parseSuiteArgs(['--arms','arms.json','--out','tmp','--split','heldout']),/explicit/);
 assert.throws(()=>parseSuiteArgs(['--arms','a','--out','o','--concurrency','5']),/concurrency/);
 const dir=await mkdtemp(path.join(os.tmpdir(),'suite-parser-')); try {
  const data=await loadGeneralityFixtures(new URL('../../scripts/quality/scenarios-train.json',import.meta.url)); const one=data.scenarios[0]; const file=path.join(dir,'test.json');
  await writeFile(file,JSON.stringify({version:1,split:'train',scenarios:[one,one]})); await assert.rejects(loadGeneralityFixtures(file),/duplicate/);
  await writeFile(file,JSON.stringify({version:1,split:'train',scenarios:[{...one,durationBudgetMs:1}]})); await assert.rejects(loadGeneralityFixtures(file),/timeout/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('location parser accepts vanilla coordinates and rejects absent locate output',()=>{
 assert.deepEqual(parseLocatedPosition('The nearest minecraft:forest is at [144, 64, -880] (900 blocks away)'),[144,-880]);
 assert.deepEqual(parseLocatedPosition('[16, ~, -32]'),[16,-32]); assert.throws(()=>parseLocatedPosition('not found'),/LOCATION/);
});
test('fixture setup keeps weather and injury evaluator-side, injury follows survival transition',async()=>{
 const commands=[]; const setup={generality:true,dimension:'minecraft:overworld',position:[0,100,0],commands:[],weather:'rain',finalCommands:['damage {agent} 14 minecraft:generic'],inventory:[],effects:[],mobs:[]};
 const receipt=await applyQualitySetup(setup,async cmd=>{commands.push(cmd);return {text:cmd.includes('if loaded')?'The time is 1':'ok'};},'Player');
 assert.ok(!commands.includes('damage Player 14 minecraft:generic'));
 await activateQualitySetup(receipt,async cmd=>{commands.push(cmd);return {text:cmd.includes('if loaded')?'The time is 1':'ok'};},{stage:'goal-start'});
 assert.ok(commands.includes('weather rain 1000000')); assert.ok(commands.indexOf('damage Player 14 minecraft:generic')>commands.indexOf('gamemode survival Player'));
});
test('goal predicates use server facts, setup stock is excluded from first progress',()=>{
 const scenario={objective:{type:'inventory',items:[{item:'minecraft:oak_log',count:4}]}};
 const samples=[{at:100,health:20,inventoryNbt:'[{id:"minecraft:oak_log",count:1}]'},{at:1100,health:20,inventoryNbt:'[{id:"minecraft:oak_log",count:4}]'}];
 const metrics={deaths:0,timeline:[],tokens:null,qualityV2:{hazardDeathsByType:{mob:0}},progressV1:{},timeToFirstProgressMs:null};
 const markers=extractGeneralityMarkers({scenario,metrics,samples}); assert.equal(markers.goalPredicateMet,true);assert.equal(markers.timeToFirstMeaningfulProgressMs,1000);assert.equal(markers.survived,true);
 assert.equal(predicateMet({type:'dimension',dimension:'minecraft:the_nether'},{dimension:'minecraft:the_nether'},{initialDimension:'minecraft:the_nether'}),false);
 assert.equal(predicateMet({type:'survival',minimumMs:1000},{health:20},{elapsedMs:1000,deaths:1}),false);
});
test('missing sample and cost evidence remain unknown',()=>{
 const m=extractGeneralityMarkers({scenario:{objective:{type:'survival',minimumMs:300000}},metrics:{timeline:[],deaths:null,tokens:null},samples:[]});assert.equal(m.goalPredicateMet,null);assert.equal(m.survived,null);assert.equal(m.timeToFirstMeaningfulProgressMs,null);
 const summary=summarizeGenerality([{arm:'B',categories:{biome:'plains'},markers:m}]); assert.equal(summary.categories[0].playCostUsd.n,0);
});
test('pair order is counterbalanced and bounded workers never exceed four',async()=>{
 assert.deepEqual(suiteSchedule(['T01'],2).map(p=>p.arms),[['A','B'],['B','A']]); assert.deepEqual(suiteSchedule(['T01'],1,'B')[0].arms,['B']);
 let active=0,max=0; const rows=await boundedMap([1,2,3,4,5,6],3,async(i)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;return i*2;});assert.equal(max,3);assert.deepEqual(rows,[2,4,6,8,10,12]);
});

test('terminal server inventory observation preserves goal completion before RCON can sample',()=>{
 const scenario={objective:{type:'inventory',items:[{item:'minecraft:oak_log',count:4}]}};
 const metrics={deaths:0,timeline:[]};
 const samples=[{at:100,health:20,inventoryNbt:'[]'},{at:900,health:20,inventoryNbt:'[{id:"minecraft:oak_log",count:3}]'}];
 const protocolRows=[{type:'goal_control',at:100,payload:{operation:'start'}},{type:'observation',payload:{observedAtEpochMs:1000,player:{health:20},inventory:{items:[{itemId:'minecraft:oak_log',count:4}]}}},{type:'goal_control',at:1001,payload:{operation:'complete'}},{type:'observation',payload:{observedAtEpochMs:1100,inventory:{items:[{itemId:'minecraft:oak_log',count:99}]}}}];
 const m=extractGeneralityMarkers({scenario,metrics,samples,protocolRows});assert.equal(m.goalPredicateMet,true);assert.equal(m.timeToGoalPredicateMs,900);
});

test('predicate and judge preflight reject malformed fields before paid work',()=>{
 for(const p of [{type:'health'},{type:'survival'},{type:'position',radius:-1},{type:'dimension',dimension:'nether'},{type:'all',predicates:[{type:'rcon',rcon:'execute if entity @a run time query gametime'}]},{type:'rcon',rcon:'execute store result score Player changed run time query gametime'}]) assert.throws(()=>validatePredicate(p));
 assert.throws(()=>parseSuiteArgs(['--arms','a','--out','o','--judge-provider','claud']),/judge-provider/);
});
test('outbound completion does not hide later inbound terminal progress',()=>{
 const scenario={objective:{type:'inventory',items:[{item:'minecraft:oak_log',count:4}]}};
 const protocolRows=[{direction:'server_to_coordinator',envelope:{type:'goal_control',at:100,payload:{operation:'start'}}},{direction:'coordinator_to_server',envelope:{type:'goal_control',at:1100,payload:{operation:'complete'}}},{direction:'server_to_coordinator',envelope:{type:'observation',payload:{observedAtEpochMs:1150,player:{health:20},inventory:{items:[{itemId:'minecraft:oak_log',count:4}]}}}},{direction:'server_to_coordinator',envelope:{type:'goal_control',at:1200,payload:{operation:'complete'}}}];
 assert.equal(extractGeneralityMarkers({scenario,metrics:{deaths:0,timeline:[]},protocolRows}).goalPredicateMet,true);
});
test('real PowerShell scenario config separates Minecraft workspace per server',{skip:process.platform!=='win32'},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'suite-config-'));
 try {
  const source=path.join(dir,'source.json'),a=path.join(dir,'a.json'),b=path.join(dir,'b.json');
  await writeFile(source,JSON.stringify({bridge:{port:1},codex:{},minecraftAgentRoot:'old-shared-root'}));
  const launcher=fileURLToPath(new URL('../../scripts/run-headless-provider-matrix.ps1',import.meta.url));
  const script=`$ast=[System.Management.Automation.Language.Parser]::ParseFile('${launcher}',[ref]$null,[ref]$null); $f=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'New-ScenarioConfig'},$true); Invoke-Expression $f.Extent.Text; New-ScenarioConfig '${source}' '${a}' 26900 '${dir}/wa'; New-ScenarioConfig '${source}' '${b}' 26910 '${dir}/wb'`;
  await promisify(execFile)('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
  const read=await import('node:fs/promises');const aa=JSON.parse(await read.readFile(a,'utf8')),bb=JSON.parse(await read.readFile(b,'utf8'));assert.notEqual(aa.minecraftAgentRoot,bb.minecraftAgentRoot);assert.equal(path.dirname(aa.minecraftAgentRoot),path.resolve(aa.workspaceRoot));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('preparation observations are not gameplay evidence when goal never starts',()=>{
 const m=extractGeneralityMarkers({scenario:{objective:{type:'inventory',items:[{item:'minecraft:diamond',count:1}]}},metrics:{deaths:0,timeline:[]},protocolRows:[{type:'observation',payload:{observedAtEpochMs:100,inventory:{items:[{itemId:'minecraft:diamond',count:1}]},player:{health:20}}}]});assert.equal(m.status,'UNAVAILABLE');assert.equal(m.goalPredicateMet,null);
});
import { reextractSuite } from '../../scripts/quality/reextract-generality.mjs';
import { readArtifactReport } from '../src/benchmark/report-artifacts.mjs';
import { mkdir } from 'node:fs/promises';

test('sunrise predicate uses the actual day clock and excludes deaths',()=>{
 assert.equal(predicateMet({type:'daylight'},{dayTime:24001,health:20},{deaths:0}),true);
 assert.equal(predicateMet({type:'daylight'},{dayTime:18000,health:20},{deaths:0}),false);
 assert.equal(predicateMet({type:'daylight'},{dayTime:24001,health:20},{deaths:1}),false);
});
test('portable re-extraction resolves raw evidence relative to input without a provider call',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'suite-extract-'));try{
  const raw=path.join(dir,'raw','T99');await mkdir(raw,{recursive:true});
  await writeFile(path.join(raw,'quality-samples.json'),JSON.stringify({samples:[{at:100,health:20,inventoryNbt:'[]'}]}));
  await writeFile(path.join(raw,'quality-protocol.jsonl'),[{type:'goal_control',at:100,payload:{operation:'start'}},{type:'observation',payload:{observedAtEpochMs:200,player:{health:20},inventory:{items:[{itemId:'minecraft:oak_log',count:4}]}}},{type:'goal_control',at:201,payload:{operation:'complete'}}].map(r=>JSON.stringify(r)).join('\n'));
  const input=path.join(dir,'results.json'),out=path.join(dir,'out');await writeFile(input,JSON.stringify({runs:[{scenario:'T99',artifacts:'raw/T99',definition:{objective:{type:'inventory',items:[{item:'minecraft:oak_log',count:4}]}},metrics:{deaths:0,timeline:[]},categories:{biome:'plains'}}]}));
  await reextractSuite(input,out);const report=await readArtifactReport(path.join(out,'results.json'));assert.equal(report.runs[0].markers.goalPredicateMet,true);assert.equal(report.runs[0].artifacts,raw);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('judge timeline excludes outcomes and includes failed completion claims plus start facts',()=>{
 const protocol=[{type:'goal_control',at:100,payload:{operation:'start'}},{type:'observation',payload:{observedAtEpochMs:101,player:{health:6,foodLevel:8},world:{dimension:'minecraft:overworld',weather:'rain'}}},{type:'goal_completion_result',at:200,payload:{verified:false,reasonCode:'PREDICATE_FAILED',facts:[{observedValue:'2 logs'}]}}];
 const rows=buildGeneralityJudgeTimeline({timeline:[{elapsedMs:10,tool:'mine',resultCode:'OK'}],playWallTimeMs:300000,goalCompleted:false},{timeToGoalPredicateMs:2000,goalPredicateMet:true},protocol);
 assert.deepEqual(rows.map(r=>r.kind),['start','action','completion-verdict']);assert.match(rows[0].argsSummary,/foodLevel/);assert.match(rows[2].argsSummary,/PREDICATE_FAILED/);assert.ok(!rows.some(r=>/objective_evidence|window_end/.test(r.tool)));
});

test('survival objectives accept the full played window and early legitimate completion',()=>{
 const scenario={objective:{type:'survival',minimumMs:270000}};
 const samples=[{at:100,health:20},{at:40100,health:20}];
 const protocolRows=[{type:'goal_control',at:100,payload:{operation:'start'}},{type:'goal_control',at:40101,payload:{operation:'complete'}}];
 assert.equal(extractGeneralityMarkers({scenario,metrics:{deaths:0,timeline:[]},samples,protocolRows}).goalPredicateMet,true);
 assert.equal(extractGeneralityMarkers({scenario,metrics:{deaths:0,timeline:[],playWallTimeMs:300000},samples:[{at:100,health:20},{at:300100,health:20}]}).goalPredicateMet,true);
 assert.equal(extractGeneralityMarkers({scenario,metrics:{deaths:1,timeline:[]},samples,protocolRows}).goalPredicateMet,false);
});

test('pre-activation health cannot satisfy a recovery objective',()=>{
 const scenario={fixtureActivatedAt:500,objective:{type:'health',minimum:16}};
 const samples=[{at:100,health:20},{at:500,health:6},{at:1000,health:6}];
 const markers=extractGeneralityMarkers({scenario,metrics:{deaths:0,timeline:[]},samples});
 assert.equal(markers.goalPredicateMet,false);
 assert.equal(extractGeneralityMarkers({scenario,metrics:{deaths:0,timeline:[]},samples:[...samples,{at:1500,health:16}]}).goalPredicateMet,true);
});

test('rejected injury activation refuses an invulnerable starting player',async()=>{
 const receipt={agent:'Player',definition:{generality:true,finalCommands:['damage {agent} 14 minecraft:generic']}};
 await assert.rejects(activateQualitySetup(receipt,async cmd=>({text:cmd.startsWith('damage ')?'Target is invulnerable to given damage type':'ok'})),/QUALITY_SETUP_ACTIVATION/);
 assert.equal(receipt.activatedAt,undefined);
});

test('offline extraction retains first-decision activation for survival and health predicates',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'suite-activation-'));try{
  const raw=path.join(dir,'raw');await mkdir(raw);
  await writeFile(path.join(raw,'quality-samples.json'),JSON.stringify({samples:[{at:100,health:20},{at:500,health:6},{at:1000,health:6}]}));
  await writeFile(path.join(raw,'quality-protocol.jsonl'),[{type:'goal_control',at:100,payload:{operation:'start'}},{type:'goal_control',at:1001,payload:{operation:'complete'}}].map(r=>JSON.stringify(r)).join('\n'));
  const input=path.join(dir,'results.json');
  await writeFile(input,JSON.stringify({runs:[{artifacts:'raw',definition:{objective:{type:'health',minimum:16}},setup:{activatedAt:500,definition:{activation:'first-decision'}},metrics:{deaths:0,timeline:[]}},{artifacts:'raw',definition:{objective:{type:'survival',minimumMs:270000}},setup:{activatedAt:500,definition:{activation:'first-decision'}},metrics:{deaths:0,timeline:[]}}]}));
  const r=await reextractSuite(input,path.join(dir,'out'));
  assert.equal(r.runs[0].markers.goalPredicateMet,false);assert.equal(r.runs[1].markers.goalPredicateMet,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('idle waste ends at objective success and total spend includes preparation and judges',()=>{
 const markers=extractGeneralityMarkers({scenario:{objective:{type:'inventory',items:[{item:'minecraft:diamond',count:1}]}},metrics:{deaths:0,timeline:[{elapsedMs:10000,tool:'pickup'}],playWallTimeMs:300000},samples:[{at:100,health:20,inventoryNbt:'[]'},{at:20100,health:20,inventoryNbt:'[{id:"minecraft:diamond",count:1}]'}]});
 assert.equal(markers.waste.idleDecisionGapMs,0);
 assert.equal(runSpendUsd({metrics:{modelCalls:1,costEstimateUsd:2},judge:{judgments:[{costUsd:.3},{costUsd:.4}]}},{reserveUsd:5}).usd,2.7);
 assert.equal(runSpendUsd({metrics:{modelCalls:1,costEstimateUsd:2},judge:{error:'crashed'}},{reserveUsd:5}).usd,2.5);
});

test('held-out drift is rejected before parsing or launch',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'suite-pin-'));try{
  const file=path.join(dir,'private.json');await writeFile(file,'{}');
  await assert.rejects(loadGeneralityFixtures(file,'heldout'),/expected SHA/);
  await assert.rejects(loadGeneralityFixtures(file,'heldout','0'.repeat(64)),/mismatch/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('captured inputs containing setup feedback or fixture metadata fail leakage checks',()=>{
 const scenario={name:'train-fixture-v2-private',setup:{commands:['gamerule spawn_mobs false'],finalCommands:[]}};
 assert.equal(findGeneralityInputLeaks([{input:'Your game mode has been updated to Creative Mode'}],scenario).length,1);
 assert.equal(findGeneralityInputLeaks([{input:'qualitySetup: unexpected metadata'}],scenario).length,1);
 assert.equal(findGeneralityInputLeaks([{input:'train-fixture-v2-private'}],scenario).length,1);
 assert.equal(findGeneralityInputLeaks([{input:'Goal: gather logs. Health20, survival mode.'}],scenario).length,0);
});

test('timed out placements cannot prove shelter authorship and post-window rows cannot influence judges',()=>{
 const scenario={objective:{type:'shelter'}};
 assert.equal(extractGeneralityMarkers({scenario,metrics:{deaths:0,timeline:[{elapsedMs:10,tool:'place_block',resultCode:'TIMED_OUT'}]},samples:[{at:100,health:20,shelterEnclosed:true},{at:200,health:20,shelterEnclosed:true}]}).goalPredicateMet,false);
 const protocol=[{type:'goal_control',at:100,payload:{operation:'start'}},{type:'goal_control',at:1000,payload:{operation:'stop'}},{type:'goal_completion_result',at:1500,payload:{verified:false}}];
 const timeline=buildGeneralityJudgeTimeline({timeline:[{elapsedMs:10,tool:'place_block'},{elapsedMs:1100,tool:'mine'}]},null,protocol);
 assert.deepEqual(timeline.map(r=>r.elapsedMs),[10]);
 assert.throws(()=>parseSuiteArgs(['--arms','a','--out','o','--provider','codex','--codex-observer-cap','yes','--judge-effort','xhigh']),/Unsupported claude/);
});

test('generality construction never puts the model player in creative and removes its placement marker',async()=>{
 const commands=[];
 await applyQualitySetup({generality:true,dimension:'minecraft:overworld',position:[0,100,0],commands:['execute at {agent} run setblock ~ ~-1 ~ minecraft:stone'],inventory:[],effects:[],mobs:[],freezeUntilGoalStart:true,activation:'first-decision',finalCommands:['execute at {agent} run setblock ~ ~ ~ minecraft:fire']},async cmd=>{commands.push(cmd);return {text:cmd.includes('if loaded')?'The time is 1':'ok'}},'Player');
 assert.ok(!commands.some(c=>c.startsWith('gamemode creative')));
 assert.ok(commands.some(c=>c.includes('run summon minecraft:armor_stand')));
 const placement=commands.findIndex(c=>c.includes('run setblock')&&c.includes('qo_prepare_Player'));
 const teleport=commands.findIndex(c=>c.includes('qo_prepare_Player')&&c.includes('run tp Player'));
 assert.ok(placement>=0&&teleport>placement);
 assert.ok(commands.some(c=>c.includes('run kill @e[type=minecraft:armor_stand,tag=qo_prepare_Player')));
 assert.ok(!commands.some(c=>c.includes('minecraft:fire')||c==='tick unfreeze'));
});
