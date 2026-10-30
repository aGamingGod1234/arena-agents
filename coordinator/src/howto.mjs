// "How do I get X": one requested requirement from the index generated out of Minecraft 26.1's own registries and
// datapack (config/howto-index.json, rebuilt by `gradlew exportHowtoIndex`). Sources are what the game allows, never
// evidence that something exists in this world. The model chooses: sources keep a stable game-data order, a node
// expands on its own only when it has exactly one source, and `<item>/<n>` expands the option the model picked.
import { readFileSync } from 'node:fs';
import { TOOLS } from './plan-checks.mjs';

const INDEX_URL = new URL('../config/howto-index.json', import.meta.url);
export const HOWTO_MAX_LINES = 14;
export const HOWTO_MAX_DEPTH = 3;
export const HOWTO_OPTION_PAGE = 8;
const SCOPE = 'possible per game data and vanilla use rules, not present here';
// Vanilla block and entity use results the game data lists nowhere: [input, one input per item, how].
const USE_SOURCES = {
	water_bucket: [['bucket', true, 'fill at a water source: interact_block on it, or look at it and use_item mode:once']],
	lava_bucket: [['bucket', true, 'fill at a lava source: interact_block on it, or look at it and use_item mode:once']],
	powder_snow_bucket: [['bucket', true, 'fill at powder snow']],
	milk_bucket: [['bucket', true, 'interact_entity with a cow, goat or mooshroom']],
	obsidian: [['water_bucket', false, 'cast: water flowing onto a lava source makes obsidian in place (not in the Nether); refill the bucket from that water']],
};
const BARTER_TABLE = 'gameplay/piglin_bartering';
// Burn ticks one item costs. Blast furnaces and smokers cook twice as fast but burn fuel twice as fast, so all three
// match a furnace per item. Campfires burn no fuel.
const FUEL_TICKS_PER_ITEM = { furnace: 200, blast_furnace: 200, smoker: 200 };
// Brewing stand constants from code: one reagent brews up to three bottles; one blaze powder fuels twenty brews.
const BREW_BOTTLES = 3;
const BREWS_PER_FUEL = 20;
const BREWING_FUEL = 'blaze_powder';
const COOKING = new Set(['furnace', 'blast_furnace', 'smoker', 'campfire']);
const TYPE_ORDER = ['craft', 'use', 'mine', 'kill', 'trade', 'barter', 'loot'];
const FLAG_TEXT = { s: 'silk touch', h: 'shears', t: 'tool', r: 'chance', p: 'grown/state', k: 'player kill', e: 'condition' };
// Sources that come from using a block or fluid, which the registries do not list; vanilla mechanics, not locations.
const BLOCK_USE = { obsidian: 'cast: water onto a lava source (strategy:portals)', lava_bucket: 'fill: empty bucket on a lava source', water_bucket: 'fill: empty bucket on a water source' };
// How a player first enters a dimension; vanilla mechanics with no registry source.
const DIMENSION_ENTRY = { the_nether: 'nether portal: obsidian x10 + flint_and_steel|fire_charge', the_end: 'end portal: 12 ender_eye in a stronghold' };
const WORN_SLOTS = new Set(['head', 'chest', 'legs', 'feet']);
const STOP_WORDS = new Set(['of', 'the', 'a', 'an', 'minecraft']);

let cachedIndex = null;
/** The generated index, read once on first use. */
export function howtoIndex() {
	cachedIndex ??= JSON.parse(readFileSync(INDEX_URL, 'utf8'));
	return cachedIndex;
}

/** Normalizes a topic to an index id; spelled names ("eye of ender") resolve by word match. */
export function resolveHowtoTopic(topic, index = howtoIndex()) {
	const raw = String(topic).trim().toLowerCase().replace(/^(#?)minecraft:/, '$1').replace(/[\s-]+/g, '_');
	const known = knownIds(index);
	if (raw === 'fuel' || known.has(raw)) return { id: raw };
	const words = raw.split(/[_:]+/).filter(word => word && !STOP_WORDS.has(word));
	const candidates = words.length === 0 ? [] : [...known].filter(id => { const parts = id.split(/[_:#]+/); return words.every(word => parts.includes(word)); })
		.sort((a, b) => a.length - b.length || a.localeCompare(b));
	if (candidates.length === 1) return { id: candidates[0], matched: raw };
	return { id: null, candidates: candidates.slice(0, 8), more: Math.max(0, candidates.length - 8) };
}

/** The howto topic for a requirement that is exactly one item or tag the index knows, else null. */
export function howtoTopic(ids) {
	if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string') return null;
	const id = ids[0].replace(/^(#?)minecraft:/, '$1');
	try { return resolveHowtoTopic(id).id === id ? id : null; } catch { return null; }
}

const knownSets = new WeakMap();
function knownIds(index) {
	let known = knownSets.get(index);
	if (known) return known;
	known = new Set();
	for (const key of ['recipes', 'blockDrops', 'mobDrops', 'loot', 'trades', 'harvest', 'worldgen', 'fuels']) for (const id of Object.keys(index[key] ?? {})) known.add(id);
	for (const rows of Object.values(index.recipes ?? {})) for (const row of rows) for (const [spec] of row[2]) for (const id of spec.split('|')) known.add(id);
	for (const [tag, members] of Object.entries(index.tags ?? {})) { known.add(tag); for (const id of members) known.add(id); }
	knownSets.set(index, known);
	return known;
}

/**
 * What the agent has, by kind. Possession: held (carried) and worn (armour slots). Access: placed (its own placed
 * station) and visible (a block in its current observation), each with distance. A dead or unobserved player holds
 * nothing known.
 */
export function howtoHoldings({ observation = null, placedStations = [] } = {}) {
	const items = new Map(), stations = new Map();
	const known = observation?.ready === true && !observation?.player?.dead && Array.isArray(observation?.inventory?.items);
	for (const row of known ? observation.inventory.items : []) {
		const id = shortId(row?.itemId);
		if (!id || !(row.count > 0)) continue;
		const entry = items.get(id) ?? { held: 0, worn: 0, uses: null };
		if (WORN_SLOTS.has(row.slot)) entry.worn += row.count; else entry.held += row.count;
		const uses = Number.isSafeInteger(row.usesLeft) ? row.usesLeft : Number.isSafeInteger(row.maxDamage) && row.maxDamage > 0 && Number.isSafeInteger(row.damage) ? row.maxDamage - row.damage : null;
		if (uses !== null) entry.uses = Math.max(entry.uses ?? 0, uses);
		items.set(id, entry);
	}
	const position = observation?.position ?? observation?.player?.position ?? observation?.player, dimension = observation?.world?.dimension ?? null;
	const distance = row => ['x', 'y', 'z'].every(k => Number.isFinite(position?.[k]) && Number.isFinite(row?.[k])) ? Math.round(Math.hypot(row.x + 0.5 - position.x, row.y + 0.5 - position.y, row.z + 0.5 - position.z)) : null;
	const note = (row, kind) => {
		const id = shortId(row?.blockId);
		if (!id) return;
		const previous = stations.get(id), d = distance(row);
		// The agent's own placement outranks a sighting; otherwise the nearer row wins.
		if (previous && (previous.kind === 'placed' && kind !== 'placed' || (previous.distance ?? Infinity) <= (d ?? Infinity) && previous.kind === kind)) return;
		stations.set(id, { kind, distance: d });
	};
	for (const row of placedStations) if (row && row.available !== false && (row.dimension == null || dimension === null || row.dimension === dimension)) note(row, 'placed');
	if (known) for (const row of [...(observation.blocks ?? []), ...(observation.landmarks ?? [])]) note(row, 'visible');
	return { known, items, stations };
}

/** Direct replacement inputs only: held raw materials do not imply a station or any intermediate crafting. */
export function howtoHeldRecipe(itemId, holdings, { index = howtoIndex() } = {}) {
	if (!holdings.known) return null;
	const query = new Query(index, holdings);
	let missing = null;
	for (const [station, , requirements] of index.recipes[shortId(itemId)] ?? []) {
		const pool = query.pool(), before = new Map(pool);
		const materialsHeld = requirements.every(([spec, count]) => query.reserve(pool, spec, count));
		const recipe = { materialsHeld, station, stationAvailable: station === 'inventory' || query.have(station, 'station').total > 0,
			inputs: materialsHeld ? [...before].flatMap(([id, count]) => count > pool.get(id) ? [{ id, count: count - pool.get(id) }] : []) : [] };
		if (materialsHeld) return recipe;
		missing ??= recipe;
	}
	return missing;
}

/** Bounded answer for one requirement; `<item>/<n>` expands the model's chosen option n. */
export function howto(topic, holdings = howtoHoldings(), { index = howtoIndex(), count = 1, offset = 0 } = {}) {
	const match = String(topic).match(/^(.*?)\/(\d{1,3})$/);
	const resolved = resolveHowtoTopic(match ? match[1] : topic, index);
	if (resolved.id === null) {
		return { howto: String(topic), found: false, scope: SCOPE, ...(resolved.candidates.length ? { candidates: resolved.candidates.map(id => `howto:${id}`), ...(resolved.more ? { moreCandidates: resolved.more } : {}) } : { reason: 'no item with that name in game data' }) };
	}
	if (resolved.id === 'fuel') return fuelAnswer(index, holdings);
	const query = new Query(index, holdings);
	query.node(resolved.id, Math.max(1, count), 0, [], 'item', { option: match ? Number(match[2]) : null, offset });
	return {
		howto: match ? `${resolved.id}/${match[2]}` : resolved.id, ...(resolved.matched ? { matched: resolved.matched } : {}), scope: SCOPE,
		...(holdings.known ? {} : { holdings: 'unknown (no fresh inventory)' }),
		...(BLOCK_USE[resolved.id] ? { blockUse: BLOCK_USE[resolved.id] } : {}),
		tree: query.lines,
		...(query.expand ? { expand: query.expand } : {}),
		...(query.nextOffset !== null ? { nextOffset: query.nextOffset } : {}),
		...(query.missing.length ? { missing: query.missing.slice(0, 5) } : {}),
		...(query.omittedLines || query.cut.size ? { truncated: { ...(query.omittedLines ? { lines: query.omittedLines } : {}), ...(query.cut.size ? { expand: [...query.cut].slice(0, 6).map(id => `howto:${id}`) } : {}) } } : {}),
	};
}

class Query {
	lines = []; missing = []; cut = new Set(); expanded = new Set(); omittedLines = 0; expand = null; nextOffset = null; fuelText = null;
	constructor(index, holdings) { this.index = index; this.holdings = holdings; }

	push(depth, text) {
		if (this.lines.length >= HOWTO_MAX_LINES) { this.omittedLines++; return false; }
		this.lines.push(`${' '.repeat(depth)}${text}`);
		return true;
	}

	node(id, need, depth, ancestors, role, { option = null, offset = 0, free } = {}) {
		if (id === 'fuel') {
			this.leaf('fuel', 'fuel');
			return void this.push(depth, `fuel: ${this.fuelText ?? 'none held'} (howto:fuel)`);
		}
		id = singleton(id, this.index);
		const label = `${role === 'item' ? '' : `${role} `}${display(id, this.index)} x${need}`;
		const have = this.withReservation(this.have(id, role), free);
		if (have.total !== null && have.total >= need) return void this.push(depth, `${label} ok ${have.text}`);
		const haveText = (have.total === null ? 'have ?' : have.text || 'have 0') + this.accessNote(id, role);
		// A requirement already on the path is a cycle: descent stops there, while the source itself stays listed.
		if (ancestors.includes(id)) return void this.push(depth, `${label} ${haveText}: cycle, needed above`);
		if (this.expanded.has(id)) return void this.push(depth, `${label} ${haveText}: see above`);
		this.expanded.add(id);
		const missingCount = have.total === null ? need : need - have.total;
		const members = memberIds(id, this.index);
		if (members.length > 1) {
			// Any member satisfies a tag or alternative list; which one to get is the model's call. A tag topic pages
			// its members; a list from a recipe is short enough to show whole.
			if (!id.startsWith('#')) return void this.push(depth, `${label} ${haveText}: any of ${members.join(', ')}`);
			if (depth === 0) {
				this.push(0, `${label} ${haveText}: any member`);
				this.page(members, offset, (member, number) => `${number} ${member}`);
				return;
			}
			this.leaf(id, 'expand');
			return void this.push(depth, `${label} ${haveText}: any of ${members.slice(0, 3).join(', ')}${members.length > 3 ? ` +${members.length - 3}` : ''} (howto:${id})`);
		}
		const path = [...ancestors, id];
		const options = this.options(id, path, missingCount);
		if (options.length === 0) {
			this.leaf(id, 'unknown');
			return void this.push(depth, `${label} ${haveText}: no source in game data (unknown)`);
		}
		let chosen = options.length === 1 ? options[0] : null;
		if (option !== null) {
			chosen = options[option - 1] ?? null;
			if (!chosen) return void this.push(depth, `${label} ${haveText}: no option ${option}; ${options.length} options (howto:${id})`);
		}
		if (!chosen) {
			if (depth === 0) {
				this.push(0, `${label} ${haveText}: ${options.length} options`);
				this.page(options, offset, (o, number) => `${number} ${this.summary(o)}`);
				this.expand = `howto:${id}/<n>`;
				return;
			}
			this.leaf(id, 'expand');
			const shown = options.slice(0, 2).map((o, i) => `${i + 1} ${this.summary(o, false)}`).join('; ');
			return void this.push(depth, `${label} ${haveText}: ${options.length} options: ${shown}${options.length > 2 ? `; +${options.length - 2}` : ''} (howto:${id})`);
		}
		const number = options.indexOf(chosen) + 1;
		const prefix = option !== null ? `option ${option}/${options.length} ` : '';
		if (!this.push(depth, `${label} ${haveText}: ${prefix}${this.summary(chosen, true)}`)) return;
		// Every member of a grouped source (blocks, mobs, loot tables) stays reachable: the chosen option pages them.
		const groupMembers = groupRows(chosen, this.index);
		if (groupMembers.length > 2) {
			if (depth === 0) this.page(groupMembers, offset, row => `- ${row}`);
			else this.push(depth + 1, `${groupMembers.length} ${chosen.type} sources (howto:${id}/${number})`);
		}
		if (chosen.type !== 'craft') this.leaf(id, chosen.type);
		for (const child of chosen.requirements.filter(r => !r.met)) {
			if (depth + 1 > HOWTO_MAX_DEPTH) { this.cutAt(child.id); continue; }
			if (child.id === 'fuel') this.fuelText = child.text;
			this.node(child.id, child.need, depth + 1, path, child.role, { free: child.free });
		}
	}

	/** One page of numbered rows under the root; `offset` continues where nextOffset points. */
	page(rows, offset, render) {
		rows.slice(offset, offset + HOWTO_OPTION_PAGE).forEach((row, i) => this.push(1, render(row, offset + i + 1)));
		if (offset + HOWTO_OPTION_PAGE < rows.length) this.nextOffset = offset + HOWTO_OPTION_PAGE;
	}

	/** A cut requirement names a follow-up query that resolves: alternatives name their first members. */
	cutAt(id) {
		const resolved = singleton(id, this.index);
		const targets = resolved === 'fuel' ? ['fuel'] : resolved.includes('|') ? resolved.split('|').slice(0, 2) : [resolved];
		for (const target of targets) { this.cut.add(target); this.leaf(target, 'expand'); }
	}

	leaf(id, how) {
		if (this.missing.some(row => row.startsWith(`${id} `))) return;
		this.missing.push(`${id} (${how === 'expand' ? `howto:${id}` : how})`);
	}

	/** Possession only: held and worn items. Placed or visible stations count solely as station access. */
	have(id, role = 'item') {
		if (role === 'station') {
			const access = this.holdings.stations.get(id);
			const held = this.holdings.items.get(id);
			if (access) return { total: 1, text: `${access.kind}${access.distance === null ? '' : ` ${access.distance}m`}` };
			if (held && held.held > 0) return { total: 1, text: 'held' };
			return this.holdings.known ? { total: 0, text: '' } : { total: null, text: '' };
		}
		if (!this.holdings.known || id.startsWith('potion:')) return { total: null, text: '' };
		const ids = memberIds(id, this.index);
		let held = 0, worn = 0, uses = null;
		const kinds = [];
		for (const member of ids) {
			const row = this.holdings.items.get(member);
			if (!row) continue;
			held += row.held; worn += row.worn;
			if (row.uses !== null) uses = Math.max(uses ?? 0, row.uses);
			if (row.held || row.worn) kinds.push(`${member} ${row.held + row.worn}`);
		}
		const parts = [];
		if (held) parts.push(`held ${held}`);
		if (worn) parts.push(`worn ${worn}`);
		if (uses !== null && held + worn > 0) parts.push(`${uses} uses`);
		if (ids.length > 1 && kinds.length && kinds.length <= 2) parts.push(`(${kinds.join(', ')})`);
		return { total: held + worn, text: parts.join(' ') };
	}

	/** Access to a station of this kind, disclosed beside an item query without counting as possession. */
	accessNote(id, role) {
		if (role === 'station') return '';
		const access = this.holdings.stations.get(id);
		return access && this.stationIds().has(id) ? `, ${access.kind}${access.distance === null ? '' : ` ${access.distance}m`}` : '';
	}

	stationIds() {
		this.stationSet ??= new Set(Object.values(this.index.recipes).flatMap(rows => rows.map(row => row[0])).filter(station => station !== 'inventory'));
		return this.stationSet;
	}

	toolStatus(setIndex) {
		const set = this.index.toolSets[setIndex];
		if (!set || set.all.length === 0) return { met: false, text: 'none drops it', id: null };
		let best = null;
		for (const tool of set.all) {
			const row = this.holdings.items.get(tool);
			if (row && row.held + row.worn > 0 && (best === null || tierRank(tool) < tierRank(best.tool))) best = { tool, row };
		}
		const weakest = [...set.min].sort((a, b) => tierRank(a) - tierRank(b) || a.localeCompare(b))[0];
		if (best) return { met: true, text: `${best.tool} held${best.row.uses === null ? '' : ` ${best.row.uses} uses`}`, id: weakest };
		return { met: false, text: `${weakest}${set.all.length > 1 ? '+' : ''} missing`, id: weakest };
	}

	/**
	 * Every way the game data allows, in stable order: recipes as the data lists them, then mine, kill, trade, loot.
	 * The list never depends on where the item sits in the tree; an input that is an ancestor is marked as a cycle.
	 */
	options(id, path, missingCount) {
		const index = this.index, options = [];
		(index.recipes[id] ?? []).forEach(row => {
			const [station, yieldCount, inputs] = row;
			const brewing = station === 'brewing_stand';
			const crafts = brewing ? Math.ceil(missingCount / BREW_BOTTLES) : Math.ceil(missingCount / yieldCount);
			// Inputs reserve held items first, so fuel is only proven from what the inputs leave over.
			const pool = this.pool();
			const requirements = inputs.map(([spec, n], position) => {
				const choice = singleton(spec, index);
				// A brew's first input is the bottle being converted; each brew converts one to three of them.
				const need = brewing && position === 0 ? missingCount : n * crafts;
				const have = this.have(choice);
				const free = this.available(pool, choice);
				const met = have.total !== null && this.reserve(pool, choice, need);
				return { id: choice, spec, need, role: 'item', met, have, free };
			});
			if (station !== 'inventory') {
				const have = this.have(station, 'station');
				requirements.push({ id: station, need: 1, role: 'station', met: have.total !== null && have.total >= 1, have });
			}
			if (FUEL_TICKS_PER_ITEM[station]) {
				const fuel = this.fuelStatus(crafts * FUEL_TICKS_PER_ITEM[station], pool);
				requirements.push({ id: 'fuel', need: 1, role: 'fuel', met: fuel.met, text: fuel.text });
			}
			if (brewing) {
				const need = Math.ceil(crafts / BREWS_PER_FUEL);
				const free = this.available(pool, BREWING_FUEL);
				const met = this.holdings.known && this.reserve(pool, BREWING_FUEL, need);
				requirements.push({ id: BREWING_FUEL, need, role: 'fuel', met, have: this.have(BREWING_FUEL), free });
			}
			const unpack = inputs.length === 1 && (index.recipes[inputs[0][0]] ?? []).some(other => other[2].some(([spec]) => spec.split('|').includes(id)));
			const cycle = requirements.filter(r => r.role === 'item' && (path.includes(r.id) || path.includes(r.spec))).map(r => r.id);
			options.push({ type: 'craft', verb: brewing ? 'brew' : COOKING.has(station) ? 'smelt' : unpack ? 'unpack' : 'craft', station, yieldCount, brewing, requirements, cycle, recipeId: row[3] ?? null });
		});
		for (const [input, perItem, how] of USE_SOURCES[id] ?? []) {
			const need = perItem ? missingCount : 1;
			options.push({ type: 'use', how, requirements: [{ id: input, need, role: 'item', met: this.holdings.known && this.reserve(this.pool(), input, need), have: this.have(input) }] });
		}
		const mineGroups = new Map();
		for (const [block, flags] of index.blockDrops[id] ?? []) {
			const tool = index.harvest[block];
			const key = `${tool ?? -1}:${flags}`;
			if (!mineGroups.has(key)) mineGroups.set(key, { type: 'mine', blocks: [], flags, tool });
			mineGroups.get(key).blocks.push(block);
		}
		for (const group of mineGroups.values()) {
			const tool = group.tool === undefined ? null : this.toolStatus(group.tool);
			group.requirements = tool?.id ? [{ id: tool.id, need: 1, role: 'tool', met: tool.met }] : [];
			group.toolText = tool?.text ?? null;
			options.push(group);
		}
		const mobs = index.mobDrops[id] ?? [];
		if (mobs.length) options.push({ type: 'kill', mobs, requirements: [] });
		for (const [profession, level, wants, gives] of index.trades[id] ?? []) {
			const pool = this.pool();
			options.push({ type: 'trade', profession, level, gives,
				requirements: wants.map(([want, n]) => ({ id: want, need: n, role: 'item', met: this.holdings.known && this.reserve(pool, want, n), have: this.have(want) })) });
		}
		const tables = (index.loot[id] ?? []).filter(table => table !== BARTER_TABLE);
		// Bartering is an entity use with a price, so it is listed with that price instead of as chest loot.
		if (tables.length < (index.loot[id] ?? []).length) {
			options.push({ type: 'barter', requirements: [{ id: 'gold_ingot', need: 1, role: 'item', met: this.holdings.known && this.reserve(this.pool(), 'gold_ingot', 1), have: this.have('gold_ingot') }] });
		}
		if (tables.length) options.push({ type: 'loot', tables, requirements: [] });
		// Array.prototype.sort is stable, so recipes keep data order inside the craft group.
		return options.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
	}

	/** Held and worn counts per item, to be reserved by one option's requirements. */
	pool() {
		return new Map([...this.holdings.items].map(([id, row]) => [id, row.held + row.worn]));
	}

	/** Takes `need` of an item or of any members of a tag or list from the pool; members that burn least go first. */
	/** What the pool still offers of an item or any member of a tag or list. */
	available(pool, id) {
		return memberIds(id, this.index).reduce((sum, member) => sum + (pool.get(member) ?? 0), 0);
	}

	/** A child line counts only what the option's earlier inputs left free, and says how much they took. */
	withReservation(have, free) {
		if (free === undefined || have.total === null || free >= have.total) return have;
		const reserved = `${have.total - free} reserved for other inputs`;
		return { total: free, text: have.text ? `${have.text}, ${reserved}` : reserved };
	}

	reserve(pool, id, need) {
		if (id.startsWith('potion:')) return false;
		const fuels = this.index.fuels;
		const members = [...memberIds(id, this.index)].sort((a, b) => (fuels[a] ?? 0) - (fuels[b] ?? 0));
		let remaining = need;
		const taken = [];
		for (const member of members) {
			const take = Math.min(remaining, pool.get(member) ?? 0);
			if (take > 0) { taken.push([member, take]); remaining -= take; }
			if (remaining === 0) break;
		}
		if (remaining > 0) return false;
		for (const [member, take] of taken) pool.set(member, pool.get(member) - take);
		return true;
	}

	/** Burn time left after the inputs' reservation: a held log that is the input cannot also be its fuel. */
	fuelStatus(ticks, pool) {
		if (!this.holdings.known) return { met: false, text: 'unknown' };
		let capacity = 0, total = 0;
		for (const [id, row] of this.holdings.items) {
			if (!this.index.fuels[id]) continue;
			capacity += (pool.get(id) ?? 0) * this.index.fuels[id];
			total += (row.held + row.worn) * this.index.fuels[id];
		}
		if (capacity >= ticks) return { met: true, text: 'ok' };
		const shared = total > capacity ? ' after inputs' : '';
		return { met: false, text: capacity > 0 ? `${Math.floor(capacity / ticks * 100)}% held${shared}` : `none held${shared}` };
	}

	summary(option, detailed = true) {
		const reqs = option.requirements;
		switch (option.type) {
			case 'craft': {
				const inputs = reqs.filter(r => r.role === 'item').map(r => `${display(r.id, this.index)} x${r.need}${r.met ? ' ok' : r.have?.total ? ` (held ${r.have.total})` : ''}`).join(', ');
				const station = reqs.find(r => r.role === 'station');
				const stationText = station ? `@${option.station}[${station.met ? station.have.text : 'missing'}]` : '';
				const fuel = reqs.find(r => r.role === 'fuel');
				const fuelText = !fuel ? '' : fuel.id === 'fuel' ? `+fuel[${fuel.text}]` : `+${fuel.id}(fuel)${fuel.need > 1 ? ` x${fuel.need}` : ''}${fuel.met ? '' : '[missing]'}`;
				const yieldText = option.brewing ? ' (1-3 bottles per brew)' : option.yieldCount > 1 ? ` (makes ${option.yieldCount})` : '';
				const ready = reqs.every(r => r.met) ? ' (ready)' : '';
				const cycle = option.cycle.length ? ` (cycle: ${option.cycle.join(', ')} needed above)` : '';
				return `${option.verb}${stationText}${fuelText}${yieldText} <- ${inputs}${ready}${cycle}${detailed && option.recipeId ? ` [recipe ${option.recipeId}]` : ''}`;
			}
			case 'mine': {
				const blocks = option.blocks.slice(0, 2).join('|') + (option.blocks.length > 2 ? `|+${option.blocks.length - 2}` : '');
				const tool = option.toolText ? ` tool ${option.toolText}` : '';
				return `mine ${blocks}${flagText(option.flags)}${tool}${detailed ? worldgenText(option.blocks, this.index) : ''}`;
			}
			case 'kill': return `kill ${option.mobs.slice(0, 2).map(([mob, flags]) => `${mob}${flagText(flags)}`).join('|')}${option.mobs.length > 2 ? `|+${option.mobs.length - 2}` : ''}${detailed && option.mobs.length === 1 ? spawnText(option.mobs[0][0], this.index) : ''}`;
			case 'use': return `use: ${option.how} <- ${reqs.map(r => `${r.id} x${r.need}${r.met ? ' ok' : ''}`).join(', ')}`;
			case 'barter': return `barter: give gold_ingot x1 to a calm adult piglin (interact_entity holding it, or drop it near); random return after about 6 s${reqs[0].met ? ' (ready)' : ''}`;
			case 'trade': return `trade ${option.profession}${option.level ? ` L${option.level}` : ''} ${reqs.map(r => `${r.id} x${r.need}`).join('+')}${option.gives > 1 ? ` -> ${option.gives}` : ''}`;
			case 'loot': return `loot ${option.tables.slice(0, 2).join(', ')}${option.tables.length > 2 ? ` +${option.tables.length - 2}` : ''}`;
		}
		return option.type;
	}
}

const SOURCE_DEPTH = 5;
const SOURCE_NODES = 64;
const SPECIAL_TOOL_FLAGS = /[sh]/;

/**
 * The gated raw sources an unmet requirement comes from: blocks to mine that need a tool tier not held, generate in
 * a depth band or only in another dimension, and mobs that spawn only away from here. A requirement that some path
 * already reaches with held tools (logs, stone, a cow) reports nothing; the gate is the hidden prerequisite. Every
 * gated source is listed in stable game-data order and none is picked. Recipes are followed through unmet inputs;
 * trades, loot, unpacking a stored block, recipes that need the item itself, stations, fuel and silk-touch or
 * shears drops are not. Mobs count only where an item has no mine or craft source.
 */
export function howtoSources(ids, holdings = howtoHoldings(), { index = howtoIndex(), visited = null, trace = null } = {}) {
	const query = new Query(index, holdings), memo = new Map();
	let budget = SOURCE_NODES;
	const node = (id, path) => {
		if (memo.has(id)) return memo.get(id);
		if (path.includes(id) || path.length >= SOURCE_DEPTH || budget-- <= 0) return CLOSED;
		trace?.add(id);
		const members = memberIds(id, index);
		let result;
		if (members.length > 1) result = alternatives(members.map(member => () => node(member, path)));
		else {
			const mined = [], crafted = [], killed = [];
			for (const option of query.options(id, [...path, id], 1)) {
				if (option.type === 'mine' && !SPECIAL_TOOL_FLAGS.test(option.flags)) {
					// Generated blocks, or the uncraftable item's own block (obsidian); never a crafted block that drops it.
					const blocks = option.blocks.filter(block => index.worldgen[block] || block === id && !index.recipes[id]);
					if (blocks.length) mined.push(() => mineSource(blocks, option.requirements[0], index, visited));
				} else if (option.type === 'craft' && option.verb !== 'unpack' && option.cycle.length === 0) {
					const inputs = option.requirements.filter(r => r.role === 'item' && !r.met);
					crafted.push(() => allOf(inputs.map(r => node(r.id, [...path, id]))));
				} else if (option.type === 'kill') {
					for (const [mob] of option.mobs) if (index.mobSpawns?.[mob]) killed.push(() => killSource(mob, index.mobSpawns[mob], visited));
				}
			}
			// Mining is judged before recipes because it is cheap; any open path settles the item.
			if (BLOCK_USE[id]) mined.push(() => ({ open: false, sources: [`${id}\0 ${BLOCK_USE[id]}`] }));
			result = alternatives(mined.length || crafted.length ? [...mined, ...crafted] : killed);
		}
		memo.set(id, result);
		return result;
	};
	const result = allOf(ids.map(id => node(id.replace(/^(#?)minecraft:/, '$1'), [])));
	if (result.open) return [];
	// Sources behind the same gate share one entry; another unvisited dimension sorts last.
	const groups = new Map();
	for (const [name, gate] of result.sources.map(source => source.split('\0'))) groups.set(gate, [...(groups.get(gate) ?? []), name]);
	const sources = [...groups].map(([gate, names]) => `${names.slice(0, 3).join('|')}${names.length > 3 ? `|+${names.length - 3}` : ''}${gate}`)
		.sort((a, b) => a.includes('(unvisited)') - b.includes('(unvisited)'));
	// A source in a dimension never entered also needs that dimension's entry.
	for (const [dimension, entry] of Object.entries(DIMENSION_ENTRY)) if (sources.some(source => source.includes(`${dimension}(unvisited)`))) sources.push(entry);
	return sources;
}

const CLOSED = Object.freeze({ open: false, sources: [] });

/** Any one open alternative makes the requirement reachable with what is held, so later ones are not explored. */
function alternatives(thunks) {
	if (thunks.length === 0) return CLOSED;
	const sources = new Set();
	for (const thunk of thunks) {
		const result = thunk();
		if (result.open) return { open: true, sources: [] };
		for (const source of result.sources) sources.add(source);
	}
	return { open: false, sources: [...sources] };
}

/** One recipe's unmet inputs: reachable only when every input is. */
function allOf(results) {
	if (results.every(r => r.open)) return { open: true, sources: [] };
	return { open: false, sources: [...new Set(results.filter(r => !r.open).flatMap(r => r.sources))] };
}

function mineSource(blocks, tool, index, visited) {
	const shown = blocks.filter(block => !(block.startsWith('deepslate_') && blocks.includes(block.slice('deepslate_'.length))));
	const generated = blocks.find(block => index.worldgen[block]);
	const place = generated ? worldgenPlace(index.worldgen[generated], visited) : '';
	const gated = Boolean(tool && !tool.met) || place !== '';
	const gate = `${tool ? tool.met ? ` ${tool.id}+ held` : ` needs ${tool.id}+` : ''}${place}`;
	return gated ? { open: false, sources: shown.map(block => `${block}\0${gate}`) } : { open: true, sources: [] };
}

function killSource(mob, places, visited) {
	if (places.includes('overworld')) return { open: true, sources: [] };
	return { open: false, sources: [`kill ${mob}\0 in ${places.map(place => unvisited(place, visited)).join('|')}`] };
}

/** Dimensions only when never the overworld; the peaked bands where it is commonest, else every band. */
function worldgenPlace(row, visited) {
	const dimensions = row.d.includes('overworld') ? [] : row.d;
	const peaked = (row.y ?? []).filter(band => band.length > 2);
	const bands = (peaked.length ? peaked : row.y ?? []).slice(0, 3).map(([min, max, peak]) => `${min}..${max}${peak === undefined ? '' : `~${peak}`}`);
	return `${dimensions.length ? ` ${dimensions.map(d => unvisited(d, visited)).join('|')}` : ''}${bands.length ? ` y${bands.join(',')}` : ''}`;
}

/** Marks a dimension the player has never been in, when the caller knows which it has visited. */
function unvisited(place, visited) {
	if (!visited) return place;
	const dimension = place.split(' ')[0];
	return visited.includes(`minecraft:${dimension}`) ? place : place.replace(dimension, `${dimension}(unvisited)`);
}

const CHAIN_DEPTH = 6;
const CHAIN_NODES = 40;
// The first portal built by hand: frame and ignition. Finding or reusing a portal is just as valid.
const ENTRY_ITEMS = { the_nether: { obsidian: 10, 'flint_and_steel|fire_charge': 1 } };
const ARMOR_PIECES = { helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' };

/**
 * Net requirements for unmet needs ([{ id, count }]): what is still missing after held items, and what each missing
 * item needs in turn. Equivalent recipe inputs share a demand; different recipes remain conditional branches.
 * Trades, loot, unpacking and silk touch are not expanded. Station construction cycles are excluded only when the
 * station is unavailable. Block, mob and block-use sources end their branch with source facts. A mining tool that is not held becomes a need of its own, and a mob found
 * only in an unvisited dimension adds that dimension's entry items. Quantities follow recipe yields and are netted
 * once across all needs. Rows run from the needs down to their sources; nothing is chosen.
 */
export function howtoChain(needs, holdings = howtoHoldings(), { index = howtoIndex(), visited = null, shown = [], path = [] } = {}) {
	const query = new Query(index, holdings);
	const routes = new Map(), order = [], extra = new Map();
	const held = id => memberIds(id, index).reduce((sum, member) => { const row = holdings.items.get(member); return sum + (row ? row.held + row.worn : 0); }, 0);
	const stationNeeds = (station, path) => {
		const rows = index.recipes[station] ?? [];
		return rows.length > 0 && rows.every(row => row[2].some(([spec]) => spec.split('|').some(input => path.includes(input))));
	};
	const wayOf = (option, id, path, deep) => {
		if (option.type === 'craft') {
			if (option.verb === 'unpack' || option.brewing || option.cycle.length || option.station !== 'inventory' && query.have(option.station, 'station').total !== 1 && stationNeeds(option.station, path)) return null;
			const inputs = option.requirements.filter(r => r.role === 'item');
			if (deep && !inputs.every(r => obtainable(r.id, path))) return null;
			return { kind: 'craft', option, inputs: inputs.map(r => ({ id: r.id, per: r.need })) };
		}
		if (option.type === 'mine') {
			if (SPECIAL_TOOL_FLAGS.test(option.flags)) return null;
			const blocks = option.blocks.filter(block => index.worldgen[block] || block === id && !index.recipes[id]);
			return blocks.length ? { kind: 'mine', option, blocks } : null;
		}
		if (option.type === 'kill') {
			const mobs = option.mobs.filter(([mob]) => index.mobSpawns?.[mob]);
			return mobs.length ? { kind: 'kill', mobs } : null;
		}
		return null;
	};
	// An input counts when held, a tag, a block-use result, or reachable by some way one level down.
	const obtainable = (id, path) => held(id) > 0 || memberIds(id, index).length > 1 || Boolean(BLOCK_USE[id])
		|| query.options(id, [...path, id], 1).some(option => wayOf(option, id, [...path, id], false) !== null);
	const visit = (id, path) => {
		if (routes.has(id)) return;
		let route = { kind: 'end', ways: 0 };
		if (memberIds(id, index).length === 1 && path.length < CHAIN_DEPTH && routes.size < CHAIN_NODES) {
			const all = query.options(id, [...path, id], 1).map(option => wayOf(option, id, [...path, id], true)).filter(Boolean);
			// Mob drops count only for items no block or recipe yields (rare zombie iron is not a way to iron).
			const rawWays = all.some(way => way.kind !== 'kill') ? all.filter(way => way.kind !== 'kill') : all;
			// Station variants with identical inputs are alternatives for the same material demand.
			const grouped = new Map();
			for (const way of rawWays) {
				const key = way.kind === 'craft' ? JSON.stringify([way.option.yieldCount, way.inputs]) : Symbol();
				if (grouped.has(key)) grouped.get(key).options.push(way.option);
				else grouped.set(key, way.kind === 'craft' ? { ...way, options: [way.option] } : way);
			}
			const ways = [...grouped.values()];
			const count = ways.length + (BLOCK_USE[id] ? 1 : 0);
			route = count === 1 && ways.length === 1 ? ways[0] : { kind: 'end', ways: count, alternatives: ways };
		}
		routes.set(id, route);
		if (route.kind === 'craft') for (const input of route.inputs) visit(input.id, [...path, id]);
		order.push(id);
	};
	const roots = new Map();
	for (const { id, count } of needs) {
		const item = id.replace(/^(#?)minecraft:/, '$1');
		roots.set(item, (roots.get(item) ?? 0) + count);
		visit(item, path);
	}
	let demand, shortOf, pool;
	// Acquisition gates are discovered only after netting all material demand against a shared pool.
	for (let pass = 0; pass < CHAIN_DEPTH; pass++) {
		demand = new Map(roots);
		for (const [id, n] of extra) demand.set(id, Math.max(demand.get(id) ?? 0, n));
		shortOf = new Map(); pool = query.pool();
		// Multi-member inputs are leaves: reserve exact items before letting a tag consume their stock.
		const netOrder = [...order].reverse().sort((a, b) => Number(memberIds(a, index).length > 1) - Number(memberIds(b, index).length > 1));
		for (const id of netOrder) {
			const need = demand.get(id) ?? 0, used = Math.min(query.available(pool, id), need);
			query.reserve(pool, id, used);
			const short = need - used, route = routes.get(id);
			shortOf.set(id, short);
			if (short && route.kind === 'craft') for (const input of route.inputs) demand.set(input.id, (demand.get(input.id) ?? 0) + input.per * Math.ceil(short / route.option.yieldCount));
		}
		let added = false;
		const gate = (id, n) => { if (!extra.has(id)) { extra.set(id, n); visit(id, path); added = true; } };
		for (const [id, short] of shortOf) {
			if (!short) continue;
			const route = routes.get(id);
			if (route.kind === 'mine') { const tool = route.option.requirements[0]; if (tool && !tool.met && tool.id) gate(tool.id, 1); }
			if (route.kind === 'kill') {
				const places = index.mobSpawns[route.mobs[0][0]];
				if (places.some(place => place.startsWith('overworld') || visited?.includes(`minecraft:${place.split(' ')[0]}`))) continue;
				for (const place of places) {
					const dimension = place.split(' ')[0];
					if (!visited || visited.includes(`minecraft:${dimension}`)) continue;
					for (const [item, n] of Object.entries(ENTRY_ITEMS[dimension] ?? {})) gate(item, n);
				}
			}
		}
		if (!added) break;
	}
	const wayText = new Map();
	const fuelDemand = new Map([...shortOf].flatMap(([id, short]) => {
		const route = routes.get(id);
		if (!short || route.kind !== 'craft') return [];
		const accessible = route.options.filter(option => option.station === 'inventory' || query.have(option.station, 'station').total === 1);
		// An unavailable fuel-free station cannot pay for work at the stations already usable.
		return [[id, Math.ceil(short / route.option.yieldCount) * Math.min(...(accessible.length ? accessible : route.options).map(option => FUEL_TICKS_PER_ITEM[option.station] ?? 0))]];
	}));
	const totalFuelTicks = [...fuelDemand.values()].reduce((sum, ticks) => sum + ticks, 0);
	for (const id of [...order].reverse()) {
		const route = routes.get(id), short = shortOf.get(id) ?? 0;
		if (!short) continue;
		if (route.kind === 'craft') {
			const crafts = Math.ceil(short / route.option.yieldCount);
			const inputsReady = route.inputs.every(input => shortOf.get(input.id) === 0);
			const descriptions = route.options.map(option => {
				const station = option.requirements.find(r => r.role === 'station');
				const ticks = FUEL_TICKS_PER_ITEM[option.station];
				const fuel = ticks ? query.fuelStatus(totalFuelTicks - (fuelDemand.get(id) ?? 0) + crafts * ticks, pool) : null;
				const ready = inputsReady && (!station || station.met) && (!fuel || fuel.met);
				const stationText = station && station.met ? `@${option.station}(${station.have.text})`
					: route.options.length > 1 ? `@${option.station}${station ? ' missing' : ''}` : station ? `@${option.station} missing` : '';
				return `${stationText}${fuel && !fuel.met ? ` fuel ${fuel.text.replace(' held', '')}` : ''}${ready ? ` ${option.verb} ready` : ''}`.trim();
			});
			wayText.set(id, descriptions.some(Boolean) ? ` ${descriptions.join(' or ')}` : '');
		} else if (route.kind === 'mine') wayText.set(id, ` ${mineText(route, holdings, index, visited)}`);
		else if (route.kind === 'kill') {
			const places = index.mobSpawns[route.mobs[0][0]];
			const here = visited ? places.filter(place => visited.includes(`minecraft:${place.split(' ')[0]}`)) : [];
			wayText.set(id, ` kill ${route.mobs[0][0]} ${(here.length ? here : places).map(place => unvisited(place, visited)).join('|')}`);
		} else {
			const recipes = route.alternatives?.filter(way => way.kind === 'craft') ?? [];
			if (recipes.length && path.length < CHAIN_DEPTH) {
				// Each alternative is conditional, not additive demand. Reserve other needs before exploring it.
				const remaining = { ...holdings, items: new Map([...holdings.items].map(([item, row]) => [item, { ...row, held: pool.get(item) ?? 0, worn: 0 }])) };
				const branches = recipes.map(way => {
					const crafts = Math.ceil(short / way.option.yieldCount);
					const inputs = way.inputs.map(input => ({ id: input.id, count: input.per * crafts }));
					const branch = howtoChain(inputs, remaining, { index, visited, path: [...path, id] });
					const branchPool = new Map(pool);
					for (const input of inputs) query.reserve(branchPool, input.id, Math.min(input.count, query.available(branchPool, input.id)));
					const stations = way.options.map(option => {
						const station = option.requirements.find(r => r.role === 'station');
						const fuel = FUEL_TICKS_PER_ITEM[option.station] ? query.fuelStatus(crafts * FUEL_TICKS_PER_ITEM[option.station], branchPool) : null;
						return `@${option.station}${station && !station.met ? ' missing' : ''}${fuel && !fuel.met ? ` fuel ${fuel.text.replace(' held', '')}` : ''}`;
					});
					return `${stations.join('|')}<-${branch.parts.join(' + ') || 'inputs held'}`;
				});
				wayText.set(id, ` (${branches.join(' or ')})`);
			} else {
				const gates = howtoSources([id], holdings, { index, visited }).filter(source => !Object.values(DIMENSION_ENTRY).includes(source))
					.map(source => source.startsWith(`${id} `) ? source.slice(id.length + 1) : source).map(source => source.replace(/ \(strategy:[a-z-]+\)$/, '').replace('cast: water onto a lava source', 'water on lava'));
				const near = gates.filter(source => !source.includes('(unvisited)'));
				wayText.set(id, gates.length ? ` ${(near.length ? near : gates).slice(0, 2).join(' or ')}` : '');
			}
		}
	}

	const rendered = new Set();
	const render = id => {
		if (rendered.has(id)) return id;
		rendered.add(id);
		const route = routes.get(id), need = demand.get(id) ?? 0;
		// An item the step line already counts starts with what it needs, not its own count again.
		const head = shown.includes(id) ? (wayText.get(id) ?? '').trim() : `${id} ${need - shortOf.get(id)}/${need}${wayText.get(id) ?? ''}`;
		if (route.kind !== 'craft') return head;
		const inputs = route.inputs.filter(input => shortOf.get(input.id) > 0).map(input => render(input.id));
		if (!inputs.length) return head;
		if (shown.includes(id)) return `${head}<-${inputs.join(' + ')}`;
		return `${head}<-${inputs.length > 1 ? `(${inputs.join(' + ')})` : inputs[0]}`;
	};
	const parts = [];
	for (const { id } of needs) {
		const item = id.replace(/^(#?)minecraft:/, '$1');
		if (shortOf.get(item) > 0 && !rendered.has(item)) parts.push(render(item));
	}
	for (const [item] of extra) if (shortOf.get(item) > 0 && !rendered.has(item)) {
		const entry = Object.entries(ENTRY_ITEMS).find(([, items]) => Object.hasOwn(items, item));
		const label = entry ? `${entry[0].replace('the_', '')} entry: ` : '';
		parts.push(`${label && !parts.some(part => part.startsWith(label)) ? label : ''}${render(item)}`);
	}
	if (parts.length && needs.some(need => need.alternative)) parts[0] = `crafting option: ${parts[0]}`;
	// Worth showing only past the obvious: a recipe still short of inputs, a missing station or fuel, a tool tier, a depth
	// band or another dimension, a mob, or several ways with a gate. A plain surface block (logs) is not a hidden step.
	const gated = [...shortOf].some(([id, short]) => short > 0 && (routes.get(id).kind === 'craft' && routes.get(id).inputs.some(input => shortOf.get(input.id) > 0) || routes.get(id).kind === 'kill' || /@|fuel|needs|ready|y-?\d|unvisited|the_nether|the_end| or /.test(wayText.get(id) ?? '')));
	return { parts, gated, items: new Set(routes.keys()), key: parts.join(', ') };
}

/** Joins chain parts into at most `maxBytes`, cutting at a part or word boundary with "...". */
export function chainText(parts, maxBytes) {
	let text = '';
	for (const part of parts) {
		const next = `${text}${text ? ', ' : ''}${part}`;
		if (Buffer.byteLength(next) <= maxBytes) { text = next; continue; }
		let cut = next.slice(0, maxBytes - 3);
		while (Buffer.byteLength(cut) > maxBytes - 3) cut = cut.slice(0, -1);
		const space = cut.lastIndexOf(' ');
		return `${space > text.length ? cut.slice(0, space) : cut}...`;
	}
	return text;
}

function mineText(route, holdings, index, visited) {
	const blocks = route.blocks.filter(block => !(block.startsWith('deepslate_') && route.blocks.includes(block.slice('deepslate_'.length))));
	const tool = route.option.requirements[0];
	const generated = route.blocks.find(block => index.worldgen[block]);
	const place = generated ? worldgenPlace(index.worldgen[generated], visited) : '';
	const seen = route.blocks.map(block => holdings.stations.get(block)).filter(row => row?.kind === 'visible' && row.distance !== null).sort((a, b) => a.distance - b.distance)[0];
	// Keep alternative generation bands: the first band is data order, not a ranking of the fastest source.
	return `mine ${blocks.slice(0, 2).join('|')}${tool && !tool.met ? ` needs ${tool.id}+` : ''}${place}${seen ? ` seen ${seen.distance}m` : ''}`;
}

/**
 * Material for the cheapest armour pieces of `tier` still missing to reach `count` worn pieces of that tier or better
 * (`wornSlots` are slots already holding one), as { id, count }, or null when the tier has no single-material recipes.
 */
export function armorMaterialNeed(tier, count, wornSlots, index = howtoIndex()) {
	const open = [];
	for (const [piece, slot] of Object.entries(ARMOR_PIECES)) {
		const row = index.recipes[`${tier}_${piece}`]?.[0];
		if (!row || row[2].length !== 1) return null;
		if (!wornSlots.has(slot)) open.push({ material: row[2][0][0], n: row[2][0][1] });
	}
	const missing = Math.max(0, count - (4 - open.length));
	if (missing === 0 || open.length === 0) return null;
	const chosen = open.sort((a, b) => a.n - b.n).slice(0, missing);
	return { id: chosen[0].material, count: chosen.reduce((sum, row) => sum + row.n, 0) };
}

function fuelAnswer(index, holdings) {
	const held = [...holdings.items].filter(([id, row]) => index.fuels[id] && row.held > 0).map(([id, row]) => `${id} x${row.held} (${index.fuels[id] / 200} smelts each)`);
	const top = Object.entries(index.fuels).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([id, ticks]) => `${id} ${ticks / 200}`);
	return { howto: 'fuel', scope: SCOPE, note: 'items smelted per fuel item, the same in furnace, blast furnace and smoker; campfires need none',
		held: holdings.known ? (held.length ? held : 'none') : 'unknown', mostSmelts: top, fuelItems: Object.keys(index.fuels).length };
}

function shortId(id) {
	return typeof id === 'string' ? id.replace(/^minecraft:/, '') : null;
}

function memberIds(id, index) {
	return id.startsWith('#') ? index.tags[id] ?? [] : id.split('|');
}

/** A tag or list with one member is that member. */
function singleton(id, index) {
	const members = memberIds(id, index);
	return members.length === 1 ? members[0] : id;
}

/** Every member of a grouped source with its conditions, for paging the chosen option. */
function groupRows(option, index) {
	if (option.type === 'mine') return option.blocks.map(block => `${block}${flagText(option.flags)}${worldgenText([block], index)}`);
	if (option.type === 'kill') return option.mobs.map(([mob, flags]) => `${mob}${flagText(flags)}${spawnText(mob, index)}`);
	if (option.type === 'loot') return option.tables;
	return [];
}

function display(id, index) {
	if (id.startsWith('#')) return `${id}(any of ${(index.tags[id] ?? []).length})`;
	const options = id.split('|');
	return options.length > 3 ? `${options.slice(0, 2).join('|')}|+${options.length - 2}` : id;
}

/** Flags are comma-separated conditions; a slash joins either-or conditions such as shears or silk touch. */
function flagText(flags) {
	if (!flags) return '';
	return `(${flags.split(',').map(token => token.split('/').map(flag => FLAG_TEXT[flag] ?? flag).join(' or ')).join('+')})`;
}

/** Where a mob spawns naturally per game data: biome dimensions and "dimension structure" spawn overrides. */
function spawnText(mob, index) {
	const places = index.mobSpawns?.[mob];
	return places?.length ? ` in ${places.join('|')}` : '';
}

function worldgenText(blocks, index) {
	const shown = blocks.slice(0, 2), known = shown.filter(block => index.worldgen[block]);
	if (known.length === 0) return '; location not indexed';
	const row = index.worldgen[known[0]];
	const bands = (row.y ?? []).slice(0, 3).map(([min, max, peak]) => `${min}..${max}${peak === undefined ? '' : `~${peak}`}`);
	return `; can generate: ${row.d.join('|')}${bands.length ? ` y${bands.join(',')}` : ''}`;
}

function tierRank(tool) {
	const rank = TOOLS.indexOf(tool.split('_')[0]);
	return rank < 0 ? TOOLS.length : rank;
}
