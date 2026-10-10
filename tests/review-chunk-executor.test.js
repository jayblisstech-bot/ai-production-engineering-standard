const test = require('node:test');
const assert = require('node:assert/strict');
const { executeReviewChunks } = require('../scripts/review-chunk-executor');

test('defaults to strictly serial review with stable ordering', async () => {
  let inFlight = 0, peak = 0;
  const results = await executeReviewChunks([1,2,3,4], async (value) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight--;
    return value * 2;
  });
  assert.equal(peak, 1);
  assert.deepEqual(results, [2,4,6,8]);
});

test('explicit two-chunk mode never exceeds approved concurrency and preserves output order', async () => {
  let inFlight = 0, peak = 0;
  const seen = [];
  const data = Array.from({length: 7}, (_, i) => i);
  const results = await executeReviewChunks(data, async (value) => {
    seen.push(value);
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight--;
    return value + 20;
  }, {concurrency: 2});
  assert.equal(peak, 2);
  assert.deepEqual(seen.slice().sort((a,b)=>a-b), data);
  assert.deepEqual(results, data.map(x=>x+20));
});

test('rejects invalid concurrency and missing chunks without invoking any external review', async () => {
  for (const value of [0,3,-1,1.1,'2',NaN]) {
    await assert.rejects(executeReviewChunks([1], async x => x, { concurrency: value }), /concurrency/);
  }
  await assert.rejects(executeReviewChunks([], async x => x), /No AI review chunks/);
});

test('fails closed and stops scheduling new chunks after any failure', async () => {
  const invoked = [];
  await assert.rejects(executeReviewChunks([0,1,2,3,4], async value => {
    invoked.push(value);
    if (value === 0) throw new Error('provider down');
    await new Promise(resolve=>setImmediate(resolve));
    return value;
  }, {concurrency: 2}), /provider down/);
  assert.ok(invoked.length <= 2, 'new review chunks must not launch after first known failure');
});

test('null or undefined response never permits a partial PASS', async () => {
  await assert.rejects(executeReviewChunks([1,2], async x => x === 2 ? null : 'ok'), /no verified result/);
  await assert.rejects(executeReviewChunks([1], async () => undefined), /no verified result/);
});
