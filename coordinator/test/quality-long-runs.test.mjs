import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeArtifactReport, readArtifactReport, hydrateArtifactReport, isScalar, MAX_SUMMARY_REPORT_BYTES, SHORT_STRING_BYTES } from '../src/benchmark/report-artifacts.mjs';
import { normalizeHeadlessScenario, runHeadlessScenario } from '../src/headless-matrix.mjs';
import { parseArgs, buildQualityScenario, resolveQualityScenarios } from '../../scripts/quality/run-scenarios.mjs';
import { applyQualitySetup } from '../src/benchmark/quality-scenarios.mjs';
import { extractQualityMetrics } from '../src/benchmark/quality-metrics.mjs';

const scenarios = JSON.parse(await readFile(new URL('../../scripts/quality/scenarios.json', import.meta.url))).scenarios;
const profile = { provider: 'codex', model: 'fixture', reasoningEffort: 'low', serviceTier: 'priority' };
const execute = promisify(execFile);
const p = (type, at, payload) => ({ type, at, payload });
const observation = (at, x, items = [], dimension = 'minecraft:overworld') => p('observation', at, { observedAtEpochMs: at, dimension, position: { x, y: 64, z: 0 }, inventory: { items: items.map(id => ({ itemId: `minecraft:${id}`, count: 1 })) } });
const action = (id, type, at, args, state = 'SUCCEEDED', code = null, target = null) => [p('action_command', at, { actionId: id, actionType: type, arguments: args }),
	p('action_result', at + 1, { actionId: id, actionType: type, state, reasonCode: code, observedAtEpochMs: at + 1, ...(target ? { actionObservation: { target } } : {}) })];
const extract = (rows, samples = []) => extractQualityMetrics({ protocolRows: rows, samples, scenario: scenarios.at(-1), profile, startedAt: 1000, endedAt: 60000 });

test('30/60-minute reports retain all calls and samples in movable, integrity-checked artifacts', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'quality-packaging-'));
	try {
		for (const minutes of [30, 60]) {
			const file = path.join(dir, `${minutes}.json`);
			const report = { runs: [{ scenario: 'S7', metrics: { modelCalls: minutes * 15, deaths: 2, tokens: { input: 123 },
				modelCallDetails: Array.from({ length: minutes * 15 }, (_, i) => ({ index: i, tokens: { input: 5000, cacheRead: 80000, output: 250 }, evidence: 'x'.repeat(600) })),
				timeline: Array.from({ length: minutes * 60 }, (_, i) => ({ at: i * 1000, position: { x: i, y: 64, z: 0 }, entityNbt: 'sample'.repeat(150) })) } }] };
			assert.ok(Buffer.byteLength(JSON.stringify(report)) > MAX_SUMMARY_REPORT_BYTES);
			const summary = await writeArtifactReport(file, report);
			assert.ok((await readFile(file)).length <= MAX_SUMMARY_REPORT_BYTES);
			assert.equal(summary.runs[0].metrics.modelCalls, minutes * 15);
			assert.equal(summary.runs[0].metrics.modelCallDetails.reportArtifact.count, minutes * 15);
			assert.deepEqual(await readArtifactReport(file), report);
		}
		const summary = JSON.parse(await readFile(path.join(dir, '60.json')));
		const ref = summary.runs[0].metrics.modelCallDetails.reportArtifact;
		await writeFile(path.join(dir, ref.path), '[]');
		await assert.rejects(readArtifactReport(path.join(dir, '60.json')), /integrity mismatch/);
		ref.path = '../outside.json';
		await writeFile(path.join(dir, 'bad.json'), JSON.stringify(summary));
		await assert.rejects(readArtifactReport(path.join(dir, 'bad.json')), /Invalid report artifact path/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('summary bound also holds for many large run objects and strings', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'quality-packaging-'));
	try {
		const value = { status: 'PASSED', runs: Array.from({ length: 80 }, (_, i) => ({ index: i, text: 'x'.repeat(8000), metrics: { value: i } })) };
		const file = path.join(dir, 'results.json');
		await writeArtifactReport(file, value);
		assert.ok((await readFile(file)).length <= MAX_SUMMARY_REPORT_BYTES);
		assert.deepEqual(await readArtifactReport(file), value);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('overflowing summaries keep structural entry ids, statuses and scalar metrics inline', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'quality-packaging-'));
	try {
		const entry = i => ({ scenarioId: `S${i}`, status: i % 3 ? 'PASSED' : 'FAILED', classification: 'TIMEOUT', metrics: { modelCalls: i, deaths: 1,
			detail: Object.fromEntries(Array.from({ length: 300 }, (_, k) => [`k${k}`, `${i}-${k}-${'v'.repeat(30)}`])) } });
		const reports = { matrix: { runId: 'm', status: 'FAILED', scenarios: Array.from({ length: 24 }, (_, i) => entry(i)) },
			paired: { schemaVersion: 3, arms: { A: { runs: Array.from({ length: 12 }, (_, i) => entry(i)) }, B: { runs: Array.from({ length: 12 }, (_, i) => entry(i + 12)) } }, sequence: Array.from({ length: 24 }, (_, i) => ({ pairId: `S${i}-r1`, arm: i % 2 ? 'B' : 'A' })) } };
		for (const [name, value] of Object.entries(reports)) {
			const file = path.join(dir, `${name}.json`);
			assert.ok(Buffer.byteLength(JSON.stringify(value)) > MAX_SUMMARY_REPORT_BYTES);
			await writeArtifactReport(file, value);
			const summary = JSON.parse(await readFile(file, 'utf8'));
			assert.ok(Buffer.byteLength(JSON.stringify(summary)) < MAX_SUMMARY_REPORT_BYTES);
			const entries = name === 'matrix' ? summary.scenarios : [...summary.arms.A.runs, ...summary.arms.B.runs];
			assert.ok(Array.isArray(entries) && entries.length === 24);
			entries.forEach((run, i) => { assert.equal(run.scenarioId, `S${i}`); assert.equal(run.status, entry(i).status); assert.equal(run.metrics.modelCalls, i); });
			if (name === 'paired') assert.equal(summary.sequence[23].pairId, 'S23-r1');
			assert.deepEqual(await readArtifactReport(file), value);
		}
		// Fallback: only sub-512-byte details remain, so whole records must move; each entry's scalar metrics still stay inline.
		const scalars = i => Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`m${k}`, i * 100 + k]));
		const small = i => ({ ...scalars(i), groups: Object.fromEntries(Array.from({ length: 60 }, (_, g) => [`g${g}`, Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`k${k}`, `${i}-${g}-${k}-vvvvvv`]))])) });
		const fallback = { runs: Array.from({ length: 24 }, (_, i) => ({ scenario: `S${i}`, measurementStatus: 'MEASURED', metrics: small(i) })) };
		const file = path.join(dir, 'fallback.json');
		assert.ok(Buffer.byteLength(JSON.stringify(fallback)) > MAX_SUMMARY_REPORT_BYTES);
		await writeArtifactReport(file, fallback);
		const summary = JSON.parse(await readFile(file, 'utf8'));
		assert.ok(Buffer.byteLength(JSON.stringify(summary)) + 1 <= MAX_SUMMARY_REPORT_BYTES);
		summary.runs.forEach((run, i) => {
			assert.equal(run.scenario, `S${i}`);
			assert.equal(run.metrics.reportArtifact, undefined, `runs[${i}].metrics moved whole`);
			for (const [name, metric] of Object.entries(scalars(i))) assert.equal(run.metrics[name], metric);
		});
		assert.ok(summary.runs.some(run => run.metrics.groups.reportArtifact));
		assert.deepEqual(await readArtifactReport(file), fallback);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

// Property check helpers. Scalars are reached through records and runs/scenarios-style arrays, as the writer defines them.
const STRUCTURAL = new Set(['runs', 'scenarios', 'firstAttemptRuns', 'history', 'sequence']);
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !v.reportArtifact;
const scalarField = v => v === null || typeof v !== 'object' && !(typeof v === 'string' && Buffer.byteLength(v) > SHORT_STRING_BYTES);
function hiddenScalars(original, summary) {
	let hidden = 0;
	const walk = (o, s) => {
		for (const [key, value] of Object.entries(o)) {
			const inline = isPlain(s) ? s[key] : undefined;
			if (scalarField(value)) { if (!isPlain(s) || !(key in s) || inline !== value) hidden++; }
			else if (isPlain(value)) walk(value, inline);
			else if (Array.isArray(value) && STRUCTURAL.has(key)) value.forEach((item, i) => isPlain(item) && walk(item, Array.isArray(inline) ? inline[i] : undefined));
		}
	};
	walk(original, summary);
	return hidden;
}
// Oracle: the summary size if every non-scalar detail that saves bytes became a reference. Recursing into scalar-free records
// overestimates slightly, so "fits" here guarantees the writer can keep every scalar inline.
function scalarsAloneFit(report) {
	const reference = (size, count) => ({ reportArtifact: { version: 1, path: `report-artifacts/${'0'.repeat(64)}.json`, sha256: '0'.repeat(64), bytes: size, ...(count === undefined ? {} : { count }) } });
	const shrink = (value, key) => {
		if (Array.isArray(value) && STRUCTURAL.has(key)) return value.map(item => shrink(item, ''));
		if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, k)]));
		if (scalarField(value)) return value;
		const size = Buffer.byteLength(JSON.stringify(value)), ref = reference(size, Array.isArray(value) ? value.length : undefined);
		return Buffer.byteLength(JSON.stringify(ref)) < size ? ref : value;
	};
	return Buffer.byteLength(JSON.stringify(shrink(report, ''))) + 1 <= MAX_SUMMARY_REPORT_BYTES;
}
const seeded = seed => () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
function generatedQualityReport(runs, seed, scalarCount = null) {
	const rand = seeded(seed), n = k => Math.floor(rand() * k);
	const scalar = k => [n(1e6), rand() > 0.5, `v${n(1000)}`, null, Math.round(rand() * 1e4) / 100][k % 5];
	return { schemaVersion: 2, benchmark: 'generated', runs: Array.from({ length: runs }, (_, i) => ({
		scenario: `S${i % 8}`, repetition: i + 1, status: rand() > 0.2 ? 'PASSED' : 'FAILED', termination: ['TIMEOUT', 'PASSED', 'NO_REPORT'][n(3)], measurementStatus: 'MEASURED',
		metrics: { ...Object.fromEntries(Array.from({ length: scalarCount ?? 20 + n(36) }, (_, k) => [`m${k}`, scalar(k + n(5))])),
			// Many small arrays beside the scalars: each saves bytes when moved but is far below any fixed size floor.
			...Object.fromEntries(Array.from({ length: n(16) }, (_, k) => [`h${k}`, Array.from({ length: 20 + n(60) }, () => n(1e6))])),
			calls: Array.from({ length: n(200) }, (_, k) => ({ index: k, tokens: { input: n(9e4), output: n(900) } })),
			timeline: Array.from({ length: n(600) }, (_, k) => ({ at: k * 1000, x: n(500), z: n(500) })),
			coverage: { ratio: rand(), samples: n(50), gaps: Array.from({ length: n(30) }, () => n(1e5)) },
			position: [n(300), 64, n(300)], notes: 'n'.repeat(n(3000)),
			extra: { log: Array.from({ length: n(40) }, (_, k) => ({ k, at: n(1e9) })), trace: 't'.repeat(n(800)) } } })) };
}

test('property: scalars never move while details remain; bound and exact restore hold for 24/30/60/100 runs', async () => {
	// In-memory files: hundreds of small artifacts per case make disk I/O dominate; disk paths are covered above.
	const files = new Map(), file = path.resolve('memory', 'summary.json');
	const io = { write: async (target, text) => { files.set(path.resolve(target), text); }, makeDirectory: async () => {} };
	const read = async target => { if (!files.has(path.resolve(target))) throw new Error(`missing ${target}`); return files.get(path.resolve(target)); };
	const pack = async value => {
		files.clear();
		const summary = await writeArtifactReport(file, value, io);
		const text = files.get(file);
		assert.ok(Buffer.byteLength(text) <= MAX_SUMMARY_REPORT_BYTES);
		assert.deepEqual(await hydrateArtifactReport(JSON.parse(text), file, { read }), value);
		return summary;
	};
	const fallbacks = summary => (JSON.stringify(summary).match(/"scalarFallback":true/g) ?? []).length;
	let fitted = 0;
	for (const runs of [24, 30, 60, 100]) for (const seed of [1, 2]) {
		const value = generatedQualityReport(runs, runs * 7919 + seed);
		assert.ok(Buffer.byteLength(JSON.stringify(value)) > MAX_SUMMARY_REPORT_BYTES, `${runs}/${seed} must overflow`);
		const summary = await pack(value);
		if (scalarsAloneFit(value)) {
			fitted++;
			assert.equal(hiddenScalars(value, summary), 0, `${runs}/${seed} hid scalars although they fit alone`);
			assert.equal(fallbacks(summary), 0);
		}
	}
	assert.ok(fitted >= 6, 'most generated cases must exercise the invariant');
	// Scalars alone cannot fit: the recorded fallback still keeps the bound, entry ids and exact restore.
	const value = generatedQualityReport(100, 3, 600);
	assert.equal(scalarsAloneFit(value), false);
	const summary = await pack(value);
	assert.ok(fallbacks(summary) > 0);
	summary.runs.forEach((run, i) => { assert.equal(run.repetition, i + 1); assert.equal(run.status, value.runs[i].status); });
});

test('short strings are classified by raw UTF-8 bytes, not JSON-escaped length', async () => {
	const sized = (unit, total) => unit.repeat(Math.floor(total / Buffer.byteLength(unit)));
	for (const [label, unit] of [['ASCII', 'a'], ['quotes', '"'], ['backslashes', '\\'], ['control characters', '\u0000'], ['newlines', '\n'], ['2-byte', 'é'], ['emoji', '🙂']]) {
		const at = sized(unit, 256), over = sized(unit, 256 + Buffer.byteLength(unit));
		assert.equal(Buffer.byteLength(at) <= 256 && Buffer.byteLength(over) > 256, true, label);
		assert.equal(isScalar(at), true, `${label} at ${Buffer.byteLength(at)} bytes is a scalar`);
		assert.equal(isScalar(over), false, `${label} at ${Buffer.byteLength(over)} bytes is a detail`);
	}
	for (const n of [254, 255, 256]) assert.equal(isScalar('a'.repeat(n)), true, `${n} ASCII bytes`);
	assert.equal(isScalar('a'.repeat(257)), false);
	// Barely over the cap: a 256-byte string of quotes stays inline as a scalar, and the 257-byte detail moves instead.
	const metrics = { label: '"'.repeat(256), detail: 'd'.repeat(257) };
	const report = { runs: [{ scenario: 'S1', status: 'PASSED', metrics }] };
	for (let k = 0; Buffer.byteLength(JSON.stringify(report)) < MAX_SUMMARY_REPORT_BYTES - 250; k++) metrics[`p${k}`] = 'x'.repeat(200);
	metrics.pad = 'y'.repeat(Math.min(256, MAX_SUMMARY_REPORT_BYTES + 20 - Buffer.byteLength(JSON.stringify(report)) - 10));
	const files = new Map(), file = path.resolve('memory', 'boundary.json');
	const summary = await writeArtifactReport(file, report, { write: async (target, text) => { files.set(path.resolve(target), text); }, makeDirectory: async () => {} });
	assert.ok(Buffer.byteLength(JSON.stringify(report)) + 1 > MAX_SUMMARY_REPORT_BYTES);
	assert.ok(Buffer.byteLength(files.get(file)) <= MAX_SUMMARY_REPORT_BYTES);
	assert.equal(summary.runs[0].metrics.label, metrics.label);
	assert.ok(summary.runs[0].metrics.detail.reportArtifact);
	assert.doesNotMatch(files.get(file), /scalarFallback/);
	assert.deepEqual(await hydrateArtifactReport(JSON.parse(files.get(file)), file, { read: async target => files.get(path.resolve(target)) }), report);
});

test('PowerShell packaging uses the same artifact writer and keeps scenario summaries bounded', { skip: process.platform !== 'win32' }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'quality-powershell-packaging-'));
	try {
		const file = path.join(dir, 'report.json'), input = path.join(dir, 'input.json');
		const value = { status: 'PASSED', metrics: { calls: Array.from({ length: 1200 }, (_, i) => ({ index: i, text: 'x'.repeat(600) })), tokens: { input: 99 } } };
		await writeFile(input, JSON.stringify(value));
		const script = fileURLToPath(new URL('../../scripts/run-headless-provider-matrix.ps1', import.meta.url));
		const quote = s => `'${s.replaceAll("'", "''")}'`;
		await execute('powershell.exe', ['-NoProfile', '-Command', `. ${quote(script)} -ProjectRoot ${quote(path.dirname(path.dirname(script)))} -FunctionsOnly; Write-ArtifactSummary ${quote(file)} (Get-Content -LiteralPath ${quote(input)} -Raw | ConvertFrom-Json)`], { windowsHide: true, timeout: 30000 });
		assert.ok((await readFile(file)).length <= MAX_SUMMARY_REPORT_BYTES);
		assert.deepEqual(await readArtifactReport(file), value);
		const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', `. ${quote(script)} -ProjectRoot ${quote(path.dirname(path.dirname(script)))} -FunctionsOnly; $r = Read-ArtifactSummary ${quote(file)} 262144 'fixture'; Write-Output $r.metrics.calls.Count`], { windowsHide: true, timeout: 30000 });
		assert.equal(Number(stdout.trim()), 1200);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('PowerShell read and rewrite of an artifact summary keeps non-ASCII text exact', { skip: process.platform !== 'win32' }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'quality-powershell-utf8-'));
	try {
		const file = path.join(dir, 'report.json');
		const value = { scenarioId: 'S7', status: 'PASSED', classification: 'naïve – ok', diagnostics: 'Serveur arrêté: §cplayer died §r',
			chat: Array.from({ length: 60 }, (_, i) => ({ index: i, message: `café – “q” ✓ 🙂 §a #${i}` })),
			items: Array.from({ length: 60 }, (_, i) => ({ index: i, name: `Épée «diamant» ${i}`, lore: 'Ünïcödé ½ ∞' })),
			modelNotes: Array.from({ length: 60 }, (_, i) => ({ index: i, note: `思考: 鉄を探す – ${i}` })) };
		await writeArtifactReport(file, value);
		assert.match(await readFile(file, 'utf8'), /"reportArtifact"/);
		const script = fileURLToPath(new URL('../../scripts/run-headless-provider-matrix.ps1', import.meta.url));
		const quote = s => `'${s.replaceAll("'", "''")}'`;
		// Node spawns PowerShell with the OEM console code page, as run-scenarios.mjs does; Invoke-Scenario reads then rewrites.
		await execute('powershell.exe', ['-NoProfile', '-Command', `. ${quote(script)} -ProjectRoot ${quote(path.dirname(path.dirname(script)))} -FunctionsOnly; $r = Read-ArtifactSummary ${quote(file)} 262144 'fixture'; Write-ArtifactSummary ${quote(file)} $r`], { windowsHide: true, timeout: 30000 });
		assert.deepEqual(await readArtifactReport(file), value);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('S7 is versioned natural survival with explicit goal-start/death policy, and S1 retains its clock', () => {
	const s7 = scenarios.find(s => s.id === 'S7');
	assert.equal(s7.version, 2); assert.equal(s7.goal, 'Beat the game by defeating the Ender Dragon');
	assert.deepEqual(s7.setup.inventory, []); assert.deepEqual(s7.setup.commands, []);
	assert.equal(s7.setup.surface, true);
	for (const budget of [1800000, 3600000]) {
		const built = normalizeHeadlessScenario(buildQualityScenario(s7, { profile, budget }));
		assert.equal(built.playWindowMs, budget); assert.equal(built.continueAfterDeath, true);
		assert.equal(built.timeoutMs, budget + built.preparationTimeoutMs);
	}
	const legacy = normalizeHeadlessScenario(buildQualityScenario(scenarios[0], { profile }));
	assert.equal(legacy.timeoutMs, 240000); assert.equal(legacy.playWindowMs, undefined); assert.equal(legacy.continueAfterDeath, false);
	const args = parseArgs(['--scenarios', 'S7', '--provider', 'codex', '--service-tier', 'priority', '--play-window-ms', '3600000', '--seed', '-123', '--spawn', '1.5,70,2.5']);
	assert.equal(args.budget, 3600000); assert.equal(args.serviceTier, 'priority'); assert.equal(args.seed, '-123'); assert.deepEqual(args.spawnPosition, [1.5, 70, 2.5]);
	assert.equal(parseArgs(['--scenarios', 'S7']).budget, null);
	assert.throws(() => parseArgs(['--play-window-ms', '3600001']));
	assert.throws(() => parseArgs(['--provider', 'claude', '--service-tier', 'fast']));
	assert.throws(() => parseArgs(['--scenarios', 'S7', '--spawn', '1,,2']));
	assert.throws(() => normalizeHeadlessScenario({ ...buildQualityScenario(s7, { profile }), continueAfterDeath: 'yes' }));
});

test('budgets and start overrides come from scenario data, so mixed selections keep each scenario window', () => {
	const warnings = [], warn = text => warnings.push(text);
	const mixed = resolveQualityScenarios(scenarios, parseArgs(['--scenarios', 'S1,S7']), warn);
	assert.deepEqual(mixed.map(s => s.durationBudgetMs), [240000, 1800000]); assert.deepEqual(warnings, []);
	const built = mixed.map(s => normalizeHeadlessScenario(buildQualityScenario(s, { profile })));
	assert.equal(built[0].timeoutMs, 240000); assert.equal(built[0].playWindowMs, undefined);
	assert.equal(built[1].playWindowMs, 1800000);
	// Every legacy scenario keeps its exact definition and the former 240 s default.
	for (const s of scenarios.filter(s => s.id !== 'S7')) assert.deepEqual(resolveQualityScenarios(scenarios, { scenarios: [s.id] }, warn)[0], { ...s, durationBudgetMs: 240000 });
	assert.equal(warnings.length, 0);
	assert.deepEqual(resolveQualityScenarios(scenarios, parseArgs(['--scenarios', 'S1,S7', '--budget-ms', '240000']), warn).map(s => s.durationBudgetMs), [240000, 240000]);
	assert.match(warnings.join(), /S7: explicit window 240000 ms replaces scenario durationBudgetMs 1800000 ms/);
	const moved = resolveQualityScenarios(scenarios, parseArgs(['--scenarios', 'S7', '--seed', '-123', '--spawn', '1.5,70,2.5']), warn)[0];
	assert.equal(moved.seed, '-123'); assert.deepEqual(moved.setup.position, [1.5, 70, 2.5]);
	assert.throws(() => resolveQualityScenarios(scenarios, parseArgs(['--scenarios', 'S1', '--seed', '1']), warn), /S1 has a fixed start/);
	assert.throws(() => resolveQualityScenarios(scenarios, parseArgs(['--scenarios', 'S7,S1', '--spawn', '1,70,2']), warn), /S1 has a fixed start/);
	assert.throws(() => resolveQualityScenarios([{ id: 'X' }], { scenarios: ['X'] }, warn), /needs durationBudgetMs/);
});

test('S7 respawns where it starts: world spawn is set at the placed start, and fixed-start scenarios do not touch it', async () => {
	const setupCommands = async setup => {
		const commands = [];
		await applyQualitySetup(setup, async command => { commands.push(command); return { text: 'player has the following entity data: ok' }; }, 'player');
		return commands;
	};
	const s7 = await setupCommands(scenarios.find(s => s.id === 'S7').setup);
	const placed = s7.findIndex(c => c.includes('run tp player')), spawn = s7.indexOf('execute at player run setworldspawn ~ ~ ~');
	assert.ok(placed >= 0 && spawn > placed && spawn < s7.indexOf('gamemode survival player'));
	for (const s of scenarios.filter(s => s.id !== 'S7')) assert.ok(!(await setupCommands(s.setup)).some(c => c.includes('spawn')), s.id);
});

async function clockFixture({ continueAfterDeath = true, emitStart = true, playWindowMs = 1800000, complete = false, rotatedAudit = false, dropRegistration = false } = {}) {
	const directory = await mkdtemp(path.join(tmpdir(), 'quality-play-clock-'));
	try {
		const scenario = normalizeHeadlessScenario({ ...buildQualityScenario(scenarios.at(-1), { profile, budget: playWindowMs }), qualitySetup: undefined, continueAfterDeath,
			world: { mode: 'natural', seed: '1' }, assert: [{ type: 'rcon', command: 'data get entity {agent} Pos', match: 'entity data' }] });
		const worldManifest = { version: 1, scenarioId: scenario.id, worldId: 'headless-clock-fixture', fresh: true, world: scenario.world,
			savedSpawn: { source: 'level.dat', dimension: 'minecraft:overworld', x: 0, y: 64, z: 0 },
			spawnLoading: { operation: 'temporary_spawn_chunk_loading', x: 0, z: 0, ready: true, elapsedMs: 1, terrainModified: false, inventoryModified: false } };
		const audit = [], commands = [];
		const protocolPath = path.join(directory, 'protocol.jsonl');
		if (rotatedAudit) await writeFile(protocolPath, '');
		let now = 1000, goalAt = null, attempt = 0;
		const report = await runHeadlessScenario({ scenario, worldManifest, protocolAudit: rotatedAudit ? protocolPath : audit, runDirectory: directory, now: () => now,
			poll: async () => { now += playWindowMs / 4; },
			rcon: { close: async () => {}, command: async command => {
				commands.push({ command, at: now });
				if (command === 'seed') return { text: 'Seed: [1]' };
				if (command === 'difficulty') return { text: 'The difficulty is normal' };
				if (command.includes(' if loaded ')) return { text: 'The time is 1' };
				if (command.includes('summon-configured')) { const name = command.split(' ').at(-1); if (!dropRegistration) audit.push({ ...p('agent_registered', now, { agentId: 'a', name, ...profile }), agentId: 'a' }); if (rotatedAudit && !dropRegistration) await appendFile(protocolPath, JSON.stringify(audit.at(-1)) + '\n'); return { text: `Created ${name}. It is ready for a task.` }; }
				if (command.startsWith('codex start ')) { now += 120000; goalAt = now; if (emitStart) { audit.push({ ...p('goal_control', now, { operation: 'start', updatedAtEpochMs: now, goal: scenario.task }), agentId: 'a' }); if (rotatedAudit) { await rename(protocolPath, `${protocolPath}.1`); await writeFile(protocolPath, JSON.stringify(audit.at(-1)) + '\n'); } } }
				if (command.startsWith('codex status ')) { attempt++; if (complete && attempt === 3) return { text: 'state=COMPLETED' }; return { text: attempt === 2 ? 'state=DEAD' : 'state=RUNNING' }; }
				if (command.startsWith('codex stop ')) return { text: `Stopped ${command.split(' ').at(-1)}.` };
				if (command.endsWith(' Pos')) return { text: 'player has the following entity data: [0d, 64d, 0d]' };
				if (command.endsWith(' Inventory')) return { text: 'player has the following entity data: []' };
				return { text: 'ok' };
			} } });
		return { report, commands, goalAt };
	} finally { await rm(directory, { recursive: true, force: true }); }
}

test('real runner entry point keeps a full 30/60-minute goal-start window across death', async () => {
	for (const [playWindowMs, rotatedAudit] of [[1800000, false], [3600000, false], [1800000, true]]) {
		const { report, commands, goalAt } = await clockFixture({ playWindowMs, rotatedAudit });
		assert.equal(report.classification, 'TIMEOUT', report.diagnostics);
		assert.equal(report.budget.goalStartedAt, goalAt);
		assert.equal(commands.find(c => c.command.startsWith('codex stop ')).at, goalAt + playWindowMs);
		assert.equal(report.lifecycle, null);
	}
});

test('death remains terminal without continuation; completion still ends early; missing start spends only preparation budget', async () => {
	assert.equal((await clockFixture({ continueAfterDeath: false })).report.classification, 'DEAD');
	assert.equal((await clockFixture({ complete: true })).report.classification, 'PASSED');
	const missing = await clockFixture({ emitStart: false });
	assert.equal(missing.report.budget.goalStartedAt, null); assert.equal(missing.report.classification, 'TIMEOUT');
	assert.ok(missing.commands.find(c => c.command.startsWith('codex stop ')).at < missing.goalAt + 1800000);
});

test('a dropped registration audit row still starts the play window and a missing start is loud', async () => {
	const { report, commands, goalAt } = await clockFixture({ dropRegistration: true });
	assert.equal(report.budget.goalStartedAt, goalAt);
	assert.equal(commands.find(c => c.command.startsWith('codex stop ')).at, goalAt + 1800000);
	const missing = await clockFixture({ emitStart: false });
	assert.equal(missing.report.budget.goalStartedAt, null);
	assert.match(missing.report.diagnostics, /GOAL_START_NOT_RECOGNIZED/);
});

test('first progress spans deaths, respects cutoff, distinguishes confirmed smelting from looting', () => {
	const rows = [observation(500, 0, ['iron_pickaxe']), observation(2000, 0, ['stone_pickaxe']), p('goal_control', 3000, { operation: 'dead' }),
		...action('smelt', 'furnace_transaction', 4000, { operation: 'insert_input', expectedItemId: 'minecraft:raw_iron' }),
		...action('take', 'furnace_transaction', 5000, { operation: 'take_output', expectedItemId: 'minecraft:iron_ingot' }), observation(5001, 0, ['iron_ingot']),
		observation(6000, 0, ['iron_pickaxe']), observation(61000, 0, ['bucket'])];
	const m = extract(rows).progressV1;
	assert.equal(m.first.stone_pickaxe.elapsedMs, 1000); assert.equal(m.first.iron_ingot.elapsedMs, 4001);
	assert.equal(m.first.iron_pickaxe.elapsedMs, 5000); assert.equal(m.first.bucket.elapsedMs, null);
	assert.equal(m.first.furnace_use.elapsedMs, 3001); assert.equal(m.first.iron_ingot.source, 'smelted');
	const loot = extract([...action('loot', 'menu_click', 5000, { expectedItemId: 'minecraft:iron_ingot', menuId: 'minecraft:generic_9x3', slot: 1, clickType: 'QUICK_MOVE' }), observation(5001, 0, ['iron_ingot'])]).progressV1;
	assert.equal(loot.first.iron_ingot.source, 'looted');
	assert.equal(extract([observation(5001, 0, ['iron_ingot'])]).progressV1.first.iron_ingot.source, 'unknown');
	assert.equal(extract([], [{ at: 3500, inventoryNbt: '[{id:"minecraft:bucket",count:1}]' }]).progressV1.first.bucket.elapsedMs, 2500);
});

test('stations count placements, exclude returns/reclamation/terminal camp, and camp travel excludes respawns', () => {
	const target = x => ({ position: { x, y: 64, z: 0 }, afterId: 'minecraft:crafting_table' });
	const rows = [observation(1000, 0), ...action('p1', 'place_block', 2000, { itemId: 'minecraft:crafting_table', x: 0, y: 64, z: 0 }, 'SUCCEEDED', null, target(0)),
		observation(3000, 10), observation(4000, 2), ...action('p2', 'place_block', 5000, { itemId: 'minecraft:crafting_table', x: 20, y: 64, z: 0 }, 'SUCCEEDED', null, target(20)),
		observation(6000, 20), observation(7000, 31), ...action('p3', 'place_block', 8000, { itemId: 'minecraft:crafting_table', x: 40, y: 64, z: 0 }, 'SUCCEEDED', null, target(40)),
		observation(9000, 40), ...action('reclaim', 'break_block', 10000, {}, 'SUCCEEDED', null, { position: { x: 20, y: 64, z: 0 }, beforeId: 'minecraft:crafting_table' }),
		p('goal_control', 6500, { operation: 'dead' }), observation(11000, 100)];
	const samples = [2001, 3000, 5001, 6000, 7000, 8001].map((at, i) => ({ at, position: { x: [0, 5, 20, 21, 1000, 1001][i], y: 64, z: 0 }, dimension: 'minecraft:overworld', deathCounter: i >= 4 ? 1 : 0 }));
	const m = extract(rows, samples).progressV1;
	assert.equal(m.stationCounts['minecraft:crafting_table'], 3);
	assert.equal(m.stations[0].unrevisited, false); assert.equal(m.stations[1].unrevisited, false); assert.equal(m.stations[2].unrevisited, true);
	assert.equal(m.stationsLeftUnrevisited, 1); assert.equal(m.campTravel[1].sampledDistance, 2);
	const terminal = extract(rows.filter(r => r.at < 11000), samples).progressV1;
	assert.equal(terminal.stations[2].unrevisited, false);
});

test('NO_PATH control proxy excludes survey, route repair, nonmoving control, deaths and outside-window actions', () => {
	const fail = (id, at, code = 'NO_PATH') => action(id, 'navigate_to', at, {}, 'FAILED', code);
	const control = (id, at, args = { forward: 1 }) => action(id, 'control', at, args);
	const rows = [...fail('a', 2000), ...control('ca', 3000), ...fail('b', 5000, 'NO_SEEN_ROUTE'), ...control('cb', 6000),
		...fail('c', 8000), ...action('survey', 'survey', 8500, {}), ...control('cc', 9000),
		...fail('d', 11000), ...action('repair', 'break_block', 11500, {}), ...control('cd', 12000),
		...fail('e', 14000), ...control('ce', 15000, { forward: 0 }),
		...fail('f', 17000), p('goal_control', 17500, { operation: 'dead' }), ...control('cf', 18000),
		...fail('g', 19000), ...control('cg', 51000), ...fail('late', 61000), ...control('clate', 62000)];
	const m = extract(rows).progressV1;
	assert.equal(m.noPathThenMovementControl, 1); assert.equal(m.pathFailureThenMovementControl, 2);
});
