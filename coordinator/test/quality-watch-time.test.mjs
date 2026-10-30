import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWatchReport } from '../../scripts/quality/watch-report.mjs';
import { LABELS, SYSTEM_LABELS, TIME_RULES, labelEpisode, measurable, observedTargets, progressMarks, readProgress, readWakes, stepTargets, summarizeTime, timeEpisodes, truthOf } from '../../scripts/quality/watch-time.mjs';

const T0 = 1_800_000_000_000, MIN = 60_000;
const IRON = { id: 'iron_capability', label: 'Iron and bucket', check: 'tool:pickaxe:iron+ & has:minecraft:bucket*1' };
const NETHER = { id: 'nether', label: 'Nether', check: 'in:minecraft:the_nether' };
const UNCHECKED = { id: 'prep', label: 'Prepare', check: null };

/** A synthetic run: samples every 5 s for `minutes`, the body at x(t), the focus step, and optional truth lines. */
function run({ minutes = 12, focus = IRON, x = () => 0, gains = [], truth = null, known = null, results = [], commands = [], wakes = [] } = {}) {
	const samples = [], progress = [];
	for (let at = T0; at <= T0 + minutes * MIN; at += 5_000) {
		const m = (at - T0) / MIN;
		samples.push({ at, dim: 'minecraft:overworld', pos: { x: x(m), y: 40, z: 0 }, deaths: 0, plan: true, focus, action: null, knownDist: known ? { iron: known(m) } : {} });
		if (truth) progress.push({ type: 'progress', agentId: 'a', atMs: at + 700, dim: 'minecraft:overworld', targets: truth(m) });
	}
	return { dir: 'fixture', startAt: T0, endAt: T0 + minutes * MIN, gains: gains.map(m => T0 + m * MIN), wouldWake: [], samples,
		commands: commands.map(([m, actionType]) => ({ at: T0 + m * MIN, actionType })), results: results.map(([m, actionType, state, reasonCode]) => ({ at: T0 + m * MIN, actionType, state, reasonCode })),
		wakes: wakes.map(([m, trigger]) => ({ at: T0 + m * MIN, trigger })), calls: [], intents: [], progress, deaths: 0 };
}
const ironLine = (iron) => ({ iron, lava_pool: { sources: 0, pool: null }, gravel: null });
const repeat = (n, row) => Array.from({ length: n }, (_, i) => [row[0] + i * 0.2, ...row.slice(1)]);

test('step checks map to the targets whose true distance measures them', () => {
	assert.deepEqual(stepTargets(IRON.check), ['iron']);
	assert.deepEqual(stepTargets(NETHER.check).sort(), ['lava_pool', 'nether_portal', 'obsidian']);
	assert.deepEqual(stepTargets('has:minecraft:flint_and_steel*1'), ['gravel']);
	assert.deepEqual(stepTargets('has:minecraft:blaze_rod*6').sort(), ['blaze_spawner', 'fortress']);
	assert.deepEqual(stepTargets('seen:minecraft:stronghold').sort(), ['portal_room', 'stronghold']);
	assert.deepEqual(stepTargets('y<=16'), [], 'a shallow depth step is measured by y, not a target');
	assert.deepEqual(stepTargets(null), []);
	assert.deepEqual(stepTargets('not a check'), []);
});

test('truth lines read distance, perceived-but-unobserved, far and known per kind', () => {
	const line = { targets: { iron: { count: 3, nearest: { dist: 9, pos: [1, 2, 3] }, perceivable: { dist: 12, pos: [4, 5, 6], inObservation: false }, known: null },
		lava_pool: { sources: 40, pool: { dist: 70, sources: 12, perceivable: true, inObservation: true }, known: { dist: 70 } }, gravel: null } };
	assert.deepEqual(truthOf(line, 'iron'), { dist: 9, unseen: true, far: false, hidden: false, known: null });
	assert.equal(truthOf(line, 'lava_pool').far, true);
	assert.equal(truthOf(line, 'lava_pool').known, 70);
	assert.deepEqual(truthOf(line, 'gravel'), { dist: null, unseen: false, far: true, hidden: false, known: null }, 'null is absent within the scan');
	assert.equal(truthOf(line, 'fortress'), null, 'a kind the line does not carry says nothing');
});

test('observations name targets by block id, structure label or entity type with their cells', () => {
	const rows = observedTargets({ sighted: { veins: [{ blockId: 'minecraft:deepslate_iron_ore', x: 1, y: -5, z: 2 }], structures: [{ structure: 'fortress', x: 9, y: 70, z: 9 }] },
		entities: [{ type: 'minecraft:end_crystal', position: { x: 3.5, y: 80.2, z: -1.5 } }], blocks: [{ blockId: 'minecraft:stone', x: 0, y: 0, z: 0, tags: ['#minecraft:lava'] }] });
	assert.deepEqual(rows.map(r => `${r.kind}@${r.x},${r.y},${r.z}`).sort(), ['crystals@3,80,-2', 'fortress@9,70,9', 'iron@1,-5,2']);
});

test('progress marks are check gains and 16-block approaches to the focus target', () => {
	const approach = run({ minutes: 10, gains: [3], truth: m => ironLine({ count: 1, nearest: { dist: Math.max(4, 60 - m * 6) }, perceivable: null, known: null }) });
	const marks = progressMarks(approach).map(at => (at - T0) / MIN);
	assert.ok(marks.includes(3), 'the gain is a mark');
	assert.ok(marks.length >= 4, `approaching 56 blocks gives several marks: ${marks}`);
	assert.equal(timeEpisodes(approach).length, 0, 'steady approach and a gain leave no 5-minute stretch');
});

test('no episode below five minutes; one stretch per gap between marks', () => {
	assert.equal(timeEpisodes(run({ minutes: 4.5 })).length, 0);
	const episodes = timeEpisodes(run({ minutes: 20, gains: [2, 9] }));
	assert.deepEqual(episodes.map(e => [e.startMin, e.minutesLost]), [[2, 7], [9, 11]]);
});

test('BODY_FAILING: the same action keeps failing with the same code', () => {
	const r = run({ results: [...repeat(10, [1, 'place_block', 'FAILED', 'NO_SUPPORT_FACE']), ...repeat(6, [4, 'place_block', 'SUCCEEDED', 'PLACED']), ...repeat(40, [6, 'move_to', 'SUCCEEDED', 'ARRIVED'])] });
	const [e] = timeEpisodes(r);
	assert.equal(e.label, 'BODY_FAILING');
	assert.match(e.evidence, /place_block FAILED NO_SUPPORT_FACE x10 of 16 place_block results/);
});

test('TARGET_UNSEEN: a perceivable target the observation never carried', () => {
	const r = run({ x: m => m * 30, truth: () => ironLine({ count: 4, nearest: { dist: 8 }, perceivable: { dist: 11, pos: [0, 0, 0], inObservation: false }, known: null }) });
	const [e] = timeEpisodes(r);
	assert.equal(e.label, 'TARGET_UNSEEN');
	assert.match(e.evidence, /iron perceivable but not in the observation in 100% of samples/);
	assert.equal(e.truth, true);
});

test('PLAN_NO_CHECK: an unchecked step cannot measure progress', () => {
	const [e] = timeEpisodes(run({ focus: UNCHECKED }));
	assert.equal(e.label, 'PLAN_NO_CHECK');
	assert.match(e.evidence, /step prep "Prepare" had no check/);
});

test('SLOW_BODY: closing on the target, far slower than a player', () => {
	const r = run({ x: m => m * 2, truth: m => ironLine({ count: 1, nearest: { dist: 30 - m }, perceivable: { dist: 30 - m, inObservation: true }, known: { dist: 30 - m } }) });
	const [e] = timeEpisodes(r);
	assert.equal(e.label, 'SLOW_BODY');
	assert.match(e.evidence, /30->18 blocks in 12 min/);
});

test('TARGET_FAR: nothing within reach and the body searched', () => {
	const r = run({ x: m => m * 40, truth: () => ironLine(null), results: repeat(20, [1, 'break_block', 'SUCCEEDED', 'BROKEN']) });
	const [e] = timeEpisodes(r);
	assert.equal(e.label, 'TARGET_FAR');
	assert.match(e.evidence, /absent or beyond 48 blocks in 100% of samples; walked 480/);
});

test('WAKE_IGNORED: a no-progress wake fired and the stretch ran 5+ more minutes', () => {
	const [e] = timeEpisodes(run({ minutes: 14, wakes: [[3, 'no_progress']], commands: repeat(30, [1, 'break_block']) }));
	assert.equal(e.label, 'WAKE_IGNORED');
	assert.match(e.evidence, /^no_progress at \+3 min, then 11 more min \(1 wake\); did break_block x30/);
	assert.equal(timeEpisodes(run({ minutes: 14, wakes: [[11, 'no_progress']] }))[0].label, 'UNKNOWN_TRUTH', 'a wake near the end is not ignored yet');
});

test('MODEL_CHOICE: the target was known nearby and Sol never went to it', () => {
	const r = run({ known: () => 20, commands: repeat(12, [1, 'craft_inventory']) });
	const [e] = timeEpisodes(r);
	assert.equal(e.label, 'MODEL_CHOICE');
	assert.match(e.evidence, /iron known 20 blocks away in 100% of samples, never within 6; did craft_inventory x12/);
	// Known and reached: not a model choice; without truth nothing else explains it.
	assert.equal(timeEpisodes(run({ known: () => 3 }))[0].label, 'UNKNOWN_TRUTH');
	assert.match(timeEpisodes(run({ known: () => 3 }))[0].evidence, /no progress lines; no search, target known in 100% of samples/);
});

test('degraded mode skips truth rules; with truth an unexplained stretch is a model choice', () => {
	const degraded = timeEpisodes(run({ x: m => m * 40, results: repeat(20, [1, 'break_block', 'SUCCEEDED', 'BROKEN']) }));
	assert.equal(degraded[0].label, 'UNKNOWN_TRUTH');
	assert.equal(degraded[0].truth, false);
	const idle = timeEpisodes(run({ truth: () => ironLine({ count: 1, nearest: { dist: 20 }, perceivable: null, known: null }) }));
	assert.equal(idle[0].label, 'MODEL_CHOICE', 'target hidden 20 blocks away, no search');
});

test('PLAN_NO_CHECK late: an all-or-nothing check measures nothing on the way', () => {
	assert.equal(measurable('in:minecraft:the_nether'), false);
	assert.equal(measurable('y<=-50'), true);
	assert.equal(measurable('in:minecraft:the_nether | lava:10'), true);
	const [e] = timeEpisodes(run({ focus: NETHER, commands: repeat(20, [1, 'break_block']) }));
	assert.equal(e.label, 'PLAN_NO_CHECK');
	assert.match(e.evidence, /check "in:minecraft:the_nether" has no measurable term in 100% of the stretch/);
	// A system cause found first keeps its label; a known target ignored is still the model's choice.
	assert.equal(timeEpisodes(run({ focus: NETHER, wakes: [[2, 'no_progress']] }))[0].label, 'WAKE_IGNORED');
	assert.equal(summarizeTime([{ label: 'PLAN_NO_CHECK', minutesLost: 9, evidence: e.evidence, step: e.step }]).topFixes[0].name, 'PLAN_NO_CHECK / nether unmeasurable');
});

test('rule table: one place, precedence order, every label known', () => {
	assert.deepEqual(TIME_RULES.map(r => r.label), ['BODY_FAILING', 'TARGET_UNSEEN', 'PLAN_NO_CHECK', 'SLOW_BODY', 'TARGET_FAR', 'WAKE_IGNORED', 'MODEL_CHOICE', 'PLAN_NO_CHECK']);
	for (const r of TIME_RULES) assert.ok(LABELS.includes(r.label));
	assert.deepEqual(TIME_RULES.filter(r => r.needsTruth).map(r => r.label), ['TARGET_UNSEEN', 'SLOW_BODY', 'TARGET_FAR']);
	// A body failure outranks an unseen target in the same stretch.
	const both = { topFailure: { key: 'mine_block FAILED NO_PATH', count: 9, of: 10 }, unseenShare: 1, unseenExample: { kind: 'iron', dist: 5 }, truth: true, wakes: [], actions: {} };
	assert.equal(labelEpisode(both).label, 'BODY_FAILING');
});

test('summary: minutes lost by label and the system fixes ranked by minutes', () => {
	const episodes = [
		{ label: 'BODY_FAILING', minutesLost: 12, evidence: 'place_block FAILED NO_FACE x10 of 12 place_block results', step: 'nether [in:minecraft:the_nether]' },
		{ label: 'BODY_FAILING', minutesLost: 6, evidence: 'place_block FAILED NO_FACE x9 of 9 place_block results', step: 'nether [in:minecraft:the_nether]' },
		{ label: 'WAKE_IGNORED', minutesLost: 20, evidence: 'no_progress at +3 min, then 17 more min', step: 'iron [x]' },
		{ label: 'TARGET_FAR', minutesLost: 30, evidence: 'far', step: 'iron [x]' },
	];
	const s = summarizeTime(episodes, 120);
	assert.equal(s.minutesLost, 68);
	assert.deepEqual(s.byLabel.BODY_FAILING, { episodes: 2, minutes: 18 });
	assert.deepEqual(s.byLabel.TARGET_FAR, { episodes: 1, minutes: 30 });
	assert.deepEqual(s.topFixes.map(f => [f.name, f.minutes]), [['WAKE_IGNORED / no_progress', 20], ['BODY_FAILING / place_block FAILED NO_FACE', 18]], 'logged labels are not fixes');
	assert.ok(SYSTEM_LABELS.every(l => Object.hasOwn(s.byLabel, l)));
});

test('reads progress lines from the artifact copy and real progress wakes from the coordinator trace', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'watch-time-'));
	try {
		await mkdir(path.join(dir, 'arena-watch'));
		await writeFile(path.join(dir, 'arena-watch', 'a-progress.jsonl'), [
			JSON.stringify({ v: 1, type: 'progress', agentId: 'a', atMs: 2, targets: {} }), JSON.stringify({ v: 1, type: 'progress', agentId: 'a', atMs: 1, targets: {} }), '{"half'].join('\n'));
		await writeFile(path.join(dir, 'arena-watch', 'a-episodes.jsonl'), JSON.stringify({ v: 1, type: 'episode', id: 'e' }) + '\n');
		await writeFile(path.join(dir, 'coordinator.jsonl'), [
			{ event: 'native_event_ready', trigger: 'no_progress', at: 5, agentId: 'a' }, { event: 'native_event_ready', trigger: 'observation', at: 6 },
			{ event: 'native_event_ready', trigger: 'repeated_result', at: 7, agentId: 'a' }, { event: 'native_tool_executed', trigger: 'no_progress', at: 8 }].map(r => JSON.stringify(r)).join('\n'));
		assert.deepEqual((await readProgress(dir)).map(p => p.atMs), [1, 2]);
		assert.deepEqual((await readWakes(dir)).map(w => [w.at, w.trigger]), [[5, 'no_progress'], [7, 'repeated_result']]);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the watch report carries the time summary, empty when no artifact dir has a protocol', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'watch-time-report-'));
	try {
		const report = await buildWatchReport([dir], { time: true });
		assert.equal(report.time.total.episodes, 0);
		assert.deepEqual(report.time.runs, []);
		assert.equal((await buildWatchReport([dir])).time, undefined, 'time is opt-in for the library call');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('End steps: dragon health lost and crystals destroyed are progress', () => {
	const DRAGON = { id: 'dragon', label: 'Kill the dragon', check: 'killed:minecraft:ender_dragon' };
	const endLine = (health, left) => ({ dragon: { dist: 14, health, perceivable: true, inObservation: false }, crystals: { left, caged: 0, nearest: null } });
	// 20 minutes of fighting: the dragon loses 4 health a minute and a crystal goes every 6 minutes.
	const fight = run({ minutes: 20, focus: DRAGON, truth: m => endLine(200 - 4 * m, 10 - Math.floor(m / 6)) });
	assert.equal(timeEpisodes(fight).length, 0, 'a dragon losing health leaves no 5-minute stretch without progress');
	const crystalsOnly = run({ minutes: 20, focus: DRAGON, truth: m => endLine(200, 10 - Math.floor(m / 4)) });
	assert.ok(progressMarks(crystalsOnly).length >= 6, 'each crystal destroyed is a mark');
	const idle = run({ minutes: 20, focus: DRAGON, truth: () => endLine(182, 10) });
	assert.equal(timeEpisodes(idle).length, 1, 'no damage and no crystals is still no progress');
});

test('a lava-floor depth step is measured by the depth left, then the nearest floor lava', () => {
	const FLOOR = { id: 'lava_floor', label: 'Lava floor', check: 'y<=-50' };
	assert.deepEqual(stepTargets(FLOOR.check), ['lava_floor']);
	assert.deepEqual(stepTargets('y<=16'), [], 'a shallow depth term stays its own metric');
	assert.equal(truthOf({ targets: { lava_floor: { depth: 110, nearest: null } } }, 'lava_floor').far, true);
	const hidden = truthOf({ targets: { lava_floor: { depth: 0, nearest: { dist: 21, perceivable: false, inObservation: false } } } }, 'lava_floor');
	assert.equal(hidden.dist, 21); assert.equal(hidden.hidden, true);
	// Descending 1 block every 4 s: 16-block approaches are progress, so no stretch of 5 minutes without it.
	const descent = run({ minutes: 10, focus: FLOOR, truth: m => ({ lava_floor: { depth: Math.max(0, 120 - Math.round(m * 15)), nearest: null } }) });
	assert.equal(timeEpisodes(descent).length, 0);
	// Tunnelling at the floor past a pool that stays hidden 20 blocks away: the truth labels it, not UNKNOWN_TRUTH.
	const tunnel = run({ minutes: 12, focus: FLOOR, x: m => m * 30, truth: () => ({ lava_floor: { depth: 0, nearest: { dist: 20, perceivable: false, inObservation: false } } }),
		results: Array.from({ length: 200 }, (_, i) => [i * 0.05, 'break_block', 'SUCCEEDED', null]) });
	const [episode] = timeEpisodes(tunnel);
	assert.ok(episode && episode.label !== 'UNKNOWN_TRUTH', episode?.label);
});
