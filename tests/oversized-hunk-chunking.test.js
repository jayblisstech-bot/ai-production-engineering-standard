const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkDiff } = require('../scripts/call-review-gateway');

function lockfileLikePatch(lineCount) {
  const additions = Array.from({ length: lineCount }, (_, i) => '+' + JSON.stringify({
    package: 'dependency-' + String(i).padStart(4, '0'),
    integrity: 'synthetic-test-integrity-value-' + String(i).padStart(4, '0'),
  }) + '\n');
  const header = 'diff --git a/package-lock.json b/package-lock.json\n'
    + 'index aaaaaaa..bbbbbbb 100644\n'
    + '--- a/package-lock.json\n'
    + '+++ b/package-lock.json\n';
  return { diff: header + '@@ -0,0 +1,' + lineCount + ' @@\n' + additions.join(''), additions };
}

test('oversized lockfile hunk is reviewed in bounded complete line-preserving pieces', () => {
  const { diff, additions } = lockfileLikePatch(120);
  const chunks = chunkDiff(diff, 850, 30);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 850));
  assert.ok(chunks.every((chunk) => chunk.startsWith('diff --git a/package-lock.json b/package-lock.json\n')));
  const recovered = chunks.flatMap((chunk) => chunk.match(/^\+(?!\+\+ b\/).*$/gm) || [])
    .map((line) => line + '\n');
  assert.deepEqual(recovered, additions);
  let expectedNewLine = 1;
  for (const chunk of chunks) {
    const h = chunk.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/m);
    assert.ok(h, 'Each chunk retains a valid synthetic hunk header');
    assert.equal(Number(h[3]), expectedNewLine);
    const count = (chunk.match(/^\+(?!\+\+ b\/).*$/gm) || []).length;
    assert.equal(Number(h[4]), count);
    expectedNewLine += count;
  }
  assert.equal(expectedNewLine, additions.length + 1);
});

test('one oversized line still fails closed instead of truncating context', () => {
  const header = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n';
  const diff = header + '@@ -0,0 +1 @@\n+' + 'x'.repeat(1200) + '\n';
  assert.throws(() => chunkDiff(diff, 400, 20), /single diff line exceeds/);
});

test('configured maxChunks remains enforced after hunk splitting', () => {
  const { diff } = lockfileLikePatch(100);
  assert.throws(() => chunkDiff(diff, 600, 1), /configured maximum/);
});

test('small ordinary diffs remain unchanged', () => {
  const diff = 'diff --git a/example.txt b/example.txt\n'
    + '--- a/example.txt\n+++ b/example.txt\n'
    + '@@ -1 +1 @@\n-old\n+new\n';
  assert.deepEqual(chunkDiff(diff, 850, 12), [diff]);
});
