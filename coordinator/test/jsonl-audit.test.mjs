import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { createJsonlAudit } from '../src/dynamic-main.mjs';

test('protocol audit owns hung writes without delaying control and bounds close', async () => {
	const audit = createJsonlAudit('protocol.jsonl', { runId: 'run' }, {
		mkdir: async () => {}, appendFile: () => new Promise(() => {}),
		maxPending: 2, operationTimeoutMs: 20, closeTimeoutMs: 30,
	});
	for (let index = 0; index < 100; index += 1) await audit('out', { sequence: index });
	assert.ok(audit.statusSnapshot().droppedCount > 0);
	const first = audit.close();
	assert.strictEqual(audit.close(), first);
	await first;
});

test('protocol audit uses shared redaction and survives rejected writes', async () => {
	const rows = [];
	let calls = 0;
	const audit = createJsonlAudit('protocol.jsonl', { authorization: 'Bearer metadata-secret' }, {
		mkdir: async () => {},
		appendFile: async (_path, text) => {
			calls += 1;
			if (calls === 1) throw new Error('temporary failure');
			rows.push(JSON.parse(text));
		},
	});
	await audit('out', { password: 'payload-secret', path: 'C:\\Users\\player\\secret.json' });
	await audit('out', { ok: true });
	// The first write was rejected, so persist a second sensitive envelope that does reach storage.
	await audit('out', { password: 'stored-payload-secret', path: 'C:\\Users\\player\\stored.json' });
	await audit.close();
	assert.equal(rows.length, 2);
	assert.deepEqual(rows[0].envelope, { ok: true });
	assert.equal(rows[1].envelope.password, '[REDACTED]');
	assert.equal(JSON.stringify(rows[1].envelope).includes('stored-payload-secret'), false);
	assert.equal(JSON.stringify(rows[1].envelope).includes('lucas'), false);
	assert.equal(JSON.stringify(rows).includes('metadata-secret'), false);
	assert.equal(JSON.stringify(rows).includes('lucas'), false);
	assert.equal(audit.statusSnapshot().state, 'ready');
	assert.equal(audit.statusSnapshot().failedOperationCount, 1);
	assert.equal(audit.statusSnapshot().incompleteCapture, true);
});

test('audit directory failure cannot escape through Node unhandled-rejection policy', () => {
	const moduleUrl = new URL('../src/dynamic-main.mjs', import.meta.url).href;
	for (const immediateWrite of [false, true]) {
		const source = `
			import assert from 'node:assert/strict';
			import { createJsonlAudit } from ${JSON.stringify(moduleUrl)};
			const audit = createJsonlAudit('unused.jsonl', {}, {
				mkdir: async () => { throw new Error('directory unavailable'); },
				appendFile: async () => assert.fail('cannot write before directory preparation'),
			});
			if (${immediateWrite}) await audit('out', { sequence: 1 });
			await new Promise(setImmediate);
			await audit.close();
			assert.equal(audit.statusSnapshot().state, 'degraded');
			assert.equal(audit.statusSnapshot().incompleteCapture, true);
		`;
		const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', source], { encoding: 'utf8' });
		assert.equal(child.status, 0, child.stderr || child.stdout);
	}
});

test('audit directory synchronous throws are contained without losing healthy first-row admission', async () => {
	const failed = createJsonlAudit('unused.jsonl', {}, { mkdir: () => { throw new Error('directory unavailable'); } });
	await new Promise(setImmediate);
	await failed.close();
	assert.equal(failed.statusSnapshot().state, 'degraded');
	let writes = 0;
	const healthy = createJsonlAudit('unused.jsonl', {}, {
		maxPending: 1, mkdir: async () => {}, appendFile: async () => { writes += 1; },
	});
	await healthy('out', { sequence: 1 });
	await healthy.close();
	assert.equal(writes, 1);
	assert.equal(healthy.statusSnapshot().incompleteCapture, false);
});

test('protocol audit retries handshake rows that hit a busy sink instead of dropping them', async () => {
	const rows = [];
	let calls = 0;
	const audit = createJsonlAudit('protocol.jsonl', { runId: 'run' }, {
		mkdir: async () => {}, criticalRetryDelayMs: 1,
		appendFile: async (_path, text) => {
			calls += 1;
			if (calls <= 3) throw new Error('append still in progress');
			rows.push(JSON.parse(text));
		},
	});
	await audit('server_to_coordinator', { type: 'hello_ack', payload: { authenticated: true } });
	await audit.close();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].envelope.type, 'hello_ack');
});

test('handshake registration and goal lifecycle survive a timed-out append and a full diagnostic queue', async () => {
	const rows = [];
	let release;
	const audit = createJsonlAudit('protocol.jsonl', {}, {
		mkdir: async () => {}, maxPending: 1, operationTimeoutMs: 5,
		appendFile: async (_path, text) => {
			if (rows.length === 0) await new Promise((resolve) => { release = resolve; });
			rows.push(JSON.parse(text));
		},
	});
	await audit('out', { type: 'heartbeat' });
	while (release === undefined) await new Promise(setImmediate);
	for (let i = 0; i < 10; i += 1) await audit('out', { type: 'heartbeat' });
	const critical = ['hello', 'hello_ack', 'registry_entry', 'registry_complete', 'agent_registered', 'goal_control'];
	for (const type of critical) await audit('server_to_coordinator', { type });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(rows.length, 0, 'critical writes wait for exclusive sink ownership');
	release();
	await audit.close();
	assert.deepEqual(rows.slice(1).map((row) => row.envelope.type), critical);
	assert.ok(audit.statusSnapshot().droppedCount > 0, 'ordinary diagnostics still respect backpressure');
});

test('a permanently hung critical append cannot block shutdown and reports incomplete capture', async () => {
	const audit = createJsonlAudit('protocol.jsonl', {}, {
		mkdir: async () => {}, closeTimeoutMs: 20, appendFile: () => new Promise(() => {}),
	});
	await audit('server_to_coordinator', { type: 'hello_ack' });
	await audit.close();
	assert.equal(audit.statusSnapshot().incompleteCapture, true);
});
