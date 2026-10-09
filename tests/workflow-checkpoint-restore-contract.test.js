const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('checkpoint recovery selects same-workflow artifacts and observes restore failures', () => {
  const yaml = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/ai-review.yml'), 'utf8');
  assert.match(yaml, /actions\/workflows\/\$workflow_id\/runs\?event=pull_request&head_sha=\$HEAD_SHA/);
  assert.match(yaml, /if \[\[ "\$RUN_ATTEMPT" -gt 1 \]\] && has_artifact "\$CURRENT_RUN_ID"/);
  assert.match(yaml, /select\(any\(\.pull_requests\[\]\?; \.number == \$pr\)\)/);
  assert.match(yaml, /\.expired == false/);
  assert.match(yaml, /Restore verified checkpoint artifact/);
  assert.doesNotMatch(yaml, /continue-on-error:\s*true/);
  assert.match(yaml, /overwrite: true/);
});

test('checkpoint discovery validates GitHub response schema and propagates jq errors', () => {
  const yaml = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/ai-review.yml'), 'utf8');
  assert.match(yaml, /Malformed GitHub artifact response/);
  assert.match(yaml, /Invalid workflow runs response/);
  assert.match(yaml, /candidates="\$\(jq -er/);
  assert.match(yaml, /select\(\.head_sha == \$head\)/);
  assert.doesNotMatch(yaml, /done < <\(jq /);
  assert.match(yaml, /done <<< "\$candidates"/);
});

test('all APES review jobs share a PR-scoped concurrency group', () => {
  const yaml = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/ai-review.yml'), 'utf8');
  const group = yaml.match(/^concurrency:\n  group: ([^\n]+)\n  cancel-in-progress: true/m);
  assert.ok(group, 'the entire reusable workflow must use a shared cancellation group');
  assert.match(group[1], /github\.repository/);
  assert.match(group[1], /github\.event\.pull_request\.number/);
  const ai = yaml.slice(yaml.indexOf('  ai-review:'), yaml.indexOf('  quality-gate:'));
  assert.match(ai, /pull-requests: write/);
  assert.doesNotMatch(ai, /^    concurrency:/m, 'AI review must not override the workflow-wide PR lock');
});
