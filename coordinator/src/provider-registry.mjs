/**
 * The one list of provider adapters. Every provider id, label, colour, limit kind and capability flag elsewhere
 * (identity checks, CLI probes, discovery, usage limits, the catalog sent to Minecraft) is derived from here,
 * so adding a provider means adding one entry. This module imports nothing so any module can read it.
 *
 * limitKind says what kind of allowance the account has:
 * - plan_percent: a subscription window reported as a used percentage (Codex rateLimits, Claude rate_limit_event)
 * - credits: a spendable balance (API credits)
 * - requests: request-rate limited with no published budget (OpenCode free tier); only 429s are observable
 * - unknown: the CLI exposes nothing about its allowance
 */
export const PROVIDER_REGISTRY = Object.freeze({
	codex: Object.freeze({
		id: 'codex',
		label: 'Codex',
		cliLabel: 'Codex CLI',
		color: 0x55ffff,
		limitKind: 'plan_percent',
		nativeTools: true,
		toolBoundarySteer: false,
		// Codex is the only provider with selectable speed tiers; others run at their one normal speed.
		speedTiers: true,
		defaultServiceTier: 'default',
	}),
	gemini: Object.freeze({
		id: 'gemini',
		label: 'Antigravity',
		cliLabel: 'Antigravity CLI',
		color: 0xff55ff,
		limitKind: 'unknown',
		nativeTools: false,
		toolBoundarySteer: false,
		speedTiers: false,
		defaultServiceTier: 'priority',
	}),
	claude: Object.freeze({
		id: 'claude',
		label: 'Claude',
		cliLabel: 'Claude Code',
		color: 0xffaa00,
		limitKind: 'plan_percent',
		nativeTools: true,
		toolBoundarySteer: true,
		speedTiers: false,
		defaultServiceTier: 'priority',
	}),
	opencode: Object.freeze({
		id: 'opencode',
		label: 'OpenCode',
		cliLabel: 'OpenCode',
		color: 0x55ffaa,
		limitKind: 'requests',
		nativeTools: true,
		toolBoundarySteer: true,
		speedTiers: false,
		defaultServiceTier: 'priority',
	}),
});

export const LIMIT_KINDS = Object.freeze(['plan_percent', 'credits', 'requests', 'unknown']);

export function providerEntry(provider) {
	return Object.hasOwn(PROVIDER_REGISTRY, provider) ? PROVIDER_REGISTRY[provider] : null;
}
