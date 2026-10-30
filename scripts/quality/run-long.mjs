#!/usr/bin/env node
import path from 'node:path';
import { requireRunBudgetPolicy, isStrictBudget, requireStrictGoal, STRICT_BUDGET_POLICY, OBSERVER_BUDGET_POLICY } from '../../coordinator/src/benchmark/auxiliary-budget-policy.mjs';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readLongArtifacts } from '../../coordinator/src/benchmark/long-run-artifacts.mjs';
import { readArtifactReport, writeArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';
import { SpendGate } from '../../coordinator/src/benchmark/spend-gate.mjs';
import { SpendLedger, runSpendUsd } from '../../coordinator/src/benchmark/spend-ledger.mjs';
import { buildLongRunDefinition, extractLongRunTimeline, formatLongRunTimeline, randomSeed, MAX_LONG_RUN_WINDOW_MS } from '../../coordinator/src/benchmark/long-run.mjs';
import { runScenarios, validateArmBuild } from './run-scenarios.mjs';
import { collectWatchFiles } from './watch-files.mjs';
import { scoreStageRun } from './stage-score.mjs';
import { recordOperatorStop } from './operator-stop.mjs';
import { writeTimeReport } from './watch-time.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USAGE = 'Regenerate: node scripts/quality/run-long.mjs --report RAW_RUN_DIR --out REPORT_DIR\nRun: node scripts/quality/run-long.mjs --budget-minutes 180 --max-total-cost-usd 80 --ledger FILE --port-base 26900 --out DIR [--prior-spend-usd P] [--run-reserve-usd R] [--provider claude|codex|opencode --model M --effort low --service-tier priority] [--codex-observer-cap yes] [--seed N] [--goal "Beat the game"] [--arms arms.json --arm B | --jar PATH --coordinator-root PATH] [--checkpoint SAVE_POINT.json [--random-salt N|none]] [--codex-mid-turn-rotation-tokens N] [--java PATH --server-template PATH]';

const DEFAULT_MODELS = Object.freeze({ claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol', opencode: 'opencode/deepseek-v4.1-flash-free' });

export function parseLongArgs(argv) {
	if (argv[0] === '--report') {
		if (argv.length !== 4 || argv[2] !== '--out') throw new Error('Usage: --report RAW_RUN_DIR --out REPORT_DIR');
		return { report: path.resolve(argv[1]), out: path.resolve(argv[3]) };
	}
	const accepted = new Set(['budget-minutes', 'max-total-cost-usd', 'ledger', 'prior-spend-usd', 'run-reserve-usd', 'provider', 'model', 'effort', 'service-tier', 'seed', 'goal', 'arms', 'arm', 'jar', 'coordinator-root', 'port-base', 'codex-observer-cap', 'java', 'server-template', 'checkpoint', 'random-salt', 'codex-mid-turn-rotation-tokens', 'out']);
	const values = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--help') return { help: true };
		const key = argv[i].replace(/^--/, '');
		if (!argv[i].startsWith('--') || !accepted.has(key) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument ${argv[i]}`);
		values[key] = argv[++i];
	}
	for (const key of ['budget-minutes', 'max-total-cost-usd', 'port-base', 'out']) if (values[key] === undefined) throw new Error(`--${key} is required`);
	const minutes = Number(values['budget-minutes']), cap = Number(values['max-total-cost-usd']), prior = values['prior-spend-usd'] === undefined ? null : Number(values['prior-spend-usd']), portBase = Number(values['port-base']);
	if (!Number.isFinite(minutes) || minutes < 1 || minutes * 60000 > MAX_LONG_RUN_WINDOW_MS) throw new Error(`--budget-minutes must be 1..${MAX_LONG_RUN_WINDOW_MS / 60000}`);
	if (!Number.isFinite(cap) || cap <= 0) throw new Error('--max-total-cost-usd must be positive; long runs require a ledger admission budget');
	if (prior !== null && !(Number.isFinite(prior) && prior >= 0)) throw new Error('--prior-spend-usd must be non-negative');
	if (values['run-reserve-usd'] !== undefined && !(Number(values['run-reserve-usd']) >= 1)) throw new Error('--run-reserve-usd must be at least 1');
	if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65533) throw new Error('--port-base must be 1024..65533');
	const provider = values.provider ?? 'claude';
	if (!['claude', 'codex', 'opencode'].includes(provider)) throw new Error('--provider must be claude, codex or opencode');
	if (values['codex-observer-cap'] !== undefined && values['codex-observer-cap'] !== 'yes') throw new Error('--codex-observer-cap takes yes');
	if (provider === 'codex' && values['codex-observer-cap'] !== 'yes') throw new Error('Codex play cannot be metered per call; pass --codex-observer-cap yes to accept an observer estimate that may exceed the cap');
	const serviceTier = values['service-tier'] ?? (provider === 'codex' ? 'default' : 'priority');
	if (!(provider === 'codex' ? ['default', 'priority', 'fast', 'flex'] : ['default', 'priority']).includes(serviceTier)) throw new Error('Unsupported --service-tier for provider');
	const midTurnRotationTokens = values['codex-mid-turn-rotation-tokens'] === undefined ? null : Number(values['codex-mid-turn-rotation-tokens']);
	if (midTurnRotationTokens !== null && !(Number.isSafeInteger(midTurnRotationTokens) && midTurnRotationTokens >= 0)) throw new Error('--codex-mid-turn-rotation-tokens takes a token count (0 = off)');
	if (values.checkpoint && values.seed) throw new Error('A checkpoint carries its own seed; drop --seed');
	if (values['random-salt'] !== undefined && (!values.checkpoint || values['random-salt'] !== 'none' && !/^-?\d{1,10}$/.test(values['random-salt']) || Math.abs(Number(values['random-salt'])) > 2147483647)) throw new Error('--random-salt takes a 32-bit integer or none, with --checkpoint');
	if (values.arms && !['A', 'B'].includes(values.arm ?? '')) throw new Error('--arms needs --arm A or B');
	if (values.arms && (values.jar || values['coordinator-root'])) throw new Error('Use --arms or --jar/--coordinator-root, not both');
	// OpenCode's free models cost nothing, so their play is observer-metered at $0 without the Codex opt-in.
	return { windowMs: Math.round(minutes * 60000), capUsd: cap, priorSpendUsd: prior, codexObserverCap: values['codex-observer-cap'] === 'yes' || provider === 'opencode', ledger: values.ledger ? path.resolve(values.ledger) : null,
		runReserveUsd: values['run-reserve-usd'] === undefined ? null : Number(values['run-reserve-usd']), provider, model: values.model ?? DEFAULT_MODELS[provider],
		effort: values.effort ?? 'low', serviceTier, midTurnRotationTokens, seed: values.seed ?? randomSeed(), goal: values.goal ?? 'Beat the game', arms: values.arms ? path.resolve(values.arms) : null, arm: values.arm ?? null,
		checkpoint: values.checkpoint ? path.resolve(values.checkpoint) : null,
		// A save point replays the same loot rolls (barters, mob drops) each game unless reseeded: a fresh salt by default.
		randomSalt: !values.checkpoint || values['random-salt'] === 'none' ? null : values['random-salt'] !== undefined ? Number(values['random-salt']) : randomInt(-2147483648, 2147483647),
		jar: values.jar ? path.resolve(values.jar) : null, coordinatorRoot: values['coordinator-root'] ? path.resolve(values['coordinator-root']) : null, portBase, out: path.resolve(values.out),
		java: values.java ?? process.env.ARENA_HEADLESS_JAVA ?? path.join(process.env.JAVA_HOME ?? path.join(ROOT, 'runtime/toolchains/temurin-25/jdk-25.0.3+9'), 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
		template: path.resolve(values['server-template'] ?? process.env.ARENA_HEADLESS_SERVER_TEMPLATE ?? path.join(ROOT, 'runtime/server-template')) };
}

/** The cap is the run's budget: reserve what it leaves (or --run-reserve-usd), stopping early enough for one in-flight call. */
export function longRunAllowance({ runReserveUsd = null }, availableUsd) {
	const reserveUsd = Math.min(runReserveUsd ?? Infinity, availableUsd);
	return { reserveUsd, stopAtUsd: reserveUsd - Math.min(0.5, reserveUsd * 0.1) };
}

export async function runLong(options, { execute = runScenarios } = {}) {
	requireRunBudgetPolicy(options);
	if (isStrictBudget(options)) requireStrictGoal(options.goal ?? 'Beat the game');
	await mkdir(options.out, { recursive: true });
	if (existsSync(path.join(options.out, 'long-run.json'))) throw new Error('Use a fresh output directory');
	let build = { jar: options.jar ?? undefined, coordinatorRoot: options.coordinatorRoot ?? undefined, commit: null };
	if (options.arms) {
		build = JSON.parse(await readFile(options.arms, 'utf8'))[options.arm];
		await validateArmBuild(build, options.arm, options.provider, { requireCapture: false });
	}
	options = { ...options, ledger: options.ledger ?? path.join(options.out, 'spend-ledger.json') };
	const ledger = new SpendLedger({ capUsd: options.capUsd, priorSpendUsd: options.priorSpendUsd, file: options.ledger });
	const { reserveUsd, stopAtUsd } = longRunAllowance(options, await ledger.available());
	if (reserveUsd < 1) throw new Error(`Only $${reserveUsd.toFixed(2)} of the $${options.capUsd} cap is unreserved; a long run needs at least $1`);
	// A save point (scripts/quality/make-checkpoint.mjs) replaces only the seed and the start; the long-run rules stay.
	const checkpoint = options.checkpoint ? JSON.parse(await readFile(options.checkpoint, 'utf8')) : null;
	if (checkpoint) options = { ...options, seed: checkpoint.seed };
	const runId = `long-${randomUUID().slice(0, 8)}`;
	if (!await ledger.reserve(runId, reserveUsd, `long run ${options.provider} ${options.model} seed ${options.seed}`)) throw new Error('Spend cap reached before launch');
	// Claude calls share a gateway gate; Codex preparation and play remain observer estimates under the explicit opt-in.
	const gate = new SpendGate({ budgetUsd: reserveUsd });
	const definition = { ...buildLongRunDefinition({ seed: options.seed, windowMs: options.windowMs, goal: options.goal, spendCapUsd: stopAtUsd }), runReserveUsd: reserveUsd };
	if (checkpoint) {
		const { startAt, ...base } = definition.setup;
		Object.assign(definition, { name: `checkpoint-${checkpoint.milestone}`, setup: { ...base, ...checkpoint.setup, ...(options.randomSalt === null || options.randomSalt === undefined ? {} : { randomSalt: options.randomSalt }) }, checkpoint: { milestone: checkpoint.milestone, minute: checkpoint.minute, source: checkpoint.source, priorAdvancements: checkpoint.priorAdvancements } });
	}
	if (isStrictBudget(options)) delete definition.runPolicy.stopOnAdvancement;
	const profile = { provider: options.provider, model: options.model, reasoningEffort: options.effort, serviceTier: options.serviceTier };
	// The scenario runner copies this into the run's coordinator config (codex.midTurnContextRotationTokens).
	if (options.midTurnRotationTokens !== null) process.env.ARENA_CODEX_MID_TURN_ROTATION_TOKENS = String(options.midTurnRotationTokens);
	console.log(`${runId}: seed ${definition.seed}${definition.setup.randomSalt === undefined ? '' : ` (loot salt ${definition.setup.randomSalt})`}, window ${options.windowMs / 60000} min, reserved $${reserveUsd.toFixed(2)}, play stops at $${stopAtUsd.toFixed(2)}`);
	await writeFile(path.join(options.out, 'long-run-start.json'), JSON.stringify({ schemaVersion: 1, runId, definition, profile, windowMs: options.windowMs, launchedAt: Date.now() }) + '\n');
	let signalRecord = null;
	const onSignal = signal => {
		// The scenario runner owns process cleanup; this listener only persists the missing provenance.
		signalRecord ??= existsSync(path.join(options.out, 'operator-stop.json')) ? Promise.resolve() : recordOperatorStop(options.out,
			`External ${signal}; operator reason unavailable`, { signal, requestedBy: 'unknown' });
	};
	const onTerm = () => onSignal('SIGTERM'), onInt = () => onSignal('SIGINT');
	process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
	let results = null, failure = null, discoveredArtifacts = null;
	try {
		results = await execute({ ...build, definitions: [definition], scenarios: [definition.id], runs: 1, repetition: 1, provider: options.provider, model: options.model, effort: options.effort,
			serviceTier: options.serviceTier, budget: null, goalStartClock: true, spendGate: gate, codexObserverCap: options.codexObserverCap, portBase: options.portBase, out: path.join(options.out, 'run'), sourceCommit: build.commit ?? null, template: options.template, java: options.java }, { onObserver: observer => { discoveredArtifacts = observer.directory; } });
	} catch (error) { failure = error; }
	finally { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); }
	if (signalRecord) await signalRecord;
	const run = results?.runs?.[0] ?? (discoveredArtifacts ? { artifacts: discoveredArtifacts, termination: failure?.code ?? 'RUNNER_ERROR', diagnostics: failure?.stack } : null);
	const spend = runSpendUsd(run, { reserveUsd });
	let totals = {};
	try { totals = await ledger.settle(runId, spend.usd, { meteredUsd: spend.meteredUsd, reservedUsd: spend.reservedUsd, notes: spend.notes }); }
	catch (error) { failure ??= Object.assign(new Error(`LEDGER_SETTLEMENT_FAILED: ${error.message}`), { cause: error }); }
	let evidence = null;
	// The Watcher's danger records travel with the long-run report; the raw run dir keeps its own copy too.
	if (run?.artifacts) await collectWatchFiles(run.artifacts, options.out).catch(error => console.warn(`Watch file copy: ${error.message}`));
	// Where the time went (watch-time.mjs), next to the artifacts so the dashboard can show it; never fails the run.
	if (run?.artifacts) await writeTimeReport([run.artifacts], run.artifacts).catch(error => console.warn(`Time report: ${error.message}`));
	if (run?.artifacts) {
		try { evidence = await readLongArtifacts(run.artifacts, { profile, windowMs: options.windowMs, termination: run.errorCode ?? run.termination, stopRequest: run.stopRequest, authoritativeDragon: isStrictBudget(options) }); }
		catch (error) { failure ??= error; }
	}
	const timeline = evidence?.timeline ?? extractLongRunTimeline({ profile, windowMs: options.windowMs, termination: failure?.code ?? failure?.message ?? run?.termination ?? 'NO_ARTIFACTS' });
	const report = { schemaVersion: 1, benchmark: 'long-run', budgetPolicy: isStrictBudget(options) ? STRICT_BUDGET_POLICY : OBSERVER_BUDGET_POLICY, runId, seed: definition.seed, goal: definition.goal, windowMs: options.windowMs, profile, build: { commit: build.commit ?? null, jar: results?.jar ?? null, coordinatorSha256: results?.coordinatorSha256 ?? null },
		definition, termination: run?.termination ?? null, measurementStatus: run?.measurementStatus ?? 'UNAVAILABLE', observerErrors: [...(run?.observerErrors ?? []), ...(evidence?.errors ?? [])], diagnostics: run?.diagnostics ?? null, stopRequest: run?.stopRequest ?? null, failure: failure?.message ?? null,
		spend, ledger: { file: options.ledger, capUsd: options.capUsd, reservedForRunUsd: reserveUsd, stopAtUsd, ...totals }, timeline, artifacts: run?.artifacts ?? null, capturedAt: new Date().toISOString() };
	await writeArtifactReport(path.join(options.out, 'long-run.json'), report);
	report.stageScore = await scoreStageRun(options.out, { rawDirectory: run?.artifacts }).catch(error => ({ error: error.message }));
	report.ending = report.stageScore.ending ?? null;
	report.operatorStop = report.ending?.operatorStop ?? null;
	await writeFile(path.join(options.out, 'stage-score.json'), JSON.stringify(report.stageScore, null, 2) + '\n');
	await writeFile(path.join(options.out, 'long-run.md'), formatLongRunTimeline(report));
	await writeArtifactReport(path.join(options.out, 'long-run.json'), report);
	console.log(`Long run ${runId}: ${timeline.stopReason}, furthest ${timeline.furthestMilestone ?? 'none'}, $${spend.usd.toFixed(3)}; ${path.join(options.out, 'long-run.md')}`);
	if (failure) throw failure;
	return report;
}

/** Read-only reconstruction of raw evidence; never launches Minecraft or changes a spend ledger. */
export async function regenerateLongReport(directory, out) {
	await mkdir(out, { recursive: true });
	const prior = await readArtifactReport(path.join(out, 'long-run.json')).catch(() => null);
	const evidence = await readLongArtifacts(directory, { profile: prior?.profile, windowMs: prior?.windowMs, stopRequest: prior?.stopRequest, authoritativeDragon: prior ? prior.budgetPolicy === STRICT_BUDGET_POLICY : undefined });
	const { timeline, metrics, profile, windowMs, runner, metadata, manifest, outcome } = evidence;
	const report = { ...prior, schemaVersion: 1, benchmark: 'long-run', regeneratedAt: new Date().toISOString(),
		runId: prior?.runId ?? manifest.runId ?? path.basename(directory), seed: prior?.seed ?? manifest.world?.seed,
		goal: prior?.goal ?? metadata?.definition?.goal ?? 'Beat the game', windowMs, profile, timeline,
		termination: outcome?.errorCode ?? runner?.errorCode ?? outcome?.termination ?? runner?.classification ?? 'NO_RUNNER_REPORT', diagnostics: outcome?.diagnostics ?? runner?.diagnostics ?? null, failure: null,
		measurementStatus: evidence.errors.length ? 'INCOMPLETE' : 'OBSERVER_ESTIMATE', observerErrors: evidence.errors,
		spend: prior?.spend ?? { usd: metrics.costEstimateUsd, meteredUsd: null, reservedUsd: null }, ledger: prior?.ledger ?? { committedUsd: null, capUsd: null },
		artifacts: directory, budgetPolicy: prior?.budgetPolicy ?? OBSERVER_BUDGET_POLICY };
	report.stageScore = await scoreStageRun(out, { rawDirectory: directory });
	report.ending = report.stageScore.ending;
	report.operatorStop = report.ending?.operatorStop ?? null;
	await writeFile(path.join(out, 'stage-score.json'), JSON.stringify(report.stageScore, null, 2) + '\n');
	await writeFile(path.join(out, 'long-run.md'), formatLongRunTimeline(report));
	await writeArtifactReport(path.join(out, 'long-run.json'), report);
	console.log(`Regenerated ${path.join(out, 'long-run.md')}: ${timeline.stopReason}, ${timeline.milestonesReached}/24 milestones, ${timeline.totals.calls} calls`);
	return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { const options = parseLongArgs(process.argv.slice(2)); if (options.help) console.log(USAGE); else { const report = options.report ? await regenerateLongReport(options.report, options.out) : await runLong(options); process.exitCode = report.artifacts && !report.observerErrors.length ? 0 : 1; } }
	catch (error) { console.error(error); process.exitCode = 1; }
}
