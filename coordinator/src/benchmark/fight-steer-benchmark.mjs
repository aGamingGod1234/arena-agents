// Counts how often damage steers cut a running fight short, before and after fightSteerDecision.
// Provider-free: replays scripted fights through the real DangerSteerCoalescer and the real decision functions,
// mirroring the coordinator's bookkeeping (the band reference moves only when a fight is really cut).
// Run: node src/benchmark/fight-steer-benchmark.mjs [--json]

import { DangerSteerCoalescer } from '../danger-steer-coalescer.mjs';
import { fightSteerDecision, nativeSteerInterruption } from '../dynamic-main.mjs';

const ZOMBIE = 'minecraft:zombie';

function hit({ health, attacker = ZOMBIE, attackerUuid = 'z1', threats = [{ type: ZOMBIE, uuid: 'z1', signals: ['targeting', 'attacked'] }], seq }) {
	return {
		trigger: 'damage', eventSequence: seq,
		nativeEvent: { event: 'observation', trigger: 'damage', observation: { player: { health, lastAttacker: { type: attacker, uuid: attackerUuid }, threats } } },
	};
}

export const SCENARIOS = Object.freeze([
	{ name: 'one zombie, 20 s, 0.5 HP per hit', durationMs: 20_000, hitEveryMs: 1_000, startHealth: 20, perHit: 0.5 },
	{ name: 'one zombie, 20 s, 1 HP per hit', durationMs: 20_000, hitEveryMs: 1_000, startHealth: 20, perHit: 1 },
	{ name: 'three zombies, 30 s, armoured (0.3 HP per hit)', durationMs: 30_000, hitEveryMs: 400, startHealth: 20, perHit: 0.3,
		threats: ['z1', 'z2', 'z3'].map(uuid => ({ type: ZOMBIE, uuid, signals: ['targeting', 'attacked'] })), attackerUuids: ['z1', 'z2', 'z3'],
		running: { actionType: 'fight_target', arguments: { targetId: 'z1', continueWithAttackers: true } } },
	// Control: a skeleton the fight is not about must still interrupt a zombie fight.
	{ name: 'control: zombie fight, skeleton shooting in', durationMs: 20_000, hitEveryMs: 1_000, startHealth: 20, perHit: 0.5, attacker: 'minecraft:skeleton', attackerUuids: ['s1'] },
]);

export function runScenario(scenario, decide) {
	const coalescer = new DangerSteerCoalescer();
	const running = { actionId: 'fight-1', actionType: 'fight_target', arguments: { targetId: 'z1' }, startHealth: scenario.startHealth, ...scenario.running };
	const threats = scenario.threats;
	const attackerUuids = scenario.attackerUuids ?? ['z1'];
	let state = null, delivered = 0, interruptions = 0, health = scenario.startHealth, seq = 0, timerDue = null;
	const deliver = (request) => {
		delivered += 1;
		const decision = decide(request, running, state);
		if (decision.interruption) { interruptions += 1; if (decision.cut) state = decision.cut; }
	};
	coalescer.noteDelivered(hit({ health, threats, seq: seq++ }), 0);
	for (let t = scenario.hitEveryMs, index = 0; t <= scenario.durationMs; t += scenario.hitEveryMs, index += 1) {
		if (timerDue !== null && timerDue <= t) { const flushed = coalescer.flush(timerDue); if (flushed) deliver(flushed); timerDue = null; }
		health = Math.max(1, health - scenario.perHit);
		const offered = coalescer.offer(hit({ health, attacker: scenario.attacker ?? ZOMBIE, attackerUuid: attackerUuids[index % attackerUuids.length], threats, seq: seq++ }), t);
		if (offered.action === 'deliver') { deliver(offered.request); timerDue = null; } else if (timerDue === null) timerDue = t + offered.dueInMs;
	}
	if (timerDue !== null) { const flushed = coalescer.flush(timerDue); if (flushed) deliver(flushed); }
	return { hits: Math.floor(scenario.durationMs / scenario.hitEveryMs), delivered, interruptions, finalHealth: health };
}

const before = (request) => ({ interruption: nativeSteerInterruption(request), cut: null });
const after = (request, running, state) => fightSteerDecision(request, running, state);

export function runFightSteerBenchmark() {
	return SCENARIOS.map(scenario => ({ scenario: scenario.name, before: runScenario(scenario, before), after: runScenario(scenario, after) }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const rows = runFightSteerBenchmark();
	if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
	else for (const row of rows) console.log(`${row.scenario.padEnd(48)} steers ${row.before.delivered}  fight cut short: before ${row.before.interruptions}, after ${row.after.interruptions}`);
}
