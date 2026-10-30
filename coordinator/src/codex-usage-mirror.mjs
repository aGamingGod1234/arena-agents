import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Coordinator Codex threads are ephemeral and run in an isolated CODEX_HOME, so Codex writes no rollout files and
// T3 Code's usage page never sees them. The mirror appends usage-only rollout records (session_meta, turn_context,
// thread_settings_applied, token_count) where T3 scans: no prompts, game content, paths or credentials.
// One file holds every thread of the process, so thousands of eval threads do not crowd T3's session import scan.
export const USAGE_MIRROR_SOURCE = 'arena-agents-usage-mirror';
const MAX_THREADS = 256;
const ROTATE_BYTES = 50 * 1024 * 1024;

export function codexUsageMirrorHome(env = process.env) {
	const configured = env.AA_CODEX_USAGE_HOME?.trim();
	return configured ? configured : path.join(os.homedir(), '.codex');
}

// Tests drive fake app-servers through the real transport; their fake usage must never reach the real usage page.
export function codexUsageMirrorEnabled(env = process.env) {
	const flag = env.AA_CODEX_USAGE_MIRROR?.trim();
	if (flag === '0' || flag === 'false' || flag === 'off') return false;
	if (flag === '1' || flag === 'true' || flag === 'on') return true;
	return env.NODE_TEST_CONTEXT === undefined;
}

export class CodexUsageMirror {
	#home;
	#now;
	#append;
	#mkdir;
	#source;
	#rotateBytes;
	#threads = new Map();
	#file = null;
	#files = [];
	#chain = Promise.resolve();
	#failed = false;

	constructor({ home = codexUsageMirrorHome(), now = () => new Date(), append = appendFile, makeDirectory = mkdir, source = USAGE_MIRROR_SOURCE, rotateBytes = ROTATE_BYTES } = {}) {
		this.#home = home;
		this.#now = now;
		this.#append = append;
		this.#mkdir = makeDirectory;
		this.#source = source;
		this.#rotateBytes = rotateBytes;
	}

	get files() { return [...this.#files]; }

	startThread({ threadId, model, serviceTier }) {
		if (typeof threadId !== 'string' || threadId.length === 0) return;
		// Threads that are never unsubscribed must not grow the map for a whole game.
		if (this.#threads.size >= MAX_THREADS) this.#threads.delete(this.#threads.keys().next().value);
		this.#threads.set(threadId, { model: text(model), serviceTier: text(serviceTier) ?? 'default', turnId: null, reportedTotal: null });
	}

	turn({ threadId, model, serviceTier }) {
		const thread = this.#threads.get(threadId);
		if (thread === undefined) return;
		thread.model = text(model) ?? thread.model;
		thread.serviceTier = text(serviceTier) ?? thread.serviceTier;
	}

	usage({ threadId, turnId, last, total = null }) {
		const thread = this.#threads.get(threadId);
		if (thread === undefined || this.#failed || thread.model === null) return;
		const usage = rolloutUsage(last);
		if (usage === null) return;
		// A repeated notification carries the same Codex cumulative total and must not be counted twice.
		const reported = total === null || typeof total !== 'object' ? null : JSON.stringify(total);
		if (reported !== null && reported === thread.reportedTotal) return;
		thread.reportedTotal = reported;
		thread.turnId = text(turnId) ?? thread.turnId ?? randomUUID();
		const at = this.#now();
		const lines = [];
		let file = this.#file;
		if (file === null || file.bytes >= this.#rotateBytes || file.day !== localDay(at).join('-')) {
			file = this.#openFile(at);
			lines.push({ timestamp: iso(at), type: 'session_meta', payload: {
				id: file.sessionId, timestamp: iso(at), originator: this.#source, source: this.#source, model_provider: 'openai', usage_only: true,
			} });
		}
		if (file.tier !== thread.serviceTier) {
			file.tier = thread.serviceTier;
			lines.push({ timestamp: iso(at), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: thread.serviceTier } } });
		}
		const context = `${threadId}\0${thread.turnId}\0${thread.model}`;
		if (file.context !== context) {
			file.context = context;
			lines.push({ timestamp: iso(at), type: 'turn_context', payload: { turn_id: thread.turnId, model: thread.model } });
		}
		// The cumulative counter is the sum of what this file reports, so T3's delta check reconciles across threads.
		file.total = Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, (file.total?.[key] ?? 0) + value]));
		lines.push({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: file.total } } });
		const data = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
		file.bytes += Buffer.byteLength(data);
		return this.#write(file, data);
	}

	endThread(threadId) { this.#threads.delete(threadId); }

	flush() { return this.#chain; }

	#openFile(at) {
		const sessionId = randomUUID();
		this.#file = { path: rolloutPath(this.#home, at, sessionId), sessionId, day: localDay(at).join('-'), bytes: 0, tier: null, context: null, total: null, created: false };
		this.#files.push(this.#file.path);
		return this.#file;
	}

	// One chain for the whole process keeps every file's records in the order their totals were computed.
	#write(file, data) {
		const first = !file.created;
		file.created = true;
		this.#chain = this.#chain.then(async () => {
			if (this.#failed) return;
			if (first) await this.#mkdir(path.dirname(file.path), { recursive: true });
			await this.#append(file.path, data);
		}).catch(() => { this.#failed = true; });
		return this.#chain;
	}
}

// One-shot `codex exec --ephemeral` calls (decision-eval judges) report a single usage object and write no rollout.
// They join the process's mirror file as one thread each.
export function mirrorCodexExecUsage({ model, serviceTier = 'default', usage }, mirror = defaultCodexUsageMirror()) {
	if (mirror === null || usage === null || typeof usage !== 'object') return Promise.resolve();
	try {
		const threadId = randomUUID();
		mirror.startThread({ threadId, model, serviceTier });
		const written = mirror.usage({ threadId, last: {
			inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens,
			reasoningOutputTokens: usage.reasoning_output_tokens,
		} });
		mirror.endThread(threadId);
		return written ?? Promise.resolve();
	} catch { return Promise.resolve(); }
}

let sharedMirror;
export function defaultCodexUsageMirror(env = process.env) {
	if (!codexUsageMirrorEnabled(env)) return null;
	sharedMirror ??= new CodexUsageMirror({ home: codexUsageMirrorHome(env) });
	return sharedMirror;
}

function rolloutUsage(value) {
	if (value === null || typeof value !== 'object') return null;
	const count = (field) => Number.isSafeInteger(field) && field > 0 ? field : 0;
	const input = count(value.inputTokens);
	const output = count(value.outputTokens);
	if (input + output === 0) return null;
	const cached = Math.min(input, count(value.cachedInputTokens));
	return {
		input_tokens: input,
		cached_input_tokens: cached,
		cache_write_input_tokens: Math.min(input - cached, count(value.cacheWriteInputTokens)),
		output_tokens: output,
		reasoning_output_tokens: Math.min(output, count(value.reasoningOutputTokens)),
		total_tokens: input + output,
	};
}

const pad = (value) => String(value).padStart(2, '0');
function localDay(date) { return [String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())]; }

function rolloutPath(home, at, sessionId) {
	const day = localDay(at);
	const stamp = `${day.join('-')}T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
	return path.join(home, 'sessions', ...day, `rollout-${stamp}-${sessionId}.jsonl`);
}

function iso(date) { return date.toISOString(); }
function text(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null; }
