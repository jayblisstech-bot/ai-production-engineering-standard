const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG } = require('../scripts/lib');
const { evaluatePrerequisites } = require('../scripts/enforce-assurance-prerequisites');

function config() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

test('audit mode may report repository validation failure without blocking', () => {
  const c = config();
  c.security.assurance.mode = 'audit';
  c.security.dependencyAudit = 'optional';
  const result = evaluatePrerequisites({ config: c, validationOutcome: 'failure', dependencyStatus: 'warning' });
  assert.equal(result.pass, true);
});

test('enforce mode fails closed when repository validation fails', () => {
  const c = config();
  c.security.assurance.mode = 'enforce';
  const result = evaluatePrerequisites({ config: c, validationOutcome: 'failure', dependencyStatus: 'passed' });
  assert.equal(result.pass, false);
  assert.match(result.failures.join(' '), /Repository-native validation/);
});

test('required dependency audit fails closed even while legacy assurance remains audit mode', () => {
  const c = config();
  c.security.assurance.mode = 'audit';
  c.security.dependencyAudit = 'required';
  const result = evaluatePrerequisites({ config: c, validationOutcome: 'success', dependencyStatus: 'failure' });
  assert.equal(result.pass, false);
  assert.match(result.failures.join(' '), /Required dependency audit/);
});

test('required dependency audit and enforce validation both pass when clean', () => {
  const c = config();
  c.security.assurance.mode = 'enforce';
  c.security.dependencyAudit = 'required';
  const result = evaluatePrerequisites({ config: c, validationOutcome: 'success', dependencyStatus: 'passed' });
  assert.equal(result.pass, true);
});
