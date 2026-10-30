import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCaseRows, gradeSamples } from '../src/decision-eval/grade.mjs';
import { compareCases, screenVerdict } from '../src/decision-eval/stats.mjs';
import { CREEPER, synthCase } from './fixtures/decision-eval-synth.mjs';

const compareCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'decision-eval', 'compare.mjs');
const FAMILIES = 15;
const PER_FAMILY = 10;
const id = (f, c) => `c${f * PER_FAMILY + c}`;
const cases = Array.from({ length: FAMILIES * PER_FAMILY }, (_, i) => synthCase({ id: `c${i}`, family: `f${Math.floor(i / PER_FAMILY)}` }));
const flee = [{ name: 'act', args: { actionType: 'flee_from', arguments: { targetId: CREEPER, distance: 16 } } }];
const fight = [{ name: 'act', args: { actionType: 'attack', arguments: { targetId: CREEPER, timeoutMs: 1000 } } }];
const row = (caseId, sample, { good = true, error = false } = {}) => ({
	schemaVersion: 1, kind: 'decision-eval-sample', caseId, family: cases.find((c) => c.id === caseId).family, sample, provider: 'claude', model: 'claude-opus-5-5',
	calls: error ? [] : good ? flee : fight, stop: error ? 'error' : 'script_end', error: error ? { code: 'PROVIDER_UNAVAILABLE', message: 'down' } : null, usage: { costUsd: 0 },
});

// Screen: every case 3/3 good in both arms, except four f3 cases where the candidate answers 1/3 good.
function screenRows(arm, { errorEvery = 0 } = {}) {
	const rows = [];
	let k = 0;
	for (const c of cases) for (let s = 0; s < 3; s += 1) {
		const weak = arm === 'candidate' && c.family === 'f3' && Number(c.id.slice(1)) % PER_FAMILY < 4 && s > 0;
		k += 1;
		rows.push(row(c.id, s, { good: !weak, error: errorEvery > 0 && k % errorEvery === 0 }));
	}
	return rows;
}

// A native run file declaring its plan: `samples` per case for every listed case, starting at sample 0.
const native = (rows, caseIds = [...new Set(rows.map((r) => r.caseId))], samples = 3) => ({
	schemaVersion: 1, kind: 'decision-eval-run', config: { samples, sampleOffset: 0, sampleCounts: Object.fromEntries(caseIds.map((caseId) => [caseId, samples])) },
	renders: Object.fromEntries(caseIds.map((caseId) => [caseId, {}])), results: rows, summary: {},
});

function run(args) {
	return new Promise((resolve) => execFile(process.execPath, [compareCli, ...args], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
}

async function withFiles(fn) {
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-verdict-'));
	const write = async (name, value) => { const file = path.join(root, name); await writeFile(file, JSON.stringify(value)); return file; };
	try {
		const casesFile = await write('cases.json', cases);
		return await fn({ root, write, casesFile });
	} finally { await rm(root, { recursive: true, force: true }); }
}

const report = async (root, dir) => JSON.parse(await readFile(path.join(root, dir, 'report.json'), 'utf8'));

test('the screen flags f3 and confirmation with almost all required samples missing stays INCONCLUSIVE, never PASS', async () => {
	await withFiles(async ({ root, write, casesFile }) => {
		const candidate = await write('screen-candidate.json', native(screenRows('candidate')));
		const baseline = await write('screen-baseline.json', native(screenRows('baseline')));
		const screen = await run(['--cases', casesFile, '--candidate', candidate, '--baseline', baseline, '--out', path.join(root, 'screen'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(screen.code, 3, screen.stderr);
		const flagged = await report(root, 'screen');
		assert.deepEqual(flagged.rerun.families, ['f3']);
		// Sol's reproduction: ten f3 cases re-asked, but only one case answered once per arm; 58 of 60 samples errored.
		const confirmRows = (arm) => Array.from({ length: PER_FAMILY }, (_, c) => [3, 4, 5].map((s) => row(id(3, c), s, { error: !(c === 0 && s === 3) }))).flat()
			.map((sample) => arm === 'candidate' ? sample : { ...sample });
		// The confirmation files declare samples 3-5 for the ten flagged cases.
		const f3 = Array.from({ length: PER_FAMILY }, (_, c) => id(3, c));
		const confirmCandidate = await write('confirm-candidate.json', nativeAt(confirmRows('candidate').filter((r) => !r.error), f3, 3, 3));
		const confirmBaseline = await write('confirm-baseline.json', nativeAt(confirmRows('baseline').filter((r) => !r.error), f3, 3, 3));
		const confirm = await run(['--cases', casesFile, '--candidate', candidate, '--baseline', baseline, '--confirm-candidate', confirmCandidate, '--confirm-baseline', confirmBaseline,
			'--out', path.join(root, 'final'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(confirm.code, 3, `must stay INCONCLUSIVE, got exit ${confirm.code}`);
		const final = await report(root, 'final');
		assert.equal(final.verdict, 'INCONCLUSIVE');
		assert.match(final.confirm.reasons.join('\n'), /f3: confirmation evidence incomplete \(candidate 1\/30, baseline 1\/30/);
		assert.equal(final.confirm.units[0].complete, false);
	});
});

test('complete fresh confirmation decides; a manifest pins which samples count', async () => {
	await withFiles(async ({ root, write, casesFile }) => {
		const candidate = await write('screen-candidate.json', native(screenRows('candidate')));
		const baseline = await write('screen-baseline.json', native(screenRows('baseline')));
		const fresh = (arm) => Array.from({ length: PER_FAMILY }, (_, c) => [3, 4, 5].map((s) => row(id(3, c), s))).flat();
		const manifest = await write('manifest.json', { required: ['candidate', 'baseline'].flatMap((arm) => Array.from({ length: PER_FAMILY }, (_, c) => [3, 4, 5].map((sample) => ({ arm, caseId: id(3, c), sample }))).flat()) });
		const result = await run(['--cases', casesFile, '--candidate', candidate, '--baseline', baseline, '--confirm-candidate', await write('cc.json', fresh('candidate')),
			'--confirm-baseline', await write('cb.json', fresh('baseline')), '--confirm-manifest', manifest, '--out', path.join(root, 'final'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(result.code, 0, result.stderr);
		const final = await report(root, 'final');
		assert.equal(final.screenVerdict, 'INCONCLUSIVE');
		assert.equal(final.confirm.verdict, 'PASS');
		assert.deepEqual(final.confirm.units.map((u) => [u.coverage.have, u.coverage.wanted, u.complete]), [[60, 60, true]]);
		assert.equal(final.families.find((f) => f.name === 'f3').candidate.n, 30, 'screen families keep describing the screen samples');
		// A confirmation sample outside the manifest is refused.
		const extra = await write('cc-extra.json', [...fresh('candidate'), row(id(3, 0), 9)]);
		const refused = await run(['--cases', casesFile, '--candidate', candidate, '--baseline', baseline, '--confirm-candidate', extra,
			'--confirm-baseline', await write('cb2.json', fresh('baseline')), '--confirm-manifest', manifest, '--out', path.join(root, 'x'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(refused.code, 2);
		assert.match(refused.stderr, /confirm: unplanned sample candidate c30#9 is not a declared identity/);
	});
});

test('Sol r3 P1-2: native files declaring 3 samples per case but holding 1 good answer per arm are INCONCLUSIVE, not PASS', async () => {
	await withFiles(async ({ root, write, casesFile }) => {
		const one = (arm) => native(cases.map((c) => row(c.id, 0)), cases.map((c) => c.id));
		const result = await run(['--cases', casesFile, '--candidate', await write('c.json', one('candidate')), '--baseline', await write('b.json', one('baseline')),
			'--out', path.join(root, 'r'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(result.code, 3, result.stderr);
		const r = await report(root, 'r');
		assert.equal(r.verdict, 'INCONCLUSIVE');
		assert.equal(r.coverage.planned, 2 * 3 * cases.length, 'the declared plan, not the rows present, is the denominator');
		// A case declared by both arms but answered by neither still counts as missing evidence.
		const gap = (arm) => native(screenRows(arm).filter((s) => s.caseId !== 'c0'), cases.map((c) => c.id));
		const both = await run(['--cases', casesFile, '--candidate', await write('c2.json', gap('candidate')), '--baseline', await write('b2.json', gap('baseline')),
			'--out', path.join(root, 'gap'), '--judge', 'off', '--spot-check', '0']);
		const g = await report(root, 'gap');
		assert.equal(g.cases.find((c) => c.id === 'c0').candidate.errors, 3);
		assert.ok(g.redo.cases.includes('c0'), both.stdout);
	});
});

test('P1-2: JSONL or array rows without a declaring plan are refused; a screen manifest declares them', async () => {
	await withFiles(async ({ root, write, casesFile }) => {
		const clean = (arm) => screenRows(arm).map((sample) => ({ ...sample, calls: flee }));
		const args = (c, b, out, extra = []) => ['--cases', casesFile, '--candidate', c, '--baseline', b, '--out', path.join(root, out), '--judge', 'off', '--spot-check', '0', ...extra];
		const c = path.join(root, 'c.jsonl');
		await writeFile(c, clean('candidate').map((r) => JSON.stringify(r)).join('\n'));
		const b = await write('b.json', clean('baseline'));
		const unknown = await run(args(c, b, 'unknown'));
		assert.equal(unknown.code, 2, unknown.stdout);
		assert.match(unknown.stderr, /unplanned sample candidate c0#0 is not a declared identity/);
		const required = ['candidate', 'baseline'].flatMap((arm) => cases.flatMap((x) => [0, 1, 2].map((sample) => ({ arm, caseId: x.id, sample }))));
		const manifest = await write('screen-manifest.json', { required });
		const known = await run(args(c, b, 'known', ['--screen-manifest', manifest]));
		assert.equal(known.code, 0, known.stdout);
		// The manifest also catches missing rows in JSONL input.
		const short = path.join(root, 'short.jsonl');
		await writeFile(short, clean('candidate').filter((r) => r.sample === 0).map((r) => JSON.stringify(r)).join('\n'));
		const missing = await run(args(short, b, 'missing', ['--screen-manifest', manifest]));
		assert.equal(missing.code, 3);
		assert.equal((await report(root, 'missing')).verdict, 'INCONCLUSIVE');
	});
});

test('P2-3: candidate-only comparisons need the same coverage; an outage or ungraded answers are INCONCLUSIVE', async () => {
	await withFiles(async ({ root, write }) => {
		const small = [synthCase({ id: 'a0', family: 'fa' })];
		const casesFile = await write('small.json', small);
		const sample = (s, opts) => ({ ...row('c0', s, opts), caseId: 'a0', family: 'fa' });
		const absolute = (file, out, judge = 'auto') => run(['--cases', casesFile, '--candidate', file, '--out', path.join(root, out), '--judge', judge, '--spot-check', '0']);
		const outage = await absolute(await write('down.json', native([0, 1, 2].map((s) => sample(s, { error: true })), ['a0'])), 'down');
		assert.equal(outage.code, 3, outage.stderr);
		assert.equal((await report(root, 'down')).verdict, 'INCONCLUSIVE');
		const fine = await absolute(await write('fine.json', native([0, 1, 2].map((s) => sample(s)), ['a0'])), 'fine', 'off');
		assert.equal(fine.code, 0, fine.stdout);
		const rubric = [synthCase({ id: 'j0', family: 'fj', expect: { judge: { rubric: 'judge me' }, threshold: 0.5 } })];
		const rubricFile = await write('rubric.json', rubric);
		const judgeOff = await run(['--cases', rubricFile, '--candidate', await write('j.json', native([0, 1, 2].map((s) => ({ ...sample(s), caseId: 'j0', family: 'fj' })), ['j0'])),
			'--out', path.join(root, 'joff'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(judgeOff.code, 3, judgeOff.stdout);
		assert.equal((await report(root, 'joff')).verdict, 'INCONCLUSIVE');
	});
});

test('Sol r4 P1: rows outside the declared plan never count; mixed native and JSONL input has no known plan', async () => {
	await withFiles(async ({ root, write }) => {
		const one = [synthCase({ id: 'a0', family: 'fa' })];
		const casesFile = await write('one.json', one);
		const sample = (s) => ({ ...row('c0', s), caseId: 'a0', family: 'fa' });
		const compare = (candidate, baseline, out, extra = []) => run(['--cases', casesFile, ...candidate.flatMap((f) => ['--candidate', f]), ...(baseline ?? []).flatMap((f) => ['--baseline', f]),
			'--out', path.join(root, out), '--judge', 'off', '--spot-check', '0', ...extra]);
		const jsonl = async (name, rows) => { const file = path.join(root, name); await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n')); return file; };
		const extraRows = Array.from({ length: 27 }, (_, i) => sample(i + 3));
		// Native files declare samples 0-2 but carry only samples 3-29: refused, not PASS on an inflated denominator.
		const unplanned = await write('unplanned.json', native(extraRows, ['a0']));
		const paired = await compare([unplanned], [unplanned], 'native');
		assert.equal(paired.code, 2, paired.stdout);
		assert.match(paired.stderr, /unplanned sample candidate a0#3 is not a declared identity/);
		// The same rows as JSONL with a screen manifest requiring 0-2: refused.
		const extra = await jsonl('extra.jsonl', extraRows);
		const manifest = await write('manifest.json', { required: ['candidate', 'baseline'].flatMap((arm) => [0, 1, 2].map((s) => ({ arm, caseId: 'a0', sample: s }))) });
		const viaManifest = await compare([extra], [extra], 'manifest', ['--screen-manifest', manifest]);
		assert.equal(viaManifest.code, 2, viaManifest.stdout);
		assert.match(viaManifest.stderr, /unplanned sample/);
		// Candidate-only with the same native file: refused.
		const absolute = await compare([unplanned], null, 'absolute');
		assert.equal(absolute.code, 2, absolute.stdout);
		// A complete native file plus undeclared JSONL rows in the same arm: refused, whatever the file order.
		const complete = await write('complete.json', native([0, 1, 2].map(sample), ['a0']));
		const unknown = await jsonl('unknown.jsonl', [3, 4].map(sample));
		for (const files of [[complete, unknown], [unknown, complete]]) {
			const mixed = await compare(files, files, 'mixed');
			assert.equal(mixed.code, 2, mixed.stdout);
			assert.match(mixed.stderr, /unplanned sample candidate a0#3/);
		}
		const alone = await compare([unknown], [unknown], 'alone');
		assert.equal(alone.code, 2);
		// The complete native file alone still passes; declaring the same identities twice is refused.
		assert.equal((await compare([complete], [complete], 'complete')).code, 0);
		const twice = await compare([complete, await write('again.json', native([], ['a0']))], [complete], 'twice');
		assert.equal(twice.code, 2, twice.stdout);
		assert.match(twice.stderr, /duplicate planned sample candidate a0#0/);
	});
});

// A native run file declaring `count` samples per listed case from `offset`.
const nativeAt = (rows, caseIds, count, offset = 0) => ({
	schemaVersion: 1, kind: 'decision-eval-run', config: { samples: count, sampleOffset: offset, sampleCounts: Object.fromEntries(caseIds.map((caseId) => [caseId, count])) },
	renders: Object.fromEntries(caseIds.map((caseId) => [caseId, {}])), results: rows, summary: {},
});
const bigSample = (s, good) => ({ ...row('c0', s, { good }), caseId: 'a0', family: 'fa' });

test('Sol r5: an empty JSONL file never disables plan validation; undeclared rows are refused and unknown plans decide nothing', async () => {
	await withFiles(async ({ root, write }) => {
		const casesFile = await write('one.json', [synthCase({ id: 'a0', family: 'fa' })]);
		let k = 0;
		const compare = async (candidate, baseline, extra = []) => {
			const out = `o${k += 1}`;
			const result = await run(['--cases', casesFile, ...candidate.flatMap((f) => ['--candidate', f]), ...(baseline ?? []).flatMap((f) => ['--baseline', f]),
				'--out', path.join(root, out), '--judge', 'off', '--spot-check', '0', ...extra]);
			return { ...result, report: result.code === 2 ? null : await report(root, out) };
		};
		const empty = path.join(root, 'empty.jsonl');
		await writeFile(empty, '');
		// 1. Native files declare 0-2 but carry 3-29 (candidate bad, baseline good). With an empty JSONL beside them, before
		//    or after: refused, paired and candidate-only.
		const extraRows = (good) => Array.from({ length: 27 }, (_, i) => bigSample(i + 3, good));
		const badNative = await write('bad-native.json', nativeAt(extraRows(false), ['a0'], 3));
		const goodNative = await write('good-native.json', nativeAt(extraRows(true), ['a0'], 3));
		for (const order of [(f) => [f, empty], (f) => [empty, f]]) {
			const paired = await compare(order(badNative), order(goodNative));
			assert.equal(paired.code, 2, paired.stdout);
			assert.match(paired.stderr, /unplanned sample candidate a0#3/);
			assert.equal((await compare(order(badNative), null)).code, 2);
		}
		// 2. A complete native control (0-2 good) plus JSONL rows 3-29, bad for the candidate: refused, not FAIL.
		const complete = await write('complete.json', nativeAt([0, 1, 2].map((s) => bigSample(s, true)), ['a0'], 3));
		assert.equal((await compare([complete], [complete])).code, 0);
		const badJsonl = path.join(root, 'bad.jsonl');
		await writeFile(badJsonl, extraRows(false).map((r) => JSON.stringify(r)).join('\n'));
		const goodJsonl = path.join(root, 'good.jsonl');
		await writeFile(goodJsonl, extraRows(true).map((r) => JSON.stringify(r)).join('\n'));
		assert.equal((await compare([complete, badJsonl], [complete, goodJsonl])).code, 2);
		assert.equal((await compare([badJsonl, complete], null)).code, 2);
		// 3. A declared comparison that FAILs on its own (30 bad vs 30 good) cannot decide once an empty JSONL makes the
		//    plan unknown, before or after the native file, paired and candidate-only.
		const thirty = (good) => nativeAt(Array.from({ length: 30 }, (_, s) => bigSample(s, good)), ['a0'], 30);
		const bad30 = await write('bad30.json', thirty(false));
		const good30 = await write('good30.json', thirty(true));
		assert.equal((await compare([bad30], [good30])).code, 1, 'the declared control fails');
		assert.equal((await compare([bad30], null)).code, 1, 'and fails its threshold without a baseline');
		for (const files of [[bad30, empty], [empty, bad30]]) {
			const paired = await compare(files, [good30]);
			assert.equal(paired.code, 3, paired.stdout);
			assert.equal(paired.report.verdict, 'INCONCLUSIVE');
			assert.equal(paired.report.screenVerdict, 'INCONCLUSIVE');
			assert.match(paired.report.reasons.join('\n'), /sample plan is unknown/);
			assert.equal((await compare(files, null)).code, 3);
		}
		// A manifest declares the plan, so the empty JSONL is harmless and the declared loss decides.
		const manifest = await write('m.json', { required: ['candidate', 'baseline'].flatMap((arm) => Array.from({ length: 30 }, (_, sample) => ({ arm, caseId: 'a0', sample }))) });
		assert.equal((await compare([bad30, empty], [good30], ['--screen-manifest', manifest])).code, 1);
		// 4. Empty native files: one that declares 3 samples but holds none counts all 3 as missing; one without a plan
		//    makes the plan unknown.
		const declaredEmpty = await write('declared-empty.json', nativeAt([], ['a0'], 3));
		const declaredOnly = await compare([declaredEmpty], [complete]);
		assert.equal(declaredOnly.code, 3);
		assert.equal(declaredOnly.report.cases[0].candidate.errors, 3);
		const planlessNative = await write('planless-native.json', { schemaVersion: 1, kind: 'decision-eval-run', results: [], summary: {} });
		for (const files of [[complete, planlessNative], [planlessNative, complete]]) assert.equal((await compare(files, [complete])).code, 3);
	});
});

// Property: random mixes of declared native files, undeclared rows, empty JSONL and planless files, with or without a
// manifest. compare may PASS or FAIL only when every supplied row is a declared identity of its arm and the plan is
// known; it refuses undeclared rows; and a decided verdict always rests on the declared denominator.
test('random mixes of declared, undeclared and empty inputs never PASS or FAIL unless every row is declared and the plan is known', async () => {
	await withFiles(async ({ root, write }) => {
		const casesFile = await write('one.json', [synthCase({ id: 'a0', family: 'fa' })]);
		let seed = 20261012;
		const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
		const pick = (list) => list[Math.floor(rnd() * list.length)];
		const TRIALS = 60;
		const seen = { 0: 0, 1: 0, 2: 0, 3: 0 };
		for (let trial = 0; trial < TRIALS; trial += 1) {
			const arms = {};
			const useManifest = rnd() < 0.25;
			for (const arm of ['candidate', 'baseline']) {
				const goodRate = arm === 'candidate' ? pick([0, 0.5, 1]) : 1;
				const files = [];
				const count = 1 + Math.floor(rnd() * 3);
				for (let f = 0; f < count; f += 1) {
					const kind = pick(['native', 'native', 'native', 'jsonl', 'empty-jsonl', 'planless-native', 'empty-native']);
					const offset = pick([0, 0, 30]);
					const n = pick([3, 30]);
					const declared = Array.from({ length: n }, (_, i) => offset + i);
					const rows = [];
					// Unknown corpus case ids: declared beside a0, or supplied as rows.
					const declaresUnknown = (kind === 'native' || kind === 'empty-native') && rnd() < 0.12;
					if (kind === 'native') {
						for (const s of declared) if (rnd() < 0.9) rows.push(bigSample(s, rnd() < goodRate));
						if (rnd() < 0.3) rows.push(bigSample(100 + Math.floor(rnd() * 50), rnd() < goodRate));
					} else if (kind === 'jsonl' || kind === 'planless-native') {
						const m = Math.floor(rnd() * 4);
						for (let i = 0; i < m; i += 1) rows.push(bigSample(Math.floor(rnd() * 60), rnd() < goodRate));
					}
					if (rows.length && rnd() < 0.1) rows.push({ ...bigSample(200 + f, true), caseId: 'not-in-corpus' });
					const plan = kind === 'native' || kind === 'empty-native' ? declared : null;
					files.push({ kind, rows, plan, n, offset, caseIds: declaresUnknown ? ['a0', 'not-in-corpus'] : ['a0'] });
				}
				arms[arm] = files;
			}
			// The oracle, written from the rule rather than from compare's code.
			let refused = false;
			let known = true;
			const declaredBy = {};
			// Identities are `case|sample`; the corpus holds only a0.
			const ids = (f) => f.plan === null ? [] : f.caseIds.flatMap((c) => f.plan.map((s) => `${c}|${s}`));
			const rowKey = (r) => `${r.caseId}|${r.sample}`;
			const inCorpus = (k) => k.startsWith('a0|');
			const checkArm = (files) => {
				const declared = new Set();
				let bad = false;
				for (const k of files.flatMap(ids)) { if (declared.has(k) && !useManifest) bad = true; declared.add(k); }
				const plan = useManifest ? new Set(files.flatMap(ids)) : declared;
				if ([...plan].some((k) => !inCorpus(k))) bad = true;
				const rowIds = files.flatMap((f) => f.rows.map(rowKey));
				if (new Set(rowIds).size !== rowIds.length || rowIds.some((k) => !plan.has(k) || !inCorpus(k))) bad = true;
				return { bad, plan, known: useManifest || (files.every((f) => f.plan !== null) && declared.size > 0) };
			};
			for (const [arm, files] of Object.entries(arms)) {
				const result = checkArm(files);
				if (result.bad) refused = true;
				if (!result.known) known = false;
				declaredBy[arm] = result.plan;
			}
			const paths = {};
			for (const [arm, files] of Object.entries(arms)) {
				paths[arm] = [];
				for (const [i, f] of files.entries()) {
					const name = path.join(root, `t${trial}-${arm}-${i}`);
					if (f.kind === 'native' || f.kind === 'empty-native') { await writeFile(`${name}.json`, JSON.stringify(nativeAt(f.rows, f.caseIds, f.n, f.offset))); paths[arm].push(`${name}.json`); }
					else if (f.kind === 'planless-native') { await writeFile(`${name}.json`, JSON.stringify({ schemaVersion: 1, kind: 'decision-eval-run', results: f.rows, summary: {} })); paths[arm].push(`${name}.json`); }
					else { await writeFile(`${name}.jsonl`, f.rows.map((r) => JSON.stringify(r)).join('\n')); paths[arm].push(`${name}.jsonl`); }
				}
			}
			const extra = [];
			if (useManifest) {
				const required = Object.entries(declaredBy).flatMap(([arm, set]) => [...set].map((k) => ({ arm, caseId: k.split('|')[0], sample: Number(k.split('|')[1]) })));
				extra.push('--screen-manifest', await write(`t${trial}-manifest.json`, { required }));
			}
			const baseline = rnd() < 0.3 ? null : paths.baseline;
			if (baseline === null) {
				// Candidate-only: the oracle covers only the candidate arm, and a manifest naming the absent baseline is refused.
				const result = checkArm(arms.candidate);
				refused = result.bad || (useManifest && declaredBy.baseline.size > 0);
				known = result.known;
			}
			const out = path.join(root, `r${trial}`);
			const result = await run(['--cases', casesFile, ...paths.candidate.flatMap((f) => ['--candidate', f]), ...(baseline ?? []).flatMap((f) => ['--baseline', f]),
				'--out', out, '--judge', 'off', '--spot-check', '0', ...extra]);
			seen[result.code] = (seen[result.code] ?? 0) + 1;
			const label = `trial ${trial}: ${JSON.stringify({ useManifest, baseline: baseline !== null, arms: Object.fromEntries(Object.entries(arms).map(([a, fs]) => [a, fs.map((f) => `${f.kind}:${f.caseIds.join('+')}:${f.offset}+${f.n}:${f.rows.length}`)])) })}`;
			if (refused) { assert.equal(result.code, 2, `${label} must be refused\n${result.stdout}`); continue; }
			assert.notEqual(result.code, 2, `${label} was refused: ${result.stderr}`);
			if (!known) {
				assert.equal(result.code, 3, `${label} has an unknown plan and must be INCONCLUSIVE`);
				// Missing declared evidence stays in the INCONCLUSIVE output too.
				const r = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
				for (const arm of baseline === null ? ['candidate'] : ['candidate', 'baseline']) {
					const c = r.cases.find((x) => x.id === 'a0')?.[arm];
					if (declaredBy[arm].size) assert.equal(c.n + c.errors + c.ungraded, declaredBy[arm].size, `${label}: ${arm} keeps its declared denominator`);
				}
				continue;
			}
			if (result.code === 0 || result.code === 1) {
				const r = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
				const plannedPerArm = (arm) => declaredBy[arm].size;
				for (const arm of baseline === null ? ['candidate'] : ['candidate', 'baseline']) {
					const c = r.cases[0][arm];
					assert.equal(c.n + c.errors + c.ungraded, plannedPerArm(arm), `${label}: the ${arm} denominator is the declared plan`);
				}
				if (result.code === 0) assert.ok(r.coverage.incompleteFraction <= 0.1, `${label}: PASS needs coverage`);
				else assert.ok(r.cases[0].candidate.n >= Math.ceil(plannedPerArm('candidate') / 2), `${label}: FAIL needs the case's minimum evidence`);
			}
		}
		assert.ok(seen[2] > 0 && seen[3] > 0 && seen[0] + seen[1] > 0, `the generator reaches refusals, INCONCLUSIVE and decisions: ${JSON.stringify(seen)}`);
	});
});

test('Sol r6 P1-1: a case id outside the corpus refuses the input wherever it appears', async () => {
	await withFiles(async ({ root, write }) => {
		const casesFile = await write('one.json', [synthCase({ id: 'a0', family: 'fa' })]);
		let k = 0;
		const compare = (candidate, baseline, extra = []) => run(['--cases', casesFile, ...candidate.flatMap((f) => ['--candidate', f]), ...(baseline ?? []).flatMap((f) => ['--baseline', f]),
			'--out', path.join(root, `o${k += 1}`), '--judge', 'off', '--spot-check', '0', ...extra]);
		const thirty = Array.from({ length: 30 }, (_, s) => bigSample(s, true));
		// A manifest requiring 30 samples of a0 and of a case the corpus lacks: refused, not PASS on half the plan.
		const rows = path.join(root, 'rows.jsonl');
		await writeFile(rows, thirty.map((r) => JSON.stringify(r)).join('\n'));
		const manifest = await write('m.json', { required: ['candidate', 'baseline'].flatMap((arm) => ['a0', 'not-in-corpus'].flatMap((caseId) => Array.from({ length: 30 }, (_, sample) => ({ arm, caseId, sample })))) });
		const viaManifest = await compare([rows], [rows], ['--screen-manifest', manifest]);
		assert.equal(viaManifest.code, 2, viaManifest.stdout);
		assert.match(viaManifest.stderr, /screen: declared case not-in-corpus \(candidate #0\) is not in the corpus/);
		// The same declaration in native sampleCounts, paired and candidate-only.
		const declared = await write('declared.json', nativeAt(thirty, ['a0', 'not-in-corpus'], 30));
		assert.equal((await compare([declared], [declared])).code, 2);
		assert.equal((await compare([declared], null)).code, 2);
		// Undeclared rows of an unknown case, and duplicate unknown-case rows: refused before anything is filtered.
		const plain = await write('plain.json', nativeAt(thirty, ['a0'], 30));
		const extra = path.join(root, 'extra.jsonl');
		await writeFile(extra, [0, 0].map((s) => JSON.stringify({ ...bigSample(s, true), caseId: 'not-in-corpus' })).join('\n'));
		const unknownRows = await compare([plain, extra], [plain]);
		assert.equal(unknownRows.code, 2);
		assert.match(unknownRows.stderr, /screen: row for case not-in-corpus \(candidate #0\) is not in the corpus/);
		assert.match(unknownRows.stderr, /screen: duplicate sample candidate not-in-corpus#0/);
		assert.equal((await compare([plain], [plain])).code, 0, 'the declared control passes');
	});
});

// The committed borderline screen (150 cases, f3 mildly worse) flags the ten f3 cases; these confirm them.
const f3 = Array.from({ length: PER_FAMILY }, (_, c) => id(3, c));
const confirmRow = (caseId, s, good = true) => row(caseId, s, { good });
async function borderline(write) {
	return { candidate: await write('screen-candidate.json', native(screenRows('candidate'))), baseline: await write('screen-baseline.json', native(screenRows('baseline'))) };
}

test('Sol r6 P1-2: confirmation inputs pass the same plan validation; unplanned or planless confirmation never decides', async () => {
	await withFiles(async ({ root, write, casesFile }) => {
		const screen = await borderline(write);
		let k = 0;
		const confirm = async (candidate, baseline, extra = []) => {
			const out = `c${k += 1}`;
			const result = await run(['--cases', casesFile, '--candidate', screen.candidate, '--baseline', screen.baseline, ...candidate.flatMap((f) => ['--confirm-candidate', f]),
				...baseline.flatMap((f) => ['--confirm-baseline', f]), '--out', path.join(root, out), '--judge', 'off', '--spot-check', '0', ...extra]);
			return { ...result, report: result.code === 2 ? null : await report(root, out) };
		};
		const rowsFor = (samples, good) => f3.flatMap((caseId) => samples.map((s) => confirmRow(caseId, s, good)));
		const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
		// Control: declared 3-5, supplied 3-5, all good: PASS.
		const valid = (arm) => write(`valid-${arm}.json`, nativeAt(rowsFor(range(3, 5), true), f3, 3, 3));
		const control = await confirm([await valid('c')], [await valid('b')]);
		assert.equal(control.code, 0, control.stdout);
		// 1. Declares 3-5, supplies only 6-8: refused, not PASS on 60/60 claimed evidence.
		const shifted = await write('shifted.json', nativeAt(rowsFor(range(6, 8), true), f3, 3, 3));
		const one = await confirm([shifted], [shifted]);
		assert.equal(one.code, 2, one.stdout);
		assert.match(one.stderr, /confirm: unplanned sample candidate c30#6/);
		// 2. Declares 30 per case (3-32), supplies 3-5: INCONCLUSIVE with the declared denominator.
		const wide = await write('wide.json', nativeAt(rowsFor(range(3, 5), true), f3, 30, 3));
		const two = await confirm([wide], [wide]);
		assert.equal(two.code, 3, two.stdout);
		assert.equal(two.report.confirm.verdict, 'INCONCLUSIVE');
		assert.deepEqual(two.report.confirm.units.map((u) => u.coverage.wanted), [600]);
		// 3. Declares 3-5, supplies 6-32, candidate bad and baseline good: refused, not FAIL.
		const three = await confirm([await write('bad.json', nativeAt(rowsFor(range(6, 32), false), f3, 3, 3))], [await write('good.json', nativeAt(rowsFor(range(6, 32), true), f3, 3, 3))]);
		assert.equal(three.code, 2, three.stdout);
		// 4. Planless confirmation: arrays, JSONL and a native file without a plan carry undeclared rows (refused); an
		//    empty JSONL beside a complete declared confirmation leaves the plan unknown (INCONCLUSIVE, not PASS).
		const array = await write('array.json', rowsFor(range(3, 5), true));
		assert.equal((await confirm([array], [array])).code, 2);
		const jsonl = path.join(root, 'confirm.jsonl');
		await writeFile(jsonl, rowsFor(range(3, 5), true).map((r) => JSON.stringify(r)).join('\n'));
		assert.equal((await confirm([jsonl], [jsonl])).code, 2);
		const noPlan = await write('noplan.json', { schemaVersion: 1, kind: 'decision-eval-run', results: rowsFor(range(3, 5), true), summary: {} });
		assert.equal((await confirm([noPlan], [noPlan])).code, 2);
		const empty = path.join(root, 'empty.jsonl');
		await writeFile(empty, '');
		for (const files of [[await valid('c2'), empty], [empty, await valid('c3')]]) {
			const unknown = await confirm(files, [await valid('b2')]);
			assert.equal(unknown.code, 3, unknown.stdout);
			assert.equal(unknown.report.confirm.verdict, 'INCONCLUSIVE');
			assert.match(unknown.report.confirm.reasons.join('\n'), /confirmation plan is unknown/);
		}
		// A confirmation manifest is the plan: the empty JSONL is then harmless, and an extra unknown-case row is refused.
		const manifest = await write('cm.json', { required: ['candidate', 'baseline'].flatMap((arm) => f3.flatMap((caseId) => range(3, 5).map((sample) => ({ arm, caseId, sample })))) });
		assert.equal((await confirm([await valid('c4'), empty], [await valid('b4')], ['--confirm-manifest', manifest])).code, 0);
		const stray = await write('stray.json', [{ ...confirmRow('c30', 3), caseId: 'not-in-corpus' }]);
		const strayResult = await confirm([await valid('c5'), stray], [await valid('b5')], ['--confirm-manifest', manifest]);
		assert.equal(strayResult.code, 2);
		assert.match(strayResult.stderr, /confirm: row for case not-in-corpus/);
	});
});

// Property: random confirmation inputs on the borderline screen. Refused whenever a confirmation row or declaration
// names a case outside the corpus, repeats, is undeclared, or reuses a screen identity; INCONCLUSIVE whenever the
// confirmation plan is unknown; and a decided confirmation rests on its declared denominator.
test('random confirmation inputs never decide unless every row is declared, in the corpus and fresh, and the plan is known', async () => {
	await withFiles(async ({ root, write, casesFile }) => {
		const screen = await borderline(write);
		let seed = 61012;
		const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
		const pick = (list) => list[Math.floor(rnd() * list.length)];
		const seen = {};
		for (let trial = 0; trial < 30; trial += 1) {
			const useManifest = rnd() < 0.25;
			const arms = {};
			for (const arm of ['candidate', 'baseline']) {
				const goodRate = arm === 'candidate' ? pick([0, 1]) : 1;
				const files = [];
				for (let f = 0, count = 1 + Math.floor(rnd() * 2); f < count; f += 1) {
					const kind = pick(['native', 'native', 'native', 'jsonl', 'empty-jsonl', 'planless-native']);
					const offset = pick([3, 3, 3, 0, 6]);
					const n = pick([3, 3, 6]);
					const caseIds = rnd() < 0.1 ? [...f3, 'not-in-corpus'] : f3;
					const plan = kind === 'native' ? caseIds.flatMap((c) => Array.from({ length: n }, (_, i) => `${c}|${offset + i}`)) : null;
					const rows = [];
					if (kind === 'native') {
						for (const k of plan) if (!k.startsWith('not-in-corpus') && rnd() < 0.95) rows.push(confirmRow(k.split('|')[0], Number(k.split('|')[1]), rnd() < goodRate));
						if (rnd() < 0.15) rows.push(confirmRow(pick(f3), 40 + Math.floor(rnd() * 10), true));
					} else if (kind !== 'empty-jsonl') {
						for (let i = 0, m = Math.floor(rnd() * 3); i < m; i += 1) rows.push(confirmRow(pick(f3), 3 + Math.floor(rnd() * 6), true));
					}
					if (rows.length && rnd() < 0.1) rows.push({ ...confirmRow('c30', 90 + f), caseId: 'not-in-corpus' });
					files.push({ kind, rows, plan, n, offset, caseIds });
				}
				arms[arm] = files;
			}
			// Oracle from the rule. Screen identities are samples 0-2 of every case in both arms.
			const isScreen = (k) => Number(k.split('|')[1]) <= 2;
			const inCorpus = (k) => !k.startsWith('not-in-corpus|');
			let refused = false;
			let known = true;
			const declaredBy = {};
			for (const [arm, files] of Object.entries(arms)) {
				const declared = new Set();
				for (const k of files.flatMap((f) => f.plan ?? [])) { if (declared.has(k) && !useManifest) refused = true; declared.add(k); }
				if ([...declared].some((k) => !inCorpus(k) || isScreen(k))) refused = true;
				const rowKeys = files.flatMap((f) => f.rows.map((r) => `${r.caseId}|${r.sample}`));
				if (new Set(rowKeys).size !== rowKeys.length || rowKeys.some((k) => !declared.has(k) || !inCorpus(k) || isScreen(k))) refused = true;
				if (!useManifest && (files.some((f) => f.plan === null) || declared.size === 0)) known = false;
				declaredBy[arm] = declared;
			}
			const paths = {};
			for (const [arm, files] of Object.entries(arms)) {
				paths[arm] = [];
				for (const [i, f] of files.entries()) {
					const name = path.join(root, `p${trial}-${arm}-${i}`);
					if (f.kind === 'native') await writeFile(`${name}.json`, JSON.stringify(nativeAt(f.rows, f.caseIds, f.n, f.offset)));
					else if (f.kind === 'planless-native') await writeFile(`${name}.json`, JSON.stringify({ schemaVersion: 1, kind: 'decision-eval-run', results: f.rows, summary: {} }));
					paths[arm].push(f.kind === 'native' || f.kind === 'planless-native' ? `${name}.json` : `${name}.jsonl`);
					if (f.kind === 'jsonl' || f.kind === 'empty-jsonl') await writeFile(`${name}.jsonl`, f.rows.map((r) => JSON.stringify(r)).join('\n'));
				}
			}
			const extra = [];
			if (useManifest) {
				const required = Object.entries(declaredBy).flatMap(([arm, set]) => [...set].map((k) => ({ arm, caseId: k.split('|')[0], sample: Number(k.split('|')[1]) })));
				extra.push('--confirm-manifest', await write(`p${trial}-manifest.json`, { required }));
			}
			const out = path.join(root, `pr${trial}`);
			const result = await run(['--cases', casesFile, '--candidate', screen.candidate, '--baseline', screen.baseline, ...paths.candidate.flatMap((f) => ['--confirm-candidate', f]),
				...paths.baseline.flatMap((f) => ['--confirm-baseline', f]), '--out', out, '--judge', 'off', '--spot-check', '0', ...extra]);
			seen[result.code] = (seen[result.code] ?? 0) + 1;
			const label = `trial ${trial}: ${JSON.stringify({ useManifest, arms: Object.fromEntries(Object.entries(arms).map(([a, fs]) => [a, fs.map((f) => `${f.kind}:${f.caseIds.length}:${f.offset}+${f.n}:${f.rows.length}`)])) })}`;
			if (refused) { assert.equal(result.code, 2, `${label} must be refused\n${result.stdout}`); continue; }
			assert.notEqual(result.code, 2, `${label} was refused: ${result.stderr}`);
			const r = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
			if (!known) { assert.equal(result.code, 3, `${label}: unknown confirmation plan must be INCONCLUSIVE`); assert.equal(r.confirm.verdict, 'INCONCLUSIVE'); continue; }
			// The screen is INCONCLUSIVE, so the final verdict is the confirmation's; its f3 unit wants the declared samples.
			// A flagged case the confirmation does not declare in either arm still needs --confirm-samples (3) per arm.
			const declaredCount = (c) => [...declaredBy.candidate, ...declaredBy.baseline].filter((k) => k.startsWith(`${c}|`)).length;
			const wanted = f3.reduce((sum, c) => sum + (declaredCount(c) || 6), 0);
			assert.equal(r.confirm.units[0].coverage.wanted, wanted, `${label}: the confirmation denominator is its declared plan`);
			if (result.code !== 3) assert.ok(r.confirm.units[0].complete, `${label}: a decision needs a complete unit`);
		}
		assert.ok(seen[2] > 0 && seen[3] > 0 && (seen[0] ?? 0) + (seen[1] ?? 0) > 0, `the generator reaches refusals, INCONCLUSIVE and decisions: ${JSON.stringify(seen)}`);
	});
});

test('compare reaches grading and statistics only through validateEvidence', async () => {
	const { readFile: read } = await import('node:fs/promises');
	const source = await read(compareCli, 'utf8');
	assert.doesNotMatch(source, /buildCaseRows|\.run\.samples|gradeSamples\(caseById, (?!samples)/, 'compare must not build case rows or read loaded rows directly');
	assert.match(source, /validateEvidence\(\{ stage: 'screen'/);
	assert.match(source, /validateEvidence\(\{ stage: 'confirm'/);
	const { evidenceSamples, evidenceCaseRows } = await import('../src/decision-eval/evidence.mjs');
	assert.throws(() => evidenceSamples({ arms: ['candidate'], identities: { candidate: new Set() } }), /must come from validateEvidence/);
	assert.throws(() => evidenceCaseRows({ arms: ['candidate'], identities: { candidate: new Set() } }, { candidate: [] }), /must come from validateEvidence/);
});

test('reused screen samples and duplicate samples are refused', async () => {
	await withFiles(async ({ root, write, casesFile }) => {
		const candidate = await write('screen-candidate.json', native(screenRows('candidate')));
		const baseline = await write('screen-baseline.json', native(screenRows('baseline')));
		const reused = await run(['--cases', casesFile, '--candidate', candidate, '--baseline', baseline, '--confirm-candidate', candidate, '--confirm-baseline', baseline,
			'--out', path.join(root, 'reused'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(reused.code, 2);
		assert.match(reused.stderr, /refusing: 1800 input problems/, "900 declared screen identities plus 900 reused screen rows");
		assert.match(reused.stderr, /confirm: declares screen sample candidate c0#0/);
		const duplicated = await write('dup.json', native([...screenRows('candidate'), row('c0', 0)]));
		const dup = await run(['--cases', casesFile, '--candidate', duplicated, '--baseline', baseline, '--out', path.join(root, 'dup'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(dup.code, 2);
		assert.match(dup.stderr, /duplicate sample candidate c0#0/);
	});
});

test('an error-only screen is INCONCLUSIVE and names the cases to answer again', async () => {
	await withFiles(async ({ root, write, casesFile }) => {
		const clean = (arm) => screenRows(arm).map((sample) => ({ ...sample, calls: flee }));
		const candidate = await write('c.json', native(clean('candidate').map((sample, i) => i % 4 === 0 ? row(sample.caseId, sample.sample, { error: true }) : sample)));
		const baseline = await write('b.json', native(clean('baseline')));
		const result = await run(['--cases', casesFile, '--candidate', candidate, '--baseline', baseline, '--out', path.join(root, 'screen'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(result.code, 3);
		const screen = await report(root, 'screen');
		assert.equal(screen.rerun.families.length, 0, 'no drop was flagged');
		assert.ok(screen.redo.cases.length > 0, 'the errored cases are listed for a new screen');
		assert.match(screen.reasons.join('\n'), /incomplete evidence, not decided/);
	});
});

test('a judge outage leaves answers ungraded and the comparison INCONCLUSIVE, not PASS', async () => {
	const rubricCases = Array.from({ length: 6 }, (_, i) => synthCase({ id: `r${i}`, family: 'night', expect: { judge: { rubric: 'prepare for night' }, threshold: 0.5 } }));
	const byId = new Map(rubricCases.map((c) => [c.id, c]));
	const samples = (arm) => rubricCases.flatMap((c) => [0, 1, 2].map((sample) => ({ caseId: c.id, family: 'night', sample, arm, calls: flee, stop: 'script_end', error: null })));
	const throwing = async () => { throw new Error('judge unavailable'); };
	const graded = async (arm) => (await gradeSamples(byId, samples(arm), { judge: throwing })).graded;
	const candidate = await graded('candidate');
	assert.ok(candidate.every((r) => r.grade.verdict === 'ungraded' && r.grade.source === 'judge-error'));
	const comparison = compareCases(buildCaseRows(rubricCases, candidate, await graded('baseline')));
	const verdict = screenVerdict(comparison);
	assert.equal(verdict.verdict, 'INCONCLUSIVE');
	assert.equal(verdict.coverage.ungraded, 36);
	assert.match(verdict.reasons.join('\n'), /incomplete evidence, not decided/);
});

test('predicate-only mode grades hard decisions only and leaves judge decisions ungraded, so it cannot PASS on them', async () => {
	await withFiles(async ({ root, write }) => {
		const mixed = [...cases.slice(0, 20), synthCase({ id: 'rubric-only', family: 'f1', expect: { judge: { rubric: 'judge me' } } })];
		const casesFile = await write('mixed.json', mixed);
		const rows = (arm) => [...screenRows(arm).filter((s) => Number(s.caseId.slice(1)) < 20), ...[0, 1, 2].map((s) => ({ ...row('c0', s), caseId: 'rubric-only' }))];
		const result = await run(['--cases', casesFile, '--candidate', await write('c.json', native(rows('candidate'))), '--baseline', await write('b.json', native(rows('baseline'))),
			'--out', path.join(root, 'po'), '--judge', 'off', '--spot-check', '0']);
		assert.equal(result.code, 3, result.stderr);
		const po = await report(root, 'po');
		assert.deepEqual(po.coverageMode, { mode: 'predicate-only', cases: 21 });
		assert.equal(po.coverage.ungraded, 6);
		assert.ok(po.cases.some((c) => c.id === 'rubric-only'), 'the case stays in the plan');
		assert.match(result.stdout, /Predicate-only mode \(diagnostic\)/);
		assert.match(po.reasons.join(String.fromCharCode(10)), /f1: incomplete evidence, not decided/);
	});
});
