/**
 * Source moments: a recorded observation and every case derived from it (a creeper moved closer, air lowered) are one
 * source group. A group gets a fixed total weight (one) and a fixed sample budget, split across its variants before
 * sampling, so authoring another variant never adds an independent situation or extra family weight.
 */

/** Stable id of the recorded moment a case comes from: trace plus recorded observation identity. */
export function sourceMomentId(testCase) {
	const source = testCase?.source ?? {};
	if (typeof source.sourceMomentId === 'string' && source.sourceMomentId) return source.sourceMomentId;
	const from = source.derived?.from;
	const trace = from?.trace ?? source.trace;
	const line = from?.line ?? source.line;
	const observation = from?.observationSha256 ?? source.observationSha256;
	if (typeof trace === 'string' && (Number.isFinite(line) || typeof observation === 'string')) return `${trace}#${Number.isFinite(line) ? line : observation}`;
	return `case:${testCase.id}`;
}

/** Variants per source group within this set of cases. */
export function sourceGroups(cases) {
	const groups = new Map();
	for (const testCase of cases) {
		const id = sourceMomentId(testCase);
		groups.set(id, [...(groups.get(id) ?? []), testCase.id]);
	}
	return groups;
}

/**
 * Samples per case: each source group gets `samples` in total, dealt across its variants in case order (the first
 * variants get the remainder). Every variant gets at least one, so a group with more variants than samples takes one
 * per variant; that is the only case where a group exceeds its budget.
 */
export function allocateSamples(cases, samples) {
	const counts = new Map();
	for (const ids of sourceGroups(cases).values()) {
		const base = Math.floor(samples / ids.length);
		const extra = samples % ids.length;
		ids.forEach((id, i) => counts.set(id, Math.max(1, base + (i < extra ? 1 : 0))));
	}
	return counts;
}

/** Weight of each case in its family and overall tests: one over its source group's size in this set. */
export function sourceWeights(cases) {
	const weights = new Map();
	for (const [source, ids] of sourceGroups(cases)) for (const id of ids) weights.set(id, { source, sourceWeight: 1 / ids.length });
	return weights;
}
