/**
 * Decision-eval shared contract (owner: core agent, branch claude/q8-de-core).
 *
 * A decision-eval case freezes one moment of a recorded game as RAW, build-independent state. Each build renders
 * that state through its own production builders into the exact model input, sends it to the play model, captures
 * the tool calls it makes WITHOUT executing them, and grades them. Nothing here stores pre-rendered prompt text.
 *
 * Stability: schemaVersion 1. Later changes must be additive (new optional fields, new matcher or helper keys) and
 * listed in the changelog below. Consumers must ignore unknown optional fields.
 *
 * Changelog
 * - v1 (2026-10-11): initial contract.
 * - v1.1 (2026-10-11, additive): state.agent.name and state.agent.lastSummary (optional); state.wake.trigger is the
 *   expected trigger, compared with the rendered one (renders report triggerMismatch, they never force a trigger);
 *   dangerSummary and conversation are not replayable yet (a case with unread conversation fails to render with
 *   RENDER_UNSUPPORTED). The sample result gains rendered.encodedSha256 (encoded wake with the per-session view id
 *   canonicalised) and rendered.sentSha256 / rendered.sentMatches (the user message actually written to the provider).
 * - v1.2 (2026-10-11, additive): predicates accept the grade engine's extension keys (action, actionArgs, movesAway,
 *   approaches, placesBlock, breaksBlock, waits, noBodyAction, bodyAction, count), negative and "every" indexes, item
 *   specs ("food" or { food, tag, regex, flags, in }), the matchers range/anyOf/allOf and "*" path segments; semantics in
 *   predicates.mjs. A canned `when` is evaluated by the same engine (helpers read the case observation; `none` never
 *   matches). Recorded state.agent.taskMemory entries with source "model_authored" (places, routes, progress, lessons)
 *   are replayed through the production taskMemory remember tool; observed entries (deaths, assets) are not. Intent and
 *   the `now` continuity header are still not reconstructed from recordings (recordings carry no tool arguments).
 *   Eval sessions name observation views with a fixed id (runner EVAL_VIEW_SESSION) so repeated samples share the
 *   prompt cache; rendered.encodedSha256 is unchanged because it canonicalises the id.
 * - v1.3 (2026-10-12, additive): predicate keys for situation-sensitive grading (semantics in predicates.mjs):
 *   firstAction / firstActionArgs (only the call's first body action, so a retry with a repair step before it is not
 *   a plain retry), escapesHazard { blocks?, minMove? } (the estimated end position leaves every listed hazard block
 *   and is not closer to one), rises { minDy?, minTicks? } (upward progress: a higher destination, or jump / swim-up
 *   frames), freesSlot <item spec> (a whole inventory stack of that item is dropped or stored, so a slot frees),
 *   discardsItem <item spec> (any amount of that item is dropped or thrown), clearsLineOfSight {x,y,z} (breaks a
 *   different block on the eye-to-target line). movesAway and approaches accept maxFinalDistance. Train cases may
 *   carry source.derived.invariants (absentItems, absentBlocks, fullInventoryFor) that the fixture invariant test checks.
 * - v1.4 (2026-10-12, additive): predicate key collectsWithoutRoom (boolean): the call mines a block or picks up an item
 *   entity whose incoming item fits nowhere in the observed inventory (no empty main slot, no stack of that item with
 *   room; an explicit block-to-drop map, unknown drops never match; a whole stack dropped or stored earlier in the same
 *   call frees a slot). Grading policy for the corpus: predicates decide only unambiguous outcomes and every case
 *   carries expect.judge.rubric, so anything else goes to the cross-family judge. Cases carry source.sourceMomentId
 *   ("sm-" + 16 hex): a stable id of the recorded source moment (trace + recorded observation hash; a derived case
 *   uses the moment it was derived from), shared by an original and its derived variants. Canned replies carry
 *   recorded.command exactly as recorded and a `when` that requires a single body action with every recorded
 *   argument except timeoutMs.
 *
 * ---------------------------------------------------------------------------------------------------------------
 * CASE (one JSON object; a case file is an array of cases or { "cases": [...] })
 * {
 *   "id": "creeper-post-escape-03",            // unique, [a-z0-9][a-z0-9._-]{0,127}
 *   "family": "creeper-post-escape",           // variants of one cause class share a family
 *   "causeClass": "threat-after-escape",
 *   "split": "train" | "heldout",
 *   "quick": true,                             // optional: member of the quick push subset
 *   "rationale": "what a real player does here and why",   // optional, player-sense note for reviewers
 *   "source": { "trace": "<path or run id>", "atMs": 123456, "note": "PAIR2 B2" },
 *   "state": {
 *     "observation": { ... },                  // RAW server observation as recorded on the protocol (the
 *                                              // observation message payload's `observation`, or the payload
 *                                              // itself). Required. Must carry goalRevision-independent facts only;
 *                                              // the renderer supplies the goal revision.
 *     "previousObservations": [ { ... } ],     // optional, oldest first: earlier raw observations of the same life,
 *                                              // replayed first so change lines, results and plan evidence build up
 *                                              // as in the game. `previousObservation` (single object) is accepted.
 *     "agent": {
 *       "goal": "make a wooden pickaxe",       // required: the player's request as the goal text
 *       "name": "ha_player",                   // optional in-game name of the agent (v1.1)
 *       "lastSummary": "..." | null,           // optional recovery summary a post-reset session receives (v1.1)
 *       "goalSpec": { ... } | null,            // optional recorded goal spec (predicate) for the task
 *       "taskPlan": { "steps": [...] } | null, // optional: the model-authored plan (taskPlan replace payload)
 *       "reflexes": [ { "id": "...", "when": {}, "do": {} } ], // optional prior live-authored rules; production runProgram setup
 *       "intent": { "step": "...", ... } | null,   // optional: the model-authored working intent (taskPlan intent)
 *       "continuity": { ... } | null,          // optional, informational only: the recorded `now` header. Never
 *                                              // sent; the renderer recomputes it from plan/intent/results.
 *       "taskMemory": { ... } | null,          // optional: the recorded taskMemory context. Model-authored places,
 *                                              // routes, progress and lessons are replayed (v1.2); observed deaths
 *                                              // and stations are seeded through the build's TaskMemoryStore (v1.3)
 *       "recentResults": [ { "tool": "moveTo", "args": {...}, "result": {...} } ]   // optional, informational;
 *                                              // results reach the model through the lastResult of replayed
 *                                              // observations; a result no replayed observation carries is listed
 *                                              // in the render's replay.unreplayed
 *     },
 *     "wake": {                                // optional; how the coordinator woke the model in the recording
 *       "event": "observation",                // informational
 *       "trigger": "damage",                   // expected trigger; the build classifies the observation itself and
 *                                              // the render reports a mismatch instead of forcing it
 *       "dangerSummary": { ... } | null,       // informational (folded hits are rebuilt from the observations)
 *       "conversation": [ { ... } ]            // unread conversation entries: not replayable yet (render fails)
 *     },
 *     "lifecycle": [ { "beforeObservation": 2, "payload": { "operation": "dead", "death": {...} } } ],
 *                                              // optional (v1.5, additive): recorded goal_control dead/respawn
 *                                              // payloads, delivered before replay entry beforeObservation (index
 *                                              // into previousObservations, then the case observation); the
 *                                              // renderer supplies the goal revision
 *     "wakeReason": "threat|action_result|failure|..."   // optional free label for reports (not sent)
 *   },
 *   "steps": [                                 // optional multi-step script, see CANNED STEPS
 *     { "canned": [ { "when": <predicate>, "result": { ...recorded tool result... }, "note": "..." } ] }
 *   ],
 *   "expect": {
 *     "good": [ <predicate>, ... ],            // a sample is good when ANY good predicate holds
 *     "bad": [ <predicate>, ... ],             // ... and bad when ANY bad predicate holds (bad wins)
 *     "judge": { "rubric": "..." } | null,     // open-ended cases only, when predicates cannot decide
 *     "threshold": 0.67                        // minimum good-rate for the candidate build, 0..1
 *   }
 * }
 *
 * CANNED STEPS (multi-step cases)
 * Every call the model makes is recorded in order (calls[].index 0, 1, 2, ...). A call the production normaliser
 * rejects (invalid arguments) gets the production rejection, is recorded with normalizeError, and does not advance
 * the script. For the k-th ACCEPTED call (k = 0, 1, ...):
 *   - if k < steps.length and some steps[k].canned[j].when matches it, the runner returns that recorded `result` to
 *     the model as the tool result (presented by the production tool-result path) and keeps going;
 *   - otherwise the sample stops after recording it (stop = "off_script" when k < steps.length, else "script_end")
 *     and the runner interrupts the turn. The runner never invents a game reply. A case without steps stops after its
 *     first accepted call. calls[].canned = { step: k, choice: j } marks a call that received a canned result.
 * A `when` predicate is evaluated against that single call and may use tool, args, normalized, not, any and all
 * (domain helpers, none and index need the whole sample and never match in `when`).

 * PREDICATE (evaluated on the captured calls of one sample)
 * {
 *   "tool": "moveTo" | ["moveTo", "control"],  // model-facing tool name(s) (MINECRAFT_DYNAMIC_TOOLS names,
 *                                              // without any provider prefix such as mcp__minecraft__)
 *   "args": { "<path>": <matcher>, ... },      // dotted paths into the raw model arguments, e.g. "x", "action.type"
 *   "normalized": { "<path>": <matcher> },     // dotted paths into the production-normalized tool, e.g.
 *                                              // "kind", "actionType", "arguments.targetEntityType"
 *   "index": 0 | "any" | "first" | "last",     // which call(s) to test; default "any"
 *   "not": <predicate>,                        // holds when the inner predicate does not
 *   "any": [ <predicate>, ... ],               // holds when one holds
 *   "all": [ <predicate>, ... ],               // holds when all hold
 *   "none": true,                              // holds when the sample made no call at all
 *   // domain helpers (each tested on the selected call):
 *   "awayFrom": { "position": { "x": 1, "y": 64, "z": 2 } | "player" | "threat", "minDistance": 4 },
 *                                              // the call's movement target is >= minDistance farther from the
 *                                              // position than the player is now ("player" = observation player
 *                                              // position, "threat" = nearest hostile entity in the observation)
 *   "targetsEntity": "minecraft:zombie" | ["minecraft:zombie", ...],   // the call targets that entity type
 *   "usesItem": "minecraft:bread" | ["minecraft:bread", ...]           // the call uses/eats/equips/places that item
 * }
 * Keys combine with AND inside one predicate object. A predicate with only "index"/"tool"/"args" tests one call
 * selected by "index". The grade agent owns evaluation semantics for helpers; their argument shapes are fixed here.
 *
 * MATCHER (value at a path)
 *   literal (string/number/boolean/null)   equality
 *   { "eq": value }                        deep equality
 *   { "regex": "pattern", "flags": "i" }   string match
 *   { "gte": n, "lte": n, "gt": n, "lt": n }   numeric range (any subset)
 *   { "in": [ ... ] }                      membership (deep equality)
 *   { "contains": value }                  array contains / substring
 *   { "exists": true|false }               path present or absent
 *   { "not": <matcher> }                   negation
 *
 * SAMPLE RESULT (one per case per sample; JSONL row or element of run.results)
 * {
 *   "schemaVersion": 1, "kind": "decision-eval-sample",
 *   "caseId", "family", "causeClass", "split", "sample": 0,
 *   "provider": "claude", "model": "claude-opus-5-5", "effort": "low",
 *   "build": { "commit": "<sha>", "dirty": false, "fingerprint": "<sha256 of commit + instructions + tools>" },
 *   "rendered": { "inputSha256", "inputBytes", "instructionsSha256", "instructionsBytes", "toolsSha256", "toolsBytes",
 *                 "prefixSha256" },              // prefix = instructions + tools; input = the encoded wake text
 *   "calls": [ { "index": 0, "name": "moveTo", "args": {...}, "normalized": {...} | null,
 *                "normalizeError": "..." | null, "canned": { "step": 0, "choice": 0 } | null, "atMs": 1234 } ],
 *   "stop": "off_script" | "script_end" | "turn_end" | "max_calls" | "error",
 *   "text": "assistant text, if any (truncated)",
 *   "error": null | { "code", "message" },
 *   "usage": { "modelCalls", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens",
 *              "costUsd", "costSource": "provider" | "estimate" },
 *   "latency": { "totalMs", "firstCallMs", "queueMs", "attempts" },
 *   "grade": null | { "verdict": "good" | "bad" | "neutral" | "judge_good" | "judge_bad" | "error", ... }
 * }
 *
 * RUN FILE (CLI --out): { "schemaVersion": 1, "kind": "decision-eval-run", "startedAt", "finishedAt", "build",
 *   "config": { provider, model, effort, samples, concurrency, split, casesPath, casesSha256 },
 *   "results": [ SAMPLE RESULT ... ], "summary": { samples, errors, wallMs, maxConcurrency, costUsd, ... } }
 */

export const DECISION_EVAL_SCHEMA_VERSION = 1;
export const CASE_SPLITS = Object.freeze(['train', 'heldout']);
export const STOP_REASONS = Object.freeze(['off_script', 'script_end', 'turn_end', 'max_calls', 'error']);
export const GRADE_VERDICTS = Object.freeze(['good', 'bad', 'neutral', 'judge_good', 'judge_bad', 'error', 'ungraded']);
export const INDEX_SELECTORS = Object.freeze(['any', 'first', 'last', 'every']);
export const DEFAULT_THRESHOLD = 0.67;

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PREDICATE_KEYS = new Set(['tool', 'args', 'normalized', 'index', 'not', 'any', 'all', 'none', 'awayFrom', 'targetsEntity', 'usesItem',
	// v1.2 grade extensions (semantics in predicates.mjs)
	'action', 'actionArgs', 'movesAway', 'approaches', 'placesBlock', 'breaksBlock', 'waits', 'noBodyAction', 'bodyAction', 'count',
	// v1.3
	'firstAction', 'firstActionArgs', 'escapesHazard', 'rises', 'freesSlot', 'discardsItem', 'clearsLineOfSight',
	// v1.4
	'collectsWithoutRoom']);
const MATCHER_KEYS = new Set(['eq', 'regex', 'flags', 'gte', 'lte', 'gt', 'lt', 'in', 'contains', 'exists', 'not', 'range', 'anyOf', 'allOf']);

export class DecisionEvalSchemaError extends TypeError {
	constructor(path, message) {
		super(`${path}: ${message}`);
		this.code = 'DECISION_EVAL_SCHEMA';
		this.path = path;
	}
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (path, message) => { throw new DecisionEvalSchemaError(path, message); };

/** Validates one matcher; returns it unchanged. */
export function validateMatcher(value, path = 'matcher') {
	if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
	if (!isObject(value)) fail(path, 'matcher must be a literal or an object');
	const keys = Object.keys(value);
	if (keys.length === 0) fail(path, 'matcher object is empty');
	for (const key of keys) if (!MATCHER_KEYS.has(key)) fail(path, `unknown matcher key '${key}'`);
	if ('regex' in value) {
		if (typeof value.regex !== 'string') fail(`${path}.regex`, 'must be a string');
		try { new RegExp(value.regex, value.flags ?? ''); } catch (error) { fail(`${path}.regex`, error.message); }
	}
	if ('flags' in value && !('regex' in value)) fail(`${path}.flags`, 'flags need regex');
	for (const key of ['gte', 'lte', 'gt', 'lt']) if (key in value && !Number.isFinite(value[key])) fail(`${path}.${key}`, 'must be a finite number');
	if ('in' in value && !Array.isArray(value.in)) fail(`${path}.in`, 'must be an array');
	if ('exists' in value && typeof value.exists !== 'boolean') fail(`${path}.exists`, 'must be a boolean');
	if ('not' in value) validateMatcher(value.not, `${path}.not`);
	if ('range' in value && !(Array.isArray(value.range) && value.range.length === 2 && value.range.every((bound) => bound === null || Number.isFinite(bound)))) fail(`${path}.range`, 'must be [min, max] with numbers or null');
	for (const key of ['anyOf', 'allOf']) {
		if (!(key in value)) continue;
		if (!Array.isArray(value[key]) || value[key].length === 0) fail(`${path}.${key}`, 'must be a nonempty array of matchers');
		value[key].forEach((entry, index) => validateMatcher(entry, `${path}.${key}[${index}]`));
	}
	return value;
}

function validatePathMap(value, path) {
	if (!isObject(value) || Object.keys(value).length === 0) fail(path, 'must be a nonempty object of path -> matcher');
	for (const [key, matcher] of Object.entries(value)) {
		if (!/^(?:[A-Za-z0-9_$-]+|\*)(\.(?:[A-Za-z0-9_$-]+|\*))*$/.test(key)) fail(`${path}.${key}`, 'path must be dotted identifiers or "*"');
		validateMatcher(matcher, `${path}.${key}`);
	}
}

function validateStringOrList(value, path) {
	const list = Array.isArray(value) ? value : [value];
	if (list.length === 0 || list.some((entry) => typeof entry !== 'string' || entry.length === 0)) fail(path, 'must be a nonempty string or array of strings');
}

function validatePosition(value, path) {
	if (value === 'player' || value === 'threat') return;
	if (!isObject(value) || !['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]))) fail(path, 'must be "player", "threat" or {x,y,z}');
}

/** Validates one predicate; returns it unchanged. */
export function validatePredicate(value, path = 'predicate') {
	if (!isObject(value)) fail(path, 'predicate must be an object');
	const keys = Object.keys(value);
	if (keys.length === 0) fail(path, 'predicate is empty');
	for (const key of keys) if (!PREDICATE_KEYS.has(key)) fail(path, `unknown predicate key '${key}'`);
	if ('tool' in value) validateStringOrList(value.tool, `${path}.tool`);
	if ('args' in value) validatePathMap(value.args, `${path}.args`);
	if ('normalized' in value) validatePathMap(value.normalized, `${path}.normalized`);
	if ('index' in value && !Number.isSafeInteger(value.index) && !INDEX_SELECTORS.includes(value.index)) {
		fail(`${path}.index`, `must be an integer (negative counts from the end) or one of ${INDEX_SELECTORS.join(', ')}`);
	}
	if ('not' in value) validatePredicate(value.not, `${path}.not`);
	for (const key of ['any', 'all']) {
		if (!(key in value)) continue;
		if (!Array.isArray(value[key]) || value[key].length === 0) fail(`${path}.${key}`, 'must be a nonempty array');
		value[key].forEach((entry, index) => validatePredicate(entry, `${path}.${key}[${index}]`));
	}
	if ('none' in value && value.none !== true) fail(`${path}.none`, 'must be true');
	if ('awayFrom' in value) {
		if (!isObject(value.awayFrom)) fail(`${path}.awayFrom`, 'must be an object');
		validatePosition(value.awayFrom.position, `${path}.awayFrom.position`);
		if (!Number.isFinite(value.awayFrom.minDistance) || value.awayFrom.minDistance < 0) fail(`${path}.awayFrom.minDistance`, 'must be a nonnegative number');
	}
	if ('targetsEntity' in value) {
		if (isObject(value.targetsEntity)) { if (!('type' in value.targetsEntity) && !('hostile' in value.targetsEntity)) fail(`${path}.targetsEntity`, 'object form needs type or hostile'); }
		else validateStringOrList(value.targetsEntity, `${path}.targetsEntity`);
	}
	for (const key of ['usesItem', 'placesBlock', 'breaksBlock', 'freesSlot', 'discardsItem']) if (key in value) validateItemSpec(value[key], `${path}.${key}`);
	for (const key of ['action', 'firstAction']) if (key in value) validateStringOrList(value[key], `${path}.${key}`);
	for (const key of ['actionArgs', 'firstActionArgs']) if (key in value) validatePathMap(value[key], `${path}.${key}`);
	for (const key of ['movesAway', 'approaches']) {
		if (!(key in value)) continue;
		const spec = value[key];
		if (!(typeof spec === 'string' || isObject(spec))) fail(`${path}.${key}`, 'must be a reference ("player", "nearestHostile", {x,y,z}, {entityType}) or { from|to, minDistance }');
		for (const bound of ['minDistance', 'minFinalDistance', 'maxFinalDistance']) if (isObject(spec) && bound in spec && !(Number.isFinite(spec[bound]) && spec[bound] >= 0)) fail(`${path}.${key}.${bound}`, 'must be a nonnegative number');
	}
	if ('escapesHazard' in value) {
		const spec = value.escapesHazard;
		if (!isObject(spec)) fail(`${path}.escapesHazard`, 'must be { blocks?, minMove? }');
		for (const key of Object.keys(spec)) if (!['blocks', 'minMove'].includes(key)) fail(`${path}.escapesHazard`, `unknown key '${key}'`);
		if ('blocks' in spec) { if (typeof spec.blocks !== 'string') fail(`${path}.escapesHazard.blocks`, 'must be a regex string'); try { new RegExp(spec.blocks); } catch (error) { fail(`${path}.escapesHazard.blocks`, error.message); } }
		if ('minMove' in spec && !(Number.isFinite(spec.minMove) && spec.minMove >= 0)) fail(`${path}.escapesHazard.minMove`, 'must be a nonnegative number');
	}
	if ('rises' in value) {
		const spec = value.rises;
		if (!isObject(spec)) fail(`${path}.rises`, 'must be { minDy?, minTicks? }');
		for (const key of Object.keys(spec)) if (!['minDy', 'minTicks'].includes(key)) fail(`${path}.rises`, `unknown key '${key}'`);
		for (const key of ['minDy', 'minTicks']) if (key in spec && !(Number.isFinite(spec[key]) && spec[key] >= 0)) fail(`${path}.rises.${key}`, 'must be a nonnegative number');
	}
	if ('clearsLineOfSight' in value) validatePosition(value.clearsLineOfSight, `${path}.clearsLineOfSight`);
	for (const key of ['waits', 'noBodyAction', 'bodyAction', 'collectsWithoutRoom']) if (key in value && typeof value[key] !== 'boolean') fail(`${path}.${key}`, 'must be a boolean');
	if ('count' in value) {
		if (!isObject(value.count) || !Object.keys(value.count).every((key) => key === 'min' || key === 'max')) fail(`${path}.count`, 'must be { min, max }');
		for (const key of ['min', 'max']) if (key in value.count && !(Number.isSafeInteger(value.count[key]) && value.count[key] >= 0)) fail(`${path}.count.${key}`, 'must be a nonnegative integer');
	}
	return value;
}

// An item id, a list of ids, "food", or { food, tag, regex, flags, in }.
function validateItemSpec(value, path) {
	if (!isObject(value)) { validateStringOrList(value, path); return; }
	const known = new Set(['food', 'tag', 'regex', 'flags', 'in']);
	for (const key of Object.keys(value)) if (!known.has(key)) fail(path, `unknown item spec key '${key}'`);
	if ('regex' in value) try { new RegExp(value.regex, value.flags ?? ''); } catch (error) { fail(`${path}.regex`, error.message); }
	if ('in' in value && !Array.isArray(value.in)) fail(`${path}.in`, 'must be an array');
}

function validateSteps(steps, path) {
	if (!Array.isArray(steps)) fail(path, 'must be an array');
	steps.forEach((step, index) => {
		const stepPath = `${path}[${index}]`;
		if (!isObject(step) || !Array.isArray(step.canned) || step.canned.length === 0) fail(stepPath, 'must have a nonempty canned array');
		step.canned.forEach((choice, choiceIndex) => {
			const choicePath = `${stepPath}.canned[${choiceIndex}]`;
			if (!isObject(choice)) fail(choicePath, 'must be an object');
			validatePredicate(choice.when, `${choicePath}.when`);
			if (!isObject(choice.result)) fail(`${choicePath}.result`, 'must be the recorded tool result object');
		});
	});
}

/** Validates one case; returns it unchanged. Throws DecisionEvalSchemaError with the failing path. */
export function validateCase(value, path = 'case') {
	if (!isObject(value)) fail(path, 'case must be an object');
	if (typeof value.id !== 'string' || !ID.test(value.id)) fail(`${path}.id`, 'must match [a-z0-9][a-z0-9._-]{0,127}');
	path = `case ${value.id}`;
	for (const key of ['family', 'causeClass']) if (typeof value[key] !== 'string' || !ID.test(value[key])) fail(`${path}.${key}`, 'must be a lowercase identifier');
	if (!CASE_SPLITS.includes(value.split)) fail(`${path}.split`, `must be one of ${CASE_SPLITS.join(', ')}`);
	if ('quick' in value && typeof value.quick !== 'boolean') fail(`${path}.quick`, 'must be a boolean');
	if (value.source !== undefined && !isObject(value.source)) fail(`${path}.source`, 'must be an object');
	const state = value.state;
	if (!isObject(state)) fail(`${path}.state`, 'must be an object');
	if (!isObject(state.observation)) fail(`${path}.state.observation`, 'must be the raw recorded observation object');
	if (state.previousObservation !== undefined && state.previousObservation !== null && !isObject(state.previousObservation)) fail(`${path}.state.previousObservation`, 'must be an object');
	if (state.previousObservations !== undefined && (!Array.isArray(state.previousObservations) || !state.previousObservations.every(isObject))) {
		fail(`${path}.state.previousObservations`, 'must be an array of observation objects');
	}
	if (state.lifecycle !== undefined && (!Array.isArray(state.lifecycle) || !state.lifecycle.every((entry) => isObject(entry)
		&& Number.isSafeInteger(entry.beforeObservation) && entry.beforeObservation >= 0 && isObject(entry.payload) && ['dead', 'respawn'].includes(entry.payload.operation)))) {
		fail(`${path}.state.lifecycle`, 'must be an array of { beforeObservation, payload: { operation: dead|respawn } }');
	}
	const agent = state.agent;
	if (!isObject(agent)) fail(`${path}.state.agent`, 'must be an object');
	if (typeof agent.goal !== 'string' || agent.goal.trim().length === 0) fail(`${path}.state.agent.goal`, 'must be nonblank');
	for (const key of ['name', 'lastSummary']) {
		if (agent[key] !== undefined && agent[key] !== null && (typeof agent[key] !== 'string' || agent[key].length === 0)) fail(`${path}.state.agent.${key}`, 'must be a nonempty string or null');
	}
	for (const key of ['goalSpec', 'taskPlan', 'intent', 'continuity', 'taskMemory']) {
		if (agent[key] !== undefined && agent[key] !== null && !isObject(agent[key])) fail(`${path}.state.agent.${key}`, 'must be an object or null');
	}
	if (agent.reflexes !== undefined && (!Array.isArray(agent.reflexes) || !agent.reflexes.every(isObject))) fail(`${path}.state.agent.reflexes`, 'must be an array of prior live-authored rule objects');
	if (agent.recentResults !== undefined && !Array.isArray(agent.recentResults)) fail(`${path}.state.agent.recentResults`, 'must be an array');
	if (state.wake !== undefined) {
		if (!isObject(state.wake)) fail(`${path}.state.wake`, 'must be an object');
		for (const key of ['event', 'trigger']) if (state.wake[key] !== undefined && (typeof state.wake[key] !== 'string' || state.wake[key].length === 0)) fail(`${path}.state.wake.${key}`, 'must be a nonblank string');
		if (state.wake.conversation !== undefined && !Array.isArray(state.wake.conversation)) fail(`${path}.state.wake.conversation`, 'must be an array');
	}
	if (value.steps !== undefined) validateSteps(value.steps, `${path}.steps`);
	const expect = value.expect;
	if (!isObject(expect)) fail(`${path}.expect`, 'must be an object');
	for (const key of ['good', 'bad']) {
		if (expect[key] === undefined) continue;
		if (!Array.isArray(expect[key])) fail(`${path}.expect.${key}`, 'must be an array');
		expect[key].forEach((predicate, index) => validatePredicate(predicate, `${path}.expect.${key}[${index}]`));
	}
	if (expect.judge !== undefined && expect.judge !== null && (!isObject(expect.judge) || typeof expect.judge.rubric !== 'string' || expect.judge.rubric.trim().length === 0)) {
		fail(`${path}.expect.judge`, 'must be null or { rubric }');
	}
	if ((expect.good?.length ?? 0) === 0 && (expect.bad?.length ?? 0) === 0 && !expect.judge) fail(`${path}.expect`, 'needs good or bad predicates, or a judge rubric');
	// The gate reads expect.threshold only; a second top-level value would silently disagree with it.
	if ('threshold' in value) fail(`${path}.threshold`, 'is not read; set the gate in expect.threshold');
	if (expect.threshold !== undefined && !(Number.isFinite(expect.threshold) && expect.threshold >= 0 && expect.threshold <= 1)) fail(`${path}.expect.threshold`, 'must be within 0..1');
	return value;
}

/** Accepts an array of cases or { cases: [...] }; validates each and rejects duplicate ids. */
export function validateCaseFile(value, path = 'cases') {
	const cases = Array.isArray(value) ? value : value?.cases;
	if (!Array.isArray(cases)) fail(path, 'must be an array of cases or { cases: [...] }');
	const seen = new Set();
	for (const [index, entry] of cases.entries()) {
		validateCase(entry, `${path}[${index}]`);
		if (seen.has(entry.id)) fail(`${path}[${index}].id`, `duplicate case id '${entry.id}'`);
		seen.add(entry.id);
	}
	return cases;
}

/** The previous observations of a case, oldest first (accepts the single previousObservation form). */
export function casePreviousObservations(testCase) {
	const state = testCase.state;
	if (Array.isArray(state.previousObservations)) return state.previousObservations;
	return isObject(state.previousObservation) ? [state.previousObservation] : [];
}

/** Validates one sample result row as written by the runner. */
export function validateSampleResult(value, path = 'result') {
	if (!isObject(value)) fail(path, 'must be an object');
	if (value.schemaVersion !== DECISION_EVAL_SCHEMA_VERSION || value.kind !== 'decision-eval-sample') fail(path, 'not a v1 decision-eval-sample');
	if (typeof value.caseId !== 'string' || !Number.isSafeInteger(value.sample) || value.sample < 0) fail(path, 'needs caseId and sample');
	if (!Array.isArray(value.calls)) fail(`${path}.calls`, 'must be an array');
	value.calls.forEach((call, index) => {
		if (!isObject(call) || call.index !== index || typeof call.name !== 'string' || !isObject(call.args)) fail(`${path}.calls[${index}]`, 'needs index, name and args');
	});
	if (!STOP_REASONS.includes(value.stop)) fail(`${path}.stop`, `must be one of ${STOP_REASONS.join(', ')}`);
	if (value.grade !== null && value.grade !== undefined && !GRADE_VERDICTS.includes(value.grade.verdict)) fail(`${path}.grade.verdict`, `must be one of ${GRADE_VERDICTS.join(', ')}`);
	return value;
}
