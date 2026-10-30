import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FAILURE_CODES } from '../src/failure-codes.mjs';
import { failureChange, failureFacts, presentFailures, toolErrorResult, validWhenFor, withFailureSchema } from '../src/failure-schema.mjs';
import { NATIVE_AGENT_INSTRUCTIONS, toolResultContent } from '../src/native-minecraft-tools.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { ModelObservationViews, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { producedJavaCodes, producedJavaScriptCodes, producedResultCodes } from './helpers/failure-code-sources.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, start, factToWireObservation } from './fixtures/dynamic-main-fixture.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATEGORIES = new Set(['cell', 'sight', 'reach', 'item', 'entity', 'body', 'menu', 'threat', 'rule', 'handle']);

test('every result code a Java or coordinator producer can emit is catalogued', () => {
	const produced = producedResultCodes(repositoryRoot);
	assert.ok(produced.size > 500, `scanner found ${produced.size} codes`);
	const missing = [...produced].filter(([code]) => !Object.hasOwn(FAILURE_CODES, code)).map(([code, sites]) => `${code} (${sites[0]})`);
	assert.deepEqual(missing, [], 'add each new code to src/failure-codes.mjs with its validity condition');
});

test('the coordinator scanner admits property, assignment and default-parameter producers in either quote style', () => {
	const produced = producedJavaScriptCodes([
		"const result = { reasonCode: 'PROPERTY_SINGLE', code: \"PROPERTY_DOUBLE\" };",
		"error.code = 'ASSIGNED_CODE';",
		'result.reasonCode = "ASSIGNED_REASON";',
		"function fail({ reasonCode = 'DEFAULT_REASON' } = {}) {}",
		"throw codedError('HELPER_CODE', 'message');",
		"if (error.code === 'COMPARED_CODE') return;",
		"const label = 'UNRELATED_LITERAL';",
		"const handler = (code) => code;",
	].join('\n'));
	assert.deepEqual([...produced].sort(), ['ASSIGNED_CODE', 'ASSIGNED_REASON', 'DEFAULT_REASON', 'HELPER_CODE', 'PROPERTY_DOUBLE', 'PROPERTY_SINGLE']);
});

test('Java receipt-code comparisons are consumers while returned and failed codes remain producers', () => {
	const produced = producedJavaCodes([
		'if (step.reasonCode().equals("READ_ONLY_CODE")) { clearingAt = null; return TickResult.running(progress()); }',
		'if (step.reasonCode( ).equals("SPACED_READ")) { return; }',
		'return finish(player, "SHELTER_BLOCKED", "obstruction", false);',
		'throw new AgentDomainException("EMITTED_CODE", "failure");',
	].join('\n'));
	assert.deepEqual([...produced].sort(), ['EMITTED_CODE', 'SHELTER_BLOCKED']);
});

test('successful replacement retirement is not presented as a failure', () => {
	const receipt = { actionId: 'old-action', state: 'CANCELLED', reasonCode: 'ACTION_REPLACED' };
	assert.equal(withFailureSchema(receipt), receipt);
	assert.deepEqual(FAILURE_CODES.ACTION_REPLACED, ['ok']);
});

test('every catalogued failure carries a blocker and a validity condition, or says why it cannot', () => {
	for (const [code, entry] of Object.entries(FAILURE_CODES)) {
		const [category, text, witnesses] = entry;
		if (category === 'ok') { assert.equal(entry.length, 1, code); continue; }
		const presented = withFailureSchema({ state: 'FAILED', reasonCode: code, message: 'stone at 1,2,3' });
		assert.equal(presented.failure.blockedBy, 'stone at 1,2,3', code);
		if (category === 'internal') {
			assert.ok(typeof text === 'string' && text.length > 0 && text.length <= 50, `${code}: ${text}`);
			assert.equal(presented.failure.validWhen, undefined, code);
			assert.equal(withFailureSchema({ state: 'FAILED', reasonCode: code }).failure.blockedBy, text, `${code} names why no request avoids it`);
			continue;
		}
		assert.ok(CATEGORIES.has(category), `${code}: ${category}`);
		if (text === null) {
			// The model can avoid it, but no single true condition covers every producer: nothing is guessed.
			assert.equal(entry.length, 2, code);
			assert.equal(presented.failure.validWhen, undefined, code);
			continue;
		}
		assert.ok(typeof text === 'string' && text.length > 0 && text.length <= 50, `${code}: ${text}`);
		assert.doesNotMatch(text, /\b(?:try|should|instead|consider)\b/i, `${code} states a condition, not advice`);
		assert.ok(Array.isArray(witnesses) && witnesses.length > 0 && witnesses.every(w => typeof w === 'string' && w.length > 0), `${code} names the check it describes`);
		assert.equal(presented.failure.validWhen, text, code);
	}
});

test('each validity condition is tied to the check at every producer of its code', () => {
	// A witness is a token of the producer's own check, within 12 lines before or 3 after the site. When a producer
	// changes its check or a new producer appears with another check, the condition must be re-derived.
	const files = new Map();
	const lines = (file) => {
		if (!files.has(file)) files.set(file, readFileSync(path.join(repositoryRoot, file), 'utf8').split('\n'));
		return files.get(file);
	};
	const unwitnessed = [];
	for (const [code, sites] of producedResultCodes(repositoryRoot)) {
		const [, condition, witnesses] = FAILURE_CODES[code] ?? [];
		if (!Array.isArray(witnesses)) continue;
		// A bound (reach, count, length, health) is witnessed only by its comparison or the named predicate holding it,
		// so inverting the check while keeping its variable name fails here.
		const bounded = BOUND.test(condition);
		const checks = bounded ? witnesses.filter(witness => /[<>]=?|[A-Za-z]\(/.test(witness)) : witnesses;
		if (checks.length === 0) unwitnessed.push(`${code}: a bounded condition names no comparison`);
		for (const site of sites) {
			const separator = site.lastIndexOf(':');
			const file = site.slice(0, separator), line = Number(site.slice(separator + 1));
			// A constant only names the code; its checks are where producers use the constant.
			const constant = /static final String\s+([A-Z][A-Z0-9_]*)\s*=/.exec(lines(file)[line - 1] ?? '')?.[1];
			const uses = constant === undefined ? [[file, line]] : constantProducers(constant, lines);
			if (constant !== undefined && uses.length === 0) unwitnessed.push(`${code}: constant ${constant} at ${site} has no producer use`);
			// The constant's own name is not evidence of the check that emits it.
			const evidence = checks.filter(witness => witness !== constant && !witness.endsWith(`.${constant}`));
			for (const [useFile, useLine] of uses) {
				const window = lines(useFile).slice(Math.max(0, useLine - 13), useLine + 3).join('\n');
				if (!evidence.some(witness => window.includes(witness))) unwitnessed.push(`${code} at ${useFile}:${useLine}`);
			}
		}
	}
	assert.deepEqual(unwitnessed, [], 're-derive the validity condition from the changed producer check');
});

test('a named range predicate is witnessed only with the polarity that rejects', () => {
	// The Java producer rejects when the target is NOT within reach; the positive predicate must not satisfy the witness.
	const [, , witnesses] = FAILURE_CODES.TARGET_OUT_OF_RANGE;
	const javaSites = producedResultCodes(repositoryRoot).get('TARGET_OUT_OF_RANGE').filter(site => site.includes('.java:'));
	assert.ok(javaSites.length > 0);
	for (const site of javaSites) {
		const separator = site.lastIndexOf(':');
		const line = Number(site.slice(separator + 1));
		const window = readFileSync(path.join(repositoryRoot, site.slice(0, separator)), 'utf8').split('\n').slice(Math.max(0, line - 13), line + 3).join('\n');
		assert.ok(witnesses.some(witness => window.includes(witness)), `${site} is witnessed`);
		const inverted = window.replace(/!\s*agent\.isWithinBlockInteractionRange\(/g, 'agent.isWithinBlockInteractionRange(');
		assert.notEqual(inverted, window, `${site} has a negated reach guard to invert`);
		assert.equal(witnesses.some(witness => inverted.includes(witness)), false, `${site}: an inverted guard must not be witnessed`);
	}
});

const BOUND = /\b(?:or more|at most|at least|within|above|below|under|exceed\w*|budget|cap|limit)\b|<=|>=/i;
const JAVA_ROOT = path.join(repositoryRoot, 'src', 'main', 'java');
const javaFiles = (directory = JAVA_ROOT, found = []) => {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) javaFiles(file, found);
		else if (file.endsWith('.java')) found.push(path.relative(repositoryRoot, file).split(path.sep).join('/'));
	}
	return found;
};

/** Lines that emit a code through its constant; comparisons against the constant only read a finished code. */
function constantProducers(constant, lines) {
	const name = new RegExp(`\\b${constant}\\b`);
	const reads = new RegExp(`\\b${constant}\\s*(?:\\.equals\\(|[!=]=)|[!=]=\\s*(?:\\w+\\.)?${constant}\\b`);
	// A quoted code in presentation copy does not reference the Java constant that emits it.
	return javaFiles().flatMap(file => lines(file).flatMap((text, index) => name.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '')) && !reads.test(text)
		&& !/static final String|^\s*(?:\/\/|\/?\*)/.test(text) ? [[file, index + 1]] : []));
}

test('the model-facing failure replaces message and execution flags instead of repeating them', () => {
	const raw = { state: 'FAILED', reasonCode: 'TARGET_OCCUPIED', message: 'Seen obstruction: minecraft:dirt at 4,64,2', executionStarted: false, physicalAttempted: false, actionId: 'a1' };
	const presented = withFailureSchema(raw);
	assert.deepEqual(presented, { state: 'FAILED', reasonCode: 'TARGET_OCCUPIED', actionId: 'a1', failure: {
		blockedBy: 'Seen obstruction: minecraft:dirt at 4,64,2', ...(validWhenFor('TARGET_OCCUPIED') === null ? {} : { validWhen: validWhenFor('TARGET_OCCUPIED') }) } });
	const before = JSON.stringify(raw).length;
	const after = JSON.stringify(presented).length;
	assert.ok(after - before <= 40 + validWhenFor('TARGET_OCCUPIED').length - 30, `${after - before} bytes added`);
	assert.deepEqual(withFailureSchema(presented), presented, 'idempotent');
	const success = { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', message: 'Block broken' };
	assert.equal(withFailureSchema(success), success);
	const ownCancel = { state: 'CANCELLED', reasonCode: 'MODEL_CANCELLED', message: 'Cancelled by request' };
	assert.equal(withFailureSchema(ownCancel), ownCancel, 'a cancel the model asked for is not a failure');
});

test('nested sequence steps and receipts use the same failure', () => {
	const sequence = presentFailures({ state: 'FAILED', completed: 1, failedAt: 1, results: [
		{ actionType: 'look_at', state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' },
		{ actionType: 'break_block', arguments: { x: 1, y: 2, z: 3 }, state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE', message: 'sight line meets minecraft:stone at 1,3,3', physicalAttempted: false },
	] });
	assert.equal(sequence.results[0].failure, undefined);
	assert.deepEqual(sequence.results[1].failure, { tried: 'break_block 1,2,3', blockedBy: 'sight line meets minecraft:stone at 1,3,3', ...(validWhenFor('TARGET_NOT_VISIBLE') === null ? {} : { validWhen: validWhenFor('TARGET_NOT_VISIBLE') }) });
	const text = JSON.parse(toolResultContent({ state: 'FAILED', reasonCode: 'NO_PATH', message: 'No route' }).contentItems[0].text);
	assert.equal(text.failure.blockedBy, 'No route');
	assert.equal(text.message, undefined);
});

test('changed reports what the body did from the result flags and positions', () => {
	assert.equal(failureChange({ executionStarted: false }), 'nothing');
	assert.equal(failureChange({ executionStarted: true, physicalAttempted: true, from: { x: 0, y: 64, z: 0 }, to: { x: 3, y: 61, z: 4 } }), 'moved 5.8m (dy -3)');
	assert.equal(failureChange({ executionStarted: true, physicalAttempted: true, from: { x: 0, y: 64, z: 0 }, to: { x: 0.1, y: 64, z: 0 } }), 'input applied; no movement');
});

test('stall reports and thrown errors build the same object', () => {
	assert.deepEqual(failureFacts({ code: 'NO_PATH', tried: 'navigate_to 5,64,9', changed: 'moved 40m', blockedBy: 'no progress in the last 3 attempts', repeat: '3rd from this block in 20s' }), {
		tried: 'navigate_to 5,64,9', changed: 'moved 40m', blockedBy: 'no progress in the last 3 attempts', repeat: '3rd from this block in 20s' }, 'a repeat already carried the condition');
	assert.equal(failureFacts({ code: 'TARGET_AIR', blockedBy: 'x' }).validWhen, validWhenFor('TARGET_AIR'), 'a first failure states the condition');
	const result = toolErrorResult(Object.assign(new Error('arguments.x is required'), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' }));
	assert.equal(result.failure.blockedBy, 'arguments.x is required');
	assert.equal(result.failure.changed, undefined);
	assert.equal(result.message, undefined);
});

const record = { agentId: 'agent-a', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'priority', goalRevision: 3, currentGoal: 'explore' };

test('body failures say what changed and repeated tool rejections count like body failures', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	const pending = runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn', callId: 'c1', tool: { kind: 'action', actionType: 'move_to', arguments: { x: 9, y: 64, z: 0, tolerance: 1 } } }, record);
	await new Promise(resolve => setImmediate(resolve));
	runtime.onActionResult(record, { actionId: sent[0].actionId, state: 'TIMED_OUT', reasonCode: 'ACTION_TIMEOUT', message: 'Navigation timed out; destination 6.0m away', executionStarted: true, physicalAttempted: true,
		actionObservation: { position: { x: 3, y: 64, z: 0 }, observedAtEpochMs: 1_000 } });
	const result = await pending;
	assert.equal(result.failure.blockedBy, 'Navigation timed out; destination 6.0m away');
	assert.equal(result.failure.validWhen, validWhenFor('ACTION_TIMEOUT'));
	assert.match(result.failure.changed, /^moved|^input applied/);

	const rejected = [];
	for (const callId of ['r1', 'r2']) {
		await assert.rejects(runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn', callId, tool: { kind: 'cancel_action', actionId: 'native:none', goalRevision: 3 } }, record), (error) => {
			rejected.push(error.failure);
			return true;
		});
	}
	assert.equal(rejected[0].changed, undefined);
	assert.ok(typeof rejected[0].blockedBy === 'string' && rejected[0].blockedBy.length > 0);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const observedAt = (x, ms) => ({ ready: true, observedAtEpochMs: ms, position: { x, y: 64, z: 0 }, player: { position: { x, y: 64, z: 0 }, health: 20 }, inventory: { items: [] } });

test('review r1: movement is measured from where this action started, not an older observation', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	runtime.updateObservation(record, observedAt(0, Date.now()), { eventSequence: 1 });
	const walk = (x, callId) => runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn', callId, tool: { kind: 'action', actionType: 'move_to', arguments: { x: 9, y: 64, z: 0, tolerance: 1 } } }, record);
	const first = walk(9, 'w1');
	await turn();
	runtime.onActionResult(record, { actionId: sent[0].actionId, state: 'SUCCEEDED', reasonCode: 'DESTINATION_REACHED', executionStarted: true, physicalAttempted: true, actionObservation: { position: { x: 5, y: 64, z: 0 }, observedAtEpochMs: Date.now() } });
	await first;
	const second = walk(9, 'w2');
	await turn();
	runtime.onActionResult(record, { actionId: sent[1].actionId, state: 'TIMED_OUT', reasonCode: 'ACTION_TIMEOUT', message: 'destination 3.0m away', executionStarted: true, physicalAttempted: true, actionObservation: { position: { x: 6, y: 64, z: 0 }, observedAtEpochMs: Date.now() } });
	assert.equal((await second).failure.changed, 'moved 1m', 'the second action moved 1m, not 6m from the first observation');
	assert.equal(failureChange({ executionStarted: true, physicalAttempted: true, from: { x: 0, y: 64, z: 0 }, fromAgeMs: 9_000, to: { x: 6, y: 64, z: 0 } }), 'moved 6m since a position seen 9s before it started');
});

test('review r1: a failed sequence step names the request it tried', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	const pending = runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn', callId: 's1', tool: { kind: 'sequence', actions: [
		{ actionType: 'break_block', arguments: { x: 4, y: 65, z: -2, expectedBlockId: 'minecraft:stone', timeoutMs: 15_000 } },
	] } }, record);
	await turn();
	runtime.onActionResult(record, { actionId: sent[0].actionId, state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE', message: 'No part of it is visible within reach from this eye', executionStarted: false, physicalAttempted: false });
	const result = await pending;
	assert.equal(result.results[0].failure.tried, 'break_block 4,65,-2');
	const presented = JSON.parse(toolResultContent(result).contentItems[0].text);
	assert.equal(presented.results[0].failure.tried, 'break_block 4,65,-2');
	assert.equal(presented.results[0].message, undefined);
});

test('review r1: a failure reaches the model once through views, wakes and follow-up facts', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	const pending = runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn', callId: 'a1', tool: { kind: 'start_action', actionType: 'move_to', arguments: { x: 9, y: 64, z: 0, tolerance: 1 } } }, record).catch(() => null);
	await turn();
	runtime.onActionResult(record, { actionId: sent[0].actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route', executionStarted: true, physicalAttempted: false });
	await pending;
	const lastResult = { present: true, actionId: sent[0].actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route' };
	const wake = runtime.decorateObservation(record, { ...observedAt(0, Date.now()), lastResult });
	assert.deepEqual(wake.lastResult, { actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH',
		failure: { blockedBy: 'No seen route', ...(validWhenFor('NO_PATH') === null ? {} : { validWhen: validWhenFor('NO_PATH') }) } });
	const later = runtime.decorateObservation(record, { ...observedAt(0, Date.now()), lastResult });
	assert.deepEqual(later.lastResult, { actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH' }, 'later views keep only the identity');

	const nested = presentFailures({ state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED', postAction: { observation: { lastResult: { present: true, state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route' } } },
		result: { state: 'FAILED', reasonCode: 'PROGRAM_DEADLINE', message: 'Deadline reached', receipts: [{ actionType: 'mine', state: 'FAILED', reasonCode: 'TARGET_AIR', message: 'air', arguments: { x: 1, y: 2, z: 3 } }] } });
	assert.equal(nested.postAction.observation.lastResult.failure.blockedBy, 'No seen route');
	assert.equal(nested.result.failure.blockedBy, 'Deadline reached');
	assert.equal(nested.result.receipts[0].failure.tried, 'mine 1,2,3');
});

test('review r1 replay: a delivered failure stays a bare code and internal reads deliver nothing', async t => {
	const bare = { observation: { lastResult: { actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH' } } };
	assert.deepEqual(presentFailures(bare), bare, 'presentation does not re-inflate a delivered failure');
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	const pending = runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn', callId: 'a2', tool: { kind: 'start_action', actionType: 'move_to', arguments: { x: 9, y: 64, z: 0, tolerance: 1 } } }, record).catch(() => null);
	await turn();
	runtime.onActionResult(record, { actionId: sent[0].actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route', executionStarted: true, physicalAttempted: false });
	await pending;
	const lastResult = { present: true, actionId: sent[0].actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route' };
	const internal = runtime.decorateObservation(record, { ...observedAt(0, Date.now()), lastResult }, { deliver: false });
	assert.equal(internal.lastResult.failure, undefined, 'an internal read changes nothing');
	assert.equal(runtime.decorateObservation(record, { ...observedAt(0, Date.now()), lastResult }).lastResult.failure.blockedBy, 'No seen route', 'the model still receives it later');
});

const startMove = async (runtime, sent, callId) => {
	const pending = runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn', callId, tool: { kind: 'start_action', actionType: 'move_to', arguments: { x: 9, y: 64, z: 0, tolerance: 1 } } }, record);
	await turn();
	await pending;
	return sent.at(-1).actionId;
};

test('review r2: the first wake keeps what a failed async action changed, and an unknown change is never presented as nothing', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	runtime.updateObservation(record, observedAt(0, Date.now()), { eventSequence: 1 });
	const actionId = await startMove(runtime, sent, 'm1');
	runtime.onActionResult(record, { actionId, state: 'TIMED_OUT', reasonCode: 'ACTION_TIMEOUT', message: 'destination 8m away', executionStarted: true, physicalAttempted: true, actionObservation: observedAt(1, Date.now()) });
	const lastResult = { present: true, actionId, actionType: 'move_to', state: 'TIMED_OUT', reasonCode: 'ACTION_TIMEOUT', message: 'destination 8m away' };
	const wake = runtime.decorateObservation(record, { ...observedAt(1, Date.now()), lastResult });
	assert.equal(wake.lastResult.failure.changed, 'moved 1m', 'the wake agrees with the receipt');
	assert.equal(wake.lastResult.failure.tried, undefined, 'the view names the action itself');
	// A result the runtime holds no receipt for (an engine action, a restart) has an unknown change.
	const foreign = runtime.decorateObservation(record, { ...observedAt(1, Date.now()), lastResult: { ...lastResult, actionId: 'engine:7' } });
	assert.equal(foreign.lastResult.failure.changed, 'unknown');
	const flagged = runtime.decorateObservation(record, { ...observedAt(1, Date.now()), lastResult: { ...lastResult, actionId: 'engine:8', executionStarted: false } });
	assert.equal(flagged.lastResult.failure.changed, undefined, 'a result that never started changed nothing');
	assert.match(NATIVE_AGENT_INSTRUCTIONS, /failure\.changed absent=none/, 'the model is told what an absent changed means');
});

test('review r2: a failure reserved for an input stays owed until the provider accepts that input', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	const actionId = await startMove(runtime, sent, 'd1');
	runtime.onActionResult(record, { actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'A concrete blocked route', executionStarted: true, physicalAttempted: false });
	const view = { ...observedAt(0, Date.now()), lastResult: { present: true, actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'A concrete blocked route' } };
	const rejected = {};
	assert.equal(runtime.decorateObservation(record, view, { reservation: rejected }).lastResult.failure.blockedBy, 'A concrete blocked route');
	assert.equal(runtime.decorateObservation(record, view).lastResult.failure, undefined, 'a tool read during the in-flight turn does not repeat it');
	runtime.settleFailureDelivery(rejected.failure, false);
	const accepted = {};
	assert.equal(runtime.decorateObservation(record, view, { reservation: accepted }).lastResult.failure.blockedBy, 'A concrete blocked route', 'a rejected input leaves it owed');
	runtime.settleFailureDelivery(accepted.failure, true);
	runtime.settleFailureDelivery(rejected.failure, false);
	assert.equal(runtime.decorateObservation(record, view, { reservation: {} }).lastResult.failure, undefined, 'an accepted input delivered it');
});

test('review r2: an actionStatus read that returns the failure delivers it', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	const actionId = await startMove(runtime, sent, 's1');
	runtime.onActionResult(record, { actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route', executionStarted: true, physicalAttempted: false });
	const status = await runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn', callId: 's2', tool: { kind: 'action_status', actionId } }, record);
	assert.equal(status.failure.blockedBy, 'No seen route');
	const view = { ...observedAt(0, Date.now()), lastResult: { present: true, actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route' } };
	assert.equal(runtime.decorateObservation(record, view, { reservation: {} }).lastResult.failure, undefined, 'the next wake does not repeat it');
});

test('review r2: through the coordinator, a provider that rejects a turn does not consume its failure', async () => {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), rows = [];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		if (planner.requests.length === 2) throw Object.assign(new Error('provider rejected before accepting input'), { code: 'INCOMPLETE_TURN' });
		return { toolCalls: 0 };
	};
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } },
		config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	const observation = (sequence, failed) => {
		const wire = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] }, world: { dimension: 'minecraft:overworld', gameTime: sequence, dayTime: sequence, raining: false, thundering: false } }, 1, sequence, true, Date.now(), ['blocks']);
		if (failed) wire.lastResult = { present: true, actionId: 'rejected-provider-action', actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'A concrete blocked route' };
		return { agentId: 'agent-a', payload: wire };
	};
	const sentFailure = (index) => JSON.parse(planner.requests[index].input.split('\n')[1]).observation.lastResult?.failure?.blockedBy;
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Explore' } });
		run.bridge.emit('observation', observation(1, false));
		await eventually(() => rows.some(row => row.event === 'native_turn_completed'));
		run.bridge.emit('observation', observation(2, true));
		await eventually(() => rows.some(row => row.event === 'native_turn_failed'));
		run.bridge.emit('observation', observation(3, true));
		await eventually(() => rows.filter(row => row.event === 'native_turn_completed').length >= 2);
		assert.equal(sentFailure(1), 'A concrete blocked route');
		assert.equal(sentFailure(2), 'A concrete blocked route', 'the turn after the rejected one still carries the blocker');
		run.bridge.emit('observation', observation(4, true));
		await eventually(() => rows.filter(row => row.event === 'native_turn_completed').length >= 3);
		assert.equal(sentFailure(3), undefined, 'an accepted turn delivered it');
	} finally { await run.coordinator.stop(); }
});

test('review r3: an owed wake carries its request regardless of its position in the provider context', async t => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.disposeAll());
	const actionId = await startMove(runtime, sent, 'r3');
	runtime.onActionResult(record, { actionId, state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route', executionStarted: true, physicalAttempted: false });
	const view = { ...observedAt(0, Date.now()), lastResult: { present: true, actionId, actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route' } };
	const wake = runtime.decorateObservation(record, view, { reservation: {} });
	assert.equal(wake.lastResult.failure.tried, 'move_to 9,64,0', 'the wake names the request and its target');

	const sent2 = [];
	const reader = new NativeToolRuntime({ bridge: { send: async (type, agentId, payload) => { if (type === 'action_command') sent2.push(payload); } } });
	t.after(() => reader.disposeAll());
	const other = await startMove(reader, sent2, 'r3b');
	reader.onActionResult(record, { actionId: other, state: 'FAILED', reasonCode: 'NO_PATH', message: 'No seen route', executionStarted: true, physicalAttempted: false });
	assert.equal(reader.decorateObservation(record, { ...view, lastResult: { ...view.lastResult, actionId: other } }).lastResult.failure.tried, undefined, 'a tool read inside the calling turn does not restate it');

	const views = new ModelObservationViews();
	const input = (sequence) => `Wake.\n${JSON.stringify({ event: 'action_result', observation: { ...observedAt(0, 1_000 + sequence), eventSequence: sequence, lastResult: wake.lastResult } })}`;
	assert.match(encodeNativeEventInput(input(1), views), /"tried":"move_to 9,64,0"/, 'the first event of a context restates the request');
	assert.match(encodeNativeEventInput(input(2), views), /"tried":"move_to 9,64,0"/, 'encoding an owed failure never discards its target');
	assert.equal(runtime.decorateObservation(record, view, { reservation: {} }).lastResult.failure, undefined, 'runtime ownership suppresses repeated wakes');
	views.reset();
	assert.match(encodeNativeEventInput(input(3), views), /"tried":"move_to 9,64,0"/, 'a reset context restates it again');
});


test('acknowledged prior collection is an ordinary successful receipt', () => {
	const receipt = { state: 'SUCCEEDED', reasonCode: 'ITEM_ALREADY_PICKED_UP', message: 'Collected 1 minecraft:oak_log; holds 1 matching' };
	assert.equal(withFailureSchema(receipt), receipt);
	assert.deepEqual(FAILURE_CODES.ITEM_ALREADY_PICKED_UP, ['ok']);
});
