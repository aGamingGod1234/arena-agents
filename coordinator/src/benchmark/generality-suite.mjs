import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeQualitySetup } from './quality-scenarios.mjs';
import { itemCount, resolveGoalWindow, epoch } from './quality-metrics.mjs';

export async function loadGeneralityFixtures(file, split = 'train', expectedSha256) {
	const bytes=await readFile(file), text=bytes.toString('utf8'), sha256=createHash('sha256').update(bytes).digest('hex');
	expectedSha256=expectedSha256?.toLowerCase();
	if (split==='heldout' && !/^[a-f0-9]{64}$/.test(expectedSha256??'')) throw new Error('Held-out fixtures require an expected SHA-256');
	if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) throw new Error('Fixture SHA-256 mismatch; refusing launch');
	const data = JSON.parse(text);
	if (data.version !== 1 || data.split !== split || !Array.isArray(data.scenarios) || !data.scenarios.length) throw new Error('Invalid versioned suite/split');
	const ids = new Set();
	for (const s of data.scenarios) {
		if (!/^[A-Z][A-Z0-9-]{1,40}$/.test(s.id) || ids.has(s.id) || (!Number.isInteger(s.version)||s.version<1) || typeof s.goal !== 'string' || !s.goal.trim() || s.goal.length > 4000 || !s.categories || !s.objective) throw new Error('Invalid or duplicate scenario');
		ids.add(s.id);
		if (!/^(?:0|-?[1-9][0-9]{0,18})$/.test(s.seed) || BigInt(s.seed) < -(2n**63n) || BigInt(s.seed) >= 2n**63n || !Number.isInteger(s.durationBudgetMs) || s.durationBudgetMs < 300000 || s.durationBudgetMs > 600000) throw new Error('Invalid seed or 5-10 minute timeout');
		normalizeQualitySetup(s.setup);
		validatePredicate(s.objective);
	}
	return { ...data, sha256 };
}
export function validatePredicate(p) {
	if (!p || !['inventory', 'survival', 'dimension', 'health', 'position', 'rcon', 'all', 'fixture-location', 'daylight', 'inventory-any', 'shelter', 'unsupported'].includes(p.type)) throw new Error('Unknown objective predicate');
	if (p.type === 'all') {
		if (!Array.isArray(p.predicates) || !p.predicates.length || p.predicates.some(v=>v.type==='rcon'||v.type==='all')) throw new Error('Composite supports non-RCON leaf predicates only');
		p.predicates.forEach(validatePredicate);
	}
	if (['inventory','inventory-any'].includes(p.type) && (!Array.isArray(p.items) || !p.items.length || p.items.some(i => !/^minecraft:[a-z0-9_]+$/.test(i.item) || !Number.isInteger(i.count) || i.count < 1))) throw new Error('Invalid inventory predicate');
	if (p.type === 'dimension' && !['minecraft:overworld','minecraft:the_nether','minecraft:the_end'].includes(p.dimension)) throw new Error('Invalid dimension predicate');
	if(p.type==='dimension'&&p.allowInitial!==undefined&&typeof p.allowInitial!=='boolean') throw new Error('Invalid dimension state predicate');
	if (p.type === 'health' && (!Number.isFinite(p.minimum)||p.minimum<=0||p.minimum>20)) throw new Error('Invalid health predicate');
	if (p.type === 'survival' && (!Number.isInteger(p.minimumMs)||p.minimumMs<=0||p.minimumMs>600000)) throw new Error('Invalid survival predicate');
	if(p.type==='survival'&&p.endState!==undefined&&(!p.endState||typeof p.endState!=='object'||Array.isArray(p.endState)||Object.entries(p.endState).some(([key,v])=>!['onFire','underWater','inLava','onGround','creeperNearby'].includes(key)||typeof v!=='boolean'))) throw new Error('Invalid survival end state');
	if (['position','fixture-location'].includes(p.type) && (!Number.isFinite(p.radius)||p.radius<=0||p.radius>256)) throw new Error('Invalid position radius');
	if (p.type === 'position' && (!p.position||['x','y','z'].some(k=>!Number.isFinite(p.position[k])))) throw new Error('Invalid position predicate');
	if (p.type === 'rcon' && (!/^execute (?:(?:at \{agent\}|if (?:entity|score|block|data)|unless (?:entity|block)) .+|at \{agent\} .+) run time query gametime$/.test(p.rcon ?? '') || /[\r\n]|\b(?:store|summon|positioned|as|in)\b/.test(p.rcon))) throw new Error('RCON predicates must be read-only execute checks');
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export function predicateMet(p, sample, context) {
	switch (p.type) {
		case 'all': return p.predicates.every(v => predicateMet(v, sample, context));
		case 'unsupported': return null;
		case 'shelter': return sample.shelterEnclosed===true && context.playerPlacedBlocks===true;
		case 'inventory-any': return p.items.some(i => itemCount(sample.inventoryNbt,new RegExp(`^${i.item}$`)) >= i.count);
		case 'inventory': return p.items.every(i => itemCount(sample.inventoryNbt, new RegExp(`^${i.item}$`)) >= i.count);
		case 'daylight': return Number.isFinite(sample.dayTime) && sample.dayTime%24000<12000 && context.deaths===0 && sample.health>0;
		case 'dimension': return sample.dimension === p.dimension && (p.allowInitial===true || sample.dimension !== context.initialDimension);
		case 'health': return sample.health >= p.minimum && sample.health > context.initialHealth;
		case 'position': return sample.position && dist(sample.position, p.position) <= p.radius && (!p.dimension || sample.dimension === p.dimension);
		case 'fixture-location': return sample.position && context.locationTarget && Math.hypot(sample.position.x-context.locationTarget[0],sample.position.z-context.locationTarget[1])<=p.radius;
		case 'rcon': return sample.objectiveMet === true;
		case 'survival': {
   if(context.survivalWindowEnded!==true || context.fixtureActivated===false) return false;
   if(!Number.isFinite(context.deaths)||!Number.isFinite(sample.health)||context.terminalEvidenceFresh===false) return null;
   if(context.deaths!==0 || !(sample.health>0)) return false;
   for(const [field,expected] of Object.entries(p.endState??{})) {
    const observed=sample[field];
    if(typeof observed!=='boolean') return null;
    if(observed!==expected) return false;
   }
   return true;
  }
	}
	return false;
}
export function extractGeneralityMarkers({ scenario, metrics, samples = [], protocolRows = [] }) {
	if (!metrics) return { version: 1, status: 'UNAVAILABLE' };
	const protocol = protocolRows.map(r => ({ ...(r.envelope ?? r), direction: r.direction ?? (r.envelope ?? r).direction, observedAtMs: r.observedAtMs, timestamp: r.timestamp }));
	const window = resolveGoalWindow(protocol);
	if (protocolRows.length && window.startedAt === null) return {version:1,status:'UNAVAILABLE',goalPredicateMet:null,survived:null,timeToFirstMeaningfulProgressMs:null,deaths:null,calls:metrics.modelCalls,tokens:metrics.tokens,playCostEstimateUsd:metrics.playCostEstimateUsd};
	const bridge = protocol.filter(r => r.type === 'observation').map(r => {
		const p = r.payload ?? {};
		return { at: p.observedAtEpochMs ?? epoch(r), health: p.player?.health, position: p.position, dimension: p.world?.dimension, dayTime: p.world?.dayTime,
			onFire:p.player?.onFire, underWater:p.player?.underWater, inLava:p.player?.inLava, onGround:p.player?.onGround,
			inventoryNbt: '[' + (p.inventory?.items ?? []).map(i => `{id:${JSON.stringify(i.itemId)},count:${i.count}}`).join(',') + ']' };
	});
	const points = [...samples, ...bridge].filter(s => Number.isFinite(s.at) && (window.startedAt === null || s.at >= window.startedAt) && (window.endedAt === null || s.at <= window.endedAt)).sort((a,b) => a.at - b.at);
	const initialPoint=points.find(s=>!Number.isFinite(scenario.fixtureActivatedAt)||s.at>=scenario.fixtureActivatedAt)??points[0];
	const start = window.startedAt ?? points[0]?.at ?? null, context = { initialDimension: initialPoint?.dimension, initialHealth: initialPoint?.health, deaths: metrics.deaths, locationTarget: scenario.setup?.locationTarget, goalCompleted: window.goalCompleted && (scenario.setup?.activation!=='first-decision' || Number.isFinite(scenario.fixtureActivatedAt) && scenario.fixtureActivatedAt <= (window.endedAt??Infinity)), playerPlacedBlocks: (metrics.timeline??[]).some(r=>/place_block|place|build|break_block|mine|dig/i.test(r.tool??'') && /^(?:BLOCK_PLACED|BLOCK_BROKEN|SUCCEEDED|SUCCESS|OK)$/.test(r.resultCode??'')) };
	const activatedPoints=points.filter(s=>!Number.isFinite(scenario.fixtureActivatedAt)||s.at>=scenario.fixtureActivatedAt);
	const survivalPredicates=scenario.objective.type==='survival'?[scenario.objective]:scenario.objective.predicates?.filter(p=>p.type==='survival')??[];
	const hasSurvival=survivalPredicates.length>0;
	const endState=Object.assign({},...survivalPredicates.map(p=>p.endState??{}));
	const observedDuration=Number.isFinite(metrics.playWallTimeMs)?metrics.playWallTimeMs:window.endedAt!==null&&start!==null?window.endedAt-start:null;
 const survivalWindowEnded=window.goalCompleted || Number.isFinite(observedDuration)&&observedDuration >= (scenario.durationBudgetMs??scenario.objective.minimumMs??Infinity);
 const survivalEndedAt=window.endedAt??(Number.isFinite(observedDuration)&&start!==null?start+observedDuration:null);
 const fixtureActivated=scenario.setup?.activation!=='first-decision'||Number.isFinite(scenario.fixtureActivatedAt);
 let terminalPoint=activatedPoints.at(-1);
 if(hasSurvival && terminalPoint) {
  terminalPoint={...terminalPoint};
  // A terminal bridge observation may omit hazard flags. Carry forward only
  // recent evaluator facts; stale or missing evidence remains unknown.
  for(const field of Object.keys(endState)) if(typeof terminalPoint[field]!=='boolean') {
   const recent=activatedPoints.findLast(s=>terminalPoint.at-s.at<=2000 && typeof s[field]==='boolean');
   if(recent) terminalPoint[field]=recent[field];
  }
 }
 const candidates = hasSurvival ? terminalPoint?[terminalPoint]:[] : activatedPoints;
 const terminalEvidenceFresh=!Number.isFinite(survivalEndedAt)||terminalPoint&&Math.abs(survivalEndedAt-terminalPoint.at)<=2000;
 const survivalContext={...context,survivalWindowEnded,fixtureActivated,terminalEvidenceFresh};
 const reached = candidates.find(s => predicateMet(scenario.objective, s, { ...survivalContext, elapsedMs: s.at - start }));
 const survivalUnknown=hasSurvival && terminalPoint && survivalPredicates.some(p=>predicateMet(p,terminalPoint,survivalContext)===null);
	const inventoryProgress = scenario.objective.type === 'inventory' ? points.find(s => scenario.objective.items.some(i => itemCount(s.inventoryNbt, new RegExp(`^${i.item}$`)) > itemCount(points[0]?.inventoryNbt, new RegExp(`^${i.item}$`)))) : null;
	const firstMs = Math.min(...[inventoryProgress ? inventoryProgress.at - start : null, reached ? reached.at - start : null, metrics.timeToFirstProgressMs].filter(Number.isFinite));
	const timeline = (metrics.timeline ?? []).filter(r => Number.isFinite(r.elapsedMs)).sort((a,b) => a.elapsedMs - b.elapsedMs);
	const idleEnd = reached ? reached.at-start : metrics.playWallTimeMs;
	const boundaries = [0, ...timeline.filter(r=>!Number.isFinite(idleEnd)||r.elapsedMs<=idleEnd).map(r=>r.elapsedMs), ...(Number.isFinite(idleEnd)?[idleEnd]:[])];
	let idleMs = 0;
	for (let i=1;i<boundaries.length;i++) idleMs += Math.max(0, boundaries[i] - boundaries[i-1] - 30000);
	const v2 = metrics.qualityV2 ?? {}, progress = metrics.progressV1 ?? {};
	return { version: 1, status: points.length > 1 ? 'OBSERVED' : 'INCOMPLETE', survived: Number.isFinite(metrics.deaths) && points.length ? metrics.deaths === 0 && points.at(-1).health > 0 : null,
		goalPredicateMet: scenario.objective.type==='unsupported'||survivalUnknown ? null : reached ? true : points.length > 1 ? false : null, authoritativeGoalCompleted: metrics.goalCompleted,
		timeToGoalPredicateMs: reached ? reached.at - start : null, timeToFirstMeaningfulProgressMs: Number.isFinite(firstMs) ? firstMs : null,
		deaths: metrics.deaths, deathsByCause: v2.hazardDeathsByType ?? null,
		waste: { repeatedIdenticalFailures: v2.repeatedIdenticalFailingRequests ?? null, blindMovesAfterPathFailure: progress.pathFailureThenMovementControl ?? null, abandonedStations: progress.stationsLeftUnrevisited ?? null, idleDecisionGapMs: Number.isFinite(metrics.playWallTimeMs) || timeline.length > 1 ? idleMs : null },
		calls: metrics.modelCalls, tokens: metrics.tokens, playTokens: metrics.playTokens, costEstimateUsd: metrics.costEstimateUsd, playCostEstimateUsd: metrics.playCostEstimateUsd,
		limitations: ['Predicates combine RCON samples and server bridge facts, including terminal inventory observations.', 'Survival means no death within the observed window.', 'Unrevisited stations and decision gaps are waste proxies, not proof of poor logic.', 'Idle proxy counts gaps between action starts, including start/cutoff boundaries, above 30s; active programs/provider latency may explain these.'], coverage: metrics.coverage };
}
/** Runs that cannot be scored: observer errors (including EVALUATOR_INPUT_LEAK), no goal window, or a spend-cap stop. */
export function generalityRunInvalidReasons(r) {
	const reasons = [];
	if (r.observerErrors?.length) reasons.push(...r.observerErrors.map(e => String(e).split(':')[0]));
	if (!r.markers || r.markers.status === 'UNAVAILABLE') reasons.push('NO_VALID_WINDOW');
	if (r.stopRequest?.reason === 'SPEND_CAP') reasons.push('SPEND_CAP_STOP');
	return [...new Set(reasons)];
}

export function summarizeGenerality(runs) {
	const categories = new Map(), waste = new Map();
	for (const r of runs) {
		for (const [kind, value] of Object.entries(r.categories ?? {})) for (const tag of Array.isArray(value) ? value : [value]) {
			const key = `${r.arm}/${kind}/${tag}`; if (!categories.has(key)) categories.set(key, []); categories.get(key).push(r);
		}
		if (generalityRunInvalidReasons(r).length) continue;
		for (const [kind,value] of Object.entries(r.markers?.waste ?? {})) { const key = `${r.arm}/${kind}`; if (!waste.has(key)) waste.set(key, []); waste.get(key).push(value); }
	}
	const mean = values => { const known = values.filter(Number.isFinite); return { n: known.length, mean: known.length ? known.reduce((a,b)=>a+b,0)/known.length : null }; };
	return { invalidRuns: runs.filter(r => generalityRunInvalidReasons(r).length).map(r => ({ pairId: r.pairId ?? null, arm: r.arm ?? null, reasons: generalityRunInvalidReasons(r) })),
		categories: [...categories].map(([category, all]) => ({ category, runs: all.length, invalid: all.filter(r => generalityRunInvalidReasons(r).length).length, rows: all.filter(r => !generalityRunInvalidReasons(r).length) })).map(({ category, runs, invalid, rows }) => ({ category, runs, invalid, measured: rows.filter(r=>r.measurementStatus==='MEASURED').length, success: mean(rows.map(r=>typeof r.markers?.goalPredicateMet==='boolean' ? +r.markers.goalPredicateMet : null)), survival: mean(rows.map(r=>typeof r.markers?.survived==='boolean' ? +r.markers.survived : null)), deaths: mean(rows.map(r=>r.markers?.deaths)), progressMs: mean(rows.map(r=>r.markers?.timeToFirstMeaningfulProgressMs)), playCostUsd: mean(rows.map(r=>r.markers?.playCostEstimateUsd)), calls: mean(rows.map(r=>r.markers?.calls)), judgeScores: Object.fromEntries(['sensibleGoalPursuit','situationalAwareness','safety','efficiency','recovery'].map(key=>[key,mean(rows.map(r=>r.judge?.judgments?.length===2?([r.judge.judgments[0].scores[key].score,r.judge.judgments[1].scores[key].score].every(Number.isFinite)?(r.judge.judgments[0].scores[key].score+r.judge.judgments[1].scores[key].score)/2:null):null))])), judgeAgreement: mean(rows.map(r=>r.judge?.agreement?.exactFraction)) })), waste: [...waste].map(([className,values])=>({className,...mean(values)})) };
}

export function buildGeneralityJudgeTimeline(metrics, markers, protocolRows = [], {activatedAt} = {}) {
 const protocol=protocolRows.map(r=>({...r.envelope??r, direction:r.direction??r.envelope?.direction, observedAtMs:r.observedAtMs}));
 const window=resolveGoalWindow(protocol);
 const endMs=window.startedAt!==null&&window.endedAt!==null?window.endedAt-window.startedAt:metrics?.playWallTimeMs;
 const rows=(metrics?.timeline??[]).filter(r=>Number.isSafeInteger(r.elapsedMs)&&r.elapsedMs>=0&&(!Number.isFinite(endMs)||r.elapsedMs<=endMs)).map(r=>({...r,kind:'action'}));
 const startObservation=protocol.filter(r=>r.type==='observation' && Number.isFinite(r.payload?.observedAtEpochMs??epoch(r))).find(r=>window.startedAt!==null && (r.payload?.observedAtEpochMs??epoch(r))>=window.startedAt);
 const p=startObservation?.payload??{};
 const start=startObservation?[{elapsedMs:0,kind:'start',tool:'starting_situation',argsSummary:JSON.stringify({health:p.player?.health,foodLevel:p.player?.foodLevel,onFire:p.player?.onFire,air:p.player?.air,effects:p.player?.effects,gear:{armor:p.player?.armor,held:p.inventory?.selectedItem},inventorySlotsUsed:p.inventory?.items?.length,inventory:p.inventory?.items?.slice(0,8).map(i=>({item:i.itemId,count:i.count})),position:p.position,dimension:p.world?.dimension,time:p.world?.dayTime,weather:{rain:p.world?.raining,thunder:p.world?.thundering},threats:(p.nearbyEntities??p.entities??[]).filter(e=>e.type!=='minecraft:item').slice(0,6).map(e=>({type:e.type,distance:e.distance}))})}]:[];
 const deaths=(metrics?.qualityV2?.deathEvents??metrics?.deathEvents??[]).filter(e=>Number.isFinite(e.at)&&window.startedAt!==null&&e.at>=window.startedAt&&(window.endedAt===null||e.at<=window.endedAt)).map(e=>({elapsedMs:e.at-window.startedAt,kind:'event',tool:'death',argsSummary:JSON.stringify({cause:e.cause??'unknown'}),resultCode:'DEAD'}));
 const completions=protocol.filter(r=>['goal_completion_request','goal_completion_result'].includes(r.type) && window.startedAt!==null && epoch(r)>=window.startedAt&&(window.endedAt===null||epoch(r)<=window.endedAt)).map(r=>({elapsedMs:Math.round(epoch(r)-window.startedAt),kind:r.type==='goal_completion_result'?'completion-verdict':'completion-claim',tool:r.type,argsSummary:JSON.stringify(r.type==='goal_completion_result'?{claimAccepted:r.payload?.verified===true,reason:r.payload?.reasonCode,facts:r.payload?.facts}:{claim:r.payload?.summary??r.payload?.reason??'Player requested completion'}),resultCode:r.payload?.reasonCode}));
 const activation=Number.isFinite(activatedAt)&&window.startedAt!==null&&activatedAt>window.startedAt?protocol.find(r=>r.type==='observation'&&(r.payload?.observedAtEpochMs??epoch(r))>=activatedAt&&(window.endedAt===null||(r.payload?.observedAtEpochMs??epoch(r))<=window.endedAt)):null;
 const changes=activation?[{elapsedMs:Math.round((activation.payload.observedAtEpochMs??epoch(activation))-window.startedAt),kind:'event',tool:'situation_update',argsSummary:JSON.stringify({health:activation.payload.player?.health,foodLevel:activation.payload.player?.foodLevel,onFire:activation.payload.player?.onFire,inLava:activation.payload.player?.inLava,underWater:activation.payload.player?.underWater,position:activation.payload.position,effects:activation.payload.player?.effects})}]:[];
 return [...start,...rows,...deaths,...completions,...changes].sort((a,b)=>a.elapsedMs-b.elapsedMs);
}

export function findGeneralityInputLeaks(providerRows,scenario) {
 const signatures=[/\"gameMode\"\s*:\s*\"creative\"/i,/Your game mode has been updated to (?:Creative|Survival|Spectator|Adventure) Mode/i,/QUALITY_SETUP|qualitySetup|fixtureKind|scenarios-heldout\.json|\[Rcon:|\[Server:|<Server>/i,/naturalRegeneration["\\]*\s*[:=]\s*false|natural_health_regeneration|gamerules?\s*[:=]|\bgamerule\s+[a-z_]+\s+(?:true|false|\d+)/i];
 const secrets=[scenario.name,...(scenario.setup?.commands??[]),...(scenario.setup?.finalCommands??[])].filter(v=>typeof v==='string'&&v.length>12);
 return providerRows.flatMap((row,index)=>{
  const input=typeof row.input==='string'?row.input:row.input?JSON.stringify(row.input):'';
  const matches=signatures.some(pattern=>pattern.test(input))||secrets.some(text=>input.includes(text));
  return matches?[{row:index,code:'EVALUATOR_INPUT_LEAK'}]:[];
 });
}
