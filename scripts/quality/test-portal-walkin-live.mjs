#!/usr/bin/env node
// Provider-free check that move_to walks into a portal it targets, as a player steps onto it:
//   node scripts/quality/test-portal-walkin-live.mjs OUT_DIR [JAR]
// Fixtures (operator commands, floating stone decks at y149 in the Overworld):
//   end-lava  a 3x3 End portal in its frame ring over lava, the frame one block above the deck (a stronghold portal room)
//   end-air   the same pool over air
//   nether    a lit 2x3 Nether portal standing on the deck
//   across    move_to the deck beyond the End pool: the route must not fall into the portal
//   lava      move_to a lava cell beside the pool: still refused
// Each walk-in case passes when the body changes dimension through the agent's own move_to. No model call is made.
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE (or the worktree's server-template) and JAVA_HOME set.
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './watch-replay.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [outArg, jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE ?? path.join(root, 'server-template'), port = Number(process.env.SLOT_PORT_BASE);
if (!outArg || !port || !process.env.JAVA_HOME) throw new Error('Usage: OUT_DIR [JAR] under slot.sh live with JAVA_HOME');
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const AGENT = 'Portal';
const result = { cases: {} };
const s = await boot(out, { jar: path.resolve(jarArg ?? path.join(root, 'build/libs/arena-agents-0.2.0.jar')), template, port, world: null, seed: '20261024' });
const ow = 'execute in minecraft:overworld run';
const dimension = async () => String(await s.command(`data get entity ${AGENT} Dimension`)).match(/"([^"]+)"/)?.[1] ?? null;
const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map((v) => Math.round(Number(v) * 10) / 10) ?? null;
const brief = (r) => ({ state: r.state, reasonCode: r.reasonCode ?? null, message: r.message ?? null });

// An End portal pool: frame ring at y150 round a 3x3 at x..x+2, z..z+2, on a deck at y149 with `under` below the pool.
async function endPool(x, z, under) {
	await s.command(`${ow} fill ${x - 8} 149 ${z - 8} ${x + 10} 149 ${z + 10} minecraft:stone`);
	await s.command(`${ow} fill ${x - 8} 150 ${z - 8} ${x + 10} 156 ${z + 10} minecraft:air`);
	await s.command(`${ow} fill ${x} 148 ${z} ${x + 2} 149 ${z + 2} ${under}`);
	for (const [fx, fz, facing] of [[0, -1, 'south'], [1, -1, 'south'], [2, -1, 'south'], [0, 3, 'north'], [1, 3, 'north'], [2, 3, 'north'], [-1, 0, 'east'], [-1, 1, 'east'], [-1, 2, 'east'], [3, 0, 'west'], [3, 1, 'west'], [3, 2, 'west']])
		await s.command(`${ow} setblock ${x + fx} 150 ${z + fz} minecraft:end_portal_frame[facing=${facing},eye=true]`);
	await s.command(`${ow} fill ${x} 150 ${z} ${x + 2} 150 ${z + 2} minecraft:end_portal`);
}
async function place(x, y, z) {
	await s.command(`${ow} tp ${AGENT} ${x + 0.5} ${y} ${z + 0.5} -90 0`);
	await sleep(1500);
	await s.observe();
}
async function walkIn(name, start, target, expect) {
	await place(...start);
	const r = brief(await s.act('move_to', { tolerance: 0.6, ...target, sprint: false }));
	let entered = false;
	for (let i = 0; i < 40 && !entered; i++) { entered = (await dimension()) === expect; if (!entered) await sleep(250); }
	result.cases[name] = { move: r, dimension: await dimension(), at: await pos(), ok: entered };
	// Back to the Overworld deck for the next case.
	await s.command(`${ow} tp ${AGENT} 0.5 150 0.5`); await sleep(2500);
}
try {
	let e = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
		await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error('agent never registered');
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	// A dimension change advances the goal revision; later requests must carry the current one.
	s.bridge.on('goal_control', (g) => { if (g.agentId === s.record.agentId && Number.isSafeInteger(g.payload?.goalRevision) && g.payload.goalRevision !== s.record.goalRevision) {
		s.record.goalRevision = g.payload.goalRevision;
		s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
	} });
	const started = s.inbox.wait('goal_control', (g) => g.payload.operation === 'start');
	await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command('time set 1000'); await s.command('gamerule minecraft:advance_time false');
	await s.command(`gamemode survival ${AGENT}`); await s.command(`clear ${AGENT}`);
	await s.command(`${ow} forceload add -48 -48 48 48`); await sleep(2000);
	await s.command(`${ow} fill -2 149 -2 2 149 2 minecraft:stone`);

	// End portal over lava: frame ring at y150, the agent on the deck 5 blocks west, targets the pool centre cell.
	await endPool(20, 0, 'minecraft:lava');
	await walkIn('end-lava', [14, 150, 1], { x: 21.5, y: 150, z: 1.5 }, 'minecraft:the_end');
	// A model naming the portal block's integer cell.
	await endPool(20, 0, 'minecraft:lava');
	await walkIn('end-lava-cell', [14, 150, 1], { x: 21, y: 150, z: 1 }, 'minecraft:the_end');
	await endPool(-30, 0, 'minecraft:air');
	await walkIn('end-air', [-36, 150, 1], { x: -28.5, y: 150, z: 1.5 }, 'minecraft:the_end');

	// Nether portal: obsidian frame on the deck (x 0..3, z 20), the agent 4 blocks south, targets a portal cell.
	await s.command(`${ow} fill -8 149 14 10 149 30 minecraft:stone`); await s.command(`${ow} fill -8 150 14 10 156 30 minecraft:air`);
	await s.command(`${ow} fill 0 150 20 3 154 20 minecraft:obsidian`); await s.command(`${ow} fill 1 151 20 2 153 20 minecraft:nether_portal[axis=x]`);
	await walkIn('nether', [1, 150, 25], { x: 1.5, y: 151, z: 20.5 }, 'minecraft:the_nether');

	// Across: from west of a fresh lava pool to the deck east of it. The route goes round, the body stays here.
	await endPool(20, 0, 'minecraft:lava');
	await place(14, 150, 1);
	result.cases.across = { move: brief(await s.act('move_to', { x: 27.5, y: 150, z: 1.5, tolerance: 0.6, sprint: false })), dimension: await dimension(), at: await pos() };
	result.cases.across.ok = result.cases.across.dimension === 'minecraft:overworld';
	// Lava: a target in a lava cell beside the deck is still refused.
	await s.command(`${ow} setblock 16 149 6 minecraft:lava`);
	await place(14, 150, 1);
	result.cases.lava = { move: brief(await s.act('move_to', { x: 16.5, y: 149, z: 6.5, tolerance: 0.6, sprint: false })), dimension: await dimension(), at: await pos() };
	result.cases.lava.ok = result.cases.lava.move.state !== 'SUCCEEDED' && (result.cases.lava.at?.[1] ?? 0) >= 149.9;
	result.ok = Object.values(result.cases).every((c) => c.ok);
} catch (error) {
	result.error = String(error?.stack ?? error);
} finally {
	await s.stop().catch(() => {});
}
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
