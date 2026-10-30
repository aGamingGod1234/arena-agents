import { gradeSample } from '../../src/decision-eval/grade.mjs';
import { ACTION_FIELDS, OPTIONAL_ACTION_FIELDS } from '../../src/constants.mjs';
import { minecraftCapabilities } from '../../src/native-minecraft-tools.mjs';
import { buildContext, canonicalCall, evaluatePredicate } from '../../src/decision-eval/predicates.mjs';

const LIMIT = minecraftCapabilities().limits.sequenceActions;
const control = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: 0, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 1 };
const defaults = {
 x: 0, y: 64, z: 0, tolerance: 1, sprint: false, ...control,
 timeoutMs: 5000, durationMs: 1000, drawDurationMs: 1000, distance: 3,
 mob: 'minecraft:zombie', untilItem: 'minecraft:rotten_flesh', untilCount: 1,
 frames: [control], maxTicks: 1, count: 1, expectedCount: 1,
 sourceKind: 'player', sourceSlot: 0, destinationKind: 'container', destinationSlot: 0,
 inventorySlot: 0, slot: 0, hotbarSlot: 0, targetSlot: 'offhand', minRemainingDurability: 0,
 operation: 'insert_input', face: 'up', opening: 'east', message: 'test', open: true, enabled: true,
 front: true, lines: ['', '', '', ''], expectedLines: ['', '', '', ''], pages: ['test'],
 expectedFingerprint: 'test', menuId: 'minecraft:inventory', containerId: 0, stateId: 0,
 primaryEffectId: 'minecraft:speed', secondaryEffectId: 'minecraft:regeneration',
 button: 0, buttonId: 0, clickType: 'PICKUP', name: 'test',
 targetId: '00000000-0000-0000-0000-000000000001', targetSelector: 'minecraft:item',
 itemId: 'minecraft:stone', expectedItemId: 'minecraft:stone', expectedBlockId: 'minecraft:stone', recipeId: 'minecraft:stick',
};

// Hints only enlarge the state-derived universe. They never decide whether a
// predicate matches, and contain no knowledge of matcher operators or dot paths.
function literals(value, numbers = new Set(), strings = new Set()) {
 if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 64) numbers.add(value);
 if (typeof value === 'string' && /^minecraft:[a-z_]+$/.test(value)) strings.add(value);
 if (value && typeof value === 'object') for (const child of Object.values(value)) literals(child, numbers, strings);
 return { numbers, strings };
}

export function candidateActions(c, recipes) {
 const o = c.state.observation;
 const hints = literals(c.expect.good);
 const ids = [...new Set([...(o.inventory?.items ?? []).map(i => i.itemId), ...Object.keys(recipes).map(id => `minecraft:${id}`), ...hints.strings, 'minecraft:diamond'])];
 const targets = [...new Set((o.entities ?? []).flatMap(e => [e.uuid, e.id, e.stableId, e.type]).filter(v => v !== undefined).map(String).concat(defaults.targetId))];
 const points = [o.position, ...(o.blocks ?? []), ...(o.landmarks ?? []), ...(o.entities ?? [])].filter(p => p && [p.x, p.y, p.z].every(Number.isFinite));
 const positions = [...new Map(points.map(p => [JSON.stringify([p.x, p.y, p.z].map(Math.floor)), Object.fromEntries(['x', 'y', 'z'].map(k => [k, Math.floor(p[k])]))])).values()];
 const counts = [...new Set([1, 2, 3, ...hints.numbers])];
 const actions = new Map();
 const add = (type, args) => {
  const call = canonicalCall({ tool: 'act', args: { actionType: type, arguments: args } });
  if (!call.normalizeError) {
   const action = call.actions[0];
   actions.set(JSON.stringify(action), action);
  }
 };
 for (const [type, fields] of Object.entries(ACTION_FIELDS)) {
  const args = Object.fromEntries(fields.filter(k => !(OPTIONAL_ACTION_FIELDS[type] ?? []).includes(k)).map(k => [k, defaults[k]]));
  if (fields.includes('x')) Object.assign(args, positions[0]);
  if (type === 'furnace_transaction') args.operation = 'take_output';
  // timeoutMs is optional only with untilDead:true; a single shot needs it.
  if (type === 'use_ranged') args.timeoutMs = defaults.timeoutMs;
  add(type, args);
  if (type === 'furnace_transaction') {
   const input = { ...args, inventorySlot: 0, count: 1, expectedItemId: 'minecraft:raw_iron' };
   add(type, { ...input, operation: 'insert_input' });
   add(type, { ...input, operation: 'insert_fuel', expectedItemId: 'minecraft:coal' });
   add(type, { ...input, operation: 'load', fuelSlot: 1, fuelCount: 1, expectedFuelItemId: 'minecraft:coal' });
  }
  for (const key of ['itemId', 'expectedItemId', 'expectedBlockId']) if (fields.includes(key)) for (const id of ids) add(type, { ...args, [key]: id });
  for (const key of ['targetId', 'targetSelector']) if (fields.includes(key)) for (const id of targets) add(type, { ...args, [key]: id });
  if (fields.includes('x')) for (const point of positions) add(type, { ...args, ...point });
  if (fields.includes('count')) for (const count of counts) add(type, { ...args, count });
  if (type.startsWith('craft_')) for (const [name, recipe] of Object.entries(recipes)) {
   const stock = Math.min(...recipe.inputs.map(([re, n]) => Math.floor((o.inventory?.items ?? []).filter(i => re.test(i.itemId)).reduce((sum, i) => sum + i.count, 0) / n)));
   const output = recipe.output ?? 1;
   // Include the material boundary and the first impossible craft even beyond the small count grid.
   const quantities = [...new Set([...counts, stock * output, stock * output + 1])].filter(n => n > 0 && n <= 64);
   const tables = type === 'craft_table' ? [positions[0], ...(o.blocks ?? []).concat(o.landmarks ?? []).filter(p => p.blockId === 'minecraft:crafting_table').map(p => ({ x: p.x, y: p.y, z: p.z }))] : [{}];
   for (const point of tables) for (const count of quantities) add(type, { ...args, ...point, recipeId: `minecraft:${name}`, count });
  }
 }
 const represented = new Set([...actions.values()].map(a => a.actionType));
 for (const type of Object.keys(ACTION_FIELDS)) if (!represented.has(type)) throw new Error(`universe lacks a production-valid ${type} candidate`);
 return [...actions.values()];
}

// Cover every tool-supported length, not a length inferred by parsing matchers.
// Every primitive is repeated and placed on either side of every canonical craft.
// All inventory craft pairs and select/use pairs are covered; longer sequences
// include their repetitions and wait-padded forms. This is deterministic bounded
// testing, not the exponential Cartesian product of every world coordinate.
export function* candidateSequences(actions) {
 const wait = actions.find(a => a.actionType === 'wait');
 const crafts = actions.filter(a => a.actionType === 'craft_inventory');
 const representatives = [...new Map(crafts.map(a => [a.arguments.recipeId, a])).values()];
 for (const action of actions) {
  yield [action];
  for (let length = 2; length <= LIMIT; length++) yield Array(length).fill(action);
 }
 const pairs = function* () {
  for (const a of crafts) for (const b of crafts) yield [a, b];
  for (const a of actions) for (const b of representatives) { yield [a, b]; yield [b, a]; }
  for (const a of actions.filter(a => a.actionType === 'select_item')) for (const b of actions.filter(a => a.actionType === 'use_item')) yield [a, b];
 };
 for (const pair of pairs()) {
  yield pair;
  for (let length = 3; length <= LIMIT; length++) {
   yield [...pair, ...Array(length - 2).fill(wait)];
   yield [...Array(length - 2).fill(wait), ...pair];
   yield Array.from({ length }, (_, i) => pair[i % 2]);
  }
 }
}

export function concreteCounterexample(c, recipes, feasibility) {
 const good = c.expect.good ?? [];
 const started = performance.now();
 const stats = { candidates: 0, accepted: 0, milliseconds: 0 };
 if (!good.length) return { problems: [], stats };
 const context = buildContext(c);
 const actions = candidateActions(c, recipes);
 for (const sequence of candidateSequences(actions)) {
  // Canonical primitives were normalized above. Sequences preserve those exact
  // action bytes in production; raw args are also provided for raw-path predicates.
  const single = sequence.length === 1;
  const args = single ? sequence[0] : { actions: sequence };
  const normalized = single ? { kind: 'action', ...sequence[0] } : { kind: 'sequence', actions: sequence };
  const call = { index: 0, step: 0, tool: single ? 'act' : 'sequence', args, normalized, actions: sequence, normalizeError: null };
  stats.candidates++;
  if (!good.some(p => evaluatePredicate(p, [call], context))) continue;
  // Re-normalize every matching candidate through the actual tool entry point.
  const actual = canonicalCall({ tool: call.tool, args });
  if (actual.normalizeError) throw new Error(`invalid universe candidate: ${actual.normalizeError}`);
  if (!good.some(p => evaluatePredicate(p, [actual], context))) throw new Error('candidate canonicalization changed predicate acceptance');
  if (gradeSample(c, { calls: [actual] }, context).verdict !== 'good') continue;
  stats.accepted++;
  const problems = feasibility(sequence);
  if (problems.length) {
   stats.milliseconds = performance.now() - started;
   return { problems: problems.map(p => `concrete accepted ${JSON.stringify(sequence)}: ${p}`), stats };
  }
 }
 stats.milliseconds = performance.now() - started;
 return { problems: [], stats };
}
