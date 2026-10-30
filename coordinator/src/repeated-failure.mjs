import { extractPosition } from './explore-frontier.mjs';

const WINDOW_MS = 60_000;
const HISTORY_LIMIT = 16;
const COUNTED_STATES = new Set(['FAILED', 'TIMED_OUT']);

/**
 * Remembers recent failures of every tool per agent so a repeated failure can say so. The fact is
 * the player's own history (same reason, same block, how recently); it never blocks a retry.
 */
export class RepeatedFailureLedger {
	#history = new Map();

	/** Records one terminal result and returns a compact repeat fact, or null for a first failure. */
	record(agentId, { goalRevision, actionType, arguments: args, state, reasonCode, observation, now = Date.now() }) {
		if (!COUNTED_STATES.has(state) || typeof reasonCode !== 'string' || reasonCode.length === 0) return null;
		const position = extractPosition(observation);
		if (position === null) return null;
		const at = Number.isFinite(observation?.observedAtEpochMs) ? observation.observedAtEpochMs : now;
		const cell = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
		const request = JSON.stringify([actionType, args ?? null]);
		const history = this.#history.get(agentId);
		const truncatedAt = history?.goalRevision === goalRevision && at - history.truncatedAt <= WINDOW_MS ? history.truncatedAt : -Infinity;
		const recent = (history?.entries ?? []).filter((entry) => entry.goalRevision === goalRevision && at - entry.at <= WINDOW_MS && entry.at <= at);
		const matching = recent.filter((entry) => entry.reasonCode === reasonCode && entry.cell === cell);
		recent.push({ goalRevision, reasonCode, cell, request, at });
		// An eviction can omit this key, even when it was caused by another failure.
		const lowerBound = truncatedAt !== -Infinity;
		const evictedAt = recent.length > HISTORY_LIMIT ? recent[0].at : -Infinity;
		this.#history.set(agentId, { goalRevision, truncatedAt: Math.max(truncatedAt, evictedAt), entries: recent.slice(-HISTORY_LIMIT) });
		if (matching.length === 0) return null;
		const identical = matching.filter((entry) => entry.request === request).length + 1;
		const seconds = Math.max(1, Math.round((at - matching[0].at) / 1000));
		// The reason code sits beside this fact in the failure, so it is not repeated here.
		return `${lowerBound ? `${matching.length + 1}+` : ordinal(matching.length + 1)} from this block in ${seconds}s${identical > 1 ? `; ${identical}${lowerBound ? "+" : ""} identical` : ''}`;
	}

	forget(agentId) { this.#history.delete(agentId); }
}

function ordinal(value) {
	const tens = value % 100;
	if (tens >= 11 && tens <= 13) return `${value}th`;
	return `${value}${['th', 'st', 'nd', 'rd'][value % 10] ?? 'th'}`;
}
