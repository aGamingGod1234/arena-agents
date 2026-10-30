import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'decision-eval', 'run.mjs');
const replay = JSON.parse(await readFile(new URL('./fixtures/decision-eval/g1-replay-sample.json', import.meta.url), 'utf8'));

function run(args) {
	return new Promise((resolve) => execFile(process.execPath, [cli, ...args], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
}

test('the CLI refuses held-out cases without the expected case-set hash and renders them with it', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-cli-'));
	try {
		const file = path.join(root, 'heldout.json');
		const cases = [{ id: 'held-1', family: 'held', causeClass: 'held', split: 'heldout', state: { observation: replay.observations[0], agent: { goal: replay.goal } }, expect: { good: [{ tool: 'moveTo' }] } }];
		await writeFile(file, JSON.stringify(cases));
		const digest = createHash('sha256').update(await readFile(file)).digest('hex');
		const missing = await run(['--cases', file, '--split', 'heldout', '--dry-run']);
		assert.equal(missing.code, 3);
		assert.match(missing.stderr, /need --expect-fixture-sha256/);
		const wrong = await run(['--cases', file, '--split', 'heldout', '--dry-run', '--expect-fixture-sha256', '0'.repeat(64)]);
		assert.equal(wrong.code, 3);
		assert.match(wrong.stderr, /refusing/);
		await writeFile(path.join(root, 'heldout.sha256'), `${digest}  heldout.json\n`);
		const out = path.join(root, 'run.json');
		const ok = await run(['--cases', file, '--split', 'heldout', '--dry-run', '--expect-fixture-sha256', `@${path.join(root, 'heldout.sha256')}`, '--out', out]);
		assert.equal(ok.code, 0, ok.stderr);
		const written = JSON.parse(await readFile(out, 'utf8'));
		assert.equal(written.kind, 'decision-eval-run');
		assert.equal(written.config.casesSha256, digest);
		assert.equal(written.summary.rendered, 1);
		assert.match(written.build.fingerprint, /^[0-9a-f]{64}$/);
		assert.match(written.renders['held-1'].encodedSha256, /^[0-9a-f]{64}$/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('cached samples of the same build, case and profile are reused and their samples are not asked again', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-cache-'));
	try {
		const file = path.join(root, 'cases.json');
		const testCase = { id: 'cache-1', family: 'cache', causeClass: 'cache', split: 'train', state: { observation: replay.observations[0], agent: { goal: replay.goal } }, expect: { good: [{ tool: 'moveTo' }] } };
		await writeFile(file, JSON.stringify([testCase]));
		const cacheDir = path.join(root, 'cache');
		const report = async (extra = []) => {
			const result = await run(['--cases', file, '--samples', '2', '--cache-dir', cacheDir, '--cache-report', ...extra]);
			assert.equal(result.code, 0, result.stderr);
			return JSON.parse(result.stdout.trim().split('\n').pop());
		};
		const empty = await report();
		assert.deepEqual([empty.cached, empty.missing], [0, 2]);
		const out = path.join(root, 'dry.json');
		assert.equal((await run(['--cases', file, '--dry-run', '--out', out])).code, 0);
		const encoded = JSON.parse(await readFile(out, 'utf8')).renders['cache-1'].encodedSha256;
		// The answer key: recorded state and steps plus this build's wake, not expectations or rubric.
		const caseKey = createHash('sha256').update(`${JSON.stringify({ state: testCase.state, steps: null })}\n${encoded}`).digest('hex').slice(0, 16);
		const row = { schemaVersion: 1, kind: 'decision-eval-sample', caseId: 'cache-1', sample: 1, calls: [], stop: 'turn_end', error: null, usage: { costUsd: 0.05 } };
		const { mkdir } = await import('node:fs/promises');
		await mkdir(path.join(cacheDir, empty.cacheBuildKey.slice(0, 24)), { recursive: true });
		await writeFile(path.join(cacheDir, empty.cacheBuildKey.slice(0, 24), `cache-1-${caseKey}.jsonl`), `${JSON.stringify(row)}\n`);
		const hit = await report();
		assert.deepEqual([hit.cached, hit.missing], [1, 1], 'sample 1 comes from the cache, sample 0 is still asked');
		assert.equal((await report(['--sample-offset', '2'])).cached, 0, 'confirm samples use fresh indexes');
		assert.notEqual((await report(['--random-view-id'])).cacheBuildKey, empty.cacheBuildKey, 'the view-id mode is part of the key');
		assert.notEqual((await report(['--effort', 'medium'])).cacheBuildKey, empty.cacheBuildKey, 'so is the model profile');
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('eval.mjs refuses a held-out run without the committed hash and an unknown baseline', async () => {
	const evalCli = path.join(path.dirname(cli), 'eval.mjs');
	const call = (args) => new Promise((resolve) => execFile(process.execPath, [evalCli, ...args], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-eval-'));
	try {
		const held = path.join(root, 'held.json');
		await writeFile(held, '[]');
		const noHash = await call(['--baseline', 'HEAD', '--split', 'heldout', '--cases', held, '--out', root]);
		assert.equal(noHash.code, 2);
		assert.match(noHash.stderr, /expect-fixture-sha256/);
		const unknown = await call(['--baseline', 'no-such-ref-decision-eval', '--out', root, '--judge', 'off']);
		assert.equal(unknown.code, 2);
		assert.match(await readFile(path.join(root, 'eval.log'), 'utf8'), /neither a checkout nor a commit/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('the cache key changes with the effective max calls, the cache epoch and the provider runtime', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-cachekey-'));
	try {
		const file = path.join(root, 'cases.json');
		await writeFile(file, JSON.stringify([{ id: 'key-1', family: 'key', causeClass: 'key', split: 'train', state: { observation: replay.observations[0], agent: { goal: replay.goal } }, expect: { good: [{ tool: 'moveTo' }] } }]));
		const key = async (extra) => {
			const result = await run(['--cases', file, '--samples', '1', '--cache-dir', path.join(root, 'cache'), '--cache-report', ...extra]);
			assert.equal(result.code, 0, result.stderr);
			return JSON.parse(result.stdout.trim().split('\n').pop()).cacheBuildKey;
		};
		const one = await key(['--max-calls', '1']);
		assert.notEqual(one, await key(['--max-calls', '10']), 'a longer call horizon captures different decisions');
		assert.notEqual(await key([]), await key(['--cache-epoch', '2']), 'a new epoch retires cached samples');
		const { cacheIdentity, providerRuntime } = await import('../src/decision-eval/runner.mjs');
		const base = { fingerprint: 'f', harnessSha256: 'h', provider: 'claude', model: 'm', effort: 'low', viewSession: 'v', maxCalls: null, epoch: '1' };
		assert.notEqual(cacheIdentity({ ...base, runtime: { command: 'claude', version: '2.1.296' } }), cacheIdentity({ ...base, runtime: { command: 'claude', version: '2.1.300' } }));
		const runtime = await providerRuntime('claude', { resolve: () => ({ command: 'fake-claude', args: [], environment: {} }), exec: async () => ({ stdout: '9.9.9 (Claude Code)\n' }) });
		assert.deepEqual(runtime, { provider: 'claude', command: 'fake-claude', version: '9.9.9 (Claude Code)' });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('the budget is validated and a shared ledger at its limit stops every sample before any model call', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-budget-'));
	try {
		const file = path.join(root, 'cases.json');
		await writeFile(file, JSON.stringify([{ id: 'budget-1', family: 'budget', causeClass: 'budget', split: 'train', state: { observation: replay.observations[0], agent: { goal: replay.goal } }, expect: { good: [{ tool: 'moveTo' }] } }]));
		for (const bad of ['0', '-1', 'abc']) assert.equal((await run(['--cases', file, `--budget-usd=${bad}`, '--dry-run'])).code, 2, bad);
		const ledger = path.join(root, 'ledger.tsv');
		await writeFile(ledger, '0.6\tother-arm#0\n0.5\tother-stage#1\n');
		const out = path.join(root, 'run.json');
		const result = await run(['--cases', file, '--samples', '2', '--budget-usd', '1', '--budget-ledger', ledger, '--root', path.join(root, 'rt'), '--out', out]);
		assert.equal(result.code, 0, result.stderr);
		const written = JSON.parse(await readFile(out, 'utf8'));
		assert.deepEqual(written.results.map((row) => row.error?.code), ['BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED']);
		assert.match(written.results[0].error.message, /spent 1\.1000 of 1 USD/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('an older cache is imported only where build, prefix, wake, profile and runtime provably match', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-import-'));
	try {
		const file = path.join(root, 'cases.json');
		const cases = ['imp-1', 'imp-2'].map((id) => ({ id, family: 'imp', causeClass: 'imp', split: 'train', state: { observation: replay.observations[0], agent: { goal: replay.goal } }, expect: { good: [{ tool: 'moveTo' }] } }));
		await writeFile(file, JSON.stringify(cases));
		const fake = path.join(root, 'fake.mjs');
		await writeFile(fake, "export async function answer() { return { calls: [{ name: 'moveTo', args: { x: 1, y: 64, z: 1 } }] }; }");
		const env = { ...process.env, DECISION_EVAL_FAKE_PROVIDER: fake };
		const call = (args) => new Promise((resolve) => execFile(process.execPath, [cli, ...args], { timeout: 60_000, env }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
		const dry = path.join(root, 'dry.json');
		assert.equal((await call(['--cases', file, '--provider', 'fake', '--dry-run', '--out', dry])).code, 0);
		const written = JSON.parse(await readFile(dry, 'utf8'));
		const old = path.join(root, 'old-cache', 'oldkey');
		const { mkdir } = await import('node:fs/promises');
		await mkdir(old, { recursive: true });
		const row = (caseId, sample, rendered) => ({ schemaVersion: 1, kind: 'decision-eval-sample', caseId, sample, provider: 'fake', model: 'claude-opus-5-5', effort: 'low', viewIdMode: 'option',
			build: { commit: written.build.commit, dirty: false }, rendered, calls: [], stop: 'turn_end', error: null, usage: { costUsd: 0.05 } });
		const good = { prefixSha256: written.renders['imp-1'] && written.build.prefixSha256, encodedSha256: written.renders['imp-1'].encodedSha256, sentMatches: true };
		await writeFile(path.join(old, 'imp-1-0000.jsonl'), `${JSON.stringify(row('imp-1', 0, good))}\n`);
		// Same case, but a different wake: must not be imported.
		await writeFile(path.join(old, 'imp-2-0000.jsonl'), `${JSON.stringify(row('imp-2', 0, { ...good, encodedSha256: 'f'.repeat(64) }))}\n`);
		const report = async (extra) => JSON.parse((await call(['--cases', file, '--provider', 'fake', '--samples', '1', '--cache-dir', path.join(root, 'cache'), '--import-cache', path.join(root, 'old-cache'), '--cache-report', ...extra])).stdout.trim().split('\n').pop());
		if (written.build.dirty) {
			assert.equal((await report(['--import-runtime', 'fake'])).cached, 0, 'a dirty build never imports: its old samples may come from other code');
			return;
		}
		assert.deepEqual([(await report([])).cached], [0], 'without --import-runtime nothing is imported');
		assert.deepEqual([(await report(['--import-runtime', 'wrong'])).cached], [0]);
		const imported = await report(['--import-runtime', 'fake']);
		assert.deepEqual([imported.cached, imported.missing], [1, 1], 'imp-1 matches; imp-2 has a different wake');
	} finally { await rm(root, { recursive: true, force: true }); }
});
