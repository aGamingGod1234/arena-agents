// Operator-only trace summary for one Sol game run directory: actions and outcomes, endermen seen/targeted,
// pearl items seen and picked up, deaths and pearls in the last inventory sample. Never read by the player.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
const dir=process.argv[2];const out={actions:{},results:{},endermenSeen:new Set(),fightTargets:{},fightResults:{},pearlItemsSeen:new Set(),deaths:0,lastPearls:null,lastPos:null,lastDimension:null,observations:0,firstEndermanAtS:null,reflexFires:{}};
let t0=null;
const rl=createInterface({input:createReadStream(`${dir}/quality-protocol.jsonl`)});
const endermanIds=new Set();
for await(const line of rl){
 let e;try{e=JSON.parse(line);}catch{continue;}const env=e.envelope??{};const p=env.payload??{};const at=e.at??e.recordedAtEpochMs??p.observedAtEpochMs;
 if(env.type==='action_command'){out.actions[p.actionType]=(out.actions[p.actionType]??0)+1;if(p.actionType==='fight_target'){const id=p.arguments?.targetId;out.fightTargets[endermanIds.has(id)?'enderman':'other']=(out.fightTargets[endermanIds.has(id)?'enderman':'other']??0)+1;}}
 if(env.type==='action_result'){const k=`${p.actionType??'?'} ${p.state} ${p.reasonCode}`;out.results[k]=(out.results[k]??0)+1;if(p.actionType==='fight_target')out.fightResults[`${p.state} ${p.reasonCode}`]=(out.fightResults[`${p.state} ${p.reasonCode}`]??0)+1;}
 if(env.type==='observation'&&p.ready){
  out.observations++;t0??=p.observedAtEpochMs;
  if(p.status==='PLAYER_DEAD')out.deaths++;
  for(const en of p.entities??[]){
   if(en.type==='minecraft:enderman'){out.endermenSeen.add(en.stableId);endermanIds.add(en.stableId);out.firstEndermanAtS??=Math.round((p.observedAtEpochMs-t0)/1000);}
   if(en.type==='minecraft:item'&&en.itemId==='minecraft:ender_pearl')out.pearlItemsSeen.add(en.stableId);
  }
  const inv=p.inventory?.items;if(inv)out.lastPearls=inv.filter(i=>i.itemId==='minecraft:ender_pearl').reduce((n,i)=>n+i.count,0);
  if(p.player)out.lastPos=[p.player.x,p.player.y,p.player.z].map(v=>Math.round(v));out.lastDimension=p.world?.dimension??out.lastDimension;
 }
}
console.log(JSON.stringify({...out,endermenSeen:out.endermenSeen.size,pearlItemsSeen:out.pearlItemsSeen.size,actions:Object.fromEntries(Object.entries(out.actions).sort((a,b)=>b[1]-a[1])),results:Object.fromEntries(Object.entries(out.results).sort((a,b)=>b[1]-a[1]).slice(0,20))},null,1));
