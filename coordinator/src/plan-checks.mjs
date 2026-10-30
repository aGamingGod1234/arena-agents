import { codePointLength } from './text-length.mjs';
export { blockContradictionEvidence, observedBlocks } from './seen-resource-facts.mjs';
import { deadSample } from './fact-provenance.mjs';
import { boundPlacements, functionalPlacement, placementsForItems, relevantPlacement } from './plan-placement-memory.mjs';

const ID = '[a-z0-9_.-]+:[a-z0-9_./-]+';
export const ARMOR = ['leather', 'copper', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
export const TOOLS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];
const ARMOR_SLOTS = new Set(['head', 'chest', 'legs', 'feet']);
const count = rows => rows.reduce((sum, row) => sum + row.count, 0);
const short = id => id.replace(/^(#?)minecraft:/, '$1');
// Where the player is or what it saw; spawn, respawn or a chance sighting can make these true without earlier steps.
const PRESENCE = new Set(['in', 'visited', 'seen', 'y', 'lava', 'near']);
// Remembered lava pools and portal frames per world, newest kept.
const MAX_REMEMBERED = 16, MAX_POOL_CELLS = 32;

/** Spaces separate boolean operators; unspaced pipes are eligible item alternatives. */
export function parsePlanCheck(check) {
 if (check === null) return null;
 const fail = reason => { throw new TypeError(`Invalid plan check: ${reason}`); };
 if (typeof check !== 'string' || check.length === 0 || codePointLength(check) > 160) fail('expected null or 1-160 characters');
 const terms = check.split(/ ([&|]) /);
 const operators = terms.filter((_, i) => i % 2);
 if (new Set(operators).size > 1) fail('cannot mix & and |');
 const raw = terms.filter((_, i) => i % 2 === 0);
 if (raw.length > 4) fail('at most 4 terms');
 const parsed = raw.map(term => {
  let m = term.match(new RegExp(`^(in|visited|adv|seen|killed):(${ID})$`));
  if (m?.[1] === 'seen' && !SEEN_IDS.has(m[2])) fail(`unknown perceived structure ${m[2]}`);
  if (m && m[2].length <= 128) return { type: m[1], id: m[2], raw: term };
  m = term.match(new RegExp(`^has:(#?${ID}(?:\\|#?${ID})*)\\*([1-9][0-9]*)$`));
  // A tag overlaps item IDs and other tags, so its observed count cannot be summed with them without counting a stack twice.
  if (m && m[1].includes('#') && m[1].includes('|')) fail(`a #tag stands alone in its term ${JSON.stringify(term)}`);
  if (m && m[1].split('|').every(id => id.length <= 128) && Number.isSafeInteger(Number(m[2])) && Number(m[2]) <= 2147483647) return { type: 'has', ids: m[1].split('|'), count: Number(m[2]), raw: term };
  // Stage outcomes inside a long step: depth reached, a still lava pool seen up close, a portal frame's obsidian or
  // light, and End crystals still standing. Each reads observed facts only.
  m = term.match(/^y(<=|>=)(-?[0-9]{1,4})$/);
  if (m && Math.abs(Number(m[2])) <= 2048) return { type: 'y', op: m[1], value: Number(m[2]), raw: term };
  m = term.match(/^lava:([1-9]|[12][0-9]|3[0-2])$/);
  if (m) return { type: 'lava', count: Number(m[1]), raw: term };
  m = term.match(/^frame:(lit|[1-9][0-9]?)$/);
  if (m) return m[1] === 'lit' ? { type: 'frame', lit: true, raw: term } : { type: 'frame', count: Number(m[1]), raw: term };
  m = term.match(new RegExp(`^near:(${ID})@(-?[0-9]{1,8}),(-?[0-9]{1,4}),(-?[0-9]{1,8})\\*([1-9][0-9]?)$`));
  if (m && Math.abs(Number(m[2])) <= 30000000 && Math.abs(Number(m[3])) <= 2048 && Math.abs(Number(m[4])) <= 30000000) return { type: 'near', dimension: m[1], x: Number(m[2]), y: Number(m[3]), z: Number(m[4]), radius: Number(m[5]), raw: term };
  if (term === 'spawn:bed') return { type: 'spawn', raw: term };
  m = term.match(/^crystals<=([0-9]{1,2})$/);
  if (m) return { type: 'crystals', value: Number(m[1]), raw: term };
  m = term.match(/^worn:(leather|copper|golden|chainmail|iron|diamond|netherite)\+([1-4])$/);
  if (m) return { type: 'worn', tier: m[1], count: Number(m[2]), raw: term };
  // Models write a worn-style count ("tool:pickaxe:stone+1"); a tool term holds one tool, so the count changes nothing.
  m = term.match(/^tool:(pickaxe|axe|sword|shovel|hoe):(wooden|golden|stone|copper|iron|diamond|netherite)\+(?:[1-9][0-9]{0,2})?$/);
  if (m) return { type: 'tool', kind: m[1], tier: m[2], raw: term };
  fail(`unsupported term ${JSON.stringify(term)}; use namespaced IDs, counts, and spaced & or |`);
 });
 return { any: operators[0] === '|', terms: parsed };
}

export function emptyKnown() { return { visitedDimensions: [], advancements: [], structuresSeen: [], kills: [], placements: [], lavaPools: [], frames: [], crystals: null, spawn: null }; }
export function restoreKnown(value, plan = null) {
 const known = emptyKnown(), id = v => typeof v === 'string' && new RegExp(`^${ID}$`).test(v);
 for (const key of ['visitedDimensions', 'advancements', 'kills']) known[key] = [...new Set((Array.isArray(value?.[key]) ? value[key] : []).filter(id))];
 known.structuresSeen = (Array.isArray(value?.structuresSeen) ? value.structuresSeen : []).filter(v => id(v?.id) && id(v.dimension) && Number.isFinite(v.x) && Number.isFinite(v.z)).map(({ id, x, z, dimension }) => ({ id, x, z, dimension }));
 const cell = v => id(v?.dimension) && [v.x, v.y, v.z].every(Number.isSafeInteger);
 known.lavaPools = (Array.isArray(value?.lavaPools) ? value.lavaPools : []).filter(v => cell(v) && Number.isSafeInteger(v.sources) && v.sources > 0 && v.sources <= MAX_POOL_CELLS).slice(-MAX_REMEMBERED)
  .map(({ dimension, x, y, z, sources, cells }) => ({ dimension, x, y, z, sources, cells: (Array.isArray(cells) ? cells : []).filter(c => typeof c === 'string' && /^-?\d+,-?\d+,-?\d+$/.test(c)).slice(0, MAX_POOL_CELLS) }));
 known.frames = (Array.isArray(value?.frames) ? value.frames : []).filter(v => cell(v) && ['x', 'z'].includes(v.axis) && Number.isSafeInteger(v.obsidian) && Number.isSafeInteger(v.needed) && v.obsidian >= 0 && v.needed > 0)
  .slice(-MAX_REMEMBERED).map(({ dimension, x, y, z, axis, obsidian, needed, lit }) => ({ dimension, x, y, z, axis, obsidian, needed, lit: lit === true }));
 const c = value?.crystals;
 known.crystals = c && [c.standing, c.caged, c.broken].every(n => Number.isSafeInteger(n) && n >= 0) ? { standing: c.standing, caged: c.caged, broken: c.broken } : null;
 known.spawn = restoreSpawn(value?.spawn);
 known.placements = boundPlacements((Array.isArray(value?.placements) ? value.placements : []).filter(v => [v?.itemId, v?.blockId, v?.dimension].every(s => id(s) && s.length <= 128) && [v.x, v.y, v.z, v.placedAt].every(Number.isSafeInteger) && v.placedAt >= 0 && typeof v.actionId === 'string' && v.actionId.length <= 256 && relevantPlacement(v, plan))
  .map(v => ({ itemId: v.itemId, blockId: v.blockId, dimension: v.dimension, x: v.x, y: v.y, z: v.z, placedAt: v.placedAt, ...(Number.isSafeInteger(v.placedTick) && v.placedTick >= 0 ? { placedTick: v.placedTick } : {}), actionId: v.actionId,
   ...(v.available === false ? { available: false, withdrawnAt: Number.isSafeInteger(v.withdrawnAt) && v.withdrawnAt >= v.placedAt ? v.withdrawnAt : v.placedAt,
    ...(Number.isSafeInteger(v.withdrawnTick) && v.withdrawnTick >= 0 ? { withdrawnTick: v.withdrawnTick } : {}) } : {}) })));
 return known;
}
// These are the recognition labels supplied by the player's visibility-gated survey, not a registry search.
const STRUCTURES = { shipwreck: 'shipwreck', igloo: 'igloo', mineshaft: 'mineshaft', stronghold: 'stronghold', 'nether fortress': 'fortress', bastion: 'bastion_remnant', 'desert temple': 'desert_pyramid', 'jungle temple': 'jungle_pyramid', 'witch hut': 'swamp_hut', 'ocean monument': 'monument', 'woodland mansion': 'mansion', 'pillager outpost': 'pillager_outpost', 'end city': 'end_city', 'ancient city': 'ancient_city', 'trial chambers': 'trial_chambers', 'trail ruins': 'trail_ruins', 'nether fossil': 'nether_fossil' };
// A spawner is a block, not a structure, but a fortress's blaze spawner is the place a rods stage is about.
const SEEN_BLOCKS = new Set(['minecraft:spawner']);
const SEEN_IDS = new Set([...Object.values(STRUCTURES).map(id => `minecraft:${id}`), ...SEEN_BLOCKS]);
export function rememberPlanFacts(known, observation) {
 let changed = false;
 const add = (key, id) => { if (typeof id === 'string' && new RegExp(`^${ID}$`).test(id) && !known[key].includes(id)) { known[key].push(id); changed = true; } };
 const dimension = observation.world?.dimension;
 if (observation.ready === true && !deadSample(observation)) add('visitedDimensions', dimension);
 for (const id of observation.advancements ?? []) add('advancements', id);
 for (const id of observation.verifiedKills ?? []) add('kills', id);
 if (dimension) for (const row of [...(observation.sighted?.structures ?? []), ...(observation.survey?.structures ?? []), ...(observation.landmarks ?? [])]) {
  if (typeof row.structure !== 'string' || !Number.isFinite(row.x) || !Number.isFinite(row.z)) continue;
  if (row.structure === 'ocean ruins') continue;
  const id = row.structure.includes(':') ? row.structure : `minecraft:${STRUCTURES[row.structure] ?? row.structure.replaceAll(' ', '_')}`;
  // Existential seen checks need one historical sighting per type and dimension, not every moving nearest surface.
  if (SEEN_IDS.has(id) && !known.structuresSeen.some(v => v.id === id && v.dimension === dimension)) { known.structuresSeen.push({ id, x: row.x, z: row.z, dimension }); changed = true; }
 }
 if (dimension && observation.ready === true && !deadSample(observation)) changed = rememberStageFacts(known, observation, dimension) || changed;
 changed = rememberSpawn(known, observation) || changed;
 return changed;
}

/**
 * Where the next death respawns, as the player knows it: the "Respawn point set" message after using a bed (by day
 * too) or a charged anchor, the death screen's respawn target, and the "no home bed" message when that target was lost.
 * kind 'set' carries the cell; kind 'world' is the world spawn. Null until one of these was seen.
 */
export function rememberSpawn(known, o) {
 let changed = false;
 const death = o?.death;
 if (death && typeof death === 'object' && 'respawnX' in death) {
  const at = Number.isSafeInteger(death.diedAtEpochMs) ? death.diedAtEpochMs : 0;
  if (!(known.spawn?.at > at)) {
   const next = [death.respawnX, death.respawnY, death.respawnZ].every(Number.isFinite) && typeof death.respawnDimensionId === 'string'
    ? { kind: 'set', dimension: death.respawnDimensionId, x: Math.floor(death.respawnX), y: Math.floor(death.respawnY), z: Math.floor(death.respawnZ), at, source: 'death' }
    : { kind: 'world', at, source: 'death' };
   if (JSON.stringify({ ...next, at: 0 }) !== JSON.stringify({ ...known.spawn, at: 0 })) changed = true;
   known.spawn = next;
  }
 }
 if (o?.continuity?.rememberedSections?.includes('perception') || deadSample(o)) return changed;
 const dimension = o?.world?.dimension, position = o?.position ?? o?.player;
 for (const event of Array.isArray(o?.perception?.events) ? o.perception.events : []) {
  if (event?.type !== 'system_message' || typeof event.text !== 'string' || !Number.isFinite(event.observedAtEpochMs) || event.observedAtEpochMs <= (known.spawn?.at ?? -1)) continue;
  if (event.text === 'Respawn point set' && typeof dimension === 'string' && [position?.x, position?.y, position?.z].every(Number.isFinite)) {
   const beds = (Array.isArray(o.blocks) ? o.blocks : []).filter(b => /^minecraft:(\w+_bed|respawn_anchor)$/.test(b?.blockId ?? '') && [b.x, b.y, b.z].every(Number.isSafeInteger))
    .map(b => ({ b, d: Math.hypot(b.x + 0.5 - position.x, b.y - position.y, b.z + 0.5 - position.z) })).filter(r => r.d <= 6).sort((l, r) => l.d - r.d);
   const cell = beds[0]?.b ?? { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
   known.spawn = { kind: 'set', dimension, x: cell.x, y: cell.y, z: cell.z, at: event.observedAtEpochMs, source: 'used' }; changed = true;
  } else if (/no home bed or charged respawn anchor/i.test(event.text)) {
   known.spawn = { kind: 'world', at: event.observedAtEpochMs, source: 'missing' }; changed = true;
  }
 }
 return changed;
}
function restoreSpawn(v) {
 if (v?.kind === 'world' && Number.isFinite(v.at)) return { kind: 'world', at: v.at, source: typeof v.source === 'string' ? v.source.slice(0, 16) : 'death' };
 if (v?.kind === 'set' && Number.isFinite(v.at) && typeof v.dimension === 'string' && new RegExp(`^${ID}$`).test(v.dimension) && [v.x, v.y, v.z].every(Number.isSafeInteger)) return { kind: 'set', dimension: v.dimension, x: v.x, y: v.y, z: v.z, at: v.at, source: typeof v.source === 'string' ? v.source.slice(0, 16) : 'used' };
 return null;
}

/** Spawners, still lava pools and portal frames in view, and the End crystal tally: facts the stage checks read. */
function rememberStageFacts(known, o, dimension) {
 let changed = false;
 known.lavaPools ??= []; known.frames ??= []; known.crystals ??= null;
 const remembered = section => o.continuity?.rememberedSections?.includes(section);
 const blocks = remembered('blocks') ? [] : (Array.isArray(o.blocks) ? o.blocks : []).filter(b => b?.visible !== false && [b.x, b.y, b.z].every(Number.isSafeInteger));
 for (const b of [...blocks, ...(remembered('sighted') ? [] : Array.isArray(o.sighted?.blocks) ? o.sighted.blocks : [])]) {
  if (!SEEN_BLOCKS.has(b?.blockId) || !Number.isFinite(b.x) || !Number.isFinite(b.z) || known.structuresSeen.some(v => v.id === b.blockId && v.dimension === dimension)) continue;
  known.structuresSeen.push({ id: b.blockId, x: b.x, z: b.z, dimension }); changed = true;
 }
 // Distinct still source cells seen up close, grouped into pools; one sample shows only part of a pool (8 at most in
 // d14-iron-i beside the pool it cast from).
 for (const b of blocks) {
  if (b.blockId !== 'minecraft:lava' || String(b.state?.level ?? '') !== '0') continue;
  let pool = known.lavaPools.find(p => p.dimension === dimension && Math.abs(p.x - b.x) <= 12 && Math.abs(p.y - b.y) <= 8 && Math.abs(p.z - b.z) <= 12);
  if (!pool) { pool = { dimension, x: b.x, y: b.y, z: b.z, sources: 0, cells: [] }; known.lavaPools.push(pool); known.lavaPools.splice(0, Math.max(0, known.lavaPools.length - MAX_REMEMBERED)); }
  pool.cells ??= [];
  const key = `${b.x},${b.y},${b.z}`;
  if (pool.cells.includes(key) || pool.sources >= MAX_POOL_CELLS) continue;
  pool.cells.push(key); pool.sources += 1; changed = true;
 }
 for (const f of remembered('sighted') ? [] : Array.isArray(o.sighted?.portalFrames) ? o.sighted.portalFrames : []) {
  if (![f?.x, f?.y, f?.z, f?.obsidian, f?.needed].every(Number.isSafeInteger) || !['x', 'z'].includes(f.axis)) continue;
  const row = { dimension, x: f.x, y: f.y, z: f.z, axis: f.axis, obsidian: f.obsidian, needed: f.needed, lit: f.lit === true };
  const index = known.frames.findIndex(v => v.dimension === dimension && v.x === f.x && v.y === f.y && v.z === f.z && v.axis === f.axis);
  if (index >= 0 && JSON.stringify(known.frames[index]) === JSON.stringify(row)) continue;
  if (index >= 0) known.frames.splice(index, 1);
  known.frames.push(row); known.frames.splice(0, Math.max(0, known.frames.length - MAX_REMEMBERED)); changed = true;
 }
 const tally = dimension === 'minecraft:the_end' && o.endCrystals && Array.isArray(o.endCrystals.standing) && Number.isSafeInteger(o.endCrystals.broken) ? o.endCrystals : null;
 if (tally) {
  const row = { standing: tally.standing.length, caged: tally.standing.filter(c => c?.caged === true).length, broken: tally.broken };
  if (JSON.stringify(row) !== JSON.stringify(known.crystals)) { known.crystals = row; changed = true; }
 }
 return changed;
}

export function evaluatePlanCheck(check, observation, known) {
 const parsed = parsePlanCheck(check);
 const o = observation ?? {}, dead = deadSample(o), items = dead ? [] : o.inventory?.items ?? [];
 const ready = o.ready === true || dead;
 const terms = parsed.terms.map(term => {
  let ok = false, reason;
  switch (term.type) {
   case 'in': ok = dead ? false : o.world?.dimension ? o.world.dimension === term.id : null; reason = `in ${short(term.id)}`; break;
   case 'visited': ok = known.visitedDimensions.includes(term.id); reason = `visited ${short(term.id)}`; break;
   case 'adv': ok = known.advancements.includes(term.id); reason = `adv ${short(term.id)}`; break;
   case 'seen': ok = known.structuresSeen.some(v => v.id === term.id); reason = `seen ${short(term.id)}`; break;
   case 'killed': ok = known.kills.includes(term.id); reason = `killed ${short(term.id)}`; break;
   case 'y': {
    const at = o.position ?? o.player?.position ?? o.player, y = Number.isFinite(at?.y) ? Math.floor(at.y) : null;
    ok = dead ? false : y === null ? null : term.op === '<=' ? y <= term.value : y >= term.value;
    reason = `y ${dead ? 'dead' : y ?? '?'} (${term.op}${term.value})`;
    return { ...term, ok, reason, ...(y === null || dead ? {} : { metric: y, better: term.op === '<=' ? 'lower' : 'higher' }) };
   }
   case 'near': {
    const at = o.position ?? o.player?.position ?? o.player;
    const distance = !dead && o.world?.dimension === term.dimension && [at?.x, at?.y, at?.z].every(Number.isFinite) ? Math.hypot(at.x-term.x,at.y-term.y,at.z-term.z) : null;
    ok = dead || o.world?.dimension && o.world.dimension !== term.dimension ? false : distance === null ? null : distance <= term.radius;
    reason = `distance ${distance === null ? '?' : Math.round(distance)} to ${term.dimension}@${term.x},${term.y},${term.z} (<=${term.radius})`;
    return { ...term, ok, reason, ...(distance === null ? {} : { metric: distance, better: 'lower' }) };
   }
   case 'lava': {
    const here = o.world?.dimension, pools = (known.lavaPools ?? []).filter(p => !here || p.dimension === here);
    const best = pools.reduce((n, p) => Math.max(n, p.sources), 0);
    ok = best >= term.count; reason = `still lava sources seen ${best}/${term.count}`;
    return { ...term, ok, reason, metric: best, better: 'higher' };
   }
   case 'frame': {
    const frames = known.frames ?? [];
    if (term.lit) { ok = frames.some(f => f.lit); reason = ok ? 'lit frame seen' : 'no lit frame seen'; break; }
    // A lit portal stands in a complete frame, whatever obsidian the frame scan counted around it.
    const best = frames.reduce((n, f) => Math.max(n, f.obsidian), 0), lit = frames.some(f => f.lit);
    // Obsidian carried (mined with a diamond pickaxe, or salvaged) is frame material on its way, not a frame.
    const held = ready ? count(items.filter(v => v.itemId === 'minecraft:obsidian')) : 0;
    ok = lit || best >= term.count; reason = lit ? 'lit frame seen' : `frame obsidian ${best}/${term.count}${held ? `, ${held} obsidian held` : ''}`;
    return { ...term, ok, reason, metric: best + held, better: 'higher' };
   }
   case 'spawn': {
    const set = known.spawn?.kind === 'set';
    ok = set; reason = set ? `respawn set ${known.spawn.x},${known.spawn.y},${known.spawn.z}` : known.spawn ? 'respawn: world spawn' : 'no respawn set seen';
    break;
   }
   case 'crystals': {
    const c = known.crystals;
    ok = c ? c.standing <= term.value : null;
    reason = c ? `crystals ${c.standing} standing${c.caged ? ` (${c.caged} caged)` : ''} of ${c.standing + c.broken} seen` : 'crystals ?';
    return { ...term, ok, reason, ...(c ? { metric: c.standing, better: 'lower' } : {}) };
   }
   case 'has': {
    const placements = placedItems(known, term.ids, o);
    const held = term.ids[0].startsWith('#') ? tagCount(o, term.ids[0]) : count(items.filter(v => term.ids.includes(v.itemId)));
    const stale = !dead && (o.continuity?.rememberedSections?.includes('inventory') || placementsForItems(known, term.ids).some(v => !Number.isFinite(o.observedAtEpochMs) || o.observedAtEpochMs < v.placedAt));
    const available = (ready && !stale ? held : 0) + placements.length;
    ok = available >= term.count ? true : ready && !stale && held !== null ? false : null;
    reason = `${term.ids.map(short).join('|')} ${ready && !stale && held !== null ? available : placements.length || '?'}/${term.count}`;
    return { ...term, ok, reason, placements: placements.slice(0, term.count), ...(ready && !stale && held !== null ? { metric: available, better: 'higher' } : {}) };
   }
   case 'worn': {
    const worn = items.filter(v => ARMOR_SLOTS.has(v.slot) && /_(helmet|chestplate|leggings|boots)$/.test(v.itemId) && ARMOR.indexOf(v.itemId === 'minecraft:turtle_helmet' ? 'iron' : v.itemId.replace(/^minecraft:/, '').split('_')[0]) >= ARMOR.indexOf(term.tier)).length;
    ok = ready ? worn >= term.count : null; reason = ok ? 'armor ok' : `armor ${worn}/${term.count} ${term.tier}+`; break;
   }
   case 'tool': {
    const found = items.some(v => v.count > 0 && v.itemId.startsWith('minecraft:') && v.itemId.endsWith(`_${term.kind}`) && TOOLS.indexOf(v.itemId.slice(10).split('_')[0]) >= TOOLS.indexOf(term.tier));
    ok = ready ? found : null; reason = found ? `${term.kind} ok` : `${term.kind} missing ${term.tier}+`;
    const rank = items.filter(v => v.count > 0 && v.itemId.startsWith('minecraft:') && v.itemId.endsWith(`_${term.kind}`)).reduce((best,v) => Math.max(best,TOOLS.indexOf(v.itemId.slice(10).split('_')[0])+1),0);
    return { ...term, ok, reason, ...(ready ? { metric: rank, better: 'higher' } : {}) };
   }
  }
  return { ...term, ok, reason };
 });
 const ok = parsed.any ? terms.some(t => t.ok === true) ? true : terms.some(t => t.ok === null) ? null : false
  : terms.some(t => t.ok === false) ? false : terms.some(t => t.ok === null) ? null : true;
 return { ok, terms, any: parsed.any, partial: terms.some(t => t.ok === true) && ok !== true, reason: terms.map(t => t.reason).join(parsed.any ? ' or ' : ', '), presenceOnly: ok === true && terms.every(t => t.ok !== true || PRESENCE.has(t.type)) };
}

// ServerObservationCollector sums each held stack's tags into tagCounts and keeps the first 128 sorted entries.
const MAX_TAG_COUNT_ENTRIES = 128;
/** The observed count of held items in a tag; null when the observation does not report it. */
function tagCount(o, tag) {
 if (deadSample(o)) return 0;
 const counts = o.inventory?.tagCounts;
 if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) return null;
 if (Object.hasOwn(counts, tag)) return Number.isSafeInteger(counts[tag]) && counts[tag] >= 0 ? counts[tag] : null;
 const keys = Object.keys(counts);
 return keys.length >= MAX_TAG_COUNT_ENTRIES && keys.every(key => key < tag) ? null : 0;
}

export function planProgress(plan) {
 if (!plan?.steps?.length) return null;
 const skipped = new Map(), byId = new Map(plan.steps.map(s => [s.id, s]));
 const visit = (id, later, visited = new Set()) => {
  if (visited.has(id)) return; visited.add(id);
  const s = byId.get(id); if (!s) return;
  if (['pending', 'lost'].includes(s.status) && !skipped.has(id)) skipped.set(id, later);
  for (const parent of s.dependsOn) visit(parent, later, visited);
 };
 for (const s of plan.steps) if (s.status === 'complete') for (const parent of s.dependsOn) visit(parent, s.id);
 const satisfied = id => byId.get(id)?.status === 'complete' || skipped.has(id);
 const open = plan.steps.filter(s => s.status !== 'complete' && !skipped.has(s.id) && s.dependsOn.every(satisfied));
 return { skipped: Object.assign(Object.create(null), Object.fromEntries(skipped)), open: open.map(s => s.id) };
}

// Functional structures remain usable after placement; building materials still require held inventory.
export function placedItems(known, ids, observation) {
 const position = observation?.position ?? observation?.player?.position ?? observation?.player;
 const distance = p => p.dimension === observation?.world?.dimension && ['x', 'y', 'z'].every(k => Number.isFinite(position?.[k])) ? Math.hypot(p.x - position.x, p.y - position.y, p.z - position.z) : Infinity;
 return placementsForItems(known, ids).filter(v => v.available !== false && functionalPlacement(v.itemId)).sort((a, b) => distance(a) - distance(b) || b.placedAt - a.placedAt);
}
