import { types as nodeTypes } from 'node:util';

import { ALL_FACT_DOMAINS, FACT_DOMAIN } from './fact-domains.mjs';
import { MAX_LINE_BYTES } from '../constants.mjs';
import { visiblePlayer, visibleWorld, visibleHealing } from '../player-visible-facts.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const OBSERVED_SETS = new WeakSet();
const CANDIDATE_ORIGINS = new WeakMap();
const INTERPRETER_FACTS = new WeakSet();
const FACT_STATS = new WeakMap();
const FACT_CLOCKS = new WeakMap();
// The deepest container copyFactData reached since trackedDepth last read it, and the deepest absolute depth so far in
// the fact tree being built. createInterpreterFacts places each copied subtree at a known depth in that tree.
let deepestCopy = -1;
let deepestFact = -1;
// Per trusted fact tree: the validated input each domain was projected from, and the context it was projected in.
const PROJECTIONS = new WeakMap();
// Whether a validated subtree projects without the player/inventory context (no nested "world" record to mask).
const CONTEXT_FREE = new WeakMap();
// Observation facts include geometry and derived position/menu aliases. Their
// structural allowance follows the existing bounded fact-byte envelope, rather
// than the smaller limits for arbitrary script-authored values. Only this
// module's validated, immutable trees receive the unforgeable fast-path brand.
const TRUST_LIMITS = Object.freeze({ depth: 256, nodes: MAX_LINE_BYTES * 2, keys: MAX_LINE_BYTES * 2, stringBytes: 16_384, factBytes: MAX_LINE_BYTES * 2, arrayLength: 256 });
const EMPTY_FACT_STATS = Object.freeze({ nodes: 0, keys: 0, bytes: 0, depth: -1 });

/** Builds an immutable, observation-only fact view. */
export function createFactView(observation) {
	const data = createInterpreterFacts(observation);
	const candidates = new WeakSet([data.world.items, data.world.entities, data.world.blocks]);
	const query = (list, criteria = {}) => {
		const filtered = filterObserved(list, criteria);
		candidates.add(filtered);
		return filtered;
	};
	return freezeRecord({
		player: data.player,
		world: freezeRecord({
			state: () => data.world.state,
			menu: () => data.world.menu,
			items: (criteria = {}) => query(data.world.items, criteria),
			entities: (criteria = {}) => query(data.world.entities, criteria),
			blocks: (criteria = {}) => query(data.world.blocks, criteria),
			nearest: (list, origin = data.player) => {
				if (!candidates.has(list)) throw new TypeError('nearest requires an observed candidate set');
				return nearest(list, origin);
			},
		}),
		inventory: freezeRecord({
			count: (itemId) => countInventory(data.inventory.items, itemId), countTag: (tag) => data.inventory.tagCounts[tag] ?? 0,
			slots: (criteria = {}) => filterObserved(data.inventory.items, criteria), state: () => data.inventory.state,
		}),
	});
}

/** Serializable frozen facts used by the interpreter. */
export function createInterpreterFacts(observation = {}, previousFacts = null) {
	const previous = INTERPRETER_FACTS.has(previousFacts) ? previousFacts : null;
	const before = PROJECTIONS.get(previous)?.input;
	deepestCopy = -1;
	deepestFact = -1;
	const source = ownDataRecord(observation, 'observation');
	const playerSource = ownDataRecord(source.player ?? Object.create(null), 'observation.player');
	playerSource.harm ??= null;
	if (Object.hasOwn(source, 'velocity')) playerSource.velocity = source.velocity;
	// Present (null when nothing is ahead) so a condition can test it without an unknown member; observations omit it.
	if (!Object.hasOwn(playerSource, 'dropAhead')) playerSource.dropAhead = null;
	if (!Object.hasOwn(playerSource, 'groundAhead')) playerSource.groundAhead = null;
	// Lists present (empty when nothing is reported) for the same reason; exits keep their reported cells as {x,y,z}.
	if (!Object.hasOwn(playerSource, 'clouds')) playerSource.clouds = [];
	if (!Object.hasOwn(playerSource, 'incomingProjectiles')) playerSource.incomingProjectiles = [];
	// Validate nested data before deriving aliases, so accessors and proxies never execute here.
	const checkedPlayer = trackedDepth(1, copyFactData(playerSource, 'observation.player'));
	const dangerCloud = checkedPlayer.clouds.find((cloud) => cloud !== null && typeof cloud === 'object'
		&& cloud.arming !== true && (cloud.harmful === true || cloud.harmUnknown === true) && (cloud.contact === true || cloud.entering === true));
	const exitCells = reportedExitCells(checkedPlayer.harm?.exits ?? checkedPlayer.exits);
	// checkedPlayer is already a validated frozen copy: only the derived aliases need copying, in the same key order.
	const frozenPlayer = reuseDomain(previous?.player, before?.player, Object.freeze(Object.assign(Object.create(null), checkedPlayer, trackedDepth(1, copyFactData({
		dropAhead: checkedPlayer.dropAhead == null ? null : { into: null, ...checkedPlayer.dropAhead },
		exitCells, safeExit: exitCells.find(cell => cell.safe) ?? null,
		cloudDanger: dangerCloud !== undefined, cloudExit: reportedCloudExit(dangerCloud),
	}, 'observation.player')))));
	const inventorySource = ownDataRecord(source.inventory ?? Object.create(null), 'observation.inventory');
	const tagCounts = Object.create(null);
	for (const [tag, count] of Object.entries(ownDataRecord(inventorySource.tagCounts ?? Object.create(null), 'observation.inventory.tagCounts'))) {
		if (validKey(tag) && nonNegativeInteger(count)) tagCounts[tag] = count;
	}
	const worldItems = reuseDomain(previous?.world.items, before?.world.items, trackedDepth(3, copyCandidates(source.items, 'item')));
	const worldEntities = reuseDomain(previous?.world.entities, before?.world.entities, trackedDepth(3, copyCandidates(source.entities, 'entity')));
	const worldBlocks = reuseDomain(previous?.world.blocks, before?.world.blocks, trackedDepth(3, copyCandidates(source.blocks, 'block')));
	const inventoryItems = reuseDomain(previous?.inventory.items, before?.inventory.items, trackedDepth(3, copyInventory(inventorySource.items)));
	const inventoryTagCounts = reuseDomain(previous?.inventory.tagCounts, before?.inventory.tagCounts, freezeRecord(tagCounts));
	const worldSource = ownDataRecord(source.world ?? Object.create(null), 'observation.world');
	for (const key of ['coverage', 'observedAtEpochMs', 'worldTick', 'interaction', 'recipes', 'events', 'perception', 'dimension', 'capabilities', 'landmarks', 'nearbyContainers', 'furnaces', 'reflexes']) {
		if (Object.hasOwn(source, key)) worldSource[key] = source[key];
	}
	// The seen portal frame lets a program check each cast without the block rows' height window and per-type cap.
	worldSource.portalFrames = Array.isArray(source.sighted?.portalFrames) ? source.sighted.portalFrames : [];
	const worldState = reuseDomain(previous?.world.state, before?.world.state, trackedDepth(2, copyFactData(worldSource, 'observation.world')));
	const interaction = ownDataRecord(source.interaction ?? Object.create(null), 'observation.interaction');
	const menu = reuseDomain(previous?.world.menu, before?.world.menu, trackedDepth(2, copyFactData(interaction.menu ?? source.menu ?? null, 'observation.menu')));
	const inventoryMetadata = Object.fromEntries(Object.entries(inventorySource).filter(([key]) => !['items', 'tagCounts'].includes(key)));
	const inventoryState = reuseDomain(previous?.inventory.state, before?.inventory.state, trackedDepth(2, copyFactData(inventoryMetadata, 'observation.inventory')));
	if (previous !== null
		&& frozenPlayer === previous.player
		&& worldItems === previous.world.items
		&& worldEntities === previous.world.entities
		&& worldBlocks === previous.world.blocks
		&& inventoryItems === previous.inventory.items
		&& inventoryTagCounts === previous.inventory.tagCounts
		&& worldState === previous.world.state && menu === previous.world.menu
		&& inventoryState === previous.inventory.state) return previous;
	const validated = freezeRecord({
		player: frozenPlayer,
		world: freezeRecord({ items: worldItems, entities: worldEntities, blocks: worldBlocks, state: worldState, menu }),
		inventory: freezeRecord({ items: inventoryItems, tagCounts: inventoryTagCounts, state: inventoryState }),
	});
	// Every subtree above is this module's own validated, frozen copy (or an equal one reused from the previous facts),
	// so it is not copied and validated a second time. Only the depth differs: each copy counted from its own root,
	// while a whole-tree copy counts from this one. A tree past that limit still takes the copy, which throws as before.
	// (Fixed containers reach depth 4: a row's tags and position.)
	if (deepestFact > TRUST_LIMITS.depth) copyFactData(validated, 'interpreter facts');
	return projectFactTree(validated, previous);
}

/** Public script facts have HUD precision; raw samples remain available only to the runtime classifier. */
export function projectInterpreterFacts(value, previousFacts = null) {
	// Validate every subtree before the presentation helpers can read properties or spread records.
	return projectFactTree(copyFactData(value, 'interpreter facts'), previousFacts);
}

function projectFactTree(data, previousFacts) {
	const previous = INTERPRETER_FACTS.has(previousFacts) ? previousFacts : null;
	const state = data.world.state;
	const rawTick = state.worldTick ?? state.gameTime;
	const before = FACT_CLOCKS.get(previous);
	const dimension = state.dimensionId ?? state.dimension;
	const body = data.player.uuid ?? data.player.entityId ?? data.player.playerId;
	const dead = data.player.dead === true || data.player.health === 0;
	const ticking = Number.isSafeInteger(rawTick) && rawTick >= 0 && !dead;
	const reset = !before || before.origin === null || !ticking || before.dead || rawTick < before.lastTick
		|| (dimension !== undefined && before.dimension !== undefined && dimension !== before.dimension)
		|| (body !== undefined && before.body !== undefined && body !== before.body);
	const clock = { origin: ticking ? reset ? rawTick : before.origin : null, lastTick: rawTick, dimension, body, dead };
	const masked = projectDomains(data, PROJECTIONS.get(previous), state.reducedDebugInfo === true);
	const player = reuseEqual(previous?.player, masked.player);
	const worldState = reuseEqual(previous?.world.state, freezeRecord({ ...masked.world.state,
		...(ticking ? { worldTick: rawTick - clock.origin } : {}),
	}));
	const items = reuseEqual(previous?.world.items, markObservedCandidateSet(masked.world.items));
	const entities = reuseEqual(previous?.world.entities, markObservedCandidateSet(masked.world.entities));
	const blocks = reuseEqual(previous?.world.blocks, markObservedCandidateSet(masked.world.blocks));
	const menu = reuseEqual(previous?.world.menu, masked.world.menu);
	const inventoryItems = reuseEqual(previous?.inventory.items, markObservedCandidateSet(masked.inventory.items));
	const tagCounts = reuseEqual(previous?.inventory.tagCounts, masked.inventory.tagCounts);
	const inventoryState = reuseEqual(previous?.inventory.state, masked.inventory.state);
	const facts = previous && player === previous.player && worldState === previous.world.state && items === previous.world.items
		&& entities === previous.world.entities && blocks === previous.world.blocks && menu === previous.world.menu
		&& inventoryItems === previous.inventory.items && tagCounts === previous.inventory.tagCounts && inventoryState === previous.inventory.state
		? previous : freezeRecord({ player, world: freezeRecord({ items, entities, blocks, state: worldState, menu }),
			inventory: freezeRecord({ items: inventoryItems, tagCounts, state: inventoryState }) });
	FACT_CLOCKS.set(facts, clock);
	if (withinInterpreterFactLimits(facts)) {
		INTERPRETER_FACTS.add(facts);
		if (facts !== previous) PROJECTIONS.set(facts, { input: data, domains: masked.domains });
	}
	return facts;
}

/**
 * The same projection as projectValidatedData over the whole tree, one domain at a time with the context that walk
 * gives it: the root's reduced flag, the inventory's own, and the raw player and inventory as context. A domain whose
 * validated input is the very one the previous facts projected, in the same context, keeps that projection. The world
 * state changes with every sample's clock, so it is always projected.
 */
function projectDomains(data, memo, rootReduced) {
	const world = { reduced: rootReduced || data.world.state?.reducedDebugInfo === true, player: data.player, inventory: data.inventory };
	const inventory = { reduced: rootReduced || data.inventory.state?.reducedDebugInfo === true, player: data.player, inventory: data.inventory };
	const sameContext = memo !== undefined && memo.input.player === data.player && memo.input.inventory === data.inventory;
	const domains = { reduced: Object.create(null) };
	const project = (name, input, previousInput, context, kind) => {
		domains.reduced[name] = context.reduced;
		const cached = memo?.domains;
		domains[name] = cached !== undefined && input === previousInput && cached.reduced[name] === context.reduced && (sameContext || contextFree(input))
			? cached[name] : projectValidatedData(input, context, kind);
	};
	const before = memo?.input;
	project('player', data.player, before?.player, { reduced: rootReduced, player: data.player, inventory: data.inventory }, 'player');
	project('items', data.world.items, before?.world.items, world, 'items');
	project('entities', data.world.entities, before?.world.entities, world, 'entities');
	project('blocks', data.world.blocks, before?.world.blocks, world, 'blocks');
	domains.state = projectValidatedData(data.world.state, world, 'world-state');
	project('menu', data.world.menu, before?.world.menu, world, 'menu');
	project('inventoryItems', data.inventory.items, before?.inventory.items, inventory, 'items');
	project('tagCounts', data.inventory.tagCounts, before?.inventory.tagCounts, inventory, 'tagCounts');
	project('inventoryState', data.inventory.state, before?.inventory.state, inventory, 'state');
	return { player: domains.player, world: { items: domains.items, entities: domains.entities, blocks: domains.blocks, state: domains.state, menu: domains.menu },
		inventory: { items: domains.inventoryItems, tagCounts: domains.tagCounts, state: domains.inventoryState }, domains };
}

/** True when no record below value is keyed "world", so its projection never reads the player or inventory context. */
function contextFree(value) {
	if (value === null || typeof value !== 'object') return true;
	let free = CONTEXT_FREE.get(value);
	if (free === undefined) CONTEXT_FREE.set(value, free = !hasWorldRecord(value));
	return free;
}

function hasWorldRecord(value) {
	if (value === null || typeof value !== 'object') return false;
	if (Array.isArray(value)) { for (const entry of value) if (hasWorldRecord(entry)) return true; return false; }
	for (const key of Object.keys(value)) if (key === 'world' || hasWorldRecord(value[key])) return true;
	return false;
}

/** Inspection/query results use the same semantic mask after ordinary query validation. */
export function projectScriptQueryData(value, context = {}) {
	const data = copyFactData(value, 'script query result');
	const options = ownDataRecord(context, 'script query projection context');
	return projectValidatedData(data, { reduced: options.reducedDebugInfo === true });
}

// Absolute world age is not a visible clock. worldTick is reintroduced only as private-origin elapsed time.
const HIDDEN_CLOCK_FIELDS = new Set(['gameTime', 'dayTime', 'naturalRegeneration', 'worldTick']);
const ROUNDED_KINDS = new Set(['position', 'view', 'debug', 'items', 'entities', 'blocks']);
const REDUCED_KINDS = new Set(['position', 'view', 'debug']);

function projectValidatedData(value, context, kind = '') {
	if (Array.isArray(value)) {
		const entryKind = kind === 'effects' ? 'effect' : kind;
		const projected = new Array(value.length);
		for (let index = 0; index < value.length; index += 1) projected[index] = projectValidatedData(value[index], context, entryKind);
		return Object.freeze(projected);
	}
	if (value === null || typeof value !== 'object') return value;
	const reduced = context.reduced || value.world?.reducedDebugInfo === true || value.state?.reducedDebugInfo === true;
	const playerContext = value.player ?? context.player;
	const inventoryContext = value.inventory ?? context.inventory;
	const entryContext = reduced === context.reduced && playerContext === context.player && inventoryContext === context.inventory
		? context : { reduced, player: playerContext, inventory: inventoryContext };
	// Built in key order without the hidden clock fields, which were projected and then deleted before: the same record.
	const built = Object.create(null);
	for (const key of Object.keys(value)) {
		if (HIDDEN_CLOCK_FIELDS.has(key)) continue;
		const entry = value[key];
		built[key] = entry === null || typeof entry !== 'object' ? entry : projectValidatedData(entry, entryContext, key === 'state' && kind === 'world' ? 'world-state' : key);
	}
	let record = built;
	if (kind === 'player') {
		const original = record;
		const { harm, ...presentation } = record;
		record = visiblePlayer(presentation);
		if (harm !== undefined) record.harm = harm;
		// These documented aliases and perceived contact facts are useful to guards; compact model deduplication is separate.
		for (const field of ['hunger', 'fire', 'hazard', 'exits', 'hurtBy', 'recentDamage', 'threat', 'highestRiskThreat', 'bestWeapon', 'heardLava']) if (Object.hasOwn(original, field)) record[field] = original[field];
		if (Number.isFinite(original.air)) {
			const maximum = Number.isFinite(original.maxAir) && original.maxAir > 0 ? original.maxAir : 300;
			const bubbles = Math.max(0, Math.min(10, Math.ceil((original.air - 2) * 10 / maximum)));
			if (original.underWater === true || original.air < maximum) record.airBubbles = bubbles;
			// Preserve the legacy guard API as HUD-derived coarse ticks, never the hidden air counter.
			record.air = bubbles * 30;
		}
		if (Array.isArray(original.effects)) record.effects = original.effects;
		record.harm ??= null;
		if (reduced) for (const field of ['x', 'y', 'z', 'yaw', 'pitch', 'position', 'view']) delete record[field];
	}
	if (kind === 'world-state' || kind === 'world' && !Object.hasOwn(value, 'state')) {
		record = visibleWorld({ ...record, dayTime: value.dayTime }, playerContext, inventoryContext);
		if (reduced) delete record.biome;
	}
	if (kind === 'healing') {
		record = visibleHealing(record);
		if (record.burn !== undefined) record.burn = freezeRecord(record.burn);
	}
	if (kind === 'effect' && Number.isFinite(record.duration) && record.duration !== -1) record.duration = Math.floor(record.duration / 20) * 20;
	if (typeof record.type === 'string' && record.type.includes(':')) for (const field of ['health', 'maxHealth']) delete record[field];
	if (ROUNDED_KINDS.has(kind)) {
		for (const field of ['x', 'y', 'z', 'yaw', 'pitch']) if (Number.isFinite(record[field])) record[field] = Math.round(record[field] * 1000) / 1000;
		if ((reduced && REDUCED_KINDS.has(kind)) || kind === 'debug' && record.reduced === true) for (const field of ['x', 'y', 'z', 'yaw', 'pitch', 'facing', 'biome', 'blockLight', 'skyLight']) delete record[field];
	}
	return record === built ? Object.freeze(record) : freezeRecord(record);
}

/** Returns true only for fact trees fully validated and frozen by this module. */
export function isTrustedInterpreterFacts(value) {
	return INTERPRETER_FACTS.has(value);
}

/** Compares trusted fact domains by identity after createInterpreterFacts structural sharing. */
export function changedInterpreterFactDomains(previous, next) {
	if (!INTERPRETER_FACTS.has(previous) || !INTERPRETER_FACTS.has(next)) return ALL_FACT_DOMAINS;
	let changed = 0;
	if (previous.player !== next.player) changed |= FACT_DOMAIN.player;
	if (previous.world.items !== next.world.items) changed |= FACT_DOMAIN.worldItems;
	if (previous.world.entities !== next.world.entities) changed |= FACT_DOMAIN.worldEntities;
	if (previous.world.blocks !== next.world.blocks) changed |= FACT_DOMAIN.worldBlocks;
	if (previous.inventory.items !== next.inventory.items) changed |= FACT_DOMAIN.inventoryItems;
	if (previous.inventory.tagCounts !== next.inventory.tagCounts) changed |= FACT_DOMAIN.inventoryTagCounts;
	if (previous.world.state !== next.world.state) changed |= FACT_DOMAIN.worldState;
	if (previous.world.menu !== next.world.menu) changed |= FACT_DOMAIN.menu;
	if (previous.inventory.state !== next.inventory.state) changed |= FACT_DOMAIN.inventoryState;
	return changed;
}

export function filterObserved(candidates, criteria = {}) {
	if (!OBSERVED_SETS.has(candidates)) throw new TypeError('candidate set is not an observed fact set');
	const record = ownDataRecord(criteria, 'criteria');
	const entries = Object.entries(record);
	if (entries.some(([key]) => !validKey(key))) throw new TypeError('criteria contains an unsafe key');
	return observedList(candidates.filter((candidate) => entries.every(([key, value]) => matches(candidate, key, value))), candidates);
}

export function nearest(candidates, origin) {
	if (!OBSERVED_SETS.has(candidates)) throw new TypeError('nearest requires an observed candidate set');
	if (candidates.length === 0) return null;
	const point = pointOf(origin, 'origin');
	let closest = candidates[0];
	let closestDistance = distanceSquared(closest, point);
	for (let index = 1; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		const candidateDistance = distanceSquared(candidate, point);
		if (candidateDistance < closestDistance
			|| (candidateDistance === closestDistance && codePointCompare(candidate.stableId, closest.stableId) < 0)) {
			closest = candidate;
			closestDistance = candidateDistance;
		}
	}
	return closest;
}

export function nearestFromCurrent(candidates, origin, currentSets) {
	if (!Array.isArray(currentSets) || !currentSets.includes(CANDIDATE_ORIGINS.get(candidates))) throw new TypeError('nearest candidates are not from the current observation');
	return nearest(candidates, origin);
}

export function markObservedCandidateSet(candidates) {
	if (!Array.isArray(candidates) || !Object.isFrozen(candidates)) throw new TypeError('observed candidate set must be a frozen array');
	OBSERVED_SETS.add(candidates);
	return candidates;
}

function copyCandidates(values, kind) {
	if (values === undefined) return observedList([]);
	return observedList(denseDataArray(values, `observation ${kind}s`).map((value) => copyCandidate(value, kind)));
}

function copyCandidate(value, kind) {
	const source = ownDataRecord(value, `observation ${kind}`);
	const required = kind === 'item' ? ['stableId', 'itemId', 'count', 'x', 'y', 'z'] : kind === 'entity' ? ['stableId', 'type', 'x', 'y', 'z'] : ['stableId', 'blockId', 'x', 'y', 'z'];
	if (required.some((key) => !Object.hasOwn(source, key))) throw new TypeError(`observation ${kind} has an invalid schema`);
	if (!Number.isFinite(source.x) || !Number.isFinite(source.y) || !Number.isFinite(source.z)) return null;
	if (typeof source.stableId !== 'string' || source.stableId.length === 0) throw new TypeError(`observation ${kind} has invalid identity`);
	if (kind === 'item' && (typeof source.itemId !== 'string' || !nonNegativeInteger(source.count))) throw new TypeError('observation item has invalid item fields');
	if (kind === 'entity' && typeof source.type !== 'string') throw new TypeError('observation entity has invalid type');
	if (kind === 'block' && typeof source.blockId !== 'string') throw new TypeError('observation block has invalid block id');
	const copied = copyRecordFields(source, `observation ${kind}`);
	if (Object.hasOwn(source, 'tags')) {
		const tags = denseDataArray(source.tags, `observation ${kind} tags`);
		if (tags.some((tag) => typeof tag !== 'string')) throw new TypeError(`observation ${kind} has invalid tags`);
		copied.tags = Object.freeze([...tags]);
	}
	copied.position = freezeRecord({ x: source.x, y: source.y, z: source.z });
	return Object.freeze(copied);
}

function copyInventory(values) {
	if (values === undefined) return observedList([]);
	return observedList(denseDataArray(values, 'observation inventory items').map((value) => {
		const source = ownDataRecord(value, 'observation inventory item');
		if (typeof source.itemId !== 'string' || !nonNegativeInteger(source.count)) throw new TypeError('observation inventory item has an invalid schema');
		const copied = copyRecordFields(source, 'observation inventory item');
		if (Object.hasOwn(source, 'tags')) {
			const tags = denseDataArray(source.tags, 'observation inventory item tags');
			if (tags.some((tag) => typeof tag !== 'string')) throw new TypeError('observation inventory item has invalid tags');
			copied.tags = Object.freeze([...tags]);
		}
		return Object.freeze(copied);
	}));
}

/** Same result as copying a validated record with copyFactData, minus the intermediate frozen copies. */
function copyRecordFields(source, label) {
	const copied = Object.create(null);
	let ancestors = null;
	for (const key of Object.keys(source)) {
		const entry = source[key];
		if (entry === undefined) continue;
		if (entry === null || typeof entry === 'string' || typeof entry === 'boolean' || Number.isFinite(entry)) { copied[key] = entry; continue; }
		ancestors ??= new Set([source]);
		copied[key] = copyFactData(entry, `${label}.${key}`, ancestors, 1);
	}
	return copied;
}

function copyFactData(value, label, ancestors = new Set(), depth = 0) {
	if (isFactPrimitive(value)) return value;
	return copyFactNode(value, { label, path: [] }, ancestors, depth);
}

function isFactPrimitive(value) {
	return value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
}

/** The label copyFactData names a failure with: the caller's label, then each record key on the way down. */
function factLabel(scope) {
	if (typeof scope === 'string') return scope;
	let text = scope.label;
	for (const key of scope.path) text += `.${key}`;
	return text;
}

/**
 * One validated frozen copy of a non-primitive fact, checking in ownDataRecord's and denseDataArray's order. Labels
 * are kept as a key path and spelled out only for an error, instead of one string per copied key.
 */
function copyFactNode(value, scope, ancestors, depth) {
	if (depth > TRUST_LIMITS.depth || ancestors.has(value)) throw new TypeError(`${factLabel(scope)} exceeds the depth limit or contains a cycle`);
	if (depth > deepestCopy) deepestCopy = depth;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const entries = denseDataArray(value, scope);
			for (let index = 0; index < entries.length; index += 1) {
				if (!isFactPrimitive(entries[index])) entries[index] = copyFactNode(entries[index], scope, ancestors, depth + 1);
			}
			return Object.freeze(entries);
		}
		if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) throw new TypeError(`${factLabel(scope)} must be a plain data record`);
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== null && prototype !== Object.prototype) throw new TypeError(`${factLabel(scope)} must be a plain data record`);
		const keys = Reflect.ownKeys(value);
		const entries = new Array(keys.length);
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index];
			if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) throw new TypeError(`${factLabel(scope)} contains an unsafe key`);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw new TypeError(`${factLabel(scope)}.${key} must be own data`);
			entries[index] = descriptor.value;
		}
		// Own keys come back integer keys first, then strings in insertion order: the order a null-prototype copy keeps.
		const copied = Object.create(null);
		for (let index = 0; index < keys.length; index += 1) {
			const entry = entries[index];
			if (entry === undefined) continue;
			if (isFactPrimitive(entry)) { copied[keys[index]] = entry; continue; }
			scope.path.push(keys[index]);
			copied[keys[index]] = copyFactNode(entry, scope, ancestors, depth + 1);
			scope.path.pop();
		}
		return Object.freeze(copied);
	} finally { ancestors.delete(value); }
}

function denseDataArray(value, label) {
	// A plain array with exactly its indices and `length` as own keys needs one descriptor check per element.
	// Anything else takes the exhaustive path below, which also names the failure.
	if (Array.isArray(value) && !nodeTypes.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype) {
		const length = value.length;
		if (Reflect.ownKeys(value).length === length + 1) {
			const copied = new Array(length);
			let index = 0;
			for (; index < length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) break;
				copied[index] = descriptor.value;
			}
			if (index === length) return copied;
		}
	}
	return exhaustiveDenseDataArray(value, label);
}

function exhaustiveDenseDataArray(value, label) {
	label = factLabel(label);
	if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a plain array`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) throw new TypeError(`${label} has unsafe keys`);
	const length = descriptors.length;
	if (!length || !Object.hasOwn(length, 'value') || length.get || length.set || !Number.isSafeInteger(length.value)) throw new TypeError(`${label} has invalid length`);
	const copied = [];
	for (let index = 0; index < length.value; index += 1) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw new TypeError(`${label} must be dense own data`);
		copied.push(descriptor.value);
	}
	if (keys.length !== length.value + 1) throw new TypeError(`${label} must not have holes or custom keys`);
	return copied;
}

function ownDataRecord(value, label) {
	if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) throw new TypeError(`${label} must be a plain data record`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) throw new TypeError(`${label} must be a plain data record`);
	const record = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) throw new TypeError(`${label} contains an unsafe key`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw new TypeError(`${label}.${key} must be own data`);
		record[key] = descriptor.value;
	}
	return record;
}

function countInventory(items, itemId) { return typeof itemId === 'string' ? items.reduce((total, item) => total + (item.itemId === itemId ? item.count : 0), 0) : 0; }
function matches(candidate, key, value) { return key === 'tag' ? Array.isArray(candidate.tags) && candidate.tags.includes(value) : Object.hasOwn(candidate, key) && candidate[key] === value; }
function distanceSquared(candidate, origin) { const point = pointOf(candidate, 'candidate'); return (point.x - origin.x) ** 2 + (point.y - origin.y) ** 2 + (point.z - origin.z) ** 2; }
function pointOf(value, label) { const source = ownDataRecord(value, label); const point = Object.hasOwn(source, 'position') ? ownDataRecord(source.position, `${label}.position`) : source; if (![point.x, point.y, point.z].every(Number.isFinite)) throw new TypeError(`${label} requires finite coordinates`); return { x: point.x, y: point.y, z: point.z }; }
function codePointCompare(left, right) { return left === right ? 0 : left < right ? -1 : 1; }
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function validKey(key) { return !FORBIDDEN_KEYS.has(key); }
function observedList(values, origin = null) { const frozen = Object.freeze(values.filter((value) => value !== null)); OBSERVED_SETS.add(frozen); if (origin !== null) CANDIDATE_ORIGINS.set(frozen, origin); return frozen; }
function freezeRecord(values) { return Object.freeze(Object.assign(Object.create(null), values)); }

/**
 * reuseEqual against the validated input the previous facts were projected from, so an unchanged domain keeps its
 * projection, else against the previous public facts as before.
 */
function reuseDomain(previousPublic, previousInput, next) {
	const reused = previousInput === undefined ? next : reuseEqual(previousInput, next);
	return reused !== next ? reused : reuseEqual(previousPublic, next);
}

function reuseEqual(previous, next) {
	if (previous === undefined || !sameTrustedValue(previous, next)) return next;
	return previous;
}

function sameTrustedValue(left, right) {
	if (Object.is(left, right)) return true;
	if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left)) {
		if (left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) if (!sameTrustedValue(left[index], right[index])) return false;
		return true;
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	for (let index = 0; index < leftKeys.length; index += 1) {
		const key = leftKeys[index];
		if (key !== rightKeys[index] || !sameTrustedValue(left[key], right[key])) return false;
	}
	return true;
}

/** Records how deep the copy just made reaches in the fact tree, given the depth its root sits at there. */
function trackedDepth(offset, value) {
	if (deepestCopy >= 0) deepestFact = Math.max(deepestFact, deepestCopy + offset);
	deepestCopy = -1;
	return value;
}

function withinInterpreterFactLimits(root) {
	const stats = interpreterFactStats(root);
	return stats !== null
		&& stats.nodes <= TRUST_LIMITS.nodes
		&& stats.keys <= TRUST_LIMITS.keys
		&& stats.bytes <= TRUST_LIMITS.factBytes
		&& stats.depth <= TRUST_LIMITS.depth;
}

// The root, its world and inventory records and each fact domain are memoized: those are the subtrees later facts
// share by identity. Nodes inside a domain are counted in place rather than each kept in the WeakMap.
const FACT_STATS_MEMO_LEVELS = 2;

function interpreterFactStats(value, level = 0) {
	if (typeof value === 'string') {
		const bytes = Buffer.byteLength(value, 'utf8');
		return bytes > TRUST_LIMITS.stringBytes ? null : { nodes: 0, keys: 0, bytes, depth: -1 };
	}
	if (value === null || typeof value !== 'object') return EMPTY_FACT_STATS;
	const memo = level <= FACT_STATS_MEMO_LEVELS;
	const cached = memo ? FACT_STATS.get(value) : undefined;
	if (cached !== undefined) return cached;
	if (Array.isArray(value) && value.length > TRUST_LIMITS.arrayLength) return null;
	const array = Array.isArray(value);
	const keys = Object.keys(value);
	const stats = { nodes: 1, keys: keys.length, bytes: 0, depth: 0 };
	for (let index = 0; index < keys.length; index += 1) {
		const key = keys[index];
		const keyBytes = array
			? index < 10 ? 1 : index < 100 ? 2 : index < 1_000 ? 3 : String(index).length
			: Buffer.byteLength(key, 'utf8');
		if (keyBytes > TRUST_LIMITS.stringBytes) return null;
		const entry = value[key];
		// A primitive adds its bytes at depth -1 (a string) or nothing (anything else), as its own stats would.
		if (typeof entry === 'string') {
			const bytes = Buffer.byteLength(entry, 'utf8');
			if (bytes > TRUST_LIMITS.stringBytes) return null;
			stats.bytes += keyBytes + bytes;
			continue;
		}
		if (entry === null || typeof entry !== 'object') { stats.bytes += keyBytes; continue; }
		const child = interpreterFactStats(entry, level + 1);
		if (child === null) return null;
		stats.nodes += child.nodes;
		stats.keys += child.keys;
		stats.bytes += keyBytes + child.bytes;
		stats.depth = Math.max(stats.depth, child.depth + 1);
	}
	if (memo) FACT_STATS.set(value, stats);
	return stats;
}

/**
 * The exits the observation already reports (lava/fire exit text ending in "(x,y,z)", or cloud exit cells) as
 * movable cell centres, in reported order, retaining whether the report names an unsafe route. No terrain is searched.
 */
function reportedExitCells(exits) {
	if (!Array.isArray(exits)) return [];
	const cells = [];
	for (const exit of exits) {
		if (typeof exit === 'string') {
			const cell = /\((-?\d+),(-?\d+),(-?\d+)\)$/.exec(exit);
			if (cell === null) continue;
			const lava = /\s(\d+)lava\b/.exec(exit);
			cells.push({ x: Number(cell[1]) + 0.5, y: Number(cell[2]), z: Number(cell[3]) + 0.5,
				safe: lava === null && !/\b(?:\d+gap|unseen|unknown|landing)\b/.test(exit) });
		} else if (exit !== null && typeof exit === 'object' && [exit.x, exit.y, exit.z].every(Number.isFinite)) {
			cells.push({ x: exit.x + 0.5, y: exit.y, z: exit.z + 0.5, safe: true });
		}
	}
	return cells;
}

/** The reported nearest exit of the first cloud the body touches or is entering, or null. */
function reportedCloudExit(cloud) {
	const exit = cloud?.nearestExit;
	return exit !== null && typeof exit === 'object' && [exit.x, exit.y, exit.z].every(Number.isFinite)
		? { x: exit.x + 0.5, y: exit.y, z: exit.z + 0.5, route: cloud.exitRoute ?? "unverified" } : null;
}
