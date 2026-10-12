'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SqliteApprovalNonceStore}=require('../gateway/sqlite-approval-nonce-store');
function temporary(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apes-nonce-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return path.join(dir,'nonce.db');
}
test('nonce is consumed exactly once across separate database connections',async t=>{
 const filename=temporary(t),a=new SqliteApprovalNonceStore(filename),b=new SqliteApprovalNonceStore(filename);
 t.after(()=>{a.close();b.close();});
 const outcomes=await Promise.all([a.consumeNonce('nonce-1',123456),b.consumeNonce('nonce-1',123456)]);
 assert.deepEqual(outcomes.sort(),[false,true]);
 assert.equal(await b.consumeNonce('nonce-1',123456),false);
});
test('nonce survives close and reopen; even past expiry cannot be reused',async t=>{
 const filename=temporary(t),a=new SqliteApprovalNonceStore(filename);
 assert.equal(await a.consumeNonce('nonce-2',1),true);a.close();
 const b=new SqliteApprovalNonceStore(filename);t.after(()=>b.close());
 assert.equal(await b.consumeNonce('nonce-2',999999),false);
});
test('rejects invalid nonce and unsafe database path',async t=>{
 const filename=temporary(t),s=new SqliteApprovalNonceStore(filename);t.after(()=>s.close());
 await assert.rejects(s.consumeNonce('../evil',10),/NONCE_INVALID/);
 await assert.rejects(s.consumeNonce('valid',-1),/NONCE_INVALID/);
 assert.throws(()=>new SqliteApprovalNonceStore(':memory:'),/NONCE_UNSAFE_PATH/);
});
