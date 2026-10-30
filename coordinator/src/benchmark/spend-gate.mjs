import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { TOKEN_PRICES_PER_MILLION, estimateTokenCostUsd } from '../call-cost.mjs';

/** Observer-mode preparation estimate only; the Codex translator has no enforced spend limit. Strict owners refuse it. */
export const PREPARATION_ALLOWANCE_USD = 0.25;
/** Observer-mode token estimates, not enforced Codex limits. The historical BOUND name does not imply a provider bound. */
export const CODEX_JUDGE_INPUT_OVERHEAD_TOKENS = 40000;
export const CODEX_JUDGE_OUTPUT_BOUND_TOKENS = 32000;
export const MIN_CLAMPED_OUTPUT_TOKENS = 4096;

const finite = value => Number.isFinite(value) && value >= 0;

/**
 * Largest possible charge of one call: every input token billed at the dearest input rate (a full cache write)
 * plus every allowed output token. One token is at least one UTF-8 byte, so request bytes bound input tokens.
 */
export function worstCallUsd({ inputTokens, outputTokens, profile }) {
	const prices = TOKEN_PRICES_PER_MILLION[`${profile?.provider}:${profile?.model}`];
	if (!prices || !finite(inputTokens) || !finite(outputTokens)) return null;
	const multiplier = profile.provider === 'codex' && ['fast', 'priority'].includes(profile.serviceTier) ? prices.tierMultiplier : 1;
	return (inputTokens * Math.max(prices.input, prices.cacheRead, prices.cacheWrite) + outputTokens * prices.output) * multiplier / 1_000_000;
}

/**
 * One run's budget authority. A call is admitted only if its worst case fits beside everything already committed
 * and every admitted call still in flight; it then settles to its metered charge, or keeps its worst case when the
 * charge is unknown. Closing the gate refuses every later call.
 */
export class SpendGate {
	#entries = new Map(); #onDeny;
	constructor({ budgetUsd, onDeny = null }) {
		if (!finite(budgetUsd) || budgetUsd <= 0) throw new TypeError('Gate budget must be a positive finite amount');
		this.budgetUsd = budgetUsd; this.#onDeny = onDeny;
		Object.assign(this, { closed: false, closeReason: null, denied: [], overruns: [] });
	}
	get committedUsd() { return [...this.#entries.values()].filter(e => e.state === 'settled').reduce((s, e) => s + e.usd, 0); }
	get pendingUsd() { return [...this.#entries.values()].filter(e => e.state === 'pending').reduce((s, e) => s + e.worstUsd, 0); }
	available() { return Math.max(0, this.budgetUsd - this.committedUsd - this.pendingUsd); }
	admit(id, worstUsd, label = null) {
		const fits = !this.closed && finite(worstUsd) && worstUsd <= this.available() + 1e-12;
		if (!fits) {
			const denial = { id, label, worstUsd: finite(worstUsd) ? worstUsd : null, availableUsd: this.available(), closed: this.closed, at: Date.now() };
			this.denied.push(denial); this.#onDeny?.(denial);
			return false;
		}
		this.#entries.set(id, { id, label, state: 'pending', worstUsd, at: Date.now() });
		return true;
	}
	/** Replace a pending worst case by the metered charge; null keeps the worst case as the charge. */
	settle(id, actualUsd, detail = null) {
		const entry = this.#entries.get(id);
		if (!entry || entry.state !== 'pending') throw new Error(`Gate entry ${id} is not pending`);
		const usd = finite(actualUsd) ? actualUsd : entry.worstUsd;
		if (usd > entry.worstUsd + 1e-9) this.overruns.push({ id, label: entry.label, worstUsd: entry.worstUsd, actualUsd: usd });
		this.#entries.set(id, { ...entry, state: 'settled', usd, metered: finite(actualUsd) && detail?.metered !== false, detail });
		return usd;
	}
	close(reason) { if (!this.closed) Object.assign(this, { closed: true, closeReason: reason, closedAt: Date.now() }); }
	totals() {
		const entries = [...this.#entries.values()];
		const committedUsd = this.committedUsd, pendingUsd = this.pendingUsd;
		return { budgetUsd: this.budgetUsd, committedUsd, pendingUsd, chargeUsd: committedUsd + pendingUsd, availableUsd: this.available(),
			admitted: entries.length, unmeteredSettlements: entries.filter(e => e.state === 'settled' && !e.metered).length, denied: this.denied.length,
			overruns: this.overruns, closed: this.closed, closeReason: this.closeReason,
			byLabel: Object.fromEntries([...new Set(entries.map(e => e.label ?? 'other'))].map(label => [label, entries.filter(e => (e.label ?? 'other') === label).reduce((s, e) => s + (e.state === 'settled' ? e.usd : e.worstUsd), 0)])) };
	}
}

const usageTokens = usage => usage && { input: usage.input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, output: usage.output_tokens ?? 0 };
const tokenCount = value => Number.isSafeInteger(value) && value >= 0;
const validUsage = usage => usage && tokenCount(usage.input_tokens) && tokenCount(usage.output_tokens)
	&& ['cache_read_input_tokens', 'cache_creation_input_tokens'].every(key => usage[key] === undefined || tokenCount(usage[key]))
	&& (usage.cache_creation === undefined || (object(usage.cache_creation)
		&& tokenCount(usage.cache_creation.ephemeral_5m_input_tokens) && tokenCount(usage.cache_creation.ephemeral_1h_input_tokens)
		&& usage.cache_creation.ephemeral_5m_input_tokens + usage.cache_creation.ephemeral_1h_input_tokens === (usage.cache_creation_input_tokens ?? 0)));
const exactUsage = usage => Boolean(validUsage(usage) && ((usage.cache_creation_input_tokens ?? 0) === 0 || usage.cache_creation !== undefined));

// Published list prices, independent of call-cost.mjs's historical comparison weights.
// https://platform.claude.com/docs/en/about-claude/pricing (2026-10-13). Admission uses the dearer 1h rate; settlement retains each reported duration.
const STRICT_PRICES = Object.freeze({
	'claude-opus-5-5': { input: 4, output: 20, cacheRead: .2, cacheWrite: 8, cacheWrite5m: 5 },
	'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: .1, cacheWrite: 4, cacheWrite5m: 2.5 },
});
const strictCost = (tokens, profile, usage = null) => {
	const price = profile?.provider === 'claude' && STRICT_PRICES[profile.model];
	if (!price) return null;
	const cacheUsd = usage?.cache_creation
		? usage.cache_creation.ephemeral_5m_input_tokens * price.cacheWrite5m + usage.cache_creation.ephemeral_1h_input_tokens * price.cacheWrite
		: tokens.cacheWrite * price.cacheWrite;
	return (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead + cacheUsd) / 1e6;
};
const strictWorst = ({ inputTokens, outputTokens, profile }) => finite(inputTokens) && finite(outputTokens)
	? strictCost({ input: 0, cacheRead: 0, cacheWrite: inputTokens, output: outputTokens }, profile) : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const cacheControl = value => value === undefined || (keysOnly(value, ['type', 'ttl']) && value.type === 'ephemeral' && [undefined, '5m', '1h'].includes(value.ttl));
function boundedContent(value, nested = false) {
	if (typeof value === 'string') return true;
	return Array.isArray(value) && value.every(block => {
		if (!object(block) || !cacheControl(block.cache_control)) return false;
		if (block.type === 'text') return keysOnly(block, ['type', 'text', 'cache_control']) && typeof block.text === 'string';
		if (nested) return false;
		if (block.type === 'thinking') return keysOnly(block, ['type', 'thinking', 'signature']) && typeof block.thinking === 'string' && typeof block.signature === 'string';
		if (block.type === 'tool_use') return keysOnly(block, ['type', 'id', 'name', 'input', 'cache_control']) && typeof block.id === 'string' && typeof block.name === 'string' && object(block.input);
		if (block.type === 'tool_result') return keysOnly(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control']) && typeof block.tool_use_id === 'string' && boundedContent(block.content, true);
		return false;
	});
}
function boundedTextRequest(request) {
	if (!keysOnly(request, ['model', 'max_tokens', 'messages', 'system', 'stream', 'tools', 'tool_choice', 'thinking', 'output_config', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata', 'service_tier', 'cache_control', 'context_management'])) return false;
	if (!STRICT_PRICES[request.model] || ![undefined, 'auto', 'standard_only'].includes(request.service_tier) || !cacheControl(request.cache_control)) return false;
	// Claude Code's keep-all edit preserves existing text; server compaction remains forbidden.
	if (request.context_management !== undefined && !(keysOnly(request.context_management, ['edits']) && Array.isArray(request.context_management.edits) && request.context_management.edits.every(edit => keysOnly(edit, ['type', 'keep']) && edit.type === 'clear_thinking_20251015' && edit.keep === 'all'))) return false;
	if (request.system !== undefined && !boundedContent(request.system, true)) return false;
	if (!Array.isArray(request.messages) || !request.messages.every(message => keysOnly(message, ['role', 'content']) && ['user', 'assistant'].includes(message.role) && boundedContent(message.content))) return false;
	if (request.tools !== undefined && (!Array.isArray(request.tools) || !request.tools.every(tool => keysOnly(tool, ['type', 'name', 'description', 'input_schema', 'cache_control', 'defer_loading', 'strict']) && [undefined, 'custom'].includes(tool.type) && typeof tool.name === 'string' && object(tool.input_schema) && cacheControl(tool.cache_control)))) return false;
	if (request.tool_choice !== undefined && !(keysOnly(request.tool_choice, ['type', 'disable_parallel_tool_use']) && ['auto', 'none'].includes(request.tool_choice.type))) return false;
	if (request.thinking !== undefined && !(keysOnly(request.thinking, ['type', 'budget_tokens', 'display']) && ['enabled', 'disabled', 'adaptive'].includes(request.thinking.type) && [undefined, 'summarized'].includes(request.thinking.display))) return false;
	if (request.output_config !== undefined && !(keysOnly(request.output_config, ['effort']) && ['low', 'medium', 'high', 'max'].includes(request.output_config.effort))) return false;
	return true;
}

/** Cumulative deltas are provisional until a terminal delta and the message_stop event both arrive. */
export function anthropicResponseUsage(text, streamed) {
	if (!streamed) { try {
		const response = JSON.parse(text), usage = response.usage;
		const tokens = validUsage(usage) ? usageTokens(usage) : null;
		return { started: Boolean(usage), opening: tokens, final: tokens, usage: usage ?? null,
			responseId: typeof response.id === 'string' ? response.id : null, exactUsage: exactUsage(usage) };
	} catch { return { started: false, opening: null, final: null, usage: null, responseId: null, exactUsage: false }; } }
	let started = false, final = null, merged = null, opening = null, terminal = false, invalid = false, responseId = null;
	// An unterminated SSE block has not been dispatched by the provider and cannot establish final accounting.
	for (const block of text.split(/\r?\n\r?\n/).slice(0, -1)) {
		const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n');
		if (!data) continue;
		let event; try { event = JSON.parse(data); } catch { invalid = true; continue; }
		if (event.type === 'error') invalid = true;
		if (event.type === 'message_start') {
			if (started) invalid = true;
			started = true; merged = { ...event.message?.usage };
			responseId = typeof event.message?.id === 'string' ? event.message.id : null;
			opening = validUsage(merged) ? usageTokens(merged) : null;
		}
		if (event.type === 'message_delta') {
			const usage = event.usage;
			if (!started || !tokenCount(usage?.output_tokens) || usage.output_tokens < (merged?.output_tokens ?? 0)) invalid = true;
			merged = { ...merged, ...usage };
			terminal = typeof event.delta?.stop_reason === 'string' && event.delta.stop_reason.length > 0;
		}
		if (event.type === 'message_stop' && terminal && !invalid && validUsage(merged)) final = usageTokens(merged);
	}
	return { started, opening, final: invalid ? null : final, usage: merged, responseId, exactUsage: !invalid && Boolean(final) && exactUsage(merged) };
}

/**
 * Local Anthropic gateway for Claude Code (ANTHROPIC_BASE_URL). Every Messages request reserves its worst case in
 * the gate before it is forwarded. When the full worst case does not fit, max_tokens is lowered to what does fit,
 * or the request is refused. Strict mode refuses every other route and input that could expand into billed
 * server work or nontext tokens. Legacy observer mode retains passthrough for compatibility.
 */
export async function startAnthropicGateway({ gate: initialGate, profileFor, upstream = 'https://api.anthropic.com', fetchImpl = fetch, host = '127.0.0.1', port = 0, log = null, onOutbound = null, strict = false }) {
	const calls = [];
	const bound = strict ? strictWorst : worstCallUsd;
	const cost = strict ? strictCost : estimateTokenCostUsd;
	// handle.gate can be replaced between phases (play, then judging) while the gateway keeps its address.
	const handle = { gate: initialGate, calls, url: null, close: null, strict };
	const server = http.createServer(async (req, res) => {
		const gate = handle.gate;
		const chunks = []; for await (const chunk of req) chunks.push(chunk);
		let body = Buffer.concat(chunks);
		const billed = req.method === 'POST' && /^\/v1\/messages(?:\?|$)/.test(req.url);
		const id = randomUUID(), call = { id, url: req.url, at: Date.now(), billed };
		const deny = (status, message) => { call.denied = message; calls.push(call); log?.(call); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } })); };
		if (strict && !billed) return deny(400, 'Evaluator spend gate: strict mode supports only POST /v1/messages');
		let profile = null, worstUsd = 0, streamed = false;
		if (billed) {
			let request; try { request = JSON.parse(body.toString('utf8')); } catch { return deny(400, 'Evaluator spend gate: unreadable Messages request'); }
			if (strict && !boundedTextRequest(request)) return deny(400, 'Evaluator spend gate: strict mode requires text Messages and custom client tools only');
			profile = profileFor(request.model);
			if (strict && (profile?.provider !== 'claude' || profile.model !== request.model)) return deny(400, 'Evaluator spend gate: strict pricing profile must match the requested Claude model');
			const inputOverhead = 64 + (strict && request.tools?.length ? 286 : 0);
			const inputTokens = body.length + inputOverhead, requested = request.max_tokens;
			const full = bound({ inputTokens, outputTokens: requested, profile });
			if (full === null || !Number.isSafeInteger(requested) || requested < 1) return deny(400, `Evaluator spend gate: cannot bound the cost of model ${request.model}`);
			let outputTokens = requested;
			if (full > gate.available()) {
				const perOutput = bound({ inputTokens: 0, outputTokens: 1, profile }), inputUsd = bound({ inputTokens, outputTokens: 0, profile });
				const fitting = Math.floor((gate.available() - inputUsd) / perOutput);
				const minimum = Math.max(MIN_CLAMPED_OUTPUT_TOKENS, (request.thinking?.budget_tokens ?? 0) + 1024);
				if (fitting >= minimum) { outputTokens = fitting; request.max_tokens = fitting; body = Buffer.from(JSON.stringify(request)); call.clampedFrom = requested; }
			}
			worstUsd = bound({ inputTokens: body.length + inputOverhead, outputTokens, profile });
			Object.assign(call, { model: request.model, requestBytes: body.length, maxTokens: outputTokens, worstUsd });
			if (!gate.admit(id, worstUsd, 'model call')) return deny(400, `Evaluator spend cap: this request could cost up to $${worstUsd.toFixed(4)} and $${gate.available().toFixed(4)} remains`);
			streamed = request.stream === true;
		}
		const headers = { ...req.headers, 'accept-encoding': 'identity' };
		for (const name of ['host', 'content-length', 'connection']) delete headers[name];
		if (strict) {
			// Forward authentication, not arbitrary pricing/beta modifiers. OAuth is needed by Claude Code's
			// subscription transport; these protocol betas do not enable extra billed provider tools.
			for (const name of Object.keys(headers)) if (!['authorization', 'x-api-key', 'anthropic-version', 'content-type', 'accept', 'accept-encoding', 'user-agent', 'anthropic-beta'].includes(name)) delete headers[name];
			if (headers['anthropic-beta']) headers['anthropic-beta'] = headers['anthropic-beta'].split(',').map(value => value.trim()).filter(value => ['oauth-2025-04-20', 'claude-code-20250219', 'interleaved-thinking-2025-05-14', 'context-management-2025-06-27'].includes(value)).join(',');
			if (!headers['anthropic-beta']) delete headers['anthropic-beta'];
		}
		const abort = new AbortController();
		res.on('close', () => { if (!res.writableFinished) abort.abort(); });
		let status = null, text = '';
		try {
			call.requestSha256 = createHash('sha256').update(body).digest('hex');
			await onOutbound?.({ ...call, pendingUsd: gate.pendingUsd, committedUsd: gate.committedUsd, chargeUsd: gate.pendingUsd + gate.committedUsd });
			const response = await fetchImpl(upstream + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, signal: abort.signal });
			status = response.status;
			const out = {}; response.headers.forEach((value, name) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) out[name] = value; });
			res.writeHead(status, out);
			if (response.body) for await (const chunk of response.body) { res.write(chunk); if (billed) text += Buffer.from(chunk).toString('utf8'); }
			res.end();
		} catch (error) { call.error = error.message; if (!res.headersSent) res.writeHead(502); res.end(); }
		finally {
			if (billed) {
				const { started, opening, final, usage, responseId, exactUsage: exact } = anthropicResponseUsage(text, streamed);
				// An answer that never started was not billed. A started answer cut off before its final usage is charged its
				// reported input plus every output token it was allowed; without even the opening usage it keeps its worst case.
				const actual = final ? cost(final, profile, usage)
					: opening ? Math.min(worstUsd, cost({ ...opening, output: call.maxTokens }, profile))
					: !started && status !== null && status !== 200 ? 0 : null;
				const metered = Boolean(final) || actual === 0;
				Object.assign(call, { status, tokens: final, usage, responseId, exactUsage: exact, usd: gate.settle(id, actual, { status, metered }), metered });
				calls.push(call); log?.(call);
			}
		}
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
	const address = server.address();
	handle.url = `http://${host}:${address.port}`;
	handle.close = () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
	return handle;
}

/** Historical name: this is only an observer-mode judge estimate, never a worst-case bound or strict admission authority. */
export function codexJudgeWorstUsd(prompt, profile) {
	return worstCallUsd({ inputTokens: Buffer.byteLength(prompt) + CODEX_JUDGE_INPUT_OVERHEAD_TOKENS, outputTokens: CODEX_JUDGE_OUTPUT_BOUND_TOKENS, profile });
}
