import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentRegistry } from '../src/agent-registry.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start, resolveNativeSteerInput } from './fixtures/dynamic-main-fixture.mjs';

const payloadOf = input => JSON.parse(input.slice(input.indexOf('\n') + 1));
const bytes = payload => Buffer.byteLength(JSON.stringify(payload));
const hasLoop = payload => payload.movementLoop === true || payload.trigger === 'movement_loop';


// The builder applies its budget before transposing the coverage labels for delivery.
const beforeCoveragePacking = value => {
 const copy = structuredClone(value), observation = copy.observation;
 if (observation.snapshotCounts) {
  observation.resultCoverage = Object.fromEntries(Object.entries(observation.snapshotCounts).map(([key, count]) => [key, {
   availableInSnapshot: count, ...(observation.omittedRows?.[key] === undefined ? {} : { omitted: observation.omittedRows[key] }),
  }]));
  delete observation.snapshotCounts;
  delete observation.omittedRows;
 }
 return copy;
};

test('loop metadata preserves the underlying wake at every compaction boundary', () => {
	const record = { currentGoal: 'Find a fortress.', goalRevision: 1 };
	const entities = Array.from({ length: 16 }, (_, index) => ({ uuid: `mob-${index}`, type: 'minecraft:skeleton', hostile: true,
		alive: true, targetingAgent: true, x: index, y: 64, z: 2, health: 20 }));
	const blocks = Array.from({ length: 32 }, (_, index) => ({ x: index, y: 63, z: 0, blockId: 'minecraft:oak_stairs',
		state: { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' },
		tags: ['minecraft:stairs', 'minecraft:mineable/axe'],
		bounds: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }, { minX: 0, minY: 0.5, minZ: 0, maxX: 1, maxY: 1, maxZ: 0.5 }] }));
	const budget = 16_384 + bytes(record.currentGoal);
	for (const withConversation of [false, true]) {
		for (const offset of [-21, -10, 0, 1, 21, 200]) {
			const options = { event: 'observation', trigger: 'damage', dangerSummary: { hitsSinceLastUpdate: 3, healthBefore: 20, healthNow: 14 },
				observation: { player: { x: 0.5, y: 64, z: 0.5, health: 14, onGround: true }, inventory: { items: [] }, blocks, entities },
				taskMemory: { facts: '' },
				...(withConversation ? { conversation: { mode: 'unread', baseSequence: -1, nextSequence: 1,
					entries: [{ sequence: 1, kind: 'player_message', sourceId: 'player-a', text: 'Keep the tree. 🌳' }] } } : {}) };
			const initial = bytes(beforeCoveragePacking(payloadOf(buildNativeEventInput(record, options))));
			options.taskMemory.facts = 'x'.repeat(budget - initial + offset);
			assert.ok(bytes(options.taskMemory) <= 6_000, 'memory stays inside its real limit');
			const plain = payloadOf(buildNativeEventInput(record, options));
			const combined = payloadOf(buildNativeEventInput(record, { ...options, movementLoop: true }));
			const { movementLoop, ...underlying } = combined;
			assert.equal(movementLoop, true);
			assert.deepEqual(underlying, plain, `all observation, danger, memory and conversation facts survive at offset ${offset}`);
			assert.equal(bytes(combined) - bytes(plain), 20);
			if (offset <= 0) {
				assert.equal(plain.observation.entities.length, 16);
				assert.equal(plain.observation.blocks.length, 32);
			}
		}
	}
});

for (const route of ['advisory', 'rejected_advisory', 'genuine_advisory', 'genuine_rejected_advisory', 'conversation', 'stale_observation', 'genuine_stale_observation']) {
	test(`progress loops wait for observation validation through ${route}`, async t => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const genuine = route.startsWith('genuine_');
		const stale = route.endsWith('stale_observation');
		const registry = new AgentRegistry();
		const planner = new FakePlanner(registry);
		const attempted = [];
		const accepted = [];
		let handle;
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		planner.getNativeDecisionTiming = () => ({ count: 4, p50Ms: 500, p95Ms: 999 });
		planner.requestNativeTurn = async request => {
			planner.requests.push(request);
			handle = await request.executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'walking', callId: 'program', tool: {
				kind: 'run_program', background: true, timeoutMs: 30_000, expectedDurationMs: 1_100, maxActions: 2,
				source: 'program.onUnhandledAttention("continue_and_notify"); await player.wait(1); await player.wait(2);',
			} });
			await gate;
			return { status: 'completed', toolCalls: 1 };
		};
		planner.steerNativeTurn = async request => {
			const payload = payloadOf(await resolveNativeSteerInput(request));
			attempted.push(payload);
			if (route.includes('rejected_advisory') && payload.event === 'program_planning_due') {
				throw Object.assign(new Error('Rejected test advisory'), { code: 'TEST_ADVISORY_REJECTED' });
			}
			accepted.push(payload);
			return { turnId: 'walking' };
		};
		const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), config: {
			bridge: { port: 27711, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' },
		} });
		const flush = async () => { for (let index = 0; index < 25; index += 1) await new Promise(resolve => setImmediate(resolve)); };
		const observe = async (at, x, health = 20) => {
			run.bridge.emit('observation', { agentId: 'agent-a', payload: {
				goalRevision: 1, eventSequence: (run.bridge.latestSequences.get('agent-a') ?? 0) + 1, attention: health < 20, observedAtEpochMs: at,
				observation: { player: { x, y: 64, z: 0.5, health, ...(health < 20 ? { hurtBy: genuine ? 'lava' : 'arrow by minecraft:skeleton' } : {}) },
					...(health < 20 && !genuine ? { velocity: { x: 0.3, y: 0.36, z: 0.3 } } : {}),
					items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} } },
			} });
			await flush();
		};
		try {
			run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Find a fortress.' } });
			await observe(1_000, 0.5);
			await eventually(() => handle && run.bridge.sent.some(message => message.type === 'action_command'));
			await observe(3_000, 1.5);
			await observe(5_000, 0.5);
			const action = run.bridge.sent.find(message => message.type === 'action_command');
			run.bridge.emit('action_progress', { agentId: 'agent-a', payload: {
				goalRevision: 1, actionId: action.payload.actionId, state: 'RUNNING', progress: 0.5, elapsedMs: 100, observedAtEpochMs: 6_980,
				actionObservation: { observedAtEpochMs: 6_980, position: { x: 1.5, y: 64, z: 0.5 },
					...(genuine ? { velocity: { x: 0.1, y: 0, z: 0 }, onGround: true } : {}) },
			} });
			await flush();
			if (stale) {
				await observe(6_970, 1.5);
			} else if (route === 'conversation') {
				run.bridge.emit('conversation_event', { agentId: 'agent-a', payload: { sequence: 1, kind: 'player_message', sourceId: 'player-a',
					recipientId: 'agent-a', scope: 'direct', text: 'Where are you?', goalRevision: 1, observedAtEpochMs: 6_990 } });
			} else t.mock.timers.tick(101);
			await flush();
			if (!stale) await eventually(() => attempted.length > 0);
			const beforeCorrection = structuredClone(attempted);
			await observe(7_000, 1.5, 18);
			if (!stale) assert.ok(beforeCorrection.length > 0, 'the competing event actually reached the model boundary');
			assert.equal(beforeCorrection.some(hasLoop), false, 'unvalidated progress cannot reach any competing delivery');
			if (genuine) await eventually(() => accepted.some(hasLoop));
			assert.equal(accepted.some(hasLoop), genuine, 'the correcting observation withdraws shoves and delivers genuine loops even after advisory rejection');
			assert.equal(run.bridge.sent.filter(message => message.type === 'agent_error').length, 0);
		} finally {
			release();
			await run.coordinator.stop();
		}
	});
}
