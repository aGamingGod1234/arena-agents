import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { loadCases, verifyProvenance } from '../../scripts/decision-eval/verify-provenance.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'decision-eval');
const trainDir = path.join(fixtures, 'train');
const files = fs.readdirSync(trainDir).filter((name) => name.endsWith('.json')).sort();
const fileCases = files.map((name) => ({ name, parsed: JSON.parse(fs.readFileSync(path.join(trainDir, name), 'utf8')) }));
const cases = fileCases.flatMap(({ parsed }) => parsed.cases);
const families = new Map();
for (const testCase of cases) families.set(testCase.family, [...(families.get(testCase.family) ?? []), testCase]);

test('every train case file validates against the shared schema', () => {
	for (const { name, parsed } of fileCases) {
		validateCaseFile(parsed, name);
		assert.equal(`${parsed.family}.json`, name, 'one family per file');
		assert.ok(parsed.cases.every((c) => c.family === parsed.family && c.causeClass === parsed.causeClass));
		assert.ok(typeof parsed.rationale === 'string' && parsed.rationale.length > 40, `${name} has a player-sense rationale`);
	}
	validateCaseFile(cases, 'all train cases'); // ids unique across files
	assert.ok(cases.every((c) => c.split === 'train'));
	assert.ok(cases.every((c) => typeof c.rationale === 'string' && c.rationale.length > 40));
});

test('the corpus spans at least 12 cause-class families with variants each', () => {
	assert.ok(families.size >= 12, `${families.size} families`);
	for (const [family, members] of families) assert.ok(members.length >= 4 && members.length <= 16, `${family}: ${members.length} cases`);
	assert.ok(cases.length >= 120 && cases.length <= 280, `${cases.length} train cases`);
	// Families vary the situation, not one copied moment.
	for (const [family, members] of families) assert.equal(new Set(members.map((c) => c.source.observationSha256)).size, members.length, `${family} repeats an observation`);
});

test('every case records provenance; real cases keep the recorded observation unchanged', () => {
	for (const c of cases) {
		const s = c.source;
		assert.ok(typeof s.trace === 'string' && s.trace.length > 0, `${c.id} trace`);
		assert.ok(Number.isSafeInteger(s.line) && s.line > 0, `${c.id} line`);
		assert.ok(Number.isFinite(s.atMs), `${c.id} atMs`);
		assert.match(s.observationSha256, /^[0-9a-f]{64}$/);
		assert.equal(observationSha256(c.state.observation), s.observationSha256, `${c.id} observation hash`);
		assert.equal('goalRevision' in c.state.observation, false, `${c.id} observation is goal-revision independent`);
		if (s.derived) {
			assert.ok(['observation', 'agent'].includes(s.derived.scope), `${c.id} derived scope`);
			assert.ok(Array.isArray(s.derived.edits) && s.derived.edits.length > 0 && s.derived.edits.every((e) => typeof e === 'string' && e.length > 10), `${c.id} describes its edit`);
			assert.match(s.derived.from.observationSha256, /^[0-9a-f]{64}$/);
			if (s.derived.scope === 'observation') assert.notEqual(s.derived.from.observationSha256, s.observationSha256, `${c.id} derived observation differs from its base`);
			else assert.equal(s.derived.from.observationSha256, s.observationSha256, `${c.id} agent-state derivation keeps the observation`);
		}
	}
	const derived = cases.filter((c) => c.source.derived).length;
	assert.ok(derived < cases.length / 2, `${derived} derived of ${cases.length}: most cases are real moments`);
});

test('multi-step cases only answer with recorded game replies', () => {
	const multi = cases.filter((c) => c.steps);
	assert.ok(multi.length >= 10 && multi.length <= 20, `${multi.length} multi-step cases`);
	for (const c of multi) {
		assert.ok(!c.source.derived, `${c.id}: canned replies come from real moments only`);
		for (const step of c.steps) for (const choice of step.canned) {
			assert.ok(choice.recorded && Number.isSafeInteger(choice.recorded.line) && Number.isSafeInteger(choice.recorded.commandLine), `${c.id} canned reply points at its recording`);
			assert.equal(choice.recorded.trace, c.source.trace, `${c.id} canned reply comes from the same trace`);
			assert.ok(choice.recorded.line > c.source.line, `${c.id} canned reply follows the moment`);
			assert.ok(['FAILED', 'TIMED_OUT', 'SUCCEEDED'].includes(choice.result.state) && typeof choice.result.reasonCode === 'string' && typeof choice.result.actionId === 'string', `${c.id} canned reply is a recorded action_result`);
			assert.equal(choice.result.actionType, choice.recorded.command.actionType);
		}
	}
});

// Grading policy since fix round 2 (Lucas's decision on review r2 P1-1): predicates decide only unambiguous outcomes,
// so every case carries a rubric that states its own recorded cause and what counts as good, bad and neutral.
test('every case keeps deterministic predicates for clear outcomes and carries a rubric for the rest', () => {
	const withPredicates = cases.filter((c) => (c.expect.good?.length ?? 0) + (c.expect.bad?.length ?? 0) > 0);
	assert.equal(withPredicates.length, cases.length, 'every case has at least one deterministic predicate');
	for (const c of cases) {
		const rubric = c.expect.judge?.rubric ?? '';
		assert.ok(rubric.length > 120, `${c.id} carries a rubric`);
		for (const part of ['Good:', 'Bad:', 'Neutral:']) assert.ok(rubric.includes(part), `${c.id} rubric says what is ${part.slice(0, -1).toLowerCase()}`);
		// The judge must not learn which build answered.
		assert.doesNotMatch(rubric, /\b(candidate|baseline|commit|branch|fingerprint)\b|\b[0-9a-f]{40}\b/i, `${c.id} rubric leaks build identity`);
		assert.ok(c.expect.threshold >= 0.5 && c.expect.threshold <= 0.8, `${c.id} threshold`);
	}
	// Failure families name the recorded failure in the rubric.
	for (const c of cases.filter((x) => ['failed-interaction-retry', 'unreachable-target', 'failure-reason-contrast'].includes(x.family))) {
		const reason = c.state.agent.recentResults.at(-1)?.result?.reasonCode;
		assert.ok(reason && c.expect.judge.rubric.includes(reason), `${c.id} rubric names ${reason}`);
	}
});

test('every case names its recorded source moment; derived variants share it with their original', () => {
	const byMoment = new Map();
	for (const c of cases) {
		assert.match(c.source.sourceMomentId ?? '', /^sm-[0-9a-f]{16}$/, `${c.id} sourceMomentId`);
		const from = c.source.derived?.from ?? c.source;
		const expected = `sm-${createHash('sha256').update(`${from.trace}\n${from.observationSha256}`).digest('hex').slice(0, 16)}`;
		assert.equal(c.source.sourceMomentId, expected, `${c.id} sourceMomentId is trace + recorded observation hash`);
		byMoment.set(c.source.sourceMomentId, [...(byMoment.get(c.source.sourceMomentId) ?? []), c]);
	}
	// A derived case whose base moment is also a real train case shares that case's id.
	for (const c of cases.filter((x) => x.source.derived)) {
		const original = cases.find((x) => !x.source.derived && x.source.trace === c.source.derived.from.trace && x.source.line === c.source.derived.from.line);
		if (original) assert.equal(c.source.sourceMomentId, original.source.sourceMomentId, `${c.id} shares ${original.id}'s source moment`);
	}
	assert.ok(byMoment.size < cases.length, 'some variants share a source moment');
});

test('the quick subset covers every train family and matches the quick flags', () => {
	const quick = JSON.parse(fs.readFileSync(path.join(fixtures, 'quick.json'), 'utf8')).ids;
	assert.deepEqual([...quick].sort(), cases.filter((c) => c.quick).map((c) => c.id).sort());
	assert.ok(quick.length >= 40 && quick.length <= 80, `${quick.length} quick cases`);
	const quickFamilies = new Set(cases.filter((c) => c.quick).map((c) => c.family));
	assert.deepEqual([...quickFamilies].sort(), [...families.keys()].sort());
});

test('the held-out split stays out of the repo; only its SHA-256 is committed', () => {
	const hash = fs.readFileSync(path.join(fixtures, 'heldout.sha256'), 'utf8').trim();
	assert.match(hash, /^[0-9a-f]{64}$/);
	const inRepo = fs.readdirSync(fixtures, { recursive: true }).filter((name) => /heldout/i.test(String(name)) && !String(name).endsWith('heldout.sha256'));
	assert.deepEqual(inRepo, []);
	assert.ok(cases.every((c) => !c.id.startsWith('ho-')));
	// With the evaluator-only file present, it must still match the committed hash (bytes only; never parsed here).
	const heldout = process.env.DECISION_EVAL_HELDOUT;
	if (heldout && fs.existsSync(heldout)) assert.equal(createHash('sha256').update(fs.readFileSync(heldout)).digest('hex'), hash);
});

test('provenance against the recorded traces (when DECISION_EVAL_TRACE_ROOT points at them)', { skip: !process.env.DECISION_EVAL_TRACE_ROOT }, async () => {
	const report = await verifyProvenance(loadCases(trainDir), process.env.DECISION_EVAL_TRACE_ROOT);
	assert.deepEqual(report.failures, []);
	assert.equal(report.cases, cases.length);
});

test('screen-open danger cases grade closing the menu alone by their rubric and carry one threshold', async () => {
	const { gradeSamples, buildCaseRows } = await import('../src/decision-eval/grade.mjs');
	const caseById = new Map(cases.map((c) => [c.id, c]));
	for (const c of cases.filter((entry) => entry.family === 'screen-open-danger')) {
		assert.ok(!('threshold' in c), `${c.id} has a top-level threshold`);
		assert.equal(typeof c.expect.threshold, 'number', c.id);
	}
	const drowning = caseById.get('screen-open-danger-03');
	assert.equal(buildCaseRows([drowning], [])[0].threshold, 0.6);
	const creeper = caseById.get('screen-open-danger-06');
	const menu = creeper.state.observation.observation?.interaction?.menu ?? creeper.state.observation.interaction?.menu;
	const close = { name: 'act', args: { actionType: 'menu_close', arguments: { containerId: menu.containerId, stateId: menu.stateId } } };
	let judgeCalls = 0;
	const judge = async (_caseDef, samples) => { judgeCalls += 1; return samples.map(() => ({ verdict: 'neutral', rationale: 'closing only' })); };
	const { graded: [graded] } = await gradeSamples(caseById, [{ caseId: creeper.id, sample: 0, calls: [close] }], { judge });
	assert.equal(graded.grade.rejectedCalls, undefined, 'the close call passes production normalization');
	assert.equal(graded.grade.verdict, 'neutral', JSON.stringify(graded.grade));
	assert.equal(judgeCalls, 1);
});
