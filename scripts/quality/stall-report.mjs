#!/usr/bin/env node
// Where a game got stuck: node scripts/quality/stall-report.mjs ARTIFACT_DIR [--stall-minutes 10]
// Prints each milestone's first time, each death, and every stretch with no new milestone, with depth, dimension and item changes.
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { LONG_RUN_MILESTONES } from '../../coordinator/src/benchmark/long-run.mjs';
import { parseInventory, parseEquipment } from '../../coordinator/src/benchmark/checkpoint.mjs';

export function stallReport(samples, { stallMinutes = 10 } = {}) {
	if (!samples.length) return { milestones: [], deaths: [], stalls: [] };
	const t0 = samples[0].at, min = s => (s.at - t0) / 60000;
	const items = s => { const out = new Map(); for (const i of parseInventory(s.inventoryNbt)) out.set(i.id, (out.get(i.id) ?? 0) + i.count); for (const e of Object.values(parseEquipment(s.entityNbt, s.equipmentNbt))) out.set(e.id, (out.get(e.id) ?? 0) + 1); return out; };
	const holds = (m, s, inv) => (m.item && [...inv.keys()].some(id => m.item.test(id))) || (m.dimension && s.dimension === m.dimension) || (m.advancement && (s.advancements ?? []).includes(m.advancement));
	const milestones = [], deaths = [], seen = new Set();
	let lastDeaths = samples[0].deathCounter ?? 0;
	for (const s of samples) {
		const inv = items(s);
		for (const m of LONG_RUN_MILESTONES) if (!seen.has(m.id) && holds(m, s, inv)) { seen.add(m.id); milestones.push({ id: m.id, label: m.label, minute: min(s) }); }
		if ((s.deathCounter ?? 0) > lastDeaths) deaths.push({ minute: min(s), dimension: s.dimension, y: Math.round(s.position.y) });
		lastDeaths = s.deathCounter ?? lastDeaths;
	}
	const marks = [0, ...milestones.map(m => m.minute), min(samples.at(-1))];
	const stalls = [];
	for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] >= stallMinutes) {
		const span = samples.filter(s => min(s) >= marks[i - 1] && min(s) <= marks[i]);
		const before = items(span[0]), after = items(span.at(-1));
		const change = [...new Set([...before.keys(), ...after.keys()])].map(id => [id.replace('minecraft:', ''), (after.get(id) ?? 0) - (before.get(id) ?? 0)]).filter(([, d]) => d).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8);
		const ys = span.map(s => s.position.y);
		const dims = [...new Set(span.map(s => s.dimension.replace('minecraft:', '')))];
		const distance = Math.round(span.slice(1).reduce((d, s, k) => d + Math.hypot(s.position.x - span[k].position.x, s.position.z - span[k].position.z), 0));
		stalls.push({ from: marks[i - 1], to: marks[i], minutes: marks[i] - marks[i - 1], next: i - 1 < milestones.length ? milestones[i - 1].label : 'end of game', dims,
			yMin: Math.round(Math.min(...ys)), yMax: Math.round(Math.max(...ys)), walked: distance, deaths: deaths.filter(d => d.minute >= marks[i - 1] && d.minute <= marks[i]).length, change });
	}
	return { length: min(samples.at(-1)), milestones, deaths, stalls };
}

export function formatStallReport(r) {
	const f = n => n.toFixed(1);
	return [`Game length ${f(r.length)} min, ${r.milestones.length}/${LONG_RUN_MILESTONES.length} milestones, ${r.deaths.length} deaths`, '',
		'Milestones:', ...r.milestones.map(m => `  ${f(m.minute).padStart(6)}  ${m.label}`), '',
		'Deaths:', ...(r.deaths.length ? r.deaths.map(d => `  ${f(d.minute).padStart(6)}  ${d.dimension.replace('minecraft:', '')} y${d.y}`) : ['  none']), '',
		'No-progress stretches:', ...(r.stalls.length ? r.stalls.map(s => `  ${f(s.from)}-${f(s.to)} (${f(s.minutes)} min) before "${s.next}": ${s.dims.join('/')} y${s.yMin}..${s.yMax}, walked ${s.walked}, deaths ${s.deaths}; items ${s.change.map(([id, d]) => `${id} ${d > 0 ? '+' : ''}${d}`).join(', ') || 'unchanged'}`) : ['  none'])].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [arg, flag, value] = process.argv.slice(2);
	if (!arg) { console.error('Usage: stall-report.mjs ARTIFACT_DIR [--stall-minutes 10]'); process.exit(2); }
	let dir = path.resolve(arg);
	const report = path.join(dir, 'run', 'LONG-r1.json');
	if (!existsSync(path.join(dir, 'quality-samples.jsonl')) && existsSync(report)) dir = JSON.parse(await readFile(report, 'utf8')).artifacts;
	const samples = [];
	for await (const line of readline.createInterface({ input: createReadStream(path.join(dir, 'quality-samples.jsonl')) })) if (line.trim()) samples.push(JSON.parse(line));
	console.log(formatStallReport(stallReport(samples, { stallMinutes: flag === '--stall-minutes' ? Number(value) : 10 })));
}
