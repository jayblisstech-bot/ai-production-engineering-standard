'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAuthorizedMockDispatch}=require('../gateway/authorized-mock-dispatch');
const {BudgetGatewayService}=require('../gateway/budget-service');
const {BudgetLedgerReference}=require('../scripts/review-dollar-budget');
const sha=c=>c.repeat(40);
const binding={repository:'example/numerra',prNumber:'11',runId:'12345',attempt:'1',headSha:sha('a'),baseSha:sha('b'),pipelineSha:sha('c')};
const bindingB={repository:'example/truemail',prNumber:'3',runId:'12346',attempt:'1',headSha:sha('d'),baseSha:sha('e'),pipelineSha:sha('f')};
const now=1700000000000;
const rate={rates:{inputMicroUsdPerMillion:10000000,outputMicroUsdPerMillion:10000000,perCallFeeMicros:0,validUntilMs:now+20000},limits:{maxInputTokens:100000,maxOutputTokens:100000}};
function fixture(){
 const ledgers=new Map([['a',new BudgetLedgerReference({binding,limitMicros:10000000})],['b',new BudgetLedgerReference({binding:bindingB,limitMicros:3000000})]]);
 let calls=0;
 const store={
  snapshot:(id,b)=>{ledgers.get(id).requireBinding(b);return ledgers.get(id).snapshot();},
  reserve:({grantId,binding:b,requestId,quoteMicros})=>ledgers.get(grantId).reserve({binding:b,requestId,ceilingMicros:quoteMicros}),
  settle:({grantId,binding:b,requestId,verified,actualMicros})=>ledgers.get(grantId).settle({binding:b,requestId,verified,actualMicros}),
 };
 const svc=new BudgetGatewayService({store,policies:[
  {grantId:'a',repository:binding.repository,prNumber:binding.prNumber,models:{openai:['mock-openai']}},
  {grantId:'b',repository:bindingB.repository,prNumber:bindingB.prNumber,models:{gemini:['mock-gemini']}},
 ],pricingCatalog:{openai:{'mock-openai':rate},gemini:{'mock-gemini':rate}},mockOnly:true,now:()=>now,
 transport:async()=>{calls++;return {mock:true};}});
 const trusted=[binding,bindingB].map((b,i)=>({
  grantId:i===0?'a':'b',binding:b,ownerId:77,repositoryId:i+99,
  audience:'apes-gateway:review',checkoutSha:sha('9'),
  ref:'refs/pull/'+b.prNumber+'/merge',jobWorkflowRef:'example/apes/.github/workflows/review.yml@refs/heads/main',
  confirmGitHubBinding:async()=>true,
 }));
 const claim=(b,i)=>({iss:'https://token.actions.githubusercontent.com',aud:'apes-gateway:review',repository:b.repository,event_name:'pull_request',repository_owner_id:'77',repository_id:String(i+99),run_id:b.runId,run_attempt:b.attempt,sha:sha('9'),workflow_sha:b.pipelineSha,ref:'refs/pull/'+b.prNumber+'/merge',job_workflow_ref:trusted[i].jobWorkflowRef});
 const verifyJwt=async(token)=>{if(token==='a')return claim(binding,0);if(token==='b')return claim(bindingB,1);throw Error('bad token');};
 const dispatch=createAuthorizedMockDispatch({service:svc,verifyJwt,grants:trusted});
 return {dispatch,ledgers,trusted,calls:()=>calls};
}
test('authenticated mock dispatch reserves and settles Numerra without spending another repo budget',async()=>{
 const f=fixture();
 const result=await f.dispatch({token:'a',binding,requestId:'req1',provider:'openai',model:'mock-openai'});
 assert.equal(result.mock,true);
 assert.equal(f.ledgers.get('a').remainingMicros(),8000000);
 assert.equal(f.ledgers.get('b').remainingMicros(),3000000);
 assert.equal(f.calls(),1);
});
test('rejects wrong repo token before transport or reservation',async()=>{
 const f=fixture();
 await assert.rejects(f.dispatch({token:'b',binding,requestId:'req2',provider:'openai',model:'mock-openai'}),/IDENTITY_DENIED/);
 assert.equal(f.calls(),0);assert.equal(f.ledgers.get('a').remainingMicros(),10000000);
});
test('denies invalid token and unknown grant binding',async()=>{
 const f=fixture();
 await assert.rejects(f.dispatch({token:'bad',binding,requestId:'req',provider:'openai',model:'mock-openai'}),/IDENTITY_DENIED/);
 await assert.rejects(f.dispatch({token:'a',binding:{...binding,attempt:'2'},requestId:'req',provider:'openai',model:'mock-openai'}),/GRANT_DENIED/);
 assert.equal(f.calls(),0);
});
test('replay refused and provider-specific policy enforced',async()=>{
 const f=fixture();
 await f.dispatch({token:'a',binding,requestId:'one',provider:'openai',model:'mock-openai'});
 await assert.rejects(f.dispatch({token:'a',binding,requestId:'one',provider:'openai',model:'mock-openai'}),/DUPLICATE_REQUEST/);
 await assert.rejects(f.dispatch({token:'a',binding,requestId:'two',provider:'gemini',model:'mock-gemini'}),/MODEL_NOT_APPROVED/);
 assert.equal(f.calls(),1);
});
test('fail closed on trusted GitHub confirmation outage',async()=>{
 const f=fixture();f.trusted[0].confirmGitHubBinding=async()=>{throw Error('unavailable');};
 // Rebuild rather than rely on mutating trusted configuration after creation.
 const g=fixture();const grants=g.trusted.map(x=>({...x,confirmGitHubBinding:async()=>false}));
 const bridge=createAuthorizedMockDispatch({service:{dispatch:async()=>{throw Error('must not dispatch');}},verifyJwt:async()=>({}),grants});
 await assert.rejects(bridge({token:'a',binding,requestId:'no',provider:'openai',model:'mock-openai'}),/IDENTITY_DENIED/);
});
test('same run cannot receive ambiguous trusted grants',()=>{
 const f=fixture();
 assert.throws(()=>createAuthorizedMockDispatch({service:{dispatch:async()=>{}},verifyJwt:async()=>({}),grants:[f.trusted[0],{...f.trusted[0],grantId:'other'}]}),/GRANT_DENIED/);
});
