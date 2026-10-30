#!/usr/bin/env node
// Feel-harness analyzer: turns coordinator.jsonl + server log into per-agent play-feel metrics.
// Usage: node analyze.mjs --coordinator <coordinator.jsonl> --log <server-or-game log> [--out-md f] [--out-json f]
//          [--span actions|first-event] (actions = first dispatch to last completion, matches the Oct 2026 live-run numbers) [--window-min N] [--label text]
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: {
	coordinator: { type: 'string' }, log: { type: 'string' }, 'out-md': { type: 'string' }, 'out-json': { type: 'string' },
	span: { type: 'string', default: 'actions' }, 'window-min': { type: 'string' }, label: { type: 'string', default: '' },
	'exclude-name': { type: 'string', default: 'aGamingGod' },
} });
if (!opt.coordinator || !opt.log) { console.error('need --coordinator and --log'); process.exit(2); }

const MILESTONES = [
	['Stone Age', 'Stone Age'], ['Acquire Hardware', 'Acquire Hardware'], ["Isn't It Iron Pick", "Isn't It Iron Pick"],
	['Suit Up', 'Suit Up'], ['Hot Stuff', 'Hot Stuff'], ['Diamonds!', 'Diamonds!'], ['We Need to Go Deeper', 'We Need to Go Deeper'],
];
const GAP_BINS = [['<1s', 0, 1], ['1-3s', 1, 3], ['3-8s', 3, 8], ['8-20s', 8, 20], ['20-60s', 20, 60], ['>60s', 60, Infinity]];

async function lines(path, fn) {
	const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
	for await (const l of rl) fn(l);
}
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const round = (x, d = 1) => x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d;
const stripFmt = (s) => s.replace(/§./g, '');

// ---- coordinator events, grouped by agent
const agents = new Map();
const agent = (id) => { if (!agents.has(id)) agents.set(id, { id, provider: null, model: null, effort: null, first: null, last: null, dispatch: new Map(), actions: [], turns: 0, modelCalls: 0, decision: [], rejected: new Map(), turnFailed: new Map() }); return agents.get(id); };
await lines(opt.coordinator, (l) => {
	if (!l) return; let j; try { j = JSON.parse(l); } catch { return; }
	if (!j.agentId || typeof j.at !== 'number') return;
	const a = agent(j.agentId);
	if (j.provider && !a.provider) { a.provider = j.provider; a.model = j.model ?? a.model; a.effort = j.reasoningEffort ?? a.effort; }
	if (a.first === null || j.at < a.first) a.first = j.at;
	if (a.last === null || j.at > a.last) a.last = j.at;
	switch (j.event) {
		case 'native_tool_dispatch_started': a.dispatch.set(j.actionId, { at: j.at, type: j.actionType }); break;
		case 'native_tool_action_completed': {
			const d = a.dispatch.get(j.actionId);
			if (d) a.actions.push({ start: d.at, end: j.at, type: d.type, state: j.state, reason: j.reasonCode });
			break;
		}
		case 'native_turn_admitted': a.turns++; break;
		case 'native_token_usage': a.modelCalls++; break;
		case 'native_model_call': if (!a.provider && j.provider) a.provider = j.provider; break;
		case 'native_decision_timing': if (typeof j.segmentDurationMs === 'number') a.decision.push(j.segmentDurationMs); break;
		case 'native_tool_rejected': { const k = j.reasonCode ?? (j.toolName ? `${j.toolName}: ${String(j.reason ?? '').slice(0, 40)}` : 'unknown'); a.rejected.set(k, (a.rejected.get(k) ?? 0) + 1); break; }
		case 'native_turn_failed': a.turnFailed.set(j.errorCode, (a.turnFailed.get(j.errorCode) ?? 0) + 1); break;
	}
});

// ---- server log: players, advancements, chat, deaths
const players = new Map(); // name -> {join: sec-of-day}
const adv = []; // {name, adv, sod}
const chat = []; // {name, sod}
const deaths = []; // {name, text, sod}
const toSod = (h, m, s) => (+h) * 3600 + (+m) * 60 + (+s);
let dayRoll = 0, prevSod = -1;
await lines(opt.log, (l) => {
	const m = l.match(/^\[(\d\d):(\d\d):(\d\d)\] \[Server thread\/INFO\]: (.*)$/);
	if (!m) return;
	let sod = toSod(m[1], m[2], m[3]);
	if (prevSod > 82800 && sod < 3600) dayRoll += 86400; // midnight rollover
	prevSod = sod; sod += dayRoll;
	const t = stripFmt(m[4]).trimEnd();
	let x;
	if ((x = t.match(/^(.+?) joined the game$/))) { if (!players.has(x[1])) players.set(x[1], { join: sod }); return; }
	if ((x = t.match(/^(.+?) has made the advancement \[(.+)\]$/))) { adv.push({ name: x[1], adv: x[2], sod }); return; }
	if ((x = t.match(/^\[([^\]]+)\] (.*)$/))) { chat.push({ name: x[1], sod }); return; }
	if ((x = t.match(/^(.+?) (was (?:blown up|shot|slain|killed|burned|fireballed|pricked|squashed|pummeled|impaled|stung|struck|doomed|killed)|burned to death|drowned|fell |hit the ground|died|suffocated|starved|tried to swim in lava|walked into|went up in flames|withered|blew up|experienced kinetic|discovered the floor|was squished|froze to death)(.*)$/))) {
		if (players.has(x[1]) || x[1]) deaths.push({ name: x[1], text: t, sod });
	}
});

function matchName(a) {
	const cands = [...players.keys()].filter((n) => n !== opt['exclude-name'] && !/^(Server|Rcon|\[)/.test(n));
	const agentNames = cands.filter((n) => !/^[A-Z][a-z]+\d*$/.test(n) || /_|\s/.test(n) || true);
	const re = a.provider === 'codex' ? /gpt|sol|codex|luna/i : a.provider === 'claude' ? /claude|opus|sonnet|fable/i : null;
	const hit = re ? agentNames.filter((n) => re.test(n)) : [];
	if (hit.length) return hit[0];
	return agentNames.length === 1 ? agentNames[0] : null;
}

function unionBusy(intervals, lo, hi) {
	const iv = intervals.map((i) => [Math.max(i.start, lo), Math.min(i.end, hi)]).filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
	const out = [];
	for (const [s, e] of iv) { const last = out[out.length - 1]; if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]); }
	return out;
}

const results = [];
for (const a of agents.values()) {
	if (!a.provider || a.actions.length === 0 && a.turns === 0) continue; // skip phantom ids
	const name = matchName(a);
	const first = a.first, last = a.last;
	let lo = first, hi = last;
	const fullBusyMs = unionBusy(a.actions, first, last).reduce((s, [x, y]) => s + (y - x), 0);
	if (opt.span === 'actions' && a.actions.length) { lo = Math.min(...a.actions.map((x) => x.start)); hi = Math.max(...a.actions.map((x) => x.end)); }
	if (opt['window-min']) hi = Math.min(hi, lo + Number(opt['window-min']) * 60000);
	const spanMs = hi - lo;
	const busy = unionBusy(a.actions, lo, hi);
	const busyMs = busy.reduce((s, [x, y]) => s + (y - x), 0);
	// idle gaps include lead-in and trailing idle inside the span
	const gaps = []; let cur = lo;
	for (const [s, e] of busy) { if (s > cur) gaps.push((s - cur) / 1000); cur = e; }
	if (hi > cur) gaps.push((hi - cur) / 1000);
	const hist = GAP_BINS.map(([label, a0, a1]) => { const g = gaps.filter((x) => x >= a0 && x < a1); return { bin: label, count: g.length, totalSec: round(g.reduce((s, x) => s + x, 0)) }; });
	const spanMin = spanMs / 60000;
	const inSpan = a.actions.filter((x) => x.start >= lo && x.start <= hi);
	const byType = {};
	for (const x of inSpan) { const t = (byType[x.type ?? '?'] ??= { count: 0, failed: 0, reasons: {} }); t.count++; if (x.state !== 'SUCCEEDED') { t.failed++; t.reasons[x.reason ?? x.state] = (t.reasons[x.reason ?? x.state] ?? 0) + 1; } }
	const reasonTotals = {};
	for (const t of Object.values(byType)) for (const [r, c] of Object.entries(t.reasons)) reasonTotals[r] = (reasonTotals[r] ?? 0) + c;
	const topReasons = Object.entries(reasonTotals).sort((x, y) => y[1] - x[1]).slice(0, 8);
	const failed = inSpan.filter((x) => x.state !== 'SUCCEEDED').length;
	// log-derived
	const joinSod = name && players.get(name)?.join;
	const myAdv = adv.filter((x) => x.name === name);
	const minutes = {};
	for (const [key, title] of MILESTONES) { const hit = myAdv.find((x) => x.adv === title); minutes[key] = hit && joinSod !== undefined ? round((hit.sod - joinSod) / 60) : null; }
	const myChat = chat.filter((x) => x.name === name && (joinSod === undefined || !opt['window-min'] || x.sod <= joinSod + Number(opt['window-min']) * 60));
	const chatSpanMin = joinSod !== undefined && myChat.length ? Math.max(spanMin, 0.01) : spanMin;
	const myDeaths = deaths.filter((x) => x.name === name);
	results.push({
		agentId: a.id, name, provider: a.provider, model: a.model, reasoningEffort: a.effort,
		spanMin: round(spanMin, 2), firstEventAt: first, joinClock: joinSod === undefined ? null : joinSod,
		bodyBusyPct: round(spanMs ? (busyMs / spanMs) * 100 : 0), bodyBusyFullEventSpanPct: round(last > first ? (fullBusyMs / (last - first)) * 100 : 0),
		idleGaps: hist, longestIdleSec: round(Math.max(0, ...gaps)),
		actionsTotal: inSpan.length, actionsFailed: failed, failureRatePct: round(inSpan.length ? (failed / inSpan.length) * 100 : 0),
		actionsByType: Object.fromEntries(Object.entries(byType).sort((x, y) => y[1].count - x[1].count).map(([k, v]) => [k, { count: v.count, failed: v.failed, failurePct: round((v.failed / v.count) * 100) }])),
		topFailureReasons: topReasons, toolRejections: [...a.rejected.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5),
		turnFailures: Object.fromEntries(a.turnFailed),
		modelTurns: a.turns, modelCalls: a.modelCalls, turnsPerMin: round(spanMin ? a.turns / spanMin : 0, 2), modelCallsPerMin: round(spanMin ? a.modelCalls / spanMin : 0, 2),
		decisionLatencyMs: { n: a.decision.length, median: round(med(a.decision), 0), p90: round(pct(a.decision, 0.9), 0) },
		chatLines: myChat.length, chatPerMin: round(chatSpanMin ? myChat.length / chatSpanMin : 0, 2),
		deaths: myDeaths.length, deathLines: myDeaths.map((d) => d.text.slice(0, 80)),
		minutesToAdvancement: minutes,
		advancementTimeline: myAdv.map((x) => ({ adv: x.adv, min: joinSod === undefined ? null : round((x.sod - joinSod) / 60) })),
	});
}

// ---- render
const f = (v) => v === null || v === undefined ? 'n/a' : String(v);
let md = `# Feel metrics${opt.label ? `: ${opt.label}` : ''}\n\n`;
md += `Span mode: ${opt.span}${opt['window-min'] ? `, window ${opt['window-min']} min` : ''}. Minutes are from the agent's join line in the server log.\n\n`;
md += `| Metric | ${results.map((r) => `${r.provider}/${r.model ?? ''} (${r.reasoningEffort ?? ''})`).join(' | ')} |\n|---|${results.map(() => '---').join('|')}|\n`;
const row = (label, fn) => { md += `| ${label} | ${results.map((r) => f(fn(r))).join(' | ')} |\n`; };
row('Agent name in log', (r) => r.name);
row('Span (min)', (r) => r.spanMin);
row('Body-busy %', (r) => r.bodyBusyPct);
row('Body-busy % over full coordinator span', (r) => r.bodyBusyFullEventSpanPct);
row('Actions (failed, %)', (r) => `${r.actionsTotal} (${r.actionsFailed}, ${r.failureRatePct}%)`);
row('Model turns / min', (r) => `${r.turnsPerMin} (${r.modelTurns} total)`);
row('Model calls (token usage events) / min', (r) => r.modelCallsPerMin);
row('Decision latency median / p90 (s)', (r) => `${round((r.decisionLatencyMs.median ?? 0) / 1000)} / ${round((r.decisionLatencyMs.p90 ?? 0) / 1000)}`);
row('Chat lines (per min)', (r) => `${r.chatLines} (${r.chatPerMin})`);
row('Deaths', (r) => r.deaths);
row('Longest idle gap (s)', (r) => r.longestIdleSec);
for (const [key] of MILESTONES) row(`Min to ${key}`, (r) => r.minutesToAdvancement[key]);
md += '\n## Idle gaps (count / total seconds)\n\n| Bin | ' + results.map((r) => r.provider).join(' | ') + ' |\n|---|' + results.map(() => '---').join('|') + '|\n';
for (let i = 0; i < GAP_BINS.length; i++) md += `| ${GAP_BINS[i][0]} | ${results.map((r) => `${r.idleGaps[i].count} / ${r.idleGaps[i].totalSec}`).join(' | ')} |\n`;
for (const r of results) {
	md += `\n## ${r.provider}: actions by type\n\n| Type | Count | Failed | Fail % |\n|---|---|---|---|\n`;
	for (const [k, v] of Object.entries(r.actionsByType)) md += `| ${k} | ${v.count} | ${v.failed} | ${v.failurePct} |\n`;
	md += `\nTop failure reasonCodes: ${r.topFailureReasons.map(([k, c]) => `${k} x${c}`).join(', ') || 'none'}\n`;
	if (r.toolRejections.length) md += `\nTool rejections: ${r.toolRejections.map(([k, c]) => `${k} x${c}`).join(', ')}\n`;
	if (Object.keys(r.turnFailures).length) md += `\nTurn failures: ${Object.entries(r.turnFailures).map(([k, c]) => `${k} x${c}`).join(', ')}\n`;
	md += `\nAdvancement timeline: ${r.advancementTimeline.map((x) => `${x.adv} @${f(x.min)}m`).join(', ') || 'none'}\n`;
	if (r.deathLines.length) md += `\nDeaths: ${r.deathLines.join('; ')}\n`;
}
if (opt['out-md']) writeFileSync(opt['out-md'], md);
if (opt['out-json']) writeFileSync(opt['out-json'], JSON.stringify({ label: opt.label, span: opt.span, agents: results }, null, 2));
if (!opt['out-md']) process.stdout.write(md);
