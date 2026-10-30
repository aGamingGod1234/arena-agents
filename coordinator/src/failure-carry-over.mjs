import { isDeepStrictEqual } from 'node:util';
import { FAILURE_STATES, failureCode, presentFailures } from './failure-schema.mjs';

const FIELDS = ['actionId', 'actionType', 'sourceStepId', 'state', 'reasonCode', 'message', 'failure', 'effects', 'effect', 'validity', 'executionStarted', 'physicalAttempted'];

export function correlateFailureEvent(value, source = value) {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value.mergedEvents)) {
		value = { ...value, mergedEvents: value.mergedEvents.map((event, index) => correlateFailureEvent(event, source?.mergedEvents?.[index])) };
	}
	const receipt = source?._actionReceipt, lastResult = value?.observation?.lastResult;
	if (typeof receipt?.actionId !== 'string' || receipt.state !== lastResult?.state
		|| lastResult?.actionId !== undefined && lastResult.actionId !== receipt.actionId
		|| receipt.reasonCode !== undefined && receipt.reasonCode !== lastResult?.reasonCode) return value;
	return { ...value, observation: { ...value.observation, lastResult: { ...lastResult, actionId: receipt.actionId } } };
}

// Runtime delivery ownership does not imply that a replacement provider has seen a receipt.
// Distinct explanations delivered during the active turn survive even when a newer steer omits them.
export class FailureCarryOver {
	#receipts = new Map();
	/** Walk only supported result envelopes, including sequences and completed program runs. */
	noteEnvelope(value, identity, seen = new Set()) {
		if (value === null || typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		this.note(value, identity);
		const data = key => Object.getOwnPropertyDescriptor(value, key)?.value;
		for (const key of ['results', 'receipts']) {
			for (const entry of Array.isArray(data(key)) ? data(key) : []) {
				this.noteEnvelope(entry, typeof entry?.actionId === 'string' ? `action:${entry.actionId}` : undefined, seen);
			}
		}
		for (const key of ['result', 'lastResult', 'observation', 'postAction', 'program', 'status', 'replacedAction', 'current']) {
			this.noteEnvelope(data(key), key === 'result' && typeof value.programId === 'string' ? `program:${value.programId}` : undefined, seen);
		}
	}
	beginTurn() {
		// The next turn supersedes the old event history; retain its latest explained outcome.
		const latest = [...this.#receipts.entries()].at(-1);
		this.#receipts = new Map(latest ? [latest] : []);
	}
	note(value, identity) {
		if (value === null || typeof value !== 'object') return;
		if (value.state === 'SUCCEEDED' && value.actionId) {
			this.#receipts.delete(`action:${value.actionId}`);
			return;
		}
		if (!FAILURE_STATES.has(value.state) || (!value.failure && !value.message && identity === undefined)) return;
		if (failureCode(value.reasonCode)?.[0] === 'ok') return;
		// Bare identified program/action reasons are facts, not missing explanations to invent.
		if (value.failure || value.message) value = presentFailures(value);
		const receipt = Object.fromEntries(FIELDS.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]));
		// Compact wakes can omit actionId. Type/code are not identity: two targets can fail alike.
		const key = identity ?? (receipt.actionId === undefined
			? [...this.#receipts].find(([, prior]) => isDeepStrictEqual(prior, receipt))?.[0] ?? Symbol('unidentified receipt')
			: `action:${receipt.actionId}`);
		const previous = this.#receipts.get(key);
		this.#receipts.delete(key);
		this.#receipts.set(key, previous ? { ...previous, ...receipt, ...(receipt.failure ? { failure: { ...previous.failure, ...receipt.failure } } : {}) } : receipt);
	}
	lines(visible = []) {
		visible = visible.map(value => presentFailures(value));
		return [...this.#receipts.entries()].filter(([identity, receipt]) => !visible.some(value => containsReceipt(value, receipt, identity)))
			.map(([identity, receipt]) => `Earlier failure receipt${typeof identity === 'string' && identity.startsWith('program:') ? ` (${identity})` : ''}: ${JSON.stringify(receipt)}`);
	}
}

// These are shared facts, not shared action identities. Keep every named receipt
// and every differing request/effect even when two actions report the same blocker.
export function shareVisibleFailureFields(result, visible) {
	const copy = structuredClone(presentFailures(result));
	const sources = [];
	const collect = (value, path) => {
		if (value === null || typeof value !== 'object') return;
		if (value.failure && typeof value.failure === 'object') sources.push({ failure: value.failure, path: `${path}.failure` });
		for (const [key, child] of Object.entries(value)) if (key !== 'failure') collect(child, `${path}.${key}`);
	};
	visible.forEach((value, index) => collect(value, `current input ${index + 1}`));
	const shared = [];
	const visit = (value, path) => {
		if (value === null || typeof value !== 'object') return;
		if (value.failure && typeof value.failure === 'object') {
			for (const [key, field] of Object.entries(value.failure)) {
				const source = sources.find(entry => isDeepStrictEqual(entry.failure[key], field));
				if (source) {
					delete value.failure[key];
					shared.push(`${path}.failure.${key} = ${source.path}.${key}`);
				}
			}
			if (Object.keys(value.failure).length === 0) delete value.failure;
		}
		for (const [key, child] of Object.entries(value)) if (key !== 'failure') visit(child, `${path}.${key}`);
	};
	visit(copy, 'tool result');
	return { value: copy, shared };
}

function containsReceipt(value, receipt, identity) {
	if (value === null || typeof value !== 'object') return false;
	if (typeof identity === 'string' && identity.startsWith('program:')) {
		if (value.programId === identity.slice('program:'.length) && containsReceipt(value.result, receipt)) return true;
	} else if (Object.entries(receipt).every(([key, field]) => isDeepStrictEqual(value[key], field))) return true;
	return Object.values(value).some(child => containsReceipt(child, receipt, identity));
}
