import { isDeepStrictEqual } from 'node:util';
import { canonicalCall } from '../../src/decision-eval/predicates.mjs';
import { gradeSample } from '../../src/decision-eval/grade.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const reject = detail => { throw new Error(`hard-good must be closed-form: ${detail}; move open conditions to the judge rubric`); };

// Deliberately small grammar, not a parser for arbitrary production matchers.
// One total accepted call, an exact tool, and a complete action or ordered array.
// Finite alternatives may vary only count, with at most eight complete executions.
export function closedExecutions(predicate) {
 if (!keysAre(predicate, ['all']) || !Array.isArray(predicate.all) || predicate.all.length !== 2
  || !isDeepStrictEqual(predicate.all[0], { count: { min: 1, max: 1 } })) reject('require exactly one total call');
 const leaf = predicate.all[1];
 if (!keysAre(leaf, ['tool', 'normalized', 'args'])) reject('require an exact tool and normalized execution');
 const n = leaf.normalized;
 const sequence = leaf.tool === 'sequence';
 if (sequence) {
  if (!keysAre(n, ['kind', 'actions']) || n.kind !== 'sequence') reject('each sequence step must be explicit');
 } else if (leaf.tool !== 'act' || !keysAre(n, ['kind', 'actionType', 'arguments']) || n.kind !== 'action' || typeof n.actionType !== 'string') {
  reject('only exact act or sequence calls can be certified');
 }
 const matcher = sequence ? n.actions : n.arguments;
 // Bound raw presentation fields too: bad rules may inspect raw args. A bad
 // rule matching only an omitted view must not excuse a different good call.
 const rawMap = sequence
  ? { actions: matcher, finish: { exists: false }, view: { exists: false }, afterObservationId: { exists: false } }
  : { actionType: n.actionType, arguments: matcher, view: { exists: false }, afterObservationId: { exists: false } };
 if (!isDeepStrictEqual(leaf.args, rawMap)) reject('raw action arguments and optional presentation fields must be fixed');
 let alternatives;
 if (keysAre(matcher, ['eq'])) alternatives = [matcher.eq];
 else if (keysAre(matcher, ['in']) && Array.isArray(matcher.in) && matcher.in.length >= 1 && matcher.in.length <= 8) alternatives = matcher.in;
 else reject('use exact complete arguments or at most eight count alternatives');
 const countShape = execution => JSON.stringify(execution.map(step => ({ ...step, arguments: { ...step.arguments, ...(Object.hasOwn(step.arguments, 'count') ? { count: '<count>' } : {}) } })));
 let shape;
 return alternatives.map(value => {
  const steps = sequence ? value : [{ actionType: n.actionType, arguments: value }];
  if (!Array.isArray(steps) || steps.length < (sequence ? 2 : 1) || steps.length > 8) reject('invalid explicit sequence length');
  for (const step of steps) {
   if (!keysAre(step, ['actionType', 'arguments']) || typeof step.actionType !== 'string' || !object(step.arguments)) reject('unknown action shape');
   if (step.actionType === 'use_item' && typeof step.arguments.expectedItemId !== 'string') reject('item use requires an exact expectedItemId');
   // Action schema validation below owns required identifiers and argument types.
   // No nested matcher is interpreted here as an argument value.
   if (Object.hasOwn(step.arguments, 'count') && (!Number.isSafeInteger(step.arguments.count) || step.arguments.count < 1 || step.arguments.count > 64)) reject('count must be an exact legal integer');
  }
  const currentShape = countShape(steps);
  if (shape !== undefined && shape !== currentShape) reject('alternatives may vary only count, not items, targets, timing or order');
  shape = currentShape;
  const args = sequence ? { actions: steps } : steps[0];
  const call = canonicalCall({ tool: leaf.tool, args });
  if (call.normalizeError) reject(`invalid production action: ${call.normalizeError}`);
  if (!isDeepStrictEqual(call.actions, steps)) reject('arguments must include their exact production defaults');
  return call;
 });
}

export function validateClosedGoods(c, feasible) {
 const problems = [];
 for (const [index, predicate] of (c.expect.good ?? []).entries()) {
  let executions;
  try { executions = closedExecutions(predicate); }
  catch (error) { problems.push(`good[${index}] ${error.message}`); continue; }
  for (const call of executions) {
   // Use the production decision, including bad-before-good precedence. The
   // positive grammar has already bounded every execution this rule can accept.
   const grade = gradeSample(c, { calls: [call] });
   if (grade.verdict === 'bad') continue;
   if (grade.verdict !== 'good') { problems.push(`good[${index}] closed execution does not match its rule`); continue; }
   problems.push(...feasible(call.actions).map(p => `good[${index}] ${p}`));
  }
 }
 return problems;
}

export function exactGood(steps, tool = steps.length === 1 ? 'act' : 'sequence') {
 const matcher = { eq: tool === 'act' ? steps[0].arguments : steps };
 const normalized = tool === 'act'
  ? { kind: 'action', actionType: steps[0].actionType, arguments: matcher }
  : { kind: 'sequence', actions: matcher };
 const args = tool === 'act'
  ? { actionType: steps[0].actionType, arguments: matcher, view: { exists: false }, afterObservationId: { exists: false } }
  : { actions: matcher, finish: { exists: false }, view: { exists: false }, afterObservationId: { exists: false } };
 return { all: [{ count: { min: 1, max: 1 } }, { tool, normalized, args }] };
}
