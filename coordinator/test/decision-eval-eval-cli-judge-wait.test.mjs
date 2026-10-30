import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// eval.mjs with an explicit free OpenCode judge whose usage limit is reached at first: the ungraded answers are graded
// again after a wait instead of leaving the run INCONCLUSIVE. A fake `opencode` on PATH stands in for the judge.
const evalCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'decision-eval', 'eval.mjs');
const replay = JSON.parse(await readFile(new URL('./fixtures/decision-eval/g1-replay-sample.json', import.meta.url), 'utf8'));
const cases = ['a', 'b', 'c'].flatMap((family) => Array.from({ length: 4 }, (_, i) => ({
	id: `${family}${i}`, family: `fam-${family}`, causeClass: 'test', split: 'train',
	state: { observation: replay.observations[0], agent: { goal: replay.goal, goalSpec: replay.goalSpec } },
	expect: { judge: { rubric: 'Moving somewhere is good.' } },
})));
const PLAYER = `export async function answer() { return { calls: [{ name: 'moveTo', args: { x: 1, y: 64, z: 1 } }] }; }\n`;
// A fake `opencode serve`: refuses every judge prompt for the first two seconds after its first one (a provider retry
// status naming the exhausted allowance, as the free tier reports once it is spent), then grades every answer good.
const OPENCODE = `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const stamp = require('node:path').join(__dirname, 'first-call');
const streams = new Set();
const messages = new Map();
const send = (event) => { for (const response of streams) response.write('data: ' + JSON.stringify(event) + '\\n\\n'); };
let next = 0;
const server = http.createServer((request, response) => {
	let body = '';
	request.on('data', (chunk) => { body += chunk; }).on('end', () => {
		const url = new URL(request.url, 'http://127.0.0.1');
		const json = (value) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
		if (url.pathname === '/event') { response.writeHead(200, { 'content-type': 'text/event-stream' }); streams.add(response); response.on('close', () => streams.delete(response)); return; }
		if (request.method === 'POST' && url.pathname === '/session') return json({ id: 'ses_' + (next += 1) });
		const message = /^\\/session\\/([^/]+)\\/message$/.exec(url.pathname);
		if (request.method === 'POST' && message) {
			if (!fs.existsSync(stamp)) fs.writeFileSync(stamp, String(Date.now()));
			if (Date.now() - Number(fs.readFileSync(stamp, 'utf8')) < 2000) {
				setTimeout(() => send({ type: 'session.status', properties: { sessionID: message[1], status: { type: 'retry', attempt: 1, message: 'Free usage limit reached. Subscribe to keep going' } } }), 100);
				return;
			}
			const input = JSON.parse(body).parts[0].text;
			const ids = [...input.slice(input.indexOf('ANSWERS_JSON')).matchAll(/"id":"(A\\d+)"/g)].map((match) => match[1]);
			const text = JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: 'good', rationale: 'moves' })) });
			const reply = { info: { role: 'assistant' }, parts: [{ type: 'step-start' }, { type: 'text', text }, { type: 'step-finish', tokens: { input: 10, output: 5 }, cost: 0 }] };
			messages.set(message[1], reply);
			return json(reply);
		}
		if (request.method === 'GET' && message) return json(messages.has(message[1]) ? [messages.get(message[1])] : []);
		json(true);
	});
});
server.listen(0, '127.0.0.1', () => process.stdout.write('opencode server listening on http://127.0.0.1:' + server.address().port + '\\n'));
process.on('SIGTERM', () => process.exit(0));
`;
test('a free judge usage limit is waited out and the ungraded answers are graded again', { skip: process.platform === 'win32' && 'needs an executable script on PATH', timeout: 240_000 }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'decision-eval-judge-wait-'));
	try {
		const bin = path.join(root, 'bin');
		await mkdir(bin);
		await writeFile(path.join(bin, 'opencode'), OPENCODE);
		await chmod(path.join(bin, 'opencode'), 0o755);
		await writeFile(path.join(root, 'cases.json'), JSON.stringify(cases));
		await writeFile(path.join(root, 'fake.mjs'), PLAYER);
		const out = path.join(root, 'out');
		const code = await new Promise((resolve) => execFile(process.execPath, [evalCli, '--baseline', '.', '--cases', path.join(root, 'cases.json'), '--provider', 'fake',
			'--judge-provider', 'opencode', '--judge-model', 'opencode/glm-5.3-flash-free', '--judge-wait-minutes', '0.05', '--samples', '2', '--concurrency', '8',
			'--out', out, '--cache-dir', path.join(root, 'cache'), '--no-confirm', '--spot-check', '0'],
		{ timeout: 200_000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DECISION_EVAL_FAKE_PROVIDER: path.join(root, 'fake.mjs') } },
		(error) => resolve(error?.code ?? 0)));
		const log = await readFile(path.join(out, 'eval.log'), 'utf8').catch(() => '');
		assert.equal(code, 0, log.slice(-3000));
		assert.match(log, /answers ungraded \(judge free usage limit reached\); waiting 0\.05 min, then grading again \(1\/18\)/);
		const summary = JSON.parse(await readFile(path.join(out, 'eval.json'), 'utf8'));
		assert.equal(summary.verdict, 'PASS');
		assert.equal(summary.coverage.ungraded, 0);
		const report = JSON.parse(await readFile(path.join(out, 'screen', 'report.json'), 'utf8'));
		assert.equal(report.judge.config.provider, 'opencode');
		assert.equal(report.judge.config.model, 'opencode/glm-5.3-flash-free');
	} finally { await rm(root, { recursive: true, force: true }); }
});
