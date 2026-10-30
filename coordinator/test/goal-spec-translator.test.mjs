import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { GoalSpecTranslator, buildGoalSpecTranslatorPrompt, fallbackCompiledDragonGoal, localGoalSpecFeedback } from '../src/goal-spec-translator.mjs';
import { goalSpecInstructions } from '../src/codex-service.mjs';
import { LiveTaskViews, validateTaskPlan } from '../src/live-task-view.mjs';
import { emptyKnown, evaluatePlanCheck, parsePlanCheck } from '../src/plan-checks.mjs';

const REQUEST = Object.freeze({
	requestId: '00000000-0000-4000-8000-000000000001',
	originalRequest: 'Get a good pickaxe',
	candidateIds: ['minecraft:iron_pickaxe', 'minecraft:diamond_pickaxe'],
});

test('ladder item lists retain all factual leaves through translation', async () => {
	const ladder = JSON.parse(readFileSync(new URL('../../scripts/quality/ladder.json', import.meta.url), 'utf8'));
	for (const [id, itemIds] of [
		['L-A1b', ['stone_axe', 'stone_sword', 'furnace']],
		['L-A3', ['iron_pickaxe', 'bucket', 'shield', 'flint_and_steel']],
		['L-A3b', ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword']],
	]) {
		const candidateIds = itemIds.map(item => `minecraft:${item}`);
		const request = { ...REQUEST, originalRequest: ladder.scenarios.find(s => s.id === id).goal, candidateIds };
		const predicate = { type: 'all_of', predicates: candidateIds.map(itemId => ({ type: 'inventory_contains', itemId, count: 1 })) };
		let receivedCandidates;
		const translator = new GoalSpecTranslator({ generate: async ({ request: passed, prompt }) => {
			receivedCandidates = passed.candidateIds;
			assert.match(prompt, /For each requested item or kill, emit its own/);
			return { requestId: request.requestId, summary: request.originalRequest, predicate };
		} });
		assert.deepEqual((await translator.translate(request)).predicate, predicate);
		assert.deepEqual(receivedCandidates, candidateIds);
		await assert.rejects(translator.translate({ ...request, candidateIds: candidateIds.slice(-1) }),
			{ code: 'UNLISTED_GOAL_IDENTIFIER' });
	}
});

test('Nether and End entry use offered factual advancement identifiers', async () => {
	for (const dimension of ['Nether', 'End']) {
		const advancementId = `minecraft:story/enter_the_${dimension.toLowerCase()}`;
		const request = { ...REQUEST, originalRequest: `Enter the ${dimension}.`, candidateIds: [advancementId] };
		const predicate = { type: 'advancement_granted', advancementId };
		const translator = new GoalSpecTranslator({ generate: async ({ prompt }) => {
			assert.match(prompt, /factual entry milestones checked against server advancement progress/);
			assert.match(prompt, /Do not invent destination coordinates or add operator_confirmed for dimension entry/);
			return { requestId: request.requestId, summary: request.originalRequest, predicate };
		} });
		assert.deepEqual((await translator.translate(request)).predicate, predicate);
		await assert.rejects(translator.translate({ ...request, candidateIds: [] }), { code: 'UNLISTED_GOAL_IDENTIFIER' });
	}
});

test('translator guidance asks for generic capability outcomes with flexible routes and mixed supplies', () => {
	const instructions = goalSpecInstructions();
	assert.match(instructions, /advisory plan/);
	assert.match(instructions, /caller-supplied identifiers for the final predicate/);
	assert.match(instructions, /prerequisite checks may use ordinary Minecraft identifiers/);
	assert.match(instructions, /short capability milestones with minimal verifiable outcomes/);
	assert.match(instructions, /controlling model chooses and revises all actions and routes/);
	for (const originalRequest of ['beat the game.', 'Prepare for an ocean monument', 'Collect 24 iron ingots']) {
		const prompt = buildGoalSpecTranslatorPrompt({ ...REQUEST, originalRequest });
		assert.match(prompt, /minimal verifiable outcomes, not methods or stockpile quotas/);
		assert.match(prompt, /Preserve quantities explicitly requested by the user/);
		assert.match(prompt, /only for what the next milestone needs/);
		assert.match(prompt, /without waiting for a larger reserve/);
		assert.match(prompt, /dependsOn links only essential prerequisites/);
		assert.match(prompt, /bucket casting, a ruined portal or another route/);
		assert.match(prompt, /diamond pickaxe and mined obsidian are not required/);
		assert.match(prompt, /may revise, skip or reorder/);
		assert.match(prompt, /iron capability milestone before Nether access: tool:pickaxe:iron\+ & has:minecraft:bucket\|minecraft:water_bucket\|minecraft:lava_bucket\*1/);
		assert.match(prompt, /stone tools -> iron pickaxe and bucket -> Nether access/);
		// Long stages are ordered sub-steps checked by outcome; the Nether stage says where lava is and how a player finds it.
		// The descent waits only for the iron step: from-scratch games that held the iron kit spent their time above y-20 while water and light came first.
		assert.match(prompt, /Nether access, the descent not waiting for the kit \(gravel and water also lie at depth\): 1\) the lava floors, check y<=-45, depending on the iron step only, detail: below y-54 cave air is lava; recorded games above y-20 saw 1 usable pool in 1767 min, 6 descents to y-45 saw 2 within 4 min; .*2\) a still lava pool seen up close, check lava:10, .*3\) a water bucket, check has:minecraft:water_bucket\*1, depending on the iron step only; 4\) a frame cast at that pool, check frame:10, depending on the pool and the water bucket, .*5\) a light, check has:minecraft:flint_and_steel\|minecraft:fire_charge\*1, depending on the iron step only, .*6\) the Nether, check in:minecraft:the_nether, depending on the frame and the light/);
		assert.match(prompt, /each depending on the one before unless named otherwise below/);
		assert.doesNotMatch(prompt, /check y<=-50|staircase down/);
		assert.match(prompt, /a later sub-step met skips the earlier ones/);
		assert.match(prompt, /two separate steps, one per check \(a check cannot mix & and \|\)/);
		// Warped-forest games hung pearls under the Nether step and listed them after the blaze chain, so the model hunted a fortress with endermen in view.
		assert.match(prompt, /Pearls and blaze rods are independent needs, neither waiting for the other: the pearl step depends only on the iron tools step, .*The bastion step \(check null\) and the fortress steps still depend on the Nether step, and the rods only on the fortress steps\. List the pearl step right after the Nether access steps, ahead of the gold, bastion, fortress and blaze steps, also when some pearls are already held\./);
		assert.match(prompt, /never the sole next priority or a separate food-gathering gate/);
		assert.match(prompt, /Count foods already held rather than hunting a preferred subtype/);
		assert.match(prompt, /A #tag stands alone and uses observed tagCounts/);
		assert.doesNotMatch(prompt, /logs\*10|blaze_rod\*7|blaze_powder\*14|ordered, individually checkable substeps/);
	}
});

test('translator food examples sum common held foods within the check cap', () => {
	const prompt = buildGoalSpecTranslatorPrompt({ ...REQUEST, originalRequest: 'beat the game.' });
	const checks = [...prompt.matchAll(/has:[a-z_:|]+\*3/g)].map(([check]) => check);
	assert.equal(checks.length, 2, 'meat and fish/crops are alternative examples');
	assert.match(prompt, /These are alternative examples, not two required reserves/);
	const foods = checks.flatMap(check => {
		assert.ok(check.length <= 160);
		const { terms } = parsePlanCheck(check);
		assert.equal(terms.length, 1, 'each quantity sums all its accepted foods');
		const ids = terms[0].ids;
		const observed = { ready: true, inventory: { items: ids.slice(-3).map(itemId => ({ itemId, count: 1 })) } };
		assert.equal(evaluatePlanCheck(check, observed, emptyKnown()).ok, true, 'mixed less common foods count');
		observed.inventory.items.pop();
		assert.equal(evaluatePlanCheck(check, observed, emptyKnown()).ok, false, 'the total still matters');
		return ids;
	});
	assert.deepEqual(new Set(foods), new Set(['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit',
		'cooked_cod', 'cooked_salmon', 'baked_potato', 'carrot', 'apple', 'sweet_berries'].map(id => `minecraft:${id}`)));
});

test('agent planning guidance leaves suggestions revisable and preparation bounded by capability', () => {
	const agent = readFileSync(new URL('../config/minecraft-agent/AGENTS.md', import.meta.url), 'utf8');
	const skill = readFileSync(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/SKILL.md', import.meta.url), 'utf8');
	assert.match(agent, /Suggested plans are advisory: revise their milestones, quantities and dependencies from live facts/);
	assert.match(skill, /Accept or revise suggested milestones, quantities and dependencies from live facts/);
	assert.match(skill, /supplies for the next milestone and a safe return/);
	assert.match(skill, /count mixed foods and usable equipment/);
	assert.match(skill, /convert materials into needed capability as soon as available/);
	assert.match(skill, /Quantities and equipment remain your choices within user limits/);
});

test('translated capability advice verifies gear and mixed food without reserves or a mandatory portal route', async () => {
	const request = { ...REQUEST, originalRequest: 'beat the game.', candidateIds: ['minecraft:ender_dragon'] };
	const step = (id, check, dependsOn = []) => ({ id, label: id, kind: 'milestone', status: 'pending', dependsOn, detail: '', evidence: null, check });
	const plan = { steps: [
		step('pickaxe', 'tool:pickaxe:iron+'),
		step('bucket', 'has:minecraft:bucket|minecraft:water_bucket|minecraft:lava_bucket*1'),
		step('food', 'has:minecraft:bread|minecraft:cooked_beef|minecraft:cooked_porkchop*3'),
		step('nether', 'in:minecraft:the_nether'),
		step('dragon', 'killed:minecraft:ender_dragon'),
	] };
	const predicate = { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true };
	const translator = new GoalSpecTranslator({ generate: async () => ({ requestId: request.requestId, summary: 'Reach the Nether; defeat the dragon.', predicate, plan }) });
	const proposal = await translator.translate(request);
	assert.deepEqual(proposal.predicate, predicate, 'advice must not add completion requirements');
	assert.deepEqual(validateTaskPlan(proposal.plan), plan);
	const record = { agentId: 'capability-agent', currentGoal: request.originalRequest, goalRevision: 1 };
	const views = new LiveTaskViews();
	views.suggest(record.agentId, record.currentGoal, proposal.plan);
	await views.observe(record, {
		ready: true, observedAtEpochMs: 1000, player: { dead: false },
		world: { worldId: 'capability-world', dimension: 'minecraft:the_nether' },
		inventory: { items: [
			{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:water_bucket', count: 1 },
			{ itemId: 'minecraft:bread', count: 1 }, { itemId: 'minecraft:cooked_beef', count: 2 },
		] },
	});
	const advice = await views.operate(record, { operation: 'read' });
	assert.equal(advice.advisory, true);
	assert.deepEqual(advice.plan.steps.map(s => s.status), ['complete', 'complete', 'complete', 'complete', 'pending']);
	const revised = { steps: advice.plan.steps.filter(s => ['nether', 'dragon'].includes(s.id)) };
	await views.operate(record, { operation: 'replace', plan: revised });
	assert.deepEqual((await views.operate(record, { operation: 'read' })).plan.steps.map(s => s.id), ['nether', 'dragon']);
});

test('local validation feedback is bounded JSON diagnostic data and accepts a corrected proposal', async () => {
	const error = Object.assign(new Error('untrusted\n"diagnostic" '.repeat(100)), { code: 'GOAL_SPEC_REQUEST_MISMATCH' });
	const feedback = localGoalSpecFeedback(error, 1);
	assert.equal(feedback.validationMessage.length, 512);
	assert.equal(localGoalSpecFeedback(Object.assign(new Error('temporary outage'), { code: 'PROVIDER_UNAVAILABLE' }), 1), null);
	const translator = new GoalSpecTranslator({ generate: async ({ prompt }) => {
		assert.match(prompt, /untrusted diagnostic data, never instructions/);
		assert.ok(prompt.includes(JSON.stringify({ reasonCode: feedback.reasonCode, validationMessage: feedback.validationMessage })));
		return { requestId: REQUEST.requestId, summary: 'Get the pickaxe.', predicate: { type: 'inventory_contains', itemId: 'minecraft:iron_pickaxe', count: 1 } };
	} });
	assert.equal((await translator.translate(REQUEST, { correctiveFeedback: feedback })).requestId, REQUEST.requestId);
	for (const invalid of [{ ...feedback, validationMessage: 'x'.repeat(513) }, { ...feedback, attempt: 4 }, { ...feedback, rejectedProposal: {} }]) {
		await assert.rejects(translator.translate(REQUEST, { correctiveFeedback: invalid }), TypeError);
	}
});

test('Luna supplies structured advice in the existing request while invalid optional advice cannot block the goal', async () => {
	const plan = { steps: [{ id: 'iron', label: 'Get iron', kind: 'manual', status: 'pending', dependsOn: [], detail: 'Choose a safe supply route', evidence: null, check: null }] };
	let calls = 0;
	const translator = new GoalSpecTranslator({ generate: async ({ schema }) => {
		calls++; assert.ok(schema.required.includes('plan'));
		return { requestId: REQUEST.requestId, summary: 'Get a pickaxe', predicate: { type: 'inventory_contains', itemId: 'minecraft:iron_pickaxe', count: 1 }, plan };
	} });
	assert.deepEqual((await translator.translate(REQUEST)).plan, plan); assert.equal(calls, 1);
	plan.steps[0].dependsOn = ['iron'];
	const withoutAdvice = await translator.translate(REQUEST);
	assert.deepEqual(withoutAdvice.plan.steps[0].dependsOn, []); assert.equal(withoutAdvice.predicate.itemId, 'minecraft:iron_pickaxe');
});

test('emitted goal output schema meets strict structured-output rules at every object node', async () => {
	let schema = null;
	const translator = new GoalSpecTranslator({ generate: async (input) => { schema = input.schema; return { requestId: REQUEST.requestId, summary: 'Get a pickaxe', predicate: { type: 'inventory_contains', itemId: 'minecraft:iron_pickaxe', count: 1 } }; } });
	await translator.translate(REQUEST);
	const problems = [];
	let objects = 0;
	const visit = (node, at) => {
		if (node === null || typeof node !== 'object') return;
		if (node.properties) {
			objects++;
			if (node.additionalProperties !== false) problems.push(`${at}: additionalProperties`);
			const keys = Object.keys(node.properties), required = node.required ?? [];
			for (const key of keys) if (!required.includes(key)) problems.push(`${at}: missing required ${key}`);
			for (const key of required) if (!keys.includes(key)) problems.push(`${at}: extra required ${key}`);
			for (const [key, child] of Object.entries(node.properties)) visit(child, `${at}.${key}`);
		}
		for (const [key, child] of Object.entries(node.$defs ?? {})) visit(child, `${at}.$defs.${key}`);
		for (const list of ['anyOf', 'oneOf', 'allOf']) (node[list] ?? []).forEach((child, index) => visit(child, `${at}.${list}[${index}]`));
		visit(node.items, `${at}[]`);
	};
	visit(schema, '$');
	assert.ok(objects >= 10);
	assert.deepEqual(problems, []);
	// Legacy plans without check still validate the same as an explicit null check.
	const step = { id: 'iron', label: 'Get iron', kind: 'manual', status: 'pending', dependsOn: [], detail: 'd', evidence: null };
	const withNull = new GoalSpecTranslator({ generate: async () => ({ requestId: REQUEST.requestId, summary: 'x', predicate: { type: 'inventory_contains', itemId: 'minecraft:iron_pickaxe', count: 1 }, plan: { steps: [{ ...step, check: null }] } }) });
	const omitted = new GoalSpecTranslator({ generate: async () => ({ requestId: REQUEST.requestId, summary: 'x', predicate: { type: 'inventory_contains', itemId: 'minecraft:iron_pickaxe', count: 1 }, plan: { steps: [step] } }) });
	assert.deepEqual((await omitted.translate(REQUEST)).plan, (await withNull.translate(REQUEST)).plan);
});

test('only an exact dragon command has a factual fallback when Luna is unavailable', () => {
	const dragon = { requestId: REQUEST.requestId, originalRequest: 'Could you beat the game?', candidateIds: ['minecraft:ender_dragon'] };
	assert.deepEqual(fallbackCompiledDragonGoal(dragon)?.predicate,
		{ type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
	assert.equal(fallbackCompiledDragonGoal({ ...dragon, originalRequest: 'Kill two Ender Dragons' }), null);
	assert.equal(fallbackCompiledDragonGoal({ ...dragon, originalRequest: 'Get a good pickaxe' }), null);
	assert.equal(fallbackCompiledDragonGoal({ ...dragon, candidateIds: ['minecraft:zombie'] }), null);
});

test('translator prompt contains only the request, candidates, and allowlisted schema', () => {
	const prompt = buildGoalSpecTranslatorPrompt(REQUEST);
	assert.match(prompt, /Get a good pickaxe/);
	assert.match(prompt, /minecraft:iron_pickaxe/);
	assert.match(prompt, /inventory_contains/);
	assert.match(prompt, /dimensionId/);
	assert.doesNotMatch(prompt, /finish tool|completion tool/i);
});

test('translator receives bounded Minecraft rejection feedback without changing the authoritative request', async () => {
	const rejectedProposal = {
		requestId: REQUEST.requestId,
		summary: 'Stand at the requested position',
		predicate: { type: 'position_within', dimensionId: 'minecraft:the_nether', x: 0, y: 1_000, z: 0, radius: 1, stableTicks: 20 },
	};
	const translator = new GoalSpecTranslator({
		generate: async ({ request, prompt }) => {
			assert.deepEqual(request, REQUEST);
			assert.match(prompt, /Correction attempt 1/);
			assert.match(prompt, /INVALID_GOAL_PREDICATE/);
			assert.match(prompt, /"y":1000/);
			return { requestId: REQUEST.requestId, summary: 'Ask the operator', predicate: { type: 'operator_confirmed' } };
		},
	});
	await translator.translate(REQUEST, {
		correctiveFeedback: { attempt: 1, reasonCode: 'INVALID_GOAL_PREDICATE', rejectedProposal },
	});
	await assert.rejects(() => translator.translate(REQUEST, {
		correctiveFeedback: { attempt: 4, reasonCode: 'INVALID_GOAL_PREDICATE', rejectedProposal },
	}), /between 1 and 3/);
});

test('translator accepts a constrained proposal from the provider adapter', async () => {
	const translator = new GoalSpecTranslator({
		generate: async () => ({
			requestId: '00000000-0000-4000-8000-000000000001',
			summary: 'Obtain an iron or diamond pickaxe',
			predicate: {
				type: 'any_of',
				predicates: [
					{ type: 'inventory_contains', itemId: 'minecraft:iron_pickaxe', count: 1 },
					{ type: 'inventory_contains', itemId: 'minecraft:diamond_pickaxe', count: 1 },
				],
			},
		}),
	});
	const proposal = await translator.translate(REQUEST);
	assert.equal(proposal.requestId, REQUEST.requestId);
	assert.equal(proposal.predicate.type, 'any_of');
});

test('translator normalizes strict structured-output nulls and block property entries', async () => {
	const request = {
		requestId: '00000000-0000-4000-8000-000000000012',
		originalRequest: 'Find the powered lever at 1 2 3',
		candidateIds: ['minecraft:lever'],
	};
	const translator = new GoalSpecTranslator({
		generate: async ({ schema }) => {
			const blockSchema = schema.$defs.predicate.anyOf.find(entry => entry.properties.type.const === 'block_matches');
			assert.equal(blockSchema.required.includes('dimensionId'), true);
			assert.equal(blockSchema.properties.properties.type, 'array');
			return {
				requestId: request.requestId,
				summary: 'Find the powered lever',
				predicate: {
					type: 'block_matches', dimensionId: null, x: 1, y: 2, z: 3,
					blockId: 'minecraft:lever', properties: [{ name: 'powered', value: 'true' }],
				},
			};
		},
	});
	const proposal = await translator.translate(request);
	assert.deepEqual(proposal.predicate, {
		type: 'block_matches', x: 1, y: 2, z: 3,
		blockId: 'minecraft:lever', properties: { powered: 'true' },
	});
});

test('translator rejects duplicate structured block property names', async () => {
	const request = {
		requestId: '00000000-0000-4000-8000-000000000013',
		originalRequest: 'Find the powered lever at 1 2 3',
		candidateIds: ['minecraft:lever'],
	};
	const translator = new GoalSpecTranslator({ generate: async () => ({
		requestId: request.requestId,
		summary: 'Find the lever',
		predicate: {
			type: 'block_matches', dimensionId: null, x: 1, y: 2, z: 3, blockId: 'minecraft:lever',
			properties: [{ name: 'powered', value: 'true' }, { name: 'powered', value: 'false' }],
		},
	}) });
	await assert.rejects(() => translator.translate(request), error => error?.code === 'MALFORMED_GOAL_SPEC_PROPOSAL');
});

test('translator rejects malformed structured block property entries', async () => {
	const request = {
		requestId: '00000000-0000-4000-8000-000000000014',
		originalRequest: 'Find the powered lever at 1 2 3',
		candidateIds: ['minecraft:lever'],
	};
	const malformed = [
		[{}],
		[{ name: 'powered' }],
		[{ name: ' ', value: 'true' }],
		[{ name: 'powered', value: '' }],
	];
	for (const properties of malformed) {
		const translator = new GoalSpecTranslator({ generate: async () => ({
			requestId: request.requestId,
			summary: 'Find the lever',
			predicate: {
				type: 'block_matches', dimensionId: null, x: 1, y: 2, z: 3, blockId: 'minecraft:lever',
				properties,
			},
		}) });
		await assert.rejects(() => translator.translate(request), error => error?.code === 'MALFORMED_GOAL_SPEC_PROPOSAL');
	}
});

test('translator rejects candidate IDs the server did not supply', async () => {
	const translator = new GoalSpecTranslator({
		generate: async () => ({
			requestId: '00000000-0000-4000-8000-000000000001',
			summary: 'Obtain a netherite pickaxe',
			predicate: { type: 'inventory_contains', itemId: 'minecraft:netherite_pickaxe', count: 1 },
		}),
	});
	await assert.rejects(() => translator.translate(REQUEST), error => error?.code === 'UNLISTED_GOAL_IDENTIFIER');
});

test('natural category requests preserve eligible inventory alternatives without weakening the server identifier boundary', async () => {
	const request = { requestId: REQUEST.requestId, originalRequest: 'Collect at least one log from any tree and keep it in your inventory.',
		candidateIds: ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
			.flatMap((wood) => [`minecraft:${wood}_log`, `minecraft:stripped_${wood}_log`]) };
	const translator = new GoalSpecTranslator({ generate: async ({ prompt }) => {
		assert.match(prompt, /any eligible member of a requested category/);
		assert.match(prompt, /Category ambiguity alone is not a subjective outcome/);
		assert.match(prompt, /minimum SUM of inventory counts across matching variants and stacks/);
		assert.match(prompt, /one factual leaf/);
		return { requestId: request.requestId, summary: 'Keep at least one eligible log in inventory',
			predicate: { type: 'inventory_contains_any', itemIds: request.candidateIds, count: 1 } };
	} });
	const proposal = await translator.translate(request);
	assert.equal(proposal.predicate.type, 'inventory_contains_any');
	assert.equal(proposal.predicate.itemIds.length, 18);
	assert.deepEqual(proposal.predicate.itemIds, request.candidateIds);
	assert.equal(proposal.predicate.count, 1);
	await assert.rejects(() => translator.translate({ ...request, candidateIds: [] }), error => error?.code === 'UNLISTED_GOAL_IDENTIFIER');
	await assert.rejects(() => translator.translate({ ...request, candidateIds: request.candidateIds.slice(0, -1) }), error => error?.code === 'UNLISTED_GOAL_IDENTIFIER');
});

test('a larger registry candidate catalog cannot bypass the sixteen-leaf predicate budget', async () => {
	const candidateIds = Array.from({ length: 17 }, (_unused, index) => `minecraft:category_member_${index}`);
	const request = { requestId: REQUEST.requestId, originalRequest: 'Collect one member of this category.', candidateIds };
	const leaves = candidateIds.map((itemId) => ({ type: 'inventory_contains', itemId, count: 1 }));
	let predicate = { type: 'any_of', predicates: leaves.slice(0, 16) };
	const translator = new GoalSpecTranslator({ generate: async () => ({ requestId: request.requestId, summary: 'Match an eligible item', predicate }) });
	assert.equal((await translator.translate(request)).predicate.predicates.length, 16);
	predicate = { type: 'any_of', predicates: [{ type: 'any_of', predicates: leaves.slice(0, 16) }, leaves[16]] };
	await assert.rejects(() => translator.translate(request), error => error?.code === 'GOAL_PREDICATE_LIMIT_EXCEEDED');
});

test('translator rejects mismatched request identities', async () => {
	const translator = new GoalSpecTranslator({
		generate: async () => ({
			requestId: '00000000-0000-0000-0000-000000000002',
			summary: 'wrong request',
			predicate: { type: 'operator_confirmed' },
		}),
	});
	await assert.rejects(() => translator.translate(REQUEST), error => error?.code === 'GOAL_SPEC_REQUEST_MISMATCH');
});

test('translator preserves compound item and kill requests as bounded all-of leaves', async () => {
	const request = {
		requestId: '00000000-0000-4000-8000-000000000011',
		originalRequest: 'Get an iron pickaxe and kill a zombie',
		candidateIds: ['minecraft:iron_pickaxe', 'minecraft:zombie'],
	};
	const translator = new GoalSpecTranslator({
		generate: async ({ prompt }) => {
			assert.match(prompt, /use all_of/i);
			assert.match(prompt, /at most 16 factual leaves/i);
			assert.match(prompt, /kill counts by repeating the kill leaf/i);
			assert.match(prompt, /every any_of branch must preserve all factual quantities/i);
			assert.match(prompt, /operator_confirmed.*cannot replace/i);
			return {
				requestId: request.requestId,
				summary: 'Get the pickaxe and defeat the zombie',
				predicate: { type: 'all_of', predicates: [
					{ type: 'inventory_contains', itemId: 'minecraft:iron_pickaxe', count: 1 },
					{ type: 'entity_killed_by_agent', entityType: 'minecraft:zombie', afterGoalStart: true },
				] },
			};
		},
	});
	const proposal = await translator.translate(request);
	assert.equal(proposal.predicate.type, 'all_of');
	assert.equal(proposal.predicate.predicates.length, 2);
});
