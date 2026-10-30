import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchWorker, parseSuiteArgs } from '../../scripts/quality/run-generality.mjs';
import { runSpendUsd } from '../src/benchmark/spend-ledger.mjs';
test('known failed judge attempts count without stopping later launches',()=>{
 assert.equal(runSpendUsd({metrics:{modelCalls:1,costEstimateUsd:.25},judge:{error:'second pass failed',costUsd:.1,unknownSpend:false}},{reserveUsd:5}).usd,.35);
 assert.equal(runSpendUsd({metrics:{modelCalls:1,costEstimateUsd:.25},judge:{costUsd:null,unknownSpend:true}},{reserveUsd:5}).usd,.75);
});
test('worker timeout terminates its child tree',async()=>{
 const child=new EventEmitter(); child.stdout=new PassThrough();child.stderr=new PassThrough();let stopped=0;
 await assert.rejects(launchWorker('fake',{timeoutMs:5,spawnChild:()=>child,stopChild:async c=>{assert.equal(c,child);stopped++;c.emit('close',1)}}),/exceeded/);
 assert.equal(stopped,1);
});
test('short pipeline windows cannot be applied to held-out benchmarks',()=>{
 assert.equal(parseSuiteArgs(['--arms','a','--out','o','--smoke-window-ms','90000'])['smoke-window-ms'],'90000');
 assert.throws(()=>parseSuiteArgs(['--arms','a','--out','o','--split','heldout','--smoke-window-ms','90000']),/train only/);
});
