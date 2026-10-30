import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_FIELDS } from '../src/constants.mjs';
import { matchValue } from '../src/decision-eval/predicates.mjs';
import { validateClosedGoods, exactGood } from './helpers/closed-progression-good.mjs';
import { gradeSample } from '../src/decision-eval/grade.mjs';
import { candidateActions, concreteCounterexample } from './helpers/decision-sequence-universe.mjs';

// Expectation validators (q9 progression review r1). Rendering and provenance prove the recorded state; these prove
// the expectations are consistent with it, one check per class of mistake the review found:
//   1. a hard "good" predicate may only credit an action the recorded inventory, surroundings and recipes allow;
//   2. a rubric may only cite carried items the inventory holds;
//   3. a rubric's Good section may only offer actions of the case's own stage;
//   4. a rubric may not assert absence or geometry the view does not establish.
// DECISION_EVAL_FIXTURE_DIR points the checks at another train directory.

const trainDir = process.env.DECISION_EVAL_FIXTURE_DIR
	?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'decision-eval', 'train');
const cases = fs.readdirSync(trainDir).filter((name) => name.endsWith('.json')).sort()
	.flatMap((name) => JSON.parse(fs.readFileSync(path.join(trainDir, name), 'utf8')).cases);

const REACH = 4.5;
const EYE = 1.62;
// Recipes graded by the corpus: grid size and the carried inputs that make one craft possible.
const RECIPES = {
	iron_pickaxe: { grid: 3, inputs: [[/^minecraft:iron_ingot$/, 3], [/^minecraft:stick$/, 2]] },
	stone_pickaxe: { grid: 3, inputs: [[/^minecraft:(cobblestone|cobbled_deepslate|blackstone)$/, 3], [/^minecraft:stick$/, 2]] },
	wooden_pickaxe: { grid: 3, inputs: [[/_planks$/, 3], [/^minecraft:stick$/, 2]] },
	iron_sword: { grid: 3, inputs: [[/^minecraft:iron_ingot$/, 2], [/^minecraft:stick$/, 1]] },
	bucket: { grid: 3, inputs: [[/^minecraft:iron_ingot$/, 3]] },
	furnace: { grid: 3, inputs: [[/^minecraft:(cobblestone|cobbled_deepslate|blackstone)$/, 8]] },
	blaze_powder: { grid: 2, output: 2, inputs: [[/^minecraft:blaze_rod$/, 1]] },
	ender_eye: { grid: 2, inputs: [[/^minecraft:blaze_powder$/, 1], [/^minecraft:ender_pearl$/, 1]] },
	flint_and_steel: { grid: 2, inputs: [[/^minecraft:iron_ingot$/, 1], [/^minecraft:flint$/, 1]] },
	crafting_table: { grid: 2, inputs: [[/_planks$/, 4]] },
	stick: { grid: 2, output: 4, inputs: [[/_planks$/, 2]] },
};

const items = (o) => (o.inventory?.items ?? []).filter((i) => i.itemId !== 'minecraft:air' && i.count > 0);
const count = (o, re) => items(o).filter((i) => re.test(i.itemId)).reduce((n, i) => n + i.count, 0);
const held = (o) => items(o).find((i) => i.slot === 'mainhand')?.itemId ?? 'minecraft:air';
const tableInReach = (o) => [...(o.blocks ?? []), ...(o.landmarks ?? [])].some((b) => b.blockId === 'minecraft:crafting_table'
	&& Math.hypot(b.x + 0.5 - o.position.x, b.y + 0.5 - o.position.y - EYE, b.z + 0.5 - o.position.z) <= REACH);
const asList = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const regexOf = (m) => (typeof m === 'string' ? new RegExp(`^${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : m?.regex ? new RegExp(m.regex, m.flags) : m?.eq ? new RegExp(`^${m.eq}$`) : null);

// Enumerate against the production action vocabulary. Argument matchers need a finite
// positive bound; filtering that bound through matchValue preserves every conjunction/negation.
function concreteValues(matcher, domain) {
 if (domain) return domain.filter(value => matchValue(matcher, value));
 if (matcher === null || typeof matcher !== 'object') return [matcher];
 let bound;
 if (Object.hasOwn(matcher, 'eq')) bound = [matcher.eq];
 else if (matcher.in) bound = matcher.in;
 else if (matcher.allOf) {
  for (const part of matcher.allOf) {
   try { bound = concreteValues(part); break; } catch { /* another conjunct may bound it */ }
  }
 } else if (matcher.anyOf) bound = matcher.anyOf.flatMap(part => concreteValues(part));
 if (!bound) throw new Error('matcher is too open to enumerate; narrow it with eq or finite membership');
 return [...new Set(bound)].filter(value => matchValue(matcher, value));
}
const actionValues = matcher => concreteValues(matcher, Object.keys(ACTION_FIELDS));
function product(groups) {
 let rows = [[]];
 for (const values of groups) {
  if (rows.length * values.length > 4096) throw new Error('matcher combinations are too open to enumerate; narrow the predicate');
  rows = rows.flatMap(row => values.map(value => [...row, value]));
 }
 return rows;
}

// Conservatively check each positive branch. A negated sequence alone does not
// specify what will execute, so it must be rewritten with bounded positive alternatives.
function leaves(p, out = [], siblings = []) {
 if (!p || typeof p !== 'object') return out;
 const own = Object.fromEntries(Object.entries(p).filter(([key]) => !['any', 'all', 'not'].includes(key)));
 if (Object.keys(own).length) out.push({ leaf: own, siblings });
 if (Array.isArray(p.any)) for (const x of p.any) leaves(x, out, siblings);
 if (Array.isArray(p.all)) for (const x of p.all) leaves(x, out, [...siblings, ...p.all]);
 if (p.not && /actions\.|actionType/.test(JSON.stringify(p.not))) out.push({ leaf: { unboundedSequenceNegation: true }, siblings });
 return out;
}
// Normalized body actions a leaf credits. Each sequence branch is fully concrete.
function creditedActions(leaf) {
 if (leaf.unboundedSequenceNegation) throw new Error('negated action predicate is too open to enumerate; narrow it to positive alternatives');
 const out = [];
 for (const type of asList(leaf.action ?? leaf.firstAction)) out.push([type, leaf.actionArgs ?? leaf.firstActionArgs ?? {}]);
 const n = leaf.normalized ?? {};
 if (n.actionType) for (const type of actionValues(n.actionType)) out.push([type, Object.fromEntries(Object.entries(n).filter(([k]) => k.startsWith('arguments.')).map(([k, v]) => [k.slice(10), v]))]);
 const byIndex = new Map();
 for (const [k, v] of Object.entries(n)) { const m = /^actions\.(\d+)\.(actionType|arguments\.(.+))$/.exec(k); if (!m) continue; const e = byIndex.get(m[1]) ?? { args: {} }; if (m[2] === 'actionType') e.type = v; else e.args[m[3]] = v; byIndex.set(m[1], e); }
 if (!byIndex.size) return out;
 const ordered = [...byIndex].sort((a, b) => a[0] - b[0]);
 const types = ordered.map(([, step]) => actionValues(step.type ?? { exists: true }));
 // Existing movement predicates are geometric checks. Crafting sequences need a
 // complete state transition, including every alternative in preceding/following steps.
 const crafting = types.some(values => values.some(type => type.startsWith('craft_')));
 const alternatives = ordered.map(([index, step], i) => {
  const keys = Object.keys(step.args);
  const args = crafting ? product(keys.map(key => concreteValues(step.args[key]))).map(values => Object.fromEntries(keys.map((key, j) => [key, values[j]]))) : [step.args];
  return types[i].flatMap(type => args.map(args => ({ type, args, index: Number(index) })));
 });
 for (const sequence of product(alternatives)) for (const step of sequence) out.push([step.type, step.args, sequence]);
 return out;
}

// A declared sequence is checked in execution order. Unknown state-changing actions cannot be certified here.
function sequenceProblems(observation, steps) {
	const state = structuredClone(observation);
	for (const [index, step] of steps.entries()) {
		if (step.index !== index) return ['sequence has an unspecified preceding step'];
		const type = step.type?.eq ?? step.type;
		const args = Object.fromEntries(Object.entries(step.args).map(([key, value]) => [key, value?.eq ?? value]));
		if (Object.values(args).some(value => value !== null && typeof value === 'object')) return ['sequence arguments must be exact to establish state changes'];
		if (!['craft_inventory', 'craft_table', 'select_item', 'use_item', 'wait'].includes(type)) return [`sequence step ${index} has unsupported state changes: ${type}`];
		const errors = fastInfeasibleGoods({ state: { observation: state }, expect: { good: [{ action: [type], actionArgs: args }] } });
		if (errors.length) return errors.map(error => `sequence step ${index}: ${error}`);
		if (type.startsWith('craft_')) {
			const name = args.recipeId?.replace(/^minecraft:/, '');
			const recipe = RECIPES[name];
			if (!recipe) return [`sequence step ${index}: unknown recipe ${args.recipeId}`];
			const crafts = Math.ceil(args.count / (recipe.output ?? 1));
			for (const [input, perCraft] of recipe.inputs) {
				let remaining = perCraft * crafts;
				for (const item of items(state).filter(item => input.test(item.itemId))) {
					const used = Math.min(item.count, remaining); item.count -= used; remaining -= used;
				}
			}
			state.inventory.items.push({ itemId: `minecraft:${name}`, count: crafts * (recipe.output ?? 1), slot: -1 });
		} else if (type === 'select_item') {
			const selected = items(state).find(item => item.itemId === args.itemId);
			if (!selected) return [`sequence step ${index}: selected item is not carried`];
			for (const item of items(state)) if (item.slot === 'mainhand') item.slot = -1;
			selected.slot = 'mainhand';
		} else if (type === 'use_item') {
			if (held(state) !== 'minecraft:ender_eye') return [`sequence step ${index}: item-use effects are not established`];
			items(state).find(item => item.slot === 'mainhand').count--;
		}
	}
	return [];
}

/** Hard-good predicates that credit an action the recorded state cannot carry out. */
function fastInfeasibleGoods(c) {
	const o = c.state.observation;
	const problems = [];
	for (const [gi, g] of (c.expect.good ?? []).entries()) for (const { leaf, siblings } of leaves(g)) {
		let actions;
		try { actions = creditedActions(leaf); }
		catch (error) { problems.push(`good[${gi}] ${error.message}`); continue; }
		const sequences = [...new Set(actions.map(([, , group]) => group).filter(Boolean))];
		if (sequences.length && actions.some(([type]) => type === 'craft_inventory' || type === 'craft_table')) {
			for (const sequence of sequences) problems.push(...sequenceProblems(o, sequence).map(p => `good[${gi}] ${p}`));
			continue;
		}
		for (const [type, args, group = []] of actions) {
			if (type === 'craft_inventory' || type === 'craft_table') {
				const quantity = typeof args.count === 'number' ? args.count : args.count?.eq;
				if (!Number.isSafeInteger(quantity) || quantity <= 0) problems.push(`good[${gi}] does not bound crafting quantity to a feasible positive count`);
				const re = regexOf(args.recipeId);
				for (const [name, r] of Object.entries(RECIPES)) {
					if (re && !re.test(`minecraft:${name}`)) continue;
					if (type === 'craft_inventory' && r.grid === 3) problems.push(`good[${gi}] crafts ${name} in the 2x2 inventory grid`);
					// A table craft is possible at a table in reach, or after placing the carried table in the same call.
					const placesTable = count(o, /^minecraft:crafting_table$/) > 0 && [leaf, ...siblings].some((x) => JSON.stringify(x).includes('crafting_table') && /place/.test(JSON.stringify(x)));
					if (type === 'craft_table' && !tableInReach(o) && !placesTable) problems.push(`good[${gi}] crafts ${name} at a table, but no crafting table is in reach`);
					const crafts = Math.ceil((quantity || 1) / (r.output ?? 1));
					for (const [input, n] of r.inputs) if (count(o, input) < n * crafts) problems.push(`good[${gi}] crafts ${name} without ${n * crafts} ${input.source}`);
					if (type === 'craft_table' && ![...(o.blocks ?? []), ...(o.landmarks ?? [])].some(b => b.blockId === 'minecraft:crafting_table' && ['x', 'y', 'z'].every(k => (args[k]?.eq ?? args[k]) === b[k]))) problems.push(`good[${gi}] does not constrain the craft to a recorded table position`);
				}
			}
			if (type === 'use_ranged') {
				if (count(o, /^minecraft:(bow|crossbow)$/) === 0) problems.push(`good[${gi}] shoots without a bow or crossbow`);
				if (count(o, /^minecraft:(arrow|spectral_arrow|tipped_arrow)$/) === 0) problems.push(`good[${gi}] shoots without arrows`);
				if (held(o) !== 'minecraft:bow') problems.push(`good[${gi}] shoots without a held bow`);
			}
			if (type === 'use_item') {
				const want = regexOf(args.expectedItemId);
				const useIndex = group.findIndex(e => e.args === args);
				const selected = group.slice(0, useIndex).some((e) => e.type === 'select_item' && want && want.test(String(e.args.itemId ?? '')) && count(o, regexOf(e.args.itemId)) > 0);
				if (want && !want.test(held(o)) && !selected) problems.push(`good[${gi}] uses ${args.expectedItemId?.eq ?? args.expectedItemId} while ${held(o)} is held and nothing selects it first`);
			}
		}
		for (const id of asList(leaf.placesBlock)) if (typeof id === 'string' && count(o, regexOf(id)) === 0) problems.push(`good[${gi}] places ${id}, which is not carried`);
		for (const id of asList(leaf.usesItem)) {
			if (typeof id !== 'string') continue;
			if (count(o, regexOf(id)) === 0) problems.push(`good[${gi}] uses ${id}, which is not carried`);
			// usesItem also matches a bare selection or a use_item that keeps another held item: only worn gear and
			// food (eating selects it) are complete actions on their own.
			else if (id !== held(o) && !/_(helmet|chestplate|leggings|boots)$|^minecraft:shield$/.test(id) && !(o.inventory?.food && /cooked|bread|beef|porkchop|mutton|chicken|apple|carrot|potato|cod|salmon|melon|berries|kelp/.test(id))) problems.push(`good[${gi}] credits using ${id} while ${held(o)} is held`);
		}
		// A list of entity types means any of them: at least one must be in view.
		const targets = asList(leaf.targetsEntity).filter((t) => typeof t === 'string' && t !== 'minecraft:item');
		if (targets.length && !targets.some((t) => (o.entities ?? []).some((e) => e.type === t))) problems.push(`good[${gi}] targets ${targets.join(' or ')}, none of which is in view`);
	}
	return problems;
}

const PROGRESSION_FAMILIES = new Set(['progression-next-milestone', 'progression-efficiency', 'nether-fortress-search', 'blaze-fight', 'enderman-pearl-hunt', 'late-stage-next-step', 'transition-prep', 'eye-of-ender-stronghold', 'end-fight-basics']);
export function infeasibleGoods(c) {
 if (!PROGRESSION_FAMILIES.has(c.family)) return fastInfeasibleGoods(c);
 return validateClosedGoods(c, sequence => sequenceProblems(c.state.observation,
  sequence.map((a, index) => ({ type: a.actionType, args: a.arguments, index }))));
}

// Carried-item phrases a rubric uses and the inventory items that make them true.
const CARRIED_PHRASES = [
	['water bucket', /^minecraft:water_bucket$/], ['lava bucket', /^minecraft:lava_bucket$/], ['stone pickaxe', /^minecraft:stone_pickaxe$/],
	['iron pickaxe', /^minecraft:iron_pickaxe$/], ['diamond pickaxe', /^minecraft:diamond_pickaxe$/], ['bow', /^minecraft:bow$/],
	['flint and steel', /^minecraft:flint_and_steel$/], ['crafting table', /^minecraft:crafting_table$/], ['shield', /^minecraft:shield$/],
	['iron sword', /^minecraft:iron_sword$/], ['bed', /_bed$/],
];
/** Rubric statements that a carried item exists when the recorded inventory does not hold it. */
export function rubricItemContradictions(c) {
	const o = c.state.observation;
	const text = c.expect.judge?.rubric ?? '';
	const problems = [];
	for (const [phrase, re] of CARRIED_PHRASES) {
		const claim = new RegExp(`\\b(carried|carries|carrying|holding|with the|using the|held) ${phrase}\\b`, 'i');
		if (claim.test(text) && count(o, re) === 0) problems.push(`rubric says the player has a ${phrase}, but the inventory has none`);
	}
	const gained = /just gained a new milestone item \(([^)]+)\)/.exec(text)?.[1];
	if (gained) {
		const id = gained.replace(/ /g, '_');
		const re = { logs: /_(log|stem)$/, iron_armor: /^minecraft:iron_(helmet|chestplate|leggings|boots)$/, cooked_food: /^minecraft:(cooked_|bread|baked_potato|golden_carrot)/, bed: /_bed$/, bucket: /bucket$/, cobblestone: /^minecraft:(cobblestone|cobbled_deepslate|blackstone)$/, blaze_rod: /^minecraft:blaze_(rod|powder)$/ }[id] ?? new RegExp(`^minecraft:${id}$`);
		if (count(o, re) === 0) problems.push(`rubric says the milestone ${gained} was just gained, but it is not carried`);
	}
	return problems;
}

/** Good-section offers of actions from another stage (eye throws without eyes or eye ingredients). */
export function rubricStageContradictions(c) {
	const o = c.state.observation;
	const good = /Good: (.*?) Bad: /.exec(c.expect.judge?.rubric ?? '')?.[1] ?? '';
	const problems = [];
	const eyesPossible = count(o, /^minecraft:ender_eye$/) > 0 || (count(o, /^minecraft:(blaze_rod|blaze_powder)$/) > 0 && count(o, /^minecraft:ender_pearl$/) > 0);
	if (/throw(ing)? (an|one|the) eye|following (the|an) eye/i.test(good) && !eyesPossible) problems.push('Good offers throwing an eye of ender, but no eye or eye ingredients are carried');
	if (/stronghold/i.test(good) && !eyesPossible && o.world?.dimension !== 'minecraft:the_end') problems.push('Good offers heading for the stronghold without eyes to find it');
	const text = c.expect.judge?.rubric ?? '';
	if (/bow and arrows.{0,25}(essential|required)|essential.{0,25}bow and arrows/i.test(text)) problems.push('rubric requires a bow instead of allowing a viable no-bow route');
	if (/Bad:.*heading (for|toward) the stronghold now/i.test(text)) problems.push('rubric equates stronghold travel with unprepared End entry');
	if (/Bad: lighting or entering/i.test(text)) problems.push('rubric equates safe portal lighting with dimension entry');
	return problems;
}

/** Rubric claims of absence or geometry that the recorded view does not establish. */
export function rubricViewContradictions(c) {
	const o = c.state.observation;
	const text = c.expect.judge?.rubric ?? '';
	const problems = [];
	const entitiesComplete = o.coverage?.sections?.entities?.complete === true;
	if (!entitiesComplete && /\b(every|all)\b[^.]{0,40}\b(destroyed|gone|killed)\b/i.test(text)) problems.push('rubric asserts everything of a kind is gone, but the entity list is sampled');
	if (/head part/i.test(text) && !(o.entities ?? []).some((e) => /head/i.test(e.partName ?? ''))) problems.push('rubric relies on a head part the view does not list');
	if (/dragon is perched|to a perched dragon/i.test(text)) problems.push('rubric infers a perch without a represented phase or observed sequence');
	if (/\b(island|void) edge|\bthe edge\b/i.test(text) && !(o.blocks ?? []).some((b) => /air|void/.test(b.blockId))) problems.push('rubric grades the island edge, but the view shows no edge');
	return problems;
}

// Pre-existing q8 cases whose hard-good alternatives credit a shot with no bow or arrows carried, or a water bucket
// that is not carried. Reported to the corpus owner as follow-ups. Only these exact case diagnostics are exempt: any
// other diagnostic, in these cases or any other, fails, and a listed diagnostic that disappears must be removed here.
const WATER_NOT_CARRIED = ['good[1] uses minecraft:water_bucket, which is not carried'];
const SHOOTS_WITHOUT_BOW = (index) => [`good[${index}] shoots without a bow or crossbow`, `good[${index}] shoots without arrows`, `good[${index}] shoots without a held bow`];
const KNOWN_INFEASIBLE_GOODS = {
	};

// Existing q8 cases exposed by the new quantity/coordinate checks. Only these exact diagnostics are exempt;
// other errors in these cases and all new cases still fail. No legacy fixture is changed by this review fix.
const LEGACY_UNBOUNDED = new Set(['failed-interaction-retry-11', 'wrong-tool-01', 'wrong-tool-02', 'wrong-tool-03', 'wrong-tool-04', 'wrong-tool-05']);
const legacyBoundError = (c, message) => LEGACY_UNBOUNDED.has(c.id) && /does not bound crafting quantity|does not constrain the craft to a recorded table position/.test(message);

test('hard good predicates credit only actions the recorded inventory, surroundings and recipes allow', t => {
	const problems = cases.flatMap((c) => {
		const known = new Set(KNOWN_INFEASIBLE_GOODS[c.id] ?? []);
		return infeasibleGoods(c).filter(p => !legacyBoundError(c, p) && !known.has(p)).map((p) => `${c.id}: ${p}`);
	});
	assert.deepEqual(problems, []);
	for (const id of LEGACY_UNBOUNDED) assert.ok(cases.some(c => c.id === id && infeasibleGoods(c).some(p => legacyBoundError(c, p))), `${id}: remove resolved legacy debt`);
	for (const [id, diagnostics] of Object.entries(KNOWN_INFEASIBLE_GOODS)) {
		const current = cases.find((c) => c.id === id);
		assert.ok(current !== undefined, `${id} no longer exists: remove it from the known list`);
		const found = new Set(infeasibleGoods(current));
		for (const diagnostic of diagnostics) assert.ok(found.has(diagnostic), `${id} no longer reports "${diagnostic}": remove it from the known list`);
	}
});

test('rubrics cite only carried items the inventory holds and milestones still carried', () => {
	const problems = cases.flatMap((c) => rubricItemContradictions(c).map((p) => `${c.id}: ${p}`));
	assert.deepEqual(problems, []);
});

test('rubric Good sections offer only actions of the case\'s own stage', () => {
	const problems = cases.flatMap((c) => rubricStageContradictions(c).map((p) => `${c.id}: ${p}`));
	assert.deepEqual(problems, []);
});

test('rubrics assert no absence or geometry the view does not establish', () => {
	const problems = cases.flatMap((c) => rubricViewContradictions(c).map((p) => `${c.id}: ${p}`));
	assert.deepEqual(problems, []);
});

test('the validators catch each mistake the review found', () => {
	const obs = (inv, extra = {}) => ({ position: { x: 0, y: 64, z: 0 }, world: { dimension: 'minecraft:overworld' }, inventory: { items: inv.map(([itemId, count, slot]) => ({ itemId, count, slot })) }, entities: [], blocks: [], ...extra });
	const mk = (o, good, rubric = 'Goal: x. Good: g. Bad: b. Neutral: n.') => ({ id: 'synthetic', state: { observation: o }, expect: { good, judge: { rubric } } });
	const tools = obs([['minecraft:iron_pickaxe', 1, 'mainhand'], ['minecraft:iron_ingot', 3, 1], ['minecraft:stick', 2, 2], ['minecraft:blaze_rod', 7, 9], ['minecraft:ender_pearl', 12, 10], ['minecraft:ender_eye', 2, 11], ['minecraft:bucket', 1, 3]]);
	assert.match(infeasibleGoods(mk(tools, [{ action: ['craft_inventory', 'craft_table'], actionArgs: { recipeId: { regex: 'iron_pickaxe' } } }])).join(), /2x2 inventory grid/);
	assert.match(infeasibleGoods(mk(tools, [{ action: ['craft_table'], actionArgs: { recipeId: { regex: 'bucket' } } }])).join(), /no crafting table is in reach/);
	assert.match(infeasibleGoods(mk(tools, [{ action: ['craft_inventory'], actionArgs: { recipeId: { regex: 'ender_eye' } } }])).join(), /without 1/);
	assert.match(infeasibleGoods(mk({ ...tools, entities: [{ type: 'minecraft:blaze' }] }, [{ all: [{ action: ['use_ranged'] }, { targetsEntity: 'minecraft:blaze' }] }])).join(), /without a bow/);
	assert.match(infeasibleGoods(mk(tools, [{ usesItem: 'minecraft:ender_eye' }])).join(), /while minecraft:iron_pickaxe is held/);
	assert.deepEqual(infeasibleGoods(mk(tools, [{ normalized: { kind: 'sequence', 'actions.length': 2, 'actions.0.actionType': 'select_item', 'actions.0.arguments.itemId': 'minecraft:ender_eye', 'actions.1.actionType': 'use_item', 'actions.1.arguments.expectedItemId': 'minecraft:ender_eye' } }])), []);

 assert.deepEqual(infeasibleGoods(mk(tools, [{ normalized: { kind: 'action' }, action: ['craft_inventory'], actionArgs: { recipeId: 'minecraft:blaze_powder', count: 1 } }])), []);
 assert.match(infeasibleGoods(mk(tools, [{ action: ['craft_inventory'], actionArgs: { recipeId: 'minecraft:blaze_powder', count: 99 } }])).join(), /without/);
 assert.match(infeasibleGoods(mk(tools, [{ normalized: { 'actions.0.actionType': 'use_item', 'actions.0.arguments.expectedItemId': 'minecraft:ender_eye', 'actions.1.actionType': 'select_item', 'actions.1.arguments.itemId': 'minecraft:ender_eye' } }])).join(), /nothing selects it first/);
 assert.match(rubricItemContradictions(mk(tools, [], 'Goal: x. Make obsidian with the water bucket. Good: g. Bad: b. Neutral: n.')).join(), /water bucket/);
 assert.match(rubricItemContradictions(mk(obs([['minecraft:wooden_pickaxe', 1, 'mainhand']]), [], 'get iron ore with the carried stone pickaxe Good: g Bad: b Neutral: n')).join(), /stone pickaxe/);
 assert.match(rubricItemContradictions(mk(obs([['minecraft:bucket', 1, 'mainhand']]), [], 'The player just gained a new milestone item (iron ingot). Good: g Bad: b Neutral: n')).join(), /iron ingot was just gained/);
 assert.match(rubricStageContradictions(mk(obs([['minecraft:obsidian', 10, 1]]), [], 'Good: building the portal, throwing an eye, heading for the stronghold. Bad: b Neutral: n')).join(), /throwing an eye/);
 assert.match(rubricStageContradictions(mk(tools, [], 'A bow and arrows are essential. Good: gather. Bad: heading for the stronghold now. Neutral: look.')).join(), /requires a bow.*equates stronghold/);
 assert.match(rubricViewContradictions(mk(obs([], { coverage: { sections: { entities: { complete: false } } } }), [], 'Every end crystal is destroyed. Good: strike a reachable head part. Bad: walking toward the island edge. Neutral: n')).join(), /sampled/);
 assert.match(rubricViewContradictions(mk(tools, [], 'The dragon is perched. Good: hit it. Bad: arrows. Neutral: n.')).join(), /infers a perch/);
});

// Progression navigation, placement and combat need route/target geometry. These predicates alone cannot certify it.
export function unprovenGeometry(c) {
 return (c.expect.good ?? []).flatMap(g => leaves(g)).filter(({ leaf }) => leaf.approaches || leaf.placesBlock || leaf.targetsEntity || creditedActions(leaf).some(([type]) => ['navigate_to', 'move_to', 'fight_target', 'use_ranged', 'place_block', 'look_at'].includes(type))).map(() => 'hard good bypasses geometric assessment');
}

test('progression geometry-dependent choices stay with the rubric judge', () => {
 const progression = new Set(['progression-next-milestone', 'progression-efficiency', 'nether-fortress-search', 'blaze-fight', 'enderman-pearl-hunt', 'late-stage-next-step', 'transition-prep', 'eye-of-ender-stronghold', 'end-fight-basics']);
 assert.deepEqual(cases.filter(c => progression.has(c.family)).flatMap(c => unprovenGeometry(c).map(p => `${c.id}: ${p}`)), []);
 for (const good of [{ placesBlock: 'minecraft:obsidian' }, { approaches: { to: { x: 0, y: 64, z: 0 }, minDistance: 3 } }, { action: ['fight_target'] }]) assert.equal(unprovenGeometry({ expect: { good: [good] } }).length, 1);
});

test('craft sequence mutations debit ingredients, credit recipe yields and reject impossible order', () => {
 const source = id => structuredClone(cases.find(c => c.id === id));
 const predicate = steps => exactCraftPredicate(steps, 'craft_inventory');
 const mutate = (id, steps) => { const c = source(id); c.expect.good = [predicate(steps)]; return c; };
 const flint = 'minecraft:flint_and_steel', powder = 'minecraft:blaze_powder', eye = 'minecraft:ender_eye';
 assert.match(fastInfeasibleGoods(mutate('late-stage-next-step-06', [[flint, 1], [flint, 1]])).join(), /sequence step 1:.*without/);
 assert.match(fastInfeasibleGoods(mutate('late-stage-next-step-03', [[eye, 12], [powder, 1]])).join(), /sequence step 0:.*without/);
 assert.deepEqual(fastInfeasibleGoods(mutate('late-stage-next-step-03', [[powder, 14], [eye, 12]])), []);
 assert.deepEqual(fastInfeasibleGoods(mutate('late-stage-next-step-03', [[powder, 13], [eye, 12]])), [], 'round crafts up and credit all fourteen actual outputs');
 assert.match(fastInfeasibleGoods(mutate('late-stage-next-step-03', [[powder, 15]])).join(), /without 8/);
 assert.match(fastInfeasibleGoods(mutate('late-stage-next-step-03', [[powder, 14], [eye, 12], [powder, 1]])).join(), /sequence step 2:.*without/);
 const sticks = source('late-stage-next-step-03');
 sticks.state.observation.inventory.items = [{ itemId: 'minecraft:oak_planks', count: 2, slot: 'mainhand' }];
 sticks.expect.good = [predicate([['minecraft:stick', 4]])];
 assert.deepEqual(fastInfeasibleGoods(sticks), []);
 sticks.expect.good = [predicate([['minecraft:stick', 5]])];
 assert.match(fastInfeasibleGoods(sticks).join(), /without 4/);
 const single = source('late-stage-next-step-03'); single.expect.good = [{ normalized: { kind: 'action' }, action: ['craft_inventory'], actionArgs: { recipeId: powder, count: 14 } }];
 assert.deepEqual(fastInfeasibleGoods(single), [], 'single-craft bulk requests use the same output arithmetic');
});

test('fixture recipe yields agree with the production howto index', () => {
 const index = JSON.parse(fs.readFileSync(new URL('../config/howto-index.json', import.meta.url))).recipes;
 for (const [name, recipe] of Object.entries(RECIPES)) assert.equal(recipe.output ?? 1, index[name][0][1], name);
});

const CRAFT_MATCHERS = {
 literal: 'craft_inventory',
 eq: { eq: 'craft_inventory' },
 membership: { in: ['craft_inventory'] },
 regex: { regex: '^craft_inventory$' },
 anyOf: { anyOf: [{ eq: 'craft_inventory' }, { regex: '^craft_inventory$' }] },
 allOf: { allOf: [{ regex: '^craft_' }, { not: { eq: 'craft_table' } }] },
 not: { not: { not: { eq: 'craft_inventory' } } },
 combined: { anyOf: [{ allOf: [{ in: ['craft_inventory', 'craft_table'] }, { not: 'craft_table' }] }] },
};
function exactCraftPredicate(crafts, matcher) {
 const normalized = { kind: 'sequence', 'actions.length': Math.max(2, crafts.length), ...Object.fromEntries(crafts.flatMap(([recipe, count], i) => [
  [`actions.${i}.actionType`, matcher], [`actions.${i}.arguments.recipeId`, recipe],
  [`actions.${i}.arguments.count`, count], [`actions.${i}.arguments.timeoutMs`, 5000],
 ])) };
 if (crafts.length === 1) Object.assign(normalized, { 'actions.1.actionType': 'wait', 'actions.1.arguments.durationMs': 1000 });
 return { normalized };
}
function craftMutation(id, matcher, crafts) {
 const c = structuredClone(cases.find(c => c.id === id));
 c.expect.good = [exactCraftPredicate(crafts, matcher)];
 return c;
}
for (const [form, matcher] of Object.entries(CRAFT_MATCHERS)) test(`legacy matcher fast path normalizes ${form} action matchers`, () => {
 // Sol's exact two-craft case, plus a feasible multi-yield control for each syntax.
 const bad = craftMutation('late-stage-next-step-06', matcher, [['minecraft:flint_and_steel', 1], ['minecraft:flint_and_steel', 1]]);
 assert.equal(matchValue(matcher, 'craft_inventory'), true);
 assert.match(fastInfeasibleGoods(bad).join(), /sequence step 1:.*without/);
 const good = craftMutation('late-stage-next-step-03', matcher, [['minecraft:blaze_powder', 14], ['minecraft:ender_eye', 12]]);
 assert.deepEqual(fastInfeasibleGoods(good), []);
});

test('every matcher alternative gets an independent inventory simulation', () => {
 const c = craftMutation('late-stage-next-step-03', { in: ['craft_inventory', 'craft_table'] }, [['minecraft:blaze_powder', 14]]);
 assert.match(fastInfeasibleGoods(c).join(), /table/);
 c.expect.good[0].normalized['actions.0.actionType'] = CRAFT_MATCHERS.combined;
 c.expect.good[0].normalized['actions.0.arguments.count'] = { anyOf: [{ eq: 13 }, { in: [14] }] };
 assert.deepEqual(fastInfeasibleGoods(c), [], "branches must not consume each other's inputs");
 c.expect.good[0].normalized['actions.0.arguments.count'] = { in: [14, 15] };
 assert.match(fastInfeasibleGoods(c).join(), /without 8/);
 c.expect.good[0].normalized['actions.0.arguments.count'] = { allOf: [{ in: [14, 15] }, { not: 15 }] };
 assert.deepEqual(fastInfeasibleGoods(c), []);
 c.expect.good[0].normalized['actions.0.arguments.recipeId'] = { allOf: [{ in: ['minecraft:blaze_powder', 'minecraft:ender_eye'] }, { regex: 'powder$' }] };
 assert.deepEqual(fastInfeasibleGoods(c), []);
});

test('open sequence arguments and unsupported action alternatives require narrower predicates', () => {
 for (const matcher of [{ gte: 1 }, { regex: '.*' }, { not: 0 }, { anyOf: [{ eq: 1 }, { gte: 2 }] }]) {
  const c = craftMutation('late-stage-next-step-06', CRAFT_MATCHERS.eq, [['minecraft:flint_and_steel', matcher]]);
  assert.match(fastInfeasibleGoods(c).join(), /too open to enumerate; narrow/);
 }
 const c = craftMutation('late-stage-next-step-06', { regex: '.*' }, [['minecraft:flint_and_steel', 1]]);
 assert.match(fastInfeasibleGoods(c).join(), /unsupported state changes/);
});

test('predicate any/all/not cannot hide an infeasible sequence', () => {
 const c = craftMutation('late-stage-next-step-06', CRAFT_MATCHERS.eq, [['minecraft:flint_and_steel', 1], ['minecraft:flint_and_steel', 1]]);
 const bad = c.expect.good[0];
 for (const predicate of [{ any: [{ waits: true }, bad] }, { all: [{ count: { min: 1, max: 1 } }, bad] }, { ...bad, all: [{ bodyAction: true }] }, { not: { not: bad } }]) {
  c.expect.good = [predicate];
  assert.ok(fastInfeasibleGoods(c).length, JSON.stringify(predicate));
 }
});

const craftStep = (recipeId, count = 1) => ({ actionType: 'craft_inventory', arguments: { recipeId, count, timeoutMs: 5000 } });
const sequenceForms = {
 'whole-array equality': steps => ({ normalized: { kind: 'sequence', actions: { eq: steps } } }),
 'indexed-object equality': steps => ({ normalized: { kind: 'sequence', 'actions.length': steps.length, ...Object.fromEntries(steps.map((step, i) => [`actions.${i}`, { eq: step }])) } }),
 'wildcard paths': steps => ({ normalized: { kind: 'sequence', 'actions.length': steps.length, 'actions.*.actionType': 'craft_inventory', 'actions.*.arguments.recipeId': steps[0].arguments.recipeId, 'actions.*.arguments.count': 1 } }),
 'raw whole-array arguments': steps => ({ tool: 'sequence', args: { actions: { eq: steps } } }),
 'literal indexed objects': steps => ({ args: { 'actions.length': steps.length, ...Object.fromEntries(steps.map((step, i) => [`actions.${i}`, step])) } }),
 'nested Boolean whole arrays': steps => ({ all: [{ not: { normalized: { kind: 'action' } } }, { any: [{ args: { actions: { eq: steps } } }, { normalized: { actions: { in: [steps] } } }] }] }),
 'array contains and length': steps => ({ normalized: { kind: 'sequence', 'actions.length': steps.length, actions: { contains: { eq: steps[0] } } } }),
};
for (const [name, form] of Object.entries(sequenceForms)) test(`concrete production predicate search rejects ${name} double consumption`, () => {
 const c = structuredClone(cases.find(c => c.id === 'late-stage-next-step-06'));
 c.expect.bad = [];
 c.expect.good = [form([craftStep('minecraft:flint_and_steel'), craftStep('minecraft:flint_and_steel')])];
 // Invoke the concrete engine directly as well: no matcher-normalization rejection can satisfy this test.
 const result = concreteCounterexample(c, RECIPES, sequence => sequenceProblems(c.state.observation, sequence.map((a, index) => ({ type: a.actionType, args: a.arguments, index }))));
 assert.match(result.problems.join(), /sequence step 1:.*without/);
 assert.ok(result.stats.accepted > 0);
 assert.match(infeasibleGoods(c).join(), /closed-form/);
});

test('whole-array and indexed-object valid powder-to-eye chains pass concrete search', () => {
 for (const name of ['whole-array equality', 'indexed-object equality']) {
  const c = structuredClone(cases.find(c => c.id === 'late-stage-next-step-03'));
  c.expect.good = [sequenceForms[name]([craftStep('minecraft:blaze_powder', 14), craftStep('minecraft:ender_eye', 12)])];
  const result = concreteCounterexample(c, RECIPES, sequence => sequenceProblems(c.state.observation, sequence.map((a, index) => ({ type: a.actionType, args: a.arguments, index }))));
  assert.deepEqual(result.problems, []);
  assert.ok(result.stats.accepted > 0, 'a passing probe must exercise a matching concrete candidate');
 }
});

test('concrete universe covers tool actions, material boundaries and maximum sequence length', () => {
 const c = structuredClone(cases.find(c => c.id === 'late-stage-next-step-06'));
 const actions = candidateActions(c, RECIPES);
 assert.deepEqual([...new Set(actions.map(a => a.actionType))].sort(), Object.keys(ACTION_FIELDS).sort());
 assert.ok(actions.some(a => a.actionType === 'craft_inventory' && a.arguments.recipeId === 'minecraft:flint_and_steel' && a.arguments.count === 2));
 c.expect.good = [exactGood(Array(8).fill(craftStep('minecraft:flint_and_steel')))];
 assert.match(infeasibleGoods(c).join(), /sequence step 1:.*without/);
});

test('concrete search rejects unbounded tails after a feasible craft prefix', () => {
 const c = craftMutation('late-stage-next-step-03', 'craft_inventory', [['minecraft:blaze_powder', 14], ['minecraft:ender_eye', 12]]);
 delete c.expect.good[0].normalized['actions.length'];
 assert.match(infeasibleGoods(c).join(), /closed-form/);
});

test('secondary concrete search finds no production-good counterexample in progression cases', t => {
 const stats = { cases: 0, candidates: 0, accepted: 0, milliseconds: 0 };
 for (const c of cases.filter(c => PROGRESSION_FAMILIES.has(c.family))) {
  const result = concreteCounterexample(c, RECIPES, sequence => sequenceProblems(c.state.observation,
   sequence.map((a, index) => ({ type: a.actionType, args: a.arguments, index }))));
  assert.deepEqual(result.problems, [], c.id);
  stats.cases++;
  for (const key of ['candidates', 'accepted', 'milliseconds']) stats[key] += result.stats[key];
 }
 t.diagnostic(JSON.stringify(stats));
});

function progressionMutation(id = 'late-stage-next-step-06') {
 const c = structuredClone(cases.find(c => c.id === id));
 c.expect.bad = [];
 return c;
}
const reviewFlint = count => craftStep('minecraft:flint_and_steel', count);
const reviewWait = { actionType: 'wait', arguments: { durationMs: 1000 } };
const r5Variants = [
 ['timeout 5001', [{ ...reviewFlint(1), arguments: { ...reviewFlint(1).arguments, timeoutMs: 5001 } }, { ...reviewFlint(1), arguments: { ...reviewFlint(1).arguments, timeoutMs: 5001 } }]],
 ['craft wait craft order', [reviewFlint(1), reviewWait, reviewFlint(1)]],
 ['count four', [reviewFlint(4), reviewFlint(4)]],
 ['uncatalogued bread', [craftStep('minecraft:bread'), reviewWait]],
 ['unseen ranged target', [{ actionType: 'use_ranged', arguments: { targetId: '00000000-0000-0000-0000-000000000099', drawDurationMs: 1000, timeoutMs: 5000 } }]],
 ['uncarried item with digits', [{ actionType: 'select_item', arguments: { itemId: 'minecraft:music_disc_13' } }]],
];
for (const [name, steps] of r5Variants) test(`round 5 rejects ${name} both as an open rule and an explicit impossible execution`, () => {
 const c = progressionMutation();
 const calls = [{ tool: steps.length === 1 ? 'act' : 'sequence', args: steps.length === 1 ? steps[0] : { actions: steps } }];
 let open = steps.length === 1 ? { normalized: { kind: 'action', actionType: steps[0].actionType, arguments: { eq: steps[0].arguments } } }
  : { normalized: { kind: 'sequence', actions: { eq: steps } } };
 if (name === 'count four') open = { normalized: { kind: 'sequence', 'actions.length': 2, 'actions.*.actionType': 'craft_inventory', 'actions.*.arguments.recipeId': 'minecraft:flint_and_steel', 'actions.*.arguments.count': { gt: 3, lt: 5 } } };
 c.expect.good = [open];
 assert.equal(gradeSample(c, { calls }).verdict, 'good', 'the original bypass is a production hard-good');
 assert.match(infeasibleGoods(c).join(), /closed-form/);
 c.expect.good = [exactGood(steps)];
 assert.equal(gradeSample(c, { calls }).verdict, 'good');
 assert.match(infeasibleGoods(c).join(), /without|unknown recipe|unsupported state changes|not carried/);
});

test('round 5 rejects unbounded startAction and multiple-call trajectories', () => {
 const c = progressionMutation();
 c.expect.good = [{ tool: 'startAction', args: { actionType: 'craft_inventory', arguments: { eq: reviewFlint(2).arguments } } }];
 assert.equal(gradeSample(c, { calls: [{ tool: 'startAction', args: reviewFlint(2) }] }).verdict, 'good');
 assert.match(infeasibleGoods(c).join(), /closed-form/);
 c.expect.good = [{ all: [{ count: { min: 2, max: 2 } }, ...[0, 1].map(index => ({ index, normalized: { kind: 'action', arguments: { eq: reviewFlint(1).arguments } } }))] }];
 assert.equal(gradeSample(c, { calls: [0, 1].map(() => ({ tool: 'act', args: reviewFlint(1) })) }).verdict, 'good');
 assert.match(infeasibleGoods(c).join(), /closed-form/);
});

test('closed good rules accept feasible exact actions, orders and bounded count alternatives', () => {
 const c = progressionMutation('late-stage-next-step-03');
 const step = craftStep('minecraft:blaze_powder', 14);
 step.arguments.timeoutMs = 5001;
 c.expect.good = [exactGood([step])];
 assert.deepEqual(infeasibleGoods(c), []);
 c.expect.good = [exactGood([step, reviewWait, craftStep('minecraft:ender_eye', 12)])];
 assert.deepEqual(infeasibleGoods(c), []);
 c.expect.good = [exactGood([step])];
 const n = c.expect.good[0].all[1].normalized;
 n.arguments = { in: [13, 14].map(count => ({ ...step.arguments, count })) };
 c.expect.good[0].all[1].args.arguments = n.arguments;
 assert.deepEqual(infeasibleGoods(c), []);
 n.arguments.in.push({ ...step.arguments, count: 15 });
 assert.match(infeasibleGoods(c).join(), /without 8/);
 n.arguments = { in: [{ ...step.arguments }, { ...step.arguments, recipeId: 'minecraft:ender_eye' }] };
 c.expect.good[0].all[1].args.arguments = n.arguments;
 assert.match(infeasibleGoods(c).join(), /alternatives may vary only count/);
 n.arguments = { in: Array.from({ length: 9 }, (_, i) => ({ ...step.arguments, count: i + 1 })) };
 c.expect.good[0].all[1].args.arguments = n.arguments;
 assert.match(infeasibleGoods(c).join(), /at most eight/);
});

test('progression gate rejects open action matchers, item use without an exact item and unknown array shapes', () => {
 const c = progressionMutation();
 for (const matcher of Object.values(CRAFT_MATCHERS).filter(value => typeof value === 'object')) {
  c.expect.good = [exactGood([reviewFlint(1)])];
  c.expect.good[0].all[1].normalized.actionType = matcher;
  assert.match(infeasibleGoods(c).join(), /closed-form/);
 }
 c.expect.good = [exactGood([{ actionType: 'use_item', arguments: { durationMs: 1000 } }])];
 assert.match(infeasibleGoods(c).join(), /exact expectedItemId/);
 c.expect.good = [exactGood([reviewFlint(1), reviewWait])];
 c.expect.good[0].all[1].normalized.actions.eq = ['craft_inventory', {}];
 assert.match(infeasibleGoods(c).join(), /unknown action shape/);
});

test('bad-before-good precedence applies to the closed gate and secondary search', () => {
 const c = progressionMutation();
 const single = exactGood([reviewFlint(1)]), double = exactGood([reviewFlint(1), reviewFlint(1)]);
 c.expect.good = [single, double];
 c.expect.bad = [double];
 assert.equal(gradeSample(c, { calls: [{ tool: 'act', args: reviewFlint(1) }] }).verdict, 'good');
 assert.equal(gradeSample(c, { calls: [{ tool: 'sequence', args: { actions: [reviewFlint(1), reviewFlint(1)] } }] }).verdict, 'bad');
 assert.deepEqual(infeasibleGoods(c), []);
 const secondary = concreteCounterexample(c, RECIPES, sequence => sequenceProblems(c.state.observation,
  sequence.map((a, index) => ({ type: a.actionType, args: a.arguments, index }))));
 assert.deepEqual(secondary.problems, []);
 assert.equal(secondary.stats.accepted, 1);
 c.expect.bad = [];
 assert.match(infeasibleGoods(c).join(), /sequence step 1:.*without/);
});

test('closed rules bind presentation options before using raw bad-rule precedence', () => {
 const c = progressionMutation();
 const double = exactGood([reviewFlint(1), reviewFlint(1)]);
 c.expect.good = [double];
 c.expect.bad = [{ args: { view: { exists: false } } }];
 assert.deepEqual(infeasibleGoods(c), []);
 delete double.all[1].args.view;
 assert.match(infeasibleGoods(c).join(), /optional presentation fields must be fixed/);
});
