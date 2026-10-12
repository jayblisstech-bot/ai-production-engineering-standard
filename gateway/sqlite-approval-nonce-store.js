'use strict';
/** Local mock durable nonce consumption. Node 24+; no hosted guarantees. */
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const NONCE=/^[A-Za-z0-9._:-]{1,128}$/;
class SqliteApprovalNonceStore {
 constructor(filename){
  if(typeof filename!=='string'||!path.isAbsolute(filename)||filename===':memory:')throw Error('APES_NONCE_UNSAFE_PATH');
  if(fs.existsSync(filename)){
   const stat=fs.lstatSync(filename);
   if(stat.isSymbolicLink()||!stat.isFile())throw Error('APES_NONCE_UNSAFE_PATH');
  }
  this.db=new DatabaseSync(filename);
  if(process.platform!=='win32')fs.chmodSync(filename,0o600);
  this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  this.db.exec('CREATE TABLE IF NOT EXISTS approval_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
 }
 async consumeNonce(nonce,expiresAt){
  if(typeof nonce!=='string'||!NONCE.test(nonce)||!Number.isSafeInteger(expiresAt)||expiresAt<=0)throw Error('APES_NONCE_INVALID');
  // No expired nonce deletion: reuse remains denied for ledger lifetime.
  const result=this.db.prepare('INSERT OR IGNORE INTO approval_nonces(nonce,expires_at) VALUES (?,?)').run(nonce,expiresAt);
  return result.changes===1;
 }
 close(){if(this.db){this.db.close();this.db=null;}}
}
module.exports={SqliteApprovalNonceStore};
