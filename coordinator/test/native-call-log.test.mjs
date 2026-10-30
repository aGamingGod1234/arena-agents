import assert from 'node:assert/strict';
import test from 'node:test';

test('reasoning summaries are captured per call and in the snapshot', async () => {
	const { NativeCallLog } = await import('../src/native-call-log.mjs');
	const log = new NativeCallLog();
	log.input('turn', 'danger');
	log.reasoningDelta('r1', 'thinking ');
	log.reasoningDelta('r1', 'hard');
	log.reasoning('thinking hard', 'r1');
	log.reasoningDelta('r2', 'unfinished');
	const snapshot = log.snapshot();
	assert.equal(snapshot.calls[0].reasoning, 'thinking hard\nunfinished');
	assert.equal(snapshot.reasoning, 'thinking hard\nunfinished');
});

test('streamed messages stay with their call across steers and completion replaces deltas', async () => {
	const { NativeCallLog } = await import('../src/native-call-log.mjs');
	const log = new NativeCallLog();
	log.input('turn', 'danger');
	log.outputDelta('m1', 'partial');
	log.input('steer', 'urgent');
	log.output('final', null, 'm1');
	log.outputDelta('m2', 'unfinished');
	assert.deepEqual(log.snapshot().calls.map((call) => call.output), ['final', 'unfinished']);
	assert.equal(log.snapshot().output, 'final\nunfinished');
});

test('usage-only replies, bounded streams and final items survive snapshots', async () => {
	const { NativeCallLog } = await import('../src/native-call-log.mjs');
	const log = new NativeCallLog();
	log.input('turn', 'danger');
	log.usage({ input: 200, output: 1 });
	assert.equal(log.snapshot().calls[0].usage.output, 1);
	log.outputDelta('m1', 'x'.repeat(100_000));
	const item = { id: 'm1', type: 'agentMessage', text: 'final' };
	log.finalItem(item);
	log.finalItem(item);
	const snapshot = log.snapshot();
	assert.ok(snapshot.output.length < 33_000);
	assert.match(snapshot.output, /truncated stream/);
	assert.equal(snapshot.finalItems.length, 1);
	assert.deepEqual(JSON.parse(snapshot.finalItems[0].content), item);
});
