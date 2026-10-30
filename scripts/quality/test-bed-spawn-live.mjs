#!/usr/bin/env node
// Provider-free check that a save point's bed spawn holds: node scripts/quality/test-bed-spawn-live.mjs CHECKPOINT.json OUT_DIR [JAR]
// Boots a server on the checkpoint's seed, summons an agent body, prepares it with the production applyQualitySetup and
// activateQualitySetup, kills it with /kill, respawns it with the agent's own respawn action, and reports where vanilla
// put it (the bed, or the world spawn). No model call is made.
// Launch under slot.sh live (SLOT_PORT_BASE) with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { boot } from './watch-replay.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [checkpointFile, outArg, jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!checkpointFile || !outArg || !template || !port || !process.env.JAVA_HOME) throw new Error('Usage: CHECKPOINT.json OUT_DIR [JAR] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
const bed = checkpoint.bedSpawn?.position;
if (!bed) throw new Error(`${checkpointFile} has no bedSpawn`);
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const AGENT = 'Probe';
const result = { checkpoint: path.basename(checkpointFile), bed };
const s = await boot(out, { jar: path.resolve(jarArg ?? path.join(root, 'build/libs/arena-agents-0.2.0.jar')), template, port, world: null, seed: checkpoint.seed });
const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number) ?? null;
try {
	let e = null;
	// A summon right after boot can go unanswered while the server settles; a player would just try again.
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
		result.summon = await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error(`agent never registered: ${result.summon}`); s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const command = async text => ({ text: await s.command(text) });
	const receipt = await applyQualitySetup(checkpoint.setup, command, AGENT);
	await activateQualitySetup(receipt, command, { stage: 'goal-start' });
	await activateQualitySetup(receipt, command, { stage: 'first-decision' });
	await s.command('tick unfreeze').catch(() => {});
	result.start = { pos: await pos(), dimension: await s.command(`data get entity ${AGENT} Dimension`) };
	result.bedBlock = await s.command(`execute in minecraft:overworld positioned ${bed.join(' ')} run forceload add ~ ~`)
		.then(() => sleep(1500)).then(() => s.command(`execute in minecraft:overworld if block ${bed.join(' ')} #minecraft:beds run time query gametime`));
	result.respawnBefore = await s.command(`data get entity ${AGENT} respawn`);
	const dead = s.inbox.wait('goal_control', g => g.payload.operation === 'dead', 20000).catch(() => null);
	// A body just placed in another dimension is invulnerable for 60 ticks (vanilla), which turned /kill into nothing.
	result.gameMode = await s.command(`data get entity ${AGENT} playerGameType`);
	await sleep(4000);
	result.kill = await s.command(`kill ${AGENT}`);
	await sleep(500);
	result.healthAfterKill = await s.command(`data get entity ${AGENT} Health`);
	if (/: [1-9][\d.]*f/.test(result.healthAfterKill)) result.damage = await s.command(`damage ${AGENT} 1000 minecraft:out_of_world`);
	result.deadSeen = (await dead) !== null;
	await sleep(1500);
	result.respawnAction = await s.act('respawn', {}).then(r => ({ state: r.state, reasonCode: r.reasonCode ?? null, message: r.message ?? null })).catch(error => ({ error: error.message }));
	let at = null, dimension = null;
	for (let i = 0; i < 50; i++) {
		await sleep(200);
		dimension = await s.command(`data get entity ${AGENT} Dimension`);
		at = await pos();
		if (/overworld/.test(dimension) && at) break;
	}
	result.respawned = { pos: at, dimension };
	// The head is one block east of the foot; vanilla stands the body up beside the bed.
	result.distanceToBed = at ? Math.round(Math.hypot(at[0] - (bed[0] + 1), at[2] - (bed[2] + 0.5)) * 10) / 10 : null;
	result.atBed = /overworld/.test(dimension) && result.distanceToBed !== null && result.distanceToBed <= 3;
} catch (error) {
	result.error = String(error?.stack ?? error);
} finally {
	await s.stop().catch(() => {});
}
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(result.atBed ? 0 : 1);
