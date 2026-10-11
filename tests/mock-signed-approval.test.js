'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createMockApprovalVerifier,signMockApproval}=require('../gateway/mock-signed-approval');
const key=Buffer.alloc(32,7),now=1700000000000;
const binding={repository:'example/numerra',prNumber:'11',runId:'12345',attempt:'1',
 headSha:'a'.repeat(40),baseSha:'b'.repeat(40),pipelineSha:'c'.repeat(40)};
function setup(){
 const consumed=new Set();
 const consumeNonce=async(nonce)=>{if(consumed.has(nonce))return false;consumed.add(nonce);return true;};
 const verify=createMockApprovalVerifier({secret:key,consumeNonce,now:()=>now});
 const approval=signMockApproval({secret:key,grantId:'grant-a',binding,capUsd:'10',nonce:'nonce-a',expiresAt:now+60000});
 const request={approval,grantId:'grant-a',binding,capMicros:10000000};
 return {verify,request,consumed};
}
test('accepts one correctly scoped signed owner approval',async()=>{
 const {verify,request}=setup();assert.equal(await verify(request),true);
});
test('rejects duplicate/replayed approval nonce',async()=>{
 const {verify,request}=setup();await verify(request);
 await assert.rejects(verify(request),/APPROVAL_DENIED/);
});
test('rejects altered cap, grant, repository, run and signature',async()=>{
 for(const change of [
  {capMicros:20000000},{grantId:'other'},{binding:{...binding,repository:'example/truemail'}},
  {binding:{...binding,runId:'999'}},
  {approval:{...setup().request.approval,mac:'0'.repeat(64)}}
 ]){
  const {verify,request}=setup();await assert.rejects(verify({...request,...change}),/APPROVAL_DENIED/);
 }
});
test('rejects expired and overly future approvals',async()=>{
 for(const expiresAt of [now-1,now+600001]){
  const {verify,request}=setup();
  const approval=signMockApproval({secret:key,grantId:'grant-a',binding,capUsd:'10',nonce:'nonce-a',expiresAt});
  await assert.rejects(verify({...request,approval}),/APPROVAL_DENIED/);
 }
});
test('rejects nonce storage outage and absent secure key',async()=>{
 const {request}=setup();
 const verify=createMockApprovalVerifier({secret:key,consumeNonce:async()=>{throw Error('offline')},now:()=>now});
 await assert.rejects(verify(request),/APPROVAL_DENIED/);
 assert.throws(()=>createMockApprovalVerifier({secret:Buffer.alloc(4),consumeNonce:async()=>true}),/APPROVAL_DENIED/);
});
