import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import * as benchmark from '../scripts/live-body-benchmark.mjs';

// Exercise the actual reset entry point without launching a server. The block model
// starts with blast holes in both the spawn floor and the hostile/escape area.
async function fixture({ geometryResponse = 'Bench has the following entity data: -60.0d' } = {}) {
	const source = await readFile(new URL('../scripts/live-body-benchmark.mjs', import.meta.url), 'utf8');
	const resetSource = source.match(/const reset = async \(\) => \{([\s\S]*?)\n\t\t\};/)[1];
	const blocks = new Map(), commands = [];
	const key = (x, y, z) => `${x},${y},${z}`;
	const command = async (text) => {
		commands.push(text);
		const parts = text.split(' ');
		if (parts[0] === 'fill') {
			const [x1, y1, z1, x2, y2, z2] = parts.slice(1, 7).map(Number);
			assert.ok((x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1) <= 32768);
			for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) blocks.set(key(x, y, z), parts[7]);
		}
		if (text.startsWith('execute positioned')) {
			return geometryResponse;
		}
		return '';
	};
	const reset = vm.runInNewContext(`${source.match(/^const number = .*$/m)[0]}\n(async () => {${resetSource}\n})`, {
		...benchmark, command, alive: async () => true, sleep: async () => {}, X: 100.5, Y: -60, Z: 100.5, AGENT: 'Bench',
	});
	return { reset, blocks, commands, key };
}

test('each arm reset repairs blast holes across the floor and clears headroom before teleport', async () => {
	const f = await fixture();
	for (const arm of ['original4', 'current10']) {
		// Original generated world, then representative blast damage at the body,
		// hostile spawn and escape area. Bedrock is never destroyed by a creeper.
		for (let x = 52; x <= 148; x++) for (let z = 52; z <= 148; z++) {
			for (const [y, block] of [[-64, 'bedrock'], [-63, 'dirt'], [-62, 'dirt'], [-61, 'grass_block'], [-60, 'air'], [-59, 'air']]) {
				f.blocks.set(f.key(x, y, z), `minecraft:${block}`);
			}
		}
		for (const x of [100, 103, 110, 130]) for (const y of [-63, -62, -61]) f.blocks.set(f.key(x, y, 100), 'minecraft:air');
		await f.reset();
		for (let x = 52; x <= 148; x++) for (let z = 52; z <= 148; z++) {
			for (const [y, block] of [[-64, 'bedrock'], [-63, 'dirt'], [-62, 'dirt'], [-61, 'grass_block'], [-60, 'air'], [-59, 'air']]) {
				assert.equal(f.blocks.get(f.key(x, y, z)), `minecraft:${block}`, `${arm}: ${x},${y},${z}`);
			}
		}
	}
	assert.ok(f.commands.findIndex((c) => c.includes('minecraft:grass_block')) < f.commands.findIndex((c) => c.startsWith('tp Bench')));
	const validation = f.commands.find((c) => c.startsWith('execute positioned'));
	assert.match(validation, /100\.5 -60 100\.5.*distance=\.\.0\.01/);
	assert.match(validation, /if block ~ ~-1 ~ minecraft:grass_block/);
	assert.match(validation, /if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air/);
});

test('failed supported-position check aborts reset instead of accepting a measurement', async () => {
	for (const geometryResponse of ['Test failed', 'Bench has the following entity data: -61.0d']) {
		const f = await fixture({ geometryResponse });
		await assert.rejects(f.reset(), /supported.*position/i);
	}
});


test('historical paired summaries carry terrain invalidation without claiming new measurements', async () => {
	const report = JSON.parse(await readFile(new URL('../../reports/live-body-benchmark-26.3-2026-11-01.json', import.meta.url)));
	assert.equal(report.validity.status, 'invalid-for-arm-comparisons');
	assert.equal(report.validity.terrainReset.freshTrialsRun, false);
	assert.equal(report.validity.terrainReset.historicalCraterDimensionsMeasured, false);
	assert.deepEqual(report.validity.affectedSummaries.sort(), Object.keys(report.summary).sort());
	for (const summary of Object.values(report.summary)) {
		assert.equal(summary.validity, 'invalid');
		assert.match(summary.reason, /Terrain was not reset/);
	}
});
