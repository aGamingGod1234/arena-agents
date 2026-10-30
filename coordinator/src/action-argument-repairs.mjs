import { MAX_DURATION_MS } from './constants.mjs';

/** Repairs change neither the target nor the action; the caller must show the returned notes. */
export function repairActionArguments(type, input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return { arguments: input };
	const miningDefault = type === 'break_block' && input.timeoutMs === undefined;
	const extraMoveTimeout = type === 'move_to' && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 1 && input.timeoutMs <= MAX_DURATION_MS;
	if (!miningDefault && !extraMoveTimeout) return { arguments: input };
	const args = Object.assign(Object.create(null), input), adjusted = {};
	if (miningDefault) {
		args.timeoutMs = 15_000;
		adjusted.timeoutMs = '15000 (default for break_block)';
	}
	if (extraMoveTimeout) {
		delete args.timeoutMs;
		adjusted.timeoutMs = 'ignored (move_to has no timeoutMs; use navigate_to for an action timeout, or the program deadline)';
	}
	return { arguments: args, ...(Object.keys(adjusted).length ? { adjusted } : {}) };
}
