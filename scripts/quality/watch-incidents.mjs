#!/usr/bin/env node
// Incident library from a finished game: node scripts/quality/watch-incidents.mjs ARTIFACT_DIR --out LIBRARY_DIR [--lead-s 10] [--outcomes death,close_call]
// For each Watcher episode that ended in a death or a close call: a save point about lead-s seconds before the
// episode opened (the make-checkpoint.mjs builder at at:<epochMs>), the reflex rules the model had armed then (from
// provider-turns), and incident.json. The run's saved world (terrain as the game left it) is copied once per run,
// without players and entities, while the server directory still exists. Reads the run; writes only the library.
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildCheckpoint, parseEquipment, parseInventory } from '../../coordinator/src/benchmark/checkpoint.mjs';
import { normalizeReflexEntries, MAX_REFLEXES } from '../../coordinator/src/reflexes.mjs';
import { findWatchDirs, readWatchDir } from './watch-files.mjs';

async function* jsonl(file) {
	for await (const line of readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
		if (!line.trim()) continue;
		try { yield JSON.parse(line); } catch { /* a line cut by a crash */ }
	}
}

/** The headless run directory (manifest.json, quality-samples.jsonl) for a dir that holds arena-watch. */
export async function headlessRunDir(dir) {
	if (existsSync(path.join(dir, 'manifest.json')) && existsSync(path.join(dir, 'quality-samples.jsonl'))) return dir;
	const report = path.join(dir, 'run', 'LONG-r1.json');
	if (existsSync(report)) return JSON.parse(await readFile(report, 'utf8')).artifacts;
	throw new Error(`${dir} has no manifest.json and quality-samples.jsonl (nor run/LONG-r1.json)`);
}

/** Every tool call that carried reflex rules, in call order: {at, agentId, entries} with the model's own wording. */
export async function reflexCalls(providerTurnsFile) {
	const calls = [];
	if (!existsSync(providerTurnsFile)) return calls;
	for await (const row of jsonl(providerTurnsFile)) for (const call of row.capture?.calls ?? []) for (const tool of call.toolCalls ?? []) {
		let args = tool.arguments;
		if (typeof args === 'string') { if (!args.includes('reflexes')) continue; try { args = JSON.parse(args); } catch { continue; } }
		if (Array.isArray(args?.reflexes)) calls.push({ at: tool.at ?? row.timestamp, agentId: row.agentId, tool: tool.name, entries: args.reflexes });
	}
	return calls.sort((a, b) => a.at - b.at);
}

/**
 * The rules installed at atMs, rebuilt the way the coordinator's ReflexBook applies them: entries install, replace or
 * remove by id ("*" clears); a call whose entries do not validate or overflow the limit changes nothing. The episode's
 * cover.armed list, when present, picks the rules the mod reported armed; without it a rule past its ttlS has expired.
 * Context lifetimes (lasts) and rules the mod disabled are not modelled.
 */
export function armedRulesAt(calls, { agentId = null, atMs, armedIds = null } = {}) {
	const own = calls.filter(c => c.agentId === agentId);
	const relevant = (own.length ? own : calls.filter(c => !String(c.agentId).startsWith('goal-spec'))).filter(c => c.at <= atMs);
	let rules = new Map();
	for (const call of relevant) {
		let entries;
		try { entries = normalizeReflexEntries(call.entries); } catch { continue; }
		const next = new Map(rules);
		entries.forEach((entry, i) => {
			if (entry.remove === true) { if (entry.id === '*') next.clear(); else next.delete(entry.id); }
			else next.set(entry.id, { rule: call.entries[i], installedAt: call.at, ttlMs: entry.ttlMs ?? null });
		});
		if (next.size <= MAX_REFLEXES) rules = next;
	}
	// The Watcher names each armed rule "<rule id>:<trigger type>" (Watcher.java); trigger types hold no colon. Its list
	// is the truth: the mod counts ttl in server ticks, so on a server below 20 TPS a rule outlives its wall-clock ttl.
	const ids = Array.isArray(armedIds) ? armedIds.map(armedRuleId) : null;
	const live = ids?.length ? [...rules.values()] : [...rules.values()].filter(r => r.ttlMs === null || r.installedAt + r.ttlMs >= atMs);
	const armed = ids?.length ? live.filter(r => ids.includes(r.rule.id)) : live;
	return { rules: armed.map(r => r.rule), installedAt: Object.fromEntries(armed.map(r => [r.rule.id, r.installedAt])),
		missingFromProviderTurns: ids ? ids.filter(id => !live.some(r => r.rule.id === id)) : [] };
}

/** The rule id in a Watcher cover.armed entry ("shield:hostile_near" -> "shield"); a bare id stays as it is. */
export const armedRuleId = entry => { const text = String(entry), cut = text.lastIndexOf(':'); return cut > 0 ? text.slice(0, cut) : text; };

const withDamage = (id, damage) => damage === null || damage === undefined ? id : `${id}[minecraft:damage=${damage}]`;

/**
 * The body's hands as the sample saw them: every inventory slot by number, the offhand and the selected hotbar slot. The
 * save point's bag (buildCheckpoint) puts an offhand shield back in the inventory, which suits a restarted game but not
 * a replay of a shield rule (every one read "lacks: no shield in either hand").
 */
export function hands(sample) {
	const slots = parseInventory(sample.inventoryNbt).map(i => ({ slot: i.slot, item: withDamage(i.id, i.damage), count: i.count }));
	const offhand = parseEquipment(sample.entityNbt, sample.equipmentNbt).offhand;
	const selected = Number(String(sample.entityNbt ?? '').match(/\bSelectedItemSlot: (\d+)/)?.[1]);
	return { slots, offhand: offhand ? withDamage(offhand.id, offhand.damage) : null, selectedSlot: Number.isInteger(selected) ? selected : null };
}

const safe = text => String(text).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80);

export async function buildIncidents(artifactDir, { out, leadMs = 10000, outcomes = ['death', 'close_call'] } = {}) {
	const made = [];
	for (const watchDir of await findWatchDirs(path.resolve(artifactDir))) {
		const watch = await readWatchDir(watchDir);
		const episodes = watch.episodes.filter(e => outcomes.includes(e.outcome));
		if (!episodes.length) continue;
		const runDir = await headlessRunDir(watch.run);
		const manifest = JSON.parse(await readFile(path.join(runDir, 'manifest.json'), 'utf8'));
		const samples = [];
		for await (const s of jsonl(path.join(runDir, 'quality-samples.jsonl'))) samples.push(s);
		const calls = await reflexCalls(manifest.providerTurns && existsSync(manifest.providerTurns) ? manifest.providerTurns : path.join(runDir, 'provider-turns.private.jsonl'));
		const runKey = safe(path.basename(runDir));
		const runOut = path.join(path.resolve(out), runKey);
		await mkdir(runOut, { recursive: true });
		// Terrain as the game left it (blocks Sol placed or dug included). Without it a replay regenerates from the seed.
		const serverDir = manifest.serverDirectory && existsSync(manifest.serverDirectory) ? manifest.serverDirectory : path.join(runDir, 'server');
		const levelDir = manifest.levelName ? path.join(serverDir, manifest.levelName) : null;
		let world = null;
		if (existsSync(path.join(runOut, 'world', 'level.dat'))) world = 'world';
		else if (levelDir && existsSync(path.join(levelDir, 'level.dat'))) {
			await cp(levelDir, path.join(runOut, 'world'), { recursive: true, filter: file => !/[\\/](players|entities)([\\/]|$)|session\.lock$/.test(file.slice(levelDir.length)) });
			world = 'world';
		}
		const run = { artifacts: runDir, runId: manifest.runId, scenarioId: manifest.scenarioId, seed: String(manifest.world?.seed ?? ''), model: manifest.model, reasoningEffort: manifest.reasoningEffort, world };
		await writeFile(path.join(runOut, 'run.json'), JSON.stringify(run, null, 2) + '\n');
		for (const episode of episodes) {
			const opened = episode.openedAt?.epochMs;
			if (!Number.isFinite(opened)) { console.warn(`skip ${episode.id}: no openedAt.epochMs`); continue; }
			// The save point: the first sample at or after (opened - lead); a game younger than the lead starts at its first sample.
			const target = Math.max(opened - leadMs, samples[0]?.at ?? 0);
			let savepoint;
			try { savepoint = buildCheckpoint(samples, { milestone: `at:${Math.round(target)}`, seed: run.seed, source: runDir }); }
			catch (error) { console.warn(`skip ${episode.id}: ${error.message}`); continue; }
			const sample = samples[savepoint.sampleIndex];
			const dir = path.join(runOut, safe(episode.id));
			await mkdir(dir, { recursive: true });
			const armed = armedRulesAt(calls, { agentId: episode.agentId, atMs: opened, armedIds: episode.cover?.armed ?? null });
			const incident = { schemaVersion: 1, id: `${runKey}/${safe(episode.id)}`, episode, run: { ...run, world: world ? '../world' : null },
				savepoint: { file: 'savepoint.json', atMs: sample.at, leadMs: opened - sample.at, health: sample.health ?? null, fallDistance: sample.fallDistance ?? 0, deathsBefore: sample.deathCounter ?? null,
					hands: hands(sample) },
				reflexes: { source: 'provider-turns tool calls carrying reflexes, applied in order up to openedAt', ...armed } };
			await writeFile(path.join(dir, 'savepoint.json'), JSON.stringify(savepoint, null, '\t') + '\n');
			await writeFile(path.join(dir, 'incident.json'), JSON.stringify(incident, null, 2) + '\n');
			made.push(incident);
			console.log(`${incident.id}: ${episode.kind} ${episode.outcome} (${episode.diagnosis}); save point ${Math.round(incident.savepoint.leadMs / 100) / 10} s before at ${savepoint.setup.dimension} ${savepoint.setup.position.map(Math.round).join(' ')}; ${armed.rules.length} armed rules${armed.missingFromProviderTurns.length ? `, not found: ${armed.missingFromProviderTurns.join(',')}` : ''}`);
		}
	}
	return made;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2), opts = {};
	let dir = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--out') opts.out = argv[++i];
		else if (argv[i] === '--lead-s') opts.leadMs = Number(argv[++i]) * 1000;
		else if (argv[i] === '--outcomes') opts.outcomes = argv[++i].split(',');
		else dir = argv[i];
	}
	if (!dir || !opts.out || !(opts.leadMs === undefined || opts.leadMs >= 0)) { console.error('Usage: node scripts/quality/watch-incidents.mjs ARTIFACT_DIR --out LIBRARY_DIR [--lead-s 10] [--outcomes death,close_call]'); process.exit(2); }
	const made = await buildIncidents(dir, opts);
	console.log(`${made.length} incident(s) in ${path.resolve(opts.out)}`);
}
