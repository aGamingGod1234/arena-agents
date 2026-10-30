import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationWakes, canonicalConversationEntry } from '../src/conversation-memory.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { buildNativeEventInput, routinePerceptionChange } from '../src/dynamic-main.mjs';

// Lucas's chat policy (2026-10-11): all public chat is context only; a DM from anyone wakes the agent so it can
// answer; only the operator's messages become tasks (Minecraft and takeTask enforce that part).
const PLAYER = '11111111-1111-4111-8111-111111111111';
const event = (kind, scope, extra = {}) => ({ sequence: 1, kind, sourceId: PLAYER, recipientId: 'agent-a', scope, text: 'hello',
	goalRevision: 0, observedAtEpochMs: 1, ...extra });

test('conversation wake table: DMs from anyone and the operator\'s nearby speech wake; public chat never does', () => {
	const rows = [
		['operator DM', event('player_message', 'direct', { operator: true }), true],
		['other player DM', event('player_message', 'direct'), true],
		['agent DM', event('agent_message', 'direct'), true],
		['agent public chat', event('agent_message', 'public'), false],
		['agent nearby speech', event('agent_message', 'proximity'), false],
		['operator nearby speech', event('proximity_speech', 'proximity', { operator: true }), true],
		['other player nearby speech', event('proximity_speech', 'proximity'), false],
	];
	for (const [label, value, wakes] of rows) {
		assert.equal(conversationWakes(value), wakes, label);
		assert.equal(conversationWakes(canonicalConversationEntry(value)), wakes, `${label} after the inbox stores it`);
	}
});

test('conversation events carry the sender name and an operator flag that is only present when true', () => {
	const normalized = validateProtocolV2Payload('conversation_event', event('player_message', 'direct', { sourceName: 'Lucas', operator: true }));
	assert.equal(normalized.sourceName, 'Lucas');
	assert.equal(normalized.operator, true);
	assert.equal(Object.hasOwn(validateProtocolV2Payload('conversation_event', event('player_message', 'direct', { operator: false })), 'operator'), false);
	assert.throws(() => validateProtocolV2Payload('conversation_event', event('player_message', 'direct', { operator: 'yes' })), /operator must be boolean/);
	assert.equal(canonicalConversationEntry(event('player_message', 'direct', { sourceName: 'Alex' })).sourceName, 'Alex');
});

test('the model sees who wrote each message and whether they are the operator, without internal routing fields', () => {
	const input = buildNativeEventInput({ agentId: 'agent-a', goalRevision: 0, currentGoal: null }, {
		event: 'player_message', trigger: 'conversation', conversationOnly: true, observation: {},
		conversation: { mode: 'unread', baseSequence: 0, nextSequence: 2, entries: [
			canonicalConversationEntry(event('player_message', 'direct', { sourceName: 'Lucas', operator: true })),
			canonicalConversationEntry(event('player_message', 'direct', { sequence: 2, sourceId: '22222222-2222-4222-8222-222222222222', sourceName: 'Alex' })),
		] },
	});
	const payload = JSON.parse(input.slice(input.indexOf('\n') + 1));
	assert.deepEqual(payload.conversation.entries, [
		{ sequence: 1, kind: 'player_message', sourceId: PLAYER, sourceName: 'Lucas', operator: true, scope: 'direct', text: 'hello', observedAtEpochMs: 1 },
		{ sequence: 2, kind: 'player_message', sourceId: '22222222-2222-4222-8222-222222222222', sourceName: 'Alex', scope: 'direct', text: 'hello', observedAtEpochMs: 1 },
	]);
	assert.match(input, /Only operator:true messages are tasks/);
});

test('Minecraft\'s lines for public and nearby chat ride the next wake; DM lines still wake', () => {
	const payload = { attention: true, changedFacts: ['perception'] };
	const wire = (text) => ({ perception: { events: [{ sequence: 4, type: 'system_message', text }] } });
	assert.equal(routinePerceptionChange(payload, wire('<Axiom> anyone have iron?'), 3, 'Iris'), true, 'another agent\'s public chat');
	assert.equal(routinePerceptionChange(payload, wire('[Nearby] <Axiom> over here'), 3, 'Iris'), true, 'another agent\'s nearby speech');
	assert.equal(routinePerceptionChange(payload, { perception: { events: [{ sequence: 4, type: 'player_chat', text: '<Steve> hi all' }] } }, 3, 'Iris'), true, 'vanilla public chat');
	assert.equal(routinePerceptionChange(payload, wire('[Axiom] Mining a block'), 3, 'Iris', ['Iris', 'Axiom']), true, "another agent's activity line");
	assert.equal(routinePerceptionChange(payload, wire('[Axiom] Mining a block'), 3, 'Iris'), false, 'an unknown bracketed name keeps its wake');
	assert.equal(routinePerceptionChange(payload, wire('[DM] Alex -> Iris: hi'), 3, 'Iris', ['Iris', 'Axiom']), false, 'a DM line still wakes');
	assert.equal(routinePerceptionChange(payload, wire('You may not rest now; there are monsters nearby'), 3, 'Iris'), false, 'other system messages keep their wake');
});
