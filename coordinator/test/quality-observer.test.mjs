import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Tail, Observer, measurementStatus, pollWithin, SAMPLER_GAP_MS } from '../../scripts/quality/run-scenarios.mjs';
import { resolveGoalWindow } from '../src/benchmark/quality-metrics.mjs';
import { writeArtifactReport } from '../src/benchmark/report-artifacts.mjs';
import { epoch } from '../src/benchmark/quality-metrics.mjs';

test('recorded protocol action with outer observedAtMs activates hazards through the Observer',async()=>{
 const row=JSON.parse(await readFile(new URL('./fixtures/quality-real-action-row.json',import.meta.url),'utf8'));
 assert.equal(epoch(row.envelope),null);assert.equal(epoch(row),row.observedAtMs);
 const directory=await mkdtemp(path.join(os.tmpdir(),'quality-real-activation-'));
 try {
  const observer=new Observer(directory,{protocolAudit:'',providerTurns:''},{objective:{type:'survival'}},{});
  observer.agent='player';observer.agentId=row.envelope.agentId;observer.startedAt=row.observedAtMs-100;
  observer.setup={agent:'player',goalStartedAt:observer.startedAt,definition:{generality:true,freezeUntilGoalStart:true,activation:'first-decision',finalCommands:['setblock ~ ~ ~ minecraft:fire']}};
  observer.trace={rows:[],poll:async()=>[]};observer.provider={rows:[],poll:async()=>[]};
  observer.protocol={rows:[{type:'goal_control',agentId:observer.agentId,payload:{operation:'start',updatedAtEpochMs:observer.startedAt}}],poll:async()=>[]};
  observer.capturePlan=async()=>{};observer.samplePlayer=async()=>{};
  const commands=[];observer.rcon={command:async text=>{commands.push(text);return {text:'ok'}}};
  await observer.poll();assert.equal(commands.length,0);
  observer.protocol.rows.push(row);await observer.poll();await observer.poll();
  assert.deepEqual(commands,['setblock ~ ~ ~ minecraft:fire','tick unfreeze']);
  assert.ok(observer.setup.activatedAt);assert.ok(observer.setup.releasedAt);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('tail retains a final non-newline row and reports malformed JSONL', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-tail-'));
	try {
		const file = path.join(directory, 'rows.jsonl');
		await writeFile(file, '{"at":1}\nmalformed\n{"at":2}');
		const tail = new Tail(file);
		await tail.poll();
		assert.equal(tail.rows.length, 1);
		assert.equal(tail.droppedLines, 1);
		await tail.finish();
		assert.deepEqual(tail.rows.map(r => r.at), [1, 2]);
		await tail.finish();
		assert.equal(tail.rows.length, 2);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('death during entity sampling is skipped only with authoritative death evidence, then sampling resumes', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-death-journal-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const observer = new Observer(directory, { protocolAudit: '', providerTurns: '' }, {}, {});
	observer.agent = 'player'; observer.agentId = 'a'; observer.startedAt = 100;
	observer.trace = observer.provider = { poll: async () => [] };
	const rows = [{ type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 100 } }];
	let polls = 0;
	observer.protocol = { rows, poll: async () => {
		if (++polls === 2) rows.push({ type: 'goal_control', agentId: 'a', payload: { operation: 'dead', death: { diedAtEpochMs: 200 } } });
		return [];
	} };
	observer.rcon = { command: async () => ({ text: 'No entity was found' }) };
	await observer.poll();
	assert.equal(observer.playerInactive, true); assert.equal(observer.errors.length, 0); assert.equal(observer.samples.length, 0);
	const respawn = { type: 'goal_control', agentId: 'a', payload: { operation: 'respawn', updatedAtEpochMs: 300 } };
	rows.push(respawn); observer.protocol.poll = async () => [respawn]; observer.nextSample = 0;
	observer.rcon = { command: async command => ({ text: command.startsWith('data get') ? '{Pos: [0d, 64d, 0d], Health: 20f}' : command.startsWith('scoreboard') ? 'player has 0 [qo_death]' : 'The time is 1' }) };
	await observer.poll();
	assert.equal(observer.playerInactive, false); assert.equal(observer.samples.length, 1);
	assert.equal(JSON.parse((await readFile(path.join(directory, 'quality-samples.jsonl'), 'utf8')).trim()).health, 20);
	rows.splice(1); observer.protocol.poll = async () => []; observer.nextSample = 0;
	observer.rcon = { command: async () => ({ text: 'No entity was found' }) };
	await assert.rejects(observer.poll(), /disappeared during sampling/);
});

test('observer isolates target read failures and still handles later protocol rows', async () => {
	const rows = [
		{ type: 'action_command', payload: { actionId: 'bad', actionType: 'fight_target', arguments: { targetId: '00000000-0000-0000-0000-000000000001' } } },
		{ type: 'goal_control', agentId: 'player', payload: { operation: 'start', updatedAtEpochMs: 100 } },
		{ type: 'action_command', payload: { actionId: 'good', actionType: 'fight_target', arguments: { targetId: '00000000-0000-0000-0000-000000000002' } } },
	];
	const observer = new Observer('.', { protocolAudit: '', providerTurns: '' }, {}, {});
	observer.trace = { poll: async () => [] };
	observer.provider = { poll: async () => [] };
	observer.protocol = { rows, poll: async () => rows };
	observer.agent = 'player'; observer.nextSample = Infinity;
	observer.rcon = { command: async command => {
		if (command.includes('000000000001')) throw new Error('target read timeout');
		return { text: '{Pos: [0.0d, 70.0d, 0.0d]}' };
	} };
	await observer.poll();
	assert.equal(observer.startedAt, 100);
	assert.equal(observer.agentId, 'player');
	assert.equal(observer.targets.length, 1);
	assert.equal(observer.targets[0].actionId, 'good');
	assert.match(observer.errors[0], /target read timeout/);
});

test('measurement coverage failures remain incomplete despite measured calls', () => {
	const metrics = { modelCalls: 2, tokenReconciliation: { complete: true }, partialMessagesAccepted: true }, samples = [{}, {}];
	assert.equal(measurementStatus(metrics, samples), 'MEASURED');
	assert.equal(measurementStatus(metrics, samples, ['read timeout']), 'INCOMPLETE');
	assert.equal(measurementStatus(metrics, samples, [], 1), 'INCOMPLETE');
	assert.equal(measurementStatus({ modelCalls: 0 }, []), 'UNAVAILABLE');
});

test('live and re-extraction share the first completion boundary before stop', () => {
	const rows = [
		{ envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 100 } } },
		{ envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'complete' } }, timestamp: 200 },
		{ envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'stop', updatedAtEpochMs: 300 } } },
	];
	const live = resolveGoalWindow(rows);
	const replay = resolveGoalWindow(rows, { startedAt: live.startedAt, endedAt: live.endedAt });
	assert.equal(live.startedAt, 100);
	assert.equal(live.endedAt, 200);
	assert.equal(live.goalCompleted, true);
	assert.deepEqual(replay, live);
});
test('threat fixture freezes before construction and observer releases only after goal start', async () => {
	const { applyQualitySetup } = await import('../src/benchmark/quality-scenarios.mjs');
	const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-release-'));
	const commands = [];
	try {
		const setup = await applyQualitySetup({ dimension: 'minecraft:overworld', position: [0, 100, 0], commands: [], freezeUntilGoalStart: true }, async command => {
			commands.push(command); return { text: 'ok' };
		}, 'player');
		assert.equal(commands[0], 'tick freeze');
		assert.ok(commands.includes('gamemode survival player'));
		assert.ok(!commands.includes('tick unfreeze'));
		const observer = new Observer(directory, { protocolAudit: '', providerTurns: '' }, {}, {});
		observer.agent = 'player'; observer.setup = setup;
		observer.trace = observer.provider = { poll: async () => [] };
		observer.protocol = { rows: [], poll: async () => observer.protocol.rows };
		observer.capturePlan = async () => {};
		observer.rcon = { command: async command => {
			commands.push(command);
			return { text: command === 'tick unfreeze' ? 'The game is running normally' : '{Health: 20.0f, Pos: [0.0d, 100.0d, 0.0d]}' };
		} };
		await observer.poll();
		assert.equal(commands.filter(c => c === 'tick unfreeze').length, 0);
		observer.protocol.rows.push({ type: 'goal_control', agentId: 'player', payload: { operation: 'start', updatedAtEpochMs: 100 } });
		await observer.poll(); await observer.poll();
		assert.equal(commands.filter(c => c === 'tick unfreeze').length, 1);
		assert.ok(observer.setup.releasedAt);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('observer stops querying a dead player until respawn', async () => {
	const observer = new Observer('.', { protocolAudit: '', providerTurns: '' }, {}, {});
	observer.agent = 'player'; observer.startedAt = 100;
	observer.trace = observer.provider = { poll: async () => [] };
	observer.protocol = { rows: [{ type: 'goal_control', payload: { operation: 'dead' } }], poll: async () => observer.protocol.rows };
	observer.rcon = { command: async () => { throw new Error('should not read dead player'); } };
	await observer.poll();
	assert.equal(observer.playerInactive, true);
	assert.equal(observer.samples.length, 0);
	assert.equal(observer.errors.length, 0);
});
test('re-extraction updates goal completion, price provenance and terminal sampling window', async () => {
	const { reextractReport } = await import('../../scripts/quality/reextract-scenarios.mjs');
	const { mkdir, readFile } = await import('node:fs/promises');
	const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-reextract-'));
	try {
		await mkdir(path.join(directory, 'workspace/player-memory'), { recursive: true });
		const fixture = name => path.join(directory, name);
		const scenario = { id: 'S1', setup: { dimension: 'minecraft:overworld', inventory: [] } };
		const rows = [{ type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 1000 } }, { type: 'goal_control', agentId: 'a', payload: { operation: 'complete' }, at: 2000 }, { type: 'goal_control', agentId: 'a', payload: { operation: 'stop', updatedAtEpochMs: 3000 } }];
		await writeFile(fixture('manifest.json'), JSON.stringify({ providerWorkspace: path.join(directory, 'workspace') }));
		await writeFile(fixture('quality-samples.json'), JSON.stringify({ samples: [1000,1500,2500].map(at => ({ at, position: { x: 0, y: 0, z: 0 }, health: 20 })), targets: [] }));
		await writeFile(fixture('protocol.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
		await writeFile(fixture('coordinator.jsonl'), [{ event: 'native_model_call', agentId: 'a', goalRevision: 1, at: 1500, totalMs: 1, inputTokens: 1, outputTokens: 1, partialMessagesAccepted: true }, { event: 'native_token_usage', scope: 'thread_total', agentId: 'a', goalRevision: 1, inputTokens: 1, outputTokens: 1 }].map(r => JSON.stringify(r)).join('\n'));
		await writeFile(fixture('results.json'), JSON.stringify({ coordinatorSha256: 'original', method: { rates: { old: true } }, runs: [{ scenario: 'S1', repetition: 1, artifacts: directory, profile: { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority' }, definition: scenario, metrics: { firstTurnUnderstanding: { initialPlan: null } }, observerErrors: ['RCON client is closed'], measurementStatus: 'INCOMPLETE' }] }));
		const report = await reextractReport(fixture('results.json'));
		assert.equal(report.runs[0].metrics.playWallTimeMs, 1000);
		assert.equal(report.runs[0].metrics.coverage.serverSamples, 2);
		assert.equal(report.runs[0].goalCompleted, true);
		assert.equal(report.runs[0].measurementStatus, 'MEASURED');
		assert.deepEqual(report.runs[0].observerErrors, ['RCON client is closed']);
		assert.equal(report.runs[0].terminalObserverErrors.length, 1);
		assert.equal(report.coordinatorSha256, 'original');
		assert.equal(report.reextraction.sourceCoordinatorSha256, 'original');
		assert.equal(report.reextraction.extractorSha256, report.metricsExtractorSha256);
		assert.equal(report.method.rates['claude:claude-opus-5-5'].input, 2);
		assert.ok((await readFile(fixture('S1-r1-timeline.txt'), 'utf8')).includes('S1 MEASURED'));
		await writeFile(fixture('protocol.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\nmalformed');
		const incomplete = await reextractReport(fixture('results.json'));
		assert.equal(incomplete.runs[0].measurementStatus, 'INCOMPLETE');
	} finally { await rm(directory, { recursive: true, force: true }); }
});test('sampling shutdown race refreshes authoritative terminal evidence and retains closure diagnostics', async () => {
	const observer = new Observer('.', { protocolAudit: '', providerTurns: '' }, {}, {});
	observer.agent = 'player'; observer.startedAt = 100;
	observer.trace = observer.provider = { poll: async () => [] };
	const rows = [{ type: 'goal_control', agentId: 'player', payload: { operation: 'start', updatedAtEpochMs: 100 } }];
	observer.protocol = { rows, poll: async () => rows };
	observer.rcon = { command: async () => {
		rows.push({ direction: 'server_to_coordinator', type: 'goal_control', agentId: 'player', payload: { operation: 'complete', updatedAtEpochMs: 200 } });
		throw Object.assign(new Error('RCON client is closed'), { code: 'RCON_CLOSED' });
	} };
	await observer.poll();
	assert.equal(observer.endedAt, 200); assert.equal(observer.terminalObserverErrors.length, 1);
	assert.equal(observer.errors.length, 0); assert.equal(observer.samples.length, 0);
});
test('nonterminal RCON closure remains a coverage failure', async () => {
	const observer = new Observer('.', { protocolAudit: '', providerTurns: '' }, {}, {});
	observer.agent = 'player'; observer.startedAt = 100;
	observer.trace = observer.provider = { poll: async () => [] };
	observer.protocol = { rows: [], poll: async () => [] };
	observer.rcon = { command: async () => { throw Object.assign(new Error('RCON client is closed'), { code: 'RCON_CLOSED' }); } };
	await assert.rejects(observer.poll(), /closed/);
	assert.equal(observer.terminalObserverErrors.length, 0);
});

test('a timed-out observer stream is replaced before the next read-only sample', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-rcon-reconnect-'));
	try {
		await writeFile(path.join(directory, 'rcon-password.txt'), 'synthetic');
		const commands = []; let connections = 0;
		const observer = new Observer(directory, { protocolAudit: '', providerTurns: '', ports: { rcon: 25575 } }, { sampledAdvancements: [] }, {}, {
			rconFactory: options => {
				assert.equal(options.port, 25575); assert.equal(options.password, 'synthetic');
				return { connect: async () => { connections++; }, close: async () => {}, command: async text => {
					commands.push(text);
					return { text: text.startsWith('data get') ? '{Pos: [0d, 64d, 0d], Health: 20f}' : text.startsWith('scoreboard') ? 'player has 0 [qo_death]' : 'The time is 1' };
				} };
			},
		});
		observer.agent = 'player'; observer.startedAt = 100;
		observer.trace = observer.provider = { poll: async () => [] };
		observer.protocol = { rows: [], poll: async () => [] };
		observer.rcon = { state: 'authenticated', command: async () => {
			observer.rcon.state = 'closed';
			throw Object.assign(new Error('RCON command timed out'), { code: 'RCON_TIMEOUT' });
		} };
		await assert.rejects(observer.poll(), /timed out/);
		observer.nextSample = 0;
		await observer.poll();
		assert.equal(connections, 1); assert.equal(observer.samples.length, 1);
		assert.ok(commands.every(text => /^(data get|time query|scoreboard players get) /.test(text)));
		observer.playerInactive = true; observer.rcon.state = 'closed'; observer.nextSample = 0;
		await observer.poll();
		assert.equal(connections, 1, 'a dead player must not cause a reconnect');
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('finish keeps a missing runner report as NO_REPORT but records unreadable or tampered artifact reports', async () => {
	const s7 = JSON.parse(await readFile(new URL('../../scripts/quality/scenarios.json', import.meta.url))).scenarios.find(s => s.id === 'S7');
	const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-finish-'));
	try {
		const finish = async () => {
			const observer = new Observer(directory, { protocolAudit: '', providerTurns: '', providerWorkspace: directory }, s7, { provider: 'claude', model: 'fixture', reasoningEffort: 'low', serviceTier: 'priority' });
			observer.trace = observer.protocol = observer.provider = { rows: [], droppedLines: 0, finish: async () => {} };
			observer.capturePlan = async () => {};
			return observer.finish();
		};
		const missing = await finish();
		assert.equal(missing.termination, 'NO_REPORT'); assert.deepEqual(missing.observerErrors, []);
		const summary = await writeArtifactReport(path.join(directory, 'report.json'), { status: 'PASSED', classification: 'PASSED', calls: Array.from({ length: 200 }, (_, i) => ({ i, text: 'x'.repeat(40) })) });
		assert.equal((await finish()).termination, 'PASSED');
		await writeFile(path.join(directory, summary.calls.reportArtifact.path), '[]');
		const tampered = await finish();
		assert.equal(tampered.termination, 'NO_REPORT'); assert.equal(tampered.measurementStatus, 'INCOMPLETE');
		assert.match(tampered.observerErrors[0], /Runner report unreadable: Report artifact integrity mismatch/);
		await rm(path.join(directory, summary.calls.reportArtifact.path));
		assert.match((await finish()).observerErrors[0], /Runner report unreadable: ENOENT/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('a sampler gap is recorded and logged: a dead player pauses it, anything else is a stall error', () => {
	const observer = new Observer('/tmp/none', { scenarioId: 'S', protocolAudit: '', providerTurns: '' }, {}, {});
	observer.startedAt = 0; observer.lastSampleAt = 1000;
	observer.watchSampler(1000 + SAMPLER_GAP_MS);
	assert.equal(observer.samplingGaps.length, 0);
	observer.playerInactive = true;
	observer.watchSampler(2000 + SAMPLER_GAP_MS);
	assert.deepEqual(observer.samplingGaps, [{ from: 1000, to: null, reason: 'player dead' }]);
	assert.equal(observer.errors.length, 0);
	observer.playerInactive = false;
	observer.watchSampler(60000);
	assert.equal(observer.samplingGaps[0].to, 60000, 'a respawn ends the pause');
	observer.watchSampler(60000 + SAMPLER_GAP_MS + 1);
	assert.deepEqual(observer.samplingGaps[1], { from: 60000, to: null, reason: 'no successful sample' });
	assert.match(observer.errors[0], /^Sampler stalled/);
	observer.lastSampleAt = 75000;
	observer.watchSampler(75100);
	assert.equal(observer.samplingGaps[1].to, 75000);
});

test('a hung observer poll is reported within the limit and never started twice', async () => {
	let calls = 0, release;
	const observer = { poll: () => { calls++; return new Promise(resolve => { release = resolve; }); } };
	await assert.rejects(pollWithin(observer, 20), /still running after/);
	await assert.rejects(pollWithin(observer, 20), /still running after/);
	assert.equal(calls, 1);
	release();
	await pollWithin(observer, 20);
	assert.equal(observer.pendingPoll, null);
	await pollWithin({ poll: async () => {} }, 20);
});
