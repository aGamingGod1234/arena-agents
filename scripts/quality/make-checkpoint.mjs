#!/usr/bin/env node
// Save point from a finished game: node scripts/quality/make-checkpoint.mjs --run ARTIFACT_DIR --at MILESTONE --out FILE.json
// ARTIFACT_DIR holds quality-samples.jsonl and manifest.json (the headless run directory, or a long-run output with run/LONG-r1.json).
// A bed spawn: add --bed-spawn X,Y,Z (the bed's foot cell in the Overworld; its head goes one block east) and optionally
// --bed-item true; --from CHECKPOINT.json adds it to an existing save point instead of building one from a run (a bed the
// save point already had is replaced).
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { buildCheckpoint, NAMED_MILESTONES, withBedSpawn } from '../../coordinator/src/benchmark/checkpoint.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[i + 1]]]), []));
const bed = args['bed-spawn'] === undefined ? null : args['bed-spawn'].split(',').map(Number);
if (bed && (bed.length !== 3 || !bed.every(Number.isInteger))) { console.error('--bed-spawn needs X,Y,Z integers'); process.exit(2); }
if (args.from && args.out && bed) {
	const checkpoint = withBedSpawn(JSON.parse(await readFile(path.resolve(args.from), 'utf8')), bed, { item: args['bed-item'] === 'true' });
	await writeFile(path.resolve(args.out), JSON.stringify(checkpoint, null, '\t') + '\n');
	console.log(`${args.from}: bed spawn at ${bed.join(' ')} -> ${args.out}`);
	process.exit(0);
}
if (!args.run || !args.at || !args.out) {
	console.error(`Usage: --run ARTIFACT_DIR --at MILESTONE --out FILE.json\nMilestones: ${Object.keys(NAMED_MILESTONES).join(', ')}, item:<id>>=N, dim:<name>, adv:<path>, minute:<M>, at:<epochMs>`);
	process.exit(2);
}
let dir = path.resolve(args.run);
const report = path.join(dir, 'run', 'LONG-r1.json');
if (!existsSync(path.join(dir, 'quality-samples.jsonl')) && existsSync(report)) dir = JSON.parse(await readFile(report, 'utf8')).artifacts;
const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
const samples = [];
for await (const line of readline.createInterface({ input: createReadStream(path.join(dir, 'quality-samples.jsonl')) })) if (line.trim()) samples.push(JSON.parse(line));
const checkpoint = buildCheckpoint(samples, { milestone: args.at, seed: manifest.world.seed, source: dir });
if (bed) withBedSpawn(checkpoint, bed, { item: args['bed-item'] === 'true' });
await writeFile(path.resolve(args.out), JSON.stringify(checkpoint, null, '\t') + '\n');
console.log(`${args.at}: minute ${checkpoint.minute}, ${checkpoint.setup.dimension} ${checkpoint.setup.position.map(Math.round).join(' ')}, ${checkpoint.setup.inventory.length} stacks, ${Object.keys(checkpoint.setup.armour).length} armour, portals ${checkpoint.setup.commands.length ? 'rebuilt' : 'none'}, deaths before ${checkpoint.deathsBefore}`);
