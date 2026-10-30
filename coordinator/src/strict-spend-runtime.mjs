export const STRICT_SPEND_RUNTIME_VERSION = 1;

export function strictSpendRuntime(environment = process.env) {
	if (environment.ARENA_STRICT_SPEND_GATE !== '1') return false;
	let url;
	try { url = new URL(environment.ANTHROPIC_BASE_URL); } catch { /* rejected below */ }
	if (!url || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
			|| !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
		throw Object.assign(new Error('Strict spend requires an explicit loopback ANTHROPIC_BASE_URL gateway'), { code: 'STRICT_SPEND_GATE_REQUIRED' });
	}
	return true;
}
