// Export only gameplay evidence. Authentication envelopes, provider homes and server credentials stay on the host.
import{createReadStream,createWriteStream,existsSync}from'node:fs';
import{readFile,writeFile,mkdir,readdir,copyFile}from'node:fs/promises';
import{createInterface}from'node:readline';
import path from'node:path';
import{pathToFileURL}from'node:url';
import{capturedFactPackets}from'./wake-facts.mjs';
const[src,out,mode,seedCsv='123456789,8675309,987654321,20261024',runCsv]=process.argv.slice(2);
const eligibleSeeds=new Set(seedCsv.split(',')),eligibleRuns=runCsv?new Set(runCsv.split(',')):null;
const decoder=path.join(src,'coordinator/src/model-fact-encoding.mjs');
const decode=existsSync(decoder)?(await import(pathToFileURL(decoder).href)).decodeModelFacts:value=>value;
const allowed=new Set(['observation','action_command','action_result','entity_killed','advancement_granted','goal_control']);
const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!/(replayProof|secret|password|authToken|accessToken|refreshToken)/i.test(k)).map(([k,v])=>[k,clean(v)])):value;
async function*dirs(root){for(const a of await readdir(root,{withFileTypes:true}).catch(()=>[]))if(a.isDirectory())yield path.join(root,a.name);}
for await(const d of dirs(path.join(src,'runtime/headless-runs')))for await(const run of dirs(d)){
 if(eligibleRuns&&!eligibleRuns.has(path.basename(run)))continue;
 let context;try{context=JSON.parse(await readFile(path.join(run,'long-run-context.json'),'utf8'));}catch{continue;}
 const seed=String(context.definition?.seed);if(!eligibleSeeds.has(seed))continue;
 if(context.definition?.setup?.dimension!=='minecraft:the_nether')continue;
 const exportRoot=path.join(out,seed,...(mode==='--all-runs'?[path.basename(run)]:[]));const target=path.join(exportRoot,'run');await mkdir(target,{recursive:true});const manifest={seed,run:path.basename(run),profile:context.profile,records:0,excluded:0,incomplete:0,exportedAt:new Date().toISOString()};
 const stream=createWriteStream(path.join(target,'quality-protocol.jsonl'));
 manifest.protocolPresent=existsSync(path.join(run,'quality-protocol.jsonl'));
 if(manifest.protocolPresent)for await(const line of createInterface({input:createReadStream(path.join(run,'quality-protocol.jsonl')),crlfDelay:Infinity})){
  let r;try{r=JSON.parse(line);}catch{manifest.incomplete++;continue;}
  if(!allowed.has(r.envelope?.type)){manifest.excluded++;continue;}
  const value={envelope:{type:r.envelope.type,payload:clean(r.envelope.payload)}};
  if(!stream.write(JSON.stringify(value)+'\n'))await new Promise(resolve=>stream.once('drain',resolve));manifest.records++;
 }
 await new Promise(resolve=>stream.end(resolve));
 await copyFile(path.join(run,'quality-samples.jsonl'),path.join(target,'quality-samples.jsonl')).catch(()=>{});
 await mkdir(path.join(target,'logs'),{recursive:true});const deaths=createWriteStream(path.join(target,'logs/fabric.stdout.log'));
 manifest.serverLogPresent=existsSync(path.join(run,'logs/fabric.stdout.log'));
 if(manifest.serverLogPresent)for await(const line of createInterface({input:createReadStream(path.join(run,'logs/fabric.stdout.log')),crlfDelay:Infinity}))if(/\[Server thread\/INFO\]: \w+ (was |burned|fell|tried|died|drowned|hit|went|walked|blew|withered|starved|froze|suffocated|experienced|discovered)/.test(line))deaths.write(line+'\n');
 await new Promise(resolve=>deaths.end(resolve));
 async function stats(root,depth=0){
  for(const e of await readdir(root,{withFileTypes:true}).catch(()=>[])){
   const p=path.join(root,e.name);
   if(e.isDirectory()&&depth<5&&/^(world|headless-run-|players|stats)/.test(e.name))await stats(p,depth+1);
   else if(e.isFile()&&path.basename(root)==='stats'&&e.name.endsWith('.json')){
    const dest=path.join(target,'server/world/players/stats');await mkdir(dest,{recursive:true});await copyFile(p,path.join(dest,e.name));
   }
  }
 }
 await stats(path.join(run,'server'));
 const memory=path.join(run,'provider-workspaces/player-memory'),dest=path.join(target,'player-memory');await mkdir(dest,{recursive:true});
 for(const f of await readdir(memory).catch(()=>[]))if(/^task-world-.*\.json$/.test(f)){
  const value=JSON.parse(await readFile(path.join(memory,f),'utf8'));if(value.entries)await writeFile(path.join(dest,f),JSON.stringify(clean({entries:value.entries})));}
 const turns=path.join(run,'provider-turns.private.jsonl');manifest.playerTurns=0;manifest.playerTurnsWithSeenGoldFact=0;manifest.decodedInputFrames=0;const presentedGold=new Map();const profiles=new Map();
 if(existsSync(turns))for await(const line of createInterface({input:createReadStream(turns),crlfDelay:Infinity})){
  let r;try{r=JSON.parse(line);}catch{continue;}
  if(r.model!=='gpt-6.1-sol')continue;manifest.playerTurns++;
  if(r.input?.includes('seen gold:'))manifest.playerTurnsWithSeenGoldFact++;
  for(const packet of capturedFactPackets(r.input)){
   let frame;try{frame=decode(packet);}catch{continue;}
   const observations=[frame?.observation,frame?.observationView?.replace].filter(v=>v&&typeof v==='object');
   if(!observations.length)continue;manifest.decodedInputFrames++;
   for(const obs of observations)for(const section of [obs.blocks,obs.landmarks,obs.known?.blocks])if(Array.isArray(section))for(const b of section){
    if(!b||!['minecraft:gold_block','minecraft:nether_gold_ore','minecraft:gilded_blackstone'].includes(b.blockId)||![b.x,b.y,b.z].every(Number.isInteger))continue;
    if(!presentedGold.has(b.blockId))presentedGold.set(b.blockId,new Set());presentedGold.get(b.blockId).add(`${b.x},${b.y},${b.z}`);
   }
  }
  const p=r.executionSettings?.requested??{};const k=JSON.stringify({model:r.model,effort:r.reasoningEffort,tier:p.serviceTier??null});profiles.set(k,(profiles.get(k)??0)+1);
 }
 manifest.goldCellsExplicitInWakeInputs=Object.fromEntries([...presentedGold].map(([type,cells])=>[type,cells.size]));
 manifest.presentedGoldCoverage='Complete JSON packets from sanitized wake audits: explicit blocks/landmarks/known.blocks and view replacements only; tool replies, removed/truncated data and retained view sections are not reconstructed. Counts are minimum explicit delivered cells, not all avatar visibility.';
 manifest.playerProfiles=[...profiles].map(([profile,turns])=>({...JSON.parse(profile),turns}));
 // Provider lifecycle codes are safe operator evidence; never export provider input or configuration.
 manifest.planningTimeouts=[];
 const lifecycle=path.join(run,'coordinator.jsonl');
 if(existsSync(lifecycle))for await(const line of createInterface({input:createReadStream(lifecycle),crlfDelay:Infinity})){
  let r;try{r=JSON.parse(line);}catch{continue;}
  if(r.event==='native_turn_failed'&&r.errorCode==='PLANNING_TIMEOUT'&&Number.isFinite(r.at))manifest.planningTimeouts.push(r.at);
 }
 await writeFile(path.join(exportRoot,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest));
}
