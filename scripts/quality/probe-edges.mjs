#!/usr/bin/env node
// Model-free probe of the side glance (player.edges): node scripts/quality/probe-edges.mjs CHECKPOINT.json OUT_DIR --jar JAR
// Boots the checkpoint's seed, applies its setup, then for each probe spot teleports the body there, looks around
// (four sides and down, as a player glances before stepping) and records player.edges, brink and footing.
// Spots come from PROBE_SPOTS (JSON [[x,y,z], ...]). Launch under fix-slot.sh with ARENA_HEADLESS_SERVER_TEMPLATE and JAVA_HOME.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { applyQualitySetup, activateQualitySetup } from '../../coordinator/src/benchmark/quality-scenarios.mjs';
import { boot } from './watch-replay.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
const [checkpointFile, outArg] = argv.filter((v, i) => !v.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const jar = path.resolve(flag('--jar'));
const spots = JSON.parse(process.env.PROBE_SPOTS ?? '[]');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE, port = Number(process.env.SLOT_PORT_BASE);
if (!checkpointFile || !outArg || !template || !port || !spots.length) throw new Error('usage: CHECKPOINT OUT --jar JAR with PROBE_SPOTS, under fix-slot.sh');
const AGENT = 'Probe';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
let current = null;
process.on('exit', () => { try { current?.child?.kill('SIGTERM'); } catch { /* gone */ } });

async function act(s, type, args, waitMs = 20_000) {
	const id = `probe-${++s.ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: s.record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: s.record.provider, model: s.record.model, reasoningEffort: s.record.reasoningEffort, serviceTier: s.record.serviceTier, traceId: id, programId: 'probe-edges', programVersion: 1, sourceStepId: id, eventSequence: s.observation?.eventSequence ?? 0 } };
	const next = s.inbox.wait('action_result', e => e.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(e.payload.state), waitMs);
	await s.bridge.send('action_command', s.record.agentId, payload);
	const result = (await next).payload;
	await s.bridge.send('action_result_ack', s.record.agentId, { actionId: id, goalRevision: s.record.goalRevision });
	return result;
}
async function observe(s) {
	const sentAt = Date.now();
	const next = s.inbox.wait('observation', e => e.agentId === s.record.agentId && e.payload.ready && (e.payload.observedAtEpochMs ?? 0) >= sentAt - 50, 15_000);
	await s.bridge.send('request_observation', s.record.agentId, { goalRevision: s.record.goalRevision });
	const observation = (await next).payload; s.observation = observation; return observation;
}

const s = await boot(out, { jar, template, port, world: null, seed: checkpoint.seed, goalTicks: 20 * 60 * 60, bridgeReadyMs: 180_000 });
current = s; s.ordinal = 0;
const rows = [];
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
	const started = s.inbox.wait('goal_control', g => g.payload.operation === 'start');
	await s.command(`codex start ${AGENT} Survive for 1200 seconds.`);
	s.record.goalRevision = (await started).payload.goalRevision;
	await s.bridge.send('agent_ready', s.record.agentId, { goalRevision: s.record.goalRevision, reconciled: false });
	await s.command('gamerule minecraft:spawn_mobs false').catch(() => {});
	const command = async text => ({ text: String(await s.command(text)) });
	const receipt = await applyQualitySetup(checkpoint.setup, command, AGENT);
	await activateQualitySetup(receipt, command, { stage: 'goal-start' });
	await activateQualitySetup(receipt, command, { stage: 'first-decision' });
	await s.command('tick unfreeze').catch(() => {});
	await s.command(`effect give ${AGENT} minecraft:fire_resistance 99999 0 true`);
	await s.command(`effect give ${AGENT} minecraft:resistance 99999 4 true`);
	await sleep(1500);
	for (const [x, y, z] of spots) {
		await s.command(`execute in ${checkpoint.setup.dimension} run tp ${AGENT} ${x} ${y} ${z}`);
		await sleep(1500);
		for (const [dx, dy, dz] of [[6, -3, 0], [0, -3, 6], [-6, -3, 0], [0, -3, -6], [0.2, -6, 0.2]]) {
			await act(s, 'look_at', { x: x + dx, y: y + dy, z: z + dz }).catch(() => null);
			await sleep(300);
		}
		const o = await observe(s);
		const p = o.player ?? {};
		rows.push({ spot: [x, y, z], at: o.position, onGround: p.onGround, edges: p.edges ?? null, brink: p.brink ?? null, footing: p.footing ?? null });
		console.log(JSON.stringify(rows.at(-1)));
	}
} finally {
	await writeFile(path.join(out, 'probe.json'), JSON.stringify({ jar, checkpoint: checkpointFile, rows }, null, 1));
	await s.stop().catch(() => {});
	await rm(path.join(out, 'server'), { recursive: true, force: true }).catch(() => {});
}
