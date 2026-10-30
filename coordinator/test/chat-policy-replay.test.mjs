import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, gate, until } from './fixtures/runtime-inbox-fixture.mjs';

// Java freezes these fields at admission (AgentConversationRouterVerification).
// De-op/logout affects future authorization, never this event's replay bytes.
for (const consumed of [false, true]) for (const change of ['de-op', 'logout']) {
	test(`frozen operator wake replays after ${change} and coordinator restart (${consumed ? 'consumed' : 'unconsumed'})`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'chat-policy-replay-'));
		const held = gate();
		const payload = {
			transactionId: '00000000-0000-4000-8000-000000000017',
			event: { sequence: 1, kind: 'player_message', sourceId: '11111111-1111-4111-8111-111111111111',
				sourceName: 'Lucas', operator: true, recipientId: 'agent-a', scope: 'direct', text: 'Collect oak logs.',
				goalRevision: 0, observedAtEpochMs: 1 },
			control: { operation: 'start', goalRevision: 1, updatedAtEpochMs: 2, goal: 'Collect oak logs.' },
		};
		let first, second;
		try {
			first = await fixture({ memoryDirectory: directory, ...(consumed ? {} : { start: () => held.promise }) });
			await first.bridge.deliver('conversation_wake', structuredClone(payload));
			await until(() => consumed ? first.traces.some(t => t.event === 'native_turn_completed') : first.calls.length === 1, 'initial wake');
			assert.equal(first.bridge.sent.filter(m => m.type === 'conversation_wake_ack').length, 1);
			// Reconnect before restart: immutable replays retain the exact fingerprint.
			await first.bridge.deliver('conversation_wake', structuredClone(payload));
			assert.deepEqual(first.errors, []);
			const current = first.registry.get('agent-a');
			await first.coordinator.stop();
			second = await fixture({ memoryDirectory: directory, record: current });
			await second.bridge.deliver('conversation_wake', structuredClone(payload));
			await until(() => second.traces.some(t => t.event === 'native_turn_completed'), 'restart replay');
			assert.equal(second.bridge.sent.filter(m => m.type === 'conversation_wake_ack').length, 1);
			assert.deepEqual(second.errors, []);
			const delivered = second.calls.flatMap(c => c.conversation.entries);
			if (consumed) assert.deepEqual(delivered, []);
			else {
				assert.equal(delivered.length, 1);
				assert.equal(delivered[0].sourceName, 'Lucas');
				assert.equal(delivered[0].operator, true);
			}
			// The old serializer's authority/name rewrite must still be detected as corruption.
			const changed = structuredClone(payload);
			delete changed.event.operator;
			if (change === 'logout') delete changed.event.sourceName;
			await assert.rejects(second.bridge.deliver('conversation_wake', changed), error =>
				['TRANSACTION_COLLISION', 'CONVERSATION_COLLISION'].includes(error.code));
		} finally {
			held.resolve();
			await first?.coordinator.stop();
			await second?.coordinator.stop();
			await rm(directory, { recursive: true, force: true });
		}
	});
}
