import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_CHAT_LENGTH, MAX_DURATION_MS } from '../src/constants.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, normalizeMinecraftToolCall, toolAdjustments } from '../src/native-minecraft-tools.mjs';
import { validateAction } from '../src/schema.mjs';

const recipientId = '550e8400-e29b-41d4-a716-446655440000';
const wait = { actionType: 'wait', arguments: { durationMs: 1 } };
const invalid = { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' };

test('say rejects invalid recipients before dispatch and emits canonically valid chat', () => {
	for (const id of ['agent-b', 'nearest_player', '', recipientId.slice(1), `${recipientId}x`]) {
		assert.throws(() => normalizeMinecraftToolCall('say', { message: 'hi', recipientId: id }), invalid);
	}
	for (const audience of ['public', 'proximity']) {
		assert.throws(() => normalizeMinecraftToolCall('say', { message: 'hi', audience, recipientId }), invalid);
	}
	assert.throws(() => normalizeMinecraftToolCall('say', { message: 'hi', audience: 'direct' }), invalid);
	for (const args of [{ recipientId }, { audience: 'direct', recipientId }, {}, { audience: 'proximity' }]) {
		const result = normalizeMinecraftToolCall('say', { message: 'hi', ...args });
		assert.doesNotThrow(() => validateAction({ type: result.actionType, ...result.arguments }));
		assert.equal(result.arguments.audience, args.audience ?? (args.recipientId ? 'direct' : 'public'));
	}
	const schema = MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === 'say').inputSchema;
	assert.match(recipientId, new RegExp(schema.properties.recipientId.pattern));
	assert.doesNotMatch('agent-b', new RegExp(schema.properties.recipientId.pattern));
});

test('say measures its advertised limit in Unicode code points for every audience', () => {
	for (const args of [{}, { audience: 'direct', recipientId }, { audience: 'proximity' }]) {
		for (const message of ['😀'.repeat(200), '😀'.repeat(MAX_CHAT_LENGTH), `a${'😀'.repeat(MAX_CHAT_LENGTH - 1)}`]) {
			const result = normalizeMinecraftToolCall('say', { message, ...args });
			assert.equal(result.arguments.message, message);
			assert.doesNotThrow(() => validateAction({ type: 'chat', ...result.arguments }));
		}
		assert.throws(() => normalizeMinecraftToolCall('say', { message: '😀'.repeat(MAX_CHAT_LENGTH + 1), ...args }), invalid);
	}
	for (const message of ['', ' ', '\u00a0', '\u001c', 42, null]) {
		assert.throws(() => normalizeMinecraftToolCall('say', { message }), invalid);
	}
});

for (const [alias, actionType, base] of [
	['moveTo', 'navigate_to', { x: 1, y: 64, z: 2, tolerance: 1, sprint: true }],
	['mine', 'break_block', { x: 1, y: 64, z: 2, expectedBlockId: 'minecraft:stone' }],
]) {
	test(`${alias}, act, startAction, replaceAction and sequence use canonical duration bounds`, () => {
		const calls = args => [
			() => normalizeMinecraftToolCall(alias, args),
			() => normalizeMinecraftToolCall('act', { actionType, arguments: args }),
			() => normalizeMinecraftToolCall('startAction', { actionType, arguments: args }),
			() => normalizeMinecraftToolCall('replaceAction', { actionId: 'exact-handle', goalRevision: 3, actionType, arguments: args }),
			() => normalizeMinecraftToolCall('sequence', { actions: [{ actionType, arguments: args }, wait] }).actions[0],
		];
		for (const timeoutMs of [1, 240_000, MAX_DURATION_MS]) {
			const args = { ...base, timeoutMs };
			const canonical = validateAction({ type: actionType, ...args });
			for (const call of calls(args)) {
				const result = call();
				assert.deepEqual({ type: result.actionType, ...result.arguments }, canonical);
			}
		}
		for (const timeoutMs of [0, -1, 0.5, MAX_DURATION_MS + 1, null, '240000']) {
			for (const call of calls({ ...base, timeoutMs })) assert.throws(call, invalid);
		}
		const schema = MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === alias).inputSchema;
		assert.equal(schema.properties.timeoutMs.maximum, MAX_DURATION_MS);
		assert.equal(schema.properties.timeoutMs.minimum, 1);
	});
}

test('action aliases retain defaults, exact fields, and explicit mine autoAim expansion', () => {
	const args = { x: 1, y: 64, z: 2 };
	const move = normalizeMinecraftToolCall('moveTo', args);
	assert.deepEqual(move.arguments, { ...args, tolerance: 1, sprint: true, timeoutMs: 30_000 });
	assert.deepEqual(normalizeMinecraftToolCall('act', { actionType: 'navigate_to', arguments: args }), move);
	const mining = { ...args, expectedBlockId: 'minecraft:stone', timeoutMs: MAX_DURATION_MS };
	const autoAim = normalizeMinecraftToolCall('mine', { ...mining, autoAim: true });
	assert.deepEqual(autoAim.actions.map(action => action.actionType), ['look_at', 'break_block']);
	assert.deepEqual(autoAim.actions[1].arguments, mining);
	for (const argumentsValue of [{ ...mining, autoAim: true }, { ...mining, type: 'wait' }]) {
		assert.throws(() => normalizeMinecraftToolCall('act', { actionType: 'break_block', arguments: argumentsValue }), invalid);
	}
});


test('template tuning at either mistaken boundary is repaired once and conflicts identify the legal call', () => {
	for (const args of [
		{ standing: { template: 'survival', fightAtHealth: 12 } },
		{ standing: { template: 'survival' }, fightAtHealth: 12 },
	]) {
		const tool = normalizeMinecraftToolCall('runProgram', args);
		assert.equal(tool.parameters.fightAtHealth, 12);
		assert.match(JSON.stringify(toolAdjustments(tool)), /moved to parameters.fightAtHealth/);
		assert.deepEqual(args.parameters, undefined, 'caller arguments were not mutated');
	}
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { standing: { template: 'survival', fightAtHealth: 12 }, parameters: { fightAtHealth: 5 } }), /Conflicting.*runProgram.*parameters/);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { standing: { template: 'survival' }, parameters: { wrong: true } }), /runProgram.*parameters.*fightAtHealth.*unknown parameters.wrong/);
});

test('template parameters merge unambiguous standing fields with root parameters regardless of position key order', () => {
	const args = { standing: { template: 'survival', threats: false, escape: { z: 3, y: 64, x: 1 } },
		parameters: { threats: false, fallDepth: 6, escape: { x: 1, y: 64, z: 3 } } };
	const before = structuredClone(args);
	const normalized = normalizeMinecraftToolCall('runProgram', args);
	assert.equal(normalized.parameters.threats, false);
	assert.equal(normalized.parameters.fallDepth, 6);
	assert.deepEqual({ ...normalized.parameters.escape }, { x: 1, y: 64, z: 3 });
	assert.deepEqual(args, before);
	assert.match(toolAdjustments(normalized)['standing.escape'], /moved to parameters.escape/);
	assert.throws(() => normalizeMinecraftToolCall('runProgram', { ...args,
		parameters: { ...args.parameters, escape: { x: 2, y: 64, z: 3 } },
	}), /Conflicting standing.escape/);
});

test('survival accepts the action spelling fleeAtHealth as its shared fight threshold without guessing conflicts', () => {
	for (const args of [
		{ standing: { template: 'survival', fleeAtHealth: 12 } },
		{ standing: { template: 'survival' }, parameters: { fleeAtHealth: 12 } },
		{ standing: { template: 'survival', fleeAtHealth: 12 }, parameters: { fightAtHealth: 12, fleeAtHealth: 12 } },
	]) {
		const before = structuredClone(args);
		const normalized = normalizeMinecraftToolCall('runProgram', args);
		assert.equal(normalized.parameters.fightAtHealth, 12);
		assert.equal(normalized.parameters.fleeAtHealth, undefined);
		assert.match(JSON.stringify(toolAdjustments(normalized)), /parameters.fightAtHealth.*engage\/bailout threshold/);
		assert.deepEqual(args, before);
	}
	for (const args of [
		{ standing: { template: 'survival', fleeAtHealth: 12 }, parameters: { fightAtHealth: 8 } },
		{ standing: { template: 'survival' }, parameters: { fleeAtHealth: 12, fightAtHealth: 8 } },
		{ standing: { template: 'survival', fightAtHealth: 8 }, parameters: { fleeAtHealth: 12 } },
	]) assert.throws(() => normalizeMinecraftToolCall('runProgram', args), /Conflicting/);
	for (const fleeAtHealth of [null, false, 0, 21]) assert.throws(() => normalizeMinecraftToolCall('runProgram', {
		standing: { template: 'survival', fleeAtHealth },
	}), /parameters.fightAtHealth/);
});

test('oversized run and queued program deadlines clamp with notes, including expected duration', () => {
	for (const name of ['runProgram', 'queueProgram']) {
		const tool = normalizeMinecraftToolCall(name, { source: 'await player.wait(1);', timeoutMs: 800_000, expectedDurationMs: 700_000, ...(name === 'queueProgram' ? { afterProgramId: 'p', goalRevision: 1, programVersion: 1, precondition: 'true' } : {}) });
		assert.equal(tool.timeoutMs, 600_000); assert.equal(tool.expectedDurationMs, 600_000);
		assert.match(toolAdjustments(tool).timeoutMs, /max, asked 800000/);
		assert.match(toolAdjustments(tool).expectedDurationMs, /max, asked 700000/);
	}
});
