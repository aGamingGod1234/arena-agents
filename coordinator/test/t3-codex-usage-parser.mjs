// T3 Code's Codex usage parser, copied from T3 Code (Nightly) resources/app.asar
// (src/provider/Drivers/codexUsage.ts: readCodexTokenUsage, advanceCodexUsage, parseCodexLine, parseCodexRecord,
// codexSpeed; src/usage totalTokens, parseTimestampMs). The Effect Schema check on CodexTokenUsage is written out
// as the same integer and filter conditions. Used to prove that the usage mirror's files are accepted.

const CODEX_USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const FORK_COPY_MAX_GAP_MS = 1e3;

function isCodexTokenUsage(usage) {
	if (!CODEX_USAGE_FIELDS.every((key) => Number.isInteger(usage[key]) && usage[key] >= 0)) return false;
	return usage.cached_input_tokens + usage.cache_write_input_tokens <= usage.input_tokens && usage.reasoning_output_tokens <= usage.output_tokens && usage.total_tokens >= usage.input_tokens + usage.output_tokens;
}

function totalTokens(totals) {
	return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + totals.outputTokens;
}

function parseTimestampMs(value) {
	if (typeof value !== 'string') return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function readCodexTokenUsage(value) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const raw = value;
	const input = raw['input_tokens'];
	const output = raw['output_tokens'];
	if (typeof input !== 'number' || typeof output !== 'number') return null;
	const usage = {
		input_tokens: input,
		cached_input_tokens: raw['cached_input_tokens'] === void 0 ? 0 : raw['cached_input_tokens'],
		cache_write_input_tokens: raw['cache_write_input_tokens'] === void 0 ? 0 : raw['cache_write_input_tokens'],
		output_tokens: output,
		reasoning_output_tokens: raw['reasoning_output_tokens'] === void 0 ? 0 : raw['reasoning_output_tokens'],
		total_tokens: raw['total_tokens'] === void 0 ? input + output : raw['total_tokens'],
	};
	return isCodexTokenUsage(usage) ? usage : null;
}

function advanceCodexUsage(previous, last) {
	return readCodexTokenUsage(Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, (previous?.[key] ?? 0) + last[key]])));
}

export function initialCodexScanState() {
	return {
		model: '', speed: 'standard', sessionId: '', lastUsageSignature: null, lastCumulativeUsage: null, malformedRecords: 0,
		sawSessionMeta: false, modelProvider: '', turnId: '', sawThreadSettings: false, suppressingForkCopies: false, forkCopyAnchorMs: 0,
	};
}

function isForkedSessionMeta(payload) {
	if (typeof payload['forked_from_id'] === 'string') return true;
	const source = payload['source'];
	if (typeof source !== 'object' || source === null) return false;
	const subagent = source['subagent'];
	if (typeof subagent !== 'object' || subagent === null) return false;
	const spawn = subagent['thread_spawn'];
	if (typeof spawn !== 'object' || spawn === null) return false;
	return typeof spawn['parent_thread_id'] === 'string';
}

export function parseCodexLine(line, state) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	return parseCodexRecord(parsed, state);
}

export function parseCodexRecord(parsed, state) {
	if (typeof parsed !== 'object' || parsed === null) return null;
	const record = parsed;
	const payload = record['payload'];
	if (typeof payload !== 'object' || payload === null) return null;
	const payloadRecord = payload;
	const payloadType = payloadRecord['type'];
	if (record['type'] === 'session_meta') {
		if (state.sawSessionMeta) return null;
		state.sawSessionMeta = true;
		const id = payloadRecord['id'] ?? payloadRecord['session_id'];
		if (typeof id === 'string') state.sessionId = id;
		if (typeof payloadRecord['model_provider'] === 'string') state.modelProvider = payloadRecord['model_provider'];
		const metaTimestampMs = parseTimestampMs(record['timestamp']);
		if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
			state.suppressingForkCopies = true;
			state.forkCopyAnchorMs = metaTimestampMs;
		}
		return null;
	}
	if (record['type'] === 'turn_context') {
		if (typeof payloadRecord['model'] === 'string') state.model = payloadRecord['model'];
		state.turnId = typeof payloadRecord['turn_id'] === 'string' && typeof payloadRecord['model'] === 'string' && payloadRecord['model'].length > 0 ? payloadRecord['turn_id'] : '';
		return null;
	}
	if (payloadType === 'thread_settings_applied') {
		state.sawThreadSettings = true;
		const settings = payloadRecord['thread_settings'];
		if (typeof settings === 'object' && settings !== null) state.speed = codexSpeed(settings['service_tier']);
		return null;
	}
	if (payloadType !== 'token_count') return null;
	const info = payloadRecord['info'];
	if (typeof info !== 'object' || info === null) return null;
	const infoRecord = info;
	const timestampMs = parseTimestampMs(record['timestamp']);
	if (timestampMs === null || state.model.length === 0) return null;
	const last = readCodexTokenUsage(infoRecord['last_token_usage']);
	const rawCumulative = infoRecord['total_token_usage'];
	const hasCumulative = rawCumulative !== void 0 && rawCumulative !== null;
	const cumulative = hasCumulative ? readCodexTokenUsage(rawCumulative) : null;
	if (state.suppressingForkCopies) {
		if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
			state.forkCopyAnchorMs = timestampMs;
			const signature = last === null ? null : JSON.stringify(last);
			if (cumulative !== null) state.lastCumulativeUsage = cumulative;
			else if (!hasCumulative && last !== null && signature !== state.lastUsageSignature) state.lastCumulativeUsage = advanceCodexUsage(state.lastCumulativeUsage, last);
			state.lastUsageSignature = signature;
			return null;
		}
		state.suppressingForkCopies = false;
		state.lastUsageSignature = null;
	}
	const previous = state.lastCumulativeUsage;
	if (cumulative !== null) state.lastCumulativeUsage = cumulative;
	if (last === null || hasCumulative && cumulative === null) {
		state.malformedRecords += 1;
		return null;
	}
	if (last.input_tokens + last.output_tokens === 0) {
		state.lastUsageSignature = null;
		return null;
	}
	if (cumulative !== null && previous !== null && CODEX_USAGE_FIELDS.every((key) => cumulative[key] === previous[key])) return null;
	if (last.total_tokens !== last.input_tokens + last.output_tokens) {
		state.malformedRecords += 1;
		return null;
	}
	const signature = JSON.stringify(last);
	if (cumulative !== null) {
		const restarted = CODEX_USAGE_FIELDS.every((key) => cumulative[key] === last[key]);
		const reconciled = previous === null ? readCodexTokenUsage(Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, cumulative[key] - last[key]]))) !== null : CODEX_USAGE_FIELDS.every((key) => cumulative[key] - previous[key] === last[key]);
		if (!restarted && !reconciled) {
			state.malformedRecords += 1;
			return null;
		}
	} else {
		if (signature === state.lastUsageSignature) return null;
		const advanced = advanceCodexUsage(previous, last);
		if (advanced === null) {
			state.malformedRecords += 1;
			return null;
		}
		state.lastCumulativeUsage = advanced;
	}
	state.lastUsageSignature = signature;
	const inputTokens = last.input_tokens;
	const cachedInputTokens = last.cached_input_tokens;
	const cacheCreationTokens = last.cache_write_input_tokens;
	const outputTokens = last.output_tokens;
	const totals = {
		uncachedInputTokens: inputTokens - cachedInputTokens - cacheCreationTokens,
		cachedInputTokens,
		cacheCreationTokens,
		outputTokens,
		reasoningTokens: last.reasoning_output_tokens,
	};
	if (totalTokens(totals) === 0) return null;
	return {
		provider: 'codex',
		timestampMs,
		model: state.model,
		sessionId: state.sessionId,
		totals,
		reportedCostUsd: null,
		speed: state.speed,
		...!state.sawThreadSettings && state.modelProvider === 'openai' && state.sessionId.length > 0 && state.turnId.length > 0 ? { unresolvedServiceTierTurnId: state.turnId } : {},
		dedupeKey: null,
	};
}

function codexSpeed(serviceTier) {
	if (serviceTier === 'priority' || serviceTier === 'fast') return 'fast';
	if (serviceTier === 'ultrafast') return 'ultrafast';
	return 'standard';
}

// Reads one rollout file the way T3's transcript reader does: one scan state per file, one record per accepted line.
export function parseCodexRollout(text) {
	const state = initialCodexScanState();
	const records = [];
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		const record = parseCodexLine(line, state);
		if (record !== null) records.push(record);
	}
	const sum = (key) => records.reduce((total, record) => total + record.totals[key], 0);
	return {
		records, malformed: state.malformedRecords,
		totals: { uncachedInput: sum('uncachedInputTokens'), cachedInput: sum('cachedInputTokens'), output: sum('outputTokens'), reasoning: sum('reasoningTokens') },
	};
}
