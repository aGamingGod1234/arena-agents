import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyObservationTrigger, nativeSteerInterruption } from '../src/dynamic-main.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start, resolveNativeSteerInput, factToWireObservation } from './fixtures/dynamic-main-fixture.mjs';

// Decision boundaries the model did not cause: a program event that reaches a turn which is still making tool calls rides
// on its next tool result instead of starting another turn after it, and routine perception queued behind a turn that
// left a program running belongs to that program.

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const OVERWORLD = 'minecraft:overworld';
const NETHER = 'minecraft:the_nether';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function observation(sequence, { dimension = OVERWORLD, attention = true, changedFacts = ['blocks'] } = {}) {
	return { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence, attention, observedAtEpochMs: sequence, changedFacts,
		observation: { player: { x: sequence % 7, y: 64, z: 0, health: 20 }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} },
			world: { dimension, gameTime: 1_000 + sequence, dayTime: 1_000 + sequence, raining: false, thundering: false } } } };
}

/** The first turn stays open (making tool calls) until released; `during` runs inside it. Later turns end at once. */
async function coordinator(during) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	const steers = [];
	let release;
	const open = new Promise((resolve) => { release = resolve; });
	planner.steerNativeTurn = async (request) => { await resolveNativeSteerInput(request); steers.push(request); };
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		if (planner.requests.length > 1) return { toolCalls: 0 };
		const call = (callId, tool) => request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId, tool });
		await during({ call });
		await open;
		return { toolCalls: 2 };
	};
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: CONFIG });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Gather wood.' } });
	run.bridge.emit('observation', observation(1));
	await eventually(() => planner.requests.length === 1);
	const commands = () => run.bridge.sent.filter((message) => message.type === 'action_command');
	const endTurn = async () => {
		release();
		await eventually(() => rows.some(({ event }) => event === 'native_turn_completed'));
		await tick(); await tick();
	};
	return { run, planner, rows, steers, commands, endTurn };
}

const program = (policy, body) => ({ kind: 'run_program', background: true, timeoutMs: 30_000, source: `program.onUnhandledAttention("${policy}"); ${body}` });



for (const order of [ ['failure','damage','success','dm','threat'], ['failure','success','dm','threat','damage'], ['dm','failure','threat','success','damage'] ]) for (const reject of [false,true]) {
 test(`mixed events ${order.join('/')} rejected=${reject}`, async()=>{
  let execute;
  const {run,planner,rows,commands,endTurn}=await coordinator(async({call})=>{execute=call;await call('first',program('continue_and_notify','await player.wait(5);'));});
  let deliver;const gate=new Promise(resolve=>{deliver=resolve;});let steering=false;let completed=0;
  try {
   planner.steerNativeTurn=async request=>{steering=true;await gate;await resolveNativeSteerInput(request);if(reject)throw Object.assign(new Error('closing'),{code:'TURN_NOT_ACTIVE'});planner.delivered=request.input;};
   await eventually(()=>commands().length===1);
   for(const name of order){
    if(name==='failure'||name==='success'){
     if(completed>0){await execute('second',program('continue_and_notify','await player.wait(5);'));await eventually(()=>commands().length===2);}
     run.bridge.emit('action_result',{agentId:'agent-a',payload:{goalRevision:1,actionId:commands().at(-1).payload.actionId,state:name==='failure'?'FAILED':'SUCCEEDED',reasonCode:name==='failure'?'MIXED_ORIGINAL_FAILURE':'WAIT_DONE',actionType:'wait',eventSequence:run.bridge.latestSequences.get('agent-a')+1}});
     completed++;
     await eventually(()=>rows.filter(r=>r.event==='native_event_ready'&&r.eventName==='program_ended').length===completed);
    }else if(name==='dm'){
     run.bridge.emit('conversation_event',{agentId:'agent-a',payload:{sequence:1,kind:'player_message',sourceId:'operator',recipientId:'agent-a',scope:'direct',text:'MIXED_OPERATOR_DM',goalRevision:1,observedAtEpochMs:4}});
    }else{
     const danger=observation(run.bridge.latestSequences.get('agent-a')+1,{changedFacts:[name==='damage'?'player.health':'threats.skeleton']});
     danger.payload.trigger=name;danger.payload.priority='urgent';
     if(name==='damage')danger.payload.observation.player.health=13;
     else danger.payload.observation.player.threats=[{type:'minecraft:skeleton',signals:['ranged_aiming']}];
     const wire=factToWireObservation(danger.payload.observation,1,danger.payload.eventSequence,true,danger.payload.eventSequence,danger.payload.changedFacts);
     wire.trigger=name;wire.priority='urgent';
     if(name==='threat')assert.equal(classifyObservationTrigger(wire,wire).trigger,'threat');
     if(name==='threat')wire.threats={entries:[{uuid:'skeleton-mid-merge',type:'minecraft:skeleton',distance:7,bearing:0,targeting:true,swelling:false,lineOfSight:true,visible:true,signals:['ranged_aiming']}]};
     run.bridge.emit('observation',{agentId:'agent-a',payload:wire});
    }
    await tick();await tick();
   }
   await eventually(()=>steering);deliver();
   if(reject){await eventually(()=>rows.some(r=>r.event==='native_turn_steer_deferred'));await endTurn();await eventually(()=>planner.requests.length===2);}
   else await eventually(()=>planner.delivered!==undefined);
   const input=reject?planner.requests[1].input:planner.delivered;
   const payload=JSON.parse(input.slice(input.indexOf('\n')+1));
   const events=[payload,...(payload.mergedEvents??[])];
   for(const kind of ['damage','threat'])assert.ok(events.some(e=>e.trigger===kind),kind+' missing '+JSON.stringify({rootTrigger:payload.trigger,historicalTriggers:events.map(e=>e.trigger),threatFacts:events.map(e=>e.observation?.player?.threats).filter(v=>v?.length),interruption:nativeSteerInterruption({priority:'urgent',trigger:payload.trigger,nativeEvent:payload}),ready:rows.filter(r=>r.event==='native_event_ready').map(r=>({trigger:r.trigger,event:r.eventName}))}));
   assert.match(input,/MIXED_ORIGINAL_FAILURE/);
   assert.equal(payload.mergedEvents.filter(e=>e.event==='program_ended').length,2);
   assert.equal(input.split('MIXED_OPERATOR_DM').length-1,1);
   if(!reject)await endTurn();
  }finally{deliver();await run.coordinator.stop();}
 });
}


for (const dmFirst of [true, false]) for (const reject of [false, true]) {
 test(`DM and aiming threat release a blocked native tool, DM first=${dmFirst}, rejected=${reject}`, async () => {
  let bodyResult;
  const { run, planner, rows, commands, endTurn } = await coordinator(async ({call}) => {
   bodyResult = await call('blocked-wait', {kind:'action', actionType:'wait', arguments:{durationMs:30000}});
  });
  let deliver;
  const gate = new Promise(resolve => { deliver = resolve; });
  try {
   planner.steerNativeTurn = async request => {
    request.onInterrupt?.();
    await gate;
    await resolveNativeSteerInput(request);
    if (reject) throw Object.assign(new Error('closing'), {code:'TURN_NOT_ACTIVE'});
    planner.delivered = request.input;
   };
   await eventually(() => commands().length === 1);
   const dm = () => run.bridge.emit('conversation_event', {agentId:'agent-a', payload:{sequence:1, kind:'player_message', sourceId:'operator', recipientId:'agent-a', scope:'direct', text:'BLOCKED_OPERATOR_DM', goalRevision:1, observedAtEpochMs:2}});
   const threat = () => {
    const wire = factToWireObservation(observation(2).payload.observation, 1, 2, true, 2, ['threats.skeleton']);
    wire.threats = {entries:[{uuid:'aiming', type:'minecraft:skeleton', distance:7, bearing:0, targeting:true, swelling:false, lineOfSight:true, signals:['ranged_aiming']}]};
    run.bridge.emit('observation', {agentId:'agent-a', payload:wire});
   };
   for (const emit of dmFirst ? [dm, threat] : [threat, dm]) { emit(); await tick(); await tick(); }
   await eventually(() => bodyResult !== undefined);
   assert.equal(bodyResult.interruptedBy, 'danger');
   assert.equal(run.bridge.sent.some(message => message.type === 'action_cancel'), false);
   deliver();
   if (reject) { await eventually(() => rows.some(row => row.event === 'native_turn_steer_deferred')); await endTurn(); await eventually(() => planner.requests.length === 2); }
   else await eventually(() => planner.delivered !== undefined);
   const input = reject ? planner.requests[1].input : planner.delivered;
   const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
   assert.equal(payload.trigger, 'threat');
   assert.equal(input.split('BLOCKED_OPERATOR_DM').length - 1, 1);
   assert.ok(payload.hud.threats.some(threat => threat.uuid === 'aiming' && threat.signals.includes('ranged_aiming')));
   const encodedInput = encodeNativeEventInput(input);
   const encoded = decodeModelFacts(JSON.parse(encodedInput.slice(encodedInput.indexOf('\n') + 1)));
   assert.ok(encoded.observation.threats.some(threat => threat.uuid === 'aiming' && threat.signals.includes('ranged_aiming')),
    'the aiming threat reaches the provider after HUD projection');
   assert.equal(encodedInput.split('BLOCKED_OPERATOR_DM').length - 1, 1);
   if (!reject) await endTurn();
  } finally { deliver(); await run.coordinator.stop(); }
 });
}
