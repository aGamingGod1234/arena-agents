// A dimension change is protected too: the arrival facts must reach a turn that keeps calling tools (d14-iron-e walked
// 55 s in the Nether, into lava, while its queued arrival wake waited for the turn to end).
const PROTECTED_TRIGGERS = new Set(['damage', 'threat', 'fire', 'lava', 'lava_flow', 'drowning', 'suffocation', 'fall', 'projectile', 'action_failure', 'dimension_changed']);
const FAILURES = new Set(['FAILED', 'TIMED_OUT', 'REJECTED', 'CANCELLED']);
const snapshots = new WeakMap();
const snapshotKeys = new WeakMap();

export function protectedNativeWake(request) {
	const event = request?.nativeEvent;
	if (event?.mergedEvents?.length > 0) return true;
	const trigger = event?.trigger ?? event?.status?.decision?.trigger ?? request?.trigger;
	return request?.priority === 'urgent' || PROTECTED_TRIGGERS.has(trigger)
		|| event?.event?.startsWith('program_') && event.event !== 'program_planning_due'
		// A retained failure is protected only until a steer carrying it was accepted by the provider.
		|| FAILURES.has(event?.observation?.lastResult?.state) && request?.failureSteered !== true;
}

function eventsOf(request) {
	const event = request?.nativeEvent;
	if (event === undefined) return [];
	if (event.mergedEvents !== undefined) return event.mergedEvents;
	const trigger = event.trigger ?? event.status?.decision?.trigger ?? request.trigger;
	if (!protectedNativeWake(request)) return [];
	const metadata = JSON.stringify([trigger, request.dangerSummary]);
	const cached = snapshots.get(event);
	if (cached?.metadata === metadata) return [cached.snapshot];
	const key = JSON.stringify({ ...event, trigger, ...(request.dangerSummary === undefined ? {} : { dangerSummary: request.dangerSummary }) });
	const snapshot = JSON.parse(key);
	snapshotKeys.set(snapshot, key);
	snapshots.set(event, { metadata, snapshot });
	return [snapshot];
}

/**
 * The protected envelopes a request owes the model, as historical events. A delayed steer that swaps in a fresher
 * observation keeps these, so a threat or hit that left perception before delivery is still reported.
 */
export function owedWakeEvents(request) {
	return eventsOf(request);
}

// A merge changes the wake boundary, not which facts are owed. Keep each original envelope until the
// containing request is delivered. Identical envelopes can recur when a rejected delivery is requeued.
// Only a routine heartbeat (no attention: event and trigger 'observation') is owed solely for its retained failure.
// Every attention envelope, urgent or not (low health, healing, threats, sightings), keeps its own facts.
function failureOnlyKey(event) {
	const last = event?.observation?.lastResult;
	if (event?.event !== 'observation' || event.trigger !== 'observation' || event.dangerSummary !== undefined
		|| !FAILURES.has(last?.state) || typeof last.actionId !== 'string') return null;
	return `failure:${last.actionId}`;
}

export function carryNativeWakeEvents(previous, next, merged) {
	if (previous?.nativeEvent === undefined || next?.nativeEvent === undefined
		|| previous.goalRevision !== next.goalRevision) return merged;
	const unique = new Map();
	for (const event of [...eventsOf(previous), ...eventsOf(next)]) {
		// Envelopes owed only for the same failed action differ just in their snapshot: keep the latest one.
		const failure = failureOnlyKey(event);
		if (failure !== null) {
			unique.delete(failure);
			unique.set(failure, event);
			continue;
		}
		const key = snapshotKeys.get(event) ?? JSON.stringify(event);
		if (!unique.has(key)) unique.set(key, event);
	}
	if (unique.size === 0) return merged;
	return { ...merged, nativeEvent: { ...merged.nativeEvent, mergedEvents: [...unique.values()] } };
}
