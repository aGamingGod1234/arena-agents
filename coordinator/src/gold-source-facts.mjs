import { observedBlocks } from './seen-resource-facts.mjs';

export const GOLD_SOURCE_BYTES = 320;
const GOLD_BLOCK = 'minecraft:gold_block', ORE = 'minecraft:nether_gold_ore';
const cellKey = row => `${row.x},${row.y},${row.z}`;

/** Inventory is priced separately. Only actual sightings, superseded by later visible cells, fund this option. */
export function goldSourceFact(observation, known, position) {
 const dimension = observation?.world?.dimension;
 if (!dimension || !position) return null;
 const cells = new Map();
 for (const row of [...(known?.blocks ?? []), ...observedBlocks(observation)]) {
  if (row.visible === false || row.perceivedBy === 'sound' || row.dimension && row.dimension !== dimension
    || ![row.x, row.y, row.z].every(Number.isSafeInteger)) continue;
  cells.set(cellKey(row), row);
 }
 const sources = [...cells.values()].filter(row => row.blockId === GOLD_BLOCK || row.blockId === ORE);
 if (!sources.length) return null;
 const blocks = sources.filter(row => row.blockId === GOLD_BLOCK).length, ores = sources.length - blocks;
 const nearest = sources.sort((a, b) => Math.hypot(a.x + .5 - position.x, a.y + .5 - position.y, a.z + .5 - position.z)
  - Math.hypot(b.x + .5 - position.x, b.y + .5 - position.y, b.z + .5 - position.z))[0];
 // A cluster contains only connected cells the player has seen. It says nothing about buried neighbours.
 const cluster = new Set([cellKey(nearest)]), queue = [nearest];
 for (let i = 0; i < queue.length; i++) {
  const row = queue[i];
  for (const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
   const key = `${row.x+dx},${row.y+dy},${row.z+dz}`, next = cells.get(key);
   if (next?.blockId === nearest.blockId && !cluster.has(key)) { cluster.add(key); queue.push(next); }
  }
 }
 const localYield = cluster.size * (nearest.blockId === GOLD_BLOCK ? 9 : 4/9);
 const dy = nearest.y - Math.floor(position.y);
 const fact = `seen gold: ${blocks} blocks + ${ores} Nether ores (~${(blocks*9+ores*4/9).toFixed(1)} ingots, no Fortune); nearest @${nearest.x},${nearest.y},${nearest.z} dy${dy>=0?'+':''}${dy}: ${cluster.size} connected seen ${nearest.blockId===GOLD_BLOCK?'blocks':'ores'} (~${localYield.toFixed(1)} ingots). Route/clearance unverified; sightings may have changed; nuggets craft 9:1, blocks 1:9`;
 if (Buffer.byteLength(fact) > GOLD_SOURCE_BYTES) throw new RangeError('Gold source fact exceeded its reserved byte budget');
 return fact;
}
