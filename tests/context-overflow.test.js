const test = require('node:test');
const assert = require('node:assert/strict');
const { callOpenAI } = require('../scripts/provider-clients');
const { GeminiCredentialPool } = require('../scripts/gemini-credential-pool');
const { compactReviewContext } = require('../scripts/call-review-gateway');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
    json: async () => ({})
  };
}

test('provider client classifies context-window overflow without provider fallback', async () => {
  const oldFetch = global.fetch;
  global.fetch = async () => response(400, 'maximum context length exceeded: input tokens too large');
  try {
    await assert.rejects(
      () => callOpenAI('test-model', 'system', 'user', 1000, 'key'),
      (err) => err.code === 'CONTEXT_OVERFLOW' && err.fallbackEligible === false
    );
  } finally { global.fetch = oldFetch; }
});

test('Gemini classifies context-window overflow without rotating or falling back', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => { calls.push(String(url)); return response(400, 'input token count exceeds the maximum context window'); };
  try {
    const pool = new GeminiCredentialPool([
      { id: 'p1', key: 'k1' },
      { id: 'p2', key: 'k2' }
    ], { maxRetriesPerCredential: 0 });
    await assert.rejects(
      () => pool.request('model', 'system', 'user'),
      (err) => err.code === 'CONTEXT_OVERFLOW' && err.fallbackEligible === false
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('key=k1'));
  } finally { global.fetch = oldFetch; }
});

test('review context compaction preserves complete context sections and adds a marker', () => {
  const context = '\n--- PROJECT CONTEXT: a.md ---\nAAAA\n--- PROJECT CONTEXT: b.md ---\nBBBB\n';
  const compacted = compactReviewContext(context, 55);
  assert.ok(compacted.includes('a.md'));
  assert.equal(compacted.includes('b.md'), false);
  assert.match(compacted, /COMPACTED/);
});
