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

test('mixed context/remove/add hunks retain old and new line positions', () => {
  const header = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n';
  const body = [' unchanged\n', '-removed\n',
    ...Array.from({ length: 100 }, (_, i) => '+added_' + i + '\n'),
    ' another-context\n'];
  const diff = header + '@@ -10,3 +10,102 @@\n' + body.join('');
  const chunks = chunkDiff(diff, 800, 30);
  assert.ok(chunks.length > 1);
  let oldLine = 10;
  let newLine = 10;
  const restored = [];
  for (const chunk of chunks) {
    const match = chunk.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/m);
    assert.ok(match);
    assert.equal(Number(match[1]), oldLine);
    assert.equal(Number(match[3]), newLine);
    oldLine += Number(match[2]);
    newLine += Number(match[4]);
    restored.push(...chunk.slice(chunk.indexOf('\n@@ ') + 1).split('\n').slice(1, -1).map(line => line + '\n'));
  }
  assert.equal(oldLine, 13);
  assert.equal(newLine, 112);
  assert.deepEqual(restored, body);
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

test('bounded first-fit packing reviews all independent sections inside the existing chunk cap', () => {
  const fileSection = (i, size) => {
    const prefix = 'diff --git a/f' + i + ' b/f' + i + '\n'
      + '--- a/f' + i + '\n+++ b/f' + i + '\n'
      + '@@ -0,0 +1,1 @@\n+';
    return prefix + 'x'.repeat(size - prefix.length - 1) + '\n';
  };
  const parts = [600, 600, 600, 300, 300, 300].map((size, i) => fileSection(i, size));
  const result = chunkDiff(parts.join(''), 1000, 3);
  assert.equal(result.length, 3, 'each 600-character section pairs with a 300-character section');
  assert.ok(result.every((chunk) => chunk.length <= 1000));
  for (let i = 0; i < parts.length; i++) {
    const marker = 'diff --git a/f' + i + ' b/f' + i;
    assert.equal(result.reduce((sum, chunk) => sum + chunk.split(marker).length - 1, 0), 1,
      'no section may be lost or duplicated');
  }
  assert.deepEqual(chunkDiff(parts.join(''), 1000, 3), result, 'packing must be deterministic');
});

test('small ordinary diffs remain unchanged', () => {
  const diff = 'diff --git a/example.txt b/example.txt\n'
    + '--- a/example.txt\n+++ b/example.txt\n'
    + '@@ -1 +1 @@\n-old\n+new\n';
  assert.deepEqual(chunkDiff(diff, 850, 12), [diff]);
});
