import { AgentRegistry } from '../../src/agent-registry.mjs';
import { FakePlanner, eventually, immutableGoalSpec, start } from './dynamic-main-fixture.mjs';

/** A coordinator whose planner forwards native turns, steers and interrupts to one real provider agent. */
export async function coordinatorWithProviderAgent(agent, provider, dependencies = {}) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	planner.steers = [];
	planner.requestNativeTurn = (request) => { planner.requests.push(request); return agent.act(request.input, request); };
	planner.steerNativeTurn = (request) => { planner.steers.push(request); return agent.steer(request.input, request); };
	planner.interrupt = async (agentId) => { planner.interruptions.push(agentId); return await agent.interrupt(); };
	const config = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools',
		launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } } };
	const initialRegistry = [{ agentId: 'agent-a', provider, model: provider === 'claude' ? 'claude-sonnet-5-5' : 'gpt-5.6-sol',
		reasoningEffort: 'high', serviceTier: 'priority', state: 'IDLE', goalRevision: 0, queue: [] }];
	const run = await start({ registry, planner, config, initialRegistry, ...dependencies });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Find a fortress.', goalSpec: immutableGoalSpec('Find a fortress.') } });
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 0, y: 64, z: 0 } } } });
	return { ...run, planner };
}

/** The body's running action stops on lava before any observation has reported the contact. */
export async function returnLavaResult(run) {
	await eventually(() => run.bridge.sent.some((message) => message.type === 'action_command'));
	const command = run.bridge.sent.find((message) => message.type === 'action_command');
	run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state: 'FAILED',
		reasonCode: 'IN_LAVA', message: 'The body entered lava; this action stopped', executionStarted: true, eventSequence: 2 } });
}

export function emitLavaObservation(run) {
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 3, attention: true, changedFacts: ['player.inLava'],
		observation: { player: { x: 0, y: 64, z: 0, health: 14, inLava: true, hazard: 'lava', fire: true, exits: [] } } } });
}
