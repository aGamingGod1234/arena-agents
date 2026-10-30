import { RULE_LIFETIMES, lifetimeEnded, lifetimeStart } from './danger-contexts.mjs';

/**
 * Model-authored reflexes: small rules the mod evaluates every server tick, because a model round (5 to 17 s) is slower
 * than a blaze volley, a creeper fuse or drowning. The model writes every rule; nothing here chooses one. This module
 * validates the model's entries (the mod validates again), keeps each agent's authoritative rule set across goal
 * revisions, sends the whole set to the mod, and turns the mod's firing reports into short wake lines.
 *
 * Vocabulary: mirrors ReflexSpec.java (a test keeps the two tables equal). To add a condition or action, register its
 * parameters in both tables, then its sensing (ReflexSensors.java) or behaviour (ReflexActions.java).
 */

export const MAX_REFLEXES = 12;
/**
 * Default survival rules (Lucas's ruling 16, Oct 28: survival reflexes are on by default from spawn and the model can
 * switch any off). Armed at the first live sample, after each respawn and at each dimension change; a default the
 * model removes by id stays off until the next respawn or dimension change; one it replaces by id becomes its own rule.
 * They do not count toward the model's MAX_REFLEXES (the mod holds MAX_REFLEXES + DEFAULT_REFLEXES.length).
 */
export const DEFAULT_REFLEXES = Object.freeze([
	{ id: 'default-lava', kind: 'trigger', priority: 9, when: [{ type: 'in_lava' }], do: { type: 'leave_lava' }, ttlMs: 3_600_000 },
	{ id: 'default-fire', kind: 'trigger', priority: 8, when: [{ type: 'in_fire' }], do: { type: 'leave_fire' }, ttlMs: 3_600_000 },
	{ id: 'default-air', kind: 'trigger', priority: 8, when: [{ type: 'air_below', bubbles: 3 }], do: { type: 'swim_up' }, ttlMs: 3_600_000 },
	{ id: 'default-edge', kind: 'stance', priority: 7, when: [{ type: 'edge_near', within: 2, direction: 'any', drop: 4 }], do: { type: 'brace' }, ttlMs: 3_600_000 },
].map((rule) => Object.freeze(rule)));
export const DEFAULT_REFLEX_IDS = Object.freeze(new Set(DEFAULT_REFLEXES.map((rule) => rule.id)));
export const MAX_REFLEX_CONDITIONS = 4;
export const REFLEX_ID = /^[A-Za-z0-9_-]{1,32}$/;
const RESOURCE_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
export const TOOL_KINDS = Object.freeze(['any', 'axe', 'hoe', 'pickaxe', 'shield', 'shovel', 'sword']);
export const PLACE_WHERE = Object.freeze(['ahead', 'below', 'feet']);
// After this long without the mod echoing the current revision, the set is sent again (a lost message or a reconnect).
export const REFLEX_RESEND_MS = 1_500;
export const MAX_REFLEX_REPORT_BYTES = 700;
// The mod's longest rule lifetime (ReflexSpec.MAX_TTL_MS); a rule with no ttlS lasts 600 s there.
const MAX_REFLEX_TTL_MS = 3_600_000;
// A rule this close to its ttl is named in the wake line, so its expiry is not a surprise.
export const EXPIRY_WARNING_S = 120;

const number = (min, max, required = false) => ({ kind: 'number', min, max, required });
const ids = () => ({ kind: 'ids' });
const tool = () => ({ kind: 'tool' });
const item = (required = false) => ({ kind: 'item', required });
const where = () => ({ kind: 'where', required: true });
const choice = (...words) => ({ kind: 'choice', words });
const bool = () => ({ kind: 'bool' });
const entityId = () => ({ kind: 'entityId' });
const COORDINATE = 30_000_000;

/** Condition type -> parameters. Every value is something a player perceives (sight, hearing, the HUD). */
export const REFLEX_CONDITIONS = Object.freeze({
	incoming_projectile: { withinS: number(0.05, 2), projectiles: ids() },
	hostile_near: { within: number(1, 32, true), mobs: ids(), targetId: entityId() },
	target_in_reach: { mobs: ids() },
	health_below: { value: number(1, 40, true) },
	air_below: { bubbles: number(1, 10, true) },
	hunger_below: { value: number(1, 20, true) },
	tool_broke: { tool: tool() },
	on_fire: {},
	in_lava: {},
	in_fire: {},
	on_hot_floor: {},
	inventory_full: {},
	item_nearby: { within: number(1, 8), items: ids() },
	tool_low: { uses: number(1, 256, true), tool: tool() },
	falling: { blocks: number(1, 64, true) },
	saturation_empty: {},
	night: {},
	stack_used_up: { item: item() },
	// Combat and hazard senses (rx-combat).
	fireball_incoming: { withinS: number(0.05, 3), deflectable: bool() },
	creeper_fusing: { within: number(1, 16) },
	enderman_gaze: { within: number(1, 64) },
	enderman_provoked: { within: number(1, 64) },
	edge_near: { within: number(1, 4), direction: choice('ahead', 'behind', 'left', 'right', 'moving', 'any'), drop: number(2, 64) },
	lava_near: { within: number(1, 4) },
	lava_flowing: { withinS: number(0.5, 6) },
	attacked_from_behind: { within: number(1, 8) },
	exposed: { within: number(1, 48, true), mobs: ids() },
	cloud_near: { within: number(0, 4) },
	// The dragon seen flying at you: its flight line passes within about 10 blocks in the next 3 s.
	dragon_charging: { within: number(8, 96) },
	// Digging (midgame): the head inside a solid block, as falling sand or gravel lands on it.
	suffocating: {},
});

/** Action type -> parameters. Every action is a player input (keys, view, hotbar, a recharged swing). */
export const REFLEX_ACTIONS = Object.freeze({
	shield: { counter: bool() },
	attack: {},
	step_back: { blocks: number(1, 4) },
	eat: {},
	select: { tool: tool(), item: item() },
	swim_up: {},
	pickup: { within: number(1, 8) },
	place: { item: item(true), where: where() },
	stop: {},
	deflect: {},
	sprint_away: { blocks: number(2, 24) },
	move_to_cell: { x: number(-COORDINATE, COORDINATE, true), y: number(-2_048, 2_048, true), z: number(-COORDINATE, COORDINATE, true), sprint: bool() },
	sneak: {},
	look_away: {},
	place_block: { item: item(), count: number(1, 2) },
	take_cover: { within: number(2, 10) },
	away_from_edge: { blocks: number(2, 12) },
	dig_out: {},
	leave_fire: {},
	leave_lava: {},
	// Never takes the body: while its condition holds, a hit's shove toward a drop is walked back in any stance.
	brace: {},
});

function codedError(code, message) { return Object.assign(new Error(message), { code }); }
function invalid(message) { throw codedError('INVALID_REFLEX', message); }
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const RULE_FIELDS = ['id', 'kind', 'priority', 'when', 'do', 'until', 'maxS', 'cooldownS', 'ttlS', 'lasts', 'maxFirings', 'wake'];
const LASTS_TEXT = { night: 'until dawn', dimension: 'in this dimension', lava: 'near lava' };

function onlyKeys(value, allowed, path) {
	for (const key of Object.keys(value)) {
		if (allowed.includes(key)) continue;
		// A rule field written inside when/do is a misplaced field, not an unknown one: say where it goes.
		const rule = path.match(/^(reflexes\[\d+\])\.(?:when|do|until)/)?.[1];
		if (rule !== undefined && RULE_FIELDS.includes(key)) invalid(`${path} has ${key}, a rule field: put it on ${rule} beside when/do; ${path} allows ${allowed.join(', ')}`);
		invalid(`${path} has unknown field ${key}; allowed: ${allowed.join(', ')}`);
	}
}

function resourceId(value, path) {
	if (typeof value !== 'string' || value.length === 0) invalid(`${path} must be an id like minecraft:blaze`);
	const id = (value.includes(':') ? value : `minecraft:${value}`).toLowerCase();
	if (!RESOURCE_ID.test(id) || id.length > 128) invalid(`${path} has an invalid id ${value}`);
	return id;
}

function params(value, table, path, reserved) {
	onlyKeys(value, [...reserved, ...Object.keys(table)], path);
	const result = {};
	for (const [name, spec] of Object.entries(table)) {
		const raw = value[name];
		const field = `${path}.${name}`;
		if (raw === undefined) {
			if (spec.required) invalid(`${field} is required for ${value.type}`);
			continue;
		}
		if (spec.kind === 'number') {
			if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < spec.min || raw > spec.max) invalid(`${field} must be a number between ${spec.min} and ${spec.max}`);
			result[name] = raw;
		} else if (spec.kind === 'entityId') {
			if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) invalid(`${field} must be a UUID`);
			result[name] = raw.toLowerCase();
		} else if (spec.kind === 'ids') {
			if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) invalid(`${field} must list 1..8 ids like minecraft:blaze`);
			result[name] = [...new Set(raw.map((entry, index) => resourceId(entry, `${field}[${index}]`)))];
		} else if (spec.kind === 'choice') {
			if (!spec.words.includes(raw)) invalid(`${field} must be one of ${spec.words.join(', ')}`);
			result[name] = raw;
		} else if (spec.kind === 'bool') {
			if (typeof raw !== 'boolean') invalid(`${field} must be boolean`);
			result[name] = raw;
		} else if (spec.kind === 'tool') {
			if (!TOOL_KINDS.includes(raw)) invalid(`${field} must be one of ${TOOL_KINDS.join(', ')}`);
			result[name] = raw;
		} else if (spec.kind === 'where') {
			if (!PLACE_WHERE.includes(raw)) invalid(`${field} must be one of ${PLACE_WHERE.join(', ')}`);
			result[name] = raw;
		} else {
			result[name] = resourceId(raw, field);
		}
	}
	return result;
}

function conditions(value, path) {
	const rows = Array.isArray(value) ? value : [value];
	if (rows.length === 0 || rows.length > MAX_REFLEX_CONDITIONS) invalid(`${path} needs 1..${MAX_REFLEX_CONDITIONS} conditions (all must hold)`);
	return rows.map((row, index) => {
		const field = Array.isArray(value) ? `${path}[${index}]` : path;
		if (!isObject(row)) invalid(`${field} must be a condition object like {type:"hostile_near",within:12}`);
		const table = REFLEX_CONDITIONS[row.type];
		if (table === undefined) invalid(`${field}.type ${JSON.stringify(row.type)} is not a reflex condition; use one of ${Object.keys(REFLEX_CONDITIONS).join(', ')}`);
		if (row.not !== undefined && typeof row.not !== 'boolean') invalid(`${field}.not must be boolean`);
		return { type: row.type, ...(row.not === true ? { not: true } : {}), ...params(row, table, field, ['type', 'not']) };
	});
}

function seconds(value, path, min, max) {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${path} must be seconds between ${min} and ${max}`);
	return Math.round(value * 1_000);
}

/**
 * One model entry: a full rule (installed or replacing the same id) or {id, remove:true} (id "*" removes all).
 * Returns the canonical wire rule, or {id, remove:true}.
 */
export function normalizeReflexEntry(entry, index = 0) {
	const path = `reflexes[${index}]`;
	if (!isObject(entry)) invalid(`${path} must be an object`);
	if (entry.remove !== undefined) {
		if (entry.remove !== true) invalid(`${path}.remove must be true`);
		onlyKeys(entry, ['id', 'remove'], path);
		if (entry.id !== '*' && (typeof entry.id !== 'string' || !REFLEX_ID.test(entry.id))) invalid(`${path}.id must be a reflex id or "*"`);
		return { id: entry.id, remove: true };
	}
	onlyKeys(entry, RULE_FIELDS, path);
	if (typeof entry.id !== 'string' || !REFLEX_ID.test(entry.id)) invalid(`${path}.id must be 1..32 letters, digits, _ or -`);
	const kind = entry.kind ?? 'trigger';
	if (!['trigger', 'stance'].includes(kind)) invalid(`${path}.kind must be trigger (fires once when its condition becomes true) or stance (holds while it is true)`);
	if (entry.priority !== undefined && (!Number.isInteger(entry.priority) || entry.priority < 1 || entry.priority > 9)) invalid(`${path}.priority must be an integer 1..9 (survival high, work low)`);
	if (entry.when === undefined) invalid(`${path}.when is required`);
	const when = conditions(entry.when, `${path}.when`);
	if (when.every((condition) => condition.not === true)) invalid(`${path}.when needs at least one condition that is not negated`);
	if (!isObject(entry.do)) invalid(`${path}.do must be an action object like {type:"shield"}`);
	const table = REFLEX_ACTIONS[entry.do.type];
	if (table === undefined) invalid(`${path}.do.type ${JSON.stringify(entry.do.type)} is not a reflex action; use one of ${Object.keys(REFLEX_ACTIONS).join(', ')}`);
	const action = { type: entry.do.type, ...params(entry.do, table, `${path}.do`, ['type']) };
	if (action.type === 'select' && (action.tool === undefined) === (action.item === undefined)) invalid(`${path}.do select needs exactly one of tool or item`);
	const until = entry.until === undefined ? undefined : conditions(entry.until, `${path}.until`);
	if (entry.maxFirings !== undefined && (!Number.isInteger(entry.maxFirings) || entry.maxFirings < 1 || entry.maxFirings > 1_000)) invalid(`${path}.maxFirings must be an integer 1..1000`);
	if (entry.wake !== undefined && typeof entry.wake !== 'boolean') invalid(`${path}.wake must be boolean`);
	const maxMs = seconds(entry.maxS, `${path}.maxS`, 0.25, kind === 'stance' && action.type === 'shield' ? 600 : 20);
	const cooldownMs = seconds(entry.cooldownS, `${path}.cooldownS`, 0.25, 60);
	const ttlMs = seconds(entry.ttlS, `${path}.ttlS`, 1, 3_600);
	if (entry.lasts !== undefined && !RULE_LIFETIMES.includes(entry.lasts)) invalid(`${path}.lasts must be one of ${RULE_LIFETIMES.join(', ')} (night: until dawn; dimension: until you leave this dimension; lava: until you are away from lava)`);
	return {
		id: entry.id, kind, ...(entry.priority === undefined ? {} : { priority: entry.priority }), when, do: action,
		...(until === undefined ? {} : { until }), ...(maxMs === undefined ? {} : { maxMs }), ...(cooldownMs === undefined ? {} : { cooldownMs }),
		// stop exists to hand the moment back to the model, so it wakes unless the rule says wake:false.
		...(ttlMs === undefined ? {} : { ttlMs }), ...(entry.lasts === undefined ? {} : { lasts: entry.lasts }), ...(entry.maxFirings === undefined ? {} : { maxFirings: entry.maxFirings }), ...(entry.wake === true || (entry.wake === undefined && action.type === 'stop') ? { wake: true } : {}),
	};
}

export function normalizeReflexEntries(value) {
	if (!Array.isArray(value)) invalid('reflexes must be an array of rules ({id, when, do, ...}) or {id, remove:true}');
	if (value.length > MAX_REFLEXES) invalid(`reflexes holds at most ${MAX_REFLEXES} entries`);
	const entries = value.map((entry, index) => normalizeReflexEntry(entry, index));
	const ids = entries.filter((entry) => entry.remove !== true).map((entry) => entry.id);
	if (new Set(ids).size !== ids.length) invalid('reflexes lists the same id twice');
	return entries;
}

/**
 * What a rule's action needs that the latest sample shows the body lacks, else null: the mod's own check
 * (ReflexActions.lacks) for the items a rule names, so the arm result says it before the mod echoes the set.
 */
export function reflexLacks(action, observation) {
	const items = observation?.inventory?.items;
	if (!Array.isArray(items) || action === undefined) return null;
	const inHand = (item) => item.hotbar === true || item.slot === 'mainhand' || item.slot === 'offhand';
	const has = (where, id) => items.some((item) => where(item) && item.itemId === id);
	switch (action.type) {
		case 'place': return has(inHand, action.item) ? null : `no ${action.item} in hotbar or offhand`;
		case 'place_block': return action.item === undefined || has((item) => item.hotbar === true || item.slot === 'mainhand', action.item) ? null : `no ${action.item} in hotbar`;
		case 'select': return action.item === undefined || has((item) => typeof item.slot === 'number' || item.slot === 'mainhand' || item.slot === 'offhand', action.item) ? null : `no ${action.item} in inventory`;
		case 'shield': return has((item) => item.slot === 'mainhand' || item.slot === 'offhand', 'minecraft:shield') ? null : 'no shield in either hand';
		default: return null;
	}
}

function eventLine(event) {
	const seconds = event.ms >= 1_000 ? ` ${(event.ms / 1_000).toFixed(1)} s` : '';
	const verb = { done: 'done', timeout: 'hit maxS', failed: 'failed', preempted: 'preempted', yielded: 'yielded', disabled: 'DISABLED', expired: 'expired', removed: 'removed' }[event.outcome] ?? event.outcome;
	return `${event.id} ${verb}${['done', 'timeout', 'preempted', 'yielded'].includes(event.outcome) ? seconds : ''}${event.detail ? `: ${event.detail}` : ''}`;
}

/** The authoritative rule sets, per agent. Rules persist across goal revisions; they end by expiry or the model. */
export class ReflexBook {
	#agents = new Map();
	// The latest live sample per agent, kept apart from #agents so seeing one never opens a rule book (a book's first
	// mod report must still count as new once the model installs rules).
	#samples = new Map();
	#now;
	#defaults;

	/** `defaults`: the rules armed by default (tests of the model's own rules pass []). */
	constructor({ now = Date.now, defaults = DEFAULT_REFLEXES } = {}) { this.#now = now; this.#defaults = defaults; }

	#agent(agentId) {
		let agent = this.#agents.get(agentId);
		if (agent === undefined) {
			agent = { rules: new Map(), revision: 0, sentAtMs: null, lastSeq: 0, pending: [], status: null, lifetimes: new Map(),
				// Ids holding the default definition now, ids the model switched off, and the last live context seen.
				defaults: new Set(), declined: new Set(), dimension: null, dead: false, seenLive: false };
			this.#agents.set(agentId, agent);
		}
		return agent;
	}

	/** Applies normalized entries (install/replace/remove); throws before changing anything when the result is too large. */
	apply(agentId, entries) {
		const agent = this.#agent(agentId);
		const next = new Map(agent.rules);
		const defaults = new Set(agent.defaults), declined = new Set(agent.declined);
		for (const entry of entries) {
			if (entry.remove === true) {
				// "*" removes the model's own rules; a default rule is switched off by its id.
				if (entry.id === '*') { for (const id of [...next.keys()]) if (!defaults.has(id)) next.delete(id); }
				else {
					next.delete(entry.id);
					if (defaults.delete(entry.id) || DEFAULT_REFLEX_IDS.has(entry.id)) declined.add(entry.id);
				}
			} else {
				next.set(entry.id, entry);
				defaults.delete(entry.id);
			}
		}
		const own = [...next.keys()].filter((id) => !defaults.has(id));
		if (own.length > MAX_REFLEXES) throw codedError('REFLEX_LIMIT', `At most ${MAX_REFLEXES} reflexes of your own besides the default rules; remove some by id first (installed: ${[...agent.rules.keys()].join(', ')})`);
		const changed = entries.length > 0;
		if (changed) {
			agent.rules = next;
			agent.defaults = defaults;
			agent.declined = declined;
			agent.revision += 1;
			// A rule with a context lifetime starts it from the latest sample; a replaced or removed one drops its old state.
			for (const id of [...agent.lifetimes.keys()]) if (next.get(id)?.lasts === undefined) agent.lifetimes.delete(id);
			for (const entry of entries) {
				if (entry.remove === true || entry.lasts === undefined) continue;
				agent.lifetimes.set(entry.id, lifetimeStart(entry.lasts, this.#samples.get(agentId) ?? null, this.#now()));
			}
		}
		return { changed, rules: [...next.values()] };
	}

	/**
	 * Ends rules whose context lifetime is over on this live sample (dawn, another dimension, away from lava): they are
	 * removed like a model removal and reported as expired in the next wake. Returns whether the set changed.
	 */
	observeContext(agentId, observation) {
		this.#samples.set(agentId, observation);
		const armed = this.#armDefaults(agentId, observation);
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return armed;
		const ended = [];
		for (const [id, state] of agent.lifetimes) {
			const why = lifetimeEnded(state, observation, this.#now());
			if (why !== null) ended.push([id, why]);
		}
		if (ended.length === 0) return armed;
		for (const [id, why] of ended) {
			agent.lifetimes.delete(id);
			agent.rules.delete(id);
			agent.pending.push({ id, outcome: 'expired', detail: why });
		}
		agent.pending = agent.pending.slice(-16);
		agent.revision += 1;
		return true;
	}

	/**
	 * Arms the default rules that are missing: on the first live sample (spawn), after a respawn and at a dimension change
	 * (which also end the model's switch-offs), and on any later sample for a default that expired or the mod dropped.
	 * Returns whether the set changed.
	 */
	#armDefaults(agentId, observation) {
		// With no defaults the book opens only when the model installs rules (its first mod report then counts as new).
		if (this.#defaults.length === 0) return false;
		const agent = this.#agent(agentId);
		if (observation?.player?.dead === true || observation?.death != null || observation?.status === 'PLAYER_DEAD') {
			agent.dead = true;
			return false;
		}
		const dimension = observation?.world?.dimension;
		if (observation?.ready === false || typeof dimension !== 'string') return false;
		const event = !agent.seenLive ? 'spawn' : agent.dead ? 'respawn' : dimension !== agent.dimension ? 'dimension' : null;
		agent.seenLive = true;
		agent.dead = false;
		agent.dimension = dimension;
		if (event !== null) agent.declined.clear();
		const missing = this.#defaults.filter((rule) => !agent.rules.has(rule.id) && !agent.declined.has(rule.id));
		if (missing.length === 0) return false;
		for (const rule of missing) {
			agent.rules.set(rule.id, structuredClone(rule));
			agent.defaults.add(rule.id);
		}
		agent.revision += 1;
		return true;
	}

	/** Whether the rule with this id is a default rule the model has not replaced. */
	isDefault(agentId, id) { return this.#agents.get(agentId)?.defaults.has(id) === true; }

	/** The installed rule definitions with the mod's live state (disabled rules say so), for coverage checks. */
	rules(agentId) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return [];
		const states = new Map(this.list(agentId).map(row => [row.id, row]));
		return [...agent.rules.values()].map(rule => {
			const row = states.get(rule.id);
			return { ...rule, state: row?.state, ...(row?.lacks ? { lacks: row.lacks } : {}) };
		});
	}

	has(agentId) { return (this.#agents.get(agentId)?.rules.size ?? 0) > 0; }

	/** The mod's latest firing reports as it sent them ({seq, id, outcome, ...}); not consumed. */
	events(agentId) { return this.#agents.get(agentId)?.status?.events ?? []; }

	/** The bridge payload for the agent's complete set. */
	payload(agentId, { yieldFiring = false } = {}) {
		const agent = this.#agent(agentId);
		agent.sentAtMs = this.#now();
		// The mod knows ttlMs only: a rule scoped to a context gets the longest ttl unless it set its own; the coordinator
		// ends it when the context ends.
		const rules = [...agent.rules.values()].map(({ lasts, ...rule }) => (lasts !== undefined && rule.ttlMs === undefined ? { ...rule, ttlMs: MAX_REFLEX_TTL_MS } : rule));
		return { revision: agent.revision, rules: structuredClone(rules), yield: yieldFiring };
	}

	/** Whether the mod reports a firing now (a direct model command then takes the body from it). */
	firing(agentId) { return this.#agents.get(agentId)?.status?.firing != null; }

	/**
	 * The id of a firing `stop` rule not handled yet (returned once per firing), else null. The coordinator then cancels
	 * the running program or action; the mod holds the body still meanwhile.
	 */
	stopFiring(agentId) {
		const agent = this.#agents.get(agentId);
		const firing = agent?.status?.firing;
		if (firing == null || agent.rules.get(firing.id)?.do.type !== 'stop') return null;
		if (agent.stopHandled === firing.id) return null;
		agent.stopHandled = firing.id;
		return firing.id;
	}

	/**
	 * Reads the reflex status from a stored observation. Returns new firing reports, whether one asks to wake the model,
	 * and whether the mod lacks the current set (so the caller re-sends it).
	 */
	observe(agentId, status) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return { events: [], wake: false, resend: false };
		if (status !== undefined) agent.status = status;
		if (status !== undefined && status.firing?.id !== agent.stopHandled) agent.stopHandled = null;
		// The mod restarted its sequence (a reconnect cleared its rules): treat what it reports as new.
		if (status !== undefined && status.events.length > 0 && status.events.at(-1).seq < agent.lastSeq) agent.lastSeq = 0;
		const events = (status?.events ?? []).filter((event) => event.seq > agent.lastSeq);
		for (const event of events) agent.lastSeq = Math.max(agent.lastSeq, event.seq);
		// Only a report acknowledging the current definitions can retire them. An old revision may
		// contain an expiry for an id the model has since deliberately replaced.
		if (status?.revision === agent.revision && !status.error) {
			const live = new Set(status.rules.map(row => row.id));
			for (const id of agent.rules.keys()) if (!live.has(id)) {
				agent.rules.delete(id);
				agent.lifetimes.delete(id);
				if (!events.some(event => event.id === id && event.outcome === 'expired'))
					agent.pending.push({ id, outcome: 'expired', detail: 'no longer installed on server' });
			}
		}
		agent.pending.push(...events);
		agent.pending = agent.pending.slice(-16);
		const behind = agent.revision > 0 && (status === undefined || status.revision !== agent.revision);
		const resend = behind && agent.sentAtMs !== null && this.#now() - agent.sentAtMs >= REFLEX_RESEND_MS;
		return { events, wake: events.some((event) => event.wake === true), resend };
	}

	/** The rules as programs and the model read them: installed definitions joined with the mod's live state. */
	list(agentId) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return [];
		const live = new Map((agent.status?.revision === agent.revision ? agent.status.rules : []).map((row) => [row.id, row]));
		return [...agent.rules.values()].map((rule) => {
			const row = live.get(rule.id);
			// The rule arms either way; a missing item is a fact for the model (the mod's word once it echoes the set).
			const lacks = row === undefined ? reflexLacks(rule.do, this.#samples.get(agentId)) : row.lacks ?? null;
			return { id: rule.id, kind: rule.kind, ...(agent.defaults.has(rule.id) ? { default: true } : {}), ...(rule.lasts === undefined ? {} : { lasts: rule.lasts }), ...(row === undefined ? { state: 'pending' } : { state: row.state, fired: row.fired, expiresInS: row.expiresInS, ...(row.disabled ? { disabled: row.disabled } : {}) }), ...(lacks ? { lacks } : {}) };
		});
	}

	/** One wake line: installed rules and the firing reports since the last wake (consumed). Null when there is nothing. */
	takeReport(agentId) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined || (agent.rules.size === 0 && agent.pending.length === 0)) return null;
		// Lifetime next to each id: its context, or the seconds left once the ttl is near (default 600 s when unset).
		const armed = this.list(agentId).map((row) => `${row.id}${row.kind === 'stance' ? '(stance)' : ''}${row.state === 'disabled' ? '(disabled)' : ''}${row.lacks ? `(${row.lacks})` : ''}${row.lasts !== undefined ? `(${LASTS_TEXT[row.lasts]})`
			: Number.isFinite(row.expiresInS) && row.expiresInS <= EXPIRY_WARNING_S ? `(expires in ${row.expiresInS} s)` : ''}`);
		// Expiries are listed apart from firings, so a lapsed rule is never trimmed away as an old firing.
		const expired = agent.pending.filter((event) => event.outcome === 'expired').map((event) => `${event.id}${event.detail ? ` (${event.detail})` : ''}`);
		const reports = agent.pending.filter((event) => event.outcome !== 'expired').map(eventLine);
		agent.pending = [];
		const error = agent.status?.error ? `; mod rejected the set: ${agent.status.error}` : '';
		const head = `${armed.length > 0 ? `armed ${armed.join(', ')}` : 'none armed'}${expired.length > 0 ? `; expired: ${expired.join(', ')}` : ''}`;
		let line = `${head}${reports.length > 0 ? `; fired: ${reports.join('; ')}` : ''}${error}`;
		while (Buffer.byteLength(line, 'utf8') > MAX_REFLEX_REPORT_BYTES && reports.length > 1) {
			reports.shift();
			line = `${head}; fired (latest): ${reports.join('; ')}${error}`;
		}
		line = Buffer.byteLength(line, 'utf8') > MAX_REFLEX_REPORT_BYTES ? `${line.slice(0, MAX_REFLEX_REPORT_BYTES - 3)}...` : line;
		// Show authored definitions only in spare report space, keeping firing/failure evidence first.
		const definitions = [];
		for (const rule of agent.rules.values()) {
			if (agent.defaults.has(rule.id)) continue;
			const definition = { id: rule.id, kind: rule.kind, priority: rule.priority ?? 5, when: rule.when, do: rule.do, ...(rule.lasts === undefined ? {} : { lasts: rule.lasts }) };
			const candidate = `${line}; rules: ${JSON.stringify([...definitions, definition])}`;
			if (Buffer.byteLength(candidate, 'utf8') <= MAX_REFLEX_REPORT_BYTES) definitions.push(definition);
		}
		return definitions.length > 0 ? `${line}; rules: ${JSON.stringify(definitions)}` : line;
	}

	clear(agentId) { this.#agents.delete(agentId); this.#samples.delete(agentId); }
}
