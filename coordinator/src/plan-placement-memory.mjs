// Match seen-memory's block bound. Indexes are transient and rebuilt only when rows change.
export const MAX_PLAN_PLACEMENTS = 1024;
const indexes = new WeakMap();
const STATIONS = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest', 'ender_chest', 'barrel', 'brewing_stand', 'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'smithing_table', 'stonecutter', 'grindstone', 'loom', 'cartography_table', 'fletching_table', 'composter', 'beacon', 'respawn_anchor'].map(id => `minecraft:${id}`));
const ANVILS = new Set(['minecraft:anvil', 'minecraft:chipped_anvil', 'minecraft:damaged_anvil']);
export const functionalPlacement = id => STATIONS.has(id) || /^minecraft:[a-z_]+_bed$/.test(id);
const itemKey = id => ANVILS.has(id) ? 'minecraft:anvil' : id;
export const placementCellKey = p => `${p.dimension}:${p.x},${p.y},${p.z}`;
export const samePlacementBlock = (left, right) => itemKey(left) === itemKey(right);

function index(known) {
 let cached = indexes.get(known);
 if (cached?.rows === known.placements) return cached;
 cached = { rows: known.placements, cells: new Map(), dimensions: new Map(), items: new Map() };
 for (const row of known.placements ?? []) {
  cached.cells.set(placementCellKey(row), row);
  if (!cached.dimensions.has(row.dimension)) cached.dimensions.set(row.dimension, new Map());
  cached.dimensions.get(row.dimension).set(`${row.x},${row.y},${row.z}`, row);
  const key = itemKey(row.itemId);
  if (!cached.items.has(key)) cached.items.set(key, []);
  cached.items.get(key).push(row);
 }
 indexes.set(known, cached); return cached;
}
export const placementAt = (known, cell) => index(known).cells.get(placementCellKey(cell));
export const placementCellsInDimension = (known, dimension) => index(known).dimensions.get(dimension);
export function placementsForItems(known, ids) {
 const items = index(known).items;
 return [...new Set(ids.map(itemKey))].flatMap(id => items.get(id) ?? []);
}
export function relevantPlacement(row, plan) {
 return functionalPlacement(row.itemId) || (plan?.steps ?? []).some(s => s.kind === 'world' && s.check === null && placementCellKey(s.evidence) === placementCellKey(row));
}
export function boundPlacements(rows) {
 return rows.sort((a, b) => a.placedAt - b.placedAt).slice(-MAX_PLAN_PLACEMENTS);
}
export function prunePlacements(known, plan) {
 const rows = known.placements.filter(row => relevantPlacement(row, plan));
 if (rows.length === known.placements.length) return false;
 known.placements = rows; return true;
}
