// A held tool breaking is something a player sees and hears (the break sound and particles, the hand going empty). The
// observation has no break event, so it is read from two consecutive inventories: a damageable stack in a hand at its last
// uses is gone from that hand, and from the inventory, while the selected hotbar slot stayed the same. The facts name what
// broke and the tools of the same kind still held; they never choose one.

/** One mining block or hit costs one or two uses, and a result is published after every action. */
const LAST_USES = 3;
const MAX_SAME_KIND = 4;

const TOOL_KIND = /_(pickaxe|axe|shovel|hoe|sword)$/;

function rows(inventory) {
	return Array.isArray(inventory?.items) ? inventory.items.filter((row) => typeof row?.itemId === 'string') : [];
}

function usesLeft(row) {
	return Number.isSafeInteger(row?.maxDamage) && row.maxDamage > 0 && Number.isSafeInteger(row.damage) ? Math.max(0, row.maxDamage - row.damage) : null;
}

function count(items, itemId) {
	return items.reduce((sum, row) => sum + (row.itemId === itemId ? Math.max(1, row.count ?? 1) : 0), 0);
}

function sameKind(brokenId, itemId) {
	const kind = TOOL_KIND.exec(brokenId)?.[1];
	return kind === undefined ? itemId === brokenId : TOOL_KIND.exec(itemId)?.[1] === kind;
}

/**
 * The held tool that broke between two inventories, or null. hand is "mainhand" or "offhand"; slot is the selected hotbar
 * slot for the main hand; sameKind lists the remaining tools of that kind (all pickaxes for a pickaxe) with their uses left.
 */
export function heldToolBreak(before, after) {
	const beforeRows = rows(before), afterRows = rows(after);
	if (beforeRows.length === 0 || after === null || typeof after !== 'object') return null;
	for (const hand of ['mainhand', 'offhand']) {
		const held = beforeRows.find((row) => row.slot === hand);
		const left = usesLeft(held);
		if (left === null || left > LAST_USES) continue;
		// Switching the hotbar slot moves the tool out of the hand without breaking it.
		if (hand === 'mainhand' && Number.isSafeInteger(before.selectedSlot) && Number.isSafeInteger(after.selectedSlot) && before.selectedSlot !== after.selectedSlot) continue;
		if (afterRows.some((row) => row.slot === hand && row.itemId === held.itemId)) continue;
		if (count(afterRows, held.itemId) >= count(beforeRows, held.itemId)) continue;
		const spares = afterRows.filter((row) => row.slot !== hand && sameKind(held.itemId, row.itemId))
			.map((row) => ({ itemId: row.itemId, slot: row.slot, ...(usesLeft(row) === null ? {} : { usesLeft: usesLeft(row) }) }))
			.sort((a, b) => (b.usesLeft ?? 0) - (a.usesLeft ?? 0));
		return {
			itemId: held.itemId,
			hand,
			...(hand === 'mainhand' && Number.isSafeInteger(after.selectedSlot) ? { slot: after.selectedSlot } : {}),
			sameKind: spares.slice(0, MAX_SAME_KIND),
			...(spares.length > MAX_SAME_KIND ? { omittedSameKind: spares.length - MAX_SAME_KIND } : {}),
		};
	}
	return null;
}
