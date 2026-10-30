import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
test('the real metrics CLI excludes setup movement and deaths after the playing window', async () => {
 const dir = await mkdtemp(path.join(tmpdir(), 'd38-metrics-'));
 try {
  const obs = (time, x, dead = false, bricks = false) => ({ type: 'observation', payload: {
   observedAtEpochMs: time, position: { x, y: 64, z: 0 }, world: { dimension: 'minecraft:the_nether', gameTime: time / 50 },
   player: { health: dead ? 0 : 20 }, status: dead ? 'PLAYER_DEAD' : 'READY',
   landmarks: bricks ? [{ blockId: 'minecraft:nether_bricks', x: 40, y: 64, z: 0 }] : [] } });
  const file = path.join(dir, 'quality-protocol.jsonl'), out = path.join(dir, 'metrics.json');
  await writeFile(file, [obs(500, 1000), obs(1000, 0), obs(6000, 5), obs(11000, 10, false, true), obs(12000, 11), obs(13000, 11, true)].map(r => JSON.stringify(r)).join('\n'));
  await exec(process.execPath, [fileURLToPath(new URL('../../scripts/quality/nether-travel-metrics.mjs', import.meta.url)), file, out, '1000', '11000']);
  const result = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(result.deaths, 0); assert.equal(result.pathBlocks, 10); assert.equal(result.netherMinutes, 1 / 6);
  assert.equal(result.firstFortress.wallFromGameStartMinutes, 1 / 6);
  assert.deepEqual(result.playingWindow, { startedAt: 1000, endedAt: 11000 });
  const withoutPosition = { type: 'observation', payload: { observedAtEpochMs: 10000, status: 'PLAYER_DEAD', player: { health: 0 } } };
  await writeFile(file, [obs(1000, 0), obs(6000, 5), withoutPosition, obs(11000, 0)].map(r => JSON.stringify(r)).join('\n'));
  await exec(process.execPath, [fileURLToPath(new URL('../../scripts/quality/nether-travel-metrics.mjs', import.meta.url)), file, out, '1000', '11000']);
  const deadResult = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(deadResult.deaths, 1, 'dead-player observations may omit position');
  assert.equal(deadResult.pathBlocks, 5);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
