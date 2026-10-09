const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiCredentialPool } = require('../scripts/gemini-credential-pool');
const { callOpenAI, callAnthropic, callOpenRouter } = require('../scripts/provider-clients');

function errorResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function successResponse() {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{"findings":[]}' }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Gemini token-related quota 429 rotates all three independent credentials before model fallback', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    assert.equal(new URL(String(url)).searchParams.has('key'), false);
    calls.push(String(url) + '?key=' + options.headers['x-goog-api-key']);
    if (String(url).includes('model-first')) {
      return errorResponse(429, {
        code: 429, status: 'RESOURCE_EXHAUSTED',
        message: 'Quota exceeded for input_token_count limit 1000',
      });
    }
    return successResponse();
  };
  try {
    const pool = new GeminiCredentialPool(
      [{ id: 'one', key: 'key-one' }, { id: 'two', key: 'key-two' }, { id: 'three', key: 'key-three' }],
      { maxRetriesPerCredential: 0, cooldown429Ms: 1000 },
    );
    const result = await pool.callModels(['model-first', 'model-next'], 's', 'u');
    assert.equal(result.model, 'model-next');
    assert.deepEqual(calls.slice(0, 3).map((u) => new URL(u).searchParams.get('key')), ['key-one', 'key-two', 'key-three']);
    assert.equal(calls.filter((u) => u.includes('model-first')).length, 3);
  } finally {
    global.fetch = original;
  }
});

test('Gemini invalid key reported as structured HTTP 400 is disabled while healthy key succeeds', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    assert.equal(new URL(String(url)).searchParams.has('key'), false);
    calls.push(String(url) + '?key=' + options.headers['x-goog-api-key']);
    return options.headers['x-goog-api-key'] === 'invalid-key'
      ? errorResponse(400, {
          code: 400, status: 'INVALID_ARGUMENT',
          message: 'API key not valid',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
        })
      : successResponse();
  };
  try {
    const pool = new GeminiCredentialPool([
      { id: 'invalid', key: 'invalid-key' },
      { id: 'healthy', key: 'healthy-key' },
    ], { maxRetriesPerCredential: 0 });
    const result = await pool.request('model', 's', 'u');
    assert.equal(result.credentialId, 'healthy');
    assert.equal(calls.length, 2);
    assert.equal(pool.credentials.find((c) => c.id === 'invalid').disabled, true);
    assert.equal(pool.credentials.find((c) => c.id === 'healthy').disabled, false);
  } finally {
    global.fetch = original;
  }
});

for (const [name, fn] of [
  ['OpenAI', callOpenAI],
  ['Anthropic', callAnthropic],
  ['OpenRouter', callOpenRouter],
]) {
  test(`${name} 429 token-rate quota is never treated as context overflow`, async () => {
    const original = global.fetch;
    global.fetch = async () => errorResponse(429, {
      type: 'rate_limit_error',
      message: 'input tokens per minute limit exceeded',
    });
    try {
      await assert.rejects(
        () => fn('model', 'system', 'user', 1000, 'test-key'),
        (err) => err.code === 'HTTP_429' && err.fallbackEligible === true,
      );
    } finally {
      global.fetch = original;
    }
  });
}
