import { defaultServiceTier } from './constants.mjs';
import { PROVIDER_REGISTRY } from './provider-registry.mjs';

const ENTRIES = Object.values(PROVIDER_REGISTRY);
export const PROVIDER_IDS = Object.freeze(ENTRIES.map((entry) => entry.id));
/** Providers whose agents drive Minecraft through the native tool loop rather than ArenaScript plans. */
export const NATIVE_TOOL_PROVIDERS = Object.freeze(ENTRIES.filter((entry) => entry.nativeTools).map((entry) => entry.id));
/** Providers that see a steer only at the next tool boundary (Codex can take one mid-call). */
export const TOOL_BOUNDARY_STEER_PROVIDERS = Object.freeze(ENTRIES.filter((entry) => entry.toolBoundarySteer).map((entry) => entry.id));

const PROVIDER_SET = new Set(PROVIDER_IDS);
const FAST_TIER_PROVIDERS = new Set(ENTRIES.filter((entry) => entry.speedTiers).map((entry) => entry.id));

export function createExecutionSettings(profile, { transport, controlProtocol, effective = {}, evidence = {}, limitations = [], modelSelector = null }) {
	return {
		requested: { provider: profile.provider ?? 'codex', model: profile.model, reasoningEffort: profile.reasoningEffort, serviceTier: profile.serviceTier ?? defaultServiceTier(profile.provider) },
		effective: { provider: profile.provider ?? 'codex', model: null, reasoningEffort: null, serviceTier: null, thinkingMode: null, ...effective },
		transport,
		controlProtocol,
		modelSelector,
		evidence: { model: 'unreported', reasoningEffort: 'unreported', serviceTier: 'unreported', ...evidence },
		limitations: [...limitations],
	};
}

export function normalizeProviderId(value, field = 'provider', { ErrorType = TypeError, code = null } = {}) {
	if (typeof value !== 'string' || value.trim() === '') throw providerError(ErrorType, code, `${field} must be nonblank`);
	const provider = value.toLowerCase();
	if (!PROVIDER_SET.has(provider)) {
		throw providerError(ErrorType, code, `${field} must be one of ${PROVIDER_IDS.join(', ')}`);
	}
	return provider;
}

export function assertProviderServiceTier(providerValue, serviceTier, field = 'serviceTier', options = {}) {
	const provider = normalizeProviderId(providerValue, 'provider', options);
	if (!['default', 'priority', 'fast'].includes(serviceTier)) {
		throw providerError(options.ErrorType ?? TypeError, options.code ?? null, `${field} must be default, priority or fast`);
	}
	if (serviceTier !== 'priority' && !FAST_TIER_PROVIDERS.has(provider)) {
		throw providerError(options.ErrorType ?? TypeError, options.code ?? null, `${field} ${serviceTier} is available only for ${[...FAST_TIER_PROVIDERS].join(', ')}`);
	}
	return serviceTier;
}

function providerError(ErrorType, code, message) {
	if (code !== null) return new ErrorType(code, message);
	return new ErrorType(message);
}
