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
