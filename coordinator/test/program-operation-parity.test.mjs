import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const record = { agentId: 'contract', provider: 'codex', model: 'test', reasoningEffort: 'high', goalRevision: 1 };
const prefix = 'program.onUnhandledAttention("continue_and_notify");';
const source = `${prefix} await player.wait(1000); await player.wait(2);`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const observation = health => ({ player: { x: 0, y: 64, z: 0, health }, entities: [], items: [], blocks: [], inventory: { items: [], tagCounts: {} } });
const actionStates = ['idle', 'PREPARING', 'RUNNING', 'blocking', 'interrupted', 'CANCELLING', 'CANCELLATION_UNCONFIRMED', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const programStates = ['idle', 'PREPARING', 'ACTIVE', 'ordinary', 'urgent', 'quiet', 'folded', 'unseen-danger', 'SUSPENDING', 'SUSPENDED', 'failure', 'CANCELLING', 'pause-stopping', 'finish-stopping', 'deadline-stopping', 'UNKNOWN', 'YIELDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const operations = ['actionStatus', 'cancelAction', 'replaceAction', 'programStatus', 'cancelProgram', 'continue', 'replace', 'pause', 'finish'];
const endedStates = new Set(['UNKNOWN', 'YIELDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
const terminalStates = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

function harness(t, { realTimers = false, preparingProgram = false, preparingAction = false } = {}) {
	if (!realTimers) t.mock.timers.enable({ apis: ['setTimeout'] });
	const sent = [], pending = [];
	let current = observation(20), callId = 0, releaseJournal, uncertainDispatch = false, holdJournal = false;
	const journal = new Promise(resolve => { releaseJournal = resolve; });
	const runtime = new NativeToolRuntime({ sessionId: 'operation-contract',
		bridge: { send: async (type, _agentId, payload) => {
			sent.push({ type, payload });
			if (uncertainDispatch && type === 'action_command') throw Object.assign(new Error('dispatch uncertain'), { code: 'TEST_DISPATCH_UNKNOWN' });
		} },
		programExecutor: new NativeProgramExecutor(),
		requestObservation: async (_record, { afterEventSequence }) => ({ observation: current, eventSequence: afterEventSequence + 1 }),
		inspectObservation: async () => new Promise(() => {}),
		...(preparingProgram ? { memoryOperation: async () => new Promise(() => {}) } : {}),
		...(preparingAction ? { notebook: { writeNote() {}, query() {}, recordReceipt() {}, recordDispatch: () => holdJournal ? journal : undefined } } : {}),
	});
	current.world = { worldId: 'contract-world', dimension: 'minecraft:overworld' };
	runtime.updateObservation(record, current, { eventSequence: 1 });
	const call = (name, args = {}) => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'turn', callId: String(++callId), tool: normalizeMinecraftToolCall(name, args) }, record);
	const track = promise => { pending.push(promise.catch(() => {})); return promise; };
	const commands = () => sent.filter(entry => entry.type === 'action_command');
	const finish = (state = 'SUCCEEDED') => {
		const command = commands().at(-1);
		if (command) runtime.onActionResult(record, { actionId: command.payload.actionId, goalRevision: 1, state, reasonCode: state });
	};
	const publish = (health, eventSequence, options = {}) => {
		current = { ...current, ...observation(health) };
		runtime.updateObservation(record, current, { eventSequence, ...options });
	};
	t.after(async () => { releaseJournal(); runtime.disposeAll(); await Promise.all(pending); });
	return { runtime, call, track, commands, sent, finish, publish, releaseJournal, uncertain: () => { uncertainDispatch = true; },
		preparing: () => { holdJournal = true; },
		advance: async ms => { t.mock.timers.tick(ms); await tick(); },
	};
}

// Only reachable combinations: active programs own their body; suspended programs can lend it to a model-authored fight/flee.
function reachable(program, action) {
	if (program === 'idle' || endedStates.has(program)) return true;
	if (program === 'PREPARING') return action === 'idle';
	if (program === 'SUSPENDED' || program === 'failure') return true;
	if (program === 'SUSPENDING' || program === 'CANCELLING' || program.endsWith('-stopping')) return action === 'CANCELLING';
	return ['idle', 'PREPARING', 'RUNNING'].includes(action);
}

async function prepare(t, program, action) {
	const h = harness(t, { preparingProgram: program === 'PREPARING', preparingAction: action === 'PREPARING' });
	if (program !== 'idle') {
		const active = ['ACTIVE', 'ordinary', 'urgent', 'quiet', 'folded', 'unseen-danger'].includes(program);
		if (active && action === 'PREPARING') h.preparing();
		const paused = ['SUSPENDING', 'SUSPENDED', 'failure'].includes(program);
		await h.call('runProgram', { background: true, ...(program === 'PREPARING' ? { noteKey: 'pending' } : {
			source: program === 'FAILED' ? 'invalid syntax' : program === 'failure' ? `${prefix} for (let i = 0; i < 3; i++) await player.wait(1000);`
				: paused ? 'program.onUnhandledAttention("pause_and_notify"); await player.wait(1000); await player.wait(2);'
				: active && action === 'idle' ? `${prefix} await world.inspect({section:"menu"}); await player.wait(2);` : source,
		}) });
		await tick();
		if (['ordinary', 'urgent', 'quiet', 'folded', 'unseen-danger', 'SUSPENDING', 'SUSPENDED', 'pause-stopping', 'finish-stopping'].includes(program)) {
			h.publish(12, 10, { attention: true, priority: program === 'ordinary' ? 'ordinary' : 'urgent', trigger: 'damage' });
			await tick();
		}
		if (program === 'quiet') h.publish(12, 11);
		if (program === 'unseen-danger') h.publish(4, 11);
		if (program === 'folded') h.publish(12, 11, { attention: true, priority: 'ordinary', trigger: 'resource_discovery' });
		if (program === 'failure') { h.finish('TIMED_OUT'); await tick(); h.finish('TIMED_OUT'); await tick(); }
		if (program === 'SUSPENDED') { h.finish('CANCELLED'); await tick(); }
		if (['CANCELLING', 'UNKNOWN', 'CANCELLED'].includes(program)) {
			const status = await h.call('programStatus');
			h.track(h.call('cancelProgram', { programId: status.programId, goalRevision: 1 })); await tick();
			if (program === 'UNKNOWN') { await h.advance(5000); if (action !== 'CANCELLING') await h.advance(5000); }
			if (program === 'CANCELLED') { h.finish('CANCELLED'); await tick(); }
		}
		if (program === 'pause-stopping' || program === 'finish-stopping') {
			const status = await h.call('programStatus');
			h.track(h.call('respondProgram', { programId: status.programId, goalRevision: 1, decisionId: status.decision.decisionId, eventSequence: status.decision.eventSequence, directive: program.split('-')[0] })); await tick();
		}
		if (program === 'deadline-stopping' || program === 'TIMED_OUT') { await h.advance(30000); if (program === 'TIMED_OUT') { h.finish('CANCELLED'); await tick(); } }
		if (program === 'YIELDED') { h.finish(); await tick(); h.finish(); await tick(); }
		if (endedStates.has(program)) {
			assert.equal((await h.call('programStatus')).state, program);
			// The uncertain end keeps its body until an authoritative receipt arrives.
			if (program === 'UNKNOWN' && !['CANCELLING', 'CANCELLATION_UNCONFIRMED'].includes(action)) { h.finish('CANCELLED'); await tick(); }
		}
	}
	const independentAction = program === 'idle' || (endedStates.has(program) && !(program === 'UNKNOWN' && ['CANCELLING', 'CANCELLATION_UNCONFIRMED'].includes(action))) || ['SUSPENDED', 'failure'].includes(program);
	if (independentAction && action !== 'idle') {
		if (action === 'PREPARING') h.preparing();
		if (action === 'UNKNOWN') h.uncertain();
		if (action === 'blocking' || action === 'interrupted') h.track(h.call('act', { actionType: 'fight_target', arguments: { targetId: '00000000-0000-0000-0000-000000000001', timeoutMs: 15000 } }));
		else h.track(h.call('startAction', { actionType: 'fight_target', arguments: { targetId: '00000000-0000-0000-0000-000000000001', timeoutMs: 15000 } }));
		await tick();
		if (action === 'interrupted') { h.runtime.interruptBlockingTool(record.agentId); await tick(); }
		if (terminalStates.has(action)) { h.finish(action); await tick(); }
		if (action === 'CANCELLING' || action === 'CANCELLATION_UNCONFIRMED') {
			const status = await h.call('actionStatus');
			h.track(h.call('cancelAction', { actionId: status.actionId, goalRevision: 1 })); await tick();
			if (action === 'CANCELLATION_UNCONFIRMED') await h.advance(10000);
		}
	}
	return h;
}

test('offered equals accepted for every reachable program state x action state x recovery operation', async t => {
	let probes = 0;
	let terminalReplacements = 0;
	for (const program of programStates) for (const action of actionStates) {
		if (!reachable(program, action)) continue;
		for (const operation of operations) await t.test(`${program} / ${action} / ${operation}`, async t => {
			const h = await prepare(t, program, action);
			const known = await h.call('actionStatus');
			const actionId = known.actionId ?? known.lastResult?.actionId ?? 'not-current';
			const rejected = await h.call('cancelAction', { actionId, goalRevision: 999 }).catch(error => error);
			assert.equal(rejected.code, 'STALE_ACTION');
			const current = rejected.current;
			assert.ok(current, 'the rejection supplies the same presenter used by all handle failures');
			if (terminalStates.has(action)) {
				assert.equal(current.body, program === 'SUSPENDED' || program === 'failure' ? 'program' : 'free');
				assert.equal(current.action.actionId, actionId);
				assert.equal(current.action.state, action, 'the probe retains the intended terminal receipt');
			}
			if (current.program?.decision) assert.deepEqual((await h.call('programStatus')).decision.directives, current.program.decision.directives, 'status and rejection present the same directives');
			const directive = ['continue', 'replace', 'pause', 'finish'].includes(operation);
			const offered = directive ? (current.program?.decision?.directives ?? []).includes(operation) : (current.next ?? []).includes(operation);
			const args = directive ? { programId: current.program?.programId ?? 'not-current', goalRevision: 1, decisionId: current.program?.decision?.decisionId ?? 'not-current',
				eventSequence: current.program?.decision?.eventSequence, directive: operation, ...(operation === 'replace' ? { source: `${prefix} await player.wait(1);` } : {}) }
				: operation === 'programStatus' ? (current.program ? { programId: current.program.programId } : {})
				: operation === 'actionStatus' ? (current.action ? { actionId: current.action.actionId } : {})
				: operation === 'cancelProgram' ? { programId: current.program?.programId ?? 'not-current', goalRevision: 1 }
				: { actionId: current.action?.actionId ?? 'not-current', goalRevision: 1, ...(operation === 'replaceAction' ? { actionType: 'flee_from', arguments: { targetId: '00000000-0000-0000-0000-000000000001', distance: 8, timeoutMs: 15000 } } : {}) };
			let outcome;
			const pending = h.call(directive ? 'respondProgram' : operation, args).then(value => { outcome = { accepted: true, value }; }, error => { outcome = { accepted: false, error }; });
			await tick();
			for (let i = 0; !outcome && i < 5; i++) { h.releaseJournal(); h.finish('CANCELLED'); await tick(); }
			assert.ok(outcome, 'accepted operations settle when their authored body receives its receipt');
			await pending;
			assert.equal(outcome.accepted, offered, `offered=${offered}, rejection=${outcome.error?.code ?? 'none'}`);
			if (terminalStates.has(action) && operation === 'replaceAction') {
				assert.equal(offered, true, 'terminal replacement must be offered');
				assert.equal(outcome.accepted, true, 'terminal replacement must succeed with the known handle');
				assert.equal(outcome.value.state, 'RUNNING');
				assert.equal(h.commands().at(-1).payload.actionType, 'flee_from');
				terminalReplacements++;
			}
			probes++;
		});
	}
	assert.equal(probes, 1080);
	assert.equal(terminalReplacements, 32, 'all terminal replacement combinations accepted');
});

async function borrowedActionAfterProgramEnd(t, ending) {
	const h = await prepare(t, 'SUSPENDED', 'idle');
	const fight = h.call('act', { actionType: 'fight_target', arguments: { targetId: '00000000-0000-0000-0000-000000000001', timeoutMs: 15000 } });
	h.track(fight);
	await tick();
	h.runtime.interruptBlockingTool(record.agentId);
	const interrupted = await fight;
	assert.equal(interrupted.state, 'RUNNING');
	assert.equal(interrupted.interruptedBy, 'danger');
	const status = await h.call('programStatus');
	assert.equal(status.engineState, 'SUSPENDED');
	if (ending === 'cancel') await h.call('cancelProgram', { programId: status.programId, goalRevision: 1 });
	else if (ending === 'deadline') await h.runtime.expireProgram(record, status.programId);
	else await h.call('respondProgram', { programId: status.programId, goalRevision: 1,
		decisionId: status.decision.decisionId, eventSequence: status.decision.eventSequence, directive: ending });
	const ended = await h.call('programStatus');
	assert.equal(ended.state, ending === 'deadline' ? 'TIMED_OUT' : ending === 'cancel' ? 'CANCELLED' : 'YIELDED');
	assert.equal((await h.call('actionStatus')).actionId, interrupted.actionId, 'the original borrowed fight survives');
	assert.equal((await h.call('actionStatus')).state, 'RUNNING');
	assert.equal(h.commands().length, 2, 'ending the program dispatches no body action');
	return { h, actionId: interrupted.actionId };
}

for (const ending of ['pause', 'finish', 'cancel', 'deadline']) for (const route of ['replaceAction', 'act']) {
	for (const receipt of terminalStates) test(`${route} replaces the original borrowed fight after ${ending}, with ${receipt} receipt`, async t => {
		const { h, actionId } = await borrowedActionAfterProgramEnd(t, ending);
		const rejected = await h.call('cancelAction', { actionId: 'not-current', goalRevision: 1 }).catch(error => error);
		assert.equal(rejected.code, 'STALE_ACTION');
		assert.equal(rejected.current.body, 'action');
		assert.equal(rejected.current.action.actionId, actionId);
		assert.ok(rejected.current.next.includes('replaceAction'));
		let outcome;
		const replacement = h.call(route, { ...(route === 'replaceAction' ? { actionId, goalRevision: 1 } : {}),
			actionType: 'flee_from', arguments: { targetId: '00000000-0000-0000-0000-000000000001', distance: 8, timeoutMs: 15000 } })
			.then(value => { outcome = { value }; }, error => { outcome = { error }; });
		await tick();
		assert.equal(outcome, undefined, 'replacement waits for the cancellation receipt');
		assert.equal(h.commands().length, 2, 'no flee before the authoritative receipt');
		assert.equal(h.sent.filter(entry => entry.type === 'action_cancel').at(-1).payload.actionId, actionId);
		h.finish(receipt);
		await tick();
		assert.equal(outcome?.error, undefined, 'the accepted replacement retains lifecycle authority');
		assert.equal(h.commands().length, 3, 'the model-authored flee starts after the receipt');
		assert.equal(h.commands().at(-1).payload.actionType, 'flee_from');
		h.finish('SUCCEEDED');
		await replacement;
		assert.equal(outcome.value.state, 'SUCCEEDED');
	});
}

for (const ending of ['pause', 'finish', 'cancel', 'deadline']) {
	test(`replacement after ${ending} keeps the borrowed body held without a receipt`, async t => {
		const { h, actionId } = await borrowedActionAfterProgramEnd(t, ending);
		const replacement = h.call('replaceAction', { actionId, goalRevision: 1, actionType: 'flee_from',
			arguments: { targetId: '00000000-0000-0000-0000-000000000001', distance: 8, timeoutMs: 15000 } });
		const refused = assert.rejects(replacement, { code: 'CANCEL_ACK_TIMEOUT' });
		await tick();
		await h.advance(10000);
		await refused;
		assert.equal((await h.call('actionStatus', { actionId })).state, 'CANCELLATION_UNCONFIRMED');
		assert.equal(h.commands().length, 2, 'no authored replacement without authoritative body release');
	});

	test(`replacement after ${ending} cannot survive lifecycle disposal while cancelling`, async t => {
		const { h, actionId } = await borrowedActionAfterProgramEnd(t, ending);
		const replacement = h.call('replaceAction', { actionId, goalRevision: 1, actionType: 'flee_from',
			arguments: { targetId: '00000000-0000-0000-0000-000000000001', distance: 8, timeoutMs: 15000 } });
		const refused = assert.rejects(replacement, { code: 'NATIVE_ACTION_CANCELLED' });
		await tick();
		await h.runtime.dispose(record.agentId, 'goal_respawn');
		h.finish('CANCELLED');
		await refused;
		assert.equal(h.commands().length, 2, 'a late receipt cannot revive disposed replacement authority');
	});
}

for (const paused of [false, true]) test(`latest ${paused ? 'paused' : 'active'} decision accepts replacement after harmless observations`, async t => {
	const h = harness(t);
	await h.call('runProgram', { background: true, source: paused ? source.replace('continue_and_notify', 'pause_and_notify') : source });
	await tick(); h.publish(12, 10, { attention: true, priority: 'urgent', trigger: 'damage' }); await tick();
	if (paused) { h.finish('CANCELLED'); await tick(); }
	h.publish(12, 11);
	const status = await h.call('programStatus');
	assert.ok(status.decision.directives.includes('replace'));
	const replacement = h.call('respondProgram', { programId: status.programId, goalRevision: 1, decisionId: status.decision.decisionId, eventSequence: status.decision.eventSequence, directive: 'replace', source: `${prefix} await player.wait(1);` });
	await tick();
	if (!paused) h.finish('CANCELLED');
	await replacement; await tick();
	assert.equal(h.commands().length, 2, 'only the model-authored replacement adds a body command');
});

test('UNKNOWN program end exposes its held action at both real cancellation deadlines', { timeout: 20000 }, async t => {
	const h = harness(t, { realTimers: true });
	// Real deadlines use unref'd timers; keep the loop alive so the runner does not cancel the pending wait on fast hosts.
	const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
	const program = await h.call('runProgram', { background: true, source }); await tick();
	const actionId = h.commands()[0].payload.actionId;
	const ended = await h.call('cancelProgram', { programId: program.programId, goalRevision: 1 });
	assert.equal(ended.state, 'UNKNOWN'); assert.equal(ended.reasonCode, 'PROGRAM_CANCEL_ACK_TIMEOUT');
	const refused = () => h.call('moveTo', { x: 1, y: 64, z: 0, timeoutMs: 100 }).catch(error => error);
	const first = await refused();
	assert.equal(first.code, 'NATIVE_ACTION_IN_PROGRESS'); assert.equal(first.current.body, 'action');
	assert.equal(first.current.action.actionId, actionId); assert.equal(first.current.action.state, 'CANCELLING');
	assert.deepEqual(first.current.next, ['actionStatus', 'programStatus']);
	await new Promise(resolve => setTimeout(resolve, 5100));
	const second = await refused();
	assert.equal(second.current.body, 'action'); assert.equal(second.current.action.state, 'CANCELLATION_UNCONFIRMED');
	assert.deepEqual(second.current.next, ['actionStatus', 'cancelAction', 'replaceAction', 'programStatus']);
	const retry = h.call('cancelAction', { actionId, goalRevision: 1 }); await tick(); h.finish('CANCELLED');
	assert.equal((await retry).state, 'CANCELLED'); assert.equal(h.commands().length, 1);
});
