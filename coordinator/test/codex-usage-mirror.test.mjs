import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexStdioTransport } from '../src/codex-app-server.mjs';
import { codexUsageMirrorEnabled, codexUsageMirrorHome, CodexUsageMirror, mirrorCodexExecUsage } from '../src/codex-usage-mirror.mjs';
import { parseCodexRollout } from './t3-codex-usage-parser.mjs';

class FakeAppServer extends EventEmitter {
	constructor() {
		super();
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		this.stdin = new EventEmitter();
		this.killed = false;
		this.pid = 4242;
		this.turn = 0;
		this.stdin.write = (line) => this.#reply(JSON.parse(String(line)));
	}

	kill() { this.killed = true; queueMicrotask(() => this.emit('exit', 0, null)); return true; }

	send(message) { this.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)); }

	usage(threadId, turnId, last, total) {
		this.send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last, total, modelContextWindow: 400_000 } } });
	}

	#reply({ id, method, params }) {
		if (method === 'thread/start') {
			const threadId = params.ephemeral ? `thread-e${this.threads = (this.threads ?? 0) + 1}` : 'thread-n';
			queueMicrotask(() => this.send({ id, result: { thread: { id: threadId }, model: params.model, serviceTier: params.serviceTier } }));
		} else if (method === 'turn/start') {
			this.turn += 1;
			queueMicrotask(() => this.send({ id, result: { turn: { id: `turn-${this.turn}`, status: 'inProgress', items: [] } } }));
		} else if (id !== undefined) queueMicrotask(() => this.send({ id, result: {} }));
	}
}

const usage = (input, cached, output, reasoning) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output });

function rolloutFiles(home) {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const child = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(child);
			else files.push(child);
		}
	};
	try { walk(path.join(home, 'sessions')); } catch { /* no sessions written */ }
	return files;
}

test('every ephemeral thread of a process lands in one rollout that T3 parses with exact totals', async (t) => {
	const home = mkdtempSync(path.join(tmpdir(), 'aa-usage-mirror-'));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const mirror = new CodexUsageMirror({ home, now: () => new Date('2026-10-26T12:00:00.000Z') });
	const child = new FakeAppServer();
	const transport = new CodexStdioTransport({ model: 'gpt-6-luna', reasoningEffort: 'low', serviceTier: 'default' }, { spawn: () => child, usageMirror: mirror, stopTimeoutMs: 1 });
	await transport.start();
	const secret = 'PROMPT-SECRET-diamond-at-12-34';
	await transport.request('thread/start', { model: 'gpt-6-luna', serviceTier: 'default', ephemeral: true, baseInstructions: secret });
	await transport.request('thread/start', { model: 'gpt-6.1-sol', serviceTier: 'default', ephemeral: true, baseInstructions: secret });
	await transport.request('thread/start', { model: 'gpt-6-luna', serviceTier: 'default', ephemeral: false });
	const turn = (threadId, model) => transport.request('turn/start', { threadId, model, serviceTier: 'default', input: [{ type: 'text', text: secret }] });
	await turn('thread-e1', 'gpt-6-luna');
	await turn('thread-e2', 'gpt-6.1-sol');
	// Interleaved calls from two threads, each with Codex's own per-thread cumulative total.
	child.usage('thread-e1', 'turn-1', usage(1000, 800, 50, 30), usage(1000, 800, 50, 30));
	child.usage('thread-e2', 'turn-2', usage(2000, 0, 10, 5), usage(2000, 0, 10, 5));
	child.usage('thread-e1', 'turn-1', usage(1000, 800, 50, 30), usage(1000, 800, 50, 30));
	child.usage('thread-e1', 'turn-1', usage(0, 0, 0, 0), usage(1000, 800, 50, 30));
	child.usage('thread-n', 'turn-x', usage(999, 0, 9, 0), usage(999, 0, 9, 0));
	child.usage('thread-e1', 'turn-1', usage(1200, 1000, 70, 40), usage(2200, 1800, 120, 70));
	child.usage('thread-e2', 'turn-2', usage(2100, 1900, 20, 0), usage(4100, 1900, 30, 5));
	await turn('thread-e1', 'gpt-6-luna');
	child.usage('thread-e1', 'turn-3', usage(1300, 1200, 20, 0), usage(3500, 3000, 140, 70));
	await transport.request('turn/start', { threadId: 'thread-e2', model: 'gpt-6.1-sol', serviceTier: 'priority', input: [] });
	child.usage('thread-e2', 'turn-4', usage(500, 400, 5, 0), usage(4600, 2300, 35, 5));
	await mirrorCodexExecUsage({ model: 'gpt-6-luna', usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 60, reasoning_output_tokens: 20 } }, mirror);
	await mirror.flush();
	await transport.stop();

	const files = rolloutFiles(home);
	assert.equal(files.length, 1, 'one file for the process');
	assert.match(path.relative(home, files[0]), /^sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/);
	const text = readFileSync(files[0], 'utf8');
	assert.equal(text.includes(secret), false);
	const kinds = text.trim().split('\n').map((line) => JSON.parse(line)).map((row) => row.payload.type ?? row.type);
	assert.deepEqual(kinds, ['session_meta', 'thread_settings_applied', 'turn_context', 'token_count', 'turn_context', 'token_count',
		'turn_context', 'token_count', 'turn_context', 'token_count', 'turn_context', 'token_count',
		'thread_settings_applied', 'turn_context', 'token_count', 'thread_settings_applied', 'turn_context', 'token_count']);
	const parsed = parseCodexRollout(text);
	assert.equal(parsed.malformed, 0);
	assert.deepEqual(parsed.records.map((record) => [record.model, record.speed]), [
		['gpt-6-luna', 'standard'], ['gpt-6.1-sol', 'standard'], ['gpt-6-luna', 'standard'], ['gpt-6.1-sol', 'standard'],
		['gpt-6-luna', 'standard'], ['gpt-6.1-sol', 'fast'], ['gpt-6-luna', 'standard']]);
	// Codex's final per-thread totals: e1 3500/3000/140, e2 4600/2300/35, plus the judge's 400/100/60.
	assert.deepEqual(parsed.totals, { uncachedInput: (3500 - 3000) + (4600 - 2300) + 300, cachedInput: 3000 + 2300 + 100, output: 140 + 35 + 60, reasoning: 70 + 5 + 20 });
});

test('the process file rotates on size and on a new local day, each with its own session', async (t) => {
	const home = mkdtempSync(path.join(tmpdir(), 'aa-usage-mirror-'));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	let clock = new Date(2026, 9, 26, 23, 59, 0);
	const mirror = new CodexUsageMirror({ home, now: () => clock, rotateBytes: 1500 });
	mirror.startThread({ threadId: 'a', model: 'gpt-6-luna', serviceTier: 'default' });
	for (let call = 0; call < 6; call++) mirror.usage({ threadId: 'a', turnId: 'turn-a', last: usage(100 + call, 10, 5, 0) });
	clock = new Date(2026, 9, 27, 0, 0, 30);
	mirror.usage({ threadId: 'a', turnId: 'turn-a', last: usage(100, 10, 5, 0) });
	await mirror.flush();
	const files = rolloutFiles(home).sort();
	assert.deepEqual(files.sort(), mirror.files.sort());
	assert.ok(files.length >= 3, `size and day rotation, got ${files.length}`);
	assert.ok(files.some((file) => file.includes(`${path.sep}27${path.sep}`)));
	let input = 0;
	const sessions = new Set();
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		sessions.add(JSON.parse(text.split('\n')[0]).payload.id);
		const parsed = parseCodexRollout(text);
		assert.equal(parsed.malformed, 0);
		assert.ok(parsed.records.every((record) => record.model === 'gpt-6-luna'));
		input += parsed.totals.uncachedInput + parsed.totals.cachedInput;
	}
	assert.equal(sessions.size, files.length);
	assert.equal(input, 100 + 101 + 102 + 103 + 104 + 105 + 100);
});

test('mirror writes are best-effort and the switch turns them off', async (t) => {
	assert.equal(codexUsageMirrorEnabled({}), true);
	assert.equal(codexUsageMirrorEnabled({ AA_CODEX_USAGE_MIRROR: '0' }), false);
	assert.equal(codexUsageMirrorEnabled({ NODE_TEST_CONTEXT: 'child-v8' }), false);
	assert.equal(codexUsageMirrorEnabled({ NODE_TEST_CONTEXT: 'child-v8', AA_CODEX_USAGE_MIRROR: '1' }), true);
	assert.equal(codexUsageMirrorHome({ AA_CODEX_USAGE_HOME: '/x/y' }), '/x/y');

	const root = mkdtempSync(path.join(tmpdir(), 'aa-usage-mirror-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(path.join(root, 'not-a-dir'), '');
	const mirror = new CodexUsageMirror({ home: path.join(root, 'not-a-dir') });
	mirror.startThread({ threadId: 't', model: 'gpt-6-luna', serviceTier: 'default' });
	await mirror.usage({ threadId: 't', last: usage(10, 0, 5, 0) });
	assert.equal(mirror.usage({ threadId: 't', last: usage(11, 0, 5, 0) }), undefined, 'a failed mirror stops writing');
	await mirrorCodexExecUsage({ model: 'gpt-6-luna', usage: null }, mirror);
});
