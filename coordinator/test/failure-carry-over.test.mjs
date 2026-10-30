import assert from 'node:assert/strict';
import test from 'node:test';
import { FailureCarryOver, correlateFailureEvent, shareVisibleFailureFields } from '../src/failure-carry-over.mjs';
import { ToolDigests } from '../src/context-carry-over.mjs';
import { withFailureSchema } from '../src/failure-schema.mjs';

test('successful replacement retirement is not retained as an identified failure', () => {
	const receipt = { actionId: 'old-action', state: 'CANCELLED', reasonCode: 'ACTION_REPLACED' };
	assert.equal(withFailureSchema(receipt), receipt);
	const carry = new FailureCarryOver();
	carry.note(receipt, 'action:old-action');
	assert.deepEqual(carry.lines(), []);
});

test('all open handles survive digest eviction; terminal results retire only their own handle', () => {
	const digests = new ToolDigests(2);
	const longId = `native:${'a'.repeat(120)}`;
	for (const actionId of [longId, 'second', 'third']) digests.push('startAction', '{}', { state: 'RUNNING', actionId });
	for (let i = 0; i < 6; i++) digests.push('observe', '{}', {});
	for (const id of [longId, 'second', 'third']) assert.ok(digests.lines().join('\n').includes(id));
	digests.push('actionStatus', '{}', { state: 'SUCCEEDED', actionId: 'second' });
	digests.push('actionStatus', '{}', { state: 'SUCCEEDED', actionId: 'third' });
	for (let i = 0; i < 6; i++) digests.push('observe', '{}', {});
	assert.ok(digests.lines().join('\n').includes(longId));
	assert.match(digests.lines().join('\n'), /third/);
	assert.doesNotMatch(digests.lines().join('\n'), /second/);
});

test('raw action status is retained in the delivered failure schema exactly once', () => {
	const carry = new FailureCarryOver();
	const raw = { actionId: 'a', actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', message: 'closed gate', executionStarted: true, physicalAttempted: false, failure: { blockedBy: 'closed gate' } };
	carry.note(raw);
	carry.note({ actionId: 'a', actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH' });
	assert.deepEqual(carry.lines([{ actionId: 'a', actionType: 'move_to', state: 'FAILED', reasonCode: 'NO_PATH', failure: { blockedBy: 'closed gate' } }]), []);
	assert.equal(carry.lines().join('\n').split('closed gate').length - 1, 1);
	assert.doesNotMatch(carry.lines().join('\n'), /executionStarted|physicalAttempted|message/);
	assert.doesNotMatch(carry.lines().join('\n'), /not reported/);
});

test('shared failure references never point to synthesized fields absent from visible input', () => {
	const raw = { state: 'FAILED', reasonCode: 'NO_PATH', message: 'closed gate' };
	const shared = shareVisibleFailureFields(raw, [{ observation: { lastResult: raw } }]);
	assert.deepEqual(shared.shared, []);
	assert.equal(shared.value.failure.blockedBy, 'closed gate');
});

test('internal correlation cannot override a conflicting explicit identity', () => {
	const value = { _actionReceipt: { actionId: 'a', state: 'FAILED', reasonCode: 'NO_PATH' }, observation: { lastResult: { actionId: 'b', state: 'FAILED', reasonCode: 'NO_PATH' } } };
	assert.equal(correlateFailureEvent(value), value);
});

test('shared failure fields preserve distinct receipts, targets and effects without identifying actions', () => {
	const event = { observation: { lastResult: { actionId: 'a', state: 'FAILED', failure: { tried: 'move_to 27,64,0', blockedBy: 'closed gate', changed: 'moved 1m' } } } };
	const result = { actionId: 'b', state: 'FAILED', reasonCode: 'NO_PATH', message: 'closed gate', failure: { tried: 'move_to 99,64,0', blockedBy: 'closed gate', changed: 'moved 2m' } };
	const shared = shareVisibleFailureFields(result, [event]);
	assert.equal(shared.value.actionId, 'b');
	assert.deepEqual(shared.value.failure, { tried: 'move_to 99,64,0', changed: 'moved 2m' });
	assert.deepEqual(shared.shared, ['tool result.failure.blockedBy = current input 1.observation.lastResult.failure.blockedBy']);
	assert.equal(result.failure.blockedBy, 'closed gate');
	assert.equal(event.observation.lastResult.actionId, 'a');
});

test('REJECTED uses the shared classification and retains its complete explanation', () => {
	const carry = new FailureCarryOver();
	carry.note({ state: 'REJECTED', reasonCode: 'NO_PLAYER_REQUEST', message: 'task has no player request' });
	const first = carry.lines();
	carry.note({ state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' });
	assert.deepEqual(carry.lines(), first);
	assert.match(first.join('\n'), /task has no player request/);
	assert.match(first.join('\n'), /"failure"/);
});

test('bare identities cannot erase distinct explanations; next turn retains the latest outcome', () => {
	const carry = new FailureCarryOver();
	carry.note({ actionId: 'a', state: 'FAILED', failure: { tried: 'move east', changed: 'moved 1m', blockedBy: 'closed gate' } });
	carry.note({ state: 'FAILED', reasonCode: 'NO_PATH' });
	carry.note({ state: 'SUCCEEDED', reasonCode: 'CHAT_SENT' });
	assert.match(carry.lines().join('\n'), /closed gate/);
	carry.note({ actionId: 'b', state: 'FAILED', failure: { tried: 'mine', blockedBy: 'out of reach' } });
	assert.match(carry.lines().join('\n'), /closed gate/);
	carry.beginTurn();
	assert.doesNotMatch(carry.lines().join('\n'), /closed gate/);
	assert.match(carry.lines().join('\n'), /out of reach/);
	carry.note({ actionId: 'b', state: 'SUCCEEDED' });
	assert.deepEqual(carry.lines(), []);
});

test('identified program failures retain bare reasons independently of later success', () => {
 const carry = new FailureCarryOver();
 carry.note({ state: 'FAILED', reasonCode: 'FIRST_PROGRAM_FAILED' }, 'program:first');
 carry.note({ state: 'FAILED', reasonCode: 'SECOND_PROGRAM_FAILED' }, 'program:second');
 carry.note({ state: 'SUCCEEDED', reasonCode: 'PROGRAM_EXHAUSTED' }, 'program:third');
 assert.equal(carry.lines().length, 2);
 assert.match(carry.lines().join('\n'), /program:first/);
 assert.match(carry.lines().join('\n'), /program:second/);
 assert.match(carry.lines().join('\n'), /FIRST_PROGRAM_FAILED/);
 assert.match(carry.lines().join('\n'), /SECOND_PROGRAM_FAILED/);
});


test('visible identical program failure satisfies only its own identity', () => {
 const carry = new FailureCarryOver();
 const result = { state: 'FAILED', reasonCode: 'SAME_FAILURE' };
 carry.note(result, 'program:first');
 carry.note(result, 'program:second');
 const lines = carry.lines([{ program: { programId: 'first', result } }]);
 assert.equal(lines.length, 1);
 assert.match(lines[0], /program:second/);
});

test('visible bare action receipt satisfies only its own identity', () => {
 const carry = new FailureCarryOver();
 for (const actionId of ['first', 'second']) carry.note({ actionId, state: 'FAILED', reasonCode: 'SAME_FAILURE' }, `action:${actionId}`);
 const lines = carry.lines([{ receipts: [{ actionId: 'first', state: 'FAILED', reasonCode: 'SAME_FAILURE' }] }]);
 assert.equal(lines.length, 1);
 assert.match(lines[0], /second/);
});

test('envelope traversal preserves distinct steps and suppresses only complete visible receipts', () => {
 const carry = new FailureCarryOver();
 const first = { actionId: 'first', sourceStepId: 'step:1', state: 'FAILED', reasonCode: 'NO_PATH', failure: { blockedBy: 'gate', tried: 'move east', changed: 'moved 1m' } };
 const second = { ...first, actionId: 'second', sourceStepId: 'step:2', failure: { ...first.failure, tried: 'move west', changed: 'moved 2m' } };
 carry.noteEnvelope({ result: { results: [first], receipts: [second] } });
 assert.equal(carry.lines().length, 2);
 assert.equal(carry.lines([{ results: [first] }]).length, 1);
 assert.match(carry.lines([{ results: [first] }])[0], /move west/);
 assert.equal(carry.lines([{ results: [{ ...first, failure: { blockedBy: 'gate' } }] }]).length, 2);
 assert.deepEqual(carry.lines([{ result: { results: [first], receipts: [second] } }]), []);
});

test('historical receipt correlation keeps exact identities even for equal failure facts', () => {
 const failure = { state: 'FAILED', reasonCode: 'NO_PATH', failure: { blockedBy: 'same gate', tried: 'move east' } };
 const raw = { mergedEvents: ['first', 'second'].map(actionId => ({ _actionReceipt: { actionId, state: 'FAILED', reasonCode: 'NO_PATH' }, observation: { lastResult: failure } })) };
 const shown = { mergedEvents: raw.mergedEvents.map(event => ({ observation: event.observation })) };
 const correlated = correlateFailureEvent(shown, raw);
 assert.deepEqual(correlated.mergedEvents.map(event => event.observation.lastResult.actionId), ['first', 'second']);
 const carry = new FailureCarryOver();
 for (const event of correlated.mergedEvents) carry.noteEnvelope(event);
 assert.equal(carry.lines([correlated]).length, 0);
 const missingSecond = { mergedEvents: [correlated.mergedEvents[0]] };
 assert.equal(carry.lines([missingSecond]).length, 1);
 assert.match(carry.lines([missingSecond])[0], /second/);
 assert.equal(shown.mergedEvents[0].observation.lastResult.actionId, undefined, 'correlation is bookkeeping only');
});
