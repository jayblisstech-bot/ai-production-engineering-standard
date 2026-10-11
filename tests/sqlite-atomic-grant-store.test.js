'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SqliteAtomicGrantStore}=require('../gateway/sqlite-atomic-grant-store');
const binding={repository:'example/numerra',prNumber:'11',runId:'12345',attempt:'1',
headSha:'a'.repeat(40),baseSha:'b'.repeat(40),pipelineSha:'c'.repeat(40)};
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apes-atomic-grant-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'grant.db');}
const args={grantId:'grant-numerra',binding,capUsd:'10',nonce:'nonce-001',expiresAt:1800000000000,approved:true};
test('atomic issuance is durable and single-use across connections',t=>{
 const file=setup(t),a=new SqliteAtomicGrantStore(file),b=new SqliteAtomicGrantStore(file);
 t.after(()=>{a.close();b.close();});
 assert.equal(a.issueApproved(args).capMicros,10000000);
 assert.equal(b.getGrant(args.grantId).cap_micros,10000000);
 assert.throws(()=>b.issueApproved(args),/ATOMIC_GRANT_DENIED/);
 assert.equal(b.getGrant(args.grantId).binding_key,JSON.stringify(binding));
});
test('failed duplicate grant insertion rolls back consumed nonce',t=>{
 const file=setup(t),s=new SqliteAtomicGrantStore(file);t.after(()=>s.close());
 s.issueApproved(args);
 assert.throws(()=>s.issueApproved({...args,nonce:'nonce-unused'}),/UNIQUE constraint failed/);
 assert.equal(s.getGrant(args.grantId).approval_nonce,args.nonce);
 // The failed nonce can be used by a separately authorized grant because its insert rolled back.
 assert.equal(s.issueApproved({...args,grantId:'separate-grant',nonce:'nonce-unused'}).grantId,'separate-grant');
});
test('rejects unauthorized, invalid caps and nonce tampering before write',t=>{
 const file=setup(t),s=new SqliteAtomicGrantStore(file);t.after(()=>s.close());
 for(const change of [{approved:false},{capUsd:'0'},{nonce:'../bad'},{binding:{...binding,headSha:'wrong'}}]){
  assert.throws(()=>s.issueApproved({...args,...change}));
 }
 assert.equal(s.getGrant(args.grantId),undefined);
});
test('committed grant survives process restart and replay stays denied',t=>{
 const file=setup(t),a=new SqliteAtomicGrantStore(file);a.issueApproved(args);a.close();
 const b=new SqliteAtomicGrantStore(file);t.after(()=>b.close());
 assert.equal(b.getGrant(args.grantId).cap_micros,10000000);
 assert.throws(()=>b.issueApproved({...args,grantId:'alternate'}),/ATOMIC_GRANT_DENIED/);
});
