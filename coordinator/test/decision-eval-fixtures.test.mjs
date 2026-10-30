import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Consistency invariants for the decision-eval train fixtures (q8 review P2-4). An observation states the inventory
// several times over (items, held item, tag counts, the inventory menu page, hotbar flags) and entities with a
// position and a box. A derived case edits recorded state, so every restatement the edit touches must still agree, in
// the case observation and in every earlier observation. Real recorded cases must pass the same rules.
// DECISION_EVAL_FIXTURE_DIR points the checks at another train directory (for example an older corpus).

const trainDir = process.env.DECISION_EVAL_FIXTURE_DIR
	?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'decision-eval', 'train');
const cases = fs.readdirSync(trainDir).filter((name) => name.endsWith('.json')).sort()
	.flatMap((name) => JSON.parse(fs.readFileSync(path.join(trainDir, name), 'utf8')).cases);

const SLOT_NAMES = new Set(['mainhand', 'offhand', 'head', 'chest', 'legs', 'feet']);
const MENU_ARMOR = { 5: 'head', 6: 'chest', 7: 'legs', 8: 'feet' };
const TAG_COUNT_CAP = 64;

function observationsOf(testCase) {
	return [['observation', testCase.state.observation], ...(testCase.state.previousObservations ?? []).map((o, i) => [`previousObservations[${i}]`, o])];
}

function strings(value, out = []) {
	if (typeof value === 'string') out.push(value);
	else if (Array.isArray(value)) for (const v of value) strings(v, out);
	else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
	return out;
}

// Contradictions inside one observation's restated inventory and entity facts.
export function inventoryContradictions(o) {
	const problems = [];
	const items = o.inventory?.items ?? [];
	const bySlot = new Map();
	for (const it of items) {
		if (!(Number.isInteger(it.slot) && it.slot >= 0 && it.slot <= 35) && !SLOT_NAMES.has(it.slot)) problems.push(`unknown slot ${it.slot}`);
		if (bySlot.has(it.slot)) problems.push(`slot ${it.slot} listed twice`);
		bySlot.set(it.slot, it);
		if (Number.isInteger(it.slot) && (it.hotbar === true) !== (it.slot < 9)) problems.push(`slot ${it.slot} hotbar flag ${it.hotbar}`);
		if (!Number.isInteger(it.slot) && it.hotbar !== undefined) problems.push(`${it.slot} carries a hotbar flag`);
		if (!it.fingerprint) problems.push(`slot ${it.slot} ${it.itemId} has no fingerprint`);
		if (Number.isInteger(it.maxStackSize) && it.count > it.maxStackSize) problems.push(`slot ${it.slot} count ${it.count} above stack size`);
	}
	const sel = o.interaction?.input?.selectedSlot;
	// The selected hotbar slot is reported as the "mainhand" entry, never as its integer slot as well.
	if (Number.isInteger(sel) && bySlot.has(sel)) problems.push(`selected slot ${sel} listed as an integer slot (${bySlot.get(sel).itemId}) beside mainhand ${bySlot.get('mainhand')?.itemId}`);
	const held = bySlot.get('mainhand')?.itemId ?? 'minecraft:air';
	if (o.inventory && o.inventory.selectedItem !== held) problems.push(`selectedItem ${o.inventory.selectedItem} but mainhand ${held}`);
	if (o.interaction?.mainHandItemId !== undefined && o.interaction.mainHandItemId !== held) problems.push(`mainHandItemId ${o.interaction.mainHandItemId} but mainhand ${held}`);
	const off = bySlot.get('offhand')?.itemId ?? 'minecraft:air';
	if (o.interaction?.offHandItemId !== undefined && o.interaction.offHandItemId !== off) problems.push(`offHandItemId ${o.interaction.offHandItemId} but offhand ${off}`);
	if (o.inventory?.tagCounts) {
		const want = {};
		for (const it of items) for (const tag of it.tags ?? []) want[tag] = (want[tag] ?? 0) + it.count;
		// The game reports at most 64 tags, the first ones in sorted order.
		const keys = Object.keys(want).sort().slice(0, TAG_COUNT_CAP);
		const got = o.inventory.tagCounts;
		for (const k of keys) if (got[k] !== want[k]) problems.push(`tagCounts[${k}] ${got[k]} but items give ${want[k]}`);
		for (const k of Object.keys(got)) if (!keys.includes(k)) problems.push(`tagCounts[${k}] ${got[k]} but no listed item has it`);
	}
	const menu = o.interaction?.menu;
	if (menu && Array.isArray(menu.slots)) {
		const playerMenu = menu.type === 'minecraft:inventory' || menu.containerId === 0;
		const containerSize = playerMenu ? null : menu.slotCount - 36;
		for (const entry of menu.slots) {
			let key;
			if (playerMenu) {
				key = MENU_ARMOR[entry.slot] ?? (entry.slot >= 9 && entry.slot <= 35 ? entry.slot : entry.slot >= 36 && entry.slot <= 44 ? (entry.slot - 36 === sel ? 'mainhand' : entry.slot - 36) : entry.slot === 45 ? 'offhand' : undefined);
			} else if (Number.isInteger(containerSize) && entry.slot >= containerSize) {
				const i = entry.slot - containerSize;
				const slot = i < 27 ? i + 9 : i - 27;
				key = slot === sel ? 'mainhand' : slot;
			}
			if (key === undefined) continue;
			const it = bySlot.get(key);
			const want = it ? `${it.itemId} x${it.count}` : 'minecraft:air x0';
			if (`${entry.itemId} x${entry.count}` !== want) problems.push(`menu slot ${entry.slot} shows ${entry.itemId} x${entry.count} but inventory ${key} holds ${want}`);
			else if (it && entry.fingerprint !== it.fingerprint) problems.push(`menu slot ${entry.slot} fingerprint differs from inventory ${key}`);
		}
	}
	for (const e of o.entities ?? []) {
		if (!e.bounds || !e.position) continue;
		const cx = (e.bounds.minX + e.bounds.maxX) / 2;
		const cz = (e.bounds.minZ + e.bounds.maxZ) / 2;
		if (Math.abs(cx - e.position.x) > 0.01 || Math.abs(cz - e.position.z) > 0.01) problems.push(`entity ${e.type} ${e.uuid} box is not centred on its position`);
		if (Number.isFinite(e.distance) && o.position && Math.abs(Math.hypot(e.position.x - o.position.x, e.position.y - o.position.y, e.position.z - o.position.z) - e.distance) > 1) problems.push(`entity ${e.type} distance ${e.distance} does not match its position`);
	}
	return problems;
}

// What a derived case declares about its edit, checked in every observation it carries.
export function derivedContradictions(testCase) {
	const invariants = testCase.source?.derived?.invariants;
	if (!invariants) return [];
	const problems = [];
	for (const [where, o] of observationsOf(testCase)) {
		const items = o.inventory?.items ?? [];
		for (const pattern of invariants.absentItems ?? []) {
			const re = new RegExp(pattern);
			for (const it of items) if (re.test(it.itemId)) problems.push(`${where}: removed item ${it.itemId} still in slot ${it.slot}`);
			for (const id of [o.inventory?.selectedItem, o.interaction?.mainHandItemId, ...(o.interaction?.menu?.slots ?? []).map((s) => s.itemId)]) if (typeof id === 'string' && re.test(id)) problems.push(`${where}: removed item ${id} still shown`);
		}
		for (const id of invariants.absentBlocks ?? []) for (const s of strings(o)) if (s.includes(id)) { problems.push(`${where}: replaced block ${id} still stated ("${s.slice(0, 80)}")`); break; }
		if (invariants.fullInventoryFor) {
			const sel = o.interaction?.input?.selectedSlot;
			const slots = new Set(items.map((it) => it.slot));
			for (let slot = 0; slot < 36; slot++) if (!slots.has(slot === sel ? 'mainhand' : slot)) problems.push(`${where}: main slot ${slot} is empty in a full inventory`);
			for (const id of invariants.fullInventoryFor) for (const it of items) if (it.itemId === id && it.count < it.maxStackSize) problems.push(`${where}: ${id} stack in slot ${it.slot} has room (${it.count}/${it.maxStackSize})`);
		}
	}
	return problems;
}

test('every train observation restates its inventory and entities consistently (real and derived cases)', () => {
	const problems = [];
	for (const c of cases) for (const [where, o] of observationsOf(c)) for (const p of inventoryContradictions(o)) problems.push(`${c.id} ${where}: ${p}`);
	assert.deepEqual(problems, []);
});

test('derived cases hold what their edit declares, in every observation they carry', () => {
	const derived = cases.filter((c) => c.source.derived?.scope === 'observation');
	assert.ok(derived.length > 0);
	const problems = derived.flatMap((c) => derivedContradictions(c).map((p) => `${c.id} ${p}`));
	assert.deepEqual(problems, []);
	// The inventory and tool-tier derivations must declare what they changed so the checks above have teeth.
	for (const c of derived.filter((x) => ['inventory-full', 'wrong-tool'].includes(x.family))) {
		const inv = c.source.derived.invariants ?? {};
		assert.ok(inv.fullInventoryFor || inv.absentItems, `${c.id} declares its edit invariants`);
	}
});

test('wrong-tool cases show no pickaxe the edit removed anywhere the model can read it', () => {
	for (const c of cases.filter((x) => x.family === 'wrong-tool')) for (const [where, o] of observationsOf(c)) {
		const text = JSON.stringify({ items: o.inventory?.items, selected: o.inventory?.selectedItem, hand: o.interaction?.mainHandItemId, menu: o.interaction?.menu, tags: o.inventory?.tagCounts });
		assert.ok(!/(stone|iron|golden|diamond|netherite)_pickaxe/.test(text), `${c.id} ${where} still shows a better pickaxe`);
	}
});

test('the checks catch the contradictions the review found', () => {
	const base = {
		inventory: { selectedItem: 'minecraft:iron_pickaxe', tagCounts: { '#minecraft:pickaxes': 2 }, items: [{ itemId: 'minecraft:dirt', count: 64, maxStackSize: 64, slot: 9, hotbar: false, fingerprint: 'f', tags: ['#minecraft:dirt'] }] },
		interaction: { mainHandItemId: 'minecraft:iron_pickaxe', input: { selectedSlot: 0 }, menu: { containerId: 0, type: 'minecraft:inventory', slots: [{ slot: 9, itemId: 'minecraft:air', count: 0 }] } },
	};
	const found = inventoryContradictions(base).join('\n');
	assert.match(found, /selectedItem minecraft:iron_pickaxe but mainhand minecraft:air/);
	assert.match(found, /mainHandItemId/);
	assert.match(found, /tagCounts\[#minecraft:pickaxes\]/);
	assert.match(found, /menu slot 9 shows minecraft:air x0 but inventory 9 holds minecraft:dirt x64/);
	const full = { source: { derived: { invariants: { fullInventoryFor: ['minecraft:oak_log'] } } }, state: { observation: { ...base, inventory: { ...base.inventory, items: [...base.inventory.items, { itemId: 'minecraft:oak_log', count: 3, maxStackSize: 64, slot: 10, hotbar: false, fingerprint: 'g', tags: [] }] } } } };
	const fullProblems = derivedContradictions(full).join('\n');
	assert.match(fullProblems, /main slot 0 is empty/);
	assert.match(fullProblems, /oak_log stack in slot 10 has room/);
});

// ---------- fix round 2 (q8 review r2 P2-5, P2-6) ----------

// Vitals restated in one observation: air and its seconds (the game reports airSecondsLeft = air / 20 only under water),
// bounded health, food and saturation. Between observations at most 5 s apart, air never drops while above water and
// drains at most 20 per second while under water.
export function vitalsContradictions(o) {
	const p = o.player ?? {};
	const problems = [];
	const maxAir = Number.isFinite(p.maxAir) ? p.maxAir : 300;
	if (Number.isFinite(p.air) && (p.air < 0 || p.air > maxAir)) problems.push(`air ${p.air} outside 0..${maxAir}`);
	if (p.airSecondsLeft !== undefined) {
		if (p.underWater !== true) problems.push(`airSecondsLeft ${p.airSecondsLeft} while not under water`);
		if (Number.isFinite(p.air) && Math.abs(p.airSecondsLeft - Math.max(0, p.air) / 20) > 0.051) problems.push(`airSecondsLeft ${p.airSecondsLeft} but air ${p.air} (${Math.max(0, p.air) / 20} s)`);
	} else if (p.underWater === true && Number.isFinite(p.air)) problems.push(`under water with air ${p.air} but no airSecondsLeft`);
	const maxHealth = Number.isFinite(p.maxHealth) ? p.maxHealth : 20;
	if (Number.isFinite(p.health) && (p.health < 0 || p.health > maxHealth + 1e-6)) problems.push(`health ${p.health} outside 0..${maxHealth}`);
	if (Number.isFinite(p.foodLevel) && (p.foodLevel < 0 || p.foodLevel > 20)) problems.push(`food ${p.foodLevel} outside 0..20`);
	if (Number.isFinite(p.saturation) && Number.isFinite(p.foodLevel) && (p.saturation < 0 || p.saturation > p.foodLevel + 1e-6)) problems.push(`saturation ${p.saturation} above food ${p.foodLevel}`);
	return problems;
}

export function vitalsSequenceContradictions(testCase) {
	const ordered = observationsOf(testCase).filter(([, o]) => Number.isFinite(o.observedAtEpochMs)).sort((a, b) => a[1].observedAtEpochMs - b[1].observedAtEpochMs);
	const problems = [];
	for (let i = 1; i < ordered.length; i++) {
		const [whereA, a] = ordered[i - 1];
		const [whereB, b] = ordered[i];
		const seconds = (b.observedAtEpochMs - a.observedAtEpochMs) / 1000;
		if (!Number.isFinite(a.player?.air) || !Number.isFinite(b.player?.air) || seconds > 5) continue;
		// Above water air only refills (4 per tick); under water it drains at most 20 per second.
		if (a.player.underWater !== true && b.player.underWater !== true && b.player.air < a.player.air) problems.push(`${whereB}: air dropped ${a.player.air} -> ${b.player.air} above water after ${whereA}`);
		if (a.player.underWater === true && b.player.underWater === true && (b.player.air > a.player.air || a.player.air - b.player.air > 20 * seconds + 5)) problems.push(`${whereB}: air ${a.player.air} -> ${b.player.air} in ${seconds} s under water after ${whereA}`);
	}
	return problems;
}

test('every observation restates its vitals consistently, in time order too (real and derived cases)', () => {
	const problems = [];
	for (const c of cases) {
		for (const [where, o] of observationsOf(c)) for (const p of vitalsContradictions(o)) problems.push(`${c.id} ${where}: ${p}`);
		for (const p of vitalsSequenceContradictions(c)) problems.push(`${c.id} ${p}`);
	}
	assert.deepEqual(problems, []);
});

test('the vitals checks catch the drowning contradictions the review found', () => {
	assert.match(vitalsContradictions({ player: { underWater: true, air: 40, maxAir: 300, airSecondsLeft: 7 } }).join(), /airSecondsLeft 7 but air 40/);
	assert.match(vitalsContradictions({ player: { underWater: true, air: 40, maxAir: 300, airSecondsLeft: 0 } }).join(), /airSecondsLeft 0 but air 40/);
	assert.deepEqual(vitalsContradictions({ player: { underWater: true, air: 148, maxAir: 300, airSecondsLeft: 7.4 } }), []);
	const dry = { state: { observation: { observedAtEpochMs: 3, player: { underWater: true, air: 90, airSecondsLeft: 4.5 } }, previousObservations: [{ observedAtEpochMs: 1, player: { underWater: false, air: 300 } }, { observedAtEpochMs: 2, player: { underWater: false, air: 254 } }] } };
	assert.match(vitalsSequenceContradictions(dry).join(), /air dropped 300 -> 254 above water/);
	const fast = { state: { observation: { observedAtEpochMs: 1500, player: { underWater: true, air: 40, airSecondsLeft: 2 } }, previousObservations: [{ observedAtEpochMs: 1000, player: { underWater: true, air: 150, airSecondsLeft: 7.5 } }] } };
	assert.match(vitalsSequenceContradictions(fast).join(), /air 150 -> 40 in 0.5 s under water/);
});

test('inventory-full capacity pressure is the recorded intended collection, and grading follows the incoming item', async () => {
	const { buildContext, blockDrop, inventoryHasRoom } = await import('../src/decision-eval/predicates.mjs');
	const { gradeSample } = await import('../src/decision-eval/grade.mjs');
	const mine = (args) => ({ name: 'mine', args });
	const full = cases.filter((x) => x.family === 'inventory-full');
	assert.ok(full.length > 0);
	for (const c of full) {
		const declared = c.source.derived?.invariants?.fullInventoryFor;
		assert.ok(Array.isArray(declared), `${c.id} declares the collection under capacity pressure`);
		const ctx = buildContext(c);
		const last = c.state.agent.recentResults.at(-1);
		// The declaration is derived from the recorded last action's target: the known drop of the mined block.
		const known = last?.tool === 'break_block' ? blockDrop(last.args.expectedBlockId) : null;
		if (known) assert.deepEqual(declared, [known], `${c.id} capacity is declared for the drop of ${last.args.expectedBlockId}`);
		for (const id of declared) assert.equal(inventoryHasRoom(ctx, id), false, `${c.id} ${id} really has no room`);
		// A hard good (freeing a whole low-value stack) exists only where that pressure is real.
		const freesGood = (c.expect.good ?? []).some((p) => JSON.stringify(p).includes('freesSlot'));
		assert.equal(freesGood, declared.length > 0, `${c.id} credits freeing a slot only under real capacity pressure`);
		// Mining the recorded target again is hard bad when its drop is known and has no room.
		if (known) {
			const { timeoutMs, ...args } = last.args;
			assert.equal(gradeSample(c, { calls: [mine(args)] }).verdict, 'bad', `${c.id} collecting the blocked drop is bad`);
		}
		// Every observed block with a known drop: mining it is bad exactly when its item has no room.
		for (const b of (c.state.observation.blocks ?? []).filter((x) => blockDrop(x.blockId))) {
			const verdict = gradeSample(c, { calls: [mine({ x: b.x, y: b.y, z: b.z, expectedBlockId: b.blockId })] }).verdict;
			if (inventoryHasRoom(ctx, blockDrop(b.blockId))) assert.notEqual(verdict, 'bad', `${c.id} mining ${b.blockId} at ${b.x},${b.y},${b.z} fits and is not bad`);
			else assert.equal(verdict, 'bad', `${c.id} mining ${b.blockId} at ${b.x},${b.y},${b.z} loses its drop`);
		}
	}
});

test('canned replies fire only for the recorded command itself', async () => {
	const { callMatches, buildContext } = await import('../src/decision-eval/match.mjs');
	const multi = cases.filter((c) => c.steps);
	assert.ok(multi.length > 0);
	for (const c of multi) for (const step of c.steps) for (const choice of step.canned) {
		const command = choice.recorded.command;
		assert.equal(choice.result.actionType, command.actionType, `${c.id} reply answers the recorded command`);
		const ctx = buildContext(c);
		const call = (args) => ({ name: 'act', args: { actionType: command.actionType, arguments: args } });
		assert.ok(callMatches(choice.when, call(command.arguments), ctx), `${c.id} the recorded command matches its reply`);
		// Every behavior-affecting argument is part of the match; only timeoutMs is free.
		for (const [key, value] of Object.entries(command.arguments)) {
			if (key === 'timeoutMs') continue;
			const changed = typeof value === 'number' ? value + 7 : typeof value === 'boolean' ? !value : `${value}_other`;
			assert.ok(!callMatches(choice.when, call({ ...command.arguments, [key]: changed }), ctx), `${c.id} changing ${key} does not get the recorded reply`);
		}
		if ('timeoutMs' in command.arguments) assert.ok(callMatches(choice.when, call({ ...command.arguments, timeoutMs: command.arguments.timeoutMs + 1000 }), ctx), `${c.id} timeoutMs is not semantic`);
		// The whole call must be that single action.
		const sequence = { name: 'sequence', args: { actions: [{ actionType: command.actionType, arguments: command.arguments }, { actionType: 'wait', arguments: { durationMs: 500 } }] } };
		assert.ok(!callMatches(choice.when, sequence, ctx), `${c.id} a longer sequence does not get the recorded reply`);
	}
});

// ---------- progression families (q9): stage kits and synthetic End views ----------

// Vanilla nutrition per item; the server's inventory.food sums count x nutrition and flags raw chicken, rotten flesh,
// spider eyes and poisonous potatoes as risky. Armour points of worn pieces restate the worn items.
const NUTRITION = { porkchop: 3, beef: 3, mutton: 2, chicken: 2, rabbit: 3, cod: 2, salmon: 2, cooked_porkchop: 8, cooked_beef: 8, cooked_mutton: 6, cooked_chicken: 6,
	cooked_rabbit: 5, cooked_cod: 5, cooked_salmon: 6, bread: 5, apple: 4, golden_apple: 4, golden_carrot: 6, carrot: 3, potato: 1, baked_potato: 5, beetroot: 1,
	melon_slice: 2, sweet_berries: 2, glow_berries: 2, dried_kelp: 1, cookie: 2, pumpkin_pie: 8, rotten_flesh: 4, spider_eye: 2, poisonous_potato: 2, mushroom_stew: 6 };
const ARMOR_POINTS = { leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3] };
const PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];

// Contradictions between the items a kit derivation declares and every restatement of them.
export function progressionContradictions(testCase) {
	const inv = testCase.source?.derived?.invariants ?? {};
	const problems = [];
	for (const [where, o] of observationsOf(testCase)) {
		const items = (o.inventory?.items ?? []).filter((it) => it.itemId !== 'minecraft:air' && it.count > 0);
		if (o.inventory?.food) {
			let n = 0, nutrition = 0;
			for (const it of items) { const s = it.itemId.slice(10); if (s in NUTRITION) { n += it.count; nutrition += it.count * NUTRITION[s]; } }
			if (o.inventory.food.items !== n || o.inventory.food.nutrition !== nutrition) problems.push(`${where}: food summary ${JSON.stringify(o.inventory.food)} but items give ${n} items, ${nutrition} nutrition`);
		}
		let armor = 0;
		for (const it of items) { const m = /^minecraft:(\w+?)_(helmet|chestplate|leggings|boots)$/.exec(it.itemId); if (m && ['head', 'chest', 'legs', 'feet'].includes(it.slot) && ARMOR_POINTS[m[1]]) armor += ARMOR_POINTS[m[1]][PIECES.indexOf(m[2])]; }
		if (inv.kit && o.player?.armor !== armor) problems.push(`${where}: armor ${o.player?.armor} but worn pieces give ${armor}`);
		const sections = o.coverage?.sections ?? {};
		for (const k of ['entities', 'blocks', 'landmarks', 'nearbyContainers']) if (inv.kit && sections[k] && sections[k].returned !== (o[k] ?? []).length) problems.push(`${where}: coverage says ${sections[k].returned} ${k} but ${(o[k] ?? []).length} are listed`);
		if (inv.kit) {
			const want = [...(inv.kit.hotbar ?? []), ...(inv.kit.main ?? [])].map(([id, n]) => `${id} x${n}`).concat((inv.kit.armor ?? []).map((id) => `${id} x1`), inv.kit.offhand ? [`${inv.kit.offhand} x1`] : []).sort();
			const got = items.map((it) => `${it.itemId} x${it.count}`).sort();
			if (JSON.stringify(want) !== JSON.stringify(got)) problems.push(`${where}: carries ${got.join(', ')} but the kit declares ${want.join(', ')}`);
			const held = inv.kit.hotbar?.[0]?.[0];
			if (held && items.find((it) => it.slot === 'mainhand')?.itemId !== held) problems.push(`${where}: holds ${items.find((it) => it.slot === 'mainhand')?.itemId} but the kit holds ${held}`);
			for (const id of inv.kit.armor ?? []) {
				const slot = { helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' }[/_(helmet|chestplate|leggings|boots)$/.exec(id)[1]];
				if (!items.some((it) => it.itemId === id && it.slot === slot)) problems.push(`${where}: ${id} is not worn`);
			}
		}
		if (inv.dimension) {
			if (o.world?.dimension !== inv.dimension) problems.push(`${where}: dimension ${o.world?.dimension} but the edit declares ${inv.dimension}`);
			for (const e of o.perception?.events ?? []) if (e.dimension && e.dimension !== inv.dimension) problems.push(`${where}: a ${e.type} event from ${e.dimension}`);
			for (const b of [...(o.blocks ?? []), ...(o.landmarks ?? [])]) {
				if (!Number.isFinite(b.distance)) continue;
				const d = Math.hypot(b.x + 0.5 - o.position.x, b.y + 0.5 - o.position.y, b.z + 0.5 - o.position.z);
				if (Math.abs(d - b.distance) > 0.01) problems.push(`${where}: landmark ${b.blockId} at ${b.x},${b.y},${b.z} distance ${b.distance} but ${d}`);
			}
		}
	}
	return problems;
}

test('every observation restates its food summary consistently; kit and End derivations hold what they declare', () => {
	const problems = cases.flatMap((c) => progressionContradictions(c).map((p) => `${c.id} ${p}`));
	assert.deepEqual(problems, []);
	const kits = cases.filter((c) => c.source.derived?.invariants?.kit);
	assert.ok(kits.length > 0, 'the progression stage kits are checked');
	for (const c of kits) assert.equal(c.state.previousObservations?.length ?? 0, 0, `${c.id} drops the recorded history that stated the old inventory`);
});

test('the progression checks catch a stale food summary, a wrong kit and a foreign dimension', () => {
	const item = (itemId, count, slot) => ({ itemId, count, slot, fingerprint: 'f', tags: [] });
	const o = { position: { x: 0, y: 64, z: 0 }, player: { armor: 0 }, world: { dimension: 'minecraft:overworld' }, coverage: { sections: { entities: { returned: 2 } } }, entities: [],
		inventory: { food: { items: 16, nutrition: 128 }, items: [item('minecraft:iron_sword', 1, 'mainhand'), item('minecraft:iron_chestplate', 1, 'chest')] }, landmarks: [{ x: 10, y: 64, z: 0, blockId: 'minecraft:obsidian', distance: 3 }] };
	const c = { source: { derived: { invariants: { kit: { hotbar: [['minecraft:iron_sword', 1], ['minecraft:cooked_beef', 16]], armor: ['minecraft:iron_chestplate'] }, dimension: 'minecraft:the_end' } } }, state: { observation: o } };
	const found = progressionContradictions(c).join('\n');
	assert.match(found, /food summary .* but items give 0 items/);
	assert.match(found, /armor 0 but worn pieces give 6/);
	assert.match(found, /coverage says 2 entities but 0 are listed/);
	assert.match(found, /but the kit declares/);
	assert.match(found, /dimension minecraft:overworld but the edit declares minecraft:the_end/);
	assert.match(found, /landmark minecraft:obsidian .* distance 3/);
});
