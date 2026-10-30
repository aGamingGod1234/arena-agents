import assert from 'node:assert/strict';
import test from 'node:test';
import { requestCaptureShutdown, watchCaptureShutdown } from '../src/capture-shutdown.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('headless close acknowledgement waits for the final turn and capture queue', async () => {
	let finish;
	const pending = new Promise(resolve => { finish = resolve; });
	const events = [];
	const dispose = watchCaptureShutdown('shutdown.json', async () => {
		events.push('stop'); await pending; events.push('capture-closed');
	}, { intervalMs: 1, read: async () => '{}', write: async (file, text) => { events.push([file, JSON.parse(text).status]); } });
	try {
		for (let n = 0; n < 100 && events.length === 0; n++) await tick();
		assert.deepEqual(events, ['stop']);
		finish();
		for (let n = 0; n < 100 && events.length < 3; n++) await tick();
		assert.deepEqual(events, ['stop', 'capture-closed', ['shutdown.json.closed', 'CLOSED']]);
	} finally { finish(); dispose(); }
});

test('capture close failure is reported to the owner', async () => {
	let status;
	const dispose = watchCaptureShutdown('shutdown.json', async () => { throw new Error('write failed'); }, {
		intervalMs: 1, read: async () => '{}', write: async (_, text) => { status = JSON.parse(text); },
	});
	try {
		for (let n = 0; n < 100 && !status; n++) await tick();
		assert.equal(status.status, 'FAILED');
		assert.equal(status.error, 'write failed');
	} finally { dispose(); }
});

test('hard-stop escalation waits for capture close and reports timeout before force cleanup', async () => {
	const events = []; let now = 0;
	const options = { timeoutMs: 100, now: () => now, wait: async ms => { now += ms; },
		write: async () => { events.push('requested'); }, read: async () => {
			if (now < 50) throw Object.assign(new Error('pending'), { code: 'ENOENT' });
			events.push('closed'); return '{"status":"CLOSED"}';
		} };
	await requestCaptureShutdown('capture', options);
	assert.deepEqual(events, ['requested', 'closed']);
	now = 0;
	await assert.rejects(requestCaptureShutdown('capture', { ...options, read: async () => { throw Object.assign(new Error('pending'), { code: 'ENOENT' }); } }), /timed out/);
	assert.equal(now, 100);
});

test('the real headless runner exits a stopped evaluator attempt through normal report and cleanup', async () => {
	const { normalizeHeadlessScenario, runHeadlessScenario } = await import('../src/headless-matrix.mjs');
	const commands = [], writes = [];
	let closed = false;
	const scenario = normalizeHeadlessScenario({ id: 'capture-end', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', task: 'Reach the target', timeoutMs: 1000,
		qualitySetup: { dimension: 'minecraft:overworld', position: [0, 201, 0], commands: [] }, assert: [{ type: 'rcon', command: 'data get entity {agent} Pos', match: 'OK' }] });
	const report = await runHeadlessScenario({ scenario, runDirectory: '/tmp/arena-capture-runner-fixture', now: () => 100,
		readFile: async file => String(file).endsWith('quality-stop.json') ? '{"reason":"EVALUATOR_PASS"}' : '',
		fileSize: async () => 0, writeFile: async (file, text) => { writes.push([String(file), text]); }, poll: async () => {},
		rcon: { close: async () => { closed = true; }, command: async command => {
			commands.push(command);
			return { text: command.includes('summon-configured') ? 'Created capture-end-agent. It is ready for a task.' : 'OK' };
		} },
	});
	assert.equal(report.classification, 'EVALUATOR_STOP', report.diagnostics);
	assert.equal(report.cleanup.status, 'CLEAN');
	assert.equal(closed, true);
	assert.ok(commands.some(command => command.startsWith('codex remove ')));
	assert.ok(writes.some(([file]) => file.endsWith('report.json')));
});

test('headless owner and coordinator exchange a complete close acknowledgement on disk', async () => {
	const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const path = await import('node:path');
	const dir = await mkdtemp(path.join(tmpdir(), 'capture-close-'));
	const request = path.join(dir, 'capture-shutdown.json');
	let captured = false;
	const dispose = watchCaptureShutdown(request, async () => { await tick(); captured = true; }, { intervalMs: 1 });
	try {
		const acknowledgement = await requestCaptureShutdown(request, { timeoutMs: 1000 });
		assert.equal(captured, true);
		assert.equal(acknowledgement.status, 'CLOSED');
		assert.equal(JSON.parse(await readFile(`${request}.closed`, 'utf8')).status, 'CLOSED');
		assert.ok(!(await readdir(dir)).some(file => file.endsWith('.tmp')));
	} finally { dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('slow shutdown request reads cannot start concurrent capture closes', async () => {
	let closeCount = 0, writeCount = 0;
	const dispose = watchCaptureShutdown('capture', async () => { closeCount++; await tick(); }, {
		intervalMs: 1, read: async () => { await tick(); return '{}'; }, write: async () => { writeCount++; },
	});
	try {
		for (let n = 0; n < 100 && !writeCount; n++) await tick();
		assert.equal(closeCount, 1);
		assert.equal(writeCount, 1);
	} finally { dispose(); }
});
