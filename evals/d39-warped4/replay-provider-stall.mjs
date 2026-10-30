// Replay safe lifecycle fields from an actual run; no provider input or credentials are exported.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {writeFile} from 'node:fs/promises';
import {ProviderStall} from './provider-stall.mjs';
const [file,out]=process.argv.slice(2),s=new ProviderStall();let firstStallAt=null,lastAt=null,events=0;
for await(const line of createInterface({input:createReadStream(file),crlfDelay:Infinity})){
 let r;try{r=JSON.parse(line);}catch{continue;}if(!Number.isFinite(r.at))continue;
 s.accept(Object.fromEntries(['event','at','errorCode','outcome','boundary','callId'].map(k=>[k,r[k]])));lastAt=r.at;events++;
 if(s.stalled(r.at))firstStallAt??=r.at;
}
const result={source:'recorded d39 Nether queue game, operator-only lifecycle',events,firstStallAt:firstStallAt?new Date(firstStallAt).toISOString():null,final:s.snapshot(lastAt),wouldVoid:firstStallAt!==null,scope:'Recorded trace replay of stall detection; process signalling is not exercised.'};
await writeFile(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(!result.wouldVoid)process.exitCode=1;
