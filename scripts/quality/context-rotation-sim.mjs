#!/usr/bin/env node
// What a Codex context-rotation policy and smaller per-call inputs would have cost on recorded games:
//   node scripts/quality/context-rotation-sim.mjs [--delta-scale 0.95] [--prefix-saved 1397] [--json OUT] RUN_DIR...
//
// RUN_DIR is a headless run artifact dir (q-*) holding coordinator.jsonl. Each model call's provider-reported input,
// cached input and output tokens are replayed in order; the context growth between calls of one session (tool results,
// steers, events, the model's own calls) is kept as recorded, times --delta-scale. A rotation restarts the context at
// the fresh-session size (fixed prefix + carry-over) with the cross-session cached prefix read from cache. Recorded
// cache misses inside a session are kept. "recorded" replays the shipped policy until d40 (rotate at a completed turn
// once past 64k, three turns after the last rotation); the simulation reproduces recorded cost within about 1%.
// Reads only. Prices are the coordinator's proxy prices (call-cost.mjs), not plan charges.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

const PRICES = { sol: { input: 2, cached: 0.1, output: 10 }, luna: { input: 0.1, cached: 0.01, output: 0.5 } };
const THRESHOLD = 64_000, GROWTH_SHARE = 0.25, FRESH_SESSION = 27_000, CARRY_OVER = 4_000, SHARED_PREFIX = 19_000;
const POLICIES = {
	recorded: { minTurns: 3 },
	'd40 default (rotate at the next completed turn, growth guard)': { minTurns: 1 },
	'd40 + mid-turn at 200k': { minTurns: 1, midTurn: 200_000 },
	'd40 + mid-turn at 128k': { minTurns: 1, midTurn: 128_000 },
	'mid-turn at 64k (Oct 9 setting, lost a fact)': { minTurns: 1, midTurn: 64_000 },
};

function parseArgs(argv) {
	const options = { deltaScale: 1, prefixSaved: 0, json: null, dirs: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--delta-scale') options.deltaScale = Number(argv[++i]);
		else if (argv[i] === '--prefix-saved') options.prefixSaved = Number(argv[++i]);
		else if (argv[i] === '--json') options.json = argv[++i];
		else options.dirs.push(argv[i]);
	}
	if (options.dirs.length === 0 || !(options.deltaScale > 0)) throw new Error('usage: context-rotation-sim.mjs [--delta-scale F] [--prefix-saved TOKENS] [--json OUT] RUN_DIR...');
	return options;
}

async function readCalls(dir) {
	const rows = [];
	const input = createReadStream(path.join(dir, 'coordinator.jsonl'));
	for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
		if (!line.includes('"native_provider_turn_started"') && !line.includes('"native_model_call"')) continue;
		try { rows.push(JSON.parse(line)); } catch { /* half-written line */ }
	}
	rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
	const calls = [];
	let turn = 0, session = 0, previous = null;
	for (const row of rows) {
		if (row.event === 'native_provider_turn_started') { turn++; continue; }
		if ((row.goalRevision ?? 1) < 1) continue;
		const call = { turn, input: row.inputTokens, cached: row.cachedInputTokens ?? 0, output: row.outputTokens ?? 0 };
		// A recorded rotation shows as a large drop in input.
		if (previous && call.input < previous.input * 0.6 && call.input < previous.input - 20_000) session++;
		call.session = session;
		calls.push(call);
		previous = call;
	}
	return calls;
}

function simulate(calls, { minTurns, midTurn = 0 }, { deltaScale, prefixSaved }) {
	const totals = { calls: 0, input: 0, cached: 0, uncached: 0, output: 0, rotations: 0 };
	let context = null, floor = 0, turnsSince = 0, due = false, previous = null;
	for (const call of calls) {
		const newTurn = previous !== null && call.turn !== previous.turn;
		const recordedMiss = call.input - call.cached;
		let uncached;
		if (context === null) {
			context = call.input - prefixSaved;
			uncached = recordedMiss;
		} else {
			const sameSession = call.session === previous.session;
			const delta = Math.max(0, sameSession ? call.input - previous.input : call.input - FRESH_SESSION) * deltaScale;
			if (newTurn) turnsSince++;
			const grown = context - floor >= THRESHOLD * GROWTH_SHARE;
			const rotate = grown && (newTurn && due && turnsSince >= minTurns || midTurn > 0 && !newTurn && context >= midTurn);
			if (rotate) {
				totals.rotations++;
				context = FRESH_SESSION - prefixSaved + CARRY_OVER + delta;
				floor = context; turnsSince = 0; due = false;
				uncached = context - (SHARED_PREFIX - prefixSaved);
			} else {
				context += delta;
				// Keep the recorded cache miss when it exceeds the new content (a cache-routing miss).
				uncached = Math.min(context, Math.max(delta, recordedMiss));
			}
		}
		if (context >= THRESHOLD) due = true;
		totals.calls++; totals.input += context; totals.cached += context - uncached; totals.uncached += uncached; totals.output += call.output;
		previous = call;
	}
	return totals;
}

const cost = (t, price) => (t.uncached * price.input + t.cached * price.cached + t.output * price.output) / 1e6;
const options = parseArgs(process.argv.slice(2));
const sums = Object.fromEntries(Object.keys(POLICIES).map(name => [name, { calls: 0, input: 0, cached: 0, uncached: 0, output: 0, rotations: 0 }]));
let games = 0, recordedSol = 0;
for (const dir of options.dirs) {
	const calls = await readCalls(dir);
	if (calls.length < 100) continue;
	games++;
	recordedSol += calls.reduce((n, c) => n + ((c.input - c.cached) * 2 + c.cached * 0.1 + c.output * 10) / 1e6, 0);
	for (const [name, policy] of Object.entries(POLICIES)) {
		// The recorded policy replays recorded inputs; alternatives also apply the presentation scale and prefix saving.
		const scale = name === 'recorded' ? { deltaScale: 1, prefixSaved: 0 } : options;
		const t = simulate(calls, policy, scale);
		for (const key of Object.keys(t)) sums[name][key] += t[key];
	}
}
const base = sums.recorded;
const report = { games, calls: base.calls, recordedSolUsd: Number(recordedSol.toFixed(2)), deltaScale: options.deltaScale, prefixSaved: options.prefixSaved, policies: {} };
console.log(`${games} games, ${base.calls} calls; recorded Sol cost $${recordedSol.toFixed(2)}; delta scale ${options.deltaScale}, prefix saved ${options.prefixSaved} tokens/call`);
console.log('| policy | input tok/call | cached | uncached | rotations/game | tokens/game | Sol $/game | Luna $/game | vs recorded |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const [name, t] of Object.entries(sums)) {
	const row = { inputPerCall: Math.round(t.input / t.calls), cachedPerCall: Math.round(t.cached / t.calls), uncachedPerCall: Math.round(t.uncached / t.calls),
		rotationsPerGame: Number((t.rotations / games).toFixed(1)), inputTokensPerGame: Math.round(t.input / games), solUsdPerGame: Number((cost(t, PRICES.sol) / games).toFixed(2)),
		lunaUsdPerGame: Number((cost(t, PRICES.luna) / games).toFixed(3)), costChange: Number((100 * (cost(t, PRICES.sol) / cost(base, PRICES.sol) - 1)).toFixed(1)) };
	report.policies[name] = row;
	console.log(`| ${name} | ${row.inputPerCall} | ${row.cachedPerCall} | ${row.uncachedPerCall} | ${row.rotationsPerGame} | ${row.inputTokensPerGame} | ${row.solUsdPerGame} | ${row.lunaUsdPerGame} | ${row.costChange}% |`);
}
if (options.json) await writeFile(options.json, JSON.stringify(report, null, 2) + '\n');
