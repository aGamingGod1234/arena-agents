import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCapabilityMatrices, CAPABILITY_TASKS, capabilityMilestonePassed, classifyCapabilityRun, selectPairwiseCases } from '../src/headless-capabilities.mjs';
import { normalizeHeadlessScenario, runHeadlessMatrix, runHeadlessScenario } from '../src/headless-matrix.mjs';
import { claimNaturalWorld, normalizeHeadlessWorld, parsePlayerPosition, parseServerSeed, summarizeProviderAttestation, validateNaturalWorldManifest } from '../src/headless-world.mjs';

const profile = { provider: 'codex', model: 'fixture', reasoningEffort: 'low', serviceTier: 'priority' };
const makeScenario = (overrides = {}) => normalizeHeadlessScenario({
	id: 'natural-case', ...profile, task: 'Collect a log', timeoutMs: 10_000, requireFactualSuccess: true,
	world: { mode: 'natural', seed: '9223372036854775807' },
	assert: [{ type: 'lifecycle', state: 'COMPLETED' }, ...CAPABILITY_TASKS[0].assert], ...overrides,
});
const header = (name, rest, revision = 1) => `audit=v2 agent=${name} agentId=fixture-agent goalRevision=${revision} goal=00000000-0000-4000-8000-000000000001 world=fresh ${rest}`;
const autonomous = (name) => header(name, 'coverage=complete interventions=0 autonomy=autonomous');
const manifest = (scenario) => ({
	version: 1, scenarioId: scenario.id, fresh: true, worldId: 'headless-isolated-fixture', world: scenario.world,
	savedSpawn: { source: 'level.dat', dimension: 'minecraft:overworld', x: 10, y: 65, z: -4 },
	spawnLoading: { operation: 'temporary_spawn_chunk_loading', x: scenario.world.spawn.x ?? 10, z: scenario.world.spawn.z ?? -4, ready: true, elapsedMs: 50, terrainModified: false, inventoryModified: false },
});

test('natural world preserves exact 64-bit seeds and rejects invalid settings or synthetic setup', () => {
	const scenario = makeScenario();
	assert.equal(scenario.world.seed, '9223372036854775807');
	assert.equal(scenario.world.gameMode, 'survival');
	assert.deepEqual(scenario.world.spawn, { policy: 'world_spawn' });
	assert.equal(validateNaturalWorldManifest(manifest(scenario), scenario.world, scenario.id).fresh, true);
	for (const seed of [1, '9223372036854775808', '-9223372036854775809', '1e9', '01', '12\nstop']) assert.throws(() => makeScenario({ world: { mode: 'natural', seed } }), /seed/);
	for (const overrides of [{ repetitions: 2 }, { rosterSize: 8 }, { setupBlocks: [{ x: 0, y: 64, z: 0, blockId: 'minecraft:stone' }] }, { requireFactualSuccess: false }]) assert.throws(() => makeScenario(overrides), /natural evaluations/);
	assert.throws(() => makeScenario({ world: { mode: 'natural', seed: '0', rules: { 'bad rule': true } } }), /rules/);
	assert.throws(() => normalizeHeadlessWorld({ mode: 'arena', seed: '0' }), /arena/);
	assert.throws(() => validateNaturalWorldManifest({ ...manifest(scenario), fresh: false }, scenario.world, scenario.id), /fresh isolated/);
	assert.throws(() => validateNaturalWorldManifest({ ...manifest(scenario), world: { mode: 'natural', seed: '1' } }, scenario.world, scenario.id), /do not match/);
	assert.equal(parseServerSeed('Seed: [9223372036854775807]'), '9223372036854775807');
	assert.deepEqual(parsePlayerPosition('player has the following entity data: [-2.5d, 71.0d, 4.5d]'), { x: -2.5, y: 71, z: 4.5 });
});

async function fixture({ scenario = makeScenario(), seed = scenario.world.seed, inventory = '[]', outcome = true, snapshot = true, effectiveProfile = profile, executionSettings = null, worldManifest = manifest(scenario), afterStart = null, loaded = true, pendingJoin = false, holds = null, audit = null, goalRevision = 1 } = {}) {
	const commands = [];
	let name = '';
	let started = false;
	const report = await runHeadlessScenario({
		scenario, worldManifest, runDirectory: path.resolve('test-natural-world-fixture'), providerTurnsPath: 'provider-turns.private.jsonl', now: () => 100,
		readFile: async (file) => {
			if (String(file).endsWith('protocol.jsonl') && name && snapshot) return `${JSON.stringify({ direction: 'server_to_coordinator', envelope: { type: 'agent_snapshot', agentId: 'fixture-agent', payload: { agentId: 'fixture-agent', name, ...effectiveProfile } } })}\n${JSON.stringify({ direction: 'server_to_coordinator', envelope: { type: 'goal_completion_result', agentId: 'fixture-agent', payload: { agentId: 'fixture-agent', goalRevision } } })}\n`;
			if (file === 'provider-turns.private.jsonl' && name && executionSettings) return `${JSON.stringify({ ...profile, agentId: 'fixture-agent', executionSettings })}\n`;
			return '';
		},
		fileSize: async () => 0, writeFile: async () => {}, poll: async () => {},
		rcon: {
			close: async () => {},
			command: async (command) => {
				commands.push(command);
				if (command === 'seed') return { text: `Seed: [${seed}]` };
				if (command === 'difficulty') return { text: `The difficulty is ${scenario.world.difficulty}` };
				if (command.includes(' if loaded ')) return { text: loaded ? 'The time is 500' : 'Test failed' };
				if (command.startsWith('gamerule ')) return { text: 'The gamerule is true' };
				if (command.includes('summon-configured')) { name = command.split(' ').at(-1); return { text: pendingJoin ? `Creating ${name}. It will be ready when its player joins.` : `Created ${name}. It is ready for a task.` }; }
				if (command.startsWith('codex start ')) { started = true; afterStart?.(); return { text: 'started' }; }
				if (command.startsWith('codex status ')) return { text: pendingJoin && !started ? `${name} | READY.` : 'state=COMPLETED' };
				// No audit answer is what an older server without the intervention audit returns.
				if (command === `codex audit ${name}`) return { text: audit === null ? 'Unknown or incomplete command, see below for error' : audit(name) };
				if (command === `data get entity ${name} Inventory`) return { text: `${name} has the following entity data: ${inventory}` };
				if (command === `data get entity ${name} Pos` || command.startsWith('execute if ') || command.startsWith('execute positioned ')) return { text: command.startsWith('data get ') || (holds === null ? outcome : holds(command, name)) ? `${name} has the following entity data: [10.5d, 65.0d, -3.5d]` : 'Test failed' };
				return { text: 'ok' };
			},
		},
	});
	return { report, commands };
}

test('natural runner preserves terrain and inventory, scopes exact settings, and never sends evaluator facts in the task', async () => {
	const { report, commands } = await fixture();
	assert.equal(report.status, 'PASSED');
	assert.equal(report.factualSuccess, true);
	assert.equal(report.world.seed, '9223372036854775807');
	assert.equal(report.world.fresh, true);
	assert.deepEqual(report.world.spawnPosition, { x: 10.5, y: 65, z: -3.5 });
	assert.deepEqual(report.settings, { requested: profile, configured: profile, configuredVerified: true, effective: null, evidence: null });
	assert.deepEqual(report.budget, { wallClockMs: 10_000 });
	assert.equal(commands.some((command) => /\b(?:fill|setblock|give|clear|teleport|tp)\b/.test(command)), false);
	const task = commands.find((command) => command.startsWith('codex start '));
	assert.match(task, / Collect a log$/);
	assert.doesNotMatch(task, /922337|manifest|seed|assert|profile/);
	assert.ok(commands.some((command) => command.includes('positioned 10.5 65 -3.5 run codex summon-configured')));
	const release = commands.indexOf('execute in minecraft:overworld run forceload remove 10 -4');
	assert.ok(release > commands.findIndex((command) => command.endsWith(' Inventory')));
	assert.ok(release < commands.findIndex((command) => command.startsWith('codex start ')));
	assert.equal(report.world.setupInterventions[0].released, true);
});

test('natural spawn readiness fails closed and releases its exact ticket without changing terrain', async () => {
	const { report, commands } = await fixture({ loaded: false });
	assert.equal(report.status, 'FAILED');
	assert.equal(commands.some((command) => command.includes('summon-configured')), false);
	assert.equal(commands.at(-1), 'execute in minecraft:overworld run forceload remove 10 -4');
	assert.equal(report.world.setupInterventions[0].released, true);
	const missing = await fixture({ worldManifest: { ...manifest(makeScenario()), savedSpawn: undefined } });
	assert.equal(missing.report.status, 'FAILED');
	assert.equal(missing.commands.some((command) => command.includes('summon-configured')), false);
	const surface = await fixture({ scenario: makeScenario({ world: { mode: 'natural', seed: '1', spawn: { policy: 'surface', x: -20, z: 48 } } }) });
	assert.equal(surface.report.status, 'PASSED');
	assert.ok(surface.commands.some((command) => command.includes('positioned -19.5 0 48.5 positioned over world_surface run codex summon-configured')));
	assert.ok(surface.commands.includes('execute in minecraft:overworld run forceload remove -20 48'));
	const joining = await fixture({ pendingJoin: true });
	assert.equal(joining.report.status, 'PASSED');
	assert.ok(joining.commands.findIndex((command) => command.startsWith('codex status ')) < joining.commands.indexOf('execute in minecraft:overworld run forceload remove 10 -4'));
});

test('natural runner fails before agent start for missing identity, wrong seed or nonempty inventory', async () => {
	for (const options of [{ worldManifest: null }, { seed: '123' }, { inventory: '[{id:"minecraft:diamond",count:1}]' }]) {
		const { report, commands } = await fixture(options);
		assert.equal(report.status, 'FAILED');
		assert.equal(report.failureCategory, 'infrastructure');
		assert.equal(commands.some((command) => command.startsWith('codex start ')), false);
	}
});

test('natural success requires factual outcomes and authoritative exact-profile evidence', async () => {
	assert.equal((await fixture({ outcome: false })).report.classification, 'ASSERTION_MISMATCH');
	assert.equal((await fixture({ snapshot: false })).report.status, 'FAILED');
	assert.equal((await fixture({ effectiveProfile: { ...profile, reasoningEffort: 'high' } })).report.status, 'FAILED');
});

test('configured model settings never substitute for missing provider attestation', () => {
	assert.deepEqual(summarizeProviderAttestation([], profile), { effective: null, evidence: null, mismatches: [] });
	const unknown = { effective: { provider: 'codex', model: null, reasoningEffort: null, serviceTier: null }, evidence: { model: 'submitted', reasoningEffort: 'process_environment', serviceTier: 'submitted' } };
	assert.deepEqual(summarizeProviderAttestation([{ executionSettings: unknown }], profile).mismatches, []);
	assert.deepEqual(summarizeProviderAttestation([{ executionSettings: { effective: { ...profile, reasoningEffort: 'high' }, evidence: { reasoningEffort: 'provider_reported' } } }], profile).mismatches, ['reasoningEffort']);
});

test('natural runner retains provider attestation and rejects a positively reported model substitution', async () => {
	const unknown = await fixture({ executionSettings: { effective: { provider: 'codex', model: null, reasoningEffort: null, serviceTier: null }, evidence: { model: 'submitted', reasoningEffort: 'process_environment', serviceTier: 'unreported' } } });
	assert.equal(unknown.report.status, 'PASSED');
	assert.equal(unknown.report.settings.effective.reasoningEffort, null);
	assert.equal(unknown.report.settings.evidence.reasoningEffort, 'process_environment');
	const substituted = await fixture({ executionSettings: { effective: { ...profile, model: 'substituted-model' }, evidence: { model: 'provider_reported', reasoningEffort: 'submitted', serviceTier: 'submitted' } } });
	assert.equal(substituted.report.classification, 'PROFILE_MISMATCH');
	assert.equal(substituted.report.failureCategory, 'profile');
	assert.equal(substituted.report.settings.effective.model, 'substituted-model');
});

test('spawn-relative and inventory/advancement assertions remain bounded read-only server queries', async () => {
	for (const capability of CAPABILITY_TASKS) {
		const scenario = makeScenario({ assert: [{ type: 'lifecycle', state: 'COMPLETED' }, ...capability.assert] });
		const { report, commands } = await fixture({ scenario, audit: autonomous });
		assert.equal(report.status, 'PASSED', `${capability.id}: ${report.diagnostics}`);
		if (capability.id === 'travel') assert.ok(commands.some((command) => command.startsWith('execute positioned 10.5 65 -3.5 if entity ')));
	}
	for (const command of [
		'execute if items entity {agent} container.* #minecraft:logs run give {agent} minecraft:diamond',
		'execute if entity @a[name={agent},advancements={minecraft:adventure/kill_a_mob=true}] run kill {agent}',
	]) {
		const { report, commands } = await fixture({ scenario: makeScenario({ assert: [{ type: 'rcon', command, match: 'ok' }] }) });
		assert.equal(report.status, 'FAILED');
		assert.equal(commands.some((entry) => /run (give|kill) /.test(entry)), false);
	}
});

test('late-game capability milestones pass only from their own server-verified evidence', async () => {
	// A tiny model of server truth: an execute-if query holds only when the named player has that exact advancement or item.
	const server = ({ advancements = [], items = [] }) => (command, name) => {
		const earned = command.match(/^execute if entity @a\[name=(\S+?),advancements=\{([^=]+)=true\}\] run data get entity /);
		if (earned) return earned[1] === name && advancements.includes(earned[2]);
		const owned = command.match(/^execute if items entity (\S+) container\.\* (\S+) run data get entity /);
		if (owned) return owned[1] === name && items.includes(owned[2]);
		return false;
	};
	const late = CAPABILITY_TASKS.filter((task) => task.stage === 'late');
	assert.deepEqual(late.map((task) => task.id), ['nether', 'blaze_rod', 'ender_pearl', 'stronghold', 'end', 'dragon']);
	const evidence = {
		nether: { advancements: ['minecraft:story/enter_the_nether'] },
		blaze_rod: { advancements: ['minecraft:nether/obtain_blaze_rod'] },
		ender_pearl: { items: ['minecraft:ender_pearl'] },
		stronghold: { advancements: ['minecraft:story/follow_ender_eye'] },
		end: { advancements: ['minecraft:story/enter_the_end'] },
		// A bed-explosion kill: the server's goal verifier credits the agent (lifecycle COMPLETED) but vanilla awards no
		// end/kill_dragon advancement, so the task must not require it.
		dragon: { advancements: ['minecraft:story/enter_the_end'] },
	};
	// The dragon task's kill evidence is the server goal verdict (lifecycle); its RCON fact is the End entry.
	const sameFacts = new Set(['end:dragon', 'dragon:end']);
	const decoys = {
		'arrow spawn': { advancements: ['minecraft:adventure/shoot_arrow'], items: ['minecraft:arrow', 'minecraft:bow'] },
		'unrelated kill': { advancements: ['minecraft:adventure/kill_a_mob', 'minecraft:adventure/kill_all_mobs'] },
		'early resources': { advancements: ['minecraft:story/mine_stone', 'minecraft:story/iron_tools', 'minecraft:story/obtain_armor'], items: ['minecraft:oak_log', 'minecraft:iron_pickaxe', 'minecraft:cooked_beef'] },
	};
	let passed = 0, failed = 0;
	for (const task of late) {
		assert.ok(task.timeoutMs > 600_000 && task.timeoutMs <= 21_600_000, task.id);
		const scenario = makeScenario({ task: task.task, timeoutMs: task.timeoutMs, assert: [{ type: 'lifecycle', state: 'COMPLETED' }, ...task.assert] });
		const own = await fixture({ scenario, holds: server(evidence[task.id]), audit: autonomous });
		assert.equal(own.report.status, 'PASSED', `${task.id}: ${own.report.diagnostics}`);
		assert.deepEqual(classifyCapabilityRun(own.report), { autonomy: 'autonomous', interventions: 0 });
		assert.equal(capabilityMilestonePassed(own.report, task.id), true);
		passed += 1;
		for (const [label, state] of [...Object.entries(decoys), ...Object.entries(evidence).filter(([id]) => id !== task.id && !sameFacts.has(`${task.id}:${id}`)).map(([id, state]) => [`other milestone ${id}`, state])]) {
			const decoy = await fixture({ scenario, holds: server(state), audit: autonomous });
			assert.equal(decoy.report.status, 'FAILED', `${task.id} passed from ${label}`);
			assert.equal(decoy.report.factualSuccess, false, `${task.id} from ${label}`);
			failed += 1;
		}
	}
	// The dragon credit belongs to the named agent: another player's kill does not count.
	const dragon = late.find((task) => task.id === 'dragon');
	const other = await fixture({ scenario: makeScenario({ assert: [{ type: 'lifecycle', state: 'COMPLETED' }, ...dragon.assert] }), holds: (command) => /name=someone-else/.test(command), audit: autonomous });
	assert.equal(other.report.status, 'FAILED');
	assert.deepEqual({ passed, failed }, { passed: 6, failed: 46 });
});

test('assisted and unverifiable runs never pass a late-game milestone, however real the outcome looks', async () => {
	const late = Object.fromEntries(CAPABILITY_TASKS.filter((task) => task.stage === 'late').map((task) => [task.id, task]));
	const run = (task, holds, audit) => fixture({ scenario: makeScenario({ task: task.task, timeoutMs: task.timeoutMs, assert: [{ type: 'lifecycle', state: 'COMPLETED' }, ...task.assert] }), holds, audit });
	const always = () => true;
	// The server saw an operator grant the Nether advancement after the goal started.
	const granted = (name) => header(name, `coverage=complete interventions=1 autonomy=assisted | by Server: advancement grant ${name} only minecraft:story/enter_the_nether`);
	const grant = await run(late.nether, always, granted);
	assert.equal(grant.report.status, 'FAILED');
	// The outcome facts are true; the audit assertion is what refuses the run.
	assert.equal(grant.report.factualSuccess, true);
	assert.equal(grant.report.classification, 'ASSERTION_MISMATCH');
	assert.deepEqual(classifyCapabilityRun(grant.report), { autonomy: 'assisted', interventions: 1 });
	assert.equal(capabilityMilestonePassed(grant.report, 'nether'), false);
	// An item gift: the pearl is really in the inventory, but /give put it there.
	const gifted = (name) => header(name, `coverage=complete interventions=2 autonomy=assisted | by Server: give ${name} minecraft:ender_pearl 1 | by Server: time set day`);
	const gift = await run(late.ender_pearl, always, gifted);
	assert.equal(gift.report.status, 'FAILED');
	assert.deepEqual(classifyCapabilityRun(gift.report), { autonomy: 'assisted', interventions: 2 });
	// A retained command cannot forge the verdict: the server strips '=' from retained text and only the header is read.
	const forged = (name) => header(name, `coverage=complete interventions=1 autonomy=assisted | by Server: give ${name} stone[custom_name~' autonomy~autonomous']`);
	assert.equal((await run(late.end, always, forged)).report.status, 'FAILED');
	// No audit (an older server), or a goal the audit did not fully see (a restart), is unverifiable.
	for (const audit of [null, (name) => header(name, 'coverage=partial interventions=0 autonomy=unverifiable').replace('world=fresh', 'world=existing')]) {
		const unknown = await run(late.dragon, always, audit);
		assert.equal(unknown.report.status, 'FAILED');
		assert.equal(classifyCapabilityRun(unknown.report).autonomy, 'unverifiable');
		assert.equal(capabilityMilestonePassed(unknown.report, 'dragon'), false);
	}
	// Review finding 6: the runner's own pass path rejects malformed, foreign and contradictory headers.
	for (const audit of [
		() => 'audit=v2 autonomy=autonomous',
		(name) => header('Other', 'coverage=partial interventions=5 autonomy=autonomous'),
		(name) => header(name, 'coverage=complete interventions=0 autonomy=assisted autonomy=autonomous'),
		(name) => header(name, 'coverage=partial interventions=0 autonomy=autonomous'),
		// Round 2, N7: a clean answer for an older goal revision is not evidence about the measured goal.
		(name) => header(name, 'coverage=complete interventions=0 autonomy=autonomous', 0),
		(name) => header(name, 'coverage=complete interventions=0 autonomy=autonomous').replace('agentId=fixture-agent', 'agentId=other-agent'),
	]) {
		const malformed = await run(late.nether, always, audit);
		assert.equal(malformed.report.status, 'FAILED', audit('X'));
		assert.equal(classifyCapabilityRun(malformed.report).autonomy, 'unverifiable');
		assert.equal(capabilityMilestonePassed(malformed.report, 'nether'), false);
	}
	// Positive control: the same outcome with a clean audit passes.
	const clean = await run(late.nether, always, autonomous);
	assert.equal(clean.report.status, 'PASSED');
	assert.equal(capabilityMilestonePassed(clean.report, 'nether'), true);
	// Early tasks keep their outcome-only check and need no audit.
	const early = await fixture({ scenario: makeScenario(), audit: null });
	assert.equal(early.report.status, 'PASSED');
	assert.equal(capabilityMilestonePassed(early.report, 'gather'), true);
	assert.equal(classifyCapabilityRun(early.report).autonomy, 'unverifiable');
});

test('capability generation keeps early tasks by default and adds late milestones only when requested', () => {
	const seeds = ['1', '-2'];
	const early = buildCapabilityMatrices({ profiles: [profile], seeds, difficulties: ['normal'] });
	assert.deepEqual(early.coverage.stages, ['early']);
	assert.equal(early.coverage.tasks, 5);
	const all = buildCapabilityMatrices({ profiles: [profile], seeds, difficulties: ['normal'], taskIds: CAPABILITY_TASKS.map((task) => task.id) });
	const scenarios = all.matrices.flatMap((matrix) => matrix.scenarios);
	assert.deepEqual(all.coverage.stages, ['early', 'late']);
	assert.equal(all.coverage.tasks, 11);
	assert.equal(all.coverage.coveredPairs, all.coverage.totalPairs);
	const dragon = scenarios.find((scenario) => scenario.id.startsWith('cap-dragon-'));
	assert.equal(dragon.timeoutMs, 21_600_000);
	assert.equal(dragon.world.mode, 'natural');
	assert.ok(dragon.assert.some((assertion) => assertion.type === 'lifecycle' && assertion.state === 'COMPLETED'),
		'the server goal verdict (which credits bed kills) is the dragon evidence');
	assert.ok(dragon.assert.some((assertion) => assertion.type === 'rcon' && assertion.command.includes('minecraft:story/enter_the_end=true')));
	assert.equal(scenarios.find((scenario) => scenario.id.startsWith('cap-gather-')).timeoutMs, 600_000);
	for (const scenario of scenarios) assert.equal(normalizeHeadlessScenario(scenario).timeoutMs, scenario.timeoutMs);
});

test('natural matrix cannot connect to an unowned or shared server without its fresh-world manifest', async () => {
	let connected = false;
	await assert.rejects(() => runHeadlessMatrix({
		configPath: 'matrix.json', runDirectory: path.resolve('fixture'), rconPasswordFile: 'password',
		readFile: async () => JSON.stringify({ version: 1, scenarios: [{ ...profile, id: 'case', task: 'task', timeoutMs: 1000, requireFactualSuccess: true, world: { mode: 'natural', seed: '1' }, assert: CAPABILITY_TASKS[0].assert }] }),
		rconFactory: () => { connected = true; },
	}), /one scenario per isolated server/);
	assert.equal(connected, false);
});

test('concurrent CLI attempts cannot reuse a natural world, including after a failed attempt', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'arena-world-claim-'));
	const file = path.join(directory, 'world-manifest.json');
	try {
		const claims = await Promise.allSettled([claimNaturalWorld(file, 'headless-test'), claimNaturalWorld(file, 'headless-test')]);
		assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1);
		assert.match(claims.find((result) => result.status === 'rejected').reason.message, /NATURAL_WORLD_REUSED/);
		assert.equal(JSON.parse(await readFile(`${file}.claimed`, 'utf8')).worldId, 'headless-test');
		await assert.rejects(() => claimNaturalWorld(file, 'headless-test'), /fresh isolated server/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('capability scheduling covers every valid pair without changing or fabricating model settings', () => {
	const profiles = [profile, { ...profile, model: 'other', reasoningEffort: 'high', serviceTier: 'fast' }];
	const { matrices, coverage } = buildCapabilityMatrices({ profiles, seeds: ['1', '-2'], difficulties: ['easy', 'hard'] });
	const scenarios = matrices.flatMap((matrix) => matrix.scenarios);
	assert.equal(coverage.coveredPairs, coverage.totalPairs);
	assert.ok(coverage.selectedCount < coverage.candidateCount);
	assert.ok(matrices.every((matrix) => matrix.scenarios.length <= 24));
	for (const scenario of scenarios) {
		assert.ok(profiles.some((candidate) => Object.keys(profile).every((key) => candidate[key] === scenario[key])));
		assert.equal(normalizeHeadlessScenario(scenario).repetitions, 1);
		assert.equal(scenario.world.mode, 'natural');
		assert.equal(scenario.task.includes(scenario.world.seed), false);
	}
	const dimensions = scenarios.map((scenario) => ({ profile: `${scenario.model}/${scenario.reasoningEffort}/${scenario.serviceTier}`, seed: scenario.world.seed, difficulty: scenario.world.difficulty, task: scenario.task }));
	for (const left of ['profile', 'seed', 'difficulty', 'task']) for (const right of ['profile', 'seed', 'difficulty', 'task']) {
		if (left >= right) continue;
		for (const first of new Set(dimensions.map((row) => row[left]))) for (const second of new Set(dimensions.map((row) => row[right]))) assert.ok(dimensions.some((row) => row[left] === first && row[right] === second), `${left}/${right} missing pair`);
	}
	assert.deepEqual(buildCapabilityMatrices({ profiles, seeds: ['1', '-2'], difficulties: ['easy', 'hard'] }), { matrices, coverage });
	assert.throws(() => selectPairwiseCases([]), /candidates/);
});

test('PowerShell launcher writes isolated natural worlds and runs the provider-free probe without the coordinator', { skip: process.platform !== 'win32' }, () => {
	const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('../scripts/test-headless-natural-world.ps1')], { encoding: 'utf8', timeout: 30_000 });
	assert.equal(result.status, 0, result.stderr);
	assert.equal((result.stdout.match(/PASS /g) ?? []).length, 3);
});
