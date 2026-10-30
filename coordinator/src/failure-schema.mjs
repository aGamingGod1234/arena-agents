import { FAILURE_CODES } from './failure-codes.mjs';

/**
 * One failure format for every tool, action, program step, navigation, fight and script call:
 * failure: { tried?, changed?, blockedBy, validWhen?, repeat? }. No changed means the body changed nothing (the
 * native instructions say so); an unknown change is stated as "unknown".
 * blockedBy is the concrete fact the producer reported (the player-visible block, item, rule or threat);
 * validWhen is the condition under which the same request is valid, from the code catalogue. Both are
 * facts; neither names an action for the model.
 */
export const FAILURE_STATES = new Set(['FAILED', 'TIMED_OUT', 'REJECTED', 'CANCELLED']);
const MAX_BLOCKED_BY = 2_048;
const STALE_START_MS = 2_000;

/** Catalogue entry for a code: [blocker, validWhen] or ['internal', reason] or ['ok'] (not a failure). */
export function failureCode(code) {
	return Object.hasOwn(FAILURE_CODES, code) ? FAILURE_CODES[code] : null;
}

export function validWhenFor(code) {
	const entry = failureCode(code);
	return entry === null || entry[0] === 'ok' || entry[0] === 'internal' ? null : entry[1];
}

export function isFailureResult(value) {
	return value !== null && typeof value === 'object' && FAILURE_STATES.has(value.state)
		&& typeof value.reasonCode === 'string' && value.reasonCode.length > 0 && failureCode(value.reasonCode)?.[0] !== 'ok';
}

/**
 * Builds the failure object from facts the caller already holds. Exported for every producer,
 * including stall reports: failureFacts({ code, tried, changed, blockedBy, repeat }).
 */
export function failureFacts({ code, tried, changed, blockedBy, repeat } = {}) {
	// A repeat names the same failure from the same block within the last minute, which already carried this condition.
	const hasRepeat = typeof repeat === 'string' && repeat.length > 0;
	const validWhen = hasRepeat ? null : validWhenFor(code);
	const entry = failureCode(code);
	const blocker = typeof blockedBy === 'string' && blockedBy.trim().length > 0 ? blockedBy.slice(0, MAX_BLOCKED_BY)
		// An internal fault has no world blocker; its catalogue reason says why.
		: entry?.[0] === 'internal' ? entry[1] : 'not reported';
	return {
		...(typeof tried === 'string' && tried.length > 0 ? { tried: tried.slice(0, 160) } : {}),
		// Most failures change nothing, so that is the default: changed appears only when something (or an unknown amount) did.
		...(typeof changed === 'string' && changed.length > 0 && changed !== 'nothing' ? { changed: changed.slice(0, 160) } : {}),
		blockedBy: blocker,
		...(validWhen === null ? {} : { validWhen }),
		...(hasRepeat ? { repeat: repeat.slice(0, 96) } : {}),
	};
}

/** A compact name for a request whose result arrives away from its call: action type plus its target. */
export function triedText(actionType, args = {}) {
	const target = [args?.x, args?.y, args?.z].every(Number.isFinite) ? `${args.x},${args.y},${args.z}`
		: ['targetId', 'stableId', 'targetSelector', 'itemId', 'recipeId', 'expectedItemId'].map(key => args?.[key]).find(value => typeof value === 'string');
	return `${actionType}${target === undefined ? '' : ` ${String(target).slice(0, 80)}`}`;
}

/**
 * What the body changed, from the result's own execution flags and the start and terminal positions. A start
 * sample taken well before dispatch is named as such, so movement is never presented as more certain than it is.
 */
export function failureChange({ executionStarted, physicalAttempted, from, fromAgeMs, to } = {}) {
	if (executionStarted === false || physicalAttempted === false) return 'nothing';
	const moved = from && to ? Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) : null;
	if (moved !== null && Number.isFinite(moved)) {
		const since = Number.isFinite(fromAgeMs) && fromAgeMs > STALE_START_MS ? ` since a position seen ${Math.round(fromAgeMs / 1000)}s before it started` : '';
		if (moved < 0.25) return since === '' ? 'input applied; no movement' : `input applied; no movement${since}`;
		return `moved ${Math.round(moved * 10) / 10}m${Math.abs(to.y - from.y) >= 1 ? ` (dy ${Math.round(to.y - from.y)})` : ''}${since}`;
	}
	return physicalAttempted === true ? 'input applied' : 'unknown';
}

/**
 * Model-facing guarantee: a failed result always carries `failure`. The producer's message becomes
 * failure.blockedBy, and the execution flags become failure.changed, so the fact is not sent twice.
 * Results that are not failures are returned unchanged.
 */
export function withFailureSchema(result, context = {}) {
	if (!isFailureResult(result)) return result;
	const { message, executionStarted, physicalAttempted, repeatedFailure, failure, ...rest } = result;
	const existing = failure !== null && typeof failure === 'object' ? failure : null;
	// Context from the envelope (a sequence or program step) names the request when the producer did not.
	const facts = existing !== null ? (existing.tried === undefined && typeof context.tried === 'string' ? { tried: context.tried.slice(0, 160), ...existing } : existing) : failureFacts({
		code: result.reasonCode,
		tried: context.tried,
		changed: failureChange({ executionStarted, physicalAttempted }),
		blockedBy: typeof message === 'string' ? message : undefined,
		repeat: repeatedFailure,
	});
	return { ...rest, failure: facts };
}

/**
 * Applies withFailureSchema to a tool result and to the results it carries: sequence steps,
 * program receipts and an action status's last result. Used at the model-facing presentation.
 */
export function presentFailures(value, depth = 0) {
	if (value === null || typeof value !== 'object' || Array.isArray(value) || depth > 2) return value;
	let next = withFailureSchema(value);
	for (const key of ['results', 'receipts']) {
		if (Array.isArray(next[key]) && next[key].some(isFailureResult)) {
			next = { ...next, [key]: next[key].map(entry => withFailureSchema(entry, { tried: entry?.actionType === undefined ? undefined : triedText(entry.actionType, entry.arguments) })) };
		}
	}
	// A view keeps a delivered failure as its bare code; only a raw result with its text is converted.
	if (isFailureResult(next.lastResult) && (next.lastResult.message !== undefined || next.lastResult.failure !== undefined)) next = { ...next, lastResult: withFailureSchema(next.lastResult) };
	// Envelopes that carry another result: a program's ended run, follow-up facts and their observation.
	for (const key of ['result', 'postAction', 'observation']) {
		if (next[key] !== null && typeof next[key] === 'object' && !Array.isArray(next[key])) {
			const nested = presentFailures(next[key], depth + 1);
			if (nested !== next[key]) next = { ...next, [key]: nested };
		}
	}
	return next;
}

/** The tool result for a thrown tool error, shared by both providers. */
export function toolErrorResult(error, extraFields = {}) {
	const reasonCode = String(error?.code ?? 'TOOL_EXECUTION_FAILED').slice(0, 128);
	return {
		state: 'FAILED',
		reasonCode,
		failure: error?.failure ?? failureFacts({ code: reasonCode, changed: 'nothing', blockedBy: String(error?.message ?? error).slice(0, 512) }),
		...extraFields,
		...(error?.actionContract === undefined ? {} : { actionContract: error.actionContract }),
		...(error?.replacedAction === undefined ? {} : { replacedAction: error.replacedAction }),
		...(error?.current === undefined ? {} : { current: error.current }),
		// Rules a rejected body call carried stay installed; the model sees them instead of re-sending.
		...(error?.reflexes === undefined ? {} : { reflexes: error.reflexes }),
	};
}
