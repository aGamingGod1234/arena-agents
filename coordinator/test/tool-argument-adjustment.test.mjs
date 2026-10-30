import assert from 'node:assert/strict';
import test from 'node:test';

import { annotateAdjustments, MINECRAFT_DYNAMIC_TOOLS, normalizeMinecraftToolCall, presentedTool, toolAdjustments } from '../src/native-minecraft-tools.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';

const reject = (name, args) => assert.throws(() => normalizeMinecraftToolCall(name, args), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' }, `${name} ${JSON.stringify(args)}`);

test('page sizes above their maximum are clamped and reported', () => {
	const cases = [
		['survey', { limit: 64 }, 'limit', 8, (tool) => tool.limit],
		['inspect', { section: 'inventory', limit: 100 }, 'limit', 32, (tool) => tool.limit],
		['inspect', { section: 'survey', limit: 20 }, 'limit', 8, (tool) => tool.limit],
		['lookAround', { centerYaw: 0, pitch: 0, steps: 4, ticksPerStep: 2, survey: { limit: 30 } }, 'survey.limit', 8, (tool) => tool.survey.limit],
		['exploreFrontier', { limit: 99 }, 'limit', 24, (tool) => tool.arguments.limit],
		['exploreFrontier', { radius: 1000 }, 'radius', 256, (tool) => tool.arguments.radius],
		['queryMemory', { limit: 500 }, 'limit', 64, (tool) => tool.limit],
		['taskMemory', { operation: 'query', query: { limit: 500 } }, 'query.limit', 64, (tool) => tool.query.limit],
	];
	for (const [name, args, field, expected, read] of cases) {
		const tool = normalizeMinecraftToolCall(name, args);
		assert.equal(read(tool), expected, name);
		assert.match(toolAdjustments(tool)[field], new RegExp(`^${expected} \\(max, asked `), name);
	}
	// The caller's object is not modified.
	const args = { limit: 64 };
	normalizeMinecraftToolCall('survey', args);
	assert.equal(args.limit, 64);
});

test('page sizes below the minimum and fractional sizes are bounded; in-range values are untouched', () => {
	assert.equal(normalizeMinecraftToolCall('survey', { limit: 0 }).limit, 1);
	assert.equal(normalizeMinecraftToolCall('survey', { limit: 3.4 }).limit, 3);
	const plain = normalizeMinecraftToolCall('survey', { limit: 5 });
	assert.equal(toolAdjustments(plain), undefined);
	// A string is not a number the model meant as a size: still rejected.
	reject('survey', { limit: '64' });
	reject('inspect', { section: 'inventory', limit: Number.POSITIVE_INFINITY });
});

test('overlong intent commentary is cut at a word boundary, step is never cut', () => {
	const why = 'gather wood quickly so the pickaxe can be crafted before dark and then continue toward the iron seen earlier near the river bend and cliffs';
	const tool = normalizeMinecraftToolCall('taskPlan', { operation: 'intent', intent: { step: 'wood', why, next: 'craft\nplanks' } });
	assert.ok(tool.intent.why.length <= 100);
	assert.ok(tool.intent.why.endsWith('…'));
	assert.ok(why.startsWith(tool.intent.why.slice(0, -1).trimEnd()));
	assert.equal(/\s…$/.test(tool.intent.why), false);
	assert.match(why.slice(tool.intent.why.length - 1), /^\s/);
	assert.match(toolAdjustments(tool)['intent.why'], /max 100/);
	assert.equal(tool.intent.next, 'craft planks');
	reject('taskPlan', { operation: 'intent', intent: { step: 's'.repeat(49), why: 'ok' } });
	reject('taskPlan', { operation: 'intent', intent: { step: 'wood' } });
});

test('overlong finish summaries are cut', () => {
	const summary = `${'done with the wood and stone tools '.repeat(30)}`;
	const tool = normalizeMinecraftToolCall('finish', { summary });
	assert.ok(tool.summary.length <= 512);
	assert.ok(toolAdjustments(tool).summary);
	const sequence = normalizeMinecraftToolCall('sequence', { actions: [{ actionType: 'wait', arguments: { durationMs: 100 } }, { actionType: 'wait', arguments: { durationMs: 100 } }], finish: { summary } });
	assert.ok(sequence.finish.summary.length <= 512);
	assert.ok(toolAdjustments(sequence)['finish.summary']);
	reject('finish', { summary: '   ' });
});

test('harmless extras are ignored with a note', () => {
	const queued = normalizeMinecraftToolCall('queueProgram', { afterProgramId: 'p1', goalRevision: 1, programVersion: 1, precondition: 'true', source: 'wait(100)', background: true });
	assert.equal(queued.background, undefined);
	assert.match(toolAdjustments(queued).background, /background/);
});

test('arguments that choose a physical target or meaning are still rejected', () => {
	reject('inspect', { section: 'item', slot: 300 });
	reject('inspect', { section: 'block', x: 1e9, y: 64, z: 0 });
	reject('inspect', { section: 'inventory', unknownField: 1 });
	reject('inspect', { section: 'inventory', include: ['poi'] });
	reject('inspect', { section: 'not_a_section', limit: 5 });
	reject('moveTo', { x: 1e9, y: 64, z: 0 });
	reject('mine', { x: 1, y: 64, z: 2, expectedBlockId: 'minecraft:stone', unknown: true });
	reject('wait', { durationMs: 99_999_999 });
	reject('runProgram', { source: 'wait(1)', planner: 'another-model' });
	reject('queueProgram', { afterProgramId: 'p1', goalRevision: 1, programVersion: 1, precondition: 'true', source: 'wait(1)', timeoutMs: -1 });
	reject('notebook', { key: 'k', text: 'x'.repeat(2049) });
	reject('takeTask', { request: 'x'.repeat(513) });
	reject('say', { message: 'x'.repeat(5000) });
	reject('act', { actionType: 'break_block', arguments: {} });
	reject('sequence', { actions: [{ actionType: 'wait', arguments: { durationMs: 1 } }], finish: { summary: 'x' } });
	reject('lookAround', { centerYaw: 400, pitch: 0, steps: 4, ticksPerStep: 2 });
	reject('survey', { include: ['not_a_section'] });
});

test('intent text lengths are stated in the advertised schema', () => {
	const intent = MINECRAFT_DYNAMIC_TOOLS.find((tool) => tool.name === 'taskPlan').inputSchema.properties.intent.properties;
	assert.deepEqual(Object.fromEntries(Object.entries(intent).map(([key, schema]) => [key, schema.maxLength])), { step: 48, why: 100, via: 100, until: 100, unless: 100, next: 100 });
});

test('adjustment notes reach the model in the tool result', () => {
	const tool = normalizeMinecraftToolCall('survey', { limit: 64 });
	const { response } = presentNativeToolResult({ section: 'survey', entries: [] }, tool);
	const parsed = JSON.parse(response.contentItems[0].text);
	assert.match(parsed.adjusted.limit, /^8 \(max, asked 64\)/);
	assert.equal(parsed.section, 'survey');
	const copy = presentedTool(tool, { view: 'full' });
	assert.deepEqual(toolAdjustments(copy), toolAdjustments(tool));
	assert.equal(JSON.parse(presentNativeToolResult({ ok: 1 }, normalizeMinecraftToolCall('survey', { limit: 4 })).response.contentItems[0].text).adjusted, undefined);
	assert.equal(annotateAdjustments('[1]', { a: 'b' }), 'adjusted: {"a":"b"}\n[1]');
});

test('adjusted results stay within the result limit and long valid text is untouched', () => {
	const tool = normalizeMinecraftToolCall('inspect', { section: 'inventory', limit: 100 });
	const entries = Array.from({ length: 400 }, (_, index) => ({ slot: index, itemId: 'minecraft:cobblestone', count: 64, note: 'x'.repeat(20) }));
	for (const size of [0, 100, 200, 300, 400]) {
		const { response } = presentNativeToolResult({ section: 'inventory', entries: entries.slice(0, size) }, tool);
		assert.ok(Buffer.byteLength(response.contentItems[0].text, 'utf8') <= 16_384, `size ${size}`);
	}
	const emoji = '😀'.repeat(300);
	const finish = normalizeMinecraftToolCall('finish', { summary: emoji });
	assert.equal(finish.summary, emoji);
	assert.equal(toolAdjustments(finish), undefined);
	const cut = normalizeMinecraftToolCall('finish', { summary: '😀'.repeat(600) });
	assert.equal(Array.from(cut.summary).length, 512);
	const sequence = normalizeMinecraftToolCall('sequence', { actions: [{ actionType: 'wait', arguments: { durationMs: 100 } }, { actionType: 'wait', arguments: { durationMs: 100 } }], finish: { summary: emoji } });
	assert.equal(sequence.finish.summary, emoji);
	// Normalizing the same call twice yields one note, not a stacked one.
	const again = normalizeMinecraftToolCall('survey', { limit: 64 });
	assert.deepEqual(toolAdjustments(again), toolAdjustments(normalizeMinecraftToolCall('survey', { limit: 64 })));
});
