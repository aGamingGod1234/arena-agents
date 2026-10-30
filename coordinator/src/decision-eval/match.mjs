import { buildContext, canonicalCall, matchCall } from './predicates.mjs';

/**
 * Single-call predicate matching for canned-step `when` clauses. It is the grade engine's call-level matcher, so a
 * `when` reads tool, args, normalized, any/all/not, every extension key and the domain helpers (against the case's
 * observation) exactly as grading does. `none` and `index` describe a whole sample, so a `when` with `none` never matches
 * and `index` is ignored.
 */

/** Whether one captured call ({ name, args, normalized }) satisfies a `when` predicate. */
export function callMatches(predicate, call, context = buildContext({})) {
	if ('none' in predicate) return false;
	return matchCall(predicate, canonicalCall({ name: call.name, args: call.args, ...(call.normalized ? { normalized: call.normalized } : {}) }), context);
}

/**
 * Arguments that do not change what the game does: only the time budget. Everything else (item, expected block, face,
 * slot, target, tolerance, positions) is behaviour and must be equal for a recorded reply to describe the call.
 */
export const NON_SEMANTIC_ARGUMENTS = Object.freeze(['timeoutMs']);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
	&& Object.keys({ ...a, ...b }).every((key) => same(a[key], b[key])));
const unset = (value) => value === undefined || value === null || value === false;

/**
 * Whether a production-normalized call is materially the recorded command: one single action (not a prefix of a
 * sequence), the same actionType, and equal behaviour arguments. A key present on only one side matches only when its
 * value is unset there (absent, null or false), so a build adding an explicit default does not count as a new command.
 */
export function commandMatches(recordedCommand, normalized) {
	if (!recordedCommand || !normalized || normalized.kind !== 'action' || typeof normalized.actionType !== 'string') return false;
	if (normalized.actionType !== recordedCommand.actionType) return false;
	const recorded = recordedCommand.arguments ?? {};
	const given = normalized.arguments ?? {};
	for (const key of new Set([...Object.keys(recorded), ...Object.keys(given)])) {
		if (NON_SEMANTIC_ARGUMENTS.includes(key)) continue;
		if (!(key in recorded) || !(key in given)) { if (unset(recorded[key]) && unset(given[key])) continue; return false; }
		if (!same(recorded[key], given[key])) return false;
	}
	return true;
}

/**
 * The canned choice a call receives: its `when` must hold and, when the choice carries the recorded command, the call
 * must be materially that command. Otherwise the sample is off script; no reply is ever lent to a different command.
 */
export function cannedChoice(step, call, context) {
	return step.canned.findIndex((choice) => callMatches(choice.when, call, context)
		&& (choice.recorded?.command === undefined || commandMatches(choice.recorded.command, call.normalized)));
}

export { buildContext };
