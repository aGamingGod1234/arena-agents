import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRegistry } from '../agent-registry.mjs';
import { ClaudeProviderService } from '../claude-service.mjs';
import { ClaudeToolServer } from '../claude-tool-server.mjs';
import { CodexService } from '../codex-service.mjs';
import { createDynamicCoordinator } from '../dynamic-main.mjs';
import { MinecraftAgentWorkspace } from '../minecraft-agent-workspace.mjs';
import { ModelObservationViews, encodeNativeEventInput } from '../model-fact-encoding.mjs';
import { normalizeMinecraftToolCall } from '../native-minecraft-tools.mjs';
import { PlanningScheduler } from '../planning-scheduler.mjs';
import { TaskMemoryStore } from '../task-memory-store.mjs';
import { casePreviousObservations, validateCase } from './schema.mjs';

/**
 * Renders a decision-eval case into exactly what this build sends the play model on a fresh (post-reset) session.
 *
 * The wake input is not composed here. The case's raw observations are replayed through the real DynamicCoordinator
 * in-process, behind an in-memory bridge, and the input it hands the provider for the case's observation is taken
 * verbatim. A plan or intent in the case is written by a setup turn that calls the production taskPlan tool through
 * the coordinator's own executeTool. Time follows the recorded observation clock, so change lines, cooldowns and ages
 * read as they did in the game. The instructions and tool definitions are captured at the provider boundary of the
 * production services (the Claude system prompt file and MCP tools/list, the Codex thread/start parameters).
 *
 * What this reproduces is the exact production rendering of the RECONSTRUCTED SUPPORTED STATE, not the original
 * recorded wake byte for byte. Supported: the recorded observations; the plan and intent (taskPlan tool); model-authored
 * task memory (taskMemory tool); action results, which production reads from each replayed observation's lastResult
 * (so a recorded result reaches the wake when the observation that carried it is replayed); recorded deaths and
 * stations (fed through the build's TaskMemoryStore.observe into the memory directory the coordinator loads). Earlier
 * wakes end as synthetic completed turns, not the recorded decisions. Supplied state that this render does not reach
 * (results older than the replayed observations, foreign-world memory, the informational continuity header) is listed
 * in replay.unreplayed for every render.
 */

export const COORDINATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MINECRAFT_TEMPLATE_ROOT = path.join(COORDINATOR_ROOT, 'config', 'minecraft-agent');
const AGENT_ID = 'decision-eval-agent';
const GOAL_REVISION = 1;
const SETTLE_TICKS = 20;
const WAKE_WAIT_MS = 2_000;
const MAX_RESAMPLES = 3;

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export class DecisionEvalRenderError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.code = code;
		Object.assign(this, details);
	}
}

/**
 * Date.now follows a virtual clock while fn runs, and the coordinator's supervision timers run on it: a timer fires
 * when the replay moves the clock past its due time, in due order. Renders therefore run one at a time.
 */
let clockDepth = 0;
async function withVirtualClock(start, fn) {
	if (clockDepth > 0) throw new DecisionEvalRenderError('RENDER_BUSY', 'decision-eval renders share the process clock; run them sequentially');
	const realNow = Date.now;
	let sequence = 0;
	const timers = new Map();
	const clock = {
		now: start,
		schedule: (callback, delay) => {
			const handle = { id: ++sequence };
			timers.set(handle.id, { handle, callback, due: clock.now + Math.max(0, Number(delay) || 0) });
			return handle;
		},
		cancel: (handle) => { timers.delete(handle?.id); },
		/** Moves to `time`, firing due timers in order; returns how many fired. */
		async advanceTo(time) {
			let fired = 0;
			for (;;) {
				const next = [...timers.values()].filter((timer) => timer.due <= time).sort((a, b) => a.due - b.due || a.handle.id - b.handle.id)[0];
				if (next === undefined) break;
				timers.delete(next.handle.id);
				if (next.due > clock.now) clock.now = next.due;
				await next.callback();
				await settle();
				fired += 1;
			}
			if (time > clock.now) clock.now = time;
			return fired;
		},
		/** Fires the earliest pending timer, if any. */
		async fireNext() {
			const next = [...timers.values()].sort((a, b) => a.due - b.due || a.handle.id - b.handle.id)[0];
			if (next === undefined) return false;
			await clock.advanceTo(next.due);
			return true;
		},
	};
	clockDepth += 1;
	Date.now = () => clock.now;
	try { return await fn(clock); } finally { Date.now = realNow; clockDepth -= 1; }
}

class HarnessBridge extends EventEmitter {
	sent = [];
	count(type) { return this.sent.reduce((total, message) => total + (message.type === type ? 1 : 0), 0); }
	start() {}
	stop() {}
	async send(type, agentId, payload) {
		this.sent.push({ type, agentId, payload });
		// The replay has no live server: a query the coordinator raises while building a wake is answered as unavailable,
		// never with invented facts.
		if (type === 'inspection_request') {
			queueMicrotask(() => this.emit('inspection_result', { agentId, connectionEpoch: 1, payload: {
				requestId: payload.requestId, goalRevision: payload.goalRevision,
				error: { code: 'INSPECTION_UNAVAILABLE', message: 'decision-eval replay has no live server' },
			} }));
		}
	}
}

/** Collects coordinator trace events; replay steps wait on them instead of on wall time. */
class TraceLog {
	events = [];
	#waiters = new Set();
	write(event, fields) {
		this.events.push({ event, fields });
		for (const waiter of this.#waiters) waiter();
	}
	count(event) { return this.events.reduce((total, row) => total + (row.event === event ? 1 : 0), 0); }
	until(predicate, timeoutMs) {
		if (predicate()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const check = () => { if (predicate()) { cleanup(); resolve(true); } };
			const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
			const cleanup = () => { clearTimeout(timer); this.#waiters.delete(check); };
			this.#waiters.add(check);
		});
	}
}

/** A planner that hands each native turn to the replay instead of a provider. */
class ReplayPlanner {
	turns = [];
	#waiters = [];
	constructor(registry) { this.registry = registry; }
	beginReconcile(records, options) {
		const registry = this.registry.reconcile(records, options);
		return { registry, complete: Promise.resolve({ registry, providers: { valid: registry.records, invalid: [], catalog: { models: [] } } }) };
	}
	async reconcile(records) { return this.beginReconcile(records).complete; }
	async requestPlan() { throw new DecisionEvalRenderError('RENDER_UNSUPPORTED', 'decision-eval renders native tool agents only'); }
	requestGoalSpec() { return new Promise(() => {}); }
	cancelGoalSpec() { return true; }
	async interrupt() {}
	async remove(agentId) { return this.registry.remove(agentId); }
	requestNativeTurn(request) {
		let finish;
		const done = new Promise((resolve) => { finish = resolve; });
		const turn = { request, finish, done };
		this.turns.push(turn);
		for (const waiter of this.#waiters.splice(0)) waiter();
		return done;
	}
	nextTurn(timeoutMs) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			this.#waiters.push(() => { clearTimeout(timer); resolve(true); });
		});
	}
}

const idleProvider = { catalog: { stale: false, refresh: async () => ({ models: [] }), assertSupported() {} }, async start() {}, async stop() {} };

async function settle(ticks = SETTLE_TICKS) {
	for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function observationPayload(raw, sequence) {
	const payload = { ...structuredClone(raw), goalRevision: GOAL_REVISION };
	const inner = payload.observation;
	if (inner !== undefined && inner !== null && typeof inner === 'object') inner.goalRevision = GOAL_REVISION;
	payload.eventSequence = sequence;
	return payload;
}

function observedAt(raw) {
	const value = raw?.observedAtEpochMs ?? raw?.observation?.observedAtEpochMs;
	return Number.isFinite(value) ? value : null;
}

/** Event sequences as recorded when they increase; otherwise a dense 1..n numbering. */
function eventSequences(observations) {
	const recorded = observations.map((raw) => raw?.eventSequence ?? raw?.observation?.eventSequence);
	const increasing = recorded.every((value, index) => Number.isSafeInteger(value) && value > 0 && (index === 0 || value > recorded[index - 1]));
	return increasing ? recorded : observations.map((_, index) => index + 1);
}

/**
 * Recorded action results that reach the wake: production remembers results from each observation's lastResult, so a
 * result is replayed exactly when an observation in the replay carries it. The others are older than the replay window.
 */
export function recentResultCoverage(testCase, replayedObservations) {
	const carried = new Set(replayedObservations.map((raw) => (raw?.observation ?? raw)?.lastResult?.actionId).filter((id) => typeof id === 'string'));
	const results = (testCase.state.agent.recentResults ?? []).filter((entry) => typeof entry?.result?.actionId === 'string');
	const replayed = results.filter((entry) => carried.has(entry.result.actionId)).length;
	return { supplied: results.length, replayed, unreplayed: results.length - replayed };
}

const rowsOf = (value) => Array.isArray(value) ? value
	: Array.isArray(value?.$rows?.rows) ? value.$rows.rows.map((row) => Object.fromEntries(value.$rows.columns.map((column, i) => [column, row[i]]))) : [];

/**
 * Observations that make the build's TaskMemoryStore record the recorded deaths and stations: a death sample per death
 * (position, cause, time, lost inventory) and a block sighting per station. Only memory of the case's own world and
 * dimension is seeded; anything else is reported as not replayed.
 */
export function observedMemorySeed(testCase) {
	const memory = testCase.state.agent.taskMemory;
	const observation = testCase.state.observation?.observation ?? testCase.state.observation ?? {};
	const world = observation.world ?? {};
	const deaths = Array.isArray(memory?.deaths) ? memory.deaths : [];
	const assets = Array.isArray(memory?.assets) ? memory.assets.filter((asset) => asset?.source === 'observed_block') : [];
	const otherAssets = (Array.isArray(memory?.assets) ? memory.assets.length : 0) - assets.length;
	if (deaths.length + assets.length === 0) return { scope: null, samples: [], seeded: 0, unreplayed: otherAssets };
	const dimension = world.dimension ?? world.dimensionId ?? memory.dimension;
	if (typeof world.worldId !== 'string' || world.worldId !== memory.worldId || typeof dimension !== 'string' || dimension !== memory.dimension) {
		return { scope: null, samples: [], seeded: 0, unreplayed: deaths.length + assets.length + otherAssets };
	}
	const samples = [];
	for (const death of deaths) {
		const at = death.diedAtEpochMs ?? null;
		if (!death.position) continue;
		samples.push({ observedAtEpochMs: at, world: { worldId: world.worldId, dimension },
			death: { ...death.position, cause: death.cause ?? 'unknown', diedAtEpochMs: at, dimensionId: dimension },
			lastLiveInventory: { items: rowsOf(death.lostInventory).map(({ itemId, count }) => ({ itemId, count })) } });
	}
	for (const asset of assets) {
		if (!asset.position || typeof asset.blockId !== 'string') continue;
		samples.push({ observedAtEpochMs: asset.observedAtEpochMs ?? null, world: { worldId: world.worldId, dimension, ...(Number.isFinite(asset.lastSeenTick) ? { gameTime: asset.lastSeenTick } : {}) },
			blocks: [{ ...asset.position, blockId: asset.blockId }] });
	}
	return { scope: { worldId: world.worldId, dimension }, samples, seeded: samples.length, unreplayed: deaths.length + assets.length - samples.length + otherAssets };
}

function setupTools(testCase) {
	const { agent } = testCase.state;
	const calls = [];
	if (agent.taskPlan) calls.push({ operation: 'replace', plan: agent.taskPlan });
	if (agent.intent) calls.push({ operation: 'intent', intent: agent.intent });
	const tools = calls.map((args) => {
		try { return normalizeMinecraftToolCall('taskPlan', args); }
		catch (error) { throw new DecisionEvalRenderError('INVALID_CASE_STATE', `case ${testCase.id}: taskPlan ${args.operation} is rejected by this build: ${error.message}`); }
	});
	if (agent.reflexes) {
		try { tools.push(normalizeMinecraftToolCall('runProgram', { reflexes: agent.reflexes })); }
		catch (error) { throw new DecisionEvalRenderError('INVALID_CASE_STATE', `case ${testCase.id}: prior reflexes rejected: ${error.message}`); }
	}
	return [...tools, ...taskMemorySetup(testCase).tools];
}

const MEMORY_KINDS = Object.freeze({ places: 'place', routes: 'route', progress: 'progress', lessons: 'lesson' });
const MEMORY_FIELDS = Object.freeze(['kind', 'key', 'label', 'summary', 'position', 'from', 'to', 'waypoints', 'status', 'shared']);

/**
 * Recorded task memory the model wrote itself (places, routes, progress, lessons) is written again through the
 * production taskMemory remember tool in the setup turn, oldest list order kept. Entries the game observed (deaths,
 * block assets) have no model-facing writer and are not replayed; entries this build rejects are skipped and counted.
 */
export function taskMemorySetup(testCase) {
	const memory = testCase.state.agent.taskMemory;
	const tools = [];
	let skipped = 0;
	let observed = 0;
	if (memory === null || typeof memory !== 'object') return { tools, skipped, observed };
	for (const [list, kind] of Object.entries(MEMORY_KINDS)) {
		for (const entry of Array.isArray(memory[list]) ? memory[list] : []) {
			if (entry?.source !== 'model_authored') { observed += 1; continue; }
			const written = Object.fromEntries(MEMORY_FIELDS.filter((field) => entry[field] !== undefined && entry[field] !== null).map((field) => [field, entry[field]]));
			written.kind = kind;
			try { tools.push(normalizeMinecraftToolCall('taskMemory', { operation: 'remember', entry: written })); } catch { skipped += 1; }
		}
	}
	for (const list of ['deaths', 'assets']) observed += Array.isArray(memory[list]) ? memory[list].length : 0;
	return { tools, skipped, observed };
}

/**
 * What a setup call did. `replace` answers with the plan view ({ goal, revision, plan }) rather than a state, so an
 * answer carrying the plan reads as APPLIED; an answer with its own state (intent: INTENT_SAVED, or a rejection) keeps it.
 */
export function setupOutcome(tool, result) {
	const steps = Array.isArray(result?.plan?.steps) ? result.plan.steps.length : null;
	const state = typeof result?.state === 'string' ? result.state : steps !== null ? 'APPLIED' : 'UNKNOWN';
	return { operation: tool.operation, state, reasonCode: result?.reasonCode ?? null, valid: result?.valid ?? null, ...(steps === null ? {} : { steps, revision: result.revision ?? null }) };
}

/** The registry record the replay registers: an idle agent of the run's play profile. */
export function replayAgentRecord(testCase, { provider = 'claude', model = 'claude-opus-5-5', reasoningEffort = 'low' } = {}) {
	const agent = testCase.state.agent;
	return {
		schemaVersion: 1, agentId: AGENT_ID, entityUuid: '00000000-0000-4000-8000-000000000001', name: agent.name ?? 'ha_eval_agent',
		provider, model, reasoningEffort, serviceTier: provider === 'codex' ? 'default' : 'priority', gameMode: 'survival', skinVariant: 'variant-1',
		state: 'IDLE', currentGoal: null, currentGoalSpec: null, goalRevision: 0, queue: [], lastSummary: agent.lastSummary ?? null, death: null,
	};
}

export const REPLAY_AGENT_ID = AGENT_ID;

function payloadOf(input) {
	const newline = input.indexOf('\n');
	try { return JSON.parse(input.slice(newline + 1)); } catch { return null; }
}

/**
 * Renders the wake input of one case.
 * Returns { input, encodedInput, inputSha256, encodedSha256, instruction, event, trigger, recoverySummary, replay }.
 * `input` is the string the coordinator passes to agent.act(); `encodedInput` is what a fresh provider session
 * writes to the model (encodeNativeEventInput with fresh observation views), byte for byte.
 */
export async function renderWake(testCase, options = {}) {
	try { return await renderWakeAs(testCase, options); }
	catch (error) {
		// A build from before the OpenCode provider rejects an OpenCode agent record. The wake the coordinator writes does
		// not depend on the provider, so that build's wake is rendered for a Claude record and sent through OpenCode.
		if (options.provider !== 'opencode' || error.code !== 'RENDER_FAILED' || !/did not accept the replay agent/.test(error.message)) throw error;
		const result = await renderWakeAs(testCase, { ...options, provider: 'claude' });
		result.replay.agentProvider = 'claude (build predates the OpenCode provider)';
		return result;
	}
}

async function renderWakeAs(testCase, { provider = 'claude', model = 'claude-opus-5-5', reasoningEffort = 'low' } = {}) {
	validateCase(testCase);
	const agent = testCase.state.agent;
	if (testCase.state.wake?.conversation?.length > 0) throw new DecisionEvalRenderError('RENDER_UNSUPPORTED', `case ${testCase.id}: unread conversation replay is not supported yet`);
	const tools = setupTools(testCase);
	const previous = casePreviousObservations(testCase);
	// A plan or intent is written by a setup turn on the first wake. Without an earlier observation that wake is
	// the case's own observation, delivered once before the replay continues to it.
	const replay = [...(tools.length > 0 && previous.length === 0 ? [testCase.state.observation] : previous), testCase.state.observation];
	const sequences = eventSequences(replay);
	const firstAt = observedAt(replay[0]) ?? 1_800_000_000_000;
	const recent = recentResultCoverage(testCase, replay);
	const seed = observedMemorySeed(testCase);
	// Recorded deaths and stations go through this build's own task memory store into a private memory directory.
	const memoryDirectory = seed.scope === null ? null : await mkdtemp(path.join(os.tmpdir(), 'decision-eval-memory-'));
	if (memoryDirectory !== null) {
		const store = new TaskMemoryStore({ directory: memoryDirectory });
		for (const sample of seed.samples) await store.observe({ agentId: AGENT_ID, ...seed.scope }, sample);
		await store.flush();
	}
	try {
	return await withVirtualClock(firstAt, async (clock) => {
		const bridge = new HarnessBridge();
		const registry = new AgentRegistry();
		const planner = new ReplayPlanner(registry);
		const traces = new TraceLog();
		const coordinator = createDynamicCoordinator({
			bridge: { port: 25570, secret: 's'.repeat(32) },
			codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-6-luna', reasoningEffort: 'low', serviceTier: 'default' } },
		}, {
			bridge, registry, planner, scheduler: new PlanningScheduler(), codexService: idleProvider, memoryDirectory, traceWriter: traces,
			// Every coordinator timer runs on the recorded clock; nothing fires on wall time during a replay.
			controlNow: () => clock.now, epochNow: () => clock.now,
			goalSchedule: clock.schedule, cancelGoalSchedule: clock.cancel, goalStuckSchedule: clock.schedule, cancelGoalStuckSchedule: clock.cancel,
			setSteerTimeout: clock.schedule, clearSteerTimeout: clock.cancel, setWakeHoldTimeout: clock.schedule, clearWakeHoldTimeout: clock.cancel,
			setGoalSpecTimeout: clock.schedule, clearGoalSpecTimeout: clock.cancel, setStatusInterval: () => ({ decisionEval: true }), clearStatusInterval: () => {},
			// Recorded cases predate the default survival rules (ruling 16, Oct 28): their mod reflex status and wakes were
			// captured without them, so a replay arms only the case's own rules.
			reflexDefaults: [],
		});
		const memory = taskMemorySetup(testCase);
		const agentState = testCase.state.agent;
		const diagnostics = { observations: replay.length, wakes: 0, timersFired: 0, resamples: 0, setupTools: tools.map((tool) => tool.operation), setupResults: [], inspections: 0, wakeTriggers: [],
			taskMemory: { written: memory.tools.length, skipped: memory.skipped, notReplayed: seed.unreplayed, observedSeeded: seed.seeded },
			recentResults: recent,
			// Supplied state this render could not reproduce; empty when everything supplied reached the coordinator.
			unreplayed: [
				...(agentState.continuity ? ['continuity (recomputed from plan, intent and results, not replayed)'] : []),
				...(recent.unreplayed ? [`recentResults: ${recent.unreplayed} of ${recent.supplied} older than the replayed observations`] : []),
				...(memory.skipped ? [`taskMemory: ${memory.skipped} authored entries rejected`] : []),
				...(seed.unreplayed ? [`taskMemory: ${seed.unreplayed} observed entries outside this world or unsupported`] : []),
			] };

		/** Delivers one bridge message and waits for the coordinator's handler, then for any wake it scheduled. */
		const deliver = async (type, message) => {
			const pending = [];
			const turns = planner.turns.length;
			const planning = bridge.count('planning_state');
			bridge.emit(type, { ...message, waitUntil: (promise) => pending.push(promise) });
			await Promise.allSettled(pending);
			await settle();
			if (planner.turns.length === turns && bridge.count('planning_state') > planning) await planner.nextTurn(WAKE_WAIT_MS);
		};
		await coordinator.start();
		try {
			await deliver('ready', { connectionEpoch: 1, serverInstanceId: 'decision-eval', registry: [replayAgentRecord(testCase, { provider, model, reasoningEffort })] });
			if (bridge.count('agent_ready') === 0) throw new DecisionEvalRenderError('RENDER_FAILED', 'coordinator did not accept the replay agent');
			await deliver('goal_control', { agentId: AGENT_ID, connectionEpoch: 1, payload: {
				operation: 'start', goalRevision: GOAL_REVISION, updatedAtEpochMs: firstAt, goal: agent.goal,
				...(agent.goalSpec ? { goalSpec: agent.goalSpec } : {}),
			} });
			let setupDone = tools.length === 0;
			let captured = null;
			let handled = 0;
			/** Handles wakes in order; the newest wake after the case observation is the one captured. */
			const drainTurns = async (targetDelivered) => {
				while (captured === null && handled < planner.turns.length) {
					const turn = planner.turns[handled];
					handled += 1;
					const input = typeof turn.request.input === 'function' ? await turn.request.input() : turn.request.input;
					diagnostics.wakes += 1;
					diagnostics.wakeTriggers.push(payloadOf(input)?.trigger ?? null);
					if (targetDelivered && setupDone && handled === planner.turns.length) { captured = { turn, input }; return; }
					// Earlier wakes end as completed turns, as if the model acted; the setup wake also writes plan and intent.
					let toolCalls = 1;
					if (!setupDone) {
						toolCalls = tools.length;
						for (const [callIndex, tool] of tools.entries()) {
							const result = await turn.request.executeTool({ agentId: AGENT_ID, goalRevision: GOAL_REVISION, threadId: 'decision-eval', turnId: 'setup', callId: `setup-${callIndex}`, tool });
							diagnostics.setupResults.push(setupOutcome(tool, result));
						}
						setupDone = true;
					}
					clock.now += 1;
					const ended = traces.count('native_turn_completed') + traces.count('native_turn_failed');
					const turns = planner.turns.length;
					const planning = bridge.count('planning_state');
					turn.finish({ status: 'completed', toolCalls });
					await traces.until(() => traces.count('native_turn_completed') + traces.count('native_turn_failed') > ended, WAKE_WAIT_MS);
					await settle();
					// A wake folded into the finished turn starts as soon as it completes.
					if (planner.turns.length === turns && bridge.count('planning_state') > planning) await planner.nextTurn(WAKE_WAIT_MS);
				}
			};
			const target = replay.length - 1;
			const offset = replay.length - 1 - casePreviousObservations(testCase).length;
			for (const [index, raw] of replay.entries()) {
				// Supervision timers due before this sample fire first, as they would have in the game.
				diagnostics.timersFired += await clock.advanceTo(observedAt(raw) ?? clock.now);
				await drainTurns(false);
				// Recorded lifecycle controls (death, respawn) arrive where they did between observations.
				for (const control of testCase.state.lifecycle ?? []) {
					if (control.beforeObservation + offset !== index) continue;
					diagnostics.timersFired += await clock.advanceTo(control.payload.updatedAtEpochMs ?? clock.now);
					await deliver('goal_control', { agentId: AGENT_ID, connectionEpoch: 1, payload: { ...control.payload, goalRevision: GOAL_REVISION } });
					await drainTurns(false);
				}
				await deliver('observation', { agentId: AGENT_ID, connectionEpoch: 1, payload: observationPayload(raw, sequences[index]) });
				await drainTurns(index === target);
			}
			// No wake for the case observation yet: let supervision run on, and answer its observation requests with
			// the case observation re-sampled (the state a live server would report a moment later).
			while (captured === null && diagnostics.resamples < MAX_RESAMPLES) {
				const requests = bridge.count('request_observation');
				if (!await clock.fireNext()) break;
				diagnostics.timersFired += 1;
				await settle();
				if (bridge.count('request_observation') > requests) {
					diagnostics.resamples += 1;
					const sample = structuredClone(testCase.state.observation);
					sample.observedAtEpochMs = clock.now;
					if (sample.observation?.observedAtEpochMs !== undefined) sample.observation.observedAtEpochMs = clock.now;
					await deliver('observation', { agentId: AGENT_ID, connectionEpoch: 1, payload: observationPayload(sample, sequences[target] + diagnostics.resamples) });
				}
				await drainTurns(true);
			}
			diagnostics.inspections = bridge.count('inspection_request');
			if (captured === null) throw new DecisionEvalRenderError('NO_WAKE', `case ${testCase.id}: this build does not wake the model for the case observation`, { diagnostics });
			const { input, turn } = captured;
			const encodedInput = encodeNativeEventInput(input, new ModelObservationViews());
			const payload = payloadOf(input);
			const result = {
				input, encodedInput,
				inputSha256: sha256(input), encodedSha256: sha256(canonicalEncodedInput(encodedInput)),
				inputBytes: Buffer.byteLength(input), encodedBytes: Buffer.byteLength(encodedInput),
				instruction: input.slice(0, input.indexOf('\n')),
				event: payload?.event ?? null, trigger: payload?.trigger ?? null,
				recoverySummary: turn.request.recoverySummary ?? null,
				replay: diagnostics,
			};
			const expectedTrigger = testCase.state.wake?.trigger;
			if (expectedTrigger !== undefined && expectedTrigger !== result.trigger) result.triggerMismatch = { expected: expectedTrigger, rendered: result.trigger };
			return result;
		} finally {
			for (const turn of planner.turns) turn.finish({ status: 'completed', toolCalls: 0 });
			await coordinator.stop();
		}
	});
	} finally {
		if (memoryDirectory !== null) await rm(memoryDirectory, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Observation views are named per provider session (observation-<random session id>-<n>), so two sessions encode
 * the same wake with different ids. Hashes compare the encoding with that id replaced.
 */
export function canonicalEncodedInput(text) {
	return text.replace(/observation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/g, 'observation-session-');
}

/** A dedicated Minecraft agent workspace whose preparation never copies the operator's Codex login. */
export async function evalMinecraftWorkspace(root, { syncCodexAuth = false } = {}) {
	await mkdir(root, { recursive: true });
	const workspace = new MinecraftAgentWorkspace({ root, templateRoot: MINECRAFT_TEMPLATE_ROOT });
	if (syncCodexAuth) return workspace;
	const emptyCodexHome = path.join(root, '.empty-codex-home');
	await mkdir(emptyCodexHome, { recursive: true });
	return { prepare: () => workspace.prepare({ sourceCodexHome: emptyCodexHome }) };
}

async function claudeToolsList() {
	const server = new ClaudeToolServer();
	try {
		const route = await server.register({ callTool: async () => ({ content: [] }) });
		const response = await fetch(route.url, {
			method: 'POST', headers: { authorization: `Bearer ${route.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		});
		const body = await response.json();
		route.unregister();
		return body.result.tools;
	} finally { await server.stop(); }
}

/**
 * The always-sent prefix of a fresh session: instructions and tool definitions exactly as the production service
 * hands them to the provider. Claude: the system prompt file and the MCP tools/list. Codex: thread/start
 * baseInstructions, developerInstructions and dynamicTools.
 */
export async function renderPrefix({ provider = 'claude', model = 'claude-opus-5-5', reasoningEffort = 'low', recoverySummary = null, root = null } = {}) {
	const owned = root === null;
	const workRoot = root ?? await mkdtemp(path.join(os.tmpdir(), 'decision-eval-prefix-'));
	try {
		const minecraftWorkspace = await evalMinecraftWorkspace(path.join(workRoot, 'minecraft-agent'));
		let instructions;
		let tools;
		if (provider === 'claude') {
			const written = [];
			const service = new ClaudeProviderService({ cwd: workRoot, runtimeRoot: path.join(workRoot, 'claude-agents'), models: [model], reasoningEfforts: [reasoningEffort] }, {
				minecraftWorkspace, toolServer: { stop: async () => {} },
				fs: { mkdir: async () => {}, writeFile: async (file, content) => { written.push({ file, content }); }, chmod: async () => {}, rm: async () => {} },
			});
			try { await service.createAgent({ agentId: AGENT_ID, provider: 'claude', model, reasoningEffort, serviceTier: 'priority' }, { recoverySummary, controlProtocol: 'native_tools' }); }
			finally { await service.stop(); }
			instructions = { systemPrompt: written.find((entry) => /system-prompt-\d+\.md$/.test(entry.file)).content };
			tools = await claudeToolsList();
		} else if (provider === 'codex') {
			let transmitted = null;
			class CaptureTransport extends EventEmitter {
				async start() {}
				async stop() {}
				notify() {}
				async request(method, params) {
					if (method === 'initialize') return {};
					if (method === 'model/list') return { data: [{ id: model, model, supportedReasoningEfforts: [{ reasoningEffort }], serviceTiers: [{ id: 'priority' }, { id: 'fast' }] }], nextCursor: null };
					if (method !== 'thread/start') throw new DecisionEvalRenderError('RENDER_FAILED', `prefix capture must not call ${method}`);
					transmitted = structuredClone(params);
					return { thread: { id: 'decision-eval-prefix' } };
				}
			}
			const service = new CodexService({ cwd: workRoot, environment: {} }, { transport: new CaptureTransport(), minecraftWorkspace: { prepare: async () => ({ ...(await minecraftWorkspace.prepare()), permissionProfile: undefined }) } });
			try { await service.createAgent({ agentId: AGENT_ID, provider: 'codex', model, reasoningEffort, serviceTier: 'default' }, { recoverySummary, controlProtocol: 'native_tools' }); }
			finally { await service.stop(); }
			instructions = { baseInstructions: transmitted.baseInstructions, developerInstructions: transmitted.developerInstructions };
			tools = transmitted.dynamicTools;
		} else if (provider === 'opencode') {
			// The agent prompt OpenCode receives and the same MCP tools Claude lists; creating the agent starts no server.
			let systemPrompt = null;
			// Loaded only for OpenCode players, so the harness still runs on builds from before the OpenCode provider.
			const { OpenCodeProviderService } = await import('../opencode-service.mjs');
			const service = new OpenCodeProviderService({ models: [model], reasoningEfforts: [reasoningEffort] }, {
				minecraftWorkspace, toolServer: { stop: async () => {} }, onSystemPrompt: (text) => { systemPrompt = text; },
			});
			try { await service.createAgent({ agentId: AGENT_ID, provider: 'opencode', model, reasoningEffort, serviceTier: 'priority' }, { recoverySummary, controlProtocol: 'native_tools' }); }
			finally { await service.stop(); }
			instructions = { systemPrompt };
			tools = await claudeToolsList();
		} else {
			throw new DecisionEvalRenderError('RENDER_UNSUPPORTED', `provider ${provider} is not supported`);
		}
		const instructionsText = JSON.stringify(instructions);
		const toolsText = JSON.stringify(tools);
		return {
			provider, instructions, tools,
			instructionsSha256: sha256(instructionsText), instructionsBytes: Buffer.byteLength(instructionsText),
			toolsSha256: sha256(toolsText), toolsBytes: Buffer.byteLength(toolsText),
			prefixSha256: sha256(`${instructionsText}\n${toolsText}`),
		};
	} finally {
		if (owned) await rm(workRoot, { recursive: true, force: true }).catch(() => {});
	}
}
