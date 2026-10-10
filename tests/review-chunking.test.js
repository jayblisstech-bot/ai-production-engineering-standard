const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkDiff, estimateTokens } = require('../scripts/call-review-gateway');

test('chunk planner preserves file boundaries and enforces a token budget', () => {
  const diff = [
    'diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -1,4 +1,4 @@\n+const a = 1;\n',
    'diff --git a/b.js b/b.js\nindex 1..2 100644\n--- a/b.js\n+++ b/b.js\n@@ -1,4 +1,4 @@\n+const b = 2;\n',
    'diff --git a/c.js b/c.js\nindex 1..2 100644\n--- a/c.js\n+++ b/c.js\n@@ -1,4 +1,4 @@\n+const c = 3;\n'
  ].join('');
  const chunks = chunkDiff(diff, 10000, 3, { maxTokens: 80, charsPerToken: 4 });
  assert.equal(chunks.length, 1);
  assert.ok(estimateTokens(chunks[0], 4) <= 80);
});

test('chunk planner creates separate logical chunks when token budget is exceeded', () => {
  const file = (name, body) => `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1,4 +1,4 @@\n+${body}\n`;
  const diff = file('a.js', 'a'.repeat(80)) + file('b.js', 'b'.repeat(80));
  const chunks = chunkDiff(diff, 1000, 4, { maxTokens: 45, charsPerToken: 4 });
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) assert.ok(estimateTokens(chunk, 4) <= 45);
});

test('oversized multi-hunk file splits at the effective token budget without losing diff content', () => {
  const header = 'diff --git a/big.js b/big.js\nindex 1..2 100644\n--- a/big.js\n+++ b/big.js\n';
  const hunks = Array.from({ length: 5 }, (_, i) => `@@ -${i + 1},1 +${i + 1},1 @@\n+${String(i).repeat(90)}\n`);
  const chunks = chunkDiff(header + hunks.join(''), 1500, 12, { maxTokens: 70, charsPerToken: 4 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 280);
    assert.ok(estimateTokens(chunk, 4) <= 70);
    assert.ok(chunk.startsWith(header));
  }
  const restored = chunks.map((chunk) => chunk.slice(header.length)).join('');
  assert.equal(restored, hunks.join(''));
});
for (const options of [
  { maxTokens: 0, charsPerToken: 4 },
  { maxTokens: Infinity, charsPerToken: 4 },
  { maxTokens: 100, charsPerToken: 0 },
  { maxTokens: 100, charsPerToken: NaN },
]) {
  test('chunk planner rejects unsafe token configuration ' + JSON.stringify(options), () => {
    assert.throws(() => chunkDiff('diff --git a/a b/a\n+x', 500, 12, options), /must be/);
  });
}
