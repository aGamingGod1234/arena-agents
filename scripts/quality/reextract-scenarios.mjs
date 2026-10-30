#!/usr/bin/env node
import path from 'node:path';
import { hydrateArtifactReport, writeArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractQualityMetrics, parseJsonlDiagnostics, parseEntitySample, resolveGoalWindow } from '../../coordinator/src/benchmark/quality-metrics.mjs';
import { formatTimeline, measurementStatus, isTerminalRconClosure } from './run-scenarios.mjs';
import { TOKEN_PRICES_PER_MILLION } from '../../coordinator/src/call-cost.mjs';

async function reextractRun(run) {
	if (!run.artifacts || !run.metrics) return run;
	const d = run.artifacts;
	const load = async name => { try { return await readFile(path.join(d, name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
	const manifest = JSON.parse(await load('manifest.json'));
	const sample = JSON.parse(await load('quality-samples.json'));
	for (const s of sample.samples) if (s.entityNbt || s.equipmentNbt) {
		const parsed = parseEntitySample(s.entityNbt ?? s.equipmentNbt, s.at);
		s.fallDistance = parsed.fallDistance; s.inventoryNbt = parsed.inventoryNbt; s.equipmentNbt = parsed.equipmentNbt;
	}
	let droppedLines = 0;
	const parse = (text, notebook = false) => {
		const parsed = parseJsonlDiagnostics(text, notebook);
		droppedLines += parsed.droppedLines; return parsed.rows;
	};
	const timedProtocol = await load('quality-protocol.jsonl');
	// Audit the original stream even when retained observation times are preferred.
	const rawParsed = parseJsonlDiagnostics(await load('protocol.jsonl'));
	droppedLines += rawParsed.droppedLines;
	const protocolRows = timedProtocol ? parse(timedProtocol) : rawParsed.rows;
	const window = resolveGoalWindow(protocolRows);
	const start = protocolRows.map(r => r.envelope ?? r).find(r => r.type === 'goal_control' && r.payload?.operation === 'start');
	const notebookRows = [];
	const memory = path.join(manifest.providerWorkspace, 'player-memory');
	for (const name of await readdir(memory)) if (name.startsWith('notebook-actions-') && name.endsWith('.jsonl')) notebookRows.push(...parse(await readFile(path.join(memory, name), 'utf8'), true));
	const planCapture = await load('quality-initial-plan.json');
	run.metrics = extractQualityMetrics({ traceRows: parse(await load('coordinator.jsonl')), protocolRows, notebookRows, samples: sample.samples,
		targetSamples: sample.targets, providerRows: parse(await load('provider-turns.private.jsonl')), scenario: run.definition, profile: run.profile,
		initialPlan: run.metrics.firstTurnUnderstanding?.initialPlan ?? null, initialPlanCapture: planCapture ? JSON.parse(planCapture) : null, startedAt: window.startedAt,
		endedAt: window.endedAt ?? sample.samples.at(-1)?.at ?? null, agentId: start?.agentId, jsonlDroppedLines: droppedLines });
	run.originalMeasurementStatus ??= run.measurementStatus;
	const observerErrors = run.observerErrors ?? [];
	// Legacy untimed closure is reclassified only with authoritative server completion.
	const terminalErrors = window.goalCompleted && droppedLines === 0 ? observerErrors.filter(isTerminalRconClosure) : [];
	run.terminalObserverErrors = [...(run.terminalObserverErrors ?? []), ...terminalErrors.filter(message => !(run.terminalObserverErrors ?? []).some(error => error.message === message && error.terminalAt === window.endedAt)).map(message => ({ message, terminalAt: window.endedAt, method: 'Legacy untimed closure reclassified from authoritative server completion; original observerErrors retained.' }))];
	run.measurementStatus = measurementStatus(run.metrics, sample.samples, observerErrors.filter(error => !terminalErrors.includes(error)), droppedLines, run.profile.provider);
	run.goalCompleted = window.goalCompleted;
	return run;
}

export function summarizeQualityV2(runs) {
	const available = runs.filter(r => r.metrics?.qualityV2);
	const sum = get => { const values = available.map(get).filter(Number.isFinite); return values.length ? values.reduce((n, v) => n + v, 0) : null; };
	const sumObject = get => { const totals = {}; for (const r of available) for (const [key, value] of Object.entries(get(r) ?? {})) totals[key] = (totals[key] ?? 0) + value; return totals; };
	const deaths = available.flatMap(r => r.metrics.qualityV2.foodUsedBelow6HpBeforeDeath);
	return { attempts: runs.length, withV2: available.length, measured: runs.filter(r => r.measurementStatus === 'MEASURED').length,
		basis: 'Descriptive totals across all attempts with retained v2 evidence, including incomplete runs. Per-scenario comparison means use measured runs only.',
		failedFightRequests: sum(r => r.metrics.qualityV2.failedFightRequests), failedFightRequestsByCode: sumObject(r => r.metrics.qualityV2.failedFightRequestsByCode),
		attacksOnUnreachableTargets: sum(r => r.metrics.qualityV2.attacksOnUnreachableTargets), legacyAttacksOnUnreachableTargets: sum(r => r.metrics.attacksOnUnreachableTargets),
		combatActionsWithoutTargetSample: sum(r => r.metrics.qualityV2.combatActionsWithoutTargetSample),
		lowHealthOutcomes: sumObject(r => r.metrics.qualityV2.lowHealthOutcomes), legacyRecoveredWithoutEating: sum(r => r.metrics.lowHealthRecoveredWithoutEating?.length),
		repeatedIdenticalFailingRequests: sum(r => r.metrics.qualityV2.repeatedIdenticalFailingRequests),
		stationarySprintSeconds: sum(r => r.metrics.qualityV2.stationarySprintSeconds), stationarySprintRunsCovered: available.filter(r => r.metrics.qualityV2.stationarySprintSeconds !== null).length,
		foodUsedBelow6HpDeaths: { yes: deaths.filter(d => d.used === true).length, no: deaths.filter(d => d.used === false).length, unknown: deaths.filter(d => d.used === null).length },
		hazardDeathsByType: sumObject(r => r.metrics.qualityV2.hazardDeathsByType),
		firstResponseCaptured: available.filter(r => r.metrics.qualityV2.firstResponse.captured).length,
		initialPlanCaptured: available.filter(r => r.metrics.qualityV2.initialPlan).length,
		byScenario: Object.fromEntries([...new Set(runs.map(r => r.scenario))].map(id => [id, available.filter(r => r.scenario === id).map(r => ({ pairId: r.pairId ?? `${r.scenario}-r${r.repetition}`, status: r.measurementStatus,
			failedFights: r.metrics.qualityV2.failedFightRequests, repeatedFailures: r.metrics.qualityV2.repeatedIdenticalFailingRequests, stationarySprintSeconds: r.metrics.qualityV2.stationarySprintSeconds,
			lowHealthOutcomes: r.metrics.qualityV2.lowHealthOutcomes, hazardDeathsByType: r.metrics.qualityV2.hazardDeathsByType, foodUsedBelow6HpBeforeDeath: r.metrics.qualityV2.foodUsedBelow6HpBeforeDeath }))])) };
}

export async function reextractReport(file, { out = null } = {}) {
	file = path.resolve(file);
	const sourceText = await readFile(file, 'utf8');
	const report = await hydrateArtifactReport(JSON.parse(sourceText), file);
	const sourceReportSha256 = createHash('sha256').update(sourceText).digest('hex');
	const outputDirectory = out ? path.resolve(out) : path.dirname(file);
	if (report.arms && !out) throw new Error('Paired re-extraction requires --out DIR to preserve the input benchmark.');
	if (out) {
		const resolved = async p => { try { return await realpath(p); } catch (e) { if (e.code !== 'ENOENT') throw e; return path.join(await resolved(path.dirname(p)), path.basename(p)); } };
		const normalize = p => process.platform === 'win32' ? p.toLowerCase() : p;
		const output = normalize(await resolved(outputDirectory));
		const overlaps = p => { const relative = path.relative(normalize(p), output); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
		if (output === normalize(await resolved(path.dirname(file)))) throw new Error('Re-extraction output must be separate from the source report directory.');
		const runs = [...(report.runs ?? []), ...(report.firstAttemptRuns ?? []), ...(report.history ?? []), ...Object.values(report.arms ?? {}).flatMap(a => [...a.runs, ...(a.firstAttemptRuns ?? [])])];
		for (const artifacts of new Set(runs.map(r => r.artifacts).filter(Boolean))) {
			if (overlaps(await resolved(path.resolve(artifacts)))) throw new Error('Re-extraction output must be separate from source artifact directories.');
			const manifest = JSON.parse(await readFile(path.join(artifacts, 'manifest.json'), 'utf8'));
			if (manifest.providerWorkspace && overlaps(await resolved(path.resolve(manifest.providerWorkspace)))) throw new Error('Re-extraction output must be separate from source provider workspaces.');
		}
	}
	await mkdir(outputDirectory, { recursive: true });
	const fingerprint = createHash('sha256');
	for (const name of ['../../coordinator/src/benchmark/quality-metrics.mjs', '../../coordinator/src/benchmark/quality-metrics-v2.mjs', '../../coordinator/src/benchmark/quality-progress.mjs', '../../coordinator/src/benchmark/report-artifacts.mjs', '../../coordinator/src/benchmark/live-speed-benchmark.mjs', '../../coordinator/src/call-cost.mjs', './run-scenarios.mjs', './reextract-scenarios.mjs']) fingerprint.update(name + '\0').update(await readFile(new URL(name, import.meta.url)));
	const extractorSha256 = fingerprint.digest('hex');
	const cache = new Map();
	const extract = async run => {
		const key = JSON.stringify([run.artifacts, run.profile, run.definition, run.metrics?.firstTurnUnderstanding?.initialPlan, run.observerErrors, run.measurementStatus, run.originalMeasurementStatus, run.terminalObserverErrors]);
		if (!cache.has(key)) cache.set(key, reextractRun(structuredClone(run)));
		const result = await cache.get(key);
		return { ...run, metrics: result.metrics, originalMeasurementStatus: result.originalMeasurementStatus,
			terminalObserverErrors: result.terminalObserverErrors, measurementStatus: result.measurementStatus, goalCompleted: result.goalCompleted };
	};
	const stamp = value => {
		value.reextractedAt = new Date().toISOString();
		value.method = { ...value.method, cost: 'Shared repository token-cost comparison proxy for play and preparation; provider-reported preparation USD retained separately; not subscription billing', rates: TOKEN_PRICES_PER_MILLION };
		value.metricsExtractorSha256 = extractorSha256;
		value.reextraction = { extractorSha256, sourceCoordinatorSha256: value.coordinatorSha256, sourceReportSha256, liveCoordinatorUnchanged: true,
			method: 'Retained raw evidence; legacy metric definitions unchanged plus qualityV2. No new provider calls. Raw artifacts are read only.' };
	};
	const extractArm = async (value, directory) => {
		await mkdir(directory, { recursive: true });
		for (let i = 0; i < value.runs.length; i++) value.runs[i] = await extract(value.runs[i]);
		if (value.firstAttemptRuns) for (let i = 0; i < value.firstAttemptRuns.length; i++) value.firstAttemptRuns[i] = await extract(value.firstAttemptRuns[i]);
		for (const run of value.runs) {
			await writeArtifactReport(path.join(directory, `${run.scenario}-r${run.repetition}.json`), run);
			await writeFile(path.join(directory, `${run.scenario}-r${run.repetition}-timeline.txt`), formatTimeline(run));
		}
		stamp(value);
	};
	if (report.arms) {
		for (const [arm, value] of Object.entries(report.arms)) {
			await extractArm(value, path.join(outputDirectory, arm));
			await writeArtifactReport(path.join(outputDirectory, `${arm}.json`), value);
		}
		if (report.history) for (let i = 0; i < report.history.length; i++) report.history[i] = await extract(report.history[i]);
		report.qualityV2Summary = Object.fromEntries(Object.entries(report.arms).map(([arm, value]) => [arm, summarizeQualityV2(value.runs)]));
		await writeArtifactReport(path.join(outputDirectory, 'quality-v2-summary.json'), report.qualityV2Summary);
		stamp(report);
	} else await extractArm(report, outputDirectory);
	await writeArtifactReport(out ? path.join(outputDirectory, 'results.json') : file, report);
	return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (![3, 5].includes(process.argv.length) || process.argv.length === 5 && process.argv[3] !== '--out') throw new Error('Usage: node scripts/quality/reextract-scenarios.mjs results.json [--out DIR]');
	await reextractReport(process.argv[2], { out: process.argv[4] });
	console.log(path.resolve(process.argv[4] ? path.join(process.argv[4], 'results.json') : process.argv[2]));
}
