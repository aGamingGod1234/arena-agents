#!/usr/bin/env node
// Operator-only measurement. Reads recorded observations and death lifecycle events; never feeds the player.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
const args=process.argv.slice(2), out=args.shift();
if(!out||!args.length)throw Error('Usage: recovery-metrics.mjs OUT.json quality-protocol.jsonl [...]');
const gear=/_(pickaxe|sword|helmet|chestplate|leggings|boots)$|^minecraft:shield$/;
const pick=i=>i?.count>0&&i.itemId?.endsWith('_pickaxe');
const results=[];
for(const file of args) {
 let previous=null,lastLivingInventory=[],episode=null,totalMs=0,postDeathMs=0,emptyMs=0,noPickMs=0,deepMs=0,maxGapMs=0;
 const deaths=[],commands=new Map(),seenDeaths=new Set();
 for await(const line of createInterface({input:createReadStream(file),crlfDelay:Infinity})) {
  let row;try{row=JSON.parse(line);}catch{continue;}
  const e=row.envelope??row,p=e.payload??{},at=p.observedAtEpochMs??row.observedAtMs;
  if(e.type==='action_command' && typeof p.actionId==='string') commands.set(p.actionId,p);
  if(e.type==='goal_control'&&p.operation==='dead'&&p.death) {
   const key=JSON.stringify([p.death.diedAtEpochMs,p.death.cause,p.death.x,p.death.y,p.death.z]);
   if(seenDeaths.has(key)) continue; seenDeaths.add(key);
   if(episode&&episode.pickMinutes===null)episode.censoredAtNextDeath=true;
   const lost=lastLivingInventory.filter(i=>gear.test(i.itemId)&&i.count>0).map(({itemId,count})=>({itemId,count}));
   episode={at:p.death.diedAtEpochMs,cause:p.death.cause,dimension:p.death.dimensionId,position:{x:p.death.x,y:p.death.y,z:p.death.z},lostGear:lost,pickMinutes:null,kitMinutes:null,noPickMiningMinutes:0,emptyHandMiningMinutes:0};
   deaths.push(episode);previous=null;continue;
  }
  if(e.type!=='observation'||!p.ready||!Number.isFinite(at))continue;
  const items=p.inventory?.items??[];
  if(previous) {
   const dt=Math.max(0,at-previous.at);totalMs+=dt;maxGapMs=Math.max(maxGapMs,dt);
   if(deaths.length) {
    postDeathMs+=dt;
    const a=previous.observation.currentAction;
    const authored=commands.get(a?.actionId);
    const mining=a?.active&&(['break_block','dig_to'].includes(a.actionType??a.type)||(a.actionType==='control'&&authored?.arguments?.attack===true&&previous.observation.interaction?.rayTarget?.type==='block'));
    const inv=previous.observation.inventory;
    if(mining&&!inv?.items?.some(pick)) {
     noPickMs+=dt;if(episode)episode.noPickMiningMinutes+=dt/60000;
     const hand=inv?.selectedItem??inv?.items?.find(i=>i.slot==='mainhand')?.itemId??'minecraft:air';
     if(hand==='minecraft:air'){emptyMs+=dt;if(episode)episode.emptyHandMiningMinutes+=dt/60000;}
     const y=previous.observation.position?.y;
     if(previous.observation.world?.dimension==='minecraft:overworld'&&y>=-60&&y<=-40)deepMs+=dt;
    }
   }
  }
  if(episode) {
   if(episode.pickMinutes===null&&items.some(pick))episode.pickMinutes=(at-episode.at)/60000;
   if(episode.kitMinutes===null&&episode.lostGear.length&&episode.lostGear.every(l=>items.filter(i=>i.itemId===l.itemId).reduce((n,i)=>n+i.count,0)>=l.count))episode.kitMinutes=(at-episode.at)/60000;
  }
  previous={at,observation:p};lastLivingInventory=items;
 }
 if(episode&&episode.pickMinutes===null)episode.censoredAtEnd=true;
 results.push({file,observedMinutes:totalMs/60000,postDeathMinutes:postDeathMs/60000,noPickMiningMinutes:noPickMs/60000,emptyHandMiningMinutes:emptyMs/60000,deepOverworldNoPickMiningMinutes:deepMs/60000,maxObservationGapSeconds:maxGapMs/1000,deaths});
}
const report={definition:'Wall time between ready observations; last observed active break_block/dig_to (or control attack aimed at a block) while inventory has no pickaxe. Death-to-pick is first ready inventory with any pickaxe; kit is all last-carried nonconsumable gear types. Gaps are reported, not capped. Read-only operator analysis.',results};
await writeFile(out,JSON.stringify(report,null,2));
console.log(JSON.stringify(results.map(r=>({file:r.file,minutes:r.observedMinutes,noPickMiningMinutes:r.noPickMiningMinutes,emptyHandMiningMinutes:r.emptyHandMiningMinutes,deepMinutes:r.deepOverworldNoPickMiningMinutes,deaths:r.deaths.length,pickMinutes:r.deaths.map(d=>d.pickMinutes)}))));
