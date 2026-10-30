import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readJsonl, rotatedJsonlFiles } from './jsonl-stream.mjs';
import { decodeModelFacts } from '../model-fact-encoding.mjs';
import { readArtifactReport } from './report-artifacts.mjs';
import { estimateTokenCostUsd } from '../call-cost.mjs';
import { extractLongRunTimeline, spendSeries } from './long-run.mjs';
import { reconcileProviderUsage } from './quality-metrics.mjs';

/** Long reports need player inventory/lifecycle, not the repeated terrain and recipe catalogues. */
export function longProtocolRow(row) {
	const e = row.envelope ?? row, p = e.payload ?? {};
	if (e.type === 'observation') return { ...row, envelope: { type: e.type, agentId: e.agentId, payload: {
		observedAtEpochMs: p.observedAtEpochMs, dimension: p.dimension ?? p.world?.dimension, inventory: p.inventory,
	} } };
	if (['goal_control', 'goal_completion_result', 'advancement_granted', 'agent_registered', 'agent_removed'].includes(e.type)) return row;
	return null;
}
export const longTraceRow = row => ['native_model_call', 'native_decision_timing', 'native_token_usage'].includes(row.event) ? row : null;

export function longMetrics({ traceRows, protocolRows, profile, providerRows = [] }) {
	const total = spendSeries(traceRows, profile).events.at(-1);
	const deathEvents = protocolRows.map(r => r.envelope ?? r).filter(e => e.type === 'goal_control' && e.payload?.operation === 'dead')
		.map(e => ({ at: e.payload.death?.diedAtEpochMs ?? e.payload.updatedAtEpochMs, cause: e.payload.death?.cause ?? null }));
	const preparationRows = providerRows.filter(r => r.goalRevision === 0);
	const preparationCosts = preparationRows.map(r => {
		const t = r.tokens;
		if (!t || !Number.isFinite(t.input) || !Number.isFinite(t.output)) return null;
		const cacheRead = t.cached ?? 0, cacheWrite = t.cacheWrite ?? 0;
		const input = r.provider === 'codex' ? Math.max(0, t.input - cacheRead - cacheWrite) : t.input;
		return estimateTokenCostUsd({ input, output: t.output, cacheRead, cacheWrite }, { ...profile, ...r,
			serviceTier: r.serviceTier ?? r.executionSettings?.effective?.serviceTier ?? profile.serviceTier });
	});
	const preparationUsd = preparationCosts.every(Number.isFinite) ? preparationCosts.reduce((a, b) => a + b, 0) : null;
	const calls = traceRows.filter(r => r.event === 'native_model_call' && (r.goalRevision === undefined || r.goalRevision >= 1));
	return { tokenReconciliation: reconcileProviderUsage(traceRows), partialMessagesAccepted: calls.length > 0 && calls.every(r=>r.partialMessagesAccepted===true), modelCalls: total?.calls ?? 0, playCostEstimateUsd: total?.costUsd ?? null, costEstimateUsd: preparationUsd === null || total?.costUsd === null ? null : (total?.costUsd ?? 0) + preparationUsd,
		preparation: { calls: preparationRows.length, costEstimateUsd: preparationRows.length ? preparationUsd : null }, deaths: deathEvents.length, deathEvents,
		measurementScope: 'Long-run milestones, deaths and estimated model usage; detailed scenario quality metrics are not extracted.' };
}

export async function readLongArtifacts(directory, { profile, windowMs, termination = null, stopRequest = null, authoritativeDragon = null } = {}) {
	const errors = [], protocolRows = [], traceRows = [], samples = [], providerRows = [];
	const optional = async (file, consume) => {
		if (!existsSync(file)) return false;
		try { const result = await readJsonl(file, consume); if (result.droppedLines) errors.push(`${path.basename(file)}: ${result.droppedLines} malformed records`); }
		catch (error) { errors.push(`${path.basename(file)}: ${error.message}`); }
		return true;
	};
	const runner = await readArtifactReport(path.join(directory, 'report.json')).catch(() => null);
	const outcome = await readArtifactReport(path.join(directory, 'quality-run.json')).catch(() => null);
	stopRequest ??= outcome?.stopRequest;
	errors.push(...(outcome?.observerErrors ?? []));
	const metadata = await readArtifactReport(path.join(directory, 'long-run-context.json')).catch(() => null);
	authoritativeDragon ??= metadata?.authoritativeDragon ?? false;
	const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8').catch(() => '{}'));
	profile ??= metadata?.profile ?? { provider: manifest.provider, model: manifest.model, reasoningEffort: manifest.reasoningEffort, serviceTier: manifest.serviceTier };
	windowMs ??= metadata?.windowMs ?? runner?.budget?.playWindowMs;
	const keepProtocol = row => { const compact = longProtocolRow(row); if (compact) protocolRows.push(compact); };
	const liveCapture = await optional(path.join(directory, 'quality-protocol.jsonl'), keepProtocol);
	if (!liveCapture) {
		for (const file of await rotatedJsonlFiles(path.join(directory, 'protocol.jsonl'))) await optional(file, keepProtocol);
		errors.push('Live observer capture unavailable; using retained rotated protocol and provider input snapshots. First-seen milestone times may be late.');
	}
	// Legacy runs lost their protocol prefix. These are actual delivered observations, never model claims.
	const readProvider = row => {
		if (row.goalRevision === 0) providerRows.push(row);
		if (liveCapture || !(row.goalRevision >= 1) || typeof row.input !== 'string') return;
		const at = row.input.indexOf('{"format":"minecraft-facts-v1"');
		if (at < 0) return;
		let decoded;
		try { decoded = decodeModelFacts(JSON.parse(row.input.slice(at))); } catch { return; }
		const observation = decoded?.observation;
		// Changes require an exact baseline, so only complete snapshots are eligible here.
		if (!observation || decoded.observationView?.mode === 'changes') return;
		keepProtocol({ source: 'provider input snapshot', envelope: { type: 'observation', payload: observation } });
	};
	const providerFile = path.join(directory, liveCapture && existsSync(path.join(directory, 'quality-provider-usage.jsonl')) ? 'quality-provider-usage.jsonl' : 'provider-turns.private.jsonl');
	for (const file of await rotatedJsonlFiles(providerFile)) await optional(file, readProvider);
	const usageFile = path.join(directory, existsSync(path.join(directory, 'quality-usage.jsonl')) ? 'quality-usage.jsonl' : 'coordinator.jsonl');
	for (const file of await rotatedJsonlFiles(usageFile)) await optional(file, row => { const compact = longTraceRow(row); if (compact) traceRows.push(compact); });
	if (!await optional(path.join(directory, 'quality-samples.jsonl'), row => { const { entityNbt, ...sample } = row; samples.push(sample); })) {
		try { samples.push(...JSON.parse(await readFile(path.join(directory, 'quality-samples.json'), 'utf8')).samples); }
		catch (error) { if (error.code !== 'ENOENT') errors.push(`quality-samples.json: ${error.message}`); }
	}
	const startedAt = runner?.budget?.goalStartedAt ?? metadata?.startedAt ?? null;
	if (!protocolRows.some(r => (r.envelope ?? r).type === 'goal_control' && (r.envelope ?? r).payload?.operation === 'start')) errors.push('Goal-start protocol record unavailable; using runner goal-start timestamp.');
	const metrics = longMetrics({ traceRows, protocolRows, profile, providerRows });
	const timeline = extractLongRunTimeline({ samples, protocolRows, traceRows, metrics, profile, stopRequest, windowMs,
		startedAt, authoritativeDragon, termination: outcome?.errorCode ?? runner?.errorCode ?? termination ?? outcome?.termination ?? runner?.classification ?? 'NO_RUNNER_REPORT' });
	return { timeline, metrics, profile, windowMs, errors, metadata, manifest, runner, outcome };
}
