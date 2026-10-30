import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
const root=process.argv[2],freeze=JSON.parse(await readFile(path.join(root,'frozen.json'),'utf8')),rows=[];
for(const seed of ['123456789','8675309','987654321','20261024'])for(const repeat of [1,2,3]){
 let r;try{r=JSON.parse(await readFile(path.join(root,'physical',`${seed}-r${repeat}`,'result.json'),'utf8'));}catch{process.exit(77);}
 if(r.error){console.error(`${seed} repeat ${repeat}: harness error`);process.exit(1);}
 if(!r.completedWindow)process.exit(77);
 if(String(r.seed)!==seed||r.repeat!==repeat||r.requestedGameTicks!==24000||r.naturalSpawns!==true||r.providerCalls!==0||!['endermenKilled','pearlsPickedUp','endPearls','deaths'].every(k=>Number.isFinite(r[k])&&r[k]>=0)||r.controllerSha256!==freeze.controllerSha256||r.jarSha256!==freeze.jarSha256||r.checkpointSha256!==freeze.checkpointSha256[seed])throw Error('Trial identity or frozen artifact mismatch');
 rows.push(r);
}
const groups=['123456789','8675309','987654321','20261024'].map(seed=>{const trials=rows.filter(r=>String(r.seed)===seed);return{seed,n:trials.length,pearlsPickedUpPer20MinuteOpportunity:trials.reduce((n,r)=>n+r.pearlsPickedUp,0)/trials.length,pearlsRetainedPer20MinuteOpportunity:trials.reduce((n,r)=>n+r.endPearls,0)/trials.length,endermenKilled:trials.reduce((n,r)=>n+r.endermenKilled,0),deaths:trials.reduce((n,r)=>n+r.deaths,0),actualGameMinutes:trials.map(r=>r.elapsedGameTicks/1200)};});
const out=path.join(root,'physical-summary.json');const temporary=out+`.${process.pid}.tmp`;await writeFile(temporary,JSON.stringify({at:new Date().toISOString(),frozen:freeze,groups,trials:rows},null,2)+'\n');await rename(temporary,out);console.log(JSON.stringify(groups));
