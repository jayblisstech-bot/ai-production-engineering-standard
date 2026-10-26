'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('required APES Self-Test remains one stable check context with independent actionlint enforcement', () => {
  const workflow = read('.github/workflows/self-test.yml');
  assert.match(workflow, /^name: APES Self-Test$/m);
  assert.match(workflow, /^    name: APES Self-Test$/m);
  assert.match(workflow, /^  pull_request:$/m);
  assert.match(workflow, /Lint workflows \(pinned actionlint\)/);
  assert.match(workflow, /actionlint_\$\{ACTIONLINT_VERSION\}_linux_amd64\.tar\.gz/);
  assert.match(workflow, /sha256sum -c -/);
  assert.match(workflow, /Linter rejects known-bad workflow/);
  assert.match(workflow, /node-version: ['"]?20['"]?/);
  assert.match(workflow, /node-version: ['"]?24['"]?/);
  assert.match(workflow, /Tests on Node 20/);
  assert.match(workflow, /Tests on Node 24/);
  assert.doesNotMatch(workflow, /^    matrix:/m, 'check name must not become matrix-suffixed');
});

test('diff chunk regression runs for every PR against main and validates YAML', () => {
  const workflow = read('.github/workflows/ai-diff-chunking-tests.yml');
  const eventBlock = workflow.split(/\npermissions:/)[0];
  assert.match(eventBlock, /pull_request:\s*\n\s*branches:\s*\n\s*- main/);
  assert.doesNotMatch(eventBlock, /\bpaths(?:-ignore)?:/, 'required PR checks cannot have path filters');
  assert.match(workflow, /Safe diff chunking and fail-closed tests/);
  assert.match(workflow, /run: \|\n\s+ruby -e/);
});

test('negative linter fixture retains a YAML parse defect and is not an active workflow', () => {
  const fixturePath = path.join(root, 'tests/fixtures/invalid-workflow.yml');
  const fixture = fs.readFileSync(fixturePath, 'utf8');
  assert.match(fixture, /- run: ruby -e "require 'yaml'; YAML\.load_file\('fixture\.yml', aliases: true\)"/);
  assert.ok(!fixturePath.includes('/.github/workflows/'));
});
