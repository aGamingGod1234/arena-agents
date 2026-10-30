#!/usr/bin/env node
// Provider-free check of the End portal-room save point: node scripts/quality/test-portal-room-live.mjs CHECKPOINT.json OUT_DIR [JAR]
// Boots the checkpoint's seed, prepares the body with the production applyQualitySetup and activateQualitySetup, then:
// 1. the start: in the stronghold portal room, the pool lit, the respawn at the bed beside it;
// 2. the agent's own move_to onto the pool centre takes it into the End (the walk-in a player makes);
// 3. a death in the End (/kill after the arrival's invulnerability) and the agent's own respawn: at the portal-room bed;
// 4. every live sample went through the production RecoveryProgressStore, and the respawn wake's lead (respawnLead)
//    names the drops in the End and the way back through the portal.
// Operator commands only prepare the fixture and the death. No model call is made.
// Launch under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME set.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { RecoveryProgressStore } from '../../coordinator/src/recovery-progress-wrap.mjs';
import { respawnLead } from '../../coordinator/src/respawn-recovery.mjs';
import { boot } from './watch-replay.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [checkpointFile, outArg, jarArg] = process.argv.slice(2);
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!checkpointFile || !outArg || !template || !port || !process.env.JAVA_HOME) throw new Error('Usage: CHECKPOINT.json OUT_DIR [JAR] under slot.sh live with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME');
const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
const bed = checkpoint.bedSpawn.position;
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const AGENT = 'Room';
const result = { checkpoint: path.basename(checkpointFile), bed };
const s = await boot(out, { jar: path.resolve(jarArg ?? path.join(root, 'build/libs/arena-agents-0.2.0.jar')), template, port, world: null, seed: checkpoint.seed });
const dimension = async () => String(await s.command(`data get entity ${AGENT} Dimension`)).match(/"([^"]+)"/)?.[1] ?? null;
const pos = async () => String(await s.command(`data get entity ${AGENT} Pos`)).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map((v) => Math.round(Number(v) * 10) / 10) ?? null;
const brief = (r) => ({ state: r.state, reasonCode: r.reasonCode ?? null, message: r.message ?? null });
const store = new RecoveryProgressStore();
let sampler = null;
try {
	let e = null;
	for (let attempt = 0; attempt < 3 && !e; attempt++) {
		const registered = s.inbox.wait('agent_registered', () => true, 45000).catch(() => null);
		await s.command(`execute positioned 0.5 200 0.5 run codex summon gpt-6.1-sol low ${AGENT}`);
		e = await registered;
	}
	if (!e) throw new Error('agent never registered');
	s.record = { ...(e.payload.record ?? e.payload), agentId: e.agentId };
	// Every live sample feeds the production recovery store, as the coordinator's tool runtime does.
	s.bridge.on('observation', (o) => { if (o.agentId === s.record.agentId) store.remember(s.record.agentId, s.record.goalRevision, o.payload); });
	// The death facts arrive with the 'dead' lifecycle control; the coordinator hands them to the same store
	// (DynamicCoordinator#installDeadStatePlan -> updateObservation({ death })).
	s.bridge.on('goal_control', (g) => { if (g.agentId === s.record.agentId && g.payload?.operation === 'dead' && g.payload.death) store.remember(s.record.agentId, s.record.goalRevision, { death: g.payload.death }); });
	s.bridge.on('goal_control', (g) => { if (g.agentId === s.record.agentId && Number.isSafeInteger(g.payload?.goalRevision) && g.payload.goalRevision !== s.record.goalRevision) {
		s.record.goalRevision = g.payload.goalRevision;
		s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false }).catch(() => {});
	} });
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const started = s.inbox.wait('goal_control', (g) => g.payload.operation === 'start');
	await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	const command = async (text) => ({ text: await s.command(text) });
	const receipt = await applyQualitySetup(checkpoint.setup, command, AGENT);
	await activateQualitySetup(receipt, command, { stage: 'goal-start' });
	await activateQualitySetup(receipt, command, { stage: 'first-decision' });
	await s.command('tick unfreeze').catch(() => {});
	await sleep(1500);
	// The coordinator samples the body all the time; so does this check, alive or dead, so the store sees the last
	// Overworld sample by the portal, the death screen and the respawn.
	sampler = setInterval(() => { s.bridge.send('request_observation', s.record.agentId, { goalRevision: s.record.goalRevision }).catch(() => {}); }, 300);

	// 1. The start.
	const start = await s.observe();
	result.start = { dimension: await dimension(), pos: await pos(), respawn: await s.command(`data get entity ${AGENT} respawn`) };
	result.portalSeen = (start.blocks ?? []).filter((b) => b.blockId === 'minecraft:end_portal').map((b) => [b.x, b.y, b.z]);
	result.bedSeen = (start.blocks ?? []).some((b) => /_bed$/.test(b.blockId));
	result.kit = (start.inventory?.items ?? []).filter((i) => i.count > 0).map((i) => i.itemId.replace('minecraft:', ''));

	// 2. Walk in with the agent's own move_to.
	result.walkIn = brief(await s.act('move_to', { x: 332.5, y: -26, z: 2553.5, tolerance: 0.6, sprint: false }));
	let entered = false;
	for (let i = 0; i < 40 && !entered; i++) { entered = (await dimension()) === 'minecraft:the_end'; if (!entered) await sleep(250); }
	result.enteredEnd = entered;
	await sleep(1500);
	await s.observe();
	result.arrival = await pos();

	// 3. A death in the End, and the agent's own respawn.
	const dead = s.inbox.wait('goal_control', (g) => g.payload.operation === 'dead', 20000).catch(() => null);
	await sleep(3500); // a body just arrived in another dimension is invulnerable for 60 ticks
	await s.command(`kill ${AGENT}`);
	result.death = (await dead)?.payload?.death ?? null;
	await sleep(1500);
	result.respawnAction = brief(await s.act('respawn', {}));
	let back = false;
	for (let i = 0; i < 40 && !back; i++) { back = (await dimension()) === 'minecraft:overworld'; if (!back) await sleep(250); }
	await sleep(1500);
	const after = await s.observe();
	result.respawnPos = await pos();
	result.respawnAtBed = back && result.respawnPos !== null && Math.hypot(result.respawnPos[0] - (bed[0] + 1), result.respawnPos[2] - (bed[2] + 0.5)) <= 3;

	// 4. The respawn wake's lead from the production store and sample.
	const recovery = store.snapshot(s.record.agentId, after);
	result.lastDeathPortal = recovery?.lastDeath?.portal ?? null;
	result.lead = respawnLead(recovery, after);
	// From the floor the frame hides the pool (portalSeen is empty there); the walk-in finds it from the stairs.
	result.ok = result.start.dimension === 'minecraft:overworld' && result.walkIn.state === 'SUCCEEDED' && result.enteredEnd
		&& result.respawnAtBed && typeof result.lead === 'string' && /Your drops wait where you died in the End/.test(result.lead)
		&& /Way back: (End portal in view|you entered through the End portal)/.test(result.lead);
} catch (error) {
	result.error = String(error?.stack ?? error);
} finally {
	clearInterval(sampler);
	await s.stop().catch(() => {});
}
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
