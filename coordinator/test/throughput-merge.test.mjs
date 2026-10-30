import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start, resolveNativeSteerInput } from './fixtures/dynamic-main-fixture.mjs';

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


for (const trigger of ['damage', 'threat', 'projectile', 'operator']) for (const reject of [false, true]) test(`program ends preserve ${trigger}, rejected=${reject}`, async () => {
 let execute;
 const {run,planner,rows,commands,endTurn}=await coordinator(async ({call})=>{execute=call; await call('c1',program('continue_and_notify','await player.wait(5);'));});
 let deliver; const gate=new Promise(resolve=>{deliver=resolve;}); let steering=false;
 try {
  planner.steerNativeTurn=async request=>{steering=true; await gate; await resolveNativeSteerInput(request); if (reject) throw Object.assign(new Error('Closed'), {code:'TURN_NOT_ACTIVE'}); planner.delivered=(planner.delivered??[]).concat(request.input);};
  await eventually(()=>commands().length===1);
  const finish=()=>run.bridge.emit('action_result',{agentId:'agent-a',payload:{goalRevision:1,actionId:commands().at(-1).payload.actionId,state:'SUCCEEDED',reasonCode:'WAIT_DONE',actionType:'wait',eventSequence:run.bridge.latestSequences.get('agent-a')+1}});
  finish();
  await eventually(()=>rows.some(row=>row.event==='native_event_ready'&&row.eventName==='program_ended'));
  const before=rows.filter(row=>row.event==='native_event_ready').length;
  if (trigger==='operator') {
   run.bridge.emit('conversation_event',{agentId:'agent-a',payload:{sequence:1,kind:'player_message',sourceId:'operator',recipientId:'agent-a',scope:'direct',text:'UNIQUE_OPERATOR_DM',goalRevision:1,observedAtEpochMs:4}});
  } else {
   const danger=observation(run.bridge.latestSequences.get('agent-a')+1,{changedFacts:[trigger==='damage'?'player.health':trigger==='threat'?'threats.skeleton':trigger]});
   if(trigger==='projectile') danger.payload.observation.player.incomingProjectiles=[{uuid:'arrow',type:'minecraft:arrow',bearing:0,etaSeconds:0.4,damaging:true}];
   else {danger.payload.trigger=trigger;danger.payload.priority='urgent';if(trigger==='damage')danger.payload.observation.player.health=18;else danger.payload.observation.player.threats=[{type:'minecraft:skeleton',signals:['ranged_aiming']}];}
   run.bridge.emit('observation',danger);
  }
  await eventually(()=>steering&&rows.filter(row=>row.event==='native_event_ready').length>before);
  await execute('c2',program('continue_and_notify','await player.wait(5);'));
  await eventually(()=>commands().length===2); finish();
  await eventually(()=>rows.filter(row=>row.event==='native_event_ready'&&row.eventName==='program_ended').length===2);
  deliver();
  let inputs;
  if(reject){await eventually(()=>rows.some(row=>row.event==='native_turn_steer_deferred')); await endTurn(); await eventually(()=>planner.requests.length===2); inputs=[planner.requests[1].input];}
  else {await eventually(()=>planner.delivered?.length>0);inputs=planner.delivered;}
  const payloads=inputs.map(input=>JSON.parse(input.slice(input.indexOf('\n')+1)));
  if(trigger==='operator') assert.match(inputs.join(''),/UNIQUE_OPERATOR_DM/);
  else assert.ok(payloads.some(payload=>[payload,...(payload.mergedEvents??[])].some(event=>event.trigger===trigger)),'every protected trigger reaches the next model input');
  if(trigger==='damage'||trigger==='threat') assert.ok(payloads.some(payload=>payload.trigger===trigger),'urgent trigger leads the wake');
  assert.equal(payloads[0].mergedEvents.filter(event=>event.event==='program_ended').length,2);
  if(!reject) await endTurn();
 } finally {deliver(); await run.coordinator.stop();}
});

for (const reject of [false, true]) test(`earlier failed program survives later success, rejected=${reject}`, async () => {
	let execute;
	const { run, planner, rows, commands, endTurn } = await coordinator(async ({ call }) => {
		execute = call;
		await call('c1', program('continue_and_notify', 'await player.wait(5);'));
	});
	let deliver;
	const delivery = new Promise((resolve) => { deliver = resolve; });
	let steering = false;
	try {
		planner.steerNativeTurn = async (request) => {
			steering = true;
			await delivery;
			await resolveNativeSteerInput(request);
			if(reject) throw Object.assign(new Error('Turn closed'), { code: 'TURN_NOT_ACTIVE' });
			planner.delivered=request.input;
		};
		await eventually(() => commands().length === 1);
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: commands()[0].payload.actionId,
			state: 'FAILED', reasonCode: 'FIRST_UNDELIVERED_FAILURE', actionType: 'wait', eventSequence: run.bridge.latestSequences.get('agent-a') + 1 } });
		await eventually(() => steering);
		await execute('c2', program('continue_and_notify', 'await player.wait(5);'));
		await eventually(() => commands().length === 2);
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: commands()[1].payload.actionId,
			state: 'SUCCEEDED', reasonCode: 'WAIT_DONE', actionType: 'wait', eventSequence: run.bridge.latestSequences.get('agent-a') + 1 } });
		await eventually(() => rows.filter(({ event, eventName, mode }) => event === 'native_event_ready' && eventName === 'program_ended' && mode === 'steer').length === 2);
		deliver();
		if(reject) {await eventually(() => rows.some(({ event }) => event === 'native_turn_steer_deferred')); await endTurn(); await eventually(() => planner.requests.length === 2);}
		else await eventually(()=>planner.delivered!==undefined);
		const input=reject?planner.requests[1].input:planner.delivered;
		assert.match(input, /program_ended/);
		assert.match(input, /FIRST_UNDELIVERED_FAILURE/);
		if(!reject) await endTurn();
	} finally { deliver(); await run.coordinator.stop(); }
});
