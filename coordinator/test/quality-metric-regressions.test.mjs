import assert from 'node:assert/strict';
import test from 'node:test';
import { extractQualityMetrics, providerCallTokens, parseEntitySample, parseJsonlDiagnostics, resolveGoalWindow, compareQualityReports } from '../src/benchmark/quality-metrics.mjs';
import { estimateTokenCostUsd, TOKEN_PRICES_PER_MILLION } from '../src/call-cost.mjs';
import { SPEED_TOKEN_PRICES_PER_MILLION, deriveRunMetrics } from '../src/benchmark/live-speed-benchmark.mjs';
const profile = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' };
const scenario = { setup: { dimension: 'minecraft:the_end', armour: {}, inventory: [{ item: 'minecraft:diamond_sword' }] } };
const extract = extra => extractQualityMetrics({ scenario, profile, startedAt: 0, endedAt: 60000, ...extra });
const sample = (at, x, health = 20, extra = {}) => ({ at, position: { x, y: 0, z: 0 }, dimension: 'minecraft:overworld', health, ...extra });
const protocol = (type, at, payload = {}) => ({ type, at, payload });

test('null health never creates or closes a low-health episode', () => {
	assert.equal(extract({ samples: [sample(0, 0, null), sample(1000, 1, null)] }).lowHealthEpisodeCount, null);
	const m = extract({ samples: [sample(0, 0, 6), sample(1000, 1, null), sample(2000, 2, 10)] });
	assert.deepEqual(m.lowHealthRecoveredWithoutEating, [{ lowHealthAt: 0, eaten: false, recoveredAt: 2000 }]);
});
test('path and observed damage exclude death/respawn jumps', () => {
	const m = extract({ samples: [sample(0, 0, 5), sample(1000, 1000), sample(2000, 1001)], protocolRows: [protocol('goal_control', 500, { operation: 'dead' })] });
	assert.equal(m.distancePath, 1);
	assert.equal(m.damageObservedHealthLoss, 0);
	assert.equal(m.deaths, 1);
	assert.equal(extract({ samples: [sample(0, 0, 20, { deathCounter: 0 }), sample(1000, 1000, 20, { deathCounter: 1 })] }).distancePath, 0);
});
test('recovered uneaten health episodes remain measurable', () => {
	const m = extract({ samples: [sample(0, 0, 6), sample(1000, 1, 10)] });
	assert.equal(m.lowHealthEpisodeCount, 1);
	assert.equal(m.lowHealthRecoveredWithoutEating.length, 1);
});
test('armour milestone counts only worn slots, including nested components', () => {
	const items = ['helmet', 'chestplate', 'leggings', 'boots'].map((part, i) => `{Slot: ${i}b, components: {"minecraft:custom_data": {x: 1}}, id: "minecraft:iron_${part}", count: 1}`);
	const carried = parseEntitySample(`{Pos: [0d, 0d, 0d], Inventory: [${items.join(',')}]}`, 0);
	assert.equal(extract({ samples: [carried] }).goalProgressMilestones.some(m => m.id === 'iron-armour'), false);
	const worn = parseEntitySample(`{Pos: [0d, 0d, 0d], Inventory: [${items.map((s, i) => s.replace(`Slot: ${i}b`, `Slot: ${100 + i}b`)).join(',')}]}`, 0);
	assert.equal(extract({ samples: [worn] }).goalProgressMilestones.some(m => m.id === 'iron-armour'), true);
	const armorItems = parseEntitySample(`{Pos: [0d, 0d, 0d], ArmorItems: [${items.join(',')}]}`, 0);
	assert.equal(extract({ samples: [armorItems] }).goalProgressMilestones.some(m => m.id === 'iron-armour'), true);
});
test('NaN scoreboard reads retain finite totals and report missing coverage', () => {
	const m = extract({ samples: [sample(0, 0, 20, { damageTakenCounter: 100, deathCounter: 2 }), sample(1000, 1, 20, { damageTakenCounter: NaN, deathCounter: NaN })] });
	assert.equal(m.damageTaken, 10); assert.equal(m.deaths, 2);
	assert.deepEqual(m.coverage.scoreboardGaps, { damageTaken: 1, deaths: 1 });
});
test('Codex overhead input removes cache before adding token categories', () => {
	const m = extract({ providerRows: [{ provider: 'codex', model: 'gpt-6.1-sol', executionSettings: { controlProtocol: 'goal_spec', serviceTier: 'fast' }, tokens: { input: 100, cached: 40, output: 10 } }] });
	assert.deepEqual(m.overheadTokens, { input: 60, cacheRead: 40, cacheWrite: 0, output: 10 });
});
test('stationary combat is not movement stuck time', () => {
	const row = type => protocol('action_command', 0, { actionId: 'a', actionType: type });
	const samples = [sample(0, 0), sample(1000, 0)];
	assert.equal(extract({ samples, protocolRows: [row('fight_target')] }).timeStuckMs, 0);
	assert.equal(extract({ samples, protocolRows: [row('navigate_to')] }).timeStuckMs, 1000);
});
test('stop-induced cancellation excluded, real failures and per-minute rates retained', () => {
	const m = extract({ protocolRows: [protocol('action_command', 0, { actionId: 'a', actionType: 'navigate_to' }), protocol('goal_control', 60000, { operation: 'stop' }), protocol('action_result', 60001, { actionId: 'a', state: 'CANCELLED' }), protocol('action_result', 1000, { actionId: 'b', state: 'FAILED', reasonCode: 'NO_PATH' })] });
	assert.deepEqual(m.toolFailuresByCode, { NO_PATH: 1 }); assert.equal(m.toolFailuresPerMinute, 1); assert.equal(m.stopInducedCancellations, 1);
});
test('JSONL diagnostics preserve final complete line and count malformed evidence', () => {
	assert.deepEqual(parseJsonlDiagnostics('{"at":1}\nbad\n{"at":2}'), { rows: [{ at: 1 }, { at: 2 }], droppedLines: 1, nonemptyLines: 3 });
	assert.equal(extract({ jsonlDroppedLines: 2 }).coverage.jsonlDroppedLines, 2);
});
test('goal window consistently ends at first completion or stop', () => {
	const rows = [protocol('goal_control', 1, { operation: 'start' }), protocol('goal_control', 3, { operation: 'complete' }), protocol('goal_control', 4, { operation: 'stop' })];
	assert.deepEqual(resolveGoalWindow(rows), { startedAt: 1, endedAt: 3, goalCompleted: true, termination: 'GOAL_COMPLETED' });
	assert.equal(resolveGoalWindow([rows[0], rows[2]]).endedAt, 4);
});
test('word hints do not count send or diamonds as end or diamond', () => {
	const first = output => extract({ providerRows: [{ traceId: 'first', output }] }).firstTurnUnderstanding;
	assert.equal(first('send a message and find diamonds').mentionsDimension, false);
	assert.equal(first('send a message and find diamonds').mentionsExistingGear, false);
	assert.equal(first('I am in the End with a diamond sword').mentionsDimension, true);
});
test('overhead proxy uses the same token price basis and retains provider reported USD', () => {
	const tokens = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 };
	const m = extract({ providerRows: [{ provider: 'claude', model: profile.model, tokens: { input: 10, cached: 20, cacheWrite: 30, output: 40 }, costUsd: .9 }] });
	assert.equal(m.overheadCostUsd, estimateTokenCostUsd(tokens, profile)); assert.equal(m.overheadReportedCostUsd, .9);
});
test('per-minute token totals use play duration and missing health stays null', () => {
	const m = extract({ traceRows: [{ event: 'native_model_call', agentId: 'a', goalRevision: 1, totalMs: 1, inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 }] });
	assert.deepEqual(m.tokensPerMinute, m.tokens);
	assert.equal(m.costPerMinuteUsd, m.costEstimateUsd);
	assert.equal(m.lowHealthEpisodeCount, null);
	assert.equal(extract({ samples: [sample(0, 0)] }).lowHealthEpisodeCount, 0);
});
test('missing preparation token evidence keeps combined totals unknown', () => {
	const m = extract({ traceRows: [{ event: 'native_model_call', agentId: 'a', goalRevision: 1, totalMs: 1, inputTokens: 100, outputTokens: 10 }], providerRows: [{ provider: 'claude', model: profile.model }] });
	assert.equal(m.tokens, null); assert.equal(m.tokensPerMinute, null); assert.equal(m.costEstimateUsd, null);
	assert.equal(m.coverage.overheadTokenRowsMissing, 1); assert.equal(m.playTokens.input, 100);
});

test('Minecraft 26.1 equipment compound counts worn armour but not held armour', () => {
	const gear = 'head: {count: 1, id: "minecraft:iron_helmet"}, chest: {count: 1, id: "minecraft:iron_chestplate"}, legs: {count: 1, id: "minecraft:iron_leggings"}, feet: {count: 1, id: "minecraft:iron_boots"}';
	const s = parseEntitySample(`{Pos: [0d, 0d, 0d], equipment: {${gear}}, Inventory: []}`, 0);
	assert.equal(extract({ samples: [s] }).goalProgressMilestones.some(m => m.id === 'iron-armour'), true);
	const held = parseEntitySample(`{Pos: [0d, 0d, 0d], equipment: {${gear.replace('head:', 'mainhand:')}}, Inventory: []}`, 0);
	assert.equal(extract({ samples: [held] }).goalProgressMilestones.some(m => m.id === 'iron-armour'), false);
});test('coordinator completion requests do not end play or imply verified success', () => {
	const rows = [protocol('goal_control', 100, { operation: 'start' }), { direction: 'coordinator_to_server', ...protocol('goal_completed', 200) }, protocol('goal_completion_result', 201, { verified: false }), protocol('goal_control', 1000, { operation: 'stop' })];
	assert.equal(resolveGoalWindow(rows).endedAt, 1000);
	assert.equal(resolveGoalWindow(rows).goalCompleted, false);
	assert.equal(extract({ startedAt: 100, endedAt: 1000, protocolRows: rows }).goalCompleted, false);
	const verified = [...rows.slice(0, 2), protocol('goal_completion_result', 250, { verified: true }), rows.at(-1)];
	assert.equal(resolveGoalWindow(verified).endedAt, 250);
	assert.equal(resolveGoalWindow(verified).goalCompleted, true);
});

test('thread totals with a legacy uncached field that includes cache writes reconcile with call rows', () => {
	const thread = { inputTokens: 598837, cachedInputTokens: 464679, cacheWriteInputTokens: 134130, uncachedInputTokens: 134158, outputTokens: 5296 };
	assert.deepEqual(providerCallTokens(thread), { input: 28, cacheRead: 464679, cacheWrite: 134130, output: 5296 });
	assert.deepEqual(providerCallTokens({ uncachedInputTokens: 10, cachedInputTokens: 5, outputTokens: 1 }), { input: 10, cacheRead: 5, cacheWrite: 0, output: 1 });
});
test('inventory observed after the goal window grants no progress or milestone', () => {
	const iron = (observedAt, receivedAt = observedAt) => ({ type: 'observation', at: receivedAt, payload: { observedAtEpochMs: observedAt, inventory: { items: [{ itemId: 'minecraft:iron_ingot', count: 1 }] } } });
	const window = rows => extractQualityMetrics({ scenario, profile, startedAt: 100, endedAt: 200, protocolRows: rows });
	const late = window([iron(300)]);
	assert.equal(late.firstProgress, null);
	assert.equal(late.progressCensored, true);
	assert.equal(late.timeToFirstProgressMs, null);
	assert.ok(!late.goalProgressMilestones.some(m => m.id === 'iron-ingot'));
	const boundary = window([iron(200)]);
	assert.equal(boundary.firstProgress.at, 200);
	assert.ok(boundary.goalProgressMilestones.some(m => m.id === 'iron-ingot'));
	// Observed inside the window but received during the drain still counts.
	assert.equal(window([iron(150, 400)]).firstProgress.at, 150);
	// The server's terminal COMPLETED observation that closes the window counts; a later one does not.
	const terminal = (observedAt, item) => ({ type: 'observation', at: observedAt, payload: { status: 'COMPLETED', observedAtEpochMs: observedAt, inventory: { items: [{ itemId: item, count: 1 }] } } });
	const completedAt = (at, revision = 1) => ({ type: 'goal_control', at, payload: { operation: 'complete', goalRevision: revision, updatedAtEpochMs: at } });
	const revised = (row, goalRevision) => ({ ...row, payload: { ...row.payload, goalRevision } });
	const closed = window([completedAt(200), terminal(201, 'minecraft:iron_ingot'), terminal(500, 'minecraft:ender_pearl')]);
	assert.ok(closed.goalProgressMilestones.some(m => m.id === 'iron-ingot'));
	assert.ok(!closed.goalProgressMilestones.some(m => m.id === 'ender-pearl'));
	// A window that ended by stop or timeout has no completion to close it: a later COMPLETED observation grants nothing.
	for (const rows of [[terminal(300, 'minecraft:iron_ingot')], [{ type: 'goal_control', at: 200, payload: { operation: 'stop', updatedAtEpochMs: 200 } }, terminal(300, 'minecraft:iron_ingot')],
		// Another goal's completion after a new start, or another revision, does not belong to this window either.
		[completedAt(200), { type: 'goal_control', at: 250, payload: { operation: 'start', updatedAtEpochMs: 250 } }, terminal(300, 'minecraft:iron_ingot')],
		[completedAt(200, 1), revised(terminal(300, 'minecraft:iron_ingot'), 2)]]) {
		const late = window(rows);
		assert.equal(late.firstProgress, null, JSON.stringify(rows));
		assert.ok(!late.goalProgressMilestones.some(m => m.id === 'iron-ingot'));
	}
});
test('a wrapped outbound completion does not count as a verified goal completion', () => {
	const wrapped = (direction, type, payload) => ({ direction, observedAtMs: 1000, envelope: { type, payload: { updatedAtEpochMs: 1000, observedAtEpochMs: 1000, ...payload } } });
	for (const row of [wrapped('coordinator_to_server', 'goal_control', { operation: 'complete' }), wrapped('coordinator_to_server', 'goal_completion_result', { verified: true })]) {
		assert.equal(extract({ protocolRows: [row] }).goalCompleted, false);
		assert.equal(resolveGoalWindow([row]).goalCompleted, false);
	}
	assert.equal(extract({ protocolRows: [wrapped('server_to_coordinator', 'goal_control', { operation: 'complete' })] }).goalCompleted, true);
	assert.equal(extract({ protocolRows: [wrapped('coordinator_to_server', 'goal_completed', {})] }).goalCompleted, false);
});
test('a requested completion keeps its terminal inventory across the R to R+1 completion transition', () => {
	const row = (type, payload) => ({ direction: 'server_to_coordinator', envelope: { type, agentId: 'a', payload } });
	const logs = (at, goalRevision) => row('observation', { status: 'COMPLETED', goalRevision, observedAtEpochMs: at, inventory: { items: [{ itemId: 'minecraft:oak_log', count: 10 }] } });
	const run = rows => {
		const window = resolveGoalWindow(rows);
		return { window, metrics: extractQualityMetrics({ scenario, profile, protocolRows: rows, startedAt: window.startedAt, endedAt: window.endedAt }) };
	};
	const start = row('goal_control', { operation: 'start', goalRevision: 1, updatedAtEpochMs: 100 });
	const result = row('goal_completion_result', { verified: true, goalRevision: 1, observedAtEpochMs: 200, updatedAtEpochMs: 200 });
	for (const controlAt of [201, 200]) {
		const control = row('goal_control', { operation: 'complete', goalRevision: 2, updatedAtEpochMs: controlAt });
		const { window, metrics } = run([start, result, control, logs(203, 2)]);
		assert.equal(window.goalCompleted, true);
		assert.ok(metrics.goalProgressMilestones.some(m => m.id === '10-logs'), `completion control at ${controlAt}`);
		assert.equal(metrics.firstProgress?.at, 203);
		// A stop or a new goal after the completion transition still closes the exception.
		for (const boundary of [row('goal_control', { operation: 'stop', goalRevision: 3, updatedAtEpochMs: 202 }), row('goal_control', { operation: 'start', goalRevision: 3, updatedAtEpochMs: 202 })]) {
			assert.equal(run([start, result, control, boundary, logs(203, 2)]).metrics.firstProgress, null, `${boundary.envelope.payload.operation} after completion at ${controlAt}`);
		}
		// A COMPLETED observation of an unrelated later revision does not belong to this completion.
		assert.equal(run([start, result, control, logs(203, 5)]).metrics.firstProgress, null);
	}
});
