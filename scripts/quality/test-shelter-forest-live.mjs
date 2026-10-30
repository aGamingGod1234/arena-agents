#!/usr/bin/env node
// Provider-free build_shelter at natural warped-forest ground points (OPUS-PLAN E6 bar: >= 9/10 per seed).
// CHECKPOINT OUT JAR [points=10], under fix-slot.sh. The operator picks points with spreadplayers around the save
// point's start (never shown to the body); hostile spawns are off, so this measures construction only.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { boot } from './watch-replay.mjs';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
const [checkpointFile, outArg, jarArg, pointsArg = '10', pairedArg] = process.argv.slice(2);
// pairedArg: an earlier shelter-forest.json; its feet are reused (same seed, same terrain) so arms are paired.
const paired = pairedArg ? JSON.parse(await readFile(pairedArg, 'utf8')).points : null;
const cp = JSON.parse(await readFile(checkpointFile, 'utf8')), out = path.resolve(outArg), jar = path.resolve(jarArg), points = Number(pointsArg);
if (!process.env.SLOT_PORT_BASE) throw Error('Use fix-slot.sh'); await mkdir(out, { recursive: true }); if ((await readdir(out)).length) throw Error('Fresh output required');
const result = { kind: 'provider-free build_shelter at natural forest points; no combat claim', checkpoint: path.basename(checkpointFile), seed: cp.seed,
	checkpointSha256: createHash('sha256').update(await readFile(checkpointFile)).digest('hex'), jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), points: [] };
const save = () => writeFile(path.join(out, 'shelter-forest.json'), JSON.stringify(result, null, 2) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const openings = ['north', 'east', 'south', 'west'];
let s;
try {
	s = await boot(out, { jar, template: process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port: Number(process.env.SLOT_PORT_BASE), world: null, seed: cp.seed, spawnMonsters: false, goalTicks: 150000 });
	const registered = s.inbox.wait('agent_registered', () => true, 45000);
	let summon; for (let i = 0; i < 20; i++) {
		summon = await s.command('execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low Probe'); if (!summon.includes('MODEL_CATALOG_UNAVAILABLE')) break;
		await s.bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Model-free shelter', reasoningEfforts: ['low'], serviceTiers: ['default'] }] }); await sleep(100);
	}
	if (!summon.includes('Creating')) { registered.catch(() => {}); throw Error('SUMMON_REFUSED'); }
	const e = await registered; s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId }; await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const start = s.inbox.wait('goal_control', g => g.payload.operation === 'start'); await s.command('codex start Probe Survive for 7000 seconds.'); s.record.goalRevision = (await start).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const setup = await applyQualitySetup({ ...cp.setup, randomSalt: 1 }, async command => ({ text: await s.command(command) }), 'Probe');
	await activateQualitySetup(setup, async command => ({ text: await s.command(command) }), { stage: 'goal-start' });
	await s.command('tick unfreeze'); await s.command('gamerule minecraft:spawn_mobs false'); await s.command('difficulty normal');
	const origin = (await s.observe()).position;
	for (let i = 0; i < points; i++) {
		// A ring of 10 points about 16 blocks apart around the start; spreadplayers lands on natural ground under y 128.
		const a = i * 2 * Math.PI / points, px = Math.round(origin.x + 24 * Math.cos(a)), pz = Math.round(origin.z + 24 * Math.sin(a));
		await s.command('kill @e[type=!minecraft:player,distance=..64]');
		const spread = paired ? await s.command(`execute in minecraft:the_nether run tp Probe ${paired[i].feet.x + 0.5} ${paired[i].feet.y} ${paired[i].feet.z + 0.5}`)
			: await s.command(`execute in minecraft:the_nether run spreadplayers ${px} ${pz} 0 6 under 120 false Probe`);
		await s.command('effect clear Probe'); await s.command('clear Probe'); await s.command('give Probe minecraft:cobblestone 64'); await s.command('give Probe minecraft:iron_pickaxe');
		await s.command('effect give Probe minecraft:fire_resistance 120 0 true'); await s.command('effect give Probe minecraft:resistance 120 4 true');
		await sleep(1000);
		let o = await s.observe(); const p = o.position, feet = { x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) };
		// The body glances around and down before building, as a player does.
		for (let k = 0; k < 4; k++) await s.act('look_at', { x: p.x + 3 * Math.cos(k * Math.PI / 2), y: p.y - 1.5, z: p.z + 3 * Math.sin(k * Math.PI / 2) }).catch(() => null);
		const opening = openings[i % 4];
		const r = await s.act('build_shelter', { x: feet.x, y: feet.y, z: feet.z, opening, itemId: 'minecraft:cobblestone', roof: true, timeoutMs: 60000 });
		o = await s.observe();
		const row = { point: i, spread: String(spread).slice(0, 160), feet, opening, state: r.state, reason: r.reasonCode, message: String(r.message ?? ''), health: o.health };
		const dest = String(r.message ?? '').match(/destination=(-?\d+),(-?\d+),(-?\d+)/);
		if (r.state !== 'SUCCEEDED' && dest) {
			// Operator-only column dump at the failing cell (never shown to the body): '#' solid-ish, '.' replaceable.
			const [x, y, z] = dest.slice(1).map(Number), cell = async (a, b, c) => /passed/i.test(await s.command(`execute if block ${a} ${b} ${c} #minecraft:replaceable`)) ? '.' : '#';
			const col = []; for (let dy = 0; dy >= -4; dy--) col.push(await cell(x, y + dy, z));
			const sides = []; for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) sides.push(await cell(x + dx, y, z + dz) + await cell(x + dx, y - 1, z + dz));
			row.operatorColumn = { at: [x, y, z], down0to4: col.join(''), sidesNESW_y0y1below: sides.join(' ') };
		}
		result.points.push(row); await save();
		console.log(i, JSON.stringify(feet), opening, r.state, r.reasonCode, String(r.message ?? '').slice(0, 200));
	}
} catch (error) { result.error = String(error.stack ?? error); }
finally { await s?.stop().catch(() => {}); }
result.built = result.points.filter(p => p.state === 'SUCCEEDED').length; result.attempted = result.points.length;
await save(); console.log(`built ${result.built}/${result.attempted}`); process.exitCode = result.error ? 1 : 0;
