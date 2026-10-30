import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { replayPort, abortReplayBoot } from '../../scripts/quality/watch-replay.mjs';

test('replay server triples stay unique inside their live slot before reuse', () => {
	const used = new Set();
	for (let index = 0; index < 25; index++) {
		const base = replayPort(28000, index);
		for (const port of [base, base + 1, base + 2]) {
			assert.ok(port >= 28000 && port < 28100);
			assert.ok(!used.has(port));
			used.add(port);
		}
	}
	assert.equal(replayPort(28000, 25), 28000);
});

test('a failed replay start kills its real child and closes its resources', async () => {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
	await once(child, 'spawn');
	const closed = [];
	try {
		await abortReplayBoot({ child, bridge: { stop() { closed.push('bridge'); } },
			rcon: { async close() { closed.push('rcon'); } }, log: { async close() { closed.push('log'); } } });
		assert.equal(child.signalCode, 'SIGKILL');
		assert.deepEqual(closed, ['bridge', 'rcon', 'log']);
	} finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
