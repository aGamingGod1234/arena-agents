#!/usr/bin/env node
// Local coordinator dispatch fixture, not provider latency or a Minecraft trial.
// Run from coordinator/: node scripts/dispatch-latency-benchmark.mjs
import { mkdtemp, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ModelNotebook } from '../src/model-notebook.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { TraceWriter } from '../src/trace-writer.mjs';

const directory = await mkdtemp(join(tmpdir(), 'dispatch-benchmark-'));
const probe = await open(join(directory, 'probe'), 'w');
const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync;
await probe.close();
const results = {};
try {
	for (const syncDelayMs of [0, 20]) {
		prototype.sync = async function (...args) {
			if (syncDelayMs) await new Promise(resolve => setTimeout(resolve, syncDelayMs));
			return originalSync.apply(this, args);
		};
		const record = { agentId: 'a', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'priority', currentGoal: 'wait' };
		const notebook = new ModelNotebook({ directory: join(directory, String(syncDelayMs)) });
		const times = [];
		let start;
		const runtime = new NativeToolRuntime({ notebook, bridge: { send: async type => {
			if (type === 'action_command') times.push(performance.now() - start);
		} } });
		for (let index = 0; index < 30; index++) {
			runtime.updateObservation(record, { world: { worldId: 'w', dimension: 'minecraft:overworld' } }, { eventSequence: index + 1 });
			start = performance.now();
			await runtime.execute({ agentId: 'a', goalRevision: 1, callId: `c${index}`, turnId: 't', tool: { kind: 'start_action', actionType: 'wait', arguments: { durationMs: 1 } } }, record);
			// No server in this fixture. Settle the test lifecycle before the next sample;
			// cancellation/cleanup and previous persistence are outside the dispatch measurement.
			await runtime.disposeAll();
		}
		await notebook.query('a', { worldId: 'w' });
		times.sort((a, b) => a - b);
		results[`syncDelay${syncDelayMs}ms`] = { n: times.length, p50: times[14], p95: times[28], total: times.reduce((a, b) => a + b, 0) };
	}
	prototype.sync = originalSync;
	let retained = 0, appends = 0, serializations = 0;
	const writer = new TraceWriter(join(directory, 'trace'), { mkdir: async () => {}, appendFile: async (_path, encoded) => {
		appends++;
		await new Promise(resolve => setTimeout(resolve, 2));
		retained += encoded.trim().split('\n').length;
	} });
	const stringify = JSON.stringify;
	const writeStartedAt = performance.now();
	let writeLoopMs;
	try {
		JSON.stringify = (...args) => { serializations++; return stringify(...args); };
		for (let index = 0; index < 1000; index++) await writer.write('native_tool_command_sent', { actionId: `a${index}` });
		writeLoopMs = performance.now() - writeStartedAt;
	} finally { JSON.stringify = stringify; }
	await writer.close();
	results.traceBurst = { submitted: 1000, retained, appends, serializations, writeLoopMs, status: writer.statusSnapshot() };
	console.log(JSON.stringify(results, null, 2));
} finally {
	prototype.sync = originalSync;
	await rm(directory, { recursive: true, force: true });
}
