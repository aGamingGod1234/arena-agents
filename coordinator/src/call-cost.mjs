// Claude proxy matches the existing interrupted-call estimate, fitted to reported CLI costs.
// These proxies are comparison weights, not a subscription invoice or current list prices.
export const TOKEN_PRICES_PER_MILLION = Object.freeze({
	'claude:claude-opus-5-5': Object.freeze({ input: 2, cacheRead: .2, cacheWrite: 8, output: 20, tierMultiplier: 1 }),
	'claude:claude-sonnet-5-5': Object.freeze({ input: 2, cacheRead: .2, cacheWrite: 8, output: 20, tierMultiplier: 1 }),
	'claude:claude-fable-5-1': Object.freeze({ input: 2, cacheRead: .2, cacheWrite: 8, output: 20, tierMultiplier: 1 }),
	'codex:gpt-6.1-sol': Object.freeze({ input: 2, cacheRead: .1, cacheWrite: 2.5, output: 10, tierMultiplier: 2 }),
	// gpt-6-sol: no separate proxy yet; weighted like gpt-6.1-sol so spend caps stay conservative.
	'codex:gpt-6-sol': Object.freeze({ input: 2, cacheRead: .1, cacheWrite: 2.5, output: 10, tierMultiplier: 2 }),
	'codex:gpt-6-luna': Object.freeze({ input: .1, cacheRead: .01, cacheWrite: .125, output: .5, tierMultiplier: 2 }),
	// OpenCode's free tier: no charge per token.
	'opencode:opencode/deepseek-v4.1-flash-free': Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, tierMultiplier: 1 }),
	'opencode:opencode/glm-5.3-flash-free': Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, tierMultiplier: 1 }),
	// OpenCode Go (flat subscription): its models.dev per-token prices, so a Go run records what its calls are worth.
	'opencode:opencode-go/deepseek-v4.1-flash': Object.freeze({ input: .15, cacheRead: .003, cacheWrite: 0, output: .6, tierMultiplier: 1 }),
});

export function estimateTokenCostUsd(tokens, profile) {
	const prices = TOKEN_PRICES_PER_MILLION[`${profile?.provider}:${profile?.model}`];
	if (!prices || !tokens || !['input', 'cacheRead', 'cacheWrite', 'output'].every(k => Number.isFinite(tokens[k]) && tokens[k] >= 0)) return null;
	const multiplier = profile.provider === 'codex' && ['fast','priority'].includes(profile.serviceTier) ? prices.tierMultiplier : 1;
	return ['input', 'cacheRead', 'cacheWrite', 'output'].reduce((cost, k) => cost + tokens[k] * prices[k], 0) * multiplier / 1_000_000;
}

// Prices learned at runtime from provider discovery: free models (every price zero) and, for a free model, the list
// price of its paid twin. Static entries above win; a model in neither has no known price.
const DISCOVERED_PRICES = new Map();

export function registerDiscoveredPrice(provider, model, { free = false, listPrice = null } = {}) {
	if (typeof provider !== 'string' || typeof model !== 'string') return;
	const list = listPrice !== null && ['input', 'cacheRead', 'cacheWrite', 'output'].every((key) => Number.isFinite(listPrice[key]) && listPrice[key] >= 0)
		? Object.freeze({ ...listPrice, tierMultiplier: 1 }) : null;
	DISCOVERED_PRICES.set(`${provider}:${model}`, Object.freeze({ free: free === true, listPrice: list }));
}

/**
 * Dollar figures for one model call. costUsd is what the account pays at proxy prices (0 for free models, null when
 * no price is known); listCostUsd is what a free model's call would cost at its paid twin's list price, when known.
 */
export function callCostUsd(tokens, profile) {
	const key = `${profile?.provider}:${profile?.model}`;
	const discovered = DISCOVERED_PRICES.get(key) ?? null;
	const known = TOKEN_PRICES_PER_MILLION[key];
	const free = discovered?.free === true || (known !== undefined && ['input', 'cacheRead', 'cacheWrite', 'output'].every((k) => known[k] === 0));
	const costUsd = known !== undefined ? estimateTokenCostUsd(tokens, profile) : free ? 0 : null;
	let listCostUsd = null;
	if (free && discovered?.listPrice) {
		listCostUsd = ['input', 'cacheRead', 'cacheWrite', 'output'].reduce((sum, k) => sum + (Number.isFinite(tokens?.[k]) ? tokens[k] : 0) * discovered.listPrice[k], 0) / 1_000_000;
	}
	return { costUsd, listCostUsd, free };
}
