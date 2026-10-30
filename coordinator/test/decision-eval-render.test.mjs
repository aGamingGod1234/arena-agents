import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { AgentRegistry } from '../src/agent-registry.mjs';
import { MINECRAFT_DYNAMIC_TOOLS } from '../src/native-minecraft-tools.mjs';
import { ModelObservationViews, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { REPLAY_AGENT_ID, canonicalEncodedInput, renderPrefix, renderWake, replayAgentRecord } from '../src/decision-eval/render.mjs';
import { FakeBridge, FakePlanner, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

const replay = JSON.parse(await readFile(new URL('./fixtures/decision-eval/g1-replay-sample.json', import.meta.url), 'utf8'));
const NATIVE_CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-6-luna', reasoningEffort: 'low', serviceTier: 'fast' } } };

function g1Case(observation, extra = {}) {
	return {
		id: 'g1-sample', family: 'g1', causeClass: 'g1', split: 'train',
		state: { observation, agent: { goal: replay.goal, goalSpec: replay.goalSpec }, ...extra.state },
		expect: { good: [{ tool: 'moveTo' }] },
	};
}

/** What the stock coordinator test harness (real clock, fixture bridge) hands the provider for one recorded observation. */
async function liveCoordinatorInput(testCase) {
	const bridge = new FakeBridge();
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const inputs = [];
	planner.requestNativeTurn = async (request) => { inputs.push(typeof request.input === 'function' ? await request.input() : request.input); return new Promise(() => {}); };
	// Recorded G1 observations predate the default reflexes; the render replays them without, and so does this live run.
	const run = await start({ bridge, registry, planner, config: NATIVE_CONFIG, initialRegistry: [replayAgentRecord(testCase)], reflexDefaults: [] });
	try {
		bridge.emit('goal_control', { agentId: REPLAY_AGENT_ID, payload: { operation: 'start', goalRevision: 1, updatedAtEpochMs: testCase.state.observation.observedAtEpochMs, goal: testCase.state.agent.goal, goalSpec: testCase.state.agent.goalSpec } });
		bridge.emit('observation', { agentId: REPLAY_AGENT_ID, payload: { ...structuredClone(testCase.state.observation), goalRevision: 1 } });
		await eventually(() => inputs.length === 1);
		return inputs[0];
	} finally { await run.coordinator.stop(); }
}

test('a rendered wake is byte-identical to the live coordinator input for recorded G1 observations', async () => {
	for (const observation of replay.observations.slice(0, 3)) {
		const testCase = g1Case(observation);
		const rendered = await renderWake(testCase);
		const live = await liveCoordinatorInput(testCase);
		assert.equal(rendered.input, live, `observation ${observation.eventSequence}`);
		assert.equal(canonicalEncodedInput(rendered.encodedInput), canonicalEncodedInput(encodeNativeEventInput(live, new ModelObservationViews())));
		assert.equal(rendered.trigger, JSON.parse(live.slice(live.indexOf('\n') + 1)).trigger);
		assert.ok(rendered.encodedBytes < rendered.inputBytes, 'fresh-session encoding compacts the wake');
	}
});

test('rendering is deterministic and follows the recorded clock', async () => {
	const testCase = g1Case(replay.observations[4], { state: { previousObservations: replay.observations.slice(0, 4) } });
	const first = await renderWake(testCase);
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	const second = await renderWake(testCase);
	assert.equal(first.input, second.input);
	assert.equal(first.inputSha256, second.inputSha256);
	assert.deepEqual(first.replay, second.replay);
	assert.equal(JSON.parse(first.input.slice(first.input.indexOf('\n') + 1)).observation.observedAtEpochMs, replay.observations[4].observedAtEpochMs);
});

test('a case plan and intent reach the wake through the production taskPlan tool', async () => {
	const taskPlan = { steps: [
		{ id: 'logs', label: 'Get logs', kind: 'inventory', status: 'pending', dependsOn: [], detail: '', check: 'has:minecraft:oak_log*3', evidence: null },
		{ id: 'pick', label: 'Craft wooden pickaxe', kind: 'inventory', status: 'pending', dependsOn: ['logs'], detail: '', check: 'has:minecraft:wooden_pickaxe*1', evidence: null },
	] };
	const testCase = g1Case(replay.observations[4], { state: { previousObservations: replay.observations.slice(0, 4) } });
	testCase.state.agent = { ...testCase.state.agent, taskPlan, intent: { step: 'logs', why: 'planks for the pickaxe', next: 'pick' } };
	const rendered = await renderWake(testCase);
	const payload = JSON.parse(rendered.input.slice(rendered.input.indexOf('\n') + 1));
	assert.equal(payload.now.intent, 'logs for pick: planks for the pickaxe');
	assert.match(payload.now.plan, /^intent logs\[/);
	assert.deepEqual(rendered.replay.setupResults.map((row) => row.operation), ['replace', 'intent']);
	assert.equal(rendered.replay.setupResults[1].reasonCode, 'INTENT_SAVED');
	assert.equal(rendered.replay.setupResults[0].state, 'APPLIED', 'the replace outcome is reported, not null');
	assert.ok(rendered.replay.setupResults[0].steps > 0);
	// Without the plan the same observation still reports the absence of a guard.
	const plain = await renderWake(g1Case(replay.observations[4], { state: { previousObservations: replay.observations.slice(0, 4) } }));
	assert.deepEqual(JSON.parse(plain.input.slice(plain.input.indexOf('\n') + 1)).now, { guard: 'none installed' });
});

test('planning wakes expose dimension prerequisites and the station behind a ready recipe', async () => {
	const fixture = async (family) => (JSON.parse(await readFile(new URL(`./fixtures/decision-eval/train/${family}.json`, import.meta.url), 'utf8'))).cases[0];
	const wake = async (testCase) => {
		const rendered = await renderWake(testCase, { provider: 'codex', model: 'gpt-6.1-sol' });
		return JSON.parse(rendered.input.slice(rendered.input.indexOf('\n') + 1));
	};
	const eyes = await wake(await fixture('plan-prerequisite-gap'));
	assert.match(eyes.now.plan, /blaze_rod 0\/6 kill blaze the_nether\(unvisited\)/);
	assert.match(eyes.now.plan, /nether entry: obsidian 0\/10 needs diamond_pickaxe\+ or water on lava, flint_and_steel\|fire_charge 0\/1/);
	const pickaxe = await wake(await fixture('progression-next-milestone'));
	assert.match(pickaxe.now.plan, /iron_pickaxe 0\/1 @crafting_table\(held\) craft ready/);
	assert.equal(pickaxe.observation.inventory.items.find(item => item.itemId === 'minecraft:crafting_table').count, 1);
});

test('an action-result wake carries the failed result, plan, intent and the recorded death through production', async () => {
	const failed = { present: true, actionId: 'native:fidelity:break:1', actionType: 'break_block', state: 'FAILED', reasonCode: 'TARGET_TOO_FAR',
		message: 'Target block is 6.2 blocks away; reach is 4.5', elapsedMs: 40 };
	const withResult = (raw) => { const copy = structuredClone(raw); (copy.observation ?? copy).lastResult = failed; return copy; };
	const observations = [replay.observations[2], withResult(replay.observations[3]), withResult(replay.observations[4])];
	const world = (observations[2].observation ?? observations[2]).world;
	const testCase = g1Case(observations[2], { state: { previousObservations: observations.slice(0, 2) } });
	testCase.state.agent = { ...testCase.state.agent,
		taskPlan: { steps: [{ id: 'logs', label: 'Get logs', kind: 'inventory', status: 'pending', dependsOn: [], detail: '', check: 'has:minecraft:oak_log*3', evidence: null }] },
		intent: { step: 'logs', why: 'planks for the pickaxe' },
		recentResults: [{ tool: 'break_block', args: { x: 9, y: 70, z: 9 }, result: failed }],
		taskMemory: { worldId: world.worldId, dimension: world.dimension, deaths: [{ position: { x: 4, y: 64, z: -3 }, cause: 'ha_eval_agent was slain by Zombie', diedAtEpochMs: (observations[0].observation ?? observations[0]).observedAtEpochMs - 120_000,
			source: 'observed_death', lostInventory: { $rows: { columns: ['itemId', 'count'], rows: [['minecraft:stone_pickaxe', 1]] } } }],
		assets: [{ blockId: 'minecraft:crafting_table', position: { x: 2, y: 64, z: 1 }, source: 'observed_block', observedAtEpochMs: (observations[0].observation ?? observations[0]).observedAtEpochMs - 60_000 }] },
	};
	const rendered = await renderWake(testCase);
	const payload = JSON.parse(rendered.input.slice(rendered.input.indexOf('\n') + 1));
	assert.match(rendered.input, /TARGET_TOO_FAR/, 'the failed result reaches the wake');
	assert.equal(payload.now.intent, 'logs: planks for the pickaxe');
	assert.match(payload.now.plan, /logs/);
	assert.match(JSON.stringify(payload.taskMemory.deaths), /slain by Zombie/, 'the recorded death is in task memory');
	assert.match(JSON.stringify(payload.taskMemory.deaths), /stone_pickaxe/, 'with its lost inventory');
	assert.match(JSON.stringify(payload.taskMemory.assets), /crafting_table/);
	assert.deepEqual(rendered.replay.recentResults, { supplied: 1, replayed: 1, unreplayed: 0 });
	assert.deepEqual(rendered.replay.unreplayed, [], 'everything supplied was replayed');
	// A result older than the replayed observations is reported, never silently dropped.
	const older = structuredClone(testCase);
	older.state.agent.recentResults.unshift({ tool: 'move_to', args: {}, result: { actionId: 'native:fidelity:older:0', state: 'SUCCEEDED' } });
	assert.deepEqual((await renderWake(older)).replay.unreplayed, ['recentResults: 1 of 2 older than the replayed observations']);
});

test('recorded model-authored task memory reaches the wake through the production taskMemory tool', async () => {
	const testCase = g1Case(replay.observations[4], { state: { previousObservations: replay.observations.slice(0, 4) } });
	testCase.state.agent = { ...testCase.state.agent, taskMemory: {
		places: [{ kind: 'place', key: 'base_table', label: 'Crafting table', position: { x: 4, y: 64, z: -3 }, summary: 'Placed table by the oak grove.', source: 'model_authored', historical: true }],
		lessons: [{ kind: 'lesson', key: 'lava_cave', label: 'Lava in the cave', summary: 'The east cave has open lava at y 12.', source: 'model_authored' }],
		deaths: [{ kind: 'death', summary: 'fell', source: 'observed_death' }],
	} };
	const rendered = await renderWake(testCase);
	const payload = JSON.parse(rendered.input.slice(rendered.input.indexOf('\n') + 1));
	assert.deepEqual(payload.taskMemory.places.map((entry) => entry.key), ['base_table']);
	assert.deepEqual(payload.taskMemory.lessons.map((entry) => entry.key), ['lava_cave']);
	assert.deepEqual(rendered.replay.taskMemory, { written: 2, skipped: 0, notReplayed: 1, observedSeeded: 0 }, 'a death without its world cannot be seeded and is reported');
	assert.ok(rendered.replay.setupResults.every((row) => row.operation !== 'remember' || row.reasonCode === 'TASK_MEMORY_WRITTEN'));
});

test('a plan the build rejects is reported as invalid case state', async () => {
	const testCase = g1Case(replay.observations[0]);
	testCase.state.agent.taskPlan = { steps: [{ id: 'x', label: 'x', kind: 'inventory', status: 'pending', dependsOn: [], detail: '', check: 'has:#logs*3', evidence: null }] };
	await assert.rejects(renderWake(testCase), (error) => error.code === 'INVALID_CASE_STATE');
});

test('the rendered prefix is the production instructions and tool definitions', async () => {
	const claude = await renderPrefix({ provider: 'claude' });
	assert.match(claude.instructions.systemPrompt, /mcp__minecraft__observe/);
	assert.deepEqual(claude.tools, MINECRAFT_DYNAMIC_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
	const codex = await renderPrefix({ provider: 'codex', model: 'gpt-6.1-sol' });
	assert.deepEqual(codex.tools, JSON.parse(JSON.stringify(MINECRAFT_DYNAMIC_TOOLS)));
	assert.ok(codex.instructions.baseInstructions.length > 1_000);
	assert.notEqual(claude.prefixSha256, codex.prefixSha256);
	assert.equal((await renderPrefix({ provider: 'claude' })).prefixSha256, claude.prefixSha256, 'prefix renders are stable');
});
