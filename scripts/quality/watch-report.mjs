#!/usr/bin/env node
// Danger report from Watcher files: node scripts/quality/watch-report.mjs ARTIFACT_DIR... [--out DIR]
// Per run and in total: episodes by kind x outcome, by diagnosis, the top system patches, forecasts that became
// episodes, and close calls per death by kind; then the time lost (watch-time.mjs: minutes lost by label and the top
// system fixes) unless --no-time. Writes watch-report.json and watch-report.md (default: the single artifact dir, else
// the current directory). Reads files only.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWatchDirs, readWatchDir } from './watch-files.mjs';
import { buildTimeReport, formatTimeSection } from './watch-time.mjs';

export const OUTCOMES = ['death', 'damage', 'close_call', 'avoided'];
/** Diagnoses that point at the system; MODEL_CHOICE and UNPERCEIVABLE are logged only. */
export const SYSTEM_DIAGNOSES = ['PERCEPTION_GAP', 'FACT_GAP', 'NO_PRIMITIVE', 'REFLEX_FAILED', 'REFLEX_SLOW', 'BODY_CAUSED'];
const evidenceText = e => (e === undefined || e === null ? '' : typeof e === 'string' ? e : JSON.stringify(e));
const zero = () => Object.fromEntries(OUTCOMES.map(o => [o, 0]));

/** System patches: (diagnosis, kind) groups ranked by deaths, then damage outcomes, then close calls, then damage taken. */
export function rankPatches(episodes, { examples = 2 } = {}) {
	const groups = new Map();
	for (const e of episodes) {
		if (!SYSTEM_DIAGNOSES.includes(e.diagnosis)) continue;
		const key = `${e.diagnosis}\u0000${e.kind}`;
		let g = groups.get(key);
		if (!g) groups.set(key, g = { diagnosis: e.diagnosis, kind: e.kind, episodes: 0, deaths: 0, damage: 0, closeCalls: 0, avoided: 0, damageTaken: 0, examples: [] });
		g.episodes++;
		if (e.outcome === 'death') g.deaths++;
		else if (e.outcome === 'damage') g.damage++;
		else if (e.outcome === 'close_call') g.closeCalls++;
		else if (e.outcome === 'avoided') g.avoided++;
		g.damageTaken += Number.isFinite(e.damage) ? e.damage : 0;
		const text = evidenceText(e.evidence);
		if (text && g.examples.length < examples && !g.examples.includes(text)) g.examples.push(text);
	}
	return [...groups.values()]
		.map(g => ({ ...g, damageTaken: Math.round(g.damageTaken * 10) / 10 }))
		.sort((a, b) => b.deaths - a.deaths || b.damage - a.damage || b.closeCalls - a.closeCalls || b.damageTaken - a.damageTaken || a.diagnosis.localeCompare(b.diagnosis) || String(a.kind).localeCompare(String(b.kind)));
}

/** The counts for one set of episodes and forecasts. */
export function summarizeWatch(episodes, forecasts = [], { top = 10 } = {}) {
	const byKindOutcome = {}, byDiagnosis = {};
	for (const e of episodes) {
		const row = byKindOutcome[e.kind] ??= zero();
		if (OUTCOMES.includes(e.outcome)) row[e.outcome]++;
		byDiagnosis[e.diagnosis ?? 'NONE'] = (byDiagnosis[e.diagnosis ?? 'NONE'] ?? 0) + 1;
	}
	const closeCallsPerDeath = Object.fromEntries(Object.entries(byKindOutcome).map(([kind, row]) => [kind, { closeCalls: row.close_call, deaths: row.death, ratio: row.death ? Math.round(row.close_call / row.death * 100) / 100 : null }]));
	// A forecast became an episode when the episode names it; forecasts and episodes are matched within one agent.
	const forecastIds = new Set(forecasts.map(f => `${f.agentId}\u0000${f.id}`));
	const realized = episodes.filter(e => e.forecastId != null && (forecastIds.has(`${e.agentId}\u0000${e.forecastId}`) || !forecasts.length));
	const realizedForecasts = { forecasts: forecasts.length, becameEpisodes: new Set(realized.map(e => `${e.agentId}\u0000${e.forecastId}`)).size,
		byOutcome: Object.fromEntries(OUTCOMES.map(o => [o, realized.filter(e => e.outcome === o).length])),
		examples: realized.slice(0, 5).map(e => { const f = forecasts.find(x => x.agentId === e.agentId && x.id === e.forecastId); return { episode: e.id, kind: e.kind, outcome: e.outcome, forecast: f ? { action: f.action, hazard: f.hazard } : e.forecastId }; }) };
	return { episodes: episodes.length, deaths: episodes.filter(e => e.outcome === 'death').length, closeCalls: episodes.filter(e => e.outcome === 'close_call').length,
		byKindOutcome, byDiagnosis, patches: rankPatches(episodes).slice(0, top), realizedForecasts, closeCallsPerDeath };
}

/** Reads every arena-watch directory under the given paths; duplicate episodes (same agent and id) count once. */
export async function buildWatchReport(dirs, options = {}) {
	const runs = [], seen = new Set(), all = { episodes: [], forecasts: [] };
	for (const dir of dirs) for (const watchDir of await findWatchDirs(path.resolve(dir))) {
		const data = await readWatchDir(watchDir);
		const episodes = data.episodes.filter(e => { const key = `${e.agentId}\u0000${e.id}`; if (seen.has(key)) return false; seen.add(key); return true; });
		all.episodes.push(...episodes); all.forecasts.push(...data.forecasts);
		runs.push({ run: data.run, droppedLines: data.dropped, schemaVersions: [...new Set([...data.episodes, ...data.forecasts].map(r => r.v))], ...summarizeWatch(episodes, data.forecasts, options) });
	}
	const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), inputs: dirs.map(d => path.resolve(d)), runs, total: summarizeWatch(all.episodes, all.forecasts, options) };
	if (options.time) {
		const time = await buildTimeReport(dirs);
		report.time = { total: time.total, runs: time.runs.map(({ episodeList, ...run }) => run) };
	}
	return report;
}

function section(title, s) {
	const lines = [`## ${title}`, '', `${s.episodes} episodes: ${s.deaths} deaths, ${s.closeCalls} close calls.`, ''];
	const kinds = Object.keys(s.byKindOutcome).sort();
	if (kinds.length) {
		lines.push('| kind | death | damage | close call | avoided | close calls per death |', '|---|---|---|---|---|---|');
		for (const k of kinds) { const r = s.byKindOutcome[k], c = s.closeCallsPerDeath[k]; lines.push(`| ${k} | ${r.death} | ${r.damage} | ${r.close_call} | ${r.avoided} | ${c.ratio ?? (c.closeCalls ? `${c.closeCalls}:0` : '-')} |`); }
		lines.push('');
	}
	const diagnoses = Object.entries(s.byDiagnosis).sort((a, b) => b[1] - a[1]);
	if (diagnoses.length) lines.push(`Diagnoses: ${diagnoses.map(([d, n]) => `${d} ${n}${SYSTEM_DIAGNOSES.includes(d) ? '' : ' (logged)'}`).join(', ')}.`, '');
	if (s.patches.length) {
		lines.push('Top system patches:', '');
		s.patches.forEach((p, i) => {
			lines.push(`${i + 1}. **${p.diagnosis} / ${p.kind}**: ${p.deaths} deaths, ${p.damage} damage, ${p.closeCalls} close calls (${p.damageTaken} hp)`);
			for (const ex of p.examples) lines.push(`   - ${ex.replace(/\s+/g, ' ').slice(0, 300)}`);
		});
		lines.push('');
	}
	const f = s.realizedForecasts;
	lines.push(`Forecasts: ${f.forecasts}; ${f.becameEpisodes} became episodes (${OUTCOMES.map(o => `${f.byOutcome[o]} ${o.replace('_', ' ')}`).join(', ')}).`, '');
	return lines.join('\n');
}

export function formatWatchReport(report) {
	const time = report.time ? ['# Time lost', '', formatTimeSection(report.time.total, `All runs (${report.time.runs.map(r => r.mode).filter(m => m === 'degraded').length} of ${report.time.runs.length} without progress truth)`)] : [];
	return ['# Watcher danger report', '', `Generated ${report.generatedAt} from ${report.runs.length} run(s).`, '', section('All runs', report.total),
		...report.runs.map(r => section(`Run ${r.run}`, r) + (r.droppedLines ? `\n${r.droppedLines} unreadable lines skipped.\n` : '')), ...time].join('\n');
}

function compactLine(report) {
	const t = report.total, p = t.patches[0], time = report.time?.total, fix = time?.topFixes[0];
	return `${report.runs.length} run(s), ${t.episodes} episodes, ${t.deaths} deaths, ${t.closeCalls} close calls${p ? `; top patch ${p.diagnosis}/${p.kind} (${p.deaths} deaths, ${p.damage} damage, ${p.closeCalls} close calls)` : ''}`
		+ (time ? `; time lost ${time.minutesLost} of ${time.runMinutes} min${fix ? `, top fix ${fix.name} (${fix.minutes} min)` : ''}` : '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const argv = process.argv.slice(2), dirs = [];
	let out = null, time = true;
	for (let i = 0; i < argv.length; i++) { if (argv[i] === '--out') out = argv[++i]; else if (argv[i] === '--no-time') time = false; else dirs.push(argv[i]); }
	if (!dirs.length) { console.error('Usage: node scripts/quality/watch-report.mjs ARTIFACT_DIR... [--out DIR] [--no-time]'); process.exit(2); }
	const report = await buildWatchReport(dirs, { time });
	out = path.resolve(out ?? (dirs.length === 1 ? dirs[0] : '.'));
	await mkdir(out, { recursive: true });
	const md = formatWatchReport(report);
	await writeFile(path.join(out, 'watch-report.json'), JSON.stringify(report, null, 2) + '\n');
	await writeFile(path.join(out, 'watch-report.md'), md);
	console.log(md);
	console.log(`${compactLine(report)}\nWrote ${path.join(out, 'watch-report.json')} and watch-report.md`);
}
