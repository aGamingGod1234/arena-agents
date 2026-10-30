import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { ContextCarryOver } from '../src/context-carry-over.mjs';
import { composeContinuityHeader, unresolvedFailure } from '../src/continuity-header.mjs';

// Real samples from a recorded run: Nether start in diamond gear, death in lava, Overworld respawn, failed mining.
const fixture = JSON.parse(await readFile(new URL('./fixtures/continuity-s1-r7.json', import.meta.url), 'utf8'));
const [nether, death, respawn, failA, failB] = fixture.observations;
const goalSpec = { originalRequest: 'beat the game', predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true }, createdAtTick: 184, fingerprint: 'f'.repeat(64) };
const record = () => ({ agentId: 'agent-r7', currentGoal: 'beat the game', currentGoalSpec: goalSpec, goalRevision: 1 });
const intent = { step: 'rods', why: 'eyes of ender need blaze powder', via: 'fortress seen at 74,68,71', until: 'has 7 blaze rods', unless: 'gear lost or health under 8', next: 'check rods held after the fight' };
const operate = (views, r, value) => views.operate(r, normalizeMinecraftToolCall('taskPlan', value));
const wake = (r, views, model, observation) => {
	const encoded = encodeNativeEventInput(buildNativeEventInput(r, { event: 'observation', trigger: 'damage', observation, continuity: views.continuity(r) }), model);
	return decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n') + 1)));
};

test('plan reads mark steps the current gear already satisfies, and death reopens only what was carried', async () => {
	const views = new LiveTaskViews(), r = record();
	await views.observe(r, nether);
	// The run's own plan, as the preparation wrote it: gear first, though the agent already wears diamond.
	const steps = structuredClone(fixture.plan.steps).map(step => ({ ...step, status: 'pending' }));
	steps.push({ id: 'base', label: 'Respawn base', kind: 'world', status: 'pending', dependsOn: [], detail: 'Placed table',
		evidence: { itemIds: [], count: 1, dimension: 'minecraft:the_nether', x: 1, y: 70, z: 2, blockId: 'minecraft:crafting_table' }, check: null });
	await views.actionReceipt(r, { state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', actionType: 'place_block', actionId: 'place-1', goalRevision: 1, worldId: nether.world.worldId,
		dimension: 'minecraft:the_nether', arguments: { itemId: 'minecraft:crafting_table', x: 1, y: 70, z: 2 }, observedAtEpochMs: nether.observedAtEpochMs });
	const written = await operate(views, r, { operation: 'replace', plan: { steps } });
	assert.equal(written.checked.firstOpenAlreadySatisfied, 'gear', 'a plan whose first open step is already done is named on write');
	assert.ok(written.checked.alreadySatisfied.includes('gear'));
	assert.ok(written.checked.satisfied.includes('base'), 'placement credit from plan-drop still counts');
	assert.equal(written.checked.unverifiable, undefined, 'every step of this plan has a factual check');
	await views.observe(r, death);
	const read = await operate(views, r, { operation: 'read' });
	assert.deepEqual(read.checked.reopened, ['gear'], 'death reopens the carried gear');
	assert.ok(read.checked.satisfied.includes('base'), 'built infrastructure survives death');
	assert.equal(read.plan.steps.find(step => step.id === 'gear').status, 'lost');
});

test('death: the goal survives; loss is asserted only from a live sample, and the intent is never replaced', async () => {
	const views = new LiveTaskViews(), r = record();
	await views.observe(r, nether);
	await operate(views, r, { operation: 'replace', plan: { steps: fixture.plan.steps.map(step => ({ ...step, status: 'pending' })) } });
	const written = await operate(views, r, { operation: 'intent', intent });
	assert.equal(written.valid, 'supported');
	assert.match(views.continuity(r).intent, /^rods for eyes for stronghold for end for dragon: eyes of ender need blaze powder; via fortress seen at 74,68,71; until has 7 blaze rods; unless gear lost/);
	await views.observe(r, death);
	const dead = views.continuity(r);
	assert.equal(dead.valid, 'unchecked', 'a corpse confirms no loss');
	assert.equal(dead.since, 'died');
	await views.observe(r, respawn);
	const now = views.continuity(r);
	assert.equal(now.goal, undefined, 'the event goal field carries the goal');
	assert.equal(now.next, intent.next, 'the model still owns next');
	assert.equal(now.valid, 'contradicted: lost: gear', 'the live respawn sample shows the gear is gone');
	assert.equal(now.since, 'died; was in the_nether, now overworld');
	assert.equal(now.effect, 'died in the_nether');
	assert.match(now.plan, /^intent rods\[/);
});

test('validity: retained items and a placed station stay satisfied after death; unknown evidence is unchecked', async () => {
	const views = new LiveTaskViews(), r = { ...record(), currentGoal: 'iron pickaxe', currentGoalSpec: null };
	const at = 1_000;
	const sample = (items, extra = {}) => ({ ready: true, observedAtEpochMs: at, world: { worldId: 'w', dimension: 'minecraft:overworld' }, player: { dead: false, health: 20 }, inventory: { items }, ...extra });
	const evidence = { itemIds: [], count: 1, dimension: 'minecraft:overworld', x: 4, y: 64, z: 4, blockId: 'minecraft:crafting_table' };
	await views.observe(r, sample([{ itemId: 'minecraft:iron_ingot', count: 3 }]));
	await views.actionReceipt(r, { state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', actionType: 'place_block', actionId: 'place-table', goalRevision: 1, worldId: 'w', dimension: 'minecraft:overworld', arguments: { itemId: 'minecraft:crafting_table', x: 4, y: 64, z: 4 }, observedAtEpochMs: at });
	await operate(views, r, { operation: 'replace', plan: { steps: [
		{ id: 'table', label: 'Table', kind: 'world', status: 'pending', dependsOn: [], detail: '', evidence, check: null },
		{ id: 'iron', label: 'Iron', kind: 'inventory', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'has:minecraft:iron_ingot*3' },
		{ id: 'pick', label: 'Iron pickaxe', kind: 'inventory', status: 'pending', dependsOn: ['table', 'iron'], detail: '', evidence: null, check: 'tool:pickaxe:iron+' },
		{ id: 'celebrate', label: 'Tell Lucas', kind: 'manual', status: 'pending', dependsOn: ['pick'], detail: '', evidence: null, check: null },
	] } });
	await operate(views, r, { operation: 'intent', intent: { step: 'pick', why: 'goal item' } });
	assert.equal(views.continuity(r).valid, 'supported');
	await views.observe(r, { ready: false, player: { dead: true } });
	// keepInventory-style respawn: the ingots are still held and the table still stands.
	await views.observe(r, sample([{ itemId: 'minecraft:iron_ingot', count: 3 }], { observedAtEpochMs: at + 5_000 }));
	const after = views.continuity(r);
	assert.equal(after.valid, 'supported', 'nothing the checks can see was lost');
	assert.equal(after.since, 'died; still built: table');
	await operate(views, r, { operation: 'intent', intent: { step: 'celebrate', why: 'tell the player' } });
	assert.equal(views.continuity(r).valid, 'unchecked', 'a manual step has no evidence either way');
	await operate(views, r, { operation: 'intent', intent: { step: 'pick', why: 'goal item' } });
	await views.observe(r, { ...sample([]), continuity: { rememberedSections: ['inventory'] } });
	assert.equal(views.continuity(r).valid, 'unchecked', 'a remembered inventory cannot support or refute the step');
});

test('the plan line never selects a step: a complete or removed intent stays visible, and without intent no step leads', async () => {
	const views = new LiveTaskViews(), r = { ...record(), currentGoal: 'stone tools', currentGoalSpec: null };
	const sample = items => ({ ready: true, observedAtEpochMs: 2_000, world: { worldId: 'w', dimension: 'minecraft:overworld' }, player: { dead: false }, inventory: { items } });
	const step = (id, check, dependsOn = []) => ({ id, label: id, kind: 'inventory', status: 'pending', dependsOn, detail: '', evidence: null, check });
	const filler = Array.from({ length: 30 }, (_, index) => step(`spare_${index}`, `has:minecraft:stick*${index + 2}`));
	const steps = [step('wood', 'has:minecraft:oak_log*4'), step('iron', 'has:minecraft:iron_ingot*3'), ...filler];
	await views.observe(r, sample([]));
	await operate(views, r, { operation: 'replace', plan: { steps } });
	const unled = views.progress(r);
	assert.doesNotMatch(unled, /intent/);
	assert.match(unled, /^open wood\[howto:oak_log 0\/4\]; open iron\[howto:iron_ingot 0\/3\]; open spare_0\[howto:stick 0\/2\]/, 'without an intent every open step has the same form, in plan order');
	await operate(views, r, { operation: 'intent', intent: { step: 'wood', why: 'planks for a table', next: 'chop the visible oak' } });
	await views.observe(r, sample([{ itemId: 'minecraft:oak_log', count: 4 }]));
	const done = views.continuity(r);
	assert.match(done.plan, /^intent wood\[complete\]; open iron\[howto:iron_ingot 0\/3; @furnace missing<-raw_iron 0\/3 mine iron_ore needs stone_pickaxe\+ [^\]]*\]; open spare_0\[howto:/, 'the satisfied intent stays visible; iron is listed like every other open step, not chosen');
	assert.equal(done.next, 'chop the visible oak', 'next stays the model\'s own');
	assert.equal(done.valid, 'contradicted: wood is complete');
	assert.ok(Buffer.byteLength(done.plan) <= 260 + 362, 'budget holds with many steps; the first step chain has its own 360 B budget');
	await operate(views, r, { operation: 'replace', plan: { steps: steps.filter(row => row.id !== 'wood') } });
	assert.match(views.progress(r), /^intent wood\[not in plan\]; open iron/, 'a removed intent stays visible');
});

test('rotation: a fresh context gets the whole header; within a context only changed lines are sent', async () => {
	const views = new LiveTaskViews(), r = record(), model = new ModelObservationViews();
	await views.observe(r, respawn);
	await operate(views, r, { operation: 'intent', intent: { step: 'tools', why: 'gear was lost in lava', next: 'craft a table from these logs' } });
	const first = wake(r, views, model, respawn);
	assert.deepEqual(Object.keys(first).slice(0, 3), ['observation', 'observationView', 'event'], 'HUD observations lead ownership and working intent');
	assert.ok(Object.keys(first).indexOf('now') > Object.keys(first).indexOf('observation'));
	assert.equal(first.goalSpec.fingerprint, undefined);
	assert.equal(first.goalSpec.originalRequest, undefined, 'the request text is already the goal');
	await views.observe(r, failA);
	const second = wake(r, views, model, failA);
	assert.match(second.now.failure, /^break_block TARGET_NOT_VISIBLE: The requested block is not the exact block/);
	assert.deepEqual(second.now.same, ['intent', 'next', 'valid', 'options', 'sleep'], 'the intent\'s logs keep the same options line');
	await views.observe(r, failB);
	// The latest unresolved failure replaces the earlier one; nothing chooses what to do about it.
	assert.equal(wake(r, views, model, failB).now.failure, 'break_block TARGET_TOO_FAR: Block is out of reach');
	model.reset();
	const rotated = wake(r, views, model, failB);
	assert.equal(rotated.now.same, undefined);
	assert.equal(rotated.now.intent, 'tools: gear was lost in lava');
});

test('rotation then terminal replacement: the failed action keeps its exact handle in the wake and the carry-over', async () => {
	const views = new LiveTaskViews(), r = record();
	await views.observe(r, respawn);
	await views.observe(r, failA);
	await views.observe(r, failB);
	const raw = JSON.parse(buildNativeEventInput(r, { event: 'observation', trigger: 'damage', observation: failB, continuity: views.continuity(r) }).split('\n')[1]);
	assert.deepEqual(raw.observation.lastResult, { actionId: failB.lastResult.actionId }, 'the header states the failure; the observation keeps its handle');
	const carry = new ContextCarryOver();
	carry.rememberTool({ kind: 'action', actionType: 'break_block', arguments: { x: 1 } }, { state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE', actionId: failA.lastResult.actionId });
	carry.rememberTool({ kind: 'action', actionType: 'break_block', arguments: { x: 2 } }, { state: 'FAILED', reasonCode: 'TARGET_TOO_FAR', actionId: failB.lastResult.actionId });
	carry.rememberTool({ kind: 'start_action', actionType: 'move_to', arguments: {} }, { state: 'RUNNING', actionId: 'running-1' });
	const text = carry.text('Session refreshed to keep context small');
	assert.ok(text.includes(failB.lastResult.actionId), 'the newest finished action is still replaceable');
	assert.ok(!text.includes(failA.lastResult.actionId), 'older finished IDs are trimmed');
	assert.ok(text.includes('running-1'), 'a running action can still be cancelled');
	const replacement = normalizeMinecraftToolCall('replaceAction', { actionId: failB.lastResult.actionId, goalRevision: r.goalRevision, actionType: 'break_block', arguments: { x: 1, y: 2, z: 3, expectedBlockId: 'minecraft:stone' } });
	assert.equal(replacement.actionId, failB.lastResult.actionId);
});

test('an intent write is acknowledged compactly; the header is not repeated in the reply', async () => {
	const views = new LiveTaskViews(), r = record();
	await views.observe(r, nether);
	const reply = await operate(views, r, { operation: 'intent', intent });
	assert.deepEqual(reply, { state: 'SUCCEEDED', reasonCode: 'INTENT_SAVED', valid: 'unchecked' });
	const description = (await import('../src/native-minecraft-tools.mjs')).MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === 'taskPlan').description;
	assert.match(description, /only when your commitment changes/);
	assert.match(description, /replace at meaningful revisions/i);
});

test('plan change: an intent step that leaves the plan is flagged; intent survives a coordinator restart', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'continuity-'));
	try {
		const views = new LiveTaskViews({ directory }), r = record();
		await views.observe(r, nether);
		await operate(views, r, { operation: 'replace', plan: { steps: fixture.plan.steps.map(step => ({ ...step, status: 'pending' })) } });
		await operate(views, r, { operation: 'intent', intent });
		const replanned = fixture.plan.steps.filter(step => step.id !== 'rods').map(step => ({ ...step, status: 'pending', dependsOn: step.dependsOn.filter(id => id !== 'rods') }));
		await operate(views, r, { operation: 'replace', plan: { steps: replanned } });
		assert.match(views.continuity(r).valid, /rods left the plan/);
		await views.flush();
		const restarted = new LiveTaskViews({ directory });
		await restarted.observe(r, nether);
		assert.equal(restarted.continuity(r).next, intent.next);
		assert.match(restarted.continuity(r).valid, /rods left the plan/);
		assert.deepEqual(restarted.intent(r), { step: 'rods', next: intent.next });
		// Pending plan saves finish before the directory is removed.
		await restarted.flush();
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('without a model-authored intent the header names no intent or next step', () => {
	const now = composeContinuityHeader({ goal: 'beat the game', plan: fixture.plan, progress: 'open rods[unmet]', results: [failA.lastResult] });
	assert.equal(now.intent, undefined);
	assert.equal(now.next, undefined);
	assert.equal(now.valid, undefined);
	assert.equal(composeContinuityHeader({ goal: 'beat the game' }), null, 'nothing beyond the goal means no header');
	assert.throws(() => normalizeMinecraftToolCall('taskPlan', { operation: 'intent', intent: { step: 'rods' } }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	assert.equal(composeContinuityHeader({ goal: 'g', progress: 'p', orders: { active: ['eat_low'], lastFired: 'eat_low 12s ago' } }).orders, 'eat_low; last fired eat_low 12s ago');
});

test('an event built from an older sample states that sample\'s dimension; a restart while dead does not recount the death', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'continuity-dead-'));
	try {
		const views = new LiveTaskViews({ directory }), r = record();
		await views.observe(r, nether);
		await operate(views, r, { operation: 'intent', intent });
		await views.observe(r, respawn);
		assert.equal(views.continuity(r).since, 'was in the_nether, now overworld');
		assert.equal(views.continuity(r, { observation: nether }).since, undefined, 'a queued Nether wake does not claim the Overworld');
		await views.observe(r, death);
		assert.equal(views.continuity(r).since, 'died; was in the_nether, now overworld', 'a corpse sample is where the last live sample was');
		await views.flush();
		const restarted = new LiveTaskViews({ directory });
		// A dead sample that names the world loads the saved plan and must not count the same death again.
		await restarted.observe(r, { ...death, world: nether.world, continuity: { phase: 'dead' } });
		assert.equal(restarted.continuity(r).since, 'died');
		await restarted.observe(r, respawn);
		assert.equal(restarted.continuity(r).since, 'died; was in the_nether, now overworld');
		// Pending plan saves finish before the directory is removed.
		await restarted.flush();
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failure the running action already retries says so; another running type or the same action does not', () => {
	const failed = (id) => ({ actionId: id, actionType: 'navigate_to', state: 'FAILED', reasonCode: 'ACTION_TIMEOUT', message: 'Navigation timed out' });
	const results = [failed('nav-1'), failed('nav-2')];
	const header = (running) => composeContinuityHeader({ goal: 'g', results, running }).failure;
	assert.equal(header({ active: true, actionId: 'nav-3', actionType: 'navigate_to' }), 'navigate_to ACTION_TIMEOUT (2 of last 2): Navigation timed out; newer navigate_to running');
	assert.equal(header(null), 'navigate_to ACTION_TIMEOUT (2 of last 2): Navigation timed out');
	assert.equal(header({ active: true, actionId: 'fight-1', actionType: 'fight_target' }), header(null), 'a different running action does not answer the failure');
	assert.equal(header({ active: false, actionId: 'nav-3', actionType: 'navigate_to' }), header(null), 'a finished action is not running');
});

test('the retry fact needs one coherent moment: an evicted older observation or a finished action states none', async () => {
	const views = new LiveTaskViews(), r = record();
	const at = nether.observedAtEpochMs;
	const navigate = (n, state, reasonCode) => ({ present: true, actionId: `nav-${n}`, actionType: 'navigate_to', state, reasonCode, message: reasonCode });
	const sample = (offset, lastResult, running) => ({ ...structuredClone(nether), observedAtEpochMs: at + offset, lastResult,
		currentAction: running ? { active: true, actionId: running, actionType: 'navigate_to' } : { active: false } });
	const queued = sample(0, navigate(5, 'FAILED', 'ACTION_TIMEOUT'), 'nav-6');
	await views.observe(r, queued);
	assert.match(views.continuity(r, { observation: queued }).failure, /; newer navigate_to running$/, 'the failure and its running retry from one sample');
	await views.observe(r, sample(1000, navigate(6, 'SUCCEEDED', 'ARRIVED'), null));
	assert.doesNotMatch(views.continuity(r, { observation: queued }).failure, /newer/, 'a cached sample cannot call a finished action running');
	for (let n = 2; n <= 9; n++) await views.observe(r, sample(n * 1000, n === 9 ? navigate(11, 'FAILED', 'ON_FIRE') : navigate(6, 'SUCCEEDED', 'ARRIVED'), null));
	const evicted = views.continuity(r, { observation: queued }).failure;
	assert.match(evicted, /^navigate_to ON_FIRE/);
	assert.doesNotMatch(evicted, /newer/, 'an older observation outside the sample cache does not lend its running action to newer results');
	// A coherent sample whose running action already finished claims nothing either.
	assert.equal(composeContinuityHeader({ goal: 'g', results: [navigate(6, 'SUCCEEDED', 'ARRIVED'), navigate(11, 'FAILED', 'ON_FIRE')],
		running: { active: true, actionId: 'nav-6', actionType: 'navigate_to' } }).failure, 'navigate_to ON_FIRE: ON_FIRE');
});

test('validity takes a fact lifecycle since(mark) and a provenance annotation without rework', () => {
	const seen = [];
	const now = composeContinuityHeader({ goal: 'g', intent: { step: 'rods', why: 'eyes', deaths: 0 }, evidence: { inPlan: true, known: true, status: 'pending', lost: [], kept: ['base'], chain: [] },
		since: { deaths: 1, dimension: { from: 'minecraft:the_nether', to: 'minecraft:overworld' }, restarted: true },
		annotate: (intent, facts) => { seen.push(facts); return 'supported (seen 5s)'; } });
	assert.equal(now.since, 'died; still built: base; was in the_nether, now overworld; coordinator restarted');
	assert.equal(now.valid, 'supported (seen 5s)');
	assert.deepEqual(seen[0].since.dimension, { from: 'minecraft:the_nether', to: 'minecraft:overworld' });
	assert.deepEqual(seen[0].contradicted, []);
});

test('usable handles outlive the six-line window: reads after an action do not hide its ID', () => {
	const carry = new ContextCarryOver();
	carry.rememberTool({ kind: 'start_action', actionType: 'move_to', arguments: { x: 1 } }, { state: 'RUNNING', actionId: 'running-7' });
	carry.rememberTool({ kind: 'action', actionType: 'break_block', arguments: { x: 2 } }, { state: 'FAILED', reasonCode: 'TARGET_TOO_FAR', actionId: 'finished-8' });
	for (let index = 0; index < 6; index++) carry.rememberTool({ kind: 'inspect', target: index }, { state: 'SUCCEEDED' });
	const text = carry.text('Session refreshed to keep context small');
	assert.match(text, /- action:break_block -> FAILED TARGET_TOO_FAR \(actionId="finished-8"\)/);
	assert.match(text, /- start_action:move_to -> RUNNING \(actionId="running-7"\)/);
	assert.equal((text.match(/^- inspect/gm) ?? []).length, 6);
});

test('a death-inferred loss stays unchecked while the respawn sample cannot read it; a visited place is not something built', async () => {
	const views = new LiveTaskViews(), r = { ...record(), currentGoal: 'planks', currentGoalSpec: null };
	const sample = (at, inventory, dimension = 'minecraft:overworld') => ({ ready: true, observedAtEpochMs: at, world: { worldId: 'w', dimension }, player: { dead: false }, inventory });
	await views.observe(r, sample(1_000, { items: [{ itemId: 'minecraft:oak_log', count: 4 }], tagCounts: { '#minecraft:logs': 4 } }));
	await views.observe(r, sample(1_500, { items: [], tagCounts: {} }, 'minecraft:the_nether'));
	await views.observe(r, sample(1_800, { items: [{ itemId: 'minecraft:oak_log', count: 4 }], tagCounts: { '#minecraft:logs': 4 } }));
	await operate(views, r, { operation: 'replace', plan: { steps: [
		{ id: 'logs', label: 'Logs', kind: 'inventory', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'has:#minecraft:logs*4' },
		{ id: 'visit', label: 'Been to the Nether', kind: 'world', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'visited:minecraft:the_nether' },
		{ id: 'planks', label: 'Planks', kind: 'inventory', status: 'pending', dependsOn: ['logs', 'visit'], detail: '', evidence: null, check: 'has:minecraft:oak_planks*4' },
	] } });
	await operate(views, r, { operation: 'intent', intent: { step: 'planks', why: 'a table' } });
	assert.equal(views.continuity(r).valid, 'supported');
	await views.observe(r, { ready: false, player: { dead: true } });
	// The respawn sample has items but no tag counts: the logs requirement is unreadable, not disproved.
	await views.observe(r, sample(5_000, { items: [] }));
	const now = views.continuity(r);
	assert.match(now.plan, /unknown:#logs \?\/4/);
	assert.equal(now.valid, 'unchecked');
	assert.equal(now.since, 'died', 'a visited dimension is not reported as still built');
	await views.observe(r, sample(6_000, { items: [], tagCounts: {} }));
	assert.equal(views.continuity(r).valid, 'contradicted: lost: logs', 'readable and unmet confirms the loss');
});

test('evidence, progress and effects describe the delivered sample, not a newer one', async () => {
	const views = new LiveTaskViews(), r = { ...record(), currentGoal: 'wood', currentGoalSpec: null };
	const sample = (at, count) => ({ ready: true, observedAtEpochMs: at, world: { worldId: 'w', dimension: 'minecraft:overworld' }, player: { dead: false }, inventory: { items: count ? [{ itemId: 'minecraft:oak_log', count }] : [] } });
	const older = sample(1_000, 0);
	await views.observe(r, older);
	await operate(views, r, { operation: 'replace', plan: { steps: [{ id: 'wood', label: 'Wood', kind: 'inventory', status: 'pending', dependsOn: [], detail: '', evidence: null, check: 'has:minecraft:oak_log*4' }] } });
	await operate(views, r, { operation: 'intent', intent: { step: 'wood', why: 'planks' } });
	await views.observe(r, sample(2_000, 0));
	await views.observe(r, sample(3_000, 4));
	assert.equal(views.continuity(r).valid, 'contradicted: wood is complete');
	const queued = views.continuity(r, { observation: sample(2_000, 0) });
	assert.equal(queued.valid, 'supported', 'the older wake does not claim the newer completion');
	assert.match(queued.plan, /^intent wood\[howto:oak_log 0\/4\]/);
	assert.equal(queued.effect, undefined, 'the +4 oak_log effect came after that sample');
});

test('a lost world step is contradicted only by a different block seen at its cell now', async () => {
	const views = new LiveTaskViews(), r = { ...record(), currentGoal: 'pickaxe', currentGoalSpec: null };
	const evidence = { itemIds: [], count: 1, dimension: 'minecraft:overworld', x: 4, y: 64, z: 4, blockId: 'minecraft:crafting_table' };
	const sample = (at, blocks) => ({ ready: true, observedAtEpochMs: at, world: { worldId: 'w', dimension: 'minecraft:overworld' }, player: { dead: false }, inventory: { items: [] }, blocks });
	await views.observe(r, sample(1_000, [{ x: 4, y: 64, z: 4, blockId: 'minecraft:crafting_table' }]));
	await operate(views, r, { operation: 'replace', plan: { steps: [
		{ id: 'table', label: 'Table', kind: 'world', status: 'pending', dependsOn: [], detail: '', evidence, check: null },
		{ id: 'pick', label: 'Pickaxe', kind: 'inventory', status: 'pending', dependsOn: ['table'], detail: '', evidence: null, check: 'tool:pickaxe:wooden+' },
	] } });
	await operate(views, r, { operation: 'intent', intent: { step: 'pick', why: 'mine stone' } });
	// The table is seen gone, so the step is lost and the current sample confirms it.
	await views.observe(r, sample(2_000, [{ x: 4, y: 64, z: 4, blockId: 'minecraft:air' }]));
	assert.equal(views.continuity(r).valid, 'contradicted: lost: table');
	// Looking away: no block at the cell in this sample. The earlier sighting is not current evidence.
	await views.observe(r, sample(3_000, []));
	assert.equal(views.continuity(r).valid, 'unchecked');
});


test('the wake header states only known absence of a persistent guard', () => {
	assert.deepEqual(composeContinuityHeader({ goal: 'g', guardInstalled: false }), { guard: 'none installed' });
	assert.equal(composeContinuityHeader({ goal: 'g', guardInstalled: false, guardThreatsNear: 2, guardThreatsTargeting: 1 }).guard, 'none installed; threats near: 2, 1 targeting you');
	assert.equal(composeContinuityHeader({ goal: 'g', guardInstalled: false, guardThreatsNear: 1 }).guard, 'none installed; threats near: 1');
	assert.equal(composeContinuityHeader({ goal: 'g', guardInstalled: true, guardCoverage: 'g: installed, condition false, fired 0x', guardThreatsNear: true }).guard, 'g: installed, condition false, fired 0x');
	assert.equal(composeContinuityHeader({ goal: 'g', guardInstalled: true }), null);
	assert.equal(composeContinuityHeader({ goal: 'g' }), null);
	assert.equal(composeContinuityHeader({ goal: '', guardInstalled: false }), null);
});

test('recorded full-game route failures keep obstruction and drop evidence in the next wake', async () => {
 const cases = JSON.parse(await readFile(new URL('./fixtures/decision-eval/train/fullgame-route-repair.json', import.meta.url), 'utf8')).cases;
 for (const c of cases) {
  const views = new LiveTaskViews(), r = record();
  await views.observe(r, c.state.observation);
  const rendered = wake(r, views, new ModelObservationViews(), c.state.observation).now.failure;
  const obstruction = c.state.observation.lastResult.message.match(/Seen obstruction: [^;]+/)[0];
  assert.ok(rendered.includes(obstruction), c.id);
  if (c.state.observation.lastResult.message.includes('route unverified')) assert.match(rendered, /route unverified/);
  if (c.id === 'fullgame-route-repair-04') assert.match(rendered, /footing.*drop.*12/);
 }
});

test('placement repair survives wake summarization without losing its cause', () => {
 const text=unresolvedFailure([{actionId:'cast-wall',actionType:'place_block',state:'FAILED',reasonCode:'NO_PLACEMENT_SUPPORT',message:'cause=SUPPORT_FACE_HIDDEN; destination=113,65,696; requestedSupport=113,64,696; requestedFace=up; repair=move for a clear sightline to the support face (top faces need eyes above them), or use another visible face; neighbours=unobserved'}]).text;
 assert.match(text,/cause=SUPPORT_FACE_HIDDEN/);
 assert.match(text,/eyes above them/);
});
