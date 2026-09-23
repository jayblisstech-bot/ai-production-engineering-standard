const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateResponseHeaders } = require('../scripts/check-security-headers');

const good = {
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};

test('runtime security-header verifier passes strong baseline', () => {
  const result = evaluateResponseHeaders(good);
  assert.equal(result.pass, true);
  assert.deepEqual(result.failures, []);
});

test('runtime verifier fails when core headers are absent', () => {
  const result = evaluateResponseHeaders({});
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((x) => /Content-Security-Policy/.test(x)));
  assert.ok(result.failures.some((x) => /Strict-Transport-Security/.test(x)));
  assert.ok(result.failures.some((x) => /Permissions-Policy/.test(x)));
});

test('runtime verifier rejects weak HSTS and unsafe referrer policy', () => {
  const result = evaluateResponseHeaders({
    ...good,
    'strict-transport-security': 'max-age=300',
    'referrer-policy': 'unsafe-url'
  });
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((x) => /max-age/.test(x)));
  assert.ok(result.failures.some((x) => /unsafe-url/.test(x)));
});

test('X-Frame-Options SAMEORIGIN satisfies frame protection when CSP lacks frame-ancestors', () => {
  const result = evaluateResponseHeaders({
    ...good,
    'content-security-policy': "default-src 'self'",
    'x-frame-options': 'SAMEORIGIN'
  });
  assert.equal(result.pass, true);
});
