const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const mutations = [
  { name: 'resume skip', file: 'scripts/call-review-gateway.js', test: 'tests/main-resume-integration.test.js', old: 'if (saved) {', replacement: 'if (false && saved) {' },
  { name: 'checkpoint commit', file: 'scripts/call-review-gateway.js', test: 'tests/main-resume-integration.test.js', old: 'checkpoint.commit(i, { findings: normalized.findings, providers: providerRoute });', replacement: '/* mutation: skipped durable commit */' },
  { name: 'context compaction', file: 'scripts/call-review-gateway.js', test: 'tests/main-context-compaction-integration.test.js', old: 'reviewContext = compactReviewContext(reviewContext, nextLimit);', replacement: '/* mutation: no context compaction */' },
  { name: 'finding deduplication', file: 'scripts/call-review-gateway.js', test: 'tests/main-publication-resume-integration.test.js', old: 'if (markers.has(fingerprint)) return false;', replacement: 'if (false) return false;' },
  { name: 'checkpoint plan identity', file: 'scripts/review-checkpoint.js', test: 'tests/review-checkpoint.test.js', old: 'parsed.planHash !== this.planHash', replacement: 'false' },
  { name: 'finding pagination', file: 'scripts/call-review-gateway.js', test: 'tests/review-checkpoint.test.js', old: 'if (comments.length < 100) break;', replacement: 'break;' },
  { name: 'finding head SHA', file: 'scripts/call-review-gateway.js', test: 'tests/review-checkpoint.test.js', old: 'comment.commit_id === headSha &&', replacement: 'true &&' },
];

function executeTest(testFile, mutation) {
  const directory = fs.mkdtempSync(path.join(root, '.apes-mutation-'));
  try {
    fs.cpSync(path.join(root, 'scripts'), path.join(directory, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'tests'));
    fs.copyFileSync(path.join(root, testFile), path.join(directory, testFile));
    if (mutation) {
      const target = path.join(directory, mutation.file);
      const original = fs.readFileSync(target, 'utf8');
      assert.ok(original.includes(mutation.old), 'Mutation anchor disappeared: ' + mutation.name);
      fs.writeFileSync(target, original.replace(mutation.old, mutation.replacement));
    }
    return spawnSync(process.execPath, ['--test', path.join(directory, testFile)], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST_'))), APES_MUTATION_TEST: 'true' },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('critical orchestration mutation checks detect the deliberate regressions', () => {
  const testFiles = [...new Set(mutations.map((item) => item.test))];
  for (const file of testFiles) {
    const baseline = executeTest(file);
    assert.equal(baseline.status, 0, 'Mutation baseline must pass for ' + file + ':\n' + baseline.stdout + '\n' + baseline.stderr);
  }
  for (const mutation of mutations) {
    const result = executeTest(mutation.test, mutation);
    assert.equal(result.status, 1, 'Mutation survived: ' + mutation.name + '\n' + result.stdout + '\n' + result.stderr);
    assert.match(result.stdout + result.stderr, /not ok/, 'Mutation must be caught by a substantive failing test: ' + mutation.name);
  }
});
