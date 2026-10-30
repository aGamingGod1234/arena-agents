// The working intent each wake shows: one model-authored commitment (taskPlan intent) plus the facts
// that support or contradict it. It is the single owner of "next": plan progress and other references
// point at intent.step instead of naming their own. Facts annotate validity; they never pick a replacement.

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
// A cancellation is the model's or the lifecycle's choice, not a failed attempt.
const FAILED = new Set(['FAILED', 'TIMED_OUT']);
const RESULT_HISTORY = 8;
const CHAIN_LIMIT = 4;
export const INTENT_FIELDS = { step: 48, why: 100, via: 100, until: 100, unless: 100, next: 100 };

/** Validates model-authored intent. `step` is a plan step ID, or the model's own short label. */
export function validateIntent(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('intent must be an object');
	if (Object.keys(value).some((key) => !Object.hasOwn(INTENT_FIELDS, key))) throw new TypeError(`intent fields: ${Object.keys(INTENT_FIELDS).join(', ')}`);
	const result = {};
	for (const [key, max] of Object.entries(INTENT_FIELDS)) {
		const text = value[key];
		if (text === undefined && !['step', 'why'].includes(key)) continue;
		if (typeof text !== 'string' || text.trim().length === 0 || text.length > max || /[\x00-\x1f\x7f]/.test(text)) throw new TypeError(`intent.${key} must be one line of text up to ${max} characters`);
		result[key] = text.trim();
	}
	return result;
}

/** Remembers the last few terminal results seen in observations (lastResult), oldest first. */
export function rememberResult(history, lastResult) {
	if (lastResult?.present === false || typeof lastResult?.actionId !== 'string' || !TERMINAL.has(lastResult.state)) return false;
	if (history.some((row) => row.actionId === lastResult.actionId)) return false;
	history.push({ actionId: lastResult.actionId, actionType: String(lastResult.actionType ?? 'action'), state: lastResult.state,
		reasonCode: String(lastResult.reasonCode ?? ''), ...(typeof lastResult.message === 'string' ? { message: lastResult.message } : {}) });
	if (history.length > RESULT_HISTORY) history.splice(0, history.length - RESULT_HISTORY);
	return true;
}

/**
 * The latest failure not followed by a success of the same action type, with how often it recurred. A newer action
 * of that type still running is stated: the failure has already been answered and its outcome is not known yet.
 */
export function unresolvedFailure(results, running = null) {
	for (let index = results.length - 1; index >= 0; index--) {
		const row = results[index];
		if (!FAILED.has(row.state) || results.slice(index + 1).some((later) => later.state === 'SUCCEEDED' && later.actionType === row.actionType)) continue;
		// One body action runs at a time, so an active action of the same type that is not among the finished results
		// started after this failure ended.
		const retrying = running?.active === true && running.actionType === row.actionType && !results.some((done) => done.actionId === running.actionId);
		const same = results.filter((other) => FAILED.has(other.state) && other.actionType === row.actionType && other.reasonCode === row.reasonCode).length;
		return { ...row, text: `${row.actionType} ${row.reasonCode}${same > 1 ? ` (${same} of last ${results.length})` : ''}${row.message ? `: ${failureDetail(row)}` : ''}${retrying ? `; newer ${row.actionType} running` : ''}` };
	}
	return null;
}

function failureDetail(row) {
	if (row.actionType === 'place_block' && row.message.includes('repair=')) {
		const cause = row.message.match(/cause=[^;]+/)?.[0];
		const repair = row.message.match(/repair=[^;]+/)?.[0];
		return clip([cause, repair].filter(Boolean).join('; '), 300);
	}
	// Navigation appends the actionable geometry after its generic retry explanation. Keep that evidence across
	// context rotation instead of spending the whole summary on "observe or choose another route".
	if (['navigate_to', 'move_to'].includes(row.actionType)) {
		const obstruction = row.message.match(/Seen obstruction: [^;]+/i)?.[0];
		const support = row.message.match(/(?:nearest seen standing cell: [^)]*\)|no seen standing cell[^;]*)/i)?.[0];
		const footing = row.message.match(/footing \{[^}]+\}/)?.[0];
		if (obstruction || footing) return clip([obstruction, support, footing].filter(Boolean).join('; '), 300);
	}
	return clip(row.message, 120);
}

/** Item count changes between two live inventories, largest first: "+3 oak_log, -1 stick". */
export function inventoryEffect(before, after) {
	const totals = (items) => {
		const map = new Map();
		for (const row of items ?? []) if (typeof row?.itemId === 'string' && Number.isFinite(row.count)) map.set(row.itemId, (map.get(row.itemId) ?? 0) + row.count);
		return map;
	};
	const a = totals(before), b = totals(after);
	const changes = [...new Set([...a.keys(), ...b.keys()])].map((id) => [id, (b.get(id) ?? 0) - (a.get(id) ?? 0)]).filter(([, delta]) => delta !== 0)
		.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]) || x[0].localeCompare(y[0]));
	if (changes.length === 0) return null;
	return `${changes.slice(0, 4).map(([id, delta]) => `${delta > 0 ? '+' : ''}${delta} ${shortId(id)}`).join(', ')}${changes.length > 4 ? ` +${changes.length - 4} more` : ''}`;
}

/** Steps that depend on `id`, followed upward: the plan's own reason a step exists. */
export function dependentChain(plan, id) {
	const steps = plan?.steps ?? [];
	const chain = [];
	let current = id;
	while (chain.length < CHAIN_LIMIT) {
		const parent = steps.find((step) => step.dependsOn.includes(current) && step.status !== 'complete' && !chain.includes(step.id) && step.id !== id);
		if (!parent) break;
		chain.push(parent.id);
		current = parent.id;
	}
	return chain;
}

/**
 * `since` has the shape of a fact lifecycle's since(mark): { deaths, dimension?: { from, to }, restarted? },
 * measured from when the intent was written. Slots for parallel work: `orders` is a standing-orders summary
 * ({ active: [ids], lastFired: text }) shown as-is; `annotate(intent, { contradicted, since, evidence })` lets a
 * shared provenance layer word validity. Neither may choose a replacement intent.
 */
export function composeContinuityHeader({ goal, intent = null, evidence = null, since = null, progress = null, stepProgress = null, repeats = null, hunt = null, options = null, craft = null, known = null, mining = null, light = null, sleep = null, casting = null, frame = null, tools = null, results = [], running = null, effect = null, orders = null, guardInstalled = undefined, guardCoverage = null, guardThreatsNear = 0, guardThreatsTargeting = 0, annotate = null }) {
	// The event's own goal field carries the goal; the header starts at the intent.
	if (typeof goal !== 'string' || goal.length === 0) return null;
	const header = {};
	if (guardInstalled === false) header.guard = 'none installed' + (guardThreatsNear ? `; threats near: ${Number(guardThreatsNear)}${guardThreatsTargeting ? `, ${guardThreatsTargeting} targeting you` : ''}` : '');
	else if (typeof guardCoverage === 'string' && guardCoverage.length) header.guard = guardCoverage;
	if (intent !== null) {
		const chain = evidence?.chain ?? [];
		header.intent = [`${intent.step}${chain.length ? ` for ${chain.join(' for ')}` : ''}: ${intent.why}`,
			...(intent.via ? [`via ${intent.via}`] : []), ...(intent.until ? [`until ${intent.until}`] : []), ...(intent.unless ? [`unless ${intent.unless}`] : [])].join('; ');
		if (intent.next) header.next = intent.next;
		// Only the plan's evidence contradicts: a satisfied step, a removed step, or a loss the checks confirmed.
		const contradicted = [];
		if (evidence?.inPlan === false && intent.inPlan === true) contradicted.push(`${intent.step} left the plan`);
		if (evidence?.status === 'complete') contradicted.push(`${intent.step} is complete`);
		if (evidence?.lost?.length) contradicted.push(`lost: ${evidence.lost.join(', ')}`);
		const local = contradicted.length ? `contradicted: ${contradicted.join('; ')}`
			: evidence?.inPlan && evidence.known ? 'supported' : 'unchecked';
		header.valid = typeof annotate === 'function' ? annotate(intent, { contradicted, since, evidence }) ?? local : local;
		// Observed changes since the intent was written: facts, not verdicts.
		const changes = [];
		const died = since?.deaths ?? 0;
		if (died > 0) changes.push(`died${died > 1 ? ` ${died}x` : ''}${evidence?.kept?.length ? `; still built: ${evidence.kept.join(', ')}` : ''}`);
		if (since?.dimension?.from && since.dimension.to) changes.push(`was in ${shortId(since.dimension.from)}, now ${shortId(since.dimension.to)}`);
		if (since?.restarted) changes.push('coordinator restarted');
		if (changes.length) header.since = changes.join('; ');
	}
	if (orders !== null && Array.isArray(orders.active) && orders.active.length) header.orders = `${orders.active.join(', ')}${orders.lastFired ? `; last fired ${orders.lastFired}` : ''}`;
	if (effect !== null) header.effect = effect;
	const failure = unresolvedFailure(results, running);
	if (failure !== null) header.failure = failure.text;
	if (typeof progress === 'string' && progress.length) header.plan = progress;
	// Whether the plan is moving, and a result that keeps repeating: facts beside the plan line, never a verdict.
	if (typeof stepProgress === 'string' && stepProgress.length) header.progress = stepProgress;
	if (typeof repeats === 'string' && repeats.length) header.repeats = repeats;
	// A near enderman (within walking height, no path check) while pearls are open, beside the plan line: a fact to weigh against travel, never an order.
	if (typeof hunt === 'string' && hunt.length) header.hunt = hunt;
	if (typeof craft === 'string' && craft.length) header.craft = craft;
	// Ways to get what the first unfinished step lacks, beside the plan line that names that step.
	if (typeof options === 'string' && options.length) header.options = options;
	// Remembered sources and the recent mining yield stand whether or not a plan exists.
	if (typeof known === 'string' && known.length) header.known = known;
	if (typeof mining === 'string' && mining.length) header.mining = mining;
	if (typeof light === 'string' && light.length) header.light = light;
	if (typeof casting === 'string' && casting.length) header.casting = casting;
	if (typeof frame === 'string' && frame.length) header.frame = frame;
	if (typeof sleep === 'string' && sleep.length) header.sleep = sleep;
	if (typeof tools === 'string' && tools.length) header.tools = tools;
	return Object.keys(header).length === 0 ? null : header;
}

function clip(text, max) { return text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`; }
function shortId(id) { return String(id).replace(/^minecraft:/, ''); }
