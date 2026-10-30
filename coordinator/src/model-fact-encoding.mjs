import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { presentAppearanceWake } from './appearance-wake-presentation.mjs';
import { presentEyeFlightWake } from './eye-flight-presentation.mjs';
import { NEW_CONTEXT_EVENT_INSTRUCTION, isNewContextEventInput } from './native-event-instructions.mjs';
import { withFailureSchema } from './failure-schema.mjs';

export const MODEL_FACT_FORMAT = 'minecraft-facts-v1';
export const MODEL_FACT_INSTRUCTIONS = `format:"minecraft-facts-v1" data is JSON; {$rows:{columns,defaults?,rows,optional?}} holds column-ordered records; optional null means absent. defaults applies to all rows. {$ref:N} equals values[N] in this reply; {$object:[[key,value],...]} escapes reserved keys. Null/absence and coverage/freshness are unchanged. observe defaults to a full snapshot with observationView.id; action/sequence postAction without view defaults to whole-section changes against the newest delivered view (baseId), full after 8 in a row. view:"changes",afterObservationId selects changes against that delivered tool/wake ID; view:"full" a full snapshot. Apply observationView.replace/remove; keep other sections. observationView.retainMetadata copies named sample fields from baseline; others are current or absent. Receipts and per-step history stay unchanged. Invalid baseline: full. Request view:"full" if unsure. Observation entityAppearance/blockAppearance map facts to {rowIndex:value} in current entities/blocks; arrays or range strings ("0,2-5") select true rows; nested [value,range] pairs share values. Player effects: [effectId,amplifier,seconds]. Entity bounds arrays are [minX,minY,minZ,maxX,maxY,maxZ]. Omitted vanilla names follow type. Absent wake conversation means no unread messages; absent omittedEntries means zero.`;
const MAX_DELIVERED_VIEWS = 8;
const MAX_DELIVERED_VIEW_BYTES = 2 * 1024 * 1024;
const RETAINABLE_METADATA = ['taskMemory', 'goal', 'goalSpec', 'executionSettings'];
// Event fields that rarely change between wakes; repeating them unchanged in every event only grows the context.
const EVENT_METADATA = ['now', 'situation', 'combat', 'progress', 'goal', 'goalSpec', 'taskMemory', 'program', 'conversation'];
const MIN_RETAINED_EVENT_FIELD_BYTES = 64;
// Default action/sequence changes views in a row before the next one is a full snapshot again.
const MAX_DEFAULT_CHANGES_CHAIN = 8;
const MARKERS = new Set(['$ref', '$rows', '$object']);
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const marked = value => record(value) && Object.keys(value).length === 1 && MARKERS.has(Object.keys(value)[0]);
const REFERENCE_FIELDS = ['reference', 'topics', 'actions', 'controlConditions', 'inspectionSections', 'limits', 'programReference', 'controlReference', 'strategyReference', 'engine', 'detail', 'completeReference', 'title', 'coverage'];
const observationIdentity = observation => typeof observation?.world?.worldId === 'string' && typeof observation?.world?.dimension === 'string'
 ? JSON.stringify([observation.world.worldId, observation.world.dimension, observation.player?.dead === true, observation.continuity?.phase ?? null]) : null;

/**
 * Raw float noise in measured readings ("distance":6.716937249955465, velocity -0.0784000015258789) is about 4% of an
 * event. These measured keys are shown to 3 decimals when they carry five or more; requested endpoints, tolerances,
 * progress and every other number stay exact.
 */
const ROUNDED_MEASUREMENTS = new Set(['distance', 'bearing', 'elevation', 'attackCooldown']);
const roundMeasurement = value => {
 if (typeof value !== 'number' || !Number.isFinite(value) || Number.isInteger(value * 10_000)) return value;
 const rounded = Math.round(value * 1000) / 1000;
 return Object.is(rounded, -0) ? 0 : rounded;
};
export function roundModelNumbers(value) {
 if (Array.isArray(value)) {
  let changed = false;
  const next = value.map(child => { const result = roundModelNumbers(child); changed ||= result !== child; return result; });
  return changed ? next : value;
 }
 if (!record(value)) return value;
 let changed = false;
 const next = {};
 for (const [key, child] of Object.entries(value)) {
  let result;
  if (ROUNDED_MEASUREMENTS.has(key)) result = roundMeasurement(child);
  else if (key === 'velocity' && record(child) && ['x', 'y', 'z'].every(axis => typeof child[axis] === 'number')) {
   const rounded = { ...child, x: roundMeasurement(child.x), y: roundMeasurement(child.y), z: roundMeasurement(child.z) };
   result = rounded.x === child.x && rounded.y === child.y && rounded.z === child.z ? child : rounded;
  } else result = roundModelNumbers(child);
  changed ||= result !== child;
  next[key] = result;
 }
 return changed ? next : value;
}

/** Provider presentation only. Each reply is complete; no dictionary survives a reply. */
export function encodeModelFacts(value) {
 const originalBytes = bytes(value);
 const wrappedAlready = value?.format === MODEL_FACT_FORMAT && Array.isArray(value.values) && Object.hasOwn(value, 'data');
 // Small view deltas can still contain several identical flight records.
 if (originalBytes < 256 && !wrappedAlready) return value;
 const counts = new Map();
 const serializedObjects = new WeakMap();
 const serialized = current => {
  if (current === null || typeof current !== 'object') return JSON.stringify(current);
  if (!serializedObjects.has(current)) serializedObjects.set(current, JSON.stringify(current));
  return serializedObjects.get(current);
 };
 const count = current => {
  if (typeof current === 'string' && current.length >= 32 || current !== null && typeof current === 'object') {
   const key = serialized(current);
   if (typeof current === 'string' || Buffer.byteLength(key, 'utf8') >= 80) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (Array.isArray(current)) for (const child of current) count(child);
  else if (record(current)) for (const child of Object.values(current)) count(child);
 };
 count(value);
 const shared = new Set([...counts].filter(([key, times]) => times >= 2 && (times - 1) * Buffer.byteLength(key) - times * 12 > 40).map(([key]) => key));
 const values = [], indexes = new Map();
 const pack = (current, skip = null) => {
  const key = serialized(current);
  if (key !== skip && shared.has(key)) {
   if (!indexes.has(key)) {
    const index = values.length;
    indexes.set(key, index); values.push(null);
    values[index] = pack(current, key);
   }
   return { $ref: indexes.get(key) };
  }
  if (Array.isArray(current)) {
   const rows = current.map(child => pack(child));
   if (current.length >= 2 && current.every(record)) {
    // Mixed rows (a slab with state among plain stone) share one table: a column missing from some
    // rows is listed in optional, where null means absent, unless a present value is itself null.
    const columns = [...new Set(current.flatMap(row => Object.keys(row)))];
    const optional = columns.filter(column => !current.every(row => Object.hasOwn(row, column)));
    const representable = optional.every(column => current.every(row => !Object.hasOwn(row, column) || row[column] !== null));
    if (representable && columns.length <= 64) {
     // Reuse packed children, including dictionary-backed/literal rows. Packing
     // those children again doubles recursive work at every nested row level.
     const cells = rows.map((row, index) => {
      const packed = marked(row) && Object.hasOwn(row, '$ref') ? values[row.$ref] : row;
      const fields = marked(packed) && Object.hasOwn(packed, '$object') ? Object.fromEntries(packed.$object) : packed;
      return columns.map(column => Object.hasOwn(current[index], column) ? fields[column] : null);
     });
     let table = { $rows: { columns, rows: cells, ...(optional.length === 0 ? {} : { optional }) } };
     // Constant columns are explicit facts, including null/false/zero. A default never means unknown.
     // Keep reserved column names in cells: a one-key defaults record must not become a fact marker.
     const constant = columns.filter(column => !MARKERS.has(column) && !optional.includes(column) && current.every(row => isDeepStrictEqual(row[column], current[0][column])));
     if (constant.length > 0) {
      const defaults = Object.fromEntries(constant.map(column => [column, cells[0][columns.indexOf(column)]]));
      const varying = columns.filter(column => !constant.includes(column));
      const candidate = { $rows: { columns: varying, defaults, rows: cells.map(row => columns.flatMap((column, index) => constant.includes(column) ? [] : [row[index]])),
       ...(optional.length === 0 ? {} : { optional }) } };
      if (bytes(candidate) < bytes(table)) table = candidate;
     }
     if (bytes(table) < bytes(rows)) return table;
    }
   }
   return rows;
  }
  if (record(current)) {
   const entries = Object.entries(current).map(([key, child]) => [key, pack(child)]);
   return marked(current) ? { $object: entries } : Object.fromEntries(entries);
  }
  return current;
 };
 const data = pack(value);
 // Packing rows may bypass a whole-record reference. Retain only definitions
 // reachable from the final data, rather than sending unused dictionary entries.
 const used = new Set();
 const visit = current => {
  if (record(current) && Object.keys(current).length === 1 && Object.hasOwn(current, '$ref')) {
   const index = current.$ref;
   if (!used.has(index)) { used.add(index); visit(values[index]); }
  } else if (Array.isArray(current)) for (const child of current) visit(child);
  else if (record(current)) for (const child of Object.values(current)) visit(child);
 };
 visit(data);
 const order = [...used].sort((a, b) => a - b), remap = new Map(order.map((old, index) => [old, index]));
 const rewrite = current => {
  if (record(current) && Object.keys(current).length === 1 && Object.hasOwn(current, '$ref')) return { $ref: remap.get(current.$ref) };
  if (Array.isArray(current)) return current.map(rewrite);
  if (record(current)) return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, rewrite(child)]));
  return current;
 };
 const encoded = { format: MODEL_FACT_FORMAT, values: order.map(index => rewrite(values[index])), data: rewrite(data) };
 return wrappedAlready || bytes(encoded) + 128 < originalBytes ? encoded : value;
}

/** Exact decoder used for replay checks; the runtime keeps its original objects. */
export function decodeModelFacts(value) {
 if (value?.format !== MODEL_FACT_FORMAT || !Array.isArray(value.values) || !Object.hasOwn(value, 'data')) return value;
 const resolved = new Map(), resolving = new Set();
 const unpack = current => {
  if (Array.isArray(current)) return current.map(unpack);
  if (!record(current)) return current;
  if (Object.keys(current).length === 1 && Object.hasOwn(current, '$ref')) {
   const index = current.$ref;
   if (!Number.isSafeInteger(index) || index < 0 || index >= value.values.length || resolving.has(index)) throw new TypeError('Invalid fact reference');
   if (!resolved.has(index)) { resolving.add(index); resolved.set(index, unpack(value.values[index])); resolving.delete(index); }
   return structuredClone(resolved.get(index));
  }
  if (Object.keys(current).length === 1 && Object.hasOwn(current, '$rows')) {
   const { columns, rows, optional = [], defaults = {} } = current.$rows ?? {};
   if (!Array.isArray(columns) || columns.some(column => typeof column !== 'string') || new Set(columns).size !== columns.length || !Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== columns.length)) throw new TypeError('Invalid fact rows');
   if (!Array.isArray(optional) || optional.some(column => !columns.includes(column))) throw new TypeError('Invalid optional fact columns');
   if (!record(defaults) || Object.keys(defaults).some(key => columns.includes(key))) throw new TypeError('Invalid fact defaults');
   const absent = new Set(optional);
   return rows.map(row => Object.fromEntries([...Object.entries(defaults).map(([key, child]) => [key, unpack(child)]),
    ...columns.flatMap((column, index) => absent.has(column) && row[index] === null ? [] : [[column, unpack(row[index])]])]));
  }
  if (Object.keys(current).length === 1 && Object.hasOwn(current, '$object')) {
   if (!Array.isArray(current.$object) || current.$object.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')) throw new TypeError('Invalid literal fact object');
   return Object.fromEntries(current.$object.map(([key, child]) => [key, unpack(child)]));
  }
  return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, unpack(child)]));
 };
 return unpack(value.data);
}

/** Changes are opt-in, apply to whole named sections, and require the exact view. */
export class ModelObservationViews {
 #session;
 #baseline = null;
 #history = new Map();
 #historyBytes = 0;
 #sequence = 0;
 #committedSequence = 0;
 #generation = 0;
 #latestViewId = null;
 #eventMetadata = null;
 #references = new Set();
 #referenceGeneration = 0;
 // A fixed session is for evaluation only: equal wakes then share a prompt-cache prefix across provider sessions.
 constructor({ session = null } = {}) { this.#session = session ?? randomUUID(); }
 reset() { this.#resetObservations(); this.#eventMetadata = null; this.#references.clear(); this.#referenceGeneration++; }
 #resetObservations() { this.#baseline = null; this.#history.clear(); this.#historyBytes = 0; this.#latestViewId = null; this.#generation++; }
 /** An event may have been encoded but not delivered; force a full view until delivery is certain again. */
 forgetEventView() { this.reset(); }
 /** A turn that may not have reached the model must not become the baseline for omitted event fields. */
 forgetEventMetadata() { this.#eventMetadata = null; }
 /** Omits now, situation, goal, goalSpec and taskMemory when they equal the previous event delivered in this same provider context. */
 retainEventMetadata(value, { keep = [] } = {}) {
  const identity = observationIdentity(value.observation);
  const previous = this.#eventMetadata;
  this.#eventMetadata = identity === null ? null : { identity, fields: Object.fromEntries(EVENT_METADATA.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])])) };
  if (previous === null || identity === null || previous.identity !== identity) return value;
  // Guard absence or coverage stays visible on every wake, including partially retained headers.
  const same = EVENT_METADATA.filter(key => !keep.includes(key) && !(key === 'now' && typeof value.now?.guard === 'string') && Object.hasOwn(value, key) && Object.hasOwn(previous.fields, key)
   && bytes(value[key] ?? null) > bytes(key) && isDeepStrictEqual(value[key], previous.fields[key]));
  // The header changes line by line (usually only last); unchanged lines are named, not repeated.
  const now = !keep.includes('now') && !same.includes('now') && record(value.now) && record(previous.fields.now) ? partialHeader(value.now, previous.fields.now) : null;
  if (now === null && (same.length === 0 || same.length === 1 && bytes(value[same[0]] ?? null) <= bytes({ sameAsPreviousEvent: same }))) return value;
  if (same.length === 0) return { ...value, now };
  const retained = now === null ? { ...value } : { ...value, now };
  for (const key of same) delete retained[key];
  retained.sameAsPreviousEvent = same;
  return retained;
 }
 observeEvent(observation) {
  const identity = observationIdentity(observation);
  // Observation baselines are per sample; event metadata is checked against its own world identity below.
  if (identity === null || identity !== this.#baseline?.identity || observation.player?.dead === true || observation.continuity?.phase === 'dead') this.#resetObservations();
 }

 prepare(value, tool, { minRetainedMetadataBytes = 0 } = {}) {
  if (tool.kind === 'capabilities') return this.#prepareReference(value, tool);
  // Only the final fresh sample is a view. Per-step observations remain
  // historical receipts, even when a sequence stopped on a failed action.
  const nested = (tool.kind === 'action' || tool.kind === 'sequence') && record(value?.postAction);
  const sample = nested ? value.postAction : tool.kind === 'observe' ? value : null;
  if (!record(sample?.observation)) return { value, commit() {} };
  const owned = structuredClone(value);
  const snapshot = nested ? owned.postAction : owned;
  snapshot.observation = presentAppearanceWake(snapshot).observation;
  const observation = snapshot.observation = presentItemTags(presentRequestableInventoryDetail(presentInventoryTagCounts(presentEyeFlightWake(snapshot.observation))));
  const sequence = ++this.#sequence;
  const id = `observation-${this.#session}-${sequence}`;
  const identity = observationIdentity(observation);
  const eligible = identity !== null && snapshot.freshness?.fresh === true && observation.player?.dead !== true && observation.continuity?.phase !== 'dead';
  // An action or sequence that names no view gets changes against the newest view delivered in this provider
  // context, which the model has just read; the chain returns to a full snapshot every few replies so no section
  // has to be looked up far back. observe and view:"full" stay complete.
  const defaultChanges = nested && tool.view === undefined && tool.afterObservationId === undefined;
  const baseId = defaultChanges ? this.#latestViewId : tool.afterObservationId;
  const previous = this.#history.get(baseId) ?? null;
  const sameBaseline = eligible && previous !== null && previous.id === baseId && previous.identity === identity && previous.goalRevision === snapshot.goalRevision
   && !(defaultChanges && previous.chain >= MAX_DEFAULT_CHANGES_CHAIN);
  const retainedObservation = structuredClone(observation);
  const next = { id, identity, observation: retainedObservation, metadata: Object.fromEntries(RETAINABLE_METADATA.filter(key => Object.hasOwn(snapshot, key)).map(key => [key, structuredClone(snapshot[key])])), goalRevision: snapshot.goalRevision, chain: 0 };
  next.bytes = bytes(next);
  const full = { ...snapshot, observationView: { id, mode: 'full' } };
  let presented = full;
  if (sameBaseline && (tool.view === 'changes' || defaultChanges)) {
   const replace = Object.fromEntries(Object.entries(retainedObservation).filter(([key, current]) => !Object.hasOwn(previous.observation, key) || !isDeepStrictEqual(previous.observation[key], current)));
   const remove = Object.keys(previous.observation).filter(key => !Object.hasOwn(observation, key));
   const { observation: _full, ...metadata } = snapshot;
   const retainMetadata = RETAINABLE_METADATA.filter(key => Object.hasOwn(metadata, key) && Object.hasOwn(previous.metadata, key)
    && bytes(metadata[key] ?? null) > minRetainedMetadataBytes && isDeepStrictEqual(metadata[key], previous.metadata[key]));
   for (const key of retainMetadata) delete metadata[key];
   const changes = { ...metadata, observationView: { id, mode: 'changes', baseId: previous.id, replace, remove, ...(retainMetadata.length === 0 ? {} : { retainMetadata }) } };
   if (bytes(changes) < bytes(full)) {
    presented = changes;
    next.chain = previous.chain + 1;
   }
  }
  const generation = this.#generation;
  let committed = false;
  const commit = baseline => {
   if (committed || generation !== this.#generation) return;
   committed = true;
   // Sibling replies may finish delivery in either order. Keep each exact
   // delivered view, but an older callback must not reset newer context.
   if (sequence > this.#committedSequence) {
    if (baseline === null || this.#baseline !== null && this.#baseline.identity !== baseline.identity) this.reset();
    this.#committedSequence = sequence;
    this.#baseline = baseline === null ? null : { identity: baseline.identity };
   } else if (baseline === null || baseline.identity !== this.#baseline?.identity) return;
   if (baseline === null || baseline.bytes > MAX_DELIVERED_VIEW_BYTES) return;
   this.#history.set(baseline.id, baseline);
   this.#latestViewId = baseline.id;
   this.#historyBytes += baseline.bytes;
   while (this.#history.size > MAX_DELIVERED_VIEWS || this.#historyBytes > MAX_DELIVERED_VIEW_BYTES) {
    const oldest = this.#history.keys().next().value;
    this.#historyBytes -= this.#history.get(oldest).bytes;
    this.#history.delete(oldest);
   }
  };
  return { value: nested ? { ...owned, postAction: presented } : presented,
   commit: () => commit(eligible ? next : null), commitWithoutView: () => commit(null) };
 }
 #prepareReference(value, tool) {
  // How-to replies depend on current holdings. Only static documentation is reusable;
  // execution settings, task memory and runtime availability are returned every time.
  if (!record(value) || tool.section === 'howto' || value.state !== undefined) return { value, commit() {} };
  const reference = Object.fromEntries(REFERENCE_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  if (bytes(reference) < 512) return { value, commit() {} };
  const referenceId = `capabilities-${createHash('sha256').update(JSON.stringify(reference)).digest('hex')}`;
  const generation = this.#referenceGeneration;
  if (this.#references.has(referenceId)) {
   const current = Object.fromEntries(Object.entries(value).filter(([key]) => !Object.hasOwn(reference, key)));
   return { value: { ...current, sameAsReference: referenceId, detail: 'Reuse the static fields of that earlier delivered capabilities reply; current metadata is below.' }, commit() {} };
  }
  return { value: { ...value, referenceId }, commit: () => {
   if (generation !== this.#referenceGeneration) return;
   // An evicted reference is sent in full again; no model facts are invalidated.
   if (this.#references.size >= 64) this.#references.delete(this.#references.values().next().value);
   this.#references.add(referenceId);
  } };
 }
 /** Wake observations share the exact delivered-view history used by observe and postAction replies. */
 prepareEvent(value) {
  if (observationIdentity(value.observation) === null) {
   this.#resetObservations();
   return value;
  }
  const hadFreshness = Object.hasOwn(value, 'freshness');
  const freshness = value.freshness ?? { fresh: value.observation?.freshness?.fresh !== false };
  const prepared = this.prepare({ ...value, freshness }, {
  kind: 'observe', view: 'changes', afterObservationId: this.#latestViewId,
  }, { minRetainedMetadataBytes: MIN_RETAINED_EVENT_FIELD_BYTES });
  prepared.commit();
  if (hadFreshness) return prepared.value;
  const { freshness: _freshness, ...event } = prepared.value;
  return event;
 }
}

/** Omit a duplicate aggregate only when the exact retained item rows reconstruct it. */
export function presentInventoryTagCounts(observation) {
 const inventory = observation?.inventory;
 if (!Array.isArray(inventory?.items) || !record(inventory.tagCounts)) return observation;
 const totals = new Map();
 for (const item of inventory.items) {
  if (!record(item) || !Number.isFinite(item.count) || !Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string')) return observation;
  for (const tag of new Set(item.tags)) totals.set(tag, (totals.get(tag) ?? 0) + item.count);
 }
 if (!isDeepStrictEqual(Object.fromEntries(totals), inventory.tagCounts)) return observation;
 const compact = { ...inventory, tagCounts: 'sum items[].count for each tag in items[].tags' };
 return bytes(compact) < bytes(inventory) ? { ...observation, inventory: compact } : observation;
}

const ITEM_TAGS_NOTE = 'sum items[].count for each tag in itemTags[items[].itemId]';

/**
 * Item tags belong to the item type, like blockTags for blocks: list each itemId's tags once in observation.itemTags
 * instead of on every inventory and ground-item row. As its own section, itemTags stays out of a changes view while the
 * carried and nearby item types are unchanged, so a count change no longer resends every stack's tag list. Rows whose
 * itemId has differing tag lists keep their own tags.
 */
export function presentItemTags(observation) {
 if (!record(observation) || Object.hasOwn(observation, 'itemTags')) return observation;
 const inventoryRows = Array.isArray(observation.inventory?.items) ? observation.inventory.items : [];
 const groundRows = Array.isArray(observation.items) ? observation.items : [];
 const byId = new Map();
 for (const row of [...inventoryRows, ...groundRows]) {
  if (!record(row) || typeof row.itemId !== 'string' || !Array.isArray(row.tags) || row.tags.length === 0) continue;
  const encoded = JSON.stringify(row.tags);
  byId.set(row.itemId, byId.has(row.itemId) && byId.get(row.itemId) !== encoded ? null : encoded);
 }
 const itemTags = Object.fromEntries([...byId].filter(([, encoded]) => encoded !== null).sort(([a], [b]) => a.localeCompare(b)).map(([itemId, encoded]) => [itemId, JSON.parse(encoded)]));
 if (Object.keys(itemTags).length === 0) return observation;
 const strip = rows => rows.map(row => {
  if (!record(row) || !Object.hasOwn(itemTags, row.itemId) || !Array.isArray(row.tags)) return row;
  const { tags: _tags, ...rest } = row;
  return rest;
 });
 const result = { ...observation, itemTags };
 if (inventoryRows.length > 0) result.inventory = { ...observation.inventory, items: strip(inventoryRows),
  ...(observation.inventory.tagCounts === 'sum items[].count for each tag in items[].tags' ? { tagCounts: ITEM_TAGS_NOTE } : {}) };
 if (groundRows.length > 0) result.items = strip(groundRows);
 return result;
}

const INVENTORY_MENU = 'minecraft:inventory';
const EMPTY_ITEM = 'minecraft:air';

/**
 * Routine observations leave out two identity details a player reads only when handling a stack: each item's stack
 * fingerprint (expectedFingerprint for edit_book/menu_click) and the slot rows of the player's own inventory menu,
 * which repeat inventory.items under menu slot numbers. Both stay one inspect call away (item/inventory/menu pages
 * carry them), and a note in place says so. Container menus, a carried cursor stack and the menu identity are kept.
 */
export function presentRequestableInventoryDetail(observation) {
 if (!record(observation)) return observation;
 let result = observation;
 const items = observation.inventory?.items;
 if (Array.isArray(items) && items.some(item => record(item) && typeof item.fingerprint === 'string')) {
  result = { ...result, inventory: { ...observation.inventory,
   items: items.map(item => { if (!record(item) || typeof item.fingerprint !== 'string') return item; const { fingerprint: _fingerprint, ...rest } = item; return rest; }),
   fingerprints: 'omitted here; inspect section:"item" with slot, or section:"inventory", lists each stack fingerprint' } };
 }
 const menu = observation.interaction?.menu;
 if (record(menu) && menu.type === INVENTORY_MENU && Array.isArray(menu.slots)) {
  const { slots: _slots, offset: _offset, hasMore: _hasMore, cursor, ...identity } = menu;
  const carried = record(cursor) && cursor.itemId !== EMPTY_ITEM && cursor.count !== 0;
  result = { ...result, interaction: { ...observation.interaction, menu: { ...identity, ...(carried ? { cursor } : {}),
   slots: 'player inventory menu: rows repeat inventory.items; inspect section:"menu" pages its slots' } } };
 }
 return result;
}

/** True when the observation carries the compact heard section, which replaces raw sound perception events. */
export function hasHeardSection(observation) {
 return Array.isArray(observation?.heard) || Array.isArray(observation?.player?.heard);
}

/** Drops raw sound events from perception when heard already reports them; a no-op without heard. */
export function withoutHeardSoundEvents(perception, observation) {
 if (!hasHeardSection(observation) || !record(perception) || !Array.isArray(perception.events)) return perception;
 const events = perception.events.filter(event => event?.type !== 'sound');
 if (events.length === perception.events.length) return perception;
 return { ...perception, events, soundEventsInHeard: perception.events.length - events.length };
}

/** Applies withoutHeardSoundEvents to the observation-bearing parts of a tool result. */
export function presentHeardSounds(value) {
 if (!record(value)) return value;
 const strip = holder => record(holder) && record(holder.perception) ? { ...holder, perception: withoutHeardSoundEvents(holder.perception, holder) } : holder;
 let result = strip(value);
 if (record(result.observation)) result = { ...result, observation: strip(result.observation) };
 if (record(result.postAction?.observation)) result = { ...result, postAction: { ...result.postAction, observation: strip(result.postAction.observation) } };
 return result;
}

/** Compress only the JSON data line emitted by buildNativeEventInput. */
function partialHeader(now, previous) {
 const same = Object.keys(now).filter(key => key !== 'guard' && Object.hasOwn(previous, key) && bytes(now[key]) > bytes(key) && isDeepStrictEqual(now[key], previous[key]));
 if (same.length === 0) return null;
 const result = Object.fromEntries(Object.entries(now).filter(([key]) => !same.includes(key)));
 result.same = same;
 return result;
}

export function encodeNativeEventInput(input, views = null) {
 const separator = input.indexOf('\n');
 if (separator < 0) return input;
 const lineEnd = input.indexOf('\n', separator + 1);
 const end = lineEnd < 0 ? input.length : lineEnd;
 try {
  const raw = JSON.parse(input.slice(separator + 1, end));
  let value = presentEventReceipts(raw);
  const changed = value !== raw;
  if (!record(value) || typeof value.event !== 'string' || !record(value.observation)) {
   return changed ? `${input.slice(0, separator + 1)}${JSON.stringify(value)}${input.slice(end)}` : input;
  }
  const beforeAppearance = value;
  value = presentAppearanceWake(value);
  const appearanceChanged = value !== beforeAppearance;
  const beforeFlight = value.observation;
  value.observation = presentInventoryTagCounts(presentEyeFlightWake(value.observation));
  const flightChanged = value.observation !== beforeFlight;

  const projectedHud = record(value.hud);
  if (projectedHud) {
   // Independent sections use the same exact-view delta contract as running action distance and damage.
   // Keep the volatile body separate so movement cannot invalidate stable threat, sky, health or menu facts.
   value.observation = { ...value.hud, ...value.observation };
   delete value.hud;
  }
  const action = value.observation.currentAction;
  const projectedAction = record(action) && (Object.hasOwn(action, 'left') || Object.hasOwn(action, 'hurtWhileRunning'));
  if (projectedAction) {
   // Independently changing readings must not invalidate the stable authored action or each other.
   if (Object.hasOwn(action, 'left')) { value.observation.actionDistance = action.left; delete action.left; }
   if (Object.hasOwn(action, 'hurtWhileRunning')) { value.observation.hurtWhileRunning = action.hurtWhileRunning; delete action.hurtWhileRunning; }
  }
  if (value.event === 'player_death' || value.observation.player?.dead === true || value.observation.continuity?.phase === 'dead') views?.reset();
  else views?.observeEvent(value.observation);
  // Runtime delivery ownership suppresses repeated failures. Any owed wake may need its target.
  const retained = typeof views?.retainEventMetadata === 'function' ? views.retainEventMetadata(value,
   { keep: [...(isNewContextEventInput(input) ? ['now', 'situation', 'combat', 'progress'] : []),
    ...((value.conversation?.entries?.length ?? 0) > 0 || (value.conversation?.omittedEntries ?? 0) > 0 ? ['conversation'] : [])] }) : value;
  const eventView = typeof views?.prepareEvent === 'function' ? views.prepareEvent(retained) : retained;
  // Both fresh facts and changed sections must lead work and menu details, not merely the unencoded input.
  const { observation, observationView, goalNow, skillFits, danger, ...metadata } = eventView;
  // The goal counts and the danger glance are the wake's first lines, ahead of the fresh facts they summarise.
  const presented = projectedHud ? {
   ...(goalNow === undefined ? {} : { goalNow }),
   ...(skillFits === undefined ? {} : { skillFits }),
   ...(danger === undefined ? {} : { danger }),
   ...(observation === undefined ? {} : { observation }),
   ...(observationView === undefined ? {} : { observationView }),
   ...metadata,
  } : eventView;
  const rounded = roundModelNumbers(presented);
  const encoded = encodeModelFacts(rounded);
  return encoded === value && rounded === presented && !changed && !appearanceChanged && !flightChanged && !projectedHud && !projectedAction ? input : `${input.slice(0, separator + 1)}${JSON.stringify(encoded)}${input.slice(end)}`;
 } catch { return input; }
}

// Each historical envelope has its own private receipt identity. Keep it in provider
// bookkeeping, never model text. Raw q6 receipts already contain their canonical failure;
// remove duplicate transport fields using the same schema as ordinary tool replies.
function presentEventReceipts(value) {
 if (!record(value)) return value;
 let next = value;
 if (record(value.failure) && ['message', 'executionStarted', 'physicalAttempted', 'repeatedFailure'].some(key => Object.hasOwn(value, key))) next = withFailureSchema(value);
 if (Object.hasOwn(next, '_actionReceipt')) { next = { ...next }; delete next._actionReceipt; }
 for (const key of ['mergedEvents', 'results', 'receipts']) {
  if (!Array.isArray(next[key])) continue;
  const items = next[key].map(presentEventReceipts);
  if (items.some((item, index) => item !== next[key][index])) next = { ...next, [key]: items };
 }
 for (const key of ['program', 'result', 'lastResult', 'observation', 'postAction', 'status', 'current', 'replacedAction']) {
  const child = presentEventReceipts(next[key]);
  if (child !== next[key]) next = { ...next, [key]: child };
 }
 return next;
}
