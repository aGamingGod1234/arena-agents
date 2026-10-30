// Coalesces repeated damage/threat steering into one in-flight native turn.
//
// Every hit used to steer the running provider turn with a full event payload (5-8k tokens each). Steering does
// not restart the turn (Codex turn/steer keeps the turn id; Claude appends the steer to the next tool result),
// but each one grows the context the model must read before it can act: in the live trace 13 per-hit steers
// grew the turn from 79k to 191k input tokens in 15 seconds while the model kept re-deciding. Here the first
// danger steer goes out at once; further hits fold into one summary delivered at most every interval, or at
// once when something materially new happens (a new trigger kind, a new threat type, a threat escalating to
// imminent, close or swelling, or health crossing a low threshold). The model still receives every fact; it just gets time to decide.

import { carryNativeWakeEvents } from './native-wake-events.mjs';

export const DANGER_STEER_INTERVAL_MS = 2_000;
const DANGER_STEER_TRIGGERS = new Set(['damage', 'threat', 'fall']);
// 70% (when eating while safe becomes worthwhile), half health and three hearts: crossing any changes what a
// sensible choice is. 14 is deliberate: waiting to be told at 5 hearts taught agents to heal far too late.
const LOW_HEALTH_THRESHOLDS = Object.freeze([14, 10, 6]);
const MAX_SUMMARY_ATTACKERS = 4;
const HAZARD_SEVERITY = Object.freeze({ burning: 1, fire: 2, lava: 3 });
// Signals that mean a known threat just got materially closer to hurting the agent (ETA under 3 s, a creeper
// within 5 blocks, a lit fuse); each is new information even when that threat type was already delivered.
const ESCALATION_SIGNALS = Object.freeze(['imminent', 'creeper_close', 'swelling', 'ranged_aiming']);

function hazardOf(request) {
	const player = request?.nativeEvent?.observation?.player ?? request?.observation?.player;
	if (player == null) return undefined;
	return player.inLava === true || player.hazard === 'lava' ? 'lava'
		: player.hazard === 'fire' ? 'fire' : player.onFire === true ? 'burning' : null;
}

/** The danger facts of one steer request, or null when the request is not a danger steer. */
export function dangerSteerFacts(request) {
	const event = request?.nativeEvent;
	const trigger = event?.event === 'program_attention' ? event.status?.decision?.trigger ?? request?.trigger : request?.trigger;
	if (!DANGER_STEER_TRIGGERS.has(trigger)) return null;
	const observation = event?.observation ?? request?.observation ?? {};
	const player = observation?.player ?? {};
	const threats = Array.isArray(player.threats) ? player.threats : Array.isArray(observation?.threats?.entries) ? observation.threats.entries : [];
	const threatKeys = new Set();
	for (const threat of threats) {
		if (typeof threat?.type !== 'string') continue;
		threatKeys.add(threat.type);
		if (threat.swelling === true) threatKeys.add(`${threat.type}#swelling`);
		for (const signal of Array.isArray(threat.signals) ? threat.signals : []) if (ESCALATION_SIGNALS.includes(signal)) threatKeys.add(`${threat.type}#${signal}`);
	}
	// A new flight kind can change the response; another arrow identity or ETA does not.
	const projectiles = player.incomingProjectiles ?? observation.incomingProjectiles;
	if (Array.isArray(projectiles)) {
		for (const row of projectiles) if (typeof row?.type === 'string') threatKeys.add(`projectile#${row.type}`);
	}
	return {
		trigger,
		hazard: hazardOf(request),
		fallDistance: trigger === 'fall' && Number.isFinite(player.fallDistance) ? player.fallDistance : 0,
		health: Number.isFinite(player.health) ? player.health : null,
		attacker: typeof player.lastAttacker?.type === 'string' ? player.lastAttacker.type : null,
		threatKeys,
	};
}

// Keep a superseded edge as history at the place it was observed, never as current footing.
export function retainedDangerFooting(previous, next) {
	const observation = request => request?.nativeEvent?.observation ?? request?.observation;
	if (observation(next)?.player?.footing != null) return undefined;
	if (next?.dangerSummary?.earlierFooting != null) return next.dangerSummary.earlierFooting;
	const older = observation(previous), player = older?.player;
	if (player?.footing == null) return previous?.dangerSummary?.earlierFooting;
	return { ...player.footing,
		...(['x', 'y', 'z'].every(axis => Number.isFinite(player[axis])) ? { position: { x: player.x, y: player.y, z: player.z } } : {}),
		...(older.world?.dimension === undefined ? {} : { dimension: older.world.dimension }),
		...(older.world?.worldId === undefined ? {} : { worldId: older.world.worldId }),
	};
}

/** Per-turn coalescing state. Pure apart from the caller-supplied clock values. */
export class DangerSteerCoalescer {
	#intervalMs; #lastDeliveredAt = null; #deliveredTriggers = new Set(); #deliveredThreatKeys = new Set(); #deliveredHealth = null; #deliveredHazard = null; #hazardSeenAt = new Map(); #folded = null;

	constructor({ intervalMs = DANGER_STEER_INTERVAL_MS } = {}) {
		if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new TypeError('intervalMs must be a nonnegative number');
		this.#intervalMs = intervalMs;
	}

	/** Records the request that started the turn, so its first repeat is not treated as new. */
	noteDelivered(request, nowMs) {
		const facts = dangerSteerFacts(request);
		if (facts !== null) this.#remember(facts, nowMs);
		else this.#rememberHazard(request, nowMs);
	}

	/**
	 * Returns { action: 'deliver', request } to steer now (with any folded summary attached), or
	 * { action: 'fold', dueInMs, folded } when folded.
	 */
	offer(request, nowMs) {
		const facts = dangerSteerFacts(request);
		// Other urgent steers (chat, death, lava...) are never delayed; they carry any folded hits along.
		if (facts === null) {
			this.#rememberHazard(request, nowMs);
			return { action: 'deliver', request: this.#attachFolded(request) };
		}
		// Without a usable clock reading nothing can be timed, so nothing is held back.
		const elapsed = this.#lastDeliveredAt === null || !Number.isFinite(nowMs) ? Number.POSITIVE_INFINITY : nowMs - this.#lastDeliveredAt;
		const materiallyNew = this.#materiallyNew(facts, nowMs);
		this.#observeHazard(facts.hazard, nowMs);
		if (elapsed >= this.#intervalMs || materiallyNew) {
			const delivered = this.#attachFolded(request);
			this.#remember(facts, nowMs);
			return { action: 'deliver', request: delivered };
		}
		this.#fold(request, facts);
		return { action: 'fold', dueInMs: Math.max(0, this.#intervalMs - elapsed), folded: this.#folded.events };
	}

	hasFolded() { return this.#folded !== null; }

	/** Takes the folded request with its summary (timer flush or turn end), or null. */
	flush(nowMs) {
		if (this.#folded === null) return null;
		const facts = dangerSteerFacts(this.#folded.request);
		const request = this.#attachFolded(this.#folded.request);
		if (facts !== null) this.#remember(facts, nowMs);
		return request;
	}

	#materiallyNew(facts, nowMs) {
		if (!this.#deliveredTriggers.has(facts.trigger)) return true;
		// Folded observations also keep a hazard recent. A timer flush with a milder sample must not make the
		// next surface bob look like new danger. One timestamp per severity bounds the sliding window's storage.
		let peak = 0;
		for (const [severity, at] of this.#hazardSeenAt) if (nowMs - at < this.#intervalMs) peak = Math.max(peak, severity);
		if (facts.hazard !== undefined && facts.hazard !== this.#deliveredHazard
			&& (HAZARD_SEVERITY[facts.hazard] ?? 0) > peak) return true;
		for (const key of facts.threatKeys) if (!this.#deliveredThreatKeys.has(key)) return true;
		if (facts.health !== null && this.#deliveredHealth !== null
			&& LOW_HEALTH_THRESHOLDS.some((threshold) => this.#deliveredHealth > threshold && facts.health <= threshold)) return true;
		return false;
	}

	#remember(facts, nowMs) {
		this.#lastDeliveredAt = nowMs;
		this.#deliveredTriggers.add(facts.trigger);
		this.#rememberHazardValue(facts.hazard, nowMs);
		for (const key of facts.threatKeys) this.#deliveredThreatKeys.add(key);
		if (facts.health !== null) this.#deliveredHealth = facts.health;
	}

	#rememberHazard(request, nowMs) {
		this.#rememberHazardValue(hazardOf(request), nowMs);
	}

	#rememberHazardValue(hazard, nowMs) {
		if (hazard === undefined) return;
		this.#deliveredHazard = hazard;
		this.#observeHazard(hazard, nowMs);
	}

	#observeHazard(hazard, nowMs) {
		const severity = HAZARD_SEVERITY[hazard];
		if (severity !== undefined && Number.isFinite(nowMs)) this.#hazardSeenAt.set(severity, nowMs);
	}

	#fold(request, facts) {
		const folded = this.#folded ?? { request, events: 0, hits: 0, healthBefore: this.#deliveredHealth, attackers: new Set() };
		const footing = retainedDangerFooting(folded.request, request);
		folded.request = carryNativeWakeEvents(folded.request, request,
			footing === undefined ? request : { ...request, dangerSummary: { ...request.dangerSummary, earlierFooting: footing } });
		folded.events += 1;
		if (facts.trigger === 'damage') folded.hits += 1;
		if (facts.attacker !== null && folded.attackers.size < MAX_SUMMARY_ATTACKERS) folded.attackers.add(facts.attacker);
		folded.healthNow = facts.health;
		folded.fallDistance = Math.max(folded.fallDistance ?? 0, facts.fallDistance);
		this.#folded = folded;
	}

	#attachFolded(request) {
		const folded = this.#folded;
		this.#folded = null;
		if (folded === null) return request;
		const facts = dangerSteerFacts(request);
		const footing = retainedDangerFooting(folded.request, request);
		const dangerSummary = {
			...(footing === undefined ? {} : { earlierFooting: footing }),
			...(Math.max(folded.fallDistance ?? 0, facts?.fallDistance ?? 0) > 0 ? { fallDistance: Math.max(folded.fallDistance ?? 0, facts?.fallDistance ?? 0) } : {}),
			foldedEvents: folded.events,
			hitsSinceLastUpdate: folded.hits + (facts?.trigger === 'damage' && request !== folded.request ? 1 : 0),
			healthAtLastUpdate: folded.healthBefore,
			healthNow: facts?.health ?? folded.healthNow ?? null,
			attackers: [...folded.attackers, ...(facts?.attacker && !folded.attackers.has(facts.attacker) ? [facts.attacker] : [])].slice(0, MAX_SUMMARY_ATTACKERS),
		};
		return carryNativeWakeEvents(folded.request, request, { ...request, dangerSummary });
	}
}
