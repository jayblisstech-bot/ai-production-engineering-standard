const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const CENTRAL = 'jayblisstech-bot/ai-production-engineering-standard';
const RUNTIME_SHA = '4f02a1ed79fb972998623a62c05a254e0e450687';

test('reusable workflow checks out the canonical APES repository', () => {
  const workflow = fs.readFileSync('.github/workflows/ai-review.yml', 'utf8');
  assert.match(workflow, new RegExp(`repository: ${CENTRAL.replace('/', '\\/')}`));
  assert.doesNotMatch(workflow, /jflowdking212\/ai-engineering-pipeline/);
});

test('project template calls the canonical APES reusable workflow by reviewed SHA', () => {
  const caller = fs.readFileSync('templates/project-repo/.github/workflows/ai-review.yml', 'utf8');
  assert.match(caller, new RegExp(`${CENTRAL.replace('/', '\\/')}\\/.github\\/workflows\\/ai-review\\.yml@${RUNTIME_SHA}`));
  assert.doesNotMatch(caller, /jflowdking212\/ai-engineering-pipeline/);
});
