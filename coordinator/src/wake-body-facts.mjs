import { howtoHeldRecipe, howtoHoldings } from './howto.mjs';
import { TOOLS } from './plan-checks.mjs';

export const LIGHT_LINE_BYTES = 160;
export const TOOLS_LINE_BYTES = 240;
const TOOL = /^minecraft:(wooden|golden|stone|copper|iron|diamond|netherite)_(pickaxe|axe|sword|shovel)$/;

/** Coarse nominal day-cycle timing, from this sample only. Day numbers are one-based. */
export function lightLine(observation) {
	const o = observation, world = o?.world;
	if (!live(o) || o.continuity?.rememberedSections?.includes('world') || world?.dimension !== 'minecraft:overworld'
		|| !Number.isSafeInteger(world.dayTime) || world.dayTime < 0) return null;
	const tick = world.dayTime % 24_000;
	if (tick < 8_400) return null;
	const day = Math.floor(world.dayTime / 24_000) + 1;
	const phase = tick < 12_000 ? `dusk in ${minutes(12_000 - tick)}` : tick < 13_000 ? 'sunset' : tick < 23_000 ? 'night' : 'sunrise';
	const timing = tick < 13_000 ? 'night lasts ~8m' : tick < 23_000 ? `sunrise in ${minutes(23_000 - tick)}` : `daylight in ${minutes(24_000 - tick)}`;
	const exposure = o.player?.skyOpen === true ? '; sky-exposed' : o.player?.skyOpen === false ? '; sky covered' : '';
	return cap(`${phase} (day ${day}); ${timing}; mobs spawn in darkness${exposure}`, LIGHT_LINE_BYTES);
}

/** Wear of the held tool, or the best carried tool for the model's stated activity. No action is chosen here. */
export function toolsLine(observation, { activity = '' } = {}) {
	const o = observation;
	if (!live(o) || o.continuity?.rememberedSections?.includes('inventory') || !Array.isArray(o.inventory?.items)) return null;
	const tools = o.inventory.items.filter(row => row.count > 0 && TOOL.test(row.itemId));
	const best = rows => [...rows].sort((a, b) => rank(b) - rank(a) || (uses(b) ?? -1) - (uses(a) ?? -1))[0];
	const held = o.inventory.selectedSlot !== undefined ? tools.find(row => row.slot === o.inventory.selectedSlot)
		: best(tools.filter(row => row.itemId === o.inventory.selectedItem));
	const fighting = o.currentAction?.active === true && ['attack', 'fight_target'].includes(o.currentAction.actionType);
	const kind = held ? TOOL.exec(held.itemId)[2] : fighting ? 'sword' : activityKind(activity);
	if (!kind) return null;
	const tool = held ?? best(tools.filter(row => row.itemId.endsWith(`_${kind}`)));
	const remaining = uses(tool);
	if (remaining === null || !(remaining <= 25 || remaining / tool.maxDamage <= 0.2)) return null;
	const spares = tools.filter(row => row !== tool && row.itemId.endsWith(`_${kind}`));
	const count = spares.reduce((n, row) => n + row.count, 0) + tool.count - 1;
	const backup = best([...spares, ...(tool.count > 1 ? [tool] : [])]);
	const spare = count === 0 ? `no spare ${kind}` : `${count} spare ${kind}${count === 1 ? '' : 's'} held: ${backup.itemId.slice(10)} ${uses(backup) ?? '?'} uses`;
	const recipe = howtoHeldRecipe(tool.itemId, howtoHoldings({ observation: o }));
	const materials = recipe === null ? 'replacement recipe unknown' : !recipe.materialsHeld ? 'replacement materials not all held'
		: `replacement materials held: ${recipe.inputs.map(({ id, count }) => `${count} ${id}`).join(' + ')}; ${recipe.station} ${recipe.stationAvailable ? 'held/seen' : 'not held/seen'}`;
	return cap(`${tool.itemId.slice(10)} ${remaining} uses left (${spare}; ${materials})`, TOOLS_LINE_BYTES);
}

function colours(sheep) {
	const seen = [...new Set(sheep.map(e => e.appearance?.woolColor).filter(c => typeof c === 'string' && /^[a-z_]{1,16}$/.test(c)))].sort();
	return seen.length ? ` (${seen.join(', ')})` : '';
}
function live(o) { return o?.ready === true && o.player?.dead !== true && o.continuity?.phase !== 'dead'; }
function minutes(ticks) { return ticks < 1_200 ? '<1m' : `~${Math.round(ticks / 1_200)}m`; }
function uses(row) {
	if (!Number.isSafeInteger(row?.maxDamage) || row.maxDamage <= 0) return null;
	if (Number.isSafeInteger(row.usesLeft) && row.usesLeft >= 0) return row.usesLeft;
	return Number.isSafeInteger(row.damage) && row.damage >= 0 ? Math.max(0, row.maxDamage - row.damage) : null;
}
function rank(row) { return TOOLS.indexOf(TOOL.exec(row.itemId)[1]); }
function activityKind(text) {
	text = String(text ?? '').replaceAll('_', ' ');
	if (/\b(fight|attack|combat|sword)\b/i.test(text)) return 'sword';
	if (/\b(dig|shovel|dirt|sand|gravel)\b/i.test(text)) return 'shovel';
	if (/\b(chop|axe|logs?|wood|trees?)\b/i.test(text)) return 'axe';
	if (/\b(mine|mining|pickaxe|ore|ores|stone|cobblestone|tunnel)\b/i.test(text)) return 'pickaxe';
	return null;
}
function cap(text, bytes) {
	if (Buffer.byteLength(text) <= bytes) return text;
	let result = '';
	for (const char of text) { if (Buffer.byteLength(result + char) > bytes - 3) break; result += char; }
	return `${result}…`;
}

/** Current carried pick wear, including healthy picks, for a mining checkpoint across program replacements. */
export function picksLine(observation) {
	const o = observation;
	if (!live(o) || o.continuity?.rememberedSections?.includes('inventory') || !Array.isArray(o.inventory?.items)) return null;
	const picks = o.inventory.items.filter(row => row.count > 0 && TOOL.test(row.itemId) && row.itemId.endsWith('_pickaxe'));
	if (!picks.length) return 'no pickaxe held';
	if (!picks.some(row => uses(row) !== null)) return null;
	return cap(picks.map(row => `${row.itemId.slice(10)} slot ${row.slot ?? '?'}: ${uses(row) ?? '?'} uses left`).join('; '), TOOLS_LINE_BYTES);
}

/** Bed choices from this sample's inventory/sight, never a hidden monster or bed search. */
export function sleepLine(o) {
	if (!live(o) || o.continuity?.rememberedSections?.includes('world')) return null;
	const dimension = o.world?.dimension, rules = o.world?.sleep;
	const tick = Number.isSafeInteger(o.world?.dayTime) ? o.world.dayTime % 24_000 : null;
	const fresh = section => !o.continuity?.rememberedSections?.includes(section);
	const items = fresh('inventory') ? o.inventory?.items : null;
	const beds = (items ?? []).filter(i => i.count > 0 && /^minecraft:\w+_bed$/.test(i.itemId));
	const explosive = rules?.bedExplodes === true || ['minecraft:the_nether', 'minecraft:the_end'].includes(dimension);
	if (explosive) return beds.length ? 'beds explode here; cannot sleep or set bed spawn' : null;
	if (dimension !== 'minecraft:overworld' && !rules) return null;
	if (tick !== null && tick < 8_400 && !o.world?.thundering) return null;
	const blocks = fresh('blocks') ? (o.blocks ?? []) : [];
	const bed = blocks.find(b => /^minecraft:\w+_bed$/.test(b.blockId));
	const held = beds.map(i => `${i.count} ${i.itemId.slice(10)}`).join(', ');
	const wool = new Map();
	for (const i of items ?? []) if (i.count > 0 && /^minecraft:\w+_wool$/.test(i.itemId)) wool.set(i.itemId, (wool.get(i.itemId) ?? 0) + i.count);
	const bestWool = [...wool].sort((a,b) => b[1]-a[1])[0];
	const planks = (items ?? []).filter(i => /^minecraft:\w+_planks$/.test(i.itemId)).reduce((n,i) => n+i.count,0);
	const table = (items ?? []).some(i => i.itemId === 'minecraft:crafting_table' && i.count > 0) || blocks.some(b => b.blockId === 'minecraft:crafting_table');
	const sheep = fresh('entities') ? (o.entities ?? []).filter(e => e.type === 'minecraft:sheep' && e.alive !== false) : [];
	const sheepFact = sheep.length ? `; sheep seen ${sheep.length}${Number.isFinite(sheep[0].distance) ? ` (nearest ~${Math.round(Math.min(...sheep.map(e => e.distance ?? Infinity)))}m)` : ''}` : '';
	const availability = `${items ? held || 'no bed held' : 'bed inventory unknown'}${bed ? `; bed seen ${bed.x},${bed.y},${bed.z}${bed.state?.occupied === 'true' ? ' occupied' : ''}` : ''}`;
	const materials = held || bed ? '' : `; wool ${bestWool ? `${bestWool[1]}/3 ${bestWool[0].slice(10)}` : items ? '0/3' : 'unknown'}, planks ${items ? `${planks}/3` : 'unknown'}; table ${table ? 'held/seen' : 'not held/seen'}${sheepFact}`;
	const timeAllows = rules?.timeAllowsSleep ?? (tick === null ? null : o.world?.thundering === true || tick >= 12_542 && tick < 23_460);
	const timing = timeAllows === true ? 'sleep time open' : timeAllows === false ? 'sleep time closed' : 'sleep time unknown';
	return cap(`${availability}${materials}; ${timing}; monster safety unverified: bed use reports blockers; use sets spawn (by day too), sleep skips night`, 480);
}


/**
 * By day, where the next death respawns and the bed that would move it here: a held bed, one craftable from held wool
 * and planks, or the sheep in view. Sol never set a bed in 10 random-seed games (3 held one), so every death sent it to
 * the world spawn with nothing. Overworld only; null once a set respawn is known or nothing bed-related is at hand.
 */
export function spawnLine(o, spawn = null) {
	if (!live(o) || o.world?.dimension !== 'minecraft:overworld' || spawn?.kind === 'set'
		|| ['inventory', 'world'].some(section => o.continuity?.rememberedSections?.includes(section)) || !Array.isArray(o.inventory?.items)) return null;
	const items = o.inventory.items.filter(i => i.count > 0);
	const now = spawn?.kind === 'world' ? 'respawn: world spawn' : 'respawn: no bed use seen yet';
	const use = 'placed and used (by day too: "Respawn point set"; sleep only at night) moves your respawn beside it, so a death costs a short walk back to the dropped items';
	const beds = items.filter(i => /^minecraft:\w+_bed$/.test(i.itemId));
	if (beds.length) return cap(`${now}; ${beds[0].itemId.slice(10)} held: ${use}`, 480);
	const blocks = o.continuity?.rememberedSections?.includes('blocks') ? [] : Array.isArray(o.blocks) ? o.blocks : [];
	const seen = blocks.find(b => /^minecraft:\w+_bed$/.test(b.blockId));
	if (seen) return cap(`${now}; bed seen ${seen.x},${seen.y},${seen.z}: using it ${use.replace(/^placed and used /, '')}`, 480);
	const wool = new Map();
	for (const i of items) if (/^minecraft:\w+_wool$/.test(i.itemId)) wool.set(i.itemId, (wool.get(i.itemId) ?? 0) + i.count);
	const best = [...wool].sort((a, b) => b[1] - a[1])[0];
	const planks = items.filter(i => /^minecraft:\w+_planks$/.test(i.itemId)).reduce((n, i) => n + i.count, 0);
	const table = items.some(i => i.itemId === 'minecraft:crafting_table') || blocks.some(b => b.blockId === 'minecraft:crafting_table');
	const sheep = o.continuity?.rememberedSections?.includes('entities') ? [] : (o.entities ?? []).filter(e => e.type === 'minecraft:sheep' && e.alive !== false);
	if (!best && !sheep.length) return null;
	const recipe = `a bed = 3 wool of one colour + 3 planks at a crafting table; ${use}`;
	// No count or distance: they change every sample and would re-send the line on every wake.
	const held = `wool ${best ? `${best[1]} ${best[0].slice(10)}` : 0}/3, planks ${planks}/3, table ${table ? 'held/seen' : 'not held/seen'}${sheep.length ? `; sheep in view${colours(sheep)}: shears or a kill give wool` : ''}`;
	return cap(`${now}; ${held}; ${recipe}`, 480);
}

export const CASTING_LINE_BYTES = 640;

/** Vanilla casting knowledge, gated by the current goal and observed resources; never a build plan or hidden search. */
export function castingLine(o, { goal = '' } = {}) {
	if (!live(o) || o.world?.dimension !== 'minecraft:overworld'
		|| ['world', 'inventory', 'blocks'].some(section => o.continuity?.rememberedSections?.includes(section))
		|| !Array.isArray(o.inventory?.items)) return null;
	if (!/\b(nether|portal|obsidian|blaze|fortress|bastion|dragon|beat the game)\b/i.test(goal)) return null;
	const count = id => o.inventory.items.filter(i => i.itemId === `minecraft:${id}` && i.count > 0).reduce((n, i) => n + i.count, 0);
	if (count('obsidian') > 0) return null;
	const blocks = (o.blocks ?? []).filter(b => b.visible !== false);
	const source = id => blocks.some(b => b.blockId === `minecraft:${id}` && String(b.state?.level) === '0');
	if (!source('lava')) return null;
	const water = count('water_bucket') > 0;
	const recipe = howtoHeldRecipe('minecraft:bucket', howtoHoldings({ observation: o }));
	if (!water && !(source('water') && (count('bucket') > 0 || recipe?.materialsHeld))) return null;
	return 'Casting: a lava SOURCE turns to obsidian the instant water (source or flowing) touches it from a side or above, as it is poured or when water arrives; water only below does nothing; flowing lava makes cobblestone. Unconverted lava spreads after ~1.5s; before then an empty bucket scoops it back. Frame 4 wide x 5 high, 2x3 clear inside; corners optional = 10 obsidian. Cast in place: mining obsidian needs diamond+. One bucket: leave the cooling water placed and ferry lava; refilling from that water removes it. Cast beside the supply pool; keep water off the pool and footing. Obsidian may sit on lava: mine it from beside, not on it.';
}

export const FRAME_LINE_BYTES = 560;

/** The seen portal frame nearest completion (sighted.portalFrames), read back as cells; never a build order. */
export function frameLine(o) {
	if (!live(o) || ['blocks', 'sighted'].some(section => o.continuity?.rememberedSections?.includes(section))) return null;
	const f = Array.isArray(o.sighted?.portalFrames) ? o.sighted.portalFrames[0] : null;
	if (!f || !Array.isArray(f.interior) || !Array.isArray(f.missing) || !Array.isArray(f.blocked)) return null;
	const [w, h] = f.interior, alongX = f.axis === 'x';
	const span = alongX ? `x${f.x}..${f.x + w - 1} y${f.y}..${f.y + h - 1} z${f.z}` : `x${f.x} y${f.y}..${f.y + h - 1} z${f.z}..${f.z + w - 1}`;
	const cells = rows => rows.map(([x, y, z, seen]) => `${x},${y},${z} ${seen}`).join('; ');
	const state = f.lit ? 'lit' : f.missing.length === 0 && f.blocked.length === 0 && !f.unseenInterior ? 'complete, interior clear: fire inside lights it' : null;
	const parts = [`seen frame, interior ${w}x${h} at ${span}: obsidian ${f.obsidian}/${f.needed}`];
	if (state) parts.push(state);
	if (f.missing.length) parts.push(`missing ${cells(f.missing)}`);
	if (f.blocked.length) parts.push(`interior blocked ${cells(f.blocked)}`);
	if (f.unseenInterior) parts.push(`${f.unseenInterior} interior cells unseen`);
	return cap(parts.join('; '), FRAME_LINE_BYTES);
}
