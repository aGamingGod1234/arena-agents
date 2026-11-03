// Fact-copy micro-benchmark: the cost of turning one observation into ArenaScript interpreter facts, and of running
// guard scripts against them, over real recorded observations (the decision-eval replay samples). Each sample is fed
// twice, as the body does: once as news, then as an unchanged heartbeat, each step chained to the previous facts the way
// the program engine and the standing-order book chain them. Run it against any checkout to compare, e.g. a "before" copy:
//   node src/benchmark/arena-script-facts-benchmark.mjs [coordinator dir] [rounds]
// It prints the CPU time (user + system, which a busy shared machine distorts less than wall time) per fact build and per
// script run, and a digest of every produced fact tree and script result: two checkouts that print the same digest
// produced identical facts, including key order, prototypes and frozenness, and identical script results.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(moduleDirectory, '../..'));
const ROUNDS = Number(process.argv[3] ?? 7);
const fixtures = path.resolve(moduleDirectory, '../../test/fixtures/decision-eval');
const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { createInterpreterFacts } = await imp('src/arena-script/facts.mjs');
const { ArenaScriptInterpreter } = await imp('src/arena-script/interpreter.mjs');
const { parseArenaScript } = await imp('src/arena-script/parser.mjs');
const { SCRIPT_BINDINGS } = await imp('src/arena-script/minecraft-api.mjs');
const { adaptObservation } = await imp('src/observation-adapter.mjs');

function files(dir) {
	return readdirSync(dir).flatMap((name) => {
		const file = path.join(dir, name);
		return statSync(file).isDirectory() ? files(file) : file.endsWith('.json') ? [file] : [];
	}).sort();
}
const wire = files(fixtures).flatMap((file) => (JSON.parse(readFileSync(file, 'utf8')).cases ?? [])
	.map((entry) => entry.state?.observation).filter((observation) => observation?.ready === true));
const samples = [];
for (const observation of wire) { try { samples.push(adaptObservation(observation)); } catch { /* a sample the adapter rejects is not a program input */ } }
// The unchanged heartbeat: equal content in new objects, cloned before timing starts.
const heartbeats = samples.map((sample) => structuredClone(sample));

// Guards and a short routine of the kinds the instructions teach; they only read facts and yield one action.
const SCRIPTS = [
	'program.watch(() => player.state().threat !== null && player.state().threat.visible, { mode: "interrupt" }, async () => { await player.wait(1); }); await player.wait(1);',
	'program.watch(() => player.state().health < 10 || player.state().inLava === true, { mode: "interrupt" }, async () => { await player.wait(1); }); await player.wait(1);',
	'const logs = world.blocks({ tag: "#minecraft:logs" }); const nearest = world.nearest(logs); await player.wait(nearest === null ? 1 : 2);',
	'let total = 0; for (const item of world.items()) total += item.count; await player.wait(total + inventory.count("minecraft:cobblestone") + 1);',
	'const p = player.state(); await player.wait(math.max(1, math.floor(p.health)) + (world.state().dimension === "minecraft:overworld" ? 0 : 1));',
].map((body) => parseArenaScript(`program.onUnhandledAttention("continue_and_notify"); ${body}`));

function digestOf(hash, value) {
	if (value === null || typeof value !== 'object') { hash.update(JSON.stringify(value) ?? 'undefined'); return; }
	const array = Array.isArray(value);
	hash.update(`${array ? '[' : '{'}${Object.isFrozen(value) ? 'F' : 'M'}${Object.getPrototypeOf(value) === null ? 'N' : 'P'}`);
	if (array) { for (let index = 0; index < value.length; index += 1) { digestOf(hash, value[index]); hash.update(','); } hash.update(']'); return; }
	for (const key of Object.keys(value)) { hash.update(JSON.stringify(key)); hash.update(':'); digestOf(hash, value[key]); hash.update(','); }
	hash.update('}');
}

const cpuMs = () => { const usage = process.cpuUsage(); return (usage.user + usage.system) / 1000; };

function buildFacts(split) {
	let previous = null;
	const out = [];
	for (let index = 0; index < samples.length; index += 1) {
		let started = cpuMs();
		previous = createInterpreterFacts(samples[index], previous);
		split.news += cpuMs() - started;
		out.push(previous);
		started = cpuMs();
		previous = createInterpreterFacts(heartbeats[index], previous);
		split.heartbeat += cpuMs() - started;
		out.push(previous);
	}
	return out;
}

function runScripts(facts) {
	const results = [];
	for (const sample of facts) {
		for (const compiled of SCRIPTS) {
			const vm = new ArenaScriptInterpreter(compiled, SCRIPT_BINDINGS);
			const step = vm.start(sample);
			results.push(step.kind === 'command' ? step.call.arguments : step.kind);
			if (compiled.watchers.length > 0) results.push(vm.evaluateWatcher('watcher-0', sample));
		}
	}
	return results;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const buildTimes = [], scriptTimes = [], newsTimes = [], heartbeatTimes = [];
let facts = null, results = null;
for (let round = 0; round < ROUNDS + 1; round += 1) {
	const split = { news: 0, heartbeat: 0 };
	let started = cpuMs();
	facts = buildFacts(split);
	const built = cpuMs() - started;
	started = cpuMs();
	results = runScripts(facts);
	const ran = cpuMs() - started;
	if (round > 0) { buildTimes.push(built); scriptTimes.push(ran); newsTimes.push(split.news); heartbeatTimes.push(split.heartbeat); } // the first round warms up the JIT
}
const hash = createHash('sha256');
for (const fact of facts) digestOf(hash, fact);
digestOf(hash, results);
const builds = samples.length * 2, runs = facts.length * SCRIPTS.length;
console.log(JSON.stringify({
	root, samples: samples.length, factBuilds: builds, scriptRuns: runs, rounds: ROUNDS,
	factBuildMsMedian: Number(median(buildTimes).toFixed(1)), factBuildUsEach: Number((median(buildTimes) * 1000 / builds).toFixed(1)),
	newSampleUsEach: Number((median(newsTimes) * 1000 / samples.length).toFixed(1)), heartbeatUsEach: Number((median(heartbeatTimes) * 1000 / samples.length).toFixed(1)),
	scriptRunMsMedian: Number(median(scriptTimes).toFixed(1)), scriptRunUsEach: Number((median(scriptTimes) * 1000 / runs).toFixed(1)),
	totalMsMedian: Number(median(buildTimes.map((value, index) => value + scriptTimes[index])).toFixed(1)),
	digest: hash.digest('hex').slice(0, 16),
}, null, 1));
