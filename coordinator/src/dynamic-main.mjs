import { watchCaptureShutdown } from './capture-shutdown.mjs';
import { strictSpendRuntime } from './strict-spend-runtime.mjs';
import { visibleObservation, visibleHealing, visibleEntity, visibleMenu } from './player-visible-facts.mjs';
import { isFailureResult, withFailureSchema } from './failure-schema.mjs';
import { compactStandingOrder } from './standing-orders.mjs';
import { presentEventHealing, presentEventObservation } from './event-observation-presentation.mjs';
import { boundedResourceSightings, isDiscoveryBlock, resourceBlockFact } from './resource-sightings.mjs';
import { compactProjectileObservation } from './projectile-attention.mjs';
import { generateDirectorScript } from './director-script-generator.mjs';
import { encodeModelFacts, hasHeardSection, withoutHeardSoundEvents } from './model-fact-encoding.mjs';
import { NEW_CONTEXT_EVENT_INSTRUCTION, ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION, isNewContextEventInput } from './native-event-instructions.mjs';
import { respawnLead } from './respawn-recovery.mjs';
export { NEW_CONTEXT_EVENT_INSTRUCTION } from './native-event-instructions.mjs';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentPlanner } from './agent-planner.mjs';
import { AgentRegistry, AgentRegistryError, DynamicAgentState } from './agent-registry.mjs';
import { ActiveGoalSupervisor } from './active-goal-supervisor.mjs';
import { MAX_LEASE_TIMEOUT_MS } from './work-lease-supervisor.mjs';
import { AgentWorkspaceManager } from './agent-workspace.mjs';
import { MinecraftAgentWorkspace } from './minecraft-agent-workspace.mjs';
import { AntigravityProviderService } from './antigravity-service.mjs';
import { ClaudeProviderService } from './claude-service.mjs';
import { OpenCodeProviderService } from './opencode-service.mjs';
import { CodexService } from './codex-service.mjs';
import { ControlLatencyRegistry } from './control-latency-registry.mjs';
import { buildCoordinatorStatus, providerRecoveryComponents } from './coordinator-status.mjs';
import { ConversationMemory, conversationWakes } from './conversation-memory.mjs';
import { PendingConversationInbox } from './pending-conversation-inbox.mjs';
import { FactLedger } from './fact-ledger.mjs';
import { InspectionClient } from './inspection-client.mjs';
import { ModelNotebook } from './model-notebook.mjs';
import { RuntimeMemoryContext } from './runtime-memory-context.mjs';
import { TaskMemoryStore } from './task-memory-store.mjs';
import { LiveTaskViews, updateUsage } from './live-task-view.mjs';
import { withToolWear } from './resource-facts.mjs';
import { ObservedMemoryStore } from './observed-memory-store.mjs';
import { ExplorationOccupancy } from './explore-frontier.mjs';
import { ownSighting } from './search-coverage.mjs';
import { ProviderService } from './provider-service.mjs';
import { ProviderTurnRecorder } from './provider-turn-recorder.mjs';
import { DangerSteerCoalescer, retainedDangerFooting } from './danger-steer-coalescer.mjs';
import { carryNativeWakeEvents, owedWakeEvents, protectedNativeWake } from './native-wake-events.mjs';
import {
	DEFAULT_AGENT_CAP,
	DEFAULT_GOAL_QUEUE_CAP,
	DEFAULT_PLANNING_CONCURRENCY,
	defaultServiceTier,
} from './constants.mjs';
import { PlanningScheduler } from './planning-scheduler.mjs';
import { MAX_VERBOSE_MESSAGE_LENGTH, MultiplexedServerBridge, ProtocolV2Error, VERBOSE_STAGES } from './protocol-v2.mjs';
import { adaptObservation } from './observation-adapter.mjs';
import { advanceContextCursor, buildPlannerInput, buildPlannerRequest, contextCursorMatches, createContextCursor } from './prompts.mjs';
import { profileFingerprint } from './provider-session.mjs';
import { ProviderHealthRegistry } from './provider-health-registry.mjs';
import { classifyRecoveryFailure } from './recovery-policy.mjs';
import { ReportingTransitionDeduper } from './reporting-transition-deduper.mjs';
import { NativeToolRuntime, PLANNING_TAIL_NOTE } from './native-tool-runtime.mjs';
import { classifyNativeGoalError } from './native-goal-error-policy.mjs';
import { MAX_GOAL_SPEC_CORRECTION_ATTEMPTS, fallbackCompiledDragonGoal, localGoalSpecFeedback } from './goal-spec-translator.mjs';
import { ProgramRuntimeManager } from './program-runtime-manager.mjs';
import { createProviderChildEnvironment } from './provider-environment.mjs';
import { PROVIDER_CLI, ProviderCliHealthMonitor, createDisabledProviderCliHealthMonitor } from './provider-cli-health.mjs';
import { NATIVE_TOOL_PROVIDERS, PROVIDER_IDS, TOOL_BOUNDARY_STEER_PROVIDERS } from './provider-identity.mjs';
import { ProviderDiscovery, createAccountReaders, discoverOpenCodeModels } from './provider-discovery.mjs';
import { registerDiscoveredPrice } from './call-cost.mjs';
import { TASK_VIEW_MAX_BYTES } from './protocol-v2.mjs';
import { UsageLedger } from './usage-ledger.mjs';
import { TraceWriter } from './trace-writer.mjs';
import { wireRuntimeDiagnostics } from './runtime-diagnostics.mjs';
import { RuntimeErrorReporter } from './runtime-error-reporter.mjs';
import { BestEffortDiagnosticQueue } from './best-effort-diagnostic-queue.mjs';
import { RotatingJsonlSink } from './rotating-jsonl-sink.mjs';
import { sanitizeDiagnosticCode, sanitizeDiagnosticErrorCode, sanitizeDiagnosticErrorMessage, sanitizeDiagnosticText, sanitizeDiagnosticValue } from './diagnostic-sanitizer.mjs';
import { FishTtsProvider } from './voice/fish-tts-provider.mjs';
import { OpenAiTtsProvider, OpenAiSttProvider, DEFAULT_OPENAI_TTS_MODEL, DEFAULT_OPENAI_STT_MODEL } from './voice/openai-speech-provider.mjs';
import { DeepgramSttProvider, NoSttProvider } from './voice/deepgram-stt-provider.mjs';
import { LocalSpeechProvider } from './voice/local-speech-provider.mjs';
import { providerCacheNamespace, tagSynthesisCacheNamespace } from './voice/tts-cache-identity.mjs';
import { createVoiceHttpServer } from './voice/voice-http-server.mjs';
import { VoiceSupervisor } from './voice/voice-supervisor.mjs';
import { loadPersistentVoiceProfileStore, VoiceProfileStore } from './voice/voice-profile-store.mjs';
import { WindowsTtsProvider } from './voice/windows-tts-provider.mjs';
import { situationFacts } from './situation-facts.mjs';
import { combatFacts } from './combat-facts.mjs';
import { arrivalFacts, reportsDimensionChange } from './arrival-facts.mjs';
import { DRAGON_PERCHED_TRIGGER, dragonPerchEdge, dragonPerchLine, noteCombatDispatch, rememberEndCrystals, settleCombatResult } from './dragon-fight-facts.mjs';
import { heldToolBreak } from './held-tool-break.mjs';
import { SITUATION_CHANGED_FIELD, STRATEGY_POINTER_FIELD, SituationChangeTracker } from './situation-changes.mjs';
import { ContextEntryTracker, uncoveredDangers } from './danger-contexts.mjs';
import { WakeFilter } from './wake-filter.mjs';
import { DEFAULT_REFLEXES, ReflexBook } from './reflexes.mjs';
// Namespace import: situationStrategyTopic is optional, so the changed line works with or without it.
import * as strategyReference from './minecraft-strategy-reference.mjs';
import { provenance } from './fact-provenance.mjs';
import { BodyPace } from './body-pace.mjs';
import { dangerGlance } from './danger-glance.mjs';

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR_DIRECTORY = path.resolve(SOURCE_DIRECTORY, '..');
const PROJECT_DIRECTORY = path.resolve(COORDINATOR_DIRECTORY, '..');
const DEFAULT_DYNAMIC_CONFIG_PATH = path.join(COORDINATOR_DIRECTORY, 'config', 'dynamic-agents.json');
const DEFAULT_INVALID_DECISION_RETRIES = 1;
const EMPTY_TURN_RETRY_DELAY_MS = 1_000;
const GOAL_SPEC_RETRY_BASE_MS = 1_000;
const GOAL_SPEC_RETRY_MAX_MS = 30_000;
const GOAL_SPEC_PROPOSAL_RETRY_MS = 5_000;
const TERMINAL_GOAL_SPEC_REJECTIONS = new Set(['UNKNOWN_GOAL_DRAFT', 'GOAL_DRAFT_AGENT_MISMATCH', 'STALE_GOAL_DRAFT']);
const QUIET_LIFECYCLE_ERRORS = new Set(['PLAN_CANCELLED', 'STALE_PLAN', 'STALE_GOAL_REVISION', 'GOAL_REVISION_COLLISION']);
const MAX_CONVERSATION_WAKE_TRANSACTIONS = 4_096;
const PARKED_NATIVE_STATES = [DynamicAgentState.IDLE, DynamicAgentState.COMPLETED, DynamicAgentState.PAUSED, DynamicAgentState.ERROR];
const GENERIC_WAKE_TRIGGERS = new Set(['attention', 'observation']);
// Ordinary perception a running program already receives and answers through its own decisions (onObservation).
const PROGRAM_OWNED_PERCEPTION_TRIGGERS = new Set(['attention', 'observation', 'resource_discovery', 'structure_sighted', 'lava_heard', 'heal_opportunity', 'projectile']);
// Never held for a running action nor waived by a program's reassessWhen (see classifyObservationTrigger).
const DIMENSION_CHANGED_TRIGGER = 'dimension_changed';
// A seen lava flow due at the body within seconds (player.lavaFlow): the last moment a reply can still move it out.
export const LAVA_FLOW_TRIGGER = 'lava_flow';
const TOOL_BROKE_TRIGGER = 'tool_broke';
// Longest an ordinary wake is held for the model's own running action. Long walks (navigate_to ran up to 37 s) must
// still let the model change course, and the model's own decision p95 is about 8 s.
const ORDINARY_WAKE_HOLD_MS = 15_000;
// Distinct block steps remembered for loop detection: a walk around a 3x3 ring (8 cells) can repeat once inside it.
const MAX_NATIVE_MOVEMENT_HISTORY = 16;
// A hit's knockback (0.4 blocks per tick with a hop, then drag and ground friction) has settled within about 12 ticks.
const KNOCKBACK_SETTLE_MS = 600;
// An action's progress position can report the shove up to two ticks before the hurt observation that explains it.
const KNOCKBACK_LEAD_MS = 100;
// The body's own ground speed: sneaking is 0.03 blocks per tick, sprinting with Speed II 0.18; a knockback starts at 0.4.
const SELF_PROPELLED_MIN_SPEED = 0.02;
const SELF_PROPELLED_MAX_SPEED = 0.25;
// Damage without an attacker's direction (vanilla damage type ids) pushes nobody, so it does not discount movement.
const NON_KNOCKBACK_DAMAGE = new Set(['in_fire', 'campfire', 'on_fire', 'lava', 'hot_floor', 'fall', 'fly_into_wall', 'drown', 'starve',
	'cactus', 'sweet_berry_bush', 'freeze', 'wither', 'magic', 'in_wall', 'cramming', 'dry_out', 'stalagmite', 'out_of_world', 'outside_border']);
const MAX_NATIVE_RESOURCE_MEMORY = 512;
const MAX_NATIVE_BROKEN_BLOCKS = 32;
const DEFAULT_CONNECTION_OPERATION_CAP = 256;
const DEFAULT_AGENT_OPERATION_CAP = 32;
const MAX_PUBLIC_NARRATIVE_RAW_CHARS = 1_024;
const DEFAULT_MAX_PENDING_AGENT_OPERATIONS = 64;
const DEFAULT_MAX_PENDING_AGENT_TRANSACTIONS = 16;
const DEFAULT_VOICE_PORT = 8_766;
const DEFAULT_VOICE_MAX_CONCURRENT = 5;
const DEFAULT_VOICE_PROFILE_ASSIGNMENTS_PATH = path.join('runtime', 'voice-profile-assignments.json');
const DEFAULT_VOICE_SECRET_PATH = path.join('runtime', 'voice-secret.txt');
const DEFAULT_LOCAL_SPEECH_TIMEOUT_MS = 120_000;
const DEFAULT_FISH_FALLBACK_BASE_DELAY_MS = 30_000;
const DEFAULT_FISH_FALLBACK_MAX_DELAY_MS = 300_000;
const VOICE_WARMUP_GRACE_MS = 1_000;
const DEFAULT_FISH_API_KEY_ENVIRONMENT_VARIABLE = 'FISH_AUDIO_API_KEY';
const DEFAULT_DEEPGRAM_API_KEY_ENVIRONMENT_VARIABLE = 'DEEPGRAM_API_KEY';
const DEFAULT_LOCAL_SPEECH_PYTHON_DIRECTORY = path.join('runtime', 'local-speech', '.venv');
const STT_ONLY_PROFILE_STORE = Object.freeze({
	resolve() { throw new Error('voice profiles are unavailable without TTS'); },
});
const WINDOWS_TTS_FALLBACK_CODES = new Set([
	'LOCAL_SPEECH_ERROR',
	'LOCAL_SPEECH_UNAVAILABLE',
	'LOCAL_TTS_ERROR',
	'TTS_AUDIO_TOO_LONG',
	'TTS_AUTHENTICATION_FAILED',
	'TTS_MALFORMED_AUDIO',
	'TTS_PROVIDER_ERROR',
	'TTS_RATE_LIMITED',
	'TTS_TIMEOUT',
	'TTS_UNAVAILABLE',
]);

export class DynamicCoordinator extends EventEmitter {
	#registry;
	#taskViews;
	#observedMemory;
	#scheduler;
	#codexService;
	#planner;
	#bridge;
	#listeners = [];
	#providerListeners = [];
	#agentOperations = new Map();
	#agentOperationCounts = new Map();
	#totalAgentOperations = 0;
	#connectionOperationCap;
	#agentOperationCap;
	#providerWork = new Map();
	#pendingAttention = new Map();
	// Ordinary wakes held while the model's own action runs: the freshest held request, the first named reason, and the
	// deadline timer that releases them if the action outlasts the hold.
	#actionDeferredWakes = new Map();
	// While the model's own action runs: which wakes are absorbed into the next one, and what they carried.
	#wakeFilter = new WakeFilter();
	#attentionFlushes = new Map();
	#lifecycleGenerations = new Map();
	#providerRetryAfter = new Map();
	#providerProbeDeadlines = new Map();
	#deferredProviderRecovery = new Map();
	#programRuntimeEpochs = new Map();
	#nativeRuntimeEpochs = new Map();
	#nativeProgramLeases = new Map();
	#verboseReporters = new Set();
	#traceUsageSamples = new Map();
	#factLedgers = new Map();
	#conversationMemories = new Map();
	#contextCursors = new Map();
	#pendingConversationInboxes = new Map();
	#memoryDirectory;
	#nativeConversationRecoveries = new Map();
	#nativeObservationSignatures = new Map();
	// Per agent and goal revision: a pending situation assessment (goal start, death or respawn, another dimension). It is
	// cleared only once an event carrying the assessment instruction and the situation line is delivered.
	#eventContexts = new Map();
	// Per agent: what materially changed since the last delivered wake (dimension, death, time, biome, gear, ...).
	#situationChanges = new Map();
	#contextEntries = new Map();
	// Per agent: the running action as first observed (handle, health), so a wake can say what changed while it ran.
	#runningActions = new Map();
	// Per agent: the body's current lava or fire-block contact (a sequence number, when it began) and whether a mid-call
	// turn was already reissued for it.
	#hazardContacts = new Map();
	#survivalRestartAt = new Map();
	// Per agent: since when no observation has shown survival danger (see #trackSurvivalQuiet).
	#survivalQuietSince = new Map();
	#hazardContactSequence = 0;
	#perceptionSequences = new Map();
	#nativeWorldSignals = new Map();
	// Low-health wakes of agents with no task, one per health level (see lowHealthWake).
	#healWakes = new Map();
	// Low-health-with-food nudges of agents with a task (see healNudgeVerdict).
	#healNudges = new Map();
	#nativeConfirmationWaits = new Map();
	// Agents that started body work while their finished goal awaits confirmation: their follow-up wakes pass.
	#confirmationActivity = new Set();
	#confirmationWorkAuthority = new Map();
	// takeTask round trips awaiting Minecraft's task_request_result, keyed by requestId.
	#taskRequests = new Map();
	#taskRequestTimeoutMs;
	#supervisedObservationRequests = new Map();
	#conversationWakeTransactions = new Map();
	#directorRequests = new Set();
	#goalSpecRequests = new Map();
	#goalSpecRequestCap;
	#setGoalSpecTimeout;
	#clearGoalSpecTimeout;
	#programRuntime;
	#nativeRuntime;
	#inspections;
	#playerMemory;
	#memorySummaries = new Map();
	#receiptReconciliations = new Map();
	#latestActionDispatches = new Map();
	#goalSupervisor;
	#codexControlProtocol;
	#reconciliation = Promise.resolve();
	#started = false;
	#stopping = false;
	#closed = false;
	#stopPromise = null;
	#healthRegistry;
	#latencyRegistry;
	#controlNow;
	#epochNow;
	#setSteerTimeout;
	#setWakeHoldTimeout;
	#clearWakeHoldTimeout;
	#clearSteerTimeout;
	#disconnectedAt = null;
	#supportedAgentIds = new Set();
	#reconciledStatus = false;
	#setStatusInterval;
	#clearStatusInterval;
	#statusHandle = null;
	#serverInstanceId = null;
	#connectionEpoch = 0;
	#connected = false;
	#providerRecoveryPending = false;
	#traceWriter;
	#bodyPace;
	#providerTurnRecorder;
	#verboseEnabled = false;
	#runtimeGeneration;
	#verboseTransitions = new ReportingTransitionDeduper();
	#maxPendingAgentOperations;
	#maxPendingAgentTransactions;
	#runtimeHooks;
	#providerCliHealth;
	#providerCliNotices = { connectionEpoch: null, agents: new Set() };
	#providerCliStartupLogged = false;
	#providerDiscovery;
	#usageLedger;
	#lastCatalog = null;
	#lastRosterTraceAt = 0;

	constructor({ registry, scheduler, codexService, planner, bridge, healthRegistry, latencyRegistry, goalSupervisor, codexControlProtocol = 'native_tools', memoryDirectory = null, runtimeSessionId, traceWriter = null, providerTurnRecorder = null, bodyPace = null, runtimeGeneration = null, runtimeHooks = {}, benchmarkRecorder = null, providerCliHealth = null, providerDiscovery = null, controlNow = () => performance.now(), epochNow = Date.now, setStatusInterval = defaultStatusInterval, clearStatusInterval = clearInterval, setGoalSpecTimeout = defaultGoalSpecTimeout, clearGoalSpecTimeout = clearTimeout, setSteerTimeout = setTimeout, clearSteerTimeout = clearTimeout, setWakeHoldTimeout = defaultGoalSpecTimeout, clearWakeHoldTimeout = clearTimeout, reflexDefaults = DEFAULT_REFLEXES, taskRequestTimeoutMs = DEFAULT_TASK_REQUEST_TIMEOUT_MS, connectionOperationCap = DEFAULT_CONNECTION_OPERATION_CAP, agentOperationCap = DEFAULT_AGENT_OPERATION_CAP, goalSpecRequestCap = connectionOperationCap, maxPendingAgentOperations = DEFAULT_MAX_PENDING_AGENT_OPERATIONS, maxPendingAgentTransactions = DEFAULT_MAX_PENDING_AGENT_TRANSACTIONS }) {
		super();
		this.#memoryDirectory = memoryDirectory;
		if (providerCliHealth !== null && typeof providerCliHealth.check !== 'function') throw new TypeError('providerCliHealth.check must be a function');
		this.#providerCliHealth = providerCliHealth;
		this.#providerDiscovery = providerDiscovery ?? new ProviderDiscovery({ cliHealth: null });
		this.#usageLedger = new UsageLedger({ now: epochNow, onWarning: (warning) => this.#publishUsageWarning(warning) });
		this.#providerDiscovery.onChange((state) => this.#acceptDiscovery(state));
		this.#registry = requireDependency(registry, 'registry');
		this.#scheduler = requireDependency(scheduler, 'scheduler');
		this.#codexService = requireDependency(codexService, 'codexService');
		this.#planner = requireDependency(planner, 'planner');
		this.#bridge = requireDependency(bridge, 'bridge');
		this.#inspections = new InspectionClient({ send: (type, agentId, payload, options) => this.#sendForEpoch(options.connectionEpoch, type, agentId, payload) });
		this.#playerMemory = new RuntimeMemoryContext({ notebook: new ModelNotebook({ directory: memoryDirectory }), taskMemory: new TaskMemoryStore({ directory: memoryDirectory }), sessionId: runtimeSessionId,
			onReceipt: async (identity, receipt) => {
				const record = this.#registry.get(identity.agentId);
				if (record?.goalRevision === identity.goalRevision) {
					try { await this.#taskViews.actionReceipt(record, receipt); }
					catch (error) { this.#writeTrace('task_view_receipt_error', { code: error?.code ?? 'PLAN_VIEW_ERROR' }); }
				}
			} });
		// One observed memory serves the native tools and the plan's need options (remembered sightings and blocks).
		const occupancy = new ExplorationOccupancy({ memoryStore: new ObservedMemoryStore({ directory: memoryDirectory }) });
		this.#observedMemory = occupancy;
		this.#taskViews = new LiveTaskViews({ directory: memoryDirectory ? path.join(memoryDirectory, 'plans') : null,
			sources: (record, observation, blockPattern) => occupancy.knownSources(record.agentId, observation, blockPattern) });
		this.#healthRegistry = requireDependency(healthRegistry, 'healthRegistry');
		this.#latencyRegistry = requireDependency(latencyRegistry, 'latencyRegistry');
		this.#goalSupervisor = requireDependency(goalSupervisor, 'goalSupervisor');
		if (traceWriter !== null && typeof traceWriter.write !== 'function') throw new TypeError('traceWriter.write must be a function');
		this.#traceWriter = traceWriter;
		this.#bodyPace = bodyPace ?? new BodyPace({ now: epochNow });
		if (providerTurnRecorder !== null && typeof providerTurnRecorder.close !== 'function') throw new TypeError('providerTurnRecorder.close must be a function');
		this.#providerTurnRecorder = providerTurnRecorder;
		this.#runtimeGeneration = runtimeGeneration;
		if (runtimeHooks === null || typeof runtimeHooks !== 'object' || Array.isArray(runtimeHooks)) throw new TypeError('runtimeHooks must be an object');
		if (runtimeHooks.onRemoved !== undefined && typeof runtimeHooks.onRemoved !== 'function') throw new TypeError('runtimeHooks.onRemoved must be a function');
		this.#runtimeHooks = runtimeHooks;
		this.#connectionOperationCap = positiveInteger(connectionOperationCap, 'connectionOperationCap');
		this.#agentOperationCap = positiveInteger(agentOperationCap, 'agentOperationCap');
		this.#goalSpecRequestCap = positiveInteger(goalSpecRequestCap, 'goalSpecRequestCap');
		if (!['arena_script', 'native_tools'].includes(codexControlProtocol)) throw new TypeError('codexControlProtocol must be arena_script or native_tools');
		this.#codexControlProtocol = codexControlProtocol;
		if (typeof controlNow !== 'function') throw new TypeError('controlNow must be a function');
		if (typeof epochNow !== 'function') throw new TypeError('epochNow must be a function');
		if (!Number.isSafeInteger(maxPendingAgentOperations) || maxPendingAgentOperations < 1) throw new TypeError('maxPendingAgentOperations must be a positive safe integer');
		if (!Number.isSafeInteger(maxPendingAgentTransactions) || maxPendingAgentTransactions < 1) throw new TypeError('maxPendingAgentTransactions must be a positive safe integer');
		this.#controlNow = controlNow;
		this.#epochNow = epochNow;
		if (typeof setSteerTimeout !== 'function' || typeof clearSteerTimeout !== 'function') throw new TypeError('steer timer callbacks must be functions');
		this.#setSteerTimeout = setSteerTimeout;
		if (typeof setWakeHoldTimeout !== 'function' || typeof clearWakeHoldTimeout !== 'function') throw new TypeError('wake hold timer callbacks must be functions');
		this.#setWakeHoldTimeout = setWakeHoldTimeout;
		this.#clearWakeHoldTimeout = clearWakeHoldTimeout;
		this.#clearSteerTimeout = clearSteerTimeout;
		this.#maxPendingAgentOperations = maxPendingAgentOperations;
		this.#maxPendingAgentTransactions = maxPendingAgentTransactions;
		const programBridge = {
			send: (type, agentId, payload) => this.#sendRuntimeMessage('program', type, agentId, payload),
		};
		const nativeBridge = {
			send: (type, agentId, payload) => this.#sendRuntimeMessage('native', type, agentId, payload),
		};
		this.#programRuntime = new ProgramRuntimeManager({
			sessionId: runtimeSessionId,
			memoryOperation: (record, operation) => this.#playerMemory.execute(record, operation),
			inspectObservation: async (record, query, authority = {}) => ({ state: 'SUCCEEDED', reasonCode: 'INSPECTED', ...await this.#inspections.request(record, query, { ...authority, connectionEpoch: this.#connectionEpoch }) }),
			registry: this.#registry,
			bridge: programBridge,
			planner: this.#planner,
			reportError: (agentId, error) => this.#reportAgentError(agentId, error, this.#programRuntimeEpochs.get(agentId)),
			requestRecovery: ({ record, reason, errorCode, recoveryKind, nextProbeAtEpochMs }) => {
				const connectionEpoch = this.#programRuntimeEpochs.get(record.agentId);
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return false;
				const current = this.#registry.get(record.agentId);
				if (current === null || current.goalRevision !== record.goalRevision) return false;
				const key = this.#supervisionKey(current);
				this.#goalSupervisor.activate(key);
				const details = this.#recoveryDetails(record.agentId, { errorCode, recoveryKind, nextProbeAtEpochMs });
				return this.#goalSupervisor.recover(key, { reason, ...details });
			},
			onCompletionRequested: (request) => this.#publishGoalCompleted(request, this.#programRuntimeEpochs.get(request.record.agentId)),
			latencyRegistry: this.#latencyRegistry,
			trace: (event, fields) => this.#writeTrace(event, fields),
			plannerContext: (agentId) => this.#plannerContext(agentId),
			onContextAccepted: (record, receipt) => this.#rememberAcceptedContextCursor(record, receipt),
			clock: () => this.#controlNow(),
			benchmarkRecorder,
		});
		this.#nativeRuntime = new NativeToolRuntime({
			// The game's rule book arms the default survival rules (ruling 16); a bare runtime has the model's rules only.
			reflexBook: new ReflexBook({ defaults: reflexDefaults }),
			taskPlan: (record, tool) => this.#taskViews.operate(record, tool),
			knownStations: (record) => this.#taskViews.placedStations(record),
			planNeeds: (record) => this.#taskViews.openNeeds(record),
			planVocabulary: (record, worldId) => this.#taskViews.activeResourceVocabulary(record, worldId),
			sessionId: runtimeSessionId,
			requestObservation: async (record) => {
				const result = await this.#inspections.request(record, { section: 'observation' }, { connectionEpoch: this.#connectionEpoch });
				const observation = adaptObservation(result.observation);
				await this.#taskViews.observe(record, observation, result.observation);
				return { ...result, observation };
			},
			inspectObservation: async (record, query, authority = {}) => {
				const result = await this.#inspections.request(record, query, { ...authority, connectionEpoch: this.#connectionEpoch });
				if (query.section === 'survey') {
					const latest = this.#nativeRuntime.latestObservation(record)?.observation;
					if (latest && result.worldId === latest.world?.worldId && result.dimension === latest.world?.dimension) await this.#taskViews.observe(record, { ...latest, survey: result.survey, continuity: { rememberedSections: ['blocks', 'landmarks', 'nearbyContainers', 'interaction', 'inventory'] } });
				}
				return result;
			},
			// Coordinator ingress owns authoritative terminal persistence/retries.
			// Avoid the runtime's best-effort duplicate write ahead of live delivery;
			// dispatch and unknown-receipt durability still use the real notebook.
			notebook: {
				...Object.fromEntries(['writeNote', 'query', 'listUnresolved', 'recordDispatch', 'recordUnknown', 'findReceipt'].map((method) => [method, this.#playerMemory.notebook[method].bind(this.#playerMemory.notebook)])),
				recordReceipt: async () => {},
			},
			memoryOperation: (record, operation) => this.#playerMemory.execute(record, operation),
			taskContext: (record) => this.#playerMemory.taskContext(record),
			memoryObservation: (record, observation, options) => {
				// This callback sees only accepted snapshots, including quiet heartbeats and requested samples.
				this.#trackRunningAction(record.agentId, observation);
				return this.#playerMemory.observe(record, observation, options);
			},
			executionSettings: (record) => this.#planner.getExecutionSettings?.(record.agentId) ?? null,
			// Preparation needs the whole response-to-request path (adapter delivery included), as one sample series.
			planningLeadTime: (record) => {
				const timing = this.#planner.getNativeDecisionTiming?.(record.agentId);
				return timing?.responseGapP95Ms ?? timing?.p95Ms ?? null;
			},
			onModelActionCancelled: (record) => this.#releaseHeldWakeForCancelledAction(record),
			occupancy,
			bridge: nativeBridge,
			registry: this.#registry,
			trace: (event, fields) => this.#writeTrace(event, fields),
			onFinish: async ({ record, result, lifecycleGeneration }) => {
				const connectionEpoch = this.#nativeRuntimeEpochs.get(record.agentId);
				if (this.#stopping || this.#closed || !this.#isConnectionEpochCurrent(connectionEpoch)) return;
				const current = this.#registry.get(record.agentId);
				if (current === null || current.goalRevision !== record.goalRevision
					|| !this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)) return;
				if (result.state === 'COMPLETED') {
					this.#goalSupervisor.terminate(this.#supervisionKey(current, lifecycleGeneration));
					this.#registry.setState(record.agentId, DynamicAgentState.COMPLETED, { goalRevision: record.goalRevision });
				}
			},
			onWorkStarted: (record, kind, options) => {
				const key = this.#supervisionKey(record);
				this.#goalSupervisor.activate(key);
				const token = this.#goalSupervisor.begin(key, kind, options);
				const programLease = kind === 'program' ? { token, programId: options.programId } : null;
				if (programLease !== null) this.#nativeProgramLeases.set(record.agentId, programLease);
				let released = false;
				const release = () => {
					if (released) return;
					released = true;
					if (this.#nativeProgramLeases.get(record.agentId) === programLease) this.#nativeProgramLeases.delete(record.agentId);
					this.#goalSupervisor.end(token);
				};
				// Time a reflex held the body moves the lease out with the program's own deadline.
				release.extend = (ms) => !released && this.#goalSupervisor.extend?.(token, ms);
				return release;
			},
			onProgramEvent: (record, event) => {
				// Already-authorized successor work owns the body; no planner wake is needed.
				if (event.event === 'program_handoff_started') {
					this.#writeTrace('native_program_handoff_started', { agentId: record.agentId, goalRevision: record.goalRevision,
						programId: event.programId, predecessorProgramId: event.predecessorProgramId, queueId: event.queueId,
						...(event.predecessorActionsFailed > 0 ? { predecessorActionsFailed: event.predecessorActionsFailed } : {}) });
					return;
				}
				const connectionEpoch = this.#nativeRuntimeEpochs.get(record.agentId);
				const lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
				const current = this.#registry.get(record.agentId);
				if (this.#stopping || this.#closed || !this.#isConnectionEpochCurrent(connectionEpoch)
					|| current?.goalRevision !== record.goalRevision || ![DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(current.state)) return;
				this.#scheduleNativeTurn(current, { agentId: current.agentId, goalRevision: current.goalRevision,
					observation: event.observation, eventSequence: event.eventSequence, preserveState: true,
					priority: event.priority ?? event.status?.decision?.priority ?? 'ordinary', trigger: event.status?.decision?.trigger ?? event.event,
					connectionEpoch, lifecycleGeneration, nativeEvent: event });
			},
		});
		this.#setStatusInterval = requireDependency(setStatusInterval, 'setStatusInterval');
		this.#clearStatusInterval = requireDependency(clearStatusInterval, 'clearStatusInterval');
		this.#setGoalSpecTimeout = requireDependency(setGoalSpecTimeout, 'setGoalSpecTimeout');
		this.#clearGoalSpecTimeout = requireDependency(clearGoalSpecTimeout, 'clearGoalSpecTimeout');
		this.#taskRequestTimeoutMs = taskRequestTimeoutMs;
	}

	get registry() { return this.#registry; }
	get bridge() { return this.#bridge; }

	/**
	 * With the compact heard section present, a perception change made only of new raw sound packets is
	 * already summarised there (and heard lava raises its own "heard" fact), so it is not attention by itself.
	 */
	#withoutSoundOnlyAttention(agentId, payload, wireObservation) {
		const perception = wireObservation?.perception;
		const latest = Number.isSafeInteger(perception?.latestSequence) ? perception.latestSequence : null;
		const previous = this.#perceptionSequences.get(agentId);
		if (latest !== null) this.#perceptionSequences.set(agentId, latest);
		const agentNames = this.#registry.list().map((record) => record.name);
		return routinePerceptionChange(payload, wireObservation, previous, this.#registry.get(agentId)?.name, agentNames) ? { ...payload, attention: false, changedFacts: [] } : payload;
	}

	/**
	 * A sighting wake whose new rows show only what the agent placed itself (its crafting table, furnace and cobblestone
	 * read as a built cluster) is no news: the fact is dropped, and the attention with it when nothing else changed.
	 */
	#withoutOwnSightings(agentId, payload, wireObservation) {
		if (!Array.isArray(payload?.changedFacts) || !payload.changedFacts.includes('sighted')) return payload;
		let placed;
		try { placed = this.#observedMemory.ownPlacements(agentId, wireObservation); } catch { return payload; }
		return withoutOwnSightings(payload, wireObservation, placed);
	}

	requestSupervisedObservation(key) {
		if (this.#stopping || this.#closed || key === null || typeof key !== 'object') return false;
		const record = this.#registry.get(key.agentId);
		if (record === null || record.goalRevision !== key.goalRevision
			|| !this.#isConnectionEpochCurrent(key.sessionEpoch)
			|| !this.#isLifecycleGenerationCurrent(key.agentId, key.lifecycleGeneration)
			|| key.profileFingerprint !== profileFingerprint(record)) return false;
		// DEAD snapshots are not admitted by the ordinary observation handler.
		// Rebuild the death request from current facts instead of requesting a sample
		// that cannot consume recovery. The lease supplies the retry backoff.
		if (this.#usesNativeTools(record) && record.state === DynamicAgentState.DEAD) {
			return this.#installDeadStatePlan(record, record.death, key.sessionEpoch);
		}
		const conversationRecovery = this.#nativeConversationRecoveries.get(key.agentId);
		if (conversationRecovery !== undefined && sameSupervisionKey(conversationRecovery.supervisionKey, key)) {
			this.#nativeConversationRecoveries.delete(key.agentId);
			this.#scheduleNativeTurn(record, conversationRecovery.request);
			return true;
		}
		if (this.#usesNativeTools(record)) {
			this.#supervisedObservationRequests.set(key.agentId, {
				goalRevision: key.goalRevision,
				lifecycleGeneration: key.lifecycleGeneration,
				connectionEpoch: key.sessionEpoch,
			});
		}
		return this.#bridge.send('request_observation', key.agentId, { goalRevision: key.goalRevision });
	}

	handleLeaseExpired({ key, lease }) {
		if (this.#stopping || this.#closed || !this.#isLifecycleGenerationCurrent(key.agentId, key.lifecycleGeneration)) return;
		const connectionEpoch = this.#connectionEpoch;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
		const record = this.#registry.get(key.agentId);
		if (record === null || record.goalRevision !== key.goalRevision) return;
		if (key.sessionEpoch !== connectionEpoch || key.profileFingerprint !== profileFingerprint(record)) return;
		this.#writeTrace('work_lease_expired', { ...key, kind: lease.kind, operationId: lease.operationId });
		this.#publishVerbose(key.agentId, key.goalRevision, 'retry', `${lease.kind} work timed out; recovering automatically.`);
		if (lease.kind === 'program') {
			const owned = this.#nativeProgramLeases.get(key.agentId);
			if (owned?.token.operationId === lease.operationId) {
				// The executor deadline and outer lease can fire in either order.
				// Settle only this program, retaining its physical cancellation fence.
				void this.#nativeRuntime.expireProgram(record, owned.programId)
					.catch((error) => this.#reportAgentError(key.agentId, error, connectionEpoch));
			}
			return;
		}
		let preserveProgram = false;
		if (lease.kind === 'provider') {
			const work = this.#providerWork.get(key.agentId);
			if (work?.kind === 'native' && work.goalRevision === key.goalRevision
				&& work.lifecycleGeneration === key.lifecycleGeneration
				&& work.supervisionToken?.operationId === lease.operationId) {
				preserveProgram = this.#preparationHasRunningProgram(work, record);
				work.expired = true;
				this.#restoreNativeConversation(work.steerRequest);
				this.#restoreNativeConversation(work.request);
				if (work.request.conversationOnly === true) {
					this.#nativeConversationRecoveries.set(work.agentId, {
						supervisionKey: work.supervisionKey,
						request: work.request,
					});
				}
				this.#providerWork.delete(key.agentId);
			}
			try {
				void Promise.resolve(this.#planner.interrupt(key.agentId, 'Provider work lease expired'))
					.catch((error) => this.#reportAgentError(key.agentId, error, connectionEpoch));
			} catch (error) {
				void this.#reportAgentError(key.agentId, error, connectionEpoch);
			}
		}
		if (['provider', 'action', 'completion'].includes(lease.kind) && !preserveProgram) {
			this.#nativeObservationSignatures.delete(key.agentId);
			void this.#nativeRuntime.dispose(key.agentId, `${lease.kind}_lease_expired`)
				.catch((error) => this.#reportAgentError(key.agentId, error, connectionEpoch));
		}
	}

	handleGoalStuck({ key, inactiveMs, history }) {
		if (this.#stopping || this.#closed || !this.#isLifecycleGenerationCurrent(key.agentId, key.lifecycleGeneration)) return;
		const record = this.#registry.get(key.agentId);
		if (record === null || record.goalRevision !== key.goalRevision) return;
		if (key.sessionEpoch !== this.#connectionEpoch || key.profileFingerprint !== profileFingerprint(record)) return;
		this.#rememberPendingAttention(key.agentId, key.goalRevision, { priority: 'urgent', trigger: 'stuck' });
		this.#writeTrace('goal_factual_progress_stuck', { ...key, inactiveMs, positionSamples: history.length });
		this.#publishVerbose(key.agentId, key.goalRevision, 'retry', 'No factual world progress for 30 seconds; reassessing without pausing the goal.');
	}

	async start() {
		if (this.#started) return;
		if (this.#closed) throw new Error('Dynamic coordinator cannot restart after it has been stopped');
		this.#stopping = false;
		try {
			this.#bindBridge();
			this.#bridge.start();
			this.#statusHandle = this.#setStatusInterval(() => {
				const connectionEpoch = this.#connectionEpoch;
				this.#requestProviderRecovery(connectionEpoch);
				this.#run(() => this.#publishStatus(connectionEpoch), connectionEpoch);
			}, 1_000);
			this.#started = true;
		} catch (error) {
			if (this.#statusHandle !== null) this.#clearStatusInterval(this.#statusHandle);
			this.#statusHandle = null;
			this.#bridge.stop();
			this.#unbindBridge();
			await this.#codexService.stop();
			throw error;
		}
	}

	stop() {
		if (this.#stopPromise !== null) return this.#stopPromise;
		this.#stopPromise = this.#stopOnce();
		return this.#stopPromise;
	}

	async #stopOnce() {
		if (this.#closed) return;
		this.#stopping = true;
		const receipts = [...this.#receiptReconciliations.values()];
		for (const receipt of receipts) { clearTimeout(receipt.retry); receipt.resolve(); }
		this.#inspections.cancel();
		this.#connected = false;
		this.#setVerboseEnabled(false);
		if (this.#statusHandle !== null) this.#clearStatusInterval(this.#statusHandle);
		this.#statusHandle = null;
		this.#bridge.stop();
		this.#unbindBridge();
		this.#scheduler.close('Dynamic coordinator stopped');
		this.#goalSupervisor.close();
		await Promise.allSettled([this.#reconciliation, ...[...this.#agentOperations.values()].map((queue) => queue.drainPromise)]);
		await Promise.all([...this.#pendingConversationInboxes.values()].map((inbox) => inbox.close().catch((error) => this.#emitRuntimeError(error))));
		this.#pendingConversationInboxes.clear();
		this.#agentOperations.clear();
		this.#agentOperationCounts.clear();
		this.#totalAgentOperations = 0;
		this.#providerWork.clear();
		this.#pendingAttention.clear();
		this.#dropAllDeferredWakes();
		this.#attentionFlushes.clear();
		this.#lifecycleGenerations.clear();
		this.#programRuntime.disposeAll();
		// Release native waiters immediately, independently of stalled terminal I/O.
		const nativeDisposal = this.#nativeRuntime.disposeAll();
		const closeMemory = async () => {
			await Promise.all([Promise.allSettled(receipts.map((receipt) => receipt.pending)), nativeDisposal]);
			await this.#playerMemory.markUnknown(undefined, 'COORDINATOR_STOPPED');
			await this.#playerMemory.flush();
		};
		// A stuck receipt write cannot hold shutdown forever. Unacknowledged
		// terminals remain in the server journal for replay on the next session.
		let receiptShutdownTimer;
		await Promise.race([
			closeMemory().catch((error) => this.#emitRuntimeError(error)),
			...(receipts.length === 0 ? [] : [new Promise((resolve) => {
				receiptShutdownTimer = setTimeout(() => {
					this.#emitRuntimeError(codedRuntimeError('RECEIPT_SHUTDOWN_PENDING', 'Receipt storage has not settled; server results remain unacknowledged for replay'));
					resolve();
				}, 1_000);
			})]),
		]);
		clearTimeout(receiptShutdownTimer);
		this.#receiptReconciliations.clear();
		this.#latestActionDispatches.clear();
		for (const receipt of receipts) receipt.resolve();
		await this.#taskViews.flush().catch((error) => this.#emitRuntimeError(error));
		this.#traceUsageSamples.clear();
		this.#providerDiscovery.stop();
		this.#memorySummaries.clear();
		this.#providerRetryAfter.clear();
		this.#providerProbeDeadlines.clear();
		this.#deferredProviderRecovery.clear();
		this.#programRuntimeEpochs.clear();
		this.#nativeRuntimeEpochs.clear();
		this.#factLedgers.clear();
		this.#conversationMemories.clear();
		this.#contextCursors.clear();
		this.#nativeConversationRecoveries.clear();
		this.#nativeObservationSignatures.clear();
		this.#hazardContacts.clear();
		this.#survivalRestartAt.clear();
		this.#survivalQuietSince.clear();
		this.#nativeWorldSignals.clear();
		this.#nativeConfirmationWaits.clear();
		this.#supervisedObservationRequests.clear();
		this.#conversationWakeTransactions.clear();
		this.#settleTaskRequests(undefined, 'COORDINATOR_STOPPING', 'The coordinator is stopping.');
		this.#cancelGoalSpecRequests();
		// Provider stop settles final turn capture before either diagnostic sink closes.
		await this.#codexService.stop();
		if (this.#providerTurnRecorder !== null) {
			await this.#scheduler.drain?.();
			await this.#providerTurnRecorder.close();
		}
		if (this.#traceWriter !== null && typeof this.#traceWriter.close === 'function') await this.#traceWriter.close();
		this.#started = false;
		this.#stopping = false;
		this.#closed = true;
	}

	#bindBridge() {
		this.#listen('inspection_result', (message) => { this.#inspections.accept(message); });
		this.#bindProviderRecovery();
		this.#listen('ready', (connection) => {
			const connectionEpoch = this.#acceptReadyEpoch(connection);
			if (connectionEpoch === null) return;
			const { serverInstanceId, registry } = connection;
			this.#setVerboseEnabled(false);
			if (this.#serverInstanceId !== null && serverInstanceId !== this.#serverInstanceId) {
				this.#invalidateServerInstance(connectionEpoch);
			}
			this.#serverInstanceId = serverInstanceId;
			this.#logProviderCliHealthAtStartup();
			this.#reconciledStatus = false;
			this.#supportedAgentIds.clear();
			this.#beginReconciliation(registry, connectionEpoch);
		}, { lifecycle: true });
		this.#listen('verbose_control', (message) => {
			this.#setVerboseEnabled(message.payload.enabled);
		});
		this.#listen('catalog_request', (_message, connectionEpoch) => this.#run(async () => {
			await this.#reconciliation;
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			// A player's Rescan: re-run discovery (CLIs, accounts) and every provider's model list.
			await this.#providerDiscovery.refresh({ force: true }).catch(() => {});
			const catalog = await this.#codexService.catalog.refresh({ force: true });
			await this.#publishCatalog(catalog, connectionEpoch);
		}, connectionEpoch));
		this.#listen('agent_registered', (message, connectionEpoch) => this.#enqueueAgent(message.agentId, async () => {
			const previous = this.#registry.get(message.agentId);
			const record = this.#registry.register(message.payload.record === undefined
				? { ...message.payload, agentId: message.agentId }
				: { ...message.payload.record, agentId: message.agentId });
			this.#codexService.catalog.assertSupported(record.provider, record.model, record.reasoningEffort, record.serviceTier ?? defaultServiceTier(record.provider));
			const replacesDeath = previous?.state === DynamicAgentState.DEAD && record.state === DynamicAgentState.DEAD
				&& record.goalRevision > previous.goalRevision;
			let lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
			const isCurrent = () => this.#isConnectionEpochCurrent(connectionEpoch)
				&& this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)
				&& this.#registry.get(record.agentId)?.goalRevision === record.goalRevision;
			if (replacesDeath) {
				this.#cancelGoalSpecRequests(record.agentId);
				this.#retireGoalSupervision(previous, 'replace');
				this.#invalidateAcceptedLifecycle(record.agentId);
				lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
				this.#beginGoalControlInterruption({ agentId: record.agentId, payload: { operation: 'steer' } }, connectionEpoch);
				this.#programRuntime.onGoalControl(previous, 'steer');
				await this.#nativeRuntime.dispose(record.agentId, 'dead_registration_replaced');
				if (!isCurrent()) return;
			}
			await this.#sendForEpoch(connectionEpoch, 'agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
			if (!isCurrent()) return;
			this.#supportedAgentIds.add(record.agentId);
			this.#usageLedger.registerAgent(record);
			this.#publishVerbose(record.agentId, record.goalRevision, 'lifecycle', 'Agent registered and ready.', connectionEpoch);
			this.#prewarmNativeAgent(record);
			this.#checkProviderCli(record, connectionEpoch);
			if (replacesDeath) {
				const recovery = this.#installDeadStatePlan(record, record.death, connectionEpoch);
				if (this.#usesNativeTools(record)) void recovery.catch((error) => this.#reportAgentError(record.agentId, error, connectionEpoch));
				else await recovery;
			}
			await this.#publishStatus(connectionEpoch);
		}, { connectionEpoch, transactional: true }));
		this.#listen('agent_removed', (message, connectionEpoch) => this.#run(async () => {
			await this.#reconciliation;
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#publishVerbose(message.agentId, message.payload.goalRevision, 'lifecycle', 'Agent removed from the coordinator roster.', connectionEpoch);
			// Removal also owns persisted mailboxes not yet opened after restart.
			const inbox = this.#pendingConversationInbox(message.agentId);
			inbox.fence();
			const current = this.#registry.get(message.agentId);
			if (current !== null) this.#goalSupervisor.terminate(this.#supervisionKey(current));
			this.#programRuntime.dispose(message.agentId);
			await this.#nativeRuntime.dispose(message.agentId, 'agent_removed');
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#traceUsageSamples.delete(message.agentId);
			this.#usageLedger.removeAgent(message.agentId);
			this.#providerWork.delete(message.agentId);
			this.#verboseTransitions.clear(message.agentId);
			this.#programRuntimeEpochs.delete(message.agentId);
			this.#nativeRuntimeEpochs.delete(message.agentId);
			this.#pendingAttention.delete(message.agentId);
			this.#dropDeferredWake(message.agentId);
			this.#attentionFlushes.delete(message.agentId);
			await this.#planner.remove(message.agentId);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#lifecycleGenerations.delete(message.agentId);
			this.#providerRetryAfter.delete(message.agentId);
			this.#providerProbeDeadlines.delete(message.agentId);
			this.#deferredProviderRecovery.delete(message.agentId);
			this.#factLedgers.delete(message.agentId);
			this.#memorySummaries.delete(message.agentId);
			this.#playerMemory.forget(message.agentId);
			this.#conversationMemories.delete(message.agentId);
			this.#contextCursors.delete(message.agentId);
			await inbox.remove(() => this.#isConnectionEpochCurrent(connectionEpoch));
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#nativeConversationRecoveries.delete(message.agentId);
			this.#nativeObservationSignatures.delete(message.agentId);
			this.#hazardContacts.delete(message.agentId);
			this.#survivalQuietSince.delete(message.agentId);
			this.#nativeWorldSignals.delete(message.agentId);
			this.#eventContexts.delete(message.agentId);
			this.#situationChanges.delete(message.agentId);
			this.#contextEntries.delete(message.agentId);
			this.#runningActions.delete(message.agentId);
			this.#healNudges.delete(message.agentId);
			this.#nativeConfirmationWaits.delete(message.agentId);
			this.#confirmationActivity.delete(message.agentId);
			this.#supervisedObservationRequests.delete(message.agentId);
			this.#settleTaskRequests(message.agentId, 'AGENT_REMOVED', 'This agent was removed.');
			this.#forgetConversationWakes(message.agentId);
			this.#cancelGoalSpecRequests(message.agentId);
			this.#supportedAgentIds.delete(message.agentId);
			try {
				void Promise.resolve(this.#runtimeHooks.onRemoved?.(message.agentId)).catch((error) => this.#emitRuntimeError(error));
			} catch (error) { this.#emitRuntimeError(error); }
			await this.#publishStatus(connectionEpoch);
		}, connectionEpoch));
        this.#listen('director_script_request', (message, connectionEpoch) => {
            const request=message.payload;
            if(this.#directorRequests.has(request.requestId)) return;
            this.#run(async () => {
                let script='', error='';
                if(this.#directorRequests.has(request.requestId)) return;
                if(this.#directorRequests.size>=4) error='Luna is busy. Try again shortly.';
                else {
                    this.#directorRequests.add(request.requestId);
                    try {
                        const value=await this.#scheduler.schedule(`director-${request.requestId}`, ({signal})=>generateDirectorScript(this.#codexService,request,{signal}), {lane:'codex',priority:'ordinary',capacityClass:'auxiliary'});
                        script=JSON.stringify(value);
                    } catch(failure) { error=('Luna could not generate this script: '+(failure.message??'Unknown error')).slice(0,400); }
                    finally { this.#directorRequests.delete(request.requestId); }
                }
                if(this.#isConnectionEpochCurrent(connectionEpoch)) await this.#sendForEpoch(connectionEpoch,'director_script_result','server',{requestId:request.requestId,script,error});
            },connectionEpoch);
        });
		this.#listen('goal_spec_request', (message, connectionEpoch) => {
			const key = this.#goalSpecRequestKey(message.agentId, message.payload.requestId);
			const { playerState, ...intent } = message.payload;
			const fingerprint = JSON.stringify(intent);
			const existing = this.#goalSpecRequests.get(key);
			if (existing !== undefined) {
				if (existing.fingerprint !== fingerprint) {
					this.#emitRuntimeError(new ProtocolV2Error('TRANSACTION_COLLISION', `Goal translation request '${message.payload.requestId}' changed during replay`));
					return;
				}
				if (existing.proposal !== null) {
					void this.#sendForEpoch(connectionEpoch, 'goal_spec_proposal', message.agentId, existing.proposal).catch((error) => this.#emitRuntimeError(error));
				}
				return existing.completion;
			}
			if (this.#goalSpecRequests.size >= this.#goalSpecRequestCap) {
				throw new ProtocolV2Error('GOAL_SPEC_REQUEST_BACKPRESSURE', 'Coordinator goal translation request capacity is full');
			}
			const releaseCapacity = this.#reserveAgentOperation(message.agentId);
			let resolveCompletion;
			const completion = new Promise((resolve) => { resolveCompletion = resolve; });
			const entry = {
				agentId: message.agentId, requestId: message.payload.requestId, request: message.payload,
				fingerprint, proposal: null, attempts: 0, rejectionAttempts: 0, correctiveFeedback: null, serverRejected: false,
				translating: false, retryHandle: null, connectionEpoch, completion, resolveCompletion, releaseCapacity,
			};
			this.#goalSpecRequests.set(key, entry);
			const initialProcessing = this.#run(() => this.#processGoalSpecRequest(key, entry), connectionEpoch);
			return Promise.all([initialProcessing, completion]);
		});
		this.#listen('goal_spec_result', (message, connectionEpoch) => {
			const key = this.#goalSpecRequestKey(message.agentId, message.payload.requestId);
			const existing = this.#goalSpecRequests.get(key);
			if (existing === undefined || existing.proposal === null) return;
			if (message.payload.status === 'accepted' || TERMINAL_GOAL_SPEC_REJECTIONS.has(message.payload.reasonCode)) {
				this.#forgetGoalSpecRequest(key, existing);
				return;
			}
			if (existing.retryHandle !== null) {
				this.#clearGoalSpecTimeout(existing.retryHandle);
				existing.retryHandle = null;
			}
			existing.rejectionAttempts += 1;
			existing.serverRejected = true;
			existing.correctiveFeedback = {
				attempt: existing.rejectionAttempts,
				reasonCode: message.payload.reasonCode,
				rejectedProposal: existing.proposal,
			};
			existing.proposal = null;
			try { this.#planner.cancelGoalSpec?.(message.agentId, message.payload.requestId); } catch { /* completed translation cleanup is best effort */ }
			if (existing.rejectionAttempts <= MAX_GOAL_SPEC_CORRECTION_ATTEMPTS) {
				const delay = Math.min(GOAL_SPEC_RETRY_MAX_MS, GOAL_SPEC_RETRY_BASE_MS * (2 ** (existing.rejectionAttempts - 1)));
				this.#scheduleGoalSpecRequest(key, existing, delay);
				return;
			}
			this.#forgetGoalSpecRequest(key, existing);
			void this.#reportAgentError(message.agentId, codedRuntimeError(
				'GOAL_SPEC_TRANSLATION_REJECTED',
				`Minecraft rejected ${MAX_GOAL_SPEC_CORRECTION_ATTEMPTS + 1} goal translation proposals; the pending draft requires operator correction or cancellation`,
			), connectionEpoch);
		});
		this.#listen('task_view_request', (message, connectionEpoch) => {
			const record = this.#registry.get(message.agentId);
			if (record === null || record.goalRevision !== message.payload.goalRevision) return;
			return this.#sendForEpoch(connectionEpoch, 'task_view', record.agentId, this.#taskViewWithRoster(record));
		});
		this.#listen('goal_control', (message, connectionEpoch) => {
			let record;
			let nativeDisposal = Promise.resolve();
			let lifecycleGeneration;
			return this.#enqueueAgent(message.agentId, async () => {
				await nativeDisposal;
				const acceptedStillCurrent = () => {
					const current = this.#registry.get(message.agentId);
					return this.#isConnectionEpochCurrent(connectionEpoch)
						&& current !== null && current.goalRevision === record.goalRevision
						&& this.#isLifecycleGenerationCurrent(message.agentId, lifecycleGeneration);
				};
				if (!acceptedStillCurrent()) return;
				this.#publishVerbose(record.agentId, record.goalRevision, 'lifecycle', `Goal lifecycle operation '${message.payload.operation}' accepted.`, connectionEpoch);
				if (!['queue', 'dequeue'].includes(message.payload.operation)) {
					this.#providerRetryAfter.delete(message.agentId);
				}
				if (message.payload.operation === 'dead') {
					void this.#installDeadStatePlan(record, message.payload.death, connectionEpoch).catch((error) => this.#reportAgentError(record.agentId, error, connectionEpoch));
				}
				const resumesGoal = ['start', 'replace', 'resume', 'steer'].includes(message.payload.operation)
					|| message.payload.operation === 'respawn' && record.state === DynamicAgentState.STARTING;
				const activatesQueuedGoal = message.payload.operation === 'complete' && record.state === DynamicAgentState.STARTING;
				if (resumesGoal || activatesQueuedGoal) {
					this.#goalSupervisor.activate(this.#supervisionKey(record));
				}
				if (resumesGoal) {
					this.#rememberPendingAttention(record.agentId, record.goalRevision, {
						priority: message.payload.operation === 'steer' ? 'urgent' : 'ordinary',
						trigger: message.payload.operation,
					});
				}
				if (resumesGoal) {
					await this.#sendForEpoch(connectionEpoch, 'agent_ready', record.agentId, { goalRevision: record.goalRevision });
				}
				if (!acceptedStillCurrent()) return;
				if (message.payload.operation === 'complete' && record.state === DynamicAgentState.COMPLETED) {
					await this.#resumeUnreadNativeConversation(record, connectionEpoch, lifecycleGeneration);
					if (!acceptedStillCurrent()) return;
				}
				this.emit('goalControl', record);
			}, {
				connectionEpoch,
				transactional: true,
				onAdmitted: () => {
					const previous = this.#registry.get(message.agentId);
					record = this.#registry.applyGoalControl(message.agentId, message.payload);
					if (['start','replace','steer'].includes(message.payload.operation)) this.#taskViews.begin(record, { fresh: ['start','replace'].includes(message.payload.operation) });
					// The death screen's respawn target is where the next body appears: the plan's spawn:bed fact.
					if (message.payload.operation === 'dead') void this.#taskViews.observe(record, { ready: false, player: { dead: true }, ...(message.payload.death ? { death: message.payload.death } : {}) }).catch(() => {});
					const lifecycleChanged = previous !== null && !['queue', 'dequeue'].includes(message.payload.operation)
						&& (record.goalRevision > previous.goalRevision
							|| (record.goalRevision === previous.goalRevision && ['dead', 'respawn'].includes(message.payload.operation)));
					if (lifecycleChanged) {
						this.#cancelGoalSpecRequests(message.agentId);
						this.#retireGoalSupervision(previous, message.payload.operation);
						this.#invalidateAcceptedLifecycle(message.agentId);
						if (['dead', 'respawn'].includes(message.payload.operation)) {
							// Admission must retain this need even if task-memory loading or a later control cancels the input.
							const context = this.#assessmentContext(record);
							context.pending = ++context.generation;
						}
						this.#beginGoalControlInterruption(message, connectionEpoch);
						this.#programRuntime.onGoalControl(previous, message.payload.operation);
						nativeDisposal = Promise.resolve(this.#nativeRuntime.dispose(previous.agentId, `goal_${message.payload.operation}`));
					}
					lifecycleGeneration = this.#lifecycleGeneration(message.agentId);
				},
			});
		});
		this.#listen('conversation_event', (message, connectionEpoch) => {
			return this.#enqueueAgent(message.agentId, async () => {
				this.#publishVerbose(message.agentId, message.payload.goalRevision, 'conversation', `Conversation event '${message.payload.kind}' received from '${message.payload.sourceId}'.`, connectionEpoch);
				const ingested = await this.#admitConversation(message.agentId, message.payload, connectionEpoch);
				const record = this.#registry.get(message.agentId);
				// Recipient-side evidence for harnesses: this runtime accepted the message (and whether it wakes the agent).
				if (ingested && record !== null) {
					this.emit('conversationAdmitted', { agentId: record.agentId, goalRevision: record.goalRevision, sequence: message.payload.sequence,
						sourceId: message.payload.sourceId, wakes: conversationWakes(message.payload) });
				}
				// Context-only chat stays unread in the inbox and rides the next wake.
				if (ingested && record !== null && conversationWakes(message.payload)) {
					this.#rememberPendingAttention(record.agentId, record.goalRevision, { priority: 'urgent', trigger: 'conversation' });
					if (this.#usesNativeTools(record)) this.#scheduleNativeConversation(record, message.payload, 'conversation');
					else {
						if ([DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING, DynamicAgentState.DEAD].includes(record.state)) {
							this.#goalSupervisor.activate(this.#supervisionKey(record));
						}
						this.#schedulePendingAttentionFlush(record);
					}
				}
				this.emit('conversationEvent', message);
			}, { waitForReconciliation: false, connectionEpoch, transactional: true });
		});
		this.#listen('conversation_wake', (message, connectionEpoch) => {
			return this.#enqueueAgent(message.agentId, async () => {
				this.#publishVerbose(message.agentId, message.payload.event.goalRevision, 'conversation', `Conversation wake '${message.payload.event.kind}' received.`, connectionEpoch);
				const fingerprint = JSON.stringify({ agentId: message.agentId, event: message.payload.event, control: message.payload.control });
				const existing = this.#conversationWakeTransactions.get(message.payload.transactionId);
				if (existing !== undefined) {
					if (existing.fingerprint !== fingerprint) {
						throw new ProtocolV2Error('TRANSACTION_COLLISION', `Conversation wake '${message.payload.transactionId}' changed during replay`);
					}
					const record = this.#registry.applyConversationWake(message.agentId, message.payload.control);
					this.#goalSupervisor.activate(this.#supervisionKey(record));
					this.#providerRetryAfter.delete(message.agentId);
					await this.#sendForEpoch(connectionEpoch, 'conversation_wake_ack', message.agentId, {
						transactionId: message.payload.transactionId,
						goalRevision: record.goalRevision,
					});
					await this.#sendForEpoch(connectionEpoch, 'agent_ready', record.agentId, { goalRevision: record.goalRevision });
					return;
				}
				const previous = this.#registry.get(message.agentId);
				if (this.#usesNativeTools(previous)) {
					await this.#pendingConversationInbox(message.agentId).checkWake(this.#serverInstanceId, message.payload.event,
						{ transactionId: message.payload.transactionId, fingerprint });
					if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
				}
				let record;
				try {
					record = this.#registry.applyConversationWake(message.agentId, message.payload.control);
				} catch (error) {
					if (error instanceof AgentRegistryError && ['STALE_GOAL_REVISION', 'GOAL_REVISION_COLLISION', 'INVALID_AGENT_STATE'].includes(error.code)) return;
					throw error;
				}
				if (previous !== null && record.goalRevision > previous.goalRevision) {
					this.#retireGoalSupervision(previous, message.payload.control.operation);
					this.#invalidateAcceptedLifecycle(message.agentId);
					this.#programRuntime.onGoalControl(previous, message.payload.control.operation);
					await this.#nativeRuntime.dispose(previous.agentId, 'conversation_wake');
					if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
				}
				await this.#admitConversation(message.agentId, message.payload.event, connectionEpoch,
					{ transactionId: message.payload.transactionId, fingerprint });
				this.#goalSupervisor.activate(this.#supervisionKey(record));
				this.#providerRetryAfter.delete(message.agentId);
				this.#rememberPendingAttention(record.agentId, record.goalRevision, { priority: 'urgent', trigger: 'conversation_wake' });
				if (this.#usesNativeTools(record)) this.#scheduleNativeConversation(record, message.payload.event, 'conversation_wake');
				else this.#schedulePendingAttentionFlush(record);
				this.#rememberConversationWake(message.payload.transactionId, message.agentId, fingerprint);
				await this.#sendForEpoch(connectionEpoch, 'conversation_wake_ack', record.agentId, {
					transactionId: message.payload.transactionId,
					goalRevision: record.goalRevision,
				});
				await this.#sendForEpoch(connectionEpoch, 'agent_ready', record.agentId, { goalRevision: record.goalRevision });
				this.emit('conversationEvent', { ...message, payload: message.payload.event });
				this.emit('goalControl', record);
			}, { waitForReconciliation: false, connectionEpoch, transactional: true });
		});
		for (const type of ['plan_facts', 'advancement_granted', 'entity_killed']) this.#listen(type, (message, connectionEpoch) => this.#enqueueAgent(message.agentId, async () => {
			const record = this.#registry.assertCurrentRevision(message.agentId, message.payload.goalRevision);
			await this.#taskViews.receipt(record, message.payload);
		}, { connectionEpoch }));
		this.#listen('observation', (message, connectionEpoch) => {
			const receiptMonotonicMs = safeClockRead(this.#controlNow);
			const receiptEpochMs = safeClockRead(this.#epochNow);
			const lifecycleGeneration = this.#lifecycleGeneration(message.agentId);
			return this.#enqueueAgent(message.agentId, async () => {
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
				if (!this.#isLifecycleGenerationCurrent(message.agentId, lifecycleGeneration)) return;
				const record = this.#registry.assertCurrentRevision(message.agentId, message.payload.goalRevision);
				// Parked native agents still own their body: danger must reach the model without resuming their goal.
				const noTask = this.#usesNativeTools(record) && PARKED_NATIVE_STATES.includes(record.state);
				if (!noTask && ![DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(record.state)) return;
				const wireObservation = message.payload.observation ?? message.payload;
				const supervisionKey = this.#supervisionKey(record, lifecycleGeneration);
				this.#goalSupervisor.factualProgress(supervisionKey, factualProgressSignature(wireObservation), factualProgressDetails(wireObservation));
				if (this.#usesNativeTools(record)) this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
				const observation = adaptObservation(wireObservation);
				const refreshMemorySummary = () => {
					const memoryKey = `${record.goalRevision}:${this.#playerMemory.worldId(record)}`;
					if (this.#memorySummaries.get(record.agentId)?.key !== memoryKey) {
						return this.#playerMemory.unresolved(record, { limit: 8 }).then((unresolved) => {
							if (!this.#isConnectionEpochCurrent(connectionEpoch) || !this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)) return false;
							this.#memorySummaries.set(record.agentId, { key: memoryKey, unresolved });
							return true;
						});
					}
				};
				const worldSignals = this.#usesNativeTools(record)
					? this.#rememberNativeWorldSignals(record, lifecycleGeneration, connectionEpoch, observation)
					: null;
				// Stored and shown with this sample only, like the result it came with.
				if (worldSignals?.toolBreak != null) observation.toolBroke = worldSignals.toolBreak;
				if (worldSignals?.dragonPerch != null) observation.dragonPerch = worldSignals.dragonPerch;
				if (worldSignals?.endCrystals != null) observation.endCrystals = worldSignals.endCrystals;
				// After the world signals, so the plan's stage checks read the same End crystal tally the wake shows.
				await this.#taskViews.observe(record, observation, wireObservation).catch((error) => this.#writeTrace('task_view_observation_error', { code: error?.code ?? 'PLAN_VIEW_ERROR' }));
				const classified = classifyObservationTrigger(this.#withoutOwnSightings(record.agentId, this.#withoutSoundOnlyAttention(record.agentId, message.payload, wireObservation), wireObservation), wireObservation, worldSignals);
				let pendingAttention = this.#pendingAttention.get(record.agentId);
				if (pendingAttention?.goalRevision === record.goalRevision && pendingAttention.trigger === 'movement_loop') {
					pendingAttention = this.#settleProvisionalLoopAttention(record, pendingAttention, worldSignals, classified);
				}
				const merged = pendingAttention?.goalRevision === record.goalRevision
					? mergeAttentionTrigger(classified, pendingAttention)
					: classified;
				let attention = noTask ? merged : this.#withHealNudge(record, observation, merged);
				// The plan not moving for minutes, or one result repeating, is said once; a routine wake takes its name.
				const progressWake = noTask ? null : this.#taskViews.progressWake(record);
				if (progressWake !== null && (attention.attention !== true || attention.priority !== 'urgent' && ['attention', 'observation'].includes(attention.trigger))) attention = { attention: true, priority: 'ordinary', trigger: progressWake };
				// Entering a dangerous context (dusk on the surface, lava near, a fortress, low health with hostiles) owes the
				// model one wake listing its dangers and their armed rules. A respawn or arrival already wakes it.
				const entered = noTask || !this.#usesNativeTools(record) ? [] : this.#contextTracker(record.agentId).observe(observation, Date.now());
				if (entered.length > 0) {
					this.#writeTrace('context_entered', { agentId: record.agentId, goalRevision: record.goalRevision, contexts: entered });
					if (attention.attention !== true && entered.some((context) => context !== 'respawn')) attention = { attention: true, priority: 'ordinary', trigger: CONTEXT_ENTRY_TRIGGER };
				}
				if (pendingAttention?.goalRevision === record.goalRevision) this.#pendingAttention.delete(record.agentId);
				this.#trackHazardContact(record.agentId, observation);
				this.#trackSurvivalQuiet(record, observation);
				if (noTask) {
					this.#observeWithoutTask(record, observation, message.payload, attention, lifecycleGeneration, connectionEpoch);
					return;
				}
				const ledger = this.#ledger(record.agentId);
				ledger.ingest('observation', wireObservation);
				if (this.#usesNativeTools(record)) {
					const observationSignature = nativeObservationSignature(observation);
					const previousSignature = this.#nativeObservationSignatures.get(record.agentId);
					const supervisedRequest = this.#supervisedObservationRequests.get(record.agentId);
					const forcedContinuation = supervisedRequest?.goalRevision === record.goalRevision
						&& supervisedRequest.lifecycleGeneration === lifecycleGeneration
						&& supervisedRequest.connectionEpoch === connectionEpoch;
					if (forcedContinuation) this.#supervisedObservationRequests.delete(record.agentId);
					const unchangedHeartbeat = attention.attention === false && !forcedContinuation
						&& previousSignature?.goalRevision === record.goalRevision
						&& previousSignature.lifecycleGeneration === lifecycleGeneration
						&& previousSignature.connectionEpoch === connectionEpoch
						&& previousSignature.signature === observationSignature;
					this.#nativeObservationSignatures.set(record.agentId, {
						goalRevision: record.goalRevision,
						lifecycleGeneration,
						connectionEpoch,
						signature: observationSignature,
					});
					const memory = this.#conversationMemory(record.agentId);
					const conversation = memory.history();
					// An unchanged heartbeat may still owe the model a failure whose steer was rejected; it must try again,
					// within the attempt bound that also applies to changed snapshots.
					const failureSteerOwed = this.#nativeRuntime.failureSteerOwed(record, observation.lastResult);
					if (unchangedHeartbeat && !failureSteerOwed) {
						if (this.#nativeRuntime.refreshObservation(record, observation, { eventSequence: message.payload.eventSequence, conversation })) return;
					}
					const accepted = this.#nativeRuntime.updateObservation(record, observation, { eventSequence: message.payload.eventSequence, conversation, attention: attention.attention, priority: attention.priority, trigger: attention.trigger, resourceSightings: worldSignals?.resourceSightings, changedFacts: message.payload.changedFacts });
					// Accepted native snapshots are ingested by the runtime callback, which
					// also preserves requested samples and enriched sparse death facts.
					if (!accepted) this.#playerMemory.observe(record, observation);
					const pendingSummary = refreshMemorySummary();
					if (pendingSummary !== undefined && !await pendingSummary) return;
					this.#goalSupervisor.observed(supervisionKey);
					// Stored above for standing orders and watchers; a sample published only for the drop ahead is no turn. A
					// finished action's held wake still resumes here (its completion owns the next observation).
					if (attention.sampleOnly === true && attention.attention === false && !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision
						&& this.#actionDeferredWakes.get(record.agentId)?.actionEnded !== true) return;
					// The program owns ordinary progress. It explicitly notifies the model
					// when reconsideration or a new intention is needed.
					if (this.#nativeRuntime.hasProgram(record) && !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision) return;
					// The model can only wait for its own running action, and the action's result is followed by an
					// attention observation that wakes it with fresher facts. Danger, conversation and forced
					// continuations (a pending attention) still wake it now.
					const wakeRequest = {
						agentId: record.agentId,
						goalRevision: record.goalRevision,
						observation,
						memory: this.#memorySummaries.get(record.agentId)?.unresolved,
						executionSettings: this.#planner.getExecutionSettings?.(record.agentId) ?? null,
						eventSequence: message.payload.eventSequence,
						priority: attention.priority,
						trigger: attention.trigger,
						lifecycleGeneration,
						connectionEpoch,
						nativeEvent: { event: 'observation', trigger: forcedContinuation ? 'continuation' : attention.trigger, observation },
						// The failure protects this wake only while a steer about it is still owed and within its attempts.
						failureSteered: !failureSteerOwed,
					};
					// System 1 runs, System 2 sleeps: while the model's own action runs, a hit absorbed at safe health by a known
					// kind, a known threat's next signal or a burn a fire rule handles is summed into the next wake; a new
					// kind of danger, low health or a discovery wakes at once (wake-filter.mjs).
					// A model mid-turn is awake already: its danger steers are folded by the DangerSteerCoalescer instead.
					const filtered = !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision && attention.attention === true
						&& this.#nativeRuntime.hasModelAction(record) && !this.#providerWork.has(record.agentId)
						? this.#wakeFilter.decide(record.agentId, { attention, observation, changedFacts: message.payload.changedFacts, reflexRules: this.#nativeRuntime.reflexRules(record),
							reflexEvents: this.#nativeRuntime.reflexEvents(record), goalText: record.currentGoal })
						: null;
					if (filtered !== null && filtered.verdict !== 'default') this.#writeTrace('native_wake_filtered', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: attention.trigger, verdict: filtered.verdict, reason: filtered.reason });
					if (filtered?.verdict === 'hold' && this.#holdWakeForModelAction(record, wakeRequest, { absorbed: true })) return;
					if (filtered?.verdict !== 'wake' && !forcedContinuation && pendingAttention?.goalRevision !== record.goalRevision && attention.priority !== 'urgent'
						&& attention.trigger !== DIMENSION_CHANGED_TRIGGER && attention.trigger !== CONTEXT_ENTRY_TRIGGER && this.#nativeRuntime.hasModelAction(record) && this.#holdWakeForModelAction(record, wakeRequest)) return;
					const resumedTrigger = this.#resumeDeferredWake(record, attention);
					if (!forcedContinuation) { wakeRequest.trigger = resumedTrigger; wakeRequest.nativeEvent.trigger = resumedTrigger; }
					if (failureSteerOwed) this.#nativeRuntime.noteFailureSteerAttempt(record, observation.lastResult);
					this.#scheduleNativeTurn(record, wakeRequest);
					return;
				}
				this.#playerMemory.observe(record, observation);
				const pendingSummary = refreshMemorySummary();
				if (pendingSummary !== undefined && !await pendingSummary) return;
				this.#goalSupervisor.observed(supervisionKey);
				const installed = await this.#programRuntime.onObservation(record, {
					observation,
					eventSequence: message.payload.eventSequence,
					attention: attention.attention,
					priority: attention.priority,
					trigger: attention.trigger,
					receiptMonotonicMs,
					receiptEpochMs,
					observedAtEpochMs: message.payload.observedAtEpochMs,
				});
				if (installed !== null) return;
				this.#scheduleInitialPlan(record, {
					agentId: record.agentId,
					goalRevision: record.goalRevision,
					observation,
					wireObservation,
					eventSequence: message.payload.eventSequence,
					receiptMonotonicMs,
					attention: attention.attention,
					priority: attention.priority,
					trigger: attention.trigger,
					preserveState: false,
					kind: 'initial',
					lifecycleGeneration,
					connectionEpoch,
					...buildPlannerRequest({
						agent: { agentId: record.agentId, provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort },
						goal: record.currentGoal,
						goalRevision: record.goalRevision,
						attentionPriority: attention.priority,
						attentionTrigger: attention.trigger,
						observation,
						memory: this.#memorySummaries.get(record.agentId)?.unresolved,
						executionSettings: this.#planner.getExecutionSettings?.(record.agentId) ?? null,
					}, this.#plannerContext(record.agentId)),
				});
			}, {
				connectionEpoch,
				coalesceKey: message.payload.attention === false
					&& message.payload.trigger === undefined
					&& !this.#pendingAttention.has(message.agentId)
					&& !this.#supervisedObservationRequests.has(message.agentId)
					? `quiet-observation:${connectionEpoch}:${lifecycleGeneration}:${message.payload.goalRevision}`
					: null,
			});
		});
		this.#listen('action_progress', (message, connectionEpoch) => {
			const lifecycleGeneration = this.#lifecycleGeneration(message.agentId);
			return this.#enqueueAgent(message.agentId, async () => {
				const record = this.#registry.assertCurrentRevision(message.agentId, message.payload.goalRevision);
				if (this.#usesNativeTools(record) && message.payload.actionObservation?.position !== undefined
					&& this.#isLifecycleGenerationCurrent(message.agentId, lifecycleGeneration)) {
					this.#sampleProgressMovement(record, lifecycleGeneration, connectionEpoch, message.payload.actionObservation);
				}
				const nativeWork = this.#providerWork.get(message.agentId);
				if (this.#usesNativeTools(record) && nativeWork?.goalRevision === record.goalRevision) {
					this.#goalSupervisor.progress(nativeWork.supervisionToken);
					for (const call of nativeWork.toolSupervision.values()) {
						if (call.token !== null) this.#goalSupervisor.progress(call.token);
					}
				}
				if (this.#usesNativeTools(record) && this.#nativeRuntime.onActionProgress(record, message.payload)) {
					this.emit('actionProgress', message);
					return;
				}
				if (this.#usesNativeTools(record) && this.#nativeRuntime.isActionResultStale(record, message.payload)) return;
				if (!this.#programRuntime.onActionProgress(record, message.payload)) throw new ProtocolV2Error('UNEXPECTED_ACTION_RESULT', `Agent '${message.agentId}' has no outstanding program action`);
				this.emit('actionProgress', message);
			}, { connectionEpoch });
		});
		this.#listen('action_result', (message, connectionEpoch) => {
			const lifecycleGeneration = this.#lifecycleGeneration(message.agentId);
			let receipt;
			return this.#enqueueAgent(message.agentId, async () => {
				const dispatch = this.#latestActionDispatches.get(message.agentId);
				if (dispatch?.connectionEpoch === connectionEpoch && dispatch.actionId === message.payload.actionId
					&& dispatch.goalRevision === message.payload.goalRevision && message.payload.actionType !== undefined
					&& dispatch.actionType !== message.payload.actionType) {
					// Invalid receipt evidence must neither enter live facts nor fail valid
					// gameplay through the agent-error/cancellation path. No disk read here.
					this.#emitRuntimeError(codedRuntimeError('UNCORRELATED_ACTION_RECEIPT', 'Terminal action type does not match its live dispatch; withholding ACK'));
					return;
				}
				// Live correlation must not wait for disk. The retained server result is
				// acknowledged separately, only after authoritative storage succeeds.
				receipt = this.#queueReceiptReconciliation(message, connectionEpoch);
				try {
					const current = this.#registry.get(message.agentId);
					if (current === null || message.payload.goalRevision !== current.goalRevision
						|| !this.#isLifecycleGenerationCurrent(message.agentId, lifecycleGeneration)) {
						return;
					}
					const record = this.#registry.assertCurrentRevision(message.agentId, message.payload.goalRevision);
					this.#ledger(record.agentId).ingest('action_result', message.payload);
					if (this.#usesNativeTools(record)) {
						this.#trackOwnBreak(record, lifecycleGeneration, connectionEpoch, (state) => {
							settleOwnBreak(state, message.payload.actionId, message.payload.state === 'SUCCEEDED', message.payload.observedAtEpochMs, message.payload.actionObservation);
							settleCombatResult(state, message.payload);
						});
					}
					if (this.#usesNativeTools(record) && this.#nativeRuntime.onActionResult(record, message.payload)) {
						this.#endHeldWakeForFinishedAction(record);
						this.emit('actionResult', message);
						return;
					}
					if (this.#usesNativeTools(record) && this.#nativeRuntime.isActionResultStale(record, message.payload)) {
						return;
					}
					if (!await this.#programRuntime.onActionResult(record, message.payload)) {
						if (this.#programRuntime.isActionResultStale(record, message.payload)) {
							return;
						}
						throw new ProtocolV2Error('UNEXPECTED_ACTION_RESULT', `Agent '${message.agentId}' has no outstanding program action`);
					}
					this.emit('actionResult', message);
				} finally {
					this.#reconcileReceipt(receipt);
				}
			}, { connectionEpoch, terminal: true });
		});
		this.#listen('task_request_result', (message) => {
			// Settled directly: the agent queue may be busy applying the goal_control this result follows.
			const pending = this.#taskRequests.get(message.payload.requestId);
			if (pending === undefined || pending.agentId !== message.agentId) return;
			this.#taskRequests.delete(message.payload.requestId);
			clearTimeout(pending.timer);
			pending.resolve(message.payload);
		});
		this.#listen('goal_completion_result', (message, connectionEpoch) => {
			return this.#enqueueAgent(message.agentId, async () => {
				const current = this.#registry.get(message.agentId);
				if (current === null || current.goalRevision !== message.payload.goalRevision) return;
				if (this.#usesNativeTools(current) && this.#nativeRuntime.onCompletionResult(current, message.payload)) { if (message.payload.verified) this.#taskViews.verified(current); return; }
				const accepted = this.#programRuntime.onCompletionResult(current, message.payload);
				if (!accepted) throw new ProtocolV2Error('UNEXPECTED_COMPLETION_RESULT', `Agent '${message.agentId}' has no matching completion request`);
				if (message.payload.verified) this.#taskViews.verified(current);
			}, { connectionEpoch, transactional: true });
		});
		this.#listen('disconnected', (event) => {
			const connectionEpoch = this.#eventConnectionEpoch(event);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			this.#inspections.cancel(undefined, 'BRIDGE_DISCONNECTED');
			void this.#playerMemory.markUnknown(undefined, 'BRIDGE_DISCONNECTED').catch((error) => this.#emitRuntimeError(error));
			this.#connected = false;
			this.#retireReceiptReconciliations();
            for(const requestId of this.#directorRequests) this.#scheduler.cancel(`director-${requestId}`, 'Director connection closed');
			this.#setVerboseEnabled(false);
			this.#cancelGoalSpecRequests();
			this.#settleTaskRequests(undefined, 'BRIDGE_DISCONNECTED', 'Lost the connection to Minecraft before it answered.');
			for (const record of this.#registry.list()) {
				const work = this.#providerWork.get(record.agentId);
				if (work?.kind === 'native') {
					this.#restoreNativeConversation(work.steerRequest);
					this.#restoreNativeConversation(work.request);
				}
				this.#nativeConversationRecoveries.delete(record.agentId);
				this.#dropDeferredWake(record.agentId);
				this.#goalSupervisor.suspend(this.#supervisionKey(record));
				this.#advanceLifecycleGeneration(record.agentId);
			}
			this.#run(async () => {
			if (this.#connectionEpoch !== connectionEpoch) return;
			this.#disconnectedAt ??= safeClockRead(this.#controlNow);
			this.#reconciledStatus = false;
			this.#supportedAgentIds.clear();
			this.#programRuntimeEpochs.clear();
			this.#nativeRuntimeEpochs.clear();
			this.#programRuntime.disposeAll();
			void this.#nativeRuntime.disposeAll('bridge_disconnected');
			this.#pendingAttention.clear();
			this.#dropAllDeferredWakes();
			this.#attentionFlushes.clear();
			this.#providerRetryAfter.clear();
			this.#providerProbeDeadlines.clear();
			this.#deferredProviderRecovery.clear();
			this.#providerWork.clear();
			await Promise.allSettled(this.#registry.list().map(async (record) => {
				if ([DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(record.state)) {
					this.#registry.setState(record.agentId, DynamicAgentState.DISCONNECTED, { goalRevision: record.goalRevision });
				}
				await this.#planner.interrupt(record.agentId, 'Minecraft bridge disconnected');
			}));
			}, connectionEpoch, { requireConnected: false });
		}, { lifecycle: true });
		this.#listen('shutdown', () => {
			this.#run(async () => {
				try { this.emit('shutdown'); }
				finally { await this.stop(); }
			});
		});
		this.#listen('protocolError', (error) => this.emit('runtimeError', error), { lifecycle: true });
		this.#listen('messageRejected', (rejection) => this.emit('runtimeError', rejection.error), { lifecycle: true });
		this.#listen('transportError', (error) => this.emit('runtimeError', error), { lifecycle: true });
	}

	#beginReconciliation(registry, connectionEpoch, { providerOnly = false } = {}) {
		let startedReconciliation;
		try {
			startedReconciliation = this.#planner.beginReconcile(registry, providerOnly ? { recovery: true, providerOnly: true } : { recovery: true });
		} catch (error) {
			startedReconciliation = { complete: Promise.reject(error) };
		}
		const reconciliation = Promise.resolve().then(async () => {
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
			if (typeof this.#codexService.bootstrapCatalog === 'function') {
				const catalog = await this.#codexService.bootstrapCatalog(registry);
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
				await this.#publishCatalog(catalog, connectionEpoch);
			}
			const result = await startedReconciliation.complete;
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
			const providers = result.providers ?? result.codex;
			await this.#publishCatalog(providers.catalog, connectionEpoch);
			const deadStatePlans = [];
			for (const profile of providers.valid) {
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
				const record = this.#registry.get(profile.agentId);
				if (record === null) throw new ProtocolV2Error('UNKNOWN_AGENT', `Reconciled provider profile references unknown agent '${profile.agentId}'`);
				const lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
				if (this.#supportedAgentIds.has(profile.agentId)) continue;
				if (record.state === DynamicAgentState.STARTING && record.currentGoal !== null) {
					this.#goalSupervisor.activate(this.#supervisionKey(record));
				}
				await this.#sendForEpoch(connectionEpoch, 'agent_ready', profile.agentId, { goalRevision: record.goalRevision, reconciled: true });
				this.#supportedAgentIds.add(profile.agentId);
				this.#usageLedger.registerAgent(record);
				this.#publishVerbose(record.agentId, record.goalRevision, 'lifecycle', 'Agent reconciled and ready.', connectionEpoch);
				this.#prewarmNativeAgent(record);
				this.#checkProviderCli(record, connectionEpoch);
				if (this.#usesNativeTools(record) && [DynamicAgentState.IDLE, DynamicAgentState.PAUSED, DynamicAgentState.COMPLETED].includes(record.state)) {
					await this.#resumeUnreadNativeConversation(record, connectionEpoch, lifecycleGeneration);
				}
				if (record.state === DynamicAgentState.DEAD) {
					const recovery = this.#installDeadStatePlan(record, record.death, connectionEpoch);
					// Native recovery is already supervised. Its body may need receipts
					// admitted only after reconciliation, so readiness cannot join the turn.
					if (this.#usesNativeTools(record)) void recovery.catch((error) => this.#reportAgentError(record.agentId, error, connectionEpoch));
					else deadStatePlans.push(recovery);
				}
			}
			for (const invalid of providers.invalid) {
				if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
				const agentId = invalid.agentId ?? invalid.profile?.agentId;
				await this.#sendForEpoch(connectionEpoch, 'agent_error', agentId, {
					goalRevision: this.#registry.get(agentId)?.goalRevision ?? 0,
					code: sanitizeDiagnosticCode(invalid.code, { fallback: 'INVALID_PROFILE' }),
					message: sanitizeDiagnosticText(invalid.message ?? 'Provider profile is unavailable.', { maxBytes: 2_048 }),
				});
			}
			await Promise.all(deadStatePlans);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
			this.#reconciledStatus = !this.#hasUnsupportedAgents();
			if (this.#disconnectedAt !== null) this.#disconnectedAt = null;
			await this.#publishStatus(connectionEpoch);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
			// The catalogs above only cover providers with saved agents. The bridge treats any
			// non-empty snapshot as loaded, so publish every provider or the summon menu stays
			// limited to those providers. Off the readiness path so slow CLIs cannot delay agents.
			void this.#publishFullCatalog(connectionEpoch);
			this.emit('reconciled', result);
			return result;
		});
		this.#reconciliation = reconciliation.catch((error) => {
			if (this.#isConnectionEpochCurrent(connectionEpoch)) this.#emitRuntimeError(error);
			return null;
		});
	}

	#bindProviderRecovery() {
		if (typeof this.#codexService.on !== 'function' || typeof this.#codexService.off !== 'function') return;
		const listener = () => this.#requestProviderRecovery(this.#connectionEpoch, { force: true });
		this.#codexService.on('providerRestored', listener);
		this.#providerListeners.push(['providerRestored', listener]);
	}

	#requestProviderRecovery(connectionEpoch, { force = false } = {}) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch) || this.#providerRecoveryPending) return;
		if (!this.#hasUnsupportedAgents()) return;
		if (!force && !this.#providerProbeDue()) return;
		this.#providerRecoveryPending = true;
		void Promise.resolve(this.#reconciliation).finally(() => {
			this.#providerRecoveryPending = false;
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			if (!this.#hasUnsupportedAgents()) return;
			this.#beginReconciliation(this.#registry.list(), connectionEpoch, { providerOnly: true });
		});
	}

	#hasUnsupportedAgents() {
		return this.#registry.list().some(({ agentId }) => !this.#supportedAgentIds.has(agentId));
	}

	#providerProbeDue() {
		if (typeof this.#codexService.recoverySnapshot !== 'function') return true;
		let recovery;
		try { recovery = this.#codexService.recoverySnapshot(); }
		catch { return true; }
		if (!Array.isArray(recovery)) return true;
		const missingProviders = new Set(this.#registry.list()
			.filter(({ agentId }) => !this.#supportedAgentIds.has(agentId))
			.map(({ provider }) => provider ?? 'codex'));
		const now = safeClockRead(this.#epochNow);
		for (const provider of missingProviders) {
			const record = recovery.find((entry) => entry?.provider === provider);
			if (record?.state !== 'degraded' || record.nextProbeAtEpochMs === null || now === null || now >= record.nextProbeAtEpochMs) return true;
		}
		return false;
	}

	#listen(event, listener, { lifecycle = false } = {}) {
		const registered = lifecycle ? listener : (message) => {
			const connectionEpoch = this.#eventConnectionEpoch(message);
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			const result = listener(message, connectionEpoch);
			if (typeof message?.waitUntil === 'function' && result !== undefined) message.waitUntil(result);
			return result;
		};
		this.#bridge.on(event, registered);
		this.#listeners.push([event, registered]);
	}

	#acceptReadyEpoch(connection) {
		const supplied = connection?.connectionEpoch;
		let connectionEpoch;
		if (supplied === undefined) {
			connectionEpoch = this.#connected && connection?.serverInstanceId === this.#serverInstanceId
				? this.#connectionEpoch
				: this.#connectionEpoch + 1;
		} else if (!Number.isSafeInteger(supplied) || supplied < 1) {
			this.#emitRuntimeError(new ProtocolV2Error('INVALID_CONNECTION_EPOCH', 'Bridge ready event requires a positive connection epoch'));
			return null;
		} else {
			connectionEpoch = supplied;
		}
		if (connectionEpoch <= this.#connectionEpoch) return null;
		this.#retireReceiptReconciliations();
		this.#inspections.cancel(undefined, 'STALE_CONNECTION_EPOCH');
		this.#memorySummaries.clear();
		if (this.#connectionEpoch > 0) {
			for (const record of this.#registry.list()) {
				void this.#nativeRuntime.dispose(record.agentId, 'connection_replaced').catch((error) => this.#emitRuntimeError(error));
			}
		}
		this.#connectionEpoch = connectionEpoch;
		this.#connected = true;
		return connectionEpoch;
	}

	#eventConnectionEpoch(event) {
		const supplied = event?.connectionEpoch;
		return Number.isSafeInteger(supplied) && supplied >= 1 ? supplied : this.#connectionEpoch;
	}

	#isConnectionEpochCurrent(connectionEpoch) {
		return this.#connected && Number.isSafeInteger(connectionEpoch) && connectionEpoch === this.#connectionEpoch;
	}

	async #installDeadStatePlan(record, death, connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return null;
		if (death === null || death === undefined) throw new ProtocolV2Error('MISSING_FIELD', `DEAD agent '${record.agentId}' requires death facts`);
		if (record.currentGoal === null) return;
		if (this.#programRuntime.hasCurrent(record)) return;
		this.#playerMemory.observe(record, { death: structuredClone(death) });
		const lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
		if (this.#usesNativeTools(record)) {
			this.#dropDeferredWake(record.agentId);
			this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
			const observation = { death: structuredClone(death) };
			const live = this.#nativeRuntime.snapshotLive(record.agentId);
			const eventSequence = Number.isSafeInteger(live?.eventSequence) ? live.eventSequence : 0;
			this.#nativeRuntime.updateObservation(record, observation, {
				eventSequence,
				conversation: this.#conversationMemory(record.agentId).history(),
				force: true,
			});
			return this.#scheduleNativeTurn(record, {
				agentId: record.agentId,
				goalRevision: record.goalRevision,
				observation,
				eventSequence,
				priority: 'urgent',
				trigger: 'player_death',
				preserveState: true,
				lifecycleGeneration,
				connectionEpoch,
				nativeEvent: { event: 'player_death', trigger: 'player_death', observation },
			});
		}
		return this.#scheduleProviderPlan(record, {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			observation: { death },
			eventSequence: 0,
			attention: true,
			priority: 'urgent',
			trigger: 'player_death',
			preserveState: true,
			kind: 'death',
			lifecycleGeneration,
			connectionEpoch,
			input: buildPlannerInput({
				agent: { agentId: record.agentId, provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort },
				goal: record.currentGoal,
				goalRevision: record.goalRevision,
				decisionContext: 'player_death',
				attentionPriority: 'urgent',
				attentionTrigger: 'player_death',
				death,
			}),
		}, { preserveState: true, kind: 'death' });
	}

	#rememberNativeWorldSignals(record, lifecycleGeneration, connectionEpoch, observation) {
		const state = this.#nativeWorldState(record, lifecycleGeneration, connectionEpoch);
		const sampledAt = finiteOrNull(observation?.observedAtEpochMs);
		const evidence = movementEvidence(observation?.velocity, observation?.player?.onGround);
		// Ground motion at walking speed on the hurt sample is evidence of a walk. A known impulse's later ground drift is not.
		if (knockbackHurt(observation?.player, state.player) && evidence !== 'walking') {
			// The hit landed after the previous observation; progress positions since then may already show the shove.
			withdrawShovedSteps(state.positions, state.observedAt, sampledAt);
			state.knockbackFrom = sampledAt === null ? null : sampledAt - KNOCKBACK_LEAD_MS;
			state.knockbackUntil = sampledAt === null ? null : sampledAt + KNOCKBACK_SETTLE_MS;
			state.knockbackLanding = true;
			state.knockbackNow = true;
		}
		sampleMovement(state, nativeBlockPositionKey(observation?.player), sampledAt, evidence);
		// Only an observation at or after the closing step can validate progress-derived history.
		if (state.movementLoopDue === true && (sampledAt === null || state.positions.at(-1)?.at == null || sampledAt >= state.positions.at(-1).at)) {
			state.movementLoopValidatedVersion = state.movementLoopVersion;
		}
		state.knockbackNow = false;
		// Due until delivered: danger in the same sample carries the loop fact in its own wake.
		const movementLoop = state.movementLoopDue === true && state.movementLoopValidatedVersion === state.movementLoopVersion
			&& state.movementLoopDelivery?.version !== state.movementLoopVersion;
		if (sampledAt !== null) state.observedAt = sampledAt;
		const lavaFlowDue = lavaFlowWakeDue(state, observation?.player, sampledAt ?? Date.now());
		const resourceDiscovery = rememberResources(state, observation, record);
		const previousPlayer = state.player;
		state.player = observation.player;
		// Only a live body's inventory is compared: a death empties it, and a stack moved into an open container leaves the hand.
		const liveInventory = observation?.ready !== false && observation?.death == null && observation?.player?.dead !== true && Array.isArray(observation?.inventory?.items);
		const toolBreak = liveInventory && observation.interaction?.menu == null ? heldToolBreak(state.inventory, observation.inventory) : null;
		state.inventory = liveInventory ? observation.inventory : null;
		const dimension = observation?.world?.dimension ?? null;
		const dimensionChanged = dimension !== null && state.dimension != null && dimension !== state.dimension;
		if (dimension !== null) state.dimension = dimension;
		const dragonPerch = dragonPerchEdge(state, observation, sampledAt);
		const endCrystals = rememberEndCrystals(state, observation);
		this.#nativeWorldSignals.set(record.agentId, state);
		return {
			previousPlayer,
			lavaFlowDue,
			dragonPerch,
			endCrystals,
			movementLoop,
			resourceDiscovery,
			resourceSightings: state.resourceSightings,
			dimensionChanged,
			toolBreak,
		};
	}

	#nativeWorldState(record, lifecycleGeneration, connectionEpoch) {
		const previous = this.#nativeWorldSignals.get(record.agentId);
		const sameLifecycle = previous?.goalRevision === record.goalRevision
			&& previous.lifecycleGeneration === lifecycleGeneration
			&& previous.connectionEpoch === connectionEpoch;
		return sameLifecycle
			? previous
			: { goalRevision: record.goalRevision, lifecycleGeneration, connectionEpoch, positions: [], resources: new Set(), brokenBlocks: [] };
	}

	/** Tracks the dispatch and confirmed visible faces of this agent's own successful break. */
	#trackOwnBreak(record, lifecycleGeneration, connectionEpoch, update) {
		const state = this.#nativeWorldState(record, lifecycleGeneration, connectionEpoch);
		update(state);
		this.#nativeWorldSignals.set(record.agentId, state);
	}

	/**
	 * Full observations now arrive only when a fact changed, so a walk back and forth is also sampled from the position
	 * every action progress message carries. A loop seen there asks the server for an observation, which merges the
	 * pending attention, so the model hears of it as fast as when every position change produced an observation.
	 */
	#sampleProgressMovement(record, lifecycleGeneration, connectionEpoch, actionObservation) {
		const state = this.#nativeWorldState(record, lifecycleGeneration, connectionEpoch);
		const movementLoop = sampleMovement(state, nativeBlockPositionKey(actionObservation.position), finiteOrNull(actionObservation.observedAtEpochMs),
			movementEvidence(actionObservation.velocity, actionObservation.onGround));
		this.#nativeWorldSignals.set(record.agentId, state);
		if (!movementLoop) return;
		// Provisional: the observation it asks for may explain the closing steps as a shove and withdraw them.
		const superseded = this.#pendingAttention.get(record.agentId);
		this.#rememberPendingAttention(record.agentId, record.goalRevision, { priority: 'urgent', trigger: 'movement_loop' });
		if (superseded?.goalRevision === record.goalRevision && superseded.trigger !== 'movement_loop') this.#pendingAttention.get(record.agentId).superseded = superseded;
		void Promise.resolve(this.#bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision })).catch(() => {});
	}

	/**
	 * A loop queued from action progress is settled by the observation it asked for: withdrawn when the corrected
	 * movement history no longer loops, kept queued (not merged) when danger in this observation outranks it, and
	 * otherwise merged as before. Returns the attention to merge, if any.
	 */
	#settleProvisionalLoopAttention(record, pending, signals, classified) {
		if (signals?.movementLoop !== true) {
			if (pending.superseded === undefined) this.#pendingAttention.delete(record.agentId);
			else this.#pendingAttention.set(record.agentId, pending.superseded);
			this.#writeTrace('native_movement_loop_withdrawn', { agentId: record.agentId, goalRevision: record.goalRevision });
			return this.#pendingAttention.get(record.agentId);
		}
		if (classified.priority === 'urgent' && classified.trigger !== 'movement_loop') return undefined;
		return pending;
	}

	#usesNativeTools(record) {
		// Claude agents always use the native tool loop; Codex follows its configured control protocol.
		if (record?.provider === 'codex') return this.#codexControlProtocol === 'native_tools';
		return NATIVE_TOOL_PROVIDERS.includes(record?.provider);
	}

	#prewarmNativeAgent(record) {
		if (!this.#usesNativeTools(record) || record.state !== DynamicAgentState.IDLE || typeof this.#codexService.prewarmAgent !== 'function') return;
		void Promise.resolve(this.#codexService.prewarmAgent(record, { goalRevision: record.goalRevision })).catch((error) => {
			this.#writeTrace('native_prewarm_failed', {
				agentId: record.agentId,
				goalRevision: record.goalRevision,
				errorCode: String(error?.code ?? 'PREWARM_FAILED').slice(0, 128),
			});
		});
	}

	/**
	 * Tells players at launch time when the provider CLI is missing, broken or signed out.
	 * The probe never blocks registration; agent_notice is used because agent_error is
	 * dropped by the server for agents without an active goal.
	 */
	#checkProviderCli(record, connectionEpoch) {
		if (this.#providerCliHealth === null) return;
		// CLI health depends on neither the goal revision nor the lifecycle generation (goal_control
		// bumps both): a goal started while a broken CLI is probed (tens of seconds) must not
		// silence the notice. Only a new connection or agent removal makes it stale.
		const current = () => this.#isConnectionEpochCurrent(connectionEpoch) && this.#registry.get(record.agentId) !== null;
		const spec = PROVIDER_CLI[record.provider];
		void Promise.resolve().then(() => this.#providerCliHealth.check(record.provider)).then((health) => {
			if (!current()) return;
			const goalRevision = this.#registry.get(record.agentId)?.goalRevision ?? record.goalRevision;
			if (health.status === 'ok') {
				this.#publishVerbose(record.agentId, goalRevision, 'provider', `${spec?.display ?? record.provider}${health.version ? ` ${health.version}` : ''} ready.`, connectionEpoch);
				return;
			}
			if (health.code === null || typeof health.message !== 'string' || health.message.length === 0) return;
			if (!this.#acceptProviderCliNotice(connectionEpoch, record.agentId)) return;
			this.#writeTrace('provider_cli_unhealthy', {
				agentId: record.agentId,
				goalRevision,
				provider: record.provider,
				status: health.status,
				code: health.code,
				version: health.version,
				details: sanitizeDiagnosticText(health.details ?? '', { maxBytes: 512 }),
			});
			this.#publishVerbose(record.agentId, goalRevision, 'provider', `${spec?.display ?? record.provider} check failed (${health.code}).`, connectionEpoch);
			void this.#sendForEpoch(connectionEpoch, 'agent_notice', record.agentId, { severity: 'error', code: health.code, message: health.message })
				.catch((error) => {
					// A failed send must not consume the one notice this agent gets per connection.
					this.#forgetProviderCliNotice(connectionEpoch, record.agentId);
					this.#writeTrace('provider_cli_notice_failed', { agentId: record.agentId, code: sanitizeDiagnosticErrorCode(error, { fallback: 'NOTICE_FAILED' }) });
				});
		}).catch((error) => {
			this.#writeTrace('provider_cli_probe_failed', { agentId: record.agentId, provider: record.provider, code: sanitizeDiagnosticErrorCode(error, { fallback: 'PROBE_FAILED' }) });
		});
	}

	/** One notice per agent per connection epoch, so reconnects and re-registrations do not repeat it. */
	#acceptProviderCliNotice(connectionEpoch, agentId) {
		if (this.#providerCliNotices.connectionEpoch !== connectionEpoch) {
			this.#providerCliNotices = { connectionEpoch, agents: new Set() };
		}
		if (this.#providerCliNotices.agents.has(agentId)) return false;
		this.#providerCliNotices.agents.add(agentId);
		return true;
	}

	#forgetProviderCliNotice(connectionEpoch, agentId) {
		if (this.#providerCliNotices.connectionEpoch === connectionEpoch) this.#providerCliNotices.agents.delete(agentId);
	}

	/**
	 * One console line per provider, once per coordinator process. Runs after the first bridge
	 * handshake rather than in start(): a first-time Codex desktop-CLI cache copy is synchronous
	 * and must not eat into the server's 5 s handshake window.
	 */
	#logProviderCliHealthAtStartup() {
		if (this.#providerCliStartupLogged || this.#providerCliHealth === null || this.#providerCliHealth.enabled !== true) return;
		this.#providerCliStartupLogged = true;
		this.#providerDiscovery.start();
		for (const provider of PROVIDER_IDS) {
			void Promise.resolve().then(() => this.#providerCliHealth.check(provider)).then((health) => {
				const display = PROVIDER_CLI[provider]?.display ?? provider;
				const line = health.status === 'ok'
					? `${display}${health.version ? ` ${health.version}` : ''} ready${health.executable ? ` (${health.executable})` : ''}`
					: `${health.status}: ${health.message ?? health.details ?? 'no details'}`;
				try { console.error(`[provider-cli] ${provider}: ${line}`); } catch { /* console output is best effort */ }
			}).catch(() => {});
		}
	}

	/**
	 * A parked agent (idle, finished, paused or in error) still has a body. Its facts stay current for observe/inspect, and urgent
	 * danger (damage, a threat, fire, lava, drowning, a fall) wakes the model at once in a no-task turn with every body
	 * tool. Ordinary sightings never wake it, so a finished task is not restarted or redone.
	 */
	#observeWithoutTask(record, observation, payload, attention, lifecycleGeneration, connectionEpoch) {
		const conversation = this.#conversationMemory(record.agentId).history();
		const accepted = this.#nativeRuntime.updateObservation(record, observation, { eventSequence: payload.eventSequence, conversation,
			attention: attention.attention, priority: attention.priority, trigger: attention.trigger, changedFacts: payload.changedFacts });
		if (!accepted) this.#playerMemory.observe(record, observation);
		// An operator's /takeover owns the body: Minecraft reports it, and the model is not woken to act on it.
		if (observation?.player?.operatorControlled === true) return;
		if (attention.priority !== 'urgent' || !NO_TASK_WAKE_TRIGGERS.has(attention.trigger)) {
			this.#considerHealWake(record, observation, lifecycleGeneration, connectionEpoch);
			return;
		}
		this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
		this.#scheduleNativeTurn(record, {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			observation,
			eventSequence: payload.eventSequence,
			priority: 'urgent',
			trigger: attention.trigger,
			lifecycleGeneration,
			connectionEpoch,
			preserveState: true,
			conversationOnly: true,
			dangerWake: true,
			nativeEvent: { event: 'observation', trigger: attention.trigger, observation, conversationOnly: true, dangerWake: true },
		});
	}

	/**
	 * Low health with no task: once per health level, give the model a no-task turn to recover (eat, or get food:
	 * hunt passive animals, pick up drops, harvest ripe crops or berries). Danger turns come first; this runs when the
	 * observation was not danger, or after a no-task turn ends. The model decides; it may simply wait.
	 */
	#considerHealWake(record, observation, lifecycleGeneration, connectionEpoch) {
		if (!this.#usesNativeTools(record) || ![DynamicAgentState.IDLE, DynamicAgentState.COMPLETED].includes(record.state)) return false;
		if (observation === null || observation === undefined || this.#providerWork.has(record.agentId)) return false;
		const latch = this.#healWakes.get(record.agentId);
		const verdict = healWakeVerdict(observation, latch?.goalRevision === record.goalRevision ? latch : null);
		if (verdict.latch === null) this.#healWakes.delete(record.agentId);
		else this.#healWakes.set(record.agentId, { goalRevision: record.goalRevision, ...verdict.latch });
		if (!verdict.wake) return false;
		this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
		this.#writeTrace('native_heal_wake', { agentId: record.agentId, goalRevision: record.goalRevision, health: observation.player.health, foodLevel: observation.player.foodLevel ?? null });
		this.#scheduleNativeTurn(record, {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			observation,
			priority: 'ordinary',
			trigger: 'low_health_idle',
			lifecycleGeneration,
			connectionEpoch,
			preserveState: true,
			conversationOnly: true,
			selfCareWake: true,
			nativeEvent: { event: 'observation', trigger: 'low_health_idle', observation, conversationOnly: true, selfCareWake: true, healing: healingFacts(observation) },
		});
		return true;
	}

	/**
	 * An agent with a task at low health with food in reach: one urgent attention edge (debounced, see healNudgeVerdict)
	 * so the model hears it at once instead of in the 30 s ordinary window. It carries healing facts and options; the
	 * routine keeps running unless the model chooses otherwise. Danger observations pass through untouched.
	 */
	#withHealNudge(record, observation, attention) {
		if (!this.#usesNativeTools(record) || attention.priority === 'urgent') return attention;
		// Another named trigger (a structure, a resource, a program edge) keeps its own wake; the nudge waits for the next sample.
		if (attention.attention === true && !['observation', 'attention'].includes(attention.trigger)) return attention;
		const latch = this.#healNudges.get(record.agentId);
		const verdict = healNudgeVerdict(observation, latch?.goalRevision === record.goalRevision ? latch : null, safeClockRead(this.#epochNow));
		if (verdict.latch === null) this.#healNudges.delete(record.agentId);
		else this.#healNudges.set(record.agentId, { goalRevision: record.goalRevision, ...verdict.latch });
		if (!verdict.nudge) return attention;
		this.#writeTrace('native_heal_nudge', { agentId: record.agentId, goalRevision: record.goalRevision, health: observation.player.health,
			foodLevel: observation.player.foodLevel ?? null, options: verdict.options });
		return { attention: true, priority: 'urgent', trigger: 'low_health_food' };
	}

	#scheduleNativeConversation(record, event, trigger) {
		const conversationOnly = [DynamicAgentState.IDLE, DynamicAgentState.COMPLETED, DynamicAgentState.PAUSED].includes(record.state);
		if (!conversationOnly && ![DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(record.state)) return;
		const lifecycleGeneration = this.#lifecycleGeneration(record.agentId);
		const connectionEpoch = this.#connectionEpoch;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
		this.#nativeRuntimeEpochs.set(record.agentId, connectionEpoch);
		this.#scheduleNativeTurn(record, {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			priority: 'urgent',
			trigger,
			lifecycleGeneration,
			connectionEpoch,
			preserveState: conversationOnly,
			conversationOnly,
			nativeEvent: {
				event: event?.kind ?? 'conversation',
				trigger,
				observation: {},
				conversationOnly,
			},
		});
	}

	async #resumeUnreadNativeConversation(record, connectionEpoch, lifecycleGeneration) {
		if (!this.#usesNativeTools(record)) return;
		const isCurrent = () => this.#isConnectionEpochCurrent(connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)
			&& this.#registry.get(record.agentId)?.goalRevision === record.goalRevision;
		const hasCurrentWork = () => {
			const work = this.#providerWork.get(record.agentId);
			return work?.kind === 'native' && work.goalRevision === record.goalRevision
				&& work.connectionEpoch === connectionEpoch && work.lifecycleGeneration === lifecycleGeneration;
		};
		if (!isCurrent() || hasCurrentWork()) return;
		const inbox = this.#pendingConversationInbox(record.agentId);
		await inbox.open(this.#serverInstanceId);
		if (!isCurrent() || hasCurrentWork()) return;
		if (!await inbox.hasUnreadWake()) return;
		if (!isCurrent() || hasCurrentWork()) return;
		// Derive authority from the new lifecycle, never replay the old goal request.
		this.#scheduleNativeConversation(record, null, 'conversation');
	}

	#awaitingNativeConfirmation(record, lifecycleGeneration = this.#lifecycleGeneration(record.agentId)) {
		return sameSupervisionKey(this.#nativeConfirmationWaits.get(record.agentId), this.#supervisionKey(record, lifecycleGeneration));
	}

	#confirmationBlocksRequest(record, request) {
		// A supervision continuation can share a wake with real danger; waiting must not swallow that danger.
		if (request.priority === 'urgent' && NO_TASK_WAKE_TRIGGERS.has(request.trigger)) return false;
		return this.#awaitingNativeConfirmation(record, request.lifecycleGeneration)
			&& !this.#confirmationActivity.has(record.agentId)
			&& (request.priority !== 'urgent' || request.trigger === 'stuck' || request.nativeEvent?.trigger === 'continuation');
	}

	#scheduleNativeTurn(record, request) {
		if (!this.#isConnectionEpochCurrent(request.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration)) return;
		if (!this.#nativePreparationIsCurrent(record, request) || this.#confirmationBlocksRequest(record, request)) return;
		if (this.#awaitingNativeConfirmation(record, request.lifecycleGeneration)) request = { ...request, preserveState: true };
		request = this.#afterProviderProbeDeadline(record, request);
		if (request === null) return;
		const existing = this.#providerWork.get(record.agentId);
		if (existing !== undefined) {
			if (
				existing.kind === 'native'
				&& existing.goalRevision === request.goalRevision
				&& existing.lifecycleGeneration === request.lifecycleGeneration
				&& existing.connectionEpoch === request.connectionEpoch
				&& (request.priority === 'urgent' || request.nativeEvent?.event === 'program_planning_due'
						|| protectedNativeWake(request))
			) {
				this.#traceEventReady(record, request, existing.traceId, 'steer');
				if (request.nativeEvent?.event === 'program_planning_due') this.#queueNativePreparation(existing, request);
				else this.#queueNativeSteer(existing, request);
				return existing.promise;
			}
			this.#traceEventReady(record, request, existing.traceId, 'pending');
			existing.pending = mergePlannerRequest(existing.pending, request);
			// How long a queued wake waits for the running turn (and its closing call) to end is reported when it does.
			if (existing.kind === 'native') existing.pendingSince ??= safeClockRead(this.#controlNow);
			return existing.promise;
		}
		const supervisionKey = this.#supervisionKey(record, request.lifecycleGeneration);
		this.#forgetNativeConversationRecovery(supervisionKey);
		this.#goalSupervisor.activate(supervisionKey);
		const work = {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			lifecycleGeneration: request.lifecycleGeneration,
			connectionEpoch: request.connectionEpoch,
			kind: 'native',
			request,
			pending: null,
			pendingSince: null,
			steerQueued: null,
			steerRequest: null,
			steerPromise: null,
			// Repeated damage/threat steers into this turn fold into one summary (see danger-steer-coalescer.mjs).
			dangerSteer: new DangerSteerCoalescer(),
			dangerSteerTimer: null,
			preparationPromise: null,
			traceId: planningTraceId(record.agentId, record.goalRevision, request.lifecycleGeneration, 'native'),
			promise: null,
			supervisionKey,
			supervisionToken: this.#goalSupervisor.begin(supervisionKey, 'provider', { timeoutMs: Math.min(MAX_LEASE_TIMEOUT_MS, this.#planner.getExecutionSettings?.(record.agentId)?.limits?.nativeTurnBudgetMs ?? MAX_LEASE_TIMEOUT_MS) }),
			toolSupervision: new Map(),
			// When the model's current call began (the turn start, then each moment no tool is left running), and the newest
			// hazard contact whose facts reached the provider in this turn's input, a steer or a tool result.
			modelCallStartedAt: safeClockRead(this.#controlNow),
			// The current call has begun streaming a tool call (Claude), so it is about to reach a tool boundary.
			callStreamingTool: false,
			hazardContactDelivered: 0,
			survivalAware: false,
			// When this turn was last told of survival danger; awareness ends with the episode (see #trackSurvivalQuiet).
			survivalAwareAt: null,
			seenSurvivalFacts: new Set(),
			survivalReissued: false,
			survivalRecheckTimer: null,
			// An IN_LAVA/ON_FIRE tool result reached the provider in this turn.
			hazardResultDelivered: false,
			// Danger's tool-boundary flush carried a contact steer, so the call is not planning blind.
			hazardSteerAtToolBoundary: false,
			successfulChat: false,
			expired: false,
		};
		this.#providerWork.set(record.agentId, work);
		this.#traceEventReady(record, request, work.traceId, 'turn');
		work.dangerSteer.noteDelivered(request, safeClockRead(this.#controlNow));
		try {
			if (request.preserveState !== true) {
				if (record.state === DynamicAgentState.STARTING) this.#registry.setState(record.agentId, DynamicAgentState.PLANNING, { goalRevision: record.goalRevision });
				void this.#sendForEpoch(request.connectionEpoch, 'planning_state', record.agentId, { goalRevision: record.goalRevision, state: DynamicAgentState.PLANNING })
					.catch((error) => this.#reportAgentError(record.agentId, error, request.connectionEpoch));
			}
		} catch (error) {
			this.#providerWork.delete(record.agentId);
			this.#goalSupervisor.end(work.supervisionToken);
			throw error;
		}
		const verboseReporter = this.#verboseReporter(record.agentId, record.goalRevision, { allowPublicAgentMessage: true, publicActivity: request.conversationOnly !== true, connectionEpoch: request.connectionEpoch });
		const eventReadyAt = performance.now();
		work.promise = Promise.resolve()
			.then(async () => this.#planner.requestNativeTurn({
				agentId: record.agentId,
				goalRevision: record.goalRevision,
				input: await this.#nativeTurnInput(record, request).then((input) => {
					this.#noteHazardDelivered(work);
					this.#noteSurvivalDelivered(work, request, request.survivalFacts);
					work.modelCallStartedAt = safeClockRead(this.#controlNow);
					work.callStreamingTool = false;
					if (typeof input === 'string') {
						work.inputBytes = Buffer.byteLength(input, 'utf8');
						this.#writeTrace('native_input_built', { agentId: record.agentId, goalRevision: record.goalRevision, traceId: work.traceId, inputBytes: work.inputBytes, buildMs: Math.round((performance.now() - eventReadyAt) * 10) / 10 });
					}
					return input;
				}),
				recoverySummary: record.lastSummary,
				priority: request.priority,
				preserveState: request.preserveState === true,
				traceId: work.traceId,
				onVerbose: verboseReporter,
				onProgress: (metadata) => {
					if (metadata?.phase === 'tool_streaming') work.callStreamingTool = true;
					if (metadata?.phase === 'tool_queued' && work.dangerSteer?.hasFolded()) {
						this.#cancelDangerSteerTimer(work);
						const folded = work.dangerSteer.flush(safeClockRead(this.#controlNow));
						if (folded !== null) this.#deliverNativeSteer(work, folded, { toolBoundary: true });
					}
					if (this.#providerWork.get(record.agentId) === work && this.#isConnectionEpochCurrent(request.connectionEpoch)) this.#goalSupervisor.progress(work.supervisionToken);
				},
				executeTool: (toolRequest) => this.#executeNativeTool(work, toolRequest),
				normalizeTool: (tool) => this.#nativeRuntime?.effectiveTool?.(tool, record) ?? tool,
			}))
			.then(async (result) => {
				try { return await this.#completeNativeTurn(work, result); }
				catch (error) { return this.#failNativeTurn(work, error); }
			}, (error) => this.#failNativeTurn(work, error))
			.finally(() => verboseReporter.dispose());
		return work.promise;
	}

	/** Marks the moment an observation or attention event reaches the coordinator's turn scheduling; the first stage of a latency chain. */
	#traceEventReady(record, request, traceId, mode) {
		this.#writeTrace('native_event_ready', { agentId: record.agentId, goalRevision: record.goalRevision, traceId, mode,
			trigger: request.trigger ?? null, eventName: request.nativeEvent?.event ?? null, priority: request.priority ?? null,
			...(Number.isFinite(request.receiptMonotonicMs) ? { receiptMonotonicMs: request.receiptMonotonicMs } : {}) });
	}

	/**
	 * True when this ordinary wake is held back for the running action. The first held wake arms a deadline, so a
	 * one-time sighting is released with the freshest held facts even if no other observation ever arrives.
	 */
	#holdWakeForModelAction(record, request, { absorbed = false } = {}) {
		// An absorbed wake (wake-filter.mjs) was protected danger the body is coping with: it is held as a routine one.
		if (!absorbed && protectedNativeWake(request)) return false;
		const held = absorbed ? { ...request, priority: 'ordinary', trigger: 'attention', nativeEvent: { ...request.nativeEvent, trigger: 'attention' } } : request;
		const previous = this.#actionDeferredWakes.get(record.agentId);
		const continuing = previous?.goalRevision === record.goalRevision && !previous.actionEnded;
		const entry = continuing ? previous : { goalRevision: record.goalRevision, trigger: null, count: 0, request: null, timer: null, actionEnded: false };
		entry.count += 1;
		entry.request = held;
		// A sighting or discovery is signalled once, so the first named reason survives the plain heartbeats after it.
		if (entry.trigger === null && !GENERIC_WAKE_TRIGGERS.has(held.trigger)) entry.trigger = held.trigger;
		this.#actionDeferredWakes.set(record.agentId, entry);
		if (entry.count === 1) this.#writeTrace('native_wake_deferred_for_action', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: request.trigger, ...(absorbed ? { absorbed: true } : {}) });
		// Only a named reason (a sighting, a discovery) is released by the deadline; routine updates and absorbed hits wait
		// for the action's end, a real wake or the model's next turn, and are summed into it.
		if (entry.timer === null && entry.trigger !== null) {
			entry.timer = this.#setWakeHoldTimeout(() => { if (entry.timer !== null) { entry.timer = null; this.#releaseHeldWake(record.agentId, entry, 'hold_limit'); } }, ORDINARY_WAKE_HOLD_MS);
		}
		return true;
	}

	/** The trigger to wake with: a generic wake adopts the named reason it replaced. */
	#namedWakeTrigger(entry, trigger, priority) {
		return priority !== 'urgent' && entry.trigger !== null && GENERIC_WAKE_TRIGGERS.has(trigger) ? entry.trigger : trigger;
	}

	/** The trigger to wake with now that the model is being woken. */
	#resumeDeferredWake(record, attention) {
		const entry = this.#actionDeferredWakes.get(record.agentId);
		if (entry === undefined) return attention.trigger;
		this.#dropDeferredWake(record.agentId);
		if (entry.goalRevision !== record.goalRevision) return attention.trigger;
		this.#writeTrace('native_wake_resumed_after_action', { agentId: record.agentId, goalRevision: record.goalRevision, skippedWakes: entry.count, deferredTrigger: entry.trigger, reason: 'wake' });
		return this.#namedWakeTrigger(entry, attention.trigger, attention.priority);
	}

	/** Wakes the model with the freshest held request: the hold limit passed, or the held action was cancelled or replaced. */
	#releaseHeldWake(agentId, entry, reason) {
		if (this.#actionDeferredWakes.get(agentId) !== entry) return false;
		this.#dropDeferredWake(agentId);
		const request = entry.request;
		this.#writeTrace('native_wake_resumed_after_action', { agentId, goalRevision: entry.goalRevision, skippedWakes: entry.count, deferredTrigger: entry.trigger, reason });
		if (request === null || this.#stopping || this.#closed) return false;
		const trigger = this.#namedWakeTrigger(entry, request.trigger, request.priority);
		return this.#reschedulePendingNativeTurn({ ...request, trigger, nativeEvent: { ...request.nativeEvent, trigger } }, { released: true });
	}

	/** The model cancelled or replaced the action that held these wakes; the facts they carried still reach the model. */
	#releaseHeldWakeForCancelledAction(record) {
		const entry = this.#actionDeferredWakes.get(record.agentId);
		if (entry !== undefined && !entry.actionEnded) this.#releaseHeldWake(record.agentId, entry, 'action_cancelled');
	}

	/** The action ended: no deadline is needed, and the completion observation that follows names what was held. */
	#endHeldWakeForFinishedAction(record) {
		const entry = this.#actionDeferredWakes.get(record.agentId);
		if (entry === undefined || entry.actionEnded || this.#nativeRuntime.hasModelAction(record)) return;
		this.#clearHeldWakeTimer(entry);
		entry.actionEnded = true;
	}

	#clearHeldWakeTimer(entry) {
		if (entry.timer === null) return;
		this.#clearWakeHoldTimeout(entry.timer);
		entry.timer = null;
	}

	#dropDeferredWake(agentId) {
		const entry = this.#actionDeferredWakes.get(agentId);
		if (entry === undefined) return;
		this.#clearHeldWakeTimer(entry);
		this.#actionDeferredWakes.delete(agentId);
	}

	#dropAllDeferredWakes() {
		for (const agentId of [...this.#actionDeferredWakes.keys()]) this.#dropDeferredWake(agentId);
	}

	#nativePreparationIsCurrent(record, request) {
		const event = request?.nativeEvent;
		return event?.event !== 'program_planning_due'
			|| this.#nativeRuntime.canPrepareProgram(record, event.programId, event.status?.programVersion);
	}

	#preparationHasRunningProgram(work, record) {
		return (work.request?.nativeEvent?.event === 'program_planning_due' || work.preparingProgram != null)
			&& this.#nativeRuntime.hasProgram(record);
	}

	#queueNativeSteer(work, request) {
		// Danger reaching a no-task conversation turn lets it defend the body (self-preservation tools only).
		if (request.dangerWake === true) work.dangerWoken = true;
		// A lava contact often arrives as a repeat damage hit; folding it would hold the reissue for up to the fold interval.
		if (this.#reissueMidCallTurnForHazard(work, request, false) || this.#reissueUnawareSurvivalTurn(work, request, false)) return;
		const decision = work.dangerSteer.offer(request, safeClockRead(this.#controlNow));
		if (decision.action === 'fold') {
			this.#writeTrace('native_turn_steer_coalesced', { agentId: work.agentId, goalRevision: work.goalRevision,
				traceId: work.traceId, trigger: request.trigger, foldedEvents: decision.folded });
			if (work.dangerSteerTimer === null) {
				work.dangerSteerTimer = this.#setSteerTimeout(() => {
					work.dangerSteerTimer = null;
					if (this.#providerWork.get(work.agentId) !== work || work.expired === true) return;
					const folded = work.dangerSteer.flush(safeClockRead(this.#controlNow));
					if (folded !== null) this.#deliverNativeSteer(work, folded);
				}, decision.dueInMs);
				work.dangerSteerTimer?.unref?.();
			}
			return;
		}
		this.#cancelDangerSteerTimer(work);
		this.#deliverNativeSteer(work, decision.request);
	}

	#cancelDangerSteerTimer(work) {
		if (work.dangerSteerTimer === null || work.dangerSteerTimer === undefined) return;
		this.#clearSteerTimeout(work.dangerSteerTimer);
		work.dangerSteerTimer = null;
	}

	/** Pending work plus any danger summary still folded when the turn ends, so no hit is lost. */
	#pendingWithFoldedSteer(work) {
		this.#cancelDangerSteerTimer(work);
		const folded = work.dangerSteer?.flush(safeClockRead(this.#controlNow)) ?? null;
		if (folded === null) return work.pending;
		return work.pending?.eventSequence > folded.eventSequence
			? mergePlannerRequest(folded, work.pending) : mergePlannerRequest(work.pending, folded);
	}

	#trackHazardContact(agentId, observation) {
		const touching = inHazardContact(observation?.player);
		if (!touching && imminentLavaFlow(observation?.player) === null) this.#hazardContacts.delete(agentId);
		// A seen flow due soon opens an episode before contact; the contact itself is a new one, so a turn that only
		// knew the flow is reissued again once the lava is on the body.
		else if (!this.#hazardContacts.has(agentId) || touching && this.#hazardContacts.get(agentId).touching === false) {
			this.#hazardContacts.set(agentId, { sequence: ++this.#hazardContactSequence, startedAt: safeClockRead(this.#controlNow), reissued: false, touching });
		}
	}

	/**
	 * A Claude turn can run for minutes, so knowing about one drowning or lava episode must not make it count as aware
	 * of the next. Once no observation has shown danger for SURVIVAL_EPISODE_QUIET_MS after everything the turn was
	 * told, the next danger wake is new to it and may reissue its call again. Short gaps (stepping in and out of a pool,
	 * a breath at the surface while escaping) stay one episode. Threat entities the model has seen stay known.
	 */
	#trackSurvivalQuiet(record, observation) {
		const player = observation?.player;
		if (player == null) return;
		const now = safeClockRead(this.#controlNow);
		if (!Number.isFinite(now)) return;
		if (survivalDangerShown(player)) { this.#survivalQuietSince.delete(record.agentId); return; }
		if (!this.#survivalQuietSince.has(record.agentId)) this.#survivalQuietSince.set(record.agentId, now);
		const quietSince = this.#survivalQuietSince.get(record.agentId);
		const work = this.#providerWork.get(record.agentId);
		if (!TOOL_BOUNDARY_STEER_PROVIDERS.includes(record.provider) || work === undefined || work.survivalReissued || !Number.isFinite(work.survivalAwareAt)
				|| work.survivalAwareAt > quietSince || now - quietSince < SURVIVAL_EPISODE_QUIET_MS) return;
		work.survivalAware = false;
		work.survivalAwareAt = null;
		work.hazardResultDelivered = false;
		work.hazardSteerAtToolBoundary = false;
		work.hazardContactDelivered = 0;
		work.seenSurvivalFacts.delete('air');
		work.seenSurvivalFacts.delete('fall');
		this.#writeTrace('native_turn_survival_episode_closed', { agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId,
			quietMs: Math.round(now - quietSince) });
	}

	#noteSurvivalAware(work) {
		work.survivalAwareAt = safeClockRead(this.#controlNow);
	}

	#noteHazardDelivered(work) {
		const contact = this.#hazardContacts.get(work.agentId);
		// A flow warning delivered before contact leaves the contact itself to reissue a call that is still planning.
		if (contact !== undefined && contact.touching !== false) {
			work.hazardContactDelivered = Math.max(work.hazardContactDelivered ?? 0, contact.sequence);
			this.#noteSurvivalAware(work);
		}
	}

	#noteSurvivalDelivered(work, request, facts) {
		if (dangerWakeRank(request) === 2 || dangerWakeRank(facts) === 2) { work.survivalAware = true; this.#noteSurvivalAware(work); }
		const keys = survivalFactKeys(facts);
		for (const key of keys) work.seenSurvivalFacts.add(key);
		if (keys.has('air') || keys.has('fall')) this.#noteSurvivalAware(work);
	}

	/**
	 * Lava or fire-block contact while the model is mid-call: a steer would wait for that call's next tool boundary
	 * (3-7 s at low effort), or for a whole new turn if the call ends text-only. When nothing in this turn has carried
	 * any contact to the provider yet (its input, a steer or an IN_LAVA/ON_FIRE result), the call is planning without
	 * knowing: cancel it and reissue the turn with this event. A turn that already knows (the reissued one, or one
	 * stepping in and out of a pool while it escapes) gets the event as a steer. Never while a tool runs (the tool's
	 * result carries the steer, and danger already cuts blocking tools short).
	 */
	#reissueMidCallTurnForHazard(work, request, toolBoundary) {
		const contact = this.#hazardContacts.get(work.agentId);
		if (contact === undefined || contact.reissued || !isHazardContactRequest(request)) return false;
		// The model just asked for a tool, so this steer rides on that tool's result; it also counts as the turn's contact
		// (a flow warning there only closes its own episode).
		if (toolBoundary && contact.touching === false) contact.reissued = true;
		else if (toolBoundary) { work.hazardSteerAtToolBoundary = true; this.#noteSurvivalAware(work); }
		if (work.toolSupervision.size > 0 || work.callStreamingTool || work.hazardSteerAtToolBoundary === true || work.hazardResultDelivered === true || (work.hazardContactDelivered ?? 0) > 0) return false;
		contact.reissued = true;
		this.#cancelDangerSteerTimer(work);
		const folded = work.dangerSteer?.flush(safeClockRead(this.#controlNow)) ?? null;
		if (folded !== null) work.pending = mergePlannerRequest(work.pending, folded);
		work.pending = mergePlannerRequest(work.pending, request);
		const now = safeClockRead(this.#controlNow);
		this.#writeTrace('native_turn_hazard_reissue', { agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId,
			trigger: request.trigger ?? null, contact: contact.sequence, deliveredContact: work.hazardContactDelivered ?? 0,
			...(Number.isFinite(now) && Number.isFinite(work.modelCallStartedAt) ? { callAgeMs: Math.max(0, Math.round(now - work.modelCallStartedAt)) } : {}),
			...(Number.isFinite(now) && Number.isFinite(contact.startedAt) ? { contactAgeMs: Math.max(0, Math.round(now - contact.startedAt)) } : {}) });
		void Promise.resolve(this.#planner.interrupt(work.agentId, 'Hazard contact during a model call')).catch(() => {});
		return true;
	}

	/** Claude queues steers until a tool result. Replace an unaware reasoning call with the first survival edge. */
	#reissueUnawareSurvivalTurn(work, request, toolBoundary) {
		if (!TOOL_BOUNDARY_STEER_PROVIDERS.includes(this.#registry.get(work.agentId)?.provider) || request.priority !== 'urgent' || dangerWakeRank(request) !== 2) return false;
		// Newer facts arriving while interruption drains belong to the replacement, never the obsolete turn.
		if (work.survivalReissued) {
			work.pending = mergePlannerRequest(work.pending, request);
			return true;
		}
		if (toolBoundary) { work.survivalAware = true; this.#noteSurvivalAware(work); }
		if (work.survivalAware || work.hazardResultDelivered || work.hazardContactDelivered > 0 || work.toolSupervision.size > 0 || work.callStreamingTool) return false;
		const observation = request.nativeEvent?.observation ?? request.observation;
		const player = observation?.player;
		const trigger = dangerWakeTrigger(request);
		// Match the warning itself, rather than unrelated known entities or air facts in the same snapshot.
		const warning = ['suffocation', 'drowning'].includes(trigger) ? { air: player?.air }
			: trigger === 'fall' ? { fallDistance: player?.fallDistance }
				: trigger === 'damage' ? { lastAttacker: player?.lastAttacker, incomingProjectiles: player?.incomingProjectiles }
					: { threats: player?.threats, incomingProjectiles: player?.incomingProjectiles };
		let facts = survivalFactKeys(warning);
		// Damage with no attacker or projectile comes from the body's surroundings (drowning, a fall): judge it by those.
		if (trigger === 'damage' && facts.size === 0) facts = survivalFactKeys({ air: player?.air, fallDistance: player?.fallDistance });
		if ([...facts].some(key => work.seenSurvivalFacts.has(key))) return false;
		const now = safeClockRead(this.#controlNow);
		const previousRestart = this.#survivalRestartAt.get(work.agentId);
		if (!Number.isFinite(now) || !Number.isFinite(work.modelCallStartedAt)
			|| previousRestart !== undefined && now - previousRestart < 20_000) return false;
		if (now - work.modelCallStartedAt < SURVIVAL_RESTART_MIN_CALL_AGE_MS) {
			this.#recheckYoungSurvivalCall(work, request, SURVIVAL_RESTART_MIN_CALL_AGE_MS - (now - work.modelCallStartedAt));
			return false;
		}
		this.#survivalRestartAt.set(work.agentId, now);
		work.survivalReissued = true;
		this.#cancelDangerSteerTimer(work);
		const folded = work.dangerSteer?.flush(safeClockRead(this.#controlNow)) ?? null;
		for (const pending of [work.steerRequest, work.steerQueued, folded, request]) {
			if (pending != null) work.pending = mergePlannerRequest(work.pending, pending);
		}
		work.steerQueued = null;
		this.#writeTrace('native_turn_survival_reissue', { agentId: work.agentId, goalRevision: work.goalRevision,
			traceId: work.traceId, trigger: request.trigger, eventSequence: request.eventSequence, phase: 'requested', callAgeMs: now - work.modelCallStartedAt });
		void Promise.resolve().then(() => this.#planner.interrupt(work.agentId, 'First survival warning during an unaware model call'))
			.then((metrics) => this.#writeTrace('native_turn_survival_reissue', {
				agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId, phase: 'interrupted',
				...metrics,
			})).catch((error) => {
				work.survivalReissued = false;
				this.#writeTrace('native_turn_survival_reissue', { agentId: work.agentId, goalRevision: work.goalRevision,
					traceId: work.traceId, phase: 'interrupt_failed', errorCode: error?.code ?? 'INTERRUPT_FAILED' });
				if (this.#providerWork.get(work.agentId) === work && !work.expired) this.#deliverNativeSteer(work, request);
			});
		return true;
	}

	/**
	 * A call too young to restart still plans blind and its steer waits for its tool boundary (6 s in W-FLOOD). Look
	 * again once it reaches the minimum age: if that same call is still generating without the danger, reissue it then.
	 */
	#recheckYoungSurvivalCall(work, request, delayMs) {
		if (work.survivalRecheckTimer != null) return;
		const callStartedAt = work.modelCallStartedAt;
		work.survivalRecheckTimer = this.#setSteerTimeout(() => {
			work.survivalRecheckTimer = null;
			if (this.#providerWork.get(work.agentId) !== work || work.expired === true || work.modelCallStartedAt !== callStartedAt) return;
			this.#reissueUnawareSurvivalTurn(work, request, false);
		}, Math.max(0, Math.ceil(delayMs)));
		work.survivalRecheckTimer?.unref?.();
	}

	#deliverNativeSteer(work, request, { toolBoundary = false } = {}) {
		if (this.#reissueMidCallTurnForHazard(work, request, toolBoundary) || this.#reissueUnawareSurvivalTurn(work, request, toolBoundary)) return;
		work.steerQueued = mergePlannerRequest(work.steerQueued, request);
		const interruption = nativeSteerInterruption(request);
		if (work.steerPromise !== null) {
			if (interruption) this.#interruptForSteer(work);
			return;
		}
		const steering = this.#drainNativeSteering(work);
		const tracked = steering.finally(() => {
			if (work.steerPromise === tracked) work.steerPromise = null;
			// A drain that ended with its turn gone may leave an arm no steer will clear; a newer turn's arm is its own.
			const owner = this.#providerWork.get(work.agentId);
			if (owner === undefined || owner === work && work.expired === true) this.#nativeRuntime.disarmBlockingInterrupt?.(work.agentId);
		});
		work.steerPromise = tracked;
	}

	#queueNativePreparation(work, request) {
		// Planning is a one-shot advisory. It must never delay or replace an
		// urgent steering request, and its eventual failure must not become a
		// replayable pending turn.
		if (work.preparationPromise !== null
				|| work.request?.priority === 'urgent'
				|| work.steerQueued?.priority === 'urgent'
				|| work.pending?.priority === 'urgent'
				|| work.steerPromise !== null) return;
		const preparation = this.#deliverNativePreparation(work, request);
		const tracked = preparation.finally(() => {
			if (work.preparationPromise === tracked) work.preparationPromise = null;
		});
		work.preparationPromise = tracked;
	}

	async #deliverNativePreparation(work, request) {
		try {
			const record = this.#registry.get(work.agentId);
			if (record === null || record.goalRevision !== work.goalRevision
					|| work.expired === true
					|| this.#providerWork.get(work.agentId) !== work
					|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
					|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)
					|| !this.#nativePreparationIsCurrent(record, request)
					|| work.steerQueued?.priority === 'urgent'
					|| work.pending?.priority === 'urgent'
					|| work.steerPromise !== null) return;
			work.preparingProgram = { programId: request.nativeEvent.programId, programVersion: request.nativeEvent.status?.programVersion };
			await this.#planner.steerNativeTurn({
				agentId: work.agentId,
				goalRevision: work.goalRevision,
				input: await this.#nativeTurnInput(record, request, { deliverConversation: false }),
			});
			this.#noteSurvivalDelivered(work, request, request.survivalFacts);
			this.#writeTrace('native_turn_prepared', {
				agentId: work.agentId,
				goalRevision: work.goalRevision,
				traceId: work.traceId,
				trigger: request.trigger,
			});
		} catch (error) {
			// Advisory delivery has no turn ownership. Do not restore conversation
			// state or queue a stale reminder after the body turn has moved on.
			this.#writeTrace('native_turn_preparation_skipped', {
				agentId: work.agentId,
				goalRevision: work.goalRevision,
				traceId: work.traceId,
				errorCode: String(error?.code ?? 'PREPARATION_FAILED').slice(0, 128),
			});
		}
	}

	async #drainNativeSteering(work) {
		const isCurrent = () => work.expired !== true
			&& this.#providerWork.get(work.agentId) === work
			&& this.#registry.get(work.agentId)?.goalRevision === work.goalRevision
			&& this.#isConnectionEpochCurrent(work.connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration);
		while (work.steerQueued !== null) {
			// Death and reconnect can replace a lifecycle without changing the goal
			// revision. Never deliver its queued events into the replacement turn.
			if (!isCurrent()) { work.steerQueued = null; return; }
			const request = work.steerQueued;
			work.steerQueued = null;
			work.steerRequest = request;
			const steerStartedAt = performance.now();
			const interruption = nativeSteerInterruption(request);
			let deliveryRequest = request;
			try {
				const record = this.#registry.get(work.agentId);
				if (record === null || record.goalRevision !== work.goalRevision) throw Object.assign(new Error('Native steering belongs to an obsolete goal'), { code: 'STALE_PLAN' });
				if (!this.#nativePreparationIsCurrent(record, request)) continue;
				const buildInput = async () => {
					while (true) {
						if (work.steerQueued !== null) {
							deliveryRequest = mergePlannerRequest(deliveryRequest, work.steerQueued);
							work.steerQueued = null;
							work.steerRequest = deliveryRequest;
						}
						if (buildInput.discarded) throw Object.assign(new Error('Native steer input was superseded before delivery'), { code: 'STEER_SUPERSEDED' });
						const input = await this.#nativeTurnInput(record, deliveryRequest, { freshObservation: true });
						this.#noteHazardDelivered(work);
						if (buildInput.discarded) {
							this.#restoreNativeConversation(deliveryRequest);
							throw Object.assign(new Error('Native steer input was superseded before delivery'), { code: 'STEER_SUPERSEDED' });
						}
						if (work.steerQueued === null) {
							this.#noteSurvivalDelivered(work, deliveryRequest, deliveryRequest.survivalFacts);
							return input;
						}
						this.#restoreNativeConversation(deliveryRequest);
					}
				};
				buildInput.discarded = false;
				await this.#planner.steerNativeTurn({
					agentId: work.agentId,
					goalRevision: work.goalRevision,
					input: buildInput,
					onInterrupt: interruption ? () => this.#interruptForSteer(work) : null,
					onDiscard: () => {
						buildInput.discarded = true;
						this.#restoreNativeConversation(deliveryRequest);
					},
				});
				this.#nativeRuntime.disarmBlockingInterrupt?.(work.agentId);
				if (!isCurrent()) { this.#restoreNativeConversation(deliveryRequest); work.steerQueued = null; return; }
				await this.#commitNativeConversation(deliveryRequest);
				work.steeredPlayerRequests = [...(work.steeredPlayerRequests ?? []), ...(deliveryRequest.deliveredPlayerRequests ?? [])];
				if (!isCurrent()) { work.steerQueued = null; return; }
				// Continue only to reach unread waking messages. A public-only suffix
				// stays pending for the next legitimate wake, even during steering.
				if (deliveryRequest.nativeConversationDelivery?.omittedEntries > 0 && work.steerQueued === null
					&& await deliveryRequest.nativeConversationDelivery.inbox.hasUnreadWake() && isCurrent()) {
					work.steerQueued = { ...deliveryRequest };
				}
				this.#writeTrace('native_turn_steered', {
					agentId: work.agentId,
					goalRevision: work.goalRevision,
					traceId: work.traceId,
					trigger: deliveryRequest.trigger,
					steerMs: Math.round((performance.now() - steerStartedAt) * 10) / 10,
				});
			} catch (error) {
				this.#nativeRuntime.disarmBlockingInterrupt?.(work.agentId);
				// A late rejection has no authority to rewind current conversation
				// delivery or add recovery work after its lifecycle has ended.
				if (!isCurrent()) { work.steerQueued = null; return; }
				this.#restoreNativeConversation(deliveryRequest);
				if (error?.code === 'CONVERSATION_STORAGE_FAILED') await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
				if (!isCurrent()) { work.steerQueued = null; return; }
				work.pending = mergePlannerRequest(work.pending, deliveryRequest);
				if (work.steerQueued !== null) work.pending = mergePlannerRequest(work.pending, work.steerQueued);
				work.steerQueued = null;
				this.#writeTrace('native_turn_steer_deferred', {
					agentId: work.agentId,
					goalRevision: work.goalRevision,
					traceId: work.traceId,
					errorCode: String(error?.code ?? 'TURN_STEER_FAILED').slice(0, 128),
				});
				return;
			} finally {
				work.steerRequest = null;
			}
		}
	}

	/**
	 * Danger steer: cut a running blocking body tool short so its result carries the steer. Claude sees a steer only at
	 * a tool boundary, so while its call is still generating, the blocking tool it issues next was chosen without the
	 * danger: that tool starts already interrupted (its action keeps running, the model decides what follows).
	 */
	#interruptForSteer(work) {
		const armNext = TOOL_BOUNDARY_STEER_PROVIDERS.includes(this.#registry.get(work.agentId)?.provider);
		return this.#nativeRuntime.interruptBlockingTool(work.agentId, armNext ? { armNext } : undefined);
	}

	async #settleNativeSteering(work) {
		while (work.steerPromise !== null) await work.steerPromise;
	}

	/**
	 * Every model tool call. A call that ends without reaching Minecraft (refused, stale, gated) is traced as
	 * native_tool_rejected with its kind and reason code only, so an idle body is explainable from the trace.
	 */
	async #executeNativeTool(work, toolRequest) {
		const traceRejection = (reasonCode) => this.#writeTrace('native_tool_rejected', {
			agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId,
			callId: typeof toolRequest?.callId === 'string' ? toolRequest.callId.slice(0, 128) : null,
			toolKind: toolRequest?.tool?.kind ?? 'unknown',
			...(typeof toolRequest?.tool?.actionType === 'string' ? { actionType: toolRequest.tool.actionType } : {}),
			reasonCode: String(reasonCode ?? 'UNKNOWN').slice(0, 128),
		});
		let result;
		try {
			result = await this.#executeNativeToolCall(work, toolRequest);
		} catch (error) {
			traceRejection(error?.code ?? 'TOOL_EXECUTION_FAILED');
			throw error;
		}
		if (result?.executed === false) traceRejection(result.reasonCode);
		return result;
	}

	async #executeNativeToolCall(work, toolRequest) {
		const record = this.#registry.get(work.agentId);
		if (work.expired === true || (work.survivalReissued === true && !isSurvivalReissueTool(toolRequest.tool)) || record === null || record.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
			const finished = record !== null && [DynamicAgentState.COMPLETED, DynamicAgentState.IDLE].includes(record.state)
				&& record.goalRevision > work.goalRevision;
			return { state: 'CANCELLED', reasonCode: 'STALE_PLAN', executed: false,
				goalRevision: work.goalRevision, currentGoalRevision: record?.goalRevision ?? null,
				message: work.taskAdopted !== undefined
					? 'Your task was accepted. Nothing was dispatched from this turn: end it now and the task turn starts with every tool.'
					: finished
						? 'Your task is complete, so this turn has ended and nothing was dispatched. End it now: damage and threats wake you again at once; then you may fight, flee, eat, equip or move away.'
						: 'This goal turn has ended or been superseded. No action was dispatched. End this turn and await the next goal event.' };
		}
		// A model tool invocation proves this turn input was consumed, even if the provider fails later.
		this.#settleFailureDelivery(work.request, true);
		if (toolRequest.tool.kind === 'take_task') return this.#takeTask(work, toolRequest.tool);
		let deliveredConfirmationAuthority = false;
		if (sameSupervisionKey(this.#nativeConfirmationWaits.get(work.agentId), work.supervisionKey)) {
			const messages = [...(work.request.deliveredPlayerRequests ?? []), ...(work.steeredPlayerRequests ?? [])];
			deliveredConfirmationAuthority = messages.slice(work.confirmationMessageBoundary ?? 0).some(entry => entry.operator === true);
			if (!deliveredConfirmationAuthority && !sameSupervisionKey(this.#confirmationWorkAuthority.get(work.agentId), work.supervisionKey)
					&& !isConfirmationContextTool(toolRequest.tool)) {
				return { state: 'REJECTED', reasonCode: 'OPERATOR_REQUEST_REQUIRED', executed: false,
					message: 'Finished work awaits the operator. Other messages allow facts and replies, not new work, plans, intent, programs or memory directives.' };
			}
		}

		if (work.request.conversationOnly === true
				&& toolRequest.tool.kind !== 'observe'
				&& !(toolRequest.tool.kind === 'action' && toolRequest.tool.actionType === 'chat')) {
			if (work.taskAdopted !== undefined) return { ...work.taskAdopted, executed: false };
			// Player requests go through takeTask, which binds the requester and Minecraft's permission checks. Only a
			// turn woken by danger may defend the body without a task, and only with self-preservation tools.
			const dangerWoken = work.request.dangerWake === true || work.dangerWoken === true || work.request.selfCareWake === true;
			if (!dangerWoken || !isSelfPreservationTool(toolRequest.tool)) {
				throw Object.assign(new Error(dangerWoken
					? 'With no task you may only look after yourself: fight_target, flee_from, attack, use_ranged, block_with_shield, use_item (eat, drink, totem), select/equip items, pick up food, mine grown crops or melons, interact with ripe berries, navigate or move away, look, control without attack/use, wait. Anything else is a player request: call takeTask.'
					: 'You have no active task yet. If the operator asked you to do something, call takeTask first and end this turn; otherwise reply with say.'), { code: 'CONVERSATION_ONLY' });
			}
		}
		const executesBody = toolRequest.tool.kind === 'action'
			|| toolRequest.tool.kind === 'sequence'
			|| toolRequest.tool.kind === 'lookAround'
			|| toolRequest.tool.kind === 'run_program'
			|| toolRequest.tool.kind === 'respond_program'
			|| toolRequest.tool.kind === 'start_action'
			|| toolRequest.tool.kind === 'replace_action';
		const supervisionKind = executesBody ? 'action' : toolRequest.tool.kind === 'finish' ? 'completion' : null;
		if (work.toolSupervision.has(toolRequest.callId)) throw codedRuntimeError('DUPLICATE_TOOL_CALL', 'A tool call with this callId is already running');
		const call = { token: null, executesBody, done: null, resolve: null };
		call.done = new Promise((resolve) => { call.resolve = resolve; });
		const finishPredecessors = toolRequest.tool.kind === 'finish' ? [...work.toolSupervision.values()].map((pending) => pending.done) : [];
		work.toolSupervision.set(toolRequest.callId, call);
		let supervisionToken = null;
		let result;
		try {
			if (finishPredecessors.length > 0) {
				await Promise.all(finishPredecessors);
				if (work.expired || !this.#isConnectionEpochCurrent(work.connectionEpoch)
					|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) return { state: 'CANCELLED', reasonCode: 'STALE_PLAN', executed: false };
			}
			if (executesBody && record.state === DynamicAgentState.PLANNING) {
				this.#registry.setState(record.agentId, DynamicAgentState.ACTING, { goalRevision: record.goalRevision });
			}
			// After finish awaits operator confirmation the goal's work leases are terminated;
			// the body must still act at once, so it runs unsupervised instead of failing to acquire a lease.
			const awaitingConfirmation = sameSupervisionKey(this.#nativeConfirmationWaits.get(work.agentId), work.supervisionKey);
			const supervised = supervisionKind !== null && !awaitingConfirmation;
			supervisionToken = supervised ? this.#goalSupervisor.begin(work.supervisionKey, supervisionKind) : null;
			if (awaitingConfirmation && executesBody && !['chat', 'wait'].includes(toolRequest.tool.actionType)) {
				// Work begun while waiting (defending, a player's extra request) may need follow-up wakes, such as its
				// own action result; let those through until a turn ends without new body work (see completion).
				this.#confirmationActivity.add(work.agentId);
				work.actedWhileAwaiting = true;
			}
			call.token = supervisionToken;
			this.#goalSupervisor.progress(work.supervisionToken);
			result = await this.#nativeRuntime.execute(toolRequest, record, { lifecycleGeneration: work.lifecycleGeneration });
			// A greeting/read/reply does not grant later messages authority over finished work.
			if (deliveredConfirmationAuthority && !isConfirmationContextTool(toolRequest.tool)
					&& result?.executed !== false && ['SUCCEEDED', 'RUNNING'].includes(result?.state)) {
				this.#confirmationWorkAuthority.set(work.agentId, work.supervisionKey);
			}
			if (toolRequest.tool.kind === 'action' && toolRequest.tool.actionType === 'chat' && result?.state === 'SUCCEEDED') work.successfulChat = true;
			if (result?.advisory === 'program_planning_due') work.preparingProgram = { programId: result.programId, programVersion: result.programVersion };
			const current = this.#registry.get(work.agentId);
			if (current?.goalRevision === work.goalRevision
				&& this.#isConnectionEpochCurrent(work.connectionEpoch)
				&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
				if (toolRequest.tool.kind === 'task_plan' && toolRequest.tool.operation === 'intent' && result?.state === 'SUCCEEDED') {
					const intent = toolRequest.tool.intent;
					const label = this.#taskViews.snapshot(current).plan?.steps.find(step => step.id === intent.step)?.label ?? intent.step;
					this.#publishVerbose(current.agentId, current.goalRevision, 'decision', sanitizePublicNarrative(`${label}: ${intent.why}`), work.connectionEpoch);
				}
				if (result?.state === 'AWAITING_OPERATOR_CONFIRMATION') {
					// Waiting belongs to this goal lifecycle, not just the provider turn that
					// requested verification. Ordinary queued sightings cannot resume it.
					this.#nativeConfirmationWaits.set(record.agentId, { ...work.supervisionKey, facts: structuredClone(result.facts) });
					this.#confirmationWorkAuthority.delete(record.agentId);
					work.confirmationMessageBoundary = (work.request.deliveredPlayerRequests?.length ?? 0) + (work.steeredPlayerRequests?.length ?? 0);
					this.#confirmationActivity.delete(record.agentId);
					this.#goalSupervisor.terminate(work.supervisionKey);
				} else if (toolRequest.tool.kind === 'finish') {
					// Body actions while waiting (defending, eating, a player's extra request) leave the finished goal
					// awaiting confirmation; only a new finish result changes it. Clearing it restarted goal supervision,
					// which woke the model to redo the finished work.
					this.#nativeConfirmationWaits.delete(record.agentId);
					this.#confirmationWorkAuthority.delete(record.agentId);
					this.#confirmationActivity.delete(record.agentId);
				}
			}
			return result;
		} finally {
			if (supervisionToken !== null) {
				this.#goalSupervisor.end(supervisionToken, { progress: ['SUCCEEDED', 'COMPLETED'].includes(result?.state) });
			}
			if (work.toolSupervision.get(toolRequest.callId) === call) work.toolSupervision.delete(toolRequest.callId);
			if (work.toolSupervision.size === 0) { work.modelCallStartedAt = safeClockRead(this.#controlNow); work.callStreamingTool = false; }
			if (result !== undefined) this.#noteSurvivalDelivered(work, null, result);
			// An action stopped by the contact names it, with the exits, in its result. That alone makes the turn aware, even
			// when no observation has reported the contact yet or the body has already left it.
			if (['IN_LAVA', 'ON_FIRE'].includes(result?.reasonCode)) {
				work.hazardResultDelivered = true;
				this.#noteSurvivalAware(work);
				this.#noteHazardDelivered(work);
			}
			call.resolve();
			this.#goalSupervisor.progress(work.supervisionToken);
			const latest = this.#registry.get(work.agentId);
			if (!this.#stopping && !this.#closed && executesBody && latest?.goalRevision === work.goalRevision && latest.state === DynamicAgentState.ACTING
				&& ![...work.toolSupervision.values()].some((pending) => pending.executesBody)
				&& this.#isConnectionEpochCurrent(work.connectionEpoch)
				&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
				this.#registry.setState(latest.agentId, DynamicAgentState.PLANNING, { goalRevision: latest.goalRevision });
			}
		}
	}

	/**
	 * The model chose to adopt a player's request. Only a conversation-only turn (no active task)
	 * may do so, and only for a player message delivered in this turn, so neither the model nor a
	 * player talking to it can credit someone else. Minecraft owns the decision: it starts or
	 * resumes the goal through its normal lifecycle (goal_control follows), stages a translation
	 * draft, or refuses with a reason the model can relay. Nothing here starts work on its own.
	 */
	async #takeTask(work, tool) {
		if (work.request.conversationOnly !== true) {
			return { state: 'REJECTED', reasonCode: 'TASK_ALREADY_ACTIVE', executed: false,
				message: 'You already have a task. takeTask only adopts an operator request when you have none; treat an operator message as input to your current task and act on it now (awaiting operator confirmation never blocks this).' };
		}
		if (work.taskAdopted !== undefined) return { ...work.taskAdopted, executed: false };
		const received = [...(work.request.deliveredPlayerRequests ?? []), ...(work.steeredPlayerRequests ?? [])];
		// Only the operator gives tasks; Minecraft enforces this too.
		const delivered = received.filter((entry) => entry.operator === true);
		const senders = [...new Set(delivered.map((entry) => entry.sourceId))];
		if (tool.requesterId !== undefined && !senders.includes(tool.requesterId)) {
			const notOperator = received.some((entry) => entry.sourceId === tool.requesterId);
			return { state: 'REJECTED', reasonCode: notOperator ? 'NOT_OPERATOR' : 'UNKNOWN_REQUESTER', executed: false,
				message: notOperator ? 'That player is not the operator; only the operator gives you tasks.'
					: 'That player did not ask you anything in this conversation. Use the sourceId of a message you received.' };
		}
		if (tool.requesterId === undefined && senders.length !== 1) {
			return { state: 'REJECTED', reasonCode: senders.length === 0 ? (received.length > 0 ? 'NOT_OPERATOR' : 'NO_PLAYER_REQUEST') : 'REQUESTER_REQUIRED', executed: false,
				message: senders.length === 0
					? (received.length > 0 ? 'Only the operator gives you tasks; no operator message is in this conversation.' : 'No player asked you anything in this conversation. Only adopt a task the operator requested.')
					: `Several operators messaged you; pass requesterId (one of ${senders.join(', ')}) for the request you adopt.` };
		}
		const requesterId = tool.requesterId ?? senders[0];
		// A model paraphrase could launder another sender's directive through an operator greeting.
		const asked = delivered.filter((entry) => entry.sourceId === requesterId
			&& (tool.request === undefined || entry.text === tool.request)).at(-1);
		if (asked === undefined) return { state: 'REJECTED', reasonCode: 'REQUEST_MISMATCH', executed: false,
			message: 'request must exactly match delivered operator words; omit it for their latest message. Never credit another sender to the operator.' };
		const requestId = randomUUID();
		const outcome = new Promise((resolve) => {
			const timer = setTimeout(() => this.#settleTaskRequest(requestId, 'TASK_REQUEST_TIMEOUT', 'Minecraft did not answer in time; nothing started. Try again.'), this.#taskRequestTimeoutMs);
			timer.unref?.();
			this.#taskRequests.set(requestId, { agentId: work.agentId, resolve, timer });
		});
		try {
			await this.#sendForEpoch(work.connectionEpoch, 'task_request', work.agentId, {
				requestId, goalRevision: work.goalRevision, requesterId, conversationSequence: asked.sequence,
				request: asked.text, resume: tool.resume === true,
			});
		} catch (error) {
			this.#settleTaskRequest(requestId, 'TASK_REQUEST_UNSENT', 'The request could not be sent to Minecraft.');
			throw error;
		}
		const result = await outcome;
		this.#writeTrace('native_task_request', { agentId: work.agentId, goalRevision: work.goalRevision, status: result.status, reasonCode: result.reasonCode });
		if (result.status === 'rejected') {
			return { state: 'REJECTED', reasonCode: result.reasonCode, executed: false,
				message: `${result.message} Tell the player with say.` };
		}
		work.taskAdopted = result.status === 'pending'
			? { state: 'PENDING', reasonCode: result.reasonCode, goalRevision: result.goalRevision, requesterId,
				message: `${result.message} You may tell the player briefly with say, then end this turn; your task turn starts when the goal does.` }
			: { state: 'SUCCEEDED', reasonCode: result.reasonCode, goalRevision: result.goalRevision, requesterId,
				message: 'Minecraft accepted this as your task. End this turn now: your task turn starts immediately with every tool.' };
		return work.taskAdopted;
	}

	#settleTaskRequest(requestId, reasonCode, message) {
		const pending = this.#taskRequests.get(requestId);
		if (pending === undefined) return;
		this.#taskRequests.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve({ requestId, status: 'rejected', reasonCode, message, goalRevision: 0 });
	}

	#settleTaskRequests(agentId, reasonCode, message) {
		for (const [requestId, pending] of this.#taskRequests) {
			if (agentId === undefined || pending.agentId === agentId) this.#settleTaskRequest(requestId, reasonCode, message);
		}
	}

	async #completeNativeTurn(work, result) {
		await Promise.all([...work.toolSupervision.values()].map((call) => call.done));
		await this.#settleNativeSteering(work);
		if (this.#providerWork.get(work.agentId) !== work) {
			this.#goalSupervisor.end(work.supervisionToken, { scheduleRecovery: false });
			return null;
		}
		if (this.#isConnectionEpochCurrent(work.connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) await this.#commitNativeConversation(work.request);
		else this.#restoreNativeConversation(work.request);
		// Persistence is part of delivery. A failed commit still owns the exact
		// supervision entry, so failNativeTurn can arrange autonomous recovery.
		this.#goalSupervisor.end(work.supervisionToken, { progress: (result?.toolCalls ?? 0) > 0 });
		if (work.request.conversationOnly === true && this.#providerWork.get(work.agentId) === work) this.#goalSupervisor.terminate(work.supervisionKey);
		// Disk completion can race replacement work just like provider completion.
		if (this.#providerWork.get(work.agentId) !== work) return null;
		this.#providerWork.delete(work.agentId);
		this.#providerRetryAfter.delete(work.agentId);
		const pending = this.#pendingWithFoldedSteer(work);
		const completedAt = safeClockRead(this.#controlNow);
		const pendingWaitMs = work.pendingSince == null || completedAt === null || pending === null ? null : Math.max(0, Math.round(completedAt - work.pendingSince));
		const record = this.#registry.get(work.agentId);
		if (record !== null && record.goalRevision === work.goalRevision
				&& this.#isConnectionEpochCurrent(work.connectionEpoch)
				&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
			this.#writeTrace('native_turn_completed', { agentId: work.agentId, goalRevision: work.goalRevision, traceId: work.traceId, toolCalls: result?.toolCalls ?? 0,
				trigger: work.request.nativeEvent?.trigger ?? work.request.trigger ?? null, wakeEvent: work.request.nativeEvent?.event ?? null,
				...(work.inputBytes === undefined ? {} : { inputBytes: work.inputBytes }), ...turnUsageTraceFields(result?.usage),
				...(pendingWaitMs === null ? {} : { pendingWaitMs, pendingTrigger: pending?.trigger ?? null }) });
		}
		if (this.#reschedulePendingNativeTurn(pending)) return result;
		if (this.#isActiveNativeGoal(work) && this.#nativeRuntime.remindProgramDecision(record)) {
			this.#writeTrace('native_program_decision_followup', { agentId: work.agentId, goalRevision: work.goalRevision });
			return result;
		}
		if (work.request.nativeConversationDelivery?.omittedEntries > 0
			&& await work.request.nativeConversationDelivery.inbox.hasUnreadWake()
			&& this.#reschedulePendingNativeTurn({ ...work.request, conversationRetry: false })) return result;
		if (work.request.conversationOnly === true && work.request.dangerWake !== true && work.request.selfCareWake !== true && !work.successfulChat
				&& work.request.conversationRetry !== true && record !== null) {
			this.#scheduleNativeTurn(record, {
				...work.request,
				connectionEpoch: work.connectionEpoch,
				conversationRetry: true,
				retryInstruction: 'Your previous turn made no visible reply. Call say exactly once now.',
			});
			return result;
		}
		// A no-task turn (often a danger turn) ended: if the body is still low, the model may now recover.
		if (work.request.conversationOnly === true && record !== null && record.goalRevision === work.goalRevision
				&& this.#isConnectionEpochCurrent(work.connectionEpoch)
				&& this.#considerHealWake(record, this.#nativeRuntime.snapshotLive(work.agentId)?.observation ?? null, work.lifecycleGeneration, work.connectionEpoch)) return result;
		const awaitingConfirmation = record !== null && this.#awaitingNativeConfirmation(record, work.lifecycleGeneration);
		if (awaitingConfirmation) this.#goalSupervisor.terminate(work.supervisionKey);
		// A turn that started no body work while waiting returns the goal to plain waiting (no redo wakes).
		if (awaitingConfirmation && work.actedWhileAwaiting !== true) this.#confirmationActivity.delete(work.agentId);
		if (!awaitingConfirmation && this.#isActiveNativeGoal(work)) {
			this.#goalSupervisor.ensure(work.supervisionKey, (result?.toolCalls ?? 0) === 0 ? 'zero_tool_turn' : 'turn_completed');
		}
		return result;
	}

	async #failNativeTurn(work, error) {
		let recovery = classifyRecoveryFailure(error);
		let classification = recovery.retryable ? 'recoverable' : classifyNativeGoalError(error);
		this.#writeTrace('native_turn_failed', { agentId: work.agentId, goalRevision: work.goalRevision,
			errorCode: sanitizeDiagnosticErrorCode(error, { fallback: 'NATIVE_TURN_FAILED' }), classification });
		try {
			await this.#settleNativeSteering(work);
		} catch (steeringError) {
			error = steeringError;
			recovery = classifyRecoveryFailure(error);
			classification = recovery.retryable ? 'recoverable' : classifyNativeGoalError(error);
		} finally {
			this.#goalSupervisor.end(work.supervisionToken, { scheduleRecovery: classification !== 'stale' });
		}
		if (this.#providerWork.get(work.agentId) !== work) return null;
		this.#providerWork.delete(work.agentId);
		const pending = this.#pendingWithFoldedSteer(work);
		const record = this.#registry.get(work.agentId);
		const staleLifecycle = record?.goalRevision !== work.goalRevision
			|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
			|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration);
		if (staleLifecycle || this.#stopping || this.#closed) {
			if (work.request.conversationOnly === true) this.#goalSupervisor.terminate(work.supervisionKey);
			this.#reschedulePendingNativeTurn(pending);
			return null;
		}
		this.#restoreNativeConversation(work.request);
		if (classification === 'stale') {
			if (work.request.conversationOnly === true) this.#goalSupervisor.terminate(work.supervisionKey);
			this.#reschedulePendingNativeTurn(pending);
			return null;
		}
		if (this.#preparationHasRunningProgram(work, record)) {
			this.#writeTrace('native_preparation_failed_current_program_preserved', { agentId: work.agentId, goalRevision: work.goalRevision,
				errorCode: sanitizeDiagnosticErrorCode(error, { fallback: 'NATIVE_TURN_FAILED' }) });
			this.#goalSupervisor.ensure(work.supervisionKey, 'program_preparation_failed');
			// The mod fails the goal on agent_error, cancelling the program kept here; only a terminal error may end it.
			if (classification === 'terminal') await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
			else this.#publishVerbose(work.agentId, work.goalRevision, 'retry', 'The model turn ended early; the running program continues and its next event wakes the model.', work.connectionEpoch, {
				component: 'provider', boundary: 'planning', code: sanitizeDiagnosticErrorCode(error, { fallback: 'NATIVE_TURN_FAILED' }), state: 'retrying',
			});
			this.#reschedulePendingNativeTurn(pending);
			return null;
		}
		await this.#nativeRuntime.dispose(work.agentId, 'native_turn_failed');
		this.#nativeObservationSignatures.delete(work.agentId);
		if (classification === 'terminal') {
			this.#goalSupervisor.terminate(work.supervisionKey);
			if ([DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING].includes(record.state)) {
				this.#registry.setState(work.agentId, DynamicAgentState.ERROR, {
					goalRevision: work.goalRevision,
					error: { code: sanitizeDiagnosticErrorCode(error, { fallback: 'NATIVE_TURN_FAILED' }), message: sanitizeDiagnosticErrorMessage(error, { maxBytes: 2_048 }) },
				});
			}
			await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
		} else {
			if (work.request.conversationOnly === true) {
				this.#nativeConversationRecoveries.set(work.agentId, {
					supervisionKey: work.supervisionKey,
					request: work.request,
				});
			}
			this.#goalSupervisor.recover(work.supervisionKey, this.#recoveryDetails(work.agentId, {
				errorCode: recovery.code,
				recoveryKind: recovery.kind,
				nextProbeAtEpochMs: recovery.nextProbeAtEpochMs,
			}));
			this.#reschedulePendingNativeTurn(pending);
		}
		return null;
	}

	#reschedulePendingNativeTurn(request, { released = false } = {}) {
		if (request === null || request === undefined || this.#stopping || this.#closed) return false;
		const record = this.#registry.get(request.agentId);
		if (record === null || record.goalRevision !== request.goalRevision
				|| !this.#isConnectionEpochCurrent(request.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration)) return false;
		const eligible = request.conversationOnly === true
			? PARKED_NATIVE_STATES
			: [DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING, DynamicAgentState.DEAD];
		if (!this.#usesNativeTools(record) || !eligible.includes(record.state)) return false;
		if (!this.#nativePreparationIsCurrent(record, request) || this.#confirmationBlocksRequest(record, request)) return false;
		// An ordinary observation queued behind a turn that then started its own action is stale for the same reason.
		if (!protectedNativeWake(request) && request.conversationOnly !== true && request.nativeEvent?.event === 'observation'
				&& request.nativeEvent.trigger !== 'continuation' && request.nativeEvent.trigger !== DIMENSION_CHANGED_TRIGGER
				&& !(request.nativeConversationDelivery?.omittedEntries > 0) && this.#nativeRuntime.hasModelAction(record)
				&& !released && this.#holdWakeForModelAction(record, request)) return false;
		// Routine perception queued behind a turn that left a program running belongs to that program, exactly as a live
		// observation does: the program decides whether it needs the model (its decisions, end and danger still wake).
		if (!protectedNativeWake(request) && request.conversationOnly !== true && request.nativeEvent?.event === 'observation'
				&& PROGRAM_OWNED_PERCEPTION_TRIGGERS.has(request.nativeEvent.trigger ?? request.trigger)
				&& !(request.nativeConversationDelivery?.omittedEntries > 0) && !released && this.#nativeRuntime.hasProgram(record)) {
			this.#writeTrace('native_wake_left_to_program', { agentId: record.agentId, goalRevision: record.goalRevision, trigger: request.trigger ?? null });
			return false;
		}
		// Waking the model for any reason ends the hold; its named reason rides this wake only if the wake is generic.
		const resumed = this.#resumeDeferredWake(record, request);
		if (resumed !== request.trigger && request.nativeEvent?.event === 'observation' && request.nativeEvent.trigger !== 'continuation') {
			request = { ...request, trigger: resumed, nativeEvent: { ...request.nativeEvent, trigger: resumed } };
		}
		this.#scheduleNativeTurn(record, request);
		return true;
	}

	#isActiveNativeGoal(work) {
		if (this.#stopping || this.#closed) return false;
		const record = this.#registry.get(work.agentId);
		return record !== null
			&& !this.#awaitingNativeConfirmation(record, work.lifecycleGeneration)
			&& record.goalRevision === work.goalRevision
			&& this.#isConnectionEpochCurrent(work.connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)
			&& this.#usesNativeTools(record)
			&& [DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING, DynamicAgentState.DEAD].includes(record.state);
	}

	#scheduleInitialPlan(record, request) {
		if (!this.#isConnectionEpochCurrent(request.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration)) return;
		request = this.#afterProviderProbeDeadline(record, request);
		if (request === null) return;
		const existing = this.#providerWork.get(record.agentId);
		if (existing !== undefined) {
			if (existing.goalRevision !== record.goalRevision || existing.lifecycleGeneration !== request.lifecycleGeneration) {
				existing.pending = mergePlannerRequest(existing.pending, request);
				return;
			}
			if (request.priority === 'urgent' && existing.request.priority !== 'urgent') {
				// Retain the urgent payload before cancellation settles. The scheduler
				// may reject the queued turn immediately, so interruption alone cannot
				// be the handoff mechanism for the replacement request.
				existing.pending = mergePlannerRequest(existing.pending, request);
				void Promise.resolve(this.#planner.interrupt(record.agentId, 'Urgent planning trigger')).catch(() => {});
				return;
			}
			existing.pending = mergePlannerRequest(existing.pending, request);
			return;
		}
		if (this.#scheduler.hasScheduled(record.agentId)) return;
		if (request.priority !== 'urgent' && request.receiptMonotonicMs !== null && (this.#providerRetryAfter.get(record.agentId) ?? 0) > request.receiptMonotonicMs) return;
		void this.#sendForEpoch(request.connectionEpoch, 'planning_state', record.agentId, { goalRevision: record.goalRevision, state: DynamicAgentState.PLANNING })
			.catch((error) => this.#reportAgentError(record.agentId, error, request.connectionEpoch));
		void this.#scheduleProviderPlan(record, request, { preserveState: false, kind: 'initial' });
	}

	#afterProviderProbeDeadline(record, request) {
		const probeDeadline = this.#providerProbeDeadlines.get(record.agentId);
		const now = safeClockRead(this.#epochNow);
		if (probeDeadline !== undefined && now !== null && now < probeDeadline) {
			const deferred = this.#deferredProviderRecovery.get(record.agentId);
			this.#deferredProviderRecovery.set(record.agentId, mergePlannerRequest(deferred, request));
			return null;
		}
		if (probeDeadline !== undefined) {
			this.#providerProbeDeadlines.delete(record.agentId);
			const deferred = this.#deferredProviderRecovery.get(record.agentId);
			this.#deferredProviderRecovery.delete(record.agentId);
			request = mergePlannerRequest(deferred, request);
		}
		return request;
	}

	#scheduleProviderPlan(record, request, { preserveState = false, kind = 'initial' } = {}) {
		const lifecycleGeneration = request.lifecycleGeneration ?? this.#lifecycleGeneration(record.agentId);
		const connectionEpoch = request.connectionEpoch ?? this.#connectionEpoch;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, lifecycleGeneration)) return Promise.resolve(null);
		const existing = this.#providerWork.get(record.agentId);
		if (existing !== undefined) {
			if (existing.goalRevision !== record.goalRevision || existing.lifecycleGeneration !== lifecycleGeneration
					|| existing.connectionEpoch !== connectionEpoch) {
				existing.pending = mergePlannerRequest(existing.pending, request);
				return existing.promise;
			}
			existing.pending = mergePlannerRequest(existing.pending, request);
			return existing.promise;
		}
		const work = {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			lifecycleGeneration,
			connectionEpoch,
			kind,
			preserveState,
			request,
			contextSnapshot: this.#contextSnapshot(record),
			pending: null,
			traceId: request.traceId ?? planningTraceId(record.agentId, record.goalRevision, lifecycleGeneration, kind),
			promise: null,
		};
		this.#providerWork.set(record.agentId, work);
		const verboseReporter = this.#verboseReporter(record.agentId, record.goalRevision, { connectionEpoch });
		const providerRequest = {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			preserveState,
			recoverySummary: record.lastSummary,
			input: request.input,
			prepareInput: request.prepareInput ?? null,
			traceId: work.traceId,
			planningPriority: request.priority,
			priority: request.priority,
			onVerbose: verboseReporter,
		};
		work.promise = Promise.resolve()
			.then(() => this.#planner.requestPlan(providerRequest))
			.then((decision) => this.#completeProviderPlan(work, decision), (error) => this.#failProviderPlan(work, record, error))
			.finally(() => verboseReporter.dispose());
		return work.promise;
	}

	async #completeProviderPlan(work, decision) {
		if (this.#providerWork.get(work.agentId) !== work) return null;
		const record = this.#registry.get(work.agentId);
		if (record === null || record.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
			const pending = work.pending;
			this.#providerWork.delete(work.agentId);
			this.#reschedulePendingProviderPlan(pending);
			return null;
		}
		let runtime = null;
		try {
			this.#programRuntimeEpochs.set(record.agentId, work.connectionEpoch);
			runtime = await this.#programRuntime.installDecision(record, decision, {
				observation: work.request.observation,
				eventSequence: work.request.eventSequence,
				traceId: work.traceId,
			});
		} catch (error) {
			if (this.#providerWork.get(work.agentId) !== work) return null;
			this.#providerWork.delete(work.agentId);
			const current = this.#registry.get(work.agentId);
			const stale = current?.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration);
			if (this.#programRuntimeEpochs.get(work.agentId) === work.connectionEpoch) this.#programRuntimeEpochs.delete(work.agentId);
			if (!stale) await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
			if (stale || work.pending?.priority === 'urgent') this.#reschedulePendingProviderPlan(work.pending);
			return null;
		}
		if (this.#providerWork.get(work.agentId) !== work) return null;
		const current = this.#registry.get(work.agentId);
		if (current?.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) {
			const pending = work.pending;
			this.#providerWork.delete(work.agentId);
			if (this.#programRuntimeEpochs.get(work.agentId) === work.connectionEpoch) {
				this.#programRuntime.dispose(work.agentId);
				this.#programRuntimeEpochs.delete(work.agentId);
			}
			this.#reschedulePendingProviderPlan(pending);
			return null;
		}
		const pending = work.pending;
		this.#providerWork.delete(work.agentId);
		this.#providerRetryAfter.delete(work.agentId);
		this.#publishVerbose(record.agentId, record.goalRevision, 'decision', verboseDecisionSummary(decision), work.connectionEpoch);
		if (runtime === null) return runtime;
		const latest = this.#registry.get(work.agentId);
		if (latest === null || latest.goalRevision !== work.goalRevision
				|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration)) return runtime;
		if (decision.contextReceipt != null) this.#rememberAcceptedContextCursor(latest, decision.contextReceipt);
		this.#flushPendingAttention(latest, work.connectionEpoch);
		if (pending === null) return runtime;
		try {
			if (pending.observation !== undefined) {
				await this.#programRuntime.onObservation(latest, {
					observation: pending.observation,
					eventSequence: pending.eventSequence,
					attention: pending.attention,
					priority: pending.priority,
					trigger: pending.trigger,
				});
			} else if (pending.attention) {
				this.#programRuntime.notifyAttention(latest, { priority: pending.priority, trigger: pending.trigger });
			}
		} catch (error) {
			await this.#reportAgentError(work.agentId, error, work.connectionEpoch);
		}
		return runtime;
	}

	async #failProviderPlan(work, record, error) {
		if (this.#providerWork.get(work.agentId) !== work) return null;
		const current = this.#registry.get(work.agentId);
		const stale = current?.goalRevision !== work.goalRevision
			|| !this.#isConnectionEpochCurrent(work.connectionEpoch)
			|| !this.#isLifecycleGenerationCurrent(work.agentId, work.lifecycleGeneration);
		this.#promotePendingAttention(work, current);
		const pending = work.pending;
		this.#providerWork.delete(work.agentId);
		const urgentRecovery = pending?.priority === 'urgent';
		const recovery = classifyRecoveryFailure(error);
		const quietRetry = recovery.quiet;
		if (!stale && recovery.retryable) {
			if (quietRetry) {
				const retryAt = safeClockRead(this.#controlNow);
				if (retryAt !== null) this.#providerRetryAfter.set(record.agentId, retryAt + EMPTY_TURN_RETRY_DELAY_MS);
			}
			this.#publishVerbose(record.agentId, record.goalRevision, 'retry', verboseRecoveryMessage(recovery), work.connectionEpoch, {
				component: 'provider', boundary: recovery.kind ?? 'planning', code: recovery.code ?? 'PROVIDER_RETRY', state: 'retrying',
			});
			try {
				const latest = this.#registry.get(record.agentId);
				if (latest?.state === DynamicAgentState.ERROR) this.#registry.setState(record.agentId, DynamicAgentState.STARTING, { goalRevision: record.goalRevision });
				if (this.#registry.get(record.agentId)?.state === DynamicAgentState.STARTING) this.#registry.setState(record.agentId, DynamicAgentState.PLANNING, { goalRevision: record.goalRevision });
			} catch (stateError) {
				void this.#reportAgentError(record.agentId, stateError, work.connectionEpoch);
			}
			const session = typeof this.#codexService.getAgent === 'function' ? this.#codexService.getAgent(record.agentId) : null;
			if (session !== null && typeof this.#codexService.replaceAgent === 'function') {
				try {
					await this.#codexService.replaceAgent(record, {
						recoverySummary: 'provider_plan_recovery',
						controlProtocol: 'arena_script',
						...(Number.isSafeInteger(session.sessionGeneration) ? { expectedSessionGeneration: session.sessionGeneration } : {}),
					});
				} catch (replacementError) {
					this.#writeTrace('provider_session_replacement_failed', {
						agentId: record.agentId,
						goalRevision: record.goalRevision,
						errorCode: replacementError?.code ?? 'SESSION_REPLACEMENT_FAILED',
					});
				}
			}
			const recoveryDetails = this.#recoveryDetails(record.agentId, {
				errorCode: recovery.code,
				recoveryKind: recovery.kind,
				nextProbeAtEpochMs: recovery.nextProbeAtEpochMs,
			});
			const supervisionKey = this.#supervisionKey(record, work.lifecycleGeneration);
			this.#goalSupervisor.activate(supervisionKey);
			this.#goalSupervisor.recover(supervisionKey, recoveryDetails);
			this.#reschedulePendingProviderPlan(pending);
			return null;
		}
		if (!stale && !urgentRecovery) await this.#reportAgentError(record.agentId, error, work.connectionEpoch);
		if (!stale && quietRetry && current?.state === DynamicAgentState.ERROR) {
			try {
				this.#registry.setState(record.agentId, DynamicAgentState.STARTING, { goalRevision: record.goalRevision });
			} catch (stateError) {
				void this.#reportAgentError(record.agentId, stateError, work.connectionEpoch);
				return null;
			}
		}
		if (urgentRecovery || stale) this.#reschedulePendingProviderPlan(pending);
		return null;
	}

	#promotePendingAttention(work, record) {
		const attention = this.#pendingAttention.get(work.agentId);
		if (record === null || attention?.goalRevision !== work.goalRevision) return;
		const request = work.request;
		const prepared = buildPlannerRequest({
			agent: { agentId: record.agentId, provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort },
			goal: record.currentGoal,
			goalRevision: record.goalRevision,
			attentionPriority: 'urgent',
			attentionTrigger: attention.trigger,
			observation: request.observation,
		}, this.#plannerContext(record.agentId));
		work.pending = mergePlannerRequest(work.pending, {
			...request,
			attention: true,
			priority: 'urgent',
			trigger: attention.trigger,
			preserveState: false,
			...prepared,
		});
		this.#pendingAttention.delete(work.agentId);
	}

	#reschedulePendingProviderPlan(request) {
		if (request === null || request === undefined) return;
		const record = this.#registry.get(request.agentId);
		if (record === null || record.goalRevision !== request.goalRevision
				|| !this.#isConnectionEpochCurrent(request.connectionEpoch)
				|| !this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration)) return;
		if (record.state === DynamicAgentState.ERROR && request.preserveState !== true) {
			try {
				this.#registry.setState(record.agentId, DynamicAgentState.STARTING, { goalRevision: record.goalRevision });
			} catch (error) {
				void this.#reportAgentError(record.agentId, error, request.connectionEpoch);
				return;
			}
		}
		request = this.#afterProviderProbeDeadline(record, request);
		if (request === null) return;
		void this.#scheduleProviderPlan(record, request, { preserveState: request.preserveState === true, kind: request.kind ?? 'initial' });
	}

	#unbindBridge() {
		for (const [event, listener] of this.#listeners) this.#bridge.off(event, listener);
		this.#listeners = [];
		if (typeof this.#codexService.off === 'function') {
			for (const [event, listener] of this.#providerListeners) this.#codexService.off(event, listener);
		}
		this.#providerListeners = [];
	}

	#beginGoalControlInterruption(message, connectionEpoch) {
		let reason = null;
		if (['stop', 'disconnect', 'dead'].includes(message.payload.operation)) reason = `Goal ${message.payload.operation}`;
		// A turn woken by danger before the goal arrived can no longer act: every body call it makes is STALE_PLAN. Live
		// rooms spawn mobs while the goal is translated (5-9 s), and the goal turn waited 3-20 s for that turn to wind down.
		const olderTurn = this.#providerWork.get(message.agentId);
		if (message.payload.operation === 'start' && olderTurn !== undefined && olderTurn.goalRevision < (this.#registry.get(message.agentId)?.goalRevision ?? -1)) reason = 'Goal started';
		if (message.payload.operation === 'steer') reason = 'Goal steered';
		if (message.payload.operation === 'replace') reason = 'Goal replaced';
		if (message.payload.operation === 'complete') reason = 'Goal completed';
		if (reason === null) return;
		try {
			Promise.resolve(this.#planner.interrupt(message.agentId, reason)).catch((error) => this.#reportAgentError(message.agentId, error, connectionEpoch));
		} catch (error) {
			void this.#reportAgentError(message.agentId, error, connectionEpoch);
		}
	}

	#lifecycleGeneration(agentId) {
		return this.#lifecycleGenerations.get(agentId) ?? 0;
	}

	#supervisionKey(record, lifecycleGeneration = this.#lifecycleGeneration(record.agentId)) {
		return {
			agentId: record.agentId,
			goalRevision: record.goalRevision,
			lifecycleGeneration,
			sessionEpoch: this.#connectionEpoch,
			profileFingerprint: profileFingerprint(record),
		};
	}

	#recoveryDetails(agentId, { errorCode, recoveryKind, nextProbeAtEpochMs }) {
		const deadline = Number.isFinite(nextProbeAtEpochMs) && nextProbeAtEpochMs >= 0 ? nextProbeAtEpochMs : null;
		if (deadline === null) this.#providerProbeDeadlines.delete(agentId);
		else this.#providerProbeDeadlines.set(agentId, deadline);
		const now = safeClockRead(this.#epochNow);
		return {
			errorCode,
			...(recoveryKind === undefined ? {} : { recoveryKind }),
			...(deadline === null ? {} : {
				nextProbeAtEpochMs: deadline,
				retryDelayMs: now === null ? 0 : Math.max(0, deadline - now),
			}),
		};
	}

	#retireGoalSupervision(record, operation) {
		const key = this.#supervisionKey(record);
		if (['disconnect', 'dead'].includes(operation)) this.#goalSupervisor.suspend(key);
		else this.#goalSupervisor.terminate(key);
	}

	#advanceLifecycleGeneration(agentId) {
		this.#latestActionDispatches.delete(agentId);
		// Release unacknowledged reservations before a replacement consumes them.
		// Late callbacks have no reservation identity left to commit or rewind.
		const work = this.#providerWork.get(agentId);
		if (work?.kind === 'native') {
			this.#restoreNativeConversation(work.steerRequest);
			this.#restoreNativeConversation(work.request);
		}
		this.#pendingConversationInboxes.get(agentId)?.fence();
		this.#inspections.cancel(agentId);
		this.#memorySummaries.delete(agentId);
		const next = this.#lifecycleGeneration(agentId) + 1;
		this.#lifecycleGenerations.set(agentId, next);
		return next;
	}

	#invalidateLifecycleWork(message) {
		if (['queue', 'dequeue'].includes(message.payload.operation)) return;
		const current = this.#registry.get(message.agentId);
		if (current !== null && message.payload.goalRevision <= current.goalRevision) return;
		this.#invalidateAcceptedLifecycle(message.agentId);
	}

	#invalidateAcceptedLifecycle(agentId) {
		this.#pendingAttention.delete(agentId);
		this.#dropDeferredWake(agentId);
		this.#wakeFilter.drop(agentId);
		this.#attentionFlushes.delete(agentId);
		this.#contextCursors.delete(agentId);
		this.#nativeObservationSignatures.delete(agentId);
		this.#hazardContacts.delete(agentId);
		this.#survivalQuietSince.delete(agentId);
		this.#supervisedObservationRequests.delete(agentId);
		this.#nativeConversationRecoveries.delete(agentId);
		this.#providerProbeDeadlines.delete(agentId);
		this.#deferredProviderRecovery.delete(agentId);
		this.#nativeWorldSignals.delete(agentId);
		// A death's unread assessment outlives the revision changes a respawn brings (see #pendingAssessment); only the
		// delivery that was in flight is void now.
		const eventContext = this.#eventContexts.get(agentId);
		if (eventContext?.pending > 0) eventContext.inFlight = null;
		else this.#eventContexts.delete(agentId);
		this.#nativeConfirmationWaits.delete(agentId);
		this.#confirmationActivity.delete(agentId);
		this.#confirmationWorkAuthority.delete(agentId);
		this.#advanceLifecycleGeneration(agentId);
	}

	#rememberPendingAttention(agentId, goalRevision, attention) {
		const previous = this.#pendingAttention.get(agentId);
		if (previous === undefined || previous.goalRevision !== goalRevision) {
			this.#pendingAttention.set(agentId, { goalRevision, ...attention });
			return;
		}
		const merged = mergeAttentionTrigger(previous, attention);
		this.#pendingAttention.set(agentId, { goalRevision, ...merged });
	}

	#schedulePendingAttentionFlush(record) {
		if (!this.#programRuntime.hasCurrent(record)) return;
		const existing = this.#attentionFlushes.get(record.agentId);
		if (existing?.goalRevision === record.goalRevision) return;
		const token = { goalRevision: record.goalRevision, connectionEpoch: this.#connectionEpoch };
		this.#attentionFlushes.set(record.agentId, token);
		setImmediate(() => {
			if (this.#attentionFlushes.get(record.agentId) !== token) return;
			this.#attentionFlushes.delete(record.agentId);
			if (this.#stopping || this.#closed || !this.#isConnectionEpochCurrent(token.connectionEpoch)) return;
			const current = this.#registry.get(record.agentId);
			const pending = this.#pendingAttention.get(record.agentId);
			if (current === null || pending?.goalRevision !== token.goalRevision || current.goalRevision !== token.goalRevision) return;
			this.#flushPendingAttention(current, token.connectionEpoch);
		});
	}

	#flushPendingAttention(record, connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
		const pending = this.#pendingAttention.get(record.agentId);
		if (pending?.goalRevision !== record.goalRevision || !this.#programRuntime.hasCurrent(record)) return;
		try {
			const notified = this.#programRuntime.notifyAttention(record, { priority: pending.priority, trigger: pending.trigger });
			if (notified !== null) this.#pendingAttention.delete(record.agentId);
		} catch (error) {
			void this.#reportAgentError(record.agentId, error, connectionEpoch);
		}
	}

	#isLifecycleGenerationCurrent(agentId, generation) {
		return this.#lifecycleGeneration(agentId) === generation;
	}

	#enqueueAgent(agentId, operation, { waitForReconciliation = true, connectionEpoch = this.#connectionEpoch, coalesceKey = null, terminal = false, terminalKey = null, transactional = false, onAdmitted = null } = {}) {
		const releaseCapacity = this.#reserveAgentOperation(agentId);
		let resolve;
		let reject;
		const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
		const waiter = {
			resolve: (value) => { releaseCapacity(); resolve(value); },
			reject: (error) => { releaseCapacity(); reject(error); },
		};
		let queue = this.#agentOperations.get(agentId);
		if (queue === undefined) {
			queue = { items: [], drainPromise: null };
			this.#agentOperations.set(agentId, queue);
		}
		const tail = queue.items.at(-1);
		if (coalesceKey !== null && tail?.coalesceKey === coalesceKey) {
			for (const superseded of tail.waiters) superseded.resolve(undefined);
			tail.operation = operation;
			tail.waitForReconciliation = waitForReconciliation;
			tail.connectionEpoch = connectionEpoch;
			tail.transactional = transactional;
			tail.waiters = [waiter];
		} else {
			const pendingTerminal = terminalKey === null ? undefined : queue.items.find((item) => item.terminal === true
				&& item.terminalKey === terminalKey && item.connectionEpoch === connectionEpoch);
			if (terminal && pendingTerminal !== undefined) {
				// An exact replay shares reconciliation and its durable-before-ACK outcome.
				// Distinct receipts remain queued, bounded by the admission reservations.
				pendingTerminal.waiters.push(waiter);
				promise.catch((error) => this.#reportAgentError(agentId, error, connectionEpoch));
				return promise;
			}
			const ordinaryPending = queue.items.filter((item) => item.terminal !== true && item.transactional !== true).length;
			const transactionalPending = queue.items.filter((item) => item.transactional === true).length;
			const capacity = transactional ? this.#maxPendingAgentTransactions : this.#maxPendingAgentOperations;
			const pending = transactional ? transactionalPending : ordinaryPending;
			if (!terminal && pending >= capacity) {
				const lane = transactional ? 'transactional' : 'ordinary';
				const error = codedRuntimeError('AGENT_EVENT_BACKPRESSURE', `Agent '${agentId}' has ${capacity} pending ${lane} coordinator events`);
				waiter.reject(error);
				promise.catch((caught) => this.#reportAgentError(agentId, caught, connectionEpoch));
				return promise;
			}
			try {
				if (onAdmitted !== null) onAdmitted();
			} catch (error) {
				waiter.reject(error);
				promise.catch((caught) => this.#reportAgentError(agentId, caught, connectionEpoch));
				if (queue.items.length === 0 && this.#agentOperations.get(agentId) === queue) this.#agentOperations.delete(agentId);
				return promise;
			}
			queue.items.push({ operation, waitForReconciliation, connectionEpoch, coalesceKey, terminal, terminalKey, transactional, waiters: [waiter] });
		}
		promise.catch((error) => this.#reportAgentError(agentId, error, connectionEpoch));
		if (queue.drainPromise === null) queue.drainPromise = Promise.resolve().then(() => this.#drainAgentOperations(agentId, queue));
		return promise;
	}

	async #drainAgentOperations(agentId, queue) {
		while (queue.items.length > 0) {
			const item = queue.items.shift();
			try {
				if (this.#isConnectionEpochCurrent(item.connectionEpoch) && item.waitForReconciliation) await this.#reconciliation;
				const value = this.#isConnectionEpochCurrent(item.connectionEpoch) ? await item.operation() : undefined;
				for (const waiter of item.waiters) waiter.resolve(value);
			} catch (error) {
				for (const waiter of item.waiters) waiter.reject(error);
			}
		}
		if (this.#agentOperations.get(agentId) === queue) this.#agentOperations.delete(agentId);
	}

	#reserveAgentOperation(agentId) {
		const agentCount = this.#agentOperationCounts.get(agentId) ?? 0;
		if (this.#totalAgentOperations >= this.#connectionOperationCap) {
			throw new ProtocolV2Error('CONNECTION_INBOUND_BACKPRESSURE', 'Coordinator inbound operation queue is full');
		}
		if (agentCount >= this.#agentOperationCap) {
			throw new ProtocolV2Error('AGENT_INBOUND_BACKPRESSURE', `Coordinator inbound operation queue for agent '${agentId}' is full`);
		}
		this.#totalAgentOperations++;
		this.#agentOperationCounts.set(agentId, agentCount + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#totalAgentOperations = Math.max(0, this.#totalAgentOperations - 1);
			const pending = this.#agentOperationCounts.get(agentId) ?? 0;
			if (pending <= 1) this.#agentOperationCounts.delete(agentId);
			else this.#agentOperationCounts.set(agentId, pending - 1);
		};
	}

	#run(operation, connectionEpoch = this.#connectionEpoch, { requireConnected = true } = {}) {
		return Promise.resolve().then(() => {
			const current = requireConnected
				? this.#isConnectionEpochCurrent(connectionEpoch)
				: connectionEpoch === this.#connectionEpoch;
			return current ? operation() : undefined;
		}).catch((error) => this.emit('runtimeError', error));
	}

	async #sendForEpoch(connectionEpoch, type, agentId, payload) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) {
			throw codedRuntimeError('STALE_CONNECTION_EPOCH', `Bridge connection epoch ${connectionEpoch ?? 'unknown'} is no longer active`);
		}
		return this.#bridge.send(type, agentId, payload, { connectionEpoch });
	}

	async #acknowledgeActionResult(message, connectionEpoch) {
		if (typeof this.#bridge.acknowledgeActionResult === 'function') {
			await this.#bridge.acknowledgeActionResult(message.agentId, message.payload, { connectionEpoch });
		}
	}

	#queueReceiptReconciliation(message, connectionEpoch) {
		const key = JSON.stringify([connectionEpoch, message.agentId, message.payload]);
		const existing = this.#receiptReconciliations.get(key);
		if (existing !== undefined) return existing;
		// Separate capacity from gameplay ingress: a stalled disk must not consume
		// every observation/control slot. Overflow remains unacknowledged upstream.
		const agentPending = [...this.#receiptReconciliations.values()].filter((entry) => entry.message.agentId === message.agentId).length;
		if (this.#receiptReconciliations.size >= this.#connectionOperationCap || agentPending >= this.#agentOperationCap) {
			this.#emitRuntimeError(codedRuntimeError('RECEIPT_BACKPRESSURE', 'Receipt reconciliation is full; server must retain this unacknowledged result'));
			return null;
		}
		const predecessor = [...this.#receiptReconciliations.values()].findLast((entry) => entry.message.agentId === message.agentId && entry.connectionEpoch === connectionEpoch);
		const receipt = { key, message: { agentId: message.agentId, payload: structuredClone(message.payload) }, connectionEpoch, pending: null, retry: null, failures: 0, durable: false, done: null, resolve: null, predecessor: predecessor?.done };
		receipt.done = new Promise((resolve) => { receipt.resolve = resolve; });
		this.#receiptReconciliations.set(key, receipt);
		return receipt;
	}

	#retireReceiptReconciliations() {
		for (const receipt of this.#receiptReconciliations.values()) {
			clearTimeout(receipt.retry);
			receipt.resolve();
			// In-flight I/O remains tracked for bounded shutdown until it settles.
			if (receipt.pending === null) this.#receiptReconciliations.delete(receipt.key);
		}
	}

	#reconcileReceipt(receipt) {
		if (receipt === null || receipt.pending !== null || receipt.retry !== null || this.#stopping || this.#closed) return;
		const { message, connectionEpoch } = receipt;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) {
			this.#receiptReconciliations.delete(receipt.key);
			receipt.resolve();
			return;
		}
		receipt.pending = Promise.resolve().then(async () => {
			await receipt.predecessor;
			if (this.#stopping || this.#closed || !this.#isConnectionEpochCurrent(connectionEpoch)) {
				this.#receiptReconciliations.delete(receipt.key);
				receipt.resolve();
				return;
			}
			if (!receipt.durable) {
				if (message.payload.actionType !== undefined) {
					const dispatch = await this.#playerMemory.notebook.findReceipt(message.agentId, { actionId: message.payload.actionId });
					if (dispatch?.actionType !== message.payload.actionType) throw codedRuntimeError('UNCORRELATED_ACTION_RECEIPT', 'Terminal action type does not match its durable dispatch; withholding ACK');
				}
				const stored = await this.#playerMemory.recordResult({ agentId: message.agentId, goalRevision: message.payload.goalRevision }, message.payload);
				if (stored !== true) throw codedRuntimeError('UNCORRELATED_ACTION_RECEIPT', 'No authoritative dispatch matches the terminal receipt; withholding ACK');
				receipt.durable = true;
				if (this.#isConnectionEpochCurrent(connectionEpoch)) this.#memorySummaries.delete(message.agentId);
			}
			if (!this.#stopping && !this.#closed && this.#isConnectionEpochCurrent(connectionEpoch)) await this.#acknowledgeActionResult(message, connectionEpoch);
			this.#receiptReconciliations.delete(receipt.key);
			receipt.resolve();
		}).catch((error) => {
			if (error?.code === 'UNCORRELATED_ACTION_RECEIPT' || ['RECEIPT_CONFLICT', 'RECEIPT_WORLD_REQUIRED'].includes(error?.message)) {
				// Missing or conflicting durable authority cannot be repaired by retrying
				// this payload. Leave it unacknowledged on the server, but release the
				// local queue so later, correctly correlated receipts can be persisted.
				this.#emitRuntimeError(error);
				this.#receiptReconciliations.delete(receipt.key);
				receipt.resolve();
				return;
			}
			// Storage errors are operational evidence, not failed gameplay. Keep the
			// exact receipt and retry without cancelling already-authorized work.
			receipt.failures++;
			this.#emitRuntimeError(error);
			if (!this.#stopping && !this.#closed && this.#isConnectionEpochCurrent(connectionEpoch)) {
				receipt.retry = setTimeout(() => { receipt.retry = null; this.#reconcileReceipt(receipt); }, Math.min(5_000, 100 * 2 ** Math.min(receipt.failures - 1, 6)));
				receipt.retry.unref?.();
			} else { this.#receiptReconciliations.delete(receipt.key); receipt.resolve(); }
		}).finally(() => { receipt.pending = null; });
	}

	async #sendRuntimeMessage(kind, type, agentId, payload) {
		const epochs = kind === 'native' ? this.#nativeRuntimeEpochs : this.#programRuntimeEpochs;
		const connectionEpoch = epochs.get(agentId);
		if (type === 'action_cancel' && !this.#isConnectionEpochCurrent(connectionEpoch)) return null;
		if (type === 'action_command' && this.#isConnectionEpochCurrent(connectionEpoch)) {
			// Both execution modes pass here. One latest dispatch per agent is enough
			// for active correlation; historical receipts still use durable authority.
			this.#latestActionDispatches.set(agentId, { actionId: payload.actionId, goalRevision: payload.goalRevision, actionType: payload.actionType, connectionEpoch });
		}
		if (kind === 'program' && type === 'action_command') {
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) throw Object.assign(new Error('Action belongs to an obsolete connection'), { code: 'STALE_SESSION' });
			await this.#playerMemory.recordDispatch(this.#registry.assertCurrentRevision(agentId, payload.goalRevision), payload);
		}
		if (kind === 'native' && type === 'action_command') {
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) throw codedRuntimeError('STALE_SESSION', 'Action belongs to an obsolete connection');
			const record = this.#registry.assertCurrentRevision(agentId, payload.goalRevision);
			if (!this.#nativeRuntime.hasCurrent(record)) {
				const lifecycleGeneration = this.#lifecycleGeneration(agentId);
				// Conversation replies can precede the first world observation. Retain
				// their exact dispatch in a durable transport-session scope. The
				// ephemeral "session:" notebook namespace intentionally never reaches
				// disk; this separate scope is not an observed world or model memory.
				await this.#playerMemory.notebook.recordDispatch(agentId, {
					worldId: `dispatch-session:${this.#playerMemory.sessionId}`,
					actionId: payload.actionId, goalRevision: payload.goalRevision,
					actionType: payload.actionType, arguments: payload.arguments,
				});
				if (!this.#isLifecycleGenerationCurrent(agentId, lifecycleGeneration)
					|| this.#nativeRuntime.isActionResultStale(record, payload)) throw codedRuntimeError('STALE_PLAN', 'Native action lifecycle ended before bridge send');
				this.#registry.assertCurrentRevision(agentId, payload.goalRevision);
			}
			if (this.#usesNativeTools(record) && typeof payload.arguments?.targetId === 'string') {
				this.#trackOwnBreak(record, this.#lifecycleGeneration(agentId), connectionEpoch, (state) => noteCombatDispatch(state, payload.actionId, payload.actionType, payload.arguments));
			}
			const target = payload.actionType === 'break_block' ? blockPosition(payload.arguments) : null;
			if (target !== null && this.#usesNativeTools(record)) {
				this.#trackOwnBreak(record, this.#lifecycleGeneration(agentId), connectionEpoch, (state) => startOwnBreak(state, payload.actionId, target));
			}
		}
		return this.#sendForEpoch(connectionEpoch, type, agentId, payload);
	}

	async #reportAgentError(agentId, error, connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
		try {
			const verboseRecord = this.#registry.get(agentId);
			if (QUIET_LIFECYCLE_ERRORS.has(error?.code)) return;
			if (classifyRecoveryFailure(error).quiet) {
				// App-server transport silence is retried from the next fresh observation.
				// It is not a world-action failure that the player or agent must repair.
				if (verboseRecord !== null) this.#publishVerbose(agentId, verboseRecord.goalRevision, 'retry', 'Provider output was incomplete; retrying from the next fresh observation.', this.#connectionEpoch, {
					component: 'provider', boundary: 'planning', code: String(error?.code ?? 'EMPTY_PROVIDER_TURN'), state: 'retrying',
				});
				const retryAt = safeClockRead(this.#controlNow);
				if (retryAt === null) this.#providerRetryAfter.delete(agentId);
				else this.#providerRetryAfter.set(agentId, retryAt + EMPTY_TURN_RETRY_DELAY_MS);
				return;
			}
			if (verboseRecord !== null) this.#publishVerbose(agentId, verboseRecord.goalRevision, 'error', verboseErrorMessage(error), this.#connectionEpoch, {
				component: 'coordinator', boundary: 'agent_work', code: String(error?.code ?? 'COORDINATOR_ERROR'), state: 'degraded',
			});
			this.#emitRuntimeError(error);
			if (!this.#bridge.ready || !this.#registry.has(agentId)) return;
			const record = this.#registry.get(agentId);
			try {
				await this.#sendForEpoch(connectionEpoch, 'agent_error', agentId, {
					goalRevision: record.goalRevision,
					code: sanitizeDiagnosticErrorCode(error, { fallback: 'COORDINATOR_ERROR' }),
					message: sanitizeDiagnosticErrorMessage(error, { maxBytes: 2_048 }),
				});
			} catch (reportError) {
				if (!QUIET_LIFECYCLE_ERRORS.has(reportError?.code)) this.#emitRuntimeError(reportError);
			}
		} catch (reportFailure) {
			this.#emitRuntimeError(reportFailure);
		}
	}

	#emitRuntimeError(error) {
		try { this.emit('runtimeError', error); }
		catch { /* reporting must never reject agent control work */ }
	}

	#writeTrace(event, fields) {
		this.#bodyPace.note(event, fields);
		if (this.#traceWriter === null) return;
		try {
			Promise.resolve(this.#traceWriter.write(event, fields)).catch(() => {});
			if (typeof this.#traceWriter.writeDiagnostic === 'function') Promise.resolve(this.#traceWriter.writeDiagnostic(event, fields)).catch(() => {});
		} catch { /* diagnostics cannot interrupt agent control */ }
	}

	#verboseReporter(agentId, goalRevision, { allowPublicAgentMessage = false, publicActivity = true, connectionEpoch = this.#connectionEpoch } = {}) {
		let publishedAgentMessage = false, qualityMessageCaptured = false;
		const reporter = (stage, message) => {
			try {
				if (stage === 'provider_event') { this.#traceProviderEvent(agentId, goalRevision, message); this.#noteProviderLimitEvent(agentId, message); return; }
				// Usage statistics and account limits are per agent and per account, independent of the goal revision.
				if (stage === 'live_allowance') {
					const allowance = JSON.parse(message);
					this.#usageLedger.recordAllowance(allowance.provider ?? this.#registry.get(agentId)?.provider, allowance);
				}
				// Billing survives a goal change or disconnect even when the public view rejects the old turn.
				if (stage === 'live_usage') {
					const value = JSON.parse(message);
					const usageRecord = this.#registry.get(agentId) ?? {};
					const usageState = this.#traceUsageSamples.get(agentId) ?? { usage: null, usageSample: null };
					this.#traceUsageSamples.set(agentId, usageState);
					const usage = nativeUsageTraceFields(value, usageState, usageRecord);
					if (Object.keys(usage).length > 0) this.#writeTrace('native_token_usage', { agentId, goalRevision, scope: 'thread_total', sessionKey: createHash('sha256').update(String(value.threadId ?? '')).digest('hex'), usageSource: 'provider', ...usage });
					if (value.call !== null && typeof value.call === 'object') this.#writeTrace('native_model_call', { agentId, goalRevision, ...modelCallTraceFields(value) });
					if (this.#registry.get(agentId) !== null) this.#usageLedger.recordUsage(this.#registry.get(agentId), value);
					// The roster in the run trace, at most once a minute: runs without a client window keep the same numbers.
					if (Date.now() - this.#lastRosterTraceAt >= 60_000) { this.#lastRosterTraceAt = Date.now(); this.#writeTrace('usage_roster', this.usageRoster()); }
				}
				const viewRecord = this.#registry.get(agentId);
				if (process.env.ARENA_QUALITY_CAPTURE === '1' && allowPublicAgentMessage && !qualityMessageCaptured && ['quality_first_message', 'agent_message'].includes(stage)) {
					qualityMessageCaptured = true;
					void this.#providerTurnRecorder?.record({ agentId, goalRevision, traceId: 'quality-first-message', provider: viewRecord?.provider, model: viewRecord?.model, output: String(message).slice(0, 8192) });
				}
				if (viewRecord !== null && viewRecord.goalRevision === goalRevision && this.#isConnectionEpochCurrent(connectionEpoch)) {
					this.#taskViews.event(viewRecord, stage, message);
				}
				// Direct replies still require say's audience and successful Minecraft receipt.
				if (!this.#verboseEnabled && !publicActivity) return;
				if (allowPublicAgentMessage && stage === 'agent_message') {
					if (publishedAgentMessage) return;
					const publicMessage = sanitizePublicAgentMessage(message);
					if (publicMessage.length === 0) return;
					publishedAgentMessage = true;
					this.#publishVerbose(agentId, goalRevision, 'decision', publicMessage, connectionEpoch);
					return;
				}
			} catch { /* verbose reporting is observational */ }
		};
		reporter.reset = () => {};
		reporter.dispose = () => {
			this.#verboseReporters.delete(reporter);
		};
		this.#verboseReporters.add(reporter);
		return reporter;
	}

	/** Provider stage timestamps (turn sent, steer delivered) ride the verbose channel so providers need no trace dependency. */
	#traceProviderEvent(agentId, goalRevision, message) {
		let value;
		try { value = JSON.parse(message); } catch { return; }
		if (typeof value?.event !== 'string' || (!value.event.startsWith('native_provider_') && value.event !== 'native_tool_rejected')) return;
		const { event, ...fields } = value;
		this.#writeTrace(event, { agentId, goalRevision, ...fields });
	}

	#setVerboseEnabled(enabled) {
		this.#verboseEnabled = enabled;
		if (enabled) return;
		this.#verboseTransitions.clearAll();
		for (const reporter of this.#verboseReporters) reporter.reset();
	}

	#publishVerbose(agentId, goalRevision, stage, message, connectionEpoch = this.#connectionEpoch, transition = {}) {
		try {
			const viewRecord = this.#registry.get(agentId);
			if (viewRecord !== null && viewRecord.goalRevision === goalRevision && this.#isConnectionEpochCurrent(connectionEpoch)) this.#taskViews.event(viewRecord, stage, message);
			const bounded = sanitizeVerboseMessage(stage, message);
			if (bounded.length === 0) return;
			const identity = verboseTransitionIdentity(stage, bounded, transition);
			if (!this.#verboseTransitions.accept({ agentId, goalRevision, ...identity })) return;
			this.#sendVerbose(agentId, goalRevision, stage, bounded, connectionEpoch);
		} catch { /* verbose delivery is best effort */ }
	}

	#sendVerbose(agentId, goalRevision, stage, message, connectionEpoch) {
		if ((!this.#verboseEnabled && stage !== 'decision') || !this.#isConnectionEpochCurrent(connectionEpoch) || !this.#bridge.ready || !VERBOSE_STAGES.includes(stage)) return;
		const current = this.#registry.get(agentId);
		if (current === null || current.goalRevision !== goalRevision || message.length === 0 || message.length > MAX_VERBOSE_MESSAGE_LENGTH) return;
		Promise.resolve(this.#sendForEpoch(connectionEpoch, 'verbose_event', agentId, { goalRevision, stage, message })).catch(() => {});
	}

	async #publishFullCatalog(connectionEpoch) {
		try {
			const catalog = await this.#codexService.catalog.refresh();
			if (!this.#isConnectionEpochCurrent(connectionEpoch)) return;
			if (catalog.models.length === 0) {
				// With no provider to discover there is no recovery record and nothing to report.
				if (catalog.recovery != null) logCatalogGap('returned no models', catalog.recovery);
				return;
			}
			await this.#publishCatalog(catalog, connectionEpoch);
		} catch (error) {
			// The bridge keeps its current catalog and still retries discovery when empty.
			logCatalogGap('failed', error?.message);
		}
	}

	async #publishCatalog(snapshot, connectionEpoch = this.#connectionEpoch) {
		this.#lastCatalog = snapshot;
		for (const model of snapshot.models) registerDiscoveredPrice(model.provider ?? 'codex', model.id, { free: model.free === true, listPrice: model.listPrice ?? null });
		const providers = this.#providerDiscovery.rows(snapshot.models, this.#usageLedger.limitSummaries());
		// Only what this machine can run is offered: a provider whose CLI is missing or signed out lists no models.
		const usable = new Set(providers.filter((row) => row.installed !== false && row.signedIn !== false).map((row) => row.id));
		await this.#sendForEpoch(connectionEpoch, 'catalog_snapshot', 'server', {
			refreshedAtEpochMs: snapshot.refreshedAtEpochMs,
			// Discovery metadata travels in the providers rows; the model entries keep their wire shape.
			models: snapshot.models.filter((model) => usable.has(model.provider ?? 'codex'))
				.map(({ free, listPrice, isDefault, defaultReasoningEffort, ...wire }) => wire),
			providers,
		});
	}

	/** A finished discovery scan: account identity and Codex limits reach the usage ledger; Minecraft gets fresh rows. */
	#acceptDiscovery(state) {
		for (const [provider, account] of Object.entries(state.accounts ?? {})) {
			if (account === null) continue;
			this.#usageLedger.setAccount(provider, account);
			if (account.rateLimits) this.#usageLedger.recordAllowance(provider, account.rateLimits);
		}
		this.#usageLedger.evaluateAll();
		if (this.#lastCatalog !== null && this.#bridge.ready) {
			void this.#publishCatalog(this.#lastCatalog, this.#connectionEpoch).catch(() => {});
		}
	}

	/** Every agent's usage and the account rows ride on each task view, so one request serves any window layout. */
	#taskViewWithRoster(record) {
		const view = this.#taskViews.snapshot(record);
		const records = [...this.#supportedAgentIds].map((agentId) => this.#registry.get(agentId)).filter((entry) => entry !== null);
		if (!records.some((entry) => entry.agentId === record.agentId)) records.push(record);
		const roster = this.#usageLedger.roster(records);
		const withRoster = { ...view, roster };
		if (Buffer.byteLength(JSON.stringify(withRoster)) <= TASK_VIEW_MAX_BYTES) return withRoster;
		const trimmed = { ...view, roster: { ...roster, agents: roster.agents.filter((row) => row.agentId === record.agentId) } };
		return Buffer.byteLength(JSON.stringify(trimmed)) <= TASK_VIEW_MAX_BYTES ? trimmed : view;
	}

	/** OpenCode reports its free-tier refusals as provider retries; they are the only limit signal that tier has. */
	#noteProviderLimitEvent(agentId, message) {
		let value;
		try { value = JSON.parse(message); } catch { return; }
		if (value?.event !== 'native_provider_retry' || value.reason !== 'RATE_LIMITED') return;
		const provider = this.#registry.get(agentId)?.provider;
		if (provider !== undefined) this.#usageLedger.recordRateLimited(provider);
	}

	/** One notice per level change, to every agent on that account, plus a console line. */
	#publishUsageWarning({ provider, level, message, agents }) {
		try { console.error(`[usage] ${provider}: ${message}`); } catch { /* console output is best effort */ }
		this.#writeTrace('usage_limit_warning', { provider, level, message });
		if (!this.#bridge.ready) return;
		const connectionEpoch = this.#connectionEpoch;
		for (const agentId of agents) {
			if (!this.#supportedAgentIds.has(agentId)) continue;
			void this.#sendForEpoch(connectionEpoch, 'agent_notice', agentId, { severity: level === 'none' ? 'info' : 'warning', code: 'USAGE_LIMIT_WARNING', message }).catch(() => {});
		}
	}

	/** The usage roster for tools and tests: every agent's usage plus the account rows. */
	usageRoster() {
		const records = [...this.#supportedAgentIds].map((agentId) => this.#registry.get(agentId)).filter((entry) => entry !== null);
		return this.#usageLedger.roster(records);
	}

	async #publishGoalCompleted({ record, goalFingerprint, traceId }, connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch) || !this.#bridge.ready) throw codedRuntimeError('BRIDGE_NOT_READY', 'Minecraft bridge is not ready for completion verification');
		if (!this.#supportedAgentIds.has(record.agentId)) throw codedRuntimeError('AGENT_NOT_SUPPORTED', `Agent '${record.agentId}' is not in the reconciled bridge roster`);
		const profile = {
			provider: record.provider,
			model: record.model,
			reasoningEffort: record.reasoningEffort,
			serviceTier: record.serviceTier ?? defaultServiceTier(record.provider),
		};
		try {
			await this.#sendForEpoch(connectionEpoch, 'goal_completed', record.agentId, {
				goalRevision: record.goalRevision,
				goalFingerprint,
				traceId,
				profile,
			});
		} catch (error) {
			if (isTransientCompletionSendError(error)) throw error;
			throw codedRuntimeError('COMPLETION_SEND_FAILED', 'Minecraft bridge rejected completion verification', error);
		}
	}

	async #publishStatus(connectionEpoch = this.#connectionEpoch) {
		if (!this.#isConnectionEpochCurrent(connectionEpoch) || !this.#bridge.ready) return;
		const records = this.#registry.list();
		const readyStates = new Set([DynamicAgentState.IDLE, DynamicAgentState.STARTING, DynamicAgentState.PLANNING, DynamicAgentState.ACTING, DynamicAgentState.PAUSED, DynamicAgentState.COMPLETED]);
		const profiles = records.filter((record) => this.#supportedAgentIds.has(record.agentId));
		const healthIdentities = profiles.flatMap((profile) => ['create_agent', this.#usesNativeTools(profile) ? 'native_turn' : 'decide'].map((operation) => ({
			provider: profile.provider,
			model: profile.model,
			profileFingerprint: profileFingerprint(profile),
			operation,
		})));
		// The wire contract has one row per provider/model/operation. Publish the
		// least healthy profile's complete snapshot, retaining truthful quantiles
		// instead of averaging percentiles or masking an open profile circuit.
		const healthByOperation = new Map();
		const circuitRank = { closed: 0, half_open: 1, open: 2 };
		for (const identity of healthIdentities) {
			const snapshot = this.#healthRegistry.snapshot(identity);
			const key = JSON.stringify([identity.provider, identity.model, identity.operation]);
			const previous = healthByOperation.get(key);
			if (previous === undefined || circuitRank[snapshot.circuit] > circuitRank[previous.circuit]
				|| (snapshot.circuit === previous.circuit && (snapshot.failureRate > previous.failureRate
					|| (snapshot.failureRate === previous.failureRate && snapshot.count > previous.count)))) healthByOperation.set(key, snapshot);
		}
		const healthSnapshots = [...healthByOperation.values()].sort((left, right) => left.provider.localeCompare(right.provider)
			|| left.model.localeCompare(right.model) || left.operation.localeCompare(right.operation));
		const pressure = this.#scheduler.pressureSnapshot;
		let providerRecovery = [];
		try { providerRecovery = this.#codexService.recoverySnapshot?.() ?? []; }
		catch { /* optional status must not affect coordinator control */ }
		const components = providerRecoveryComponents(providerRecovery);
		try {
			const diagnostics = this.#traceWriter?.statusSnapshot?.();
			if (diagnostics !== null && diagnostics !== undefined) components.push(diagnostics);
		} catch { /* optional status must not affect coordinator control */ }
		try {
			const providerAudit = this.#providerTurnRecorder?.statusSnapshot?.();
			if (providerAudit !== null && providerAudit !== undefined) components.push(providerAudit);
		} catch { /* optional status must not affect coordinator control */ }
		await this.#sendForEpoch(connectionEpoch, 'coordinator_status', 'server', buildCoordinatorStatus({
			reconciled: this.#reconciledStatus,
			records,
			supportedAgentIds: this.#supportedAgentIds,
			readyStates,
			pressure: {
				active: pressure.active,
				pending: pressure.pending,
				maxConcurrent: pressure.maxConcurrent,
				maxPending: pressure.maxPending,
				warning: pressure.warning,
				mode: pressure.mode,
				configuredTarget: pressure.configuredTarget,
				target: pressure.target,
				minConcurrency: pressure.minConcurrency,
				maxConcurrency: pressure.maxConcurrency,
				urgentReserve: pressure.urgentReserve,
				ordinaryActiveLimit: pressure.ordinaryActiveLimit,
				activeOrdinary: pressure.activeOrdinary,
				activeUrgent: pressure.activeUrgent,
				pendingOrdinary: pressure.pendingOrdinary,
				pendingUrgent: pressure.pendingUrgent,
				growthCount: pressure.growthCount,
				backoffCount: pressure.backoffCount,
				lastChangeReason: pressure.lastChangeReason,
				healthyCompletions: pressure.healthyCompletions,
				ordinaryReservationRejections: pressure.ordinaryReservationRejections,
				urgentReservationRejections: pressure.urgentReservationRejections,
			},
			healthSnapshots: healthSnapshots.slice(0, 32),
			latencies: this.#latencyRegistry.snapshot(),
			bridgeSessionEpoch: connectionEpoch,
			runtimeGeneration: this.#runtimeGeneration,
			components,
		}));
	}

	#ledger(agentId) {
		let ledger = this.#factLedgers.get(agentId);
		if (ledger === undefined) {
			ledger = new FactLedger();
			this.#factLedgers.set(agentId, ledger);
		}
		return ledger;
	}

	#plannerContext(agentId) {
		const ledger = this.#ledger(agentId);
		const memory = this.#conversationMemory(agentId);
		const cursor = this.#contextCursors.get(agentId);
		const record = this.#registry.get(agentId);
		if (record === null || this.#serverInstanceId === null) {
			return {
				untrustedFacts: ledger.toPlannerFacts(),
				conversationContext: memory.toPlannerContext(),
				taskMemory: record === null ? null : this.#playerMemory.peekTaskContext(record),
			};
		}
		const binding = this.#contextBinding(record);
		return {
			factLedger: ledger,
			taskMemory: this.#playerMemory.peekTaskContext(record),
			conversationMemory: memory,
			contextCursor: cursor,
			contextBinding: binding,
			cursorBinding: cursor,
		};
	}

	#contextBinding(record) {
		const session = typeof this.#codexService.getAgent === 'function'
			? this.#codexService.getAgent(record.agentId)
			: null;
		let metadata = null;
		try { metadata = session?.sessionMetadata?.() ?? null; } catch { metadata = null; }
		const selectedProfile = {
			agentId: record.agentId,
			provider: record.provider,
			model: record.model,
			reasoningEffort: record.reasoningEffort,
			serviceTier: record.serviceTier ?? defaultServiceTier(record.provider),
		};
		const sessionFingerprint = metadata?.profileFingerprint ?? session?.profileFingerprint;
		const resolvedFingerprint = typeof sessionFingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(sessionFingerprint)
			? sessionFingerprint
			: profileFingerprint(selectedProfile);
		const sessionGeneration = metadata?.sessionGeneration ?? session?.sessionGeneration;
		return {
			agentId: record.agentId,
			profileFingerprint: resolvedFingerprint,
			sessionGeneration: Number.isSafeInteger(sessionGeneration) && sessionGeneration >= 1 ? sessionGeneration : 1,
			goalRevision: record.goalRevision,
			serverInstanceId: this.#serverInstanceId,
		};
	}

	#contextSnapshot(record) {
		return {
			factRevision: this.#ledger(record.agentId).delta(null).nextRevision,
			conversationSequence: this.#conversationMemory(record.agentId).delta(null).nextSequence,
		};
	}

	#rememberAcceptedContextCursor(record, snapshot = null) {
		if (this.#serverInstanceId === null) return;
		const binding = this.#contextBinding(record);
		// Accept only the exact delivered session/server/goal and captured revisions.
		if (snapshot == null || !contextCursorMatches(snapshot, binding)) return;
		const revisions = snapshot;
		const value = {
			...binding,
			factRevision: revisions.factRevision,
			conversationSequence: revisions.conversationSequence,
			providerAccepted: true,
		};
		const previous = this.#contextCursors.get(record.agentId);
		try {
			this.#contextCursors.set(record.agentId, previous === undefined ? createContextCursor(value) : advanceContextCursor(previous, value));
		} catch {
			// A replacement provider session starts from a full current baseline.
			this.#contextCursors.set(record.agentId, createContextCursor(value));
		}
		// The provider accepted an input that carried exactly these conversation messages.
		const sequences = Array.isArray(snapshot.deliveredConversationSequences) ? snapshot.deliveredConversationSequences.filter(Number.isSafeInteger) : [];
		if (sequences.length > 0) this.emit('conversationProcessed', { agentId: record.agentId, goalRevision: binding.goalRevision, sequences: [...sequences] });
	}

	#invalidateServerInstance(connectionEpoch) {
		this.#cancelGoalSpecRequests();
		this.#settleTaskRequests(undefined, 'BRIDGE_DISCONNECTED', 'Minecraft restarted before answering.');
		this.#healthRegistry.reset();
		this.#factLedgers.clear();
		this.#conversationMemories.clear();
		this.#contextCursors.clear();
		for (const inbox of this.#pendingConversationInboxes.values()) inbox.fence();
		this.#nativeConversationRecoveries.clear();
		this.#nativeObservationSignatures.clear();
		this.#hazardContacts.clear();
		this.#survivalRestartAt.clear();
		this.#survivalQuietSince.clear();
		this.#nativeWorldSignals.clear();
		this.#nativeConfirmationWaits.clear();
		this.#supervisedObservationRequests.clear();
		this.#conversationWakeTransactions.clear();
		this.#providerWork.clear();
		this.#providerProbeDeadlines.clear();
		this.#deferredProviderRecovery.clear();
		this.#programRuntimeEpochs.clear();
		this.#nativeRuntimeEpochs.clear();
		for (const record of this.#registry.list()) {
			this.#goalSupervisor.terminate(this.#supervisionKey(record));
			this.#advanceLifecycleGeneration(record.agentId);
			this.#programRuntime.dispose(record.agentId);
			void this.#nativeRuntime.dispose(record.agentId, 'server_replaced');
			this.#pendingAttention.delete(record.agentId);
			this.#attentionFlushes.delete(record.agentId);
			this.#providerRetryAfter.delete(record.agentId);
			try {
				Promise.resolve(this.#planner.interrupt(record.agentId, 'Minecraft server instance changed'))
					.catch((error) => this.#reportAgentError(record.agentId, error, connectionEpoch));
			} catch (error) {
				void this.#reportAgentError(record.agentId, error, connectionEpoch);
			}
		}
	}

	#goalSpecRequestKey(agentId, requestId) {
		return `${this.#serverInstanceId ?? 'disconnected'}\u0000${agentId}\u0000${requestId}`;
	}

	async #processGoalSpecRequest(key, entry) {
		if (this.#goalSpecRequests.get(key) !== entry || this.#serverInstanceId === null
				|| !this.#isConnectionEpochCurrent(entry.connectionEpoch) || entry.translating) return;
		if (entry.retryHandle !== null) {
			this.#clearGoalSpecTimeout(entry.retryHandle);
			entry.retryHandle = null;
		}
		if (entry.proposal !== null) {
			try {
				await this.#sendForEpoch(entry.connectionEpoch, 'goal_spec_proposal', entry.agentId, entry.proposal);
			} catch (error) {
				if (this.#goalSpecRequests.get(key) === entry) this.#emitRuntimeError(error);
			}
			if (this.#goalSpecRequests.get(key) === entry) this.#scheduleGoalSpecRequest(key, entry, GOAL_SPEC_PROPOSAL_RETRY_MS);
			return;
		}
		entry.translating = true;
		try {
			await this.#reconciliation;
			if (this.#goalSpecRequests.get(key) !== entry || this.#serverInstanceId === null
					|| !this.#isConnectionEpochCurrent(entry.connectionEpoch)) return;
			entry.proposal = await this.#planner.requestGoalSpec({
				agentId: entry.agentId,
				request: entry.request,
				...(entry.correctiveFeedback === null ? {} : { correctiveFeedback: entry.correctiveFeedback }),
			});
			if (entry.proposal.plan !== undefined) {
				this.#taskViews.suggest(entry.agentId, entry.request.originalRequest, entry.proposal.plan);
				const { plan, ...wireProposal } = entry.proposal;
				entry.proposal = wireProposal;
			}
			entry.attempts = 0;
		} catch (error) {
			if (this.#goalSpecRequests.get(key) !== entry) return;
			this.#emitRuntimeError(error);
			if (error?.code === 'STRICT_SPEND_AUXILIARY_DISABLED') {
				this.#forgetGoalSpecRequest(key, entry);
				await this.#reportAgentError(entry.agentId, error, entry.connectionEpoch);
				return;
			}
			const localFeedback = localGoalSpecFeedback(error, entry.rejectionAttempts + 1);
			if (localFeedback !== null) {
				entry.rejectionAttempts += 1;
				entry.correctiveFeedback = localFeedback;
				entry.proposal = null;
				if (entry.rejectionAttempts > MAX_GOAL_SPEC_CORRECTION_ATTEMPTS && (entry.serverRejected || fallbackCompiledDragonGoal(entry.request) === null)) {
					this.#forgetGoalSpecRequest(key, entry);
					await this.#reportAgentError(entry.agentId, codedRuntimeError('GOAL_SPEC_TRANSLATION_REJECTED',
						`Goal translation failed validation after ${entry.rejectionAttempts} proposals (${localFeedback.reasonCode}); the pending draft requires operator correction or cancellation`), entry.connectionEpoch);
					return;
				}
				if (entry.rejectionAttempts <= MAX_GOAL_SPEC_CORRECTION_ATTEMPTS) {
					this.#scheduleGoalSpecRequest(key, entry, Math.min(GOAL_SPEC_RETRY_MAX_MS, GOAL_SPEC_RETRY_BASE_MS * (2 ** (entry.rejectionAttempts - 1))));
					return;
				}
			}
			// Only an exact, server-constrained dragon goal may proceed when its
			// optional Luna advice is unavailable. Other translations keep retrying.
			if (!entry.serverRejected) {
				entry.proposal = fallbackCompiledDragonGoal(entry.request);
			}
			if (entry.proposal === null) {
				entry.attempts += 1;
				const delay = Math.min(GOAL_SPEC_RETRY_MAX_MS, GOAL_SPEC_RETRY_BASE_MS * (2 ** Math.min(entry.attempts - 1, 5)));
				this.#scheduleGoalSpecRequest(key, entry, delay);
				return;
			}
		} finally {
			entry.translating = false;
		}
		if (this.#goalSpecRequests.get(key) === entry) await this.#processGoalSpecRequest(key, entry);
	}

	#scheduleGoalSpecRequest(key, entry, delayMs) {
		if (entry.retryHandle !== null) this.#clearGoalSpecTimeout(entry.retryHandle);
		entry.retryHandle = this.#setGoalSpecTimeout(() => {
			entry.retryHandle = null;
			this.#run(() => this.#processGoalSpecRequest(key, entry), entry.connectionEpoch);
		}, delayMs);
	}

	#forgetGoalSpecRequest(key, entry) {
		if (this.#goalSpecRequests.get(key) !== entry) return;
		this.#goalSpecRequests.delete(key);
		if (entry.retryHandle !== null) this.#clearGoalSpecTimeout(entry.retryHandle);
		try { this.#planner.cancelGoalSpec?.(entry.agentId, entry.requestId); } catch { /* cancellation is best effort */ }
		entry.releaseCapacity();
		entry.resolveCompletion();
	}

	#cancelGoalSpecRequests(agentId = null) {
		for (const [key, request] of this.#goalSpecRequests) {
			if (agentId !== null && request.agentId !== agentId) continue;
			this.#goalSpecRequests.delete(key);
			if (request.retryHandle !== null) this.#clearGoalSpecTimeout(request.retryHandle);
			try { this.#planner.cancelGoalSpec?.(request.agentId, request.requestId); } catch { /* cancellation is best effort */ }
			request.releaseCapacity();
			request.resolveCompletion();
		}
	}

	#conversationMemory(agentId) {
		let memory = this.#conversationMemories.get(agentId);
		if (memory === undefined) {
			memory = new ConversationMemory();
			this.#conversationMemories.set(agentId, memory);
		}
		return memory;
	}

	#pendingConversationInbox(agentId) {
		let inbox = this.#pendingConversationInboxes.get(agentId);
		if (!inbox) {
			inbox = new PendingConversationInbox({ directory: this.#memoryDirectory, agentId });
			this.#pendingConversationInboxes.set(agentId, inbox);
		}
		return inbox;
	}

	async #admitConversation(agentId, event, connectionEpoch, wake = null) {
		const record = this.#registry.get(agentId);
		const ingested = this.#usesNativeTools(record)
			? await this.#pendingConversationInbox(agentId).append(this.#serverInstanceId, event, wake)
			: true;
		// A retry can find a durable append whose original caller saw an I/O failure.
		const retryPending = this.#usesNativeTools(record) && !ingested
			? await this.#pendingConversationInbox(agentId).needsDelivery(event.sequence) : false;
		if (!this.#isConnectionEpochCurrent(connectionEpoch)) throw Object.assign(new Error('Conversation admission belongs to an obsolete connection'), { code: 'STALE_PLAN' });
		if (this.#usesNativeTools(record) && !ingested) return retryPending;
		const historyIngested = this.#conversationMemory(agentId).ingest(event);
		return this.#usesNativeTools(record) ? ingested : historyIngested;
	}

	async #nativeTurnInput(record, request, { deliverConversation = true, freshObservation = false } = {}) {
		if (request.nativeEvent === undefined) return request.input;
		const taskMemory = request.nativeEvent.event === 'program_planning_due' ? null : await this.#playerMemory.taskContext(record);
		const isCurrent = () => this.#registry.get(record.agentId)?.goalRevision === record.goalRevision
			&& this.#isConnectionEpochCurrent(request.connectionEpoch)
			&& this.#isLifecycleGenerationCurrent(record.agentId, request.lifecycleGeneration);
		if (!isCurrent()) throw Object.assign(new Error('Native input belongs to an obsolete lifecycle'), { code: 'STALE_PLAN' });
		this.#settleMovementLoopDelivery(request, false);
		this.#settleFailureDelivery(request, false);
		delete request.nativeConversationDelivery;
		request.deliveredPlayerRequests = [];
		const inbox = this.#pendingConversationInbox(record.agentId);
		await inbox.open(this.#serverInstanceId);
		if (!isCurrent()) throw Object.assign(new Error('Native input belongs to an obsolete lifecycle'), { code: 'STALE_PLAN' });
		const reservation = deliverConversation ? await inbox.reserve() : null;
		if (reservation) request.nativeConversationDelivery = { inbox, token: reservation.token, omittedEntries: 0 };
		try {
			if (!isCurrent()) throw Object.assign(new Error('Native input belongs to an obsolete lifecycle'), { code: 'STALE_PLAN' });
			const program = this.#nativeRuntime.programSnapshot(record, { presentDecision: true });
			const pendingProgram = program?.decision == null ? null : program;
			const latest = freshObservation || pendingProgram !== null || request.nativeEvent.status?.decision != null
				? this.#nativeRuntime.latestObservation(record) : null;
			// Observation wakes carry their sequence on the request, not the envelope.
			const triggeringSequence = request.nativeEvent.eventSequence ?? request.eventSequence;
			const refreshed = latest !== null && latest.eventSequence !== triggeringSequence;
			const owed = refreshed ? owedWakeEvents(request) : [];
			// The fresh observation is the current snapshot; a protected trigger's own facts travel as history.
			let nativeEvent = latest === null ? request.nativeEvent : {
				...request.nativeEvent, eventSequence: latest.eventSequence, observation: latest.observation,
				...(owed.length === 0 ? {} : { mergedEvents: owed }),
			};
			// Any wake can interrupt a decision. Keep the live handle and choices beside its fresh facts.
			if (pendingProgram !== null) {
				const historical = nativeEvent.programId !== undefined && nativeEvent.programId !== pendingProgram.programId;
				const history = historical ? owedWakeEvents(request) : [];
				const { result, ...current } = nativeEvent;
				nativeEvent = { ...current, programId: pendingProgram.programId, status: { ...pendingProgram,
					decision: { ...pendingProgram.decision, request: 'Call respondProgram before ending this turn: use this programId, goalRevision, decisionId, eventSequence and a listed directive; replace also needs source. Choose from the fresh facts.' } },
					...(!historical && result !== undefined ? { result } : {}),
					...(historical ? { event: 'program_attention', trigger: pendingProgram.decision.trigger,
						mergedEvents: history.length > 0 ? history : [{ ...nativeEvent, mergedEvents: undefined }] } : {}) };
			} else if (nativeEvent.status?.decision != null) {
				// Delivery can wait behind task-memory I/O while the model answers or the program ends.
				nativeEvent = { ...nativeEvent, status: program?.programId === nativeEvent.programId ? program : undefined };
			}
			// A failed last result is owed until the provider accepts this input, like the conversation reserved above.
			const failureReservation = {};
			const observation = this.#nativeRuntime.decorateObservation(record, nativeEvent.observation ?? {}, { reservation: failureReservation });
			if (failureReservation.failure !== undefined) request.failureDelivery = failureReservation.failure;
			if (failureReservation.steer !== undefined) request.failureSteer = failureReservation.steer;
			const loopState = this.#nativeWorldSignals.get(record.agentId);
			// Advisories have no delivery ownership. Leave loop facts for an observation-validated body event.
			const movementLoop = nativeEvent.event !== 'program_planning_due' && loopState?.movementLoopDue === true
				&& loopState.movementLoopValidatedVersion === loopState.movementLoopVersion
				&& loopState.movementLoopDelivery?.version !== loopState.movementLoopVersion;
			const isPlanning = nativeEvent.event === 'program_planning_due';
			const reflexRules = this.#nativeRuntime.reflexRules(record);
			const uncovered = isPlanning ? [] : uncoveredDangers(observation, reflexRules);
			const contextsOwed = !isPlanning && this.#contextTracker(record.agentId).owed();
			const { changed, strategy } = this.#situationChangeLine(record, request, nativeEvent, observation, uncovered, contextsOwed);
			const contexts = isPlanning ? null : this.#contextEntryLine(record, request, observation, reflexRules);
			const continuity = this.#taskViews.continuity(record, { observation, guardInstalled: this.#nativeRuntime.hasStandingGuard(record), guardCoverage: this.#nativeRuntime.standingGuardCoverage(record) });
			const guardOutcome = this.#nativeRuntime.guardFeedback(record);
			// Reflex rules the model armed and what fired since its last wake.
			const reflexes = this.#nativeRuntime.reflexReport(record);
			// Facts the wake filter held while the model's action ran (hits absorbed, items gained, routine updates).
			const whileActing = this.#wakeFilter.take(record.agentId, observation);
			const pace = continuity === null ? null : this.#bodyPace.line(record.agentId);
			const input = buildNativeEventInput(record, {
				...nativeEvent, movementLoop, taskMemory, progress: this.#taskViews.progress(record), goalNow: this.#taskViews.goalLine(record), skillFits: this.#taskViews.skillLine?.(record) ?? null,
				continuity: guardOutcome || reflexes || pace || whileActing ? { ...continuity, ...(guardOutcome ? { guardOutcome } : {}), ...(reflexes ? { reflexes } : {}), ...(whileActing ? { whileActing } : {}), ...(pace ? { pace } : {}) } : continuity, dangerSummary: request.dangerSummary,
				awaitingConfirmation: this.#awaitingNativeConfirmation(record, request.lifecycleGeneration),
				confirmationFacts: this.#nativeConfirmationWaits.get(record.agentId)?.facts ?? null,
				observation, actionReceipt: request.nativeEvent.observation?.lastResult, newContext: this.#pendingAssessment(record, request, nativeEvent, observation), changed, strategy, contexts, uncovered,
				runningActionStart: this.#runningActions.get(record.agentId) ?? null, runningAction: this.#nativeRuntime.runningAction(record),
				conversation: reservation?.conversation ?? { mode: 'unread', baseSequence: null, nextSequence: -1, entries: [] },
			});
			const builtPayload = JSON.parse(input.slice(input.indexOf('\n') + 1));
			request.survivalFacts = builtPayload;
			this.#noteAssessmentBuilt(record, request, input, builtPayload);
			if (movementLoop && (builtPayload.movementLoop === true || builtPayload.trigger === 'movement_loop')) {
				loopState.movementLoopDelivery = { version: loopState.movementLoopVersion };
				request.movementLoopDelivery = { state: loopState, delivery: loopState.movementLoopDelivery };
			}
			const contextTrimmed = builtPayload.contextTrimmed;
			if (contextTrimmed !== undefined) {
				this.#writeTrace('native_event_context_trimmed', { agentId: record.agentId, goalRevision: record.goalRevision, fields: contextTrimmed });
			}
			if (reservation) {
				const delivered = builtPayload.conversation;
				inbox.trim(reservation.token, delivered.entries.length);
				// takeTask may only credit a player whose message this turn actually delivered.
				request.deliveredPlayerRequests = delivered.entries
					.filter((entry) => ((entry.kind === 'player_message' && entry.scope === 'direct')
						|| (entry.kind === 'proximity_speech' && entry.scope === 'proximity')) && UUID_TEXT.test(entry.sourceId ?? ''))
					.map((entry) => ({ sequence: entry.sequence, sourceId: entry.sourceId.toLowerCase(), operator: entry.operator === true, text: entry.text }));
				request.nativeConversationDelivery.omittedEntries = delivered.omittedEntries + (reservation.more ? 1 : 0);
				request.nativeConversationDelivery.sequences = delivered.entries.map((entry) => entry.sequence).filter(Number.isSafeInteger);
			}
			return request.retryInstruction === undefined ? input : `${input}\n${request.retryInstruction}`;
		} catch (error) { this.#restoreNativeConversation(request); throw error; }
	}

	#assessmentContext(record) {
		let context = this.#eventContexts.get(record.agentId);
		if (context?.goalRevision !== record.goalRevision) {
			// A respawn often reaches the model as a new revision (respawn, disconnect, resume); the death's unread
			// assessment carries over so the first live call still re-reads the situation, delivered once.
			const carried = context?.pending > 0 ? 1 : 0;
			context = { goalRevision: record.goalRevision, dimension: context?.dimension ?? null, generation: carried, pending: carried, inFlight: null };
			this.#eventContexts.set(record.agentId, context);
		}
		return context;
	}

	/**
	 * Whether this event should ask the model to re-read where it is: a goal start, a death or respawn, or a dimension
	 * different from the last event built. The need stays pending through advisories, danger or confirmation events
	 * and failed deliveries, and is not repeated while one delivery that carries it is still in flight.
	 */
	#pendingAssessment(record, request, nativeEvent, observation) {
		const context = this.#assessmentContext(record);
		const raise = () => { context.generation += 1; context.pending = context.generation; };
		const dimension = observation?.world?.dimension ?? null;
		if (dimension !== null) {
			if (context.dimension !== null && dimension !== context.dimension) raise();
			context.dimension = dimension;
		}
		const died = nativeEvent?.event === 'player_death';
		if (died || NEW_CONTEXT_TRIGGERS.has(nativeEvent?.trigger)) raise();
		if (died || context.pending === 0) return false;
		const inFlight = context.inFlight;
		return !(inFlight?.generation === context.pending && this.#isLifecycleGenerationCurrent(record.agentId, inFlight.lifecycleGeneration)
			&& this.#isConnectionEpochCurrent(inFlight.connectionEpoch));
	}

	/**
	 * The changed line for this wake. It only rides on wakes that already happen; advisories have no delivery
	 * ownership, so they neither carry nor consume it.
	 */
	#situationChangeLine(record, request, nativeEvent, observation, uncovered = [], contextsOwed = false) {
		this.#settleSituationChange(request, false);
		if (nativeEvent?.event === 'program_planning_due') return { changed: null, strategy: null };
		let tracker = this.#situationChanges.get(record.agentId);
		if (tracker === undefined) {
			tracker = new SituationChangeTracker();
			this.#situationChanges.set(record.agentId, tracker);
		}
		const trigger = nativeEvent?.status?.decision?.trigger ?? nativeEvent?.trigger;
		const { text, strategy, token } = tracker.line(observation, {
			at: Date.now(), event: nativeEvent?.event, trigger: nativeEvent?.trigger,
			// Danger and low-health wakes already report the health they lost, and lava contact has its own instruction.
			hpReported: request.dangerSummary != null || DANGER_DECISION_TRIGGERS.has(trigger) || HEALING_EVENT_TRIGGERS.has(trigger),
			// The same rule buildNativeEventInput uses to attach the healing section, which states natural regeneration.
			healingReported: nativeEvent?.healing != null || HEALING_EVENT_TRIGGERS.has(trigger) || trigger === 'damage' && burnFacts(observation?.player) !== null,
			lavaReported: inHazardContact(observation?.player),
			strategyTopic: strategyReference.situationStrategyTopic?.(observation) ?? null,
			// Danger wakes carry the uncovered dangers in their own field; the line names a change of them on other wakes.
			uncovered, uncoveredReported: contextsOwed || DANGER_DECISION_TRIGGERS.has(trigger) || trigger === 'low_health',
		});
		request.situationChangeDelivery = { tracker, token };
		return { changed: text, strategy };
	}

	#trackRunningAction(agentId, observation) {
		const action = observation?.currentAction;
		if (action === undefined) return;
		if (action?.active !== true) { this.#runningActions.delete(agentId); return; }
		if (this.#runningActions.get(agentId)?.actionId === action.actionId) return;
		this.#runningActions.set(agentId, { actionId: action.actionId, health: observation.player?.health });
	}

	#contextTracker(agentId) {
		let tracker = this.#contextEntries.get(agentId);
		if (tracker === undefined) {
			tracker = new ContextEntryTracker();
			this.#contextEntries.set(agentId, tracker);
		}
		return tracker;
	}

	/** The owed context entries for this wake, settled with the situation line (delivered or kept owed). */
	#contextEntryLine(record, request, observation, rules) {
		const tracker = this.#contextTracker(record.agentId);
		if (!tracker.owed()) return null;
		const { value, token } = tracker.line(observation, rules);
		request.contextEntryDelivery = { tracker, token };
		return value;
	}

	#settleSituationChange(request, delivered) {
		const entries = request?.contextEntryDelivery;
		if (entries !== undefined) {
			delete request.contextEntryDelivery;
			entries.tracker.settle(entries.token, delivered);
		}
		const delivery = request?.situationChangeDelivery;
		if (delivery === undefined) return;
		delete request.situationChangeDelivery;
		delivery.tracker.settle(delivery.token, delivered);
	}

	/** Records which pending assessment this built input carries, so only its successful delivery clears it. */
	#noteAssessmentBuilt(record, request, input, payload) {
		delete request.assessmentDelivery;
		const context = this.#eventContexts.get(record.agentId);
		if (context?.goalRevision !== record.goalRevision || context.pending === 0) return;
		if (!isNewContextEventInput(input) || typeof payload.situation !== 'string') return;
		context.inFlight = { generation: context.pending, lifecycleGeneration: request.lifecycleGeneration, connectionEpoch: request.connectionEpoch };
		request.assessmentDelivery = { agentId: record.agentId, goalRevision: record.goalRevision, generation: context.pending };
	}

	#settleAssessmentDelivery(request, delivered) {
		const delivery = request?.assessmentDelivery;
		if (delivery === undefined) return;
		delete request.assessmentDelivery;
		const context = this.#eventContexts.get(delivery.agentId);
		if (context?.goalRevision !== delivery.goalRevision) return;
		if (context.inFlight?.generation === delivery.generation) context.inFlight = null;
		// A newer death or dimension change raised since this input was built still needs its own delivery.
		if (delivered && context.pending === delivery.generation) context.pending = 0;
	}

	// Like unread conversation, a loop fact remains owed through rejected or superseded delivery.
	#settleMovementLoopDelivery(request, delivered) {
		const pending = request?.movementLoopDelivery;
		if (pending === undefined) return;
		delete request.movementLoopDelivery;
		const { state, delivery } = pending;
		if (state.movementLoopDelivery === delivery) state.movementLoopDelivery = null;
		if (delivered && state.movementLoopVersion === delivery.version) state.movementLoopDue = false;
	}

	#settleFailureDelivery(request, delivered) {
		const steer = request?.failureSteer;
		if (steer !== undefined) {
			delete request.failureSteer;
			this.#nativeRuntime.settleFailureSteer(steer, delivered);
		}
		const token = request?.failureDelivery;
		if (token === undefined) return;
		delete request.failureDelivery;
		this.#nativeRuntime.settleFailureDelivery(token, delivered);
	}

	async #commitNativeConversation(request) {
		const delivery = request?.nativeConversationDelivery;
		if (delivery?.token) {
			await delivery.inbox.commit(delivery.token);
			delete delivery.token;
			// The provider accepted the turn that delivered exactly these messages.
			if (delivery.sequences?.length > 0) {
				this.emit('conversationProcessed', { agentId: request.agentId, goalRevision: request.goalRevision, sequences: [...delivery.sequences] });
			}
		}
		this.#settleAssessmentDelivery(request, true);
		this.#settleSituationChange(request, true);
		this.#settleMovementLoopDelivery(request, true);
		this.#settleFailureDelivery(request, true);
	}

	#restoreNativeConversation(request) {
		const delivery = request?.nativeConversationDelivery;
		if (delivery?.token) delivery.inbox.rollback(delivery.token);
		if (request) delete request.nativeConversationDelivery;
		this.#settleAssessmentDelivery(request, false);
		this.#settleSituationChange(request, false);
		this.#settleMovementLoopDelivery(request, false);
		this.#settleFailureDelivery(request, false);
	}

	#forgetNativeConversationRecovery(supervisionKey) {
		const recovery = this.#nativeConversationRecoveries.get(supervisionKey.agentId);
		if (recovery !== undefined && sameSupervisionKey(recovery.supervisionKey, supervisionKey)) {
			this.#nativeConversationRecoveries.delete(supervisionKey.agentId);
		}
	}

	#rememberConversationWake(transactionId, agentId, fingerprint) {
		this.#forgetConversationWakes(agentId);
		this.#conversationWakeTransactions.set(transactionId, { agentId, fingerprint });
		while (this.#conversationWakeTransactions.size > MAX_CONVERSATION_WAKE_TRANSACTIONS) {
			this.#conversationWakeTransactions.delete(this.#conversationWakeTransactions.keys().next().value);
		}
	}

	#forgetConversationWakes(agentId) {
		for (const [transactionId, transaction] of this.#conversationWakeTransactions) {
			if (transaction.agentId === agentId) this.#conversationWakeTransactions.delete(transactionId);
		}
	}

}

export function createDynamicCoordinator(configValue, dependencies = {}) {
	const providerTurnRecorder = dependencies.providerTurnRecorder ?? null;
	const coordinatorEnvironment = dependencies.env ?? process.env;
	const strictSpendGate = strictSpendRuntime(coordinatorEnvironment);
	const config = normalizeDynamicConfig(configValue, coordinatorEnvironment);
	const providerEnvironments = Object.fromEntries(PROVIDER_IDS.map((provider) => [
		provider,
		createProviderChildEnvironment(provider, coordinatorEnvironment, config.bridge.secretEnvironmentVariable,
			config.voice.provider === 'openai' ? { speechApiKeyEnvironmentVariable: config.voice.openaiApiKeyEnvironmentVariable } : {}),
	]));
	const registry = dependencies.registry ?? new AgentRegistry({
		agentCap: config.limits.agentCap,
		queueCap: config.limits.goalQueueCap,
		now: dependencies.now ?? Date.now,
	});
	const scheduler = dependencies.scheduler ?? new PlanningScheduler({
		maxConcurrent: config.limits.planningConcurrency,
		maxPending: Math.max(0, config.limits.agentCap - config.limits.planningConcurrency),
		planningMode: config.limits.planningMode,
		minConcurrency: 4,
		maxConcurrency: config.limits.agentCap,
		urgentReserve: config.limits.urgentReserve,
		onPressure: (snapshot) => dependencies.onSchedulerPressure?.(snapshot),
		benchmarkRecorder: dependencies.benchmarkRecorder,
	});
	const workspaceManager = dependencies.workspaceManager ?? new AgentWorkspaceManager(config.workspaceRoot);
	const minecraftWorkspace = dependencies.minecraftWorkspace ?? new MinecraftAgentWorkspace({
		root: config.minecraftAgentRoot,
		templateRoot: config.minecraftAgentTemplateRoot,
	});
	// Tests and simulators get a monitor that never spawns; runCli injects the real one.
	const providerCliHealth = strictSpendGate ? createDisabledProviderCliHealthMonitor() : (dependencies.providerCliHealth ?? createDisabledProviderCliHealthMonitor());
	if (typeof providerCliHealth.configure === 'function') {
		providerCliHealth.configure({
			codex: { ...config.codex, ...(config.codex.launchProfile ?? {}), environment: providerEnvironments.codex, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable },
			gemini: { ...config.gemini, environment: providerEnvironments.gemini, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable },
			claude: { ...config.claude, environment: providerEnvironments.claude, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable },
			opencode: { ...config.opencode, environment: providerEnvironments.opencode, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable },
		});
	}
	// Discovery spawns the CLIs' read-only status and model-list commands, so it runs only where CLI probes may.
	const discoveryEnabled = providerCliHealth.enabled === true;
	const injectedProviders = dependencies.providerService ?? dependencies.codexService ?? null;
	const codexProvider = injectedProviders !== null ? null
		: new CodexService({ ...config.codex, environment: providerEnvironments.codex, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable }, { transport: dependencies.codexTransport, now: dependencies.now ?? Date.now, workspaceManager, minecraftWorkspace });
	const codexService = injectedProviders ?? new ProviderService({
		codex: codexProvider,
		gemini: new AntigravityProviderService({ ...config.gemini, environment: providerEnvironments.gemini, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable }, {
			spawn: dependencies.antigravitySpawn,
			terminate: dependencies.terminateProviderProcess,
			platform: dependencies.platform,
			workspaceManager,
		}),
		claude: new ClaudeProviderService({ ...config.claude, environment: providerEnvironments.claude, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable }, {
			spawn: dependencies.claudeSpawn,
			terminate: dependencies.terminateProviderProcess,
			toolServer: dependencies.claudeToolServer,
			workspaceManager,
			minecraftWorkspace,
		}),
		opencode: new OpenCodeProviderService({ ...config.opencode, environment: providerEnvironments.opencode, bridgeSecretEnvironmentVariable: config.bridge.secretEnvironmentVariable }, {
			discoverModels: dependencies.opencodeDiscoverModels ?? (discoveryEnabled
				? () => discoverOpenCodeModels({ executable: config.opencode.executable ?? 'opencode', environment: providerEnvironments.opencode })
				: null),
			spawn: dependencies.opencodeSpawn,
			terminate: dependencies.terminateProviderProcess,
			toolServer: dependencies.claudeToolServer,
			workspaceManager,
			minecraftWorkspace,
		}),
	}, { strictSpendGate, turnRecorder: providerTurnRecorder, now: dependencies.epochNow ?? Date.now });
	const healthRegistry = dependencies.healthRegistry ?? dependencies.planner?.healthRegistry ?? new ProviderHealthRegistry({ now: dependencies.healthNow ?? Date.now });
	const latencyRegistry = dependencies.latencyRegistry ?? new ControlLatencyRegistry();
	const bodyPace = dependencies.bodyPace ?? new BodyPace({ now: dependencies.epochNow ?? Date.now });
	const planner = dependencies.planner ?? new AgentPlanner({
		strictSpendGate,
		registry,
		scheduler,
		codexService,
		invalidDecisionRetries: config.limits.invalidDecisionRetries,
		healthRegistry,
		latencyRegistry,
		now: dependencies.plannerNow ?? dependencies.now,
		telemetrySink: dependencies.telemetrySink,
		nativeTimingSink: (event, fields) => { bodyPace.note(event, fields); return dependencies.traceWriter?.write(event, fields); },
		benchmarkRecorder: dependencies.benchmarkRecorder,
		turnRecorder: providerTurnRecorder,
	});
	const bridge = dependencies.bridge ?? new MultiplexedServerBridge(config.bridge, {
		audit: dependencies.protocolAudit,
		socketFactory: dependencies.socketFactory,
		schedule: dependencies.schedule,
		cancelSchedule: dependencies.cancelSchedule,
		scheduleDeadline: dependencies.scheduleDeadline,
		cancelDeadline: dependencies.cancelDeadline,
		currentRevision: (agentId) => registry.get(agentId)?.goalRevision ?? null,
	});
	let coordinator = null;
	const goalSupervisor = dependencies.goalSupervisor ?? new ActiveGoalSupervisor({
		requestObservation: (key, reason) => coordinator?.requestSupervisedObservation(key, reason) ?? false,
		clock: dependencies.goalClock ?? dependencies.controlNow ?? Date.now,
		schedule: dependencies.goalSchedule,
		cancelSchedule: dependencies.cancelGoalSchedule,
		stuckSchedule: dependencies.goalStuckSchedule,
		cancelStuckSchedule: dependencies.cancelGoalStuckSchedule,
		onExpire: (event) => coordinator?.handleLeaseExpired(event),
		onStuck: (event) => coordinator?.handleGoalStuck(event),
	});
	coordinator = new DynamicCoordinator({
		bodyPace,
		registry,
		scheduler,
		codexService,
		planner,
		bridge,
		healthRegistry,
		latencyRegistry,
		goalSupervisor,
		codexControlProtocol: config.codex.controlProtocol,
		memoryDirectory: Object.hasOwn(dependencies, 'memoryDirectory') ? dependencies.memoryDirectory : path.join(config.workspaceRoot, 'player-memory'),
		runtimeSessionId: dependencies.runtimeSessionId,
		traceWriter: dependencies.traceWriter,
		providerTurnRecorder,
		runtimeGeneration: dependencies.runtimeGeneration,
		runtimeHooks: dependencies.runtimeHooks,
		controlNow: dependencies.controlNow,
		epochNow: dependencies.epochNow,
		setStatusInterval: dependencies.setStatusInterval,
		clearStatusInterval: dependencies.clearStatusInterval,
		setGoalSpecTimeout: dependencies.setGoalSpecTimeout,
		clearGoalSpecTimeout: dependencies.clearGoalSpecTimeout,
		setSteerTimeout: dependencies.setSteerTimeout,
		clearSteerTimeout: dependencies.clearSteerTimeout,
		setWakeHoldTimeout: dependencies.setWakeHoldTimeout,
		...(dependencies.reflexDefaults === undefined ? {} : { reflexDefaults: dependencies.reflexDefaults }),
		clearWakeHoldTimeout: dependencies.clearWakeHoldTimeout,
		taskRequestTimeoutMs: dependencies.taskRequestTimeoutMs,
		maxPendingAgentOperations: dependencies.maxPendingAgentOperations,
		maxPendingAgentTransactions: dependencies.maxPendingAgentTransactions,
		connectionOperationCap: dependencies.connectionOperationCap,
		agentOperationCap: dependencies.agentOperationCap,
		goalSpecRequestCap: dependencies.goalSpecRequestCap,
		benchmarkRecorder: dependencies.benchmarkRecorder,
		providerCliHealth,
		providerDiscovery: dependencies.providerDiscovery ?? new ProviderDiscovery({
			cliHealth: discoveryEnabled ? providerCliHealth : null,
			accountReaders: createAccountReaders({
				environments: providerEnvironments,
				executables: { opencode: config.opencode.executable, claude: config.claude.executable },
				codexService: codexProvider,
			}),
		}),
	});
	return coordinator;
}

function defaultGoalSpecTimeout(callback, delayMs) {
	const handle = setTimeout(callback, delayMs);
	handle.unref?.();
	return handle;
}

export function parseDynamicCliArguments(args) {
	if (!Array.isArray(args)) throw new TypeError('CLI arguments must be an array');
	if (args.length === 0) return { configPath: DEFAULT_DYNAMIC_CONFIG_PATH };
	if (args.length !== 2 || args[0] !== '--config') throw new Error('Usage: node coordinator/src/dynamic-main.mjs [--config <absolute-path>]');
	if (!path.isAbsolute(args[1])) throw new Error('--config must be an absolute path');
	return { configPath: args[1] };
}

export function resolveDynamicCliRuntime(environment = process.env) {
	if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('runtime environment must be an object');
	const tracePath = environment.ARENA_HEADLESS_TRACE_PATH ?? path.join(PROJECT_DIRECTORY, 'runtime', 'traces', 'coordinator.jsonl');
	const separator = tracePath.includes('\\') ? '\\' : '/';
	const traceDirectory = tracePath.slice(0, Math.max(0, tracePath.lastIndexOf(separator)));
	return {
		tracePath,
		diagnosticTracePath: environment.ARENA_HEADLESS_PRIVATE_TRACE_PATH ?? `${traceDirectory}${separator}coordinator-private.jsonl`,
		protocolAuditPath: environment.ARENA_PROTOCOL_AUDIT_PATH ?? null,
		providerTurnsPath: environment.ARENA_PROVIDER_TURNS_PATH ?? null,
		runtimeGeneration: /^[0-9a-f]{64}$/.test(environment.ARENA_AGENT_COORDINATOR_RUNTIME_GENERATION ?? '')
			? environment.ARENA_AGENT_COORDINATOR_RUNTIME_GENERATION
			: null,
		runId: environment.ARENA_HEADLESS_RUN_ID ?? 'dynamic-run',
		scenarioId: environment.ARENA_HEADLESS_SCENARIO_ID ?? 'dynamic',
	};
}

export async function loadDynamicConfig(configPath = DEFAULT_DYNAMIC_CONFIG_PATH) {
	const document = JSON.parse(await readFile(configPath, 'utf8'));
	return normalizeDynamicConfig(document, process.env);
}

export function normalizeDynamicConfig(value, environment = process.env) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('dynamic coordinator config must be an object');
	value = migrateDynamicConfig(value);
	assertKnownConfigKeys(value, ['schemaVersion', 'bridge', 'voice', 'codex', 'gemini', 'claude', 'opencode', 'limits', 'workspaceRoot', 'minecraftAgentRoot', 'minecraftAgentTemplateRoot'], 'config');
	if (value.bridge === null || typeof value.bridge !== 'object' || Array.isArray(value.bridge)) throw new TypeError('dynamic coordinator bridge config must be an object');
	if (value.codex === null || typeof value.codex !== 'object' || Array.isArray(value.codex)) throw new TypeError('dynamic coordinator Codex config must be an object');
	if (value.voice !== undefined && (value.voice === null || typeof value.voice !== 'object' || Array.isArray(value.voice))) throw new TypeError('dynamic coordinator voice config must be an object');
	assertOptionalConfigObject(value.limits, 'limits');
	assertOptionalConfigObject(value.gemini, 'gemini');
	assertOptionalConfigObject(value.claude, 'claude');
	assertOptionalConfigObject(value.opencode, 'opencode');
	assertKnownConfigKeys(value.bridge, ['host', 'port', 'secret', 'secretEnvironmentVariable', 'reconnectDelayMs', 'maxReconnectDelayMs', 'connectionQueueCap', 'agentQueueCap', 'inboundConnectionQueueCap', 'inboundAgentQueueCap', 'inboundDispatchBatch', 'trackedTerminalActionIdCap', 'handshakeTimeoutMs', 'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'serverInstanceId', 'launchId'], 'bridge');
	assertKnownConfigKeys(value.voice ?? {}, ['port', 'maxConcurrent', 'profileAssignmentsPath', 'provider', 'openaiApiKeyEnvironmentVariable', 'openaiTtsModel', 'openaiSttModel', 'fishApiKeyEnvironmentVariable', 'deepgramApiKeyEnvironmentVariable', 'localSpeechTimeoutMs', 'localSpeechPythonPath', 'secret', 'secretFile'], 'voice');
	assertKnownConfigKeys(value.codex, ['cwd', 'controlProtocol', 'planningTimeoutMs', 'maxDecisionBytes', 'catalogTtlMs', 'startupTimeoutMs', 'serviceTier', 'launchProfile', 'contextRotationTokens', 'midTurnContextRotationTokens'], 'codex');
	if (value.codex.launchProfile !== undefined) {
		assertOptionalConfigObject(value.codex.launchProfile, 'codex.launchProfile');
		assertKnownConfigKeys(value.codex.launchProfile, ['agentId', 'model', 'reasoningEffort', 'serviceTier', 'planningTimeoutMs', 'maxDecisionBytes', 'cwd'], 'codex.launchProfile');
	}
	const providerKeys = ['provider', 'cwd', 'executable', 'models', 'reasoningEfforts', 'modelReasoningEfforts', 'catalogDiscovery', 'catalogDiscoveryTimeoutMs', 'planningTimeoutMs', 'maxDecisionBytes', 'stdoutLimitBytes', 'stderrLimitBytes', 'serviceTier'];
	assertKnownConfigKeys(value.gemini ?? {}, providerKeys, 'gemini');
	assertKnownConfigKeys(value.claude ?? {}, ['provider', 'cwd', 'executable', 'models', 'reasoningEfforts', 'planningTimeoutMs', 'startupTimeoutMs', 'interruptTimeoutMs', 'maxDecisionBytes', 'stdoutLimitBytes', 'stderrLimitBytes', 'runtimeRoot', 'fastMode'], 'claude');
	assertKnownConfigKeys(value.opencode ?? {}, ['provider', 'executable', 'models', 'reasoningEfforts', 'planningTimeoutMs', 'startupTimeoutMs', 'interruptTimeoutMs', 'maxDecisionBytes', 'runtimeRoot', 'contextRotationTokens'], 'opencode');
	assertKnownConfigKeys(value.limits ?? {}, ['agentCap', 'goalQueueCap', 'planningConcurrency', 'planningMode', 'urgentReserve', 'invalidDecisionRetries'], 'limits');
	const secret = value.bridge.secret ?? environment[value.bridge.secretEnvironmentVariable ?? 'ARENA_AGENT_BRIDGE_SECRET'];
	const cwd = value.codex.cwd ?? PROJECT_DIRECTORY;
	const workspaceRoot = value.workspaceRoot === undefined
		? path.join(PROJECT_DIRECTORY, 'runtime', 'agent-workspaces')
		: path.resolve(PROJECT_DIRECTORY, value.workspaceRoot);
	const minecraftAgentRoot = value.minecraftAgentRoot === undefined
		? path.join(PROJECT_DIRECTORY, 'runtime', 'minecraft-agent')
		: path.resolve(PROJECT_DIRECTORY, value.minecraftAgentRoot);
	const agentCap = positiveInteger(value.limits?.agentCap ?? DEFAULT_AGENT_CAP, 'limits.agentCap');
	const planningConcurrency = positiveInteger(value.limits?.planningConcurrency ?? DEFAULT_PLANNING_CONCURRENCY, 'limits.planningConcurrency');
	const planningMode = value.limits?.planningMode ?? 'fixed';
	if (planningMode !== 'fixed' && planningMode !== 'adaptive') throw new TypeError("limits.planningMode must be 'fixed' or 'adaptive'");
	if (agentCap > 16) throw new TypeError('limits.agentCap must not exceed 16');
	if (planningMode === 'adaptive' && (agentCap < 4 || planningConcurrency < 4 || planningConcurrency > 16 || planningConcurrency > agentCap)) {
		throw new TypeError('adaptive planningConcurrency and agentCap must be in [4, 16]');
	}
	if (planningConcurrency > agentCap) throw new TypeError('limits.planningConcurrency must not exceed limits.agentCap');
	const urgentReserve = value.limits?.urgentReserve ?? (agentCap >= 4 && planningConcurrency > 1 ? 1 : 0);
	if (!Number.isSafeInteger(urgentReserve) || urgentReserve < 0 || urgentReserve > agentCap) throw new TypeError('limits.urgentReserve must be a non-negative safe integer within limits.agentCap');
	if (urgentReserve >= (planningMode === 'adaptive' ? 4 : planningConcurrency)) throw new TypeError('limits.urgentReserve must leave at least one ordinary planning slot at every target');
	const voice = normalizeVoiceConfig(value.voice, environment);
	const codexControlProtocol = value.codex.controlProtocol ?? 'native_tools';
	if (!['arena_script', 'native_tools'].includes(codexControlProtocol)) throw new TypeError('codex.controlProtocol must be arena_script or native_tools');
	return {
		schemaVersion: 1,
		bridge: { ...value.bridge, secret },
		workspaceRoot,
		minecraftAgentRoot,
		minecraftAgentTemplateRoot: path.join(COORDINATOR_DIRECTORY, 'config', 'minecraft-agent'),
		voice,
		codex: {
			...value.codex,
			cwd,
			controlProtocol: codexControlProtocol,
			launchProfile: value.codex.launchProfile === undefined ? undefined : { ...value.codex.launchProfile, cwd },
		},
		gemini: {
			provider: 'gemini',
			cwd,
			catalogDiscovery: true,
			models: ['gemini-3.7-flash', 'gemini-3.1-pro', 'gemini-3.6-flash', 'gemini-3.5-flash'],
			modelReasoningEfforts: {
				'gemini-3.7-flash': ['high', 'medium', 'low'],
				'gemini-3.1-pro': ['high', 'low'],
				'gemini-3.6-flash': ['high', 'medium', 'low'],
				'gemini-3.5-flash': ['high', 'medium', 'low'],
			},
			...(value.gemini ?? {}),
		},
		claude: {
			provider: 'claude',
			cwd,
			// Claude agents share Codex's dedicated Minecraft workspace; only their launch prompt files live here.
			runtimeRoot: path.join(minecraftAgentRoot, 'claude'),
			...(value.claude ?? {}),
		},
		opencode: {
			provider: 'opencode',
			...(value.opencode ?? {}),
		},
		limits: {
			agentCap,
			goalQueueCap: positiveInteger(value.limits?.goalQueueCap ?? DEFAULT_GOAL_QUEUE_CAP, 'limits.goalQueueCap'),
			planningConcurrency,
			planningMode,
			urgentReserve,
			invalidDecisionRetries: nonNegativeInteger(value.limits?.invalidDecisionRetries ?? DEFAULT_INVALID_DECISION_RETRIES, 'limits.invalidDecisionRetries'),
		},
	};
}

function migrateDynamicConfig(value) {
	const schemaVersion = value.schemaVersion ?? 0;
	if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) throw new TypeError('config.schemaVersion must be a nonnegative safe integer');
	if (schemaVersion > 1) throw new TypeError(`Unsupported dynamic coordinator config schemaVersion ${schemaVersion}`);
	// Kimi and Cursor were retired as providers; installed configs may still carry their sections.
	const { kimi: _retiredKimi, cursor: _retiredCursor, ...current } = value;
	return { ...current, schemaVersion: 1 };
}

function assertOptionalConfigObject(value, field) {
	if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
		throw new TypeError(`dynamic coordinator ${field} config must be an object`);
	}
}

function assertKnownConfigKeys(value, allowed, field) {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new TypeError(`Unknown dynamic coordinator config key '${field}.${key}'`);
	}
}

async function runCli(reporter = new RuntimeErrorReporter()) {
	const { configPath } = parseDynamicCliArguments(process.argv.slice(2));
	const config = await loadDynamicConfig(configPath);
	const runtime = resolveDynamicCliRuntime(process.env);
	const traceWriter = new TraceWriter(runtime.tracePath, { diagnosticFilePath: runtime.diagnosticTracePath });
	const protocolAudit = runtime.protocolAuditPath === null ? null : createJsonlAudit(runtime.protocolAuditPath, { runId: runtime.runId, scenarioId: runtime.scenarioId });
	if (runtime.providerTurnsPath !== null) await mkdir(path.dirname(path.resolve(runtime.providerTurnsPath)), { recursive: true });
	const providerTurnRecorder = runtime.providerTurnsPath === null ? null : new ProviderTurnRecorder({
		runId: runtime.runId,
		scenarioId: runtime.scenarioId,
		privatePath: runtime.providerTurnsPath,
	});
	const voiceSupervisor = createVoiceSupervisor(config, process.env);
	const coordinator = createDynamicCoordinator(config, {
		traceWriter, protocolAudit, providerTurnRecorder, runtimeGeneration: runtime.runtimeGeneration,
		runtimeHooks: { onRemoved: (agentId) => voiceSupervisor.removeAgent(agentId) },
		// Real agents launch real CLIs here, so the probes may spawn them.
		providerCliHealth: new ProviderCliHealthMonitor(),
	});
	const disposeDiagnostics = wireRuntimeDiagnostics(coordinator, reporter);
	try {
		await startCoordinatorControl(coordinator, voiceSupervisor);
	} catch (error) {
		await Promise.allSettled([coordinator.stop(), voiceSupervisor.close(), protocolAudit?.close()]);
		disposeDiagnostics();
		throw error;
	}
	let shutdownPromise = null;
	const shutdown = async () => {
		shutdownPromise ??= (async () => {
			await coordinator.stop();
			await voiceSupervisor.close();
			await protocolAudit?.close();
		})().finally(disposeDiagnostics);
		await shutdownPromise;
		process.exitCode = 0;
	};
	watchCaptureShutdown(process.env.ARENA_CAPTURE_SHUTDOWN_PATH, shutdown);
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
}

export async function startCoordinatorControl(coordinator, voiceSupervisor) {
	if (coordinator === null || typeof coordinator?.start !== 'function') {
		throw new TypeError('coordinator.start is required');
	}
	if (voiceSupervisor === null || typeof voiceSupervisor?.start !== 'function'
			|| typeof voiceSupervisor?.close !== 'function') {
		throw new TypeError('voiceSupervisor.start and voiceSupervisor.close are required');
	}
	if (typeof coordinator.once === 'function') {
		coordinator.once('shutdown', () => { void Promise.resolve(voiceSupervisor.close()).catch(() => {}); });
	}
	await coordinator.start();
	try { Promise.resolve(voiceSupervisor.start()).catch(() => {}); }
	catch { /* optional voice startup cannot reject coordinator control */ }
}

export function createVoiceSupervisor(config, environment = process.env, dependencies = {}) {
	if (strictSpendRuntime(environment)) return { start() {}, close() {}, removeAgent() {} };
	if (config === null || typeof config !== 'object' || Array.isArray(config)) {
		throw new TypeError('voice supervisor config must be an object');
	}
	if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
		throw new TypeError('voice supervisor environment must be an object');
	}
	const localSpeechTimeoutMs = config.voice?.localSpeechTimeoutMs ?? DEFAULT_LOCAL_SPEECH_TIMEOUT_MS;
	if (!Number.isSafeInteger(localSpeechTimeoutMs) || localSpeechTimeoutMs < 1 || localSpeechTimeoutMs > 600_000) {
		throw new TypeError('voice.localSpeechTimeoutMs must be between 1 and 600000');
	}
	const reportVoiceDiagnostic = dependencies.reportVoiceDiagnostic ?? writeVoiceDiagnostic;
	if (typeof reportVoiceDiagnostic !== 'function') throw new TypeError('reportVoiceDiagnostic must be a function');
	const startWorker = dependencies.startWorker
		?? (({ signal }) => startVoiceWorker(config, environment, { signal, reportVoiceDiagnostic }));
	const reportFailure = dependencies.reportFailure ?? (({ failureCode }) => {
		process.stderr.write(`[voice-supervisor] ${failureCode}: proximity speech unavailable; retrying automatically\n`);
	});
	return new VoiceSupervisor({
		startWorker,
		warmupTimeoutMs: Math.min(Number.MAX_SAFE_INTEGER, localSpeechTimeoutMs + VOICE_WARMUP_GRACE_MS),
		onFailure: reportFailure,
		...(dependencies.supervisorOptions ?? {}),
	});
}

const CRITICAL_AUDIT_TYPES = new Set(['hello', 'hello_ack', 'registry_entry', 'registry_complete', 'agent_registered', 'goal_control']);

export function createJsonlAudit(filePath, metadata, dependencies = {}) {
	if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('protocol audit path must be nonblank');
	const makeDirectory = dependencies.mkdir ?? mkdir;
	let queue;
	const sink = new RotatingJsonlSink(filePath, {
		...dependencies,
		inspect: dependencies.appendFile === undefined || dependencies.stat !== undefined
			|| dependencies.maxFileBytes !== undefined || dependencies.maxFileAgeMs !== undefined,
	});
	let closed = false;
	let closePromise = null;
	// Attach rejection handling immediately, including when no audit row ever arrives.
	const ready = Promise.resolve().then(() => makeDirectory(path.dirname(path.resolve(filePath)), { recursive: true }))
		.then(() => true, () => { queue.reportFailure(); return false; });
	// The default 64-row queue overflowed during the connection burst (a dozen catalog snapshots) and silently dropped the
	// agent_registered row, so the matrix runner never saw the goal start. Registration and goal rows must survive that burst.
	queue = new BestEffortDiagnosticQueue({ maxPending: 1_024, ...dependencies, ready });
	const requireReady = async () => {
		if (!await ready) throw new Error('protocol audit directory is unavailable');
	};
	// Handshake and registration rows are evidence the harness waits on. They bypass the 250 ms best-effort timeout
	// and retry while the sink is busy (for example a timed-out earlier append still holding the file).
	const criticalAttempts = dependencies.criticalAttempts ?? 40;
	const criticalDelayMs = dependencies.criticalRetryDelayMs ?? 50;
	let criticalChain = Promise.resolve();
	const writeCritical = (encoded) => {
		criticalChain = criticalChain.then(async () => {
			for (let attempt = 1; attempt <= criticalAttempts; attempt += 1) {
				try { await requireReady(); await sink.append(encoded, { encoding: 'utf8', flag: 'a' }, { waitForIdle: true }); return; }
				catch { if (attempt < criticalAttempts) await new Promise((resolve) => setTimeout(resolve, criticalDelayMs)); }
			}
			queue.reportFailure();
		}).catch(() => {});
	};
	const audit = (direction, envelope) => {
		if (closed) return Promise.resolve();
		try {
			const safeMetadata = sanitizeDiagnosticValue(metadata);
			const row = Object.assign(Object.create(null),
				safeMetadata !== null && typeof safeMetadata === 'object' && !Array.isArray(safeMetadata) ? safeMetadata : {},
				{ direction: sanitizeDiagnosticValue(direction), envelope: sanitizeDiagnosticValue(envelope) });
			const encoded = `${JSON.stringify(row)}\n`;
			if (CRITICAL_AUDIT_TYPES.has(row.envelope?.type)) writeCritical(encoded);
			else queue.submit(async () => { await requireReady(); await sink.append(encoded, { encoding: 'utf8', flag: 'a' }); });
		} catch { /* invalid audit evidence is observational */ }
		return Promise.resolve();
	};
	audit.close = () => {
		if (closePromise !== null) return closePromise;
		closed = true;
		const criticalClose = new Promise((resolve) => {
			const timer = setTimeout(() => { queue.reportFailure(); resolve(); }, dependencies.closeTimeoutMs ?? 1_000);
			criticalChain.then(() => { clearTimeout(timer); resolve(); });
		});
		closePromise = Promise.all([queue.close(), criticalClose]).then(() => undefined);
		return closePromise;
	};
	audit.statusSnapshot = () => Object.freeze({ ...queue.statusSnapshot('protocol_audit'), droppedCount: queue.droppedCount });
	return audit;
}

export async function startVoiceWorker(config, environment = process.env, dependencies = {}) {
	if (strictSpendRuntime(environment)) throw codedRuntimeError('STRICT_SPEND_AUXILIARY_DISABLED', 'Voice is disabled in strict spend mode');
	if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('voice worker config must be an object');
	if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('voice worker environment must be an object');
	const voice = config.voice ?? {};
	const localSpeechTimeoutMs = voice.localSpeechTimeoutMs ?? DEFAULT_LOCAL_SPEECH_TIMEOUT_MS;
	if (!Number.isSafeInteger(localSpeechTimeoutMs) || localSpeechTimeoutMs < 1 || localSpeechTimeoutMs > 600_000) {
		throw new TypeError('voice.localSpeechTimeoutMs must be between 1 and 600000');
	}
	const signal = dependencies.signal;
	const reportVoiceDiagnostic = dependencies.reportVoiceDiagnostic ?? (() => {});
	if (typeof reportVoiceDiagnostic !== 'function') throw new TypeError('reportVoiceDiagnostic must be a function');
	if (signal !== undefined && (signal === null || typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
		throw new TypeError('voice startup signal must be an AbortSignal');
	}
	throwIfVoiceStartupAborted(signal);
	const fishApiKey = firstNonBlank(
		environment[voice.fishApiKeyEnvironmentVariable ?? DEFAULT_FISH_API_KEY_ENVIRONMENT_VARIABLE],
		environment.FISH_API_KEY,
	);
	const deepgramApiKey = firstNonBlank(
		environment[voice.deepgramApiKeyEnvironmentVariable ?? DEFAULT_DEEPGRAM_API_KEY_ENVIRONMENT_VARIABLE],
	);
	const platform = dependencies.platform ?? process.platform;
	const openaiApiKey = firstNonBlank(environment[voice.openaiApiKeyEnvironmentVariable ?? 'OPENAI_API_KEY']);
	if (voice.provider === 'openai') {
		if (openaiApiKey === null) throw codedRuntimeError('VOICE_OPENAI_KEY_MISSING', 'Set OPENAI_API_KEY on the host and restart Minecraft to enable OpenAI speech');
		return startOpenAiVoiceWorker(voice, openaiApiKey, dependencies, { signal, reportVoiceDiagnostic, localSpeechTimeoutMs });
	}
	const createLocalSpeechProvider = dependencies.createLocalSpeechProvider
		?? ((options) => LocalSpeechProvider.createIfAvailable(options));
	if (typeof createLocalSpeechProvider !== 'function') throw new TypeError('createLocalSpeechProvider must be a function');
	let localSpeechProvider = null;
	let profiles = null;
	let profileStore = null;
	let worker = null;
	try {
		localSpeechProvider = await createLocalSpeechProvider({
			executable: firstNonBlank(environment.ARENA_AGENT_SPEECH_PYTHON, voice.localSpeechPythonPath)
				?? path.resolve(PROJECT_DIRECTORY, defaultLocalSpeechPythonPath(platform)),
			scriptPath: path.join(SOURCE_DIRECTORY, 'voice', 'local-speech-worker.py'),
			timeoutMs: localSpeechTimeoutMs,
			environment,
			signal,
			accessFile: dependencies.localSpeechAccess,
		});
		throwIfVoiceStartupAborted(signal);
		if (localSpeechProvider === null && fishApiKey === null && deepgramApiKey === null && platform !== 'win32') return null;
		const voiceSecret = await resolveVoiceSecret(voice, dependencies.readVoiceSecret ?? readFile, signal);
		throwIfVoiceStartupAborted(signal);
		const createFishTtsProvider = dependencies.createTtsProvider ?? ((options) => new FishTtsProvider(options));
		let fishTtsProvider;
		const createTtsProvider = (options) => fishTtsProvider ??= createFishTtsProvider(options);
		const createWindowsTtsProvider = dependencies.createWindowsTtsProvider ?? ((options) => new WindowsTtsProvider(options));
		const createSttProvider = dependencies.createSttProvider ?? ((options) => new DeepgramSttProvider(options));
		const createServer = dependencies.createVoiceServer ?? createVoiceHttpServer;
		if (typeof createFishTtsProvider !== 'function') throw new TypeError('createTtsProvider must be a function');
		if (typeof createWindowsTtsProvider !== 'function') throw new TypeError('createWindowsTtsProvider must be a function');
		if (typeof createServer !== 'function') throw new TypeError('createVoiceServer must be a function');
		const hasTtsProvider = localSpeechProvider !== null || fishApiKey !== null || platform === 'win32';
		if (hasTtsProvider) {
			const profilePath = dependencies.profilePath
				?? voice.profileAssignmentsPath
				?? path.resolve(PROJECT_DIRECTORY, DEFAULT_VOICE_PROFILE_ASSIGNMENTS_PATH);
			const loadProfileStore = dependencies.loadProfileStore ?? loadPersistentVoiceProfileStore;
			if (typeof loadProfileStore !== 'function') throw new TypeError('loadProfileStore must be a function');
			try {
				profiles = await loadProfileStore(profilePath, { ...(dependencies.voiceProfileIo ?? {}), signal });
			} catch (error) {
				if (!canUseVolatileLocalProfiles({ error, localSpeechProvider, fishApiKey, deepgramApiKey, platform })) throw error;
				profiles = { store: new VoiceProfileStore() };
			}
			throwIfVoiceStartupAborted(signal);
			if (profiles === null || typeof profiles !== 'object' || profiles.store === null || typeof profiles.store?.resolve !== 'function') {
				throw new TypeError('loadProfileStore must return a profile store');
			}
			profileStore = voiceProfileStoreWithLifecycle(profiles);
		} else {
			profileStore = voiceProfileStoreWithLifecycle({ store: STT_ONLY_PROFILE_STORE });
		}
		if (deepgramApiKey !== null && typeof createSttProvider !== 'function') throw new TypeError('createSttProvider must be a function when Deepgram is configured');
		let provider;
		let sttProvider;
		let ownedSpeechProvider = localSpeechProvider;
		if (localSpeechProvider !== null) {
			const fallback = fishApiKey !== null || deepgramApiKey !== null
				? createRemoteFirstSpeechRouting(localSpeechProvider, {
					fishApiKey,
					deepgramApiKey,
					platform,
					createTtsProvider,
					createWindowsTtsProvider,
					createSttProvider,
					fallbackCircuit: voiceFallbackCircuitOptions(dependencies),
				})
				: createLocalSpeechFailover(localSpeechProvider, {
				fishApiKey,
				deepgramApiKey,
				platform,
				createTtsProvider,
				createWindowsTtsProvider,
				createSttProvider,
				fallbackCircuit: voiceFallbackCircuitOptions(dependencies),
				});
			provider = fallback.tts;
			sttProvider = fallback.stt;
			ownedSpeechProvider = fallback;
		} else {
			provider = fishApiKey === null
				? (platform === 'win32' ? createWindowsTtsProvider({}) : null)
				: createTtsProvider({ apiKey: fishApiKey });
			if (fishApiKey !== null && platform === 'win32') {
				provider = ttsProviderWithFallback(provider, createWindowsTtsProvider({}), voiceFallbackCircuitOptions(dependencies));
			}
			sttProvider = deepgramApiKey === null ? new NoSttProvider() : createSttProvider({ apiKey: deepgramApiKey });
		}
		emitVoiceDiagnostic(reportVoiceDiagnostic, fishApiKey === null
			? {
				code: 'VOICE_TTS_REMOTE_UNCONFIGURED',
				effectiveProvider: voiceProviderNamespace(provider, 'tts/unavailable'),
				reason: 'fish_credential_missing',
			}
			: {
				code: 'VOICE_TTS_REMOTE_CONFIGURED',
				effectiveProvider: voiceProviderNamespace(provider, 'fish/s2.1-pro-free'),
				reason: 'fish_credential_configured',
			});
		worker = createServer({
			provider,
			fishProvider: fishApiKey === null ? null : createTtsProvider({ apiKey: fishApiKey }),
			sttProvider,
			profileStore,
			secret: voiceSecret,
			port: voice.port ?? DEFAULT_VOICE_PORT,
			maxConcurrent: voice.maxConcurrent ?? DEFAULT_VOICE_MAX_CONCURRENT,
			requestTimeoutMs: localSpeechTimeoutMs,
			onDiagnostic: reportVoiceDiagnostic,
		});
		throwIfVoiceStartupAborted(signal);
		if (worker === null || typeof worker !== 'object' || typeof worker.start !== 'function' || typeof worker.close !== 'function') {
			throw new TypeError('createVoiceServer must return a voice worker');
		}
		await worker.start({ signal });
		throwIfVoiceStartupAborted(signal);
		return localSpeechProvider === null ? worker : voiceWorkerWithOwnedProvider(worker, ownedSpeechProvider);
	} catch (error) {
		await settleVoiceBootstrapCleanup(
			[
				() => worker?.close(),
				() => profileStore === null ? closeLoadedVoiceProfiles(profiles) : profileStore.close(),
				() => localSpeechProvider?.close(),
			],
			dependencies.cleanupTimeoutMs ?? 1_000,
		);
		throw error;
	}
}

async function startOpenAiVoiceWorker(voice, apiKey, dependencies, { signal, reportVoiceDiagnostic, localSpeechTimeoutMs }) {
	let profiles = null;
	let profileStore = null;
	let worker = null;
	try {
		const secret = await resolveVoiceSecret(voice, dependencies.readVoiceSecret ?? readFile, signal);
		throwIfVoiceStartupAborted(signal);
		const loadProfiles = dependencies.loadProfileStore ?? loadPersistentVoiceProfileStore;
		profiles = await loadProfiles(dependencies.profilePath ?? voice.profileAssignmentsPath
			?? path.resolve(PROJECT_DIRECTORY, DEFAULT_VOICE_PROFILE_ASSIGNMENTS_PATH), { ...(dependencies.voiceProfileIo ?? {}), signal });
		throwIfVoiceStartupAborted(signal);
		profileStore = voiceProfileStoreWithLifecycle(profiles);
		const provider = (dependencies.createOpenAiTtsProvider ?? (options => new OpenAiTtsProvider(options)))({ apiKey, model: voice.openaiTtsModel ?? DEFAULT_OPENAI_TTS_MODEL });
		const sttProvider = (dependencies.createOpenAiSttProvider ?? (options => new OpenAiSttProvider(options)))({ apiKey, model: voice.openaiSttModel ?? DEFAULT_OPENAI_STT_MODEL });
		worker = (dependencies.createVoiceServer ?? createVoiceHttpServer)({
			provider, sttProvider, profileStore, secret, port: voice.port ?? DEFAULT_VOICE_PORT,
			maxConcurrent: voice.maxConcurrent ?? DEFAULT_VOICE_MAX_CONCURRENT, requestTimeoutMs: localSpeechTimeoutMs,
			directorUsesPrimaryProvider: true, onDiagnostic: reportVoiceDiagnostic,
		});
		await worker.start({ signal });
		throwIfVoiceStartupAborted(signal);
		emitVoiceDiagnostic(reportVoiceDiagnostic, { code: 'VOICE_OPENAI_CONFIGURED', effectiveProvider: provider.cacheNamespace(), reason: 'openai_credential_configured' });
		return worker;
	} catch (error) {
		await settleVoiceBootstrapCleanup([
			() => worker?.close(), () => profileStore === null ? closeLoadedVoiceProfiles(profiles) : profileStore.close(),
		], dependencies.cleanupTimeoutMs ?? 1_000);
		throw error;
	}
}

function createRemoteFirstSpeechRouting(localProvider, {
	fishApiKey,
	deepgramApiKey,
	platform,
	createTtsProvider,
	createWindowsTtsProvider,
	createSttProvider,
	fallbackCircuit,
}) {
	const owned = new Set([localProvider]);
	let provider = localProvider;
	let sttProvider = localProvider;
	let localTtsFallback = localProvider;
	if (platform === 'win32') {
		const windows = createWindowsTtsProvider({});
		owned.add(windows);
		localTtsFallback = ttsProviderWithFallback(localProvider, windows, fallbackCircuit);
	}
	if (fishApiKey !== null) {
		const fish = createTtsProvider({ apiKey: fishApiKey });
		owned.add(fish);
		provider = ttsProviderWithFallback(fish, localTtsFallback, fallbackCircuit);
	} else {
		provider = localTtsFallback;
	}
	if (deepgramApiKey !== null) {
		const deepgram = createSttProvider({ apiKey: deepgramApiKey });
		owned.add(deepgram);
		sttProvider = sttProviderWithFallback(deepgram, localProvider);
	}
	const localIsPrimary = fishApiKey === null || deepgramApiKey === null;
	let warmupPromise = null;
	return Object.freeze({
		tts: provider,
		stt: sttProvider,
		warmup({ signal } = {}) {
			if (!localIsPrimary || typeof localProvider.warmup !== 'function') return;
			warmupPromise ??= Promise.resolve(localProvider.warmup({ signal })).catch((error) => {
				if (error?.name === 'AbortError' || signal?.aborted) {
					warmupPromise = null;
					throw error;
				}
				return undefined;
			});
			return warmupPromise;
		},
		async close() {
			await Promise.allSettled([...owned].map((candidate) => candidate?.close?.()));
		},
	});
}

function sttProviderWithFallback(primary, fallback) {
	return Object.freeze({
		async transcribe(request) {
			try {
				return await primary.transcribe(request);
			} catch (error) {
				if (!shouldUseLocalSttFallback(error, request?.signal)) throw error;
				return fallback.transcribe(request);
			}
		},
	});
}

function canUseVolatileLocalProfiles({ error, localSpeechProvider, fishApiKey, deepgramApiKey, platform }) {
	if (localSpeechProvider === null || fishApiKey !== null || deepgramApiKey === null || platform === 'win32') return false;
	if (error instanceof SyntaxError) return true;
	return ['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(error?.code);
}

function voiceProfileStoreWithLifecycle(profiles) {
	const store = profiles.store;
	const flush = profiles.flush ?? store.flush;
	const close = profiles.close ?? store.close;
	if (flush !== undefined && typeof flush !== 'function') throw new TypeError('profile store flush must be a function');
	if (close !== undefined && typeof close !== 'function') throw new TypeError('profile store close must be a function');
	const flushOperation = flush === undefined
		? null
		: flush.bind(typeof profiles.flush === 'function' ? profiles : store);
	const closeOperation = close === undefined
		? null
		: close.bind(typeof profiles.close === 'function' ? profiles : store);
	let closePromise = null;
	return Object.freeze({
		resolve(agentId) { return store.resolve(agentId); },
		...(typeof store.resolveRequested === 'function' ? { resolveRequested: store.resolveRequested.bind(store) } : {}),
		remove(agentId) { return store.remove?.(agentId) ?? false; },
		flush(options) { return flushOperation === null ? Promise.resolve() : flushOperation(options); },
		close() {
			closePromise ??= Promise.resolve().then(() => closeOperation === null ? flushOperation?.() : closeOperation());
			return closePromise;
		},
	});
}

function closeLoadedVoiceProfiles(profiles) {
	if (profiles === null || typeof profiles !== 'object') return undefined;
	if (typeof profiles.close === 'function') return profiles.close();
	if (typeof profiles.store?.close === 'function') return profiles.store.close();
	if (typeof profiles.flush === 'function') return profiles.flush();
	if (typeof profiles.store?.flush === 'function') return profiles.store.flush();
	return undefined;
}

async function settleVoiceBootstrapCleanup(operations, timeoutMs) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('voice cleanup timeout must be positive');
	const cleanup = Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)));
	let timer;
	await Promise.race([
		cleanup,
		new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
	]);
	clearTimeout(timer);
}

function throwIfVoiceStartupAborted(signal) {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error('Voice startup was cancelled');
	error.name = 'AbortError';
	error.code = 'VOICE_OPERATION_CANCELLED';
	throw error;
}

function voiceWorkerWithOwnedProvider(worker, provider) {
	let closePromise = null;
	return Object.freeze({
		...worker,
		start: worker.start.bind(worker),
		warmup: typeof provider.warmup === 'function'
			? ({ signal } = {}) => provider.warmup({ signal })
			: undefined,
		close() {
			closePromise ??= Promise.allSettled([worker.close(), provider.close()]).then(() => undefined);
			return closePromise;
		},
	});
}

function defaultLocalSpeechPythonPath(platform) {
	return path.join(
		DEFAULT_LOCAL_SPEECH_PYTHON_DIRECTORY,
		platform === 'win32' ? 'Scripts' : 'bin',
		platform === 'win32' ? 'python.exe' : 'python',
	);
}

function createLocalSpeechFailover(localProvider, {
	fishApiKey,
	deepgramApiKey,
	platform,
	createTtsProvider,
	createWindowsTtsProvider,
	createSttProvider,
	fallbackCircuit,
}) {
	let activeTts = localProvider;
	let activeStt = localProvider;
	let fallbackTts = null;
	let fallbackStt = null;
	let localUnavailable = false;
	let ttsTransitionPromise = null;
	let sttTransitionPromise = null;
	let warmupPromise = null;
	let localClosePromise = null;
	const closeLocal = () => {
		localClosePromise ??= Promise.resolve().then(() => localProvider.close?.()).then(() => undefined, () => undefined);
		return localClosePromise;
	};
	const closeLocalIfUnused = () => {
		if (activeTts === localProvider || activeStt === localProvider) return Promise.resolve();
		localUnavailable = true;
		return closeLocal();
	};
	const fallbackTtsFactory = () => {
		if (fallbackTts !== null) return fallbackTts;
		if (fishApiKey !== null) {
			const fish = createTtsProvider({ apiKey: fishApiKey });
			fallbackTts = platform === 'win32'
				? ttsProviderWithFallback(fish, createWindowsTtsProvider({}), fallbackCircuit)
				: fish;
			return fallbackTts;
		}
		if (platform === 'win32') fallbackTts = createWindowsTtsProvider({});
		return fallbackTts;
	};
	const fallbackSttFactory = () => {
		if (fallbackStt !== null) return fallbackStt;
		fallbackStt = deepgramApiKey === null
			? new NoSttProvider()
			: createSttProvider({ apiKey: deepgramApiKey });
		return fallbackStt;
	};
	const switchTtsToFallback = async (error, signal, allowUnavailable = false) => {
		if (!shouldUseLocalTtsFallback(error, signal)) throw error;
		if (fishApiKey === null && platform !== 'win32' && !allowUnavailable) throw error;
		if (activeTts !== localProvider) return;
		ttsTransitionPromise ??= Promise.resolve().then(async () => {
			throwIfVoiceStartupAborted(signal);
			if (activeTts === localProvider) activeTts = fallbackTtsFactory();
			await closeLocalIfUnused();
		}).catch((transitionError) => {
			ttsTransitionPromise = null;
			throw transitionError;
		});
		await ttsTransitionPromise;
	};
	const switchSttToFallback = async (error, signal, allowUnavailable = false) => {
		if (!shouldUseLocalSttFallback(error, signal)) throw error;
		if (deepgramApiKey === null && !allowUnavailable) throw error;
		if (activeStt !== localProvider) return;
		sttTransitionPromise ??= Promise.resolve().then(async () => {
			throwIfVoiceStartupAborted(signal);
			if (activeStt === localProvider) activeStt = fallbackSttFactory();
			await closeLocalIfUnused();
		}).catch((transitionError) => {
			sttTransitionPromise = null;
			throw transitionError;
		});
		await sttTransitionPromise;
	};
	const switchFailedWarmupChannels = async ({ sttReady, ttsReady }, error, signal) => {
		if (error?.name === 'AbortError' || signal?.aborted) throw error;
		const ttsUsable = ttsReady || fishApiKey !== null || platform === 'win32';
		const sttUsable = sttReady || deepgramApiKey !== null;
		if (!ttsReady && !sttReady) {
			if (!ttsUsable && !sttUsable) throw error;
			await closeLocal();
			throwIfVoiceStartupAborted(signal);
			await Promise.all([
				switchTtsToFallback(error, signal, true),
				switchSttToFallback(error, signal, true),
			]);
			return;
		}
		await Promise.all([
			ttsReady ? undefined : switchTtsToFallback(error, signal, true),
			sttReady ? undefined : switchSttToFallback(error, signal, true),
		]);
	};
	return Object.freeze({
		tts: Object.freeze({
			cacheNamespace() {
				if (activeTts === localProvider) return 'local-chatterbox/chatterbox-v1';
				if (activeTts === null) return 'tts/unavailable';
				return providerCacheNamespace(
					activeTts,
					fishApiKey !== null ? 'fish/s2.1-pro-free' : 'windows/system-speech',
				);
			},
			async synthesize(request) {
				if (activeTts !== null) {
					const attemptedProvider = activeTts;
					const attemptedNamespace = attemptedProvider === localProvider
						? 'local-chatterbox/chatterbox-v1'
						: providerCacheNamespace(
							attemptedProvider,
							fishApiKey !== null ? 'fish/s2.1-pro-free' : 'windows/system-speech',
						);
					try {
						return tagSynthesisCacheNamespace(await attemptedProvider.synthesize(request), attemptedNamespace);
					} catch (error) {
						if (attemptedProvider !== localProvider) throw error;
						await switchTtsToFallback(error, request?.signal);
						const fallbackNamespace = providerCacheNamespace(
							activeTts,
							fishApiKey !== null ? 'fish/s2.1-pro-free' : 'windows/system-speech',
						);
						return tagSynthesisCacheNamespace(await activeTts.synthesize(request), fallbackNamespace);
					}
				}
				const error = new Error('Speech synthesis is not configured');
				error.code = 'TTS_UNAVAILABLE';
				throw error;
			},
		}),
		stt: Object.freeze({
			async transcribe(request) {
				const attemptedProvider = activeStt;
				try {
					return await attemptedProvider.transcribe(request);
				} catch (error) {
					if (attemptedProvider !== localProvider) throw error;
					await switchSttToFallback(error, request?.signal);
					return activeStt.transcribe(request);
				}
			},
		}),
		warmup({ signal } = {}) {
			if (localUnavailable || typeof localProvider.warmup !== 'function') return;
			warmupPromise ??= (async () => {
				let readiness;
				try {
					readiness = await localProvider.warmup({ signal });
				} catch (error) {
					await switchFailedWarmupChannels({ sttReady: false, ttsReady: false }, error, signal);
					return;
				}
				if (readiness === undefined) return;
				if (readiness === null || typeof readiness !== 'object'
						|| typeof readiness.sttReady !== 'boolean' || typeof readiness.ttsReady !== 'boolean') {
					throw new TypeError('local speech warmup must return channel readiness');
				}
				if (readiness.sttReady && readiness.ttsReady) return;
				const retryLocalOnlyChannel = (!readiness.sttReady && deepgramApiKey === null)
						|| (!readiness.ttsReady && fishApiKey === null && platform !== 'win32');
				if (retryLocalOnlyChannel && (readiness.sttReady || readiness.ttsReady)) {
					try {
						const retried = await localProvider.warmup({ signal });
						if (retried === null || typeof retried !== 'object'
								|| typeof retried.sttReady !== 'boolean' || typeof retried.ttsReady !== 'boolean') {
							throw new TypeError('local speech warmup must return channel readiness');
						}
						readiness = retried;
					} catch (error) {
						if (error?.name === 'AbortError' || signal?.aborted) throw error;
					}
					if (readiness.sttReady && readiness.ttsReady) return;
				}
				const error = Object.assign(new Error('Local speech warmup did not initialize every channel'), {
					code: 'LOCAL_SPEECH_WARMUP_FAILED',
				});
				await switchFailedWarmupChannels(readiness, error, signal);
			})().catch((error) => {
				warmupPromise = null;
				throw error;
			});
			return warmupPromise;
		},
		async close() {
			await Promise.allSettled([
				closeLocal(),
				fallbackTts?.close?.(),
				fallbackStt?.close?.(),
			]);
		},
	});
}

function shouldUseLocalTtsFallback(error, signal) {
	if (error?.name === 'AbortError' || signal?.aborted) return false;
	if (error instanceof TypeError || error?.code === 'TTS_INVALID_REQUEST') return false;
	return true;
}

function shouldUseLocalSttFallback(error, signal) {
	if (error?.name === 'AbortError' || signal?.aborted) return false;
	if (error instanceof TypeError || ['STT_INVALID_REQUEST', 'STT_MALFORMED_AUDIO'].includes(error?.code)) return false;
	return true;
}

function voiceFallbackCircuitOptions(dependencies) {
	return {
		now: dependencies.voiceFallbackNow ?? Date.now,
		baseDelayMs: dependencies.voiceFallbackBaseDelayMs ?? DEFAULT_FISH_FALLBACK_BASE_DELAY_MS,
		maxDelayMs: dependencies.voiceFallbackMaxDelayMs ?? DEFAULT_FISH_FALLBACK_MAX_DELAY_MS,
		onDiagnostic: dependencies.reportVoiceDiagnostic ?? (() => {}),
	};
}

function ttsProviderWithFallback(primary, fallback, {
	now = Date.now,
	baseDelayMs = DEFAULT_FISH_FALLBACK_BASE_DELAY_MS,
	maxDelayMs = DEFAULT_FISH_FALLBACK_MAX_DELAY_MS,
	onDiagnostic = () => {},
} = {}) {
	if (typeof now !== 'function') throw new TypeError('Fish fallback clock must be a function');
	if (typeof onDiagnostic !== 'function') throw new TypeError('Fish fallback diagnostic reporter must be a function');
	if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1) throw new TypeError('Fish fallback base delay must be positive');
	if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw new TypeError('Fish fallback maximum delay must not be less than its base delay');
	let consecutiveFailures = 0;
	let nextProbeAt = null;
	let probePromise = null;
	const readNow = () => {
		const value = now();
		if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Fish fallback clock must return a non-negative safe integer');
		return value;
	};
	const primaryProvider = voiceProviderNamespace(primary, 'tts/primary');
	const fallbackProvider = voiceProviderNamespace(fallback, 'tts/fallback');
	const recordFailure = (error) => {
		consecutiveFailures = Math.min(consecutiveFailures + 1, 31);
		const exponent = Math.min(consecutiveFailures - 1, 30);
		const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
		nextProbeAt = Math.min(Number.MAX_SAFE_INTEGER, readNow() + delay);
		emitVoiceDiagnostic(onDiagnostic, {
			code: 'VOICE_TTS_FALLBACK_ACTIVATED',
			primaryProvider,
			effectiveProvider: fallbackProvider,
			failureCode: voiceDiagnosticFailureCode(error),
		});
	};
	const synthesizeFallback = async (request) => {
		const output = await fallback.synthesize(request);
		return tagSynthesisCacheNamespace(
			{ ...output, cacheable: false },
			providerCacheNamespace(fallback, 'windows/system-speech'),
		);
	};
	const attemptPrimary = async (request) => {
		const recovering = nextProbeAt !== null;
		try {
			const output = await primary.synthesize(request);
			consecutiveFailures = 0;
			nextProbeAt = null;
			if (recovering) emitVoiceDiagnostic(onDiagnostic, {
				code: 'VOICE_TTS_PRIMARY_RESTORED',
				primaryProvider,
				effectiveProvider: primaryProvider,
			});
			return tagSynthesisCacheNamespace(output, providerCacheNamespace(primary, 'fish/s2.1-pro-free'));
		} catch (error) {
			if (!shouldUseWindowsTtsFallback(error)) throw error;
			recordFailure(error);
			return synthesizeFallback(request);
		}
	};
	return Object.freeze({
		cacheNamespace() {
			return nextProbeAt === null
				? providerCacheNamespace(primary, 'fish/s2.1-pro-free')
				: providerCacheNamespace(fallback, 'windows/system-speech');
		},
		async synthesize(request) {
			if (nextProbeAt === null) return attemptPrimary(request);
			if (probePromise !== null || readNow() < nextProbeAt) return synthesizeFallback(request);
			probePromise = attemptPrimary(request).finally(() => { probePromise = null; });
			return probePromise;
		},
	});
}

function voiceProviderNamespace(provider, fallback) {
	try {
		const namespace = providerCacheNamespace(provider, fallback);
		return /^[a-z0-9][a-z0-9._/-]{0,127}$/.test(namespace) ? namespace : 'tts/unspecified';
	} catch {
		return 'tts/unspecified';
	}
}

function voiceDiagnosticFailureCode(error) {
	const value = error?.code;
	return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'TTS_PROVIDER_ERROR';
}

function emitVoiceDiagnostic(reporter, event) {
	try { reporter(Object.freeze({ ...event })); }
	catch { /* voice diagnostics are observational */ }
}

function writeVoiceDiagnostic(event) {
	const fields = Object.entries(event)
		.filter(([key]) => key !== 'code')
		.map(([key, value]) => `${key}=${value}`)
		.join(' ');
	process.stderr.write(`[voice] ${event.code}${fields === '' ? '' : ` ${fields}`}\n`);
}

function shouldUseWindowsTtsFallback(error) {
	if (error?.name === 'AbortError') return false;
	return error?.name === 'TimeoutError' || WINDOWS_TTS_FALLBACK_CODES.has(error?.code);
}

function normalizeVoiceConfig(value, environment) {
	const source = value ?? {};
	const configuredPort = environment.ARENA_AGENT_VOICE_PORT === undefined
		? source.port ?? DEFAULT_VOICE_PORT
		: Number(environment.ARENA_AGENT_VOICE_PORT);
	if (!Number.isSafeInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) throw new TypeError('voice.port must be an integer between 1 and 65535');
	const maxConcurrent = positiveInteger(source.maxConcurrent ?? DEFAULT_VOICE_MAX_CONCURRENT, 'voice.maxConcurrent');
	if (maxConcurrent > 5) throw new TypeError('voice.maxConcurrent must not exceed 5');
	const profileAssignmentsPath = path.resolve(PROJECT_DIRECTORY, source.profileAssignmentsPath ?? DEFAULT_VOICE_PROFILE_ASSIGNMENTS_PATH);
	const localSpeechTimeoutMs = positiveInteger(source.localSpeechTimeoutMs ?? DEFAULT_LOCAL_SPEECH_TIMEOUT_MS, 'voice.localSpeechTimeoutMs');
	if (localSpeechTimeoutMs > 600_000) throw new TypeError('voice.localSpeechTimeoutMs must not exceed 600000');
	const secret = firstNonBlank(source.secret, environment.ARENA_AGENT_VOICE_SECRET);
	const configuredSecretFile = firstNonBlank(source.secretFile, environment.ARENA_AGENT_VOICE_SECRET_FILE);
	return {
		...source,
		secret,
		secretFile: path.resolve(PROJECT_DIRECTORY, configuredSecretFile ?? DEFAULT_VOICE_SECRET_PATH),
		port: configuredPort,
		maxConcurrent,
		profileAssignmentsPath,
		localSpeechTimeoutMs,
		provider: requireSpeechProvider(source.provider ?? 'legacy'),
		openaiApiKeyEnvironmentVariable: requireEnvironmentVariableName(source.openaiApiKeyEnvironmentVariable ?? 'OPENAI_API_KEY', 'voice.openaiApiKeyEnvironmentVariable'),
		openaiTtsModel: source.openaiTtsModel ?? DEFAULT_OPENAI_TTS_MODEL,
		openaiSttModel: source.openaiSttModel ?? DEFAULT_OPENAI_STT_MODEL,
		fishApiKeyEnvironmentVariable: requireEnvironmentVariableName(source.fishApiKeyEnvironmentVariable ?? DEFAULT_FISH_API_KEY_ENVIRONMENT_VARIABLE, 'voice.fishApiKeyEnvironmentVariable'),
		deepgramApiKeyEnvironmentVariable: requireEnvironmentVariableName(source.deepgramApiKeyEnvironmentVariable ?? DEFAULT_DEEPGRAM_API_KEY_ENVIRONMENT_VARIABLE, 'voice.deepgramApiKeyEnvironmentVariable'),
	};
}

function requireSpeechProvider(value) {
	if (!['openai', 'legacy'].includes(value)) throw new TypeError('voice.provider must be openai or legacy');
	return value;
}

async function resolveVoiceSecret(voice, readSecretFile, signal) {
	throwIfVoiceStartupAborted(signal);
	let secret = firstNonBlank(voice.secret);
	if (secret === null) {
		if (typeof readSecretFile !== 'function') throw new TypeError('readVoiceSecret must be a function');
		let onAbort;
		try {
			const read = Promise.resolve().then(() => readSecretFile(voice.secretFile, { encoding: 'utf8', signal }));
			const aborted = new Promise((_, reject) => {
				onAbort = () => { try { throwIfVoiceStartupAborted(signal); } catch (error) { reject(error); } };
				signal?.addEventListener('abort', onAbort, { once: true });
				if (signal?.aborted) onAbort();
			});
			secret = firstNonBlank(await Promise.race([read, aborted]));
		} catch (error) {
			throwIfVoiceStartupAborted(signal);
			throw codedRuntimeError('VOICE_SECRET_UNAVAILABLE', 'Dedicated voice authentication secret is unavailable', error);
		} finally {
			if (onAbort) signal?.removeEventListener('abort', onAbort);
		}
	}
	if (secret !== null) secret = secret.trim();
	if (secret === null || secret.length < 16 || secret.length > 512) {
		throw codedRuntimeError('VOICE_SECRET_INVALID', 'Dedicated voice authentication secret must contain 16 to 512 characters');
	}
	return secret;
}

function firstNonBlank(...values) {
	for (const value of values) if (typeof value === 'string' && value.trim() !== '') return value;
	return null;
}

function requireEnvironmentVariableName(value, field) {
	if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(value)) throw new TypeError(`${field} must be an environment variable name`);
	return value;
}

function requireDependency(value, name) {
	if (value === null || value === undefined) throw new TypeError(`${name} is required`);
	return value;
}

function defaultStatusInterval(callback, milliseconds) {
	const handle = setInterval(callback, milliseconds);
	handle.unref?.();
	return handle;
}

function positiveInteger(value, field) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
	return value;
}

function nonNegativeInteger(value, field) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
	return value;
}

function safeClockRead(clock) {
	try {
		const value = clock();
		return Number.isFinite(value) && value >= 0 ? value : null;
	} catch {
		return null;
	}
}

function codedRuntimeError(code, message, cause = undefined) {
	return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function isTransientCompletionSendError(error) {
	return ['BRIDGE_NOT_READY', 'BRIDGE_DISCONNECTED', 'CONNECTION_BACKPRESSURE', 'AGENT_BACKPRESSURE'].includes(error?.code);
}

function verboseErrorMessage(error) {
	const code = String(error?.code ?? 'COORDINATOR_ERROR').slice(0, 128);
	return `${verboseErrorScope(code)} error (${code}).`;
}

function verboseRecoveryMessage(recovery) {
	if (recovery.quiet) return 'Provider output was incomplete; retrying from the next fresh observation.';
	if (recovery.blocked) return 'Provider access is unavailable; retrying automatically from fresh state.';
	return 'Provider work failed; recovering automatically from fresh state.';
}

function sanitizeVerboseMessage(stage, message) {
	const normalized = String(message ?? '')
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (stage === 'error') {
		const code = normalized.match(/\(([A-Z][A-Z0-9_]{1,127})\)/)?.[1]
			?? normalized.match(/\b[A-Z][A-Z0-9_]{2,127}\b/)?.[0]
			?? 'COORDINATOR_ERROR';
		const scope = /^(Provider|Planning|Coordinator) error \(/i.exec(normalized)?.[1] ?? verboseErrorScope(code);
		return `${scope[0].toUpperCase()}${scope.slice(1).toLowerCase()} error (${code}).`.slice(0, MAX_VERBOSE_MESSAGE_LENGTH);
	}
	return sanitizeVerboseOutput(normalized).slice(0, MAX_VERBOSE_MESSAGE_LENGTH);
}

function verboseDecisionSummary(decision) {
	return sanitizePublicNarrative(decision?.summary) || 'Plan accepted.';
}

function verboseTransitionIdentity(stage, message, value) {
	const defaults = {
		conversation: { component: 'conversation', boundary: 'message', code: 'MESSAGE_RECEIVED', state: 'ready' },
		decision: { component: 'provider', boundary: 'planning', code: 'PLAN_ACCEPTED', state: 'ready' },
		error: { component: 'coordinator', boundary: 'agent_work', code: 'COORDINATOR_ERROR', state: 'degraded' },
		lifecycle: { component: 'lifecycle', boundary: 'goal', code: 'LIFECYCLE_CHANGED', state: 'ready' },
		retry: { component: 'provider', boundary: 'planning', code: 'PROVIDER_RETRY', state: 'retrying' },
	}[stage] ?? { component: 'coordinator', boundary: stage, code: 'STATUS_CHANGED', state: 'ready' };
	return {
		component: String(value?.component ?? defaults.component).slice(0, 128),
		boundary: String(value?.boundary ?? defaults.boundary).slice(0, 128),
		code: String(value?.code ?? defaults.code).slice(0, 128),
		state: String(value?.state ?? defaults.state).slice(0, 128),
		detail: message,
	};
}

function sanitizePublicAgentMessage(message) {
	return sanitizePublicNarrative(message);
}

function sanitizePublicNarrative(message) {
	const source = typeof message === 'string' ? message : String(message ?? '');
	let raw = source.slice(0, MAX_PUBLIC_NARRATIVE_RAW_CHARS);
	if (source.length > MAX_PUBLIC_NARRATIVE_RAW_CHARS) raw = completePublicSentences(raw);
	const visible = sanitizeVerboseOutput(raw);
	if (visible.length === 0 || /^[{]/.test(visible)) return '';
	const boundary = publicNarrativeBoundary(visible);
	return visible.slice(0, boundary ?? visible.length).replace(/[\s,;:-]+$/, '').trim().slice(0, MAX_VERBOSE_MESSAGE_LENGTH);
}

function completePublicSentences(value) {
	let boundary = 0;
	for (const match of value.matchAll(/[.!?](?=\s|$)/g)) boundary = match.index + match[0].length;
	return value.slice(0, boundary);
}

function publicNarrativeBoundary(value) {
	const matches = [
		value.search(/\{/),
		value.search(/\[\s*\{/),
		value.search(/\b(?:action[_ -]?id|native[_ -]?action|action[_ -]?call|call[_ -]?id|tool[_ -]?(?:call|record|result)|trace[_ -]?id|uuid|diagnostic|program[_ -]?(?:step|compiled|replaced))\b/i),
		value.search(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i),
		value.search(/\bnative:[a-z0-9._-]+:\d+:\d+\b/i),
		value.search(/\baction-progress-\d+\b/i),
		value.search(/\bcall_[a-z0-9]{3,}\b/i),
		value.search(/\b[a-z0-9._-]+:\d+:\d+:\d+:program-\d+-\d+:\d+:\d+:(?:arena-state|step)-\d+\b/i),
		value.search(/\bprogram-\d+-\d+:\d+:\d+:(?:arena-state|step)-\d+\b/i),
		value.search(/\btrace-[a-z0-9._:-]+-\d+-\d+-[a-z][a-z0-9_-]*\b/i),
		value.search(/\b(?:calling|executing|invoking)\s+[a-z][a-z0-9_]*\s+with\s+(?:[a-z][a-z0-9_]*\s*=|\{)/i),
	].filter((index) => index >= 0);
	return matches.length === 0 ? null : Math.min(...matches);
}

function verboseErrorScope(code) {
	if (/^(?:AUTHENTICATION_REQUIRED|PROVIDER|TURN_|REQUEST_TIMEOUT|MISSING_(?:AGENT|FINAL)_MESSAGE|SPAWN_|APP_SERVER_)/.test(code)) return 'Provider';
	if (/(?:DECISION|PLANNER|PLANNING_TIMEOUT|PLAN_|PARSE|DIRECTIVE|ARENA_SCRIPT)/.test(code)) return 'Planning';
	return 'Coordinator';
}

function sanitizeVerboseOutput(message) {
	return String(message ?? '')
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]')
		.replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_KEY]')
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH]')
		.replace(/(\b(?:secret|token|api[-_ ]?key|password|authorization)\b["']?\s*(?:[:=]\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
}

function factualProgressSignature(observation) {
	const projection = factualProgressProjection(observation);
	return createHash('sha256').update(JSON.stringify(sortFactualValue(projection))).digest('hex');
}

function factualProgressDetails(observation) {
	const player = observation?.player ?? {};
	const position = observation?.position ?? player.position ?? player;
	return {
		position: {
			x: finiteOrNull(position?.x),
			y: finiteOrNull(position?.y),
			z: finiteOrNull(position?.z),
		},
		lastResult: observation?.lastResult?.present === true ? {
			actionType: observation.lastResult.actionType,
			state: observation.lastResult.state,
			reasonCode: observation.lastResult.reasonCode,
		} : null,
	};
}

function factualProgressProjection(observation) {
	const player = observation?.player ?? {};
	const position = observation?.position ?? player.position ?? player;
	return {
		position: [finiteOrNull(position?.x), finiteOrNull(position?.y), finiteOrNull(position?.z)],
		alive: player.dead === true ? false : player.alive ?? null,
		health: finiteOrNull(player.health),
		inventory: (observation?.inventory?.items ?? []).map((item) => ({ itemId: item?.itemId ?? item?.id ?? null, count: item?.count ?? null })),
		blocks: (observation?.blocks ?? []).map((block) => ({ x: block?.x ?? null, y: block?.y ?? null, z: block?.z ?? null, blockId: block?.blockId ?? block?.id ?? null, state: block?.state ?? block?.properties ?? null })),
		advancements: observation?.advancements ?? null,
		killEvidence: observation?.killEvidence ?? null,
	};
}

// Same value with every object's keys in sorted order, so equal facts serialize identically.
function sortFactualValue(value) {
	if (Array.isArray(value)) {
		const sorted = new Array(value.length);
		for (let index = 0; index < value.length; index += 1) sorted[index] = sortFactualValue(value[index]);
		return sorted;
	}
	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value).sort();
		const sorted = {};
		for (const key of keys) {
			if (key === '__proto__') Object.defineProperty(sorted, key, { value: sortFactualValue(value[key]), enumerable: true, writable: true, configurable: true });
			else sorted[key] = sortFactualValue(value[key]);
		}
		return sorted;
	}
	return value;
}

function finiteOrNull(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * True when the only new perception is routine: sounds already summarised under `heard`, or the server echoing the
 * agent's own chat and action announcements ("<name> ...", "[name] Mining a block"), which its action results already carry.
 * Newly observed player-chat packets and advancement toasts remain facts for the next wake, preserving the base wake policy.
 */
export function routinePerceptionChange(payload, wireObservation, previousSequence, ownName = null, agentNames = []) {
	if (!Number.isSafeInteger(previousSequence)) return false;
	if (typeof payload?.trigger === 'string' && payload.trigger.trim().length > 0) return false;
	const changedFacts = Array.isArray(payload?.changedFacts) ? payload.changedFacts : [];
	if (changedFacts.length === 0 || !changedFacts.every((fact) => fact === 'perception')) return false;
	const events = Array.isArray(wireObservation.perception?.events) ? wireObservation.perception.events : [];
	const fresh = events.filter((event) => Number.isSafeInteger(event?.sequence) && event.sequence > previousSequence);
	const heard = hasHeardSection(wireObservation);
	return fresh.length > 0 && fresh.every((event) => ['player_chat', 'advancement_toast'].includes(event.type)
		|| (heard && event.type === 'sound') || ownEcho(event, ownName) || publicChatLine(event)
		// Every agent's activity line ("[name] Mining a block") is broadcast public chat: context, never a wake.
		|| agentNames.some((name) => ownEcho(event, name)));
}

/** Minecraft's line for an agent's public ("<name> text") or nearby ("[Nearby] <name> text") chat: context, never a wake. */
function publicChatLine(event) {
	return ['system_message', 'chat'].includes(event?.type) && typeof event.text === 'string' && /^(\[Nearby\] )?<[^<>\n]{1,64}> /.test(event.text);
}

function ownEcho(event, name) {
	if (typeof name !== 'string' || name.length === 0 || !['system_message', 'chat'].includes(event?.type) || typeof event.text !== 'string') return false;
	return event.text.startsWith(`[${name}] `) || event.text.startsWith(`<${name}> `);
}

/**
 * Drops the `sighted` fact when every new structure, built or point-of-interest row shows only blocks the agent placed
 * (placed: { x, y, z, blockId }), and the attention with it when nothing else changed and no reason was named.
 */
export function withoutOwnSightings(payload, wireObservation, placed) {
	const changedFacts = Array.isArray(payload?.changedFacts) ? payload.changedFacts : [];
	if (!changedFacts.includes('sighted')) return payload;
	const sighted = wireObservation?.sighted;
	const fresh = ['structures', 'built', 'poi'].flatMap((kind) => (Array.isArray(sighted?.[kind]) ? sighted[kind] : []).filter((row) => row?.new === true).map((row) => [kind, row]));
	if (fresh.length === 0 || !fresh.every(([kind, row]) => ownSighting(kind === 'structures' ? 'structure' : kind, row, placed))) return payload;
	const remaining = changedFacts.filter((fact) => fact !== 'sighted');
	const named = typeof payload.trigger === 'string' && payload.trigger.trim().length > 0;
	return { ...payload, changedFacts: remaining, ...(remaining.length === 0 && !named ? { attention: false } : {}) };
}

export const LAVA_HEARD_TRIGGER = 'lava_heard';
const LAVA_HEARD_NEAR = 16;
/** Lava among the remembered sounds within LAVA_HEARD_NEAR blocks. */
export function heardLavaNear(observation) {
	return (Array.isArray(observation?.heard) ? observation.heard : []).some((row) => typeof row?.sound === 'string' && row.sound.includes('lava')
		&& Number.isFinite(row.distance) && row.distance <= LAVA_HEARD_NEAR);
}

export function classifyObservationTrigger(payload, observation, signals = null) {
	const explicitTrigger = typeof payload.trigger === 'string' && payload.trigger.trim().length > 0 ? payload.trigger.trim().slice(0, 128) : null;
	// A known edge ahead is about a second away at walking speed, faster than any model round: it is never a wake reason
	// itself (authored standing orders and program watchers react to the stored sample). The server never sets attention
	// for it alone and marks a publication made only for it sampleOnly; a forced reason (an action result) keeps attention.
	const changedFacts = Array.isArray(payload.changedFacts) ? payload.changedFacts.filter((fact) => fact !== 'player.dropAhead') : [];
	const sampleOnly = payload.sampleOnly === true;
	const attention = payload.attention === true && !sampleOnly;
	if (explicitTrigger !== null && explicitTrigger !== 'projectile'
		&& (payload.priority === 'urgent' || NO_TASK_WAKE_TRIGGERS.has(explicitTrigger))) {
		return { attention: true, priority: 'urgent', trigger: explicitTrigger };
	}
	// Healing signals are classified on their own below; their names must not read as damage/air/fall facts.
	const joinedFacts = changedFacts.filter((value) => typeof value === 'string' && !value.startsWith('survival.')).join('|').toLowerCase();
	const player = observation?.player ?? {};
	if (changedFacts.includes('player.clouds')) return { attention: true, priority: 'urgent', trigger: 'cloud' };
	const flights = observation?.incomingProjectiles ?? player.incomingProjectiles ?? [];
	const before = signals?.previousPlayer;
	const healthDecreased = Number.isFinite(player.health) && Number.isFinite(before?.health) && player.health < before.health;
	// The server's health delta already means damage. When both samples are
	// available, also exclude healing from legacy/general-purpose deltas.
	const healthDelta = joinedFacts.includes('health') && (!Number.isFinite(before?.health) || !Number.isFinite(player.health) || healthDecreased);
	if (healthDecreased || healthDelta || joinedFacts.includes('attacker') || joinedFacts.includes('damage')) return { attention: true, priority: 'urgent', trigger: 'damage' };
	// Server-sensed threat edges (a mob starts targeting, a creeper swells or closes in, a ranged mob gets a
	// clear shot) wake the model before the first hit; the server latch debounces each mob and signal.
	if (changedFacts.some((fact) => typeof fact === 'string' && fact.startsWith('threats.'))) return { attention: true, priority: 'urgent', trigger: 'threat' };
	if (player.inLava === true || joinedFacts.includes('player.inlava')) return { attention: true, priority: 'urgent', trigger: 'lava' };
	// A seen flow due at the body soon wakes the model before contact. Native agents are debounced per agent
	// (lavaFlowWakeDue); without that state only a flow the previous sample lacked is news.
	if (imminentLavaFlow(player) !== null && (signals?.lavaFlowDue ?? imminentLavaFlow(before) === null)) return { attention: true, priority: 'urgent', trigger: LAVA_FLOW_TRIGGER };
	if (joinedFacts.includes('fire') || player.onFire === true || player.fire === true) return { attention: true, priority: 'urgent', trigger: 'fire' };
	if (joinedFacts.includes('air') && player.underWater === true) return { attention: true, priority: 'urgent', trigger: 'drowning' };
	if (joinedFacts.includes('suffoc') || joinedFacts.includes('air')) return { attention: true, priority: 'urgent', trigger: 'suffocation' };
	if (joinedFacts.includes('fall')) return { attention: true, priority: 'urgent', trigger: 'fall' };
	// The server lists only visible collision-course flights within two seconds, with shields/resistance accounted for.
	if (flights.some(row => row.damaging !== false && (row.new || row.imminentNew))) return { attention: true, priority: 'urgent', trigger: 'projectile' };
	// Debounced healing facts from Minecraft. Low health with no food while threatened is urgent so the model can
	// weigh a retreat; a safe chance to eat is ordinary attention. The model decides whether to eat or flee.
	if (changedFacts.includes('survival.low_health_no_food')) return { attention: true, priority: 'urgent', trigger: 'low_health' };
	// The dragon landing on the fountain is the melee window: about 5 s with nobody within 20 blocks, so it is not held.
	if (signals?.dragonPerch != null) return { attention: true, priority: 'urgent', trigger: DRAGON_PERCHED_TRIGGER };
	// An ordinary named observation cannot hide simultaneous survival facts.
	// A held tool breaking is seen and heard at once; the empty hand changes what every following action does. Its facts
	// ride on the observation (toolBroke), so a danger wake in the same sample carries them too.
	const toolBroke = signals?.toolBreak != null;
	if (explicitTrigger !== null && explicitTrigger !== 'projectile') {
		return { attention: true, priority: 'ordinary', trigger: signals?.dimensionChanged === true ? DIMENSION_CHANGED_TRIGGER : toolBroke ? TOOL_BROKE_TRIGGER : explicitTrigger };
	}
	// A real dimension edge (a portal; a respawn starts a new lifecycle instead) changes every fact the plan assumed.
	// It outranks every ordinary reason here, since the remembered dimension has already moved on and a routine
	// filter would otherwise swallow the crossing; urgent danger (a movement loop included) still wins.
	if (signals?.dimensionChanged === true) return signals.movementLoop === true ? { attention: true, priority: 'urgent', trigger: 'movement_loop' } : { attention: true, priority: 'ordinary', trigger: DIMENSION_CHANGED_TRIGGER };
	// The loop detector fires once, on the sample that closes the loop, so a flight in the same sample must not use it up.
	if (signals?.movementLoop === true) return { attention: true, priority: 'urgent', trigger: 'movement_loop' };
	if (toolBroke) return { attention: true, priority: 'ordinary', trigger: TOOL_BROKE_TRIGGER };
	if (explicitTrigger === 'projectile' || changedFacts.includes('projectile')) return { attention: true, priority: 'ordinary', trigger: 'projectile' };
	if (changedFacts.includes('survival.heal_opportunity')) return { attention: true, priority: 'ordinary', trigger: 'heal_opportunity' };
	// A structure came into view (new, or again after a minute): worth a look; the model decides whether to go.
	// Lava first heard within earshot of a pool (a player hears its pops and turns toward them): the model decides whether to look.
	if (changedFacts.includes('heard') && heardLavaNear(observation)) return { attention: true, priority: 'ordinary', trigger: LAVA_HEARD_TRIGGER };
	if (changedFacts.includes('sighted')) return { attention: true, priority: 'ordinary', trigger: 'structure_sighted' };
	if (changedFacts.includes('furnaces')) return { attention: true, priority: 'ordinary', trigger: 'furnace_ready' };
	if (signals?.resourceDiscovery === true) return { attention: true, priority: 'ordinary', trigger: 'resource_discovery', ...(signals.resourceSightings?.length ? { resourceSightings: signals.resourceSightings } : {}) };
	// sampleOnly: the sample was published only for the drop ahead; it is stored for orders and watchers, never a turn.
	if (!attention) return { attention: false, priority: 'ordinary', trigger: 'observation', ...(sampleOnly ? { sampleOnly: true } : {}) };
	return { attention: true, priority: 'ordinary', trigger: 'attention' };
}

/**
 * Records a block position (repeats collapse) and reports whether it newly completed a movement loop. While a hit's
 * knockback carries the body, and where it lands, the position is not a step the model walked, so it is not recorded.
 */
function sampleMovement(state, positionKey, sampledAt, evidence) {
	const steps = state.positions;
	const shoved = state.knockbackNow === true
		|| (sampledAt !== null && state.knockbackUntil != null && sampledAt >= state.knockbackFrom && sampledAt <= state.knockbackUntil);
	if (positionKey !== null && !shoved && positionKey !== steps.at(-1)?.key) {
		// The first cell seen after the knockback settled is where it left the body, unless the body is walking there.
		if (state.knockbackLanding !== true || evidence === 'walking') {
			steps.push({ key: positionKey, at: sampledAt, evidence });
			if (steps.length > MAX_NATIVE_MOVEMENT_HISTORY) steps.shift();
		}
		state.knockbackLanding = false;
	} else if (positionKey !== null && !shoved) state.knockbackLanding = false;
	const looping = detectMovementLoop(steps.map((step) => step.key));
	// Repeated samples of the same unresolved loop are not new decisions.
	// Moving out of it rearms attention without an arbitrary cooldown.
	const movementLoop = looping && state.movementLoopActive !== true;
	state.movementLoopActive = looping;
	if (movementLoop) state.movementLoopVersion = (state.movementLoopVersion ?? 0) + 1;
	// The loop stays due until delivery succeeds; walking out of it retires an unreported loop.
	state.movementLoopDue = looping && (state.movementLoopDue === true || movementLoop);
	return movementLoop;
}

/**
 * A hit explains progress positions recorded since the previous observation: steps without walking evidence within
 * its lead, or whose body was carried (airborne or faster than it moves itself) or gave no evidence, are
 * withdrawn; the rest stay the steps the model walked. Steps left adjacent at one cell collapse as when sampled.
 */
function withdrawShovedSteps(steps, previousObservedAt, hitAt) {
	if (hitAt === null) return;
	const since = previousObservedAt ?? -Infinity;
	for (let index = steps.length - 1; index >= 1; index -= 1) {
		const step = steps[index];
		if (step.at === null || step.at <= since) break;
		if (step.evidence !== 'walking' && (step.at >= hitAt - KNOCKBACK_LEAD_MS || step.evidence === 'carried' || step.evidence === null)) steps.splice(index, 1);
	}
	for (let index = steps.length - 1; index >= 1; index -= 1) if (steps[index].key === steps[index - 1].key) steps.splice(index, 1);
}

/**
 * What the body's own motion says: 'walking' (on the ground at a speed of its own), 'still', 'carried' (airborne or
 * faster than it moves itself), or null without a velocity. A body standing in a new cell after a hit was carried there.
 */
function movementEvidence(velocity, onGround) {
	if (!Number.isFinite(velocity?.x) || !Number.isFinite(velocity?.z)) return null;
	const speed = Math.hypot(velocity.x, velocity.z);
	if (onGround === false || speed > SELF_PROPELLED_MAX_SPEED) return 'carried';
	return speed < SELF_PROPELLED_MIN_SPEED ? 'still' : 'walking';
}

/**
 * Detects a walk that repeats its own recent route: the last steps retrace the same sequence of blocks just before
 * them, for a route of any length (back and forth, a triangle, a square, a ring) that fits twice in the history.
 * Ordinary forward travel never repeats a sequence.
 */
export function detectMovementLoop(positionKeys) {
	if (!Array.isArray(positionKeys)) return false;
	for (let period = 2; period * 2 <= positionKeys.length; period += 1) {
		let repeats = true;
		for (let index = positionKeys.length - period; index < positionKeys.length && repeats; index += 1) {
			repeats = positionKeys[index] === positionKeys[index - period];
		}
		if (repeats) return true;
	}
	return false;
}

/** True when health fell from a hit that pushes the body (an attacker or projectile, not fire, lava or a fall). */
function knockbackHurt(player, before) {
	if (!Number.isFinite(player?.health) || !Number.isFinite(before?.health) || player.health >= before.health) return false;
	return typeof player.hurtBy !== 'string' || !NON_KNOCKBACK_DAMAGE.has(player.hurtBy.split(' ')[0]);
}

// The block the feet are in, as on F3. Rounding would put the cell edge at the block centre, where paths walk.
function nativeBlockPositionKey(player) {
	if (![player?.x, player?.y, player?.z].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
	return `${Math.floor(player.x)},${Math.floor(player.y)},${Math.floor(player.z)}`;
}

/** Dispatch records establish action identity; pending breaks never explain a discovery. */
export function startOwnBreak(state, actionId, position) {
	state.brokenBlocks = (state.brokenBlocks ?? []).filter((broken) => broken.at !== null);
	state.brokenBlocks.push({ actionId, ...position, at: null, revealed: new Set() });
	if (state.brokenBlocks.length > MAX_NATIVE_BROKEN_BLOCKS) state.brokenBlocks.shift();
}

/** Only server-confirmed visible faces of this exact successful removal can explain a new block. */
export function settleOwnBreak(state, actionId, succeeded, endedAtEpochMs, evidence) {
	const broken = state.brokenBlocks?.find((entry) => entry.actionId === actionId && entry.at === null);
	if (broken === undefined) return;
	const target = evidence?.target;
	if (!succeeded || !Number.isSafeInteger(endedAtEpochMs) || target?.kind !== 'block'
		|| !['x', 'y', 'z'].every(axis => target.position?.[axis] === broken[axis])
		|| target.worldChanged !== true || evidence?.progress?.basis !== 'world_mutation' || evidence.progress.verified !== true || evidence.progress.value !== 1) {
		state.brokenBlocks = state.brokenBlocks.filter(entry => entry !== broken);
		return;
	}
	broken.at = endedAtEpochMs;
	for (const block of evidence.revealedBlocks ?? []) {
		const position = blockPosition(block.position);
		if (position === null || typeof block.blockId !== 'string') continue;
		const delta = { x: position.x - broken.x, y: position.y - broken.y, z: position.z - broken.z };
		const face = delta.x === 1 ? 'west' : delta.x === -1 ? 'east' : delta.y === 1 ? 'down' : delta.y === -1 ? 'up' : delta.z === 1 ? 'north' : 'south';
		if (Math.abs(delta.x) + Math.abs(delta.y) + Math.abs(delta.z) === 1 && block.face === face) {
			broken.revealed.add(`${position.x},${position.y},${position.z}:${block.blockId}`);
		}
	}
}

/** A proof belongs to the first post-result publication, never a later nearby arrival or an item. */
export function rememberResources(state, observation, record = {}) {
	const observedAt = Number.isSafeInteger(observation?.observedAtEpochMs) ? observation.observedAtEpochMs : null;
	const confirmed = (state.brokenBlocks ?? []).filter(broken => broken.at !== null && observedAt !== null && observedAt >= broken.at);
	state.resourceSightings = [];
	for (const candidate of observedResourceCandidates(observation, record)) {
		if (state.resources.has(candidate.key)) continue;
		const suppressed = !candidate.item && confirmed.some(broken => broken.revealed.has(candidate.key));
		state.resources.add(candidate.key);
		if (!suppressed) state.resourceSightings.push({
			...(observedAt === null ? {} : { observedAtEpochMs: observedAt }),
			...(observation?.world?.dimension === undefined ? {} : { dimension: observation.world.dimension }),
			[candidate.item ? 'item' : 'block']: candidate.fact,
		});
	}
	state.brokenBlocks = (state.brokenBlocks ?? []).filter(broken => !confirmed.includes(broken));
	while (state.resources.size > MAX_NATIVE_RESOURCE_MEMORY) state.resources.delete(state.resources.values().next().value);
	const discovery = state.resourceSightings.length > 0;
	state.resourceSightings = boundedResourceSightings(record, state.resourceSightings);
	return discovery;
}

function blockPosition(value) {
	return ['x', 'y', 'z'].every((axis) => Number.isSafeInteger(value?.[axis])) ? { x: value.x, y: value.y, z: value.z } : null;
}

function observedResourceCandidates(observation, record) {
	const candidates = [];
	for (const block of [...(observation?.blocks ?? []), ...(observation?.landmarks ?? [])]) {
		if (!isDiscoveryBlock(block, record)) continue;
		candidates.push({ key: `${block.x},${block.y},${block.z}:${block.blockId}`, item: false, fact: resourceBlockFact(block) });
	}
	for (const item of observation?.items ?? []) {
		if (typeof item?.stableId !== 'string' || typeof item?.itemId !== 'string') continue;
		candidates.push({ key: `item:${item.stableId}:${item.itemId}`, item: true, fact: { stableId: item.stableId, itemId: item.itemId, x: item.x, y: item.y, z: item.z } });
	}
	return candidates;
}

const DANGER_WAKE_TRIGGERS = new Set(['damage', 'threat', 'fire', 'lava', LAVA_FLOW_TRIGGER, 'drowning', 'suffocation', 'fall', 'projectile']);

// Only facts actually included in an input or tool result establish awareness. Seeing an entity before its
// threat edge still counts; a different entity of the same type must retain its own warning.
export function survivalFactKeys(facts, keys = new Set()) {
	if (facts === null || typeof facts !== 'object') return keys;
	const player = facts.player ?? facts.hud ?? facts;
	const threatRows = (value) => Array.isArray(value) ? value : value?.entries ?? [];
	// Model wakes list threats beside player (observation.threats) with the nearest as player.threat.
	const rows = [...threatRows(player.threats), ...(player !== facts ? threatRows(facts.threats) : []), ...(player.threat ? [player.threat] : []),
		...(Array.isArray(facts.entities) ? facts.entities : []), ...(player.incomingProjectiles ?? []),
		...(player.lastAttacker ? [player.lastAttacker] : [])];
	for (const row of rows) {
		const id = row?.stableId ?? row?.entityId ?? row?.id ?? row?.uuid;
		if (id !== undefined) keys.add(`entity:${id}`);
		else if (typeof row?.type === 'string') keys.add(`type:${row.type}`);
	}
	if (Number.isFinite(player.air) && player.air < 300) keys.add('air');
	if (typeof player.air === 'string') {
		const bubbles = player.air.match(/(\d+(?:\.\d+)?)\/10 bubbles/u);
		if (player.air.includes('underwater') || bubbles !== null && Number(bubbles[1]) < 10) keys.add('air');
	}
	if (Number.isFinite(player.fallDistance) && player.fallDistance > 0) keys.add('fall');
	for (const child of ['observation', 'postAction', 'world']) survivalFactKeys(facts[child], keys);
	return keys;
}

function isSurvivalReissueTool(tool) {
	// Waiting is permitted for a no-task survival turn, but is still obsolete routine work during a reissue.
	if (tool?.kind === 'sequence') return tool.actions.every(isSurvivalReissueTool);
	return tool?.actionType !== 'wait' && isSelfPreservationTool(tool);
}

function dangerWakeTrigger(request) {
	const event = request?.nativeEvent;
	return event?.event === 'program_attention'
		? event.status?.decision?.trigger ?? event.trigger ?? request?.trigger
		: event?.trigger ?? request?.trigger;
}

function dangerWakeRank(request) {
	const trigger = dangerWakeTrigger(request);
	return DANGER_WAKE_TRIGGERS.has(trigger) ? (trigger === 'projectile' ? 1 : 2) : 0;
}

function attentionWinner(previous, next, priority) {
	const difference = dangerWakeRank(previous) - dangerWakeRank(next);
	if (difference !== 0) return difference > 0 ? previous : next;
	return next?.priority === priority ? next : previous;
}

function mergeAttentionTrigger(previous, next) {
	const priority = previous?.priority === 'urgent' || next?.priority === 'urgent' ? 'urgent' : 'ordinary';
	const winner = attentionWinner(previous, next, priority);
	return {
		attention: previous?.attention === true || next?.attention !== false,
		priority,
		trigger: winner?.trigger ?? 'attention',
	};
}

export function mergePlannerRequest(previous, next) {
	if (previous != null && previous.goalRevision !== next.goalRevision) return next;
	let merged = carryNativeWakeEvents(previous, next, mergePlannerRequestFacts(previous, next));
	if (previous == null || previous.goalRevision !== next.goalRevision || merged.nativeEvent === undefined) return merged;
	if (previous.nativeEvent !== undefined && attentionWinner(previous, next, merged.priority) === previous
			&& (previous.priority === 'urgent' && next.priority !== 'urgent' || dangerWakeRank(previous) > dangerWakeRank(next))) {
		merged = { ...merged, nativeEvent: { ...previous.nativeEvent,
			observation: merged.nativeEvent.observation ?? previous.nativeEvent.observation,
			eventSequence: merged.nativeEvent.eventSequence ?? previous.nativeEvent.eventSequence,
			mergedEvents: merged.nativeEvent.mergedEvents, trigger: previous.nativeEvent.trigger ?? previous.trigger } };
	}
	if (previous.dangerWake === true) merged.dangerWake = true;
	const sightings = mergeResourceSightings(...[previous.nativeEvent, next.nativeEvent].flatMap(event =>
		[event?.resourceSightings, event?.status?.decision?.resourceSightings, event?.result?.resourceSightings]));
	return sightings.length === 0 ? merged : { ...merged, nativeEvent: { ...merged.nativeEvent, resourceSightings: sightings } };
}

function mergePlannerRequestFacts(previous, next) {
	if (previous === null || previous === undefined) return next;
	const fallDistance = previous.nativeEvent?.observation?.player?.fallDistance;
	if (previous.trigger === 'fall' && Number.isFinite(fallDistance) && fallDistance > 0
			&& fallDistance > (next.nativeEvent?.observation?.player?.fallDistance ?? 0))
		previous = { ...previous, dangerSummary: { ...previous.dangerSummary, fallDistance } };
	const priority = previous.priority === 'urgent' || next.priority === 'urgent' ? 'urgent' : 'ordinary';
	// A queued dimension change stays named over a later routine wake, which would otherwise be held for an action.
	const keepsDimension = previous.priority === next.priority && previous.trigger === DIMENSION_CHANGED_TRIGGER;
	const winner = keepsDimension && dangerWakeRank(next) === 0 ? previous : attentionWinner(previous, next, priority);
	let dangerSummary = mergeDangerSummary(previous.dangerSummary, next.dangerSummary);
	const footing = retainedDangerFooting(previous, next);
	if (footing !== undefined) dangerSummary = { ...dangerSummary, earlierFooting: footing };
	else if (dangerSummary?.earlierFooting !== undefined) {
		const { earlierFooting: superseded, ...rest } = dangerSummary;
		dangerSummary = Object.keys(rest).length === 0 ? undefined : rest;
	}
	const mergedDanger = dangerSummary === undefined ? {} : { dangerSummary };
	// A program that ended (or asked for a decision) while the model was still in a turn must not be replaced by the
	// plain observation that followed: the model would wake without the program's result and have to ask for it.
	const programEvent = previous.nativeEvent?.event;
	if (['program_ended', 'program_attention', 'program_handoff_rejected'].includes(programEvent) && next.nativeEvent?.event === 'observation'
			&& next.nativeEvent.conversationOnly !== true && previous.goalRevision === next.goalRevision) {
		const { programId, status, result } = previous.nativeEvent;
		const program = { ...(programId === undefined ? {} : { programId }), ...(status === undefined ? {} : { status }), ...(result === undefined ? {} : { result }) };
		// Danger leads the wake (its own event and trigger) but still carries the program's result or decision handle.
		if (next.priority === 'urgent') return { ...next, ...mergedDanger, priority, trigger: winner.trigger, nativeEvent: { ...next.nativeEvent, ...program } };
		return { ...next, ...mergedDanger, priority, trigger: winner.trigger, nativeEvent: { ...previous.nativeEvent, observation: next.nativeEvent.observation ?? previous.nativeEvent.observation,
			...(next.eventSequence === undefined ? {} : { eventSequence: next.eventSequence }) } };
	}
	// The newest facts ride under the kept trigger, so queued danger keeps its danger instruction; a crossing in those
	// facts stays a pending assessment for the next wake (see #pendingAssessment).
	const keptTrigger = previous.nativeEvent?.trigger ?? winner.trigger;
	const nativeEvent = winner === previous && next.nativeEvent?.event === 'observation' ? { nativeEvent: { ...next.nativeEvent, trigger: keptTrigger } } : {};
	return { ...next, ...mergedDanger, priority, trigger: winner.trigger, ...nativeEvent };
}

function mergeDangerSummary(previous, next) {
	if (previous == null) return next;
	if (next == null) return previous;
	return {
		foldedEvents: (previous.foldedEvents ?? 0) + (next.foldedEvents ?? 0),
		hitsSinceLastUpdate: (previous.hitsSinceLastUpdate ?? 0) + (next.hitsSinceLastUpdate ?? 0),
		healthAtLastUpdate: previous.healthAtLastUpdate ?? next.healthAtLastUpdate,
		healthNow: next.healthNow ?? previous.healthNow,
		attackers: [...new Set([...(previous.attackers ?? []), ...(next.attackers ?? [])])].slice(0, 4),
		...(previous.fallDistance || next.fallDistance ? { fallDistance: Math.max(previous.fallDistance ?? 0, next.fallDistance ?? 0) } : {}),
	};
}

/** Visible HUD facts in independent sections: a changing air bar must not resend a stable sky or screen. */
export function hudFacts(player, world, menu) {
	if (player == null || typeof player !== 'object' || player.dead === true) return null;
	const hud = {};
	// Copy observations, including approaching:false and signal names; absence never becomes a guessed threat or ETA.
	if (Array.isArray(player.threats) && player.threats.length > 0) hud.threats = player.threats;
	for (const key of ['harm', 'lastAttacker', 'recentDamage', 'clouds', 'groundAhead', 'brink']) if (player[key] != null) hud[key] = player[key];
	for (const key of ['suffocating', 'inLava', 'onFire']) if (typeof player[key] === 'boolean') hud[key] = player[key];
	if (player.hazard != null) hud.hazard = player.hazard;
	if (player.underWater === true) for (const key of ['airSecondsLeft', 'waterMotion', 'waterAbove', 'breathable']) {
		if (player[key] !== undefined) hud[key] = player[key];
	}
	if (Number.isFinite(player.health)) {
		hud.health = Number.isFinite(player.maxHealth) ? `${player.health}/${player.maxHealth}` : player.health;
	}
	if (typeof player.underWater === 'boolean' || Number.isFinite(player.airBubbles)) {
		const water = player.underWater === true ? 'underwater' : player.underWater === false ? 'above water' : '';
		hud.air = [water, ...(Number.isFinite(player.airBubbles) ? [`${player.airBubbles}/10 bubbles`] : [])].filter(Boolean).join(' ');
	}
	if (Number.isFinite(player.foodLevel)) hud.foodLevel = player.foodLevel;
	if (typeof player.hungerShaking === 'boolean') hud.hungerShaking = player.hungerShaking;
	// world.dayPhase is present only where the sky (or a clock) shows it. darkIn stays in world.
	if (world?.dayPhase !== undefined) hud.sky = world.dayPhase;
	if (typeof menu?.type === 'string' && 'containerId' in menu) hud.menuId = menu.type === 'minecraft:inventory' ? null : menu.type;
	return Object.keys(hud).length === 0 ? null : hud;
}

/** In lava or touching a fire block (Minecraft's hazard fact; a hot floor such as magma is not this), not fire resistant. */
const SURVIVAL_EPISODE_QUIET_MS = 5_000;
const SURVIVAL_RESTART_MIN_CALL_AGE_MS = 1_500;

/** Danger an observation shows on the body itself; nearby threats alone do not count (they persist all night). */
function survivalDangerShown(player) {
	return (Number.isFinite(player.air) && player.air < 300) || player.underWater === true || player.suffocating === true
		|| (Number.isFinite(player.fallDistance) && player.fallDistance > 0) || player.onFire === true || inHazardContact(player)
		|| player.lastAttacker != null || player.recentDamage != null || (player.incomingProjectiles?.length ?? 0) > 0;
}

export function inHazardContact(player) {
	if (!(player?.inLava === true || player?.hazard === 'lava' || player?.hazard === 'fire')) return false;
	return !(Array.isArray(player.effects) && player.effects.some((effect) => effect?.effectId === 'minecraft:fire_resistance'));
}

/**
 * A danger steer while the body is in lava or stands in fire (not fire that merely follows it out). Lava contact also
 * costs health, so its event often arrives as damage, which outranks lava when triggers are classified.
 */
export function isHazardContactRequest(request) {
	const event = request?.nativeEvent;
	const trigger = event?.trigger ?? request?.trigger;
	if (request?.priority !== 'urgent' && !NO_TASK_WAKE_TRIGGERS.has(trigger) && trigger !== 'movement_loop') return false;
	const player = (event?.observation ?? request?.observation)?.player;
	// A seen flow due within seconds is contact to come: a call planning without it would answer after the lava arrived.
	return inHazardContact(player) || imminentLavaFlow(player) !== null;
}

// A seen flow due at a body cell within this many seconds wakes the model before contact. Lava kills in about 2.5 s once
// in it and Nether lava spreads a cell every 0.5 s; leave_lava's own pre-contact horizon is the same 4 s.
const LAVA_FLOW_WAKE_S = 4;
const flowCell = (text) => {
	const cell = typeof text === 'string' ? text.split(',').map(Number) : [];
	return cell.length === 3 && cell.every(Number.isSafeInteger) ? cell : null;
};

// A body stepping in and out of a flow's path (an action oscillating beside a Nether lava fall, d24 q-kmb0h6) shows the
// flow every other sample; one wake per this window is enough, the facts ride every later wake.
const LAVA_FLOW_REPEAT_MS = 10_000;

/** Whether this sample's imminent flow wakes the model: at most once per LAVA_FLOW_REPEAT_MS per agent (state is per agent). */
export function lavaFlowWakeDue(state, player, at) {
	if (imminentLavaFlow(player) === null) return false;
	if (Number.isFinite(state.lavaFlowWokeAt) && at - state.lavaFlowWokeAt < LAVA_FLOW_REPEAT_MS && at >= state.lavaFlowWokeAt) return false;
	state.lavaFlowWokeAt = at;
	return true;
}

/** player.lavaFlow as {from, at, inS} cells when it reaches a body cell within LAVA_FLOW_WAKE_S and the body is not in lava yet. */
export function imminentLavaFlow(player) {
	const flow = player?.lavaFlow;
	if (flow == null || player.inLava === true || !Number.isFinite(flow.inS) || flow.inS > LAVA_FLOW_WAKE_S) return null;
	if (Array.isArray(player.effects) && player.effects.some((effect) => effect?.effectId === 'minecraft:fire_resistance')) return null;
	const from = flowCell(flow.from), cell = flowCell(flow.at);
	return from === null || cell === null ? null : { from, at: cell, inS: flow.inS };
}

/**
 * The wake line for an advancing seen flow: where it comes from, the body cell, when, and the player's options. The
 * inflow cell is the one beside the reached cell toward the lava (above it for a straight fall); the step-out cell is
 * the one on the far side at the feet, named only when no seen lava fills it or lies under it. Facts only; nothing moves.
 */
export function lavaFlowLine(observation) {
	const flow = imminentLavaFlow(observation?.player);
	if (flow === null) return null;
	const [fx, , fz] = flow.from, [ax, ay, az] = flow.at;
	const alongX = Math.abs(fx - ax) >= Math.abs(fz - az);
	const dx = alongX ? Math.sign(fx - ax) : 0, dz = alongX ? 0 : Math.sign(fz - az);
	const falls = dx === 0 && dz === 0;
	const inflow = falls ? [ax, ay + 1, az] : [ax + dx, ay, az + dz];
	const feetY = Number.isFinite(observation?.position?.y) ? Math.floor(observation.position.y + 1e-6) : ay;
	const lava = new Set((Array.isArray(observation?.blocks) ? observation.blocks : [])
		.filter((row) => row?.blockId === 'minecraft:lava').map((row) => `${row.x},${row.y},${row.z}`));
	const away = falls ? null : [ax - dx, feetY, az - dz];
	const safe = away !== null && !lava.has(away.join()) && !lava.has([away[0], away[1] + 1, away[2]].join()) && !lava.has([away[0], away[1] - 1, away[2]].join()) ? away : null;
	const step = safe !== null ? `step out of its path to ${safe.join()}` : falls ? 'step out from under it' : 'step out of its path';
	return `Live Minecraft event: seen lava from ${flow.from.join()} reaches your cell ${flow.at.join()} in ~${flow.inS}s; lava kills ~2.5 s after contact. `
		+ `Before then: ${step}, dam its inflow ${inflow.join()} with a block, or arm lava_flowing -> leave_lava/place_block, faster than a reply.`;
}

export function nativeSteerInterruption(request) {
	const event = request?.nativeEvent;
	// Undelivered danger keeps its original facts even if the newest observation no longer shows it.
	if (event?.mergedEvents?.some(nativeEvent => nativeSteerInterruption({ nativeEvent }) === 'danger')) return 'danger';
	const trigger = event?.event === 'program_attention'
		? event.status?.decision?.trigger ?? event.trigger ?? request?.trigger
		: event?.trigger ?? request?.trigger;
	if (trigger === 'damage' || request?.dangerSummary?.hitsSinceLastUpdate > 0) return 'danger';
	if (['lava', LAVA_FLOW_TRIGGER, 'fire', 'drowning', 'suffocation', 'fall', 'cloud'].includes(trigger)) return 'danger';
	const observation = event?.observation ?? request?.observation ?? {};
	const flights = observation?.player?.incomingProjectiles ?? observation?.incomingProjectiles ?? [];
	if (trigger === 'projectile' && flights.some(row => row.damaging !== false)) return 'danger';
	const threats = Array.isArray(observation?.player?.threats) ? observation.player.threats
		: Array.isArray(observation?.threats?.entries) ? observation.threats.entries : [];
	return threats.some((threat) => {
		const type = typeof threat?.type === 'string' ? threat.type.toLowerCase() : '';
		const creeper = type.includes('creeper');
		const signals = Array.isArray(threat?.signals) ? threat.signals : [];
		// A drawn bow interrupts only as its own threat edge; it stays visible while held and must not cut every steer.
		return signals.includes('imminent') || trigger === 'threat' && signals.includes('ranged_aiming')
			|| creeper && (threat.swelling === true || signals.includes('swelling') || signals.includes('creeper_close'));
	}) ? 'danger' : null;
}

function finiteCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function stringList(value) { return Array.isArray(value) ? value.slice(0, 8).filter((entry) => typeof entry === 'string').map((entry) => entry.slice(0, 64)) : null; }

function nativeUsageTraceFields(value, state, record) {
	if (!['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'].some(key => finiteCount(value?.[key]) !== null)) return {};
	// Reuse the legacy flat usage schema without mutating the current goal's public view.
	updateUsage(state, record, value, Date.now());
	return state.usage ?? {};
}

export function modelCallTraceFields(value) {
	const call = value.call, last = value.last ?? {};
	const fields = { provider: typeof call.provider === 'string' ? call.provider : null, turnId: typeof call.turnId === 'string' ? call.turnId : null,
		modelCallId: typeof call.modelCallId === 'string' ? call.modelCallId : null,
		timingBasis: ['input-to-first-tool-request', 'usage-notification-only'].includes(call.timingBasis) ? call.timingBasis : null,
		handoffBudget: call.handoffBudget == null ? null : Object.fromEntries(['creditUsd', 'totalReadUsd', 'totalElectiveWriteUsd', 'lastWriteUsd', 'lastPayloadBytes', 'lastOverrunUsd', 'lastElectiveWriteUsd', 'reservedWriteUsd', 'unsettledDebtUsd'].filter(key => Number.isFinite(call.handoffBudget[key])).map(key => [key, call.handoffBudget[key]])),
		partialMessagesAccepted: typeof call.partialMessagesAccepted === 'boolean' ? call.partialMessagesAccepted : null,
		interrupted: typeof call.interrupted === 'boolean' ? call.interrupted : null, outputReconciled: typeof call.outputReconciled === 'boolean' ? call.outputReconciled : null,
		contextTokens: finiteCount(call.contextTokens), inputTokens: finiteCount(last.inputTokens), cachedInputTokens: finiteCount(last.cachedInputTokens),
		cacheWriteInputTokens: finiteCount(last.cacheWriteInputTokens), outputTokens: finiteCount(last.outputTokens), rotations: finiteCount(call.rotations),
		firstEventMs: finiteCount(call.firstEventMs), streamMs: finiteCount(call.streamMs), totalMs: finiteCount(call.totalMs),
		requestAt: finiteCount(call.requestAt), endedAt: finiteCount(call.endedAt), firstEventAt: finiteCount(call.firstEventAt), startMs: finiteCount(call.startMs), streamEvents: finiteCount(call.streamEvents),
		firstEventSource: ['stream', 'assistant'].includes(call.firstEventSource) ? call.firstEventSource : null,
		toolNames: stringList(call.toolNames), toolStartMs: Array.isArray(call.toolStartMs) ? call.toolStartMs.slice(0, 8).map(finiteCount).filter((entry) => entry !== null) : null };
	return Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== null && !(Array.isArray(field) && field.length === 0)));
}

export function turnUsageTraceFields(usage) {
	if (usage === null || typeof usage !== 'object') return {};
	const fields = { modelCalls: finiteCount(usage.calls), inputTokens: finiteCount(usage.input), cachedInputTokens: finiteCount(usage.cacheRead),
		cacheWriteInputTokens: finiteCount(usage.cacheWrite), outputTokens: finiteCount(usage.output), contextTokens: finiteCount(usage.contextTokens),
		costUsd: Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : null,
		// Included in the counts above: calls of an interrupted turn (a hazard reissue, for one) that reported nothing.
		interruptedModelCalls: finiteCount(usage.interrupted?.calls),
		interruptedTokens: usage.interrupted ? finiteCount(['input', 'cacheRead', 'cacheWrite', 'output'].reduce((sum, key) => sum + (usage.interrupted[key] ?? 0), 0)) : null };
	return Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== null));
}

function sameSupervisionKey(left, right) {
	return left?.agentId === right?.agentId
		&& left?.goalRevision === right?.goalRevision
		&& left?.lifecycleGeneration === right?.lifecycleGeneration
		&& left?.sessionEpoch === right?.sessionEpoch
		&& left?.profileFingerprint === right?.profileFingerprint;
}

const PLANNING_EVENT_INSTRUCTION = 'Planning due soon; prepare the next intention while the current routine runs. Advisory: no pending decisionId needed. Use current programVersion and timing; do not blindly renew or cancel the program.';

export function buildNativeEventInput(record, { event, trigger, programId, status, result, mergedEvents, resourceSightings: queuedResourceSightings, planningLeadMs, eventSequence, taskMemory = null, progress = null, goalNow = null, skillFits = null, continuity = null, dangerSummary = null, movementLoop = false, observation = {}, conversation = { mode: 'unread', baseSequence: -1, nextSequence: -1, entries: [] }, conversationOnly = false, awaitingConfirmation = false, confirmationFacts = null, dangerWake = false, selfCareWake = false, healing = null, newContext = false, changed = null, strategy = null, contexts = null, uncovered = null, runningActionStart = null, runningAction = null, actionReceipt = observation.lastResult } = {}) {
	const eventName = typeof event === 'string' && event.length > 0 ? event : event?.event;
	const normalizedEvent = typeof eventName === 'string' && eventName.length > 0 ? eventName : 'observation';
	// Read before presentation copies the observation: the drop clock rides on recovery as a non-enumerable field.
	const respawnRecovery = trigger === 'respawn' && conversationOnly !== true ? respawnLead(observation.recovery ?? null, observation) : null;
	observation = presentEventObservation(compactProjectileObservation(observation), { inventoryLimit: normalizedEvent === 'program_planning_due' ? 8 : 32 });
	const header = continuity !== null && typeof continuity === 'object' ? continuity : null;
	// The header's unresolved failure already states this result; the observation keeps only its replaceable handle.
	const lastResultInHeader = header?.failure !== undefined && typeof observation.lastResult?.actionId === 'string' && observation.lastResult.state !== 'SUCCEEDED'
		&& header.failure.startsWith(`${observation.lastResult.actionType} ${observation.lastResult.reasonCode}`);
	const eventPlanningLeadMs = status?.planningLeadMs ?? planningLeadMs ?? event?.planningLeadMs;
	// The model reads wear as usesLeft; programs keep the raw damage facts.
	const inventorySource = asArray(withToolWear(observation.inventory)?.items);
	const itemSource = asArray(observation.items);
	const entitySource = asArray(observation.entities).filter((entity) => entity?.type !== 'minecraft:item').map(visibleEntity);
	const blockSource = asArray(observation.blocks);
	const landmarkSource = Array.isArray(observation.landmarks) ? observation.landmarks : null;
	const nearbyContainerSource = Array.isArray(observation.nearbyContainers) ? observation.nearbyContainers : null;
	const optionSource = Array.isArray(observation.options) ? observation.options : null;
	const inventoryRows = boundedEventArray(inventorySource, 32);
	const itemRows = boundedEventArray(itemSource, 16);
	// Hostile or hunting mobs (including ones only heard behind the agent) survive the nearest-16 cut.
	const entityRows = boundedEventArray(entitySource, 16, isHazardousEventFact);
	// Pay for landing/burn danger facts with terrain detail. The full observation stays
	// queryable; coverage below names the omitted rows, and threat/inventory detail keeps its existing budget.
	const dangerTrigger = normalizedEvent === 'program_attention' ? status?.decision?.trigger ?? trigger : trigger;
	const burningOrContact = (DANGER_DECISION_TRIGGERS.has(dangerTrigger) || dangerTrigger === 'low_health')
		&& (inHazardContact(observation.player) || burnFacts(observation.player) !== null);
	const blockRows = boundedEventArray(blockSource, burningOrContact ? 12 : 32,
		burningOrContact ? row => isHazardousEventFact(row) || row?.blockId === 'minecraft:water' : isHazardousEventFact);
	const landmarkRows = landmarkSource === null ? null : boundedEventArray(landmarkSource, 32);
	const nearbyContainerRows = nearbyContainerSource === null ? null : boundedEventArray(nearbyContainerSource, 16);
	const optionRows = optionSource === null ? null : boundedEventArray(optionSource, 4);
	const compactObservation = {
		...(observation.observedAtEpochMs === undefined ? {} : { observedAtEpochMs: observation.observedAtEpochMs }),
		...(observation.eventSequence === undefined ? {} : { eventSequence: observation.eventSequence }),
		...(observation.freshness === undefined ? {} : { freshness: observation.freshness }),
		...(observation.coverage === undefined ? {} : { coverage: compactCoverageForEvent(observation.coverage) }),
		...(observation.perception === undefined ? {} : { perception: compactPerceptionForEvent(withoutHeardSoundEvents(observation.perception, observation)) }),
		...(observation.ready === undefined ? {} : { ready: observation.ready }),
		...(observation.status === undefined ? {} : { status: observation.status }),
		...(observation.velocity === undefined ? {} : { velocity: observation.velocity }),
		player: visibleObservation(observation).player ?? {},
		inventory: {
			items: inventoryRows.values,
			...(observation.inventory?.selectedSlot === undefined ? {} : { selectedSlot: observation.inventory.selectedSlot }),
			...(observation.inventory?.selectedItem === undefined ? {} : { selectedItem: observation.inventory.selectedItem }),
			...(observation.inventory?.tagCounts === undefined ? {} : { tagCounts: observation.inventory.tagCounts }),
		},
		items: itemRows.values,
		entities: entityRows.values,
		...compactBlockDefaults(blockRows.values, landmarkRows?.values),
		...(observation.sighted === undefined ? {} : { sighted: observation.sighted }),
		...(observation.furnaces === undefined ? {} : { furnaces: observation.furnaces }),
		...(observation.toolBroke === undefined ? {} : { toolBroke: observation.toolBroke }),
		...(observation.leftBehind === undefined ? {} : { leftBehind: observation.leftBehind }),
		...(observation.recentlySeen === undefined ? {} : { recentlySeen: observation.recentlySeen }),
		...(nearbyContainerRows === null ? {} : { nearbyContainers: nearbyContainerRows.values }),
		...(observation.world === undefined ? {} : { world: modelFacingWorld(visibleObservation(observation).world) }),
		...(observation.currentAction === undefined ? {} : { currentAction: runningActionFacts(observation.currentAction, runningActionStart, runningAction, visibleObservation(observation).player) }),
		...(observation.lastResult === undefined ? {} : { lastResult: lastResultInHeader ? { actionId: observation.lastResult.actionId } : observation.lastResult }),
		...(observation.interaction === undefined ? {} : { interaction: observation.interaction?.menu == null ? observation.interaction : { ...observation.interaction, menu: visibleMenu(observation.interaction.menu) } }),
		...(observation.death === undefined ? {} : { death: observation.death }),
		...(observation.deathScreen === undefined ? {} : { deathScreen: observation.deathScreen }),
		...(observation.recovery === undefined ? {} : { recovery: observation.recovery }),
		...(optionRows === null ? {} : { options: optionRows.values }),
		...(observation.failureClass === undefined ? {} : { failureClass: observation.failureClass }),
		...(observation.continuity === undefined ? {} : { continuity: observation.continuity }),
		...(observation.lastLiveInventory === undefined ? {} : { lastLiveInventory: observation.lastLiveInventory }),
		resultCoverage: {
			inventory: eventArrayCoverage(inventorySource, inventoryRows.values),
			items: eventArrayCoverage(itemSource, itemRows.values),
			entities: eventArrayCoverage(entitySource, entityRows.values),
			blocks: eventArrayCoverage(blockSource, blockRows.values),
			...(landmarkRows === null ? {} : { landmarks: eventArrayCoverage(landmarkSource, landmarkRows.values) }),
			...(nearbyContainerRows === null ? {} : { nearbyContainers: eventArrayCoverage(nearbyContainerSource, nearbyContainerRows.values) }),
			...(optionRows === null ? {} : { options: eventArrayCoverage(optionSource, optionRows.values) }),
		},
	};
	const conversationEntries = Array.isArray(conversation) ? conversation : (Array.isArray(conversation?.entries) ? conversation.entries : []);
	// recipientId is always this agent and goalRevision is bookkeeping; the sender's name and operator flag stay.
	const unreadEntries = boundedEventArray(conversationEntries, Number.POSITIVE_INFINITY).values
		.map(({ recipientId, goalRevision, ...entry }) => entry);
	const unreadConversation = Array.isArray(conversation)
		? { mode: 'unread', baseSequence: null, nextSequence: conversation.at(-1)?.sequence ?? -1, entries: unreadEntries, omittedEntries: 0 }
		: {
			mode: 'unread',
			baseSequence: conversation?.baseSequence ?? null,
			nextSequence: conversation?.nextSequence ?? -1,
			entries: unreadEntries,
			omittedEntries: 0,
		};
	const isPlanningDue = normalizedEvent === 'program_planning_due';
	// A program's attention event names the program, so the decision carries the trigger that raised it.
	const effectiveTrigger = status?.decision?.trigger ?? trigger;
	// Burning damage (lava contact often classifies as damage) carries the burn and food facts too.
	const healingTrigger = HEALING_EVENT_TRIGGERS.has(effectiveTrigger) || effectiveTrigger === 'damage' && burnFacts(observation.player) !== null;
	const hazardContact = !isPlanningDue && inHazardContact(observation.player);
	const residualBurn = !isPlanningDue && !hazardContact && (observation.player?.onFire === true || burnFacts(observation.player) !== null);
	const needsFoodFacts = !isPlanningDue && (Number.isFinite(observation.player?.foodLevel) && observation.player.foodLevel <= 6 || lowEligibleBody(observation.player, 8, 0.4));
	const healingSource = healing ?? ((healingTrigger || needsFoodFacts || residualBurn) && Number.isFinite(observation.player?.health) ? healingFacts(observation) : null);
	const eventHealing = presentEventHealing(visibleHealing(compactHealingForEvent(healingSource, hazardContact), compactObservation.player));
	const outlook = isPlanningDue ? null : threatOutlook(observation);
	const hud = hudFacts(compactObservation.player, compactObservation.world, observation.interaction?.menu);
	// Move only facts present in the lead sections; runtime observations and tool results retain their full shapes.
	if (hud !== null) {
		for (const key of Object.keys(hud)) delete compactObservation.player[key];
		if (hud.air !== undefined) {
			delete compactObservation.player.airBubbles;
			delete compactObservation.player.underWater;
		}
		if (hud.health !== undefined) delete compactObservation.player.maxHealth;
		if (hud.menuId !== undefined) delete compactObservation.interaction.menu.menuId;
		if (hud.sky !== undefined) delete compactObservation.world.dayPhase;
	}
	const situation = isPlanningDue ? null : situationFacts(observation);
	// The side glance is stated once, in the danger line; the raw rows stay in the stored observation.
	const glance = isPlanningDue || conversationOnly === true ? null : dangerGlance(visibleObservation(observation).player);
	delete compactObservation.player.edges;
	const combat = isPlanningDue ? null : combatFacts(observation);
	// Only the wake that first reports a dimension change: what the arrival spot shows before the first step.
	const arrival = isPlanningDue || !reportsDimensionChange(changed) ? null : arrivalFacts(observation);
	const pendingResourceSightings = boundedResourceSightings(record, queuedResourceSightings, status?.decision?.resourceSightings, result?.resourceSightings);
	const sightingClock = { observedAtEpochMs: compactObservation.observedAtEpochMs };
	const resourceSightings = historicalResourceSightings(pendingResourceSightings, compactObservation, sightingClock);
	const decision = status?.decision == null ? undefined : (({ resourceSightings, ...rest }) => rest)(status.decision);
	const payload = {
		event: normalizedEvent,
		...(mergedEvents === undefined ? {} : { mergedEvents: mergedEvents.map((entry) => {
			const input = buildNativeEventInput(record, entry);
			const { goal, goalSpec, goalRevision, mode, conversation, ...facts } = JSON.parse(input.slice(input.indexOf('\n') + 1));
			if (facts.program?.decision != null) {
				delete facts.program.decision.request;
				facts.program.decision.historical = true;
			}
			if (facts.program?.result !== undefined && entry.result !== undefined) {
				// Each owed program failure owns its receipts, including failures older than the usual receipt tail.
				for (const key of ['failure', 'message']) {
					if (entry.result[key] !== undefined) facts.program.result[key] = entry.result[key];
				}
				if (entry.result.receipts !== undefined) {
					facts.program.result.receipts = entry.result.receipts.filter((receipt, index, rows) =>
						index >= rows.length - 8 || ['FAILED', 'TIMED_OUT', 'REJECTED', 'CANCELLED'].includes(receipt.state));
					facts.program.result.omittedReceipts = (entry.result.omittedReceipts ?? 0) + entry.result.receipts.length - facts.program.result.receipts.length;
				}
			}
			return facts;
		}) }),
		trigger: typeof trigger === 'string' && trigger.length > 0 ? trigger : (isPlanningDue ? normalizedEvent : 'observation'),
		...(movementLoop && trigger !== 'movement_loop' ? { movementLoop: true } : {}),
		// The plan's counted needs (have/need) and the step being worked, then the dangers around the body, lead every wake.
		...(typeof goalNow === 'string' && goalNow.length > 0 && !isPlanningDue && conversationOnly !== true ? { goalNow } : {}),
		// A goal skill whose preconditions hold now, beside the counts it serves (skill-fits.mjs).
		...(typeof skillFits === 'string' && skillFits.length > 0 && !isPlanningDue && conversationOnly !== true ? { skillFits } : {}),
		...(glance === null ? {} : { danger: glance }),
		// Danger and body/program ownership lead, then the working intent (now), then changed facts.
		...(hud === null ? {} : { hud }),
		// Repeated hits folded since the last update, so one steer carries what several used to.
		...(dangerSummary === null || dangerSummary === undefined ? {} : { dangerSinceLastUpdate: dangerSummary }),
		...(eventHealing === null || eventHealing === undefined ? {} : { healing: eventHealing }),
		...(outlook === null ? {} : { threatOutlook: outlook }),
		// Dangerous contexts just entered: each danger there and the armed rule that senses it, or the reflex vocabulary that could.
		...(Array.isArray(contexts) && contexts.length > 0 && !isPlanningDue ? { contexts } : {}),
		// Danger wakes: current dangers no armed rule senses.
		...(Array.isArray(uncovered) && uncovered.length > 0 && !isPlanningDue && (DANGER_DECISION_TRIGGERS.has(dangerTrigger) || dangerTrigger === 'low_health') ? { noRuleFor: uncovered } : {}),
		...(programId === undefined ? {} : { program: { programId,
			...(status === undefined ? {} : { state: status.state, engineState: status.engineState, programVersion: status.programVersion, deadlineEpochMs: status.deadlineEpochMs, planningLeadMs: status.planningLeadMs ?? eventPlanningLeadMs, planningBasis: status.planningBasis, ...(isPlanningDue ? { next: PLANNING_TAIL_NOTE } : {}), timing: status.timing, decision, pendingSuccessor: status.pendingSuccessor, ...(status.standingOrder == null ? {} : { standingOrder: compactStandingOrder(status.standingOrder) }) }),
			...(result === undefined ? {} : { result: { state: result.state, reasonCode: result.reasonCode, ...(typeof result.summary === 'string' ? { summary: result.summary } : {}), ...(isFailureResult(result) ? { failure: withFailureSchema(result).failure } : {}), ...(result.standingOrder == null ? {} : { standingOrder: compactStandingOrder(result.standingOrder) }), actions: result.actions, actionsSucceeded: result.actionsSucceeded, actionsFailed: result.actionsFailed, timing: result.timing, freshness: result.freshness, programVersion: result.programVersion, queueId: result.queueId, predecessorProgramId: result.predecessorProgramId, discardedSuccessor: result.discardedSuccessor, receipts: result.receipts?.slice(-8).map(wakeReceipt), omittedReceipts: Math.max(0, (result.receipts?.length ?? 0) - 8) + (result.omittedReceipts ?? 0) } }) } }),
		...(header === null ? {} : { now: header }),
		...(situation === null ? {} : { situation }),
		...(typeof changed === 'string' && !isPlanningDue ? { [SITUATION_CHANGED_FIELD]: changed } : {}),
		...(arrival === null ? {} : { arrival }),
		...(typeof strategy === 'string' && !isPlanningDue ? { [STRATEGY_POINTER_FIELD]: strategy } : {}),
		...(progress === null || header !== null ? {} : { progress }),
		...(combat === null ? {} : { combat }),
		// The goal and event instruction already state task ownership; HUD wakes need no duplicate mode label.
		...(hud === null ? { mode: conversationOnly === true ? 'conversation_only' : 'goal' } : {}),
		goal: record?.currentGoal ?? null,
		goalSpec: presentGoalSpec(record?.currentGoalSpec ?? null, record?.currentGoal),
		goalRevision: record?.goalRevision ?? 0,
		...(awaitingConfirmation ? { completion: { state: 'AWAITING_OPERATOR_CONFIRMATION', factsAtFinish: confirmationFacts ?? [] } } : {}),
		...(taskMemory === null ? {} : { taskMemory: presentTaskMemory(taskMemory, record?.agentId) }),
		...(eventSequence === undefined ? {} : { eventSequence }),
		...(resourceSightings.length === 0 ? {} : { resourceSightings }),
		observation: isPlanningDue ? compactPlanningDueObservation(compactObservation) : compactObservation,
		conversation: unreadConversation,
	};
	// Authoritative persisted steering has its own schema-derived bound. Reserve
	// its actual encoded bytes once, so even escaped/non-ASCII history cannot
	// consume the optional event/unread budget or force instructions out of it.
	// Budget the underlying wake independently: a loop flag must never trim danger or unread messages.
	const loopMetadataBytes = payload.movementLoop === true ? Buffer.byteLength(JSON.stringify({ movementLoop: true }), 'utf8') - 1 : 0;
	// Owed event history has already passed the same player-facing projection as an individual wake.
	// Reserve it separately so optional context trimming cannot erase an undelivered danger or failure.
	const mergedEventBytes = payload.mergedEvents === undefined ? 0 : Buffer.byteLength(JSON.stringify({ mergedEvents: payload.mergedEvents }), 'utf8');
	const eventBudgetBytes = 16_384 + Buffer.byteLength(JSON.stringify(payload.goal), 'utf8') + loopMetadataBytes + mergedEventBytes;
	// Appearance is optional visual detail. It must not push an otherwise fitting
	// wake into overflow compaction, which can discard hostile rows and block facts.
	if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > eventBudgetBytes) {
		for (const section of ['entities', 'blocks', 'landmarks']) {
			if (!Array.isArray(compactObservation[section])) continue;
			compactObservation[section] = compactObservation[section].map(({ appearance, ...facts }) => facts);
		}
		payload.observation = isPlanningDue ? compactPlanningDueObservation(compactObservation) : compactObservation;
	}
	let json = fitResourceSightings(payload, eventBudgetBytes);
	if (Buffer.byteLength(json, 'utf8') > eventBudgetBytes) {
		const overflowObservation = compactEventObservationForBudget(compactObservation);
		const overflowConversation = { ...unreadConversation, entries: [...unreadConversation.entries] };
		const overflowPayload = {
			...payload,
			observation: isPlanningDue ? compactPlanningDueObservation(overflowObservation) : overflowObservation,
			conversation: overflowConversation,
		};
		const overflowSightings = historicalResourceSightings(pendingResourceSightings, overflowPayload.observation, sightingClock);
		overflowPayload.resourceSightings = overflowSightings.length === 0 ? undefined : overflowSightings;
		json = fitResourceSightings(overflowPayload, eventBudgetBytes);
		// Player messages outrank optional context. If the compacted event still leaves
		// no room for the oldest unread message, fall back to core facts instead of
		// failing every later turn with the same oversized context.
		if (unreadConversation.entries.length > 0 && !fitsWithOldestMessage(overflowPayload, eventBudgetBytes)) {
			Object.assign(overflowPayload, minimalEventContext(overflowPayload));
			const minimalSightings = historicalResourceSightings(pendingResourceSightings, overflowPayload.observation, sightingClock);
			overflowPayload.resourceSightings = minimalSightings.length === 0 ? undefined : minimalSightings;
			json = fitResourceSightings(overflowPayload, eventBudgetBytes);
		}
		// Protect the oldest unread instructions. Later messages stay unread and
		// are delivered by a following turn, never acknowledged via a skipped tail.
		while (Buffer.byteLength(json, 'utf8') > eventBudgetBytes && overflowConversation.entries.length > 0) {
			overflowConversation.entries.pop();
			overflowConversation.omittedEntries += 1;
			overflowConversation.nextSequence = overflowConversation.entries.at(-1)?.sequence ?? unreadConversation.baseSequence ?? -1;
			json = JSON.stringify(overflowPayload);
		}
		if (unreadConversation.entries.length > 0 && overflowConversation.entries.length === 0) {
			throw Object.assign(new TypeError(`Native event context leaves no room for unread conversation sequence ${unreadConversation.entries[0].sequence}; messages remain unread. Reduce the event or task context before retrying.`), { code: 'NATIVE_CONVERSATION_BUDGET_EXCEEDED' });
		}
	}
	// Budget with every capacity identity, then abbreviate only what the final retained rows still prove.
	const retainedPayload = JSON.parse(json);
	if (typeof retainedPayload.situation === 'string') {
		retainedPayload.situation = situationFacts(observation, retainedPayload.observation?.inventory?.items);
		json = JSON.stringify(retainedPayload);
	}
	json = withItemDefaults(json);
	// Urgent program decisions get a factual danger line; fight_target and flee_from can run while the program
	// pauses or awaits an explicit decision, so the threat line says so instead of ordering a response.
	const dangerDecision = !isPlanningDue && status?.decision?.priority === 'urgent' && DANGER_DECISION_TRIGGERS.has(status.decision.trigger);
	const dangerLine = isPlanningDue || conversationOnly === true ? null : effectiveTrigger === DRAGON_PERCHED_TRIGGER
		? `${dragonPerchLine(observation)}${status?.decision ? ' Answer program decisions.' : ''}`
		: effectiveTrigger === LAVA_FLOW_TRIGGER ? lavaFlowLine(observation)
		: dangerFactLine(effectiveTrigger, visibleObservation(observation).player);
	const survivalLine = isPlanningDue || conversationOnly === true || effectiveTrigger === 'low_health_food' ? null : survivalFactLine(observation, { newContext });
	const burningInstruction = observation.player?.harm?.waterEvaporates === true || observation.world?.dimension === 'minecraft:the_nether'
		? BURNING_INSTRUCTION.replace('Water/rain extinguish;', 'Water evaporates here;') : BURNING_INSTRUCTION;
	let instruction = conversationOnly === true && dangerWake === true
		? NO_TASK_DANGER_INSTRUCTION
		: conversationOnly === true && selfCareWake === true
		? NO_TASK_HEAL_INSTRUCTION
		: conversationOnly === true
		? 'Player conversation. You have no active task. Only operator:true messages are tasks: if one asks you to do something, call takeTask (it defaults to the sender\'s words; use resume:true to continue a paused task), then end this turn; your task turn starts at once with every tool. Otherwise reply with say.'
		: isPlanningDue
		? PLANNING_EVENT_INSTRUCTION
		: hazardContact
			? `${observation.player?.hazard === 'fire' && observation.player?.inLava !== true ? FIRE_CONTACT_INSTRUCTION : HAZARD_CONTACT_INSTRUCTION}${dangerDecision ? ' Respond to the program after.' : ''}`
		: residualBurn
			? `${burningInstruction}${dangerDecision ? ' Respond to the program after.' : ''}`
		: dangerLine !== null
			? `${dangerLine}${dangerDecision ? ' Facts below are fresh; the program awaits your reply.' : ''}`
		: survivalLine !== null
			? `${survivalLine}${status?.decision ? ' Respond to the pending program decision after the immediate defense.' : ''}`
		: dangerDecision
			? dangerDecisionInstruction(status.decision.trigger)
			: awaitingConfirmation === true
				? AWAITING_CONFIRMATION_EVENT_INSTRUCTION
				: effectiveTrigger === 'low_health_food'
					? TASK_HEAL_INSTRUCTION
					// Danger keeps its own wake; the assessment stays pending for the next event (see #pendingAssessment).
					: newContext === true && !DANGER_DECISION_TRIGGERS.has(effectiveTrigger)
						? NEW_CONTEXT_EVENT_INSTRUCTION
						: status?.decision ? GENERIC_UPDATE_INSTRUCTION : GENERIC_FACTS_INSTRUCTION;
	// Danger and hazard lines stay as they are; the contexts field still rides on those wakes.
	if (Array.isArray(contexts) && contexts.length > 0 && !conversationOnly && !isPlanningDue && !hazardContact && !residualBurn && dangerLine === null && !dangerDecision && !DANGER_DECISION_TRIGGERS.has(effectiveTrigger)) {
		const entered = contexts.map((row) => row.entered).join(', ');
		instruction = instruction === GENERIC_UPDATE_INSTRUCTION || instruction === GENERIC_FACTS_INSTRUCTION
			? `Live Minecraft event: entered ${entered}. contexts lists each danger there and which armed reflex senses it.${status?.decision ? ' Answer program decisions.' : ''}`
			: `${instruction} Entered ${entered}: contexts lists its dangers and armed reflexes.`;
	}
	// Respawn wakes 2026-10-23: after 35 End deaths and the Nether deaths the model rebuilt from nothing beside the
	// portal while its kit waited minutes away; where the drops are, how long they last and the way back lead the wake.
	if (respawnRecovery !== null && instruction.startsWith(NEW_CONTEXT_EVENT_INSTRUCTION)) {
		instruction = `${NEW_CONTEXT_EVENT_INSTRUCTION} ${respawnRecovery}${instruction.slice(NEW_CONTEXT_EVENT_INSTRUCTION.length)}`;
	}
	if (!conversationOnly && !isPlanningDue && !awaitingConfirmation) {
		const recovery = failureRecoveryInstruction(observation, status, header?.failure);
		if ((instruction === GENERIC_UPDATE_INSTRUCTION || instruction === GENERIC_FACTS_INSTRUCTION) && recovery !== null) instruction = recovery;
		const menu = observation.interaction?.menu;
		const player = visibleObservation(observation).player;
		// An open container can coexist with danger before its next threshold-crossing event.
		if (typeof menu?.type === 'string' && menu.type !== 'minecraft:inventory' && 'containerId' in menu
			&& (player?.underWater === true || player?.onFire === true || player?.inLava === true
				|| player?.suffocating === true || player?.lastAttacker != null || player?.threats?.length > 0)) {
			const response = player.underWater === true ? 'get air' : inHazardContact(player) ? 'move horizontally out of fire/lava' : 'defend or escape';
			instruction = `Danger with ${menu.type} open. Use one sequence: menu_close (menuId:"${menu.type}"), then ${response}. Closing alone gives no protection.${status?.decision ? ' Respond to the pending program decision after.' : ''}`;
		}
	}
	if (!conversationOnly && !isPlanningDue) {
		const dead = deathInstruction(normalizedEvent, observation, taskMemory, record?.name);
		if (dead !== null) instruction = dead;
	}
	// Survival facts and finished-goal ownership must both reach the model, including lava/fire wakes.
	if (awaitingConfirmation) {
		if (instruction !== AWAITING_CONFIRMATION_EVENT_INSTRUCTION) instruction += ` ${AWAITING_CONFIRMATION_EVENT_INSTRUCTION}`;
		if (confirmationFacts?.some(fact => fact.type !== 'operator_confirmed' && fact.satisfied === true)) {
			instruction += ' Minecraft verified the factual goal conditions at your last finish check (completion.factsAtFinish). Only operator confirmation remains; keep waiting without repeating the work.';
		}
	}
	// Provider bookkeeping keeps receipt identity even when the presentation budget removed it.
	// encodeNativeEventInput removes this internal field before sending model-facing text.
	const receipt = actionReceipt;
	if (typeof receipt?.actionId === 'string' && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(receipt.state)) {
		const delivered = JSON.parse(json);
		if (delivered.observation?.lastResult?.actionId !== receipt.actionId || delivered.observation?.lastResult?.state !== receipt.state) {
			delivered._actionReceipt = { actionId: receipt.actionId, state: receipt.state, ...(receipt.reasonCode === undefined ? {} : { reasonCode: receipt.reasonCode }) };
			json = JSON.stringify(delivered);
		}
	}
	if (mergedEvents !== undefined) {
		const delivered = JSON.parse(json);
		for (const historical of delivered.mergedEvents) {
			// Share only identical ordinary context with the final current snapshot, after its budget is fitted.
			// Historical danger/player facts and failure receipts stay explicit, including across context handoff.
			const same = [];
			for (const key of ['blocks', 'landmarks', 'entities', 'items', 'nearbyContainers', 'inventory', 'world', 'resultCoverage']) {
				if (historical.observation?.[key] !== undefined
					&& JSON.stringify(historical.observation[key]) === JSON.stringify(delivered.observation?.[key])) {
					same.push(key);
					delete historical.observation[key];
				}
			}
			if (same.length > 0) historical.observationFieldsEqualToCurrent = same;
		}
		json = JSON.stringify(delivered);
	}
	// Coverage must keep one shape when HUD or running-action facts appear and disappear.
	const presented = JSON.parse(json);
	compactRoutineCoverage(presented.observation);
	return `${compactEventInstruction(instruction)}\n${JSON.stringify(presented)}`;
}

// Transpose the repeated labels, preserving every count and omission after budget trimming.
function compactRoutineCoverage(observation) {
	const coverage = observation.resultCoverage;
	if (!coverage || Object.values(coverage).some(detail => !detail || typeof detail !== 'object'
		|| Object.keys(detail).some(key => !['availableInSnapshot', 'omitted'].includes(key)))) return;
	observation.snapshotCounts = Object.fromEntries(Object.entries(coverage).map(([section, detail]) => [section, detail.availableInSnapshot]));
	const omitted = Object.entries(coverage).filter(([, detail]) => detail.omitted !== undefined);
	if (omitted.length) observation.omittedRows = Object.fromEntries(omitted.map(([section, detail]) => [section, detail.omitted]));
	delete observation.resultCoverage;
}

export function compactEventInstruction(instruction) {
	if (instruction === GENERIC_UPDATE_INSTRUCTION) return 'Update; answer program decisions.';
	if (instruction === GENERIC_FACTS_INSTRUCTION) return 'Update; act on fresh facts.';
	// The encoder recognizes this exact boundary to retain orientation on context changes.
	if (instruction === NEW_CONTEXT_EVENT_INSTRUCTION) return ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION;
	return instruction.replace(/^Live Minecraft event[.:] /, '')
		.replace('Facts below are fresh; the program awaits your reply.', 'Reply to the program.')
		.replace('Player conversation. You have no active task.', 'Conversation; no active task.')
		.replace('Held jump rises ~0.8m/s in lava.', 'Held jump: ~0.8m/s up.')
		.replace('Burn continues after exit; time unknown.', 'Burn after exit; time unknown.')
		.replace('burn continues after exit.', 'burn after exit.')
		.replace('threat, see player.threats. fight_target and flee_from work while the program awaits you.', 'Threat: fight_target/flee_from work while program awaits reply.')
		.replace('defensive handler finished; result and fresh facts below. The program awaits your reply.', 'Handler finished; result/facts below. Reply to the program.')
		.replace('Your finished goal awaits operator confirmation: do not redo it or re-run finish. Waiting never blocks new requests: act on player messages now with any tool, as part of your task, then call finish again when done.', 'Goal awaits operator confirmation: do not redo it or re-run finish. New player requests allow every tool as part of your task; act now, then finish again.')
		.replace('You have no active task; any finished task stays finished, so do not redo it.', 'No active task; do not redo finished work.')
		.replace('If a message asks you to do something, call takeTask', 'For a task request, call takeTask')
		.replace("it defaults to the sender's words; use resume:true to continue a paused task", 'defaults to sender text; resume:true resumes a paused task');
}

const TRAVEL_ACTION_TYPES = new Set(['move_to', 'navigate_to', 'travel_to']);
// What the running action is committed to, from the arguments it was started with (travel destination and the straight
// distance left to it, a fight's own bailout), and the hearts lost since it was first seen running, as the HUD drew
// them. Only a drop is news: the action's own result reports how it ended.
function runningActionFacts(action, start, authored, player) {
	if (action?.active !== true) return action;
	const facts = { ...action };
	const args = authored?.actionId === action.actionId ? authored.arguments ?? {} : {};
	if (TRAVEL_ACTION_TYPES.has(action.actionType) && [args.x, args.y, args.z].every(Number.isFinite)) {
		facts.to = `${args.x},${args.y},${args.z}`;
		if ([player?.x, player?.y, player?.z].every(Number.isFinite)) facts.left = Math.round(Math.hypot(args.x - player.x, args.y - player.y, args.z - player.z));
	} else if (action.actionType === 'travel_to' && [args.x, args.z].every(Number.isFinite)) {
		facts.to = `${args.x},${args.z}`;
		if ([player?.x, player?.z].every(Number.isFinite)) facts.left = Math.round(Math.hypot(args.x - player.x, args.z - player.z));
	}
	if (action.actionType === 'fight_target' && Number.isFinite(args.fleeAtHealth)) facts.fleeAtHealth = args.fleeAtHealth;
	// A dig runs for minutes: its goal stays in view while it digs.
	if (action.actionType === 'dig_to') facts.to = `${args.pattern ?? 'stairs_down'}${Number.isFinite(args.y) ? ` y${args.y}` : ''}${Number.isFinite(args.x) ? ` x${args.x}` : ''}${Number.isFinite(args.z) ? ` z${args.z}` : ''}${args.heading ? ` ${args.heading}` : ''}`;
	if (start?.actionId === action.actionId && Number.isFinite(start.health) && Number.isFinite(player?.health)) {
		const before = Math.ceil(start.health), now = Math.ceil(player.health);
		if (now < before) facts.hurtWhileRunning = `${before}->${now}`;
	}
	return facts;
}

// No preference for keeping running work: currentAction states what runs and what it has cost, and the model weighs it.
// Restating the cancel contract here changed no decision in the evals and cost ~70 B on every running wake.
export const GENERIC_UPDATE_INSTRUCTION = 'Update. Use fresh facts for the goal; answer program decisions.';
// Without a pending decision, naming one sent the model to programStatus before eating or fleeing (decision evals).
export const GENERIC_FACTS_INSTRUCTION = 'Update. Use fresh facts for the goal.';

function failureRecoveryInstruction(observation, status, unresolvedFailure) {
	if (status?.decision != null) return null;
	const failed = observation.lastResult;
	if (!isFailureResult(failed) && typeof unresolvedFailure !== 'string') return null;
	const current = observation.currentAction;
	if (current?.active === true) {
		// An unrelated old result must not turn every running action into a retry wake.
		const sameKind = isFailureResult(failed) && failed.actionType === current.actionType
			|| typeof unresolvedFailure === 'string' && unresolvedFailure.startsWith(`${current.actionType} `);
		if (!sameKind) return null;
		return `Your ${current.actionType} is running; lastResult describes an earlier action. End this turn to let it continue unless fresh facts require a changed action. No status lookup is needed.`;
	}
	const reason = isFailureResult(failed) ? `${failed.actionType ?? 'action'} ${failed.reasonCode}` : unresolvedFailure;
	const repair = FAILURE_REPAIR_HINTS[failed?.reasonCode] ?? 'Read the reported blocker and current facts; repair that cause or choose a feasible alternative.';
	return `Action failed: ${reason}. Keep the existing goal; choose its next unmet step from these fresh facts. Skip gathering resources already sufficient for that step. Repair this attempt only if still useful: ${repair} Mining needs room for drops and the right harvest tier (stone: wooden+, iron ore: stone+, diamond/gold/redstone: iron+). Use drop_item only on expendable stacks if room is needed; batch known setup with the useful action in sequence. Make progress now; no status lookup or unchanged retry.`;
}

// Live death wakes 2026-10-20 (71 in 22 games) led with "Update" or the failure of an action the death had already ended
// (38 of them, e.g. "Action failed: fight_target ... Make progress now"); none named the death. While dead the only
// action is respawn: a model that respawned straight into the zombies camping the spawn point died six times in three
// minutes, each time hit within ~5 s, before its first post-respawn call. The death and what waits there are the news.
function deathInstruction(event, observation, taskMemory, name) {
	const player = visibleObservation(observation).player ?? {};
	if (!(player.dead === true || event === 'player_death' && player.dead !== false && !(player.health > 0))) return null;
	const raw = typeof observation.death?.cause === 'string' ? observation.death.cause.trim() : '';
	// Vanilla death messages begin with the player's name.
	const cause = (typeof name === 'string' && name.length > 0 && raw.startsWith(`${name} `) ? raw.slice(name.length + 1) : raw).replace(/^was /, '') || 'cause unknown';
	return `Died: ${cause}. While dead only respawn acts.${respawnSurroundings(observation, taskMemory)}`;
}

// Hostiles seen now around where the next respawn lands: the set respawn, else the last respawn in this dimension (the
// world spawn area). Nothing is said when that point is unknown or nothing hostile is seen near it.
function respawnSurroundings(observation, taskMemory) {
	const death = observation.death ?? {};
	const dimension = observation.world?.dimension ?? death.dimensionId ?? null;
	const finite = (cell) => [cell?.x, cell?.y, cell?.z].every(Number.isFinite);
	let point = null;
	let label = null;
	const set = { x: death.respawnX, y: death.respawnY, z: death.respawnZ };
	if (finite(set)) {
		if ((death.respawnDimensionId ?? dimension) === dimension) { point = set; label = 'Set respawn'; }
	} else {
		const last = asArray(taskMemory?.deaths).map(entry => entry?.respawnedAt)
			.filter(cell => finite(cell) && (cell.dimension ?? dimension) === dimension).at(-1);
		if (last !== undefined) { point = last; label = 'No bed set; last respawn'; }
	}
	if (point === null) return '';
	const near = asArray(observation.entities).filter(entity => entity?.hostile === true && Number.isFinite(entity.x) && Number.isFinite(entity.z)
		&& Math.hypot(entity.x - point.x, entity.z - point.z) <= 16);
	if (near.length === 0) return '';
	const counts = new Map();
	for (const entity of near) {
		const type = typeof entity.type === 'string' ? entity.type.replace(/^minecraft:/, '') : 'unknown';
		counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	const list = [...counts].map(([type, count]) => count > 1 ? `${type} x${count}` : type).join(', ');
	return ` ${label} ${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}: hostiles within 16 blocks of it now: ${list}.`;
}

// Options for the model, not a selected action or a claim that unseen geometry is safe.
const FAILURE_REPAIR_HINTS = {
	TARGET_NOT_VISIBLE: 'Clear or move around the obstruction, or choose another visible target; mine aims itself.',
	TARGET_TOO_FAR: 'Choose a closer supported position within reach before retrying.',
	NO_STANDABLE_PATH: 'Choose a supported arrival cell with feet/head clearance, or change the obstructing terrain.',
	NO_PATH: 'Choose another approach or change the terrain blocking the route.',
	PATH_BLOCKED: 'Choose another approach or clear the reported obstruction.',
	TARGET_CHANGED: 'Use the currently observed block identity or choose another target.',
	TARGET_OCCUPIED: 'Choose an empty placement cell or clear its occupant first.',
	NO_PLACEMENT_SUPPORT: 'Choose a placement with an adjacent solid support face.',
	ITEM_NOT_IN_HOTBAR: 'Move the needed item to the hotbar with select_tool or menu_click.',
	HOTBAR_SLOT_OCCUPIED: 'Choose an empty hotbar slot or rearrange the occupied destination.',
	RECIPE_INPUTS_UNAVAILABLE: 'Acquire the missing ingredients before crafting again.',
};

// The model reads the completion predicate; the request text is already the goal, and the
// fingerprint and creation tick are bookkeeping that only defeat same-as-previous omission.
function presentGoalSpec(spec, goal) {
	if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return spec;
	const { fingerprint, createdAtTick, originalRequest, ...rest } = spec;
	return { ...(originalRequest === undefined || originalRequest === goal ? {} : { originalRequest }), ...rest };
}

// Task memory as a wake shows it: store revisions, scope identity and authorship stamps change or
// repeat without telling the model anything, and a changed revision alone re-sent the whole summary.
const TASK_MEMORY_BOOKKEEPING = ['worldId', 'revision', 'currentGoalRevision', 'historical', 'query'];
const TASK_ENTRY_BOOKKEEPING = ['goalRevision', 'source', 'historical'];
function presentTaskMemory(summary, agentId) {
	if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return summary;
	const result = {};
	for (const [key, value] of Object.entries(summary)) {
		if (TASK_MEMORY_BOOKKEEPING.includes(key)) continue;
		result[key] = Array.isArray(value) ? value.map(entry => presentTaskEntry(entry, agentId)) : value;
	}
	return result;
}
function presentTaskEntry(entry, agentId) {
	// Model notes: `source` today; a provenance envelope's `src` beginning "told" after that lands.
	const authored = entry?.source === 'model_authored' || typeof entry?.src === 'string' && entry.src.startsWith('told');
	if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || !authored) return entry;
	const copy = { ...entry };
	for (const key of TASK_ENTRY_BOOKKEEPING) delete copy[key];
	// Another agent's shared entry keeps its author.
	if (copy.agentId === agentId) delete copy.agentId;
	return copy;
}

function mergeResourceSightings(...groups) {
	// Goal relevance was established at discovery; coalescing only enforces the carrier bounds.
	return boundedResourceSightings(null, ...groups);
}

function fitResourceSightings(payload, budget) {
	let json = JSON.stringify(payload);
	while (Buffer.byteLength(json, 'utf8') > budget && payload.resourceSightings?.length) {
		payload.resourceSightings = payload.resourceSightings.slice(0, -1);
		if (payload.resourceSightings.length === 0) delete payload.resourceSightings;
		json = JSON.stringify(payload);
	}
	return json;
}

// Dated sightings remain facts after they leave view; they must not masquerade as a current block or item.
// A sighting reaches the model with its fact envelope (src: source and age) instead of a raw wall clock.
function historicalResourceSightings(sightings, observation, now = observation) {
	return (sightings ?? []).filter(sighting => {
		if (sighting.dimension !== undefined && sighting.dimension !== observation.world?.dimension) return true;
		if (sighting.block) return ![...(observation.blocks ?? []), ...(observation.landmarks ?? [])].some(block =>
			block.x === sighting.block.x && block.y === sighting.block.y && block.z === sighting.block.z && block.blockId === sighting.block.blockId);
		return !(observation.items ?? []).some(item => item.stableId === sighting.item?.stableId && item.itemId === sighting.item?.itemId);
	}).map(({ observedAtEpochMs, ...sighting }) => ({ ...sighting, src: provenance('seen', { observedAtEpochMs }, now) }));
}

// Clock ticks change every wake, which would re-send the whole world section; situation carries the coarse day phase
// and biome instead. Programs, memory and watchers keep the raw facts from the runtime observation.
function modelFacingWorld(world) {
	if (world === null || typeof world !== 'object') return world;
	const { gameTime, dayTime, biome, ...rest } = world;
	return rest;
}

const NEW_CONTEXT_TRIGGERS = new Set(['start', 'replace', 'respawn']);
const CONTEXT_ENTRY_TRIGGER = 'context_entry';
// Sent only on lava or fire-block contact, in place of the generic event line.
export const HAZARD_CONTACT_INSTRUCTION = 'Live Minecraft event: lava/fire contact. Move horizontally out now, holding jump toward higher exits (player.exits up1). Jump alone may leave you in lava. Lava costs ~8 HP/s; burn continues after exit. Escape before food or guards.';
// A fire block (a blaze fireball leaves one where it lands) is not lava: no jump or swim, and staying adds burn time.
export const FIRE_CONTACT_INSTRUCTION = 'Live Minecraft event: standing in fire. It re-ignites you each tick; the burn grows while you stay. Step to a fire-free cell (harm.exits); breaking the fire block also puts it out. Burn continues after exit. Escape before food or guards.';
export const BURNING_INSTRUCTION = 'Live Minecraft event: burn continues after exit. Move clear of nearby fire/lava first. Water/rain extinguish; fire resistance blocks damage. Burn time unknown; food in healing.';
const DANGER_DECISION_TRIGGERS = new Set(['damage', 'threat', 'lava', LAVA_FLOW_TRIGGER, 'fire', 'suffocation', 'fall', 'drowning', 'cloud', 'projectile', 'defensive_handler_completed']);
const at = (cell) => [cell?.x, cell?.y, cell?.z].every(Number.isFinite) ? `${cell.x},${cell.y},${cell.z}` : null;
// The threat line names what a player could do with what the body carries, in no preferred order. d41 deck c4/c5:
// the line listed melee, flight and cover but never the bow, and the model never drew a carried bow from inside a shelter.
const RANGED_AMMO = new Set(['minecraft:arrow', 'minecraft:spectral_arrow', 'minecraft:tipped_arrow']);
export function carriedCombatOptions(observation) {
	const items = observation?.continuity?.rememberedSections?.includes('inventory') || !Array.isArray(observation?.inventory?.items) ? null
		: observation.inventory.items.filter(e => e?.count > 0);
	const count = test => (items ?? []).filter(e => test(e.itemId)).reduce((sum, e) => sum + e.count, 0);
	// Vanilla: a crossbow draws arrows from anywhere in the inventory but loads rockets only from either hand; a shield blocks from either hand.
	const inHand = e => e.slot === 'mainhand' || e.slot === 'offhand';
	const arrows = count(id => RANGED_AMMO.has(id)), rockets = (items ?? []).filter(e => inHand(e) && e.itemId === 'minecraft:firework_rocket').reduce((sum, e) => sum + e.count, 0);
	const ranged = items === null ? ['use_ranged (needs a bow or crossbow and ammunition; inventory not shown)']
		: [...(count(id => id === 'minecraft:bow') && arrows ? [`use_ranged (bow, ${arrows} arrows)`] : []),
			...(count(id => id === 'minecraft:crossbow') && arrows + rockets ? [`use_ranged (crossbow, ${[arrows ? `${arrows} arrows` : '', rockets ? `${rockets} rockets` : ''].filter(Boolean).join(', ')})`] : [])];
	const shield = ['offhand', 'mainhand'].map(slot => (items ?? []).find(e => e.slot === slot && e.itemId === 'minecraft:shield')).find(Boolean);
	return ['fight_target (melee)', ...ranged, ...(shield ? [`block_with_shield (${shield.slot === 'offhand' ? 'offhand' : 'main-hand'} shield)`] : []), 'flee_from', 'supported cover placement',
		'digging in (a 1x1 hole 2 deep with one block over it is fully enclosed; dirt breaks by hand in under 1 s)'].join(', ');
}
// A fresh context or unrelated event can carry an already unsafe body without a new danger edge.
function survivalFactLine(observation, { newContext = false } = {}) {
	const { player = {}, world = {} } = visibleObservation(observation);
	if (player.dead === true || player.health <= 0 || ['creative', 'spectator'].includes(player.gameMode)) return null;
	if (player.suffocating === true) return dangerFactLine('suffocation', player);
	if (player.underWater === true && player.airSecondsLeft <= 7.5) return dangerFactLine('drowning', player);
	const threats = asArray(player.threats);
	const creeper = threats.find(threat => threat.type === 'minecraft:creeper' && (threat.swelling === true || threat.signals?.some(signal => ['creeper_close', 'imminent'].includes(signal))));
	if (creeper) return `Live Minecraft event: creeper ${creeper.uuid} ${creeper.distance}m away${creeper.swelling === true ? ', swelling' : ''}. Choose flee_from now, including during a fight with another mob. Replace the active action with your escape if needed; fighting the other target does not handle this explosion. Use observed footing; the escape call can carry reflexes for the rest of the encounter.`;
	if (observation.currentAction?.active !== true && observation.lastResult?.reasonCode === 'LOW_HEALTH_BAILOUT') return 'Live Minecraft event: combat stopped at your bailout health; body idle, no retreat performed. Repeating the same threshold cannot attack while health remains below it. Choose flee_from, reachable cover, digging in (a 1x1 hole 2 deep with one block over it is fully enclosed; dirt breaks by hand in under 1 s) or a shield now, then heal once clear. Use fresh attacker UUIDs; do not resume exposed work.';
	if (threats.some(threat => threat.targeting === true || threat.swelling === true || threat.signals?.includes('attacked') || threat.signals?.includes('imminent') || threat.signals?.includes('creeper_close'))) {
		if (lowEligibleBody(player, 10, 0.5)) return `Live Minecraft event: nearby attacker and low health. Choose flee_from, reachable cover or digging in (a 1x1 hole 2 deep with one block over it is fully enclosed; dirt breaks by hand in under 1 s) now; break contact before eating. A fight at or below fleeAtHealth stops without retreating. Use player.threats UUIDs and observed footing.${edgeNote(player)}`;
		const calm = asArray(observation.entities).filter(entity => ['minecraft:piglin', 'minecraft:zombified_piglin'].includes(entity.type) && entity.hostile === false && entity.targetingAgent !== true && entity.alive !== false && entity.distance <= 4);
		if (calm.some(entity => entity.type === 'minecraft:piglin')) return `Live Minecraft event: nearby attacker beside a calm piglin. Sword sweeps can provoke its group despite worn gold. Choose separation or cover now, or a held axe with attack when in reach; fight_target selects its own hotbar weapon. Use the hostile target UUID, not the calm piglin.${edgeNote(player)}`;
		// Run d9-nether-e: a fight_target sweep at a blaze hurt a calm zombified piglin 1.3 m away; it killed the agent 13 s later.
		if (calm.length) return `Live Minecraft event: nearby attacker beside a calm zombified piglin ${Math.round(Math.min(...calm.map(entity => entity.distance)) * 10) / 10}m away. A sword sweep or stray hit makes it and every zombified piglin within 35 blocks hostile. Choose separation or cover now, or a held axe with attack when in reach; fight_target selects its own hotbar weapon. Use the hostile target UUID, not the calm one.${edgeNote(player)}`;
		return `Live Minecraft event: nearby threat (player.threats). Options with current gear and footing, in no order: ${carriedCombatOptions(observation)}. After blocked flight or a failed cover search, build cover or open a different exit before exposed work. Flee creepers; break contact at low health before eating. Use the reported target UUID. That call can carry reflexes for the next shots, burning or low health.${edgeNote(player)}`;
	}
	if (player.inWater === true && player.underWater === false && player.onGround === false && player.passenger !== true) {
		return 'Live Minecraft event: eyes above water, body still afloat without footing. Released input sinks. Hold jump while refilling air or choose a reachable shore/air pocket from observed terrain. Guard deletion cancels its current swim or float input; replace it with your next water action before doing stationary work.';
	}
	if (Number.isFinite(player.foodLevel) && player.foodLevel <= 6) return 'Live Minecraft event: low food; sprint is unavailable at 6 or below and regeneration needs 18+. Once clear of immediate danger eat carried food, or obtain visible food if empty. healing.options and player.bestFood give the available calls and slots; choose the food action now.';
	if (lowEligibleBody(player, 8, 0.4) && Number.isFinite(player.foodLevel) && player.foodLevel < 18) return `Live Minecraft event: low health. Food ${player.foodLevel}/20 cannot regenerate health. Eat carried food or obtain a visible food source before routine work; regeneration needs 18+. Use healing.options and current footing for the first food step.`;
	if (lowEligibleBody(player, 8, 0.4)) return 'Live Minecraft event: low health. Choose safe recovery before exposed travel or combat. Food 18+ permits regeneration; at full food ordinary eating cannot start. Eat if needed, retreat to cover or do safe nearby work while healing. Reuse these fresh facts for your first action.';
	if (!newContext && world.dayPhase === 'sunset' && player.skyOpen === true) return 'Live Minecraft event: sunset under open sky. Account for night before exposed travel: choose nearby shelter, light, sleep or defensible local work according to gear and food. Take the chosen preparation action from these fresh facts.';
	return null;
}
/**
 * A11: drowning, cloud and projectile wakes read "Update; answer program decisions." with the danger only in JSON.
 * The lead line states the one fact each needs (time left, where it ends, what hits when); the model picks the response.
 */
export function dangerFactLine(trigger, player) {
	if (player == null || typeof player !== 'object') return null;
	if (trigger === 'suffocation' && player.suffocating === true) {
		return 'Live Minecraft event: suffocating inside a solid block. Break the observed block at your head or open a reachable side exit now; sand/gravel can refill the shaft. Stop pillaring. If a program owns the body, cancelProgram with its current handle, then escape; repeated damage can stale a replace decision. Full food does not remove the obstruction.';
	}
	if (trigger === 'fall') {
		if (player.onGround === false && player.fallDistance > 0 && player.harm?.source === 'minecraft:fell_out_of_world') return `Live Minecraft event: falling into the void, ${player.fallDistance} blocks so far: nothing is below to the world's bottom, so no landing or water bucket stops it. An ender pearl thrown onto ground you saw is the only way back.`;
		if (player.onGround === false && player.fallDistance > 0) return `Live Minecraft event: already falling ${player.fallDistance} blocks${Number.isFinite(player.fallDamage) ? `; current fall damage estimate ${player.fallDamage} HP` : ''}. Released input or sneak cannot undo a fall. Choose reachable water or a carried water bucket landing if feasible; do not jump forward again. Prevention requires verified footing before leaving the edge.`;
		if (player.dropAhead) return 'Live Minecraft event: drop ahead on your movement heading. Choose to stop forward/jump input before the edge, then a supported route or place a step from safe footing. Unknown depth is not a safe short drop. Sneak protects grounded edges, not airborne landings.';
	}
	if (trigger === 'drowning') {
		const air = Number.isFinite(player.airSecondsLeft) ? ` ${player.airSecondsLeft}s air left;` : '';
		const breath = player.breathable, cell = at(breath);
		return `Live Minecraft event: drowning.${air}${cell === null ? ' No breathable cell seen.' : ` Breathable ${cell}${Number.isFinite(breath.distance) ? ` ${breath.distance}m` : ''}${typeof breath.direction === 'string' ? ` ${breath.direction}` : ''}.`} Surfacing alone does not advance a route. Released input sinks; hold jump to refill, then choose moveTo travel or an air pocket (doors create air).`;
	}
	if (trigger === 'cloud') {
		const cloud = (Array.isArray(player.clouds) ? player.clouds : []).find(row => row?.harmful === true);
		if (cloud === undefined) return null;
		const rate = Number.isFinite(player.harm?.hpLossPerSecond) ? ` ${player.harm.hpLossPerSecond} HP/s;` : '';
		const exit = at(cloud.nearestExit);
		return `Live Minecraft event: harmful cloud${cloud.contact === true ? ' contact' : ''}.${rate}${exit === null ? ' Exit unseen.' : ` Nearest exit ${exit}.`}${edgeNote(player)}`;
	}
	if (trigger === 'projectile') {
		const flight = (Array.isArray(player.incomingProjectiles) ? player.incomingProjectiles : []).find(row => row?.damaging !== false);
		if (flight === undefined || typeof flight.type !== 'string') return null;
		return `Live Minecraft event: incoming ${flight.type.replace(/^minecraft:/, '')}${Number.isFinite(flight.etaSeconds) ? ` hits in ${flight.etaSeconds}s` : ''}${Number.isFinite(flight.bearing) ? `, bearing ${flight.bearing}` : ''}.${edgeNote(player)}`;
	}
	return null;
}
// A dodge or a fight is chosen from the danger line alone; the edge beside the body is what turns a hit into a fall.
// LivingEntity.knockback(0.4): about 0.4 blocks/tick away from the hitter and 0.4 up, so the body leaves the ground
// (sneak's edge stop only holds a grounded body) and carries about 3 blocks. Fall damage is the drop minus 3, unarmoured.
export function edgeNote(player) {
	return dropNote(player) + standNote(player);
}
function dropNote(player) {
	const footing = player?.footing;
	// A drop within knockback reach but not beside the feet carries its distance.
	const where = Number.isFinite(footing?.distance) && footing.distance > 0 ? `${footing.distance} blocks from you` : 'beside you';
	if (footing?.into === 'void' && Number.isFinite(footing.yaw)) return ` Void edge ${where} at yaw ${footing.yaw}.`;
	if (Number.isFinite(footing?.drop) && footing.drop >= 4 && footing.into !== 'water' && Number.isFinite(footing.yaw)) {
		const plus = footing.atLeast === true ? '+' : '';
		const landing = footing.into === 'lava' ? ' into lava' : `, a fall costs ~${footing.drop - 3}${plus} HP${Number.isFinite(player.health) ? ` of your ${Math.round(player.health)}` : ''}`;
		return ` Open drop ${footing.drop}${plus} blocks ${where} at yaw ${footing.yaw}${landing}. A hit knocks you about 3 blocks away from the hitter, airborne, so sneaking does not hold the edge; a solid block on that side stops the push.`;
	}
	if (player?.dropAhead?.into === 'void' && Number.isFinite(player.dropAhead.at)) return ` Void ${player.dropAhead.at} blocks ahead.`;
	return '';
}
// Shooters whose volleys a roof and walls stop; a covered stand is news only against them or off a push-safe cell.
const RANGED_THREAT = /^minecraft:(blaze|ghast|skeleton|stray|bogged|pillager|piglin)$/;
/**
 * FightingPosition (mod): the nearest seen cell with no open drop within a hit's push, and the nearest such cell with a
 * roof and 2+ full-block walls. Runs d9-nether-d, d11-nether-a/g were knocked off fortress bridges (one at full health)
 * and every blaze death of 2026-10-21 was spent placing cover one block per turn in the open.
 */
export function standNote(player) {
	const stand = player?.stand;
	if (stand == null || typeof stand !== 'object' || stand.here == null) return '';
	const cell = row => `${row.x},${row.y},${row.z}, ${row.steps} step${row.steps === 1 ? '' : 's'}`;
	const walls = row => `${row.roof ? 'roof' : 'no roof'}, ${row.walls} wall${row.walls === 1 ? '' : 's'}${row.open ? `, open ${row.open}` : ''}`;
	const ranged = asArray(player.threats).some(threat => RANGED_THREAT.test(threat?.type ?? ''));
	const parts = [];
	if (stand.here.pushSafe !== true) {
		parts.push(stand.pushSafe ? `Nearest push-safe stand (no open drop within 3 blocks): ${cell(stand.pushSafe)} (${walls(stand.pushSafe)}).`
			: `No push-safe stand within ${stand.searchedSteps ?? 12} steps of seen footing.`);
	}
	if (stand.covered && (ranged || stand.here.pushSafe !== true) && !(stand.pushSafe && stand.pushSafe.x === stand.covered.x && stand.pushSafe.y === stand.covered.y && stand.pushSafe.z === stand.covered.z)) {
		parts.push(`Nearest roofed push-safe stand: ${cell(stand.covered)} (${walls(stand.covered)}); shots reach it only through open sides.`);
	}
	return parts.length ? ` ${parts.join(' ')}` : '';
}
function dangerDecisionInstruction(trigger) {
	if (trigger === 'threat') {
		return 'Live Minecraft event: threat, see player.threats. fight_target and flee_from work while the program awaits you.';
	}
	if (trigger === 'suffocation') return 'Live Minecraft event: suffocation. Facts below are fresh; the program awaits your reply.';
	if (trigger === 'fall') return 'Live Minecraft event: fall danger. Facts below are fresh; the program awaits your reply.';
	if (trigger === 'defensive_handler_completed') return 'Live Minecraft event: defensive handler finished; result and fresh facts below. The program awaits your reply.';
	return 'Live Minecraft event: danger. Facts below are fresh; the program awaits your reply.';
}
// Urgent facts that wake an agent with no task: the body is still the model's to defend.
const NO_TASK_WAKE_TRIGGERS = new Set(['damage', 'threat', 'lava', LAVA_FLOW_TRIGGER, 'fire', 'suffocation', 'drowning', 'fall', 'low_health', 'low_health_food', 'cloud', 'projectile']);
// With no task, a danger-woken turn may defend the body only: these mirror Minecraft's own detached-action allowlist
// (AgentLifecycleReducer.isSelfPreservationAction). Everything else is a player request and needs takeTask.
const SELF_PRESERVATION_ACTIONS = new Set(['fight_target', 'flee_from', 'attack', 'use_ranged', 'block_with_shield', 'use_item',
	'select_item', 'select_tool', 'equip_item', 'navigate_to', 'travel_to', 'move_to', 'look_at', 'control', 'control_sequence', 'wait', 'dismount', 'wake_up']);
const SELF_PRESERVATION_READ_TOOLS = new Set(['observe', 'inspect', 'capabilities', 'action_status', 'cancel_action', 'lookAround']);
// Getting food is self-preservation too: picking up drops, and breaking only blocks that are food (Minecraft checks the
// block really is the expected one before breaking it, so these ids bound what a no-task agent can break).
// Minecraft also checks the live target: crops fully grown, berries ripe, a picked-up stack edible.
export const FOOD_PLANT_BLOCKS = Object.freeze(['minecraft:wheat', 'minecraft:carrots', 'minecraft:potatoes', 'minecraft:beetroots', 'minecraft:melon']);
// Berries are picked by right-click, as in vanilla.
export const FOOD_BERRY_BLOCKS = Object.freeze(['minecraft:sweet_berry_bush', 'minecraft:cave_vines', 'minecraft:cave_vines_plant']);
const releasedInput = (frame) => frame?.attack === false && frame?.use === false;
function isSelfPreservationAction(action) {
	// Raw input may move and aim, but attack/use (which could break, place or open anything) goes through
	// fight_target, attack and use_item.
	if (action?.actionType === 'control') return releasedInput(action.arguments);
	if (action?.actionType === 'control_sequence') return Array.isArray(action.arguments?.frames) && action.arguments.frames.every(releasedInput);
	if (SELF_PRESERVATION_ACTIONS.has(action?.actionType) || ['pick_up_item', 'interact_block'].includes(action?.actionType)) return true;
	return action?.actionType === 'break_block' && FOOD_PLANT_BLOCKS.includes(action.arguments?.expectedBlockId);
}
function isConfirmationContextTool(tool) {
	return isSelfPreservationTool(tool)
		|| ['query_memory', 'program_status'].includes(tool.kind)
		|| (tool.kind === 'task_plan' && tool.operation === 'read')
		|| (tool.kind === 'task_memory' && tool.operation === 'query')
		|| (tool.kind === 'action' && tool.actionType === 'chat');
}
export function isSelfPreservationTool(tool) {
	if (SELF_PRESERVATION_READ_TOOLS.has(tool?.kind)) return true;
	if (['action', 'start_action', 'replace_action'].includes(tool?.kind)) return isSelfPreservationAction(tool);
	if (tool?.kind === 'sequence') return Array.isArray(tool.actions) && tool.actions.every((action) => isSelfPreservationAction(action));
	return false;
}

// Passive animals that drop food, and dropped items worth picking up to eat.
const FOOD_ANIMALS = new Set(['minecraft:cow', 'minecraft:mooshroom', 'minecraft:pig', 'minecraft:sheep', 'minecraft:chicken', 'minecraft:rabbit',
	'minecraft:cod', 'minecraft:salmon', 'minecraft:hoglin']);
const FOOD_ITEM = /^minecraft:(?:cooked_)?(?:beef|porkchop|mutton|chicken|rabbit|cod|salmon)$|^minecraft:(?:apple|golden_apple|enchanted_golden_apple|bread|carrot|golden_carrot|potato|baked_potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|mushroom_stew|rabbit_stew|beetroot_soup|dried_kelp)$/;
const RIPE_AGE = { 'minecraft:wheat': 7, 'minecraft:carrots': 7, 'minecraft:potatoes': 7, 'minecraft:beetroots': 3, 'minecraft:sweet_berry_bush': 2 };
const LOW_HEALTH_FRACTION = 0.5;
const LOW_HEALTH_POINTS = 6;
const RECOVERED_FRACTION = 0.7;
// Starving on Hard drains one point at a time; only a real further drop wakes again.
const FURTHER_DROP_POINTS = 2;
const REGENERATING_FOOD_LEVEL = 18;
// With a task, low health and food in reach gets one urgent nudge at 4 hearts (or 40%), then again only after 2+ more
// health is lost or new food comes into reach, never more often than every 10 s.
const HEAL_NUDGE_POINTS = 8;
const HEAL_NUDGE_FRACTION = 0.4;
const HEAL_NUDGE_INTERVAL_MS = 10_000;
const MAX_SEEN_FOOD = 64;
// Events that carry healing facts (and options) even when the caller passed none.
const HEALING_EVENT_TRIGGERS = new Set(['low_health_food', 'low_health_idle', 'heal_opportunity', 'low_health', 'fire', 'lava']);

/**
 * Whether low health should wake an agent with no task, and the health level to remember. One wake per level: it
 * rearms only after the agent recovers to 70% or loses 2+ more health. Takeover, creative/spectator and death never
 * wake, nor does a body that is already regenerating (food bar 18+) with no food carried or in view to add.
 * `health: null` clears the memory.
 */
export function lowHealthWake(observation, wokenAtHealth = null) {
	const player = observation?.player;
	const health = Number.isFinite(player?.health) ? player.health : null;
	if (health === null || player.dead === true || health <= 0) return { wake: false, health: wokenAtHealth };
	const maxHealth = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 20;
	if (health >= maxHealth * RECOVERED_FRACTION) return { wake: false, health: null };
	const low = health <= Math.max(LOW_HEALTH_POINTS, maxHealth * LOW_HEALTH_FRACTION);
	if (!low || player.operatorControlled === true || ['creative', 'spectator'].includes(player.gameMode)) return { wake: false, health: wokenAtHealth };
	if (wokenAtHealth !== null && health > wokenAtHealth - FURTHER_DROP_POINTS) return { wake: false, health: wokenAtHealth };
	const facts = healingFacts(observation);
	const nothingToEat = facts.bestFood === null && Object.values(facts.foodSources).every((rows) => rows.length === 0);
	if (nothingToEat && facts.naturalRegen === true) return { wake: false, health: wokenAtHealth };
	return { wake: true, health };
}

/** A low body that is ours to wake: alive, survival or adventure, not taken over, at or below the given level. */
function lowEligibleBody(player, points, fraction) {
	const health = Number.isFinite(player?.health) ? player.health : null;
	if (health === null || player.dead === true || health <= 0 || player.operatorControlled === true || ['creative', 'spectator'].includes(player.gameMode)) return false;
	const maxHealth = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 20;
	return health <= Math.max(points, maxHealth * fraction);
}

/** Stable keys of the food in reach: carried best food, then drops, animals and ripe plants in view. */
export function foodSourceKeys(facts) {
	const sources = facts?.foodSources ?? {};
	return [
		...(carriedFoodToEat(facts)?.itemId ? [`carried:${carriedFoodToEat(facts).itemId}`] : []),
		...(sources.drops ?? []).map((drop) => `drop:${drop.stableId}`),
		...(sources.animals ?? []).map((animal) => `animal:${animal.stableId}`),
		...(sources.plants ?? []).filter((plant) => plant.ripe !== false).map((plant) => `plant:${plant.x},${plant.y},${plant.z}`),
	];
}

/**
 * The carried food that can be eaten right now: the server's healFood (best safe food edible at this hunger, sent when it
 * differs from bestFood), else bestFood when it is edible now. Steak at full hunger cannot start eating; a golden apple can.
 */
export function carriedFoodToEat(facts) {
	if (facts?.healFood?.itemId) return facts.healFood;
	const food = facts?.bestFood;
	if (!food?.itemId) return null;
	return food.alwaysEdible === true || !(Number.isFinite(facts.foodLevel) && facts.foodLevel >= 20) ? food : null;
}

function canEatNow(facts) {
	return !(Number.isFinite(facts?.foodLevel) && facts.foodLevel >= 20) || facts?.canEat === true;
}

function rememberFood(seen, keys) {
	return [...new Set([...seen, ...keys])].slice(-MAX_SEEN_FOOD);
}

/**
 * The no-task heal wake (lowHealthWake) plus food that comes into reach after it: a drop thrown to the agent or an
 * animal walking up is a chance the model has not seen yet, so it wakes once more for each new source while still low.
 * `latch` is { health, seenFood } or null; the result's latch is null once the body recovered.
 */
export function healWakeVerdict(observation, latch = null) {
	const verdict = lowHealthWake(observation, latch?.health ?? null);
	if (verdict.health === null) return { wake: false, latch: null };
	const facts = healingFacts(observation);
	const keys = foodSourceKeys(facts);
	const seen = latch?.seenFood ?? [];
	const fresh = keys.some((key) => !seen.includes(key));
	const wake = verdict.wake || (latch !== null && fresh && canEatNow(facts) && lowEligibleBody(observation.player, LOW_HEALTH_POINTS, LOW_HEALTH_FRACTION));
	return { wake, latch: { health: verdict.health, seenFood: rememberFood(seen, keys) } };
}

/**
 * With a task: whether low health with reachable food should raise one urgent attention edge. Fires at 4 hearts
 * (or 40%) while safe and able to eat, then again only after 2+ more health is lost or new food comes into reach,
 * at most every 10 s; recovering to 70% resets it. `latch` is { health, seenFood, atMs } or null.
 */
export function healNudgeVerdict(observation, latch = null, nowMs = null) {
	const player = observation?.player ?? {};
	const maxHealth = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 20;
	if (Number.isFinite(player.health) && player.health >= maxHealth * RECOVERED_FRACTION) return { nudge: false, latch: null };
	if (!lowEligibleBody(player, HEAL_NUDGE_POINTS, HEAL_NUDGE_FRACTION) || player.safe === false) return { nudge: false, latch };
	const facts = healingFacts(observation);
	const keys = foodSourceKeys(facts);
	if (keys.length === 0 || !canEatNow(facts)) return { nudge: false, latch };
	// Only food that changes what the agent can eat right now repeats the nudge: carried food or a new drop. Animals
	// and crops passing by while walking are already in the first nudge's options and would repeat it every 10 s.
	const ownKeys = keys.filter((key) => key.startsWith('carried:') || key.startsWith('drop:'));
	const seen = latch?.seenFood ?? [];
	const lower = latch === null || player.health <= latch.health - FURTHER_DROP_POINTS;
	const fresh = ownKeys.some((key) => !seen.includes(key));
	const spaced = latch === null || !Number.isFinite(nowMs) || !Number.isFinite(latch.atMs) || nowMs - latch.atMs >= HEAL_NUDGE_INTERVAL_MS;
	if (!(lower || fresh) || !spaced) return { nudge: false, latch: latch === null ? null : { ...latch, seenFood: rememberFood(seen, ownKeys) } };
	return { nudge: true, options: facts.options.length, latch: { health: player.health, seenFood: rememberFood(seen, ownKeys), atMs: nowMs } };
}

/**
 * Concrete ways to get food now, nearest first, as the native calls that do it. They are facts about reach, not a plan:
 * the model chooses whether and which.
 */
export function healingOptions(facts) {
	const options = [];
	const away = (distance) => (Number.isFinite(distance) ? ` ${distance} blocks away` : '');
	const carried = carriedFoodToEat(facts);
	if (carried) options.push(carried.slot <= 8
		? `eat carried ${carried.itemId}: control use:true,ticks:40,selectedSlot:${carried.slot}`
		: `eat carried ${carried.itemId}: select_item, then use_item durationMs:2000`);
	for (const drop of facts.foodSources.drops.slice(0, 2)) options.push(`pick up ${drop.count ?? 1}x ${drop.itemId}${away(drop.distance)}: pick_up_item targetSelector ${drop.stableId}, then eat it`);
	for (const animal of facts.foodSources.animals.slice(0, 1)) options.push(`hunt ${animal.type}${away(animal.distance)}: fight_target targetId ${animal.stableId}, pick_up_item its drop, eat it`);
	for (const plant of facts.foodSources.plants.filter((row) => row.ripe !== false).slice(0, 1)) {
		options.push(`harvest ${plant.blockId} at ${plant.x},${plant.y},${plant.z}${away(plant.distance)}: ${plant.harvest === 'interact' ? 'interact_block' : 'break_block'}, pick up, eat`);
	}
	return options;
}

/**
 * Reference to the approaching threat that reaches contact range soonest. Its ETA and risks remain in player.threats.
 * Null when nothing approaches.
 */
export function threatOutlook(observation) {
	const threats = Array.isArray(observation?.player?.threats) ? observation.player.threats : [];
	const soonest = threats.filter((threat) => threat?.approaching === true && Number.isFinite(threat.etaSeconds))
		.sort((left, right) => left.etaSeconds - right.etaSeconds)[0];
	if (soonest === undefined) return null;
	if (typeof soonest.uuid === 'string' && soonest.uuid.length > 0) return { soonestContact: soonest.uuid };
	const then = Number.isFinite(soonest.contactRisk) ? `, about ${soonest.contactRisk} there` : '';
	return `${soonest.type} ${soonest.uuid} is ${soonest.distance} blocks away closing at ${soonest.closingSpeed} blocks/s: contact range in ${soonest.etaSeconds} s (risk ${soonest.risk} now${then}).`;
}

/**
 * Whether health regenerates on its own, as vanilla decides it: never with the naturalRegeneration gamerule off; in
 * Peaceful at any food level; otherwise only while the food bar is 18 or more. Null when the food level is unknown.
 */
export function naturalRegeneration(player, world) {
	if (world?.naturalRegeneration === false) return false;
	if (world?.difficulty === 'peaceful') return true;
	return Number.isFinite(player?.foodLevel) ? player.foodLevel >= REGENERATING_FOOD_LEVEL : null;
}

// Upper bound at the current food/saturation, not promised recovery: saturation is spent by healing and damage can
// outpace it. Peaceful has an additional player regeneration path, so leave that rate unknown here.
function regenerationRateMax(player, world) {
	const enabled = naturalRegeneration(player, world);
	if (enabled === false) return 0;
	if (enabled === null || world?.difficulty === 'peaceful') return null;
	if (player.foodLevel < 20) return 0.25;
	if (!Number.isFinite(player.saturation)) return null;
	return player.saturation > 0 ? Math.ceil(Math.min(player.saturation, 6) / 3 * 1000) / 1000 : 0.25;
}

function compactHealingForEvent(source, hazardContact) {
	if (source == null) return source;
	if (hazardContact) {
		const { foodLevel, saturation, naturalRegen, bestFood, healFood, burn, canEat } = source;
		return { foodLevel, saturation, naturalRegen, bestFood, ...(healFood === undefined ? {} : { healFood }), burn, canEat };
	}
	const { foodSources, options, ...facts } = source;
	return { ...facts,
		...(foodSources && Object.values(foodSources).some(rows => rows.length > 0) ? { foodSources } : {}),
		...(hazardContact || options === undefined ? {} : { options }),
	};
}

/** The facts a no-task low-health turn needs: health, hunger, carried food and the nearest food sources in view. */
export function healingFacts(observation) {
	const player = observation?.player ?? {};
	const list = (value) => (Array.isArray(value) ? value : []);
	const at = (row) => (['x', 'y', 'z'].every((axis) => Number.isFinite(row?.[axis]) && Number.isFinite(player[axis]))
		? Math.round(Math.hypot(row.x - player.x, row.y - player.y, row.z - player.z) * 10) / 10 : null);
	const nearest = (rows, limit) => rows.map(({ source, ...row }) => ({ ...row, distance: Number.isFinite(source?.distance) ? source.distance : at(source) }))
		.sort((left, right) => (left.distance ?? Infinity) - (right.distance ?? Infinity)).slice(0, limit);
	const animals = list(observation?.entities).filter((entity) => FOOD_ANIMALS.has(entity?.type) && entity.alive !== false)
		.map((entity) => ({ stableId: entity.stableId, type: entity.type, source: entity }));
	const plants = list(observation?.blocks).filter((block) => FOOD_PLANT_BLOCKS.includes(block?.blockId) || FOOD_BERRY_BLOCKS.includes(block?.blockId)).map((block) => {
		const age = Number(block.state?.age);
		const ripe = block.blockId in RIPE_AGE ? (Number.isFinite(age) ? age >= RIPE_AGE[block.blockId] : null)
			: block.blockId.startsWith('minecraft:cave_vines') ? (block.state?.berries === undefined ? null : String(block.state.berries) === 'true') : true;
		return { x: block.x, y: block.y, z: block.z, blockId: block.blockId, harvest: FOOD_BERRY_BLOCKS.includes(block.blockId) ? 'interact' : 'mine', ...(ripe === null ? {} : { ripe }), source: block };
	});
	const drops = list(observation?.items).filter((item) => FOOD_ITEM.test(item?.itemId ?? ''))
		.map((item) => ({ stableId: item.stableId, itemId: item.itemId, count: item.count, source: item }));
	const facts = {
		health: player.health ?? null, maxHealth: player.maxHealth ?? 20, foodLevel: player.foodLevel ?? null, saturation: player.saturation ?? null,
		naturalRegen: naturalRegeneration(player, observation?.world),
		regenHPPerSecondMax: regenerationRateMax(player, observation?.world),
		canEat: typeof player.canEat === 'boolean' ? player.canEat : !player.bestFood ? false : player.bestFood.alwaysEdible === true ? true
			: Number.isFinite(player.foodLevel) ? player.foodLevel < 20 : null,
		bestFood: player.bestFood ?? null, ...(player.healFood ? { healFood: player.healFood } : {}),
		safe: player.safe ?? null, threats: list(player.threats).length,
		foodSources: { animals: nearest(animals, 4), plants: nearest(plants, 4), drops: nearest(drops, 4) },
	};
	const burn = burnFacts(player);
	return { ...facts, ...(burn === null ? {} : { burn }), options: healingOptions(facts) };
}

/**
 * Burn left and its raw cost: on_fire deals 1 HP each second through armour (Resistance and Fire Protection still
 * reduce it; lava itself hurts about 8 HP/s while the body stays in it). Null when not burning.
 */
export function burnFacts(player) {
	if (!(Number.isFinite(player?.fireTicks) && player.fireTicks > 0)) return null;
	const seconds = Math.ceil(player.fireTicks / 20);
	const resistance = Array.isArray(player.effects) ? player.effects.find((effect) => effect?.effectId === 'minecraft:fire_resistance') : null;
	const protectedTicks = resistance == null ? 0 : Number.isFinite(resistance.duration) && resistance.duration >= 0 ? resistance.duration : Infinity;
	return { seconds, rawDamage: Math.floor(Math.max(0, player.fireTicks - protectedTicks) / 20) };
}
export const NO_TASK_HEAL_INSTRUCTION = 'Live Minecraft event: low health. You have no active task; any finished task stays finished, so do not redo it. Recovering is your call. healing.regenFoodReady reports hunger eligibility under vanilla rules; damage may outpace recovery. healing.options lists the food in reach as exact calls: eat carried food, pick_up_item a food drop, fight_target a passive animal and pick up its drop, mine fully grown crops or melon, or interact with ripe berries; then eat. Other work is a player request and needs takeTask.';
export const TASK_HEAL_INSTRUCTION = 'Live Minecraft event: low health with food in reach. Whether to recover before continuing the task is your call. healing.regenFoodReady reports hunger eligibility under vanilla rules; damage may outpace recovery. healing.options lists the food in reach as exact calls (eat carried food; pick_up_item a food drop; fight_target a passive animal and pick up its drop). Respond explicitly to pending program decisions.';
export const NO_TASK_DANGER_INSTRUCTION = 'Live Minecraft event: danger. You have no active task; any finished task stays finished, so do not redo it. Options include: fight_target, flee_from, eat or drink, shield or totem, equip armor and weapons, move away. Other work is a player request and needs takeTask.';
// Waiting for the operator only means "do not redo the finished work or re-run finish"; it never blocks new requests.
export const AWAITING_CONFIRMATION_EVENT_INSTRUCTION = 'Live Minecraft event. Your finished goal awaits operator confirmation: do not redo it or re-run finish. You still own your body: defend, flee, escape lava/fire, breathe, eat or equip as needed without operator permission; this leaves confirmation pending. Only operator:true direct/voice requests may change work; other messages supply facts or invite replies. After handling a new operator request, call finish again.';
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TASK_REQUEST_TIMEOUT_MS = 10_000;
const MINIMAL_TASK_MEMORY_BYTES = 2_048;
const MINIMAL_RECEIPTS = 2;
const MINIMAL_OBSERVATION_FIELDS = new Set(['observedAtEpochMs', 'eventSequence', 'freshness', 'ready', 'status', 'player', 'inventory', 'sighted', 'leftBehind', 'currentAction', 'lastResult', 'death', 'deathScreen', 'recovery', 'failureClass', 'continuity', 'resultCoverage']);

function fitsWithOldestMessage(payload, budgetBytes) {
	const probe = { ...payload, conversation: { ...payload.conversation, entries: payload.conversation.entries.slice(0, 1) } };
	return Buffer.byteLength(JSON.stringify(probe), 'utf8') <= budgetBytes;
}

// Core facts only: where the agent is, what it holds and what just happened.
// contextTrimmed lists what was dropped, largest first with original byte sizes,
// so the model can look it up again and traces show which context outgrew the budget.
function minimalEventContext(payload) {
	const observation = payload.observation ?? {};
	const sizes = {};
	const minimalObservation = {};
	for (const [key, value] of Object.entries(observation)) {
		if (key === 'world') minimalObservation.world = compactWorldForEvent(value);
		else if (MINIMAL_OBSERVATION_FIELDS.has(key)) minimalObservation[key] = value;
		else sizes[`observation.${key}`] = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
	}
	if (observation.inventory !== undefined) {
		minimalObservation.inventory = { ...observation.inventory, items: asArray(observation.inventory.items).slice(0, 8) };
	}
	// Omission counts must describe the rows this event keeps; dropped sections keep zero rows.
	if (minimalObservation.resultCoverage !== undefined) {
		minimalObservation.resultCoverage = retainedEventCoverage(minimalObservation.resultCoverage, Object.fromEntries(Object.keys(minimalObservation.resultCoverage)
			.map((section) => [section, asArray(section === 'inventory' ? minimalObservation.inventory?.items : minimalObservation[section]).length])));
	}
	const result = { observation: minimalObservation };
	if (payload.taskMemory !== undefined) {
		const encoded = JSON.stringify(payload.taskMemory);
		const bytes = Buffer.byteLength(encoded, 'utf8');
		if (bytes > MINIMAL_TASK_MEMORY_BYTES) {
			sizes.taskMemory = bytes;
			result.taskMemory = { truncated: true, excerpt: truncateUtf8(encoded, MINIMAL_TASK_MEMORY_BYTES) };
		}
	}
	const programResult = payload.program?.result;
	if (Array.isArray(programResult?.receipts) && programResult.receipts.length > MINIMAL_RECEIPTS) {
		sizes['program.result.receipts'] = Buffer.byteLength(JSON.stringify(programResult.receipts), 'utf8');
		result.program = { ...payload.program, result: { ...programResult, receipts: programResult.receipts.slice(-MINIMAL_RECEIPTS), omittedReceipts: (programResult.omittedReceipts ?? 0) + programResult.receipts.length - MINIMAL_RECEIPTS } };
	}
	result.contextTrimmed = Object.fromEntries(Object.entries(sizes).sort(([, left], [, right]) => right - left).slice(0, 12));
	return result;
}

function truncateUtf8(text, maxBytes) {
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1;
	// Never end on the first half of a surrogate pair.
	if (end > 0 && end < text.length) {
		const code = text.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	return text.slice(0, end);
}

function boundedEventArray(value, limit, preserve = null) {
	const source = asArray(value);
	const retained = source.slice(0, limit);
	if (retained.length >= source.length || typeof preserve !== 'function') return { values: retained, omitted: source.length - retained.length };
	let replacement = retained.length - 1;
	for (let index = retained.length; index < source.length && replacement >= 0; index++) {
		if (!preserve(source[index])) continue;
		while (replacement >= 0 && preserve(retained[replacement])) replacement -= 1;
		if (replacement < 0) break;
		retained[replacement] = source[index];
		replacement -= 1;
	}
	return { values: retained, omitted: source.length - retained.length };
}

function eventArrayCoverage(source, retained) {
	return { availableInSnapshot: source.length, ...(source.length <= retained.length ? {} : { omitted: source.length - retained.length }) };
}

function compactEventObservationForBudget(observation) {
	const inventoryRows = boundedEventArray(compactEventRows(observation.inventory?.items), 16, isHazardousEventFact);
	const itemRows = boundedEventArray(compactEventRows(observation.items), 8, isHazardousEventFact);
	const entityRows = boundedEventArray(compactEventRows(observation.entities), 8, isHazardousEventFact);
	const blockRows = boundedEventArray(compactEventRows(observation.blocks), 12, isHazardousEventFact);
	const landmarkRows = Array.isArray(observation.landmarks)
		? boundedEventArray(compactEventRows(observation.landmarks), 12, isHazardousEventFact)
		: null;
	const nearbyContainerRows = Array.isArray(observation.nearbyContainers)
		? boundedEventArray(compactEventRows(observation.nearbyContainers), 8, isHazardousEventFact)
		: null;
	const optionRows = Array.isArray(observation.options)
		? boundedEventArray(compactEventRows(observation.options), 2)
		: null;
	const resultCoverage = retainedEventCoverage(observation.resultCoverage, {
		inventory: inventoryRows.values.length,
		items: itemRows.values.length,
		entities: entityRows.values.length,
		blocks: blockRows.values.length,
		...(landmarkRows === null ? {} : { landmarks: landmarkRows.values.length }),
		...(nearbyContainerRows === null ? {} : { nearbyContainers: nearbyContainerRows.values.length }),
		...(optionRows === null ? {} : { options: optionRows.values.length }),
	});
	return {
		...observation,
		inventory: { ...observation.inventory, items: inventoryRows.values },
		items: itemRows.values,
		entities: entityRows.values,
		...compactBlockOmissions(blockRows.values),
		...(observation.blockDefaults === undefined ? {} : { blockDefaults: observation.blockDefaults }), ...(observation.blockTags === undefined ? {} : { blockTags: retainedBlockTags(observation.blockTags, [...blockRows.values, ...(landmarkRows?.values ?? [])]) }),
		...(landmarkRows === null ? {} : { landmarks: landmarkRows.values }),
		...(nearbyContainerRows === null ? {} : { nearbyContainers: nearbyContainerRows.values }),
		...(optionRows === null ? {} : { options: optionRows.values }),
		...(observation.world === undefined ? {} : { world: compactWorldForEvent(observation.world) }),
		...(observation.lastResult === undefined ? {} : { lastResult: compactLastResultForEvent(observation.lastResult) }),
		...(observation.recovery === undefined ? {} : { recovery: compactRecoveryForEvent(observation.recovery) }),
		...(observation.coverage === undefined ? {} : { coverage: compactCoverageForEvent(observation.coverage) }),
		...(observation.perception === undefined ? {} : { perception: compactPerceptionForEvent(observation.perception) }),
		resultCoverage,
	};
}

function compactPlanningDueObservation(observation) {
	const inventoryRows = boundedEventArray(compactEventRows(observation.inventory?.items), 8, isHazardousEventFact);
	const itemRows = boundedEventArray(compactEventRows(observation.items), 4, isHazardousEventFact);
	const entityRows = boundedEventArray(compactEventRows(observation.entities), 4, isHazardousEventFact);
	const blockRows = boundedEventArray(compactEventRows(observation.blocks), 8, isHazardousEventFact);
	const resultCoverage = retainedEventCoverage(observation.resultCoverage, {
		inventory: inventoryRows.values.length,
		items: itemRows.values.length,
		entities: entityRows.values.length,
		blocks: blockRows.values.length,
		landmarks: 0,
		nearbyContainers: 0,
		options: 0,
	});
	const metadata = Object.fromEntries(['observedAtEpochMs', 'eventSequence', 'freshness', 'coverage', 'ready', 'status', 'velocity', 'perception']
		.filter((field) => observation[field] !== undefined)
		.map((field) => [field, observation[field]]));
	return {
		...metadata,
		player: observation.player ?? {},
		inventory: { ...observation.inventory, items: inventoryRows.values },
		items: itemRows.values,
		entities: entityRows.values,
		...compactBlockOmissions(blockRows.values),
		...(observation.blockDefaults === undefined ? {} : { blockDefaults: observation.blockDefaults }), ...(observation.blockTags === undefined ? {} : { blockTags: retainedBlockTags(observation.blockTags, blockRows.values) }),
		...(observation.sighted === undefined ? {} : { sighted: observation.sighted }),
		...(observation.furnaces === undefined ? {} : { furnaces: observation.furnaces }),
		...(observation.toolBroke === undefined ? {} : { toolBroke: observation.toolBroke }),
		...(observation.leftBehind === undefined ? {} : { leftBehind: observation.leftBehind }),
		...(observation.recentlySeen === undefined ? {} : { recentlySeen: observation.recentlySeen }),
		...(observation.world === undefined ? {} : { world: compactWorldForEvent(observation.world) }),
		...(observation.currentAction === undefined ? {} : { currentAction: observation.currentAction }),
		...(observation.lastResult === undefined ? {} : { lastResult: compactLastResultForEvent(observation.lastResult) }),
		...(observation.interaction === undefined ? {} : { interaction: observation.interaction }),
		...(observation.death === undefined ? {} : { death: observation.death }),
		...(observation.deathScreen === undefined ? {} : { deathScreen: observation.deathScreen }),
		...(observation.recovery === undefined ? {} : { recovery: compactRecoveryForEvent(observation.recovery) }),
		...(observation.failureClass === undefined ? {} : { failureClass: observation.failureClass }),
		...(observation.continuity === undefined ? {} : { continuity: observation.continuity }),
		...(observation.lastLiveInventory === undefined ? {} : { lastLiveInventory: observation.lastLiveInventory }),
		resultCoverage,
	};
}

function retainedEventCoverage(coverage, retainedCounts) {
	if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) return coverage;
	return Object.fromEntries(Object.entries(coverage).map(([section, detail]) => {
		if (detail === null || typeof detail !== 'object' || retainedCounts[section] === undefined) return [section, detail];
		const available = Number.isSafeInteger(detail.availableInSnapshot) ? detail.availableInSnapshot : detail.retained;
		const retained = retainedCounts[section];
		const { retained: previousRetained, omitted: previousOmitted, ...facts } = detail;
		return [section, { ...facts, ...(available <= retained ? {} : { omitted: available - retained }) }];
	}));
}

const COMPACT_EVENT_ROW_FIELDS = ['uuid', 'stableId', 'type', 'name', 'position', 'x', 'y', 'z', 'distance', 'blockId', 'itemId', 'count', 'slot', 'tags', 'velocity', 'bounds', 'pickable', 'parentId', 'partName', 'state', 'bearing', 'elevation', 'id', 'feasible', 'moveTo', 'reason', 'cause', 'hazard', 'damage', 'maxDamage', 'usesLeft', 'fingerprint', 'hotbar', 'displayName', 'maxStackSize', 'hostile', 'alive', 'health', 'maxHealth', 'targetingAgent', 'swelling', 'fuse', 'appearance', 'perceivedBy', 'potentialRisk', 'risk', 'expectedHitDamage', 'blastDamageIfBroken', 'withinInteractionRange', 'capabilities'];

// Two item row fields usually follow from the row itself: displayName is the item id in title case ("minecraft:oak_planks"
// is "Oak Planks") and hotbar is true exactly for numbered slots 0-8. Matching values are left out of the finished event and
// the rule is stated once; any other value (a renamed stack, "Raw Porkchop" for porkchop) stays on its row. This runs after
// every budget decision, so what the event keeps is unchanged, and only when the encoded event gets smaller: never grows.
export const EVENT_ITEM_DEFAULTS = 'Omitted item fields: displayName = itemId path in title case; hotbar = slot 0-8.';
function defaultItemName(itemId) {
	return itemId.slice(itemId.indexOf(':') + 1).split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
function withoutDefaultItemFields(rows) {
	if (!Array.isArray(rows)) return rows;
	return rows.map((row) => {
		if (row === null || typeof row !== 'object' || Array.isArray(row) || typeof row.itemId !== 'string') return row;
		const { displayName, hotbar, ...rest } = row;
		return {
			...rest,
			...(displayName === undefined || displayName === defaultItemName(row.itemId) ? {} : { displayName }),
			...(hotbar === undefined || hotbar === (Number.isInteger(row.slot) && row.slot >= 0 && row.slot < 9) ? {} : { hotbar }),
		};
	});
}
function withItemDefaults(json) {
	const payload = JSON.parse(json);
	const observation = payload?.observation;
	if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) return json;
	const items = withoutDefaultItemFields(observation.items);
	const compact = {
		...payload,
		observation: Object.fromEntries(Object.entries(observation).flatMap(([key, value]) => {
			if (key === 'inventory' && value !== null && typeof value === 'object' && Array.isArray(value.items)) return [[key, { ...value, items: withoutDefaultItemFields(value.items) }]];
			if (key === 'items') return [[key, items], ['itemDefaults', EVENT_ITEM_DEFAULTS]];
			return [[key, value]];
		})),
	};
	if (compact.observation.itemDefaults === undefined) compact.observation.itemDefaults = EVENT_ITEM_DEFAULTS;
	const encodedBytes = (value) => Buffer.byteLength(JSON.stringify(encodeModelFacts(value)), 'utf8');
	const compactJson = JSON.stringify(compact);
	return encodedBytes(compact) < encodedBytes(payload) && compactJson.length < json.length ? compactJson : json;
}

// Blocks are about half of every event. Most rows repeat values that follow from the row itself.
export const EVENT_BLOCK_DEFAULTS = 'Omitted block fields mean: stableId "x,y,z", bounds one full cube, state {}, tags from blockTags[blockId].';
// Only these exact generation-only tags are omitted. Spawn floors, mob interactions and
// player-triggered growth are gameplay facts; unknown and datapack tags remain visible.
const WORLDGEN_BLOCK_TAGS = new Set([
	'#minecraft:overworld_carver_replaceables',
	'#minecraft:nether_carver_replaceables',
	'#minecraft:sculk_replaceable_world_gen',
	'#minecraft:stone_ore_replaceables',
	'#minecraft:geode_invalid_blocks',
	'#minecraft:lava_pool_stone_cannot_replace',
	'#minecraft:ice_spike_replaceable',
	'#minecraft:trail_ruins_replaceable',
	'#minecraft:forest_rock_can_place_on',
]);
function playerBlockTags(row) {
	if (row === null || typeof row !== 'object' || !Array.isArray(row.tags)) return row;
	return { ...row, tags: row.tags.filter((tag) => typeof tag !== 'string' || !WORLDGEN_BLOCK_TAGS.has(tag)) };
}

function compactBlockDefaults(blocks, landmarks) {
	blocks = blocks.map(playerBlockTags);
	landmarks = landmarks?.map(playerBlockTags);
	let omitted = false;
	// Block tags belong to the block type, so each blockId's tags are listed once when every row agrees.
	const tagsById = new Map();
	for (const block of [...blocks, ...(landmarks ?? [])]) {
		if (block === null || typeof block !== 'object' || typeof block.blockId !== 'string' || !Array.isArray(block.tags)) continue;
		const encoded = JSON.stringify(block.tags);
		tagsById.set(block.blockId, tagsById.has(block.blockId) && tagsById.get(block.blockId) !== encoded ? null : encoded);
	}
	const blockTags = Object.fromEntries([...tagsById].filter(([, encoded]) => encoded !== null).map(([blockId, encoded]) => [blockId, JSON.parse(encoded)]));
	const values = blocks.map((block) => {
		if (block === null || typeof block !== 'object' || Array.isArray(block)) return block;
		const compact = { ...block };
		if (Object.hasOwn(blockTags, compact.blockId) && Array.isArray(compact.tags)) { delete compact.tags; omitted = true; }
		if (compact.stableId === `${compact.x},${compact.y},${compact.z}`) { delete compact.stableId; omitted = true; }
		if (isFullCubeBounds(compact.bounds)) { delete compact.bounds; omitted = true; }
		if (compact.state !== null && typeof compact.state === 'object' && !Array.isArray(compact.state) && Object.keys(compact.state).length === 0) { delete compact.state; omitted = true; }
		return compact;
	});
	let landmarkOmitted = false;
	const landmarkValues = landmarks?.map((landmark) => {
		if (landmark === null || typeof landmark !== 'object' || Array.isArray(landmark)) return landmark;
		const compact = { ...landmark };
		if (compact.stableId === `${compact.x},${compact.y},${compact.z}`) { delete compact.stableId; omitted = landmarkOmitted = true; }
		if (Object.hasOwn(blockTags, compact.blockId) && Array.isArray(compact.tags)) { delete compact.tags; omitted = landmarkOmitted = true; }
		return compact;
	});
	const rows = { blocks: values, ...(landmarkValues === undefined ? {} : { landmarks: landmarkValues }), ...(landmarkOmitted ? { landmarkDefaults: 'Omitted landmark stableId means x,y,z; tags come from blockTags[blockId].' } : {}) };
	if (!omitted) return rows;
	return { ...rows, blockDefaults: EVENT_BLOCK_DEFAULTS, ...(Object.keys(blockTags).length === 0 ? {} : { blockTags }) };
}

function compactBlockOmissions(blocks) {
	const omittedFields = blocks[0]?.omittedFields;
	if (!Array.isArray(omittedFields) || blocks.length < 2 || !blocks.every((row) => JSON.stringify(row?.omittedFields) === JSON.stringify(omittedFields))) return { blocks };
	return { blocks: blocks.map(({ omittedFields: _omitted, ...row }) => row), blockOmittedFields: omittedFields };
}

function retainedBlockTags(blockTags, rows) {
	const retained = new Set(rows.map((row) => row?.blockId));
	const kept = Object.fromEntries(Object.entries(blockTags ?? {}).filter(([blockId]) => retained.has(blockId))
		.map(([blockId, tags]) => [blockId, Array.isArray(tags) ? playerBlockTags({ tags }).tags : tags]));
	return Object.keys(kept).length === 0 ? undefined : kept;
}

function isFullCubeBounds(bounds) {
	return Array.isArray(bounds) && bounds.length === 1 && bounds[0] !== null && typeof bounds[0] === 'object'
		&& Object.keys(bounds[0]).length === 6 && bounds[0].minX === 0 && bounds[0].minY === 0 && bounds[0].minZ === 0
		&& bounds[0].maxX === 1 && bounds[0].maxY === 1 && bounds[0].maxZ === 1;
}

function compactEventRows(value) {
	return asArray(value).map((entry) => {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
		const compact = Object.fromEntries(COMPACT_EVENT_ROW_FIELDS.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]]));
		if (Object.keys(compact).length === 0) return entry;
		const omittedFields = [...new Set([...(entry.omittedFields ?? []), ...Object.keys(entry).filter((field) => field !== 'omittedFields' && !COMPACT_EVENT_ROW_FIELDS.includes(field))])];
		return omittedFields.length === 0 ? compact : { ...compact, omittedFields };
	});
}

function isHazardousEventFact(value) {
	if (value === null || typeof value !== 'object') return false;
	if (value.hostile === true && value.alive !== false) return true;
	if (value.targetingAgent === true || value.swelling === true) return true;
	// An active risk (engaging the agent right now) is kept under budget like a hostile.
	if (typeof value.risk === 'number') return true;
	const text = ['blockId', 'itemId', 'type', 'name', 'reason', 'cause', 'hazard'].map((field) => value[field]).filter((field) => typeof field === 'string').join(' ');
	return /lava|fire|magma|cactus|campfire|tnt|creeper|ghast|blaze|wither|warden|dragon|hostile/i.test(text);
}

function compactRecoveryForEvent(recovery) {
	if (recovery === null || typeof recovery !== 'object') return recovery;
	return {
		...(recovery.lastDeath === undefined ? {} : { lastDeath: recovery.lastDeath }),
		...(Array.isArray(recovery.lastLostInventory) ? { lastLostInventory: recovery.lastLostInventory.slice(0, 16) } : {}),
		...(Array.isArray(recovery.alreadyHave) ? { alreadyHave: recovery.alreadyHave.slice(-32) } : {}),
		...(Array.isArray(recovery.doNotRedo) ? { doNotRedo: recovery.doNotRedo.slice(0, 24) } : {}),
		...(typeof recovery.facts === 'string' ? { facts: recovery.facts } : {}),
	};
}

/** A program receipt in a wake: a failed step keeps its code; the program result's own failure explains the end. */
function wakeReceipt(receipt) {
	if (!isFailureResult(receipt)) return receipt;
	const { message: _message, failure: _failure, executionStarted: _started, physicalAttempted: _attempted, repeatedFailure: _repeat, ...rest } = receipt;
	return rest;
}

function compactLastResultForEvent(lastResult) {
	if (lastResult === null || typeof lastResult !== 'object') return lastResult;
	return {
		...(lastResult.state === undefined ? {} : { state: lastResult.state }),
		...(lastResult.reasonCode === undefined ? {} : { reasonCode: lastResult.reasonCode }),
		// The runtime attaches a failure only on its first delivery; a compact wake must not lose it.
		...(lastResult.failure === undefined ? {} : { failure: lastResult.failure }),
	};
}

function compactWorldForEvent(world) {
	if (world === null || typeof world !== 'object') return world;
	return {
		...(world.worldId === undefined ? {} : { worldId: world.worldId }),
		...(world.dimension === undefined ? {} : { dimension: world.dimension }),
		...(world.dimensionId === undefined ? {} : { dimensionId: world.dimensionId }),
		...(world.dayPhase === undefined ? {} : { dayPhase: world.dayPhase }),
		...(world.darkIn === undefined ? {} : { darkIn: world.darkIn }),
		...(world.raining === undefined ? {} : { raining: world.raining }),
		...(world.thundering === undefined ? {} : { thundering: world.thundering }),
	};
}

// placeableFacesFor / placeableFacesStandIn say which item placeableFaces was judged for; the faces mean nothing without it.
const COVERAGE_EVENT_FIELDS = ['returned', 'total', 'omittedByWire', 'complete', 'hasMore', 'nextOffset', 'placeableFacesFor', 'placeableFacesStandIn'];

function compactCoverageForEvent(coverage) {
	if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) return coverage;
	return {
		...coverage,
		...(coverage.sections === null || typeof coverage.sections !== 'object' || Array.isArray(coverage.sections)
			? {}
			: { sections: Object.fromEntries(Object.entries(coverage.sections).map(([section, detail]) => [section,
				detail === null || typeof detail !== 'object' || Array.isArray(detail) ? detail : Object.fromEntries(
					COVERAGE_EVENT_FIELDS.filter((field) => detail[field] !== undefined).map((field) => [field, detail[field]]),
				)])) }),
	};
}

function compactPerceptionForEvent(perception) {
	if (perception === null || typeof perception !== 'object' || Array.isArray(perception)) return perception;
	return {
		...perception,
		...(Array.isArray(perception.events) ? { events: perception.events.slice(-8), ...(perception.events.length <= 8 ? {} : { omittedEvents: perception.events.length - 8 }) } : {}),
		...(Array.isArray(perception.bossBars) ? { bossBars: perception.bossBars.slice(-16), ...(perception.bossBars.length <= 16 ? {} : { omittedBossBars: perception.bossBars.length - 16 }) } : {}),
	};
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

export function nativeObservationSignature(observation) {
	return createHash('sha256').update(JSON.stringify(sortFactualValue(nativeActionableObservationProjection(observation)))).digest('hex');
}

function nativeActionableObservationProjection(observation) {
	const projection = { ...observation };
	// Receipt/sample identity remains in raw facts, but is not a changed world fact.
	delete projection.observedAtEpochMs;
	delete projection.eventSequence;
	if (observation.freshness !== undefined) {
		const { observedAtEpochMs, eventSequence, afterEventSequence, ...freshness } = observation.freshness;
		projection.freshness = freshness;
	}
	delete projection.recovery;
	delete projection.options;
	delete projection.failureClass;
	delete projection.continuity;
	delete projection.lastLiveInventory;
	if (observation.player !== undefined) {
		projection.player = { ...observation.player };
		if (observation.player.effects !== undefined) {
			projection.player.effects = observation.player.effects.map(({ duration, ...effect }) => effect);
		}
		// Counters that tick down on their own, and exits that shift with every step in lava; the facts they describe
		// change only with health, fire, inLava or position. The hazard kind rides inLava, fire and damage.
		delete projection.player.hazard;
		delete projection.player.fireTicks;
		delete projection.player.exits;
		delete projection.player.hurtBy;
		delete projection.player.recentDamage;
		delete projection.player.lavaSeen;
		// A flow on its way is a change when it appears or changes course, not as its arrival time counts down.
		if (observation.player.lavaFlow && typeof observation.player.lavaFlow === 'object') {
			const { inS, ...course } = observation.player.lavaFlow;
			projection.player.lavaFlow = course;
		}
	}
	if (Array.isArray(observation.items)) projection.items = observation.items.map(({ distance, ...item }) => item);
	if (Array.isArray(observation.entities)) projection.entities = observation.entities.map(({ distance, ...entity }) => entity);
	if (Array.isArray(observation.furnaces)) {
		projection.furnaces = observation.furnaces.map(({ observedAtEpochMs, estimatedReadyAtEpochMs, ...furnace }) => furnace);
	}
	if (Array.isArray(observation.nearbyContainers)) {
		projection.nearbyContainers = observation.nearbyContainers.map(({ distance, ...container }) => container);
	}
	if (observation.landmarks !== undefined) {
		projection.landmarks = observation.landmarks.map(({ distance, bearing, elevation, ...landmark }) => landmark);
	}
	if (observation.world !== undefined) {
		const { gameTime, dayTime, ...world } = observation.world;
		projection.world = world;
	}
	if (observation.interaction !== undefined) {
		const { useRemainingTicks, attackCooldown, ...interaction } = observation.interaction;
		projection.interaction = { ...interaction, attackReady: attackCooldown >= 1 };
	}
	return projection;
}

function planningTraceId(agentId, goalRevision, lifecycleGeneration, kind) {
	const identity = String(agentId).replace(/[^A-Za-z0-9._:-]/g, '_');
	return `trace-${identity}-${goalRevision}-${lifecycleGeneration}-${kind}`.slice(0, 128);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const reporter = new RuntimeErrorReporter();
	runCli(reporter).catch((error) => {
		reporter.report(error, { phase: 'startup' });
		process.exitCode = 1;
	});
}

function logCatalogGap(outcome, detail) {
	try {
		const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null);
		console.error(`[provider-catalog] discovery ${outcome}: ${sanitizeDiagnosticText(text ?? '', { maxBytes: 2_048 })}`);
	} catch { /* console output is best effort */ }
}
