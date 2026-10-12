'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGitHubOidcVerifier, ISSUER, JWKS_URL } = require('../gateway/github-oidc-verifier');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({format:'jwk'});
const now = 1791750000, audience='apes-gateway:review';
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
function sign(overrides={}, headerOverrides={}) {
 const header=b64({alg:'RS256',kid:'test-1',typ:'JWT',...headerOverrides});
 const payload=b64({iss:ISSUER,aud:audience,iat:now-10,exp:now+200,...overrides});
 const message=header+'.'+payload;
 return message+'.'+crypto.sign('RSA-SHA256',Buffer.from(message),privateKey).toString('base64url');
}
function verifier(keys=[{...jwk,kid:'test-1',alg:'RS256',use:'sig'}]) {
 return createGitHubOidcVerifier({
  fetchJwks: async(url)=>{assert.equal(url,JWKS_URL);return {keys};}, nowSeconds:()=>now
 });
}
test('verifies signed, pinned GitHub OIDC JWT', async()=>{
 const claims=await verifier()(sign(),{issuer:ISSUER,audience});
 assert.equal(claims.iss,ISSUER);
});
for(const [name,changes] of [
 ['wrong audience',{aud:'attacker'}],['wrong issuer',{iss:'https://evil.invalid'}],
 ['expired',{exp:now-50}],['issued in future',{iat:now+50}],
 ['stale token',{iat:now-500}],['bad lifetime',{exp:now+1000}],
 ['future not-before',{nbf:now+50}],
]) test('rejects '+name,async()=>assert.rejects(verifier()(sign(changes),{issuer:ISSUER,audience}),/JWT_DENIED/));
test('rejects token-supplied JWK URL',async()=>assert.rejects(verifier()(sign({}, {jku:'https://evil.invalid/jwks'}),{issuer:ISSUER,audience}),/JWT_DENIED/));
test('rejects tampered JWT signature',async()=>{
 const parts=sign().split('.'); parts[1]=b64({iss:ISSUER,aud:audience,iat:now-10,exp:now+200,admin:true});
 await assert.rejects(verifier()(parts.join('.'),{issuer:ISSUER,audience}),/JWT_DENIED/);
});
test('rejects key mismatch, duplicate kid and JWKS errors',async()=>{
 const args={issuer:ISSUER,audience};
 await assert.rejects(verifier([])(sign(),args),/JWT_DENIED/);
 await assert.rejects(verifier([{...jwk,kid:'test-1'},{...jwk,kid:'test-1'}])(sign(),args),/JWT_DENIED/);
 await assert.rejects(createGitHubOidcVerifier({fetchJwks:async()=>{throw Error('offline');},nowSeconds:()=>now})(sign(),args),/JWT_DENIED/);
});
test('rejects unsupported signature algorithms and invalid verifier audience',async()=>{
 await assert.rejects(verifier()(sign({}, {alg:'none'}),{issuer:ISSUER,audience}),/JWT_DENIED/);
 await assert.rejects(verifier()(sign(),{issuer:ISSUER,audience:'untrusted'}),/JWT_DENIED/);
});
