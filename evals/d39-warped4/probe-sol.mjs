// Fresh short request through the production launcher, with a 30-second admission deadline.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {CodexStdioTransport} from '../../coordinator/src/codex-app-server.mjs';
const out=path.resolve(process.argv[2]);await mkdir(path.dirname(out),{recursive:true});
const began=Date.now(),profile={model:'gpt-6.1-sol',reasoningEffort:'low',serviceTier:'default'};
const env={...process.env};for(const k of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','CODEX_HOME','CLAUDE_CONFIG_DIR'])delete env[k];
const transport=new CodexStdioTransport({...profile,cwd:'/tmp',environment:env});
let responseAt=null,threadId=null,failure=null,observedModel=null,resolveAnswer,rejectAnswer;const eventTypes={},phases={},mcpStartup=[],itemTypes={};let observedServiceTier=null;
const answer=new Promise((resolve,reject)=>{resolveAnswer=resolve;rejectAnswer=reject;});answer.catch(()=>{});
transport.on('notification',({method,params})=>{
 eventTypes[method]=(eventTypes[method]??0)+1;
 if(method==='mcpServer/startupStatus/updated'){const s=params?.status;const state=typeof s==='string'?s:s?.state??s?.type??'unknown';mcpStartup.push({afterMs:Date.now()-began,state:['starting','ready','failed','cancelled'].includes(state)?state:'unknown'});}
 if(method==='item/completed'&&typeof params?.item?.type==='string')itemTypes[params.item.type]=(itemTypes[params.item.type]??0)+1;
 if(!threadId||params?.threadId!==threadId)return;
 if(method==='item/completed'&&params.item?.type==='agentMessage'&&params.item.text?.trim()==='READY'){responseAt=Date.now();}
 if(method==='turn/completed'){if(params.turn?.status==='completed'&&responseAt)resolveAnswer();else rejectAnswer(Error('INVALID_SHORT_RESPONSE'));}
});
let timer,passed=false;
const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('NO_RESPONSE_WITHIN_30_SECONDS')),30000);});
try{
 await Promise.race([deadline,(async()=>{
  await transport.start();phases.transportStartedMs=Date.now()-began;await transport.request('initialize',{clientInfo:{name:'warped-pearl-readiness',title:'Warped pearl readiness',version:'1'},capabilities:{experimentalApi:true}});transport.notify('initialized',{});phases.initializedMs=Date.now()-began;
  const thread=await transport.request('thread/start',{model:profile.model,serviceTier:'default',cwd:'/tmp',allowProviderModelFallback:false,runtimeWorkspaceRoots:['/tmp'],selectedCapabilityRoots:[],approvalPolicy:'never',sandbox:'read-only',dynamicTools:[],environments:[],ephemeral:true,baseInstructions:'Reply with exactly READY. Never use tools.',developerInstructions:'This is a short provider readiness check. Reply READY.'});
  phases.threadCreatedMs=Date.now()-began;threadId=thread.thread.id;observedServiceTier=thread.serviceTier??thread.thread.serviceTier??null;observedModel=thread.model??thread.thread.model??null;
  if(observedModel&&observedModel!==profile.model)throw Error('MODEL_MISMATCH');if(observedServiceTier&&observedServiceTier!=='default')throw Error('TIER_MISMATCH');
  const turn=await transport.request('turn/start',{threadId,input:[{type:'text',text:'Reply READY.'}],model:profile.model,effort:'low',serviceTier:'default',approvalPolicy:'never',environments:[]});phases.turnAcknowledgedMs=Date.now()-began;observedServiceTier??=turn.serviceTier??turn.turn?.serviceTier??null;if(observedServiceTier&&observedServiceTier!=='default')throw Error('TIER_MISMATCH');await answer;
 })()]);passed=responseAt!==null&&responseAt-began<=30000;
}catch(error){failure=['NO_RESPONSE_WITHIN_30_SECONDS','INVALID_SHORT_RESPONSE','MODEL_MISMATCH','TIER_MISMATCH'].includes(error.message)?error.message:(error.code??'PROBE_TRANSPORT_FAILURE');}
finally{clearTimeout(timer);await transport.stop();}
const result={at:new Date(began).toISOString(),model:profile.model,effort:'low',serviceTier:'default',fastServiceRequested:false,launcher:'unchanged production CodexStdioTransport',observedModel,responseMs:responseAt?responseAt-began:null,passed,failure,observedServiceTier,phases,mcpStartup,itemTypes,eventTypes};
await writeFile(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exitCode=passed?0:1;
