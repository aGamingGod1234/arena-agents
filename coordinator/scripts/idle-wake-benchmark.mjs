// Counts provider turns an idle native agent receives from heartbeats that change only noise.
// Provider-free: drives the real coordinator through the dynamic-main test fixture with a fake planner. Each
// scenario sends 20 non-urgent heartbeats after the first wake; every extra planner request is a paid model turn.
// Run: node scripts/idle-wake-benchmark.mjs [--json]

const fixtures = await import('../test/fixtures/dynamic-main-fixture.mjs');
const { AgentRegistry } = await import('../src/agent-registry.mjs');
const { FakePlanner, start, factToWireObservation, eventually } = fixtures;

const HEARTBEATS = 20;
const base = () => ({ player: { x: 0, y: 64, z: 0, health: 20 }, items: [], blocks: [], inventory: { items: [], tagCounts: {} } });
const entity = (type, x, extra = {}) => ({ uuid: `${type}-1`, type, name: type, distance: Math.abs(x), position: { x, y: 64, z: 0 }, velocity: { x: 0.05, y: 0, z: 0 }, ...extra });

export const SCENARIOS = Object.freeze([
	// Noise: none of these changes what a player would do next.
	{ name: 'cow 20 m away drifting 0.1 block per beat', noise: true, mutate: (w, s) => { w.entities = [entity('minecraft:cow', 20 + s * 0.1)]; } },
	{ name: 'zombie 40 m away wandering, not targeting', noise: true, mutate: (w, s) => { w.entities = [entity('minecraft:zombie', 40 + s * 0.1, { hostile: true })]; } },
	{ name: 'view yaw jitter', noise: true, mutate: (w, s) => { w.view = { yaw: s * 2, pitch: 0 }; } },
	{ name: 'saturation ticking down', noise: true, mutate: (w, s) => { w.player.saturation = 5 - s * 0.1; } },
	{ name: 'player position drift 0.01 block per beat', noise: true, mutate: (w, s) => { w.position = { x: s * 0.01, y: 64, z: 0 }; } },
	{ name: 'dayTime advancing only', noise: true, mutate: (w, s) => { w.world = { ...w.world, gameTime: s * 10, dayTime: s * 10 }; } },
	// Controls: real changes must still wake the idle model.
	{ name: 'control: player walks 1 block per beat', noise: false, mutate: (w, s) => { w.position = { x: s, y: 64, z: 0 }; } },
	{ name: 'control: hunger drops 1 per beat', noise: false, mutate: (w, s) => { w.player.foodLevel = 20 - s; w.player.hunger = 20 - s; } },
]);

async function scenario({ mutate }) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	planner.requestNativeTurn = async (request) => { planner.requests.push(request); return { status: 'completed', toolCalls: 1 }; };
	const run = await start({ registry, planner, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Gather 10 oak logs.' } });
		run.bridge.emit('observation', { agentId: 'agent-a', payload: factToWireObservation(base(), 1, 1, false, 1) });
		await eventually(() => planner.requests.length === 1);
		for (let sequence = 2; sequence <= HEARTBEATS + 1; sequence += 1) {
			const wire = factToWireObservation(base(), 1, sequence, false, sequence * 500);
			mutate(wire, sequence);
			run.bridge.emit('observation', { agentId: 'agent-a', payload: wire });
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		await new Promise(resolve => setTimeout(resolve, 300));
		return planner.requests.length - 1;
	} finally {
		await run.coordinator.stop();
	}
}

export async function runIdleWakeBenchmark() {
	const rows = [];
	for (const entry of SCENARIOS) rows.push({ scenario: entry.name, noise: entry.noise, heartbeats: HEARTBEATS, extraTurns: await scenario(entry) });
	return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const rows = await runIdleWakeBenchmark();
	if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
	else {
		for (const row of rows) console.log(`${row.scenario.padEnd(46)} ${row.heartbeats} heartbeats -> ${row.extraTurns} extra model turns`);
		const noise = rows.filter(row => row.noise);
		console.log(`noise total: ${noise.reduce((sum, row) => sum + row.extraTurns, 0)} of ${noise.length * HEARTBEATS} heartbeats woke the model`);
	}
}
