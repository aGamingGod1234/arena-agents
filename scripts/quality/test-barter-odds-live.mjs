#!/usr/bin/env node
// Provider-free measurement of real piglin barter odds: node scripts/quality/test-barter-odds-live.mjs OUT_DIR
// Barters draw from the world's minecraft:gameplay/piglin_bartering random sequence, seeded by the world seed and the
// table id alone, so one save point repeats its barters exactly (2026-10-23: three games from one save point all got
// the same 6 pearls from 10 gold). Here 8 adult piglins in glass cells take gold ingots dropped beside them and barter
// as in vanilla; before each trial `random reset` reseeds that sequence with a new salt (what a save point's randomSalt
// does). Trials of 10, 30 and 60 ingots give the pearl rate per ingot and the game time per ingot. Controls: the
// unsalted world-default sequence twice, and one salt twice, each must repeat exactly. Operator commands build the
// fixture; no model or agent body is involved. Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and
// JAVA_HOME. BARTER_TRIALS="10x40,30x15,60x10" overrides the trial plan.
import { writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';

const out = resolve(process.argv[2] ?? 'runtime/barter-odds-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE || !process.env.JAVA_HOME) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME and launch under slot.sh live');
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
const plan = (process.env.BARTER_TRIALS ?? '10x40,30x15,60x10').split(',').map(part => part.split('x').map(Number)).map(([ingots, trials]) => ({ ingots, trials }));
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await cp(template, server, { recursive: true });
// Vanilla mechanics only: the arena mod is not loaded.
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
const secret = randomBytes(32).toString('hex');
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261024\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=4\nsimulation-distance=4\npause-when-empty-seconds=-1\nspawn-monsters=false\nspawn-animals=false\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(`${process.env.JAVA_HOME}/bin/java`, ['-Xms512M', '-Xmx1536M', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
const sleep = ms => new Promise(done => setTimeout(done, ms));
let rcon;
const command = async text => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 10000 }); await rcon.connect(); }
	return String((await rcon.command(text)).text);
};
const PIGLINS = 8;
// Flat world: bedrock at y-64, stone up to y-61, so pens stand on y-61.
const cell = index => ({ x: index * 4 + 0.5, y: -60, z: 0.5 });
const score = async (objective, holder = 'Total') => Number(/has (-?\d+)/.exec(await command(`scoreboard players get ${holder} ${objective}`))?.[1] ?? NaN);
// Item stacks merge on the ground, so counts are summed from each item entity's stack size.
async function groundCount(itemId) {
	await command('scoreboard players reset * odds');
	await command(`execute as @e[type=minecraft:item] if items entity @s contents ${itemId} store result score @s odds run data get entity @s Item.count`);
	await command('scoreboard players set Total odds 0');
	await command('scoreboard players operation Total odds += @e[type=minecraft:item] odds');
	return score('odds');
}
async function trial(ingots, salt, { sprint = true, piglins = PIGLINS } = {}) {
	await command('kill @e[type=minecraft:item]');
	if (salt === null) await command('random reset minecraft:gameplay/piglin_bartering');
	else await command(`random reset minecraft:gameplay/piglin_bartering ${salt}`);
	const start = Number(/(\d+)/.exec(await command('time query gametime'))?.[1]);
	for (let index = 0; index < piglins; index++) {
		const share = Math.floor(ingots / piglins) + (index < ingots % piglins ? 1 : 0);
		const at = cell(index);
		if (share) await command(`summon minecraft:item ${at.x} ${at.y} ${at.z} {Item:{id:"minecraft:gold_ingot",count:${share}},PickupDelay:0}`);
	}
	if (sprint) await command('tick sprint 200000');
	let gold = ingots, idle = 0, polls = 0, done = null;
	// Done once no gold lies on the ground and no piglin still holds one it is admiring (polled several times).
	while (idle < 3 && polls < 1200) {
		await sleep(250); polls++;
		gold = await groundCount('minecraft:gold_ingot');
		// An admiring piglin holds the ingot in its offhand; the count sums over every piglin.
		const admiring = Number(/count: (\d+)/i.exec(await command('execute if items entity @e[type=minecraft:piglin] weapon.offhand minecraft:gold_ingot'))?.[1] ?? 0);
		idle = gold === 0 && admiring === 0 ? idle + 1 : 0;
		if (idle === 1) done = Number(/(\d+)/.exec(await command('time query gametime'))?.[1]);
	}
	if (sprint) await command('tick sprint stop');
	const end = done ?? Number(/(\d+)/.exec(await command('time query gametime'))?.[1]);
	// Natural piglins hold a crossbow or golden sword, so they never take thrown pearls; any held one still counts.
	const held = Number(/count: (\d+)/i.exec(await command('execute if items entity @e[type=minecraft:piglin] weapon.* minecraft:ender_pearl'))?.[1] ?? 0);
	await command('clear @e[type=minecraft:piglin] minecraft:ender_pearl').catch(() => '');
	const pearls = await groundCount('minecraft:ender_pearl') + held;
	// Obsidian and fire charges (weight 40 each, always 1) check that every ingot was bartered: ~8.5% of ingots each.
	const obsidian = await groundCount('minecraft:obsidian'), fireCharges = await groundCount('minecraft:fire_charge');
	return { ingots, salt, pearls, heldByPiglins: held, obsidian, fireCharges, goldLeft: gold, ticks: end - start, completed: idle >= 3 };
}
const result = { piglins: PIGLINS, plan, trials: [], controls: {} };
try {
	for (let attempt = 0; attempt < 180; attempt++) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 10000 }); await rcon.connect(); break; } catch (error) { await rcon?.close(); if (attempt === 179) throw error; await sleep(1000); } }
	await command('difficulty easy'); await command('gamerule minecraft:send_command_feedback false'); await command('time set noon');
	await command('scoreboard objectives add odds dummy');
	await command('forceload add -8 -8 40 8'); await sleep(2000);
	for (let index = 0; index < PIGLINS; index++) {
		const at = cell(index), x = Math.floor(at.x);
		await command(`fill ${x - 1} -61 -1 ${x + 1} -57 1 minecraft:glass hollow`); await command(`fill ${x} -60 0 ${x} -58 0 minecraft:air`);
		result.summon = await command(`summon minecraft:piglin ${at.x} ${at.y} ${at.z} {IsImmuneToZombification:1b,PersistenceRequired:1b,equipment:{mainhand:{id:"minecraft:golden_sword",count:1}}}`);
	}
	await sleep(1500);
	result.armed = Number(/count: (\d+)/i.exec(await command('execute if items entity @e[type=minecraft:piglin] weapon.mainhand minecraft:golden_sword'))?.[1] ?? 0);
	result.piglinCount = Number(/count: (\d+)/i.exec(await command('execute if entity @e[type=minecraft:piglin]'))?.[1] ?? 0);
	// Controls: the world-default sequence (an unsalted save point) and one salt, each twice.
	result.controls.worldDefault = [await trial(10, null), await trial(10, null)];
	result.controls.sameSalt = [await trial(10, 777), await trial(10, 777)];
	// Game time per ingot at the normal tick rate (sprinted trials poll too coarsely to time).
	result.timing = [await trial(6, 5, { sprint: false, piglins: 1 }), await trial(24, 6, { sprint: false })];
	let salt = Number(process.env.BARTER_SALT_BASE ?? 1000);
	for (const { ingots, trials } of plan) for (let index = 0; index < trials; index++) result.trials.push(await trial(ingots, salt++));
	const summary = {};
	for (const { ingots } of plan) {
		const rows = result.trials.filter(row => row.ingots === ingots && row.completed);
		const pearls = rows.map(row => row.pearls);
		summary[ingots] = { trials: rows.length, meanPearls: +(pearls.reduce((a, b) => a + b, 0) / rows.length).toFixed(2), zeroPearlTrials: pearls.filter(n => n === 0).length,
			atLeast4: pearls.filter(n => n >= 4).length, min: Math.min(...pearls), max: Math.max(...pearls),
		};
	}
	const all = result.trials.filter(row => row.completed);
	const ingotsTotal = all.reduce((a, row) => a + row.ingots, 0), pearlsTotal = all.reduce((a, row) => a + row.pearls, 0);
	const fixed = all.reduce((a, row) => a + row.obsidian + row.fireCharges, 0);
	result.summary = { byIngots: summary, ingots: ingotsTotal, pearls: pearlsTotal, obsidianAndFireChargesPerIngot: +(fixed / ingotsTotal).toFixed(4), vanillaObsidianAndFireChargesPerIngot: +(80 / 469).toFixed(4), pearlsPerIngot: +(pearlsTotal / ingotsTotal).toFixed(4), ingotsPerPearl: +(ingotsTotal / pearlsTotal).toFixed(1), vanillaPearlsPerIngot: +(10 / 469 * 3).toFixed(4),
		secondsPerIngotOnePiglin: +(result.timing[0].ticks / 20 / result.timing[0].ingots).toFixed(2), secondsPerIngotEightPiglins: +(result.timing[1].ticks / 20 / result.timing[1].ingots).toFixed(2) };
	result.ok = result.piglinCount === PIGLINS && result.armed === PIGLINS && all.length === result.trials.length
		&& result.controls.worldDefault[0].pearls === result.controls.worldDefault[1].pearls && result.controls.sameSalt[0].pearls === result.controls.sameSalt[1].pearls
		&& new Set(result.trials.filter(row => row.ingots === plan[0].ingots).map(row => row.pearls)).size > 1;
} catch (error) {
	result.error = String(error?.stack ?? error);
} finally {
	if (rcon) await command('stop').catch(() => {});
	await rcon?.close();
	await Promise.race([new Promise(done => child.once('exit', done)), sleep(15000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, summary: result.summary, controls: result.controls, error: result.error }, null, 2));
process.exit(result.ok ? 0 : 1);
