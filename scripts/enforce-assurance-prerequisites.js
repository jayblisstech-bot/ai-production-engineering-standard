#!/usr/bin/env node
const path = require('path');
const { loadConfig } = require('./lib');

function evaluatePrerequisites({ config, validationOutcome, dependencyStatus }) {
  const failures = [];

  if (config.security.assurance.mode === 'enforce' && validationOutcome !== 'success') {
    failures.push('Repository-native validation did not succeed while security.assurance.mode=enforce.');
  }

  if (
    config.security.dependencyAudit === 'required' &&
    !['passed', 'success'].includes(String(dependencyStatus || '').toLowerCase())
  ) {
    failures.push('Required dependency audit did not pass.');
  }

  return { pass: failures.length === 0, failures };
}

function main() {
  const projectRoot = path.resolve(process.env.PROJECT_ROOT || process.cwd());
  const config = loadConfig(projectRoot, process.env.APES_CONFIG_PATH || '.apes.json');
  const result = evaluatePrerequisites({
    config,
    validationOutcome: process.env.VALIDATION_OUTCOME || 'unknown',
    dependencyStatus: process.env.DEPENDENCY_STATUS || 'unknown',
  });

  if (!result.pass) {
    for (const failure of result.failures) console.error('APES prerequisite gate: ' + failure);
    process.exit(1);
  }
  console.log('APES prerequisite gate passed.');
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.stack || err.message); process.exit(1); }
}

module.exports = { evaluatePrerequisites };
