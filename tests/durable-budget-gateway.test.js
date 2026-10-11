const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SqliteBudgetStore } = require('../gateway/sqlite-budget-store');
const { parseCapUsd } = require('../scripts/review-dollar-budget');

const binding = {
  runId: '38171001847', attempt: '1',
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  pipelineSha: 'c'.repeat(40),
};
const grantId = 'numerra-review-10usd';
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'ledger.db');
  const store = new SqliteBudgetStore(dbPath);
  t.after(() => store.close());
  store.createGrant({ grantId, binding, capUsd: '10.00' });
  return { dbPath, store };
}
test('durable mock ledger stores an exact $10 authorized cap, never $20', (t) => {
  const { dbPath, store } = setup(t);
  assert.equal(parseCapUsd('10'), 10000000);
  assert.equal(store.snapshot(grantId, binding).limitMicros, 10000000);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  assert.throws(() => store.createGrant({ grantId, binding, capUsd: '20' }), /DUPLICATE_GRANT/);
  assert.equal(store.snapshot(grantId, binding).limitMicros, 10000000);
});
test('separate gateway instances share durable reservations and exact limit', (t) => {
  const { dbPath, store } = setup(t);
  const other = new SqliteBudgetStore(dbPath);
  t.after(() => other.close());
  store.reserve({ grantId, binding, requestId: 'openai-1', quoteMicros: 6000000 });
  assert.equal(other.snapshot(grantId, binding).reservedMicros, 6000000);
  assert.throws(() => other.reserve({ grantId, binding, requestId: 'gemini-1', quoteMicros: 4000001 }), /BUDGET_EXHAUSTED/);
  other.reserve({ grantId, binding, requestId: 'gemini-1', quoteMicros: 4000000 });
  assert.equal(store.snapshot(grantId, binding).remainingMicros, 0);
});
test('replay and incorrect immutable attempt cannot reset a grant', (t) => {
  const { dbPath, store } = setup(t);
  store.reserve({ grantId, binding, requestId: 'attempt-a', quoteMicros: 6000000 });
  store.close();
  const reopened = new SqliteBudgetStore(dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot(grantId, binding).reservedMicros, 6000000);
  assert.throws(() => reopened.reserve({ grantId, binding, requestId: 'attempt-a', quoteMicros: 2000000 }), /DUPLICATE_REQUEST/);
  assert.throws(() => reopened.reserve({ grantId, binding: { ...binding, attempt: '2' }, requestId: 'different', quoteMicros: 1 }), /UNAUTHORIZED_GRANT/);
});
test('provider-verified cost releases unused ceiling and unknown spend consumes full reservation', (t) => {
  const { store } = setup(t);
  store.reserve({ grantId, binding, requestId: 'r1', quoteMicros: 4500000 });
  store.settle({ grantId, binding, requestId: 'r1', verified: true, actualMicros: 2000000 });
  store.reserve({ grantId, binding, requestId: 'r2', quoteMicros: 8000000 });
  store.settle({ grantId, binding, requestId: 'r2', verified: false });
  assert.equal(store.snapshot(grantId, binding).remainingMicros, 0);
  assert.throws(() => store.reserve({ grantId, binding, requestId: 'r3', quoteMicros: 1 }), /BUDGET_EXHAUSTED/);
});
test('unverified or overquoted settlements fail closed, preserving reservations', (t) => {
  const { store } = setup(t);
  store.reserve({ grantId, binding, requestId: 'r1', quoteMicros: 10000000 });
  assert.throws(() => store.settle({ grantId, binding, requestId: 'r1', verified: true, actualMicros: 10000001 }), /CEILING_VIOLATION/);
  assert.throws(() => store.settle({ grantId, binding, requestId: 'r1', verified: true, actualMicros: -1 }), /INVALID_ACTUAL_COST/);
  assert.equal(store.snapshot(grantId, binding).reservedMicros, 10000000);
});
test('closing a grant prevents new requests and never refunds in-flight reservations', (t) => {
  const { store } = setup(t);
  store.reserve({ grantId, binding, requestId: 'r1', quoteMicros: 10000000 });
  store.closeGrant(grantId, binding);
  assert.equal(store.snapshot(grantId, binding).state, 'closed');
  assert.throws(() => store.reserve({ grantId, binding, requestId: 'r2', quoteMicros: 1 }), /GRANT_CLOSED/);
  assert.equal(store.snapshot(grantId, binding).reservedMicros, 10000000);
});
test('mock concurrent gateway subprocesses cannot collectively reserve over $10', async (t) => {
  const { dbPath, store } = setup(t);
  const js = [
    "const {SqliteBudgetStore}=require(process.argv[1]);",
    "const db=new SqliteBudgetStore(process.argv[2]);",
    "try{db.reserve({grantId:'numerra-review-10usd',binding:JSON.parse(process.argv[3]),requestId:process.argv[4],quoteMicros:2000000});process.exitCode=0;}",
    "catch(e){if(e.message==='APES_BUDGET_EXHAUSTED')process.exitCode=3;else {process.stderr.write(e.message);process.exitCode=7;}}",
    "finally{db.close();}",
  ].join('');
  const modulePath = path.join(__dirname, '..', 'gateway', 'sqlite-budget-store.js');
  const run = (index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', js, modulePath, dbPath, JSON.stringify(binding), 'attempt:' + index], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, error }));
  });
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => run(i + 1)));
  assert.equal(results.filter((x) => x.code === 0).length, 5, JSON.stringify(results));
  assert.equal(results.filter((x) => x.code === 3).length, 4, JSON.stringify(results));
  assert.equal(store.snapshot(grantId, binding).remainingMicros, 0);
  assert.equal(store.snapshot(grantId, binding).reservedMicros, 10000000);
});
