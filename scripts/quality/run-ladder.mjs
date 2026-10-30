#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { checkAdvancements, evaluateArtifacts, parseSuccessCheck } from './ladder-evaluator.mjs';
import { DEFAULT_SAMPLED_ADVANCEMENTS, parseArgs, resolveQualityScenarios, runScenarios } from './run-scenarios.mjs';
import { readArtifactReport, writeArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';

const DEFAULT_DATA = fileURLToPath(new URL('./ladder.json', import.meta.url));

export function parseLadderArgs(argv) {
	const rest = [], values = {};
	let earlyStop = true;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--no-early-stop') { earlyStop = false; continue; }
		if (['--parallel', '--scenario-file'].includes(argv[i])) {
			if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
			values[argv[i].slice(2)] = argv[++i];
		} else rest.push(argv[i]);
	}
	const options = parseArgs(rest.includes('--runs') ? rest : [...rest, '--runs', '1']);
	const parallel = Number(values.parallel ?? 1);
	if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('--parallel must be 1..8 (each server uses up to 2 GiB)');
	if (options.arms || options.retryFailed) throw new Error('Use run-scenarios.mjs for paired arms/retries');
	if (parallel > 1 && !options.portBase) throw new Error('--parallel requires an explicit --port-base');
	if (options.portBase && options.portBase + (parallel - 1) * 10 + 2 > 65535) throw new Error('Parallel port blocks exceed 65535');
	return { ...options, parallel, earlyStop, scenarioFile: path.resolve(values['scenario-file'] ?? DEFAULT_DATA), scenarios: rest.includes('--scenarios') ? options.scenarios : null };
}

// PASS is the evaluator-owned success check when the run carries one; goalCompleted (the agent's own
// verified completion, which crafting goals leave waiting for operator confirmation) stays a separate column.
export function ladderRow(run) {
	const m = run.metrics, goalCompleted = run.goalCompleted === true, evaluated = run.evaluation?.status === 'EVALUATED';
	const pass = evaluated ? run.evaluation.pass === true : goalCompleted;
	const busy = m?.bodyIdleShare;
	const timeToPassMs = evaluated ? run.evaluation.timeToPassMs : (goalCompleted ? m?.playWallTimeMs : null);
	const postPass = pass && evaluated ? run.evaluation.postPass ?? null : null;
	// A recorded pass keeps its result; what the run did afterwards is information only.
	const note = postPass?.died ? `passed, then died at ${(postPass.diedAfterPassMs / 1000 + (timeToPassMs ?? 0) / 1000).toFixed(1)}s` : null;
	return { scenario: run.scenario, provider: run.profile?.provider ?? null, model: run.profile?.model ?? null,
		repetition: run.repetition ?? 1, result: pass ? 'PASS' : 'FAIL', goalCompleted, evaluatorPass: evaluated ? pass : null,
		evaluatorSource: evaluated ? run.evaluation.source : null, measurementStatus: run.measurementStatus,
		minutesToGoal: pass && Number.isFinite(timeToPassMs) ? timeToPassMs / 60000 : null,
		observedMinutes: Number.isFinite(m?.playWallTimeMs) ? m.playWallTimeMs / 60000 : null,
		deaths: m?.deaths ?? null, bodyBusyPct: Number.isFinite(busy) ? Math.max(0, Math.min(100, (1 - busy) * 100)) : null,
		failures: m?.toolFailuresByCode ?? null, termination: run.termination, runnerTermination: run.runnerTermination ?? null, passedThen: note,
		passTicks: evaluated ? run.evaluation.passTicks ?? null : null, observerErrors: run.observerErrors ?? [] };
}

export function formatLadderReport(runs) {
	const number = n => Number.isFinite(n) ? n.toFixed(2) : '?';
	const cell = s => String(s ?? '?').replaceAll('|', '/').replaceAll('\n', ' ');
	return ['# Ladder results', '', 'PASS is the evaluator-owned success check (inventory / advancement / position / survival sampled from the server) holding at any sample inside the budget; log fallback requires the agent name and an absolute timestamp inside the run window; the agent\'s own goalCompleted is a separate column. Pass min = time from goal_control start to the first passing sample (? for server-log evidence). ? is unobserved. Body-busy is the existing merged dispatch-to-completion proxy, excluding chat.', '',
		'| Scenario | Provider / model | Run | Result | Pass min | Evaluator | Agent goalCompleted | Source | Deaths | Body busy % | Failures / stop |',
		'|---|---|---:|---|---:|---|---|---|---:|---:|---|', ...runs.map(ladderRow).map(r =>
			`| ${cell(r.scenario)} | ${cell(r.provider)} / ${cell(r.model)} | ${r.repetition} | ${r.result} (${cell(r.measurementStatus)}) | ${number(r.minutesToGoal)} | ${r.evaluatorPass === null ? 'n/a' : r.evaluatorPass ? 'pass' : 'fail'} | ${r.goalCompleted ? 'yes' : 'no'} | ${cell(r.evaluatorSource ?? 'n/a')} | ${r.deaths ?? '?'} | ${number(r.bodyBusyPct)} | ${cell(JSON.stringify(r.failures))}; ${cell(r.termination)}${r.passedThen ? '; ' + r.passedThen : ''}${r.observerErrors.length ? '; ' + cell(r.observerErrors.join('; ')) : ''} |`), ''].join('\n');
}

// A verdict recorded during the run (or by an earlier evaluation) is never replaced by a failing re-evaluation.
export function keepRecordedPass(recorded, fresh) {
	return recorded?.status === 'EVALUATED' && recorded.pass === true && recorded.source === 'samples' && recorded.check === fresh?.check && !(fresh?.status === 'EVALUATED' && fresh.pass === true) ? recorded : fresh;
}

export async function evaluateRun(run, definition, { artifactRoots = [] } = {}) {
	const directory = locateArtifacts(run.artifacts, artifactRoots);
	if (!directory) return { status: 'NO_ARTIFACTS', pass: false, check: definition.successCheck, artifacts: run.artifacts ?? null };
	return evaluateArtifacts(directory, definition);
}

// Artifact paths are recorded where the run happened (e.g. C:\\...\\headless-runs\\<name>); after copying
// a results directory elsewhere, find the same-named directory under the given roots.
export function locateArtifacts(recorded, roots = []) {
	if (!recorded) return null;
	if (existsSync(recorded)) return recorded;
	const name = path.win32.basename(path.posix.basename(String(recorded).replaceAll('\\', '/')));
	for (const root of roots) for (const candidate of [path.join(root, name), path.join(root, 'headless-runs', name)]) if (existsSync(candidate)) return candidate;
	return null;
}

// Attach the verdict; a pass supersedes a timeout/death label from the runner, which stays under runnerTermination.
function withEvaluation(run, evaluation) {
	const passed = evaluation?.status === 'EVALUATED' && evaluation.pass === true && evaluation.source === 'samples';
	return { ...run, evaluation, ...(passed ? { runnerTermination: run.runnerTermination ?? run.termination, termination: 'EVALUATOR_PASS' } : {}) };
}

/** Recompute ladder reports from an existing output directory's results.json without rerunning anything. */
export async function rescoreLadder(dir, { artifactRoots = [], scenarioFile = DEFAULT_DATA } = {}) {
	const report = await readArtifactReport(path.join(dir, 'results.json'));
	const data = JSON.parse(await readFile(scenarioFile, 'utf8'));
	const roots = [...artifactRoots, dir, path.dirname(dir)];
	const runs = [];
	for (const run of report.runs) {
		const definition = data.scenarios.find(s => s.id === run.scenario);
		const evaluation = definition ? await evaluateRun(run, definition, { artifactRoots: roots }).catch(error => ({ status: 'ERROR', pass: false, error: error.message })) : { status: 'UNKNOWN_SCENARIO', pass: false };
		runs.push(withEvaluation(run, keepRecordedPass(run.evaluation, evaluation)));
	}
	await writeFile(path.join(dir, 'ladder-rescored.md'), formatLadderReport(runs));
	await writeFile(path.join(dir, 'ladder-rescored.json'), JSON.stringify(runs.map(r => ({ ...ladderRow(r), evaluation: r.evaluation })), null, 2));
	return runs;
}

// Each lane owns a port block, output directory, copied server template and fresh
// world per attempt. A rejected attempt is retained and cannot discard other lanes.
export async function runLadder(options, execute = runScenarios) {
	const data = JSON.parse(await readFile(options.scenarioFile, 'utf8'));
	const ids = options.scenarios ?? data.scenarios.map(s => s.id);
	if (new Set(ids).size !== ids.length || ids.length * options.runs > 40) throw new Error('Select unique scenarios, at most 40 attempts');
	const definitions = resolveQualityScenarios(data.scenarios, { ...options, scenarios: ids }).map(s => ({ ...s,
		sampledAdvancements: [...new Set([...DEFAULT_SAMPLED_ADVANCEMENTS, ...checkAdvancements(parseSuccessCheck(s.successCheck))])],
		evaluatorEarlyStop: options.earlyStop !== false }));
	const jobs = Array.from({ length: options.runs }, (_, i) => definitions.map(s => ({ scenario: s, repetition: i + 1 }))).flat();
	const runs = [], attempts = [];
	await mkdir(options.out, { recursive: true });
	const save = async () => {
		const ordered = [...runs].sort((a, b) => ids.indexOf(a.scenario) - ids.indexOf(b.scenario) || a.repetition - b.repetition);
		await writeArtifactReport(path.join(options.out, 'results.json'), { schemaVersion: 1, benchmark: 'route-ladder', scenarioFile: options.scenarioFile, parallel: options.parallel, runs: ordered, attempts });
		await writeFile(path.join(options.out, 'ladder-report.md'), formatLadderReport(ordered));
		await writeFile(path.join(options.out, 'ladder-report.json'), JSON.stringify(ordered.map(ladderRow), null, 2));
	};
	let cursor = 0, checkpoint = Promise.resolve();
	await Promise.all(Array.from({ length: options.parallel }, async (_, lane) => {
		while (cursor < jobs.length) {
			const { scenario, repetition } = jobs[cursor++];
			const out = path.join(options.out, `${scenario.id}-r${repetition}`);
			try {
				const report = await execute({ ...options, definitions: [scenario], scenarios: [scenario.id], runs: 1, repetition, out, portBase: options.portBase ? options.portBase + lane * 10 : 0 });
				for (const run of report.runs) Object.assign(run, withEvaluation(run, keepRecordedPass(run.evaluation, await evaluateRun(run, scenario).catch(error => ({ status: 'ERROR', pass: false, error: error.message })))));
				runs.push(...report.runs);
				attempts.push({ scenario: scenario.id, repetition, lane, out, process: report.process });
			} catch (error) {
				runs.push({ scenario: scenario.id, repetition, profile: { provider: options.provider, model: options.model }, goalCompleted: false, measurementStatus: 'UNAVAILABLE', termination: 'LAUNCH_ERROR', observerErrors: [error.message], metrics: null });
			}
			checkpoint = checkpoint.then(save);
			await checkpoint;
		}
	}));
	return runs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv[2] === '--report') {
			const files = process.argv.slice(3);
			if (!files.length) throw new Error('--report requires one or more results.json files');
			const reports = await Promise.all(files.map(readArtifactReport));
			console.log(formatLadderReport(reports.flatMap(r => r.runs)));
		} else if (process.argv[2] === '--rescore') {
			const [dir, ...extra] = process.argv.slice(3);
			if (!dir) throw new Error('--rescore requires a ladder output directory (containing results.json); optional --artifacts-root <dir> (repeatable)');
			const roots = extra.flatMap((a, i) => a === '--artifacts-root' ? [extra[i + 1]] : []);
			console.log(formatLadderReport(await rescoreLadder(path.resolve(dir), { artifactRoots: roots.map(r => path.resolve(r)) })));
		} else {
			const options = parseLadderArgs(process.argv.slice(2));
			if (options.help) console.log('run-ladder.mjs [--scenario-file ladder.json] [--scenarios L-A1,L-A3] [--parallel 2 --port-base 28100] [run-scenarios options]; defaults: all links, one repetition. --no-early-stop keeps playing after the evaluator check holds. --report results.json [more.json] prints a combined report. --rescore <dir> [--artifacts-root <dir>] recomputes ladder-rescored.{md,json} from existing artifacts.');
			else {
				const runs = await runLadder(options);
				console.log(formatLadderReport(runs));
				if (runs.some(r => ladderRow(r).result !== 'PASS' || r.measurementStatus !== 'MEASURED')) process.exitCode = 1;
			}
		}
	} catch (error) { console.error(error.stack); process.exitCode = 1; }
}
