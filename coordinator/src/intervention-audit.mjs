const AUTONOMY = new Set(['autonomous', 'assisted', 'unverifiable']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Exactly one header with every field once, in this order; anything else is not an audit answer.
const HEADER = /^audit=v2 agent=([A-Za-z0-9_.-]{1,64}) agentId=([A-Za-z0-9-]{1,64}) goalRevision=(none|0|[1-9][0-9]{0,17}) goal=(none|[0-9a-f-]{36}) world=(fresh|existing|unknown) coverage=(complete|partial) interventions=(0|[1-9][0-9]{0,9}) autonomy=([a-z]+)$/;

/**
 * Strict reader for the server's `codex audit` line, bound to the measured run: the expected agent name, agent id and
 * goal revision must all match. 'autonomous' needs a fresh world, complete coverage, zero interventions and a goal.
 * Missing, malformed, duplicated, contradictory, foreign or stale answers are 'unverifiable', with the reason.
 */
export function parseInterventionAudit(text, expected = {}) {
	const unverifiable = (reason) => ({ autonomy: 'unverifiable', interventions: null, reason });
	if (typeof text !== 'string' || !text.startsWith('audit=v2 ')) return unverifiable('no audit answer');
	if (/[\r\n]/.test(text)) return unverifiable('multi-line answer');
	const [header, ...items] = text.split(' | ');
	const match = header.match(HEADER);
	if (!match) return unverifiable('malformed audit header');
	// Retained items never contain '=' (the server strips it), so an item with one is forged or corrupt.
	if (items.some((item) => item.includes('=') || item.length === 0)) return unverifiable('malformed retained item');
	const [, agent, agentId, revision, goal, world, coverage, count, autonomy] = match;
	const interventions = Number(count);
	if (!AUTONOMY.has(autonomy)) return unverifiable('unknown autonomy');
	if (goal !== 'none' && !UUID.test(goal)) return unverifiable('malformed goal');
	if ((goal === 'none') !== (revision === 'none')) return unverifiable('goal and revision disagree');
	if (typeof expected.agent !== 'string' || agent !== expected.agent) return unverifiable('audit names a different agent');
	if (typeof expected.agentId !== 'string' || agentId !== expected.agentId) return unverifiable('audit names a different agent id');
	if (!Number.isSafeInteger(expected.goalRevision) || revision !== String(expected.goalRevision)) return unverifiable('audit is not for the measured goal');
	const consistent = (coverage === 'complete') <= (world === 'fresh')
		&& (autonomy === 'autonomous' ? coverage === 'complete' && interventions === 0 && goal !== 'none'
			: autonomy === 'assisted' ? interventions > 0
				: interventions === 0 && (coverage === 'partial' || goal === 'none'));
	if (!consistent) return unverifiable('contradictory audit fields');
	return { autonomy, agent, agentId, goalRevision: Number(revision), goal, world, coverage, interventions, reason: null };
}
