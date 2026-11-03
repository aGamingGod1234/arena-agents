import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { NativeToolRuntime } from '../native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../native-minecraft-tools.mjs';

// Provider-free benchmark for audit 2026-11-01 #6 (let the body keep working while the model thinks).
// The real NativeToolRuntime runs on a deterministic clock behind a fake Minecraft bridge: each action takes a fixed
// simulated time and every model decision takes a fixed thinking time. Nothing calls a provider or a server. Each
// strategy completes the same workload; keepGoing also dispatches a speculative leg that the reply cancels.
//
//   node src/benchmark/body-overlap-benchmark.mjs [thinkingMs=4000]
const [thinkingArg = '4000'] = process.argv.slice(2);
const THINKING_MS = Number(thinkingArg);
if (!Number.isInteger(THINKING_MS) || THINKING_MS < 100 || THINKING_MS > 30_000) throw new Error('Usage: node body-overlap-benchmark.mjs [thinkingMs 100..30000]');

const TARGET = '0506d22f-7469-4a60-bf39-b1b9daf72a3a';
// A known chain of long steps: walk to a tree, take a log, travel to a hill, stair down, walk to an ore, fight for drops.
const CHAIN = [
	{ actionType: 'navigate_to', arguments: { x: 30, y: 64, z: 4 }, durationMs: 6_000 },
	{ actionType: 'break_block', arguments: { x: 31, y: 64, z: 4 }, durationMs: 1_500 },
	{ actionType: 'travel_to', arguments: { x: 300, z: 40 }, durationMs: 20_000 },
	{ actionType: 'dig_to', arguments: { pattern: 'stairs_down', y: 16 }, durationMs: 30_000 },
	{ actionType: 'navigate_to', arguments: { x: 310, y: 16, z: 44 }, durationMs: 5_000 },
	{ actionType: 'fight_target', arguments: { targetId: TARGET, untilItem: 'minecraft:bone', untilCount: 3, timeoutMs: 60_000 }, durationMs: 12_000 },
];
// Open-ended work: a strip-mine tunnel driven leg by leg, the model reading each leg before the next.
const TUNNEL_LEG = { actionType: 'dig_to', arguments: { pattern: 'tunnel', heading: 'east', maxBlocks: 16 }, durationMs: 12_000 };
const TUNNEL_LEGS = 6;

function deterministicClock() {
	let now = 0;
	let nextId = 0;
	const timers = [];
	return {
		now: () => now,
		setTimeoutFn(callback, delayMs) {
			const timer = { id: ++nextId, dueAt: now + delayMs, callback, cancelled: false };
			timers.push(timer);
			return timer;
		},
		async advanceTo(targetMs) {
			assert.ok(targetMs >= now, 'deterministic clock cannot move backwards');
			for (;;) {
				await new Promise((resolve) => setImmediate(resolve));
				const timer = timers.filter((candidate) => !candidate.cancelled && candidate.dueAt <= targetMs)
					.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
				if (timer === undefined) break;
				timer.cancelled = true;
				now = timer.dueAt;
				timer.callback();
			}
			now = targetMs;
			for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
		},
		advanceBy(durationMs) { return this.advanceTo(now + durationMs); },
		/** Fires due timers in order until the condition holds. */
		async runUntil(condition) {
			while (!condition()) {
				const next = timers.filter((candidate) => !candidate.cancelled).sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
				assert.ok(next !== undefined, 'the condition can never hold: no timer is pending');
				await this.advanceTo(next.dueAt);
			}
		},
		/** Runs the clock until the promise settles, firing due timers in order. */
		async until(promise) {
			let settled = false;
			const value = promise.then((result) => { settled = true; return result; }, (error) => { settled = true; throw error; });
			while (!settled) {
				await new Promise((resolve) => setImmediate(resolve));
				if (settled) break;
				const next = timers.filter((candidate) => !candidate.cancelled).sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
				assert.ok(next !== undefined, 'the awaited call can never settle: no timer is pending');
				await this.advanceTo(next.dueAt);
			}
			return value;
		},
	};
}

function harness(strategy) {
	const clock = deterministicClock();
	const record = { agentId: `overlap-${strategy}`, provider: 'synthetic-benchmark', model: 'selected-model-simulation', reasoningEffort: 'fixed-delay', goalRevision: 1, currentGoal: 'Benchmark routine' };
	const dispatched = [];
	const executions = new Map();
	const bodyBusy = [];
	const endedAt = [];
	let position = { x: 0, y: 64, z: 0 };
	let eventSequence = 1;
	let ordinal = 0;
	let runtime;
	const observation = () => ({ world: { worldId: 'synthetic-overlap-world', dimension: 'minecraft:overworld' }, player: { ...position, health: 20, foodLevel: 20 }, blocks: [], entities: [], items: [], inventory: { items: [] }, observedAtEpochMs: clock.now() });
	const durations = new Map();
	runtime = new NativeToolRuntime({
		sessionId: `overlap-${strategy}`,
		publicationGraceMs: 0,
		bridge: { send: async (type, _agentId, payload) => {
			if (type === 'action_cancel') {
				clock.setTimeoutFn(() => {
					const execution = executions.get(payload.actionId);
					assert.equal(execution.state, 'RUNNING', 'only running work can be cancelled');
					execution.timer.cancelled = true;
					execution.state = 'CANCELLED';
					execution.finishedAtMs = clock.now();
					runtime.onActionResult(record, { goalRevision: payload.goalRevision, actionId: payload.actionId, state: 'CANCELLED', reasonCode: 'ACTION_CANCELLED', actionObservation: { position } });
				}, 50);
				return;
			}
			if (type !== 'action_command') return;
			const step = durations.get(JSON.stringify([payload.actionType, payload.arguments]));
			assert.ok(step !== undefined, `unplanned action ${payload.actionType}`);
			const action = { actionType: payload.actionType, arguments: structuredClone(payload.arguments) };
			dispatched.push(action);
			const startedAt = clock.now();
			const execution = { ...action, state: 'RUNNING', startedAtMs: startedAt };
			executions.set(payload.actionId, execution);
			execution.timer = clock.setTimeoutFn(() => {
				execution.state = 'SUCCEEDED';
				execution.finishedAtMs = clock.now();
				// Each completed leg moves the body, so a keepGoing leg counts as progress.
				position = { ...position, x: position.x + 16 };
				bodyBusy.push(clock.now() - startedAt);
				endedAt.push(clock.now());
				runtime.onActionResult(record, { goalRevision: payload.goalRevision, actionId: payload.actionId, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED', executionStarted: true, actionObservation: { position } });
			}, step.durationMs);
		} },
		requestObservation: async (_record, { afterEventSequence }) => {
			eventSequence = Math.max(eventSequence, afterEventSequence) + 1;
			return { observation: observation(), eventSequence };
		},
	});
	runtime.updateObservation(record, observation(), { eventSequence });
	const plan = (steps) => { for (const step of steps) durations.set(JSON.stringify([step.actionType, normalizeMinecraftToolCall('startAction', { actionType: step.actionType, arguments: step.arguments }).arguments]), step); };
	const call = (name, args) => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'turn-1', callId: `call-${++ordinal}`, tool: normalizeMinecraftToolCall(name, args) }, record);
	const action = (step) => ({ actionType: step.actionType, arguments: step.arguments });
	return { clock, runtime, call, action, plan, dispatched, executions, bodyBusy, endedAt, dispose: () => runtime.disposeAll() };
}

const think = (clock) => clock.advanceBy(THINKING_MS);

// Today's default: think, then a blocking act; the body waits for every decision.
async function serialChain() {
	const h = harness('serial-chain');
	h.plan(CHAIN);
	try {
		for (const step of CHAIN) {
			await think(h.clock);
			assert.equal((await h.clock.until(h.call('act', h.action(step)))).state, 'SUCCEEDED');
		}
		return { elapsedMs: h.clock.now(), decisions: CHAIN.length, dispatched: h.dispatched, bodyMs: h.bodyBusy.reduce((a, b) => a + b, 0) };
	} finally { await h.dispose(); }
}

// startAction, then each next step decided while the body works and sent with after:<running handle>.
async function afterChain() {
	const h = harness('after-chain');
	h.plan(CHAIN);
	try {
		await think(h.clock);
		let handle = await h.clock.until(h.call('startAction', h.action(CHAIN[0])));
		for (const step of CHAIN.slice(1)) {
			await think(h.clock);
			handle = await h.clock.until(h.call('startAction', { ...h.action(step), after: handle.actionId }));
			assert.equal(handle.state, 'RUNNING');
			assert.equal(handle.predecessor.state, 'SUCCEEDED');
		}
		await h.clock.runUntil(() => h.endedAt.length === CHAIN.length);
		return { elapsedMs: h.endedAt.at(-1), decisions: CHAIN.length, dispatched: h.dispatched, bodyMs: h.bodyBusy.reduce((a, b) => a + b, 0) };
	} finally { await h.dispose(); }
}

function tunnelAccounting(h, completedAtMs) {
	const dispatches = [...h.executions.values()].map(({ timer, ...execution }) => execution);
	assert.ok(dispatches.every(({ state }) => state === 'SUCCEEDED' || state === 'CANCELLED'), 'all tunnel dispatches must settle');
	const digMs = (state) => dispatches.filter((row) => row.actionType === 'dig_to' && row.state === state)
		.reduce((total, row) => total + row.finishedAtMs - row.startedAtMs, 0);
	return { dispatches, completedDigMs: digMs('SUCCEEDED'), cancelledDigMs: digMs('CANCELLED'),
		completedAtMs, stopFinishedAtMs: h.clock.now() };
}

// Today's default for open-ended work: one decision per tunnel leg.
async function serialTunnel() {
	const h = harness('serial-tunnel');
	h.plan([TUNNEL_LEG]);
	try {
		for (let leg = 0; leg < TUNNEL_LEGS; leg += 1) {
			await think(h.clock);
			assert.equal((await h.clock.until(h.call('act', h.action(TUNNEL_LEG)))).state, 'SUCCEEDED');
		}
		return { elapsedMs: h.clock.now(), decisions: TUNNEL_LEGS, dispatched: h.dispatched, accounting: tunnelAccounting(h, h.clock.now()), bodyMs: h.bodyBusy.reduce((a, b) => a + b, 0) };
	} finally { await h.dispose(); }
}

// keepGoing: one decision starts the tunnel; legs repeat while the model reads them, and its reply stops the last one.
async function keepGoingTunnel() {
	const h = harness('keep-going-tunnel');
	h.plan([TUNNEL_LEG, { actionType: 'look_at', arguments: { x: 200, y: 64, z: 0 }, durationMs: 50 }]);
	try {
		await think(h.clock);
		const first = await h.clock.until(h.call('act', { ...h.action(TUNNEL_LEG), keepGoing: true }));
		assert.equal(first.state, 'SUCCEEDED');
		assert.ok(first.continuing, 'the second leg runs while the model reads the first');
		// The model reads the first leg's facts while the body keeps digging; the later legs need no decision.
		await think(h.clock);
		await h.clock.runUntil(() => h.endedAt.length === TUNNEL_LEGS);
		const legsDoneAt = h.endedAt[TUNNEL_LEGS - 1];
		// Its reply (any body call) stops the leg running now.
		const reply = await h.clock.until(h.call('act', { actionType: 'look_at', arguments: { x: 200, y: 64, z: 0 } }));
		assert.equal(reply.replacedAction.state, 'CANCELLED');
		const accounting = tunnelAccounting(h, legsDoneAt);
		return { elapsedMs: legsDoneAt, decisions: 2, dispatched: h.dispatched, accounting,
			bodyMs: accounting.completedDigMs };
	} finally { await h.dispose(); }
}

const wallStartedAt = performance.now();
const results = { serialChain: await serialChain(), afterChain: await afterChain(), serialTunnel: await serialTunnel(), keepGoingTunnel: await keepGoingTunnel() };
assert.deepEqual(results.afterChain.dispatched, results.serialChain.dispatched, 'after dispatches exactly the serial chain');
const completedDigs = (result) => result.accounting.dispatches
	.filter(({ actionType, state }) => actionType === 'dig_to' && state === 'SUCCEEDED')
	.map(({ actionType, arguments: args }) => ({ actionType, arguments: args }));
assert.deepEqual(completedDigs(results.keepGoingTunnel), results.serialTunnel.dispatched, 'keepGoing completes exactly the serial legs');
assert.deepEqual(results.keepGoingTunnel.accounting.dispatches.map(({ actionType, state }) => [actionType, state]), [
	...Array.from({ length: TUNNEL_LEGS }, () => ['dig_to', 'SUCCEEDED']),
	['dig_to', 'CANCELLED'], ['look_at', 'SUCCEEDED'],
], 'the full tunnel dispatch list includes one cancelled speculative dig and the stop reply');
const compare = (serial, overlapped) => ({
	serialMs: results[serial].elapsedMs, overlappedMs: results[overlapped].elapsedMs,
	savedMs: results[serial].elapsedMs - results[overlapped].elapsedMs,
	bodyDecisions: { serial: results[serial].decisions, overlapped: results[overlapped].decisions },
	percentSaved: Number(((results[serial].elapsedMs - results[overlapped].elapsedMs) / results[serial].elapsedMs * 100).toFixed(1)),
	bodyIdleShare: { serial: Number((1 - results[serial].bodyMs / results[serial].elapsedMs).toFixed(3)), overlapped: Number((1 - results[overlapped].bodyMs / results[overlapped].elapsedMs).toFixed(3)) },
});
process.stdout.write(`${JSON.stringify({
	benchmark: 'native-body-overlap',
	classification: 'synthetic, deterministic timing; no live provider or Minecraft server',
	controller: 'real NativeToolRuntime with a deterministic clock and a fake action bridge',
	thinkingMsPerDecision: THINKING_MS,
	workloads: { chain: CHAIN.map(({ actionType, durationMs }) => ({ actionType, durationMs })), tunnel: { leg: TUNNEL_LEG.arguments, legs: TUNNEL_LEGS, legMs: TUNNEL_LEG.durationMs, accounting: { serial: results.serialTunnel.accounting, keepGoing: results.keepGoingTunnel.accounting } } },
	correctness: 'PASSED: known-chain dispatches and completed tunnel work match serial, in order; tunnel includes one cancelled speculative dig and a completed stop reply',
	timingBasis: 'Comparison ends at workload completion; tunnel stopFinishedAtMs also includes cancellation acknowledgement and the stop reply. Cancelled dig time is simulated occupancy, not measured blocks or live gameplay cost.',
	comparisons: { knownChain: compare('serialChain', 'afterChain'), openTunnel: compare('serialTunnel', 'keepGoingTunnel') },
	benchmarkWallClockMs: Number((performance.now() - wallStartedAt).toFixed(1)),
}, null, 2)}\n`);
