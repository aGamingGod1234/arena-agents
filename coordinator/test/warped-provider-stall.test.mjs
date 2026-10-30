import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderStall} from '../../evals/d39-warped4/provider-stall.mjs';
test('retries, physical program dispatches and RPC acknowledgements cannot conceal a ten-minute provider outage',()=>{
 const s=new ProviderStall();s.accept({event:'native_provider_turn_sent',at:1000});
 for(let at=121000;at<=601000;at+=120000){s.accept({event:'native_turn_failed',errorCode:'PLANNING_TIMEOUT',at});s.accept({event:'native_provider_turn_sent',at:at+1});s.accept({event:'native_provider_turn_acked',at:at+2});s.accept({event:'native_tool_dispatch_started',at:at+3});s.accept({event:'native_token_usage',at:at+4});}
 assert.equal(s.stalled(600999),false);assert.equal(s.stalled(601000),true);
 s.accept({event:'native_decision_timing',outcome:'completed',boundary:'tool_request',at:601001});assert.equal(s.stalled(1201000),true);
});
test('time executing a model tool is separate from provider waiting',()=>{
 const s=new ProviderStall();s.accept({event:'native_provider_turn_sent',at:1000});s.accept({event:'native_first_tool_requested',at:2000});s.accept({event:'native_tool_queue_timing',callId:'build',at:2001});
 assert.equal(s.stalled(1201000),false);
 s.accept({event:'native_tool_result_delivered',callId:'build',at:1202000});s.accept({event:'native_turn_failed',errorCode:'PLANNING_TIMEOUT',at:1322000});
 assert.equal(s.stalled(1801999),false);assert.equal(s.stalled(1802000),true);
});
test('parallel model tools do not start a provider clock until their last result is delivered',()=>{
 const s=new ProviderStall();s.accept({event:'native_provider_turn_sent',at:1000});
 s.accept({event:'native_first_tool_requested',at:1999});
 for(const callId of ['a','b'])s.accept({event:'native_tool_queue_timing',callId,at:2000});
 s.accept({event:'native_tool_result_delivered',callId:'a',at:3000});assert.equal(s.waitingSince,null);
 s.accept({event:'native_tool_result_delivered',callId:'b',at:900000});assert.equal(s.waitingSince,900000);
 s.accept({event:'native_turn_completed',at:900001});assert.equal(s.stalled(1900000),false);
});

test('an unanswered request crosses ten minutes even if the provider never emits a timeout',()=>{
 const s=new ProviderStall();s.accept({event:'native_provider_turn_sent',at:1000});assert.equal(s.stalled(600999),false);assert.equal(s.stalled(601000),true);
});
test('a long provider segment remains void after its late answer, while a prompt cancellation starts no outage',()=>{
 const s=new ProviderStall();s.accept({event:'native_decision_timing',outcome:'completed',boundary:'tool_request',at:900000,segmentDurationMs:700000});assert.equal(s.stalled(900001),true);
 const cancelled=new ProviderStall();cancelled.accept({event:'native_provider_turn_sent',at:1000});cancelled.accept({event:'native_turn_failed',errorCode:'PLAN_CANCELLED',at:2000});assert.equal(cancelled.stalled(1000000),false);
});

test('a queued second body tool cannot charge its execution time to the provider',()=>{
 const s=new ProviderStall();s.accept({event:'native_provider_turn_sent',at:1000});s.accept({event:'native_first_tool_requested',at:2000});
 s.accept({event:'native_tool_queue_timing',callId:'a',at:2001});s.accept({event:'native_tool_result_delivered',callId:'a',at:3000});
 s.accept({event:'native_tool_queue_timing',callId:'b',at:3001});assert.equal(s.stalled(900000),false);
 s.accept({event:'native_tool_result_delivered',callId:'b',at:900001});assert.equal(s.stalled(900002),false);
});
