// How the body spent the last minutes: acting, or standing still while the model decided. A player feels the time
// their own thinking takes; the model does not, and long runs showed the body idle 55% (Sol) to 94% (DeepSeek) of
// the wall clock while decisions were made one action at a time. Fed by the coordinator's own timing traces:
// native_decision_timing segments (provider generating) and native_tool_dispatch_started/native_tool_action_completed.

export const PACE_WINDOW_MS = 10 * 60_000;
/** Less recorded play than this says too little to report. */
export const PACE_MIN_SPAN_MS = 3 * 60_000;
const BUCKET_MS = 250;
const MAX_SPANS = 4096;

export class BodyPace {
	#agents = new Map();
	#now;

	constructor({ now = Date.now } = {}) { this.#now = now; }

	#agent(agentId) {
		let agent = this.#agents.get(agentId);
		if (agent === undefined) this.#agents.set(agentId, agent = { since: this.#now(), decisions: [], actions: [], running: new Map() });
		return agent;
	}

	/** One trace event; anything that is not a timing event is ignored. */
	note(event, fields) {
		const agentId = fields?.agentId;
		if (typeof agentId !== 'string') return;
		const now = this.#now();
		if (event === 'native_decision_timing') {
			const ms = Number(fields.segmentDurationMs);
			if (Number.isFinite(ms) && ms > 0) push(this.#agent(agentId).decisions, [now - ms, now]);
		} else if (event === 'native_tool_dispatch_started') {
			if (typeof fields.actionId === 'string' && fields.actionType !== 'wait') this.#agent(agentId).running.set(fields.actionId, now);
		} else if (event === 'native_tool_action_completed') {
			const agent = this.#agents.get(agentId), start = agent?.running.get(fields.actionId);
			if (start === undefined) return;
			agent.running.delete(fields.actionId);
			push(agent.actions, [start, now]);
		}
	}

	/** { actedMs, decidingMs, windowMs, medianDecisionMs } over the last window, or null with too little play. */
	summary(agentId) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return null;
		const now = this.#now(), from = Math.max(agent.since, now - PACE_WINDOW_MS);
		if (now - from < PACE_MIN_SPAN_MS) return null;
		const n = Math.ceil((now - from) / BUCKET_MS), acted = new Uint8Array(n), deciding = new Uint8Array(n);
		const mark = (marks, start, end) => {
			for (let i = Math.max(0, Math.floor((start - from) / BUCKET_MS)); i < Math.min(n, Math.ceil((end - from) / BUCKET_MS)); i++) marks[i] = 1;
		};
		for (const [start, end] of agent.actions) if (end > from) mark(acted, start, end);
		for (const start of agent.running.values()) mark(acted, start, now);
		const lengths = [];
		for (const [start, end] of agent.decisions) if (end > from) { mark(deciding, start, end); lengths.push(end - start); }
		let actedBuckets = 0, decidingBuckets = 0;
		for (let i = 0; i < n; i++) { if (acted[i]) actedBuckets++; else if (deciding[i]) decidingBuckets++; }
		lengths.sort((a, b) => a - b);
		return { actedMs: actedBuckets * BUCKET_MS, decidingMs: decidingBuckets * BUCKET_MS, windowMs: now - from,
			medianDecisionMs: lengths.length ? lengths[lengths.length >> 1] : null };
	}

	/** The header line: minutes acted and minutes stood still while the model decided, or null. */
	line(agentId) {
		const pace = this.summary(agentId);
		if (pace === null) return null;
		const minutes = ms => (ms / 60_000).toFixed(1);
		return `last ${minutes(pace.windowMs)} min: body acted ${minutes(pace.actedMs)} min, stood still ${minutes(pace.decidingMs)} min while you decided`
			+ (pace.medianDecisionMs === null ? '' : ` (median decision ${Math.round(pace.medianDecisionMs / 1000)} s)`);
	}

	forget(agentId) { this.#agents.delete(agentId); }
}

function push(spans, span) {
	spans.push(span);
	if (spans.length > MAX_SPANS) spans.splice(0, spans.length - MAX_SPANS);
}
