import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { ModelNotebook } from '../src/model-notebook.mjs';
import { validateTaskPlan } from '../src/live-task-view.mjs';
import { TaskMemoryStore } from '../src/task-memory-store.mjs';

const invalid = { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' };
const emoji = '😀';
const step = (overrides = {}) => ({ id: 'one', label: emoji.repeat(100), kind: 'manual', status: 'active', dependsOn: [], detail: emoji.repeat(200), evidence: null, ...overrides });

test('contract: notebook character limits accept Unicode code points through normalization and durable write read restart', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'arena-unicode-contract-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const key = emoji.repeat(128), text = emoji.repeat(2048);
	const call = normalizeMinecraftToolCall('notebook', { key, text });
	const notebook = new ModelNotebook({ directory });
	await notebook.writeNote('agent', { worldId: 'world', key: call.key, text: call.text });
	const restored = new ModelNotebook({ directory });
	assert.equal((await restored.query('agent', { worldId: 'world', kind: 'notes', text: emoji.repeat(256) })).entries[0].text, text);
	assert.equal((await restored.query('agent', { worldId: 'world', kind: 'notes' })).entries[0].key, key);
	assert.throws(() => normalizeMinecraftToolCall('notebook', { key, text: text + emoji }), invalid);
	assert.throws(() => restored.writeNote('agent', { worldId: 'world', key, text: text + emoji }), TypeError);
	assert.throws(() => normalizeMinecraftToolCall('queryMemory', { text: emoji.repeat(257) }), invalid);
	await assert.rejects(restored.query('agent', { worldId: 'world', text: emoji.repeat(257) }), TypeError);
});

test('contract: task plan Unicode character boundaries agree across normalized and direct validation', () => {
	const plan = { steps: [step()] };
	assert.equal(validateTaskPlan(plan).steps[0].label, plan.steps[0].label);
	assert.equal(normalizeMinecraftToolCall('taskPlan', { operation: 'replace', plan }).plan.steps[0].detail, plan.steps[0].detail);
	for (const [field, maximum] of [['label', 100], ['detail', 200]]) {
		const invalidPlan = { steps: [step({ [field]: emoji.repeat(maximum + 1) })] };
		assert.throws(() => validateTaskPlan(invalidPlan), TypeError);
		assert.throws(() => normalizeMinecraftToolCall('taskPlan', { operation: 'replace', plan: invalidPlan }), invalid);
	}
});

test('contract: task memory Unicode entry and query boundaries agree through the real durable store', async () => {
	const scope = { worldId: 'world', dimension: 'minecraft:overworld', agentId: 'agent', goalRevision: 1 };
	const store = new TaskMemoryStore();
	const entry = { kind: 'lesson', key: emoji.repeat(128), label: emoji.repeat(128), summary: emoji.repeat(1024) };
	const call = normalizeMinecraftToolCall('taskMemory', { operation: 'remember', entry });
	await store.remember(scope, call.entry);
	const query = normalizeMinecraftToolCall('taskMemory', { operation: 'query', query: { text: emoji.repeat(256) } }).query;
	assert.equal((await store.query(scope, query)).entries[0].summary, entry.summary);
	for (const [field, maximum] of [['key', 128], ['label', 128], ['summary', 1024]]) {
		assert.throws(() => normalizeMinecraftToolCall('taskMemory', { operation: 'remember', entry: { ...entry, [field]: emoji.repeat(maximum + 1) } }), invalid);
		await assert.rejects(store.remember(scope, { ...entry, [field]: emoji.repeat(maximum + 1) }), TypeError);
	}
	await assert.rejects(store.query(scope, { text: emoji.repeat(257) }), TypeError);
});

test('contract: Unicode character acceptance leaves source parameter and aggregate plan UTF8 byte caps intact', () => {
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { source: `//${emoji.repeat(16_384)}` }), invalid);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { source: 'program.onUnhandledAttention("pause_and_notify");', parameters: { text: emoji.repeat(1024) } }), invalid);
	const plan = { steps: Array.from({ length: 16 }, (_, index) => step({ id: `step${index}` })) };
	assert.ok(Buffer.byteLength(JSON.stringify(plan), 'utf8') > 12_288);
	assert.throws(() => validateTaskPlan(plan), /12 KiB/);
	assert.throws(() => normalizeMinecraftToolCall('taskPlan', { operation: 'replace', plan }), invalid);
});
