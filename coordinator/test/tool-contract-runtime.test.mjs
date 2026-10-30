import assert from 'node:assert/strict';
import test from 'node:test';
import { ARENA_SCRIPT_API_REFERENCE } from '../src/prompts.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, minecraftCapabilities, normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { validateToolSchema } from '../src/tool-schema-contract.mjs';
import { CONTROL_REFERENCE_TOPICS } from '../src/minecraft-control-reference.mjs';
import { STRATEGY_REFERENCE_TOPICS } from '../src/minecraft-strategy-reference.mjs';

const record = { agentId: 'contract-agent', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'priority', goalRevision: 1, currentGoal: 'Inspect contracts.' };
const call = tool => ({ agentId: record.agentId, goalRevision: 1, turnId: 'contract-turn', callId: 'contract-call', tool });

test('capabilities describes discoverable topics and complete control pagination', () => {
	const description = MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === 'capabilities').description;
	for (const fact of ['query sections', 'Read each topic once', 'before writing ArenaScript', 'before unfamiliar calls', 'nextOffset', 'topic all is complete', 'ores', 'no topic lists all']) assert.ok(description.includes(fact), fact);
	assert.deepEqual(minecraftCapabilities({ section: 'strategy' }).topics.map(topic => topic.id), STRATEGY_REFERENCE_TOPICS);
	assert.deepEqual(minecraftCapabilities({ section: 'control' }).topics.map(topic => topic.id), CONTROL_REFERENCE_TOPICS);
});

test('restored tool advisories retain their trigger, examples and body ownership facts', () => {
	const descriptions = Object.fromEntries(MINECRAFT_DYNAMIC_TOOLS.map(tool => [tool.name, tool.description]));
	for (const [tool, facts] of Object.entries({
		runProgram: ['expectedDurationMs<=timeout', 'Size loops from work, not timeout'],
		survey: ['portals/bells/beds/workstations', 'nearest visible ground', 'lava pools/spawners/chests', 'Caves/structures show seen ore without digging'],
		act: ['replaceAction fight_target retargets', 'nearby drops may be gone', 'eyes near a stronghold hover at its anchor, not the portal room; conserve 12 minus filled frames'],
		finish: ['never repeat work/verification'], control: ['turns before movement/clicks'],
		mine: ['It turns to a visible part'], taskMemory: ['Reobserve before relying on any memory'],
	})) for (const fact of facts) assert.ok(descriptions[tool].includes(fact), `${tool}: ${fact}`);
});

test('reused schema validation remains correct if a caller updates a pattern', () => {
	const schema = { type: 'string', pattern: '^first$' };
	assert.equal(validateToolSchema('first', schema), 'first');
	assert.throws(() => validateToolSchema('second', schema), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	schema.pattern = '^second$';
	assert.equal(validateToolSchema('second', schema), 'second');
	assert.throws(() => validateToolSchema('first', schema), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
});

test('contract: an unavailable observation barrier returns explicitly stale cached facts without a body action', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (...args) => sent.push(args) } });
	t.after(() => runtime.disposeAll());
	runtime.updateObservation(record, { worldId: 'contract-world', player: { health: 9 }, world: { dimension: 'minecraft:overworld' } }, { eventSequence: 5 });
	const result = await runtime.execute(call(normalizeMinecraftToolCall('observe', {})), record);
	assert.equal(result.observation.player.health, 9);
	assert.equal(result.freshness.fresh, false);
	assert.equal(result.freshness.reasonCode, 'FRESH_OBSERVATION_UNAVAILABLE');
	assert.equal(result.eventSequence, 5);
	// The default reflex set armed on the first live sample is rules, not a body action.
	assert.deepEqual(sent.filter(([type]) => type !== 'reflex_update'), []);
});

test('contract: every program, strategy and paged control capability is read-only through the native runtime', async t => {
	const runtime = new NativeToolRuntime({ bridge: { send: async () => assert.fail('Reference query dispatched gameplay') } });
	t.after(() => runtime.disposeAll());
	for (const section of ['all', 'program', 'strategy', 'control']) {
		const result = await runtime.execute(call(normalizeMinecraftToolCall('capabilities', { section })), record);
		assert.equal(result.version, 1);
	}
	for (const topic of STRATEGY_REFERENCE_TOPICS) {
		const result = await runtime.execute(call(normalizeMinecraftToolCall('capabilities', { section: 'strategy', topic })), record);
		assert.equal(result.topic, topic);
		assert.ok(result.reference.length);
	}
	for (const topic of CONTROL_REFERENCE_TOPICS) {
		let offset = 0;
		for (;;) {
			const page = await runtime.execute(call(normalizeMinecraftToolCall('capabilities', { section: 'control', topic, offset })), record);
			assert.equal(page.offset, offset);
			assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 15000);
			if (page.nextOffset === undefined) { assert.equal(page.coverage.complete, true); break; }
			assert.ok(page.nextOffset > offset);
			offset = page.nextOffset;
		}
	}
});

test('contract: native and program inspection keep the survey include/exclude contract', () => {
	const args = { section: 'survey', include: ['blocks:minecraft:stone'], exclude: ['built'], limit: 8 };
	assert.deepEqual(normalizeMinecraftToolCall('inspect', args), { kind: 'inspect', ...args });
	for (const include of [['hidden'], Array(9).fill('structures')]) assert.throws(() => normalizeMinecraftToolCall('inspect', { ...args, include }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	assert.throws(() => normalizeMinecraftToolCall('inspect', { ...args, section: 'blocks' }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
});

test('contract: navigation keeps one model target and deadline and preserves an honest near-arrival receipt', async t => {
	for (const actionType of ['navigate_to', 'move_to']) {
		const sent = [];
		const runtime = new NativeToolRuntime({ bridge: { send: async (...args) => sent.push(args) } });
		t.after(() => runtime.disposeAll());
		const args = { x: 40.5, y: 64, z: 0.5, tolerance: 1, sprint: false, ...(actionType === 'navigate_to' ? { timeoutMs: 12_345 } : {}) };
		const tool = actionType === 'navigate_to' ? normalizeMinecraftToolCall('moveTo', args)
			: normalizeMinecraftToolCall('act', { actionType, arguments: args });
		const pending = runtime.execute(call(tool), record);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(sent.length, 1, 'only one action is dispatched across body replans');
		assert.equal(sent[0][2].actionType, actionType);
		assert.deepEqual(sent[0][2].arguments, args);
		const message = 'Stopped 2.5 blocks from target (requested tolerance 1); target footing seen, remaining approach unverified; replans 4; walked 38.0, left 2.5; stopped at 38.00,64.00,0.50';
		runtime.onActionResult(record, { actionId: sent[0][2].actionId, goalRevision: 1, state: 'FAILED', reasonCode: 'DESTINATION_NEAR_UNVERIFIED', message,
			actionObservation: { worldTick: 40, position: { x: 38, y: 64, z: 0.5 }, target: { kind: 'position', position: { x: 40.5, y: 64, z: 0.5 }, tolerance: 1, standable: true } } });
		const result = await pending;
		assert.equal(result.state, 'FAILED');
		assert.equal(result.reasonCode, 'DESTINATION_NEAR_UNVERIFIED');
		assert.equal(result.message, message);
		assert.equal(result.actionObservation.target.standable, true);
		assert.deepEqual(result.actionObservation.target.position, { x: 40.5, y: 64, z: 0.5 });
		assert.ok(result.failure);
		assert.equal(result.failureClass, 'path');
		assert.equal(sent.length, 1);
	}
});

test('program reference describes live-authored source and explicit attention handles', () => {
	assert.ok(ARENA_SCRIPT_API_REFERENCE.includes('runProgram: live-authored source.'));
	assert.ok(ARENA_SCRIPT_API_REFERENCE.includes('programStatus/respondProgram: attention.'));
});

test('contract: placement face preference accepts strict mode and preserves factual failure causes', async t => {
	const args = { x: 1, y: 64, z: 0, face: 'east', itemId: 'minecraft:obsidian' };
	const plain = normalizeMinecraftToolCall('act', { actionType: 'place_block', arguments: args });
	assert.equal(plain.arguments.faceMode, undefined, 'omission reaches the runtime preferred default');
	for (const faceMode of ['preferred', 'strict']) {
		assert.equal(normalizeMinecraftToolCall('act', { actionType: 'place_block', arguments: { ...args, faceMode } }).arguments.faceMode, faceMode);
	}
	for (const faceMode of ['any', true, null]) {
		assert.throws(() => normalizeMinecraftToolCall('act', { actionType: 'place_block', arguments: { ...args, faceMode } }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	}
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (...values) => sent.push(values) } });
	t.after(() => runtime.disposeAll());
	const pending = runtime.execute(call(plain), record);
	await new Promise(resolve => setImmediate(resolve));
	const cause = 'SUPPORT_FACE_HIDDEN';
	const message = 'cause=SUPPORT_FACE_HIDDEN; destination=1,64,0; requestedSupport=0,64,0; requestedFace=east; eye=-1,65.62,0.5; visibleFaces=[0,64,0:west]';
	runtime.onActionResult(record, { actionId: sent[0][2].actionId, goalRevision: 1, state: 'FAILED', reasonCode: 'NO_PLACEMENT_SUPPORT', cause, message });
	const result = await pending;
	assert.equal(result.reasonCode, 'NO_PLACEMENT_SUPPORT');
	assert.equal(result.cause, cause);
	assert.equal(result.message, message);
});
