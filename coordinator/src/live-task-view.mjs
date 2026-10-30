import { codePointLength } from './text-length.mjs';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeDiagnosticText } from './diagnostic-sanitizer.mjs';
import { readFileInTurn, replaceFile } from './file-turns.mjs';
import { emptyKnown, restoreKnown, rememberPlanFacts, parsePlanCheck, evaluatePlanCheck, planProgress, placedItems, TOOLS, ARMOR } from './plan-checks.mjs';
import { observedBlocks } from './seen-resource-facts.mjs';
import { FactLifecycle, currentSample, deadSample, directBlockEvidence, evidenceClock, freshEvidence, invalidated, newerEvidence } from './fact-provenance.mjs';
import { strategyHints } from './minecraft-strategy-reference.mjs';
import { composeContinuityHeader, dependentChain, inventoryEffect, rememberResult, validateIntent } from './continuity-header.mjs';
import { boundPlacements, functionalPlacement, placementAt, placementCellsInDimension, placementsForItems, prunePlacements, relevantPlacement, samePlacementBlock } from './plan-placement-memory.mjs';
import { armorMaterialNeed, chainText, howtoChain, howtoHeldRecipe, howtoHoldings, howtoTopic } from './howto.mjs';
import { fortressSearchOption } from './nether-regions.mjs';
import { NETHER_OPTIONS_BYTES, SOURCE_BLOCKS, bedSpawnOption, descentRespawnFact, knownLine, needOptions, netherReadiness, netherRouteOption, pearlHuntLine, pearlOptions, pearlSourceInView, pearlsWanted, pickaxeTier, portalAtHand, progressionGoal, textResources } from './need-sources.mjs';
import { VILLAGE_POI, headingOf, sightingKind } from './search-coverage.mjs';
import { skillFitsLine } from './skill-fits.mjs';
import { dropLoss, recoveryRoute } from './respawn-recovery.mjs';
import { lightLine, toolsLine, picksLine, sleepLine, spawnLine, castingLine, frameLine } from './wake-body-facts.mjs';
import { noteIntent, noteRepeat, progressFacts, resetProgress, takeProgressWake, trackProgress } from './step-progress.mjs';

const KINDS = ['inventory', 'world', 'milestone', 'manual'];
const STATES = ['pending', 'active', 'complete', 'lost'];
const MAX_PLAN_BYTES = 12_288;
export const TASK_PLAN_SCHEMA = {
 type: 'object', additionalProperties: false, required: ['steps'], properties: {
  steps: { type: 'array', maxItems: 48, items: { type: 'object', additionalProperties: false,
   required: ['id', 'label', 'kind', 'status', 'dependsOn', 'detail', 'evidence'], properties: {
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,48}$' }, label: { type: 'string', minLength: 1, maxLength: 100 },
    kind: { type: 'string', enum: KINDS }, status: { type: 'string', enum: STATES },
    dependsOn: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 48 } },
    detail: { type: 'string', maxLength: 200 }, check: { type: ['string', 'null'], minLength: 1, maxLength: 160, description: 'in|visited|adv|seen|killed:<id>; has:<id>[|..]*N; has:#tag*N; worn:<tier>+N; tool:<kind>:<tier>+; y<=N; lava:N; frame:N; crystals<=N; spawn:bed; near:<dimension>@x,y,z*radius. Spaced &/|; max 4.' },
    evidence: { type: ['object', 'null'], additionalProperties: false,
     required: ['itemIds', 'count', 'dimension', 'x', 'y', 'z', 'blockId'], properties: {
      itemIds: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 128 } }, count: { type: 'integer', minimum: 1, maximum: 2147483647 },
      dimension: { type: ['string', 'null'], maxLength: 128 }, x: { type: ['integer', 'null'] }, y: { type: ['integer', 'null'] }, z: { type: ['integer', 'null'] }, blockId: { type: ['string', 'null'], maxLength: 128 },
     } },
   } } },
 } };
// Strict structured output requires every property; null states "no check". Tool input keeps check optional for legacy steps.
const STRICT_STEP = TASK_PLAN_SCHEMA.properties.steps.items;
export const TASK_PLAN_OUTPUT_SCHEMA = { ...TASK_PLAN_SCHEMA, properties: { steps: { ...TASK_PLAN_SCHEMA.properties.steps, items: { ...STRICT_STEP, required: Object.keys(STRICT_STEP.properties) } } } };

export function validateTaskPlan(value) {
 exact(value, ['steps']);
 if (!Array.isArray(value.steps) || value.steps.length > 48) throw new TypeError('Plan requires at most 48 steps');
 const steps = value.steps.map(validateTaskStep);
 const ids = new Set(steps.map(s => s.id));
 if (ids.size !== steps.length) throw new TypeError('Duplicate plan step ID');
 const visited = new Set(), visiting = new Set();
 function visit(id) {
  if (visiting.has(id)) throw new TypeError('Cyclic plan dependencies');
  if (visited.has(id)) return;
  const step = steps.find(s => s.id === id); if (!step) throw new TypeError('Unknown plan dependency');
  visiting.add(id); step.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
 }
 steps.forEach(s => visit(s.id));
 const result = { steps }; if (Buffer.byteLength(JSON.stringify(result)) > MAX_PLAN_BYTES) throw new TypeError('Plan exceeds 12 KiB');
 return result;
}

/** Validates one step on its own; dependency references are checked by validateTaskPlan. */
export function validateTaskStep(v) {
 if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('Plan step must be an object');
 if (!Object.hasOwn(v, 'check')) v = { ...v, check: null };
 exact(v, ['id', 'label', 'kind', 'status', 'dependsOn', 'detail', 'evidence', 'check']);
 if (!/^[a-zA-Z0-9_-]{1,48}$/.test(v.id) || !KINDS.includes(v.kind) || !STATES.includes(v.status)) throw new TypeError('Invalid plan step identity, kind or status');
 if (!Array.isArray(v.dependsOn) || v.dependsOn.length > 12 || new Set(v.dependsOn).size !== v.dependsOn.length) throw new TypeError('Invalid dependencies');
 parsePlanCheck(v.check);
 let evidence = v.evidence;
 if (evidence !== null) {
  exact(evidence, ['itemIds', 'count', 'dimension', 'x', 'y', 'z', 'blockId']);
  if (!Array.isArray(evidence.itemIds) || evidence.itemIds.length > 16 || evidence.itemIds.some(id => !identifier(id)) || new Set(evidence.itemIds).size !== evidence.itemIds.length) throw new TypeError('Invalid inventory evidence');
  if (!Number.isSafeInteger(evidence.count) || evidence.count < 1 || evidence.count > 2147483647) throw new TypeError('Invalid evidence count');
  if (evidence.dimension !== null && !identifier(evidence.dimension) || evidence.blockId !== null && !identifier(evidence.blockId)) throw new TypeError('Invalid world identifier');
  for (const field of ['x', 'y', 'z']) if (evidence[field] !== null && (!Number.isSafeInteger(evidence[field]) || Math.abs(evidence[field]) > (field === 'y' ? 2048 : 30000000))) throw new TypeError('Invalid evidence position');
  evidence = structuredClone(evidence);
 }
 if (v.check === null && v.kind === 'inventory' && (!evidence || evidence.itemIds.length === 0)) throw new TypeError('Inventory steps require item evidence');
 if (v.check === null && v.kind === 'world' && (!evidence || !evidence.dimension || !evidence.blockId || ['x', 'y', 'z'].some(k => evidence[k] === null))) throw new TypeError('World steps require an exact block position and dimension');
 return { id: v.id, label: text(v.label, 100, false), kind: v.kind, status: v.status, dependsOn: [...v.dependsOn], detail: text(v.detail, 200, true), evidence, check: v.check };
}

/** A factual, persistent view of agent-authored plans; never chooses game actions. */
export class LiveTaskViews {
 #directory; #states = new Map(); #advice = new Map(); #writes = Promise.resolve(); #now; #sources; #progressTiming;
 /** sources(record, observation, blockPattern) returns remembered { sightings, blocks } of that world and dimension, or null. */
 /** progressTiming ({ noProgressMs, repeatCount }) overrides the recorded-game defaults, for replays only. */
 constructor({ directory = null, now = Date.now, sources = null, progressTiming = {} } = {}) {
  if (typeof now !== 'function') throw new TypeError('Live task view clock must be a function');
  if (sources !== null && typeof sources !== 'function') throw new TypeError('Live task view sources must be a function');
  this.#directory = directory; this.#now = now; this.#sources = sources; this.#progressTiming = progressTiming;
 }
 suggest(agentId, goal, plan) { const checked=validateTaskPlan(plan); for(const step of checked.steps) step.status='pending'; this.#advice.set(`${agentId}:${goal}`, checked); }
 #state(record) {
  const identity = taskIdentity(record);
  let state = this.#states.get(record.agentId);
  if (!state || identity !== null && state.taskIdentity !== identity) {
   state = this.#newState(record);
   this.#states.set(record.agentId, state);
  }
  if (state.goalRevision !== record.goalRevision) { state.usage = null; state.usageSample = null; }
  state.goalRevision = record.goalRevision;
  return state;
 }
 #newState(record, fresh = false) {
  // Steering changes the planner prompt, not the immutable task or its saved scope.
  return { taskIdentity: taskIdentity(record), goal: record.currentGoalSpec?.originalRequest ?? record.currentGoal ?? '', goalRevision: record.goalRevision, plan: null, revision: 0, events: [], sequence: 0, usage: null, usageSample: null, allowance: null, worldId: null, observation: null, scope: null, loading: null, lastObserved: {}, worldProof: {}, presenceProof: {}, deathLosses: {}, known: emptyKnown(), verified: false, fresh, intent: null, stall: null, broken: 0, counted: [], breaks: [], gains: [], ownPoi: [], dimensionSince: null, deaths: 0, wasDead: false, results: [], effect: null, liveInventory: null, liveDimension: null, samples: [], lifecycle: new FactLifecycle(), progress: null, alarms: {}, repeats: [], repeatAlarmed: {}, intentLog: [] };
 }
 async #load(record, state) {
  if (!state.worldId) return;
  const scope = createHash('sha256').update(JSON.stringify([state.worldId, record.agentId, state.goal])).digest('hex');
  if (state.scope === scope) { await state.loading; return; }
  state.scope = scope;
  state.loading = (async () => {
   let saved = null;
   if (this.#directory && !state.fresh) {
    try { saved = JSON.parse(await readFileInTurn(path.join(this.#directory, `${scope}.json`), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT' && this.#states.get(record.agentId) === state && state.scope === scope) this.event(record, 'status', 'Saved plan unavailable; the agent can publish a fresh plan.'); }
   }
   if (this.#states.get(record.agentId) !== state || state.scope !== scope) return;
   const wasFresh = state.fresh; state.fresh = false;
   if (saved?.plan) {
    try {
     state.plan = validateTaskPlan(saved.plan);
     state.revision = Number.isSafeInteger(saved.revision) ? Math.max(0, saved.revision) : 0;
     state.lastObserved = Object.fromEntries(Object.entries(saved.lastObserved ?? {}).filter(([id, at]) => state.plan.steps.some(s => s.id === id) && Number.isSafeInteger(at) && at >= 0));
     state.worldProof = Object.fromEntries(state.plan.steps.filter(s => s.kind === 'world' && s.check === null && saved.worldProof?.[s.id] === worldProofKey(s, state.plan.steps)).map(s => [s.id, saved.worldProof[s.id]]));
    // Presence proofs are life-bound (LIFECYCLE_BINDINGS.life): a record read back may have missed a death, so they are
    // never restored; visits stay remembered, and life-bound ordering must be re-proven.
    state.presenceProof = {};
    state.deathLosses = Object.fromEntries(Object.entries(saved.deathLosses ?? {}).filter(([id, n]) => state.plan.steps.some(s => s.id === id) && Number.isSafeInteger(n) && n > 0));
    } catch { /* invalid saved advice does not block play */ }
   }
   // Deaths and the dimension carry over a restart; the restored record reports the restart on its next sample.
   if (saved?.lifecycle) state.lifecycle.adopt(saved.lifecycle);
   const adviceKey = `${record.agentId}:${record.currentGoalSpec?.originalRequest ?? state.goal}`;
   const advice = this.#advice.get(adviceKey);
   if (!state.plan && advice) { state.plan = structuredClone(advice); state.revision++; }
   this.#advice.delete(adviceKey);
   if (saved?.intent) { try { const { inPlan, deaths, dimension, at, mark, ...authored } = saved.intent; state.intent = { ...validateIntent(authored), ...intentFacts(saved.intent) }; } catch { /* invalid saved intent does not block play */ } }
   if (Number.isSafeInteger(saved?.deaths) && saved.deaths > state.deaths) state.deaths = saved.deaths;
   if (typeof saved?.stall?.step === 'string' && typeof saved.stall.key === 'string' && Number.isSafeInteger(saved.stall.since) && state.plan?.steps.some(s => s.id === saved.stall.step)) state.stall = { step: saved.stall.step, key: saved.stall.key, since: saved.stall.since, ...(Number.isSafeInteger(saved.stall.broken) && saved.stall.broken >= 0 ? { broken: saved.stall.broken } : {}) };
   if (Number.isSafeInteger(saved?.broken) && saved.broken > state.broken) state.broken = saved.broken;
   if (Array.isArray(saved?.counted)) state.counted = [...new Set([...saved.counted.filter(key => typeof key === 'string' && key.length <= 300), ...state.counted])].slice(-MAX_COUNTED);
   if (Array.isArray(saved?.ownPoi)) state.ownPoi = boundOwnPoi([...saved.ownPoi.filter(p => identifier(p?.dimension) && identifier(p.blockId) && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))), ...state.ownPoi]);
   // A restart while dead must not count the same death again.
   if (saved?.dead === true) state.wasDead = true;
   if (saved?.known) {
    const previousKnown = state.known; state.known = restoreKnown(saved.known, state.plan);
    for (const key of ['visitedDimensions', 'advancements', 'kills']) state.known[key] = [...new Set([...state.known[key], ...previousKnown[key]])];
    for (const row of previousKnown.structuresSeen) if (!state.known.structuresSeen.some(v => JSON.stringify(v) === JSON.stringify(row))) state.known.structuresSeen.push(row);
    for (const key of ['lavaPools', 'frames']) if (!state.known[key].length) state.known[key] = previousKnown[key] ?? [];
    state.known.crystals ??= previousKnown.crystals ?? null;
   }
   prunePlacements(state.known, state.plan);
   const knownChanged = rememberPlanFacts(state.known, state.observation ?? {});
   if (state.plan || wasFresh || knownChanged || saved?.known) { this.#reconcile(state); this.#save(state); }
  })();
  await state.loading;
 }
 async observe(record, observation, directObservation = observation) {
  // Keep the source's visibility and continuity labels; adaptation can omit them from scripting facts.
  if (directObservation !== observation) observation = { ...observation, ...Object.fromEntries(['continuity', 'blocks', 'landmarks', 'nearbyContainers', 'interaction'].filter(k => Object.hasOwn(directObservation, k)).map(k => [k, directObservation[k]])) };
  // Only a current observation of the agent may change the plan or its world scope (the lifecycle also needs body
  // evidence). An unready or bodiless sample, even one naming another world, only makes current facts unknown.
  if (!currentSample(observation)) { this.#state(record).observation = { ready: false }; return; }
  const state = this.#state(record), world = observation.world?.worldId ?? null;
  if (world && state.worldId && world !== state.worldId) { state.plan = null; state.revision = 0; state.scope = null; state.lastObserved={}; state.worldProof = {}; state.presenceProof = {}; state.deathLosses = {}; state.known=emptyKnown(); state.verified=false; state.usage=null; state.usageSample=null; state.intent = null; state.deaths = 0; state.results = []; state.effect = null; state.liveInventory = null; state.liveDimension = null; state.samples = []; state.ownPoi = []; state.breaks = []; state.gains = []; state.intentLog = []; resetProgress(state); }
  if (world) state.worldId = world;
  state.observation = observation;
  await this.#load(record, state);
  if (this.#states.get(record.agentId) !== state) return;
  const dead = observation.player?.dead === true || observation.continuity?.phase === 'dead';
  const died = dead && !state.wasDead, revived = !dead && state.wasDead;
  // A corpse sample may lack the world; the last live dimension is where the death happened.
  if (died) { state.deaths++; state.effect = `died in ${String(observation.world?.dimension ?? state.liveDimension ?? 'this world').replace(/^minecraft:/, '')}`; state.liveInventory = null; }
  if (!dead && identifier(observation.world?.dimension)) {
   // The first dimension seen is no change; a later one is.
   if (state.liveDimension !== null && state.liveDimension !== observation.world.dimension) state.dimensionSince = Number.isFinite(observation.observedAtEpochMs) ? observation.observedAtEpochMs : this.#now();
   state.liveDimension = observation.world.dimension;
  }
  state.wasDead = dead;
  if (!dead) {
   rememberResult(state.results, observation.lastResult);
   // The last meaningful change to what the agent holds, from fresh inventory samples only.
   if (observation.ready === true && Array.isArray(observation.inventory?.items) && !observation.continuity?.rememberedSections?.includes('inventory')) {
    const effect = state.liveInventory === null ? null : inventoryEffect(state.liveInventory, observation.inventory.items);
    if (effect !== null) state.effect = effect;
    if (state.liveInventory !== null) rememberGains(state, state.liveInventory, observation.inventory.items, Number.isFinite(observation.observedAtEpochMs) ? observation.observedAtEpochMs : this.#now());
    state.liveInventory = observation.inventory.items.map(({ itemId, count }) => ({ itemId, count }));
   }
  }
  const life = state.lifecycle.observe(observation);
  const lifeEnded = invalidated('life', life) && Object.keys(state.presenceProof).length > 0;
  if (lifeEnded) state.presenceProof = {};
  const knownChanged = rememberPlanFacts(state.known, observation);
  const placementChanged = this.#invalidatePlacements(state, observation);
  const changed = this.#reconcile(state);
  if (changed) state.revision++;
  const stalled = !dead && observation.ready === true && trackStall(state, Number.isFinite(observation.observedAtEpochMs) ? observation.observedAtEpochMs : this.#now());
  if (!dead && observation.ready === true) trackProgress(state, progressFocus(state), Number.isFinite(observation.observedAtEpochMs) ? observation.observedAtEpochMs : this.#now(), { ...this.#progressTiming, chain: step => requirementChain(step, state, { counted: true })?.key ?? null });
  if (stalled || changed || knownChanged || placementChanged || lifeEnded || life !== null || (died || revived) && state.intent) this.#save(state);
  rememberSample(state, observation);
 }
 #invalidatePlacements(state, o) {
  if (o.ready !== true || deadSample(o) || !Number.isFinite(o.observedAtEpochMs)) return false;
  const placements = placementCellsInDimension(state.known, o.world?.dimension);
  if (!placements?.size) return false;
  const seen = directBlockEvidence(o), removed = [], at = new Map();
  // Each row is compared at its own observation time: an older row cannot withdraw a later placement.
  const consider = (p, block) => {
   const clock = evidenceClock(block, o);
   if (p && (p.available !== false || newerEvidence(withdrawnClock(p), clock)) && freshEvidence(placedClock(p), clock) && !samePlacementBlock(p.blockId, block.blockId)) { removed.push(p); at.set(p, clock); }
  };
  // Intersect the two cell indexes from the smaller side, within this dimension only.
  if (placements.size < seen.size) {
   for (const [key, p] of placements) { const block = seen.get(key); if (block) consider(p, block); }
  } else for (const [key, block] of seen) consider(placements.get(key), block);
  return this.#forgetPlacements(state, removed, p => at.get(p));
 }
 #forgetPlacements(state, removed, at) {
  if (!removed.length) return false;
  // Retain the action identity so replaying an old terminal receipt cannot resurrect a destroyed station.
  for (const p of removed) {
   const clock = typeof at === 'function' ? at(p) : at;
   p.available = false; p.withdrawnAt = typeof clock === 'number' ? clock : clock.observedAtEpochMs ?? p.placedAt;
   if (Number.isSafeInteger(clock?.lastSeenTick)) p.withdrawnTick = clock.lastSeenTick; else delete p.withdrawnTick;
  }
  for (const step of state.plan?.steps ?? []) {
   const ids = step.check !== null ? parsePlanCheck(step.check).terms.filter(t => t.type === 'has').flatMap(t => t.ids) : step.kind === 'inventory' ? step.evidence.itemIds : [];
   if (step.status === 'complete' && removed.some(p => ids.some(id => samePlacementBlock(id, p.itemId)))) step.status = 'lost';
  }
  for (const step of state.plan?.steps ?? []) if (step.kind === 'world' && step.check === null && removed.some(p => samePlacedCell(p, step.evidence) && p.blockId === step.evidence.blockId)) {
   delete state.worldProof[step.id]; delete state.presenceProof[step.id];
   if (step.status === 'complete') step.status = 'lost';
  }
  return true;
 }
 async actionReceipt(record, receipt) {
  // A result that changed nothing, repeated, is a fact about the current approach (arrows into iron bars).
  if (receipt.goalRevision === record.goalRevision && (receipt.state !== 'SUCCEEDED' || typeof receipt.message === 'string' && /\bmissed\b/i.test(receipt.message))) {
   const state = this.#state(record); await this.#load(record, state);
   if (this.#states.get(record.agentId) === state) noteRepeat(state, receipt, Number.isSafeInteger(receipt.observedAtEpochMs) ? receipt.observedAtEpochMs : this.#now(), progressFocus(state), this.#progressTiming);
  }
  // Held attack (control, control_sequence, scripts) reports how many blocks it broke; break_block is counted below.
  const tally = receipt.actionType !== 'break_block' && Number.isSafeInteger(receipt.breakOutcome?.blocks) && receipt.breakOutcome.blocks > 0 ? receipt.breakOutcome.blocks : 0;
  if (tally > 0) {
   const state = this.#state(record); await this.#load(record, state);
   if (this.#states.get(record.agentId) !== state || receipt.goalRevision !== record.goalRevision || !firstCount(state, receipt)) return;
   const at = Number.isSafeInteger(receipt.observedAtEpochMs) ? receipt.observedAtEpochMs : this.#now();
   state.broken += tally; recordBreaks(state, at, tally); this.#save(state);
   return;
  }
  if (receipt.state !== 'SUCCEEDED' || !['BLOCK_PLACED', 'BLOCK_BROKEN'].includes(receipt.reasonCode)) return;
  const state = this.#state(record); await this.#load(record, state);
  if (this.#states.get(record.agentId) !== state || receipt.goalRevision !== record.goalRevision || receipt.worldId !== state.worldId) return;
  // Native tool dispatches are journaled without a dimension: the break still counts, and its own bells and
  // workstations take the dimension it is living in; plan placements keep needing the receipt's own.
  if (!identifier(receipt.dimension)) {
   const args = receipt.arguments, at = Number.isSafeInteger(receipt.observedAtEpochMs) ? receipt.observedAtEpochMs : this.#now();
   // Without the dispatch's dimension, the living one stands in only if the body has not changed dimension within any
   // action's lifetime before the result.
   const ownDimension = state.dimensionSince === null || state.dimensionSince <= at - ACTION_LIFETIME_MS ? state.liveDimension : null;
   if (receipt.reasonCode === 'BLOCK_BROKEN' && receipt.actionType === 'break_block' && firstCount(state, receipt)) { state.broken++; recordBreaks(state, at, 1); this.#save(state); }
   const blockId = receipt.actionObservation?.target?.afterId ?? args?.desiredState?.split('[')[0] ?? args?.itemId;
   if (receipt.reasonCode === 'BLOCK_PLACED' && receipt.actionType === 'place_block' && identifier(ownDimension) && identifier(blockId) && VILLAGE_POI.test(blockId) && ['x', 'y', 'z'].every(k => Number.isSafeInteger(args?.[k]))) {
    state.ownPoi = boundOwnPoi([...state.ownPoi, { blockId, dimension: ownDimension, x: args.x, y: args.y, z: args.z }]); this.#save(state);
   }
   return;
  }
  const args = receipt.arguments;
  if (!args || !['x', 'y', 'z'].every(k => Number.isSafeInteger(args[k]))) return;
  const at = receipt.observedAtEpochMs ?? receipt.actionObservation?.observedAtEpochMs ?? this.#now();
  if (!Number.isSafeInteger(at) || at < 0) return;
  const tick = receipt.actionObservation?.worldTick ?? receipt.tick;
  const receiptClock = { observedAtEpochMs: at, ...(Number.isSafeInteger(tick) && tick >= 0 ? { lastSeenTick: tick } : {}) };
  let changed = false;
  // The yield of the current approach: blocks this task broke, shown against the step that stays unchanged.
  if (receipt.reasonCode === 'BLOCK_BROKEN' && receipt.actionType === 'break_block' && firstCount(state, receipt)) {
   state.broken++; changed = true;
   recordBreaks(state, at, 1);
  }
  if (receipt.reasonCode === 'BLOCK_PLACED' && receipt.actionType === 'place_block' && identifier(args.itemId) && typeof receipt.actionId === 'string' && receipt.actionId.length <= 256) {
   const blockId = receipt.actionObservation?.target?.afterId ?? args.desiredState?.split('[')[0] ?? args.itemId;
   if (!identifier(blockId)) return;
   const previous = placementAt(state.known, { ...args, dimension: receipt.dimension });
   if (previous?.actionId === receipt.actionId || previous && previous.placedAt > at) return;
   this.#forgetPlacements(state, previous ? [previous] : [], receiptClock);
   // Bells, beds and workstations it placed itself are never evidence of a village, whatever the plan keeps.
   if (VILLAGE_POI.test(blockId)) { state.ownPoi = boundOwnPoi([...state.ownPoi, { blockId, dimension: receipt.dimension, x: args.x, y: args.y, z: args.z }]); changed = true; }
   const row = { itemId: args.itemId, blockId, dimension: receipt.dimension, x: args.x, y: args.y, z: args.z, placedAt: at, ...(Number.isSafeInteger(receiptClock.lastSeenTick) ? { placedTick: receiptClock.lastSeenTick } : {}), actionId: receipt.actionId };
   changed = Boolean(previous) || changed;
   if (relevantPlacement(row, state.plan)) {
    state.known.placements = boundPlacements([...state.known.placements.filter(p => p !== previous), row]); changed = true;
   }
  } else if (receipt.reasonCode === 'BLOCK_BROKEN' && receipt.actionType === 'break_block') {
   const p = placementAt(state.known, { ...args, dimension: receipt.dimension });
   changed = this.#forgetPlacements(state, p && (p.available !== false || newerEvidence(withdrawnClock(p), receiptClock)) && freshEvidence(placedClock(p), receiptClock) ? [p] : [], receiptClock) || changed;
  }
  if (receipt.goalRevision === record.goalRevision) state.effect = `${receipt.reasonCode === 'BLOCK_PLACED' ? 'placed' : 'broke'} ${String(receipt.actionObservation?.target?.afterId ?? receipt.actionObservation?.target?.beforeId ?? args.itemId ?? 'block').replace(/^minecraft:/, '')} at ${args.x},${args.y},${args.z}`;
  if (state.observation) changed = this.#invalidatePlacements(state, state.observation) || changed;
  if (this.#reconcile(state)) state.revision++;
  if (changed) this.#save(state);
 }
 #reconcile(state) {
  // An empty plan (the model cleared its steps) has nothing to reconcile.
  const o = state.observation; if (!o || !state.plan || state.plan.steps.length === 0) return false;
  const steps = state.plan.steps, before = steps.map(s => s.status), dead = deadSample(o);
  let changed = false;
  const unproven = new Map(), observedWorld = new Set(), strong = new Set();
  for (const step of steps) {
   let status = step.status;
   if (step.check !== null) {
    const result = evaluatePlanCheck(step.check, o, state.known);
    if (result.ok === true && result.presenceOnly) unproven.set(step.id, step);
    else if (result.ok === true) { status = 'complete'; strong.add(step.id); }
    else if (result.ok === false) status = step.status === 'complete' ? 'lost' : step.status === 'active' && dead ? 'pending' : step.status;
   } else if (step.kind === 'inventory') {
    const placements = placedItems(state.known, step.evidence.itemIds, o);
    if (dead && !placements.length) status = step.status === 'complete' ? 'lost' : step.status === 'active' ? 'pending' : step.status;
    else if (o.ready === true || placements.length) {
     const fresh = !dead && o.ready === true && !o.continuity?.rememberedSections?.includes('inventory') && placementsForItems(state.known, step.evidence.itemIds).every(p => o.observedAtEpochMs >= p.placedAt);
     const count = (fresh ? (o.inventory?.items ?? []).filter(v => step.evidence.itemIds.includes(v.itemId)).reduce((a, v) => a + v.count, 0) : 0) + placements.length;
     status = count >= step.evidence.count ? 'complete' : (fresh || dead) && step.status === 'complete' ? 'lost' : step.status;
     if (count >= step.evidence.count) strong.add(step.id);
    }
   } else if (step.kind === 'world') {
    const e = step.evidence, placement = placementAt(state.known, e), withdrawn = placement?.available === false ? placement : null;
    const row = !dead && o.ready === true && o.world?.dimension === e.dimension ? directBlockEvidence(o).get(`${e.x},${e.y},${e.z}`) : undefined;
    // The row's own time must be after any withdrawal, the placement and the last observation it would replace.
    const rowClock = row === undefined ? null : evidenceClock(row, o), rowAt = rowClock?.observedAtEpochMs ?? null;
    const block = row !== undefined && (!withdrawn || newerEvidence(withdrawnClock(withdrawn), rowClock)) && !(placement && !freshEvidence(placedClock(placement), rowClock))
     && !(Number.isFinite(state.lastObserved[step.id]) && rowAt < state.lastObserved[step.id]) ? row : undefined;
    const placed = placement && placement.available !== false && placement.blockId === e.blockId;
    if (placed) { status = 'complete'; strong.add(step.id); }
    else if (block) {
     if (block.blockId === e.blockId) { unproven.set(step.id, step); observedWorld.add(step.id); }
     else {
      if (step.status === 'complete') status = 'lost';
      for (const proof of [state.worldProof, state.presenceProof]) if (Object.hasOwn(proof, step.id)) { delete proof[step.id]; changed = true; }
     }
     const observedAt = rowAt ?? null;
     if (state.lastObserved[step.id] !== observedAt) { state.lastObserved[step.id] = observedAt; changed = true; }
    } else if (step.status === 'complete') unproven.set(step.id, step);
    if (status === 'complete' && Object.hasOwn(state.worldProof, step.id) && state.worldProof[step.id] === worldProofKey(step, steps)) strong.add(step.id);
   }
   if (status === 'complete' && step.check === null && !['inventory', 'world'].includes(step.kind)) strong.add(step.id);
   if (dead && step.status === 'complete' && status === 'lost') state.deathLosses[step.id] = (Object.hasOwn(state.deathLosses, step.id) ? state.deathLosses[step.id] : 0) + 1;
   step.status = status;
  }
  // A standing block, visit or sighting keeps qualified ordering history only within the same life.
  // Only an independent later completion proves consumed prerequisites and lets infrastructure survive death.
  for (const step of unproven.values()) if (step.status === 'complete') step.status = 'pending';
  const provenSkipped = planProgress({ steps: steps.map(s => ({ ...s, status: strong.has(s.id) ? 'complete' : s.status === 'complete' ? 'pending' : s.status })) }).skipped;
  for (let grew = true; grew;) {
   grew = false;
   const { skipped } = planProgress(state.plan);
   for (const [id, step] of unproven) {
    const key = worldProofKey(step, steps);
    const durable = step.check === null && state.worldProof[id] === key;
    const historical = state.presenceProof[id] === key;
    const consumed = step.check === null && Boolean(provenSkipped[id]) && step.dependsOn.every(d => strong.has(d) || provenSkipped[d]);
    if (step.check === null && !observedWorld.has(id) && !durable && !historical && !consumed) continue;
    if (!durable && !historical && !step.dependsOn.every(d => skipped[d] || steps.find(s => s.id === d)?.status === 'complete')) continue;
    if (consumed && !durable) { state.worldProof[id] = key; changed = true; }
    if (!dead && !historical) {
     state.presenceProof[id] = key; changed = true;
    }
    step.status = 'complete'; unproven.delete(id); grew = true;
   }
  }
  state.early = [...unproven.keys()];
  return changed || steps.some((s, i) => s.status !== before[i]);
 }
 #save(state) {
  if (!this.#directory || !state.scope) return;
  const filename = path.join(this.#directory, `${state.scope}.json`);
  const plan = state.plan ? { steps: state.plan.steps.map(({ lastObservedAt, ...s }) => s) } : null;
  const content = JSON.stringify({ version: 1, plan, revision: state.revision, lastObserved: state.lastObserved, worldProof: state.worldProof, presenceProof: state.presenceProof, deathLosses: state.deathLosses, known: state.known, lifecycle: state.lifecycle, broken: state.broken, counted: state.counted, ownPoi: state.ownPoi, ...(state.stall ? { stall: { step: state.stall.step, key: state.stall.key, since: state.stall.since, ...(Number.isSafeInteger(state.stall.broken) ? { broken: state.stall.broken } : {}) } } : {}), ...(state.intent ? { intent: state.intent, deaths: state.deaths, ...(state.wasDead ? { dead: true } : {}) } : {}) });
  this.#writes = this.#writes.catch(() => {}).then(async () => {
   await mkdir(this.#directory, { recursive: true }); await replaceFile(filename, content, 'utf8');
  });
  void this.#writes.catch(() => {});
 }
 async operate(record, tool) {
  const state = this.#state(record); await this.#load(record, state);
  if (this.#states.get(record.agentId) !== state || state.goalRevision !== record.goalRevision) throw Object.assign(new Error('Task changed while loading its plan'), { code: 'STALE_NATIVE_TOOL' });
  let authored = null;
  if (tool.operation === 'replace') {
   if (!record.currentGoal) throw new Error('No active goal to replan');
   if (!state.worldId) throw new Error('A fresh world observation is required before saving a plan');
   const plan = validateTaskPlan(tool.plan);
   authored = plan.steps.map(s => ({ ...s }));
   // Evidence, not an asserted green inventory/world node, supplies factual completion.
   for (const s of plan.steps) if ((s.check !== null || ['inventory', 'world'].includes(s.kind)) && s.status === 'complete') {
    const previous = state.plan?.steps.find(p => p.id === s.id && p.status === 'complete' && p.kind === s.kind && JSON.stringify(p.evidence) === JSON.stringify(s.evidence));
    if (s.check !== null || s.kind !== 'world' || !previous) s.status = 'pending';
   }
   state.worldProof = retainPlanProof(state.worldProof, state.plan?.steps ?? [], plan.steps);
   state.presenceProof = retainPlanProof(state.presenceProof, state.plan?.steps ?? [], plan.steps);
   state.deathLosses = Object.fromEntries(Object.entries(state.deathLosses).filter(([id]) => {
    const p = state.plan?.steps.find(s => s.id === id), s = plan.steps.find(s => s.id === id);
    return p && s && p.kind === s.kind && p.check === s.check && JSON.stringify(p.evidence) === JSON.stringify(s.evidence);
   }));
   state.plan = plan; resetProgress(state); prunePlacements(state.known, plan); state.lastObserved=Object.fromEntries(Object.entries(state.lastObserved).filter(([id])=>plan.steps.some(s=>s.id===id))); state.revision++; this.#reconcile(state); this.#save(state);
  }
  if (tool.operation === 'intent') {
   if (!record.currentGoal) throw new Error('No active goal for an intent');
   if (!state.worldId) throw new Error('A fresh world observation is required before saving an intent');
   const intent = validateIntent(tool.intent);
   // Facts at the moment of writing, so later wakes can show what changed since.
   state.intent = { ...intent, inPlan: Boolean(state.plan?.steps.some(s => s.id === intent.step)), deaths: state.deaths, ...(identifier(state.observation?.world?.dimension) ? { dimension: state.observation.world.dimension } : {}), at: this.#now() };
   noteIntent(state, intent, this.#now());
   this.#save(state);
   // The next event's now shows the intent; the reply only confirms it and its validity.
   return { state: 'SUCCEEDED', reasonCode: 'INTENT_SAVED', valid: this.continuity(record)?.valid ?? 'unchecked' };
  }
  // Every read re-checks each step against the current inventory, armour, dimension and placements (plan-drop credit included).
  if (tool.operation === 'read' && this.#reconcile(state)) { state.revision++; this.#save(state); }
  const checked = planEvidence(state.plan, authored);
  const open = planProgress(state.plan)?.open ?? [];
  const first = state.plan?.steps.find(s => s.id === state.intent?.step && s.status !== 'complete') ?? state.plan?.steps.find(s => open.includes(s.id));
  // The whole requirement chain, uncut, for the step the wake line abbreviates.
  const found = first ? requirementChain(first, state) : null;
  const prerequisites = found?.parts.length ? { step: first.id, chain: found.parts } : null;
  // Points at on-demand strategy topics relevant to unfinished steps; reading them stays the model's choice.
  const strategy = strategyHints({ goal: state.goal, plan: state.plan, dimension: state.observation?.world?.dimension });
  const options = this.#options(record, state);
  return { goal: state.goal, revision: state.revision, plan: structuredClone(state.plan), advisory: true, ...(prerequisites === null ? {} : { prerequisites }), ...(options === null ? {} : { options }), ...(checked === null ? {} : { checked }), ...(strategy === null ? {} : { strategy }) };
 }
 async receipt(record, { advancementId, entityType, advancements = [], verifiedKills = [] } = {}) {
  const state = this.#state(record); await this.#load(record, state);
  if (this.#states.get(record.agentId) !== state) return;
  const changed = rememberPlanFacts(state.known, { advancements: [...advancements, ...(advancementId ? [advancementId] : [])], verifiedKills: [...verifiedKills, ...(entityType ? [entityType] : [])] });
  if (this.#reconcile(state)) state.revision++;
  if (changed) this.#save(state);
 }
 progress(record) {
  if (!record.currentGoal) return null;
  return this.#progressLine(this.#state(record));
 }
 /**
  * The first wake line: the plan's own counted needs as have/need (its has:item*N checks) and the step being worked
  * (the intent's step, else the first open one). It reads the saved plan, so it stands through rotation and death.
  */
 goalLine(record) {
  if (!record.currentGoal) return null;
  const state = this.#state(record), facts = planProgress(state.plan);
  if (!facts) return null;
  const next = firstUnfinished(state);
  const counts = new Map();
  const steps = [next, ...state.plan.steps.filter(s => s !== next && s.status !== 'complete' && !facts.skipped[s.id])];
  for (const step of steps) {
   if (!step || typeof step.check !== 'string') continue;
   let result;
   try { result = evaluatePlanCheck(step.check, state.observation, state.known); } catch { continue; }
   // An either-or check (rods | powder | eyes) counts its first item, the one the plan leads with, until any one is met.
   if (result.any && result.ok === true) continue;
   for (const term of result.any ? result.terms.slice(0, 1) : result.terms) {
    if (term.type !== 'has' || !(term.count > 1 || step === next)) continue;
    const key = term.ids.join('|'), seen = counts.get(key);
    if (!seen || term.count > seen.count) counts.set(key, term);
   }
  }
  const items = [...counts.values()].slice(0, GOAL_LINE_ITEMS).map(term => term.reason);
  const parts = [...(items.length ? [items.join(', ')] : []), ...(next ? [`next: ${next.id}`] : [])];
  return parts.length ? parts.join('; ') : null;
 }
 /** One goal skill whose preconditions hold now (skill-fits.mjs), from the plan's open counted needs; null otherwise. */
 skillLine(record) {
  const needs = this.openNeeds(record, { frame: true });
  if (!needs.length) return null;
  const state = this.#state(record), { known } = this.#memory(record, state);
  return skillFitsLine({ observation: state.observation, needs, sightings: (known?.sightings ?? []).map(row => ({ ...row, kind: sightingKind(row) })), lavaPools: state.known.lavaPools ?? [] });
 }
 /**
  * The plan's open counted needs in plan order (the next unfinished step first): { id, have, need, step, label } for
  * each has: term not yet met. frame:true adds an open Nether entry's 10-obsidian frame need.
  */
 openNeeds(record, { frame = false } = {}) {
  if (!record.currentGoal) return [];
  const state = this.#state(record), facts = planProgress(state.plan);
  if (!facts) return [];
  const next = firstUnfinished(state), needs = [];
  let nether = false;
  for (const step of [next, ...state.plan.steps.filter(s => s !== next && s.status !== 'complete' && !facts.skipped[s.id])]) {
   if (!step || typeof step.check !== 'string') continue;
   let result;
   try { result = evaluatePlanCheck(step.check, state.observation, state.known); } catch { continue; }
   if (result.any && result.ok === true) continue;
   for (const term of result.any ? result.terms.slice(0, 1) : result.terms) {
    if (term.type === 'has' && term.ok === false && Number.isFinite(term.metric)) needs.push({ id: term.ids[0], have: term.metric, need: term.count, step: step.id, label: step.label });
    if (['in', 'visited'].includes(term.type) && term.id === 'minecraft:the_nether' && term.ok === false) nether = true;
   }
  }
  // An open Nether entry needs a 10-obsidian frame (held obsidian plus the best seen unlit frame here).
  const items = state.observation?.inventory?.items, dimension = state.observation?.world?.dimension;
  if (frame && nether && Array.isArray(items) && !needs.some(n => n.id === 'minecraft:obsidian') && !(state.known.frames ?? []).some(f => f.lit && f.dimension === dimension)) {
   const held = items.filter(i => i?.itemId === 'minecraft:obsidian').reduce((n, i) => n + (i.count > 0 ? i.count : 0), 0);
   const framed = (state.known.frames ?? []).filter(f => f.dimension === dimension).reduce((n, f) => Math.max(n, f.obsidian), 0);
   if (held + framed < 10) needs.push({ id: 'minecraft:obsidian', have: held + framed, need: 10 });
  }
  return needs;
 }
 #progressLine(state) {
  const plan = state.plan;
  const facts = planProgress(plan);
  if (!facts) return null;
  const byId = new Map(plan.steps.map(s => [s.id, s]));
  const pieces = [];
  const add = (text, ids = []) => pieces.push({ text, ids });
  // The model's intent step stays first whatever its state; no other step is singled out as next.
  const intendedId = state.intent?.step, intended = byId.get(intendedId);
  const first = intended && intended.status !== 'complete' ? intended : byId.get(facts.open[0]);
  const needs = first ? stepNeeds(first, state).filter(Boolean).map(need => need.id) : [];
  const found = first ? requirementChain(first, state) : null;
  // A checked missing item is more precise than the step label or later open steps. When the chain needs a source
  // found only in the never-entered Nether (blaze rods for eyes), that dimension is the relevant topic.
  const netherGated = Boolean(found?.key.includes('the_nether(unvisited)'));
  const strategy = strategyHints(needs.length
   ? { includeMechanics: true, goal: `${netherGated ? 'nether ' : ''}${needs.map(id => id.replace(/^minecraft:/, '').replaceAll('_', ' ')).join(' ')}` }
   : { plan: { steps: first ? [first] : [] }, dimension: state.observation?.world?.dimension });
  // Only the first unfinished step carries elapsed progress; source details are on demand.
  let withStall = true;
  const now = Number.isFinite(state.observation?.observedAtEpochMs) ? state.observation.observedAtEpochMs : this.#now();
  // The first unfinished step also carries its requirement chain, outside the line's byte cap.
  let chain = '';
  const requirement = step => {
   let text = progressRequirement(step, state, withStall, now);
   if (withStall && step === first) { if (found?.gated) chain = `; ${chainText(found.parts, CHAIN_BYTES)}`; }
   withStall = false; return text;
  };
  if (intendedId !== undefined) add(`intent ${intendedId}[${!intended ? 'not in plan' : intended.status === 'complete' ? 'complete' : requirement(intended)}]`, intended ? [intendedId] : []);
  if (chain) pieces.at(-1).chain = chain;
  // Open steps in the plan's own order, each with the same detailed facts (status, held tier, losses).
  for (const id of facts.open) if (id !== intendedId) {
   add(`open ${id}[${requirement(byId.get(id))}]`, [id]); if (chain && !pieces.some(piece => piece.chain)) pieces.at(-1).chain = chain;
   // A count already partly gathered (6 of 12 pearls) is the need a player keeps working on; it keeps its place on the line.
   const step = byId.get(id), result = step.check === null ? null : evaluatePlanCheck(step.check, state.observation, state.known);
   if (result?.ok === false && result.terms.some(t => t.type === 'has' && t.ok === false && t.metric > 0)) pieces.at(-1).started = true;
  }
  const reported = plan.steps.filter(s => s.id !== intendedId && s.status === 'complete' && s.check === null && !['inventory', 'world'].includes(s.kind));
  if (reported.length) add(`reported ${reported.map(s => s.id).join(',')}[unverified]`, reported.map(s => s.id));
  const done = plan.steps.filter(s => s.id !== intendedId && s.status === 'complete' && !reported.includes(s));
  const placementDetails = new Map();
  for (const step of done) {
   const rows = placementRows(step, state);
   if (rows.length) placementDetails.set(step.id, rows[0]);
  }
  const placementGroups = new Map();
  for (const [id, p] of placementDetails) {
   if (!placementGroups.has(p)) placementGroups.set(p, []); placementGroups.get(p).push(id);
  }
  for (const [p, ids] of placementGroups) add(`done ${ids.join(',')}[${placementText(p, state.observation, this.#now())}]`, ids);
  const otherDone = done.filter(s => !placementDetails.has(s.id));
  if (otherDone.length) add(`done ${otherDone.map(s => s.id).join(',')}`, otherDone.map(s => s.id));
  const early = new Set(state.early ?? []);
  for (const id of early) {
   const step = byId.get(id); if (!step || facts.skipped[id]) continue;
   add(`early ${id}[before ${step.dependsOn.filter(d => byId.get(d)?.status !== 'complete' && !facts.skipped[d]).join(',')}]`, [id]);
  }
  if (strategy) add(`strategy:${strategy.topics[0]}`);
  for (const step of plan.steps) {
   if (step.id === intendedId || step.status === 'complete' || facts.open.includes(step.id) || early.has(step.id)) continue;
   const result = step.check === null ? null : evaluatePlanCheck(step.check, state.observation, state.known);
   if (result?.partial || result?.terms.length > 1) add(`partial ${step.id}[${result.reason}]`, [step.id]);
  }
  const skippedGroups = new Map();
  for (const step of plan.steps) {
   const later = facts.skipped[step.id]; if (!later) continue;
   if (!skippedGroups.has(later)) skippedGroups.set(later, []); skippedGroups.get(later).push(step.id);
  }
  for (const [later, ids] of skippedGroups) add(`skipped ${ids.join(',')} via ${later}`, ids);
  const later = plan.steps.filter(s => s.id !== intendedId && s.status !== 'complete' && !facts.open.includes(s.id) && !facts.skipped[s.id] && !early.has(s.id));
  if (later.length) add(`later:${later.length}`, later.map(s => s.id));
  let measured = 0;
  let omitted = new Set(plan.steps.map(s => s.id));
  const kept = new Set();
  // Started steps claim the budget first; the line keeps the plan's order.
  for (const piece of [...pieces.filter(p => p.started), ...pieces.filter(p => !p.started)]) {
   const remaining = new Set([...omitted].filter(id => !piece.ids.includes(id)));
   const tail = remaining.size > 0 ? `; +${remaining.size} more` : '';
   // The chain is paid for outside the line budget, so it never displaces another step.
   const size = measured + (measured ? 2 : 0) + Buffer.byteLength(piece.text);
   if (size + Buffer.byteLength(tail) > 240) continue;
   measured = size; kept.add(piece); omitted = remaining;
  }
  let line = pieces.filter(piece => kept.has(piece)).map(piece => piece.chain ? `${piece.text.slice(0, -1)}${piece.chain}]` : piece.text).join('; ');
  if (omitted.size > 0) line += `; +${omitted.size} more`;
  return line;
 }
 /** The wake header: the model's working intent, checked against the plan and observed facts. */
 continuity(record, { observation = null, orders = null, guardInstalled = undefined, guardCoverage = null, annotate = null } = {}) {
  if (!record.currentGoal) return null;
  const current = this.#state(record);
  // An event built from an older sample states that sample's facts: its step statuses, results, effect and dimension.
  const sample = observation && Number.isFinite(observation.observedAtEpochMs) ? current.samples.findLast(row => row.at === observation.observedAtEpochMs) : undefined;
  const state = sample ? sampleView(current, sample) : current;
  const shown = sample ? state.observation : observation ?? state.observation;
  const dimension = shown?.world?.dimension ?? state.liveDimension;
  // The running action and the results must describe one moment: an older observation no longer in the sample
  // cache would pair its running action with newer results, so it states no running action.
  const coherent = sample !== undefined || observation === null || observation === current.observation;
  const sampledAction = coherent ? (sample ? state.observation : current.observation)?.currentAction ?? null : null;
  const currentAction = current.observation?.currentAction;
  // Queued samples can still be cached after their action finishes. Present-tense wording needs current evidence.
  const running = currentAction?.active === true && sampledAction?.actionId === currentAction.actionId
   && sampledAction?.actionType === currentAction.actionType ? sampledAction : null;
  // Local stand-in for a shared fact lifecycle's since(mark), same shape.
  const since = state.intent ? { deaths: Math.max(0, state.deaths - (state.intent.deaths ?? 0)),
   ...(identifier(dimension) && state.intent.dimension && state.intent.dimension !== dimension ? { dimension: { from: state.intent.dimension, to: dimension } } : {}) } : null;
  const nearThreats = (shown?.player?.threats ?? []).filter(t => t.swelling === true || Number.isFinite(t.distance) && t.distance <= 16);
  const guardThreatsNear = nearThreats.length, guardThreatsTargeting = nearThreats.filter(t => t.targeting === true).length;
  const stepProgress = progressFacts(current, Number.isFinite(current.observation?.observedAtEpochMs) ? current.observation.observedAtEpochMs : this.#now(), progressFocus(current));
  return composeContinuityHeader({ goal: record.currentGoal, intent: state.intent, evidence: intentEvidence(state), since, progress: this.#progressLine(state), stepProgress: stepProgress.progress ?? null, repeats: stepProgress.repeats ?? null, ...this.#memoryFacts(record, state, shown, observation?.recovery ?? null), results: state.results, running, effect: state.effect, orders, guardInstalled, guardCoverage, guardThreatsNear, guardThreatsTargeting, annotate });
 }
 /** The trigger for a no-progress or repeated-result fact not yet woken for ('no_progress' | 'repeated_result'), once. */
 progressWake(record) {
  if (!record.currentGoal) return null;
  const state = this.#states.get(record.agentId);
  return state && state.goalRevision === record.goalRevision ? takeProgressWake(state) : null;
 }
 /**
  * Ways to get what the first unfinished step (the one the stall clock follows) still lacks: remembered sightings and
  * blocks nearest first, then typical vanilla ways. Null unless that step is unmet with a need of a known resource.
  */
 #options(record, state, memory = this.#memory(record, state)) {
  const step = firstUnfinished(state), { position, known, placed } = memory;
  // Held items and a frame in view feed the obsidian estimates.
  const items = Array.isArray(state.observation?.inventory?.items) ? state.observation.inventory.items : [];
  const frames = Array.isArray(state.observation?.sighted?.portalFrames) ? state.observation.sighted.portalFrames : [];
  // A checked dimension milestone names access, not a mandatory next pickaxe tier. These are alternative sources
  // for the authored requirement; the model still chooses its route and preparation.
  const nether = (candidate) => {
   if (!candidate?.check || state.observation?.world?.dimension !== 'minecraft:overworld') return null;
   const check = evaluatePlanCheck(candidate.check, state.observation, state.known);
   if (check.any || !check.terms.some(t => t.ok === false && ['in', 'visited'].includes(t.type) && t.id === 'minecraft:the_nether')) return null;
   // A frame also needs a light: without flint and steel or a fire charge, flint is the missing ingredient.
   const lit = (state.observation?.inventory?.items ?? []).some(item => ['minecraft:flint_and_steel', 'minecraft:fire_charge'].includes(item?.itemId) && item.count > 0);
   const sources = needOptions({ resources: lit ? ['obsidian'] : ['obsidian', 'flint'], basis: `step ${candidate.id}: Nether access; casting needs no diamond pick`, position, known, placed, items, frames, cap: NETHER_OPTIONS_BYTES });
   const kit = netherReadiness(state.observation) ?? (portalAtHand(state.observation) ? null : descentRespawnFact({ position, placed, items }));
   return kit === null ? sources : `${sources} | ${kit}`;
  };
  // A depth, lava or frame sub-step is part of the plan's Nether access: the access options stay those of that step.
  // So is a portal kit step (the water bucket that casts, the light): its item alone would show only iron sources and
  // hide the lava estimates the kit is for; the access options name both missing kit items.
  const terms = step?.check && step.status !== 'complete' ? parsePlanCheck(step.check).terms : [];
  const kitStep = terms.length > 0 && terms.every(t => t.type === 'has' && t.ids.every(id => PORTAL_KIT.has(id)));
  const stage = kitStep || terms.some(t => ['y', 'lava', 'frame'].includes(t.type));
  const openNether = () => nether(state.plan.steps.find(s => s.status !== 'complete' && /\b(in|visited):minecraft:the_nether\b/.test(s.check ?? '')));
  const kitAccess = kitStep ? openNether() : null;
  if (kitAccess) return kitAccess;
  const ids = step && step.status !== 'complete' ? stepNeeds(step, state).filter(Boolean).map(need => need.id) : [];
  const pearls = { observation: deadSample(state.observation) ? null : state.observation, pearls: pearlsWanted(step?.check) };
  if (ids.length) return needOptions({ ids, chainKey: requirementChain(step, state, { counted: true })?.key ?? null, position, known, placed, items, frames, ...pearls });
  const access = nether(step) ?? (stage ? openNether() : null);
  if (access) return access;
  // A plan with every step done needs nothing.
  if (state.plan && !step) return null;
  // Without a checked need: the resources the intent or the first unfinished step asks for, else, for a goal of
  // progressing through the game, the next pickaxe tier.
  const intent = state.intent, sources = [];
  if (intent) sources.push([`intent ${intent.step}`, [intent.step, intent.why, intent.next].join(' ')]);
  if (step && step.id !== intent?.step) sources.push([`step ${step.id}`, `${step.label} ${step.detail}`]);
  for (const [basis, text] of sources) {
   const resources = textResources(text);
   if (resources.length) return needOptions({ resources, basis, position, known, placed, items, frames, ...pearls });
  }
  // A plan whose unmet outcome has no known source must not silently acquire a different equipment goal.
  if (step?.check) return null;
  // An unchecked first step (a manual preparation) leaves the plan's open Nether milestone the next checked
  // outcome: its sources, not the next pickaxe tier, which would make diamonds look like the route.
  const open = planProgress(state.plan)?.open ?? [];
  for (const later of state.plan?.steps ?? []) {
   const options = later !== step && open.includes(later.id) ? nether(later) : null;
   if (options) return options;
  }
  const o = state.observation;
  if (!progressionGoal(record.currentGoal) && !progressionGoal(state.goal)) return null;
  if (deadSample(o) || o?.ready !== true || !Array.isArray(o.inventory?.items) || o.continuity?.rememberedSections?.includes('inventory')) return null;
  const tier = pickaxeTier(o.inventory.items);
  return tier === null ? null : needOptions({ ...tier, position, known, placed });
 }
 /**
  * The bed-by-the-portal option while the plan's next dimension is still ahead: the Nether once a portal is at hand,
  * the End once an eye is held or an end portal frame is in view. Null otherwise.
  */
 #spawnOption(state) {
  const o = state.observation;
  if (deadSample(o) || o?.world?.dimension !== 'minecraft:overworld') return null;
  // A respawn already set beside the player (the bed by this portal) needs no option.
  const at = o?.position ?? o?.player, spawn = state.known?.spawn;
  if (spawn?.kind === 'set' && spawn.dimension === 'minecraft:overworld' && [at?.x, at?.z].every(Number.isFinite) && Math.hypot(spawn.x - at.x, spawn.z - at.z) <= 24) return null;
  const endNear = () => (o.inventory?.items ?? []).some(item => item?.itemId === 'minecraft:ender_eye' && item.count > 0)
   || (Array.isArray(o.blocks) && o.blocks.some(row => row?.blockId === 'minecraft:end_portal_frame' || row?.blockId === 'minecraft:end_portal'));
  const respawn = spawn?.kind === 'set' ? `your respawn now: ${spawn.x},${spawn.y},${spawn.z}${[at?.x, at?.z].every(Number.isFinite) ? `, ${Math.round(Math.hypot(spawn.x - at.x, spawn.z - at.z))} blocks away` : ''}` : null;
  const option = target => { const text = bedSpawnOption(o, target); return text && respawn ? `${text}; ${respawn}` : text; };
  for (const step of state.plan?.steps ?? []) {
   if (step.status === 'complete' || !step.check) continue;
   const target = /\b(?:in|visited):minecraft:the_(nether|end)\b/.exec(step.check)?.[1];
   if (!target) continue;
   const check = evaluatePlanCheck(step.check, o, state.known);
   if (check.any || !check.terms.some(t => t.ok === false && ['in', 'visited'].includes(t.type))) continue;
   const near = target === 'nether' ? portalAtHand(o) : endNear();
   return near ? option(target) : null;
  }
  // Without such a plan step, a portal in front of the player is the same moment.
  if (Array.isArray(o.blocks) && o.blocks.some(row => row?.blockId === 'minecraft:end_portal')) return option('end');
  if (Array.isArray(o.sighted?.portalFrames) && o.sighted.portalFrames[0]?.lit === true) return option('nether');
  return null;
 }
 /** Position, remembered sources and own placements of the shown sample; known is null without memory. */
 #memory(record, state) {
  // The wire carries position; the adapted observation the coordinator stores carries it as player.x/y/z.
  const o = state.observation, at = o?.position ?? o?.player?.position ?? o?.player;
  const position = !deadSample(o) && at && [at.x, at.y, at.z].every(Number.isFinite) ? { x: at.x, y: at.y, z: at.z } : null;
  let known = null;
  try { known = position && this.#sources ? this.#sources(record, o, SOURCE_BLOCKS) : null; } catch { /* missing memory leaves only the typical ways */ }
  // Blocks the agent placed (its own bed, smoker, crafting table) are no evidence of a village.
  const dimension = o?.world?.dimension;
  const placed = [...state.ownPoi.filter(p => p.dimension === dimension), ...(state.known?.placements ?? []).filter(p => p.dimension === dimension), ...(Array.isArray(o?.leftBehind) ? o.leftBehind : []), ...(known?.placed ?? [])];
  return { position, known, placed };
 }
 /** Wake facts from the shown sample: remembered sources, mining yield, daylight and current tool wear. */
 #memoryFacts(record, state, observation = state.observation, recovery = null) {
  const memory = this.#memory(record, state);
  const unmet = firstUnfinished(state);
  const drops = deathDropsLead(recovery, memory.position, observation?.world?.dimension ?? state.liveDimension,
   unmet && unmet.status !== 'complete' ? stepNeeds(unmet, state).filter(Boolean).map(need => need.id) : [], observation);
  const needs = this.#options(record, state, memory), known = knownLine(memory);
  const spawn = this.#spawnOption(state);
  // Rods or pearls still open in the plan, or a progression goal without one.
  const open = state.plan ? state.plan.steps.filter(s => s.status !== 'complete').map(s => `${s.check ?? ''} ${s.label} ${s.detail}`).join('\n')
   : progressionGoal(record.currentGoal) ? 'ender_pearl blaze_rod' : '';
  const route = deadSample(state.observation) ? null : netherRouteOption({ observation: state.observation, known: memory.known, position: memory.position, open });
  const search = deadSample(state.observation) ? null : fortressSearchOption({ observation: state.observation, known: memory.known, position: memory.position, open });
  // Without a plan, a goal that names pearls ("get 4 ender pearls") is the open need.
  const pearls = needs?.includes('ender_pearl:') ? null : this.#pearlOptions(state, memory, open || (state.plan ? '' : record.currentGoal ?? ''));
  // The pearl sources come before the general route and search lines, and before the first step's own needs while one
  // is in view now (an enderman, or calm piglins with gold held).
  const order = pearls !== null && pearlSourceInView(state.observation) ? [drops, pearls, needs, spawn, route, search] : [drops, needs, spawn, pearls, route, search];
  const options = order.filter(part => part !== null).join(' | ') || null;
  const hunt = deadSample(state.observation) ? null : pearlHuntLine({ observation: state.observation, position: memory.position, open: open || (state.plan ? '' : record.currentGoal ?? '') });
  let mining = miningYield(state, Number.isFinite(state.observation?.observedAtEpochMs) ? state.observation.observedAtEpochMs : this.#now());
  const picks = mining === null ? null : picksLine(observation);
  if (picks !== null) mining += `; picks now: ${picks}`;
  const step = firstUnfinished(state), intent = state.intent;
  const craft = affordableCrafts(step, { ...state, observation });
  const activity = intent ? `${intent.step} ${intent.why}` : step ? `${step.label} ${step.detail}` : record.currentGoal;
  const sleep = sleepLine(observation) ?? spawnLine(observation, state.known?.spawn ?? null);
  const casting = castingLine(observation, { goal: `${record.currentGoal} ${activity}` });
  const light = lightLine(observation), tools = toolsLine(observation, { activity }), frame = frameLine(observation);
  return { ...(hunt === null ? {} : { hunt }), ...(craft === null ? {} : { craft }), ...(casting === null ? {} : { casting }), ...(frame === null ? {} : { frame }), ...(known === null ? {} : { known }), ...(options === null ? {} : { options }), ...(mining === null ? {} : { mining }), ...(light === null ? {} : { light }), ...(sleep === null ? {} : { sleep }), ...(tools === null ? {} : { tools }) };
 }
 /**
  * Pearl sources while pearls (or eyes) are an open plan need but not the first unfinished step's: in the Nether, or in
  * the Overworld at night or with an enderman in view. Elsewhere the line would repeat in every wake for nothing to act on.
  */
 #pearlOptions(state, memory, open) {
  const o = state.observation;
  if (deadSample(o) || memory.position === null || !/\bender_(pearl|eye)\b|\b(ender )?pearls?\b|\beyes? of ender\b/i.test(open)) return null;
  if (!Array.isArray(o?.inventory?.items) || o.continuity?.rememberedSections?.includes('inventory')) return null;
  const tick = ((Number(o.world?.dayTime) % 24000) + 24000) % 24000;
  const overworld = o.world?.dimension === 'minecraft:overworld' && (tick >= 13000 && tick < 23000 || (o.entities ?? []).some(e => e?.type === 'minecraft:enderman'));
  if (o.world?.dimension !== 'minecraft:the_nether' && !overworld) return null;
  return pearlOptions({ observation: o, position: memory.position, known: memory.known, items: o.inventory.items, needed: pearlsWanted(open) ?? 12 });
 }
 /** The model's authored intent for other references (how-to, orientation) to point at; never a replacement for it. */
 intent(record) {
  const intent = record.currentGoal ? this.#state(record).intent : null;
  return intent ? { step: intent.step, ...(intent.next ? { next: intent.next } : {}) } : null;
 }
 event(record, stage, value) {
  const state = this.#state(record);
  if (stage === 'live_usage') { try { updateUsage(state, record, JSON.parse(value), this.#now()); } catch {} return; }
  if (stage === 'live_allowance') { try { state.allowance = allowance(JSON.parse(value)); } catch {} return; }
  const message = sanitizeDiagnosticText(String(value), { maxBytes: 1024 });
  if (!message) return;
  if (['live_delta','live_summary'].includes(stage) && state.events.at(-1)?.stage === stage) state.events.at(-1).message = message;
  else state.events.push({ sequence: ++state.sequence, stage: text(stage, 40, false), message, at: this.#now() });
  while (Buffer.byteLength(JSON.stringify(state.events)) > 8192) state.events.shift();
 }
 /** This task's lifecycle for facts written now (the working intent): keep mark(), later read since(mark). */
 lifecycle(record) { return this.#state(record).lifecycle; }
 snapshot(record) {
  const s = this.#state(record);
  return { goalRevision: record.goalRevision, goal: displayGoal(s.goal), active: Boolean(record.currentGoal), verified: s.verified, revision: s.revision, plan: structuredClone(s.plan), lastObserved: { ...s.lastObserved }, events: [...s.events], usage: s.usage, allowance: s.allowance, generatedAt: this.#now() };
 }
 /**
  * Resource vocabulary the model authored in its own active plan steps: has: ids/tags from checks, inventory evidence
  * itemIds and step labels. Pending, complete and lost steps, other tasks, revisions and worlds contribute nothing.
  */
 activeResourceVocabulary(record, worldId = null) {
  const state = this.#states.get(record.agentId), identity = taskIdentity(record);
  if (!state?.plan || state.goalRevision !== record.goalRevision || identity === null || state.taskIdentity !== identity) return null;
  if (worldId !== null && state.worldId !== worldId) return null;
  const ids = new Set(), labels = [];
  for (const step of state.plan.steps) {
   if (step.status !== 'active') continue;
   labels.push(step.label);
   if (step.check !== null) {
    for (const term of parsePlanCheck(step.check)?.terms ?? []) if (term.type === 'has') for (const id of term.ids) ids.add(id);
   } else if (step.kind === 'inventory') for (const id of step.evidence?.itemIds ?? []) ids.add(id);
  }
  return labels.length === 0 ? null : { ids: [...ids], text: labels.join(' ') };
 }
 verified(record) { this.#state(record).verified=true; }
 /** Stations this agent placed that are still standing as far as its observations know. */
 placedStations(record) {
  return (this.#states.get(record.agentId)?.known.placements ?? []).filter(p => p.available !== false && functionalPlacement(p.itemId));
 }
 begin(record, { fresh = false } = {}) {
  // Explicit new tasks discard previous terminal output and task milestones, including identical text.
  if (fresh) {
   const previous = this.#states.get(record.agentId), state = this.#newState(record, true);
   this.#states.set(record.agentId, state);
   // Clear a reused task file immediately, even if the coordinator restarts before the first new sample.
   if (previous?.worldId) {
    state.scope = createHash('sha256').update(JSON.stringify([previous.worldId, record.agentId, state.goal])).digest('hex');
    this.#save(state); state.scope = null;
   }
  }
  else {
   const previous = this.#states.get(record.agentId);
   // Legacy records lack an immutable spec. Explicit steer/resume retains their
   // existing task, while start/replace always takes the fresh branch above.
   if (previous?.taskIdentity?.startsWith('prompt:') && !record.currentGoalSpec?.fingerprint) previous.taskIdentity = taskIdentity(record);
   this.#state(record).verified=false;
  }
 }
 async flush() { await this.#writes; }
}
function progressRequirement(step, state, withStall = false, now = null) {
 let requirement;
 if (step.check !== null) {
  const result = evaluatePlanCheck(step.check, state.observation, state.known);
  const unmet = result.terms.filter(t => t.ok !== true);
  // One unmet item names its howto topic in place of the unmet: label, at no extra bytes.
  const label = result.ok === false && unmet.length === 1 && unmet[0].type === 'has' && unmet[0].ok === false && howtoTopic(unmet[0].ids) ? 'howto' : result.ok === null ? 'unknown' : result.ok ? 'met' : 'unmet';
  requirement = `${label}:${(unmet.length ? unmet : result.terms).map(t => t.ok === null ? t.reason.replace(/\d+(?=\/)/g, '?') : t.reason).join(result.any ? ' or ' : ', ')}`;
  // The situation line already names the best pickaxe; other tool kinds say which one is held.
  const tool = unmet.find(t => t.type === 'tool' && t.kind !== 'pickaxe');
  const held = !deadSample(state.observation) && tool && (state.observation?.inventory?.items ?? []).reduce((best, item) => {
   if (!(item.count > 0) || !item.itemId.startsWith('minecraft:') || !item.itemId.endsWith(`_${tool.kind}`)) return best;
   const rank = TOOLS.indexOf(item.itemId.slice(10).split('_')[0]);
   return rank > (best ? TOOLS.indexOf(best.itemId.slice(10).split('_')[0]) : -1) ? item : best;
  }, null);
  if (held) requirement += `; have:${held.itemId.slice(10)}`;
  if (unmet.some(t => t.type === 'has' && t.ids.length === 1 && t.ids[0] === 'minecraft:bucket')) {
   const filled = !deadSample(state.observation) && !state.observation?.continuity?.rememberedSections?.includes('inventory')
    && state.observation?.inventory?.items?.find(v => v.count > 0 && ['minecraft:water_bucket', 'minecraft:lava_bucket'].includes(v.itemId));
   if (filled) requirement += `; have:${filled.itemId.slice(10)} (check requires empty)`;
  }
 } else if (step.kind === 'inventory') {
  const e = step.evidence, o = state.observation;
  const count = deadSample(o) ? 0 : o?.ready === true ? (o.inventory?.items ?? []).filter(v => e.itemIds.includes(v.itemId)).reduce((n, v) => n + v.count, 0) : '?';
  const ids = e.itemIds.map(id => id.replace(/^minecraft:/, '')).join('|');
  requirement = count !== '?' && howtoTopic(e.itemIds) ? `howto:${ids} ${count}/${e.count}` : `${count === '?' ? 'unknown' : 'unmet'}:held ${ids} ${count}/${e.count}`;
 } else if (step.kind === 'world') {
  requirement = `${step.status === 'lost' ? 'lost' : 'unverified'}:${step.label}`;
 } else {
  requirement = `unverified:${step.detail || step.label}`;
 }
 if (Object.hasOwn(state.deathLosses ?? {}, step.id)) requirement += `; lost at death ×${state.deathLosses[step.id]}`;
 if (withStall && state.stall?.step === step.id && Number.isFinite(now) && now - state.stall.since >= STALL_SHOWN_MS) requirement += `; unchanged ${Math.floor((now - state.stall.since) / 60_000)}m${Number.isSafeInteger(state.stall.broken) ? `, ${state.broken - state.stall.broken} blocks broken` : ''}`;
 if (Buffer.byteLength(requirement) <= 148) return requirement;
 let bounded = '';
 for (const character of requirement) {
  if (Buffer.byteLength(bounded + character) > 148) return bounded + '...';
  bounded += character;
 }
 return bounded;
}
/** Items an unmet step still needs: each unmet check term's item, or a single-item inventory step's item. */
/** Unmet needs of a step as { id, count }: each unmet check term's item and remaining quantity, or null when unknown. */
// Gear and the materials of a need: what a player would walk back to their death spot for.
const GEAR_ID = /_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$|^minecraft:(bucket|water_bucket|lava_bucket|shield|bow|crossbow|flint_and_steel|shears)$/;
const material = id => id.replace(/^minecraft:(raw_)?/, '').split('_')[0];
const DIMENSION_NAMES = { 'minecraft:overworld': 'the Overworld', 'minecraft:the_nether': 'the Nether', 'minecraft:the_end': 'the End' };
/** The last death's lost gear and need materials as a source lead, while its drops can still exist; null otherwise. */
export function deathDropsLead(recovery, position, dimension, ids, observation = null) {
 const death = recovery?.lastDeath, clock = recovery?.dropTicking;
 if (!death || !position || typeof death.dimensionId !== 'string' || !Array.isArray(recovery.lastLostInventory)) return null;
 if (clock && clock.tickedSeconds >= 300) return null;
 // The void keeps nothing: Sol was offered a kit at y-229 below the End island.
 const loss = dropLoss(death);
 if (loss === 'void') return null;
 const materials = new Set(ids.map(material));
 const lost = recovery.lastLostInventory.filter(({ itemId, count }) => count > 0 && (ids.includes(itemId) || GEAR_ID.test(itemId) || materials.has(material(itemId))));
 if (lost.length === 0) return null;
 const cell = `@${Math.floor(death.x)},${Math.floor(death.y)},${Math.floor(death.z)}`;
 // A Nether death respawns the player in the Overworld; the kit waits there, its clock paused while no one is near
 // (run d9-nether-e lost full iron and a blaze rod at the fortress and rebuilt from logs for 30 min instead).
 const distance = Math.round(Math.hypot(death.x - position.x, death.z - position.z)), dy = Math.round(death.y - position.y);
 const where = death.dimensionId !== dimension ? `in ${DIMENSION_NAMES[death.dimensionId] ?? death.dimensionId} ${cell}`
  : `${distance}m${distance < 1 ? '' : ` ${headingOf(death.x - position.x, death.z - position.z)}`}${Math.abs(dy) >= 4 ? ` dy${dy > 0 ? '+' : ''}${dy}` : ''} ${cell}`;
 const items = lost.slice(0, 6).map(({ itemId, count }) => `${itemId.replace(/^minecraft:/, '')}${count > 1 ? ` x${count}` : ''}`).join(', ');
 const left = clock ? (clock.tickedSeconds >= 240 ? 'under 1 min' : `~${Math.floor((300 - clock.tickedSeconds) / 60)} min`) + ` of drop time left${clock.tickingNow ? ', ageing' : ', paused while you are away'}` : 'drop time unknown';
 const way = death.dimensionId !== dimension ? wayBackShort(death, observation) : null;
 return `death drops ${where}${loss === 'lava' ? ' (died in lava: what fell in burned)' : ''}: ${items}${lost.length > 6 ? ` +${lost.length - 6} more` : ''} (${left})${way ? `; ${way}` : ''}`;
}
/** The way back through a portal, short: the portal in view or remembered, and where the far side puts you. */
function wayBackShort(death, observation) {
 const route = observation ? recoveryRoute(death, observation) : null;
 return route ? route.replace(/^Way back: /, 'way back: ').replace(/\.$/, '') : null;
}

function stepNeeds(step, state) {
 const items = deadSample(state.observation) ? [] : state.observation?.inventory?.items ?? [];
 if (step.check !== null) {
  const result = evaluatePlanCheck(step.check, state.observation, state.known);
  const unmet = result.terms.filter(t => t.ok !== true);
  return result.ok === false && (!result.any || unmet.length === 1) ? unmet.map(term => requirementItem(term, items)) : [];
 }
 if (step.kind !== 'inventory' || step.evidence.itemIds.length !== 1 || deadSample(state.observation) || state.observation?.ready !== true) return [];
 return [{ id: step.evidence.itemIds[0], count: step.evidence.count, shown: true }];
}
/** Each affordable recipe is an option, not a reservation against the other options or the whole goal quantity. */
function affordableCrafts(step, state) {
 const o = state.observation;
 if (!step || deadSample(o) || o?.continuity?.rememberedSections?.includes('inventory')) return null;
 const placedStations = (state.known?.placements ?? []).filter(p => p.available !== false && functionalPlacement(p.itemId));
 const holdings = howtoHoldings({ observation: o, placedStations });
 if (!holdings.known) return null;
 const check = step.check === null ? null : evaluatePlanCheck(step.check, o, state.known);
 if (check?.ok === true) return null;
 const ids = check ? check.terms.filter(term => term.ok === false).flatMap(term => term.type === 'has' ? term.ids : [requirementItem(term, o.inventory.items)?.id])
  : stepNeeds(step, state).filter(Boolean).map(need => need.id);
 const choices = [];
 for (const id of new Set(ids)) {
  if (typeof id !== 'string' || !id.startsWith('minecraft:')) continue;
  const recipe = howtoHeldRecipe(id, holdings);
  if (!recipe?.materialsHeld) continue;
  choices.push(`${id.slice(10)} (${recipe.inputs.map(input => `${input.count} ${input.id}`).join(' + ')}; ${recipe.station} ${recipe.stationAvailable ? 'held/seen, placement/reach unverified' : 'missing'})`);
 }
 return choices.length ? chainText(['one craft each from held inputs; options share materials', ...choices], 360) : null;
}
const CHAIN_BYTES = 360;
// At most this many counted items on the goal line: the dragon goal carries rods, pearls and eyes.
const GOAL_LINE_ITEMS = 4;
/**
 * The step's requirement chain from game data and what is held (`parts` to show, `key` for progress), or null. counted
 * keeps every root's own count ("obsidian 0/10 ..."), which the wake line otherwise leaves to the step's own text.
 */
function requirementChain(step, state, { counted = false } = {}) {
 // A non-expandable sibling (such as filled/empty bucket alternatives) must not hide a known tool's ingredients.
 const needs = stepNeeds(step, state).filter(Boolean);
 if (!needs.length) return null;
 const placedStations = (state.known?.placements ?? []).filter(p => p.available !== false && functionalPlacement(p.itemId));
 const holdings = howtoHoldings({ observation: state.observation, placedStations });
 if (!holdings.known) return null;
 const shown = needs.filter(need => need.shown).map(need => need.id.replace(/^minecraft:/, ''));
 try {
  const chain = howtoChain(needs.filter(need => need.count > 0), holdings, { visited: state.known?.visitedDimensions ?? [], shown: counted ? [] : shown });
  const facts = needs.flatMap(need => need.fact ? [need.fact] : []);
  chain.parts.unshift(...facts);
  chain.gated ||= facts.length > 0;
  chain.key = chain.parts.join(', ');
  return chain;
 } catch { return null; }
}
const STALL_SHOWN_MS = 120_000;
/**
 * Since when the first unfinished step (the intent, else the first open step) and its whole requirement chain have
 * stayed the same: the deficit of every item on it, held partial ingredients, mining tool, station and fuel status.
 * Mining raw iron, crafting a stone pickaxe or placing a furnace for an iron step is progress; a death or a replaced
 * step starts the clock again. Returns whether the record changed.
 */
function trackStall(state, at) {
 const step = firstUnfinished(state);
 if (!step) { const had = state.stall !== null; state.stall = null; return had; }
 const key = `${progressRequirement(step, state)}|${requirementChain(step, state)?.key ?? ''}`;
 if (state.stall?.step === step.id && state.stall.key === key) return false;
 state.stall = { step: step.id, key, since: at, broken: state.broken };
 return true;
}
const MAX_OWN_POI = 64;
// The mining window: breaks and resource gains in the last ten minutes, shown from this many breaks.
const MINING_WINDOW_MS = 600_000, MINING_SHOWN = 1, MAX_WINDOW_ROWS = 4096;
const RECENT_MINING_MS = 120_000;
// Block drops a mining trip is for (not the stone and dirt every break yields, nor smelted or crafted products).
const GAIN_ITEMS = /^minecraft:(raw_(iron|gold|copper)|coal|diamond|emerald|redstone|lapis_lazuli|quartz|amethyst_shard|flint|obsidian|crying_obsidian|ancient_debris|[a-z_]+_ore)$/;
// Only gains this close to a break appear together: drops land within seconds, and held-attack tallies arrive
// after the drops they caused. Timing alone does not establish the source of an inventory gain.
const MINED_WITHIN_MS = 30_000;
// Result identities already counted toward broken blocks, so a replayed result is not counted again.
const MAX_COUNTED = 512;
// Longer than any action runs (a control sequence is at most 2000 ticks), for a result without its dispatch dimension.
const ACTION_LIFETIME_MS = 300_000;
function firstCount(state, receipt) {
 if (typeof receipt.actionId !== 'string') return true;
 const key = `${receipt.goalRevision}:${receipt.worldId ?? ''}:${receipt.actionId}`;
 if (state.counted.includes(key)) return false;
 state.counted.push(key); if (state.counted.length > MAX_COUNTED) state.counted.splice(0, state.counted.length - MAX_COUNTED);
 return true;
}
function recordBreaks(state, at, count) {
 for (let index = 0; index < Math.min(count, MAX_WINDOW_ROWS); index += 1) state.breaks.push(at);
 if (state.breaks.length > MAX_WINDOW_ROWS) state.breaks.splice(0, state.breaks.length - MAX_WINDOW_ROWS);
}
function rememberGains(state, before, after, at) {
 const count = (items, id) => items.reduce((n, item) => n + (item.itemId === id ? item.count : 0), 0);
 for (const id of new Set(after.map(item => item.itemId))) {
  if (!GAIN_ITEMS.test(id)) continue;
  const gained = count(after, id) - count(before, id);
  if (gained > 0) state.gains.push({ at, id, n: gained });
 }
 if (state.gains.length > MAX_WINDOW_ROWS) state.gains.splice(0, state.gains.length - MAX_WINDOW_ROWS);
}
/**
 * Blocks broken and observed mineral gains near breaks in the last ten minutes. Inventory deltas cannot prove
 * where an item came from, or whether drops still on the ground will be collected; else null when no breaks.
 */
function miningYield(state, now) {
 const since = now - MINING_WINDOW_MS;
 const breaks = state.breaks.filter(at => at > since && at <= now);
 if (breaks.length < MINING_SHOWN) return null;
 const recentSince = now - RECENT_MINING_MS;
 const recentBreaks = breaks.filter(at => at > recentSince);
 const gained = new Map(), recentGained = new Map();
 for (const row of state.gains) {
  if (row.at <= since || row.at > now || !breaks.some(at => Math.abs(at - row.at) <= MINED_WITHIN_MS)) continue;
  gained.set(row.id, (gained.get(row.id) ?? 0) + row.n);
  if (row.at > recentSince && recentBreaks.some(at => Math.abs(at - row.at) <= MINED_WITHIN_MS)) recentGained.set(row.id, (recentGained.get(row.id) ?? 0) + row.n);
 }
 const top = rows => [...rows].sort((left, right) => right[1] - left[1]).slice(0, 4).map(([id, n]) => `${id.replace(/^minecraft:/, '')} ${n}`).join(', ') || 'none observed';
 const count = rows => `${rows.length} ${rows.length === 1 ? 'block' : 'blocks'} broken`;
 // Old gains must not make a currently fruitless approach look productive. Keep the longer window for context;
 // neither window attributes a pickup to mining or chooses when the model should change sources.
 if (recentBreaks.length < breaks.length) return `last 2m: ${count(recentBreaks)}; mineral gains near breaks (source unverified): ${top(recentGained)}; last 10m: ${count(breaks)}, gains ${top(gained)}`;
 return `last 10m: ${count(breaks)}; mineral gains near breaks (source unverified): ${top(gained)}`;
}
/** Latest placement per cell, newest last, at most MAX_OWN_POI. */
function boundOwnPoi(rows) {
 const cells = new Map();
 for (const row of rows) { const key = `${row.dimension}:${row.x},${row.y},${row.z}`; cells.delete(key); cells.set(key, row); }
 return [...cells.values()].slice(-MAX_OWN_POI);
}
/**
 * The step the progress clock names: the intent's step while unfinished, else the first open step once steps already
 * true by presence (an End checkpoint stands in the End before its stronghold is proven) count as reached.
 */
function progressFocus(state) {
 const plan = state.plan, early = new Set(state.early ?? []);
 const intended = plan?.steps.find(s => s.id === state.intent?.step && s.status !== 'complete' && !early.has(s.id));
 if (intended || !early.size) return intended ?? firstUnfinished(state);
 const open = planProgress({ steps: plan.steps.map(s => early.has(s.id) ? { ...s, status: 'complete' } : s) })?.open ?? [];
 return plan.steps.find(s => open.includes(s.id)) ?? firstUnfinished(state);
}
/** The intent's step while unfinished, else the first open step: the step the wake line and stall clock follow. */
// The portal kit a Nether frame needs besides its obsidian: the water bucket that casts it and the light.
const PORTAL_KIT = new Set(['minecraft:water_bucket', 'minecraft:flint_and_steel', 'minecraft:fire_charge']);
function firstUnfinished(state) {
 const plan = state.plan, facts = planProgress(plan);
 const intended = plan?.steps.find(s => s.id === state.intent?.step && s.status !== 'complete');
 return intended ?? plan?.steps.find(s => facts?.open.includes(s.id));
}
/**
 * What an unmet check term still needs, with its quantity: the item and its count, a tier tool, or the material for
 * the cheapest armour pieces missing from slots without that tier. `shown` marks items the step line already counts.
 */
function requirementItem(term, items) {
 if (term.type === 'has') return term.ids.length === 1 ? { id: term.ids[0], count: term.count, shown: true } : null;
 if (term.type === 'tool') return { id: `minecraft:${term.tier}_${term.kind}`, count: 1 };
 if (term.type === 'worn') {
  const pieceSlots = { helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' };
  const acceptable = items.filter(row => row.count > 0 && ARMOR.indexOf(row.itemId === 'minecraft:turtle_helmet' ? 'iron' : row.itemId.replace(/^minecraft:/, '').split('_')[0]) >= ARMOR.indexOf(term.tier));
  const slots = new Set(acceptable.filter(row => Object.values(pieceSlots).includes(row.slot)).map(row => row.slot));
  const carried = [];
  for (const row of acceptable) {
   const id = row.itemId.replace(/^minecraft:/, ''), slot = pieceSlots[id.split('_').at(-1)];
   if (!slot || slots.has(slot) || slots.size >= term.count) continue;
   slots.add(slot); carried.push(id);
  }
  const need = armorMaterialNeed(term.tier, term.count, slots);
  return { id: `minecraft:${need?.id ?? `${term.tier}_boots`}`, count: need?.count ?? 0, alternative: true, ...(carried.length ? { fact: `${carried.join('|')} carried, not worn` } : {}) };
 }
 return null;
}
function taskIdentity(record) {
 if (record.currentGoalSpec?.fingerprint) return `spec:${record.currentGoalSpec.fingerprint}`;
 return record.currentGoal ? `prompt:${record.currentGoal}` : null;
}
const planProofKeys = new WeakMap();
function retainPlanProof(proof, previous, steps) {
 const before = new Map(previous.map(s => [s.id, s])), after = new Map(steps.map(s => [s.id, s]));
 const compatible = new Map();
 const retainsDefinition = id => {
  if (compatible.has(id)) return compatible.get(id);
  const p = before.get(id), s = after.get(id);
  const sameInstruction = s && p && (s.check !== null || !['manual', 'milestone'].includes(s.kind) || s.label === p.label && s.detail === p.detail);
  // Removing constraints at any depth preserves proof; retained requirements must keep their meaning.
  const retained = Boolean(s && p && s.kind === p.kind && s.check === p.check && JSON.stringify(s.evidence) === JSON.stringify(p.evidence)
   && sameInstruction && s.dependsOn.every(parent => p.dependsOn.includes(parent) && retainsDefinition(parent)));
  compatible.set(id, retained); return retained;
 };
 return Object.fromEntries(steps.filter(s => {
  const p = before.get(s.id);
  return p && Object.hasOwn(proof, s.id) && proof[s.id] === worldProofKey(p, previous) && retainsDefinition(s.id);
 }).map(s => [s.id, worldProofKey(s, steps)]));
}
function worldProofKey(step, steps) {
 // Reconciliation changes statuses only. A replacement owns a new array, so definitions are hashed once per plan.
 let keys = planProofKeys.get(steps);
 if (!keys) { keys = new Map(); planProofKeys.set(steps, keys); }
 if (keys.has(step.id)) return keys.get(step.id);
 const related = new Map(), byId = new Map(steps.map(s => [s.id, s]));
 const visit = s => {
  if (related.has(s.id)) return;
  // An unchecked reported step has no factual predicate to identify its meaning.
  const instruction = s.check === null && ['manual', 'milestone'].includes(s.kind) ? [s.label, s.detail] : null;
  related.set(s.id, [s.id, s.kind, s.check, s.evidence, instruction, [...s.dependsOn].sort()]);
  s.dependsOn.forEach(id => visit(byId.get(id)));
 };
 visit(step);
 const key = createHash('sha256').update(JSON.stringify([...related.values()].sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
 keys.set(step.id, key); return key;
}
function numericUsage(value) {
 const out = {}; for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) out[key] = value[key];
 if (out.inputTokens !== undefined && out.cachedInputTokens !== undefined && out.cachedInputTokens <= out.inputTokens) out.uncachedInputTokens = out.inputTokens - out.cachedInputTokens;
 return Object.keys(out).length ? out : null;
}
export function updateUsage(state, record, value, fallbackNow) {
 const totals = numericUsage(value); if (totals === null) return;
 const at = Number.isSafeInteger(value?.reportedAtEpochMs) && value.reportedAtEpochMs >= 0 ? value.reportedAtEpochMs : fallbackNow;
 const latest = numericUsage(value?.last);
 const usage = { ...totals, ...Object.fromEntries(Object.entries(latest ?? {}).map(([key, number]) => [`last${key[0].toUpperCase()}${key.slice(1)}`, number])) };
 // Identity is private bookkeeping. The transmitted display contract remains
 // flat safe integers and each provider update replaces its cumulative totals.
 const session = JSON.stringify([record.provider, record.model, record.reasoningEffort, record.serviceTier, state.worldId, typeof value?.threadId === 'string' ? value.threadId : null]);
 const previous = state.usageSample;
 const reset = !previous || previous.session !== session || at < previous.at
  || Object.entries(totals).some(([key, count]) => previous.totals[key] !== undefined && count < previous.totals[key]);
 if (!reset) {
  const changed = Object.entries(totals).some(([key, count]) => previous.totals[key] !== count);
  if (!changed) {
   // A repeated cumulative notification is not a new zero-token model call.
   Object.assign(usage, Object.fromEntries(Object.entries(state.usage ?? {}).filter(([key]) => key === 'observedElapsedMs' || key.startsWith('interval') || key.endsWith('PerMinute'))));
   state.usage = usage; return;
  }
  const elapsed = at - previous.at;
  if (elapsed > 0 && Number.isSafeInteger(elapsed)) {
   usage.observedElapsedMs = elapsed;
   for (const key of ['inputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'outputTokens']) {
    if (totals[key] === undefined || previous.totals[key] === undefined) continue;
    const delta = totals[key] - previous.totals[key];
    if (delta < 0) continue;
    usage[`interval${key[0].toUpperCase()}${key.slice(1)}`] = delta;
    const rate = Math.round(delta / elapsed * 60_000);
    if (Number.isSafeInteger(rate) && rate >= 0) usage[`${key}PerMinute`] = rate;
   }
  }
 }
 state.usage = usage;
 state.usageSample = { session, at, totals };
}
function allowance(value) {
 const out = {}; for (const key of ['primary', 'secondary']) if (Number.isFinite(value?.[key]?.usedPercent)) out[key] = { usedPercent: value[key].usedPercent, windowDurationMins: value[key].windowDurationMins ?? null };
 return Object.keys(out).length ? out : null;
}
// What the facts say about the plan right now: steps the evidence satisfies, steps reopened by a loss,
// and steps nothing can verify. On a write, a first open step that is already satisfied is named.
function planEvidence(plan, authored) {
 if (!plan?.steps?.length) return null;
 const ids = test => plan.steps.filter(test).map(s => s.id);
 const result = {};
 const satisfied = ids(s => s.status === 'complete' && (s.check !== null || ['inventory', 'world'].includes(s.kind)));
 const reopened = ids(s => s.status === 'lost');
 const unverifiable = ids(s => s.status !== 'complete' && s.check === null && !['inventory', 'world'].includes(s.kind));
 if (satisfied.length) result.satisfied = satisfied;
 if (reopened.length) result.reopened = reopened;
 if (unverifiable.length) result.unverifiable = unverifiable;
 if (authored) {
  const now = new Map(plan.steps.map(s => [s.id, s.status]));
  const already = authored.filter(s => s.status !== 'complete' && now.get(s.id) === 'complete').map(s => s.id);
  if (already.length) result.alreadySatisfied = already;
  const first = planProgress({ steps: authored }).open[0];
  if (first !== undefined && already.includes(first)) result.firstOpenAlreadySatisfied = first;
 }
 return Object.keys(result).length ? result : null;
}
// Placements that satisfy a completed step (plan-drop credit), nearest first.
function placementRows(step, state) {
 return step.check !== null ? evaluatePlanCheck(step.check, state.observation, state.known).terms.filter(t => t.ok === true).flatMap(t => t.placements ?? [])
  : step.kind === 'inventory' ? placedItems(state.known, step.evidence.itemIds, state.observation)
  : step.kind === 'world' ? [placementAt(state.known, step.evidence)].filter(p => p && p.available !== false && p.blockId === step.evidence.blockId) : [];
}
// What the plan's own evidence says about the intent step: its state, whether its requirement can be
// established from current facts, which prerequisites a loss reopened, and which built ones still stand.
function intentEvidence(state) {
 const id = state.intent?.step;
 if (id === undefined || !state.plan) return null;
 const byId = new Map(state.plan.steps.map(s => [s.id, s])), step = byId.get(id);
 if (!step) return { inPlan: false };
 const closure = [], visit = s => { if (!s || closure.includes(s)) return; closure.push(s); s.dependsOn.forEach(d => visit(byId.get(d))); };
 visit(step);
 const o = state.observation;
 // A corpse or a remembered inventory confirms nothing: losses count only against a fresh live sample.
 const live = o?.ready === true && o.player?.dead !== true && !o.continuity?.rememberedSections?.includes('inventory');
 let known;
 if (!live) known = false;
 else if (step.check !== null) known = evaluatePlanCheck(step.check, o, state.known).ok !== null;
 else if (step.kind === 'inventory') known = true;
 else if (step.kind === 'world') known = step.status === 'complete' || o?.world?.dimension === step.evidence.dimension && observedBlocks(o ?? {}).some(b => b.x === step.evidence.x && b.y === step.evidence.y && b.z === step.evidence.z);
 else known = false;
 // A loss inferred at death is confirmed only when this sample can read the requirement and it is unmet.
 const lost = [];
 for (const s of closure.filter(row => row.status === 'lost')) {
  const readable = !live ? null : s.check !== null ? evaluatePlanCheck(s.check, o, state.known).ok
   : s.kind === 'inventory' ? (o.inventory?.items ?? []).filter(v => s.evidence.itemIds.includes(v.itemId)).reduce((n, v) => n + v.count, 0) + placedItems(state.known, s.evidence.itemIds, o).length >= s.evidence.count
   : s.kind === 'world' ? worldReadable(s, state, o)
   : null;
  if (readable === false) lost.push(s.id); else known = false;
 }
 return { inPlan: true, status: step.status, known, lost,
  // Standing infrastructure needs a placement or a block seen in place, not merely a completed world step.
  kept: closure.filter(s => s.status === 'complete' && (placementRows(s, state).length > 0 || s.kind === 'world' && s.check === null && Object.hasOwn(state.worldProof ?? {}, s.id))).map(s => s.id),
  chain: dependentChain(state.plan, id) };
}
// A checkless world step is readable only through a block seen now at its cell in its dimension, or a standing
// placement of the agent's own: true present, false a different block, null nothing seen (unknown, not lost).
function worldReadable(step, state, o) {
 const e = step.evidence, placement = placementAt(state.known, e);
 if (placement && placement.available !== false && placement.blockId === e.blockId) return true;
 if (o?.world?.dimension !== e.dimension) return null;
 const block = observedBlocks(o).find(b => b.x === e.x && b.y === e.y && b.z === e.z);
 return block === undefined ? null : block.blockId === e.blockId;
}
// Per-sample facts, so a wake built from an older sample describes that sample, not a newer one.
const SAMPLE_HISTORY = 8;
function rememberSample(state, observation) {
 if (!Number.isFinite(observation?.observedAtEpochMs)) return;
 state.samples.push({ at: observation.observedAtEpochMs, observation, statuses: new Map((state.plan?.steps ?? []).map(s => [s.id, s.status])),
  early: [...(state.early ?? [])], results: [...state.results], effect: state.effect, deaths: state.deaths });
 if (state.samples.length > SAMPLE_HISTORY) state.samples.splice(0, state.samples.length - SAMPLE_HISTORY);
}
function sampleView(state, sample) {
 const plan = state.plan ? { steps: state.plan.steps.map(s => sample.statuses.has(s.id) ? { ...s, status: sample.statuses.get(s.id) } : s) } : null;
 return { ...state, plan, observation: sample.observation, early: sample.early, results: sample.results, effect: sample.effect, deaths: sample.deaths };
}
function intentFacts(f) {
 return { ...(typeof f.inPlan === 'boolean' ? { inPlan: f.inPlan } : {}), ...(Number.isSafeInteger(f.deaths) && f.deaths >= 0 ? { deaths: f.deaths } : {}), ...(identifier(f.dimension) ? { dimension: f.dimension } : {}), ...(Number.isSafeInteger(f.at) ? { at: f.at } : {}) };
}
// Placement memory keeps the receipt's tick next to its wall time, so every clock a row carries is compared.
function placedClock(p) { return { observedAtEpochMs: p.placedAt, ...(Number.isSafeInteger(p.placedTick) ? { lastSeenTick: p.placedTick } : {}) }; }
function withdrawnClock(p) { return { observedAtEpochMs: p.withdrawnAt ?? p.placedAt, ...(Number.isSafeInteger(p.withdrawnTick) ? { lastSeenTick: p.withdrawnTick } : Number.isSafeInteger(p.placedTick) && p.withdrawnAt === undefined ? { lastSeenTick: p.placedTick } : {}) }; }
function identifier(v) { return typeof v === 'string' && v.length <= 128 && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(v); }
function samePlacedCell(p, e) { return p.dimension === e.dimension && p.x === e.x && p.y === e.y && p.z === e.z; }
function placementText(p, o, now) {
 const position = o?.position ?? o?.player?.position ?? o?.player;
 const sameDimension = o?.world?.dimension === p.dimension;
 const distance = sameDimension && ['x', 'y', 'z'].every(k => Number.isFinite(position?.[k])) ? `${Math.round(Math.hypot(position.x - p.x, position.y - p.y, position.z - p.z))}m` : p.dimension.replace(/^minecraft:/, '');
 return `placed ${p.blockId.replace(/^minecraft:/, '')} at ${p.x},${p.y},${p.z}, ${Math.max(0, Math.floor((now - p.placedAt) / 1000))}s ago, ${distance}`;
}
function text(v, max, empty) { if (typeof v !== 'string' || codePointLength(v) > max || (!empty && !v.trim()) || /[\x00-\x1f\x7f]/.test(v)) throw new TypeError('Invalid plan text'); return v; }
function exact(v, keys) { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(v, k))) throw new TypeError('Invalid plan fields'); }

// This is a display projection only: saved scope, task identity and tool reads
// retain the complete immutable request. Keep UTF-16 bounds without splitting a pair.
function displayGoal(goal) {
 if (goal.length <= 512) return goal;
 return goal.slice(0, 511).replace(/[\uD800-\uDBFF]$/, '') + '\u2026';
}
