const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiCredentialPool, parseGeminiCredentials } = require('../scripts/gemini-credential-pool');

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    json: async () => typeof body === 'string' ? JSON.parse(body) : body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

const okBody = (text='{"findings":[]}') => ({ candidates: [{ content: { parts: [{ text }] } }] });

test('parses multiple Gemini project credentials without exposing keys as ids', () => {
  const creds = parseGeminiCredentials({ GEMINI_API_KEYS_JSON: JSON.stringify([{ id: 'project-a', key: 'secret-a' }, { id: 'project-b', key: 'secret-b' }]) });
  assert.deepEqual(creds.map((c) => c.id), ['project-a', 'project-b']);
  assert.deepEqual(creds.map((c) => c.key), ['secret-a', 'secret-b']);
});

test('rotates credential before changing the selected Gemini model on 429', async () => {
  const oldFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('key=k1')) return response(429, 'quota');
    return response(200, okBody());
  };
  try {
    const pool = new GeminiCredentialPool([{ id: 'p1', key: 'k1' }, { id: 'p2', key: 'k2' }], { maxRetriesPerCredential: 0, cooldown429Ms: 1000 });
    const out = await pool.callModels(['gemini-same-model', 'gemini-weaker-model'], 's', 'u');
    assert.equal(out.model, 'gemini-same-model');
    assert.equal(out.credentialId, 'p2');
    assert.equal(urls.length, 2);
    assert.ok(urls.every((u) => u.includes('gemini-same-model')));
  } finally { global.fetch = oldFetch; }
});

test('only moves to the next Gemini model after all healthy credentials are exhausted for the first', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.includes('model-one')) return response(429, 'quota');
    return response(200, okBody());
  };
  try {
    const pool = new GeminiCredentialPool([{ id: 'p1', key: 'k1' }, { id: 'p2', key: 'k2' }], { maxRetriesPerCredential: 0, cooldown429Ms: 1000 });
    const out = await pool.callModels(['model-one', 'model-two'], 's', 'u');
    assert.equal(out.model, 'model-two');
    const firstModelTwo = calls.findIndex((u) => u.includes('model-two'));
    assert.equal(firstModelTwo, 2);
    assert.ok(calls[0].includes('model-one'));
    assert.ok(calls[1].includes('model-one'));
  } finally { global.fetch = oldFetch; }
});

test('invalid Gemini credential is disabled and next project credential is tried on the same model', async () => {
  const oldFetch = global.fetch;
  global.fetch = async (url) => String(url).includes('key=bad') ? response(401, 'bad key') : response(200, okBody());
  try {
    const pool = new GeminiCredentialPool([{ id: 'bad-project', key: 'bad' }, { id: 'good-project', key: 'good' }], { maxRetriesPerCredential: 0 });
    const out = await pool.request('model-one', 's', 'u');
    assert.equal(out.credentialId, 'good-project');
    assert.equal(pool.credentials.find((c) => c.id === 'bad-project').disabled, true);
  } finally { global.fetch = oldFetch; }
});

test('rejects account-identifying or duplicate Gemini pool entries', () => {
  assert.throws(() => parseGeminiCredentials({ GEMINI_API_KEYS_JSON: JSON.stringify([{ id: 'person@example.com', key: 'k1' }]) }), /opaque/);
  assert.throws(() => parseGeminiCredentials({ GEMINI_API_KEYS_JSON: JSON.stringify([{ id: 'p1', key: 'same' }, { id: 'p2', key: 'same' }]) }), /Duplicate Gemini credential material/);
});

test('Gemini telemetry exposes opaque ids but never API key material', async () => {
  const oldFetch = global.fetch;
  global.fetch = async () => response(200, okBody());
  try {
    const pool = new GeminiCredentialPool([{ id: 'project-opaque', key: 'very-secret-key-value' }], { maxRetriesPerCredential: 0 });
    await pool.request('model-one', 's', 'u');
    const serialized = JSON.stringify(pool.publicTelemetry());
    assert.match(serialized, /project-opaque/);
    assert.doesNotMatch(serialized, /very-secret-key-value/);
  } finally { global.fetch = oldFetch; }
});

test('maxRetriesPerCredential=0 is honored for transient server failures', async () => {
  const oldFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return response(500, 'server'); };
  try {
    const pool = new GeminiCredentialPool([{ id: 'p1', key: 'k1' }], { maxRetriesPerCredential: 0, transientCooldownMs: 100 });
    await assert.rejects(() => pool.request('m', 's', 'u'), /pool exhausted/);
    assert.equal(calls, 1);
  } finally { global.fetch = oldFetch; }
});

test('Gemini 403 quarantines only the credential+model pair, not the whole credential', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.includes('model-a') && u.includes('key=k1')) return response(403, 'forbidden for model');
    return response(200, okBody());
  };
  try {
    const pool = new GeminiCredentialPool([{ id: 'p1', key: 'k1' }, { id: 'p2', key: 'k2' }], { maxRetriesPerCredential: 0 });
    const a = await pool.request('model-a', 's', 'u');
    assert.equal(a.credentialId, 'p2');
    const b = await pool.request('model-b', 's', 'u');
    assert.equal(pool.credentials.find((c) => c.id === 'p1').disabled, false);
    assert.ok(['p1','p2'].includes(b.credentialId));
  } finally { global.fetch = oldFetch; }
});


test('Gemini request sends configured thinking level and omits deprecated temperature sampling', async () => {
  const oldFetch = global.fetch;
  let requestBody = null;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return response(200, okBody());
  };
  try {
    const pool = new GeminiCredentialPool([{ id: 'p1', key: 'k1' }], { maxRetriesPerCredential: 0 });
    await pool.request('gemini-3.8-flash', 's', 'u', { thinkingLevel: 'high' });
    assert.deepEqual(requestBody.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
    assert.equal(Object.prototype.hasOwnProperty.call(requestBody.generationConfig, 'temperature'), false);
  } finally { global.fetch = oldFetch; }
});

test('repeated 5xx failures across a bounded number of credentials fall back without exhausting the full pool', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return response(503, 'overloaded');
  };
  try {
    const pool = new GeminiCredentialPool([
      { id: 'p1', key: 'k1' },
      { id: 'p2', key: 'k2' },
      { id: 'p3', key: 'k3' },
      { id: 'p4', key: 'k4' },
    ], {
      maxRetriesPerCredential: 0,
      maxTransientCredentialsPerModel: 2,
      transientCooldownMs: 1000,
    });
    await assert.rejects(
      () => pool.request('gemini-3.8-flash', 's', 'u'),
      (err) => err.code === 'MODEL_TRANSIENT_UNAVAILABLE' && /without exhausting the full key pool/.test(err.message)
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.some((u) => u.includes('key=k1')));
    assert.ok(calls.some((u) => u.includes('key=k2')));
    assert.equal(calls.some((u) => u.includes('key=k3')), false);
    assert.equal(calls.some((u) => u.includes('key=k4')), false);
  } finally { global.fetch = oldFetch; }
});

test('429 remains credential-specific and continues rotating across the pool', async () => {
  const oldFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.includes('key=k1') || u.includes('key=k2')) return response(429, 'quota');
    return response(200, okBody());
  };
  try {
    const pool = new GeminiCredentialPool([
      { id: 'p1', key: 'k1' },
      { id: 'p2', key: 'k2' },
      { id: 'p3', key: 'k3' },
    ], {
      maxRetriesPerCredential: 0,
      maxTransientCredentialsPerModel: 1,
      cooldown429Ms: 1000,
    });
    const out = await pool.request('gemini-3.8-flash', 's', 'u', { thinkingLevel: 'medium' });
    assert.equal(out.credentialId, 'p3');
    assert.equal(calls.length, 3);
  } finally { global.fetch = oldFetch; }
});
