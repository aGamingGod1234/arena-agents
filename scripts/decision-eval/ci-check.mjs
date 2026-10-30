#!/usr/bin/env node
// Decision-eval check for a pull request: baseline = the PR base, candidate = the PR head.
//
//   node scripts/decision-eval/ci-check.mjs (--pr <number> | --base <ref> --head <ref>) [--post-status]
//        [--status-context decision-eval] [--fetch] [--keep-worktree] [any scripts/decision-eval/eval.mjs option]
//
// The PR head is checked out into a temporary worktree (with its own npm ci) and its own eval.mjs runs there, so the
// harness and cases the PR carries judge both builds; eval.mjs checks the base out the same way with that harness.
// --pr reads base and head commits with `gh pr view` (read only). --fetch fetches missing commits from origin.
// --post-status (off by default) sets a commit status on the head through `gh api` with the verdict; it needs a gh
// login allowed to write statuses. Nothing else is written to GitHub. Exit code: eval.mjs's (0 PASS, 1 FAIL, 2 error).
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWN_FLAGS = new Set(['--pr', '--base', '--head', '--status-context']);
const OWN_SWITCHES = new Set(['--post-status', '--fetch', '--keep-worktree']);

const argv = process.argv.slice(2);
const own = {};
const forward = [];
for (let index = 0; index < argv.length; index += 1) {
	if (OWN_SWITCHES.has(argv[index])) own[argv[index].slice(2)] = true;
	else if (OWN_FLAGS.has(argv[index])) own[argv[index].slice(2)] = argv[++index];
	// eval.mjs runs inside the temporary worktree, so paths the caller gives are made absolute here.
	else if (['--out', '--cache-dir', '--cases'].includes(argv[index]) && argv[index + 1] !== undefined) forward.push(argv[index], path.resolve(argv[++index]));
	else forward.push(argv[index]);
}
if (argv.includes('--help') || (!own.pr && !(own.base && own.head))) {
	process.stderr.write(`${(await readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n').slice(1, 11).map((line) => line.replace(/^\/\/ ?/, '')).join('\n')}\n`);
	process.exit(argv.includes('--help') ? 0 : 2);
}
const context = own['status-context'] ?? 'decision-eval';
const git = async (...gitArgs) => (await execFileAsync('git', gitArgs, { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
const gh = async (...ghArgs) => (await execFileAsync('gh', ghArgs, { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

async function commitOf(ref) {
	try { return await git('rev-parse', '--verify', `${ref}^{commit}`); } catch { /* maybe not fetched yet */ }
	if (!own.fetch) throw new Error(`${ref} is not in this clone; fetch it or pass --fetch`);
	await git('fetch', '--no-tags', 'origin', ref);
	return git('rev-parse', '--verify', `${ref}^{commit}`).catch(() => git('rev-parse', '--verify', 'FETCH_HEAD^{commit}'));
}

async function postStatus(sha, state, description) {
	if (!own['post-status']) return;
	const repo = JSON.parse(await gh('repo', 'view', '--json', 'nameWithOwner')).nameWithOwner;
	await gh('api', '--method', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description.slice(0, 140)}`);
	process.stderr.write(`ci-check: posted ${state} status "${context}" on ${sha.slice(0, 12)}\n`);
}

let base;
let head;
if (own.pr) {
	const pr = JSON.parse(await gh('pr', 'view', own.pr, '--json', 'baseRefOid,headRefOid,number'));
	base = await commitOf(pr.baseRefOid);
	head = await commitOf(pr.headRefOid);
} else {
	base = await commitOf(own.base);
	head = await commitOf(own.head);
}
process.stderr.write(`ci-check: base ${base.slice(0, 12)}, head ${head.slice(0, 12)}\n`);

const worktree = path.join(os.tmpdir(), 'arena-decision-eval', 'worktrees', `pr-head-${head.slice(0, 10)}-${randomBytes(3).toString('hex')}`);
await mkdir(path.dirname(worktree), { recursive: true });
await git('worktree', 'add', '--detach', worktree, head);
let code = 2;
try {
	if (!existsSync(path.join(worktree, 'scripts', 'decision-eval', 'eval.mjs'))) throw new Error('the PR head has no decision-eval harness (scripts/decision-eval/eval.mjs)');
	await new Promise((resolve, reject) => {
		const child = spawn('npm ci --ignore-scripts --omit=dev --no-audit --no-fund', { cwd: path.join(worktree, 'coordinator'), shell: true, stdio: 'inherit' });
		child.on('error', reject);
		child.on('close', (exit) => exit === 0 ? resolve() : reject(new Error(`npm ci failed in ${worktree}`)));
	});
	await postStatus(head, 'pending', 'decision eval running');
	const out = forward.includes('--out') ? null : path.join(os.tmpdir(), 'arena-decision-eval', `pr-${head.slice(0, 10)}-${Date.now().toString(36)}`);
	const evalArgs = [path.join(worktree, 'scripts', 'decision-eval', 'eval.mjs'), '--baseline', base, '--candidate', worktree, ...(out === null ? [] : ['--out', out]), ...forward];
	code = await new Promise((resolve) => {
		const child = spawn(process.execPath, evalArgs, { cwd: worktree, stdio: 'inherit' });
		child.on('close', (exit) => resolve(exit ?? 2));
	});
	const outDir = out ?? path.resolve(forward[forward.indexOf('--out') + 1]);
	let summary = null;
	// Only a deciding exit has a summary of this run (eval removes an older eval.json before it starts).
	if ([0, 1, 3].includes(code)) try { summary = JSON.parse(await readFile(path.join(outDir, 'eval.json'), 'utf8')); } catch { /* error exit */ }
	const description = summary === null ? 'decision eval could not run' : `${summary.verdict}: ${summary.families.filter((family) => (family.deltaPts ?? 0) < 0).length} families lower, $${summary.costUsd.total.toFixed(2)}, ${Math.round(summary.wallMs / 1000)} s`;
	await postStatus(head, code === 0 ? 'success' : code === 1 ? 'failure' : 'error', description);
} catch (error) {
	process.stderr.write(`ci-check: ${error.message}\n`);
	await postStatus(head, 'error', String(error.message)).catch(() => {});
	code = 2;
} finally {
	if (!own['keep-worktree']) await git('worktree', 'remove', '--force', worktree).catch((error) => process.stderr.write(`ci-check: could not remove ${worktree}: ${error.message}\n`));
}
process.exitCode = code;
