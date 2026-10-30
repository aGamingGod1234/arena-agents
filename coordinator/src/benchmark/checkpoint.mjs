/** Save points: rebuild a real game's state at a milestone as a long-run start on the same seed.
 * Terrain regenerates from the seed, so blocks the agent placed or dug are gone; portals it used are rebuilt. */
const DIMS = { overworld: 'minecraft:overworld', nether: 'minecraft:the_nether', end: 'minecraft:the_end' };

export const NAMED_MILESTONES = {
	iron_pickaxe: 'item:minecraft:iron_pickaxe>=1',
	nether: 'dim:nether',
	fortress: 'adv:nether/find_fortress',
	blaze_rods: 'item:minecraft:blaze_rod>=6',
	pearls: 'item:minecraft:ender_pearl>=12',
	eyes: 'item:minecraft:ender_eye>=12',
	stronghold: 'adv:story/follow_ender_eye',
	end: 'dim:end',
};

export function parseInventory(nbt) {
	const items = [];
	for (const m of String(nbt ?? '').matchAll(/\{(?:components: \{(.*?)\}, )?count: (\d+), Slot: (\d+)b, id: "([^"]+)"\}/g)) {
		const damage = m[1]?.match(/"minecraft:damage": (\d+)/)?.[1];
		items.push({ id: m[4], count: Number(m[2]), slot: Number(m[3]), damage: damage === undefined ? null : Number(damage) });
	}
	return items;
}

// Slot names live in the player record (`equipment: {head: ..., offhand: ...}`); the sampled equipment list has neither names nor the offhand.
export function parseEquipment(entityNbt, equipmentNbt = '') {
	const out = {};
	const map = String(entityNbt ?? '').match(/\bequipment: \{(.*?\})\}(?:, [A-Za-z_]+:|\}$)/)?.[1] ?? '';
	for (const m of map.matchAll(/(head|chest|legs|feet|offhand): \{(?:components: \{(.*?)\}, )?count: \d+, id: "([^"]+)"\}/g)) {
		const damage = m[2]?.match(/"minecraft:damage": (\d+)/)?.[1];
		out[m[1]] = { id: m[3], damage: damage === undefined ? null : Number(damage) };
	}
	if (Object.keys(out).length) return out;
	for (const m of String(equipmentNbt ?? '').matchAll(/\{(?:components: \{(.*?)\}, )?count: \d+, id: "([^"]+)"\}/g)) {
		const slot = { helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' }[m[2].match(/_(helmet|chestplate|leggings|boots)$/)?.[1]];
		const damage = m[1]?.match(/"minecraft:damage": (\d+)/)?.[1];
		if (slot) out[slot] = { id: m[2], damage: damage === undefined ? null : Number(damage) };
	}
	return out;
}

const countOf = (sample, id) => parseInventory(sample.inventoryNbt).filter(i => i.id === id).reduce((n, i) => n + i.count, 0)
	+ Object.values(parseEquipment(sample.entityNbt, sample.equipmentNbt)).filter(i => i.id === id).length;

/** `item:<id>>=N`, `dim:<overworld|nether|end>`, `adv:<path>`, `minute:<M>` (from the first sample), `at:<epochMs>` (the first sample at or after that wall time), or a name in NAMED_MILESTONES. */
export function milestoneTest(spec) {
	const text = NAMED_MILESTONES[spec] ?? spec;
	let m;
	if ((m = text.match(/^item:([a-z0-9_:]+)>=(\d+)$/))) return (s) => countOf(s, m[1]) >= Number(m[2]);
	if ((m = text.match(/^dim:(overworld|nether|end)$/))) return (s) => s.dimension === DIMS[m[1]];
	if ((m = text.match(/^adv:([a-z0-9_\/]+)$/))) return (s) => (s.advancements ?? []).includes(m[1]);
	if ((m = text.match(/^minute:(\d+(?:\.\d+)?)$/))) { const ms = Number(m[1]) * 60000; return (s, first) => s.at - first.at >= ms; }
	if ((m = text.match(/^at:(\d+)$/))) { const at = Number(m[1]); return (s) => s.at >= at; }
	throw new TypeError(`Unknown milestone ${spec}; use ${Object.keys(NAMED_MILESTONES).join(', ')} or item:/dim:/adv:/minute:/at:`);
}

const withDamage = (id, damage) => damage ? `${id}[minecraft:damage=${damage}]` : id;
const block = (p) => p.map(Math.floor);

// An x-axis portal whose two lower portal blocks start at the given cell.
function portalCommands(dimension, [x, y, z]) {
	return [
		`execute in ${dimension} run fill ${x - 1} ${y - 1} ${z} ${x + 2} ${y + 3} ${z} minecraft:obsidian`,
		// Open both sides so the agent can step out; only plain ground is cleared, never lava or water.
		...['#minecraft:replaceable', '#minecraft:base_stone_overworld', '#minecraft:base_stone_nether', '#minecraft:dirt'].map(tag => `execute in ${dimension} run fill ${x} ${y} ${z - 1} ${x + 1} ${y + 2} ${z + 1} minecraft:air replace ${tag}`),
		`execute in ${dimension} run fill ${x} ${y} ${z} ${x + 1} ${y + 2} ${z} minecraft:nether_portal[axis=x]`,
	];
}

// The fixture of a used bed whose foot is at x,y,z (head one block east), and the spawn it sets.
const bedFixture = (ow, [x, y, z]) => ({
	commands: [
		`execute in ${ow} run fill ${x - 1} ${y - 1} ${z - 1} ${x + 2} ${y - 1} ${z + 1} minecraft:stone`,
		`execute in ${ow} run fill ${x - 1} ${y} ${z - 1} ${x + 2} ${y + 1} ${z + 1} minecraft:air`,
		`execute in ${ow} run setblock ${x} ${y} ${z} minecraft:red_bed[facing=east,part=foot]`,
		`execute in ${ow} run setblock ${x + 1} ${y} ${z} minecraft:red_bed[facing=east,part=head]`],
	finalCommand: `execute in ${ow} run spawnpoint {agent} ${x} ${y} ${z}`,
});

/**
 * A prepared player's respawn: a bed placed and used in the Overworld, its foot at {@code foot} and its head one block
 * east. The cells round it are cleared to air over a stone floor so the bed stands and the body can stand up beside it;
 * the spawn is set by a vanilla bed interaction during preparation, without a forced spawn. A bed the
 * save point already had is taken away (a player has one spawn). With {@code item}, a spare bed goes in the bag.
 * Mutates and returns the checkpoint.
 */
export function withBedSpawn(checkpoint, [x, y, z], { item = false } = {}) {
	const setup = checkpoint.setup, ow = DIMS.overworld;
	const previous = checkpoint.bedSpawn?.dimension === ow ? checkpoint.bedSpawn.position : null;
	if (previous) {
		const old = bedFixture(ow, previous);
		setup.commands = setup.commands.filter(c => !old.commands.includes(c));
		setup.finalCommands = (setup.finalCommands ?? []).filter(c => c !== old.finalCommand);
		setup.loadChunks = (setup.loadChunks ?? []).filter(c => !(c.dimension === ow && c.position.join() === previous.join()));
		checkpoint.notes = (checkpoint.notes ?? []).filter(n => !n.startsWith('Respawn point: a red bed at '));
	}
	const bed = bedFixture(ow, [x, y, z]);
	setup.commands = [...setup.commands, ...bed.commands];
	setup.loadChunks = [...(setup.loadChunks ?? []).filter(c => !(c.dimension === ow && c.position.join() === [x, y, z].join())), { dimension: ow, position: [x, y, z] }].slice(-8);
	setup.usedBedSpawn = { dimension: ow, position: [x, y, z] };
	if (item) setup.inventory = [...setup.inventory, { item: 'minecraft:red_bed', count: 1 }];
	checkpoint.bedSpawn = { dimension: ow, position: [x, y, z] };
	checkpoint.notes = [...(checkpoint.notes ?? []).filter(n => !/bed spawn is not restored/.test(n)),
		`Respawn point: a red bed at ${x},${y},${z} in the Overworld (foot; head east), used through vanilla bed interaction; breaking it restores world-spawn recovery.${item ? ' A spare bed is in the bag.' : ''}`];
	return checkpoint;
}

/** The last overworld<->nether crossing at or before index i: the cell left behind and the cell arrived at. */
export function lastCrossing(samples, i) {
	for (let j = i; j > 0; j--) {
		const a = samples[j - 1], b = samples[j];
		const pair = new Set([a.dimension, b.dimension]);
		if (a.dimension !== b.dimension && pair.has(DIMS.overworld) && pair.has(DIMS.nether)) {
			const ow = a.dimension === DIMS.overworld ? a : b, ne = a.dimension === DIMS.nether ? a : b;
			return { overworld: block([ow.position.x, ow.position.y, ow.position.z]), nether: block([ne.position.x, ne.position.y, ne.position.z]) };
		}
	}
	return null;
}

export function buildCheckpoint(samples, { milestone, seed, source = null }) {
	if (!samples.length) throw new Error('No samples');
	const test = milestoneTest(milestone);
	const index = samples.findIndex(s => test(s, samples[0]));
	if (index < 0) throw new Error(`Milestone ${milestone} never reached in this game`);
	const s = samples[index];
	const pos = [s.position.x, s.position.y, s.position.z];
	const equipment = parseEquipment(s.entityNbt, s.equipmentNbt);
	const inventory = parseInventory(s.inventoryNbt).map(i => ({ item: withDamage(i.id, i.damage), count: i.count }));
	// The armour fixture covers the four armour slots; an offhand item (usually a shield) goes back in the bag.
	if (equipment.offhand) inventory.push({ item: withDamage(equipment.offhand.id, equipment.offhand.damage), count: 1 });
	const armour = Object.fromEntries(['head', 'chest', 'legs', 'feet'].filter(k => equipment[k]).map(k => [k, withDamage(equipment[k].id, equipment[k].damage)]));
	const setup = { dimension: s.dimension, position: pos, generality: true, commands: [], inventory, armour, effects: [], mobs: [], freezeUntilGoalStart: true,
		time: Number.isFinite(s.gameTime) ? s.gameTime % 24000 : 1000 };
	// Start on natural ground near the saved spot: a tunnel the agent dug does not exist in the regenerated world.
	if (s.dimension === DIMS.overworld || s.dimension === DIMS.end) setup.groundBelowCanopy = true;
	else Object.assign(setup, { naturalCave: true, caveMaxY: Math.min(120, Math.floor(pos[1]) + 12), caveMinY: Math.max(5, Math.floor(pos[1]) - 12) });
	const crossing = lastCrossing(samples, index);
	if (!crossing && samples[0].dimension === DIMS.nether) {
		// The game began in the Nether at a portal; a lit Nether portal makes its own Overworld exit when used.
		const cell = block([samples[0].position.x, samples[0].position.y, samples[0].position.z]);
		if (s.dimension === DIMS.nether && Math.hypot(cell[0] - pos[0], cell[2] - pos[2]) < 8) cell[2] = Math.floor(pos[2]) + 3;
		setup.loadChunks = [{ dimension: DIMS.nether, position: cell }];
		setup.commands.push(...portalCommands(DIMS.nether, cell));
	}
	if (crossing) {
		// The start search only tries columns 8k blocks from the saved spot, so a portal 3 blocks off cannot swallow the start.
		for (const [dim, cell] of [[DIMS.overworld, crossing.overworld], [DIMS.nether, crossing.nether]])
			if (dim === s.dimension && Math.hypot(cell[0] - pos[0], cell[2] - pos[2]) < 8) cell[2] = Math.floor(pos[2]) + 3;
		setup.loadChunks = [{ dimension: DIMS.overworld, position: crossing.overworld }, { dimension: DIMS.nether, position: crossing.nether }];
		setup.commands.push(...portalCommands(DIMS.overworld, crossing.overworld), ...portalCommands(DIMS.nether, crossing.nether));
	}
	return {
		milestone, sampleIndex: index, minute: Math.round((s.at - samples[0].at) / 600) / 100, seed: String(seed), source,
		priorAdvancements: s.advancements ?? [], deathsBefore: s.deathCounter ?? null, setup,
		notes: ['Terrain regenerates from the seed: placed blocks, chests and dropped items are gone.', 'Respawn point is the world spawn; a bed spawn is not restored.', 'Only tool wear is kept from item components; enchantments are dropped.'],
	};
}
