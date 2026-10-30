import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';

// Free production rendering only. No provider or game is started.
const [baseRoot, output, historyFlag] = process.argv.slice(2);
const withHistory = historyFlag === '--history';
if (!baseRoot || !output) throw new Error('Usage: node scripts/render-routine-bytes.mjs <base-worktree> <output.json> [--history]');
const { buildNativeEventInput: baseBuild } = await import(pathToFileURL(`${baseRoot}/coordinator/src/dynamic-main.mjs`));
const { encodeNativeEventInput: baseEncode, ModelObservationViews: BaseViews } = await import(pathToFileURL(`${baseRoot}/coordinator/src/model-fact-encoding.mjs`));
const record = { currentGoal: 'Beat Minecraft', currentGoalSpec: { originalRequest: 'Beat Minecraft' }, goalRevision: 1 };
const rows = [];
for (const [kind, actionType, args] of [
 ['travel', 'move_to', { x: 40, y: 64, z: 40 }],
 ['travelDecimal', 'navigate_to', { x: 12345.123456, y: 64.987654, z: -12345.123456 }],
 ['fight', 'fight_target', { targetId: 'z', fleeAtHealth: 6 }],
]) for (const combination of ['action', 'hurt', 'sunset', 'all'])
for (const wake of ['ordinary', 'newContext', 'healing', 'hazard', 'burn', 'program', 'threat', 'suffocation', 'fall', 'handler', 'planning', 'confirmation', 'noTaskDanger', 'noTaskHealing', 'conversation']) {
 const actionId = 'native:a:3';
 const hurt = combination === 'hurt' || combination === 'all';
 const sunset = combination === 'sunset' || combination === 'all';
 const state = { event: 'observation', trigger: 'observation',
  observation: { player: { x: 10, y: 64, z: 0, health: hurt ? 8 : 11, maxHealth: 20, skyOpen: true },
   world: { dimension: 'minecraft:overworld', dayTime: sunset ? 11770 : 6000, raining: false, thundering: false },
   currentAction: { active: true, actionId, actionType } },
  runningAction: { actionId, actionType, arguments: args }, runningActionStart: { actionId, health: 11 } };
 const baseViews = new BaseViews(), headViews = new ModelObservationViews();
 if (withHistory) {
  // Sol r2 live-history.mjs: the same valid-world healthy running wake precedes each combination.
  state.observation.world.worldId = 'review-world';
  state.observation.blocks = Array.from({length:24},(_,x)=>({blockId:'minecraft:stone',x,y:64,z:0}));
  state.observation.entities = []; state.observation.items = []; state.observation.inventory = {items:[]};
  const prior = structuredClone(state);
  prior.observation.player.health = 11; prior.observation.world.dayTime = 6000;
  baseEncode(baseBuild(record, prior), baseViews);
  encodeNativeEventInput(buildNativeEventInput(record, prior), headViews);
 }
 if (wake === 'newContext') state.newContext = true;
 if (wake === 'healing') state.trigger = 'low_health_food';
 if (wake === 'hazard') { state.trigger = 'damage'; state.observation.player.inLava = true; }
 if (wake === 'burn') { state.trigger = 'damage'; state.observation.player.onFire = true; state.observation.player.fireTicks = 100; }
 if (['program','threat','suffocation','fall','handler'].includes(wake)) {
  state.event = 'program_attention'; state.programId = 'program-1';
  state.status = { state: 'PAUSED', engineState: 'PAUSED', programVersion: 1,
   decision: { decisionId: 'd1', trigger: {program:'damage',handler:'defensive_handler_completed'}[wake] ?? wake, priority:'urgent' } };
 }
 if (wake === 'planning') { state.event = 'program_planning_due'; state.programId = 'program-1'; state.status = {state:'RUNNING',engineState:'ACTIVE',programVersion:1}; }
 if (wake === 'confirmation') state.awaitingConfirmation = true;
 if (wake.startsWith('noTask') || wake === 'conversation') { state.conversationOnly = true; state.dangerWake = wake === 'noTaskDanger'; state.selfCareWake = wake === 'noTaskHealing'; }
 const base = baseBuild(record, state), head = buildNativeEventInput(record, state);
 const shown = JSON.parse(head.slice(head.indexOf('\n') + 1)).observation;
 const action = shown.currentAction;
 assert.equal(action.hurtWhileRunning, hurt ? '11->8' : undefined);
 assert.equal(shown.world?.darkIn, sunset ? 'unknown' : undefined);
 if (kind === 'fight') assert.equal(action.fleeAtHealth, 6);
 else { assert.equal(action.to, `${args.x},${args.y},${args.z}`); assert.equal(action.left, Math.round(Math.hypot(args.x - 10, args.y - 64, args.z))); }
 const bytes = s => Buffer.byteLength(s);
 const baseEncoded = baseEncode(base, baseViews), headEncoded = encodeNativeEventInput(head, headViews);
 rows.push({kind,combination,wake,baseBytes:bytes(base),headBytes:bytes(head),delta:bytes(head)-bytes(base),
  baseEncodedBytes:bytes(baseEncoded),headEncodedBytes:bytes(headEncoded),encodedDelta:bytes(headEncoded)-bytes(baseEncoded)});
}
await writeFile(output, JSON.stringify({base:'9d44450c',withHistory,rows},null,2));
const failures = rows.filter(r=>r.delta>0 || r.encodedDelta>0);
console.log(JSON.stringify({count:rows.length,maxDelta:Math.max(...rows.map(r=>r.delta)),maxEncodedDelta:Math.max(...rows.map(r=>r.encodedDelta)),failures},null,2));
assert.deepEqual(failures, [], 'every carrying wake must pay for its routine facts');
