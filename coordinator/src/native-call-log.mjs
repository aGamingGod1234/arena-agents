// Per-model-call capture for native-tool turns. Created only when provider-turn
// recording is enabled; services hold `null` otherwise, so the disabled path
// costs one null check per event. Text is cut here with a marker so a long turn
// cannot grow without bound; ProviderTurnRecorder applies the final row bound.

const MAX_FIELD_CHARS = 32_768;
const MAX_TOTAL_CHARS = 2_000_000;
const MAX_CALLS = 1_000;
const MAX_INPUTS_PER_CALL = 64;
const MAX_TOOL_CALLS_PER_CALL = 64;
const MAX_ITEMS = 256;

function clip(value, limit = MAX_FIELD_CHARS) {
	const text = typeof value === 'string' ? value : value === undefined ? '' : safeJson(value);
	return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function safeJson(value) {
	try { return JSON.stringify(value) ?? ''; } catch { return '[unserializable]'; }
}

export class NativeCallLog {
	#now;
	#calls = [];
	#pendingInputs = [];
	#current = null;
	#currentKey = null;
	#chars = 0;
	#omittedCalls = 0;
	#firstInput = null;
	#nextIndex = 0;
	// Usage can be reported before the assistant message that opens its call.
	#lateUsage = new Map();
	#textDeltas = new Map();
	#finalItems = [];

	constructor({ now = Date.now } = {}) { this.#now = now; }

	beginCall(key) { this.#open(key); }

	#take(value) {
		const text = clip(value);
		if (this.#chars >= MAX_TOTAL_CHARS) return text.length === 0 ? '' : '[capture budget exhausted]';
		this.#chars += text.length;
		return text;
	}

	/** Anything sent to the model: the turn input, a steer, a handoff message or a tool result. */
	input(kind, text, extra = {}) {
		if (this.#current !== null) this.#closeCurrent();
		this.#firstInput ??= clip(text);
		if (this.#pendingInputs.length < MAX_INPUTS_PER_CALL) {
			this.#pendingInputs.push({ kind, at: this.#now(), ...extra, text: this.#take(text) });
		}
	}

	/** Completed text replaces any streamed fallback for the same item. */
	output(text, key = null, itemId = null) { this.#completeText('output', text, itemId, key); }

	reasoning(text, itemId = null, key = null) { this.#completeText('reasoning', text, itemId, key); }

	#completeText(kind, text, itemId, key) {
		let id = itemId === null ? null : `${kind}:${itemId}`;
		let pending = this.#textDeltas.get(id);
		// Claude can emit one assistant block at a time under the same message ID;
		// its content array then starts at zero again while stream indices do not.
		if (pending === undefined && key !== null) {
			const match = [...this.#textDeltas].find(([, entry]) => entry.kind === kind && entry.call.key === key);
			if (match !== undefined) [id, pending] = match;
		}
		// Some completed reasoning items omit the summary that was streamed.
		if (kind === 'reasoning' && !text && pending !== undefined) return;
		this.#textDeltas.delete(id);
		const call = pending?.call ?? this.#open(key);
		if (call === null || typeof text !== 'string' || text.length === 0) return;
		const seen = kind === 'output' ? 'seenText' : 'seenReasoning';
		const bounded = clip(text);
		if (call[seen] === bounded) return;
		call[seen] = bounded;
		call[kind] = !call[kind] ? this.#take(text) : `${call[kind]}\n${this.#take(text)}`;
		call.endedAt = this.#now();
	}

	outputDelta(itemId, delta, key = null) { this.#delta('output', itemId, delta, key); }

	reasoningDelta(itemId, delta, key = null) { this.#delta('reasoning', itemId, delta, key); }

	#delta(kind, itemId, delta, key) {
		if (typeof delta !== 'string' || delta.length === 0) return;
		const id = `${kind}:${itemId ?? 'turn'}`;
		let entry = this.#textDeltas.get(id);
		if (entry === undefined) {
			if (this.#textDeltas.size >= MAX_ITEMS) return;
			const call = this.#open(key);
			if (call === null) return;
			entry = { call, kind, text: '', truncated: false };
			this.#textDeltas.set(id, entry);
		}
		const room = Math.max(0, MAX_FIELD_CHARS - entry.text.length);
		entry.text += this.#take(delta.slice(0, room));
		entry.truncated ||= delta.length > room;
		entry.call.endedAt = this.#now();
	}

	/** Keep the provider's final item content, including empty messages and result-only replies. */
	finalItem(item, id = item?.id) {
		const safeId = id == null ? null : clip(String(id), 128);
		const content = clip(item);
		// Duplicate completion notifications must not consume the capture budget twice.
		if (this.#finalItems.some((entry) => entry.id === safeId && entry.content === content)) return;
		if (this.#finalItems.length >= MAX_ITEMS) return;
		this.#finalItems.push({ id: safeId, type: clip(item?.type ?? '', 128), content: this.#take(item) });
	}

	toolCall({ callId = null, name, arguments: args }, key = null) {
		const call = this.#open(key);
		if (call === null) return;
		call.endedAt = this.#now();
		if (callId !== null && call.toolCalls.some((entry) => entry.callId === String(callId))) return;
		if (call.toolCalls.length >= MAX_TOOL_CALLS_PER_CALL) { call.omittedToolCalls = (call.omittedToolCalls ?? 0) + 1; return; }
		call.toolCalls.push({ callId: callId === null ? null : String(callId), name: clip(String(name ?? ''), 128), arguments: this.#take(args), at: this.#now() });
	}

	/** Token usage for the call in flight (or the latest call). */
	usage(tokens, key = null) {
		const call = key !== null ? this.#calls.findLast((entry) => entry.key === key) : this.#current ?? this.#calls.at(-1);
		if (call !== undefined) { if (tokens != null) call.usage = tokens; }
		else if (tokens != null) {
			if (key === null) { const opened = this.#open(null); if (opened !== null) opened.usage = tokens; }
			else if (this.#lateUsage.size < MAX_CALLS) this.#lateUsage.set(key, tokens);
		}
	}

	toolResult(callId, text, extra = {}) {
		this.input('tool_result', text, { callId: callId === null || callId === undefined ? null : String(callId), ...extra });
	}

	get firstInput() { return this.#firstInput ?? ''; }

	get isEmpty() { return this.#calls.length === 0 && this.#pendingInputs.length === 0; }

	#open(key) {
		if (this.#current !== null && key !== null && key !== this.#currentKey) this.#closeCurrent();
		if (this.#current !== null) return this.#current;
		if (this.#calls.length >= MAX_CALLS) { this.#omittedCalls += 1; this.#pendingInputs = []; return null; }
		const startedAt = this.#now();
		this.#current = {
			index: this.#nextIndex++, key, startedAt, endedAt: startedAt,
			inputs: this.#pendingInputs, output: '', toolCalls: [], usage: this.#lateUsage.get(key) ?? null,
		};
		this.#pendingInputs = [];
		this.#lateUsage.delete(key);
		this.#currentKey = key;
		this.#calls.push(this.#current);
		return this.#current;
	}

	#closeCurrent() { this.#current = null; this.#currentKey = null; }

	snapshot() {
		const calls = this.#calls.map((source) => {
			const { key, seenText, seenReasoning, ...call } = source;
			const result = { ...(key === null ? {} : { messageId: String(key).slice(0, 128) }), ...call };
			for (const entry of this.#textDeltas.values()) {
				if (entry.call !== source) continue;
				const text = `${entry.text}${entry.truncated ? '...[truncated stream]' : ''}`;
				result[entry.kind] = [result[entry.kind], text].filter(Boolean).join('\n');
			}
			return result;
		});
		const reasoning = calls.map((call) => call.reasoning ?? '').filter(Boolean).join('\n');
		return {
			calls,
			trailingInputs: this.#pendingInputs.slice(),
			omittedCalls: this.#omittedCalls,
			input: this.firstInput,
			...(reasoning === '' ? {} : { reasoning }),
			finalItems: this.#finalItems.slice(),
			output: calls.map((call) => call.output).filter(Boolean).join('\n'),
		};
	}
}
