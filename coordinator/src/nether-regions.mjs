// Where a player looks for a Nether fortress: the vanilla structure grid both Nether complexes share, offered as facts
// and the nearest unchecked regions. The model chooses where to go; nothing here moves the player.
//
// Vanilla 26.1.2 data and code (worldgen/structure_set/nether_complexes.json, RandomSpreadStructurePlacement,
// ChunkGenerator.createStructures, NetherFortressStructure, NetherFortressPieces, worldgen/structure/bastion_remnant.json):
// random_spread spacing 27 chunks, separation 4, so each 432-block region (cells from chunk 0, 27, 54...) gets one start
// in its first 23 chunks (368 blocks) per axis; fortress weight 2, bastion 3, and a bastion that cannot start (basalt
// deltas are not in has_structure/bastion_remnant) falls back to the fortress, which every Nether biome allows.
// Fortress pieces stay within 112 blocks of the start piece and the fortress is moved to start at y 48-70; a bastion's
// pieces stay within 80 blocks of its start. dimension_type/the_nether.json ends the fog at 96 blocks.
import { headingOf, sightingKind } from './search-coverage.mjs';

export const REGION_BLOCKS = 432;
export const START_BLOCKS = 368;
// Vanilla walking speed (blocks per second); sprinting is 5.6.
const WALK_SPEED = 4.3;
const SEARCH_ROWS = 3;
const WINDOW = 2;
// Start ground within this of where the player stood counts as seen: the 96-block fog plus a structure's spread.
export const CHECKED_BLOCKS = 140;
// Start ground is weighed on a 32-block grid (11.5 x 11.5 points per region).
const GROUND_STEP = 32;
// Blocks only these structures generate in the Nether: nether bricks only in fortresses (no bastion, ruined portal or
// fossil template holds them); gilded blackstone only in bastions. Polished blackstone bricks also come from nether
// ruined portals (stone bricks replaced by blackstone), so only a large seen cluster of them counts.
const FORTRESS_BLOCK = /(^|:)nether_brick/;
const BASTION_BLOCK = /(^|:)gilded_blackstone$/;
const BASTION_LARGE_BLOCK = /(^|:)(cracked_)?polished_blackstone_bricks$/;
const BASTION_LARGE_SIZE = 8;
const BLAZE_NEEDS = /\b(blaze_rod|blaze_powder|ender_eye|blaze rods?|blaze powder|eyes? of ender|fortress)\b/i;

const floorDiv = (value, size) => Math.floor(value / size);

/** The region a position lies in. */
export function regionOf(x, z) {
	return { rx: floorDiv(x, REGION_BLOCKS), rz: floorDiv(z, REGION_BLOCKS) };
}

/**
 * The region whose structure a seen block most likely belongs to. Starts lie only in a region's first 368 blocks per
 * axis, so a block in the last 64 belongs to whichever start area is nearer: its own region's or the next one's.
 */
export function structureRegion(x, z) {
	const axis = (value) => {
		const region = floorDiv(value, REGION_BLOCKS), offset = value - region * REGION_BLOCKS;
		return offset >= START_BLOCKS && REGION_BLOCKS - offset < offset - (START_BLOCKS - 1) ? region + 1 : region;
	};
	return { rx: axis(x), rz: axis(z) };
}

/** What a remembered sighting shows about its region's structure: 'fortress', 'bastion' or null. */
export function sightedComplex(row) {
	const kind = sightingKind(row), what = String(row?.what ?? '');
	if (kind === 'structure') return /fortress/.test(what) ? 'fortress' : /^bastion/.test(what) ? 'bastion' : null;
	if (kind !== 'built') return null;
	const blocks = what.replace(/^built:/, '').split('+');
	if (blocks.some((id) => FORTRESS_BLOCK.test(id))) return 'fortress';
	if (blocks.some((id) => BASTION_BLOCK.test(id)) || (Number(row.size) >= BASTION_LARGE_SIZE && blocks.some((id) => BASTION_LARGE_BLOCK.test(id)))) return 'bastion';
	return null;
}

/** Regions whose structure was seen, keyed "rx,rz", with the kind and the nearest seen row. */
export function knownRegions(sightings, position) {
	const regions = new Map();
	for (const row of sightings ?? []) {
		if (![row?.x, row?.z].every(Number.isFinite)) continue;
		const kind = sightedComplex(row);
		if (kind === null) continue;
		const region = structureRegion(row.x, row.z), key = `${region.rx},${region.rz}`;
		const distance = Math.hypot(row.x - position.x, row.z - position.z), held = regions.get(key);
		// A fortress sighting outranks a bastion one: a region holds only one of them, and bricks are unambiguous.
		if (!held || (kind === 'fortress' && held.kind !== 'fortress') || (kind === held.kind && distance < held.distance)) regions.set(key, { ...region, kind, row, distance });
	}
	return regions;
}

/**
 * Regions near the player with no seen structure, by the average distance to their start ground the player has not
 * yet seen (farther than {@link CHECKED_BLOCKS} from everywhere it stood), with the nearest such spot as the target.
 * Measured on 30 surveyed seeds (/locate ground truth), following this order re-read as the player walks reached a
 * fortress in sight sooner than region middles or a straight line on a random heading.
 */
export function searchRegions(position, known, limit = SEARCH_ROWS, trail = []) {
	const here = regionOf(position.x, position.z), stood = [...trail, position], rows = [];
	for (let dx = -WINDOW; dx <= WINDOW; dx++) for (let dz = -WINDOW; dz <= WINDOW; dz++) {
		const region = { rx: here.rx + dx, rz: here.rz + dz };
		if (known.has(`${region.rx},${region.rz}`)) continue;
		const x0 = region.rx * REGION_BLOCKS, z0 = region.rz * REGION_BLOCKS;
		const near = stood.filter((point) => point.x > x0 - CHECKED_BLOCKS && point.x < x0 + START_BLOCKS + CHECKED_BLOCKS
			&& point.z > z0 - CHECKED_BLOCKS && point.z < z0 + START_BLOCKS + CHECKED_BLOCKS);
		let target = null, sum = 0, count = 0;
		for (let gx = GROUND_STEP / 2; gx < START_BLOCKS; gx += GROUND_STEP) for (let gz = GROUND_STEP / 2; gz < START_BLOCKS; gz += GROUND_STEP) {
			const x = x0 + gx, z = z0 + gz;
			if (near.some((point) => Math.hypot(point.x - x, point.z - z) <= CHECKED_BLOCKS)) continue;
			const distance = Math.hypot(x - position.x, z - position.z);
			sum += distance;
			count++;
			if (target === null || distance < target.distance) target = { x, z, distance };
		}
		if (target !== null) rows.push({ ...region, target, average: sum / count, unseen: count / (START_BLOCKS / GROUND_STEP) ** 2 });
	}
	return rows.sort((a, b) => a.average - b.average).slice(0, limit);
}

const span = ({ rx, rz }) => `x ${rx * REGION_BLOCKS}..${rx * REGION_BLOCKS + REGION_BLOCKS - 1} z ${rz * REGION_BLOCKS}..${rz * REGION_BLOCKS + REGION_BLOCKS - 1}`;
const minutes = (blocks) => Math.max(0.1, Math.round(blocks / WALK_SPEED / 6) / 10);

/**
 * In the Nether while blaze rods are still to get and no fortress is known: the shared grid of fortresses and bastions,
 * the regions already known to hold a bastion, and the regions with nothing seen yet, each with its nearest unseen start
 * ground, straight-line distance and walking minutes. Null otherwise.
 */
export function fortressSearchOption({ observation = null, known = null, position = null, open = '' } = {}) {
	if (observation?.world?.dimension !== 'minecraft:the_nether' || position === null || !BLAZE_NEEDS.test(open)) return null;
	const sighted = Array.isArray(observation?.sighted?.structures) ? observation.sighted.structures.map((row) => ({ ...row, what: row?.structure ?? `built:${(row?.blocks ?? []).join('+')}` })) : [];
	const regions = knownRegions([...(known?.sightings ?? []), ...sighted], position);
	if ([...regions.values()].some((region) => region.kind === 'fortress')) return null;
	const bastions = [...regions.values()].sort((a, b) => a.distance - b.distance).slice(0, SEARCH_ROWS);
	const nearest = searchRegions(position, regions, SEARCH_ROWS, Array.isArray(known?.trail) ? known.trail : []);
	const facts = 'Fortress search, your choice: fortresses and bastions share one grid of 432-block regions (edges at x and z multiples of 432); each holds exactly one of the two, started in its first 368 blocks along x and z;'
		+ ' about half are fortresses (weight 2 of 5, plus where a bastion would start in basalt deltas); fortress bricks spread up to 112 blocks from the start, a bastion 80; Nether fog hides everything past 96, so ground within ~140 of where you stood is seen; fortresses are built upward from y 48-70; an open lava sea (surface y 31) or high ground gives the full 96';
	const seen = bastions.length === 0 ? '' : ` | bastion seen, so no fortress in: ${bastions.map((region) => `${span(region)} (@${region.row.x},${region.row.z})`).join('; ')}`;
	const next = nearest.map((region) => `${headingOf(region.target.x - position.x, region.target.z - position.z)} ${span(region)}: nearest unseen start ground @${region.target.x},${region.target.z} ${Math.round(region.target.distance)} blocks ~${minutes(region.target.distance)} min walking, ${Math.round(region.unseen * 100)}% unseen`);
	return `${facts}${seen} | regions with nothing seen yet, nearest unseen start ground on average first: ${next.join('; ')}`;
}
