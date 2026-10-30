/**
 * Token price proxies for decision-eval cost tracking, shared by the runner (play model calls) and the judge.
 *
 * Source: coordinator/src/token-cost.mjs on branch claude/q4-suite (commit a9f30846), read, not merged. The Claude rows
 * equal the production proxy CALL_PRICE_USD in claude-service.mjs (fitted to the costs Claude Code reports; a test keeps
 * them equal). These are comparison weights, not an invoice or current list prices. Codex priority/fast service tiers
 * bill at tierMultiplier times the base rate.
 */
export const TOKEN_PRICES_PER_MILLION = Object.freeze({
	'claude:claude-opus-5-5': Object.freeze({ input: 2, cacheRead: 0.2, cacheWrite: 8, output: 20, tierMultiplier: 1 }),
	'claude:claude-sonnet-5-5': Object.freeze({ input: 2, cacheRead: 0.2, cacheWrite: 8, output: 20, tierMultiplier: 1 }),
	'claude:claude-fable-5-1': Object.freeze({ input: 2, cacheRead: 0.2, cacheWrite: 8, output: 20, tierMultiplier: 1 }),
	'codex:gpt-6.1-sol': Object.freeze({ input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10, tierMultiplier: 2 }),
	'codex:gpt-6-sol': Object.freeze({ input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10, tierMultiplier: 2 }),
	'codex:gpt-6-luna': Object.freeze({ input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5, tierMultiplier: 2 }),
	'opencode:opencode/deepseek-v4.1-flash-free': Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, tierMultiplier: 1 }),
	'opencode:opencode/glm-5.3-flash-free': Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, tierMultiplier: 1 }),
	// OpenCode Go is a subscription with usage limits; these are the models.dev list prices of its models (2026-10-23), so a
	// report shows how much of the Go allowance a suite used, in list-price dollars.
	'opencode:opencode-go/deepseek-v4.1-flash': Object.freeze({ input: 0.15, cacheRead: 0.003, cacheWrite: 0.15, output: 0.6, tierMultiplier: 1 }),
	'opencode:opencode-go/glm-5.3-flash': Object.freeze({ input: 0.15, cacheRead: 0.03, cacheWrite: 0.15, output: 0.5, tierMultiplier: 1 }),
});

const TOKEN_KEYS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output']);

/**
 * USD proxy for one call or a sum of calls. `tokens.input` is UNCACHED input only; cacheRead and cacheWrite are the
 * cached parts. Returns null for an unknown model or incomplete counts, so callers can report the cost as unknown.
 */
export function estimateTokenCostUsd(tokens, { provider, model, serviceTier = 'default' } = {}) {
	const prices = TOKEN_PRICES_PER_MILLION[`${provider}:${model}`];
	if (!prices || !tokens || !TOKEN_KEYS.every((key) => Number.isFinite(tokens[key]) && tokens[key] >= 0)) return null;
	const multiplier = provider === 'codex' && ['fast', 'priority'].includes(serviceTier) ? prices.tierMultiplier : 1;
	return TOKEN_KEYS.reduce((cost, key) => cost + tokens[key] * prices[key], 0) * multiplier / 1_000_000;
}

/** Codex reports total input including cached input, and no cache writes. */
export function codexTokens({ inputTokens, cachedInputTokens = 0, outputTokens }) {
	if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
	const cacheRead = Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0;
	return { input: Math.max(0, inputTokens - cacheRead), cacheRead, cacheWrite: 0, output: outputTokens };
}
