const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCapUsd, ceilingMicros, assertBinding,
  BudgetLedgerReference, simulateGatewayCall, assertProductionReady,
} = require('../scripts/review-dollar-budget');

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), PIPELINE = 'c'.repeat(40);
const binding = Object.freeze({
  runId: '38171001847', attempt: '1',
  headSha: HEAD, baseSha: BASE, pipelineSha: PIPELINE,
});
const rates = Object.freeze({
  inputMicroUsdPerMillion: 2000000,
  outputMicroUsdPerMillion: 8000000,
  perCallFeeMicros: 0,
  validUntilMs: 1800000000000,
});
const limits = Object.freeze({ maxInputTokens: 100000, maxOutputTokens: 100000 });
const now = 1790000000000; // fixed mock date
const newLedger = () => new BudgetLedgerReference({ binding, limitMicros: parseCapUsd('20') });

test('exact $20 USD cap stored as micro USD; reject fractional cents and nonsensical caps', () => {
  assert.equal(parseCapUsd('20'), 20000000);
  assert.equal(parseCapUsd('20.00'), 20000000);
  assert.equal(parseCapUsd('0.01'), 10000);
  for (const bad of ['0', '0.00', '$20', '20.001', '-1', 'NaN', '1e3', ' 20', 'Infinity', 20]) {
    assert.throws(() => parseCapUsd(bad), /INVALID_USD_CAP/);
  }
});

test('cap binding is immutable across head, base, pinned pipeline, attempt and run', () => {
  assert.deepEqual(assertBinding(binding), binding);
  for (const field of ['headSha', 'baseSha', 'pipelineSha', 'runId', 'attempt']) {
    const ledger = newLedger();
    const replaced = { ...binding, [field]: field.endsWith('Sha') ? 'f'.repeat(40) : '2' };
    assert.throws(() => ledger.reserve({ binding: replaced, requestId: 'r1', ceilingMicros: 10 }), /RUN_BINDING_MISMATCH/);
    assert.equal(ledger.snapshot().remainingMicros, 20000000);
  }
  assert.throws(() => assertBinding({ ...binding, headSha: 'main' }), /INVALID_RUN_BINDING/);
});

test('quote is rounded up to integer microdollars, including request fees', () => {
  const quote = ceilingMicros({ ...rates, perCallFeeMicros: 1250 },
    { maxInputTokens: 1, maxOutputTokens: 1 }, now);
  assert.equal(quote, 1260);
});

test('missing/stale/invalid price proof or token ceiling always fails closed', () => {
  assert.throws(() => ceilingMicros(null, limits, now), /INVALID_PRICE_PROOF/);
  assert.throws(() => ceilingMicros({ ...rates, validUntilMs: now - 1 }, limits, now), /PRICE_EXPIRED/);
  assert.throws(() => ceilingMicros({ ...rates, outputMicroUsdPerMillion: -1 }, limits, now), /INVALID_OUTPUT_RATE/);
  assert.throws(() => ceilingMicros(rates, { ...limits, maxOutputTokens: 0 }, now), /INVALID_OUTPUT_TOKENS/);
  assert.throws(() => ceilingMicros(rates, { ...limits, maxInputTokens: Infinity }, now), /INVALID_INPUT_TOKENS/);
  assert.throws(() => ceilingMicros(rates, { maxInputTokens: 999999999999, maxOutputTokens: 999999999999 }, now), /INVALID_QUOTED_CEILING/);
});

test('reservation cannot push used + reserved over $20', () => {
  const ledger = newLedger();
  ledger.reserve({ binding, requestId: 'openai:1', ceilingMicros: 15000000 });
  assert.throws(() => ledger.reserve({ binding, requestId: 'gemini:1', ceilingMicros: 5000001 }), /BUDGET_EXHAUSTED/);
  ledger.reserve({ binding, requestId: 'gemini:1', ceilingMicros: 5000000 });
  assert.equal(ledger.snapshot().remainingMicros, 0);
  assert.equal(ledger.snapshot().usedMicros + ledger.snapshot().reservedMicros, 20000000);
});

test('duplicate retry IDs cannot spend twice, even after settlement', () => {
  const ledger = newLedger();
  ledger.reserve({ binding, requestId: 'attempt:001', ceilingMicros: 20000 });
  assert.throws(() => ledger.reserve({ binding, requestId: 'attempt:001', ceilingMicros: 20000 }), /DUPLICATE_REQUEST/);
  assert.throws(() => ledger.reserve({ binding, requestId: 'attempt:001', ceilingMicros: 10000 }), /RESERVATION_REPLAY_MISMATCH/);
  ledger.settle({ binding, requestId: 'attempt:001', verified: true, actualMicros: 9000 });
  assert.throws(() => ledger.reserve({ binding, requestId: 'attempt:001', ceilingMicros: 20000 }), /DUPLICATE_REQUEST/);
  assert.equal(ledger.snapshot().usedMicros, 9000);
});

test('verified lower provider bill releases unused reserved budget', () => {
  const ledger = newLedger();
  ledger.reserve({ binding, requestId: 'r1', ceilingMicros: 5000000 });
  ledger.settle({ binding, requestId: 'r1', verified: true, actualMicros: 1000000 });
  assert.deepEqual(ledger.snapshot(), {
    limitMicros: 20000000, usedMicros: 1000000,
    reservedMicros: 0, remainingMicros: 19000000, requests: 1,
  });
});

test('unverified provider usage conservatively consumes entire reservation', () => {
  const ledger = newLedger();
  ledger.reserve({ binding, requestId: 'r1', ceilingMicros: 20000000 });
  ledger.settle({ binding, requestId: 'r1', verified: false });
  assert.equal(ledger.snapshot().remainingMicros, 0);
  assert.throws(() => ledger.reserve({ binding, requestId: 'r2', ceilingMicros: 1 }), /BUDGET_EXHAUSTED/);
});

test('unresolved provider requests remain reserved after simulated worker loss', () => {
  const ledger = newLedger();
  ledger.reserve({ binding, requestId: 'network-unknown', ceilingMicros: 20000000 });
  assert.equal(ledger.snapshot().reservedMicros, 20000000);
  assert.throws(() => ledger.reserve({ binding, requestId: 'next-chunk', ceilingMicros: 1000 }), /BUDGET_EXHAUSTED/);
});

test('invalid or over-ceiling settlement never releases reservation', () => {
  const ledger = newLedger();
  ledger.reserve({ binding, requestId: 'r1', ceilingMicros: 100 });
  assert.throws(() => ledger.settle({ binding, requestId: 'r1', verified: true, actualMicros: 101 }), /CEILING_VIOLATION/);
  assert.throws(() => ledger.settle({ binding, requestId: 'r1', verified: true, actualMicros: -1 }), /INVALID_SETTLED_AMOUNT/);
  assert.equal(ledger.snapshot().reservedMicros, 100);
});

test('concurrent OpenAI/Gemini mock requests reserve before transport (no network)', async () => {
  const ledger = newLedger();
  let providerCalls = 0;
  const large = { ...rates, inputMicroUsdPerMillion: 10000000, outputMicroUsdPerMillion: 10000000 };
  const cap = { maxInputTokens: 300000, maxOutputTokens: 500000 }; // $8/request
  const results = await Promise.allSettled(['openai:1', 'gemini:1', 'openai:2', 'gemini:2'].map((id) =>
    simulateGatewayCall({
      ledger, binding, requestId: id, catalogEntry: large, limits: cap, nowMs: now,
      transport: async () => { providerCalls++; return { actualBilledMicros: 8000000, usageVerified: true }; },
    })
  ));
  assert.equal(results.filter((v) => v.status === 'fulfilled').length, 2);
  assert.equal(results.filter((v) => v.status === 'rejected' && /BUDGET_EXHAUSTED/.test(v.reason.message)).length, 2);
  assert.equal(providerCalls, 2);
  assert.equal(ledger.snapshot().usedMicros, 16000000);
  assert.equal(ledger.snapshot().remainingMicros, 4000000);
});

test('fallback cannot call Gemini when earlier OpenAI failure reserved the remaining amount', async () => {
  const ledger = newLedger();
  const quote = { ...rates, inputMicroUsdPerMillion: 20000000, outputMicroUsdPerMillion: 20000000 };
  const cap = { maxInputTokens: 500000, maxOutputTokens: 500000 }; // $20
  let geminiCalls = 0;
  await assert.rejects(() => simulateGatewayCall({
    ledger, binding, requestId: 'openai-failed', catalogEntry: quote, limits: cap, nowMs: now,
    transport: async () => { throw new Error('HTTP 503, usage not reconcilable'); },
  }), /HTTP 503/);
  await assert.rejects(() => simulateGatewayCall({
    ledger, binding, requestId: 'gemini-fallback', catalogEntry: quote, limits: cap, nowMs: now,
    transport: async () => { geminiCalls++; return { actualBilledMicros: 0, usageVerified: true }; },
  }), /BUDGET_EXHAUSTED/);
  assert.equal(geminiCalls, 0);
  assert.equal(ledger.snapshot().usedMicros, 20000000);
});

test('model-cascade requests cannot reuse a prior request ID', async () => {
  const ledger = newLedger(), seen = [];
  await simulateGatewayCall({
    ledger, binding, requestId: 'call-1', catalogEntry: rates, limits, nowMs: now,
    transport: async () => { seen.push(1); return { actualBilledMicros: 100000, usageVerified: true }; },
  });
  await assert.rejects(() => simulateGatewayCall({
    ledger, binding, requestId: 'call-1', catalogEntry: rates, limits, nowMs: now,
    transport: async () => { seen.push(2); return { actualBilledMicros: 0, usageVerified: true }; },
  }), /DUPLICATE_REQUEST/);
  assert.deepEqual(seen, [1]);
});

test('missing paid gateway or pricing cannot fall back to direct provider', async () => {
  await assert.rejects(() => simulateGatewayCall({
    ledger: null, binding, requestId: 'r', catalogEntry: rates, limits, nowMs: now,
    transport: async () => {},
  }), /UNTRUSTED_GATEWAY/);
  assert.throws(() => assertProductionReady(), /LIVE_NOT_CERTIFIED/);
});
