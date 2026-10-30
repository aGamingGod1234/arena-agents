import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoalSpecTranslator } from '../src/goal-spec-translator.mjs';
import { goalSpecTranslatorProfile } from '../src/agent-planner.mjs';
import { LiveTaskViews, validateTaskPlan } from '../src/live-task-view.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';

const goal = 'Beat the game by defeating the Ender Dragon';
const request = { requestId: '00000000-0000-4000-8000-000000000001', originalRequest: goal, candidateIds: ['minecraft:ender_dragon'] };
const record = { agentId: 'plan-detail', currentGoal: goal, goalRevision: 1, provider: 'codex', currentGoalSpec: { originalRequest: goal, fingerprint: 'dragon-task' } };
const step = (id, check, dependsOn = [], detail = '') => ({ id, label: id, check, dependsOn, detail, kind: check === null ? 'manual' : 'milestone', status: 'pending', evidence: null });
// A fake provider authors this route. Production code contains no scenario route.
const route = { steps: [
 step('iron_pickaxe', 'tool:pickaxe:iron+'),
 step('bucket_iron', 'has:minecraft:iron_ingot*3', ['iron_pickaxe']),
 step('bucket', 'has:minecraft:bucket*1', ['bucket_iron']),
 step('portal_supply', 'has:minecraft:obsidian*10', ['bucket']),
 step('nether', 'adv:minecraft:story/enter_the_nether', ['portal_supply']),
 step('rods', 'has:minecraft:blaze_rod*7', ['nether']),
 step('pearls', 'has:minecraft:ender_pearl*12', ['rods']),
 step('eyes', 'has:minecraft:ender_eye*12', ['pearls']),
 step('stronghold', 'seen:minecraft:stronghold', ['eyes']),
 step('end', 'in:minecraft:the_end', ['stronghold']),
 step('dragon', 'killed:minecraft:ender_dragon', ['end']),
] };
const observation = items => ({ ready: true, player: { dead: false }, world: { worldId: 'detail-world', dimension: 'minecraft:overworld' }, inventory: { items } });
const inventories = JSON.parse(await readFile(new URL('./fixtures/progress/desktop-inventories.json', import.meta.url), 'utf8'));

test('dragon request preserves provider-authored ordered checked substeps through the translator contract', async () => {
 let calls = 0;
 const translator = new GoalSpecTranslator({ generate: async ({ prompt, schema }) => {
  calls++;
  assert.match(prompt, /short plan of capability milestones/);
  assert.match(prompt, /minimal verifiable outcomes/);
  assert.match(prompt, /operator confirmation of the final goal does not prevent checked prerequisite steps/);
  assert.ok(schema.required.includes('plan'));
  assert.equal(schema.properties.plan.properties.steps.maxItems, 48);
  return JSON.stringify({ requestId: request.requestId, summary: 'Gather prerequisites; enter the End; defeat the dragon', predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true }, plan: route });
 } });
 const translated = await translator.translate(request);
 assert.deepEqual(translated.plan, validateTaskPlan(route));
 assert.equal(translated.plan.steps.filter(s => s.check !== null).length, 11);
 assert.equal(calls, 1);
 assert.equal(goalSpecTranslatorProfile(record, 'translator').model, 'gpt-6-sol');
});

for (const fixture of inventories) test(`next requirement is visible with captured inventory: ${fixture.name}`, async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, goal, route);
 const o = observation(fixture.items); await views.observe(record, o);
 const line = views.progress(record);
 assert.match(line, /^open iron_pickaxe\[unmet:pickaxe missing iron\+; iron_pickaxe 0\/1 @crafting_table\(held\)<-\(?iron_ingot 0\/3 @furnace\(held\)<-raw_iron 0\/3 mine iron_ore y-24\.\.56~16/);
 assert.ok(Buffer.byteLength(line) <= 240 + 362);
 const input = buildNativeEventInput(record, { trigger: 'start', observation: o, progress: line });
 assert.equal(JSON.parse(input.slice(input.indexOf('\n') + 1)).progress, line);
 await views.operate(record, { operation: 'replace', plan: { steps: [step('iron', 'has:minecraft:iron_ingot*3')] } });
 assert.equal(views.progress(record), 'open iron[howto:iron_ingot 0/3; @furnace(held)<-raw_iron 0/3 mine iron_ore y-24..56~16,80..319~232]; strategy:sourcing');
});

test('checked progress survives wakes, steering, context rotation and reload; death reopens lost equipment', async t => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'plan-detail-'));
 t.after(() => rm(directory, { recursive: true, force: true }));
 let views = new LiveTaskViews({ directory }); views.suggest(record.agentId, goal, route);
 const o = observation([{ itemId: 'minecraft:iron_pickaxe', count: 1 }]);
 await views.observe(record, o);
 const line = views.progress(record); assert.match(line, /^open bucket_iron\[howto:iron_ingot 0\/3/);
 await views.observe(record, o); assert.equal(views.progress(record), line);
 const steered = { ...record, goalRevision: 2, currentGoal: `${goal}; use safe paths` };
 views.begin(steered); await views.observe(steered, o); assert.equal(views.progress(steered), line);
 const rotated = { ...steered, model: 'gpt-6.1-sol', reasoningEffort: 'low' };
 await views.observe(rotated, o); assert.equal(views.progress(rotated), line); await views.flush();
 views = new LiveTaskViews({ directory }); await views.observe(rotated, o); assert.equal(views.progress(rotated), line);
 await views.observe(rotated, { ready: false, player: { dead: true } });
 assert.match(views.progress(rotated), /^open iron_pickaxe\[unmet:pickaxe missing iron\+(?:; lost at death ×1)?\]/);
 assert.equal(views.snapshot(rotated).plan.steps[0].status, 'lost'); await views.flush();
 views = new LiveTaskViews({ directory }); await views.observe(rotated, observation(inventories[1].items));
 assert.match(views.progress(rotated), /^open iron_pickaxe\[unmet:pickaxe missing iron\+(?:; lost at death ×1)?/);
 await views.flush();
});

test('unchecked pending and reported complete steps are explicitly unverified', async () => {
 const views = new LiveTaskViews(); await views.observe(record, observation(inventories[1].items));
 await views.operate(record, { operation: 'replace', plan: { steps: [step('gear', null, [], 'Gather 3 iron for the bucket')] } });
 assert.match(views.progress(record), /^open gear\[unverified:Gather 3 iron for the bucket\]/);
 const reported = { ...step('gear', null), status: 'complete' };
 await views.operate(record, { operation: 'replace', plan: { steps: [reported] } });
 assert.equal(views.progress(record), 'reported gear[unverified]');
});

test('unknown checks do not claim zero inventory or verified completion', async () => {
 const views = new LiveTaskViews(); await views.observe(record, observation([]));
 await views.operate(record, { operation: 'replace', plan: { steps: [step('iron', 'has:minecraft:iron_ingot*3')] } });
 await views.observe(record, { ready: false });
 assert.match(views.progress(record), /^open iron\[unknown:iron_ingot \?\/3\]/);
});

test('the next step survives a full budget of completed IDs and multibyte unchecked detail', async () => {
 const views = new LiveTaskViews(); await views.observe(record, observation([]));
 const done = Array.from({ length: 47 }, (_, i) => ({ ...step(`reported_${i}`, null), status: 'complete' }));
 const next = step('next_step', null, [], '获取铁'.repeat(60));
 await views.operate(record, { operation: 'replace', plan: { steps: [...done, next] } });
 const line = views.progress(record);
 assert.match(line, /^open next_step\[unverified:获取铁/);
 assert.ok(Buffer.byteLength(line) <= 240 + 362);
 assert.doesNotMatch(line, /\uFFFD/);
});

for (const [name, items, expected] of [
 ['wooden before stone', ['wooden_axe', 'stone_axe'], 'stone_axe'],
 ['golden before stone', ['golden_axe', 'stone_axe'], 'stone_axe'],
 ['stone before wooden', ['stone_axe', 'wooden_axe'], 'stone_axe'],
 ['copper after stone', ['wooden_axe', 'stone_axe', 'copper_axe'], 'copper_axe'],
 ['unrecognised tier', ['unknown_axe'], null],
 ['other tool kind', ['wooden_axe', 'netherite_pickaxe'], 'wooden_axe'],
]) test(`held tool hint uses the best relevant known tier: ${name}`, async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, goal, { steps: [step('pick', 'tool:axe:iron+')] });
 await views.observe(record, observation(items.map(item => ({ itemId: `minecraft:${item}`, count: 1 }))));
 const line = views.progress(record);
 if (expected) assert.match(line, new RegExp(`have:${expected}[;\\]]`));
 else assert.doesNotMatch(line, /have:/);
});

test('held pickaxes are left to the situation line, which already names the best one', async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, goal, { steps: [step('pick', 'tool:pickaxe:iron+')] });
 await views.observe(record, observation([{ itemId: 'minecraft:stone_pickaxe', count: 1 }]));
 assert.doesNotMatch(views.progress(record), /have:/);
});

test('held tool hint omits empty stacks, foreign items and dead-player inventory', async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, goal, { steps: [step('pick', 'tool:axe:iron+')] });
 const o = observation([{ itemId: 'minecraft:stone_axe', count: 0 }, { itemId: 'other:netherite_axe', count: 1 }]);
 await views.observe(record, o); assert.doesNotMatch(views.progress(record), /have:/);
 o.inventory.items = [{ itemId: 'minecraft:stone_axe', count: 1 }]; o.player.dead = true;
 await views.observe(record, o); assert.doesNotMatch(views.progress(record), /have:/);
});

test('parallel open steps use neutral wording without recommending an action', async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, goal, { steps: [step('iron', 'has:minecraft:iron_ingot*3'), step('food', 'has:minecraft:cooked_beef*5')] });
 await views.observe(record, observation([]));
 // Every open step carries the same facts; none is singled out as the next one.
 // Only the first open step carries its requirement chain; the other keeps its count.
 assert.match(views.progress(record), /^open iron\[howto:iron_ingot 0\/3; @furnace missing fuel none<-raw_iron 0\/3 mine iron_ore needs stone_pickaxe\+ [^\]]*\]; open food\[howto:cooked_beef 0\/5\]; strategy:sourcing$/);
});

test('alternative checks list every unmet threshold with an explicit or', async () => {
 const views = new LiveTaskViews(); views.suggest(record.agentId, goal, { steps: [step('rods', 'has:minecraft:blaze_rod*7 | has:minecraft:blaze_powder*14')] });
 const o = observation([{ itemId: 'minecraft:blaze_rod', count: 3 }, { itemId: 'minecraft:blaze_powder', count: 8 }]);
 await views.observe(record, o);
 assert.equal(views.progress(record), 'open rods[unmet:blaze_rod 3/7 or blaze_powder 8/14]');
 o.inventory.items[1].count = 14; await views.observe(record, o);
 assert.equal(views.progress(record), 'done rods');
});

test('translator names existing plan bounds and limits tags to the listed grammar', async () => {
 const translator = new GoalSpecTranslator({ generate: async ({ prompt }) => {
  assert.match(prompt, /at most 48 steps, 12 KiB/);
  assert.match(prompt, /A #tag stands alone and uses observed tagCounts/);
  return { requestId: request.requestId, summary: 'Defeat the dragon', predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true }, plan: route };
 } });
 assert.equal((await translator.translate(request)).plan.steps.length, 11);
});
