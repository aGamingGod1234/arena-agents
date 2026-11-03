import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { trackBenchmarkReflexes, stageBenchmarkTrial, SCENARIOS } from '../scripts/live-body-benchmark.mjs';

const source = await readFile(new URL('../scripts/live-body-benchmark.mjs', import.meta.url), 'utf8');
// Use the benchmark's real inbox, including its timeout and queued-message behavior.
const Inbox = vm.runInNewContext(`(${source.match(/class Inbox \{[\s\S]*?\n\}/)[0]})`, { setTimeout, clearTimeout });
const firing = (seq, id = 'default-retreat', outcome = 'done') => ({ seq, id, outcome });
function fixture() {
	const bridge = new EventEmitter();
	const inbox = new Inbox(bridge);
	const requests = [];
	bridge.send = async (...args) => { requests.push(args); };
	const history = trackBenchmarkReflexes({ bridge, inbox, record: { agentId: 'bench', goalRevision: 1 } });
	let sequence = 0;
	const observe = ({ revision = 1, events = [], ready = true, agentId = 'bench', hasStatus = true } = {}) => {
		const event = { type: 'observation', agentId, payload: { ready, eventSequence: ++sequence,
			...(hasStatus ? { reflexes: { revision, events } } : {}) } };
		// Match MultiplexedServerBridge dispatch order: typed event first, message second.
		bridge.emit('observation', event);
		bridge.emit('message', event);
	};
	history.begin(1);
	return { history, observe, requests, inbox };
}

test('last live completed events survive a dead observation; known death requests and waits for nothing', async () => {
	const f = fixture();
	const baseline = f.history.status();
	f.observe({ events: [firing(7)] });
	const seqBefore = Math.max(...(await baseline).events.map((event) => event.seq));
	f.observe({ events: [firing(7), firing(8)] });
	f.observe({ ready: false, hasStatus: false });
	const requestsBefore = f.requests.length;
	assert.equal(await f.history.status({ died: true }), null);
	assert.equal(f.requests.length, requestsBefore);
	assert.equal(f.inbox.waiters.length, 0);
	assert.deepEqual(f.history.firings(seqBefore), ['default-retreat:done']);
	assert.match(source, /await reflexHistory\.status\(\{ died \}\);\s*row\.firings = reflexHistory\.firings\(seqBefore\)/);
});

test('terminal events are retained, duplicates merge, and rolled-off live events stay recorded', async () => {
	const f = fixture();
	f.observe({ events: [firing(8)] });
	f.observe({ events: [firing(8), firing(9, 'default-air')] });
	const pending = f.history.status();
	f.observe({ ready: false, events: [firing(10, 'default-fire', 'timeout')] });
	assert.equal((await pending).events[0].seq, 10);
	assert.deepEqual(f.history.firings(7), ['default-retreat:done', 'default-air:done', 'default-fire:timeout']);
});

test('death during a final status request resolves on a non-ready observation without reflexes', async () => {
	const f = fixture();
	f.observe({ events: [firing(8)] });
	const pending = f.history.status();
	f.observe({ ready: false, hasStatus: false });
	assert.equal(await pending, null);
	assert.equal(f.inbox.waiters.length, 0);
	assert.deepEqual(f.history.firings(7), ['default-retreat:done']);
});

test('new trial excludes prior revision, other agents and cumulative pre-baseline history', async () => {
	const f = fixture();
	f.observe({ events: [firing(8)] });
	f.history.begin(2);
	assert.deepEqual(f.history.firings(0), []);
	const baseline = f.history.status();
	f.observe({ revision: 1, events: [firing(9)] });
	f.observe({ revision: 2, events: [firing(10)], agentId: 'other' });
	assert.equal(f.inbox.waiters.length, 1);
	f.observe({ revision: 2, events: [firing(8), firing(9)] });
	const seqBefore = Math.max(...(await baseline).events.map((event) => event.seq));
	f.observe({ revision: 1, events: [firing(11)] });
	f.observe({ revision: 2, events: [firing(9), firing(12, 'default-eat')] });
	assert.deepEqual(f.history.firings(seqBefore), ['default-eat:done']);
});

test('missing initial status cannot use a zero baseline and attribute historical firings to a trial', async () => {
	let resets = 0;
	const rejected = [], commands = [];
	const staged = await stageBenchmarkTrial({
		scenario: SCENARIOS.creeper, rules: [], reset: async () => { resets++; },
		install: async () => {}, reflexStatus: async () => null, sleep: async () => {},
		command: async (command) => { commands.push(command); return 'Bench has the following entity data: 20f'; },
		onRejected: (failure) => rejected.push(failure),
	});
	assert.equal(staged, null);
	assert.equal(resets, 3);
	assert.equal(rejected.length, 3);
	assert.ok(rejected.every((failure) => failure.reason.includes('reflex status')));
	assert.ok(commands.every((command) => command === 'data get entity Bench Health'));
});
