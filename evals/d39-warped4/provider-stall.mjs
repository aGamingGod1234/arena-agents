// Actual model replies and tool publications bound provider waits. Body dispatches, usage and RPC acks do not.
export class ProviderStall {
 waitingSince=null;timeouts=0;longestMs=0;pendingTools=new Set();active=false;violatedAt=null;
 detect(at){
  if(!this.pendingTools.size&&(this.active||this.timeouts>0)&&this.waitingSince!==null&&at-this.waitingSince>=600000)this.violatedAt??=this.waitingSince+600000;
 }
 responded(at){
  this.detect(at);
  if(this.waitingSince!==null)this.longestMs=Math.max(this.longestMs,at-this.waitingSince);
  this.waitingSince=null;this.timeouts=0;
 }
 accept(row){
  if(!Number.isFinite(row.at))return;
  if(row.event==='native_decision_timing'&&Number.isFinite(row.segmentDurationMs)&&row.segmentDurationMs>=600000)this.violatedAt??=row.at-row.segmentDurationMs+600000;
  if(row.event==='native_turn_completed'||row.event==='native_decision_timing'&&row.outcome==='completed'&&row.boundary==='turn_completed'){
   this.responded(row.at);this.pendingTools.clear();this.active=false;
  }else if(row.event==='native_first_tool_requested'||row.event==='native_decision_timing'&&row.outcome==='completed'&&row.boundary==='tool_request'){
   this.responded(row.at);this.active=true;
  }else if(row.event==='native_tool_queue_timing'){
   if(this.active&&row.callId){this.pendingTools.add(row.callId);this.waitingSince=null;}
  }else if(row.event==='native_tool_result_delivered'){
   this.pendingTools.delete(row.callId);if(this.active&&!this.pendingTools.size)this.waitingSince??=row.at;
  }else if(row.event==='native_provider_turn_sent'){
   this.pendingTools.clear();this.active=true;this.waitingSince??=row.at;
  }else if(row.event==='native_turn_failed'){
   this.active=false;this.pendingTools.clear();
   if(row.errorCode==='PLANNING_TIMEOUT'){this.waitingSince??=row.at;this.timeouts++;}
   else if(!this.timeouts)this.waitingSince=null;
  }
 }
 stalled(now){this.detect(now);return this.violatedAt!==null;}
 snapshot(now){return{waitingSince:this.waitingSince,pendingModelTools:this.pendingTools.size,confirmedTimeouts:this.timeouts,currentWaitMs:this.waitingSince===null?0:now-this.waitingSince,longestCompletedWaitMs:this.longestMs,violatedAt:this.violatedAt};}
}
