import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
	discoverAntigravityCatalog,
	parseAntigravityModelsOutput,
} from '../src/provider-catalog-discovery.mjs';

test('Antigravity parser derives stable slugs and preserves CLI effort order', () => {
	assert.deepEqual(parseAntigravityModelsOutput([
		'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
		'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
		'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
		'claude-sonnet-4-6-thinking\tClaude Sonnet 4.6 (Thinking)',
		'not model metadata',
	].join('\n')), [
		{ id: 'gemini-3.6-flash', model: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', reasoningEfforts: ['high', 'medium', 'low'], serviceTiers: [] },
		{ id: 'claude-sonnet-4-6', model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', reasoningEfforts: ['thinking'], serviceTiers: [] },
	]);
});

test('Antigravity parser keeps display-only models distinct and derives slugs from the full name', () => {
	assert.deepEqual(parseAntigravityModelsOutput([
		'Gemini 3.6 Flash (High)',
		'Gemini 3.6 Flash (Low)',
		'Gemini 3.1 Pro (Low)',
		'Claude Sonnet 4.6 (Thinking)',
		'gemini-3.1-pro-high Gemini 3.1 Pro (High)',
	].join('\n')), [
		{ id: 'gemini-3.6-flash', model: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', reasoningEfforts: ['high', 'low'], serviceTiers: [] },
		{ id: 'gemini-3.1-pro', model: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', reasoningEfforts: ['low', 'high'], serviceTiers: [] },
		{ id: 'claude-sonnet-4.6', model: 'claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6', reasoningEfforts: ['thinking'], serviceTiers: [] },
	]);
});

test('CLI discovery adapter passes only the catalog command, explicit environment, and parse stdout', async () => {
	const calls = [];
	const environment = { PATH: 'test', GEMINI_API_KEY: 'provider-key' };
	const execFile = (command, args, options, callback) => {
		calls.push({ command, args, options });
		callback(null, 'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n', '');
	};
	assert.deepEqual(await discoverAntigravityCatalog({ execFile, environment }), [
		{ id: 'gemini-3.1-pro', model: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', reasoningEfforts: ['low'], serviceTiers: [] },
	]);
	assert.deepEqual(calls[0].args, ['models']);
	assert.equal(calls[0].options.env, environment);

});

// Runs a real Node child in place of `agy`, so the default (non-execFile) discovery path spawns a process.
function nodeChildSpawn(source, calls = []) {
	return (command, args, options) => {
		calls.push({ command, args, options });
		return spawn(process.execPath, ['-e', source, ...args], options);
	};
}

// Counts 10 ms interval ticks while `work` runs. A blocked event loop gets none until the work returns.
async function eventLoopTicksDuring(work) {
	let ticks = 0;
	const timer = setInterval(() => { ticks += 1; }, 10);
	const started = performance.now();
	try {
		const result = await work();
		return { result, ticks, elapsedMs: performance.now() - started };
	} finally {
		clearInterval(timer);
	}
}

test('default Antigravity discovery keeps the event loop running while the CLI is slow', async (t) => {
	const calls = [];
	const environment = { PATH: process.env.PATH ?? '', GEMINI_API_KEY: 'provider-key' };
	const source = "setTimeout(() => process.stdout.write('gemini-3.1-pro-low\\tGemini 3.1 Pro (Low)\\n'), 400)";
	const { result, ticks, elapsedMs } = await eventLoopTicksDuring(() => discoverAntigravityCatalog({ executable: 'agy', spawn: nodeChildSpawn(source, calls), environment }));
	t.diagnostic(`discovery took ${Math.round(elapsedMs)} ms; ${ticks} of ${Math.floor(elapsedMs / 10)} 10 ms ticks ran`);
	assert.deepEqual(result, [
		{ id: 'gemini-3.1-pro', model: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', reasoningEfforts: ['low'], serviceTiers: [] },
	]);
	// spawnSync ran zero ticks for the whole child lifetime; the async child leaves the loop free.
	assert.ok(ticks >= 10, `expected the event loop to keep ticking, got ${ticks} ticks in ${Math.round(elapsedMs)} ms`);
	assert.equal(calls[0].command, 'agy');
	assert.deepEqual(calls[0].args, ['models']);
	assert.equal(calls[0].options.env, environment);
	assert.equal(calls[0].options.windowsHide, true);
});

test('default Antigravity discovery reports the same failure codes spawnSync did', async () => {
	const environment = { PATH: process.env.PATH ?? '' };
	await assert.rejects(
		discoverAntigravityCatalog({ spawn: nodeChildSpawn('setTimeout(() => {}, 10_000)'), environment, timeoutMs: 100 }),
		{ message: 'Provider model discovery failed (ETIMEDOUT)' },
	);
	await assert.rejects(
		discoverAntigravityCatalog({ spawn: nodeChildSpawn('process.exit(3)'), environment }),
		{ message: 'Provider model discovery failed (exit_3)' },
	);
	await assert.rejects(
		discoverAntigravityCatalog({ spawn: nodeChildSpawn("process.stdout.write('x'.repeat(2 * 1024 * 1024))"), environment }),
		{ message: 'Provider model discovery failed (ENOBUFS)' },
	);
	await assert.rejects(
		discoverAntigravityCatalog({ spawn: nodeChildSpawn("process.stderr.write('x'.repeat(2 * 1024 * 1024))"), environment }),
		{ message: 'Provider model discovery failed (ENOBUFS)' },
	);
	await assert.rejects(
		discoverAntigravityCatalog({ executable: 'arena-agents-missing-agy-cli', environment }),
		{ message: 'Provider model discovery failed (ENOENT)' },
	);
});
