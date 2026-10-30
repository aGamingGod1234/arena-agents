#!/usr/bin/env node
// Owned disposable server only. No provider imports or model calls.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { applyQualitySetup, normalizeQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { parseValidationPlayer } from './validate-generality-fixtures.mjs';
import { LadderEvaluator, parseSuccessCheck } from './ladder-evaluator.mjs';
import { itemCount } from '../../coordinator/src/benchmark/quality-metrics.mjs';

const args = {};
for (let i=2;i<process.argv.length;i+=2) {
 const flag=process.argv[i], value=process.argv[i+1];
 if (!['--rcon-port','--password-file','--out','--fixtures'].includes(flag) || !value || value.startsWith('--')) throw new Error(`Invalid argument ${flag}`);
 args[flag.slice(2)]=value;
}
for (const k of ['rcon-port','password-file','out']) if (!args[k]) throw new Error(`--${k} required (owned disposable server)`);
const rooms = JSON.parse(await readFile(args.fixtures ?? new URL('./reflex-rooms.json', import.meta.url), 'utf8')).scenarios;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clientOptions = { port: Number(args['rcon-port']), password: (await readFile(args['password-file'], 'utf8')).trim(), commandTimeoutMs: 120000 };
let client;
const report = { purpose: 'Provider-free real server setup and controlled predicate transitions; not model performance.', startedAt: new Date().toISOString(), runs: [] };
await mkdir(path.dirname(path.resolve(args.out)), {recursive:true});
try {
 for (let i=0;;i++) { client=new HeadlessRconClient(clientOptions); try { await client.connect(); break; } catch(e) { await client.close(); if(i>=150) throw e; await sleep(2000); } }
 const command = c => client.command(c);
 for (const room of rooms) {
  const evidence=[], checks=[];
  const check=(name,pass,observed)=>checks.push({name,pass:Boolean(pass),observed});
  const run=async c=>{const r=await command(c.replaceAll('{agent}','ReflexCheck')); evidence.push({command:c,response:r.text});return r;};
  const sample=async()=>{
   const s=parseValidationPlayer((await run('data get entity ReflexCheck')).text);
   s.at=Date.now();
   s.gameTime=Number((await run('time query gametime')).text.match(/time is (\d+)/i)?.[1]);
   s.deathCounter=Number((await run('scoreboard players get ReflexCheck qo_death')).text.match(/has (\d+) \[/)?.[1]);
   return s;
  };
  try {
   normalizeQualitySetup(room.setup);
   const spec=parseSuccessCheck(room.successCheck);
   check('seed',(await run('seed')).text.includes(room.seed));
   await run('tick unfreeze'); await run('tick rate 20'); await run('player ReflexCheck kill');
   for(const d of ['overworld','the_nether','the_end']) await run(`execute in minecraft:${d} run kill @e[type=!minecraft:player]`);
   for(const o of ['qo_death','qo_damage']) await run(`scoreboard objectives remove ${o}`);
   await run('player ReflexCheck spawn at 134.5 120 488.5 facing 0 0 in minecraft:overworld');
   for(let i=0;i<100;i++){if((await run('data get entity ReflexCheck Pos')).text.includes('has the following'))break;await sleep(100);}
   const setup=await applyQualitySetup(room.setup,run,'ReflexCheck');
   const initial=await sample();
   check('survival-start',initial.gameMode===0 && initial.health>0 && initial.dimension===room.setup.dimension,initial);
   for(const {item,count=1} of room.setup.inventory) check(`inventory:${item}`,itemCount(initial.inventoryNbt,new RegExp('^'+item.split('[')[0]+'$'))>=count);
   for(const [slot,item] of Object.entries(room.setup.armour)) check(`armour:${slot}`,/time is \d+/i.test((await run(`execute if items entity ReflexCheck armor.${slot} ${item} run time query gametime`)).text));
   for(const id of new Set((room.setup.mobs??[]).map(m=>m.id))) check(`mob:${id}`,/time is \d+/i.test((await run(`execute at ReflexCheck if entity @e[type=${id},distance=..64] run time query gametime`)).text));
   if(room.id==='R-BLAZE') check('blaze-spawner',/time is \d+/i.test((await run('execute at ReflexCheck if block ~7 ~ ~ minecraft:spawner run time query gametime')).text));
   const block=async(at,id)=>/time is \d+/i.test((await run(`execute at ReflexCheck if block ${at} ${id} run time query gametime`)).text);
   if(room.id==='R-BLAZE') for(const z of [-3,3]) check(`blaze-wall-gap:${z}`,await block(`~3 ~ ~${z}`,'minecraft:air')&&await block(`~3 ~1 ~${z}`,'minecraft:air')&&await block(`~3 ~-1 ~${z}`,'minecraft:nether_bricks'));
   if(room.id==='R-BLAZE') check('blaze-wall-middle',await block('~3 ~1 ~','minecraft:nether_bricks'));
   if(room.id==='R-CREEPER') for(const at of ['~25 ~1 ~','~-25 ~1 ~','~ ~2 ~13','~ ~2 ~-13']) check(`creeper-rim:${at}`,await block(at,'minecraft:stone_bricks'));
   if(room.id==='R-TOOLBREAK') check('near-broken-held-pick',/time is \d+/i.test((await run('execute if items entity ReflexCheck weapon.mainhand minecraft:stone_pickaxe[minecraft:damage=129] run time query gametime')).text));
   if(room.id==='R-FLOOD') check('flooded-head',/time is \d+/i.test((await run('execute at ReflexCheck if block ~ ~1 ~ minecraft:water run time query gametime')).text));
   const evaluator=new LadderEvaluator(spec,{goalStartAt:initial.at,goalStartTick:initial.gameTime,budgetMs:room.durationBudgetMs});
   check('predicate-initially-false',!evaluator.push(initial));
   // Disable hazards only after proving their presence; then synthesize success on the real server.
   for(const d of ['overworld','the_nether','the_end']) await run(`execute in minecraft:${d} run kill @e[type=!minecraft:player]`);
   await run('effect give ReflexCheck minecraft:resistance infinite 255 true');
   await run('effect give ReflexCheck minecraft:water_breathing infinite 0 true');
   const leaves=s=>s.of?s.of.flatMap(leaves):[s];
   for(const leaf of leaves(spec)) {
    if(leaf.type==='inventory') await run(`give ReflexCheck ${leaf.items[0]} ${leaf.count}`);
    if(leaf.type==='position') await run(`execute in ${leaf.dimension} run tp ReflexCheck ${leaf.center.join(' ')}`);
   }
   const ticks=Math.max(0,...leaves(spec).filter(s=>s.type==='survive').map(s=>s.ticks));
   if(ticks){
    check('survival-not-early',!evaluator.push(await sample()));
    await run('tick rate 1000'); await run(`tick step ${ticks+20}`);
    for(let i=0;i<600;i++){const s=await sample();if(s.gameTime-initial.gameTime>=ticks)break;if(i===599)throw new Error('tick stepping timed out');await sleep(100);}
   }
   const positive=await sample();
   check('predicate-server-positive',Boolean(evaluator.push(positive)),positive);
   if(leaves(spec).some(s=>s.type==='survive')) {
    const dead=new LadderEvaluator(spec,{goalStartAt:initial.at,goalStartTick:initial.gameTime,budgetMs:room.durationBudgetMs});dead.push(initial);
    await run('scoreboard players set ReflexCheck qo_death 1');
    check('predicate-rejects-death',!dead.push(await sample()));
   }
   report.runs.push({id:room.id,pass:checks.every(c=>c.pass),checks,setup,evidence});
  } catch(error) {report.runs.push({id:room.id,pass:false,error:error.stack,checks,evidence});}
  finally {await run('player ReflexCheck kill');await run('tick unfreeze');await run('tick rate 20');}
  const result=report.runs.at(-1);console.log(`${room.id}: ${result.pass?'PASS':'FAIL'} ${result.error??checks.filter(c=>!c.pass).map(c=>c.name).join(', ')}`);
  await writeFile(args.out,JSON.stringify(report,null,2));
 }
} finally {await client.close();}
report.pass=report.runs.every(r=>r.pass);report.endedAt=new Date().toISOString();await writeFile(args.out,JSON.stringify(report,null,2));
if(!report.pass)process.exitCode=1;
