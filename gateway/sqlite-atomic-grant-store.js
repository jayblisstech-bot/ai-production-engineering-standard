'use strict';
/**
 * MOCK-ONLY atomic approval-consumption + grant creation in ONE SQLite transaction.
 * Unlike separately calling consumeNonce() then createGrant(), this leaves
 * no consumed-but-unissued gap on crash/rollback. No real owner authentication.
 */
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {assertBinding,bindingKey,parseCapUsd}=require('../scripts/review-dollar-budget');
const ID=/^[A-Za-z0-9._:-]{1,128}$/;
function deny(){throw Error('APES_ATOMIC_GRANT_DENIED');}
class SqliteAtomicGrantStore{
 constructor(filename){
  if(typeof filename!=='string'||!path.isAbsolute(filename)||filename===':memory:')deny();
  if(fs.existsSync(filename)){const s=fs.lstatSync(filename);if(s.isSymbolicLink()||!s.isFile())deny();}
  this.db=new DatabaseSync(filename);
  if(process.platform!=='win32')fs.chmodSync(filename,0o600);
  this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  this.db.exec('CREATE TABLE IF NOT EXISTS consumed_approvals (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);');
  this.db.exec('CREATE TABLE IF NOT EXISTS issued_grants (grant_id TEXT PRIMARY KEY, binding_key TEXT NOT NULL, cap_micros INTEGER NOT NULL CHECK(cap_micros>0), approval_nonce TEXT NOT NULL UNIQUE REFERENCES consumed_approvals(nonce));');
 }
 issueApproved({grantId,binding,capUsd,nonce,expiresAt,approved}){
  if(approved!==true||typeof grantId!=='string'||!ID.test(grantId)||
     typeof nonce!=='string'||!ID.test(nonce)||!Number.isSafeInteger(expiresAt)||expiresAt<=0)deny();
  let run,amount;
  try{run=assertBinding(binding);amount=parseCapUsd(capUsd);}catch(_){deny();}
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const taken=this.db.prepare('INSERT OR IGNORE INTO consumed_approvals(nonce,expires_at) VALUES (?,?)').run(nonce,expiresAt);
   if(taken.changes!==1)deny();
   this.db.prepare('INSERT INTO issued_grants(grant_id,binding_key,cap_micros,approval_nonce) VALUES(?,?,?,?)')
    .run(grantId,bindingKey(run),amount,nonce);
   this.db.exec('COMMIT');
   return Object.freeze({grantId,capMicros:amount,binding:run});
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 getGrant(grantId){
  if(typeof grantId!=='string'||!ID.test(grantId))deny();
  return this.db.prepare('SELECT * FROM issued_grants WHERE grant_id=?').get(grantId);
 }
 close(){if(this.db){this.db.close();this.db=null;}}
}
module.exports={SqliteAtomicGrantStore};
