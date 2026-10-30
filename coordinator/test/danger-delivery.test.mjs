import assert from 'node:assert/strict';
import test from 'node:test';
import { DangerSteerCoalescer } from '../src/danger-steer-coalescer.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { nativeSteerInterruption, mergePlannerRequest, buildNativeEventInput } from '../src/dynamic-main.mjs';
import { realPlannerProvider, record, start, eventually, resolveNativeSteerInput } from './fixtures/dynamic-main-fixture.mjs';

import { AgentPlanner } from '../src/agent-planner.mjs';
import { PlanningScheduler } from '../src/planning-scheduler.mjs';
import { CodexService } from '../src/codex-service.mjs';
import { harness as claudeHarness } from './fixtures/claude-service-fixture.mjs';
import { FakeSharedTransport } from './fixtures/codex-service-fixture.mjs';

const request = (trigger, health = 20, signals = []) => ({ trigger, priority: 'urgent', nativeEvent: { event: 'observation', trigger, observation: { player: { health, threats: [{ type: 'minecraft:piglin', signals }] } } } });

test('contact approach, visible aiming and damaging fall interrupt without stopping the action', () => {
	for (const signal of ['imminent', 'ranged_aiming']) assert.equal(nativeSteerInterruption(request('threat', 20, [signal])), 'danger');
	assert.equal(nativeSteerInterruption(request('fall')), 'danger');
	assert.equal(nativeSteerInterruption(request('threat', 20, ['ranged_sight'])), null);
});

for (const { provider, healthSamples } of [
	{ provider: 'codex', healthSamples: [18, 17] },
	{ provider: 'claude', healthSamples: [18, 17] },
]) {
	test(`${provider} tool_queued progress immediately delivers folded damage with newest health and cancels its timer`, async () => {
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		const registry = new AgentRegistry();
		const scheduler = new PlanningScheduler();
		const requests = [];
		const transport = new FakeSharedTransport();
		transport.autoComplete = false;
		const cli = provider === 'claude' ? await claudeHarness({ async onUser(child) { await gate; child.emitLine({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-1' }); } }) : null;
		const service = cli?.service ?? new CodexService({ cwd: process.cwd() }, { transport });
		const fakeProvider = realPlannerProvider(async () => ({}));
		fakeProvider.getAgent = agentId => service.getAgent(agentId);
		const planner = new AgentPlanner({ registry, scheduler, codexService: fakeProvider });
		const steers = [];
		const progress = [];
		const requestTurn = planner.requestNativeTurn.bind(planner);
		planner.requestNativeTurn = request => requestTurn({ ...request, onProgress: metadata => { progress.push(metadata); return request.onProgress(metadata); } });
		const timers = new Map();
		const canceled = [];
		const traces = [];
		let timerId = 0;
		let now = 0;
		fakeProvider.createAgent = async record => {
			const agent = await service.createAgent(record, { controlProtocol: 'native_tools' });
			const act = agent.act.bind(agent);
			agent.act = async (input, options) => { requests.push(options); return act(input, options); };
			agent.steer = async input => { steers.push(await resolveNativeSteerInput({ input })); return { turnId: 'danger-turn' }; };
			return agent;
		};
		const run = await start({ registry, scheduler, planner, codexService: fakeProvider,
			initialRegistry: [{ ...record(), provider, ...(provider === 'claude' ? { model: 'claude-sonnet-5-5' } : {}) }],
			controlNow: () => now,
			setSteerTimeout: (callback, delay) => {
				const id = ++timerId;
				timers.set(id, { callback, due: now + delay });
				return id;
			},
			clearSteerTimeout: id => { canceled.push(id); timers.delete(id); },
			traceWriter: { write(event, fields) { traces.push({ event, ...fields }); } },
			config: { bridge: { port: 25570, secret: 's'.repeat(32) },
				codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } } },
		});
		let sequence = 0;
		const observe = (health, footing, attention = false) => run.bridge.emit('observation', { agentId: 'agent-a', payload: {
			goalRevision: 1, eventSequence: ++sequence, attention, changedFacts: ['player.health'],
			observation: { player: { x: 0, y: 64, z: 0, health, ...(footing ? { footing } : {}) }, items: [], entities: [], blocks: [], inventory: { items: [] } },
		} });
		const settle = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); };
		try {
			run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Survive the night.' } });
			// This test covers coalescing after danger is known; first-warning delivery has separate regressions.
			observe(20, undefined, true);
			await eventually(() => requests.length === 1);
			now = 2_000;
			observe(19);
			await eventually(() => steers.length === 1);
			await settle();
			for (const health of healthSamples) {
				now += 100;
				observe(health, health === healthSamples[0] ? { drop: 4, atLeast: true, yaw: -90 } : null);
				await settle();
			}
			assert.equal(traces.filter(row => row.event === 'native_turn_steer_coalesced').length, healthSamples.length);
			assert.equal(steers.length, 1, 'repeat hits stay folded before a provider tool boundary');
			assert.equal(timers.size, 1);
			const [foldTimerId, foldTimer] = [...timers][0];
			assert.ok(foldTimer.due > now, 'the coalescing timer has not elapsed');
			const turn = requests[0];
			turn.onProgress({ phase: 'assistant', provider });
			await settle();
			assert.equal(steers.length, 1, 'ordinary provider progress must not flush folded danger');
			const queueTool = async callId => {
				if (cli) await cli.children[0].rpc('tools/call', { name: 'observe', arguments: {}, _meta: { 'claudecode/toolUseId': callId } });
				else transport.emit('serverRequest', { id: callId, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId, tool: 'observe', arguments: {} } });
			};
			await queueTool('queued-observe');
			await eventually(() => canceled.length === 1);
			assert.equal(timers.size, 0, 'the tool boundary cancels the pending fold timer synchronously');
			assert.deepEqual(canceled, [foldTimerId]);
			assert.ok(progress.some(metadata => metadata.phase === 'tool_queued' && metadata.toolName === 'observe'));
			await eventually(() => steers.length === 2);
			const payload = JSON.parse(steers[1].slice(steers[1].indexOf('\n') + 1));
			assert.equal(payload.trigger, 'damage');
			assert.equal(payload.hud.health, `${healthSamples.at(-1)}/20`);
			assert.equal(payload.dangerSinceLastUpdate.hitsSinceLastUpdate, healthSamples.length);
			assert.equal(payload.dangerSinceLastUpdate.foldedEvents, healthSamples.length);
			assert.equal(payload.dangerSinceLastUpdate.healthNow, healthSamples.at(-1));
			assert.deepEqual(payload.dangerSinceLastUpdate.earlierFooting, { drop: 4, atLeast: true, yaw: -90, position: { x: 0, y: 64, z: 0 }, dimension: 'minecraft:overworld' });
			assert.equal(payload.observation.player.footing, undefined, 'past footing does not become current footing');
			await queueTool('next-observe');
			await settle();
			assert.equal(steers.length, 2, 'the folded update is delivered only once');
			assert.equal(requests.length, 1, 'the provider keeps its active turn');
			assert.equal(run.bridge.sent.some(message => message.type === 'action_cancel'), false);
		} finally {
			release();
			await run.coordinator.stop();
			if (cli) await cli.close();
			else await service.stop();
		}
	});
}

test('landing damage retains the fall distance when its newer observation replaces an airborne steer', () => {
	const fall = request('fall', 18);
	fall.nativeEvent.observation.player.fallDistance = 9;
	const airborne = mergePlannerRequest(null, fall);
	assert.equal(airborne.dangerSummary?.fallDistance, undefined, 'the airborne observation already carries fall distance');
	const merged = mergePlannerRequest(airborne, request('damage', 8));
	assert.equal(merged.nativeEvent.observation.player.health, 8);
	assert.equal(merged.dangerSummary.fallDistance, 9);
	const input = buildNativeEventInput({ agentId: 'agent-a', goalRevision: 1 }, { ...merged.nativeEvent, dangerSummary: merged.dangerSummary });
	const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
	assert.equal(payload.dangerSinceLastUpdate.fallDistance, 9);
	assert.equal(payload.hud.health, 8);
});

test('queued danger retains superseded footing at its original position and world', () => {
	const earlier = request('damage', 18);
	earlier.nativeEvent.observation.world = { dimension: 'minecraft:the_nether', worldId: 'world-a' };
	Object.assign(earlier.nativeEvent.observation.player, { x: 3, y: 64, z: 5, footing: { drop: 4, atLeast: true, yaw: -90 } });
	const later = request('damage', 17);
	Object.assign(later.nativeEvent.observation.player, { x: 4, y: 64, z: 5 });
	const expected = { drop: 4, atLeast: true, yaw: -90, position: { x: 3, y: 64, z: 5 }, dimension: 'minecraft:the_nether', worldId: 'world-a' };
	const merged = mergePlannerRequest(earlier, later);
	assert.deepEqual(merged.dangerSummary?.earlierFooting, expected);
	assert.equal(merged.nativeEvent.observation.player.footing, undefined);
	assert.equal(merged.nativeEvent.observation.player.x, 4);
	assert.deepEqual(mergePlannerRequest(merged, request('damage', 16)).dangerSummary.earlierFooting, expected);
	const newer = structuredClone(earlier);
	newer.nativeEvent.observation.player.footing.drop = 8;
	const latest = mergePlannerRequest(merged, newer);
	assert.equal(latest.nativeEvent.observation.player.footing.drop, 8);
	assert.equal(latest.dangerSummary?.earlierFooting, undefined, 'newer current footing supersedes the old summary');
	assert.equal(earlier.dangerSummary, undefined, 'merging does not mutate a source request');
});

test('folded footing survives an urgent non-danger steer and clears after delivery', () => {
	const coalescer = new DangerSteerCoalescer();
	coalescer.noteDelivered(request('damage', 19), 0);
	const first = request('damage', 18);
	Object.assign(first.nativeEvent.observation.player, { x: 3, y: 64, z: 5, footing: { drop: 4, atLeast: true, yaw: -90 } });
	assert.equal(coalescer.offer(first, 100).action, 'fold');
	assert.equal(coalescer.offer(request('damage', 17), 200).action, 'fold');
	const delivered = coalescer.offer({ trigger: 'conversation', nativeEvent: { event: 'conversation' } }, 300);
	assert.deepEqual(delivered.request.dangerSummary.earlierFooting, { drop: 4, atLeast: true, yaw: -90, position: { x: 3, y: 64, z: 5 } });
	assert.equal(coalescer.flush(400), null);
});
