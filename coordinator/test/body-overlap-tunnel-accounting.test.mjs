import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

for (const thinkingMs of [100, 4000, 30000]) {
	test(`tunnel benchmark accounts for completed and cancelled work at ${thinkingMs}ms thinking`, () => {
		const output = execFileSync(process.execPath, [...process.execArgv,
			new URL('../src/benchmark/body-overlap-benchmark.mjs', import.meta.url).pathname, String(thinkingMs)], { encoding: 'utf8' });
		const result = JSON.parse(output);
		const { serial, keepGoing } = result.workloads.tunnel.accounting;
		assert.equal(serial.dispatches.length, 6);
		assert.ok(serial.dispatches.every((row) => row.state === 'SUCCEEDED' && row.actionType === 'dig_to'));
		assert.deepEqual(keepGoing.dispatches.map(({ actionType, state }) => [actionType, state]), [
			...Array.from({ length: 6 }, () => ['dig_to', 'SUCCEEDED']),
			['dig_to', 'CANCELLED'], ['look_at', 'SUCCEEDED'],
		]);
		assert.deepEqual(keepGoing.dispatches.filter((row) => row.actionType === 'dig_to' && row.state === 'SUCCEEDED')
			.map(({ actionType, arguments: args }) => ({ actionType, arguments: args })),
		serial.dispatches.map(({ actionType, arguments: args }) => ({ actionType, arguments: args })));
		assert.equal(serial.completedDigMs, 72000);
		assert.equal(keepGoing.completedDigMs, 72000);
		assert.equal(keepGoing.cancelledDigMs, 50);
		const cancelled = keepGoing.dispatches.find((row) => row.state === 'CANCELLED');
		assert.equal(cancelled.finishedAtMs - cancelled.startedAtMs, keepGoing.cancelledDigMs);
		assert.equal(keepGoing.completedAtMs, thinkingMs + 72000);
		assert.equal(keepGoing.stopFinishedAtMs, keepGoing.completedAtMs + 100);
		assert.equal(result.comparisons.openTunnel.overlappedMs, keepGoing.completedAtMs);
		assert.match(result.correctness, /completed tunnel work/);
		assert.match(result.correctness, /cancelled speculative/);
		assert.doesNotMatch(result.correctness, /each overlapped strategy dispatched exactly/);
	});
}
