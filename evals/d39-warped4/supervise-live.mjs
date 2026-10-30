import {spawn} from 'node:child_process';
import {mkdir,open,stat,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {ProviderStall} from './provider-stall.mjs';
import {recordOperatorStop} from '../../scripts/quality/operator-stop.mjs';
const [outArg,...args]=process.argv.slice(2),out=path.resolve(outArg);await mkdir(out,{recursive:true});
const log=await open(out+'.log','a');
const child=spawn(process.execPath,['scripts/quality/run-long.mjs',...args,'--out',out],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe',log.fd],detached:true});
let raw=null,offset=0,partial='',ended=false,checking=false,voidRecord=null;const stalls=new ProviderStall();
createInterface({input:child.stdout}).on('line',line=>{log.write(line+'\n').catch(()=>{});const m=line.match(/^Running \S+: (.+)$/);if(m)raw=m[1];});
async function check(){
 if(checking||!raw||ended)return;checking=true;
 try{
  const file=path.join(raw,'coordinator.jsonl'),size=(await stat(file)).size;
  if(size<offset)throw Error('Lifecycle evidence rotated or truncated');
  const h=await open(file);try{const b=Buffer.alloc(size-offset);const {bytesRead}=await h.read(b,0,b.length,offset);offset+=bytesRead;partial+=b.subarray(0,bytesRead).toString('utf8');}finally{await h.close();}
  let i;while((i=partial.indexOf('\n'))>=0){const line=partial.slice(0,i);partial=partial.slice(i+1);try{stalls.accept(JSON.parse(line));}catch{}}
  const at=Date.now();await writeFile(out+'.provider-status.json',JSON.stringify({at,raw,...stalls.snapshot(at)},null,2)+'\n');
  if(stalls.stalled(at)&&!voidRecord){
   voidRecord={at,reason:'VOID_PROVIDER_STALL_10_MINUTES',...stalls.snapshot(at)};
   await writeFile(out+'.void.json',JSON.stringify(voidRecord,null,2)+'\n');
   await recordOperatorStop(out,voidRecord.reason,{at,signal:'SIGTERM',requestedBy:'d39-warped4 provider-stall guard'});
   if(child.exitCode===null&&child.signalCode===null)process.kill(-child.pid,'SIGTERM');
  }
 }catch(error){if(error.code!=='ENOENT')await writeFile(out+'.monitor-error.json',JSON.stringify({at:Date.now(),error:error.message})+'\n');}
 finally{checking=false;}
}
const timer=setInterval(()=>{void check();},2000);
const code=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));clearInterval(timer);while(checking)await new Promise(r=>setTimeout(r,20));await check();ended=true;await log.close();
await writeFile(out+'.done',JSON.stringify({...code,at:new Date().toISOString(),void:!!voidRecord})+'\n');process.exitCode=voidRecord?77:(code.code??1);
