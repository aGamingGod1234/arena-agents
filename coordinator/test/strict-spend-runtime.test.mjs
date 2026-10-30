import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderService } from '../src/provider-service.mjs';
import { createDynamicCoordinator, createVoiceSupervisor, startVoiceWorker } from '../src/dynamic-main.mjs';
import { strictSpendRuntime } from '../src/strict-spend-runtime.mjs';
import { FakeBridge, FakeProvider, record, eventually } from './fixtures/dynamic-main-fixture.mjs';

const env = { ARENA_STRICT_SPEND_GATE: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:29999' };
const config = { codex: {}, bridge: { port: 25570, secret: 's'.repeat(32) } };
const request = { requestId: '00000000-0000-0000-0000-000000000101', originalRequest: 'Beat the game', candidateIds: ['minecraft:ender_dragon'] };
const profile = provider => ({ agentId: provider + '-agent', provider, model: provider + '-model', reasoningEffort: 'high', serviceTier: 'priority' });

test('strict runtime rejects absent or non-loopback gateways before construction', () => {
    for (const value of [undefined, 'https://api.anthropic.com', 'http://localhost:1234', 'http://127.0.0.1', 'http://127.0.0.1:1234/bypass']) {
        assert.throws(() => createDynamicCoordinator(config, { env: { ...env, ANTHROPIC_BASE_URL: value } }), { code: 'STRICT_SPEND_GATE_REQUIRED' });
    }
    assert.equal(strictSpendRuntime(env), true);
});

test('strict authority counts every mocked outbound and blocks forbidden create, replace, reconcile, catalog and repeated startup', async () => {
    const calls = [];
    const services = Object.fromEntries(['codex', 'gemini', 'claude'].map(provider => [provider, {
        start: async () => calls.push([provider, 'start']), stop: async () => {},
        createAgent: async () => { calls.push([provider, 'create']); return { decide: async () => calls.push([provider, 'decide']) }; },
        replaceAgent: async () => { calls.push([provider, 'replace']); return {}; },
        reconcile: async records => { calls.push([provider, 'reconcile']); return { valid: records, invalid: [], removed: [] }; },
        catalog: { refresh: async () => { calls.push([provider, 'catalog']); return { models: [] }; } },
    }]));
    const router = new ProviderService(services, { strictSpendGate: true });
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            const started = await router.start(['codex', 'gemini']);
            assert.ok(started.every(result => result.status === 'rejected' && result.reason.code === 'STRICT_SPEND_PROVIDER_DISABLED'));
            for (const provider of ['codex', 'gemini']) {
                await assert.rejects(router.createAgent(profile(provider)), { code: 'STRICT_SPEND_PROVIDER_DISABLED' });
                await assert.rejects(router.replaceAgent(profile(provider)), { code: 'STRICT_SPEND_PROVIDER_DISABLED' });
            }
            await router.reconcile([profile('codex'), profile('gemini')]);
            await router.catalog.refresh({ providers: ['codex', 'gemini'] });
        }
        assert.deepEqual(calls, []);
        const player = await router.createAgent(profile('claude'));
        await player.decide();
        assert.deepEqual(calls, [['claude', 'start'], ['claude', 'create'], ['claude', 'decide']]);
    } finally { await router.stop(); }
});

test('real coordinator wires strict planner: dragon proposal makes zero auxiliary calls and rejection is terminal', async () => {
    const bridge = new FakeBridge();
    const provider = new FakeProvider();
    provider.reconcile = async records => ({ valid: records, invalid: [], removed: [], catalog: { models: [] } });
    let outbound = 0;
    provider.createAgent = async () => { outbound++; throw new Error('unexpected auxiliary provider'); };
    const coordinator = createDynamicCoordinator(config, { env, bridge, codexService: provider, memoryDirectory: null });
    const errors = [];
    coordinator.on('runtimeError', error => errors.push(error));
    await coordinator.start();
    try {
        bridge.emit('ready', { serverInstanceId: 'test', registry: [{ ...record(), provider: 'claude', model: 'claude-sonnet-4-6' }] });
        await eventually(() => bridge.sent.some(message => message.type === 'agent_ready'));
        bridge.emit('goal_spec_request', { agentId: 'agent-a', payload: request });
        await eventually(() => bridge.sent.some(message => message.type === 'goal_spec_proposal'));
        const proposal = bridge.sent.find(message => message.type === 'goal_spec_proposal').payload;
        assert.deepEqual(proposal.predicate, { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
        assert.equal(outbound, 0);
        bridge.emit('goal_spec_result', { agentId: 'agent-a', payload: { requestId: request.requestId, status: 'rejected', reasonCode: 'INVALID_PREDICATE' } });
        await eventually(() => bridge.sent.some(message => message.type === 'agent_error'));
        assert.equal(outbound, 0);
        assert.equal(bridge.sent.filter(message => message.type === 'goal_spec_proposal').length, 1);
        bridge.emit('goal_spec_request', { agentId: 'agent-a', payload: { ...request, requestId: '00000000-0000-0000-0000-000000000102', originalRequest: 'Get iron', candidateIds: ['minecraft:iron_ingot'] } });
        await eventually(() => bridge.sent.filter(message => message.type === 'agent_error').length === 2);
        assert.equal(outbound, 0);
        assert.ok(errors.every(error => error.code === 'STRICT_SPEND_AUXILIARY_DISABLED'));
    } finally { await coordinator.stop(); }
});

test('strict voice supervisor and direct worker cannot invoke any paid voice factory', async () => {
    let outbound = 0;
    const supervisor = createVoiceSupervisor(config, env, { startWorker: () => { outbound++; } });
    await supervisor.start(); await supervisor.close();
    await assert.rejects(startVoiceWorker(config, env, { createOpenAiTtsProvider: () => { outbound++; } }), { code: 'STRICT_SPEND_AUXILIARY_DISABLED' });
    assert.equal(outbound, 0);
});


test('production coordinator router disables Codex transport, Gemini launch and health probes for an untrusted roster', async () => {
    const calls = [];
    const bridge = new FakeBridge();
    const coordinator = createDynamicCoordinator(config, {
        env, bridge, memoryDirectory: null,
        codexTransport: { start: async () => { calls.push('codex-start'); throw new Error('unexpected transport'); }, stop: async () => {}, request: async () => calls.push('codex-request') },
        antigravitySpawn: () => { calls.push('gemini-spawn'); throw new Error('unexpected spawn'); },
        claudeSpawn: () => { calls.push('claude-spawn'); throw new Error('unexpected spawn'); },
        providerCliHealth: { enabled: true, configure() {}, check: async () => calls.push('health-probe') },
    });
    await coordinator.start();
    try {
        bridge.emit('ready', { serverInstanceId: 'test', registry: [record()] });
        await eventually(() => bridge.sent.some(message => message.type === 'agent_error'));
        bridge.emit('director_script_request', { agentId: 'server', payload: { requestId: 'strict-director', actorName: 'Astra', description: 'Jump once' } });
        await eventually(() => bridge.sent.some(message => message.type === 'director_script_result'));
        assert.match(bridge.sent.find(message => message.type === 'director_script_result').payload.error, /disabled in strict spend mode/);
        assert.deepEqual(calls, []);
    } finally { await coordinator.stop(); }
});
