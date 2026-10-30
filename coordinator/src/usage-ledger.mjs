import { callCostUsd } from './call-cost.mjs';
import { parseCodexRateLimits } from './provider-discovery.mjs';
import { PROVIDER_REGISTRY } from './provider-registry.mjs';

/**
 * Provider-neutral usage statistics for every agent at once, plus one row per provider account.
 * Agent totals live for the agent's lifetime (a new goal does not reset them); per-goal values are kept beside them.
 * Account data (plan windows, credits, request limits) is held once per account, never copied into each agent.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RATE_SHORT_MS = 10 * MINUTE;
const SAMPLE_KEEP_MS = 2 * HOUR;
const MIN_RATE_SPAN_MS = 2 * MINUTE;
export const WARNING_HOURS = Object.freeze({ red: 1, yellow: 3 });
const RATE_LIMIT_RED_MS = 10 * MINUTE;
const MAX_CALL_EVENTS = 4_096;
const TOKEN_KEYS = Object.freeze(['input', 'cached', 'uncached', 'cacheWrite', 'output', 'reasoning']);

function zeroTokens() { return { input: 0, cached: 0, uncached: 0, cacheWrite: 0, output: 0, reasoning: 0 }; }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function round(value, digits = 4) { if (!Number.isFinite(value)) return null; const scale = 10 ** digits; return Math.round(value * scale) / scale; }

/** One provider usage report as token counts; input includes cached and cache-written tokens, output includes reasoning. */
function tokensOf(value) {
	if (value === null || typeof value !== 'object') return null;
	const input = count(value.inputTokens);
	const cached = Math.min(input, count(value.cachedInputTokens));
	const cacheWrite = Math.min(input - cached, count(value.cacheWriteInputTokens));
	const output = count(value.outputTokens);
	return { input, cached, cacheWrite, uncached: Math.max(0, input - cached - cacheWrite), output, reasoning: Math.min(output, count(value.reasoningOutputTokens)) };
}

function totalsOf(value) {
	const keys = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
	if (!keys.some((key) => Number.isSafeInteger(value?.[key]))) return null;
	return Object.fromEntries(keys.map((key) => [key, count(value[key])]));
}

function addTokens(target, tokens) { for (const key of TOKEN_KEYS) target[key] += tokens[key]; }

export function warningLevel(hoursToLimit) {
	if (!Number.isFinite(hoursToLimit)) return 'none';
	if (hoursToLimit < WARNING_HOURS.red) return 'red';
	if (hoursToLimit < WARNING_HOURS.yellow) return 'yellow';
	return 'none';
}

const LEVEL_RANK = Object.freeze({ none: 0, yellow: 1, red: 2 });
function worse(left, right) { return LEVEL_RANK[right] > LEVEL_RANK[left] ? right : left; }

/**
 * Rate of change per minute (over the last 10 minutes) and per hour (over the last hour) of a sampled series.
 * Returns nulls until the samples span at least two minutes.
 */
export function seriesRates(samples, now) {
	const rate = (spanMs) => {
		const inWindow = samples.filter((sample) => sample.at >= now - spanMs);
		if (inWindow.length < 2) return null;
		const first = inWindow[0];
		const last = inWindow[inWindow.length - 1];
		const elapsed = last.at - first.at;
		if (elapsed < MIN_RATE_SPAN_MS) return null;
		return (last.value - first.value) / elapsed;
	};
	const shortPerMs = rate(RATE_SHORT_MS);
	const hourPerMs = rate(HOUR);
	return { perMinute: shortPerMs === null ? null : shortPerMs * MINUTE, perHour: hourPerMs === null ? (shortPerMs === null ? null : shortPerMs * HOUR) : hourPerMs * HOUR };
}

/** Hours until `remaining` is used up at `perHour`; null when nothing is being used. */
export function hoursUntil(remaining, perHour) {
	if (!Number.isFinite(remaining) || !Number.isFinite(perHour)) return null;
	if (remaining <= 0) return 0;
	if (perHour <= 0) return null;
	return remaining / perHour;
}

export class UsageLedger {
	#now;
	#onWarning;
	#agents = new Map();
	#accounts = new Map();

	constructor({ now = Date.now, onWarning = () => {} } = {}) {
		this.#now = now;
		this.#onWarning = onWarning;
	}

	#agent(record) {
		let agent = this.#agents.get(record.agentId);
		if (agent === undefined) {
			agent = { agentId: record.agentId, since: this.#now(), calls: 0, busyMs: 0, tokens: zeroTokens(), costUsd: 0, costKnown: true, listCostUsd: 0, listKnown: false, free: false,
				last: null, events: [], threads: new Map(), goal: { revision: record.goalRevision ?? 0, calls: 0, tokens: zeroTokens(), costUsd: 0, busyMs: 0 }, profile: null };
			this.#agents.set(record.agentId, agent);
		}
		agent.profile = { provider: record.provider ?? 'codex', model: record.model ?? null, reasoningEffort: record.reasoningEffort ?? null, serviceTier: record.serviceTier ?? null };
		if (Number.isSafeInteger(record.goalRevision) && record.goalRevision !== agent.goal.revision) {
			agent.goal = { revision: record.goalRevision, calls: 0, tokens: zeroTokens(), costUsd: 0, busyMs: 0 };
		}
		return agent;
	}

	registerAgent(record) { this.#agent(record); }

	removeAgent(agentId) { this.#agents.delete(agentId); }

	/**
	 * A provider usage report (the live_usage JSON). Cumulative totals are kept per thread so repeated reports are
	 * not counted twice; a report with call timing counts one model call.
	 */
	recordUsage(record, value) {
		if (record === null || record === undefined || value === null || typeof value !== 'object') return;
		const agent = this.#agent(record);
		const now = this.#now();
		const thread = typeof value.threadId === 'string' ? value.threadId : '';
		const totals = totalsOf(value);
		const previous = agent.threads.get(thread) ?? null;
		const call = value.call !== null && typeof value.call === 'object' ? value.call : null;
		const changed = totals !== null && (previous === null || Object.keys(totals).some((key) => totals[key] !== previous[key]));
		if (!changed && call === null) return;
		let tokens = null;
		if (changed && previous !== null && Object.keys(totals).every((key) => totals[key] >= previous[key])) {
			tokens = tokensOf(Object.fromEntries(Object.keys(totals).map((key) => [key, totals[key] - previous[key]])));
		} else if (changed) {
			tokens = tokensOf(value.last ?? value);
		}
		if (totals !== null) agent.threads.set(thread, totals);
		if (agent.threads.size > 64) agent.threads.delete(agent.threads.keys().next().value);
		const at = Number.isSafeInteger(call?.endedAt) ? call.endedAt : Number.isSafeInteger(value.reportedAtEpochMs) ? value.reportedAtEpochMs : now;
		const busyMs = Number.isFinite(call?.totalMs) && call.totalMs >= 0 ? call.totalMs : 0;
		const isCall = call !== null || previous === null;
		tokens ??= zeroTokens();
		const cost = callCostUsd({ input: tokens.uncached, cacheRead: tokens.cached, cacheWrite: tokens.cacheWrite, output: tokens.output }, agent.profile);
		agent.free = cost.free;
		if (isCall) { agent.calls += 1; agent.goal.calls += 1; }
		agent.busyMs += busyMs;
		agent.goal.busyMs += busyMs;
		addTokens(agent.tokens, tokens);
		addTokens(agent.goal.tokens, tokens);
		if (cost.costUsd === null) agent.costKnown = false;
		else { agent.costUsd += cost.costUsd; agent.goal.costUsd += cost.costUsd; }
		if (cost.listCostUsd !== null) { agent.listCostUsd += cost.listCostUsd; agent.listKnown = true; }
		agent.last = { at, input: tokens.input, cached: tokens.cached, output: tokens.output, reasoning: tokens.reasoning, ms: call === null ? null : busyMs };
		agent.events.push({ at, calls: isCall ? 1 : 0, input: tokens.input, output: tokens.output, costUsd: cost.costUsd ?? 0, listCostUsd: cost.listCostUsd ?? 0 });
		this.#trim(agent.events, now);
		const account = this.#account(agent.profile.provider);
		if (isCall) account.requests.push(at);
		this.#trimTimes(account.requests, now);
		this.#evaluate(agent.profile.provider);
	}

	/** Shared allowance reports: Codex rateLimits (raw or parsed) or a parsed Claude rate_limit_event. */
	recordAllowance(provider, value) {
		if (value === null || typeof value !== 'object' || !Object.hasOwn(PROVIDER_REGISTRY, provider)) return;
		const now = this.#now();
		const parsed = Array.isArray(value.windows) ? value : parseCodexRateLimits(value);
		if (parsed === null) return;
		const account = this.#account(provider);
		for (const window of parsed.windows ?? []) {
			if (!Number.isFinite(window.usedPercent)) continue;
			const current = account.windows.get(window.id) ?? { id: window.id, samples: [] };
			// A window that reset starts a new series.
			if (current.samples.length > 0 && window.usedPercent < current.samples[current.samples.length - 1].value) current.samples = [];
			current.samples.push({ at: now, value: window.usedPercent });
			current.samples = current.samples.filter((sample) => sample.at >= now - SAMPLE_KEEP_MS);
			current.usedPercent = window.usedPercent;
			current.windowMins = window.windowMins ?? current.windowMins ?? null;
			current.resetsAt = window.resetsAt ?? null;
			account.windows.set(window.id, current);
		}
		if (parsed.credits !== undefined && parsed.credits !== null) {
			account.credits.unlimited = parsed.credits.unlimited === true;
			if (Number.isFinite(parsed.credits.balance)) {
				if (account.credits.samples.length > 0 && parsed.credits.balance > account.credits.samples[account.credits.samples.length - 1].value) account.credits.samples = [];
				account.credits.samples.push({ at: now, value: parsed.credits.balance });
				account.credits.samples = account.credits.samples.filter((sample) => sample.at >= now - SAMPLE_KEEP_MS);
			}
		}
		if (typeof parsed.plan === 'string') account.plan ??= parsed.plan;
		account.blocked = parsed.reached != null || parsed.status === 'rejected' ? 'red' : parsed.status === 'allowed_warning' ? 'yellow' : 'none';
		this.#evaluate(provider);
	}

	/** A request the provider refused for rate (HTTP 429 or the provider's equivalent). */
	recordRateLimited(provider, at = this.#now()) {
		if (!Object.hasOwn(PROVIDER_REGISTRY, provider)) return;
		const account = this.#account(provider);
		account.rateLimited.total += 1;
		account.rateLimited.times.push(at);
		this.#trimTimes(account.rateLimited.times, this.#now());
		this.#evaluate(provider);
	}

	/** Account identity from discovery (already redacted). */
	setAccount(provider, info) {
		if (!Object.hasOwn(PROVIDER_REGISTRY, provider) || info === null || typeof info !== 'object') return;
		const account = this.#account(provider);
		account.name = info.name ?? info.method ?? info.credentials?.[0] ?? account.name;
		account.plan = info.plan ?? account.plan;
	}

	#account(provider) {
		let account = this.#accounts.get(provider);
		if (account === undefined) {
			account = { provider, name: null, plan: null, windows: new Map(), credits: { unlimited: false, samples: [] }, requests: [], rateLimited: { total: 0, times: [] }, blocked: 'none', level: 'none' };
			this.#accounts.set(provider, account);
		}
		return account;
	}

	#trim(events, now) {
		while (events.length > 0 && (events[0].at < now - HOUR || events.length > MAX_CALL_EVENTS)) events.shift();
	}

	#trimTimes(times, now) {
		while (times.length > 0 && (times[0] < now - HOUR || times.length > MAX_CALL_EVENTS)) times.shift();
	}

	agentRow(agentId) {
		const agent = this.#agents.get(agentId);
		if (agent === undefined) return null;
		const now = this.#now();
		const elapsed = Math.max(1, now - agent.since);
		const rates = (spanMs) => {
			const events = agent.events.filter((event) => event.at > now - spanMs);
			const minutes = Math.max(1 / 60, Math.min(spanMs, elapsed) / MINUTE);
			const sum = (key) => events.reduce((total, event) => total + event[key], 0);
			return { calls: round(sum('calls') / minutes, 3), tokensIn: round(sum('input') / minutes, 1), tokensOut: round(sum('output') / minutes, 1), costUsd: agent.costKnown ? round(sum('costUsd') / minutes, 6) : null, listCostUsd: agent.listKnown ? round(sum('listCostUsd') / minutes, 6) : null };
		};
		const perMinute = rates(RATE_SHORT_MS);
		const hour = rates(HOUR);
		const perHour = Object.fromEntries(Object.entries(hour).map(([key, value]) => [key, value === null ? null : round(value * 60, key.endsWith('Usd') ? 4 : 1)]));
		return {
			agentId: agent.agentId,
			provider: agent.profile.provider,
			model: agent.profile.model,
			effort: agent.profile.reasoningEffort,
			tier: agent.profile.serviceTier,
			since: agent.since,
			calls: agent.calls,
			busyMs: Math.round(agent.busyMs),
			busyPercent: round(Math.min(100, agent.busyMs / elapsed * 100), 1),
			tokens: { ...agent.tokens },
			last: agent.last === null ? null : { ...agent.last },
			costUsd: agent.costKnown ? round(agent.costUsd, 6) : null,
			listCostUsd: agent.listKnown ? round(agent.listCostUsd, 6) : null,
			free: agent.free,
			perMinute,
			perHour,
			goal: { revision: agent.goal.revision, calls: agent.goal.calls, busyMs: Math.round(agent.goal.busyMs), tokens: { ...agent.goal.tokens }, costUsd: agent.costKnown ? round(agent.goal.costUsd, 6) : null },
		};
	}

	accountRow(provider) {
		const account = this.#accounts.get(provider);
		if (account === undefined) return null;
		const now = this.#now();
		const entry = PROVIDER_REGISTRY[provider];
		const windows = [...account.windows.values()].map((window) => {
			const rates = seriesRates(window.samples, now);
			let hours = hoursUntil(100 - window.usedPercent, rates.perHour);
			const resetsFirst = hours !== null && Number.isFinite(window.resetsAt) && now + hours * HOUR > window.resetsAt;
			return { id: window.id, windowMins: window.windowMins ?? null, usedPercent: round(window.usedPercent, 2), resetsAt: window.resetsAt ?? null,
				perMinute: round(rates.perMinute, 4), perHour: round(rates.perHour, 3), hoursToLimit: round(hours, 2), resetsFirst };
		});
		let credits = null;
		if (account.credits.samples.length > 0 || account.credits.unlimited) {
			const latest = account.credits.samples.at(-1)?.value ?? null;
			const rates = seriesRates(account.credits.samples, now);
			// Credits fall as they are spent, so the burn is the negative of the balance's rate.
			const burnHour = rates.perHour === null ? null : -rates.perHour;
			credits = { remaining: latest === null ? null : round(latest, 2), unlimited: account.credits.unlimited,
				perMinute: rates.perMinute === null ? null : round(-rates.perMinute, 4), perHour: round(burnHour, 3),
				hoursToLimit: account.credits.unlimited ? null : round(hoursUntil(latest, burnHour), 2) };
		}
		const requestsSince = (spanMs) => account.requests.filter((at) => at > now - spanMs).length;
		// Shorter than the window so far: requests between the first and the last over that span.
		const span = (account.requests.at(-1) ?? now) - (account.requests[0] ?? now);
		const shortRate = now - (account.requests[0] ?? now) < RATE_SHORT_MS
			? (span >= MINUTE ? (account.requests.length - 1) / (span / MINUTE) : null)
			: requestsSince(RATE_SHORT_MS) / (RATE_SHORT_MS / MINUTE);
		const limitedRecent = account.rateLimited.times.filter((at) => at >= now - RATE_LIMIT_RED_MS).length;
		const limitedHour = account.rateLimited.times.filter((at) => at >= now - HOUR).length;
		const requests = { perMinute: round(shortRate, 2), perHour: requestsSince(HOUR),
			rateLimited: { total: account.rateLimited.total, lastHour: limitedHour, lastAt: account.rateLimited.times.at(-1) ?? null } };
		const { level, reason, hoursToLimit } = this.#level(account, windows, credits, limitedRecent, limitedHour);
		return {
			provider,
			label: entry.label,
			account: account.name,
			plan: account.plan,
			limitKind: entry.limitKind === 'plan_percent' && windows.length === 0 && credits !== null ? 'credits' : entry.limitKind,
			windows,
			credits,
			requests,
			hoursToLimit,
			warning: level,
			warningReason: reason,
			agents: [...this.#agents.values()].filter((agent) => agent.profile.provider === provider).map((agent) => agent.agentId),
		};
	}

	#level(account, windows, credits, limitedRecent, limitedHour) {
		let level = account.blocked === 'red' ? 'red' : account.blocked === 'yellow' ? 'yellow' : 'none';
		let reason = level === 'none' ? null : 'provider reports the limit is near or reached';
		let soonest = null;
		for (const window of windows) {
			if (window.usedPercent >= 100) { level = 'red'; reason = `${windowLabel(window)} limit reached`; soonest = 0; continue; }
			if (window.hoursToLimit === null || window.resetsFirst) continue;
			if (soonest === null || window.hoursToLimit < soonest) soonest = window.hoursToLimit;
			const next = warningLevel(window.hoursToLimit);
			if (LEVEL_RANK[next] > LEVEL_RANK[level]) { level = next; reason = `${windowLabel(window)} ${window.usedPercent}% used, about ${formatHours(window.hoursToLimit)} to the limit`; }
		}
		if (credits !== null && credits.hoursToLimit !== null) {
			if (soonest === null || credits.hoursToLimit < soonest) soonest = credits.hoursToLimit;
			const next = warningLevel(credits.hoursToLimit);
			if (LEVEL_RANK[next] > LEVEL_RANK[level]) { level = next; reason = `credits ${credits.remaining} left, about ${formatHours(credits.hoursToLimit)} at this rate`; }
		}
		// Request-limited accounts publish no budget: only refusals are observable.
		if (limitedRecent > 0 && LEVEL_RANK.red > LEVEL_RANK[level]) { level = 'red'; reason = `${limitedRecent} rate-limited request${limitedRecent === 1 ? '' : 's'} in the last 10 min`; }
		else if (limitedHour > 0 && level === 'none') { level = 'yellow'; reason = `${limitedHour} rate-limited request${limitedHour === 1 ? '' : 's'} in the last hour`; }
		return { level: worse('none', level), reason, hoursToLimit: soonest };
	}

	#evaluate(provider) {
		const account = this.#accounts.get(provider);
		const row = this.accountRow(provider);
		if (account === undefined || row === null || row.warning === account.level) return;
		const previous = account.level;
		account.level = row.warning;
		try { this.#onWarning({ provider, level: row.warning, previous, message: warningMessage(row), agents: row.agents }); } catch { /* warnings are observational */ }
	}

	/** Re-checks every account so a projection crossing a threshold between reports still warns once. */
	evaluateAll() { for (const provider of this.#accounts.keys()) this.#evaluate(provider); }

	/** One short line per account for the settings table, e.g. "weekly 84% used" or "credits 4288". */
	limitSummaries() {
		const out = {};
		for (const provider of this.#accounts.keys()) {
			const row = this.accountRow(provider);
			if (row === null) continue;
			const window = row.windows.toSorted((left, right) => right.usedPercent - left.usedPercent)[0];
			if (window !== undefined) out[provider] = `${windowLabel(window).replace(/ window$/, '')} ${window.usedPercent}% used`;
			else if (row.credits?.remaining != null) out[provider] = `credits ${row.credits.remaining}`;
			else if (row.requests.rateLimited.lastHour > 0) out[provider] = `${row.requests.rateLimited.lastHour} rate-limited in the last hour`;
		}
		return out;
	}

	/** Every agent's usage plus one row per account, in one snapshot. */
	roster(records = null) {
		const ids = records === null ? [...this.#agents.keys()] : records.map((record) => { this.#agent(record); return record.agentId; });
		const agents = ids.map((id) => this.agentRow(id)).filter((row) => row !== null);
		const providers = new Set([...agents.map((row) => row.provider), ...this.#accounts.keys()]);
		const accounts = [...providers].filter((provider) => Object.hasOwn(PROVIDER_REGISTRY, provider)).map((provider) => { this.#account(provider); return this.accountRow(provider); });
		return { generatedAt: this.#now(), agents, accounts };
	}
}

function windowLabel(window) {
	if (window.windowMins === 300) return '5-hour window';
	if (window.windowMins === 10_080) return 'weekly window';
	if (Number.isFinite(window.windowMins)) return `${window.windowMins}-minute window`;
	return `${window.id} window`;
}

function formatHours(hours) {
	if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
	return `${round(hours, 1)} h`;
}

export function warningMessage(row) {
	const name = `${row.label}${row.account ? ` (${row.account})` : ''}`;
	if (row.warning === 'none') return `${name} usage is back within limits.`;
	return `${name} usage ${row.warning === 'red' ? 'critical' : 'warning'}: ${row.warningReason ?? 'limit near'}.`;
}
