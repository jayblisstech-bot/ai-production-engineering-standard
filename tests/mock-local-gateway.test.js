const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SqliteBudgetStore } = require('../gateway/sqlite-budget-store');
const { createMockGateway, listenLoopback } = require('../gateway/mock-local-gateway');

const binding = {
  repository: 'jayblisstech-bot/Numerra', prNumber: '11',
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
  const policies = [{ grantId: 'numerra-10', repository: binding.repository, prNumber: binding.prNumber, models: { openai: ['mock-openai'], gemini: ['mock-gemini'], anthropic: ['mock-claude'] } }];
  const server = createMockGateway({ store, policies, token, env: { APES_MOCK_GATEWAY_ONLY: '1' } });
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
  assert.equal((await call(url, { requestId: 'wrong-repo', binding: { ...binding, repository: 'example/Other' } })).status, 403);
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

test('two repositories have independently authorized budgets and model policies', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-multi-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SqliteBudgetStore(path.join(dir, 'shared-ledger.db'));
  t.after(() => store.close());
  const other = { ...binding, repository: 'team/TrueMail-AI', prNumber: '7' };
  const policies = [
    { grantId: 'numerra-10', repository: binding.repository, prNumber: binding.prNumber, models: { openai: ['mock-openai'], gemini: ['mock-gemini'] } },
    { grantId: 'truemail-3', repository: other.repository, prNumber: other.prNumber, models: { anthropic: ['mock-claude'] } },
  ];
  store.createGrant({ grantId: 'numerra-10', binding, capUsd: '10' });
  store.createGrant({ grantId: 'truemail-3', binding: other, capUsd: '3' });
  const server = createMockGateway({ store, policies, token, env: { APES_MOCK_GATEWAY_ONLY: '1' } });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = await listenLoopback(server);
  const first = await call(url, { requestId: 'numerra-1' });
  assert.equal(first.status, 200);
  const second = await call(url, {
    grantId: 'truemail-3', binding: other, requestId: 'truemail-1',
    provider: 'anthropic', model: 'mock-claude',
  });
  assert.equal(second.status, 200);
  assert.equal(store.snapshot('numerra-10', binding).remainingMicros, 8000000);
  assert.equal(store.snapshot('truemail-3', other).remainingMicros, 1000000);
  const deniedModel = await call(url, {
    grantId: 'truemail-3', binding: other, requestId: 'truemail-denied',
    provider: 'gemini', model: 'mock-gemini',
  });
  assert.equal(deniedModel.status, 403);
  assert.match(deniedModel.body.error, /MODEL_NOT_APPROVED_FOR_REPOSITORY/);
  const crossRepo = await call(url, {
    grantId: 'numerra-10', binding: other, requestId: 'cross-repo',
    provider: 'openai', model: 'mock-openai',
  });
  assert.equal(crossRepo.status, 403);
  assert.match(crossRepo.body.error, /REPOSITORY_POLICY_DENIED/);
  const exhausted = await call(url, {
    grantId: 'truemail-3', binding: other, requestId: 'truemail-2',
    provider: 'anthropic', model: 'mock-claude',
  });
  assert.equal(exhausted.status, 429);
  assert.equal(store.snapshot('numerra-10', binding).remainingMicros, 8000000);
  assert.equal(store.snapshot('truemail-3', other).remainingMicros, 1000000);
});
