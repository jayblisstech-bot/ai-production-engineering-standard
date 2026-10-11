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

test('small multiple hunks in one file can be separately packed without omission', () => {
  const file = (name, hunkSizes) => {
    const header = 'diff --git a/' + name + ' b/' + name + '\n'
      + '--- a/' + name + '\n+++ b/' + name + '\n';
    const hunks = hunkSizes.map((size, i) =>
      '@@ -' + i + ',0 +' + (i + 1) + ',1 @@\n+' + name + '_' + i + '_'
        + 'x'.repeat(size) + '\n');
    return header + hunks.join('');
  };
  const combined = file('multi', [380, 380]) + file('second', [425]) + file('third', [425]);
  const chunks = chunkDiff(combined, 1000, 2);
  assert.equal(chunks.length, 2, 'two individual multi-file hunks should fit remaining space');
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  for (const marker of ['+multi_0_', '+multi_1_', '+second_0_', '+third_0_']) {
    assert.equal(chunks.reduce((sum, chunk) => sum + chunk.split(marker).length - 1, 0), 1);
  }
});

test('small ordinary diffs remain unchanged', () => {
  const diff = 'diff --git a/example.txt b/example.txt\n'
    + '--- a/example.txt\n+++ b/example.txt\n'
    + '@@ -1 +1 @@\n-old\n+new\n';
  assert.deepEqual(chunkDiff(diff, 850, 12), [diff]);
});

test('AI review reduces unchanged context while deterministic scanners retain deep context', () => {
  const fs = require('node:fs');
  const workflow = fs.readFileSync(require('node:path').join(__dirname, '../.github/workflows/ai-review.yml'), 'utf8');
  const reviewMarker = '  ai-review:';
  assert.ok(workflow.includes(reviewMarker));
  const before = workflow.slice(0, workflow.indexOf(reviewMarker));
  const after = workflow.slice(workflow.indexOf(reviewMarker));
  assert.equal((before.match(/--unified=80/g) || []).length, 2,
    'secret scanning and deterministic gate must keep deep context');
  assert.ok(after.includes('git diff --no-ext-diff --unified=3'),
    'the AI reviewer must still receive a complete changed-line unified diff');
  assert.equal((after.match(/--unified=80/g) || []).length, 0);
});

test('repeated diff headers for the same file union right and left anchors', () => {
  const { diffLineIndex } = require('../scripts/lib');
  const header = 'diff --git a/repeated.ts b/repeated.ts\n--- a/repeated.ts\n+++ b/repeated.ts\n';
  const diff = header + '@@ -10,1 +10,1 @@\n-old10\n+new10\n'
    + header + '@@ -21,1 +21,1 @@\n-old21\n+new21\n';
  const lineIndex = diffLineIndex(diff);
  assert.deepEqual([...lineIndex.get('repeated.ts').RIGHT].sort((a,b)=>a-b), [10,21]);
  assert.deepEqual([...lineIndex.get('repeated.ts').LEFT].sort((a,b)=>a-b), [10,21]);
  const { addedLineIndex } = require('../scripts/lib');
  assert.deepEqual([...addedLineIndex(diff).get('repeated.ts')].sort((a,b)=>a-b), [10,21]);
});

test('hunk planner retains all added and removed anchors under token and chunk caps', () => {
  const { diffLineIndex } = require('../scripts/lib');
  const before = 'diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n';
  const body = Array.from({length:42},(_,i)=>'-removed_'+i+'\n+added_'+i+'\n').join('');
  const original = before+'@@ -1,42 +1,42 @@\n'+body;
  const chunks = chunkDiff(original, 500, 12, {maxTokens:125,charsPerToken:4});
  assert.ok(chunks.length>1);
  const actualR=new Set(), actualL=new Set();
  for(const chunk of chunks) {
    assert.ok(chunk.length<=500);
    const i=diffLineIndex(chunk).get('large.ts');
    assert.ok(i);
    for(const n of i.RIGHT) { assert.ok(!actualR.has(n),'added line must not be duplicated');actualR.add(n); }
    for(const n of i.LEFT) { assert.ok(!actualL.has(n),'removed line must not be duplicated');actualL.add(n); }
  }
  assert.deepEqual([...actualR].sort((a,b)=>a-b),Array.from({length:42},(_,i)=>i+1));
  assert.deepEqual([...actualL].sort((a,b)=>a-b),Array.from({length:42},(_,i)=>i+1));
});

test('integration leaves provider execution sequential and keeps deadline checkpoint controls', () => {
  const fs = require('node:fs'), path = require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../scripts/call-review-gateway.js'),'utf8');
  assert.match(source,/for \(let i = 0; i < chunks.length; i\+\+\)/);
  assert.match(source,/checkpoint\.commit\(i,/);
  assert.match(source,/deadlineMs: providerDeadlineMs/);
  assert.doesNotMatch(source,/review-chunk-executor|reviewConcurrency|maxConcurrentChunks/);
});
