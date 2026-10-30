#!/usr/bin/env node
// What one model call costs, and what a presentation change saves, from a recorded native-tools run:
//   node scripts/quality/call-cost-replay.mjs --before CHECKOUT --after CHECKOUT [--tokens] [--json OUT] RUN_DIR...
//
// RUN_DIR is a headless run artifact dir holding provider-turns.private.jsonl and quality-protocol.jsonl (or
// protocol.jsonl). Three reports per run:
//   1. latency: per model call, seconds from its last input to its first tool call, against input, uncached input and
//      output tokens (provider-reported per-call usage).
//   2. composition: each call's input tokens split into what the thread had accumulated by then (turn inputs, steers,
//      tool results by tool, the model's own tool calls) and the fixed rest (instructions, tool schemas, reasoning),
//      from the recorded byte lengths (captures note truncated bytes) at a measured tokens-per-byte ratio.
//   3. replay: every recorded observe/moveTo/mine/act/sequence result and wake event is rebuilt from the raw server
//      observation recorded just before it and presented by each checkout's presentNativeToolResult and
//      ModelObservationViews, one views session per recorded provider thread (production resets views on rotation).
//      Each call's input after = its recorded input minus the tokens the change removed from earlier items of its
//      thread. Raw observations lack the coordinator's decorations, so replayed sizes are a lower bound on recorded ones;
//      the before/after difference is the measured part. Thread boundaries stay as recorded, although smaller
//      contexts rotate later.
// Reads only. Tokens: --tokens counts with tiktoken o200k_base through uv (a tokenizer proxy, not billing);
// otherwise bytes x the ratio measured on this run's untruncated captured inputs (or 0.33).
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const POST_ACTION_TOOLS = new Set(['moveTo', 'mine', 'act', 'sequence']);
const DEFAULT_TOKENS_PER_BYTE = 0.33;
const bytes = text => Buffer.byteLength(text, 'utf8');
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length === 0 ? null : s[s.length >> 1]; };
const mean = values => values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
const round = (value, digits = 0) => value === null ? null : Number(value.toFixed(digits));

function parseArgs(argv) {
	const options = { before: null, after: null, tokens: false, json: null, dirs: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--before') options.before = argv[++i];
		else if (argv[i] === '--after') options.after = argv[++i];
		else if (argv[i] === '--tokens') options.tokens = true;
		else if (argv[i] === '--json') options.json = argv[++i];
		else options.dirs.push(argv[i]);
	}
	if (options.dirs.length === 0) throw new Error('usage: call-cost-replay.mjs [--before CHECKOUT --after CHECKOUT] [--tokens] [--json OUT] RUN_DIR...');
	return options;
}

async function* jsonl(file, filter) {
	for await (const line of readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
		if (!line || filter && !filter(line)) continue;
		try { yield JSON.parse(line); } catch { /* half-written line */ }
	}
}

/** Recorded UTF-8 length of a captured text, adding the bytes the capture truncated. */
function recordedBytes(text) {
	if (typeof text !== 'string') return 0;
	const match = /\.\.\.\[truncated (\d+) bytes\]$/.exec(text);
	return match === null ? bytes(text) : bytes(text) - bytes(match[0]) + Number(match[1]) + 3;
}

/** Ordered thread items: events (turn input, steer), tool results and model calls with usage. */
async function readTurns(dir) {
	const items = [], calls = [];
	const names = new Map();
	for await (const turn of jsonl(path.join(dir, 'provider-turns.private.jsonl'))) {
		if (String(turn.agentId).startsWith('goal-spec') || turn.capture?.calls === undefined) continue;
		for (const call of turn.capture.calls) {
			for (const input of call.inputs ?? []) {
				const tool = input.kind === 'tool_result' ? names.get(input.callId) ?? null : null;
				items.push({ threadId: turn.threadId, kind: input.kind, at: input.at, tool: tool?.name ?? null, args: tool?.args ?? null,
					recordedBytes: recordedBytes(input.text), untruncated: typeof input.text === 'string' && !input.text.includes('...[truncated ') ? input.text : null });
			}
			const lastInputAt = Math.max(...(call.inputs ?? []).map(input => input.at).filter(Number.isFinite));
			const firstToolAt = call.toolCalls?.[0]?.at ?? call.endedAt ?? null;
			if (call.usage) calls.push({ threadId: turn.threadId, itemsBefore: items.length, usage: call.usage,
				latencyMs: Number.isFinite(lastInputAt) && Number.isFinite(firstToolAt) ? firstToolAt - lastInputAt : null });
			for (const toolCall of call.toolCalls ?? []) {
				names.set(toolCall.callId, { name: toolCall.name, args: toolCall.arguments });
				items.push({ threadId: turn.threadId, kind: 'tool_call', at: toolCall.at, tool: toolCall.name, recordedBytes: bytes(toolCall.arguments ?? '') });
			}
		}
	}
	return { items, calls };
}

/** The newest raw server observation recorded at or before each wanted time. */
async function observationsAt(dir, times) {
	const file = ['quality-protocol.jsonl', 'protocol.jsonl'].map(name => path.join(dir, name)).find(existsSync);
	if (file === undefined) return new Map();
	const wanted = [...new Set(times)].sort((a, b) => a - b);
	const found = new Map();
	let index = 0, latest = null;
	for await (const row of jsonl(file, line => line.includes('"type":"observation"') && line.includes('"server_to_coordinator"'))) {
		const at = row.observedAtMs ?? row.envelope?.payload?.observedAtEpochMs;
		while (index < wanted.length && wanted[index] < at) { if (latest !== null) found.set(wanted[index], latest); index++; }
		if (index >= wanted.length) break;
		if (row.envelope?.type === 'observation' && row.envelope.payload?.observation === undefined) latest = row.envelope.payload;
	}
	for (; index < wanted.length; index++) if (latest !== null) found.set(wanted[index], latest);
	return found;
}

function presentationTool(item) {
	let args = null;
	try { args = JSON.parse(item.args); } catch { /* capture truncated the arguments; presentation options are read below */ }
	const view = args?.view ?? /"view":"(full|changes)"/.exec(item.args ?? '')?.[1];
	const afterObservationId = args?.afterObservationId ?? /"afterObservationId":"([^"]+)"/.exec(item.args ?? '')?.[1];
	const kind = item.tool === 'observe' ? 'observe' : item.tool === 'sequence' ? 'sequence' : 'action';
	return { kind, ...(view === undefined ? {} : { view }), ...(afterObservationId === undefined ? {} : { afterObservationId }) };
}

async function loadCheckout(root) {
	const src = path.join(path.resolve(root), 'coordinator', 'src');
	const { presentNativeToolResult } = await import(pathToFileURL(path.join(src, 'codex-service.mjs')));
	const { ModelObservationViews, encodeModelFacts } = await import(pathToFileURL(path.join(src, 'model-fact-encoding.mjs')));
	return { root, presentNativeToolResult, ModelObservationViews, encodeModelFacts };
}

/** Presents every replayable item through one checkout; returns the text per item index. */
function replay(checkout, items, observations) {
	const texts = new Map();
	let views = null, thread = null, sequence = 0;
	for (const [index, item] of items.entries()) {
		if (item.threadId !== thread) { thread = item.threadId; views = new checkout.ModelObservationViews({ session: 'replay' }); }
		const observation = observations.get(item.at);
		if (observation === undefined) continue;
		const eventSequence = ++sequence;
		const freshness = { fresh: true, eventSequence, observedAtEpochMs: observation.observedAtEpochMs ?? null };
		if (item.kind === 'turn_input' || item.kind === 'steer') {
			texts.set(index, JSON.stringify(checkout.encodeModelFacts(views.prepareEvent({ observation: structuredClone(observation), freshness }))));
		} else if (item.kind === 'tool_result' && (POST_ACTION_TOOLS.has(item.tool) || item.tool === 'observe')) {
			const tool = presentationTool(item);
			const sample = { eventSequence, observation: structuredClone(observation), freshness };
			const value = tool.kind === 'observe' ? sample : { state: 'SUCCEEDED', reasonCode: 'REPLAYED', postAction: sample };
			const presented = checkout.presentNativeToolResult(value, tool, views);
			presented.commit();
			texts.set(index, presented.response.contentItems[0].text);
		}
	}
	return texts;
}

function tiktokenCounts(texts) {
	return JSON.parse(execFileSync('uv', ['run', '--no-project', '--with', 'tiktoken', 'python', '-c',
		'import json,sys,tiktoken; e=tiktoken.get_encoding("o200k_base"); print(json.dumps([len(e.encode(s,disallowed_special=())) for s in json.load(sys.stdin)]))'],
	{ input: JSON.stringify(texts), maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }));
}

function latencyReport(calls) {
	const rows = calls.filter(call => Number.isFinite(call.latencyMs) && call.latencyMs > 0 && call.latencyMs < 120_000 && call.usage.input > 0);
	const bucket = (key, edges) => edges.slice(0, -1).map((low, i) => {
		const inBucket = rows.filter(call => key(call) >= low && key(call) < edges[i + 1]);
		return { from: low, to: edges[i + 1], calls: inBucket.length, medianSeconds: round(median(inBucket.map(call => call.latencyMs)) / 1000, 1) };
	}).filter(row => row.calls > 0);
	return { calls: rows.length, medianSeconds: round(median(rows.map(call => call.latencyMs)) / 1000, 2), meanSeconds: round(mean(rows.map(call => call.latencyMs)) / 1000, 2),
		byInputTokens: bucket(call => call.usage.input, [0, 40_000, 80_000, 120_000, 160_000, 250_000, 1e9]),
		byUncachedTokens: bucket(call => call.usage.input - (call.usage.cached ?? 0), [0, 1_000, 2_000, 4_000, 8_000, 16_000, 1e9]),
		byOutputTokens: bucket(call => call.usage.output, [0, 40, 80, 150, 300, 600, 1e9]) };
}

function compositionReport(items, calls, tokensPerByte) {
	const totals = new Map();
	const add = (key, value) => totals.set(key, (totals.get(key) ?? 0) + value);
	let thread = null, accumulated = new Map(), next = 0, counted = 0;
	for (const call of calls) {
		for (; next < call.itemsBefore; next++) {
			const item = items[next];
			if (item.threadId !== thread) { thread = item.threadId; accumulated = new Map(); }
			const key = item.kind === 'tool_result' ? `result:${item.tool ?? '?'}` : item.kind === 'tool_call' ? 'model tool calls' : item.kind;
			accumulated.set(key, (accumulated.get(key) ?? 0) + item.recordedBytes);
		}
		if (call.threadId !== thread) { thread = call.threadId; accumulated = new Map(); }
		let history = 0;
		for (const [key, value] of accumulated) { add(key, value * tokensPerByte); history += value * tokensPerByte; }
		add('fixed: instructions, tool schemas, reasoning', call.usage.input - history);
		counted++;
	}
	const all = [...totals.values()].reduce((a, b) => a + b, 0);
	const group = key => key.startsWith('result:') ? 'tool results' : key;
	const grouped = new Map();
	for (const [key, value] of totals) grouped.set(group(key), (grouped.get(group(key)) ?? 0) + value);
	const rows = map => [...map].sort((a, b) => b[1] - a[1]).map(([part, value]) => ({ part, tokensPerCall: Math.round(value / counted), share: round(100 * value / all, 1) }));
	return { calls: counted, meanInputTokens: Math.round(all / counted), medianInputTokens: median(calls.map(call => call.usage.input)),
		parts: rows(grouped), toolResults: rows(new Map([...totals].filter(([key]) => key.startsWith('result:')))).filter(row => row.share >= 0.5) };
}

async function analyse(dir, checkouts, options) {
	const { items, calls } = await readTurns(dir);
	const samples = items.map(item => item.untruncated).filter(text => typeof text === 'string' && bytes(text) > 2_000).slice(0, 300);
	let tokensPerByte = DEFAULT_TOKENS_PER_BYTE;
	if (options.tokens && samples.length > 0) {
		const counts = tiktokenCounts(samples);
		tokensPerByte = counts.reduce((a, b) => a + b, 0) / samples.reduce((a, text) => a + bytes(text), 0);
	}
	const report = { dir, tokensPerByte: round(tokensPerByte, 3), latency: latencyReport(calls), composition: compositionReport(items, calls, tokensPerByte) };
	if (checkouts.length !== 2) return report;
	const observations = await observationsAt(dir, items.filter(item => item.kind !== 'tool_call').map(item => item.at));
	const [before, after] = checkouts.map(checkout => replay(checkout, items, observations));
	const indexes = [...before.keys()].filter(index => after.has(index));
	const texts = indexes.flatMap(index => [before.get(index), after.get(index)]);
	const counts = options.tokens ? tiktokenCounts(texts) : texts.map(text => Math.round(bytes(text) * tokensPerByte));
	const saved = new Map(), byTool = new Map();
	indexes.forEach((index, i) => {
		const [b, a] = [counts[2 * i], counts[2 * i + 1]];
		saved.set(index, b - a);
		const item = items[index];
		const key = item.kind === 'tool_result' ? item.tool : item.kind;
		const row = byTool.get(key) ?? { items: 0, beforeTokens: 0, afterTokens: 0, recordedBytes: 0, beforeBytes: 0, afterBytes: 0 };
		row.items++; row.beforeTokens += b; row.afterTokens += a; row.recordedBytes += item.recordedBytes;
		row.beforeBytes += bytes(before.get(index)); row.afterBytes += bytes(after.get(index));
		byTool.set(key, row);
	});
	// Each call re-reads everything earlier in its thread, so a saving counts once per later call of that thread.
	const perCall = [];
	let thread = null, cumulative = 0, next = 0;
	for (const call of calls) {
		for (; next < call.itemsBefore; next++) {
			if (items[next].threadId !== thread) { thread = items[next].threadId; cumulative = 0; }
			cumulative += saved.get(next) ?? 0;
		}
		if (call.threadId !== thread) { thread = call.threadId; cumulative = 0; }
		perCall.push({ before: call.usage.input, after: call.usage.input - cumulative });
	}
	const sum = values => values.reduce((a, b) => a + b, 0);
	report.replay = {
		replayedItems: indexes.length, beforeCheckout: checkouts[0].root, afterCheckout: checkouts[1].root,
		items: Object.fromEntries([...byTool].sort((a, b) => b[1].beforeTokens - a[1].beforeTokens).map(([key, row]) => [key, {
			items: row.items, recordedBytesMean: Math.round(row.recordedBytes / row.items), beforeBytesMean: Math.round(row.beforeBytes / row.items),
			afterBytesMean: Math.round(row.afterBytes / row.items), beforeTokensMean: Math.round(row.beforeTokens / row.items), afterTokensMean: Math.round(row.afterTokens / row.items),
		}])),
		inputTokensPerCall: { calls: perCall.length, beforeMean: Math.round(mean(perCall.map(row => row.before))), afterMean: Math.round(mean(perCall.map(row => row.after))),
			beforeMedian: median(perCall.map(row => row.before)), afterMedian: median(perCall.map(row => row.after)),
			beforeTotal: sum(perCall.map(row => row.before)), afterTotal: sum(perCall.map(row => row.after)) },
	};
	return report;
}

function markdown(report) {
	const lines = [`## ${path.basename(report.dir)}`, '', `tokens per byte ${report.tokensPerByte}`, '', '### latency (s from last input to first tool call)', '',
		`${report.latency.calls} calls, median ${report.latency.medianSeconds} s, mean ${report.latency.meanSeconds} s`, ''];
	for (const [title, key] of [['input tokens', 'byInputTokens'], ['uncached input tokens', 'byUncachedTokens'], ['output tokens', 'byOutputTokens']]) {
		lines.push(`| ${title} | calls | median s |`, '|---|---:|---:|', ...report.latency[key].map(row => `| ${row.from}-${row.to} | ${row.calls} | ${row.medianSeconds} |`), '');
	}
	lines.push('### input tokens per call by part', '', `${report.composition.calls} calls, mean ${report.composition.meanInputTokens}, median ${report.composition.medianInputTokens}`, '',
		'| part | tokens/call | share |', '|---|---:|---:|', ...[...report.composition.parts, ...report.composition.toolResults.map(row => ({ ...row, part: `  ${row.part}` }))]
			.map(row => `| ${row.part} | ${row.tokensPerCall} | ${row.share}% |`), '');
	if (report.replay) {
		const r = report.replay;
		lines.push('### replay', '', `${r.replayedItems} items; input tokens per call: mean ${r.inputTokensPerCall.beforeMean} -> ${r.inputTokensPerCall.afterMean}, median ${r.inputTokensPerCall.beforeMedian} -> ${r.inputTokensPerCall.afterMedian}, total ${r.inputTokensPerCall.beforeTotal} -> ${r.inputTokensPerCall.afterTotal}`, '',
			'| item | n | recorded bytes | replay bytes before | after | tokens before | after |', '|---|---:|---:|---:|---:|---:|---:|',
			...Object.entries(r.items).map(([key, row]) => `| ${key} | ${row.items} | ${row.recordedBytesMean} | ${row.beforeBytesMean} | ${row.afterBytesMean} | ${row.beforeTokensMean} | ${row.afterTokensMean} |`), '');
	}
	return lines.join('\n');
}

const options = parseArgs(process.argv.slice(2));
const checkouts = options.before && options.after ? [await loadCheckout(options.before), await loadCheckout(options.after)] : [];
const reports = [];
for (const dir of options.dirs) {
	const report = await analyse(path.resolve(dir), checkouts, options);
	reports.push(report);
	console.log(markdown(report));
}
if (options.json) await writeFile(options.json, JSON.stringify(reports, null, 2) + '\n');
