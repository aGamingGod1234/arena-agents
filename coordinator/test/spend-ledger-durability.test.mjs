import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { SpendLedger } from '../src/benchmark/spend-ledger.mjs';

const moduleUrl = new URL('../src/benchmark/spend-ledger.mjs', import.meta.url).href;

test('r5: clock skew cannot steal a paused live writer lock', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-clock-'));
 const file = path.join(dir, 'ledger.json');
 const script = path.join(dir, 'writer.mjs');
 await fs.writeFile(script, `import fs from 'node:fs/promises';
 import { syncBuiltinESMExports } from 'node:module';
 const rename = fs.rename;
 fs.rename = async (...args) => { process.send('paused'); await new Promise(r => process.once('message', r)); return rename(...args); };
 syncBuiltinESMExports();
 const { SpendLedger } = await import(${JSON.stringify(moduleUrl)});
 process.send(await new SpendLedger({ capUsd: 4, file: process.argv[2] }).reserve('first', 4));
 process.disconnect();`);
 const child = fork(script, [file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
 const exited = once(child, 'exit');
 const now = Date.now;
 try {
  assert.equal((await once(child, 'message'))[0], 'paused');
  Date.now = () => now() + 61000;
  await assert.rejects(new SpendLedger({ capUsd: 4, file, lockTimeoutMs: 75 }).reserve('second', 4), /stayed locked/);
 } finally {
  Date.now = now;
  child.send('resume');
  await exited;
  try { assert.equal((await new SpendLedger({ file }).totals()).reservedUsd, 4); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
 }
});

for (const stage of ['writeFile', 'sync', 'rename']) test(`r5: failed ${stage} preserves prior seed when the ledger object is reused`, async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-seed-'));
 const file = path.join(dir, 'ledger.json');
 const ledger = new SpendLedger({ capUsd: 150, priorSpendUsd: 146, file });
 const failure = () => { throw Object.assign(new Error('injected persistence failure'), { code: 'EIO' }); };
 const originalOpen = fs.open;
 try {
  if (stage !== 'rename') {
   if (stage === 'writeFile') t.mock.method(fs, 'writeFile', failure);
   t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('.tmp')) handle[stage] = failure;
    return handle;
   });
  } else t.mock.method(fs, 'rename', failure);
  syncBuiltinESMExports();
  await assert.rejects(ledger.reserve('failed', 1), /injected persistence failure/);
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(await ledger.reserve('retry', 149), false);
  assert.equal((await ledger.totals()).priorSpendUsd, 146);
  assert.equal(await ledger.reserve('within-cap', 4), true);
  assert.equal((await new SpendLedger({ capUsd: 150, file }).totals()).priorSpendUsd, 146);
 } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(dir, { recursive: true, force: true }); }
});


test('r5: releasing a lock verifies its ownership token', async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-owner-'));
 const file = path.join(dir, 'ledger.json');
 const rename = fs.rename;
 const replacement = JSON.stringify({ token: 'another-owner', pid: process.pid });
 try {
  t.mock.method(fs, 'rename', async (...args) => {
   await rename(...args);
   await fs.writeFile(`${file}.lock`, replacement);
  });
  syncBuiltinESMExports();
  await assert.rejects(new SpendLedger({ capUsd: 4, file }).reserve('first', 4), /lock ownership changed/);
  assert.equal(await fs.readFile(`${file}.lock`, 'utf8'), replacement);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).entries.first.usd, 4);
 } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('r5: failed replacement leaves the committed ledger intact and flush precedes atomic rename', async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-atomic-'));
 const file = path.join(dir, 'ledger.json');
 const ledger = new SpendLedger({ capUsd: 150, priorSpendUsd: 146, file });
 const open = fs.open;
 const events = [];
 try {
  await ledger.reserve('existing', 1);
  const before = await fs.readFile(file, 'utf8');
  t.mock.method(fs, 'open', async (...args) => {
   const handle = await open(...args);
   if (String(args[0]).endsWith('.tmp')) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { events.push('sync'); return sync(); };
   }
   return handle;
  });
  t.mock.method(fs, 'rename', async () => { events.push('rename'); throw new Error('replacement failed'); });
  syncBuiltinESMExports();
  await assert.rejects(ledger.reserve('failed', 1), /replacement failed/);
  assert.deepEqual(events, ['sync', 'rename']);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['ledger.json']);
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(await ledger.reserve('too-large', 4), false);
  assert.equal(await ledger.reserve('remaining', 3), true);
 } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(dir, { recursive: true, force: true }); }
});
