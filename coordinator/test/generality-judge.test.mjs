import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildJudgePrompt, JUDGE_DIMENSIONS, JUDGE_MAX_OUTPUT_BYTES, JUDGE_MAX_TIMELINE_ROWS, JUDGE_OUTPUT_SCHEMA, JudgeAttemptError, invokeJudgeCli, judgeAgreement, judgeTimeline, parseJudgeResponse, parseJudgeCliResult, projectJudgeInput } from '../src/benchmark/generality-judge.mjs';

const timeline = [
	{ elapsedMs: 0, tool: 'survey', argsSummary: { radius: 16 }, resultCode: 'OK', health: 20, dimension: 'minecraft:overworld', position: { x: 1, y: 64, z: 2 } },
	{ elapsedMs: 10_000, tool: 'mine', argsSummary: 'target=minecraft:oak_log', resultCode: 'OK', health: 20 },
	{ elapsedMs: 20_000, tool: 'craft', argsSummary: 'item=minecraft:crafting_table', resultCode: 'OK', health: 20 },
];
const response = (overrides = {}) => JSON.stringify({ scores: Object.fromEntries(JUDGE_DIMENSIONS.map(key => [key, {
	score: Object.hasOwn(overrides, key) ? overrides[key] : 4, citationsMs: [10_000, 20_000], rationale: 'Gathered wood and crafted a useful station.',
}])) });

test('fake judge runs twice with independent opposite evidence order and reports agreement', async () => {
	const calls = [];
	const result = await judgeTimeline({ goal: 'Build a shelter.', timeline, invoke: async request => {
		calls.push(request);
		return { text: response(request.round === 2 ? { safety: 3, efficiency: 2 } : {}), usage: { input_tokens: 20, output_tokens: 10 }, costUsd: 0.01 };
	} });
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map(call => call.round), [1, 2]);
	assert.notEqual(calls[0].prompt, calls[1].prompt);
	const data = prompt => JSON.parse(prompt.split('TIMELINE_DATA_BEGIN\n')[1].split('\nTIMELINE_DATA_END')[0]);
	assert.deepEqual(data(calls[0].prompt).timeline, [...data(calls[1].prompt).timeline].reverse());
	assert.equal(data(calls[0].prompt).evidenceOrder, 'ascending-time');
	assert.equal(data(calls[1].prompt).evidenceOrder, 'descending-time');
	assert.equal(calls[0].provider, 'claude');
	assert.equal(calls[0].model, 'claude-opus-5-5');
	assert.equal(calls[0].effort, 'medium');
	assert.equal(result.agreement.exactFraction, 0.6);
	assert.equal(result.agreement.meanAbsoluteDifference, 0.6);
	assert.deepEqual(result.agreement.dimensions.efficiency, { scores: [4, 2], absoluteDifference: 2, exact: false, comparable: true });
	assert.equal(result.agreement.coverage.fraction, 1);
	assert.equal(result.judgments[0].costUsd, 0.01);
	assert.equal(result.costUsd, 0.02);
	assert.equal(result.unknownSpend, false);
	assert.deepEqual(result.input, { timelineRows: 3, omittedRows: 0 });
});

test('projection never passes model inputs, identity keys or nested metadata to the judge', async () => {
	let sent;
	const row = { ...timeline[0], arm: 'A', profile: { model: 'secret-model' }, modelInput: 'NEVER SEND THIS', payload: { observation: 'NEVER SEND THAT' },
		argsSummary: { item: 'minecraft:oak_log', profile: 'secret-profile', modelInput: 'secret-input', nested: { commit: 'secret-commit', destination: { x: 2, y: 65, z: 4 } } },
		position: { x: 1, y: 64, z: 2, arm: 'B' },
	};
	await judgeTimeline({ goal: 'Build a shelter. arm=B; model=gpt-6.1-sol; commit=f32ba2c9', timeline: [row, ...timeline.slice(1)],
		invoke: async request => { sent = request.prompt; return response(); } });
	for (const secret of ['NEVER SEND', 'secret-profile', 'secret-input', 'secret-commit', 'f32ba2c9', 'gpt-6.1-sol', 'arm=B', 'secret-model']) assert.ok(!sent.includes(secret), secret);
	assert.match(sent, /minecraft:oak_log/);
	assert.match(sent, /destination/);
	const projected = projectJudgeInput({ goal: 'Build a shelter.', timeline: [row] });
	assert.deepEqual(Object.keys(projected.timeline[0]), ['elapsedMs', 'kind', 'tool', 'argsSummary', 'resultCode', 'health', 'position', 'dimension']);
	assert.deepEqual(projected.timeline[0].position, { x: 1, y: 64, z: 2 });
});

test('structured JSON summaries and identity-bearing free text are sanitized', () => {
	const projected = projectJudgeInput({ goal: 'Gather wood.', timeline: [
		{ ...timeline[0], argsSummary: '{"item":"minecraft:oak_log","arm":"B","prompt":"hidden","nested":{"provider":"secret","count":3}}' },
		{ ...timeline[1], argsSummary: 'arm A claude/q2-stack f32ba2c9 codex gpt-6.1-sol C:\\private\\trace.json mine oak' },
	] });
	const prompt = buildJudgePrompt(projected);
	for (const secret of ['hidden', 'q2-stack', 'f32ba2c9', 'gpt-6.1-sol', 'private', 'secret']) assert.ok(!prompt.includes(secret), secret);
	assert.match(prompt, /minecraft:oak_log/);
	assert.match(prompt, /mine oak/);
});

test('truncated JSON arguments cannot leak identity or model inputs while decision text survives', () => {
	const broken = '{"profile":"SECRET_ARM_B","modelInput":"SECRET_MODEL_INPUT_'.padEnd(220, 'x');
	const projected = projectJudgeInput({ goal: 'Gather wood.', timeline: [
		{ ...timeline[0], argsSummary: broken },
		{ ...timeline[1], tool: 'say', argsSummary: 'Mining failed, so I will select the stone pickaxe and try again.' },
		{ ...timeline[2], argsSummary: '  [{"item":"oak_log","prompt":"secret' },
	] });
	assert.equal(projected.timeline[0].argsSummary, '[truncated action arguments]');
	assert.equal(projected.timeline[2].argsSummary, '[truncated action arguments]');
	const prompt = buildJudgePrompt(projected);
	assert.ok(!prompt.includes('SECRET_ARM_B'));
	assert.ok(!prompt.includes('SECRET_MODEL_INPUT'));
	assert.match(prompt, /Mining failed, so I will select the stone pickaxe and try again/);
});

test('codex provider, model, effort and executable are configurable', async () => {
	const calls = [];
	await judgeTimeline({ goal: 'Gather wood.', timeline, provider: 'codex', effort: 'low', executable: 'custom-codex.exe', timeoutMs: 9000,
		invoke: async request => { calls.push(request); return response(); } });
	assert.equal(calls[0].model, 'gpt-6.1-sol');
	assert.equal(calls[0].executable, 'custom-codex.exe');
	assert.equal(calls[0].timeoutMs, 9000);
});

test('arm family selects a different default judge family without exposing metadata', async () => {
	for (const [armProvider, provider, model] of [['claude', 'codex', 'gpt-6.1-sol'], ['codex', 'claude', 'claude-opus-5-5']]) {
		const calls = [];
		await judgeTimeline({ goal: 'Gather wood.', timeline, armProvider, invoke: async request => { calls.push(request); return response(); } });
		assert.equal(calls[0].provider, provider);
		assert.equal(calls[0].model, model);
		assert.equal(calls[0].effort, 'medium');
		assert.ok(!Object.hasOwn(calls[0], 'armProvider'));
		assert.ok(!calls[0].prompt.includes('armProvider'));
		assert.ok(!calls[0].prompt.includes(armProvider));
	}
	let selected;
	await judgeTimeline({ goal: 'Gather wood.', timeline, armProvider: 'claude', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', invoke: async request => { selected = request; return response(); } });
	assert.equal(selected.provider, 'claude');
	assert.equal(selected.model, 'claude-sonnet-5-5');
	assert.equal(selected.effort, 'high');
});

test('bare model-family names are redacted in goals, arguments and start facts', () => {
	const input = projectJudgeInput({ goal: 'Opus Sonnet Sol/Luna/Fable/Haiku gathers wood.', timeline: [
		{ ...timeline[0], argsSummary: { note: 'opus SONNET sol luna fable haiku', armProvider: 'secret-family' } },
	] });
	const prompt = buildJudgePrompt(input);
	for (const name of ['opus', 'sonnet', 'sol', 'luna', 'fable', 'haiku', 'armProvider', 'secret-family']) assert.ok(!new RegExp(`\\b${name}\\b`, 'i').test(prompt), name);
});

test('start facts and completion checks survive projection, outcome rows do not', () => {
	const startingFacts = { health: 6, foodLevel: 7, saturation: 0, onFire: false, air: 300, effects: [], gear: {}, inventory: [{ item: 'minecraft:bread', count: 2 }], position: { x: 1, y: 64, z: 2 }, dimension: 'minecraft:overworld', biome: 'minecraft:plains', time: 18_000, weather: 'thunder', threats: [{ type: 'minecraft:zombie', distance: 8 }] };
	const rows = [
		{ elapsedMs: 0, kind: 'start', tool: 'start_situation', argsSummary: startingFacts },
		...timeline.slice(1),
		{ elapsedMs: 26_000, kind: 'completion-claim', tool: 'completion_claim', argsSummary: 'I have enough logs.' },
		{ elapsedMs: 27_000, kind: 'completion-verdict', tool: 'completion_verdict', resultCode: 'PREDICATE_FAILED' },
		{ elapsedMs: 28_000, tool: 'objective_evidence', argsSummary: 'Independent goal predicate met.' },
		{ elapsedMs: 30_000, tool: 'window_end', argsSummary: 'GOAL_COMPLETED' },
	];
	const input = projectJudgeInput({ goal: 'Gather wood.', timeline: rows });
	assert.equal(input.timeline.length, 5);
	assert.match(input.timeline[0].argsSummary, /foodLevel/);
	assert.match(input.timeline[0].argsSummary, /minecraft:zombie/);
	assert.match(input.timeline[0].argsSummary, /thunder/);
	assert.match(buildJudgePrompt(input), /PREDICATE_FAILED/);
	assert.ok(!buildJudgePrompt(input).includes('Independent goal predicate met'));
	assert.ok(!buildJudgePrompt(input).includes('GOAL_COMPLETED'));
});

test('numeric scores require a cited action row rather than synthetic or completion rows alone', () => {
	const rows = [
		{ elapsedMs: 0, kind: 'start', tool: 'start_situation' },
		{ elapsedMs: 10_000, kind: 'action', tool: 'mine' },
		{ elapsedMs: 20_000, kind: 'completion-verdict', tool: 'completion_verdict' },
	];
	const value = JSON.parse(response());
	for (const score of Object.values(value.scores)) score.citationsMs = [0, 20_000];
	assert.throws(() => parseJudgeResponse(value, rows), /must cite an action row/);
	for (const score of Object.values(value.scores)) score.citationsMs.push(10_000);
	assert.equal(parseJudgeResponse(value, rows).scores.safety.score, 4);
	assert.equal(projectJudgeInput({ goal: 'Survive.', timeline: [rows[0], rows[2]] }).timeline.length, 2);
});

test('unexercised recovery is explicitly null and excluded from agreement with coverage', async () => {
	const noRecovery = () => { const value = JSON.parse(response()); value.scores.recovery = { score: null, citationsMs: [], rationale: 'not-exercised: no setback in the available evidence' }; return JSON.stringify(value); };
	const result = await judgeTimeline({ goal: 'Gather wood.', timeline, invoke: async () => noRecovery() });
	assert.equal(result.judgments[0].scores.recovery.score, null);
	assert.equal(result.agreement.exactFraction, 1);
	assert.equal(result.agreement.dimensions.recovery.exact, null);
	assert.deepEqual(result.agreement.coverage, { comparedDimensions: 4, totalDimensions: 5, fraction: 0.8, exercisedByPass: [4, 4] });
	const mixed = judgeAgreement([parseJudgeResponse(noRecovery(), timeline), parseJudgeResponse(response(), timeline)]);
	assert.equal(mixed.coverage.comparedDimensions, 4);
	assert.deepEqual(mixed.coverage.exercisedByPass, [4, 5]);
	const bad = JSON.parse(noRecovery());
	bad.scores.recovery.rationale = 'No setback or recovery attempt is evidenced.';
	assert.equal(parseJudgeResponse(bad, timeline).scores.recovery.score, null);
	bad.scores.recovery.rationale = 'not-exercised: none'; bad.scores.recovery.citationsMs = [10_000];
	assert.throws(() => parseJudgeResponse(bad, timeline), /invalid unavailable recovery/);
	bad.scores.safety.score = null;
	assert.throws(() => parseJudgeResponse(bad, timeline), /invalid safety/);
});

test('malformed paid JSON is retried once, retains both costs, and never fabricates a score', async () => {
	let count = 0;
	const result = await judgeTimeline({ goal: 'Gather wood.', timeline, invoke: async () => { count++; return { text: '```json\n{"scores":', usage: { input_tokens: 20, output_tokens: 10 }, costUsd: .01 }; } });
	assert.match(result.error, /malformed JSON/);
	assert.equal(count, 2);
	assert.equal(result.costUsd, .02);
	assert.equal(result.unknownSpend, false);
	assert.deepEqual(result.judgments, []);
	assert.equal(result.agreement, null);
	assert.deepEqual(result.attempts.map(row => [row.round, row.attempt, row.status]), [[1, 1, 'failed'], [1, 2, 'failed']]);
});

test('unknown or missing timestamp citations and out-of-range scores fail validation', () => {
	const edit = update => { const value = JSON.parse(response()); update(value.scores.safety); return JSON.stringify(value); };
	assert.throws(() => parseJudgeResponse(edit(item => { item.citationsMs = [999]; }), timeline), /unknown timestamps/);
	assert.throws(() => parseJudgeResponse(edit(item => { item.citationsMs = []; }), timeline), /invalid safety/);
	assert.throws(() => parseJudgeResponse(edit(item => { item.citationsMs = ['10000']; }), timeline), /unknown timestamps/);
	assert.throws(() => parseJudgeResponse(edit(item => { item.citationsMs = [10_000, 10_000]; }), timeline), /invalid safety/);
	assert.throws(() => parseJudgeResponse(edit(item => { item.score = 6; }), timeline), /invalid safety/);
	assert.throws(() => parseJudgeResponse(edit(item => { item.score = 2.5; }), timeline), /invalid safety/);
	assert.throws(() => parseJudgeResponse(edit(item => { item.rationale = ''; }), timeline), /invalid safety/);
});

test('unknown keys, missing dimensions and oversized output are rejected', () => {
	const value = JSON.parse(response());
	value.scores.arm = { score: 4, citationsMs: [0], rationale: 'metadata' };
	assert.throws(() => parseJudgeResponse(JSON.stringify(value), timeline), /invalid scores object/);
	delete value.scores.arm;
	delete value.scores.recovery;
	assert.throws(() => parseJudgeResponse(JSON.stringify(value), timeline), /invalid scores object/);
	assert.throws(() => parseJudgeResponse(' '.repeat(JUDGE_MAX_OUTPUT_BYTES + 1), timeline), /bounded size/);
});

test('large timelines are uniformly compacted with endpoints, and omitted citations are rejected', () => {
	const long = Array.from({ length: 1000 }, (_, elapsedMs) => ({ ...timeline[0], elapsedMs }));
	const projected = projectJudgeInput({ goal: 'Gather wood.', timeline: long });
	assert.equal(projected.timeline.length, JUDGE_MAX_TIMELINE_ROWS);
	assert.equal(projected.omittedRows, 1000 - JUDGE_MAX_TIMELINE_ROWS);
	assert.equal(projected.timeline[0].elapsedMs, 0);
	assert.equal(projected.timeline.at(-1).elapsedMs, 999);
	assert.equal(new Set(projected.timeline.map(row => row.elapsedMs)).size, JUDGE_MAX_TIMELINE_ROWS);
	const answer = JSON.parse(response());
	for (const item of Object.values(answer.scores)) item.citationsMs = [1];
	assert.throws(() => parseJudgeResponse(answer, projected.timeline), /unknown timestamps/);
});

test('compaction retains start facts and at least one action when most rows are synthetic events', () => {
	const rows = Array.from({ length: 1000 }, (_, elapsedMs) => ({ elapsedMs, kind: 'event', tool: 'death' }));
	rows[1] = { elapsedMs: 1, kind: 'start', tool: 'start_situation', argsSummary: { health: 6 } };
	rows[2] = { elapsedMs: 2, kind: 'action', tool: 'eat' };
	const input = projectJudgeInput({ goal: 'Heal.', timeline: rows });
	assert.equal(input.timeline.length, JUDGE_MAX_TIMELINE_ROWS);
	assert.ok(input.timeline.some(row => row.kind === 'action' && row.elapsedMs === 2));
	assert.ok(input.timeline.some(row => row.kind === 'start' && row.elapsedMs === 1));
});

test('zero-action traces have unknown scores, zero coverage and no paid invocations', async () => {
	const invoke = async () => assert.fail('must not invoke');
	for (const rows of [[], [{ elapsedMs: 0, kind: 'start', tool: 'start_situation', argsSummary: { health: 20 } }]]) {
		const result = await judgeTimeline({ goal: 'Gather wood.', timeline: rows, invoke });
		assert.equal(result.status, 'NO_ACTIONS');
		assert.equal(result.costUsd, 0);
		assert.equal(result.unknownSpend, false);
		assert.deepEqual(result.attempts, []);
		assert.equal(result.agreement.coverage.fraction, 0);
		assert.equal(result.agreement.exactFraction, null);
		for (const judgment of result.judgments) {
			assert.ok(Object.values(judgment.scores).every(row => row.score === null && row.citationsMs.length === 0));
			assert.deepEqual(parseJudgeResponse({ scores: judgment.scores }, rows).scores, judgment.scores);
		}
	}
	assert.throws(() => parseJudgeResponse(response(), []), /unknown timestamps/);
});

test('invalid configuration fails before invoking a provider', async () => {
	const invoke = async () => assert.fail('must not invoke');
	await assert.rejects(judgeTimeline({ goal: 'Gather wood.', timeline: null, invoke }), /array/);
	await assert.rejects(judgeTimeline({ goal: 'Gather wood.', timeline, provider: 'unknown', invoke }), /provider/);
	await assert.rejects(judgeTimeline({ goal: 'Gather wood.', timeline, timeoutMs: 0, invoke }), /timeoutMs/);
	await assert.rejects(judgeTimeline({ goal: 'Gather wood.', timeline: [{ elapsedMs: NaN }], invoke }), /elapsedMs/);
});

test('API schema is nullable and Codex compatible, parser still requires unique citations', () => {
	assert.ok(!JSON.stringify(JUDGE_OUTPUT_SCHEMA).includes('uniqueItems'));
	for (const key of JUDGE_DIMENSIONS) assert.deepEqual(JUDGE_OUTPUT_SCHEMA.properties.scores.properties[key].properties.score.type, ['integer', 'null']);
	const bad = JSON.parse(response());
	bad.scores.efficiency.citationsMs = [10_000, 10_000];
	assert.throws(() => parseJudgeResponse(bad, timeline), /invalid efficiency/);
});

test('starting facts retain numeric precision and drop item entities and inventory metadata', () => {
	const input = projectJudgeInput({ goal: 'Escape fire.', timeline: [{ elapsedMs: 0, kind: 'start', tool: 'starting_situation', argsSummary: {
		health: 20, foodLevel: 20, position: { x: .123456789, y: 64, z: 22.987654321 }, onFire: true,
		inventory: [{ itemId: 'minecraft:water_bucket', count: 1, slot: 0, nbt: 'SECRET_ITEM_METADATA', displayName: 'Opus', stackId: 'f32ba2c9' }],
		threats: [{ type: 'minecraft:item', distance: 0, item: 'minecraft:steak' }, { type: 'item', distance: 0 }, { type: 'minecraft:skeleton', distance: 6.123456789 }],
		worldFingerprint: 'SECRET_WORLD_FINGERPRINT', model: 'Opus',
	} }] });
	const raw = input.timeline[0].argsSummary;
	const facts = JSON.parse(raw);
	assert.equal(facts.position.x, .123456789);
	assert.equal(facts.position.z, 22.987654321);
	assert.deepEqual(facts.inventory, [{ itemId: 'minecraft:water_bucket', count: 1 }]);
	assert.deepEqual(facts.threats, [{ type: 'minecraft:skeleton', distance: 6.1 }]);
	assert.equal(facts.onFire, true);
	assert.ok(raw.length <= 1100);
	assert.ok(!raw.includes('SECRET'));
	assert.ok(!raw.includes('minecraft:steak'));
});

test('one retry succeeds and all failed and successful attempt costs are counted for both providers', async () => {
	for (const provider of ['claude', 'codex']) {
		const calls = [];
		const result = await judgeTimeline({ goal: 'Gather wood.', timeline, provider, invoke: async request => {
			calls.push([request.round, request.attempt]);
			if (request.round === 1 && request.attempt === 1) throw new JudgeAttemptError('temporary failed call', { usage: { input_tokens: 2, output_tokens: 1 }, costUsd: .01 });
			return { text: response(), usage: { input_tokens: 20, output_tokens: 10 }, costUsd: .02 };
		} });
		assert.deepEqual(calls, [[1, 1], [1, 2], [2, 1]]);
		assert.equal(result.judgments.length, 2);
		assert.equal(result.attempts.length, 3);
		assert.equal(result.costUsd, .05);
		assert.equal(result.unknownSpend, false);
		assert.equal(result.agreement.exactFraction, 1);
		assert.ok(!Object.hasOwn(result, 'error'));
		assert.deepEqual(result.attempts[0].usage, { input_tokens: 2, output_tokens: 1 });
	}
});

test('a failed second pass retains the first judgment and charges all attempts', async () => {
	const result = await judgeTimeline({ goal: 'Gather wood.', timeline, invoke: async request => ({ text: request.round === 1 ? response() : '{}', costUsd: .01 }) });
	assert.equal(result.judgments.length, 1);
	assert.equal(result.attempts.length, 3);
	assert.equal(result.costUsd, .03);
	assert.equal(result.agreement, null);
	assert.match(result.error, /scores object/);
});

test('known request rejection costs zero, while transport failures with no metering are unknown', async () => {
	for (const provider of ['claude', 'codex']) {
		const model = provider === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol';
		const stdout = provider === 'codex' ? JSON.stringify({ type: 'turn.failed', error: { message: 'unexpected status 400 Bad Request' } })
			: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: 400 invalid schema'] });
		const result = await judgeTimeline({ goal: 'Gather wood.', timeline, provider, invoke: async () => parseJudgeCliResult(provider, { stdout, exitCode: 1 }, model) });
		assert.equal(result.costUsd, 0);
		assert.equal(result.unknownSpend, false);
		assert.equal(result.attempts.length, 2);
		assert.ok(result.attempts.every(row => row.usage.input_tokens === 0 && row.usage.output_tokens === 0));
		assert.match(result.error, /HTTP 400/);
	}
	const unknown = await judgeTimeline({ goal: 'Gather wood.', timeline, invoke: async () => { throw new Error('connection timed out after sending request'); } });
	assert.equal(unknown.costUsd, null);
	assert.equal(unknown.unknownSpend, true);
	assert.equal(unknown.attempts.length, 2);
});

test('failed CLI output preserves usage before and after errors for both providers', () => {
	const usage = { input_tokens: 200, output_tokens: 20 };
	assert.throws(() => parseJudgeCliResult('claude', { stdout: JSON.stringify({ type: 'result', is_error: true, subtype: 'error', usage, total_cost_usd: .015 }), stderr: 'HTTP 400', exitCode: 1 }, 'claude-opus-5-5'), error => {
		assert.ok(error instanceof JudgeAttemptError);
		assert.equal(error.costUsd, .015);
		assert.deepEqual(error.usage, usage);
		return true;
	});
	for (const rows of [
		[{ type: 'turn.completed', usage }, { type: 'error', message: 'HTTP 400' }],
		[{ type: 'error', message: 'HTTP 400' }, { type: 'turn.completed', usage }],
		[{ type: 'turn.failed', usage, error: { message: 'HTTP 400' } }],
	]) assert.throws(() => parseJudgeCliResult('codex', { stdout: rows.map(row => JSON.stringify(row)).join('\n'), exitCode: 1 }, 'gpt-6.1-sol'), error => {
		assert.ok(error instanceof JudgeAttemptError);
		assert.deepEqual(error.usage, usage);
		assert.equal(error.costUsd, .0012);
		return true;
	});
});

test('CLI success parser handles structured Claude output and Codex final text with cached tokens', () => {
	const claude = parseJudgeCliResult('claude', { stdout: JSON.stringify({ type: 'result', subtype: 'success', structured_output: JSON.parse(response()), usage: { input_tokens: 10, output_tokens: 10 }, total_cost_usd: .003 }) }, 'claude-opus-5-5');
	assert.equal(parseJudgeResponse(claude.text, timeline).scores.safety.score, 4);
	assert.equal(claude.costUsd, .003);
	const codex = parseJudgeCliResult('codex', { stdout: [
		{ type: 'item.completed', item: { type: 'agent_message', text: response() } },
		{ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } },
	].map(row => JSON.stringify(row)).join('\n') }, 'gpt-6.1-sol');
	assert.equal(parseJudgeResponse(codex.text, timeline).scores.safety.score, 4);
	assert.equal(codex.costUsd, .00041);
});

test('local launch failure is known zero; malformed transport and timeout retain any metering', () => {
	assert.throws(() => parseJudgeCliResult('codex', { processError: Object.assign(new Error('not found'), { code: 'ENOENT' }) }, 'gpt-6.1-sol'), error => error.costUsd === 0);
	const usage = { input_tokens: 100, output_tokens: 10 };
	assert.throws(() => parseJudgeCliResult('codex', { stdout: `broken\n${JSON.stringify({ type: 'turn.completed', usage })}`, processError: new Error('timeout') }, 'gpt-6.1-sol'), error => {
		assert.deepEqual(error.usage, usage);
		assert.equal(error.costUsd, .0006);
		return true;
	});
	assert.throws(() => parseJudgeCliResult('claude', { stdout: '{broken', exitCode: 1 }, 'claude-opus-5-5'), error => error.costUsd === null);
});

test('Windows fake npm CLIs exercise subprocess output and nonzero exit metering without paid calls', { skip: process.platform !== 'win32' }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'arena-fake-judge-test-'));
	try {
		for (const provider of ['claude', 'codex']) {
			const entry = path.join(root, 'node_modules', ...(provider === 'claude' ? ['@anthropic-ai', 'claude-code', 'cli.js'] : ['@openai', 'codex', 'bin', 'codex.js']));
			await mkdir(path.dirname(entry), { recursive: true });
			await writeFile(path.join(root, `${provider}.cmd`), '@exit /b 1');
			const body = provider === 'claude' ? JSON.stringify({ type: 'result', subtype: 'success', structured_output: JSON.parse(response()), usage: { input_tokens: 20, output_tokens: 10 }, total_cost_usd: .01 })
				: [{ type: 'item.completed', item: { type: 'agent_message', text: response() } }, { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } }].map(row => JSON.stringify(row)).join('\n');
			await writeFile(entry, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(body)});});`);
			const request = { provider, model: provider === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol', effort: 'medium', executable: path.join(root, `${provider}.cmd`), timeoutMs: 5000, prompt: 'Fake transport check' };
			const success = await invokeJudgeCli(request);
			assert.equal(parseJudgeResponse(success.text, timeline).scores.safety.score, 4);
			assert.equal(success.usage.input_tokens, 20);
			assert.ok(success.costUsd > 0);
			const failed = provider === 'claude' ? JSON.stringify({ type: 'result', subtype: 'error', is_error: true, usage: { input_tokens: 20, output_tokens: 10 }, total_cost_usd: .01 })
				: JSON.stringify({ type: 'turn.failed', usage: { input_tokens: 20, output_tokens: 10 } });
			await writeFile(entry, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(failed)});process.stderr.write('HTTP 400 rejected');process.exitCode=1;});`);
			await assert.rejects(invokeJudgeCli(request), error => {
				assert.ok(error instanceof JudgeAttemptError);
				assert.equal(error.httpStatus, 400);
				assert.equal(error.usage.output_tokens, 10);
				assert.ok(error.costUsd > 0);
				return true;
			});
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('missing explicit executables fail locally without falling back to a paid provider', async () => {
	for (const provider of ['claude', 'codex']) await assert.rejects(invokeJudgeCli({ provider, model: 'unused', effort: 'medium', executable: path.join(os.tmpdir(), 'arena-judge-guaranteed-missing', `${provider}.cmd`), timeoutMs: 100, prompt: 'must not launch' }), error => {
		assert.match(error.message, /executable does not exist/);
		assert.equal(error.costUsd, 0);
		return true;
	});
});
