import { open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { dirname } from 'node:path';
import { estimateTokenCostUsd } from '../call-cost.mjs';
import { providerCallTokens } from './quality-metrics.mjs';
import { PREPARATION_ALLOWANCE_USD } from './spend-gate.mjs';

/** Provider rows whose usage counters could not attribute tokens to the call (for example a cut-off Codex turn). */
export const UNMETERED_USAGE_STATUSES = new Set(['missing', 'baseline_unknown', 'counter_reset']);
/** Held for both judgments until play ends: two Codex Sol judge attempts at their reserved bound. */
export const JUDGE_ALLOWANCE_USD = 2;
export const DEFAULT_JUDGE_ATTEMPT_RESERVE_USD = 0.25;
/** The gate refuses a call whose worst case does not fit, so the last few dollars of a run's budget are headroom, not play. */
export const CALL_HEADROOM_USD = 4;
export const MIN_SUITE_RESERVE_USD = PREPARATION_ALLOWANCE_USD + JUDGE_ALLOWANCE_USD + 1;

/** Default per-run reservation: $0.45 per play minute, the preparation and judge allowances, and worst-case call headroom. */
export function defaultRunReserveUsd(windowMs, { judges = true } = {}) {
	return Math.round((0.45 * windowMs / 60000 + PREPARATION_ALLOWANCE_USD + (judges ? JUDGE_ALLOWANCE_USD : 0) + CALL_HEADROOM_USD) * 100) / 100;
}

/** Charge for one provider call whose usage was never metered: the largest metered play call, or R/10 without one. Used live and at settlement. */
export function unmeteredCallUsd(playCallCosts, reserveUsd) {
	const known = playCallCosts.filter(finite);
	return known.length ? Math.max(...known) : reserveUsd / 10;
}

const finite = value => Number.isFinite(value) && value >= 0;
const sum = values => values.reduce((total, value) => total + value, 0);

/**
 * Charge for one finished (or failed) run. Metered spend is used as is; anything that may have cost money without
 * metering is charged a conservative reserve so a budget never treats it as free and never has to halt on it.
 */
export function runSpendUsd(run, { reserveUsd, judgeAttemptReserveUsd = DEFAULT_JUDGE_ATTEMPT_RESERVE_USD } = {}) {
	if (!finite(reserveUsd)) throw new TypeError('reserveUsd must be a finite non-negative amount');
	const notes = [];
	let meteredUsd = 0, reservedUsd = 0;
	if (!run) return { usd: reserveUsd, meteredUsd: 0, reservedUsd: reserveUsd, notes: ['Worker failed or was cancelled; spend unknown, charged the run reserve'] };
	const metrics = run.metrics ?? null;
	const details = Array.isArray(metrics?.modelCallDetails) ? metrics.modelCallDetails : [];
	const meteredCalls = details.map(d => d.costEstimateUsd).filter(finite);
	const perCallUsd = unmeteredCallUsd(details.filter(d => d.phase === 'play').map(d => d.costEstimateUsd), reserveUsd);
	const unmetered = Number.isSafeInteger(run.unmeteredProviderCalls) ? run.unmeteredProviderCalls : 0;
	if (run.gate) {
		// The gate already holds preparation, judges and (for gateway-metered play) every model call at metered or worst-case cost.
		let usd = run.gate.chargeUsd, playUsd = 0;
		if (run.gate.playMetering === 'observer') {
			playUsd = finite(metrics?.playCostEstimateUsd) ? metrics.playCostEstimateUsd : metrics?.modelCalls > 0 ? reserveUsd : 0;
			playUsd += unmetered * perCallUsd;
			usd += playUsd;
		}
		const notes = [`Gate charge ${run.gate.chargeUsd.toFixed(4)} USD (${run.gate.unmeteredSettlements} settlements at worst case, ${run.gate.denied} refused calls)`];
		if (run.gate.playMetering === 'observer') notes.push(`Observer-metered play ${playUsd.toFixed(4)} USD including ${unmetered} missing-usage calls at ${perCallUsd.toFixed(4)} USD`);
		return { usd, meteredUsd: usd, reservedUsd: 0, notes, overReservationUsd: Math.max(0, usd - reserveUsd) };
	}
	if (!metrics) {
		// The launcher writes the scenario manifest before it starts the server or coordinator, so no observer means no model ran.
		if (run.termination === 'NO_OBSERVER') notes.push('No observer: the coordinator never started, so no model calls were made');
		else { reservedUsd += reserveUsd; notes.push('Metrics missing; spend unknown, charged the run reserve'); }
	} else if (!(metrics.modelCalls > 0)) {
		if (finite(metrics.costEstimateUsd)) meteredUsd += metrics.costEstimateUsd;
		notes.push('No model calls; known preparation spend only');
	} else if (finite(metrics.costEstimateUsd)) meteredUsd += metrics.costEstimateUsd;
	else if (details.length) {
		const unknown = details.filter(d => !finite(d.costEstimateUsd)).length;
		meteredUsd += sum(meteredCalls); reservedUsd += unknown * perCallUsd;
		notes.push(`${unknown} model calls without token counts; charged ${perCallUsd.toFixed(4)} USD each`);
	} else { reservedUsd += reserveUsd; notes.push('Model calls without cost evidence; charged the run reserve'); }
	if (unmetered > 0) { reservedUsd += unmetered * perCallUsd; notes.push(`${unmetered} provider calls with missing usage; charged ${perCallUsd.toFixed(4)} USD each`); }
	const judge = run.judge;
	if (judge) {
		if (finite(judge.costUsd) && judge.unknownSpend !== true) meteredUsd += judge.costUsd;
		else if (Array.isArray(judge.attempts) && judge.attempts.length) {
			const unknown = judge.attempts.filter(a => !finite(a.costUsd)).length;
			meteredUsd += sum(judge.attempts.map(a => a.costUsd).filter(finite)); reservedUsd += unknown * judgeAttemptReserveUsd;
			if (unknown) notes.push(`${unknown} judge attempts without metering; charged ${judgeAttemptReserveUsd} USD each`);
		} else if (Array.isArray(judge.judgments) && judge.judgments.length) {
			const costs = judge.judgments.map(j => j.costUsd ?? j.costEstimateUsd);
			meteredUsd += sum(costs.filter(finite)); reservedUsd += (costs.filter(c => !finite(c)).length + Math.max(0, 2 - costs.length)) * judgeAttemptReserveUsd;
		} else { reservedUsd += 2 * judgeAttemptReserveUsd; notes.push('Judge failed without attempt evidence; charged two judge attempts'); }
	}
	return { usd: meteredUsd + reservedUsd, meteredUsd, reservedUsd, notes, overReservationUsd: Math.max(0, meteredUsd + reservedUsd - reserveUsd) };
}

/**
 * Provider turns whose usage was never metered. Only thread-counter providers (Codex) meter through these rows; Claude
 * meters every call in the trace and reports its turn rows as counter-missing, so they are not unmetered calls.
 * A cut-off turn (a death cancels it before any usage update) is metered after all once its thread's cumulative counter
 * is read again: that reading, and so the thread total, already holds whatever the turn spent. Only a counter reset
 * can lose spend without a later reading showing it.
 */
export function unmeteredProviderCalls(traceRows, providerRows) {
	if (traceRows.some(r => r.event === 'native_model_call' && providerCallTokens(r))) return 0;
	const readThreads = new Set();
	let unmetered = 0;
	for (let index = providerRows.length - 1; index >= 0; index -= 1) {
		const row = providerRows[index], usage = row?.usage;
		const threadId = typeof row?.threadId === 'string' && row.threadId.length > 0 ? row.threadId : null;
		const covered = threadId !== null && usage?.status !== 'counter_reset' && (readThreads.has(threadId) || usage?.end != null);
		if (UNMETERED_USAGE_STATUSES.has(usage?.status) && !covered) unmetered += 1;
		if (threadId !== null && (usage?.start != null || usage?.end != null)) readThreads.add(threadId);
	}
	return unmetered;
}

/** Running play spend from the live trace, cheap enough to evaluate every few seconds during a long run. */
export function liveSpendUsd({ traceRows = [], providerRows = [], profile, reserveUsd = 0 }) {
	const finalCalls = new Map(), calls = [];
	for (const row of traceRows) if (row.event === 'native_model_call' && (row.goalRevision === undefined || row.goalRevision >= 1)) {
		if (row.modelCallId) finalCalls.set(row.modelCallId, row); else calls.push(row);
	}
	calls.push(...finalCalls.values());
	const callCosts = calls.map(providerCallTokens).filter(Boolean).map(tokens => estimateTokenCostUsd(tokens, profile)).filter(finite);
	let usd = sum(callCosts);
	if (!callCosts.length) {
		// Codex exposes cumulative thread counters instead of per-call rows. One thread outlives goal revisions (each death
		// and respawn bumps the revision), so its latest total is counted once, as settlement does.
		const latest = new Map();
		for (const row of traceRows) if (row.event === 'native_token_usage' && row.scope === 'thread_total') latest.set(`${row.agentId}|${row.sessionKey ?? 'default'}`, row);
		usd = sum([...latest.values()].map(row => estimateTokenCostUsd(providerCallTokens(row), profile)).filter(finite));
	}
	const unmetered = unmeteredProviderCalls(traceRows, providerRows);
	const perCall = unmeteredCallUsd(callCosts, reserveUsd);
	return { usd: usd + unmetered * perCall, calls: calls.length, unmetered, perCallUsd: perCall };
}

/**
 * Budget ledger: a launch reserves its allowance first and settles to the actual charge afterwards.
 * With a file, the ledger is shared by every invocation that names it, so train and held-out runs share one cap.
 * Reservations left by a crashed invocation stay charged until someone settles them.
 */
export class SpendLedger {
	#file; #entries = {}; #lockTimeoutMs; #seed;
	/** priorSpendUsd is a one-time seed stored in the ledger itself: later invocations inherit it and must not restate a different value. */
	constructor({ capUsd = Infinity, priorSpendUsd = null, file = null, lockTimeoutMs = 30000 } = {}) {
		if (!(capUsd > 0)) throw new TypeError('Spend cap must be positive');
		if (priorSpendUsd !== null && !finite(priorSpendUsd)) throw new TypeError('Prior spend must be a finite non-negative amount');
		this.capUsd = capUsd; this.#seed = priorSpendUsd;
		this.#file = file; this.#lockTimeoutMs = lockTimeoutMs;
	}
	get file() { return this.#file; }
	async reserve(id, usd, label = null) {
		if (!finite(usd)) throw new TypeError('Reservation must be a finite non-negative amount');
		return this.#update(entries => {
			if (entries[id]) throw new Error(`Ledger entry ${id} already exists`);
			const t = totalsOf(entries);
			if (t.committedUsd + t.reservedUsd + usd > this.capUsd) return false;
			entries[id] = { state: 'reserved', usd, label, reservedUsd: usd, at: new Date().toISOString() };
			return true;
		});
	}
	async settle(id, usd, detail = null) {
		if (!finite(usd)) throw new TypeError('Settled spend must be a finite non-negative amount');
		return this.#update(entries => {
			const entry = entries[id];
			if (!entry || entry.state !== 'reserved') throw new Error(`Ledger entry ${id} is not reserved`);
			entries[id] = { ...entry, state: 'settled', usd, detail, settledAt: new Date().toISOString() };
			return totalsOf(entries);
		});
	}
	async totals() { return this.#update(entries => totalsOf(entries), false); }
	/** The largest amount a new reservation could take right now. */
	async available() { const t = await this.totals(); return Math.max(0, this.capUsd - t.committedUsd - t.reservedUsd); }
	async #update(change, write = true) {
		if (!this.#file) { this.#applySeed(this.#entries); this.#seed = null; return change(this.#entries); }
		const release = await this.#lock();
		try {
			const entries = await readFile(this.#file, 'utf8').then(text => JSON.parse(text).entries ?? {}, error => { if (error.code === 'ENOENT') return {}; throw error; });
			if (this.#applySeed(entries)) write = true;
			const result = change(entries);
			if (write) await this.#save(entries);
			// A failed write or rename must not consume the seed on this reusable ledger instance.
			this.#seed = null;
			return result;
		} finally { await release(); }
	}
	#applySeed(entries) {
		if (this.#seed === null) return false;
		const seed = this.#seed, existing = entries[SEED_ID];
		if (existing) {
			if (Math.abs(existing.usd - seed) > 1e-9) throw new Error(`Ledger ${this.#file ?? '(memory)'} was seeded with prior spend $${existing.usd}; omit --prior-spend-usd or pass that same value`);
		} else if (Object.keys(entries).length) throw new Error(`Ledger ${this.#file ?? '(memory)'} already has runs; a prior-spend seed can only be set when the ledger is created`);
		else entries[SEED_ID] = { state: 'settled', usd: seed, label: 'prior spend seed', seed: true, at: new Date().toISOString() };
		return !existing;
	}
	async #save(entries) {
		const temp = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
		let handle;
		try {
			handle = await open(temp, 'wx');
			await handle.writeFile(JSON.stringify({ version: 1, entries }, null, 2));
			await handle.sync();
			await handle.close(); handle = null;
			await rename(temp, this.#file);
			// POSIX needs the directory entry flushed too. Node cannot open Windows directories for fsync.
			if (process.platform !== 'win32') {
				const directory = await open(dirname(this.#file), 'r');
				try { await directory.sync(); } finally { await directory.close(); }
			}
		} finally {
			try { await handle?.close(); } finally { await rm(temp, { force: true }); }
		}
	}
	async #lock() {
		const lock = `${this.#file}.lock`, deadline = performance.now() + this.#lockTimeoutMs;
		for (;;) {
			let handle;
			try { handle = await open(lock, 'wx'); }
			catch (error) {
				if (error.code !== 'EEXIST') throw error;
				// Never reclaim by age or PID: either can mistake a live owner for a dead one.
				// An abandoned lock requires an operator to establish ownership before removing it.
				if (performance.now() >= deadline) throw new Error(`Spend ledger ${this.#file} stayed locked for ${this.#lockTimeoutMs} ms`);
				await new Promise(resolve => setTimeout(resolve, 25));
				continue;
			}
			const owner = JSON.stringify({ token: randomUUID(), pid: process.pid });
			try { await handle.writeFile(owner); } finally { await handle.close(); }
			return async () => {
				if (await readFile(lock, 'utf8') !== owner) throw new Error(`Spend ledger ${this.#file} lock ownership changed; refusing to remove it`);
				await rm(lock);
			};
		}
	}
}

const SEED_ID = '__prior_spend_seed__';
function totalsOf(entries) {
	const rows = Object.values(entries);
	return { priorSpendUsd: entries[SEED_ID]?.usd ?? 0, committedUsd: sum(rows.filter(r => r.state === 'settled').map(r => r.usd)), reservedUsd: sum(rows.filter(r => r.state === 'reserved').map(r => r.usd)),
		openReservations: rows.filter(r => r.state === 'reserved').length, settledRuns: rows.filter(r => r.state === 'settled' && !r.seed).length };
}
