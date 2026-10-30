// Measures exploreFrontier result bytes on the recorded 2026-10-09 Nether run (node src/benchmark/frontier-bytes.mjs [moduleDir]).
// The replay walks the run's receipt end positions in sprint-sized steps and shows each remembered block as a landmark
// at the sample nearest its last sighting tick. A moduleDir (for example a copy of main's src) measures other code on the
// same replay.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const fixture = JSON.parse(await readFile(new URL('./fixtures/nether-observed-memory.json', import.meta.url), 'utf8'));
const worldId = 'nether-fixture-world', agentId = 'nether-fixture-agent';
// Receipt end positions (tick, x, y, z) from notebook-actions-37c78..., then the final memory position.
const ROUTE = [[2863, 349.4, 84, -236.4], [3537, 382, 98, -219.1], [4458, 393.5, 84, -220.6], [4818, 382.6, 85, -207.5], [4933, 373.7, 86, -196.8],
	[5251, 367.4, 88, -186.2], [5363, 367.9, 87, -174.5], [5729, 359.5, 87, -175.7], [6417, 369.7, 87, -178]];

export async function replayNetherFixture(ExplorationOccupancy, ObservedMemoryStore) {
	const occupancy = new ExplorationOccupancy({ memoryStore: new ObservedMemoryStore() });
	const samples = [];
	for (let index = 1; index < ROUTE.length; index += 1) {
		const [fromTick, fx, fy, fz] = ROUTE[index - 1], [toTick, tx, ty, tz] = ROUTE[index];
		const steps = Math.max(1, Math.ceil(Math.hypot(tx - fx, tz - fz) / 2.8));
		for (let step = 0; step < steps; step += 1) {
			const t = step / steps;
			samples.push({ tick: Math.round(fromTick + (toTick - fromTick) * t), x: fx + (tx - fx) * t, y: Math.round(fy + (ty - fy) * t), z: fz + (tz - fz) * t, landmarks: [] });
		}
	}
	const [lastTick, lx, ly, lz] = ROUTE.at(-1);
	samples.push({ tick: lastTick, x: lx, y: ly, z: lz, landmarks: [] });
	for (const [x, y, z, id, lastSeenTick] of fixture.blocks) {
		const sample = samples.reduce((best, entry) => Math.abs(entry.tick - lastSeenTick) < Math.abs(best.tick - lastSeenTick) ? entry : best);
		if (sample.landmarks.length < 32) sample.landmarks.push({ blockId: `minecraft:${id}`, x, y, z });
	}
	for (const sample of samples) {
		occupancy.ingest(agentId, { position: { x: sample.x, y: sample.y, z: sample.z }, player: { yaw: 0, onGround: true }, world: { worldId, dimension: fixture.dimension, gameTime: sample.tick }, landmarks: sample.landmarks, blocks: [] }, { snapshot: false });
	}
	return { occupancy, agentId, samples: samples.length, observation: { position: { x: lx, y: ly, z: lz }, player: { yaw: 0, onGround: true }, world: { worldId, dimension: fixture.dimension, gameTime: lastTick } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const directory = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url));
	const { ExplorationOccupancy } = await import(pathToFileURL(join(directory, 'explore-frontier.mjs')));
	const { ObservedMemoryStore } = await import(pathToFileURL(join(directory, 'observed-memory-store.mjs')));
	const { occupancy, observation, samples } = await replayNetherFixture(ExplorationOccupancy, ObservedMemoryStore);
	const started = process.hrtime.bigint();
	const runs = 200;
	let result;
	for (let run = 0; run < runs; run += 1) result = occupancy.candidates(agentId, observation);
	const microseconds = Number(process.hrtime.bigint() - started) / 1000 / runs;
	console.log(JSON.stringify({ module: directory, samples, bytes: Buffer.byteLength(JSON.stringify(result)), candidates: result.candidates.length,
		total: result.totalCandidates ?? result.total, nearest: Math.min(...result.candidates.map((entry) => entry.distance)), farthest: Math.max(...result.candidates.map((entry) => entry.distance)),
		candidatesMicroseconds: Math.round(microseconds) }));
}
