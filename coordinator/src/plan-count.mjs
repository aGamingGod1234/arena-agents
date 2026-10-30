// Count mode from the plan: a fight_target or use_ranged on a mob whose drop is an open counted need of the model's
// own plan (a has:<item>*N check) runs to that count, as if the model had passed untilItem/untilCount. The model's
// own untilItem/untilCount, or single:true, keeps its call as written. Nothing starts from this; it only fills fields
// of a call the model made.

/** Mobs whose drop a player fights them for, and that drop. */
export const MOB_DROPS = Object.freeze({
	'minecraft:blaze': 'minecraft:blaze_rod',
	'minecraft:enderman': 'minecraft:ender_pearl',
});
export const PLAN_COUNT_ACTIONS = Object.freeze(new Set(['fight_target', 'use_ranged']));

/**
 * tool: a native action { actionType, arguments }. needs: the plan's open counted needs in plan order,
 * { id, have, need, step?, label? }. entities: the latest observed entities (uuid or stableId, type).
 * Returns { tool, note } when the plan's count applies, else { tool } with only `single` removed.
 */
export function planCountDefault(tool, { needs = [], entities = [] } = {}) {
	if (!PLAN_COUNT_ACTIONS.has(tool?.actionType) || tool.arguments === null || typeof tool.arguments !== 'object') return { tool };
	const { single, ...args } = tool.arguments;
	const stripped = single === undefined ? tool : { ...tool, arguments: args };
	if (single === true || args.untilItem !== undefined || args.untilCount !== undefined) return { tool: stripped };
	const target = (Array.isArray(entities) ? entities : []).find((entry) => entry && (entry.uuid ?? entry.stableId) === args.targetId);
	const drop = MOB_DROPS[target?.type];
	if (drop === undefined) return { tool: stripped };
	const need = (Array.isArray(needs) ? needs : []).find((entry) => entry?.id === drop && Number.isFinite(entry.have) && Number.isFinite(entry.need) && entry.have < entry.need);
	if (need === undefined) return { tool: stripped };
	const count = Math.min(2_304, Math.max(1, Math.trunc(need.need)));
	const step = typeof need.label === 'string' && need.label ? `"${need.label.slice(0, 60)}"` : typeof need.step === 'string' ? need.step : 'open';
	const note = `Count mode from your plan: step ${step} checks has:${drop}*${count} (held ${need.have}), so this ${tool.actionType} on ${target.type} ran as untilItem:${drop} untilCount:${count} with collect on. single:true fights one target only; your own untilItem/untilCount set the count; cancelAction stops the run.`;
	return { tool: { ...stripped, arguments: { ...args, untilItem: drop, untilCount: count } }, note };
}
