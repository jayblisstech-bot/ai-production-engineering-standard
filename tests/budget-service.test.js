'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BudgetGatewayService, validateGrantPolicy } = require('../gateway/budget-service');
const { BudgetLedgerReference, parseCapUsd } = require('../scripts/review-dollar-budget');

const bindingA = Object.freeze({
  repository: 'example/numerra', prNumber: '11',
  runId: '12345', attempt: '1',
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pipelineSha: 'c'.repeat(40),
});
const bindingB = Object.freeze({
  repository: 'another-org/truemail-ai', prNumber: '7',
  runId: '67890', attempt: '1',
  headSha: 'd'.repeat(40), baseSha: 'e'.repeat(40), pipelineSha: 'f'.repeat(40),
});
const now = 1700000000000;
const entry = Object.freeze({
  rates: { inputMicroUsdPerMillion: 10000000, outputMicroUsdPerMillion: 10000000,
    perCallFeeMicros: 0, validUntilMs: now + 20000 },
  limits: { maxInputTokens: 100000, maxOutputTokens: 100000 },
});
const policies = Object.freeze([
  { grantId: 'project-a', repository: bindingA.repository, prNumber: bindingA.prNumber,
    models: { openai: ['mock-openai'], gemini: ['mock-gemini'] } },
  { grantId: 'project-b', repository: bindingB.repository, prNumber: bindingB.prNumber,
    models: { anthropic: ['mock-claude'] } },
]);
function make() {
  const ledgers = new Map([
    ['project-a', new BudgetLedgerReference({ binding: bindingA, limitMicros: parseCapUsd('10') })],
    ['project-b', new BudgetLedgerReference({ binding: bindingB, limitMicros: parseCapUsd('3') })],
  ]);
  // Pure in-memory adapter: no SQLite imports or cloud SDK.
  const store = {
    snapshot(id, binding) {
      const ledger = ledgers.get(id);
      if (!ledger) throw new Error('APES_BUDGET_UNAUTHORIZED_GRANT');
      ledger.requireBinding(binding);
      return ledger.snapshot();
    },
    reserve({ grantId, binding, requestId, quoteMicros }) {
      if (!ledgers.has(grantId)) throw new Error('APES_BUDGET_UNAUTHORIZED_GRANT');
      return ledgers.get(grantId).reserve({ binding, requestId, ceilingMicros: quoteMicros });
    },
    settle({ grantId, binding, requestId, verified, actualMicros }) {
      if (!ledgers.has(grantId)) throw new Error('APES_BUDGET_UNAUTHORIZED_GRANT');
      return ledgers.get(grantId).settle({ binding, requestId, verified, actualMicros });
    },
  };
  let calls = 0;
  const create = (settings = {}) => new BudgetGatewayService({
    store, policies,
    pricingCatalog: {
      openai: { 'mock-openai': entry },
      gemini: { 'mock-gemini': entry },
      anthropic: { 'mock-claude': entry },
    },
    mockOnly: true, now: () => now,
    transport: async ({ simulateFailure }) => {
      calls++;
      if (simulateFailure) throw new Error('mock-timeout');
      return { mock: true };
    },
    ...settings,
  });
  return { create, ledgers, getCalls: () => calls, store };
}
test('backend-independent service accepts an injected memory adapter, no SQLite requirement', async () => {
  const m = make(); const service = m.create();
  const response = await service.dispatch({
    grantId: 'project-a', binding: bindingA, requestId: 'a1',
    provider: 'openai', model: 'mock-openai',
  });
  assert.equal(response.mock, true);
  assert.equal(response.budget.remainingMicros, 8000000);
  assert.equal(m.getCalls(), 1);
});
test('one APES service can enforce separate repository budget ceilings', async () => {
  const m = make(); const svc = m.create();
  await svc.dispatch({ grantId: 'project-a', binding: bindingA, requestId: 'a1', provider: 'openai', model: 'mock-openai' });
  await svc.dispatch({ grantId: 'project-b', binding: bindingB, requestId: 'b1', provider: 'anthropic', model: 'mock-claude' });
  assert.equal(m.ledgers.get('project-a').remainingMicros(), 8000000);
  assert.equal(m.ledgers.get('project-b').remainingMicros(), 1000000);
  assert.equal(m.getCalls(), 2);
});
test('cross-repo attempts cannot spend another client grant', async () => {
  const m = make(); const svc = m.create();
  await assert.rejects(() => svc.dispatch({
    grantId: 'project-a', binding: bindingB, requestId: 'bad',
    provider: 'openai', model: 'mock-openai',
  }), /REPOSITORY_POLICY_DENIED/);
  assert.equal(m.getCalls(), 0);
});
test('model allowance is isolated per repo, never inherited globally', async () => {
  const m = make(); const svc = m.create();
  await assert.rejects(() => svc.dispatch({
    grantId: 'project-b', binding: bindingB, requestId: 'bad',
    provider: 'gemini', model: 'mock-gemini',
  }), /MODEL_NOT_APPROVED_FOR_REPOSITORY/);
  assert.equal(m.getCalls(), 0);
});
test('invalid, duplicate or missing policy and storage adapters fail closed', () => {
  const m = make();
  assert.throws(() => m.create({ store: {} }), /STORAGE_ADAPTER_REQUIRED/);
  assert.throws(() => m.create({ mockOnly: false }), /LIVE_NOT_CERTIFIED/);
  assert.throws(() => m.create({ policies: [] }), /INVALID_SERVICE_CONFIG/);
  assert.throws(() => m.create({ policies: [policies[0], policies[0]] }), /DUPLICATE_POLICY/);
  assert.throws(() => validateGrantPolicy({ grantId: 'bad', repository: 'none', prNumber: '0', models: {} }), /INVALID_GRANT_POLICY/);
});
test('stale price or missing model tariff denies transport', async () => {
  const m = make();
  const svc = m.create({ pricingCatalog: {
    openai: { 'mock-openai': { ...entry, rates: { ...entry.rates, validUntilMs: now - 1 } } },
  } });
  await assert.rejects(() => svc.dispatch({ grantId: 'project-a', binding: bindingA, requestId: 'stale', provider: 'openai', model: 'mock-openai' }), /PRICE_EXPIRED/);
  await assert.rejects(() => svc.dispatch({ grantId: 'project-a', binding: bindingA, requestId: 'missing', provider: 'gemini', model: 'mock-gemini' }), /MISSING_APPROVED_PRICE/);
  assert.equal(m.getCalls(), 0);
});
test('failed mock provider request charges reservation and replay cannot evade cap', async () => {
  const m = make(); const svc = m.create();
  await assert.rejects(() => svc.dispatch({ grantId: 'project-a', binding: bindingA, requestId: 'failed', provider: 'openai', model: 'mock-openai', simulateFailure: true }), /mock-timeout/);
  assert.equal(m.ledgers.get('project-a').remainingMicros(), 8000000);
  await assert.rejects(() => svc.dispatch({ grantId: 'project-a', binding: bindingA, requestId: 'failed', provider: 'gemini', model: 'mock-gemini' }), /DUPLICATE_REQUEST/);
  assert.equal(m.getCalls(), 1);
});
test('invalid repository or PR scope cannot be provisioned in grant policy', () => {
  for (const repository of ['../escape', 'one-repo', '', 'tenant/../../unsafe']) {
    assert.throws(() => validateGrantPolicy({
      grantId: 'id', repository, prNumber: '1', models: { openai: ['mock-openai'] },
    }), /INVALID_GRANT_POLICY/);
  }
});
