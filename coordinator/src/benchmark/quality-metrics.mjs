import { estimateTokenCostUsd } from '../call-cost.mjs';
import { deriveRunMetrics } from './live-speed-benchmark.mjs';
import { extractQualityProgress } from './quality-progress.mjs';
import { extractQualityMetricsV2 } from './quality-metrics-v2.mjs';

export const epoch = r => r?.at ?? r?.payload?.updatedAtEpochMs ?? r?.timestamp ?? r?.observedAtMs ?? null;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const physical = type => /move|navigate|explore/.test(type ?? '');
const combat = type => /fight|attack/.test(type ?? '');
const terminal = state => ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(state);
export function parseJsonlDiagnostics(text, notebook = false) {
	const rows = [];
	let droppedLines = 0, nonemptyLines = 0;
	for (const line of String(text).split(/\r?\n/).filter(line => line.trim())) {
		nonemptyLines++;
		try { rows.push(JSON.parse(notebook ? line.slice(line.indexOf(' ') + 1) : line)); } catch { droppedLines++; }
	}
	return { rows, droppedLines, nonemptyLines };
}
export function parseJsonl(text, notebook = false) { return parseJsonlDiagnostics(text, notebook).rows; }

export function isVerifiedGoalCompletion(row) {
	const event = row.envelope ?? row;
	return row.direction !== 'coordinator_to_server' && (event.type === 'goal_control' && event.payload?.operation === 'complete'
		|| event.type === 'goal_completion_result' && event.payload?.verified === true);
}
export function resolveGoalWindow(protocolRows, { agentId = null, startedAt = null, endedAt = null } = {}) {
	const rows = protocolRows.map(r => { const event = r.envelope ?? r; return { ...event, direction: r.direction ?? event.direction, observedAtMs: r.observedAtMs ?? event.observedAtMs, timestamp: r.timestamp ?? event.timestamp, at: event.payload?.updatedAtEpochMs ?? event.at }; })
		.filter(r => !agentId || !r.agentId || r.agentId === agentId).sort((a, b) => epoch(a) - epoch(b));
	const start = rows.find(r => r.type === 'goal_control' && r.payload?.operation === 'start' && Number.isFinite(epoch(r)));
	startedAt = start ? epoch(start) : startedAt;
	const end = rows.find(r => Number.isFinite(epoch(r)) && (startedAt === null || epoch(r) >= startedAt)
		&& (isVerifiedGoalCompletion(r) || r.type === 'goal_control' && r.payload?.operation === 'stop'));
	if (end) endedAt = epoch(end);
	return { startedAt, endedAt, goalCompleted: Boolean(end && isVerifiedGoalCompletion(end)), termination: end && isVerifiedGoalCompletion(end) ? 'GOAL_COMPLETED' : end ? 'STOPPED' : null };
}
function inventoryNbt(text, name = 'Inventory', opening = '[') {
	const match = new RegExp(`\\b${name}:\\s*\\${opening}`).exec(String(text));
	if (!match) return '';
	const start = match.index + match[0].length - 1;
	let depth = 0, quoted = false, escaped = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (!quoted && c === opening) depth++;
		if (!quoted && c === (opening === '[' ? ']' : '}') && --depth === 0) return text.slice(start, i + 1);
		if (escaped) escaped = false;
		else if (quoted && c === '\\') escaped = true;
		else if (c === '"') quoted = !quoted;
	}
	return '';
}
function wornArmourNbt(text) {
	const equipment = inventoryNbt(text, 'equipment', '{');
	if (equipment) return `[${['head', 'chest', 'legs', 'feet'].map(slot => inventoryNbt(equipment, slot, '{')).filter(Boolean).join(',')}]`;
	const armour = inventoryNbt(text, 'ArmorItems');
	if (armour) return armour;
	const inventory = inventoryNbt(text), entries = [];
	let depth = 0, start = 0, quoted = false, escaped = false;
	for (let i = 0; i < inventory.length; i++) {
		const c = inventory[i];
		if (!quoted && c === '{' && depth++ === 0) start = i;
		if (!quoted && c === '}' && --depth === 0) {
			const entry = inventory.slice(start, i + 1);
			if (/\bSlot:\s*10[0-3]b?\b/.test(entry)) entries.push(entry);
		}
		if (escaped) escaped = false;
		else if (quoted && c === '\\') escaped = true;
		else if (c === '"') quoted = !quoted;
	}
	return `[${entries.join(',')}]`;
}
export function parseEntitySample(text, at = Date.now()) {
	const numeric = name => { const m = text.match(new RegExp(`\\b${name}:\\s*(-?[\\d.]+)`)); return m ? Number(m[1]) : null; };
	const pos = text.match(/\bPos:\s*\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
	return { at, position: pos ? { x: +pos[1], y: +pos[2], z: +pos[3] } : null,
		health: numeric('Health'), fallDistance: numeric('fall_distance') ?? numeric('FallDistance'), onGround: numeric('OnGround') === 1,
		dimension: text.match(/\bDimension:\s*"([^"]+)"/)?.[1] ?? null, entityNbt: text, equipmentNbt: wornArmourNbt(text), inventoryNbt: inventoryNbt(text) };
}
export function itemCount(text, pattern) {
	let count = 0, quoted = false, escaped = false;
	const stack = [];
	for (const c of String(text)) {
		if (!quoted && c === '{') {
			const parent = stack.at(-1);
			stack.push({ direct: '', component: parent?.component || /\bcomponents:\s*$/.test(parent?.direct ?? '') });
			continue;
		}
		if (!quoted && c === '}') {
			const entry = stack.pop();
			if (!entry) continue;
			const id = entry.direct.match(/\bid:\s*"([^"]+)"/)?.[1];
			if (!entry.component && id && pattern.test(id)) count += Number(entry.direct.match(/\bcount:\s*(\d+)/)?.[1] ?? 1);
			if (stack.length) stack.at(-1).direct += '{}';
			continue;
		}
		if (stack.length) stack.at(-1).direct += c;
		if (escaped) escaped = false;
		else if (quoted && c === '\\') escaped = true;
		else if (c === '"') quoted = !quoted;
	}
	return count;
}

// Thread-total rows carry a legacy uncachedInputTokens that still includes cache writes, so derive uncached input
// from the gross count whenever it is present.
export function providerCallTokens(row) {
	if (!Number.isFinite(row.outputTokens) || !Number.isFinite(row.inputTokens) && !Number.isFinite(row.uncachedInputTokens)) return null;
	const cacheRead = row.cachedInputTokens ?? 0, cacheWrite = row.cacheWriteInputTokens ?? 0;
	return { input: Number.isFinite(row.inputTokens) ? Math.max(0, row.inputTokens - cacheRead - cacheWrite) : row.uncachedInputTokens, cacheRead, cacheWrite, output: row.outputTokens };
}

/** Reconcile final physical-call rows against the latest counter for each provider session. */
export function reconcileProviderUsage(traceRows) {
	const rows = traceRows.filter(r => r.goalRevision === undefined || r.goalRevision >= 1);
	const finalCalls = new Map(), loose = [], latestUsage = new Map();
	for (const row of rows) {
		if (row.event === 'native_model_call' && Number.isFinite(row.totalMs)) {
			if (row.modelCallId) finalCalls.set(row.modelCallId, row); else loose.push(row);
		}
		if (row.event === 'native_token_usage' && row.scope === 'thread_total') latestUsage.set(`${row.agentId}|${row.sessionKey ?? 'default'}`, row);
	}
	const categories = ['input', 'cacheRead', 'cacheWrite', 'output'];
	const sum = records => {
		const tokens = records.map(providerCallTokens);
		return tokens.length && tokens.every(Boolean) ? Object.fromEntries(categories.map(k => [k, tokens.reduce((n,t)=>n+t[k],0)])) : null;
	};
	const callRowTotals = sum([...loose, ...finalCalls.values()]), threadTotals = sum([...latestUsage.values()]);
	const reconciliationCategories = Object.fromEntries(categories.map(k => {
		const difference = callRowTotals && threadTotals ? callRowTotals[k]-threadTotals[k] : null;
		const relativeDifference = difference === null ? null : Math.abs(difference)/Math.max(1,threadTotals[k]);
		return [k, {callRows:callRowTotals?.[k]??null,threadTotal:threadTotals?.[k]??null,difference,relativeDifference}];
	}));
	return { callRowTotals, threadTotals, categories: reconciliationCategories, tolerance: .02,
		complete: Boolean(callRowTotals && threadTotals && Object.values(reconciliationCategories).every(r=>r.relativeDifference<=.02)) };
}

export function extractQualityMetrics({ traceRows = [], protocolRows = [], notebookRows = [], samples = [], targetSamples = [], providerRows = [], initialPlan = null, initialPlanCapture = null, scenario, profile, startedAt = null, endedAt = null, agentId = null, jsonlDroppedLines = 0 } = {}) {
	const scoped = rows => rows.filter(r => (!agentId || !r.agentId || r.agentId === agentId) && (r.goalRevision === undefined || r.goalRevision >= 1));
	traceRows = scoped(traceRows);
	// Final usage corrections replace the earlier row for the same physical call.
	const finalCalls = new Map();
	for (const row of traceRows) if (row.event === 'native_model_call' && row.modelCallId) finalCalls.set(row.modelCallId, row);
	traceRows = traceRows.filter(r => r.event !== 'native_model_call' || !r.modelCallId || finalCalls.get(r.modelCallId) === r);
	protocolRows = scoped(protocolRows.map(r => ({ ...(r.envelope ?? r), direction: r.direction ?? (r.envelope ?? r).direction, observedAtMs: r.observedAtMs ?? (r.envelope ?? r).observedAtMs, timestamp: r.timestamp ?? (r.envelope ?? r).timestamp })));
	const speed = deriveRunMetrics({ traceRows: traceRows.map(r => ({ ...r, observedAtMs: epoch(r) })), profile,
		goalStartedAtMs: startedAt, goalCompletedAtMs: endedAt });
	const actions = new Map();
	const merge = (id, fields) => { if (id) actions.set(id, { ...(actions.get(id) ?? {}), ...fields, actionId: id }); };
	for (const r of traceRows) {
		if (r.event === 'native_tool_dispatch_started') merge(r.actionId, { type: r.actionType, start: epoch(r) });
		if (r.event === 'native_tool_action_completed') merge(r.actionId, { state: r.state, code: r.reasonCode, end: r.javaEndedAtEpochMs ?? epoch(r) });
	}
	for (const r of protocolRows) {
		const p = r.payload ?? {};
		if (r.type === 'action_command') merge(p.actionId, { type: p.actionType, args: p.arguments ?? p.args ?? p.action?.arguments ?? {}, start: actions.get(p.actionId)?.start ?? epoch(r) });
		if (r.type === 'action_result') merge(p.actionId, { state: p.state, code: p.reasonCode, end: actions.get(p.actionId)?.end ?? p.endedAtEpochMs ?? epoch(r) });
	}
	for (const r of notebookRows.flatMap(r => r.receipts?.put ?? [])) merge(r.actionId, { type: r.actionType, args: r.arguments, ...(terminal(r.state) ? { state: r.state, code: r.reasonCode } : {}) });
	const list = [...actions.values()].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
	let selectedItem = null;
	for (const a of list) {
		if (a.type === 'select_item') selectedItem = a.args?.itemId;
		a.eating = /eat|consume/.test(a.type) || a.type === 'use_item' && /cooked_|beef|porkchop|mutton|chicken|rabbit|salmon|:cod$|bread|apple|carrot|potato|stew|soup|berries|melon_slice|cookie|pumpkin_pie|rotten_flesh/.test(selectedItem ?? '');
	}
	const deathEvents = protocolRows.filter(r => r.type === 'goal_control' && r.payload?.operation === 'dead').map(r => ({ at: r.payload.death?.diedAtEpochMs ?? epoch(r), cause: r.payload.death?.cause ?? null, dimension: r.payload.death?.dimensionId ?? null }));
	const points = samples.filter(s => s.position && Number.isFinite(s.at) && (startedAt === null || s.at >= startedAt) && (endedAt === null || s.at <= endedAt)).sort((a, b) => a.at - b.at);
	let path = 0, stuckMs = 0, damageObserved = 0, falls = 0, falling = false;
	const damageEvents = [], eatingDelays = [], uneatenEpisodes = [];
	let lowAt = null, lowEpisode = false;
	for (let i = 0; i < points.length; i++) {
		const s = points[i], prev = points[i - 1];
		if (Number.isFinite(s.health) && s.health <= 8 && !lowEpisode) { lowAt = s.at; lowEpisode = true; }
		if (prev && prev.dimension === s.dimension && !deathEvents.some(e => e.at > prev.at && e.at <= s.at) && !(Number.isFinite(prev.deathCounter) && Number.isFinite(s.deathCounter) && s.deathCounter > prev.deathCounter)) {
			const d = distance(prev.position, s.position), dt = s.at - prev.at;
			path += d;
			if (d < .15 && list.some(a => physical(a.type) && a.start <= prev.at && (a.end ?? endedAt ?? Infinity) >= s.at)) stuckMs += dt;
			if (Number.isFinite(prev.health) && Number.isFinite(s.health) && s.health < prev.health) {
				const amount = prev.health - s.health; damageObserved += amount;
				damageEvents.push({ at: s.at, amount, source: s.damageSource ?? 'unknown', lastAttackerEvidence: s.lastAttackerEvidence ?? null, position: s.position });
			}
		}
		const nowFalling = (s.fallDistance ?? 0) > 3;
		if (nowFalling && !falling) falls++;
		falling = nowFalling;
		const eat = list.find(a => a.eating && a.start >= (lowAt ?? Infinity) && a.start <= s.at);
		if (lowAt !== null && eat) { eatingDelays.push({ lowHealthAt: lowAt, eatingAt: eat.start, delayMs: eat.start - lowAt, completed: eat.state === 'SUCCEEDED' }); lowAt = null; }
		if (Number.isFinite(s.health) && s.health > 8) {
			if (lowAt !== null) uneatenEpisodes.push({ lowHealthAt: lowAt, eaten: false, recoveredAt: s.at });
			lowAt = null; lowEpisode = false;
		}
	}
	const unreachable = list.filter(a => combat(a.type)).flatMap(a => {
		const target = targetSamples.find(t => t.actionId === a.actionId);
		const noPath = /NO_(?:STANDABLE_)?PATH|UNREACHABLE|PATH_NOT_FOUND/.test(a.code ?? '');
		return noPath || (target?.verticalDelta > 3) ? [{ actionId: a.actionId, at: a.start, verticalDelta: target?.verticalDelta ?? null, noPath }] : [];
	});
	const failures = {};
	const stopTimes = protocolRows.filter(r => r.type === 'goal_control' && r.payload?.operation === 'stop').map(epoch).filter(Number.isFinite);
	const stopCancelled = a => a.state === 'CANCELLED' && (stopTimes.some(at => Number.isFinite(a.end) && a.end >= at) || /GOAL_STOP|BUDGET|STOP_REQUEST|AGENT_STOP/.test(a.code ?? ''));
	for (const a of list) if (a.state && a.state !== 'SUCCEEDED' && !stopCancelled(a)) failures[a.code ?? a.state] = (failures[a.code ?? a.state] ?? 0) + 1;
	for (const r of traceRows.filter(r => r.event === 'native_tool_rejected')) failures[r.reasonCode ?? 'REJECTED'] = (failures[r.reasonCode ?? 'REJECTED'] ?? 0) + 1;
	const playProviderRows = providerRows.filter(r => r.executionSettings?.controlProtocol === 'native_tools' || r.traceId);
	const firstOutput = playProviderRows.find(r => r.output)?.output ?? '';
	const overheadRows = providerRows.filter(r => r.executionSettings?.controlProtocol !== 'native_tools' && !r.traceId);
	const overheadStart = overheadRows.map(r => Number.isFinite(r.timestamp) && Number.isFinite(r.timing?.durationMs) ? r.timestamp - r.timing.durationMs : null).filter(Number.isFinite);
	const measuredStart = startedAt === null ? null : Math.min(startedAt, ...overheadStart);
	const overheadReportedCostUsd = overheadRows.every(r => Number.isFinite(r.costUsd)) ? overheadRows.reduce((sum, r) => sum + r.costUsd, 0) : null;
	const overheadCosts = overheadRows.map(r => estimateTokenCostUsd(normalizedProviderTokens(r), { ...profile, provider: r.provider ?? profile.provider, model: r.model ?? profile.model, serviceTier: r.executionSettings?.serviceTier ?? profile.serviceTier }));
	const overheadCostUsd = overheadCosts.every(Number.isFinite) ? overheadCosts.reduce((sum, value) => sum + value, 0) : null;
	const overheadTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	for (const r of overheadRows) {
		const tokens = normalizedProviderTokens(r);
		for (const name of Object.keys(overheadTokens)) overheadTokens[name] += tokens?.[name] ?? 0;
	}

	const firstSay = list.find(a => a.type === 'say' || a.type === 'chat');
	const firstText = firstOutput;
	const firstSayText = firstSay?.args?.message || firstSay?.args?.text || null;
	const planSteps = initialPlan?.plan?.steps ?? initialPlan?.steps ?? [];
	const planText = JSON.stringify(planSteps);
	const dimensionWord = scenario.setup.dimension.replace('minecraft:', '').replace('the_', '');
	const gearWords = [...Object.values(scenario.setup.armour ?? {}), ...(scenario.setup.inventory ?? []).map(i => i.item)].map(i => i.replace('minecraft:', '').replaceAll('_', ' '));
	const awarenessText = `${firstText}\n${planText}`;
	const milestones = new Map();
	const reached = (id, s) => { if (!milestones.has(id)) milestones.set(id, { id, at: s.at, elapsedMs: startedAt === null ? null : s.at - startedAt }); };
	for (const s of points) {
		if (s.dimension?.includes('the_nether')) reached('entered-nether', s);
		if (s.dimension?.includes('the_end')) reached('entered-end', s);
		if (['helmet','chestplate','leggings','boots'].every(part => itemCount(s.equipmentNbt?.includes('Inventory:') || s.equipmentNbt?.includes('ArmorItems:') ? wornArmourNbt(s.equipmentNbt) : s.equipmentNbt, new RegExp(`:iron_${part}$`)))) reached('iron-armour', s);
		if (itemCount(s.inventoryNbt, /_log$/) >= 10) reached('10-logs', s);
		for (const [id, pattern] of [['iron-ingot', /:iron_ingot$/], ['iron-pickaxe', /:iron_pickaxe$/], ['blaze-rod', /:blaze_rod$/], ['ender-pearl', /:ender_pearl$/], ['eye-of-ender', /:ender_eye$/]]) if (itemCount(s.inventoryNbt, pattern)) reached(id, s);
		for (const id of s.advancements ?? []) reached(id, s);
	}
	// A verified goal can remove its player before the next RCON sample, so the server's terminal (COMPLETED)
	// observation that closes this window still counts. The window must end at a verified completion of revision R.
	// When that is the goal_completion_result, the server then accepts it as a goal_control complete that moves the
	// goal to R+1; that transition belongs to this completion, not a boundary. The first COMPLETED observation after
	// the window end, of revision R or the transition's revision and before any other later goal control, counts.
	// Any other observation after the window end does not.
	const observedAt = r => r.payload?.observedAtEpochMs ?? epoch(r);
	const windowCompletion = endedAt === null ? null : protocolRows.find(r => isVerifiedGoalCompletion(r) && epoch(r) === endedAt) ?? null;
	const completedRevision = windowCompletion?.payload?.goalRevision ?? null;
	const isTransition = r => r.type === 'goal_control' && r.payload?.operation === 'complete' && isVerifiedGoalCompletion(r)
		&& (completedRevision === null || r.payload?.goalRevision == null || [completedRevision, completedRevision + 1].includes(r.payload.goalRevision));
	const transition = windowCompletion === null ? null : windowCompletion.type === 'goal_control' ? windowCompletion
		: protocolRows.filter(r => isTransition(r) && epoch(r) >= endedAt).sort((a, b) => epoch(a) - epoch(b))[0] ?? null;
	const nextControlAt = endedAt === null ? null : Math.min(...protocolRows.filter(r => r.type === 'goal_control' && r !== transition && epoch(r) > endedAt).map(epoch));
	const terminalRevisions = [completedRevision, transition?.payload?.goalRevision].filter(v => v !== undefined && v !== null);
	const sameGoal = r => r.payload?.goalRevision == null || terminalRevisions.length === 0 || terminalRevisions.includes(r.payload.goalRevision);
	const terminalObservation = windowCompletion === null ? null : protocolRows
		.filter(r => r.type === 'observation' && r.payload?.status === 'COMPLETED' && observedAt(r) > endedAt && observedAt(r) < nextControlAt)
		.sort((a, b) => observedAt(a) - observedAt(b))[0] ?? null;
	const terminalCounts = terminalObservation !== null && sameGoal(terminalObservation);
	const afterWindow = (r, at) => endedAt !== null && at > endedAt && !(terminalCounts && r === terminalObservation);
	for (const r of protocolRows.filter(r => r.type === 'observation')) {
		const p = r.payload ?? {}, items = p.inventory?.items ?? [];
		const at = p.observedAtEpochMs ?? epoch(r);
		if (!Number.isFinite(at) || startedAt !== null && at < startedAt || afterWindow(r, at)) continue;
		const has = pattern => items.some(i => pattern.test(i.itemId ?? '') && i.count > 0);
		const s = { at };
		if (items.filter(i => /_log$/.test(i.itemId ?? '')).reduce((n, i) => n + (i.count ?? 0), 0) >= 10) reached('10-logs', s);
		for (const [id, pattern] of [['iron-ingot', /:iron_ingot$/], ['iron-pickaxe', /:iron_pickaxe$/], ['blaze-rod', /:blaze_rod$/], ['ender-pearl', /:ender_pearl$/], ['eye-of-ender', /:ender_eye$/]]) if (has(pattern)) reached(id, s);
	}
	const nearest = at => { let found = null; for (const s of points) { if (s.at > at) break; found = s; } return found; };
	const timeline = list.map(a => { const s = nearest(a.end ?? a.start); return { at: a.start ?? null, elapsedMs: Number.isFinite(a.start) && startedAt !== null ? a.start - startedAt : null,
		tool: a.type, argsSummary: JSON.stringify(a.args ?? {}).slice(0, 220), resultCode: a.code ?? a.state ?? 'IN_FLIGHT', health: s?.health ?? null, position: s?.position ?? null, dimension: s?.dimension ?? null }; });
	const goalCompleted = protocolRows.some(r => isVerifiedGoalCompletion(r) && (startedAt === null || epoch(r) >= startedAt) && (endedAt === null || epoch(r) <= endedAt));
	const playWallTimeMs = startedAt !== null && endedAt !== null ? endedAt - startedAt : null;
	const totalCost = speed.costEstimateUsd === null || overheadCostUsd === null ? null : speed.costEstimateUsd + overheadCostUsd;
	const perMinute = value => Number.isFinite(value) && playWallTimeMs > 0 ? value * 60000 / playWallTimeMs : null;
	const overheadTokenRowsMissing = overheadRows.filter(r => normalizedProviderTokens(r) === null).length;
	const totalTokens = speed.tokens && overheadTokenRowsMissing === 0 ? Object.fromEntries(Object.entries(speed.tokens).map(([k, v]) => [k, v + overheadTokens[k]])) : null;
	const callTokens = providerCallTokens;
	const modelCallDetails = [
		...overheadRows.map((r, index) => ({ phase: 'preparation', index, at: epoch(r), durationMs: r.timing?.durationMs ?? null, model: r.model, tokens: normalizedProviderTokens(r) })),
		...traceRows.filter(r => r.event === 'native_model_call' && Number.isFinite(r.totalMs)).map((r, index) => ({ phase: 'play', index, at: r.endedAt ?? epoch(r), durationMs: r.totalMs, model: r.model ?? profile.model, tokens: callTokens(r) })),
	].map(r => ({ ...r, costEstimateUsd: estimateTokenCostUsd(r.tokens, { ...profile, model: r.model ?? profile.model }) }));
	const charged = tokens => tokens ? tokens.input + tokens.cacheWrite + tokens.output : null;
	const perCallCoverageComplete = modelCallDetails.length === speed.modelRounds + overheadRows.length && modelCallDetails.every(r => r.tokens !== null);
	const playCalls = modelCallDetails.filter(r => r.phase === 'play').sort((a, b) => a.at - b.at);
	const firstPlayCall = playCalls[0] ? { ...playCalls[0], cacheWarmth: playCalls[0].tokens ? (playCalls[0].tokens.cacheRead > 0 ? 'warm' : 'cold') : 'unknown' } : null;
	const steadyCalls = playCalls.slice(1);
	const steadyStart = firstPlayCall?.at;
	const steadyDurationMs = Number.isFinite(steadyStart) && endedAt > steadyStart ? endedAt - steadyStart : null;
	const sumTokens = rows => rows.length && rows.every(r => r.tokens) ? Object.fromEntries(Object.keys(overheadTokens).map(k => [k, rows.reduce((sum, r) => sum + r.tokens[k], 0)])) : null;
	const tokenReconciliation = reconcileProviderUsage(traceRows);
	const steadyTokens = sumTokens(steadyCalls);
	const steadyCost = steadyCalls.length && steadyCalls.every(r => Number.isFinite(r.costEstimateUsd)) ? steadyCalls.reduce((sum, r) => sum + r.costEstimateUsd, 0) : null;
	const steadyState = { calls: steadyCalls.length, startedAt: steadyStart ?? null, durationMs: steadyDurationMs, tokens: steadyTokens,
		tokensPerCall: steadyTokens ? Object.fromEntries(Object.entries(steadyTokens).map(([k, v]) => [k, v / steadyCalls.length])) : null,
		chargedTokensPerCall: steadyTokens ? charged(steadyTokens) / steadyCalls.length : null,
		chargedTokensPerMinute: steadyTokens && steadyDurationMs > 0 ? charged(steadyTokens) * 60000 / steadyDurationMs : null,
		costPerCallUsd: steadyCost === null ? null : steadyCost / steadyCalls.length,
		costPerMinuteUsd: steadyCost !== null && steadyDurationMs > 0 ? steadyCost * 60000 / steadyDurationMs : null };
	const partialMessagesAccepted = traceRows.filter(r => r.event === 'native_model_call').length > 0
		&& traceRows.filter(r => r.event === 'native_model_call').every(r => r.partialMessagesAccepted === true);
	// Goal preparation runs on its own translator model by design; only gameplay rows must match the gameplay profile.
	const providerMismatches = overheadRows.filter(r => r.provider && r.provider !== profile.provider).length
		+ providerRows.filter(r => !overheadRows.includes(r)).filter(r => r.provider && r.provider !== profile.provider || r.model && r.model !== profile.model
		|| ['model', 'reasoningEffort', 'serviceTier'].some(key => r.executionSettings?.effective?.[key] && r.executionSettings.effective[key] !== profile[key])).length
		+ traceRows.filter(r => r.event === 'native_model_call' && (r.provider && r.provider !== profile.provider || r.model && r.model !== profile.model)).length;
	const rateLimitedProviderRows = providerRows.filter(r => r.rateLimited === true || /RATE.?LIMIT|\b429\b/i.test(r.error?.code ?? '')).length;
	const progressEvents = [];
	const resources = [/_log$/, /:iron_ingot$/, /:iron_pickaxe$/, /:blaze_rod$/, /:ender_pearl$/, /:ender_eye$/];
	const startingCounts = resources.map(pattern => (scenario.setup.inventory ?? []).filter(i => pattern.test(i.item)).reduce((n, i) => n + (i.count ?? 1), 0));
	const startingAdvancements = new Set(points[0]?.advancements ?? []);
	for (const [i, s] of points.entries()) {
		const previous = points[i - 1];
		const respawn = deathEvents.some(e => e.at > (previous?.at ?? startedAt ?? -Infinity) && e.at <= s.at);
		if (s.dimension && s.dimension !== (previous?.dimension ?? scenario.setup.dimension) && !respawn) progressEvents.push({ at: s.at, kind: 'dimension-change', dimension: s.dimension });
		resources.forEach((pattern, i) => { const count = itemCount(s.inventoryNbt, pattern); if (count > startingCounts[i]) progressEvents.push({ at: s.at, kind: 'resource-gain', resource: pattern.source, count }); });
		for (const advancement of s.advancements ?? []) if (!startingAdvancements.has(advancement)) progressEvents.push({ at: s.at, kind: 'advancement', advancement });
	}
	for (const r of protocolRows.filter(r => r.type === 'observation')) {
		const at = r.payload?.observedAtEpochMs ?? epoch(r);
		if (!Number.isFinite(at) || startedAt !== null && at < startedAt || afterWindow(r, at)) continue;
		resources.forEach((pattern, i) => { const count = (r.payload?.inventory?.items ?? []).filter(item => pattern.test(item.itemId ?? '')).reduce((n, item) => n + (item.count ?? 0), 0); if (count > startingCounts[i]) progressEvents.push({ at, kind: 'resource-gain', resource: pattern.source, count }); });
	}
	const firstProgress = progressEvents.sort((a, b) => a.at - b.at)[0] ?? null;
	return { ...speed, steadyState, firstPlayCall, preparation: { calls: overheadRows.length, tokens: overheadTokens, chargedTokens: charged(overheadTokens), costEstimateUsd: overheadCostUsd }, tokenReconciliation, partialMessagesAccepted, providerMismatches, rateLimitedProviderRows, goalCompleted, costPerCompletedGoalUsd: goalCompleted ? totalCost : null, completedGoalWallTimeMs: goalCompleted && measuredStart !== null && endedAt !== null ? endedAt - measuredStart : null,
		progressV1: extractQualityProgress({ protocolRows, traceRows, samples, startedAt, endedAt, countItems: itemCount }),
		qualityV2: extractQualityMetricsV2({ actions: list, protocolRows, samples, targetSamples, providerRows, initialPlan, initialPlanCapture, startedAt, endedAt, stopCancelled }),
		modelCallDetails, perCallCoverageComplete, tokensPerCall: perCallCoverageComplete && modelCallDetails.length ? Object.fromEntries(Object.keys(overheadTokens).map(k => [k, modelCallDetails.reduce((n, r) => n + r.tokens[k], 0) / modelCallDetails.length])) : null,
		chargedTokensPerCall: perCallCoverageComplete && modelCallDetails.length ? modelCallDetails.reduce((n, r) => n + charged(r.tokens), 0) / modelCallDetails.length : null,
		chargedTokensPerMinute: perMinute(charged(totalTokens)), chargedTokenBasis: 'Uncached input + cache write + output; cache read reported separately.',
		progressCensored: !firstProgress, timeToProgressCensoredMs: firstProgress && startedAt !== null ? Math.max(0, firstProgress.at - startedAt) : playWallTimeMs, timeToFirstProgressMs: firstProgress && startedAt !== null ? Math.max(0, firstProgress.at - startedAt) : null, firstProgress,
		progressBasis: 'First resource gain above fixture inventory (logs, iron, blaze rods, pearls, eyes), non-respawn dimension transition or advancement absent at the first sample; setup progress excluded. Null means none observed, not zero.',
		rateBasis: 'Totals divided by observed play minutes, including preparation cost/tokens; fixture time excluded.', tokensPerMinute: totalTokens ? Object.fromEntries(Object.entries(totalTokens).map(([k, v]) => [k, perMinute(v)])) : null, costPerMinuteUsd: perMinute(totalCost), playCostPerMinuteUsd: perMinute(speed.costEstimateUsd), modelCallsPerMinute: perMinute(speed.modelRounds + overheadRows.length), actionsPerMinute: perMinute(list.length), toolFailuresPerMinute: perMinute(Object.values(failures).reduce((sum, n) => sum + n, 0)), stopInducedCancellations: list.filter(stopCancelled).length, modelCalls: speed.modelRounds + overheadRows.length, playModelCalls: speed.modelRounds, overheadModelCalls: overheadRows.length, overheadTokens,
		playTokens: speed.tokens, tokens: totalTokens,
		costEstimateUsd: speed.costEstimateUsd === null || overheadCostUsd === null ? null : speed.costEstimateUsd + overheadCostUsd,
		playCostEstimateUsd: speed.costEstimateUsd, overheadCostUsd, overheadReportedCostUsd,
		costCoverage: 'Play and overhead use the shared token-cost proxy. Provider-reported overhead USD is separate; this is not a subscription invoice.',
		overheadProfiles: [...new Set(overheadRows.map(r => `${r.provider}:${r.model}`))], actions: list.length, wallTimeMs: measuredStart !== null && endedAt !== null ? endedAt - measuredStart : null,
		playWallTimeMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
		overheadDurationMs: overheadRows.reduce((sum, r) => sum + (r.timing?.durationMs ?? 0), 0),
		wallTimeBasis: 'First captured goal-spec/planning request through first completion or stop; fixture construction excluded. Play time starts at goal_control start.',
		firstTurnUnderstanding: { text: firstText || null, firstSayText, initialPlan, mentionsDimension: firstText || planSteps.length ? wordHint(dimensionWord).test(awarenessText) : null,
			mentionsExistingGear: gearWords.length && (firstText || planSteps.length) ? gearWords.some(w => wordHint(w).test(awarenessText) || wordHint(w.split(' ')[0]).test(awarenessText)) : null,
			method: 'First captured provider turn plus first plan snapshot. The first say is separate and may occur later. Lexical hints require manual review; native turns can contain multiple model calls.' },
		initialPlanSteps: initialPlan ? { done: planSteps.filter(s => ['complete', 'completed', 'done'].includes(s.status)).length, pending: planSteps.filter(s => s.status === 'pending').length, active: planSteps.filter(s => s.status === 'active').length } : null,
		distanceNet: points.length > 1 && points[0].dimension === points.at(-1).dimension ? distance(points[0].position, points.at(-1).position) : null,
		distancePath: points.length > 1 ? path : null, timeStuckMs: points.length > 1 ? stuckMs : null,
		attacksOnUnreachableTargets: unreachable.length, unreachableAttacks: unreachable, combatActionsWithoutTargetSample: list.filter(a => combat(a.type) && !targetSamples.some(t => t.actionId === a.actionId)).length,
		damageTaken: points.some(s => Number.isFinite(s.damageTakenCounter)) ? Math.max(...points.map(s => s.damageTakenCounter).filter(Number.isFinite)) / 10 : null,
		damageObservedHealthLoss: points.length > 1 ? damageObserved : null, damageEvents,
		lowHealthEating: eatingDelays, lowHealthEpisodes: [...eatingDelays, ...uneatenEpisodes, ...(lowAt === null ? [] : [{ lowHealthAt: lowAt, eaten: false, until: endedAt }])], lowHealthEpisodeCount: points.some(s => Number.isFinite(s.health)) ? eatingDelays.length + uneatenEpisodes.length + Number(lowAt !== null) : null, lowHealthRecoveredWithoutEating: uneatenEpisodes, lowHealthWithoutEating: lowAt === null ? null : { since: lowAt, until: endedAt },
		deaths: deathEvents.length || (points.some(s => Number.isFinite(s.deathCounter)) ? Math.max(...points.map(s => s.deathCounter).filter(Number.isFinite)) : null), deathEvents,
		falls: points.length ? falls : null, toolFailuresByCode: failures, goalProgressMilestones: [...milestones.values()], timeline,
		coverage: { jsonlDroppedLines, overheadTokenRowsMissing, scoreboardGaps: { damageTaken: points.filter(s => !Number.isFinite(s.damageTakenCounter)).length, deaths: points.filter(s => !Number.isFinite(s.deathCounter)).length }, traceRows: traceRows.length, notebookRows: notebookRows.length, serverSamples: points.length, targetSamples: targetSamples.length, firstOutputCaptured: Boolean(firstText), initialPlanCaptured: Boolean(initialPlan),
			limitations: ['Path and stuck time use approximately 1s server samples and exclude dimension transitions and death/respawn intervals. Stationary combat is not movement stuck time.', 'Falls count sampled fallDistance crossings above 3 blocks.', 'Damage totals use vanilla damage_taken; individual sampled health drops can hide healing. Source is unknown unless explicitly recorded.', 'No target sample means unreachable status is unknown, not a reachable target.'] } };
}

function normalizedProviderTokens(row) {
	const t = row.tokens;
	if (!t || !Number.isFinite(t.input) || !Number.isFinite(t.output)) return null;
	const cacheRead = Number.isFinite(t.cached) ? t.cached : 0, cacheWrite = Number.isFinite(t.cacheWrite) ? t.cacheWrite : 0;
	return { input: row.provider === 'codex' ? Math.max(0, t.input - cacheRead - cacheWrite) : t.input, cacheRead, cacheWrite, output: t.output };
}
function wordHint(word) { return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'); }

export function summarizeQualityValues(values) {
	const clean = values.filter(Number.isFinite).sort((a, b) => a - b), n = clean.length;
	return { n, mean: n ? clean.reduce((sum, v) => sum + v, 0) / n : null,
		median: n ? (clean[Math.floor((n - 1) / 2)] + clean[Math.ceil((n - 1) / 2)]) / 2 : null,
		min: n ? clean[0] : null, max: n ? clean.at(-1) : null, range: n ? clean.at(-1) - clean[0] : null };
}

export function isEligibleQualityRun(r) {
	if (r.measurementStatus !== 'MEASURED' || !['PASSED', 'TIMEOUT', 'FAILED_USER_OBJECTIVE'].includes(r.termination)) return false;
	const m = r.metrics;
	if (!m?.perCallCoverageComplete || m.tokenReconciliation?.complete !== true || m.rateLimitedProviderRows > 0 || m.providerMismatches > 0) return false;
	if (!Number.isFinite(m.deaths) || !(m.modelCallsPerMinute > 0)) return false;
	if (!(m.steadyState?.chargedTokensPerCall > 0) || !(m.steadyState?.chargedTokensPerMinute > 0)) return false;
	if (r.profile?.provider === 'claude' && m.partialMessagesAccepted !== true) return false;
	const attestation = r.providerAttestation;
	if (!attestation || attestation.mismatches?.length || attestation.configuredVerified === false) return false;
	for (const settings of [attestation.requested, attestation.configured, attestation.effective]) {
		for (const key of ['provider', 'model', 'reasoningEffort', 'serviceTier']) if (settings?.[key] && r.profile?.[key] && settings[key] !== r.profile[key]) return false;
	}
	return true;
}

function pairedInterval(values) {
	values = values.filter(Number.isFinite);
	const n = values.length, mean = n ? values.reduce((sum, v) => sum + v, 0) / n : null;
	const critical = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
	const sd = n > 1 ? Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)) : null;
	const half = n >= 3 ? critical[Math.min(n - 1, 30)] * sd / Math.sqrt(n) : null;
	return { n, mean, sd, lower: half === null ? null : mean - half, upper: half === null ? null : mean + half };
}
const percentInterval = ci => Object.fromEntries(Object.entries(ci).map(([k, v]) => [k, ['mean', 'lower', 'upper'].includes(k) && v !== null ? Math.expm1(v) * 100 : v]));

// Meet in the middle counts all 2^n flips exactly without enumerating their product.
export function signFlipPermutation(values) {
	if (!values.length || values.some(v => !Number.isFinite(v)) || values.length > 40) return { pValue: null, exact: false, reason: 'Requires 1..40 finite pairs' };
	const sums = list => list.reduce((current, v) => current.flatMap(sum => [sum - v, sum + v]), [0]);
	const middle = Math.floor(values.length / 2), left = sums(values.slice(0, middle)), right = sums(values.slice(middle)).sort((a, b) => a - b);
	const observed = values.reduce((sum, v) => sum + v, 0), epsilon = 1e-12 * Math.max(1, values.reduce((sum, v) => sum + Math.abs(v), 0));
	let count = 0;
	for (const sum of left) {
		let low = 0, high = right.length;
		while (low < high) { const mid = Math.floor((low + high) / 2); if (right[mid] <= observed - sum + epsilon) low = mid + 1; else high = mid; }
		count += low;
	}
	return { pValue: count / (left.length * right.length), exact: true, alternatives: 2 ** values.length, alternative: 'B lower than A' };
}

function pairedSigns(deltas) {
	const finite = deltas.filter(Number.isFinite), lower = finite.filter(v => v < 0).length, higher = finite.filter(v => v > 0).length, n = lower + higher;
	let coefficient = 1, tail = 0;
	for (let k = 0; k <= n; k++) { if (k >= higher) tail += coefficient; coefficient *= (n - k) / (k + 1); }
	return { n: finite.length, lower, equal: finite.length - n, higher, discordant: n, pValue: n ? tail / 2 ** n : 1, status: n && tail / 2 ** n < .05 ? 'REGRESSED' : 'NO_DETECTED_REGRESSION' };
}
const completed = r => r.goalCompleted === true || r.metrics?.goalCompleted === true;
export function firstAttemptQualityRuns(runs, history = [], sequence = []) {
	const originals = new Map();
	for (const run of [...history, ...runs]) {
		const slot = sequence.find(row => row.executionOrder === run.executionOrder && row.retryAttempt === 0);
		if (!(run.retryAttempt === 0 || run.retryAttempt === undefined && run.retry !== true) || sequence.length && !slot) continue;
		if (!originals.has(run.pairId)) originals.set(run.pairId, run);
	}
	return [...originals.values()];
}

function firstAttemptFailures(before, after, firstBefore, firstAfter) {
	const original = (runs, expected) => {
		const ids = new Set(expected.map(run => run.pairId));
		return firstAttemptQualityRuns(runs).filter(run => ids.has(run.pairId));
	};
	const a = original(firstBefore, before), b = original(firstAfter, after);
	const summarize = runs => {
		const failed = runs.filter(run => !isEligibleQualityRun(run));
		const counts = field => failed.reduce((counts, run) => { const key = run[field] ?? 'UNKNOWN'; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});
		return { attempts: runs.length, failures: failed.length, byTermination: counts('termination'), byMeasurementStatus: counts('measurementStatus') };
	};
	const A = summarize(a), B = summarize(b);
	const complete = a.length === before.length && b.length === after.length && a.every(run => b.some(mate => mate.pairId === run.pairId));
	const signTest = pairedSigns(a.flatMap(run => { const mate = b.find(mate => mate.pairId === run.pairId); return mate ? [Number(!isEligibleQualityRun(mate)) - Number(!isEligibleQualityRun(run))] : []; }));
	return { A, B, complete, excessBFailures: B.failures - A.failures, signTest,
		status: !complete ? 'INCOMPLETE' : B.failures > A.failures ? 'REGRESSED' : 'NO_DETECTED_REGRESSION',
		method: 'First-attempt ineligible runs by arm. Any excess B failures is a conservative quality regression; the paired one-sided sign-test p-value is descriptive. Retries cannot erase failures.' };
}

function qualityGuards(pairs, firstAttempts) {
	const completion = pairedSigns(pairs.map(p => Number(completed(p.before)) - Number(completed(p.after))));
	const deaths = pairedSigns(pairs.map(p => Number.isFinite(p.before.metrics.deaths) && Number.isFinite(p.after.metrics.deaths) ? p.after.metrics.deaths - p.before.metrics.deaths : null));
	const progress = pairedSigns(pairs.map(p => Number(Boolean(p.before.metrics.firstProgress)) - Number(Boolean(p.after.metrics.firstProgress))));
	// Saved model rounds are useful unless game activity or observed progress also falls.
	const callsPerMinute = pairedSigns(pairs.map(p => {
		if (completed(p.after)) return 0;
		const a = p.before.metrics, b = p.after.metrics;
		if (!(a.modelCallsPerMinute > 0) || !Number.isFinite(b.modelCallsPerMinute)) return null;
		if (b.modelCallsPerMinute >= .8 * a.modelCallsPerMinute) return 0;
		const progressDropped = Boolean(a.firstProgress) && !b.firstProgress;
		if (progressDropped) return 1;
		if (!Number.isFinite(a.actionsPerMinute) || !Number.isFinite(b.actionsPerMinute)) return null;
		return b.actionsPerMinute < .8 * a.actionsPerMinute ? 1 : 0;
	}));
	const complete = deaths.n === pairs.length && callsPerMinute.n === pairs.length && firstAttempts.complete;
	return { completion, deaths, progress, callsPerMinute, firstAttemptFailures: firstAttempts, complete,
		status: !complete ? 'INCOMPLETE' : [completion, deaths, progress, callsPerMinute, firstAttempts].some(g => g.status === 'REGRESSED') ? 'REGRESSED' : 'NO_DETECTED_REGRESSION',
		method: 'One-sided exact paired sign tests, p < .05; deaths and completion have zero tolerance. A >20% calls/min decline in noncompleted B runs counts as a stall only with >20% actions/min decline or lost observed progress. First-attempt failures use a conservative excess-B guard.' };

}

export function pairedTokenConfidence(before, after, { firstAttemptsBefore = before, firstAttemptsAfter = after } = {}) {
	if (new Set(before.map(r => r.pairId).filter(Boolean)).size !== before.filter(r => r.pairId).length || new Set(after.map(r => r.pairId).filter(Boolean)).size !== after.filter(r => r.pairId).length) throw new Error('Duplicate pairId in benchmark arm');
	const paired = before.flatMap(b => { const a = after.find(a => a.pairId && a.pairId === b.pairId); return a && isEligibleQualityRun(b) && isEligibleQualityRun(a) ? [{ before: b, after: a }] : []; });
	const logRatio = (p, name) => p.before.metrics.steadyState?.[name] > 0 && p.after.metrics.steadyState?.[name] > 0 ? Math.log(p.after.metrics.steadyState[name] / p.before.metrics.steadyState[name]) : null;
	const callLogs = paired.map(p => logRatio(p, 'chargedTokensPerCall')), rateLogs = paired.map(p => logRatio(p, 'chargedTokensPerMinute'));
	const perCall = pairedInterval(callLogs), perMinute = pairedInterval(rateLogs);
	const order = r => r.actualExecutionOrder ?? r.executionOrder;
	const orders = [...before, ...after].map(order);
	const ordered = orders.every(Number.isInteger) && new Set(orders).size === orders.length && paired.every(p => Math.abs(order(p.after) - order(p.before)) === 1);
	const complete = before.length === after.length && paired.length === before.length && paired.length > 0;
	const cacheWarmthMatched = paired.every(p => ['warm', 'cold'].includes(p.before.metrics.firstPlayCall?.cacheWarmth) && p.before.metrics.firstPlayCall.cacheWarmth === p.after.metrics.firstPlayCall?.cacheWarmth);
	const firstAttempts = firstAttemptFailures(before, after, firstAttemptsBefore, firstAttemptsAfter);
	const guards = qualityGuards(paired, firstAttempts);
	const cacheWarmthMismatches = paired.filter(p => p.before.metrics.firstPlayCall?.cacheWarmth !== p.after.metrics.firstPlayCall?.cacheWarmth).length;
	const signFlip = { perCall: signFlipPermutation(callLogs), perMinute: signFlipPermutation(rateLogs.map(v => v === null ? null : v - Math.log(1.05))) };
	const conclusive = complete && ordered && guards.complete && signFlip.perCall.exact && perCall.n >= 3 && perMinute.n === perCall.n;
	const costPass = perCall.upper < 0 && perMinute.upper <= Math.log(1.05) + 1e-12 && signFlip.perCall.pValue !== null && signFlip.perCall.pValue < .05;
	const verdict = !conclusive ? 'INCONCLUSIVE' : costPass ? guards.status === 'REGRESSED' ? 'COST_PASS_QUALITY_REGRESSION' : 'PASS' : 'FAIL';
	return { confidence: .95, method: 'Paired Student t intervals on log(B/A), equal weight per pair across scenarios. df >30 uses df=30. Exact sign flips check the per-call saving.',
		tokenBasis: 'Steady-state uncached input + cache write + output, excluding preparation and first play call; duration from first play call end to window end.',
		pairs: paired.length, complete, interleaved: ordered, cacheWarmthMatched, cacheWarmthMismatches, perCallLogRatio: perCall, perMinuteLogRatio: perMinute,
		perCallPercent: percentInterval(perCall), tokensPerMinutePercent: percentInterval(perMinute), signFlip, qualityGuards: guards,
		secondaryCostProxy: Object.fromEntries(['costPerCallUsd', 'costPerMinuteUsd'].map(name => [name, percentInterval(pairedInterval(paired.map(p => logRatio(p, name))))])),
		perPair: paired.map((p, i) => ({ pairId: p.before.pairId, scenario: p.before.scenario, firstCallWarmth: { A: p.before.metrics.firstPlayCall?.cacheWarmth ?? 'unknown', B: p.after.metrics.firstPlayCall?.cacheWarmth ?? 'unknown' }, perCallLogRatio: callLogs[i], perMinuteLogRatio: rateLogs[i], beforeOrder: order(p.before), afterOrder: order(p.after), beforeOriginalOrder: p.before.executionOrder, afterOriginalOrder: p.after.executionOrder })),
		power: { estimatedPairsFor80Percent: perCall.mean < 0 && perCall.sd !== null ? Math.max(3, Math.ceil(((1.96 + .842) * perCall.sd / Math.abs(perCall.mean)) ** 2)) : null, method: 'Normal approximation from observed pooled log-ratio SD and saving; estimated, unstable at small n.' }, verdict,
		requirements: 'Only pooled verdict decides: per-call upper log bound <0, rate upper <=log(1.05), per-call sign-flip p<.05, healthy complete adjacent pairs, reported first-call warmth, complete quality guards without detected regression.' };
}

function descriptiveConfidence(before, after) {
	const { verdict, ...statistics } = pairedTokenConfidence(before, after);
	return { ...statistics, interpretation: 'DESCRIPTIVE', limitation: 'Per-scenario intervals do not decide acceptance.' };
}

export function compareQualityReports(base, after) {
	const runsOf = report => report.runs ?? [report];
	const identity = report => ({ coordinatorSha256: report.coordinatorSha256 ?? null, jarSha256: report.jar?.sha256 ?? null,
		harnessCommit: report.harnessCommit ?? null, instrumentationSha256: report.instrumentationSha256 ?? report.reextraction?.extractorSha256 ?? null,
		extractorSha256: report.reextraction?.extractorSha256 ?? report.metricsExtractorSha256 ?? null,
		scenarioDataSha256: report.scenarioDataSha256 ?? null });
	const identities = { before: identity(base), after: identity(after) };
	const conditionWarnings = [];
	for (const field of ['scenarioDataSha256', 'instrumentationSha256']) {
		const b = identities.before[field], a = identities.after[field];
		if (b && a && b !== a) throw new Error(`Incomparable reports: ${field} mismatch`);
		if (!b || !a) conditionWarnings.push(`Missing ${field}; equal conditions cannot be verified`);
	}
	for (const field of ['coordinatorSha256', 'jarSha256', 'harnessCommit']) if (!identities.before[field] || !identities.after[field]) conditionWarnings.push(`Missing ${field}; arm identity cannot be verified`);
	if (identities.before.extractorSha256 || identities.after.extractorSha256) {
		if (identities.before.extractorSha256 && identities.after.extractorSha256 && identities.before.extractorSha256 !== identities.after.extractorSha256) throw new Error('Incomparable reports: extractorSha256 mismatch');
		if (!identities.before.extractorSha256 || !identities.after.extractorSha256) conditionWarnings.push('Missing extractorSha256; equal extraction cannot be verified');
	}
	if (!identities.before.instrumentationSha256 && !identities.after.instrumentationSha256 && identities.before.harnessCommit && identities.after.harnessCommit && identities.before.harnessCommit !== identities.after.harnessCommit) throw new Error('Incomparable reports: harnessCommit mismatch without instrumentation identity');
	const groupKey = r => [r.scenario, r.profile?.provider, r.profile?.model, r.profile?.reasoningEffort, r.profile?.serviceTier].join('|');
	const groups = new Set([...runsOf(base), ...runsOf(after)].map(groupKey));
	return [...groups].map(key => {
		const before = runsOf(base).filter(r => groupKey(r) === key), candidate = runsOf(after).filter(r => groupKey(r) === key);
		const budgets = [...before, ...candidate].map(r => r.definition?.durationBudgetMs ?? r.durationBudgetMs);
		const finiteBudgets = budgets.filter(Number.isFinite);
		if (new Set(finiteBudgets).size > 1) throw new Error(`Incomparable reports: durationBudgetMs mismatch for ${key}`);
		const warnings = [...conditionWarnings];
		const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
			? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
		const definitions = [...before, ...candidate].map(r => r.definition ? JSON.stringify(canonical(Object.fromEntries(Object.entries(r.definition).filter(([k]) => k !== 'repetition')))) : null);
		if (new Set(definitions.filter(Boolean)).size > 1) throw new Error(`Incomparable reports: per-run scenario definition mismatch for ${key}`);
		if (definitions.some(d => d === null)) warnings.push('Missing per-run definition; scenario setup equality cannot be verified');
		if (finiteBudgets.length !== budgets.length) warnings.push('Missing durationBudgetMs; equal budgets cannot be verified');
		const measured = runs => runs.filter(r => r.measurementStatus === 'MEASURED');
		const dimension = (get, filter = () => true) => {
			const b = summarizeQualityValues(measured(before).filter(filter).map(get)), a = summarizeQualityValues(measured(candidate).filter(filter).map(get));
			return { beforeMean: b.mean, afterMean: a.mean, delta: a.mean === null || b.mean === null ? null : a.mean - b.mean,
				percent: a.mean === null || !b.mean ? null : (a.mean - b.mean) / b.mean * 100, before: b, after: a };
		};
		const completed = r => r.goalCompleted === true || r.metrics?.goalCompleted === true;
		const names = ['wallTimeMs', 'playWallTimeMs', 'overheadDurationMs', 'modelCalls', 'costEstimateUsd', 'actions', 'distanceNet', 'distancePath', 'timeStuckMs', 'attacksOnUnreachableTargets', 'damageTaken', 'damageObservedHealthLoss', 'deaths', 'falls', 'lowHealthEpisodeCount', 'costPerMinuteUsd', 'modelCallsPerMinute', 'actionsPerMinute', 'toolFailuresPerMinute', 'stopInducedCancellations', 'chargedTokensPerCall', 'chargedTokensPerMinute', 'timeToProgressCensoredMs'];
		const codes = new Set([...before, ...candidate].flatMap(r => Object.keys(r.metrics?.toolFailuresByCode ?? {})));
		const fightCodes = new Set([...before, ...candidate].flatMap(r => Object.keys(r.metrics?.qualityV2?.failedFightRequestsByCode ?? {})));
		const progressSummary = runs => { const observed = measured(runs); return { runs: observed.length, withProgress: observed.filter(r => r.metrics?.firstProgress).length, censored: observed.filter(r => !r.metrics?.firstProgress).length, shareWithProgress: observed.length ? observed.filter(r => r.metrics?.firstProgress).length / observed.length : null, timeMs: summarizeQualityValues(observed.map(r => r.metrics?.timeToFirstProgressMs ?? r.metrics?.playWallTimeMs)), basis: 'No-progress runs are right-censored at their observed play window; mean uses that lower bound.' }; };
		const causeSummary = runs => { const causes = {}; for (const r of measured(runs)) { const events = r.metrics?.deathEvents ?? []; for (const event of events) { const cause = typeof event.cause === 'string' ? event.cause : JSON.stringify(event.cause ?? 'unknown'); causes[cause] = (causes[cause] ?? 0) + 1; } const missing = Math.max(0, (r.metrics?.deaths ?? 0) - events.length); if (missing) causes.unknown = (causes.unknown ?? 0) + missing; } return causes; };
		const pairedDeltas = Object.fromEntries(['deaths', 'attacksOnUnreachableTargets'].map(name => [name, pairedSigns(before.flatMap(b => { const a = candidate.find(a => a.pairId && a.pairId === b.pairId); return a && Number.isFinite(b.metrics?.[name]) && Number.isFinite(a.metrics?.[name]) ? [a.metrics[name] - b.metrics[name]] : []; }))]));
		const milestones = new Set([...before, ...candidate].flatMap(r => (r.metrics?.goalProgressMilestones ?? []).map(m => m.id)));
		return { key, beforeAttempts: before.length, afterAttempts: candidate.length, beforeMeasured: measured(before).length, afterMeasured: measured(candidate).length,
			tokenConfidence: descriptiveConfidence(before, candidate),
			conditions: { status: warnings.length ? 'UNVERIFIABLE' : 'MATCHED', warnings, identities,
				armDifferences: ['coordinatorSha256', 'jarSha256', 'harnessCommit'].filter(field => identities.before[field] && identities.after[field] && identities.before[field] !== identities.after[field]) },
			awarenessPairing: { usable: [...before, ...candidate].every(r => r.metrics?.coverage?.firstOutputCaptured === true), basis: 'First-response awareness hints are usable only when both arms captured every first response; otherwise manual single-arm evidence only.' },
			progress: { before: progressSummary(before), after: progressSummary(candidate) }, deathCauses: { before: causeSummary(before), after: causeSummary(candidate) }, pairedDeltas,
			completion: { before: { attempts: before.length, completed: before.filter(completed).length, rate: before.length ? before.filter(completed).length / before.length : null },
				after: { attempts: candidate.length, completed: candidate.filter(completed).length, rate: candidate.length ? candidate.filter(completed).length / candidate.length : null } },
			completedGoals: { costUsd: dimension(r => r.metrics?.costEstimateUsd, completed), wallTimeMs: dimension(r => r.metrics?.wallTimeMs, completed) },
			metrics: Object.fromEntries(names.map(n => [n, dimension(r => n === 'timeToProgressCensoredMs' ? r.metrics?.timeToFirstProgressMs ?? r.metrics?.playWallTimeMs : r.metrics?.[n])])),
			qualityV2: { version: 2,
				metrics: Object.fromEntries(['failedFightRequests', 'attacksOnUnreachableTargets', 'combatActionsWithoutTargetSample', 'lowHealthEpisodeCount', 'repeatedIdenticalFailingRequests', 'stationarySprintSeconds'].map(n => [n, dimension(r => r.metrics?.qualityV2?.[n])])),
				failedFightRequestsByCode: Object.fromEntries([...fightCodes].map(code => [code, dimension(r => r.metrics?.qualityV2 ? r.metrics.qualityV2.failedFightRequestsByCode[code] ?? 0 : null)])),
				lowHealthOutcomes: Object.fromEntries(['recoveredByHealing', 'recoveredWithoutEating', 'died', 'censored'].map(outcome => [outcome, dimension(r => r.metrics?.qualityV2?.lowHealthOutcomes?.[outcome])])),
				hazardDeathsByType: Object.fromEntries(['lava', 'fire', 'fall', 'mob', 'other', 'unknown'].map(type => [type, dimension(r => r.metrics?.qualityV2?.hazardDeathsByType?.[type])])),
				foodUsedBelow6HpDeaths: dimension(r => r.metrics?.qualityV2?.foodUsedBelow6HpBeforeDeath?.filter(d => d.used === true).length),
				firstResponseCaptured: dimension(r => r.metrics?.qualityV2 ? Number(r.metrics.qualityV2.firstResponse.captured) : null),
				initialPlanCaptured: dimension(r => r.metrics?.qualityV2 ? Number(Boolean(r.metrics.qualityV2.initialPlan)) : null) },
			tokens: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(n => [n, dimension(r => r.metrics?.tokens?.[n])])),
			tokensPerMinute: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(n => [n, dimension(r => r.metrics?.playWallTimeMs > 0 && Number.isFinite(r.metrics?.tokens?.[n]) ? r.metrics.tokens[n] * 60000 / r.metrics.playWallTimeMs : null)])),
			initialPlanSteps: Object.fromEntries(['done', 'pending', 'active'].map(n => [n, dimension(r => r.metrics?.initialPlanSteps?.[n])])),
			lowHealthEatingDelayMs: dimension(r => { const v = (r.metrics?.lowHealthEating ?? []).map(e => e.delayMs).filter(Number.isFinite); return v.length ? v.reduce((n, delay) => n + delay, 0) / v.length : null; }),
			zeroLowHealthEpisodes: dimension(r => Number.isFinite(r.metrics?.lowHealthEpisodeCount) ? Number(r.metrics.lowHealthEpisodeCount === 0) : null),
			toolFailuresByCode: Object.fromEntries([...codes].map(code => [code, dimension(r => r.metrics?.toolFailuresByCode ? r.metrics.toolFailuresByCode[code] ?? 0 : null)])),
			toolFailuresByCodePerMinute: Object.fromEntries([...codes].map(code => [code, dimension(r => r.metrics?.toolFailuresByCode && r.metrics.playWallTimeMs > 0 ? (r.metrics.toolFailuresByCode[code] ?? 0) * 60000 / r.metrics.playWallTimeMs : null)])),
			goalProgressMilestones: Object.fromEntries([...milestones].map(id => [id, {
				reachedShare: dimension(r => r.metrics?.goalProgressMilestones ? Number(r.metrics.goalProgressMilestones.some(m => m.id === id)) : null),
				elapsedMs: dimension(r => r.metrics?.goalProgressMilestones?.find(m => m.id === id)?.elapsedMs),
			}])), perRun: { before, after: candidate } };
	});
}
