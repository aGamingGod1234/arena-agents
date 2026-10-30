import assert from 'node:assert/strict';
import test from 'node:test';
import { Observer } from '../../scripts/quality/run-scenarios.mjs';

function observer(hardStop) {
 const o = new Observer('.', { protocolAudit: '', providerTurns: '' }, {}, {}, { stopRetryMs: 0, hardStop });
 o.agent = 'player';
 o.rcon = { command: async () => { throw new Error('RCON timed out'); } };
 return o;
}

test('pending stop escalates despite persistent evidence read errors', async () => {
 let kills = 0;
 const o = observer(async () => { kills++; });
 await o.requestStop('SPEND_CAP');
 o.stopConfirmMs = 0;
 o.trace.poll = async () => { throw new Error('EIO evidence read failed'); };
 for (let i = 0; i < 4; i++) await assert.rejects(o.poll(), /EIO/);
 assert.equal(kills, 1);
 assert.equal(o.stopRequest.state, 'escalated');
});

test('failed hard stop remains unresolved and retries until termination succeeds', async () => {
 let kills = 0;
 const o = observer(async () => { if (++kills < 3) throw new Error('termination failed'); });
 o.stopConfirmMs = 0;
 await o.requestStop('SPEND_CAP');
 assert.equal(o.stopRequest.state, 'pending');
 await o.progressStop();
 assert.equal(o.stopRequest.state, 'pending');
 await o.progressStop();
 assert.equal(o.stopRequest.state, 'escalated');
 await o.progressStop();
 assert.equal(kills, 3);
 assert.equal(o.stopRequest.hardStopped, true);
 assert.equal(o.stopRequest.hardStopFailures.length, 2);
});

test('concurrent watchdog polls share one in-flight termination', async () => {
 let finish, kills = 0;
 const o = observer(async () => { kills++; await new Promise(resolve => { finish = resolve; }); });
 o.stopConfirmMs = 0;
 const requested = o.requestStop('SPEND_CAP');
 const polls = Array.from({ length: 4 }, () => o.progressStop());
 assert.equal(kills, 1);
 finish();
 await Promise.all([requested, ...polls]);
 assert.equal(o.stopRequest.state, 'escalated');
});

test('missing termination handler never counts as a successful hard stop', async () => {
 const o = observer(null);
 o.stopConfirmMs = 0;
 await o.requestStop('SPEND_CAP');
 assert.equal(o.stopRequest.state, 'pending');
 assert.match(o.stopRequest.hardStopError, /No owned process/);
 assert.notEqual(o.stopRequest.hardStopped, true);
});
