/**
 * Decision-eval moment capture: scans recorded protocol traces and extracts raw decision moments on triggers.
 *
 * A moment is the RAW state a decision-eval case needs (schema.mjs): the recorded server observation, a few earlier
 * observations of the same life, the agent's recorded goal, plan progress and task memory, and the recent action
 * results. Nothing here renders prompt text; the renderer of each build does that.
 *
 * Input records are protocol audit rows ({ direction, envelope, observedAtMs }) as written to protocol.jsonl and
 * quality-protocol.jsonl, plus optional provider-turn rows (provider-turns.private.jsonl) that supply the goal,
 * plan progress line and task memory the model saw at the time.
 */
import { createHash } from 'node:crypto';

export const CAPTURE_TRIGGERS = Object.freeze([
	'damage', 'low_health', 'low_food', 'failed_action', 'hazard_lava', 'hazard_fire', 'hazard_drowning', 'hazard_fall',
	'hostile_near', 'night_falling', 'no_progress', 'plan_step_change', 'plan_step_stalled', 'inventory_full', 'respawn', 'threat_after_escape',
	'milestone_gained', 'dimension_change', 'structure_seen', 'progression_mob_seen', 'dragon_perched',
]);

// Progression moments ("have X, what next"): the first carried item of each stage of the vanilla route to the dragon,
// the first sight of a structure block that marks a stage (fortress, portal, stronghold), and a dimension change.
// The key is the milestone, so each one fires once per cooldown window, not once per stack change.
const MILESTONES = [
	['logs', /^minecraft:\w+_(log|stem)$/], ['crafting_table', /^minecraft:crafting_table$/], ['wooden_pickaxe', /^minecraft:wooden_pickaxe$/],
	['cobblestone', /^minecraft:(cobblestone|cobbled_deepslate|blackstone)$/], ['stone_pickaxe', /^minecraft:stone_pickaxe$/], ['furnace', /^minecraft:furnace$/],
	['raw_iron', /^minecraft:raw_iron$/], ['iron_ingot', /^minecraft:iron_ingot$/], ['iron_pickaxe', /^minecraft:iron_pickaxe$/],
	['iron_armor', /^minecraft:iron_(helmet|chestplate|leggings|boots)$/], ['shield', /^minecraft:shield$/], ['bucket', /^minecraft:(bucket|water_bucket|lava_bucket)$/],
	['bed', /^minecraft:\w+_bed$/], ['cooked_food', /^minecraft:(cooked_\w+|bread|baked_potato|golden_carrot)$/], ['diamond', /^minecraft:diamond$/],
	['diamond_pickaxe', /^minecraft:diamond_pickaxe$/], ['obsidian', /^minecraft:obsidian$/], ['flint_and_steel', /^minecraft:flint_and_steel$/],
	['blaze_rod', /^minecraft:blaze_(rod|powder)$/], ['ender_pearl', /^minecraft:ender_pearl$/], ['ender_eye', /^minecraft:ender_eye$/],
];
// Mobs a stage needs (pearls, blaze rods), hostile or not, when one first comes within this distance.
const PROGRESSION_MOBS = new Set(['minecraft:enderman', 'minecraft:blaze']);
const PROGRESSION_MOB_RADIUS = 32;
const STRUCTURE_BLOCKS = new Set(['nether_bricks', 'nether_brick_fence', 'spawner', 'nether_portal', 'obsidian', 'crying_obsidian', 'end_portal_frame', 'end_portal']
	.map((id) => `minecraft:${id}`));

export const DEFAULT_CAPTURE_OPTIONS = Object.freeze({
	cooldownMs: 30_000,          // the same trigger (and detail key) fires at most once per window
	previousObservations: 2,     // earlier observations of the same life kept with each moment
	recentResults: 5,
	hostileRadius: 12,
	creeperRadius: 10,
	hazardRadius: 3,
	lowHealth: 8,
	lowFood: 6,
	fallDistance: 4,
	noProgressMs: 90_000,
	noProgressRadius: 3,
	nightDayTime: 12_000,
	planStallMs: 300_000,        // the same open plan step for this long without the step changing
	escapeWindowMs: 15_000,      // a hostile still near this soon after a successful flee
});

// Fallback when an entity row predates the server's `hostile` flag.
const HOSTILE_TYPES = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
	'witch', 'enderman', 'slime', 'magma_cube', 'blaze', 'ghast', 'piglin_brute', 'hoglin', 'zoglin', 'wither_skeleton', 'phantom', 'pillager',
	'vindicator', 'ravager', 'silverfish', 'endermite', 'guardian', 'elder_guardian', 'warden', 'breeze', 'vex', 'evoker', 'shulker'].map((id) => `minecraft:${id}`));
const LAVA = new Set(['minecraft:lava']);
const FIRE = new Set(['minecraft:fire', 'minecraft:soul_fire', 'minecraft:campfire', 'minecraft:soul_campfire', 'minecraft:magma_block']);
const MAIN_INVENTORY_SLOTS = 36;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => Number.isFinite(value);

/** Canonical JSON (sorted keys) so hashes do not depend on key order. */
export function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	return JSON.stringify(value ?? null);
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const observationSha256 = (observation) => sha256(canonicalJson(observation));

/** The raw observation without the goal revision (cases are goal-revision independent; the renderer supplies it). */
export function rawObservation(payload) {
	const observation = isObject(payload?.observation) && payload.observation.player ? payload.observation : payload;
	if (!isObject(observation)) return null;
	const { goalRevision: _goalRevision, ...rest } = observation;
	return rest;
}

export function distance(a, b) {
	if (!a || !b) return Infinity;
	return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));
}

const isHostile = (entity) => entity?.alive !== false && entity?.type !== 'minecraft:item'
	&& (entity?.hostile === true || (entity?.hostile === undefined && HOSTILE_TYPES.has(entity?.type)));

function nearestHostile(observation, options) {
	let best = null;
	for (const entity of Array.isArray(observation.entities) ? observation.entities : []) {
		if (!isHostile(entity)) continue;
		const d = finite(entity.distance) ? entity.distance : distance(entity.position, observation.position);
		const radius = entity.type === 'minecraft:creeper' ? options.creeperRadius : options.hostileRadius;
		if (d <= radius && (best === null || d < best.distance)) best = { type: entity.type, distance: Math.round(d * 10) / 10, uuid: entity.uuid, targetingAgent: entity.targetingAgent === true };
	}
	return best;
}

function nearestBlock(observation, ids, radius) {
	let best = null;
	for (const block of Array.isArray(observation.blocks) ? observation.blocks : []) {
		if (!ids.has(block?.blockId)) continue;
		const d = distance({ x: block.x + 0.5, y: block.y + 0.5, z: block.z + 0.5 }, observation.position);
		if (d <= radius && (best === null || d < best.distance)) best = { blockId: block.blockId, distance: Math.round(d * 10) / 10 };
	}
	return best;
}

function occupiedMainSlots(observation) {
	const items = Array.isArray(observation.inventory?.items) ? observation.inventory.items : [];
	// The collector emits the selected hotbar slot once as 'mainhand' instead of its index, so it counts as one main slot.
	const main = (slot) => slot === 'mainhand' || (Number.isInteger(slot) && slot >= 0 && slot < MAIN_INVENTORY_SLOTS);
	return items.filter((item) => main(item?.slot) && item.itemId !== 'minecraft:air' && item.count > 0).length;
}

function milestonesOf(observation) {
	const items = Array.isArray(observation.inventory?.items) ? observation.inventory.items : [];
	const ids = items.filter((item) => item?.count > 0).map((item) => item.itemId);
	return MILESTONES.filter(([, re]) => ids.some((id) => re.test(id))).map(([name]) => name);
}

/** Structure blocks in sight (blocks and landmarks), each with its nearest distance. */
function structuresOf(observation) {
	const found = new Map();
	for (const block of [...(Array.isArray(observation.blocks) ? observation.blocks : []), ...(Array.isArray(observation.landmarks) ? observation.landmarks : [])]) {
		if (!STRUCTURE_BLOCKS.has(block?.blockId)) continue;
		const d = Math.round(distance({ x: block.x + 0.5, y: block.y + 0.5, z: block.z + 0.5 }, observation.position) * 10) / 10;
		if (!found.has(block.blockId) || d < found.get(block.blockId)) found.set(block.blockId, d);
	}
	return found;
}

function progressionMobsOf(observation) {
	const found = new Map();
	for (const entity of Array.isArray(observation.entities) ? observation.entities : []) {
		if (!PROGRESSION_MOBS.has(entity?.type) || entity.alive === false) continue;
		const d = finite(entity.distance) ? entity.distance : distance(entity.position, observation.position);
		if (d <= PROGRESSION_MOB_RADIUS && (!found.has(entity.type) || d < found.get(entity.type))) found.set(entity.type, Math.round(d * 10) / 10);
	}
	return found;
}

const dayTime = (observation) => finite(observation.world?.dayTime) ? ((observation.world.dayTime % 24_000) + 24_000) % 24_000 : null;
const alive = (observation) => observation?.ready !== false && finite(observation?.player?.health) && observation.player.health > 0;

/**
 * Trigger edges between two consecutive observations of one agent. Level triggers (low health, hazard, mob near,
 * inventory full) fire on the edge into the condition so one long episode yields one moment per cooldown window.
 */
export function detectObservationTriggers(previous, current, options = DEFAULT_CAPTURE_OPTIONS) {
	const out = [];
	if (!alive(current)) return out;
	const p = current.player, q = previous?.player;
	const was = (test) => previous != null && alive(previous) && test(previous);
	if (q && finite(q.health) && q.health - p.health >= 1 && alive(previous)) out.push({ trigger: 'damage', key: 'damage', detail: { from: q.health, to: p.health } });
	if (p.health <= options.lowHealth && !was((o) => o.player.health <= options.lowHealth)) out.push({ trigger: 'low_health', key: 'low_health', detail: { health: p.health, food: p.foodLevel } });
	if (finite(p.foodLevel) && p.foodLevel <= options.lowFood && !was((o) => o.player.foodLevel <= options.lowFood)) out.push({ trigger: 'low_food', key: 'low_food', detail: { food: p.foodLevel, health: p.health } });
	const lava = (o) => o.player.inLava === true || nearestBlock(o, LAVA, options.hazardRadius) !== null;
	if (lava(current) && !was(lava)) out.push({ trigger: 'hazard_lava', key: 'hazard_lava', detail: { inLava: p.inLava === true, onFire: p.onFire === true, near: nearestBlock(current, LAVA, options.hazardRadius) } });
	const fire = (o) => (o.player.onFire === true && o.player.inLava !== true) || nearestBlock(o, FIRE, options.hazardRadius) !== null;
	if (fire(current) && !was(fire)) out.push({ trigger: 'hazard_fire', key: 'hazard_fire', detail: { onFire: p.onFire === true, near: nearestBlock(current, FIRE, options.hazardRadius) } });
	const drowning = (o) => o.player.underWater === true && finite(o.player.air) && finite(o.player.maxAir) && o.player.air < o.player.maxAir / 2;
	if (drowning(current) && !was(drowning)) out.push({ trigger: 'hazard_drowning', key: 'hazard_drowning', detail: { air: p.air, maxAir: p.maxAir } });
	const falling = (o) => finite(o.player.fallDistance) && o.player.fallDistance >= options.fallDistance;
	if (falling(current) && !was(falling)) out.push({ trigger: 'hazard_fall', key: 'hazard_fall', detail: { fallDistance: p.fallDistance } });
	const hostile = nearestHostile(current, options);
	if (hostile !== null) {
		const before = previous && alive(previous) ? nearestHostile(previous, options) : null;
		if (before === null || before.type !== hostile.type) out.push({ trigger: 'hostile_near', key: `hostile_near:${hostile.type}`, detail: hostile });
	}
	const now = dayTime(current), then = previous ? dayTime(previous) : null;
	if (now !== null && then !== null && then < options.nightDayTime && now >= options.nightDayTime && now < 18_000) out.push({ trigger: 'night_falling', key: 'night_falling', detail: { dayTime: now, skyOpen: p.skyOpen } });
	const full = (o) => occupiedMainSlots(o) >= MAIN_INVENTORY_SLOTS;
	if (full(current) && !was(full)) out.push({ trigger: 'inventory_full', key: 'inventory_full', detail: { occupied: occupiedMainSlots(current) } });
	// Progression edges need a living previous observation: the first observation of a life (or of a trace) states
	// what was already carried and seen, which is not a new milestone.
	if (previous != null && alive(previous)) {
		const before = new Set(milestonesOf(previous)), seenBefore = structuresOf(previous);
		for (const name of milestonesOf(current)) if (!before.has(name)) out.push({ trigger: 'milestone_gained', key: `milestone_gained:${name}`, detail: { milestone: name } });
		for (const [blockId, d] of structuresOf(current)) if (!seenBefore.has(blockId)) out.push({ trigger: 'structure_seen', key: `structure_seen:${blockId}`, detail: { blockId, distance: d } });
		const mobsBefore = progressionMobsOf(previous);
		for (const [type, d] of progressionMobsOf(current)) if (!mobsBefore.has(type)) out.push({ trigger: 'progression_mob_seen', key: `progression_mob_seen:${type}`, detail: { type, distance: d } });
		const from = previous.world?.dimension, to = current.world?.dimension;
		if (typeof from === 'string' && typeof to === 'string' && from !== to) out.push({ trigger: 'dimension_change', key: `dimension_change:${to}`, detail: { from, to } });
	}
	// The ender dragon seen landing on the exit fountain: the perch the player may fight it at.
	const perched = perchedDragonRow(current);
	if (perched !== null && was((o) => perchedDragonRow(o) === null)) out.push({ trigger: 'dragon_perched', key: 'dragon_perched', detail: { distance: perched.distance ?? null, health: perched.health ?? null } });
	return out;
}

function perchedDragonRow(observation) {
	const rows = Array.isArray(observation?.entities) ? observation.entities : [];
	return rows.find((e) => e?.type === 'minecraft:ender_dragon' && typeof e.partName !== 'string' && e.alive !== false
		&& e.perceivedBy !== 'sound' && e.appearance?.motion === 'perched') ?? null;
}

/** "open wood[unmet:#logs 0/8]; later:6" -> "wood" (the plan step the model was shown as open). */
export function openPlanStep(progressLine) {
	if (typeof progressLine !== 'string') return null;
	const match = /(?:^|;\s*)(?:open|active|next)\s+([A-Za-z0-9_-]+)/.exec(progressLine);
	return match ? match[1] : null;
}

/** Structured payload of a recorded provider-turn input ("<header line> {json}"), or null. */
export function providerTurnPayload(row) {
	const input = typeof row?.input === 'string' ? row.input : '';
	const start = input.indexOf('{');
	if (start < 0) return null;
	try {
		const parsed = JSON.parse(input.slice(start));
		return isObject(parsed?.data) ? parsed.data : (isObject(parsed) ? parsed : null);
	} catch { return null; }
}

/**
 * Streaming extractor for one trace. Feed protocol rows in file order with `ingest(row, line)`; provider-turn rows
 * may be given up front (`turns`) and are applied by timestamp. `moments` holds the captured moments.
 */
export class MomentCapture {
	#options; #trace; #turns; #turnIndex = 0;
	#agents = new Map();
	moments = [];
	stats = { rows: 0, observations: 0, results: 0, failures: 0, deaths: 0, suppressed: 0, triggers: {} };

	constructor({ trace, runId = null, scenarioId = null, turns = [], options = {} } = {}) {
		this.#options = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
		this.#trace = trace;
		this.runId = runId;
		this.scenarioId = scenarioId;
		this.#turns = turns.filter((row) => finite(row?.timestamp) && row?.executionSettings?.controlProtocol !== 'goal_spec')
			.map((row) => ({ at: row.timestamp, agentId: row.agentId, data: providerTurnPayload(row) }))
			.filter((row) => row.data !== null).sort((a, b) => a.at - b.at);
	}

	#agent(agentId) {
		let agent = this.#agents.get(agentId);
		if (!agent) {
			agent = { history: [], commands: new Map(), results: [], pendingFailure: null, lastFire: new Map(), dead: false, respawnPending: false,
				goal: null, goalSpec: null, progress: null, openStep: null, taskMemory: null, stall: null };
			this.#agents.set(agentId, agent);
		}
		return agent;
	}

	#applyTurns(agentId, atMs, agent) {
		while (this.#turnIndex < this.#turns.length && this.#turns[this.#turnIndex].at <= atMs) {
			const turn = this.#turns[this.#turnIndex++];
			const target = turn.agentId && this.#agents.has(turn.agentId) ? this.#agents.get(turn.agentId) : agent;
			const data = turn.data;
			if (typeof data.goal === 'string' && data.goal.trim()) target.goal = data.goal;
			if (isObject(data.goalSpec)) target.goalSpec = data.goalSpec;
			if (isObject(data.taskMemory)) target.taskMemory = data.taskMemory;
			if (typeof data.progress === 'string') {
				const open = openPlanStep(data.progress);
				if (target.progress !== null && open !== null && open !== target.openStep) target.pendingPlanChange = { from: target.openStep, to: open, progress: data.progress };
				target.progress = data.progress;
				if (open !== null) target.openStep = open;
			}
		}
	}

	#fire(agentId, agent, event, observation, envelopeMeta) {
		const at = observation.observedAtEpochMs ?? envelopeMeta.atMs;
		const last = agent.lastFire.get(event.key);
		this.stats.triggers[event.trigger] = (this.stats.triggers[event.trigger] ?? 0) + 1;
		if (last !== undefined && at - last < this.#options.cooldownMs) { this.stats.suppressed++; return; }
		agent.lastFire.set(event.key, at);
		const observationRaw = rawObservation(observation);
		const previousObservations = agent.history.slice(-this.#options.previousObservations - 1, -1).map(rawObservation);
		this.moments.push({
			id: `${this.#trace.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(-48)}-${event.trigger}-${at}`.replace(/^-+/, ''),
			trigger: event.trigger,
			detail: event.detail,
			source: {
				trace: this.#trace, line: envelopeMeta.line, atMs: at, messageId: envelopeMeta.messageId ?? null,
				runId: this.runId, scenarioId: this.scenarioId, agentId, observationSha256: observationSha256(observationRaw),
			},
			state: {
				observation: observationRaw,
				previousObservations,
				agent: {
					goal: agent.goal, goalSpec: agent.goalSpec, taskPlan: null, intent: null, continuity: null,
					taskMemory: agent.taskMemory, progressLine: agent.progress, openStep: agent.openStep,
					recentResults: agent.results.slice(-this.#options.recentResults),
				},
				wakeReason: event.trigger,
			},
		});
	}

	ingest(row, line = null) {
		this.stats.rows++;
		const envelope = row?.envelope;
		if (!isObject(envelope)) return;
		this.runId ??= row.runId ?? null;
		this.scenarioId ??= row.scenarioId ?? null;
		const payload = envelope.payload ?? {};
		const agentId = envelope.agentId;
		const meta = { line, messageId: envelope.messageId, atMs: row.observedAtMs };
		if (row.direction === 'coordinator_to_server' && envelope.type === 'action_command') {
			const agent = this.#agent(agentId);
			agent.commands.set(payload.actionId, { actionType: payload.actionType, arguments: payload.arguments });
			return;
		}
		if (row.direction !== 'server_to_coordinator') return;
		if (envelope.type === 'action_result') {
			const agent = this.#agent(agentId);
			this.stats.results++;
			const command = agent.commands.get(payload.actionId) ?? null;
			agent.commands.delete(payload.actionId);
			const entry = { tool: payload.actionType ?? command?.actionType ?? null, args: command?.arguments ?? null, result: payload, line };
			agent.results.push(entry);
			if (agent.results.length > 16) agent.results.shift();
			if (payload.state === 'SUCCEEDED' && entry.tool === 'flee_from') agent.escapedAt = payload.observedAtEpochMs ?? row.observedAtMs ?? null;
			if (payload.state !== 'SUCCEEDED' && payload.state !== 'CANCELLED') {
				this.stats.failures++;
				agent.pendingFailure = { reasonCode: payload.reasonCode, actionType: entry.tool, state: payload.state, line };
			}
			return;
		}
		// The goal as the server recorded it; a later provider turn's goal text replaces it.
		if (envelope.type === 'goal_spec_request' && typeof payload.originalRequest === 'string' && payload.originalRequest.trim()) {
			this.#agent(agentId).goal ??= payload.originalRequest;
			return;
		}
		if (envelope.type === 'goal_control' && payload.operation === 'start' && typeof payload.goal === 'string' && payload.goal.trim()) {
			const agent = this.#agent(agentId);
			agent.goal = payload.goal;
			if (isObject(payload.goalSpec)) agent.goalSpec = payload.goalSpec;
			return;
		}
		if (envelope.type === 'goal_control' && payload.operation === 'dead') {
			const agent = this.#agent(agentId);
			this.stats.deaths++;
			agent.dead = true; agent.respawnPending = true; agent.history = []; agent.pendingFailure = null; agent.stall = null; agent.pendingMilestones?.clear();
			return;
		}
		if (envelope.type !== 'observation' || !isObject(payload.player)) return;
		const agent = this.#agent(agentId);
		const at = payload.observedAtEpochMs ?? row.observedAtMs;
		this.#applyTurns(agentId, at, agent);
		this.stats.observations++;
		const previous = agent.history.at(-1) ?? null;
		if (!alive(payload)) { agent.history.push(payload); if (agent.history.length > 8) agent.history.shift(); return; }
		agent.history.push(payload);
		if (agent.history.length > 8) agent.history.shift();
		if (agent.goal === null) return; // no recorded goal yet: the moment would have no task context
		const detected = detectObservationTriggers(previous, payload, this.#options);
		// "Have X, what next" is the decision the player makes once the step that produced X has finished: a milestone
		// gained during a running action (a crafting sequence, a furnace transaction) fires on the first observation
		// with no running action, with the observation the player decides on.
		agent.pendingMilestones ??= new Map();
		for (const event of detected.filter((e) => e.trigger === 'milestone_gained')) agent.pendingMilestones.set(event.key, event);
		const events = detected.filter((e) => e.trigger !== 'milestone_gained');
		if (payload.currentAction?.active !== true && agent.pendingMilestones.size > 0) {
			// Only milestones the player still carries: one consumed or lost before the idle moment (ingots crafted into a
			// bucket, a dropped stack) is history, not the "have X" state this moment shows.
			const carried = new Set(milestonesOf(payload));
			events.push(...[...agent.pendingMilestones.values()].filter((event) => carried.has(event.detail.milestone)));
			agent.pendingMilestones.clear();
		}
		if (agent.respawnPending && agent.dead) { agent.respawnPending = false; agent.dead = false; events.push({ trigger: 'respawn', key: 'respawn', detail: { health: payload.player.health } }); }
		if (agent.pendingFailure !== null) {
			const failure = agent.pendingFailure; agent.pendingFailure = null;
			events.push({ trigger: 'failed_action', key: `failed_action:${failure.actionType}:${failure.reasonCode}`, detail: failure });
		}
		if (agent.pendingPlanChange) { events.push({ trigger: 'plan_step_change', key: 'plan_step_change', detail: agent.pendingPlanChange }); agent.pendingPlanChange = null; }
		if (agent.openStep !== null) {
			if (agent.stepSince?.step !== agent.openStep) agent.stepSince = { step: agent.openStep, at, firedAt: null };
			else if (at - (agent.stepSince.firedAt ?? agent.stepSince.at) >= this.#options.planStallMs) {
				agent.stepSince.firedAt = at;
				events.push({ trigger: 'plan_step_stalled', key: 'plan_step_stalled', detail: { step: agent.openStep, openMs: at - agent.stepSince.at, progress: agent.progress } });
			}
		}
		if (finite(agent.escapedAt) && at - agent.escapedAt <= this.#options.escapeWindowMs) {
			const threat = nearestHostile(payload, this.#options);
			if (threat !== null) { events.push({ trigger: 'threat_after_escape', key: 'threat_after_escape', detail: { ...threat, sinceEscapeMs: at - agent.escapedAt } }); agent.escapedAt = null; }
		}
		const position = payload.position;
		if (!agent.stall || distance(agent.stall.position, position) > this.#options.noProgressRadius) agent.stall = { position, since: at, fired: false };
		else if (!agent.stall.fired && at - agent.stall.since >= this.#options.noProgressMs) {
			agent.stall.fired = true;
			events.push({ trigger: 'no_progress', key: 'no_progress', detail: { stalledMs: at - agent.stall.since, radius: this.#options.noProgressRadius } });
		}
		for (const event of events) this.#fire(agentId, agent, event, payload, meta);
	}
}

/** Moment counts by trigger. */
export function summarizeMoments(moments) {
	const byTrigger = {};
	for (const moment of moments) byTrigger[moment.trigger] = (byTrigger[moment.trigger] ?? 0) + 1;
	return { total: moments.length, byTrigger };
}
