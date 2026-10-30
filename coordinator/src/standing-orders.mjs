import { visiblePlayer } from './player-visible-facts.mjs';
import { adaptObservation } from './observation-adapter.mjs';
import { survivalThreatFeedback } from './standing-templates.mjs';
import { compileProgramPrecondition, preconditionEvaluator, preconditionFacts } from './program-precondition.mjs';

/**
 * Model-authored standing orders: a reflex the model writes in advance ("burning and health below 10: eat") that the
 * runtime runs the moment its condition becomes true, because a model round (5 to 13 s) is slower than the danger.
 * The model writes every condition and every handler; nothing here chooses an action. Orders are few, expire, and
 * each firing is reported back to the model as a program result.
 */
export const MAX_STANDING_ORDERS = 4;
export const MAX_STANDING_TTL_S = 1_800;
export const DEFAULT_STANDING_TTL_S = 600;
export const MAX_STANDING_WHEN_BYTES = 1_024;
export const MAX_STANDING_SOURCE_BYTES = 4_096;
export const STANDING_ORDER_ID = /^[A-Za-z0-9_-]{1,32}$/;
// A condition that flickers across its threshold (health 9 <-> 10 while regenerating) must not refire every sample.
export const STANDING_REFIRE_MS = 2_000;
export const STANDING_GUARD_REFIRE_MS = 250;
export const MAX_STANDING_GUARD_REFIRE_MS = 5_000;

export class StandingOrderBook {
	#agents = new Map();
	#facts = new Map();
	#closedEpisodes = new Map();
	#now;

	constructor({ now = Date.now } = {}) { this.#now = now; }

	has(agentId) { return (this.#agents.get(agentId)?.size ?? 0) > 0; }

	guardCoverage(agentId) {
		const orders = this.#agents.get(agentId);
		if (orders === undefined) return null;
		this.#prune(orders);
		return [...orders.values()].filter(order => order.guard).map(order =>
			`${order.id}: installed, condition ${order.conditionError ? `error ${order.conditionError}` : order.evaluatedAtMs == null ? 'unchecked' : String(order.truth)}, fired ${order.fired}x`
		).join('; ') || null;
	}

	/** Install or replace one order. Compiles the condition first so a bad order never replaces a good one. */
	set(agentId, { id, template, when, source, parameters, maxActions, timeoutMs, guard = false, ttlS = DEFAULT_STANDING_TTL_S, goalRevision, goalText }) {
		const compiled = compileProgramPrecondition(when);
		const evaluate = preconditionEvaluator(compiled, parameters);
		const orders = this.#agents.get(agentId) ?? new Map();
		this.#prune(orders);
		if (!orders.has(id) && orders.size >= MAX_STANDING_ORDERS) throw codedError('STANDING_ORDER_LIMIT', `At most ${MAX_STANDING_ORDERS} standing orders; delete one by id first`);
		const installedAtMs = this.#now();
		this.#closeEpisode(agentId, orders.get(id));
		orders.set(id, { id, template, when, guard, goalRevision, goalText, episode: null, retryAtMs: null, backoffMs: STANDING_GUARD_REFIRE_MS, evaluate, readsWorld: /\bworld\b/.test(when), source, parameters, maxActions, timeoutMs, installedAtMs, expiresAtMs: guard ? Infinity : installedAtMs + ttlS * 1_000,
			truth: false, due: false, evaluatedAtMs: null, lastFiredAtMs: null, fired: 0, conditionError: null });
		this.#agents.set(agentId, orders);
		return this.list(agentId);
	}

	delete(agentId, id) {
		const orders = this.#agents.get(agentId);
		this.#closeEpisode(agentId, orders?.get(id));
		const deleted = orders?.delete(id) === true;
		if (orders?.size === 0) { this.#agents.delete(agentId); this.#facts.delete(agentId); }
		return deleted;
	}

	isCurrent(agentId, order) { return this.#agents.get(agentId)?.get(order.id) === order; }

	clear(agentId) { this.#agents.delete(agentId); this.#facts.delete(agentId); this.#closedEpisodes.delete(agentId); }

	clearGuards(agentId, keep = () => false) {
		for (const order of this.#agents.get(agentId)?.values() ?? []) if (order.guard && !keep(order)) this.delete(agentId, order.id);
	}

	takeClosedEpisodes(agentId) {
		const episodes = this.#closedEpisodes.get(agentId) ?? [];
		this.#closedEpisodes.delete(agentId);
		return episodes;
	}

	#closeEpisode(agentId, order) {
		if (order?.episode == null || order.episode.closed) return;
		order.episode.closed = true;
		const episodes = this.#closedEpisodes.get(agentId) ?? [];
		episodes.push(order.episode);
		this.#closedEpisodes.set(agentId, episodes);
	}

	list(agentId) {
		const orders = this.#agents.get(agentId);
		if (orders === undefined) return [];
		this.#prune(orders);
		const now = this.#now();
		return [...orders.values()].map(order => ({ id: order.id, when: order.when, ...(order.guard ? { guard: true } : { expiresInS: Math.max(0, Math.round((order.expiresAtMs - now) / 1_000)) }),
			...(order.fired === 0 ? {} : { fired: order.fired }), ...(order.episode == null ? {} : guardEpisodeFacts(order.episode)),
			...(order.feedback == null ? {} : { feedback: structuredClone(order.feedback) }), ...(order.conditionError === null ? {} : { conditionError: order.conditionError }) }));
	}

	/** Keep outcomes outside the coalesced wake history, including failures followed by a successful action. */
	recordGuardAction(order, actionType, result) {
		const feedback = order.feedback ??= { actions: 0, actionTypes: {}, lastFailure: null };
		feedback.actions++;
		feedback.actionTypes[actionType] = (feedback.actionTypes[actionType] ?? 0) + 1;
		this.#recordFailure(feedback, actionType, result);
	}

	#recordFailure(feedback, actionType, result) {
		if (!['FAILED', 'TIMED_OUT', 'UNKNOWN'].includes(result.state)) return;
		const message = typeof result.message === 'string' ? result.message.slice(0, 160) : '';
		const previous = feedback.lastFailure;
		feedback.lastFailure = { actionType, reasonCode: result.reasonCode, message,
			repeat: previous?.actionType === actionType && previous.reasonCode === result.reasonCode && previous.message === message ? previous.repeat + 1 : 1 };
	}

	feedback(agentId) {
		return this.list(agentId).filter(order => order.guard && (order.fired > 0 || order.feedback?.threats?.length > 0)).map(order => this.orderFeedback(order)).join('; ');
	}

	orderFeedback(order) {
		const feedback = order.feedback;
		const types = Object.entries(feedback?.actionTypes ?? {});
		const actions = types.slice(0, 4).map(([type, count]) => `${type} ${count}x`).join(', ') + (types.length > 4 ? ', other actions' : '');
		const failure = feedback?.lastFailure;
		const threats = (feedback?.threats ?? []).map(t => `${t.uuid} visible:${t.visible} targetable:${t.targetable} reachable:unverified ${t.response}`).join(', ');
		return `guard ${order.id} fired ${order.fired}x, ${feedback?.actions ?? 0} actions${actions ? ` (${actions})` : ''}${failure ? `; last ${failure.reasonCode}${failure.message ? ` ${failure.message}` : ''} (repeat ${failure.repeat})` : '; no failures reported'}${feedback?.repeat > 1 ? `; outcome repeated ${feedback.repeat}x` : ''}${threats ? `; threats: ${threats}` : ''}`;
	}

	/**
	 * Track every order's condition on one live observation and return the first order whose condition rose (or is
	 * still true after a deferred firing) and may fire now, or null. A condition that cannot be read (a fact missing
	 * from this sample) counts as false for that sample and is named in the order list.
	 */
	evaluate(agentId, observation) {
		const orders = this.#agents.get(agentId);
		if (orders === undefined) return null;
		this.#prune(orders);
		if (orders.size === 0) { this.clear(agentId); return null; }
		let facts;
		try { facts = preconditionFacts(conditionInput(observation, [...orders.values()].some((order) => order.readsWorld)), this.#facts.get(agentId) ?? null); }
		catch { return null; }
		this.#facts.set(agentId, facts);
		const now = this.#now();
		let ready = null;
		for (const order of [...orders.values()].sort((a, b) => Number(b.guard) - Number(a.guard))) {
			if (order.template === 'survival') {
				const feedback = order.feedback ??= { actions: 0, actionTypes: {}, lastFailure: null };
				feedback.threats = survivalThreatFeedback(facts.player, order.parameters);
			}
			let truth;
			try { truth = order.evaluate(facts) === true; order.conditionError = null; }
			catch (error) { truth = false; order.conditionError = String(error?.code ?? error?.cause?.code ?? 'CONDITION_FAILED').slice(0, 64); }
			order.evaluatedAtMs = now;
			if (truth && (!order.truth || order.guard)) order.due = true;
			if (!truth) {
				order.due = false;
				this.#closeEpisode(agentId, order);
				order.backoffMs = STANDING_GUARD_REFIRE_MS;
				order.retryAtMs = null;
			}
			order.truth = truth;
			if (ready === null && order.due && (order.guard ? now >= (order.retryAtMs ?? 0) : order.lastFiredAtMs === null || now - order.lastFiredAtMs >= STANDING_REFIRE_MS)) ready = order;
		}
		return ready;
	}

	/** A new body: keep each order's source and remaining time, but its condition starts afresh (a true one fires). */
	rearm(agentId) {
		for (const order of this.#agents.get(agentId)?.values() ?? []) { order.truth = false; order.due = false; order.evaluatedAtMs = null; order.conditionError = null; order.lastFiredAtMs = null; order.episode = null; order.retryAtMs = null; order.backoffMs = STANDING_GUARD_REFIRE_MS; }
		this.#closedEpisodes.delete(agentId);
		this.#facts.delete(agentId);
	}

	/** Record an admitted handler; guards can retry a held condition after their backoff. */
	markFired(agentId, id) {
		const order = this.#agents.get(agentId)?.get(id);
		if (order === undefined) return null;
		order.due = false;
		order.lastFiredAtMs = this.#now();
		order.fired += 1;
		if (order.guard) {
			if (order.episode == null || order.episode.closed) order.episode = { activations: 0, lastOutcome: null, closed: false };
			order.episode.activations += 1;
			order.retryAtMs = this.#now() + order.backoffMs;
		}
		return order;
	}

	/** A held condition is still the same situation, even if the source exhausted successfully. */
	finishGuard(agentId, order, episode, outcome) {
		const previous = episode.lastOutcome;
		// continue_and_notify can exhaust after an action failure; retain the last body result in that case.
		const last = outcome.state === 'YIELDED' && outcome.reasonCode === 'PROGRAM_EXHAUSTED' ? outcome.receipts?.at(-1) ?? outcome : outcome;
		episode.lastOutcome = { state: last.state, reasonCode: last.reasonCode };
		const feedback = order.feedback ??= { actions: 0, actionTypes: {}, lastFailure: null };
		feedback.repeat = previous?.state === last.state && previous.reasonCode === last.reasonCode ? (feedback.repeat ?? 1) + 1 : 1;
		if (outcome.receipts?.at(-1)?.reasonCode !== outcome.reasonCode) this.#recordFailure(feedback, 'program', outcome);
		if (this.isCurrent(agentId, order) && order.episode === episode && !episode.closed) {
			order.retryAtMs = this.#now() + order.backoffMs;
			order.backoffMs = Math.min(MAX_STANDING_GUARD_REFIRE_MS, order.backoffMs * 2);
		}
		return previous !== null && (previous.state !== last.state || previous.reasonCode !== last.reasonCode);
	}

	#prune(orders) {
		const now = this.#now();
		for (const [id, order] of orders) if (order.expiresAtMs <= now) orders.delete(id);
	}
}

/**
 * Building interpreter facts copies the whole sample (blocks, entities, items: about 25 KB, 3 to 5 ms). A condition
 * that never names world cannot read those domains, so when no order does, only the player and inventory are copied.
 */
function conditionInput(observation, readsWorld) {
	const adapted = observation && Object.hasOwn(observation, 'ready') && Object.hasOwn(observation, 'position') ? adaptObservation(observation) : observation;
	if (readsWorld || adapted === null || typeof adapted !== 'object') return adapted;
	return { player: adapted.player, inventory: adapted.inventory, ...(Object.hasOwn(adapted, 'velocity') ? { velocity: adapted.velocity } : {}) };
}

/** The facts that made an order fire, as the model would read them in player.state(); absent facts are omitted. */
export function standingOrderCause(observation) {
	const player = visiblePlayer(observation?.player ?? {});
	const cause = {};
	for (const [from, to] of [['health', 'health'], ['foodLevel', 'hunger'], ['airBubbles', 'airBubbles'], ['fallDistance', 'fallDistance']]) {
		if (Number.isFinite(player[from])) cause[to] = Math.round(player[from] * 10) / 10;
	}
	if (player.onFire === true) cause.fire = true;
	if (player.inLava === true) cause.inLava = true;
	if (Number.isFinite(player.harm?.hpLossPerSecond)) cause.hpLossPerSecond = player.harm.hpLossPerSecond;
	if (player.dropAhead != null) cause.dropAhead = player.dropAhead;
	// Stored samples are adapted (threats under player); wire samples keep threats.entries.
	const threats = Array.isArray(player.threats) ? player.threats : observation?.threats?.entries;
	if (Array.isArray(threats) && threats.length > 0) cause.threats = threats.length;
	return cause;
}

export function guardEpisodeFacts(episode) {
	return { activations: episode.activations, ...(episode.lastOutcome == null ? {} : { lastOutcome: { ...episode.lastOutcome } }) };
}

const CAUSE_NUMBERS = ['health', 'hunger', 'air', 'airBubbles', 'fallDistance', 'hpLossPerSecond', 'threats'];
// The serialized report never exceeds this many UTF-8 bytes, whatever its text holds (see the test that fills every field).
export const MAX_STANDING_REPORT_BYTES = 1_500;

/** The longest prefix whose JSON string form (escapes included) fits in maximum UTF-8 bytes, without splitting a character. */
function clipJsonText(value, maximum) {
	let bytes = 0, end = 0;
	for (const character of value) {
		bytes += Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
		if (bytes > maximum) break;
		end += character.length;
	}
	return value.slice(0, end);
}

/**
 * The firing report as the model reads it, bounded for wakes and compacted tool results: about 350 bytes for a typical
 * firing. Conditions retain all guards when they fit; preemption text yields first. An incomplete condition is
 * explicitly an excerpt with guardsOmitted, including when a report passes through this boundary more than once.
 */
export function compactStandingOrder(value) {
	if (value === null || typeof value !== 'object') return undefined;
	const text = (field, maximum) => typeof field === 'string' ? clipJsonText(field, maximum) : undefined;
	const cause = value.cause !== null && typeof value.cause === 'object' ? value.cause : {};
	const compactCause = {
		...Object.fromEntries(CAUSE_NUMBERS.filter((key) => Number.isFinite(cause[key])).map((key) => [key, cause[key]])),
		...(cause.fire === true ? { fire: true } : {}), ...(cause.inLava === true ? { inLava: true } : {}),
		...(cause.dropAhead !== null && typeof cause.dropAhead === 'object' ? { dropAhead: Object.fromEntries(['drop', 'at', 'atLeast', 'into']
			.filter((key) => ['number', 'boolean', 'string'].includes(typeof cause.dropAhead[key])).map((key) => [key, typeof cause.dropAhead[key] === 'string' ? clipJsonText(cause.dropAhead[key], 16) : cause.dropAhead[key]])) } : {}),
	};
	const preempted = Array.isArray(value.preempted) ? value.preempted.slice(0, 2).map((entry) => Object.fromEntries(['actionId', 'actionType', 'programId']
		.filter((key) => typeof entry?.[key] === 'string').map((key) => [key, clipJsonText(entry[key], key === 'actionType' ? 64 : 128)]))) : [];
	const report = {
		id: text(value.id, 32),
		...(typeof value.outcome === 'string' ? { outcome: text(value.outcome, 640) } : {}),
		...(Number.isSafeInteger(value.activations) ? { activations: value.activations } : {}),
		...(value.lastOutcome == null ? {} : { lastOutcome: { state: text(value.lastOutcome.state, 32), reasonCode: text(value.lastOutcome.reasonCode, 64) } }),
		...(typeof value.when === 'string' ? { when: value.when } : {}),
		...(value.guardsOmitted === true ? { guardsOmitted: true, whenExcerpt: typeof value.whenExcerpt === 'string' ? value.whenExcerpt : '' } : {}),
		...(value.preemptedOmitted === true ? { preemptedOmitted: true } : {}),
		...(Number.isSafeInteger(value.firedAtMs) ? { firedAtMs: value.firedAtMs } : {}),
		cause: compactCause,
		...(preempted.length === 0 ? {} : { preempted }),
		...(Number.isSafeInteger(value.continuedAttention) ? { continuedAttention: value.continuedAttention } : {}),
	};
	const size = () => Buffer.byteLength(JSON.stringify(report), 'utf8');
	if (size() > MAX_STANDING_REPORT_BYTES && report.preempted !== undefined) {
		// Keep the authorization before supporting action identifiers or descriptions.
		delete report.preempted;
		report.preemptedOmitted = true;
	}
	if (report.guardsOmitted === true || size() > MAX_STANDING_REPORT_BYTES) {
		const when = report.when ?? report.whenExcerpt ?? '';
		delete report.when;
		report.guardsOmitted = true;
		report.whenExcerpt = '';
		// Include the omission marker and the JSON string quotes in the remaining budget.
		report.whenExcerpt = clipJsonText(when, Math.max(0, MAX_STANDING_REPORT_BYTES - size()));
	}
	return report;
}

function codedError(code, message) { return Object.assign(new Error(message), { code }); }
