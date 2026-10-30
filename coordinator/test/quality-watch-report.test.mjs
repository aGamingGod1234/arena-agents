import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWatchReport, formatWatchReport, rankPatches, summarizeWatch } from '../../scripts/quality/watch-report.mjs';
import { collectWatchFiles, findWatchDirs } from '../../scripts/quality/watch-files.mjs';
import { milestoneTest } from '../src/benchmark/checkpoint.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/watch/', import.meta.url));
const episode = (diagnosis, kind, outcome, extra = {}) => ({ v: 1, type: 'episode', id: `${diagnosis}-${kind}-${outcome}-${Math.random()}`, agentId: 'a', kind, outcome, diagnosis, damage: 0, ...extra });

test('system patches group by diagnosis and kind and rank by deaths, then damage, then close calls', () => {
	const patches = rankPatches([
		episode('FACT_GAP', 'blaze', 'close_call'), episode('FACT_GAP', 'blaze', 'close_call'), episode('FACT_GAP', 'blaze', 'close_call'),
		episode('NO_PRIMITIVE', 'ghast', 'damage', { damage: 5 }), episode('NO_PRIMITIVE', 'ghast', 'damage', { damage: 2 }),
		episode('REFLEX_SLOW', 'creeper', 'death', { evidence: 'one' }), episode('REFLEX_SLOW', 'creeper', 'avoided', { evidence: 'two' }), episode('REFLEX_SLOW', 'creeper', 'avoided', { evidence: 'three' }),
		episode('BODY_CAUSED', 'lava', 'damage', { damage: 9 }),
		episode('MODEL_CHOICE', 'zombie', 'death'), episode('UNPERCEIVABLE', 'lava', 'death'),
	]);
	assert.deepEqual(patches.map(p => `${p.diagnosis}/${p.kind}`), ['REFLEX_SLOW/creeper', 'NO_PRIMITIVE/ghast', 'BODY_CAUSED/lava', 'FACT_GAP/blaze']);
	assert.deepEqual(patches[0].examples, ['one', 'two']);
	assert.equal(patches[1].damageTaken, 7);
	// Equal deaths, damage and close calls: more damage taken ranks first.
	const tie = rankPatches([episode('FACT_GAP', 'a', 'damage', { damage: 1 }), episode('PERCEPTION_GAP', 'b', 'damage', { damage: 6 })]);
	assert.equal(tie[0].kind, 'b');
});

test('watch report counts fixture runs by kind x outcome, diagnosis, forecasts and close calls per death', async () => {
	const report = await buildWatchReport([fixtures]);
	assert.equal(report.runs.length, 2);
	const t = report.total;
	assert.equal(t.episodes, 12);
	assert.equal(t.deaths, 5);
	assert.equal(t.closeCalls, 4);
	assert.deepEqual(t.byKindOutcome.creeper, { death: 3, damage: 0, close_call: 2, avoided: 1 });
	assert.deepEqual(t.byKindOutcome.lava, { death: 1, damage: 1, close_call: 1, avoided: 0 });
	assert.deepEqual(t.byDiagnosis, { REFLEX_FAILED: 5, BODY_CAUSED: 3, PERCEPTION_GAP: 1, MODEL_CHOICE: 1, REFLEX_SLOW: 1, UNPERCEIVABLE: 1 });
	assert.deepEqual(t.patches.map(p => [`${p.diagnosis}/${p.kind}`, p.deaths, p.damage, p.closeCalls]), [
		['REFLEX_FAILED/creeper', 2, 0, 2], ['BODY_CAUSED/lava', 1, 1, 1], ['REFLEX_SLOW/creeper', 1, 0, 0], ['PERCEPTION_GAP/skeleton', 0, 1, 0]]);
	assert.equal(t.patches[0].examples.length, 2);
	assert.equal(t.realizedForecasts.forecasts, 3);
	assert.equal(t.realizedForecasts.becameEpisodes, 2);
	assert.deepEqual(t.realizedForecasts.byOutcome, { death: 1, damage: 1, close_call: 0, avoided: 0 });
	assert.deepEqual(t.closeCallsPerDeath.creeper, { closeCalls: 2, deaths: 3, ratio: 0.67 });
	assert.equal(t.closeCallsPerDeath.skeleton.ratio, null);
	const live = report.runs.find(r => r.run.endsWith('run-b'));
	assert.equal(live.droppedLines, 1, 'a copy taken mid-write ends in half a line');
	assert.equal(live.episodes, 4);
	const md = formatWatchReport(report);
	assert.match(md, /1\. \*\*REFLEX_FAILED \/ creeper\*\*: 2 deaths, 0 damage, 2 close calls/);
	assert.match(md, /\| skeleton \| 0 \| 1 \| 1 \| 0 \| 1:0 \|/);
});

test('summaries of no episodes are empty, not errors', () => {
	const s = summarizeWatch([], []);
	assert.equal(s.episodes, 0);
	assert.deepEqual(s.patches, []);
});

test('watch files are copied from the server dir into the artifact dir and found once', async () => {
	const run = await mkdtemp(path.join(tmpdir(), 'watch-collect-'));
	try {
		assert.equal(await collectWatchFiles(run), 0, 'no server dir yet');
		await mkdir(path.join(run, 'server', 'arena-watch'), { recursive: true });
		await writeFile(path.join(run, 'server', 'arena-watch', 'x-episodes.jsonl'), '{"v":1}\n');
		await writeFile(path.join(run, 'server', 'arena-watch', 'notes.txt'), 'not copied');
		assert.equal(await collectWatchFiles(run), 1);
		assert.equal(await readFile(path.join(run, 'arena-watch', 'x-episodes.jsonl'), 'utf8'), '{"v":1}\n');
		await rm(path.join(run, 'server'), { recursive: true });
		assert.deepEqual(await findWatchDirs(run), [path.join(run, 'arena-watch')]);
	} finally { await rm(run, { recursive: true, force: true }); }
});

test('a save point can be taken at a wall-clock time', () => {
	const at = milestoneTest('at:1500');
	assert.equal(at({ at: 1499 }), false);
	assert.equal(at({ at: 1500 }), true);
});
