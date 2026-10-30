#!/usr/bin/env node
// Evaluation only. Read one JSONL record at a time; retain aggregates and the bounded fatal encounter, never terrain/NBT history.
import path from 'node:path';
import { existsSync, createReadStream } from 'node:fs';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readJsonl, rotatedJsonlFiles } from '../../coordinator/src/benchmark/jsonl-stream.mjs';
import { readArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';
import { itemCount } from '../../coordinator/src/benchmark/quality-metrics.mjs';
import { LONG_RUN_MILESTONES } from '../../coordinator/src/benchmark/long-run.mjs';

const finite = Number.isFinite;
const timestamp = row => row?.at ?? row?.observedAtMs ?? row?.atMs ?? row?.timestamp ?? row?.payload?.observedAtEpochMs ?? row?.payload?.updatedAtEpochMs ?? null;
const json = async file => readArtifactReport(file).catch(async () => { try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } });
const zero = () => ({ rods: 0, pearlsEyes: 0, gold: 0 });
const units = { rods: 'rod equivalents (rod=1, powder=0.5, eye=0.5)', pearlsEyes: 'pearl/eye equivalents', gold: 'barterable ingot equivalents (block=9, nugget=1/9)' };
export function resourceCounts(sample) {
	const nbt = sample?.inventoryNbt;
	if (typeof nbt !== 'string' || !nbt.trim().startsWith('[')) return { rods: null, pearlsEyes: null, gold: null };
	const count = id => itemCount(nbt, new RegExp(`^minecraft:${id}$`));
	return { rods: count('blaze_rod') + count('blaze_powder') / 2 + count('ender_eye') / 2,
		pearlsEyes: count('ender_pearl') + count('ender_eye'), gold: count('gold_ingot') + count('gold_block') * 9 + count('gold_nugget') / 9 };
}
function setupResources(setup) {
	if (!setup || !Array.isArray(setup.inventory)) return null;
	return resourceCounts({ inventoryNbt: `[${setup.inventory.map(i => `{id: "${i.item ?? i.itemId}", count: ${i.count ?? 1}}`).join(',')}]` });
}
export function classifyEnding({ operatorStop, stopRequest, termination, failure, startedAt, lastAt, windowMs, completed = false }) {
	if (operatorStop?.status === 'stop_failed') return { kind: 'failure', reason: `OPERATOR_STOP_FAILED: ${operatorStop.reason}`, at: operatorStop.at, censored: true, operatorStop };
	if (operatorStop) return { kind: 'stopped', reason: operatorStop.reason, at: operatorStop.at, censored: true, operatorStop };
	if (completed) return { kind: 'completed', reason: 'verified goal completion', at: lastAt, censored: false };
	const reason = stopRequest?.reason ?? termination ?? failure ?? 'UNKNOWN_TERMINATION';
	if (['SPEND_CAP', 'WALL_CLOCK_BUDGET'].includes(reason) || finite(startedAt) && finite(lastAt) && finite(windowMs) && lastAt - startedAt >= windowMs - 5000)
		return { kind: 'budget_end', reason: reason === 'SPEND_CAP' ? reason : 'WALL_CLOCK_BUDGET', at: lastAt, censored: true };
	if (failure || /ERROR|FAILED|NO_OBSERVER|LAUNCH|EADDRINUSE/.test(reason)) return { kind: 'failure', reason, at: lastAt, censored: true };
	return { kind: 'unknown', reason, at: lastAt, censored: true };
}
async function findRaw(directory, depth = 0) {
	if (existsSync(path.join(directory, 'quality-samples.jsonl')) || existsSync(path.join(directory, 'quality-samples.json'))) return directory;
	if (depth >= 4) return null;
	for (const e of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
		if (e.isDirectory() && (['run', 'run-artifacts'].includes(e.name) || /^(run-|q-)/.test(e.name))) {
			const found = await findRaw(path.join(directory, e.name), depth + 1); if (found) return found;
		}
	}
	return null;
}
async function streamFiles(directory, name, accept, diagnostics) {
	if (!directory) return { rows: 0, files: [] };
	const files = await rotatedJsonlFiles(path.join(directory, name)).catch(() => []);
	let rows = 0;
	for (const f of files) {
		const result = await readJsonl(f, accept); rows += result.rows;
		if (result.droppedLines) diagnostics.push(`${path.basename(f)}: ${result.droppedLines} malformed/truncated lines`);
	}
	return { rows, files: files.map(f => path.basename(f)) };
}
// Legacy quality-samples.json is a JSON array wrapper. Scan top-level sample objects without loading the array.
async function legacySamples(file, accept) {
	let started = false, depth = 0, quoted = false, escaped = false, record = '';
	for await (const chunk of createReadStream(file, { encoding: 'utf8' })) for (const c of chunk) {
		if (!started) { if (c === '[') started = true; continue; }
		if (depth === 0 && c !== '{') continue;
		record += c;
		if (!quoted && c === '{') depth++;
		if (!quoted && c === '}') depth--;
		if (escaped) escaped = false; else if (quoted && c === '\\') escaped = true; else if (c === '"') quoted = !quoted;
		if (depth === 0) { await accept(JSON.parse(record)); record = ''; }
	}
}
function suppliedReserves(setup) {
	const inventory = [];
	for (const command of setup?.commands ?? []) {
		const m = command.match(/item replace block .* with (minecraft:\w+)(?: (\d+))?/);
		if (m) inventory.push({ item: m[1], count: Number(m[2] ?? 1) });
	}
	return setup ? setupResources({ inventory }) : null;
}
function newStage(name, supplied = null) {
	return { name, samples: 0, startedAt: null, endedAt: null, deaths: 0, damageTakenCounterDelta: null, healthDropLowerBound: 0,
		resources: Object.fromEntries(Object.entries(units).map(([key, unit]) => [key, { unit, supplied: supplied?.[key] ?? null, earned: null, held: null, spent: null, lost: 0,
			observedGains: 0, recoveredOrEarned: 0, unexplainedDecrease: 0, peakHeld: 0 }])), milestones: {}, _last: null };
}
function pushStage(stage, sample, { death = false, initial = false } = {}) {
	stage.samples++; stage.startedAt ??= sample.at; stage.endedAt = sample.at;
	const counts = resourceCounts(sample), previous = stage._last;
	if (previous && finite(previous.damageTakenCounter) && finite(sample.damageTakenCounter)) stage.damageTakenCounterDelta = (stage.damageTakenCounterDelta ?? 0) + Math.max(0, sample.damageTakenCounter - previous.damageTakenCounter);
	if (previous && finite(previous.health) && finite(sample.health)) stage.healthDropLowerBound += Math.max(0, previous.health - sample.health);
	for (const [key, r] of Object.entries(stage.resources)) {
		const held = counts[key], before = previous ? resourceCounts(previous)[key] : r.supplied;
		if (!finite(held)) { r.held = null; continue; }
		if (finite(before)) {
			const change = held - before;
			if (death) r.lost += Math.max(0, -change);
			else if (change < 0) r.unexplainedDecrease += -change;
			else if (change > 0) { r.observedGains += change; if (stage.name === 'after_death') r.recoveredOrEarned += change; }
		}
		r.held = held; r.peakHeld = Math.max(r.peakHeld, held);
	}
	for (const m of LONG_RUN_MILESTONES) {
		const holds = m.item ? itemCount(`${sample.inventoryNbt ?? ''}${sample.equipmentNbt ?? ''}`, m.item) > 0 : m.dimension ? sample.dimension === m.dimension : sample.advancements?.includes(m.advancement) ?? false;
		const entry = stage.milestones[m.id] ??= { firstObservedAt: null, heldAtStageEnd: null, reached: false };
		if (holds) entry.firstObservedAt ??= sample.at;
		entry.reached ||= holds;
		// Advancements remain historical events; only items and location have a held-at-end state.
		entry.heldAtStageEnd = m.item ? (typeof sample.inventoryNbt === 'string' && sample.inventoryNbt.trim().startsWith('[') ? holds : null) : m.dimension ? holds : null;
	}
	stage._last = { at: sample.at, health: sample.health, damageTakenCounter: sample.damageTakenCounter, inventoryNbt: sample.inventoryNbt, deathCounter: sample.deathCounter };
}
function cleanStage(stage, status, endAt) {
	for (const r of Object.values(stage.resources)) {
		r.earnedBounds = { minimum: 0, maximum: null, classifiableObservedGains: r.observedGains, exact: false };
		r.spentBounds = { minimum: 0, maximum: null, classifiableObservedDecreases: r.unexplainedDecrease, exact: false };
		r.lostBasis = 'Last sampled holdings dropped at an observed death; inferred loss of possession, not verified destruction or exact loss between samples.';
	}
	delete stage._last;
	return { ...stage, endedAt: endAt ?? stage.endedAt, status, durationMs: finite(stage.startedAt) && finite(endAt ?? stage.endedAt) ? (endAt ?? stage.endedAt) - stage.startedAt : null,
		retentionRequirements: { rodsHeldAtStageEnd: stage.resources.rods.held == null ? null : stage.resources.rods.held >= 6, pearlsOrEyesHeldAtStageEnd: stage.resources.pearlsEyes.held == null ? null : stage.resources.pearlsEyes.held >= 12, required: { rods: 6, pearlsEyes: 12 } },
		resourceBasis: 'Inventory deltas. Earned/spent remain unknown without a causal receipt; positive deltas can be recovery, gifts or container transfers. Lost is the observed death-associated decrease, not item destruction. Counter units are vanilla tenths of HP.' };
}
const compactSample = s => ({ at: s.at, health: s.health, damageTakenCounter: s.damageTakenCounter, deathCounter: s.deathCounter, position: s.position, dimension: s.dimension, counts: resourceCounts(s) });

export async function scoreStageRun(directory, { rawDirectory = null } = {}) {
	directory = path.resolve(directory);
	const diagnostics = [];
	const report = await json(path.join(directory, 'long-run.json'));
	const raw = rawDirectory ?? (report?.artifacts && existsSync(report.artifacts) ? await findRaw(report.artifacts) : null) ?? await findRaw(directory);
	const context = raw ? await json(path.join(raw, 'long-run-context.json')) : null;
	const runner = raw ? await json(path.join(raw, 'report.json')) : null;
	const outcome = raw ? await json(path.join(raw, 'quality-run.json')) : null;
	const manifest = raw ? await json(path.join(raw, 'manifest.json')) : null;
	const startRecord = await json(path.join(directory, 'long-run-start.json'));
	const definition = report?.definition ?? context?.definition ?? outcome?.definition ?? startRecord?.definition;
	const windowMs = report?.windowMs ?? context?.windowMs ?? definition?.durationBudgetMs ?? runner?.budget?.playWindowMs ?? null;
	let operatorStop = await json(path.join(directory, 'operator-stop.json')) ?? (raw ? await json(path.join(raw, 'operator-stop.json')) : null) ?? report?.operatorStop ?? null;
	if (!operatorStop) {
		const done = await readFile(`${directory}.done`, 'utf8').catch(() => '');
		const stop = done.match(/^stopped\s+(\S+)(?:\s+(.+))?/);
		if (stop && finite(Date.parse(stop[1]))) operatorStop = { kind: 'operator-stop', at: Date.parse(stop[1]), reason: stop[2] ?? 'Historical operator stop; explanation was not recorded', source: '.done marker', reasonRecorded: Boolean(stop[2]) };
	}
	let agentId = null, startedAt = runner?.budget?.goalStartedAt ?? report?.timeline?.startedAt ?? context?.startedAt ?? null, endedAt = null, firstDeath = null, completed = false;
	const deathTimes = [];
	const acceptDeath = d => { if (operatorStop && d.at > operatorStop.at || finite(startedAt) && finite(windowMs) && d.at > startedAt + windowMs) return; if (finite(d.at) && (!finite(startedAt) || d.at >= startedAt)) { if (!deathTimes.some(at => Math.abs(at - d.at) < 1500)) deathTimes.push(d.at); if (!firstDeath || d.at < firstDeath.at) firstDeath = d; } };
	const protocolName = raw && existsSync(path.join(raw, 'quality-protocol.jsonl')) ? 'quality-protocol.jsonl' : 'protocol.jsonl';
	let protocolStarted = false;
	const protocol = await streamFiles(raw, protocolName, row => {
		const e = row.envelope ?? row, p = e.payload ?? {}, at = timestamp(row) ?? timestamp(e);
		if (e.type === 'goal_control' && p.operation === 'start' && finite(at) && !protocolStarted && (!agentId || e.agentId === agentId)) { agentId ??= e.agentId; startedAt = at; protocolStarted = true; }
		if (agentId && e.agentId && e.agentId !== agentId) return;
		if (e.type === 'goal_control' && p.operation === 'dead') acceptDeath({ at: p.death?.diedAtEpochMs ?? at, cause: p.death?.cause ?? null, source: 'protocol' });
		if (e.type === 'goal_control' && ['stop', 'complete'].includes(p.operation) && finite(at) && (!finite(startedAt) || at >= startedAt) && (!finite(windowMs) || !finite(startedAt) || at <= startedAt + windowMs + 5000)) { endedAt = at; completed ||= p.operation === 'complete'; }
	}, diagnostics);
	if (!protocol.rows) diagnostics.push('Protocol absent: command arguments, exact perception, rule expiry and controller ownership may be unobservable.');
	const traceName = raw && existsSync(path.join(raw, 'coordinator.jsonl')) ? 'coordinator.jsonl' : 'quality-usage.jsonl';
	await streamFiles(raw, traceName, row => { if (row.goalRevision >= 1 && row.agentId) agentId ??= row.agentId; }, diagnostics);
	const watchDirs = raw ? [path.join(raw, 'arena-watch'), path.join(raw, 'server', 'arena-watch')] : [];
	const watchFiles = [];
	for (const dir of watchDirs) {
		const files = (await readdir(dir).catch(() => [])).filter(n => n.endsWith('-episodes.jsonl') && (!agentId || n.startsWith(agentId))).map(n => path.join(dir, n));
		if (files.length) { watchFiles.push(...files); break; }
	}
	const fatalEpisodes = [];
	for (const f of watchFiles) await readJsonl(f, e => {
		if (e.outcome === 'death') acceptDeath({ at: e.closedAt?.epochMs, cause: e.source?.type ?? e.kind, source: 'watcher' });
	});
	for (const d of outcome?.metrics?.deathEvents ?? report?.timeline?.deaths ?? []) acceptDeath({ ...d, source: 'run-record' });
	const supplied = setupResources(definition?.setup);
	const first = newStage('first_life', supplied), recovery = newStage('after_death', zero());
	let previous = null, lastAt = null, sampleDeaths = 0;

	const consume = sample => {
		if (sample.health <= 0) sample = { ...sample, inventoryNbt: '[]', equipmentNbt: '[]' };
		if (!finite(sample.at) || finite(startedAt) && sample.at < startedAt || finite(startedAt) && finite(windowMs) && sample.at > startedAt + windowMs || operatorStop && sample.at > operatorStop.at) return;
		if (sample.agentId && agentId && sample.agentId !== agentId) return;
		startedAt ??= sample.at;
		if (previous && sample.at < previous.at) { diagnostics.push('Out-of-order sample ignored'); return; }
		const dead = finite(sample.deathCounter) && sample.deathCounter > (previous?.deathCounter ?? 0) || sample.health <= 0 && (previous?.health ?? 20) > 0;
		if (dead) { sampleDeaths += Math.max(1, sample.deathCounter - (previous?.deathCounter ?? 0) || 1); if (!firstDeath) acceptDeath({ at: sample.at, cause: null, source: 'sample (upper time bound)' }); }
		const after = firstDeath && sample.at >= firstDeath.at;
		if (after && !recovery.samples && previous) {
			if (finite(previous.damageTakenCounter) && finite(sample.damageTakenCounter)) first.damageTakenCounterDelta = (first.damageTakenCounterDelta ?? 0) + Math.max(0, sample.damageTakenCounter - previous.damageTakenCounter);
			first.healthDropLowerBound += Math.max(0, previous.health - sample.health);
			recovery._last = { ...sample, inventoryNbt: '[]' };
		}
		pushStage(after ? recovery : first, sample, { death: dead && recovery.samples > 0, initial: !previous });
		if (dead) (after ? recovery : first).deaths++;
		previous = sample; lastAt = sample.at;
	};
	const samples = await streamFiles(raw, 'quality-samples.jsonl', consume, diagnostics);
	if (!samples.files.length && raw && existsSync(path.join(raw, 'quality-samples.json'))) await legacySamples(path.join(raw, 'quality-samples.json'), consume);
	if (firstDeath) {
		for (const f of watchFiles) await readJsonl(f, e => {
			if (e.outcome === 'death' && Math.abs((e.closedAt?.epochMs ?? Infinity) - firstDeath.at) < 2500) fatalEpisodes.push(e);
		});
	}
	const fatalStart = fatalEpisodes.reduce((t, e) => Math.min(t, e.perceived?.firstObservedAt ?? e.openedAt?.epochMs ?? t), firstDeath?.at ?? Infinity);
	const deathTrace = firstDeath ? { death: firstDeath, encounterStartAt: fatalEpisodes.length && finite(fatalStart) ? fatalStart : null,
		hazards: fatalEpisodes.map(e => ({ kind: e.kind, source: e.source, firstSensedAt: e.perceived?.firstObservedAt ?? null,
			watcherOpenedAt: e.openedAt?.epochMs, watcherDamageTakenHp: e.damage, advertisedRules: e.cover?.armed ?? [], firings: e.cover?.fired ?? [] })),
		liveReflexCoverage: [], dispatchedCommands: [], ownership: [], damage: { taken: [], dealt: [], dealtTotal: null }, gaps: [] } : null;
	const traceEnd = firstDeath?.at ?? -Infinity, traceStart = finite(fatalStart) && fatalStart < traceEnd ? fatalStart : traceEnd - 30000;
	let lastObservation = null;
	if (deathTrace) {
		deathTrace.traceWindow = { from: traceStart, through: traceEnd, basis: fatalEpisodes.length ? 'Watcher first sensed/opened time' : 'last 30 seconds for diagnosis; hazard onset unknown' };
		if (!fatalEpisodes.length) deathTrace.gaps.push('No matching Watcher fatal episode: first-sensed hazard time is unknown.');
		await streamFiles(raw, protocolName, row => {
			const e = row.envelope ?? row, p = e.payload ?? {}, at = p.observedAtEpochMs ?? timestamp(row) ?? timestamp(e);
			if (agentId && e.agentId && e.agentId !== agentId || !finite(at) || at > traceEnd) return;
			if (e.type === 'observation') {
				lastObservation = { at, p };
				if (at < traceStart) return;
				(deathTrace.controllerSnapshots ??= []).push({ at, handsOwner: p.interaction?.ownership?.hands ?? null, aimOwner: p.interaction?.ownership?.aim ?? null,
					currentAction: p.currentAction, reflexFiring: p.reflexes?.firing ?? null, input: p.interaction?.input ?? null, activeHand: p.interaction?.activeHand ?? null,
					mainHand: p.interaction?.mainHandItemId ?? null, offHand: p.interaction?.offHandItemId ?? null, basis: 'observed controllers and inputs; null owner means no ownership proof' });
				const coveringIds = new Set(deathTrace.hazards.flatMap(h => h.advertisedRules).map(name => name.split(':')[0]));
				const live = (p.reflexes?.rules ?? []).filter(r => r.expiresInS > 0 && !r.disabled && !/expired|removed|disabled/.test(r.state));
				deathTrace.liveReflexCoverage.push({ at, rules: live.map(r => ({ ...r, coversRecordedHazard: coveringIds.size ? coveringIds.has(r.id) : null })), coveringRules: coveringIds.size ? live.filter(r => coveringIds.has(r.id)).map(r => r.id) : null, basis: 'server observation status; live at observation time' });
				const owners = p.interaction?.ownership ?? p.currentAction?.ownership;
				if (owners) deathTrace.ownership.push({ at, ...owners, basis: 'protocol' });
			}
			if (at >= traceStart && e.type === 'action_command') deathTrace.dispatchedCommands.push({ at, source: 'protocol', ...p });
			if (at >= traceStart && ['action_result', 'action_progress'].includes(e.type)) (deathTrace.actionReceipts ??= []).push({ at, actionId: p.actionId, actionType: p.actionType, state: p.state, reasonCode: p.reasonCode, message: p.message, elapsedMs: p.elapsedMs, executionStarted: p.executionStarted, physicalAttempted: p.physicalAttempted, actionObservation: p.actionObservation });
			if (at >= traceStart && /damage/.test(e.type ?? '')) deathTrace.damage.dealt.push({ at, type: e.type, payload: p, attribution: 'unclassified protocol damage event' });
		}, diagnostics);
		let priorSample = null;
		await streamFiles(raw, 'quality-samples.jsonl', s => {
			if (s.at > traceEnd) return;
			if (s.at >= traceStart && priorSample) {
				const counterDelta = finite(s.damageTakenCounter) && finite(priorSample.damageTakenCounter) ? Math.max(0, s.damageTakenCounter - priorSample.damageTakenCounter) : null;
				if (counterDelta > 0 || s.health < priorSample.health) deathTrace.damage.taken.push({ ...compactSample(s), counterDelta, hpLowerBound: Math.max(0, priorSample.health - s.health) });
			}
			priorSample = s;
		}, diagnostics);
		if (!deathTrace.liveReflexCoverage.length) deathTrace.gaps.push('No live server rule status/expiry retained. Watcher advertised rule names do not establish live coverage.');
		if (!deathTrace.ownership.length) deathTrace.gaps.push('Hands and aim ownership were not recorded; dispatched action types cannot prove controller ownership.');
		deathTrace.lastObservationAt = lastObservation?.at ?? null;
		deathTrace.lastObservationAgeAtDeathMs = lastObservation ? traceEnd - lastObservation.at : null;
		deathTrace.damage.basis = 'Taken: vanilla counter deltas (tenths of HP), health-drop lower bounds, and per-hazard Watcher damage (can overlap, do not sum). Dealt: unknown without attributed damage receipts; attack dispatch is not a hit.';
		deathTrace.gaps.push('Damage dealt is unknown unless an attributed damage receipt is present.');
	}
	const latencies = [], usageLatencies = [];
	await streamFiles(raw, traceName, row => {
		if (agentId && row.agentId && row.agentId !== agentId || row.goalRevision === 0) return;
		const at = timestamp(row);
		if (!finite(at) || finite(startedAt) && at < startedAt || finite(lastAt) && at > lastAt || operatorStop && at > operatorStop.at) return;
		if (row.event === 'native_decision_timing' && row.outcome === 'completed' && finite(row.segmentDurationMs)) latencies.push(row.segmentDurationMs);
		if (row.event === 'native_model_call' && finite(row.totalMs)) usageLatencies.push(row.totalMs);
		if (deathTrace && at >= traceStart && at <= traceEnd) {
			if (row.event === 'native_tool_dispatch_started') deathTrace.dispatchedCommands.push({ at, actionId: row.actionId, actionType: row.actionType, source: 'coordinator' });
			if (/reflexes_|action_completed/.test(row.event)) (deathTrace.coordinatorEvents ??= []).push(row);
		}
	}, diagnostics);
	const p50 = xs => { xs.sort((a, b) => a - b); return xs.length ? (xs[Math.floor((xs.length - 1) / 2)] + xs[Math.ceil((xs.length - 1) / 2)]) / 2 : null; };
	endedAt ??= report?.timeline?.endedAt ?? lastAt;
	const ending = classifyEnding({ operatorStop, stopRequest: report?.stopRequest ?? outcome?.stopRequest, termination: outcome?.errorCode ?? report?.termination ?? outcome?.termination ?? runner?.classification,
		failure: report?.failure ?? (runner?.failureCategory && runner.failureCategory !== 'budget' ? runner.failureCategory : null), startedAt, lastAt: endedAt, windowMs, completed });
	if (firstDeath) {
		first.deaths = 1;
		// The living stage ends with death, when held inventory has been dropped. Keep its pre-death sample as evidence.
		for (const [k, r] of Object.entries(first.resources)) { r.heldBeforeDeath = r.held; r.lost += r.held ?? 0; r.held = 0; }
		for (const [id, m] of Object.entries(first.milestones)) if (LONG_RUN_MILESTONES.find(x => x.id === id)?.item) m.heldAtStageEnd = false;
	}
	first.startedAt = first.samples ? startedAt : null;
	if (recovery.samples && firstDeath) recovery.startedAt = firstDeath.at;
	const firstLife = cleanStage(first, firstDeath ? 'observed_death' : !first.samples ? 'unobserved' : ending.censored ? 'censored_alive' : 'completed', firstDeath?.at ?? lastAt);
	recovery.deaths = Math.max(0, Math.max(sampleDeaths, deathTimes.length) - (firstDeath ? 1 : 0));
	const afterDeath = cleanStage(recovery, recovery.samples ? ending.censored ? 'censored' : 'completed' : 'unobserved', lastAt);
	if (!operatorStop && ending.kind === 'unknown') diagnostics.push('Historical stop time/reason absent: do not infer an operator stop from timeout/SIGTERM.');
	if (!supplied) diagnostics.push('Save-point kit definition absent; initial possession is not proven earned.');
	return { schemaVersion: 1, scorer: 'd38-measure', scoredAt: new Date().toISOString(), run: path.basename(directory), raw: raw ? path.relative(directory, raw) : null,
		evaluationReferences: path.basename(directory).startsWith('w-desk-d38-baseline-') ? ['evals/d38-baseline'] : path.basename(directory).startsWith('w-desk-d38-recover-') ? ['evals/d38-recover'] : [],
		identity: { agentId, agentName: runner?.generatedName ?? null, seed: report?.seed ?? definition?.seed ?? manifest?.world?.seed ?? null, profile: report?.profile ?? outcome?.profile ?? null, build: report?.build ?? null, checkpoint: definition?.name ?? null },
		window: { startedAt, observedThrough: lastAt, plannedEndAt: finite(startedAt) && finite(windowMs) ? startedAt + windowMs : null, windowMs }, ending,
		postRunFailure: runner?.failureCategory && runner.failureCategory !== 'budget' ? { category: runner.failureCategory, classification: runner.classification, diagnostics: runner.diagnostics } : null,
		censoring: { censored: ending.censored, unobservedRemainder: ending.censored, observedFirstLifeFailure: Boolean(firstDeath), reason: 'Continuation after the last observation is unobserved, including after a fixed budget. Observed first-life deaths remain failures.' },
		firstLife, afterDeath, suppliedKit: { inventory: supplied, reserveContainers: suppliedReserves(definition?.setup) }, observedDeaths: !lastAt && !deathTimes.length ? null : Math.max(sampleDeaths, deathTimes.length), firstLifeDeathTrace: deathTrace,
		timing: { decisionSegments: latencies.length, decisionP50Ms: p50(latencies), usageRecords: usageLatencies.length, usageRecordP50Ms: p50(usageLatencies), basis: 'completed provider decision segments; usage notification timing shown separately, never substituted' },
		coverage: { protocolRecords: protocol.rows, samples: first.samples + recovery.samples, watcherFiles: watchFiles.length, diagnostics: [...new Set(diagnostics)] } };
}

export function demonstrationMarkdown(scores) {
	const cell = n => n == null ? '?' : Number(n).toFixed(1);
	return ['# d38 stage measurement demonstration', '',
		'One row per retained run; the baseline/recover cohorts are the same games referenced by evals/d38-baseline and evals/d38-recover, not extra independent trials. Observational rescoring only. ? means unobserved, never zero. R/P/G = rod equivalents / pearls or eyes / barterable gold ingots. Earned and spent are unknown without receipts; gains are not claimed as earnings. First-life held is zero on observed death (dropped), with the last living inventory retained in each JSON report.', '',
		'| Run | Ending / censor | First-life min / outcome | After-death min / deaths total | Supplied R/P/G | Held at run end R/P/G | Observed gains R/P/G | Death-associated lost R/P/G | Decision / usage p50 ms |',
		'|---|---|---|---|---|---|---|---|---|', ...scores.map(s => {
			const triple = (field, combine = false) => Object.keys(units).map(k => cell(combine ? (s.firstLife.resources[k][field] ?? 0) + (s.afterDeath.resources[k][field] ?? 0) : s.firstLife.resources[k][field])).join('/');
			const held = Object.keys(units).map(k => cell((s.afterDeath.samples ? s.afterDeath : s.firstLife).resources[k].held)).join('/');
			return `| ${s.run} | ${s.ending.kind}; ${s.ending.censored ? 'censored' : 'complete'} | ${cell(s.firstLife.durationMs == null ? null : s.firstLife.durationMs / 60000)}; ${s.firstLife.status} | ${cell(s.afterDeath.durationMs == null ? null : s.afterDeath.durationMs / 60000)} / ${s.observedDeaths} | ${triple('supplied')} | ${held} | ${triple('observedGains', true)} | ${triple('lost', true)} | ${cell(s.timing.decisionP50Ms)} / ${cell(s.timing.usageRecordP50Ms)} |`;
		}), '', 'Resource details, stage-end milestones, per-death traces and coverage gaps are in the adjacent JSON files.', ''].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2), outAt = args.indexOf('--out');
	const out = outAt < 0 ? null : path.resolve(args[outAt + 1]);
	if (outAt >= 0) args.splice(outAt, 2);
	if (args[0] === '--demo') {
		const root = path.resolve(args[1]);
		if (!out) throw new Error('--demo ROOT needs --out DIR');
		await mkdir(out, { recursive: true });
		const dirs = (await readdir(path.join(root, 'sub/long'), { withFileTypes: true })).filter(e => e.isDirectory() && e.name.startsWith('w-desk-d38-')).sort((a, b) => a.name.localeCompare(b.name));
		const scores = [];
		for (const d of dirs) {
			const score = await scoreStageRun(path.join(root, 'sub/long', d.name)); scores.push(score);
			await writeFile(path.join(out, `${d.name}.json`), JSON.stringify(score, null, 2) + '\n');
			process.stderr.write(`${d.name}: ${score.firstLife.status}, ${score.coverage.samples} samples\n`);
		}
		await writeFile(path.join(out, 'demonstration.json'), JSON.stringify(scores, null, 2) + '\n');
		await writeFile(path.join(out, 'demonstration.md'), demonstrationMarkdown(scores));
	} else {
		if (!args[0]) throw new Error('Usage: stage-score.mjs RUN_DIR [--out FILE] | --demo ARENA_BEAT_GAME --out DIR');
		const score = await scoreStageRun(args[0]);
		if (out) await writeFile(out, JSON.stringify(score, null, 2) + '\n'); else process.stdout.write(JSON.stringify(score, null, 2) + '\n');
	}
}
