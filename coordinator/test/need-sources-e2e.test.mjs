import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, factToWireObservation, start } from './fixtures/dynamic-main-fixture.mjs';

// Acceptance for live run 2: wire observations and action results through the real coordinator reach the model input
// with remembered sources, iron options and the mining yield, though the model never wrote a plan.

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const frame = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: true, use: false, yaw: 0, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 200 };
const row = (x, y, z) => ({ x, y, z, distance: 10, bearing: 0 });

function wire(sequence, { sighted, changedFacts = ['blocks'], items = [['stone_pickaxe', 1], ['crafting_table', 1]], dimension = 'minecraft:overworld' } = {}) {
	const at = sequence * 1000;
	const observation = factToWireObservation({ player: { x: 76, y: 16, z: -640 }, inventory: { items: items.map(([id, count]) => ({ itemId: `minecraft:${id}`, count })) },
		world: { worldId: 'run2-world', dimension, gameTime: 30_000 + sequence, dayTime: 1000, raining: false, thundering: false } }, 1, sequence, true, at, changedFacts);
	return { agentId: 'agent-a', payload: { ...observation, ...(sighted ? { sighted } : {}) } };
}

test('acceptance: without a plan the planner input carries known sources, iron options first by the vein, and the mining yield', async () => {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	const tools = [
		{ kind: 'start_action', actionType: 'place_block', arguments: { x: 75, y: 16, z: -652, face: 'up', itemId: 'minecraft:crafting_table' } },
		{ kind: 'start_action', actionType: 'control', arguments: frame },
		{ kind: 'start_action', actionType: 'break_block', arguments: { x: 76, y: 16, z: -641, expectedBlockId: 'minecraft:stone', timeoutMs: 5000 } },
	];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'low' });
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		const tool = tools[planner.requests.length - 1];
		if (tool) await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: `turn-${planner.requests.length}`, callId: `c${planner.requests.length}`, tool });
		return { toolCalls: tool ? 1 : 0 };
	};
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: CONFIG });
	const commands = () => run.bridge.sent.filter(({ type }) => type === 'action_command');
	const finish = async (index, payload) => {
		await eventually(() => commands().length > index);
		const command = commands()[index];
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, actionType: command.payload.actionType, observedAtEpochMs: 10_000 + index * 1000, eventSequence: 100 + index * 10, ...payload } });
		await eventually(() => rows.some(({ event, actionId }) => event === 'native_tool_action_completed' && actionId === command.payload.actionId) || rows.filter(({ event }) => event === 'native_tool_action_completed').length > index);
		// The next sample after a result wakes the model, as the server's own update would.
		run.bridge.emit('observation', wire(101 + index * 10, { items: [['stone_pickaxe', 1]] }));
		await eventually(() => planner.requests.length > index + 1);
	};
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'beat the game.' } });
		run.bridge.emit('observation', wire(1));
		await finish(0, { state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED' });
		// The own crafting table reads as a built cluster beside an iron vein, caves and other ore.
		run.bridge.emit('observation', wire(105, { changedFacts: ['sighted'], items: [['stone_pickaxe', 1]], sighted: {
			built: [{ blocks: ['minecraft:crafting_table'], size: 1, ...row(75, 16, -652), new: true }],
			structures: [{ blocks: ['minecraft:snow_block'], size: 1, ...row(-13, 16, -640) }],
			veins: [{ blockId: 'minecraft:iron_ore', visible: 2, ...row(77, 25, -600) }, { blockId: 'minecraft:coal_ore', visible: 3, ...row(75, 16, -660) }],
			caves: [{ air: 70, ...row(72, 28, -629) }, { air: 50, ...row(70, 20, -650) }],
		} }));
		await finish(1, { state: 'SUCCEEDED', reasonCode: 'CONTROL_DONE', breakOutcome: { blocks: 29, correctTool: true, noDropsSeen: false } });
		await finish(2, { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' });
		// Results reach the task view after their durable receipt is stored, so the yield shows on the next wake.
		await eventually(() => rows.filter(({ event }) => event === 'native_turn_completed').length >= 4);
		run.bridge.emit('observation', wire(131, { items: [['stone_pickaxe', 1]] }));
		await eventually(() => planner.requests.length > 4);
		const wake = JSON.parse(planner.requests.at(-1).input.split('\n')[1]);
		assert.match(wake.now.known, /^ores: iron_ore x2 seen 40m S dy\+9 y25 @77,25,-600, coal_ore x3 seen 20m N y16 @75,16,-660; caves: /);
		assert.doesNotMatch(`${wake.now.known} ${wake.now.options}`, /crafting_table|built/, 'its own crafting table is not a remembered source');
		assert.doesNotMatch(`${wake.now.known} ${wake.now.options}`, /snow_block|structure 89m W/, 'a single snow block is neither a structure nor a loot source');
		assert.match(wake.now.options, /^\(best pickaxe stone\) iron: seen iron_ore x2 seen 40m S dy\+9 y25 @77,25,-600; possible cave/);
		assert.match(wake.now.mining, /^last 2m: 1 block broken; mineral gains near breaks \(source unverified\): /);
		assert.equal(rows.filter((row) => JSON.stringify(row).includes('structure_sighted')).length, 0, 'its own crafting table raised no structure_sighted wake');
		assert.ok(rows.some(({ event }) => event === 'native_event_ready'), 'the trace records wakes and their triggers');
	} finally { await run.coordinator.stop(); }
});

/** A native coordinator whose turns each run the next scripted tool; later turns run nothing. */
async function coordinator(tools) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'low' });
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		const tool = tools[planner.requests.length - 1];
		if (tool) await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: `turn-${planner.requests.length}`, callId: `c${planner.requests.length}`, tool });
		return { toolCalls: tool ? 1 : 0 };
	};
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } }, config: CONFIG });
	const commands = () => run.bridge.sent.filter(({ type }) => type === 'action_command');
	const turns = () => rows.filter(({ event }) => event === 'native_turn_completed').length;
	const wakeWith = async (sample) => {
		const before = planner.requests.length;
		await eventually(() => turns() >= before);
		run.bridge.emit('observation', sample);
		await eventually(() => planner.requests.length > before);
		return JSON.parse(planner.requests.at(-1).input.split('\n')[1]).now ?? {};
	};
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'beat the game.' } });
	return { run, planner, rows, commands, wakeWith };
}

test('a seen iron source survives cave and copper churn in the real native wake input', async () => {
	const { run, commands, wakeWith } = await coordinator([]);
	try {
		await wakeWith(wire(1, { changedFacts: ['sighted'], sighted: {
			veins: [{ blockId: 'minecraft:iron_ore', visible: 2, ...row(77, 25, -600) }],
		} }));
		for (let index = 0; index < 40; index += 1) {
			await wakeWith(wire(index + 2, { changedFacts: ['sighted'], sighted: {
				caves: [{ air: 70, ...row(index * 32, 16, -640) }],
				veins: [{ blockId: 'minecraft:copper_ore', visible: 3, ...row(index * 16, 16, -660) }],
			} }));
		}
		const final = wire(50);
		final.payload.position.x = 100;
		const now = await wakeWith(final);
		assert.match(now.options ?? '', /iron: seen iron_ore x2 seen .*@77,25,-600/);
		assert.match(now.known ?? '', /^ores: iron_ore x2 seen .*@77,25,-600/);
		assert.ok(Buffer.byteLength(now.options) <= 360);
		assert.ok(Buffer.byteLength(now.known) <= 300);
		assert.equal(commands().length, 0, 'remembering sources issues no action or route');
	} finally { await run.coordinator.stop(); }
});

test('a replayed result is not counted twice toward the mining yield', async () => {
	const { run, commands, wakeWith, rows } = await coordinator([{ kind: 'start_action', actionType: 'control', arguments: frame }]);
	try {
		await wakeWith(wire(1));
		await eventually(() => commands().length === 1);
		const command = commands()[0];
		const result = { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, actionType: 'control', state: 'SUCCEEDED', reasonCode: 'CONTROL_DONE', observedAtEpochMs: 3000, eventSequence: 3, breakOutcome: { blocks: 30, correctTool: true, noDropsSeen: false } } };
		run.bridge.emit('action_result', result);
		await eventually(() => rows.some(({ event }) => event === 'native_tool_action_completed'));
		await wakeWith(wire(4));
		run.bridge.emit('action_result', structuredClone(result));
		await wakeWith(wire(6));
		const now = await wakeWith(wire(8));
		assert.equal(now.mining, 'last 10m: 30 blocks broken; mineral gains near breaks (source unverified): none observed');
	} finally { await run.coordinator.stop(); }
});

test('a bell placed in the Nether whose result arrives in the Overworld does not hide an Overworld bell there', async () => {
	const bell = { kind: 'start_action', actionType: 'place_block', arguments: { x: 80, y: 16, z: -630, face: 'up', itemId: 'minecraft:bell' } };
	const { run, commands, wakeWith, rows } = await coordinator([bell]);
	try {
		await wakeWith(wire(1, { dimension: 'minecraft:the_nether', items: [['stone_pickaxe', 1], ['bell', 1]] }));
		await eventually(() => commands().length === 1);
		// Through a portal before the result arrives.
		await wakeWith(wire(3));
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: commands()[0].payload.actionId, actionType: 'place_block', state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', observedAtEpochMs: 4000, eventSequence: 4 } });
		await eventually(() => rows.some(({ event }) => event === 'native_tool_action_completed'));
		await wakeWith(wire(6, { changedFacts: ['sighted'], sighted: { poi: [{ blockId: 'minecraft:bell', ...row(80, 16, -630), new: true }] } }));
		const now = await wakeWith(wire(8));
		assert.match(now.known ?? '', /^places: village\(bell\) 11m S/, 'the Overworld bell is evidence; the agent placed its own in the Nether');
	} finally { await run.coordinator.stop(); }
});
