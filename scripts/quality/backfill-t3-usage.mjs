#!/usr/bin/env node
// One-off: write usage-only Codex rollout files for past headless games so T3 Code's usage page includes them.
// Reads only token counts from each run's quality-usage.jsonl (native_token_usage, one row per model call) and
// provider-turns.private.jsonl (non-native turns such as goal_spec); never prompts or game content.
// One file per game run (rotated at 50 MB or a new day), as the live mirror writes one per process.
// Files are marked source "arena-agents-usage-backfill" and listed in <home>/aa-usage-backfill-manifest.json.
//   node scripts/quality/backfill-t3-usage.mjs [--root <headless-runs dir>]... [--days 7] [--until <ISO>] [--write]
//   node scripts/quality/backfill-t3-usage.mjs --delete     removes every file the manifest lists
// Without --write it only reports what it would add. Use --until to stop before runs that already had the live mirror.
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { codexUsageMirrorHome, CodexUsageMirror } from '../../coordinator/src/codex-usage-mirror.mjs';

const SOURCE = 'arena-agents-usage-backfill';
const { values } = parseArgs({ options: {
	root: { type: 'string', multiple: true }, days: { type: 'string', default: '7' }, until: { type: 'string' },
	home: { type: 'string' }, write: { type: 'boolean', default: false }, delete: { type: 'boolean', default: false },
} });
const home = values.home ?? codexUsageMirrorHome();
const manifestPath = path.join(home, 'aa-usage-backfill-manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { source: SOURCE, files: [] };

if (values.delete) {
	for (const file of manifest.files) rmSync(file.path, { force: true });
	rmSync(manifestPath, { force: true });
	console.log(`deleted ${manifest.files.length} backfill files`);
	process.exit(0);
}

const sinceMs = Date.now() - Number(values.days) * 86_400_000;
const untilMs = values.until ? Date.parse(values.until) : Date.now();
const projects = path.join(os.homedir(), 'Desktop', 'Projects');
const roots = values.root ?? readdirSync(projects).filter((name) => name.startsWith('aa-run-')).map((name) => path.join(projects, name, 'runtime', 'headless-runs'));
const known = new Set(manifest.files.map((file) => file.run));

async function* rows(file) {
	if (!existsSync(file)) return;
	for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
		if (line.trim() === '') continue;
		try { yield JSON.parse(line); } catch { /* a torn last line */ }
	}
}

const inWindow = (at) => Number.isFinite(at) && at >= sinceMs && at <= untilMs;

// Each session: { key, model, serviceTier, calls: [{ at, last }] }.
async function runSessions(dir) {
	const sessions = new Map();
	const agents = new Map();
	for await (const row of rows(path.join(dir, 'quality-usage.jsonl'))) {
		if (row.event === 'native_decision_timing' && row.provider === 'codex') agents.set(row.agentId, { model: row.model, serviceTier: row.serviceTier });
		if (row.event !== 'native_token_usage' || !inWindow(row.at)) continue;
		const key = `${dir}\0${row.sessionKey}`;
		const session = sessions.get(key) ?? { key, agentId: row.agentId, calls: [], lastTotal: null };
		sessions.set(key, session);
		const total = `${row.inputTokens}/${row.outputTokens}/${row.totalTokens}`;
		if (total === session.lastTotal) continue;
		session.lastTotal = total;
		session.calls.push({ at: row.at, last: { inputTokens: row.lastInputTokens, cachedInputTokens: row.lastCachedInputTokens,
			cacheWriteInputTokens: row.lastCacheWriteInputTokens, outputTokens: row.lastOutputTokens, reasoningOutputTokens: row.lastReasoningOutputTokens } });
	}
	for (const session of sessions.values()) Object.assign(session, agents.get(session.agentId) ?? {});
	let turn = 0;
	for await (const row of rows(path.join(dir, 'provider-turns.private.jsonl'))) {
		turn += 1;
		if (row.provider !== 'codex' || row.executionSettings?.controlProtocol === 'native_tools' || !inWindow(row.timestamp) || !row.tokens) continue;
		const key = `${dir}\0turn-${turn}`;
		sessions.set(key, { key, model: row.executionSettings?.effective?.model ?? row.model, serviceTier: row.executionSettings?.effective?.serviceTier ?? 'default',
			calls: [{ at: row.timestamp, last: { inputTokens: row.tokens.input, cachedInputTokens: row.tokens.cached, cacheWriteInputTokens: row.tokens.cacheWrite,
				outputTokens: row.tokens.output, reasoningOutputTokens: row.tokens.reasoning } }] });
	}
	return [...sessions.values()].filter((session) => typeof session.model === 'string' && session.calls.length > 0);
}

const totals = { runs: 0, files: 0, threads: 0, calls: 0, input: 0, output: 0, skipped: 0 };
for (const root of roots) {
	if (!existsSync(root)) continue;
	for (const run of readdirSync(root).filter((name) => name.startsWith('run-'))) {
		for (const scenario of readdirSync(path.join(root, run)).filter((name) => name.startsWith('q-'))) {
			const dir = path.join(root, run, scenario);
			const usageFile = path.join(dir, 'quality-usage.jsonl');
			if (!existsSync(usageFile) || statSync(usageFile).mtimeMs < sinceMs) continue;
			if (known.has(dir)) { totals.skipped += 1; continue; }
			const sessions = await runSessions(dir);
			if (sessions.length === 0) continue;
			// Every thread of the run in call order, the way the live mirror sees them.
			const calls = sessions.flatMap((session) => session.calls.map((call) => ({ ...call, session }))).sort((left, right) => left.at - right.at);
			totals.runs += 1;
			totals.threads += sessions.length;
			totals.calls += calls.length;
			for (const call of calls) { totals.input += call.last.inputTokens ?? 0; totals.output += call.last.outputTokens ?? 0; }
			let clock = new Date(calls[0].at);
			const mirror = new CodexUsageMirror({ home, source: SOURCE, now: () => clock });
			for (const session of sessions) mirror.startThread({ threadId: session.key, model: session.model, serviceTier: session.serviceTier });
			if (values.write) {
				for (const call of calls) {
					clock = new Date(call.at);
					mirror.usage({ threadId: call.session.key, last: call.last });
				}
				await mirror.flush();
				for (const file of mirror.files) if (existsSync(file)) manifest.files.push({ run: dir, path: file });
				totals.files += mirror.files.length;
			} else {
				// Dry run: count the files rotation would produce, without writing.
				const days = new Set(calls.map((call) => new Date(call.at).toDateString()));
				totals.files += days.size;
			}
		}
	}
}
if (values.write) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
console.log(JSON.stringify({ mode: values.write ? 'write' : 'dry-run', home, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), ...totals }));
