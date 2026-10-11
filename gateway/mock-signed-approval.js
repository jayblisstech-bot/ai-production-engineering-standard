'use strict';
/**
 * MOCK-ONLY signed approval verification. HMAC secret is gateway-owned.
 * Replay prevention requires an atomic durable consumeNonce implementation.
 * No HTTP endpoint, provider calls or production key custody is supplied.
 */
const crypto=require('node:crypto');
const { assertBinding, bindingKey, parseCapUsd }=require('../scripts/review-dollar-budget');
const ID=/^[A-Za-z0-9._:-]{1,128}$/;
function deny(){throw new Error('APES_GRANT_APPROVAL_DENIED');}
function canonical({grantId,binding,capUsd,nonce,expiresAt}){
 if(typeof grantId!=='string'||!ID.test(grantId)||typeof nonce!=='string'||!ID.test(nonce)||
    !Number.isSafeInteger(expiresAt)||expiresAt<=0) deny();
 let run,cap;
 try{run=assertBinding(binding);cap=parseCapUsd(capUsd);}catch(_){deny();}
 return {grantId,binding:run,capMicros:cap,nonce,expiresAt};
}
function signature(key,payload){
 return crypto.createHmac('sha256',key).update(JSON.stringify([
  'apes-owner-grant-v1',payload.grantId,bindingKey(payload.binding),
  payload.capMicros,payload.nonce,payload.expiresAt
 ])).digest('hex');
}
function createMockApprovalVerifier({secret,consumeNonce,now=()=>Date.now()}){
 if(!Buffer.isBuffer(secret)||secret.length<32||typeof consumeNonce!=='function'||typeof now!=='function')deny();
 const key=Buffer.from(secret);
 return async function authorizeOwner({approval,grantId,binding,capMicros}){
  if(!approval||typeof approval!=='object'||Array.isArray(approval)||
     typeof approval.capUsd!=='string'||typeof approval.mac!=='string'|| !/^[0-9a-f]{64}$/.test(approval.mac))deny();
  const payload=canonical({grantId:approval.grantId,binding:approval.binding,capUsd:approval.capUsd,
    nonce:approval.nonce,expiresAt:approval.expiresAt});
  if(payload.grantId!==grantId||bindingKey(payload.binding)!==bindingKey(assertBinding(binding))||
     payload.capMicros!==capMicros)deny();
  const timestamp=now();
  if(!Number.isSafeInteger(timestamp)||payload.expiresAt<=timestamp||
     payload.expiresAt>timestamp+10*60*1000)deny();
  const expected=Buffer.from(signature(key,payload),'hex');
  if(!crypto.timingSafeEqual(expected,Buffer.from(approval.mac,'hex')))deny();
  // This MUST be an atomic persistent insert-if-absent in deployment.
  let consumed=false;
  try{consumed=await consumeNonce(payload.nonce,payload.expiresAt);}catch(_){deny();}
  if(consumed!==true)deny();
  return true;
 };
}
function signMockApproval({secret,grantId,binding,capUsd,nonce,expiresAt}){
 if(!Buffer.isBuffer(secret)||secret.length<32)deny();
 const payload=canonical({grantId,binding,capUsd,nonce,expiresAt});
 return Object.freeze({...payload,capUsd,mac:signature(secret,payload)});
}
module.exports={createMockApprovalVerifier,signMockApproval};
