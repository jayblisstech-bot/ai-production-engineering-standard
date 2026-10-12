'use strict';
/**
 * Pinned GitHub Actions OIDC verifier. No provider keys or paid transport.
 * The caller MUST additionally verify the PR/base/head and grant through an
 * independently authenticated GitHub API lookup before granting access.
 */
const crypto = require('node:crypto');
const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = ISSUER + '/.well-known/jwks';
const MAX_JWT_BYTES = 8192;
const MAX_JWKS_BYTES = 65536;
function deny() { throw new Error('APES_GATEWAY_JWT_DENIED'); }
function decodePart(part) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part)) deny();
  const buffer = Buffer.from(part, 'base64url');
  if (buffer.toString('base64url') !== part) deny();
  try { return JSON.parse(buffer.toString('utf8')); } catch (_) { deny(); }
}
function checkTime(value, now, leeway, future) {
  return Number.isSafeInteger(value) && (future ? value <= now + leeway : value > now - leeway);
}
function createGitHubOidcVerifier({ fetchJwks, nowSeconds = () => Math.floor(Date.now() / 1000), maxAgeSeconds = 300 }) {
  if (typeof fetchJwks !== 'function' || typeof nowSeconds !== 'function' ||
      !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 600) deny();
  return async function verifyJwt(token, { issuer, audience }) {
    if (issuer !== ISSUER || typeof audience !== 'string' || !audience.startsWith('apes-gateway:') ||
        typeof token !== 'string' || token.length > MAX_JWT_BYTES || token.length < 30) deny();
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) deny();
    const header = decodePart(parts[0]);
    if (!header || typeof header !== 'object' || Array.isArray(header) ||
        header.alg !== 'RS256' || typeof header.kid !== 'string' ||
        !/^[A-Za-z0-9._-]{1,256}$/.test(header.kid) ||
        (header.typ !== undefined && header.typ !== 'JWT') ||
        header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined ||
        header.x5u !== undefined) deny();
    // Fetch implementation must enforce TLS trust, bounded timeouts, response
    // size and only the pinned URL. Never use an untrusted token-supplied URL.
    let jwks;
    try { jwks = await fetchJwks(JWKS_URL); } catch (_) { deny(); }
    if (typeof jwks === 'string') {
      if (Buffer.byteLength(jwks, 'utf8') > MAX_JWKS_BYTES) deny();
      try { jwks = JSON.parse(jwks); } catch (_) { deny(); }
    }
    if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length > 64) deny();
    const keys = jwks.keys.filter(k => k && k.kid === header.kid && k.kty === 'RSA' &&
      (k.alg === undefined || k.alg === 'RS256') && (k.use === undefined || k.use === 'sig') &&
      typeof k.n === 'string' && typeof k.e === 'string');
    if (keys.length !== 1) deny();
    let key;
    try { key = crypto.createPublicKey({ key: { kty:'RSA', n:keys[0].n, e:keys[0].e }, format:'jwk' }); }
    catch (_) { deny(); }
    const sig = Buffer.from(parts[2], 'base64url');
    if (sig.toString('base64url') !== parts[2] || !crypto.verify('RSA-SHA256',
        Buffer.from(parts[0] + '.' + parts[1], 'ascii'), key, sig)) deny();
    const claims = decodePart(parts[1]);
    const now = nowSeconds(), leeway = 30;
    if (!claims || typeof claims !== 'object' || Array.isArray(claims) ||
        claims.iss !== ISSUER || claims.aud !== audience ||
        !Number.isSafeInteger(now) || !checkTime(claims.exp, now, leeway, false) ||
        !checkTime(claims.iat, now, leeway, true) ||
        claims.iat < now - maxAgeSeconds - leeway ||
        (claims.nbf !== undefined && !checkTime(claims.nbf, now, leeway, true)) ||
        claims.exp <= claims.iat || claims.exp - claims.iat > 900) deny();
    return claims;
  };
}
module.exports = { createGitHubOidcVerifier, ISSUER, JWKS_URL };
