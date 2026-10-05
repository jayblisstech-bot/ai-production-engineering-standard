const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiCredentialPool } = require('../scripts/gemini-credential-pool');

test('transient model failure exhausts independent credential pool before model fallback', async () => {
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ error: { message: 'temporary outage' } }), { status: 503 });
  };
  try {
    const pool = new GeminiCredentialPool(
      [{ id: 'k1', key: 'a' }, { id: 'k2', key: 'b' }, { id: 'k3', key: 'c' }, { id: 'k4', key: 'd' }],
      { timeoutMs: 1000, maxRetriesPerCredential: 0, transientCooldownMs: 1 }
    );
    await assert.rejects(
      pool.request('gemini-test', 'system', 'user'),
      (err) => err.code === 'MODEL_TRANSIENT_UNAVAILABLE'
    );
    assert.equal(seen.length, 4);
    const telemetry = pool.publicTelemetry().filter((x) => x.event === 'server-error');
    assert.deepEqual(telemetry.map((x) => x.credentialId), ['k1', 'k2', 'k3', 'k4']);
  } finally {
    global.fetch = originalFetch;
  }
});
