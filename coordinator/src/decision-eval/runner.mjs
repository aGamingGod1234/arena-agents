import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ClaudeProviderService, resolveClaudeLaunch } from '../claude-service.mjs';
import { ClaudeToolServer } from '../claude-tool-server.mjs';
import { buildCodexArgs, CodexStdioTransport, resolveCodexLaunch } from '../codex-app-server.mjs';
import { CodexService } from '../codex-service.mjs';
import { canonicalEncodedInput, evalMinecraftWorkspace, sha256 } from './render.mjs';
import { buildContext, cannedChoice } from './match.mjs';
import { codexTokens, estimateTokenCostUsd } from './pricing.mjs';
import { DECISION_EVAL_SCHEMA_VERSION } from './schema.mjs';

/**
 * Sends rendered wakes to the play model through the production provider services and captures the tool calls it
 * makes without executing any of them.
 *
 * Each sample is a fresh provider session (a new Claude Code process, or a new Codex thread), so the model sees the
 * post-reset turn: production instructions and tools, then the rendered wake as its first user message. The runner
 * is the session's executeTool: a call matching the case's canned step gets that recorded result (presented by the
 * production tool-result path); any other call ends the sample, and the runner interrupts the turn. A call the
 * production normaliser rejects gets the production rejection and does not advance the script.
 */

export const DEFAULT_PLAY_PROFILE = Object.freeze({ provider: 'claude', model: 'claude-opus-5-5', effort: 'low' });
/**
 * Every eval session names its observation views with this id instead of a random one, so samples of a case (and a
 * baseline whose wake bytes are unchanged) send identical bytes and read the wake from the prompt cache. Pass
 * `viewSession: null` to an adapter for the production random id.
 */
export const EVAL_VIEW_SESSION = '00000000-0000-4000-8000-000000000000';
/**
 * Version of how a sample session is opened and fed (adapters, prewarm, wake delivery, view ids). Part of every cache key:
 * bump it whenever a change here could alter what the model receives or how a single-call sample ends.
 */
export const RUNNER_PROTOCOL = 'session-v1';
const GOAL_REVISION = 1;
const STOPPED_RESULT = Object.freeze({ state: 'FAILED', reasonCode: 'DECISION_EVAL_STOPPED', message: 'The evaluation ended at this call.' });
// Diagnostic probe mode (off by default, never part of a gate): reads, setup and notes get this fixed reply and the
// sample continues, so the first world action or intent after them is captured. The reply is not production-faithful.
export const PROBE_KINDS = Object.freeze(['capabilities', 'reflexes', 'inspect', 'observe', 'lookAround', 'explore_frontier', 'take_task', 'task_plan', 'task_memory', 'query_memory', 'action_status', 'program_status']);
const PROBE_ACTIONS = Object.freeze(['select_tool', 'select_item', 'look_at']);
export const PROBE_RESULT = Object.freeze({ state: 'SKIPPED', reasonCode: 'DECISION_EVAL_PROBE', message: 'Not executed in this evaluation: no fresh reads, setup or notes are available. Choose the next world action from the facts already shown.' });
export function probeCall(tool) {
	if (tool?.kind === 'sequence') return Array.isArray(tool.actions) && tool.actions.length > 0 && tool.actions.every(action => PROBE_ACTIONS.includes(action?.actionType));
	return PROBE_KINDS.includes(tool?.kind) || (tool?.kind === 'action' && PROBE_ACTIONS.includes(tool.actionType));
}
const RETRYABLE = new Set(['RATE_LIMITED', 'PROVIDER_START_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PLANNING_TIMEOUT', 'TURN_FAILED', 'SESSION_INVALIDATED']);
const RATE_LIMIT_TEXT = /rate.?limit|usage limit|overloaded|429|too many requests/i;
const execFileAsync = promisify(execFile);

export class DecisionEvalRunError extends Error {
	constructor(code, message) { super(message); this.code = code; }
}

/** Harness paths: hashed separately by the CLI, and overlaid onto older builds, so they never make a build dirty. */
export const HARNESS_PATHSPEC = Object.freeze(['--', '.', ':(exclude)coordinator/src/decision-eval', ':(exclude)scripts/decision-eval']);

/** The build under test: commit, dirty flag and a fingerprint over the commit and the rendered prefix. */
export async function buildFingerprint(repositoryRoot, prefix) {
	let commit = null;
	let dirty = null;
	try {
		commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
		dirty = (await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no', ...HARNESS_PATHSPEC], { cwd: repositoryRoot })).stdout.trim().length > 0;
	} catch { /* outside a repository the prefix still fingerprints the build */ }
	return { commit, dirty, prefixSha256: prefix?.prefixSha256 ?? null, fingerprint: sha256(`${commit ?? 'unknown'}\n${dirty ? 'dirty' : 'clean'}\n${prefix?.prefixSha256 ?? ''}`) };
}

/** Per-call usage from the production live_usage diagnostics; the latest report of each model call wins. */
function createUsageCollector({ provider, model, serviceTier = 'default' }) {
	const price = (tokens) => estimateTokenCostUsd(tokens, { provider, model, serviceTier });
	const calls = new Map();
	let total = null;
	return {
		onVerbose(stage, message) {
			if (stage !== 'live_usage') return;
			let value;
			try { value = JSON.parse(message); } catch { return; }
			if (provider === 'claude' || provider === 'opencode') {
				const id = value?.call?.modelCallId;
				if (typeof id !== 'string' || value.last === undefined) return;
				calls.set(id, {
					input: Math.max(0, (value.last.inputTokens ?? 0) - (value.last.cachedInputTokens ?? 0) - (value.last.cacheWriteInputTokens ?? 0)),
					cacheRead: value.last.cachedInputTokens ?? 0, cacheWrite: value.last.cacheWriteInputTokens ?? 0, output: value.last.outputTokens ?? 0,
					firstEventMs: value.call.firstEventMs ?? null, totalMs: value.call.totalMs ?? null,
				});
			} else {
				total = value;
			}
		},
		summary(providerCostUsd = null) {
			if (provider === 'claude' || provider === 'opencode') {
				const rows = [...calls.values()];
				const sum = (key) => rows.reduce((acc, row) => acc + row[key], 0);
				const usage = { input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output') };
				const prices = rows.map((row) => price(row));
				const estimate = prices.includes(null) ? null : prices.reduce((acc, value) => acc + value, 0);
				return {
					modelCalls: rows.length, inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, uncachedInputTokens: usage.input,
					cachedInputTokens: usage.cacheRead, cacheWriteInputTokens: usage.cacheWrite, outputTokens: usage.output,
					costUsd: providerCostUsd ?? (estimate === null ? null : round(estimate)), costSource: providerCostUsd !== null ? 'provider' : estimate === null ? 'none' : 'estimate',
					estimateUsd: estimate === null ? null : round(estimate),
					calls: rows,
				};
			}
			const tokens = total === null ? null : codexTokens(total);
			const estimate = tokens === null ? null : price(tokens);
			return {
				modelCalls: null, inputTokens: total?.inputTokens ?? null, cachedInputTokens: total?.cachedInputTokens ?? null, cacheWriteInputTokens: null,
				outputTokens: total?.outputTokens ?? null, reasoningOutputTokens: total?.reasoningOutputTokens ?? null,
				costUsd: estimate === null ? null : round(estimate), costSource: estimate === null ? 'none' : 'estimate',
			};
		},
	};
}

const round = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Claude Code through ClaudeProviderService, exactly as the coordinator launches it, with three observation taps:
 * the MCP tool server records each raw call, the spawned process records what is written to its stdin, and the
 * service's file writes record the system prompt it launched with.
 */
export function createClaudeAdapter({ model = DEFAULT_PLAY_PROFILE.model, effort = DEFAULT_PLAY_PROFILE.effort, root, spawn = nodeSpawn, terminate, executable, planningTimeoutMs = 120_000, interruptTimeoutMs, environment, viewSession = EVAL_VIEW_SESSION, viewIdMode = null } = {}) {
	const toolServer = new ClaudeToolServer();
	let workspace = null;
	let prepared = null;
	const minecraftWorkspace = { prepare: () => (prepared ??= workspace.prepare()) };
	return {
		provider: 'claude', model, effort, prewarm: true, viewSession, viewIdMode: viewSession === null ? 'random' : viewIdMode,
		async start() {
			this.viewIdMode ??= await claudeViewIdMode();
			await mkdir(root, { recursive: true });
			workspace = await evalMinecraftWorkspace(path.join(root, 'minecraft-agent'));
		},
		async stop() { await toolServer.stop(); },
		async open({ sampleId, recoverySummary, tap }) {
			const ids = viewIds(this.viewIdMode === 'translated' ? viewSession : null);
			const routedServer = {
				register: (options) => toolServer.register({ ...options, callTool: async (name, args, meta) => {
					const call = tap.raw(name, args, meta?.toolUseId ?? null);
					const content = ids.toModel(await options.callTool(name, ids.fromModel(args), meta));
					tap.responded(call, content);
					return content;
				} }),
				stop: async () => {},
			};
			const tappedSpawn = (command, args, options) => {
				const child = spawn(command, args, options);
				const write = child.stdin.write.bind(child.stdin);
				child.stdin.write = (chunk, ...rest) => {
					const text = ids.toModel(String(chunk));
					tap.stdin(text);
					return write(text === String(chunk) ? chunk : text, ...rest);
				};
				return child;
			};
			const service = new ClaudeProviderService({
				cwd: root, runtimeRoot: path.join(root, 'claude-agents'), models: [model], reasoningEfforts: [effort], planningTimeoutMs,
				...(executable === undefined ? {} : { executable }), ...(environment === undefined ? {} : { environment }),
				...(interruptTimeoutMs === undefined ? {} : { interruptTimeoutMs }),
			}, {
				minecraftWorkspace, toolServer: routedServer, spawn: tappedSpawn, ...(terminate === undefined ? {} : { terminate }),
				...(this.viewIdMode === 'option' ? { observationViewSession: viewSession } : {}),
				fs: { mkdir, rm, chmod, writeFile: async (file, content, options) => { if (/system-prompt-\d+\.md$/.test(file)) tap.instructions(content); return writeFile(file, content, options); } },
			});
			const agent = await service.createAgent({ agentId: sampleId, provider: 'claude', model, reasoningEffort: effort, serviceTier: 'priority' }, { recoverySummary, controlProtocol: 'native_tools' });
			await agent.setGoalRevision(GOAL_REVISION);
			return { agent, close: () => service.stop() };
		},
		/** The first user message Claude Code received: the encoded wake. */
		sentInput(lines) {
			for (const line of lines) {
				let value;
				try { value = JSON.parse(line); } catch { continue; }
				if (value?.type === 'user' && typeof value.message?.content === 'string') return value.message.content;
			}
			return null;
		},
	};
}

/**
 * OpenCode through OpenCodeProviderService, as the coordinator launches it, with the same taps as Claude: raw MCP calls,
 * the prompt text sent to the session, and the agent prompt. Each sample's agent writes its own config and gets its own
 * OpenCode instance and session; the instances share a few long-lived server processes (opencode-pool.mjs) unless
 * `pooled` is false, which starts one server process per sample as the coordinator does.
 */
export function createOpenCodeAdapter({ model, effort = 'low', root, planningTimeoutMs = 120_000, viewSession = EVAL_VIEW_SESSION, pooled = true } = {}) {
	const toolServer = new ClaudeToolServer();
	let workspace = null;
	let prepared = null;
	let pool = null;
	const minecraftWorkspace = { prepare: () => (prepared ??= workspace.prepare()) };
	return {
		provider: 'opencode', model, effort, prewarm: true, viewSession, pooled,
		async start() {
			await mkdir(root, { recursive: true });
			workspace = await evalMinecraftWorkspace(path.join(root, 'minecraft-agent'));
			if (pooled) {
				const { OpenCodeServerPool } = await import('./opencode-pool.mjs');
				pool = new OpenCodeServerPool();
			}
		},
		async stop() { await pool?.stop(); await toolServer.stop(); },
		poolStats() { return pool === null ? null : { ...pool.stats }; },
		async open({ sampleId, recoverySummary, tap }) {
			const routedServer = {
				register: (options) => toolServer.register({ ...options, callTool: async (name, args, meta) => {
					const call = tap.raw(name, args, null);
					const content = await options.callTool(name, args, meta);
					tap.responded(call, content);
					return content;
				} }),
				stop: async () => {},
			};
			// Loaded only for OpenCode players, so the harness still runs on builds from before the OpenCode provider.
			const { OpenCodeProviderService, httpJsonRequest } = await import('../opencode-service.mjs');
			const service = new OpenCodeProviderService({ models: [model], reasoningEfforts: [effort], planningTimeoutMs }, {
				minecraftWorkspace, toolServer: routedServer, observationViewSession: viewSession,
				...(pool === null ? {} : pool.playerDependencies({ request: httpJsonRequest })),
				onPromptSent: (text) => tap.stdin(JSON.stringify({ type: 'user', text })),
				onSystemPrompt: (text) => tap.instructions(text),
			});
			const agent = await service.createAgent({ agentId: sampleId, provider: 'opencode', model, reasoningEffort: effort, serviceTier: 'priority' }, { recoverySummary, controlProtocol: 'native_tools' });
			await agent.setGoalRevision(GOAL_REVISION);
			return { agent, close: () => service.stop() };
		},
		/** The first prompt OpenCode received: the encoded wake. */
		sentInput(lines) {
			for (const line of lines) {
				let value;
				try { value = JSON.parse(line); } catch { continue; }
				if (value?.type === 'user' && typeof value.text === 'string') return value.text;
			}
			return null;
		},
	};
}

/**
 * Codex through CodexService on the production app-server transport. One app-server serves every sample; each sample
 * is its own ephemeral thread. Raw tool arguments come from the transport's item/tool/call requests.
 */
export function createCodexAdapter({ model, effort, serviceTier = 'default', root, planningTimeoutMs = 120_000, transport = null, minecraftWorkspace = null, viewSession = EVAL_VIEW_SESSION } = {}) {
	let service = null;
	// Codex call ids are unique per call, so raw arguments are kept by call id until the sample's executeTool asks.
	const rawCalls = new Map();
	const launchProfile = { model, reasoningEffort: effort, serviceTier, cwd: root };
	return {
		provider: 'codex', model, effort, serviceTier, viewSession,
		async start() {
			await mkdir(root, { recursive: true });
			// Codex threads need the operator's login, which production also copies into the dedicated workspace.
			const workspace = minecraftWorkspace ?? await evalMinecraftWorkspace(path.join(root, 'minecraft-agent'), { syncCodexAuth: true });
			const appServer = transport ?? new CodexStdioTransport(launchProfile);
			appServer.on('serverRequest', (request) => {
				if (request?.method !== 'item/tool/call') return;
				if (typeof request.params?.callId === 'string') rawCalls.set(request.params.callId, { name: request.params.tool, args: request.params.arguments ?? {} });
			});
			service = new CodexService({ cwd: root, planningTimeoutMs, serviceTier, launchProfile }, { transport: appServer, minecraftWorkspace: workspace, ...(viewSession === null ? {} : { observationViewSession: viewSession }) });
			await service.start();
		},
		async stop() { await service?.stop(); },
		async open({ sampleId, recoverySummary, tap }) {
			const agent = await service.createAgent({ agentId: sampleId, provider: 'codex', model, reasoningEffort: effort, serviceTier }, { recoverySummary, controlProtocol: 'native_tools' });
			await agent.setGoalRevision(GOAL_REVISION);
			const seen = new Set();
			tap.lookupRaw = (callId) => { seen.add(callId); return rawCalls.get(callId) ?? null; };
			return { agent, close: async () => { for (const callId of seen) rawCalls.delete(callId); await service.removeAgent(sampleId); } };
		},
		sentInput() { return null; },
	};
}

/** 'option' when this build's Claude service takes observationViewSession, else 'translated' (see viewIds). */
async function claudeViewIdMode() {
	const source = await readFile(new URL('../claude-service.mjs', import.meta.url), 'utf8');
	return source.includes('observationViewSession') ? 'option' : 'translated';
}

/**
 * Builds older than the observationViewSession option name views with a random id per session. For them the adapter
 * swaps that session's id for the eval id in everything the model reads (Claude Code's stdin, tool results) and back in
 * what the model sends (tool arguments), so the model sees the bytes a build with the option sends and repeated samples
 * still share the prompt cache. The production code of the build is untouched. With no eval id this is the identity.
 */
export function viewIds(evalSession) {
	let session = null;
	const swap = (value, from, to) => {
		if (from === null || to === null) return value;
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		if (text === undefined || !text.includes(`observation-${from}-`)) return value;
		const swapped = text.replaceAll(`observation-${from}-`, `observation-${to}-`);
		return typeof value === 'string' ? swapped : JSON.parse(swapped);
	};
	return {
		toModel(value) {
			if (evalSession === null) return value;
			if (session === null) {
				const found = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').match(/observation-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d+/);
				if (found !== null && found[1] !== evalSession) session = found[1];
			}
			return swap(value, session, evalSession);
		},
		fromModel: (value) => evalSession === null ? value : swap(value, evalSession, session),
	};
}

function isRateLimit(error) {
	return error?.code === 'RATE_LIMITED' || RATE_LIMIT_TEXT.test(String(error?.message ?? ''));
}

/** One sample: open a fresh session, send the rendered wake, follow the canned script, stop at the first off-script call. */
export async function runSample(adapter, { testCase, rendered, sample, sampleId, maxCalls = null, probe = false, now = () => performance.now() }) {
	const steps = testCase.steps ?? [];
	const limit = maxCalls ?? steps.length + 4;
	const whenContext = buildContext(testCase);
	const calls = [];
	const byToolUse = new Map();
	const stdinLines = [];
	let instructions = null;
	let stop = null;
	let stopping = null;
	let session = null;
	let accepted = 0;
	let text = null;
	const usage = createUsageCollector(adapter);
	const startedAt = now();
	let firstCallAt = null;
	const record = (name, args, toolUseId) => {
		const call = { index: calls.length, name: String(name).replace(/^mcp__minecraft__/, ''), args: args ?? {}, normalized: null, normalizeError: null, canned: null, atMs: Math.round(now() - startedAt) };
		firstCallAt ??= now();
		calls.push(call);
		if (toolUseId !== null) byToolUse.set(toolUseId, call);
		return call;
	};
	const requestStop = (reason) => {
		stop ??= reason;
		stopping ??= Promise.resolve().then(() => session?.agent.interrupt()).catch(() => {});
	};
	const tap = {
		raw: (name, args, toolUseId) => record(name, args, toolUseId),
		responded: (call, content) => {
			// A call the production normaliser rejected never reached executeTool; its rejection went to the model.
			if (call.normalized === null && call.normalizeError === null) {
				call.normalizeError = String(content?.content?.[0]?.text ?? 'rejected').slice(0, 512);
				if (calls.length >= limit) requestStop('max_calls');
			}
		},
		stdin: (chunk) => { for (const line of chunk.split('\n')) if (line.trim()) stdinLines.push(line); },
		instructions: (content) => { instructions = content; },
		lookupRaw: null,
	};
	const executeTool = async (request) => {
		// Claude: the MCP tap recorded this call under its tool-use id (or, without one, as the newest unclaimed call).
		// OpenCode names its call id only after the MCP request, so its raw call is the newest unclaimed one.
		const unclaimed = () => calls.findLast((entry) => entry.normalized === null && entry.normalizeError === null);
		let call = request.callId == null ? unclaimed() : byToolUse.get(request.callId) ?? unclaimed();
		if (call === undefined) {
			const raw = tap.lookupRaw?.(request.callId) ?? { name: request.tool?.kind ?? 'unknown', args: {} };
			call = record(raw.name, raw.args, null);
		}
		call.normalized = request.tool;
		if (stop !== null) return STOPPED_RESULT;
		const step = accepted < steps.length ? steps[accepted] : null;
		if (probe && step === null && calls.length < limit && probeCall(request.tool)) { call.probe = true; return structuredClone(PROBE_RESULT); }
		const choiceIndex = step === null ? -1 : cannedChoice(step, call, whenContext);
		if (choiceIndex < 0 || calls.length >= limit) {
			requestStop(calls.length >= limit && choiceIndex >= 0 ? 'max_calls' : step === null ? 'script_end' : 'off_script');
			return STOPPED_RESULT;
		}
		call.canned = { step: accepted, choice: choiceIndex };
		accepted += 1;
		return structuredClone(step.canned[choiceIndex].result);
	};
	let providerCostUsd = null;
	let error = null;
	let bootMs = null;
	let modelStartedAt = null;
	try {
		session = await adapter.open({ sampleId, recoverySummary: rendered.recoverySummary ?? null, tap });
		// Claude Code boots and lists the Minecraft tools first (production prewarm, no model turn), so model latency
		// excludes process start-up.
		if (adapter.prewarm === true) await session.agent.prewarm({ goalRevision: GOAL_REVISION });
		bootMs = Math.round(now() - startedAt);
		modelStartedAt = now();
		try {
			const result = await session.agent.act(rendered.input, {
				goalRevision: GOAL_REVISION, executeTool,
				onVerbose: (stage, message) => {
					usage.onVerbose(stage, message);
					if (stage === 'agent_message' && text === null) text = String(message).slice(0, 2_000);
				},
			});
			stop ??= 'turn_end';
			if (Number.isFinite(result?.usage?.costUsd)) providerCostUsd = result.usage.costUsd;
		} catch (caught) {
			if (stop === null) { error = caught; stop = 'error'; }
		}
		await stopping;
	} catch (caught) {
		error = caught;
		stop = 'error';
	} finally {
		await session?.close().catch(() => {});
	}
	const sent = adapter.sentInput(stdinLines);
	return {
		schemaVersion: DECISION_EVAL_SCHEMA_VERSION, kind: 'decision-eval-sample',
		caseId: testCase.id, family: testCase.family, causeClass: testCase.causeClass, split: testCase.split, sample,
		provider: adapter.provider, model: adapter.model, effort: adapter.effort, ...(adapter.viewIdMode ? { viewIdMode: adapter.viewIdMode } : {}),
		rendered: {
			inputSha256: rendered.inputSha256, inputBytes: rendered.inputBytes, encodedSha256: rendered.encodedSha256, encodedBytes: rendered.encodedBytes,
			trigger: rendered.trigger,
			...(instructions === null ? {} : { sentInstructionsSha256: sha256(instructions) }),
			...(sent === null ? {} : { sentSha256: sha256(canonicalEncodedInput(sent)), sentMatches: sha256(canonicalEncodedInput(sent)) === rendered.encodedSha256 }),
		},
		calls, stop, text,
		error: error === null ? null : { code: String(error?.code ?? 'ERROR'), message: String(error?.message ?? error).slice(0, 512), rateLimited: isRateLimit(error) },
		usage: usage.summary(providerCostUsd),
		latency: {
			totalMs: Math.round(now() - startedAt), bootMs,
			firstCallMs: firstCallAt === null ? null : Math.round(firstCallAt - startedAt),
			modelFirstCallMs: firstCallAt === null || modelStartedAt === null ? null : Math.round(firstCallAt - modelStartedAt),
		},
		grade: null,
	};
}

/**
 * Runs tasks with at most `concurrency` in flight. A rate-limited task waits out a shared backoff (every worker pauses
 * until it passes) and retries; other retryable failures retry once. Reports achieved concurrency.
 */
export async function runPool(tasks, { concurrency, attempt, maxAttempts = 5, baseBackoffMs = 2_000, maxBackoffMs = 60_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => performance.now(), onResult = () => {} }) {
	const results = new Array(tasks.length);
	let next = 0;
	let active = 0;
	let maxActive = 0;
	let activeArea = 0;
	let lastChange = now();
	let pauseUntil = 0;
	const rateLimitEvents = [];
	const startedAt = now();
	const mark = (delta) => {
		const at = now();
		activeArea += active * (at - lastChange);
		lastChange = at;
		active += delta;
		maxActive = Math.max(maxActive, active);
	};
	const worker = async () => {
		for (;;) {
			const index = next;
			if (index >= tasks.length) return;
			next += 1;
			let result;
			for (let tries = 1; ; tries += 1) {
				const wait = pauseUntil - now();
				if (wait > 0) await sleep(wait);
				const queuedAt = now();
				mark(1);
				try { result = await attempt(tasks[index], { tries }); } finally { mark(-1); }
				result.latency = { ...result.latency, attempts: tries, queueMs: Math.round(queuedAt - startedAt) };
				const failure = result.error;
				if (failure === null || failure === undefined || tries >= maxAttempts) break;
				if (failure.rateLimited) {
					const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (tries - 1)) * (0.75 + Math.random() * 0.5);
					pauseUntil = Math.max(pauseUntil, now() + backoff);
					rateLimitEvents.push({ atMs: Math.round(now() - startedAt), task: index, tries, backoffMs: Math.round(backoff) });
					continue;
				}
				if (!RETRYABLE.has(failure.code) || tries >= 2) break;
			}
			results[index] = result;
			onResult(result, index);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
	mark(0);
	const wallMs = now() - startedAt;
	return { results, wallMs: Math.round(wallMs), maxConcurrency: maxActive, meanConcurrency: wallMs > 0 ? Math.round((activeArea / wallMs) * 100) / 100 : 0, rateLimitEvents };
}

export function defaultRunRoot() { return path.join(os.tmpdir(), 'arena-decision-eval'); }

/**
 * The provider runtime the samples ran on: the resolved CLI and the version it reports. The CLI adds its own system
 * prompt and tool handling around the rendered prefix, so a CLI upgrade can change answers with no repository change.
 */
export async function providerRuntime(provider, { executable, model = 'gpt-6.1-sol', effort = 'low', exec = execFileAsync, resolve = provider === 'claude' ? resolveClaudeLaunch : resolveCodexLaunch } = {}) {
	let launch;
	try {
		if (provider === 'opencode') launch = { command: executable ?? 'opencode', args: [], environment: process.env };
		else if (provider === 'claude') launch = resolve({ ...(executable === undefined ? {} : { executable }) });
		else {
			// The Codex launch carries the app-server arguments; only the CLI itself is asked for its version.
			const config = { model, reasoningEffort: effort, serviceTier: 'default' };
			launch = resolve(config);
			launch = { ...launch, args: launch.args.slice(0, launch.args.length - buildCodexArgs(config).length) };
		}
	}
	catch (error) { return { provider, command: null, version: null, error: String(error?.message ?? error).slice(0, 200) }; }
	let version = null;
	try {
		const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(launch.command);
		const { stdout } = await exec(launch.command, [...(launch.args ?? []), '--version'], { timeout: 20_000, env: launch.environment, shell, windowsHide: true });
		version = String(stdout).trim().split(String.fromCharCode(10))[0].trim().slice(0, 200) || null;
	} catch (error) { return { provider, command: launch.command, version: null, error: String(error?.message ?? error).slice(0, 200) }; }
	return { provider, command: launch.command, version };
}

/**
 * Identity of a cached sample set: everything that decides the answers. A change in any part makes a new key.
 * maxCalls is the effective limit ("steps+4" when unset); runtime is providerRuntime(); epoch is the caller's cache epoch
 * (bump it to retire every cached sample, for example when a provider-side model alias may have moved).
 */
export function cacheIdentity({ fingerprint, harnessSha256, dirtyDiffSha256 = '', provider, model, effort, viewSession, maxCalls, runtime, epoch }) {
	return sha256(JSON.stringify({ v: 2, fingerprint, harnessSha256, dirtyDiffSha256, provider, model, effort, viewSession: viewSession ?? 'random-view-id',
		maxCalls: maxCalls ?? 'steps+4', runtime: runtime ? { command: runtime.command ?? null, version: runtime.version ?? null } : null, epoch: String(epoch ?? '') }));
}
