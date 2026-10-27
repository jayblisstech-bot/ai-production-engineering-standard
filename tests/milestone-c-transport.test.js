'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchBufferedResponse, remainingDeadlineMs } = require('../scripts/http-bounded');
const { callOpenRouter, callOpenAI, callAnthropic } = require('../scripts/provider-clients');
const { GeminiCredentialPool } = require('../scripts/gemini-credential-pool');
const { HermesOrchestrator } = require('../scripts/hermes-orchestrator');
const { DEFAULT_CONFIG } = require('../scripts/lib');
const { createPlan, reviewOneChunk } = require('../scripts/ai-chunk-protocol');
const { postInlineComment } = require('../scripts/call-review-gateway');

async function stalledResponse(run, sendHeaders = true) {
  const server = http.createServer((_req, res) => {
    if (sendHeaders) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      res.write('{"partial":');
    }
    // Deliberately never close the body or finish headers.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const realFetch = global.fetch;
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  global.fetch = (_url, opts) => realFetch(endpoint, opts);
  const started = Date.now();
  try {
    await run();
    assert.ok(Date.now() - started < 2000, 'HTTP transport exceeded test timebox');
  } finally {
    global.fetch = realFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const [name, client] of [
  ['OpenRouter', callOpenRouter],
  ['OpenAI', callOpenAI],
  ['Anthropic', callAnthropic],
]) {
  test(name + ': abort timer covers stalled response body', { timeout: 4000 }, async () => {
    await stalledResponse(async () => {
      await assert.rejects(
        () => client('model', 'system', 'user', 200, 'test-credential'),
        (e) => e.code === 'NETWORK' && /timeout/i.test(e.message),
      );
    });
  });
}

test('abort timer covers stalled response headers', { timeout: 4000 }, async () => {
  await stalledResponse(async () => {
    await assert.rejects(
      () => fetchBufferedResponse('https://example.invalid', {}, 200),
      (e) => e.code === 'REQUEST_TIMEOUT',
    );
  }, false);
});

test('response byte cap rejects streaming bodies even without Content-Length', async () => {
  const old = global.fetch;
  global.fetch = async () => new Response('x'.repeat(8192), { status: 200 });
  try {
    await assert.rejects(
      () => fetchBufferedResponse('https://example.invalid', {}, 500, null, 1024),
      (e) => e.code === 'HTTP_BODY_TOO_LARGE' && e.fallbackEligible === false,
    );
  } finally { global.fetch = old; }
});

test('actual deadline aborts stalled body with non-fallback error', { timeout: 4000 }, async () => {
  await stalledResponse(async () => {
    await assert.rejects(
      () => fetchBufferedResponse('https://example.invalid', {}, 10000, Date.now() + 180),
      (e) => e.code === 'REVIEW_DEADLINE_EXCEEDED' && e.fallbackEligible === false,
    );
  });
});

test('provider input-context overflow is not confused with output-token errors', async () => {
  const old = global.fetch;
  try {
    global.fetch = async () => new Response(JSON.stringify({
      error: { message: 'input token count exceeds the limit' },
    }), { status: 400 });
    await assert.rejects(
      () => callOpenRouter('model', 'system', 'user', 500, 'key'),
      (e) => e.code === 'CONTEXT_OVERFLOW',
    );
    global.fetch = async () => new Response(JSON.stringify({
      error: { message: 'max_tokens must be less than 400' },
    }), { status: 400 });
    await assert.rejects(
      () => callAnthropic('model', 'system', 'user', 500, 'key'),
      (e) => e.code === 'HTTP_400',
    );
  } finally { global.fetch = old; }
});

test('rate-limit errors remain HTTP_429 and fallback eligible', async () => {
  const old = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    error: { message: 'input token rate limit exceeded' },
  }), { status: 429 });
  try {
    await assert.rejects(
      () => callOpenAI('model', 'system', 'user', 500, 'key'),
      (e) => e.code === 'HTTP_429' && e.fallbackEligible === true,
    );
  } finally { global.fetch = old; }
});

test('Gemini 5xx backoff never overshoots the shared absolute deadline', { timeout: 4000 }, async () => {
  const old = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('unavailable', { status: 503 }); };
  try {
    const pool = new GeminiCredentialPool([{ id: 'project', key: 'k' }], {
      maxRetriesPerCredential: 3, backoffBaseMs: 3000, modelBudgetMs: 4000,
    });
    const started = Date.now();
    await assert.rejects(
      () => pool.request('model', 's', 'u', { deadlineMs: Date.now() + 220 }),
      (e) => e.code === 'REVIEW_DEADLINE_EXCEEDED',
    );
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 1800, 'backoff exceeded deadline');
  } finally { global.fetch = old; }
});

test('Hermes propagates absolute deadline and does not punish a timed-out candidate', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.review.allowedExternalProviders = ['openai'];
  config.review.routing.mode = 'direct';
  const hermes = new HermesOrchestrator({
    config, env: { OPENAI_API_KEY: 'test' },
    clients: { openai: async () => {
      await new Promise((r) => setTimeout(r, 90));
      return { text: '{"findings":[]}', provider: 'openai', model: 'mock' };
    } },
  });
  await assert.rejects(
    () => hermes.review({
      modelTier: 'medium', systemPrompt: 's', userPrompt: 'u',
      validate: () => ({ findings: [] }), deadlineMs: Date.now() + 30,
    }),
    (e) => e.code === 'REVIEW_DEADLINE_EXCEEDED',
  );
  assert.equal(hermes.providerCooldowns.size, 0);
});

test('serial chunk reviewer rejects a late validated result', async () => {
  const plan = createPlan({
    rawDiff: 'diff --git a/f.js b/f.js\n--- a/f.js\n+++ b/f.js\n@@ -0,0 +1 @@\n+const a = 1;\n',
    changedFiles: ['f.js'], config: { review: { maxChunkChars: 45000, maxChunks: 12 } },
    projectRoot: '/unused', contextOverride: 'safe project context',
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), pipelineSha: 'c'.repeat(40),
    runId: '12345', runAttempt: '1', riskTier: 'HIGH', modelTier: 'strong',
  });
  await assert.rejects(
    () => reviewOneChunk(plan, 1, async ({ validate }) => {
      await new Promise((r) => setTimeout(r, 65));
      return { validated: validate('{"findings":[]}') };
    }, Date.now() + 15),
    (e) => e.code === 'REVIEW_DEADLINE_EXCEEDED',
  );
});

test('review comment posting times out on stalled response body', { timeout: 4000 }, async () => {
  await stalledResponse(async () => {
    await assert.rejects(
      () => postInlineComment('owner', 'repo', 7, 'a'.repeat(40), {
        severity: 'P1', path: 'f.js', line: 1, side: 'RIGHT', comment: 'test issue',
      }, null, 200),
      (e) => e.code === 'REQUEST_TIMEOUT',
    );
  });
});

test('an already elapsed review deadline fails closed', () => {
  assert.throws(() => remainingDeadlineMs(Date.now() - 1),
    (e) => e.code === 'REVIEW_DEADLINE_EXCEEDED');
});
