import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { arenaScriptDiagnosticFields, arenaScriptDiagnosticSummary } from './arena-script/errors.mjs';
import { terminateChildProcess, spawnOwnedProcess as nodeSpawn } from './child-process-lifecycle.mjs';
import { ClaudeToolServer } from './claude-tool-server.mjs';
import { goalSpecInstructions, isNativeBodyTool, nativeInstructions, nativeRecoveryInstructions, nativeToolSchedulingClass, presentNativeToolResult, recoveryInstructions } from './codex-service.mjs';
import { DEFAULT_CONTEXT_ROTATION_TOKENS, MIN_TURNS_BETWEEN_ROTATIONS, ToolDigests } from './context-carry-over.mjs';
import { parseDecision } from './decision-parser.mjs';
import { FailureCarryOver, correlateFailureEvent } from './failure-carry-over.mjs';
import { toolErrorResult } from './failure-schema.mjs';
import { ModelObservationViews, encodeNativeEventInput } from './model-fact-encoding.mjs';
import { NativeCallLog } from './native-call-log.mjs';
import { NATIVE_AGENT_INSTRUCTIONS, normalizeMinecraftToolCall, presentedTool, toolResultContent } from './native-minecraft-tools.mjs';
import { PLANNER_OUTPUT_SCHEMA, PLANNER_SYSTEM_PROMPT } from './prompts.mjs';
import { createProviderChildEnvironment } from './provider-environment.mjs';
import { createExecutionSettings } from './provider-identity.mjs';
import { createSessionMetadata, profileFingerprint } from './provider-session.mjs';
import { recordProviderTurn } from './provider-turn-recorder.mjs';
import { reportVisibleOutput } from './verbose-output.mjs';

/**
 * OpenCode's free models, played through the OpenCode client itself: the free tier only serves requests from
 * OpenCode, so the coordinator drives a headless `opencode serve` per agent over its HTTP API and event stream.
 * The Minecraft tools reach it through the same loopback MCP server Claude uses, one bearer token per body.
 */
export const OPENCODE_MODELS = Object.freeze({
	'opencode/deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash (free)',
	'opencode/glm-5.3-flash-free': 'GLM 5.3 Flash (free)',
});
// The free models expose exactly these OpenCode variants (models.dev); effort maps to the variant of the same name.
export const OPENCODE_REASONING_EFFORTS = Object.freeze(['low', 'high', 'max']);

const CONTROL_PROTOCOLS = new Set(['arena_script', 'native_tools', 'goal_spec']);
const MCP_SERVER_NAME = 'minecraft';
const AGENT_NAME = 'arena';
const DEFAULT_PLANNING_TIMEOUT_MS = 120_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_DECISION_BYTES = 256 * 1_024;
const MAX_PUBLIC_AGENT_MESSAGE_CHARS = 1_280;
// runProgram and other long tools hold their MCP request for minutes, as with Claude's MCP_TOOL_TIMEOUT.
const MCP_TOOL_TIMEOUT_MS = 600_000;
const CARRY_OVER_TOOL_CALLS = 6;
const CARRY_OVER_CONVERSATION = 6;
const MAX_TRACED_TOOLS = 8;
const STREAM_PROGRESS_INTERVAL_MS = 1_000;
// Free-tier limits: a failed call that OpenCode gave up on is resumed after a growing wait.
export const RATE_LIMIT_RETRY = Object.freeze({ maxAttempts: 6, baseMs: 5_000, maxMs: 60_000 });
// OpenCode retries retryable API errors itself; past this many attempts in one turn the turn fails as rate limited.
const MAX_PROVIDER_RETRIES_PER_TURN = 10;
const RETRY_CONTINUATION = 'The previous model call failed before it finished (provider limit). Continue the current turn from where it stopped.';
// A tool call's MCP request can arrive just before OpenCode's event naming its call id.
const CALL_ID_WAIT_MS = 50;
const IDLE_EVENT_WAIT_MS = 1_000;
// A session started by a mid-turn handoff must grow by this share of the threshold before it rotates again.
const MIN_ROTATION_GROWTH_SHARE = 0.25;

/**
 * Built-in OpenCode tools stay listed (the free tier rejects requests whose built-in tools were removed) and are
 * blocked by permission. `read` must stay listed, so it is denied for every path except one that never exists.
 */
export const OPENCODE_PERMISSION = Object.freeze({
	edit: 'deny', bash: 'deny', webfetch: 'deny', websearch: 'deny', codesearch: 'deny', task: 'deny', skill: 'deny',
	todowrite: 'deny', todoread: 'deny', question: 'deny', lsp: 'deny', glob: 'deny', grep: 'deny', list: 'deny',
	external_directory: 'deny', doom_loop: 'deny',
	read: Object.freeze({ '*': 'deny', '/nonexistent-arena-opencode-path': 'allow' }),
});

const OPENCODE_TOOL_NOTE = `OpenCode exposes the Minecraft tools as ${'`'}${MCP_SERVER_NAME}_<name>${'`'}; every tool name in these instructions refers to that tool (for example observe is ${MCP_SERVER_NAME}_observe). OpenCode's own file tools are blocked here; use only the ${MCP_SERVER_NAME} tools. A tool result may end with newer coordinator events for the same body; treat them exactly like the turn input.`;

export class OpenCodeProviderError extends Error {
	constructor(code, message, options = undefined) {
		super(message, options);
		this.name = 'OpenCodeProviderError';
		this.code = code;
	}
}

export class OpenCodeProviderService {
	#config;
	#dependencies;
	#minecraftWorkspace;
	#workspaceManager;
	#toolServer;
	#ownsToolServer;
	#agents = new Map();
	#creating = new Map();
	#replacing = new Map();
	#sessionGenerations = new Map();
	#lifecycleGeneration = 0;

	constructor(config, dependencies = {}) {
		this.#config = validateServiceConfig(config);
		this.#dependencies = {
			spawn: dependencies.spawn ?? nodeSpawn,
			terminate: dependencies.terminate ?? terminateChildProcess,
			fs: { mkdir, mkdtemp, writeFile, rm, chmod, ...(dependencies.fs ?? {}) },
			schedule: dependencies.schedule ?? setTimeout,
			cancelSchedule: dependencies.cancelSchedule ?? clearTimeout,
			request: dependencies.request ?? httpJsonRequest,
			openEvents: dependencies.openEvents ?? openEventStream,
			observationViewSession: dependencies.observationViewSession ?? null,
			onPromptSent: dependencies.onPromptSent ?? null,
			onSystemPrompt: dependencies.onSystemPrompt ?? null,
		};
		this.#minecraftWorkspace = dependencies.minecraftWorkspace ?? null;
		if (this.#minecraftWorkspace !== null && typeof this.#minecraftWorkspace.prepare !== 'function') throw new TypeError('minecraftWorkspace must expose prepare()');
		this.#workspaceManager = dependencies.workspaceManager ?? null;
		if (this.#workspaceManager !== null && typeof this.#workspaceManager.prepare !== 'function') throw new TypeError('workspaceManager must expose prepare(provider, agentId)');
		this.#ownsToolServer = dependencies.toolServer === undefined;
		this.#toolServer = dependencies.toolServer ?? new ClaudeToolServer();
		this.catalog = new OpenCodeCatalog(this.#config, typeof dependencies.discoverModels === 'function' ? dependencies.discoverModels : null);
	}

	async start() {}
	get agentIds() { return [...this.#agents.keys()]; }
	getAgent(agentId) { return this.#agents.get(agentId) ?? null; }

	async createAgent(profileValue, { recoverySummary = null, controlProtocol = 'native_tools' } = {}) {
		const lifecycleGeneration = this.#lifecycleGeneration;
		const profile = validateProfile(profileValue, this.#config);
		const protocol = validateControlProtocol(controlProtocol);
		const replacing = this.#replacing.get(profile.agentId);
		if (replacing !== undefined) { assertSameSession(replacing, profile, protocol); return replacing.promise; }
		const existing = this.#agents.get(profile.agentId);
		if (existing !== undefined) {
			if (!existing.matchesProfile(profile) || !existing.matchesControlProtocol(protocol)) throw profileConflict(profile.agentId);
			return existing;
		}
		const creating = this.#creating.get(profile.agentId);
		if (creating !== undefined) { assertSameSession(creating, profile, protocol); return creating.promise; }
		const promise = this.#createAgentOnce(profile, recoverySummary, protocol, lifecycleGeneration);
		this.#creating.set(profile.agentId, { profile, controlProtocol: protocol, promise });
		try { return await promise; } finally { this.#creating.delete(profile.agentId); }
	}

	async replaceAgent(profileValue, { recoverySummary = null, controlProtocol = 'native_tools', expectedSessionGeneration = null } = {}) {
		const lifecycleGeneration = this.#lifecycleGeneration;
		const profile = validateProfile(profileValue, this.#config);
		const protocol = validateControlProtocol(controlProtocol);
		const replacing = this.#replacing.get(profile.agentId);
		if (replacing !== undefined) { assertSameSession(replacing, profile, protocol); return replacing.promise; }
		const creating = this.#creating.get(profile.agentId);
		if (creating !== undefined) assertSameSession(creating, profile, protocol);
		const existing = this.#agents.get(profile.agentId);
		if (existing !== undefined) {
			if (!existing.matchesProfile(profile) || !existing.matchesControlProtocol(protocol)) throw profileConflict(profile.agentId);
			if (expectedSessionGeneration !== null && existing.sessionGeneration !== expectedSessionGeneration) {
				throw new OpenCodeProviderError('STALE_SESSION_GENERATION', 'OpenCode replacement target is no longer current');
			}
		}
		const promise = (async () => {
			if (creating !== undefined) await creating.promise.catch(() => {});
			const owned = this.#agents.get(profile.agentId);
			if (owned !== undefined) { this.#agents.delete(profile.agentId); await owned.dispose(); }
			return this.#createAgentOnce(profile, recoverySummary, protocol, lifecycleGeneration);
		})();
		const entry = { profile, controlProtocol: protocol, promise };
		this.#replacing.set(profile.agentId, entry);
		try { return await promise; } finally { if (this.#replacing.get(profile.agentId) === entry) this.#replacing.delete(profile.agentId); }
	}

	async #createAgentOnce(profile, recoverySummary, controlProtocol, lifecycleGeneration) {
		this.catalog.assertSupported(profile.model, profile.reasoningEffort, profile.serviceTier);
		const summary = normalizeRecoverySummary(recoverySummary);
		let systemPrompt;
		try {
			if (this.#minecraftWorkspace !== null) {
				// Same AGENTS.md and minecraft-control skill text Codex and Claude receive, carried in the agent prompt.
				const prepared = await this.#minecraftWorkspace.prepare();
				if (prepared === null || typeof prepared !== 'object' || typeof prepared.cwd !== 'string') throw new TypeError('minecraftWorkspace.prepare() must return cwd');
				systemPrompt = systemPromptFor(controlProtocol, summary, prepared.instructions?.trim() ?? '', prepared.skillInstructions?.trim() ?? '');
			} else {
				if (this.#workspaceManager !== null) await this.#workspaceManager.prepare(profile.provider, profile.agentId);
				systemPrompt = systemPromptFor(controlProtocol, summary, '', '');
			}
		} catch (error) {
			throw new OpenCodeProviderError('PROVIDER_UNAVAILABLE', `Could not prepare the OpenCode agent workspace: ${error?.message ?? String(error)}`, { cause: error });
		}
		assertLifecycleActive(lifecycleGeneration, this.#lifecycleGeneration);
		const sessionGeneration = (this.#sessionGenerations.get(profile.agentId) ?? 0) + 1;
		this.#sessionGenerations.set(profile.agentId, sessionGeneration);
		try { this.#dependencies.onSystemPrompt?.(systemPrompt); } catch { /* observation only */ }
		const agent = new OpenCodeAgent(profile, {
			...this.#dependencies,
			config: this.#config,
			controlProtocol,
			systemPrompt,
			toolServer: this.#toolServer,
			sessionGeneration,
			resetReason: sessionGeneration > 1 ? 'session_replaced' : null,
			onInvalidated: (invalidated) => { if (this.#agents.get(invalidated.agentId) === invalidated) this.#agents.delete(invalidated.agentId); },
		});
		if (lifecycleGeneration !== this.#lifecycleGeneration) {
			await agent.dispose();
			throw new OpenCodeProviderError('PROVIDER_STOPPED', 'OpenCode service lifecycle was stopped');
		}
		this.#agents.set(profile.agentId, agent);
		return agent;
	}

	async prewarmAgent(profileValue, { goalRevision = 0 } = {}) {
		const agent = await this.createAgent(profileValue, { controlProtocol: 'native_tools' });
		await agent.setGoalRevision(goalRevision);
		await agent.prewarm({ goalRevision });
		return agent;
	}

	async removeAgent(agentId) {
		const creating = this.#creating.get(agentId);
		if (creating !== undefined) await creating.promise.catch(() => {});
		const replacing = this.#replacing.get(agentId);
		if (replacing !== undefined) await replacing.promise.catch(() => {});
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return false;
		this.#agents.delete(agentId);
		await agent.dispose();
		return true;
	}

	async reconcile(records, { signal } = {}) {
		if (!Array.isArray(records)) throw new TypeError('opencode reconciliation records must be an array');
		assertReconciliationActive(signal);
		const desiredIds = new Set(records.map((record) => record.agentId));
		const removed = [];
		for (const agentId of this.#agents.keys()) {
			assertReconciliationActive(signal);
			if (!desiredIds.has(agentId)) {
				await this.removeAgent(agentId);
				assertReconciliationActive(signal);
				removed.push(agentId);
			}
		}
		// Saved agents are checked against the discovered models, so discover first.
		const catalog = await this.catalog.refresh();
		const valid = [];
		const invalid = [];
		for (const record of records) {
			try {
				const profile = validateProfile(record, this.#config);
				this.catalog.assertSupported(profile.model, profile.reasoningEffort, profile.serviceTier);
				valid.push(profile);
			} catch (error) { invalid.push({ profile: record, code: error.code ?? 'INVALID_PROFILE', message: error.message }); }
		}
		return { valid, invalid, removed, catalog };
	}

	async stop() {
		this.#lifecycleGeneration += 1;
		await Promise.allSettled([...this.#creating.values(), ...this.#replacing.values()].map((entry) => entry.promise));
		this.#creating.clear();
		this.#replacing.clear();
		const agents = [...this.#agents.values()];
		this.#agents.clear();
		await Promise.allSettled(agents.map((agent) => agent.dispose()));
		if (this.#ownsToolServer) await this.#toolServer.stop();
	}
}

class OpenCodeCatalog {
	#config;
	#discover;
	#discovered = null;
	#listPrices = {};
	#refreshing = null;
	stale = false;
	/** With a discoverer the playable models come from `opencode models`; the configured list is the fallback. */
	constructor(config, discover = null) { this.#config = config; this.#discover = discover; this.stale = discover !== null; }
	async refresh({ force = false } = {}) {
		if (this.#discover === null || (!force && !this.stale && this.#discovered !== null)) return this.snapshot();
		this.#refreshing ??= Promise.resolve().then(() => this.#discover()).then((result) => {
			const models = Array.isArray(result?.models) ? result.models.filter((model) => typeof model?.id === 'string' && model.id.includes('/')) : [];
			if (models.length > 0) { this.#discovered = models; this.#listPrices = result.listPrices ?? {}; }
			this.stale = models.length === 0;
		}, () => { this.stale = true; }).finally(() => { this.#refreshing = null; });
		await this.#refreshing;
		return this.snapshot();
	}
	/** USD per million tokens of a free model's paid twin, keyed by model id. */
	get listPrices() { return { ...this.#listPrices }; }
	#models() {
		if (this.#discovered !== null) return this.#discovered.map((model) => ({ id: model.id, label: OPENCODE_MODELS[model.id] ?? model.label, efforts: model.efforts, free: model.free === true }));
		return this.#config.models.map((model) => ({ id: model, label: OPENCODE_MODELS[model] ?? model, efforts: this.#config.reasoningEfforts, free: /-free$/.test(model) }));
	}
	snapshot() {
		return {
			provider: 'opencode',
			refreshedAtEpochMs: Date.now(),
			models: this.#models().map((model) => ({
				id: model.id, model: model.id, displayName: model.label,
				reasoningEfforts: [...model.efforts], serviceTiers: ['priority'], free: model.free,
				...(this.#listPrices[model.id] === undefined ? {} : { listPrice: { ...this.#listPrices[model.id] } }),
			})),
		};
	}
	assertSupported(model, reasoningEffort, serviceTier = 'priority') {
		const found = this.#models().find((candidate) => candidate.id === model);
		if (found === undefined) throw new OpenCodeProviderError('UNSUPPORTED_MODEL', `opencode model '${model}' is not available`);
		if (!found.efforts.includes(reasoningEffort)) throw new OpenCodeProviderError('UNSUPPORTED_THINKING', `opencode model '${model}' does not support effort '${reasoningEffort}'`);
		if (serviceTier !== 'priority') throw new OpenCodeProviderError('UNSUPPORTED_SERVICE_TIER', `opencode service tier '${serviceTier}' is not supported`);
	}
}

/**
 * One `opencode serve` per agent keeps its session warm across turns; a turn is one prompt on that session and ends
 * when OpenCode answers it. Steers reach the model with the next tool result, as with Claude.
 */
class OpenCodeAgent {
	#profile;
	#config;
	#controlProtocol;
	#systemPrompt;
	#toolServer;
	#spawn;
	#terminate;
	#fs;
	#schedule;
	#cancelSchedule;
	#request;
	#openEvents;
	#onPromptSent;
	#onInvalidated;
	#sessionGeneration;
	#resetReason;
	#executionSettings;
	#observationViews;
	#goalRevision = 0;
	#sessionState = 'cold';
	#server = null;
	#serverStart = null;
	#sessionId = null;
	#active = null;
	#oneShot = null;
	#inFlight = null;
	#disposed = false;
	#invalidationError = null;
	#turnSequence = 0;
	#usage = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0 };
	#interruptedTurns = [];
	#calls = new Map();
	#requestAt = null;
	#lastStreamProgressAt = 0;
	#lastContextTokens = 0;
	#rotationDue = false;
	#sessionFloorTokens = null;
	#awaitingFloor = false;
	#rotations = 0;
	#turnsSinceRotation = 0;
	#sessionUsed = false;
	#pendingCarryOver = null;
	#recentTools = new ToolDigests(CARRY_OVER_TOOL_CALLS);
	#failureCarryOver = new FailureCarryOver();
	#recentConversation = [];
	#lastProgram = null;
	#lastAgentText = null;
	#toolParts = new Map();
	#idleWaiters = [];

	constructor(profile, { config, controlProtocol, systemPrompt, toolServer, spawn, terminate, fs, schedule, cancelSchedule, request, openEvents, onPromptSent = null, sessionGeneration, resetReason, onInvalidated, observationViewSession = null }) {
		this.#observationViews = new ModelObservationViews({ session: observationViewSession });
		this.#profile = structuredClone(profile);
		this.#config = config;
		this.#controlProtocol = controlProtocol;
		this.#systemPrompt = systemPrompt;
		this.#toolServer = toolServer;
		this.#spawn = spawn;
		this.#terminate = terminate;
		this.#fs = fs;
		this.#schedule = schedule;
		this.#cancelSchedule = cancelSchedule;
		this.#request = request;
		this.#openEvents = openEvents;
		this.#onPromptSent = onPromptSent;
		this.#sessionGeneration = sessionGeneration;
		this.#resetReason = resetReason;
		this.#onInvalidated = onInvalidated;
		this.#executionSettings = createExecutionSettings(profile, {
			transport: 'opencode_server', controlProtocol, modelSelector: profile.model,
			evidence: { model: 'launch_argument', reasoningEffort: 'launch_argument', serviceTier: 'unreported' },
		});
	}

	get agentId() { return this.#profile.agentId; }
	get provider() { return 'opencode'; }
	get model() { return this.#profile.model; }
	get reasoningEffort() { return this.#profile.reasoningEffort; }
	get serviceTier() { return this.#profile.serviceTier; }
	get goalRevision() { return this.#goalRevision; }
	get planning() { return this.#active !== null || this.#oneShot !== null; }
	get sessionGeneration() { return this.#sessionGeneration; }
	get profileFingerprint() { return profileFingerprint(this.#profile); }
	get executionSettings() { return structuredClone(this.#executionSettings); }
	sessionMetadata() {
		return createSessionMetadata(this.#profile, { sessionGeneration: this.#sessionGeneration, sessionState: this.#sessionState, continuation: 'durable', durability: 'provider', resetReason: this.#resetReason });
	}
	matchesProfile(profile) { return profilesMatch(this.#profile, profile); }
	matchesControlProtocol(value) { return this.#controlProtocol === value; }

	async setGoalRevision(revision) {
		if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('goalRevision must be a nonnegative safe integer');
		if (revision < this.#goalRevision) throw new OpenCodeProviderError('STALE_GOAL_REVISION', `Goal revision ${revision} is older than ${this.#goalRevision}`);
		if (revision === this.#goalRevision) return;
		this.#goalRevision = revision;
		this.#recentTools.invalidateHandles();
		this.#active?.toolDigests.invalidateHandles();
		this.#failureCarryOver = new FailureCarryOver();
		if ((this.#active !== null && this.#active.goalRevision !== revision) || this.#oneShot !== null) await this.interrupt();
	}

	/** Starts OpenCode and waits until it has listed the Minecraft tools, without spending a model turn. */
	async prewarm({ goalRevision = this.#goalRevision } = {}) {
		this.#assertNative('prewarm');
		this.#assertUsable();
		if (goalRevision !== this.#goalRevision) throw new OpenCodeProviderError('STALE_GOAL_REVISION', `Goal revision ${goalRevision} does not match ${this.#goalRevision}`);
		await this.#ensureServer();
		await this.#ensureSession();
		return this;
	}

	async act(input, { goalRevision, signal, executeTool, onVerbose = null, onProgress = null, captureCalls = false } = {}) {
		this.#assertNative('act');
		this.#assertUsable();
		if (typeof input !== 'string' || input.trim().length === 0) throw new TypeError('native event input must be nonblank');
		if (typeof executeTool !== 'function') throw new TypeError('executeTool must be a function');
		if (onProgress !== null && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function or null');
		if (goalRevision !== this.#goalRevision) throw new OpenCodeProviderError('STALE_GOAL_REVISION', `Goal revision ${String(goalRevision)} does not match ${this.#goalRevision}`);
		if (signal?.aborted) throw signal.reason ?? new OpenCodeProviderError('TURN_INTERRUPTED', 'Native tool turn was interrupted');
		if (this.#active !== null) throw new OpenCodeProviderError('TURN_IN_PROGRESS', `OpenCode agent '${this.agentId}' already has an active turn`);
		await this.#ensureServer();
		// An interrupted turn's prompt must finish before the session takes the next one.
		await this.#waitForIdle();
		await this.#ensureServer();
		this.#rotateIfDue();
		await this.#ensureSession();
		this.#assertUsable();
		if (goalRevision !== this.#goalRevision || signal?.aborted) throw new OpenCodeProviderError('STALE_PLAN', 'OpenCode native turn belongs to an obsolete goal revision');
		if (this.#active !== null) throw new OpenCodeProviderError('TURN_IN_PROGRESS', `OpenCode agent '${this.agentId}' already has an active turn`);
		const interrupted = carriedUsage(this.#interruptedTurns.splice(0));
		let resolveTurn;
		let rejectTurn;
		const turnPromise = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
		void turnPromise.catch(() => {});
		const silence = createSilenceDeadline(this.#config.planningTimeoutMs, this.#schedule, this.#cancelSchedule);
		const active = {
			turnId: `${this.#sessionGeneration}:${++this.#turnSequence}`,
			sessionId: this.#sessionId,
			callLog: captureCalls ? new NativeCallLog() : null,
			latestInput: input,
			goalRevision,
			modelSawInput: false,
			toolDigests: new ToolDigests(CARRY_OVER_TOOL_CALLS * 2),
			executeTool, onVerbose, onProgress, silence,
			toolCalls: 0,
			providerRetries: 0,
			usage: interrupted === null
				? { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 }
				: { ...interrupted, interrupted: { ...interrupted } },
			publishedMessage: false,
			pendingSteers: null,
			tail: Promise.resolve(),
			inFlightTools: 0,
			inFlight: null,
			handoff: null,
			settled: false,
			interrupted: false,
			wakeSleep: null,
			resolve: (value) => { if (!active.settled) { active.settled = true; failPendingSteers(active); resolveTurn(value); } },
			reject: (error) => { if (!active.settled) { active.settled = true; failPendingSteers(active); active.wakeSleep?.(); rejectTurn(error); } },
		};
		this.#active = active;
		this.#failureCarryOver.beginTurn();
		const abort = () => {
			active.reject(new OpenCodeProviderError('STALE_PLAN', 'OpenCode native turn was aborted'));
			void this.interrupt().catch(() => {});
		};
		signal?.addEventListener('abort', abort, { once: true });
		let completed = false;
		try {
			const encoded = encodeNativeEventInput(input, this.#observationViews);
			const carryOver = this.#pendingCarryOver;
			const text = carryOver === null ? encoded : `${carryOver}\n\n${encoded}`;
			this.#pendingCarryOver = null;
			this.#noteEventFacts(input);
			providerEvent(onVerbose, 'native_provider_turn_sent', { turnId: active.turnId, sessionGeneration: this.#sessionGeneration });
			silence.restart();
			void this.#runPrompt(active, text).then(
				(outcome) => active.resolve({
					status: 'completed', toolCalls: active.toolCalls,
					...(active.callLog === null ? {} : { nativeCapture: nativeCapture(active, this.#sessionId) }),
					usage: { ...active.usage, contextTokens: this.#lastContextTokens },
					...(outcome.retries > 0 ? { providerRetries: outcome.retries } : {}),
				}),
				(error) => active.reject(error),
			);
			const result = await Promise.race([turnPromise, silence.promise]);
			if (this.#active !== active || this.#goalRevision !== goalRevision || signal?.aborted) throw new OpenCodeProviderError('STALE_PLAN', 'OpenCode native turn belongs to an obsolete goal revision');
			this.#sessionState = 'warm';
			this.#turnsSinceRotation += 1;
			completed = true;
			return result;
		} catch (error) {
			if (!active.modelSawInput) this.#observationViews.forgetEventView();
			if (error?.code === 'PLANNING_TIMEOUT') await this.interrupt().catch(() => {});
			if (active.callLog !== null && error !== null && typeof error === 'object' && !Object.hasOwn(error, 'nativeCapture')) {
				try { Object.defineProperty(error, 'nativeCapture', { value: nativeCapture(active, this.#sessionId) }); } catch { /* capture is observational */ }
			}
			throw error;
		} finally {
			signal?.removeEventListener('abort', abort);
			silence.dispose();
			if (!active.settled) active.reject(new OpenCodeProviderError('STALE_PLAN', 'OpenCode native turn ended'));
			if (this.#active === active) this.#active = null;
			if (!completed && !active.interrupted) {
				active.interrupted = true;
				this.#interruptedTurns.push(active);
			}
		}
	}

	/** Sends one prompt and resumes it after a free-tier limit; every resume and its wait goes to the trace. */
	async #runPrompt(active, text) {
		let body = text;
		for (let attempt = 0; ; attempt += 1) {
			const outcome = await this.#postPrompt(body, active, { kind: attempt === 0 ? 'turn_input' : 'retry_input' });
			if (active.settled) throw new OpenCodeProviderError('STALE_PLAN', 'OpenCode turn was interrupted');
			if (active.handoff !== null) {
				// A tool boundary moved this turn to a fresh session; the retired session's aborted reply is not an outcome.
				body = active.handoff;
				active.handoff = null;
				await this.#ensureSession();
				active.sessionId = this.#sessionId;
				attempt -= 1;
				continue;
			}
			// The reply can overtake the event stream; its idle event follows every usage event of the prompt.
			await this.#sessionIdle(active.sessionId, IDLE_EVENT_WAIT_MS);
			const failure = outcome?.info?.error ?? null;
			if (failure === null) {
				this.#noteReportedModel(outcome?.info);
				return { retries: attempt };
			}
			const mapped = classifyOpenCodeError(failure);
			if (!mapped.retryable || attempt + 1 >= RATE_LIMIT_RETRY.maxAttempts) {
				throw new OpenCodeProviderError(mapped.code, `OpenCode ended the turn (${mapped.name}): ${excerpt(mapped.message)}`);
			}
			const waitMs = retryDelayMs(attempt, mapped.retryAfterMs);
			providerEvent(active.onVerbose, 'native_provider_retry', {
				turnId: active.turnId, retriedBy: 'coordinator', attempt: attempt + 1, waitMs, reason: mapped.code,
				...(mapped.statusCode === null ? {} : { statusCode: mapped.statusCode }), message: mapped.message.slice(0, 160),
			});
			active.silence.pause();
			try { await this.#sleep(waitMs, active); } finally { active.silence.resume(); }
			if (active.settled) throw new OpenCodeProviderError('STALE_PLAN', 'OpenCode turn was interrupted');
			body = RETRY_CONTINUATION;
		}
	}

	/** Waits out a retry backoff; an interrupt or failure of the turn ends the wait at once. */
	#sleep(ms, active) {
		return new Promise((resolve) => {
			const handle = this.#schedule(() => { active.wakeSleep = null; resolve(); }, ms);
			active.wakeSleep = () => { active.wakeSleep = null; this.#cancelSchedule(handle); resolve(); };
		});
	}

	async #postPrompt(text, active, { kind }) {
		const server = this.#server;
		if (server === null) throw new OpenCodeProviderError('PROVIDER_UNAVAILABLE', 'OpenCode server is not running');
		this.#requestAt = Date.now();
		active.callLog?.input(active.callLog.isEmpty ? 'turn_input' : kind === 'retry_input' ? 'retry_input' : 'handoff_input', text);
		try { this.#onPromptSent?.(text); } catch { /* observation only */ }
		this.#sessionUsed = true;
		const [providerID, modelID] = splitModel(this.#profile.model);
		const request = this.#request(server, 'POST', `/session/${encodeURIComponent(active.sessionId)}/message`, {
			agent: AGENT_NAME, model: { providerID, modelID }, ...openCodeVariant(this.#profile.reasoningEffort),
			parts: [{ type: 'text', text }],
		}, { timeoutMs: 0 });
		const tracked = request.catch(() => {});
		this.#inFlight = tracked;
		active.inFlight = tracked;
		try { return await request; }
		catch (error) {
			if (active.settled) throw new OpenCodeProviderError('STALE_PLAN', 'OpenCode turn was interrupted', { cause: error });
			throw new OpenCodeProviderError('PROVIDER_UNAVAILABLE', `OpenCode prompt failed: ${error?.message ?? String(error)}`, { cause: error });
		} finally { if (this.#inFlight === tracked) this.#inFlight = null; }
	}

	async steer(input, { goalRevision = this.#goalRevision, onInterrupt = null, onDiscard = null } = {}) {
		this.#assertNative('steer');
		this.#assertUsable();
		if (!(typeof input === 'function' || typeof input === 'string' && input.trim().length > 0)) throw new TypeError('native steer input must be nonblank or a builder');
		if (onInterrupt !== null && typeof onInterrupt !== 'function') throw new TypeError('onInterrupt must be a function or null');
		if (onDiscard !== null && typeof onDiscard !== 'function') throw new TypeError('onDiscard must be a function or null');
		if (goalRevision !== this.#goalRevision) throw new OpenCodeProviderError('STALE_GOAL_REVISION', `Goal revision ${goalRevision} does not match ${this.#goalRevision}`);
		const active = this.#active;
		if (active === null || active.settled || active.goalRevision !== goalRevision) throw new OpenCodeProviderError('TURN_NOT_ACTIVE', `OpenCode agent '${this.agentId}' has no steerable native turn`);
		// Like Claude: only the newest pending builder is delivered, with the next tool result.
		const delivered = new Promise((resolve, reject) => {
			const waiter = { resolve: () => resolve({ turnId: active.turnId }), reject };
			const previous = active.pendingSteers;
			active.pendingSteers = {
				buildInput: typeof input === 'function' ? input : async () => input,
				onDiscard, discarded: false,
				waiters: [...(previous?.waiters ?? []), waiter],
				queuedAt: previous?.queuedAt ?? Date.now(),
			};
			discardPendingSteer(previous);
			active.silence.restart();
		});
		try { onInterrupt?.(); } catch { /* steer delivery remains authoritative */ }
		return delivered;
	}

	/** One-shot structured decision used for goal translation and ArenaScript planning, on a fresh session. */
	async decide(input, {
		goalRevision, signal, turnRecorder = null, attempt = 1, retry = false, queueWaitMs, onVerbose = null,
		outputSchema = PLANNER_OUTPUT_SCHEMA, parseOutput = parseDecision, systemPrompt,
	} = {}) {
		if (this.#controlProtocol === 'native_tools') throw new OpenCodeProviderError('CONTROL_PROTOCOL_MISMATCH', 'Native tool agents must use act()');
		this.#assertUsable();
		if (typeof input !== 'string' || input.trim().length === 0) throw new TypeError('planner input must be nonblank');
		if (typeof parseOutput !== 'function') throw new TypeError('parseOutput must be a function');
		if (systemPrompt !== undefined && typeof systemPrompt !== 'string') throw new TypeError('systemPrompt must be a string');
		if (goalRevision !== this.#goalRevision) throw new OpenCodeProviderError('STALE_GOAL_REVISION', `Goal revision ${String(goalRevision)} does not match ${this.#goalRevision}`);
		if (signal?.aborted) throw signal.reason ?? new OpenCodeProviderError('PLAN_CANCELLED', 'Planning was cancelled');
		if (this.#oneShot !== null) throw new OpenCodeProviderError('TURN_IN_PROGRESS', `OpenCode agent '${this.agentId}' already has an active turn`);
		const schemaText = outputSchema === null || outputSchema === undefined ? '' : `\n\nReturn only one JSON value matching this JSON Schema, with no prose or code fences:\n${JSON.stringify(outputSchema)}`;
		const prompt = `${systemPrompt ? `${systemPrompt}\n\n` : ''}${input}${schemaText}`;
		const startedAt = Date.now();
		const operation = { cancelled: null, sessionId: null };
		this.#oneShot = operation;
		const abort = () => { void this.#cancelOneShot(operation, new OpenCodeProviderError('PLAN_CANCELLED', 'Planning was cancelled')); };
		signal?.addEventListener('abort', abort, { once: true });
		let output = '';
		let timing = null;
		let timer = null;
		try {
			await this.#ensureServer();
			const deadline = new Promise((_, reject) => {
				timer = this.#schedule(() => {
					const error = new OpenCodeProviderError('PLANNING_TIMEOUT', `OpenCode planning timed out after ${this.#config.planningTimeoutMs} ms`);
					void this.#cancelOneShot(operation, error);
					reject(error);
				}, this.#config.planningTimeoutMs);
			});
			void deadline.catch(() => {});
			const result = await Promise.race([this.#runOneShot(operation, prompt, onVerbose), deadline]);
			output = result.text;
			timing = { durationMs: Date.now() - startedAt, apiDurationMs: null, ...(Number.isFinite(queueWaitMs) && queueWaitMs >= 0 ? { queueWaitMs } : {}) };
			if (Buffer.byteLength(output, 'utf8') > this.#config.maxDecisionBytes) throw new OpenCodeProviderError('TURN_OUTPUT_LIMIT', `OpenCode planner output exceeded ${this.#config.maxDecisionBytes} bytes`);
			if (signal?.aborted || goalRevision !== this.#goalRevision) throw new OpenCodeProviderError('STALE_PLAN', 'opencode result belongs to an obsolete goal');
			reportVisibleOutput(onVerbose, output);
			let decision;
			try { decision = parseOutput(stripCodeFence(output.trim())); }
			catch (error) {
				const parseError = new OpenCodeProviderError(error?.code ?? 'INVALID_DECISION', 'opencode returned an invalid planner decision', { cause: error });
				parseError.category = 'decision_parse';
				throw parseError;
			}
			recordProviderTurn(turnRecorder, {
				executionSettings: this.executionSettings, agentId: this.agentId, provider: 'opencode', model: this.#profile.model,
				reasoningEffort: this.#profile.reasoningEffort, goalRevision, attempt, retry, input: prompt, output, error: null, timing,
				tokens: result.tokens, costUsd: 0,
			});
			return decision;
		} catch (error) {
			recordProviderTurn(turnRecorder, {
				executionSettings: this.executionSettings, agentId: this.agentId, provider: 'opencode', model: this.#profile.model,
				reasoningEffort: this.#profile.reasoningEffort, goalRevision, attempt, retry, input: prompt,
				output: error?.category === 'decision_parse' ? '' : output, error, timing,
			});
			if (signal?.aborted || goalRevision !== this.#goalRevision) throw new OpenCodeProviderError('STALE_PLAN', 'opencode result belongs to an obsolete goal', { cause: error });
			throw error;
		} finally {
			if (timer !== null) this.#cancelSchedule(timer);
			signal?.removeEventListener('abort', abort);
			if (this.#oneShot === operation) this.#oneShot = null;
		}
	}

	async #runOneShot(operation, prompt, onVerbose) {
		const [providerID, modelID] = splitModel(this.#profile.model);
		for (let attempt = 0; ; attempt += 1) {
			if (operation.cancelled !== null) throw operation.cancelled;
			const session = await this.#request(this.#server, 'POST', '/session', { title: `arena-${this.agentId}-decide` }, { timeoutMs: this.#config.startupTimeoutMs });
			operation.sessionId = session.id;
			let outcome;
			try {
				outcome = await this.#request(this.#server, 'POST', `/session/${encodeURIComponent(session.id)}/message`, {
					agent: AGENT_NAME, model: { providerID, modelID }, ...openCodeVariant(this.#profile.reasoningEffort), parts: [{ type: 'text', text: prompt }],
				}, { timeoutMs: 0 });
			} finally {
				void this.#request(this.#server, 'DELETE', `/session/${encodeURIComponent(session.id)}`, null, { timeoutMs: 5_000 }).catch(() => {});
			}
			if (operation.cancelled !== null) throw operation.cancelled;
			const failure = outcome?.info?.error ?? null;
			if (failure === null) {
				this.#noteReportedModel(outcome?.info);
				const text = (Array.isArray(outcome?.parts) ? outcome.parts : []).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
				return { text, tokens: openCodeTokens(outcome?.info?.tokens) };
			}
			const mapped = classifyOpenCodeError(failure);
			if (!mapped.retryable || attempt + 1 >= RATE_LIMIT_RETRY.maxAttempts) throw new OpenCodeProviderError(mapped.code, `OpenCode decision failed (${mapped.name}): ${excerpt(mapped.message)}`);
			const waitMs = retryDelayMs(attempt, mapped.retryAfterMs);
			providerEvent(onVerbose, 'native_provider_retry', { retriedBy: 'coordinator', operation: 'decide', attempt: attempt + 1, waitMs, reason: mapped.code, ...(mapped.statusCode === null ? {} : { statusCode: mapped.statusCode }) });
			await new Promise((resolve) => this.#schedule(resolve, waitMs));
		}
	}

	async #cancelOneShot(operation, error) {
		operation.cancelled ??= error;
		if (operation.sessionId !== null && this.#server !== null) {
			await this.#request(this.#server, 'POST', `/session/${encodeURIComponent(operation.sessionId)}/abort`, {}, { timeoutMs: this.#config.interruptTimeoutMs }).catch(() => {});
		}
	}

	async interrupt() {
		const interruptStartedAt = Date.now();
		const oneShot = this.#oneShot;
		if (oneShot !== null) await this.#cancelOneShot(oneShot, new OpenCodeProviderError('PLAN_CANCELLED', 'Planning was cancelled'));
		const active = this.#active;
		if (active === null) return;
		if (!active.interrupted) { active.interrupted = true; this.#interruptedTurns.push(active); }
		active.reject(new OpenCodeProviderError('STALE_PLAN', 'OpenCode turn was interrupted'));
		if (this.#server === null) return;
		let interruptTimedOut = false;
		try {
			// Waits for this turn's own prompt only; a newer turn may already be running on the session.
			await withDeadline((async () => {
				await this.#request(this.#server, 'POST', `/session/${encodeURIComponent(active.sessionId)}/abort`, {}, { timeoutMs: this.#config.interruptTimeoutMs });
				await (active.inFlight ?? Promise.resolve());
			})(), this.#config.interruptTimeoutMs, this.#schedule, this.#cancelSchedule,
			() => new OpenCodeProviderError('INTERRUPT_TIMEOUT', 'OpenCode did not acknowledge the interrupt'));
		} catch (error) {
			interruptTimedOut = error?.code === 'INTERRUPT_TIMEOUT';
			// A server that ignores the abort loses its warm session rather than blocking the body, unless a newer turn owns it.
			if (this.#active === null || this.#active === active) await this.#stopServer('OpenCode restarted');
		}
		return { interruptLatencyMs: Math.max(0, Date.now() - interruptStartedAt), interruptAcknowledged: !interruptTimedOut, interruptTimedOut };
	}

	async dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		const error = this.#invalidationError ?? new OpenCodeProviderError('AGENT_DISPOSED', `OpenCode agent '${this.agentId}' is disposed`);
		this.#active?.reject(error);
		this.#active = null;
		if (this.#oneShot !== null) await this.#cancelOneShot(this.#oneShot, error);
		await this.#serverStart?.catch(() => {});
		await this.#stopServer(null);
	}

	invalidateSession(cause) {
		if (this.#invalidationError !== null || this.#disposed) return;
		this.#invalidationError = new OpenCodeProviderError('SESSION_INVALIDATED', 'OpenCode session is no longer usable', { cause });
		this.#sessionState = 'cold';
		this.#active?.reject(this.#invalidationError);
		this.#onInvalidated?.(this);
		void this.dispose();
	}

	#assertNative(operation) {
		if (this.#controlProtocol !== 'native_tools') throw new OpenCodeProviderError('CONTROL_PROTOCOL_MISMATCH', `Only native tool agents can ${operation}`);
	}

	#assertUsable() {
		if (this.#disposed) throw this.#invalidationError ?? new OpenCodeProviderError('AGENT_DISPOSED', `OpenCode agent '${this.agentId}' is disposed`);
	}

	#ensureServer() {
		if (this.#server !== null) return Promise.resolve();
		this.#serverStart ??= this.#startServer().finally(() => { this.#serverStart = null; });
		return this.#serverStart;
	}

	async #startServer() {
		this.#assertUsable();
		const native = this.#controlProtocol === 'native_tools';
		const route = native ? await this.#toolServer.register({
			callTool: (name, args) => this.#callTool(name, args),
			onToolsListed: () => {},
			onToolResponded: () => {},
		}) : null;
		if (this.#disposed) { route?.unregister(); this.#assertUsable(); }
		const directory = await this.#fs.mkdtemp(path.join(this.#config.runtimeRoot ?? os.tmpdir(), 'arena-opencode-'));
		await this.#fs.chmod(directory, 0o700).catch(() => {});
		const password = randomBytes(24).toString('hex');
		const configFile = path.join(directory, 'opencode.json');
		const config = buildOpenCodeConfig({ prompt: this.#systemPrompt, mcp: route === null ? null : { url: route.url, token: route.token } });
		// The file carries this body's MCP bearer token: private directory, owner-only file, removed on stop.
		await this.#fs.writeFile(configFile, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
		await this.#fs.chmod(configFile, 0o600).catch(() => {});
		const launch = buildOpenCodeLaunch(this.#config, { directory, configFile, password });
		const state = { child: null, url: null, auth: basicAuth(password), directory, route, events: null, exited: false, stdout: '', stderr: '' };
		let child;
		try { child = this.#spawn(launch.command, launch.args, launch.options); }
		catch (error) {
			route?.unregister();
			await this.#fs.rm(directory, { recursive: true, force: true }).catch(() => {});
			throw new OpenCodeProviderError('SPAWN_FAILED', `Could not start OpenCode: ${error.message}`, { cause: error });
		}
		state.child = child;
		child.stdout?.setEncoding?.('utf8');
		child.stderr?.setEncoding?.('utf8');
		child.stderr?.on('data', (chunk) => { if (state.stderr.length < 16_384) state.stderr += redactSecrets(String(chunk)); });
		child.stdin?.on?.('error', () => {});
		const listening = new Promise((resolve, reject) => {
			child.stdout?.on('data', (chunk) => {
				if (state.url !== null) return;
				state.stdout = (state.stdout + String(chunk)).slice(-4_096);
				const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(state.stdout);
				if (match !== null) { state.url = match[1]; resolve(); }
			});
			child.once('error', (error) => reject(new OpenCodeProviderError('SPAWN_FAILED', `Could not start OpenCode: ${error.message}`, { cause: error })));
			child.once('close', (exitCode, signalCode) => {
				const error = new OpenCodeProviderError('PROVIDER_UNAVAILABLE', `OpenCode exited with code ${String(exitCode)} and signal ${String(signalCode)} [stderr=${excerpt(state.stderr)}]`);
				reject(error);
				this.#onServerExit(state, error);
			});
		});
		try {
			await withDeadline(listening, this.#config.startupTimeoutMs, this.#schedule, this.#cancelSchedule,
				() => new OpenCodeProviderError('PROVIDER_START_TIMEOUT', `OpenCode did not start within ${this.#config.startupTimeoutMs} ms`));
			state.events = this.#openEvents(state, (event) => this.#onEvent(event));
			if (native) {
				// The first instance request connects the MCP server; wait until OpenCode reports it connected.
				await withDeadline(this.#waitForMcp(state), this.#config.startupTimeoutMs, this.#schedule, this.#cancelSchedule,
					() => new OpenCodeProviderError('PROVIDER_START_TIMEOUT', `OpenCode did not load the Minecraft tools within ${this.#config.startupTimeoutMs} ms`));
			}
		} catch (error) {
			this.#server = state;
			await this.#stopServer(null);
			throw error;
		}
		this.#server = state;
		this.#resetContextState();
	}

	async #waitForMcp(state) {
		for (;;) {
			if (state.exited) throw new OpenCodeProviderError('PROVIDER_UNAVAILABLE', 'OpenCode exited during startup');
			const status = await this.#request(state, 'GET', '/mcp', null, { timeoutMs: this.#config.startupTimeoutMs }).catch(() => null);
			const entry = status?.[MCP_SERVER_NAME];
			if (entry?.status === 'connected') return;
			if (entry?.status === 'failed' || entry?.status === 'disabled') throw new OpenCodeProviderError('PROVIDER_UNAVAILABLE', `OpenCode could not connect the Minecraft tools (${entry.status}): ${excerpt(entry.error ?? '')}`);
			await new Promise((resolve) => this.#schedule(resolve, 100));
		}
	}

	async #ensureSession() {
		if (this.#sessionId !== null) return;
		const session = await this.#request(this.#server, 'POST', '/session', { title: `arena-${this.agentId}` }, { timeoutMs: this.#config.startupTimeoutMs });
		if (typeof session?.id !== 'string') throw new OpenCodeProviderError('PROVIDER_UNAVAILABLE', 'OpenCode did not create a session');
		this.#sessionId = session.id;
	}

	/** A completed turn past the rotation threshold starts the next turn on a fresh session with a carry-over. */
	#rotateIfDue() {
		const threshold = this.#config.contextRotationTokens;
		if (!this.#rotationDue || threshold <= 0 || this.#turnsSinceRotation < MIN_TURNS_BETWEEN_ROTATIONS || this.#sessionId === null) return;
		const retired = this.#sessionId;
		this.#pendingCarryOver = this.#carryOver('Session refreshed to keep context small');
		this.#sessionId = null;
		this.#rotations += 1;
		this.#resetContextState();
		this.#awaitingFloor = true;
		void this.#request(this.#server, 'DELETE', `/session/${encodeURIComponent(retired)}`, null, { timeoutMs: 5_000 }).catch(() => {});
	}

	#resetContextState() {
		this.#observationViews.reset();
		this.#rotationDue = false;
		this.#sessionFloorTokens = null;
		this.#awaitingFloor = false;
		this.#lastContextTokens = 0;
		this.#turnsSinceRotation = 0;
		this.#sessionUsed = false;
		this.#calls.clear();
		this.#toolParts.clear();
	}

	#onServerExit(state, error) {
		if (state.exited) return;
		state.exited = true;
		state.events?.close();
		state.route?.unregister();
		void this.#fs.rm(state.directory, { recursive: true, force: true }).catch(() => {});
		if (this.#server !== state) return;
		this.#server = null;
		this.#sessionId = null;
		this.#sessionState = 'cold';
		if (!this.#disposed) this.invalidateSession(error);
	}

	async #stopServer(carryReason) {
		const state = this.#server;
		this.#server = null;
		this.#sessionId = null;
		this.#sessionState = 'cold';
		if (carryReason !== null && this.#sessionUsed && this.#pendingCarryOver === null) this.#pendingCarryOver = this.#carryOver(carryReason);
		if (state === null) return;
		state.exited = true;
		state.events?.close();
		state.route?.unregister();
		await Promise.resolve(this.#terminate(state.child)).catch(() => {});
		await this.#fs.rm(state.directory, { recursive: true, force: true }).catch(() => {});
	}

	#idlePromise() { return this.#inFlight ?? Promise.resolve(); }

	#sessionIdle(sessionId, timeoutMs) {
		return new Promise((resolve) => {
			const waiter = { sessionId, resolve: () => { this.#cancelSchedule(handle); resolve(); } };
			const handle = this.#schedule(() => { this.#idleWaiters = this.#idleWaiters.filter((entry) => entry !== waiter); resolve(); }, timeoutMs);
			this.#idleWaiters.push(waiter);
		});
	}

	#noteIdle(sessionId) {
		const ready = this.#idleWaiters.filter((entry) => entry.sessionId === sessionId);
		this.#idleWaiters = this.#idleWaiters.filter((entry) => entry.sessionId !== sessionId);
		for (const waiter of ready) waiter.resolve();
	}

	async #waitForIdle() {
		if (this.#inFlight === null) return;
		try {
			await withDeadline(this.#idlePromise(), this.#config.interruptTimeoutMs, this.#schedule, this.#cancelSchedule,
				() => new OpenCodeProviderError('INTERRUPT_TIMEOUT', 'OpenCode did not finish the interrupted turn'));
		} catch {
			await this.#stopServer('OpenCode restarted');
			await this.#ensureServer();
		}
	}

	#onEvent(event) {
		const properties = event?.properties ?? {};
		const sessionId = properties.sessionID ?? properties.part?.sessionID ?? properties.info?.sessionID ?? null;
		if (event?.type === 'session.idle' || event?.type === 'session.status' && properties.status?.type === 'idle') this.#noteIdle(sessionId);
		if (sessionId === null || sessionId !== this.#sessionId) return;
		const active = this.#active;
		const now = Date.now();
		const renew = event.type !== 'message.part.delta' || now - this.#lastStreamProgressAt >= STREAM_PROGRESS_INTERVAL_MS;
		if (active !== null && !active.settled && renew) {
			this.#lastStreamProgressAt = now;
			active.silence.restart();
			try { active.onProgress?.({ phase: 'provider' }); } catch { /* progress reporting cannot fail provider work */ }
		}
		switch (event.type) {
			case 'message.part.delta': {
				const call = this.#calls.get(properties.messageID);
				if (call !== undefined) { call.firstAt ??= now; call.events += 1; }
				if (active !== null) active.modelSawInput = true;
				return;
			}
			case 'message.part.updated': this.#onPart(properties.part, now); return;
			case 'session.status': {
				const status = properties.status;
				if (status?.type === 'retry' && active !== null) {
					active.providerRetries += 1;
					const waitMs = Number.isFinite(status.next) ? Math.max(0, status.next - now) : null;
					providerEvent(active.onVerbose, 'native_provider_retry', { turnId: active.turnId, retriedBy: 'opencode', attempt: status.attempt ?? active.providerRetries, ...(waitMs === null ? {} : { waitMs }), reason: classifyOpenCodeError({ name: 'APIError', data: { message: String(status.message ?? '') } }).code, message: String(status.message ?? '').slice(0, 160) });
					if (active.providerRetries > MAX_PROVIDER_RETRIES_PER_TURN) {
						active.reject(new OpenCodeProviderError('RATE_LIMITED', `OpenCode retried ${active.providerRetries} times in one turn: ${excerpt(status.message ?? '')}`));
						void this.interrupt().catch(() => {});
					} else if (waitMs !== null) {
						// The provider is waiting, not silent: hold the deadline until its next attempt.
						active.silence.pause();
						this.#schedule(() => active.silence.resume(), waitMs);
					}
				}
				return;
			}
			default: return;
		}
	}

	#onPart(part, now) {
		if (part === null || typeof part !== 'object') return;
		const active = this.#active;
		const key = part.messageID;
		if (part.type === 'step-start') {
			if (!this.#calls.has(key)) {
				this.#calls.set(key, { id: key, active, requestAt: this.#requestAt, firstAt: null, events: 0, tools: [], done: false });
				active?.callLog?.beginCall(key);
			}
			return;
		}
		const call = this.#calls.get(key);
		if (part.type === 'text' && typeof part.text === 'string' && part.time?.end !== undefined) {
			call && (call.firstAt ??= now);
			active?.callLog?.output(part.text, key, part.id);
			const text = part.text.trim();
			if (active !== null && !active.publishedMessage && text.length > 0) {
				this.#lastAgentText = text.slice(0, 400);
				active.publishedMessage = true;
				safeVerbose(active.onVerbose, 'agent_message', text.slice(0, MAX_PUBLIC_AGENT_MESSAGE_CHARS));
				if (process.env.ARENA_QUALITY_CAPTURE === '1' && !active.qualityFirstMessageCaptured) {
					active.qualityFirstMessageCaptured = true;
					safeVerbose(active.onVerbose, 'quality_first_message', JSON.stringify([{ type: 'text', text }]).slice(0, 8192));
				}
			}
			return;
		}
		if (part.type === 'reasoning' && typeof part.text === 'string' && part.time?.end !== undefined) {
			call && (call.firstAt ??= now);
			active?.callLog?.reasoning(part.text, part.id, key);
			return;
		}
		if (part.type === 'tool') {
			const status = part.state?.status;
			let entry = this.#toolParts.get(part.callID);
			if (entry === undefined) {
				entry = { callId: part.callID, tool: String(part.tool ?? ''), claimed: false, executed: false, reported: false, waiters: [] };
				this.#toolParts.set(part.callID, entry);
				if (call !== undefined) {
					call.firstAt ??= now;
					if (call.tools.length < MAX_TRACED_TOOLS) call.tools.push({ name: entry.tool.slice(0, 64), at: now });
				}
				if (active !== null && !active.settled) { try { active.onProgress?.({ phase: 'tool_streaming' }); } catch { /* diagnostics only */ } }
			}
			if ((status === 'running' || status === 'completed' || status === 'error') && !entry.reported) {
				entry.reported = true;
				active?.callLog?.toolCall({ callId: part.callID, name: entry.tool, arguments: part.state?.input ?? {} }, key);
				for (const resolve of entry.waiters.splice(0)) resolve();
			}
			// A call OpenCode refused itself (bad arguments, unknown or blocked tool) never reaches the Minecraft tools.
			if (status === 'error' && !entry.executed && active !== null) {
				entry.executed = true;
				providerEvent(active.onVerbose, 'native_provider_tool_error', { turnId: active.turnId, callId: part.callID, toolName: entry.tool.slice(0, 64), error: String(part.state?.error ?? '').slice(0, 240) });
			}
			return;
		}
		if (part.type === 'step-finish' && call !== undefined && !call.done) this.#finishCall(call, part.tokens, now);
	}

	#finishCall(call, tokens, now) {
		call.done = true;
		call.endedAt = now;
		const usage = {
			input: count(tokens?.input), cacheRead: count(tokens?.cache?.read), cacheWrite: count(tokens?.cache?.write),
			// Reasoning is billed output; OpenCode reports it separately.
			output: count(tokens?.output) + count(tokens?.reasoning), reasoning: count(tokens?.reasoning),
		};
		const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		this.#lastContextTokens = contextTokens;
		if (this.#awaitingFloor) { this.#sessionFloorTokens = contextTokens; this.#awaitingFloor = false; }
		const threshold = this.#config.contextRotationTokens;
		if (threshold > 0 && contextTokens >= threshold
			&& (this.#sessionFloorTokens === null || contextTokens - this.#sessionFloorTokens >= threshold * MIN_ROTATION_GROWTH_SHARE)) this.#rotationDue = true;
		addUsage(this.#usage, usage);
		const active = call.active;
		if (active === null || active === undefined) return;
		addUsage(active.usage, usage);
		this.#emitCallUsage(call, usage, contextTokens);
	}

	#emitCallUsage(call, usage, contextTokens) {
		const active = call.active;
		const total = this.#usage;
		const { requestAt, firstAt, endedAt } = call;
		active.callLog?.usage({ input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output }, call.id);
		safeVerbose(active.onVerbose, 'live_usage', JSON.stringify({
			inputTokens: total.input + total.cacheRead + total.cacheWrite, cachedInputTokens: total.cacheRead, cacheWriteInputTokens: total.cacheWrite,
			outputTokens: total.output, reasoningOutputTokens: total.reasoning, totalTokens: total.input + total.cacheRead + total.cacheWrite + total.output,
			threadId: `opencode:${this.agentId}:${this.#sessionGeneration}`, reportedAtEpochMs: Date.now(),
			last: { inputTokens: contextTokens, cachedInputTokens: usage.cacheRead, cacheWriteInputTokens: usage.cacheWrite, outputTokens: usage.output, reasoningOutputTokens: usage.reasoning, totalTokens: contextTokens + usage.output },
			call: {
				provider: 'opencode', turnId: active.turnId, modelCallId: `${active.turnId}:${call.id}`, contextTokens, rotations: this.#rotations, endedAt,
				partialMessagesAccepted: call.events > 0,
				...(requestAt === null || firstAt === null ? {} : { firstEventMs: Math.max(0, firstAt - requestAt) }),
				...(firstAt === null ? {} : { streamMs: Math.max(0, endedAt - firstAt), firstEventAt: firstAt, firstEventSource: 'stream' }),
				...(requestAt === null ? {} : { totalMs: Math.max(0, endedAt - requestAt), requestAt }),
				streamEvents: call.events,
				...(call.tools.length === 0 ? {} : { toolNames: call.tools.map((tool) => tool.name), ...(requestAt === null ? {} : { toolStartMs: call.tools.map((tool) => Math.max(0, tool.at - requestAt)) }) }),
			},
		}));
	}

	#noteReportedModel(info) {
		if (info === null || typeof info !== 'object' || typeof info.modelID !== 'string') return;
		const reported = `${info.providerID ?? ''}/${info.modelID}`;
		if (reported !== this.#profile.model) {
			// Mirrors Codex and Claude: work never continues under a model other than the selected one.
			const mismatch = new OpenCodeProviderError('PROVIDER_SETTINGS_MISMATCH', `OpenCode answered with ${reported.slice(0, 128)}, not the selected model`);
			this.#active?.reject(mismatch);
			this.invalidateSession(mismatch);
			return;
		}
		this.#executionSettings.effective.model = reported;
		this.#executionSettings.evidence.model = 'provider_reported';
	}

	/** Matches an MCP call to OpenCode's call id for traces; OpenCode does not forward the id over MCP. */
	async #claimCallId(name) {
		const toolName = `${MCP_SERVER_NAME}_${name}`;
		const find = () => [...this.#toolParts.values()].find((entry) => !entry.claimed && entry.tool === toolName);
		let entry = find();
		if (entry === undefined) {
			await new Promise((resolve) => this.#schedule(resolve, CALL_ID_WAIT_MS));
			entry = find();
		}
		if (entry === undefined) return null;
		entry.claimed = true;
		entry.executed = true;
		return entry.callId;
	}

	async #callTool(name, args) {
		const active = this.#active;
		if (this.#disposed || active === null || active.settled) {
			return mcpContent(toolResultContent({ state: 'FAILED', reasonCode: 'TURN_NOT_ACTIVE', message: 'No Minecraft turn is active for this body.' }, false));
		}
		active.modelSawInput = true;
		const toolUseId = await this.#claimCallId(name);
		let schedulingClass = 'ordered';
		let admittedTool;
		try { admittedTool = normalizeMinecraftToolCall(name, args); schedulingClass = nativeToolSchedulingClass(admittedTool); } catch { /* rejected below, in order */ }
		// Exact control handles (cancel, program responses) must not wait behind the work they interrupt.
		const bypass = schedulingClass === 'control';
		const bodyToken = {};
		const run = async () => {
			active.queuedBodyTools?.delete(bodyToken);
			if (active.settled) return toolResultContent({ state: 'FAILED', reasonCode: 'TURN_NOT_ACTIVE', message: 'The Minecraft turn already ended.' }, false);
			active.toolCalls += 1;
			try { active.onProgress?.({ phase: 'tool_queued', toolName: name }); } catch { /* diagnostics only */ }
			active.silence.pause();
			let result;
			let tool;
			let toolFailed = false;
			try {
				tool = normalizeMinecraftToolCall(name, args);
				result = await active.executeTool({
					agentId: this.agentId, goalRevision: active.goalRevision, threadId: this.#sessionId, turnId: active.turnId, callId: toolUseId,
					hasQueuedBodyAction: () => (active.queuedBodyTools?.size ?? 0) > 0, tool,
				});
				this.#rememberTool(name, args, result, active.toolDigests);
				this.#noteProgram(result);
			} catch (error) {
				if (tool === undefined || error?.diagnostics !== undefined) providerEvent(active.onVerbose, 'native_tool_rejected', { toolName: name, reason: String(error?.message ?? error).slice(0, 512), ...arenaScriptDiagnosticSummary(error) });
				result = toolErrorResult(error, arenaScriptDiagnosticFields(error));
				this.#rememberTool(name, args, result, active.toolDigests);
				toolFailed = true;
			} finally { active.silence.resume(); }
			if (active.settled && tool !== undefined) this.#pendingCarryOver ??= `${this.#carryOver('Turn interrupted after the tool completed')}\n\nCompleted tool result for "${name}":\n${JSON.stringify(result)}`;
			if (!active.settled && tool !== undefined && !bypass && active.inFlightTools === 1 && this.#rotationDue && active.handoff === null) {
				return this.#midTurnHandoff(active, name, toolUseId, result, tool, toolFailed);
			}
			let content;
			let commit = () => {};
			if (tool === undefined) content = toolResultContent(result, false);
			else {
				const presented = presentNativeToolResult(result, tool, this.#observationViews);
				if (toolFailed) presented.response.success = false;
				content = presented.response;
				commit = presented.commit;
			}
			const delivered = await deliverSteers(active, content, this.#steerEncoder(active));
			active.callLog?.toolResult(toolUseId, delivered.contentItems.map((item) => item?.text ?? '').join('\n'), { success: delivered.success });
			if (!active.settled) commit();
			this.#requestAt = Date.now();
			if (toolUseId !== null) {
				providerEvent(active.onVerbose, 'native_provider_tool_result_sent', { callId: toolUseId });
				try { active.onProgress?.({ phase: 'tool_completed', callId: toolUseId }); } catch { /* diagnostics only */ }
			}
			return delivered;
		};
		active.queuedBodyTools ??= new Set();
		if (isNativeBodyTool(admittedTool)) active.queuedBodyTools.add(bodyToken);
		active.inFlightTools += 1;
		const task = (bypass ? run() : active.tail.then(run, run)).finally(() => { active.inFlightTools -= 1; });
		active.tail = bypass ? Promise.allSettled([active.tail, task]).then(() => {}) : task.catch(() => {});
		return mcpContent(await task);
	}

	/**
	 * Moves a long turn to a fresh session at a tool boundary: the replacement gets the carry-over, the current turn
	 * input, this turn's tool digests and the completed result in full view; the retired session is aborted.
	 */
	async #midTurnHandoff(active, name, toolUseId, result, tool, toolFailed) {
		const retired = active.sessionId;
		this.#observationViews.reset();
		const turnInput = encodeNativeEventInput(active.latestInput, this.#observationViews);
		const presented = presentNativeToolResult(result, presentedTool(tool, { view: 'full' }), this.#observationViews);
		if (toolFailed) presented.response.success = false;
		const delivered = await deliverSteers(active, presented.response, this.#steerEncoder(active));
		const [toolResult, ...steers] = delivered.contentItems.map((item) => item.text);
		const digests = active.toolDigests.lines({ everyAction: true });
		active.handoff = [
			`${this.#carryOver('Mid-turn continuation')}\nAn active tool turn resumes below. Use the completed tool result once, then continue the current goal with the latest event facts.`,
			`Current turn input to continue:\n${turnInput}`,
			...(digests.length === 0 ? [] : [['Completed tool calls this turn (one-line digests):', ...digests.map((entry) => `- ${entry}`)].join('\n')]),
			`Tool result for Minecraft tool "${name}"${toolUseId === null ? '' : ` (tool use ${toolUseId})`}:\n${toolResult}`,
			...steers,
		].join('\n\n');
		presented.commit();
		const contextTokens = this.#lastContextTokens;
		this.#sessionId = null;
		this.#rotations += 1;
		this.#rotationDue = false;
		this.#lastContextTokens = 0;
		this.#turnsSinceRotation = 0;
		this.#awaitingFloor = true;
		providerEvent(active.onVerbose, 'native_provider_session_rotated', { turnId: active.turnId, midTurn: true, contextTokens, rotations: this.#rotations, handoffBytes: Buffer.byteLength(active.handoff, 'utf8') });
		if (this.#server !== null) {
			void this.#request(this.#server, 'POST', `/session/${encodeURIComponent(retired)}/abort`, {}, { timeoutMs: this.#config.interruptTimeoutMs })
				.catch(() => {})
				.then(() => this.#request(this.#server, 'DELETE', `/session/${encodeURIComponent(retired)}`, null, { timeoutMs: 5_000 }).catch(() => {}));
		}
		return toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'The completed tool result continues in a fresh session.' }, false);
	}

	#steerEncoder(active) {
		return async (input) => {
			const text = await resolveSteerInput(input);
			active.latestInput = text;
			this.#noteEventFacts(text);
			return encodeNativeEventInput(text, this.#observationViews);
		};
	}

	#carryOver(reason) {
		const lines = this.#recentTools.lines().map((entry) => `- ${entry}`);
		return [
			`${reason}: earlier turns are not shown. The event restates goal, intent (now), task memory and facts; read taskPlan, programStatus or memory for more.`,
			...(lines.length === 0 ? [] : ['Your most recent tool calls (oldest first):', ...lines]),
			...(this.#recentConversation.length === 0 ? [] : ['Recent conversation already delivered to you (oldest first):', ...this.#recentConversation.map((entry) => `- ${entry}`)]),
			...this.#failureCarryOver.lines([]),
			...(this.#lastProgram === null ? [] : [`Last known program (verify with programStatus): ${JSON.stringify(this.#lastProgram)}`]),
			...(this.#lastAgentText === null ? [] : [`Your last note: ${JSON.stringify(this.#lastAgentText)}`]),
		].join('\n');
	}

	#noteEventFacts(text) {
		const separator = text.indexOf('\n');
		if (separator < 0) return;
		const lineEnd = text.indexOf('\n', separator + 1);
		let value;
		try { value = JSON.parse(text.slice(separator + 1, lineEnd < 0 ? text.length : lineEnd)); } catch { return; }
		for (const event of [value, ...(Array.isArray(value?.mergedEvents) ? value.mergedEvents : [])]) {
			this.#recentTools.noteDelivered(event);
			this.#active?.toolDigests.noteDelivered(event);
			this.#failureCarryOver.noteEnvelope(correlateFailureEvent(event));
		}
		for (const entry of Array.isArray(value?.conversation?.entries) ? value.conversation.entries : []) {
			const speaker = typeof entry?.sourceName === 'string' ? entry.sourceName : typeof entry?.sourceId === 'string' ? entry.sourceId : entry?.kind ?? 'message';
			if (typeof entry?.text !== 'string') continue;
			this.#recentConversation.push(`${truncate(String(speaker), 48)}: ${truncate(entry.text, 200)}`);
		}
		if (this.#recentConversation.length > CARRY_OVER_CONVERSATION) this.#recentConversation.splice(0, this.#recentConversation.length - CARRY_OVER_CONVERSATION);
		if (value?.program !== null && typeof value?.program === 'object') this.#noteProgram(value.program);
	}

	#noteProgram(value) {
		if (value === null || typeof value !== 'object' || typeof value.programId !== 'string') return;
		const decision = value.decision ?? value.status?.decision;
		this.#lastProgram = {
			programId: value.programId,
			...(typeof value.state === 'string' ? { state: value.state } : {}),
			...(typeof value.engineState === 'string' ? { engineState: value.engineState } : {}),
			...(typeof decision?.decisionId === 'string' ? { pendingDecisionId: decision.decisionId, trigger: decision.trigger } : {}),
		};
	}

	#rememberTool(name, args, result, digests) {
		if (name === 'replaceAction' && typeof args?.actionId === 'string' && typeof result?.actionId === 'string' && args.actionId !== result.actionId && result.replacedAction === undefined) {
			const replaced = { actionId: args.actionId, state: 'CANCELLED', reasonCode: 'ACTION_REPLACED' };
			digests.noteDelivered(replaced);
			this.#recentTools.noteDelivered(replaced);
		}
		this.#failureCarryOver.noteEnvelope(result);
		digests.push(name, truncate(JSON.stringify(args ?? {}), 160), result);
		return this.#recentTools.push(name, truncate(JSON.stringify(args ?? {}), 160), result);
	}
}

/** The generated OpenCode config: our agent prompt, the Minecraft MCP route and the built-in tools blocked. */
export function buildOpenCodeConfig({ prompt, mcp = null }) {
	if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new TypeError('prompt must be nonblank');
	return {
		$schema: 'https://opencode.ai/config.json',
		autoupdate: false,
		share: 'disabled',
		snapshot: false,
		...(mcp === null ? {} : { mcp: { [MCP_SERVER_NAME]: { type: 'remote', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` }, enabled: true, oauth: false, timeout: MCP_TOOL_TIMEOUT_MS } } }),
		// A blocked built-in tool returns an error to the model instead of ending its turn.
		experimental: { mcp_timeout: MCP_TOOL_TIMEOUT_MS, continue_loop_on_deny: true },
		agent: { [AGENT_NAME]: { description: 'Minecraft player', mode: 'primary', prompt } },
		permission: structuredClone(OPENCODE_PERMISSION),
	};
}

/**
 * `opencode serve` isolated from the operator's own OpenCode setup: no global config, AGENTS.md, Claude Code files,
 * plugins or project config; a private session database. The saved login (XDG data home) is the only shared state.
 * Arguments start with --pure so the idle-server reaper (pattern "serve --hostname=") never matches a live agent.
 */
export function buildOpenCodeLaunch(config, { directory, configFile, password }) {
	const environment = createProviderChildEnvironment('opencode', config.environment ?? process.env, config.bridgeSecretEnvironmentVariable);
	return {
		command: config.executable,
		args: ['serve', '--pure', '--port', '0', '--hostname', '127.0.0.1'],
		options: {
			cwd: directory,
			env: {
				...environment,
				OPENCODE_CONFIG: configFile,
				XDG_CONFIG_HOME: path.join(directory, 'config-home'),
				OPENCODE_DB: path.join(directory, 'opencode.db'),
				OPENCODE_DISABLE_CLAUDE_CODE: '1',
				OPENCODE_DISABLE_PROJECT_CONFIG: '1',
				OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
				OPENCODE_DISABLE_AUTOUPDATE: '1',
				OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
				OPENCODE_SERVER_PASSWORD: password,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		},
	};
}

/** Maps an OpenCode message error onto the coordinator's recovery codes; only provider limits are retried. */
export function classifyOpenCodeError(error) {
	const name = typeof error?.name === 'string' ? error.name : 'UnknownError';
	const data = error?.data ?? {};
	const message = String(data.message ?? error?.message ?? '');
	const body = String(data.responseBody ?? '');
	const statusCode = Number.isSafeInteger(data.statusCode) ? data.statusCode : null;
	const text = `${message}\n${body}`;
	const retryAfterMs = parseRetryAfter(data.responseHeaders);
	const result = (code, retryable) => ({ code, retryable, name, message, statusCode, retryAfterMs });
	if (name === 'MessageAbortedError') return result('TURN_INTERRUPTED', false);
	if (name === 'ProviderAuthError') return result('AUTHENTICATION_REQUIRED', false);
	if (name === 'ContextOverflowError') return result('CONTEXT_OVERFLOW', false);
	// The free tier refuses clients other than OpenCode and configurations without its built-in tools; waiting cannot fix that.
	if (/only be used from within opencode/i.test(text)) return result('MODEL_UNAVAILABLE', false);
	if (statusCode === 429 || /free.?tier.?error|rate.?limit|too many requests|overloaded|capacity|quota|try again later/i.test(text)) return result('RATE_LIMITED', true);
	if (statusCode !== null && statusCode >= 500 || /endpoint is unavailable|service unavailable|upstream request failed|bad gateway/i.test(text)) return result('PROVIDER_UNAVAILABLE', true);
	if (statusCode === 401 || /not logged in|invalid api key|unauthori[sz]ed|authenticat/i.test(text)) return result('AUTHENTICATION_REQUIRED', false);
	if (/model .*not (?:available|found)|no such model|unknown model/i.test(text)) return result('MODEL_UNAVAILABLE', false);
	return result('TURN_FAILED', data.isRetryable === true);
}

export function retryDelayMs(attempt, retryAfterMs = null) {
	const backoff = Math.min(RATE_LIMIT_RETRY.maxMs, RATE_LIMIT_RETRY.baseMs * 2 ** Math.max(0, attempt));
	return Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(RATE_LIMIT_RETRY.maxMs * 5, Math.max(backoff, retryAfterMs)) : backoff;
}

function parseRetryAfter(headers) {
	if (headers === null || typeof headers !== 'object') return null;
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after');
	if (entry === undefined) return null;
	const seconds = Number(entry[1]);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const at = Date.parse(entry[1]);
	return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export function splitModel(model) {
	const index = String(model).indexOf('/');
	if (index <= 0 || index === model.length - 1) throw new OpenCodeProviderError('UNSUPPORTED_MODEL', `opencode model '${model}' must be provider/model`);
	return [model.slice(0, index), model.slice(index + 1)];
}

/** JSON over loopback HTTP with no client-side deadline by default: a turn's prompt request lasts the whole turn. */
export function httpJsonRequest(server, method, pathname, body = null, { timeoutMs = 0 } = {}) {
	return new Promise((resolve, reject) => {
		if (server === null || typeof server?.url !== 'string') { reject(new OpenCodeProviderError('PROVIDER_UNAVAILABLE', 'OpenCode server is not running')); return; }
		const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
		const request = http.request(new URL(pathname, server.url), {
			method, agent: false,
			headers: { authorization: server.auth, accept: 'application/json', ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': payload.length }) },
		}, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				if (response.statusCode < 200 || response.statusCode >= 300) { reject(new OpenCodeProviderError('PROVIDER_UNAVAILABLE', `OpenCode ${method} ${pathname.split('?')[0]} returned ${response.statusCode}: ${excerpt(text)}`)); return; }
				if (text.trim().length === 0) { resolve(null); return; }
				try { resolve(JSON.parse(text)); } catch (error) { reject(new OpenCodeProviderError('INVALID_PROVIDER_OUTPUT', 'OpenCode returned invalid JSON', { cause: error })); }
			});
			response.on('error', reject);
		});
		request.on('error', reject);
		if (timeoutMs > 0) request.setTimeout(timeoutMs, () => request.destroy(new OpenCodeProviderError('PROVIDER_TIMEOUT', `OpenCode ${method} timed out`)));
		request.end(payload ?? undefined);
	});
}

/** Subscribes to the server's event stream (server-sent events) and reconnects while the server lives. */
export function openEventStream(server, onEvent) {
	let closed = false;
	let request = null;
	const connect = () => {
		if (closed || server.exited) return;
		request = http.get(new URL('/event', server.url), { agent: false, headers: { authorization: server.auth, accept: 'text/event-stream' } }, (response) => {
			response.setEncoding('utf8');
			let buffer = '';
			response.on('data', (chunk) => {
				buffer += chunk;
				let boundary;
				while ((boundary = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
					if (data.length === 0) continue;
					let event;
					try { event = JSON.parse(data); } catch { continue; }
					try { onEvent(event); } catch { /* one bad event cannot stop the stream */ }
				}
			});
			response.on('end', () => { if (!closed) setTimeout(connect, 250).unref?.(); });
			response.on('error', () => {});
		});
		request.on('error', () => { if (!closed) setTimeout(connect, 500).unref?.(); });
	};
	connect();
	return { close() { closed = true; request?.destroy(); } };
}

function basicAuth(password) { return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`; }

/** Bearer tokens and server passwords are 48+ hex characters; nothing that long reaches a log. */
export function redactSecrets(text) { return String(text).replace(/[0-9a-f]{40,}/gi, '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>'); }

function systemPromptFor(controlProtocol, recoverySummary, minecraftInstructions, skillInstructions) {
	if (controlProtocol === 'native_tools') {
		const base = minecraftInstructions === '' ? NATIVE_AGENT_INSTRUCTIONS : nativeInstructions(minecraftInstructions, skillInstructions);
		return `${base}\n\n${OPENCODE_TOOL_NOTE}\n\n${nativeRecoveryInstructions(recoverySummary)}\n`;
	}
	if (controlProtocol === 'goal_spec') return `${goalSpecInstructions()}\n\nReturn only one JSON value matching the supplied output schema. Never call tools.\n`;
	return `${PLANNER_SYSTEM_PROMPT}\n\n${recoveryInstructions(recoverySummary)}\n`;
}

function nativeCapture(active, sessionId) {
	return { ...active.callLog.snapshot(), turnId: active.turnId, threadId: sessionId,
		tokens: { input: active.usage.input + active.usage.cacheRead + active.usage.cacheWrite, output: active.usage.output,
			reasoning: null, cached: active.usage.cacheRead, cacheWrite: active.usage.cacheWrite } };
}

/** Appends queued steers to a tool result so the model sees them before its next decision. */
async function deliverSteers(active, content, encode = (text) => text) {
	while (active.pendingSteers !== null) {
		const pending = active.pendingSteers;
		let text;
		try { text = await encode(await pending.buildInput()); }
		catch (error) {
			if (active.pendingSteers !== pending) { discardPendingSteer(pending); continue; }
			active.pendingSteers = null;
			discardPendingSteer(pending);
			for (const waiter of pending.waiters) waiter.reject(error);
			return content;
		}
		if (active.pendingSteers !== pending) { discardPendingSteer(pending); continue; }
		active.pendingSteers = null;
		providerEvent(active.onVerbose, 'native_provider_steer_delivered', { turnId: active.turnId, steers: pending.waiters.length, waitMs: Math.max(0, Date.now() - pending.queuedAt) });
		const delivered = { ...content, contentItems: [...content.contentItems, { type: 'inputText', text: `Newer coordinator events for this turn (treat them exactly like the turn input):\n${text}` }] };
		for (const waiter of pending.waiters) waiter.resolve();
		return delivered;
	}
	return content;
}

function failPendingSteers(active) {
	const pending = active.pendingSteers;
	active.pendingSteers = null;
	discardPendingSteer(pending);
	for (const waiter of pending?.waiters ?? []) waiter.reject(new OpenCodeProviderError('TURN_NOT_ACTIVE', 'OpenCode turn ended before the steer reached a tool boundary'));
}

function discardPendingSteer(pending) {
	if (pending === null || pending === undefined || pending.discarded) return;
	pending.discarded = true;
	try { pending.onDiscard?.(); } catch { /* cleanup reporting cannot interrupt the next steer */ }
}

async function resolveSteerInput(input) {
	const resolved = typeof input === 'function' ? await input() : input;
	if (typeof resolved !== 'string' || resolved.trim().length === 0) throw new TypeError('native steer builder must return nonblank text');
	return resolved;
}

function mcpContent({ success, contentItems }) {
	return { content: contentItems.map((item) => ({ type: 'text', text: item.text })), isError: success === false };
}

function createSilenceDeadline(timeoutMs, schedule, cancelSchedule) {
	let handle = null;
	let generation = 0;
	let disposed = false;
	let paused = 0;
	let rejectDeadline;
	const promise = new Promise((_, reject) => { rejectDeadline = reject; });
	void promise.catch(() => {});
	const clear = () => { generation += 1; if (handle !== null) cancelSchedule(handle); handle = null; };
	const restart = () => {
		if (disposed) return;
		clear();
		if (paused > 0) return;
		const expected = generation;
		handle = schedule(() => {
			if (disposed || generation !== expected) return;
			handle = null;
			rejectDeadline(new OpenCodeProviderError('PLANNING_TIMEOUT', `OpenCode provider was silent for ${timeoutMs} ms`));
		}, timeoutMs);
	};
	return { promise, restart, pause() { paused += 1; clear(); }, resume() { paused = Math.max(0, paused - 1); restart(); }, dispose() { disposed = true; clear(); } };
}

function withDeadline(promise, timeoutMs, schedule, cancelSchedule, createError) {
	let handle;
	const timeout = new Promise((_, reject) => { handle = schedule(() => reject(createError()), timeoutMs); handle?.unref?.(); });
	return Promise.race([promise, timeout]).finally(() => cancelSchedule(handle));
}

function validateServiceConfig(config) {
	if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('OpenCode service config must be an object');
	if ((config.provider ?? 'opencode') !== 'opencode') throw new TypeError('OpenCode provider must be opencode');
	const models = requireStringArray(config.models ?? Object.keys(OPENCODE_MODELS), 'models');
	for (const model of models) splitModel(model);
	const reasoningEfforts = requireStringArray(config.reasoningEfforts ?? OPENCODE_REASONING_EFFORTS, 'reasoningEfforts');
	for (const effort of reasoningEfforts) if (!OPENCODE_REASONING_EFFORTS.includes(effort)) throw new TypeError(`OpenCode reasoning effort '${effort}' must be one of ${OPENCODE_REASONING_EFFORTS.join(', ')}`);
	return {
		...config,
		provider: 'opencode',
		executable: requireText(config.executable ?? 'opencode', 'executable'),
		runtimeRoot: config.runtimeRoot === undefined || config.runtimeRoot === null ? null : path.resolve(config.runtimeRoot),
		models,
		reasoningEfforts,
		planningTimeoutMs: positiveInteger(config.planningTimeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS, 'planningTimeoutMs'),
		startupTimeoutMs: positiveInteger(config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs'),
		interruptTimeoutMs: positiveInteger(config.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS, 'interruptTimeoutMs'),
		maxDecisionBytes: positiveInteger(config.maxDecisionBytes ?? DEFAULT_MAX_DECISION_BYTES, 'maxDecisionBytes'),
		contextRotationTokens: nonnegativeInteger(config.contextRotationTokens ?? DEFAULT_CONTEXT_ROTATION_TOKENS, 'contextRotationTokens'),
	};
}

function validateProfile(value, config) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('agent profile must be an object');
	const profile = {
		agentId: requireText(value.agentId, 'agentId'),
		provider: value.provider ?? 'opencode',
		model: requireText(value.model, 'model'),
		reasoningEffort: requireText(value.reasoningEffort, 'reasoningEffort'),
		serviceTier: requireText(value.serviceTier ?? 'priority', 'serviceTier'),
	};
	if (profile.provider !== 'opencode') throw new OpenCodeProviderError('PROVIDER_MISMATCH', `Expected opencode profile, received ${profile.provider}`);
	return profile;
}

function validateControlProtocol(value) {
	if (!CONTROL_PROTOCOLS.has(value)) throw new TypeError("controlProtocol must be 'arena_script', 'native_tools', or 'goal_spec'");
	return value;
}

function assertSameSession(entry, profile, protocol) { if (!profilesMatch(entry.profile, profile) || entry.controlProtocol !== protocol) throw profileConflict(profile.agentId); }
function profileConflict(agentId) { return new OpenCodeProviderError('AGENT_PROFILE_CONFLICT', `opencode agent '${agentId}' already has a different profile`); }
function assertReconciliationActive(signal) { if (signal?.aborted) throw new OpenCodeProviderError('STALE_RECONCILIATION', 'OpenCode reconciliation was superseded'); }
function assertLifecycleActive(expected, current) { if (expected !== current) throw new OpenCodeProviderError('PROVIDER_STOPPED', 'OpenCode service lifecycle was stopped'); }
/** Models without OpenCode variants run with their default reasoning; 'default' names that choice. */
function openCodeVariant(effort) { return effort === 'default' ? {} : { variant: effort }; }

function providerEvent(callback, event, fields) { safeVerbose(callback, 'provider_event', JSON.stringify({ event, ...fields })); }
function safeVerbose(callback, stage, message) {
	if (typeof callback !== 'function') return;
	try { Promise.resolve(callback(stage, message)).catch(() => {}); } catch { /* reporting cannot affect provider work */ }
}
function normalizeRecoverySummary(value) {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string' || value.length > 2_048) throw new TypeError('recoverySummary must be at most 2048 characters');
	return value;
}
function profilesMatch(left, right) { return ['agentId', 'provider', 'model', 'reasoningEffort', 'serviceTier'].every((key) => left[key] === right[key]); }
function stripCodeFence(text) { const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text); return fenced === null ? text : fenced[1].trim(); }
function excerpt(value) { return JSON.stringify(redactSecrets(typeof value === 'string' ? value : JSON.stringify(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512)); }
function count(value) { return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0; }
function openCodeTokens(tokens) {
	if (tokens === null || typeof tokens !== 'object') return null;
	return { input: count(tokens.input), output: count(tokens.output) + count(tokens.reasoning), reasoning: count(tokens.reasoning), cached: count(tokens.cache?.read), cacheWrite: count(tokens.cache?.write) };
}
function addUsage(target, usage) {
	target.calls += 1;
	for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) target[key] += usage[key];
	if ('reasoning' in target) target.reasoning += usage.reasoning;
}
/** Totals of interrupted turns, each already including any turn it carried; null when there are none. */
function carriedUsage(turns) {
	if (turns.length === 0) return null;
	const total = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 };
	for (const { usage } of turns) for (const key of ['calls', 'input', 'cacheRead', 'cacheWrite', 'output']) total[key] += usage[key];
	return total;
}
function truncate(text, max) { return text.length <= max ? text : `${text.slice(0, max - 3)}...`; }
function requireText(value, field) { if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be nonblank`); return value.trim(); }
function requireStringArray(value, field) { if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a nonempty array`); return [...new Set(value.map((entry) => requireText(entry, field)))]; }
function positiveInteger(value, field) { if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`); return value; }
function nonnegativeInteger(value, field) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a nonnegative safe integer`); return value; }
