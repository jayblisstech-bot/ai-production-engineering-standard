'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createMockGrantIssuer}=require('../gateway/mock-grant-issuer');
const {BudgetLedgerReference,parseCapUsd}=require('../scripts/review-dollar-budget');
const binding={repository:'example/numerra',prNumber:'11',runId:'12345',attempt:'1',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),pipelineSha:'c'.repeat(40)};
function fixture(){
 const records=new Map();let calls=0;
 const store={createGrant({grantId,binding,capUsd}){
  calls++;if(records.has(grantId))throw Error('APES_BUDGET_DUPLICATE_GRANT');
  records.set(grantId,new BudgetLedgerReference({binding,limitMicros:parseCapUsd(capUsd)}));
  return records.get(grantId).snapshot();
 }};
 const approvedPolicies=[{grantId:'numerra-11',repository:binding.repository,prNumber:'11',models:{openai:['mock-openai']}}];
 const approve=async ({approval,grantId,binding:b,capMicros})=>approval==='signed-owner-approval' &&
  grantId==='numerra-11'&&b.runId==='12345'&&capMicros===10000000;
 const issue=createMockGrantIssuer({store,approvedPolicies,authorizeOwner:approve});
 return {store,records,issue,calls:()=>calls,approvedPolicies};
}
test('authorized owner can issue exactly scoped mock grant',async()=>{
 const f=fixture();
 const result=await f.issue({approval:'signed-owner-approval',grantId:'numerra-11',binding,capUsd:'10'});
 assert.equal(result.limitMicros,10000000);assert.equal(f.calls(),1);
});
test('unapproved caller cannot issue grant',async()=>{
 const f=fixture();
 await assert.rejects(f.issue({approval:'invalid',grantId:'numerra-11',binding,capUsd:'10'}),/ISSUANCE_DENIED/);
 assert.equal(f.calls(),0);
});
test('rejects cap tampering and mismatched run',async()=>{
 const f=fixture();
 await assert.rejects(f.issue({approval:'signed-owner-approval',grantId:'numerra-11',binding,capUsd:'20'}),/ISSUANCE_DENIED/);
 await assert.rejects(f.issue({approval:'signed-owner-approval',grantId:'numerra-11',binding:{...binding,runId:'999'},capUsd:'10'}),/ISSUANCE_DENIED/);
 assert.equal(f.calls(),0);
});
test('rejects cross repo, PR and grant switches',async()=>{
 const f=fixture();
 for(const b of [{...binding,repository:'example/truemail'},{...binding,prNumber:'12'}]){
  await assert.rejects(f.issue({approval:'signed-owner-approval',grantId:'numerra-11',binding:b,capUsd:'10'}),/ISSUANCE_DENIED/);
 }
 await assert.rejects(f.issue({approval:'signed-owner-approval',grantId:'different',binding,capUsd:'10'}),/ISSUANCE_DENIED/);
 assert.equal(f.calls(),0);
});
test('refuses duplicate grant issuance',async()=>{
 const f=fixture();const args={approval:'signed-owner-approval',grantId:'numerra-11',binding,capUsd:'10'};
 await f.issue(args);await assert.rejects(f.issue(args),/DUPLICATE_GRANT/);
 assert.equal(f.records.size,1);
});
test('owner authorization errors fail closed',async()=>{
 const f=fixture();
 const issue=createMockGrantIssuer({store:f.store,approvedPolicies:f.approvedPolicies,authorizeOwner:async()=>{throw Error('offline')}});
 await assert.rejects(issue({approval:'signed-owner-approval',grantId:'numerra-11',binding,capUsd:'10'}),/ISSUANCE_DENIED/);
 assert.equal(f.calls(),0);
});
