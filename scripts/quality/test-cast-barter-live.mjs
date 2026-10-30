#!/usr/bin/env node
// Provider-free check of the model-chosen goal skills cast_obsidian and barter_until through the production action path.
//   node scripts/quality/test-cast-barter-live.mjs cast-count CHECKPOINT.json OUT_DIR [JAR]   (lava-pool: >= 4 new obsidian)
//   node scripts/quality/test-cast-barter-live.mjs cast-frame CHECKPOINT.json OUT_DIR [JAR]   (lava-half-frame: complete 4x5 frame)
//   node scripts/quality/test-cast-barter-live.mjs barter FIXTURE.json OUT_DIR [JAR]          (piglin room: items gained, count matches inventory)
// Boots the save point's seed, applies its setup with the production applyQualitySetup, looks at the pool (as the model
// would before naming it), sends one action and checks the world with operator reads. No model call is made; operator
// commands build the fixture and read the outcome only. Launch under fix-slot.sh (SLOT_PORT_BASE) with
// ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME. RANDOM_SALT=N reseeds loot rolls for barter trials.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { boot } from './watch-replay.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [mode, fixtureFile, outArg, jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!['cast-count', 'cast-frame', 'barter'].includes(mode) || !fixtureFile || !outArg || !template || !port || !process.env.JAVA_HOME)
	throw new Error('Usage: cast-count|cast-frame|barter FIXTURE.json OUT_DIR [JAR] under fix-slot.sh with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
// A partial-frame save point names its starting obsidian; the frame origin is their lowest corner, the axis the one they span.
if (mode === 'cast-frame' && !fixture.frame && fixture.initialObsidian?.length) {
	const cells = fixture.initialObsidian, sameZ = cells.every(c => c[2] === cells[0][2]);
	fixture.frame = { axis: sameZ ? 'x' : 'z', origin: [Math.min(...cells.map(c => c[0])), Math.min(...cells.map(c => c[1])), Math.min(...cells.map(c => c[2]))] };
}
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Probe';
const result = { mode, fixture: path.basename(fixtureFile), salt: process.env.RANDOM_SALT ?? null };
const s = await boot(out, { jar: path.resolve(jarArg ?? path.join(root, 'build/libs/arena-agents-0.2.0.jar')), template, port, world: null, seed: fixture.seed, readyTimeoutMs: 90000 });
const count = text => Number(/count: (\d+)/i.exec(String(text))?.[1] ?? 0);
const held = async item => count(await s.command(`execute if items entity ${AGENT} container.* ${item}`));
const isBlock = async (dim, [x, y, z], block) => /passed/i.test(String(await s.command(`execute in ${dim} if block ${x} ${y} ${z} ${block}`)));
async function act(type, args, ms) {
	const id = `skill-${++s.ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: s.record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: s.record.provider, model: s.record.model, reasoningEffort: s.record.reasoningEffort, serviceTier: s.record.serviceTier, traceId: id, programId: 'skill-test', programVersion: 1, sourceStepId: id, eventSequence: s.observation?.eventSequence ?? 0 } };
	const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), ms);
	await s.bridge.send('action_command', s.record.agentId, payload);
	const r = (await next).payload;
	await s.bridge.send('action_result_ack', s.record.agentId, { actionId: id, goalRevision: s.record.goalRevision });
	return { state: r.state, reasonCode: r.reasonCode, message: r.message };
}
async function obsidianIn(dim, [x0, y0, z0], [x1, y1, z1]) {
	const cells = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++)
		if (await isBlock(dim, [x, y, z], 'minecraft:obsidian')) cells.push([x, y, z]);
	return cells;
}
try {
	let e = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
		result.summon = await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${result.summon}`);
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const command = async text => ({ text: await s.command(text) });
	let setup = { ...fixture.setup, ...(process.env.RANDOM_SALT ? { randomSalt: Number(process.env.RANDOM_SALT) } : {}) };
	let room = null;
	if (mode === 'barter') {
		// Nether wastes found from the seed; a sealed netherrack room keeps lava and wandering mobs out.
		const located = await s.command(`execute in minecraft:the_nether positioned 0 70 0 run locate biome ${fixture.room.biome}`);
		const m = /\[(-?\d+),\s*(~|-?\d+),\s*(-?\d+)\]/.exec(located);
		if (!m) throw new Error(`locate failed: ${located}`);
		const [x, y, z] = [Number(m[1]), fixture.room.y, Number(m[3])];
		const r = fixture.room.half;
		room = { at: [x, y, z], located };
		setup = { ...setup, position: [x + 0.5, y, z + 0.5], commands: [
			`execute in minecraft:the_nether run forceload add ${x - 16} ${z - 16} ${x + 16} ${z + 16}`,
			`execute in minecraft:the_nether run fill ${x - r - 1} ${y - 1} ${z - r - 1} ${x + r + 1} ${y + 4} ${z + r + 1} minecraft:netherrack`,
			`execute in minecraft:the_nether run fill ${x - r} ${y} ${z - r} ${x + r} ${y + 3} ${z + r} minecraft:air`,
			`execute in minecraft:the_nether run setblock ${x} ${y + 3} ${z} minecraft:glowstone`,
		] };
	}
	const receipt = await applyQualitySetup(setup, command, AGENT);
	await activateQualitySetup(receipt, command, { stage: 'goal-start' });
	await activateQualitySetup(receipt, command, { stage: 'first-decision' });
	await s.command('tick unfreeze').catch(() => {});
	await s.command('difficulty normal');
	const dim = setup.dimension;
	result.start = String(await s.command(`data get entity ${AGENT} Pos`));
	await s.observe();
	if (mode === 'barter') {
		const [x, y, z] = room.at;
		for (const [i, [dx, dz]] of fixture.room.piglins.entries())
			await s.command(`execute in minecraft:the_nether run summon minecraft:piglin ${x + dx + 0.5} ${y} ${z + dz + 0.5} {PersistenceRequired:1b,IsImmuneToZombification:1b,UUID:[I;0,0,7,${i + 1}]}`);
		await sleep(2000);
		const o = await s.observe();
		result.piglinsSeen = (o.entities ?? []).filter(row => row.type === 'minecraft:piglin').length;
		result.before = { wanted: await held(fixture.item), gold: await held('minecraft:gold_ingot') };
		const t0 = Date.now();
		result.action = await act('barter_until', { itemId: fixture.item, count: fixture.count, timeoutMs: fixture.timeoutMs }, fixture.timeoutMs + 30000);
		result.seconds = Math.round((Date.now() - t0) / 1000);
		result.after = { wanted: await held(fixture.item), gold: await held('minecraft:gold_ingot') };
		const reported = Number(new RegExp(`${fixture.item} gained: (\\d+)`).exec(result.action.message ?? '')?.[1] ?? NaN);
		const thrown = Number(/gold ingots thrown (\d+)/.exec(result.action.message ?? '')?.[1] ?? NaN);
		const gainedAll = /all items gained: (.*)$/.exec(result.action.message ?? '')?.[1] ?? '';
		result.check = { reported, actual: result.after.wanted - result.before.wanted, thrown, goldSpent: result.before.gold - result.after.gold, gainedAll };
		result.ok = result.check.reported === result.check.actual && gainedAll !== 'none' && gainedAll !== ''
			&& ['BARTER_COUNT_REACHED', 'OUT_OF_GOLD', 'BARTER_TIMED_OUT'].includes(result.action.reasonCode);
	} else {
		// The model names a pool it has seen: turn toward it first, as a player would before choosing the spot.
		const edge = fixture.lavaPool.edge;
		await act('look_at', { x: edge[0] + 0.5, y: edge[1] + 0.5, z: edge[2] + 0.5 }, 10000);
		await s.observe(); await sleep(500); await s.observe();
		const box = [[edge[0] - 8, edge[1] - 2, edge[2] - 8], [edge[0] + 6, edge[1] + 6, edge[2] + 8]];
		const before = await obsidianIn(dim, ...box);
		const t0 = Date.now();
		const args = mode === 'cast-frame'
			? { x: fixture.frame.origin[0], y: fixture.frame.origin[1], z: fixture.frame.origin[2], axis: fixture.frame.axis, frame: true, timeoutMs: 240000 }
			: { x: edge[0], y: edge[1], z: edge[2], count: 4, timeoutMs: 240000 };
		result.args = args;
		result.action = await act('cast_obsidian', args, 270000);
		result.seconds = Math.round((Date.now() - t0) / 1000);
		const after = await obsidianIn(dim, ...box);
		const key = c => c.join(',');
		const old = new Set(before.map(key));
		result.newObsidian = after.filter(c => !old.has(key(c))).length;
		result.health = String(await s.command(`data get entity ${AGENT} Health`));
		if (mode === 'cast-frame') {
			const [ox, oy, oz] = fixture.frame.origin;
			const along = (i, y) => fixture.frame.axis === 'z' ? [ox, oy + y, oz + i] : [ox + i, oy + y, oz];
			const cells = [along(1, 0), along(2, 0), along(0, 1), along(3, 1), along(0, 2), along(3, 2), along(0, 3), along(3, 3), along(1, 4), along(2, 4)];
			const missing = [];
			for (const c of cells) if (!(await isBlock(dim, c, 'minecraft:obsidian'))) missing.push(c);
			const blockedInterior = [];
			for (const i of [1, 2]) for (const y of [1, 2, 3]) if (!(await isBlock(dim, along(i, y), 'minecraft:air')) && !(await isBlock(dim, along(i, y), 'minecraft:water'))) blockedInterior.push(along(i, y));
			result.frame = { missing, blockedInterior };
			result.ok = missing.length === 0;
		} else {
			result.ok = result.newObsidian >= 4;
		}
		result.alive = !/No entity/i.test(result.health);
	}
} catch (error) {
	result.error = String(error?.stack ?? error);
} finally {
	await s.stop().catch(() => {});
}
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, action: result.action, newObsidian: result.newObsidian, frame: result.frame, check: result.check, seconds: result.seconds, error: result.error?.slice(0, 400) }));
process.exit(result.ok ? 0 : 1);
