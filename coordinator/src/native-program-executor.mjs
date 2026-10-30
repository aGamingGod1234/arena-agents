import { createHash, randomUUID } from 'node:crypto';
import { ArenaScriptEngine, CONTEXT_TRIGGERS } from './arena-script/program-engine.mjs';
import { parseArenaScript } from './arena-script/parser.mjs';
import { DEFAULT_ARENA_SCRIPT_LIMITS, MAX_PROGRAM_ACTIONS, MAX_PROGRAM_TIMEOUT_MS } from './arena-script/limits.mjs';
import { breakOutcomeEvidence, breakOutcomeScriptEvidence, freezeRuntimeResult } from './arena-script/interpreter.mjs';
import { adaptObservation } from './observation-adapter.mjs';
import { minecraftCapabilities, normalizeMinecraftToolCall, toolAdjustments, withAdjustments } from './native-minecraft-tools.mjs';
import { validateAction } from './schema.mjs';
import { validateProgramParameters } from './program-parameters.mjs';
import { nativeOperationRejection } from './native-operation-contract.mjs';
import { boundedResourceSightings, resourceSightingKey } from './resource-sightings.mjs';
import { defaultServiceTier } from './constants.mjs';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
// Session trace: ordinary sightings re-woke the model every ~3 s while a program ran (305 of 358 turns ended with no tool call).
export const ORDINARY_ATTENTION_INTERVAL_MS = 30_000;
export const DECISION_REMINDER_INTERVAL_MS = 2_000;
/** A planning notice with less body time than a model response left still fires when this much remains. */
export const MIN_PLANNING_OVERLAP_MS = 4_000;

/** Runs selected-model ArenaScript through native tools, returning every new decision to its caller. */
export class NativeProgramExecutor {
	#runs = new Map(); #agentDurations = new Map(); #setTimeout; #clearTimeout; #cancellationTimeoutMs; #sessionId; #sequence = 0; #now; #ordinaryAttentionIntervalMs;
	constructor({ setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, cancellationTimeoutMs = 5_000, sessionId = randomUUID(), now = Date.now, ordinaryAttentionIntervalMs = ORDINARY_ATTENTION_INTERVAL_MS } = {}) {
		if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') throw new TypeError('timer callbacks are required');
		if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) throw new TypeError('sessionId must be a bounded identifier');
		this.#sessionId = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
		integer(cancellationTimeoutMs, 'cancellationTimeoutMs', 1, 10_000);
		this.#setTimeout = setTimeoutFn; this.#clearTimeout = clearTimeoutFn; this.#cancellationTimeoutMs = cancellationTimeoutMs;
		if (typeof now !== 'function') throw new TypeError('now must be a function');
		integer(ordinaryAttentionIntervalMs, 'ordinaryAttentionIntervalMs', 0, 600_000);
		this.#now = now; this.#ordinaryAttentionIntervalMs = ordinaryAttentionIntervalMs;
	}

	run(record, { source, parameters, maxActions = 64, timeoutMs = 30_000, expectedDurationMs, planningLeadMs, observationIntervalMs, programId: suppliedProgramId, provenance = {} } = {}, context = {}) {
		validateRecord(record);
		integer(maxActions, 'maxActions', 1, MAX_PROGRAM_ACTIONS); integer(timeoutMs, 'timeoutMs', 1, MAX_PROGRAM_TIMEOUT_MS);
		if (expectedDurationMs !== undefined) integer(expectedDurationMs, 'expectedDurationMs', 1, timeoutMs);
		parameters = validateProgramParameters(parameters);
		if (planningLeadMs !== undefined && planningLeadMs !== null) integer(planningLeadMs, 'planningLeadMs', 0, Number.MAX_SAFE_INTEGER);
		if (observationIntervalMs !== undefined) {
			integer(observationIntervalMs, 'observationIntervalMs', 100, 5000);
			if (typeof context.refreshObservation !== 'function') throw codedError('INSPECTION_UNAVAILABLE', 'Requested sampling requires fresh observations');
		}
		if (this.#runs.has(record.agentId)) throw codedError('PROGRAM_BUSY', 'Cancel the active program before starting another');
		if (typeof context.executeAction !== 'function' || typeof context.cancelAction !== 'function') throw new TypeError('executeAction and cancelAction callbacks are required');
		integer(context.eventSequence, 'eventSequence', 1, Number.MAX_SAFE_INTEGER);
		const compiled = parseArenaScript(source);
		const programId = suppliedProgramId ?? `native-program-${this.#sessionId}-${++this.#sequence}`;
		if (typeof programId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(programId)) throw new TypeError('programId must be a bounded identifier');
		let resolve;
		const result = new Promise((done) => { resolve = done; });
		const run = { record: { ...record }, context, programId, maxActions, timeoutMs, expectedDurationMs, planningLeadMs: planningLeadMs ?? null, actions: 0, actionsSucceeded: 0, actionsFailed: 0, receipts: [], resolve, result,
			settled: false, bodyPending: false, pendingActionId: null, stopping: null, timer: null, planningDueTimer: null, planningDueNotified: false, planningDueRearmed: false, planningDueRemainingMs: null, planningDueVersion: null, cancellationTimer: null,
			observation: programObservation(context.observation), eventSequence: context.eventSequence, engine: null,
			observationIntervalMs, observationTimer: null, refresh: null, refreshGeneration: 0, decision: null, decisionSequence: 0,
			urgentNotificationQueued: false,
			notifiedDecisionId: null, notifiedDecisions: [], firstNotifiedDecision: null, remindedDecisionId: null, decisionReminderTimer: null, lastDecisionReminderAt: null,
			startedAt: this.#now(), actionStartedAt: null, actionDurations: new Map(), actionMs: 0, lastActionObservationSequence: null,
			launchedAt: this.#now(), lastOrdinaryNotificationAt: Number.NEGATIVE_INFINITY, ordinaryNotificationTimer: null, ordinaryNotificationDueAt: null, unseenAttention: false, unseenDiscovery: false, resourceSightings: new Map() };
		run.engine = new ArenaScriptEngine({
			dispatch: (command) => { void this.#dispatch(run, command); },
			cancel: (actionId) => { void this.#cancelBody(run, actionId); },
			inspect: (request) => { void this.#query(run, request); },
			requestModel: (request) => this.#requestDecision(run, request),
		});
		this.#runs.set(record.agentId, run);
		run.creditMs = 0;
		run.urgentWaitSince = null;
		run.timer = this.#setTimeout(() => this.#deadline(run), timeoutMs);
		run.timer?.unref?.();
		try {
			run.engine.install({ agentId: record.agentId, provider: record.provider, modelIdentity: record.model, reasoningEffort: record.reasoningEffort,
				serviceTier: record.serviceTier ?? defaultServiceTier(record.provider), goalRevision: record.goalRevision, programId, version: 1, compiled,
				traceId: provenance.traceId ?? programId, parameters, observation: run.observation, eventSequence: run.eventSequence });
			this.#schedulePlanningDue(run);
			this.#check(run);
			this.#scheduleObservation(run);
		} catch (error) { this.#return(run, failure(error, 'PROGRAM_EXECUTION_FAILED'), true); }
		return result;
	}

	#refresh(run, purpose = 'interval') {
		if (run.refresh === null) {
			const refresh = { generation: ++run.refreshGeneration, purpose, promise: null };
			run.refresh = refresh;
			refresh.promise = Promise.resolve().then(() => run.context.refreshObservation?.()).finally(() => {
				if (run.refresh === refresh) run.refresh = null;
			});
		}
		return run.refresh;
	}

	#scheduleObservation(run) {
		if (run.settled || run.stopping !== null || run.observationIntervalMs === undefined || run.observationTimer !== null) return;
		const timer = this.#setTimeout(async () => {
			if (run.observationTimer !== timer || run.settled || run.stopping !== null) return;
			run.observationTimer = null;
			const refresh = this.#refresh(run);
			try {
				const fresh = await refresh.promise;
				if (run.refreshGeneration === refresh.generation && !run.settled && run.stopping === null) this.onObservation(run.record, fresh);
			} catch (error) {
				if (run.refreshGeneration === refresh.generation && !run.settled && run.stopping === null) this.#return(run, failure(error, 'FRESH_OBSERVATION_REQUIRED'), true);
			} finally { if (run.refreshGeneration === refresh.generation) this.#scheduleObservation(run); }
		}, run.observationIntervalMs);
		run.observationTimer = timer;
		run.observationTimer?.unref?.();
	}

	onObservation(record, payload = {}) {
		const run = this.#runs.get(record.agentId);
		if (!run || run.record.goalRevision !== record.goalRevision || run.settled) return false;
		if (!Number.isSafeInteger(payload.eventSequence) || payload.eventSequence <= run.eventSequence) return false;
		try {
			const previousObservation = run.observation;
			run.observation = programObservation(payload.observation ?? payload);
			run.eventSequence = payload.eventSequence;
			const sightings = boundedResourceSightings(run.record, [...run.resourceSightings.values()], payload.resourceSightings);
			run.resourceSightings = new Map(sightings.map(sighting => [resourceSightingKey(sighting), sighting]));
			// A new hazard in view, lost health or air, or a changed dimension/readiness is never held back.
			// A context edge (another dimension, a held tool that broke) changes what every next action does: it is not held either.
			if (hazardEdge(previousObservation, run.observation) || payload.attention === true && CONTEXT_TRIGGERS.has(payload.trigger)) run.lastOrdinaryNotificationAt = run.launchedAt = Number.NEGATIVE_INFINITY;
			if (run.refresh?.purpose === 'interval') {
				// A newer publication replaces background sampling, but cannot replace
				// the terminal-effect barrier owned by a completed action.
				run.refreshGeneration++;
				run.refresh = null;
				this.#scheduleObservation(run);
			}
			const decisionSequence = run.decisionSequence;
			run.engine.ingestObservation({ ...payload, observation: run.observation });
			if (run.decision !== null && payload.attention === true && payload.resourceSightings?.length) run.unseenDiscovery = true;
			// A new attention event invalidates an older decision. Ordinary progress
			// refreshes facts without starving a model response on every physics tick.
			if (payload.attention === true && run.decision !== null && run.decisionSequence === decisionSequence) {
				const priority = payload.priority ?? 'ordinary';
				const request = run.engine.refreshDirectiveRequest();
				// Only escalation (urgent attention or a changed action failure) needs a new handle. Ordinary sightings keep
				// the pending decision (so an in-flight respondProgram stays valid) and only refresh its facts.
				if (priority === 'urgent' || this.#escalates(run, request)) this.#requestDecision(run, request, priority);
				else {
					this.#foldOrdinary(run, request);
					this.#notifyDecision(run, priority);
				}
			}
			this.#check(run);
			return true;
		} catch (error) { this.#return(run, failure(error, 'INVALID_OBSERVATION'), true); return false; }
	}

	#schedulePlanningDue(run) {
		if (run.settled || run.stopping !== null || typeof run.context.onPlanningDue !== 'function') return;
		const snapshot = run.engine.snapshot();
		if (snapshot.status !== 'ACTIVE' || run.decision !== null) return;
		const timing = this.#timing(run);
		let remainingMs = timing.estimatedRemainingMs ?? timing.estimatedRemainingMsAtMost;
		let basis = timing.estimatedRemainingMs === undefined ? 'measured_bound' : 'measured_progress';
		if (run.expectedDurationMs !== undefined) {
			const expected = Math.max(0, run.expectedDurationMs - timing.elapsedMs);
			if (remainingMs === undefined || expected < remainingMs) { remainingMs = expected; basis = 'model_expected_duration'; }
		}
		if (remainingMs === undefined) { this.#clearPlanningDue(run); return; }
		remainingMs = Math.min(remainingMs, Math.max(0, run.timeoutMs - timing.elapsedMs));
		// Cold sessions need at least two seconds of useful overlap. With telemetry,
		// wait until a full measured model response can still fit before exhaustion.
		const leadMs = run.planningLeadMs ?? 2000;
		if (run.planningLeadMs === null && (timing.remainingActions !== 1 || timing.estimatedRemainingMs === undefined)) return;
		if (run.planningLeadMs === null) basis = 'final_action';
		if (run.planningDueNotified) {
			if (run.planningDueRemainingMs === null || run.planningDueRearmed || remainingMs <= Math.max(run.planningDueRemainingMs * 2, leadMs * 2)) return;
			run.planningDueRearmed = true;
			run.planningDueNotified = false;
		}
		this.#clearPlanningDue(run);
		// Less than a model response left: the notice still buys what remains, when that is worth a turn.
		if (leadMs === 0 || remainingMs < Math.min(leadMs, MIN_PLANNING_OVERLAP_MS)) return;
		run.planningDueVersion = snapshot.version;
		const delay = Math.max(0, remainingMs - leadMs);
		const timer = this.#setTimeout(() => {
			if (run.planningDueTimer !== timer) return;
			run.planningDueTimer = null;
			if (run.settled || run.stopping !== null || run.planningDueNotified) return;
			const snapshot = run.engine.snapshot();
			if (run.decision !== null || snapshot.status !== 'ACTIVE' || snapshot.version !== run.planningDueVersion) return;
			run.planningDueNotified = true;
			run.planningDueRemainingMs = remainingMs - delay;
			try { run.context.onPlanningDue(this.status(run.record), { planningLeadMs: run.planningLeadMs, basis }); }
			catch { /* planning-ahead is advisory and cannot interrupt body execution */ }
		}, delay);
		run.planningDueTimer = timer;
		run.planningDueTimer?.unref?.();
	}

	/**
	 * Moves the program's deadline out by time a reflex held the body (its action paused, not running). Bounded to the
	 * program's own timeoutMs in total. Returns the credited milliseconds.
	 */
	extendDeadline(agentId, programId, ms) {
		const run = this.#runs.get(agentId);
		if (run === undefined || run.settled || run.stopping !== null || run.programId !== programId || !Number.isFinite(ms) || ms <= 0) return 0;
		const credit = Math.min(Math.round(ms), run.timeoutMs - run.creditMs);
		if (credit <= 0) return 0;
		run.creditMs += credit;
		this.#armDeadline(run);
		return credit;
	}

	#armDeadline(run) {
		this.#clearTimeout(run.timer);
		run.timer = this.#setTimeout(() => this.#deadline(run), Math.max(0, run.startedAt + run.timeoutMs + run.creditMs - this.#now()));
		run.timer?.unref?.();
	}

	/**
	 * The program's deadline. While the model owes an answer to an urgent decision the routine is held for that answer,
	 * so the wait is credited like a reflex hold (same timeoutMs bound); otherwise the model's defence would arrive to a
	 * program that timed out while it was replying.
	 */
	#deadline(run) {
		if (run.settled || run.stopping !== null) return;
		// With the wait credited 1:1 and all credit capped at timeoutMs, the latest the deadline can fall is twice timeoutMs.
		const heldUntil = run.startedAt + 2 * run.timeoutMs;
		if (run.decision?.priority === 'urgent' && run.urgentWaitSince !== null && this.#now() < heldUntil) {
			this.#clearTimeout(run.timer);
			run.timer = this.#setTimeout(() => this.#deadline(run), heldUntil - this.#now());
			run.timer?.unref?.();
			return;
		}
		this.#return(run, { state: 'TIMED_OUT', reasonCode: 'PROGRAM_DEADLINE' }, true);
	}

	/** The urgent decision was answered or replaced by an ordinary one: credit the time the routine was held for it. */
	#settleUrgentWait(run) {
		if (run.urgentWaitSince === null) return;
		const credit = Math.max(0, Math.min(this.#now() - run.urgentWaitSince, run.timeoutMs - run.creditMs));
		run.urgentWaitSince = null;
		run.creditMs += credit;
		this.#armDeadline(run);
	}

	#timing(run) {
		const completedActions = run.actionsSucceeded + run.actionsFailed;
		const averageActionMs = completedActions === 0 ? undefined : Math.round(run.actionMs / completedActions);
		const progress = run.engine.progress();
		const activeElapsedMs = run.bodyPending && run.actionStartedAt !== null ? Math.max(0, this.#now() - run.actionStartedAt) : 0;
		let estimatedRemainingMs;
		const remainingMs = (byAction, durations) => {
			let total = 0;
			for (const [type, count] of Object.entries(byAction)) {
				if (count === 0) continue;
				const measured = run.actionDurations.get(type) ?? durations?.get(type);
				if (!measured) return undefined;
				total += count * measured.totalMs / measured.count;
			}
			return Math.max(0, Math.round(total - activeElapsedMs));
		};
		if (progress !== null) estimatedRemainingMs = remainingMs(progress.remainingByAction);
		// Where the exact continuation is unknown, its upper bound still times the planning notice (never early);
		// this agent's earlier programs supply durations for action types this one has not timed yet.
		const bound = progress === null ? run.engine.progressBound() : null;
		const boundMs = bound === null ? undefined : remainingMs(bound.remainingByActionAtMost, this.#agentDurations.get(run.record.agentId));
		return { elapsedMs: Math.max(0, this.#now() - run.startedAt), completedActions,
			...(bound === null ? {} : { remainingActionsAtMost: bound.remainingActionsAtMost, ...(boundMs === undefined ? {} : { estimatedRemainingMsAtMost: boundMs }) }),
			...(averageActionMs === undefined ? {} : { averageActionMs }),
			byAction: [...run.actionDurations].slice(-16).map(([actionType, { count, totalMs }]) => ({ actionType, count, averageMs: Math.round(totalMs / count) })),
			...(run.actionDurations.size > 16 ? { omittedActionTypes: run.actionDurations.size - 16 } : {}),
			...(progress === null ? {} : progress), ...(estimatedRemainingMs === undefined ? {} : { estimatedRemainingMs }) };
	}

	#requestDecision(run, request, notificationPriority = request?.priority) {
		if (run.settled || run.stopping !== null || request === null) return;
		if (request.trigger === 'program_exhausted' || typeof run.context.onDecision !== 'function') {
			this.#return(run, { state: 'YIELDED', reasonCode: request.trigger === 'program_exhausted' ? 'PROGRAM_EXHAUSTED' : 'MODEL_DECISION_REQUIRED',
				trigger: request.trigger, ...(request.actionFailure === undefined ? {} : { actionFailure: request.actionFailure }) });
			return;
		}
		if (request.trigger === 'resource_discovery') run.unseenDiscovery = true;
		if (run.decision !== null && run.decision.priority === 'urgent' && request.priority === 'urgent'
			&& run.decision.programVersion === request.version) {
			// Urgent facts may change faster than the model can answer. Keep the
			// already-shown handle, but bind it to the newest decision context.
			run.decision.trigger = request.trigger;
			run.decision.eventSequence = request.eventSequence;
			if (request.actionFailure === undefined) delete run.decision.actionFailure;
			else run.decision.actionFailure = request.actionFailure;
			run.unseenAttention = true;
			this.#scheduleUrgentNotification(run);
			return;
		}
		run.decision = { decisionId: `${run.programId}:decision-${++run.decisionSequence}`, programVersion: request.version,
			trigger: request.trigger, priority: request.priority, eventSequence: request.eventSequence,
			...(request.actionFailure === undefined ? {} : { actionFailure: request.actionFailure }) };
		run.notifiedDecisions = [];
		run.firstNotifiedDecision = null;
		run.unseenAttention = true;
		if (request.priority !== 'urgent') this.#settleUrgentWait(run);
		else if (run.urgentWaitSince === null) run.urgentWaitSince = this.#now();
		// The engine must finish applying the authored attention policy first.
		if (notificationPriority === 'urgent') this.#scheduleUrgentNotification(run);
		else {
			const decision = run.decision;
			queueMicrotask(() => {
				if (run.settled || run.decision !== decision) return;
				this.#notifyDecision(run, notificationPriority);
			});
		}
	}

	#scheduleUrgentNotification(run) {
		if (run.urgentNotificationQueued) return;
		run.urgentNotificationQueued = true;
		queueMicrotask(() => {
			run.urgentNotificationQueued = false;
			if (run.settled || run.decision?.priority !== 'urgent') return;
			// Several snapshots can arrive in one bridge batch. One notification uses
			// the latest refreshed handle/facts; later urgent events still notify again.
			this.#notifyDecision(run, 'urgent');
		});
	}

	/**
	 * Wakes the model for the pending decision. Ordinary attention on a routine that keeps running
	 * (nothing is paused, no action failed) is not urgent: one notification per window carries the
	 * latest facts, instead of a fresh model call for every sighting while the authored work continues.
	 * Urgent, failed or paused decisions always notify at once.
	 */
	#notifyDecision(run, notificationPriority, { reminder = false } = {}) {
		if (run.settled || run.decision === null) return;
		// A folded sighting on an idle or paused body: the model already holds this handle and answers it with the
		// newest facts, so it is told once, not once per observation.
		if (!reminder && !this.#deferrableOrdinary(run, notificationPriority) && notificationPriority !== 'urgent'
			&& run.notifiedDecisionId === run.decision.decisionId && run.ordinaryNotificationTimer === null) return;
		if (!reminder && this.#deferrableOrdinary(run, notificationPriority)) {
			const dueAt = ordinaryWindowStart(run) + this.#ordinaryAttentionIntervalMs;
			const now = this.#now();
			if (now < dueAt) {
				// A sighting folded in can move the due time earlier (a resource first seen after launch).
				if (run.ordinaryNotificationTimer === null || dueAt < run.ordinaryNotificationDueAt) {
					this.#clearOrdinaryNotification(run);
					run.ordinaryNotificationDueAt = dueAt;
					run.ordinaryNotificationTimer = this.#setTimeout(() => {
						run.ordinaryNotificationTimer = null;
						this.#notifyDecision(run, run.decision?.priority ?? 'ordinary');
					}, dueAt - now);
					run.ordinaryNotificationTimer?.unref?.();
				}
				return;
			}
			run.lastOrdinaryNotificationAt = now;
		}
		this.#clearOrdinaryNotification(run);
		this.#clearDecisionReminder(run);
		run.unseenAttention = false;
		run.unseenDiscovery = false;
		run.notifiedDecisionId = run.decision.decisionId;
		run.decision.eventSequence = run.eventSequence;
		this.#rememberNotifiedDecision(run);
		// The pending request retains its highest urgency, but later ordinary
		// discoveries must not repeatedly interrupt that same reconsideration.
		const deliveredSightings = new Map(run.resourceSightings);
		try {
			run.context.onDecision(this.status(run.record), { priority: notificationPriority });
			for (const [key, sighting] of deliveredSightings) {
				if (run.resourceSightings.get(key) === sighting) run.resourceSightings.delete(key);
			}
		}
		catch (error) { this.#return(run, failure(error, 'PROGRAM_NOTIFICATION_FAILED'), true); }
	}

	#rememberNotifiedDecision(run) {
		const snapshot = { decisionId: run.decision.decisionId, eventSequence: run.eventSequence,
			trigger: run.decision.trigger, facts: urgentFactsSnapshot(run.observation) };
		rememberNotifiedSnapshot(run, snapshot);
	}

	/** A new decision handle is owed only for a higher urgency, a changed action failure or a new urgent trigger. */
	#escalates(run, request) {
		if (!request) return false;
		return request.priority !== run.decision.priority
			|| JSON.stringify(request.actionFailure) !== JSON.stringify(run.decision.actionFailure)
			|| (request.priority === 'urgent' && request.trigger !== run.decision.trigger);
	}

	#deferrableOrdinary(run, notificationPriority) {
		if (notificationPriority === 'urgent' || run.decision?.priority === 'urgent' || run.decision?.actionFailure !== undefined) return false;
		const snapshot = run.engine.snapshot();
		// The window covers the routine's whole run, including the gap between one action's result and the next
		// dispatch. A routine whose source ran out holds the body until the model answers the pending decision, so
		// that wait must not also sit out the window.
		return snapshot.status === 'ACTIVE' && (snapshot.activeActionId !== null || snapshot.activeQueryId !== null || run.bodyPending || !snapshot.sourceExhausted);
	}

	/** Newer ordinary attention folded into the pending decision: same handle, latest trigger and facts, not yet seen. */
	#foldOrdinary(run, request) {
		if (run.decision === null || request === null || request === undefined) return;
		run.decision.trigger = request.trigger;
		run.decision.eventSequence = request.eventSequence;
		run.unseenAttention = true;
		if (request.trigger === 'resource_discovery') run.unseenDiscovery = true;
	}

	#clearOrdinaryNotification(run) {
		if (run.ordinaryNotificationTimer === null || run.ordinaryNotificationTimer === undefined) return;
		this.#clearTimeout(run.ordinaryNotificationTimer);
		run.ordinaryNotificationTimer = null;
	}

	#operationContext(record, tool, { pausedAction = false, authoredPolicy = false } = {}) {
		const run = this.#runs.get(record.agentId);
		const decision = run?.decision;
		const request = run && !run.settled ? run.engine.refreshDirectiveRequest() : null;
		// A standing order's own declared continue_and_notify was authored before any of these facts existed; the
		// fresh-facts gate guards model answers only. The order's end result reports the attention it continued past.
		const checksFacts = !authoredPolicy && decision?.priority === 'urgent' && ['continue', 'replace'].includes(tool.directive);
		const notified = checksFacts ? notifiedSnapshotForResponse(run, tool.decisionId, tool.eventSequence) : undefined;
		const changes = notified === undefined ? null : urgentFactChanges(notified, decision, run);
		return { goalRevision: record.goalRevision, pausedAction,
			program: run && { programId: run.programId, goalRevision: run.record.goalRevision, settled: run.settled, stopping: run.stopping !== null },
			response: { currentHandle: decision?.decisionId === tool.decisionId, issuedHandle: run && isIssuedDecisionId(run, tool.decisionId),
				requestAvailable: request !== null, actionFailure: request?.actionFailure !== undefined, urgent: decision?.priority === 'urgent',
				notified: authoredPolicy || notified !== undefined, material: changes?.material === true, newDanger: changes?.newDanger === true, continueUnsafe: changes?.continueUnsafe === true },
		};
	}

	operationRejection(record, tool, options = {}) {
		return nativeOperationRejection(this.#operationContext(record, tool, options), tool);
	}

	/** A completed turn still owes this answer. Pace rapid empty completions, never active inference. */
	remindDecision(record) {
		const run = this.#runs.get(record.agentId);
		if (!run || run.record.goalRevision !== record.goalRevision || run.settled || run.stopping !== null
			|| run.decision === null) return false;
		if (run.decisionReminderTimer !== null) return true;
		const decision = run.decision;
		const delay = run.remindedDecisionId === decision.decisionId ? Math.max(0, run.lastDecisionReminderAt + DECISION_REMINDER_INTERVAL_MS - this.#now()) : 0;
		const remind = () => {
			if (run.settled || run.stopping !== null || run.decision !== decision) return;
			run.remindedDecisionId = decision.decisionId;
			run.lastDecisionReminderAt = this.#now();
			this.#notifyDecision(run, decision.priority, { reminder: true });
		};
		if (delay === 0) remind();
		else {
			const timer = this.#setTimeout(() => {
				if (run.decisionReminderTimer !== timer) return;
				run.decisionReminderTimer = null;
				remind();
			}, delay);
			run.decisionReminderTimer = timer;
			timer?.unref?.();
		}
		return true;
	}

	#clearDecisionReminder(run) {
		if (run.decisionReminderTimer === null) return;
		this.#clearTimeout(run.decisionReminderTimer);
		run.decisionReminderTimer = null;
	}

	status(record, options = {}) {
		const run = this.#runs.get(record.agentId);
		if (!run || run.record.goalRevision !== record.goalRevision || run.settled) return null;
		if (options.presentDecision === true && run.decision !== null) {
			this.#clearDecisionReminder(run);
			run.decision.eventSequence = run.eventSequence;
			run.unseenAttention = false;
			this.#rememberNotifiedDecision(run);
		}
		const snapshot = run.engine.snapshot();
		const warnings = options.deliverWarnings === true && run.warnedVersion !== snapshot.version ? snapshot.warnings : [];
		if (warnings.length > 0) run.warnedVersion = snapshot.version;
		const tool = { kind: 'respond_program', programId: run.programId, ...run.decision, directive: 'continue' };
		const context = run.decision === null ? null : this.#operationContext(record, tool, options);
		return { programVersion: snapshot.version, engineState: snapshot.status, budget: programBudget(run), timing: this.#timing(run),
			...(warnings.length === 0 ? {} : { warnings }),
			...(run.decision === null ? {} : { decision: { ...structuredClone(run.decision), ...(run.resourceSightings.size === 0 ? {} : { resourceSightings: [...run.resourceSightings.values()].map(sighting => structuredClone(sighting)) }), directives: ['continue', 'replace', 'pause', 'finish'].filter(directive =>
				nativeOperationRejection(context, { ...tool, directive }) === null) } }) };
	}

	respond(record, { programId, goalRevision, decisionId, eventSequence, directive, source }, options = {}) {
		const run = this.#runs.get(record.agentId);
		const rejected = this.operationRejection(record, { kind: 'respond_program', programId, goalRevision, decisionId, eventSequence, directive }, options);
		if (rejected !== null) {
			if (rejected.code === 'STALE_PROGRAM_DECISION' && run && !run.settled && run.stopping === null && run.programId === programId
				&& run.record.goalRevision === record.goalRevision && (goalRevision === undefined || goalRevision === record.goalRevision) && !['pause', 'finish'].includes(directive)
				&& run.decision?.priority === 'urgent' && isIssuedDecisionId(run, decisionId)) {
				throw freshDecisionError(run, run.decision, notifiedSnapshotForResponse(run, decisionId, eventSequence) ?? null);
			}
			if (rejected.code === 'STALE_PROGRAM_DECISION' && (goalRevision === undefined || goalRevision === record.goalRevision)) {
				const live = run && !run.settled && run.stopping === null && run.record.goalRevision === record.goalRevision;
				if (!live || run.programId !== programId) throw codedError(rejected.code, live
					? `programId ${programId} is not the running program; the running program is ${run.programId}` : 'This program is no longer running');
				if (run.decision?.decisionId !== decisionId && !(['pause', 'finish'].includes(directive) && isIssuedDecisionId(run, decisionId))) {
					throw codedError(rejected.code, run.decision === null
						? `decisionId ${decisionId} is not pending; this program has no pending decision`
						: `decisionId ${decisionId} is not pending; pending decision: ${JSON.stringify({ decisionId: run.decision.decisionId, eventSequence: run.decision.eventSequence, trigger: run.decision.trigger })}`);
				}
			}
			throw codedError(rejected.code, rejected.message);
		}
		const request = run.engine.refreshDirectiveRequest();
		const compiled = directive === 'replace' ? parseArenaScript(source) : null;
		this.#clearDecisionReminder(run);
		run.decision = null;
		this.#settleUrgentWait(run);
		if (directive === 'replace') {
			// Replacements may wait for the current body action to acknowledge before
			// installing their next engine version. Fence the old advisory now so a
			// queued deadline callback cannot notify against obsolete authority.
			run.planningDueNotified = true;
			this.#clearPlanningDue(run);
		}
		if (directive === 'pause' || directive === 'finish') {
			this.#return(run, { state: 'YIELDED', reasonCode: directive === 'pause' ? 'MODEL_PAUSED' : 'PROGRAM_FINISH_REQUESTED',
				...(directive === 'finish' ? { finishRequested: true } : {}) }, true);
			return run.result;
		}
		// The model answered what it was shown; attention folded in after that notification is still owed to it.
		const unseen = directive === 'continue' && run.unseenAttention === true ? { trigger: request.trigger } : null;
		run.unseenAttention = false;
		run.engine.applyDirective({ ...request, directive, ...(compiled === null ? {} : { install: { programId, version: request.version + 1, compiled } }) });
		if (unseen !== null && run.decision === null && run.engine.snapshot().status === 'ACTIVE') run.engine.notifyAttention({ priority: 'ordinary', trigger: unseen.trigger });
		this.#check(run);
		return this.status(record) ?? { state: 'ENDED' };
	}

	cancel(agentId, reason = 'PROGRAM_CANCELLED') {
		const run = this.#runs.get(agentId);
		if (!run) return Promise.resolve({ state: 'CANCELLED', reasonCode: 'NO_ACTIVE_PROGRAM' });
		this.#return(run, { state: 'CANCELLED', reasonCode: boundedReason(reason, 'PROGRAM_CANCELLED') }, true);
		return run.result;
	}

	expire(record, programId) {
		const run = this.#runs.get(record.agentId);
		if (!run || run.record.goalRevision !== record.goalRevision || run.programId !== programId) return Promise.resolve(null);
		// Do not overwrite cancellation or a deadline already being acknowledged.
		if (run.stopping === null) this.#return(run, { state: 'TIMED_OUT', reasonCode: 'PROGRAM_DEADLINE' }, true);
		return run.result;
	}

	async #dispatch(run, suppliedCommand) {
		if (run.settled) return;
		if (run.stopping !== null || run.actions >= run.maxActions) {
			this.#return(run, run.stopping ?? { state: 'YIELDED', reasonCode: 'PROGRAM_ACTION_LIMIT' }, true);
			return;
		}
		let command;
		try { command = canonicalCommand(suppliedCommand); }
		catch (error) { this.#return(run, failure(error, 'INVALID_PROGRAM_ACTION'), true); return; }
		run.actions++;
		run.bodyPending = true;
		run.pendingActionId = command.actionId;
		run.actionStartedAt = this.#now();
		run.lastActionObservationSequence = null;
		queueMicrotask(() => this.#schedulePlanningDue(run));
		let result;
		try { result = freezeRuntimeResult(await run.context.executeAction(command)); }
		catch (error) {
			if (run.settled) return;
			run.bodyPending = false;
			void Promise.resolve().then(() => run.context.cancelAction(command.actionId, 'PROGRAM_ACTION_UNCERTAIN')).catch(() => {});
			this.#return(run, { state: 'UNKNOWN', reasonCode: boundedReason(error?.code, 'PROGRAM_ACTION_UNCERTAIN') }, true);
			return;
		}
		if (run.settled) return;
		run.bodyPending = false;
		if (!TERMINAL.has(result.state) || typeof result.reasonCode !== 'string' || result.reasonCode.length > 128) {
			void Promise.resolve().then(() => run.context.cancelAction(command.actionId, 'INVALID_ACTION_RESULT')).catch(() => {});
			this.#return(run, { state: 'UNKNOWN', reasonCode: 'INVALID_ACTION_RESULT' }, true); return;
		}
		if (result.state === 'SUCCEEDED') run.actionsSucceeded++;
		else run.actionsFailed++;
		const durationMs = Number.isFinite(result.durationMs) && result.durationMs >= 0 ? Math.round(result.durationMs) : Math.max(0, this.#now() - run.actionStartedAt);
		run.actionMs += durationMs;
		const durations = run.actionDurations.get(command.action.type) ?? { count: 0, totalMs: 0 };
		durations.count++; durations.totalMs += durationMs;
		run.actionDurations.set(command.action.type, durations);
		const agentDurations = this.#agentDurations.get(run.record.agentId) ?? new Map();
		const typed = agentDurations.get(command.action.type) ?? { count: 0, totalMs: 0 };
		// Recent programs weigh most: halve an old tally instead of averaging the whole game.
		if (typed.count >= 32) { typed.count /= 2; typed.totalMs /= 2; }
		typed.count++; typed.totalMs += durationMs;
		agentDurations.set(command.action.type, typed);
		this.#agentDurations.set(run.record.agentId, agentDurations);
		const evidence = breakOutcomeEvidence(result);
		const explanation = receiptMessage(result, evidence);
		// Only the newest explanation is kept, so a wake carries at most one bounded message however many steps failed.
		if (explanation.message !== undefined) for (const prior of run.receipts) delete prior.message;
		run.receipts.push({ actionId: command.actionId, actionType: command.action.type, sourceStepId: command.provenance.stepId,
			state: result.state, reasonCode: result.reasonCode, durationMs,
			...(command.adjusted === undefined ? {} : { adjusted: command.adjusted }),
			...(result.cause === undefined ? {} : { cause: result.cause }),
			...(typeof result.actionId === 'string' ? { bodyActionId: result.actionId } : {}),
			...(typeof result.executionStarted === 'boolean' ? { executionStarted: result.executionStarted } : {}),
			...(typeof result.physicalAttempted === 'boolean' ? { physicalAttempted: result.physicalAttempted } : {}), ...evidence,
			...explanation });
		if (run.receipts.length > 64) run.receipts.shift();
		if (run.stopping !== null) {
			run.engine.suspend(run.stopping.reasonCode);
			run.engine.ingestActionResult({ actionId: command.actionId, state: result.state, reasonCode: result.reasonCode, ...(result.cause === undefined ? {} : { cause: result.cause }), eventSequence: run.eventSequence, ...partialCraftEvidence(result, explanation), ...breakOutcomeScriptEvidence(result) });
			this.#check(run); return;
		}
		let fresh;
		try {
			// A sample requested during the action cannot prove its terminal effects.
			// Supersede its result, failure and cleanup instead of waiting on it.
			run.refreshGeneration++;
			run.refresh = null;
			fresh = result.observation !== undefined && Number.isSafeInteger(result.eventSequence) ? result : await this.#refresh(run, 'terminal').promise;
			if (!fresh || !Number.isSafeInteger(fresh.eventSequence) || fresh.eventSequence <= command.provenance.eventSequence) throw codedError('FRESH_OBSERVATION_REQUIRED', 'Observe action effects before continuing the program');
			if (run.settled) return;
			if (fresh.eventSequence > run.eventSequence) this.onObservation(run.record, fresh);
			if (run.settled) return;
			if (run.stopping !== null) run.engine.suspend(run.stopping.reasonCode);
			run.lastActionObservationSequence = fresh.eventSequence;
			run.engine.ingestActionResult({ actionId: command.actionId, state: result.state, reasonCode: result.reasonCode, ...(result.cause === undefined ? {} : { cause: result.cause }), eventSequence: fresh.eventSequence, ...actionFailureEvidence(result), ...partialCraftEvidence(result, explanation), ...breakOutcomeScriptEvidence(result) });
			this.#check(run);
		} catch (error) { this.#return(run, { state: 'YIELDED', reasonCode: boundedReason(error?.code, 'FRESH_OBSERVATION_REQUIRED') }, true); }
		finally { this.#scheduleObservation(run); }
	}

	async #query(run, { queryId, operation, query, authorship }) {
		let value;
		try {
			if (operation === 'inspect') value = await run.context.inspect?.(query) ?? { state: 'FAILED', reasonCode: 'INSPECTION_UNAVAILABLE' };
			else if (operation === 'taskMemory') {
				const tool = normalizeMinecraftToolCall('taskMemory', query);
				const { kind, ...args } = tool;
				value = withAdjustments(await run.context.memoryOperation?.({ operation: 'task', arguments: args, provenance: authorship }) ?? { state: 'FAILED', reasonCode: 'MEMORY_UNAVAILABLE' }, toolAdjustments(tool));
			}
			else {
				const normalized = normalizeMinecraftToolCall(operation === 'remember' ? 'notebook' : 'queryMemory', query);
				const args = operation === 'remember' ? { key: normalized.key, text: normalized.text }
					: { kind: normalized.memoryKind, limit: normalized.limit, ...(normalized.offset === undefined ? {} : { offset: normalized.offset }), ...(normalized.text === undefined ? {} : { text: normalized.text }) };
				value = withAdjustments(await run.context.memoryOperation?.({ operation: operation === 'remember' ? 'write' : 'query', arguments: args, provenance: authorship })
					?? { state: 'FAILED', reasonCode: 'MEMORY_UNAVAILABLE' }, toolAdjustments(normalized));
			}
		} catch (error) { value = failure(error, 'QUERY_FAILED'); }
		if (run.settled || run.engine.snapshot().activeQueryId !== queryId) return;
		try { run.engine.ingestQueryResult({ queryId, value }); this.#check(run); }
		catch (error) { this.#return(run, failure(error, 'INVALID_QUERY_RESULT'), true); }
	}

	async #cancelBody(run, actionId) {
		if (run.settled || !run.bodyPending || run.pendingActionId !== actionId) return;
		try { await run.context.cancelAction(actionId, run.stopping?.reasonCode ?? 'MODEL_AUTHORED_INTERRUPT'); }
		catch (error) {
			// The terminal action receipt can arrive before the cancel transport fails.
			// Once acknowledged, that old failure cannot invalidate a newer body action.
			if (run.settled || !run.bodyPending || run.pendingActionId !== actionId) return;
			this.#finish(run, { state: 'UNKNOWN', reasonCode: boundedReason(error?.code, 'PROGRAM_CANCEL_UNCERTAIN') });
		}
	}

	#return(run, outcome, cancel = false) {
		if (run.settled) return;
		run.stopping = run.stopping ?? outcome;
		if (cancel) run.stopping = outcome;
		this.#clearPlanningDue(run);
		if (cancel || !run.bodyPending) run.engine.suspend(run.stopping.reasonCode);
		if (run.bodyPending && cancel && run.cancellationTimer === null) {
			run.cancellationTimer = this.#setTimeout(() => this.#finish(run, { state: 'UNKNOWN', reasonCode: 'PROGRAM_CANCEL_ACK_TIMEOUT' }), this.#cancellationTimeoutMs);
			run.cancellationTimer?.unref?.();
		}
		this.#check(run);
	}

	#check(run) {
		if (run.settled) return;
		if (run.stopping === null && run.decision !== null) {
			const request = run.engine.refreshDirectiveRequest();
			// The shared engine coalesces failures behind an outstanding model request.
			// Publish that changed decision without treating ordinary progress as one.
			// A different ordinary trigger is new facts for the same decision, not a new handle.
			if (this.#escalates(run, request)) this.#requestDecision(run, request);
			else if (request && request.trigger !== run.decision.trigger) this.#foldOrdinary(run, request);
			// A deferred ordinary notification is due now if the body went idle or a folded trigger moved its window:
			// tell the model once. An urgent notification already queued carries the same handle and the latest facts.
			if (run.decision !== null && run.ordinaryNotificationTimer !== null && !run.urgentNotificationQueued) this.#notifyDecision(run, run.decision.priority);
		}
		const snapshot = run.engine.snapshot();
		if (run.stopping !== null && !run.bodyPending) this.#finish(run, run.stopping);
		else if (snapshot.status === 'PAUSED') this.#finish(run, { state: 'YIELDED', reasonCode: 'PROGRAM_CHECKPOINT', ...terminalSummary(snapshot) });
		else if (snapshot.status === 'FINISHED') this.#finish(run, { state: 'YIELDED', reasonCode: 'PROGRAM_FINISH_REQUESTED', finishRequested: true, ...terminalSummary(snapshot) });
		else if (snapshot.status === 'ACTIVE' && snapshot.activeActionId === null && snapshot.activeQueryId === null && snapshot.pendingRequestTrigger === null) {
			this.#finish(run, { state: 'YIELDED', reasonCode: 'PROGRAM_IDLE' });
		}
	}

	#finish(run, outcome) {
		if (run.settled) return;
		run.settled = true;
		this.#clearTimeout(run.timer);
		this.#clearDecisionReminder(run);
		this.#clearPlanningDue(run);
		this.#clearOrdinaryNotification(run);
		if (run.observationTimer !== null) this.#clearTimeout(run.observationTimer);
		if (run.cancellationTimer !== null) this.#clearTimeout(run.cancellationTimer);
		this.#runs.delete(run.record.agentId);
		const snapshot = run.engine.snapshot();
		const budget = programBudget(run);
		run.engine.dispose();
		run.resolve({ ...outcome, programId: run.programId, programVersion: snapshot.version, actions: run.actions, actionsSucceeded: run.actionsSucceeded, actionsFailed: run.actionsFailed, timing: this.#timing(run), budget, receipts: run.receipts, eventSequence: snapshot.eventSequence,
			observation: run.observation, freshness: { fresh: run.lastActionObservationSequence !== null && run.eventSequence >= run.lastActionObservationSequence,
				eventSequence: run.eventSequence, observedAtEpochMs: run.observation.observedAtEpochMs ?? null,
				...(run.observation.continuity?.rememberedSections === undefined ? {} : { rememberedSections: run.observation.continuity.rememberedSections }) },
			...(run.resourceSightings.size === 0 ? {} : { resourceSightings: [...run.resourceSightings.values()] }), ...(run.decision === null ? {} : { decision: structuredClone(run.decision) }), ...(run.actions > 64 ? { omittedReceipts: run.actions - run.receipts.length } : {}) });
	}

	#clearPlanningDue(run) {
		if (run.planningDueTimer === null) return;
		this.#clearTimeout(run.planningDueTimer);
		run.planningDueTimer = null;
	}
}

// Script commands and world queries share one per-version allowance (reset on replace); the run's physical
// actions are a separate run-wide maxActions allowance. Both are read-only views here, never new limits.
function programBudget(run) {
	const commands = run.engine.commandBudget() ?? { commandsUsed: 0, commandsRemaining: DEFAULT_ARENA_SCRIPT_LIMITS.commandsPerProgram, queriesUsed: 0 };
	return { ...commands, actionsUsed: run.actions, actionsRemaining: Math.max(0, run.maxActions - run.actions) };
}

function canonicalCommand(command) {
	const type = command.action.type;
	const supplied = command.action.arguments;
	const args = supplied !== null && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied
		: ['wait', 'use_item', 'block_with_shield'].includes(type) ? { durationMs: supplied } : {};
	if (Object.hasOwn(args, 'type')) throw codedError('INVALID_ACTION', 'Action arguments cannot override action type');
	let action;
	try { action = validateAction({ ...args, type }); }
	catch (error) {
		const contract = minecraftCapabilities().actions.find(row => row.actionType === type);
		throw codedError(error.code ?? 'INVALID_ACTION', `player.${type.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}: ${error.message}; legal fields: ${contract?.fields.join(', ')}; required: ${contract?.requiredFields.join(', ')}`);
	}
	const { type: validatedType, ...normalized } = action;
	return Object.freeze({ ...command, action: Object.freeze({ type: validatedType, arguments: Object.freeze(normalized) }) });
}

const CONTINUE_HEALTH_DROP_LIMIT = 4;
const CONTINUE_AIR_DROP_LIMIT = 20;
const CONTINUE_THREAT_DISTANCE_LIMIT = 2;
// At three hearts, another bounded two-heart loss could leave only one heart.
const CONTINUE_HEALTH_FLOOR = CONTINUE_HEALTH_DROP_LIMIT + 2;
// Air is measured in ticks at 20 per second, so 60 leaves about three seconds.
const CONTINUE_MIN_AIR = 60;
const CONTINUE_CLOSE_THREAT_DISTANCE = 3;
const INLINE_THREAT_LIMIT = 8;
// The body's own threat range (CombatPlanning.THREAT_RANGE): a newly seen hostile beyond it that is not targeting the
// player does not make a defensive reply stale.
const REPLY_THREAT_RANGE = 16;
const nearOrTargeting = (threat) => threat.targeting === true || threat.swelling === true || !Number.isFinite(threat.distance)
	|| threat.distance <= REPLY_THREAT_RANGE;
// A shot in flight lands or misses within a second, well inside any reply's latency; only its shooter is a danger a
// reply can answer. A blaze volley is three new projectiles every few seconds, so counting them bounced every reply.
const PROJECTILE_TYPE = /(?:arrow|trident|fireball|wither_skull|shulker_bullet|llama_spit|wind_charge|firework_rocket|snowball|egg|potion)$/i;
const isProjectile = (threat) => PROJECTILE_TYPE.test(threat.type ?? '');
// Shown threats whose hits set the player on fire: catching fire from them is that shown danger landing its hit.
const FIRE_SHOOTER_TYPE = /(?:blaze|ghast|fireball)$/i;
// A continue may cover up to two hearts, one second of air, or two blocks of approach from the notified facts.
const HOSTILE_ENTITY_TYPE = /(?:zombie|skeleton|creeper|spider|enderman|witch|pillager|vindicator|evoker|ravager|phantom|guardian|blaze|ghast|wither|warden|hoglin|piglin|silverfish|endermite|slime|magma_cube|shulker|vex|breeze|drowned|husk|stray|bogged|illusioner|giant|dragon|zoglin|(?:spectral_)?arrow|trident|fireball|wither_skull|shulker_bullet|llama_spit|wind_charge|projectile|tnt|firework_rocket)/i;

function urgentFactsSnapshot(observation) {
	const player = observation?.player ?? {};
	const threats = new Map();
	const addThreat = (entry, assumeThreat = false) => {
		if (entry === null || typeof entry !== 'object') return;
		const uuid = entry.uuid ?? entry.stableId ?? entry.id;
		if (typeof uuid !== 'string') return;
		const type = typeof entry.type === 'string' ? entry.type : typeof entry.typeId === 'string' ? entry.typeId : null;
		const threat = assumeThreat || entry.hostile === true || entry.targetingAgent === true || entry.targeting === true
			|| entry.swelling === true || HOSTILE_ENTITY_TYPE.test(type ?? '');
		if (!threat) return;
		const previous = threats.get(uuid) ?? {};
		const distance = threatDistance(entry, player);
		threats.set(uuid, { ...previous, uuid, ...(type === null ? {} : { type }),
			...(typeof entry.targeting === 'boolean' || typeof entry.targetingAgent === 'boolean' ? { targeting: entry.targeting ?? entry.targetingAgent } : {}),
			...(typeof entry.swelling === 'boolean' ? { swelling: entry.swelling } : {}),
			...(Number.isFinite(entry.fuse) ? { fuse: entry.fuse } : {}),
			...(distance === null ? {} : { distance }),
		});
	};
	for (const entity of Array.isArray(observation?.entities) ? observation.entities : []) addThreat(entity);
	for (const entry of Array.isArray(observation?.threats?.entries) ? observation.threats.entries : []) addThreat(entry, true);
	for (const entry of Array.isArray(player.threats) ? player.threats : []) addThreat(entry, true);
	addThreat(observation?.threats?.threat, true);
	addThreat(player.threat, true);
	const lastAttacker = player.lastAttacker && typeof player.lastAttacker.uuid === 'string'
		? { uuid: player.lastAttacker.uuid, ...(typeof player.lastAttacker.type === 'string' ? { type: player.lastAttacker.type } : {}) }
		: null;
	if (lastAttacker !== null) addThreat(lastAttacker, true);
	return {
		health: finiteValue(player.health), air: finiteValue(player.air ?? player.airSupply), lastAttacker,
		onFire: onFireValue(player),
		threats: [...threats.values()], hazards: [...hazardKeys(observation)].sort(),
		dimension: observation?.world?.dimension ?? null, ready: observation?.ready ?? null, status: observation?.status ?? null,
	};
}

function urgentFactChanges(notified, decision, run, { continueOnly = false } = {}) {
	const before = notified.facts;
	const after = urgentFactsSnapshot(run.observation);
	const facts = {};
	const healthUnknownChanged = (before.health === null) !== (after.health === null);
	const airUnknownChanged = (before.air === null) !== (after.air === null);
	const healthDrop = before.health === null || after.health === null ? 0 : before.health - after.health;
	const airDrop = before.air === null || after.air === null ? 0 : before.air - after.air;
	const lowRemainingHealth = after.health !== null && after.health <= CONTINUE_HEALTH_FLOOR;
	const largeRelativeHealthDrop = after.health !== null && healthDrop > after.health / 2;
	const criticalAir = after.air !== null && (after.air <= 0 || after.air < CONTINUE_MIN_AIR);
	if (healthUnknownChanged || healthDrop !== 0 || lowRemainingHealth || largeRelativeHealthDrop) {
		facts.health = { notified: before.health, current: after.health, ...(healthUnknownChanged ? {} : { droppedBy: healthDrop }),
			...(lowRemainingHealth ? { lowRemainingHealth: true } : {}), ...(largeRelativeHealthDrop ? { largeRelativeDrop: true } : {}) };
	}
	if (airUnknownChanged || airDrop !== 0 || criticalAir) facts.air = { notified: before.air, current: after.air,
		...(airUnknownChanged ? {} : { droppedBy: airDrop }), ...(criticalAir ? { critical: true } : {}) };
	if (notified.trigger !== decision.trigger) facts.triggerChanged = { notified: notified.trigger, current: decision.trigger };
	if (JSON.stringify(before.lastAttacker) !== JSON.stringify(after.lastAttacker)) facts.lastAttacker = after.lastAttacker;
	const newFire = after.onFire === true && before.onFire !== true;
	if (newFire) facts.onFire = { notified: before.onFire, current: true };
	const oldThreats = new Map(before.threats.map((entry) => [entry.uuid, entry]));
	const newThreats = after.threats.filter((entry) => !oldThreats.has(entry.uuid));
	const changedThreats = [];
	for (const current of after.threats) {
		const old = oldThreats.get(current.uuid);
		if (old === undefined) continue;
		const changed = {};
		if (old.type !== current.type) changed.type = { notified: old.type, current: current.type };
		if (current.swelling === true && old.swelling !== true) changed.swelling = true;
		if (current.targeting === true && old.targeting !== true) changed.targeting = true;
		if (Number.isFinite(old.fuse) && Number.isFinite(current.fuse) && current.fuse < old.fuse) changed.fuse = { notified: old.fuse, current: current.fuse };
		if (Number.isFinite(old.distance) && Number.isFinite(current.distance) && old.distance - current.distance > CONTINUE_THREAT_DISTANCE_LIMIT) {
			changed.distance = { notified: old.distance, current: current.distance };
		}
		if (Number.isFinite(current.distance) && current.distance <= CONTINUE_CLOSE_THREAT_DISTANCE
			&& (!Number.isFinite(old.distance) || current.distance < old.distance)) changed.closeApproach = true;
		if (Object.keys(changed).length > 0) changedThreats.push({ uuid: current.uuid, type: current.type, changes: changed });
	}
	if (newThreats.length > 0) facts.newThreats = newThreats;
	if (changedThreats.length > 0) facts.changedThreats = changedThreats;
	const oldHazards = new Set(before.hazards);
	const newHazards = after.hazards.filter((hazard) => !oldHazards.has(hazard));
	if (newHazards.length > 0) facts.newHazards = newHazards;
	if (before.dimension !== after.dimension) facts.dimension = { notified: before.dimension, current: after.dimension };
	if (before.ready !== after.ready || before.status !== after.status) facts.playerStatus = { notified: before.status, current: after.status, ready: after.ready };
	// A replacement is the model's own answer to the danger it was shown. The same harm getting worse while it
	// replied (air or health falling, drowning turning into drowning damage) is what that answer addresses; only a
	// danger it was not shown makes it stale. Otherwise a reply slower than one second of drowning never lands.
	// The threat it was shown closing in or landing its hit is that same danger, and a mob that appeared far off and is
	// not after the player is not one the reply had to answer: in a fortress both happen within any reply's latency.
	const newAttacker = before.lastAttacker?.uuid !== after.lastAttacker?.uuid && after.lastAttacker !== null;
	const shownFireShooter = before.threats.some((threat) => FIRE_SHOOTER_TYPE.test(threat.type ?? ''));
	const newDanger = healthUnknownChanged || airUnknownChanged || (newFire && !shownFireShooter)
		|| (newAttacker && !oldThreats.has(after.lastAttacker.uuid))
		|| newThreats.some((threat) => !isProjectile(threat) && nearOrTargeting(threat)) || changedThreats.some(({ changes }) => changes.type || changes.swelling || changes.targeting || changes.fuse)
		|| newHazards.length > 0 || before.dimension !== after.dimension;
	return {
		facts,
		continueUnsafe: lowRemainingHealth || largeRelativeHealthDrop || criticalAir,
		newDanger,
		material: notified.trigger !== decision.trigger || healthUnknownChanged || airUnknownChanged
			|| (continueOnly && (lowRemainingHealth || largeRelativeHealthDrop || criticalAir)) || newFire
			|| healthDrop > CONTINUE_HEALTH_DROP_LIMIT || airDrop > CONTINUE_AIR_DROP_LIMIT
			|| (before.lastAttacker?.uuid !== after.lastAttacker?.uuid && after.lastAttacker !== null)
			|| newThreats.length > 0 || changedThreats.length > 0 || newHazards.length > 0
			|| before.dimension !== after.dimension || before.ready !== after.ready || before.status !== after.status,
	};
}

/**
 * The model wrote the routine from the facts it had at launch, so its own progress joins the window from launch. A
 * resource first seen after launch is not among those facts: until the model is told, it waits only behind an earlier
 * wake's window, even if routine attention folds in after it.
 */
function ordinaryWindowStart(run) {
	if (run.unseenDiscovery) return run.lastOrdinaryNotificationAt;
	return Math.max(run.lastOrdinaryNotificationAt, run.launchedAt);
}

function freshDecisionError(run, decision, notified) {
	const currentFacts = urgentFactsSnapshot(run.observation);
	const changes = notified === null ? null : urgentFactChanges(notified, decision, run).facts;
	const exposedFacts = limitInlineThreatFacts(changes && Object.keys(changes).length > 0 ? changes : {
		health: currentFacts.health, air: currentFacts.air, lastAttacker: currentFacts.lastAttacker, onFire: currentFacts.onFire,
		threats: currentFacts.threats, hazards: currentFacts.hazards, dimension: currentFacts.dimension,
		ready: currentFacts.ready, status: currentFacts.status,
	});
	const freshDecision = {
		decisionId: decision.decisionId,
		eventSequence: run.eventSequence,
		trigger: decision.trigger,
		facts: exposedFacts,
	};
	decision.eventSequence = run.eventSequence;
	const snapshot = { decisionId: decision.decisionId, eventSequence: run.eventSequence, trigger: decision.trigger,
		facts: freshDecisionSnapshotFacts(notified, currentFacts, exposedFacts) };
	run.notifiedDecisionId = decision.decisionId;
	rememberNotifiedSnapshot(run, snapshot);
	const error = codedError('STALE_PROGRAM_DECISION', `New danger facts arrived after this decision. Fresh decision: ${JSON.stringify(freshDecision)}`);
	error.freshDecision = freshDecision;
	return error;
}

const HAZARD_BLOCK = /lava|fire|magma|tnt/i;
const ROUTINE_BODY_STATUS = new Set([null, 'IDLE', 'STARTING', 'PLANNING', 'ACTING', 'PAUSED', 'COMPLETED']);
function hazardKeys(observation) {
	const keys = new Set();
	for (const block of Array.isArray(observation?.blocks) ? observation.blocks : []) {
		const id = block?.blockId ?? block?.id;
		if (typeof id === 'string' && HAZARD_BLOCK.test(id)) keys.add(`${id}@${block.x},${block.y},${block.z}`);
	}
	return keys;
}
const finiteValue = (value) => (Number.isFinite(value) ? value : null);
function threatDistance(entry, player) {
	const directDistance = finiteValue(entry.distance);
	if (directDistance !== null) return directDistance;
	const squaredDistance = finiteValue(entry.distanceSquared);
	if (squaredDistance !== null && squaredDistance >= 0) return Math.sqrt(squaredDistance);
	const from = entry.position ?? entry;
	const to = player.position ?? player;
	const coordinates = ['x', 'y', 'z'].map((axis) => [finiteValue(from?.[axis]), finiteValue(to?.[axis])]);
	if (coordinates.some(([left, right]) => left === null || right === null)) return null;
	return Math.hypot(...coordinates.map(([left, right]) => left - right));
}
function rememberNotifiedSnapshot(run, snapshot) {
	run.notifiedDecisions.push(snapshot);
	if (run.notifiedDecisions.length > 8) run.notifiedDecisions.shift();
	// Keep the first shown facts after the rolling history evicts later snapshots.
	if (run.firstNotifiedDecision?.decisionId !== snapshot.decisionId) run.firstNotifiedDecision = snapshot;
}
function notifiedSnapshotForResponse(run, decisionId, eventSequence) {
	const snapshots = run.notifiedDecisions.filter((entry) => entry.decisionId === decisionId);
	if (run.firstNotifiedDecision?.decisionId === decisionId
		&& !snapshots.some((entry) => entry.eventSequence === run.firstNotifiedDecision.eventSequence)) snapshots.push(run.firstNotifiedDecision);
	snapshots.sort((left, right) => left.eventSequence - right.eventSequence);
	if (eventSequence === undefined) return snapshots[0];
	if (!Number.isSafeInteger(eventSequence) || eventSequence > run.eventSequence) return undefined;
	// A status can carry a folded sequence; use the nearest earlier facts the model was shown.
	return snapshots.filter((entry) => entry.eventSequence <= eventSequence).at(-1);
}
function limitInlineThreatFacts(facts) {
	let remaining = INLINE_THREAT_LIMIT;
	let omittedThreats = 0;
	const bounded = { ...facts };
	for (const field of ['newThreats', 'changedThreats', 'threats']) {
		if (!Array.isArray(bounded[field])) continue;
		const entries = bounded[field];
		bounded[field] = entries.slice(0, remaining);
		remaining -= bounded[field].length;
		omittedThreats += entries.length - bounded[field].length;
	}
	if (omittedThreats > 0) bounded.omittedThreats = omittedThreats;
	return bounded;
}
function freshDecisionSnapshotFacts(notified, current, exposed) {
	const facts = notified === null
		? { health: null, air: null, lastAttacker: null, onFire: null, threats: [], hazards: [], dimension: null, ready: null, status: null }
		: { ...notified.facts, threats: [...notified.facts.threats], hazards: [...notified.facts.hazards] };
	for (const field of ['health', 'air', 'lastAttacker', 'onFire', 'dimension', 'ready', 'status']) {
		if (Object.hasOwn(exposed, field)) facts[field] = current[field];
	}
	if (Array.isArray(exposed.hazards)) facts.hazards = [...current.hazards];
	else if (Array.isArray(exposed.newHazards)) facts.hazards = [...new Set([...facts.hazards, ...exposed.newHazards])];
	if (Object.hasOwn(exposed, 'playerStatus')) {
		facts.ready = current.ready;
		facts.status = current.status;
	}
	// Omitted rows stay unseen so a retry cannot authorize threats absent from the inline response.
	const currentThreats = new Map(current.threats.map((entry) => [entry.uuid, entry]));
	const knownThreats = new Map(facts.threats.map((entry) => [entry.uuid, entry]));
	for (const field of ['newThreats', 'changedThreats', 'threats']) {
		for (const row of Array.isArray(exposed[field]) ? exposed[field] : []) {
			const currentThreat = currentThreats.get(row.uuid);
			if (currentThreat !== undefined) knownThreats.set(row.uuid, currentThreat);
		}
	}
	facts.threats = [...knownThreats.values()];
	return facts;
}
function onFireValue(player) {
	return typeof player?.onFire === 'boolean' ? player.onFire : typeof player?.fire === 'boolean' ? player.fire : null;
}
/** Facts that must reach the model at once even when the routine itself keeps running. */
export function hazardEdge(previous, next) {
	if (previous === null || typeof previous !== 'object' || next === null || typeof next !== 'object') return false;
	const before = hazardKeys(previous);
	for (const key of hazardKeys(next)) if (!before.has(key)) return true;
	const health = [finiteValue(previous.player?.health), finiteValue(next.player?.health)];
	if (health[0] !== null && health[1] !== null && health[1] < health[0]) return true;
	const air = [finiteValue(previous.player?.air ?? previous.player?.airSupply), finiteValue(next.player?.air ?? next.player?.airSupply)];
	if (air[0] !== null && air[1] !== null && air[1] < air[0]) return true;
	if (onFireValue(previous.player) !== true && onFireValue(next.player) === true) return true;
	if ((previous.world?.dimension ?? null) !== (next.world?.dimension ?? null)) return true;
	if (previous.ready !== next.ready) return true;
	// The body's own lifecycle (STARTING between actions, ACTING during one) flips on every action and is no hazard.
	const status = [previous.status ?? null, next.status ?? null];
	if (JSON.stringify(status[0]) !== JSON.stringify(status[1]) && !status.every((value) => ROUTINE_BODY_STATUS.has(value))) return true;
	return false;
}

function programObservation(observation) {
	return observation && Object.hasOwn(observation, 'ready') && (Object.hasOwn(observation, 'position') || observation.ready === false)
		? adaptObservation(observation) : observation;
}
function isIssuedDecisionId(run, decisionId) {
	const prefix = `${run.programId}:decision-`;
	if (typeof decisionId !== 'string' || !decisionId.startsWith(prefix)) return false;
	const suffix = decisionId.slice(prefix.length);
	if (!/^[1-9]\d*$/.test(suffix)) return false;
	const sequence = Number(suffix);
	return Number.isSafeInteger(sequence) && sequence > 0 && sequence <= run.decisionSequence;
}
function validateRecord(record) {
	for (const key of ['agentId', 'provider', 'model', 'reasoningEffort']) if (typeof record?.[key] !== 'string' || record[key].trim().length === 0 || record[key].length > 256) throw new TypeError(`record.${key} is required`);
	integer(record.goalRevision, 'goalRevision', 0, Number.MAX_SAFE_INTEGER);
}
function integer(value, field, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field} must be ${minimum}..${maximum}`); }
// A failed or drop-less step keeps the body's own explanation (blocker, required tool, carried slot), as a single
// tool call shows it; ordinary successes stay byte-free. The cap counts JSON-encoded bytes, escapes included, so one
// message adds at most MAX_RECEIPT_MESSAGE_BYTES plus its key to a wake.
export const MAX_RECEIPT_MESSAGE_BYTES = 160;
function receiptMessage(result, evidence) {
	if (typeof result.message !== 'string' || result.message.length === 0) return {};
	// A partial craft succeeded with less than was asked; its explanation ("crafted 4 of 12: ...") is the only record of why.
	if (result.state === 'SUCCEEDED' && evidence.correctTool !== false && evidence.noDropsSeen !== true
		&& result.reasonCode !== 'CRAFT_PARTIAL') return {};
	let message = '';
	let used = 0;
	for (const character of result.message) {
		const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
		if (used + bytes > MAX_RECEIPT_MESSAGE_BYTES) break;
		message += character;
		used += bytes;
	}
	return { message };
}

/** The authored checkpoint/finish text, bounded like a receipt message so a wake stays small. */
function terminalSummary(snapshot) {
	if (typeof snapshot.terminalSummary !== 'string' || snapshot.terminalSummary.length === 0) return {};
	const { message } = receiptMessage({ state: 'FAILED', message: snapshot.terminalSummary }, {});
	return message === undefined ? {} : { summary: message };
}

/** The bounded partial-craft explanation as script `detail`, so an authored routine sees how much was actually made. */
function partialCraftEvidence(result, explanation) {
	return result.state === 'SUCCEEDED' && result.reasonCode === 'CRAFT_PARTIAL' && typeof explanation.message === 'string'
		? { detail: explanation.message } : {};
}

function boundedReason(value, fallback) { return typeof value === 'string' && /^[A-Z0-9_]{1,128}$/.test(value) ? value : fallback; }
// The producer's text becomes failure.blockedBy at presentation (A11 F1: INVALID_FIELD faceMode read "not reported").
function failure(error, fallback) {
	const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message.slice(0, 512) : undefined;
	return { state: 'FAILED', reasonCode: boundedReason(error?.code, fallback), ...(message === undefined ? {} : { message }) };
}
/**
 * What the body reported about a failed authored action: whether it was rejected without any attempt
 * and the concrete reason for authored handlers and failure-limit decisions.
 */
function actionFailureEvidence(result) {
	if (result.state === 'SUCCEEDED') return {};
	const observation = result.actionObservation;
	const noEffect = result.executionStarted === false && result.physicalAttempted === false;
	const evidence = {};
	if (typeof result.executionStarted === 'boolean' && typeof result.physicalAttempted === 'boolean') evidence.noEffect = noEffect;
	const looked = observation?.lookedAt;
	const target = observation?.target?.kind === 'block' ? observation.target.position : null;
	const crosshair = target && looked?.type === 'block' && looked.position
		&& ['x', 'y', 'z'].some((axis) => looked.position[axis] !== target[axis])
		? `crosshair on ${looked.id} at ${looked.position.x},${looked.position.y},${looked.position.z}` : null;
	const detail = [typeof result.message === 'string' ? result.message.slice(0, 160) : null, crosshair].filter(Boolean).join('; ');
	if (detail.length > 0) evidence.detail = Buffer.from(detail, 'utf8').subarray(0, 240).toString('utf8').replace(/ï¿½+$/, '');
	return evidence;
}
function codedError(code, message) { return Object.assign(new Error(message), { code }); }
