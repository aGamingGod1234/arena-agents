#!/usr/bin/env node
// Replays recorded games through the production task view to count the plan-progress facts it would have stated.
//
//   node scripts/quality/progress-replay.mjs [--plan recorded|<plan.json>] [--from-min M] [--json out.json] <run dir>...
//
// Each run dir holds quality-protocol.jsonl (observations, action commands and results) and provider-turns.private.jsonl
// (the model's recorded intents and plan replacements). Observations go through adaptObservation and the End crystal
// memory as in dynamic-main; results reach actionReceipt with their dispatch arguments and message. --plan recorded
// replays the translator plan and the model's own replacements; a plan file replaces both. Provider-free.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { LiveTaskViews } from '../../coordinator/src/live-task-view.mjs';
import { adaptObservation } from '../../coordinator/src/observation-adapter.mjs';
import { rememberEndCrystals, noteCombatDispatch, settleCombatResult } from '../../coordinator/src/dragon-fight-facts.mjs';

function parseArgs(argv) {
	const args = { plan: 'recorded', json: null, fromMin: 0, noProgressMin: null, repeatCount: null, quiet: false, dirs: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--plan') args.plan = argv[++i];
		else if (argv[i] === '--json') args.json = argv[++i];
		else if (argv[i] === '--from-min') args.fromMin = Number(argv[++i]);
		else if (argv[i] === '--no-progress-min') args.noProgressMin = Number(argv[++i]);
		else if (argv[i] === '--repeat') args.repeatCount = Number(argv[++i]);
		else if (argv[i] === '--quiet') args.quiet = true;
		else args.dirs.push(argv[i]);
	}
	return args;
}

function readTurns(dir) {
	const file = path.join(dir, 'provider-turns.private.jsonl');
	const events = [];
	if (!fs.existsSync(file)) return events;
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (!line) continue;
		let row; try { row = JSON.parse(line); } catch { continue; }
		for (const call of row.capture?.calls ?? []) for (const tool of call.toolCalls ?? []) {
			if (tool.name !== 'taskPlan') continue;
			let args; try { args = JSON.parse(tool.arguments); } catch { continue; }
			const at = tool.at ?? call.endedAt ?? row.timestamp;
			if (args.operation === 'intent' && args.intent) events.push({ at, kind: 'intent', intent: args.intent });
			if (args.operation === 'replace' && args.plan) events.push({ at, kind: 'replace', plan: args.plan });
		}
	}
	return events.sort((a, b) => a.at - b.at);
}

function initialPlan(dir) {
	try { return JSON.parse(JSON.parse(fs.readFileSync(path.join(dir, 'quality-initial-plan.json'), 'utf8')).text); } catch { return null; }
}

// Hooks (watch-time.mjs): onObservation({ at, wire, observation, views, record }) after each observed sample,
// onCommand(payload) for each dispatched action and onResult(payload, command) for each terminal result.
export async function replay(dir, { plan = 'recorded', fromMin = 0, noProgressMin = null, repeatCount = null, onObservation = null, onCommand = null, onResult = null } = {}) {
	let clock = 0;
	// Every gap between plan progress and every no-effect repeat run, for choosing the thresholds.
	const gaps = [], runs = new Map();
	const progressTiming = { ...(noProgressMin === null ? {} : { noProgressMs: noProgressMin * 60_000 }), ...(repeatCount === null ? {} : { repeatCount }),
		onGain: ({ at, from, step }) => gaps.push({ from, to: at, step }),
		onRepeat: ({ key, count, first, at }) => { const id = `${key}@${first}`; runs.set(id, { key, count, first, last: at }); } };
	const views = new LiveTaskViews({ now: () => clock, progressTiming });
	const record = { agentId: 'replay', goalRevision: 1, currentGoal: 'Beat the game', currentGoalSpec: { originalRequest: 'Beat the game', fingerprint: 'replay' } };
	const fixed = plan === 'recorded' ? null : JSON.parse(fs.readFileSync(plan, 'utf8'));
	const startPlan = fixed ?? initialPlan(dir);
	const turnEvents = readTurns(dir).filter(e => fixed === null || e.kind === 'intent');
	const commands = new Map(), worldState = {};
	const wakes = [];
	let start = null, last = null, planned = false, observations = 0, results = 0, skipped = 0;
	const input = readline.createInterface({ input: fs.createReadStream(path.join(dir, 'quality-protocol.jsonl')), crlfDelay: Infinity });
	for await (const line of input) {
		if (!line.includes('"observation"') && !line.includes('"action_command"') && !line.includes('"action_result"')) continue;
		let row; try { row = JSON.parse(line); } catch { continue; }
		const envelope = row.envelope, type = envelope?.type, payload = envelope?.payload;
		if (type === 'action_command' && row.direction === 'coordinator_to_server') {
			commands.set(payload.actionId, { actionType: payload.actionType, arguments: payload.arguments });
			onCommand?.(payload, clock);
			noteCombatDispatch(worldState, payload.actionId, payload.actionType, payload.arguments);
			continue;
		}
		if (type === 'action_result' && row.direction === 'server_to_coordinator') {
			const command = commands.get(payload.actionId);
			settleCombatResult(worldState, payload);
			if (command) onResult?.(payload, command, Number.isSafeInteger(payload.observedAtEpochMs) ? payload.observedAtEpochMs : clock);
			if (!command || !planned) continue;
			results++;
			clock = Number.isSafeInteger(payload.observedAtEpochMs) ? payload.observedAtEpochMs : clock;
			await views.actionReceipt(record, { ...payload, goalRevision: 1, actionType: command.actionType, arguments: command.arguments, worldId: worldState.worldId });
			continue;
		}
		if (type !== 'observation' || row.direction !== 'server_to_coordinator') continue;
		const wire = payload.observation ?? payload;
		if (!Number.isFinite(wire.observedAtEpochMs)) continue;
		clock = wire.observedAtEpochMs; start ??= clock; last = clock;
		if (wire.world?.worldId) worldState.worldId = wire.world.worldId;
		let observation;
		// A sample the adapter refuses (a malformed section) is one production would also drop.
		try { observation = adaptObservation(wire); } catch { skipped++; continue; }
		const crystals = rememberEndCrystals(worldState, observation);
		if (crystals != null) observation.endCrystals = crystals;
		// The plan arrives with the first live sample, as the translator's advice does at task start.
		if (!planned && observation.ready === true && startPlan) {
			await views.observe(record, observation, wire);
			await views.operate(record, { operation: 'replace', plan: startPlan });
			planned = true;
		}
		while (turnEvents.length && turnEvents[0].at <= clock) {
			const event = turnEvents.shift();
			// Recorded intents name the recorded plan's steps; against another plan they keep their words but no step id.
			const intent = event.kind === 'intent' && fixed !== null ? { ...event.intent, step: `recorded-${event.intent.step}`.slice(0, 48) } : event.intent;
			try { await views.operate(record, event.kind === 'intent' ? { operation: 'intent', intent } : { operation: 'replace', plan: event.plan }); } catch { /* an intent the build rejects is skipped */ }
		}
		await views.observe(record, observation, wire);
		observations++;
		onObservation?.({ at: clock, wire, observation, views, record });
		const kind = views.progressWake(record);
		if (kind && (clock - start) / 60_000 >= fromMin) {
			const header = views.continuity(record) ?? {};
			wakes.push({ at: clock, minute: Math.round((clock - start) / 6_000) / 10, kind, line: kind === 'no_progress' ? header.progress : header.repeats, y: Math.floor(observation.player?.y ?? NaN), dimension: observation.world?.dimension });
		}
	}
	if (start !== null && planned) gaps.push({ from: gaps.at(-1)?.to ?? start, to: last, step: null, open: true });
	const minute = at => Math.round((at - start) / 6_000) / 10;
	return { dir, startAt: start, endAt: last, gainsAt: gaps.filter(g => !g.open).map(g => ({ at: g.to, step: g.step })), minutes: start === null ? 0 : minute(last), observations, skipped, results, wakes,
		gaps: gaps.map(g => ({ start: minute(g.from), minutes: Math.round((g.to - g.from) / 6_000) / 10, step: g.step, ...(g.open ? { open: true } : {}) })),
		repeatRuns: [...runs.values()].map(r => ({ key: r.key, count: r.count, start: minute(r.first), minutes: Math.round((r.last - r.first) / 6_000) / 10 })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = parseArgs(process.argv.slice(2));
	const all = [];
	for (const dir of args.dirs) {
		const result = await replay(dir, args);
		all.push(result);
		const counts = result.wakes.reduce((m, w) => ({ ...m, [w.kind]: (m[w.kind] ?? 0) + 1 }), {});
		console.log(`${path.basename(path.dirname(dir))}/${path.basename(dir)}: ${result.minutes} min, ${result.observations} obs, ${result.results} results, wakes ${JSON.stringify(counts)}`);
		if (!args.quiet) for (const w of result.wakes) console.log(`  ${w.minute.toFixed(1)}m ${w.kind} y${w.y} ${String(w.dimension).replace('minecraft:', '')}: ${w.line}`);
	}
	if (args.json) fs.writeFileSync(args.json, JSON.stringify(all, null, 1));
}
