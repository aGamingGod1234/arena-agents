import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeEncoding, analyzeNativeEventInputs, analyzeObservationChanges, renderMarkdown, runBenchmark, semanticFixtures, summarizeMeasurements } from '../src/benchmark/native-input-encoding.mjs';
import { ModelObservationViews, encodeModelFacts, decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';

test('input benchmark rejects lost facts and mutation instead of publishing apparent savings', () => {
	const replies = [{ index: 0, tool: 'observe', value: { dead: false, health: null, coverage: { complete: false } } }];
	assert.throws(() => analyzeEncoding({ replies, encode: () => ({}), decode: value => value }), /fact reconstruction/);
	assert.throws(() => analyzeEncoding({ replies, encode: value => { delete value.health; return value; }, decode: value => value }), /input mutation/);
});

test('byte and proxy totals count each reply once and preserve category arithmetic', () => {
	const measured = [
		{ tool: 'observe', beforeBytes: 100, afterBytes: 60, changed: true },
		{ tool: 'observe', beforeBytes: 40, afterBytes: 40, changed: false },
		{ tool: 'programStatus', beforeBytes: 10, afterBytes: 9, changed: true },
	];
	const report = summarizeMeasurements(measured, [50, 30, 20, 20, 4, 5]);
	assert.deepEqual(report.total, { replies: 3, changedReplies: 2, exactReconstructions: 3, beforeBytes: 150,
		afterBytes: 109, beforeProxyTokens: 74, afterProxyTokens: 55, proxyTokenRegressionReplies: 1,
		proxyTokenRegressionTokens: 1, byteReductionPercent: 27.333, proxyTokenReductionPercent: 25.676 });
	assert.equal(report.byTool.observe.beforeBytes, 140);
	assert.equal(report.byTool.observe.afterProxyTokens, 50);
	assert.equal(report.byTool.programStatus.proxyTokenReductionPercent, -25, 'report tokenizer regressions honestly');
	assert.throws(() => summarizeMeasurements(measured, [5]), /6/);
});

test('offline replay report uses the real encoder, exact JSON recovery and explicit evidence limits', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'arena-native-input-benchmark-'));
	try {
		const fixture = path.join(directory, 'responses.json');
		const before = path.join(directory, 'before.json'), after = path.join(directory, 'after.json');
		const scenarios = semanticFixtures();
		await writeFile(fixture, JSON.stringify({ payloads: scenarios.map(row => ({ value: row.value })) }));
		await writeFile(before, JSON.stringify({ baseInstructions: 'Longer original stable instructions.', dynamicTools: [{ name: 'observe' }] }));
		await writeFile(after, JSON.stringify({ baseInstructions: 'Short instructions.', dynamicTools: [{ name: 'observe', format: 'documented' }] }));
		const result = await runBenchmark({ inputPath: fixture, beforeContextPath: before, afterContextPath: after });
		assert.equal(result.providerUsed, false);
		assert.equal(result.paidModelCalls, 0);
		assert.equal(result.minecraftServerUsed, false);
		assert.equal(result.installedClientVerified, false);
		assert.equal(result.replay.total.exactReconstructions, scenarios.length);
		assert.ok(result.replay.total.afterBytes <= result.replay.total.beforeBytes);
		assert.equal(result.semanticChecks.length, 7);
		assert.ok(result.semanticChecks.every(row => row.result === 'PASSED'));
		assert.equal(result.rowShapeChecks.exactReconstructions, 80);
		assert.equal(result.staticContextTotal.beforeBytes, result.staticContext.reduce((total, row) => total + row.beforeBytes, 0));
		assert.equal(result.staticContext.length, 2);
		assert.ok(result.staticContext.find(row => row.name === 'dynamicTools').byteReductionPercent < 0);
		assert.equal(result.tokenizer, null);
		const markdown = renderMarkdown(result);
		assert.match(markdown, /does not prove model comprehension or unchanged gameplay decisions/);
		assert.match(markdown, /No paid model requests/);
		assert.doesNotMatch(markdown, /00000000-0000-4000-8000/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('changes replay reconstructs removals and restarts snapshots after death, dimension change or stale facts', () => {
	const initial = semanticFixtures()[0].value;
	const observed = observation => ({ goalSpec: { originalRequest: 'fixture task' }, observation,
		freshness: { fresh: true }, eventSequence: 1 });
	const next = { ...structuredClone(initial), player: { ...initial.player, health: 18 } };
	delete next.coverage;
	const death = { ...structuredClone(next), player: { ...next.player, dead: true, health: 0 } };
	const respawn = { ...structuredClone(initial) };
	const dimension = { ...structuredClone(initial), world: { ...initial.world, dimension: 'minecraft:the_nether' } };
	const values = [observed(initial), observed(next), observed(death), observed(respawn), observed(dimension),
		{ ...observed(dimension), freshness: { fresh: false } }];
	const result = analyzeObservationChanges({ replies: values.map((value, index) => ({ value, index })),
		ModelObservationViews, encode: encodeModelFacts, decode: decodeModelFacts });
	assert.equal(result.fullReplies, 5);
	assert.equal(result.changeReplies, 1);
	assert.equal(result.raw.length, 6);
	assert.ok(result.raw[1].afterBytes < result.raw[1].beforeBytes);
	assert.equal(JSON.parse(result.raw[1].after).observationView.remove[0], 'coverage');
});

test('production event input encoding preserves bounded facts and imperative heading or retry suffix', () => {
	const replies = semanticFixtures().map(({ value }, index) => ({ index, value: { observation: value } }));
	const result = analyzeNativeEventInputs({ replies, buildNativeEventInput, encodeNativeEventInput, decode: decodeModelFacts });
	assert.equal(result.length, replies.length);
	assert.ok(result.some(row => row.changed));
	for (const row of result) {
		assert.equal(row.before.slice(0, row.before.indexOf('\n')), row.after.slice(0, row.after.indexOf('\n')));
		assert.equal(row.before.slice(row.before.lastIndexOf('\n')), row.after.slice(row.after.lastIndexOf('\n')));
	}
	const nonNative = `Compiler error. Correct the source.\n${JSON.stringify({ source: 'await player.wait(1);', observation: semanticFixtures()[0].value })}\nKeep exact action requirements.`;
	assert.equal(encodeNativeEventInput(nonNative), nonNative, 'non-native structured JSON must not acquire a facts wrapper');
	assert.equal(encodeNativeEventInput('not a structured event'), 'not a structured event');
});

test('native event benchmark rejects a missing promoted HUD fact', () => {
 const replies = [{ index: 0, value: { observation: { player: { health: 4, maxHealth: 20 } } } }];
 const loseHealth = input => {
  const lines = encodeNativeEventInput(input).split('\n');
  const value = decodeModelFacts(JSON.parse(lines[1]));
  delete value.observation.health;
  lines[1] = JSON.stringify(value);
  return lines.join('\n');
 };
 assert.throws(() => analyzeNativeEventInputs({ replies, buildNativeEventInput, encodeNativeEventInput: loseHealth, decode: decodeModelFacts }), /native event facts/);
});

test('native event benchmark accepts merged presentation but rejects lost appearance, effect and flight facts', () => {
	const observation = {
		player: { health: 12, effects: [{ effectId: 'minecraft:speed', amplifier: 0, seconds: 9 }] },
		world: { worldId: 'merged-facts', dimension: 'minecraft:overworld' },
		entities: [{ type: 'minecraft:zombie', name: 'Zombie', appearance: { baby: true },
			bounds: { minX: 0, minY: 64, minZ: 0, maxX: 1, maxY: 66, maxZ: 1 } }],
		perception: { events: [{ type: 'eye_of_ender_flight', flightId: 7, from: { x: 0, y: 64, z: 0 },
			to: { x: 8, y: 68, z: 0 }, yaw: -90, vertical: 'rose', outcome: 'shattered' }] },
	};
	const replies = [{ index: 0, value: { observation } }];
	const before = structuredClone(replies);
	const [result] = analyzeNativeEventInputs({ replies, buildNativeEventInput, encodeNativeEventInput, decode: decodeModelFacts });
	const facts = decodeModelFacts(JSON.parse(result.after.split('\n')[1])).observation;
	assert.deepEqual(facts.entityAppearance, { baby: [0] });
	assert.deepEqual(facts.entities[0].bounds, [0, 64, 0, 1, 66, 1]);
	assert.deepEqual(facts.player.effects, [['minecraft:speed', 0, 9]]);
	assert.equal(facts.eye7, '0,64,0 -90/8 up@68 broke');
	for (const lose of [value => delete value.entityAppearance, value => delete value.player.effects,
		value => delete value.eye7, value => delete value.entities[0].bounds]) {
		const lossyEncoder = input => {
			const lines = encodeNativeEventInput(input).split('\n');
			const value = decodeModelFacts(JSON.parse(lines[1]));
			lose(value.observation);
			lines[1] = JSON.stringify(value);
			return lines.join('\n');
		};
		assert.throws(() => analyzeNativeEventInputs({ replies, buildNativeEventInput,
			encodeNativeEventInput: lossyEncoder, decode: decodeModelFacts }), /native event facts/);
	}
	assert.deepEqual(replies, before, 'benchmark presentation does not mutate recorded facts');
});

test('benchmark CLI rejects report destinations that would overwrite the JSON report before measuring', async () => {
	const { execFile } = await import('node:child_process');
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	const cli = fileURLToPath(new URL('../src/benchmark/native-input-encoding.mjs', import.meta.url));
	const run = (args, cwd) => new Promise(resolve => execFile(process.execPath, [cli, ...args], { cwd, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stderr })));
	const directory = await mkdtemp(path.join(os.tmpdir(), 'arena-native-input-cli-'));
	try {
		const fixture = path.join(directory, 'responses.json');
		await writeFile(fixture, JSON.stringify({ payloads: semanticFixtures().map(row => ({ value: row.value })) }));
		const sentinel = path.join(directory, 'report.txt');
		await writeFile(sentinel, 'keep');
		for (const args of [['--output', sentinel], ['--output', path.join(directory, 'same.json'), '--markdown', path.join(directory, 'same.json')],
			['--output', 'same.json', '--markdown', path.join(directory, 'same.json')]]) {
			const result = await run(['--input', fixture, ...args], directory);
			assert.notEqual(result.code, 0, args.join(' '));
			assert.match(result.stderr, /--output must end in \.json|--markdown must differ/);
		}
		assert.equal(await readFile(sentinel, 'utf8'), 'keep');
		const output = path.join(directory, 'report.json');
		const ok = await run(['--input', fixture, '--output', output, '--markdown', path.join(directory, 'notes.md')], directory);
		assert.equal(ok.code, 0, ok.stderr);
		assert.ok(JSON.parse(await readFile(output, 'utf8')));
		assert.match(await readFile(path.join(directory, 'notes.md'), 'utf8'), /\S/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
