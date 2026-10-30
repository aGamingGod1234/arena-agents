import { normalizeMinecraftToolCall } from '../native-minecraft-tools.mjs';

// Predicate engine for decision-eval grading. Predicates read the tool calls a model made for one frozen moment.
// Nothing here executes a call; it only reads the call arguments and the case's raw observation.
//
// Contract: coordinator/src/decision-eval/schema.mjs (v1) fixes the predicate shapes; this file owns their evaluation.
// Keys marked [ext] are grade-side extensions not yet in schema v1 (validateCase rejects them until the schema adds them).
//
// Trajectory level (a sample's ordered calls):
//   { any: [p...] } | { all: [p...] } | { not: p }   combine trajectory predicates
//   { none: true }                                    the model made no tool call
//   [ext] { count: { min, max }, ...leaf }            number of calls matching the leaf keys
//   leaf keys with optional index                     some selected call matches every leaf key
// index: 0..n (that call), "first", "last", "any" (default); [ext] -1 (last), "every" (all calls, at least one).
//
// Call level (one canonical call), every present key must hold:
//   tool: name | [names]   model-facing tool name only (as in schema v1 and the runner's canned `when`); body action types
//                          are matched with normalized: { actionType } or [ext] action (act/startAction/sequence/moveTo/mine).
//   args: { path: matcher }        raw model arguments (dot paths; [ext] "*" matches any array element or object value)
//   normalized: { path: matcher }  production-normalized call (normalizeMinecraftToolCall), e.g. kind, actionType, arguments.x
//   awayFrom: { position: {x,y,z} | "player" | "threat", minDistance }   movement ends >= minDistance farther from position
//   targetsEntity: type | [types]  an action's targetId/targetSelector is an entity of that type: listed in the case
//                                  observation, else in earlier observations or the canned replies, else a type selector
//   usesItem: id | [ids]           the call uses, eats, selects (select_item or a control slot change), equips or places
//                                  that item ([ext] "food", { food, tag, regex })
//   [ext] action: type | [types] and actionArgs: { path: matcher } on one body action; movesAway, approaches, placesBlock,
//         breaksBlock, waits, noBodyAction, bodyAction (see the functions below)
//   [v1.3] firstAction / firstActionArgs: like action / actionArgs but only on the call's FIRST body action (a retry
//         with no repair step before it); escapesHazard, rises, freesSlot, discardsItem, clearsLineOfSight; the
//         movesAway / approaches specs accept maxFinalDistance (see the functions below)
//   [v1.4] collectsWithoutRoom: true   the call mines a block or picks up an item whose incoming item fits nowhere in
//         the observed inventory (see collectsWithoutRoom below)
//   any / all / not at call level combine call predicates.
// Matchers: literal (deep equality) | { eq } | { regex, flags } | { gte, gt, lte, lt } | { range: [min, max] }
//   | { in: [...] } | { exists: bool } | { contains: matcher } | { anyOf: [...] } | { allOf: [...] } | { not: matcher }.

const MCP_PREFIX = /^mcp__[^_]+(?:_[^_]+)*?__/;
const MOVE_ACTIONS = new Set(['move_to', 'navigate_to']);
const TARGET_KEYS = ['targetId', 'targetSelector'];
const ITEM_KEYS = ['expectedItemId', 'itemId'];
// Vanilla horizontal speeds in blocks per tick, used only to estimate where a raw control call ends up.
const WALK_PER_TICK = 4.317 / 20;
const SPRINT_PER_TICK = 5.612 / 20;
const SNEAK_PER_TICK = 1.31 / 20;
const NO_BODY_TOOLS = new Set(['observe', 'inspect', 'capabilities', 'survey', 'taskPlan', 'taskMemory', 'notebook', 'queryMemory',
	'actionStatus', 'programStatus', 'say', 'finish', 'lookAround', 'exploreFrontier']);
const CALL_KEYS = new Set(['tool', 'action', 'args', 'normalized', 'actionArgs', 'awayFrom', 'movesAway', 'approaches', 'targetsEntity', 'usesItem', 'placesBlock',
	'breaksBlock', 'waits', 'noBodyAction', 'bodyAction', 'any', 'all', 'not',
	'firstAction', 'firstActionArgs', 'escapesHazard', 'rises', 'freesSlot', 'discardsItem', 'clearsLineOfSight', 'collectsWithoutRoom']);
// Blocks that hurt on contact; escapesHazard defaults to these.
const DEFAULT_HAZARD_BLOCKS = 'lava|fire|magma_block|campfire|sweet_berry_bush|cactus|powder_snow';
// Player body box (vanilla standing hitbox) used to decide whether a destination still touches a hazard cell.
const BODY_HALF_WIDTH = 0.3;
const BODY_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
// Vanilla inventory menu: armor slots 5-8 are head, chest, legs, feet; 9-35 main; 36-44 hotbar; 45 offhand.
const INVENTORY_MENU_ARMOR = { 5: 'head', 6: 'chest', 7: 'legs', 8: 'feet' };
const MATCHER_KEYS = new Set(['eq', 'regex', 'flags', 'gte', 'gt', 'lte', 'lt', 'range', 'in', 'exists', 'contains', 'anyOf', 'allOf', 'not']);

export function stripToolPrefix(name) {
	return typeof name === 'string' ? name.replace(MCP_PREFIX, '') : name;
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function parseArgs(value) {
	if (typeof value !== 'string') return object(value) ? value : {};
	try { const parsed = JSON.parse(value); return object(parsed) ? parsed : {}; } catch { return {}; }
}

// Body actions from the production normalization, which also applies tool defaults (moveTo becomes navigate_to).
function normalizedActions(normalized) {
	if (!object(normalized)) return null;
	if (typeof normalized.actionType === 'string') return [{ actionType: normalized.actionType, arguments: object(normalized.arguments) ? normalized.arguments : {} }];
	if (normalized.kind === 'sequence' && Array.isArray(normalized.actions)) return normalized.actions.filter(a => object(a) && typeof a.actionType === 'string')
		.map(a => ({ actionType: a.actionType, arguments: object(a.arguments) ? a.arguments : {} }));
	return [];
}

export function normalizeCall(tool, args) {
	try { return { normalized: normalizeMinecraftToolCall(tool, args), error: null }; } catch (error) { return { normalized: null, error: String(error?.message ?? error) }; }
}

// Body actions a tool call would start, in order, read from the raw arguments. Used when production normalization rejects
// the call: an invalid call still shows what the model chose. Programs are opaque source and start no listed action.
export function bodyActions(tool, args) {
	switch (tool) {
		case 'act': case 'startAction': case 'replaceAction':
			return typeof args.actionType === 'string' ? [{ actionType: args.actionType, arguments: object(args.arguments) ? args.arguments : {} }] : [];
		case 'sequence':
			return Array.isArray(args.actions) ? args.actions.filter(object).filter(a => typeof a.actionType === 'string')
				.map(a => ({ actionType: a.actionType, arguments: object(a.arguments) ? a.arguments : {} })) : [];
		case 'moveTo': return [{ actionType: 'navigate_to', arguments: pick(args, ['x', 'y', 'z', 'tolerance', 'sprint', 'timeoutMs']) }];
		case 'mine': return [{ actionType: 'break_block', arguments: { ...pick(args, ['x', 'y', 'z', 'expectedBlockId', 'timeoutMs', 'acceptLavaRisk']) } }];
		case 'wait': return [{ actionType: 'wait', arguments: pick(args, ['durationMs']) }];
		case 'control': return [{ actionType: 'control', arguments: { ...args } }];
		default: return [];
	}
}

function pick(source, keys) {
	return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

// Accepts the shapes providers and recorders use: {tool|name, args|arguments|input}, string JSON arguments, MCP-prefixed names.
export function canonicalCall(raw, index = 0, step = 0) {
	const rawName = raw?.tool ?? raw?.name ?? raw?.toolName ?? '';
	const tool = stripToolPrefix(String(rawName));
	const args = parseArgs(raw?.args ?? raw?.arguments ?? raw?.input ?? raw?.params);
	// Recorded normalization wins so grading reads what the recording build saw; otherwise this build normalizes.
	const { normalized, error } = object(raw?.normalized) ? { normalized: raw.normalized, error: null } : normalizeCall(tool, args);
	const actions = normalizedActions(normalized) ?? bodyActions(tool, args);
	return { index: Number.isInteger(raw?.index) ? raw.index : index, step: Number.isInteger(raw?.step) ? raw.step : step, tool, rawName: String(rawName),
		args, normalized, normalizeError: raw?.normalizeError ?? error, canned: raw?.canned ?? null, actions };
}

export function canonicalCalls(calls) {
	return (Array.isArray(calls) ? calls : []).map((call, index) => canonicalCall(call, index, call?.step ?? 0));
}

// ---------- observation context ----------

export function observationPayload(observation) {
	if (!object(observation)) return {};
	if (object(observation.envelope?.payload)) return observation.envelope.payload;
	if (object(observation.payload) && (observation.payload.position || observation.payload.player)) return observation.payload;
	if (object(observation.observation) && (observation.observation.position || observation.observation.player)) return observation.observation;
	return observation;
}

export function buildContext(caseDef = {}) {
	const payload = observationPayload(caseDef?.state?.observation ?? caseDef?.observation);
	const entities = Array.isArray(payload.entities) ? payload.entities.filter(object) : [];
	const byId = new Map();
	for (const entity of entities) for (const id of [entity.uuid, entity.stableId, entity.id]) if (typeof id === 'string' || Number.isFinite(id)) byId.set(String(id), entity);
	const items = Array.isArray(payload.inventory?.items) ? payload.inventory.items.filter(object) : [];
	const blocks = [...(Array.isArray(payload.blocks) ? payload.blocks : []), ...(Array.isArray(payload.landmarks) ? payload.landmarks : [])]
		.filter(block => object(block) && typeof block.blockId === 'string' && ['x', 'y', 'z'].every(key => Number.isFinite(block[key])));
	const selectedSlot = Number.isInteger(payload.interaction?.input?.selectedSlot) ? payload.interaction.input.selectedSlot : null;
	return { payload, position: vec(payload.position), entities, entityById: byId, knownEntityById: knownEntities(caseDef, byId), items,
		selectedItem: payload.inventory?.selectedItem ?? null, blocks, selectedSlot, menu: object(payload.interaction?.menu) ? payload.interaction.menu : null };
}

const ENTITY_MENTION = /\b((?:[a-z0-9_.-]+:)?[a-z0-9_]+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;

// Ids the model can name without the entity being in the case observation's list: entities of earlier observations and
// entities in the canned replies it was shown (as objects, or as "minecraft:magma_cube <uuid>" in result text). The case
// observation wins, then the canned replies, then the newest earlier observation.
function knownEntities(caseDef, current) {
	const known = new Map(current);
	const add = (id, entity) => { if ((typeof id === 'string' || Number.isFinite(id)) && !known.has(String(id))) known.set(String(id), entity); };
	const visit = (value, depth = 0) => {
		if (depth > 12 || value === null || value === undefined) return;
		if (typeof value === 'string') { for (const [, type, id] of value.matchAll(ENTITY_MENTION)) add(id, { type: normalizeId(type), uuid: id }); return; }
		if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
		if (!object(value)) return;
		if (typeof value.type === 'string' && (value.uuid !== undefined || value.stableId !== undefined)) for (const id of [value.uuid, value.stableId]) add(id, value);
		for (const child of Object.values(value)) visit(child, depth + 1);
	};
	for (const step of caseDef?.steps ?? []) for (const choice of step?.canned ?? []) visit(choice?.result);
	const state = caseDef?.state ?? {};
	const previous = Array.isArray(state.previousObservations) ? state.previousObservations : object(state.previousObservation) ? [state.previousObservation] : [];
	for (const observation of [...previous].reverse()) {
		for (const entity of observationPayload(observation).entities ?? []) if (object(entity)) for (const id of [entity.uuid, entity.stableId]) add(id, entity);
	}
	return known;
}

// A target the observation does not list: an id seen elsewhere in the case, or a selector that is itself an entity type.
function targetEntity(target, context) {
	const key = String(target);
	const known = context.entityById.get(key) ?? context.knownEntityById?.get(key);
	if (known) return known;
	return typeof target === 'string' && /^(?:[a-z0-9_.-]+:)?[a-z_][a-z0-9_]*$/.test(target) ? { type: normalizeId(target) } : undefined;
}

function vec(value) {
	return object(value) && ['x', 'y', 'z'].every(key => Number.isFinite(value[key])) ? { x: value.x, y: value.y, z: value.z } : null;
}

function distance(a, b, horizontal = false) {
	if (!a || !b) return null;
	return Math.hypot(a.x - b.x, horizontal ? 0 : a.y - b.y, a.z - b.z);
}

function normalizeId(id) {
	return typeof id === 'string' && id && !id.startsWith('#') && !id.includes(':') ? `minecraft:${id}` : id;
}

// Resolves a helper reference point: {x,y,z}, {entityType}, {entityId}, or "nearestHostile".
function resolvePoint(ref, context) {
	if (vec(ref)) return { point: vec(ref), entity: null };
	if (ref === 'player') return { point: context.position, entity: null, player: true };
	const candidates = (filter) => context.entities.filter(filter).filter(e => vec(e.position))
		.sort((a, b) => (a.distance ?? distance(vec(a.position), context.position) ?? Infinity) - (b.distance ?? distance(vec(b.position), context.position) ?? Infinity));
	let entity = null;
	if (ref === 'nearestHostile' || ref?.nearestHostile) entity = candidates(e => e.hostile === true)[0] ?? null;
	else if (object(ref) && ref.entityId !== undefined) entity = context.entityById.get(String(ref.entityId)) ?? null;
	else if (object(ref) && ref.entityType !== undefined) {
		const types = new Set([ref.entityType].flat().map(normalizeId));
		entity = candidates(e => types.has(e.type))[0] ?? null;
	}
	return entity ? { point: vec(entity.position), entity } : { point: null, entity: null };
}

// Where the body is estimated to end up after this call, or null when the call does not move it predictably.
export function estimatedDestination(call, context) {
	let at = context.position;
	let moved = false;
	for (const action of call.actions) {
		const args = action.arguments;
		if (MOVE_ACTIONS.has(action.actionType) && vec(args)) { at = vec(args); moved = true; }
		else if (action.actionType === 'control' && at) { at = controlEnd(at, args); moved = true; }
		else if (action.actionType === 'control_sequence' && at && Array.isArray(args.frames)) {
			for (const frame of args.frames) if (object(frame)) at = controlEnd(at, frame);
			moved = true;
		}
	}
	return moved ? at : null;
}

function controlEnd(at, frame) {
	const forward = Number.isFinite(frame.forward) ? frame.forward : 0;
	const strafe = Number.isFinite(frame.strafe) ? frame.strafe : 0;
	const ticks = Number.isFinite(frame.ticks) ? frame.ticks : 1;
	if (!Number.isFinite(frame.yaw) || (forward === 0 && strafe === 0)) return at;
	const speed = frame.sneak ? SNEAK_PER_TICK : frame.sprint && forward > 0 ? SPRINT_PER_TICK : WALK_PER_TICK;
	const yaw = frame.yaw * Math.PI / 180;
	// Minecraft yaw 0 faces +z and 90 faces -x; strafe positive moves to the player's left.
	const dx = (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed * ticks;
	const dz = (Math.cos(yaw) * forward + Math.sin(yaw) * strafe) * speed * ticks;
	return { x: at.x + dx, y: at.y, z: at.z + dz };
}

function entityTypeMatches(entity, spec) {
	if (!entity) return false;
	if (typeof spec === 'string' || Array.isArray(spec)) return [spec].flat().map(normalizeId).includes(entity.type);
	if (object(spec)) {
		if (spec.type !== undefined && ![spec.type].flat().map(normalizeId).includes(entity.type)) return false;
		if (spec.hostile !== undefined && entity.hostile !== spec.hostile) return false;
		return true;
	}
	return spec === true;
}

function itemMatches(itemId, spec, context) {
	if (typeof itemId !== 'string') return false;
	if (typeof spec === 'string' && spec === 'food') return isFood(itemId, context);
	if (typeof spec === 'string' || Array.isArray(spec)) return [spec].flat().map(normalizeId).includes(itemId);
	if (object(spec)) {
		if (spec.food === true && !isFood(itemId, context)) return false;
		if (spec.tag !== undefined && !context.items.some(item => item.itemId === itemId && item.tags?.includes(spec.tag))) return false;
		if (spec.regex !== undefined && !new RegExp(spec.regex, spec.flags ?? '').test(itemId)) return false;
		if (spec.in !== undefined && !spec.in.map(normalizeId).includes(itemId)) return false;
		return true;
	}
	return false;
}

const FOOD_FALLBACK = /(?:apple|bread|beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato|carrot|melon_slice|cookie|pie|stew|soup|berries|kelp|beetroot|honey_bottle|chorus_fruit)$/;
function isFood(itemId, context) {
	const held = context.items.find(item => item.itemId === itemId);
	if (held?.tags?.some(tag => /^#c:foods(?:\/|$)/.test(tag))) return true;
	if (held && (Number.isFinite(held.nutrition) || object(held.food))) return true;
	return FOOD_FALLBACK.test(itemId) && !/^minecraft:(?:rotten_flesh|spider_eye|poisonous_potato|pufferfish)$/.test(itemId);
}

function hotbarItem(slot, context) {
	return context.items.find(item => item.hotbar === true && item.slot === slot)?.itemId ?? null;
}

// Items a call uses: explicit ids, or the held item for an unqualified use_item. Selecting an item (select_item, or a
// control frame's selectedSlot, the vanilla hotbar key) counts too: a player eats by selecting food, then holding use.
function itemsUsed(call, context, { placingOnly = false } = {}) {
	const used = [];
	let held = context.selectedItem;
	for (const action of call.actions) {
		const args = action.arguments;
		if (action.actionType === 'select_item' && typeof args.itemId === 'string') { held = args.itemId; if (!placingOnly) used.push(args.itemId); continue; }
		if (action.actionType === 'control' || action.actionType === 'control_sequence') {
			const frames = action.actionType === 'control' ? [args] : Array.isArray(args.frames) ? args.frames.filter(object) : [];
			// Control frames usually repeat the current slot, so only a slot change or holding use counts.
			for (const frame of frames) {
				const slotItem = Number.isInteger(frame.selectedSlot) ? hotbarItem(frame.selectedSlot, context) : null;
				const switched = slotItem !== null && slotItem !== held;
				if (slotItem !== null) held = slotItem;
				if (!placingOnly && (switched || frame.use === true) && typeof held === 'string') used.push(held);
			}
			continue;
		}
		if (placingOnly) { if (action.actionType === 'place_block' && typeof args.itemId === 'string') used.push(args.itemId); continue; }
		if (action.actionType === 'use_item') used.push(typeof args.expectedItemId === 'string' ? args.expectedItemId : held);
		else for (const key of ITEM_KEYS) if (typeof args[key] === 'string') used.push(args[key]);
	}
	return used.filter(id => typeof id === 'string');
}

// ---------- matchers ----------

function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keysA = Object.keys(a), keysB = Object.keys(b);
	return keysA.length === keysB.length && keysA.every(key => deepEqual(a[key], b[key]));
}

function isMatcherObject(value) {
	return object(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => MATCHER_KEYS.has(key));
}

export function matchValue(matcher, value) {
	if (!isMatcherObject(matcher)) return deepEqual(matcher, value);
	if (matcher.exists !== undefined && (value !== undefined) !== matcher.exists) return false;
	if (matcher.eq !== undefined && !deepEqual(matcher.eq, value)) return false;
	if (matcher.regex !== undefined && !(typeof value === 'string' && new RegExp(matcher.regex, matcher.flags ?? '').test(value))) return false;
	for (const [key, test] of [['gte', (v, m) => v >= m], ['gt', (v, m) => v > m], ['lte', (v, m) => v <= m], ['lt', (v, m) => v < m]]) {
		if (matcher[key] !== undefined && !(Number.isFinite(value) && test(value, matcher[key]))) return false;
	}
	if (matcher.range !== undefined) {
		const [min = -Infinity, max = Infinity] = matcher.range.map(v => v ?? undefined);
		if (!(Number.isFinite(value) && value >= min && value <= max)) return false;
	}
	if (matcher.in !== undefined && !matcher.in.some(entry => deepEqual(entry, value))) return false;
	if (matcher.contains !== undefined) {
		if (Array.isArray(value)) { if (!value.some(entry => matchValue(matcher.contains, entry))) return false; }
		else if (typeof value === 'string') { if (typeof matcher.contains !== 'string' || !value.includes(matcher.contains)) return false; }
		else return false;
	}
	if (matcher.anyOf !== undefined && !matcher.anyOf.some(m => matchValue(m, value))) return false;
	if (matcher.allOf !== undefined && !matcher.allOf.every(m => matchValue(m, value))) return false;
	if (matcher.not !== undefined && matchValue(matcher.not, value)) return false;
	return true;
}

// Every value at a dot path; "*" fans out over array elements or object values.
export function valuesAtPath(root, path) {
	let current = [root];
	for (const part of String(path).split('.').filter(Boolean)) {
		const next = [];
		for (const value of current) {
			if (value === null || typeof value !== 'object') continue;
			if (part === '*') next.push(...(Array.isArray(value) ? value : Object.values(value)));
			else if (Object.hasOwn(value, part)) next.push(value[part]);
		}
		current = next;
	}
	return current;
}

function matchPaths(spec, root) {
	return Object.entries(spec).every(([path, matcher]) => {
		const values = valuesAtPath(root, path);
		if (values.length === 0) return matchValue(matcher, undefined);
		return values.some(value => matchValue(matcher, value));
	});
}

// ---------- call level ----------

function asList(value) { return [value].flat(); }

export function matchCall(predicate, call, context) {
	if (!object(predicate)) throw new TypeError('predicate must be an object');
	for (const key of Object.keys(predicate)) if (!CALL_KEYS.has(key) && key !== 'index' && key !== 'count') throw new TypeError(`unknown predicate key ${key}`);
	if (predicate.tool !== undefined) {
		const names = asList(predicate.tool).map(stripToolPrefix);
		if (!names.includes(call.tool)) return false;
	}
	if (predicate.args !== undefined && !matchPaths(predicate.args, call.args)) return false;
	if (predicate.normalized !== undefined && !matchPaths(predicate.normalized, call.normalized ?? {})) return false;
	if (predicate.awayFrom !== undefined && !movesAway(call, context, { from: awayReference(predicate.awayFrom.position), minDistance: predicate.awayFrom.minDistance ?? 1 })) return false;
	if (predicate.action !== undefined || predicate.actionArgs !== undefined) {
		const types = predicate.action === undefined ? null : asList(predicate.action);
		if (!call.actions.some(action => (!types || types.includes(action.actionType))
			&& (predicate.actionArgs === undefined || matchPaths(predicate.actionArgs, action.arguments)))) return false;
	}
	if (predicate.firstAction !== undefined || predicate.firstActionArgs !== undefined) {
		const first = call.actions[0];
		if (!first) return false;
		if (predicate.firstAction !== undefined && !asList(predicate.firstAction).includes(first.actionType)) return false;
		if (predicate.firstActionArgs !== undefined && !matchPaths(predicate.firstActionArgs, first.arguments)) return false;
	}
	if (predicate.escapesHazard !== undefined && !escapesHazard(call, context, predicate.escapesHazard)) return false;
	if (predicate.rises !== undefined && !rises(call, context, predicate.rises)) return false;
	if (predicate.freesSlot !== undefined && !removedStacks(call, context).some(stack => stack.whole && itemMatches(stack.itemId, predicate.freesSlot, context))) return false;
	if (predicate.discardsItem !== undefined && !removedStacks(call, context).some(stack => stack.kind === 'drop' && itemMatches(stack.itemId, predicate.discardsItem, context))) return false;
	if (predicate.clearsLineOfSight !== undefined && !clearsLineOfSight(call, context, predicate.clearsLineOfSight)) return false;
	if (predicate.collectsWithoutRoom !== undefined && collectsWithoutRoom(call, context) !== Boolean(predicate.collectsWithoutRoom)) return false;
	if (predicate.movesAway !== undefined && !movesAway(call, context, predicate.movesAway)) return false;
	if (predicate.approaches !== undefined && !approaches(call, context, predicate.approaches)) return false;
	if (predicate.targetsEntity !== undefined && !call.actions.some(action => TARGET_KEYS.some(key =>
		action.arguments[key] !== undefined && entityTypeMatches(targetEntity(action.arguments[key], context), predicate.targetsEntity)))) return false;
	if (predicate.usesItem !== undefined && !itemsUsed(call, context).some(id => itemMatches(id, predicate.usesItem, context))) return false;
	if (predicate.placesBlock !== undefined && !itemsUsed(call, context, { placingOnly: true }).some(id => itemMatches(id, predicate.placesBlock, context))) return false;
	if (predicate.breaksBlock !== undefined && !call.actions.some(action => action.actionType === 'break_block'
		&& itemMatches(action.arguments.expectedBlockId, predicate.breaksBlock, context))) return false;
	if (predicate.waits !== undefined && isWait(call) !== Boolean(predicate.waits)) return false;
	if (predicate.noBodyAction !== undefined && !hasBodyEffect(call) !== Boolean(predicate.noBodyAction)) return false;
	if (predicate.bodyAction !== undefined && hasBodyEffect(call) !== Boolean(predicate.bodyAction)) return false;
	if (predicate.any !== undefined && !predicate.any.some(p => matchCall(p, call, context))) return false;
	if (predicate.all !== undefined && !predicate.all.every(p => matchCall(p, call, context))) return false;
	if (predicate.not !== undefined && matchCall(predicate.not, call, context)) return false;
	return true;
}

function isWait(call) {
	return call.actions.length > 0 && call.actions.every(action => action.actionType === 'wait');
}

// A call that changes nothing in the world: reads, notes, plans, chat, waits and pure looking.
export function hasBodyEffect(call) {
	if (NO_BODY_TOOLS.has(call.tool)) return false;
	if (['runProgram', 'queueProgram', 'respondProgram', 'cancelProgram', 'cancelAction', 'takeTask', 'cancelQueuedProgram'].includes(call.tool)) return true;
	if (call.actions.length === 0) return false;
	return call.actions.some(action => {
		if (action.actionType === 'wait' || action.actionType === 'chat' || action.actionType === 'look_at') return false;
		if (action.actionType === 'control') {
			const a = action.arguments;
			return Boolean(a.forward || a.strafe || a.jump || a.attack || a.use || a.sneak);
		}
		return true;
	});
}

// Schema awayFrom positions: "player" is where the player stands now, "threat" the nearest hostile entity.
function awayReference(position) {
	if (position === 'player') return 'player';
	if (position === 'threat') return 'nearestHostile';
	return position;
}

// movesAway: { from: point|{entityType}|{entityId}|"nearestHostile", minDistance = 1, minFinalDistance? }
// Distance gained between the reference and the estimated end position. flee_from from the reference entity gains its distance argument.
export function distanceGain(call, context, from) {
	const { point, entity, player } = resolvePoint(from, context);
	if (!point) return null;
	const start = distance(context.position, point);
	let best = null;
	for (const action of call.actions) {
		if (action.actionType !== 'flee_from' || !Number.isFinite(action.arguments.distance)) continue;
		const target = context.entityById.get(String(action.arguments.targetId));
		// Relative to the player's own spot, fleeing covers roughly the separation it still has to add.
		if (player) { if (target) best = Math.max(best ?? -Infinity, action.arguments.distance - (distance(vec(target.position), point) ?? 0)); continue; }
		const sameThreat = target && (target === entity || (entity === null && distance(vec(target.position), point) <= 3)
			|| (entity && target.type === entity.type && distance(vec(target.position), point) <= 6));
		if (sameThreat && start !== null) best = Math.max(best ?? -Infinity, action.arguments.distance - start);
	}
	const end = estimatedDestination(call, context);
	if (end && start !== null) best = Math.max(best ?? -Infinity, distance(end, point) - start);
	return best;
}

function finalDistance(call, context, ref, gain) {
	const { point } = resolvePoint(ref, context);
	const end = estimatedDestination(call, context);
	return end ? distance(end, point) : distance(context.position, point) + gain;
}

function movesAway(call, context, spec) {
	const from = spec?.from ?? spec;
	const gain = distanceGain(call, context, from);
	if (gain === null) return false;
	if (gain < (spec?.minDistance ?? 1)) return false;
	if (spec?.minFinalDistance !== undefined && finalDistance(call, context, from, gain) < spec.minFinalDistance) return false;
	if (spec?.maxFinalDistance !== undefined && finalDistance(call, context, from, gain) > spec.maxFinalDistance) return false;
	return true;
}

// approaches: { to, minDistance = 1, maxFinalDistance? } e.g. ends within reach of a block it could not reach before.
function approaches(call, context, spec) {
	const to = spec?.to ?? spec;
	const gain = distanceGain(call, context, to);
	if (gain === null || -gain < (spec?.minDistance ?? 1)) return false;
	return spec?.maxFinalDistance === undefined || finalDistance(call, context, to, gain) <= spec.maxFinalDistance;
}

// ---------- v1.3 helpers ----------

function hazardCells(context, pattern) {
	const re = new RegExp(pattern ?? DEFAULT_HAZARD_BLOCKS);
	return context.blocks.filter(block => re.test(block.blockId));
}

// The standing body box at `at` overlaps the block cell (feet slightly below so standing on magma counts).
function bodyTouches(at, cell) {
	const overlap = (min, max, cellMin) => max > cellMin && min < cellMin + 1;
	return overlap(at.x - BODY_HALF_WIDTH, at.x + BODY_HALF_WIDTH, cell.x) && overlap(at.z - BODY_HALF_WIDTH, at.z + BODY_HALF_WIDTH, cell.z)
		&& overlap(at.y - 0.05, at.y + BODY_HEIGHT, cell.y);
}

function nearestCellDistance(at, cells) {
	return Math.min(...cells.map(cell => distance(at, { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 })));
}

// escapesHazard: { blocks?: regex, minMove = 0.5 }. The call moves the body at least minMove, its estimated end
// position touches none of the hazard blocks the case observation lists, and it ends no closer to the nearest one.
// A zero-motion control or a moveTo of the current spot never escapes. Unlisted blocks are unknown, not safe.
export function escapesHazard(call, context, spec = {}) {
	const start = context.position;
	const end = estimatedDestination(call, context);
	if (!start || !end || distance(end, start) < (spec.minMove ?? 0.5)) return false;
	const cells = hazardCells(context, spec.blocks);
	if (cells.some(cell => bodyTouches(end, cell))) return false;
	return cells.length === 0 || nearestCellDistance(end, cells) >= nearestCellDistance(start, cells);
}

// rises: { minDy = 1, minTicks = 10 }. Upward progress toward air: a move whose destination is at least minDy higher,
// or control frames that hold jump (swim up) or swim forward pitched up (pitch <= -30) for at least minTicks ticks.
export function rises(call, context, spec = {}) {
	const minDy = spec.minDy ?? 1;
	const minTicks = spec.minTicks ?? 10;
	const y = context.position?.y;
	let ticks = 0;
	for (const action of call.actions) {
		const args = action.arguments;
		if (MOVE_ACTIONS.has(action.actionType) && Number.isFinite(args.y) && Number.isFinite(y) && args.y - y >= minDy) return true;
		const frames = action.actionType === 'control' ? [args] : action.actionType === 'control_sequence' && Array.isArray(args.frames) ? args.frames.filter(object) : [];
		for (const frame of frames) {
			const up = frame.jump === true || ((frame.forward ?? 0) > 0 && Number.isFinite(frame.pitch) && frame.pitch <= -30);
			if (up) ticks += Number.isFinite(frame.ticks) ? frame.ticks : 1;
		}
	}
	return ticks >= minTicks;
}

// The stack an inventory slot (0..35) holds; the selected hotbar slot is recorded as the "mainhand" entry.
function inventoryStack(context, slot) {
	if (!Number.isInteger(slot)) return null;
	const listed = context.items.find(item => item.slot === slot);
	if (listed) return listed;
	return slot === context.selectedSlot ? context.items.find(item => item.slot === 'mainhand') ?? null : null;
}

// The player stack behind a menu slot: the inventory menu maps 5-8 armor, 9-35 main, 36-44 hotbar, 45 offhand; a
// container menu lists its own slots first, then the 27 main and 9 hotbar player slots.
function menuStack(context, menuSlot) {
	const menu = context.menu;
	if (!menu || !Number.isInteger(menuSlot)) return { stack: null, container: false };
	if (menu.type === 'minecraft:inventory' || menu.containerId === 0) {
		if (INVENTORY_MENU_ARMOR[menuSlot]) return { stack: context.items.find(item => item.slot === INVENTORY_MENU_ARMOR[menuSlot]) ?? null, container: false };
		if (menuSlot >= 9 && menuSlot <= 35) return { stack: inventoryStack(context, menuSlot), container: false };
		if (menuSlot >= 36 && menuSlot <= 44) return { stack: inventoryStack(context, menuSlot - 36), container: false };
		if (menuSlot === 45) return { stack: context.items.find(item => item.slot === 'offhand') ?? null, container: false };
		return { stack: null, container: false };
	}
	const size = Number.isInteger(menu.slotCount) ? menu.slotCount - 36 : null;
	if (size === null || menuSlot < size) return { stack: null, container: true, playerSlot: false };
	const index = menuSlot - size;
	return { stack: inventoryStack(context, index < 27 ? index + 9 : index - 27), container: true, playerSlot: true };
}

// Stacks a call drops or stores away from the player inventory: [{ itemId, whole, kind: 'drop' | 'store' }]. `whole`
// means the slot ends empty (the count covers the stack, a THROW with button 1, or a QUICK_MOVE into an open container).
export function removedStacks(call, context) {
	const out = [];
	for (const action of call.actions) {
		const args = action.arguments;
		if (action.actionType === 'drop_item') {
			const stack = inventoryStack(context, args.slot);
			if (stack) out.push({ itemId: stack.itemId, whole: Number.isFinite(args.count) && args.count >= stack.count, kind: 'drop' });
		} else if (action.actionType === 'menu_click') {
			const { stack, container, playerSlot } = menuStack(context, args.slot);
			const itemId = stack?.itemId ?? (typeof args.expectedItemId === 'string' ? args.expectedItemId : null);
			if (!itemId || itemId === 'minecraft:air') continue;
			if (args.clickType === 'THROW') out.push({ itemId, whole: args.button === 1 || stack?.count === 1, kind: 'drop' });
			else if (args.clickType === 'QUICK_MOVE' && container && playerSlot) out.push({ itemId, whole: true, kind: 'store' });
		} else if (action.actionType === 'transfer_container' && args.sourceKind === 'player') {
			const stack = inventoryStack(context, args.sourceSlot);
			const itemId = stack?.itemId ?? args.expectedItemId;
			if (typeof itemId === 'string') out.push({ itemId, whole: Boolean(stack) && Number.isFinite(args.count) && args.count >= stack.count, kind: 'store' });
		} else if (action.actionType === 'menu_transfer') {
			const { stack, container, playerSlot } = menuStack(context, args.sourceSlot);
			if (stack && container && playerSlot) out.push({ itemId: stack.itemId, whole: Number.isFinite(args.count) && args.count >= stack.count, kind: 'store' });
		}
	}
	return out;
}

// clearsLineOfSight: {x,y,z} of a block the player could not see. Holds when the call breaks a different block that lies
// between the player's eye and that block (within 0.9 of the sight line), the obstruction a player would dig out.
export function clearsLineOfSight(call, context, target) {
	const at = context.position;
	const to = vec(target);
	if (!at || !to) return false;
	const eye = { x: at.x, y: at.y + EYE_HEIGHT, z: at.z };
	const end = { x: Math.floor(to.x) + 0.5, y: Math.floor(to.y) + 0.5, z: Math.floor(to.z) + 0.5 };
	const line = { x: end.x - eye.x, y: end.y - eye.y, z: end.z - eye.z };
	const lengthSquared = line.x ** 2 + line.y ** 2 + line.z ** 2;
	if (lengthSquared === 0) return false;
	return call.actions.some(action => {
		const b = action.arguments;
		if (action.actionType !== 'break_block' || !vec(b)) return false;
		if (Math.floor(b.x) === Math.floor(to.x) && Math.floor(b.y) === Math.floor(to.y) && Math.floor(b.z) === Math.floor(to.z)) return false;
		const c = { x: Math.floor(b.x) + 0.5, y: Math.floor(b.y) + 0.5, z: Math.floor(b.z) + 0.5 };
		const s = ((c.x - eye.x) * line.x + (c.y - eye.y) * line.y + (c.z - eye.z) * line.z) / lengthSquared;
		if (s <= 0 || s >= 1) return false;
		return distance(c, { x: eye.x + s * line.x, y: eye.y + s * line.y, z: eye.z + s * line.z }) <= 0.9;
	});
}

// ---------- v1.4 helpers ----------

// The one item a mined block adds to the inventory in vanilla survival without enchantments. Explicit on purpose: a
// block whose drop varies or is not listed (leaves, gravel, short grass, clay) is unknown, so a capacity check never
// calls mining it wrong.
const BLOCK_DROPS = [
	[/^minecraft:(stone|cobblestone)$/, () => 'minecraft:cobblestone'],
	[/^minecraft:(deepslate|cobbled_deepslate)$/, () => 'minecraft:cobbled_deepslate'],
	[/^minecraft:(grass_block|dirt|podzol|mycelium|dirt_path|farmland)$/, () => 'minecraft:dirt'],
	[/^minecraft:(deepslate_)?coal_ore$/, () => 'minecraft:coal'],
	[/^minecraft:(deepslate_)?iron_ore$/, () => 'minecraft:raw_iron'],
	[/^minecraft:(deepslate_)?copper_ore$/, () => 'minecraft:raw_copper'],
	[/^minecraft:(deepslate_)?gold_ore$/, () => 'minecraft:raw_gold'],
	[/^minecraft:(deepslate_)?diamond_ore$/, () => 'minecraft:diamond'],
	[/^minecraft:(deepslate_)?emerald_ore$/, () => 'minecraft:emerald'],
	[/^minecraft:(deepslate_)?redstone_ore$/, () => 'minecraft:redstone'],
	[/^minecraft:(deepslate_)?lapis_ore$/, () => 'minecraft:lapis_lazuli'],
	[/^minecraft:nether_quartz_ore$/, () => 'minecraft:quartz'],
	[/^minecraft:[a-z_]+_(log|wood|stem|hyphae|planks)$/, (id) => id],
	[/^minecraft:(andesite|diorite|granite|tuff|calcite|sand|red_sand|netherrack|blackstone|basalt|soul_sand|soul_soil|crafting_table|furnace|chest|coarse_dirt|rooted_dirt)$/, (id) => id],
];

export function blockDrop(blockId) {
	const id = normalizeId(blockId);
	if (typeof id !== 'string') return null;
	const rule = BLOCK_DROPS.find(([re]) => re.test(id));
	return rule ? rule[1](id) : null;
}

// Whether `itemId` can enter the inventory: an empty main slot (0..35, the selected hotbar slot is the "mainhand"
// entry) or a stack of the same item with room, in the main inventory or the offhand (vanilla merges there too).
export function inventoryHasRoom(context, itemId, freedSlots = 0) {
	if (freedSlots > 0) return true;
	const stacks = context.items.filter(item => typeof item.itemId === 'string' && item.itemId !== 'minecraft:air' && (item.count ?? 1) > 0);
	const main = new Set();
	for (const item of stacks) {
		if (Number.isInteger(item.slot) && item.slot >= 0 && item.slot <= 35) main.add(item.slot);
		else if (item.slot === 'mainhand') main.add(Number.isInteger(context.selectedSlot) ? context.selectedSlot : 'mainhand');
	}
	if (main.size < 36) return true;
	return stacks.some(item => item.itemId === itemId && (Number.isInteger(item.slot) || item.slot === 'mainhand' || item.slot === 'offhand')
		&& (item.count ?? 1) < (Number.isInteger(item.maxStackSize) ? item.maxStackSize : 64));
}

function blockAt(context, at) {
	const c = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
	return context.blocks.find(block => block.x === c.x && block.y === c.y && block.z === c.z)?.blockId ?? null;
}

// collectsWithoutRoom: the call mines a block (its expectedBlockId, else the block the observation lists at that cell)
// or picks up an item entity whose incoming item fits nowhere: no empty main slot and no stack of that item with room.
// A whole stack the same call drops or stores BEFORE that action frees a slot. Unknown drops and unknown item entities
// never match, so this only decides when the observation proves the item is lost.
export function collectsWithoutRoom(call, context) {
	let freed = 0;
	for (const action of call.actions) {
		const args = action.arguments;
		if (action.actionType === 'break_block' && vec(args)) {
			const drop = blockDrop(typeof args.expectedBlockId === 'string' && !args.expectedBlockId.startsWith('#') ? args.expectedBlockId : blockAt(context, args));
			if (drop && !inventoryHasRoom(context, drop, freed)) return true;
		} else if (action.actionType === 'pick_up_item' && args.targetSelector !== undefined) {
			const entity = context.entityById.get(String(args.targetSelector)) ?? context.knownEntityById?.get(String(args.targetSelector));
			const itemId = typeof entity?.itemId === 'string' ? entity.itemId : typeof entity?.item?.itemId === 'string' ? entity.item.itemId : null;
			if (itemId && !inventoryHasRoom(context, itemId, freed)) return true;
		}
		freed += removedStacks({ actions: [action] }, context).filter(stack => stack.whole).length;
	}
	return false;
}

// ---------- trajectory level ----------

function selectCalls(calls, index) {
	if (index === undefined || index === 'any' || index === 'every') return calls;
	if (index === 'first') return calls.slice(0, 1);
	if (index === 'last') return calls.slice(-1);
	if (Number.isInteger(index)) { const call = index < 0 ? calls[calls.length + index] : calls[index]; return call ? [call] : []; }
	throw new TypeError(`unsupported predicate index ${index}`);
}

function leafKeys(predicate) {
	return Object.keys(predicate).filter(key => !['any', 'all', 'not', 'none', 'index', 'count'].includes(key));
}

export function evaluatePredicate(predicate, calls, context) {
	if (!object(predicate)) throw new TypeError('predicate must be an object');
	if (predicate.none !== undefined) {
		const rest = Object.keys(predicate).filter(key => key !== 'none');
		if (rest.length) throw new TypeError('none cannot be combined with other predicate keys');
		return (calls.length === 0) === Boolean(predicate.none);
	}
	const callLevel = leafKeys(predicate).length > 0 || predicate.index !== undefined || predicate.count !== undefined;
	if (!callLevel) {
		if (predicate.any !== undefined && !predicate.any.some(p => evaluatePredicate(p, calls, context))) return false;
		if (predicate.all !== undefined && !predicate.all.every(p => evaluatePredicate(p, calls, context))) return false;
		if (predicate.not !== undefined && evaluatePredicate(predicate.not, calls, context)) return false;
		return true;
	}
	const { index, count, ...callPredicate } = predicate;
	const selected = selectCalls(calls, index);
	if (count !== undefined) {
		const n = selected.filter(call => matchCall(callPredicate, call, context)).length;
		return n >= (count.min ?? 0) && n <= (count.max ?? Infinity);
	}
	if (index === 'every') return selected.length > 0 && selected.every(call => matchCall(callPredicate, call, context));
	return selected.some(call => matchCall(callPredicate, call, context));
}

// Validates a predicate tree up front so a typo in a case file fails loudly instead of grading everything neutral.
export function validatePredicate(predicate, where = 'predicate') {
	const errors = [];
	const visit = (p, at, level) => {
		if (!object(p)) { errors.push(`${at} must be an object`); return; }
		for (const key of Object.keys(p)) if (!CALL_KEYS.has(key) && !['index', 'count', 'none'].includes(key)) errors.push(`${at}.${key} is not a predicate key`);
		for (const key of ['any', 'all']) if (p[key] !== undefined) {
			if (!Array.isArray(p[key]) || p[key].length === 0) errors.push(`${at}.${key} must be a nonempty array`);
			else p[key].forEach((child, i) => visit(child, `${at}.${key}[${i}]`, level));
		}
		if (p.not !== undefined) visit(p.not, `${at}.not`, level);
		if (p.regex !== undefined) errors.push(`${at}.regex belongs inside an args matcher`);
		for (const key of ['args', 'actionArgs', 'firstActionArgs']) if (p[key] !== undefined && !object(p[key])) errors.push(`${at}.${key} must map paths to matchers`);
		if (object(p.args) || object(p.actionArgs)) for (const matcher of [...Object.values(p.args ?? {}), ...Object.values(p.actionArgs ?? {})]) {
			if (isMatcherObject(matcher) && matcher.regex !== undefined) try { new RegExp(matcher.regex, matcher.flags ?? ''); } catch (error) { errors.push(`${at} regex: ${error.message}`); }
		}
	};
	visit(predicate, where, 0);
	return errors;
}
