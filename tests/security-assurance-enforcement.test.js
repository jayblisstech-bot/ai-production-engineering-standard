const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG } = require('../scripts/lib');
const { evaluateAssurance } = require('../scripts/security-assurance-audit');

function config(mode) {
  const c = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  c.security.assurance.mode = mode;
  c.security.assurance.failOnSeverities = ['P0', 'P1'];
  return c;
}

const resultWithP1 = {
  findings: [{ severity: 'P1', id: 'TEST', layer: 1, path: 'src/a.js', line: 1, message: 'test' }]
};

test('audit mode records blocking-severity findings without failing', () => {
  const r = evaluateAssurance(resultWithP1, config('audit'));
  assert.equal(r.blocking.length, 1);
  assert.equal(r.shouldFail, false);
});

test('enforce mode fails closed on configured blocking severity', () => {
  const r = evaluateAssurance(resultWithP1, config('enforce'));
  assert.equal(r.blocking.length, 1);
  assert.equal(r.shouldFail, true);
});

test('enforce mode does not fail on severities outside configured threshold', () => {
  const result = { findings: [{ severity: 'P2', id: 'TEST', layer: 3, path: 'src/a.js', line: 1, message: 'test' }] };
  const r = evaluateAssurance(result, config('enforce'));
  assert.equal(r.blocking.length, 0);
  assert.equal(r.shouldFail, false);
});

test('required security header policy blocks even while legacy assurance is in audit mode', () => {
  const c = config('audit');
  c.security.headers.mode = 'required';
  const result = { findings: [{ severity: 'P1', id: 'SECURITY_HEADERS_INCOMPLETE', policy: 'security-headers', layer: 3, path: '<repository>', line: 1, message: 'missing' }] };
  const r = evaluateAssurance(result, c);
  assert.equal(r.shouldFail, true);
  assert.equal(r.headerBlocking.length, 1);
});

test('security header audit mode records but does not block legacy onboarding', () => {
  const c = config('audit');
  c.security.headers.mode = 'audit';
  const result = { findings: [{ severity: 'P1', id: 'SECURITY_HEADERS_INCOMPLETE', policy: 'security-headers', layer: 3, path: '<repository>', line: 1, message: 'missing' }] };
  const r = evaluateAssurance(result, c);
  assert.equal(r.shouldFail, false);
});
