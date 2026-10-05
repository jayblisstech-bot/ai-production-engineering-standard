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
  assert.ok(estimateTokens(chunks[0], 4) <= 35);
});

test('chunk planner creates separate logical chunks when token budget is exceeded', () => {
  const file = (name, body) => `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1,4 +1,4 @@\n+${body}\n`;
  const diff = file('a.js', 'a'.repeat(80)) + file('b.js', 'b'.repeat(80));
  const chunks = chunkDiff(diff, 1000, 4, { maxTokens: 45, charsPerToken: 4 });
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) assert.ok(estimateTokens(chunk, 4) <= 30);
});
