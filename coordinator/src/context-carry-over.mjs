// Every model call re-reads the whole provider conversation. Past this many context tokens a provider session is
// replaced by a fresh one (same instructions and tools) that starts with this short carry-over; each event already
// restates the goal, task memory, facts and program state.
export const DEFAULT_CONTEXT_ROTATION_TOKENS = 64_000;
// Hysteresis: a fresh session whose first turns already pass the threshold (large tool results) must not thrash.
export const MIN_TURNS_BETWEEN_ROTATIONS = 3;
// The event's now header carries intent, the unresolved failure and the last effect; older calls repeat it.
const CARRY_OVER_TOOL_CALLS = 6;
const CARRY_OVER_CONVERSATION = 6;
const TERMINAL_RESULT_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/**
 * One-line tool digests for a fresh or resumed context. A running action's ID can be cancelled, and the
 * newest finished action's ID can still be replaced, so both keep it; older finished IDs are dropped.
 */
export class ToolDigests {
	#entries = [];
	#limit;
	// The newest usable handles survive the window: reads after an action must not hide its ID.
	#handles = { terminal: null, running: new Map() };
	constructor(limit = CARRY_OVER_TOOL_CALLS) { this.#limit = limit; }
	get length() { return this.#entries.length; }

	/** Records one call; returns its rendered line as it reads now. */
	push(name, argsText, result) {
		this.noteDelivered(result);
		const decision = result?.decision ?? result?.status?.decision;
		const ids = [['programId', result?.programId], ['decisionId', result?.decisionId ?? decision?.decisionId], ['queueId', result?.queueId]]
			.filter(([, value]) => typeof value === 'string').map(([key, value]) => `${key}=${JSON.stringify(truncate(value, 96))}`);
		const outcome = typeof result?.outcome === 'string' ? result.outcome : [result?.state, result?.reasonCode].filter((value) => typeof value === 'string').join(' ');
		const entry = { head: `${name} ${argsText} -> ${outcome || 'returned'}`, short: `${name} -> ${outcome || 'returned'}`, ids,
			actionId: typeof result?.actionId === 'string' && result?.state !== 'UNKNOWN_ACTION' ? `actionId=${JSON.stringify(result.actionId)}` : null, terminal: TERMINAL_RESULT_STATES.has(result?.state) };
		this.#entries.push(entry);
		if (entry.actionId !== null) {
			if (entry.terminal) {
				this.#handles.running.delete(entry.actionId);
				this.#handles.terminal = entry;
			} else this.#handles.running.set(entry.actionId, entry);
		}
		if (this.#entries.length > this.#limit) this.#entries.splice(0, this.#entries.length - this.#limit);
		return this.#render(entry, true);
	}

	/** Reconcile only authoritative receipts that have reached a model input/tool reply. */
	noteDelivered(value) {
		if (value === null || typeof value !== 'object') return;
		// Receipts are JSON data. Do not invoke metadata accessors while recording a call.
		for (const key of ['lastResult', 'observation', 'postAction', 'replacedAction', 'current', 'action', 'result', 'program', '_actionReceipt']) this.noteDelivered(Object.getOwnPropertyDescriptor(value, key)?.value);
		for (const receipt of Array.isArray(value.receipts) ? value.receipts : []) this.noteDelivered(receipt);
		if (typeof value.actionId !== 'string' || !TERMINAL_RESULT_STATES.has(value.state) && value.state !== 'UNKNOWN_ACTION') return;
		const actionId = `actionId=${JSON.stringify(value.actionId)}`;
		this.#handles.running.delete(actionId);
		// Old starts must no longer render as current RUNNING handles, even inside the recent window.
		for (const entry of this.#entries) if (entry.actionId === actionId) entry.actionId = null;
		if (value.state === 'UNKNOWN_ACTION') {
			if (this.#handles.terminal?.actionId === actionId) this.#handles.terminal = null;
			return;
		}
		const outcome = [value.state, value.reasonCode].filter(Boolean).join(' ');
		this.#handles.terminal = { head: `actionResult -> ${outcome}`, short: `actionResult -> ${outcome}`, ids: [], actionId, terminal: true };
	}

	invalidateHandles() {
		for (const entry of this.#entries) entry.actionId = null;
		this.#handles = { terminal: null, running: new Map() };
	}

	/** `everyAction` keeps every action ID (a turn resuming within the same context). */
	lines({ everyAction = false } = {}) {
		const newestTerminal = this.#entries.findLastIndex((entry) => entry.terminal && entry.actionId !== null);
		// Handles pushed out of the window come first (they are older), compact: no arguments.
		const evicted = [...this.#handles.running.values(), this.#handles.terminal].filter((entry) => entry !== null && !this.#entries.includes(entry))
			.map((entry) => `${entry.short} (${entry.actionId})`);
		return [...evicted, ...this.#entries.map((entry, index) => this.#render(entry, everyAction || !entry.terminal || index === newestTerminal))];
	}

	#render(entry, withAction) {
		const ids = [...(withAction && entry.actionId !== null ? [entry.actionId] : []), ...entry.ids];
		return `${entry.head}${ids.length === 0 ? '' : ` (${ids.join(', ')})`}`;
	}
}

/** Remembers the little a fresh provider session needs to continue: recent tool calls, delivered chat, last program. */
export class ContextCarryOver {
	#tools = new ToolDigests();
	#conversation = [];
	#program = null;
	#lastNote = null;

	rememberTool(tool, result, error = null) {
		if (tool === null || typeof tool !== 'object') return;
		const { kind, ...rest } = tool;
		const isAction = (kind === 'action' || kind === 'start_action') && typeof tool.actionType === 'string';
		const name = isAction ? `${kind}:${tool.actionType}` : String(kind);
		const args = isAction ? tool.arguments : rest;
		// A successor that failed after its predecessor was closed still delivers the predecessor's receipt.
		if (error !== null) this.#tools.noteDelivered(error?.replacedAction);
		const digestResult = error !== null ? { outcome: `error ${typeof error?.code === 'string' ? error.code : 'TOOL_FAILED'}` } : result;
		this.#tools.push(name, truncate(safeJson(args), 160), digestResult);
		if (typeof result?.programId === 'string') this.#noteProgram(result);
	}

	/** Delivered conversation and program state from a native event ("instruction\njson"). */
	noteEvent(text) {
		if (typeof text !== 'string') return;
		const separator = text.indexOf('\n');
		if (separator < 0) return;
		const lineEnd = text.indexOf('\n', separator + 1);
		let value;
		try { value = JSON.parse(text.slice(separator + 1, lineEnd < 0 ? text.length : lineEnd)); } catch { return; }
		// Merged wake envelopes were delivered too; reconcile them oldest first so the current envelope wins.
		for (const merged of Array.isArray(value?.mergedEvents) ? value.mergedEvents : []) this.#tools.noteDelivered(merged);
		this.#tools.noteDelivered(value);
		for (const entry of Array.isArray(value?.conversation?.entries) ? value.conversation.entries : []) {
			const speaker = typeof entry?.sourceName === 'string' ? entry.sourceName : typeof entry?.sourceId === 'string' ? entry.sourceId : entry?.kind ?? 'message';
			if (typeof entry?.text !== 'string') continue;
			// Quoted, so a player's newlines cannot forge extra carry-over lines.
			this.#conversation.push(`${JSON.stringify(truncate(String(speaker), 48))}: ${JSON.stringify(truncate(entry.text, 200))}`);
		}
		if (this.#conversation.length > CARRY_OVER_CONVERSATION) this.#conversation.splice(0, this.#conversation.length - CARRY_OVER_CONVERSATION);
		if (value?.program !== null && typeof value?.program === 'object') this.#noteProgram(value.program);
	}

	/** The model's own latest note: what it wrote down is what it chose to keep from earlier observations. */
	noteAgentMessage(text) {
		if (typeof text === 'string' && text.trim().length > 0) this.#lastNote = truncate(text.trim(), 400);
	}

	text(reason) {
		const heading = reason === 'Mid-turn continuation'
			? 'Mid-turn continuation: resume with the current event and the completed tool result below. Do not repeat completed tool calls.'
			: `${reason}: earlier turns are not shown. The current event restates goal, intent (now), task memory and facts. Continue from those facts; read more only for a missing fact that changes your action.`;
		return [
			heading,
			...(this.#tools.length === 0 ? [] : ['Your most recent tool calls (oldest first):', ...this.#tools.lines().map((entry) => `- ${entry}`)]),
			...(this.#conversation.length === 0 ? [] : ['Recent conversation already delivered to you (oldest first):', ...this.#conversation.map((entry) => `- ${entry}`)]),
			...(this.#program === null ? [] : [`Historical program (current event takes precedence): ${JSON.stringify(this.#program)}`]),
			...(this.#lastNote === null ? [] : [`Your last note: ${JSON.stringify(this.#lastNote)}`]),
		].join('\n');
	}

	#noteProgram(value) {
		if (typeof value.programId !== 'string') return;
		const decision = value.decision ?? value.status?.decision;
		this.#program = {
			programId: value.programId,
			...(typeof value.state === 'string' ? { state: value.state } : {}),
			...(typeof value.engineState === 'string' ? { engineState: value.engineState } : {}),
			...(typeof decision?.decisionId === 'string' ? { pendingDecisionId: decision.decisionId, trigger: decision.trigger } : {}),
		};
	}
}

function safeJson(value) { try { return JSON.stringify(value ?? {}); } catch { return '{}'; } }
function truncate(text, max) { return text.length <= max ? text : `${text.slice(0, max - 3)}...`; }
