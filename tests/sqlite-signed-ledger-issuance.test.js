'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SqliteBudgetStore}=require('../gateway/sqlite-budget-store');
const {signMockApproval,createSynchronousApprovalSignatureVerifier}=require('../gateway/mock-signed-approval');
const binding={repository:'example/numerra',prNumber:'11',runId:'12345',attempt:'1',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),pipelineSha:'c'.repeat(40)};
const secret=Buffer.alloc(32,9),now=Date.now();
const base={grantId:'review-1',binding,capUsd:'10',nonce:'approval-1',expiresAt:now+60000};
const sign=(p)=>signMockApproval({secret,...p});
const args={...base,approval:sign(base),verifyApproval:createSynchronousApprovalSignatureVerifier({secret,now:()=>now})};
function db(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apes-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'ledger.sqlite');}
test('trusted approval and actual spend grant share one atomic ledger transaction',t=>{
 const file=db(t),s=new SqliteBudgetStore(file);t.after(()=>s.close());
 assert.equal(s.issueSignedGrant(args).limitMicros,10000000);
 assert.equal(s.snapshot(args.grantId,binding).remainingMicros,10000000);
 s.reserve({grantId:args.grantId,binding,requestId:'call-1',quoteMicros:2000000});
 assert.equal(s.snapshot(args.grantId,binding).remainingMicros,8000000);
});
test('replay nonce cannot mint a second grant after reopening',t=>{
 const file=db(t),a=new SqliteBudgetStore(file);a.issueSignedGrant(args);a.close();
 const b=new SqliteBudgetStore(file);t.after(()=>b.close());
 assert.throws(()=>b.issueSignedGrant({...args,grantId:'review-2',approval:sign({...base,grantId:'review-2'})}),/APPROVAL_REPLAY/);
 assert.throws(()=>b.snapshot('review-2',binding),/UNAUTHORIZED_GRANT/);
});
test('duplicate grant insertion rolls back claimed nonce',t=>{
 const file=db(t),s=new SqliteBudgetStore(file);t.after(()=>s.close());
 s.issueSignedGrant(args);
 assert.throws(()=>s.issueSignedGrant({...args,nonce:'unused-approval',approval:sign({...base,nonce:'unused-approval'})}),/UNIQUE constraint failed/);
 assert.equal(s.issueSignedGrant({...args,grantId:'review-2',nonce:'unused-approval',approval:sign({...base,grantId:'review-2',nonce:'unused-approval'})}).limitMicros,10000000);
});
test('unverified and asynchronous approval is refused before grant creation',t=>{
 const file=db(t),s=new SqliteBudgetStore(file);t.after(()=>s.close());
 assert.throws(()=>s.issueSignedGrant({...args,verifyApproval:()=>false}),/APPROVAL_DENIED/);
 assert.throws(()=>s.issueSignedGrant({...args,verifyApproval:async()=>true}),/APPROVAL_DENIED/);
 assert.throws(()=>s.snapshot(args.grantId,binding),/UNAUTHORIZED_GRANT/);
});

test('tampered signature and amount are refused before touching ledger',t=>{
 const file=db(t),s=new SqliteBudgetStore(file);t.after(()=>s.close());
 assert.throws(()=>s.issueSignedGrant({...args,approval:{...args.approval,mac:'0'.repeat(64)}}),/APPROVAL_DENIED/);
 assert.throws(()=>s.issueSignedGrant({...args,capUsd:'20'}),/APPROVAL_DENIED/);
 assert.throws(()=>s.snapshot(args.grantId,binding),/UNAUTHORIZED_GRANT/);
});
