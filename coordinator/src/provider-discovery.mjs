import { execFile as nodeExecFile } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROVIDER_REGISTRY } from './provider-registry.mjs';

/**
 * Finds which provider CLIs this machine has, which account each is signed in to, and which models, reasoning
 * levels and speed tiers each offers. Installed/version/signed-in come from the provider CLI health probe; the
 * account comes from each CLI's own status command; models come from the provider catalogs (Codex model/list,
 * `opencode models`, `agy models`, Claude's stored list). Nothing here starts a model call.
 */

export const DEFAULT_DISCOVERY_INTERVAL_MS = 10 * 60_000;
const ACCOUNT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const MAX_ROW_MODELS = 48;

/** Keeps only a short prefix of the local part, so the settings table can tell accounts apart without showing them. */
export function redactEmail(value) {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	const at = text.indexOf('@');
	if (at <= 0) return text.length === 0 ? null : `${text.slice(0, 4)}...`;
	return `${text.slice(0, Math.min(4, at))}...`;
}

function clean(text) { return String(text ?? '').replace(ANSI, ''); }

function parseJsonObject(text) {
	const value = clean(text);
	const start = value.indexOf('{');
	const end = value.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(value.slice(start, end + 1));
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
	} catch { return null; }
}

/** `codex login status` prints only the method ("Logged in using ChatGPT" / "... an API key"). */
export function parseCodexLoginStatus(text) {
	const value = clean(text);
	if (/not logged in/i.test(value)) return { signedIn: false, method: null };
	const match = /logged in using (?:an? )?([^\r\n]+)/i.exec(value);
	if (match === null) return { signedIn: null, method: null };
	return { signedIn: true, method: match[1].trim().replace(/\.$/, '').slice(0, 32) };
}

/** Codex app-server `account/read` result: ChatGPT accounts carry the email and plan type. */
export function parseCodexAccount(result) {
	const account = result?.account;
	if (account === null || account === undefined || typeof account !== 'object') return null;
	if (account.type === 'chatgpt') return { name: redactEmail(account.email), plan: typeof account.planType === 'string' ? account.planType : null, method: 'ChatGPT' };
	if (account.type === 'apiKey') return { name: null, plan: null, method: 'API key' };
	return { name: null, plan: null, method: typeof account.type === 'string' ? account.type.slice(0, 32) : null };
}

/**
 * Codex app-server `account/rateLimits/read` result or `account/rateLimits/updated` params. Windows are percentages
 * of the plan; credits are the spendable balance when the account has any.
 */
export function parseCodexRateLimits(value) {
	const limits = value?.rateLimits ?? value;
	if (limits === null || typeof limits !== 'object') return null;
	const windows = [];
	for (const key of ['primary', 'secondary']) {
		const window = limits[key];
		if (!Number.isFinite(window?.usedPercent)) continue;
		windows.push({
			id: key,
			usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
			windowMins: Number.isSafeInteger(window.windowDurationMins) ? window.windowDurationMins : null,
			resetsAt: Number.isFinite(window.resetsAt) ? Math.round(window.resetsAt * 1_000) : null,
		});
	}
	let credits = null;
	const snapshot = limits.credits;
	if (snapshot !== null && typeof snapshot === 'object') {
		const balance = Number.parseFloat(snapshot.balance);
		credits = { hasCredits: snapshot.hasCredits === true, unlimited: snapshot.unlimited === true, balance: Number.isFinite(balance) ? balance : null };
	}
	if (windows.length === 0 && credits === null) return null;
	return { windows, credits, plan: typeof limits.planType === 'string' ? limits.planType : null, reached: typeof limits.rateLimitReachedType === 'string' ? limits.rateLimitReachedType : null };
}

/** `claude auth status --json`. The org name often contains the email, so only the email prefix and plan leave here. */
export function parseClaudeAuthStatus(text) {
	const document = parseJsonObject(text);
	if (document === null) return { signedIn: null, name: null, plan: null, method: null };
	return {
		signedIn: typeof document.loggedIn === 'boolean' ? document.loggedIn : null,
		name: redactEmail(document.email),
		plan: typeof document.subscriptionType === 'string' ? document.subscriptionType.slice(0, 32) : null,
		method: typeof document.authMethod === 'string' ? document.authMethod.slice(0, 32) : null,
	};
}

/**
 * Claude Code's stream-json `rate_limit_event`. `utilization` is a 0..1 share of the subscription window; the
 * per-window breakdown is present only on some accounts.
 */
export function parseClaudeRateLimitEvent(message) {
	const info = message?.rate_limit_info;
	if (info === null || typeof info !== 'object') return null;
	const windows = [];
	const add = (id, utilization, resetsAt) => {
		if (!Number.isFinite(utilization)) return;
		const percent = utilization <= 1 ? utilization * 100 : utilization;
		windows.push({ id, usedPercent: Math.max(0, Math.min(100, percent)), windowMins: CLAUDE_WINDOW_MINS[id] ?? null, resetsAt: Number.isFinite(resetsAt) ? Math.round(resetsAt * 1_000) : null });
	};
	if (info.unifiedWindows !== null && typeof info.unifiedWindows === 'object') {
		for (const [id, window] of Object.entries(info.unifiedWindows)) add(id, window?.utilization, window?.resetsAt);
	}
	if (windows.length === 0 && typeof info.rateLimitType === 'string') add(info.rateLimitType, info.utilization, info.resetsAt);
	return { status: typeof info.status === 'string' ? info.status : null, windows, overage: info.isUsingOverage === true };
}
const CLAUDE_WINDOW_MINS = Object.freeze({ five_hour: 300, seven_day: 10_080, seven_day_opus: 10_080, seven_day_sonnet: 10_080, seven_day_overage_included: 10_080 });

/** `opencode auth list` names saved credentials ("OpenCode api") and never prints a key. */
export function parseOpenCodeAuthList(text) {
	const value = clean(text);
	const count = /\b(\d+)\s+credentials?\b/i.exec(value);
	const names = [];
	for (const line of value.split(/\r?\n/)) {
		const match = /^[\s│]*[●•*]\s+(.+?)\s*$/.exec(line);
		if (match !== null) names.push(match[1].replace(/\s+/g, ' ').slice(0, 48));
	}
	const total = count === null ? names.length : Number(count[1]);
	return { signedIn: total > 0 ? true : count === null ? null : false, credentials: names };
}

/**
 * `opencode models --verbose` prints `provider/model` followed by that model's JSON. Only active models that can
 * call tools are playable; a model whose every price is zero is free. Variants are the reasoning levels.
 */
export function parseOpenCodeModels(text) {
	const value = clean(text);
	const models = [];
	const header = /^([a-z0-9][\w.-]*\/[^\s{}]+)\s*$/gm;
	const starts = [];
	for (let match = header.exec(value); match !== null; match = header.exec(value)) starts.push({ id: match[1], at: match.index, end: header.lastIndex });
	for (let index = 0; index < starts.length; index += 1) {
		const body = value.slice(starts[index].end, index + 1 < starts.length ? starts[index + 1].at : value.length).trim();
		let info = null;
		if (body.startsWith('{')) { try { info = JSON.parse(body); } catch { info = null; } }
		const id = starts[index].id;
		if (info === null) { models.push({ id, label: id.split('/').pop(), efforts: ['default'], free: /-free$/.test(id), toolcall: null, active: null, cost: null }); continue; }
		const cost = info.cost ?? null;
		const prices = cost === null ? [] : [cost.input, cost.output, cost.cache?.read, cost.cache?.write].filter((price) => price !== undefined);
		const variants = info.variants !== null && typeof info.variants === 'object' ? Object.keys(info.variants) : [];
		models.push({
			id,
			label: typeof info.name === 'string' && info.name.trim() ? info.name.trim().slice(0, 96) : id.split('/').pop(),
			efforts: variants.length === 0 ? ['default'] : variants,
			free: prices.length > 0 && prices.every((price) => price === 0),
			toolcall: info.capabilities?.toolcall ?? null,
			active: info.status === undefined ? null : info.status === 'active',
			cost: cost === null ? null : { input: cost.input ?? null, output: cost.output ?? null, cacheRead: cost.cache?.read ?? null, cacheWrite: cost.cache?.write ?? null },
		});
	}
	return models;
}

/** Models OpenCode can play: the account can use them (they are listed), they are active and they call tools. */
export function playableOpenCodeModels(models) {
	return models.filter((model) => model.toolcall !== false && model.active !== false);
}

/**
 * A free OpenCode model's list-price equivalent: the paid model of the same name in OpenCode's own models.dev
 * cache (`opencode/glm-5.3-flash-free` -> `opencode/glm-5.3-flash`). Prices are USD per million tokens.
 */
export function openCodeListPrices(modelsDocument, ids) {
	const prices = {};
	if (modelsDocument === null || typeof modelsDocument !== 'object') return prices;
	for (const id of ids) {
		const [provider, ...rest] = id.split('/');
		const name = rest.join('/');
		if (!/-free$/.test(name)) continue;
		const paid = modelsDocument[provider]?.models?.[name.replace(/-free$/, '')]?.cost;
		if (paid === undefined || paid === null || !Number.isFinite(paid.input) || !Number.isFinite(paid.output)) continue;
		if (paid.input === 0 && paid.output === 0) continue;
		prices[id] = Object.freeze({ input: paid.input, output: paid.output, cacheRead: Number.isFinite(paid.cache_read) ? paid.cache_read : paid.input, cacheWrite: Number.isFinite(paid.cache_write) ? paid.cache_write : paid.input });
	}
	return prices;
}

export function openCodeModelsCachePath(environment = process.env) {
	const base = typeof environment.XDG_CACHE_HOME === 'string' && environment.XDG_CACHE_HOME.length > 0 ? environment.XDG_CACHE_HOME : path.join(environment.HOME ?? environment.USERPROFILE ?? os.homedir(), '.cache');
	return path.join(base, 'opencode', 'models.json');
}

/**
 * Builds the catalog's providers section from CLI health, accounts and the combined model catalog.
 * A provider whose CLI is known to be missing or signed out keeps its row (so the table can say so) but no models.
 */
export function buildProviderRows({ catalogModels = [], health = {}, accounts = {}, checkedAt = 0, limits = {} } = {}) {
	return Object.values(PROVIDER_REGISTRY).map((entry) => {
		const probe = health[entry.id] ?? null;
		const account = accounts[entry.id] ?? null;
		const installed = probe === null || probe.status === 'unknown' ? null : !['missing', 'broken'].includes(probe.status);
		const signedIn = probe?.status === 'unauthenticated' ? false
			: probe?.status === 'ok' ? true
			: typeof account?.signedIn === 'boolean' ? account.signedIn : null;
		const usable = installed !== false && signedIn !== false;
		const models = usable ? catalogModels.filter((model) => (model.provider ?? 'codex') === entry.id && typeof model.id === 'string').slice(0, MAX_ROW_MODELS).map((model) => {
			const efforts = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
			const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers : [];
			return {
				id: model.id,
				label: typeof model.displayName === 'string' ? model.displayName : model.id,
				efforts: [...efforts],
				defaultEffort: typeof model.defaultReasoningEffort === 'string' && efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : efforts[0] ?? null,
				tiers: tiers.length > 0 ? [...tiers] : [entry.defaultServiceTier],
				free: model.free === true,
			};
		}) : [];
		const defaultModel = models.find((model) => catalogModels.find((candidate) => candidate.id === model.id && (candidate.provider ?? 'codex') === entry.id)?.isDefault === true)?.id ?? models[0]?.id ?? null;
		return {
			id: entry.id,
			label: entry.cliLabel,
			color: entry.color,
			installed,
			version: probe?.version ?? null,
			signedIn,
			account: account?.name ?? account?.method ?? (account?.credentials?.[0] ?? null),
			plan: account?.plan ?? null,
			models,
			defaultModel,
			limitKind: entry.limitKind,
			limit: typeof limits[entry.id] === 'string' ? limits[entry.id].slice(0, 48) : null,
			checkedAt: probe?.checkedAtEpochMs ?? checkedAt,
		};
	});
}

/**
 * Rescans on start, every `intervalMs` and on request. Account readers run the CLIs' read-only status commands;
 * a failed reader leaves that provider's account unknown and never fails the scan.
 */
export class ProviderDiscovery {
	#cliHealth;
	#accountReaders;
	#now;
	#intervalMs;
	#setInterval;
	#clearInterval;
	#timer = null;
	#health = {};
	#accounts = {};
	#checkedAt = 0;
	#inFlight = null;
	#listeners = new Set();
	enabled;

	constructor({ cliHealth = null, accountReaders = {}, now = Date.now, intervalMs = DEFAULT_DISCOVERY_INTERVAL_MS, setInterval: schedule = setInterval, clearInterval: cancel = clearInterval } = {}) {
		this.#cliHealth = cliHealth;
		this.#accountReaders = accountReaders;
		this.#now = now;
		this.#intervalMs = intervalMs;
		this.#setInterval = schedule;
		this.#clearInterval = cancel;
		this.enabled = cliHealth !== null && cliHealth.enabled === true;
	}

	/** Called with the fresh rows' inputs after every completed scan. */
	onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

	start() {
		if (!this.enabled || this.#timer !== null) return;
		void this.refresh({ force: true }).catch(() => {});
		this.#timer = this.#setInterval(() => { void this.refresh({ force: true }).catch(() => {}); }, this.#intervalMs);
		this.#timer?.unref?.();
	}

	stop() {
		if (this.#timer !== null) this.#clearInterval(this.#timer);
		this.#timer = null;
	}

	async refresh({ force = false } = {}) {
		if (!this.enabled) return this.state();
		if (this.#inFlight !== null) return this.#inFlight;
		this.#inFlight = (async () => {
			if (force) this.#cliHealth.invalidate?.();
			const ids = Object.keys(PROVIDER_REGISTRY);
			const health = await Promise.all(ids.map((id) => Promise.resolve().then(() => this.#cliHealth.check(id)).catch(() => null)));
			const accounts = await Promise.all(ids.map((id, index) => {
				const reader = this.#accountReaders[id];
				const probe = health[index];
				if (typeof reader !== 'function' || probe === null || ['missing', 'broken'].includes(probe.status)) return null;
				return Promise.resolve().then(() => reader()).catch(() => null);
			}));
			this.#health = Object.fromEntries(ids.map((id, index) => [id, health[index]]));
			this.#accounts = Object.fromEntries(ids.map((id, index) => [id, accounts[index]]));
			this.#checkedAt = this.#now();
			for (const listener of this.#listeners) { try { listener(this.state()); } catch { /* listeners are observational */ } }
			return this.state();
		})().finally(() => { this.#inFlight = null; });
		return this.#inFlight;
	}

	state() {
		return { health: { ...this.#health }, accounts: { ...this.#accounts }, checkedAt: this.#checkedAt };
	}

	rows(catalogModels, limits = {}) {
		return buildProviderRows({ catalogModels, limits, ...this.state() });
	}
}

/** Runs a read-only CLI status command with the agent's child environment. */
export function runStatusCommand(command, args, { environment, execFile = nodeExecFile, timeoutMs = ACCOUNT_TIMEOUT_MS } = {}) {
	return new Promise((resolve) => {
		try {
			execFile(command, args, { env: environment, timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
				resolve({ ok: error === null || error === undefined, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
			});
		} catch {
			resolve({ ok: false, stdout: '', stderr: '' });
		}
	});
}

/** Account readers for the CLIs that expose one. Codex reads its account through the running app-server. */
export function createAccountReaders({ environments = {}, executables = {}, codexService = null, execFile = nodeExecFile } = {}) {
	const run = (provider, args) => runStatusCommand(executables[provider] ?? provider, args, { environment: environments[provider] ?? process.env, execFile });
	return {
		codex: async () => {
			const live = typeof codexService?.readAccount === 'function' ? await codexService.readAccount().catch(() => null) : null;
			if (live?.account) return { signedIn: true, ...live.account, rateLimits: live.rateLimits ?? null };
			const status = await run('codex', ['login', 'status']);
			const parsed = parseCodexLoginStatus(`${status.stdout}\n${status.stderr}`);
			return { signedIn: parsed.signedIn, name: null, plan: null, method: parsed.method };
		},
		claude: async () => {
			const status = await run('claude', ['auth', 'status', '--json']);
			return parseClaudeAuthStatus(status.stdout || status.stderr);
		},
		opencode: async () => {
			const status = await run('opencode', ['auth', 'list']);
			const parsed = parseOpenCodeAuthList(`${status.stdout}\n${status.stderr}`);
			return { signedIn: parsed.signedIn, name: null, plan: parsed.credentials.some((name) => /opencode/i.test(name)) ? 'Zen' : null, method: parsed.credentials[0] ?? null, credentials: parsed.credentials };
		},
	};
}

/** Reads `opencode models --verbose` and the models.dev cache for list-price equivalents of free models. */
export async function discoverOpenCodeModels({ executable = 'opencode', environment = process.env, execFile = nodeExecFile, readFile = nodeReadFile, timeoutMs = ACCOUNT_TIMEOUT_MS } = {}) {
	const result = await runStatusCommand(executable, ['models', '--verbose'], { environment, execFile, timeoutMs });
	if (!result.ok) throw Object.assign(new Error('opencode models failed'), { code: 'OPENCODE_MODELS_FAILED' });
	const models = playableOpenCodeModels(parseOpenCodeModels(result.stdout));
	let listPrices = {};
	try { listPrices = openCodeListPrices(JSON.parse(await readFile(openCodeModelsCachePath(environment), 'utf8')), models.map((model) => model.id)); } catch { listPrices = {}; }
	return { models, listPrices };
}
