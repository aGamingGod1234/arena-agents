import { toolErrorResult } from './failure-schema.mjs';
import { arenaScriptDiagnosticFields, arenaScriptDiagnosticSummary } from './arena-script/errors.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { terminateChildProcess, spawnOwnedProcess as nodeSpawn } from './child-process-lifecycle.mjs';
import { ClaudeToolServer } from './claude-tool-server.mjs';
import { DEFAULT_CONTEXT_ROTATION_TOKENS, ToolDigests } from './context-carry-over.mjs';
import { FailureCarryOver, correlateFailureEvent, shareVisibleFailureFields } from './failure-carry-over.mjs';
import { HandoffBudget, CONTEXT_PRICE_USD } from './handoff-budget.mjs';
import { goalSpecInstructions, nativeInstructions, nativeRecoveryInstructions, nativeToolSchedulingClass, isNativeBodyTool, presentNativeToolResult, recoveryInstructions } from './codex-service.mjs';
import { NativeCallLog } from './native-call-log.mjs';
import { parseDecision } from './decision-parser.mjs';
import { ModelObservationViews, decodeModelFacts, encodeModelFacts, encodeNativeEventInput } from './model-fact-encoding.mjs';
import { NATIVE_AGENT_INSTRUCTIONS, normalizeMinecraftToolCall, presentedTool, toolResultContent } from './native-minecraft-tools.mjs';
import { PLANNER_OUTPUT_SCHEMA, PLANNER_SYSTEM_PROMPT } from './prompts.mjs';
import { DIRECTLY_SPAWNABLE_WINDOWS_EXTENSIONS, createProviderChildEnvironment, environmentValue, findExecutableOnPath, findNpmEntrypointBesideShim } from './provider-environment.mjs';
import { createExecutionSettings } from './provider-identity.mjs';
import { createSessionMetadata, profileFingerprint } from './provider-session.mjs';
import { recordProviderTurn } from './provider-turn-recorder.mjs';
import { estimateTokenCostUsd } from './call-cost.mjs';
import { reportVisibleOutput } from './verbose-output.mjs';
import { parseClaudeRateLimitEvent } from './provider-discovery.mjs';

export const CLAUDE_MODELS = Object.freeze({
	'claude-opus-5-5': 'Claude Opus 5.5',
	'claude-sonnet-5-5': 'Claude Sonnet 5.5',
	'claude-fable-5-1': 'Claude Fable 5.1',
});
// Claude agents are offered only Low through High; xhigh and max are deliberately excluded.
export const CLAUDE_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);

const CONTROL_PROTOCOLS = new Set(['arena_script', 'native_tools', 'goal_spec']);
const MCP_SERVER_NAME = 'minecraft';
const DEFAULT_PLANNING_TIMEOUT_MS = 120_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_DECISION_BYTES = 256 * 1_024;
const DEFAULT_STDOUT_LINE_LIMIT_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1_024;
const MAX_PUBLIC_AGENT_MESSAGE_CHARS = 1_280;
// Claude Code would otherwise apply its own MCP timeout to long-running tools such as runProgram.
const MCP_TOOL_TIMEOUT_MS = '600000';
// Every model call re-reads the whole conversation. Near this threshold, warm a fresh session and hand the
// active turn over at its next tool boundary; the same prompt and tools preserve prefix reuse.
// A replacement must earn its write cost through paid context reads. The original size threshold
// and growth guard also apply, so a large handoff cannot thrash.
const MIN_TURNS_BETWEEN_ROTATIONS = 3;
const MIN_ROTATION_GROWTH_SHARE = 0.25;
// A handoff's turn input can be minutes old in a long turn; past this age it says so.
const STALE_TURN_INPUT_MS = 30_000;
// Digests of the active turn's earlier calls in a mid-turn handoff; running and newest finished action IDs always survive.
const MID_TURN_TOOL_DIGESTS = 12;
const STANDBY_WARMUP_LEAD_TOKENS = 10_000;
const STANDBY_READY_TIMEOUT_MS = 250;
const DEFAULT_MAX_CONCURRENT_STANDBYS = 2;
const DEFAULT_STANDBY_IDLE_TIMEOUT_MS = 3_000;
// The event's now header carries intent, the unresolved failure and the last effect; older calls repeat it.
const CARRY_OVER_TOOL_CALLS = 6;
const MAX_TRACED_TOOLS = 8;
const CARRY_OVER_CONVERSATION = 6;
// USD per token implied by Claude Code's own costUsd (exact fit over six traced turns); uncached input is a 0.1x-read
// style estimate and tiny in practice. Used only for calls whose process ends before it reports a result line.
export const CALL_PRICE_USD = CONTEXT_PRICE_USD;
// Streamed token events renew liveness at most this often.
const STREAM_PROGRESS_INTERVAL_MS = 1_000;
// Claude Code builds without --include-partial-messages; recorded when one rejects the flag.
const PARTIAL_MESSAGES_UNSUPPORTED = new Set();

/**
 * Tool names, instructions, and the dedicated Minecraft workspace are the same ones
 * Codex receives. Claude Code namespaces MCP tools, so the bare names used by the
 * shared instructions are mapped once here.
 */
const CLAUDE_TOOL_NOTE = `Claude Code exposes the Minecraft tools as ${'`'}mcp__${MCP_SERVER_NAME}__<name>${'`'}; every tool name in these instructions refers to that tool (for example observe is mcp__${MCP_SERVER_NAME}__observe). A tool result may end with newer coordinator events for the same body; treat them exactly like the turn input.`;

export class ClaudeProviderError extends Error {
	constructor(code, message, options = undefined) {
		super(message, options);
		this.name = 'ClaudeProviderError';
		this.code = code;
	}
}

export class ClaudeProviderService {
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
	#standbyLeases = new Set();

	constructor(config, dependencies = {}) {
		this.#config = validateServiceConfig(config);
		this.#dependencies = {
			spawn: dependencies.spawn ?? nodeSpawn,
			terminate: dependencies.terminate ?? terminateChildProcess,
			fs: { mkdir, writeFile, rm, chmod, ...(dependencies.fs ?? {}) },
			schedule: dependencies.schedule ?? setTimeout,
			cancelSchedule: dependencies.cancelSchedule ?? clearTimeout,
			// Evaluation only (decision-eval): a fixed observation-view session id; production leaves it random.
			observationViewSession: dependencies.observationViewSession ?? null,
		};
		this.#minecraftWorkspace = dependencies.minecraftWorkspace ?? null;
		if (this.#minecraftWorkspace !== null && typeof this.#minecraftWorkspace.prepare !== 'function') {
			throw new TypeError('minecraftWorkspace must expose prepare()');
		}
		this.#workspaceManager = dependencies.workspaceManager ?? null;
		if (this.#workspaceManager !== null && typeof this.#workspaceManager.prepare !== 'function') {
			throw new TypeError('workspaceManager must expose prepare(provider, agentId)');
		}
		this.#ownsToolServer = dependencies.toolServer === undefined;
		this.#toolServer = dependencies.toolServer ?? new ClaudeToolServer();
		this.catalog = new ClaudeCatalog(this.#config);
	}

	async start() {}
	get agentIds() { return [...this.#agents.keys()]; }
	getAgent(agentId) { return this.#agents.get(agentId) ?? null; }

	async createAgent(profileValue, { recoverySummary = null, controlProtocol = 'native_tools' } = {}) {
		const lifecycleGeneration = this.#lifecycleGeneration;
		const profile = validateProfile(profileValue, this.#config);
		const protocol = validateControlProtocol(controlProtocol);
		const replacing = this.#replacing.get(profile.agentId);
		if (replacing !== undefined) {
			assertSameSession(replacing, profile, protocol);
			return replacing.promise;
		}
		const existing = this.#agents.get(profile.agentId);
		if (existing !== undefined) {
			if (!existing.matchesProfile(profile) || !existing.matchesControlProtocol(protocol)) throw profileConflict(profile.agentId);
			return existing;
		}
		const creating = this.#creating.get(profile.agentId);
		if (creating !== undefined) {
			assertSameSession(creating, profile, protocol);
			return creating.promise;
		}
		const promise = this.#createAgentOnce(profile, recoverySummary, protocol, lifecycleGeneration);
		this.#creating.set(profile.agentId, { profile, controlProtocol: protocol, promise });
		try { return await promise; } finally { this.#creating.delete(profile.agentId); }
	}

	async replaceAgent(profileValue, { recoverySummary = null, controlProtocol = 'native_tools', expectedSessionGeneration = null } = {}) {
		const lifecycleGeneration = this.#lifecycleGeneration;
		const profile = validateProfile(profileValue, this.#config);
		const protocol = validateControlProtocol(controlProtocol);
		const replacing = this.#replacing.get(profile.agentId);
		if (replacing !== undefined) {
			assertSameSession(replacing, profile, protocol);
			return replacing.promise;
		}
		const creating = this.#creating.get(profile.agentId);
		if (creating !== undefined) assertSameSession(creating, profile, protocol);
		const existing = this.#agents.get(profile.agentId);
		if (existing !== undefined) {
			if (!existing.matchesProfile(profile) || !existing.matchesControlProtocol(protocol)) throw profileConflict(profile.agentId);
			if (expectedSessionGeneration !== null && existing.sessionGeneration !== expectedSessionGeneration) {
				throw new ClaudeProviderError('STALE_SESSION_GENERATION', 'Claude replacement target is no longer current');
			}
		}
		const promise = (async () => {
			if (creating !== undefined) await creating.promise.catch(() => {});
			const owned = this.#agents.get(profile.agentId);
			if (owned !== undefined) {
				this.#agents.delete(profile.agentId);
				await owned.dispose();
			}
			return this.#createAgentOnce(profile, recoverySummary, protocol, lifecycleGeneration);
		})();
		const entry = { profile, controlProtocol: protocol, promise };
		this.#replacing.set(profile.agentId, entry);
		try { return await promise; } finally {
			if (this.#replacing.get(profile.agentId) === entry) this.#replacing.delete(profile.agentId);
		}
	}

	async #createAgentOnce(profile, recoverySummary, controlProtocol, lifecycleGeneration) {
		this.catalog.assertSupported(profile.model, profile.reasoningEffort, profile.serviceTier);
		const summary = normalizeRecoverySummary(recoverySummary);
		let cwd;
		let systemPrompt;
		try {
			if (this.#minecraftWorkspace !== null) {
				// Same dedicated workspace, AGENTS.md, and minecraft-control skill that Codex receives.
				const prepared = await this.#minecraftWorkspace.prepare();
				if (prepared === null || typeof prepared !== 'object' || typeof prepared.cwd !== 'string') {
					throw new TypeError('minecraftWorkspace.prepare() must return cwd');
				}
				cwd = prepared.cwd;
				systemPrompt = systemPromptFor(controlProtocol, summary, prepared.instructions?.trim() ?? '', prepared.skillInstructions?.trim() ?? '');
			} else {
				cwd = this.#workspaceManager === null
					? this.#config.cwd
					: await this.#workspaceManager.prepare(profile.provider, profile.agentId);
				systemPrompt = systemPromptFor(controlProtocol, summary, '', '');
			}
		} catch (error) {
			throw new ClaudeProviderError('PROVIDER_UNAVAILABLE', `Could not prepare the Claude agent workspace: ${error?.message ?? String(error)}`, { cause: error });
		}
		assertLifecycleActive(lifecycleGeneration, this.#lifecycleGeneration);
		const sessionGeneration = (this.#sessionGenerations.get(profile.agentId) ?? 0) + 1;
		this.#sessionGenerations.set(profile.agentId, sessionGeneration);
		const agentRoot = path.join(this.#config.runtimeRoot, agentDirectoryName(profile.agentId));
		const systemPromptFile = path.join(agentRoot, `system-prompt-${sessionGeneration}.md`);
		await this.#dependencies.fs.mkdir(agentRoot, { recursive: true });
		await this.#dependencies.fs.writeFile(systemPromptFile, systemPrompt, 'utf8');
		await this.#dependencies.fs.chmod(systemPromptFile, 0o600).catch(() => {});
		const agent = new ClaudeAgent(profile, {
			...this.#dependencies,
			acquireStandby: () => {
				if (this.#standbyLeases.size >= this.#config.maxConcurrentStandbys) return null;
				const lease = {};
				this.#standbyLeases.add(lease);
				return () => this.#standbyLeases.delete(lease);
			},
			config: this.#config,
			cwd,
			controlProtocol,
			systemPromptFile,
			toolServer: this.#toolServer,
			sessionGeneration,
			resetReason: sessionGeneration > 1 ? 'session_replaced' : null,
			onInvalidated: (invalidated) => { if (this.#agents.get(invalidated.agentId) === invalidated) this.#agents.delete(invalidated.agentId); },
		});
		if (lifecycleGeneration !== this.#lifecycleGeneration) {
			await agent.dispose();
			throw new ClaudeProviderError('PROVIDER_STOPPED', 'Claude service lifecycle was stopped');
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
		if (!Array.isArray(records)) throw new TypeError('claude reconciliation records must be an array');
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
		const valid = [];
		const invalid = [];
		for (const record of records) {
			try {
				const profile = validateProfile(record, this.#config);
				this.catalog.assertSupported(profile.model, profile.reasoningEffort, profile.serviceTier);
				valid.push(profile);
			} catch (error) { invalid.push({ profile: record, code: error.code ?? 'INVALID_PROFILE', message: error.message }); }
		}
		return { valid, invalid, removed, catalog: await this.catalog.refresh() };
	}

	async stop() {
		this.#lifecycleGeneration += 1;
		await Promise.allSettled([
			...[...this.#creating.values()].map((entry) => entry.promise),
			...[...this.#replacing.values()].map((entry) => entry.promise),
		]);
		this.#creating.clear();
		this.#replacing.clear();
		const agents = [...this.#agents.values()];
		this.#agents.clear();
		await Promise.allSettled(agents.map((agent) => agent.dispose()));
		if (this.#ownsToolServer) await this.#toolServer.stop();
	}
}

class ClaudeCatalog {
	#config;
	stale = false;

	constructor(config) { this.#config = config; }

	async refresh() { return this.snapshot(); }

	snapshot() {
		return {
			provider: 'claude',
			refreshedAtEpochMs: Date.now(),
			models: this.#config.models.map((model) => ({
				id: model,
				model,
				displayName: CLAUDE_MODELS[model] ?? readableModel(model),
				reasoningEfforts: [...this.#config.reasoningEfforts],
				serviceTiers: ['priority'],
			})),
		};
	}

	assertSupported(model, reasoningEffort, serviceTier = 'priority') {
		if (!this.#config.models.includes(model)) throw new ClaudeProviderError('UNSUPPORTED_MODEL', `claude model '${model}' is not configured`);
		if (!this.#config.reasoningEfforts.includes(reasoningEffort)) throw new ClaudeProviderError('UNSUPPORTED_THINKING', `claude model '${model}' does not support effort '${reasoningEffort}'`);
		if (serviceTier !== 'priority') throw new ClaudeProviderError('UNSUPPORTED_SERVICE_TIER', `claude service tier '${serviceTier}' is not supported`);
	}
}

/**
 * One Claude Code process per native agent keeps the conversation warm across
 * turns, mirroring a Codex app-server thread. Turns are user messages on the
 * stream-json input, and each `result` line closes the current turn.
 */
class ClaudeAgent {
	#profile;
	#config;
	#cwd;
	#controlProtocol;
	#systemPromptFile;
	#toolServer;
	#spawn;
	#terminate;
	#fs;
	#schedule;
	#cancelSchedule;
	#onInvalidated;
	#sessionGeneration;
	#resetReason;
	#executionSettings;
	#goalRevision = 0;
	#sessionState = 'cold';
	#process = null;
	#processStart = null;
	#standbyProcess = null;
	#standbyStart = null;
	#standbyGeneration = 0;
	#standbyRelease = null;
	#standbyFailedForProcess = false;
	#standbyIdleTimer = null;
	#acquireStandby;
	#route = null;
	#sessionId = null;
	#active = null;
	#usageOwner = null;
	#lastOnVerbose = null;
	#awaitingResult = 0;
	#idleWaiters = [];
	#toolsListed = null;
	#oneShot = null;
	#disposed = false;
	#invalidationError = null;
	#turnSequence = 0;
	#observationViews;
	// Token accounting across this agent's Claude Code sessions (rotation keeps one running total).
	#usage = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 };
	// Interrupted turns report nothing themselves; the next turn reports their billed calls (each call is owned by its turn).
	#interruptedTurns = [];
	#calls = new Map();
	#currentCallId = null;
	#requestAt = null;
	// Stream marks of the model call in flight; a call keeps the object it started with.
	#stream = newStreamMarks();
	#lastContextTokens = 0;
	#handoffBudget = new HandoffBudget();
	// A session started by a mid-turn handoff records its first call's context: the handoff's own size.
	#awaitingHandoffFloor = false;
	#sessionFloorTokens = null;
	#rotationDue = false;
	#rotations = 0;
	#turnsSinceRotation = 0;
	#pendingCarryOver = null;
	// Late outcomes of controls detached from a retired session, kept apart from the replaceable handoff carry-over.
	#lateOutcomes = [];
	#processUsed = false;
	#processCostUsd = 0;
	#unreportedCostUsd = 0;
	#lastStreamProgressAt = 0;
	#recentTools = new ToolDigests(CARRY_OVER_TOOL_CALLS);
	#failureCarryOver = new FailureCarryOver();
	#recentConversation = [];
	#lastProgram = null;
	#lastAgentText = null;
	#routeEpochSequence = 0;
	#handoffPending = null;

	constructor(profile, { config, cwd, controlProtocol, systemPromptFile, toolServer, spawn, terminate, fs, schedule, cancelSchedule, acquireStandby, sessionGeneration, resetReason, onInvalidated, observationViewSession = null }) {
		this.#observationViews = new ModelObservationViews({ session: observationViewSession });
		this.#profile = structuredClone(profile);
		this.#config = config;
		this.#cwd = cwd;
		this.#controlProtocol = controlProtocol;
		this.#systemPromptFile = systemPromptFile;
		this.#toolServer = toolServer;
		this.#spawn = spawn;
		this.#terminate = terminate;
		this.#fs = fs;
		this.#schedule = schedule;
		this.#cancelSchedule = cancelSchedule;
		this.#acquireStandby = acquireStandby;
		this.#sessionGeneration = sessionGeneration;
		this.#resetReason = resetReason;
		this.#onInvalidated = onInvalidated;
		this.#executionSettings = createExecutionSettings(profile, {
			transport: 'claude_code_cli', controlProtocol, modelSelector: profile.model,
			// fastMode is opt-in: it bills usage credits, and without them Claude Code silently stays on standard speed.
			evidence: { model: 'launch_argument', reasoningEffort: 'launch_argument', serviceTier: config.fastMode === true && profile.serviceTier === 'priority' ? 'requested' : 'unreported' },
		});
	}

	#noteFastModeState(message) {
		// Claude Code reports whether fast mode actually ran, e.g. off with reason extra_usage_disabled when the account has no usage credits.
		if (message.fast_mode_state !== 'on' && message.fast_mode_state !== 'off') return;
		// Without the opt-in the tier stays a label; reporting standard here would read as a profile mismatch.
		if (this.#config.fastMode !== true) return;
		const settings = this.#executionSettings;
		settings.effective.serviceTier = message.fast_mode_state === 'on' ? 'priority' : 'standard';
		settings.evidence.serviceTier = 'provider_reported';
		const reason = typeof message.fast_mode_disabled_reason === 'string' ? message.fast_mode_disabled_reason.slice(0, 80) : '';
		const note = `claude fast mode ${message.fast_mode_state}${reason === '' ? '' : ` (${reason})`}`;
		settings.limitations = settings.limitations.filter((entry) => !entry.startsWith('claude fast mode'));
		if (message.fast_mode_state === 'off' && this.#config.fastMode === true) settings.limitations.push(note);
	}

	get agentId() { return this.#profile.agentId; }
	get provider() { return 'claude'; }
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
		if (revision < this.#goalRevision) throw new ClaudeProviderError('STALE_GOAL_REVISION', `Goal revision ${revision} is older than ${this.#goalRevision}`);
		if (revision === this.#goalRevision) return;
		this.#goalRevision = revision;
		this.#recentTools.invalidateHandles();
		this.#active?.toolDigests.invalidateHandles();
		this.#failureCarryOver = new FailureCarryOver();
		if ((this.#active !== null && this.#active.goalRevision !== revision) || this.#oneShot !== null || this.#handoffPending !== null) await this.interrupt();
	}

	/** Starts Claude Code and waits until it has discovered the Minecraft tools, without spending a model turn. */
	async prewarm({ goalRevision = this.#goalRevision } = {}) {
		this.#assertNative('prewarm');
		this.#assertUsable();
		if (goalRevision !== this.#goalRevision) throw new ClaudeProviderError('STALE_GOAL_REVISION', `Goal revision ${goalRevision} does not match ${this.#goalRevision}`);
		await this.#ensureProcess();
		await withDeadline(this.#toolsListed.promise, this.#config.startupTimeoutMs, this.#schedule, this.#cancelSchedule,
			() => new ClaudeProviderError('PROVIDER_START_TIMEOUT', `Claude Code did not load the Minecraft tools within ${this.#config.startupTimeoutMs} ms`));
		return this;
	}

	async act(input, { goalRevision, signal, executeTool, onVerbose = null, onProgress = null, captureCalls = false } = {}) {
		this.#assertNative('act');
		this.#assertUsable();
		if (typeof input !== 'string' || input.trim().length === 0) throw new TypeError('native event input must be nonblank');
		if (typeof executeTool !== 'function') throw new TypeError('executeTool must be a function');
		if (onProgress !== null && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function or null');
		if (goalRevision !== this.#goalRevision) throw new ClaudeProviderError('STALE_GOAL_REVISION', `Goal revision ${String(goalRevision)} does not match ${this.#goalRevision}`);
		if (signal?.aborted) throw signal.reason ?? new ClaudeProviderError('TURN_INTERRUPTED', 'Native tool turn was interrupted');
		if (this.#active !== null) throw new ClaudeProviderError('TURN_IN_PROGRESS', `Claude agent '${this.agentId}' already has an active turn`);
		this.#cancelStandbyExpiry();
		// A standby that failed to warm during an earlier turn must not disable rotation for the rest of the process.
		this.#standbyFailedForProcess = false;
		await this.#ensureProcess();
		// An interrupted turn still owes Claude Code's closing result line; never let it close this turn.
		await this.#waitForIdle();
		// An unacknowledged interrupt can drop the process while this wait is released by its cleanup.
		await this.#ensureProcess();
		this.#assertUsable();
		if (goalRevision !== this.#goalRevision || signal?.aborted) throw new ClaudeProviderError('STALE_PLAN', 'Claude native turn belongs to an obsolete goal revision');
		if (this.#active !== null) throw new ClaudeProviderError('TURN_IN_PROGRESS', `Claude agent '${this.agentId}' already has an active turn`);
		// After the idle wait every interrupted turn's closing result (output reconciliation, cost) has been applied.
		const interrupted = carriedUsage(this.#interruptedTurns.splice(0));

		let resolveTurn;
		let rejectTurn;
		const turnPromise = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
		const silence = createSilenceDeadline(this.#config.planningTimeoutMs, this.#schedule, this.#cancelSchedule);
		if (onVerbose !== null) this.#lastOnVerbose = onVerbose;
		const active = {
			turnId: `${this.#sessionGeneration}:${++this.#turnSequence}`,
			input,
			callLog: captureCalls ? new NativeCallLog() : null,
			latestInput: input,
			latestInputAt: Date.now(),
			goalRevision,
			routeEpoch: this.#process?.routeEpoch ?? null,
			modelSawInput: false,
			toolDigests: new ToolDigests(MID_TURN_TOOL_DIGESTS),
			toolExecutions: 0,
			processLost: false,
			executeTool,
			onVerbose,
			onProgress,
			silence,
			toolCalls: 0,
			// An interrupted turn reports nothing itself; its calls count here, itemised as interrupted.
			usage: interrupted === null
				? { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: null }
				: { ...interrupted, interrupted: { ...interrupted } },
			publishedMessage: false,
			pendingSteers: null,
			tail: Promise.resolve(),
			inFlightTools: 0,
			queuedBodyTools: new Set(),
			// Exact control calls running beside ordered work, the outcomes of those the model has not seen
			// yet (its parallel batch is still open), and the fence a session handoff raises over them.
			controlTasks: new Map(),
			orderedTail: Promise.resolve(),
			batchOutcomes: [],
			handoffFence: null,
			settled: false,
			resolve: (value) => { if (!active.settled) { active.settled = true; failPendingSteers(active); resolveTurn(value); } },
			reject: (error) => { if (!active.settled) { active.settled = true; failPendingSteers(active); rejectTurn(error); } },
		};
		void turnPromise.catch(() => {});
		this.#active = active;
		this.#failureCarryOver.beginTurn();
		const abort = () => {
			active.reject(new ClaudeProviderError('STALE_PLAN', 'Claude native turn was aborted'));
			void this.interrupt().catch(() => {});
		};
		signal?.addEventListener('abort', abort, { once: true });
		let completed = false;
		try {
			// Same compact fact encoding Codex receives; the observe tool description documents it.
			const encoded = encodeNativeEventInput(input, this.#observationViews);
			const carryOver = this.#pendingCarryOver;
			this.#writeUserMessage(carryOver === null ? encoded : `${carryOver}

${encoded}`);
			providerEvent(onVerbose, 'native_provider_turn_sent', { turnId: active.turnId, sessionGeneration: this.#sessionGeneration });
			this.#pendingCarryOver = null;
			this.#processUsed = true;
			this.#noteEventFacts(input);
			this.#awaitingResult += 1;
			silence.restart();
			const result = await Promise.race([turnPromise, silence.promise]);
			if (this.#active !== active || this.#goalRevision !== goalRevision || signal?.aborted) {
				throw new ClaudeProviderError('STALE_PLAN', 'Claude native turn belongs to an obsolete goal revision');
			}
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
			if (this.#active === active) this.#active = null;
			if (completed) this.#rotateAfterTurn();
			// A failed, interrupted or not-yet-due turn leaves any warm standby idle; it must still expire.
			this.#scheduleStandbyExpiry();
		}
	}

	async steer(input, { goalRevision = this.#goalRevision, onInterrupt = null, onDiscard = null } = {}) {
		this.#assertNative('steer');
		this.#assertUsable();
		if (!(typeof input === 'function' || typeof input === 'string' && input.trim().length > 0)) throw new TypeError('native steer input must be nonblank or a builder');
		if (onInterrupt !== null && typeof onInterrupt !== 'function') throw new TypeError('onInterrupt must be a function or null');
		if (onDiscard !== null && typeof onDiscard !== 'function') throw new TypeError('onDiscard must be a function or null');
		if (goalRevision !== this.#goalRevision) throw new ClaudeProviderError('STALE_GOAL_REVISION', `Goal revision ${goalRevision} does not match ${this.#goalRevision}`);
		const active = this.#active;
		if (active === null || active.settled || active.goalRevision !== goalRevision) {
			throw new ClaudeProviderError('TURN_NOT_ACTIVE', `Claude agent '${this.agentId}' has no steerable native turn`);
		}
		// Claude Code's own mid-turn message queue can spill into a second turn, which would desynchronize
		// turn accounting. Keep only the newest pending builder and resolve every folded request from that delivery.
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
		try { onInterrupt?.(); } catch { /* steer delivery remains authoritative if interruption reporting fails */ }
		return delivered;
	}

	/** One-shot structured decision used for goal translation and ArenaScript planning. */
	async decide(input, {
		goalRevision, signal, turnRecorder = null, attempt = 1, retry = false, queueWaitMs, onVerbose = null,
		outputSchema = PLANNER_OUTPUT_SCHEMA, parseOutput = parseDecision, systemPrompt,
	} = {}) {
		if (this.#controlProtocol === 'native_tools') throw new ClaudeProviderError('CONTROL_PROTOCOL_MISMATCH', 'Native tool agents must use act()');
		this.#assertUsable();
		if (typeof input !== 'string' || input.trim().length === 0) throw new TypeError('planner input must be nonblank');
		if (typeof parseOutput !== 'function') throw new TypeError('parseOutput must be a function');
		if (systemPrompt !== undefined && typeof systemPrompt !== 'string') throw new TypeError('systemPrompt must be a string');
		if (goalRevision !== this.#goalRevision) throw new ClaudeProviderError('STALE_GOAL_REVISION', `Goal revision ${String(goalRevision)} does not match ${this.#goalRevision}`);
		if (signal?.aborted) throw signal.reason ?? new ClaudeProviderError('PLAN_CANCELLED', 'Planning was cancelled');
		if (this.#oneShot !== null) throw new ClaudeProviderError('TURN_IN_PROGRESS', `Claude agent '${this.agentId}' already has an active turn`);

		const schemaText = outputSchema === null || outputSchema === undefined
			? ''
			: `\n\nReturn only one JSON value matching this JSON Schema, with no prose or code fences:\n${JSON.stringify(outputSchema)}`;
		const prompt = `${systemPrompt ? `${systemPrompt}\n\n` : ''}${input}${schemaText}`;
		const startedAt = Date.now();
		const operation = this.#runOneShot(prompt);
		this.#oneShot = operation;
		const abort = () => { void operation.cancel(new ClaudeProviderError('PLAN_CANCELLED', 'Planning was cancelled')); };
		signal?.addEventListener('abort', abort, { once: true });
		let output = '';
		let timing = null;
		try {
			const result = await operation.promise;
			output = result.text;
			timing = { durationMs: result.durationMs ?? Date.now() - startedAt, apiDurationMs: result.apiDurationMs ?? null, ...(Number.isFinite(queueWaitMs) && queueWaitMs >= 0 ? { queueWaitMs } : {}) };
			if (Buffer.byteLength(output, 'utf8') > this.#config.maxDecisionBytes) throw new ClaudeProviderError('TURN_OUTPUT_LIMIT', `Claude planner output exceeded ${this.#config.maxDecisionBytes} bytes`);
			if (signal?.aborted || goalRevision !== this.#goalRevision) throw new ClaudeProviderError('STALE_PLAN', 'claude result belongs to an obsolete goal');
			reportVisibleOutput(onVerbose, output);
			let decision;
			try { decision = parseOutput(stripCodeFence(output.trim())); }
			catch (error) {
				const parseError = new ClaudeProviderError(error?.code ?? 'INVALID_DECISION', 'claude returned an invalid planner decision', { cause: error });
				parseError.category = 'decision_parse';
				throw parseError;
			}
			recordProviderTurn(turnRecorder, {
				executionSettings: this.executionSettings, agentId: this.agentId, provider: 'claude', model: this.#profile.model,
				reasoningEffort: this.#profile.reasoningEffort, goalRevision, attempt, retry, input: prompt, output, error: null, timing,
				...(result.tokens === null ? {} : { tokens: result.tokens }),
				...(Number.isFinite(result.costUsd) ? { costUsd: result.costUsd } : {}),
			});
			return decision;
		} catch (error) {
			recordProviderTurn(turnRecorder, {
				executionSettings: this.executionSettings, agentId: this.agentId, provider: 'claude', model: this.#profile.model,
				reasoningEffort: this.#profile.reasoningEffort, goalRevision, attempt, retry, input: prompt,
				output: error?.category === 'decision_parse' ? '' : output, error, timing,
			});
			if (signal?.aborted || goalRevision !== this.#goalRevision) throw new ClaudeProviderError('STALE_PLAN', 'claude result belongs to an obsolete goal', { cause: error });
			throw error;
		} finally {
			signal?.removeEventListener('abort', abort);
			if (this.#oneShot === operation) this.#oneShot = null;
		}
	}

	async interrupt() {
		const interruptStartedAt = Date.now();
		const oneShot = this.#oneShot;
		if (oneShot !== null) await oneShot.cancel(new ClaudeProviderError('PLAN_CANCELLED', 'Planning was cancelled'));
		const active = this.#active;
		if (active === null) {
			const pending = this.#handoffPending;
			if (pending !== null) this.#cancelHandoff(pending.active);
			return;
		}
		if (!active.interrupted) {
			active.interrupted = true;
			this.#interruptedTurns.push(active);
		}
		active.reject(new ClaudeProviderError('STALE_PLAN', 'Claude turn was interrupted'));
		this.#cancelHandoff(active);
		if (this.#process === null) return;
		this.#writeLine({ type: 'control_request', request_id: `interrupt-${active.turnId}`, request: { subtype: 'interrupt' } });
		let interruptTimedOut = false;
		try {
			await withDeadline(this.#idlePromise(), this.#config.interruptTimeoutMs, this.#schedule, this.#cancelSchedule,
				() => new ClaudeProviderError('INTERRUPT_TIMEOUT', 'Claude Code did not acknowledge the interrupt'));
		} catch (error) {
			interruptTimedOut = error?.code === 'INTERRUPT_TIMEOUT';
			// A process that ignores interrupts loses its warm context rather than blocking the body.
			await this.#stopProcess();
		}
		const carried = active.usage.interrupted;
		return {
			interruptLatencyMs: Math.max(0, Date.now() - interruptStartedAt),
			interruptAcknowledged: !interruptTimedOut, interruptTimedOut,
			cacheReadInputTokens: active.usage.cacheRead - (carried?.cacheRead ?? 0),
			cacheCreationInputTokens: active.usage.cacheWrite - (carried?.cacheWrite ?? 0),
		};
	}

	async dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		const error = this.#invalidationError ?? new ClaudeProviderError('AGENT_DISPOSED', `Claude agent '${this.agentId}' is disposed`);
		if (this.#handoffPending !== null) this.#cancelHandoff(this.#handoffPending.active);
		this.#active?.reject(error);
		this.#active = null;
		await this.#oneShot?.cancel(error);
		await this.#stopProcess();
		await this.#standbyStart?.catch(() => {});
		await this.#stopStandbyProcess();
		await this.#fs.rm(this.#systemPromptFile, { force: true }).catch(() => {});
	}

	invalidateSession(cause) {
		if (this.#invalidationError !== null || this.#disposed) return;
		this.#invalidationError = new ClaudeProviderError('SESSION_INVALIDATED', 'Claude session is no longer usable', { cause });
		this.#sessionState = 'cold';
		this.#active?.reject(this.#invalidationError);
		this.#onInvalidated?.(this);
		void this.dispose();
	}

	#assertNative(operation) {
		if (this.#controlProtocol !== 'native_tools') throw new ClaudeProviderError('CONTROL_PROTOCOL_MISMATCH', `Only native tool agents can ${operation}`);
	}

	#assertUsable() {
		if (this.#disposed) throw this.#invalidationError ?? new ClaudeProviderError('AGENT_DISPOSED', `Claude agent '${this.agentId}' is disposed`);
	}

	#ensureProcess() {
		if (this.#handoffPending !== null) return this.#handoffPending.promise.then(() => this.#ensureProcess());
		if (this.#process !== null) return Promise.resolve();
		// prewarm() and act() can race; both must share one Claude Code process.
		this.#processStart ??= this.#startProcess().finally(() => { this.#processStart = null; });
		return this.#processStart;
	}

	async #startProcess({ standby = false, standbyGeneration = this.#standbyGeneration } = {}) {
		if (!standby) this.#resetContextState();
		let resolveListed;
		let rejectListed;
		const toolsListed = { promise: new Promise((resolve, reject) => { resolveListed = resolve; rejectListed = reject; }), resolve: () => resolveListed(), reject: (error) => rejectListed(error) };
		void toolsListed.promise.catch(() => {});
		const routeEpoch = ++this.#routeEpochSequence;
		const route = await this.#toolServer.register({
			callTool: (name, args, meta) => this.#callTool(name, args, meta, routeEpoch),
			onToolsListed: () => toolsListed.resolve(),
			onToolResponded: ({ toolUseId }) => {
				if (toolUseId === null || this.#active === null) return;
				providerEvent(this.#active.onVerbose, 'native_provider_tool_result_sent', { callId: toolUseId });
				// The planner times adapter delivery up to this publication, as with Codex's tool_completed.
				try { this.#active.onProgress?.({ phase: 'tool_completed', callId: toolUseId }); } catch { /* diagnostics only */ }
			},
		});
		if (standby && standbyGeneration !== this.#standbyGeneration) { route.unregister(); return null; }
		// Disposal can overtake registration; a route registered afterwards must not outlive the agent.
		if (this.#disposed) { route.unregister(); this.#assertUsable(); }
		const state = { child: null, stdout: '', stderr: '', stderrBytes: 0, exited: false, route, routeEpoch, toolsListed, sessionId: null, standby, retired: false };
		if (standby) this.#standbyProcess = state;
		else { this.#route = route; this.#toolsListed = toolsListed; }
		this.#assertUsable();
		const launch = buildClaudeLaunch(this.#profile, this.#config, {
			cwd: this.#cwd,
			systemPromptFile: this.#systemPromptFile,
			mcpConfig: { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: route.url, headers: { Authorization: `Bearer ${route.token}` } } } },
			streaming: true,
		});
		let child;
		try { child = this.#spawn(launch.command, launch.args, launch.options); }
		catch (error) {
			route.unregister();
			if (standby) this.#standbyProcess = null;
			else this.#route = null;
			throw new ClaudeProviderError('SPAWN_FAILED', `Could not start Claude Code: ${error.message}`, { cause: error });
		}
		state.child = child;
		if (!standby) this.#process = state;
		child.stdout?.setEncoding?.('utf8');
		child.stdout?.on('data', (chunk) => this.#onStdout(state, String(chunk)));
		child.stderr?.on('data', (chunk) => {
			const text = String(chunk);
			state.stderrBytes += Buffer.byteLength(text, 'utf8');
			if (state.stderrBytes <= this.#config.stderrLimitBytes) state.stderr += text;
		});
		child.stdin?.on?.('error', () => {});
		child.once('error', (error) => this.#onProcessExit(state, new ClaudeProviderError('SPAWN_FAILED', `Could not start Claude Code: ${error.message}`, { cause: error })));
		child.once('close', (exitCode, signalCode) => this.#onProcessExit(state, new ClaudeProviderError('PROVIDER_UNAVAILABLE',
			`Claude Code exited with code ${String(exitCode)} and signal ${String(signalCode)} [stderr=${excerpt(state.stderr)}]`)));
		return state;
	}

	#canHandoff(payloadBytes) {
		const threshold = this.#config.contextRotationTokens;
		return threshold > 0 && this.#lastContextTokens >= threshold
			&& this.#handoffBudget.quote(payloadBytes).allowed
			&& (this.#sessionFloorTokens === null || this.#lastContextTokens - this.#sessionFloorTokens >= threshold * MIN_ROTATION_GROWTH_SHARE);
	}

	#prepareStandbyIfUseful() {
		const threshold = this.#config.contextRotationTokens;
		if (threshold <= 0 || this.#lastContextTokens < Math.max(1, threshold - STANDBY_WARMUP_LEAD_TOKENS)
			|| this.#disposed || this.#active === null || this.#standbyFailedForProcess || this.#process === null
			|| this.#standbyProcess !== null || this.#standbyStart !== null) return;
		const release = this.#acquireStandby?.();
		if (typeof release !== 'function') return;
		this.#standbyRelease = release;
		const generation = ++this.#standbyGeneration;
		const warming = (async () => {
			const state = await this.#startProcess({ standby: true, standbyGeneration: generation });
			if (state === null) throw new ClaudeProviderError('PROVIDER_UNAVAILABLE', 'Claude standby process exited during startup');
			await withDeadline(state.toolsListed.promise, this.#config.startupTimeoutMs, this.#schedule, this.#cancelSchedule,
				() => new ClaudeProviderError('PROVIDER_START_TIMEOUT', `Claude Code did not load the Minecraft tools within ${this.#config.startupTimeoutMs} ms`));
			if (generation !== this.#standbyGeneration || this.#standbyProcess !== state || state.exited) throw new ClaudeProviderError('PROVIDER_UNAVAILABLE', 'Claude standby process exited during startup');
			return state;
		})();
		this.#standbyStart = warming.catch(async (error) => {
			// A standby stopped or promoted meanwhile belongs to someone else now; only the current warmup may mark failure.
			if (generation === this.#standbyGeneration) {
				this.#standbyFailedForProcess = true;
				await this.#stopStandbyProcess();
			}
			throw error;
		}).finally(() => { if (this.#standbyStart === tracked) this.#standbyStart = null; });
		const tracked = this.#standbyStart;
		void tracked.catch(() => {});
	}

	async #standbyAtToolBoundary() {
		if (!this.#rotationDue || this.#disposed || this.#standbyFailedForProcess) return null;
		if (this.#standbyStart === null) return this.#standbyProcess;
		try {
			return await withDeadline(this.#standbyStart, STANDBY_READY_TIMEOUT_MS, this.#schedule, this.#cancelSchedule,
				() => new ClaudeProviderError('STANDBY_READY_TIMEOUT', 'Claude standby was not ready at the next tool boundary'));
		} catch {
			this.#standbyFailedForProcess = true;
			void this.#stopStandbyProcess();
			return null;
		}
	}

	async #stopStandbyProcess() {
		this.#cancelStandbyExpiry();
		const state = this.#standbyProcess;
		this.#standbyProcess = null;
		this.#standbyGeneration += 1;
		this.#releaseStandbyLease();
		if (state === null) return;
		state.toolsListed?.reject(new ClaudeProviderError('PROVIDER_UNAVAILABLE', 'Claude standby was stopped before becoming ready'));
		state.exited = true;
		state.route?.unregister();
		try { state.child?.stdin?.end?.(); } catch { /* the process may already be gone */ }
		await Promise.resolve(this.#terminate(state.child)).catch(() => {});
	}

	#promoteStandby(state, active = null) {
		if (this.#standbyProcess !== state || state.exited) return null;
		this.#cancelStandbyExpiry();
		const previous = this.#process;
		if (this.#disposed) return null;
		this.#standbyProcess = null;
		this.#standbyGeneration += 1;
		this.#releaseStandbyLease();
		state.standby = false;
		this.#process = state;
		this.#route = state.route;
		this.#toolsListed = state.toolsListed;
		this.#sessionId = state.sessionId;
		if (active !== null) active.routeEpoch = state.routeEpoch;
		// Calls the old process made since its last result line are billed but will never be reported; this books them.
		this.#resetContextState();
		this.#rotations += 1;
		return { previous };
	}

	#releaseStandbyLease() {
		this.#standbyRelease?.();
		this.#standbyRelease = null;
	}

	#scheduleStandbyExpiry() {
		if (this.#standbyProcess === null && this.#standbyStart === null) return;
		this.#cancelStandbyExpiry();
		this.#standbyIdleTimer = this.#schedule(() => {
			this.#standbyIdleTimer = null;
			void this.#stopStandbyProcess();
		}, this.#config.standbyIdleTimeoutMs);
		this.#standbyIdleTimer?.unref?.();
	}

	#cancelStandbyExpiry() {
		if (this.#standbyIdleTimer === null) return;
		this.#cancelSchedule(this.#standbyIdleTimer);
		this.#standbyIdleTimer = null;
	}

	/** Stops a replaced process at once: it gets no answer for its held request, or it would pay for another model call. */
	#retireProcess(state) {
		if (state === null) return Promise.resolve();
		state.retired = true;
		state.exited = true;
		state.route?.unregister();
		try { state.child.stdin?.end?.(); } catch { /* the process may already be gone */ }
		return Promise.resolve(this.#terminate(state.child)).catch(() => {});
	}

	#beginHandoff(active) {
		let resolveDone;
		let resolveCancelled;
		const transaction = {
			active,
			cancelled: false,
			promise: new Promise((resolve) => { resolveDone = resolve; }),
			cancelPromise: new Promise((resolve) => { resolveCancelled = resolve; }),
			resolveDone,
			resolveCancelled,
		};
		this.#handoffPending = transaction;
		return transaction;
	}

	#finishHandoff(transaction) {
		if (this.#handoffPending !== transaction) return;
		this.#handoffPending = null;
		transaction.resolveDone();
	}

	#cancelHandoff(active) {
		const transaction = this.#handoffPending;
		if (transaction === null || transaction.active !== active || transaction.cancelled) return;
		transaction.cancelled = true;
		transaction.resolveCancelled();
	}

	#onStdout(state, chunk) {
		if (this.#process !== state && this.#standbyProcess !== state) return;
		state.stdout += chunk;
		if (Buffer.byteLength(state.stdout, 'utf8') > this.#config.stdoutLineLimitBytes && !state.stdout.includes('\n')) {
			this.invalidateSession(new ClaudeProviderError('OUTPUT_LIMIT_EXCEEDED', `Claude Code output line exceeded ${this.#config.stdoutLineLimitBytes} bytes`));
			return;
		}
		let newline;
		while ((newline = state.stdout.indexOf('\n')) >= 0) {
			const line = state.stdout.slice(0, newline).trim();
			state.stdout = state.stdout.slice(newline + 1);
			if (line.length === 0) continue;
			let message;
			try { message = JSON.parse(line); } catch { continue; }
			this.#onMessage(message, state);
		}
	}

	#onMessage(message, state = this.#process) {
		if (state?.standby === true && this.#standbyProcess === state) {
			if (message?.type === 'system' && message.subtype === 'init') {
				if (typeof message.session_id === 'string') state.sessionId = message.session_id;
				// A standby on another model must never be promoted into the selected agent's session.
				if (reportsOtherModel(this.#profile.model, message.model)) {
					this.#standbyFailedForProcess = true;
					void this.#stopStandbyProcess();
				}
				return;
			}
			return;
		}
		const active = this.#active;
		const now = Date.now();
		// Token deltas arrive many times a second; renewing timers and leases for each one is wasted work.
		const renew = message?.type !== 'stream_event' || now - this.#lastStreamProgressAt >= STREAM_PROGRESS_INTERVAL_MS;
		if (active !== null && !active.settled && renew) {
			this.#lastStreamProgressAt = now;
			active.silence.restart();
			try { active.onProgress?.({ phase: 'provider' }); } catch { /* progress reporting cannot fail provider work */ }
		}
		if (message?.type === 'rate_limit_event') {
			// Subscription windows as Claude Code reports them; shared account state, so any agent may carry it.
			const limits = parseClaudeRateLimitEvent(message);
			const reporter = active?.onVerbose ?? this.#lastOnVerbose;
			if (limits !== null && reporter) safeVerbose(reporter, 'live_allowance', JSON.stringify({ provider: 'claude', ...limits, reportedAtEpochMs: now }));
			return;
		}
		if (message?.type === 'stream_event') {
			if (active !== null) active.modelSawInput = true;
			this.#noteStreamMarks(message.event, now);
			// The call has decided on a tool and will reach a tool boundary as soon as its input finishes streaming.
			if (active !== null && !active.settled && message.event?.type === 'content_block_start' && message.event.content_block?.type === 'tool_use') {
				try { active.onProgress?.({ phase: 'tool_streaming' }); } catch { /* progress reporting cannot fail provider work */ }
			}
			this.#onStreamEvent(message.event);
			return;
		}
		if (message?.type === 'assistant') {
			if (active !== null) {
				active.modelSawInput = true;
				if (process.env.ARENA_QUALITY_CAPTURE === '1' && !active.qualityFirstMessageCaptured) {
					const content = (message.message?.content ?? []).filter(block => ['text', 'tool_use'].includes(block.type));
					if (content.length > 0) {
						active.qualityFirstMessageCaptured = true;
						safeVerbose(active.onVerbose, 'quality_first_message', JSON.stringify(content).slice(0, 8192));
					}
				}
			}
			this.#noteAssistantUsage(message.message);
			if (active?.callLog != null) captureAssistantMessage(active.callLog, message.message);
		}
		if (message?.type === 'system' && message.subtype === 'init') {
			if (typeof message.session_id === 'string') { this.#sessionId = message.session_id; if (state !== null) state.sessionId = message.session_id; }
			if (reportsOtherModel(this.#profile.model, message.model)) {
				// Mirrors Codex: work never continues under a model other than the selected one.
				const mismatch = new ClaudeProviderError('PROVIDER_SETTINGS_MISMATCH', 'Claude Code did not confirm the selected model');
				this.#active?.reject(mismatch);
				this.invalidateSession(mismatch);
				return;
			}
			if (typeof message.model === 'string' && message.model.length > 0 && message.model.length <= 256) {
				this.#executionSettings.effective.model = message.model;
				this.#executionSettings.evidence.model = 'provider_reported';
			}
			return;
		}
		if (message?.type === 'assistant' && active !== null && !active.publishedMessage) {
			const text = (Array.isArray(message.message?.content) ? message.message.content : [])
				.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').trim();
			if (text.length > 0) {
				this.#lastAgentText = text.slice(0, 400);
				active.publishedMessage = true;
				safeVerbose(active.onVerbose, 'agent_message', text.slice(0, MAX_PUBLIC_AGENT_MESSAGE_CHARS));
			}
			return;
		}
		if (message?.type !== 'result') return;
		if (active?.callLog != null) {
			active.callLog.finalItem({ type: 'result', subtype: message.subtype, result: message.result, usage: message.usage });
			if (!active.callLog.snapshot().output && typeof message.result === 'string') active.callLog.output(message.result);
		}
		if (typeof message.session_id === 'string') this.#sessionId = message.session_id;
		this.#noteFastModeState(message);
		const requestOwner = this.#usageOwner;
		const resultCalls = this.#finishCalls();
		// The turn that sent this request; an interrupted one keeps receiving its own late output and cost.
		const usageOwner = active ?? resultCalls[0]?.active ?? requestOwner;
		// In streaming input mode total_cost_usd is the running total for this Claude Code process.
		if (Number.isFinite(message.total_cost_usd) && message.total_cost_usd >= 0) {
			const delta = message.total_cost_usd >= this.#processCostUsd ? message.total_cost_usd - this.#processCostUsd : message.total_cost_usd;
			this.#processCostUsd = message.total_cost_usd;
			this.#usage.costUsd += delta;
			if (usageOwner != null) usageOwner.usage.costUsd = (usageOwner.usage.costUsd ?? 0) + delta;
			// The reported total already covers every call made so far.
			this.#unreportedCostUsd = 0;
		}
		// Per-step assistant output_tokens are placeholders; the result's usage covers this turn's real output.
		const turnOutput = message.usage?.output_tokens;
		if (usageOwner != null && Number.isSafeInteger(turnOutput) && turnOutput >= 0) {
			// A replacement process's result excludes output billed by the retired process.
			const recordedOutput = resultCalls.reduce((total, call) => total + call.usage.output, 0);
			let correction = turnOutput - recordedOutput;
			this.#usage.output += correction;
			usageOwner.usage.output += correction;
			for (const call of [...resultCalls].reverse()) {
				if (correction === 0) break;
				const delta = correction > 0 ? correction : -Math.min(call.usage.output, -correction);
				call.usage.output += delta;
				correction -= delta;
				this.#emitCallUsage(call, { outputReconciled: true });
			}
		}
		if (this.#awaitingResult > 0) this.#awaitingResult -= 1;
		if (this.#awaitingResult === 0) for (const resolve of this.#idleWaiters.splice(0)) resolve();
		if (active === null || active.settled) return;
		if (message.subtype === 'success' && message.is_error !== true) {
			// Tool responses are returned before Claude Code continues, but drain the queue defensively.
			void active.tail.then(() => active.resolve({ status: 'completed', toolCalls: active.toolCalls, ...(active.callLog === null ? {} : { nativeCapture: nativeCapture(active, this.#sessionId) }), ...(active.usage.calls === 0 && active.usage.costUsd === null ? {} : { usage: { ...active.usage, contextTokens: this.#lastContextTokens } }) }));
			return;
		}
		active.reject(new ClaudeProviderError(resultErrorCode(message) ?? 'TURN_FAILED',
			`Claude Code ended the turn (${String(message.subtype ?? 'error')}): ${excerpt(message.result ?? message.errors ?? '')}`));
	}

	/** Encodes a pending steer for delivery and records it as the newest event the model has been given. */
	#steerEncoder(active) {
		return async (input) => {
			const text = await resolveSteerInput(input);
			active.latestInput = text;
			active.latestInputAt = Date.now();
			this.#noteEventFacts(text);
			return encodeNativeEventInput(text, this.#observationViews);
		};
	}

	/**
	 * A rotation handoff carries the newest event as the replacement's current input, so a pending steer becomes that
	 * input instead of a second copy. Its waiters resolve here, which is the only delivery the steer gets.
	 */
	async #foldPendingSteerIntoInput(active) {
		while (active.pendingSteers !== null) {
			const pending = active.pendingSteers;
			let text;
			try { text = await resolveSteerInput(pending.buildInput); }
			catch (error) {
				if (active.pendingSteers !== pending) { discardPendingSteer(pending); continue; }
				active.pendingSteers = null;
				discardPendingSteer(pending);
				for (const waiter of pending.waiters) waiter.reject(error);
				return;
			}
			if (active.pendingSteers !== pending) { discardPendingSteer(pending); continue; }
			active.pendingSteers = null;
			active.latestInput = text;
			active.latestInputAt = Date.now();
			this.#noteEventFacts(text);
			providerEvent(active.onVerbose, 'native_provider_steer_delivered', { turnId: active.turnId, steers: pending.waiters.length, waitMs: Math.max(0, Date.now() - pending.queuedAt) });
			for (const waiter of pending.waiters) waiter.resolve();
		}
	}

	async #callTool(name, args, { toolUseId }, routeEpoch) {
		const active = this.#active;
		if (this.#disposed || active === null || active.settled) {
			return mcpContent(toolResultContent({ state: 'FAILED', reasonCode: 'TURN_NOT_ACTIVE', message: 'No Minecraft turn is active for this body.' }, false));
		}
		if (routeEpoch !== active.routeEpoch) {
			return mcpContent(toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'This tool request came from a retired Claude session.' }, false));
		}
		active.modelSawInput = true;
		let schedulingClass = 'ordered', admittedTool;
		try { admittedTool = normalizeMinecraftToolCall(name, args); schedulingClass = nativeToolSchedulingClass(admittedTool); } catch { /* rejected below, in order */ }
		// Exact control handles (cancel, program responses) must not wait behind the work they interrupt.
		const bypass = schedulingClass === 'control';
		// A bypassing control call that overlaps other tools leaves session handoffs to the ordered call.
		// Identifies this control call so a handoff it starts never waits on itself.
		const controlToken = bypass ? {} : null;
		// A control detached from a failed cold handoff belongs to a retired session and never owns a boundary.
		const ownsBoundary = () => !bypass || active.inFlightTools === 1 && controlToken.detached !== true;
		const callLabel = `"${name}"${toolUseId === null ? '' : ` (tool use ${toolUseId})`} with arguments ${boundedArguments(args)}`;
		const bodyToken = {};
		const run = async () => {
			active.queuedBodyTools.delete(bodyToken);
			if (active.settled) return toolResultContent({ state: 'FAILED', reasonCode: 'TURN_NOT_ACTIVE', message: 'The Minecraft turn already ended.' }, false);
			if (routeEpoch !== active.routeEpoch) return toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'This tool request came from a retired Claude session.' }, false);
			active.toolCalls += 1;
			try { active.onProgress?.({ phase: 'tool_queued', toolName: name }); } catch { /* diagnostics only */ }
			active.silence.pause();
			// A control detached from a failed cold handoff hands its pause back early; release it only once.
			let silenceHeld = true;
			const releaseSilence = () => { if (silenceHeld) { silenceHeld = false; active.silence.resume(); } };
			if (controlToken !== null) controlToken.releaseSilence = releaseSilence;
			let content;
			let result;
			let tool;
			let toolFailed = false;
			let commit = () => {};
			try {
				tool = normalizeMinecraftToolCall(name, args);
				active.toolExecutions += 1;
				try { result = await active.executeTool({
					agentId: this.agentId,
					goalRevision: active.goalRevision,
					threadId: this.#sessionId,
					turnId: active.turnId,
					callId: toolUseId,
					hasQueuedBodyAction: () => active.queuedBodyTools.size > 0,
					tool,
				}); } finally { active.toolExecutions -= 1; }
				if (controlToken?.detached !== true) {
					this.#rememberTool(name, args, result, active.toolDigests);
					this.#noteProgram(result);
				}
			} catch (error) {
				if (tool === undefined || error?.diagnostics !== undefined) providerEvent(active.onVerbose, 'native_tool_rejected', { toolName: name, reason: String(error?.message ?? error).slice(0, 512), ...arenaScriptDiagnosticSummary(error) });
				result = toolErrorResult(error, arenaScriptDiagnosticFields(error));
				if (controlToken?.detached !== true) this.#rememberTool(name, args, result, active.toolDigests);
				toolFailed = true;
			} finally { releaseSilence(); }
			if (controlToken?.detached === true) {
				// Quarantined: its session is gone and the replacement was told the outcome is unconfirmed.
				// The late outcome is history for the next turn only; it never touches this turn's state.
				this.#lateOutcomes.push(`Late outcome of tool call ${callLabel} from a retired session (earlier reported as not confirmed):\n${JSON.stringify(result)}`);
				return toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'This tool request came from a retired Claude session.' }, false);
			}
			if (active.processLost && this.#process === null && !active.settled && tool !== undefined && ownsBoundary()) {
				const transaction = this.#beginHandoff(active);
				active.silence.pause();
				let handoff = null;
				try {
					// The body has no process; a control that outlives the join cannot hold up the replacement.
					if (!await this.#joinControlCalls(active, transaction, controlToken)) this.#detachRunningControls(active, controlToken);
					await this.#startProcess();
					await withDeadline(this.#toolsListed.promise, this.#config.startupTimeoutMs, this.#schedule, this.#cancelSchedule,
						() => new ClaudeProviderError('PROVIDER_START_TIMEOUT', `Claude Code did not load the Minecraft tools within ${this.#config.startupTimeoutMs} ms`));
					if (active.settled || this.#active !== active || active.goalRevision !== this.#goalRevision) {
						this.#pendingCarryOver = [`${this.#carryOver('Session refreshed to continue the next turn')}\n\nCompleted tool result from the interrupted turn for "${name}":\n${JSON.stringify(result)}`, ...this.#takeBatchOutcomes(active, controlToken)].join('\n\n');
						return toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'The old session ended while this tool was running.' }, false);
					}
					active.routeEpoch = this.#process.routeEpoch;
					await this.#foldPendingSteerIntoInput(active);
					const turnInput = encodeNativeEventInput(active.latestInput, this.#observationViews);
					const presented = presentNativeToolResult(result, presentedTool(tool, { view: 'full' }), this.#observationViews);
					if (toolFailed) presented.response.success = false;
					commit = presented.commit;
					const delivered = await deliverSteers(active, presented.response, this.#steerEncoder(active));
					const [toolResult, ...steers] = delivered.contentItems.map((item) => item.text);
					handoff = this.#midTurnHandoff(active, turnInput, name, toolUseId, toolResult, steers, this.#takeBatchOutcomes(active, controlToken));
					this.#pendingCarryOver = handoff;
					this.#awaitingHandoffFloor = true;
					this.#writeUserMessage(handoff);
					// The process exit cleared the original turn's booking; the replacement turn owes its own result.
					this.#awaitingResult += 1;
					this.#pendingCarryOver = null;
					this.#processUsed = true;
					commit();
					return toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'The completed tool result continues in a cold replacement session.' }, false);
				} catch (error) {
					// A built handoff already folded the pending steer and resolved its waiters, so it is the only copy the model can still get.
					this.#pendingCarryOver = handoff ?? [`${this.#carryOver('Session refreshed to continue the next turn')}\n\nCompleted tool result from the interrupted turn for "${name}":\n${JSON.stringify(result)}`, ...this.#takeBatchOutcomes(active, controlToken)].join('\n\n');
					active.reject(error);
					return toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'The completed tool result was saved for the next session.' }, false);
				} finally {
					active.silence.resume();
					active.handoffFence = null;
					this.#finishHandoff(transaction);
				}
			}
			// Render a disposable full view to price the prospective payload without committing it.
			let rotationBytes = 0;
			if (result !== undefined && tool !== undefined && this.#rotationDue) {
				const views = new ModelObservationViews();
				const input = encodeNativeEventInput(active.latestInput, views);
				const response = presentNativeToolResult(result, presentedTool(tool, { view: 'full' }), views).response;
				rotationBytes = Buffer.byteLength(this.#midTurnHandoff(active, input, name, toolUseId, response.contentItems[0].text, []), 'utf8');
			}
			if (result !== undefined && tool !== undefined && this.#rotationDue && ownsBoundary() && this.#canHandoff(rotationBytes) && !this.#disposed) {
				const transaction = this.#beginHandoff(active);
				active.silence.pause();
				try {
					// An elective rotation that cannot collect every running control is deferred.
					const joined = await this.#joinControlCalls(active, transaction, controlToken);
					const standby = !joined ? null : await Promise.race([
						this.#standbyAtToolBoundary(),
						transaction.cancelPromise.then(() => null),
					]);
					if (standby !== null && !transaction.cancelled && !active.settled
						&& active.goalRevision === this.#goalRevision && this.#active === active) {
						this.#handoffBudget.reserve(rotationBytes);
						const promoted = await this.#promoteStandby(standby, active);
						if (promoted === null) this.#handoffBudget.cancelReservation();
						if (promoted !== null) {
							providerEvent(active.onVerbose, 'native_context_handoff_budget', { ...this.#handoffBudget.snapshot, quotedPayloadBytes: rotationBytes });
							const stillCurrent = !transaction.cancelled && !active.settled && this.#active === active
								&& active.goalRevision === this.#goalRevision && !this.#disposed;
							if (!stillCurrent) {
							this.#pendingCarryOver = [
								this.#carryOver('Session refreshed to continue the next turn'),
								`Completed tool result from the interrupted turn for "${name}":\n${JSON.stringify(result)}`,
								...this.#takeBatchOutcomes(active, controlToken),
							].join('\n\n');
							this.#retireProcess(promoted.previous);
							return toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'The old turn was interrupted during session rotation.' }, false);
						}
						await this.#foldPendingSteerIntoInput(active);
						const turnInput = encodeNativeEventInput(active.latestInput, this.#observationViews);
						const presented = presentNativeToolResult(result, presentedTool(tool, { view: 'full' }), this.#observationViews);
						if (toolFailed) presented.response.success = false;
						commit = presented.commit;
						const delivered = await deliverSteers(active, presented.response, this.#steerEncoder(active));
						const [toolResult, ...steers] = delivered.contentItems.map((item) => item.text);
						const handoff = this.#midTurnHandoff(active, turnInput, name, toolUseId, toolResult, steers, this.#takeBatchOutcomes(active, controlToken));
						this.#pendingCarryOver = handoff;
						this.#awaitingHandoffFloor = true;
						this.#writeUserMessage(handoff);
						this.#pendingCarryOver = null;
						this.#processUsed = true;
						commit();
						this.#retireProcess(promoted.previous);
							return toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'This process ended at a session boundary; the completed tool result continues in the replacement turn.' }, false);
						}
					}
				} finally {
					active.silence.resume();
					active.handoffFence = null;
					this.#finishHandoff(transaction);
				}
			}
			if (routeEpoch !== active.routeEpoch) {
				this.#pendingCarryOver ??= `${this.#carryOver('Session refreshed to continue the next turn')}\n\nCompleted tool result from the interrupted turn for "${name}":\n${JSON.stringify(result)}`;
				return toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'This tool request came from a retired Claude session.' }, false);
			}
			if (active.settled && tool !== undefined) {
				this.#pendingCarryOver ??= `${this.#carryOver('Turn interrupted after the tool completed')}\n\nCompleted tool result for "${name}":\n${JSON.stringify(result)}`;
			}
			if (tool === undefined) content = toolResultContent(result, false);
			else {
				const presented = presentNativeToolResult(result, tool, this.#observationViews);
				if (toolFailed) presented.response.success = false;
				content = presented.response;
				commit = presented.commit;
			}
			const delivered = await deliverSteers(active, content, this.#steerEncoder(active));
			active.callLog?.toolResult(toolUseId, delivered.contentItems.map((item) => item?.text ?? '').join('\n'), { success: delivered.success });
			// A settled (interrupted or aborted) turn may never show this result to the model.
			if (!active.settled) commit();
			// Claude shows a parallel batch's results only once every call returns. If ordered work is still
			// running, a session handoff must carry this outcome, or the model never sees it.
			if (bypass && !ownsBoundary()) {
				active.batchOutcomes.push(`Tool result for Minecraft tool "${name}"${toolUseId === null ? '' : ` (tool use ${toolUseId})`}:\n${delivered.contentItems.map((item) => item.text).join('\n\n')}`);
			}
			this.#requestAt = Date.now();
			return delivered;
		};
		// Parallel Claude tool calls are serialized like Codex's ordered calls. Exact control
		// bypasses that order, but later calls still wait for it.
		if (bypass && active.handoffFence !== null) {
			// A handoff is collecting this batch; a control admitted now would act after its continuation was written.
			active.handoffFence.refused.push(`Tool call ${callLabel} was not run because the session was handing off. Reissue it exactly if it is still needed.`);
			return mcpContent(toolResultContent({ state: 'FAILED', reasonCode: 'SESSION_ROTATED', message: 'Not run: the session was handing off. Reissue it if it is still needed.' }, false));
		}
		if (isNativeBodyTool(admittedTool)) active.queuedBodyTools.add(bodyToken);
		active.inFlightTools += 1;
		const task = (bypass ? run() : active.tail.then(run, run)).finally(() => {
			active.inFlightTools -= 1;
			if (active.inFlightTools === 0) active.batchOutcomes = [];
		});
		if (bypass) {
			active.controlTasks.set(controlToken, { task, label: callLabel });
			void task.finally(() => active.controlTasks.delete(controlToken)).catch(() => {});
		}
		if (!bypass) active.orderedTail = task.catch(() => {});
		active.tail = bypass ? Promise.allSettled([active.tail, task]).then(() => {}) : task.catch(() => {});
		return mcpContent(await task);
	}

	/** Rotates after a completed turn when a long-turn tool boundary did not use the warm session. */
	#rotateAfterTurn() {
		if (!this.#rotationDue || this.#turnsSinceRotation < MIN_TURNS_BETWEEN_ROTATIONS) return;
		if (this.#process === null || this.#active !== null || this.#awaitingResult > 0 || this.#disposed) return;
		if (this.#standbyStart === null) { this.#rotateNow(); return; }
		// A standby that is still starting gets a moment; one that hangs is replaced by a plain restart.
		void withDeadline(this.#standbyStart, STANDBY_READY_TIMEOUT_MS, this.#schedule, this.#cancelSchedule,
			() => new ClaudeProviderError('STANDBY_READY_TIMEOUT', 'Claude standby was not ready after the turn')).catch((error) => {
			if (error?.code !== 'STANDBY_READY_TIMEOUT') return;
			this.#standbyFailedForProcess = true;
			void this.#stopStandbyProcess();
		}).then(() => {
			if (!this.#rotationDue || this.#turnsSinceRotation < MIN_TURNS_BETWEEN_ROTATIONS) return;
			if (this.#process === null || this.#active !== null || this.#awaitingResult > 0 || this.#disposed) return;
			this.#rotateNow();
		});
	}

	#rotateNow() {
		const carryOver = this.#carryOver('Session refreshed to keep context small');
		if (!this.#handoffBudget.reserve(Buffer.byteLength(carryOver, 'utf8'))) return;
		const standby = this.#standbyProcess;
		if (standby === null || standby.exited || this.#standbyStart !== null) {
			// No usable standby (warmup failed, timed out or is still hanging, or the standby cap was full): restart the
			// way a completed turn always did, so a missing standby can never switch rotation off.
			if (standby !== null) void this.#stopStandbyProcess();
			// The carry-over is armed before the stop so a racing turn cannot start without it.
			this.#pendingCarryOver = this.#carryOver('Session refreshed to keep context small');
			this.#rotations += 1;
			void this.#stopProcess().then(() => {
				if (this.#disposed || this.#invalidationError !== null) return undefined;
				return this.#ensureProcess();
			}).catch(() => {});
			return;
		}
		const transaction = this.#beginHandoff(null);
		try {
			this.#pendingCarryOver = this.#carryOver('Session refreshed to keep context small');
			const promoted = this.#promoteStandby(standby);
			if (promoted !== null) void this.#retireProcess(promoted.previous);
			else { this.#pendingCarryOver = null; this.#handoffBudget.cancelReservation(); }
		} finally { this.#finishHandoff(transaction); }
	}

	/** The replacement session's whole view of an active turn: carry-over, newest turn input, this turn's calls, the unseen result. */
	/** Fences new control admissions and waits for running ones, so one continuation carries every outcome. */
	/**
	 * Waits for running controls other than the caller. Interruption or the planning deadline ends the
	 * wait, so a control that never finishes cannot hold the body; returns whether every control settled.
	 */
	async #joinControlCalls(active, transaction, self) {
		active.handoffFence ??= { refused: [] };
		const others = () => [...active.controlTasks].filter(([token]) => token !== self && token.detached !== true).map(([, entry]) => entry.task);
		let handle = null;
		const deadline = new Promise((resolve) => { handle = this.#schedule(() => resolve('deadline'), this.#config.planningTimeoutMs); });
		try {
			while (others().length > 0) {
				const outcome = await Promise.race([
					Promise.allSettled(others()).then(() => 'joined'),
					transaction.cancelPromise.then(() => 'cancelled'),
					deadline,
				]);
				if (outcome !== 'joined') return false;
			}
			return true;
		} finally { if (handle !== null) this.#cancelSchedule(handle); }
	}

	/**
	 * After a cold handoff gave up waiting, running controls stay reported as unconfirmed but stop owning
	 * the replacement's ordering and silence deadline. Their late results only reach carry-over.
	 */
	#detachRunningControls(active, self) {
		for (const [token] of active.controlTasks) {
			if (token === self) continue;
			token.detached = true;
			token.releaseSilence?.();
		}
		active.tail = Promise.allSettled([active.orderedTail, ...(self === null ? [] : [active.controlTasks.get(self)?.task])]).then(() => {});
	}

	#takeBatchOutcomes(active, self = null) {
		const unconfirmed = [...active.controlTasks].filter(([token]) => token !== self)
			.map(([, entry]) => `Tool call ${entry.label} was still running when the session handed off; its outcome is not confirmed. Check its status before relying on it.`);
		const outcomes = [...active.batchOutcomes, ...(active.handoffFence?.refused ?? []), ...unconfirmed];
		active.batchOutcomes = [];
		if (active.handoffFence !== null) active.handoffFence.refused = [];
		return outcomes;
	}

	#midTurnHandoff(active, turnInput, name, toolUseId, toolResult, steers, otherResults = []) {
		const inputFacts = handoffFacts(turnInput);
		const rawInput = handoffFacts(active.latestInput)[0];
		const visible = [...inputFacts.map(value => correlateFailureEvent(value, rawInput)), ...[toolResult, ...steers].flatMap(handoffFacts)];
		const resultFacts = handoffFacts(toolResult);
		const shared = resultFacts.length === 1 ? shareVisibleFailureFields(resultFacts[0], inputFacts) : null;
		if (shared !== null) toolResult = JSON.stringify(encodeModelFacts(shared.value));
		const ageMs = Date.now() - active.latestInputAt;
		const inputLabel = ageMs >= STALE_TURN_INPUT_MS
			? `Current turn input to continue (delivered ${Math.round(ageMs / 1000)} s ago; later tool results are newer):`
			: 'Current turn input to continue:';
		return [
			// The recent list also owns handles from earlier turns. Deduplicate entries, not whole lists.
			this.#carryOver('Mid-turn continuation', { midTurn: true, excludeTools: new Set(active.toolDigests.lines({ everyAction: true })), visible }),
			`${inputLabel}\n${turnInput}`,
			...(active.toolDigests.length === 0 ? [] : [['Completed tool calls this turn (one-line digests):', ...active.toolDigests.lines({ everyAction: true }).map((entry) => `- ${entry}`)].join('\n')]),
			`Tool result for Minecraft tool "${name}"${toolUseId === null ? '' : ` (tool use ${toolUseId})`}:\n${toolResult}`,
			...otherResults,
			...(shared?.shared.length ? [`Shared failure fields shown above (apply these to the tool receipt; omitted fields here are not absent facts):\n${shared.shared.join('\n')}`] : []),
			...steers,
		].filter(Boolean).join('\n\n');
	}

	#carryOver(reason, { midTurn = false, excludeTools = new Set(), visible = [] } = {}) {
		const lines = this.#recentTools.lines({ everyAction: midTurn }).filter((entry) => !excludeTools.has(entry)).map((entry) => `- ${entry}`);
		return [
			midTurn
				? `${reason}: an active tool turn resumes below. Use the completed tool result once, then continue the current goal with the latest event facts.`
				: `${reason}: earlier turns are not shown. The event restates goal, intent (now), task memory and facts; read taskPlan, programStatus or memory for more.`,
			...(lines.length === 0 ? [] : ['Your most recent tool calls (oldest first):', ...lines]),
			...(this.#recentConversation.length === 0 ? [] : ['Recent conversation already delivered to you (oldest first):', ...this.#recentConversation.map((entry) => `- ${entry}`)]),
			...this.#failureCarryOver.lines(visible),
			...(this.#lastProgram === null ? [] : [`Last known program (verify with programStatus): ${JSON.stringify(this.#lastProgram)}`]),
			...(this.#lastAgentText === null ? [] : [`Your last note: ${JSON.stringify(this.#lastAgentText)}`]),
		].join('\n');
	}

	/** Remembers delivered conversation and program state from a native event for a later carry-over. */
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
		// A successful replacement may omit the CANCELLED predecessor receipt. The new
		// handle proves the runtime released the explicitly named old handle.
		if (name === 'replaceAction' && typeof args?.actionId === 'string' && typeof result?.actionId === 'string' && args.actionId !== result.actionId && result.replacedAction === undefined) {
			const replaced = { actionId: args.actionId, state: 'CANCELLED', reasonCode: 'ACTION_REPLACED' };
			digests.noteDelivered(replaced);
			this.#recentTools.noteDelivered(replaced);
		}
		this.#failureCarryOver.noteEnvelope(result);
		digests.push(name, truncate(JSON.stringify(args ?? {}), 160), result);
		return this.#recentTools.push(name, truncate(JSON.stringify(args ?? {}), 160), result);
	}

	/**
	 * Marks the call's first stream event of any kind, so a late or missing message_start cannot hide the
	 * prefill/generation split, and records every tool the model starts before it reaches the Minecraft tool server.
	 */
	#noteStreamMarks(event, now) {
		const marks = this.#stream;
		marks.firstAt ??= now;
		marks.events += 1;
		if (event?.type === 'message_start') marks.startAt ??= now;
		else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use' && typeof event.content_block.name === 'string' && marks.tools.length < MAX_TRACED_TOOLS) {
			marks.tools.push({ name: event.content_block.name.slice(0, 64), at: now });
		}
	}

	/** --include-partial-messages: message_start is the first streamed event (after prefill), message_stop ends generation. */
	#onStreamEvent(event) {
		const id = event?.message?.id;
		if (event?.type === 'message_start' && typeof id === 'string') {
			this.#currentCallId = id;
			const call = this.#call(id);
			call.active?.callLog?.beginCall(id);
			mergeUsage(call.usage, event.message.usage);
			return;
		}
		const call = this.#currentCallId === null ? undefined : this.#calls.get(this.#currentCallId);
		if (call === undefined) return;
		const log = call.active?.callLog;
		if (log != null) {
			const id = `${call.id}:${event.index ?? 0}`;
			const block = event.type === 'content_block_start' ? event.content_block : event.delta;
			if (['text', 'text_delta'].includes(block?.type)) log.outputDelta(id, block.text, call.id);
			else if (['thinking', 'thinking_delta'].includes(block?.type)) log.reasoningDelta(id, block.thinking, call.id);
		}
		if (event?.type === 'message_delta') mergeUsage(call.usage, event.usage);
		else if (event?.type === 'message_stop') this.#finishCall(call);
	}

	/** Without partial messages each API call still arrives as assistant messages sharing one message id. */
	#noteAssistantUsage(message) {
		if (typeof message?.id !== 'string') return;
		const call = this.#call(message.id);
		if (call.done) return;
		call.firstEventAt ??= Date.now();
		mergeUsage(call.usage, message.usage);
	}

	#call(id) {
		let call = this.#calls.get(id);
		if (call === undefined) {
			call = { id, active: this.#active ?? this.#usageOwner, requestAt: this.#requestAt, firstEventAt: null, stream: this.#stream, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, done: false };
			this.#calls.set(id, call);
			this.#currentCallId = id;
		}
		return call;
	}

	#finishCalls() {
		const calls = [...this.#calls.values()];
		for (const call of this.#calls.values()) this.#finishCall(call);
		this.#calls.clear();
		this.#currentCallId = null;
		this.#stream = newStreamMarks();
		this.#usageOwner = null;
		return calls;
	}

	/**
	 * A call still streaming when its process is dropped was billed from the moment it started; the tool call that triggers
	 * a handoff is usually dispatched before that call's message_stop. Its output so far is a lower bound.
	 */
	#settleOpenCalls() {
		for (const call of this.#calls.values()) {
			if (call.done) continue;
			call.done = true;
			this.#handoffBudget.noteUsage(call.usage);
			addUsage(this.#usage, call.usage);
			this.#unreportedCostUsd += estimateCallCostUsd(call.usage);
			if (call.active !== null) addUsage(call.active.usage, call.usage);
			this.#emitCallUsage(call, { interrupted: true });
		}
	}

	#finishCall(call) {
		if (call.done) return;
		call.endedAt = Date.now();
		call.done = true;
		if (this.#stream === call.stream) this.#stream = newStreamMarks();
		const { input, cacheRead, cacheWrite } = call.usage;
		this.#handoffBudget.noteUsage(call.usage);
		const contextTokens = input + cacheRead + cacheWrite;
		this.#lastContextTokens = contextTokens;
		if (this.#awaitingHandoffFloor) { this.#sessionFloorTokens = contextTokens; this.#awaitingHandoffFloor = false; }
		const rotationTokens = this.#config.contextRotationTokens;
		if (rotationTokens > 0 && contextTokens >= rotationTokens
			&& (this.#sessionFloorTokens === null || contextTokens - this.#sessionFloorTokens >= rotationTokens * MIN_ROTATION_GROWTH_SHARE)) this.#rotationDue = true;
		this.#prepareStandbyIfUseful();
		addUsage(this.#usage, call.usage);
		this.#unreportedCostUsd += estimateCallCostUsd(call.usage);
		const active = call.active;
		if (active === null) return;
		addUsage(active.usage, call.usage);
		this.#emitCallUsage(call);
	}

	#emitCallUsage(call, flags = {}) {
		const active = call.active;
		if (active === null) return;
		const endedAt = call.endedAt ??= Date.now();
		const firstAt = call.stream.firstAt ?? call.firstEventAt;
		const { input, cacheRead, cacheWrite, output } = call.usage;
		const contextTokens = input + cacheRead + cacheWrite;
		const total = this.#usage;
		const requestAt = call.requestAt;
		active.callLog?.usage({ input, cacheRead, cacheWrite, output }, call.id);
		safeVerbose(active.onVerbose, 'live_usage', JSON.stringify({
			inputTokens: total.input + total.cacheRead + total.cacheWrite, cachedInputTokens: total.cacheRead, cacheWriteInputTokens: total.cacheWrite,
			outputTokens: total.output, totalTokens: total.input + total.cacheRead + total.cacheWrite + total.output,
			threadId: `claude:${this.agentId}:${this.#sessionGeneration}`, reportedAtEpochMs: Date.now(),
			last: { inputTokens: contextTokens, cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite, outputTokens: output, totalTokens: contextTokens + output },
			call: {
				provider: 'claude', turnId: active.turnId, modelCallId: `${active.turnId}:${call.id}`, contextTokens, rotations: this.#rotations, endedAt,
				handoffBudget: this.#handoffBudget.snapshot,
				partialMessagesAccepted: call.stream.events > 0, ...flags,
				...(requestAt === null || firstAt === null ? {} : { firstEventMs: Math.max(0, firstAt - requestAt) }),
				...(firstAt === null ? {} : { streamMs: Math.max(0, endedAt - firstAt) }),
				...(requestAt === null ? {} : { totalMs: Math.max(0, endedAt - requestAt), requestAt }),
				...(firstAt === null ? {} : { firstEventAt: firstAt, firstEventSource: call.stream.firstAt === null ? 'assistant' : 'stream' }),
				...(requestAt === null || call.stream.startAt === null ? {} : { startMs: Math.max(0, call.stream.startAt - requestAt) }),
				streamEvents: call.stream.events,
				...(call.stream.tools.length === 0 ? {} : { toolNames: call.stream.tools.map((tool) => tool.name), ...(requestAt === null ? {} : { toolStartMs: call.stream.tools.map((tool) => Math.max(0, tool.at - requestAt)) }) }),
			},
		}));
	}

	#writeUserMessage(text) {
		this.#usageOwner = this.#active;
		// Late outcomes ride on whichever input reaches the model next (turn, warm or cold continuation)
		// and leave the queue only once that input was written.
		const late = this.#lateOutcomes.length;
		if (late > 0) text = `${text}\n\nLate outcomes from retired Claude sessions (history, not results of this turn's tool calls):\n\n${this.#lateOutcomes.join('\n\n')}`;
		this.#writeLine({ type: 'user', message: { role: 'user', content: text } });
		this.#active?.callLog?.input(this.#active.callLog.isEmpty ? 'turn_input' : 'handoff_input', text);
		this.#lateOutcomes.splice(0, late);
		if (!this.#processUsed) this.#handoffBudget.startSession(Buffer.byteLength(text, 'utf8'));
		this.#requestAt = Date.now();
	}

	#writeLine(value) {
		const child = this.#process?.child;
		if (child?.stdin === undefined || child.stdin === null || child.stdin.destroyed) {
			throw new ClaudeProviderError('PROVIDER_UNAVAILABLE', 'Claude Code input is closed');
		}
		child.stdin.write(`${JSON.stringify(value)}\n`);
	}

	#idlePromise() {
		if (this.#awaitingResult === 0) return Promise.resolve();
		return new Promise((resolve) => { this.#idleWaiters.push(resolve); });
	}

	async #waitForIdle() {
		if (this.#awaitingResult === 0) return;
		try {
			await withDeadline(this.#idlePromise(), this.#config.interruptTimeoutMs, this.#schedule, this.#cancelSchedule,
				() => new ClaudeProviderError('INTERRUPT_TIMEOUT', 'Claude Code did not finish the interrupted turn'));
		} catch {
			await this.#stopProcess();
			await this.#ensureProcess();
		}
	}

	#onProcessExit(state, error) {
		if (state.exited) return;
		state.exited = true;
		if (/unknown option[^\n]*--include-partial-messages/i.test(state.stderr)) PARTIAL_MESSAGES_UNSUPPORTED.add(partialMessagesKey(this.#config));
		if (this.#standbyProcess === state) {
			this.#standbyProcess = null;
			state.route?.unregister();
			state.toolsListed?.reject(error);
			return;
		}
		if (this.#process !== state) return;
		this.#process = null;
		// A process that dies before listing the tools fails prewarm now, not at the startup deadline.
		state.toolsListed?.reject(error);
		const activeToolCanHandoff = this.#active !== null && !this.#active.settled && this.#active.toolExecutions > 0;
		this.#releaseProcessState();
		if (activeToolCanHandoff) {
			this.#active.processLost = true;
			return;
		}
		if (!this.#disposed) this.invalidateSession(error);
	}

	async #stopProcess() {
		const state = this.#process;
		this.#process = null;
		this.#releaseProcessState();
		if (state === null) return;
		state.exited = true;
		try { state.child.stdin?.end?.(); } catch { /* the process may already be gone */ }
		await Promise.resolve(this.#terminate(state.child)).catch(() => {});
	}

	#releaseProcessState() {
		this.#route?.unregister();
		this.#route = null;
		this.#awaitingResult = 0;
		for (const resolve of this.#idleWaiters.splice(0)) resolve();
		this.#sessionState = 'cold';
		// An unplanned restart (unacknowledged interrupt, stuck turn) also loses the conversation.
		if (this.#processUsed && this.#pendingCarryOver === null) this.#pendingCarryOver = this.#carryOver('Claude Code restarted');
		this.#resetContextState();
	}

	/** A new Claude Code process has never seen earlier events, fact views or omitted metadata. */
	#resetContextState() {
		this.#settleOpenCalls();
		// A process dropped before its result line (rotation, restart, loss) still billed these calls.
		if (this.#unreportedCostUsd > 0) {
			this.#usage.costUsd += this.#unreportedCostUsd;
			const owner = this.#active ?? this.#usageOwner;
			if (owner !== null) owner.usage.costUsd = (owner.usage.costUsd ?? 0) + this.#unreportedCostUsd;
		}
		this.#unreportedCostUsd = 0;
		this.#observationViews.reset();
		this.#rotationDue = false;
		this.#lastContextTokens = 0;
		this.#sessionFloorTokens = null;
		this.#awaitingHandoffFloor = false;
		this.#standbyFailedForProcess = false;
		this.#turnsSinceRotation = 0;
		this.#processUsed = false;
		this.#processCostUsd = 0;
		this.#calls.clear();
		this.#currentCallId = null;
		this.#stream = newStreamMarks();
		this.#usageOwner = null;
	}

	#runOneShot(prompt) {
		const launch = buildClaudeLaunch(this.#profile, this.#config, { cwd: this.#cwd, systemPromptFile: this.#systemPromptFile, mcpConfig: null, streaming: false });
		let child;
		try { child = this.#spawn(launch.command, launch.args, launch.options); }
		catch (error) {
			return { promise: Promise.reject(new ClaudeProviderError('SPAWN_FAILED', `Could not start Claude Code: ${error.message}`, { cause: error })), cancel: async () => {} };
		}
		let cancellation = null;
		let settle;
		let timer = null;
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const terminate = this.#terminate;
		const cancel = async (error) => {
			cancellation ??= error;
			await Promise.resolve(terminate(child)).catch(() => {});
			settle?.(cancellation);
		};
		const promise = new Promise((resolve, reject) => {
			let settled = false;
			settle = (error, value) => {
				if (settled) return;
				settled = true;
				if (timer !== null) this.#cancelSchedule(timer);
				if (error === null) resolve(value); else reject(error);
			};
			child.stdout?.on('data', (chunk) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > this.#config.stdoutLineLimitBytes) { void cancel(new ClaudeProviderError('OUTPUT_LIMIT_EXCEEDED', 'Claude Code stdout exceeded its limit')); return; }
				stdout.push(Buffer.from(chunk));
			});
			child.stderr?.on('data', (chunk) => {
				stderrBytes += chunk.length;
				if (stderrBytes <= this.#config.stderrLimitBytes) stderr.push(Buffer.from(chunk));
			});
			child.once('error', (error) => settle(new ClaudeProviderError('SPAWN_FAILED', `Could not start Claude Code: ${error.message}`, { cause: error })));
			child.once('close', (exitCode, signalCode) => {
				if (cancellation !== null) { settle(cancellation); return; }
				const text = Buffer.concat(stdout).toString('utf8');
				if (exitCode !== 0) {
					settle(new ClaudeProviderError('PROVIDER_UNAVAILABLE', `Claude Code exited with code ${String(exitCode)} and signal ${String(signalCode)} [stderr=${excerpt(Buffer.concat(stderr).toString('utf8'))}] [stdout=${excerpt(text)}]`));
					return;
				}
				try { settle(null, parseClaudeJsonResult(text)); } catch (error) { settle(error); }
			});
			timer = this.#schedule(() => { void cancel(new ClaudeProviderError('PLANNING_TIMEOUT', `Claude planning timed out after ${this.#config.planningTimeoutMs} ms`)); }, this.#config.planningTimeoutMs);
			child.stdin?.on?.('error', () => {});
			child.stdin?.end?.(prompt, 'utf8');
		});
		return { promise, cancel };
	}
}

/**
 * Resolves how the Claude Code CLI is started, mirroring resolveCodexLaunch: an explicit
 * configured path wins, then a native claude.exe on PATH, then the npm package entrypoint
 * run through this Node (npm's claude.cmd shim cannot be spawned without a shell), then
 * the native installer location, and finally the bare name for the OS to resolve.
 * `args` carries the arguments that must precede the CLI's own arguments.
 */
const CLAUDE_NPM_ENTRYPOINT = Object.freeze(['@anthropic-ai', 'claude-code', 'cli.js']);

export function resolveClaudeLaunch(config, dependencies = {}) {
	const platform = dependencies.platform ?? process.platform;
	const environment = createProviderChildEnvironment('claude', dependencies.env ?? config.environment ?? process.env, config.bridgeSecretEnvironmentVariable);
	const pathExists = dependencies.existsSync ?? existsSync;
	const nodeExecutable = dependencies.execPath ?? process.execPath;
	const configured = typeof config.executable === 'string' && config.executable.trim().length > 0 ? config.executable.trim() : 'claude';
	const explicitPath = path.isAbsolute(configured) || /[\\/]/.test(configured);
	if (explicitPath && pathExists(configured)) return { command: configured, args: [], environment, source: 'configured' };
	if (platform === 'win32') {
		const onPath = explicitPath ? null : findExecutableOnPath(configured, environment, { platform, existsSync: pathExists, extensions: DIRECTLY_SPAWNABLE_WINDOWS_EXTENSIONS });
		if (onPath !== null) return { command: onPath, args: [], environment, source: 'path' };
		const appData = environmentValue(environment, 'APPDATA');
		if (appData !== null) {
			const entrypoint = path.join(appData, 'npm', 'node_modules', ...CLAUDE_NPM_ENTRYPOINT);
			if (pathExists(entrypoint)) return { command: nodeExecutable, args: [entrypoint], environment, source: 'npm' };
		}
		// Custom npm prefixes (nvm-windows and friends) only expose claude.cmd; run the package beside it.
		const besideShim = explicitPath ? null : findNpmEntrypointBesideShim(configured, CLAUDE_NPM_ENTRYPOINT, environment, { platform, existsSync: pathExists });
		if (besideShim !== null) return { command: nodeExecutable, args: [besideShim], environment, source: 'npm-shim' };
		const userProfile = environmentValue(environment, 'USERPROFILE');
		if (userProfile !== null) {
			const nativeInstall = path.join(userProfile, '.local', 'bin', 'claude.exe');
			if (pathExists(nativeInstall)) return { command: nativeInstall, args: [], environment, source: 'native' };
		}
	}
	return { command: configured, args: [], environment, source: 'bare' };
}

export function buildClaudeLaunch(profile, config, { cwd, systemPromptFile, mcpConfig = null, streaming = true }) {
	const launch = resolveClaudeLaunch(config);
	const args = [
		...launch.args,
		'--print',
		...(streaming ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...(PARTIAL_MESSAGES_UNSUPPORTED.has(partialMessagesKey(config)) ? [] : ['--include-partial-messages'])] : ['--output-format', 'json']),
		'--model', profile.model,
		'--effort', profile.reasoningEffort,
		// Only the priority tier asks for fast mode, and only when the config opts in; this is the sole non-isolated setting we pass.
		...(config.fastMode === true && profile.serviceTier === 'priority' ? ['--settings', JSON.stringify({ fastMode: true })] : []),
		'--system-prompt-file', systemPromptFile,
		// Isolation equivalent to Codex's dedicated CODEX_HOME: no user/project settings,
		// CLAUDE.md, hooks, plugins, or MCP servers other than the Minecraft tools.
		'--setting-sources', '',
		'--strict-mcp-config',
		...(mcpConfig === null ? [] : ['--mcp-config', JSON.stringify(mcpConfig)]),
		// References are served by Minecraft capabilities; the skill is already in the system prompt.
		'--tools', '',
		...(mcpConfig === null ? [] : ['--allowedTools', `mcp__${MCP_SERVER_NAME}`]),
		'--permission-mode', 'dontAsk',
		// Keep the CLI restriction in addition to exposing only the Minecraft MCP tools.
		'--restricted',
		'--disable-slash-commands',
		'--no-session-persistence',
	];
	return {
		command: launch.command,
		args,
		options: {
			cwd,
			env: {
				...launch.environment,
				CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
				DISABLE_AUTOUPDATER: '1',
				MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS,
			},
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		},
	};
}

function systemPromptFor(controlProtocol, recoverySummary, minecraftInstructions, skillInstructions) {
	if (controlProtocol === 'native_tools') {
		const base = minecraftInstructions === '' ? NATIVE_AGENT_INSTRUCTIONS : nativeInstructions(minecraftInstructions, skillInstructions);
		return `${base}\n\n${CLAUDE_TOOL_NOTE}\n\n${nativeRecoveryInstructions(recoverySummary)}\n`;
	}
	if (controlProtocol === 'goal_spec') return `${goalSpecInstructions()}\n\nReturn only one JSON value matching the supplied output schema. Never call tools.\n`;
	return `${PLANNER_SYSTEM_PROMPT}\n\n${recoveryInstructions(recoverySummary)}\n`;
}

function parseClaudeJsonResult(output) {
	let document;
	try { document = JSON.parse(String(output).trim()); }
	catch (error) { throw new ClaudeProviderError('INVALID_PROVIDER_OUTPUT', 'Claude Code returned invalid JSON', { cause: error }); }
	if (document?.type !== 'result' || document.subtype !== 'success' || document.is_error === true || typeof document.result !== 'string') {
		throw new ClaudeProviderError(resultErrorCode(document) ?? 'PROVIDER_UNAVAILABLE', `Claude Code returned an unsuccessful result [output=${excerpt(output)}]`);
	}
	return {
		text: document.result,
		durationMs: finiteDuration(document.duration_ms),
		apiDurationMs: finiteDuration(document.duration_api_ms),
		tokens: claudeTokenUsage(document.usage),
		...(Number.isFinite(document.total_cost_usd) && document.total_cost_usd >= 0 ? { costUsd: document.total_cost_usd } : {}),
	};
}

function claudeTokenUsage(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	return {
		input: nativeToken(value.input_tokens),
		output: nativeToken(value.output_tokens),
		reasoning: null,
		cached: nativeToken(value.cache_read_input_tokens),
		cacheWrite: nativeToken(value.cache_creation_input_tokens),
	};
}

/** Maps Claude Code's error text onto the coordinator's recovery codes so account problems are not retried blindly. */
function resultErrorCode(document) {
	const text = String(document?.result ?? '');
	// e.g. "Fable 5.1 requires usage credits. Switch to another model": retrying the same model cannot succeed.
	if (/usage credits|switch to another model|do(?:es)? not have access to|model .*not (?:available|found)/i.test(text)) return 'MODEL_UNAVAILABLE';
	if (/not logged in|\/login|invalid api key|authentication/i.test(text)) return 'AUTHENTICATION_REQUIRED';
	if (/rate.?limit|usage limit|overloaded|429/i.test(text)) return 'RATE_LIMITED';
	return null;
}

function captureAssistantMessage(log, message) {
	const id = typeof message?.id === 'string' ? message.id : null;
	log.finalItem({ type: 'assistant', ...message }, id);
	for (const [index, block] of (Array.isArray(message?.content) ? message.content : []).entries()) {
		const itemId = `${id}:${index}`;
		if (block?.type === 'text') log.output(block.text, id, itemId);
		else if (block?.type === 'thinking' && typeof block.thinking === 'string') log.reasoning(block.thinking, itemId, id);
		else if (block?.type === 'tool_use') log.toolCall({ callId: block.id ?? null, name: block.name, arguments: block.input }, id);
	}
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
		const delivered = { ...content, contentItems: [...content.contentItems, {
			type: 'inputText', text: `Newer coordinator events for this turn (treat them exactly like the turn input):\n${text}`,
		}] };
		for (const waiter of pending.waiters) waiter.resolve();
		return delivered;
	}
	return content;
}

function failPendingSteers(active) {
	const pending = active.pendingSteers;
	active.pendingSteers = null;
	discardPendingSteer(pending);
	for (const waiter of pending?.waiters ?? []) waiter.reject(new ClaudeProviderError('TURN_NOT_ACTIVE', 'Claude turn ended before the steer reached a tool boundary'));
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
	return {
		content: contentItems.map((item) => ({ type: 'text', text: item.text })),
		isError: success === false,
	};
}

function createSilenceDeadline(timeoutMs, schedule, cancelSchedule) {
	let handle = null;
	let generation = 0;
	let disposed = false;
	let paused = 0;
	let rejectDeadline;
	const promise = new Promise((_, reject) => { rejectDeadline = reject; });
	void promise.catch(() => {});
	const clear = () => {
		generation += 1;
		if (handle !== null) cancelSchedule(handle);
		handle = null;
	};
	const restart = () => {
		if (disposed) return;
		clear();
		if (paused > 0) return;
		const expected = generation;
		handle = schedule(() => {
			if (disposed || generation !== expected) return;
			handle = null;
			rejectDeadline(new ClaudeProviderError('PLANNING_TIMEOUT', `Claude provider was silent for ${timeoutMs} ms`));
		}, timeoutMs);
	};
	return {
		promise,
		restart,
		pause() { paused += 1; clear(); },
		resume() { paused = Math.max(0, paused - 1); restart(); },
		dispose() { disposed = true; clear(); },
	};
}

function withDeadline(promise, timeoutMs, schedule, cancelSchedule, createError) {
	let handle;
	const timeout = new Promise((_, reject) => {
		handle = schedule(() => reject(createError()), timeoutMs);
		handle?.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => cancelSchedule(handle));
}

function validateServiceConfig(config) {
	if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Claude service config must be an object');
	if ((config.provider ?? 'claude') !== 'claude') throw new TypeError('Claude provider must be claude');
	const cwd = requireText(config.cwd, 'cwd');
	const models = requireStringArray(config.models ?? Object.keys(CLAUDE_MODELS), 'models');
	for (const model of models) if (!/^claude-[a-z0-9.-]+$/.test(model)) throw new TypeError(`Claude model '${model}' must be a claude-* model id`);
	const reasoningEfforts = requireStringArray(config.reasoningEfforts ?? CLAUDE_REASONING_EFFORTS, 'reasoningEfforts');
	for (const effort of reasoningEfforts) {
		if (!CLAUDE_REASONING_EFFORTS.includes(effort)) throw new TypeError(`Claude reasoning effort '${effort}' must be one of ${CLAUDE_REASONING_EFFORTS.join(', ')}`);
	}
	const maxConcurrentStandbys = positiveInteger(config.maxConcurrentStandbys ?? DEFAULT_MAX_CONCURRENT_STANDBYS, 'maxConcurrentStandbys');
	return {
		...config,
		provider: 'claude',
		cwd,
		executable: requireText(config.executable ?? 'claude', 'executable'),
		runtimeRoot: path.resolve(config.runtimeRoot ?? path.join(cwd, 'runtime', 'claude-agents')),
		models,
		reasoningEfforts,
		planningTimeoutMs: positiveInteger(config.planningTimeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS, 'planningTimeoutMs'),
		startupTimeoutMs: positiveInteger(config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs'),
		interruptTimeoutMs: positiveInteger(config.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS, 'interruptTimeoutMs'),
		maxDecisionBytes: positiveInteger(config.maxDecisionBytes ?? DEFAULT_MAX_DECISION_BYTES, 'maxDecisionBytes'),
		stdoutLineLimitBytes: positiveInteger(config.stdoutLimitBytes ?? DEFAULT_STDOUT_LINE_LIMIT_BYTES, 'stdoutLimitBytes'),
		stderrLimitBytes: positiveInteger(config.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES, 'stderrLimitBytes'),
		contextRotationTokens: nonnegativeInteger(config.contextRotationTokens ?? DEFAULT_CONTEXT_ROTATION_TOKENS, 'contextRotationTokens'),
		fastMode: config.fastMode === true,
		maxConcurrentStandbys,
		standbyIdleTimeoutMs: positiveInteger(config.standbyIdleTimeoutMs ?? DEFAULT_STANDBY_IDLE_TIMEOUT_MS, 'standbyIdleTimeoutMs'),
	};
}

function validateProfile(value, config) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('agent profile must be an object');
	const profile = {
		agentId: requireText(value.agentId, 'agentId'),
		provider: value.provider ?? 'claude',
		model: requireText(value.model, 'model'),
		reasoningEffort: requireText(value.reasoningEffort, 'reasoningEffort'),
		serviceTier: requireText(value.serviceTier ?? 'priority', 'serviceTier'),
	};
	if (profile.provider !== 'claude') throw new ClaudeProviderError('PROVIDER_MISMATCH', `Expected claude profile, received ${profile.provider}`);
	if (!config.models.includes(profile.model)) throw new ClaudeProviderError('UNSUPPORTED_MODEL', `claude model '${profile.model}' is not configured`);
	return profile;
}

function validateControlProtocol(value) {
	if (!CONTROL_PROTOCOLS.has(value)) throw new TypeError("controlProtocol must be 'arena_script', 'native_tools', or 'goal_spec'");
	return value;
}

function assertSameSession(entry, profile, protocol) {
	if (!profilesMatch(entry.profile, profile) || entry.controlProtocol !== protocol) throw profileConflict(profile.agentId);
}

function profileConflict(agentId) {
	return new ClaudeProviderError('AGENT_PROFILE_CONFLICT', `claude agent '${agentId}' already has a different profile`);
}

function assertReconciliationActive(signal) {
	if (signal?.aborted) throw new ClaudeProviderError('STALE_RECONCILIATION', 'Claude reconciliation was superseded');
}

function assertLifecycleActive(expected, current) {
	if (expected !== current) throw new ClaudeProviderError('PROVIDER_STOPPED', 'Claude service lifecycle was stopped');
}

function agentDirectoryName(agentId) {
	return createHash('sha256').update(agentId, 'utf8').digest('hex').slice(0, 24);
}

function stripCodeFence(text) {
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
	return fenced === null ? text : fenced[1].trim();
}

/** Stage timestamp for the latency trace; the coordinator stamps it when the verbose channel delivers it. */
function providerEvent(callback, event, fields) {
	safeVerbose(callback, 'provider_event', JSON.stringify({ event, ...fields }));
}

function newStreamMarks() {
	return { firstAt: null, startAt: null, events: 0, tools: [] };
}

function safeVerbose(callback, stage, message) {
	if (typeof callback !== 'function') return;
	try { Promise.resolve(callback(stage, message)).catch(() => {}); }
	catch { /* public-agent-message reporting cannot affect provider work */ }
}

function normalizeRecoverySummary(value) {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value !== 'string' || value.length > 2_048) throw new TypeError('recoverySummary must be at most 2048 characters');
	return value;
}

function profilesMatch(left, right) { return ['agentId', 'provider', 'model', 'reasoningEffort', 'serviceTier'].every((key) => left[key] === right[key]); }
function readableModel(value) { return value.split('-').map((part) => part.length === 0 ? '' : part[0].toUpperCase() + part.slice(1)).filter(Boolean).join(' '); }
/**
 * True only when Claude Code confirms a model that is not the selected one. A context-window suffix such
 * as [1m] is not part of the model. Only a -latest alias or an undated legacy ID (before the 4.6
 * generation, when undated IDs were aliases of dated snapshots) may be confirmed as a dated snapshot.
 * Dated IDs and modern dateless IDs are fixed snapshots and must be confirmed exactly.
 */
function reportsOtherModel(selected, reported) {
	if (typeof reported !== 'string' || reported.length === 0 || reported.length > 256) return false;
	const model = (value) => String(value).trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
	const requested = model(selected);
	const confirmed = model(reported);
	if (confirmed === requested) return false;
	const alias = requested.endsWith('-latest') ? requested.slice(0, -'-latest'.length)
		: isLegacyClaudeAlias(requested) ? requested : null;
	return alias === null || confirmed.replace(/-\d{8}$/, '') !== alias;
}

function isLegacyClaudeAlias(id) {
	const match = /^claude-(?:[a-z]+-)?(\d+)(?:-(\d))?(?:-[a-z]+)?$/.exec(id);
	if (match === null) return false;
	const major = Number(match[1]);
	const minor = match[2] === undefined ? 0 : Number(match[2]);
	return major < 4 || major === 4 && minor < 6;
}

function boundedArguments(args) {
	let text;
	try { text = JSON.stringify(args ?? {}); } catch { text = '{}'; }
	return text.length <= 2_048 ? text : `${text.slice(0, 2_048)}...`;
}

function excerpt(value) { return JSON.stringify((typeof value === 'string' ? value : JSON.stringify(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512)); }
function nativeToken(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function finiteDuration(value) { return Number.isFinite(value) && value >= 0 ? Math.round(value) : null; }
function requireText(value, field) { if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be nonblank`); return value.trim(); }
function requireStringArray(value, field) { if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a nonempty array`); return [...new Set(value.map((entry) => requireText(entry, field)))]; }
function partialMessagesKey(config) { return String(config.executable ?? 'claude'); }
function nonnegativeInteger(value, field) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a nonnegative safe integer`); return value; }
function truncate(text, max) { return text.length <= max ? text : `${text.slice(0, max - 3)}...`; }
function mergeUsage(target, usage) {
	if (usage === null || typeof usage !== 'object') return;
	// Streaming repeats cumulative counts per message, so the largest value seen is the call's total.
	for (const [key, field] of [['input', 'input_tokens'], ['cacheRead', 'cache_read_input_tokens'], ['cacheWrite', 'cache_creation_input_tokens'], ['output', 'output_tokens']]) {
		if (Number.isSafeInteger(usage[field]) && usage[field] > target[key]) target[key] = usage[field];
	}
}
export function estimateCallCostUsd(usage) {
	return estimateTokenCostUsd(usage, { provider: 'claude', model: 'claude-opus-5-5', serviceTier: 'priority' });
}
/** Totals of interrupted turns, each already including any turn it carried; null when there are none. */
function carriedUsage(turns) {
	if (turns.length === 0) return null;
	const total = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: null };
	for (const { usage } of turns) {
		for (const key of ['calls', 'input', 'cacheRead', 'cacheWrite', 'output']) total[key] += usage[key];
		if (usage.costUsd !== null) total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
	}
	return total;
}
function addUsage(target, usage) {
	target.calls += 1;
	for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) target[key] += usage[key];
}
function positiveInteger(value, field) { if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`); return value; }

// Event inputs carry their JSON after an instruction line; tool replies are a single JSON line.
function handoffFacts(text) {
	return text.split('\n').flatMap(line => {
		try { return [decodeModelFacts(JSON.parse(line))]; } catch { return []; }
	});
}
