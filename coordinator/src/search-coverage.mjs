// Bounded per world+dimension record of where the player stood, what it saw and which surveys it completed.
// It holds facts only; the model reads them through exploreFrontier and survey and chooses every destination.
import { deadSample } from './fact-provenance.mjs';

export const SECTOR_SIZE = 16;
export const HEADINGS = Object.freeze(['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE']);
const LIMITS = Object.freeze({ trail: 128, seen: 256, looks: 32, sightings: 48, withdrawn: 128, placed: 256 });
// A built row names its nearest seen block and its seen horizontal extent: its blocks lie within that extent plus this.
const BUILT_SLACK = 2;
// Caves, veins and lava share this bound, with room shared by kind and ore material so frequent sightings cannot
// erase the only observed source of another material. They never evict structures and villages on insertion.
const TRANSIENT_SIGHTINGS = 24;
const TRANSIENT = new Set(['cave', 'vein', 'lava', 'mob']);
// Mobs that are themselves an item source, remembered where they were seen: blazes hover near their fortress spawner.
const SOURCE_MOBS = new Set(['minecraft:blaze', 'minecraft:enderman']);
const SPAWNER = 'minecraft:spawner';
// Points of interest villages generate: a bell, beds and villager workstations. One alone is no village (a player
// places beds and workstations too); need options decide what a group of them shows.
export const VILLAGE_POI = /(^|:)(bell|[a-z_]+_bed|blast_furnace|smoker|cartography_table|brewing_stand|composter|barrel|fletching_table|cauldron|lectern|stonecutter|loom|smithing_table|grindstone)$/;
// A cave row's air count starts at 30 (SightedFeatures.CAVE_MIN_AIR); a remembered cave is a roomier one.
const CAVE_MIN_AIR = 40;
const NEAR = 8;
// A survey counts for "here" only when it was taken this close; farther ones looked from somewhere else.
const SURVEY_NEAR = 32;
const EYE_HEIGHT = 1.62;
// ObservationVisibility puts a direction in view when its dot product with the view vector is at least 0.25.
const VIEW_DOT = 0.25;
// What a body moves by itself between two samples, per tick: sprint-jumping on ice stays under 1 horizontally, a
// jump rises 1.25 and stairs about 0.3 a tick, terminal falling speed is 3.92. Faster gaps need riding, gliding,
// a fluid current or a launch (knockback, explosion) to explain them, and even those stay under 5 a tick.
const WALK = Object.freeze({ horizontal: 1, riseOnce: 1, rise: 0.6, fall: 4 });
const CARRIED = Object.freeze({ horizontal: 5, vertical: 4 });
// Velocity (blocks a tick) at either end of a gap that shows the body was launched rather than walking.
const LAUNCH_SPEED = 0.6;
// The server reports a teleport for this long (PlayerTeleports.REPORT_TICKS); a longer gap may hide one.
const UNOBSERVED_TICKS = 400;
// Blocks a player cannot stand on, or should not: fluids, fire, plants, thin attachments and hazards.
const NON_FOOTING = /(^|:)(air|cave_air|void_air|lava|water|fire|soul_fire|bubble_column|powder_snow|cobweb|magma_block|cactus|sweet_berry_bush|pointed_dripstone|scaffolding|brown_mushroom|red_mushroom|short_grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|sculk_vein|nether_sprouts|weeping_vines|twisting_vines|ladder|snow|iron_bars|chain|lantern|soul_lantern|end_rod|lightning_rod|campfire|soul_campfire|bell|flower_pot|decorated_pot|amethyst_cluster|hopper|anvil|chipped_anvil|damaged_anvil|enchanting_table|daylight_detector|stonecutter|lectern|brewing_stand|cauldron|composter|grindstone)$|_(roots|sprouts|sapling|mushroom|fungus|flower|tulip|torch|vines|carpet|button|pressure_plate|sign|banner|rail|plant|slab|stairs|fence|fence_gate|wall|pane|door|trapdoor|bed|candle|head|skull|bud|leaves|coral|coral_fan|layer|chain)$/;
// Block tags of shapes that are not a full top face at y+1.
const NON_FULL_TAGS = new Set(['minecraft:replaceable', 'minecraft:slabs', 'minecraft:stairs', 'minecraft:fences', 'minecraft:walls', 'minecraft:fence_gates',
	'minecraft:doors', 'minecraft:trapdoors', 'minecraft:beds', 'minecraft:candles', 'minecraft:leaves', 'minecraft:climbable', 'minecraft:fire', 'minecraft:campfires']);
const AIR = /(^|:)(air|cave_air|void_air)$/;
// Recent travel: a breadcrumb every RECENT_SPACING blocks walked, the last RECENT_CRUMBS of them (about 256 blocks). A
// crumb within RECENT_SPACING of an earlier, non-adjacent one at the same feet height is a place walked through again.
const RECENT_SPACING = 8;
const RECENT_CRUMBS = 32;

export function createSearch() {
	return { trail: new Map(), seen: new Map(), surfaceCells: new Map(), looks: [], sightings: new Map(), withdrawn: new Map(), placed: new Map(), odometer: { travelled: 0, descended: 0, climbed: 0 }, motion: null, tick: 0 };
}

export function sectorKey(x, z) { return `${Math.floor(x / SECTOR_SIZE)},${Math.floor(z / SECTOR_SIZE)}`; }

/** Compass label of a horizontal offset; Minecraft north is -Z and east is +X. */
export function headingOf(dx, dz) {
	const yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
	return HEADINGS[((Math.round(yaw / 45) % 8) + 8) % 8];
}

/** Death, or a sample of a dead body: motion before and after it is not one journey. */
export const lifecycleBreak = deadSample;

/**
 * Standing needs positive evidence: on the ground and not in a fluid, riding, gliding or swimming. Returns true, false
 * (seen otherwise) or null (the sample does not say).
 */
export function grounded(player) {
	if (player === null || typeof player !== 'object') return null;
	if (player.inWater === true || player.inLava === true || player.passenger === true || player.vehicle != null || player.gliding === true || player.swimming === true) return false;
	return typeof player.onGround === 'boolean' ? player.onGround : null;
}

/** The body facts of a full observation, or of an action result (whose onGround already excludes fluids and riding). */
function bodyOf(observation) {
	if (observation?.player !== null && typeof observation?.player === 'object') return observation.player;
	return observation !== null && typeof observation === 'object' ? observation : null;
}

/** Riding, gliding, in a fluid, or moving at launch speed: movement the body's own walking does not bound. */
function carriedBy(body, velocity) {
	if (body !== null && (body.passenger === true || body.vehicle != null || body.gliding === true || body.inWater === true || body.inLava === true || body.swimming === true)) return true;
	return velocity !== null && typeof velocity === 'object' && Math.hypot(velocity.x, velocity.y, velocity.z) >= LAUNCH_SPEED;
}

/**
 * Classifies one sample against the last one without changing anything. continuity is 'same' (one motion), 'break'
 * (death, or a teleport the player saw), or 'gap' (movement the samples cannot explain: uncertain, so never counted as
 * travel or climb). groundY is the block Y it stands on, null without positive grounding evidence.
 */
export function classifySample(search, observation, position, tick) {
	if (lifecycleBreak(observation)) return { continuity: 'break', ended: true, groundY: null, standing: false, feetY: position.y, tick };
	const body = bodyOf(observation);
	const standing = grounded(body);
	const groundY = standing === true ? Math.floor(position.y + 1e-3) : null;
	const teleportTick = Number.isSafeInteger(body?.teleportTick) ? body.teleportTick : undefined;
	const carried = carriedBy(body, observation?.velocity);
	const last = search.motion;
	let continuity = 'break';
	if (last !== null && Number.isSafeInteger(tick) && tick >= last.tick
		&& !(teleportTick !== undefined && teleportTick !== last.teleportTick && teleportTick >= last.tick)) {
		const ticks = Math.max(1, tick - last.tick);
		const horizontal = Math.hypot(position.x - last.x, position.z - last.z), dy = position.y - last.y;
		const walked = horizontal <= WALK.horizontal * ticks && dy <= WALK.riseOnce + WALK.rise * ticks && dy >= -WALK.fall * ticks;
		const rode = (carried || last.carried) && horizontal <= CARRIED.horizontal * ticks && Math.abs(dy) <= CARRIED.vertical * ticks;
		continuity = tick - last.tick <= UNOBSERVED_TICKS && (walked || rode) ? 'same' : 'gap';
	}
	return { continuity, ended: false, groundY, standing, carried, teleportTick, feetY: position.y, tick };
}

/**
 * Ingests one sample; returns its classification, which travel measurement reuses. sightingAt, the block evidence that
 * may bring a withdrawn sighting back, defaults to blockAt.
 */
export function observeSearch(search, observation, position, tick, blockAt = () => undefined, sightingAt = blockAt) {
	const sample = classifySample(search, observation, position, tick);
	search.tick = Math.max(search.tick, tick);
	// What was seen stays a sighting even when this sample ends a life.
	recordSightings(search, observation?.sighted && typeof observation.sighted === 'object' ? observation.sighted : {}, tick, sightingAt, seenWith(observation));
	if (sample.ended) { search.motion = null; search.odometer.recent = []; return sample; }
	const odometer = search.odometer;
	const previous = search.motion;
	const same = sample.continuity === 'same';
	// A respawn, teleport or unexplained gap starts a new recent walk.
	if (!same) odometer.recent = [];
	if (same) {
		odometer.travelled += Math.hypot(position.x - previous.x, position.z - previous.z);
		const crumbs = odometer.recent ??= [];
		if (crumbs.length === 0 || odometer.travelled - crumbs.at(-1).at >= RECENT_SPACING) {
			crumbs.push({ x: position.x, y: position.y, z: position.z, at: odometer.travelled });
			if (crumbs.length > RECENT_CRUMBS) crumbs.shift();
		}
	}
	// Ground level carries across airborne samples of one motion, so a fall counts on landing; a break or gap forgets it.
	let groundY = same ? previous.groundY : undefined;
	if (sample.groundY !== null) {
		if (groundY !== undefined) {
			const change = sample.groundY - groundY;
			if (change < 0) odometer.descended -= change; else odometer.climbed += change;
		}
		groundY = sample.groundY;
		const key = sectorKey(position.x, position.z), stood = search.trail.get(key);
		if (stood === undefined) {
			search.trail.set(key, { x: Math.floor(position.x), y: groundY, z: Math.floor(position.z), tick });
			if (search.trail.size > LIMITS.trail) search.trail.delete(oldest(search.trail));
		} else Object.assign(stood, { x: Math.floor(position.x), y: groundY, z: Math.floor(position.z), tick });
	}
	// A sample without a teleport mark keeps the last one seen, so an expired mark is not mistaken for a new teleport.
	search.motion = { x: position.x, y: position.y, z: position.z, tick, standing: sample.standing, carried: sample.carried, teleportTick: sample.teleportTick ?? previous?.teleportTick, ...(groundY === undefined ? {} : { groundY }) };
	odometer.start ??= roundPoint(position);
	const landmarks = observation?.landmarks ?? observation?.world?.landmarks;
	if (Array.isArray(landmarks) && landmarks.length > 0) {
		const eyeY = position.y + EYE_HEIGHT;
		// Many landmarks share a sector: each is looked up and touched once per sample (this runs on every observation).
		const sectors = new Map();
		for (const mark of landmarks) {
			if (typeof mark?.blockId !== 'string' || !Number.isFinite(mark.x) || !Number.isFinite(mark.y) || !Number.isFinite(mark.z)) continue;
			const sectorX = Math.floor(mark.x / SECTOR_SIZE), sectorZ = Math.floor(mark.z / SECTOR_SIZE);
			const local = sectorX * 4_000_000 + sectorZ;
			let sector = sectors.get(local);
			if (sector === undefined) {
				const key = `${sectorX},${sectorZ}`;
				let entry = search.seen.get(key);
				if (entry === undefined) {
					entry = { tick };
					search.seen.set(key, entry);
					if (search.seen.size > LIMITS.seen) evictOldestSeen(search);
				} else entry.tick = tick;
				sector = { key, entry, best: null };
				sectors.set(local, sector);
			}
			const dx = mark.x - position.x, dz = mark.z - position.z;
			// A block whose top lies below the eye may show its top face; whether it did, and whether it can be stood on, is unknown.
			if (mark.y + 1 > eyeY - 0.25 || dx * dx + dz * dz < 4 || !surfaceBlock(mark)) continue;
			if (sector.best === null || mark.y > sector.best.y) sector.best = mark;
		}
		// Only the highest candidate per sector is checked for cover; a covered one leaves the older surface in place. The
		// same surface seen again only refreshes its tick: a block seen above it since then already dropped it at ingest.
		for (const { key, entry, best } of sectors.values()) {
			if (best === null) continue;
			const kept = entry.surface;
			if (kept !== undefined && kept.x === best.x && kept.y === best.y && kept.z === best.z && kept.blockId === best.blockId) kept.tick = tick;
			else if (!covered(blockAt, best.x, best.y, best.z)) setSurface(search, key, entry, { x: best.x, y: best.y, z: best.z, blockId: best.blockId, tick });
		}
	}
	return sample;
}

/**
 * A block just observed at "x,y,z": a retained surface there with another material, or a solid block in the two cells
 * above one, disproves it. The surface is forgotten (the sector's sighting history stays) until it is seen again.
 */
export function contradictSurface(search, key, blockId) {
	const hit = search.surfaceCells.get(key);
	if (hit === undefined) return;
	const entry = search.seen.get(hit.sector);
	if (entry?.surface === undefined) { search.surfaceCells.delete(key); return; }
	if (hit.above ? !AIR.test(blockId) : blockId !== entry.surface.blockId) dropSurface(search, entry);
}

/** Records one completed survey attempt with the pose and sight range the server used. */
export function recordLook(search, { x, y, z, yaw, pitch, range, tick }) {
	if (![x, y, z, yaw, pitch, range].every(Number.isFinite) || range < 0 || !Number.isSafeInteger(tick)) return;
	const key = sectorKey(x, z);
	const index = search.looks.findIndex((look) => sectorKey(look.x, look.z) === key && Math.abs(wrap(look.yaw - yaw)) <= 20 && Math.abs(look.pitch - pitch) <= 20);
	if (index >= 0) search.looks.splice(index, 1);
	search.looks.push({ x: Math.round(x), y: Math.round(y), z: Math.round(z), yaw: Math.round(yaw), pitch: Math.round(pitch), range: Math.round(range), tick });
	if (search.looks.length > LIMITS.looks) search.looks.shift();
}

/**
 * Keeps what passive sightings and survey rows showed, with position: structures, portals, bells, beds and villager
 * workstations, possibly player-built clusters, roomy caves, exposed ore veins and lava. Biomes and other
 * notable blocks stay in their own results.
 */
export function recordSightings(search, sighted, tick, blockAt = () => undefined, seen = {}) {
	const rows = (kind) => Array.isArray(sighted[kind]) ? sighted[kind].filter((row) => row !== null && typeof row === 'object') : [];
	const keep = (row, what, kind, cell, extra = {}) => {
		if (typeof what !== 'string' || what.length === 0 || what.length > 256 || ![row.x, row.y, row.z].every(Number.isFinite)) return;
		// The server repeats rows it announced for a while: a withdrawn cell comes back only with a remembered direct
		// sighting of its block newer than the withdrawal.
		const at = `${row.x},${row.y},${row.z}`, withdrawnAt = search.withdrawn.get(at);
		if (withdrawnAt !== undefined && SAME_BLOCK[kind] !== undefined) {
			const block = blockAt(row.x, row.y, row.z);
			if (!(block !== undefined && block.lastSeenTick > withdrawnAt && SAME_BLOCK[kind]({ what }, block.blockId))) return;
			search.withdrawn.delete(at);
		}
		const key = `${what}@${Math.floor(row.x / cell)},${TRANSIENT.has(kind) ? `${Math.floor(row.y / cell)},` : ''}${Math.floor(row.z / cell)}`;
		// A far row does not show the spawner's mob; a closer look that did stays known.
		const mob = extra.mob ?? search.sightings.get(key)?.mob;
		touchSighting(search.sightings, key,
			{ what, x: row.x, y: row.y, z: row.z, ...(Number.isFinite(row.size) ? { size: row.size } : {}), kind, ...extra, ...(mob ? { mob } : {}), tick });
	};
	const nether = seen.dimension === 'minecraft:the_nether';
	for (const row of rows('structures')) {
		if (typeof row.structure === 'string') keep(row, row.structure, 'structure', 32);
		else if (notableBuilt(row) && !ownSighting('built', row, search.placed)) keep(row, `built:${row.blocks.join('+')}`, 'built', 32);
	}
	for (const row of rows('poi')) {
		if (typeof row.blockId !== 'string' || ownSighting('poi', row, search.placed)) continue;
		if (row.blockId.includes('portal')) keep(row, row.blockId, 'portal', 32);
		else if (VILLAGE_POI.test(row.blockId)) keep(row, row.blockId, 'poi', 16);
	}
	for (const row of rows('built')) if (notableBuilt(row) && !ownSighting('built', row, search.placed)) keep(row, `built:${row.blocks.join('+')}`, 'built', 32);
	for (const row of rows('caves')) if (Number.isFinite(row.air) && row.air >= CAVE_MIN_AIR) keep(row, 'cave', 'cave', 16, { air: row.air });
	for (const row of rows('veins')) if (Number.isFinite(row.visible)) keep(row, row.blockId, 'vein', 8, { visible: row.visible });
	for (const row of rows('blocks')) {
		if (row.blockId === 'minecraft:lava') keep(row, row.blockId, 'lava', 16, Number.isFinite(row.count) ? { count: row.count } : {});
		else if (row.blockId === SPAWNER) keep(row, SPAWNER, 'spawner', 8, nether ? { nether } : {});
	}
	// Up close a player sees the mob spinning inside a spawner, and every mob in sight.
	for (const row of Array.isArray(seen.blocks) ? seen.blocks : []) {
		if (row?.blockId === SPAWNER && typeof row.appearance?.mob === 'string') keep(row, SPAWNER, 'spawner', 8, { mob: row.appearance.mob, ...(nether ? { nether } : {}) });
	}
	for (const row of Array.isArray(seen.entities) ? seen.entities : []) {
		if (!SOURCE_MOBS.has(row?.type) || row.alive === false || row.perceivedBy === 'sound' || ![row.x, row.y, row.z].every(Number.isFinite)) continue;
		keep({ x: Math.floor(row.x), y: Math.floor(row.y), z: Math.floor(row.z) }, row.type, 'mob', 16);
	}
}

/** What a sample shows besides its sighted rows: its dimension, direct block rows and entities, unless only remembered. */
export function seenWith(observation) {
	const remembered = Array.isArray(observation?.continuity?.rememberedSections) ? observation.continuity.rememberedSections : [];
	return { dimension: observation?.world?.dimension,
		...(remembered.includes('blocks') ? {} : { blocks: observation?.blocks }),
		...(remembered.includes('entities') ? {} : { entities: observation?.entities }) };
}

/**
 * Caves, veins and lava share a bounded budget. Evict the oldest row of the most represented kind/material; ties
 * follow recency. A cave or common ore stream must not erase every source of a different material.
 */
function touchSighting(map, key, value) {
	map.delete(key); map.set(key, value);
	if (!TRANSIENT.has(value.kind)) {
		while (map.size > LIMITS.sightings) map.delete(map.keys().next().value);
		return;
	}
	let transient = 0;
	const groups = new Map();
	for (const [rowKey, row] of map) if (TRANSIENT.has(row.kind)) {
		transient += 1;
		const material = row.kind === 'vein' ? `vein:${row.what.replace(':deepslate_', ':')}` : row.kind;
		const group = groups.get(material);
		if (group) group.count += 1; else groups.set(material, { first: rowKey, count: 1 });
	}
	if (transient > TRANSIENT_SIGHTINGS || map.size > LIMITS.sightings) {
		let largest;
		for (const group of groups.values()) if (!largest || group.count > largest.count) largest = group;
		map.delete(largest.first);
	}
}

const SAME_BLOCK = Object.freeze({ vein: (row, blockId) => blockId.replace(':deepslate_', ':') === row.what.replace(':deepslate_', ':'),
	lava: (row, blockId) => blockId === 'minecraft:lava', spawner: (row, blockId) => blockId === SPAWNER, poi: (row, blockId) => blockId === row.what, portal: (row, blockId) => blockId === row.what });

/**
 * Withdraws vein, lava, point-of-interest and portal sightings whose own block a direct observation or a break at
 * least as new shows as something else. blockAt(x, y, z) returns { blockId, tick } or undefined. A vein's other members
 * are announced again by the next row that sees them.
 */
export function contradictSightings(search, blockAt) {
	for (const [key, row] of search.sightings) {
		const same = SAME_BLOCK[sightingKind(row)];
		if (same === undefined) continue;
		const seen = blockAt(row.x, row.y, row.z);
		if (seen === undefined || seen.tick < row.tick || same(row, seen.blockId)) continue;
		search.sightings.delete(key);
		const at = `${row.x},${row.y},${row.z}`;
		search.withdrawn.delete(at); search.withdrawn.set(at, seen.tick);
		if (search.withdrawn.size > LIMITS.withdrawn) search.withdrawn.delete(search.withdrawn.keys().next().value);
	}
}

/** Remembers a block the agent placed (a successful place receipt), latest last; a break at the cell forgets it. */
export function recordPlacement(search, { x, y, z, blockId }, placed = true) {
	if (![x, y, z].every(Number.isSafeInteger)) return;
	const key = `${x},${y},${z}`;
	search.placed.delete(key);
	if (!placed || typeof blockId !== 'string' || blockId.length > 256) return;
	search.placed.set(key, { blockId, x, y, z });
	if (search.placed.size > LIMITS.placed) search.placed.delete(search.placed.keys().next().value);
}

/**
 * Whether a sighted row shows only what the agent placed: a point of interest at a placed cell of the same block, or a
 * built cluster whose seen cell is (within a block, height included) a placed cell, whose every listed block id the
 * agent placed within its extent, and with at least as many such placed blocks as the extent is wide. Anything less
 * certain stays a sighting. placed is a Map or array of { x, y, z, blockId }.
 */
export function ownSighting(kind, row, placed) {
	const rows = placed instanceof Map ? [...placed.values()] : placed ?? [];
	if (rows.length === 0 || ![row?.x, row?.z].every(Number.isFinite)) return false;
	if (kind === 'poi') return rows.some((p) => p.x === row.x && p.y === row.y && p.z === row.z && p.blockId === row.blockId);
	if (kind !== 'built' || !Array.isArray(row.blocks) || row.blocks.length === 0) return false;
	if (!rows.some((p) => Math.max(Math.abs(p.x - row.x), Math.abs(p.y - row.y), Math.abs(p.z - row.z)) <= 1)) return false;
	const size = Number.isSafeInteger(row.size) && row.size > 0 ? row.size : 1, reach = size + BUILT_SLACK;
	const near = rows.filter((p) => row.blocks.includes(p.blockId) && Math.max(Math.abs(p.x - row.x), Math.abs(p.y - row.y), Math.abs(p.z - row.z)) <= reach);
	return row.blocks.every((id) => near.some((p) => p.blockId === id)) && near.length >= size;
}

// These materials alone can be terrain rather than evidence of a building.
const NATURAL_BUILT_BLOCK = /(^|:)(snow_block|snow|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|stone|deepslate|granite|diorite|andesite|tuff|calcite|sand|red_sand|gravel|clay|mud|moss_block|ice|packed_ice|blue_ice|netherrack|basalt|blackstone|end_stone)$|_(ore|log|wood|leaves)$/;

/** A built cluster needs size and some constructed material before it is a useful remembered place. */
export function notableBuilt(row) {
	const blocks = row.blocks ?? String(row.what ?? '').replace(/^built:/, '').split('+');
	return Number.isFinite(row.size) && row.size >= 6 && Array.isArray(blocks) && blocks.length > 0
		&& blocks.every((id) => typeof id === 'string' && id.length > 0) && blocks.some((id) => !NATURAL_BUILT_BLOCK.test(id));
}

/** Legacy prefixes and unnamed material rows still identify built clusters. */
export function sightingKind(row) {
	if (row.what?.startsWith('built:') || (!row.kind || row.kind === 'structure')
		&& (row.what?.includes('+') || NATURAL_BUILT_BLOCK.test(row.what))) return 'built';
	return row.kind ?? (/portal/.test(row.what) ? 'portal' : 'structure');
}

/**
 * Where the player stood, and seen surfaces: blocks seen below the eye, one per sector, each with its own observation
 * tick. A surface later seen changed, or covered within two blocks, is dropped.
 */
export function footings(search, blockAt = () => undefined) {
	const result = [];
	for (const [key, stood] of search.trail) result.push({ key, x: stood.x, y: stood.y, z: stood.z, footing: 'stood', tick: stood.tick });
	for (const [key, entry] of search.seen) {
		const surface = entry.surface;
		if (surface === undefined) continue;
		const now = blockAt(surface.x, surface.y, surface.z);
		if (now !== undefined && now.blockId !== surface.blockId) continue;
		if (covered(blockAt, surface.x, surface.y, surface.z)) continue;
		const stood = search.trail.get(key);
		if (stood !== undefined && Math.abs(stood.y - (surface.y + 1)) < 4) continue;
		result.push({ key, x: surface.x, y: surface.y + 1, z: surface.z, footing: 'seen_surface', tick: surface.tick, visited: stood !== undefined });
	}
	return result;
}

/** Whether a later survey from near here faced a heading: the newest such attempt's sight range and tick. */
function surveyFacing(search, position, index) {
	const headingYaw = index * 45;
	let best = null;
	for (const look of search.looks) {
		// Surveys record the eye; a survey from a different vertical level (surface versus cave) saw different terrain.
		const dy = Number.isFinite(position.y) ? look.y - (position.y + EYE_HEIGHT) : 0;
		if (Math.hypot(look.x - position.x, dy, look.z - position.z) > SURVEY_NEAR) continue;
		const dot = Math.cos(look.pitch * Math.PI / 180) * Math.cos(wrap(look.yaw - headingYaw) * Math.PI / 180);
		if (dot < VIEW_DOT) continue;
		if (best === null || look.tick > best.tick || look.tick === best.tick && look.range > best.range) best = look;
	}
	return best;
}

export function summarizeSearch(search, position, { sightingLimit = 6, odometer: withOdometer = true, tick = search.tick } = {}) {
	const walked = new Array(8).fill(0), seen = new Array(8).fill(0);
	const farthest = (target, x, z) => {
		const distance = Math.hypot(x - position.x, z - position.z);
		if (distance < NEAR) return;
		const index = HEADINGS.indexOf(headingOf(x - position.x, z - position.z));
		target[index] = Math.max(target[index], distance);
	};
	for (const stood of search.trail.values()) farthest(walked, stood.x + 0.5, stood.z + 0.5);
	for (const key of search.seen.keys()) {
		const [sx, sz] = key.split(',').map(Number);
		farthest(seen, (sx + 0.5) * SECTOR_SIZE, (sz + 0.5) * SECTOR_SIZE);
	}
	const headings = {};
	for (let index = 0; index < 8; index += 1) {
		const look = surveyFacing(search, position, index);
		if (walked[index] + seen[index] === 0 && look === null) continue;
		headings[HEADINGS[index]] = [Math.round(walked[index]), Math.round(seen[index]), ...(look === null ? [] : [look.range, Math.max(0, Math.round((tick - look.tick) / 20))])];
	}
	const odometer = search.odometer;
	// Coverage lists places to go back to (spawners too); caves, veins, lava, mobs and single points of interest are in the need options instead.
	const sightings = [...search.sightings.values()].filter((row) => !TRANSIENT.has(sightingKind(row)) && sightingKind(row) !== 'poi' && (sightingKind(row) !== 'built' || notableBuilt(row))).map((row) => ({ what: row.what, x: row.x, y: row.y, z: row.z, ...(row.size === undefined ? {} : { size: row.size }), ...(row.mob === undefined ? {} : { mob: row.mob }),
		distance: Math.round(Math.hypot(row.x - position.x, row.z - position.z)), heading: headingOf(row.x - position.x, row.z - position.z) }))
		.sort((left, right) => left.distance - right.distance);
	const recent = withOdometer ? recentTravel(odometer, position) : null;
	return {
		...(withOdometer ? { travelled: Math.round(odometer.travelled), descended: odometer.descended, climbed: odometer.climbed, ...(odometer.start === undefined ? {} : { start: odometer.start }) } : {}),
		...(recent === null ? {} : { recent }),
		headings,
		...(Object.keys(headings).length === 0 ? {} : { legend: Object.values(headings).some(row => row.length > 2)
			? 'max[walk,seen];nearFullSurvey[range,ageS]' : '[farthest walked,seen]' }),
		sightings: sightings.slice(0, sightingLimit), ...(sightings.length > sightingLimit ? { moreSightings: sightings.length - sightingLimit } : {}),
	};
}

/**
 * Useful displacement over the recent walk: blocks walked since the oldest retained breadcrumb, straight-line distance
 * from it to here, and how many breadcrumbs lie on ground already walked through. Null until 32 blocks are walked.
 */
export function recentTravel(odometer, position) {
	const crumbs = odometer.recent ?? [];
	if (crumbs.length < 2) return null;
	const walked = odometer.travelled - crumbs[0].at;
	if (walked < 4 * RECENT_SPACING) return null;
	let revisits = 0;
	for (let index = 2; index < crumbs.length; index += 1) {
		const crumb = crumbs[index];
		for (let earlier = 0; earlier < index - 1; earlier += 1) {
			const dy = crumb.y - crumbs[earlier].y;
			// An eight-block sphere alone still merges ordinary floors four blocks apart.
			if (Math.abs(dy) < 1 && Math.hypot(crumb.x - crumbs[earlier].x, dy, crumb.z - crumbs[earlier].z) <= RECENT_SPACING) { revisits += 1; break; }
		}
	}
	return { walked: Math.round(walked), net: Math.round(Math.hypot(position.x - crumbs[0].x, position.y - crumbs[0].y, position.z - crumbs[0].z)), revisits };
}

/** Starts one move's measurement from the latest sample: its feet Y, and its ground only if it was standing. */
export function startTravel(search) {
	const motion = search.motion;
	if (motion === null) return null;
	// A last grounded Y from before a jump or fall is not where this move starts.
	const startGround = motion.standing === true ? motion.groundY : null;
	return { startFeetY: motion.y, feetY: motion.y, tick: motion.tick, previousGround: startGround, lowestGround: startGround, descended: 0, climbed: 0, gaps: 0,
		broken: false, startStanding: motion.standing, endStanding: motion.standing, before: null };
}

/** Folds one classified sample into a move's measurement. */
export function advanceTravel(travel, sample) {
	if (travel === null || travel.broken) return;
	if (sample.continuity === 'break') { travel.broken = true; return; }
	// The measurement before this sample, so an authoritative terminal at the same tick replaces it instead of adding to it.
	const { before, ...state } = travel;
	travel.before = { ...state, sample };
	if (sample.continuity === 'gap') { travel.gaps += 1; travel.previousGround = null; }
	travel.feetY = sample.feetY;
	travel.tick = sample.tick;
	travel.endStanding = sample.standing;
	if (sample.groundY === null) return;
	if (travel.previousGround !== null) {
		const change = sample.groundY - travel.previousGround;
		if (change < 0) travel.descended -= change; else travel.climbed += change;
	}
	travel.previousGround = sample.groundY;
	travel.lowestGround = travel.lowestGround === null ? sample.groundY : Math.min(travel.lowestGround, sample.groundY);
}

/**
 * Ends a move's measurement, folding in the terminal sample once when it is newer than the last ingested one. Feet
 * displacement is exact; descended/climbed only add ground changes between sampled footholds, so they are lower bounds.
 */
export function finishTravel(travel, search, terminal = null) {
	if (travel === null || travel.broken) return null;
	let result = { ...travel };
	if (terminal !== null && terminal.position !== null) {
		const tick = Number.isSafeInteger(terminal.tick) ? terminal.tick : null;
		const moved = search.motion === null || terminal.position.x !== search.motion.x || terminal.position.y !== search.motion.y || terminal.position.z !== search.motion.z;
		if (tick === null ? moved : tick > travel.tick) advanceTravel(result, classifySample(search, terminal.observation, terminal.position, tick ?? (search.motion?.tick ?? 0) + 1));
		else if (tick === travel.tick) result = sameTickTerminal(result, terminal);
		if (result.broken) return null;
	}
	return {
		feetDy: Math.round((result.feetY - result.startFeetY) * 10) / 10,
		...(result.descended > 0 ? { descendedAtLeast: result.descended } : {}),
		...(result.climbed > 0 ? { climbedAtLeast: result.climbed } : {}),
		...(result.lowestGround === null ? {} : { lowestGroundY: result.lowestGround }),
		// Standing is stated only when a sample showed it; otherwise false (airborne, swimming, riding) or unknown.
		...(result.startStanding === true ? {} : { startOnGround: result.startStanding ?? 'unknown' }),
		...(result.endStanding === true ? {} : { endOnGround: result.endStanding ?? 'unknown' }),
		...(result.gaps > 0 ? { unexplainedGaps: result.gaps } : {}),
	};
}

/**
 * Reconciles an authoritative terminal sample taken in the same tick as the last ingested one: its position replaces
 * that sample's, its grounding too when it states one. The last sample's ground change is undone first, so it is not
 * counted twice. Without a grounding fact of its own, the terminal keeps the last sample's only at the same position.
 */
function sameTickTerminal(travel, terminal) {
	const previous = travel.before?.sample;
	const restored = travel.before === null ? { ...travel } : { ...travel.before, before: null };
	delete restored.sample;
	const own = grounded(bodyOf(terminal.observation));
	const samePosition = previous !== undefined ? previous.feetY === terminal.position.y : travel.feetY === terminal.position.y;
	const standing = own ?? (samePosition ? (previous?.standing ?? travel.endStanding) : null);
	advanceTravel(restored, {
		continuity: previous?.continuity ?? 'same', ended: false, standing, feetY: terminal.position.y, tick: travel.tick,
		groundY: standing === true ? Math.floor(terminal.position.y + 1e-3) : null,
	});
	return restored;
}

export function serializeSearch(search) {
	const { travelled, descended, climbed, start } = search.odometer;
	// Motion continuity is not saved: a restart can follow any amount of unobserved movement.
	return { trail: [...search.trail.entries()], seen: [...search.seen.entries()], looks: search.looks, sightings: [...search.sightings.entries()], withdrawn: [...search.withdrawn.entries()], placed: [...search.placed.values()], odometer: { travelled, descended, climbed, ...(start === undefined ? {} : { start }) } };
}

/** Restores saved coverage, dropping malformed entries instead of failing the whole memory file. */
export function restoreSearch(saved) {
	const search = createSearch();
	if (saved === null || typeof saved !== 'object') return search;
	const point = (value) => value && [value.x, value.y, value.z].every(Number.isFinite);
	const entries = (list, valid, limit) => (Array.isArray(list) ? list : []).filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && valid(entry[1])).slice(-limit);
	search.trail = new Map(entries(saved.trail, (value) => point(value) && Number.isSafeInteger(value.tick), LIMITS.trail));
	// Older files kept one undated "top" per sector; only surfaces with their own observation tick are restored.
	search.seen = new Map(entries(saved.seen, (value) => Number.isSafeInteger(value.tick), LIMITS.seen).map(([key, value]) => [key, { tick: value.tick }]));
	for (const [key, value] of entries(saved.seen, (value) => Number.isSafeInteger(value.tick), LIMITS.seen)) {
		const surface = value.surface;
		if (point(surface) && typeof surface.blockId === 'string' && Number.isSafeInteger(surface.tick)) {
			setSurface(search, key, search.seen.get(key), { x: surface.x, y: surface.y, z: surface.z, blockId: surface.blockId, tick: surface.tick });
		}
	}
	search.sightings = new Map(entries(saved.sightings, (value) => point(value) && typeof value.what === 'string' && Number.isSafeInteger(value.tick), LIMITS.sightings));
	for (const row of Array.isArray(saved.placed) ? saved.placed.slice(-LIMITS.placed) : []) if (row && typeof row === 'object') recordPlacement(search, row);
	search.withdrawn = new Map((Array.isArray(saved.withdrawn) ? saved.withdrawn : []).filter((entry) => Array.isArray(entry) && /^-?\d+,-?\d+,-?\d+$/.test(entry[0]) && Number.isSafeInteger(entry[1])).slice(-LIMITS.withdrawn));
	// Older files kept pitchless cones without a measured range; those are not evidence of a survey and are dropped.
	search.looks = (Array.isArray(saved.looks) ? saved.looks : []).filter((look) => point(look) && [look.yaw, look.pitch, look.range].every(Number.isFinite) && Number.isSafeInteger(look.tick)).slice(-LIMITS.looks);
	search.tick = Math.max(0, ...[...search.trail.values(), ...search.seen.values(), ...search.looks].map((value) => value.tick));
	const odometer = saved.odometer ?? {};
	for (const field of ['travelled', 'descended', 'climbed']) if (Number.isFinite(odometer[field]) && odometer[field] >= 0) search.odometer[field] = odometer[field];
	if (point(odometer.start)) search.odometer.start = roundPoint(odometer.start);
	return search;
}

const footingIds = new Map();
function surfaceBlock(mark) {
	let footing = footingIds.get(mark.blockId);
	if (footing === undefined) {
		footing = !NON_FOOTING.test(mark.blockId);
		if (footingIds.size < 4096) footingIds.set(mark.blockId, footing);
	}
	if (!footing) return false;
	if (Array.isArray(mark.tags)) for (const tag of mark.tags) if (NON_FULL_TAGS.has(tag)) return false;
	return true;
}

/** A remembered non-air block in the two cells above means the top is roofed or buried there. */
function covered(blockAt, x, y, z) {
	for (let dy = 1; dy <= 2; dy += 1) {
		const above = blockAt(x, y + dy, z);
		if (above !== undefined && !AIR.test(above.blockId)) return true;
	}
	return false;
}

/** Stores a sector's surface and indexes its block and the two cells above, where a later observation can disprove it. */
function setSurface(search, sector, entry, surface) {
	if (entry.surface !== undefined) dropSurface(search, entry);
	entry.surface = surface;
	for (let dy = 0; dy <= 2; dy += 1) search.surfaceCells.set(`${surface.x},${surface.y + dy},${surface.z}`, { sector, above: dy > 0 });
}

function dropSurface(search, entry) {
	const { x, y, z } = entry.surface;
	for (let dy = 0; dy <= 2; dy += 1) search.surfaceCells.delete(`${x},${y + dy},${z}`);
	delete entry.surface;
}

/** Trail and sectors update in place and are kept by their latest tick: the oldest goes when a new one exceeds the bound. */
function oldest(map) {
	let oldestKey, oldestTick = Infinity;
	for (const [key, entry] of map) if (entry.tick < oldestTick) { oldestKey = key; oldestTick = entry.tick; }
	return oldestKey;
}

function evictOldestSeen(search) {
	const key = oldest(search.seen), entry = search.seen.get(key);
	if (entry.surface !== undefined) dropSurface(search, entry);
	search.seen.delete(key);
}

function roundPoint(value) { return { x: Math.round(value.x), y: Math.round(value.y), z: Math.round(value.z) }; }
function wrap(degrees) { return ((degrees + 540) % 360) - 180; }
