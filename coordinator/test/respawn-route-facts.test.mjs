import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dropLoss, lostItemsText, recoveryRoute, respawnLead } from '../src/respawn-recovery.mjs';
import { RecoveryProgressStore } from '../src/recovery-progress-wrap.mjs';
import { spawnLine } from '../src/wake-body-facts.mjs';
import { isNewContextEventInput, NEW_CONTEXT_EVENT_INSTRUCTION } from '../src/native-event-instructions.mjs';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';

const T0 = 1_800_000_000_000;
const OW = 'minecraft:overworld', NETHER = 'minecraft:the_nether', END = 'minecraft:the_end';
const kit = [{ itemId: 'minecraft:cobblestone', count: 64 }, { itemId: 'minecraft:flint_and_steel', count: 1 }, { itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:golden_helmet', count: 1 }];
const here = (dimension, x, y, z, blocks = []) => ({ ready: true, observedAtEpochMs: T0 + 5_000, world: { worldId: 'w', dimension }, position: { x, y, z }, blocks });

test('the void and lava destroy drops; other deaths leave them', () => {
	assert.equal(dropLoss({ cause: 'a fell out of the world', dimensionId: END, y: -229 }), 'void');
	assert.equal(dropLoss({ cause: 'a was slain by Enderman', dimensionId: END, y: -70 }), 'void');
	assert.equal(dropLoss({ cause: 'a tried to swim in lava', dimensionId: NETHER, y: 31 }), 'lava');
	// A magma block floor is not lava.
	assert.equal(dropLoss({ cause: 'a discovered the floor was lava', dimensionId: NETHER, y: 34 }), null);
	assert.equal(dropLoss({ cause: 'a was slain by Piglin', dimensionId: NETHER, y: 93 }), null);
	assert.equal(lostItemsText(kit), 'iron_pickaxe, golden_helmet, flint_and_steel, cobblestone x64');
});

test('the way back names the portal in view or remembered and where its far side lands', () => {
	const end = { cause: 'a slain', dimensionId: END, x: 5, y: 64, z: -12 };
	const portal = { blockId: 'minecraft:end_portal', x: 259, y: 68, z: 2542 };
	assert.equal(recoveryRoute(end, here(OW, 256.5, 69, 2543.5, [portal])),
		'Way back: End portal in view 3 blocks away @259,68,2542; jumping in, with any inventory or none, puts you on the obsidian platform at 100,49,0, 96 blocks from the drops. The platform is usually 20-30 blocks of void from the island; without blocks or a pearl, it is a dead end over the void.');
	assert.match(recoveryRoute(end, here(OW, 256.5, 69, 2543.5)), /no End portal location remembered/);
	const nether = { cause: 'a slain', dimensionId: NETHER, x: -6, y: 42, z: 47, portal: { from: { dimension: OW, x: -13, y: -54, z: 99 }, to: { dimension: NETHER, x: 9, y: 37, z: 24 } } };
	assert.equal(recoveryRoute(nether, here(OW, -4.5, -53, 96.5)), 'Way back: the portal you entered by @-13,-54,99, 9 blocks from you; it led to @9,37,24 in the Nether, 27 blocks from the drops.');
	// Without the far side, the 1/8 link rule.
	const { portal: _, ...unlinked } = nether;
	assert.match(recoveryRoute(unlinked, here(OW, -4.5, -53, 96.5, [{ blockId: 'minecraft:nether_portal', x: -9, y: -52, z: 101 }])), /links to the Nether portal nearest -2,12 \(1\/8 of its x,z\)/);
	// Same dimension: the existing distance facts say it.
	assert.equal(recoveryRoute({ ...nether, dimensionId: OW }, here(OW, 0, 64, 0)), null);
});

test('the respawn lead states the drops, their clock and the way back, or that the void took them', () => {
	const recovery = { lastDeath: { cause: 'a was slain by Piglin', dimensionId: NETHER, x: -6, y: 42, z: 47, diedAtEpochMs: T0, portal: { from: { dimension: OW, x: -13, y: -54, z: 99 }, to: { dimension: NETHER, x: 9, y: 37, z: 24 } } }, lastLostInventory: kit };
	Object.defineProperty(recovery, 'dropTicking', { value: { simulationDistance: 6, tickedSeconds: 4, tickingNow: false } });
	assert.ok(respawnLead(recovery, here(OW, -4.5, -53, 96.5)).startsWith(
		'Respawned. Your drops wait where you died in the Nether @-6,42,47 (slain by Piglin): iron_pickaxe, golden_helmet, flint_and_steel, cobblestone x64; ~4 of 5 min left; they age only while you are near them (within 96 blocks), paused now. Way back: the portal you entered by @-13,-54,99, 9 blocks from you; it led to @9,37,24 in the Nether, 27 blocks from the drops.'));
	const fell = { ...recovery, lastDeath: { ...recovery.lastDeath, cause: 'a fell out of the world', dimensionId: END, y: -229 } };
	assert.ok(respawnLead(fell, here(OW, 0, 64, 0)).startsWith('Respawned. Everything carried fell into the void with you (fell out of the world) and is gone: nothing to recover.'));
	assert.equal(respawnLead({ ...recovery, lastLostInventory: [] }, here(OW, 0, 64, 0)), null);
	// Once the drop time is spent there is nothing to say.
	const spent = { ...recovery };
	Object.defineProperty(spent, 'dropTicking', { value: { simulationDistance: 6, tickedSeconds: 300, tickingNow: true } });
	assert.equal(respawnLead(spent, here(OW, 0, 64, 0)), null);
	assert.ok(isNewContextEventInput(`${NEW_CONTEXT_EVENT_INSTRUCTION} Respawned. Your drops wait\n{}`));
});

test('a portal crossing in an earlier life is the way back for a later death in that dimension', () => {
	const store = new RecoveryProgressStore();
	const obs = (at, dimension, position, extra = {}) => ({ ready: true, observedAtEpochMs: at, world: { worldId: 'w', dimension }, position, inventory: { items: kit.map((item, slot) => ({ ...item, slot })) }, ...extra });
	// The End portal teleports on contact: the last Overworld sample shows it beside the body, not around it.
	store.remember('a', 1, obs(T0, OW, { x: 256.5, y: 69, z: 2543.5 }, { blocks: [{ blockId: 'minecraft:end_portal', x: 259, y: 68, z: 2542 }] }));
	store.remember('a', 1, obs(T0 + 1_000, END, { x: 100.5, y: 49, z: 0.5 }));
	store.remember('a', 1, { ready: false, observedAtEpochMs: T0 + 9_000, death: { cause: 'a was slain by Enderman', dimensionId: END, x: 5, y: 64, z: -12, diedAtEpochMs: T0 + 9_000 } });
	store.remember('a', 1, obs(T0 + 12_000, OW, { x: 256.5, y: 69, z: 2543.5 }, { inventory: { items: [] } }));
	assert.deepEqual(store.snapshot('a', obs(T0 + 12_000, OW, { x: 256.5, y: 69, z: 2543.5 })).lastDeath.portal.from, { dimension: OW, x: 259, y: 68, z: 2542 });
	// A second death in the End after re-entering through the same portal keeps the way back.
	store.remember('a', 1, obs(T0 + 20_000, END, { x: 100.5, y: 49, z: 0.5 }));
	store.remember('a', 1, { ready: false, observedAtEpochMs: T0 + 30_000, death: { cause: 'a was slain by Enderman', dimensionId: END, x: 6, y: 64, z: -12, diedAtEpochMs: T0 + 30_000 } });
	assert.equal(store.snapshot('a', obs(T0 + 31_000, OW, { x: 256.5, y: 69, z: 2543.5 })).lastDeath.portal.source, 'remembered_crossing');
});

test('by day the bed line says where the next death respawns and what sets it', () => {
	const day = (items, extra = {}) => ({ ready: true, world: { dimension: OW }, inventory: { items }, blocks: [], entities: [], ...extra });
	assert.match(spawnLine(day([{ itemId: 'minecraft:white_bed', count: 1 }])), /^respawn: no bed use seen yet; white_bed held: placed and used \(by day too: "Respawn point set"/);
	assert.match(spawnLine(day([{ itemId: 'minecraft:black_wool', count: 2 }, { itemId: 'minecraft:oak_planks', count: 8 }], { entities: [{ type: 'minecraft:sheep', appearance: { woolColor: 'black' } }] })),
		/wool 2 black_wool\/3, planks 8\/3, table not held\/seen; sheep in view \(black\): shears or a kill give wool; a bed = 3 wool of one colour/);
	assert.equal(spawnLine(day([{ itemId: 'minecraft:white_bed', count: 1 }]), { kind: 'set', dimension: OW, x: 1, y: 2, z: 3, at: 1 }), null);
	assert.equal(spawnLine(day([{ itemId: 'minecraft:dirt', count: 1 }])), null);
	assert.equal(spawnLine({ ...day([{ itemId: 'minecraft:white_bed', count: 1 }]), world: { dimension: NETHER } }), null);
});

const recover = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/extra/d31-respawn-recovery.json', import.meta.url)));
const beds = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/extra/d31-bed-spawn.json', import.meta.url)));
const lava = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/extra/d31-nether-lava-recovery.json', import.meta.url)));

test('respawn and bed cases keep provenance and their wakes carry the new facts', async () => {
	for (const file of [recover, beds, lava]) {
		validateCaseFile(file.cases);
		for (const c of file.cases) {
			assert.equal(c.source.observationSha256, observationSha256(c.state.observation));
			for (const section of ['Good:', 'Bad:', 'Neutral:']) assert.ok(c.expect.judge.rubric.includes(section), c.id);
		}
	}
	const wake = async (file, id) => {
		const { encodedInput } = await renderWake(file.cases.find(c => c.id === id), { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' });
		return { head: encodedInput.slice(0, encodedInput.indexOf('\n')), data: JSON.parse(encodedInput.slice(encodedInput.indexOf('\n') + 1)).data };
	};
	const end = await wake(recover, 'respawn-kit-end-01');
	assert.match(end.head, /Respawned\. Your drops wait where you died in the End @5,64,-13 \(slain by Enderman\): iron_sword/);
	assert.match(end.head, /Way back: End portal in view 3 blocks away @259,68,2542; jumping in/);
	assert.match(end.head, /without blocks or a pearl, it is a dead end over the void/);
	assert.match((await wake(recover, 'respawn-kit-end-void-04')).head, /fell into the void with you \(fell out of the world\) and is gone/);
	assert.match((await wake(recover, 'respawn-kit-nether-06')).head, /Way back: the portal you entered by @-13,-54,99, 9 blocks from you; it led to @9,37,24 in the Nether, 27 blocks from the drops\./);
	assert.match((await wake(beds, 'bed-spawn-sheep-05')).data.now.sleep, /sheep in view \(black\)/);
});

test('Nether lava deaths say what burned without claiming which, whichever way the drops went', async () => {
	const head = async (id) => { const { encodedInput } = await renderWake(lava.cases.find(c => c.id === id), { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' }); return encodedInput.slice(0, encodedInput.indexOf('\n')); };
	const lead = /Respawned\. You died in lava in the Nether @-?\d+,\d+,-?\d+ \(tried to swim in lava[^)]*\): drops that fell into it burned; any that landed beside it wait there \(~4 of 5 min left; .*?, paused now\)\. Carried then: [^.]*iron_pickaxe/;
	// 01: stacks (the iron pickaxe among them) waited beside the lava; 02: everything burned. The wake is the same claim.
	for (const id of ['respawn-nether-lava-01', 'respawn-nether-lava-02']) {
		const text = await head(id);
		assert.match(text, lead, id);
		assert.match(text, /Way back: the portal you entered by @-?\d+,-5[34],\d+, \d+ blocks from you; it led to @9,37,24 in the Nether, \d+ blocks from the drops\./, id);
		assert.doesNotMatch(text, /Your drops wait where you died/, id);
	}
	assert.equal(lava.cases[0].source.dropsAfterGame.survived.some(i => i.itemId === 'minecraft:iron_pickaxe'), true);
	assert.deepEqual(lava.cases[1].source.dropsAfterGame.survived, []);
	// A game begun at a Nether save point never saw the Overworld side of a portal: no way back is claimed.
	const unknown = await head('respawn-nether-lava-07');
	assert.match(unknown, lead);
	assert.match(unknown, /Way back: no Overworld Nether portal remembered\./);
});
