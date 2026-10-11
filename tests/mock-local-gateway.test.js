const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteBudgetStore } = require('../gateway/sqlite-budget-store');
const { createMockGateway, listenLoopback } = require('../gateway/mock-local-gateway');

const binding = {
  runId: '38171001847', attempt: '1', headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40), pipelineSha: 'c'.repeat(40),
};
const token = 'only-a-test-gateway-authentication-token';
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-http-mock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SqliteBudgetStore(path.join(dir, 'mock-ledger.db'));
  t.after(() => store.close());
  store.createGrant({ grantId: 'numerra-10', binding, capUsd: '10' });
  const server = createMockGateway({ store, token, env: { APES_MOCK_GATEWAY_ONLY: '1' } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = await listenLoopback(server);
  return { store, url };
}
async function call(url, request, authorization = 'Bearer ' + token) {
  const result = await fetch(url + '/mock/review', {
    method: 'POST',
    headers: { 'authorization': authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      grantId: 'numerra-10', binding,
      requestId: 'r1', provider: 'openai', model: 'mock-openai', ...request,
    }),
  });
  return { status: result.status, body: await result.json() };
}
test('mock HTTP gateway is explicitly disabled without isolation flag', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-disabled-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SqliteBudgetStore(path.join(dir, 'ledger.db'));
  t.after(() => store.close());
  assert.throws(() => createMockGateway({ store, token, env: {} }), /LIVE_NOT_CERTIFIED/);
  assert.throws(() => createMockGateway({ store, token: '', env: { APES_MOCK_GATEWAY_ONLY: '1' } }), /LIVE_NOT_CERTIFIED/);
});
test('gateway refuses unauthorized request before reserve or simulated provider call', async (t) => {
  const { store, url } = await setup(t);
  const r = await call(url, {}, 'Bearer incorrect');
  assert.equal(r.status, 401);
  assert.equal(store.snapshot('numerra-10', binding).usedMicros, 0);
});
test('9 simulated review attempts share one $10 cap across OpenAI, Gemini and Claude', async (t) => {
  const { store, url } = await setup(t);
  const providers = ['openai','gemini','anthropic','openai','gemini','anthropic','openai','gemini','openai'];
  const models = { openai: 'mock-openai', gemini: 'mock-gemini', anthropic: 'mock-claude' };
  const results = await Promise.all(providers.map((provider, i) =>
    call(url, { requestId: 'chunk:' + (i + 1), provider, model: models[provider] })
  ));
  assert.equal(results.filter((r) => r.status === 200).length, 5);
  assert.equal(results.filter((r) => r.status === 429 && r.body.error === 'APES_BUDGET_EXHAUSTED').length, 4);
  assert.equal(store.snapshot('numerra-10', binding).limitMicros, 10000000);
  assert.equal(store.snapshot('numerra-10', binding).usedMicros, 10000000);
  assert.equal(store.snapshot('numerra-10', binding).remainingMicros, 0);
});
test('gateway cannot accept caller-selected low quote, price or maxOutputTokens', async (t) => {
  const { store, url } = await setup(t);
  const r = await call(url, {
    requestId: 'override', quoteMicros: 1,
    maxInputTokens: 1, maxOutputTokens: 1,
    inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0,
  });
  assert.equal(r.status, 200);
  assert.equal(store.snapshot('numerra-10', binding).usedMicros, 2000000);
  assert.equal(r.body.mock, true);
});
test('unknown model and unauthorized run attempts do not consume budget', async (t) => {
  const { store, url } = await setup(t);
  assert.equal((await call(url, { requestId: 'unknown', model: 'any-real-model' })).status, 400);
  assert.equal((await call(url, { requestId: 'wrong', binding: { ...binding, attempt: '2' } })).status, 403);
  assert.equal(store.snapshot('numerra-10', binding).remainingMicros, 10000000);
});
test('duplicate request IDs cannot cause another billable attempt', async (t) => {
  const { store, url } = await setup(t);
  assert.equal((await call(url, { requestId: 'same' })).status, 200);
  const duplicate = await call(url, { requestId: 'same', provider: 'gemini', model: 'mock-gemini' });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.body.error, /DUPLICATE_REQUEST/);
  assert.equal(store.snapshot('numerra-10', binding).usedMicros, 2000000);
});
test('simulated provider failure consumes reserved ceiling and cannot escape cap', async (t) => {
  const { store, url } = await setup(t);
  const fail = await call(url, { requestId: 'failed', simulateFailure: true });
  assert.equal(fail.status, 503);
  assert.equal(store.snapshot('numerra-10', binding).usedMicros, 2000000);
  assert.equal(store.snapshot('numerra-10', binding).remainingMicros, 8000000);
});
