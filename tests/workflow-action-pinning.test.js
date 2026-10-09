const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('AI review workflow only uses immutable action SHAs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ai-review.yml'), 'utf8');
  const entries = [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(entries.length > 0, 'workflow must contain action references');
  for (const entry of entries) {
    assert.match(entry, /^[^@\s]+@[0-9a-f]{40}$/, `mutable action reference: ${entry}`);
  }
});
