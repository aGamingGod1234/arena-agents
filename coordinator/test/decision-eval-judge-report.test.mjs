import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createJudge, crossFamilyJudge, openCodeStreamError, parseJudgeCliResult, parseJudgeVerdicts, projectAnswer, projectSituation, entityLabels } from '../src/decision-eval/judge.mjs';
import { gradeSamples } from '../src/decision-eval/grade.mjs';
import { selectSpotChecks } from '../src/decision-eval/report.mjs';
import { main } from '../../scripts/decision-eval/compare.mjs';
import { CREEPER, synthCase } from './fixtures/decision-eval-synth.mjs';

const flee = { name: 'mcp__minecraft__act', args: { actionType: 'flee_from', arguments: { targetId: CREEPER, distance: 16, timeoutMs: 8000 } } };
const observe = { name: 'observe', args: {} };
const rubricCase = (id = 'creeper-near-01') => synthCase({ id, expect: { good: [{ normalized: { actionType: 'flee_from' } }], judge: { rubric: 'A creeper is 3 blocks away: getting distance first is good; mining on is bad.' }, threshold: 0.67 } });

test('the judge comes from the other model family', () => {
	assert.deepEqual(crossFamilyJudge('claude'), { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
	assert.deepEqual(crossFamilyJudge('codex'), { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
	assert.throws(() => crossFamilyJudge('claude', { provider: 'claude' }), /other model family/);
	// Free OpenCode players are judged by the other free model.
	assert.deepEqual(crossFamilyJudge('opencode', {}, 'opencode/deepseek-v4.1-flash-free'), { provider: 'opencode', model: 'opencode/glm-5.3-flash-free', effort: 'high' });
	assert.deepEqual(crossFamilyJudge('opencode', {}, 'opencode/glm-5.3-flash-free'), { provider: 'opencode', model: 'opencode/deepseek-v4.1-flash-free', effort: 'high' });
	assert.throws(() => crossFamilyJudge('opencode', { model: 'opencode/deepseek-v4.1-flash-free' }, 'opencode/deepseek-v4.1-flash-free'), /other model family/);
});

test('judge input is blind: entity ids become labels, no model identity, situation keeps the facts', () => {
	const c = rubricCase();
	c.state.agent.goal = 'collect logs (asked of claude-opus-5-5)';
	const { context, labels } = entityLabels(c);
	const situation = projectSituation(c, { context, labels });
	const answer = projectAnswer({ calls: [flee] }, labels);
	const text = JSON.stringify({ situation, answer });
	assert.ok(!text.includes(CREEPER));
	assert.ok(!/claude|opus/i.test(text));
	assert.equal(answer.calls[0].args.arguments.targetId, situation.recordedState.entities.find(e => e.type === 'minecraft:creeper').label);
	assert.equal(situation.recordedState.player.health, 14);
	assert.equal(projectAnswer({ calls: [] }, labels).note, 'made no accepted tool call');
});

test('judge sees the whole accepted program: long programs that differ only in their tail stay distinct', async () => {
	const { parseArenaScript } = await import('../src/arena-script/parser.mjs');
	const { canonicalCall } = await import('../src/decision-eval/predicates.mjs');
	const { labels } = entityLabels(rubricCase());
	// Parser-valid programs with the attention policy and supported awaited calls, sharing a long prefix.
	const prefix = `program.onUnhandledAttention("continue_and_notify");\n${Array.from({ length: 40 }, (_, i) => `await player.wait(${i + 1});`).join('\n')}\n`;
	const waitTail = 'await player.wait(1000);';
	const craftTail = 'await player.craftInventory({ recipeId: "minecraft:crafting_table", count: 1, timeoutMs: 5000 });';
	const program = tail => ({ name: 'runProgram', args: { source: `${prefix}${tail}` } });
	for (const tail of [waitTail, craftTail]) {
		parseArenaScript(`${prefix}${tail}`);
		assert.ok(!canonicalCall(program(tail)).normalizeError, 'production normalization accepts the program');
	}
	assert.ok(prefix.length > 600, 'the shared prefix is longer than the old 600-character cut');
	const [wait, craft] = [waitTail, craftTail].map(tail => projectAnswer({ calls: [program(tail)] }, labels));
	assert.notDeepEqual(wait, craft);
	assert.ok(wait.calls[0].args.source.endsWith(waitTail), 'tail and newlines survive the projection');
	assert.ok(craft.calls[0].args.source.endsWith(craftTail));
	// A valid control sequence whose only difference is after entry 16 stays distinct.
	const frame = (forward) => ({ forward, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: 0, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 1 });
	const sequence = last => ({ name: 'act', args: { actionType: 'control_sequence', arguments: { frames: Array.from({ length: 20 }, (_, i) => frame(i === 18 ? last : 1)), maxTicks: 40 } } });
	for (const last of [0, 1]) assert.ok(!canonicalCall(sequence(last)).normalizeError);
	assert.notDeepEqual(projectAnswer({ calls: [sequence(1)] }, labels), projectAnswer({ calls: [sequence(0)] }, labels));
	// Code is projected verbatim apart from provider names; it is not path- or control-character-rewritten.
	const pathy = projectAnswer({ calls: [{ name: 'runProgram', args: { source: 'let p = "/a/b/c";\nlet who = "claude";' } }] }, labels);
	assert.equal(pathy.calls[0].args.source, 'let p = "/a/b/c";\nlet who = "[redacted]";');
	const free = projectAnswer({ calls: [{ name: 'runProgram', args: { source: 'a="deepseek-v4.1"; b="glm-5.3"; c="opencode/x"' } }] }, labels);
	assert.equal(free.calls[0].args.source, 'a="[redacted]"; b="[redacted]"; c="[redacted]"');
});

test('verdict parsing rejects missing, unknown and repeated answers', () => {
	assert.equal(parseJudgeVerdicts('{"verdicts":[{"id":"A1","verdict":"good","rationale":"ok"}]}', ['A1']).get('A1').verdict, 'good');
	assert.throws(() => parseJudgeVerdicts('{"verdicts":[]}', ['A1']), /skipped/);
	assert.throws(() => parseJudgeVerdicts('{"verdicts":[{"id":"A9","verdict":"good","rationale":"x"}]}', ['A1']), /invalid/);
	assert.throws(() => parseJudgeVerdicts('not json', ['A1']), /malformed/);
	const claude = parseJudgeCliResult('claude', { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { verdicts: [] }, total_cost_usd: 0.012 }) }, 'claude-opus-5-5');
	assert.equal(claude.costUsd, 0.012);
	const codex = parseJudgeCliResult('codex', { stdout: [JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"verdicts":[]}' } })].join('\n') }, 'gpt-6.1-sol');
	assert.ok(codex.costUsd > 0);
	const step = (text) => [JSON.stringify({ type: 'step_start' }), JSON.stringify({ type: 'text', part: { text } }), JSON.stringify({ type: 'step_finish', part: { tokens: { input: 900, output: 80, reasoning: 20, cache: { read: 0 } }, cost: 0 } })];
	const opencode = parseJudgeCliResult('opencode', { stdout: step('{"verdicts":[]}').join('\n') }, 'opencode/glm-5.3-flash-free');
	assert.equal(opencode.text, '{"verdicts":[]}');
	assert.equal(opencode.costUsd, 0);
	assert.throws(() => parseJudgeCliResult('opencode', { stdout: JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429 } } }), exitCode: 1 }, 'opencode/glm-5.3-flash-free'),
		(error) => error.retryable === true && /RATE_LIMITED/.test(error.message));
	// `opencode run` retries silently, so the judge stops on OpenCode's logged stream error; the title model's error is ignored.
	const log = (small, error) => `timestamp=x level=ERROR message="stream error" providerID=opencode small=${small} agent=arena-judge error.error="${error}"`;
	assert.equal(openCodeStreamError(log(true, 'AI_APICallError: Insufficient account funds')), null);
	const exhausted = openCodeStreamError(log(false, 'AI_APICallError: Free usage limit reached. Subscribe to keep going'));
	assert.match(exhausted.message, /MODEL_UNAVAILABLE.*Free usage limit/);
	assert.equal(exhausted.retryable, undefined);
	assert.equal(openCodeStreamError(log(false, 'AI_APICallError: Rate limit exceeded')).retryable, true);
});

test('createJudge batches a case, shuffles answers, caches verdicts and keeps a spend ledger', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'de-judge-'));
	try {
		const prompts = [];
		const invoke = async ({ prompt, provider, model }) => {
			prompts.push({ prompt, provider, model });
			const answers = JSON.parse(prompt.slice(prompt.indexOf('ANSWERS_JSON') + 'ANSWERS_JSON'.length));
			return { text: JSON.stringify({ verdicts: answers.map(a => ({ id: a.id, verdict: a.calls.some(c => c.tool === 'moveTo') ? 'good' : 'bad', rationale: 'r' })) }), costUsd: 0.02 };
		};
		const c = rubricCase();
		const byId = new Map([[c.id, c]]);
		const samples = [
			{ caseId: c.id, sample: 0, provider: 'claude', calls: [{ name: 'moveTo', args: { x: -8, y: 64, z: 0 } }] },
			{ caseId: c.id, sample: 1, provider: 'claude', calls: [observe] },
			{ caseId: c.id, sample: 2, provider: 'claude', calls: [observe] },
		];
		const judge = createJudge({ playerProvider: 'claude', invoke, cacheFile: path.join(dir, 'cache.jsonl') });
		const { graded } = await gradeSamples(byId, samples, { judge });
		assert.deepEqual(graded.map(r => r.grade.verdict), ['judge_good', 'judge_bad', 'judge_bad']);
		assert.equal(prompts.length, 1);
		assert.equal(prompts[0].provider, 'codex');
		// Identical answers are judged once.
		assert.equal(JSON.parse(prompts[0].prompt.slice(prompts[0].prompt.indexOf('ANSWERS_JSON') + 12)).length, 2);
		assert.equal(judge.ledger.costUsd, 0.02);
		const again = createJudge({ playerProvider: 'claude', invoke, cacheFile: path.join(dir, 'cache.jsonl') });
		const second = await gradeSamples(byId, samples, { judge: again });
		assert.deepEqual(second.graded.map(r => r.grade.verdict), ['judge_good', 'judge_bad', 'judge_bad']);
		assert.equal(prompts.length, 1);
		assert.equal(again.ledger.cacheHits, 3);
		// A judge that keeps failing leaves the answers ungraded (not a player answer) instead of failing the run.
		const broken = createJudge({ playerProvider: 'claude', invoke: async () => ({ text: 'nope', costUsd: 0.01 }) });
		const third = await gradeSamples(new Map([[c.id, c]]), [{ caseId: c.id, sample: 9, calls: [{ name: 'moveTo', args: { x: 3, y: 64, z: 9 } }] }], { judge: broken });
		assert.equal(third.graded[0].grade.verdict, 'ungraded');
		assert.equal(third.graded[0].grade.source, 'judge-error');
		assert.equal(broken.ledger.calls, 2);
		assert.equal(broken.ledger.costUsd, 0.02);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('spot-check sampling prefers judged and non-good answers and spreads families', () => {
	const rows = [];
	for (let f = 0; f < 4; f++) for (let i = 0; i < 5; i++) {
		rows.push({ caseDef: { id: `f${f}-${i}`, family: `f${f}` }, sample: { sample: i }, grade: { verdict: i === 0 ? 'bad' : 'good', source: f === 0 && i === 1 ? 'judge' : 'predicate' } });
	}
	const picked = selectSpotChecks(rows, 6);
	assert.equal(picked.length, 6);
	assert.equal(picked[0].grade.source, 'judge');
	assert.ok(picked.some(r => r.grade.verdict === 'bad'));
	assert.ok(new Set(picked.map(r => r.caseDef.family)).size >= 3);
});

function sampleRow(caseId, sample, calls, extra = {}) {
	return { schemaVersion: 1, kind: 'decision-eval-sample', caseId, family: caseId.split('-').slice(0, 2).join('-'), sample, provider: 'claude', model: 'claude-opus-5-5',
		build: { commit: extra.commit ?? 'aaaaaaaa' }, rendered: { inputSha256: 'h', inputBytes: 10 }, calls: calls.map((c, index) => ({ index, normalized: null, ...c })),
		stop: 'script_end', error: null, usage: { inputTokens: 1000, outputTokens: 50, costUsd: 0.01 }, latency: { totalMs: 4000 + sample }, grade: null, ...extra };
}

test('compare CLI: paired PASS, family drop FAIL, report files and exit codes', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'de-compare-'));
	try {
		const cases = [];
		for (let f = 0; f < 3; f++) for (let i = 0; i < 6; i++) {
			const c = synthCase({ id: `fam${f}-c${i}`, family: `fam${f}`, causeClass: 'threat-close' });
			cases.push(c);
		}
		await writeFile(path.join(dir, 'cases.json'), JSON.stringify({ cases }));
		const run = (badFamily, commit) => ({ schemaVersion: 1, kind: 'decision-eval-run', summary: { wallMs: 60000, maxConcurrency: 16 },
			config: { sampleOffset: 0, sampleCounts: Object.fromEntries(cases.map((c) => [c.id, 3])) },
			results: cases.flatMap(c => [0, 1, 2].map(s => sampleRow(c.id, s, [c.family === badFamily ? { name: 'act', args: { actionType: 'attack', arguments: { targetId: CREEPER, timeoutMs: 500 } } } : flee], { commit }))) });
		await writeFile(path.join(dir, 'base.json'), JSON.stringify(run(null, 'bbbbbbbb')));
		await writeFile(path.join(dir, 'same.json'), JSON.stringify(run(null, 'cccccccc')));
		await writeFile(path.join(dir, 'worse.json'), JSON.stringify(run('fam1', 'dddddddd')));
		const quiet = process.stdout.write;
		process.stdout.write = () => true;
		let pass, fail, usage;
		try {
			pass = await main(['--cases', path.join(dir, 'cases.json'), '--candidate', path.join(dir, 'same.json'), '--baseline', path.join(dir, 'base.json'), '--out', path.join(dir, 'out-pass'), '--judge', 'off']);
			fail = await main(['--cases', path.join(dir, 'cases.json'), '--candidate', path.join(dir, 'worse.json'), '--baseline', path.join(dir, 'base.json'), '--out', path.join(dir, 'out-fail'), '--judge', 'off', '--spot-check', '4']);
			usage = await main(['--cases', path.join(dir, 'cases.json')]);
		} finally { process.stdout.write = quiet; }
		assert.equal(pass, 0);
		assert.equal(fail, 1);
		assert.equal(usage, 2);
		const report = JSON.parse(await readFile(path.join(dir, 'out-fail', 'report.json'), 'utf8'));
		assert.equal(report.verdict, 'FAIL');
		assert.equal(report.families[0].name, 'fam1');
		assert.equal(report.candidate.costUsd.toFixed(2), '0.54');
		const markdown = await readFile(path.join(dir, 'out-fail', 'report.md'), 'utf8');
		assert.match(markdown, /# Decision eval: FAIL/);
		assert.match(markdown, /\| fam1 \| 6 \(6\) \| 0% \| 100% \| -100\.0 \|/);
		const spot = await readFile(path.join(dir, 'out-fail', 'spot-check', 'spot-check.md'), 'utf8');
		assert.match(spot, /Context the model saw/);
		const graded = (await readFile(path.join(dir, 'out-fail', 'graded-samples.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		assert.equal(graded.length, 108);
		assert.ok(graded.every(row => ['good', 'bad', 'neutral', 'judge_good', 'judge_bad', 'error'].includes(row.grade.verdict)));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the judge spend cap is checked after a slot is acquired and counts calls in flight', async () => {
	const { createJudge } = await import('../src/decision-eval/judge.mjs');
	const { synthCase } = await import('./fixtures/decision-eval-synth.mjs');
	let started = 0;
	const release = [];
	const invoke = async ({ prompt }) => {
		started++;
		await new Promise((resolve) => release.push(resolve));
		const answers = JSON.parse(prompt.slice(prompt.indexOf('ANSWERS_JSON') + 'ANSWERS_JSON'.length));
		return { text: JSON.stringify({ verdicts: answers.map((a) => ({ id: a.id, verdict: 'good', rationale: 'ok' })) }), costUsd: 0.05 };
	};
	const judge = createJudge({ playerProvider: 'claude', invoke, concurrency: 8, maxSpendUsd: 0.12 });
	const cases = Array.from({ length: 6 }, (_, i) => synthCase({ id: `cap${i}`, expect: { judge: { rubric: `case ${i}` } } }));
	const pending = cases.map((c) => judge(c, [{ caseId: c.id, sample: 0, calls: [{ name: 'moveTo', args: { x: i(c), y: 64, z: 0 } }] }]).then(() => 'judged', (error) => error.message));
	function i(c) { return Number(c.id.slice(3)); }
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(started, 3, 'with 0.05 expected per call, only three calls fit under 0.12 even though eight slots were free');
	for (const resolve of release.splice(0)) resolve();
	const outcomes = await Promise.all(pending);
	assert.equal(outcomes.filter((o) => o === 'judged').length, 3);
	assert.ok(outcomes.filter((o) => o !== 'judged').every((o) => /spend cap/.test(o)));
	assert.ok(judge.ledger.costUsd <= 0.15 + 1e-9);
});

test('judge verdicts are keyed by case, accepted trajectory, rubric and judge model', async () => {
	const { judgeCacheKey, trajectoryHash } = await import('../src/decision-eval/judge.mjs');
	const { synthCase } = await import('./fixtures/decision-eval-synth.mjs');
	const caseDef = synthCase({ expect: { judge: { rubric: 'flee the creeper' } } });
	const config = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
	const move = { name: 'moveTo', args: { x: -8, y: 64, z: 0 } };
	const rejected = { name: 'act', args: { actionType: 'nonsense' }, normalizeError: 'unknown action type' };
	const key = (sample, c = caseDef, rubric = 'flee the creeper', cfg = config) => judgeCacheKey(cfg, c, rubric, sample);
	const base = key({ calls: [move], text: 'running away', sample: 0 });
	assert.equal(key({ calls: [rejected, move], text: 'different words', sample: 5 }), base, 'rejected calls, text and sample index do not change what was done');
	assert.notEqual(key({ calls: [{ name: 'moveTo', args: { x: 8, y: 64, z: 0 } }] }), base);
	assert.notEqual(key({ calls: [move] }, caseDef, 'another rubric'), base);
	assert.notEqual(key({ calls: [move] }, caseDef, 'flee the creeper', { ...config, model: 'other' }), base);
	assert.notEqual(key({ calls: [move] }, { ...caseDef, state: { ...caseDef.state, agent: { goal: 'changed' } } }), base, 'a changed case state is a new case');
	assert.equal(trajectoryHash({ calls: [] }), trajectoryHash({ calls: [rejected] }));
});

test('the judge sees the night clock, the bed and the ray target: a night bed and a day grass block give different prompts', async () => {
	const { buildJudgePrompt, entityLabels, judgeCacheKey, projectAnswer, projectSituation, JUDGE_PROJECTION_VERSION } = await import('../src/decision-eval/judge.mjs');
	const caseDef = JSON.parse(await readFile(new URL('./fixtures/decision-eval/train/plan-prerequisite-gap.json', import.meta.url), 'utf8')).cases.find((c) => c.id === 'plan-prerequisite-gap-04');
	// Review r3 audit row 34: the accepted answer replaces the running wait with using the bed at night.
	const sample = { calls: [{ name: 'replaceAction', args: { actionId: caseDef.state.observation.currentAction?.actionId ?? 'a', goalRevision: 1, actionType: 'interact_block', arguments: { x: 58, y: 72, z: 426, face: 'up', hand: 'main', expectedItemId: 'minecraft:air' } } }] };
	const prompt = (c) => { const view = entityLabels(c); return buildJudgePrompt({ rubric: c.expect.judge.rubric, situation: projectSituation(c, view), answers: [{ id: 'A1', ...projectAnswer(sample, view.labels, c) }] }); };
	const night = prompt(caseDef);
	const situation = projectSituation(caseDef);
	assert.equal(situation.recordedState.clock.phase, 'night');
	assert.equal(situation.recordedState.clock.tick, 12579);
	assert.ok(situation.recordedState.blocks.some((b) => b.blockId === 'minecraft:white_bed' && b.x === 58 && b.y === 72 && b.z === 426), 'the bed is in the judged blocks');
	assert.equal(situation.recordedState.currentAction.actionType, 'wait');
	assert.ok(situation.recordedState.heard.length > 0);
	assert.equal(situation.recordedState.player.armor, caseDef.state.observation.player.armor);
	assert.ok(situation.recordedState.rememberedDeaths.length > 0);
	assert.equal(situation.recordedState.inventory.items.length, Math.min(46, (caseDef.state.observation.observation ?? caseDef.state.observation).inventory.items.length), 'the whole slot-indexed inventory is judged');
	// The same answer by day with the beds and the ray target turned to grass must read differently.
	const day = structuredClone(caseDef);
	const payload = day.state.observation.observation ?? day.state.observation;
	payload.world.dayTime = 6000;
	for (const block of payload.blocks) if (block.blockId === 'minecraft:white_bed') block.blockId = 'minecraft:grass_block';
	payload.interaction.rayTarget = { ...payload.interaction.rayTarget, blockId: 'minecraft:grass_block' };
	assert.notEqual(prompt(day), night);
	assert.equal(projectSituation(day).recordedState.clock.phase, 'day');
	// Verdicts given on an older projection are never reused.
	assert.equal(JUDGE_PROJECTION_VERSION, 6);
	const config = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
	assert.notEqual(judgeCacheKey(config, caseDef, caseDef.expect.judge.rubric, sample), judgeCacheKey(config, day, caseDef.expect.judge.rubric, sample));
});

test('a multi-step answer shows the judge the recorded reply it actually received', async () => {
	const { projectAnswer } = await import('../src/decision-eval/judge.mjs');
	const caseDef = JSON.parse(await readFile(new URL('./fixtures/decision-eval/train/failed-interaction-retry.json', import.meta.url), 'utf8')).cases.find((c) => c.steps?.length);
	const recorded = caseDef.steps[0].canned[0];
	const answer = projectAnswer({ calls: [{ name: 'act', args: { actionType: recorded.recorded.command.actionType, arguments: recorded.recorded.command.arguments }, canned: { step: 0, choice: 0 } }] }, new Map(), caseDef);
	assert.equal(answer.calls[0].receivedRecordedReply.state, recorded.result.state);
	assert.equal(answer.calls[0].receivedRecordedReply.reasonCode, recorded.result.reasonCode);
});

test('the judge sees entity motion and parts, far landmarks and whether a listed section is complete (projection v3)', () => {
	const c = synthCase({ id: 'v3-projection' });
	const o = c.state.observation.envelope.payload;
	o.entities = [{ type: 'minecraft:eye_of_ender', uuid: '11111111-2222-4333-8444-555555555555', distance: 6, position: { x: o.position.x + 4, y: o.position.y + 4, z: o.position.z + 3 }, velocity: { x: 0.32, y: 0.1, z: 0.24 } }];
	o.landmarks = [{ blockId: 'minecraft:obsidian', x: Math.floor(o.position.x) + 40, y: 100, z: Math.floor(o.position.z), distance: 50 }];
	o.coverage = { sections: { entities: { returned: 1, complete: false }, blocks: { returned: 0, complete: true } } };
	const view = projectSituation(c).recordedState;
	assert.deepEqual(view.entities[0].velocity, { x: 0.3, y: 0.1, z: 0.2 });
	assert.equal(view.landmarks[0].blockId, 'minecraft:obsidian');
	assert.deepEqual(view.coverage, { entities: 'sampled', blocks: 'complete' });
});

test('judge retains visible bounds and does not call its truncated entity list complete', () => {
 const c = synthCase({ id: 'v4-projection' });
 const o = c.state.observation.envelope.payload;
 const bounds = { minX: 1, minY: 64, minZ: 2, maxX: 2, maxY: 65, maxZ: 3 };
 o.entities = Array.from({ length: 13 }, (_, i) => ({ type: 'minecraft:ender_dragon', uuid: `entity-${i}`, distance: i, bounds, partName: i === 0 ? 'head' : undefined }));
 o.coverage = { sections: { entities: { returned: 13, complete: true } } };
 const view = projectSituation(c).recordedState;
 assert.equal(view.entities.length, 12);
 assert.equal(view.coverage.entities, 'sampled');
 assert.deepEqual(view.entities[0].bounds, bounds);
 assert.equal(view.entities[0].partName, 'head');
});

test('a launched judge attempt with unknown cost keeps its reservation and stops further launches at the cap', async () => {
	const { createJudge, JudgeAttemptError } = await import('../src/decision-eval/judge.mjs');
	const { synthCase } = await import('./fixtures/decision-eval-synth.mjs');
	const cases = Array.from({ length: 3 }, (_, i) => synthCase({ id: `unknown${i}`, expect: { judge: { rubric: `case ${i}` } } }));
	const sample = (c, x) => [{ caseId: c.id, sample: 0, calls: [{ name: 'moveTo', args: { x, y: 64, z: 0 } }] }];
	const run = async (invoke) => {
		const judge = createJudge({ playerProvider: 'claude', invoke, concurrency: 1, maxSpendUsd: 0.05 });
		const outcomes = [];
		for (const [i, c] of cases.entries()) outcomes.push(await judge(c, sample(c, i)).then(() => 'judged', error => error.message));
		return { judge, outcomes };
	};
	// Launched and unmetered: the first attempt consumes the 0.05 reservation; no retry and no later case may launch.
	let launches = 0;
	const unmetered = await run(async () => { launches++; throw new JudgeAttemptError('provider failed', { costUsd: null }); });
	assert.equal(launches, 1);
	assert.equal(unmetered.judge.ledger.unknownCostCalls, 1);
	assert.equal(unmetered.judge.ledger.unknownCostReservedUsd, 0.05);
	assert.equal(unmetered.judge.ledger.costUsd, 0);
	// An unpriced success also keeps its reservation.
	launches = 0;
	const unpriced = await run(async ({ prompt }) => {
		launches++;
		const answers = JSON.parse(prompt.slice(prompt.indexOf('ANSWERS_JSON') + 'ANSWERS_JSON'.length));
		return { text: JSON.stringify({ verdicts: answers.map(a => ({ id: a.id, verdict: 'good', rationale: 'ok' })) }) };
	});
	assert.equal(launches, 1);
	assert.deepEqual(unpriced.outcomes.slice(0, 1), ['judged']);
	assert.ok(unpriced.outcomes.slice(1).every(o => /spend cap/.test(o)));
	// A known-free prelaunch failure (costUsd 0) reserves nothing: retries and later cases still run.
	launches = 0;
	const prelaunch = await run(async () => { launches++; throw new JudgeAttemptError('spawn ENOENT', { costUsd: 0 }); });
	assert.equal(launches, 6);
	assert.equal(prelaunch.judge.ledger.unknownCostReservedUsd, 0);
});

test('maintenance judge sees prior authored rule definitions, live state and firing failures', async () => {
 const { cases } = JSON.parse(await readFile(new URL('./fixtures/decision-eval/extra/rx-teach2.json', import.meta.url), 'utf8'));
 const c = cases.find(c => c.id === 'rx-adjust');
 const situation = projectSituation(c);
 const reflexes = situation.recordedState.reflexes;
 assert.equal(reflexes.authored[0].id, 'fortress-cover');
 assert.equal(reflexes.authored[0].do.type, 'shield');
 assert.equal(reflexes.status.rules[0].state, 'disabled');
 assert.equal(reflexes.status.events[0].detail, 'no shield equipped');
 const replacement = projectAnswer({ calls: [{ name: 'runProgram', args: { reflexes: [{ ...c.state.agent.reflexes[0], do: { type: 'take_cover', within: 6 } }] } }] }, entityLabels(c).labels);
 assert.equal(replacement.calls[0].args.reflexes[0].id, reflexes.authored[0].id);
 assert.equal(replacement.calls[0].args.reflexes[0].do.type, 'take_cover');
});
