import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingConversationInbox } from '../src/pending-conversation-inbox.mjs';
import { fixture, event, until, flush } from './fixtures/runtime-inbox-fixture.mjs';
const publicEvent = sequence => ({ ...event(sequence, false), kind: 'agent_message', scope: 'public', text: `Public context ${sequence}` });
async function persisted(t, messages) {
  const directory = await mkdtemp(join(tmpdir(), 'public-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inbox = new PendingConversationInbox({ directory, agentId: 'agent-a' });
  for (const message of messages) await inbox.append('r17-server', message);
  await inbox.close();
  return directory;
}
for (const count of [32, 33, 97]) test(`public-only recovery of ${count} messages never wakes`, { timeout: 120_000 }, async t => {
  const memoryDirectory = await persisted(t, Array.from({ length: count }, (_, i) => publicEvent(i + 1)));
  const f = await fixture({ memoryDirectory });
  try {
    await flush();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.errors, []);
    await f.bridge.deliver('conversation_event', event(count + 1, false));
    await until(() => f.calls.some(c => c.conversation.entries.some(e => e.sequence === count + 1)), 'DM behind public prefix delivered');
    assert.deepEqual(f.calls.flatMap(c => c.conversation.entries).map(e => e.sequence), Array.from({ length: count + 1 }, (_, i) => i + 1));
  } finally { await f.coordinator.stop(); }
});
test('recovery finds a DM beyond two pages and leaves public-only suffix for later wakes', { timeout: 120_000 }, async t => {
  const messages = Array.from({ length: 216 }, (_, i) => i === 65 ? event(i + 1, false) : publicEvent(i + 1));
  const memoryDirectory = await persisted(t, messages);
  const f = await fixture({ memoryDirectory });
  try {
    await until(() => f.traces.filter(t => t.event === 'native_turn_completed').length >= 4, 'DM delivery and visible reply correction complete');
    await flush();
    assert.equal(f.calls.length, 4, 'pagination cannot drain the public suffix with more model turns');
    assert.deepEqual(f.calls.flatMap(c => c.conversation.entries).map(e => e.sequence), Array.from({ length: 128 }, (_, i) => i + 1));
    await f.bridge.deliver('conversation_event', event(217, false));
    await until(() => f.calls.some(c => c.conversation.entries.some(e => e.sequence === 217)), 'next legitimate wake delivers retained context');
    assert.deepEqual(f.calls.flatMap(c => c.conversation.entries).map(e => e.sequence), Array.from({ length: 217 }, (_, i) => i + 1));
    assert.deepEqual(f.errors, []);
  } finally { await f.coordinator.stop(); }
});

test('next DM delivers more than eight full public player messages interleaved with public notices', { timeout: 120_000 }, async t => {
  const messages = Array.from({ length: 24 }, (_, i) => ({
    ...publicEvent(i + 1),
    kind: i % 2 === 0 ? 'player_message' : 'agent_message',
    text: i % 2 === 0 ? `Player ${i}: ${'x'.repeat(490)}` : `Public notice ${i}`,
  }));
  const memoryDirectory = await persisted(t, messages);
  const f = await fixture({ memoryDirectory });
  try {
    assert.equal(f.calls.length, 0);
    await f.bridge.deliver('conversation_event', event(25, false));
    await until(() => f.calls.some(c => c.conversation.entries.some(e => e.sequence === 25)), 'legitimate DM delivers public context');
    const delivered = f.calls.flatMap(c => c.conversation.entries);
    assert.deepEqual(delivered.slice(0, 24).map(e => e.text), messages.map(e => e.text));
    assert.equal(delivered.filter(e => e.scope === 'public' && e.kind === 'player_message').length, 12);
    assert.deepEqual(f.errors, []);
  } finally { await f.coordinator.stop(); }
});
