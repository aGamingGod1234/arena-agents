/**
 * Wake filter for a running model action or skill (System 1 runs, System 2 sleeps). While the model's own action runs,
 * ordinary results and facts (a hit absorbed at safe health by a mob kind the model already knows, another threat
 * signal from a known kind, a fire contact a fire rule is handling, items picked up, routine updates) do not wake the
 * model; they are summed into the next wake as `now.whileActing`. The model is woken at once for a finished or failed
 * action (that path never reaches this filter), health at or below the low floor, a new kind of danger (a mob or
 * projectile kind the model was not shown, lava at the body, burning after a fire rule failed or with none armed), and
 * a new discovery (a fortress, portal, stronghold or bastion sighted; an enderman in range while pearls are open).
 *
 * Pure bookkeeping: no clock, no I/O. The caller asks decide() only while the model's own action runs, and calls take()
 * when it builds a wake for the model.
 */

// Same floor as the low-health danger context (danger-contexts.mjs: 8, or 40% of max health when lower).
export const WAKE_LOW_HEALTH = 8;
// An enderman this close is in pearl range (a player sees and walks to it within the hold).
export const ENDERMAN_RANGE = 24;
export const PEARL_TARGET = 12;
const MAJOR_STRUCTURE = /fortress|portal|stronghold|bastion/i;
const PEARL_GOAL = /pearl|ender[_ ]eye|eye of ender|eyes of ender|stronghold|end portal|the end\b|dragon|beat the game/i;
const FIRE_ACTIONS = new Set(['leave_fire', 'leave_lava']);
const FAILED_OUTCOMES = new Set(['failed', 'timeout', 'disabled']);
// Urgent triggers this filter may hold when the facts show the body coping; every other urgent trigger wakes.
const ABSORBABLE = new Set(['damage', 'threat', 'projectile', 'fire']);
// A creeper about to blow is a new danger whatever kinds the model has seen.
const WAKING_SIGNALS = new Set(['swelling', 'creeper_close']);

const typeOf = (value) => (typeof value === 'string' && value.length > 0 ? (value.includes(':') ? value : `minecraft:${value}`) : null);
const short = (id) => String(id).replace(/^minecraft:/u, '');
const rowsOf = (value) => (Array.isArray(value) ? value : []);

function threatRows(observation) {
	const rows = rowsOf(observation?.player?.threats);
	return rows.length > 0 ? rows : rowsOf(observation?.threats?.entries);
}

/** Mob and projectile kinds the observation shows (what a wake built from it tells the model). */
export function shownKinds(observation) {
	const kinds = new Set();
	for (const row of threatRows(observation)) { const type = typeOf(row?.type); if (type) kinds.add(type); }
	for (const row of rowsOf(observation?.entities)) {
		const type = typeOf(row?.type);
		if (type && (row?.hostile === true || row?.targetingAgent === true || type === 'minecraft:enderman')) kinds.add(type);
	}
	const attacker = typeOf(observation?.player?.lastAttacker?.type);
	if (attacker) kinds.add(attacker);
	for (const row of rowsOf(observation?.player?.incomingProjectiles ?? observation?.incomingProjectiles)) {
		const type = typeOf(row?.type);
		if (type) kinds.add(`projectile:${type}`);
	}
	return kinds;
}

function lowHealth(player) {
	if (!Number.isFinite(player?.health)) return false;
	const max = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 20;
	return player.health <= Math.min(WAKE_LOW_HEALTH, max * 0.4);
}

function itemCounts(observation) {
	const counts = new Map();
	for (const item of rowsOf(observation?.inventory?.items)) {
		if (typeof item?.itemId !== 'string' || !Number.isFinite(item.count)) continue;
		counts.set(item.itemId, (counts.get(item.itemId) ?? 0) + item.count);
	}
	return counts;
}

/** Whether the goal names pearls or eyes and fewer than 12 pearls plus eyes are held. */
export function pearlsOpen(goalText, observation) {
	if (typeof goalText !== 'string' || !PEARL_GOAL.test(goalText)) return false;
	const counts = itemCounts(observation);
	return (counts.get('minecraft:ender_pearl') ?? 0) + (counts.get('minecraft:ender_eye') ?? 0) < PEARL_TARGET;
}

/** Types of threats whose new signals this sample carries (changed facts "threats.<uuid>.<signal>"). */
function signalledThreats(changedFacts, observation) {
	const byId = new Map(threatRows(observation).map((row) => [row?.uuid ?? row?.stableId, typeOf(row?.type)]));
	const kinds = new Set(), signals = new Set();
	for (const fact of rowsOf(changedFacts)) {
		if (typeof fact !== 'string' || !fact.startsWith('threats.')) continue;
		const key = fact.slice('threats.'.length);
		const uuid = key.slice(0, key.lastIndexOf('.'));
		kinds.add(byId.get(uuid) ?? 'unknown');
		signals.add(key.slice(key.lastIndexOf('.') + 1));
	}
	return { kinds, signals };
}

function newMajorStructure(observation) {
	for (const row of rowsOf(observation?.sighted?.structures)) {
		if (row?.new !== true) continue;
		const name = [row.type, row.kind, row.structure, row.name, row.id].find((value) => typeof value === 'string');
		if (name !== undefined && MAJOR_STRUCTURE.test(name)) return short(name);
	}
	for (const row of rowsOf(observation?.sighted?.poi)) {
		if (row?.new !== true) continue;
		const name = [row.type, row.kind, row.blockId, row.name].find((value) => typeof value === 'string');
		if (name !== undefined && MAJOR_STRUCTURE.test(name)) return short(name);
	}
	return null;
}

function nearEnderman(observation) {
	const rows = [...rowsOf(observation?.entities), ...threatRows(observation)];
	return rows.some((row) => typeOf(row?.type) === 'minecraft:enderman' && Number.isFinite(row?.distance) && row.distance <= ENDERMAN_RANGE);
}

export class WakeFilter {
	#agents = new Map();

	#agent(agentId) {
		let agent = this.#agents.get(agentId);
		if (agent === undefined) {
			agent = { known: null, held: null, health: null, dimension: null };
			this.#agents.set(agentId, agent);
		}
		return agent;
	}

	#held(agent, observation, reflexEvents) {
		if (agent.held === null) {
			agent.held = {
				hits: 0, healthFrom: agent.health ?? observation?.player?.health ?? null, healthTo: null, by: new Map(),
				threatSignals: 0, threatKinds: new Set(), projectiles: 0, fire: 0, routine: 0,
				items: itemCounts(observation), reflexSeq: Math.max(0, ...rowsOf(reflexEvents).map((event) => event?.seq ?? 0)),
			};
		}
		return agent.held;
	}

	/**
	 * The verdict for one attention sample while the model's own action runs: 'wake' (wake now, never held), 'hold'
	 * (absorbed: summed into the next wake, no deadline) or 'default' (the ordinary hold policy decides).
	 * input: { attention, observation, changedFacts, reflexRules, reflexEvents, goalText }.
	 */
	decide(agentId, { attention, observation, changedFacts = [], reflexRules = [], reflexEvents = [], goalText = null } = {}) {
		const agent = this.#agent(agentId);
		const known = agent.known ?? new Set();
		const player = observation?.player ?? {};
		const trigger = attention?.trigger;
		// A discovery wakes whatever the trigger: an enderman in range while pearls are open, a major structure seen.
		if (!known.has('minecraft:enderman') && nearEnderman(observation) && pearlsOpen(goalText, observation)) return this.#wake(agent, observation, 'enderman in range while pearls are open');
		const structure = trigger === 'structure_sighted' ? newMajorStructure(observation) : null;
		if (structure !== null) return this.#wake(agent, observation, `${structure} sighted`);
		if (attention?.priority !== 'urgent') {
			if (['attention', 'observation'].includes(trigger)) this.#held(agent, observation, reflexEvents).routine += 1;
			return { verdict: 'default' };
		}
		if (!ABSORBABLE.has(trigger)) return { verdict: 'wake', reason: trigger };
		if (lowHealth(player)) return this.#wake(agent, observation, 'health at or below the low floor');
		if (player.inLava === true || player.hazard === 'lava') return this.#wake(agent, observation, 'lava at the body');
		const held = this.#held(agent, observation, reflexEvents);
		const burning = player.onFire === true || player.fire === true || player.hazard === 'fire';
		if (trigger === 'damage') {
			const attacker = typeOf(player.lastAttacker?.type);
			// Damage with no mob behind it is a burn (judged as fire below) or something the filter cannot judge (a fall,
			// drowning, a cactus): that wakes.
			if (attacker === null && !burning) return this.#wake(agent, observation, 'damage with no seen attacker');
			if (attacker !== null && !known.has(attacker)) return this.#wake(agent, observation, `hit by a new kind: ${short(attacker)}`);
			if (attacker !== null && burning) {
				const fire = this.#fireVerdict(agent, observation, held, reflexRules, reflexEvents);
				if (fire !== null) return fire;
			}
			if (attacker === null) return this.#fireVerdict(agent, observation, held, reflexRules, reflexEvents) ?? { verdict: 'hold', reason: 'fire rule handling it' };
			held.hits += 1;
			held.healthTo = player.health ?? held.healthTo;
			held.by.set(attacker ?? 'unknown', (held.by.get(attacker ?? 'unknown') ?? 0) + 1);
			return { verdict: 'hold', reason: 'hit absorbed' };
		}
		if (trigger === 'threat') {
			const { kinds, signals } = signalledThreats(changedFacts, observation);
			const waking = [...signals].filter((signal) => WAKING_SIGNALS.has(signal));
			if (waking.length > 0) return this.#wake(agent, observation, `threat signal ${waking.join(', ')}`);
			const fresh = [...kinds].filter((kind) => !known.has(kind));
			if (fresh.length > 0) return this.#wake(agent, observation, `new hostile kind: ${fresh.map(short).join(', ')}`);
			held.threatSignals += 1;
			for (const kind of kinds) held.threatKinds.add(kind);
			return { verdict: 'hold', reason: 'known threat' };
		}
		if (trigger === 'projectile') {
			const flights = rowsOf(player.incomingProjectiles ?? observation?.incomingProjectiles).map((row) => typeOf(row?.type)).filter(Boolean);
			const fresh = flights.filter((type) => !known.has(`projectile:${type}`));
			if (fresh.length > 0 || flights.length === 0) return this.#wake(agent, observation, fresh.length > 0 ? `new projectile kind: ${fresh.map(short).join(', ')}` : 'projectile');
			held.projectiles += 1;
			return { verdict: 'hold', reason: 'known projectile' };
		}
		return this.#fireVerdict(agent, observation, held, reflexRules, reflexEvents) ?? { verdict: 'hold', reason: 'fire rule handling it' };
	}

	/** Burning is held only while an armed fire rule handles it and none of its firings failed since the hold began. */
	#fireVerdict(agent, observation, held, reflexRules, reflexEvents) {
		const fireRules = rowsOf(reflexRules).filter((rule) => FIRE_ACTIONS.has(rule?.do?.type) && rule.state !== 'disabled');
		if (fireRules.length === 0) return this.#wake(agent, observation, 'burning with no fire rule armed');
		const ids = new Set(fireRules.map((rule) => rule.id));
		const failed = rowsOf(reflexEvents).some((event) => (event?.seq ?? 0) > held.reflexSeq && FAILED_OUTCOMES.has(event.outcome) && (ids.has(event.id) || FIRE_ACTIONS.has(event.action)));
		if (failed) return this.#wake(agent, observation, 'burning after a fire rule failed');
		held.fire += 1;
		return null;
	}

	#wake(agent, observation, reason) {
		// What triggered this wake is shown in it, so the same kind does not wake again before the model's next turn.
		agent.known = new Set([...(agent.known ?? []), ...shownKinds(observation)]);
		return { verdict: 'wake', reason };
	}

	/**
	 * The facts held since the last wake as one line (consumed), or null. Also records what this wake shows the model
	 * (added to the kinds already shown in this dimension), so the next hold judges "new" against it.
	 */
	take(agentId, observation) {
		const agent = this.#agent(agentId);
		const held = agent.held;
		agent.held = null;
		// Kinds stay known across wakes in one dimension (the model has fought them); a new dimension starts over.
		const dimension = observation?.world?.dimension ?? null;
		agent.known = new Set([...(dimension === agent.dimension ? agent.known ?? [] : []), ...shownKinds(observation)]);
		agent.dimension = dimension;
		agent.health = Number.isFinite(observation?.player?.health) ? observation.player.health : null;
		if (held === null) return null;
		const parts = [];
		if (held.hits > 0) {
			const by = [...held.by].map(([kind, count]) => `${kind === 'unknown' ? 'unseen attacker' : short(kind)} ${count}`).join(', ');
			const health = Number.isFinite(held.healthFrom) && Number.isFinite(held.healthTo) ? `, health ${held.healthFrom} -> ${held.healthTo}` : '';
			parts.push(`${held.hits} hit(s) taken (${by}${health})`);
		}
		if (held.threatSignals > 0) parts.push(`${held.threatSignals} threat signal(s) from ${[...held.threatKinds].map(short).join(', ') || 'known mobs'}`);
		if (held.projectiles > 0) parts.push(`${held.projectiles} incoming projectile(s) of known kinds`);
		if (held.fire > 0) parts.push(`${held.fire} fire contact(s) with a fire rule armed`);
		const gained = [];
		for (const [item, count] of itemCounts(observation)) {
			const before = held.items.get(item) ?? 0;
			if (count > before) gained.push(`${short(item)} +${count - before}`);
		}
		if (gained.length > 0) parts.push(`items gained ${gained.join(', ')}`);
		if (held.routine > 0) parts.push(`${held.routine} routine update(s)`);
		return parts.length === 0 ? null : `not woken for: ${parts.join('; ')}`;
	}

	drop(agentId) { this.#agents.delete(agentId); }
}
