// Operator-only per-game timeline: pearl count over time (first, peak, end), deaths with server-log causes, health low
// points, and the actions Sol took before and after its first pearl, in 10-minute buckets. Never read by the player.
import {createReadStream,readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const dir=process.argv[2];let t0=null,first=null,peak=0,peakAt=null,last=0,dead=false;const deaths=[],drops=[],buckets={},crafts=[];let minHealth=20,prevPearls=0;
const rl=createInterface({input:createReadStream(`${dir}/quality-protocol.jsonl`)});
for await(const line of rl){
 let e;try{e=JSON.parse(line);}catch{continue;}const env=e.envelope??{};const p=env.payload??{};
 if(env.type==='observation'&&p.observedAtEpochMs){
  t0??=p.observedAtEpochMs;const m=(p.observedAtEpochMs-t0)/60000;
  if(p.status==='PLAYER_DEAD'){if(!dead)deaths.push({atMin:+m.toFixed(1),pearlsBefore:prevPearls});dead=true;continue;}
  if(!p.ready||!p.inventory)continue;dead=false;
  const n=(p.inventory.items??[]).filter(i=>i.itemId==='minecraft:ender_pearl').reduce((s,i)=>s+i.count,0);
  if(n>0&&first===null)first=+m.toFixed(1);if(n>peak){peak=n;peakAt=+m.toFixed(1);}
  if(n<prevPearls)drops.push({atMin:+m.toFixed(1),from:prevPearls,to:n});prevPearls=n;last=n;
  const h=p.player?.health;if(typeof h==='number'&&h<minHealth)minHealth=h;
 }
 if(env.type==='action_command'&&t0){const at=e.observedAtMs;const min=typeof at==='number'?(at-t0)/60000:null;
  const b=min===null?'?':`${Math.floor(min/10)*10}-${Math.floor(min/10)*10+10}`;buckets[b]??={};const k=p.actionType;buckets[b][k]=(buckets[b][k]??0)+1;
  if(/craft/.test(k)||/craft/i.test(JSON.stringify(p.arguments??{}).slice(0,400)))crafts.push({atMin:min&&+min.toFixed(1),type:k,args:JSON.stringify(p.arguments).slice(0,140)});
 }
}
let log='';try{log=readFileSync(`${dir}/server/logs/latest.log`,'utf8');}catch{}
const causes=log.split('\n').filter(l=>/INFO\]: ha_\S+ (was |died|drowned|burned|tried to swim|fell|hit the ground|blew up|walked into|went up in flames|withered|starved|suffocated)/.test(l)).map(l=>l.replace(/^.*INFO\]: /,''));
const adv=log.split('\n').filter(l=>/has made the advancement/.test(l)).map(l=>l.replace(/^\[(\S+)\].*advancement /,'$1 '));
console.log(JSON.stringify({firstPearlMin:first,peakPearls:peak,peakAtMin:peakAt,endPearls:last,pearlLosses:drops,deaths,deathCauses:causes,minHealth,advancements:adv,crafts:crafts.slice(0,12),buckets},null,1));
