import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioConfig, coordinatorReady } from '../../scripts/run-headless-provider-matrix.mjs';

const scenario = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'priority' };
test('POSIX launcher isolates workspaces and seeds the exact requested Codex profile', () => {
	const source = { bridge: { host: 'example', port: 1 }, codex: { launchProfile: { model: 'other' } } };
	const a = scenarioConfig(source, scenario, 28000, '/tmp/lane-a');
	const b = scenarioConfig(source, scenario, 28100, '/tmp/lane-b');
	assert.equal(a.bridge.host, '127.0.0.1');
	assert.equal(a.bridge.port, 28000);
	assert.equal(a.codex.launchProfile.model, scenario.model);
	assert.equal(a.codex.launchProfile.reasoningEffort, 'low');
	assert.equal(a.codex.launchProfile.serviceTier, 'priority');
	assert.notEqual(a.minecraftAgentRoot, b.minecraftAgentRoot);
	assert.notEqual(a.codex.cwd, b.codex.cwd);
	assert.equal(source.codex.launchProfile.model, 'other');
});
test('POSIX readiness accepts authenticated exact profile or settled provider catalog, tolerating a partial tail', () => {
	const row = (type, payload) => JSON.stringify({ direction: 'coordinator_to_server', envelope: { type, payload } });
	const catalog = row('catalog_snapshot', { models: [{ provider: 'codex', model: scenario.model, reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
	assert.equal(coordinatorReady(catalog + '\n{"partial"', scenario), true);
	assert.equal(coordinatorReady('', scenario), false);
	assert.equal(coordinatorReady(row('catalog_snapshot', { models: [{ provider: 'codex', model: 'other' }] }), scenario), false);
	const fallback = row('coordinator_status', { components: [{ component: 'provider:codex', state: 'degraded' }] }) + '\n' + row('catalog_snapshot', { models: [{ provider: 'codex', model: 'other' }] });
	assert.equal(coordinatorReady(fallback, scenario), true);
});
