'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SqliteBudgetStore}=require('../gateway/sqlite-budget-store');
const {BudgetGatewayService}=require('../gateway/budget-service');
const {signMockApproval,createSynchronousApprovalSignatureVerifier}=require('../gateway/mock-signed-approval');
const sha=c=>c.repeat(40),now=Date.now(),secret=Buffer.alloc(32,11);
const a={repository:'example/numerra',prNumber:'11',runId:'120001',attempt:'1',headSha:sha('a'),baseSha:sha('b'),pipelineSha:sha('c')};
const b={repository:'example/truemail',prNumber:'9',runId:'120002',attempt:'1',headSha:sha('d'),baseSha:sha('e'),pipelineSha:sha('f')};
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apes-fault-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'ledger.sqlite'),s=new SqliteBudgetStore(file);t.after(()=>s.close());
 const verifyApproval=createSynchronousApprovalSignatureVerifier({secret,now:()=>now});
 for(const [grantId,binding,capUsd] of [['ga',a,'10'],['gb',b,'3']]){
  const payload={grantId,binding,capUsd,nonce:'nonce-'+grantId,expiresAt:now+60000};
  s.issueSignedGrant({...payload,approval:signMockApproval({secret,...payload}),verifyApproval});
 }
 return {file,s};
}
function svc(store,transport){
 const rate={rates:{inputMicroUsdPerMillion:10000000,outputMicroUsdPerMillion:10000000,perCallFeeMicros:0,validUntilMs:now+60000},limits:{maxInputTokens:100000,maxOutputTokens:100000}};
 return new BudgetGatewayService({store,policies:[
  {grantId:'ga',repository:a.repository,prNumber:a.prNumber,models:{openai:['mock-openai']}},
  {grantId:'gb',repository:b.repository,prNumber:b.prNumber,models:{gemini:['mock-gemini']}}
 ],pricingCatalog:{openai:{'mock-openai':rate},gemini:{'mock-gemini':rate}},transport,mockOnly:true,now:()=>now});
}
test('parallel mock requests cannot exceed a single $10 grant',async t=>{
 const {s}=setup(t);let calls=0;
 const gateway=svc(s,async()=>{calls++;await new Promise(resolve=>setImmediate(resolve));return {mock:true};});
 const results=await Promise.allSettled(Array.from({length:8},(_,i)=>gateway.dispatch({grantId:'ga',binding:a,requestId:'parallel-'+i,provider:'openai',model:'mock-openai'})));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,5);
 assert.equal(results.filter(x=>x.status==='rejected').length,3);
 assert.equal(calls,5);assert.equal(s.snapshot('ga',a).remainingMicros,0);
 assert.equal(s.snapshot('gb',b).remainingMicros,3000000);
});
test('gateway timeout consumes full ceiling; replay cannot cause second mock call',async t=>{
 const {s}=setup(t);let calls=0;
 const gateway=svc(s,async()=>{calls++;throw Error('provider-timeout');});
 const args={grantId:'ga',binding:a,requestId:'timeout',provider:'openai',model:'mock-openai'};
 await assert.rejects(gateway.dispatch(args),/provider-timeout/);
 assert.equal(s.snapshot('ga',a).usedMicros,2000000);
 await assert.rejects(gateway.dispatch(args),/DUPLICATE_REQUEST/);
 assert.equal(calls,1);
});
test('process restart retains ambiguous reservation and denies its replay',t=>{
 const {file,s}=setup(t);
 s.reserve({grantId:'ga',binding:a,requestId:'crashed-at-provider',quoteMicros:7000000});
 const second=new SqliteBudgetStore(file);t.after(()=>second.close());
 assert.equal(second.snapshot('ga',a).reservedMicros,7000000);
 assert.throws(()=>second.reserve({grantId:'ga',binding:a,requestId:'crashed-at-provider',quoteMicros:7000000}),/DUPLICATE_REQUEST/);
 assert.throws(()=>second.reserve({grantId:'ga',binding:a,requestId:'over-cap',quoteMicros:4000000}),/EXHAUSTED/);
});
test('cross-repository grant substitution fails without affecting either ledger',async t=>{
 const {s}=setup(t);let calls=0;const gateway=svc(s,async()=>{calls++;return {mock:true};});
 await assert.rejects(gateway.dispatch({grantId:'ga',binding:b,requestId:'attack',provider:'openai',model:'mock-openai'}),/REPOSITORY_POLICY_DENIED/);
 assert.equal(calls,0);assert.equal(s.snapshot('ga',a).remainingMicros,10000000);
 assert.equal(s.snapshot('gb',b).remainingMicros,3000000);
});
test('unknown mock provider result holds conservative full cost',async t=>{
 const {s}=setup(t);const gateway=svc(s,async()=>({untrusted:true}));
 await assert.rejects(gateway.dispatch({grantId:'ga',binding:a,requestId:'unknown',provider:'openai',model:'mock-openai'}),/UNTRUSTED_PROVIDER_RESULT/);
 assert.equal(s.snapshot('ga',a).usedMicros,2000000);
});
